import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, PG_SCHEMA } from '../server/db.js';
import { Store } from '../server/store.js';
import { utcToZoned } from '../shared/time.js';

let store;
let fac;
let fac2;
let alice;
let bob;
let carol;

// Runs on in-memory SQLite by default; set TEST_DATABASE_URL to run the same
// tests against Postgres (the nurse_schedule schema is dropped before each test).
const PG_URL = process.env.TEST_DATABASE_URL;

beforeEach(async () => {
  if (PG_URL) {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
    await c.end();
  }
  store = new Store(await openDb(PG_URL || ':memory:'));
  fac = await store.saveFacility({ name: 'North Clinic', timezone: 'America/New_York' });
  fac2 = await store.saveFacility({ name: 'West Clinic', timezone: 'America/Los_Angeles' });
  alice = await store.saveNurse({ name: 'Alice' });
  bob = await store.saveNurse({ name: 'Bob' });
  carol = await store.saveNurse({ name: 'Carol' });
});

afterEach(() => store.db.close());

const shift = (o = {}) => ({
  facility_id: fac.id, nurse_id: alice.id, start_time: '08:00', end_time: '16:00', end_offset: 0,
  hours_specified: true, type: 'regular', status: 'confirmed', notes: '', ...o,
});
const occ = (from, to = from) => store.occurrences(from, to);
const conflict = (fn) => assert.rejects(fn, (e) => e.status === 409 && e.extra.conflicts.length > 0);

test('1. one-time coverage assignment from a date', async () => {
  const [id] = await store.createShifts({ ...shift({ type: 'coverage', covering_for_id: bob.id }), dates: ['2026-11-05'] });
  const [o] = (await occ('2026-11-05'));
  assert.equal(o.id, id);
  assert.equal(o.type, 'coverage');
  assert.equal(o.covering_for_id, bob.id);
  assert.equal(o.recurring, false);
});

test('validation: confirmed/tentative need a nurse, unfilled does not', async () => {
  await assert.rejects(() => store.createShifts({ ...shift({ nurse_id: null }), dates: ['2026-11-05'] }), /assigned nurse/);
  await assert.rejects(() => store.createShifts({ ...shift({ nurse_id: null, status: 'tentative' }), dates: ['2026-11-05'] }), /assigned nurse/);
  const [id] = await store.createShifts({ ...shift({ nurse_id: null, status: 'unfilled' }), dates: ['2026-11-05'] });
  assert.ok(id);
  await assert.rejects(() => store.createShifts({ ...shift({ end_time: '07:00' }), dates: ['2026-11-05'] }), /next day/);
});

test('unspecified hours are not treated as 24-hour coverage', async () => {
  await store.createShifts({ ...shift({ hours_specified: false }), dates: ['2026-11-05'] });
  const [o] = (await occ('2026-11-05'));
  assert.equal(o.start_utc, null);
  assert.equal(o.end_date, '2026-11-05');
  await store.saveRequirement({ facility_id: fac.id, weekdays: [4], start_time: '08:00', end_time: '16:00', min_nurses: 1 });
  const { requirements } = await store.schedule('2026-11-05', '2026-11-05');
  assert.equal(requirements[0].met, false);
});

test('2. same assignment applied to multiple dates', async () => {
  const ids = await store.createShifts({ ...shift(), dates: ['2026-11-03', '2026-11-05', '2026-11-10'] });
  assert.equal(ids.length, 3);
  assert.deepEqual((await occ('2026-11-01', '2026-11-30')).map((o) => o.date), ['2026-11-03', '2026-11-05', '2026-11-10']);
});

test('3. every-other-week series stored as one row and expanded on demand', async () => {
  await store.createSeries({ ...shift(), recurrence: { start_date: '2026-11-02', interval_weeks: 2, weekdays: [1, 3], end_type: 'never' } });
  assert.equal(Number((await store.db.get('SELECT COUNT(*) AS n FROM series')).n), 1);
  assert.deepEqual((await occ('2026-11-01', '2026-11-30')).map((o) => o.date),
    ['2026-11-02', '2026-11-04', '2026-11-16', '2026-11-18', '2026-11-30']);
  // Far future still works without generating rows.
  assert.equal((await occ('2030-06-01', '2030-06-30')).length > 0, true);
});

