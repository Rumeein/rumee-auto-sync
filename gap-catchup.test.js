// gap-catchup.test.js — Node-only simulation tests for gap-catchup.js.
// Run with: node gap-catchup.test.js
// No browser, no chrome.* mocks, no real Flipkart/Meesho involved — the module
// under test is pure logic, so every failure scenario is simulated instantly
// instead of waiting real days for a live report to actually get stuck.

const { GAP_CATCHUP_MAX_DAYS, gcGetAllPending, gcGetOldestPending, gcRecordOutcome, gcMarkPlaced } = require('./gap-catchup.js');

// Plain calendar-day arithmetic for test dates only — not the real ist-time.js
// (deliberately not touching that file just to add a Node require shim to
// already-live-verified working code, see how-i-work Rule 5).
function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) {
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
  }
  ok ? pass++ : fail++;
}

// ── Scenario A: normal day, every attempt succeeds ──────────────────────────
// Must behave exactly like today's current code: nothing ever gets tracked.
(() => {
  let state = {};
  let r = gcRecordOutcome(state, 'fk_payments', '2026-07-01', '2026-07-02', true);
  state = r.pendingItems;
  check('A: success leaves no pending item', gcGetAllPending(state, 'fk_payments'), []);
  check('A: success never escalates', r.escalated, null);
})();

// ── Scenario B: placement fails today, retried next day alongside new order ─
(() => {
  let state = {};
  // Jul10 run: placing order for Jul9 fails.
  let r = gcRecordOutcome(state, 'fk_payments', '2026-07-09', '2026-07-10', false);
  state = r.pendingItems;
  check('B: failed placement is tracked', gcGetOldestPending(state, 'fk_payments'),
    { date: '2026-07-09', daysPending: 1, firstSeen: '2026-07-10', lastAttemptDate: '2026-07-10', placed: false });

  // Jul11 run: retry Jul9 (succeeds) AND place new order for Jul10 (succeeds).
  r = gcRecordOutcome(state, 'fk_payments', '2026-07-09', '2026-07-11', true);
  state = r.pendingItems;
  r = gcRecordOutcome(state, 'fk_payments', '2026-07-10', '2026-07-11', true);
  state = r.pendingItems;
  check('B: both cleared after both succeed', gcGetAllPending(state, 'fk_payments'), []);
})();

// ── Scenario C: placed, not ready for 2 days, ready on day 3 ────────────────
(() => {
  let state = {};
  let r = gcRecordOutcome(state, 'fk_orders', '2026-07-09', '2026-07-10', false); // day 1: not ready
  state = r.pendingItems;
  r = gcRecordOutcome(state, 'fk_orders', '2026-07-09', '2026-07-11', false);      // day 2: still not ready
  state = r.pendingItems;
  check('C: daysPending=2 after 2 failed days', gcGetOldestPending(state, 'fk_orders').daysPending, 2);
  check('C: not escalated yet (cap is 3)', r.escalated, null);

  r = gcRecordOutcome(state, 'fk_orders', '2026-07-09', '2026-07-12', true);       // day 3: ready, downloaded
  state = r.pendingItems;
  check('C: cleared once ready', gcGetAllPending(state, 'fk_orders'), []);
  check('C: no escalation on eventual success', r.escalated, null);
})();

// ── Scenario D: never ready after MAX_DAYS -> escalate to manual ────────────
(() => {
  let state = {};
  let today = '2026-07-10';
  let escalated = null;
  for (let i = 0; i < GAP_CATCHUP_MAX_DAYS + 1; i++) {
    const r = gcRecordOutcome(state, 'fk_returns', '2026-07-09', today, false);
    state = r.pendingItems;
    if (r.escalated) escalated = r.escalated;
    today = addDays(today, 1);
  }
  check('D: escalated after exceeding cap', escalated, { jobId: 'fk_returns', date: '2026-07-09', daysPending: GAP_CATCHUP_MAX_DAYS + 1 });
  check('D: removed from pending once escalated', gcGetAllPending(state, 'fk_returns'), []);
})();

