// ─── Rumee — Bulk Flipkart Content Script ─────────────────────────────────────
// Injected by background.js (bulk-handler.js) via chrome.scripting.executeScript
// when a bulk job tab finishes loading. All message types are BULK_* to avoid
// collision with the daily sync path.

if (!window.__rumeeBulkFkInjected) {
window.__rumeeBulkFkInjected = true;
'use strict';

// ─── Module-level state ───────────────────────────────────────────────────────
let _bulkCurrentJob = null;
let _bulkHandlingDownloadInContentScript = false;

// ─── Handler registry ─────────────────────────────────────────────────────────
const HANDLERS_BULK_FK = {
  fk_orders:         handleBulkFkReportsCentre,
  fk_returns:        handleBulkFkReportsCentre,
  fk_payments:       handleBulkFkReportsCentre,
  fk_rc_download:    handleBulkFkRCDownload,
  fk_ads_daily:      handleBulkFkAds,
  fk_ads_fsn:        handleBulkFkAds,
  fk_ads_placements: handleBulkFkAds,
  fk_ads_overall:    handleBulkFkAds,
  fk_ads_search:     handleBulkFkAds,
  fk_ads_orders:     handleBulkFkAds,
  fk_ads_kw:         handleBulkFkAds,
  fk_views_request:  handleBulkFkViewsRequest,
  fk_views:          handleBulkFkViewsDownload,
  fk_claims:         handleBulkFkClaims,
};

const REPORTS_CENTRE_CFG = {
  fk_orders:   { categoryTab: 'Fulfilment', skipCategoryTab: true, subType: 'orders',               requestType: 'Fulfilment Reports', requestSubType: 'Orders',               requestOnly: true },
  fk_returns:  { categoryTab: 'Fulfilment', skipCategoryTab: true, subType: 'returns',              requestType: 'Fulfilment Reports', requestSubType: 'Returns',              requestOnly: true },
  fk_payments: { categoryTab: null,         skipCategoryTab: true, subType: 'settled transactions', requestType: 'Payment Reports',    requestSubType: 'Settled Transactions', requestOnly: true },
};

const FK_DOWNLOAD_PATTERNS = [
  /\/download/i, /\/export/i, /downloadReport/i, /getReport/i,
  /\.xlsx(\?|$)/i, /\.csv(\?|$)/i, /\.xls(\?|$)/i,
  /amazonaws\.com/i, /storage\.googleapis/i, /cdn.*download/i,
];

const BULK_FK_RC_JOBS         = ['fk_orders', 'fk_returns', 'fk_payments'];
const BULK_FK_RC_MAX_RECHECKS = 6;
const BULK_FK_VIEWS_MAX_RECHECKS = 6;

// ─── Entry point ──────────────────────────────────────────────────────────────

(async () => {
  const resp = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'BULK_CONTENT_READY' }, resolve);
  });
  const job = resp?.job || null;
  if (!job) { console.log('[Rumee/BulkFK] No bulk job — standing by'); return; }

  const isLoginPage = () => {
    const url = window.location.href;
    return url.includes('/login') || url.includes('/signin')
      || document.title.toLowerCase().includes('login');
  };
  if (isLoginPage()) {
    chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: job.id, error: 'FK login required — please log in and re-run bulk' });
    return;
  }

  _bulkCurrentJob = job;
  console.log(`[Rumee/BulkFK] ▶ job=${job.id} from=${job.targetFromDate} to=${job.targetToDate}`);

  const handler = HANDLERS_BULK_FK[job.id];
  if (!handler) {
    chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: job.id, error: `No bulk handler for "${job.id}"` });
    return;
  }
  try {
    await handler(job);
  } catch (err) {
    console.error(`[Rumee/BulkFK] ✖ ${job.id}:`, err);
    chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: job.id, error: err.message || String(err) });
  }
})();

// ─── Shared helpers (adapted from flipkart.js) ────────────────────────────────

function signalBulkDownloadExpected(job, filenameOverride = null) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'BULK_DOWNLOAD_BUTTON_CLICKED', jobId: job.id, filenameOverride }, () => {
      if (filenameOverride && _bulkCurrentJob && _bulkCurrentJob.id === job.id) {
        _bulkCurrentJob.filename = filenameOverride;
      }
      window.__rumeeIntercepting = true;
      window.__rumeeCapturingBlob = true;
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

function waitForElement(selector, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sels = selector.split(',').map(s => s.trim());
    const check = () => {
      for (const s of sels) { try { const el = document.querySelector(s); if (el) return el; } catch (_) {} }
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

async function clickAndWait(el, ms = 1000) {
  chrome.runtime.sendMessage({
    type: 'LOG_DEBUG', jobId: _bulkCurrentJob?.id || 'bulk_fk',
    text: `CLICK ${el.tagName} "${(el.textContent || '').trim().slice(0, 60)}" wait=${ms}ms`,
  }).catch(() => {});
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(200);
  el.click();
  await sleep(ms);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function todayISO()      { return new Date().toISOString().slice(0, 10); }
function daysAgoISO(n)   { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function yesterdayISO()  { return daysAgoISO(1); }
function addDays(isoDate, n) { const d = new Date(isoDate); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

function makeDatedFilename(job, fromDate, toDate) {
  const dotIdx = job.filename.lastIndexOf('.');
  const base   = job.filename.slice(0, dotIdx);
  const ext    = job.filename.slice(dotIdx);
  const dateStr = (toDate && toDate !== fromDate) ? `${fromDate}_${toDate}` : fromDate;
  return `${base}_${dateStr}${ext}`;
}

function debugPage(label = '', jobId = 'bulk_fk') {
  const els = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], a[href]'));
  const lines = els.slice(0, 40).map((el, i) =>
    `[${i}] ${el.tagName} "${el.textContent.trim().slice(0, 60)}" aria="${el.getAttribute('aria-label') || ''}"`
  );
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

function looksLikeDownload(url) {
  return typeof url === 'string' && FK_DOWNLOAD_PATTERNS.some(p => p.test(url));
}

function interceptNextDownload(timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      window.__rumeeIntercepting = false;
      window.removeEventListener('message', onMsg);
      debugPage('bulk-download-timeout');
      reject(new Error('interceptNextDownload: no download captured within timeout'));
    }, timeout);

    function onMsg(event) {
      if (!event.data?.__rumeeDownload) return;
      if (settled) return;
      const { url, headers } = event.data;
      const isFalsePositive = /getReportsCount|bizReport\/get[A-Za-z]|\/metrics\/.*\/get[A-Za-z]/i.test(url);
      if (isFalsePositive) return;
      settled = true;
      clearTimeout(timer);
      window.__rumeeIntercepting = false;
      window.removeEventListener('message', onMsg);
      resolve({ url, headers: headers || {}, referer: window.location.href });
    }
    window.addEventListener('message', onMsg);
    window.__rumeeIntercepting = true;
    window.postMessage({ __rumeeArmCapture: true, __rumeeCapturingBlob: false }, '*');
  });
}

async function dismissFkPopups() {
  const notifOpen = Array.from(document.querySelectorAll('span, button, a, div'))
    .find(el => el.offsetParent !== null && (el.textContent || '').trim() === 'Mark All as Read');
  if (notifOpen) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(400);
  }
  const CLOSE_SELECTORS = [
    '[aria-label="close" i]', '[aria-label="Close" i]', '[aria-label="dismiss" i]',
    'button[class*="close" i]', 'button[class*="Close"]', 'button[class*="dismiss" i]',
    '[data-testid*="close" i]', '[data-testid*="dismiss" i]',
  ];
  const CLOSE_TEXTS = ['close', 'skip', 'got it', 'ok', 'dismiss', 'maybe later', 'not now', 'no thanks', '✕', '×', 'x'];
  for (let round = 0; round < 3; round++) {
    let dismissed = false;
    const _isNavEl = el => !!el.closest('header, nav, [class*="NavigationRail"], [class*="navbar"], [class*="topbar"], [class*="header" i]');
    for (const sel of CLOSE_SELECTORS) {
      try {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null && !_isNavEl(btn)) {
          btn.click(); await sleep(600); dismissed = true; break;
        }
      } catch (_) {}
    }
    if (!dismissed) {
      const overlayContainers = document.querySelectorAll('[class*="modal" i], [class*="overlay" i], [class*="dialog" i], [class*="popup" i]');
      for (const container of overlayContainers) {
        if (!container.offsetParent) continue;
        const btns = Array.from(container.querySelectorAll('button, a, span'));
        const closeBtn = btns.find(b => CLOSE_TEXTS.some(t => b.textContent.trim().toLowerCase() === t));
        if (closeBtn) { closeBtn.click(); await sleep(600); dismissed = true; break; }
      }
    }
    if (!dismissed) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      break;
    }
    await sleep(800);
  }
}

