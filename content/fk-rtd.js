// ─── Rumee Extension — Flipkart one-by-one order actions ────────────────────
// Runs on https://seller.flipkart.com/* (document_idle), but stays completely
// inert unless the page is Active Orders → Pending-to-Pack or Pending-to-Accept.
//
// WHY THIS EXISTS: Flipkart's bulk actions are broken, so every order has to be
// handled with an individual click. This drives those clicks one at a time, with
// randomised pacing so it behaves like a person working through the list rather
// than a burst of scripted clicks.
//
// Two modes, picked automatically from the page URL:
//   pendingToPack   → clicks "Mark RTD" on each row
//   pendingToAccept → clicks "Accept" on each row, optionally only for the SKUs
//                     ticked in the panel (Scan SKUs lists every SKU on the tab
//                     with its order count first)
//
// It is NOT part of the daily sync and never auto-starts — only the Start button
// on its own on-page panel begins a run. State lives in chrome.storage.local so a
// page reload (its own, or Flipkart's) resumes the run instead of losing it.

if (!window.__rumeeRtdInjected) {
window.__rumeeRtdInjected = true;

'use strict';

const STATE_KEY  = 'fkRtdBot';
const LOG_KEY    = 'fkRtdLog';
const UI_KEY     = 'fkRtdUi';      // panel position + collapsed state
const FILTER_KEY = 'fkRtdFilter';  // { mode: [sku, sku, ...] } — survives reloads mid-run

// The two Active Orders tabs this works on. `labels` are the exact button texts
// on a row; `tile` is the counter chip used to confirm an action landed.
const MODES = {
  pack: {
    id:     'pack',
    tabKey: 'pendingToPack',
    title:  'Mark RTD',
    verb:   'Mark RTD',
    labels: ['mark rtd', 'mark as rtd', 'mark ready to dispatch'],
    tiles:  ['Pending RTD', 'To Pack'],
    skuFilter: false,
  },
  accept: {
    id:     'accept',
    tabKey: 'pendingToAccept',
    title:  'Accept orders',
    verb:   'Accept',
    labels: ['accept', 'accept order', 'accept orders'],
    tiles:  ['To Accept'],
    skuFilter: true,
    // Inspected live 2026-08-19: a row's "Accept Orders" is NOT a button — it is
    // an accordion header (a plain div, data-testid="accordion-header") that
    // opens a small panel offering "Accept All N Order(s)" and "Accept Orders
    // Partially". So this tab needs two clicks per row, and we always take the
    // full-accept option.
    findRows() {
      return [...document.querySelectorAll('[data-testid="accordion-header"]')]
        .filter(h => /^accept orders?/i.test(txt(h)) && isVisible(h) && !isDisabled(h))
        .map(h => {
          const ctx = rowContextFor(h);
          return ctx ? { el: h, ctx, sku: skuOf(ctx.text) } : null;
        })
        .filter(Boolean);
    },
    async act(pick) {
      const scope = pick.el.closest('[data-testid^="accordion-component"]')
                 || pick.el.parentElement;
      const findAcceptAll = () => [...scope.querySelectorAll('button')].find(b =>
        /^accept all \d+ orders?$/i.test(txt(b)) && isVisible(b) && !isDisabled(b));

      // One native click opens the row. aria-expanded is not trustworthy here —
      // it stayed "false" on a panel that had visibly opened — so the arrival of
      // the "Accept All ..." button is the real signal.
      await humanClick(pick.el, { native: true });
      const btn = await waitFor(findAcceptAll, 8000);
      if (!btn) { await log('  row panel did not open'); return false; }
      await log('  panel open → "' + txt(btn) + '"');
      await humanClick(btn, { native: true });
      return true;
    },
  },
};

const urlFor = mode =>
  'https://seller.flipkart.com/index.html#dashboard/active-orders?query='
  + encodeURIComponent('{"activeShipmentTile":"' + mode.tabKey + '"}');

function currentMode() {
  const h = decodeURIComponent(location.hash || '');
  if (!/active-orders/i.test(h)) return null;
  if (new RegExp(MODES.accept.tabKey, 'i').test(h)) return MODES.accept;
  if (new RegExp(MODES.pack.tabKey,   'i').test(h)) return MODES.pack;
  return null;
}

// Pacing (milliseconds). Every wait is randomised around these — never a fixed beat.
const PACE = {
  betweenOrdersMin:  2200,
  betweenOrdersMax:  6500,
  breakEveryMin:     8,      // after this many clicks (randomised up to Max) take a longer break
  breakEveryMax:     15,
  breakMin:          18000,
  breakMax:          55000,
  rowWaitMs:         45000,  // how long to wait for the list to render before reloading
  confirmWaitMs:     12000,  // how long to wait for the row to disappear after a click
  maxReloads:        6,      // consecutive reloads with no rows before giving up
  maxFails:          5,      // consecutive clicks that changed nothing before giving up
  reloadEveryClicks: 25,     // refresh the list periodically so it doesn't go stale
};

// ── small helpers ───────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => Math.floor(a + Math.random() * (b - a));

// Randomised wait that is occasionally much longer — a flat random range still
// looks mechanical; real people stall now and then.
async function humanPause(min, max) {
  let ms = rand(min, max);
  if (Math.random() < 0.12) ms += rand(2000, 9000);
  await sleep(ms);
}

// Polls until `fn()` returns something truthy, or the timeout runs out.
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
}

