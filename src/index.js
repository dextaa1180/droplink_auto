'use strict';

const fs = require('node:fs');
const path = require('node:path');

loadEnvFile(path.join(process.cwd(), '.env'));

const config = readConfig();
const telegramBaseUrl = `https://api.telegram.org/bot${config.telegramBotToken}`;
const droplinkHost = safeHost(config.droplinkBaseUrl);

let updateOffset = 0;
let isStopping = false;

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});

async function main() {
  console.log('Tuna Droplink Telegram Bot is running.');
  console.log(`Droplink base URL: ${config.droplinkBaseUrl}`);

  while (!isStopping) {
    try {
      const updates = await telegram('getUpdates', {
        offset: updateOffset,
        timeout: 50,
        allowed_updates: ['message', 'channel_post']
      }, 65000);

      for (const update of updates) {
        updateOffset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      if (!isStopping) {
        console.error('[polling]', error.message);
        await sleep(3000);
      }
    }
  }
}

async function handleUpdate(update) {
  const message = update.message || update.channel_post;
  if (!message) {
    return;
  }

  const chatId = message.chat.id;
  const userId = message.from && message.from.id;
  const chatIdString = String(chatId);

  if (!isAllowedTarget(userId, chatIdString)) {
    await reply(chatId, message.message_id, 'Maaf, bot ini sedang dibuat privat.');
    return;
  }

  const text = getMessageText(message);
  if (!text) {
    return;
  }

  const command = parseCommand(text);
  if (command) {
    await handleCommand(message, command);
    return;
  }

  const urls = uniqueUrls(extractUrls(text).filter((url) => !isDroplinkUrl(url)));
  if (urls.length === 0) {
    return;
  }

  await shortenAndReply(message, urls);
}

async function handleCommand(message, command) {
  const chatId = message.chat.id;

  if (command.name === 'start' || command.name === 'help') {
    await reply(chatId, message.message_id, helpText());
    return;
  }

  if (command.name === 'short') {
    const parsed = parseShortCommand(command.body);
    if (parsed.urls.length === 0) {
      await reply(chatId, message.message_id, 'Kirim: /short https://example.com atau /short https://example.com alias=nama-alias');
      return;
    }

    await shortenAndReply(message, parsed.urls, parsed.alias);
    return;
  }

  await reply(chatId, message.message_id, 'Command tidak dikenal. Pakai /help untuk melihat contoh penggunaan.');
}

async function shortenAndReply(message, urls, alias) {
  const chatId = message.chat.id;
  const limitedUrls = uniqueUrls(urls).slice(0, config.maxUrlsPerMessage);

  if (urls.length > limitedUrls.length) {
    await reply(chatId, message.message_id, `Saya proses ${limitedUrls.length} link pertama dulu.`);
  }

  await telegram('sendChatAction', {
    chat_id: chatId,
    action: 'typing'
  });

  const results = [];
  for (const longUrl of limitedUrls) {
    try {
      const shortUrl = await shortenWithDroplink(longUrl, limitedUrls.length === 1 ? alias : undefined);
      results.push({ longUrl, shortUrl });
    } catch (error) {
      results.push({ longUrl, error: error.message });
    }
  }

  await reply(chatId, message.message_id, formatResults(results));
}

async function shortenWithDroplink(longUrl, alias) {
  const endpoint = new URL('/api', ensureTrailingSlash(config.droplinkBaseUrl));
  endpoint.searchParams.set('api', config.droplinkApiKey);
  endpoint.searchParams.set('url', longUrl);

  if (alias) {
    endpoint.searchParams.set('alias', alias);
  }

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      'user-agent': 'TunaDroplinkTelegramBot/1.0'
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Droplink HTTP ${response.status}: ${truncate(body)}`);
  }

  const payload = parseResponseBody(body);
  const apiStatus = typeof payload === 'object' && payload ? String(payload.status || '').toLowerCase() : '';

  if (apiStatus && apiStatus !== 'success') {
    throw new Error(payload.message || 'Droplink menolak request.');
  }

  const shortUrl = findShortUrl(payload, body);
  if (!shortUrl) {
    throw new Error('Response Droplink tidak berisi shortenedUrl.');
  }

  return shortUrl;
}

async function telegram(method, body, timeoutMs = config.requestTimeoutMs) {
  const response = await fetch(`${telegramBaseUrl}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok !== true) {
    const description = payload && payload.description ? payload.description : `Telegram HTTP ${response.status}`;
    throw new Error(description);
  }

  return payload.result;
}

async function reply(chatId, replyToMessageId, text) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
    disable_web_page_preview: true
  });
}

