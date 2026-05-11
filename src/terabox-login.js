'use strict';

const DEFAULT_LOGIN_URL = 'https://www.terabox.com/wap/outlogin/login?type=2&redirectUrl=https%3A%2F%2Fwww.terabox.com%2Fdisk%2Fhome%23%2Fall';

async function loginWithQrCode(options = {}) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: options.headless !== false,
    executablePath: options.executablePath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 420, height: 720, deviceScaleFactor: 2 });
    await page.goto(options.loginUrl || DEFAULT_LOGIN_URL, {
      waitUntil: 'networkidle2',
      timeout: options.navigationTimeoutMs || 45000
    });

    await preferQrLogin(page);

    const qrImage = await captureQrImage(page, options.qrTimeoutMs || 30000);
    if (typeof options.onQrImage === 'function') {
      await options.onQrImage(qrImage);
    }

    const cookies = await waitForNdusCookie(page, options.loginTimeoutMs || 180000);
    return {
      ndus: cookies.ndus,
      cookies: cookies.all,
      pageUrl: page.url()
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function preferQrLogin(page) {
  await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button, a, div, span')];
    const target = candidates.find((item) => {
      const text = (item.textContent || '').trim().toLowerCase();
      const aria = (item.getAttribute('aria-label') || '').trim().toLowerCase();
      const className = String(item.className || '').toLowerCase();
      return text.includes('qr') ||
        text.includes('scan') ||
        text.includes('kode qr') ||
        text.includes('pindai') ||
        aria.includes('qr') ||
        className.includes('qr');
    });

    if (target) {
      target.click();
    }
  }).catch(() => {});

  await sleep(1500);
}

async function captureQrImage(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const qrElement = await findQrElement(page);
    if (qrElement) {
      return qrElement.screenshot({ type: 'png' });
    }

    await sleep(1000);
  }

  return page.screenshot({ type: 'png', fullPage: false });
}

async function findQrElement(page) {
  const selectors = [
    'canvas',
    'img[src*="qr"]',
    'img[src*="qrcode"]',
    '[class*="qr"]',
    '[class*="QRCode"]',
    '[class*="qrcode"]',
    '[id*="qr"]',
    '[id*="qrcode"]'
  ];

  for (const selector of selectors) {
    const handles = await page.$$(selector).catch(() => []);
    for (const handle of handles) {
      const box = await handle.boundingBox().catch(() => null);
      if (box && box.width >= 80 && box.height >= 80) {
        return handle;
      }
    }
  }

  return null;
}

async function waitForNdusCookie(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const all = await page.cookies(
      'https://www.terabox.com',
      'https://terabox.com',
      'https://www.1024terabox.com',
      'https://1024terabox.com'
    ).catch(() => []);
    const ndusCookie = all.find((cookie) => cookie.name === 'ndus' && cookie.value);

    if (ndusCookie) {
      return {
        ndus: ndusCookie.value,
        all
      };
    }

    await sleep(2000);
  }

  throw new Error('Login QR timeout. QR belum selesai discan atau belum dikonfirmasi.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  DEFAULT_LOGIN_URL,
  loginWithQrCode
};
