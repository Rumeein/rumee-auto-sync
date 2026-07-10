// test-views-lag.js — Standalone FK Views Lag Test
// Open via: chrome-extension://eipligfabjdahmklcddijnegenacgbdp/test-views-lag.html
// Does NOT modify any existing extension files.
// Uses the existing BULK_RUN_NOW / BULK_STATUS / BULK_STOP messages.

const TEST_DATES = [
  '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09',
];

const POLL_MS    = 2000;
const TIMEOUT_MS = 12 * 60 * 1000; // 12 min per date (fk_views_request + download)

let stopRequested = false;

// ─── UI ───────────────────────────────────────────────────────────────────────

function log(msg) {
  const el = document.getElementById('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function initTable() {
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';
  for (const d of TEST_DATES) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${d}</td>` +
      `<td class="waiting" id="st-${d}">Waiting</td>` +
      `<td id="det-${d}">—</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById('summary').textContent = '';
}

function setRow(date, cls, status, detail) {
  const st  = document.getElementById(`st-${date}`);
  const det = document.getElementById(`det-${date}`);
  if (st)  { st.className = cls; st.textContent = status; }
  if (det) det.textContent = detail || '';
}

function showSummary(results) {
  const ready    = results.filter(r => r.result === 'ready').map(r => r.date);
  const notready = results.filter(r => r.result === 'notready').map(r => r.date);
  const errors   = results.filter(r => r.result === 'error').map(r => r.date);
  const lines = [];
  if (ready.length)    lines.push(`READY: ${ready.join(', ')}`);
  if (notready.length) lines.push(`NOT READY: ${notready.join(', ')}`);
  if (errors.length)   lines.push(`ERRORS: ${errors.join(', ')}`);
  document.getElementById('summary').textContent = lines.join(' | ');
}

// ─── Chrome helpers ───────────────────────────────────────────────────────────

const storageGet = keys => new Promise(r => chrome.storage.local.get(keys, r));
const storageDel = keys => new Promise(r => chrome.storage.local.remove(keys, r));

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

async function clearBulkViewsState() {
  await chrome.alarms.clear('bulk_fk_views_recheck');
  await storageDel(['bulk_fk_views_range', 'bulk_fk_views_recheck_count']);
}

// ─── Test one date ────────────────────────────────────────────────────────────

async function testDate(date) {
  setRow(date, 'running', 'Starting…', 'Clearing previous state');
  log(`${date}: clearing state`);
  await clearBulkViewsState();

  // Trigger bulk for this single date — views jobs only
  setRow(date, 'running', 'Running…', 'BULK_RUN_NOW sent');
  let startResp;
  try {
    startResp = await sendMsg({
      type: 'BULK_RUN_NOW',
      jobIds: ['fk_views_request', 'fk_views'],
      fromDate: date,
      toDate:   date,
    });
  } catch (err) {
    setRow(date, 'error', 'ERROR', `Could not start: ${err.message}`);
    log(`${date}: start error — ${err.message}`);
    return { date, result: 'error' };
  }

  if (!startResp || !startResp.ok) {
    const msg = 'BULK_RUN_NOW rejected — daily sync may be running, or bulk already active';
    setRow(date, 'error', 'ERROR', msg);
    log(`${date}: ${msg}`);
    return { date, result: 'error' };
  }

  log(`${date}: bulk started — polling…`);
  setRow(date, 'running', 'Running…', 'fk_views_request + fk_views in progress');

  // Poll until bulkRunning = false or timeout
  const deadline = Date.now() + TIMEOUT_MS;
  let finalStatus = null;

  while (Date.now() < deadline) {
    if (stopRequested) {
      await sendMsg({ type: 'BULK_STOP' });
      setRow(date, 'error', 'STOPPED', 'User stopped');
      await clearBulkViewsState();
      return { date, result: 'error' };
    }
    await new Promise(r => setTimeout(r, POLL_MS));
    let status;
    try { status = await sendMsg({ type: 'BULK_STATUS' }); }
    catch (_) { continue; }

    if (!status.bulkRunning) {
      finalStatus = status;
      break;
    }

    const cur = status.currentBulkJobId || '?';
    setRow(date, 'running', 'Running…', `Current job: ${cur}`);
  }

  if (!finalStatus) {
    await sendMsg({ type: 'BULK_STOP' });
    setRow(date, 'error', 'TIMEOUT', 'Took > 12 min — stopping');
    log(`${date}: TIMEOUT`);
    await clearBulkViewsState();
    return { date, result: 'error' };
  }

  const done   = finalStatus.bulkDone   || [];
  const failed = finalStatus.bulkFailed || [];
  log(`${date}: finished — done=[${done.join(',')}] failed=[${failed.join(',')}]`);

  // If fk_views_request itself failed — navigation/selector error
  if (failed.includes('fk_views_request')) {
    setRow(date, 'error', 'ERROR', 'fk_views_request failed — check extension log');
    await clearBulkViewsState();
    return { date, result: 'error' };
  }

  // If fk_views hard-failed (gave up after max rechecks)
  if (failed.includes('fk_views')) {
    setRow(date, 'error', 'ERROR', 'fk_views failed — gave up after max rechecks');
    log(`${date}: ERROR — fk_views failed`);
    await clearBulkViewsState();
    return { date, result: 'error' };
  }

  // fk_views ended in bulkDone — but did it actually download, or schedule a recheck?
  // A scheduled recheck sets bulk_fk_views_recheck_count > 0 before sending BULK_JOB_DONE.
  const { bulk_fk_views_recheck_count: recheckCount = 0 } =
    await storageGet(['bulk_fk_views_recheck_count']);

  await clearBulkViewsState();

  if (recheckCount > 0) {
    setRow(date, 'notready', 'NOT READY', `FK still generating report (recheck ${recheckCount} scheduled)`);
    log(`${date}: NOT READY — report still generating`);
    return { date, result: 'notready' };
  }

  setRow(date, 'ready', 'READY ✓', 'File downloaded and uploaded to Drive');
  log(`${date}: READY — uploaded to Drive`);
  return { date, result: 'ready' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

document.getElementById('runBtn').addEventListener('click', async () => {
  stopRequested = false;
  document.getElementById('runBtn').disabled  = true;
  document.getElementById('stopBtn').disabled = false;
  initTable();
  log('=== Test started ===');

  const results = [];

  for (const date of TEST_DATES) {
    if (stopRequested) break;
    const r = await testDate(date);
    results.push(r);
    // Brief pause between dates so FK page settles and tab closes cleanly
    if (!stopRequested) await new Promise(res => setTimeout(res, 4000));
  }

  showSummary(results);
  document.getElementById('runBtn').disabled  = false;
  document.getElementById('stopBtn').disabled = true;
  log('=== Test complete ===');
});

document.getElementById('stopBtn').addEventListener('click', () => {
  stopRequested = true;
  document.getElementById('stopBtn').disabled = true;
  log('Stop requested — will stop after current date finishes.');
});
