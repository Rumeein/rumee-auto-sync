// ─── Rumee — Bulk Meesho Content Script ──────────────────────────────────────
// Injected by background.js (bulk-handler.js) via chrome.scripting.executeScript
// when a bulk job tab finishes loading on Meesho. All message types are BULK_*.

if (!window.__rumeeBulkMeInjected) {
window.__rumeeBulkMeInjected = true;
'use strict';

// ─── Module-level state ───────────────────────────────────────────────────────
let _bulkCurrentJob = null;

// ─── Constants ────────────────────────────────────────────────────────────────
const SUPPLIER_SLUG_FALLBACK = 'xuptj';

const MEESHO_DOWNLOAD_PATTERNS = [
  /\/download/i, /\/export/i, /\.xlsx(\?|$)/i, /\.csv(\?|$)/i,
  /amazonaws\.com/i, /storage\.googleapis/i, /meesho.*download/i,
];

// URLs mirror content/meesho.js's JOB_PAGES exactly — bulk was pointing at the
// old /supplier/{slug}/... panel, which no longer serves these tabs, causing
// "tab not found" errors even though the daily-sync selectors are correct.
const JOB_PAGES_BULK = {
  me_orders: {
    urlKey:  '/orders',
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/fulfillment/${slug}/orders/`,
  },
  me_payments: {
    urlKey:  '/payments',
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/payouts/${slug}/payments`,
  },
  me_ads: {
    urlKey:  '/advertisement',
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/ads/${slug}/advertisement?tab=ALL`,
  },
  me_claims: {
    urlKey:  '/claims',
    pageUrl: slug => `https://supplier.meesho.com/panel/v3/new/fulfillment/${slug}/claims`,
  },
};

// ─── Handler registry ─────────────────────────────────────────────────────────
const HANDLERS_BULK_ME = {
  me_orders:   handleBulkMeOrders,
  me_payments: handleBulkMePayments,
  me_ads:      handleBulkMeAds,
  me_claims:   handleBulkMeClaims,
};

// ─── Entry point ──────────────────────────────────────────────────────────────

(async () => {
  const resp = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'BULK_CONTENT_READY' }, resolve);
  });
  const job = resp?.job || null;
  if (!job) { console.log('[Rumee/BulkMe] No bulk job — standing by'); return; }

  const isLoginPage = () => {
    const url = window.location.href;
    const body = document.body?.innerText || '';
    return url.includes('/login') || url.includes('/signin')
      || body.includes('Login to Meesho') || body.includes('Enter your phone');
  };
  if (isLoginPage()) {
    chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: job.id, error: 'Meesho login required — please log in and re-run bulk' });
    return;
  }

  _bulkCurrentJob = job;
  console.log(`[Rumee/BulkMe] ▶ job=${job.id} from=${job.targetFromDate} to=${job.targetToDate}`);

  const handler = HANDLERS_BULK_ME[job.id];
  if (!handler) {
    chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: job.id, error: `No bulk handler for "${job.id}"` });
    return;
  }
  try {
    await handler(job);
  } catch (err) {
    console.error(`[Rumee/BulkMe] ✖ ${job.id}:`, err);
    chrome.runtime.sendMessage({ type: 'BULK_JOB_ERROR', jobId: job.id, error: err.message || String(err) });
  }
})();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function setStorage(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function todayISO()     { return new Date().toISOString().slice(0, 10); }
function daysAgoISO(n)  { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function yesterdayISO() { return daysAgoISO(1); }
function addDays(isoDate, n) { const d = new Date(isoDate); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

function makeDatedFilename(job, fromDate, toDate) {
  const dotIdx = job.filename.lastIndexOf('.');
  const base   = job.filename.slice(0, dotIdx);
  const ext    = job.filename.slice(dotIdx);
  const dateStr = (toDate && toDate !== fromDate) ? `${fromDate}_${toDate}` : fromDate;
  return `${base}_${dateStr}${ext}`;
}

function getSupplierSlug() {
  const m = window.location.href.match(
    /supplier\.meesho\.com\/panel\/v\d+\/new\/[^/]+\/([^/?#]+)/
  );
  return (m && m[1] !== 'undefined') ? m[1] : SUPPLIER_SLUG_FALLBACK;
}

function looksLikeDownload(url) {
  return typeof url === 'string' && MEESHO_DOWNLOAD_PATTERNS.some(p => p.test(url));
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
  return findEl([text], 'button, [role="button"]') || null;
}

async function clickAndWait(el, ms = 1000) {
  chrome.runtime.sendMessage({
    type: 'LOG_DEBUG', jobId: _bulkCurrentJob?.id || 'bulk_me',
    text: `CLICK ${el.tagName} "${(el.textContent || '').trim().slice(0, 60)}" wait=${ms}ms`,
  }).catch(() => {});
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(200);
  el.click();
  await sleep(ms);
}

async function dismissMeeshoPopups() {
  const _plog = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: _bulkCurrentJob?.id || 'bulk_me', text: `dismissPopups: ${t}` }).catch(() => {});
  const CLOSE_TEXTS = ['×', '✕', 'close', 'dismiss', 'got it', 'ok', 'skip', 'maybe later', 'not now'];
  for (let round = 0; round < 2; round++) {
    const overlays = document.querySelectorAll('[class*="modal" i], [class*="dialog" i], [class*="popup" i], [class*="overlay" i]');
    let dismissed = false;
    for (const overlay of overlays) {
      if (!overlay.offsetParent) continue;
      const btns = Array.from(overlay.querySelectorAll('button, span, a, [role="button"]'));
      const closeBtn = btns.find(b => {
        const t = b.textContent.trim().toLowerCase();
        return CLOSE_TEXTS.some(ct => t === ct || t.startsWith(ct));
      });
      if (closeBtn) {
        await _plog(`round ${round}: dismissed overlay via "${closeBtn.textContent.trim().slice(0,20)}"`);
        closeBtn.click(); await sleep(500); dismissed = true; break;
      }
    }
    if (!dismissed) {
      await _plog(`round ${round}: no popup found — pressing Escape`);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      break;
    }
    await sleep(600);
  }
}

async function isOnTargetPage(pagePath) {
  const url = window.location.href;
  return url.includes(pagePath);
}

async function goToPage(job) {
  const pagePath = JOB_PAGES_BULK[job.id];
  if (!pagePath) return;
  const _glog = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `goToPage: ${t}` }).catch(() => {});
  if (window.location.href.includes(pagePath)) {
    await _glog(`already on ${pagePath}`);
    return;
  }
  const slug = getSupplierSlug();
  const target = `https://supplier.meesho.com/supplier/${slug}${pagePath}`;
  await _glog(`navigating to ${target.slice(0, 100)}`);
  window.location.href = target;
  await sleep(6000);
  await _glog(`arrived: ${window.location.href.slice(0, 100)}`);
}

function interceptNextMeDownload(timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      window.__rumeeIntercepting = false;
      window.removeEventListener('message', onMsg);
      reject(new Error('interceptNextMeDownload: no download captured within timeout'));
    }, timeout);
    function onMsg(event) {
      if (!event.data?.__rumeeDownload) return;
      if (settled) return;
      settled = true; clearTimeout(timer);
      window.__rumeeIntercepting = false;
      window.removeEventListener('message', onMsg);
      resolve({ url: event.data.url, headers: event.data.headers || {} });
    }
    window.addEventListener('message', onMsg);
    window.__rumeeIntercepting = true;
    window.postMessage({ __rumeeArmCapture: true, __rumeeCapturingBlob: false }, '*');
  });
}

