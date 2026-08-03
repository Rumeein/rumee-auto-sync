// â”€â”€â”€ Rumee Extension â€” Flipkart Content Script â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Runs on https://seller.flipkart.com/* (document_idle).
// Flipkart Seller Hub is an AngularJS SPA â€” pages render after hash-change routing.
// TIMEOUT_MS, JOB_GAP_MS, DRIVE_FOLDERS, and JOBS are imported from config.js.
//

// Double-injection guard â€” prevents duplicate listeners if executeScript reinjecting after
// extension reload. Wraps entire script so no top-level `return` is needed.
if (!window.__rumeeInjected) {
window.__rumeeInjected = true;

// Safety: logInfo/logError/logSuccess are background-only (logger.js).
// Polyfill them in case an old cached content script version calls them.
/* eslint-disable no-var */
if (typeof logInfo   === 'undefined') var logInfo   = (j,m) => chrome.runtime.sendMessage({type:'LOG_DEBUG', jobId:j, text:m});
if (typeof logError  === 'undefined') var logError  = (j,m) => chrome.runtime.sendMessage({type:'LOG_DEBUG', jobId:j, text:'ERR:'+m});
if (typeof logSuccess=== 'undefined') var logSuccess= (j,m) => chrome.runtime.sendMessage({type:'LOG_DEBUG', jobId:j, text:'OK:'+m});
/* eslint-enable no-var */
// Hash â†’ job mapping:
//   #reports-centre        â†’ fk_orders, fk_returns, fk_payments   (Scheduled Reports)
//   #ads/reports           â†’ fk_ads_daily/fsn/placements/overall/search/orders/kw
//   #listing-performance   â†’ fk_views  (NXT Insights Traffic Report, requestâ†’waitâ†’download)
//   #keyword-performance   â†’ fk_keywords (DOM scrape, same Traffic Report page)
//   #claims                â†’ fk_claims  (SPF Claims â€” test shortcut; fallback = Help button)
//   #my-listings           â†’ fk_listings (Downloads modal, generation wait, download)

'use strict';

// â”€â”€ Handler registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Current job being processed â€” set after askBackground(), read by the
// module-level __rumeeDownload listener below.
let _currentJob = null;

// Set to true when a handler will fetch the download URL directly from the
// content script (avoiding CORS issues with background re-fetch).
let _handlingDownloadInContentScript = false;

// Campaign cache key in chrome.storage.local.
// Using storage (not module-level) so it survives page reloads between FK ads jobs.
// Shape: { date: 'YYYY-MM-DD', ids: string[]|null }
const _FK_ADS_CACHE_KEY = 'fkAdsCampaignCache';

async function _getCampaignCache() {
  const stored = await chrome.storage.local.get(_FK_ADS_CACHE_KEY);
  const cache = stored[_FK_ADS_CACHE_KEY];
  // Compare against THIS run's actual target date (URL-derived), not a blind
  // yesterdayISO() — otherwise a gap-catchup retry for an older date would
  // always see the cache as "stale" even when fk_ads_daily just set it
  // correctly for that same retried date.
  if (!cache || cache.date !== _fkAdsCurrentTargetDate()) return null; // missing or stale
  return cache;
}

const HANDLERS_FK = {
  fk_orders:          handleFkReportsCentre,   // requestOnly: submits request, no poll
  fk_returns:          handleFkReturnsRequest,  // phase 1: submit request only
  fk_payments:         handleFkReportsCentre,  // requestOnly: submits request, no poll
  fk_rc_download:      handleFkRCDownload,     // polls fk_orders + fk_payments, downloads, reschedules
  fk_ads_daily:        handleFkAds,
  fk_ads_fsn:          handleFkAds,
  fk_ads_placements:   handleFkAds,
  fk_ads_overall:      handleFkAds,
  fk_ads_search:       handleFkAds,
  fk_ads_orders:       handleFkAds,
  fk_ads_kw:           handleFkAds,
  fk_views_request:    handleFkViewsRequest,  // phase 1: submit listings-report request (early)
  fk_views:            handleFkViewsDownload, // phase 2: download when ready (runs after fk_rc_download)
  fk_returns_download: handleFkReturnsDownload, // phase 2: poll + download (runs before fk_keywords)
  fk_keywords:         handleFkKeywords,
  fk_claims:          handleFkClaims,
  fk_listings:        handleFkListings,
  fk_listings_download: handleFkListingsDownload,
};

// Reports Centre sub-type config â€” identifies which row to click per job.
const REPORTS_CENTRE_CFG = {
  // skipCategoryTab: true  â€” stays on "All" tab (category tab click routes away from Reports Centre)
  // requestOnly: true      â€” submit request and proceed immediately, no polling
  // pollForAll: [...]       â€” after own request, poll for ALL listed jobs and download each
  // requestOnly: true â€” submit request and return immediately (no polling)
  // Polling + download handled by fk_rc_download (last job)
  fk_orders:   { categoryTab: 'Fulfilment', skipCategoryTab: true, subType: 'orders',               requestType: 'Fulfilment Reports', requestSubType: 'Orders',               requestOnly: true },
  fk_payments: { categoryTab: null,         skipCategoryTab: true, subType: 'settled transactions', requestType: 'Payment Reports',    requestSubType: 'Settled Transactions', requestOnly: true },
};

// â”€â”€ Entry point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

(async () => {
  const job = await askBackground();
  if (!job) return; // not a Rumee-controlled tab â€” exit silently

  // Check for login wall â€” bot-detected background tabs get redirected here
  const isLoginPage = () => {
    const url   = window.location.href;
    const title = document.title.toLowerCase();
    return url.includes('/login') || url.includes('/signin')
      || title.includes('login')
      || title.includes('sign in')
      // An expired Flipkart session is NOT sent to a login page. FK bounces the
      // tab to its PUBLIC MARKETING page, which matches none of the checks above
      // â€” it advertises signing UP. Observed live 2026-07-29 and 2026-08-03:
      //   https://seller.flipkart.com/?referral_url=%2Findex.html%3F%23dashboard%2Fads%2F...
      //   title "Become an Online Seller in India | Flipkart Seller Hub"
      // Without these two checks the script proceeds as if authenticated and every
      // element lookup fails, surfacing an expired login as "Request New Report /
      // All Returns / Custom Dates button not found" and letting gap-catchup retry
      // a session problem for days. Only these two positively-observed signatures
      // are matched â€” deliberately not a broad "dashboard shell missing" test,
      // which would false-positive during normal early page load.
      // referral_url is FK's own bounce marker; the extension never adds it.
      || /[?&]referral_url=/.test(url)
      || title.includes('become an online seller');
  };

  if (isLoginPage()) {
    console.warn('[Rumee/FK] Landed on login page â€” panel session not active');
    chrome.runtime.sendMessage({
      type:     'PANEL_LOGIN_REQUIRED',
      jobId:    job.id,
      platform: 'flipkart',
    });
    return;
  }

  _currentJob = job; // expose to the module-level __rumeeDownload listener
  _YESTERDAY_OVERRIDE = job.backfillDate || null; // backfill hub: target a specific past date instead of real yesterday
  console.log(`[Rumee/FK] â–¶ job: ${job.id} | url: ${window.location.href}`);

  const handler = HANDLERS_FK[job.id];
  if (!handler) {
    reportError(job.id, `No Flipkart handler for job "${job.id}"`);
    return;
  }

  try {
    await handler(job);
  } catch (err) {
    console.error(`[Rumee/FK] âœ– ${job.id}:`, err);
    reportError(job.id, err.message || String(err));

    // FK Returns is deliberately excluded from gap-catchup's auto-retry (see
    // how-i-work item 18 in project memory) â€” FK's own panel doesn't show
    // which date a pending request is for, only an approximate timestamp,
    // so automated retry risks silently matching the wrong date. Instead of
    // auto-retrying, flag it for manual download immediately on the very
    // first failure â€” reuses the same Discord notify + popup "Mark Done"
    // list gap-catchup already has for the auto-retry jobs, just skipping
    // straight to it with no retry attempt of its own.
    if (job.id === 'fk_returns_download') {
      chrome.runtime.sendMessage({ type: 'GAP_CATCHUP_ESCALATED', jobId: job.id,
        date: yesterdayISO(), daysPending: 1,
        reason: 'FK Returns could not be matched to a ready download automatically' });
    }
  }
})();

// â”€â”€ Background messaging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function askBackground() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: 'CONTENT_READY', url: window.location.href },
      response => resolve(response?.job || null)
    );
  });
}

function reportError(jobId, error) {
  console.error(`[Rumee/FK] error for ${jobId}:`, error);
  chrome.runtime.sendMessage({ type: 'JOB_ERROR', jobId, error });
}

/** Send a captured URL to the background for re-fetching and Drive upload. */
function dispatchDownload(job, url, headers, referer) {
  console.log(`[Rumee/FK] âœ“ dispatching download URL for ${job.id}: ${url.slice(0, 120)}`);
  chrome.runtime.sendMessage({
    type:      'DOWNLOAD_URL_CAPTURED',
    jobId:     job.id,
    url,
    headers,
    referer,
    filename:  job.filename,
    folderKey: job.folderKey,
    mimeType:  job.mimeType,
  });
}

/** Send raw string data (CSV etc.) directly to the background for Drive upload. */
function dispatchData(job, data) {
  console.log(`[Rumee/FK] âœ“ dispatching data for ${job.id} (${data.length} chars)`);
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
 * Layer 1 â€” MAIN-world intercept (primary, preferred):
 *   Sets window.__rumeeIntercepting = true so that intercept.js (running in the
 *   page's own JS context) patches fetch/XHR/anchor/window.open BEFORE the
 *   request reaches Chrome's download manager. Result: __rumeeDownload postMessage
 *   â†’ dispatchDownload() â†’ background re-fetches + uploads. No file saved to disk.
 *
 * Layer 2 â€” chrome.downloads.onCreated (fallback for navigation-based downloads):
 *   Sends DOWNLOAD_BUTTON_CLICKED to the background so it pre-arms _pendingDownloadJob.
 *   If the download reaches Chrome's download manager (e.g. via window.location redirect),
 *   onCreated fires, cancel() is called synchronously, and the URL is re-fetched.
 *   The file may briefly appear in Downloads but is erased immediately.
 *
 * These two paths are mutually exclusive: if Layer 1 intercepts the request,
 * Chrome never sees it and onCreated never fires.
 */
function signalDownloadExpected(job, filenameOverride = null) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_BUTTON_CLICKED', jobId: job.id, filenameOverride }, () => {
      if (filenameOverride && _currentJob && _currentJob.id === job.id) {
        _currentJob.filename = filenameOverride;
      }
      window.__rumeeIntercepting = true;
      window.__rumeeCapturingBlob = true;
      // Mirror to MAIN world (isolated world flags not visible to MAIN world)
      window.postMessage({ __rumeeArmCapture: true, __rumeeCapturingBlob: true }, '*');
      setTimeout(() => {
        window.__rumeeIntercepting = false;
        window.__rumeeCapturingBlob = false;
        window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: false }, '*');
      }, 8000);
      resolve();
    });
  });
}

// â”€â”€ DOM helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Wait for a CSS selector to appear in the DOM (MutationObserver).
 * Supports comma-separated selector lists.
 */
function waitForElement(selector, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sels = selector.split(',').map(s => s.trim());
    const check = () => {
      for (const s of sels) {
        try { const el = document.querySelector(s); if (el) return el; } catch (_) {}
      }
      return null;
    };
    const existing = check();
    if (existing) return resolve(existing);
    const obs = new MutationObserver(() => {
      const found = check();
      if (found) { obs.disconnect(); clearTimeout(timer); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
  });
}

/**
 * Find any element whose trimmed text contains one of the given strings (case-insensitive).
 * @param {string[]} texts    - Candidate substrings to match.
 * @param {string}   selector - CSS selector to limit the search scope.
 */
function findEl(texts, selector = '*') {
  const els = Array.from(document.querySelectorAll(selector));
  for (const text of texts) {
    const t = text.toLowerCase();
    const found = els.find(el => el.textContent.trim().toLowerCase().includes(t));
    if (found) return found;
  }
  return null;
}

/** Convenience: find interactive element (button / role=button / tab / link) by text. */
function findBtn(text) {
  return findEl([text], 'button, [role="button"], [role="tab"], a') || null;
}

/** Scroll into view then click; await ms before returning. */
async function clickAndWait(el, ms = 1000) {
  const _tag = el.tagName || '?';
  const _txt = (el.textContent || '').trim().slice(0, 60);
  const _cls = (typeof el.className === 'string' ? el.className : '').slice(0, 50);
  chrome.runtime.sendMessage({
    type: 'LOG_DEBUG',
    jobId: _currentJob?.id || 'fk',
    text: `CLICK ${_tag} "${_txt}" class="${_cls}" wait=${ms}ms`,
  }).catch(() => {});
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(200);
  el.click();
  await sleep(ms);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Flipkart's calendar widgets (react-dates, shared across Reports Centre and
// All Returns) sometimes render a day cell that LOOKS normal but hasn't been
// "opened" yet for that report/closure period â€” confirmed live 2026-07-13:
// the cell keeps its regular CalendarDay classes but gets pointer-events:none,
// so a click silently no-ops instead of throwing. Checking this BEFORE
// clicking avoids wasting a full submit/wait cycle on a date that was never
// actually selectable â€” the day becomes available on a later date, so this
// is expected/recoverable, not a real failure.
function isFkCalendarDayDisabled(cellEl) {
  if (!cellEl) return false;
  // Two confirmed, distinct disabling mechanisms Flipkart uses (2026-07-14):
  // 1. pointer-events:none - day exists but report period not yet opened ("Invalid date" case).
  // 2. cursor !== 'pointer' (e.g. "no-drop") - day genuinely outside the selectable range
  //    (CalendarDay__blocked_out_of_range class). Checked via cursor, not the class name
  //    itself, so this also catches any other disabled variant Flipkart uses the same way.
  if (getComputedStyle(cellEl).pointerEvents === 'none') return true;
  return getComputedStyle(cellEl).cursor !== 'pointer';
}

/**
 * Dismiss any modal / ad / promo / cookie popup that Flipkart shows on page load.
 * Tries up to 3 rounds (popups can stack). Safe to call when no popup is present.
 */
async function dismissFkPopups() {
  // â”€â”€ Close FK notification panel if auto-opened by report-generation events â”€â”€
  // The panel contains "Mark All as Read" when open. Press Escape to close it.
  const notifOpen = Array.from(document.querySelectorAll('span, button, a, div'))
    .find(el => el.offsetParent !== null && (el.textContent || '').trim() === 'Mark All as Read');
  if (notifOpen) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(400);
    console.log('[Rumee/FK] Closed FK notification panel via Escape');
  }

  const CLOSE_SELECTORS = [
    '[aria-label="close" i]',
    '[aria-label="Close" i]',
    '[aria-label="dismiss" i]',
    'button[class*="close" i]',
    'button[class*="Close"]',
    'button[class*="dismiss" i]',
    '[data-testid*="close" i]',
    '[data-testid*="dismiss" i]',
  ];
  const CLOSE_TEXTS = ['close', 'skip', 'got it', 'ok', 'dismiss', 'maybe later', 'not now', 'no thanks', 'âœ•', 'Ã—', 'x'];

  for (let round = 0; round < 3; round++) {
    let dismissed = false;

    // Guard: never click elements inside the main nav/header (avoids notification bell)
    const _isNavEl = el => !!el.closest('header, nav, [class*="NavigationRail"], [class*="navbar"], [class*="topbar"], [class*="header" i]');

    // Try selector-based close buttons
    for (const sel of CLOSE_SELECTORS) {
      try {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null && !_isNavEl(btn)) {
          btn.click();
          await sleep(600);
          console.log(`[Rumee/FK] Dismissed popup via selector: ${sel}`);
          dismissed = true;
          break;
        }
      } catch (_) {}
    }

    if (!dismissed) {
      // Try text-based close buttons inside known overlay containers
      const overlayContainers = document.querySelectorAll(
        '[class*="modal" i], [class*="overlay" i], [class*="dialog" i], [class*="popup" i], [class*="notify" i]'
      );
      for (const container of overlayContainers) {
        if (!container.offsetParent) continue; // not visible
        const btns = Array.from(container.querySelectorAll('button, a, span'));
        const closeBtn = btns.find(b => CLOSE_TEXTS.some(t => b.textContent.trim().toLowerCase() === t));
        if (closeBtn) {
          closeBtn.click();
          await sleep(600);
          console.log(`[Rumee/FK] Dismissed popup via text: "${closeBtn.textContent.trim()}"`);
          dismissed = true;
          break;
        }
      }
    }

    // Last resort: Escape key (closes most modal dialogs)
    if (!dismissed) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    if (!dismissed) break; // no popup found this round
    await sleep(800);
  }
}

function todayISO() { return istToday(); }
function daysAgoISO(n) { return istDaysAgo(n); }

/** Build a dated filename: flipkart_orders_2026-05-31.xlsx */
function makeDatedFilename(job, fromDate, toDate) {
  const dotIdx = job.filename.lastIndexOf('.');
  const base   = job.filename.slice(0, dotIdx);
  const ext    = job.filename.slice(dotIdx);
  const dateStr = (toDate && toDate !== fromDate) ? `${fromDate}_${toDate}` : fromDate;
  return `${base}_${dateStr}${ext}`;
}
// Was a hardcoded const for manual dev testing. Now also set at runtime from
// job.backfillDate (see the entry-point IIFE below) — background.js's
// _YESTERDAY_OVERRIDE_BG, set via SET_BACKFILL_OVERRIDE, flows into the job
// object handleContentReady() returns. Still defaults to null (real
// yesterday) for every normal daily-sync run.
let _YESTERDAY_OVERRIDE = null;
function yesterdayISO() { return (_YESTERDAY_OVERRIDE != null) ? _YESTERDAY_OVERRIDE : daysAgoISO(1); }
function addDays(isoDate, n) { return istAddDays(isoDate, n); }

// The DATA date this ads job is fetching (never a "run date" — see gap-catchup.js's
// header for that distinction). FK ads jobs navigate with ?duration=YYYY-MM-DD_YYYY-MM-DD
// already set by background.js's getEffectiveStartUrl (gap-catchup-aware — normally
// yesterday's data, a retried older data-date if one's still owed). Reading it back
// from the URL instead of independently recomputing yesterdayISO() is the single
// source of truth, so every date reference within one ads job run agrees, including
// on a retry — the content script never has to know or guess which case it's in.
function _fkAdsCurrentTargetDate() {
  const m = window.location.hash.match(/duration=(\d{4}-\d{2}-\d{2})_/);
  return m ? m[1] : yesterdayISO();
}

/** Dump all interactive elements to console AND to the extension log. */
function debugPage(label = '', jobId = 'fk_debug') {
  const els = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], a[href]'));
  const lines = els.slice(0, 40).map((el, i) =>
    `[${i}] ${el.tagName} "${el.textContent.trim().slice(0, 60)}" aria="${el.getAttribute('aria-label') || ''}"`
  );
  console.warn(`[Rumee/FK] === DEBUG DUMP ${label} ===`, lines);
  // Also send to extension log so we can read it without console access
  chrome.runtime.sendMessage({
    type: 'LOG_DEBUG', jobId, text: `DEBUG ${label} | hash=${window.location.hash.slice(0,80)} | buttons: ${lines.slice(0,15).join(' || ')}`
  });
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function setStorage(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

// Polls for the URL relayed by background.js's RELAY_ARM interceptor (see
// chrome.downloads.onCreated in background.js). Used instead of the
// fetch/XHR-only postMessage relay for downloads that can be triggered via
// window.open/native navigation, which that relay can never see.
async function pollStorageForRelay(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { _relayedDownload } = await getStorage('_relayedDownload');
    if (_relayedDownload) {
      await new Promise(res => chrome.storage.local.remove('_relayedDownload', res));
      return _relayedDownload;
    }
    await sleep(300);
  }
  return null;
}

// â”€â”€ Download interception â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// URL patterns that indicate a file download rather than a normal API call.
const FK_DOWNLOAD_PATTERNS = [
  /\/download/i,
  /\/export/i,
  /downloadReport/i,
  /getReport/i,
  /\.xlsx(\?|$)/i,
  /\.csv(\?|$)/i,
  /\.xls(\?|$)/i,
  /amazonaws\.com/i,      // Flipkart uses pre-signed S3 URLs for most reports
  /storage\.googleapis/i,
  /cdn.*download/i,
];

function looksLikeDownload(url) {
  return typeof url === 'string' && FK_DOWNLOAD_PATTERNS.some(p => p.test(url));
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ Flipkart SPA Navigation helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Flipkart's AngularJS SPA routes to 404 when a deep hash URL is opened in a
// fresh background tab (Angular auth hasn't initialised yet).
// We start from the base index.html and click through the sidebar instead â€”
// same human-like approach used for Meesho.

/**
 * Navigate within the Flipkart SPA by clicking sidebar items sequentially.
 * @param {...string} labels â€” Ordered labels to click, e.g.:
 *   navigateViaFkSidebar('Reports', 'Report Centre')
 *   navigateViaFkSidebar('Ads', 'Reports')
 */
async function navigateViaFkSidebar(...labels) {
  console.log(`[Rumee/FK] Sidebar navigation: ${labels.join(' â†’ ')}`);

  for (let i = 0; i < labels.length; i++) {
    const label  = labels[i];
    const isLast = (i === labels.length - 1);

    const dumpVisible = () => Array.from(document.querySelectorAll('a[href], button'))
      .filter(e => e.offsetParent !== null && e.textContent.trim().length > 0 && e.textContent.trim().length < 70)
      .slice(0, 30)
      .map(e => `${e.tagName}:"${e.textContent.trim()}"`)
      .join(' | ');

    // â”€â”€ Strategy 1: nav / sidebar-scoped selectors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let el = findEl(
      [label],
      'nav a, nav li, nav button, [class*="sidebar"] a, [class*="sidebar"] li, ' +
      '[class*="nav-item"] a, [class*="nav-link"], [class*="sidenav"] a'
    );

    // â”€â”€ Strategy 2: exact text match across all interactive elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!el) {
      const candidates = Array.from(
        document.querySelectorAll('a, button, li, [role="menuitem"]')
      );
      el = candidates.find(e => {
        const t = e.textContent.trim();
        return t === label || t.toLowerCase() === label.toLowerCase();
      }) || null;
    }

    // â”€â”€ Strategy 3: retry for up to 8 s if DOM is still rendering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!el) {
      const retryDeadline = Date.now() + 8000;
      while (!el && Date.now() < retryDeadline) {
        await sleep(1500);
        el = findEl(
          [label],
          'nav a, nav li, nav button, [class*="sidebar"] a, [class*="sidebar"] li, ' +
          '[class*="nav-item"] a, [class*="nav-link"], [class*="sidenav"] a'
        );
        if (!el) {
          const candidates = Array.from(document.querySelectorAll('a, button, li, [role="menuitem"]'));
          el = candidates.find(e => {
            const t = e.textContent.trim();
            return t === label || t.toLowerCase() === label.toLowerCase();
          }) || null;
        }
      }
    }

    if (!el) {
      chrome.runtime.sendMessage({
        type: 'LOG_DEBUG', jobId: 'fk_nav',
        text: `NOT FOUND: "${label}" â€” visible: ${dumpVisible()}`,
      });
      debugPage(`no-nav-item-${label}`);
      throw new Error(`FK sidebar nav: "${label}" not found`);
    }

    chrome.runtime.sendMessage({
      type: 'LOG_DEBUG', jobId: 'fk_nav',
      text: `CLICK: "${el.textContent.trim()}" (${el.tagName} cls="${el.className.slice(0, 60)}")`,
    });

    await clickAndWait(el, isLast ? 4000 : 2000);
    console.log(`[Rumee/FK] Nav clicked: "${label}"`);
    if (!isLast) await sleep(1200); // wait for submenu to expand

  }

  console.log('[Rumee/FK] Sidebar navigation complete');
}

