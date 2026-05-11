'use strict';

const DEFAULT_LOGIN_URL = 'https://www.terabox.com/login';

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
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
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
  const clicked = await page.evaluate(() => {
    const visibleBoxes = [...document.querySelectorAll('.other-item .logo')]
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          element,
          box,
          visible: box.width > 0 && box.height > 0
        };
      })
      .filter((item) => item.visible);

    const qrButton = visibleBoxes.sort((a, b) => b.box.left - a.box.left)[0];
    if (qrButton) {
      qrButton.element.click();
      return true;
    }

    return false;
  }).catch(() => false);

  if (!clicked) {
    throw new Error('Tombol QR login TeraBox tidak ditemukan di halaman login.');
  }

  await sleep(2500);
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

  throw new Error('QR login TeraBox tidak muncul. Halaman mungkin berubah atau login QR sedang tidak tersedia.');
}

async function findQrElement(page) {
  const selectors = [
    '.qrcode .qrcode-img',
    '.qrcode img',
    'canvas'
  ];

  for (const selector of selectors) {
    const handles = await page.$$(selector).catch(() => []);
    for (const handle of handles) {
      const box = await handle.boundingBox().catch(() => null);
      if (box && box.width >= 120 && box.height >= 120 && Math.abs(box.width - box.height) <= 30) {
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