function interceptNextMeBlob(timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      window.__rumeeCapturingBlob = false;
      window.removeEventListener('message', onMsg);
      reject(new Error('interceptNextMeBlob: no blob captured within timeout'));
    }, timeout);
    function onMsg(event) {
      if (!event.data?.__rumeeBlob) return;
      if (settled) return;
      settled = true; clearTimeout(timer);
      window.__rumeeCapturingBlob = false;
      window.removeEventListener('message', onMsg);
      resolve({ base64: event.data.base64, mimeType: event.data.mimeType });
    }
    window.addEventListener('message', onMsg);
    window.__rumeeCapturingBlob = true;
    window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: true }, '*');
  });
}

// fillMeeshoDates — parameterized (verbatim from meesho.js, adapted for bulk)
async function fillBulkMeeshoDates(fromISO, toISO) {
  const _dlog = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: _bulkCurrentJob?.id || 'bulk_me', text: `fillDates(${fromISO}→${toISO}): ${t}` }).catch(() => {});
  await _dlog('start');
  const dateInputs = Array.from(document.querySelectorAll('input[type="date"]'));
  if (dateInputs.length >= 2) {
    await _dlog(`strategy1: found ${dateInputs.length} date inputs`);
    setValue(dateInputs[0], fromISO); await sleep(300);
    setValue(dateInputs[1], toISO);   await sleep(300);
    await _dlog('strategy1: done');
    return;
  }

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [fYear, fMonth, fDay] = fromISO.split('-').map(Number);
  const [tYear, tMonth, tDay] = toISO.split('-').map(Number);

  const calendarTrigger = findEl(['From Date', 'Start Date', 'date range', 'Select Date'], 'button, [role="button"], input, div, span')
    || document.querySelector('[class*="DateRange"], [class*="date-range"], [class*="datepicker"], [class*="DatePicker"]');
  if (calendarTrigger) {
    await _dlog(`strategy2: calendar trigger found "${(calendarTrigger.textContent||'').trim().slice(0,40)}"`);
    calendarTrigger.click();
    await sleep(1000);
  } else {
    await _dlog('strategy2: no calendar trigger found — trying waitForElement');
  }

  const calendarEl = await waitForElement(
    '[class*="Calendar"], [class*="calendar"], [class*="DatePicker"], [class*="datePicker"]',
    8000
  ).catch(() => null);

  if (calendarEl) {
    await _dlog(`strategy2: calendar element found — navigating`);
    // Strategy 2: aria-label based navigation
    const getHeaderMonth = () => {
      const headers = Array.from(document.querySelectorAll('[class*="month" i], [class*="header" i]'))
        .filter(el => el.offsetParent && MONTHS.some(m => el.textContent.includes(m)));
      return headers[0]?.textContent.trim() || '';
    };

    const navToMonth = async (targetYear, targetMonth) => {
      const targetText = `${MONTHS[targetMonth - 1]} ${targetYear}`;
      let guard = 24;
      while (guard-- > 0 && !getHeaderMonth().includes(targetText)) {
        const header = getHeaderMonth();
        const [hMonthStr, hYearStr] = header.replace(/\s+/g, ' ').split(' ').filter(Boolean).slice(-2);
        const hMonth = MONTHS.indexOf(hMonthStr) + 1;
        const hYear  = parseInt(hYearStr) || targetYear;
        const goBack = (hYear > targetYear) || (hYear === targetYear && hMonth > targetMonth);
        const navBtn = goBack
          ? document.querySelector('[aria-label*="prev" i], [aria-label*="back" i], [class*="prev" i]')
          : document.querySelector('[aria-label*="next" i], [aria-label*="forward" i], [class*="next" i]');
        if (!navBtn) break;
        navBtn.click();
        await sleep(500);
      }
    };

    const clickCalDay = async (year, month, day) => {
      const label1 = `${MONTHS[month-1]} ${day}, ${year}`;
      const label2 = `${day} ${MONTHS[month-1]} ${year}`;
      let cell = document.querySelector(`[aria-label="${label1}"], [aria-label="${label2}"]`);
      if (!cell) {
        const dayCells = Array.from(document.querySelectorAll('td, [role="gridcell"], [role="cell"], [class*="day"], [class*="date"]'))
          .filter(el => el.offsetParent && el.textContent.trim() === String(day));
        cell = dayCells.find(el => {
          let anc = el.parentElement;
          for (let i = 0; i < 8 && anc; i++) {
            if (anc.textContent.includes(MONTHS[month-1])) return true;
            anc = anc.parentElement;
          }
          return false;
        }) || dayCells[0];
      }
      if (cell) { cell.click(); await sleep(400); return true; }
      return false;
    };

    await navToMonth(fYear, fMonth);
    const fromClicked = await clickCalDay(fYear, fMonth, fDay);
    await _dlog(`strategy2: fromDate click=${fromClicked}`);
    if (fYear !== tYear || fMonth !== tMonth) {
      await navToMonth(tYear, tMonth);
    }
    const toClicked = await clickCalDay(tYear, tMonth, tDay);
    await _dlog(`strategy2: toDate click=${toClicked}`);
    return;
  }

  // Strategy 3: DD/MM/YYYY text inputs
  await _dlog('strategy3: trying text inputs');
  const ddmmyyyy = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
  const textInputs = Array.from(document.querySelectorAll(
    'input[placeholder*="From" i], input[placeholder*="To" i], input[placeholder*="Start" i], input[placeholder*="End" i], input[placeholder*="DD" i], input[placeholder*="date" i]'
  ));
  if (textInputs.length >= 2) {
    await _dlog(`strategy3: found ${textInputs.length} text inputs`);
    setValue(textInputs[0], ddmmyyyy(fromISO)); await sleep(300);
    setValue(textInputs[1], ddmmyyyy(toISO));
    await _dlog('strategy3: done');
    return;
  }
  await _dlog('FAILED: no date input strategy worked');
  console.warn('[Rumee/BulkMe] fillBulkMeeshoDates: no strategy worked');
}