/**
 * Wait for the Flipkart AngularJS SPA to finish bootstrapping.
 * We detect readiness by waiting for sidebar/nav anchor links to appear.
 * Opening a tab directly to a hash URL causes Angular to 404; we must start
 * at index.html, wait for bootstrap, THEN change the hash.
 */
async function waitForSpaBootstrap() {
  console.log('[Rumee/FK] Waiting for SPA bootstrap (looking for sidebar links)...');
  await waitForElement(
    'nav a[href], [class*="sidebar"] a, a[href*="#dashboard"], a[href*="seller.flipkart"]',
    15000
  ).catch(() => console.warn('[Rumee/FK] SPA bootstrap timeout â€” sidebar not detected in 15s'));
  await sleep(2000); // extra settle after first link appears
  console.log('[Rumee/FK] SPA bootstrap ready');
}

/**
 * True ONLY when the URL hash confirms we are on the Reports Centre.
 * Do NOT rely on body text â€” the payments dashboard also contains
 * "Payment Reports" and "Download" in its sidebar, causing false positives.
 */
function isOnReportsCentrePage() {
  return window.location.hash.includes('report-centre');
}

/**
 * Ensure we are on the Reports Centre page.
 * Always force-navigates via hash â€” Flipkart's SPA restores its last page
 * when loading seller.flipkart.com, so we cannot assume we're already there.
 */
async function ensureOnReportsCentre(forceFresh = false) {
  // Always navigate via sidebar when forceFresh=true (needed when "Request New Report"
  // button isn't rendering on stale page). Otherwise skip if already on the page.
  if (!forceFresh && isOnReportsCentrePage()) {
    console.log('[Rumee/FK] Already on Reports Centre âœ“');
    return;
  }

  await waitForSpaBootstrap();
  const fromHash = window.location.hash.slice(0, 80);
  console.log(`[Rumee/FK] Navigating to Reports Centre via sidebar (from: ${fromHash})`);

  // Sidebar navigation is the ONLY reliable method for Flipkart Angular SPA.
  // Hash navigation gets overridden by Angular's router (redirects to home/payments).
  // The sidebar click fires Angular's internal router properly.
  //
  // The "Reports" sidebar item may have doubled text ("ReportsReports") due to
  // icon + label. Strategy 2 in navigateViaFkSidebar handles this via exact match.
  // Sub-item may be "Report Centre" or "Reports Centre" â€” try both.
  let sidebarOk = false;
  // "Reports" sidebar item navigates DIRECTLY to Reports Centre (no sub-menu).
  // Just click it once â€” no sub-label needed.
  try {
    await navigateViaFkSidebar('Reports');
    await sleep(4000);
    if (isOnReportsCentrePage()) { sidebarOk = true; }
  } catch (e) {
    console.warn(`[Rumee/FK] Sidebar Reports click failed: ${e.message}`);
  }

  if (!sidebarOk) {
    // Last resort: hash nav (may get redirected, but worth trying)
    console.log('[Rumee/FK] Sidebar nav failed â€” trying hash nav as last resort');
    window.postMessage({ __rumeeNavigateHash: '#dashboard/metrics/report-centre' }, '*');
    await sleep(8000);
  }

  // Confirm we're on Reports Centre AND page content is loaded
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (isOnReportsCentrePage()) {
      console.log('[Rumee/FK] Reports Centre confirmed âœ“');
      // Switch to "Requested" tab via URL â€” el.click() doesn't trigger Angular's
      // event binding on these <div> chips. Changing the hash query param does.
      const reqQuery = encodeURIComponent(JSON.stringify({
        one_time_request:  { reportGroup: null, reportName: null, enable: true,  status: null },
        repeat_request:    { repeat_report_group_name: null, repeat_report_name: null, repeat_enable: false },
        pagination:        { page_size: 10, starting_page: 1 },
        request_report:    { create_request: false, report_type: null, report_subtype: null, repeat_report: false }
      }));
      window.location.hash = `#dashboard/metrics/report-centre?query=${reqQuery}`;
      await sleep(2500);
      console.log('[Rumee/FK] Navigated to Requested tab âœ“');
      return;
    }
    await sleep(1000);
  }

  throw new Error(`FK_REPORTS: Could not navigate to Reports Centre. Was: ${fromHash}, now: ${window.location.hash.slice(0,80)}`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ FK_ORDERS / FK_RETURNS / FK_PAYMENTS â€” Reports Centre â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Each job navigates to Reports Centre â†’ Requested tab â†’ checks if yesterday's
// report is already available â†’ if not, requests it via "Request New Report" modal.
// All 3 use requestOnly:true so they submit requests and move on immediately.
// fk_rc_download (last job) polls for all 3 and downloads when ready.

// Guard: prevents concurrent instances of the same job when the SW wakes and
// re-queues mid-flight (MV3 service worker lifecycle). Each job gets its own flag.
const _fkRCRunning = {};

async function handleFkReportsCentre(job) {
  await dismissFkPopups();
  const cfg = REPORTS_CENTRE_CFG[job.id];
  if (!cfg) throw new Error(`handleFkReportsCentre: no config for ${job.id}`);

  if (_fkRCRunning[job.id]) {
    console.log(`[Rumee/FK] ${job.id} already running in this context â€” skipping duplicate`);
    return;
  }
  _fkRCRunning[job.id] = true;

  try {
    await _handleFkReportsCentreInner(job, cfg);
  } finally {
    _fkRCRunning[job.id] = false;
  }
}

// ─── Gap catch-up (two-phase FK jobs: fk_orders / fk_payments) ────────────────
// Purely additive on top of the existing Reports Centre flow above. Disabled
// by default (kill switch); only enabled per-job via gapCatchupJobs during
// staged rollout. See gap-catchup.js for the pure decision logic, and
// how-i-work item 18 in project memory for the full design.

async function gcIsEnabledFor(jobId) {
  const { gapCatchupEnabled = false, gapCatchupJobs = [] } = await getStorage(['gapCatchupEnabled', 'gapCatchupJobs']);
  return gapCatchupEnabled && gapCatchupJobs.includes(jobId);
}

// Runs at the top of _handleFkReportsCentreInner (already on the Reports Centre
// page). If a previous day's order for this job was never successfully
// submitted, retry submitting it now — before today's own request happens via
// the unchanged code below. No-op if catch-up is off, or nothing is stuck at
// "not yet submitted" (an already-submitted-but-not-ready order is handled by
// gcCheckFkRCPending in fk_rc_download instead, not here).
async function gcAttemptFkPlacementCatchup(job, cfg) {
  if (!(await gcIsEnabledFor(job.id))) return;

  const { gapCatchupPending = {} } = await getStorage(['gapCatchupPending']);
  const oldest = gcGetOldestPending(gapCatchupPending, job.id);
  if (!oldest || oldest.placed) return;

  const today = todayISO();
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id,
    text: `GapCatchup: retrying stuck submission for ${oldest.date} (day ${oldest.daysPending})` });

  let success = false;
  let lastError = null;
  try {
    await requestNewFkReport(cfg, oldest.date, job.id);
    success = true;
  } catch (e) {
    lastError = e.message;
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id,
      text: `GapCatchup: retry submit failed for ${oldest.date}: ${e.message}` });
  }

  let pending = gapCatchupPending;
  if (success) {
    pending = gcMarkPlaced(pending, job.id, oldest.date);
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id,
      text: `GapCatchup: ${oldest.date} submitted ✓ — now awaiting ready` });
  } else {
    const r = gcRecordOutcome(pending, job.id, oldest.date, today, false);
    pending = r.pendingItems;
    if (r.escalated) {
      chrome.runtime.sendMessage({ type: 'GAP_CATCHUP_ESCALATED', jobId: job.id, date: r.escalated.date, daysPending: r.escalated.daysPending, reason: lastError ? `${lastError} (after ${r.escalated.daysPending} days)` : undefined });
    }
  }
  await new Promise(res => chrome.storage.local.set({ gapCatchupPending: pending }, res));
}

async function _handleFkReportsCentreInner(job, cfg) {
  console.log(`[Rumee/FK] ReportsCentre: job=${job.id} category="${cfg.categoryTab}" subType="${cfg.subType}"`);

  // â”€â”€ Step 1: Navigate to Reports Centre (always fresh via sidebar) â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // forceFresh=true ensures Angular reloads the page so "Request New Report"
  // button is rendered â€” skipping navigation on an already-loaded page causes
  // the button to be absent.
  await ensureOnReportsCentre(true);
  await sleep(2000);

  // â”€â”€ Gap catch-up: retry a stuck-from-a-previous-day submission first, if any â”€
  // (no-op unless explicitly enabled for this job â€” see gcIsEnabledFor above)
  await gcAttemptFkPlacementCatchup(job, cfg);

  // â”€â”€ Step 2: ensureOnReportsCentre already navigated to Requested tab via URL â”€â”€

  // â”€â”€ Step 3: Click the category filter tab (Fulfilment / Payment) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Skip for fk_payments (skipCategoryTab=true) â€” stays on "All" tab which
  // shows Settled Transactions rows without risking clicking the sidebar link.
  if (!cfg.skipCategoryTab && cfg.categoryTab) {
    // Only search [role="tab"] and button â€” never <a> to avoid sidebar nav links
    const catTabEl = findEl([cfg.categoryTab], '[role="tab"]')
      || findEl([cfg.categoryTab], 'button');
    if (catTabEl) {
      await clickAndWait(catTabEl, 2500);
      console.log(`[Rumee/FK] Clicked category: ${cfg.categoryTab}`);
    } else {
      console.warn(`[Rumee/FK] Category tab "${cfg.categoryTab}" not found â€” proceeding unfiltered`);
    }
  } else {
    console.log('[Rumee/FK] Skipping category tab click â€” staying on All tab');
  }

  // â”€â”€ Step 4: Two-phase logic â€” REQUEST then DOWNLOAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  //
  // Phase A â€” Download check: if a ready report already exists for yesterday, use it.
  //
  // Phase B â€” Request: only if no ready report AND we haven't already requested today.
  //   Flipkart REJECTS duplicate requests for the same date period.
  //   Once a request is made, store the date in storage ({jobId}_requested = YYYY-MM-DD).
  //   On all subsequent runs for the same day, skip the request and go straight to polling.
  //
  // Phase C â€” Poll: wait for the requested report to become ready (no re-requesting).

  const yesterday = yesterdayISO();
  const datedFilename = makeDatedFilename(job, yesterday, yesterday);
  const requestedKey = `${job.id}_requested`;

  // â”€â”€ Phase A: check if report already ready or in progress â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let { btn: downloadBtn, status: phaseAStatus } = findReportRowDownloadBtn(cfg.subType, yesterday, job.id);

  // â”€â”€ Phase B: submit request if not found (skip if In Progress or already requested) â”€
  if (!downloadBtn && cfg.requestType && phaseAStatus !== 'in_progress') {
    const stored = await getStorage([requestedKey]);
    const alreadyRequested = stored[requestedKey] === yesterday;
    if (alreadyRequested) {
      console.log(`[Rumee/FK] Already requested ${job.id} for ${yesterday} â€” skipping request`);
    } else {
      console.log(`[Rumee/FK] Requesting "${cfg.requestSubType}" for ${yesterday}`);
      const gcOn = await gcIsEnabledFor(job.id);
      try {
        await requestNewFkReport(cfg, yesterday, job.id);
      } catch (e) {
        // Submission itself failed outright (not just "slow to generate" â€” that
        // case is handled separately in handleFkRCDownload's recheck-exhaustion
        // branch). Track it so tomorrow's run retries the submission, instead
        // of just failing today and moving on.
        if (gcOn) {
          const { gapCatchupPending = {} } = await getStorage(['gapCatchupPending']);
          const r = gcRecordOutcome(gapCatchupPending, job.id, yesterday, todayISO(), false);
          await new Promise(res => chrome.storage.local.set({ gapCatchupPending: r.pendingItems }, res));
          if (r.escalated) {
            chrome.runtime.sendMessage({ type: 'GAP_CATCHUP_ESCALATED', jobId: job.id, date: r.escalated.date, daysPending: r.escalated.daysPending, reason: `${e.message} (after ${r.escalated.daysPending} days)` });
          }
        }
        throw e; // preserve existing behavior â€” job is still marked failed today
      }
      await new Promise(res => chrome.storage.local.set({ [requestedKey]: yesterday }, res));
      console.log(`[Rumee/FK] Request saved: ${requestedKey}=${yesterday}`);
      await sleep(3000);
    }
  } else if (phaseAStatus === 'in_progress') {
    console.log(`[Rumee/FK] ${job.id} already In Progress for ${yesterday} â€” skipping request`);
  }

  // â”€â”€ requestOnly mode: always return immediately â€” fk_rc_download handles all downloads â”€
  // Whether the report is already Generated, In Progress, or just requested,
  // we never download here. fk_rc_download (last job) polls and downloads all 3.
  if (cfg.requestOnly) {
    chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: job.id,
      text: `â–¶ requestOnly â€” moving on (status: ${downloadBtn ? 'ready' : 'requested/pending'}) â€” fk_rc_download will download` });
    // Signal background: this job is done (no file to upload â€” fk_rc_download handles it).
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  // â”€â”€ Phase C: poll for this job's report (or all jobs if pollForAll is set) â”€
  const jobsToPoll = cfg.pollForAll
    ? cfg.pollForAll.map(id => ({ job: JOBS.find(j => j.id === id), cfg: REPORTS_CENTRE_CFG[id] }))
    : [{ job, cfg }];

  const maxAttempts = 12; // 12 Ã— 45s â‰ˆ 9 min
  const downloaded = new Set();
  let lastPollStatus = 'not_found';

  if (!downloadBtn) for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const waitMs = attempt === 1 ? 30000 : 45000;
    await sleep(waitMs);
    await ensureOnReportsCentre(true);
    await sleep(3000);

    // ensureOnReportsCentre already navigated to Requested tab via URL hash.

    // Check each job in the poll list
    for (const { job: pJob, cfg: pCfg } of jobsToPoll) {
      if (downloaded.has(pJob.id)) continue;
      const { btn: pollBtn, status: pollStatus } = findReportRowDownloadBtn(pCfg.subType, yesterday, pJob.id);
      lastPollStatus = pollStatus;
      if (pollBtn) {
        chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: pJob.id,
          text: `âœ“ Report ready on attempt ${attempt} â€” downloading` });
        // Download this report immediately
        const pFilename = makeDatedFilename(pJob, yesterday, yesterday);
        await _downloadFkReport(pJob, pollBtn, pFilename);
        downloaded.add(pJob.id);
      } else {
        chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: pJob.id,
          text: `${pollStatus === 'in_progress' ? 'â³ In Progress' : 'â³ Not found yet'} (attempt ${attempt}/${maxAttempts})` });
      }
    }

    // All done?
    if (jobsToPoll.every(({job: pj}) => downloaded.has(pj.id))) break;
  }

  // Check if the PRIMARY job (this job) was downloaded
  if (!downloaded.has(job.id) && !downloadBtn) {
    if (lastPollStatus === 'in_progress') {
      throw new Error(`${job.id}: still generating after ${maxAttempts} attempts â€” retry next run`);
    }
    throw new Error(`${job.id}: report not found after ${maxAttempts} attempts`);
  }

  // If already downloaded via pollForAll loop, done.
  if (downloaded.has(job.id)) return;

  // â”€â”€ Step 6: Download the primary job's report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await _downloadFkReport(job, downloadBtn, datedFilename);
}

/**
 * Download a FK report by clicking its button and uploading to Drive.
 * @param {boolean} signalDone  When true (default): sends UPLOAD_DATA which marks the job
 *                              done and advances the queue. When false: sends UPLOAD_DATA_SILENT
 *                              which only uploads without touching the queue. Caller is
 *                              responsible for sending JOB_DONE when all uploads finish.
 * @param {boolean} useLayer2   When true: use blob capture (URL.createObjectURL interception,
 *                              Layer 2) instead of the RELAY_ARM download-URL capture (Layer 1).
 *                              Layer 2 is required for Flipkart Ads Other Reports, where the
 *                              Download button POSTs and builds a Blob client-side rather than
 *                              triggering a real navigable download URL.
 */
