// me-payments-backfill.js — Standalone Meesho Payments Backfill
// Open via: chrome-extension://eipligfabjdahmklcddijnegenacgbdp/me-payments-backfill.html
// Does NOT modify any existing extension files.
//
// Flow per date (mirrors me-orders-backfill.js's proven BACKFILL_ARM pattern):
//   Navigate Meesho tab → /payouts/.../payments → BACKFILL_ARM → inject
//   self-contained function → Click Download → Payments to Date → Custom Date
//   Range → fill date → click Download → background's chrome.downloads.onCreated
//   intercepts the native download, fetches, extracts ZIP, uploads to Drive →
//   outer script polls chrome.storage.local.backfillDownloadResult

const UPLOAD_CONFIG = {
  folderKey: 'ME_PAYMENTS',
  // Meesho's payments download is actually a ZIP (matches config.js's me_payments
  // job: mimeType 'application/zip') — this must be the ZIP mimeType, not the
  // final xlsx mimeType, so extractZipIfNeeded() unwraps it before upload.
  mimeType:  'application/zip',
};

const MEESHO_PAYMENTS_URL = `https://supplier.meesho.com/panel/v3/new/payouts/${MEESHO_SUPPLIER_SLUG}/payments`;

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
      return activeMeTabId; // reuse
    } catch (_) {
      activeMeTabId = null;
    }
  }
  const existing = await chrome.tabs.query({ url: 'https://supplier.meesho.com/*' });
  if (existing.length > 0) {
    activeMeTabId = existing[0].id;
    return activeMeTabId;
  }
  const tab = await chrome.tabs.create({ url: MEESHO_PAYMENTS_URL, active: false });
  activeMeTabId = tab.id;
  await waitForTabLoad(tab.id);
  return activeMeTabId;
}

// ─── Injected function (runs inside Meesho supplier tab, isolated world) ─────
//
// Self-contained — no references to outer scope variables.
// All helpers defined locally.
// Only drives the UI up to the final Download click — the outer script arms
// background's BACKFILL_ARM interceptor first, which handles the actual
// download capture, fetch, and upload.