function setValue(input, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSetter) nativeSetter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function findDownloadButton() {
  const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a, span'));
  const downloadBtns = allButtons.filter(el => {
    if (!el.offsetParent) return false;
    const t = el.textContent.trim().toLowerCase();
    return t === 'download' || t.startsWith('download');
  });
  return downloadBtns[downloadBtns.length - 1] || null;
}

async function findExportedFileDownloadBtn(fromDate, toDate) {
  const rows = Array.from(document.querySelectorAll('tr, [class*="row" i], li'));
  for (const row of rows) {
    const txt = row.textContent;
    if (txt.includes(fromDate) && (toDate === fromDate || txt.includes(toDate))) {
      const dlBtn = Array.from(row.querySelectorAll('span, button, a, [role="button"]'))
        .find(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download');
      if (dlBtn) return dlBtn;
    }
  }
  return null;
}

// ─── Meesho API helpers ───────────────────────────────────────────────────────

async function fetchMeeshoCampaignList() {
  const slug = getSupplierSlug();
  const allCampaigns = [];
  let page = 1;
  while (true) {
    const res = await fetch(`https://supplier.meesho.com/api/ads/campaigns/fetch-campaign-list`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Supplier-Slug': slug },
      body: JSON.stringify({ page_no: page, page_size: 100 }),
    });
    if (!res.ok) break;
    const json = await res.json();
    const items = json?.data?.campaigns || json?.campaigns || [];
    allCampaigns.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return allCampaigns;
}

async function fetchMeeshoCampaignDetails(fromISO, toISO) {
  const slug = getSupplierSlug();
  const res = await fetch(`https://supplier.meesho.com/api/ads/campaigns/fetch-campaign-details`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Supplier-Slug': slug },
    body: JSON.stringify({ start_date: fromISO, end_date: toISO, page_no: 1, page_size: 1000 }),
  });
  if (!res.ok) throw new Error(`Meesho campaign details fetch: HTTP ${res.status}`);
  return res.json();
}

