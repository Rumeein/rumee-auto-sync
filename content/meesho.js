// ─── Rumee Extension — Meesho Content Script ──────────────────────────────────
// Runs on https://supplier.meesho.com/* (document_idle).
// TIMEOUT_MS, DRIVE_FOLDERS, and JOBS are imported from config.js.
//
// ── Bot detection notes ───────────────────────────────────────────────────────
// Meesho uses Akamai Bot Manager. We run inside a real Chrome session with
// real cookies — the biggest risk factors are already eliminated.
// Additional precautions applied here:
//   • Random delays (base + Math.random() × variance), never fixed ms
//   • Slight scroll before interactions (human-like orientation)
//   • Navigate via sidebar clicks rather than deep-link jumps where possible
//   • Session recovery: if redirected to /login, attempt autofill-based re-login once
//
// ── Job → page mapping ────────────────────────────────────────────────────────
// ME_VIEWS   — dashboard home (DOM scrape, no download)
// ME_ORDERS  — /orders  (async export queue: date range → Export → refresh → download)
// ME_RETURNS — /returns → Return Tracking → Delivered (export → timestamp → download)
// ME_PAYMENTS— /payments → Download ∨ → Payments to Date → Custom Date Range → download
// ME_ADS     — /advertisement (direct API calls → build CSV → UPLOAD_DATA)
// ME_CLAIMS  — /claims  (period select → Export → timestamp → download)
// ME_CATALOG — /inventory → Bulk Stock Update → Download (direct browser download)

'use strict';

