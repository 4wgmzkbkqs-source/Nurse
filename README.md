# Nurse Schedule

A nursing schedule and coverage calendar. The calendar is the main workspace: click a date to add a shift, mark coverage, and see open shifts and staffing gaps.

## Running

Requires Node.js 22.13 or later. Locally, data is stored with the built-in `node:sqlite`. The only npm dependency is `pg`, which is used for hosted Postgres.

```sh
npm install
npm start            # http://localhost:3000, data in data/schedule.db
npm run seed         # optional demo data (only into an empty database)
npm test             # unit + API tests
npm run test:e2e     # browser walkthrough (needs Playwright + Chromium)
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` or `POSTGRES_URL` | unset | Postgres connection string. When set, it is used instead of SQLite |
| `DB_FILE` | `data/schedule.db` | SQLite database file |
| `APP_USER`, `APP_PASSWORD` | unset | Optional. When both are set, the app asks for this username and password |

## Deploying to Vercel (with Supabase)

1. In Vercel, choose **Add New → Project** and import this GitHub repository. Leave the build settings alone: `vercel.json` supplies them.
2. In the project's **Storage** tab, create or connect a **Supabase** database. This adds `POSTGRES_URL` and related variables to the project.
3. Redeploy. On the first request the app creates its tables in a separate `nurse_schedule` schema. That schema is not exposed through Supabase's public data API.

Open the deployment URL and add your facilities and nurses. No sign-in is required: anyone with the URL can view and edit the schedule. To require a shared username and password, add `APP_USER` and `APP_PASSWORD` under **Settings → Environment Variables** and redeploy. To load demo data instead, run `POSTGRES_URL=... npm run seed` once from your computer.

How it works: `npm run build` copies `public/` and `shared/` into `dist/`, which Vercel serves as static files. Every `/api/*` request is routed to the single function in `api/index.js`.

To run the tests against Postgres, set `TEST_DATABASE_URL=postgres://...` for `npm test`, or `E2E_DATABASE_URL` for `npm run test:e2e`. Both reset the `nurse_schedule` schema.

## Features

- **Calendar**: month (default), week and agenda views, with Today, previous/next and a date picker. Filter by facility and nurse. Entries show the hours, nurse, facility and a type label (Regular, Coverage, Unfilled, Released, Tentative), each with its own color.
- **Quick entry**: click a date or **+ Add shift**. The form covers facility, status (confirmed, tentative, unfilled), nurse, type (regular or coverage), an optional "covering for" nurse, dates, hours (or "hours not specified"), notes and an optional repeat. The form remembers the last facility and the last hours used at each facility, and offers your most common hours as presets. For an overnight shift, set the end to the next day explicitly.
- **Several dates at once**: use **Select days** on the calendar, or **+ Add another date** in the form.
- **Recurring schedules**: weekly, every other week or every X weeks on chosen weekdays. A series can end on a date, after N occurrences, or never. The form shows a plain-language summary before you save. When you edit or delete an occurrence, you choose this occurrence, this and future occurrences, or the entire series.
- **Coverage**: use **Assign coverage** on any shift to pick a replacement nurse. The original nurse is marked *released* and recorded as "covering for", and is no longer counted on that shift. Partial coverage is supported: any part still uncovered is shown as unfilled. You can also create a coverage assignment directly, without an existing shift. **Duplicate** copies an assignment to another date.
- **Overlap warnings**: the app checks the same nurse across all facilities, using real instants, so overnight shifts and different timezones are handled. You can save anyway after confirming.
- **Needs attention**: a side list of upcoming unfilled or released-but-uncovered shifts, and of unmet coverage requirements.
- **Coverage requirements** (optional, under Setup): set the facility, weekdays, time window (which may run overnight) and minimum number of nurses. Only confirmed assignments count toward a requirement. When tentative assignments would fill a gap, the day is shown as *Tentative* rather than *Staffed*. Days with no requirement are never treated as gaps.
- **Setup**: nurses (active or inactive; inactive nurses keep their history), facilities (each with its own timezone), and requirements.

## Design notes

- **Recurring storage**: one row per series in `series`, plus per-occurrence rows in `series_exceptions` (cancelled, or overrides stored as JSON). Occurrences are expanded on demand for the requested date range, so no unbounded rows are generated. An exception stores only the fields that differ from the series, so editing the entire series later keeps one-off changes (for example a different nurse on one day).
- **This and future**: the original series is ended the day before, and a new series starts at the chosen occurrence. Later exceptions and coverage links move to the new series. For count-based series, the remaining count carries over.
- **Time**: dates and times are stored as wall-clock values in the facility's timezone. They are converted to UTC instants only for overlap and coverage maths. As a result, an 8:00 AM shift stays 8:00 AM across daylight saving changes, and an overnight shift on the fall-back night counts as 13 real hours. A wall-clock time that doesn't exist (inside the spring-forward gap) moves forward an hour.
- **Unspecified hours** never count as 24-hour coverage and do not satisfy time-window requirements. An overlap with them is reported as a *possible* conflict.
- The scheduling logic lives in `shared/` (pure ES modules). The server, the browser and the tests all use the same code.

## Layout

```
server/   index.js (HTTP + routing), store.js (operations), db.js (SQLite/Postgres adapters + schema)
api/      index.js (Vercel function entry)
shared/   time.js (dates/timezones), recurrence.js (rules/summary), schedule.js (expansion, coverage, overlaps, requirements)
public/   index.html, styles.css, app.js (vanilla JS UI)
test/     node:test suites
scripts/  seed.js, e2e.js, build.js (static build for Vercel)
```

## Limitations

- Built for a single team. By default there is no sign-in; optionally, one shared username and password (`APP_USER` / `APP_PASSWORD`). There are no per-user accounts or roles.
- An individual occurrence can be moved by at most 31 days.
- If an entire-series edit changes the weekdays, exceptions on dates that are no longer in the pattern stop applying.
- The every-other-week phase is anchored to the Sunday-starting week of the series start date.