// ─── Job handlers ─────────────────────────────────────────────────────────────

async function handleBulkMeOrders(job) {
  const fromDate = job.targetFromDate;
  const toDate   = job.targetToDate;
  const BULK_ME_ORDERS_KEY = 'bulkMeOrdersPendingExport';
  const _log = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `MeOrders: ${t}` }).catch(() => {});

  await _log(`entry: ${fromDate}→${toDate} url=${window.location.href.slice(0,80)}`);
  await sleep(4000);
  await dismissMeeshoPopups();

  const stored = await getStorage([BULK_ME_ORDERS_KEY]);
  const pending = stored[BULK_ME_ORDERS_KEY];

  if (pending && pending.jobId === job.id) {
    await _log(`resume path — pending export from ${pending.ts ? new Date(pending.ts).toISOString() : 'unknown'}`);
    await goToPage(job);
    await sleep(3000);

    const exportedTab = findBtn('Exported Files') || findEl(['Exported Files'], 'button, li, [role="tab"]');
    if (exportedTab) { await _log('found Exported Files tab'); await clickAndWait(exportedTab, 2000); }
    else await _log('Exported Files tab not found');

    const dlBtn = await findExportedFileDownloadBtn(fromDate, toDate);
    if (dlBtn) {
      await _log('exported file found — downloading via blob');
      window.__rumeeCapturingBlob = true;
      window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: true }, '*');
      dlBtn.click();
      await sleep(1000);
      const blobResult = await interceptNextMeBlob(60000);
      await chrome.storage.local.remove([BULK_ME_ORDERS_KEY]);
      const filename = makeDatedFilename(job, fromDate, toDate);
      await _log(`blob captured — uploading as ${filename}`);
      chrome.runtime.sendMessage({
        type: 'BULK_UPLOAD_DATA', jobId: job.id,
        data: blobResult.base64, encoding: 'base64',
        filename, folderKey: job.folderKey, mimeType: job.mimeType,
      });
      return;
    }
    await _log('exported file NOT ready yet — throwing');
    throw new Error('Bulk orders: exported file not yet available — retry later');
  }

  // Normal path: Export
  await _log('normal path — requesting export');
  await goToPage(job);
  await sleep(3000);
  await dismissMeeshoPopups();

  const ordersTab = findEl(['Orders', 'All Orders'], '[role="tab"], li');
  if (ordersTab) { await _log('found Orders tab'); await clickAndWait(ordersTab, 2000); }
  else await _log('Orders tab not found — skipping');

  const exportBtn = findBtn('Export') || findEl(['Export'], 'button, [role="button"]');
  if (!exportBtn) { await _log('ERROR: Export button not found'); throw new Error('Bulk orders: Export button not found'); }
  await _log(`found Export button: "${exportBtn.textContent.trim().slice(0,40)}"`);
  await clickAndWait(exportBtn, 1500);

  await fillBulkMeeshoDates(fromDate, toDate);
  await sleep(1000);

  const confirmExportBtn = findBtn('Export') || findBtn('Confirm') || findBtn('Submit');
  if (!confirmExportBtn) { await _log('ERROR: Export confirm button not found'); throw new Error('Bulk orders: Export confirm button not found'); }
  await _log(`found confirm button: "${confirmExportBtn.textContent.trim().slice(0,40)}"`);
  await clickAndWait(confirmExportBtn, 2000);

  await setStorage({ [BULK_ME_ORDERS_KEY]: { jobId: job.id, fromDate, toDate, ts: Date.now() } });
  await _log('export requested — waiting 35s then reloading to check');

  await sleep(35000);
  await _log('reloading page for resume check');
  window.location.reload();
}