const txt = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();

function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.2;
}

function isDisabled(el) {
  if (el.disabled === true) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  if (/disabled/i.test(el.className || '')) return true;
  const cs = getComputedStyle(el);
  if (cs.pointerEvents === 'none') return true;
  if (parseFloat(cs.opacity || '1') < 0.55) return true;
  return false;
}

// A row's action button sits inside a container that also carries the order's
// SKU / FSN text. The toolbar's bulk button does not — that is how the two are
// told apart, on top of the disabled check.
function rowContextFor(el) {
  let node = el;
  for (let i = 0; i < 10 && node; i++) {
    node = node.parentElement;
    if (!node) break;
    const t = txt(node);
    if (/SKU ID|FSN|Order ID/i.test(t) && t.length > 40) {
      // The toolbar's bulk button has no row of its own, so walking up from it
      // eventually lands on a container holding the WHOLE table. Anything covering
      // more than one order is not a row — reject it outright (an outer container
      // can only get bigger, so there is no point walking further).
      if ((t.match(/SKU ID/gi) || []).length > 1 || t.length > 600) return null;
      return { node, text: t };
    }
  }
  return null;
}

function skuOf(rowText) {
  const m = rowText.match(/SKU ID:\s*([^|]+?)\s*(?:\||FSN\b|$)/i);
  return m ? m[1].trim() : '(no SKU)';
}

function actionRowButtons(mode) {
  if (mode.findRows) return mode.findRows();
  const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
  const out = [];
  for (const el of nodes) {
    const t = txt(el).toLowerCase();
    if (!(mode.match ? mode.match(t) : mode.labels.indexOf(t) !== -1)) continue;
    if (!isVisible(el) || isDisabled(el)) continue;
    const ctx = rowContextFor(el);
    if (!ctx) continue;                       // toolbar / bulk button — skip
    out.push({ el, ctx, sku: skuOf(ctx.text) });
  }
  return out;
}

// Reads a counter chip such as "Pending RTD 75" or the "0 To Accept" tile.
function readTile(label) {
  const nodes = [...document.querySelectorAll('div, span, li, button, a')];
  const re    = new RegExp('^(\\d+)\\s*' + label + '$|^' + label + '\\s*(\\d+)$', 'i');
  for (const el of nodes) {
    const t = txt(el);
    if (t.length > 30) continue;
    const m = t.match(re);
    if (m) return parseInt(m[1] || m[2], 10);
  }
  return null;
}

function readPendingCount(mode) {
  for (const label of mode.tiles) {
    const n = readTile(label);
    if (n != null) return n;
  }
  return null;
}

// Flipkart's own empty-state artwork, e.g. "No orders to accept" / "No orders
// to pack". Its exact wording differs per tab, so only the shape is matched.
function isEmptyState() {
  return [...document.querySelectorAll('div, p, span, h1, h2, h3')].some(el => {
    const t = txt(el);
    return t.length < 60 && /^No orders/i.test(t) && isVisible(el);
  });
}

