// backfill-hub.js — Unified Backfill Panel
// Open via: chrome-extension://<id>/backfill-hub.html
//
// Replaces the old "hub of separate mini-tools" (me-orders-backfill.html,
// me-payments-backfill.html, me-payments-upload.html, test-returns.html) with
// one panel: pick a report type + date (or range), run it, and it uploads +
// updates the Download Manifest + clears any matching "Manual Action Needed"
// entry automatically. Every per-report DOM-automation function below is
// copied VERBATIM from its proven, already-tested standalone tool — only the
// outer wiring (report picker, shared table, post-success hooks) is new.
// The 4 old standalone files are left untouched in the repo as a fallback —
// not deleted, not modified, no longer linked to from here.

// ─── Report type registry ──────────────────────────────────────────────────
const REPORT_TYPES = {
  me_orders: {
    label:  'Meesho Orders',
    mode:   'daterange',
    platform: 'meesho',
    gapJobId: 'me_orders',
  },
  me_payments: {
    label:  'Meesho Payments — fetch from panel',
    mode:   'daterange',
    platform: 'meesho',
    gapJobId: 'me_payments',
  },
  me_payments_upload: {
    label:  'Meesho Payments — upload local ZIPs',
    mode:   'upload',
    gapJobId: 'me_payments',
  },
  fk_returns: {
    label:  'Flipkart Returns',
    mode:   'daterange',
    platform: 'flipkart',
    gapJobId: 'fk_returns_download',
  },
};

let stopRequested = false;
let activeMeTabId = null;
let activeFkTabId = null;

// ─── Shared UI helpers (identical across the old per-report tools) ─────────

function log(msg) {
  const el = document.getElementById('log');
  el.textContent += `[${istTimeOnly(Date.now())}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setRow(date, cls, status, size, detail) {
  const st  = document.getElementById(`st-${date}`);
  const sz  = document.getElementById(`sz-${date}`);
  const det = document.getElementById(`det-${date}`);
  if (st)  { st.className = cls; st.textContent = status; }
  if (sz)  sz.textContent = size  || '—';
  if (det) det.textContent = detail || '';
}

function initTable(dates) {
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';
  for (const d of dates) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${d}</td>` +
      `<td class="waiting" id="st-${d}">Waiting</td>` +
      `<td id="sz-${d}">—</td>` +
      `<td id="det-${d}">—</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById('summary').textContent = '';
}

function dateRange(from, to) {
  const dates = [];
  let cur = from;
  while (cur <= to) {
    dates.push(cur);
    cur = istAddDays(cur, 1);
  }
  return dates;
}

function waitForTabLoad(tabId, timeout = 40000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeout);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function bgMessage(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

function pollStorage(key, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      chrome.storage.local.get([key], data => {
        if (data[key] !== undefined) {
          resolve(data[key]);
        } else if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Timeout waiting for ${key} (${timeoutMs / 1000}s)`));
        } else {
          setTimeout(check, 1500);
        }
      });
    }
    check();
  });
}

// ─── Tab management (identical helpers from the old per-report tools) ──────

async function ensureMeeshoTab(startUrl) {
  if (activeMeTabId) {
    try { await chrome.tabs.get(activeMeTabId); return activeMeTabId; }
    catch (_) { activeMeTabId = null; }
  }
  const existing = await chrome.tabs.query({ url: 'https://supplier.meesho.com/*' });
  if (existing.length > 0) {
    activeMeTabId = existing[0].id;
    return activeMeTabId;
  }
  const tab = await chrome.tabs.create({ url: startUrl, active: false });
  activeMeTabId = tab.id;
  await waitForTabLoad(tab.id);
  return activeMeTabId;
}

async function ensureFkTab() {
  const existing = await chrome.tabs.query({ url: 'https://seller.flipkart.com/*' });
  if (existing.length > 0) {
    activeFkTabId = existing[0].id;
    return activeFkTabId;
  }
  const tab = await chrome.tabs.create({ url: 'https://seller.flipkart.com/', active: false });
  activeFkTabId = tab.id;
  await waitForTabLoad(tab.id);
  return activeFkTabId;
}

// ─── Post-success hook — the actual new behavior this panel adds ───────────
// Called after EVERY successful single-date backfill, regardless of which
// report type produced it. Two steps, both reusing existing background.js
// machinery unchanged:
//   1. VERIFY_NOW with an explicit dataDate — verifyAndLogManifest() upserts
//      just this one date's manifest row (keyed by Data Date + File Name),
//      every other row is left untouched. Also posts the existing Discord
//      summary for that date (kept on purpose — Jaiswal wants the ping).
//   2. If this jobId+date is sitting in the "Manual Action Needed" list
//      (gapCatchupManual), clear it via the same MARK_GAP_CATCHUP_DONE the
//      popup's own "Mark Done" button already uses.

