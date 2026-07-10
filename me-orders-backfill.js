// me-orders-backfill.js — Standalone Meesho Orders Backfill
// Open via: chrome-extension://<id>/me-orders-backfill.html
// Does NOT modify any existing extension files (except background.js additions).
//
// Flow per date (two-stage):
//   Stage 1: Navigate orders tab → inject meeshoOrdersExport(date) →
//            Export data → return { success: true }
//   Outer:   Wait 35 s → reload tab → wait for load → send BACKFILL_ARM
//   Stage 2: Inject meeshoOrdersDownload(date) → open dropdown →
//            find exported file → click Download → return { success: true }
//   Background downloads.onCreated intercepts → fetches CSV → uploads to Drive
//   Outer:   Poll chrome.storage.local.backfillDownloadResult up to 60 s → done

const ORDERS_URL = `https://supplier.meesho.com/panel/v3/new/fulfillment/${MEESHO_SUPPLIER_SLUG}/orders/`;
const FOLDER_KEY = 'ME_ORDERS';
const MIME_TYPE  = 'text/csv';

let stopRequested = false;
let activeMeTabId = null;

// ─── UI ───────────────────────────────────────────────────────────────────────

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

// ─── Tab management ───────────────────────────────────────────────────────────

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

async function ensureMeeshoTab() {
  if (activeMeTabId) {
    try {
      await chrome.tabs.get(activeMeTabId);
      return activeMeTabId;
    } catch (_) {
      activeMeTabId = null;
    }
  }
  const existing = await chrome.tabs.query({ url: 'https://supplier.meesho.com/*' });
  if (existing.length > 0) {
    activeMeTabId = existing[0].id;
    return activeMeTabId;
  }
  const tab = await chrome.tabs.create({ url: ORDERS_URL, active: false });
  activeMeTabId = tab.id;
  await waitForTabLoad(tab.id);
  return activeMeTabId;
}

// ─── Stage 1 injected function ────────────────────────────────────────────────
// Runs inside the Meesho supplier tab (isolated world via executeScript).
// Self-contained — no references to outer scope.
// Opens "Download Orders Data" → "Select Date Range" → fills dates → "Export data".
// Returns { success: true } when export is queued, or { success: false, error }.

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

    // 1. Open "Download Orders Data" dropdown
    let dlDropdown = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      dlDropdown = Array.from(document.querySelectorAll('button, [role="button"], p'))
        .find(el => el.offsetParent && /download orders data/i.test(el.textContent.trim()));
      if (dlDropdown) break;
      await sleep(2000);
    }
    if (!dlDropdown) throw new Error('"Download Orders Data" button not found after 5 attempts');
    await clickAndWait(dlDropdown, 1500);

    // 2. Click "Select Date Range"
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

    // 3. Fill dates (from = to = target date)
    await fillDates(dateStr, dateStr);
    await sleep(600);

    // 4. Click "Export data" (wait up to 4s for it to become enabled)
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

// ─── Stage 2 injected function ────────────────────────────────────────────────
// Runs inside the Meesho supplier tab AFTER page reload.
// Opens "Download Orders Data" dropdown → finds the exported file row for dateStr →
// clicks its Download element.
// Background's downloads.onCreated (BACKFILL_ARM path) intercepts the Chrome download
// and uploads the CSV to Drive.
// Returns { success: true } when the Download was clicked, or { success: false, error }.

async function meeshoOrdersDownload(dateStr) {

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function clickAndWait(el, ms = 800) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return sleep(200 + Math.random() * 100).then(() => {
      el.click();
      return sleep(ms + Math.random() * 200);
    });
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

    // 1. Open "Download Orders Data" dropdown
    let dlDropdown = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      dlDropdown = Array.from(document.querySelectorAll('button, [role="button"], p'))
        .find(el => el.offsetParent && /download orders data/i.test(el.textContent.trim()));
      if (dlDropdown) break;
      await sleep(2000);
    }
    if (!dlDropdown) throw new Error('"Download Orders Data" button not found after reload');
    await clickAndWait(dlDropdown, 2000);

    // 2. Find the exported file row for this date
    let downloadBtn = findExportedFileDownloadBtn(dateStr, dateStr);

    // Poll up to 6 × 30 s if not immediately visible
    for (let poll = 1; poll <= 6 && !downloadBtn; poll++) {
      document.body.click(); // close dropdown
      await sleep(30000);

      const dlDropdown2 = Array.from(document.querySelectorAll('button, [role="button"], p'))
        .find(el => el.offsetParent && /download orders data/i.test(el.textContent.trim()));
      if (!dlDropdown2) break;
      await clickAndWait(dlDropdown2, 2000);

      downloadBtn = findExportedFileDownloadBtn(dateStr, dateStr);
    }

    if (!downloadBtn) throw new Error(`Exported file for ${dateStr} not found in dropdown`);

    // 3. Click Download — background intercepts via BACKFILL_ARM
    await clickAndWait(downloadBtn, 500);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Per-date runner ──────────────────────────────────────────────────────────

