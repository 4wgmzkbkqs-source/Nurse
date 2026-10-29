// Data access and scheduling operations. All writes go through here so the
// HTTP layer and the tests exercise the same code.

import { tx } from './db.js';
import { addDays, diffDays, isValidDate, isValidTimeZone, isValidTime, formatDateShort, formatTime } from '../shared/time.js';
import { validateRule, countBefore, isOccurrence, lastOccurrence } from '../shared/recurrence.js';
import {
  buildOccurrences, expandSeries, seriesTemplate, seriesRule, parseOccurrenceId, shiftToOccurrence,
  findOverlaps, openShifts, evaluateRequirements, coverageStatus, isOpen, validateAssignment, isWorking, OVERRIDABLE,
  withInstants,
} from '../shared/schedule.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const bad = (msg) => new HttpError(400, msg);
const notFound = (what) => new HttpError(404, `${what} not found.`);

const FIELD_KEYS = ['facility_id', 'nurse_id', 'start_time', 'end_time', 'end_offset', 'hours_specified',
  'type', 'covering_for_id', 'notes', 'status'];
const MAX_MOVE_DAYS = 31;
const OVERLAP_HORIZON_DAYS = 366;

const toInt = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Normalise assignment fields from a request body.
export function normalizeFields(body) {
  const hours_specified = body.hours_specified !== false && body.hours_specified !== 0;
  const status = body.status || 'confirmed';
  const f = {
    facility_id: toInt(body.facility_id),
    nurse_id: status === 'unfilled' ? null : toInt(body.nurse_id),
    start_time: hours_specified ? body.start_time || null : null,
    end_time: hours_specified ? body.end_time || null : null,
    end_offset: hours_specified ? Number(body.end_offset) || 0 : 0,
    hours_specified,
    type: body.type || 'regular',
    covering_for_id: toInt(body.covering_for_id),
    notes: String(body.notes || '').slice(0, 2000),
    status,
  };
  return f;
}

function normalizeRule(r, fallbackStart) {
  const rule = {
    start_date: r.start_date || fallbackStart,
    interval_weeks: Number(r.interval_weeks) || 1,
    weekdays: (r.weekdays || []).map(Number),
    end_type: r.end_type || 'never',
    until_date: r.end_type === 'until' ? r.until_date : null,
    count: r.end_type === 'count' ? Number(r.count) : null,
  };
  const errs = validateRule(rule);
  if (errs.length) throw bad(errs.join(' '));
  return rule;
}

