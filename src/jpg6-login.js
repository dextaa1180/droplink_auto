'use strict';

const DEFAULT_JPG6_BASE_URL = 'https://jpg6.su';
const DEFAULT_JPG6_LOGIN_URL = 'https://jpg6.su/login';

async function loginJpg6Manually(options = {}) {
  const puppeteer = require('puppeteer');
  const loginUrl = options.loginUrl || DEFAULT_JPG6_LOGIN_URL;
  const browser = await puppeteer.launch({
    headless: options.headless !== false,
    executablePath: options.executablePath || undefined,
    acceptInsecureCerts: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--ignore-certificate-errors',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900'
    ]
  });

  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(options.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9,id;q=0.8'
    });
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
  const failedRequests = [];

  page.on('requestfailed', (request) => {
    const failure = request.failure();
    failedRequests.push(`${request.url()} => ${failure ? failure.errorText : 'unknown'}`);
    if (failedRequests.length > 5) {
      failedRequests.shift();
    }
  });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const homeResponse = await page.goto(DEFAULT_JPG6_BASE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      });
      await sleep(2500);

      const loginResponse = await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      });
      await sleep(5000);

      const currentUrl = page.url();
      const pageState = await getPageNavigationState(page).catch(() => ({
        location: '',
        title: '',
        bodyLength: 0
      }));
      const responseUrl = loginResponse ? loginResponse.url() : '';
      if (isUsableJpg6Page(currentUrl, responseUrl, pageState)) {
        return;
      }

      if (loginResponse && loginResponse.status() === 200 && /^https:\/\/(?:www\.)?jpg6\.su\//i.test(responseUrl)) {
        const rendered = await renderResponseHtml(page, loginResponse, responseUrl).catch((error) => ({
          ok: false,
          error: error.message,
          state: null
        }));
        if (rendered.ok && isUsableJpg6Page(page.url(), responseUrl, rendered.state)) {
          return;
        }

        lastError = new Error([
          'Puppeteer menerima HTML JPG6 tapi gagal render otomatis',
          `home=${homeResponse ? homeResponse.status() : 'no-response'}`,
          `login=${loginResponse.status()}`,
          `url=${currentUrl || 'empty'}`,
          `responseUrl=${responseUrl || 'empty'}`,
          `location=${rendered.state && rendered.state.location || pageState.location || 'empty'}`,
          `title=${rendered.state && rendered.state.title || pageState.title || 'empty'}`,
          `body=${rendered.state && rendered.state.bodyLength || pageState.bodyLength}`,
          `fallback=${rendered.ok ? 'rendered' : rendered.error || 'failed'}`
        ].join(', '));
        continue;
      }

      lastError = new Error([
        'Puppeteer masih berada di about:blank setelah membuka JPG6',
        `home=${homeResponse ? homeResponse.status() : 'no-response'}`,
        `login=${loginResponse ? loginResponse.status() : 'no-response'}`,
        `url=${currentUrl || 'empty'}`,
        `responseUrl=${responseUrl || 'empty'}`,
        `location=${pageState.location || 'empty'}`,
        `title=${pageState.title || 'empty'}`,
        `body=${pageState.bodyLength}`
      ].join(', '));
    } catch (error) {
      lastError = error;
    }
  }

  const failedText = failedRequests.length > 0 ? ` Failed requests: ${failedRequests.join(' | ')}` : '';
  throw new Error(`Gagal membuka halaman login JPG6 (${loginUrl}): ${lastError ? lastError.message : 'unknown error'}.${failedText}`);
}

async function renderResponseHtml(page, response, responseUrl) {
  const html = await readResponseHtml(response, responseUrl);
  if (!html || html.length < 100) {
    return {
      ok: false,
      error: `HTML kosong atau terlalu pendek (${html ? html.length : 0})`,
      state: null
    };
  }

  const htmlWithBase = injectBaseHref(html, responseUrl);
  await page.setContent(htmlWithBase, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await sleep(2500);
  const state = await getPageNavigationState(page);
  return {
    ok: true,
    state
  };
}

async function readResponseHtml(response, responseUrl) {
  try {
    return await response.text();
  } catch (error) {
    return fetchHtml(responseUrl, error);
  }
}

async function fetchHtml(url, originalError) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9,id;q=0.8',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(45000)
  });

  if (!response.ok) {
    throw new Error(`Puppeteer tidak bisa baca body (${originalError.message}) dan fetch fallback HTTP ${response.status}`);
  }

  return response.text();
}

function injectBaseHref(html, responseUrl) {
  const base = `<base href="${responseUrl.replace(/"/g, '&quot;')}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  }

  return `${base}${html}`;
}

function isUsableJpg6Page(currentUrl, responseUrl, pageState) {
  const candidates = [currentUrl, responseUrl, pageState && pageState.location].filter(Boolean);
  const hasJpg6Url = candidates.some((value) => /^https:\/\/(?:www\.)?jpg6\.su\//i.test(value));
  const hasBody = pageState && Number(pageState.bodyLength) > 100;
  return hasJpg6Url && hasBody;
}

async function getPageNavigationState(page) {
  return page.evaluate(() => ({
    location: window.location.href,
    title: document.title || '',
    bodyLength: document.body ? (document.body.innerText || document.body.textContent || '').length : 0
  }));
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
    acceptInsecureCerts: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--ignore-certificate-errors',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900'
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