async function _downloadFkReport(job, dlBtn, filename, signalDone = true, useLayer2 = false) {
  console.log(`[Rumee/FK] Downloading for ${job.id} as ${filename} (layer=${useLayer2 ? 2 : 1})`);

  if (useLayer2) {
    // Flipkart Ads Other Reports download flow:
    //   1. Click fires a POST to /fed-ads/download/table â†’ server returns binary CSV
    //   2. Page creates Blob(csvData) â†’ URL.createObjectURL(blob) â†’ blob: URL download
    //
    // Strategy: arm ONLY blob capture (NOT fetch interception) so the page's POST
    // passes through unmodified, gets the real CSV, creates a Blob, and calls
    // URL.createObjectURL. intercept.js captures the Blob as base64 and posts
    // { __rumeeBlob: true }. The module-level __rumeeBlob listener at the bottom of
    // this file sends UPLOAD_DATA to background. For fk_ads_daily, background also
    // sets the campaign cache from the CSV content before calling processNextJob.
    //
    // __rumeeArmCapture: false â†’ __rumeeIntercepting stays false (no fetch URL capture
    //   â€” critical: /fed-ads/download/table matches _DOWNLOAD_PATTERNS and would be
    //     intercepted if __rumeeIntercepting=true, returning a dummy response to the
    //     page so the Blob is never created)
    // __rumeeCapturingBlob: true â†’ URL.createObjectURL patched to capture the Blob

    if (_currentJob) _currentJob.filename = filename; // dated filename for blob relay
    window.__rumeeCapturingBlob = true;
    window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: true }, '*');
    _handlingDownloadInContentScript = true; // block stray __rumeeDownload relay
    await clickAndWait(dlBtn, 300);
    _handlingDownloadInContentScript = false;

    // â”€â”€ Blob timeout guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // _downloadFkReport used to return here immediately (fire-and-forget).
    // If FK does not call URL.createObjectURL (e.g. async report generation,
    // no-data state, or API error), the __rumeeBlob event never fires and the
    // pipeline is stuck forever with no timeout.
    //
    // Fix: wait up to 45 s for the blob.
    //   â€¢ Blob arrives in time  â†’ clear timeout, let module-level listener do UPLOAD_DATA
    //   â€¢ Timeout fires         â†’ reset state, send JOB_ERROR to advance pipeline
    const _LAYER2_TIMEOUT_MS = 45000;
    const _capturedJobId = job.id; // capture in closure â€” _currentJob may change
    await new Promise(resolve => {
      let _settled = false;

      // Peek at blob arrival so we can clear the timeout before it fires.
      // The MODULE-LEVEL listener (below in this file) still does the actual UPLOAD_DATA send.
      const _blobWatcher = ev => {
        if (!ev.data?.__rumeeBlob || _settled) return;
        _settled = true;
        clearTimeout(_timer);
        window.removeEventListener('message', _blobWatcher);
        resolve(); // blob arrived â€” let module-level handler deal with upload
      };
      window.addEventListener('message', _blobWatcher);

      const _timer = setTimeout(() => {
        if (_settled) return;
        _settled = true;
        window.removeEventListener('message', _blobWatcher);
        // Clean up capture state so the next job starts fresh
        window.__rumeeCapturingBlob = false;
        window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: false }, '*');
        _currentJob = null; // prevent stale UPLOAD_DATA from a late-arriving blob
        console.warn(`[Rumee/FK] Layer2 timeout ${_LAYER2_TIMEOUT_MS / 1000}s â€” no blob for ${_capturedJobId}`);
        chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: _capturedJobId,
          text: `Layer2: no blob captured within ${_LAYER2_TIMEOUT_MS / 1000}s for ${_capturedJobId} â€” FK may use async report generation or returned no data` });
        chrome.runtime.sendMessage({ type: 'JOB_ERROR', jobId: _capturedJobId,
          error: `Layer2 blob timeout: FK did not produce a download within ${_LAYER2_TIMEOUT_MS / 1000}s` });
        resolve();
      }, _LAYER2_TIMEOUT_MS);
    });
    return;
  }

  // Layer 1: RELAY_ARM — background's chrome.downloads.onCreated catches the
  // real URL regardless of trigger mechanism (fetch/XHR/click/window.open),
  // cancels synchronously (no Save-As dialog possible), relays URL back.
  await new Promise(res => chrome.runtime.sendMessage({ type: 'RELAY_ARM', jobId: job.id }, res));
  await clickAndWait(dlBtn, 300);
  const relayed = await pollStorageForRelay(TIMEOUT_MS);
  _currentJob = job;
  if (!relayed) {
    chrome.runtime.sendMessage({ type: 'RELAY_DISARM' });
    throw new Error(`FK: no relayed download URL within timeout for ${job.id}`);
  }
  const captured = { url: relayed.url, headers: {} };

  const resp = await fetch(captured.url, { credentials: 'include', headers: captured.headers || {} });
  if (!resp.ok) throw new Error(`FK fetch failed: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = ''; const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  // When signalDone=false (called from fk_rc_download for sub-jobs), await the upload
  // response before returning so caller can send JOB_DONE only after all files are saved.
  await new Promise(res => chrome.runtime.sendMessage({
    type: signalDone ? 'UPLOAD_DATA' : 'UPLOAD_DATA_SILENT',
    jobId: job.id, data: btoa(binary), encoding: 'base64',
    filename, folderKey: job.folderKey, mimeType: job.mimeType,
  }, res));
}

/**
 * Request a fresh one-time report via the "Request New Report" modal.
 * Navigates the modal: type tab â†’ subtype "REQUEST REPORT" â†’ custom date â†’ SUBMIT.
 */
async function requestNewFkReport(cfg, date, jobId = 'fk_report') {
  // â”€â”€ Step A: Click "Request New Report" â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Retry up to 5x2s -- the button can be missing if the SPA hasn't finished
  // rendering yet (same class of failure that broke me_payments' download
  // button -- a single immediate check was too strict).
  let reqBtn = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    reqBtn = findEl(['Request New Report'], 'button, [role="button"]') || findBtn('Request New Report');
    if (reqBtn) break;
    console.warn(`[Rumee/FK] "Request New Report" button not found (attempt ${attempt}/5) -- waiting 2s`);
    await sleep(2000);
  }
  if (!reqBtn) throw new Error(`FK_REPORTS: "Request New Report" button not found after 5 attempts â€” cannot submit ${cfg.requestSubType}`);
  await clickAndWait(reqBtn, 2500);
  console.log('[Rumee/FK] Opened "Request New Report" modal');

  // â”€â”€ Step B: Select report type (e.g. "Payment Reports" / "Fulfilment Reports") â”€â”€
  await sleep(3000); // let modal slide-in animation complete

  // The modal is a slide-in drawer. The Reports Centre table rows ALSO contain
  // "Payment Reports" / "Fulfilment Reports" as type-column text, so searching the
  // whole document would find a <TD> first. Scope search to the modal container.
  // The modal has short innerText (title + 5 tab labels) with no table content.
  const modalRoot = Array.from(document.querySelectorAll('*')).find(el => {
    const t = el.innerText || '';
    return t.includes('Payment Reports')
      && t.includes('Fulfilment Reports')
      && t.includes('Tax Reports')
      && !t.includes('Requested Type')   // exclude background table
      && !t.includes('One Time')         // exclude report rows
      && t.length < 800
      && el !== document.body && el !== document.documentElement;
  });

  const searchRoot = modalRoot || document;
  // Find the pill BUTTON (not a <TD>) with matching type label
  const typeTab = Array.from(searchRoot.querySelectorAll('*'))
    .find(el => (el.innerText || '').trim() === cfg.requestType
      && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE')
    || Array.from(searchRoot.querySelectorAll('*'))
    .find(el => el.children.length === 0 && el.textContent.trim() === cfg.requestType);

  if (typeTab) {
    console.log(`[Rumee/FK] Clicking type tab: <${typeTab.tagName}> "${cfg.requestType}"`);
    typeTab.click();
    await sleep(4000); // wait for sub-type list to render
  } else {
    throw new Error(`FK_REPORTS: type tab "${cfg.requestType}" not found in modal`);
  }

  // â”€â”€ Step C: Find and click "REQUEST REPORT" for the correct sub-type â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Poll up to 10s â€” content may take a moment to render after tab click.
  let reqReportBtn = null;
  for (let attempt = 0; attempt < 5 && !reqReportBtn; attempt++) {
    if (attempt > 0) await sleep(2000);
    // Find leaf element matching sub-type name (e.g. "Settled Transactions")
    // No visibility check â€” modal elements have 0 dimensions during animation
    const allSections = Array.from(document.querySelectorAll('*'))
      .filter(el => el.children.length === 0
        && el.textContent.trim().toLowerCase() === cfg.requestSubType.toLowerCase());
    for (const sec of allSections) {
      let parent = sec.parentElement;
      for (let i = 0; i < 8 && parent; i++) {
        const btn = Array.from(parent.querySelectorAll('*'))
          .find(el => /request\s*report/i.test(el.textContent.trim())
            && el.textContent.trim().length < 30 && el.children.length === 0);
        if (btn) { reqReportBtn = btn; break; }
        parent = parent.parentElement;
      }
      if (reqReportBtn) break;
    }
    if (!reqReportBtn) console.log(`[Rumee/FK] Waiting for "${cfg.requestSubType}" section (attempt ${attempt + 1}/5)...`);
  }
  if (!reqReportBtn) {
    const allTexts = Array.from(document.querySelectorAll('*'))
      .filter(el => el.children.length === 0 && el.textContent.trim().length > 2 && el.textContent.trim().length < 60
        && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE')
      .map(el => el.textContent.trim()).filter((t,i,a) => a.indexOf(t) === i).slice(0, 30).join(' | ');
    throw new Error(`FK_REPORTS: "${cfg.requestSubType}" not found after 10s. All leaf text: ${allTexts.slice(0, 500)}`);
  }
  await clickAndWait(reqReportBtn, 2000);
  console.log(`[Rumee/FK] Clicked "Request Report" for "${cfg.requestSubType}"`);

  // â”€â”€ Step D: Open the date picker + click "custom" chip â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The sub-page has a "Select Date Range" input box â€” must click it first to
  // expand the calendar (monthly/custom chips + year grid).
  const [y, m, d] = date.split('-').map(Number);
  const MONTHS_FULL = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
  const MONTHS_ABR  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const targetMonthText1 = `${MONTHS_FULL[m-1]} ${y}`;
  const targetMonthText2 = `${MONTHS_ABR[m-1]} ${y}`;

  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD: date=${date} target="${targetMonthText1}"` });

  // Helper: find month header in visible calendar
  const findMonthHeader = () => Array.from(document.querySelectorAll('*'))
    .find(el => {
      const t = (el.innerText||'').trim();
      return (t === targetMonthText1 || t === targetMonthText2) && el.offsetParent;
    });

  // Step D-0: Click "Select Date Range" input box to expand the calendar
  // The calendar (monthly/custom chips + grid) is HIDDEN until the input is clicked.
  // Strategy: find the label "Select Date Range", then click its associated input/box.
  let dateRangeClicked = false;
  let dateInputEl = null;
  for (let w = 0; w < 8 && !dateRangeClicked; w++) {
    await sleep(1000);

    // Find the "Select Date Range" label text node
    const selectDateLabel = Array.from(document.querySelectorAll('*'))
      .find(el => el.children.length === 0
        && /select\s*date\s*range/i.test((el.innerText||el.textContent||'').trim()));

    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD-0 w=${w}: selectDateLabel=${!!selectDateLabel}` });

    if (selectDateLabel) {
      // Walk up to find container, then find input/clickable element within it
      let parent = selectDateLabel.parentElement;
      let clickTarget = null;
      for (let i = 0; i < 5 && parent; i++) {
        // Prefer the actual <input> element, then calendar icon, then date value div
        clickTarget = parent.querySelector('input[type="text"], input:not([type="hidden"])')
          || parent.querySelector('svg, [class*="calendar"], [class*="Calendar"], [class*="icon"]')
          || Array.from(parent.querySelectorAll('*'))
              .find(el => el !== selectDateLabel && el.offsetParent
                && (el.tagName === 'INPUT'
                  || (el.innerText||'').includes('2026')
                  || /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(el.innerText||'')));
        if (clickTarget) break;
        parent = parent.parentElement;
      }
      if (!clickTarget) {
        // Last resort: click the entire container row
        clickTarget = selectDateLabel.closest('[class*="date"],[class*="Date"],[class*="range"],[class*="Range"]')
          || selectDateLabel.nextElementSibling
          || selectDateLabel.parentElement;
      }
      if (clickTarget) {
        dateInputEl = clickTarget;
        chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD-0: clicking ${clickTarget.tagName} "${(clickTarget.innerText||'').slice(0,30)}"` });
        clickTarget.click();
        await sleep(1500);
        dateRangeClicked = true;
      }
    } else {
      // Fallback: try clicking any visible date-like input or dropdown
      const fallbackInput = Array.from(document.querySelectorAll('input, [role="combobox"], [class*="DatePicker"], [class*="datePicker"], [class*="date-picker"]'))
        .find(el => el.offsetParent);
      if (fallbackInput) {
        chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD-0 fallback: clicking ${fallbackInput.tagName}` });
        fallbackInput.click();
        await sleep(1500);
        dateRangeClicked = true;
      }
    }
  }

  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD-0 done: dateRangeClicked=${dateRangeClicked}` });

  // Poll for "custom" chip â€” appears after date input is clicked
  // If chip not found after first attempt, try clicking the date box again
  let customChip = null;
  for (let attempt = 0; attempt < 15 && !customChip; attempt++) {
    await sleep(600);
    // Case-insensitive search across all interactive elements
    customChip = Array.from(document.querySelectorAll('button, span, div, li, a, [role="option"], [role="menuitem"]'))
      .find(el => /^custom$/i.test((el.innerText||el.textContent||'').trim()) && el.offsetParent);
    if (!customChip) {
      // Broader: contains "custom" and is small (not a container)
      customChip = Array.from(document.querySelectorAll('button, span, li, a'))
        .find(el => /^custom$/i.test((el.innerText||el.textContent||'').trim()));
    }
    // Every 3 attempts, re-click the date range area in case first click didn't open it
    if (!customChip && attempt % 3 === 2) {
      const retry = dateInputEl || Array.from(document.querySelectorAll('*'))
        .find(el => (el.innerText||'').includes('2026') && el.offsetParent
          && el.children.length <= 3);
      if (retry) {
        chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD retry click attempt ${attempt}` });
        retry.click(); await sleep(500);
      }
    }
  }
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD: customChip found=${!!customChip}` });

  if (customChip) {
    customChip.click();
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: 'StepD: customChip clicked â€” waiting for calendar' });
    // Poll until day-level calendar appears (month header visible)
    let calReady = false;
    for (let w = 0; w < 12 && !calReady; w++) {
      await sleep(600);
      calReady = !!findMonthHeader();
      if (!calReady && w === 5) {
        // Retry: re-click custom chip in case it toggled off
        customChip.click();
        chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: 'StepD: re-clicked customChip at w=5' });
      }
    }
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD: calendar ready=${calReady}` });
  } else {
    // customChip not found â€” log all visible text to debug
    const visText = Array.from(document.querySelectorAll('button, span, li, div[role]'))
      .filter(el => el.offsetParent && (el.innerText||'').trim().length > 0 && (el.innerText||'').trim().length < 30)
      .map(el => (el.innerText||'').trim()).filter((t,i,a)=>a.indexOf(t)===i).slice(0,20).join(' | ');
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD: customChip NOT found. Visible: ${visText}` });
  }

  // â”€â”€ Step D-1: Navigate calendar to target month if not already visible â”€â”€â”€â”€â”€â”€â”€â”€
  // Calendar may open on a different month â€” click next/prev arrows until correct.
  if (!findMonthHeader()) {
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD-1: target month not visible â€” trying navigation arrows` });
    for (let navAttempt = 0; navAttempt < 12; navAttempt++) {
      if (findMonthHeader()) break;
      // Look for next/prev month buttons
      const navBtn = Array.from(document.querySelectorAll('button, [role="button"], span'))
        .find(el => el.offsetParent && (
          /next\s*month|next/i.test(el.getAttribute('aria-label')||'') ||
          (el.textContent||'').trim() === '>' ||
          (el.textContent||'').trim() === 'â€º' ||
          (el.textContent||'').trim() === 'â–¶' ||
          (el.textContent||'').trim() === 'â†’' ||
          /^[>â€ºâ–¶â†’]$/.test((el.textContent||'').trim())
        ));
      if (navBtn) {
        navBtn.click();
        await sleep(400);
        chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD-1: clicked next arrow at attempt ${navAttempt}` });
      } else {
        chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD-1: no nav arrow found at attempt ${navAttempt}` });
        break;
      }
    }
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepD-1: after nav, monthHeader found=${!!findMonthHeader()}` });
  }

  // â”€â”€ Step E: Click the target date in the correct month's calendar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let calCell = null;
  const monthHeader = findMonthHeader();
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepE: monthHeader found=${!!monthHeader}` });
  if (monthHeader) {
    // Walk up to find the calendar container, then find the day cell
    let container = monthHeader.parentElement;
    for (let i = 0; i < 8 && container && !calCell; i++) {
      calCell = Array.from(container.querySelectorAll('td, [role="gridcell"], [role="cell"], button, div, span'))
        .find(el => {
          const txt = (el.innerText||el.textContent||'').trim();
          return txt === String(d) && !el.querySelector('td, [role="gridcell"]');
        });
      container = container.parentElement;
    }
    if (calCell) chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepE: found day cell "${d}" in ${targetMonthText1}` });
    else chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepE: day cell "${d}" NOT found inside monthHeader container` });
  }

  // Fallback: aria-label
  if (!calCell) {
    const label1 = `${MONTHS_FULL[m-1]} ${d}, ${y}`;
    const label2 = `${MONTHS_ABR[m-1]} ${d}, ${y}`;
    calCell = document.querySelector(`[aria-label="${label1}"], [aria-label="${label2}"], [data-date="${date}"]`);
    if (calCell) chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepE: found via aria-label fallback` });
  }

  // Second fallback: search entire document for the day number in a calendar-like element
  if (!calCell) {
    const allDayCells = Array.from(document.querySelectorAll('td, [role="gridcell"]'))
      .filter(el => (el.innerText||el.textContent||'').trim() === String(d));
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepE: fallback2 found ${allDayCells.length} cells with day="${d}"` });
    calCell = allDayCells[0] || null;
  }

  if (!calCell) {
    // Log page state for debugging
    const calText = Array.from(document.querySelectorAll('[role="gridcell"], td'))
      .map(el=>(el.innerText||'').trim()).filter(t=>t).slice(0,20).join(',');
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepE FAIL: no cell for day ${d}. gridcells: ${calText||'none'}` });
    throw new Error(`FK_REPORTS: cannot find date cell for ${date} â€” aborting to avoid wrong-date report`);
  }

  // TWO-DAY range: day-before-yesterday â†’ yesterday. The UI calendar REQUIRES two
  // DISTINCT days (selecting the same day twice leaves the end "Invalid date"),
  // and the server REJECTS to_date = today (today's data doesn't exist). So we
  // shift the range back one day: START = yesterday-1, END = yesterday. The report
  // still covers yesterday (the END = the target day). calCell (found above) is
  // yesterday's cell = the END. Find the day-before cell for the START.
  const findDayCell = (dayNum, mFull, mAbr) => {
    const header = Array.from(document.querySelectorAll('*'))
      .find(el => { const t = (el.innerText||'').trim(); return (t === mFull || t === mAbr) && el.offsetParent; });
    if (header) {
      let c = header.parentElement;
      for (let i = 0; i < 8 && c; i++) {
        const hit = Array.from(c.querySelectorAll('td, [role="gridcell"], button, div, span'))
          .find(el => (el.innerText||el.textContent||'').trim() === String(dayNum) && !el.querySelector('td, [role="gridcell"]'));
        if (hit) return hit;
        c = c.parentElement;
      }
    }
    return null;
  };

  // START = day before yesterday (handles month boundary if yesterday is the 1st).
  const startObj = new Date(y, m - 1, d - 1);
  const sD = startObj.getDate(), sM = startObj.getMonth() + 1, sY = startObj.getFullYear();
  const startCell = findDayCell(sD, `${MONTHS_FULL[sM-1]} ${sY}`, `${MONTHS_ABR[sM-1]} ${sY}`) || calCell;
  await clickAndWait(startCell, 900 + Math.floor(Math.random() * 700)); // click START (day before yesterday)
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepE: clicked start date ${sY}-${String(sM).padStart(2,'0')}-${String(sD).padStart(2,'0')}` });
  await sleep(450 + Math.floor(Math.random() * 550)); // natural pause before second click

  // END = yesterday. Re-find the cell (DOM can re-render after the start click).
  const endCell = findDayCell(d, targetMonthText1, targetMonthText2) || calCell;
  if (isFkCalendarDayDisabled(endCell)) {
    throw new Error(`FK_REPORTS: report period for ${date} not yet available on Flipkart (calendar day disabled) â€” will retry automatically`);
  }
  await clickAndWait(endCell, 800 + Math.floor(Math.random() * 600));
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepE: clicked end date ${date} (range ${sD}â†’${d}) âœ“` });

  // Flipkart sometimes hasn't opened this reporting period yet (confirmed live,
  // 2026-07-13) â€” the end-day cell LOOKS clickable but the click silently no-ops
  // internally, and the date-range display shows "Invalid date" instead of the
  // selected date. This is expected/recoverable (the day becomes available on a
  // later day), not a real failure â€” skip SUBMIT entirely instead of wasting the
  // full 15s banner-wait on a request we already know will not go through.
  const invalidDateShown = Array.from(document.querySelectorAll('*'))
    .some(el => el.children.length === 0 && el.offsetParent && /invalid date/i.test(el.textContent));
  if (invalidDateShown) {
    throw new Error(`FK_REPORTS: report period for ${date} not yet available on Flipkart (calendar shows Invalid date) â€” will retry automatically`);
  }

  // â”€â”€ Step F: Submit + verify success banner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Wait for calendar to close before looking for submit button (human-like pause)
  await sleep(1200 + Math.floor(Math.random() * 900));
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: 'StepF: looking for SUBMIT button' });
  // Search with and without offsetParent check â€” calendar overlay may obscure it
  let submitBtn = Array.from(document.querySelectorAll('button'))
    .find(el => el.offsetParent && /submit/i.test(el.textContent.trim()));
  if (!submitBtn) {
    submitBtn = Array.from(document.querySelectorAll('button'))
      .find(el => /submit/i.test(el.textContent.trim()));
  }
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: `StepF: submitBtn found=${!!submitBtn} text="${(submitBtn?.textContent||'').trim()}"` });
  if (!submitBtn) throw new Error(`FK_REPORTS: SUBMIT button not found â€” report for "${cfg.requestSubType}" was NOT submitted`);
  await sleep(600 + Math.floor(Math.random() * 700)); // brief human pause before submitting
  await clickAndWait(submitBtn, 500);
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: 'StepF: SUBMIT clicked â€” waiting for banner' });

  // Flipkart shows a green banner "Report is requested successfully." on success.
  // Only the banner counts â€” poll for up to 15s (30 Ã— 500ms).
  let confirmed = false;
  for (let w = 0; w < 30; w++) {
    await sleep(500);
    const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase();
    if (bodyText.includes('requested successfully') || bodyText.includes('report is requested')) {
      confirmed = true; break;
    }
  }
  if (!confirmed) {
    // Check if an error banner appeared instead
    const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase();
    const duplicateBannerSeen = bodyText.includes('already been requested') || bodyText.includes('already requested');
    chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId, text:`no-banner bodyText snippet: ${bodyText.replace(/\s+/g,' ').trim().slice(0, 300)}` });

    // Neither toast is a reliable signal on its own — Chrome can throttle this
    // tab's timers so badly that a transient toast appears and disappears
    // between checks (see memory item 22, confirmed via log timestamps: a
    // nominal 15s poll took up to 9m47s in practice). Fall back to the durable
    // Reports Centre row list, which doesn't vanish after a few seconds the
    // way a toast does.
    await ensureOnReportsCentre(true);
    const rowScanResult = findReportRowDownloadBtn(cfg.requestSubType, date, jobId);
    const decision = decideReportSubmissionOutcome({ bannerConfirmed: false, duplicateBannerSeen, rowScanResult });

    if (decision.outcome === 'confirmed') {
      chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId, text:`âœ“ Report request confirmed via row-scan fallback: "${cfg.requestSubType}" for ${date} (row status: ${rowScanResult.status})` });
      return;
    }
    if (decision.outcome === 'duplicate_blocked') {
      throw new Error(`FK_REPORTS: duplicate request blocked â€” "${cfg.requestSubType}" already requested today`);
    }
    debugPage(`rc-submit-no-banner-${cfg.requestSubType}`, jobId);
    throw new Error(`FK_REPORTS: SUBMIT clicked but success banner never appeared â€” request status unknown`);
  }
  chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId, text:`âœ“ Report request confirmed: "${cfg.requestSubType}" for ${date}` });
  console.log(`[Rumee/FK] âœ“ Report request confirmed for "${cfg.requestSubType}" (${date})`);
}


/**
 * Scan Reports Centre rows for a report matching subType + date.
 * Returns { btn, status } where:
 *   status = 'ready'       â€” report Generated, Download button available
 *   status = 'in_progress' â€” report found with correct date but still generating
 *   status = 'not_found'   â€” no matching report on this page
 *   btn    = the Download button element (only set when status='ready')
 */