async function postBackfillSuccess(gapJobId, date) {
  try {
    await bgMessage({ type: 'VERIFY_NOW', dataDate: date });
    log(`${date}: manifest updated`);
  } catch (e) {
    log(`${date}: manifest update failed — ${e.message}`);
  }

  try {
    const { gapCatchupManual = [] } = await new Promise(res =>
      chrome.storage.local.get('gapCatchupManual', res));
    if (gapCatchupManual.some(x => x.jobId === gapJobId && x.date === date)) {
      await bgMessage({ type: 'MARK_GAP_CATCHUP_DONE', jobId: gapJobId, date });
      log(`${date}: cleared from Manual Action Needed`);
      renderPending();
    }
  } catch (e) {
    log(`${date}: gap-catchup clear failed — ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ─── me_orders — copied verbatim from me-orders-backfill.js ────────────────
// ══════════════════════════════════════════════════════════════════════════

const ME_ORDERS_URL = `https://supplier.meesho.com/panel/v3/new/fulfillment/${MEESHO_SUPPLIER_SLUG}/orders/`;

async function meeshoOrdersExport(dateStr) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function clickAndWait(el, ms = 800) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return sleep(200 + Math.random() * 100).then(() => {
      el.click();
      return sleep(ms + Math.random() * 200);
    });
  }

  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function clickCalendarDate(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const DAYS       = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const MONTHS_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const localDate  = new Date(y, m - 1, d);
    const label1     = `${DAYS[localDate.getDay()]} ${MONTHS_ABR[m-1]} ${String(d).padStart(2,'0')} ${y}`;
    const label2     = `${MONTHS_ABR[m-1]} ${d}, ${y}`;
    const targetKey  = y * 12 + (m - 1);

    for (let nav = 0; nav < 14; nav++) {
      const already = document.querySelector(
        `[aria-label="${label1}"], [aria-label="${label2}"], [data-date="${isoDate}"]`
      );
      if (already) break;

      let displayedKey = null;
      const headerEl = Array.from(document.querySelectorAll('*')).find(el => {
        if (!el.offsetParent || el.children.length > 3) return false;
        return /^[A-Za-z]+ \d{4}$/.test(el.textContent.trim());
      });
      if (headerEl) {
        const parts = headerEl.textContent.trim().split(' ');
        const hmIdx = MONTHS_ABR.findIndex(a => parts[0].startsWith(a));
        if (hmIdx !== -1) displayedKey = parseInt(parts[1]) * 12 + hmIdx;
      }

      const goNext = displayedKey !== null ? displayedKey < targetKey : false;
      const navBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => {
          if (!el.offsetParent) return false;
          const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
          const cls = (el.className || '').toLowerCase();
          const txt = el.textContent.trim();
          return goNext
            ? (lbl.includes('next') || /next/i.test(cls) || ['>','›','→','»'].includes(txt))
            : (lbl.includes('prev') || lbl.includes('back') || /prev/i.test(cls) ||
               /back/i.test(cls) || ['<','‹','←','«'].includes(txt));
        });
      if (!navBtn) break;
      navBtn.click();
      await sleep(600);
    }

    const cell = document.querySelector(
      `[aria-label="${label1}"], [aria-label="${label2}"], [data-date="${isoDate}"]`
    );
    if (cell) { await clickAndWait(cell, 300); return true; }

    const calRoot = document.querySelector(
      '[class*="calendar"],[class*="Calendar"],[class*="datepicker"],[role="grid"]'
    ) || document;
    const dayCells = Array.from(calRoot.querySelectorAll(
      'button[class*="day"],button[class*="Day"],td,[role="gridcell"],[role="option"]'
    )).filter(el => el.textContent.trim() === String(d) && el.offsetParent !== null);
    if (dayCells.length > 0) { await clickAndWait(dayCells[0], 300); return true; }

    return false;
  }

  async function fillDates(fromISO, toISO) {
    const dateInputs = Array.from(document.querySelectorAll('input[type="date"]'));
    if (dateInputs.length >= 2) {
      setValue(dateInputs[0], fromISO); await sleep(300);
      setValue(dateInputs[1], toISO);   await sleep(300);
      return;
    }
    const fromOk = await clickCalendarDate(fromISO);
    await sleep(500);
    const toOk   = await clickCalendarDate(toISO);
    if (fromOk && toOk) return;

    const ddmmyyyy = iso => { const [yr, mo, dy] = iso.split('-'); return `${dy}/${mo}/${yr}`; };
    const textInputs = Array.from(document.querySelectorAll(
      'input[type="text"][placeholder*="From" i], input[type="text"][placeholder*="To" i], ' +
      'input[type="text"][placeholder*="DD" i], input[type="text"][placeholder*="date" i], ' +
      'input[type="text"][placeholder*="Select" i]'
    )).filter(el => el.offsetParent);
    if (textInputs.length >= 2) {
      setValue(textInputs[0], ddmmyyyy(fromISO)); await sleep(300);
      setValue(textInputs[1], ddmmyyyy(toISO));   await sleep(300);
    }
  }

  async function dismissPopups() {
    const CLOSE_TEXTS = ['close','skip','got it','ok','dismiss','maybe later','not now','✕','×'];
    for (let round = 0; round < 3; round++) {
      const closeBtn = Array.from(document.querySelectorAll(
        '[aria-label="close" i],[aria-label="dismiss" i],button[class*="close" i],' +
        '[data-testid*="close" i]'
      )).find(el => el.offsetParent);
      if (closeBtn) { closeBtn.click(); await sleep(700); continue; }

      const overlays = document.querySelectorAll(
        '[class*="modal" i],[class*="overlay" i],[class*="dialog" i],[class*="popup" i]'
      );
      let found = false;
      for (const ov of overlays) {
        if (!ov.offsetParent) continue;
        const btn = Array.from(ov.querySelectorAll('button, a'))
          .find(b => CLOSE_TEXTS.includes(b.textContent.trim().toLowerCase()));
        if (btn) { btn.click(); await sleep(700); found = true; break; }
      }
      if (!found) break;
      await sleep(500);
    }
  }

  try {
    await sleep(4000 + Math.random() * 1000);
    await dismissPopups();

    let dlDropdown = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      dlDropdown = Array.from(document.querySelectorAll('button, [role="button"], p'))
        .find(el => el.offsetParent && /download orders data/i.test(el.textContent.trim()));
      if (dlDropdown) break;
      await sleep(2000);
    }
    if (!dlDropdown) throw new Error('"Download Orders Data" button not found after 5 attempts');
    await clickAndWait(dlDropdown, 1500);

    let dateRangeBtn = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      dateRangeBtn = Array.from(document.querySelectorAll('p, span, a, button, [role="button"], *'))
        .find(el => el.children.length === 0 && el.offsetParent !== null &&
                    el.textContent.trim() === 'Select Date Range');
      if (dateRangeBtn) break;
      await sleep(1500);
    }
    if (!dateRangeBtn) throw new Error('"Select Date Range" not found in dropdown');
    await clickAndWait(dateRangeBtn, 1500);

    await fillDates(dateStr, dateStr);
    await sleep(600);

    let exportBtn = null;
    for (let t = 0; t < 8; t++) {
      exportBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => /export/i.test(el.textContent.trim()) &&
                    !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
                    el.offsetParent !== null);
      if (exportBtn) break;
      await sleep(500);
    }
    if (!exportBtn) throw new Error('"Export data" button not found or still disabled');
    await clickAndWait(exportBtn, 1000);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function meeshoOrdersDownload(dateStr) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function clickAndWait(el, ms = 800) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return sleep(200 + Math.random() * 100).then(() => { el.click(); return sleep(ms + Math.random() * 200); });
  }

  async function dismissPopups() {
    const CLOSE_TEXTS = ['close','skip','got it','ok','dismiss','maybe later','not now','✕','×'];
    for (let round = 0; round < 3; round++) {
      const closeBtn = Array.from(document.querySelectorAll(
        '[aria-label="close" i],[aria-label="dismiss" i],button[class*="close" i],' +
        '[data-testid*="close" i]'
      )).find(el => el.offsetParent);
      if (closeBtn) { closeBtn.click(); await sleep(700); continue; }

      const overlays = document.querySelectorAll(
        '[class*="modal" i],[class*="overlay" i],[class*="dialog" i],[class*="popup" i]'
      );
      let found = false;
      for (const ov of overlays) {
        if (!ov.offsetParent) continue;
        const btn = Array.from(ov.querySelectorAll('button, a'))
          .find(b => CLOSE_TEXTS.includes(b.textContent.trim().toLowerCase()));
        if (btn) { btn.click(); await sleep(700); found = true; break; }
      }
      if (!found) break;
      await sleep(500);
    }
  }

  function findExportedFileDownloadBtn(fromDate, toDate) {
    const dlEls = Array.from(document.querySelectorAll('span, button, a, p'))
      .filter(el => {
        if (!el.offsetParent) return false;
        const t = el.textContent.trim().toLowerCase();
        return t === 'download' || t === 'download ↓' || t === '↓ download';
      });

    for (const el of dlEls) {
      let ancestor = el.parentElement;
      for (let lvl = 0; lvl < 6 && ancestor && ancestor !== document.body; lvl++) {
        if (ancestor.textContent.includes(fromDate) && ancestor.textContent.includes(toDate)) {
          return el;
        }
        ancestor = ancestor.parentElement;
      }
    }
    return null;
  }

  try {
    await sleep(4000 + Math.random() * 1000);
    await dismissPopups();

    let dlDropdown = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      dlDropdown = Array.from(document.querySelectorAll('button, [role="button"], p'))
        .find(el => el.offsetParent && /download orders data/i.test(el.textContent.trim()));
      if (dlDropdown) break;
      await sleep(2000);
    }
    if (!dlDropdown) throw new Error('"Download Orders Data" button not found after reload');
    await clickAndWait(dlDropdown, 2000);

    let downloadBtn = findExportedFileDownloadBtn(dateStr, dateStr);

    for (let poll = 1; poll <= 6 && !downloadBtn; poll++) {
      document.body.click();
      await sleep(30000);

      const dlDropdown2 = Array.from(document.querySelectorAll('button, [role="button"], p'))
        .find(el => el.offsetParent && /download orders data/i.test(el.textContent.trim()));
      if (!dlDropdown2) break;
      await clickAndWait(dlDropdown2, 2000);

      downloadBtn = findExportedFileDownloadBtn(dateStr, dateStr);
    }

    if (!downloadBtn) throw new Error(`Exported file for ${dateStr} not found in dropdown`);

    await clickAndWait(downloadBtn, 500);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function runMeOrdersDate(date) {
  const filename = `meesho_orders_${date}.csv`;

  setRow(date, 'running', 'Starting…', '—', 'Navigating to Meesho orders');
  log(`${date}: stage 1 — navigating to orders page`);

  try {
    const tabId = await ensureMeeshoTab(ME_ORDERS_URL);

    await chrome.tabs.update(tabId, { url: ME_ORDERS_URL });
    setRow(date, 'running', 'Loading…', '—', 'Waiting for page load');
    try {
      await waitForTabLoad(tabId, 40000);
    } catch (_) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') throw new Error('Orders page load timeout');
    }
    await new Promise(r => setTimeout(r, 1500));

    setRow(date, 'running', 'Exporting…', '—', 'Requesting export');
    const [{ result: stage1 }] = await chrome.scripting.executeScript({
      target: { tabId }, func: meeshoOrdersExport, args: [date],
    });
    if (!stage1?.success) throw new Error(`Export stage failed: ${stage1?.error || 'unknown'}`);

    log(`${date}: export requested — waiting 35s for file generation`);
    setRow(date, 'running', 'Waiting…', '—', 'Waiting 35s for file generation');
    await new Promise(r => setTimeout(r, 35000));

    log(`${date}: reloading page`);
    setRow(date, 'running', 'Reloading…', '—', 'Reloading page');
    const reloadWait = waitForTabLoad(tabId, 40000);
    await chrome.tabs.reload(tabId);
    try { await reloadWait; }
    catch (_) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') throw new Error('Reload timeout');
    }
    await new Promise(r => setTimeout(r, 1500));

    await chrome.storage.local.remove('backfillDownloadResult');
    const armResp = await bgMessage({ type: 'BACKFILL_ARM', filename, folderKey: 'ME_ORDERS', mimeType: 'text/csv' });
    if (!armResp?.ok) throw new Error('BACKFILL_ARM failed');

    log(`${date}: stage 2 — clicking download`);
    setRow(date, 'running', 'Downloading…', '—', 'Finding exported file');
    const [{ result: stage2 }] = await chrome.scripting.executeScript({
      target: { tabId }, func: meeshoOrdersDownload, args: [date],
    });
    if (!stage2?.success) {
      await bgMessage({ type: 'BACKFILL_DISARM' });
      throw new Error(`Download stage failed: ${stage2?.error || 'unknown'}`);
    }

    log(`${date}: download clicked — waiting for Drive upload`);
    setRow(date, 'running', 'Uploading…', '—', 'Background uploading to Drive');
    let uploadResult;
    try { uploadResult = await pollStorage('backfillDownloadResult', 60000); }
    catch (pollErr) {
      await bgMessage({ type: 'BACKFILL_DISARM' });
      throw new Error(`Upload poll timeout: ${pollErr.message}`);
    }
    await bgMessage({ type: 'BACKFILL_DISARM' });
    if (!uploadResult?.ok) throw new Error(`Drive upload failed: ${uploadResult?.error || 'unknown'}`);

    const sizeStr = uploadResult.bytes ? `${(uploadResult.bytes / 1024).toFixed(1)} KB` : '—';
    setRow(date, 'done', 'DONE ✓', sizeStr, filename);
    log(`${date}: SUCCESS — ${filename} (${sizeStr})`);
    await postBackfillSuccess('me_orders', date);
    return true;

  } catch (err) {
    setRow(date, 'error', 'ERROR', '—', err.message);
    log(`${date}: ERROR — ${err.message}`);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ─── me_payments — copied verbatim from me-payments-backfill.js ────────────
// ══════════════════════════════════════════════════════════════════════════

const ME_PAYMENTS_URL = `https://supplier.meesho.com/panel/v3/new/payouts/${MEESHO_SUPPLIER_SLUG}/payments`;

async function meeshoPaymentsDownload(dateStr) {
  const sendLog = msg => chrome.runtime.sendMessage({ type: 'ME_PAYMENTS_BF_LOG', date: dateStr, msg });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function clickAndWait(el, ms = 800) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return sleep(200 + Math.random() * 100).then(() => { el.click(); return sleep(ms + Math.random() * 200); });
  }

  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function clickCalendarDate(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const DAYS       = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const MONTHS_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const localDate  = new Date(y, m - 1, d);
    const label1 = `${DAYS[localDate.getDay()]} ${MONTHS_ABR[m-1]} ${String(d).padStart(2,'0')} ${y}`;
    const label2 = `${MONTHS_ABR[m-1]} ${d}, ${y}`;
    const targetKey = y * 12 + (m - 1);

    for (let nav = 0; nav < 14; nav++) {
      const already = document.querySelector(
        `[aria-label="${label1}"], [aria-label="${label2}"], [data-date="${isoDate}"]`
      );
      if (already) break;

      let displayedKey = null;
      const headerEl = Array.from(document.querySelectorAll('*')).find(el => {
        if (!el.offsetParent || el.children.length > 3) return false;
        return /^[A-Za-z]+ \d{4}$/.test(el.textContent.trim());
      });
      if (headerEl) {
        const parts = headerEl.textContent.trim().split(' ');
        const hmIdx = MONTHS_ABR.findIndex(a => parts[0].startsWith(a));
        if (hmIdx !== -1) displayedKey = parseInt(parts[1]) * 12 + hmIdx;
      }

      const goNext = displayedKey !== null ? displayedKey < targetKey : false;
      const navBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => {
          if (!el.offsetParent) return false;
          const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
          const cls = (el.className || '').toLowerCase();
          const txt = el.textContent.trim();
          return goNext
            ? (lbl.includes('next') || /next/i.test(cls) || ['>','›','→','»'].includes(txt))
            : (lbl.includes('prev') || lbl.includes('back') || /prev/i.test(cls) ||
               ['<','‹','←','«'].includes(txt));
        });
      if (!navBtn) break;
      navBtn.click();
      await sleep(600);
    }

    const cell = document.querySelector(
      `[aria-label="${label1}"], [aria-label="${label2}"], [data-date="${isoDate}"]`
    );
    if (cell) { await clickAndWait(cell, 300); return true; }

    const calRoot = document.querySelector(
      '[class*="calendar"],[class*="Calendar"],[class*="datepicker"],[role="grid"]'
    ) || document;
    const dayCells = Array.from(calRoot.querySelectorAll(
      'button[class*="day"],button[class*="Day"],td,[role="gridcell"],[role="option"]'
    )).filter(el => el.textContent.trim() === String(d) && el.offsetParent !== null);
    if (dayCells.length > 0) { await clickAndWait(dayCells[0], 300); return true; }

    return false;
  }

  async function fillDates(fromISO, toISO) {
    const dateInputs = Array.from(document.querySelectorAll('input[type="date"]'));
    if (dateInputs.length >= 2) {
      setValue(dateInputs[0], fromISO); await sleep(300);
      setValue(dateInputs[1], toISO);   await sleep(300);
      return;
    }
    const fromOk = await clickCalendarDate(fromISO);
    await sleep(500);
    const toOk   = await clickCalendarDate(toISO);
    if (fromOk && toOk) return;

    const ddmmyyyy = iso => { const [yr, mo, dy] = iso.split('-'); return `${dy}/${mo}/${yr}`; };
    const textInputs = Array.from(document.querySelectorAll(
      'input[type="text"][placeholder*="From" i], input[type="text"][placeholder*="To" i], ' +
      'input[type="text"][placeholder*="DD" i], input[type="text"][placeholder*="date" i], ' +
      'input[type="text"][placeholder*="Select" i]'
    )).filter(el => el.offsetParent);
    if (textInputs.length >= 2) {
      setValue(textInputs[0], ddmmyyyy(fromISO)); await sleep(300);
      setValue(textInputs[1], ddmmyyyy(toISO));   await sleep(300);
    }
  }

  async function dismissPopups() {
    const CLOSE_TEXTS = ['close', 'skip', 'got it', 'ok', 'dismiss', 'maybe later', 'not now', '✕', '×'];
    for (let round = 0; round < 3; round++) {
      const closeBtn = Array.from(document.querySelectorAll(
        '[aria-label="close" i],[aria-label="Close"],[aria-label="dismiss" i],' +
        'button[class*="close" i],button[class*="dismiss" i],' +
        '[data-testid*="close" i],[data-testid*="dismiss" i]'
      )).find(el => el.offsetParent);
      if (closeBtn) { closeBtn.click(); await sleep(700); continue; }

      const overlays = document.querySelectorAll(
        '[class*="modal" i],[class*="overlay" i],[class*="dialog" i],[class*="popup" i]'
      );
      let found = false;
      for (const ov of overlays) {
        if (!ov.offsetParent) continue;
        const btn = Array.from(ov.querySelectorAll('button, a'))
          .find(b => CLOSE_TEXTS.includes(b.textContent.trim().toLowerCase()));
        if (btn) { btn.click(); await sleep(700); found = true; break; }
      }
      if (!found) break;
      await sleep(500);
    }
  }

  try {
    sendLog('Page settling...');
    await sleep(4000 + Math.random() * 1000);
    await dismissPopups();

    let dlBtn = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      dlBtn = Array.from(document.querySelectorAll('p, button, [role="button"]'))
        .find(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download');
      if (dlBtn) break;
      sendLog(`Download dropdown not found (attempt ${attempt}/5) — waiting 2s...`);
      await sleep(2000);
    }
    if (!dlBtn) throw new Error('Download dropdown not found after 5 attempts');

    sendLog('Clicking Download dropdown...');
    await clickAndWait(dlBtn, 1200);

    const paymentsToDate = Array.from(document.querySelectorAll('p, li, [role="option"], button'))
      .find(el => el.offsetParent && el.textContent.trim() === 'Payments to Date');
    if (!paymentsToDate) throw new Error('"Payments to Date" option not found');
    sendLog('Clicking Payments to Date...');
    await clickAndWait(paymentsToDate, 1500);

    const customOpt = Array.from(document.querySelectorAll('input[type="radio"], label, li, button'))
      .find(el => el.offsetParent && /custom date range/i.test(el.textContent.trim()));
    if (customOpt) {
      const radio = customOpt.querySelector('input[type="radio"]') || customOpt;
      radio.click();
      await sleep(800);
      sendLog('Selected Custom Date Range');
    } else {
      sendLog('Custom Date Range radio not found — proceeding');
    }

    sendLog(`Filling dates: ${dateStr} → ${dateStr}`);
    await fillDates(dateStr, dateStr);
    await sleep(600);

    let finalBtn = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      finalBtn = Array.from(document.querySelectorAll('button'))
        .find(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download');
      if (finalBtn) break;
      await sleep(1000);
    }
    if (!finalBtn) throw new Error('Final Download button in modal not found');

    sendLog('Clicking Download — background will intercept...');
    await clickAndWait(finalBtn, 500);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function runMePaymentsDate(date) {
  setRow(date, 'running', 'Starting…', '—', 'Navigating to Meesho payments');
  log(`${date}: navigating to payments page`);

  try {
    const tabId = await ensureMeeshoTab(ME_PAYMENTS_URL);

    await chrome.tabs.update(tabId, { url: ME_PAYMENTS_URL });
    setRow(date, 'running', 'Loading…', '—', 'Waiting for page load');
    try { await waitForTabLoad(tabId, 40000); }
    catch (_) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') throw new Error('Payments page load timeout');
    }
    await new Promise(r => setTimeout(r, 1500));

    setRow(date, 'running', 'Running…', '—', 'Script injected');

    const logListener = msg => {
      if (msg.type === 'ME_PAYMENTS_BF_LOG' && msg.date === date) {
        log(`  ${date}: ${msg.msg}`);
        setRow(date, 'running', 'Running…', '—', msg.msg.slice(0, 60));
      }
    };
    chrome.runtime.onMessage.addListener(logListener);

    const xlsxFilename = `meesho_payments_${date}.xlsx`;

    await chrome.storage.local.remove('backfillDownloadResult');
    const armResp = await bgMessage({
      type: 'BACKFILL_ARM', filename: xlsxFilename,
      folderKey: 'ME_PAYMENTS', mimeType: 'application/zip',
    });
    if (!armResp?.ok) throw new Error('BACKFILL_ARM failed');

    let clickResult;
    try {
      const [{ result: r }] = await chrome.scripting.executeScript({
        target: { tabId }, func: meeshoPaymentsDownload, args: [date],
      });
      clickResult = r;
    } finally {
      chrome.runtime.onMessage.removeListener(logListener);
    }

    if (!clickResult?.success) {
      await bgMessage({ type: 'BACKFILL_DISARM' });
      throw new Error(clickResult?.error || 'Download click failed');
    }

    setRow(date, 'running', 'Uploading…', '—', 'Waiting for background to fetch + upload');
    let uploadResult;
    try { uploadResult = await pollStorage('backfillDownloadResult', 60000); }
    catch (pollErr) {
      await bgMessage({ type: 'BACKFILL_DISARM' });
      throw new Error(`Upload poll timeout: ${pollErr.message}`);
    }
    await bgMessage({ type: 'BACKFILL_DISARM' });

    if (uploadResult?.ok) {
      const sizeStr = uploadResult.bytes ? `${(uploadResult.bytes / 1024).toFixed(1)} KB` : '—';
      setRow(date, 'done', 'DONE ✓', sizeStr, uploadResult.filename || '');
      log(`${date}: SUCCESS — ${uploadResult.filename} (${sizeStr})`);
      await postBackfillSuccess('me_payments', date);
      return true;
    } else {
      const errMsg = uploadResult?.error || 'Unknown error';
      setRow(date, 'error', 'ERROR', '—', errMsg);
      log(`${date}: ERROR — ${errMsg}`);
      return false;
    }

  } catch (err) {
    setRow(date, 'error', 'ERROR', '—', err.message);
    log(`${date}: FAILED — ${err.message}`);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ─── me_payments_upload — copied verbatim from me-payments-upload.js ───────
// (the hardcoded one-off "Duplicate Cleanup — Jun 1" block from the original
// file is NOT carried over — confirmed dead: it targets two specific,
// already-resolved Drive file IDs from a single past incident, not general
// logic. Everything else — ZIP extraction, date-from-filename, upload — is
// unchanged.)
// ══════════════════════════════════════════════════════════════════════════

let selectedZipFiles = []; // { file, date, rowId }

function extractZipDate(filename) {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function extractXlsxFromZip(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4B || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return buffer;
  }
  const view   = new DataView(buffer);
  const method = view.getUint16(8,  true);
  let compSz   = view.getUint32(18, true);
  const fnLen  = view.getUint16(26, true);
  const exLen  = view.getUint16(28, true);
  const dataOff = 30 + fnLen + exLen;

  if (compSz === 0) {
    let eocdOff = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
        eocdOff = i; break;
      }
    }
    if (eocdOff < 0) return buffer;
    const cdOff = view.getUint32(eocdOff + 16, true);
    compSz = view.getUint32(cdOff + 20, true);
  }

  const compressed = bytes.slice(dataOff, dataOff + compSz);
  if (method === 0) return compressed.buffer;

  if (method === 8) {
    const ds     = new DecompressionStream('deflate-raw');
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
    const out   = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
  }

  return buffer;
}