function isLoggedOut() {
  const url = location.href, title = (document.title || '').toLowerCase();
  return url.includes('/login') || url.includes('/signin')
      || /[?&]referral_url=/.test(url)
      || title.includes('become an online seller')
      || title.includes('sign in');
}

// ── state ───────────────────────────────────────────────────────────────────
const getState = async () => (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || null;
const setState = async s   => chrome.storage.local.set({ [STATE_KEY]: s });

async function getFilter(mode) {
  const all = (await chrome.storage.local.get(FILTER_KEY))[FILTER_KEY] || {};
  return all[mode.id] || [];
}
async function setFilter(mode, skus) {
  const all = (await chrome.storage.local.get(FILTER_KEY))[FILTER_KEY] || {};
  all[mode.id] = skus;
  await chrome.storage.local.set({ [FILTER_KEY]: all });
}

// ── on-page panel ───────────────────────────────────────────────────────────
let panel, logBox, statLine, skuBox;

async function log(line) {
  const stamp = new Date().toLocaleTimeString('en-IN', { hour12: false });
  const entry = stamp + '  ' + line;
  console.log('[Rumee/RTD]', line);
  // After the extension is reloaded, the copy of this script already running in
  // an open tab is orphaned — every chrome.* call throws and the buttons look
  // dead. Say so instead of failing silently.
  let store;
  try {
    store = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] || [];
  } catch (e) {
    if (logBox) logBox.textContent = 'Extension was reloaded — refresh this page (F5) to use the panel.';
    return;
  }
  store.push(entry);
  while (store.length > 120) store.shift();
  await chrome.storage.local.set({ [LOG_KEY]: store });
  if (logBox) { logBox.textContent = store.slice(-80).join('\n'); logBox.scrollTop = logBox.scrollHeight; }
}