function findReportRowDownloadBtn(subType, expectedDate = null, jobId = 'fk_report') {
  const subLow = subType.toLowerCase();

  const MONTHS_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const buildFmts = (isoDate) => {
    const [y, m, d] = isoDate.split('-').map(Number);
    return [
      `${MONTHS_ABR[m-1]} ${d} ${y}`,       // "Jun 4 2026"
      `${MONTHS_ABR[m-1]} ${String(d).padStart(2,'0')} ${y}`, // "Jun 04 2026"
      `${MONTHS_ABR[m-1]} ${d}, ${y}`,       // "Jun 4, 2026"
      `${d} ${MONTHS_ABR[m-1]} ${y}`,        // "4 Jun 2026"  (some Flipkart formats)
      isoDate,                                // "2026-06-04"
    ];
  };
  const dateFmts = expectedDate ? buildFmts(expectedDate) : [];

  const rows = Array.from(document.querySelectorAll('table tr, [role="row"], .report-row'));
  let foundInProgress = false;

  for (const row of rows) {
    const rowText = row.textContent || '';
    const rowLow  = rowText.toLowerCase();

    // â”€â”€ 1. SubType match â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!rowLow.includes(subLow)) continue;

    // â”€â”€ 2. Date Range check â€” match the range END (= yesterday, the data date) â”€
    // We request a 2-day range [yesterday-1, yesterday], so the report we want has
    // its range END on yesterday: "Jun 10 2026 To Jun 11 2026". Match the date
    // immediately AFTER " To " (the end date). This uniquely identifies today's
    // report and excludes stale rows ("Jun 9 To Jun 10" ends Jun 10 â‰  Jun 11) and
    // the old buggy [yesterday,today] rows ("Jun 11 To Jun 12" ends Jun 12).
    if (dateFmts.length > 0) {
      const afterTo = rowText.includes(' To ') ? rowText.split(' To ')[1].trimStart() : rowText;
      const hasDate = dateFmts.some(fmt => afterTo.startsWith(fmt));
      if (!hasDate) {
        // Log what we're skipping so user can verify
        const snippet = rowText.replace(/\s+/g,' ').trim().slice(0, 100);
        chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId:'fk_report',
          text:`SKIP_ROW (end-date mismatch for ${expectedDate}): ${snippet}` });
        continue;
      }
    }

    // â”€â”€ 3. Status check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const isInProgress = rowLow.includes('in progress') || rowLow.includes('processing')
      || rowLow.includes('in_progress') || rowLow.includes('queued')
      || rowLow.includes('eta:');  // "ETA: 05 Jun 2026" = still generating
    const isGenerated = rowLow.includes('generated') || rowLow.includes('completed')
      || rowLow.includes('available');

    const snippet = rowText.replace(/\s+/g,' ').trim().slice(0, 120);

    if (isInProgress) {
      foundInProgress = true;
      chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId:'fk_report',
        text:`IN_PROGRESS (${expectedDate}): ${snippet}` });
      continue; // keep polling
    }

    // â”€â”€ 4. Download button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const dlBtn = Array.from(row.querySelectorAll('button, a, [role="button"]'))
      .find(el => {
        if (!el.offsetParent) return false;
        const t = el.textContent.trim().toLowerCase();
        const href = (el.href || '').toLowerCase();
        return t.includes('download') || href.includes('download') || looksLikeDownload(el.href);
      });

    if (dlBtn && isGenerated) {
      chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId:'fk_report',
        text:`READY (${expectedDate}): ${snippet}` });
      return { btn: dlBtn, status: 'ready' };
    }
  }

  const status = foundInProgress ? 'in_progress' : 'not_found';
  chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId:'fk_report',
    text:`SCAN_RESULT: ${status} for ${subType}/${expectedDate} (${rows.length} rows checked)` });
  return { btn: null, status };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ FK_ADS_* â€” Flipkart Ads Other Reports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Navigation: Ads â†’ Reports â†’ Other Reports tab
// The job.adsReportType string maps to one of 7 dropdown options.
// Date: "Yesterday" preset (one click â€” no calendar interaction for daily runs).

async function handleFkAds(job) {
  // Define _log FIRST â€” before any await â€” so every step is visible in the log.
  // Fire-and-forget variant to avoid hanging if SW response callback is delayed.
  const _log = t => {
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: t });
    return Promise.resolve();
  };

  try {
  await _log(`handleFkAds: entry â€” job=${job.id} url=${window.location.href.slice(0,80)}`);
  await sleep(5000);
  await dismissFkPopups();
  // Always wait for SPA to be ready â€” ensures DOM is stable before any nav/check.
  // Critical for fk_ads_search (5th in sequence) where the previous download
  // can leave the tab in a transient blank state.
  await _log('handleFkAds: calling waitForSpaBootstrap');
  await waitForSpaBootstrap();
  await _log('handleFkAds: waitForSpaBootstrap done');

  // â”€â”€ Campaign gate (Option 5) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // fk_ads_daily runs unconditionally and sets the cache after downloading its
  // CSV (row count > 0 â†’ ['active'], 0 â†’ []). The other 6 jobs read that cache.
  // ids=[]     â†’ 0 data rows in daily report â†’ skip job
  // ids=['active'] â†’ data found â†’ proceed
  // cache miss â†’ fk_ads_daily may have been skipped or errored â†’ proceed anyway
  const _rawStored = await chrome.storage.local.get(_FK_ADS_CACHE_KEY);
  const _storedCache = _rawStored[_FK_ADS_CACHE_KEY];
  await _log(`CACHE: stored.date=${_storedCache?.date||'none'}  ids=${_storedCache?.ids===undefined?'undef':_storedCache?.ids===null?'null':Array.isArray(_storedCache?.ids)?_storedCache.ids.length+'arr':'?'}  target=${_fkAdsCurrentTargetDate()}`);

  if (job.id !== 'fk_ads_daily') {
    const campaignCache = await _getCampaignCache();
    const cachedIds = campaignCache ? campaignCache.ids : null;
    await _log(`CACHE: ${campaignCache ? `hit ids=${JSON.stringify(cachedIds).slice(0,40)}` : 'miss â€” proceeding (fk_ads_daily skipped or errored)'}`);
    if (Array.isArray(cachedIds) && cachedIds.length === 0) {
      await _log(`fk_ads_daily: 0 data rows â€” skipping ${job.id}`);
      chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
      return;
    }
    // null (cache miss) or ['active'] â†’ proceed
    await _log(`CACHE: proceeding with ${job.id}`);
  } else {
    await _log('fk_ads_daily: skipping cache check â€” this job sets the cache after download');
  }

  await _log(`Step1: waiting for Other Reports page (report="${job.adsReportType}")`);

  // â”€â”€ Step 1: Verify we are on Other Reports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // background.js already navigated the FK tab to the full URL:
  //   https://seller.flipkart.com/index.html#dashboard/ads/reports/others?duration=DATE_DATE
  // This is a clean single-# navigation â€” React mounts fresh and may read ?duration=.
  // We just wait for the SPA to boot and verify the page is correct.
  const _step1Date = _fkAdsCurrentTargetDate(); // e.g. "2026-06-01" — normally yesterday, a retried date if gap-catchup is active

  await sleep(6000); // wait for React route change + initial data load
  await waitForSpaBootstrap();
  await dismissFkPopups();

  // Require BOTH "Ad Product" AND "Report Type" â€” "Download" alone passes on Report Centre
  const onOtherReports = () =>
    document.body.innerText.includes('Ad Product') &&
    document.body.innerText.includes('Report Type');

  if (!onOtherReports()) {
    await _log('Step1: Other Reports not confirmed â€” trying sidebar + hash nav fallback');
    try { await navigateViaFkSidebar('Ads', 'Reports'); } catch(e) { await _log(`Step1: sidebar failed: ${e.message}`); }
    await sleep(3000);
    await clickTabIfNeeded(['Other Reports', 'other reports']);
    // Fallback hash nav (uses double-# but still works for routing)
    if (!onOtherReports()) {
      const _fbHash = `#dashboard/ads/reports/others?duration=${_step1Date}_${_step1Date}`;
      window.location.hash = _fbHash;
      await sleep(3000);
    }
  }
  await _log(`Step1: on Other Reports âœ“  hash=${window.location.hash.slice(0,80)}`);
  await clickTabIfNeeded(['Other Reports', 'other reports']);

  // Helper: FK-Ads dropdown selection, scoped to the report form container only.
  // Avoids clicking nav buttons (â˜…, Notifications, etc.) that navigate away.
  // _pickDropdown: label-anchored approach.
  // Finds the label text ("Ad Product" / "Report Type") as a leaf DOM node,
  // then walks UP to find the adjacent dropdown trigger (a sibling element).
  // This is strictly anchored to the label position â€” can never hit nav/header buttons.
  const _pickDropdown = async (labelText, targetText, stepLabel) => {
    await _log(`${stepLabel}: looking for label "${labelText}" â†’ option "${targetText}"`);

    // Find the label as a visible leaf node (exact text match).
    const allVisible = () => Array.from(document.querySelectorAll('div,span,label,p,li,td,th'))
      .filter(el => el.offsetParent !== null);

    const labelEl = allVisible().find(el =>
      el.children.length === 0 && (el.textContent || '').trim() === labelText
    ) || allVisible().find(el =>
      el.children.length <= 1 && (el.textContent || '').trim() === labelText
    );

    if (!labelEl) {
      await _log(`${stepLabel}: label "${labelText}" not found â€” skipping`);
      return false;
    }

    // Walk up from label to find sibling trigger container.
    let triggerContainer = null;
    let parent = labelEl;
    for (let depth = 0; depth < 12 && parent && parent !== document.body; depth++) {
      parent = parent.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter(el => {
        if (!el.offsetParent) return false;
        if (el === labelEl) return false;
        if ((el.textContent || '').trim() === labelText) return false;
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.width > 0;
      });
      if (siblings.length >= 1 && parent.children.length <= 5) {
        triggerContainer = siblings[0];
        break;
      }
    }

    if (!triggerContainer) {
      await _log(`${stepLabel}: no trigger container found near label "${labelText}"`);
      return false;
    }

    // Drill into wrapper to find the actual clickable control.
    // FK React dropdowns render as: <div wrapper> â†’ <div role="combobox"> or <div tabindex="0">
    const clickTarget = triggerContainer.querySelector(
      '[role="combobox"], [role="listbox"], [tabindex="0"], input[readonly], ' +
      '[class*="control"], [class*="Control"], [class*="select"], [class*="Select"]'
    ) || triggerContainer.children[0] || triggerContainer;

    await _log(`${stepLabel}: container tag=${triggerContainer.tagName} â†’ clickTarget tag=${clickTarget.tagName} class="${(clickTarget.className||'').toString().slice(0,50)}"`);

    // Capture trigger position BEFORE clicking â€” used for proximity filtering.
    // We intentionally do NOT snapshot "beforeSet" here because FK pre-renders
    // dropdown options (PLA, PCA etc.) as li elements in the DOM even before the
    // dropdown is opened. The beforeSet approach filters them out as "not new".
    const triggerRect = clickTarget.getBoundingClientRect();
    await _log(`${stepLabel}: triggerRect left=${triggerRect.left.toFixed(0)} top=${triggerRect.top.toFixed(0)} right=${triggerRect.right.toFixed(0)} bottom=${triggerRect.bottom.toFixed(0)}`);

    // Snapshot ALL visible elements showing targetText BEFORE clicking (e.g. nav tabs).
    // After clicking, new elements with targetText = dropdown options.
    const preClickWithText = new Set(
      Array.from(document.querySelectorAll('*'))
        .filter(el => el.offsetParent !== null
          && (el.textContent || '').trim() === targetText
          && el.getBoundingClientRect().height > 0)
    );
    await _log(`${stepLabel}: pre-click elements with text "${targetText}": ${preClickWithText.size}`);

    clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    clickTarget.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
    await sleep(1200);

    // Strategy 1: find NEW elements showing targetText (appeared after click = dropdown options)
    let opts = Array.from(document.querySelectorAll('*'))
      .filter(el => {
        if (!el.offsetParent) return false;
        if (preClickWithText.has(el)) return false; // existed before â€” skip nav tabs etc.
        const r = el.getBoundingClientRect();
        return r.height > 0 && (el.textContent || '').trim() === targetText;
      });
    await _log(`${stepLabel}: new elements with text "${targetText}" after click: ${opts.length}`);

    if (opts.length === 0) {
      // Retry once â€” dropdown may still be animating in
      await sleep(600);
      opts = Array.from(document.querySelectorAll('*'))
        .filter(el => {
          if (!el.offsetParent) return false;
          if (preClickWithText.has(el)) return false;
          const r = el.getBoundingClientRect();
          return r.height > 0 && (el.textContent || '').trim() === targetText;
        });
      await _log(`${stepLabel}: retry â€” new elements with text "${targetText}": ${opts.length}  all visible with text: ${Array.from(document.querySelectorAll('*')).filter(el => el.offsetParent !== null && (el.textContent||'').trim() === targetText).map(e => `${e.tagName}.${(e.className||'').toString().split(' ')[0].slice(0,25)}@${e.getBoundingClientRect().left.toFixed(0)},${e.getBoundingClientRect().top.toFixed(0)}`).join(' | ')}`);
    }

    const opt = opts.find(el =>
      (el.textContent || '').trim() === targetText ||
      (el.textContent || '').includes(targetText)
    );

    if (opt) {
      opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      opt.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
      await sleep(800);
      await _log(`${stepLabel}: selected "${targetText}" âœ“`);
      return true;
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    await _log(`${stepLabel}: not found â€” opts=[${opts.slice(0,6).map(e=>(e.textContent||'').trim()).join(' | ')}]`);
    return false;
  };

  // â”€â”€ Step 2: Select "PLA" as Ad Product â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await _pickDropdown('Ad Product', 'PLA', 'Step2');
  await sleep(500); // let Report Type options update after Ad Product change

  // â”€â”€ Step 3: Select the target Report Type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await _pickDropdown('Report Type', job.adsReportType, 'Step3');
  await sleep(2500); // allow FK React to re-render for new report type (FK may re-fetch preview data); was 800ms

  // Verify report type is showing on screen
  const visibleRtText = Array.from(document.querySelectorAll('button, [role="combobox"], div[aria-haspopup]'))
    .filter(el => el.offsetParent !== null)
    .map(el => (el.textContent||'').trim()).join(' | ').slice(0,120);
  await _log(`Step3: visible dropdown values after selection: [${visibleRtText}]`);

  // â”€â”€ Step 4: Set date via date picker UI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // background.js navigated directly to Other Reports with ?duration=DATE_DATE in the hash.
  // If React read the date from the URL on initial mount, the picker already shows the
  // correct date and we can skip this step entirely.
  // If not (FK ignores ?duration= even on fresh mount), we interact with the date picker.
  await _log('Step4: checking date on page');
  const _yISO = _fkAdsCurrentTargetDate(); // e.g. "2026-06-01" — normally yesterday, a retried date if gap-catchup is active

  // Convert ISO date to FK display format variants: "01-Jun-2026", "1-Jun-2026", "01-Jun-26"
  const _MONTHS_3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [_yYear, _yMon, _yDay] = _yISO.split('-');
  const _yFkDateFull  = `${parseInt(_yDay)}-${_MONTHS_3[parseInt(_yMon)-1]}-${_yYear}`;      // "1-Jun-2026"
  const _yFkDateShort = `${parseInt(_yDay)}-${_MONTHS_3[parseInt(_yMon)-1]}-${_yYear.slice(2)}`; // "1-Jun-26"

  // Log current date display on page
  const _dateDisplay0 = Array.from(document.querySelectorAll('*'))
    .filter(el => el.offsetParent !== null && /\d{1,2}-[A-Za-z]{3}-\d{2,4}/.test((el.textContent||'')))
    .map(el => (el.textContent||'').replace(/\s+/g,' ').trim().slice(0,60))
    .slice(0, 3).join(' | ');
  await _log(`Step4: current date display: "${_dateDisplay0}"  target: "${_yFkDateFull}" or "${_yFkDateShort}"`);

  // Check if the correct date is already shown â€” URL-based initialization worked!
  const _dateAlreadyCorrect = _dateDisplay0.includes(_yFkDateFull)
    || _dateDisplay0.includes(_yFkDateShort)
    || _dateDisplay0.includes(_yISO);
  if (_dateAlreadyCorrect) {
    await _log('Step4: correct date already shown â€” skipping date picker âœ“');
  } else {
    await _log('Step4: date not set by URL â€” interacting with date picker');
  }

  if (!_dateAlreadyCorrect) {
    // â”€â”€ Find the date trigger â€” walk up from text leaf to nearest clickable ancestor â”€â”€
    // IMPORTANT: Must limit txt.length to exclude large container elements whose
    // textContent merely CONTAINS a date string deep in a subtree (e.g. sidebar nav
    // containers whose combined textContent is "ReportsPLAPCAOther ReportsOther Reports...07-Jun-26").
    const _findDateTrigger = () => {
      const dateRx = /\d{1,2}-[A-Za-z]{3}-\d{2,4}/;
      const presetRx = /yesterday|today|last \d+ days/i;
      const allVis = Array.from(document.querySelectorAll('*'))
        .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 0);
      // Pass 1a: TRUE leaf (no children) with short date/preset text â€” avoids label+chip containers
      // whose combined textContent starts with the field label ("Date07-Jun-26...").
      // Prefer leaves first because querySelectorAll returns ancestors before descendants.
      const textEl =
        allVis.find(el => {
          const txt = (el.textContent||'').trim();
          return el.children.length === 0 && txt.length >= 6 && txt.length < 80
            && (dateRx.test(txt) || presetRx.test(txt));
        })
        // Pass 1b: near-leaf (â‰¤2 children) with short text â€” catches flex date chips
        || allVis.find(el => {
          const txt = (el.textContent||'').trim();
          return el.children.length <= 2 && txt.length < 80
            && (dateRx.test(txt) || presetRx.test(txt));
        })
        // Pass 2: bounding-box heuristic â€” small-height element with date text
        || allVis.find(el => {
          const r = el.getBoundingClientRect();
          const txt = (el.textContent||'').trim();
          return r.width > 50 && r.width < 600 && r.height > 12 && r.height < 60
            && txt.length < 80
            && (dateRx.test(txt) || presetRx.test(txt));
        });
      if (!textEl) return null;
      // Walk UP 20 levels to find the nearest button or pointer-cursor ancestor (actual trigger).
      // FK wraps date chips in deep React component hierarchies.
      let el = textEl;
      for (let i = 0; i < 20 && el && el !== document.body; i++) {
        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'
            || window.getComputedStyle(el).cursor === 'pointer') {
          return el;
        }
        el = el.parentElement;
      }
      // No pointer-cursor found â€” return the leaf itself and rely on event bubbling
      return textEl;
    };

    const _dateTrigger = _findDateTrigger();
    await _log(`Step4: dateTrigger=${_dateTrigger ? `${_dateTrigger.tagName} cursor=${window.getComputedStyle(_dateTrigger).cursor} "${(_dateTrigger.textContent||'').trim().slice(0,40)}"` : 'NOT FOUND'}`);

    if (_dateTrigger) {
      _dateTrigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      _dateTrigger.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
      await sleep(1200);

      // Log all preset-like elements visible after click
      const _presets = Array.from(document.querySelectorAll('*'))
        .filter(el => el.offsetParent !== null && el.children.length <= 3)
        .map(el => (el.textContent||'').trim())
        .filter(t => /yesterday|today|last \d+|custom|apply|cancel/i.test(t) && t.length < 40)
        .slice(0, 10);
      await _log(`Step4: presets visible after trigger click: [${_presets.join(' | ')}]`);

      if (_YESTERDAY_OVERRIDE === null) {
        // â”€â”€ Production: click "Yesterday" preset â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const _findYestEl = () => Array.from(document.querySelectorAll('*'))
          .find(el => el.offsetParent !== null
            && (el.textContent || '').trim() === 'Yesterday'
            && el.getBoundingClientRect().height > 0);
        let _yestEl = _findYestEl();
        if (!_yestEl) { await sleep(600); _yestEl = _findYestEl(); }
        if (_yestEl) {
          _yestEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          _yestEl.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
          await sleep(800);
          await _log('Step4: Yesterday preset clicked âœ“');
        } else {
          await _log('Step4: Yesterday not found â€” picker still open, trying Custom path');
          // Fall through to Custom path below (picker is still open)
        }
      }
      // â”€â”€ Custom date path (used when: _YESTERDAY_OVERRIDE set, OR Yesterday preset absent) â”€â”€
      const _needCustomDate = _YESTERDAY_OVERRIDE !== null
        || (() => {
          // Yesterday was not clicked â€” check if date is still wrong
          const _nowDate = Array.from(document.querySelectorAll('*'))
            .filter(el => el.offsetParent !== null && /\d{1,2}-[A-Za-z]{3}-\d{2,4}/.test((el.textContent||'')))
            .map(el => (el.textContent||'').replace(/\s+/g,' ').trim().slice(0,60))
            .slice(0,2).join(' ');
          const _stillWrong = !_nowDate.includes(_yFkDateFull) && !_nowDate.includes(_yFkDateShort) && !_nowDate.includes(_yISO);
          return _stillWrong;
        })();
      if (_needCustomDate) {
        // â”€â”€ Override date OR fallback: click "Custom" then set inputs + calendar â”€â”€
        const _customEl = Array.from(document.querySelectorAll('*'))
          .find(el => el.offsetParent !== null
            && /^custom$/i.test((el.textContent||'').trim())
            && el.getBoundingClientRect().height > 0);
        await _log(`Step4: Custom option: ${_customEl ? `${_customEl.tagName} "${(_customEl.textContent||'').trim()}"` : 'NOT FOUND'}`);

        if (_customEl) {
          _customEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          _customEl.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
          await sleep(1500);

          // Log ALL visible inputs and calendar cells
          const _visInputs = Array.from(document.querySelectorAll('input,div[contenteditable],div[role="textbox"]'))
            .filter(el => el.offsetParent !== null)
            .map(el => `${el.tagName}[${el.type||el.getAttribute('role')||''}]="${(el.value||el.textContent||'').trim().slice(0,20)}" @${Math.round(el.getBoundingClientRect().top)},${Math.round(el.getBoundingClientRect().left)}`);
          await _log(`Step4: inputs after Custom: [${_visInputs.slice(0,5).join(' | ').slice(0,250)}]`);

          const _calCells = Array.from(document.querySelectorAll('td,div[role="gridcell"],[data-date],span[role="option"]'))
            .filter(el => el.offsetParent !== null)
            .slice(0, 20)
            .map(el => `${el.tagName}:"${(el.textContent||'').trim().slice(0,8)}"`);
          await _log(`Step4: calendar cells: [${_calCells.join('|').slice(0,250) || 'none'}]`);

          // â”€â”€ Strategy 1: set <input> values directly via React native setter â”€
          const _dateInputEls = Array.from(document.querySelectorAll('input'))
            .filter(el => el.offsetParent !== null);
          await _log(`Step4: visible <input> count: ${_dateInputEls.length}`);
          if (_dateInputEls.length >= 1) {
            const _nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            const _setReactInput = (inp, val) => {
              inp.focus();
              _nativeSetter.call(inp, val);
              inp.dispatchEvent(new Event('input',  { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            };
            _setReactInput(_dateInputEls[0], _yFkDateFull);
            await sleep(400);
            if (_dateInputEls.length >= 2) {
              _setReactInput(_dateInputEls[_dateInputEls.length - 1], _yFkDateFull);
              await sleep(400);
            }
            await _log(`Step4: set input(s) to "${_yFkDateFull}"`);
          }

          // â”€â”€ Strategy 2: click day-1 cells in calendar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          const _day1Cells = Array.from(document.querySelectorAll('td,div[role="gridcell"],span[role="option"],div[role="option"]'))
            .filter(el => el.offsetParent !== null
              && /^1$/.test((el.textContent||'').trim())
              && el.getBoundingClientRect().width > 0
              && el.getBoundingClientRect().width < 60);
          await _log(`Step4: day-1 calendar cells: ${_day1Cells.length}`);
          if (_day1Cells.length >= 1 && _day1Cells.length <= 4) {
            _day1Cells[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await sleep(400);
            // For range pickers: click end-date "1" as well (last found)
            if (_day1Cells.length >= 2) {
              _day1Cells[_day1Cells.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              await sleep(400);
            }
            await _log('Step4: clicked day-1 cell(s)');
          }

          // â”€â”€ Strategy 3: click Apply / OK button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          const _applyBtn = Array.from(document.querySelectorAll('button,[role="button"]'))
            .find(el => el.offsetParent !== null && /^(apply|ok|done|set|submit)$/i.test((el.textContent||'').trim()));
          if (_applyBtn) {
            _applyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await sleep(800);
            await _log('Step4: Apply clicked âœ“');
          } else {
            await _log('Step4: Apply button not found');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
        } else {
          await _log('Step4: Custom not found â€” download will use FK default date');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(300);
        }
      }
    } else {
      await _log('Step4: date trigger not found on page â€” download will use FK default date');
    }

    // Log final date display after interactions
    const _dateDisplayFinal = Array.from(document.querySelectorAll('*'))
      .filter(el => el.offsetParent !== null && /\d{1,2}-[A-Za-z]{3}-\d{2,4}/.test((el.textContent||'')))
      .map(el => (el.textContent||'').replace(/\s+/g,' ').trim().slice(0,60))
      .slice(0, 2).join(' | ');
    await _log(`Step4: final date display: "${_dateDisplayFinal}"`);
    await sleep(500);
  } // end if (!_dateAlreadyCorrect)

  // â”€â”€ Step 5: Overall Performance â€” loop through all campaigns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (job.id === 'fk_ads_overall') {
    await _log('Step5: delegating to _handleFkAdsOverall');
    await _handleFkAdsOverall(job);
    return;
  }

  // â”€â”€ Step 6: Regular report â€” single download via CS fetch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Scope the search to the ads form area only (not the full page) to avoid
  // accidentally clicking a settlement "Download" button from another FK page.
  await _log(`Step6: looking for Download button`);
  // Find the ads form container â€” contains "Ad Product" label
  const _adsFormRoot = (() => {
    const adProdLabel = Array.from(document.querySelectorAll('*'))
      .find(el => el.offsetParent !== null && (el.textContent||'').trim() === 'Ad Product' && el.children.length === 0);
    if (!adProdLabel) return document.body;
    // Walk up to find a reasonable form container (ancestor that's a section/div with enough width)
    let el = adProdLabel.parentElement;
    for (let i = 0; i < 12 && el && el !== document.body; i++) {
      const r = el.getBoundingClientRect();
      if (r.width > 400 && r.height > 200) return el;
      el = el.parentElement;
    }
    return document.body;
  })();
  await _log(`Step6: adsFormRoot=${_adsFormRoot === document.body ? 'body (fallback)' : _adsFormRoot.tagName + ' w=' + Math.round(_adsFormRoot.getBoundingClientRect().width)}`);

  const _findDlBtn = (text) => {
    const t = text.toLowerCase();
    return Array.from(_adsFormRoot.querySelectorAll('button, [role="button"], [role="tab"], a'))
      .find(el => el.offsetParent !== null && (el.textContent||'').trim().toLowerCase().includes(t)) || null;
  };
  const dlBtn = _findDlBtn('Download') || _findDlBtn('Get Report') || _findDlBtn('Generate Report');
  await _log(`Step6: Download button found = ${!!dlBtn}  text="${(dlBtn?.textContent||'').trim().slice(0,30)}"`);
  if (!dlBtn) {
    debugPage(`ads-no-download-${job.id}`);
    throw new Error(`Ads Download button not found for ${job.id} / ${job.adsReportType}`);
  }
  console.log(`[Rumee/FK] Downloading: ${job.adsReportType}`);
  const filename = makeDatedFilename(job, _fkAdsCurrentTargetDate(), _fkAdsCurrentTargetDate());

  // Layer 2: background.js chrome.downloads.onCreated intercepts the real browser-navigation
  // download (Sec-Fetch-Dest: document â†’ CSV). For fk_ads_daily, background also sets the
  // campaign cache from the CSV row count before calling processNextJob.
  await _log(`Step6: using Layer 2 (DOWNLOAD_BUTTON_CLICKED) for ${job.id}`);
  // Snapshot page text before download â€” helps diagnose "no data" / error states
  const _preDownloadBodySnip = (document.body.innerText || document.body.textContent || '')
    .replace(/\s+/g, ' ').trim().slice(200, 700); // skip nav chrome, grab form area
  await _log(`Step6: page text before download: "${_preDownloadBodySnip.slice(0, 300)}"`);
  await _downloadFkReport(job, dlBtn, filename, true, true);
  } catch(err) {
    _log(`handleFkAds ERROR: ${err.message || String(err)}`);
    chrome.runtime.sendMessage({ type: 'JOB_ERROR', jobId: job.id, error: err.message || String(err) });
  }
}

/**
 * Overall Performance Report â€” requires Campaign ID (mandatory field).
 * Active campaign IDs already fetched and cached in _fkAdsCampaignIds by the
 * time this runs (checked on fk_ads_daily, first in the ads sequence).
 * Downloads one file per active campaign; uses UPLOAD_DATA_SILENT for all
 * but the last so the queue stays alive.
 */
async function _handleFkAdsOverall(job) {
  const _log = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: t });

  const _cache = await _getCampaignCache();
  const activeCampaignIds = _cache && _cache.ids;

  if (!Array.isArray(activeCampaignIds) || activeCampaignIds.length === 0) {
    await _log(activeCampaignIds === null
      ? 'fk_ads_overall: no cache â€” skipping'
      : 'fk_ads_overall: 0 campaigns yesterday â€” skipping');
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  // Legacy cache format stored ['active'] instead of real IDs
  if (activeCampaignIds.length === 1 && activeCampaignIds[0] === 'active') {
    await _log('fk_ads_overall: legacy ["active"] cache â€” run fk_ads_daily first to update. Skipping.');
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  await _log(`fk_ads_overall: ${activeCampaignIds.length} campaign(s) â€” [${activeCampaignIds.join(' | ')}]`);

  // Poll for Campaign ID input (up to 8s)
  const _findCampInput = () =>
    Array.from(document.querySelectorAll('input'))
      .filter(el => el.offsetParent !== null)
      .find(el => /campaign/i.test(el.placeholder || ''));

  let input = null;
  for (let i = 0; i < 16 && !input; i++) { input = _findCampInput(); if (!input) await sleep(500); }
  if (!input) {
    await _log('fk_ads_overall: Campaign ID input not found after 8s â€” error');
    chrome.runtime.sendMessage({ type: 'JOB_ERROR', jobId: job.id, error: 'fk_ads_overall: Campaign ID input not found' });
    return;
  }
  await _log(`fk_ads_overall: input found â€” placeholder="${input.placeholder}"`);

  // Capture the pristine filename template BEFORE the loop. Each iteration below
  // assigns the per-campaign name onto _currentJob.filename (which is the same
  // object as `job`) so the blob relay picks it up — meaning a later iteration
  // reading job.filename would build its name on top of the previous campaign's
  // already-dated name and compound. Seen live 2026-08-03 with 2 live campaigns:
  // campaign 2 uploaded as flipkart_ads_overall_2026-08-02_0P5FADU79046_2026-08-02_863R3CQQCKQW.csv
  // and campaign 1's own file never landed.
  const _baseFilename = job.filename;

  for (let i = 0; i < activeCampaignIds.length; i++) {
    const campId = activeCampaignIds[i];
    const isLast = (i === activeCampaignIds.length - 1);
    const safeName = campId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    const filename = makeDatedFilename({ ...job, filename: _baseFilename },
                                       _fkAdsCurrentTargetDate(), _fkAdsCurrentTargetDate())
      .replace('.csv', activeCampaignIds.length > 1 ? `_${safeName}.csv` : '.csv');

    await _log(`Overall (${i + 1}/${activeCampaignIds.length}): "${campId}" â†’ "${filename}"`);

    // Step A: type campaign ID via execCommand (React-compatible â€” nativeSetter doesn't trigger search)
    const inp = _findCampInput();
    if (!inp) { await _log(`Overall: input gone at i=${i} â€” stopping`); break; }

    inp.click();
    inp.focus();
    await sleep(300);
    inp.select();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, campId);
    await _log(`Overall: typed "${campId}" | field="${inp.value}" | waiting for suggestion...`);
    await sleep(2500);

    // Step B: find suggestion â€” smallest visible element containing campId (not the input itself)
    const withId = Array.from(document.querySelectorAll('*')).filter(el => {
      if (['INPUT', 'TEXTAREA', 'SCRIPT', 'STYLE'].includes(el.tagName)) return false;
      if (el === inp || el.contains(inp)) return false;
      const txt = (el.textContent || '').trim();
      const rect = el.getBoundingClientRect();
      return txt.includes(campId) && txt.length < 300 && rect.height > 0 && rect.width > 0;
    });
    await _log(`Overall: ${withId.length} element(s) with campaign ID visible`);

    if (!withId.length) {
      await _log(`Overall: no suggestion for "${campId}" â€” skipping`);
      document.execCommand('selectAll');
      document.execCommand('insertText', false, '');
      await sleep(300);
      continue;
    }

    // Click the leaf (smallest h) suggestion row
    const suggestion = withId.reduce((a, b) =>
      a.getBoundingClientRect().height < b.getBoundingClientRect().height ? a : b);
    await _log(`Overall: clicking suggestion h=${suggestion.getBoundingClientRect().height.toFixed(0)} "${(suggestion.textContent || '').trim().slice(0, 80)}"`);
    suggestion.click();
    await sleep(1500);

    // Step C: confirm "Ad Group" label appeared (React re-renders it when campaign is selected)
    const adGroupOk = Array.from(document.querySelectorAll('*'))
      .filter(el => el.offsetParent !== null && el.children.length === 0)
      .some(el => /ad group/i.test(el.textContent || ''));
    await _log(`Overall: Ad Group field visible = ${adGroupOk}`);

    if (!adGroupOk) {
      await _log(`Overall: selection not confirmed for "${campId}" â€” skipping`);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);
      continue;
    }

    // Step D: find Download button
    const dlBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(el => el.offsetParent !== null)
      .find(el => /download/i.test(el.textContent || '') && !el.disabled);
    if (!dlBtn) {
      await _log(`Overall: Download button not found for "${campId}" â€” skipping`);
      continue;
    }

    await _log(`Overall: downloading "${campId}" â†’ "${filename}" (isLast=${isLast})`);

    if (isLast) {
      // Last: module-level blob relay handles UPLOAD_DATA and advances the queue
      if (_currentJob) _currentJob.filename = filename;
      await _downloadFkReport(job, dlBtn, filename, true, true);
    } else {
      // Non-last: capture blob locally, send UPLOAD_DATA_SILENT (don't advance queue yet)
      // Null _currentJob temporarily so module-level relay bails on its _currentJob check
      const _savedJob = _currentJob;
      _currentJob = null;
      if (_savedJob) _savedJob.filename = filename;

      window.__rumeeCapturingBlob = true;
      window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: true }, '*');

      const blobData = await new Promise(resolve => {
        const _t = setTimeout(() => { resolve(null); }, 30000);
        const _w = ev => {
          if (!ev.data?.__rumeeBlob) return;
          window.removeEventListener('message', _w);
          clearTimeout(_t);
          window.__rumeeCapturingBlob = false;
          window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: false }, '*');
          resolve(ev.data);
        };
        window.addEventListener('message', _w);
        dlBtn.click();
      });

      _currentJob = _savedJob;

      if (blobData?.base64) {
        await new Promise(res => chrome.runtime.sendMessage({
          type: 'UPLOAD_DATA_SILENT',
          jobId: job.id, data: blobData.base64, encoding: 'base64',
          filename, folderKey: job.folderKey, mimeType: job.mimeType,
        }, res));
        await _log(`Overall: uploaded "${filename}" (${blobData.size} bytes) silently`);
      } else {
        await _log(`Overall: blob timeout for "${campId}"`);
      }
      await sleep(2000);
    }
  }
}

