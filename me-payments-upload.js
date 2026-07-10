// me-payments-upload.js — Upload local Meesho payment ZIPs to Drive
// Reads each ZIP, extracts the XLSX inside, uploads via UPLOAD_DATA_SILENT.

const UPLOAD_CONFIG = {
  folderKey: 'ME_PAYMENTS',
  mimeType:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

let selectedFiles = []; // { file, date, rowId }

// ─── Date extraction from filename ───────────────────────────────────────────
// Handles: meesho_PREVIOUS_PAYMENT_2026-06-12 (2).zip → 2026-06-12

function extractDate(filename) {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// ─── ZIP extraction ───────────────────────────────────────────────────────────

async function extractXlsxFromZip(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4B || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return buffer; // not a ZIP — upload as-is
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

  if (method === 0) return compressed.buffer; // stored

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

  return buffer; // unsupported compression
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function log(msg) {
  const el = document.getElementById('log');
  el.textContent += `[${istTimeOnly(Date.now())}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setRow(rowId, cls, status, size, detail) {
  const st  = document.getElementById(`st-${rowId}`);
  const sz  = document.getElementById(`sz-${rowId}`);
  const det = document.getElementById(`det-${rowId}`);
  if (st)  { st.className = cls; st.textContent = status; }
  if (sz)  sz.textContent = size || '—';
  if (det) det.textContent = detail || '';
}

function renderTable(entries) {
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';
  const tbl = document.getElementById('fileTable');
  if (entries.length === 0) { tbl.style.display = 'none'; return; }
  tbl.style.display = '';
  for (const e of entries) {
    const tr = document.createElement('tr');
    const dateCell = e.date || '<span style="color:#f44">no date</span>';
    tr.innerHTML =
      `<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.file.name}">${e.file.name}</td>` +
      `<td>${e.date || '—'}</td>` +
      `<td class="waiting" id="st-${e.rowId}">Pending</td>` +
      `<td id="sz-${e.rowId}">—</td>` +
      `<td id="det-${e.rowId}">—</td>`;
    tbody.appendChild(tr);
  }
}

// ─── File selection ───────────────────────────────────────────────────────────

function processFiles(fileList) {
  selectedFiles = [];
  let idx = 0;
  for (const f of fileList) {
    if (!f.name.toLowerCase().endsWith('.zip')) continue;
    const date = extractDate(f.name);
    selectedFiles.push({ file: f, date, rowId: idx++ });
  }

  // Sort by date ascending (nulls last)
  selectedFiles.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });

  const noDate = selectedFiles.filter(e => !e.date).length;
  document.getElementById('fileCount').textContent =
    `${selectedFiles.length} ZIP file${selectedFiles.length !== 1 ? 's' : ''} selected` +
    (noDate ? ` (${noDate} without a recognisable date — will be skipped)` : '');

  document.getElementById('uploadBtn').disabled = selectedFiles.length === 0;
  document.getElementById('summary').textContent = '';
  renderTable(selectedFiles);
  document.getElementById('log').textContent = '';
}

const dropZone  = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => processFiles(fileInput.files));

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  processFiles(e.dataTransfer.files);
});

document.getElementById('clearBtn').addEventListener('click', () => {
  selectedFiles = [];
  fileInput.value = '';
  document.getElementById('fileCount').textContent = '';
  document.getElementById('uploadBtn').disabled = true;
  document.getElementById('fileTable').style.display = 'none';
  document.getElementById('summary').textContent = '';
  document.getElementById('log').textContent = '';
});

// ─── Upload ───────────────────────────────────────────────────────────────────

