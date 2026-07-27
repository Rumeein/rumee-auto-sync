// ─── Rumee Extension — Background Service Worker ─────────────────────────────
// MV3 service worker: sleeps between alarms. ALL state lives in
// chrome.storage.local so we survive sleep/wake cycles mid-job.

importScripts('ist-time.js', 'gap-catchup.js', 'secrets.js', 'config.js', 'logger.js', 'drive/upload.js', 'drive/sheets.js');

const ALARM_NAME     = 'rumee-daily-sync';
const KEEPALIVE_ALARM = 'rumee_keepalive';   // wakes SW every 2 min → watchdog can fire on time

// ── Date helpers (mirrored from content/flipkart.js) ─────────────────────────
// Was a hardcoded const meant for manual dev testing (hand-edit + reload).
// Now also settable at runtime via SET_BACKFILL_OVERRIDE (backfill-hub.js) —
// see that handler below. Still defaults to null (real yesterday) whenever
// nothing has set it, so the daily sync is completely unaffected.
let _YESTERDAY_OVERRIDE_BG = null;
function yesterdayISOBg() {
  if (_YESTERDAY_OVERRIDE_BG != null) return _YESTERDAY_OVERRIDE_BG;
  return istYesterday();
}

/**
 * Returns the effective startUrl for a job.
 * For FK Ads jobs: navigates directly to Other Reports with ?duration= in the hash,
 * so React mounts fresh at that route and reads the date from the URL on initial mount.
 * The date is normally "yesterday"; if gap-catchup is enabled for this job and a
 * previous day's download failed, it targets that missed date instead (see
 * gcFkAdsTargetDate) — content/flipkart.js reads the SAME date back out of this
 * URL rather than recomputing it, so every part of the job agrees on one date.
 * For all other jobs: returns job.startUrl unchanged.
 */
async function getEffectiveStartUrl(job) {
  if (job.platform === 'flipkart' && job.adsReportType) {
    const date = await gcFkAdsTargetDate(job.id);
    return `https://seller.flipkart.com/index.html#dashboard/ads/reports/others?duration=${date}_${date}`;
  }
  return job.startUrl;
}

// Serial queue for LOG_DEBUG writes — prevents concurrent chrome.storage overwrites
// that would cause log entries to be silently dropped.
let _logQueue = Promise.resolve();

// ─── Alarm setup ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const { customFolders } = await chrome.storage.local.get('customFolders');
  if (!customFolders) {
    await chrome.storage.local.set({ customFolders: { ...DRIVE_FOLDERS }, needsSetup: false });
  }

  await scheduleAlarm();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 2 });

  // Clean slate on every reload: cancel any leftover recheck alarms/counters so
  // a reload reliably stops self-triggered re-navigation from old runs.
  await chrome.alarms.clear('fk_rc_recheck');
  await chrome.alarms.clear('fk_views_recheck');
  await chrome.alarms.clear('fk_returns_recheck');
  await chrome.alarms.clear('fk_listings_recheck');
  await chrome.alarms.clear('rumee_sync_retry');
  await chrome.storage.local.remove(['fk_rc_recheck_count', 'fk_views_recheck_count', 'fk_returns_recheck_count', 'fk_listings_recheck_count', 'fk_listings_gen_date', '_pendingRetryJobIds']);

  // Reinject isolated-world content scripts into any already-open tabs.
  // After extension reload, existing tabs' content scripts are invalidated — relay
  // and job handlers stop working until the tab is manually refreshed. This restores
  // them automatically. intercept.js (MAIN world) is skipped — its fetch patches
  // persist in the page window and keep working across reloads.
  const tabs = await chrome.tabs.query({
    url: ['https://supplier.meesho.com/*', 'https://seller.flipkart.com/*'],
  });
  logInfo('system', `onInstalled: found ${tabs.length} tab(s) to reinject`);
  for (const tab of tabs) {
    try {
      const isMeesho = tab.url.startsWith('https://supplier.meesho.com');
      logInfo('system', `reinject step1: clearing guard on tab ${tab.id} url=${tab.url.slice(0,60)}`);

      // Step 1: Clear the double-injection guard in the isolated world.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { window.__rumeeInjected = false; },
      });
      logInfo('system', `reinject step2: checking JOBS on tab ${tab.id}`);

      // Step 2: Inject config.js only if JOBS is not already defined.
      const [{ result: hasConfig }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => typeof JOBS !== 'undefined',
      });
      logInfo('system', `reinject step2: hasConfig=${hasConfig} on tab ${tab.id}`);
      if (!hasConfig) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['config.js'] });
        logInfo('system', `reinject step2: config.js injected into tab ${tab.id}`);
      }

      // Step 3: Reinject the content script.
      const scriptFile = isMeesho ? 'content/meesho.js' : 'content/flipkart.js';
      logInfo('system', `reinject step3: injecting ${scriptFile} into tab ${tab.id}`);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [scriptFile] });
      logInfo('system', `reinject step3: DONE tab ${tab.id}`);

    } catch (e) {
      logError('system', `reinject FAILED tab ${tab.id}: ${e.message}`);
    }
  }

  logInfo('system', `onInstalled complete — ${tabs.length} tab(s) processed`);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[Rumee] Alarm fired — starting sync');
    await startSync();
  }
  // KEEPALIVE_ALARM: wakes the SW so the resume-on-wake IIFE can run the watchdog check.
  // No explicit action needed here — the IIFE at the bottom of this file handles it.
  if (alarm.name === KEEPALIVE_ALARM) return;
});

/**
 * Create (or recreate) the daily alarm based on the stored schedule time.
 * Default: 16:00 local time.
 */
async function scheduleAlarm() {
  const { scheduleHour = 16, scheduleMinute = 0 } =
    await chrome.storage.local.get(['scheduleHour', 'scheduleMinute']);

  await chrome.alarms.clear(ALARM_NAME);

  const now   = new Date();
  const next  = new Date();
  next.setHours(scheduleHour, scheduleMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // already passed today → tomorrow

  chrome.alarms.create(ALARM_NAME, {
    when:         next.getTime(),
    periodInMinutes: 24 * 60,   // repeat daily
  });
}

// ─── Sync orchestration ───────────────────────────────────────────────────────

/**
 * Entry point — called by alarm or popup "Run now".
 * Builds a job queue, stores it, then starts processing.
 */
async function startSync(manualJobIds = null) {
  const running = await isRunning();
  if (running) {
    console.log('[Rumee] Sync already in progress — skipping');
    // A targeted request (e.g. a recheck alarm like fk_views_recheck) can
    // collide with another sync/recheck that's already running (confirmed:
    // fk_views_recheck and fk_rc_recheck fired ~24s apart on 2026-07-03,
    // silently dropping the fk_views retry with no record of it happening).
    // Reschedule a short retry instead of losing it outright.
    if (manualJobIds && manualJobIds.length) {
      await chrome.storage.local.set({ _pendingRetryJobIds: manualJobIds });
      chrome.alarms.create('rumee_sync_retry', { delayInMinutes: 3 });
      console.log(`[Rumee] Collision — rescheduled retry for [${manualJobIds.join(',')}] in 3 min`);
    }
    return;
  }

  const today = todayStr();
  const { lastRun = {} } = await chrome.storage.local.get('lastRun');

  // Build queue: ALWAYS in JOBS array order — this is the canonical sequence.
  // manualJobIds acts as a filter (which jobs to include), not an ordering.
  const requested = manualJobIds ? new Set(manualJobIds) : null;
  const queue = JOBS.map(j => j.id).filter(id => {
    const job = JOBS.find(j => j.id === id);
    if (!job) return false;
    // If a manual list was given, only include jobs in that list
    if (requested && !requested.has(id)) return false;
    // Manual-frequency jobs only run when explicitly requested
    if (job.frequency === 'manual' && !manualJobIds) return false;
    // Explicit RUN_NOW always runs regardless of lastRun (testing / re-run after failure)
    if (manualJobIds) return true;
    if (job.frequency === 'daily') return lastRun[id] !== today;
    if (job.frequency === '3day') {
      const last = lastRun[id];
      if (!last) return true;
      const daysSince = (Date.now() - new Date(last).getTime()) / 86400000;
      return daysSince >= 3;
    }
    return true;
  });

  if (queue.length === 0) {
    console.log('[Rumee] All jobs up to date — nothing to do');
    notify('Rumee Sync', 'All files are already up to date.');
    return;
  }

  // ── Pre-run notification for jobs that require user setup ──────────────────
  // fk_keywords needs the user to navigate to Traffic Report + Latest + All
  // BEFORE that job runs (it is always last in the queue).
  if (queue.includes('fk_keywords')) {
    notify(
      'Rumee - Setup Required Before Run',
      'FK Keywords is queued (runs last).\n\nWhen all other jobs finish, navigate:\nFlipkart -> Growth -> Seller Insights -> Traffic Report -> click "Latest" -> click "All"\n\nYou will get another prompt when it is time.'
    );
  }

  await chrome.storage.local.set({
    syncRunning:  true,
    syncQueue:    queue,
    syncDone:     [],
    syncFailed:   [],
    syncStarted:  Date.now(),
    pausedQueue:  [], // a genuine fresh start supersedes any old unresolved pause
  });

  console.log(`[Rumee] Starting sync — ${queue.length} jobs in JOBS order:`, queue);
  await processNextJob();
}

/**
 * Pull the first job off the queue and process it.
 * Stores currentJobId so we can resume if the worker sleeps mid-job.
 */
async function processNextJob() {
  const { syncQueue = [], syncDone = [], syncFailed = [] } =
    await chrome.storage.local.get(['syncQueue', 'syncDone', 'syncFailed']);

  if (syncQueue.length === 0) {
    await finishSync(syncDone, syncFailed);
    return;
  }

  const [jobId, ...remaining] = syncQueue;
  await chrome.storage.local.set({
    syncQueue:      remaining,
    currentJobId:   jobId,
    currentJobStarted: Date.now(),
  });

  const job = JOBS.find(j => j.id === jobId);
  if (!job) {
    console.warn(`[Rumee] Unknown job "${jobId}" — skipping`);
    await markJobResult(jobId, false, 'Unknown job id');
    await processNextJob();
    return;
  }

  console.log(`[Rumee] Starting job: ${job.label}`);
  logInfo(job.id, `▶ Started: ${job.label}`);

  try {
    await openTabForJob(job);
    // Tab message handler (onMessage) will call processNextJob() when done
  } catch (err) {
    console.error(`[Rumee] Failed to open tab for ${job.label}:`, err);
    await markJobResult(jobId, false, err.message);
    await processNextJob();
  }
}

/**
 * Open (or reuse) a tab for a job.
 *
 * Preference order:
 *   1. An already-open tab on the same platform domain  →  navigate it to startUrl.
 *      The user's session cookies + SPA bootstrap are already in place; fastest path.
 *   2. No existing tab  →  open a new background tab.
 *
 * We store currentTabBorrowed = true when we reused an existing user tab so that
 * closeCurrentTab() knows NOT to close it when the job finishes.
 */
async function openTabForJob(job) {
  // Release / close any stale tab from the previous job
  const { currentTabId, currentTabBorrowed } =
    await chrome.storage.local.get(['currentTabId', 'currentTabBorrowed']);

  if (currentTabId) {
    if (currentTabBorrowed) {
      // We borrowed this from the user — don't close it, just forget the reference
      console.log(`[Rumee] Releasing borrowed tab ${currentTabId} (not closing)`);
    } else {
      try { await chrome.tabs.remove(currentTabId); } catch (_) {}
    }
    await chrome.storage.local.remove(['currentTabId', 'currentTabBorrowed']);
  }

  // Which domain does this job live on?
  const domain = job.platform === 'meesho'
    ? 'supplier.meesho.com'
    : 'seller.flipkart.com';

  // Look for an existing, open tab on that domain
  const existingTabs = await chrome.tabs.query({ url: `https://${domain}/*` });

  let tab;
  let borrowed = false;

  if (existingTabs.length > 0) {
    // Pick the most-recently-accessed tab on this domain
    const best = existingTabs.reduce((a, b) =>
      (b.lastAccessed || 0) > (a.lastAccessed || 0) ? b : a
    );

    if (job.skipNavigation) {
      // Don't navigate — directly send job to the existing content script.
      // User must already be on the correct page (e.g. Traffic Report + All).
      console.log(`[Rumee] skipNavigation: sending RUN_JOB to tab ${best.id} for ${job.label}`);
      tab = best;
      borrowed = true;
      // Send RUN_JOB directly to content script (no CONTENT_READY handshake needed)
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(best.id, { type: 'RUN_JOB', jobId: job.id });
          console.log(`[Rumee] RUN_JOB sent to tab ${best.id}`);
        } catch (e) {
          console.warn(`[Rumee] RUN_JOB failed (${e.message}) — falling back to navigate`);
          await chrome.tabs.update(best.id, { url: job.startUrl });
        }
      }, 1500);
    } else {
      const effectiveUrl = await getEffectiveStartUrl(job);
      console.log(`[Rumee] Reusing existing tab ${best.id} (${best.url.slice(0, 80)}) for ${job.label} → ${effectiveUrl.slice(0, 100)}`);
      // chrome.tabs.update only triggers a full page reload when the base URL (origin +
      // pathname) changes. When only the hash differs (e.g. same SPA, different route),
      // Chrome performs a same-document hashchange — page does NOT reload, manifest
      // content scripts are NOT re-injected, CONTENT_READY never fires → silent stall.
      //
      // Fix: whenever the base URL is the same (same origin+pathname), force a full
      // reload so content scripts re-inject cleanly. The content script handles
      // navigating to the correct SPA route after receiving the job from background.
      const sameBase = best.url.split('#')[0] === effectiveUrl.split('#')[0];
      if (sameBase) {
        console.log(`[Rumee] Tab at same base URL — forcing reload to re-inject content script`);
        await chrome.tabs.reload(best.id);
        tab = best;
      } else {
        tab = await chrome.tabs.update(best.id, { url: effectiveUrl });
      }
      borrowed = true;
    }
  } else {
    // No panel open — open a new background tab
    const effectiveUrl = await getEffectiveStartUrl(job);
    console.log(`[Rumee] No ${domain} tab found — opening new background tab for ${job.label} → ${effectiveUrl.slice(0, 100)}`);
    tab     = await chrome.tabs.create({ url: effectiveUrl, active: false });
    borrowed = false;
  }

  await chrome.storage.local.set({
    currentTabId:      tab.id,
    currentTabBorrowed: borrowed,
  });
  console.log(`[Rumee] Tab ${tab.id} assigned for ${job.label} (borrowed=${borrowed})`);
}

