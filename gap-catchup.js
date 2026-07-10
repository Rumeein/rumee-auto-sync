// gap-catchup.js — tracks jobs that started but didn't finish (order placed but
// never ready, or a single-shot download that failed) so the NEXT run can retry
// that specific stuck date before doing today's normal job, instead of silently
// losing it. Escalates to manual after GAP_CATCHUP_MAX_DAYS.
//
// IMPORTANT — every "date" in this file is a DATA date, never a run date.
// Jobs always fetch "yesterday's" data, so a failure on the run that happens
// on day X always means day X-1's data is what's actually missing/owed —
// NOT day X. Example: the run on 2026-07-09 tries to fetch 2026-07-08's data
// and fails → 2026-07-08 (not 07-09) is what gets tracked here as owed. The
// NEXT run (2026-07-10) retries 07-08 first, then does its own normal
// yesterday (07-09) on top. Every date stored/returned by this module already
// IS the data date — callers never need to shift it by a day in either direction.
//
// Pure logic only — no chrome.* calls, no DOM. This is what makes it testable
// with instant simulated scenarios instead of waiting real days for a live
// Flipkart/Meesho failure. See test-gap-catchup.js.
//
// State shape: pendingItems = { [jobId]: [ { date, daysPending, firstSeen, lastAttemptDate, placed }, ... ] }
// Each job can have more than one date stuck at once (e.g. two consecutive
// days both fail) — oldest is always list[0] since entries are only ever
// pushed to the end and removed when resolved/escalated, never reordered.
//
// `placed` is only meaningful for two-phase jobs (fk_orders/fk_payments/fk_returns):
// false = the order was never successfully submitted yet, safe to retry submitting it.
// true  = the order WAS submitted successfully, just not ready yet — retrying the
//         submission itself would get rejected by Flipkart as a duplicate. Single-shot
//         jobs (no submit/wait split) can ignore this field entirely.

const GAP_CATCHUP_MAX_DAYS = 3;

// All currently-stuck dates for a job, oldest first. Empty array if none.
function gcGetAllPending(pendingItems, jobId) {
  return pendingItems[jobId] || [];
}

// The single oldest stuck date for a job (the one to retry first), or null.
function gcGetOldestPending(pendingItems, jobId) {
  return gcGetAllPending(pendingItems, jobId)[0] || null;
}

// Record the outcome of an attempt at `targetDate` for `jobId` on `today`.
//   resolved=true  -> attempt succeeded, clear it from tracking.
//   resolved=false -> attempt failed. If this date was already being tracked,
//                     bump its day-count (once per calendar day, not per
//                     attempt within the same day). If a fresh date, start
//                     tracking it. Once daysPending exceeds the cap, remove
//                     it from tracking and report it as escalated.
// Returns { pendingItems: <new state>, escalated: null | { jobId, date, daysPending } }
function gcRecordOutcome(pendingItems, jobId, targetDate, today, resolved) {
  const next = { ...pendingItems };
  const list = [...(next[jobId] || [])];
  const idx = list.findIndex(item => item.date === targetDate);

  if (resolved) {
    if (idx !== -1) list.splice(idx, 1);
    if (list.length) next[jobId] = list; else delete next[jobId];
    return { pendingItems: next, escalated: null };
  }

  let escalated = null;

  if (idx !== -1) {
    const existing = list[idx];
    if (existing.lastAttemptDate !== today) {
      const updated = { ...existing, daysPending: existing.daysPending + 1, lastAttemptDate: today };
      if (updated.daysPending > GAP_CATCHUP_MAX_DAYS) {
        escalated = { jobId, date: updated.date, daysPending: updated.daysPending };
        list.splice(idx, 1);
      } else {
        list[idx] = updated;
      }
    }
    // Same day, already attempted once — leave as-is, don't double-count.
  } else {
    list.push({ date: targetDate, daysPending: 1, firstSeen: today, lastAttemptDate: today, placed: false });
  }

  if (list.length) next[jobId] = list; else delete next[jobId];
  return { pendingItems: next, escalated };
}

// Mark a tracked date as "successfully submitted" (two-phase jobs only) so a
// later run knows not to submit it again — just check if it's ready yet.
// No-op if that date isn't currently tracked.
function gcMarkPlaced(pendingItems, jobId, date) {
  const next = { ...pendingItems };
  const list = [...(next[jobId] || [])];
  const idx = list.findIndex(item => item.date === date);
  if (idx !== -1) {
    list[idx] = { ...list[idx], placed: true };
    next[jobId] = list;
  }
  return next;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GAP_CATCHUP_MAX_DAYS, gcGetAllPending, gcGetOldestPending, gcRecordOutcome, gcMarkPlaced };
}
