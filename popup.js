// ─── Rumee Extension — Popup ──────────────────────────────────────────────────
// Loads config.js via manifest (listed in web_accessible_resources is NOT needed
// for popup — popup.html can <script src="config.js"> directly, but we load it
// via a dynamic import workaround since config.js uses const not export).

// We reference JOBS and DRIVE_FOLDERS from config.js which is loaded first.
// popup.html loads: <script src="config.js"></script><script src="popup.js"></script>

document.addEventListener('DOMContentLoaded', init);

let selectedJobs = new Set();

function init() {
  chrome.runtime.sendMessage({ type: 'GET_SETUP_STATUS' }, (data) => {
    if (data && data.needsSetup) {
      showSetupScreen();
    } else {
      showMainUI();
    }
  });
}

function showSetupScreen() {
  document.getElementById('setupScreen').classList.remove('hidden');
  document.getElementById('mainUI').classList.add('hidden');
  document.getElementById('createFoldersBtn').addEventListener('click', runSetup);
}

function showMainUI() {
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('mainUI').classList.remove('hidden');
  renderJobList();
  loadStatus();
  attachListeners();
  setInterval(loadStatus, 2000);
}

function runSetup() {
  const btn    = document.getElementById('createFoldersBtn');
  const status = document.getElementById('setupStatus');
  btn.disabled = true;
  btn.textContent = 'Creating folders…';
  status.classList.remove('hidden');
  status.textContent = 'Connecting to Google Drive…';

  chrome.runtime.sendMessage({ type: 'CREATE_FOLDERS' }, (result) => {
    if (result && result.success) {
      status.textContent = 'All folders created! Loading…';
      setTimeout(() => showMainUI(), 1200);
    } else {
      status.textContent = 'Error: ' + (result && result.error ? result.error : 'Unknown error. Try again.');
      btn.disabled = false;
      btn.textContent = 'Create My Drive Folders';
    }
  });
}

// ── Render job list ───────────────────────────────────────────────────────────

function renderJobList() {
  const container = document.getElementById('jobList');
  container.innerHTML = '';

  let lastPlatform = null;
  JOBS.forEach(job => {
    if (job.platform !== lastPlatform) {
      const div = document.createElement('div');
      div.className = 'platform-divider';
      div.textContent = job.platform === 'meesho' ? '── Meesho' : '── Flipkart';
      container.appendChild(div);
      lastPlatform = job.platform;
    }

    const row = document.createElement('div');
    row.className = 'job-row';
    row.dataset.jobId = job.id;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id   = `cb_${job.id}`;
    cb.checked = job.frequency !== 'manual'; // auto-select non-manual jobs

    if (cb.checked) selectedJobs.add(job.id);

    cb.addEventListener('change', () => {
      if (cb.checked) selectedJobs.add(job.id);
      else            selectedJobs.delete(job.id);
    });

    const label = document.createElement('label');
    label.htmlFor = `cb_${job.id}`;
    label.className = 'job-label' + (job.frequency === 'manual' ? ' manual' : '');
    label.textContent = job.label;

    const status = document.createElement('span');
    status.className = 'job-status pending';
    status.id = `status_${job.id}`;
    status.textContent = '—';

    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(status);
    container.appendChild(row);

    // Clicking the row (not just checkbox) toggles the checkbox
    row.addEventListener('click', e => {
      if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
    });
  });
}

// ── Load & display current status ─────────────────────────────────────────────

function loadStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (data) => {
    if (!data) return;
    updateBanner(data);
    updateJobStatuses(data);
    updateLastRunSummary(data);
    updateProgressSection(data);
    updateButtons(data);
    updateScheduleInput(data);
  });
}

function updateBanner(data) {
  const banner = document.getElementById('statusBanner');
  const icon   = document.getElementById('statusIcon');
  const text   = document.getElementById('statusText');

  if (data.syncRunning) {
    banner.className = 'banner banner--running';
    icon.textContent = '⟳';
    text.textContent = `Syncing… (${(data.syncDone || []).length + (data.syncFailed || []).length + (data.syncQueue || []).length} jobs)`;
  } else if ((data.syncFailed || []).length > 0 && (data.syncDone || []).length > 0) {
    banner.className = 'banner banner--error';
    icon.textContent = '⚠';
    text.textContent = `Last sync had ${data.syncFailed.length} failure(s)`;
  } else if ((data.syncDone || []).length > 0) {
    banner.className = 'banner banner--done';
    icon.textContent = '✓';
    text.textContent = 'Last sync completed';
  } else {
    banner.className = 'banner banner--idle';
    icon.textContent = '⏸';
    text.textContent = 'Idle';
  }
}

