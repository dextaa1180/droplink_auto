'use strict';

let teraboxApiModulePromise = null;

async function convertTeraboxShare(options) {
  const {
    ndus,
    shareUrl,
    destinationRoot = '/Tuna Bot',
    sharePassword = '',
    sharePeriod = 0,
    waitTimeoutMs = 30000
  } = options || {};

  if (!ndus) {
    throw new Error('Session TeraBox tidak punya token ndus. Login ulang lewat Dashboard TeraBox.');
  }

  const TeraBoxApp = await loadTeraBoxApp();
  const app = new TeraBoxApp(ndus);
  await app.checkLogin();

  const shortUrl = extractTeraboxShortUrl(shareUrl);
  if (!shortUrl) {
    throw new Error('Link TeraBox tidak dikenali.');
  }

  const source = await getShareList(app, shortUrl);
  const files = getShareFiles(source);
  const fsIds = uniqueNumbers(files.map((file) => file.fs_id || file.fsid || file.id));
  if (fsIds.length === 0) {
    throw new Error('Tidak ada file/folder yang bisa disimpan dari link ini.');
  }

  const shareId = pickNumber(source.share_id, source.shareid, source.shareId, source.sid);
  const fromUk = pickNumber(source.uk, source.share_uk, source.from_uk, source.fromUk, source.suk);
  if (!shareId || !fromUk) {
    throw new Error('Data share_id/from_uk tidak ditemukan dari link TeraBox.');
  }

  const destinationDir = normalizeRemoteDir(destinationRoot);
  await ensureRemoteDir(app, destinationDir);
  const beforeItems = await listRemoteFiles(app, destinationDir);

  const transfer = await app.shareTransfer(shareId, fromUk, fsIds, destinationDir, { ondup: 'newcopy' });
  assertTeraboxOk(transfer, 'Save to TeraBox gagal');

  const savedItems = await waitForSavedItems(app, destinationDir, files, beforeItems, waitTimeoutMs);
  const sharePaths = savedItems.map((item) => item.path).filter(Boolean);
  if (sharePaths.length === 0) {
    throw new Error('File sudah tersimpan, tapi path asli hasil save tidak ditemukan.');
  }

  const share = await app.shareSet(sharePaths, sharePassword, sharePeriod);
  assertTeraboxOk(share, 'Generate share link gagal');

  const newShareUrl = findShareUrl(share);
  if (!newShareUrl) {
    throw new Error('Share berhasil dipanggil, tapi response tidak berisi link baru.');
  }

  return {
    sourceUrl: shareUrl,
    newShareUrl,
    destinationDir,
    sharePaths,
    fileCount: fsIds.length,
    taskId: transfer.task_id || transfer.taskid || transfer.taskId || '',
    rawTransfer: transfer,
    rawShare: share
  };
}

async function loadTeraBoxApp() {
  if (!teraboxApiModulePromise) {
    teraboxApiModulePromise = import('terabox-api');
  }

  const mod = await teraboxApiModulePromise;
  return mod.TeraBoxApp || mod.default;
}

