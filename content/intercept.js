// ─── Rumee — MAIN World Download Interceptor ─────────────────────────────────
// Declared in manifest.json with "world": "MAIN", "run_at": "document_start".
// Runs in the PAGE's JavaScript context (same scope as the site's own code),
// so patching window.fetch / XMLHttpRequest here actually intercepts the page's
// real download requests.
//
// HOW IT WORKS
// ─────────────
// The isolated-world content script (meesho.js / flipkart.js) sets
//   window.__rumeeIntercepting = true
// just before triggering a download action.  Our patched fetch/XHR checks that
// flag; if set it posts the URL to the isolated world via postMessage and returns
// a dummy response so Chrome never sees the download.  The isolated world picks
// up the URL via its own message listener and forwards it to the background for
// re-fetch → Drive upload.  The flag is cleared once captured (or on timeout).
//
// When __rumeeIntercepting is false (normal user browsing) every request passes
// through unmodified — user downloads are never affected.

'use strict';

const _DOWNLOAD_PATTERNS = [
  /\/download/i, /\/export/i, /downloadReport/i, /getReport/i,
  /\.xlsx(\?|$)/i, /\.csv(\?|$)/i, /\.xls(\?|$)/i, /\.zip(\?|$)/i,
  /amazonaws\.com/i, /storage\.googleapis/i,
  /meesho-prod.*\/file/i,
  /downloadOrders/i, /downloadReturns/i, /downloadPayments/i,
  /seller-api\.flipkart/i,
];

// Endpoints that stream binary directly (not redirect to CDN).
// The fetch intercept lets these through so the page gets the real response
// and creates a blob.  We capture the blob via URL.createObjectURL instead.
const _BLOB_PASSTHROUGH_PATTERNS = [
  /downloadInventoryTemplate/i,
];

function _looksLikeDownload(url) {
  return typeof url === 'string' && _DOWNLOAD_PATTERNS.some(p => p.test(url));
}

function _isBlobPassthrough(url) {
  return typeof url === 'string' && _BLOB_PASSTHROUGH_PATTERNS.some(p => p.test(url));
}

/**
 * Notify the isolated world that a download URL was captured.
 * Returns true if we intercepted it (flag was set), false if we should let it through.
 */
function _capture(url, headers) {
  if (!window.__rumeeIntercepting) return false;
  window.postMessage({ __rumeeDownload: true, url, headers: headers || {} }, '*');
  return true;
}

// ── Catch-all: log ALL download triggers when capturing ───────────────────────

// Form submissions bypass fetch/XHR entirely
const _origFormSubmit = HTMLFormElement.prototype.submit;
HTMLFormElement.prototype.submit = function() {
  const cap = window.__rumeeCapturingBlob || window.__rumeeIntercepting;
  if (cap) console.log(`[Rumee] TRIGGER form.submit: action=${this.action}, method=${this.method}`);
  if (cap && (_looksLikeDownload(this.action) || _isBlobPassthrough(this.action))) {
    // Intercept: make the POST ourselves and capture binary
    const formData = new FormData(this);
    _origFetch(this.action, { method: this.method || 'POST', body: formData, credentials: 'include' })
      .then(async resp => {
        if (!resp.ok) { window.postMessage({ __rumeeBlob: true, base64: '', mimeType: '', size: 0, error: `HTTP ${resp.status}` }, '*'); return; }
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = ''; const C = 8192;
        for (let i = 0; i < bytes.length; i += C) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
        window.postMessage({ __rumeeBlob: true, base64: btoa(bin), mimeType: resp.headers.get('content-type') || '', size: buf.byteLength }, '*');
        console.log(`[Rumee] form.submit captured: ${buf.byteLength} bytes`);
      }).catch(e => window.postMessage({ __rumeeBlob: true, base64: '', mimeType: '', size: 0, error: e.message }, '*'));
    return; // suppress actual form submit (no Save As dialog)
  }
  return _origFormSubmit.apply(this, arguments);
};

