'use strict';

const fs = require('node:fs');
const path = require('node:path');

loadEnvFile(path.join(process.cwd(), '.env'));

const config = readConfig();
const telegramBaseUrl = `https://api.telegram.org/bot${config.telegramBotToken}`;
const droplinkHost = safeHost(config.droplinkBaseUrl);
const chatModes = new Map();
const teraboxSessions = loadSessionStore(config.sessionStorePath);

const MODES = {
  SHORTEN: 'shorten',
  TERABOX: 'terabox'
};

const MENU_BUTTONS = {
  SHORTEN: 'Shorten Link',
  TERABOX: 'Convert TeraBox',
  TERABOX_DASHBOARD: 'Dashboard TeraBox',
  TERABOX_CONNECT: 'Hubungkan TeraBox',
  TERABOX_STATUS: 'Status Session',
  TERABOX_DISCONNECT: 'Putus Session',
  HELP: 'Bantuan'
};

const TERABOX_HOSTS = new Set([
  '1024terabox.com',
  'terabox.com',
  'teraboxapp.com',
  'teraboxlink.com',
  'freeterabox.com',
  '4funbox.com',
  'mirrobox.com',
  'tibibox.com'
]);

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

  const menuAction = parseMenuButton(text);
  if (menuAction) {
    await handleMenuAction(message, menuAction);
    return;
  }

  const command = parseCommand(text);
  if (command) {
    await handleCommand(message, command);
    return;
  }

  const mode = chatModes.get(chatIdString);
  const teraboxUrls = uniqueUrls(extractUrls(text).filter(isTeraboxUrl));
  if (mode === MODES.TERABOX || teraboxUrls.length > 0) {
    if (teraboxUrls.length === 0) {
      await reply(chatId, message.message_id, 'Kirim link TeraBox, contoh: https://1024terabox.com/s/xxxxx');
      return;
    }

    await reshareTeraboxAndReply(message, teraboxUrls);
    return;
  }

  const urls = uniqueUrls(extractUrls(text).filter((url) => !isDroplinkUrl(url) && !isTeraboxUrl(url)));
  if (urls.length === 0) {
    return;
  }

  await shortenAndReply(message, urls);
}