async function handleBulkMePayments(job) {
  const fromDate = job.targetFromDate;
  const toDate   = job.targetToDate;
  const _log = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `MePayments: ${t}` }).catch(() => {});

  await _log(`entry: ${fromDate}→${toDate} url=${window.location.href.slice(0,80)}`);
  await sleep(4000);
  await dismissMeeshoPopups();
  await goToPage(job);
  await sleep(3000);
  await dismissMeeshoPopups();

  const paymentsTab = findEl(['Payments', 'Payment'], '[role="tab"], li');
  if (paymentsTab) { await _log(`found Payments tab: "${paymentsTab.textContent.trim().slice(0,30)}"`); await clickAndWait(paymentsTab, 2000); }
  else await _log('Payments tab not found — skipping');

  const dlDropdownBtn = findEl(['Download', '▼', '▾'], 'button, [role="button"]')
    || Array.from(document.querySelectorAll('button, [role="button"]'))
       .find(el => el.offsetParent && /download/i.test(el.textContent) && el.textContent.trim().length < 30);
  if (!dlDropdownBtn) { await _log('ERROR: Download dropdown not found'); throw new Error('Bulk payments: Download dropdown not found'); }
  await _log(`found Download dropdown: "${dlDropdownBtn.textContent.trim().slice(0,40)}"`);
  await clickAndWait(dlDropdownBtn, 1000);

  const paymentsToDateOpt = findEl(['Payments to Date', 'Payment to Date'], 'li, [role="option"], button, a, div, span');
  if (!paymentsToDateOpt) { await _log('ERROR: "Payments to Date" option not found'); throw new Error('Bulk payments: "Payments to Date" option not found'); }
  await _log(`found "Payments to Date" option`);
  await clickAndWait(paymentsToDateOpt, 1500);

  const customRangeOpt = findEl(['Custom Date Range', 'Custom'], 'li, [role="option"], button, a, span, div');
  if (!customRangeOpt) { await _log('ERROR: "Custom Date Range" option not found'); throw new Error('Bulk payments: "Custom Date Range" option not found'); }
  await _log(`found "Custom Date Range" option`);
  await clickAndWait(customRangeOpt, 1500);

  await fillBulkMeeshoDates(fromDate, toDate);
  await sleep(1000);

  const finalDlBtn = findDownloadButton() || findBtn('Download') || findBtn('Submit') || findBtn('Confirm');
  if (!finalDlBtn) { await _log('ERROR: final Download button not found'); throw new Error('Bulk payments: final Download button not found'); }
  await _log(`found final Download button: "${finalDlBtn.textContent.trim().slice(0,40)}"`);

  const filename = makeDatedFilename(job, fromDate, toDate);
  await _log(`arming blob capture for filename=${filename}`);
  _bulkCurrentJob.filename = filename;
  window.__rumeeCapturingBlob = true;
  window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: true }, '*');
  chrome.runtime.sendMessage({ type: 'BULK_DOWNLOAD_BUTTON_CLICKED', jobId: job.id, filenameOverride: filename });
  finalDlBtn.click();
  await sleep(1000);
  await _log('blob click done — waiting for relay');
}