async function navigateViaFkSidebar(...labels) {
  console.log(`[Rumee/BulkFK] Sidebar: ${labels.join(' → ')}`);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const isLast = (i === labels.length - 1);
    let el = findEl([label], 'nav a, nav li, nav button, [class*="sidebar"] a, [class*="sidebar"] li, [class*="nav-item"] a, [class*="nav-link"], [class*="sidenav"] a');
    if (!el) {
      const candidates = Array.from(document.querySelectorAll('a, button, li, [role="menuitem"]'));
      el = candidates.find(e => { const t = e.textContent.trim(); return t === label || t.toLowerCase() === label.toLowerCase(); }) || null;
    }
    if (!el) {
      const retryDeadline = Date.now() + 8000;
      while (!el && Date.now() < retryDeadline) {
        await sleep(1500);
        el = findEl([label], 'nav a, nav li, nav button, [class*="sidebar"] a');
        if (!el) {
          const candidates = Array.from(document.querySelectorAll('a, button, li, [role="menuitem"]'));
          el = candidates.find(e => { const t = e.textContent.trim(); return t === label || t.toLowerCase() === label.toLowerCase(); }) || null;
        }
      }
    }
    if (!el) throw new Error(`FK sidebar nav: "${label}" not found`);
    await clickAndWait(el, isLast ? 4000 : 2000);
    if (!isLast) await sleep(1200);
  }
}

async function waitForSpaBootstrap() {
  await waitForElement('nav a[href], [class*="sidebar"] a, a[href*="#dashboard"], a[href*="seller.flipkart"]', 15000)
    .catch(() => console.warn('[Rumee/BulkFK] SPA bootstrap timeout'));
  await sleep(2000);
}

function isOnReportsCentrePage() {
  return window.location.hash.includes('report-centre');
}

async function ensureOnReportsCentre(forceFresh = false) {
  const _rclog = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: _bulkCurrentJob?.id || 'bulk_fk_rc', text: `RC: ${t}` }).catch(() => {});
  await _rclog(`ensureOnReportsCentre force=${forceFresh} hash=${window.location.hash.slice(0,60)}`);
  if (!forceFresh && isOnReportsCentrePage()) { await _rclog('already on RC page'); return; }
  await waitForSpaBootstrap();
  await _rclog('SPA ready — trying sidebar');
  let sidebarOk = false;
  try {
    await navigateViaFkSidebar('Reports');
    await sleep(4000);
    if (isOnReportsCentrePage()) { sidebarOk = true; await _rclog('sidebar nav OK'); }
    else await _rclog('sidebar nav done but hash not RC');
  } catch (e) {
    await _rclog(`sidebar Reports failed: ${e.message}`);
    console.warn(`[Rumee/BulkFK] Sidebar Reports failed: ${e.message}`);
  }
  if (!sidebarOk) {
    await _rclog('hash nav fallback → #dashboard/metrics/report-centre');
    window.postMessage({ __rumeeNavigateHash: '#dashboard/metrics/report-centre' }, '*');
    await sleep(8000);
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (isOnReportsCentrePage()) {
      await _rclog('on RC page — setting query params');
      const reqQuery = encodeURIComponent(JSON.stringify({
        one_time_request:  { reportGroup: null, reportName: null, enable: true, status: null },
        repeat_request:    { repeat_report_group_name: null, repeat_report_name: null, repeat_enable: false },
        pagination:        { page_size: 10, starting_page: 1 },
        request_report:    { create_request: false, report_type: null, report_subtype: null, repeat_report: false }
      }));
      window.location.hash = `#dashboard/metrics/report-centre?query=${reqQuery}`;
      await sleep(2500);
      await _rclog('RC ready');
      return;
    }
    await sleep(1000);
  }
  await _rclog('FAILED — RC page never reached');
  throw new Error('FK_BULK_REPORTS: Could not navigate to Reports Centre');
}

async function clickTabIfNeeded(texts) {
  const tab = findEl(texts, '[role="tab"], li, button, a');
  if (tab) {
    const isActive = tab.getAttribute('aria-selected') === 'true'
      || tab.classList.contains('active') || tab.classList.contains('selected');
    if (!isActive) { await clickAndWait(tab, 2000); }
  }
}

async function fkViewsClickDay(jobId, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const mName = MONTHS[m - 1];
  const mAbr  = mName.slice(0, 3);
  let cell = document.querySelector(`[aria-label="${mName} ${d}, ${y}"], [aria-label="${d} ${mName} ${y}"], [data-date="${isoDate}"]`);
  if (!(cell && cell.offsetParent)) {
    const dayCells = Array.from(document.querySelectorAll('td, [role="gridcell"], [role="cell"], [class*="day"], [class*="date"]'))
      .filter(el => el.offsetParent && el.textContent.trim() === String(d));
    const monthRx = /^[A-Z][a-z]{2,8}\s+\d{4}$/;
    const headerCandidates = Array.from(document.querySelectorAll('*')).filter(el => {
      const t = (el.innerText || '').trim();
      return (t === `${mName} ${y}` || t === `${mAbr} ${y}`) && el.offsetParent;
    });
    for (const header of headerCandidates) {
      let container = header.parentElement;
      for (let i = 0; i < 8 && container && !cell; i++) {
        const cellsInside = Array.from(container.querySelectorAll('td, [role="gridcell"], [role="cell"]'))
          .filter(el => el.offsetParent && (el.innerText || el.textContent || '').trim() === String(d));
        if (cellsInside.length) {
          const monthsInside = Array.from(container.querySelectorAll('*'))
            .filter(el => el.children.length === 0 && monthRx.test((el.innerText || '').trim()))
            .map(el => el.innerText.trim()).filter((t, idx, arr) => arr.indexOf(t) === idx);
          if (monthsInside.length <= 1) cell = cellsInside[0];
          break;
        }
        container = container.parentElement;
      }
      if (cell) break;
    }
    if (!cell) {
      const now = new Date();
      const isCurrentMonth = (now.getFullYear() === y && now.getMonth() === m - 1);
      cell = isCurrentMonth ? dayCells[dayCells.length - 1] : dayCells[0];
    }
  }
  if (!cell) return false;
  cell.click();
  await sleep(600);
  return true;
}

