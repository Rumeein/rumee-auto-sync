// report-confirm-fallback.js — decides whether an FK report SUBMIT actually
// succeeded when the transient success/duplicate toast check times out.
//
// Root cause (rumee-auto-sync memory item 22, 2026-07-13): requestNewFkReport()
// polls document.body.innerText for up to 30x500ms looking for Flipkart's
// "requested successfully" toast. Chrome throttles JS timers in a tab that
// isn't focused, so those checks can end up running minutes late — by which
// time the toast (which auto-dismisses after a few seconds) is long gone from
// the DOM. The request itself usually DID succeed; only our detection missed it.
//
// Fix: when neither the success toast nor the "already requested" toast was
// seen, fall back to the SAME durable row-scan (findReportRowDownloadBtn) the
// code already uses elsewhere to check "was this already requested" — a row
// in the Reports Centre table doesn't vanish after a few seconds the way a
// toast does, so it isn't vulnerable to the same throttling race.
//
// Pure logic only — no chrome.* calls, no DOM. Takes the already-computed
// banner outcome + row-scan result and returns a decision, so every scenario
// can be simulated instantly instead of needing a live throttled Flipkart tab.

/**
 * @param {Object} params
 * @param {boolean} params.bannerConfirmed - success toast text was seen during the poll
 * @param {boolean} params.duplicateBannerSeen - "already requested" toast text was seen during the poll
 * @param {{status:'ready'|'in_progress'|'not_found'}|null} [params.rowScanResult] - result of
 *        findReportRowDownloadBtn(), only read when neither banner was seen
 * @returns {{outcome:'confirmed'|'duplicate_blocked'|'failed', reason:string}}
 *        outcome:
 *          'confirmed'         — treat exactly like today's existing success path
 *          'duplicate_blocked' — treat exactly like today's existing duplicate-request path
 *          'failed'            — treat exactly like today's existing "banner never appeared" failure
 */
function decideReportSubmissionOutcome({ bannerConfirmed, duplicateBannerSeen, rowScanResult }) {
  if (bannerConfirmed) {
    return { outcome: 'confirmed', reason: 'success_banner' };
  }
  if (duplicateBannerSeen) {
    return { outcome: 'duplicate_blocked', reason: 'duplicate_banner' };
  }
  // Neither toast was seen in time — fall back to the durable row list instead
  // of assuming failure.
  const status = rowScanResult && rowScanResult.status;
  if (status === 'ready' || status === 'in_progress') {
    return { outcome: 'confirmed', reason: 'row_scan_fallback' };
  }
  return { outcome: 'failed', reason: 'row_scan_not_found' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decideReportSubmissionOutcome };
}
