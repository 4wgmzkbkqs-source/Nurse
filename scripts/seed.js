// Adds demo facilities, nurses, a requirement and a few assignments around
// the current date. Usage: npm run seed  (uses DATABASE_URL/POSTGRES_URL,
// DB_FILE, or data/schedule.db)
import { openDb } from '../server/db.js';
import { databaseTarget } from '../server/index.js';
import { Store } from '../server/store.js';
import { addDays, startOfWeek, todayIn } from '../shared/time.js';

const store = new Store(await openDb(databaseTarget()));
if ((await store.listFacilities()).length) {
  console.log('Database already has data; not seeding.');
  process.exit(0);
}
const north = await store.saveFacility({ name: 'North Clinic', timezone: 'America/New_York' });
const west = await store.saveFacility({ name: 'West Campus', timezone: 'America/Los_Angeles' });
const nurses = [];
for (const name of ['Ana Ruiz', 'Ben Okafor', 'Cara Lin', 'Dev Patel']) nurses.push(await store.saveNurse({ name }));
const [ana, ben, cara, dev] = nurses;
await store.saveRequirement({ facility_id: north.id, label: 'Day shift', weekdays: [1, 2, 3, 4, 5], start_time: '07:00', end_time: '19:00', min_nurses: 1 });

const week = startOfWeek(todayIn('America/New_York'));
const base = { hours_specified: true, type: 'regular', status: 'confirmed', notes: '' };
await store.createSeries({ ...base, facility_id: north.id, nurse_id: ana.id, start_time: '07:00', end_time: '19:00',
  recurrence: { start_date: addDays(week, 1), interval_weeks: 1, weekdays: [1, 3], end_type: 'never' } });
await store.createSeries({ ...base, facility_id: north.id, nurse_id: ben.id, start_time: '07:00', end_time: '19:00',
  recurrence: { start_date: addDays(week, 2), interval_weeks: 2, weekdays: [2, 4], end_type: 'count', count: 12 } });
await store.createSeries({ ...base, facility_id: west.id, nurse_id: cara.id, start_time: '19:00', end_time: '07:00', end_offset: 1,
  recurrence: { start_date: addDays(week, 5), interval_weeks: 1, weekdays: [5], end_type: 'never' } });
await store.createShifts({ ...base, facility_id: north.id, nurse_id: null, status: 'unfilled', start_time: '07:00', end_time: '19:00', dates: [addDays(week, 12)] });
await store.createShifts({ ...base, facility_id: west.id, nurse_id: dev.id, type: 'coverage', covering_for_id: cara.id, status: 'tentative', hours_specified: false, dates: [addDays(week, 9)] });
console.log('Seeded demo data.');
await store.db.close();