function renderZipTable(entries) {
  const tbody = document.getElementById('zipTbody');
  tbody.innerHTML = '';
  const tbl = document.getElementById('zipFileTable');
  if (entries.length === 0) { tbl.style.display = 'none'; return; }
  tbl.style.display = '';
  for (const e of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.file.name}">${e.file.name}</td>` +
      `<td>${e.date || '—'}</td>` +
      `<td class="waiting" id="zst-${e.rowId}">Pending</td>` +
      `<td id="zsz-${e.rowId}">—</td>` +
      `<td id="zdet-${e.rowId}">—</td>`;
    tbody.appendChild(tr);
  }
}

function setZipRow(rowId, cls, status, size, detail) {
  const st  = document.getElementById(`zst-${rowId}`);
  const sz  = document.getElementById(`zsz-${rowId}`);
  const det = document.getElementById(`zdet-${rowId}`);
  if (st)  { st.className = cls; st.textContent = status; }
  if (sz)  sz.textContent = size || '—';
  if (det) det.textContent = detail || '';
}

function processZipFiles(fileList) {
  selectedZipFiles = [];
  let idx = 0;
  for (const f of fileList) {
    if (!f.name.toLowerCase().endsWith('.zip')) continue;
    const date = extractZipDate(f.name);
    selectedZipFiles.push({ file: f, date, rowId: idx++ });
  }
  selectedZipFiles.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });

  const noDate = selectedZipFiles.filter(e => !e.date).length;
  document.getElementById('zipFileCount').textContent =
    `${selectedZipFiles.length} ZIP file${selectedZipFiles.length !== 1 ? 's' : ''} selected` +
    (noDate ? ` (${noDate} without a recognisable date — will be skipped)` : '');

  document.getElementById('zipUploadBtn').disabled = selectedZipFiles.length === 0;
  renderZipTable(selectedZipFiles);
}

