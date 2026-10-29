import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceDates, isOccurrence, countBefore, lastOccurrence, describeRule, validateRule } from '../shared/recurrence.js';
import { zonedToUtc, utcToZoned } from '../shared/time.js';
import { expandSeries } from '../shared/schedule.js';

const rule = (o) => ({ start_date: '2026-11-02', interval_weeks: 1, weekdays: [1, 3], end_type: 'never', until_date: null, count: null, ...o });

test('weekly on Monday and Wednesday', () => {
  assert.deepEqual(occurrenceDates(rule(), '2026-11-01', '2026-11-15'),
    ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11']);
});

test('every other week alternates relative to the series start', () => {
  const r = rule({ interval_weeks: 2, weekdays: [1] });
  assert.deepEqual(occurrenceDates(r, '2026-11-01', '2026-12-31'),
    ['2026-11-02', '2026-11-16', '2026-11-30', '2026-12-14', '2026-12-28']);
  // Querying a window that starts mid-series stays in phase.
  assert.deepEqual(occurrenceDates(r, '2026-11-20', '2026-12-20'), ['2026-11-30', '2026-12-14']);
  assert.equal(isOccurrence(r, '2026-11-09'), false);
  assert.equal(isOccurrence(r, '2026-11-16'), true);
});

test('every 3 weeks', () => {
  const r = rule({ interval_weeks: 3, weekdays: [5], start_date: '2026-11-06' });
  assert.deepEqual(occurrenceDates(r, '2026-11-01', '2026-12-31'), ['2026-11-06', '2026-11-27', '2026-12-18']);
});

test('start date mid-week skips earlier weekdays of the first week', () => {
  const r = rule({ start_date: '2026-11-04', weekdays: [1, 3, 5] });
  assert.deepEqual(occurrenceDates(r, '2026-11-01', '2026-11-10'), ['2026-11-04', '2026-11-06', '2026-11-09']);
});

test('ends on a date (inclusive)', () => {
  const r = rule({ end_type: 'until', until_date: '2026-11-09' });
  assert.deepEqual(occurrenceDates(r, '2026-11-01', '2027-01-01'), ['2026-11-02', '2026-11-04', '2026-11-09']);
  assert.equal(lastOccurrence(r), '2026-11-09');
});

test('ends after N occurrences, even when queried from a later window', () => {
  const r = rule({ end_type: 'count', count: 5 });
  assert.deepEqual(occurrenceDates(r, '2026-11-01', '2027-01-01'),
    ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16']);
  assert.deepEqual(occurrenceDates(r, '2026-11-10', '2027-01-01'), ['2026-11-11', '2026-11-16']);
  assert.equal(lastOccurrence(r), '2026-11-16');
  assert.equal(countBefore(r, '2026-11-11'), 3);
});

test('no end date is bounded by the query window', () => {
  const ds = occurrenceDates(rule(), '2030-01-01', '2030-01-31');
  assert.equal(ds.length, 9);
  assert.ok(ds.every((d) => d.startsWith('2030-01')));
});

test('plain-language summary', () => {
  assert.equal(
    describeRule(rule({ end_type: 'until', until_date: '2026-12-31' }), { start_time: '08:00', end_time: '16:00', hours_specified: true }),
    'Every Monday and Wednesday, 8:00 AM–4:00 PM, starting November 2, 2026, through December 31.');
  assert.equal(
    describeRule(rule({ interval_weeks: 2, weekdays: [2, 4, 6], end_type: 'count', count: 10 }), { start_time: '19:00', end_time: '07:00', end_offset: 1, hours_specified: true }),
    'Every other week on Tuesday, Thursday, and Saturday, 7:00 PM–7:00 AM (next day), starting November 2, 2026, for 10 occurrences.');
  assert.equal(describeRule(rule({ interval_weeks: 4, weekdays: [1] }), { hours_specified: false }),
    'Every 4 weeks on Monday, hours not specified, starting November 2, 2026, with no end date.');
});

test('validation', () => {
  assert.equal(validateRule(rule()).length, 0);
  assert.ok(validateRule(rule({ weekdays: [] })).length);
  assert.ok(validateRule(rule({ end_type: 'until', until_date: '2026-10-01' })).length);
  assert.ok(validateRule(rule({ end_type: 'count', count: 0 })).length);
});

test('daylight saving: local shift times are preserved across the change', () => {
  const tz = 'America/New_York';
  // US DST ends Sunday 2026-11-01.
  const series = { id: 1, facility_id: 1, nurse_id: 1, start_time: '08:00', end_time: '16:00', end_offset: 0,
    hours_specified: true, type: 'regular', status: 'confirmed', start_date: '2026-10-26', interval_weeks: 1,
    weekdays: [1], end_type: 'never' };
  const occs = expandSeries(series, [], '2026-10-26', '2026-11-02', () => tz);
  assert.deepEqual(occs.map((o) => o.date), ['2026-10-26', '2026-11-02']);
  assert.equal(new Date(occs[0].start_utc).toISOString(), '2026-10-26T12:00:00.000Z'); // EDT, UTC-4
  assert.equal(new Date(occs[1].start_utc).toISOString(), '2026-11-02T13:00:00.000Z'); // EST, UTC-5
  for (const o of occs) {
    assert.equal(utcToZoned(o.start_utc, tz).time, '08:00');
    assert.equal(o.end_utc - o.start_utc, 8 * 3600000);
  }
});

test('daylight saving: overnight shift durations reflect the clock change', () => {
  const tz = 'America/New_York';
  // Fall back: 7 PM Oct 31 -> 7 AM Nov 1 is 13 real hours.
  assert.equal(zonedToUtc('2026-11-01', '07:00', tz) - zonedToUtc('2026-10-31', '19:00', tz), 13 * 3600000);
  // Spring forward (2027-03-14): 7 PM -> 7 AM is 11 real hours.
  assert.equal(zonedToUtc('2027-03-14', '07:00', tz) - zonedToUtc('2027-03-13', '19:00', tz), 11 * 3600000);
  // A nonexistent wall time resolves forward rather than failing.
  assert.equal(utcToZoned(zonedToUtc('2027-03-14', '02:30', tz), tz).time, '03:30');
  // An ambiguous wall time resolves to the first occurrence (EDT).
  assert.equal(new Date(zonedToUtc('2026-11-01', '01:30', tz)).toISOString(), '2026-11-01T05:30:00.000Z');
});

test('daylight saving: other timezones (Europe/London)', () => {
  const tz = 'Europe/London';
  // BST ends 2026-10-25.
  assert.equal(new Date(zonedToUtc('2026-10-24', '09:00', tz)).toISOString(), '2026-10-24T08:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-10-26', '09:00', tz)).toISOString(), '2026-10-26T09:00:00.000Z');
});
