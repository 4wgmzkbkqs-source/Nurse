// Date/time helpers. Calendar dates are 'YYYY-MM-DD' strings and times are
// 'HH:MM' wall-clock strings in a facility's IANA timezone. Arithmetic on
// dates is done in UTC so it is never affected by daylight saving changes.

const DAY_MS = 86400000;

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

export function dateToUTCms(s) {
  const { y, m, d } = parseDate(s);
  return Date.UTC(y, m - 1, d);
}

export function msToDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(s, n) {
  return msToDate(dateToUTCms(s) + n * DAY_MS);
}

export function diffDays(a, b) {
  return Math.round((dateToUTCms(a) - dateToUTCms(b)) / DAY_MS);
}

// 0 = Sunday … 6 = Saturday
export function weekday(s) {
  return new Date(dateToUTCms(s)).getUTCDay();
}

export function startOfWeek(s, weekStartsOn = 0) {
  const wd = weekday(s);
  return addDays(s, -((wd - weekStartsOn + 7) % 7));
}

export function startOfMonth(s) {
  return s.slice(0, 8) + '01';
}

export function addMonths(s, n) {
  const { y, m } = parseDate(s);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return msToDate(d.getTime());
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return msToDate(dateToUTCms(s)) === s;
}

export function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const dtfCache = new Map();
function partsFormatter(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

// Offset (ms) of `tz` from UTC at the instant `ms`.
export function tzOffsetMs(ms, tz) {
  const p = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(ms))) p[type] = value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

// Convert a wall-clock date + time in `tz` to a UTC instant (ms).
// Times that do not exist (spring-forward gap) resolve to the equivalent
// later time (02:30 -> 03:30); ambiguous times (fall-back) resolve to the
// first occurrence.
export function zonedToUtc(date, time, tz) {
  const { y, m, d } = parseDate(date);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = tzOffsetMs(wall - 12 * 3600000, tz);
  const o2 = tzOffsetMs(wall + 12 * 3600000, tz);
  // Try the earlier offset first so ambiguous times pick the first instant.
  const candidates = o1 === o2 ? [o1] : [o1, o2];
  for (const o of candidates) {
    const t = wall - o;
    if (tzOffsetMs(t, tz) === o) return t;
  }
  // Nonexistent wall time: interpret using the offset in effect before the gap.
  return wall - o1;
}

// UTC instant -> { date, time } wall clock in tz.
export function utcToZoned(ms, tz) {
  const local = ms + tzOffsetMs(ms, tz);
  const iso = new Date(local).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export function todayIn(tz) {
  return utcToZoned(Date.now(), tz).date;
}

// --- Formatting -----------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatTime(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

export function formatTimeShort(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'a' : 'p';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
}

export function formatDateLong(s, withYear = true) {
  const { y, m, d } = parseDate(s);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

export function formatDateShort(s) {
  const { m, d } = parseDate(s);
  return `${WEEKDAYS_SHORT[weekday(s)]} ${MONTHS[m - 1].slice(0, 3)} ${d}`;
}

export function monthTitle(s) {
  const { y, m } = parseDate(s);
  return `${MONTHS[m - 1]} ${y}`;
}

export function joinList(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