/**
 * Click a tab identified by text, if it's not already active.
 * @param {string[]} texts
 */
async function clickTabIfNeeded(texts) {
  const tab = findEl(texts, '[role="tab"], li, button, a');
  if (tab) {
    // Check if already active (aria-selected=true or active class)
    const isActive = tab.getAttribute('aria-selected') === 'true'
      || tab.classList.contains('active')
      || tab.classList.contains('selected');
    if (!isActive) {
      await clickAndWait(tab, 2000);
      console.log(`[Rumee/FK] Clicked tab: "${tab.textContent.trim()}"`);
    }
  } else {
    console.warn(`[Rumee/FK] Tab not found: [${texts.join(', ')}]`);
  }
}

/**
 * Find and use a dropdown (native <select> or custom) to select an option.
 * @param {string[]} optionTexts  - Text of the option to select.
 * @param {string[]} labelTexts   - Text near the dropdown that labels it.
 */
async function selectDropdownOption(optionTexts, labelTexts) {
  // Try native <select> first â€” find select whose label contains one of labelTexts
  const selects = Array.from(document.querySelectorAll('select'));
  for (const sel of selects) {
    const label = (
      document.querySelector(`label[for="${sel.id}"]`)?.textContent ||
      sel.previousElementSibling?.textContent ||
      sel.closest('div')?.querySelector('label, span')?.textContent ||
      ''
    ).toLowerCase();
    if (labelTexts.some(l => label.includes(l.toLowerCase()))) {
      const opt = Array.from(sel.options).find(o =>
        optionTexts.some(t => o.text.toLowerCase().includes(t.toLowerCase()))
      );
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(800);
        console.log(`[Rumee/FK] <select> set to: "${opt.text}"`);
        return;
      }
    }
  }

  // Custom dropdown: find the trigger button/combobox near the label
  let trigger = null;
  for (const labelText of labelTexts) {
    const labelEl = findEl([labelText], 'label, span, div, p');
    if (labelEl) {
      // Search siblings and parent for a button/combobox
      const parent = labelEl.closest('div, section, form') || labelEl.parentElement;
      trigger = parent?.querySelector('button, [role="combobox"], [role="listbox"]') || null;
      if (trigger) break;
    }
  }
  if (!trigger) {
    trigger = findEl(labelTexts, 'button, [role="combobox"]');
  }

  if (trigger) {
    await clickAndWait(trigger, 800);
    const opt = findEl(optionTexts, '[role="option"], li, [role="menuitem"]');
    if (opt) {
      await clickAndWait(opt, 800);
      console.log(`[Rumee/FK] Custom dropdown selected: "${opt.textContent.trim()}"`);
    } else {
      console.warn(`[Rumee/FK] Option not found after opening dropdown: [${optionTexts.join(', ')}]`);
    }
  } else {
    console.warn(`[Rumee/FK] Dropdown trigger not found for: [${labelTexts.join(', ')}]`);
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ FK_VIEWS â€” two-phase flow (request early / download late) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// The Traffic Report listings report is keyed to the selected date range
// (verified live by fk_views_probe on 2026-06-11):
//   no report for range â†’ "Request Listings Report" button
//   request accepted    â†’ faded "Generating Report â€¦"
//   ready (same range)  â†’ "Download Listings Report" button
//
// fk_views_request (early, right after FK RC requests): selects the range via
//   Custom Dates, clicks Request, stores the range, moves on. Generation took
//   ~7 min in live testing.
// fk_views (last, after fk_rc_download): re-selects the IDENTICAL stored range;
//   downloads if ready; if still generating schedules a 1-hour recheck (max 3),
//   then notifies the user and gives up. Mirrors the FK RC recheck pattern.

const FK_VIEWS_MAX_RECHECKS = 3;

// Click one day cell in the dual-month Custom Dates calendar.
// Disambiguation (fixed 2026-06-11): both month panels share ancestors whose
// textContent contains BOTH month headers, so ancestor-text matching picked the
// wrong month ("10 May" instead of "10 Jun"). Instead, locate the target month's
// header element ("Jun 2026") and pick the candidate day cell horizontally
// closest to that header â€” day cells sit directly under their month's header.
async function fkViewsClickDay(jobId, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const mName = MONTHS[m - 1];
  const mAbr  = mName.slice(0, 3);                       // calendar headers show "Jun 2026"
  let cell = document.querySelector(
    `[aria-label="${mName} ${d}, ${y}"], [aria-label="${d} ${mName} ${y}"], [data-date="${isoDate}"]`
  );
  if (!(cell && cell.offsetParent)) {
    const dayCells = Array.from(document.querySelectorAll(
      'td, [role="gridcell"], [role="cell"], [class*="day"], [class*="date"]'
    )).filter(el => el.offsetParent && el.textContent.trim() === String(d));

    // Month disambiguation â€” same structural pattern as the proven FK Reports
    // Centre calendar (requestNewFkReport StepE): find the element whose entire
    // text is exactly the target month ("Jun 2026"/"June 2026"), walk UP from
    // it, and at each level query DOWN for the day cell â€” the first container
    // holding it is that month's own panel.
    // Extra guard for this page: the toolbar also shows a "Jun 2026 â–¼" dropdown,
    // so any container holding MORE THAN ONE month label is rejected (it means
    // we escaped the month panel / started from the toolbar button).
    const monthRx = /^[A-Z][a-z]{2,8}\s+\d{4}$/;
    const headerCandidates = Array.from(document.querySelectorAll('*')).filter(el => {
      const t = (el.innerText || '').trim();
      return (t === `${mName} ${y}` || t === `${mAbr} ${y}`) && el.offsetParent;
    });
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId,
      text: `Views2: day cells for "${d}": ${dayCells.length}, "${mAbr} ${y}" header candidates: ${headerCandidates.length}` });

    for (const header of headerCandidates) {
      let container = header.parentElement;
      for (let i = 0; i < 8 && container && !cell; i++) {
        const cellsInside = Array.from(container.querySelectorAll(
          'td, [role="gridcell"], [role="cell"]'
        )).filter(el => el.offsetParent && (el.innerText || el.textContent || '').trim() === String(d));
        if (cellsInside.length) {
          const monthsInside = Array.from(container.querySelectorAll('*'))
            .filter(el => el.children.length === 0 && monthRx.test((el.innerText || '').trim()))
            .map(el => el.innerText.trim())
            .filter((t, idx, arr) => arr.indexOf(t) === idx);
          if (monthsInside.length <= 1) {
            cell = cellsInside[0];
            chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId,
              text: `Views2: day "${d}" matched inside single-month panel "${monthsInside[0] || '(no label)'}"` });
          } else {
            chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId,
              text: `Views2: container has ${monthsInside.length} month labels [${monthsInside.join(' | ')}] â€” rejecting this header` });
          }
          break; // first container with day cells decides for this header
        }
        container = container.parentElement;
      }
      if (cell) break;
    }

    if (!cell) {
      // Positional fallback: current month sits on the right panel.
      const now = new Date();
      const isCurrentMonth = (now.getFullYear() === y && now.getMonth() === m - 1);
      cell = isCurrentMonth ? dayCells[dayCells.length - 1] : dayCells[0];
      chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId,
        text: `Views2: header walk failed â€” positional fallback (${isCurrentMonth ? 'rightmost' : 'leftmost'})` });
    }
  }
  if (!cell) return false;
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId,
    text: `Views2: clicked day ${isoDate} ("${cell.textContent.trim()}")` });
  cell.click();
  await sleep(600);
  return true;
}

// Navigate to Traffic Report, select [fromISO..toISO] via Custom Dates, and
// return the page state for that range: { requestBtn, generating, downloadBtn }.
async function fkViewsSelectRange(job, fromISO, toISO) {
  const vlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `Views2: ${txt}` });

  await sleep(4000);
  await dismissFkPopups();
  await waitForSpaBootstrap();
  const cleanHash = 'dashboard/growth/seller-insights?businessVertical=ALL&section=purchase_funnel&selectedPeriod=latest&activeMetric=impression&activeProductType=ALL';
  window.location.hash = cleanHash;
  await sleep(6000);
  if (!window.location.hash.includes('seller-insights')) {
    vlog('hash nav failed â€” trying sidebar');
    try { await navigateViaFkSidebar('Growth', 'Seller Insights'); } catch (_) {}
    await sleep(4000);
  }
  await clickTabIfNeeded(['Traffic Report', 'traffic report']);
  await sleep(2000);

  const customBtn = findBtn('Custom Dates') || findBtn('Custom Date')
    || findEl(['Custom Dates', 'Custom Date'], 'button, li, [role="button"], div');
  if (!customBtn) {
    const bodyText = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `views2-no-custom bodyText snippet: ${bodyText}` });
    debugPage('views2-no-custom', job.id);
    throw new Error('FK_VIEWS: Custom Dates button not found');
  }
  await clickAndWait(customBtn, 1500);

  // ALWAYS two clicks â€” start then end. Verified live (probe, 2026-06-11): a
  // single click only sets the range END (start stays whatever the page had,
  // e.g. weekly mode produced 04â†’10 Jun). For a single-day range, the same
  // date must be clicked twice (start = end).
  if (!(await fkViewsClickDay(job.id, fromISO))) {
    debugPage('views2-no-from-day', job.id);
    throw new Error(`FK_VIEWS: calendar day ${fromISO} not found`);
  }
  if (!(await fkViewsClickDay(job.id, toISO))) {
    debugPage('views2-no-to-day', job.id);
    throw new Error(`FK_VIEWS: calendar day ${toISO} not found`);
  }
  const doneBtn = findBtn('Done') || findBtn('Apply');
  if (doneBtn) await clickAndWait(doneBtn, 3000);
  await sleep(3000);

  const requestBtn   = findBtn('Request Listings Report') || findBtn('Request Listing Report');
  const generatingEl = findEl(['Generating Report', 'Generating'], 'button, [role="button"], div, span');
  const generating   = !!(generatingEl && generatingEl.offsetParent);
  const downloadBtn  = findBtn('Download Listings Report') || findBtn('Download Listing Report')
    || findBtn('Download Report');
  vlog(`range ${fromISO}â†’${toISO} STATE: request=${!!requestBtn} generating=${generating} download=${!!downloadBtn}`);
  return { requestBtn, generating, downloadBtn };
}

