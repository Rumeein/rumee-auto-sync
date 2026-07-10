// ─── Rumee — Bulk Download Handler ───────────────────────────────────────────
// Imported by background.js via importScripts (runs in SW global scope).
// All storage keys and message types are prefixed bulk_ / BULK_ to avoid
// any collision with the daily sync path.

// Fast-path pre-arm: set by BULK_DOWNLOAD_BUTTON_CLICKED before the click.
let _bulkPendingDownloadJob = null;

const BULK_EXCLUDED = new Set([
  'me_returns', 'me_catalog', 'me_views', 'fk_listings', 'fk_keywords',
]);

const BULK_FK_RC_MAX_RECHECKS    = 6;
const BULK_FK_VIEWS_MAX_RECHECKS = 6;

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'BULK_RUN_NOW') {
    startBulkSync(msg.jobIds, msg.fromDate, msg.toDate)
      .then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'BULK_STATUS') {
    chrome.storage.local.get(
      ['bulkRunning','bulkQueue','bulkDone','bulkFailed',
       'bulkFromDate','bulkToDate','bulkStarted','currentBulkJobId'],
      data => sendResponse(data)
    );
    return true;
  }

  if (msg.type === 'BULK_STOP') {
    (async () => {
      await chrome.alarms.clear('bulk_fk_rc_recheck');
      await chrome.alarms.clear('bulk_fk_views_recheck');
      await chrome.storage.local.set({ bulkRunning: false, bulkQueue: [] });
      await chrome.storage.local.remove([
        'currentBulkJobId','currentBulkTabId','currentBulkTabBorrowed',
        'bulk_fk_rc_recheck_count','bulk_fk_views_recheck_count',
      ]);
      console.log('[Rumee/Bulk] STOP — bulk sync aborted');
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'BULK_CONTENT_READY') {
    handleBulkContentReady(sender.tab?.id).then(job => sendResponse({ job }));
    return true;
  }

  if (msg.type === 'BULK_DOWNLOAD_URL_CAPTURED') {
    handleBulkDownloadUrlCaptured(msg).then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'BULK_JOB_DONE') {
    (async () => {
      await markBulkJobResult(msg.jobId, true);
      await closeBulkCurrentTab();
      await processNextBulkJob();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'BULK_JOB_ERROR') {
    (async () => {
      await markBulkJobResult(msg.jobId, false, msg.error || 'Content script error');
      await closeBulkCurrentTab();
      await processNextBulkJob();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'BULK_UPLOAD_DATA') {
    handleBulkUploadData(msg).then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'BULK_UPLOAD_DATA_SILENT') {
    handleBulkUploadDataSilent(msg).then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'BULK_UPLOAD_ADS_BUNDLE') {
    handleBulkUploadAdsBundle(msg).then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'BULK_DOWNLOAD_BUTTON_CLICKED') {
    const job = JOBS.find(j => j.id === msg.jobId);
    _bulkPendingDownloadJob = job
      ? { ...job, ...(msg.filenameOverride ? { filename: msg.filenameOverride } : {}) }
      : null;
    if (msg.filenameOverride) {
      chrome.storage.local.set({ _bulkPendingFilenameOverride: msg.filenameOverride }, () => {
        sendResponse({ ok: true });
      });
    } else {
      sendResponse({ ok: true });
    }
    return true;
  }

  if (msg.type === 'BULK_CS_UPLOAD_DONE') {
    (async () => {
      const { jobId, filename, folderKey, mimeType, dataBase64, error } = msg;
      if (error) {
        await markBulkJobResult(jobId, false, error);
      } else {
        try {
          const binary = atob(dataBase64);
          const buf = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
          const folderId = DRIVE_FOLDERS[folderKey];
          await uploadToDrive(buf.buffer, filename, folderId, mimeType);
          await markBulkJobResult(jobId, true);
        } catch (err) {
          await markBulkJobResult(jobId, false, err.message);
        }
      }
      await closeBulkCurrentTab();
      await processNextBulkJob();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'BULK_SCHEDULE_FK_RC_RECHECK') {
    chrome.alarms.create('bulk_fk_rc_recheck', { delayInMinutes: msg.delayMinutes || 60 });
    console.log(`[Rumee/Bulk] Scheduled bulk_fk_rc_recheck in ${msg.delayMinutes || 60} min`);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'BULK_SCHEDULE_FK_VIEWS_RECHECK') {
    chrome.alarms.create('bulk_fk_views_recheck', { delayInMinutes: msg.delayMinutes || 60 });
    console.log(`[Rumee/Bulk] Scheduled bulk_fk_views_recheck in ${msg.delayMinutes || 60} min`);
    sendResponse({ ok: true });
    return true;
  }
});

// ─── downloads.onCreated (second listener) — checks _bulkPendingDownloadJob ───

chrome.downloads.onCreated.addListener((item) => {
  if (!_bulkPendingDownloadJob) return;
  const job = _bulkPendingDownloadJob;
  _bulkPendingDownloadJob = null;
  chrome.storage.local.remove('_bulkPendingFilenameOverride');

  console.log(`[Rumee/Bulk] downloads.onCreated: intercepting for ${job.id} — ${item.url.slice(0, 120)}`);
  chrome.downloads.cancel(item.id, () => { chrome.downloads.erase({ id: item.id }, () => {}); });

  if (item.url.startsWith('blob:')) {
    markBulkJobResult(job.id, false, 'Blob URL — re-fetch not possible')
      .then(() => closeBulkCurrentTab())
      .then(() => processNextBulkJob());
    return;
  }

  let { filename, mimeType, folderKey } = job;
  if (item.url.toLowerCase().includes('.zip') || (item.filename || '').toLowerCase().endsWith('.zip')) {
    mimeType = 'application/zip';
    filename = filename.replace(/\.(xlsx|csv|xls)$/i, '.zip');
  }
  handleBulkDownloadUrlCaptured({
    jobId: job.id, url: item.url, headers: {}, referer: item.referrer || '',
    filename, folderKey, mimeType,
  });
});

// ─── tabs.onUpdated — inject bulk script when bulk tab finishes loading ────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const { bulkRunning, currentBulkTabId, currentBulkJobId } =
    await chrome.storage.local.get(['bulkRunning', 'currentBulkTabId', 'currentBulkJobId']);
  if (!bulkRunning || tabId !== currentBulkTabId || !currentBulkJobId) return;

  const job = JOBS.find(j => j.id === currentBulkJobId);
  if (!job) return;

  const scriptFile = job.platform === 'flipkart'
    ? 'bulk/bulk-flipkart.js'
    : 'bulk/bulk-meesho.js';

  console.log(`[Rumee/Bulk] Tab ${tabId} ready — injecting ${scriptFile} for ${job.id}`);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] });
  } catch (err) {
    console.error(`[Rumee/Bulk] Injection failed for ${job.id}: ${err.message}`);
    await markBulkJobResult(job.id, false, `Injection failed: ${err.message}`);
    await closeBulkCurrentTab();
    await processNextBulkJob();
  }
});

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bulk_fk_rc_recheck') {
    console.log('[Rumee/Bulk] bulk_fk_rc_recheck fired');
    const { bulkFromDate, bulkToDate } = await chrome.storage.local.get(['bulkFromDate', 'bulkToDate']);
    if (bulkFromDate && bulkToDate) await startBulkSync(['fk_rc_download'], bulkFromDate, bulkToDate);
  }
  if (alarm.name === 'bulk_fk_views_recheck') {
    console.log('[Rumee/Bulk] bulk_fk_views_recheck fired');
    const { bulkFromDate, bulkToDate } = await chrome.storage.local.get(['bulkFromDate', 'bulkToDate']);
    if (bulkFromDate && bulkToDate) await startBulkSync(['fk_views'], bulkFromDate, bulkToDate);
  }
});