async function uploadOneZip(entry) {
  if (!entry.date) {
    setZipRow(entry.rowId, 'skip', 'SKIPPED', '—', 'No date in filename');
    log(`${entry.file.name}: SKIPPED — no date found`);
    return false;
  }

  setZipRow(entry.rowId, 'running', 'Reading…', '—', 'Reading ZIP');
  let buffer;
  try { buffer = await entry.file.arrayBuffer(); }
  catch (err) {
    setZipRow(entry.rowId, 'error', 'ERROR', '—', `Read failed: ${err.message}`);
    return false;
  }

  let xlsxBuf;
  try { xlsxBuf = await extractXlsxFromZip(buffer); }
  catch (err) {
    setZipRow(entry.rowId, 'error', 'ERROR', '—', `ZIP extract failed: ${err.message}`);
    return false;
  }

  const xlsxBytes = new Uint8Array(xlsxBuf);
  let binary = ''; const CHUNK = 8192;
  for (let i = 0; i < xlsxBytes.length; i += CHUNK)
    binary += String.fromCharCode.apply(null, xlsxBytes.subarray(i, i + CHUNK));
  const base64 = btoa(binary);

  const filename = `meesho_payments_${entry.date}.xlsx`;
  const sizeStr  = `${(xlsxBuf.byteLength / 1024).toFixed(1)} KB`;
  setZipRow(entry.rowId, 'running', 'Uploading…', sizeStr, `→ ${filename}`);

  const resp = await bgMessage({
    type: 'UPLOAD_DATA_SILENT', jobId: 'me_payments_upload',
    data: base64, encoding: 'base64', filename,
    folderKey: 'ME_PAYMENTS',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  if (resp?.ok) {
    setZipRow(entry.rowId, 'done', 'DONE ✓', sizeStr, filename);
    log(`${entry.date}: SUCCESS — ${filename}`);
    await postBackfillSuccess('me_payments', entry.date);
    return true;
  } else {
    setZipRow(entry.rowId, 'error', 'ERROR', sizeStr, 'Drive upload returned ok=false');
    log(`${entry.date}: UPLOAD FAILED — Drive returned ok=false`);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ─── fk_returns — copied verbatim from test-returns.js ─────────────────────
// ══════════════════════════════════════════════════════════════════════════

async function fkReturnsDirectDownload(dateStr, uploadCfg) {
  const sendLog  = msg => chrome.runtime.sendMessage({ type: 'FK_RETURNS_BF_LOG', date: dateStr, msg });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function findEl(texts, selector) {
    const arr = Array.isArray(texts) ? texts : [texts];
    return Array.from(document.querySelectorAll(selector)).find(el => {
      if (!el.offsetParent) return false;
      const t = el.textContent.trim();
      return arr.some(tx => t === tx || t === tx + tx || t.toLowerCase() === tx.toLowerCase());
    }) || null;
  }

  async function navigateToAllReturns() {
    if (!window.location.hash.includes('returnsV2')) {
      window.location.hash = '#dashboard/returnsV2';
      await sleep(4000);
    }
    if (!window.location.hash.includes('returnsV2')) {
      throw new Error(`Hash nav failed — still at: ${window.location.hash}`);
    }

    let allTab = null;
    const tabDeadline = Date.now() + 8000;
    while (!allTab && Date.now() < tabDeadline) {
      allTab = Array.from(document.querySelectorAll('button, [role="tab"], a, span, div'))
        .filter(el => el.offsetParent)
        .find(el => el.textContent.trim() === 'All Returns') || null;
      if (!allTab) await sleep(1000);
    }
    if (!allTab) {
      const vis = Array.from(document.querySelectorAll('button, [role="tab"], a'))
        .filter(el => el.offsetParent && el.textContent.trim().length < 40)
        .map(el => `"${el.textContent.trim()}"`)
        .join(', ');
      throw new Error(`"All Returns" tab not found. Visible: [${vis}]`);
    }
    allTab.click();
    await sleep(3500);
  }

  async function waitForDateFilter() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const el = Array.from(document.querySelectorAll('button, div, span, [role="button"]'))
        .filter(el => el.offsetParent)
        .find(el => el.textContent.trim() === 'Date of Closure');
      if (el) return el;
      await sleep(1000);
    }
    const vis = Array.from(document.querySelectorAll('button, div, span'))
      .filter(el => el.offsetParent && el.textContent.trim().length > 2 && el.textContent.trim().length < 40)
      .slice(0, 25)
      .map(el => `"${el.textContent.trim()}"`)
      .join(', ');
    throw new Error(`"Date of Closure" filter never appeared. Visible elements: [${vis}]`);
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function getCalendarPanels() {
    return Array.from(document.querySelectorAll('[class*="CalendarMonth"]'))
      .filter(el => el.querySelectorAll('td').length >= 28);
  }

  function getPanelMonth(panel) {
    const hdr = Array.from(panel.querySelectorAll('*'))
      .find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && /^[A-Z][a-z]{2} \d{4}$/.test(el.textContent.trim()); });
    if (!hdr) return null;
    const [mName, yStr] = hdr.textContent.trim().split(' ');
    return { year: parseInt(yStr, 10), month: MONTHS.indexOf(mName) + 1 };
  }

  async function goToCalendarMonth(targetYear, targetMonth) {
    for (let step = 0; step < 14; step++) {
      const panels = getCalendarPanels();
      if (!panels.length) throw new Error('No CalendarMonth panels found — calendar not open?');

      for (const p of panels) {
        const m = getPanelMonth(p);
        if (m && m.year === targetYear && m.month === targetMonth) return p;
      }

      const firstM = getPanelMonth(panels[0]);
      if (!firstM) throw new Error('Could not read calendar month from first panel');
      const goNext = (targetYear * 12 + targetMonth) > (firstM.year * 12 + firstM.month);

      const navBtn = Array.from(document.querySelectorAll('button'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.width < 60; })
        .find(el => {
          const cls = (el.className || '') + (el.getAttribute('aria-label') || '');
          return goNext
            ? (cls.toLowerCase().includes('next') || cls.toLowerCase().includes('right') || cls.toLowerCase().includes('forward'))
            : (cls.toLowerCase().includes('prev') || cls.toLowerCase().includes('left')  || cls.toLowerCase().includes('back'));
        });
      if (!navBtn) throw new Error(`Calendar ${goNext ? 'next' : 'prev'} nav button not found`);
      navBtn.click();
      await sleep(700);
    }
    throw new Error(`Could not navigate calendar to ${MONTHS[targetMonth - 1]} ${targetYear}`);
  }

  try {
    sendLog('Waiting for SPA to settle...');
    await sleep(3000);

    sendLog('Navigating to All Returns page...');
    await navigateToAllReturns();

    sendLog('Waiting for filter bar...');
    const dateFilterEl = await waitForDateFilter();
    sendLog(`Opening Date of Closure calendar for ${dateStr}...`);
    dateFilterEl.click();
    await sleep(1500);

    const [yStr, mStr, dStr] = dateStr.split('-');
    const targetYear  = parseInt(yStr, 10);
    const targetMonth = parseInt(mStr, 10);
    const dayNum      = parseInt(dStr, 10);

    sendLog(`Navigating calendar to ${targetYear}-${targetMonth}...`);
    const calPanel = await goToCalendarMonth(targetYear, targetMonth);

    const dayStr2 = String(dayNum);
    const dayCells = Array.from(calPanel.querySelectorAll('td'))
      .filter(el => el.textContent.trim() === dayStr2);

    if (dayCells.length === 0) {
      const allDays = Array.from(calPanel.querySelectorAll('td'))
        .map(el => `"${el.textContent.trim()}"`)
        .join(', ');
      throw new Error(`Day ${dayNum} not found in panel. Panel TDs: [${allDays}]`);
    }
    dayCells[0].click();
    await sleep(800);

    const applyBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(el => el.offsetParent)
      .find(el => el.textContent.trim() === 'Apply');
    if (!applyBtn) throw new Error('"Apply" button not found after selecting date');
    applyBtn.click();
    await sleep(2000);

    sendLog('Clicking Request Download...');
    const reqDlBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => el.offsetParent && el.textContent.includes('Request Download'));
    if (!reqDlBtn) throw new Error('"Request Download" button not found');

    const submitResult = await new Promise(resolve => {
      const handler = e => {
        if (!e.data?.__rumeeSubmitReport) return;
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        resolve(e.data);
      };
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 10000);
      window.addEventListener('message', handler);
      reqDlBtn.click();
    });

    sendLog(`submitReport status: ${submitResult ? submitResult.status : 'no event (timeout)'}`);

    const STORAGE_KEY = `fk_returns_reqtime_${dateStr}`;
    let requestedAt;

    const httpStatus = submitResult ? submitResult.status : 0;
    const isNew = httpStatus >= 200 && httpStatus < 300;
    const isDuplicate = httpStatus >= 400;

    if (isNew) {
      requestedAt = Date.now();
      await chrome.storage.local.set({ [STORAGE_KEY]: requestedAt });
      sendLog('Request accepted (HTTP ' + httpStatus + ') — waiting 25s for FK to process...');
      await sleep(25000);
    } else if (isDuplicate) {
      const bannerText = document.documentElement.innerHTML;
      const m = bannerText.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      if (m) {
        requestedAt = new Date(m[1]).getTime();
        sendLog(`Duplicate (HTTP ${httpStatus}) — original request at ${new Date(requestedAt).toLocaleTimeString()}`);
      } else {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        requestedAt = stored[STORAGE_KEY];
        if (!requestedAt) throw new Error(`Duplicate (HTTP ${httpStatus}) — cannot find original request time.`);
        sendLog(`Duplicate — using stored time: ${new Date(requestedAt).toLocaleTimeString()}`);
      }
    } else {
      requestedAt = Date.now();
      await chrome.storage.local.set({ [STORAGE_KEY]: requestedAt });
      sendLog(`No submitReport event (status=${httpStatus}) — assuming accepted. Waiting 25s...`);
      await sleep(25000);
    }

    const panelBtn = () => Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => el.textContent.includes('Previous Downloads'));
    const isPanelOpen = () => document.documentElement.innerHTML.includes('Requested On');

    const openPanel = async () => {
      if (!isPanelOpen()) {
        const btn = panelBtn();
        if (!btn) throw new Error('"Previous Downloads" button not found');
        btn.click();
        await sleep(1500);
      }
    };
    const closePanel = async () => {
      if (isPanelOpen()) {
        const btn = panelBtn();
        if (btn) { btn.click(); await sleep(800); }
      }
    };

    const MON = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    const parseReqOn = (text) => {
      const m = text.match(/(\d{1,2}):(\d{2}),\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/);
      if (!m) return null;
      const [, h, min, mon, day, yr] = m;
      const mo = MON[mon];
      return mo !== undefined ? new Date(+yr, mo, +day, +h, +min).getTime() : null;
    };

    const getOurRow = () => {
      const timeRe = /\d{1,2}:\d{2},\s*\w+\s+\d{1,2},\s*\d{4}/;
      const candidates = Array.from(document.querySelectorAll('tr, [role="row"], div, li'))
        .filter(el => {
          const txt = el.textContent;
          return timeRe.test(txt) && (txt.includes('Pending') || txt.includes('Ready to download'));
        });

      sendLog(`getOurRow: ${candidates.length} candidates, requestedAt=${new Date(requestedAt).toLocaleTimeString()}`);
      if (!candidates.length) return null;

      candidates.sort((a, b) => a.textContent.length - b.textContent.length);

      let bestRow = null, bestDiff = Infinity;
      for (const el of candidates) {
        const t = parseReqOn(el.textContent);
        if (t === null) continue;
        const diff = Math.abs(t - requestedAt);
        sendLog(`  candidate time=${new Date(t).toLocaleTimeString()} diff=${Math.round(diff/1000)}s`);
        if (diff < bestDiff) { bestDiff = diff; bestRow = el; }
      }
      return bestDiff <= 5 * 60 * 1000 ? bestRow : candidates[0];
    };

    const DEADLINE = Date.now() + 5 * 60 * 1000;
    let downloadUrl = null;

    await openPanel();

    while (Date.now() < DEADLINE) {
      const row = getOurRow();

      if (row && row.textContent.includes('Ready to download')) {
        sendLog('Status: Ready to download — locating Download element...');

        const dlEl = Array.from(row.querySelectorAll('*'))
          .find(el => el.textContent.trim() === 'Download' && !el.children.length);

        sendLog(`Download el: ${dlEl ? dlEl.tagName + ' href=' + (dlEl.href || 'none') : 'NOT FOUND'}`);

        if (dlEl) {
          const a = dlEl.tagName === 'A' ? dlEl : dlEl.closest('a');
          if (a?.href && !a.href.startsWith('javascript') && !a.href.endsWith('#')) {
            downloadUrl = a.href;
            break;
          }
          for (let clickAttempt = 1; clickAttempt <= 3 && !downloadUrl; clickAttempt++) {
            const capturePromise = new Promise((res, rej) => {
              const t = setTimeout(() => {
                window.removeEventListener('message', h);
                rej(new Error('Download click: no URL captured in 15s'));
              }, 15000);
              function h(e) {
                if (!e.data?.__rumeeDownload) return;
                clearTimeout(t);
                window.removeEventListener('message', h);
                res(e.data.url);
              }
              window.addEventListener('message', h);
            });
            window.postMessage({ __rumeeArmCapture: true }, '*');
            await sleep(80);
            dlEl.click();
            try { downloadUrl = await capturePromise; }
            catch(e) { sendLog(`Click intercept failed (attempt ${clickAttempt}/3): ${e.message}`); }
            window.postMessage({ __rumeeArmCapture: false }, '*');
          }
        }
        break;
      }

      const remainSec = Math.round((DEADLINE - Date.now()) / 1000);
      sendLog(`Pending... ${remainSec}s left`);
      await closePanel();
      await sleep(12000);
      await openPanel();
    }

    if (!downloadUrl) throw new Error('No download URL — check log above for row HTML and Download element details');

    sendLog(`Fetching: ${downloadUrl.slice(0, 80)}...`);
    const resp = await fetch(downloadUrl, { credentials: 'include' });
    if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status} ${resp.statusText}`);
    const buffer = await resp.arrayBuffer();
    const bytes  = new Uint8Array(buffer);

    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));

    sendLog(`Downloaded ${bytes.length} bytes — uploading to Drive...`);

    const filename = `flipkart_returns_${dateStr}.csv`;
    await new Promise(res => chrome.runtime.sendMessage({
      type: 'UPLOAD_DATA_SILENT', jobId: 'fk_returns_direct',
      data: btoa(binary), encoding: 'base64', filename,
      folderKey: uploadCfg.folderKey, mimeType: uploadCfg.mimeType,
    }, res));

    return { success: true, bytes: bytes.length, filename };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function runFkReturnsDate(date) {
  const UPLOAD_CONFIG = { folderKey: 'FK_RETURNS', mimeType: 'text/csv' };

  setRow(date, 'running', 'Starting…', '—', 'Opening FK tab');
  log(`${date}: starting`);

  try {
    const tabId = await ensureFkTab();

    setRow(date, 'running', 'Loading…', '—', 'Navigating FK Seller Hub');
    await chrome.tabs.update(tabId, { url: 'https://seller.flipkart.com/' });
    await waitForTabLoad(tabId, 35000);
    await new Promise(r => setTimeout(r, 1000));

    setRow(date, 'running', 'Injecting…', '—', 'Script injected');

    const logListener = msg => {
      if (msg.type === 'FK_RETURNS_BF_LOG' && msg.date === date) {
        log(`  ${date}: ${msg.msg}`);
        setRow(date, 'running', 'Running…', '—', msg.msg.slice(0, 60));
      }
    };
    chrome.runtime.onMessage.addListener(logListener);

    let result;
    try {
      const [{ result: r }] = await chrome.scripting.executeScript({
        target: { tabId }, func: fkReturnsDirectDownload, args: [date, UPLOAD_CONFIG],
      });
      result = r;
    } finally {
      chrome.runtime.onMessage.removeListener(logListener);
    }

    if (result?.success) {
      const sizeStr = result.bytes ? `${(result.bytes / 1024).toFixed(1)} KB` : '—';
      setRow(date, 'done', 'DONE ✓', sizeStr, result.filename || '');
      log(`${date}: SUCCESS — ${result.filename} (${sizeStr})`);
      await postBackfillSuccess('fk_returns_download', date);
      return true;
    } else {
      const errMsg = result?.error || 'Unknown error';
      setRow(date, 'error', 'ERROR', '—', errMsg);
      log(`${date}: ERROR — ${errMsg}`);
      return false;
    }
  } catch (err) {
    setRow(date, 'error', 'ERROR', '—', err.message);
    log(`${date}: FAILED — ${err.message}`);
    return false;
  }
}

// ─── Report dispatch ─────────────────────────────────────────────────────────

function runnerFor(reportKey) {
  if (reportKey === 'me_orders')   return runMeOrdersDate;
  if (reportKey === 'me_payments') return runMePaymentsDate;
  if (reportKey === 'fk_returns')  return runFkReturnsDate;
  throw new Error(`No date-range runner for ${reportKey}`);
}

// ─── Pending / Manual Action Needed panel ───────────────────────────────────
// Reads the same chrome.storage.local.gapCatchupManual list the popup's own
// "Manual Action Needed" section already renders (see popup.js
// renderGapCatchupManual). Entries whose jobId matches a report this hub can
// run get a "Backfill →" action that pre-fills the picker; others are shown
// read-only (that report type isn't backfillable from here yet).

function reportKeyForGapJobId(jobId) {
  for (const [key, cfg] of Object.entries(REPORT_TYPES)) {
    if (cfg.gapJobId === jobId && cfg.mode === 'daterange') return key;
  }
  return null;
}

function renderPending() {
  chrome.storage.local.get('gapCatchupManual', ({ gapCatchupManual = [] }) => {
    const section = document.getElementById('pendingSection');
    const list = document.getElementById('pendingList');
    if (!gapCatchupManual.length) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    list.innerHTML = gapCatchupManual.map((item, i) => {
      const reportKey = reportKeyForGapJobId(item.jobId);
      const actionHtml = reportKey
        ? `<button class="pending-action" data-i="${i}" data-report="${reportKey}">Backfill →</button>`
        : `<span class="pending-noaction">not backfillable here yet</span>`;
      return `
        <div class="pending-row">
          <div>
            <div class="pending-job">${item.jobId} — ${item.date}</div>
            <div class="pending-reason">${item.daysPending ? `${item.daysPending}d pending` : ''} ${item.escalatedAt || ''}</div>
          </div>
          ${actionHtml}
        </div>`;
    }).join('');

    list.querySelectorAll('.pending-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        const item = gapCatchupManual[i];
        const reportKey = btn.dataset.report;
        document.getElementById('reportSelect').value = reportKey;
        onReportChange();
        document.getElementById('fromDate').value = item.date;
        document.getElementById('toDate').value = item.date;
        document.getElementById('controls').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  });
}

// ─── Main wiring ─────────────────────────────────────────────────────────────

function onReportChange() {
  const key = document.getElementById('reportSelect').value;
  const cfg = REPORT_TYPES[key];
  document.getElementById('daterangeControls').classList.toggle('hidden', cfg.mode !== 'daterange');
  document.getElementById('uploadControls').classList.toggle('hidden', cfg.mode !== 'upload');
}

document.addEventListener('DOMContentLoaded', () => {
  const select = document.getElementById('reportSelect');
  select.innerHTML = Object.entries(REPORT_TYPES)
    .map(([key, cfg]) => `<option value="${key}">${cfg.label}</option>`).join('');
  select.addEventListener('change', onReportChange);
  onReportChange();
  renderPending();
});

document.getElementById('runBtn').addEventListener('click', async () => {
  const key = document.getElementById('reportSelect').value;
  const fromDate = document.getElementById('fromDate').value;
  const toDate   = document.getElementById('toDate').value;
  if (!fromDate || !toDate) { alert('Set both From and To dates.'); return; }
  if (fromDate > toDate)    { alert('From must be ≤ To.'); return; }

  stopRequested = false;
  document.getElementById('runBtn').disabled  = true;
  document.getElementById('stopBtn').disabled = false;

  const runner = runnerFor(key);
  const dates = dateRange(fromDate, toDate);
  initTable(dates);
  log(`=== ${REPORT_TYPES[key].label} backfill started: ${fromDate} → ${toDate} (${dates.length} date${dates.length > 1 ? 's' : ''}) ===`);

  let ok = 0, fail = 0;
  for (const date of dates) {
    if (stopRequested) { log('Stopped by user.'); break; }
    const success = await runner(date);
    success ? ok++ : fail++;
    if (!stopRequested && date !== dates[dates.length - 1])
      await new Promise(r => setTimeout(r, 3000));
  }

  document.getElementById('summary').textContent =
    `Done: ${ok} succeeded, ${fail} failed out of ${ok + fail} dates processed.`;
  document.getElementById('runBtn').disabled  = false;
  document.getElementById('stopBtn').disabled = true;
  log(`=== Backfill complete: ${ok} OK, ${fail} failed ===`);
});

document.getElementById('stopBtn').addEventListener('click', () => {
  stopRequested = true;
  document.getElementById('stopBtn').disabled = true;
  log('Stop requested — will finish current date then stop.');
});

// ─── ZIP upload mode wiring ──────────────────────────────────────────────────

const zipDropZone  = document.getElementById('zipDropZone');
const zipFileInput = document.getElementById('zipFileInput');

zipDropZone.addEventListener('click', () => zipFileInput.click());
zipFileInput.addEventListener('change', () => processZipFiles(zipFileInput.files));
zipDropZone.addEventListener('dragover', e => { e.preventDefault(); zipDropZone.classList.add('drag-over'); });
zipDropZone.addEventListener('dragleave', () => zipDropZone.classList.remove('drag-over'));
zipDropZone.addEventListener('drop', e => {
  e.preventDefault();
  zipDropZone.classList.remove('drag-over');
  processZipFiles(e.dataTransfer.files);
});

document.getElementById('zipClearBtn').addEventListener('click', () => {
  selectedZipFiles = [];
  zipFileInput.value = '';
  document.getElementById('zipFileCount').textContent = '';
  document.getElementById('zipUploadBtn').disabled = true;
  document.getElementById('zipFileTable').style.display = 'none';
});

document.getElementById('zipUploadBtn').addEventListener('click', async () => {
  if (selectedZipFiles.length === 0) return;

  document.getElementById('zipUploadBtn').disabled = true;
  document.getElementById('zipClearBtn').disabled  = true;
  log(`=== ZIP upload started: ${selectedZipFiles.length} files ===`);

  let ok = 0, fail = 0, skip = 0;
  for (const entry of selectedZipFiles) {
    const success = await uploadOneZip(entry);
    if (!entry.date) skip++;
    else if (success) ok++;
    else fail++;
  }

  const parts = [`${ok} uploaded`];
  if (fail) parts.push(`${fail} failed`);
  if (skip) parts.push(`${skip} skipped (no date)`);
  document.getElementById('summary').textContent = parts.join(', ') + ` out of ${selectedZipFiles.length} files.`;
  document.getElementById('zipUploadBtn').disabled = false;
  document.getElementById('zipClearBtn').disabled  = false;
  log(`=== ZIP upload done: ${ok} OK, ${fail} failed, ${skip} skipped ===`);
});