// â”€â”€ Phase 1: fk_views_request â€” submit the request and move on â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleFkViewsRequest(job) {
  const vlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `Views2: ${txt}` });

  // Range: day after the last successfully DOWNLOADED to-date â†’ yesterday.
  // (fk_views_last_to avoids the lastRun off-by-one: lastRun stamps the run day,
  // but the data only covers through the previous day.)
  const yesterday = yesterdayISO();
  const { fk_views_last_to, lastRun = {} } = await getStorage(['fk_views_last_to', 'lastRun']);
  let from;
  if (fk_views_last_to)        from = addDays(fk_views_last_to, 1);
  else if (lastRun['fk_views']) from = lastRun['fk_views'];   // legacy fallback: include run day
  else                          from = daysAgoISO(7);
  if (from > yesterday) from = yesterday;
  // Clamp so the date stays within the two visible calendar months.
  if (from < daysAgoISO(25)) { vlog(`from ${from} clamped to 25 days back`); from = daysAgoISO(25); }

  // Persist so the download phase re-selects the IDENTICAL range.
  await new Promise(res => chrome.storage.local.set({ fk_views_range: { from, to: yesterday } }, res));
  vlog(`requesting range ${from} â†’ ${yesterday}`);

  const state = await fkViewsSelectRange(job, from, yesterday);

  if (state.downloadBtn) {
    vlog('report already generated for this range â€” fk_views (download) will fetch it');
  } else if (state.generating) {
    vlog('already generating â€” nothing to do');
  } else if (state.requestBtn) {
    await clickAndWait(state.requestBtn, 4000);
    const gen = findEl(['Generating'], 'button, [role="button"], div, span');
    vlog(`request submitted â€” generating=${!!(gen && gen.offsetParent)}`);
  } else {
    debugPage('views2-request-unknown-state', job.id);
    throw new Error('FK_VIEWS request: no Request/Generating/Download state found');
  }
  chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
}

// â”€â”€ FK Views content verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Root cause (found 2026-07-10, real incident: flipkart_views_2026-07-03.xlsx):
// a multi-day range request (e.g. 07-02â†’07-03) can come back from FK with only
// PART of the range actually populated â€” no error, no warning, just fewer days
// of data than asked for. The old code trusted the requested "to" date blindly
// and advanced the watermark past it, permanently losing the missing day with
// no way to notice. Fix: after downloading, read the ACTUAL latest date present
// inside the file and only advance the watermark that far â€” never past what was
// actually captured. If verification itself fails for any reason, fall back to
// the old trusting behavior (fail safe â€” a verification bug must never be worse
// than not verifying at all).

// Finds the End of Central Directory record (same technique already used in
// background.js's extractZipIfNeeded, just reused here for a different job).
function _zipFindEOCD(bytes) {
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) return i;
  }
  return -1;
}

// Reads a NAMED entry out of a general (multi-entry) ZIP archive, unlike
// background.js's extractZipIfNeeded which only handles a single-entry ZIP.
// Returns the decompressed bytes, or null on any failure â€” never throws, so
// callers can safely treat null as "couldn't verify" and fall back.
async function _extractNamedZipEntry(buffer, entryName) {
  try {
    const bytes = new Uint8Array(buffer);
    const view  = new DataView(buffer);
    const eocdOff = _zipFindEOCD(bytes);
    if (eocdOff < 0) return null;

    const entryCount = view.getUint16(eocdOff + 10, true);
    let cdOff = view.getUint32(eocdOff + 16, true);

    for (let i = 0; i < entryCount; i++) {
      if (bytes[cdOff] !== 0x50 || bytes[cdOff+1] !== 0x4B || bytes[cdOff+2] !== 0x01 || bytes[cdOff+3] !== 0x02) break;
      const compMethod = view.getUint16(cdOff + 10, true);
      const compSize   = view.getUint32(cdOff + 20, true);
      const fnLen      = view.getUint16(cdOff + 28, true);
      const extraLen   = view.getUint16(cdOff + 30, true);
      const commentLen = view.getUint16(cdOff + 32, true);
      const localOff   = view.getUint32(cdOff + 42, true);
      const name       = new TextDecoder().decode(bytes.slice(cdOff + 46, cdOff + 46 + fnLen));

      if (name === entryName) {
        const lfnLen  = view.getUint16(localOff + 26, true);
        const lefLen  = view.getUint16(localOff + 28, true);
        const dataOff = localOff + 30 + lfnLen + lefLen;
        const compressed = bytes.slice(dataOff, dataOff + compSize);

        if (compMethod === 0) return compressed;
        if (compMethod === 8) {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          const reader = ds.readable.getReader();
          writer.write(compressed);
          writer.close();
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const total = chunks.reduce((s, c) => s + c.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { out.set(c, off); off += c.length; }
          return out;
        }
        return null; // unsupported compression method
      }
      cdOff += 46 + fnLen + extraLen + commentLen;
    }
    return null; // entry not found
  } catch (e) {
    return null; // fail safe
  }
}

// Returns the latest "Impression Date" actually present in a downloaded FK
// Views XLSX buffer, or null if it couldn't be determined (parsing failed,
// or no dates found â€” either way, callers fall back to trusting the request).
async function _fkViewsActualMaxDate(buffer) {
  const sheetBytes = await _extractNamedZipEntry(buffer, 'xl/worksheets/sheet1.xml');
  if (!sheetBytes) return null;
  const xml = new TextDecoder('utf-8').decode(sheetBytes);
  const dates = xml.match(/\d{4}-\d{2}-\d{2}/g);
  if (!dates || !dates.length) return null;
  return dates.reduce((max, d) => (d > max ? d : max));
}

// â”€â”€ Phase 2: fk_views â€” download when ready, else hourly recheck (max 3) â”€â”€â”€â”€â”€â”€
async function handleFkViewsDownload(job) {
  const vlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `Views2: ${txt}` });

  const yesterday = yesterdayISO();
  const { fk_views_range } = await getStorage(['fk_views_range']);
  const from = (fk_views_range && fk_views_range.from) || yesterday;
  const to   = (fk_views_range && fk_views_range.to)   || yesterday;
  vlog(`checking range ${from} â†’ ${to}`);

  const state = await fkViewsSelectRange(job, from, to);

  if (state.downloadBtn) {
    vlog('READY â€” downloading');
    // RELAY_ARM: background.js's chrome.downloads.onCreated fires with the
    // real URL regardless of trigger mechanism (fetch, XHR, or window.open --
    // this button opens a new tab, which intercept.js's fetch/XHR monkey-patch
    // can never see). Background cancels synchronously (no Save-As dialog) and
    // relays the URL back via storage; we still do our own fetch below since
    // background's own fetch fails CORS for some FK endpoints.
    await new Promise(res => chrome.runtime.sendMessage({ type: 'RELAY_ARM', jobId: job.id }, res));
    await clickAndWait(state.downloadBtn, 300);
    const relayed = await pollStorageForRelay(TIMEOUT_MS);
    if (!relayed) {
      const bodyText = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `views2-no-relay bodyText snippet: ${bodyText}` });
      chrome.runtime.sendMessage({ type: 'RELAY_DISARM' });
      throw new Error('FK_VIEWS: no relayed download URL within timeout');
    }
    const captured = { url: relayed.url, headers: {} };
    _currentJob = job;

    const datedFilename = makeDatedFilename(job, to, to);
    const resp = await fetch(captured.url, { credentials: 'include', headers: captured.headers || {} });
    if (!resp.ok) throw new Error(`FK_VIEWS: fetch failed ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = ''; const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    vlog(`downloaded ${bytes.length} bytes â€” uploading as ${datedFilename}`);

    // Verify the file actually contains data up to "to" before trusting it â€”
    // FK can silently return a partial range (confirmed real incident:
    // 2026-07-03's file only contained 07-02's data). Only advance the
    // watermark as far as what was ACTUALLY captured, so a short-changed
    // range gets its missing tail retried on a future run instead of being
    // silently marked done.
    const actualMaxDate = await _fkViewsActualMaxDate(buffer);
    let watermarkTo = to;
    if (actualMaxDate && actualMaxDate < to) {
      vlog(`WARNING: requested up to ${to} but file only contains data through ${actualMaxDate} â€” watermark advancing to ${actualMaxDate} only, ${to} will be retried on a future run`);
      watermarkTo = actualMaxDate;
    } else if (!actualMaxDate) {
      vlog(`could not verify actual date coverage (parse failed) â€” trusting requested date ${to}`);
    }

    // Remember coverage + clear recheck counter for the next cycle.
    await new Promise(res => chrome.storage.local.set({ fk_views_last_to: watermarkTo }, res));
    await new Promise(res => chrome.storage.local.remove(['fk_views_recheck_count'], res));
    chrome.runtime.sendMessage({
      type: 'UPLOAD_DATA', jobId: job.id, data: btoa(binary), encoding: 'base64',
      filename: datedFilename, folderKey: job.folderKey, mimeType: job.mimeType,
    });
    return;
  }

  // Not ready. If the request was somehow lost (page shows Request again),
  // re-submit it before scheduling the recheck.
  if (!state.generating && state.requestBtn) {
    vlog('request appears lost â€” re-requesting before recheck');
    await clickAndWait(state.requestBtn, 4000);
  }

  const { fk_views_recheck_count = 0 } = await getStorage(['fk_views_recheck_count']);
  if (fk_views_recheck_count >= FK_VIEWS_MAX_RECHECKS) {
    chrome.runtime.sendMessage({ type: 'NOTIFY_USER',
      title: 'Rumee â€” FK Views Report Not Ready',
      message: `Views listings report (${from} â†’ ${to}) still not generated after ${FK_VIEWS_MAX_RECHECKS} hourly rechecks. Not downloaded â€” please check the Traffic Report page manually.` });
    vlog(`NOT READY after ${FK_VIEWS_MAX_RECHECKS} rechecks â€” giving up`);
    await new Promise(res => chrome.storage.local.remove(['fk_views_recheck_count'], res));
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  const nextCount = fk_views_recheck_count + 1;
  await new Promise(res => chrome.storage.local.set({ fk_views_recheck_count: nextCount }, res));
  chrome.runtime.sendMessage({ type: 'SCHEDULE_FK_VIEWS_RECHECK', delayMinutes: 60 });
  vlog(`still generating â€” scheduled recheck ${nextCount}/${FK_VIEWS_MAX_RECHECKS} in 60 min`);
  chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
}


// ── FK_RETURNS — Phase 1: Submit request only (phase 2 = fk_returns_download) ─
//
// Navigates to All Returns → sets Date of Closure = yesterday →
// clicks Request Download → stores requestedAt in chrome.storage → returns immediately.
// Phase 2 (handleFkReturnsDownload) runs near end of sync to download the ready report.

async function handleFkReturnsRequest(job) {
  const rlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `FkReturns: ${txt}` });
  const yesterday = yesterdayISO();

  // 1. Navigate to All Returns
  await dismissFkPopups();
  window.postMessage({ __rumeeNavigateHash: '#dashboard/returnsV2' }, '*');
  await sleep(4000);

  let allTab = null;
  const tabDeadline = Date.now() + 8000;
  while (!allTab && Date.now() < tabDeadline) {
    allTab = Array.from(document.querySelectorAll('button, [role="tab"], a, span, div'))
      .filter(el => el.offsetParent)
      .find(el => el.textContent.trim() === 'All Returns') || null;
    if (!allTab) await sleep(1000);
  }
  // Fallback: re-post the hash nav and give it a second, longer window — both
  // recorded real-world failures of this check coincided with FK being broadly
  // slow that run (other unrelated jobs failed the same run too), so a single
  // retry after re-navigating is worth it before giving up.
  if (!allTab) {
    await rlog('"All Returns" tab not found after 8s — retrying nav once');
    window.postMessage({ __rumeeNavigateHash: '#dashboard/returnsV2' }, '*');
    await sleep(5000);
    const retryDeadline = Date.now() + 12000;
    while (!allTab && Date.now() < retryDeadline) {
      allTab = Array.from(document.querySelectorAll('button, [role="tab"], a, span, div'))
        .filter(el => el.offsetParent)
        .find(el => el.textContent.trim() === 'All Returns') || null;
      if (!allTab) await sleep(1000);
    }
  }
  if (!allTab) throw new Error('FkReturns: "All Returns" tab not found');
  allTab.click();
  await sleep(3500);

  // 2. Open Date of Closure calendar
  let dateFilterEl = null;
  const filterDeadline = Date.now() + 10000;
  while (!dateFilterEl && Date.now() < filterDeadline) {
    dateFilterEl = Array.from(document.querySelectorAll('button, div, span, [role="button"]'))
      .filter(el => el.offsetParent)
      .find(el => el.textContent.trim() === 'Date of Closure') || null;
    if (!dateFilterEl) await sleep(1000);
  }
  if (!dateFilterEl) {
    await rlog('"Date of Closure" filter not found after 10s — retrying tab click once');
    allTab.click();
    await sleep(5000);
    const retryDeadline = Date.now() + 12000;
    while (!dateFilterEl && Date.now() < retryDeadline) {
      dateFilterEl = Array.from(document.querySelectorAll('button, div, span, [role="button"]'))
        .filter(el => el.offsetParent)
        .find(el => el.textContent.trim() === 'Date of Closure') || null;
      if (!dateFilterEl) await sleep(1000);
    }
  }
  if (!dateFilterEl) throw new Error('FkReturns: "Date of Closure" filter not found');
  dateFilterEl.click();
  await sleep(1500);

  // 3. Navigate calendar to yesterday, pick day, click Apply
  const _RET_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function _retGetPanels() {
    return Array.from(document.querySelectorAll('[class*="CalendarMonth"]'))
      .filter(el => el.querySelectorAll('td').length >= 28);
  }

  function _retPanelMonth(panel) {
    const hdr = Array.from(panel.querySelectorAll('*'))
      .find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && /^[A-Z][a-z]{2} \d{4}$/.test(el.textContent.trim()); });
    if (!hdr) return null;
    const [mName, yStr2] = hdr.textContent.trim().split(' ');
    return { year: parseInt(yStr2, 10), month: _RET_MONTHS.indexOf(mName) + 1 };
  }

  async function _retGoToMonth(tYear, tMonth) {
    for (let step = 0; step < 14; step++) {
      const panels = _retGetPanels();
      if (!panels.length) throw new Error('FkReturns: No calendar panels found');
      for (const p of panels) {
        const m = _retPanelMonth(p);
        if (m && m.year === tYear && m.month === tMonth) return p;
      }
      const firstM = _retPanelMonth(panels[0]);
      if (!firstM) throw new Error('FkReturns: Cannot read calendar month header');
      const goNext = (tYear * 12 + tMonth) > (firstM.year * 12 + firstM.month);
      const navBtn = Array.from(document.querySelectorAll('button'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.width < 60; })
        .find(el => {
          const cls = (el.className || '') + (el.getAttribute('aria-label') || '');
          return goNext
            ? (cls.toLowerCase().includes('next') || cls.toLowerCase().includes('right') || cls.toLowerCase().includes('forward'))
            : (cls.toLowerCase().includes('prev') || cls.toLowerCase().includes('left')  || cls.toLowerCase().includes('back'));
        });
      if (!navBtn) throw new Error(`FkReturns: Calendar ${goNext ? 'next' : 'prev'} button not found`);
      navBtn.click();
      await sleep(700);
    }
    throw new Error(`FkReturns: Could not navigate calendar to ${tYear}-${tMonth}`);
  }

  const [yStr, mStr, dStr] = yesterday.split('-');
  const tYear  = parseInt(yStr, 10);
  const tMonth = parseInt(mStr, 10);
  const dayNum = parseInt(dStr, 10);

  rlog(`Navigating calendar to ${tYear}-${tMonth}...`);
  const calPanel = await _retGoToMonth(tYear, tMonth);
  const dayCells = Array.from(calPanel.querySelectorAll('td'))
    .filter(el => el.textContent.trim() === String(dayNum));
  if (!dayCells.length) throw new Error(`FkReturns: Day ${dayNum} not found in calendar`);
  if (isFkCalendarDayDisabled(dayCells[0])) {
    throw new Error(`FkReturns: report period for ${yesterday} not yet available on Flipkart (calendar day disabled) â€” will retry automatically`);
  }
  dayCells[0].click();
  await sleep(800);

  const applyBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(el => el.offsetParent)
    .find(el => el.textContent.trim() === 'Apply');
  if (!applyBtn) throw new Error('FkReturns: "Apply" button not found after date selection');
  applyBtn.click();
  await sleep(2000);

  // 4. Click Request Download — store timestamp, return immediately (no wait)
  rlog(`Requesting download for ${yesterday}...`);
  const reqDlBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
    .find(el => el.offsetParent && el.textContent.includes('Request Download'));
  if (!reqDlBtn) throw new Error('FkReturns: "Request Download" button not found');

  const STORAGE_KEY = `fk_returns_reqtime_${yesterday}`;
  const submitResult = await new Promise(resolve => {
    const handler = e => {
      if (!e.data?.__rumeeSubmitReport) return;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      resolve(e.data);
    };
    const timer = setTimeout(() => { window.removeEventListener('message', handler); resolve(null); }, 10000);
    window.addEventListener('message', handler);
    reqDlBtn.click();
  });

  const httpStatus = submitResult ? submitResult.status : 0;

  if (httpStatus >= 200 && httpStatus < 300) {
    await new Promise(res => chrome.storage.local.set({ [STORAGE_KEY]: Date.now() }, res));
    rlog(`Request accepted (HTTP ${httpStatus}) -- fk_returns_download will pick up later`);
  } else if (httpStatus >= 400) {
    await sleep(1500);
    const bannerEl = Array.from(document.querySelectorAll('*'))
      .filter(el => el.offsetParent && el.children.length < 5)
      .find(el => el.textContent.includes('already been requested'));
    const bannerText = bannerEl ? bannerEl.textContent.trim() : '';
    rlog(`Red banner: "${bannerText.slice(0, 120)}"`);
    const isoMatch = bannerText.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (!isoMatch) throw new Error(`FkReturns: duplicate but could not parse timestamp from banner -- "${bannerText.slice(0, 100)}"`);
    const bannerTime = new Date(isoMatch[1]).getTime();
    await new Promise(res => chrome.storage.local.set({ [STORAGE_KEY]: bannerTime }, res));
    rlog(`Parsed requestedAt from banner: ${new Date(bannerTime).toLocaleTimeString()}`);
  } else {
    await new Promise(res => chrome.storage.local.set({ [STORAGE_KEY]: Date.now() }, res));
    rlog(`No submitReport event (status=${httpStatus}) -- stored timestamp, fk_returns_download will pick up`);
  }

  chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
}


// ── FK_RETURNS_DOWNLOAD — Phase 2: Poll Previous Downloads and upload ──────────
//
// Runs near end of sync (after fk_views, before fk_keywords).
// By this point phase 1 submitted the request ~30-60 min ago — report should be Ready.
// Reads requestedAt from chrome.storage, navigates to All Returns page (full reload),
// opens Previous Downloads panel, finds matching row, fetches and uploads.

async function handleFkReturnsDownload(job) {
  const rlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `FkReturnsDownload: ${txt}` });
  const yesterday = yesterdayISO();
  const STORAGE_KEY = `fk_returns_reqtime_${yesterday}`;

  const stored = await new Promise(res => chrome.storage.local.get(STORAGE_KEY, res));
  const requestedAt = stored[STORAGE_KEY];
  if (!requestedAt) throw new Error(`FkReturnsDownload: no stored requestedAt for ${yesterday} -- did fk_returns phase 1 run?`);
  rlog(`requestedAt=${new Date(requestedAt).toLocaleTimeString()}, navigating to All Returns...`);

  // Navigate away and back to force full page state refresh
  window.postMessage({ __rumeeNavigateHash: '#dashboard' }, '*');
  await sleep(2000);
  window.postMessage({ __rumeeNavigateHash: '#dashboard/returnsV2?tab=all_returns&state=all' }, '*');
  await sleep(4000);

  const _retPanelBtn = () => Array.from(document.querySelectorAll('button, [role="button"]'))
    .find(el => el.textContent.includes('Previous Downloads'));
  if (!document.documentElement.innerHTML.includes('Requested On')) {
    const btn = _retPanelBtn();
    if (!btn) throw new Error('FkReturnsDownload: "Previous Downloads" button not found');
    btn.click();
    await sleep(1500);
  }

  // Find row matching requestedAt within 5 min
  const _RET_MON = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const _retParseTime = text => {
    const m = text.match(/(\d{1,2}):(\d{2}),\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/);
    if (!m) return null;
    const mo = _RET_MON[m[3]];
    return mo !== undefined ? new Date(+m[5], mo, +m[4], +m[1], +m[2]).getTime() : null;
  };

  const timeRe = /\d{1,2}:\d{2},\s*\w+\s+\d{1,2},\s*\d{4}/;
  const candidates = Array.from(document.querySelectorAll('tr, [role="row"], div, li'))
    .filter(el => timeRe.test(el.textContent) && el.textContent.includes('Ready to download'))
    .sort((a, b) => a.textContent.length - b.textContent.length);

  let bestRow = null, bestDiff = Infinity;
  for (const el of candidates) {
    const t = _retParseTime(el.textContent);
    if (t === null) continue;
    const diff = Math.abs(t - requestedAt);
    if (diff < bestDiff) { bestDiff = diff; bestRow = el; }
  }
  const row = (bestDiff <= 5 * 60 * 1000) ? bestRow : null;
  if (!row) {
    const FK_RETURNS_MAX_RECHECKS = 3;
    const { fk_returns_recheck_count = 0 } = await getStorage(['fk_returns_recheck_count']);
    if (fk_returns_recheck_count >= FK_RETURNS_MAX_RECHECKS) {
      rlog(`MANUAL_REQUIRED: report not Ready after ${FK_RETURNS_MAX_RECHECKS} rechecks`);
      chrome.runtime.sendMessage({ type: 'NOTIFY_USER',
        title: 'Rumee -- Manual Action Required',
        message: 'FK Returns report not ready after 3 hourly rechecks. Please download from All Returns > Previous Downloads manually.' });
      await new Promise(res => chrome.storage.local.remove(['fk_returns_recheck_count'], res));
    } else {
      const nextCount = fk_returns_recheck_count + 1;
      await new Promise(res => chrome.storage.local.set({ fk_returns_recheck_count: nextCount }, res));
      chrome.runtime.sendMessage({ type: 'SCHEDULE_FK_RETURNS_RECHECK', delayMinutes: 60 });
      rlog(`Report still Pending -- scheduled recheck ${nextCount}/${FK_RETURNS_MAX_RECHECKS} in 60 min`);
      chrome.runtime.sendMessage({ type: 'NOTIFY_USER',
        title: `Rumee -- FK Returns Still Generating (${nextCount}/${FK_RETURNS_MAX_RECHECKS})`,
        message: 'FK Returns report still generating. Will recheck in 1 hour.' });
    }
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  // Intercept Download button click and upload
  const dlEl = Array.from(row.querySelectorAll('*'))
    .find(el => el.textContent.trim() === 'Download' && !el.children.length);
  if (!dlEl) throw new Error('FkReturnsDownload: "Download" element not found in ready row');

  rlog('READY -- intercepting download...');
  await new Promise(res => chrome.runtime.sendMessage({ type: 'RELAY_ARM', jobId: job.id }, res));
  await sleep(80);
  dlEl.click();
  const relayed = await pollStorageForRelay(TIMEOUT_MS);
  _currentJob = job;
  if (!relayed) {
    chrome.runtime.sendMessage({ type: 'RELAY_DISARM' });
    throw new Error('FkReturnsDownload: no relayed download URL within timeout');
  }
  const captured = { url: relayed.url, headers: {} };

  const datedFilename = makeDatedFilename(job, yesterday, yesterday);
  const resp = await fetch(captured.url, { credentials: 'include', headers: captured.headers || {} });
  if (!resp.ok) throw new Error(`FkReturnsDownload: fetch failed ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const bytes  = new Uint8Array(buffer);
  let binary = ''; const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));

  rlog(`Downloaded ${bytes.length} bytes -- uploading as ${datedFilename}`);
  await new Promise(res => chrome.storage.local.remove([STORAGE_KEY], res));
  chrome.runtime.sendMessage({
    type: 'UPLOAD_DATA', jobId: job.id, data: btoa(binary), encoding: 'base64',
    filename: datedFilename, folderKey: job.folderKey, mimeType: job.mimeType,
  });
}




// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ FK_KEYWORDS â€” Direct API (no navigation needed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Step 1: POST /napi/metrics/search â†’ get all listing IDs for yesterday
// Step 2: POST /graphql (Metrics_listingTopQueries) â†’ keywords per listing
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ FK_RC_DOWNLOAD â€” Poll & download fk_orders, fk_returns, fk_payments â”€â”€â”€â”€â”€â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// This job runs LAST. By this point fk_orders and fk_payments requests were
// submitted at the beginning of the sync (~30-60 min ago) so reports should be Generated.
// fk_returns is not in FK_RC_JOBS — it uses a two-phase direct download (handleFkReturnsRequest + handleFkReturnsDownload).
//
// If any are still generating:
//   â†’ Notify user + schedule 1-hour recheck alarm (up to 3 times)
//   â†’ After 3 failed rechecks: notify user to download manually

const FK_RC_JOBS = ['fk_orders', 'fk_payments'];
const FK_RC_MAX_RECHECKS = 3;

// â”€â”€ Gap catch-up: check any order submitted on a previous day that's now due
// to become ready. Purely additive â€” runs BEFORE the existing loop below,
// which continues to handle today's date exactly as it always has. No-op
// unless catch-up is enabled for a given job (see gcIsEnabledFor).
async function gcCheckFkRCPending() {
  const { gapCatchupPending = {} } = await getStorage(['gapCatchupPending']);
  let pending = gapCatchupPending;
  const today = todayISO();

  for (const jobId of FK_RC_JOBS) {
    if (!(await gcIsEnabledFor(jobId))) continue;
    const item = gcGetOldestPending(pending, jobId);
    if (!item || !item.placed) continue; // nothing submitted-but-not-ready for this job

    const pJob = JOBS.find(j => j.id === jobId);
    const pCfg = REPORTS_CENTRE_CFG[jobId];
    const { btn } = findReportRowDownloadBtn(pCfg.subType, item.date, jobId);

    if (btn) {
      chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId,
        text: `GapCatchup: ${item.date} is ready â€” downloading` });
      const filename = makeDatedFilename(pJob, item.date, item.date);
      await _downloadFkReport(pJob, btn, filename, false); // silent upload, no queue change
      const r = gcRecordOutcome(pending, jobId, item.date, today, true);
      pending = r.pendingItems;
    } else {
      const r = gcRecordOutcome(pending, jobId, item.date, today, false);
      pending = r.pendingItems;
      if (r.escalated) {
        chrome.runtime.sendMessage({ type: 'GAP_CATCHUP_ESCALATED', jobId, date: r.escalated.date, daysPending: r.escalated.daysPending, reason: `report was requested but Flipkart still hasn't generated it after ${r.escalated.daysPending} days` });
      } else {
        chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId,
          text: `GapCatchup: ${item.date} still not ready (day ${r.pendingItems[jobId]?.[0]?.daysPending || '?'})` });
      }
    }
  }
  await new Promise(res => chrome.storage.local.set({ gapCatchupPending: pending }, res));
}

async function handleFkRCDownload(job) {
  await dismissFkPopups();
  const yesterday = yesterdayISO();
  chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: job.id,
    text: `Checking FK RC reports for ${yesterday}` });

  await ensureOnReportsCentre(true);  // already navigates to Requested tab
  await sleep(2000);

  // â”€â”€ Gap catch-up: pick up any previously-submitted, now-ready reports first â”€
  await gcCheckFkRCPending();

  const downloaded = [];
  const pending = [];

  for (const jobId of FK_RC_JOBS) {
    const pJob = JOBS.find(j => j.id === jobId);
    const pCfg = REPORTS_CENTRE_CFG[jobId];
    const { btn, status } = findReportRowDownloadBtn(pCfg.subType, yesterday, jobId);

    if (btn) {
      chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: job.id,
        text: `${jobId}: READY â€” downloading` });
      const filename = makeDatedFilename(pJob, yesterday, yesterday);
      // signalDone=false: upload silently; JOB_DONE for fk_rc_download is sent below
      await _downloadFkReport(pJob, btn, filename, false);
      downloaded.push(jobId);
    } else {
      chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: job.id,
        text: `${jobId}: ${status} â€” not ready yet` });
      pending.push({ jobId, status });
    }
  }

  if (downloaded.length > 0) {
    chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: job.id,
      text: `Downloaded: ${downloaded.join(', ')}` });
  }

  if (pending.length === 0) {
    // All 3 downloaded â€” success
    console.log('[Rumee/FK] All RC reports downloaded âœ“');
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  // Some reports still pending â€” check recheck count
  const { fk_rc_recheck_count = 0 } = await getStorage(['fk_rc_recheck_count']);
  const pendingNames = pending.map(p => p.jobId.replace('fk_', '').toUpperCase()).join(', ');

  if (fk_rc_recheck_count >= FK_RC_MAX_RECHECKS) {
    // 3 hourly rechecks exhausted for today. Split: gap-catchup-enabled jobs
    // hand off to cross-day tracking (will keep retrying on later daily runs,
    // see gcCheckFkRCPending, before finally escalating to manual after
    // GAP_CATCHUP_MAX_DAYS). Everything else keeps the original behavior —
    // notify manual immediately, exactly as before this feature existed.
    const gcPendingJobs = [];
    const legacyPendingJobs = [];
    for (const p of pending) {
      if (await gcIsEnabledFor(p.jobId)) gcPendingJobs.push(p); else legacyPendingJobs.push(p);
    }

    if (gcPendingJobs.length) {
      const { gapCatchupPending = {} } = await getStorage(['gapCatchupPending']);
      let gcState = gapCatchupPending;
      const today = todayISO();
      for (const p of gcPendingJobs) {
        const r = gcRecordOutcome(gcState, p.jobId, yesterday, today, false);
        gcState = gcMarkPlaced(r.pendingItems, p.jobId, yesterday); // submitted OK, just not ready
        if (r.escalated) {
          chrome.runtime.sendMessage({ type: 'GAP_CATCHUP_ESCALATED', jobId: p.jobId, date: r.escalated.date, daysPending: r.escalated.daysPending, reason: `report was requested but Flipkart still hasn't generated it after ${r.escalated.daysPending} days (3 hourly rechecks exhausted each day)` });
        }
      }
      await new Promise(res => chrome.storage.local.set({ gapCatchupPending: gcState }, res));
      chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: job.id,
        text: `GapCatchup: ${gcPendingJobs.map(p=>p.jobId).join(', ')} for ${yesterday} handed off to cross-day tracking (3 hourly rechecks exhausted)` });
    }

    if (legacyPendingJobs.length) {
      const legacyNames = legacyPendingJobs.map(p => p.jobId.replace('fk_', '').toUpperCase()).join(', ');
      chrome.runtime.sendMessage({ type: 'NOTIFY_USER',
        title: 'Rumee â€” Manual Action Required',
        message: `FK Reports (${legacyNames}) not auto-generated after 3 hourly rechecks.\n\nPlease download from Flipkart Reports Centre and place files in the Drive folders manually.`
      });
      chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: job.id,
        text: `MANUAL_REQUIRED: ${legacyNames} â€” 3 rechecks exhausted` });
    }

    await new Promise(res => chrome.storage.local.remove(['fk_rc_recheck_count'], res));
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  // Schedule 1-hour recheck
  const nextCount = fk_rc_recheck_count + 1;
  await new Promise(res => chrome.storage.local.set({ fk_rc_recheck_count: nextCount }, res));
  chrome.runtime.sendMessage({ type: 'SCHEDULE_FK_RC_RECHECK', delayMinutes: 60 });
  chrome.runtime.sendMessage({ type: 'NOTIFY_USER',
    title: `â³ Rumee â€” FK Reports Still Generating (${nextCount}/${FK_RC_MAX_RECHECKS})`,
    message: `${pendingNames} still generating. Will recheck in 1 hour.\n\nIf all 3 are not ready after ${FK_RC_MAX_RECHECKS} rechecks, you will be asked to download manually.`
  });
  chrome.runtime.sendMessage({ type:'LOG_DEBUG', jobId: job.id,
    text: `Scheduled recheck ${nextCount}/${FK_RC_MAX_RECHECKS} in 60 min for: ${pendingNames}` });
  // Signal fk_rc_download complete â€” sync can advance (recheck runs as a separate alarm job)
  chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
}

// â”€â”€â”€ Runs from ANY seller.flipkart.com page. No UI navigation required. â”€â”€â”€â”€â”€â”€â”€

async function handleFkKeywords(job) {
  // â”€â”€ Step 1: Ask user to navigate to the correct page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The keywords data requires: Traffic Report + Latest + All product filter.
  // Extension cannot navigate there programmatically â€” user must do it.
  // IMPORTANT: must be on purchase_funnel + selectedPeriod=latest + activeProductType=ALL
  // Weekly/monthly periods give wrong date ranges â€” only "Latest" is single-day.
  const isReady = () => window.location.hash.includes('purchase_funnel') &&
    window.location.hash.includes('selectedPeriod=latest') &&
    window.location.hash.includes('activeProductType=ALL');

  if (!isReady()) {
    chrome.runtime.sendMessage({
      type: 'NOTIFY_USER',
      title: 'Rumee - Action Required',
      message: 'Please navigate to: Flipkart > Growth > Seller Insights > Traffic Report\n1. Click "Latest" (top-right period selector)\n2. Click "All" (product type filter)\n\nScraping will start automatically once you\'re on the right page.',
    });
    console.log('[Rumee/FK] Keywords: waiting for user to navigate to Traffic Report + Latest + All');

    // Poll until user is on the right page (up to 5 minutes)
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!isReady() && Date.now() < deadline) {
      await sleep(3000);
    }

    if (!isReady()) throw new Error('FK_KEYWORDS: user did not navigate to correct page within 5 min');

    console.log('[Rumee/FK] Keywords: correct page detected â€” starting scrape');
    chrome.runtime.sendMessage({ type: 'NOTIFY_USER', title: 'Rumee', message: 'Starting keyword scrape...' });
    await sleep(2000); // brief settle
  }

  // â”€â”€ Step 2: Extract data date from the URL (most reliable) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // URL has startDate=YYYY-MM-DD which reflects what the user selected.
  // Do NOT use the "Latest" button text â€” it shows the last available data date
  // which may lag behind the selected date.
  let dataDate = yesterdayISO();
  const urlDateMatch = window.location.hash.match(/startDate=(\d{4}-\d{2}-\d{2})/);
  if (urlDateMatch) {
    dataDate = urlDateMatch[1];
  }
  console.log(`[Rumee/FK] Keywords: scraping for date ${dataDate} (from URL)`);

  // â”€â”€ Step 3: DOM scrape â€” same logic as the user's console script â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Page is on Traffic Report + Latest + All â†’ table has "View top search keywords" buttons
  const pageNums = [...document.querySelectorAll('button, a')]
    .map(el => parseInt(el.textContent.trim()))
    .filter(n => !isNaN(n) && n > 0 && n < 1000);
  const totalPages = pageNums.length > 0 ? Math.max(...pageNums) : 1;
  console.log(`[Rumee/FK] Keywords: ${totalPages} page(s), date=${dataDate}`);

  const results = [];
  for (let page = 1; page <= totalPages; page++) {
    if (page > 1) {
      const pageBtn = [...document.querySelectorAll('button, a')]
        .find(el => el.textContent.trim() === String(page));
      if (pageBtn) { pageBtn.click(); await sleep(5000); }
      else { console.warn(`[Rumee/FK] Keywords: page ${page} not found`); break; }
    }

    const rows = [...document.querySelectorAll('tr')];
    let processed = 0;
    for (const row of rows) {
      const btn = [...row.querySelectorAll('button')]
        .find(b => b.textContent.includes('View top search keywords'));
      if (!btn) continue;

      const lines = (row.innerText || '').split('\n').map(l => l.trim()).filter(l => l);
      const sku = lines.length >= 2 ? lines[1] : 'N/A';

      btn.scrollIntoView({ block: 'center' });
      await sleep(800 + Math.random() * 400);
      btn.click();
      await sleep(4000);

      const popup = [...document.querySelectorAll('div')]
        .find(el => el.innerText?.includes('Top 10 Searched Keywords'));

      if (popup) {
        popup.querySelectorAll('table tbody tr').forEach(r => {
          const cols = r.querySelectorAll('td');
          if (cols.length >= 3 && cols[0].innerText.trim()) {
            results.push([dataDate, sku, cols[0].innerText.trim(),
              cols[1].innerText.trim(), cols[2].innerText.trim()]);
          }
        });
        (popup.querySelector('[aria-label="close"]') || document.querySelector('[aria-label="close"]'))?.click();
        processed++;
        await sleep(2000 + Math.random() * 500);
      }
    }
    console.log(`[Rumee/FK] Keywords: page ${page}/${totalPages} â€” ${processed} SKUs`);
  }

  if (results.length === 0) throw new Error('FK_KEYWORDS: no keyword data found â€” ensure Traffic Report + Latest + All is selected');
  console.log(`[Rumee/FK] Keywords: ${results.length} rows`);

  // â”€â”€ Step 4: Build CSV and upload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = `Date,SKU,Keyword,Impression %,Clicks %\n${results.map(r => r.map(q).join(',')).join('\n')}`;
  dispatchData({ ...job, filename: `flipkart_keywords_${dataDate}.csv` }, csv);
  chrome.runtime.sendMessage({ type: 'NOTIFY_USER', title: 'Rumee âœ…', message: `Keywords done! ${results.length} rows uploaded to Drive.` });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ FK_CLAIMS â€” SPF Claims XLSX â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Path: seller.flipkart.com/index.html#claims
//   OR: Help button (bottom-right) â†’ My Help Centre â†’ My Tickets â†’ SPF Claims
//
// First run: download from 2025-12-01 to today (full history).
// Subsequent runs: lastRun[fk_claims] + 1 day â†’ today.