// ─── Core orchestration ───────────────────────────────────────────────────────

async function startBulkSync(jobIds, fromDate, toDate) {
  const { syncRunning } = await chrome.storage.local.get('syncRunning');
  if (syncRunning) {
    notify('Rumee Bulk', 'Daily sync is running — stop it first.');
    return false;
  }
  const { bulkRunning } = await chrome.storage.local.get('bulkRunning');
  if (bulkRunning) {
    console.log('[Rumee/Bulk] Already running — skipping duplicate start');
    return false;
  }

  const validJobIds = jobIds.filter(id => !BULK_EXCLUDED.has(id));
  if (validJobIds.length === 0) return false;

  const orderedQueue = JOBS.map(j => j.id).filter(id => validJobIds.includes(id));

  await chrome.storage.local.set({
    bulkRunning:  true,
    bulkQueue:    orderedQueue,
    bulkDone:     [],
    bulkFailed:   [],
    bulkFromDate: fromDate,
    bulkToDate:   toDate,
    bulkStarted:  Date.now(),
  });

  console.log(`[Rumee/Bulk] Starting ${fromDate}→${toDate}: [${orderedQueue.join(', ')}]`);
  await processNextBulkJob();
  return true;
}

async function processNextBulkJob() {
  const { bulkQueue = [], bulkDone = [], bulkFailed = [] } =
    await chrome.storage.local.get(['bulkQueue', 'bulkDone', 'bulkFailed']);

  if (bulkQueue.length === 0) {
    await logInfo('bulk', `processNext: queue empty — finishing (done=${bulkDone.length} failed=${bulkFailed.length})`);
    await finishBulkSync(bulkDone, bulkFailed);
    return;
  }

  const [jobId, ...remaining] = bulkQueue;
  await logInfo('bulk', `processNext: starting jobId=${jobId} queue=[${remaining.join(',')}]`);
  await chrome.storage.local.set({
    bulkQueue:             remaining,
    currentBulkJobId:      jobId,
    currentBulkJobStarted: Date.now(),
  });

  const job = JOBS.find(j => j.id === jobId);
  if (!job) {
    await logError('bulk', `processNext: unknown jobId=${jobId}`);
    await markBulkJobResult(jobId, false, 'Unknown job id');
    await processNextBulkJob();
    return;
  }

  console.log(`[Rumee/Bulk] Job: ${job.label}`);
  try {
    await openBulkTabForJob(job);
  } catch (err) {
    await logError(jobId, `openBulkTabForJob failed: ${err.message}`);
    await markBulkJobResult(jobId, false, err.message);
    await processNextBulkJob();
  }
}