async function fkViewsSelectRange(job, fromISO, toISO) {
  const vlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `BulkViews: ${txt}` });
  await sleep(4000);
  await dismissFkPopups();
  await waitForSpaBootstrap();
  const cleanHash = 'dashboard/growth/seller-insights?businessVertical=ALL&section=purchase_funnel&selectedPeriod=latest&activeMetric=impression&activeProductType=ALL';
  window.location.hash = cleanHash;
  await sleep(6000);
  if (!window.location.hash.includes('seller-insights')) {
    vlog('hash nav failed — trying sidebar');
    try { await navigateViaFkSidebar('Growth', 'Seller Insights'); } catch (_) {}
    await sleep(4000);
  }
  await clickTabIfNeeded(['Traffic Report', 'traffic report']);
  await sleep(2000);
  const customBtn = findBtn('Custom Dates') || findBtn('Custom Date')
    || findEl(['Custom Dates', 'Custom Date'], 'button, li, [role="button"], div');
  if (!customBtn) { debugPage('bulk-views-no-custom', job.id); throw new Error('FK_BULK_VIEWS: Custom Dates button not found'); }
  await clickAndWait(customBtn, 1500);
  if (!(await fkViewsClickDay(job.id, fromISO))) { debugPage('bulk-views-no-from-day', job.id); throw new Error(`FK_BULK_VIEWS: calendar day ${fromISO} not found`); }
  if (!(await fkViewsClickDay(job.id, toISO)))   { debugPage('bulk-views-no-to-day',   job.id); throw new Error(`FK_BULK_VIEWS: calendar day ${toISO} not found`); }
  const doneBtn = findBtn('Done') || findBtn('Apply');
  if (doneBtn) await clickAndWait(doneBtn, 3000);
  await sleep(3000);
  const requestBtn   = findBtn('Request Listings Report') || findBtn('Request Listing Report');
  const generatingEl = findEl(['Generating Report', 'Generating'], 'button, [role="button"], div, span');
  const generating   = !!(generatingEl && generatingEl.offsetParent);
  const downloadBtn  = findBtn('Download Listings Report') || findBtn('Download Listing Report') || findBtn('Download Report');
  vlog(`range ${fromISO}→${toISO} STATE: request=${!!requestBtn} generating=${generating} download=${!!downloadBtn}`);
  return { requestBtn, generating, downloadBtn };
}

function findReportRowDownloadBtn(subType, expectedDate, jobId = 'bulk_fk_report') {
  const subLow = subType.toLowerCase();
  const MONTHS_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const buildFmts = (isoDate) => {
    const [y, m, d] = isoDate.split('-').map(Number);
    return [
      `${MONTHS_ABR[m-1]} ${d} ${y}`, `${MONTHS_ABR[m-1]} ${String(d).padStart(2,'0')} ${y}`,
      `${MONTHS_ABR[m-1]} ${d}, ${y}`, `${d} ${MONTHS_ABR[m-1]} ${y}`, isoDate,
    ];
  };
  const dateFmts = expectedDate ? buildFmts(expectedDate) : [];
  const rows = Array.from(document.querySelectorAll('table tr, [role="row"], .report-row'));
  let foundInProgress = false;
  for (const row of rows) {
    const rowText = row.textContent || '';
    const rowLow  = rowText.toLowerCase();
    if (!rowLow.includes(subLow)) continue;
    if (dateFmts.length > 0) {
      const afterTo = rowText.includes(' To ') ? rowText.split(' To ')[1].trimStart() : rowText;
      const hasDate = dateFmts.some(fmt => afterTo.startsWith(fmt));
      if (!hasDate) continue;
    }
    const isInProgress = rowLow.includes('in progress') || rowLow.includes('processing')
      || rowLow.includes('queued') || rowLow.includes('eta:');
    const isGenerated  = rowLow.includes('generated') || rowLow.includes('completed') || rowLow.includes('available');
    if (isInProgress) { foundInProgress = true; continue; }
    const dlBtn = Array.from(row.querySelectorAll('button, a, [role="button"]'))
      .find(el => {
        if (!el.offsetParent) return false;
        const t = el.textContent.trim().toLowerCase();
        const href = (el.href || '').toLowerCase();
        return t.includes('download') || href.includes('download') || looksLikeDownload(el.href);
      });
    if (dlBtn && isGenerated) return { btn: dlBtn, status: 'ready' };
  }
  return { btn: null, status: foundInProgress ? 'in_progress' : 'not_found' };
}

function isOnClaimsPage() {
  const body = document.body.innerText || '';
  return body.includes('SPF Claims')
    || (body.includes('Raised by You') && body.includes('Auto Approved'))
    || (body.includes('Download Report') && body.includes('Claim ID'));
}

async function fillDateRange(fromISO, toISO) {
  const dateInputs = Array.from(document.querySelectorAll('input[type="date"]'));
  if (dateInputs.length >= 2) {
    setValue(dateInputs[0], fromISO); await sleep(300);
    setValue(dateInputs[1], toISO);
    return;
  }
  const ddmmyyyy = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
  const textInputs = Array.from(document.querySelectorAll(
    'input[placeholder*="From" i], input[placeholder*="To" i], ' +
    'input[placeholder*="Start" i], input[placeholder*="End" i], ' +
    'input[placeholder*="DD" i], input[placeholder*="date" i]'
  ));
  if (textInputs.length >= 2) {
    setValue(textInputs[0], ddmmyyyy(fromISO)); await sleep(300);
    setValue(textInputs[1], ddmmyyyy(toISO));
    return;
  }
  const clickCalDate = async (isoDate) => {
    const [y, m, d] = isoDate.split('-').map(Number);
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const mName = MONTHS[m - 1];
    const label1 = `${mName} ${d}, ${y}`;
    const label2 = `${d} ${mName} ${y}`;
    let cell = document.querySelector(`[aria-label="${label1}"], [aria-label="${label2}"], [data-date="${isoDate}"]`);
    if (cell && cell.offsetParent) { cell.click(); await sleep(300); return true; }
    const dayCells = Array.from(document.querySelectorAll('td, [role="gridcell"], [role="cell"], [class*="day"], [class*="date"]'))
      .filter(el => el.offsetParent && el.textContent.trim() === String(d));
    const correct = dayCells.find(el => {
      let anc = el.parentElement;
      for (let i = 0; i < 6 && anc; i++) {
        if (anc.textContent.includes(mName)) return true;
        anc = anc.parentElement;
      }
      return false;
    }) || dayCells[0];
    if (correct) { correct.click(); await sleep(300); return true; }
    return false;
  };
  await clickCalDate(fromISO);
  await sleep(400);
  await clickCalDate(toISO);
}