test('4. change one occurrence without affecting the series (nurse swap kept as exception)', async () => {
  const sid = await store.createSeries({ ...shift({ type: 'coverage' }), recurrence: { start_date: '2026-11-02', interval_weeks: 1, weekdays: [1], end_type: 'never' } });
  await store.updateOccurrence(`r:${sid}:2026-11-09`, { ...shift({ type: 'coverage', nurse_id: bob.id }), scope: 'this' });
  const os = (await occ('2026-11-01', '2026-11-30'));
  assert.deepEqual(os.map((o) => o.nurse_id), [alice.id, bob.id, alice.id, alice.id, alice.id]);
  assert.equal(os[1].is_exception, true);
  assert.equal(Number((await store.db.get('SELECT COUNT(*) AS n FROM series_exceptions')).n), 1);

  // Editing the entire series afterwards preserves the exception's nurse.
  await store.updateOccurrence(`r:${sid}:2026-11-02`, { ...shift({ type: 'coverage', start_time: '09:00', end_time: '17:00' }), scope: 'all' });
  const after = (await occ('2026-11-01', '2026-11-30'));
  assert.deepEqual(after.map((o) => o.nurse_id), [alice.id, bob.id, alice.id, alice.id, alice.id]);
  assert.ok(after.every((o) => o.start_time === '09:00'));
});

test('cancel one occurrence and move another', async () => {
  const sid = await store.createSeries({ ...shift(), recurrence: { start_date: '2026-11-02', interval_weeks: 1, weekdays: [1], end_type: 'never' } });
  await store.deleteOccurrence(`r:${sid}:2026-11-09`, 'this');
  await store.updateOccurrence(`r:${sid}:2026-11-16`, { ...shift(), date: '2026-11-17', scope: 'this' });
  assert.deepEqual((await occ('2026-11-01', '2026-11-30')).map((o) => o.date), ['2026-11-02', '2026-11-17', '2026-11-23', '2026-11-30']);
  const moved = (await store.getOccurrence(`r:${sid}:2026-11-16`)).occ;
  assert.equal(moved.date, '2026-11-17');
});

test('5. change this and future occurrences without altering the past', async () => {
  const sid = await store.createSeries({ ...shift(), recurrence: { start_date: '2026-11-02', interval_weeks: 2, weekdays: [1], end_type: 'count', count: 6 } });
  // An exception in the past and one in the future.
  await store.updateOccurrence(`r:${sid}:2026-11-02`, { ...shift({ notes: 'past note' }), scope: 'this' });
  await store.updateOccurrence(`r:${sid}:2027-01-11`, { ...shift({ nurse_id: carol.id }), scope: 'this' });

  const res = await store.updateOccurrence(`r:${sid}:2026-11-30`, { ...shift({ start_time: '10:00', end_time: '18:00' }), scope: 'future' });
  assert.notEqual(res.series_id, sid);
  const os = (await occ('2026-11-01', '2027-03-01'));
  assert.deepEqual(os.map((o) => o.date), ['2026-11-02', '2026-11-16', '2026-11-30', '2026-12-14', '2026-12-28', '2027-01-11']);
  assert.deepEqual(os.map((o) => o.start_time), ['08:00', '08:00', '10:00', '10:00', '10:00', '10:00']);
  assert.equal(os[0].notes, 'past note');
  assert.equal(os[0].series_id, sid);
  // Future exception moved to the new series and preserved.
  assert.equal(os[5].nurse_id, carol.id);
  assert.equal(os[5].series_id, res.series_id);
  // Total occurrence count preserved (6).
  assert.equal((await occ('2026-11-01', '2028-01-01')).length, 6);
});

test('delete this and future keeps the past', async () => {
  const sid = await store.createSeries({ ...shift(), recurrence: { start_date: '2026-11-02', interval_weeks: 1, weekdays: [1], end_type: 'never' } });
  await store.deleteOccurrence(`r:${sid}:2026-11-16`, 'future');
  assert.deepEqual((await occ('2026-11-01', '2026-12-31')).map((o) => o.date), ['2026-11-02', '2026-11-09']);
  await store.deleteOccurrence(`r:${sid}:2026-11-09`, 'all');
  assert.equal((await occ('2026-11-01', '2026-12-31')).length, 0);
});

