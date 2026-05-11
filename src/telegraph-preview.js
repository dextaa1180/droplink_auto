'use strict';

const TELEGRAPH_API_BASE = 'https://api.telegra.ph';
const TELEGRAPH_UPLOAD_URL = 'https://telegra.ph/upload';
const TELEGRAPH_BASE_URL = 'https://telegra.ph';

async function createTelegraphAccount(options = {}) {
  const payload = await callTelegraph('createAccount', {
    short_name: options.shortName || 'TunaPreview',
    author_name: options.authorName || 'Tuna',
    author_url: options.authorUrl || ''
  });

  if (!payload.access_token) {
    throw new Error('Telegraph tidak mengembalikan access_token.');
  }

  return payload;
}

async function createTelegraphPreviewPage(options = {}) {
  const {
    accessToken,
    title,
    imageUrls,
    authorName = '',
    authorUrl = ''
  } = options;

  if (!accessToken) {
    throw new Error('Telegraph access token kosong.');
  }

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    throw new Error('Tidak ada gambar untuk dibuat preview.');
  }

  const content = imageUrls.flatMap((url, index) => {
    const nodes = [{
      tag: 'figure',
      children: [{
        tag: 'img',
        attrs: {
          src: url
        }
      }]
    }];

    if (index < imageUrls.length - 1) {
      nodes.push({ tag: 'p', children: [{ tag: 'br' }] });
    }

    return nodes;
  });

  const payload = await callTelegraph('createPage', {
    access_token: accessToken,
    title: title || 'ASUPAN',
    author_name: authorName,
    author_url: authorUrl,
    content: JSON.stringify(content),
    return_content: false
  });

  if (!payload.url) {
    throw new Error('Telegraph tidak mengembalikan URL page.');
  }

  return payload;
}

async function uploadImageToTelegraph(buffer, filename = 'image.jpg') {
  if (!buffer || buffer.length === 0) {
    throw new Error('Buffer gambar kosong.');
  }

  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);

  const response = await fetch(TELEGRAPH_UPLOAD_URL, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60000)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Telegraph upload HTTP ${response.status}: ${truncate(text)}`);
  }

  const payload = parseJson(text);
  const item = Array.isArray(payload) ? payload[0] : null;
  if (!item || !item.src) {
    throw new Error(`Response upload Telegraph tidak berisi src: ${truncate(text)}`);
  }

  return item.src.startsWith('http') ? item.src : `${TELEGRAPH_BASE_URL}${item.src}`;
}

async function callTelegraph(method, params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      body.set(key, String(value));
    }
  }

  const response = await fetch(`${TELEGRAPH_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body,
    signal: AbortSignal.timeout(30000)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Telegraph API HTTP ${response.status}: ${truncate(text)}`);
  }

  const payload = parseJson(text);
  if (!payload || payload.ok !== true) {
    throw new Error(payload && payload.error ? `Telegraph API: ${payload.error}` : `Telegraph API response tidak valid: ${truncate(text)}`);
  }

  return payload.result;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(value, length = 180) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length)}...` : clean;
}

module.exports = {
  createTelegraphAccount,
  createTelegraphPreviewPage,
  uploadImageToTelegraph
};
