'use strict';

const DEFAULT_JPG6_BASE_URL = 'https://jpg6.su';
const DEFAULT_JPG6_LOGIN_URL = 'https://jpg6.su/login';

async function loginJpg6Manually(options = {}) {
  const puppeteer = require('puppeteer');
  const loginUrl = options.loginUrl || DEFAULT_JPG6_LOGIN_URL;
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
    await page.setUserAgent(options.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    await gotoJpg6Login(page, loginUrl, options.navigationTimeoutMs || 45000);

    if (typeof options.onReady === 'function') {
      await options.onReady({
        pageUrl: page.url(),
        screenshot: await page.screenshot({ type: 'png', fullPage: false }).catch(() => null)
      });
    }

    const loginState = await waitForJpg6Login(page, options.loginTimeoutMs || 300000);
    const cookies = await page.cookies(DEFAULT_JPG6_BASE_URL, loginUrl);

    return {
      ...loginState,
      cookies,
      pageUrl: page.url()
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function gotoJpg6Login(page, loginUrl, timeoutMs) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      });
      await sleep(5000);

      const currentUrl = page.url();
      if (currentUrl && currentUrl !== 'about:blank') {
        return;
      }

      lastError = new Error('Puppeteer masih berada di about:blank setelah membuka JPG6.');
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Gagal membuka halaman login JPG6 (${loginUrl}): ${lastError ? lastError.message : 'unknown error'}`);
}

async function verifyJpg6Session(session, options = {}) {
  if (!session || !Array.isArray(session.cookies) || session.cookies.length === 0) {
    return {
      connected: false,
      pageUrl: '',
      accountName: ''
    };
  }

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
    await page.setCookie(...session.cookies);
    await page.goto(options.baseUrl || DEFAULT_JPG6_BASE_URL, {
      waitUntil: 'networkidle2',
      timeout: options.navigationTimeoutMs || 45000
    });

    const state = await getJpg6LoginState(page);
    return {
      connected: state.loggedIn,
      accountName: state.accountName,
      pageUrl: page.url()
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function waitForJpg6Login(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await getJpg6LoginState(page);
    if (state.loggedIn) {
      return state;
    }

    await sleep(2000);
  }

  throw new Error('Login JPG6 timeout. Selesaikan login manual di browser sebelum waktu habis.');
}

async function getJpg6LoginState(page) {
  return page.evaluate(() => {
    const text = document.body ? document.body.innerText || '' : '';
    const anchors = [...document.querySelectorAll('a')].map((item) => ({
      text: (item.textContent || '').trim(),
      href: item.href || ''
    }));
    const hasLogout = anchors.some((item) => /logout|sign out/i.test(item.text) || /logout/i.test(item.href));
    const hasLogin = anchors.some((item) => /login|sign in/i.test(item.text) || /login/i.test(item.href));
    const accountNode = document.querySelector('[data-modal="form-user"], .top-bar .user, .user-image, .header-user, [href*="/user/"]');
    const accountName = accountNode ? (accountNode.textContent || accountNode.getAttribute('title') || '').trim() : '';

    return {
      loggedIn: hasLogout || (text.includes('Not logged-in') === false && hasLogin === false && Boolean(accountNode)),
      accountName
    };
  }).catch(() => ({
    loggedIn: false,
    accountName: ''
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  DEFAULT_JPG6_BASE_URL,
  DEFAULT_JPG6_LOGIN_URL,
  loginJpg6Manually,
  verifyJpg6Session
};
