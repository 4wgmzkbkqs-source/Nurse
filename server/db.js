import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS nurses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
-- One-time assignments (including coverage and exceptions materialised as
-- independent shifts).
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  nurse_id INTEGER REFERENCES nurses(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  hours_specified INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  covering_for_id INTEGER REFERENCES nurses(id),
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  vacated INTEGER NOT NULL DEFAULT 0,
  covers_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS shifts_date ON shifts(start_date);
CREATE INDEX IF NOT EXISTS shifts_covers ON shifts(covers_ref);
-- Recurring schedules: one row per series, never one row per occurrence.
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  nurse_id INTEGER REFERENCES nurses(id),
  start_time TEXT,
  end_time TEXT,
  end_offset INTEGER NOT NULL DEFAULT 0,
  hours_specified INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  covering_for_id INTEGER REFERENCES nurses(id),
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  start_date TEXT NOT NULL,
  interval_weeks INTEGER NOT NULL DEFAULT 1,
  weekdays TEXT NOT NULL,
  end_type TEXT NOT NULL DEFAULT 'never',
  until_date TEXT,
  count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Per-occurrence exceptions: cancelled or modified (overrides JSON).
CREATE TABLE IF NOT EXISTS series_exceptions (
  id INTEGER PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  overrides TEXT NOT NULL DEFAULT '{}',
  UNIQUE(series_id, occurrence_date)
);
CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  weekdays TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  min_nurses INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