async function uploadOne(entry) {
  if (!entry.date) {
    setRow(entry.rowId, 'skip', 'SKIPPED', '—', 'No date in filename');
    log(`${entry.file.name}: SKIPPED — no date found`);
    return false;
  }

  setRow(entry.rowId, 'running', 'Reading…', '—', 'Reading ZIP');
  log(`${entry.date}: reading ${entry.file.name}`);

  let buffer;
  try {
    buffer = await entry.file.arrayBuffer();
  } catch (err) {
    setRow(entry.rowId, 'error', 'ERROR', '—', `Read failed: ${err.message}`);
    log(`${entry.date}: READ ERROR — ${err.message}`);
    return false;
  }

  setRow(entry.rowId, 'running', 'Extracting…', '—', 'Extracting XLSX from ZIP');
  let xlsxBuf;
  try {
    xlsxBuf = await extractXlsxFromZip(buffer);
  } catch (err) {
    setRow(entry.rowId, 'error', 'ERROR', '—', `ZIP extract failed: ${err.message}`);
    log(`${entry.date}: EXTRACT ERROR — ${err.message}`);
    return false;
  }

  const xlsxBytes = new Uint8Array(xlsxBuf);
  let binary = ''; const CHUNK = 8192;
  for (let i = 0; i < xlsxBytes.length; i += CHUNK)
    binary += String.fromCharCode.apply(null, xlsxBytes.subarray(i, i + CHUNK));
  const base64 = btoa(binary);

  const filename = `meesho_payments_${entry.date}.xlsx`;
  const sizeStr  = `${(xlsxBuf.byteLength / 1024).toFixed(1)} KB`;
  setRow(entry.rowId, 'running', 'Uploading…', sizeStr, `→ ${filename}`);
  log(`${entry.date}: uploading ${filename} (${sizeStr})`);

  const resp = await new Promise(res => chrome.runtime.sendMessage({
    type:      'UPLOAD_DATA_SILENT',
    jobId:     'me_payments_upload',
    data:      base64,
    encoding:  'base64',
    filename,
    folderKey: UPLOAD_CONFIG.folderKey,
    mimeType:  UPLOAD_CONFIG.mimeType,
  }, res));

  if (resp?.ok) {
    setRow(entry.rowId, 'done', 'DONE ✓', sizeStr, filename);
    log(`${entry.date}: SUCCESS — ${filename}`);
    return true;
  } else {
    setRow(entry.rowId, 'error', 'ERROR', sizeStr, 'Drive upload returned ok=false');
    log(`${entry.date}: UPLOAD FAILED — Drive returned ok=false`);
    return false;
  }
}

// ─── Duplicate cleanup ────────────────────────────────────────────────────────
// Delete the older copy of meesho_payments_2026-06-01.xlsx.
// Both IDs confirmed in Drive; we delete the second one and keep the first.

const DEDUP_DELETE_ID = '1l1OlNEYxmUEklbokhZUrWioEjYgWv-XJ';
const DEDUP_KEEP_ID   = '1qnnRVKSWRcm4XC09BSbRZOc7V0mr2gll';

async function getDriveToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      if (chrome.runtime.lastError || !token)
        reject(new Error(chrome.runtime.lastError?.message || 'No auth token'));
      else
        resolve(token);
    });
  });
}

document.getElementById('dedupBtn').addEventListener('click', async () => {
  const btn    = document.getElementById('dedupBtn');
  const status = document.getElementById('dedupStatus');
  btn.disabled = true;
  status.style.color = '#64b5f6';
  status.textContent = 'Deleting…';

  try {
    const token = await getDriveToken();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${DEDUP_DELETE_ID}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 204 || res.status === 200) {
      status.style.color = '#4caf50';
      status.textContent = `Deleted ${DEDUP_DELETE_ID} — keeping ${DEDUP_KEEP_ID}`;
      log(`Dedup: deleted file ${DEDUP_DELETE_ID} (Jun 1 duplicate)`);
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    status.style.color = '#f44336';
    status.textContent = `Failed: ${err.message}`;
    log(`Dedup error: ${err.message}`);
    btn.disabled = false;
  }
});

// ─── Upload ───────────────────────────────────────────────────────────────────

document.getElementById('uploadBtn').addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;

  document.getElementById('uploadBtn').disabled = true;
  document.getElementById('clearBtn').disabled  = true;
  document.getElementById('summary').textContent = '';
  log(`=== Upload started: ${selectedFiles.length} files ===`);

  let ok = 0, fail = 0, skip = 0;
  for (const entry of selectedFiles) {
    const success = await uploadOne(entry);
    if (!entry.date) skip++;
    else if (success) ok++;
    else fail++;
  }

  const parts = [`${ok} uploaded`];
  if (fail) parts.push(`${fail} failed`);
  if (skip) parts.push(`${skip} skipped (no date)`);
  document.getElementById('summary').textContent = parts.join(', ') + ` out of ${selectedFiles.length} files.`;
  document.getElementById('uploadBtn').disabled = false;
  document.getElementById('clearBtn').disabled  = false;
  log(`=== Done: ${ok} OK, ${fail} failed, ${skip} skipped ===`);
});