function buildPanel(mode) {
  if (panel) return;
  panel = document.createElement('div');
  panel.id = '__rumeeRtdPanel';
  panel.innerHTML = [
    '<style>',
    // Default bottom-LEFT: the action buttons live on the right of the table,
    // and the panel must never sit on top of the thing it is clicking.
    '#__rumeeRtdPanel{position:fixed;left:16px;bottom:16px;width:340px;z-index:2147483647;',
    'background:#14161a;color:#e8eaed;font:12px/1.45 system-ui,Segoe UI,Arial;border-radius:10px;',
    'box-shadow:0 8px 28px rgba(0,0,0,.45);overflow:hidden}',
    '#__rumeeRtdPanel h4{margin:0;padding:9px 12px;background:#1f6feb;font-size:13px;font-weight:600;',
    'cursor:move;display:flex;align-items:center;justify-content:space-between;user-select:none}',
    '#__rumeeRtdPanel #__rtdToggle{flex:0 0 auto;width:24px;padding:1px 0;background:rgba(0,0,0,.25);',
    'font-size:14px;line-height:1.2}',
    '#__rumeeRtdPanel .bd{padding:10px 12px}',
    '#__rumeeRtdPanel .row{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}',
    '#__rumeeRtdPanel button{flex:1;padding:7px 8px;border:0;border-radius:6px;cursor:pointer;',
    'font-size:12px;font-weight:600;color:#fff;background:#3d444d}',
    '#__rumeeRtdPanel .go{background:#1a7f37}',
    '#__rumeeRtdPanel .stop{background:#b62324}',
    '#__rumeeRtdPanel .scan{background:#8250df}',
    '#__rumeeRtdPanel input[type=number]{width:62px;background:#0d1117;color:#e8eaed;border:1px solid #30363d;',
    'border-radius:5px;padding:4px 6px}',
    '#__rumeeRtdPanel .stat{font-size:12px;margin-bottom:8px;color:#9fb0c0}',
    '#__rumeeRtdPanel pre{margin:0;height:140px;overflow:auto;background:#0d1117;border-radius:6px;',
    'padding:7px;font:11px/1.4 Consolas,monospace;white-space:pre-wrap;color:#adbac7}',
    '#__rumeeRtdPanel label{color:#9fb0c0}',
    '#__rumeeRtdPanel .skus{max-height:150px;overflow:auto;background:#0d1117;border-radius:6px;',
    'padding:6px 8px;margin-bottom:8px;display:none}',
    '#__rumeeRtdPanel .skus div{display:flex;gap:6px;align-items:center;padding:2px 0;color:#c9d1d9}',
    '#__rumeeRtdPanel .skus b{margin-left:auto;color:#7ee787;font-weight:600}',
    '#__rumeeRtdPanel .hint{color:#6e7681;font-size:11px;margin-bottom:8px}',
    '</style>',
    '<h4><span>Rumee — ' + mode.title + '</span><button id="__rtdToggle" title="Collapse">–</button></h4>',
    '<div class="bd">',
    '  <div class="stat" id="__rtdStat">Idle</div>',
    (mode.skuFilter
      ? '  <div class="row"><button class="scan" id="__rtdScan">Scan SKUs</button></div>'
        + '  <div class="skus" id="__rtdSkus"></div>'
        + '  <div class="hint" id="__rtdHint">Scan first, then tick the SKUs to accept. Nothing ticked = all of them.</div>'
      : ''),
    '  <div class="row"><label><input type="checkbox" id="__rtdDry" checked> Dry run (no clicks)</label></div>',
    '  <div class="row"><label>Stop after <input type="number" id="__rtdLimit" min="1" value="50"> orders</label></div>',
    '  <div class="row">',
    '    <button class="go" id="__rtdStart">Start</button>',
    '    <button class="stop" id="__rtdStop">Stop</button>',
    '    <button id="__rtdProbe">Probe</button>',
    '  </div>',
    '  <pre id="__rtdLog"></pre>',
    '</div>',
  ].join('');
  document.body.appendChild(panel);
  logBox   = panel.querySelector('#__rtdLog');
  statLine = panel.querySelector('#__rtdStat');
  skuBox   = panel.querySelector('#__rtdSkus');

  // ── collapse / expand ──
  const body   = panel.querySelector('.bd');
  const toggle = panel.querySelector('#__rtdToggle');
  const applyCollapsed = c => {
    body.style.display = c ? 'none' : '';
    toggle.textContent = c ? '+' : '–';
    toggle.title       = c ? 'Expand' : 'Collapse';
  };
  toggle.onclick = async e => {
    e.stopPropagation();                       // do not start a drag
    const ui = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
    ui.collapsed = body.style.display !== 'none';
    applyCollapsed(ui.collapsed);
    await chrome.storage.local.set({ [UI_KEY]: ui });
  };

  // ── drag by the blue header ──
  const head = panel.querySelector('h4');
  let drag = null;
  head.addEventListener('mousedown', e => {
    if (e.target === toggle) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    panel.style.left   = Math.max(0, Math.min(window.innerWidth  - 80, e.clientX - drag.dx)) + 'px';
    panel.style.top    = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + 'px';
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', async () => {
    if (!drag) return;
    drag = null;
    const ui = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
    ui.left = parseInt(panel.style.left, 10);
    ui.top  = parseInt(panel.style.top, 10);
    await chrome.storage.local.set({ [UI_KEY]: ui });
  });

  // Put it back where it was left last time.
  chrome.storage.local.get(UI_KEY).then(res => {
    const ui = res[UI_KEY] || {};
    if (typeof ui.left === 'number' && typeof ui.top === 'number') {
      panel.style.left = ui.left + 'px';
      panel.style.top  = ui.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    applyCollapsed(!!ui.collapsed);
  });

  // ── buttons ──
  if (mode.skuFilter) {
    panel.querySelector('#__rtdScan').onclick = () => scanSkus(mode);
  }

  panel.querySelector('#__rtdStart').onclick = async () => {
    const dryRun = panel.querySelector('#__rtdDry').checked;
    const limit  = parseInt(panel.querySelector('#__rtdLimit').value, 10) || 1;
    if (mode.skuFilter) await setFilter(mode, tickedSkus());
    const picked = mode.skuFilter ? await getFilter(mode) : [];
    await chrome.storage.local.set({ [LOG_KEY]: [] });
    await setState({
      mode: mode.id, running: true, dryRun, limit,
      done: 0, failed: 0, reloads: 0, startedAt: Date.now(),
    });
    await log('START — ' + mode.verb + ', ' + (dryRun ? 'DRY RUN' : 'LIVE') + ', limit ' + limit
      + (mode.skuFilter ? (picked.length ? ', SKUs: ' + picked.join(', ') : ', all SKUs') : ''));
    runLoop(mode);
  };

  panel.querySelector('#__rtdStop').onclick = async () => {
    const s = (await getState()) || {};
    s.running = false;
    await setState(s);
    await log('STOP requested — will halt after the current order.');
  };

  panel.querySelector('#__rtdProbe').onclick = async () => {
    const btns = actionRowButtons(mode);
    await log('PROBE (' + mode.verb + '): counter = ' + readPendingCount(mode)
      + ', row buttons found = ' + btns.length);
    for (let i = 0; i < Math.min(3, btns.length); i++) {
      await log('  [' + i + '] SKU "' + btns[i].sku + '" | ' + btns[i].ctx.text.slice(0, 70));
    }
    if (!mode.findRows) {
      const all = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(e => mode.labels.indexOf(txt(e).toLowerCase()) !== -1);
      await log('  matching elements on page = ' + all.length + ' (usable rows = ' + btns.length + ')');
    }
  };
}

function tickedSkus() {
  if (!skuBox) return [];
  return [...skuBox.querySelectorAll('input[type=checkbox]')]
    .filter(c => c.checked).map(c => c.dataset.sku);
}

async function paint(mode, extra) {
  const s = await getState();
  if (!statLine) return;
  const pending = readPendingCount(mode);
  const tail = (pending != null ? ', on this tab ' + pending : '') + (extra ? ' ' + extra : '');
  statLine.textContent = (s && s.running)
    ? 'Running — done ' + s.done + ', failed ' + s.failed + tail
    : 'Idle' + tail;
}

// ── pagination ──────────────────────────────────────────────────────────────
// The list is paged, not endlessly scrolled: 20 rows per page with real page
// buttons underneath (data-testid page-1, page-2, ..., plus next/prev).
const pageButtons = () => [...document.querySelectorAll('[data-testid^="page-"]')]
  .filter(b => /^\d+$/.test(txt(b)));

// Clicks page number `i` (0-based) and waits for its rows to render.
async function gotoPage(mode, i) {
  const btns = pageButtons();
  if (!btns[i]) return false;
  await humanClick(btns[i]);
  await sleep(rand(900, 1600));
  await waitFor(() => actionRowButtons(mode).length > 0, 15000);
  return true;
}

// ── SKU scan ────────────────────────────────────────────────────────────────
// Walks every page and tallies the SKUs, then comes back to page 1. Only the SKU
// text is kept, never element references — those die the moment a page changes.
async function scanAllPages(mode, onProgress) {
  const skus  = [];
  const total = Math.max(1, pageButtons().length);
  for (let i = 0; i < total; i++) {
    if (i > 0 && !(await gotoPage(mode, i))) break;
    await waitFor(() => actionRowButtons(mode).length > 0, 15000);
    const rows = actionRowButtons(mode);
    for (const r of rows) skus.push(r.sku);
    if (onProgress) onProgress(skus.length, i + 1, total);
  }
  if (total > 1) await gotoPage(mode, 0);      // leave the list back on page 1
  return skus;
}

async function scanSkus(mode) {
  const pages = Math.max(1, pageButtons().length);
  await log('scanning ' + pages + ' page(s) of orders…');
  const skus = await scanAllPages(mode, (n, p, t) =>
    paint(mode, '(page ' + p + '/' + t + ', ' + n + ' orders)'));
  const rows = skus.map(s => ({ sku: s }));
  const counts = new Map();
  for (const r of rows) counts.set(r.sku, (counts.get(r.sku) || 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const previously = await getFilter(mode);

  skuBox.innerHTML = '';
  for (const [sku, n] of sorted) {
    const line = document.createElement('div');
    const cb   = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.sku = sku;
    cb.checked = previously.indexOf(sku) !== -1;
    const name = document.createElement('span');
    name.textContent = sku;
    const cnt = document.createElement('b');
    cnt.textContent = n + (n === 1 ? ' order' : ' orders');
    line.appendChild(cb); line.appendChild(name); line.appendChild(cnt);
    skuBox.appendChild(line);
  }
  skuBox.style.display = sorted.length ? 'block' : 'none';
  await log('scan done — ' + rows.length + ' order(s) across ' + sorted.length + ' SKU(s):');
  for (const [sku, n] of sorted) await log('   ' + n + ' × ' + sku);
  await paint(mode);
}

// ── human-like click ────────────────────────────────────────────────────────
function fire(el, type, x, y) {
  const Ev = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
  el.dispatchEvent(new Ev(type, {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, button: 0,
    buttons: (type === 'pointerdown' || type === 'mousedown') ? 1 : 0,
  }));
}

// Proved live 2026-08-19: when the panel sits over the row being clicked, the
// click simply does not land — the Accept row would not open at all until the
// panel was hidden, and then it opened in half a second. So get out of the way
// for the duration of any click that overlaps it, then come straight back.
function movePanelAsideFor(el) {
  if (!panel || !el || !el.getBoundingClientRect) return () => {};
  const a = panel.getBoundingClientRect(), b = el.getBoundingClientRect();
  const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  if (!overlaps) return () => {};
  const was = panel.style.visibility;
  panel.style.visibility = 'hidden';
  return () => { panel.style.visibility = was; };
}

// opts.single — send exactly one click. The `el.click()` fallback below is a
// second click as far as a toggle is concerned: on the Accept accordion it
// opened the panel and immediately shut it again, so nothing could be accepted.
async function humanClick(el, opts) {
  const restorePanel = movePanelAsideFor(el);
  try {
    return await clickSequence(el, opts);
  } finally {
    restorePanel();
  }
}

async function clickSequence(el, opts) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(rand(400, 1100));                       // settle + look at the row
  const r = el.getBoundingClientRect();
  const x = r.left + r.width  * (0.28 + Math.random() * 0.44);
  const y = r.top  + r.height * (0.28 + Math.random() * 0.44);
  fire(el, 'pointerover', x, y); fire(el, 'mouseover', x, y);
  fire(el, 'mousemove', x + rand(-3, 3), y + rand(-2, 2));
  await sleep(rand(140, 480));                        // hover dwell
  // opts.native — hover like a person, then hand over to the element's own click.
  // The Accept row accordion ignores a synthetic mouse sequence completely
  // (aria-expanded never flips), but responds to a native click every time.
  if (opts && opts.native) { el.click(); return; }
  fire(el, 'pointerdown', x, y); fire(el, 'mousedown', x, y);
  await sleep(rand(55, 165));                         // press duration
  fire(el, 'pointerup', x, y); fire(el, 'mouseup', x, y);
  fire(el, 'click', x, y);
  if (!(opts && opts.single) && typeof el.click === 'function') {
    // Belt-and-braces: some Flipkart controls bind only the framework's own
    // click handler, which the synthetic sequence above can miss.
    await sleep(rand(40, 90));
    el.click();
  }
}

// Occasional idle movement so the page does not only ever see click bursts.
async function idleFidget() {
  if (Math.random() < 0.35) {
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: rand(-120, 220), bubbles: true }));
    window.scrollBy({ top: rand(-90, 160), behavior: 'smooth' });
    await sleep(rand(250, 900));
  }
  if (Math.random() < 0.25) {
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: rand(200, 1200), clientY: rand(150, 700),
    }));
    await sleep(rand(150, 600));
  }
}