async function getShareList(app, shortUrl) {
  const candidates = uniqueStrings([
    shortUrl,
    shortUrl.startsWith('1') ? shortUrl.slice(1) : `1${shortUrl}`
  ]);

  const errors = [];
  for (const candidate of candidates) {
    try {
      const payload = await app.shortUrlList(candidate);
      if (payload && Number(payload.errno || 0) === 0 && getShareFiles(payload).length > 0) {
        return payload;
      }

      errors.push(payload && payload.errmsg ? payload.errmsg : JSON.stringify(payload).slice(0, 180));
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(`Gagal membaca isi link TeraBox: ${errors.filter(Boolean).join(' | ')}`);
}

async function ensureRemoteDir(app, remoteDir) {
  if (!remoteDir || remoteDir === '/') {
    return;
  }

  const response = await app.createDir(remoteDir);
  const errno = Number(response && (response.errno ?? response.error_code ?? 0));
  if (![0, -8, 31061].includes(errno)) {
    const message = response && (response.errmsg || response.message || response.error_msg);
    throw new Error(`Gagal membuat folder ${remoteDir}: ${message || `errno ${errno}`}`);
  }
}

async function listRemoteFiles(app, remoteDir) {
  const payload = await app.getRemoteDir(remoteDir).catch(() => null);
  return getRemoteFiles(payload);
}

async function waitForSavedItems(app, remoteDir, sourceFiles, beforeItems, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const expectedNames = uniqueStrings(sourceFiles.map((file) => file.server_filename || file.filename || file.name));
  const expectedCount = Math.max(1, expectedNames.length);
  const beforePaths = new Set((beforeItems || []).map((item) => item.path).filter(Boolean));
  let lastPayload = null;

  while (Date.now() < deadline) {
    lastPayload = await app.getRemoteDir(remoteDir).catch((error) => ({ error: error.message }));
    const files = getRemoteFiles(lastPayload);
    const matched = matchSavedItems(files, expectedNames, beforePaths);
    if (matched.length >= expectedCount) {
      return matched;
    }

    await sleep(2500);
  }

  throw new Error(`File belum muncul di ${remoteDir} setelah save. Response terakhir: ${truncateJson(lastPayload)}`);
}

function matchSavedItems(remoteFiles, expectedNames, beforePaths) {
  const matched = [];

  for (const file of remoteFiles) {
    const path = file.path || file.server_path || file.path_name || '';
    if (path && !beforePaths.has(path)) {
      matched.push({ ...file, path });
      continue;
    }

    const name = file.server_filename || file.filename || file.name || lastPathPart(file.path);
    if (!expectedNames.includes(name)) {
      continue;
    }

    matched.push({
      ...file,
      path
    });
  }

  return matched;
}

function getShareFiles(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  return firstArray(payload.list, payload.records, payload.data && payload.data.list, payload.data && payload.data.records);
}

function getRemoteFiles(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  return firstArray(payload.list, payload.records, payload.data && payload.data.list, payload.data && payload.data.records);
}

function firstArray(...values) {
  return values.find(Array.isArray) || [];
}

function extractTeraboxShortUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return '';
  }

  const surl = url.searchParams.get('surl') || url.searchParams.get('shorturl');
  if (surl) {
    return cleanShortUrl(surl);
  }

  const match = url.pathname.match(/\/s\/([^/?#]+)/i);
  return match ? cleanShortUrl(match[1]) : '';
}

function cleanShortUrl(value) {
  return String(value || '').trim().replace(/^\/+/, '').replace(/[^\w-].*$/g, '');
}

function normalizeRemoteDir(value) {
  const clean = String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!clean || clean === '/') {
    return '/Tuna Bot';
  }

  return clean.startsWith('/') ? clean.replace(/\/$/g, '') : `/${clean.replace(/\/$/g, '')}`;
}

function lastPathPart(value) {
  return String(value || '').split('/').filter(Boolean).pop() || '';
}

function findShareUrl(payload) {
  const candidates = [
    payload && payload.link,
    payload && payload.shorturl,
    payload && payload.shortUrl,
    payload && payload.url,
    payload && payload.share_url,
    payload && payload.shareUrl,
    payload && payload.data && payload.data.link,
    payload && payload.data && payload.data.url,
    payload && payload.data && payload.data.share_url
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }

  const text = JSON.stringify(payload || {});
  const match = text.match(/https?:\/\/[^"'\\\s]+/i);
  return match ? match[0] : '';
}

function assertTeraboxOk(payload, label) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${label}: response kosong.`);
  }

  const errno = Number(payload.errno ?? payload.error_code ?? 0);
  if (errno !== 0) {
    const message = payload.errmsg || payload.message || payload.error_msg || `errno ${errno}`;
    throw new Error(`${label}: ${message}`);
  }
}

function pickNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function truncateJson(value, limit = 240) {
  const text = JSON.stringify(value || {});
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  convertTeraboxShare,
  extractTeraboxShortUrl
};