async function openBulkTabForJob(job) {
  const { currentBulkTabId, currentBulkTabBorrowed } =
    await chrome.storage.local.get(['currentBulkTabId', 'currentBulkTabBorrowed']);

  if (currentBulkTabId) {
    if (!currentBulkTabBorrowed) {
      try { await chrome.tabs.remove(currentBulkTabId); } catch (_) {}
    }
    await chrome.storage.local.remove(['currentBulkTabId', 'currentBulkTabBorrowed']);
  }

  const { bulkFromDate, bulkToDate } =
    await chrome.storage.local.get(['bulkFromDate', 'bulkToDate']);
  const effectiveUrl = getBulkEffectiveStartUrl(job, bulkFromDate, bulkToDate);
  const domain = job.platform === 'meesho' ? 'supplier.meesho.com' : 'seller.flipkart.com';

  const existingTabs = await chrome.tabs.query({ url: `https://${domain}/*` });
  let tab, borrowed;

  if (existingTabs.length > 0) {
    const best = existingTabs.reduce((a, b) =>
      (b.lastAccessed || 0) > (a.lastAccessed || 0) ? b : a
    );
    const sameBase = (best.url || '').split('#')[0] === effectiveUrl.split('#')[0];
    tab = sameBase
      ? (await chrome.tabs.reload(best.id), best)
      : await chrome.tabs.update(best.id, { url: effectiveUrl });
    borrowed = true;
  } else {
    tab = await chrome.tabs.create({ url: effectiveUrl, active: false });
    borrowed = false;
  }

  await chrome.storage.local.set({
    currentBulkTabId:       tab.id,
    currentBulkTabBorrowed: borrowed,
  });
  console.log(`[Rumee/Bulk] Tab ${tab.id} → ${effectiveUrl.slice(0, 100)} (borrowed=${borrowed})`);
}