function setValue(input, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeInputValueSetter) nativeInputValueSetter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// ─── Download helper (adapted from _downloadFkReport) ─────────────────────────

async function _downloadBulkFkReport(job, dlBtn, filename, signalDone = true, useLayer2 = false) {
  console.log(`[Rumee/BulkFK] Downloading ${job.id} as ${filename} (layer=${useLayer2 ? 2 : 1})`);
  if (useLayer2) {
    if (_bulkCurrentJob) _bulkCurrentJob.filename = filename;
    window.__rumeeCapturingBlob = true;
    window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: true }, '*');
    _bulkHandlingDownloadInContentScript = true;
    await clickAndWait(dlBtn, 300);
    _bulkHandlingDownloadInContentScript = false;

    const _capturedJobId = job.id;
    await new Promise(resolve => {
      let _settled = false;
      const _blobWatcher = ev => {
        if (!ev.data?.__rumeeBlob || _settled) return;
        _settled = true; clearTimeout(_timer);
        window.removeEventListener('message', _blobWatcher);
        resolve();
      };
      window.addEventListener('message', _blobWatcher);
      const _timer = setTimeout(() => {
        if (_settled) return; _settled = true;
        window.removeEventListener('message', _blobWatcher);
        window.__rumeeCapturingBlob = false;
        window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: false }, '*');
        _bulkCurrentJob = null;
        chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: _capturedJobId,
          error: `Layer2 blob timeout: FK did not produce a download within 45s` });
        resolve();
      }, 45000);
    });
    return;
  }

  _bulkHandlingDownloadInContentScript = true;
  const capturePromise = interceptNextDownload(TIMEOUT_MS);
  await clickAndWait(dlBtn, 300);
  let captured;
  try { captured = await capturePromise; }
  finally { _bulkHandlingDownloadInContentScript = false; _bulkCurrentJob = job; }

  const resp = await fetch(captured.url, { credentials: 'include', headers: captured.headers || {} });
  if (!resp.ok) throw new Error(`FK bulk fetch failed: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = ''; const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  await new Promise(res => chrome.runtime.sendMessage({
    type: signalDone ? 'BULK_UPLOAD_DATA' : 'BULK_UPLOAD_DATA_SILENT',
    jobId: job.id, data: btoa(binary), encoding: 'base64',
    filename, folderKey: job.folderKey, mimeType: job.mimeType,
  }, res));
}

// ─── requestNewBulkFkReport (adapted from requestNewFkReport) ─────────────────
// fromDate → toDate range for calendar. If fromDate==toDate, shifts start back 1 day.

async function requestNewBulkFkReport(cfg, fromDate, toDate, jobId = 'bulk_fk_report') {
  const _log = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId, text: t });

  const reqBtn = findEl(['Request New Report'], 'button, [role="button"]') || findBtn('Request New Report');
  if (!reqBtn) throw new Error(`FK_BULK_RC: "Request New Report" button not found for ${cfg.requestSubType}`);
  await clickAndWait(reqBtn, 2500);
  await _log('Opened Request New Report modal');
  await sleep(3000);

  const modalRoot = Array.from(document.querySelectorAll('*')).find(el => {
    const t = el.innerText || '';
    return t.includes('Payment Reports') && t.includes('Fulfilment Reports') && t.includes('Tax Reports')
      && !t.includes('Requested Type') && !t.includes('One Time') && t.length < 800
      && el !== document.body && el !== document.documentElement;
  });
  const searchRoot = modalRoot || document;
  const typeTab = Array.from(searchRoot.querySelectorAll('*'))
    .find(el => (el.innerText || '').trim() === cfg.requestType && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE')
    || Array.from(searchRoot.querySelectorAll('*'))
      .find(el => el.children.length === 0 && el.textContent.trim() === cfg.requestType);
  if (!typeTab) throw new Error(`FK_BULK_RC: type tab "${cfg.requestType}" not found`);
  typeTab.click();
  await sleep(4000);

  let reqReportBtn = null;
  for (let attempt = 0; attempt < 5 && !reqReportBtn; attempt++) {
    if (attempt > 0) await sleep(2000);
    const allSections = Array.from(document.querySelectorAll('*'))
      .filter(el => el.children.length === 0 && el.textContent.trim().toLowerCase() === cfg.requestSubType.toLowerCase());
    for (const sec of allSections) {
      let parent = sec.parentElement;
      for (let i = 0; i < 8 && parent; i++) {
        const btn = Array.from(parent.querySelectorAll('*'))
          .find(el => /request\s*report/i.test(el.textContent.trim()) && el.textContent.trim().length < 30 && el.children.length === 0);
        if (btn) { reqReportBtn = btn; break; }
        parent = parent.parentElement;
      }
      if (reqReportBtn) break;
    }
  }
  if (!reqReportBtn) throw new Error(`FK_BULK_RC: "${cfg.requestSubType}" section not found in modal`);
  await clickAndWait(reqReportBtn, 2000);

  // Step D: open date picker and click "custom" chip
  const [ty, tm, td] = toDate.split('-').map(Number);
  const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MONTHS_ABR  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const targetMonthText1 = `${MONTHS_FULL[tm-1]} ${ty}`;
  const targetMonthText2 = `${MONTHS_ABR[tm-1]} ${ty}`;
  const findMonthHeader = () => Array.from(document.querySelectorAll('*'))
    .find(el => { const t = (el.innerText||'').trim(); return (t === targetMonthText1 || t === targetMonthText2) && el.offsetParent; });

  let dateRangeClicked = false;
  let dateInputEl = null;
  for (let w = 0; w < 8 && !dateRangeClicked; w++) {
    await sleep(1000);
    const selectDateLabel = Array.from(document.querySelectorAll('*'))
      .find(el => el.children.length === 0 && /select\s*date\s*range/i.test((el.innerText||el.textContent||'').trim()));
    if (selectDateLabel) {
      let parent = selectDateLabel.parentElement;
      let clickTarget = null;
      for (let i = 0; i < 5 && parent; i++) {
        clickTarget = parent.querySelector('input[type="text"], input:not([type="hidden"])')
          || parent.querySelector('svg, [class*="calendar"], [class*="Calendar"]')
          || null;
        if (clickTarget) break;
        parent = parent.parentElement;
      }
      if (!clickTarget) clickTarget = selectDateLabel.parentElement;
      if (clickTarget) { dateInputEl = clickTarget; clickTarget.click(); await sleep(1500); dateRangeClicked = true; }
    } else {
      const fallbackInput = Array.from(document.querySelectorAll('input, [role="combobox"], [class*="DatePicker"]')).find(el => el.offsetParent);
      if (fallbackInput) { fallbackInput.click(); await sleep(1500); dateRangeClicked = true; }
    }
  }

  let customChip = null;
  for (let attempt = 0; attempt < 15 && !customChip; attempt++) {
    await sleep(600);
    customChip = Array.from(document.querySelectorAll('button, span, div, li, a, [role="option"]'))
      .find(el => /^custom$/i.test((el.innerText||el.textContent||'').trim()) && el.offsetParent);
    if (!customChip) customChip = Array.from(document.querySelectorAll('button, span, li, a'))
      .find(el => /^custom$/i.test((el.innerText||el.textContent||'').trim()));
    if (!customChip && attempt % 3 === 2) {
      const retry = dateInputEl || null;
      if (retry) { retry.click(); await sleep(500); }
    }
  }
  if (customChip) {
    customChip.click();
    for (let w = 0; w < 12 && !findMonthHeader(); w++) {
      await sleep(600);
      if (w === 5) customChip.click();
    }
  }

  // Navigate calendar to toDate's month
  if (!findMonthHeader()) {
    for (let navAttempt = 0; navAttempt < 12; navAttempt++) {
      if (findMonthHeader()) break;
      const navBtn = Array.from(document.querySelectorAll('button, [role="button"], span'))
        .find(el => el.offsetParent && (
          /next\s*month|next/i.test(el.getAttribute('aria-label')||'') ||
          ['>','›','▶','→'].includes((el.textContent||'').trim())
        ));
      if (navBtn) { navBtn.click(); await sleep(400); } else break;
    }
  }

  // Step E: find toDate's cell (endCell)
  let calCell = null;
  const monthHeader = findMonthHeader();
  if (monthHeader) {
    let container = monthHeader.parentElement;
    for (let i = 0; i < 8 && container && !calCell; i++) {
      calCell = Array.from(container.querySelectorAll('td, [role="gridcell"], [role="cell"], button, div, span'))
        .find(el => { const txt = (el.innerText||el.textContent||'').trim(); return txt === String(td) && !el.querySelector('td, [role="gridcell"]'); });
      container = container.parentElement;
    }
  }
  if (!calCell) {
    calCell = document.querySelector(`[aria-label="${MONTHS_FULL[tm-1]} ${td}, ${ty}"], [data-date="${toDate}"]`);
  }
  if (!calCell) {
    calCell = Array.from(document.querySelectorAll('td, [role="gridcell"]')).find(el => (el.innerText||el.textContent||'').trim() === String(td));
  }
  if (!calCell) throw new Error(`FK_BULK_RC: cannot find date cell for ${toDate}`);

  // Determine startCell
  const findDayCell = (dayNum, mFull, mAbr) => {
    const header = Array.from(document.querySelectorAll('*')).find(el => {
      const t = (el.innerText||'').trim(); return (t === mFull || t === mAbr) && el.offsetParent;
    });
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

  let startCell;
  if (fromDate < toDate) {
    const [fy, fm, fd] = fromDate.split('-').map(Number);
    startCell = findDayCell(fd, `${MONTHS_FULL[fm-1]} ${fy}`, `${MONTHS_ABR[fm-1]} ${fy}`) || calCell;
    await _log(`Step E: multi-day range ${fromDate}→${toDate}, startCell for ${fd}`);
  } else {
    const startObj = new Date(ty, tm - 1, td - 1);
    const sD = startObj.getDate(), sM = startObj.getMonth() + 1, sY = startObj.getFullYear();
    startCell = findDayCell(sD, `${MONTHS_FULL[sM-1]} ${sY}`, `${MONTHS_ABR[sM-1]} ${sY}`) || calCell;
    await _log(`Step E: single day — shifted start to ${sY}-${sM}-${sD}`);
  }

  await clickAndWait(startCell, 900 + Math.floor(Math.random() * 700));
  await sleep(450 + Math.floor(Math.random() * 550));
  const endCell = findDayCell(td, targetMonthText1, targetMonthText2) || calCell;
  await clickAndWait(endCell, 800 + Math.floor(Math.random() * 600));
  await _log(`Step E: clicked range — done`);

  // Step F: Submit
  await sleep(1200 + Math.floor(Math.random() * 900));
  let submitBtn = Array.from(document.querySelectorAll('button'))
    .find(el => el.offsetParent && /submit/i.test(el.textContent.trim()));
  if (!submitBtn) submitBtn = Array.from(document.querySelectorAll('button'))
    .find(el => /submit/i.test(el.textContent.trim()));
  if (!submitBtn) throw new Error(`FK_BULK_RC: SUBMIT button not found for "${cfg.requestSubType}"`);
  await sleep(600 + Math.floor(Math.random() * 700));
  await clickAndWait(submitBtn, 500);

  let confirmed = false;
  for (let w = 0; w < 30; w++) {
    await sleep(500);
    const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase();
    if (bodyText.includes('requested successfully') || bodyText.includes('report is requested')) { confirmed = true; break; }
  }
  if (!confirmed) {
    const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase();
    if (bodyText.includes('already been requested') || bodyText.includes('already requested'))
      throw new Error(`FK_BULK_RC: duplicate request blocked — "${cfg.requestSubType}" already requested`);
    throw new Error(`FK_BULK_RC: SUBMIT clicked but success banner never appeared`);
  }
  await _log(`✓ Request confirmed: "${cfg.requestSubType}" for ${fromDate}→${toDate}`);
}

// ─── Job handlers ─────────────────────────────────────────────────────────────

async function handleBulkFkReportsCentre(job) {
  const _log = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `RC: ${t}` }).catch(() => {});
  await _log(`entry: ${job.targetFromDate}→${job.targetToDate}`);
  await dismissFkPopups();
  const cfg = REPORTS_CENTRE_CFG[job.id];
  if (!cfg) throw new Error(`no REPORTS_CENTRE_CFG for ${job.id}`);

  await ensureOnReportsCentre(true);
  await sleep(2000);

  if (!cfg.skipCategoryTab && cfg.categoryTab) {
    const catTabEl = findEl([cfg.categoryTab], '[role="tab"]') || findEl([cfg.categoryTab], 'button');
    if (catTabEl) { await _log(`clicking category tab: ${cfg.categoryTab}`); await clickAndWait(catTabEl, 2500); }
    else await _log(`category tab "${cfg.categoryTab}" not found`);
  }

  const fromDate = job.targetFromDate;
  const toDate   = job.targetToDate;
  const requestedKey = `bulk_${job.id}_req_${fromDate}_${toDate}`;

  const { btn: downloadBtn, status: phaseAStatus } = findReportRowDownloadBtn(cfg.subType, toDate, job.id);
  await _log(`phaseA: subType=${cfg.subType} status=${phaseAStatus} dlBtn=${!!downloadBtn}`);

  if (!downloadBtn && cfg.requestType && phaseAStatus !== 'in_progress') {
    const stored = await getStorage([requestedKey]);
    const alreadyRequested = stored[requestedKey] === toDate;
    if (alreadyRequested) {
      await _log(`already requested ${job.id} for ${toDate} — skipping`);
      console.log(`[Rumee/BulkFK] Already requested ${job.id} for ${toDate}`);
    } else {
      await _log(`requesting new report for ${cfg.requestSubType}`);
      await requestNewBulkFkReport(cfg, fromDate, toDate, job.id);
      await new Promise(res => chrome.storage.local.set({ [requestedKey]: toDate }, res));
      await _log(`request submitted and stored`);
    }
  } else if (phaseAStatus === 'in_progress') {
    await _log(`report in_progress — skipping request (fk_rc_download will retry)`);
  }

  // requestOnly=true for all 3: fk_rc_download handles the actual download
  await _log('done — signalling BULK_JOB_DONE');
  chrome.runtime.sendMessage({ type: 'BULK_JOB_DONE', jobId: job.id });
}

async function handleBulkFkRCDownload(job) {
  await dismissFkPopups();
  const toDate = job.targetToDate;
  const fromDate = job.targetFromDate;
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `Bulk RC download for ${fromDate}→${toDate}` });

  await ensureOnReportsCentre(true);
  await sleep(2000);

  const downloaded = [];
  const pending = [];

  for (const jobId of BULK_FK_RC_JOBS) {
    const pJob = JOBS.find(j => j.id === jobId);
    const pCfg = REPORTS_CENTRE_CFG[jobId];
    const { btn, status } = findReportRowDownloadBtn(pCfg.subType, toDate, jobId);

    if (btn) {
      const filename = makeDatedFilename(pJob, fromDate, toDate);
      await _downloadBulkFkReport(pJob, btn, filename, false);
      downloaded.push(jobId);
    } else {
      pending.push({ jobId, status });
    }
  }

  if (pending.length === 0) {
    chrome.runtime.sendMessage({ type: 'BULK_JOB_DONE', jobId: job.id });
    return;
  }

  const { bulk_fk_rc_recheck_count = 0 } = await getStorage(['bulk_fk_rc_recheck_count']);
  const pendingNames = pending.map(p => p.jobId.replace('fk_', '').toUpperCase()).join(', ');

  if (bulk_fk_rc_recheck_count >= BULK_FK_RC_MAX_RECHECKS) {
    await chrome.storage.local.remove(['bulk_fk_rc_recheck_count']);
    chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id,
      text: `Bulk RC: ${pendingNames} not ready after ${BULK_FK_RC_MAX_RECHECKS} rechecks` });
    chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: job.id,
      error: `FK RC reports (${pendingNames}) still not ready after ${BULK_FK_RC_MAX_RECHECKS} rechecks` });
    return;
  }

  const nextCount = bulk_fk_rc_recheck_count + 1;
  await chrome.storage.local.set({ bulk_fk_rc_recheck_count: nextCount });
  chrome.runtime.sendMessage({ type: 'BULK_SCHEDULE_FK_RC_RECHECK', delayMinutes: 60 });
  chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id,
    text: `Bulk RC: scheduled recheck ${nextCount}/${BULK_FK_RC_MAX_RECHECKS} in 60 min for ${pendingNames}` });
  chrome.runtime.sendMessage({ type: 'BULK_JOB_DONE', jobId: job.id });
}

async function handleBulkFkAds(job) {
  const _log = t => { chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: t }); return Promise.resolve(); };

  try {
    await _log(`BulkAds: entry job=${job.id} url=${window.location.href.slice(0,80)}`);
    await sleep(5000);
    await dismissFkPopups();
    await waitForSpaBootstrap();

    // No campaign cache gate in bulk — proceed directly

    // Step 1: Verify on Other Reports
    const _fromISO = job.targetFromDate;
    const _toISO   = job.targetToDate;
    await sleep(6000);
    await waitForSpaBootstrap();
    await dismissFkPopups();

    const onOtherReports = () =>
      document.body.innerText.includes('Ad Product') && document.body.innerText.includes('Report Type');

    if (!onOtherReports()) {
      await _log('BulkAds: not on Other Reports — trying sidebar + hash nav');
      try { await navigateViaFkSidebar('Ads', 'Reports'); } catch(e) { await _log(`sidebar: ${e.message}`); }
      await sleep(3000);
      await clickTabIfNeeded(['Other Reports', 'other reports']);
      if (!onOtherReports()) {
        window.location.hash = `#dashboard/ads/reports/others?duration=${_fromISO}_${_toISO}`;
        await sleep(3000);
      }
    }
    await clickTabIfNeeded(['Other Reports', 'other reports']);

    // Step 2+3: Select Ad Product = PLA, Report Type
    const _pickDropdown = async (labelText, targetText, stepLabel) => {
      await _log(`${stepLabel}: label="${labelText}" → "${targetText}"`);
      const allVisible = () => Array.from(document.querySelectorAll('div,span,label,p,li,td,th')).filter(el => el.offsetParent !== null);
      const labelEl = allVisible().find(el => el.children.length === 0 && (el.textContent||'').trim() === labelText)
        || allVisible().find(el => el.children.length <= 1 && (el.textContent||'').trim() === labelText);
      if (!labelEl) { await _log(`${stepLabel}: label not found`); return false; }

      let triggerContainer = null;
      let parent = labelEl;
      for (let depth = 0; depth < 12 && parent && parent !== document.body; depth++) {
        parent = parent.parentElement;
        if (!parent) break;
        const siblings = Array.from(parent.children).filter(el => {
          if (!el.offsetParent || el === labelEl || (el.textContent||'').trim() === labelText) return false;
          const rect = el.getBoundingClientRect();
          return rect.height > 0 && rect.width > 0;
        });
        if (siblings.length >= 1 && parent.children.length <= 5) { triggerContainer = siblings[0]; break; }
      }
      if (!triggerContainer) { await _log(`${stepLabel}: no trigger container`); return false; }

      const clickTarget = triggerContainer.querySelector(
        '[role="combobox"], [role="listbox"], [tabindex="0"], [class*="control"], [class*="select"]'
      ) || triggerContainer.children[0] || triggerContainer;

      const preClickWithText = new Set(
        Array.from(document.querySelectorAll('*'))
          .filter(el => el.offsetParent !== null && (el.textContent||'').trim() === targetText && el.getBoundingClientRect().height > 0)
      );
      clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      clickTarget.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
      await sleep(1200);

      let opts = Array.from(document.querySelectorAll('*')).filter(el => {
        if (!el.offsetParent || preClickWithText.has(el)) return false;
        return el.getBoundingClientRect().height > 0 && (el.textContent||'').trim() === targetText;
      });
      if (opts.length === 0) { await sleep(600); opts = Array.from(document.querySelectorAll('*')).filter(el => !el.offsetParent ? false : !preClickWithText.has(el) && el.getBoundingClientRect().height > 0 && (el.textContent||'').trim() === targetText); }

      const opt = opts.find(el => (el.textContent||'').trim() === targetText);
      if (opt) { opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(800); await _log(`${stepLabel}: selected "${targetText}" ✓`); return true; }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await _log(`${stepLabel}: option not found`);
      return false;
    };

    await _pickDropdown('Ad Product', 'PLA', 'Step2');
    await sleep(500);
    await _pickDropdown('Report Type', job.adsReportType, 'Step3');
    await sleep(2500);

    // Step 4: ALWAYS use Custom date path for bulk
    const _MONTHS_3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const [_fY, _fMon, _fDay] = _fromISO.split('-');
    const [_tY, _tMon, _tDay] = _toISO.split('-');
    const _fromFKFmt = `${parseInt(_fDay)}-${_MONTHS_3[parseInt(_fMon)-1]}-${_fY}`;
    const _toFKFmt   = `${parseInt(_tDay)}-${_MONTHS_3[parseInt(_tMon)-1]}-${_tY}`;

    await _log(`Step4: looking for date trigger — from=${_fromFKFmt} to=${_toFKFmt}`);
    const _findDateTrigger = () => {
      const dateRx = /\d{1,2}-[A-Za-z]{3}-\d{2,4}/;
      const presetRx = /yesterday|today|last \d+ days/i;
      const allVis = Array.from(document.querySelectorAll('*')).filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 0);
      const textEl = allVis.find(el => {
        const txt = (el.textContent||'').trim();
        return el.children.length === 0 && txt.length >= 6 && txt.length < 80 && (dateRx.test(txt) || presetRx.test(txt));
      }) || allVis.find(el => {
        const txt = (el.textContent||'').trim();
        return el.children.length <= 2 && txt.length < 80 && (dateRx.test(txt) || presetRx.test(txt));
      });
      if (!textEl) return null;
      let el = textEl;
      for (let i = 0; i < 20 && el && el !== document.body; i++) {
        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || window.getComputedStyle(el).cursor === 'pointer') return el;
        el = el.parentElement;
      }
      return textEl;
    };

    const _dateTrigger = _findDateTrigger();
    if (_dateTrigger) {
      _dateTrigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      _dateTrigger.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
      await sleep(1200);

      // Click "Custom" option
      const _customEl = Array.from(document.querySelectorAll('*'))
        .find(el => el.offsetParent && /^custom$/i.test((el.textContent||'').trim()) && el.getBoundingClientRect().height > 0);
      if (_customEl) {
        _customEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        _customEl.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
        await sleep(1500);

        // Set input values to fromDate and toDate
        const _dateInputEls = Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent);
        if (_dateInputEls.length >= 1) {
          const _nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          const _setReactInput = (inp, val) => {
            inp.focus(); _nativeSetter.call(inp, val);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          };
          _setReactInput(_dateInputEls[0], _fromFKFmt);
          await sleep(400);
          if (_dateInputEls.length >= 2) {
            _setReactInput(_dateInputEls[_dateInputEls.length - 1], _toFKFmt);
            await sleep(400);
          }
          await _log(`Step4: set inputs to ${_fromFKFmt} → ${_toFKFmt}`);
        }

        const _applyBtn = Array.from(document.querySelectorAll('button,[role="button"]'))
          .find(el => el.offsetParent && /^(apply|ok|done|set|submit)$/i.test((el.textContent||'').trim()));
        if (_applyBtn) { _applyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(800); await _log('Step4: Apply clicked ✓'); }
        else { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
      } else {
        await _log('Step4: Custom option not found');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    } else {
      await _log('Step4: date trigger not found');
    }

    await sleep(500);

    // Step 6: Download (no fk_ads_overall per-campaign loop in bulk — single download)
    const _adsFormRoot = (() => {
      const adProdLabel = Array.from(document.querySelectorAll('*'))
        .find(el => el.offsetParent && (el.textContent||'').trim() === 'Ad Product' && el.children.length === 0);
      if (!adProdLabel) return document.body;
      let el = adProdLabel.parentElement;
      for (let i = 0; i < 12 && el && el !== document.body; i++) {
        const r = el.getBoundingClientRect();
        if (r.width > 400 && r.height > 200) return el;
        el = el.parentElement;
      }
      return document.body;
    })();

    const _findDlBtn = (text) => {
      const t = text.toLowerCase();
      return Array.from(_adsFormRoot.querySelectorAll('button, [role="button"], [role="tab"], a'))
        .find(el => el.offsetParent && (el.textContent||'').trim().toLowerCase().includes(t)) || null;
    };
    const dlBtn = _findDlBtn('Download') || _findDlBtn('Get Report') || _findDlBtn('Generate Report');
    if (!dlBtn) { debugPage(`bulk-ads-no-download-${job.id}`, job.id); throw new Error(`Bulk ads Download button not found for ${job.id}`); }

    const filename = makeDatedFilename(job, _fromISO, _toISO);
    await _log(`Step6: downloading as ${filename}`);
    await _downloadBulkFkReport(job, dlBtn, filename, true, true);
  } catch (err) {
    await chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `BulkAds ERROR: ${err.message}` });
    chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: job.id, error: err.message || String(err) });
  }
}

