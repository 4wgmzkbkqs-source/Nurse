// Weekly recurrence rules.
//
// rule = {
//   start_date: 'YYYY-MM-DD',        // first possible occurrence (series anchor)
//   interval_weeks: 1 | 2 | n,       // 1 = weekly, 2 = every other week
//   weekdays: [0..6],                // 0 = Sunday
//   end_type: 'never' | 'until' | 'count',
//   until_date: 'YYYY-MM-DD' | null, // inclusive
//   count: number | null,            // total occurrences generated
// }
//
// Weeks are counted from the Sunday-starting week that contains start_date,
// so "every other week" alternates relative to the series start.

import {
  addDays, diffDays, startOfWeek, weekday, isValidDate,
  WEEKDAYS, formatTime, formatDateLong, joinList, parseDate,
} from './time.js';

export function validateRule(rule) {
  const errors = [];
  if (!isValidDate(rule.start_date)) errors.push('Recurrence start date is invalid.');
  const n = Number(rule.interval_weeks);
  if (!Number.isInteger(n) || n < 1 || n > 52) errors.push('Repeat interval must be between 1 and 52 weeks.');
  if (!Array.isArray(rule.weekdays) || rule.weekdays.length === 0) errors.push('Select at least one weekday.');
  else if (rule.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Invalid weekday.');
  if (!['never', 'until', 'count'].includes(rule.end_type)) errors.push('Invalid end option.');
  if (rule.end_type === 'until') {
    if (!isValidDate(rule.until_date)) errors.push('End date is invalid.');
    else if (rule.until_date < rule.start_date) errors.push('End date must be on or after the start date.');
  }
  if (rule.end_type === 'count') {
    const c = Number(rule.count);
    if (!Number.isInteger(c) || c < 1 || c > 1000) errors.push('Number of occurrences must be between 1 and 1000.');
  }
  return errors;
}

function sortedDays(rule) {
  return [...new Set(rule.weekdays)].sort((a, b) => a - b);
}

// Generate occurrence dates within [from, to] (inclusive), honouring the
// rule's end condition. Never generates unbounded output: iteration stops at
// `to` (or the rule's end, whichever is first).
export function occurrenceDates(rule, from, to) {
  const out = [];
  const days = sortedDays(rule);
  if (!days.length) return out;
  const interval = Math.max(1, Number(rule.interval_weeks) || 1);
  const anchorWeek = startOfWeek(rule.start_date);
  let last = to;
  if (rule.end_type === 'until' && rule.until_date < last) last = rule.until_date;
  if (last < rule.start_date) return out;

  const counted = rule.end_type === 'count';
  const maxCount = counted ? Number(rule.count) : Infinity;

  // Without a count limit we can jump straight to the first relevant week.
  let week = 0;
  if (!counted && from > rule.start_date) {
    const w = Math.floor(diffDays(startOfWeek(from), anchorWeek) / 7);
    week = Math.max(0, Math.floor(w / interval) * interval);
  }
  let generated = 0;
  for (; ; week += interval) {
    const ws = addDays(anchorWeek, week * 7);
    if (ws > last) break;
    for (const d of days) {
      const date = addDays(ws, d);
      if (date < rule.start_date) continue;
      if (date > last) break;
      generated++;
      if (generated > maxCount) return out;
      if (date >= from) out.push(date);
    }
    if (generated >= maxCount) break;
  }
  return out;
}

export function isOccurrence(rule, date) {
  if (!isValidDate(date) || date < rule.start_date) return false;
  return occurrenceDates(rule, date, date).length === 1;
}

// Number of occurrences strictly before `date`.
export function countBefore(rule, date) {
  if (date <= rule.start_date) return 0;
  return occurrenceDates(rule, rule.start_date, addDays(date, -1)).length;
}

// Last occurrence date for bounded rules (null when open-ended).
export function lastOccurrence(rule) {
  if (rule.end_type === 'never') return null;
  if (rule.end_type === 'until') {
    const ds = occurrenceDates(rule, rule.start_date, rule.until_date);
    return ds.length ? ds[ds.length - 1] : null;
  }
  // count: worst case spans count * interval weeks
  const horizon = addDays(rule.start_date, (Number(rule.count) + 1) * 7 * Math.max(1, rule.interval_weeks));
  const ds = occurrenceDates(rule, rule.start_date, horizon);
  return ds.length ? ds[ds.length - 1] : null;
}

function dayList(days) {
  const names = days.map((d) => WEEKDAYS[d]);
  return joinList(names);
}

// Plain-language summary, e.g.
// "Every Monday and Wednesday, 8:00 AM–4:00 PM, starting November 2, 2026, through December 31."
export function describeRule(rule, hours = {}) {
  const days = sortedDays(rule);
  const n = Number(rule.interval_weeks) || 1;
  let s;
  if (n === 1) s = days.length === 7 ? 'Every day' : `Every ${dayList(days)}`;
  else if (n === 2) s = `Every other week on ${dayList(days)}`;
  else s = `Every ${n} weeks on ${dayList(days)}`;

  if (hours.hours_specified === false) s += ', hours not specified';
  else if (hours.start_time && hours.end_time) {
    const overnight = (hours.end_offset || 0) > 0;
    s += `, ${formatTime(hours.start_time)}–${formatTime(hours.end_time)}${overnight ? ' (next day)' : ''}`;
  }

  if (isValidDate(rule.start_date)) s += `, starting ${formatDateLong(rule.start_date)}`;
  if (rule.end_type === 'until' && isValidDate(rule.until_date)) {
    const sameYear = parseDate(rule.until_date).y === parseDate(rule.start_date).y;
    s += `, through ${formatDateLong(rule.until_date, !sameYear)}`;
  } else if (rule.end_type === 'count' && rule.count) {
    const c = Number(rule.count);
    s += `, for ${c} occurrence${c === 1 ? '' : 's'}`;
  } else if (rule.end_type === 'never') {
    s += ', with no end date';
  }
  return s + '.';
}

export function defaultWeekdaysFor(date) {
  return [weekday(date)];
}
