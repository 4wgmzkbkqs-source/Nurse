// Scheduling logic shared by server, client and tests: expanding recurring
// series into occurrences, coverage/gap calculations, overlap detection and
// staffing requirement checks. All functions are pure.

import { addDays, diffDays, zonedToUtc, utcToZoned, weekday, timeToMinutes } from './time.js';
import { occurrenceDates, isOccurrence } from './recurrence.js';

export const TYPES = ['regular', 'coverage'];
export const STATUSES = ['confirmed', 'tentative', 'unfilled'];

// Fields an exception may override on a series occurrence.
export const OVERRIDABLE = [
  'date', 'facility_id', 'nurse_id', 'start_time', 'end_time', 'end_offset',
  'hours_specified', 'type', 'covering_for_id', 'notes', 'status', 'vacated',
];

export function seriesRule(series) {
  return {
    start_date: series.start_date,
    interval_weeks: series.interval_weeks,
    weekdays: series.weekdays,
    end_type: series.end_type,
    until_date: series.until_date,
    count: series.count,
  };
}

export function seriesOccurrenceId(seriesId, date) {
  return `r:${seriesId}:${date}`;
}

export function parseOccurrenceId(id) {
  const m = /^s:(\d+)$/.exec(id);
  if (m) return { source: 'shift', shift_id: Number(m[1]) };
  const r = /^r:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (r) return { source: 'series', series_id: Number(r[1]), occurrence_date: r[2] };
  return null;
}

// Attach UTC instants for an occurrence with specified hours.
export function withInstants(occ, tz) {
  if (!occ.hours_specified || !occ.start_time || !occ.end_time) {
    return { ...occ, start_utc: null, end_utc: null };
  }
  const start_utc = zonedToUtc(occ.date, occ.start_time, tz);
  const end_utc = zonedToUtc(occ.end_date, occ.end_time, tz);
  return { ...occ, start_utc, end_utc };
}

export function shiftToOccurrence(shift, tz) {
  return withInstants({
    id: `s:${shift.id}`,
    source: 'shift',
    shift_id: shift.id,
    series_id: null,
    occurrence_date: null,
    recurring: false,
    is_exception: false,
    date: shift.start_date,
    end_date: shift.end_date || shift.start_date,
    start_time: shift.start_time,
    end_time: shift.end_time,
    hours_specified: !!shift.hours_specified,
    facility_id: shift.facility_id,
    nurse_id: shift.nurse_id ?? null,
    type: shift.type,
    covering_for_id: shift.covering_for_id ?? null,
    notes: shift.notes || '',
    status: shift.status,
    vacated: !!shift.vacated,
    covers_ref: shift.covers_ref || null,
  }, tz);
}

// The template values a series occurrence has before exceptions apply.
export function seriesTemplate(series, date) {
  return {
    date,
    facility_id: series.facility_id,
    nurse_id: series.nurse_id ?? null,
    start_time: series.start_time,
    end_time: series.end_time,
    end_offset: series.end_offset || 0,
    hours_specified: !!series.hours_specified,
    type: series.type,
    covering_for_id: series.covering_for_id ?? null,
    notes: series.notes || '',
    status: series.status,
    vacated: false,
  };
}