// window.open — suppress download URLs when capturing (HTTP, blob:, data:)
const _origWindowOpen2 = window.open;
window.open = function(url) {
  const cap = window.__rumeeCapturingBlob || window.__rumeeIntercepting;
  if (cap && typeof url === 'string') {
    if (_looksLikeDownload(url) || url.startsWith('blob:') || url.startsWith('data:')) {
      console.log(`[Rumee] Suppressed window.open: ${url.slice(0, 80)}`);
      if (!url.startsWith('blob:') && !url.startsWith('data:')) _capture(url, {});
      return null;
    }
  }
  return _origWindowOpen2.apply(this, arguments);
};

// window.location.href = downloadUrl — suppress download navigations when capturing
try {
  const _origHref = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
  if (_origHref && _origHref.set) {
    Object.defineProperty(Location.prototype, 'href', {
      get: _origHref.get,
      set: function(url) {
        if (typeof url === 'string' && (window.__rumeeCapturingBlob || window.__rumeeIntercepting)) {
          // Suppress download navigations: HTTP download URLs, blob: URLs, data: URLs
          if (_looksLikeDownload(url) || url.startsWith('blob:') || url.startsWith('data:')) {
            console.log(`[Rumee] Suppressed location.href: ${url.slice(0, 80)}`);
            if (!url.startsWith('blob:') && !url.startsWith('data:')) _capture(url, {});
            return; // prevent navigation / download dialog
          }
        }
        return _origHref.set.call(this, url);
      }
    });
  }
} catch (_) {}