async function handleFkClaims(job) {
  await sleep(5000);
  await dismissFkPopups();
  console.log('[Rumee/FK] Claims: checking if already on claims page');

  // â”€â”€ Navigate to SPF Claims via hash (Payments â†’ SPF section) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!isOnClaimsPage()) {
    console.log('[Rumee/FK] Claims: navigating to #dashboard/payments/spf');
    await waitForSpaBootstrap();
    window.location.hash = '#dashboard/payments/spf';
    await sleep(5000);
  }

  // Fallback: sidebar navigation (Payments â†’ SPF Claims)
  if (!isOnClaimsPage()) {
    console.log('[Rumee/FK] Claims: hash nav failed â€” trying sidebar');
    try {
      await navigateViaFkSidebar('Payments', 'SPF Claims');
    } catch (e) {
      try { await navigateViaFkSidebar('Payments'); } catch (_) {}
      console.warn(`[Rumee/FK] Claims sidebar fallback: ${e.message}`);
    }
    await sleep(3000);
  }

  if (!isOnClaimsPage()) {
    debugPage('claims-navigation-failed');
    throw new Error('FK_CLAIMS: could not reach SPF Claims page');
  }

  console.log('[Rumee/FK] Claims: on SPF Claims page âœ“');

  // â”€â”€ Ensure "Raised by You" tab is active â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const raisedByYouTab = findBtn('Raised by You') || findEl(['Raised by You'], '[role="tab"]');
  if (raisedByYouTab) await clickAndWait(raisedByYouTab, 1000);

  // â”€â”€ Click "Download Report âˆ¨" button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const dlReportBtn = findBtn('Download Report')
    || findEl(['Download Report', 'Download report'], 'button, [role="button"]');
  if (!dlReportBtn) {
    debugPage('claims-no-download-report-btn');
    throw new Error('FK_CLAIMS: "Download Report" button not found');
  }
  await clickAndWait(dlReportBtn, 1500); // extra wait for dropdown animation
  console.log('[Rumee/FK] Claims: opened Download Report dropdown');

  // â”€â”€ Select "Custom Date Range" â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Exact text match on leaf/visible elements (findEl matches parents too, which is wrong)
  const customRangeOpt = (() => {
    const exact = Array.from(document.querySelectorAll('li, a, button, [role="option"], span, div'))
      .find(el => el.offsetParent && el.textContent.trim() === 'Custom Date Range');
    if (exact) return exact;
    // Fallback: any element containing the text
    return findBtn('Custom Date Range')
      || findEl(['Custom Date Range'], 'li, [role="option"], a, button');
  })();
  if (!customRangeOpt) {
    debugPage('claims-no-custom-range');
    throw new Error('FK_CLAIMS: "Custom Date Range" option not found');
  }
  await clickAndWait(customRangeOpt, 1500);
  console.log('[Rumee/FK] Claims: selected Custom Date Range');

  // â”€â”€ Determine date range â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const { lastRun = {}, fkClaimsFirstRunDone } = await getStorage(['lastRun', 'fkClaimsFirstRunDone']);
  const toDate   = todayISO();
  let fromDate = !fkClaimsFirstRunDone
    ? '2025-12-01'
    : (lastRun['fk_claims'] ? addDays(lastRun['fk_claims'], 1) : daysAgoISO(30));
  // Clamp: if lastRun was today (same-day re-run), fromDate would be tomorrow â€” fix it
  if (fromDate > toDate) fromDate = toDate;

  if (!fkClaimsFirstRunDone) {
    await setStorage({ fkClaimsFirstRunDone: true });
    console.log(`[Rumee/FK] Claims: FIRST RUN â€” downloading history from ${fromDate} to ${toDate}`);
  } else {
    console.log(`[Rumee/FK] Claims: incremental â€” ${fromDate} â†’ ${toDate}`);
  }

  // â”€â”€ Fill date range â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await fillDateRange(fromDate, toDate);

  // â”€â”€ Click "Done" â€” bottom-right of the calendar popup (may not be a <button>) â”€â”€
  const doneBtn = findBtn('Done')
    || findBtn('Apply')
    || findBtn('Confirm')
    || Array.from(document.querySelectorAll('*'))
        .find(el => el.offsetParent && el.textContent.trim() === 'Done');
  if (!doneBtn) {
    debugPage('claims-no-done-btn');
    throw new Error('FK_CLAIMS: "Done" button not found after selecting custom date range');
  }

  // RELAY_ARM: content script still does the fetch itself (background re-fetch
  // fails CORS for this Flipkart CDN endpoint), just fed a reliable URL.
  await new Promise(res => chrome.runtime.sendMessage({ type: 'RELAY_ARM', jobId: job.id }, res));
  await clickAndWait(doneBtn, 300);

  const relayed = await pollStorageForRelay(TIMEOUT_MS);
  _currentJob = job;
  if (!relayed) {
    const bodyText = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `claims-no-relay bodyText snippet: ${bodyText}` });
    chrome.runtime.sendMessage({ type: 'RELAY_DISARM' });
    throw new Error('FK_CLAIMS: no relayed download URL within timeout');
  }
  const captured = { url: relayed.url, headers: {} };

  const claimsFilename = makeDatedFilename(job, fromDate, toDate);
  console.log(`[Rumee/FK] Claims: fetching as ${claimsFilename}`);
  const resp = await fetch(captured.url, { credentials: 'include', headers: captured.headers || {} });
  if (!resp.ok) throw new Error(`FK_CLAIMS: fetch failed ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = ''; const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  chrome.runtime.sendMessage({
    type: 'UPLOAD_DATA', jobId: job.id, data: btoa(binary), encoding: 'base64',
    filename: claimsFilename, folderKey: job.folderKey, mimeType: job.mimeType,
  });
}

function isOnClaimsPage() {
  const body = document.body.innerText || '';
  return (
    body.includes('SPF Claims') ||
    (body.includes('Raised by You') && body.includes('Auto Approved')) ||
    (body.includes('Download Report') && body.includes('Claim ID'))
  );
}

async function navigateToClaimsViaHelp() {
  // Flipkart's Help button is a floating widget in the bottom-right corner.
  const helpSelectors = [
    '[data-testid="help-button"]',
    '#helpBtn', '#help-btn', '#helpButton',
    '.help-fab', '.help-button',
    '[aria-label*="help" i]',
    '[title*="help" i]',
    '[class*="helpButton" i]',
    '[class*="help-widget" i]',
  ];

  let helpBtn = null;
  for (const sel of helpSelectors) {
    helpBtn = document.querySelector(sel);
    if (helpBtn) { console.log(`[Rumee/FK] Found help btn via: ${sel}`); break; }
  }

  if (!helpBtn) {
    // Fallback: any element in the bottom-right area with help-related text/aria
    helpBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        return aria.includes('help') || title.includes('help');
      });
  }

  if (!helpBtn) {
    console.warn('[Rumee/FK] Claims: Help button not found â€” trying hash navigation');
    window.location.hash = '#claims';
    await sleep(5000);
    return;
  }

  await clickAndWait(helpBtn, 3000);
  console.log('[Rumee/FK] Claims: clicked Help button');

  // Click "My Help Center" or "My Help Centre"
  const helpCentreLink = findBtn('My Help Center')
    || findBtn('My Help Centre')
    || findEl(['My Help Center', 'My Help Centre', 'Help Center', 'View Help'], 'a, button, [role="link"]');
  if (helpCentreLink) { await clickAndWait(helpCentreLink, 4000); console.log('[Rumee/FK] Clicked My Help Centre'); }

  // Click "My Tickets"
  const ticketsBtn = findBtn('My Tickets')
    || findEl(['My Tickets', 'Your Tickets', 'Tickets Dashboard'], 'button, a, [role="button"]');
  if (ticketsBtn) { await clickAndWait(ticketsBtn, 3000); console.log('[Rumee/FK] Clicked My Tickets'); }

  // Click "SPF Claims" tab
  const spfTab = findBtn('SPF Claims')
    || findEl(['SPF Claims', 'SPF', 'spf claims'], '[role="tab"], li, button, a');
  if (spfTab) { await clickAndWait(spfTab, 2000); console.log('[Rumee/FK] Clicked SPF Claims tab'); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ FK_LISTINGS â€” Master Listing XLS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Flow: My Listings â†’ Downloads button â†’ Download Listing File â†’ wait for
// "Generating X%" â†’ poll until complete â†’ click download â†“ â†’ intercept URL.

// ── Phase 1: trigger generation and move on immediately ──────────────────────
async function handleFkListings(job) {
  const rlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `FkListings: ${txt}` });
  await sleep(6000);
  await dismissFkPopups();

  const onListings = () => document.body.innerText.includes('Downloads')
    || document.body.innerText.includes('My Listings')
    || (document.body.innerText.includes('Active') && document.body.innerText.includes('Listing'));

  if (!onListings()) {
    await waitForSpaBootstrap();
    window.location.hash = '#dashboard/listings-management';
    await sleep(5000);
    if (!onListings()) {
      try { await navigateViaFkSidebar('Listings'); } catch (e) { debugPage('listings-nav-failed'); }
      await sleep(3000);
    }
  }

  const allFilterBtn = findEl(['All'], '[role=”tab”], button[class*=”filter” i], li[class*=”filter” i]');
  if (allFilterBtn && !allFilterBtn.classList.contains('active') && !allFilterBtn.getAttribute('aria-selected'))
    await clickAndWait(allFilterBtn, 1000);

  let downloadsBtn = null;
  for (let w = 0; w < 10; w++) {
    await sleep(2000);
    downloadsBtn = Array.from(document.querySelectorAll('button, [role=”button”], a'))
      .find(el => el.offsetParent && /^downloads?$/i.test(el.textContent.trim()));
    if (downloadsBtn) break;
    downloadsBtn = Array.from(document.querySelectorAll('button, [role=”button”]'))
      .find(el => el.offsetParent && /download/i.test(el.textContent.trim()) && el.textContent.trim().length < 30 && !/listing/i.test(el.textContent));
    if (downloadsBtn) break;
  }
  if (!downloadsBtn) {
    const allBtns = Array.from(document.querySelectorAll('button, [role=”button”], a'))
      .filter(el => el.offsetParent).map(el => el.textContent.trim().slice(0, 30)).join(' | ');
    rlog(`No Downloads btn after 20s. Visible: ${allBtns.slice(0, 200)}`);
    throw new Error('FK_LISTINGS: “Downloads” button not found after 20s');
  }
  await clickAndWait(downloadsBtn, 1000);

  const dlListingOpt = Array.from(document.querySelectorAll('*'))
    .find(el => el.offsetParent && /download listing file/i.test(el.textContent.trim()) &&
      el.textContent.trim().length < 30);
  const dropItems = Array.from(document.querySelectorAll('*'))
    .filter(el => el.offsetParent && /download|listing|recent/i.test(el.textContent.trim()) && el.textContent.trim().length < 50)
    .map(el => `[${el.tagName}]${el.textContent.trim().slice(0,30)}`).join(' | ');
  rlog(`Dropdown items: ${dropItems.slice(0, 200)}`);
  if (!dlListingOpt) throw new Error('FK_LISTINGS: “Download Listing File” option not found in dropdown');
  await clickAndWait(dlListingOpt, 2000);
  rlog('Generation triggered -- fk_listings_download will pick up later');

  await new Promise(res => chrome.storage.local.set({ fk_listings_gen_date: todayISO() }, res));
  chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
}

// ── Phase 2: check if ready, download; else schedule recheck ─────────────────
async function handleFkListingsDownload(job) {
  const rlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `FkListingsDownload: ${txt}` });
  const FK_LISTINGS_MAX_RECHECKS = 3;

  const { fk_listings_gen_date } = await getStorage(['fk_listings_gen_date']);
  if (fk_listings_gen_date !== todayISO()) {
    rlog(`No generation triggered today (stored=${fk_listings_gen_date}) -- skipping`);
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  // Navigate to listings page
  const onListings = () => document.body.innerText.includes('Downloads History')
    || document.body.innerText.includes('My Listings')
    || (document.body.innerText.includes('Active') && document.body.innerText.includes('Listing'));

  await dismissFkPopups();
  await sleep(4000);
  if (!onListings()) {
    await waitForSpaBootstrap();
    window.location.hash = '#dashboard/listings-management';
    await sleep(5000);
    if (!onListings()) {
      try { await navigateViaFkSidebar('Listings'); } catch (e) { /* ignore */ }
      await sleep(3000);
    }
  }

  // Open Downloads → View Recent Downloads
  let downloadsBtn = null;
  for (let w = 0; w < 10; w++) {
    await sleep(2000);
    downloadsBtn = Array.from(document.querySelectorAll('button, [role=”button”], a'))
      .find(el => el.offsetParent && /^downloads?$/i.test(el.textContent.trim()));
    if (downloadsBtn) break;
    downloadsBtn = Array.from(document.querySelectorAll('button, [role=”button”]'))
      .find(el => el.offsetParent && /download/i.test(el.textContent.trim()) && el.textContent.trim().length < 30 && !/listing/i.test(el.textContent));
    if (downloadsBtn) break;
  }
  if (!downloadsBtn) throw new Error('FkListingsDownload: Downloads button not found');
  await clickAndWait(downloadsBtn, 800);

  const viewRecent = Array.from(document.querySelectorAll('*'))
    .find(el => el.offsetParent && /view recent downloads/i.test(el.textContent.trim()) && el.textContent.trim().length < 30);
  if (viewRecent) await clickAndWait(viewRecent, 2000);

  // Poll up to 2 min for the file to become ready
  const pollDeadline = Date.now() + 2 * 60 * 1000;
  let fileBtn = null;
  while (Date.now() < pollDeadline) {
    fileBtn = findReadyListingDownloadBtn();
    if (fileBtn) { rlog('File ready -- downloading'); break; }
    const panelOpen = document.body.innerText.includes('Downloads History');
    rlog(`Poll: panelOpen=${panelOpen}`);
    await sleep(5000);
    if (!panelOpen) {
      await clickAndWait(downloadsBtn, 800);
      await sleep(500);
      const vr = Array.from(document.querySelectorAll('*'))
        .find(el => el.offsetParent && /view recent downloads/i.test(el.textContent.trim()));
      if (vr) await clickAndWait(vr, 2000);
    }
  }

  if (!fileBtn) {
    const { fk_listings_recheck_count = 0 } = await getStorage(['fk_listings_recheck_count']);
    if (fk_listings_recheck_count >= FK_LISTINGS_MAX_RECHECKS) {
      rlog(`MANUAL_REQUIRED: still Generating after ${FK_LISTINGS_MAX_RECHECKS} rechecks`);
      chrome.runtime.sendMessage({ type: 'NOTIFY_USER',
        title: 'Rumee -- Manual Action Required',
        message: 'FK Listings file not ready after 3 rechecks. Download manually from All Listings > Downloads.' });
      await new Promise(res => chrome.storage.local.remove(['fk_listings_recheck_count', 'fk_listings_gen_date'], res));
    } else {
      const nextCount = fk_listings_recheck_count + 1;
      await new Promise(res => chrome.storage.local.set({ fk_listings_recheck_count: nextCount }, res));
      chrome.runtime.sendMessage({ type: 'SCHEDULE_FK_LISTINGS_RECHECK', delayMinutes: 60 });
      rlog(`Still Generating -- scheduled recheck ${nextCount}/${FK_LISTINGS_MAX_RECHECKS} in 60 min`);
      chrome.runtime.sendMessage({ type: 'NOTIFY_USER',
        title: `Rumee -- FK Listings Still Generating (${nextCount}/${FK_LISTINGS_MAX_RECHECKS})`,
        message: 'FK Listings file still generating. Will recheck in 1 hour.' });
    }
    chrome.runtime.sendMessage({ type: 'JOB_DONE', jobId: job.id });
    return;
  }

  // Download the ready file
  await new Promise(res => chrome.runtime.sendMessage({ type: 'RELAY_ARM', jobId: job.id }, res));
  await clickAndWait(fileBtn, 300);
  const relayed = await pollStorageForRelay(TIMEOUT_MS);
  _currentJob = job;
  if (!relayed) {
    chrome.runtime.sendMessage({ type: 'RELAY_DISARM' });
    throw new Error('FkListingsDownload: no relayed download URL within timeout');
  }
  const captured = { url: relayed.url, headers: {} };

  const resp = await fetch(captured.url, { credentials: 'include', headers: captured.headers || {} });
  if (!resp.ok) throw new Error(`FkListingsDownload: fetch failed ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = ''; const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  await new Promise(res => chrome.storage.local.remove(['fk_listings_gen_date', 'fk_listings_recheck_count'], res));
  rlog(`Downloaded ${bytes.length} bytes -- uploading as flipkart_listings_${todayISO()}.xls`);
  chrome.runtime.sendMessage({
    type: 'UPLOAD_DATA', jobId: job.id, data: btoa(binary), encoding: 'base64',
    filename: `flipkart_listings_${todayISO()}.xls`, folderKey: job.folderKey, mimeType: job.mimeType,
  });
}

/**
 * In the Downloads History modal, find the download icon/button for the most
 * recent "Listing" entry that is NOT still in "Generating" state.
 */
function findReadyListingDownloadBtn() {
  const bodyText = document.body.innerText;
  const hasPanel = bodyText.includes('Downloads History');

  // Log state on each check
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: 'fk_listings',
    text: `findReady: panel=${hasPanel} snippet="${bodyText.slice(0,300).replace(/\n/g,' ')}"` });

  if (!hasPanel) return null;

  // Strategy 1: Any anchor with .xls href (direct download link)
  const xls = Array.from(document.querySelectorAll('a'))
    .find(el => el.offsetParent && /\.(xls|xlsx)/i.test(el.href) && !/catalog/i.test(el.href));
  if (xls) { console.log(`[Rumee/FK] XLS link found: ${xls.href.slice(0,80)}`); return xls; }

  // Strategy 2: Find ALL elements in the Downloads History panel area
  // Panel is a slide-in on the right â€” find it by looking for the heading
  const allEls = Array.from(document.querySelectorAll('*'));
  const panelEl = allEls.find(el => el.offsetParent &&
    el.children.length === 0 && el.textContent.trim() === 'Downloads History');

  if (panelEl) {
    // Walk up to find the panel container, then search inside it
    let container = panelEl.parentElement;
    for (let i = 0; i < 6 && container; i++) {
      const allBtns = Array.from(container.querySelectorAll('button, a, [role="button"]'));
      for (const btn of allBtns) {
        if (!btn.offsetParent) continue;
        const row = btn.closest('[class*="row"], tr, li, div');
        if (!row) continue;
        const rowTxt = row.textContent;
        if (!/listing/i.test(rowTxt) || /catalog/i.test(rowTxt)) continue;
        if (/generating|pending/i.test(rowTxt) || /%/.test(rowTxt)) continue;
        // This button is inside a Listing row that's not generating
        console.log(`[Rumee/FK] Found btn in Listing row: ${btn.tagName} "${btn.textContent.trim().slice(0,20)}"`);
        return btn;
      }
      container = container.parentElement;
    }
  }

  // Strategy 3: Global â€” any button/link near "S_listing" filename
  const listingFilename = allEls.find(el => el.offsetParent &&
    /^S_listing/i.test(el.textContent.trim()));
  if (listingFilename) {
    let p = listingFilename.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      const btn = Array.from(p.querySelectorAll('button, a, [role="button"]'))
        .find(b => b.offsetParent && (b.querySelector('svg') || /download/i.test(b.getAttribute('aria-label') || '')));
      if (btn) { console.log('[Rumee/FK] Found btn near S_listing filename'); return btn; }
      p = p.parentElement;
    }
  }

  return null;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â”€â”€ Shared date-range filler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Flipkart uses different input patterns across pages:
//   - HTML <input type="date"> (ideal)
//   - Text inputs with DD/MM/YYYY placeholders
//   - Click-driven calendars (handled by caller with day-click logic)

async function fillDateRange(fromISO, toISO) {
  // 1 â€” Native date inputs
  const dateInputs = Array.from(document.querySelectorAll('input[type="date"]'));
  if (dateInputs.length >= 2) {
    const [fi, ti] = dateInputs;
    setValue(fi, fromISO);
    await sleep(300);
    setValue(ti, toISO);
    console.log(`[Rumee/FK] fillDateRange (type=date): ${fromISO} â†' ${toISO}`);
    return;
  }

  // 2 â€” Text inputs with DD/MM/YYYY format
  const ddmmyyyy = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
  const textInputs = Array.from(document.querySelectorAll(
    'input[placeholder*="From" i], input[placeholder*="To" i], ' +
    'input[placeholder*="Start" i], input[placeholder*="End" i], ' +
    'input[placeholder*="DD" i], input[placeholder*="date" i]'
  ));
  if (textInputs.length >= 2) {
    const [fi, ti] = textInputs;
    setValue(fi, ddmmyyyy(fromISO));
    await sleep(300);
    setValue(ti, ddmmyyyy(toISO));
    console.log(`[Rumee/FK] fillDateRange (DD/MM/YYYY text): ${fromISO} â†' ${toISO}`);
    return;
  }

  // 3 â€” Click-driven calendar (e.g. Flipkart Claims, dual-month picker)
  const clickCalDate = async (isoDate) => {
    const [y, m, d] = isoDate.split('-').map(Number);
    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    const mName = MONTHS[m - 1];

    // Try aria-label formats
    const label1 = `${mName} ${d}, ${y}`;    // "May 31, 2026"
    const label2 = `${d} ${mName} ${y}`;     // "31 May 2026"
    const label3 = `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`; // "31/05/2026"

    let cell = document.querySelector(
      `[aria-label="${label1}"], [aria-label="${label2}"], [data-date="${isoDate}"]`
    );
    if (cell && cell.offsetParent) { cell.click(); await sleep(300); return true; }

    // Fallback: find visible day number cell in a calendar context
    const dayCells = Array.from(document.querySelectorAll(
      'td, [role="gridcell"], [role="cell"], [class*="day"], [class*="date"]'
    )).filter(el => el.offsetParent && el.textContent.trim() === String(d));
    // Pick the one whose ancestor mentions the correct month
    const correct = dayCells.find(el => {
      let anc = el.parentElement;
      for (let i = 0; i < 6 && anc; i++) {
        if (anc.textContent.includes(mName) || anc.textContent.includes(`${m}/${y}`) || anc.textContent.includes(`${mName} ${y}`)) return true;
        anc = anc.parentElement;
      }
      return false;
    }) || dayCells[0];

    if (correct) { correct.click(); await sleep(300); return true; }
    return false;
  };

  const fromOk = await clickCalDate(fromISO);
  await sleep(400);
  const toOk = await clickCalDate(toISO);
  if (fromOk || toOk) {
    console.log(`[Rumee/FK] fillDateRange (calendar click): ${fromISO} â†' ${toISO} (from=${fromOk} to=${toOk})`);
    return;
  }

  console.warn(`[Rumee/FK] fillDateRange: no strategy worked â€” ${fromISO}â†'${toISO} NOT set`);
}

/** Set an input value and fire React/Angular change events. */
function setValue(input, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype, 'value'
  )?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// â”€â”€â”€ Persist metrics headers captured by intercept.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// When intercept.js captures auth headers from /napi/metrics/search, it posts
// __rumeeMetricsHeadersCaptured. We store them in chrome.storage.local so they
// survive page reloads and are available when fk_keywords runs.
window.addEventListener('message', (event) => {
  if (!event.data?.__rumeeMetricsHeadersCaptured) return;
  const headers = event.data.headers || {};
  if (Object.keys(headers).length > 0) {
    chrome.storage.local.set({ _fkMetricsHeaders: headers });
    console.log('[Rumee/FK] Persisted metrics headers to storage:', Object.keys(headers));
  }
});

// â”€â”€â”€ RUN_JOB direct trigger (for skipNavigation jobs like fk_keywords) â”€â”€â”€â”€â”€â”€â”€â”€
// Background sends this when it cannot navigate the tab (user must be on right page).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'RUN_JOB') return;
  const job = JOBS.find(j => j.id === msg.jobId);
  if (!job) { sendResponse({ ok: false, error: 'Job not found' }); return; }

  _currentJob = job;
  console.log(`[Rumee/FK] â–¶ RUN_JOB: ${job.id} | url: ${window.location.href}`);
  const handler = HANDLERS_FK[job.id];
  if (handler) {
    handler(job).catch(err => reportError(job.id, err.message || String(err)));
  } else {
    reportError(job.id, `No handler for "${job.id}"`);
  }
  sendResponse({ ok: true });
});

// â”€â”€â”€ CS_FETCH_AND_UPLOAD: background delegates portal fetches here â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Flipkart portal URLs (seller.flipkart.com) return HTML to the SW because
// SameSite cookies are blocked. The content script runs at the correct origin
// and receives the session cookies â€” it fetches and hands the data back.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'CS_FETCH_AND_UPLOAD') return;
  const { jobId, url, filename, folderKey, mimeType } = msg;
  console.log(`[Rumee/FK] CS_FETCH_AND_UPLOAD: fetching ${url.slice(0, 80)} for ${jobId}`);

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
      console.error(`[Rumee/FK] CS_FETCH_AND_UPLOAD failed for ${jobId}:`, err);
      chrome.runtime.sendMessage({
        type: 'CS_UPLOAD_DONE', jobId, error: err.message
      });
    });

  sendResponse({ ok: true });
  return true;
});

// â”€â”€â”€ MAIN-world download intercept relay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.addEventListener('message', (event) => {
  if (!event.data?.__rumeeDownload) return;
  if (!_currentJob) return;
  // Skip dispatch if the handler is fetching the file directly from the
  // content script â€” prevents background from trying (and failing) to re-fetch.
  if (_handlingDownloadInContentScript) return;

  const capturedJob = _currentJob;
  _currentJob = null;
  window.__rumeeIntercepting = false;

  const { url, headers } = event.data;
  console.log(`[Rumee/FK] âœ“ MAIN-world relay: ${url.slice(0, 160)}`);
  dispatchDownload(capturedJob, url, headers || {}, window.location.href);
});

// â”€â”€â”€ MAIN-world blob relay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Handles blob-based FK downloads (e.g. reports served as binary blobs).
window.addEventListener('message', (event) => {
  if (!event.data?.__rumeeBlob) return;
  if (!window.__rumeeIntercepting && !window.__rumeeCapturingBlob) return;
  if (!_currentJob) return;

  const capturedJob = _currentJob;
  _currentJob = null;
  window.__rumeeIntercepting = false;
  window.__rumeeCapturingBlob = false;

  const { base64, mimeType, size } = event.data;
  console.log(`[Rumee/FK] âœ“ blob relay: ${size} bytes â†' ${capturedJob.id}`);

  chrome.runtime.sendMessage({
    type:      'UPLOAD_DATA',
    jobId:     capturedJob.id,
    data:      base64,
    encoding:  'base64',
    filename:  capturedJob.filename,
    folderKey: capturedJob.folderKey,
    mimeType:  capturedJob.mimeType || mimeType,
  });
});

// â”€â”€â”€ MCP Debug Relay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Allows triggering FK jobs and reading status via window.postMessage.
window.addEventListener('message', async (event) => {
  if (event.origin !== location.origin) return;
  if (!event.data?.__rumee) return;
  const { msg } = event.data;
  if (!msg?.type) return;

  if (msg.type === 'READ_STATUS') {
    const data = await new Promise(r => chrome.storage.local.get(
      ['syncRunning','syncQueue','syncDone','syncFailed','lastRun','currentJobId'], r
    ));
    window.postMessage({ __rumeeStatusData: true, status: data }, '*');
    return;
  }
  if (msg.type === 'READ_LOG') {
    const data = await new Promise(r => chrome.storage.local.get(['rumeeLog'], r));
    window.postMessage({ __rumeeLogData: true, log: data.rumeeLog || [] }, '*');
    return;
  }
  chrome.runtime.sendMessage(msg);
});

} // end double-injection guard