function readConfig() {
  const telegramBotToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const droplinkApiKey = requireEnv('DROPLINK_API_KEY');
  const droplinkBaseUrl = cleanBaseUrl(process.env.DROPLINK_BASE_URL || 'https://droplink.co');

  return {
    telegramBotToken,
    droplinkApiKey,
    droplinkBaseUrl,
    allowedUserIds: parseIdSet(process.env.ALLOWED_USER_IDS || ''),
    allowedChatIds: parseIdSet(process.env.ALLOWED_CHAT_IDS || ''),
    maxUrlsPerMessage: parsePositiveInt(process.env.MAX_URLS_PER_MESSAGE, 5),
    requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 15000)
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Environment variable ${name} wajib diisi.`);
  }

  return value.trim();
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getMessageText(message) {
  return message.text || message.caption || '';
}

function parseCommand(text) {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const body = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  const match = head.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?$/i);

  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    body
  };
}

function parseShortCommand(body) {
  const urlMatches = extractUrlMatches(body).filter((item) => !isDroplinkUrl(item.url));
  const urls = uniqueUrls(urlMatches.map((item) => item.url));
  let alias = findAlias(body);

  if (!alias && urlMatches.length === 1) {
    const only = urlMatches[0];
    const afterUrl = body.slice(only.index + only.raw.length).trim();
    const aliasToken = afterUrl.split(/\s+/).find(Boolean);
    if (aliasToken && isSafeAlias(aliasToken)) {
      alias = aliasToken;
    }
  }

  return { urls, alias };
}

function extractUrls(text) {
  return extractUrlMatches(text).map((item) => item.url);
}

function extractUrlMatches(text) {
  const matches = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const raw = stripTrailingPunctuation(match[0]);
    const url = normalizeUrl(raw);
    if (url) {
      matches.push({
        raw,
        url,
        index: match.index
      });
    }
  }

  return matches;
}

function stripTrailingPunctuation(value) {
  return value.replace(/[)\].,!?;:]+$/g, '');
}

function normalizeUrl(value) {
  const withScheme = value.toLowerCase().startsWith('www.') ? `https://${value}` : value;

  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function uniqueUrls(urls) {
  return [...new Set(urls)];
}

function isDroplinkUrl(url) {
  if (!droplinkHost) {
    return false;
  }

  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    return host === droplinkHost || host.endsWith(`.${droplinkHost}`);
  } catch {
    return false;
  }
}

function findAlias(text) {
  const match = text.match(/(?:^|\s)(?:--)?alias=([a-z0-9_-]{1,50})(?=\s|$)/i);
  return match ? match[1] : undefined;
}

function isSafeAlias(value) {
  return /^[a-z0-9_-]{1,50}$/i.test(value);
}

function findShortUrl(payload, body) {
  if (payload && typeof payload === 'object') {
    const candidates = [
      payload.shortenedUrl,
      payload.shortened_url,
      payload.shortUrl,
      payload.short_url,
      payload.url,
      payload.result
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && isHttpUrl(candidate)) {
        return candidate;
      }
    }
  }

  if (typeof payload === 'string' && isHttpUrl(payload.trim())) {
    return payload.trim();
  }

  const baseHostPattern = escapeRegExp(droplinkHost || 'droplink.co');
  const match = body.match(new RegExp(`https?:\\/\\/(?:www\\.)?${baseHostPattern}\\/[^\\s"'<>]+`, 'i'));
  return match ? stripTrailingPunctuation(match[0]) : null;
}

function parseResponseBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function formatResults(results) {
  if (results.length === 1 && results[0].shortUrl) {
    return results[0].shortUrl;
  }

  return results.map((result, index) => {
    if (result.shortUrl) {
      return `${index + 1}. ${result.longUrl}\n=> ${result.shortUrl}`;
    }

    return `${index + 1}. ${result.longUrl}\nGagal: ${result.error}`;
  }).join('\n\n');
}

function helpText() {
  return [
    'Kirim link apa saja, bot akan otomatis membuat short link Droplink.',
    '',
    'Contoh:',
    '/short https://example.com',
    '/short https://example.com nama-alias',
    '/short https://example.com alias=nama-alias'
  ].join('\n');
}

function isAllowedTarget(userId, chatId) {
  if (config.allowedUserIds.size === 0 && config.allowedChatIds.size === 0) {
    return true;
  }

  return (userId && config.allowedUserIds.has(String(userId))) || config.allowedChatIds.has(chatId);
}

function parseIdSet(value) {
  return new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('DROPLINK_BASE_URL harus URL HTTP/HTTPS.');
  }

  url.pathname = url.pathname.replace(/\/+$/g, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/g, '');
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function safeHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(value, length = 180) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length)}...` : clean;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stop() {
  isStopping = true;
  console.log('Stopping bot...');
}
