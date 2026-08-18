// ─── Rumee Extension — Flipkart "Mark RTD" one-by-one clicker ────────────────
// Runs on https://seller.flipkart.com/* (document_idle), but stays completely
// inert unless the page is the Active Orders → Pending-to-Pack screen.
//
// WHY THIS EXISTS: Flipkart's bulk "Mark RTD" action is broken, so every order
// has to be marked ready-to-dispatch with an individual click. This drives those
// clicks one at a time, with randomised pacing so it behaves like a person
// working through the list rather than a burst of scripted clicks.
//
// It is NOT part of the daily sync. It never auto-starts: it only runs after the
// Start button on its own on-page panel is pressed. State lives in
// chrome.storage.local so a page reload (its own, or Flipkart's) resumes the run
// instead of losing it.
//
// Target page:
//   https://seller.flipkart.com/index.html#dashboard/active-orders?query=%7B%22activeShipmentTile%22%3A%22pendingToPack%22%7D

if (!window.__rumeeRtdInjected) {
window.__rumeeRtdInjected = true;

'use strict';

const RTD_URL = 'https://seller.flipkart.com/index.html#dashboard/active-orders?query=%7B%22activeShipmentTile%22%3A%22pendingToPack%22%7D';
const STATE_KEY = 'fkRtdBot';
const LOG_KEY   = 'fkRtdLog';
const UI_KEY    = 'fkRtdUi';   // panel position + collapsed state, so it stays put after a reload

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

// A row's Mark RTD button sits inside a container that also carries the order's
// SKU / FSN text. The toolbar's bulk Mark RTD button does not — that is how the
// two are told apart, on top of the disabled check.
function rowContextFor(el) {
  let node = el;
  for (let i = 0; i < 8 && node; i++) {
    node = node.parentElement;
    if (!node) break;
    const t = txt(node);
    if (/SKU ID|FSN|Order ID/i.test(t) && t.length > 40) {
      // The toolbar's bulk Mark RTD button has no row of its own, so walking up
      // from it eventually lands on a container holding the WHOLE table. Anything
      // covering more than one order is not a row — reject it outright (an outer
      // container can only get bigger, so there is no point walking further).
      if ((t.match(/SKU ID/gi) || []).length > 1 || t.length > 600) return null;
      return { node, text: t };
    }
  }
  return null;
}

function rtdRowButtons() {
  const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
  const out = [];
  for (const el of nodes) {
    const t = txt(el).toLowerCase();
    if (t !== 'mark rtd' && t !== 'mark as rtd' && t !== 'mark ready to dispatch') continue;
    if (!isVisible(el) || isDisabled(el)) continue;
    const ctx = rowContextFor(el);
    if (!ctx) continue;                       // toolbar / bulk button — skip
    out.push({ el, ctx });
  }
  return out;
}

// "Pending RTD  59" chip, falling back to null when it is not on screen.
function readPendingCount() {
  const nodes = [...document.querySelectorAll('div, span, li, button, a')];
  for (const el of nodes) {
    const t = txt(el);
    if (t.length > 30) continue;
    const m = t.match(/^Pending\s*RTD\s*(\d+)$/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function isLoggedOut() {
  const url = location.href, title = (document.title || '').toLowerCase();
  return url.includes('/login') || url.includes('/signin')
      || /[?&]referral_url=/.test(url)
      || title.includes('become an online seller')
      || title.includes('sign in');
}

const onTargetPage = () => /active-orders/i.test(location.hash)
                        && /pendingToPack/i.test(decodeURIComponent(location.hash));

// ── state ───────────────────────────────────────────────────────────────────
const getState = async () => (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || null;
const setState = async s   => chrome.storage.local.set({ [STATE_KEY]: s });

// ── on-page panel ───────────────────────────────────────────────────────────
let panel, logBox, statLine;

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

function buildPanel() {
  if (panel) return;
  panel = document.createElement('div');
  panel.id = '__rumeeRtdPanel';
  panel.innerHTML = [
    '<style>',
    // Default bottom-LEFT: the Mark RTD buttons live on the right of the table,
    // and the panel must never sit on top of the thing it is clicking.
    '#__rumeeRtdPanel{position:fixed;left:16px;bottom:16px;width:330px;z-index:2147483647;',
    'background:#14161a;color:#e8eaed;font:12px/1.45 system-ui,Segoe UI,Arial;border-radius:10px;',
    'box-shadow:0 8px 28px rgba(0,0,0,.45);overflow:hidden}',
    '#__rumeeRtdPanel h4{margin:0;padding:9px 12px;background:#1f6feb;font-size:13px;font-weight:600;',
    'cursor:move;display:flex;align-items:center;justify-content:space-between;user-select:none}',
    '#__rumeeRtdPanel #__rtdToggle{flex:0 0 auto;width:24px;padding:1px 0;background:rgba(0,0,0,.25);',
    'font-size:14px;line-height:1.2}',
    '#__rumeeRtdPanel .bd{padding:10px 12px}',
    '#__rumeeRtdPanel .row{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}',
    '#__rumeeRtdPanel button{flex:1;padding:7px 8px;border:0;border-radius:6px;cursor:pointer;',
    'font-size:12px;font-weight:600;color:#fff}',
    '#__rumeeRtdPanel .go{background:#1a7f37}',
    '#__rumeeRtdPanel .stop{background:#b62324}',
    '#__rumeeRtdPanel .probe{background:#3d444d}',
    '#__rumeeRtdPanel input[type=number]{width:62px;background:#0d1117;color:#e8eaed;border:1px solid #30363d;',
    'border-radius:5px;padding:4px 6px}',
    '#__rumeeRtdPanel .stat{font-size:12px;margin-bottom:8px;color:#9fb0c0}',
    '#__rumeeRtdPanel pre{margin:0;height:150px;overflow:auto;background:#0d1117;border-radius:6px;',
    'padding:7px;font:11px/1.4 Consolas,monospace;white-space:pre-wrap;color:#adbac7}',
    '#__rumeeRtdPanel label{color:#9fb0c0}',
    '</style>',
    '<h4><span>Rumee — Mark RTD helper</span><button id="__rtdToggle" title="Collapse">–</button></h4>',
    '<div class="bd">',
    '  <div class="stat" id="__rtdStat">Idle</div>',
    '  <div class="row"><label><input type="checkbox" id="__rtdDry" checked> Dry run (no clicks)</label></div>',
    '  <div class="row"><label>Stop after <input type="number" id="__rtdLimit" min="1" value="50"> orders</label></div>',
    '  <div class="row">',
    '    <button class="go" id="__rtdStart">Start</button>',
    '    <button class="stop" id="__rtdStop">Stop</button>',
    '    <button class="probe" id="__rtdProbe">Probe</button>',
    '  </div>',
    '  <pre id="__rtdLog"></pre>',
    '</div>',
  ].join('');
  document.body.appendChild(panel);
  logBox   = panel.querySelector('#__rtdLog');
  statLine = panel.querySelector('#__rtdStat');

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
    const left = Math.max(0, Math.min(window.innerWidth  - 80, e.clientX - drag.dx));
    const top  = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
    panel.style.left = left + 'px';
    panel.style.top  = top + 'px';
    panel.style.right = 'auto';
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

  panel.querySelector('#__rtdStart').onclick = async () => {
    const dryRun = panel.querySelector('#__rtdDry').checked;
    const limit  = parseInt(panel.querySelector('#__rtdLimit').value, 10) || 1;
    await chrome.storage.local.set({ [LOG_KEY]: [] });
    await setState({ running: true, dryRun, limit, done: 0, failed: 0, reloads: 0, startedAt: Date.now() });
    await log('START — ' + (dryRun ? 'DRY RUN' : 'LIVE') + ', limit ' + limit);
    runLoop();
  };

  panel.querySelector('#__rtdStop').onclick = async () => {
    const s = (await getState()) || {};
    s.running = false;
    await setState(s);
    await log('STOP requested — will halt after the current order.');
  };

  panel.querySelector('#__rtdProbe').onclick = async () => {
    const btns = rtdRowButtons();
    await log('PROBE: pending chip = ' + readPendingCount() + ', row buttons found = ' + btns.length);
    for (let i = 0; i < Math.min(3, btns.length); i++) {
      await log('  [' + i + '] "' + txt(btns[i].el) + '" | row: ' + btns[i].ctx.text.slice(0, 90));
    }
    const all = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(e => /mark\s*rtd/i.test(txt(e)));
    await log('  all "Mark RTD"-ish elements on page = ' + all.length + ' (usable rows = ' + btns.length + ')');
  };
}

async function paint(extra) {
  const s = await getState();
  if (!statLine) return;
  const pending = readPendingCount();
  const tail = (pending != null ? ', pending ' + pending : '') + (extra ? ' ' + extra : '');
  statLine.textContent = (s && s.running)
    ? 'Running — done ' + s.done + ', failed ' + s.failed + tail
    : 'Idle' + tail;
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

async function humanClick(el) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(rand(400, 1100));                       // settle + look at the row
  const r = el.getBoundingClientRect();
  const x = r.left + r.width  * (0.28 + Math.random() * 0.44);
  const y = r.top  + r.height * (0.28 + Math.random() * 0.44);
  fire(el, 'pointerover', x, y); fire(el, 'mouseover', x, y);
  fire(el, 'mousemove', x + rand(-3, 3), y + rand(-2, 2));
  await sleep(rand(140, 480));                        // hover dwell
  fire(el, 'pointerdown', x, y); fire(el, 'mousedown', x, y);
  await sleep(rand(55, 165));                         // press duration
  fire(el, 'pointerup', x, y); fire(el, 'mouseup', x, y);
  fire(el, 'click', x, y);
  if (typeof el.click === 'function') {
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

// ── confirmation modal (Flipkart may or may not show one) ───────────────────
async function confirmModalIfAny() {
  await sleep(rand(500, 1200));
  const wanted = ['yes', 'confirm', 'proceed', 'ok', 'mark rtd', 'yes, mark rtd', 'continue'];
  const candidates = [...document.querySelectorAll('button, [role="button"]')].filter(el =>
    isVisible(el) && !isDisabled(el) && wanted.indexOf(txt(el).toLowerCase()) !== -1);
  // Only treat it as a modal if the button sits inside an overlay-ish container.
  const modalBtn = candidates.find(el =>
    el.closest('[class*="modal" i],[class*="dialog" i],[class*="popup" i],[role="dialog"]'));
  if (!modalBtn) return false;
  await log('  confirmation dialog → clicking "' + txt(modalBtn) + '"');
  await humanClick(modalBtn);
  await sleep(rand(700, 1600));
  return true;
}

// ── waiting / recovery ──────────────────────────────────────────────────────
// Waits for the order list to render. Flipkart's dashboard is slow and sometimes
// never finishes painting — in that case the page is reloaded and we wait again.
async function waitForRows() {
  const deadline = Date.now() + PACE.rowWaitMs;
  while (Date.now() < deadline) {
    const s = await getState();
    if (!s || !s.running) return [];
    if (isLoggedOut()) return 'LOGGED_OUT';
    const btns = rtdRowButtons();
    if (btns.length) return btns;
    // The list may be inside a collapsed "Dispatch by ..." group — open it once.
    const group = [...document.querySelectorAll('div,button,span,[role="button"]')]
      .find(e => /^Dispatch by .{0,40}\(\d+\)$/i.test(txt(e)) && isVisible(e));
    if (group && !group.__rumeeOpened) { group.__rumeeOpened = true; group.click(); await sleep(1500); }
    await sleep(600);
  }
  return [];
}

async function reloadAndResume(why) {
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
  if (!onTargetPage()) location.href = RTD_URL;
  location.reload();
}

// ── main loop ───────────────────────────────────────────────────────────────
let looping = false;

async function runLoop() {
  if (looping) return;
  looping = true;
  try {
    let sinceBreak  = 0;
    let breakAfter  = rand(PACE.breakEveryMin, PACE.breakEveryMax);
    let consecFails = 0;

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
      if (!onTargetPage()) { await reloadAndResume('not on the pending-to-pack page'); return; }

      const rows = await waitForRows();
      if (rows === 'LOGGED_OUT') continue;
      if (!rows.length) {
        const pending = readPendingCount();
        if (pending === 0) {
          s.running = false; await setState(s);
          await log('DONE — nothing left pending.');
          break;
        }
        await reloadAndResume('no Mark RTD buttons rendered'); return;
      }

      // The page is healthy again — clear the reload counter.
      if (s.reloads) { s.reloads = 0; await setState(s); }

      // Work mostly top-down, but not always the very first row.
      const pick  = rows[Math.random() < 0.75 ? 0 : rand(0, Math.min(3, rows.length))];
      const label = pick.ctx.text.slice(0, 80);
      await paint();
      await idleFidget();

      if (s.dryRun) {
        await log('(dry) would click Mark RTD → ' + label);
        s.done += 1; await setState(s);
        await humanPause(700, 1400);
        continue;
      }

      await log('click ' + (s.done + 1) + '/' + s.limit + ' → ' + label);
      const before = readPendingCount();
      await humanClick(pick.el);
      await confirmModalIfAny();

      // Success = that row's button left the screen, or the pending count dropped.
      const deadline = Date.now() + PACE.confirmWaitMs;
      let ok = false;
      while (Date.now() < deadline) {
        await sleep(500);
        if (!document.contains(pick.el) || !isVisible(pick.el)) { ok = true; break; }
        const after = readPendingCount();
        if (before != null && after != null && after < before) { ok = true; break; }
      }

      const st = await getState();
      if (!st) break;

      if (ok) {
        st.done += 1; consecFails = 0;
        await setState(st);
        await log('  marked OK (' + st.done + ' done)');
      } else {
        st.failed += 1; consecFails += 1;
        await setState(st);
        await log('  no change after click (fail ' + consecFails + '/' + PACE.maxFails + ')');
        if (consecFails >= PACE.maxFails) {
          st.running = false; await setState(st);
          await log('STOPPED — clicks are not doing anything. Press Probe and send me the log.');
          break;
        }
        await reloadAndResume('click had no effect'); return;
      }

      sinceBreak += 1;
      await paint();

      if (st.done % PACE.reloadEveryClicks === 0) {
        await reloadAndResume('periodic refresh of the list'); return;
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
    await paint();
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
(async () => {
  // Only ever mount on the Active Orders screen — every other Flipkart page,
  // including the tabs the daily sync drives, is left untouched.
  const mount = async () => {
    if (!onTargetPage()) return;
    buildPanel();
    const store = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] || [];
    if (logBox) logBox.textContent = store.slice(-80).join('\n');
    await paint();
    const s = await getState();
    if (s && s.running) {
      await log('resuming after page load…');
      await sleep(rand(2000, 4500));   // let the list paint before touching it
      runLoop();
    }
  };
  await mount();
  window.addEventListener('hashchange', () => setTimeout(mount, 1200));
})();

}
