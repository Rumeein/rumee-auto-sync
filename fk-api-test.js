// fk-api-test.js — Flipkart Seller API test lab
// Open via: chrome-extension://eipligfabjdahmklcddijnegenacgbdp/fk-api-test.html
// Does NOT modify any existing extension files.

const TOKEN_URL = 'https://api.flipkart.net/oauth-service/oauth/token';
const API_BASE  = 'https://api.flipkart.net/sellers';

const PRESETS = {
  orders:        { url: `${API_BASE}/orders/v2`,       params: '{"filter": "created", "created_from": "2026-06-17", "created_to": "2026-06-17"}' },
  returns:       { url: `${API_BASE}/returns`,          params: '' },
  payments:      { url: `${API_BASE}/payments`,         params: '' },
  listings:      { url: `${API_BASE}/listings`,         params: '' },
  shipments:     { url: `${API_BASE}/shipments`,        params: '' },
  skus:          { url: `${API_BASE}/skus`,             params: '' },
  notifications: { url: `${API_BASE}/notifications`,   params: '' },
};

let accessToken  = null;
let tokenExpires = 0;   // epoch ms

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const el = document.getElementById('log');
  el.textContent += `[${istTimeOnly(Date.now())}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

// ── Token ─────────────────────────────────────────────────────────────────────

async function getToken() {
  const apiKey    = document.getElementById('apiKey').value.trim();
  const apiSecret = document.getElementById('apiSecret').value.trim();
  const scope     = document.getElementById('scopeInput').value.trim();

  if (!apiKey || !apiSecret) {
    setTokenStatus('error', 'Enter API Key and Secret first.');
    return;
  }

  document.getElementById('tokenBtn').disabled = true;
  setTokenStatus('idle', 'Requesting token…');
  log('POST ' + TOKEN_URL);

  try {
    const credentials = btoa(apiKey + ':' + apiSecret);
    const qs = new URLSearchParams({ grant_type: 'client_credentials' });
    if (scope) qs.set('scope', scope);

    // Store credentials so onAuthRequired listener can supply them if server challenges us
    await chrome.storage.local.set({ fkApiKey: apiKey, fkApiSecret: apiSecret });

    // FK OAuth token endpoint requires POST with body (not GET with query string)
    const resp = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + credentials,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: qs.toString(),
    });

    const raw = await resp.text();

    // Log ALL response headers — critical for rate limit debugging (Retry-After, X-RateLimit-*)
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    log(`HTTP ${resp.status} — headers: ${JSON.stringify(headers)}`);
    log(`Body: ${raw.slice(0, 300)}`);

    if (!resp.ok) {
      const retryAfter = resp.headers.get('retry-after') || resp.headers.get('Retry-After');
      const resetTime  = resp.headers.get('x-ratelimit-reset') || resp.headers.get('X-RateLimit-Reset');
      let errDetail = `HTTP ${resp.status} — ${raw.slice(0, 100)}`;
      if (retryAfter) errDetail += ` | Retry-After: ${retryAfter}s`;
      if (resetTime)  errDetail += ` | Reset at: ${new Date(+resetTime * 1000).toLocaleTimeString()}`;
      setTokenStatus('error', errDetail);
      return;
    }

    const json = JSON.parse(raw);
    accessToken  = json.access_token;
    const expiresIn = json.expires_in || 3600;
    tokenExpires = Date.now() + expiresIn * 1000;

    setTokenStatus('ok',
      `Token OK — expires in ${expiresIn}s` +
      (json.token_type ? `  [${json.token_type}]` : '') +
      (json.scope ? `  scope: ${json.scope}` : '')
    );
    log(`Token received. Expires in ${expiresIn}s.`);

  } catch (err) {
    setTokenStatus('error', 'Fetch error: ' + err.message);
    log('Token fetch error: ' + err.message);
  } finally {
    document.getElementById('tokenBtn').disabled = false;
  }
}

function setTokenStatus(type, msg) {
  const el = document.getElementById('tokenStatus');
  el.className = 'status-bar ' + (type === 'ok' ? 'status-ok' : type === 'error' ? 'status-err' : 'status-idle');
  el.textContent = msg;
}

// ── Presets ───────────────────────────────────────────────────────────────────

function preset(name) {
  const p = PRESETS[name];
  if (!p) return;
  document.getElementById('endpointUrl').value = p.url;
  document.getElementById('paramsArea').value  = p.params;
  document.getElementById('method').value      = 'GET';
}

// ── Send request ──────────────────────────────────────────────────────────────

async function sendRequest() {
  if (!accessToken) {
    document.getElementById('reqStatus').textContent = 'No token — get token first.';
    return;
  }
  if (Date.now() > tokenExpires) {
    document.getElementById('reqStatus').textContent = 'Token expired — refresh it.';
    return;
  }

  const method = document.getElementById('method').value;
  let   url    = document.getElementById('endpointUrl').value.trim();
  const params = document.getElementById('paramsArea').value.trim();

  if (!url) {
    document.getElementById('reqStatus').textContent = 'Enter a URL.';
    return;
  }

  document.getElementById('sendBtn').disabled = true;
  document.getElementById('reqStatus').textContent = 'Sending…';
  setResponse('…');

  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Accept':        'application/json',
  };

  let fetchOpts = { method, headers };

  // If GET + params look like JSON object → append as query string
  // If POST + params → send as JSON body
  if (params) {
    if (method === 'GET') {
      try {
        const obj = JSON.parse(params);
        const qs  = new URLSearchParams(obj).toString();
        url = url + (url.includes('?') ? '&' : '?') + qs;
      } catch {
        // treat as raw query string already
        url = url + (url.includes('?') ? '&' : '?') + params;
      }
    } else {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = params;
    }
  }

  log(`${method} ${url}`);

  try {
    const resp = await fetch(url, fetchOpts);
    const raw  = await resp.text();

    document.getElementById('reqStatus').textContent =
      `HTTP ${resp.status} ${resp.statusText} — ${raw.length} bytes`;

    log(`HTTP ${resp.status} — ${raw.length} bytes`);

    let display = raw;
    try {
      const parsed = JSON.parse(raw);
      display = JSON.stringify(parsed, null, 2);
    } catch { /* not JSON — show raw */ }

    setResponse(display);

  } catch (err) {
    document.getElementById('reqStatus').textContent = 'Fetch error: ' + err.message;
    setResponse('ERROR: ' + err.message);
    log('Fetch error: ' + err.message);
  } finally {
    document.getElementById('sendBtn').disabled = false;
  }
}

function setResponse(text) {
  document.getElementById('responseBox').textContent = text;
}

function clearResponse() {
  setResponse('— response will appear here —');
  document.getElementById('reqStatus').textContent = '';
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Pre-populate secret from secrets.js
  if (typeof FLIPKART_API_SECRET !== 'undefined') {
    document.getElementById('apiSecret').value = FLIPKART_API_SECRET;
  }

  // Button wiring
  document.getElementById('tokenBtn').addEventListener('click', getToken);
  document.getElementById('sendBtn').addEventListener('click', sendRequest);
  document.getElementById('clearBtn').addEventListener('click', clearResponse);

  // Preset buttons
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => preset(btn.dataset.preset));
  });

  // Enter on secret field triggers token fetch
  document.getElementById('apiSecret').addEventListener('keydown', e => {
    if (e.key === 'Enter') getToken();
  });

  // Save credentials on change (stored locally in extension only)
  document.getElementById('apiKey').addEventListener('change', e => {
    chrome.storage.local.set({ fkApiKey: e.target.value.trim() });
  });
  document.getElementById('apiSecret').addEventListener('change', e => {
    chrome.storage.local.set({ fkApiSecret: e.target.value.trim() });
  });

  // Restore saved credentials
  chrome.storage.local.get(['fkApiKey', 'fkApiSecret'], ({ fkApiKey, fkApiSecret }) => {
    if (fkApiKey)    { document.getElementById('apiKey').value    = fkApiKey; }
    if (fkApiSecret) { document.getElementById('apiSecret').value = fkApiSecret; }
    if (fkApiKey) log('Restored saved API Key from storage.');
  });
});
