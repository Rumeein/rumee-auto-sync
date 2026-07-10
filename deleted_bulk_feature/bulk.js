// ─── Rumee — Bulk Download UI ─────────────────────────────────────────────────
// Runs in bulk.html (a full browser tab). Sends BULK_RUN_NOW / BULK_STOP to SW,
// polls BULK_STATUS every 2s, and renders a live progress table.

const BULK_EXCLUDED = new Set(['me_returns', 'me_catalog', 'me_views', 'fk_listings', 'fk_keywords']);

const BULK_JOBS = (typeof JOBS !== 'undefined')
  ? JOBS.filter(j => !BULK_EXCLUDED.has(j.id))
  : [];

let selectedBulkJobs = new Set();
let pollInterval = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setDefaultDates();
  renderJobList();
  attachListeners();
  pollStatus();
  pollInterval = setInterval(pollStatus, 2000);
});

function setDefaultDates() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const fmt = d => d.toISOString().slice(0, 10);
  document.getElementById('fromDate').value = fmt(yesterday);
  document.getElementById('toDate').value   = fmt(yesterday);
}

// ─── Job list ─────────────────────────────────────────────────────────────────

function renderJobList() {
  const container = document.getElementById('jobList');
  container.innerHTML = '';

  let lastPlatform = null;
  BULK_JOBS.forEach(job => {
    if (job.platform !== lastPlatform) {
      const header = document.createElement('div');
      header.className = 'platform-header';
      header.textContent = job.platform === 'meesho' ? 'Meesho' : 'Flipkart';
      container.appendChild(header);
      lastPlatform = job.platform;
    }

    const grid = (() => {
      let g = container.lastElementChild;
      if (!g || !g.classList.contains('job-grid')) {
        g = document.createElement('div');
        g.className = 'job-grid';
        container.appendChild(g);
      }
      return g;
    })();

    const item = document.createElement('div');
    item.className = 'job-item';
    item.dataset.jobId = job.id;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id   = `bcb_${job.id}`;
    cb.checked = true;
    selectedBulkJobs.add(job.id);

    cb.addEventListener('change', () => {
      if (cb.checked) selectedBulkJobs.add(job.id);
      else            selectedBulkJobs.delete(job.id);
    });

    const label = document.createElement('label');
    label.htmlFor = `bcb_${job.id}`;
    label.className = 'job-label';
    label.textContent = job.label;

    const dot = document.createElement('span');
    dot.className = 'job-status-dot';
    dot.id = `bdot_${job.id}`;

    item.appendChild(cb);
    item.appendChild(label);
    item.appendChild(dot);
    item.addEventListener('click', e => {
      if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
    });
    grid.appendChild(item);
  });
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function attachListeners() {
  document.getElementById('runBtn').addEventListener('click', startBulk);
  document.getElementById('stopBtn').addEventListener('click', stopBulk);

  document.getElementById('selectAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#jobList input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
      selectedBulkJobs.add(cb.id.replace('bcb_', ''));
    });
  });

  document.getElementById('deselectAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#jobList input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
      selectedBulkJobs.delete(cb.id.replace('bcb_', ''));
    });
  });
}

function startBulk() {
  const fromDate = document.getElementById('fromDate').value;
  const toDate   = document.getElementById('toDate').value;

  if (!fromDate || !toDate) {
    setBanner('error', 'Please select both From and To dates.');
    return;
  }
  if (fromDate > toDate) {
    setBanner('error', '"From" date must be on or before "To" date.');
    return;
  }
  if (selectedBulkJobs.size === 0) {
    setBanner('error', 'Please select at least one job.');
    return;
  }

  const jobIds = [...selectedBulkJobs];
  chrome.runtime.sendMessage({ type: 'BULK_RUN_NOW', jobIds, fromDate, toDate }, (resp) => {
    if (resp && resp.error) {
      setBanner('error', resp.error);
    } else {
      setBanner('running', 'Bulk download starting…');
    }
  });
}

function stopBulk() {
  chrome.runtime.sendMessage({ type: 'BULK_STOP' }, () => {
    setBanner('idle', 'Stopped.');
  });
}

// ─── Status polling ───────────────────────────────────────────────────────────

function pollStatus() {
  chrome.runtime.sendMessage({ type: 'BULK_STATUS' }, (data) => {
    if (!data) return;
    renderStatus(data);
  });
}