// ── Patch window.fetch ────────────────────────────────────────────────────────
const _origFetch = window.fetch;
window.fetch = function(input, init) {
  const url = typeof input === 'string' ? input
            : (input && input.url)       ? input.url
            : String(input);

  // ── Flipkart metrics/search header capture (passive) ────────────────────────
  // Captures auth/CSRF headers from the page's own /napi/metrics/search call.
  // These are needed when the content script calls the same endpoint directly.
  // ── Intercept /napi/metrics/search RESPONSE (steal listing IDs from page's own call) ─
  if (url.includes('/napi/metrics/search') && window.__rumeeCapturingMetrics) {
    window.__rumeeCapturingMetrics = false;
    const resp = _origFetch.apply(this, arguments);
    resp.then(async r => {
      try {
        const data = await r.clone().json();
        window.postMessage({ __rumeeMetricsSearchData: true, data }, '*');
        console.log('[Rumee] Captured /napi/metrics/search response');
      } catch (_) {}
    });
    return resp;
  }

  if (url.includes('/napi/metrics/') && init?.headers) {
    try {
      const captured = {};
      const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
      h.forEach((v, k) => {
        if (!['accept-encoding','connection','content-length','host'].includes(k.toLowerCase())) {
          captured[k] = v;
        }
      });
      if (Object.keys(captured).length > 0) {
        window._rumeeMetricsHeaders = captured;
        // Also post to isolated world so it can persist to chrome.storage.local
        window.postMessage({ __rumeeMetricsHeadersCaptured: true, headers: captured }, '*');
        console.log('[Rumee] Captured metrics headers:', Object.keys(captured));
      }
    } catch (_) {}
  }

  // ── Ads session header capture (passive — always on /api/ads/) ──────────────
  // Ads page makes API calls during page load, BEFORE the content script fires.
  // We always capture headers from /api/ads/ and store them for later retrieval.
  // Content script requests them via __rumeeRequestAdsHeaders postMessage.
  if (url.includes('/api/ads/')) {
    try {
      const adsH = {};
      const h = (init || {}).headers;
      if (h) (h instanceof Headers ? h : new Headers(h))
        .forEach((v, k) => { if (['browser-id','supplier-id','identifier','client-type'].includes(k)) adsH[k] = v; });
      if (adsH['browser-id']) {
        window._rumeeAdsHeaders = adsH; // store for content script request
        // If content script is already waiting, respond immediately
        if (window.__rumeeCapturingAdsHeaders) {
          window.postMessage({ __rumeeAdsHeaders: true, headers: adsH }, '*');
          window.__rumeeCapturingAdsHeaders = false;
        }
      }
    } catch (_) {}
  }

  // ── Direct-stream binary download (BLOB_PASSTHROUGH_PATTERNS) ───────────────
  if (_isBlobPassthrough(url)) {
  }
  if (_isBlobPassthrough(url) && (window.__rumeeCapturingBlob || window.__rumeeIntercepting)) {
    console.log(`[Rumee] Direct-stream intercept: ${url.slice(0, 120)}`);
    _origFetch.apply(this, arguments).then(async resp => {
      try {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buffer = await resp.arrayBuffer();
        const bytes  = new Uint8Array(buffer);
        let binary = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        const base64 = btoa(binary);
        const mimeType = resp.headers.get('content-type') || '';
        window.postMessage({ __rumeeBlob: true, base64, mimeType, size: buffer.byteLength }, '*');
        console.log(`[Rumee] Direct-stream captured: ${buffer.byteLength} bytes`);
      } catch (e) {
        console.error('[Rumee] Direct-stream capture failed:', e.message);
        window.postMessage({ __rumeeBlob: true, base64: '', mimeType: '', size: 0, error: e.message }, '*');
      }
    });
    // Abort the page's own fetch so it can't create a secondary download
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }

  // Blob-passthrough URLs not in capture mode — let through normally.
  if (_looksLikeDownload(url) && !_isBlobPassthrough(url)) {
    const headers = {};
    try {
      const h = (init || {}).headers;
      if (h) (h instanceof Headers ? h : new Headers(h)).forEach((v, k) => { headers[k] = v; });
    } catch (_) {}
    if (window.__rumeeIntercepting) {
      // Capture method and body so the proxy can replay the exact same request
      const method = (init && init.method) || 'GET';
      let body = null;
      try {
        if (init && init.body != null) {
          body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        }
      } catch (_) {}
      window.postMessage({ __rumeeDownload: true, url, headers, method, body }, '*');
      return Promise.resolve(new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (_capture(url, headers)) {
      return Promise.resolve(new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
  }
  // ── Expose submitReport response status via window event ─────────────────────
  // Injected scripts (isolated world) listen for __rumeeSubmitReport to detect
  // whether "Request Download" was a new submission (2xx) or duplicate (4xx/5xx).
  if (url.includes('/submitReport')) {
    return _origFetch.apply(this, arguments).then(resp => {
      window.postMessage({ __rumeeSubmitReport: true, status: resp.status }, '*');
      return resp;
    });
  }

  return _origFetch.apply(this, arguments);
};

// ── Patch XMLHttpRequest ──────────────────────────────────────────────────────
const _origXHROpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url) {
  if (_looksLikeDownload(url) && !_isBlobPassthrough(url) && _capture(url, {})) {
    // Return a no-op XHR that never actually sends
    this.send = function() {};
    return;
  }
  return _origXHROpen.apply(this, arguments);
};

// ── Patch window.open (some portals use this for downloads) ───────────────────
const _origWindowOpen = window.open;
window.open = function(url, target, features) {
  if (typeof url === 'string' && _looksLikeDownload(url) && _capture(url, {})) {
    return null; // suppress the popup/download
  }
  return _origWindowOpen.apply(this, arguments);
};

// ── Capture blob-based downloads via URL.createObjectURL ─────────────────────
//
// For endpoints that stream binary directly (BLOB_PASSTHROUGH_PATTERNS):
//   1. The fetch intercept lets the real request through → page gets binary response
//   2. Page creates a Blob and calls URL.createObjectURL(blob)
//   3. Our patch captures the blob as base64 and posts __rumeeBlob
//   4. The isolated-world content script receives it and sends UPLOAD_DATA
//
// We return the real object URL so the page proceeds normally, but the anchor
// click intercept (below) prevents Chrome's download manager from seeing it.
// ── __rumeeCapturingBlob — separate flag for blob-only capture ────────────────
// Unlike __rumeeIntercepting (which gets cleared by the __rumeeDownload relay in
// meesho.js whenever any other download URL is intercepted), __rumeeCapturingBlob
// is ONLY cleared by interceptNextBlobDownload() itself.  This prevents a race
// where an unrelated API call matching _DOWNLOAD_PATTERNS is captured first,
// clearing __rumeeIntercepting before the real blob is created.
const _origCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = function(blob) {
  const objectUrl = _origCreateObjectURL.apply(URL, arguments);
  if ((window.__rumeeCapturingBlob || window.__rumeeIntercepting) && blob instanceof Blob && blob.size > 10) {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      window.postMessage({ __rumeeBlob: true, base64, mimeType: blob.type || '', size: blob.size }, '*');
      console.log(`[Rumee] Blob captured: ${blob.size} bytes (${blob.type})`);
    };
    reader.readAsDataURL(blob);
  }
  return objectUrl;
};

// ── Suppress blob: anchor .click() via prototype patch ───────────────────────
// document.addEventListener('click') only fires for elements IN the DOM.
// Download utilities commonly create a disconnected <a>, set href to a blob URL,
// and call .click() — this never reaches the document capture phase.
// Patching HTMLAnchorElement.prototype.click catches ALL .click() calls.
const _origAnchorClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function() {
  const href = this.href || '';
  const dl   = this.download || '';
  // Debug: log every anchor click when a job is capturing
  if (window.__rumeeCapturingBlob || window.__rumeeIntercepting) {
    console.log(`[Rumee] Anchor .click(): href=${href.slice(0, 120)}, download="${dl}", capBlob=${window.__rumeeCapturingBlob}, intercept=${window.__rumeeIntercepting}`);
  }
  // ── Suppress blob: downloads ──────────────────────────────────────────────
  if (href.startsWith('blob:') && (window.__rumeeCapturingBlob || window.__rumeeIntercepting)) {
    console.log('[Rumee] Suppressed blob anchor .click()');
    return;
  }
  // ── Suppress CDN / download-URL anchor clicks when Rumee is capturing ─────
  // Meesho payment ZIP and similar direct-CDN downloads use an off-DOM anchor
  // with href = signed GCS URL. document.addEventListener('click') never sees
  // disconnected elements, so we must handle it here.
  // Suppressing prevents the "Ask where to save" dialog before the SW can cancel.
  if (_looksLikeDownload(href) && (window.__rumeeCapturingBlob || window.__rumeeIntercepting)) {
    console.log(`[Rumee] Suppressed CDN anchor .click(): ${href.slice(0, 80)}`);
    // Relay URL so content script / background can fetch & upload it
    window.postMessage({ __rumeeDownload: true, url: href, headers: {} }, '*');
    return; // suppress browser download → no Save As dialog
  }
  // ── Capture data: URL downloads (base64 file served inline) ───────────────
  if (href.startsWith('data:') && (window.__rumeeCapturingBlob || window.__rumeeIntercepting)) {
    const semi = href.indexOf(';');
    const comma = href.indexOf(',');
    if (semi > -1 && comma > -1 && href.slice(semi + 1, comma) === 'base64') {
      const mimeType = href.slice(5, semi);
      const base64   = href.slice(comma + 1);
      const size     = Math.floor(base64.length * 3 / 4);
      console.log(`[Rumee] Captured data-URL anchor .click(): ${mimeType}, ~${size} bytes`);
      window.postMessage({ __rumeeBlob: true, base64, mimeType, size }, '*');
      return; // suppress download
    }
  }
  return _origAnchorClick.apply(this, arguments);
};

// ── Intercept anchor <a href="…"> clicks (in-DOM fallback) ───────────────────
// Catches user-triggered clicks and dispatchEvent on in-DOM anchors.
document.addEventListener('click', function(e) {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  if (a.href && a.href.startsWith('blob:') && (window.__rumeeCapturingBlob || window.__rumeeIntercepting)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (_looksLikeDownload(a.href) && _capture(a.href, {})) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true); // capture phase — fires before site handlers

// ── MAIN-world fetch proxy: content script asks MAIN world to make page-context calls ──
// Requests from MAIN world use the same Sec-Fetch-* headers as the page's own JS.
// Isolated world fetch() gets 403 for some Flipkart endpoints; MAIN world doesn't.
window.addEventListener('message', e => {
  if (!e.data?.__rumeeHttpPost) return;
  const { url, body, method, reqId } = e.data;
  _origFetch(url, {
    method: method || 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async resp => {
    if (!resp.ok) {
      window.postMessage({ __rumeeHttpResult: true, reqId, error: `HTTP ${resp.status}` }, '*');
      return;
    }
    const data = await resp.json();
    window.postMessage({ __rumeeHttpResult: true, reqId, data }, '*');
  }).catch(err => {
    window.postMessage({ __rumeeHttpResult: true, reqId, error: String(err) }, '*');
  });
});

// ── MAIN-world GET-text proxy (for Campaign Manager CSV) ─────────────────────
// Like __rumeeHttpPost but for GET requests that should return text (CSV/JSON).
// Uses _origFetch so the request looks identical to the page's own JS calls,
// bypassing the SPA-shell response that isolated-world fetch() receives.
window.addEventListener('message', e => {
  if (!e.data?.__rumeeHttpGetText) return;
  const { url, headers, method, body, reqId } = e.data;
  _origFetch(url, {
    method: method || 'GET',
    credentials: 'include',
    headers: Object.assign({ 'Accept': 'text/csv,text/plain,application/json,*/*' }, headers || {}),
    body: body || undefined,
  }).then(async resp => {
    if (!resp.ok) {
      window.postMessage({ __rumeeHttpResult: true, reqId, error: `HTTP ${resp.status}` }, '*');
      return;
    }
    const text = await resp.text();
    window.postMessage({ __rumeeHttpResult: true, reqId, text }, '*');
  }).catch(err => {
    window.postMessage({ __rumeeHttpResult: true, reqId, error: String(err) }, '*');
  });
});

// ── Navigation bridge: content script posts hash to navigate from MAIN world ──
// Navigating from MAIN world fires the real hashchange event that Angular listens to.
window.addEventListener('message', e => {
  if (e.data && e.data.__rumeeNavigateHash) {
    console.log('[Rumee] MAIN-world hash nav:', e.data.__rumeeNavigateHash.slice(0,80));
    window.location.hash = e.data.__rumeeNavigateHash;
  }
});

// ── Flag bridge: isolated world cannot set window properties visible to MAIN ──
// meesho.js (isolated) posts these messages to set/clear flags here in MAIN world.
window.addEventListener('message', e => {
  if (!e.data) return;
  // Download / blob capture flags
  if ('__rumeeArmCapture' in e.data) {
    window.__rumeeIntercepting  = !!e.data.__rumeeArmCapture;
    window.__rumeeCapturingBlob = !!(e.data.__rumeeArmCapture || e.data.__rumeeCapturingBlob);
  }
  // Respond with passively-captured metrics headers
  if (e.data.__rumeeRequestMetricsHeaders) {
    window.postMessage({ __rumeeMetricsHeaders: true, headers: window._rumeeMetricsHeaders || {} }, '*');
  }
  // Metrics search response capture flag
  if ('__rumeeArmMetricsCapture' in e.data) {
    window.__rumeeCapturingMetrics = !!e.data.__rumeeArmMetricsCapture;
  }
  // Ads session header capture flag
  if ('__rumeeArmAdsCapture' in e.data) {
    window.__rumeeCapturingAdsHeaders = !!e.data.__rumeeArmAdsCapture;
    // If headers were already passively captured, respond immediately
    if (e.data.__rumeeArmAdsCapture && window._rumeeAdsHeaders?.['browser-id']) {
      window.postMessage({ __rumeeAdsHeaders: true, headers: window._rumeeAdsHeaders }, '*');
      window.__rumeeCapturingAdsHeaders = false;
    }
  }
});

console.log('[Rumee] MAIN-world download interceptor active');