test('6. assign a replacement nurse without double counting', async () => {
  const [orig] = await store.createShifts({ ...shift(), dates: ['2026-11-05'] });
  await store.saveRequirement({ facility_id: fac.id, weekdays: [4], start_time: '08:00', end_time: '16:00', min_nurses: 2 });
  await store.assignCoverage(orig, { nurse_id: bob.id, start_time: '08:00', end_time: '16:00', end_offset: 0, status: 'confirmed' });
  const os = (await occ('2026-11-05'));
  const original = os.find((o) => o.id === orig);
  const cover = os.find((o) => o.id !== orig);
  assert.equal(original.vacated, true);
  assert.equal(cover.nurse_id, bob.id);
  assert.equal(cover.covering_for_id, alice.id);
  assert.equal(cover.type, 'coverage');
  const { requirements, coverage } = await store.schedule('2026-11-05', '2026-11-05');
  // Only one nurse is counted: requirement of 2 is short by one for the whole window.
  assert.equal(requirements[0].met, false);
  assert.equal(requirements[0].shortfalls.length, 1);
  assert.equal(requirements[0].shortfalls[0].confirmed, 1);
  assert.equal(coverage[orig].fully_covered, true);
  // Alice is free again; she can take another shift then without an overlap warning.
  await assert.doesNotReject(() => store.createShifts({ ...shift({ facility_id: fac2.id, start_time: '06:00', end_time: '10:00' }), dates: ['2026-11-05'] }));
});

test('6b. covering a recurring occurrence only affects that occurrence', async () => {
  const sid = await store.createSeries({ ...shift(), recurrence: { start_date: '2026-11-02', interval_weeks: 1, weekdays: [1], end_type: 'never' } });
  await store.assignCoverage(`r:${sid}:2026-11-09`, { nurse_id: bob.id, start_time: '08:00', end_time: '16:00', status: 'confirmed' });
  const os = (await occ('2026-11-01', '2026-11-30'));
  const series = os.filter((o) => o.series_id === sid);
  assert.deepEqual(series.map((o) => o.vacated), [false, true, false, false, false]);
  assert.equal(os.filter((o) => o.nurse_id === bob.id).length, 1);
});

test('7. partial coverage leaves an accurate remaining gap', async () => {
  const [orig] = await store.createShifts({ ...shift({ start_time: '07:00', end_time: '19:00' }), dates: ['2026-11-05'] });
  await store.assignCoverage(orig, { nurse_id: bob.id, start_time: '07:00', end_time: '11:00', status: 'confirmed' });
  await store.assignCoverage(orig, { nurse_id: carol.id, start_time: '15:00', end_time: '19:00', status: 'tentative' });
  const { coverage } = await store.schedule('2026-11-05', '2026-11-05');
  const c = coverage[orig];
  assert.equal(c.fully_covered, false);
  const tz = 'America/New_York';
  const fmt = (segs) => segs.map(([s, e]) => `${utcToZoned(s, tz).time}-${utcToZoned(e, tz).time}`);
  assert.deepEqual(fmt(c.remaining), ['11:00-15:00']);
  assert.deepEqual(fmt(c.tentative), ['15:00-19:00']);
  const att = await store.attention('2026-11-01', 30);
  assert.equal(att.open.length, 1);
  assert.equal(att.open[0].occurrence.id, orig);

  // Filling the middle closes the gap; the tentative part remains flagged.
  await store.assignCoverage(orig, { nurse_id: carol.id, start_time: '11:00', end_time: '15:00', status: 'confirmed', force: true });
  const c2 = (await store.schedule('2026-11-05', '2026-11-05')).coverage[orig];
  assert.deepEqual(c2.remaining, []);
  assert.equal(c2.tentatively_covered, true);
});