function renderStatus(data) {
  const running  = data.bulkRunning;
  const queue    = data.bulkQueue    || [];
  const done     = data.bulkDone     || [];
  const failed   = data.bulkFailed   || [];
  const current  = data.currentBulkJobId;

  // Banner
  if (running) {
    const total     = queue.length + done.length + failed.length + (current ? 1 : 0);
    const completed = done.length + failed.length;
    setBanner('running', `Running… ${completed}/${total} complete${current ? ` — ${current}` : ''}`);
  } else if (done.length > 0 || failed.length > 0) {
    if (failed.length === 0) {
      setBanner('done', `Done — ${done.length} file(s) uploaded.`);
    } else {
      setBanner('error', `Finished with ${failed.length} failure(s). ${done.length} succeeded.`);
    }
  } else {
    setBanner('idle', 'Idle — choose a date range and jobs, then click Start.');
  }

  // Buttons
  document.getElementById('runBtn').style.display  = running ? 'none' : '';
  document.getElementById('stopBtn').style.display = running ? '' : 'none';
  document.getElementById('runBtn').disabled  = running;

  // Disable job/date inputs while running
  const inputsDisabled = running;
  document.getElementById('fromDate').disabled = inputsDisabled;
  document.getElementById('toDate').disabled   = inputsDisabled;
  document.querySelectorAll('#jobList input[type="checkbox"]').forEach(cb => cb.disabled = inputsDisabled);
  document.getElementById('selectAllBtn').disabled   = inputsDisabled;
  document.getElementById('deselectAllBtn').disabled = inputsDisabled;

  // Dot indicators on job list
  const doneSet   = new Set(done);
  const failedMap = new Map((failed).map(f => [f.id, f.error || '']));
  BULK_JOBS.forEach(job => {
    const dot = document.getElementById(`bdot_${job.id}`);
    if (!dot) return;
    dot.className = 'job-status-dot';
    if (current === job.id) {
      dot.classList.add('running');
      dot.title = 'Running…';
    } else if (doneSet.has(job.id)) {
      dot.classList.add('ok');
      dot.title = 'Done';
    } else if (failedMap.has(job.id)) {
      dot.classList.add('fail');
      dot.title = failedMap.get(job.id) || 'Failed';
    } else if (queue.includes(job.id)) {
      dot.classList.add('pending');
      dot.title = 'Queued';
    }
  });

  // Progress table
  const hasActivity = running || done.length > 0 || failed.length > 0 || current;
  const section = document.getElementById('progressSection');
  if (hasActivity) {
    section.classList.add('show');
    renderProgressTable({ queue, done, failed, current });
  } else {
    section.classList.remove('show');
  }
}

function renderProgressTable({ queue, done, failed, current }) {
  const body = document.getElementById('progressBody');
  const rows = [];

  const failedMap = new Map((failed || []).map(f => [f.id, f.error || 'Error']));
  const doneSet   = new Set(done || []);
  const queueSet  = new Set(queue || []);

  // Collect all job IDs mentioned in any state
  const allIds = new Set([
    ...(done || []),
    ...(failed || []).map(f => f.id),
    ...(queue || []),
    ...(current ? [current] : []),
  ]);

  for (const jobId of allIds) {
    const job = BULK_JOBS.find(j => j.id === jobId);
    const label = job ? job.label : jobId;

    let statusClass = 'queued';
    let statusText  = 'Queued';
    let errorText   = '';

    if (jobId === current) {
      statusClass = 'running'; statusText = 'Running…';
    } else if (doneSet.has(jobId)) {
      statusClass = 'ok'; statusText = 'Done';
    } else if (failedMap.has(jobId)) {
      statusClass = 'fail'; statusText = 'Failed';
      errorText = failedMap.get(jobId);
    }

    rows.push({ label, statusClass, statusText, errorText });
  }

  body.innerHTML = rows.map(r => `
    <tr>
      <td>${escHtml(r.label)}</td>
      <td class="status-cell ${r.statusClass}">${r.statusText}</td>
      <td class="error-cell">${escHtml(r.errorText)}</td>
    </tr>
  `).join('');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setBanner(type, text) {
  const banner = document.getElementById('statusBanner');
  banner.className = `show ${type}`;
  banner.textContent = text;
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