// ── confirmation dialog (Flipkart may or may not show one) ──────────────────
async function confirmModalIfAny() {
  await sleep(rand(500, 1200));
  const wanted = ['yes', 'confirm', 'proceed', 'ok', 'continue',
                  'mark rtd', 'yes, mark rtd', 'accept', 'accept order', 'yes, accept'];
  const candidates = [...document.querySelectorAll('button, [role="button"]')].filter(el =>
    isVisible(el) && !isDisabled(el) && wanted.indexOf(txt(el).toLowerCase()) !== -1);
  // Only a button inside an overlay counts, and never one that belongs to a row —
  // otherwise "Accept" in the next row would be mistaken for a dialog button.
  const modalBtn = candidates.find(el =>
    el.closest('[class*="modal" i],[class*="dialog" i],[class*="popup" i],[role="dialog"]')
    && !rowContextFor(el));
  if (!modalBtn) return false;
  await log('  confirmation dialog → clicking "' + txt(modalBtn) + '"');
  await humanClick(modalBtn);
  await sleep(rand(700, 1600));
  return true;
}

// ── waiting / recovery ──────────────────────────────────────────────────────
// Waits for the order list to render. Flipkart's dashboard is slow and sometimes
// never finishes painting — in that case the page is reloaded and we wait again.
async function waitForRows(mode) {
  const deadline = Date.now() + PACE.rowWaitMs;
  while (Date.now() < deadline) {
    const s = await getState();
    if (!s || !s.running) return [];
    if (isLoggedOut()) return 'LOGGED_OUT';
    const btns = actionRowButtons(mode);
    if (btns.length) return btns;
    // The list may be inside a collapsed "Dispatch by ..." group — open it once.
    const group = [...document.querySelectorAll('div,button,span,[role="button"]')]
      .find(e => /^Dispatch by .{0,40}\(\d+\)$/i.test(txt(e)) && isVisible(e));
    if (group && !group.__rumeeOpened) { group.__rumeeOpened = true; group.click(); await sleep(1500); }
    await sleep(600);
  }
  return [];
}