// ─── Message handler (content script + popup → background) ──────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content script announces it's ready and asks for the current job
  if (msg.type === 'CONTENT_READY') {
    handleContentReady(sender.tab?.id).then(job => sendResponse({ job }));
    return true;
  }

  // Content script captured a download URL — re-fetch from background + upload to Drive
  if (msg.type === 'DOWNLOAD_URL_CAPTURED') {
    handleDownloadUrlCaptured(msg).then(ok => sendResponse({ ok }));
    return true;
  }

  // Content script completed a CS_FETCH_AND_UPLOAD delegation (CDN CORS fallback)
  if (msg.type === 'CS_UPLOAD_DONE') {
    (async () => {
      const { jobId, filename, folderKey, mimeType, dataBase64, error } = msg;
      if (error) {
        logError(jobId, `✗ CS fetch failed: ${error}`);
        await markJobResult(jobId, false, error);
      } else {
        try {
          const binary = atob(dataBase64);
          const buf = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
          // Option 5: set campaign cache before advancing to next job
          if (jobId === 'fk_ads_daily') await _setFkAdsDailyCacheFromBuffer(jobId, filename, buf.buffer);
          const { buffer: upBuf, filename: upName, mimeType: upMime } = await extractZipIfNeeded(buf.buffer, filename, mimeType);
          const folderId = DRIVE_FOLDERS[folderKey];
          const driveFile = await uploadToDrive(upBuf, upName, folderId, upMime);
          logSuccess(jobId, `✓ Uploaded "${upName}" (CS fetch) to Drive (${(upBuf.byteLength / 1024).toFixed(1)} KB) — file ID: ${driveFile.id}`);
          await markJobResult(jobId, true);
        } catch (err) {
          logError(jobId, `✗ CS upload failed: ${err.message}`);
          await markJobResult(jobId, false, err.message);
        }
      }
      await closeCurrentTab();
      await processNextJob();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Content script requests a user-visible notification
  if (msg.type === 'NOTIFY_USER') {
    notify(msg.title || 'Rumee', msg.message || '');
    sendResponse({ ok: true });
    return true;
  }

  // Gap catch-up gave up on a stuck date after GAP_CATCHUP_MAX_DAYS — record it
  // for the popup's "Mark Done" list and notify on Discord so it's seen even
  // if nobody's watching this machine right now.
  if (msg.type === 'GAP_CATCHUP_ESCALATED') {
    handleGapCatchupEscalated(msg.jobId, msg.date, msg.daysPending, msg.reason).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Popup "Mark Done" click — clears one manually-resolved item from the list.
  if (msg.type === 'MARK_GAP_CATCHUP_DONE') {
    (async () => {
      const { gapCatchupManual = [] } = await chrome.storage.local.get('gapCatchupManual');
      const next = gapCatchupManual.filter(x => !(x.jobId === msg.jobId && x.date === msg.date));
      await chrome.storage.local.set({ gapCatchupManual: next });
      logSuccess(msg.jobId, `✓ GapCatchup: ${msg.date} marked done manually`);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Schedule a 1-hour alarm to recheck FK RC reports
  if (msg.type === 'SCHEDULE_FK_RC_RECHECK') {
    chrome.alarms.create('fk_rc_recheck', { delayInMinutes: msg.delayMinutes || 60 });
    console.log(`[Rumee] Scheduled fk_rc_recheck in ${msg.delayMinutes || 60} min`);
    sendResponse({ ok: true });
    return true;
  }

  // Schedule a 1-hour alarm to recheck the FK Views listings report
  if (msg.type === 'SCHEDULE_FK_VIEWS_RECHECK') {
    chrome.alarms.create('fk_views_recheck', { delayInMinutes: msg.delayMinutes || 60 });
    console.log(`[Rumee] Scheduled fk_views_recheck in ${msg.delayMinutes || 60} min`);
    sendResponse({ ok: true });
    return true;
  }

  // Schedule a 1-hour alarm to recheck FK Returns download
  if (msg.type === 'SCHEDULE_FK_RETURNS_RECHECK') {
    chrome.alarms.create('fk_returns_recheck', { delayInMinutes: msg.delayMinutes || 60 });
    console.log(`[Rumee] Scheduled fk_returns_recheck in ${msg.delayMinutes || 60} min`);
    sendResponse({ ok: true });
    return true;
  }

  // Schedule a 1-hour alarm to recheck FK Listings download
  if (msg.type === 'SCHEDULE_FK_LISTINGS_RECHECK') {
    chrome.alarms.create('fk_listings_recheck', { delayInMinutes: msg.delayMinutes || 60 });
    console.log(`[Rumee] Scheduled fk_listings_recheck in ${msg.delayMinutes || 60} min`);
    sendResponse({ ok: true });
    return true;
  }

  // Content script completed job without uploading a file (e.g. requestOnly jobs
  // that just submit a request and move on, or fk_rc_download after downloading sub-jobs).
  if (msg.type === 'JOB_DONE') {
    (async () => {
      await markJobResult(msg.jobId, true);
      await closeCurrentTab();
      await processNextJob();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Content script built data in-memory (CSV string) — encode + upload directly
  // Used by: FK_KEYWORDS (keyword scrape) and any DOM-scrape job
  if (msg.type === 'UPLOAD_DATA') {
    handleUploadData(msg).then(ok => sendResponse({ ok }));
    return true;
  }

  // Silent upload: upload a file to Drive WITHOUT advancing the job queue.
  // Used by fk_rc_download to upload fk_orders/returns/payments sub-files;
  // fk_rc_download sends JOB_DONE after all sub-files are uploaded.
  if (msg.type === 'UPLOAD_DATA_SILENT') {
    handleUploadDataSilent(msg).then(ok => sendResponse({ ok }));
    return true;
  }

  // ME_VIEWS: append a new row to the running meesho_views.csv in Drive
  // (read existing file, append row, re-upload; create with header if missing)
  if (msg.type === 'APPEND_VIEW_DATA') {
    handleAppendViewData(msg).then(ok => sendResponse({ ok }));
    return true;
  }

  // ME_ADS: upload the 3-file ads bundle (master upsert-by-campaign + per-campaign
  // per-day summary & catalog files, each upsert-by-filename). Advances the queue.
  if (msg.type === 'UPLOAD_ADS_BUNDLE') {
    handleUploadAdsBundle(msg).then(ok => sendResponse({ ok }));
    return true;
  }

  // Manual trigger for the download-manifest verification (testing / on demand).
  // msg.dataDate (optional, 'YYYY-MM-DD'): verify a specific date instead of
  // yesterday — used by the backfill hub to upsert the manifest row for a
  // date it just backfilled, without touching any other row (content-based
  // upsert keyed by Data Date + File Name — see verifyAndLogManifest above).
  if (msg.type === 'VERIFY_NOW') {
    verifyAndLogManifest(msg.dataDate).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // Backfill hub: set/clear the runtime date override before/after RUN_NOW.
  // msg.date: 'YYYY-MM-DD'. Every job's date-resolution (yesterdayISOBg,
  // gcFkAdsTargetDate, content/flipkart.js's and content/meesho.js's own
  // yesterdayISO/gcSingleShotTargetDate) checks this FIRST, ahead of both
  // "real yesterday" and gap-catchup's own pending-date pick. Defaults to
  // null (unset) — the daily sync never sets this, so its behavior is
  // completely unaffected unless a backfill run is actively in progress.
  if (msg.type === 'SET_BACKFILL_OVERRIDE') {
    _YESTERDAY_OVERRIDE_BG = msg.date || null;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'CLEAR_BACKFILL_OVERRIDE') {
    _YESTERDAY_OVERRIDE_BG = null;
    sendResponse({ ok: true });
    return true;
  }

  // Manual trigger to rebuild the Download Manifest Sheet's history for a date
  // range (repair tool — see rebuildManifestHistory). msg.fromDate/toDate: 'YYYY-MM-DD'.
  if (msg.type === 'REBUILD_MANIFEST_HISTORY') {
    rebuildManifestHistory(msg.fromDate, msg.toDate, !!msg.dryRun)
      .then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // One-time migration step: create the Download Manifest Sheet (see DOCS.md
  // Section 25). Returns the new spreadsheetId, which must be hand-copied into
  // config.js as DOWNLOAD_MANIFEST_SHEET_ID before verifyAndLogManifest /
  // rebuildManifestHistory can write to it.
  if (msg.type === 'CREATE_MANIFEST_SHEET') {
    (async () => {
      const token = await getDriveToken(true);
      const id = await createSheetInFolder(token, DRIVE_FOLDERS.DOWNLOAD_MANIFEST, 'download_manifest');
      sendResponse({ sheetId: id });
    })().catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // One-time cleanup: trash the old download_manifest.csv once the Sheet
  // migration is verified. Moves to Drive Trash, not a permanent delete.
  if (msg.type === 'DELETE_MANIFEST_CSV') {
    (async () => {
      const token = await getDriveToken(true);
      const existing = await searchDriveFile(token, DRIVE_FOLDERS.DOWNLOAD_MANIFEST, 'download_manifest.csv');
      if (!existing) { sendResponse({ ok: false, reason: 'not found' }); return; }
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${existing.id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
      sendResponse({ ok: res.ok, status: res.status });
    })().catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // Content script debug log — writes directly to rumeeLog (for DOM inspection).
  // All writes are chained through _logQueue to prevent concurrent storage overwrites.
  // IMPORTANT: The chain must NEVER reject — a rejected _logQueue causes all subsequent
  // messages' .then(logInfo) to be skipped (entries silently dropped).
  // Use a single async .then() with inner try/catch so the chain always resolves.
  if (msg.type === 'LOG_DEBUG') {
    _logQueue = _logQueue
      .then(async () => {
        try { await logInfo(msg.jobId || 'debug', msg.text || ''); } catch(e) {}
        try { sendResponse({ ok: true }); } catch(e) {}
      })
      .catch(() => {}); // should never fire, but prevents any rejection from leaking
    return true;
  }

  // Explicit log clear — call before each test run so old entries don't pollute analysis
  if (msg.type === 'CLEAR_LOG') {
    _logQueue = _logQueue
      .then(() => clearLog())
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  // Content script is about to click a download button — pre-arm the onCreated handler
  // so it can cancel synchronously without any async storage read.
  // This message keeps the service worker alive for 30 s (chrome.runtime.onMessage keepalive).
  if (msg.type === 'DOWNLOAD_BUTTON_CLICKED') {
    const job = JOBS.find(j => j.id === msg.jobId);
    // Allow the content script to override the filename (e.g. with a date suffix).
    _pendingDownloadJob = job
      ? { ...job, ...(msg.filenameOverride ? { filename: msg.filenameOverride } : {}) }
      : null;
    // Persist the dated filename override so the slow-path onCreated handler
    // (after a service worker wake-up) can still use the correct dated name.
    if (msg.filenameOverride) {
      // Await the write before responding so signalDownloadExpected only resolves
      // after the override is durably stored — prevents the slow path reading a
      // stale value from the previous job if the SW sleeps before the set completes.
      chrome.storage.local.set({ _pendingFilenameOverride: msg.filenameOverride }, () => {
        sendResponse({ ok: true });
      });
    } else {
      sendResponse({ ok: true });
    }
    return true;
  }

  // Content scripts that must fetch the file themselves (CORS/cookie reasons)
  // arm this instead of DOWNLOAD_BUTTON_CLICKED. chrome.downloads.onCreated
  // fires with item.url regardless of HOW the download was triggered — fetch,
  // XHR, anchor click, or window.open/native navigation (which intercept.js's
  // fetch/XHR monkey-patch cannot see at all). This cancels the native download
  // synchronously (suppressing any Save-As dialog) and relays the real URL back
  // via storage instead of fetching it in the background (which fails CORS for
  // some FK CDN endpoints) — the content script keeps its existing fetch +
  // job-specific bookkeeping, just fed a reliable URL.
  if (msg.type === 'RELAY_ARM') {
    _relayArmedJobId = msg.jobId;
    chrome.storage.local.remove('_relayedDownload', () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'RELAY_DISARM') {
    _relayArmedJobId = null;
    sendResponse({ ok: true });
    return true;
  }

  // Backfill pages arm the download interceptor before clicking the download button.
  if (msg.type === 'BACKFILL_ARM') {
    _backfillDownload = { filename: msg.filename, folderKey: msg.folderKey, mimeType: msg.mimeType };
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'BACKFILL_DISARM') {
    _backfillDownload = null;
    chrome.storage.local.remove('backfillDownloadResult');
    sendResponse({ ok: true });
    return true;
  }

  // Content script landed on a login page — session not active in that tab.
  // Show a notification and abort the sync rather than trying to auto-login
  // (which looks bot-like and rarely works).
  if (msg.type === 'PANEL_LOGIN_REQUIRED') {
    handlePanelLoginRequired(msg).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Content script hit an unrecoverable error
  if (msg.type === 'JOB_ERROR') {
    handleJobError(msg.jobId, msg.error);
    sendResponse({ ok: true });
    return true;
  }

  // Popup: run jobs now (optionally filtered to specific job IDs)
  if (msg.type === 'RUN_NOW') {
    startSync(msg.jobIds || null).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Popup: resume a sync that stopped early (e.g. login-required) exactly
  // where it left off — restores the preserved remaining queue instead of
  // rebuilding one, and does not touch syncDone/syncFailed so the eventual
  // finishSync() tally still reflects everything from before the pause too.
  if (msg.type === 'RESUME_SYNC') {
    (async () => {
      const { pausedQueue = [] } = await chrome.storage.local.get(['pausedQueue']);
      if (!pausedQueue.length) { sendResponse({ ok: false, error: 'Nothing to resume' }); return; }
      await chrome.storage.local.set({
        syncRunning: true,
        syncQueue:   pausedQueue,
        pausedQueue: [],
        syncStarted: Date.now(),
      });
      await processNextJob();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Popup: get current sync status
  if (msg.type === 'GET_STATUS') {
    chrome.storage.local.get(
      ['syncRunning', 'syncQueue', 'syncDone', 'syncFailed', 'lastRun', 'currentJobId', 'pausedQueue'],
      data => sendResponse(data)
    );
    return true;
  }

  // Popup: check if first-time setup is needed
  if (msg.type === 'GET_SETUP_STATUS') {
    chrome.storage.local.get(['needsSetup', 'customFolders'], data => sendResponse(data));
    return true;
  }

  // Popup: auto-create Drive folder structure for a fresh install
  if (msg.type === 'CREATE_FOLDERS') {
    createDriveFolderStructure()
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // Clear a specific storage key (e.g. fk_orders_requested) to force re-request
  if (msg.type === 'CLEAR_STORAGE_KEY') {
    chrome.storage.local.remove(msg.key, () => {
      console.log(`[Rumee] Cleared storage key: ${msg.key}`);
      sendResponse({ ok: true });
    });
    return true;
  }

  // Set one or more storage keys directly (e.g. gap-catchup kill-switch flags
  // during staged rollout) — debug relay counterpart to CLEAR_STORAGE_KEY above.
  if (msg.type === 'SET_STORAGE_KEYS') {
    chrome.storage.local.set(msg.values || {}, () => {
      console.log(`[Rumee] Set storage keys: ${Object.keys(msg.values || {}).join(', ')}`);
      sendResponse({ ok: true });
    });
    return true;
  }

  // Popup: KILL ALL — abort the current sync AND cancel every pending recheck
  // alarm/counter so no more self-triggered navigations happen. The in-flight
  // tab (if any) finishes its current job; nothing new is started.
  if (msg.type === 'STOP_SYNC') {
    (async () => {
      await chrome.alarms.clear('fk_rc_recheck');
      await chrome.alarms.clear('fk_views_recheck');
      await chrome.alarms.clear('fk_returns_recheck');
      await chrome.alarms.clear('fk_listings_recheck');
      await chrome.alarms.clear('rumee_sync_retry');
      await chrome.storage.local.set({ syncRunning: false, syncQueue: [], lastSyncEndTime: Date.now() });
      await chrome.storage.local.remove([
        'currentJobId', 'fk_rc_recheck_count', 'fk_views_recheck_count',
        'fk_returns_recheck_count', 'fk_listings_recheck_count', 'fk_listings_gen_date',
        '_pendingRetryJobIds',
      ]);
      console.log('[Rumee] KILL ALL — sync aborted + recheck alarms cleared');
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Popup: update the daily alarm schedule time
  if (msg.type === 'UPDATE_SCHEDULE') {
    chrome.storage.local.set(
      { scheduleHour: msg.hour, scheduleMinute: msg.minute },
      () => { scheduleAlarm().then(() => sendResponse({ ok: true })); }
    );
    return true;
  }
});

// FK API test page — supplies Basic Auth credentials to prevent Chrome's native auth dialog.
// Fires when api.flipkart.net returns 401 + WWW-Authenticate. Reads credentials stored by the
// test page before each request. Scoped strictly to api.flipkart.net — no effect on seller.flipkart.com.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    chrome.storage.local.get(['fkApiKey', 'fkApiSecret'], ({ fkApiKey, fkApiSecret }) => {
      if (fkApiKey && fkApiSecret) {
        callback({ authCredentials: { username: fkApiKey, password: fkApiSecret } });
      } else {
        callback({});
      }
    });
  },
  { urls: ['https://api.flipkart.net/*'] },
  ['asyncBlocking']
);

/**
 * Content script loaded on the right page — tell it which job to run.
 *
 * Guard: only dispatch a job if a sync is actively running in storage.
 * Without this check, stale currentJobId/currentTabId values (left over from a
 * previous run after finishSync sets syncRunning:false before its remove() call,
 * or after a mid-job crash) would cause the reinjected content script to pick up
 * and re-execute the last job — triggering downloads the onCreated interceptor
 * won't catch because syncRunning is false.
 */
async function handleContentReady(tabId) {
  const { currentJobId, currentTabId, syncRunning } = await chrome.storage.local.get([
    'currentJobId',
    'currentTabId',
    'syncRunning',
  ]);
  // Only respond if a sync is actively running AND this is the assigned tab
  if (!syncRunning || tabId !== currentTabId) return null;

  const job = JOBS.find(j => j.id === currentJobId);
  if (!job) return null;
  // Propagate an active backfill override to the content script via a NEW
  // object — never mutate the shared JOBS entry itself (JOBS.find() returns
  // the SAME object reference every run; setting a property directly on it
  // would leak the override into every future real daily-sync run of this
  // same job until the process restarts).
  return _YESTERDAY_OVERRIDE_BG != null ? { ...job, backfillDate: _YESTERDAY_OVERRIDE_BG } : job;
}

/**
 * Content script captured the download URL — re-fetch from background
 * (avoids 64MB sendMessage limit; cookies sent automatically via credentials:include
 *  because extension has host_permission for the domain).
 */
// Domains that serve pre-signed URLs (auth is embedded in the URL itself).
// These respond with Access-Control-Allow-Origin: * which is incompatible with
// credentials: 'include' — using 'include' causes an immediate CORS "Failed to fetch".
// No cookies are needed for these URLs; the signature in the query string is the auth.
const CDN_DOMAINS = /storage\.googleapis\.com|amazonaws\.com|dlhvr\.in|cloudfront\.net|akamaized\.net|fastly\.net|meesho-prod/i;

// Prevents double-upload when both downloads.onCreated and DOWNLOAD_URL_CAPTURED
// fire for the same job (both paths call handleDownloadUrlCaptured).
const _downloadInFlight = new Set();

// ─── Option 5: set fk_ads_daily campaign cache from CSV buffer ────────────────
// Called by BOTH handleDownloadUrlCaptured and CS_UPLOAD_DONE so the cache is
// set no matter which fetch path (background SW or content-script delegation) wins.
// Must complete BEFORE processNextJob() so the next ads job sees the gate result.
async function _setFkAdsDailyCacheFromBuffer(jobId, filename, buffer) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
    logError(jobId, `Option5: buffer is HTML — cannot set campaign cache (download not a real CSV)`);
    return;
  }
  const lines = text.split('\n');
  const hdrIdx = lines.findIndex(l => /Campaign ID/i.test(l) && /\bDate\b/i.test(l));
  const dateColIdx = hdrIdx >= 0
    ? lines[hdrIdx].split(',').findIndex(h => /^date$/i.test(h.trim()))
    : -1;
  // Extract yesterday from filename: flipkart_ads_daily_2026-06-07_2026-06-07.csv
  const dateMatch = (filename || '').match(/(\d{4}-\d{2}-\d{2})/);
  const reportDate = dateMatch ? dateMatch[1] : null;

  const campIdColIdx = hdrIdx >= 0
    ? lines[hdrIdx].split(',').findIndex(h => /^campaign.?id$/i.test(h.trim()))
    : 0;

  let matchedRows = [];
  if (hdrIdx >= 0 && dateColIdx >= 0 && reportDate) {
    matchedRows = lines.slice(hdrIdx + 1)
      .filter(l => l.trim().length > 0)
      .filter(l => (l.split(',')[dateColIdx] || '').trim() === reportDate);
    logSuccess(jobId, `Option5: ${matchedRows.length} rows for ${reportDate} (hdrIdx=${hdrIdx} dateCol=${dateColIdx} campIdCol=${campIdColIdx}) — header="${lines[hdrIdx].slice(0, 80)}"`);
  } else {
    matchedRows = lines.slice(1).filter(l => l.trim().length > 0);
    logInfo(jobId, `Option5: no header/date col (hdrIdx=${hdrIdx} dateColIdx=${dateColIdx} reportDate=${reportDate}) — all-row fallback: ${matchedRows.length} rows`);
  }

  // Extract unique Campaign IDs from column 0 (or detected campIdColIdx)
  const ids = [];
  const _col = campIdColIdx >= 0 ? campIdColIdx : 0;
  for (const row of matchedRows) {
    const id = (row.split(',')[_col] || '').trim().replace(/^"|"$/g, '');
    if (id && !ids.includes(id)) ids.push(id);
  }

  await chrome.storage.local.set({ fkAdsCampaignCache: { date: reportDate, ids } });
  logSuccess(jobId, `Option5: cache set → date=${reportDate} ids=${JSON.stringify(ids)}`);
}

async function handleDownloadUrlCaptured(msg) {
  const { jobId, url, headers = {}, referer, filename, folderKey, mimeType } = msg;

  if (_downloadInFlight.has(jobId)) {
    console.log(`[Rumee] Duplicate DOWNLOAD_URL_CAPTURED for ${jobId} — skipping`);
    return false;
  }
  _downloadInFlight.add(jobId);

  try {
    const isCdn = CDN_DOMAINS.test(url);
    logInfo(jobId, `⟳ Re-fetching (isCdn=${isCdn}): ${url.slice(0, 200)}`);
    console.log(`[Rumee] Fetching file for ${jobId} (isCdn=${isCdn}): ${url}`);

    // CDN / pre-signed URLs: auth is in the URL itself, no cookies needed.
    // Portal API URLs (seller.flipkart.com, supplier.meesho.com): need cookies.

    const res = await fetch(url, {
      credentials: isCdn ? 'omit' : 'include',
      headers: {
        ...(isCdn ? {} : { 'Referer': referer }),
        ...headers,
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    // Guard: portal URLs (seller.flipkart.com, supplier.meesho.com) can return HTTP 200
    // with an HTML login/redirect page when SameSite cookies block the SW fetch.
    // Detect this early and delegate to the content script which runs in the correct origin.
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new TypeError(`Portal returned HTML page instead of file (SameSite cookie blocked in SW) — delegating to content script`);
    }

    let buffer = await res.arrayBuffer();
    console.log(`[Rumee] Downloaded ${buffer.byteLength} bytes — uploading to Drive`);

    // Option 5: set campaign cache before advancing to next job
    if (jobId === 'fk_ads_daily') await _setFkAdsDailyCacheFromBuffer(jobId, filename, buffer);

    const { buffer: upBuf, filename: upName, mimeType: upMime } = await extractZipIfNeeded(buffer, filename, mimeType);

    const folderId = DRIVE_FOLDERS[folderKey];
    if (!folderId) throw new Error(`No Drive folder mapped for key "${folderKey}"`);

    const driveFile = await uploadToDrive(upBuf, upName, folderId, upMime);
    console.log(`[Rumee] Uploaded to Drive: ${driveFile.name} (${driveFile.id})`);
    logSuccess(jobId, `✓ Uploaded "${upName}" to Drive (${(upBuf.byteLength / 1024).toFixed(1)} KB) — file ID: ${driveFile.id}`);

    await markJobResult(jobId, true);
    await closeCurrentTab();
    await processNextJob();
    return true;

  } catch (err) {
    const detail = [err.name, err.message, err.cause ? String(err.cause) : ''].filter(Boolean).join(' | ');
    console.error(`[Rumee] Upload failed for ${jobId}:`, err);

    // ── CS delegation: CDN CORS block OR portal HTML auth-redirect ───────────
    // Two cases trigger this:
    //   1. CDN buckets (CORS blocks SW origin) — isCdn=true, err.name=TypeError
    //   2. Portal URLs (seller.flipkart.com) returning HTML instead of file —
    //      SameSite cookies are not sent from the SW, so Flipkart returns a redirect.
    //      Content script runs at the page origin and gets the cookies correctly.
    const isCdn = CDN_DOMAINS.test(url);
    const isHtmlRedirect = err.name === 'TypeError' && err.message.includes('Portal returned HTML');
    if ((isCdn && err.name === 'TypeError') || isHtmlRedirect) {
      logInfo(jobId, `⟳ ${isHtmlRedirect ? 'Portal HTML redirect' : 'CDN CORS blocked'} — delegating to content script`);
      try {
        const tabs = await chrome.tabs.query({
          url: ['*://supplier.meesho.com/*', '*://seller.flipkart.com/*']
        });
        for (const tab of tabs) {
          try {
            chrome.tabs.sendMessage(tab.id, {
              type: 'CS_FETCH_AND_UPLOAD', jobId, url, filename, folderKey, mimeType
            });
            return true; // content script takes over and sends CS_UPLOAD_DONE
          } catch (_) {}
        }
      } catch (delegateErr) {
        console.warn('[Rumee] CS delegation failed:', delegateErr.message);
      }
    }

    logError(jobId, `✗ Failed: ${detail}`);
    await markJobResult(jobId, false, detail);
    await closeCurrentTab();
    await processNextJob();
    return false;
  } finally {
    _downloadInFlight.delete(jobId);
  }
}

async function handleJobError(jobId, error) {
  console.error(`[Rumee] Content script error for ${jobId}:`, error);
  logError(jobId, `✗ Content script error: ${error}`);
  await markJobResult(jobId, false, error);
  await closeCurrentTab();
  await processNextJob();
}

async function handlePanelLoginRequired(msg) {
  const platformName = msg.platform === 'meesho' ? 'Meesho supplier panel' : 'Flipkart seller hub';
  const domain       = msg.platform === 'meesho' ? 'supplier.meesho.com'   : 'seller.flipkart.com';
  console.warn(`[Rumee] Login required for ${msg.jobId} — panel session not active`);
  logError(msg.jobId, `✗ Login required — open ${domain}, log in, then tap Resume Sync`);
  notify('Rumee — Login Required',
    `Please open the ${platformName} and log in, then tap "Resume Sync".`);
  await markJobResult(msg.jobId, false, `Login required — open ${domain}`);
  await closeCurrentTab();
  // Preserve whatever's left in the queue instead of discarding it — processNextJob()
  // already removes a job from syncQueue before running it, so this is exactly
  // "everything after the job that just failed." Resume Sync restores it later.
  const { syncQueue = [] } = await chrome.storage.local.get(['syncQueue']);
  await chrome.storage.local.set({
    syncRunning: false,
    syncQueue: [],
    pausedQueue: syncQueue,
    lastSyncEndTime: Date.now(),
  });
}

// ─── Job result helpers ───────────────────────────────────────────────────────

// Single-shot jobs (no submit/wait split, unlike fk_orders/fk_payments/fk_returns)
// whose gap-catchup outcome is recorded centrally here in markJobResult, rather
// than inside each content-script handler. Extend this list as each job is
// added to the staged rollout (see how-i-work item 18 in project memory).
const SINGLE_SHOT_GC_JOBS = [
  'me_payments', 'me_orders', 'me_ads',
  'fk_ads_daily', 'fk_ads_fsn', 'fk_ads_placements', 'fk_ads_overall',
  'fk_ads_search', 'fk_ads_orders', 'fk_ads_kw',
];

async function gcIsEnabledForBg(jobId) {
  const { gapCatchupEnabled = false, gapCatchupJobs = [] } = await chrome.storage.local.get(['gapCatchupEnabled', 'gapCatchupJobs']);
  return gapCatchupEnabled && gapCatchupJobs.includes(jobId);
}

// Which DATA date this job's next navigation should fetch — never a "run
// date" (see gap-catchup.js's header comment for that distinction: a failure
// on today's run means YESTERDAY's data is what's owed, not today's date).
// FK ads jobs each navigate fresh (see getEffectiveStartUrl) rather than
// reading date state mid-run, so this only needs to answer "which date for
// this job's NEXT navigation" — same pending-lookup logic as the
// content-script version (gcSingleShotTargetDate in meesho.js).
async function gcFkAdsTargetDate(jobId) {
  // A backfill run always wins over gap-catchup's own pending-date pick —
  // otherwise a backfill for date X could silently target gap-catchup's own
  // stuck date instead, whenever gap-catchup happens to have one pending.
  if (_YESTERDAY_OVERRIDE_BG != null) return _YESTERDAY_OVERRIDE_BG;
  if (!(await gcIsEnabledForBg(jobId))) return yesterdayISOBg();
  const { gapCatchupPending = {} } = await chrome.storage.local.get(['gapCatchupPending']);
  const oldest = gcGetOldestPending(gapCatchupPending, jobId);
  return oldest ? oldest.date : yesterdayISOBg();
}

// Record a single-shot job's success/failure into gap-catchup tracking.
// No-op for any job not in SINGLE_SHOT_GC_JOBS or not enabled — existing
// behavior for every other job is completely unaffected.
async function recordSingleShotGapCatchup(jobId, success, errMsg = null) {
  // A manual backfill run is explicitly NOT a missed automatic run — gap-catchup
  // tracks recent dates owed because the daily sync failed, and a backfill of an
  // arbitrary historical date has nothing to do with that. Recording it here
  // (even with the override date substituted in) risks adding a spurious pending
  // item or misdating an existing one, so skip gap-catchup bookkeeping entirely
  // whenever a backfill is what actually ran.
  if (_YESTERDAY_OVERRIDE_BG != null) return;
  if (!SINGLE_SHOT_GC_JOBS.includes(jobId)) return;
  if (!(await gcIsEnabledForBg(jobId))) return;

  // Whatever date this run actually targeted: the oldest pending date if one
  // was being retried (same lookup gcSingleShotTargetDate/gcFkAdsTargetDate
  // used to pick it before the run started), otherwise the normal "yesterday".
  // Must NOT just assume "yesterday" here — that would misrecord a retry
  // attempt's outcome against today's date instead of the date actually retried.
  const { gapCatchupPending = {} } = await chrome.storage.local.get(['gapCatchupPending']);
  const oldest = gcGetOldestPending(gapCatchupPending, jobId);
  const targetDate = oldest ? oldest.date : yesterdayISOBg();
  const r = gcRecordOutcome(gapCatchupPending, jobId, targetDate, todayStr(), success);
  await chrome.storage.local.set({ gapCatchupPending: r.pendingItems });
  if (r.escalated) {
    const reason = errMsg ? `${errMsg} (after ${r.escalated.daysPending} days)` : null;
    await handleGapCatchupEscalated(jobId, r.escalated.date, r.escalated.daysPending, reason);
  }
}

async function markJobResult(jobId, success, errMsg = null) {
  const { syncDone = [], syncFailed = [], lastRun = {}, lastJobError = {} } =
    await chrome.storage.local.get(['syncDone', 'syncFailed', 'lastRun', 'lastJobError']);

  if (success) {
    lastRun[jobId] = todayStr();
    // Job's own storage key, keyed by jobId only — untouched by startSync()'s
    // syncFailed:[] reset (which fires on every sync, including unrelated
    // single-job rechecks), so this survives long enough for the next daily
    // manifest/Discord post to still show the real reason.
    delete lastJobError[jobId];
    await chrome.storage.local.set({
      syncDone: [...syncDone, jobId],
      lastRun,
      lastJobError,
    });
  } else {
    lastJobError[jobId] = errMsg;
    await chrome.storage.local.set({
      syncFailed: [...syncFailed, { id: jobId, error: errMsg }],
      lastJobError,
    });
  }
  await recordSingleShotGapCatchup(jobId, success, errMsg);
  await chrome.storage.local.remove('currentJobId');
}

async function finishSync(done, failed) {
  // lastSyncEndTime lets the download listener distinguish "a download from
  // THIS sync arrived late, right after it finished" from "an unrelated
  // manual download happening at some random later time" -- see the
  // uncaptured-download guard in chrome.downloads.onCreated below.
  await chrome.storage.local.set({ syncRunning: false, lastSyncEndTime: Date.now() });
  await chrome.storage.local.remove(['currentJobId', 'currentTabId']);

  // "jobs completed", not "files synced" — request-only jobs (fk_orders/returns/
  // payments, fk_views_request) complete without uploading any file.
  const msg = failed.length === 0
    ? `✅ All ${done.length} job(s) completed.`
    : `✅ ${done.length} completed  ❌ ${failed.length} failed: ${failed.map(f => `${f.id} (${(f.error || '').slice(0, 60)})`).join(', ')}`;

  const level = failed.length === 0 ? 'success' : 'warn';
  _appendLog({ jobId: 'system', level, msg: `Sync complete — ${done.length} OK, ${failed.length} failed` +
    (failed.length ? `: ${failed.map(f => `${f.id} (${f.error})`).join(' | ')}` : '') });

  notify('Rumee Sync Complete', msg);
  console.log('[Rumee] Sync complete:', { done, failed });

  // Verify downloads immediately on completion — main sync AND recheck mini-syncs.
  // Upsert-by-(Data Date + File Name) means a Missing row flips to Verified when a
  // later recheck (RC reports / FK views) lands the file. Never blocks the sync.
  try { await verifyAndLogManifest(); }
  catch (e) { logError('verify', `manifest verification failed: ${e.message}`); }

  try { await flushLogToDrive(); }
  catch (e) { console.error('[Rumee] Drive log flush failed:', e); }
}

// ─── Drive log flush ──────────────────────────────────────────────────────────
// At the end of every sync, appends this run's log entries to a single rolling
// CSV file in Drive (rumee_sync_log.csv). Creates the file on first run.
// Non-fatal — failure is logged to console only and never blocks the sync.
async function flushLogToDrive() {
  const LOG_FILENAME = 'rumee_sync_log.csv';
  const HEADER       = 'ts,jobId,level,msg\n';

  const { rumeeLog = [], syncStarted } = await chrome.storage.local.get(['rumeeLog', 'syncStarted']);
  const cutoff = syncStarted || 0;
  const entries = rumeeLog.filter(e => new Date(e.ts).getTime() >= cutoff);
  if (entries.length === 0) return;

  const csvEscape = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const csvRows   = entries.map(e => [e.ts, e.jobId, e.level, csvEscape(e.msg)].join(',')).join('\n') + '\n';

  const token    = await getDriveToken(false);
  const folderId = DRIVE_FOLDERS.SYNC_LOG;
  const existing = await searchDriveFile(token, folderId, LOG_FILENAME);

  if (existing) {
    const current   = await downloadDriveFileText(token, existing.id);
    const appended  = current.trimEnd() + '\n' + csvRows;
    await updateDriveFile(token, existing.id, new TextEncoder().encode(appended).buffer, 'text/csv');
  } else {
    await uploadToDrive(new TextEncoder().encode(HEADER + csvRows).buffer, LOG_FILENAME, folderId, 'text/csv');
  }

  logInfo('system', `✓ Log flushed to Drive (${entries.length} entries)`);
}

async function isRunning() {
  const { syncRunning } = await chrome.storage.local.get('syncRunning');
  // Safety valve: if a sync has been "running" for over 90 minutes, reset it
  const { syncStarted } = await chrome.storage.local.get('syncStarted');
  if (syncRunning && syncStarted && Date.now() - syncStarted > 90 * 60_000) {
    console.warn('[Rumee] Stale sync detected — resetting');
    await chrome.storage.local.set({ syncRunning: false, lastSyncEndTime: Date.now() });
    return false;
  }
  return !!syncRunning;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function todayStr() {
  return istToday(); // 'YYYY-MM-DD', IST calendar day
}

function notify(title, message) {
  chrome.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
  });
}

// A gap-catchup retry gave up on a stuck date (content/flipkart.js and
// content/meesho.js both send this). Record it so the popup can list it with
// a "Mark Done" button, and post to Discord so it's visible even if nobody's
// watching this machine. Desktop notification too, for parity with other
// manual-action-required cases (see FK RC recheck exhaustion, above).
// `reason` overrides the default "not resolved after N days" wording — used
// by jobs (fk_returns_download) that skip retry/tracking entirely and
// escalate on the very first failure, so "after N days" would be misleading.
async function handleGapCatchupEscalated(jobId, date, daysPending, reason = null) {
  const { gapCatchupManual = [] } = await chrome.storage.local.get('gapCatchupManual');
  const already = gapCatchupManual.some(x => x.jobId === jobId && x.date === date);
  if (!already) {
    gapCatchupManual.push({ jobId, date, daysPending, escalatedAt: istDisplayString(Date.now()) });
    await chrome.storage.local.set({ gapCatchupManual });
  }

  const detail = reason || `could not be auto-completed after ${daysPending} days`;
  logError(jobId, `✗ GapCatchup: ${date} — ${detail} — manual download required`);
  notify('Rumee — Manual Action Required',
    `${jobId} for ${date}: ${detail}.\nPlease download manually and click "Mark Done" in the extension popup.`);

  try {
    await fetch(DISCORD_WEBHOOKS.AUTO_SYNC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content:
        `⚠️ **Manual action needed** — \`${jobId}\` for **${date}**: ${detail}.\n` +
        `Please download it manually and place it in the Drive folder, then click "Mark Done" in the extension popup.` }),
    });
  } catch (e) {
    console.warn('[Rumee] GapCatchup Discord notify failed:', e.message);
  }
}

// ─── ZIP extraction helper ────────────────────────────────────────────────────
// Only called when mimeType === 'application/zip' (currently: me_payments only).
// Removed: PK\x03\x04 magic byte check that previously guarded this function.
// That check became dead code once the mimeType guard above was added — XLSX files
// are also ZIP archives (ECMA-376) and share the same magic bytes, so the magic
// check alone was what caused XLSX corruption. mimeType from config.js is the
// authoritative signal for whether extraction is needed.
async function extractZipIfNeeded(buffer, filename, mimeType) {
  if (mimeType !== 'application/zip') {
    return { buffer, filename, mimeType };
  }
  const view    = new DataView(buffer);
  const bytes   = new Uint8Array(buffer);
  const method  = view.getUint16(8,  true);
  const fnLen   = view.getUint16(26, true);
  const efLen   = view.getUint16(28, true);
  const dataOff = 30 + fnLen + efLen;

  // Bit 3 of flags = data descriptor mode: compressedSize in local header is 0.
  // Read the real value from the Central Directory (always correct).
  let compSz = view.getUint32(18, true);
  if (compSz === 0) {
    let eocdOff = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
        eocdOff = i; break;
      }
    }
    if (eocdOff < 0) throw new Error('extractZipIfNeeded: EOCD not found');
    const cdOff = view.getUint32(eocdOff + 16, true);
    compSz = view.getUint32(cdOff + 20, true);
  }
  const compressed = bytes.slice(dataOff, dataOff + compSz);
  let extracted;
  if (method === 0) {
    extracted = compressed;
  } else if (method === 8) {
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
    extracted = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { extracted.set(c, off); off += c.length; }
  } else {
    throw new Error(`extractZipIfNeeded: unsupported compression method ${method}`);
  }
  const xlsxFilename = filename.replace(/\.zip$/i, '.xlsx');
  const xlsxMime     = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  console.log(`[Rumee] ZIP extracted: ${filename} → ${xlsxFilename} (${extracted.length} bytes)`);
  return { buffer: extracted.buffer, filename: xlsxFilename, mimeType: xlsxMime };
}

// ─── UPLOAD_DATA handler (in-memory data → Drive) ────────────────────────────
//
// Used by FK_KEYWORDS (DOM-scraped CSV) and any job that builds data in-memory
// rather than intercepting a download URL.

async function handleUploadData({ jobId, data, filename, folderKey, mimeType, encoding }) {
  try {
    let buffer;
    if (encoding === 'base64') {
      // Binary file sent as base64 string (e.g. XLSX from a POST API)
      console.log(`[Rumee] UPLOAD_DATA (binary/base64): ${jobId} — ${data.length} b64 chars → ${filename}`);
      const binaryStr = atob(data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      buffer = bytes.buffer;
    } else {
      // Plain text (CSV etc.)
      console.log(`[Rumee] UPLOAD_DATA: ${jobId} — ${data.length} chars → ${filename}`);
      const encoder = new TextEncoder();
      buffer = encoder.encode(data).buffer;
    }

    const folderId = DRIVE_FOLDERS[folderKey];
    if (!folderId) throw new Error(`No Drive folder for key "${folderKey}"`);

    const driveFile = await uploadToDrive(buffer, filename, folderId, mimeType);
    console.log(`[Rumee] UPLOAD_DATA uploaded: ${driveFile.name} (${driveFile.id})`);
    logSuccess(jobId, `✓ Uploaded "${filename}" (scraped data, ${data.length} chars) — file ID: ${driveFile.id}`);

    // Option 5: set campaign cache before advancing to next job
    if (jobId === 'fk_ads_daily') {
      await _setFkAdsDailyCacheFromBuffer(jobId, filename, buffer);
    }

    await markJobResult(jobId.replace('_catalog', ''), true); // strip internal suffix if any
    await closeCurrentTab();
    await processNextJob();
    return true;
  } catch (err) {
    console.error(`[Rumee] UPLOAD_DATA failed for ${jobId}:`, err);
    logError(jobId, `✗ UPLOAD_DATA failed: ${err.message}`);
    await markJobResult(jobId.replace('_catalog', ''), false, err.message);
    await closeCurrentTab();
    await processNextJob();
    return false;
  }
}

// ─── UPLOAD_DATA_SILENT handler (fk_rc_download sub-job uploads) ─────────────
//
// Uploads a file to Drive WITHOUT advancing the job queue.
// Used by fk_rc_download to upload fk_orders/returns/payments.
// Caller sends JOB_DONE after all sub-files finish uploading.

async function handleUploadDataSilent({ jobId, data, filename, folderKey, mimeType, encoding }) {
  try {
    let buffer;
    if (encoding === 'base64') {
      const binaryStr = atob(data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      buffer = bytes.buffer;
    } else {
      const encoder = new TextEncoder();
      buffer = encoder.encode(data).buffer;
    }
    const folderId = DRIVE_FOLDERS[folderKey];
    if (!folderId) throw new Error(`No Drive folder for key "${folderKey}"`);
    const driveFile = await uploadToDrive(buffer, filename, folderId, mimeType);
    logSuccess(jobId, `✓ Uploaded "${filename}" (${(buffer.byteLength / 1024).toFixed(1)} KB) — file ID: ${driveFile.id}`);
    return true;
  } catch (err) {
    logError(jobId, `✗ Silent upload failed: ${err.message}`);
    return false;
  }
}

// ─── Backfill download-URL handler (fetches URL, extracts ZIP if needed, uploads) ─

async function handleDownloadUrlCapturedSilent({ url, filename, folderKey, mimeType }) {
  try {
    const isCdn = CDN_DOMAINS.test(url);
    const res = await fetch(url, { credentials: isCdn ? 'omit' : 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) throw new Error('Portal returned HTML — SameSite blocked');
    const buffer = await res.arrayBuffer();
    const { buffer: upBuf, filename: upName, mimeType: upMime } = await extractZipIfNeeded(buffer, filename, mimeType);
    const folderId = DRIVE_FOLDERS[folderKey];
    if (!folderId) throw new Error(`No folder for key "${folderKey}"`);
    const driveFile = await uploadToDrive(upBuf, upName, folderId, upMime);
    console.log(`[Rumee] Backfill uploaded "${upName}" (${(upBuf.byteLength / 1024).toFixed(1)} KB) — ${driveFile.id}`);
    return { ok: true, filename: upName, bytes: upBuf.byteLength };
  } catch (err) {
    console.error(`[Rumee] Backfill upload failed:`, err);
    return { ok: false, error: err.message };
  }
}

// ─── UPLOAD_ADS_BUNDLE handler (ME_ADS — master + per-campaign per-day files) ─
//
// master: { folderKey, filename, header, keyColIndex, rows[] } — each row is a
//   full CSV line; rows are upserted into the master file keyed by the value at
//   keyColIndex (Campaign ID), so a live campaign's lifetime row is overwritten
//   each day while other campaigns' rows are preserved.
// files:  [{ folderKey, filename, mimeType, content }] — per-campaign per-day
//   summary/catalog files; upserted by filename (replace if same name exists,
//   so re-running the same day doesn't create duplicates).

// Minimal CSV line parser — handles quoted fields containing commas/quotes.
function _parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function handleUploadAdsBundle({ jobId, master, files }) {
  try {
    const token = await getDriveToken(true);
    const enc = str => new TextEncoder().encode(str).buffer;

    // ── Per-campaign per-day files: upsert by filename ──────────────────────
    for (const f of (files || [])) {
      const folderId = DRIVE_FOLDERS[f.folderKey];
      if (!folderId) throw new Error(`No Drive folder for key "${f.folderKey}"`);
      const buffer = enc(f.content);
      const existing = await searchDriveFile(token, folderId, f.filename);
      if (existing) await updateDriveFile(token, existing.id, buffer, f.mimeType || 'text/csv');
      else          await uploadToDrive(buffer, f.filename, folderId, f.mimeType || 'text/csv');
    }

    // ── Master: merge rows by key column ────────────────────────────────────
    if (master && Array.isArray(master.rows) && master.rows.length) {
      const folderId = DRIVE_FOLDERS[master.folderKey];
      if (!folderId) throw new Error(`No Drive folder for key "${master.folderKey}"`);
      const existing = await searchDriveFile(token, folderId, master.filename);
      let headerLine = master.header;
      const byKey = new Map(); // key → full csv line; insertion order preserved
      if (existing) {
        const text = await downloadDriveFileText(token, existing.id);
        const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length) headerLine = lines[0];
        for (const l of lines.slice(1)) byKey.set(_parseCsvLine(l)[master.keyColIndex], l);
      }
      for (const line of master.rows) byKey.set(_parseCsvLine(line)[master.keyColIndex], line);
      const updated = [headerLine, ...byKey.values()].join('\n');
      const buffer = enc(updated);
      if (existing) await updateDriveFile(token, existing.id, buffer, 'text/csv');
      else          await uploadToDrive(buffer, master.filename, folderId, 'text/csv');
    }

    const nMaster = (master && master.rows && master.rows.length) ? 1 : 0;
    logSuccess(jobId, `✓ Ads bundle: master(${nMaster}) + ${(files || []).length} per-campaign file(s)`);
    await markJobResult(jobId, true);
    await closeCurrentTab();
    await processNextJob();
    return true;
  } catch (err) {
    console.error('[Rumee] UPLOAD_ADS_BUNDLE failed:', err);
    logError(jobId, `✗ Ads bundle failed: ${err.message}`);
    await markJobResult(jobId, false, err.message);
    await closeCurrentTab();
    await processNextJob();
    return false;
  }
}

// ─── APPEND_VIEW_DATA handler (ME_VIEWS — append row to running CSV) ──────────
//
// ME_VIEWS maintains a single growing CSV in Drive (meesho_views.csv).
// This handler: search for existing file → download text → append new row → re-upload.

async function handleAppendViewData({ jobId, row, filename, folderKey, mimeType, header }) {
  try {
    console.log(`[Rumee] APPEND_VIEW_DATA: ${jobId} — row: "${row.trim()}"`);

    const folderId = DRIVE_FOLDERS[folderKey];
    if (!folderId) throw new Error(`No Drive folder for key "${folderKey}"`);

    const token = await getDriveToken(true);

    // Search for existing file in the folder
    const existingFile = await searchDriveFile(token, folderId, filename);

    let existingContent = '';
    if (existingFile) {
      existingContent = await downloadDriveFileText(token, existingFile.id);
      console.log(`[Rumee] Existing ${filename}: ${existingContent.split('\n').length} lines`);
    } else {
      // First run — create with header
      existingContent = header || 'Date,Views,Orders';
      console.log(`[Rumee] ${filename} not found — creating new file with header`);
    }

    // Merge the new row by date: if a row for the same date already exists,
    // replace it (keep the latest scrape) instead of appending a duplicate.
    // Rows are keyed by their first CSV column (Date). Data rows are kept
    // sorted by date so the CSV stays chronological even if a run was missed.
    const newRow  = row.trim();                       // row arrives as '\n<date>,<views>,<orders>'
    const lines   = existingContent.trimEnd().split('\n').map(l => l.trim()).filter(Boolean);
    const headerLine = lines.length > 0 ? lines[0] : (header || 'Date,Views,Orders');
    const byDate = new Map();                         // date → row; later rows win
    for (const l of lines.slice(1)) byDate.set(l.split(',')[0], l);
    byDate.set(newRow.split(',')[0], newRow);
    const dataRows = [...byDate.values()]
      .sort((a, b) => a.split(',')[0].localeCompare(b.split(',')[0]));
    const updatedContent = [headerLine, ...dataRows].join('\n');

    const encoder  = new TextEncoder();
    const buffer   = encoder.encode(updatedContent).buffer;

    if (existingFile) {
      // Update the existing file
      await updateDriveFile(token, existingFile.id, buffer, mimeType);
      console.log(`[Rumee] Updated ${filename} in Drive`);
    } else {
      // Create new file
      const driveFile = await uploadToDrive(buffer, filename, folderId, mimeType);
      console.log(`[Rumee] Created ${filename} in Drive: ${driveFile.id}`);
    }

    await markJobResult(jobId, true);
    await closeCurrentTab();
    await processNextJob();
    return true;
  } catch (err) {
    console.error(`[Rumee] APPEND_VIEW_DATA failed for ${jobId}:`, err);
    await markJobResult(jobId, false, err.message);
    await closeCurrentTab();
    await processNextJob();
    return false;
  }
}

// ─── Tab cleanup helper ───────────────────────────────────────────────────────

async function closeCurrentTab() {
  const { currentTabId, currentTabBorrowed } =
    await chrome.storage.local.get(['currentTabId', 'currentTabBorrowed']);

  if (currentTabId) {
    if (currentTabBorrowed) {
      // This tab belonged to the user — leave it open, just clear our reference.
      console.log(`[Rumee] Job done — keeping user's tab ${currentTabId} open`);
    } else {
      // We opened this tab ourselves — close it cleanly.
      try { await chrome.tabs.remove(currentTabId); } catch (_) {}
    }
    await chrome.storage.local.remove(['currentTabId', 'currentTabBorrowed']);
  }
}

// ─── Download expectation state (module-level, valid while worker is awake) ──
// Content scripts call DOWNLOAD_BUTTON_CLICKED before clicking a download
// button.  This keeps the service worker alive AND pre-loads the job so the
// onCreated handler can cancel synchronously — no async storage read needed.
let _pendingDownloadJob = null;
// Backfill download: armed by BACKFILL_ARM, cleared after first use
let _backfillDownload = null;
// Relay-arm: armed by RELAY_ARM (jobs whose content script must fetch the
// file itself for CORS reasons). Cleared after first use.
let _relayArmedJobId = null;

// ─── Chrome download interceptor ─────────────────────────────────────────────
//
// Catches every browser download while a Rumee sync job is running,
// regardless of HOW the page triggered it (fetch, XHR, anchor, window.location,
// blob URL, form submission, redirect chain — anything that reaches the
// Chrome download manager).
//
// Flow:
//   1. Content script clicks the download button and exits — no interceptNextDownload needed.
//   2. Chrome starts the download → onCreated fires with the item URL.
//   3. We cancel the browser download immediately (before any bytes save to disk).
//   4. Background re-fetches the URL with credentials and uploads to Drive.
//
// Guard: only intercepts when syncRunning + currentJobId are set (i.e. a Rumee
// job is actively running). User-initiated downloads outside a sync are untouched.

chrome.downloads.onCreated.addListener((item) => {
  // ── RELAY PATH — content script needs the raw URL, not a background fetch ─
  if (_relayArmedJobId) {
    const jobId = _relayArmedJobId;
    _relayArmedJobId = null;
    chrome.downloads.cancel(item.id, () => { chrome.downloads.erase({ id: item.id }, () => {}); });
    console.log(`[Rumee] downloads.onCreated (relay): intercepting for ${jobId} — ${item.url.slice(0, 120)}`);
    chrome.storage.local.set({ _relayedDownload: { url: item.url, ts: Date.now() } });
    return;
  }

  // ── BACKFILL PATH — standalone backfill pages ─────────────────────────────
  if (_backfillDownload) {
    const bf = _backfillDownload;
    _backfillDownload = null;
    chrome.downloads.cancel(item.id, () => { chrome.downloads.erase({ id: item.id }, () => {}); });
    console.log(`[Rumee] downloads.onCreated (backfill): ${item.url.slice(0, 120)}`);
    handleDownloadUrlCapturedSilent({ url: item.url, ...bf })
      .then(result => chrome.storage.local.set({ backfillDownloadResult: result }));
    return;
  }

  // ── FAST PATH ──────────────────────────────────────────────────────────────
  // Content script sent DOWNLOAD_BUTTON_CLICKED just before the click, which
  // (a) kept the service worker alive, and (b) set _pendingDownloadJob.
  // We read it synchronously here — no await, so cancel() fires BEFORE Chrome
  // has a chance to show the Save-As dialog.
  if (_pendingDownloadJob) {
    const job = _pendingDownloadJob;
    _pendingDownloadJob = null; // consumed
    chrome.storage.local.remove('_pendingFilenameOverride'); // prevent stale value reaching next job's slow path

    console.log(`[Rumee] downloads.onCreated (fast): intercepting for ${job.id} — ${item.url.slice(0, 120)}`);
    logInfo(job.id, `↓ Intercepted download: ${item.url.slice(0, 120)}`);

    // Synchronous cancel — no dialog appears
    chrome.downloads.cancel(item.id, () => { chrome.downloads.erase({ id: item.id }, () => {}); });

    if (item.url.startsWith('blob:')) {
      // Blob URLs cannot be re-fetched by the background.
      // Mark failure and advance so the sync doesn't stall.
      logError(job.id, '✗ Download was a blob URL — cannot re-fetch. Use interceptNextBlobDownload instead.');
      markJobResult(job.id, false, 'Blob URL — re-fetch not possible')
        .then(() => closeCurrentTab())
        .then(() => processNextJob());
      return;
    }

    let { filename, mimeType, folderKey } = job;
    if (item.url.toLowerCase().includes('.zip') || (item.filename || '').toLowerCase().endsWith('.zip')) {
      mimeType = 'application/zip';
      filename = filename.replace(/\.(xlsx|csv|xls)$/i, '.zip');
    }
    handleDownloadUrlCaptured({ jobId: job.id, url: item.url, headers: {}, referer: item.referrer || '', filename, folderKey, mimeType });
    return;
  }

  // ── SLOW FALLBACK PATH ────────────────────────────────────────────────────
  chrome.storage.local.get(['syncRunning', 'currentJobId', '_pendingFilenameOverride', 'lastSyncEndTime'], ({ syncRunning, currentJobId, _pendingFilenameOverride, lastSyncEndTime }) => {
    if (!syncRunning || !currentJobId) {
      // Nothing armed — the sync this download belonged to has already finished
      // or timed out by the time Chrome actually created the download (confirmed
      // real incident 2026-07-10: a me_payments ZIP arrived late enough that the
      // whole sync had already moved on). Previously this left Chrome's native
      // Save-As dialog sitting open indefinitely, requiring a manual click.
      //
      // Fix: for any Meesho/Flipkart-looking download that arrives within a
      // short window (5 min) after a sync ended, cancel it anyway to kill the
      // blocking dialog. The 5-min window matters — outside a sync, downloads
      // must stay untouched (see the guard comment above this listener); a
      // Meesho/Flipkart URL hours or days later during idle time could easily
      // be Jaiswal manually downloading something himself, and cancelling that
      // would be a real regression, not a fix. We deliberately do NOT try to
      // guess which job this straggler belonged to and re-upload it (a wrong
      // guess = file lands in the wrong Drive folder, worse than not capturing
      // it at all) — whichever job this was will either already be covered by
      // gap-catchup's automatic retry, or show up in the log as a genuine
      // failure to recover manually.
      const withinRecentSyncWindow = lastSyncEndTime && (Date.now() - lastSyncEndTime) < 5 * 60_000;
      if (withinRecentSyncWindow && (CDN_DOMAINS.test(item.url) || /meesho|flipkart/i.test(item.url))) {
        console.warn(`[Rumee] UNCAPTURED download (nothing armed, ${Math.round((Date.now()-lastSyncEndTime)/1000)}s after last sync ended) — cancelling to prevent Save-As dialog: ${item.url.slice(0, 160)}`);
        chrome.downloads.cancel(item.id, () => { chrome.downloads.erase({ id: item.id }, () => {}); });
        chrome.storage.local.get({ uncapturedDownloads: [] }, ({ uncapturedDownloads }) => {
          uncapturedDownloads.push({ ts: new Date().toISOString(), url: item.url.slice(0, 300), filename: item.filename || '' });
          chrome.storage.local.set({ uncapturedDownloads: uncapturedDownloads.slice(-20) });
        });
      } else if (CDN_DOMAINS.test(item.url) || /meesho|flipkart/i.test(item.url)) {
        // Outside the recent-sync window — leave it untouched, same as before.
        console.warn(`[Rumee] UNCAPTURED download (nothing armed, outside recent-sync window): ${item.url.slice(0, 160)}`);
        chrome.storage.local.get({ uncapturedDownloads: [] }, ({ uncapturedDownloads }) => {
          uncapturedDownloads.push({ ts: new Date().toISOString(), url: item.url.slice(0, 300), filename: item.filename || '' });
          chrome.storage.local.set({ uncapturedDownloads: uncapturedDownloads.slice(-20) });
        });
      }
      return;
    }

    const job = JOBS.find(j => j.id === currentJobId);
    if (!job) return;

    console.log(`[Rumee] downloads.onCreated (slow): intercepting for ${currentJobId} — ${item.url.slice(0, 120)}`);
    logInfo(currentJobId, `↓ Intercepted download (slow path): ${item.url.slice(0, 120)}`);

    chrome.downloads.cancel(item.id, () => { chrome.downloads.erase({ id: item.id }, () => {}); });
    chrome.storage.local.remove('_pendingFilenameOverride');

    if (item.url.startsWith('blob:')) {
      logError(currentJobId, '✗ Blob URL (slow path) — marking failed and advancing.');
      markJobResult(currentJobId, false, 'Blob URL — re-fetch not possible')
        .then(() => closeCurrentTab())
        .then(() => processNextJob());
      return;
    }

    let { filename, mimeType, folderKey } = job;
    // Use the dated filename override if available (persisted from DOWNLOAD_BUTTON_CLICKED)
    if (_pendingFilenameOverride) filename = _pendingFilenameOverride;
    if (item.url.toLowerCase().includes('.zip') || (item.filename || '').toLowerCase().endsWith('.zip')) {
      mimeType = 'application/zip';
      filename = filename.replace(/\.(xlsx|csv|xls)$/i, '.zip');
    }
    handleDownloadUrlCaptured({ jobId: currentJobId, url: item.url, headers: {}, referer: item.referrer || '', filename, folderKey, mimeType });
  });
});

// ─── Drive folder creation (fresh install setup) ──────────────────────────────

async function createDriveFolder(token, name, parentId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Failed to create folder "${name}" (${res.status})`);
  return (await res.json()).id;
}

async function createDriveFolderStructure() {
  const token = await getDriveToken(true);

  const mk = (name, parent) => createDriveFolder(token, name, parent);

  const root = await mk('Rumee Auto Sync', null);

  const fk  = await mk('Flipkart', root);
  const FK_ORDERS   = await mk('Orders',   fk);
  const FK_RETURNS  = await mk('Returns',  fk);
  const FK_PAYMENTS = await mk('Payments', fk);
  const FK_CLAIMS   = await mk('Claims',   fk);
  const FK_LISTINGS = await mk('Listings', fk);
  const FK_VIEWS    = await mk('Views',    fk);
  const FK_KEYWORDS = await mk('Keywords', fk);
  const FK_ADS      = await mk('Ads',      fk);
  const FK_ADS_DAILY      = await mk('Daily Report',        FK_ADS);
  const FK_ADS_FSN        = await mk('FSN Report',          FK_ADS);
  const FK_ADS_PLACEMENTS = await mk('Placements',          FK_ADS);
  const FK_ADS_OVERALL    = await mk('Overall Performance', FK_ADS);
  const FK_ADS_SEARCH     = await mk('Search Terms',        FK_ADS);
  const FK_ADS_ORDERS     = await mk('Campaign Orders',     FK_ADS);
  const FK_ADS_KW         = await mk('Keyword Report',      FK_ADS);

  const me  = await mk('Meesho', root);
  const ME_ORDERS   = await mk('Orders',   me);
  const ME_RETURNS  = await mk('Returns',  me);
  const ME_PAYMENTS = await mk('Payments', me);
  const ME_CATALOG  = await mk('Catalog',  me);
  const ME_VIEWS    = await mk('Views',    me);
  const ME_CLAIMS   = await mk('Claims',   me);
  const ME_ADS      = await mk('Ads',      me);
  const ME_ADS_MASTER  = await mk('Master',  ME_ADS);
  const ME_ADS_SUMMARY = await mk('Summary', ME_ADS);
  const ME_ADS_CATALOG = await mk('Catalog', ME_ADS);

  const sys = await mk('System', root);
  const DOWNLOAD_MANIFEST = await mk('Download Manifest', sys);

  const folders = {
    FK_ORDERS, FK_RETURNS, FK_PAYMENTS, FK_CLAIMS, FK_LISTINGS, FK_VIEWS, FK_KEYWORDS,
    FK_ADS, FK_ADS_DAILY, FK_ADS_FSN, FK_ADS_PLACEMENTS, FK_ADS_OVERALL,
    FK_ADS_SEARCH, FK_ADS_ORDERS, FK_ADS_KW,
    ME_ORDERS, ME_RETURNS, ME_PAYMENTS, ME_CATALOG, ME_VIEWS, ME_CLAIMS,
    ME_ADS, ME_ADS_MASTER, ME_ADS_SUMMARY, ME_ADS_CATALOG,
    DOWNLOAD_MANIFEST,
  };

  Object.assign(DRIVE_FOLDERS, folders);
  await chrome.storage.local.set({ customFolders: folders, needsSetup: false });
  return { success: true };
}

// ─── Resume on wake ───────────────────────────────────────────────────────────
// If the service worker wakes up and a sync was in progress, resume it.
(async () => {
  // Load custom folder IDs into DRIVE_FOLDERS on every service worker wake.
  // (Module-level state is lost when the worker sleeps, so this re-applies on each wake.)
  const { customFolders } = await chrome.storage.local.get('customFolders');
  if (customFolders) Object.assign(DRIVE_FOLDERS, customFolders);

  // Ensure the keepalive alarm is always running (self-heals if cleared after Chrome update).
  chrome.alarms.get(KEEPALIVE_ALARM, a => {
    if (!a) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 2 });
  });

  const { syncRunning, syncQueue = [], currentJobId, currentJobStarted = 0 } =
    await chrome.storage.local.get(['syncRunning', 'syncQueue', 'currentJobId', 'currentJobStarted']);

  if (!syncRunning) return;

  // If a job was mid-flight when the worker died, check how long it's been running.
  // For long-polling jobs (FK Reports Centre polls for up to 6 min), the SW wakes
  // every ~50s and would otherwise re-navigate the tab, killing the content script.
  // Solution: if the job started less than 10 minutes ago, wait without re-navigating.
  // After 10 minutes assume the content script died and re-queue.
  if (currentJobId && !syncQueue.includes(currentJobId)) {
    const elapsed = Date.now() - currentJobStarted;
    const MAX_JOB_TIME = 10 * 60 * 1000; // 10 minutes

    if (elapsed < MAX_JOB_TIME) {
      console.log(`[Rumee] SW woke — job ${currentJobId} started ${Math.round(elapsed/1000)}s ago, still within timeout — not re-navigating`);
      // Don't re-queue yet. SW will wake again in ~50s and re-check.
      return;
    }

    console.log(`[Rumee] Resuming after sleep — re-queuing ${currentJobId} (ran ${Math.round(elapsed/1000)}s)`);
    await chrome.storage.local.set({ syncQueue: [currentJobId, ...syncQueue] });
  }

  console.log('[Rumee] Service worker woke — resuming sync');
  await processNextJob();
})();

// ─── Sync retry alarm (collision recovery) ────────────────────────────────────
// Fires when a targeted startSync() call (e.g. a recheck alarm) collided with
// another sync already running and was dropped. See startSync()'s `running`
// guard for how this gets scheduled.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'rumee_sync_retry') return;
  const { _pendingRetryJobIds } = await chrome.storage.local.get('_pendingRetryJobIds');
  if (!_pendingRetryJobIds || !_pendingRetryJobIds.length) return;
  await chrome.storage.local.remove('_pendingRetryJobIds');
  console.log(`[Rumee] rumee_sync_retry fired — retrying [${_pendingRetryJobIds.join(',')}]`);
  await startSync(_pendingRetryJobIds);
});

// ─── FK RC Recheck Alarm ──────────────────────────────────────────────────────
// Fires 1 hour after fk_rc_download found pending reports.
// Re-triggers fk_rc_download to check again + download if ready.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'fk_rc_recheck') return;
  console.log('[Rumee] fk_rc_recheck alarm fired — running FK RC download check');
  notify('Rumee — FK Reports Recheck', 'Checking if FK Orders/Returns/Payments reports are ready...');
  // Trigger fk_rc_download as a standalone job
  await startSync(['fk_rc_download']);
});

// ─── FK Views Recheck Alarm ───────────────────────────────────────────────────
// Fires 1 hour after fk_views found the listings report still generating.
// Re-triggers fk_views to re-select the stored range and download if ready.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'fk_views_recheck') return;
  console.log('[Rumee] fk_views_recheck alarm fired — running FK Views download check');
  await startSync(['fk_views']);
});

// ─── FK Returns Recheck Alarm ─────────────────────────────────────────────────
// Fires 1 hour after fk_returns_download found the report still Pending.
// Re-triggers fk_returns_download to check again and download if Ready.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'fk_returns_recheck') return;
  console.log('[Rumee] fk_returns_recheck alarm fired — running FK Returns download check');
  notify('Rumee — FK Returns Recheck', 'Checking if FK Returns report is ready...');
  await startSync(['fk_returns_download']);
});

// ─── FK Listings Recheck Alarm ────────────────────────────────────────────────
// Fires 1 hour after fk_listings_download found the file still Generating.
// Re-triggers fk_listings_download to check again and download if ready.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'fk_listings_recheck') return;
  console.log('[Rumee] fk_listings_recheck alarm fired — running FK Listings download check');
  notify('Rumee — FK Listings Recheck', 'Checking if FK Listings file is ready...');
  await startSync(['fk_listings_download']);
});

// ─── Download Manifest: verify every expected file landed in Drive ────────────
//
// Detection is by Drive PRESENCE (not job success): for each expected slot we
// look in its folder for a file modified during today's run window. Robust to
// the varied filename/date conventions across jobs.
//   single  — one file expected; Verified if a fresh file exists, else Missing.
//   multi   — N files expected (ads per live campaign); one row per fresh file,
//             labelled with a numeric suffix (slot.label_1, _2, ...) so rows
//             stay distinct without leaking campaign ID/date into File Name.
//             A single Missing row (no suffix) if none.
//   append  — file is overwritten in place (meesho_views, ads master); Verified
//             if its modifiedTime is within the run window.
// Upserts rows into the Download Manifest Sheet (4 cols: Run Date, Data Date, File Name, Status).

const MANIFEST_SLOTS = [
  // Meesho
  { folderKey: 'ME_ORDERS',   kind: 'single', label: 'meesho_orders' },
  { folderKey: 'ME_RETURNS',  kind: 'single', label: 'meesho_returns' },
  { folderKey: 'ME_PAYMENTS', kind: 'single', label: 'meesho_payments' },
  { folderKey: 'ME_CLAIMS',   kind: 'single', label: 'meesho_tickets' },
  { folderKey: 'ME_CATALOG',  kind: 'single', label: 'meesho_inventory' },
  { folderKey: 'ME_VIEWS',    kind: 'append', label: 'meesho_views.csv' },
  { folderKey: 'ME_ADS_MASTER',  kind: 'append', label: 'meesho_ads_master.csv' },
  { folderKey: 'ME_ADS_SUMMARY', kind: 'multi',  label: 'meesho_ads_summary' },
  { folderKey: 'ME_ADS_CATALOG', kind: 'multi',  label: 'meesho_ads_catalog' },
  // Flipkart
  { folderKey: 'FK_ORDERS',   kind: 'single', label: 'flipkart_orders' },
  { folderKey: 'FK_RETURNS',  kind: 'single', label: 'flipkart_returns' },
  { folderKey: 'FK_PAYMENTS', kind: 'single', label: 'flipkart_payments' },
  { folderKey: 'FK_ADS_DAILY',      kind: 'single', label: 'flipkart_ads_daily' },
  { folderKey: 'FK_ADS_FSN',        kind: 'single', label: 'flipkart_ads_fsn' },
  { folderKey: 'FK_ADS_PLACEMENTS', kind: 'single', label: 'flipkart_ads_placements' },
  { folderKey: 'FK_ADS_OVERALL',    kind: 'single', label: 'flipkart_ads_overall' },
  { folderKey: 'FK_ADS_SEARCH',     kind: 'single', label: 'flipkart_ads_search_terms' },
  { folderKey: 'FK_ADS_ORDERS',     kind: 'single', label: 'flipkart_ads_orders' },
  { folderKey: 'FK_ADS_KW',         kind: 'single', label: 'flipkart_ads_keywords' },
  { folderKey: 'FK_VIEWS',    kind: 'single', label: 'flipkart_views' },
  { folderKey: 'FK_CLAIMS',   kind: 'single', label: 'flipkart_claims' },
  { folderKey: 'FK_LISTINGS', kind: 'single', label: 'flipkart_listings' },
  { folderKey: 'FK_KEYWORDS', kind: 'single', label: 'flipkart_keywords' },
];

// Does a slot have real data for one specific date? Checked by CONTENT, never
// by upload timing — this is the single source of truth shared by the live
// daily verify (below) and the manual history rebuild (rebuildManifestHistory).
//
// - single slots (20 of 22) always upload with the exact data date embedded
//   in the filename (e.g. flipkart_orders_2026-07-10.xlsx) — matched via a
//   Drive filename query. Ads summary/catalog also carry a per-campaign ID
//   in their real Drive filename, but the manifest only checks "does at
//   least one match exist", so that's transparent to this check.
// - append slots (2: meesho_views.csv, meesho_ads_master.csv) are a single
//   rolling file with no date in the name — content is appended/upserted in
//   place — so they're matched by their own per-row date column instead
//   (`Date` / `Last Updated`) via a substring check on the downloaded file.
//
// ORIGINAL BUG (fixed here): this used to check "was anything uploaded to this
// folder since syncStarted". verifyAndLogManifest() scans ALL 22 slots every
// time it runs, and it's called again after every recheck mini-sync
// (fk_rc_recheck, fk_views_recheck, fk_returns_recheck, fk_listings_recheck) —
// each of which overwrites `syncStarted` to its OWN recent start time. A
// recheck firing hours after the main sync would then find every OTHER job's
// already-uploaded file "stale" against that narrow new cutoff and wrongly
// flip its correct Verified row back to Missing. Confirmed via
// rumee_sync_log.csv: e.g. 2026-06-17 "21 verified, 2 missing" immediately
// followed 6 min later by a recheck logging "0 verified, 23 missing" for the
// same data date. Checking by content instead of timing removes the whole bug
// class instead of narrowing the timing window (a first attempt anchored to
// IST midnight still broke on a post-midnight call — verified live).
async function _checkManifestSlotForDate(token, slot, dataDate) {
  const folderId = DRIVE_FOLDERS[slot.folderKey];
  if (!folderId) return [];

  if (slot.kind === 'append') {
    const existing = await searchDriveFile(token, folderId, slot.label);
    if (!existing) return [];
    const text = await downloadDriveFileText(token, existing.id);
    const hasDate = text.split('\n').some(l => l.includes(dataDate));
    return hasDate ? [{ name: slot.label }] : [];
  }

  const nameQ = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and name contains '${dataDate}'`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${nameQ}&fields=files(name)&pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 401) { await invalidateDriveToken(); throw new Error('Drive token expired'); }
  if (!res.ok) throw new Error(`manifest list failed (${res.status}) for folder ${folderId}`);
  return (await res.json()).files || [];
}

async function verifyAndLogManifest(dataDate = yesterdayISOBg()) {
  const token = await getDriveToken(true);

  const runDate = todayStr();

  // Each result → { fileName, status }. Single/append slots use the stable slot
  // LABEL as File Name (so a Missing row flips to Verified in place on recheck);
  // multi (ads) slots use each actual filename (unique per campaign+date).
  const results = [];
  let verified = 0, missing = 0;

  for (const slot of MANIFEST_SLOTS) {
    if (!DRIVE_FOLDERS[slot.folderKey]) continue;
    let fresh = [];
    try { fresh = await _checkManifestSlotForDate(token, slot, dataDate); }
    catch (e) { logError('verify', `${slot.label}: list error ${e.message}`); }

    if (slot.kind === 'multi') {
      if (fresh.length) {
        // Sort by real filename (stable — embeds campaign ID) so the same
        // campaign always lands on the same _N suffix across reruns, instead
        // of depending on Drive's list-order (which isn't guaranteed stable).
        const ordered = fresh.slice().sort((a, b) => a.name.localeCompare(b.name));
        ordered.forEach((f, i) => { results.push({ fileName: `${slot.label}_${i + 1}`, status: 'Verified', folderKey: slot.folderKey }); verified++; });
      } else {
        results.push({ fileName: slot.label, status: 'Missing', folderKey: slot.folderKey }); missing++;
      }
    } else {
      results.push({ fileName: slot.label, status: fresh.length ? 'Verified' : 'Missing', folderKey: slot.folderKey });
      if (fresh.length) verified++; else missing++;
    }
  }

  // ── Upsert into the Download Manifest Sheet, keyed by (Data Date + File Name) ─
  // Native Sheet, not a CSV — writing structured arrays via valueInputOption=RAW
  // means there's no delimiter/quoting to get wrong and no "open + resave" step
  // that can silently reformat dates (see DOCS.md Section 25).
  const sheetId = DOWNLOAD_MANIFEST_SHEET_ID;
  const existingRows = await sheetsGetValues(token, sheetId, 'A2:D200000'); // skip header row 1

  // key = Data Date + File Name so a Missing row updates in place.
  const byKey = new Map();
  for (const row of existingRows) {
    if (!row[1] || !row[2]) continue;
    byKey.set(`${row[1]}||${row[2]}`, row);
  }
  for (const r of results) {
    byKey.set(`${dataDate}||${r.fileName}`, [runDate, dataDate, r.fileName, r.status]);
  }

  await sheetsClearValues(token, sheetId, 'A:D');
  await sheetsSetValues(token, sheetId, 'A1', [
    ['Run Date', 'Data Date', 'File Name', 'Status'],
    ...byKey.values(),
  ]);

  logSuccess('verify', `Manifest: ${verified} verified, ${missing} missing (data date ${dataDate})`);

  // ── Post summary to Discord #auto-sync ────────────────────────────────────
  try {
    const verifiedList = results.filter(r => r.status === 'Verified').map(r => r.fileName);
    const missingList  = results.filter(r => r.status === 'Missing');
    const lines = [`**AutoSync complete — ${runDate}**`];
    if (missingList.length) {
      // Map each Missing slot's folderKey to the job id(s) that write it
      // (derived from JOBS itself — two-phase jobs like fk_orders/fk_rc_download
      // share one folderKey, so a slot can map to more than one job id).
      const jobIdsByFolderKey = {};
      for (const j of JOBS) (jobIdsByFolderKey[j.folderKey] ||= []).push(j.id);
      // lastJobError (not the transient syncFailed) — persists across unrelated
      // recheck starts, so it still has the real reason even if this manifest
      // check runs long after the job actually failed.
      const { lastJobError = {} } = await chrome.storage.local.get(['lastJobError']);

      lines.push(`✅ ${verifiedList.length}/${results.length} verified`);
      lines.push(`❌ Missing (${missingList.length}):`);
      for (const r of missingList) {
        const jobIds = jobIdsByFolderKey[r.folderKey] || [];
        const failedJobId = jobIds.find(id => lastJobError[id]);
        // No recorded error (self-skip, e.g. 0 live campaigns, or a two-phase
        // job still on a pending recheck) — no real reason to show, never invent one.
        lines.push(failedJobId ? `• ${r.fileName} — ${lastJobError[failedJobId]}` : `• ${r.fileName}`);
      }
      lines.push(`_Pipeline runs at 6:30 PM IST. Upload missing files to Drive before then._`);
    } else {
      lines.push(`✅ All ${results.length}/${results.length} files verified. Pipeline runs at 6:30 PM IST.`);
    }
    await fetch(DISCORD_WEBHOOKS.AUTO_SYNC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') }),
    });
  } catch (e) {
    logError('verify', `Discord notify failed: ${e.message}`);
  }

  return { verified, missing };
}

// ─── Manifest history rebuild — one-time (or as-needed) repair tool ───────────
// Writes to the Download Manifest Sheet (DOWNLOAD_MANIFEST_SHEET_ID, config.js
// — see DOCS.md Section 25; replaced download_manifest.csv 2026-07-11 because
// a CSV gets silently reformatted by Excel/Sheets on open+save). Rows written
// before the content-based redesign (65c597e/4bebb99) used the old
// syncStarted-timing check and were largely wrong (see
// _checkManifestSlotForDate's comment above). This rebuilds the ENTIRE sheet
// from scratch for [fromDate, toDate] using the same content-based truth as
// the now-fixed live check, so history matches what the fixed code would have
// written all along.
//
// Uses the same match rule as _checkManifestSlotForDate (filename-date for
// single/multi, per-row date column for append) but fetches each folder's full
// file listing / each rolling file's content ONCE up front, then matches every
// date against that in memory — turns what would be (slots × days) Drive calls
// into ~23 total, regardless of how many days are being rebuilt.
async function rebuildManifestHistory(fromDate, toDate, dryRun = false) {
  const token = await getDriveToken(true);

  const folderListings = {};   // folderKey -> [{name}]
  const appendContent  = {};   // folderKey -> file text ('' if no file yet)

  for (const slot of MANIFEST_SLOTS) {
    const folderId = DRIVE_FOLDERS[slot.folderKey];
    if (!folderId || folderListings[slot.folderKey] || appendContent[slot.folderKey] !== undefined) continue;

    if (slot.kind === 'append') {
      const existing = await searchDriveFile(token, folderId, slot.label);
      appendContent[slot.folderKey] = existing ? await downloadDriveFileText(token, existing.id) : '';
      continue;
    }

    const listQ = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${listQ}&fields=files(name)&pageSize=1000`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 401) { await invalidateDriveToken(); throw new Error('Drive token expired'); }
    if (!res.ok) throw new Error(`rebuild list failed (${res.status}) for ${slot.folderKey}`);
    folderListings[slot.folderKey] = (await res.json()).files || [];
  }

  const header = ['Run Date', 'Data Date', 'File Name', 'Status'];
  const rows = [];

  for (let d = fromDate; d <= toDate; d = istAddDays(d, 1)) {
    const runDate = istAddDays(d, 1);   // sync for date d runs the evening of d+1
    for (const slot of MANIFEST_SLOTS) {
      if (!DRIVE_FOLDERS[slot.folderKey]) continue;

      if (slot.kind === 'append') {
        const has = (appendContent[slot.folderKey] || '').split('\n').some(l => l.includes(d));
        rows.push([runDate, d, slot.label, has ? 'Verified' : 'Missing']);
        continue;
      }

      const matches = (folderListings[slot.folderKey] || []).filter(f => f.name.includes(d));
      if (slot.kind === 'multi') {
        if (matches.length) {
          // Same stable-sort rule as verifyAndLogManifest — same campaign,
          // same _N suffix, regardless of Drive's list-order.
          const ordered = matches.slice().sort((a, b) => a.name.localeCompare(b.name));
          ordered.forEach((f, i) => rows.push([runDate, d, `${slot.label}_${i + 1}`, 'Verified']));
        } else rows.push([runDate, d, slot.label, 'Missing']);
      } else {
        rows.push([runDate, d, slot.label, matches.length ? 'Verified' : 'Missing']);
      }
    }
  }

  // dryRun: compute everything, write nothing — lets the result be inspected
  // (e.g. specific slot/date rows) before trusting a real overwrite of the
  // production manifest Sheet.
  if (dryRun) {
    logSuccess('verify', `Manifest history DRY RUN: ${rows.length} rows, ${fromDate} → ${toDate} (not written)`);
    return { rows: rows.length, from: fromDate, to: toDate, dryRun: true, sample: rows };
  }

  const sheetId = DOWNLOAD_MANIFEST_SHEET_ID;
  await sheetsClearValues(token, sheetId, 'A:D');
  await sheetsSetValues(token, sheetId, 'A1', [header, ...rows]);

  logSuccess('verify', `Manifest history rebuilt: ${rows.length} rows, ${fromDate} → ${toDate}`);
  return { rows: rows.length, from: fromDate, to: toDate };
}