async function meeshoPaymentsDownload(dateStr) {

  const sendLog = msg => chrome.runtime.sendMessage({
    type: 'ME_PAYMENTS_BF_LOG', date: dateStr, msg,
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── DOM helpers ────────────────────────────────────────────────────────────

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

  // ── Calendar date filler (mirrors fillMeeshoDates from meesho.js) ──────────

  async function clickCalendarDate(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const DAYS       = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const MONTHS_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const localDate  = new Date(y, m - 1, d);

    // Meesho payments calendar uses "Jun 2, 2026" (month abbr, day no-pad, comma, year)
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

    // Fallback: day number in calendar grid
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
    // Strategy 1: native date inputs
    const dateInputs = Array.from(document.querySelectorAll('input[type="date"]'));
    if (dateInputs.length >= 2) {
      setValue(dateInputs[0], fromISO);
      await sleep(300);
      setValue(dateInputs[1], toISO);
      await sleep(300);
      return;
    }

    // Strategy 2: aria-label calendar
    const fromOk = await clickCalendarDate(fromISO);
    await sleep(500);
    const toOk   = await clickCalendarDate(toISO);
    if (fromOk && toOk) return;

    // Strategy 3: text inputs with DD/MM/YYYY
    const ddmmyyyy = iso => { const [yr, mo, dy] = iso.split('-'); return `${dy}/${mo}/${yr}`; };
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
    }
  }

  // ── Popup dismissal ────────────────────────────────────────────────────────

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

  // ── Main flow ──────────────────────────────────────────────────────────────

  try {
    sendLog('Page settling...');
    await sleep(4000 + Math.random() * 1000);
    await dismissPopups();

    // 1. Find "Download" dropdown <P> — retry up to 5×
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

    // 2. Click "Payments to Date"
    const paymentsToDate = Array.from(document.querySelectorAll('p, li, [role="option"], button'))
      .find(el => el.offsetParent && el.textContent.trim() === 'Payments to Date');
    if (!paymentsToDate) throw new Error('"Payments to Date" option not found');
    sendLog('Clicking Payments to Date...');
    await clickAndWait(paymentsToDate, 1500);

    // 3. Click "Custom Date Range" radio
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

    // 4. Fill dates (from = to = target date)
    sendLog(`Filling dates: ${dateStr} → ${dateStr}`);
    await fillDates(dateStr, dateStr);
    await sleep(600);

    // 5. Find final Download button in modal
    let finalBtn = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      finalBtn = Array.from(document.querySelectorAll('button'))
        .find(el => el.offsetParent && el.textContent.trim().toLowerCase() === 'download');
      if (finalBtn) break;
      await sleep(1000);
    }
    if (!finalBtn) throw new Error('Final Download button in modal not found');

    // 6. Click Download — background's BACKFILL_ARM interceptor (armed by the
    // outer script before this function was injected) catches the resulting
    // native chrome.downloads.onCreated event, cancels it, fetches the URL
    // with the correct CDN-vs-portal credential handling, extracts the ZIP,
    // and uploads to Drive. This mirrors me-orders-backfill.js's proven
    // pattern instead of doing a content-script-context fetch (which fails
    // with "Failed to fetch" — content-script fetches don't get the
    // extension's host_permissions CORS bypass that background.js fetches do).
    sendLog('Clicking Download — background will intercept...');
    await clickAndWait(finalBtn, 500);

    return { success: true };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Background messaging helpers ──────────────────────────────────────────────

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
  setRow(date, 'running', 'Starting…', '—', 'Navigating to Meesho payments');
  log(`${date}: navigating to payments page`);

  try {
    const tabId = await ensureMeeshoTab();

    await chrome.tabs.update(tabId, { url: MEESHO_PAYMENTS_URL });
    setRow(date, 'running', 'Loading…', '—', 'Waiting for page load');

    try {
      await waitForTabLoad(tabId, 40000);
    } catch (_) {
      // onUpdated sometimes fires before waitForTabLoad is armed — check if already loaded
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') throw new Error('Payments page load timeout');
    }

    await new Promise(r => setTimeout(r, 1500)); // brief post-load settle

    setRow(date, 'running', 'Running…', '—', 'Script injected');

    // Listen for log messages from the injected function
    const logListener = msg => {
      if (msg.type === 'ME_PAYMENTS_BF_LOG' && msg.date === date) {
        log(`  ${date}: ${msg.msg}`);
        setRow(date, 'running', 'Running…', '—', msg.msg.slice(0, 60));
      }
    };
    chrome.runtime.onMessage.addListener(logListener);

    const xlsxFilename = `meesho_payments_${date}.xlsx`;

    // Arm background's downloads.onCreated interceptor BEFORE the click —
    // it will cancel the native download, fetch, extract, and upload.
    await chrome.storage.local.remove('backfillDownloadResult');
    const armResp = await bgMessage({
      type:      'BACKFILL_ARM',
      filename:  xlsxFilename,
      folderKey: UPLOAD_CONFIG.folderKey,
      mimeType:  UPLOAD_CONFIG.mimeType,
    });
    if (!armResp?.ok) throw new Error('BACKFILL_ARM failed');

    let clickResult;
    try {
      const [{ result: r }] = await chrome.scripting.executeScript({
        target: { tabId },
        func:   meeshoPaymentsDownload,
        args:   [date],
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
    try {
      uploadResult = await pollStorage('backfillDownloadResult', 60000);
    } catch (pollErr) {
      await bgMessage({ type: 'BACKFILL_DISARM' });
      throw new Error(`Upload poll timeout: ${pollErr.message}`);
    }
    await bgMessage({ type: 'BACKFILL_DISARM' });

    if (uploadResult?.ok) {
      const sizeStr = uploadResult.bytes ? `${(uploadResult.bytes / 1024).toFixed(1)} KB` : '—';
      setRow(date, 'done', 'DONE ✓', sizeStr, uploadResult.filename || '');
      log(`${date}: SUCCESS — ${uploadResult.filename} (${sizeStr})`);
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
  log(`=== Backfill started: ${fromDate} → ${toDate} (${dates.length} date${dates.length > 1 ? 's' : ''}) ===`);

  let ok = 0, fail = 0;

  for (const date of dates) {
    if (stopRequested) { log('Stopped by user.'); break; }
    const success = await runDate(date);
    success ? ok++ : fail++;
    if (!stopRequested && date !== dates[dates.length - 1])
      await new Promise(r => setTimeout(r, 3000)); // settle between dates
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