async function reloadAndResume(mode, why) {
  const s = await getState();
  if (!s) return;
  s.reloads = (s.reloads || 0) + 1;
  await setState(s);
  await log('reload #' + s.reloads + ' — ' + why);
  if (s.reloads > PACE.maxReloads) {
    s.running = false; await setState(s);
    await log('STOPPED — too many reloads with nothing on screen.');
    return;
  }
  await sleep(rand(1200, 3000));
  if (!currentMode()) location.href = urlFor(mode);
  location.reload();
}

// ── main loop ───────────────────────────────────────────────────────────────
let looping = false;

async function runLoop(mode) {
  if (looping) return;
  looping = true;
  try {
    let sinceBreak  = 0;
    let breakAfter  = rand(PACE.breakEveryMin, PACE.breakEveryMax);
    let consecFails = 0;
    let pageHop     = 0;   // how far through the pages we have looked for a ticked SKU
    const filter    = mode.skuFilter ? await getFilter(mode) : [];
    const wanted    = new Set(filter);

    for (;;) {
      const s = await getState();
      if (!s || !s.running) { await log('stopped.'); break; }

      if (s.done >= s.limit) {
        s.running = false; await setState(s);
        await log('DONE — limit reached, ' + s.done + ' order(s) handled.');
        break;
      }
      if (isLoggedOut()) {
        s.running = false; await setState(s);
        await log('STOPPED — Flipkart session expired. Log in again, then press Start.');
        break;
      }
      if (!currentMode()) { await reloadAndResume(mode, 'not on the ' + mode.title + ' tab'); return; }

      const rows = await waitForRows(mode);
      if (rows === 'LOGGED_OUT') continue;
      if (!rows.length) {
        // Once the tab is empty Flipkart drops the counter chip altogether and
        // shows its "No orders ..." artwork, so a null count is not a failure —
        // check the empty-state message before treating this as a stalled page.
        if (readPendingCount(mode) === 0 || isEmptyState()) {
          s.running = false; await setState(s);
          await log('DONE — nothing left on this tab.');
          break;
        }
        await reloadAndResume(mode, 'no ' + mode.verb + ' buttons rendered'); return;
      }

      // The page is healthy again — clear the reload counter.
      if (s.reloads) { s.reloads = 0; await setState(s); }

      // Only the ticked SKUs, when a filter is set. The chosen SKUs may sit on a
      // later page, so walk the pages before concluding there is nothing left.
      const candidates = wanted.size ? rows.filter(r => wanted.has(r.sku)) : rows;
      if (!candidates.length) {
        const pages = pageButtons().length;
        pageHop += 1;
        if (pageHop < pages && await gotoPage(mode, pageHop)) {
          await log('no chosen SKUs on this page — page ' + (pageHop + 1) + ' of ' + pages);
          continue;
        }
        s.running = false; await setState(s);
        await log('DONE — no more orders for the chosen SKUs.');
        break;
      }
      pageHop = 0;   // found work here — start from this page again next time

      // Work mostly top-down, but not always the very first row.
      const pick  = candidates[Math.random() < 0.75 ? 0 : rand(0, Math.min(3, candidates.length))];
      const label = pick.sku + ' — ' + pick.ctx.text.slice(0, 60);
      await paint(mode);
      await idleFidget();

      if (s.dryRun) {
        await log('(dry) would click ' + mode.verb + ' → ' + label);
        s.done += 1; await setState(s);
        await humanPause(700, 1400);
        continue;
      }

      await log('click ' + (s.done + 1) + '/' + s.limit + ' → ' + label);
      const before = readPendingCount(mode);
      if (mode.act) {
        const acted = await mode.act(pick);
        if (!acted) {
          // Count it as a failure rather than retrying forever — an earlier
          // version looped on the same row indefinitely.
          consecFails += 1;
          const sf = await getState();
          if (sf) { sf.failed += 1; await setState(sf); }
          if (consecFails >= PACE.maxFails) {
            if (sf) { sf.running = false; await setState(sf); }
            await log('STOPPED — could not open ' + PACE.maxFails + ' rows in a row.');
            break;
          }
          await humanPause(1200, 2500);
          continue;
        }
      } else {
        await humanClick(pick.el);
      }
      await confirmModalIfAny();

      // Success = that row's button left the screen, or the tab counter dropped.
      const deadline = Date.now() + PACE.confirmWaitMs;
      let ok = false;
      while (Date.now() < deadline) {
        await sleep(500);
        if (!document.contains(pick.el) || !isVisible(pick.el)) { ok = true; break; }
        const after = readPendingCount(mode);
        if (before != null && after != null && after < before) { ok = true; break; }
      }

      const st = await getState();
      if (!st) break;

      if (ok) {
        st.done += 1; consecFails = 0;
        await setState(st);
        await log('  ' + mode.verb + ' OK (' + st.done + ' done)');
      } else {
        st.failed += 1; consecFails += 1;
        await setState(st);
        await log('  no change after click (fail ' + consecFails + '/' + PACE.maxFails + ')');
        if (consecFails >= PACE.maxFails) {
          st.running = false; await setState(st);
          await log('STOPPED — clicks are not doing anything. Press Probe and send me the log.');
          break;
        }
        await reloadAndResume(mode, 'click had no effect'); return;
      }

      sinceBreak += 1;
      await paint(mode);

      if (st.done % PACE.reloadEveryClicks === 0) {
        await reloadAndResume(mode, 'periodic refresh of the list'); return;
      }

      if (sinceBreak >= breakAfter) {
        const br = rand(PACE.breakMin, PACE.breakMax);
        await log('  pausing ' + Math.round(br / 1000) + 's');
        sinceBreak = 0; breakAfter = rand(PACE.breakEveryMin, PACE.breakEveryMax);
        await sleep(br);
      } else {
        await humanPause(PACE.betweenOrdersMin, PACE.betweenOrdersMax);
      }
    }
  } catch (err) {
    await log('ERROR: ' + ((err && err.message) ? err.message : String(err)));
    const s = await getState();
    if (s) { s.running = false; await setState(s); }
  } finally {
    looping = false;
    await paint(mode);
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
(async () => {
  // Only ever mount on the two Active Orders tabs — every other Flipkart page,
  // including the tabs the daily sync drives, is left untouched.
  const mount = async () => {
    const mode = currentMode();
    if (!mode) return;
    if (panel && panel.__rumeeMode !== mode.id) { panel.remove(); panel = null; }  // switched tab
    buildPanel(mode);
    panel.__rumeeMode = mode.id;
    const store = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] || [];
    if (logBox) logBox.textContent = store.slice(-80).join('\n');
    await paint(mode);
    const s = await getState();
    if (s && s.running && s.mode === mode.id) {
      await log('resuming after page load…');
      await sleep(rand(2000, 4500));   // let the list paint before touching it
      runLoop(mode);
    }
  };
  await mount();
  window.addEventListener('hashchange', () => setTimeout(mount, 1200));
})();

}
