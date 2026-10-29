import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';

async function start(file) {
  const db = await openDb(file);
  const server = createServer(createApp(new Store(db)));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const stop = () => new Promise((r) => server.close(r)).then(() => db.close());
  return { call, stop, base };
}

test('9. data persists across a restart, served over HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nurse-'));
  const file = join(dir, 'test.db');
  try {
    let app = await start(file);
    const fac = (await app.call('POST', '/api/facilities', { name: 'North', timezone: 'America/Chicago' })).body;
    const n1 = (await app.call('POST', '/api/nurses', { name: 'Alice' })).body;
    const n2 = (await app.call('POST', '/api/nurses', { name: 'Bob' })).body;
    const base = { facility_id: fac.id, nurse_id: n1.id, start_time: '08:00', end_time: '16:00', hours_specified: true, type: 'regular', status: 'confirmed' };
    const s = await app.call('POST', '/api/series', { ...base, recurrence: { start_date: '2026-11-02', interval_weeks: 2, weekdays: [1], end_type: 'never' } });
    assert.equal(s.status, 201);
    const occId = `r:${s.body.series_id}:2026-11-16`;
    const ex = await app.call('PUT', `/api/occurrences/${encodeURIComponent(occId)}`, { ...base, nurse_id: n2.id, scope: 'this' });
    assert.equal(ex.status, 200);
    const cov = await app.call('POST', '/api/occurrences/r%3A1%3A2026-11-30/coverage', { nurse_id: n2.id, start_time: '08:00', end_time: '12:00', status: 'confirmed' });
    assert.equal(cov.status, 201);
    await app.call('POST', '/api/requirements', { facility_id: fac.id, weekdays: [1], start_time: '08:00', end_time: '16:00', min_nurses: 1 });

    // Overlap returns 409 with details; force overrides.
    const dup = await app.call('POST', '/api/shifts', { ...base, dates: ['2026-11-02'] });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.conflicts[0].nurse, 'Alice');
    assert.equal((await app.call('POST', '/api/shifts', { ...base, dates: ['2026-11-02'], force: true })).status, 201);
    await app.stop();

    app = await start(file);
    const sched = (await app.call('GET', '/api/schedule?from=2026-11-01&to=2026-11-30')).body;
    const os = sched.occurrences;
    assert.deepEqual(os.map((o) => [o.date, o.nurse_id]), [
      ['2026-11-02', n1.id], ['2026-11-02', n1.id], ['2026-11-16', n2.id], ['2026-11-30', n1.id], ['2026-11-30', n2.id]]);
    const released = os.find((o) => o.id === 'r:1:2026-11-30');
    assert.equal(released.vacated, true);
    assert.equal(sched.coverage[released.id].remaining.length, 1);
    const reqs = Object.fromEntries(sched.requirements.map((r) => [r.date, r.met]));
    assert.deepEqual(reqs, { '2026-11-02': true, '2026-11-09': false, '2026-11-16': true, '2026-11-23': false, '2026-11-30': false });

    const att = (await app.call('GET', '/api/attention?from=2026-11-01&days=30')).body;
    assert.equal(att.open.length, 1);

    // Validation errors are reported as 400.
    const badReq = await app.call('POST', '/api/shifts', { ...base, nurse_id: null, dates: ['2026-11-03'] });
    assert.equal(badReq.status, 400);
    assert.match(badReq.body.error, /nurse/);
    // Static assets and shared modules are served.
    const page = await fetch(`${app.base}/`);
    assert.equal(page.status, 200);
    const mod = await fetch(`${app.base}/shared/recurrence.js`);
    assert.equal(mod.status, 200);
    await app.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