test('coverage must fall within the original shift', async () => {
  const [orig] = await store.createShifts({ ...shift(), dates: ['2026-11-05'] });
  await assert.rejects(() => store.assignCoverage(orig, { nurse_id: bob.id, start_time: '06:00', end_time: '10:00' }), /within/);
});

test('filling an unfilled shift', async () => {
  const [orig] = await store.createShifts({ ...shift({ nurse_id: null, status: 'unfilled' }), dates: ['2026-11-05'] });
  assert.equal((await store.attention('2026-11-01', 30)).open.length, 1);
  await store.assignCoverage(orig, { nurse_id: bob.id, start_time: '08:00', end_time: '16:00', status: 'confirmed' });
  assert.equal((await store.attention('2026-11-01', 30)).open.length, 0);
  const cover = (await occ('2026-11-05')).find((o) => o.id !== orig);
  assert.equal(cover.covering_for_id, null);
});

test('8. overlap warnings, including overnight and across facilities', async () => {
  await store.createShifts({ ...shift({ start_time: '19:00', end_time: '07:00', end_offset: 1 }), dates: ['2026-11-05'] });
  // Next-morning shift at another facility (different timezone) overlaps the overnight tail.
  // 06:00 Pacific = 09:00 Eastern, after 07:00 Eastern -> no overlap.
  await assert.doesNotReject(() => store.createShifts({ ...shift({ facility_id: fac2.id, start_time: '06:00', end_time: '10:00' }), dates: ['2026-11-06'] }));
  // 03:00 Pacific = 06:00 Eastern -> overlaps the overnight shift ending 07:00 Eastern.
  await conflict(() => store.createShifts({ ...shift({ facility_id: fac2.id, start_time: '03:00', end_time: '05:00' }), dates: ['2026-11-06'] }));
  // Same-facility next morning overlap.
  await conflict(() => store.createShifts({ ...shift({ start_time: '06:00', end_time: '12:00' }), dates: ['2026-11-06'] }));
  // Override with confirmation.
  const ids = await store.createShifts({ ...shift({ start_time: '06:00', end_time: '12:00' }), dates: ['2026-11-06'], force: true });
  assert.equal(ids.length, 1);
  // Back-to-back shifts do not overlap.
  await assert.doesNotReject(() => store.createShifts({ ...shift({ start_time: '16:00', end_time: '19:00' }), dates: ['2026-11-05'] }));
  // Unspecified hours on the same day -> possible conflict.
  await assert.rejects(() => store.createShifts({ ...shift({ hours_specified: false }), dates: ['2026-11-05'] }),
    (e) => e.status === 409 && e.extra.conflicts[0].kind === 'possible');
  // Other nurses are not affected.
  await assert.doesNotReject(() => store.createShifts({ ...shift({ nurse_id: bob.id }), dates: ['2026-11-05'] }));
});

test('overlap check for recurring series and edits excludes itself', async () => {
  await store.createShifts({ ...shift(), dates: ['2026-11-18'] });
  await conflict(() => store.createSeries({ ...shift({ start_time: '12:00', end_time: '20:00' }), recurrence: { start_date: '2026-11-02', interval_weeks: 2, weekdays: [3], end_type: 'never' } }));
  const sid = await store.createSeries({ ...shift(), recurrence: { start_date: '2026-11-02', interval_weeks: 1, weekdays: [1], end_type: 'never' } });
  // Editing an occurrence's notes does not conflict with itself.
  await assert.doesNotReject(() => store.updateOccurrence(`r:${sid}:2026-11-09`, { ...shift({ notes: 'x' }), scope: 'this' }));
  await assert.doesNotReject(() => store.updateOccurrence(`r:${sid}:2026-11-09`, { ...shift({ start_time: '09:00', end_time: '17:00' }), scope: 'all' }));
});

