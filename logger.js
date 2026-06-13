// ─── Rumee Extension — Persistent Logger ──────────────────────────────────────
// Loaded via importScripts in background.js and via <script> in log.html.
// Writes structured log entries to chrome.storage.local key "rumeeLog".
//
// Log entry shape:
//   { ts, jobId, level: 'info'|'warn'|'error'|'success', msg }
//
// Max 2000 entries kept — oldest dropped when limit is exceeded.
// Clear explicitly via clearLog() before a new test run.

const LOG_KEY      = 'rumeeLog';
const LOG_MAX_ROWS = 2000;

async function _appendLog(entry) {
  const stored = await chrome.storage.local.get(LOG_KEY);
  const log = stored[LOG_KEY] || [];
  log.push({ ts: new Date().toISOString(), ...entry });
  // Trim oldest entries if over the limit
  if (log.length > LOG_MAX_ROWS) log.splice(0, log.length - LOG_MAX_ROWS);
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

function logInfo(jobId, msg)    { return _appendLog({ jobId, level: 'info',    msg }); }
function logWarn(jobId, msg)    { return _appendLog({ jobId, level: 'warn',    msg }); }
function logError(jobId, msg)   { return _appendLog({ jobId, level: 'error',   msg }); }
function logSuccess(jobId, msg) { return _appendLog({ jobId, level: 'success', msg }); }

/** Clear all log entries (called from log viewer). */
function clearLog() {
  return chrome.storage.local.set({ [LOG_KEY]: [] });
}

/** Read all log entries, newest first. */
async function readLog() {
  const stored = await chrome.storage.local.get(LOG_KEY);
  return (stored[LOG_KEY] || []).slice().reverse();
}