function updateJobStatuses(data) {
  const done   = new Set(data.syncDone   || []);
  const failed = new Set((data.syncFailed || []).map(f => f.id));
  const queue  = new Set(data.syncQueue  || []);

  JOBS.forEach(job => {
    const el = document.getElementById(`status_${job.id}`);
    if (!el) return;

    if (data.currentJobId === job.id) {
      el.className = 'job-status running';
      el.textContent = '⟳';
    } else if (done.has(job.id)) {
      el.className = 'job-status ok';
      el.textContent = '✓';
    } else if (failed.has(job.id)) {
      el.className = 'job-status fail';
      el.textContent = '✗';
    } else if (queue.has(job.id)) {
      el.className = 'job-status pending';
      el.textContent = '…';
    } else if (data.lastRun?.[job.id]) {
      el.className = 'job-status ok';
      el.textContent = data.lastRun[job.id];
    } else {
      el.className = 'job-status pending';
      el.textContent = '—';
    }
  });
}

function updateLastRunSummary(data) {
  const el = document.getElementById('lastRunSummary');
  if (!data.lastRun || Object.keys(data.lastRun).length === 0) {
    el.textContent = 'Never run';
    return;
  }
  const dates = Object.values(data.lastRun);
  const latest = dates.reduce((a, b) => a > b ? a : b);
  const doneCount = Object.keys(data.lastRun).length;
  el.textContent = `${doneCount} file(s) · latest ${latest}`;
}

function updateProgressSection(data) {
  const section = document.getElementById('progressSection');
  const jobEl   = document.getElementById('currentJob');
  const queueEl = document.getElementById('queueCount');

  if (data.syncRunning && data.currentJobId) {
    section.classList.remove('hidden');
    const job = JOBS.find(j => j.id === data.currentJobId);
    jobEl.textContent = job ? job.label : data.currentJobId;
    const remaining = (data.syncQueue || []).length;
    queueEl.textContent = remaining > 0 ? `${remaining} job(s) remaining` : 'Last job…';
  } else {
    section.classList.add('hidden');
  }
}

function updateButtons(data) {
  const runBtn  = document.getElementById('runNowBtn');
  const stopBtn = document.getElementById('stopBtn');

  // Kill button is ALWAYS visible — it also cancels pending recheck alarms, which
  // can re-trigger navigation even when no sync shows as "running".
  stopBtn.classList.remove('hidden');
  if (data.syncRunning) {
    runBtn.classList.add('hidden');
  } else {
    runBtn.classList.remove('hidden');
  }
  runBtn.disabled = data.syncRunning;
}

function updateScheduleInput(data) {
  const input = document.getElementById('scheduleTime');
  if (document.activeElement === input) return; // don't override while editing
  const h = String(data.scheduleHour   ?? 16).padStart(2, '0');
  const m = String(data.scheduleMinute ?? 0).padStart(2, '0');
  input.value = `${h}:${m}`;
}

// ── Event listeners ───────────────────────────────────────────────────────────

function attachListeners() {
  // Run now
  document.getElementById('runNowBtn').addEventListener('click', () => {
    const jobIds = selectedJobs.size > 0 ? [...selectedJobs] : null;
    chrome.runtime.sendMessage({ type: 'RUN_NOW', jobIds }, () => loadStatus());
  });

  // Select all / deselect all toggle
  let allSelected = true;
  document.getElementById('selectAllBtn').addEventListener('click', () => {
    allSelected = !allSelected;
    document.querySelectorAll('.job-row input[type="checkbox"]').forEach(cb => {
      cb.checked = allSelected;
      const jobId = cb.id.replace('cb_', '');
      if (allSelected) selectedJobs.add(jobId);
      else             selectedJobs.delete(jobId);
    });
    document.getElementById('selectAllBtn').textContent = allSelected ? 'deselect all' : 'select all';
  });

  // Open log viewer in a new tab
  document.getElementById('viewLogBtn').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('log.html') });
  });

  // Stop sync
  document.getElementById('stopBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_SYNC' }, () => loadStatus());
  });

  // Save schedule
  document.getElementById('saveScheduleBtn').addEventListener('click', () => {
    const [h, m] = document.getElementById('scheduleTime').value.split(':').map(Number);
    chrome.runtime.sendMessage({ type: 'UPDATE_SCHEDULE', hour: h, minute: m }, () => {
      document.getElementById('saveScheduleBtn').textContent = 'Saved ✓';
      setTimeout(() => { document.getElementById('saveScheduleBtn').textContent = 'Save'; }, 2000);
    });
  });
}
