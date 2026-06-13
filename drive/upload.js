// ─── Rumee Extension — Google Drive Upload ───────────────────────────────────
// Uses resumable upload protocol for all files (handles any size safely).
// Called only from background.js.

/**
 * Get (or refresh) the OAuth2 token via chrome.identity.
 * Token is cached in chrome.storage.local with an expiry timestamp.
 * Always call this before any Drive API request.
 */
async function getDriveToken(interactive = false) {
  const { driveToken, driveTokenExpiry } = await chrome.storage.local.get([
    'driveToken',
    'driveTokenExpiry',
  ]);

  // Use cached token if still valid (with 5-minute buffer)
  if (driveToken && driveTokenExpiry && Date.now() < driveTokenExpiry - 300_000) {
    return driveToken;
  }

  // Request a fresh token
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(
          chrome.runtime.lastError?.message || 'Failed to get Drive auth token'
        ));
        return;
      }
      // Cache token — Drive tokens typically expire in 1 hour
      await chrome.storage.local.set({
        driveToken: token,
        driveTokenExpiry: Date.now() + 3600_000,
      });
      resolve(token);
    });
  });
}

/**
 * Clear the cached token (call when Drive API returns 401).
 */
async function invalidateDriveToken() {
  const { driveToken } = await chrome.storage.local.get('driveToken');
  if (driveToken) {
    // Tell Chrome to forget this token so next getAuthToken fetches a new one
    await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token: driveToken }, resolve));
  }
  await chrome.storage.local.remove(['driveToken', 'driveTokenExpiry']);
}

/**
 * Upload an ArrayBuffer to a Drive folder using the resumable upload protocol.
 * Safe for any file size.
 *
 * @param {ArrayBuffer} buffer     - File contents
 * @param {string}      filename   - Name to give the file in Drive
 * @param {string}      folderId   - Drive folder ID (parent)
 * @param {string}      mimeType   - MIME type of the file
 * @returns {Promise<{id: string, name: string}>} - Drive file metadata
 */
async function uploadToDrive(buffer, filename, folderId, mimeType) {
  const token = await getDriveToken(true);

  // ── Step 1: Initiate resumable upload session ─────────────────────────────
  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'POST',
      headers: {
        'Authorization':           `Bearer ${token}`,
        'Content-Type':            'application/json',
        'X-Upload-Content-Type':   mimeType,
        'X-Upload-Content-Length': String(buffer.byteLength),
      },
      body: JSON.stringify({
        name:    filename,
        parents: [folderId],
      }),
    }
  );

  if (initRes.status === 401) {
    await invalidateDriveToken();
    throw new Error('Drive token expired — will retry on next run');
  }
  if (!initRes.ok) {
    const errBody = await initRes.text();
    throw new Error(`Drive session init failed (${initRes.status}): ${errBody}`);
  }

  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) throw new Error('Drive did not return a resumable upload URL');

  // ── Step 2: Upload the file body ──────────────────────────────────────────
  const uploadRes = await fetch(uploadUrl, {
    method:  'PUT',
    headers: {
      'Content-Type':   mimeType,
      'Content-Length': String(buffer.byteLength),
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const errBody = await uploadRes.text();
    throw new Error(`Drive file upload failed (${uploadRes.status}): ${errBody}`);
  }

  return uploadRes.json(); // { id, name, ... }
}

// ─── Drive file search ────────────────────────────────────────────────────────

/**
 * Search for a file by name within a specific Drive folder.
 * Returns { id, name } of the first match, or null if not found.
 *
 * @param {string} token     - Bearer token from getDriveToken()
 * @param {string} folderId  - Drive folder to search in
 * @param {string} filename  - Exact file name to look for
 */
async function searchDriveFile(token, folderId, filename) {
  const q = encodeURIComponent(
    `name='${filename.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (res.status === 401) { await invalidateDriveToken(); throw new Error('Drive token expired'); }
  if (!res.ok) throw new Error(`Drive search failed (${res.status})`);

  const data = await res.json();
  return (data.files && data.files.length > 0) ? data.files[0] : null;
}

// ─── Drive file read ──────────────────────────────────────────────────────────

/**
 * Download the text content of a Drive file by its file ID.
 *
 * @param {string} token   - Bearer token
 * @param {string} fileId  - Drive file ID
 * @returns {Promise<string>} - File content as a UTF-8 string
 */
async function downloadDriveFileText(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (res.status === 401) { await invalidateDriveToken(); throw new Error('Drive token expired'); }
  if (!res.ok) throw new Error(`Drive file download failed (${res.status})`);
  return res.text();
}

// ─── Drive file update ────────────────────────────────────────────────────────

/**
 * Overwrite the content of an existing Drive file.
 * Uses the multipart upload protocol (simpler than resumable for small files).
 *
 * @param {string}      token    - Bearer token
 * @param {string}      fileId   - Drive file ID to update
 * @param {ArrayBuffer} buffer   - New file content
 * @param {string}      mimeType - MIME type of the content
 */
async function updateDriveFile(token, fileId, buffer, mimeType) {
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method:  'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':   mimeType,
        'Content-Length': String(buffer.byteLength),
      },
      body: buffer,
    }
  );

  if (res.status === 401) { await invalidateDriveToken(); throw new Error('Drive token expired'); }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive file update failed (${res.status}): ${body}`);
  }
  return res.json(); // { id, name, ... }
}
