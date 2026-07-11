// ─── Rumee Extension — Google Sheets API helpers ─────────────────────────────
// Used for the Download Manifest — a native Google Sheet instead of a CSV
// file, so that merely opening/viewing it in Drive can never reformat the
// data. A CSV is plain text: Excel/Sheets silently reformats date-looking
// columns and strips quoting on open+save (see DOCS.md Section 25 for the
// 2026-07-10 incident this replaced). A Sheet stores typed cell values —
// there is no "resave the whole file as text" step for viewing to trigger.
// Uses the same drive.file OAuth token as drive/upload.js — confirmed
// against Google's own Sheets API scope docs that drive.file is sufficient
// for files this app created; no extra permission/re-consent needed.
// Called only from background.js.

/**
 * Create a new Google Sheet inside a Drive folder.
 * @returns {Promise<string>} spreadsheetId
 */
async function createSheetInFolder(token, folderId, name) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [folderId],
    }),
  });
  if (res.status === 401) { await invalidateDriveToken(); throw new Error('Drive token expired'); }
  if (!res.ok) throw new Error(`Sheet create failed (${res.status}): ${await res.text()}`);
  return (await res.json()).id;
}

/**
 * Read a range of cell values. Returns [] if the range is empty.
 */
async function sheetsGetValues(token, sheetId, range) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (res.status === 401) { await invalidateDriveToken(); throw new Error('Drive token expired'); }
  if (!res.ok) throw new Error(`Sheets values.get failed (${res.status}): ${await res.text()}`);
  return (await res.json()).values || [];
}

/**
 * Clear a range of cell values. Always called before a full overwrite so no
 * stale trailing rows can ever survive a shrink — the same defect class
 * (trailing blank rows) observed in the corrupted CSV this replaces.
 */
async function sheetsClearValues(token, sheetId, range) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (res.status === 401) { await invalidateDriveToken(); throw new Error('Drive token expired'); }
  if (!res.ok) throw new Error(`Sheets values.clear failed (${res.status}): ${await res.text()}`);
}

/**
 * Write cell values starting at the top-left of `range`.
 * valueInputOption=RAW is required — USER_ENTERED mimics typing into the UI
 * and would let Sheets auto-detect date-looking strings and convert them to
 * date-typed cells, which is exactly the corruption this replaces the CSV
 * to avoid.
 */
async function sheetsSetValues(token, sheetId, range, values) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values }),
    }
  );
  if (res.status === 401) { await invalidateDriveToken(); throw new Error('Drive token expired'); }
  if (!res.ok) throw new Error(`Sheets values.update failed (${res.status}): ${await res.text()}`);
}