function rowFacility(r) { return r && { ...r, active: !!r.active }; }
function rowNurse(r) { return r && { ...r, active: !!r.active }; }
function rowSeries(r) {
  return r && {
    ...r,
    hours_specified: !!r.hours_specified,
    weekdays: r.weekdays.split(',').filter(Boolean).map(Number),
  };
}
function rowException(r) {
  return { ...r, cancelled: !!r.cancelled, overrides: JSON.parse(r.overrides || '{}') };
}
function rowRequirement(r) {
  return { ...r, active: !!r.active, weekdays: r.weekdays.split(',').filter(Boolean).map(Number) };
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  // --- Facilities, nurses, requirements ------------------------------------

  listFacilities() {
    return this.db.prepare('SELECT * FROM facilities ORDER BY name').all().map(rowFacility);
  }

  getFacility(id) {
    return rowFacility(this.db.prepare('SELECT * FROM facilities WHERE id = ?').get(id));
  }

  saveFacility(body, id = null) {
    const name = String(body.name || '').trim();
    if (!name) throw bad('Facility name is required.');
    const timezone = body.timezone || 'America/New_York';
    if (!isValidTimeZone(timezone)) throw bad('Unknown timezone.');
    const color = body.color || null;
    const active = body.active === false ? 0 : 1;
    if (id) {
      if (!this.getFacility(id)) throw notFound('Facility');
      this.db.prepare('UPDATE facilities SET name=?, timezone=?, color=?, active=? WHERE id=?')
        .run(name, timezone, color, active, id);
      return this.getFacility(id);
    }
    const r = this.db.prepare('INSERT INTO facilities (name, timezone, color, active) VALUES (?,?,?,?)')
      .run(name, timezone, color, active);
    return this.getFacility(Number(r.lastInsertRowid));
  }

  listNurses() {
    return this.db.prepare('SELECT * FROM nurses ORDER BY active DESC, name').all().map(rowNurse);
  }

  getNurse(id) {
    return rowNurse(this.db.prepare('SELECT * FROM nurses WHERE id = ?').get(id));
  }

  saveNurse(body, id = null) {
    const name = String(body.name || '').trim();
    if (!name) throw bad('Nurse name is required.');
    const active = body.active === false ? 0 : 1;
    if (id) {
      if (!this.getNurse(id)) throw notFound('Nurse');
      this.db.prepare('UPDATE nurses SET name=?, active=? WHERE id=?').run(name, active, id);
      return this.getNurse(id);
    }
    const r = this.db.prepare('INSERT INTO nurses (name, active) VALUES (?, ?)').run(name, active);
    return this.getNurse(Number(r.lastInsertRowid));
  }

  listRequirements() {
    return this.db.prepare('SELECT * FROM requirements ORDER BY facility_id, start_time').all().map(rowRequirement);
  }

  saveRequirement(body, id = null) {
    const facility_id = toInt(body.facility_id);
    if (!this.getFacility(facility_id)) throw bad('Choose a facility.');
    const weekdays = [...new Set((body.weekdays || []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    if (!weekdays.length) throw bad('Select at least one weekday.');
    if (!isValidTime(body.start_time) || !isValidTime(body.end_time)) throw bad('Enter a valid time window.');
    const min = Number(body.min_nurses);
    if (!Number.isInteger(min) || min < 1 || min > 50) throw bad('Minimum nurses must be between 1 and 50.');
    const vals = [facility_id, String(body.label || '').slice(0, 100), weekdays.join(','), body.start_time,
      body.end_time, min, body.active === false ? 0 : 1];
    if (id) {
      const r = this.db.prepare(`UPDATE requirements SET facility_id=?, label=?, weekdays=?, start_time=?,
        end_time=?, min_nurses=?, active=? WHERE id=?`).run(...vals, id);
      if (!r.changes) throw notFound('Requirement');
      return rowRequirement(this.db.prepare('SELECT * FROM requirements WHERE id=?').get(id));
    }
    const r = this.db.prepare(`INSERT INTO requirements (facility_id, label, weekdays, start_time, end_time,
      min_nurses, active) VALUES (?,?,?,?,?,?,?)`).run(...vals);
    return rowRequirement(this.db.prepare('SELECT * FROM requirements WHERE id=?').get(Number(r.lastInsertRowid)));
  }

  deleteRequirement(id) {
    this.db.prepare('DELETE FROM requirements WHERE id=?').run(id);
  }

  // --- Raw loading -----------------------------------------------------------

  getShift(id) {
    const r = this.db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    return r && { ...r, hours_specified: !!r.hours_specified, vacated: !!r.vacated };
  }

  getSeries(id) {
    return rowSeries(this.db.prepare('SELECT * FROM series WHERE id = ?').get(id));
  }

  getExceptions(seriesId) {
    return this.db.prepare('SELECT * FROM series_exceptions WHERE series_id = ? ORDER BY occurrence_date')
      .all(seriesId).map(rowException);
  }

  loadRaw(from, to) {
    const shifts = this.db.prepare('SELECT * FROM shifts WHERE start_date BETWEEN ? AND ?').all(from, to);
    const series = this.db.prepare(`SELECT * FROM series WHERE start_date <= ?
      AND NOT (end_type = 'until' AND until_date < ?)`).all(addDays(to, MAX_MOVE_DAYS), addDays(from, -MAX_MOVE_DAYS))
      .map(rowSeries);
    let exceptions = [];
    if (series.length) {
      const ids = series.map((s) => s.id);
      exceptions = this.db.prepare(`SELECT * FROM series_exceptions WHERE series_id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids).map(rowException);
    }
    return { shifts, series, exceptions, facilities: this.listFacilities() };
  }

  occurrences(from, to) {
    return buildOccurrences(this.loadRaw(from, to), from, to);
  }

  tzOf(facilityId) {
    const f = this.getFacility(facilityId);
    return f ? f.timezone : 'UTC';
  }

  // Find a single occurrence by id ('s:12' or 'r:3:2026-11-02').
  getOccurrence(id) {
    const ref = parseOccurrenceId(id);
    if (!ref) throw bad('Invalid occurrence id.');
    if (ref.source === 'shift') {
      const s = this.getShift(ref.shift_id);
      if (!s) throw notFound('Shift');
      return { ref, occ: shiftToOccurrence(s, this.tzOf(s.facility_id)) };
    }
    const series = this.getSeries(ref.series_id);
    if (!series) throw notFound('Recurring schedule');
    if (!isOccurrence(seriesRule(series), ref.occurrence_date)) throw notFound('Occurrence');
    const exceptions = this.getExceptions(series.id).filter((e) => e.occurrence_date === ref.occurrence_date);
    if (exceptions[0] && exceptions[0].cancelled) throw notFound('Occurrence');
    // Expand the occurrence regardless of where an exception moved it.
    const moved = exceptions[0]?.overrides?.date;
    const lo = moved && moved < ref.occurrence_date ? moved : ref.occurrence_date;
    const hi = moved && moved > ref.occurrence_date ? moved : ref.occurrence_date;
    const occ = expandSeries(series, exceptions, lo, hi, (fid) => this.tzOf(fid))
      .find((o) => o.occurrence_date === ref.occurrence_date);
    if (!occ) throw notFound('Occurrence');
    return { ref, occ, series, exception: exceptions[0] || null };
  }

  // --- Schedule queries --------------------------------------------------------

  schedule(from, to, filters = {}) {
    // Pad by a day so overnight shifts and their coverage are evaluated fully.
    const all = this.occurrences(addDays(from, -1), addDays(to, 1));
    const inRange = all.filter((o) => o.date >= from && o.date <= to);
    // Coverage state for every unfilled or released shift, including fully
    // covered ones, so the UI can show who covers and what remains open.
    const coverage = {};
    for (const o of inRange) {
      if (isOpen(o)) coverage[o.id] = serializeCoverage(coverageStatus(o, all));
    }
    const requirements = evaluateRequirements(this.listRequirements(), all, this.listFacilities(), from, to);
    let occs = inRange;
    if (filters.facility_id) {
      occs = occs.filter((o) => o.facility_id === filters.facility_id);
    }
    if (filters.nurse_id) {
      occs = occs.filter((o) => o.nurse_id === filters.nurse_id || o.covering_for_id === filters.nurse_id);
    }
    return {
      occurrences: occs.map(serializeOccurrence),
      coverage,
      requirements: requirements
        .filter((r) => !filters.facility_id || r.facility_id === filters.facility_id)
        .map(serializeRequirement),
    };
  }

  // Upcoming items that need attention: open shifts and unmet requirements.
  attention(from, days = 60) {
    const to = addDays(from, days);
    const all = this.occurrences(addDays(from, -1), addDays(to, 1));
    const open = openShifts(all)
      .filter((x) => x.occurrence.date >= from && x.occurrence.date <= to)
      .map((x) => ({ occurrence: serializeOccurrence(x.occurrence), ...serializeCoverage(x) }));
    const reqs = evaluateRequirements(this.listRequirements(), all, this.listFacilities(), from, to)
      .filter((r) => !r.met)
      .map(serializeRequirement);
    return { open, requirements: reqs };
  }

  // Most common hours used at a facility (for quick-entry presets).
  presets(facilityId) {
    const rows = this.db.prepare(`
      SELECT start_time, end_time, (julianday(end_date) - julianday(start_date)) AS end_offset, COUNT(*) AS n
      FROM shifts WHERE facility_id = ? AND hours_specified = 1 GROUP BY 1,2,3
      UNION ALL
      SELECT start_time, end_time, end_offset, COUNT(*) * 3 AS n
      FROM series WHERE facility_id = ? AND hours_specified = 1 GROUP BY 1,2,3`).all(facilityId, facilityId);
    const map = new Map();
    for (const r of rows) {
      const key = `${r.start_time}|${r.end_time}|${Math.round(r.end_offset)}`;
      map.set(key, (map.get(key) || 0) + r.n);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => {
      const [start_time, end_time, off] = k.split('|');
      return { start_time, end_time, end_offset: Number(off) };
    });
  }

  // --- Validation helpers ------------------------------------------------------

  checkRefs(f) {
    const fac = this.getFacility(f.facility_id);
    if (!fac) throw bad('Choose a facility.');
    if (f.nurse_id && !this.getNurse(f.nurse_id)) throw bad('Unknown nurse.');
    if (f.covering_for_id && !this.getNurse(f.covering_for_id)) throw bad('Unknown “covering for” nurse.');
    const errs = validateAssignment(f);
    if (errs.length) throw bad(errs.join(' '));
    return fac;
  }

  // Build a proposed occurrence (not yet saved) for overlap checks.
  proposedOccurrence(f, date, id) {
    return withInstants({
      id, date, end_date: addDays(date, f.end_offset || 0),
      start_time: f.start_time, end_time: f.end_time, hours_specified: f.hours_specified,
      facility_id: f.facility_id, nurse_id: f.nurse_id, status: f.status, vacated: false,
      series_id: null,
    }, this.tzOf(f.facility_id));
  }

  // Throws 409 with conflict details unless `force` is set.
  assertNoOverlaps(proposed, opts, force) {
    const active = proposed.filter(isWorking);
    if (!active.length || force) return;
    const dates = active.map((p) => p.date).sort();
    const existing = this.occurrences(addDays(dates[0], -1), addDays(dates[dates.length - 1], 2));
    const conflicts = findOverlaps(active, existing, opts);
    if (conflicts.length) {
      const nurses = new Map(this.listNurses().map((n) => [n.id, n.name]));
      const facilities = new Map(this.listFacilities().map((f) => [f.id, f.name]));
      throw new HttpError(409, 'Overlapping assignment', {
        conflicts: conflicts.slice(0, 20).map((c) => ({
          kind: c.kind,
          nurse: nurses.get(c.proposed.nurse_id),
          proposed: describeOcc(c.proposed, facilities),
          existing: describeOcc(c.existing, facilities),
          existing_id: c.existing.id,
        })),
        total: conflicts.length,
      });
    }
  }

  // --- One-time shifts ----------------------------------------------------------

  createShifts(body) {
    const f = normalizeFields(body);
    this.checkRefs(f);
    const dates = [...new Set(body.dates || (body.date ? [body.date] : []))].sort();
    if (!dates.length) throw bad('Choose at least one date.');
    if (dates.length > 366) throw bad('Too many dates selected.');
    for (const d of dates) if (!isValidDate(d)) throw bad(`Invalid date: ${d}`);
    const covers_ref = body.covers_ref || null;
    const proposed = dates.map((d, i) => this.proposedOccurrence(f, d, `new:${i}`));
    this.assertNoOverlaps(proposed, {}, body.force);
    return tx(this.db, () => dates.map((d) => this.insertShift(f, d, covers_ref)));
  }

  insertShift(f, date, covers_ref = null, vacated = false) {
    const r = this.db.prepare(`INSERT INTO shifts (facility_id, nurse_id, start_date, end_date, start_time,
      end_time, hours_specified, type, covering_for_id, notes, status, vacated, covers_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.facility_id, f.nurse_id, date, addDays(date, f.end_offset || 0), f.start_time, f.end_time,
      f.hours_specified ? 1 : 0, f.type, f.covering_for_id, f.notes, f.status, vacated ? 1 : 0, covers_ref);
    return `s:${r.lastInsertRowid}`;
  }

  // --- Recurring series --------------------------------------------------------

  createSeries(body) {
    const f = normalizeFields(body);
    this.checkRefs(f);
    const rule = normalizeRule(body.recurrence || {}, body.date);
    this.assertSeriesOverlaps(f, rule, null, body.force);
    return tx(this.db, () => this.insertSeries(f, rule));
  }

  insertSeries(f, rule) {
    const r = this.db.prepare(`INSERT INTO series (facility_id, nurse_id, start_time, end_time, end_offset,
      hours_specified, type, covering_for_id, notes, status, start_date, interval_weeks, weekdays, end_type,
      until_date, count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.facility_id, f.nurse_id, f.start_time, f.end_time, f.end_offset || 0, f.hours_specified ? 1 : 0,
      f.type, f.covering_for_id, f.notes, f.status, rule.start_date, rule.interval_weeks,
      rule.weekdays.join(','), rule.end_type, rule.until_date, rule.count);
    return Number(r.lastInsertRowid);
  }

  assertSeriesOverlaps(f, rule, excludeSeriesId, force) {
    if (force || f.status === 'unfilled' || !f.nurse_id) return;
    const pseudo = { id: -1, ...f, ...rule };
    const last = lastOccurrence(rule);
    const horizon = addDays(rule.start_date, OVERLAP_HORIZON_DAYS);
    const to = last && last < horizon ? last : horizon;
    const proposed = expandSeries(pseudo, [], rule.start_date, to, (fid) => this.tzOf(fid))
      .map((o) => ({ ...o, series_id: null }));
    this.assertNoOverlaps(proposed, { excludeSeriesId }, false);
  }

  // --- Editing ------------------------------------------------------------------

  // scope: 'this' | 'future' | 'all' (series only)
  updateOccurrence(id, body) {
    const { ref, occ, series, exception } = this.getOccurrence(id);
    const f = normalizeFields(body);
    this.checkRefs(f);
    const date = body.date || occ.date;
    if (!isValidDate(date)) throw bad('Invalid date.');

    if (ref.source === 'shift') {
      const proposed = this.proposedOccurrence(f, date, occ.id);
      this.assertNoOverlaps([proposed], { excludeIds: [occ.id] }, body.force);
      this.db.prepare(`UPDATE shifts SET facility_id=?, nurse_id=?, start_date=?, end_date=?, start_time=?,
        end_time=?, hours_specified=?, type=?, covering_for_id=?, notes=?, status=?, updated_at=datetime('now')
        WHERE id=?`).run(f.facility_id, f.nurse_id, date, addDays(date, f.end_offset), f.start_time, f.end_time,
        f.hours_specified ? 1 : 0, f.type, f.covering_for_id, f.notes, f.status, ref.shift_id);
      return { id: occ.id };
    }

    const scope = body.scope || 'this';
    const current = occurrenceFields(occ);
    const next = { ...f, date };
    const changes = {};
    for (const k of [...FIELD_KEYS, 'date']) if (!sameVal(current[k], next[k])) changes[k] = next[k];
    const ruleChange = body.recurrence ? normalizeRule(body.recurrence, series.start_date) : null;

    if (scope === 'this') {
      if (ruleChange && !sameRule(ruleChange, seriesRule(series))) {
        throw bad('Repeat settings can only be changed for this and future occurrences or the entire series.');
      }
      if (changes.date && Math.abs(diffDays(changes.date, ref.occurrence_date)) > MAX_MOVE_DAYS) {
        throw bad(`An occurrence can be moved by at most ${MAX_MOVE_DAYS} days.`);
      }
      const proposed = this.proposedOccurrence(f, date, occ.id);
      this.assertNoOverlaps([proposed], { excludeIds: [occ.id] }, body.force);
      const template = seriesTemplate(series, ref.occurrence_date);
      const overrides = { ...(exception?.overrides || {}), ...changes };
      for (const k of Object.keys(overrides)) {
        if (k !== 'vacated' && sameVal(overrides[k], template[k])) delete overrides[k];
      }
      if (overrides.vacated === false) delete overrides.vacated;
      tx(this.db, () => {
        if (Object.keys(overrides).length) this.upsertException(series.id, ref.occurrence_date, overrides);
        else if (exception) this.db.prepare('DELETE FROM series_exceptions WHERE id=?').run(exception.id);
      });
      return { id: occ.id };
    }

    if (changes.date) throw bad('Moving a date applies to this occurrence only.');
    if (!['future', 'all'].includes(scope)) throw bad('Invalid scope.');
    const oldRule = seriesRule(series);
    const splitAt = ref.occurrence_date;
    const isFuture = scope === 'future' && countBefore(oldRule, splitAt) > 0;
    const template = { ...seriesTemplate(series, splitAt), ...changes };
    delete template.date;
    let rule = ruleChange || oldRule;
    if (isFuture) {
      rule = { ...rule, start_date: splitAt };
      if (rule.end_type === 'count') {
        // Count is the total for the original series; keep the remainder.
        rule.count = Math.max(1, rule.count - countBefore(oldRule, splitAt));
      }
      if (rule.end_type === 'until' && rule.until_date < splitAt) throw bad('End date must be after this occurrence.');
      if (!isOccurrence(rule, splitAt) && !ruleChange) throw bad('Cannot split the series here.');
    }
    const ruleErrs = validateRule(rule);
    if (ruleErrs.length) throw bad(ruleErrs.join(' '));
    this.assertSeriesOverlaps(template, rule, series.id, body.force);

    return tx(this.db, () => {
      // The edited occurrence's own overrides yield to the explicit changes.
      if (exception && !exception.cancelled) {
        const ov = { ...exception.overrides };
        for (const k of Object.keys(changes)) delete ov[k];
        if (Object.keys(ov).length) this.upsertException(series.id, splitAt, ov);
        else this.db.prepare('DELETE FROM series_exceptions WHERE id=?').run(exception.id);
      }
      if (!isFuture) {
        this.db.prepare(`UPDATE series SET facility_id=?, nurse_id=?, start_time=?, end_time=?, end_offset=?,
          hours_specified=?, type=?, covering_for_id=?, notes=?, status=?, start_date=?, interval_weeks=?,
          weekdays=?, end_type=?, until_date=?, count=?, updated_at=datetime('now') WHERE id=?`).run(
          template.facility_id, template.nurse_id, template.start_time, template.end_time, template.end_offset || 0,
          template.hours_specified ? 1 : 0, template.type, template.covering_for_id, template.notes,
          template.status, rule.start_date, rule.interval_weeks, rule.weekdays.join(','), rule.end_type,
          rule.until_date, rule.count, series.id);
        return { id: `r:${series.id}:${splitAt}`, series_id: series.id };
      }
      // Split: the original series ends the day before; past occurrences and
      // their exceptions are untouched.
      this.endSeriesBefore(series.id, splitAt);
      const newId = this.insertSeries(template, rule);
      this.db.prepare('UPDATE series_exceptions SET series_id=? WHERE series_id=? AND occurrence_date >= ?')
        .run(newId, series.id, splitAt);
      this.remapCoversRefs(series.id, newId, splitAt);
      return { id: `r:${newId}:${splitAt}`, series_id: newId };
    });
  }

  endSeriesBefore(seriesId, date) {
    this.db.prepare(`UPDATE series SET end_type='until', until_date=?, count=NULL, updated_at=datetime('now')
      WHERE id=?`).run(addDays(date, -1), seriesId);
  }

  remapCoversRefs(oldId, newId, fromDate) {
    const prefix = `r:${oldId}:`;
    const rows = this.db.prepare('SELECT id, covers_ref FROM shifts WHERE covers_ref LIKE ?').all(`${prefix}%`);
    const upd = this.db.prepare('UPDATE shifts SET covers_ref=? WHERE id=?');
    for (const r of rows) {
      const d = r.covers_ref.slice(prefix.length);
      if (d >= fromDate) upd.run(newId == null ? null : `r:${newId}:${d}`, r.id);
    }
  }

  upsertException(seriesId, date, overrides, cancelled = false) {
    this.db.prepare(`INSERT INTO series_exceptions (series_id, occurrence_date, cancelled, overrides)
      VALUES (?,?,?,?) ON CONFLICT(series_id, occurrence_date)
      DO UPDATE SET cancelled=excluded.cancelled, overrides=excluded.overrides`)
      .run(seriesId, date, cancelled ? 1 : 0, JSON.stringify(overrides));
  }

  deleteOccurrence(id, scope = 'this') {
    const { ref, occ, series } = this.getOccurrence(id);
    return tx(this.db, () => {
      const unlink = this.db.prepare('UPDATE shifts SET covers_ref=NULL WHERE covers_ref=?');
      if (ref.source === 'shift') {
        unlink.run(occ.id);
        this.db.prepare('DELETE FROM shifts WHERE id=?').run(ref.shift_id);
        return { deleted: 1 };
      }
      const splitAt = ref.occurrence_date;
      if (scope === 'this') {
        unlink.run(occ.id);
        this.upsertException(series.id, splitAt, {}, true);
        return { deleted: 1 };
      }
      if (scope === 'future' && countBefore(seriesRule(series), splitAt) > 0) {
        this.endSeriesBefore(series.id, splitAt);
        this.db.prepare('DELETE FROM series_exceptions WHERE series_id=? AND occurrence_date >= ?').run(series.id, splitAt);
        this.remapCoversRefs(series.id, null, splitAt);
        return { deleted: 'future' };
      }
      if (scope !== 'future' && scope !== 'all') throw bad('Invalid scope.');
      this.remapCoversRefs(series.id, null, '0000-00-00');
      this.db.prepare('DELETE FROM series_exceptions WHERE series_id=?').run(series.id);
      this.db.prepare('DELETE FROM series WHERE id=?').run(series.id);
      return { deleted: 'all' };
    });
  }

  // --- Coverage -----------------------------------------------------------------

  // Assign a replacement nurse to (part of) an existing occurrence. The
  // original nurse is released (not counted as working) and recorded as
  // "covering for" on the new coverage assignment.
  assignCoverage(id, body) {
    const { ref, occ, series, exception } = this.getOccurrence(id);
    const f = normalizeFields({
      ...body,
      facility_id: occ.facility_id,
      type: 'coverage',
      covering_for_id: occ.nurse_id && occ.nurse_id !== toInt(body.nurse_id) ? occ.nurse_id : null,
    });
    if (f.status === 'unfilled' || !f.nurse_id) throw bad('Choose the replacement nurse.');
    if (f.nurse_id === occ.nurse_id && isWorking(occ)) throw bad('Choose a different nurse than the one already assigned.');
    this.checkRefs(f);
    const date = body.date || occ.date;
    if (!isValidDate(date)) throw bad('Invalid date.');
    const proposed = this.proposedOccurrence(f, date, 'new:cov');
    if (occ.start_utc != null) {
      if (proposed.start_utc == null) {
        // Unspecified hours on the coverage means the whole shift.
        f.hours_specified = true;
        f.start_time = occ.start_time;
        f.end_time = occ.end_time;
        f.end_offset = diffDays(occ.end_date, occ.date);
        return this.assignCoverage(id, { ...body, ...f, date: occ.date });
      }
      if (proposed.start_utc < occ.start_utc || proposed.end_utc > occ.end_utc) {
        throw bad('Coverage hours must fall within the original shift.');
      }
    }
    this.assertNoOverlaps([this.proposedOccurrence(f, date, 'new:cov')], { excludeIds: [occ.id] }, body.force);
    return tx(this.db, () => {
      if (isWorking(occ)) this.setVacated(ref, series, exception, true);
      const newId = this.insertShift(f, date, occ.id);
      return { id: newId, covers: occ.id };
    });
  }

  setVacated(ref, series, exception, vacated) {
    if (ref.source === 'shift') {
      this.db.prepare(`UPDATE shifts SET vacated=?, updated_at=datetime('now') WHERE id=?`).run(vacated ? 1 : 0, ref.shift_id);
      return;
    }
    const overrides = { ...(exception?.overrides || {}) };
    if (vacated) overrides.vacated = true;
    else delete overrides.vacated;
    if (!Object.keys(overrides).length && exception) {
      this.db.prepare('DELETE FROM series_exceptions WHERE id=?').run(exception.id);
    } else if (Object.keys(overrides).length) {
      this.upsertException(series.id, ref.occurrence_date, overrides);
    }
  }

  // Undo a release: the original nurse works the shift again. Coverage
  // assignments linked to it are kept but unlinked (and may then overlap).
  restoreOccurrence(id) {
    const { ref, occ, series, exception } = this.getOccurrence(id);
    if (!occ.vacated) return { id };
    tx(this.db, () => this.setVacated(ref, series, exception, false));
    return { id };
  }
}

// --- Serialisation helpers ---------------------------------------------------

function sameVal(a, b) {
  const na = a === undefined || a === '' ? null : a;
  const nb = b === undefined || b === '' ? null : b;
  return na === nb;
}

function sameRule(a, b) {
  return a.start_date === b.start_date && Number(a.interval_weeks) === Number(b.interval_weeks)
    && [...a.weekdays].sort().join() === [...b.weekdays].sort().join() && a.end_type === b.end_type
    && (a.until_date || null) === (b.until_date || null) && (a.count || null) === (b.count || null);
}

function occurrenceFields(occ) {
  return {
    date: occ.date,
    facility_id: occ.facility_id,
    nurse_id: occ.nurse_id,
    start_time: occ.start_time,
    end_time: occ.end_time,
    end_offset: occ.hours_specified ? diffDays(occ.end_date, occ.date) : 0,
    hours_specified: occ.hours_specified,
    type: occ.type,
    covering_for_id: occ.covering_for_id,
    notes: occ.notes || '',
    status: occ.status,
  };
}

function describeOcc(o, facilities) {
  const hours = o.hours_specified
    ? `${formatTime(o.start_time)}–${formatTime(o.end_time)}${o.end_date !== o.date ? ' (next day)' : ''}`
    : 'hours not specified';
  return { date: o.date, label: `${formatDateShort(o.date)}, ${hours}`, facility: facilities.get(o.facility_id) || '' };
}

export function serializeOccurrence(o) {
  return o;
}

function serializeCoverage(x) {
  return {
    fully_covered: x.fully_covered,
    tentatively_covered: x.tentatively_covered,
    open: x.open,
    hours_specified: x.hours_specified,
    remaining: x.remaining,
    tentative: x.tentative,
    coverers: x.coverers.map((c) => c.id),
  };
}

function serializeRequirement(r) {
  return r;
}

export { OVERRIDABLE };