async function handleBulkMeAds(job) {
  const fromDate = job.targetFromDate;
  const toDate   = job.targetToDate;
  const _log = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `BulkMeAds: ${t}` });

  await _log(`entry: ${fromDate} → ${toDate}`);

  const campaigns = await fetchMeeshoCampaignList();
  const liveCampaigns = campaigns.filter(c => {
    const status = (c.status || c.campaign_status || '').toUpperCase();
    return status === 'LIVE' || status === 'ACTIVE' || status === 'RUNNING';
  });
  await _log(`campaigns: total=${campaigns.length} live=${liveCampaigns.length}`);

  if (liveCampaigns.length === 0) {
    await _log('no live campaigns — sending empty bundle');
    chrome.runtime.sendMessage({ type: 'BULK_UPLOAD_ADS_BUNDLE', jobId: job.id, files: [] });
    return;
  }

  const detailsJson = await fetchMeeshoCampaignDetails(fromDate, toDate);
  const detailRows  = detailsJson?.data?.campaigns || detailsJson?.campaigns || [];

  const liveCampaignIds = new Set(liveCampaigns.map(c => c.id || c.campaign_id));

  const _parseCsvLine = (line) => {
    const result = []; let cur = ''; let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  };

  const campaignFiles = [];
  for (const campaign of liveCampaigns) {
    const cId   = campaign.id || campaign.campaign_id;
    const cName = campaign.name || campaign.campaign_name || String(cId);
    const rows  = detailRows.filter(r => (r.campaign_id || r.id) === cId);
    if (rows.length === 0) continue;

    const headers = Object.keys(rows[0]).join(',');
    const csvRows = [headers, ...rows.map(r => Object.values(r).map(v =>
      (typeof v === 'string' && v.includes(',')) ? `"${v}"` : String(v ?? '')
    ).join(','))];
    const csvContent = csvRows.join('\n');
    const base64 = btoa(unescape(encodeURIComponent(csvContent)));
    const safeName = cName.replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 40);
    const filename = `meesho_ads_${fromDate}_${toDate}_${safeName}.csv`;
    campaignFiles.push({ campaignId: cId, campaignName: cName, filename, data: base64, encoding: 'base64' });
  }

  await _log(`built ${campaignFiles.length} campaign files`);
  chrome.runtime.sendMessage({
    type: 'BULK_UPLOAD_ADS_BUNDLE', jobId: job.id,
    files: campaignFiles, folderKey: job.folderKey,
  });
}