// Expand a series into occurrences whose (possibly moved) date falls in
// [from, to]. `exceptions` are that series' exception records:
// { occurrence_date, cancelled, overrides }.
export function expandSeries(series, exceptions, from, to, tzOf) {
  const rule = seriesRule(series);
  const excByDate = new Map(exceptions.map((e) => [e.occurrence_date, e]));
  const keys = new Set(occurrenceDates(rule, from, to));
  // Occurrences moved into the range from outside it.
  for (const e of exceptions) {
    const moved = e.overrides && e.overrides.date;
    if (!e.cancelled && moved && moved >= from && moved <= to && !keys.has(e.occurrence_date)
      && isOccurrence(rule, e.occurrence_date)) {
      keys.add(e.occurrence_date);
    }
  }
  const out = [];
  for (const key of [...keys].sort()) {
    const exc = excByDate.get(key);
    if (exc && exc.cancelled) continue;
    const f = { ...seriesTemplate(series, key), ...((exc && exc.overrides) || {}) };
    if (f.date < from || f.date > to) continue;
    out.push(withInstants({
      id: seriesOccurrenceId(series.id, key),
      source: 'series',
      shift_id: null,
      series_id: series.id,
      occurrence_date: key,
      recurring: true,
      is_exception: !!exc,
      date: f.date,
      end_date: addDays(f.date, f.hours_specified ? (f.end_offset || 0) : 0),
      start_time: f.hours_specified ? f.start_time : null,
      end_time: f.hours_specified ? f.end_time : null,
      hours_specified: !!f.hours_specified,
      facility_id: f.facility_id,
      nurse_id: f.nurse_id ?? null,
      type: f.type,
      covering_for_id: f.covering_for_id ?? null,
      notes: f.notes || '',
      status: f.status,
      vacated: !!f.vacated,
      covers_ref: null,
    }, tzOf(f.facility_id)));
  }
  return out;
}

// Build every occurrence with a start date in [from, to].
export function buildOccurrences({ shifts, series, exceptions, facilities }, from, to) {
  const tzById = new Map(facilities.map((f) => [f.id, f.timezone]));
  const tzOf = (id) => tzById.get(id) || 'UTC';
  const out = [];
  for (const s of shifts) {
    if (s.start_date >= from && s.start_date <= to) out.push(shiftToOccurrence(s, tzOf(s.facility_id)));
  }
  const excBySeries = new Map();
  for (const e of exceptions) {
    if (!excBySeries.has(e.series_id)) excBySeries.set(e.series_id, []);
    excBySeries.get(e.series_id).push(e);
  }
  for (const s of series) out.push(...expandSeries(s, excBySeries.get(s.id) || [], from, to, tzOf));
  out.sort(compareOccurrences);
  return out;
}