async function handleBulkFkViewsRequest(job) {
  const vlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `BulkViews: ${txt}` });
  const from = job.targetFromDate;
  const to   = job.targetToDate;

  await new Promise(res => chrome.storage.local.set({ bulk_fk_views_range: { from, to } }, res));
  vlog(`requesting range ${from} → ${to}`);

  const state = await fkViewsSelectRange(job, from, to);
  if (state.downloadBtn) {
    vlog('already generated — fk_views download will fetch it');
  } else if (state.generating) {
    vlog('already generating');
  } else if (state.requestBtn) {
    await clickAndWait(state.requestBtn, 4000);
    vlog('request submitted');
  } else {
    debugPage('bulk-views-request-unknown-state', job.id);
    throw new Error('FK_BULK_VIEWS request: no Request/Generating/Download state found');
  }
  chrome.runtime.sendMessage({ type: 'BULK_JOB_DONE', jobId: job.id });
}

async function handleBulkFkViewsDownload(job) {
  const vlog = txt => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `BulkViews: ${txt}` });

  const { bulk_fk_views_range } = await getStorage(['bulk_fk_views_range']);
  const from = (bulk_fk_views_range && bulk_fk_views_range.from) || job.targetFromDate;
  const to   = (bulk_fk_views_range && bulk_fk_views_range.to)   || job.targetToDate;
  vlog(`checking range ${from} → ${to}`);

  const state = await fkViewsSelectRange(job, from, to);

  if (state.downloadBtn) {
    vlog('READY — downloading');
    _bulkHandlingDownloadInContentScript = true;
    const capturePromise = interceptNextDownload(TIMEOUT_MS);
    await clickAndWait(state.downloadBtn, 300);
    let captured;
    try { captured = await capturePromise; }
    finally { _bulkHandlingDownloadInContentScript = false; _bulkCurrentJob = job; }

    const datedFilename = makeDatedFilename(job, from, to);
    const resp = await fetch(captured.url, { credentials: 'include', headers: captured.headers || {} });
    if (!resp.ok) throw new Error(`FK_BULK_VIEWS: fetch failed ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = ''; const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    await chrome.storage.local.remove(['bulk_fk_views_recheck_count']);
    vlog(`downloaded ${bytes.length} bytes as ${datedFilename}`);
    chrome.runtime.sendMessage({
      type: 'BULK_UPLOAD_DATA', jobId: job.id, data: btoa(binary), encoding: 'base64',
      filename: datedFilename, folderKey: job.folderKey, mimeType: job.mimeType,
    });
    return;
  }

  if (!state.generating && state.requestBtn) {
    vlog('request appears lost — re-requesting');
    await clickAndWait(state.requestBtn, 4000);
  }

  const { bulk_fk_views_recheck_count = 0 } = await getStorage(['bulk_fk_views_recheck_count']);
  if (bulk_fk_views_recheck_count >= BULK_FK_VIEWS_MAX_RECHECKS) {
    await chrome.storage.local.remove(['bulk_fk_views_recheck_count']);
    vlog(`NOT READY after ${BULK_FK_VIEWS_MAX_RECHECKS} rechecks — giving up`);
    chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: job.id,
      error: `FK Views (${from}→${to}) not generated after ${BULK_FK_VIEWS_MAX_RECHECKS} rechecks` });
    return;
  }

  const nextCount = bulk_fk_views_recheck_count + 1;
  await chrome.storage.local.set({ bulk_fk_views_recheck_count: nextCount });
  chrome.runtime.sendMessage({ type: 'BULK_SCHEDULE_FK_VIEWS_RECHECK', delayMinutes: 60 });
  vlog(`still generating — scheduled recheck ${nextCount}/${BULK_FK_VIEWS_MAX_RECHECKS} in 60 min`);
  chrome.runtime.sendMessage({ type: 'BULK_JOB_DONE', jobId: job.id });
}

async function handleBulkFkClaims(job) {
  await sleep(5000);
  await dismissFkPopups();

  if (!isOnClaimsPage()) {
    await waitForSpaBootstrap();
    window.location.hash = '#dashboard/payments/spf';
    await sleep(5000);
  }
  if (!isOnClaimsPage()) {
    try { await navigateViaFkSidebar('Payments', 'SPF Claims'); } catch (e) {
      try { await navigateViaFkSidebar('Payments'); } catch (_) {}
    }
    await sleep(3000);
  }
  if (!isOnClaimsPage()) throw new Error('FK_BULK_CLAIMS: could not reach SPF Claims page');

  const raisedByYouTab = findBtn('Raised by You') || findEl(['Raised by You'], '[role="tab"]');
  if (raisedByYouTab) await clickAndWait(raisedByYouTab, 1000);

  const dlReportBtn = findBtn('Download Report') || findEl(['Download Report', 'Download report'], 'button, [role="button"]');
  if (!dlReportBtn) throw new Error('FK_BULK_CLAIMS: "Download Report" button not found');
  await clickAndWait(dlReportBtn, 1500);

  const customRangeOpt = (() => {
    const exact = Array.from(document.querySelectorAll('li, a, button, [role="option"], span, div'))
      .find(el => el.offsetParent && el.textContent.trim() === 'Custom Date Range');
    if (exact) return exact;
    return findBtn('Custom Date Range') || findEl(['Custom Date Range'], 'li, [role="option"], a, button');
  })();
  if (!customRangeOpt) throw new Error('FK_BULK_CLAIMS: "Custom Date Range" not found');
  await clickAndWait(customRangeOpt, 1500);

  const fromDate = job.targetFromDate;
  const toDate   = job.targetToDate;

  await fillDateRange(fromDate, toDate);

  const doneBtn = findBtn('Done') || findBtn('Apply') || findBtn('Confirm')
    || Array.from(document.querySelectorAll('*')).find(el => el.offsetParent && el.textContent.trim() === 'Done');
  if (!doneBtn) throw new Error('FK_BULK_CLAIMS: "Done" button not found');

  _bulkHandlingDownloadInContentScript = true;
  const capturePromise = interceptNextDownload(TIMEOUT_MS);
  await clickAndWait(doneBtn, 300);
  let captured;
  try { captured = await capturePromise; }
  finally { _bulkHandlingDownloadInContentScript = false; _bulkCurrentJob = job; }

  const claimsFilename = makeDatedFilename(job, fromDate, toDate);
  const resp = await fetch(captured.url, { credentials: 'include', headers: captured.headers || {} });
  if (!resp.ok) throw new Error(`FK_BULK_CLAIMS: fetch failed ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = ''; const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  chrome.runtime.sendMessage({
    type: 'BULK_UPLOAD_DATA', jobId: job.id, data: btoa(binary), encoding: 'base64',
    filename: claimsFilename, folderKey: job.folderKey, mimeType: job.mimeType,
  });
}

// ─── Module-level relays ──────────────────────────────────────────────────────

// MAIN-world download intercept relay
window.addEventListener('message', (event) => {
  if (!event.data?.__rumeeDownload) return;
  if (!_bulkCurrentJob) return;
  if (_bulkHandlingDownloadInContentScript) return;
  const capturedJob = _bulkCurrentJob;
  _bulkCurrentJob = null;
  window.__rumeeIntercepting = false;
  const { url, headers } = event.data;
  console.log(`[Rumee/BulkFK] ✓ MAIN-world relay: ${url.slice(0, 160)}`);
  chrome.runtime.sendMessage({
    type: 'BULK_DOWNLOAD_URL_CAPTURED', jobId: capturedJob.id,
    url, headers: headers || {}, referer: window.location.href,
    filename: capturedJob.filename, folderKey: capturedJob.folderKey, mimeType: capturedJob.mimeType,
  });
});

// Blob relay
window.addEventListener('message', (event) => {
  if (!event.data?.__rumeeBlob) return;
  if (!window.__rumeeIntercepting && !window.__rumeeCapturingBlob) return;
  if (!_bulkCurrentJob) return;
  const capturedJob = _bulkCurrentJob;
  _bulkCurrentJob = null;
  window.__rumeeIntercepting = false;
  window.__rumeeCapturingBlob = false;
  const { base64, mimeType, size } = event.data;
  console.log(`[Rumee/BulkFK] ✓ blob relay: ${size} bytes → ${capturedJob.id}`);
  chrome.runtime.sendMessage({
    type: 'BULK_UPLOAD_DATA', jobId: capturedJob.id,
    data: base64, encoding: 'base64',
    filename: capturedJob.filename, folderKey: capturedJob.folderKey, mimeType: capturedJob.mimeType || mimeType,
  });
});

// CS_FETCH_AND_UPLOAD relay
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'BULK_CS_FETCH_AND_UPLOAD') return;
  const { jobId, url, filename, folderKey, mimeType } = msg;
  fetch(url, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
    .then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }))
    .then(dataBase64 => { chrome.runtime.sendMessage({ type: 'BULK_CS_UPLOAD_DONE', jobId, filename, folderKey, mimeType, dataBase64 }); })
    .catch(err => { chrome.runtime.sendMessage({ type: 'BULK_CS_UPLOAD_DONE', jobId, error: err.message }); });
  sendResponse({ ok: true });
  return true;
});

} // end __rumeeBulkFkInjected guard