// ── Scenario E: single-shot job fails today, retried same date next run ─────
// Mechanically identical call shape to the two-phase case — same function.
(() => {
  let state = {};
  let r = gcRecordOutcome(state, 'me_orders', '2026-07-09', '2026-07-10', false);
  state = r.pendingItems;
  check('E: failed single-shot download is tracked', gcGetOldestPending(state, 'me_orders').date, '2026-07-09');

  r = gcRecordOutcome(state, 'me_orders', '2026-07-09', '2026-07-11', true); // retry succeeds
  state = r.pendingItems;
  check('E: cleared once retry succeeds', gcGetAllPending(state, 'me_orders'), []);
})();

// ── Scenario F: single-shot fails MAX_DAYS days straight -> escalate ────────
(() => {
  let state = {};
  let today = '2026-07-10';
  let escalated = null;
  for (let i = 0; i < GAP_CATCHUP_MAX_DAYS + 1; i++) {
    const r = gcRecordOutcome(state, 'me_payments', '2026-07-09', today, false);
    state = r.pendingItems;
    if (r.escalated) escalated = r.escalated;
    today = addDays(today, 1);
  }
  check('F: single-shot escalates after cap', escalated && escalated.jobId, 'me_payments');
})();

// ── Scenario G: two different dates stuck at once for the same job ──────────
(() => {
  let state = {};
  let r = gcRecordOutcome(state, 'fk_payments', '2026-07-09', '2026-07-10', false); // Jul9 fails
  state = r.pendingItems;
  r = gcRecordOutcome(state, 'fk_payments', '2026-07-10', '2026-07-11', false);      // Jul10 also fails next day
  state = r.pendingItems;
  check('G: both dates tracked independently', gcGetAllPending(state, 'fk_payments').map(x => x.date), ['2026-07-09', '2026-07-10']);
  check('G: oldest returned first', gcGetOldestPending(state, 'fk_payments').date, '2026-07-09');

  r = gcRecordOutcome(state, 'fk_payments', '2026-07-09', '2026-07-12', true); // Jul9 resolves
  state = r.pendingItems;
  check('G: resolving one leaves the other tracked', gcGetAllPending(state, 'fk_payments').map(x => x.date), ['2026-07-10']);
})();

// ── Scenario H: idempotency — same job attempted twice in one day (e.g. RUN_NOW
// manually re-triggered) must not double-count the day ──────────────────────
(() => {
  let state = {};
  let r = gcRecordOutcome(state, 'fk_orders', '2026-07-09', '2026-07-10', false);
  state = r.pendingItems;
  r = gcRecordOutcome(state, 'fk_orders', '2026-07-09', '2026-07-10', false); // same day, attempted again
  state = r.pendingItems;
  check('H: same-day repeat attempt does not double-count', gcGetOldestPending(state, 'fk_orders').daysPending, 1);
})();

// ── Scenario I: placed-flag distinguishes "submitted, just waiting" from
// "never successfully submitted" — this is what stops fk_payments from
// re-submitting a duplicate order Flipkart would reject ──────────────────────
(() => {
  let state = {};
  let r = gcRecordOutcome(state, 'fk_payments', '2026-07-09', '2026-07-10', false); // placement failed
  state = r.pendingItems;
  check('I: new pending item starts unplaced', gcGetOldestPending(state, 'fk_payments').placed, false);

  // Jul11: retry succeeds in SUBMITTING the order (but it's not ready yet — separate outcome).
  state = gcMarkPlaced(state, 'fk_payments', '2026-07-09');
  check('I: marked placed after successful submit', gcGetOldestPending(state, 'fk_payments').placed, true);

  // Later run: not ready yet — still tracked, still placed=true, day count still bumps.
  r = gcRecordOutcome(state, 'fk_payments', '2026-07-09', '2026-07-12', false);
  state = r.pendingItems;
  check('I: placed flag survives a not-ready outcome', gcGetOldestPending(state, 'fk_payments').placed, true);
  check('I: day count still bumps while awaiting ready', gcGetOldestPending(state, 'fk_payments').daysPending, 2);
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