// Double-injection guard — prevents duplicate listeners if executeScript reinjecting after
// extension reload. Wraps entire script so no top-level `return` is needed.
if (!window.__rumeeInjected) {
window.__rumeeInjected = true;

// ── Supplier slug ─────────────────────────────────────────────────────────────
// Short ID that appears in all panel URLs. Read from the URL at runtime;
// MEESHO_SUPPLIER_SLUG (config.js) is the compile-time fallback only.
const SUPPLIER_SLUG_FALLBACK = MEESHO_SUPPLIER_SLUG;

// ── Target page definitions ───────────────────────────────────────────────────
const JOB_PAGES = {
  me_views: {
    urlKey:  '/growth',      // panel home: /panel/v3/new/growth/<slug>/home
    navText: ['home', 'dashboard'],
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/growth/${slug}/home`,
  },
  me_orders: {
    urlKey:  '/orders',
    navText: ['orders'],
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/fulfillment/${slug}/orders/`,
  },
  me_returns: {
    urlKey:  '/returns',
    navText: ['returns'],
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/fulfillment/${slug}/returns/returnTracking-completed_delivered`,
  },
  me_payments: {
    urlKey:  '/payments',
    navText: ['payments', 'payouts'],
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/payouts/${slug}/payments`,
  },
  me_ads: {
    urlKey:  '/advertisement',
    navText: ['ads', 'advertisement', 'advertising'],
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/ads/${slug}/advertisement?tab=ALL`,
  },
  me_claims: {
    urlKey:  '/claims',
    navText: ['claims', 'support'],
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/fulfillment/${slug}/claims`,
  },
  me_catalog: {
    urlKey:  '/inventory',
    navText: ['inventory', 'catalog', 'products'],
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/services/${slug}/inventory`,
  },
};

// ── Download URL patterns ─────────────────────────────────────────────────────
const MEESHO_DOWNLOAD_PATTERNS = [
  /\/download/i, /\/export/i, /\/csv/i, /\/report/i,
  /downloadOrders/i, /downloadReturns/i, /downloadPayments/i,
  /amazonaws\.com/i,
  /meesho-prod.*\/file/i,
];

// ── Handler registry ──────────────────────────────────────────────────────────
const HANDLERS = {
  me_views:    handleViews,
  me_orders:   handleOrders,
  me_returns:  handleReturns,
  me_payments: handlePayments,
  me_ads:      handleAds,
  me_claims:   handleClaims,
  me_catalog:  handleCatalog,
};

// Current job being processed — set after askBackground(), read by the
// module-level __rumeeDownload listener below.
let _currentJob = null;

// Set at bootstrap from job.backfillDate (see entry-point IIFE below) —
// background.js's _YESTERDAY_OVERRIDE_BG, set via SET_BACKFILL_OVERRIDE,
// flows into the job object handleContentReady() returns. Mirrors the same
// mechanism in content/flipkart.js. Defaults to null (real yesterday) for
// every normal daily-sync run.
let _YESTERDAY_OVERRIDE = null;

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  const job = await askBackground();
  if (!job) return; // not a Rumee-controlled tab

  if (isLoginPage()) {
    if (isPublicHomepage()) {
      // ── Public homepage (session expired / not logged in) ───────────────────
      // Clicking "Login" either:
      //   a) Auto-logs in via saved session → redirects straight to the panel
      //   b) Goes to the login form → next content-script instance handles autofill
      console.warn('[Rumee/ME] On Meesho public homepage — clicking Login to restore session');
      const loginLink = Array.from(document.querySelectorAll('a, button'))
        .find(el => el.textContent.trim() === 'Login');
      if (loginLink) {
        // The <a> has target="_blank" — .click() would open a new orphan tab.
        // Force navigation in THIS tab so the content script re-fires here after login.
        const loginHref = loginLink.href || 'https://supplier.meesho.com/panel/v3/new/root/login';
        console.log(`[Rumee/ME] Navigating to login: ${loginHref}`);
        window.location.href = loginHref;
        // Page navigates; this script ends here.
        // The login page fires a fresh content-script instance → attemptAutoLogin().
      } else {
        console.error('[Rumee/ME] "Login" link not found on public homepage');
        chrome.runtime.sendMessage({ type: 'PANEL_LOGIN_REQUIRED', jobId: job.id, platform: 'meesho' });
      }
    } else {
      // ── Actual login form ───────────────────────────────────────────────────
      // Chrome has saved credentials; one click on the input triggers autofill.
      console.warn('[Rumee/ME] On login form — attempting autofill login');
      const loggedIn = await attemptAutoLogin();
      if (!loggedIn) {
        console.error('[Rumee/ME] Autofill login failed — manual login required');
        chrome.runtime.sendMessage({ type: 'PANEL_LOGIN_REQUIRED', jobId: job.id, platform: 'meesho' });
      }
      // If loggedIn: page navigated to panel, fresh content-script continues the job.
    }
    return;
  }

  _currentJob = job; // expose to the module-level __rumeeDownload listener
  _YESTERDAY_OVERRIDE = job.backfillDate || null; // backfill hub: target a specific past date instead of real yesterday
  console.log(`[Rumee/ME] ▶ job: ${job.id} | url: ${window.location.href}`);

  // ── Dismiss any ad / promo / cookie popup that blocks the sidebar ──────────
  await dismissMeeshoPopups();

  const handler = HANDLERS[job.id];
  if (!handler) { reportError(job.id, `No handler for "${job.id}"`); return; }

  try {
    await handler(job);
  } catch (err) {
    console.error(`[Rumee/ME] ✖ ${job.id}:`, err);
    reportError(job.id, err.message || String(err));
  }
})();

// ── Background messaging ──────────────────────────────────────────────────────

function askBackground() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: 'CONTENT_READY', url: window.location.href },
      response => resolve(response?.job || null)
    );
  });
}

function reportError(jobId, error) {
  console.error(`[Rumee/ME] error:`, error);
  chrome.runtime.sendMessage({ type: 'JOB_ERROR', jobId, error });
}

function dispatchDownload(job, url, headers, referer) {
  console.log(`[Rumee/ME] ✓ dispatch download for ${job.id}: ${url.slice(0, 120)}`);
  chrome.runtime.sendMessage({
    type:      'DOWNLOAD_URL_CAPTURED',
    jobId:     job.id,
    url, headers, referer,
    filename:  job.filename,
    folderKey: job.folderKey,
    mimeType:  job.mimeType,
  });
}

function dispatchData(job, data) {
  console.log(`[Rumee/ME] ✓ dispatch data for ${job.id} (${data.length} chars)`);
  chrome.runtime.sendMessage({
    type:      'UPLOAD_DATA',
    jobId:     job.id,
    data,
    filename:  job.filename,
    folderKey: job.folderKey,
    mimeType:  job.mimeType,
  });
}

/**
 * Arm both interception layers before clicking a download button.
 *
 * Layer 1 — MAIN-world intercept (primary, preferred):
 *   Sets window.__rumeeIntercepting = true so that intercept.js (running in the
 *   page's own JS context) patches fetch/XHR/anchor/window.open BEFORE the
 *   request reaches Chrome's download manager. Result: __rumeeDownload postMessage
 *   → dispatchDownload() → background re-fetches + uploads. No file saved to disk.
 *
 * Layer 2 — chrome.downloads.onCreated (fallback for navigation-based downloads):
 *   Sends DOWNLOAD_BUTTON_CLICKED to the background so it pre-arms _pendingDownloadJob.
 *   If the download reaches Chrome's download manager (e.g. via window.location redirect),
 *   onCreated fires, cancel() is called synchronously, and the URL is re-fetched.
 *   The file may briefly appear in Downloads but is erased immediately.
 *
 * These two paths are mutually exclusive: if Layer 1 intercepts the request,
 * Chrome never sees it and onCreated never fires.
 */
/**
 * Arm both interception layers before clicking a download button.
 * @param {object} job - The current JOBS entry.
 * @param {string|null} filenameOverride - If provided, overrides job.filename for this download.
 *   Used to inject a date suffix (e.g. "meesho_orders_2026-05-30.csv").
 *   Forwarded to background (for the onCreated fallback path) AND applied to
 *   _currentJob.filename (for the MAIN-world intercept path).
 */
function signalDownloadExpected(job, filenameOverride = null) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: 'DOWNLOAD_BUTTON_CLICKED', jobId: job.id, filenameOverride },
      () => {
        // Keep _currentJob.filename in sync so the MAIN-world relay uses the dated name.
        if (filenameOverride && _currentJob && _currentJob.id === job.id) {
          _currentJob.filename = filenameOverride;
        }
        // Arm both intercept flags.
        // __rumeeIntercepting: fetch/XHR/anchor URL capture (intercept.js)
        // __rumeeCapturingBlob: blob capture via URL.createObjectURL (intercept.js)
        // Both are needed: if the page has other API calls matching _looksLikeDownload,
        // the __rumeeDownload relay clears __rumeeIntercepting. __rumeeCapturingBlob
        // is never cleared by that relay, so blob capture survives the race.
        window.__rumeeIntercepting = true;
        window.__rumeeCapturingBlob = true;
        // Mirror to MAIN world (isolated world flags are not visible to MAIN world)
        window.postMessage({ __rumeeArmCapture: true, __rumeeCapturingBlob: true }, '*');
        setTimeout(() => {
          window.__rumeeIntercepting = false;
          window.__rumeeCapturingBlob = false;
          window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: false }, '*');
        }, 8000);
        resolve();
      }
    );
  });
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function setStorage(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

// ── Navigation helpers ────────────────────────────────────────────────────────

function getSupplierSlug() {
  const m = window.location.href.match(
    /supplier\.meesho\.com\/panel\/v\d+\/new\/[^/]+\/([^/?#]+)/
  );
  return (m && m[1] !== 'undefined') ? m[1] : SUPPLIER_SLUG_FALLBACK;
}

function isOnTargetPage(jobId) {
  const page = JOB_PAGES[jobId];
  if (!page) return false;
  if (jobId === 'me_views') return window.location.href.includes('/growth');
  return window.location.href.includes(page.urlKey);
}

/**
 * Dismiss any modal / ad / promo popup that Meesho shows on login or page load.
 * Tries up to 3 rounds (popups can stack). Safe to call when no popup is present.
 */
async function dismissMeeshoPopups() {
  const CLOSE_SELECTORS = [
    // Generic accessibility close buttons
    '[aria-label="close" i]',
    '[aria-label="Close" i]',
    '[aria-label="dismiss" i]',
    // Meesho-specific patterns observed in the supplier panel
    'button[class*="close" i]',
    'button[class*="Close"]',
    'button[class*="dismiss" i]',
    'button[class*="modal" i]',
    '[data-testid*="close" i]',
    '[data-testid*="dismiss" i]',
    // Generic modal overlay close / skip / dismiss text buttons
  ];
  const CLOSE_TEXTS = ['close', 'skip', 'got it', 'ok', 'dismiss', 'maybe later', 'not now', '✕', '×', 'x'];

  for (let round = 0; round < 3; round++) {
    let dismissed = false;

    // Try selector-based close buttons
    for (const sel of CLOSE_SELECTORS) {
      try {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          btn.click();
          await sleep(600);
          console.log(`[Rumee/ME] Dismissed popup via selector: ${sel}`);
          dismissed = true;
          break;
        }
      } catch (_) {}
    }

    if (!dismissed) {
      // Try text-based close buttons inside known overlay containers
      const overlayContainers = document.querySelectorAll(
        '[class*="modal" i], [class*="overlay" i], [class*="dialog" i], [class*="popup" i], [class*="banner" i]'
      );
      for (const container of overlayContainers) {
        if (!container.offsetParent) continue; // not visible
        const btns = Array.from(container.querySelectorAll('button, a'));
        const closeBtn = btns.find(b => CLOSE_TEXTS.some(t => b.textContent.trim().toLowerCase() === t));
        if (closeBtn) {
          closeBtn.click();
          await sleep(600);
          console.log(`[Rumee/ME] Dismissed popup via text: "${closeBtn.textContent.trim()}"`);
          dismissed = true;
          break;
        }
      }
    }

    if (!dismissed) break; // no popup found this round
    await sleep(800); // wait for popup animation to complete
  }
}

function isLoginPage() {
  const url = window.location.href;
  if (url.includes('/login') || url.includes('/signin') || url.includes('/auth')) return true;
  // Public homepage shown when session expired: supplier.meesho.com/ with Login + Start Selling buttons
  // (panel URLs always contain /panel/)
  if (!url.includes('/panel/')) {
    const hasLoginBtn = Array.from(document.querySelectorAll('a, button'))
      .some(el => el.textContent.trim() === 'Login' || el.textContent.trim() === 'Start Selling');
    if (hasLoginBtn) return true;
  }
  return false;
}

/** True when we are on the public Meesho supplier homepage (not the login form). */
function isPublicHomepage() {
  return !window.location.href.includes('/panel/') &&
         !window.location.href.includes('/login') &&
         Array.from(document.querySelectorAll('a, button'))
           .some(el => el.textContent.trim() === 'Login');
}

/**
 * Navigate to the correct page for a job.
 * Returns true if already on the page; false if navigation was triggered (script will re-fire).
 */
async function goToPage(job) {
  if (isOnTargetPage(job.id)) return true;

  const page = JOB_PAGES[job.id];
  if (!page) throw new Error(`No JOB_PAGES entry for "${job.id}"`);

  await sleep(800 + Math.random() * 1000);

  const slug      = getSupplierSlug();
  const targetUrl = page.pageUrl(slug);

  // IMPORTANT: Meesho is a React SPA — clicking a nav link only does a client-side
  // route change which does NOT reload the page, so the content script never re-fires.
  // window.location.href = full URL always forces a real page reload, which re-triggers
  // the content script. We rely on this reload to continue the job on the correct page.
  console.log(`[Rumee/ME] Navigating to ${targetUrl}`);
  window.location.href = targetUrl;

  return false; // page will reload → content script re-fires → job continues
}

// ── Session recovery ──────────────────────────────────────────────────────────

/**
 * Autofill-based login on the Meesho supplier login form.
 *
 * Meesho uses a 2-step flow: phone number → password/OTP.
 * Chrome's autofill fills each step when the input is clicked/focused.
 * We run up to 2 rounds of (click input → wait for autofill → click submit).
 *
 * Returns true if we end up on a panel page; false if still on a login page.
 */
async function attemptAutoLogin() {
  console.log('[Rumee/ME] Autofill login: starting');

  for (let step = 1; step <= 2; step++) {
    // Find the first visible text/tel/password/email input
    const input = Array.from(document.querySelectorAll(
      'input[type="tel"], input[type="text"], input[type="email"], ' +
      'input[type="password"], input[name*="phone" i], input[name*="mobile" i], ' +
      'input[name*="email" i], input[name*="otp" i], input[name*="password" i]'
    )).find(el => el.offsetParent !== null);

    if (!input) {
      console.warn(`[Rumee/ME] Autofill login step ${step}: no visible input found`);
      break;
    }

    console.log(`[Rumee/ME] Autofill login step ${step}: clicking "${input.type}" input`);
    input.focus();
    input.click();
    await sleep(2000); // give Chrome autofill time to populate the field

    // Click Continue / Next / Login / Verify (whatever the submit button says this step)
    const submitBtn =
      findBtn('Continue') || findBtn('Next') || findBtn('Log in') ||
      findBtn('Login')    || findBtn('Verify')|| findBtn('Sign in') ||
      document.querySelector('button[type="submit"]');

    if (!submitBtn) {
      console.warn(`[Rumee/ME] Autofill login step ${step}: submit button not found`);
      break;
    }

    console.log(`[Rumee/ME] Autofill login step ${step}: clicking "${submitBtn.textContent.trim()}"`);
    submitBtn.click();
    await sleep(6000); // wait for navigation / next step

    // Success: reached the supplier panel
    if (window.location.href.includes('/panel/')) {
      console.log('[Rumee/ME] Autofill login: succeeded — on panel page');
      return true;
    }

    // Still on a login page — try next step (password / OTP)
    if (!isLoginPage()) {
      console.log('[Rumee/ME] Autofill login: succeeded — no longer on login page');
      return true;
    }
  }

  console.warn('[Rumee/ME] Autofill login: failed after 2 steps — manual login needed');
  return false;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function waitForElement(selector, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sels = selector.split(',').map(s => s.trim());
    const check = () => { for (const s of sels) { try { const el = document.querySelector(s); if (el) return el; } catch (_) {} } return null; };
    const existing = check();
    if (existing) return resolve(existing);
    const obs = new MutationObserver(() => { const found = check(); if (found) { obs.disconnect(); clearTimeout(timer); resolve(found); } });
    obs.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
  });
}

function findEl(texts, selector = '*') {
  const els = Array.from(document.querySelectorAll(selector));
  for (const text of texts) {
    const t = text.toLowerCase();
    const found = els.find(el => el.textContent.trim().toLowerCase().includes(t));
    if (found) return found;
  }
  return null;
}

function findBtn(text) {
  return findEl([text], 'button, [role="button"], [role="tab"], a') || null;
}

function findDownloadButton() {
  // 1. CSS selector (class/data-testid)
  let btn = document.querySelector(
    'button[class*="download" i], button[class*="export" i], ' +
    '[data-testid*="download"], [data-testid*="export"]'
  );
  if (btn) return btn;

  // 2. Text content match
  const labels = ['download', 'export', 'generate report', 'generate', 'डाउनलोड'];
  btn = Array.from(document.querySelectorAll('button, [role="button"], a[href]'))
    .find(el => { const t = el.textContent.trim().toLowerCase(); return labels.some(l => t === l || t.startsWith(l)); });
  if (btn) return btn;

  // 3. aria-label / title
  btn = Array.from(document.querySelectorAll('button, [role="button"]'))
    .find(el => {
      const label = ((el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '')).toLowerCase();
      return label.includes('download') || label.includes('export');
    });
  if (btn) return btn;

  // 4. Debug dump
  console.warn('[Rumee/ME] Download button not found. All buttons:');
  document.querySelectorAll('button, [role="button"]').forEach((b, i) =>
    console.warn(`  [${i}] "${b.textContent.trim().slice(0, 60)}" class="${b.className.slice(0, 80)}"`)
  );
  return null;
}

async function clickAndWait(el, ms = 800) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(200 + Math.random() * 100);
  el.click();
  await sleep(ms);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function todayISO()        { return istToday(); }
function yesterdayISO()    { return (_YESTERDAY_OVERRIDE != null) ? _YESTERDAY_OVERRIDE : daysAgoISO(1); }
function daysAgoISO(n)     { return istDaysAgo(n); }
function addDays(iso, n)   { return istAddDays(iso, n); }

// ─── Gap catch-up (single-shot jobs) ───────────────────────────────────────────
// See gap-catchup.js and how-i-work item 18 in project memory. Disabled by
// default; only enabled per-job via gapCatchupJobs during staged rollout.
async function gcIsEnabledFor(jobId) {
  const { gapCatchupEnabled = false, gapCatchupJobs = [] } = await getStorage(['gapCatchupEnabled', 'gapCatchupJobs']);
  return gapCatchupEnabled && gapCatchupJobs.includes(jobId);
}

// Which DATA date to fetch this run — never a "run date" (see gap-catchup.js's
// header comment for that distinction). Example: today's run normally fetches
// yesterday's data; but if a PAST run failed to fetch some earlier date's data,
// that earlier date is what's "owed" and gets retried first, before today's
// own normal (yesterday's) data. No-op — always plain yesterday — unless
// gap-catchup is enabled for this job.
async function gcSingleShotTargetDate(jobId) {
  // A backfill run always wins over gap-catchup's own pending-date pick —
  // otherwise a backfill for date X could silently target gap-catchup's own
  // stuck date instead, whenever gap-catchup happens to have one pending.
  if (_YESTERDAY_OVERRIDE != null) return _YESTERDAY_OVERRIDE;
  if (!(await gcIsEnabledFor(jobId))) return yesterdayISO();
  const { gapCatchupPending = {} } = await getStorage(['gapCatchupPending']);
  const oldest = gcGetOldestPending(gapCatchupPending, jobId);
  return oldest ? oldest.date : yesterdayISO();
}

/**
 * Build a dated filename for Drive uploads.
 * Single-day:   meesho_orders_2026-05-30.csv
 * Date range:   meesho_orders_2026-05-01_2026-05-30.csv
 * Snapshot:     meesho_inventory_2026-05-31.xlsx  (pass same date twice or only fromDate)
 */
function makeDatedFilename(job, fromDate, toDate) {
  const dotIdx = job.filename.lastIndexOf('.');
  const base   = job.filename.slice(0, dotIdx);
  const ext    = job.filename.slice(dotIdx); // includes the dot
  const dateStr = (toDate && toDate !== fromDate) ? `${fromDate}_${toDate}` : fromDate;
  return `${base}_${dateStr}${ext}`;
}

function looksLikeDownload(url) {
  return typeof url === 'string' && MEESHO_DOWNLOAD_PATTERNS.some(p => p.test(url));
}

// ── Download interception ─────────────────────────────────────────────────────
//
// content/intercept.js (world: MAIN, document_start) patches the PAGE's real
// fetch / XHR / anchor and posts {__rumeeDownload: true, url, headers} when
// window.__rumeeIntercepting === true.  We set that flag, listen for the msg,
// then clear the flag — no isolated-world patching needed.

function interceptNextDownload(timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.__rumeeIntercepting = false;
      window.removeEventListener('message', onMsg);
      reject(new Error('interceptNextDownload: timeout — no download captured'));
    }, timeout);

    function onMsg(event) {
      if (!event.data?.__rumeeDownload) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.__rumeeIntercepting = false;
      window.removeEventListener('message', onMsg);
      const { url, headers } = event.data;
      console.log(`[Rumee/ME] ✓ MAIN-world captured: ${url.slice(0, 160)}`);
      resolve({ url, headers: headers || {}, referer: window.location.href });
    }

    window.addEventListener('message', onMsg);
    window.__rumeeIntercepting = true; // tell intercept.js to start catching
  });
}

/**
 * Wait for intercept.js (MAIN world) to post a __rumeeBlob message.
 *
 * Flow:
 *   1. Sets window.__rumeeIntercepting = true immediately (arms intercept.js).
 *   2. intercept.js lets blob-passthrough fetches (e.g. downloadInventoryTemplate)
 *      reach the page with real binary data.
 *   3. Page creates a Blob → calls URL.createObjectURL(blob).
 *   4. intercept.js's URL.createObjectURL patch reads blob as base64 and posts
 *      { __rumeeBlob: true, base64, mimeType, size }.
 *   5. intercept.js's anchor-click listener suppresses the blob: href download.
 *   6. This function resolves with { base64, mimeType, size } for upload.
 *
 * @param {number} timeout - ms to wait before rejecting
 */
function interceptNextBlobDownload(timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const clearMain = () => window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: false }, '*');

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.__rumeeCapturingBlob = false;
      clearMain();
      window.removeEventListener('message', onMsg);
      reject(new Error('interceptNextBlobDownload: timeout — no blob captured'));
    }, timeout);

    function onMsg(event) {
      if (!event.data?.__rumeeBlob) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.__rumeeCapturingBlob = false;
      clearMain();
      window.removeEventListener('message', onMsg);
      const { base64, mimeType, size, error } = event.data;
      if (error || !base64) {
        reject(new Error(`interceptNextBlobDownload: capture failed — ${error || 'empty data'}`));
        return;
      }
      console.log(`[Rumee/ME] ✓ blob captured: ${size} bytes (${mimeType})`);
      resolve({ base64, mimeType: mimeType || '', size });
    }

    window.addEventListener('message', onMsg);
    window.__rumeeCapturingBlob = true;
    // Mirror to MAIN world
    window.postMessage({ __rumeeArmCapture: true, __rumeeCapturingBlob: true }, '*');
  });
}

/**
 * Generic download pattern:
 *   1. Wait up to 10s for a download button
 *   2. Optionally run extraSetup (date range, filters)
 *   3. Intercept click → capture URL → dispatch to background
 */
async function genericDownload(job, extraSetup = null) {
  await sleep(3000 + Math.random() * 1000);
  if (extraSetup) await extraSetup();

  let btn = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    btn = findDownloadButton();
    if (btn) break;
    console.warn(`[Rumee/ME] Download btn attempt ${attempt}/3 — waiting 4s`);
    await sleep(4000);
  }
  if (!btn) throw new Error('Download button not found on page');

  // Signal the background BEFORE clicking — keeps worker alive and pre-arms
  // _pendingDownloadJob so the onCreated handler cancels synchronously.
  await signalDownloadExpected(job);
  await clickAndWait(btn, 500);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ME_VIEWS — Dashboard scrape ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// The Meesho supplier dashboard shows Views and Orders counts for recent dates.
// This handler reads those numbers and appends a row to meesho_views.csv in Drive.
//
// Since we can't know the exact DOM selectors without live inspection, we use
// multiple fallback strategies and log everything for debugging.

async function handleViews(job) {
  const onPage = await goToPage(job);
  if (!onPage) return;

  await sleep(5000); // dashboard takes time to hydrate

  console.log('[Rumee/ME] Views: scraping dashboard');

  // ── Find "Views" metric on the dashboard ──────────────────────────────────
  // Meesho dashboard shows a summary card with Views count.
  // The date shown is usually 1-2 days behind today.

  let viewsCount = null;
  let ordersCount = null;
  let dataDate = yesterdayISO();

  // Strategy: look for elements near the text "Views" or "views"
  const allText = Array.from(document.querySelectorAll('*'))
    .filter(el => el.children.length === 0 && el.textContent.trim().length > 0);

  // Find "Views" label and get the adjacent number
  for (const el of allText) {
    const txt = el.textContent.trim().toLowerCase();
    if (txt === 'views' || txt === 'total views' || txt === 'page views') {
      // The number is usually in a sibling or parent
      const parent = el.parentElement;
      const siblings = parent ? Array.from(parent.children) : [];
      for (const sib of siblings) {
        const num = parseInt(sib.textContent.replace(/,/g, '').trim());
        if (!isNaN(num) && num > 0 && sib !== el) {
          viewsCount = num;
          console.log(`[Rumee/ME] Views: found views=${viewsCount} near "${el.textContent}"`);
          break;
        }
      }
      // Also check grandparent for a numeric sibling
      if (viewsCount === null && parent?.parentElement) {
        const gps = Array.from(parent.parentElement.querySelectorAll('*'))
          .filter(e => e.children.length === 0);
        for (const gp of gps) {
          const num = parseInt(gp.textContent.replace(/,/g, '').trim());
          if (!isNaN(num) && num > 0 && num < 100_000_000) { viewsCount = num; break; }
        }
      }
      if (viewsCount !== null) break;
    }
  }

  // Find "Orders" count similarly
  for (const el of allText) {
    const txt = el.textContent.trim().toLowerCase();
    if (txt === 'orders' || txt === 'total orders' || txt === 'new orders') {
      const parent = el.parentElement;
      const siblings = parent ? Array.from(parent.children) : [];
      for (const sib of siblings) {
        const num = parseInt(sib.textContent.replace(/,/g, '').trim());
        if (!isNaN(num) && num >= 0 && sib !== el) { ordersCount = num; break; }
      }
      if (ordersCount !== null) break;
    }
  }

  // Try to detect the date shown on the dashboard
  for (const el of allText) {
    const txt = el.textContent.trim();
    // Look for date patterns like "29 May 2026" or "29/05/2026"
    const m1 = txt.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
    const m2 = txt.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m1) {
      const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
      const mm = MONTHS[m1[2].toLowerCase().slice(0,3)];
      dataDate = `${m1[3]}-${String(mm).padStart(2,'0')}-${String(parseInt(m1[1])).padStart(2,'0')}`;
      break;
    }
    if (m2) {
      dataDate = `${m2[3]}-${m2[2]}-${m2[1]}`;
      break;
    }
  }

  console.log(`[Rumee/ME] Views: date=${dataDate} views=${viewsCount} orders=${ordersCount}`);

  if (viewsCount === null) {
    // Log the page structure to help with selector identification
    console.warn('[Rumee/ME] Views: could not find views count. Page text sample:');
    allText.slice(0, 50).forEach((el, i) =>
      console.warn(`  [${i}] "${el.textContent.trim().slice(0, 60)}" class="${el.className.slice(0, 40)}"`)
    );
    throw new Error('ME_VIEWS: could not find Views count on dashboard — selectors need updating');
  }

  // ── Build the new CSV row ─────────────────────────────────────────────────
  const newRow = `\n${dataDate},${viewsCount},${ordersCount ?? ''}`;

  // Send to background which will append to meesho_views.csv in Drive
  chrome.runtime.sendMessage({
    type:      'APPEND_VIEW_DATA',
    jobId:     job.id,
    row:       newRow,
    filename:  job.filename,
    folderKey: job.folderKey,
    mimeType:  job.mimeType,
    header:    'Date,Views,Orders',
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ME_ORDERS — Async export queue ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// Flow:
//   1. Click "Download Orders Data ∧" → dropdown opens
//   2. Click "Select Date Range" → modal with From/To calendar + "Export data"
//   3. Fill dates (always yesterday = single day; small file, no lastRun dependency)
//   4. Click "Export data" → save state → wait 35 s → window.location.reload()
//      (file is ready almost instantly but WILL NOT appear in EXPORTED FILES
//       until the page is reloaded — re-opening the dropdown is NOT enough)
//   5. On re-fire (after reload): read saved state → open dropdown →
//      find file by date match → click its "Download" span → done
//
// State key: chrome.storage.local "meOrdersPendingExport"
//   { fromDate, toDate, savedAt }  — cleared once the download is triggered.

async function handleOrders(job) {
  // ── Resume path: page was reloaded after Export was clicked ──────────────
  // Check for a pending export BEFORE navigating — if the key exists we're
  // already on (or about to be on) the orders page with the file ready.
  const { meOrdersPendingExport } = await getStorage(['meOrdersPendingExport']);

  if (meOrdersPendingExport) {
    const { fromDate, toDate, savedAt } = meOrdersPendingExport;
    const ageMin = (Date.now() - (savedAt || 0)) / 60000;

    if (ageMin > 60) {
      // Stale state (> 1 hour old) — something went wrong earlier; start fresh.
      console.warn(`[Rumee/ME] Orders: stale pending export (${ageMin.toFixed(1)} min old) — clearing`);
      await setStorage({ meOrdersPendingExport: null });
    } else {
      console.log(`[Rumee/ME] Orders: resuming after reload — looking for ${fromDate} → ${toDate}`);

      // Make sure we're on the orders page (goToPage navigates if needed and
      // returns false, causing the content script to re-fire with the flag still set).
      const onPage = await goToPage(job);
      if (!onPage) return;

      await sleep(4000 + Math.random() * 1000);

      // Clear the flag NOW so a crash/failure doesn't loop forever.
      await setStorage({ meOrdersPendingExport: null });

      // Open "Download Orders Data" dropdown — the exported file will be visible now.
      const dlDropdown = findBtn('Download Orders Data')
        || findEl(['Download Orders Data', 'Download Orders', 'download orders'], 'button, [role="button"]');
      if (!dlDropdown) throw new Error('ME_ORDERS: "Download Orders Data" button not found after reload');
      await clickAndWait(dlDropdown, 2000);

      // Look for the matching file immediately (it should be there after reload).
      const ordersFilename = makeDatedFilename(job, fromDate, toDate);
      let downloadBtn = findExportedFileDownloadBtn(fromDate, toDate);
      if (downloadBtn) {
        console.log(`[Rumee/ME] Orders: file ready immediately — clicking download (${ordersFilename})`);
        await signalDownloadExpected(job, ordersFilename);
        await clickAndWait(downloadBtn, 500);
        return;
      }

      // If not immediately visible, poll a few times (30 s apart).
      // Each poll: close the dropdown, wait, reopen — page data is fresh because we reloaded.
      for (let poll = 1; poll <= 6; poll++) {
        console.log(`[Rumee/ME] Orders: file not yet visible — poll ${poll}/6, waiting 30 s`);
        document.body.click();
        await sleep(30000);

        const dlDropdown2 = findBtn('Download Orders Data');
        if (!dlDropdown2) { console.warn('[Rumee/ME] Orders: download button gone — aborting'); break; }
        await clickAndWait(dlDropdown2, 2000);

        downloadBtn = findExportedFileDownloadBtn(fromDate, toDate);
        if (downloadBtn) {
          console.log(`[Rumee/ME] Orders: file found on poll ${poll} — clicking download (${ordersFilename})`);
          await signalDownloadExpected(job, ordersFilename);
          await clickAndWait(downloadBtn, 500);
          return;
        }
      }

      throw new Error('ME_ORDERS: exported file not found after reload + 6 × 30 s polls');
    }
  }

  // ── Normal flow (Steps 1–4 then reload) ───────────────────────────────────
  const onPage = await goToPage(job);
  if (!onPage) return;

  await sleep(4000 + Math.random() * 1000);

  // ── Date range: normally yesterday only ────────────────────────────────────
  // The dashboard independently tracks "data available up to" and determines
  // whether a backfill is needed; the extension normally downloads exactly one
  // day so files stay small and uploads stay fast. If gap-catchup is enabled
  // and a previous day's download failed, retry that date first instead.
  const targetDate = await gcSingleShotTargetDate('me_orders');
  const fromDate = targetDate;
  const toDate   = targetDate;

  console.log(`[Rumee/ME] Orders: requesting ${fromDate} → ${toDate}`);

  // ── Step 1: Open "Download Orders Data" dropdown ──────────────────────────
  const downloadDropdown = findBtn('Download Orders Data')
    || findEl(['Download Orders Data', 'Download Orders', 'download orders'], 'button, [role="button"]');
  if (!downloadDropdown) throw new Error('ME_ORDERS: "Download Orders Data" button not found');
  await clickAndWait(downloadDropdown, 1500);

  // ── Step 2: Click "Select Date Range" (with retry — dropdown options may render slowly) ──
  let dateRangeBtn = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    dateRangeBtn = Array.from(document.querySelectorAll('p, span, a, button, [role="button"]'))
      .find(el => el.textContent.trim() === 'Select Date Range' && el.offsetParent !== null)
      || Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && el.offsetParent !== null)
        .find(el => el.textContent.trim() === 'Select Date Range') || null;
    if (dateRangeBtn) break;
    console.warn(`[Rumee/ME] Orders: "Select Date Range" not found (attempt ${attempt}/5) — waiting 1.5s`);
    await sleep(1500);
  }
  if (!dateRangeBtn) throw new Error('ME_ORDERS: "Select Date Range" not found in dropdown');
  await clickAndWait(dateRangeBtn, 1500);

  // ── Step 3: Fill dates in modal (calendar picker) ─────────────────────────
  await fillMeeshoDates(fromDate, toDate);

  // ── Step 4: Click "Export data" ───────────────────────────────────────────
  // Wait up to 4 s for the button to become enabled (calendar selection enables it reactively)
  let exportBtn = null;
  for (let t = 0; t < 8; t++) {
    exportBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => /export/i.test(el.textContent.trim()) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (exportBtn) break;
    await sleep(500);
  }
  if (!exportBtn) throw new Error('ME_ORDERS: "Export data" button not found or still disabled after filling dates');
  await clickAndWait(exportBtn, 1000);
  console.log('[Rumee/ME] Orders: export requested — saving state then reloading in 35 s');

  // ── Step 5: Save state → wait → reload ───────────────────────────────────
  // CRITICAL: The file IS generated almost instantly on Meesho's servers but it
  // WILL NOT appear in the EXPORTED FILES dropdown until the page is reloaded.
  // Re-opening the dropdown without a reload shows stale data. We must reload.
  // After reload the content script re-fires, reads meOrdersPendingExport and
  // skips Steps 1-4, going straight to open-dropdown → find file → download.
  await setStorage({ meOrdersPendingExport: { fromDate, toDate, savedAt: Date.now() } });

  // Wait 35 s for the file to finish generating (usually < 10 s, 35 s is safe).
  console.log('[Rumee/ME] Orders: waiting 35 s for file generation...');
  await sleep(35000);

  console.log('[Rumee/ME] Orders: reloading page to reveal the exported file');
  window.location.reload();
  // Script dies here. Re-fires on reload and takes the resume path above.
}

/**
 * Find the "Download" element in the "EXPORTED FILES" section whose row text
 * contains both the from-date and to-date strings.
 *
 * DOM structure on Meesho (2026-05):
 *   <div class="row">                          ← file row (L2 from Download span)
 *     <div>                                    ← filename column
 *       <p>2026-05-01_2026-05-30_2026-05-31</p>
 *       <p>31 May 2026, 08:05 AM</p>
 *     </div>
 *     <div class="...col">                     ← download column (L1 from Download span)
 *       <span>Download</span>                  ← the element we click
 *     </div>
 *   </div>
 *
 * closest('div[class]') stops at L1 (the download column div, no date text).
 * We must walk up until an ancestor contains BOTH dates — that is L2 (the row).
 * We cap the walk at 6 levels to avoid false-positives from high-level containers
 * that contain ALL rows (which would match every Download span).
 */
function findExportedFileDownloadBtn(fromDate, toDate) {
  // Collect all visible "Download" clickable elements (Meesho uses <span>).
  const dlEls = Array.from(document.querySelectorAll('span, button, a, p'))
    .filter(el => {
      if (!el.offsetParent) return false;
      const t = el.textContent.trim().toLowerCase();
      return t === 'download' || t === 'download ↓' || t === '↓ download';
    });

  for (const el of dlEls) {
    // Walk up (max 6 levels) until an ancestor's text contains both dates.
    // Stop early — if we need more than 6 levels the ancestor is a container
    // that spans multiple rows and would give a false positive.
    let ancestor = el.parentElement;
    for (let lvl = 0; lvl < 6 && ancestor && ancestor !== document.body; lvl++) {
      if (ancestor.textContent.includes(fromDate) && ancestor.textContent.includes(toDate)) {
        console.log(`[Rumee/ME] Orders: matched Download at L${lvl+1}: "${ancestor.textContent.trim().slice(0, 80)}"`);
        return el;
      }
      ancestor = ancestor.parentElement;
    }
  }

  // Debug dump — show the Download spans and their walk chain.
  console.warn(`[Rumee/ME] Orders: file not found for ${fromDate}…${toDate} — ${dlEls.length} Download spans on page`);
  dlEls.slice(0, 4).forEach((el, i) => {
    let anc = el.parentElement;
    const chain = [];
    for (let j = 0; j < 5 && anc; j++) {
      chain.push(anc.tagName + '(len=' + anc.textContent.length + ')');
      anc = anc.parentElement;
    }
    console.warn(`  [${i}] chain: ${chain.join(' → ')}`);
  });

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ME_RETURNS — Export queue (same-day ready) ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// Returns are always "last 2 weeks" — no date range control.
// Flow: Return Tracking tab → Delivered sub-tab → Export → find by today's timestamp → download.

async function handleReturns(job) {
  const onPage = await goToPage(job);
  if (!onPage) return;

  await sleep(4000 + Math.random() * 1000);

  console.log('[Rumee/ME] Returns: navigating to Delivered tab');

  // ── Click "Return Tracking" tab ───────────────────────────────────────────
  const trackingTab = findBtn('Return Tracking') || findEl(['Return Tracking', 'Tracking'], '[role="tab"], button');
  if (trackingTab) await clickAndWait(trackingTab, 2000);

  // ── Click "Delivered" sub-tab ─────────────────────────────────────────────
  const deliveredTab = findBtn('Delivered') || findEl(['Delivered'], '[role="tab"], button');
  if (deliveredTab) await clickAndWait(deliveredTab, 2000);

  // ── Click the spreadsheet/download icon dropdown (shows "0/0 files ready ∨") ──
  const filesDropdown = findEl(['files ready', '0 files', 'download', 'export'], '[role="button"], button')
    || findEl(['∨', '▼'], '[role="button"], button');
  if (filesDropdown) {
    await clickAndWait(filesDropdown, 1000);
  } else {
    // Try the generic download button
    const dlBtn = findDownloadButton();
    if (dlBtn) await clickAndWait(dlBtn, 1000);
  }

  // ── Click "Export" to generate a fresh file ───────────────────────────────
  const exportBtn = findBtn('Export') || findBtn('Export data') || findBtn('Generate');
  if (!exportBtn) throw new Error('ME_RETURNS: Export button not found');
  await clickAndWait(exportBtn, 2000);
  console.log('[Rumee/ME] Returns: export triggered');

  // ── Poll for file with today's timestamp (max 5 min) ─────────────────────
  // The export panel (showing Exported Files) may close after clicking Export.
  // Each poll: reopen the files-ready dropdown, then search for today's file.
  const todayStr = todayISO(); // YYYY-MM-DD
  const returnsFilename = makeDatedFilename(job, yesterdayISO(), yesterdayISO());
  const deadline = Date.now() + 5 * 60 * 1000;

  for (let poll = 1; Date.now() < deadline; poll++) {
    // Reopen the export dropdown (counter reads "0/0", "0/1", or "1/1 files ready")
    const filesBtn = Array.from(document.querySelectorAll('button, [role="button"], p'))
      .find(el => el.offsetParent && /\d+\/\d+\s*files?\s*ready/i.test(el.textContent));
    if (filesBtn) {
      await clickAndWait(filesBtn, 1500);
    } else {
      console.warn('[Rumee/ME] Returns: files-ready button not found on poll ' + poll);
    }

    const dlBtn = findExportDownloadByTodayDate(todayStr);
    if (dlBtn) {
      console.log(`[Rumee/ME] Returns: found export on poll ${poll} — downloading as ${returnsFilename}`);
      await signalDownloadExpected(job, returnsFilename);
      await clickAndWait(dlBtn, 500);
      return; // background downloads.onCreated handles capture + upload
    }

    console.log(`[Rumee/ME] Returns: poll ${poll} — file not ready, waiting 30 s`);
    document.body.click(); // close the dropdown before sleeping
    await sleep(30000 + Math.random() * 5000);
  }

  throw new Error('ME_RETURNS: export file did not appear within 5 min');
}

/**
 * Find the "Download" element for a file that was exported today.
 *
 * Uses the same walk-up approach as findExportedFileDownloadBtn — searches for
 * visible "Download" spans and walks up the DOM until an ancestor's text contains
 * today's date in any common format. Excludes "Download POD" (exact text match
 * only) to avoid hitting the per-row POD buttons in the returns table.
 *
 * Also tries to open/read the files dropdown button so the exported files panel
 * is visible before searching — call this AFTER reopening the dropdown.
 *
 * @param {string} todayISO - "YYYY-MM-DD"
 */
function findExportDownloadByTodayDate(todayISO) {
  const [y, m, d] = todayISO.split('-');
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mName = MONTHS[parseInt(m) - 1];
  const todayVariants = [
    todayISO,                           // "2026-05-31"
    `${parseInt(d)} ${mName} ${y}`,     // "31 May 2026"
    `${d} ${mName} ${y}`,              // "31 May 2026" (zero-padded)
    `${parseInt(d)} ${mName}`,          // "31 May"
    `${d}/${m}/${y}`,                   // "31/05/2026"
    `${d}-${m}-${y}`,                   // "31-05-2026"
  ];

  // Exact "download" only — avoids "Download POD", "Download File" etc.
  const dlEls = Array.from(document.querySelectorAll('span, button, a, p'))
    .filter(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download');

  for (const el of dlEls) {
    let ancestor = el.parentElement;
    for (let lvl = 0; lvl < 6 && ancestor && ancestor !== document.body; lvl++) {
      const txt = ancestor.textContent;
      if (todayVariants.some(v => txt.includes(v))) {
        console.log(`[Rumee/ME] Export file matched at L${lvl + 1}: "${txt.trim().slice(0, 80)}"`);
        return el;
      }
      ancestor = ancestor.parentElement;
    }
  }

  // Debug dump
  console.warn(`[Rumee/ME] Export file not found for today (${todayISO}) — ${dlEls.length} "Download" spans on page`);
  dlEls.slice(0, 4).forEach((el, i) => {
    let anc = el.parentElement;
    const chain = [];
    for (let j = 0; j < 5 && anc; j++) {
      chain.push(`${anc.tagName}(len=${anc.textContent.length})`);
      anc = anc.parentElement;
    }
    console.warn(`  [${i}] chain: ${chain.join(' → ')}`);
  });
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ME_PAYMENTS — Custom Date Range → download ZIP ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// Flow: Download ∨ → Payments to Date → Custom Date Range → calendar → Download
// Output is a ZIP file containing one XLSX. We upload the ZIP as-is to Drive.

async function handlePayments(job) {
  const onPage = await goToPage(job);
  if (!onPage) return;

  await sleep(4000 + Math.random() * 1000);

  // ── Determine date range ──────────────────────────────────────────────────
  // Normally yesterday only — the dashboard independently tracks "data
  // available up to" and triggers backfills if needed, extension just
  // downloads one day. If gap-catchup is enabled and a previous day's
  // download failed, retry that date first instead (see gcSingleShotTargetDate).
  const targetDate = await gcSingleShotTargetDate('me_payments');
  const fromDate = targetDate;
  const toDate   = targetDate;

  console.log(`[Rumee/ME] Payments: ${fromDate} → ${toDate}`);

  // ── Click "Download ∨" dropdown (top-right) ──────────────────────────────
  // The element is a <P class="dropdown_la"> — not a <button> or role="button".
  // Use exact-text match to avoid other Ps that contain "download" in longer text.
  // Retry up to 5× (2s apart) in case the React component hasn't rendered yet.
  let dlBtn = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    dlBtn = Array.from(document.querySelectorAll('p, button, [role="button"]'))
      .find(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download');
    if (dlBtn) break;
    console.warn(`[Rumee/ME] Payments: Download dropdown not found (attempt ${attempt}/5) — waiting 2s`);
    await sleep(2000);
  }
  if (!dlBtn) throw new Error('ME_PAYMENTS: Download dropdown not found after 5 attempts');
  await clickAndWait(dlBtn, 1200);

  // ── Click "Payments to Date" option ──────────────────────────────────────
  // Dropdown options are <P> elements (Meesho custom dropdown, not native <select>).
  // Meesho later added a "Payments over time" chart whose LEGEND carries the exact
  // same label — and it sits EARLIER in the DOM, so a plain text match returned the
  // legend. Clicking a chart legend does nothing, the menu closes, no modal opens,
  // and the job then died two steps later with "final Download button not found
  // after 5 attempts" — which is why that error was so misleading: the real failure
  // is here. Confirmed live 2026-08-03: exactly 2 visible matches — the legend at
  // y=684 (the one .find() was picking) and the real menu item at y=195.
  // Disambiguate by requiring the match to sit inside the open download menu,
  // identified by that menu's own first option, "GST Report".
  const inDownloadMenu = (el) => {
    for (let a = el, k = 0; a && k < 6; a = a.parentElement, k++) {
      if (/GST Report/.test(a.textContent || '')) return true;
    }
    return false;
  };
  const paymentsToDateOpt = Array.from(document.querySelectorAll('p, li, [role="option"], button'))
    .filter(el => el.offsetParent && el.textContent.trim() === 'Payments to Date')
    .find(inDownloadMenu);
  if (!paymentsToDateOpt) throw new Error('ME_PAYMENTS: "Payments to Date" option not found in download menu');
  await clickAndWait(paymentsToDateOpt, 1500);

  // ── Select "Custom Date Range" radio ─────────────────────────────────────
  const customRadio = findEl(['Custom Date Range', 'custom date range', 'Custom'], 'input[type="radio"], label, li, button');
  if (customRadio) {
    if (customRadio.tagName === 'INPUT') {
      customRadio.click();
    } else {
      const radio = customRadio.querySelector('input[type="radio"]') || customRadio;
      radio.click();
    }
    await sleep(800);
    console.log('[Rumee/ME] Payments: selected Custom Date Range');
  } else {
    console.warn('[Rumee/ME] Payments: Custom Date Range radio not found — proceeding anyway');
  }

  // ── Fill dates ─────────────────────────────────────────────────────────────
  await fillMeeshoDates(fromDate, toDate);

  // ── Click "Download" button in modal ─────────────────────────────────────
  // The modal has a real <button> — use exact-text match to skip the dropdown <P>.
  // Retry up to 5× (2s apart) — same pattern as the dropdown above, since the
  // modal can still be re-rendering right after fillMeeshoDates.
  let finalDlBtn = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    finalDlBtn = Array.from(document.querySelectorAll('button'))
      .find(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download')
      || findBtn('Confirm') || findBtn('Submit');
    if (finalDlBtn) break;
    console.warn(`[Rumee/ME] Payments: final Download button not found (attempt ${attempt}/5) — waiting 2s`);
    await sleep(2000);
  }
  if (!finalDlBtn) throw new Error('ME_PAYMENTS: final Download button not found after 5 attempts');

  const paymentsFilename = makeDatedFilename(job, fromDate, toDate);
  console.log(`[Rumee/ME] Payments: downloading as ${paymentsFilename}`);
  await signalDownloadExpected(job, paymentsFilename);
  await clickAndWait(finalDlBtn, 500);
  // background downloads.onCreated handles capture + upload
  // (auto-detects ZIP vs XLSX from the actual download URL)
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ME_ADS — Direct API calls (no download button) ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// Meesho Ads API only requires two headers + supplier_id in body:
//   client-type: 'd-web'  (static)
//   identifier:  <slug>   (from URL, e.g. 'xuptj')
// No browser-id or supplier-id header needed — confirmed via live testing.
// The numeric supplier_id is extracted from localStorage key patterns.

// Three outputs (all to their own Drive subfolders):
//   1. MASTER  (ME_ADS_MASTER)  — one row per LIVE campaign, LIFETIME totals,
//      upserted by Campaign ID each run (single growing file).
//   2. SUMMARY (ME_ADS_SUMMARY) — per live campaign per day: the "Overview" box.
//   3. CATALOG (ME_ADS_CATALOG) — per live campaign per day: every catalog row.
// Only LIVE campaigns are captured (paused handled separately). One details API
// call per live campaign yields all three (lifetime + daily + catalogs).
async function handleAds(job) {
  const onPage = await goToPage(job);
  if (!onPage) return;

  await sleep(3000 + Math.random() * 1000);

  const slug = getSupplierSlug();
  // Numeric supplier ID from localStorage key names (e.g. ..._1244938 → 1244938)
  const supplierId = (() => {
    for (const k of Object.keys(localStorage)) { const m = k.match(/[_](\d{6,8})$/); if (m) return m[1]; }
    return null;
  })();
  if (!supplierId) throw new Error('ME_ADS: could not determine numeric supplier ID from localStorage');

  const sessionHeaders = { 'identifier': slug, 'client-type': 'd-web', 'browser-id': '', 'supplier-id': supplierId };
  const targetDate = await gcSingleShotTargetDate('me_ads');   // data date (retries a failed past date first if any)
  const runDate    = todayISO();        // master "Last Updated"
  console.log(`[Rumee/ME] Ads: slug=${slug}, supplierId=${supplierId}, target=${targetDate}`);

  // ── Fetch campaigns, keep LIVE only ───────────────────────────────────────
  const allCampaigns = await fetchMeeshoCampaignList(sessionHeaders, supplierId);
  const live = (allCampaigns || []).filter(c => c.status === 'LIVE');
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id,
    text: `Ads: ${(allCampaigns || []).length} campaigns, ${live.length} LIVE` });

  if (live.length === 0) {
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: 'Ads: no LIVE campaigns — nothing to capture' });
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const row = arr => arr.map(q).join(',');
  const perOrder = (spend, orders) => (Number(orders) > 0 ? (Number(spend) / Number(orders)).toFixed(2) : '0');
  const fbLabel = s => ({ RED_ATTENTION: 'Low Orders', GOOD: 'Good', GREEN: 'Good' }[s] || s || '');

  const masterHeader  = 'Last Updated,Campaign ID,Campaign Name,Status,Start Date,Ad Spend,Revenue,Orders,Views,Clicks,ROI,Conversion %,Avg Order Value,Ad Spend Per Order';
  const summaryHeader = 'Date,Campaign ID,Campaign Name,Ad Spend,Revenue,ROI,Ad Spend Per Order,Views,Clicks,Orders,Conversion %,Avg Order Value';
  const catalogHeader = 'Date,Campaign ID,Campaign Name,Catalog ID,Category,Catalog Status,Spend,Revenue,Orders,Views,Clicks,CPC,Conversion %,Delivered ROI,Ad Spend Per Order,Current Performance,Avg Rating,Selected Min ROI';

  const masterRows = [];
  const files = [];

  for (const c of live) {
    const details = await fetchMeeshoCampaignDetails(sessionHeaders, supplierId, c.campaign_id, targetDate, targetDate);
    if (!details) {
      chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `Ads: no details for campaign ${c.campaign_id}` });
      continue;
    }
    const life = details.campaign_overall_performance || {};   // lifetime
    const day  = details.campaign_performance || {};            // requested day
    const startDate = String(details.start_date || c.start_date || '').slice(0, 10);

    // 1 — Master row (lifetime, upserted by Campaign ID = column index 1)
    masterRows.push(row([
      runDate, c.campaign_id, c.campaign_name, c.status, startDate,
      life.total_budget_utilized, life.total_revenue, life.total_orders, life.total_views, life.total_clicks,
      life.roi, life.conversion_rate, life.average_order_value, life.cpo,
    ]));

    // 2 — Summary file (per campaign per day)
    const summaryRow = row([
      targetDate, c.campaign_id, c.campaign_name,
      day.total_budget_utilized, day.total_revenue, day.roi, day.cpo,
      day.total_views, day.total_clicks, day.total_orders, day.conversion_rate, day.average_order_value,
    ]);
    files.push({
      folderKey: 'ME_ADS_SUMMARY', mimeType: 'text/csv',
      filename: `meesho_ads_${c.campaign_id}_summary_${targetDate}.csv`,
      content: summaryHeader + '\n' + summaryRow,
    });

    // 3 — Catalog file (per campaign per day; one row per catalog)
    const catRows = (details.catalogs || []).map(cat => {
      const p = cat.perf_details || {};
      const fb = cat.roi_bidding_catalog_feedback_details?.catalog_feedback_state;
      return row([
        targetDate, c.campaign_id, c.campaign_name, cat.catalog_id,
        Array.isArray(cat.category) ? cat.category.join('|') : cat.category, cat.catalog_status,
        p.budget_utilised, p.revenue, p.order_count, p.total_views, p.total_clicks, p.cpc,
        p.conversion_rate, p.roi, perOrder(p.budget_utilised, p.order_count),
        fbLabel(fb), p.average_rating, cat.bid,
      ]);
    });
    files.push({
      folderKey: 'ME_ADS_CATALOG', mimeType: 'text/csv',
      filename: `meesho_ads_${c.campaign_id}_catalog_${targetDate}.csv`,
      content: catalogHeader + '\n' + catRows.join('\n'),
    });

    await sleep(500 + Math.random() * 300); // pace requests
  }

  // ── Hand the whole bundle to background (it uploads + advances the queue) ──
  chrome.runtime.sendMessage({
    type: 'UPLOAD_ADS_BUNDLE',
    jobId: job.id,
    master: { folderKey: 'ME_ADS_MASTER', filename: 'meesho_ads_master.csv', header: masterHeader, keyColIndex: 1, rows: masterRows },
    files,
  });
}

async function fetchMeeshoCampaignList(sessionHeaders, supplierId) {
  const campaigns = [];
  let page = 1;
  const pageSize = 10;

  while (true) {
    const res = await fetch('https://supplier.meesho.com/api/ads/campaigns/fetch-campaign-list', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'client-type': sessionHeaders['client-type'] || 'd-web',
        'identifier': sessionHeaders['identifier'] || '',
        'supplier-id': supplierId,
        'browser-id': sessionHeaders['browser-id'] || '',
      },
      body: JSON.stringify({
        supplier_id: parseInt(supplierId),
        perf_details_required: true,
        page_number: page,
        page_size: pageSize,
      }),
    });

    if (!res.ok) { console.warn(`[Rumee/ME] Ads: campaign list page ${page} failed: ${res.status}`); break; }
    const data = await res.json();
    const items = data?.data?.campaigns || data?.data?.campaign_list || data?.campaigns || data?.campaign_list || [];
    if (items.length === 0) break;
    campaigns.push(...items);
    if (items.length < pageSize) break; // last page
    page++;
    await sleep(300);
  }

  return campaigns;
}

async function fetchMeeshoCampaignDetails(sessionHeaders, supplierId, campaignId, startDate, endDate) {
  try {
    const res = await fetch('https://supplier.meesho.com/api/ads/campaigns/fetch-campaign-details', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'client-type': sessionHeaders['client-type'] || 'd-web',
        'identifier': sessionHeaders['identifier'] || '',
        'supplier-id': supplierId,
        'browser-id': sessionHeaders['browser-id'] || '',
      },
      body: JSON.stringify({
        supplier_id: parseInt(supplierId),
        campaign_id: String(campaignId),
        page_number: 1,
        page_size: 50,
        start_date: startDate,
        end_date: endDate,
        is_graph_required: false,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data || null;
  } catch (_) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ME_CLAIMS — Period select → Export → timestamp → download ─────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// First run: select "Last 180 Days" (flag stored in chrome.storage.local).
// Subsequent runs: "Last 30 Days" (default — no change needed).

async function handleClaims(job) {
  const onPage = await goToPage(job);
  if (!onPage) return;

  await sleep(4000 + Math.random() * 1000);

  // ── Check first-run flag ──────────────────────────────────────────────────
  const { meeshoClaimsFirstRunDone } = await getStorage(['meeshoClaimsFirstRunDone']);

  if (!meeshoClaimsFirstRunDone) {
    console.log('[Rumee/ME] Claims: FIRST RUN — selecting Last 180 Days');
    const period180 = findEl(['180 Days', '180 days', 'Last 180'], 'select option, li, [role="option"], button');
    if (period180) {
      if (period180.tagName === 'OPTION') {
        period180.parentElement.value = period180.value;
        period180.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // Open the period dropdown first
        const periodDropdown = findEl(['Last 30 Days', '30 Days', 'Last 30', 'Period'], 'select, button, [role="combobox"]');
        if (periodDropdown) await clickAndWait(periodDropdown, 800);
        await clickAndWait(period180, 1000);
      }
      await sleep(2000);
    } else {
      console.warn('[Rumee/ME] Claims: 180 Days option not found — using default period');
    }
    await setStorage({ meeshoClaimsFirstRunDone: true });
  } else {
    console.log('[Rumee/ME] Claims: using default Last 30 Days period');
  }

  // ── Click "Download ∨" dropdown ───────────────────────────────────────────
  // Same <P> pattern as payments — not a <button>.
  const openDownloadDropdown = () =>
    Array.from(document.querySelectorAll('p, button, [role="button"]'))
      .find(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download');

  const dlDropdown = openDownloadDropdown();
  if (!dlDropdown) throw new Error('ME_CLAIMS: Download dropdown not found');
  await clickAndWait(dlDropdown, 1200);

  // ── Click "Export Data" ───────────────────────────────────────────────────
  // Dropdown shows two options: "Export Data" (button) and "Exported Files" (P).
  const exportBtn = Array.from(document.querySelectorAll('button'))
    .find(el => el.offsetParent && el.textContent.trim() === 'Export Data')
    || findBtn('Export') || findBtn('Export data') || findBtn('Generate');
  if (!exportBtn) throw new Error('ME_CLAIMS: Export Data button not found in dropdown');
  await clickAndWait(exportBtn, 2000);
  console.log('[Rumee/ME] Claims: export triggered');

  // ── Poll for file with today's timestamp (max 5 min) ─────────────────────
  // Each poll: open dropdown → click "Exported Files" → search for today's Download span.
  const todayStr     = todayISO();
  const claimsFilename = makeDatedFilename(job, yesterdayISO(), yesterdayISO());
  const deadline     = Date.now() + 5 * 60 * 1000;

  for (let poll = 1; Date.now() < deadline; poll++) {
    // 1. Open the Download dropdown
    const dd = openDownloadDropdown();
    if (dd) await clickAndWait(dd, 1200);

    // 2. Click "Exported Files" panel option
    const exportedFilesOpt = Array.from(document.querySelectorAll('p'))
      .find(el => el.offsetParent && el.textContent.trim() === 'Exported Files');
    if (exportedFilesOpt) await clickAndWait(exportedFilesOpt, 1000);

    // 3. Look for today's Download button in the panel
    const dlBtn = findExportDownloadByTodayDate(todayStr);
    if (dlBtn) {
      console.log(`[Rumee/ME] Claims: found export on poll ${poll} — downloading as ${claimsFilename}`);
      await signalDownloadExpected(job, claimsFilename);
      await clickAndWait(dlBtn, 500);
      return; // background handles capture + upload
    }

    console.log(`[Rumee/ME] Claims: poll ${poll} — file not ready, waiting 30 s`);
    document.body.click(); // close dropdown/panel
    await sleep(30000 + Math.random() * 5000);
  }

  throw new Error('ME_CLAIMS: export did not complete within 5 min');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ME_CATALOG — Blob-capture download → Drive ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// Meesho's "Bulk Stock Update → Download" button triggers a POST to:
//   /api/services/catalogManagement/downloadInventoryTemplate
// which streams a binary XLSX directly — no CDN redirect, so background re-fetch
// after URL capture would fail.
//
// Approach: let the PAGE make its own real POST (intercept.js lets it through via
// _BLOB_PASSTHROUGH_PATTERNS), then capture the resulting Blob via the
// URL.createObjectURL patch in intercept.js before Chrome's download manager
// sees it.  The anchor click (blob: href) is suppressed by intercept.js.
//
//   1. Click "Bulk Stock Update" → modal opens
//   2. interceptNextBlobDownload() arms __rumeeIntercepting = true
//   3. Click the Step-1 Download button in the modal
//      → page's own fetch POST hits the real API → gets binary XLSX
//      → page calls URL.createObjectURL(blob)
//      → intercept.js captures blob as base64, posts __rumeeBlob
//      → intercept.js suppresses the blob: anchor click
//   4. Receive __rumeeBlob → send UPLOAD_DATA{encoding:'base64'} → Drive

async function handleCatalog(job) {
  const onPage = await goToPage(job);
  if (!onPage) return;

  await sleep(5000 + Math.random() * 1000); // inventory table takes longer to load

  const catalogFilename = makeDatedFilename(job, todayISO(), todayISO());
  console.log(`[Rumee/ME] Catalog: opening Bulk Stock Update modal → ${catalogFilename}`);

  // ── Step 1: Click "Bulk Stock Update" to open the modal ──────────────────
  const bulkBtn = findBtn('Bulk Stock Update')
    || findEl(['Bulk Stock Update', 'Bulk Update', 'bulk stock', 'Stock Update'],
               'button, [role="button"], a, p, span');
  if (!bulkBtn) {
    // Debug dump — show all visible buttons to help identify the right one
    console.warn('[Rumee/ME] Catalog: "Bulk Stock Update" not found. All buttons:');
    Array.from(document.querySelectorAll('button, [role="button"], a')).filter(el => el.offsetParent)
      .slice(0, 20).forEach((el, i) =>
        console.warn(`  [${i}] "${el.textContent.trim().slice(0, 60)}"`)
      );
    throw new Error('ME_CATALOG: "Bulk Stock Update" button not found');
  }
  await clickAndWait(bulkBtn, 2500);

  // ── Step 2: Find the Download button in the modal ─────────────────────────
  // The modal has a Step 1 section: "Download the template file".
  // The download button may be: "Download", "Download Template", etc.
  let modalDlBtn = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    // Prefer a button with "download" in its text within a modal/dialog container
    const modalContainers = document.querySelectorAll(
      '[class*="modal" i], [class*="dialog" i], [class*="drawer" i], [class*="popup" i]'
    );
    for (const container of modalContainers) {
      if (!container.offsetParent) continue;
      const btn = Array.from(container.querySelectorAll('button, [role="button"], a'))
        .find(el => el.offsetParent && /download/i.test(el.textContent.trim()));
      if (btn) { modalDlBtn = btn; break; }
    }
    if (!modalDlBtn) {
      // Fallback: any visible "Download" button on the whole page
      modalDlBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download');
    }
    if (modalDlBtn) break;
    console.warn(`[Rumee/ME] Catalog: modal Download button not found (attempt ${attempt}/5) — waiting 2 s`);
    await sleep(2000);
  }
  if (!modalDlBtn) throw new Error('ME_CATALOG: Download button not found in Bulk Stock Update modal');
  console.log(`[Rumee/ME] Catalog: found modal Download button: "${modalDlBtn.textContent.trim()}"`);

  // ── Step 3: Signal + click ────────────────────────────────────────────────
  // The modal Download button opens a pre-signed GCS URL for the XLSX file.
  // signalDownloadExpected arms the background (downloads.onCreated fast path)
  // to cancel + re-fetch the GCS URL and upload directly to Drive.
  // The __rumeeArmCapture postMessage also mirrors flags to MAIN world so the
  // fetch/anchor interceptors catch the GCS URL as a backup (Layer 1).
  await signalDownloadExpected(job, catalogFilename);
  await clickAndWait(modalDlBtn, 300);
  console.log('[Rumee/ME] Catalog: download triggered — background handles GCS URL upload');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Shared helpers ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fill a Meesho date range picker with From and To dates.
 * Strategy order (most reliable first):
 *   1. <input type="date"> native inputs
 *   2. Calendar buttons with aria-label "Fri May 01 2026" (Meesho's primary picker)
 *   3. Text inputs with DD/MM/YYYY placeholder (fallback for other pickers)
 *
 * NOTE: Text inputs (strategy 3) must come AFTER calendar click (strategy 2).
 * Meesho's orders/returns modals show text inputs that are calendar-controlled and
 * do NOT accept typed values — React ignores the synthetic input/change events.
 * Always try aria-label calendar buttons first.
 */
async function fillMeeshoDates(fromISO, toISO) {
  // ── Shared calendar-click helper ────────────────────────────────────────────
  // Different Meesho pages use different aria-label formats:
  //   Orders/Returns: "Fri May 01 2026"  (weekday + month3 + zero-padded day + year)
  //   Payments:       "Jun 2, 2026"      (month3-abbr + day no-pad + comma + year)
  // Navigation is bi-directional: goes forward OR backward to reach target month.
  const clickCalendarDate = async (isoDate) => {
    const [y, m, d] = isoDate.split('-').map(Number);
    const DAYS       = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const MONTHS_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const localDate  = new Date(y, m - 1, d);

    // Format 1 — orders/returns: "Fri May 01 2026"
    const label1 = `${DAYS[localDate.getDay()]} ${MONTHS_ABR[m-1]} ${String(d).padStart(2,'0')} ${y}`;
    // Format 2 — payments: "Jun 2, 2026"  (abbreviated month, no zero-pad, comma)
    const label2 = `${MONTHS_ABR[m-1]} ${d}, ${y}`;

    const targetMonthKey = y * 12 + (m - 1); // numeric key for comparison

    // ── Step 0: Navigate calendar to the correct month ──────────────────────
    // Supports both forward (next) and backward (prev) navigation.
    // Tries up to 14 steps (covers >1 year gap).
    for (let nav = 0; nav < 14; nav++) {
      const already = document.querySelector(
        `[aria-label="${label1}"], [aria-label="${label2}"], [data-date="${isoDate}"]`
      );
      if (already) break;

      // Detect currently displayed month from the calendar header
      // (looks for text like "June 2026" or "Jun 2026" or "May 2026")
      let displayedKey = null;
      const headerEl = Array.from(document.querySelectorAll('*')).find(el => {
        if (!el.offsetParent || el.children.length > 3) return false;
        return /^[A-Za-z]+ \d{4}$/.test(el.textContent.trim());
      });
      if (headerEl) {
        const [hm, hy] = headerEl.textContent.trim().split(' ');
        const hmIdx = MONTHS_ABR.findIndex(a => hm.startsWith(a));
        if (hmIdx !== -1) displayedKey = parseInt(hy) * 12 + hmIdx;
      }

      // Decide direction: go next if displayed < target, prev if displayed > target
      const goNext = displayedKey !== null ? displayedKey < targetMonthKey : false;

      const navBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => {
          if (!el.offsetParent) return false;
          const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
          const cls = (el.className || '').toLowerCase();
          const txt = el.textContent.trim();
          if (goNext) {
            return lbl.includes('next') || /next/i.test(cls) ||
                   ['>','›','→','»'].includes(txt);
          } else {
            return lbl.includes('prev') || lbl.includes('back') ||
                   /prev/i.test(cls) || /back/i.test(cls) ||
                   ['<','‹','←','«'].includes(txt);
          }
        });

      if (!navBtn) {
        console.warn(`[Rumee/ME] Calendar: nav button not found (step ${nav+1}, goNext=${goNext})`);
        break;
      }
      console.log(`[Rumee/ME] Calendar: ${goNext ? 'next' : 'prev'}-month for ${isoDate} (step ${nav+1})`);
      await clickAndWait(navBtn, 600);
    }

    // ── Step 1: Click the date cell ──────────────────────────────────────────
    const ariaCell = document.querySelector(
      `[aria-label="${label1}"], [aria-label="${label2}"], [data-date="${isoDate}"]`
    );
    if (ariaCell) { await clickAndWait(ariaCell, 300); return true; }

    // Fallback: find the calendar container, then click the cell whose text = day number.
    // Scoped to avoid clicking nav arrows or unrelated buttons with the same number.
    const calendarRoot = document.querySelector(
      '[class*="calendar"],[class*="Calendar"],[class*="datepicker"],[class*="DatePicker"],[role="grid"]'
    );
    const searchRoot = calendarRoot || document;
    const cells = Array.from(searchRoot.querySelectorAll(
      'button[class*="day"], button[class*="Day"], td, [role="gridcell"], [role="option"]'
    )).filter(el => el.textContent.trim() === String(d) && el.offsetParent !== null);
    if (cells.length > 0) { await clickAndWait(cells[0], 300); return true; }

    console.warn(`[Rumee/ME] Calendar: cell not found for ${isoDate} (label1="${label1}", label2="${label2}")`);
    return false;
  };

  // 1 — Native date inputs (rare but cleanest)
  const dateInputs = Array.from(document.querySelectorAll('input[type="date"]'));
  if (dateInputs.length >= 2) {
    setValue(dateInputs[0], fromISO);
    await sleep(300);
    setValue(dateInputs[1], toISO);
    await sleep(300);
    console.log(`[Rumee/ME] fillMeeshoDates (type=date): ${fromISO} → ${toISO}`);
    return;
  }

  // 2 — Calendar aria-label buttons (primary for Meesho — orders, returns modals)
  const fromClicked = await clickCalendarDate(fromISO);
  await sleep(500);
  const toClicked   = await clickCalendarDate(toISO);

  if (fromClicked && toClicked) {
    console.log(`[Rumee/ME] fillMeeshoDates (aria-label calendar): ${fromISO} → ${toISO}`);
    return;
  }

  // 3 — Text inputs (DD/MM/YYYY typed entry — payments uses "Select From/To Date" placeholders)
  const ddmmyyyy = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
  const textInputs = Array.from(document.querySelectorAll(
    'input[type="text"][placeholder*="From" i], input[type="text"][placeholder*="To" i], ' +
    'input[type="text"][placeholder*="DD" i], input[type="text"][placeholder*="date" i], ' +
    'input[type="text"][placeholder*="Select" i]'
  )).filter(el => el.offsetParent);
  if (textInputs.length >= 2) {
    setValue(textInputs[0], ddmmyyyy(fromISO));
    await sleep(300);
    setValue(textInputs[1], ddmmyyyy(toISO));
    await sleep(300);
    console.log(`[Rumee/ME] fillMeeshoDates (text DD/MM/YYYY): ${fromISO} → ${toISO}`);
    return;
  }

  // Nothing worked
  if (fromClicked || toClicked) {
    console.warn(`[Rumee/ME] fillMeeshoDates (partial calendar): from=${fromClicked} to=${toClicked} — ${fromISO} → ${toISO}`);
  } else {
    console.warn(`[Rumee/ME] fillMeeshoDates: no strategy worked — ${fromISO} → ${toISO} NOT set`);
  }
}

function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value); else input.value = value;
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// ─── MAIN-world download intercept relay ─────────────────────────────────────
// intercept.js posts { __rumeeDownload: true, url, headers } when a download-like
// fetch/XHR/anchor fires while __rumeeIntercepting is true.
window.addEventListener('message', (event) => {
  if (!event.data?.__rumeeDownload) return;
  if (!_currentJob) return;

  const capturedJob = _currentJob;
  _currentJob = null;                 // consume — prevents double-dispatch
  window.__rumeeIntercepting = false; // disarm

  const { url, headers } = event.data;
  console.log(`[Rumee/ME] ✓ MAIN-world relay: ${url.slice(0, 160)}`);
  dispatchDownload(capturedJob, url, headers || {}, window.location.href);
});

// ─── MAIN-world blob relay ────────────────────────────────────────────────────
// intercept.js posts { __rumeeBlob: true, base64, mimeType, size } when
// URL.createObjectURL is called while __rumeeIntercepting OR __rumeeCapturingBlob
// is true.  interceptNextBlobDownload() (me_catalog) has its own handler that
// fires first and clears __rumeeCapturingBlob.  This module-level handler catches
// the remaining case: any job using signalDownloadExpected whose download is
// blob-based (e.g. me_payments zip, me_returns csv).
window.addEventListener('message', (event) => {
  if (!event.data?.__rumeeBlob) return;
  // Only handle if a regular (non-catalog) interception was armed via signalDownloadExpected.
  // interceptNextBlobDownload (me_catalog) clears __rumeeCapturingBlob itself before this fires.
  if (!window.__rumeeIntercepting && !window.__rumeeCapturingBlob) return;
  if (!_currentJob) return;

  const capturedJob = _currentJob;
  _currentJob = null;
  window.__rumeeIntercepting = false;
  window.__rumeeCapturingBlob = false;

  const { base64, mimeType, size } = event.data;
  console.log(`[Rumee/ME] ✓ blob relay: ${size} bytes (${mimeType}) → ${capturedJob.id}`);

  chrome.runtime.sendMessage({
    type:      'UPLOAD_DATA',
    jobId:     capturedJob.id,
    data:      base64,
    encoding:  'base64',
    filename:  capturedJob.filename, // already has dated suffix from signalDownloadExpected
    folderKey: capturedJob.folderKey,
    mimeType:  capturedJob.mimeType || mimeType,
  });
});

// ─── CDN fetch fallback: content-script fetches URL when background is blocked ──
// Triggered by background.js when a CDN URL fetch fails from the service worker.
// The content script runs at the page origin (supplier.meesho.com), which the
// GCS payment bucket allows via CORS — whereas chrome-extension:// is blocked.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'CS_FETCH_AND_UPLOAD') return;
  const { jobId, url, filename, folderKey, mimeType } = msg;
  console.log(`[Rumee/ME] CS_FETCH_AND_UPLOAD: fetching ${url.slice(0, 80)} for ${jobId}`);

  fetch(url, { credentials: 'include' })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return r.blob();
    })
    .then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]); // base64
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }))
    .then(dataBase64 => {
      chrome.runtime.sendMessage({
        type: 'CS_UPLOAD_DONE', jobId, filename, folderKey, mimeType, dataBase64
      });
    })
    .catch(err => {
      console.error(`[Rumee/ME] CS_FETCH_AND_UPLOAD failed for ${jobId}:`, err);
      chrome.runtime.sendMessage({
        type: 'CS_UPLOAD_DONE', jobId, error: err.message
      });
    });

  sendResponse({ ok: true });
  return true;
});

// ─── MCP Debug Relay ──────────────────────────────────────────────────────────
// Allows the Claude MCP browser tool (which can access supplier.meesho.com but
// not seller.flipkart.com) to:
//   1. Trigger extension jobs:
//      window.postMessage({__rumee:true, msg:{type:'RUN_NOW', jobIds:['fk_returns']}}, '*')
//   2. Read rumeeLog:
//      window.postMessage({__rumee:true, msg:{type:'READ_LOG'}}, '*')
//      → window.__rumeeLog is populated; CustomEvent 'rumeeLogReady' fires
//   3. Read sync status:
//      window.postMessage({__rumee:true, msg:{type:'READ_STATUS'}}, '*')
//      → window.__rumeeStatus is populated; CustomEvent 'rumeeStatusReady' fires
// Only processes messages from the same window (page JS same origin).
window.addEventListener('message', async (event) => {
  // In MV3 isolated worlds, event.source is the page-context window proxy
  // which !== the content-script's window proxy, so we check origin instead.
  if (event.origin !== location.origin) return;
  if (!event.data?.__rumee) return;
  const { msg } = event.data;
  if (!msg?.type) return;

  if (msg.type === 'CLEAR_STORAGE_KEY') {
    chrome.runtime.sendMessage({ type: 'CLEAR_STORAGE_KEY', key: msg.key }, r => {
      window.postMessage({ __rureeClearDone: true, key: msg.key }, '*');
    });
    return;
  }

  if (msg.type === 'READ_LOG') {
    const data = await new Promise(r => chrome.storage.local.get(['rumeeLog'], r));
    window.__rumeeLog = data.rumeeLog || [];
    // Also post back to main world (page context) so MCP tools can read it
    window.postMessage({ __rumeeLogData: true, log: data.rumeeLog || [] }, '*');
    window.dispatchEvent(new CustomEvent('rumeeLogReady'));
    return;
  }

  if (msg.type === 'READ_STATUS') {
    const data = await new Promise(r =>
      chrome.storage.local.get(
        ['syncRunning','syncQueue','syncDone','syncFailed','lastRun','currentJobId'], r
      )
    );
    window.__rumeeStatus = data;
    // Also post back to main world so MCP tools can read it
    window.postMessage({ __rumeeStatusData: true, status: data }, '*');
    window.dispatchEvent(new CustomEvent('rumeeStatusReady'));
    return;
  }

  // All other types (RUN_NOW, STOP_SYNC, VERIFY_NOW, REBUILD_MANIFEST_HISTORY…)
  // forward to background; relay any response back so MCP tools can read
  // sendResponse() return values, not just fire-and-forget.
  chrome.runtime.sendMessage(msg, response => {
    window.postMessage({ __rumeeMsgResponse: true, type: msg.type, response }, '*');
  });
});

} // end double-injection guard
