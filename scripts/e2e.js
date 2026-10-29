// Browser walkthrough of the main workflows against a fresh database.
// Usage: node scripts/e2e.js   (needs Playwright + Chromium available)
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(join(process.env.NODE_PATH || '/usr/lib/node_modules', 'playwright'))); }

const shots = process.env.SHOTS_DIR || join(tmpdir(), 'nurse-shots');
mkdirSync(shots, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'nurse-e2e-'));
const db = openDb(join(dir, 'e2e.db'));
const server = createServer(createApp(new Store(db)));
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/status of 409/.test(m.text())) errors.push(m.text()); });

const step = (s) => console.log(`• ${s}`);
const drawer = () => page.locator('#drawer');
const cell = (d) => page.locator(`.day[data-date="${d}"]`);

try {
  await page.goto(url);
  step('first run opens setup');
  await drawer().getByText('New facility').waitFor();
  await page.fill('#new-fac', 'North Clinic');
  await page.selectOption('#new-fac-tz', 'America/New_York');
  await drawer().getByRole('button', { name: 'Add facility' }).click();
  await page.fill('#new-fac', 'West Campus');
  await page.selectOption('#new-fac-tz', 'America/Los_Angeles');
  await drawer().getByRole('button', { name: 'Add facility' }).click();
  await drawer().locator('[data-fac-name]').nth(1).waitFor();
  await drawer().getByRole('tab', { name: 'Nurses' }).click();
  for (const n of ['Alice', 'Bob', 'Carol']) {
    await page.fill('#new-nurse', n);
    await page.press('#new-nurse', 'Enter');
    await drawer().locator(`[data-nurse-name][value="${n}"]`).waitFor();
  }
  await drawer().getByRole('tab', { name: 'Coverage requirements' }).click();
  await page.selectOption('#rq-fac', { label: 'North Clinic' });
  await page.fill('#rq-start', '08:00');
  await page.fill('#rq-end', '16:00');
  await drawer().getByRole('button', { name: 'Add requirement' }).click();
  await drawer().getByText('min 1').waitFor();
  await drawer().getByRole('button', { name: 'Done' }).click();

  await page.fill('#jump', '2026-11-01');
  await page.dispatchEvent('#jump', 'change');
  await page.locator('#title', { hasText: 'November 2026' }).waitFor();

  step('1. one-time coverage from a calendar date');
  await cell('2026-11-05').click({ position: { x: 60, y: 90 } });
  await page.selectOption('#f-facility', { label: 'North Clinic' });
  await page.selectOption('#f-nurse', { label: 'Alice' });
  await page.click('label[for="type-coverage"]');
  await page.selectOption('#f-covering', { label: 'Bob' });
  await page.fill('#f-start', '08:00');
  await page.fill('#f-end', '16:00');
  await drawer().getByRole('button', { name: 'Save' }).click();
  await cell('2026-11-05').locator('.entry.type-coverage', { hasText: 'Alice' }).waitFor();
  assert.match(await cell('2026-11-05').locator('.entry').first().innerText(), /8a–4p[\s\S]*Alice[\s\S]*Coverage[\s\S]*North Clinic[\s\S]*for Bob/i);
  await page.screenshot({ path: join(shots, '1-month.png') });

  step('2. same assignment to multiple selected dates');
  await page.click('#select-btn');
  await cell('2026-11-10').click({ position: { x: 60, y: 90 } });
  await cell('2026-11-12').click({ position: { x: 60, y: 90 } });
  await page.getByRole('button', { name: 'Add shift to selected' }).click();
  await drawer().locator('.date-chip').nth(1).waitFor();
  await page.selectOption('#f-nurse', { label: 'Carol' });
  await drawer().getByRole('button', { name: 'Save' }).click();
  await cell('2026-11-10').locator('.entry', { hasText: 'Carol' }).waitFor();
  await cell('2026-11-12').locator('.entry', { hasText: 'Carol' }).waitFor();

  step('3. every-other-week recurring schedule with summary');
  await cell('2026-11-02').click({ position: { x: 60, y: 90 } });
  await page.selectOption('#f-nurse', { label: 'Alice' });
  await page.fill('#f-start', '08:00');
  await page.fill('#f-end', '16:00');
  await page.selectOption('#f-repeat', 'biweekly');
  await page.locator('label:has(input[name="wd"][value="3"])').click();
  await page.check('input[name="endtype"][value="until"]');
  await page.fill('#f-until', '2026-12-31');
  await page.dispatchEvent('#f-until', 'input');
  const summary = await page.textContent('#rule-summary');
  assert.equal(summary, 'Every other week on Monday and Wednesday, 8:00 AM–4:00 PM, starting November 2, 2026, through December 31.');
  await page.screenshot({ path: join(shots, '3-recurring-form.png') });
  await drawer().getByRole('button', { name: 'Save' }).click();
  await cell('2026-11-16').locator('.entry', { hasText: 'Alice' }).waitFor();
  assert.equal(await cell('2026-11-09').locator('.entry', { hasText: 'Alice' }).count(), 0);
  assert.equal(await cell('2026-11-18').locator('.entry', { hasText: 'Alice' }).count(), 1);

  step('4. change one occurrence only');
  await cell('2026-11-16').locator('.entry', { hasText: 'Alice' }).click();
  await drawer().getByRole('button', { name: 'Edit' }).click();
  await page.selectOption('#f-nurse', { label: 'Bob' });
  await drawer().getByRole('button', { name: 'Save changes' }).click();
  await page.locator('#modal').getByRole('button', { name: /This occurrence only/ }).click();
  await cell('2026-11-16').locator('.entry', { hasText: 'Bob' }).waitFor();
  assert.equal(await cell('2026-11-30').locator('.entry', { hasText: 'Alice' }).count(), 1);
  assert.equal(await cell('2026-11-18').locator('.entry', { hasText: 'Alice' }).count(), 1);

  step('5. change this and future occurrences');
  await cell('2026-11-18').locator('.entry', { hasText: 'Alice' }).click();
  await drawer().getByRole('button', { name: 'Edit' }).click();
  await page.fill('#f-start', '09:00');
  await page.fill('#f-end', '17:00');
  await drawer().getByRole('button', { name: 'Save changes' }).click();
  await page.locator('#modal').getByRole('button', { name: /This and future/ }).click();
  await cell('2026-11-18').locator('.entry', { hasText: '9a–5p' }).waitFor();
  assert.equal(await cell('2026-11-04').locator('.entry', { hasText: '8a–4p' }).count(), 1);
  assert.equal(await cell('2026-11-16').locator('.entry', { hasText: '8a–4p' }).count(), 1, 'past exception keeps its hours');
  assert.equal(await cell('2026-11-30').locator('.entry', { hasText: '9a–5p' }).count(), 1);

  step('6/7. partial coverage on a recurring occurrence');
  await cell('2026-11-30').locator('.entry', { hasText: 'Alice' }).click();
  await drawer().getByRole('button', { name: 'Assign coverage' }).click();
  await page.selectOption('#c-nurse', { label: 'Carol' });
  await page.fill('#c-end', '13:00');
  await page.dispatchEvent('#c-end', 'input');
  assert.match(await page.textContent('#c-remaining'), /Remaining unfilled after this: 1:00 PM–5:00 PM/);
  await drawer().getByRole('button', { name: 'Assign coverage' }).click();
  await cell('2026-11-30').locator('.entry.type-coverage', { hasText: 'Carol' }).waitFor();
  assert.match(await cell('2026-11-30').locator('.entry.vacated').innerText(), /Alice[\s\S]*needs coverage/i);
  assert.match(await page.textContent('#attention'), /Mon Nov 30 · North Clinic\s*Alice released — 1:00 PM–5:00 PM unfilled/);
  assert.match(await cell('2026-11-30').locator('.entry.type-coverage').innerText(), /for Alice/);

  step('8. overlap warning for overnight shift, with override');
  await cell('2026-11-19').click({ position: { x: 60, y: 90 } });
  await page.selectOption('#f-nurse', { label: 'Bob' });
  await page.fill('#f-start', '19:00');
  await page.fill('#f-end', '07:00');
  await page.dispatchEvent('#f-end', 'change');
  assert.equal(await page.inputValue('#f-end-date'), '1');
  await drawer().getByRole('button', { name: 'Save' }).click();
  await cell('2026-11-19').locator('.entry', { hasText: 'Bob' }).waitFor();
  await cell('2026-11-20').click({ position: { x: 60, y: 90 } });
  await page.selectOption('#f-facility', { label: 'West Campus' });
  await page.selectOption('#f-nurse', { label: 'Bob' });
  await page.fill('#f-start', '03:00');
  await page.fill('#f-end', '06:00');
  await page.dispatchEvent('#f-end', 'change');
  await drawer().getByRole('button', { name: 'Save' }).click();
  await page.locator('#modal').getByRole('heading', { name: 'Overlapping assignment' }).waitFor();
  assert.match(await page.textContent('#modal'), /Bob is already scheduled:[\s\S]*Thu Nov 19, 7:00 PM–7:00 AM \(next day\) at North Clinic/);
  await page.screenshot({ path: join(shots, '8-overlap.png') });
  await page.locator('#modal').getByRole('button', { name: 'Save anyway' }).click();
  await cell('2026-11-20').locator('.entry', { hasText: 'West Campus' }).waitFor();

  step('10. unfilled shifts vs. days without requirements');
  await cell('2026-11-21').click({ position: { x: 60, y: 90 } });
  assert.equal(await page.inputValue('#f-facility'), await page.locator('#f-facility option', { hasText: 'West Campus' }).getAttribute('value'), 'remembers last facility');
  assert.equal(await page.inputValue('#f-start'), '03:00', 'remembers last hours for the facility');
  await page.selectOption('#f-facility', { label: 'North Clinic' });
  await page.click('label[for="status-unfilled"]');
  await drawer().getByRole('button', { name: 'Save' }).click();
  await cell('2026-11-21').locator('.entry.status-unfilled').waitFor();
  assert.equal(await cell('2026-11-22').locator('.req-badge').count(), 0, 'Sunday has no requirement, no badge');
  assert.equal(await cell('2026-11-02').locator('.req-badge.ok').count(), 1);
  assert.equal(await cell('2026-11-03').locator('.req-badge.short').count(), 1);
  assert.match(await page.textContent('#attention'), /Sat Nov 21 · North Clinic\s*Unfilled shift/);

  step('9. reload keeps everything');
  const before = await page.locator('.entry').count();
  await page.reload();
  await page.fill('#jump', '2026-11-01');
  await page.dispatchEvent('#jump', 'change');
  await page.locator('#title', { hasText: 'November 2026' }).waitFor();
  await cell('2026-11-30').locator('.entry.type-coverage').waitFor();
  assert.equal(await page.locator('.entry').count(), before);
  await page.screenshot({ path: join(shots, '9-after-reload.png'), fullPage: true });

  step('week and agenda views, filters');
  await page.click('[data-view="week"]');
  await page.fill('#jump', '2026-11-30');
  await page.dispatchEvent('#jump', 'change');
  await page.locator('.week-col .entry', { hasText: 'Carol' }).waitFor();
  await page.screenshot({ path: join(shots, 'week.png') });
  await page.click('[data-view="agenda"]');
  await page.locator('.ag-day').first().waitFor();
  await page.selectOption('#filter-nurse', { label: 'Carol' });
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-list .entry')].every((e) => /Carol|for Carol/.test(e.textContent)));
  await page.selectOption('#filter-nurse', '');
  await page.selectOption('#filter-facility', { label: 'West Campus' });
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-list .entry')].every((e) => e.textContent.includes('West Campus')));
  await page.selectOption('#filter-facility', '');
  await page.click('[data-view="month"]');

  step('mobile layout');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.fill('#jump', '2026-11-01');
  await page.dispatchEvent('#jump', 'change');
  await page.locator('#title', { hasText: 'November 2026' }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll on mobile (overflow ${overflow}px)`);
  await page.screenshot({ path: join(shots, 'mobile.png'), fullPage: true });
  await cell('2026-11-05').click({ position: { x: 5, y: 5 } });
  await drawer().getByText('Add shift').waitFor();
  await page.screenshot({ path: join(shots, 'mobile-form.png') });

  assert.deepEqual(errors, [], `browser errors: ${errors.join('\n')}`);
  console.log(`\nAll browser checks passed. Screenshots in ${shots}`);
} finally {
  await browser.close();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
