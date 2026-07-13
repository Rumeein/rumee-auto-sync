// report-confirm-fallback.test.js — Node-only simulation tests for
// report-confirm-fallback.js. Run with: node report-confirm-fallback.test.js
// No browser, no chrome.* mocks, no real Flipkart tab involved — the module
// under test is pure logic, so every scenario (including today's real
// throttling-caused false-negative) is simulated instantly.

const { decideReportSubmissionOutcome } = require('./report-confirm-fallback.js');

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

// ── A: normal fast path — banner caught immediately, exactly today's happy path ──
check('A: banner confirmed -> confirmed/success_banner',
  decideReportSubmissionOutcome({ bannerConfirmed: true, duplicateBannerSeen: false, rowScanResult: null }),
  { outcome: 'confirmed', reason: 'success_banner' });

// ── B: genuine duplicate — FK's "already requested" toast caught in time ──
check('B: duplicate banner seen -> duplicate_blocked/duplicate_banner',
  decideReportSubmissionOutcome({ bannerConfirmed: false, duplicateBannerSeen: true, rowScanResult: null }),
  { outcome: 'duplicate_blocked', reason: 'duplicate_banner' });

// ── C: TODAY'S REAL BUG — banner missed (throttled), but the row already shows Generated ──
check('C: banner missed, row-scan ready -> confirmed/row_scan_fallback',
  decideReportSubmissionOutcome({ bannerConfirmed: false, duplicateBannerSeen: false, rowScanResult: { status: 'ready' } }),
  { outcome: 'confirmed', reason: 'row_scan_fallback' });

// ── D: banner missed, report submitted but still generating ──
check('D: banner missed, row-scan in_progress -> confirmed/row_scan_fallback',
  decideReportSubmissionOutcome({ bannerConfirmed: false, duplicateBannerSeen: false, rowScanResult: { status: 'in_progress' } }),
  { outcome: 'confirmed', reason: 'row_scan_fallback' });

// ── E: genuine failure — nothing was ever submitted (real site error) ──
check('E: banner missed, row-scan not_found -> failed/row_scan_not_found',
  decideReportSubmissionOutcome({ bannerConfirmed: false, duplicateBannerSeen: false, rowScanResult: { status: 'not_found' } }),
  { outcome: 'failed', reason: 'row_scan_not_found' });

// ── F: fail-safe — the row-scan itself produced nothing (e.g. threw, page navigation failed) ──
check('F: banner missed, rowScanResult null -> failed/row_scan_not_found (fail-safe)',
  decideReportSubmissionOutcome({ bannerConfirmed: false, duplicateBannerSeen: false, rowScanResult: null }),
  { outcome: 'failed', reason: 'row_scan_not_found' });

check('F2: banner missed, rowScanResult undefined -> failed/row_scan_not_found (fail-safe)',
  decideReportSubmissionOutcome({ bannerConfirmed: false, duplicateBannerSeen: false }),
  { outcome: 'failed', reason: 'row_scan_not_found' });

// ── G: unexpected/garbage status -> never silently confirm on an unknown state ──
check('G: banner missed, unknown row status -> failed/row_scan_not_found (fail-safe)',
  decideReportSubmissionOutcome({ bannerConfirmed: false, duplicateBannerSeen: false, rowScanResult: { status: 'something_new_flipkart_added' } }),
  { outcome: 'failed', reason: 'row_scan_not_found' });

// ── H: priority — success banner wins even if duplicate flag somehow also true (shouldn't happen in real code, defensive) ──
check('H: both banner flags true -> success_banner takes priority',
  decideReportSubmissionOutcome({ bannerConfirmed: true, duplicateBannerSeen: true, rowScanResult: { status: 'not_found' } }),
  { outcome: 'confirmed', reason: 'success_banner' });

// ── I: priority — duplicate banner wins over any rowScanResult content, never even consults it ──
check('I: duplicate banner true with a "ready" rowScanResult -> still duplicate_blocked',
  decideReportSubmissionOutcome({ bannerConfirmed: false, duplicateBannerSeen: true, rowScanResult: { status: 'ready' } }),
  { outcome: 'duplicate_blocked', reason: 'duplicate_banner' });

// ── J: priority — success banner wins over a rowScanResult too ──
check('J: banner confirmed true with a "not_found" rowScanResult -> still confirmed/success_banner',
  decideReportSubmissionOutcome({ bannerConfirmed: true, duplicateBannerSeen: false, rowScanResult: { status: 'not_found' } }),
  { outcome: 'confirmed', reason: 'success_banner' });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