async function handleCommand(message, command) {
  const chatId = message.chat.id;

  if (command.name === 'start' || command.name === 'menu') {
    chatModes.delete(String(chatId));
    await sendMenu(chatId, message.message_id);
    return;
  }

  if (command.name === 'help') {
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

  if (command.name === 'terabox' || command.name === 'pindah') {
    const urls = uniqueUrls(extractUrls(command.body).filter(isTeraboxUrl));
    if (urls.length === 0) {
      chatModes.set(String(chatId), MODES.TERABOX);
      await reply(chatId, message.message_id, 'Mode Convert TeraBox aktif. Kirim link TeraBox yang ingin diproses.');
      return;
    }

    await reshareTeraboxAndReply(message, urls);
    return;
  }

  if (command.name === 'terabox_dashboard' || command.name === 'dashboard_terabox') {
    await sendTeraboxDashboard(message);
    return;
  }

  if (command.name === 'terabox_connect' || command.name === 'hubungkan_terabox') {
    await startTeraboxSession(message);
    return;
  }

  if (command.name === 'terabox_status' || command.name === 'status_terabox') {
    await showTeraboxSessionStatus(message);
    return;
  }

  if (command.name === 'terabox_logout' || command.name === 'putus_terabox') {
    await disconnectTeraboxSession(message);
    return;
  }

  await reply(chatId, message.message_id, 'Command tidak dikenal. Pakai /help untuk melihat contoh penggunaan.');
}

async function handleMenuAction(message, action) {
  const chatId = message.chat.id;

  if (action === MODES.SHORTEN) {
    chatModes.set(String(chatId), MODES.SHORTEN);
    await reply(chatId, message.message_id, 'Mode Shorten aktif. Kirim link yang ingin dibuat shortlink Droplink.');
    return;
  }

  if (action === MODES.TERABOX) {
    chatModes.set(String(chatId), MODES.TERABOX);
    await reply(chatId, message.message_id, 'Mode Convert TeraBox aktif. Kirim link TeraBox untuk mengambil metadata, download link, dan stream link dari API.');
    return;
  }

  if (action === 'terabox_dashboard') {
    await sendTeraboxDashboard(message);
    return;
  }

  if (action === 'terabox_connect') {
    await startTeraboxSession(message);
    return;
  }

  if (action === 'terabox_status') {
    await showTeraboxSessionStatus(message);
    return;
  }

  if (action === 'terabox_disconnect') {
    await disconnectTeraboxSession(message);
    return;
  }

  await reply(chatId, message.message_id, helpText(), {
    reply_markup: menuKeyboard()
  });
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

async function reshareTeraboxAndReply(message, urls) {
  const chatId = message.chat.id;
  const limitedUrls = uniqueUrls(urls).slice(0, config.maxUrlsPerMessage);

  if (urls.length > limitedUrls.length) {
    await reply(chatId, message.message_id, `Saya proses ${limitedUrls.length} link TeraBox pertama dulu.`);
  }

  await telegram('sendChatAction', {
    chat_id: chatId,
    action: 'typing'
  });

  const results = [];
  for (const shareUrl of limitedUrls) {
    try {
      const output = await reshareTeraboxLink(shareUrl, message);
      results.push({ shareUrl, ...output });
    } catch (error) {
      results.push({ shareUrl, error: error.message });
    }
  }

  await reply(chatId, message.message_id, formatTeraboxResults(results));
}

async function reshareTeraboxLink(shareUrl, message) {
  if (!config.teraboxReshareApiUrl) {
    throw new Error('Fitur Convert TeraBox belum dikonfigurasi. Isi TERABOX_RESHARE_API_URL di .env.');
  }

  const session = getMessageUserSession(message);
  if (config.teraboxReshareRequireSession && !session) {
    throw new Error('Session TeraBox belum terhubung. Buka Dashboard TeraBox lalu pilih Hubungkan TeraBox.');
  }

  const headers = {
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    'content-type': 'application/json',
    'user-agent': 'TunaDroplinkTelegramBot/1.0'
  };

  if (config.teraboxReshareApiKey) {
    headers[config.teraboxReshareApiKeyHeader] = config.teraboxReshareApiKey;
  }

  const requestBody = {
    url: shareUrl
  };

  if (config.teraboxReshareRequireSession) {
    requestBody.sessionId = session ? session.sessionId : undefined;
    requestBody.telegramUserId = message.from ? String(message.from.id) : undefined;
    requestBody.telegramChatId = String(message.chat.id);
  }

  const response = await fetch(config.teraboxReshareApiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`TeraBox API HTTP ${response.status}: ${truncate(body)}`);
  }

  const payload = parseResponseBody(body);
  const apiStatus = typeof payload === 'object' && payload ? String(payload.status || '').toLowerCase() : '';
  if (apiStatus && apiStatus !== 'success') {
    throw new Error(payload.message || 'TeraBox API menolak request.');
  }

  const newShareUrl = findTeraboxShareUrl(payload, body);
  if (newShareUrl) {
    return { newShareUrl };
  }

  const detailsText = formatTeraboxApiPayload(payload);
  if (detailsText) {
    return { detailsText };
  }

  throw new Error('Response TeraBox API tidak berisi data yang dikenali.');
}

async function sendTeraboxDashboard(message) {
  if (!(await ensureTeraboxDashboardAccess(message))) {
    return;
  }

  const session = getUserSession(message.from.id);
  await reply(message.chat.id, message.message_id, teraboxDashboardText(session), {
    reply_markup: teraboxDashboardKeyboard()
  });
}

async function startTeraboxSession(message) {
  if (!(await ensureTeraboxDashboardAccess(message))) {
    return;
  }

  if (!config.teraboxSessionStartApiUrl) {
    await reply(message.chat.id, message.message_id, [
      'Endpoint session TeraBox belum dikonfigurasi.',
      '',
      'Isi TERABOX_SESSION_START_API_URL di .env dengan endpoint resmi/authorized yang membuat QR login.',
      'Bot tidak menyimpan cookie akun; hanya sessionId/status dari endpoint itu.'
    ].join('\n'), {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  await telegram('sendChatAction', {
    chat_id: message.chat.id,
    action: 'typing'
  });

  try {
    const payload = await callTeraboxSessionApi(config.teraboxSessionStartApiUrl, {
      action: 'start',
      telegramUserId: String(message.from.id),
      telegramChatId: String(message.chat.id),
      username: message.from.username || '',
      firstName: message.from.first_name || '',
      lastName: message.from.last_name || ''
    });

    const session = saveSessionFromPayload(message, payload, 'pending');
    const text = formatTeraboxSessionStart(payload, session);
    const qrImageUrl = getPayloadString(payload, ['qrImageUrl', 'qr_image_url', 'qrUrl', 'qr_url']);

    if (qrImageUrl && isHttpUrl(qrImageUrl)) {
      await sendPhoto(message.chat.id, qrImageUrl, text, {
        reply_to_message_id: message.message_id,
        reply_markup: teraboxDashboardKeyboard()
      });
      return;
    }

    await reply(message.chat.id, message.message_id, text, {
      reply_markup: teraboxDashboardKeyboard()
    });
  } catch (error) {
    await reply(message.chat.id, message.message_id, `Gagal memulai session TeraBox: ${error.message}`, {
      reply_markup: teraboxDashboardKeyboard()
    });
  }
}

async function showTeraboxSessionStatus(message) {
  if (!(await ensureTeraboxDashboardAccess(message))) {
    return;
  }

  const existing = getUserSession(message.from.id);
  if (!existing) {
    await reply(message.chat.id, message.message_id, 'Belum ada session TeraBox. Pilih Hubungkan TeraBox untuk mulai.', {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  if (!config.teraboxSessionStatusApiUrl) {
    await reply(message.chat.id, message.message_id, formatTeraboxSessionStatus(existing, 'Status ini dari data lokal karena TERABOX_SESSION_STATUS_API_URL belum diisi.'), {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  await telegram('sendChatAction', {
    chat_id: message.chat.id,
    action: 'typing'
  });

  try {
    const payload = await callTeraboxSessionApi(config.teraboxSessionStatusApiUrl, {
      action: 'status',
      sessionId: existing.sessionId,
      telegramUserId: String(message.from.id),
      telegramChatId: String(message.chat.id)
    });

    const session = saveSessionFromPayload(message, payload, existing.status || 'pending');
    await reply(message.chat.id, message.message_id, formatTeraboxSessionStatus(session), {
      reply_markup: teraboxDashboardKeyboard()
    });
  } catch (error) {
    await reply(message.chat.id, message.message_id, `Gagal cek status session TeraBox: ${error.message}`, {
      reply_markup: teraboxDashboardKeyboard()
    });
  }
}

async function disconnectTeraboxSession(message) {
  if (!(await ensureTeraboxDashboardAccess(message))) {
    return;
  }

  const existing = getUserSession(message.from.id);
  if (!existing) {
    await reply(message.chat.id, message.message_id, 'Tidak ada session TeraBox yang tersimpan.', {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  if (config.teraboxSessionDisconnectApiUrl) {
    try {
      await callTeraboxSessionApi(config.teraboxSessionDisconnectApiUrl, {
        action: 'disconnect',
        sessionId: existing.sessionId,
        telegramUserId: String(message.from.id),
        telegramChatId: String(message.chat.id)
      });
    } catch (error) {
      await reply(message.chat.id, message.message_id, `Endpoint disconnect gagal: ${error.message}\nSession lokal belum dihapus.`, {
        reply_markup: teraboxDashboardKeyboard()
      });
      return;
    }
  }

  deleteUserSession(message.from.id);
  await reply(message.chat.id, message.message_id, 'Session TeraBox lokal sudah diputus.', {
    reply_markup: teraboxDashboardKeyboard()
  });
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

async function sendPhoto(chatId, photo, caption, options = {}) {
  return telegram('sendPhoto', {
    chat_id: chatId,
    photo,
    caption,
    ...options
  });
}

async function callTeraboxSessionApi(endpoint, body) {
  const headers = {
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    'content-type': 'application/json',
    'user-agent': 'TunaDroplinkTelegramBot/1.0'
  };

  if (config.teraboxSessionApiKey) {
    headers.authorization = `Bearer ${config.teraboxSessionApiKey}`;
    headers['x-api-key'] = config.teraboxSessionApiKey;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${truncate(responseBody)}`);
  }

  const payload = parseResponseBody(responseBody);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Response endpoint session harus JSON object.');
  }

  const apiStatus = String(payload.status || '').toLowerCase();
  if (apiStatus && !['success', 'pending', 'connected', 'authorized', 'disconnected'].includes(apiStatus)) {
    throw new Error(payload.message || 'Endpoint session menolak request.');
  }

  return payload;
}

async function reply(chatId, replyToMessageId, text, options = {}) {
  return sendMessage(chatId, text, {
    reply_to_message_id: replyToMessageId,
    ...options
  });
}

async function sendMessage(chatId, text, options = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...options
  });
}

async function sendMenu(chatId, replyToMessageId) {
  return reply(chatId, replyToMessageId, menuText(), {
    reply_markup: menuKeyboard()
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
    teraboxDashboardUserIds: parseIdSet(process.env.TERABOX_DASHBOARD_USER_IDS || ''),
    maxUrlsPerMessage: parsePositiveInt(process.env.MAX_URLS_PER_MESSAGE, 5),
    requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 15000),
    teraboxReshareApiUrl: optionalUrl(process.env.TERABOX_RESHARE_API_URL || '', 'TERABOX_RESHARE_API_URL'),
    teraboxReshareApiKey: (process.env.TERABOX_RESHARE_API_KEY || '').trim(),
    teraboxReshareApiKeyHeader: cleanHeaderName(process.env.TERABOX_RESHARE_API_KEY_HEADER || 'xAPIverse-Key'),
    teraboxReshareRequireSession: parseBool(process.env.TERABOX_RESHARE_REQUIRE_SESSION, false),
    teraboxSessionStartApiUrl: optionalUrl(process.env.TERABOX_SESSION_START_API_URL || '', 'TERABOX_SESSION_START_API_URL'),
    teraboxSessionStatusApiUrl: optionalUrl(process.env.TERABOX_SESSION_STATUS_API_URL || '', 'TERABOX_SESSION_STATUS_API_URL'),
    teraboxSessionDisconnectApiUrl: optionalUrl(process.env.TERABOX_SESSION_DISCONNECT_API_URL || '', 'TERABOX_SESSION_DISCONNECT_API_URL'),
    teraboxSessionApiKey: (process.env.TERABOX_SESSION_API_KEY || '').trim(),
    sessionStorePath: resolveWorkspacePath(process.env.TERABOX_SESSION_STORE_FILE || path.join(process.env.DATA_DIR || 'data', 'terabox-sessions.json'))
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
  const urlMatches = extractUrlMatches(body).filter((item) => !isDroplinkUrl(item.url) && !isTeraboxUrl(item.url));
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

function parseMenuButton(text) {
  const normalized = text.trim().toLowerCase();

  if (normalized === MENU_BUTTONS.SHORTEN.toLowerCase()) {
    return MODES.SHORTEN;
  }

  if (normalized === MENU_BUTTONS.TERABOX.toLowerCase()) {
    return MODES.TERABOX;
  }

  if (normalized === 'pindah terabox') {
    return MODES.TERABOX;
  }

  if (normalized === MENU_BUTTONS.TERABOX_DASHBOARD.toLowerCase()) {
    return 'terabox_dashboard';
  }

  if (normalized === MENU_BUTTONS.TERABOX_CONNECT.toLowerCase()) {
    return 'terabox_connect';
  }

  if (normalized === MENU_BUTTONS.TERABOX_STATUS.toLowerCase()) {
    return 'terabox_status';
  }

  if (normalized === MENU_BUTTONS.TERABOX_DISCONNECT.toLowerCase()) {
    return 'terabox_disconnect';
  }

  if (normalized === MENU_BUTTONS.HELP.toLowerCase()) {
    return 'help';
  }

  return null;
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

function isTeraboxUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    return TERABOX_HOSTS.has(host) || [...TERABOX_HOSTS].some((domain) => host.endsWith(`.${domain}`));
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

function findTeraboxShareUrl(payload, body) {
  if (payload && typeof payload === 'object') {
    const candidates = [
      payload.shareUrl,
      payload.share_url,
      payload.sharedUrl,
      payload.shared_url,
      payload.newShareUrl,
      payload.new_share_url,
      payload.url,
      payload.result
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && isTeraboxUrl(candidate)) {
        return candidate;
      }
    }
  }

  if (typeof payload === 'string' && isTeraboxUrl(payload.trim())) {
    return payload.trim();
  }

  const match = body.match(/https?:\/\/[^\s"'<>]+/i);
  if (match && isTeraboxUrl(stripTrailingPunctuation(match[0]))) {
    return stripTrailingPunctuation(match[0]);
  }

  return null;
}

function parseResponseBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function saveSessionFromPayload(message, payload, fallbackStatus) {
  const existing = getUserSession(message.from.id) || {};
  const status = normalizeSessionStatus(getPayloadString(payload, ['status']) || fallbackStatus);
  const sessionId = getPayloadString(payload, ['sessionId', 'session_id', 'id']) || existing.sessionId;
  const now = new Date().toISOString();

  if (!sessionId) {
    throw new Error('Response endpoint session tidak berisi sessionId.');
  }

  const session = {
    userId: String(message.from.id),
    chatId: String(message.chat.id),
    sessionId,
    status,
    accountName: getPayloadString(payload, ['accountName', 'account_name', 'displayName', 'display_name', 'name']) || existing.accountName || '',
    accountEmail: getPayloadString(payload, ['accountEmail', 'account_email', 'email']) || existing.accountEmail || '',
    createdAt: existing.createdAt || now,
    connectedAt: status === 'connected' ? (existing.connectedAt || now) : existing.connectedAt || '',
    expiresAt: getPayloadString(payload, ['expiresAt', 'expires_at', 'expireAt', 'expire_at']) || existing.expiresAt || '',
    updatedAt: now
  };

  setUserSession(message.from.id, session);
  return session;
}

function normalizeSessionStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'authorized') {
    return 'connected';
  }

  if (['connected', 'pending', 'expired', 'disconnected', 'failed'].includes(normalized)) {
    return normalized;
  }

  return 'pending';
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

function formatTeraboxResults(results) {
  if (results.length === 1 && results[0].newShareUrl) {
    return results[0].newShareUrl;
  }

  if (results.length === 1 && results[0].detailsText) {
    return results[0].detailsText;
  }

  return results.map((result, index) => {
    if (result.newShareUrl) {
      return `${index + 1}. ${result.shareUrl}\n=> ${result.newShareUrl}`;
    }

    if (result.detailsText) {
      return `${index + 1}. ${result.shareUrl}\n${result.detailsText}`;
    }

    return `${index + 1}. ${result.shareUrl}\nGagal: ${result.error}`;
  }).join('\n\n');
}

function formatTeraboxApiPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const files = Array.isArray(payload.list) ? payload.list : [];
  if (files.length === 0) {
    return '';
  }

  const lines = [
    `Status: ${payload.status || 'success'}`,
    `Total file: ${payload.total_files || files.length}`
  ];

  files.slice(0, config.maxUrlsPerMessage).forEach((file, index) => {
    lines.push('', `${index + 1}. ${file.name || 'Tanpa nama'}`);
    if (file.size_formatted) {
      lines.push(`Size: ${file.size_formatted}`);
    }

    if (file.type) {
      lines.push(`Type: ${file.type}`);
    }

    if (file.quality) {
      lines.push(`Quality: ${file.quality}`);
    }

    if (file.duration) {
      lines.push(`Duration: ${file.duration}`);
    }

    if (file.normal_dlink) {
      lines.push(`Download: ${file.normal_dlink}`);
    }

    if (file.zip_dlink) {
      lines.push(`Zip: ${file.zip_dlink}`);
    }

    const streamUrl = pickStreamUrl(file.fast_stream_url);
    if (streamUrl) {
      lines.push(`Stream: ${streamUrl}`);
    }
  });

  if (payload.folder_zip_dlink) {
    lines.push('', `Folder zip: ${payload.folder_zip_dlink}`);
  }

  return truncateTelegramMessage(lines.join('\n'));
}

function helpText() {
  return [
    'Kirim link biasa untuk dibuat shortlink Droplink.',
    'Kirim link TeraBox untuk diproses lewat mode Convert TeraBox.',
    '',
    'Contoh:',
    '/short https://example.com',
    '/short https://example.com nama-alias',
    '/short https://example.com alias=nama-alias',
    '/terabox https://1024terabox.com/s/xxxxx',
    '/terabox_dashboard',
    '/terabox_connect',
    '/terabox_status',
    '/terabox_logout',
    '',
    'Catatan: Convert TeraBox memerlukan TERABOX_RESHARE_API_URL dan API key dari provider yang kamu pakai.'
  ].join('\n');
}

function menuText() {
  return [
    'Pilih menu:',
    '',
    `${MENU_BUTTONS.SHORTEN} - buat shortlink Droplink`,
    `${MENU_BUTTONS.TERABOX} - ambil metadata/download link TeraBox`,
    `${MENU_BUTTONS.TERABOX_DASHBOARD} - kelola session pribadi`,
    `${MENU_BUTTONS.HELP} - lihat bantuan`
  ].join('\n');
}

function menuKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_BUTTONS.SHORTEN }, { text: MENU_BUTTONS.TERABOX }],
      [{ text: MENU_BUTTONS.TERABOX_DASHBOARD }, { text: MENU_BUTTONS.HELP }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: 'Pilih menu atau kirim link'
  };
}

function teraboxDashboardText(session) {
  return [
    'Dashboard TeraBox pribadi',
    '',
    session ? formatSessionSummary(session) : 'Status: belum terhubung',
    '',
    `${MENU_BUTTONS.TERABOX_CONNECT} - mulai login QR dari endpoint session`,
    `${MENU_BUTTONS.TERABOX_STATUS} - cek status session`,
    `${MENU_BUTTONS.TERABOX_DISCONNECT} - putus session lokal/endpoint`
  ].join('\n');
}

function teraboxDashboardKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_BUTTONS.TERABOX_CONNECT }, { text: MENU_BUTTONS.TERABOX_STATUS }],
      [{ text: MENU_BUTTONS.TERABOX_DISCONNECT }],
      [{ text: MENU_BUTTONS.SHORTEN }, { text: MENU_BUTTONS.TERABOX }],
      [{ text: MENU_BUTTONS.TERABOX_DASHBOARD }, { text: MENU_BUTTONS.HELP }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: 'Kelola session TeraBox'
  };
}

function formatTeraboxSessionStart(payload, session) {
  const loginUrl = getPayloadString(payload, ['loginUrl', 'login_url', 'authorizeUrl', 'authorize_url']);
  const expiresAt = getPayloadString(payload, ['expiresAt', 'expires_at', 'expireAt', 'expire_at']) || session.expiresAt;
  const lines = [
    'Session TeraBox dimulai.',
    '',
    formatSessionSummary(session)
  ];

  if (loginUrl) {
    lines.push('', `Login URL: ${loginUrl}`);
  }

  if (expiresAt) {
    lines.push(`Berlaku sampai: ${expiresAt}`);
  }

  lines.push('', 'Setelah login selesai, pilih Status Session.');
  return lines.join('\n');
}

function formatTeraboxSessionStatus(session, note) {
  const lines = [
    'Status session TeraBox:',
    '',
    formatSessionSummary(session)
  ];

  if (note) {
    lines.push('', note);
  }

  return lines.join('\n');
}

function formatSessionSummary(session) {
  const lines = [
    `Status: ${session.status || 'unknown'}`,
    `Session ID: ${maskValue(session.sessionId)}`
  ];

  if (session.accountName) {
    lines.push(`Akun: ${session.accountName}`);
  }

  if (session.accountEmail) {
    lines.push(`Email: ${maskEmail(session.accountEmail)}`);
  }

  if (session.connectedAt) {
    lines.push(`Terhubung: ${session.connectedAt}`);
  }

  if (session.expiresAt) {
    lines.push(`Expired: ${session.expiresAt}`);
  }

  if (session.updatedAt) {
    lines.push(`Update: ${session.updatedAt}`);
  }

  return lines.join('\n');
}

async function ensureTeraboxDashboardAccess(message) {
  const chatId = message.chat.id;
  const userId = message.from && message.from.id;

  if (!userId) {
    await reply(chatId, message.message_id, 'Dashboard TeraBox hanya tersedia untuk akun user, bukan channel.');
    return false;
  }

  if (!isPrivateChat(message)) {
    await reply(chatId, message.message_id, 'Dashboard TeraBox hanya bisa dibuka di chat private dengan bot.');
    return false;
  }

  if (!isAllowedDashboardUser(userId)) {
    await reply(chatId, message.message_id, 'Dashboard TeraBox dibatasi untuk user yang diizinkan.');
    return false;
  }

  return true;
}

function isPrivateChat(message) {
  return message.chat.type === 'private' || String(message.chat.id) === String(message.from && message.from.id);
}

function isAllowedDashboardUser(userId) {
  const id = String(userId);
  if (config.teraboxDashboardUserIds.size > 0) {
    return config.teraboxDashboardUserIds.has(id);
  }

  if (config.allowedUserIds.size > 0) {
    return config.allowedUserIds.has(id);
  }

  return true;
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

function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function cleanHeaderName(value) {
  const clean = String(value || '').trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(clean)) {
    throw new Error('TERABOX_RESHARE_API_KEY_HEADER harus nama header HTTP yang valid.');
  }

  return clean;
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

function optionalUrl(value, name = 'URL') {
  const clean = value.trim();
  if (!clean) {
    return '';
  }

  let url;
  try {
    url = new URL(clean);
  } catch {
    throw new Error(`${name} harus URL HTTP/HTTPS yang valid.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} harus URL HTTP/HTTPS.`);
  }

  return url.toString();
}

function resolveWorkspacePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function loadSessionStore(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn(`[session-store] Gagal baca ${filePath}: ${error.message}`);
    return {};
  }
}

function saveSessionStore() {
  fs.mkdirSync(path.dirname(config.sessionStorePath), { recursive: true });
  const tempPath = `${config.sessionStorePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(teraboxSessions, null, 2));
  fs.renameSync(tempPath, config.sessionStorePath);
}

function getMessageUserSession(message) {
  if (!message.from || !message.from.id) {
    return null;
  }

  return getUserSession(message.from.id);
}

function getUserSession(userId) {
  return teraboxSessions[String(userId)] || null;
}

function setUserSession(userId, session) {
  teraboxSessions[String(userId)] = session;
  saveSessionStore();
}

function deleteUserSession(userId) {
  delete teraboxSessions[String(userId)];
  saveSessionStore();
}

function getPayloadString(payload, keys) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return '';
}

function maskValue(value) {
  const text = String(value || '');
  if (text.length <= 8) {
    return text || '-';
  }

  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function maskEmail(value) {
  const [name, domain] = String(value || '').split('@');
  if (!name || !domain) {
    return maskValue(value);
  }

  return `${name.slice(0, 2)}***@${domain}`;
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

function truncateTelegramMessage(value, limit = 3900) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit - 24)}\n\n...dipotong oleh bot.` : text;
}

function pickStreamUrl(streams) {
  if (!streams || typeof streams !== 'object') {
    return '';
  }

  const preferredQualities = ['1080p', '720p', '480p', '360p'];
  for (const quality of preferredQualities) {
    if (typeof streams[quality] === 'string' && streams[quality]) {
      return streams[quality];
    }
  }

  const first = Object.values(streams).find((value) => typeof value === 'string' && value);
  return first || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stop() {
  isStopping = true;
  console.log('Stopping bot...');
}