function getBulkEffectiveStartUrl(job, fromDate, toDate) {
  if (job.platform === 'flipkart' && job.adsReportType) {
    return `https://seller.flipkart.com/index.html#dashboard/ads/reports/others?duration=${fromDate}_${toDate}`;
  }
  return job.startUrl;
}

async function handleBulkContentReady(tabId) {
  const { currentBulkJobId, currentBulkTabId, bulkRunning, bulkFromDate, bulkToDate } =
    await chrome.storage.local.get([
      'currentBulkJobId','currentBulkTabId','bulkRunning','bulkFromDate','bulkToDate',
    ]);
  if (!bulkRunning || tabId !== currentBulkTabId) return null;
  const job = JOBS.find(j => j.id === currentBulkJobId);
  if (!job) return null;
  return { ...job, targetFromDate: bulkFromDate, targetToDate: bulkToDate };
}

async function handleBulkDownloadUrlCaptured(msg) {
  const { jobId, url, headers = {}, referer, filename, folderKey, mimeType } = msg;
  await logInfo(jobId, `downloadUrlCaptured: url=${url.slice(0,100)} filename=${filename}`);
  try {
    const isCdn = CDN_DOMAINS.test(url);
    await logInfo(jobId, `fetch: isCdn=${isCdn}`);
    const res = await fetch(url, {
      credentials: isCdn ? 'omit' : 'include',
      headers: { ...(isCdn ? {} : { 'Referer': referer }), ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    await logInfo(jobId, `fetch ok: contentType="${contentType}"`);
    if (contentType.includes('text/html')) throw new TypeError('Portal returned HTML');

    let buffer = await res.arrayBuffer();
    const { buffer: upBuf, filename: upName, mimeType: upMime } =
      await extractZipIfNeeded(buffer, filename, mimeType);
    const folderId = DRIVE_FOLDERS[folderKey];
    if (!folderId) throw new Error(`No Drive folder for "${folderKey}"`);
    await logInfo(jobId, `uploading "${upName}" to folder ${folderKey}`);
    await uploadToDrive(upBuf, upName, folderId, upMime);
    console.log(`[Rumee/Bulk] Uploaded "${upName}"`);
    await markBulkJobResult(jobId, true);
    await closeBulkCurrentTab();
    await processNextBulkJob();
    return true;
  } catch (err) {
    const isCdn = CDN_DOMAINS.test(url);
    const isHtml = err.name === 'TypeError' && err.message.includes('Portal returned HTML');
    await logError(jobId, `download fetch failed: ${err.message} isCdn=${isCdn} isHtml=${isHtml}`);
    if ((isCdn && err.name === 'TypeError') || isHtml) {
      const tabs = await chrome.tabs.query({
        url: ['*://supplier.meesho.com/*', '*://seller.flipkart.com/*'],
      }).catch(() => []);
      await logInfo(jobId, `CS fallback: found ${tabs.length} candidate tabs`);
      for (const tab of tabs) {
        try {
          chrome.tabs.sendMessage(tab.id, {
            type: 'BULK_CS_FETCH_AND_UPLOAD', jobId, url, filename, folderKey, mimeType,
          });
          return true;
        } catch (_) {}
      }
    }
    console.error(`[Rumee/Bulk] Download failed for ${jobId}:`, err.message);
    await markBulkJobResult(jobId, false, err.message);
    await closeBulkCurrentTab();
    await processNextBulkJob();
    return false;
  }
}

async function handleBulkUploadData({ jobId, data, filename, folderKey, mimeType, encoding }) {
  try {
    let buffer;
    if (encoding === 'base64') {
      const binaryStr = atob(data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      buffer = bytes.buffer;
    } else {
      buffer = new TextEncoder().encode(data).buffer;
    }
    const folderId = DRIVE_FOLDERS[folderKey];
    if (!folderId) throw new Error(`No Drive folder for "${folderKey}"`);
    await uploadToDrive(buffer, filename, folderId, mimeType);
    console.log(`[Rumee/Bulk] Uploaded "${filename}"`);
    await markBulkJobResult(jobId, true);
    await closeBulkCurrentTab();
    await processNextBulkJob();
    return true;
  } catch (err) {
    console.error(`[Rumee/Bulk] BULK_UPLOAD_DATA failed for ${jobId}:`, err.message);
    await markBulkJobResult(jobId, false, err.message);
    await closeBulkCurrentTab();
    await processNextBulkJob();
    return false;
  }
}

async function handleBulkUploadDataSilent({ jobId, data, filename, folderKey, mimeType, encoding }) {
  try {
    let buffer;
    if (encoding === 'base64') {
      const binaryStr = atob(data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      buffer = bytes.buffer;
    } else {
      buffer = new TextEncoder().encode(data).buffer;
    }
    const folderId = DRIVE_FOLDERS[folderKey];
    if (!folderId) throw new Error(`No Drive folder for "${folderKey}"`);
    await uploadToDrive(buffer, filename, folderId, mimeType);
    return true;
  } catch (err) {
    console.error(`[Rumee/Bulk] Silent upload failed for ${jobId}:`, err.message);
    return false;
  }
}

async function handleBulkUploadAdsBundle({ jobId, master, files }) {
  try {
    const token = await getDriveToken(true);
    const enc = str => new TextEncoder().encode(str).buffer;

    for (const f of (files || [])) {
      const folderId = DRIVE_FOLDERS[f.folderKey];
      if (!folderId) throw new Error(`No Drive folder for "${f.folderKey}"`);
      const buffer = enc(f.content);
      const existing = await searchDriveFile(token, folderId, f.filename);
      if (existing) await updateDriveFile(token, existing.id, buffer, f.mimeType || 'text/csv');
      else          await uploadToDrive(buffer, f.filename, folderId, f.mimeType || 'text/csv');
    }

    if (master && Array.isArray(master.rows) && master.rows.length) {
      const folderId = DRIVE_FOLDERS[master.folderKey];
      if (!folderId) throw new Error(`No Drive folder for "${master.folderKey}"`);
      const existing = await searchDriveFile(token, folderId, master.filename);
      let headerLine = master.header;
      const byKey = new Map();
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

    await markBulkJobResult(jobId, true);
    await closeBulkCurrentTab();
    await processNextBulkJob();
    return true;
  } catch (err) {
    console.error('[Rumee/Bulk] BULK_UPLOAD_ADS_BUNDLE failed:', err);
    await markBulkJobResult(jobId, false, err.message);
    await closeBulkCurrentTab();
    await processNextBulkJob();
    return false;
  }
}

async function markBulkJobResult(jobId, success, errMsg = null) {
  const { bulkDone = [], bulkFailed = [] } =
    await chrome.storage.local.get(['bulkDone', 'bulkFailed']);
  if (success) {
    await logSuccess(jobId, `job DONE`);
    await chrome.storage.local.set({ bulkDone: [...bulkDone, jobId] });
  } else {
    await logError(jobId, `job FAILED: ${errMsg}`);
    await chrome.storage.local.set({ bulkFailed: [...bulkFailed, { id: jobId, error: errMsg }] });
  }
  await chrome.storage.local.remove('currentBulkJobId');
}

async function finishBulkSync(done, failed) {
  await chrome.storage.local.set({ bulkRunning: false });
  await chrome.storage.local.remove([
    'currentBulkJobId', 'currentBulkTabId', 'currentBulkTabBorrowed',
  ]);
  const msg = failed.length === 0
    ? `Bulk complete: ${done.length} file(s) downloaded.`
    : `Bulk done: ${done.length} ok, ${failed.length} failed — ${failed.map(f => f.id).join(', ')}`;
  notify('Rumee Bulk Download', msg);
  console.log('[Rumee/Bulk] Complete:', { done, failed });
}

async function closeBulkCurrentTab() {
  const { currentBulkTabId, currentBulkTabBorrowed } =
    await chrome.storage.local.get(['currentBulkTabId', 'currentBulkTabBorrowed']);
  if (!currentBulkTabId) return;
  if (!currentBulkTabBorrowed) {
    try { await chrome.tabs.remove(currentBulkTabId); } catch (_) {}
  }
  await chrome.storage.local.remove(['currentBulkTabId', 'currentBulkTabBorrowed']);
}