async function runDate(date) {
  const filename = `meesho_orders_${date}.csv`;

  setRow(date, 'running', 'Starting…', '—', 'Navigating to Meesho orders');
  log(`${date}: stage 1 — navigating to orders page`);

  try {
    const tabId = await ensureMeeshoTab();

    // ── Navigate to orders page ───────────────────────────────────────────────
    await chrome.tabs.update(tabId, { url: ORDERS_URL });
    setRow(date, 'running', 'Loading…', '—', 'Waiting for page load');
    try {
      await waitForTabLoad(tabId, 40000);
    } catch (_) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') throw new Error('Orders page load timeout');
    }
    await new Promise(r => setTimeout(r, 1500));

    // ── Stage 1: Export ───────────────────────────────────────────────────────
    setRow(date, 'running', 'Exporting…', '—', 'Requesting export');
    const [{ result: stage1 }] = await chrome.scripting.executeScript({
      target: { tabId },
      func:   meeshoOrdersExport,
      args:   [date],
    });

    if (!stage1?.success) {
      throw new Error(`Export stage failed: ${stage1?.error || 'unknown'}`);
    }

    log(`${date}: export requested — waiting 35s for file generation`);
    setRow(date, 'running', 'Waiting…', '—', 'Waiting 35s for file generation');
    await new Promise(r => setTimeout(r, 35000));

    // ── Reload tab ────────────────────────────────────────────────────────────
    log(`${date}: reloading page`);
    setRow(date, 'running', 'Reloading…', '—', 'Reloading page');

    const reloadWait = waitForTabLoad(tabId, 40000);
    await chrome.tabs.reload(tabId);
    try {
      await reloadWait;
    } catch (_) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') throw new Error('Reload timeout');
    }
    await new Promise(r => setTimeout(r, 1500));

    // ── Arm background download interceptor ───────────────────────────────────
    await chrome.storage.local.remove('backfillDownloadResult');
    const armResp = await bgMessage({
      type:      'BACKFILL_ARM',
      filename,
      folderKey: FOLDER_KEY,
      mimeType:  MIME_TYPE,
    });
    if (!armResp?.ok) throw new Error('BACKFILL_ARM failed');

    // ── Stage 2: Download ─────────────────────────────────────────────────────
    log(`${date}: stage 2 — clicking download`);
    setRow(date, 'running', 'Downloading…', '—', 'Finding exported file');

    const [{ result: stage2 }] = await chrome.scripting.executeScript({
      target: { tabId },
      func:   meeshoOrdersDownload,
      args:   [date],
    });

    if (!stage2?.success) {
      await bgMessage({ type: 'BACKFILL_DISARM' });
      throw new Error(`Download stage failed: ${stage2?.error || 'unknown'}`);
    }

    // ── Poll for upload result ────────────────────────────────────────────────
    log(`${date}: download clicked — waiting for Drive upload`);
    setRow(date, 'running', 'Uploading…', '—', 'Background uploading to Drive');

    let uploadResult;
    try {
      uploadResult = await pollStorage('backfillDownloadResult', 60000);
    } catch (pollErr) {
      await bgMessage({ type: 'BACKFILL_DISARM' });
      throw new Error(`Upload poll timeout: ${pollErr.message}`);
    }

    await bgMessage({ type: 'BACKFILL_DISARM' });

    if (!uploadResult?.ok) {
      throw new Error(`Drive upload failed: ${uploadResult?.error || 'unknown'}`);
    }

    const sizeStr = uploadResult.bytes ? `${(uploadResult.bytes / 1024).toFixed(1)} KB` : '—';
    setRow(date, 'done', 'DONE ✓', sizeStr, filename);
    log(`${date}: SUCCESS — ${filename} (${sizeStr})`);
    return true;

  } catch (err) {
    setRow(date, 'error', 'ERROR', '—', err.message);
    log(`${date}: ERROR — ${err.message}`);
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

document.getElementById('runBtn').addEventListener('click', async () => {
  const fromDate = document.getElementById('fromDate').value;
  const toDate   = document.getElementById('toDate').value;
  if (!fromDate || !toDate) { alert('Set both From and To dates.'); return; }
  if (fromDate > toDate)    { alert('From must be ≤ To.'); return; }

  stopRequested = false;
  document.getElementById('runBtn').disabled  = true;
  document.getElementById('stopBtn').disabled = false;

  const dates = dateRange(fromDate, toDate);
  initTable(dates);
  log(`=== Orders backfill started: ${fromDate} → ${toDate} (${dates.length} date${dates.length > 1 ? 's' : ''}) ===`);

  let ok = 0, fail = 0;

  for (const date of dates) {
    if (stopRequested) { log('Stopped by user.'); break; }
    const success = await runDate(date);
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