async function handleBulkMeClaims(job) {
  const fromDate = job.targetFromDate;
  const toDate   = job.targetToDate;
  const _log = t => chrome.runtime.sendMessage({ type: 'LOG_DEBUG', jobId: job.id, text: `BulkMeClaims: ${t}` });

  await _log(`entry: ${fromDate}→${toDate} url=${window.location.href.slice(0,80)}`);
  await sleep(4000);
  await dismissMeeshoPopups();
  await goToPage(job);
  await sleep(3000);
  await dismissMeeshoPopups();

  const claimsMenu = findEl(['Claims', 'Claim Management'], '[role="tab"], li, a, button, span')
    || findBtn('Claims');
  if (claimsMenu) { await _log(`found Claims menu: "${claimsMenu.textContent.trim().slice(0,30)}"`); await clickAndWait(claimsMenu, 2000); }
  else await _log('Claims menu not found — skipping tab click');

  // Wait for claims page content
  await waitForElement('[class*="claims" i], [class*="claim" i], table, [role="grid"]', 10000)
    .catch(() => { _log('claims section load warning — timeout'); });

  const dlDropdownBtn = findEl(['Download', '▼', '▾'], 'button, [role="button"]')
    || Array.from(document.querySelectorAll('button, [role="button"]'))
       .find(el => el.offsetParent && /download/i.test(el.textContent) && el.textContent.trim().length < 30);
  if (!dlDropdownBtn) { await _log('ERROR: Download dropdown not found'); throw new Error('Bulk claims: Download dropdown not found'); }
  await _log(`found Download dropdown: "${dlDropdownBtn.textContent.trim().slice(0,40)}"`);
  await clickAndWait(dlDropdownBtn, 1000);

  const exportDataOpt = findEl(['Export Data', 'Export Claims', 'Export'], 'li, [role="option"], a, button, span, div');
  if (!exportDataOpt) { await _log('ERROR: "Export Data" option not found'); throw new Error('Bulk claims: "Export Data" option not found'); }
  await _log(`found Export option: "${exportDataOpt.textContent.trim().slice(0,40)}"`);
  await clickAndWait(exportDataOpt, 2000);

  // Look for "Exported Files" tab first
  const exportedTab = findBtn('Exported Files') || findEl(['Exported Files'], 'button, li, [role="tab"]');
  if (exportedTab) { await _log('found Exported Files tab'); await clickAndWait(exportedTab, 2000); }
  else await _log('Exported Files tab not found');

  // Check if there's already a file for our date range
  const existingBtn = await findExportedFileDownloadBtn(fromDate, toDate);
  if (existingBtn) {
    await _log('found existing exported file — downloading');
    const filename = makeDatedFilename(job, fromDate, toDate);
    _bulkCurrentJob.filename = filename;
    window.__rumeeCapturingBlob = true;
    window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: true }, '*');
    chrome.runtime.sendMessage({ type: 'BULK_DOWNLOAD_BUTTON_CLICKED', jobId: job.id, filenameOverride: filename });
    existingBtn.click();
    await sleep(500);
    return; // blob relay fires
  }

  // Request fresh export with date filter
  const requestExportTab = findBtn('Request Export') || findEl(['Request Export', 'New Export', 'Request'], 'button, li, [role="tab"]');
  if (requestExportTab) { await _log(`found Request Export tab: "${requestExportTab.textContent.trim().slice(0,30)}"`); await clickAndWait(requestExportTab, 1500); }
  else await _log('Request Export tab not found — filling dates directly');

  await fillBulkMeeshoDates(fromDate, toDate);
  await sleep(1000);

  const submitBtn = findBtn('Export') || findBtn('Request') || findBtn('Submit') || findBtn('Confirm');
  if (!submitBtn) { await _log('ERROR: Export/Submit button not found'); throw new Error('Bulk claims: Export/Submit button not found'); }
  await _log(`found submit button: "${submitBtn.textContent.trim().slice(0,40)}"`);
  await clickAndWait(submitBtn, 2000);
  await _log('export requested — polling for result');

  // Poll for the exported file
  let found = false;
  for (let attempt = 0; attempt < 12 && !found; attempt++) {
    await _log(`poll attempt ${attempt + 1}/12 — waiting 5s`);
    await sleep(5000);
    const exportedTabNow = findBtn('Exported Files') || findEl(['Exported Files'], 'button, li, [role="tab"]');
    if (exportedTabNow) await clickAndWait(exportedTabNow, 1500);

    const dlBtn = await findExportedFileDownloadBtn(fromDate, toDate);
    if (!dlBtn) {
      await _log(`poll ${attempt + 1}: no matching file yet`);
      // Fallback: find any recent download button
      const todayStr = todayISO();
      const allDlBtns = Array.from(document.querySelectorAll('span, button, a'))
        .filter(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download');
      if (allDlBtns.length > 0) {
        const btn = allDlBtns[allDlBtns.length - 1];
        const rowTxt = btn.closest('tr, li, [class*="row"]')?.textContent || '';
        if (rowTxt.includes(todayStr.slice(0,7))) { // same month
          await _log(`found recent download btn (attempt ${attempt+1})`);
          const filename = makeDatedFilename(job, fromDate, toDate);
          _bulkCurrentJob.filename = filename;
          window.__rumeeCapturingBlob = true;
          window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: true }, '*');
          chrome.runtime.sendMessage({ type: 'BULK_DOWNLOAD_BUTTON_CLICKED', jobId: job.id, filenameOverride: filename });
          btn.click();
          found = true;
        }
      }
      continue;
    }
    await _log(`exported file ready (attempt ${attempt+1})`);
    const filename = makeDatedFilename(job, fromDate, toDate);
    _bulkCurrentJob.filename = filename;
    window.__rumeeCapturingBlob = true;
    window.postMessage({ __rumeeArmCapture: false, __rumeeCapturingBlob: true }, '*');
    chrome.runtime.sendMessage({ type: 'BULK_DOWNLOAD_BUTTON_CLICKED', jobId: job.id, filenameOverride: filename });
    dlBtn.click();
    found = true;
  }

  if (!found) {
    throw new Error(`Bulk claims: exported file not ready after 12 polling attempts`);
  }
  // blob relay will fire below
}

// ─── Module-level relays ──────────────────────────────────────────────────────

// MAIN-world download intercept relay
window.addEventListener('message', (event) => {
  if (!event.data?.__rumeeDownload) return;
  if (!_bulkCurrentJob) return;
  const capturedJob = _bulkCurrentJob;
  _bulkCurrentJob = null;
  window.__rumeeIntercepting = false;
  const { url, headers } = event.data;
  console.log(`[Rumee/BulkMe] ✓ MAIN-world relay: ${url.slice(0, 160)}`);
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
  console.log(`[Rumee/BulkMe] ✓ blob relay: ${size} bytes → ${capturedJob.id}`);
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

} // end __rumeeBulkMeInjected guard