test('10. requirements: only configured requirements create gaps; tentative stays distinct', async () => {
  // No requirement configured -> empty days produce no gaps.
  assert.deepEqual(await store.attention('2026-11-01', 30), { open: [], requirements: [] });

  await store.saveRequirement({ facility_id: fac.id, weekdays: [1, 2, 3, 4, 5], start_time: '07:00', end_time: '19:00', min_nurses: 1 });
  await store.createShifts({ ...shift({ start_time: '07:00', end_time: '19:00' }), dates: ['2026-11-02'] });
  await store.createShifts({ ...shift({ start_time: '07:00', end_time: '13:00', nurse_id: bob.id }), dates: ['2026-11-03'] });
  await store.createShifts({ ...shift({ start_time: '13:00', end_time: '19:00', nurse_id: carol.id, status: 'tentative' }), dates: ['2026-11-03'] });
  const { requirements } = await store.schedule('2026-11-01', '2026-11-07');
  const byDate = Object.fromEntries(requirements.map((r) => [r.date, r]));
  assert.equal(byDate['2026-11-01'], undefined); // Sunday: no requirement -> not a gap
  assert.equal(byDate['2026-11-07'], undefined);
  assert.equal(byDate['2026-11-02'].met, true);
  assert.equal(byDate['2026-11-03'].met, false);
  assert.equal(byDate['2026-11-03'].met_with_tentative, true);
  const s = byDate['2026-11-03'].shortfalls;
  assert.equal(s.length, 1);
  assert.equal(s[0].start_local.time, '13:00');
  assert.equal(s[0].end_local.time, '19:00');
  assert.equal(byDate['2026-11-04'].met, false);
  assert.equal(byDate['2026-11-04'].met_with_tentative, false);
});

test('overnight requirement window counts overnight shifts', async () => {
  await store.saveRequirement({ facility_id: fac.id, weekdays: [5], start_time: '19:00', end_time: '07:00', min_nurses: 1 });
  await store.createShifts({ ...shift({ start_time: '19:00', end_time: '07:00', end_offset: 1 }), dates: ['2026-11-06'] });
  const { requirements } = await store.schedule('2026-11-06', '2026-11-06');
  assert.equal(requirements[0].met, true);
});

test('inactive nurses keep historical assignments', async () => {
  await store.createShifts({ ...shift(), dates: ['2026-11-05'] });
  await store.saveNurse({ name: 'Alice', active: false }, alice.id);
  assert.equal((await store.getNurse(alice.id)).active, false);
  assert.equal((await occ('2026-11-05'))[0].nurse_id, alice.id);
});

test('presets reflect commonly used hours', async () => {
  await store.createShifts({ ...shift({ start_time: '07:00', end_time: '19:00' }), dates: ['2026-11-02', '2026-11-03', '2026-11-04'] });
  await store.createShifts({ ...shift({ start_time: '19:00', end_time: '07:00', end_offset: 1, nurse_id: bob.id }), dates: ['2026-11-02'] });
  const p = await store.presets(fac.id);
  assert.deepEqual(p[0], { start_time: '07:00', end_time: '19:00', end_offset: 0 });
  assert.deepEqual(p[1], { start_time: '19:00', end_time: '07:00', end_offset: 1 });
});

test('reverting a one-off change removes the exception', async () => {
  const sid = await store.createSeries({ ...shift(), recurrence: { start_date: '2026-11-02', interval_weeks: 1, weekdays: [1], end_type: 'never' } });
  await store.updateOccurrence(`r:${sid}:2026-11-09`, { ...shift({ nurse_id: bob.id }), scope: 'this' });
  await store.updateOccurrence(`r:${sid}:2026-11-09`, { ...shift(), scope: 'this' });
  assert.equal((await store.getExceptions(sid)).length, 0);
  assert.equal((await occ('2026-11-09'))[0].is_exception, false);
});

test('fully covered released shift reports its coverer', async () => {
  const [orig] = await store.createShifts({ ...shift(), dates: ['2026-11-05'] });
  const { id } = await store.assignCoverage(orig, { nurse_id: bob.id, start_time: '08:00', end_time: '16:00', status: 'confirmed' });
  const c = (await store.schedule('2026-11-05', '2026-11-05')).coverage[orig];
  assert.equal(c.fully_covered, true);
  assert.deepEqual(c.coverers, [id]);
  // Restoring the original nurse makes them count again.
  await store.restoreOccurrence(orig);
  assert.equal((await occ('2026-11-05')).find((o) => o.id === orig).vacated, false);
});
