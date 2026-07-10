// ist-time.js — All date/time in this extension must go through these helpers.
// India Standard Time is a fixed UTC+5:30 offset with no DST, so a plain
// millisecond shift is exact and permanent — no timezone database or Intl
// dependency needed. This must NOT depend on the host machine's OS timezone.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const IST_MONTHS_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _istPad(n) { return String(n).padStart(2, '0'); }

// Current IST calendar date as 'YYYY-MM-DD'.
function istToday() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Add (or subtract, with negative n) whole days to an IST calendar date string.
// Pure calendar-day arithmetic, anchored to UTC internally — never touches a
// wall-clock/timezone boundary, so it's safe regardless of offset direction.
function istAddDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function istYesterday() {
  return istAddDays(istToday(), -1);
}

function istDaysAgo(n) {
  return istAddDays(istToday(), -n);
}

// Full IST wall-clock timestamp for logs/UI: 'DD Mon YYYY HH:MM:SS IST'.
function istDisplayString(when) {
  const ms = typeof when === 'number' ? when : new Date(when).getTime();
  const s  = new Date(ms + IST_OFFSET_MS);
  return `${_istPad(s.getUTCDate())} ${IST_MONTHS_ABR[s.getUTCMonth()]} ${s.getUTCFullYear()} ` +
         `${_istPad(s.getUTCHours())}:${_istPad(s.getUTCMinutes())}:${_istPad(s.getUTCSeconds())} IST`;
}

// Compact 'HH:MM:SS IST' for inline activity logs.
function istTimeOnly(when) {
  const ms = typeof when === 'number' ? when : new Date(when).getTime();
  const s  = new Date(ms + IST_OFFSET_MS);
  return `${_istPad(s.getUTCHours())}:${_istPad(s.getUTCMinutes())}:${_istPad(s.getUTCSeconds())} IST`;
}