export function compareOccurrences(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const at = a.hours_specified ? a.start_time : '99:99';
  const bt = b.hours_specified ? b.start_time : '99:99';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// --- Interval helpers (half-open [start, end) in ms) ----------------------

export function mergeIntervals(list) {
  const sorted = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function subtractIntervals(base, cuts) {
  let result = mergeIntervals(base);
  for (const [cs, ce] of mergeIntervals(cuts)) {
    const next = [];
    for (const [s, e] of result) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    result = next;
  }
  return result;
}

export function intersectIntervals(a, b) {
  const out = [];
  for (const [as, ae] of mergeIntervals(a)) {
    for (const [bs, be] of mergeIntervals(b)) {
      const s = Math.max(as, bs);
      const e = Math.min(ae, be);
      if (e > s) out.push([s, e]);
    }
  }
  return mergeIntervals(out);
}

export function totalMs(list) {
  return list.reduce((n, [s, e]) => n + (e - s), 0);
}

// --- Staffing semantics ---------------------------------------------------

// The nurse on this occurrence is actually working it (counts as staff).
export function isWorking(occ) {
  return occ.nurse_id != null && !occ.vacated && occ.status !== 'unfilled';
}

// The occurrence represents a need that someone has to fill: either it was
// created as unfilled, or the assigned nurse was released and needs coverage.
export function isOpen(occ) {
  return occ.status === 'unfilled' || !!occ.vacated;
}

// Compute coverage of an open occurrence by the coverage assignments that
// reference it (covers_ref === occ.id). Returns remaining unfilled segments
// (nobody assigned) and tentative-only segments.
export function coverageStatus(occ, all) {
  const coverers = all.filter((o) => o.covers_ref === occ.id && isWorking(o));
  const confirmed = coverers.filter((o) => o.status === 'confirmed');
  const tentative = coverers.filter((o) => o.status === 'tentative');
  if (!occ.hours_specified || occ.start_utc == null) {
    const filled = confirmed.length > 0;
    return {
      coverers,
      hours_specified: false,
      remaining: [],
      tentative: [],
      fully_covered: filled,
      tentatively_covered: !filled && tentative.length > 0,
      open: !filled && tentative.length === 0,
    };
  }
  const base = [[occ.start_utc, occ.end_utc]];
  const ivs = (list) => list.filter((o) => o.start_utc != null).map((o) => [o.start_utc, o.end_utc]);
  const afterConfirmed = subtractIntervals(base, ivs(confirmed));
  const remaining = subtractIntervals(afterConfirmed, ivs(tentative));
  const tentativeOnly = intersectIntervals(afterConfirmed, ivs(tentative));
  // A coverer with unspecified hours fills the whole shift.
  const unspecConfirmed = confirmed.some((o) => o.start_utc == null);
  const unspecTentative = tentative.some((o) => o.start_utc == null);
  if (unspecConfirmed) {
    return { coverers, hours_specified: true, remaining: [], tentative: [], fully_covered: true, tentatively_covered: false, open: false };
  }
  const rem = unspecTentative ? [] : remaining;
  const tent = unspecTentative ? afterConfirmed : tentativeOnly;
  return {
    coverers,
    hours_specified: true,
    remaining: rem,
    tentative: tent,
    fully_covered: afterConfirmed.length === 0,
    tentatively_covered: afterConfirmed.length > 0 && rem.length === 0,
    open: rem.length > 0,
  };
}

// Open items (unfilled / released shifts with uncovered time).
export function openShifts(occurrences) {
  const out = [];
  for (const occ of occurrences) {
    if (!isOpen(occ)) continue;
    const cov = coverageStatus(occ, occurrences);
    if (cov.fully_covered) continue;
    out.push({ occurrence: occ, ...cov });
  }
  return out;
}

// --- Overlap detection ----------------------------------------------------

// Returns conflicts between `proposed` occurrences and `existing` ones for
// the same nurse, across all facilities. `excludeIds` lists occurrence ids
// to ignore (e.g. the occurrence being edited). Overnight shifts are compared
// by their real UTC instants. If either side has unspecified hours the
// conflict is reported as "possible" when their dates touch.
export function findOverlaps(proposed, existing, { excludeIds = [], excludeSeriesId = null } = {}) {
  const exclude = new Set(excludeIds);
  const conflicts = [];
  for (const p of proposed) {
    if (!isWorking(p)) continue;
    for (const e of existing) {
      if (exclude.has(e.id) || e.id === p.id) continue;
      if (excludeSeriesId != null && e.series_id === excludeSeriesId) continue;
      if (!isWorking(e) || e.nurse_id !== p.nurse_id) continue;
      if (p.start_utc != null && e.start_utc != null) {
        if (p.start_utc < e.end_utc && e.start_utc < p.end_utc) {
          conflicts.push({ kind: 'overlap', proposed: p, existing: e });
        }
      } else if (p.date <= e.end_date && e.date <= p.end_date) {
        conflicts.push({ kind: 'possible', proposed: p, existing: e });
      }
    }
  }
  return conflicts;
}

// --- Coverage requirements ------------------------------------------------

// requirement = { id, facility_id, weekdays: [0..6], start_time, end_time,
//                 min_nurses, active, label }
// A window whose end_time <= start_time ends the next day.
export function requirementWindow(req, date, tz) {
  const overnight = timeToMinutes(req.end_time) <= timeToMinutes(req.start_time);
  const start = zonedToUtc(date, req.start_time, tz);
  const end = zonedToUtc(overnight ? addDays(date, 1) : date, req.end_time, tz);
  return [start, end];
}

// Sweep a window counting confirmed and confirmed+tentative staff.
// Returns segments [{start, end, confirmed, with_tentative}] covering the window.
export function staffingProfile(window, occs) {
  const [ws, we] = window;
  const events = new Map();
  const bump = (t, dc, dt) => {
    const cur = events.get(t) || [0, 0];
    cur[0] += dc; cur[1] += dt;
    events.set(t, cur);
  };
  bump(ws, 0, 0);
  bump(we, 0, 0);
  for (const o of occs) {
    const s = Math.max(ws, o.start_utc);
    const e = Math.min(we, o.end_utc);
    if (e <= s) continue;
    const c = o.status === 'confirmed' ? 1 : 0;
    bump(s, c, 1);
    bump(e, -c, -1);
  }
  const times = [...events.keys()].sort((a, b) => a - b);
  const segs = [];
  let conf = 0;
  let tent = 0;
  for (let i = 0; i < times.length - 1; i++) {
    const [dc, dt] = events.get(times[i]);
    conf += dc; tent += dt;
    const s = times[i];
    const e = times[i + 1];
    if (s < ws || e > we || e <= s) continue;
    const last = segs[segs.length - 1];
    if (last && last.end === s && last.confirmed === conf && last.with_tentative === tent) last.end = e;
    else segs.push({ start: s, end: e, confirmed: conf, with_tentative: tent });
  }
  return segs;
}

// Evaluate requirements for each date in [from, to]. Only dates matching a
// configured requirement produce results; days without a requirement are
// never treated as gaps.
export function evaluateRequirements(requirements, occurrences, facilities, from, to) {
  const tzById = new Map(facilities.map((f) => [f.id, f.timezone]));
  const results = [];
  const counted = occurrences.filter((o) => isWorking(o) && o.start_utc != null);
  for (const req of requirements) {
    if (req.active === false || req.active === 0) continue;
    const tz = tzById.get(req.facility_id);
    if (!tz) continue;
    const staff = counted.filter((o) => o.facility_id === req.facility_id);
    const n = diffDays(to, from);
    for (let i = 0; i <= n; i++) {
      const date = addDays(from, i);
      if (!req.weekdays.includes(weekday(date))) continue;
      const window = requirementWindow(req, date, tz);
      const profile = staffingProfile(window, staff);
      const short = profile.filter((s) => s.confirmed < req.min_nurses);
      results.push({
        requirement_id: req.id,
        facility_id: req.facility_id,
        label: req.label || '',
        date,
        min_nurses: req.min_nurses,
        window_start: window[0],
        window_end: window[1],
        met: short.length === 0,
        met_with_tentative: profile.every((s) => s.with_tentative >= req.min_nurses),
        shortfalls: short.map((s) => ({
          ...s,
          start_local: utcToZoned(s.start, tz),
          end_local: utcToZoned(s.end, tz),
        })),
      });
    }
  }
  return results;
}

// --- Validation -----------------------------------------------------------

export function validateAssignment(f) {
  const errors = [];
  if (!f.facility_id) errors.push('Choose a facility.');
  if (!TYPES.includes(f.type)) errors.push('Choose an assignment type.');
  if (!STATUSES.includes(f.status)) errors.push('Choose a status.');
  if (f.status !== 'unfilled' && !f.nurse_id) errors.push('Confirmed and tentative shifts need an assigned nurse.');
  if (f.hours_specified) {
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!re.test(f.start_time || '') || !re.test(f.end_time || '')) errors.push('Enter a start and end time, or choose “hours not specified”.');
    else {
      const off = Number(f.end_offset) || 0;
      if (off < 0 || off > 1) errors.push('Shifts may end on the same day or the next day.');
      else if (off === 0 && timeToMinutes(f.end_time) <= timeToMinutes(f.start_time)) {
        errors.push('End time must be after start time. For overnight shifts, set the end date to the next day.');
      } else if (off === 1 && timeToMinutes(f.end_time) > timeToMinutes(f.start_time)) {
        errors.push('Overnight shifts cannot be longer than 24 hours.');
      }
    }
  }
  if (f.covering_for_id && f.nurse_id && Number(f.covering_for_id) === Number(f.nurse_id)) {
    errors.push('A nurse cannot cover for themselves.');
  }
  return errors;
}
