// test-returns.js — Standalone FK Returns Direct Download Test
// Open via: chrome-extension://eipligfabjdahmklcddijnegenacgbdp/test-returns.html
// Does NOT modify any existing extension files.
//
// Flow per date:
//   FK Seller Hub tab → Orders → Returns → All Returns →
//   Date of Closure filter → select day → Request Download →
//   poll Previous Downloads → Ready → fetch blob → UPLOAD_DATA_SILENT → Drive

const UPLOAD_CONFIG = {
  folderKey: 'FK_RETURNS',
  mimeType:  'text/csv',
};

let stopRequested  = false;
let activeFkTabId  = null;

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

function waitForTabLoad(tabId, timeout = 35000) {
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

async function ensureFkTab() {
  // Reuse an existing FK tab to keep session cookies alive
  const existing = await chrome.tabs.query({ url: 'https://seller.flipkart.com/*' });
  if (existing.length > 0) {
    activeFkTabId = existing[0].id;
    return activeFkTabId;
  }
  const tab = await chrome.tabs.create({
    url: 'https://seller.flipkart.com/',
    active: false,
  });
  activeFkTabId = tab.id;
  await waitForTabLoad(tab.id);
  return activeFkTabId;
}

// ─── Injected function (runs inside FK Seller Hub tab) ───────────────────────
//
// Self-contained — no references to outer scope variables.
// All helpers defined locally. chrome.runtime is available in isolated world.

async function fkReturnsDirectDownload(dateStr, uploadCfg) {

  const sendLog  = msg => chrome.runtime.sendMessage({
    type: 'FK_RETURNS_TEST_LOG', date: dateStr, msg,
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Find first visible element whose text matches any of the given strings
  function findEl(texts, selector) {
    const arr = Array.isArray(texts) ? texts : [texts];
    return Array.from(document.querySelectorAll(selector)).find(el => {
      if (!el.offsetParent) return false;
      const t = el.textContent.trim();
      return arr.some(tx =>
        t === tx ||
        t === tx + tx ||             // doubled icon+label ("OrdersOrders")
        t.toLowerCase() === tx.toLowerCase()
      );
    }) || null;
  }

  // Navigate to returnsV2 hash and click the All Returns tab.
  // Does NOT wait for Date of Closure — that filter appears after tab load.
  async function navigateToAllReturns() {
    if (!window.location.hash.includes('returnsV2')) {
      window.location.hash = '#dashboard/returnsV2';
      await sleep(4000);
    }
    if (!window.location.hash.includes('returnsV2')) {
      throw new Error(`Hash nav failed — still at: ${window.location.hash}`);
    }

    // Wait for "All Returns" tab to appear, then click it
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
    // Give the tab time to load its content — Date of Closure appears after this
    await sleep(3500);
  }

  // Wait for the Date of Closure filter button to appear on screen
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

  // Calendar uses react-dates (CalendarMonth / CalendarMonth_caption classes).
  // May show 2 months at once — find ALL panels, then return the one for target month.
  // Nav arrows live at the DayPicker level, outside individual CalendarMonth divs.
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

      // Check if target month is already visible in any panel
      for (const p of panels) {
        const m = getPanelMonth(p);
        if (m && m.year === targetYear && m.month === targetMonth) return p;
      }

      // Need to navigate — determine direction from first panel
      const firstM = getPanelMonth(panels[0]);
      if (!firstM) throw new Error('Could not read calendar month from first panel');
      const goNext = (targetYear * 12 + targetMonth) > (firstM.year * 12 + firstM.month);

      // Nav buttons are at the DayPicker root level — search the full document
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

    // ── 1. Navigate to returnsV2 hash → click All Returns tab ────────────────
    sendLog('Navigating to All Returns page...');
    await navigateToAllReturns();

    // ── 2. Wait for filter bar, then open Date of Closure calendar ───────────
    sendLog('Waiting for filter bar...');
    const dateFilterEl = await waitForDateFilter();
    sendLog(`Opening Date of Closure calendar for ${dateStr}...`);
    dateFilterEl.click();
    await sleep(1500); // wait for calendar to open

    // ── 4. Navigate calendar to correct month, then pick day ──────────────────
    const [yStr, mStr, dStr] = dateStr.split('-');
    const targetYear  = parseInt(yStr, 10);
    const targetMonth = parseInt(mStr, 10);
    const dayNum      = parseInt(dStr, 10);

    // Navigate to correct month panel and pick the day cell within it
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

    // Click Apply to confirm the date filter (required — clicking elsewhere does not apply)
    const applyBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(el => el.offsetParent)
      .find(el => el.textContent.trim() === 'Apply');
    if (!applyBtn) throw new Error('"Apply" button not found after selecting date');
    applyBtn.click();
    await sleep(2000); // wait for filtered data to load

    // ── 5. Click Request Download — check banner to confirm new submission ────
    sendLog('Clicking Request Download...');
    const reqDlBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => el.offsetParent && el.textContent.includes('Request Download'));
    if (!reqDlBtn) throw new Error('"Request Download" button not found');

    // Listen for submitReport response via postMessage (intercept.js MAIN world
    // posts this; isolated world receives via window.addEventListener('message'))
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

    // ── 5b. Determine requestedAt from network status ────────────────────────────
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
      // Red banner text contains the original ISO timestamp — find it in the DOM
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
      // Report already in queue — no 25s wait

    } else {
      // Timeout or unexpected status — assume accepted
      requestedAt = Date.now();
      await chrome.storage.local.set({ [STORAGE_KEY]: requestedAt });
      sendLog(`No submitReport event (status=${httpStatus}) — assuming accepted. Waiting 25s...`);
      await sleep(25000);
    }

    // ── 6. Poll Previous Downloads — close/reopen to refresh, match by time ──
    const panelBtn = () => Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => el.textContent.includes('Previous Downloads'));

    // Panel is open when "Requested On" column header is visible
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

    // Parse "17:20, Jun 14, 2026" → epoch ms
    const MON = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    const parseReqOn = (text) => {
      const m = text.match(/(\d{1,2}):(\d{2}),\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/);
      if (!m) return null;
      const [, h, min, mon, day, yr] = m;
      const mo = MON[mon];
      return mo !== undefined ? new Date(+yr, mo, +day, +h, +min).getTime() : null;
    };

    // Find the row closest to requestedAt — no layout check, textContent only
    const getOurRow = () => {
      // Collect all elements whose text includes a status AND a time pattern
      const timeRe = /\d{1,2}:\d{2},\s*\w+\s+\d{1,2},\s*\d{4}/;
      const candidates = Array.from(document.querySelectorAll('tr, [role="row"], div, li'))
        .filter(el => {
          const txt = el.textContent;
          return timeRe.test(txt) &&
                 (txt.includes('Pending') || txt.includes('Ready to download'));
        });

      sendLog(`getOurRow: ${candidates.length} candidates, requestedAt=${new Date(requestedAt).toLocaleTimeString()}`);

      if (!candidates.length) return null;

      // Pick the element with the shortest text (most specific row-level element)
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

        // Find element whose own trimmed text is exactly "Download"
        const dlEl = Array.from(row.querySelectorAll('*'))
          .find(el => el.textContent.trim() === 'Download' && !el.children.length);

        sendLog(`Download el: ${dlEl ? dlEl.tagName + ' href=' + (dlEl.href || 'none') : 'NOT FOUND'}`);
        sendLog(`Row HTML: ${row.innerHTML.slice(0, 600)}`);

        if (dlEl) {
          // Try href first (anchor)
          const a = dlEl.tagName === 'A' ? dlEl : dlEl.closest('a');
          if (a?.href && !a.href.startsWith('javascript') && !a.href.endsWith('#')) {
            downloadUrl = a.href;
            break;
          }
          // Not an anchor — click it and wait for intercept.js to capture the URL.
          // Retry up to 3x — the postMessage relay from intercept.js doesn't always
          // fire in time even though the button click itself works (confirmed:
          // reports that failed this capture were still "Ready to download" and
          // fetchable afterward — this is a client-side relay timing issue, not a
          // report-generation issue).
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
            // Arm MAIN world interceptor via postMessage — direct assignment to
            // window.__rumeeIntercepting only affects isolated world, not MAIN world.
            window.postMessage({ __rumeeArmCapture: true }, '*');
            await sleep(80); // let MAIN world process the flag before click
            dlEl.click();
            try {
              downloadUrl = await capturePromise;
            } catch(e) {
              sendLog(`Click intercept failed (attempt ${clickAttempt}/3): ${e.message}`);
            }
            window.postMessage({ __rumeeArmCapture: false }, '*');
          }
        }
        break; // exit loop regardless — we either have URL or need to debug
      }

      const remainSec = Math.round((DEADLINE - Date.now()) / 1000);
      sendLog(`Pending... ${remainSec}s left`);
      await closePanel();
      await sleep(12000);
      await openPanel();
    }

    if (!downloadUrl) throw new Error('No download URL — check log above for row HTML and Download element details');

    // ── 7. Fetch the file blob ─────────────────────────────────────────────────
    sendLog(`Fetching: ${downloadUrl.slice(0, 80)}...`);
    const resp = await fetch(downloadUrl, { credentials: 'include' });
    if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status} ${resp.statusText}`);
    const buffer = await resp.arrayBuffer();
    const bytes  = new Uint8Array(buffer);

    // Convert to base64
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));

    sendLog(`Downloaded ${bytes.length} bytes — uploading to Drive...`);

    // ── 8. Upload to Drive (silent — does not disturb job queue) ──────────────
    const filename = `flipkart_returns_${dateStr}.csv`;
    await new Promise(res => chrome.runtime.sendMessage({
      type:     'UPLOAD_DATA_SILENT',
      jobId:    'fk_returns_direct',
      data:     btoa(binary),
      encoding: 'base64',
      filename,
      folderKey: uploadCfg.folderKey,
      mimeType:  uploadCfg.mimeType,
    }, res));

    return { success: true, bytes: bytes.length, filename };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Test runner ──────────────────────────────────────────────────────────────

async function runDate(date) {
  setRow(date, 'running', 'Starting…', '—', 'Opening FK tab');
  log(`${date}: starting`);

  try {
    const tabId = await ensureFkTab();

    // Navigate tab to FK root for a clean start
    setRow(date, 'running', 'Loading…', '—', 'Navigating FK Seller Hub');
    await chrome.tabs.update(tabId, { url: 'https://seller.flipkart.com/' });
    await waitForTabLoad(tabId, 35000);
    await new Promise(r => setTimeout(r, 1000)); // brief settle after load event

    setRow(date, 'running', 'Injecting…', '—', 'Script injected');

    // Listen for log messages from injected function
    const logListener = msg => {
      if (msg.type === 'FK_RETURNS_TEST_LOG' && msg.date === date) {
        log(`  ${date}: ${msg.msg}`);
        setRow(date, 'running', 'Running…', '—', msg.msg.slice(0, 60));
      }
    };
    chrome.runtime.onMessage.addListener(logListener);

    let result;
    try {
      const [{ result: r }] = await chrome.scripting.executeScript({
        target: { tabId },
        func:   fkReturnsDirectDownload,
        args:   [date, UPLOAD_CONFIG],
      });
      result = r;
    } finally {
      chrome.runtime.onMessage.removeListener(logListener);
    }

    if (result?.success) {
      const sizeStr = result.bytes ? `${(result.bytes / 1024).toFixed(1)} KB` : '—';
      setRow(date, 'done', 'DONE ✓', sizeStr, result.filename || '');
      log(`${date}: SUCCESS — ${result.filename} (${sizeStr})`);
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
  log(`=== Test started: ${fromDate} → ${toDate} (${dates.length} date${dates.length > 1 ? 's' : ''}) ===`);

  let ok = 0, fail = 0;
  for (const date of dates) {
    if (stopRequested) { log('Stopped by user.'); break; }
    const success = await runDate(date);
    success ? ok++ : fail++;
    if (!stopRequested && date !== dates[dates.length - 1])
      await new Promise(r => setTimeout(r, 3000)); // pause between dates
  }

  document.getElementById('summary').textContent =
    `Done: ${ok} succeeded, ${fail} failed out of ${ok + fail} dates.`;
  document.getElementById('runBtn').disabled  = false;
  document.getElementById('stopBtn').disabled = true;
  log(`=== Test complete: ${ok} OK, ${fail} failed ===`);
});

document.getElementById('stopBtn').addEventListener('click', () => {
  stopRequested = true;
  document.getElementById('stopBtn').disabled = true;
  log('Stop requested — will finish current date then stop.');
});
