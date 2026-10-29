import {
  addDays, addMonths, startOfMonth, startOfWeek, weekday, diffDays, formatTime, formatTimeShort,
  formatDateShort, formatDateLong, monthTitle, utcToZoned, zonedToUtc, WEEKDAYS_SHORT, isValidDate,
  timeToMinutes,
} from '/shared/time.js';
import { describeRule } from '/shared/recurrence.js';
import { subtractIntervals } from '/shared/schedule.js';

// ---------------------------------------------------------------------------
// State & persistence of per-viewer preferences
// ---------------------------------------------------------------------------

const prefs = {
  get(k, d) { try { const v = localStorage.getItem(`ns.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ns.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const S = {
  view: prefs.get('view', 'month'),
  cursor: localToday(),
  facilities: [],
  nurses: [],
  requirements: [],
  filter: prefs.get('filter', { facility: '', nurse: '' }),
  data: { occurrences: [], coverage: {}, requirements: [] },
  attention: { open: [], requirements: [] },
  selecting: false,
  selected: new Set(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nurse = (id) => S.nurses.find((n) => n.id === id);
const nurseName = (id) => (id == null ? '' : nurse(id)?.name || `Nurse #${id}`);
const facility = (id) => S.facilities.find((f) => f.id === id);
const facilityName = (id) => facility(id)?.name || '';
const tzOf = (id) => facility(id)?.timezone || 'UTC';

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, data) { super(data.error || `Request failed (${status})`); this.status = status; this.data = data; }
}

// Credentials for deployments protected by APP_USER / APP_PASSWORD. Kept
// for the browser session only.
const auth = {
  get() { try { return sessionStorage.getItem('ns.auth'); } catch { return null; } },
  set(v) { try { if (v) sessionStorage.setItem('ns.auth', v); else sessionStorage.removeItem('ns.auth'); } catch { /* unavailable */ } },
};

async function api(method, path, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const token = auth.get();
  if (token) headers.Authorization = `Basic ${token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === 'auth_required') {
    // Ask for credentials, then retry the same request once signed in.
    await signIn(token ? 'That username or password was not accepted.' : '');
    return api(method, path, body);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

let signInPromise = null;
function signIn(message) {
  if (signInPromise) return signInPromise;
  auth.set(null);
  signInPromise = new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<h3>Sign in</h3>
      <form id="signin-form" novalidate>
        ${message ? `<div class="error">${esc(message)}</div>` : ''}
        <div class="field"><label for="si-user">Username</label><input type="text" id="si-user" autocomplete="username" style="width:100%"></div>
        <div class="field"><label for="si-pass">Password</label><input type="password" id="si-pass" autocomplete="current-password" style="width:100%"></div>
        <div class="row-end"><button class="btn primary">Sign in</button></div>
      </form>`;
    m.hidden = false;
    $('#modal-backdrop').hidden = false;
    $('#si-user').focus();
    $('#signin-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const bytes = new TextEncoder().encode(`${$('#si-user').value}:${$('#si-pass').value}`);
      auth.set(btoa(String.fromCharCode(...bytes)));
      m.hidden = true;
      $('#modal-backdrop').hidden = true;
      signInPromise = null;
      resolve();
    });
  });
  return signInPromise;
}

// Run a save; on an overlap (409) ask for confirmation and retry with force.
async function saveWithOverlapCheck(fn) {
  try {
    return await fn(false);
  } catch (e) {
    if (e.status !== 409) throw e;
    const list = e.data.conflicts.map((c) => `
      <div class="conflict"><b>${esc(c.nurse)}</b> ${c.kind === 'possible' ? 'may already be working' : 'is already scheduled'}:
      <br>${esc(c.existing.label)} at ${esc(c.existing.facility)}
      <br><span class="muted">New: ${esc(c.proposed.label)} at ${esc(c.proposed.facility)}</span></div>`).join('');
    const more = e.data.total > e.data.conflicts.length ? `<p class="muted">…and ${e.data.total - e.data.conflicts.length} more.</p>` : '';
    const ok = await modal({
      title: 'Overlapping assignment',
      html: `<p>This nurse already has ${e.data.total > 1 ? 'overlapping assignments' : 'an overlapping assignment'}${e.data.conflicts.some((c) => c.kind === 'possible') ? ' (some have unspecified hours)' : ''}.</p>${list}${more}`,
      choices: [{ label: 'Go back', value: false }, { label: 'Save anyway', value: true, cls: 'primary' }],
      inline: true,
    });
    if (!ok) return null;
    return fn(true);
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadSetup() {
  const b = await api('GET', '/api/bootstrap');
  S.facilities = b.facilities;
  S.nurses = b.nurses;
  S.requirements = b.requirements;
  if (S.filter.facility && !facility(Number(S.filter.facility))) S.filter.facility = '';
  if (S.filter.nurse && !nurse(Number(S.filter.nurse))) S.filter.nurse = '';
  renderFilters();
}

function viewRange() {
  if (S.view === 'month') {
    const from = startOfWeek(startOfMonth(S.cursor));
    return { from, to: addDays(from, 41) };
  }
  if (S.view === 'week') {
    const from = startOfWeek(S.cursor);
    return { from, to: addDays(from, 6) };
  }
  return { from: S.cursor, to: addDays(S.cursor, 29) };
}

let loadSeq = 0;
async function refresh() {
  const seq = ++loadSeq;
  const { from, to } = viewRange();
  const q = new URLSearchParams({ from, to });
  if (S.filter.facility) q.set('facility_id', S.filter.facility);
  if (S.filter.nurse) q.set('nurse_id', S.filter.nurse);
  try {
    const [data, attention] = await Promise.all([
      api('GET', `/api/schedule?${q}`),
      api('GET', `/api/attention?from=${localToday()}&days=60`),
    ]);
    if (seq !== loadSeq) return;
    S.data = data;
    S.attention = attention;
  } catch (e) {
    toast(e.message);
  }
  render();
}

// ---------------------------------------------------------------------------
// Rendering: chrome
// ---------------------------------------------------------------------------

function renderFilters() {
  const fsel = $('#filter-facility');
  fsel.innerHTML = `<option value="">All facilities</option>${S.facilities.map((f) =>
    `<option value="${f.id}">${esc(f.name)}${f.active ? '' : ' (inactive)'}</option>`).join('')}`;
  fsel.value = S.filter.facility;
  const nsel = $('#filter-nurse');
  nsel.innerHTML = `<option value="">All nurses</option>${S.nurses.map((n) =>
    `<option value="${n.id}">${esc(n.name)}${n.active ? '' : ' (inactive)'}</option>`).join('')}`;
  nsel.value = S.filter.nurse;
}

function renderTitle() {
  const { from, to } = viewRange();
  let t;
  if (S.view === 'month') t = monthTitle(S.cursor);
  else t = `${formatDateShort(from).slice(4)} – ${formatDateShort(to).slice(4)}, ${to.slice(0, 4)}`;
  $('#title').textContent = t;
  $('#jump').value = S.cursor;
  for (const b of $$('[data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === S.view));
  $('#select-btn').classList.toggle('active', S.selecting);
  $('#select-bar').hidden = !S.selecting;
  const n = S.selected.size;
  $('#select-count').textContent = n ? `${n} date${n === 1 ? '' : 's'} selected: ${[...S.selected].sort().map(formatDateShort).join(', ')}` : 'Click dates on the calendar to select them.';
  $('[data-action="add-selected"]').disabled = n === 0;
}

function render() {
  renderTitle();
  const cal = $('#calendar');
  if (!S.facilities.length) {
    cal.innerHTML = `<div class="empty"><p><b>Welcome!</b> Start by adding a facility and your nurses.</p>
      <button class="btn primary" data-action="settings">Open setup</button></div>`;
  } else if (S.view === 'month') cal.innerHTML = renderMonth();
  else if (S.view === 'week') cal.innerHTML = renderWeek();
  else cal.innerHTML = renderAgenda();
  renderAttention();
}

// ---------------------------------------------------------------------------
// Rendering: entries
// ---------------------------------------------------------------------------

function hoursLabel(o, short = false) {
  if (!o.hours_specified) return 'Hours not specified';
  const f = short ? formatTimeShort : formatTime;
  return `${f(o.start_time)}–${f(o.end_time)}${o.end_date !== o.date ? (short ? '⁺¹' : ' (next day)') : ''}`;
}

function typeLabel(o) {
  if (o.status === 'unfilled') return 'Unfilled';
  if (o.vacated) return 'Released';
  return o.type === 'coverage' ? 'Coverage' : 'Regular';
}

function entryClasses(o) {
  const c = ['entry', `type-${o.type}`];
  if (o.status === 'unfilled') c.push('status-unfilled');
  if (o.status === 'tentative') c.push('status-tentative');
  if (o.vacated) {
    c.push('vacated');
    const cov = S.data.coverage[o.id];
    if (cov && !cov.fully_covered) c.push('has-gap');
  }
  return c.join(' ');
}

function describe(o) {
  const parts = [hoursLabel(o), o.status === 'unfilled' ? 'Unfilled' : nurseName(o.nurse_id), facilityName(o.facility_id),
    typeLabel(o)];
  if (o.status === 'tentative') parts.push('Tentative');
  if (o.covering_for_id) parts.push(`covering for ${nurseName(o.covering_for_id)}`);
  if (o.recurring) parts.push('recurring');
  return parts.filter(Boolean).join(' · ');
}

function entryHtml(o, { short = true } = {}) {
  const who = o.status === 'unfilled' ? 'Unfilled' : nurseName(o.nurse_id);
  const tags = [typeLabel(o)];
  if (o.status === 'tentative') tags.push('Tentative');
  const cov = S.data.coverage[o.id];
  const gapNote = o.vacated && cov ? (cov.fully_covered ? 'covered' : 'needs coverage') : '';
  const l2 = [facilityName(o.facility_id), o.covering_for_id ? `for ${nurseName(o.covering_for_id)}` : '', gapNote, o.recurring ? '↻' : '']
    .filter(Boolean).join(' · ');
  return `<button type="button" class="${entryClasses(o)}" data-occ="${esc(o.id)}" title="${esc(describe(o))}">
    <span class="l1"><span>${esc(hoursLabel(o, short))}</span> <b>${esc(who)}</b></span>
    <span class="l2"><span class="tag">${esc(tags.join(' · '))}</span> ${esc(l2)}</span>
  </button>`;
}

function occsOn(date) {
  return S.data.occurrences.filter((o) => o.date === date);
}

function reqBadge(date) {
  const rs = S.data.requirements.filter((r) => r.date === date);
  if (!rs.length) return '';
  const short = rs.filter((r) => !r.met);
  if (!short.length) return '<span class="req-badge ok" title="Staffing requirement met">✓ Staffed</span>';
  const tentOnly = short.every((r) => r.met_with_tentative);
  const title = short.map((r) => `${facilityName(r.facility_id)}: needs ${r.min_nurses} — ${r.shortfalls.map((s) =>
    `${formatTime(s.start_local.time)}–${formatTime(s.end_local.time)} has ${s.confirmed}`).join(', ')}`).join('\n');
  return tentOnly
    ? `<span class="req-badge tent" title="${esc(`Met only if tentative shifts are confirmed\n${title}`)}">Tentative</span>`
    : `<span class="req-badge short" title="${esc(title)}">Short</span>`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function renderMonth() {
  const { from } = viewRange();
  const month = S.cursor.slice(0, 7);
  const today = localToday();
  const max = window.matchMedia('(max-width: 700px)').matches ? 3 : 4;
  let html = `<div class="dow-row">${WEEKDAYS_SHORT.map((d) => `<div>${d}</div>`).join('')}</div><div class="month-grid">`;
  for (let i = 0; i < 42; i++) {
    const d = addDays(from, i);
    const occs = occsOn(d);
    const cls = ['day'];
    if (d.slice(0, 7) !== month) cls.push('other');
    if (d === today) cls.push('today');
    if (S.selected.has(d)) cls.push('selected');
    const shown = occs.length > max ? occs.slice(0, max - 1) : occs;
    html += `<div class="${cls.join(' ')}" data-date="${d}" role="button" tabindex="0" aria-label="${esc(formatDateLong(d))}, ${occs.length} assignment${occs.length === 1 ? '' : 's'}">
      <div class="dayhead"><span class="daynum">${Number(d.slice(8))}</span>${reqBadge(d)}<span class="add-hint">+ Add</span></div>
      ${shown.map((o) => entryHtml(o)).join('')}
      ${occs.length > shown.length ? `<button type="button" class="more" data-more="${d}">+${occs.length - shown.length} more</button>` : ''}
    </div>`;
  }
  return `${html}</div>`;
}

function renderWeek() {
  const { from } = viewRange();
  const today = localToday();
  let html = '<div class="week-grid">';
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    const occs = occsOn(d);
    const cls = ['week-col'];
    if (d === today) cls.push('today');
    if (S.selected.has(d)) cls.push('selected');
    html += `<div class="${cls.join(' ')}">
      <div class="wk-head" data-date="${d}" role="button" tabindex="0"><div class="dayhead"><b>${esc(formatDateShort(d))}</b>${reqBadge(d)}</div></div>
      <div class="wk-body" data-date="${d}">
        ${occs.map((o) => entryHtml(o, { short: false })).join('') || '<span class="muted small">No assignments</span>'}
      </div>
    </div>`;
  }
  return `${html}</div>`;
}

function renderAgenda() {
  const { from, to } = viewRange();
  const n = diffDays(to, from);
  let html = '<div class="agenda">';
  let any = false;
  for (let i = 0; i <= n; i++) {
    const d = addDays(from, i);
    const occs = occsOn(d);
    const badge = reqBadge(d);
    if (!occs.length && !badge) continue;
    any = true;
    html += `<div class="ag-day"><div class="ag-date" data-date="${d}" role="button" tabindex="0">${esc(formatDateShort(d))}<br>${badge}</div>
      <div class="ag-list">${occs.map((o) => entryHtml(o, { short: false })).join('') || '<span class="muted small">No assignments</span>'}</div></div>`;
  }
  if (!any) html += '<div class="empty">No assignments in this period.</div>';
  return `${html}</div>`;
}

function fmtSeg([s, e], tz) {
  const a = utcToZoned(s, tz);
  const b = utcToZoned(e, tz);
  return `${formatTime(a.time)}–${formatTime(b.time)}${b.date !== a.date ? ' (next day)' : ''}`;
}

function renderAttention() {
  const ff = Number(S.filter.facility) || null;
  const items = [];
  const reqItems = [];
  for (const x of S.attention.open) {
    const o = x.occurrence;
    if (ff && o.facility_id !== ff) continue;
    const tz = tzOf(o.facility_id);
    let what;
    if (!o.hours_specified) what = 'Hours not specified · needs a nurse';
    else what = x.remaining.map((s) => `${fmtSeg(s, tz)} unfilled`).concat(x.tentative.map((s) => `${fmtSeg(s, tz)} tentative`)).join('; ');
    const why = o.vacated ? `${nurseName(o.nurse_id)} released` : 'Unfilled shift';
    items.push({ date: o.date, html: `<button type="button" class="att-item" data-occ="${esc(o.id)}">
      <b>${esc(formatDateShort(o.date))} · ${esc(facilityName(o.facility_id))}</b>${esc(why)} — ${esc(what)}</button>` });
  }
  for (const r of S.attention.requirements) {
    if (ff && r.facility_id !== ff) continue;
    const segs = r.shortfalls.map((s) => `${formatTime(s.start_local.time)}–${formatTime(s.end_local.time)} has ${s.confirmed}`).join(', ');
    const first = r.shortfalls[0];
    reqItems.push({ date: r.date, html: `<button type="button" class="att-item ${r.met_with_tentative ? 'tent' : ''}"
      data-gap="${r.facility_id}|${r.date}|${first.start_local.time}|${first.end_local.time}|${diffDays(first.end_local.date, r.date)}|${first.start_local.date}">
      <b>${esc(formatDateShort(r.date))} · ${esc(facilityName(r.facility_id))}</b>
      Below minimum (${r.min_nurses} nurse${r.min_nurses === 1 ? '' : 's'}${r.label ? `, ${esc(r.label)}` : ''}): ${esc(segs)}${r.met_with_tentative ? ' — met only if tentative shifts are confirmed' : ''}</button>` });
  }
  const group = (title, list, limit) => {
    if (!list.length) return '';
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return `<h3 class="att-head">${esc(title)} <span class="muted">(${list.length})</span></h3>${list.slice(0, limit).map((i) => i.html).join('')}${
      list.length > limit ? `<p class="muted small">…and ${list.length - limit} more.</p>` : ''}`;
  };
  $('#attention').innerHTML = items.length || reqItems.length
    ? group('Unfilled shifts', items, 15) + group('Below staffing requirement', reqItems, 8)
    : '<p class="muted small">Nothing unfilled. Gaps appear here only for shifts marked unfilled, released shifts without coverage, or unmet coverage requirements.</p>';
}

// ---------------------------------------------------------------------------
// Drawer & modal
// ---------------------------------------------------------------------------

let drawerOnClose = null;
function openDrawer(title, bodyHtml, footerHtml = '') {
  // A fresh element per panel so listeners from a previous panel don't linger.
  const old = $('#drawer');
  const d = old.cloneNode(false);
  old.replaceWith(d);
  d.innerHTML = `<header><h2>${esc(title)}</h2><button class="btn icon" data-close aria-label="Close">×</button></header>
    <div class="body">${bodyHtml}</div>${footerHtml ? `<footer>${footerHtml}</footer>` : ''}`;
  d.hidden = false;
  $('#drawer-backdrop').hidden = false;
  const first = d.querySelector('.body select, .body input, .body button');
  if (first) first.focus({ preventScroll: true });
  return d;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
  $('#drawer').innerHTML = '';
  if (drawerOnClose) { const f = drawerOnClose; drawerOnClose = null; f(); }
}

let modalResolve = null;
function modal({ title, html = '', choices, inline = false }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    const buttons = choices.map((c, i) => `<button class="btn ${c.cls || ''}" data-choice="${i}" ${c.disabled ? 'disabled' : ''}>
      ${esc(c.label)}${c.hint ? `<br><span class="muted small">${esc(c.hint)}</span>` : ''}</button>`).join('');
    m.innerHTML = `<h3>${esc(title)}</h3>${html}<div class="${inline ? 'row-end' : 'choices'}">${buttons}</div>`;
    m.hidden = false;
    $('#modal-backdrop').hidden = false;
    modalResolve = (i) => {
      m.hidden = true;
      $('#modal-backdrop').hidden = true;
      modalResolve = null;
      resolve(i == null ? null : choices[i].value);
    };
    const firstEnabled = m.querySelector('[data-choice]:not([disabled])');
    if (firstEnabled) firstEnabled.focus();
  });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

const scopeChoices = (verb, { allowThis = true, allowOthers = true } = {}) => [
  { label: 'This occurrence only', value: 'this', disabled: !allowThis, hint: allowThis ? '' : 'Not available for repeat-setting changes' },
  { label: 'This and future occurrences', value: 'future', disabled: !allowOthers, hint: allowOthers ? 'Earlier occurrences stay unchanged' : 'Moving a date applies to one occurrence only' },
  { label: 'Entire series', value: 'all', disabled: !allowOthers, hint: allowOthers ? 'One-off changes to individual occurrences are kept' : '' },
  { label: 'Cancel', value: null },
];

// ---------------------------------------------------------------------------
// Shift form (add / edit / duplicate)
// ---------------------------------------------------------------------------

const DEFAULT_PRESETS = [
  { start_time: '07:00', end_time: '19:00', end_offset: 0 },
  { start_time: '19:00', end_time: '07:00', end_offset: 1 },
  { start_time: '08:00', end_time: '16:00', end_offset: 0 },
];

function nurseOptions(selected, { blank = 'Select nurse…', exclude = null } = {}) {
  const opts = S.nurses.filter((n) => (n.active || n.id === selected) && n.id !== exclude);
  return `<option value="">${esc(blank)}</option>${opts.map((n) =>
    `<option value="${n.id}" ${n.id === selected ? 'selected' : ''}>${esc(n.name)}${n.active ? '' : ' (inactive)'}</option>`).join('')}`;
}

function facilityOptions(selected) {
  return S.facilities.filter((f) => f.active || f.id === selected).map((f) =>
    `<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
}

function segGroup(name, options, value) {
  return `<span class="seg-group" role="radiogroup">${options.map(([v, l]) => `
    <input type="radio" name="${name}" id="${name}-${v}" value="${v}" ${v === value ? 'checked' : ''}><label for="${name}-${v}">${esc(l)}</label>`).join('')}</span>`;
}

function weekdayToggles(name, selected) {
  return `<div class="weekday-toggles">${WEEKDAYS_SHORT.map((d, i) => `<label title="${d}"><input type="checkbox" name="${name}" value="${i}" ${selected.includes(i) ? 'checked' : ''}>${d.slice(0, 2)}</label>`).join('')}</div>`;
}

// opts: { mode: 'create' | 'edit' | 'duplicate', dates, occ, series, prefill }
function openShiftForm(opts) {
  if (!S.facilities.length) { openSettings('facilities'); return; }
  const { mode = 'create', occ = null, series = null } = opts;
  const base = occ || opts.prefill || {};
  const lastFacility = prefs.get('lastFacility', null);
  const facilityId = base.facility_id ?? (Number(S.filter.facility) || (facility(lastFacility)?.active ? lastFacility : S.facilities.find((f) => f.active)?.id));
  const lastHours = prefs.get(`hours.${facilityId}`, DEFAULT_PRESETS[0]);
  const hoursSpecified = base.hours_specified ?? true;
  const start = base.start_time ?? lastHours.start_time;
  const end = base.end_time ?? lastHours.end_time;
  const baseDate = base.date || opts.dates?.[0] || S.cursor;
  const endOffset = occ ? diffDays(occ.end_date, occ.date) : (base.end_offset ?? (timeToMinutes(end) <= timeToMinutes(start) ? 1 : 0));
  const status = base.status || 'confirmed';
  const type = base.type || 'regular';
  const nurseId = base.nurse_id ?? (Number(S.filter.nurse) || null);
  const editing = mode === 'edit';
  const isSeries = editing && occ?.recurring;
  const rule = series ? {
    start_date: series.start_date, interval_weeks: series.interval_weeks, weekdays: series.weekdays,
    end_type: series.end_type, until_date: series.until_date, count: series.count,
  } : null;
  let dates = editing ? [occ.date] : [...(opts.dates || [baseDate])].sort();
  const repeatInitial = rule ? (rule.interval_weeks === 1 ? 'weekly' : rule.interval_weeks === 2 ? 'biweekly' : 'custom') : 'none';

  const title = editing ? 'Edit assignment' : mode === 'duplicate' ? 'Duplicate assignment' : 'Add shift';
  const body = `
    <form id="shift-form" novalidate>
      <div class="error" id="form-error" hidden></div>
      ${isSeries ? `<div class="summary" style="margin-bottom:12px">Part of a recurring schedule. You'll choose whether changes apply to this occurrence, this and future occurrences, or the entire series.</div>` : ''}
      <div class="field"><label for="f-facility">Facility</label><select id="f-facility" required>${facilityOptions(facilityId)}</select></div>
      <div class="field"><span class="lbl">Status</span>${segGroup('status', [['confirmed', 'Confirmed'], ['tentative', 'Tentative'], ['unfilled', 'Unfilled']], status)}</div>
      <div class="field"><label for="f-nurse" id="f-nurse-label">Nurse</label><select id="f-nurse">${nurseOptions(nurseId)}</select></div>
      <div class="field"><span class="lbl">Assignment type</span>${segGroup('type', [['regular', 'Regular shift'], ['coverage', 'Coverage']], type)}</div>
      <div class="field" id="covering-field"><label for="f-covering">Covering for <span class="muted small">(optional)</span></label>
        <select id="f-covering">${nurseOptions(base.covering_for_id ?? null, { blank: '— nobody —' })}</select></div>
      <div class="field">
        <label for="f-date">${editing ? 'Date' : 'Date(s)'}</label>
        <div class="row"><input type="date" id="f-date" value="${esc(dates[0])}" required>
          ${editing ? '' : '<button type="button" class="btn" id="add-date">+ Add another date</button>'}</div>
        <div class="date-chips" id="date-chips"></div>
        ${isSeries ? '<div class="hint">Changing the date moves this occurrence only.</div>' : ''}
      </div>
      <div class="field">
        <span class="lbl">Hours</span>
        <div id="hours-inputs">
          <div class="row">
            <input type="time" id="f-start" value="${esc(start)}" aria-label="Start time"> –
            <input type="time" id="f-end" value="${esc(end)}" aria-label="End time">
            <select id="f-end-date" aria-label="End date"></select>
          </div>
          <div class="presets" id="presets"></div>
        </div>
        <label class="row" style="margin-top:6px;font-weight:normal"><input type="checkbox" id="f-unspecified" ${hoursSpecified ? '' : 'checked'}> Hours not specified</label>
        <div class="hint" id="unspec-hint" hidden>Shown as “hours not specified” — not counted as 24-hour coverage.</div>
      </div>
      <div class="field"><label for="f-notes">Notes <span class="muted small">(optional)</span></label>
        <input type="text" id="f-notes" value="${esc(base.notes || '')}" maxlength="2000"></div>
      <div class="field" id="repeat-field" ${editing && !isSeries ? 'hidden' : ''}>
        <label for="f-repeat">Repeat</label>
        <select id="f-repeat">
          <option value="none" ${repeatInitial === 'none' ? 'selected' : ''} ${isSeries ? 'disabled' : ''}>Does not repeat</option>
          <option value="weekly" ${repeatInitial === 'weekly' ? 'selected' : ''}>Weekly</option>
          <option value="biweekly" ${repeatInitial === 'biweekly' ? 'selected' : ''}>Every other week</option>
          <option value="custom" ${repeatInitial === 'custom' ? 'selected' : ''}>Every X weeks…</option>
        </select>
        <div class="hint" id="repeat-multi-hint" hidden>Repeat is unavailable when several dates are selected.</div>
        <div class="subtle-box" id="repeat-box" style="margin-top:8px" hidden>
          <div class="field" id="interval-field"><label for="f-interval">Every</label>
            <div class="row"><input type="number" id="f-interval" min="1" max="52" value="${rule?.interval_weeks || 3}" style="width:70px"> weeks</div></div>
          <div class="field"><span class="lbl">On</span>${weekdayToggles('wd', rule ? rule.weekdays : [weekday(dates[0])])}</div>
          ${rule ? `<div class="field"><label for="f-rstart">Series starts</label><input type="date" id="f-rstart" value="${esc(rule.start_date)}"></div>` : ''}
          <div class="field"><span class="lbl">Ends</span>
            <div><label class="row" style="font-weight:normal"><input type="radio" name="endtype" value="never" ${!rule || rule.end_type === 'never' ? 'checked' : ''}> No end date</label></div>
            <div><label class="row" style="font-weight:normal"><input type="radio" name="endtype" value="until" ${rule?.end_type === 'until' ? 'checked' : ''}> On
              <input type="date" id="f-until" value="${esc(rule?.until_date || addDays(dates[0], 84))}"></label></div>
            <div><label class="row" style="font-weight:normal"><input type="radio" name="endtype" value="count" ${rule?.end_type === 'count' ? 'checked' : ''}> After
              <input type="number" id="f-count" min="1" max="1000" value="${rule?.count || 10}" style="width:70px"> occurrences</label></div>
            ${isSeries ? '<div class="hint">The occurrence count includes earlier occurrences of the series.</div>' : ''}
          </div>
          <div class="summary" id="rule-summary"></div>
        </div>
      </div>
    </form>`;
  const footer = `<button class="btn" data-close>Cancel</button><button class="btn primary" id="save-shift">${editing ? 'Save changes' : 'Save'}</button>`;
  const d = openDrawer(title, body, footer);
  const form = $('#shift-form', d);

  const val = (id) => $(id, d).value;
  let timesTouched = false;
  const radio = (name) => $(`input[name="${name}"]:checked`, d)?.value;

  function renderDates() {
    const chips = $('#date-chips', d);
    if (editing || dates.length <= 1) chips.innerHTML = '';
    else chips.innerHTML = dates.map((x) => `<span class="date-chip">${esc(formatDateShort(x))}<button type="button" data-remove-date="${x}" aria-label="Remove ${esc(x)}">×</button></span>`).join('');
    const multi = dates.length > 1;
    $('#f-repeat', d).disabled = multi && !isSeries;
    $('#repeat-multi-hint', d).hidden = !multi;
    if (multi && !isSeries) $('#f-repeat', d).value = 'none';
    renderEndDate();
    updateRepeat();
  }

  function renderEndDate() {
    const sel = $('#f-end-date', d);
    const first = dates[0] || val('#f-date');
    if (!isValidDate(first)) return;
    const prev = sel.value || String(endOffset);
    sel.innerHTML = `<option value="0">ends same day</option><option value="1">ends next day (${esc(formatDateShort(addDays(first, 1)))})</option>`;
    sel.value = prev;
  }

  function autoEndDate() {
    const s = val('#f-start');
    const e = val('#f-end');
    if (s && e) $('#f-end-date', d).value = timeToMinutes(e) <= timeToMinutes(s) ? '1' : '0';
  }

  function updateVisibility() {
    const st = radio('status');
    const unfilled = st === 'unfilled';
    $('#f-nurse', d).disabled = unfilled;
    $('#f-nurse-label', d).textContent = unfilled ? 'Nurse (not needed for unfilled shifts)' : 'Nurse';
    $('#covering-field', d).hidden = radio('type') !== 'coverage' && !$('#f-covering', d).value;
    const unspec = $('#f-unspecified', d).checked;
    $('#hours-inputs', d).hidden = unspec;
    $('#unspec-hint', d).hidden = !unspec;
  }

  async function loadPresets() {
    const fid = Number(val('#f-facility'));
    let list = [];
    try { list = await api('GET', `/api/presets?facility_id=${fid}`); } catch { /* ignore */ }
    for (const p of DEFAULT_PRESETS) {
      if (list.length >= 4) break;
      if (!list.some((x) => x.start_time === p.start_time && x.end_time === p.end_time)) list.push(p);
    }
    $('#presets', d).innerHTML = list.map((p) => `<button type="button" class="preset" data-preset="${p.start_time}|${p.end_time}|${p.end_offset}">
      ${esc(formatTimeShort(p.start_time))}–${esc(formatTimeShort(p.end_time))}${p.end_offset ? '⁺¹' : ''}</button>`).join('');
  }

  function currentRule() {
    const rep = val('#f-repeat');
    if (rep === 'none') return null;
    const weekdays = $$('input[name="wd"]:checked', d).map((x) => Number(x.value));
    const end_type = radio('endtype');
    return {
      start_date: $('#f-rstart', d)?.value || dates[0],
      interval_weeks: rep === 'weekly' ? 1 : rep === 'biweekly' ? 2 : Number(val('#f-interval')) || 1,
      weekdays,
      end_type,
      until_date: end_type === 'until' ? val('#f-until') : null,
      count: end_type === 'count' ? Number(val('#f-count')) : null,
    };
  }

  function updateRepeat() {
    const rep = val('#f-repeat');
    $('#repeat-box', d).hidden = rep === 'none';
    $('#interval-field', d).hidden = rep !== 'custom';
    const r = currentRule();
    if (r) {
      const f = readFields();
      $('#rule-summary', d).textContent = r.weekdays.length ? describeRule(r, f) : 'Select at least one weekday.';
    }
  }

  function readFields() {
    const unspec = $('#f-unspecified', d).checked;
    return {
      facility_id: Number(val('#f-facility')),
      status: radio('status'),
      nurse_id: radio('status') === 'unfilled' ? null : Number(val('#f-nurse')) || null,
      type: radio('type'),
      covering_for_id: Number(val('#f-covering')) || null,
      hours_specified: !unspec,
      start_time: unspec ? null : val('#f-start'),
      end_time: unspec ? null : val('#f-end'),
      end_offset: unspec ? 0 : Number(val('#f-end-date')) || 0,
      notes: val('#f-notes').trim(),
    };
  }

  function showError(msg) {
    const e = $('#form-error', d);
    e.textContent = msg;
    e.hidden = !msg;
    if (msg) e.scrollIntoView({ block: 'nearest' });
  }

  function clientValidate(f) {
    if (!f.facility_id) return 'Choose a facility.';
    if (f.status !== 'unfilled' && !f.nurse_id) return 'Choose a nurse, or set the status to Unfilled.';
    if (f.hours_specified) {
      if (!f.start_time || !f.end_time) return 'Enter a start and end time, or check “Hours not specified”.';
      if (f.end_offset === 0 && timeToMinutes(f.end_time) <= timeToMinutes(f.start_time)) return 'End time must be after start time. For overnight shifts choose “ends next day”.';
    }
    if (!dates.length) return 'Choose at least one date.';
    return '';
  }

  // Events
  d.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'f-facility') {
      loadPresets();
      const remembered = prefs.get(`hours.${t.value}`, null);
      if (!editing && !timesTouched && remembered && !opts.prefill) {
        $('#f-start', d).value = remembered.start_time;
        $('#f-end', d).value = remembered.end_time;
        $('#f-end-date', d).value = String(remembered.end_offset || 0);
      }
    }
    if (t.id === 'f-start' || t.id === 'f-end') timesTouched = true;
    if (t.id === 'f-date') {
      if (!isValidDate(t.value)) return;
      if (editing || dates.length <= 1) dates = [t.value];
      renderDates();
    }
    if (t.id === 'f-start' || t.id === 'f-end') autoEndDate();
    if (t.name === 'type' && t.value === 'coverage') $('#covering-field', d).hidden = false;
    updateVisibility();
    updateRepeat();
  });
  d.addEventListener('input', (ev) => { if (ev.target.closest('#repeat-box')) updateRepeat(); });
  d.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.id === 'add-date') {
      const v = val('#f-date');
      const next = dates.length ? addDays(dates[dates.length - 1], 1) : v;
      if (!dates.includes(v)) dates.push(v); else dates.push(next);
      dates = [...new Set(dates)].sort();
      $('#f-date', d).value = dates[dates.length - 1];
      renderDates();
    } else if (t.dataset.removeDate) {
      dates = dates.filter((x) => x !== t.dataset.removeDate);
      if (dates.length) $('#f-date', d).value = dates[0];
      renderDates();
    } else if (t.dataset.preset) {
      const [s, e, off] = t.dataset.preset.split('|');
      $('#f-start', d).value = s;
      $('#f-end', d).value = e;
      $('#f-end-date', d).value = off;
      $('#f-unspecified', d).checked = false;
      updateVisibility();
      updateRepeat();
    } else if (t.id === 'save-shift') {
      save();
    }
  });
  form.addEventListener('submit', (ev) => { ev.preventDefault(); save(); });

  async function save() {
    const f = readFields();
    const err = clientValidate(f);
    if (err) return showError(err);
    const r = currentRule();
    if (r && !r.weekdays.length) return showError('Select at least one weekday for the repeat.');
    showError('');
    const btn = $('#save-shift', d);
    btn.disabled = true;
    try {
      let result;
      if (!editing) {
        if (r && dates.length === 1) {
          result = await saveWithOverlapCheck((force) => api('POST', '/api/series', { ...f, recurrence: { ...r, start_date: dates[0] }, force }));
        } else {
          result = await saveWithOverlapCheck((force) => api('POST', '/api/shifts', { ...f, dates, force }));
        }
      } else if (!isSeries) {
        result = await saveWithOverlapCheck((force) => api('PUT', `/api/occurrences/${encodeURIComponent(occ.id)}`, { ...f, date: dates[0], force }));
      } else {
        const dateChanged = dates[0] !== occ.date;
        const ruleChanged = JSON.stringify(normRule(r)) !== JSON.stringify(normRule(rule));
        const scope = await modal({
          title: 'Apply changes to…',
          choices: scopeChoices('edit', { allowThis: !ruleChanged, allowOthers: !dateChanged }),
        });
        if (!scope) { btn.disabled = false; return; }
        result = await saveWithOverlapCheck((force) => api('PUT', `/api/occurrences/${encodeURIComponent(occ.id)}`, {
          ...f, date: dates[0], scope, recurrence: scope === 'this' ? undefined : r, force,
        }));
      }
      if (!result) { btn.disabled = false; return; }
      prefs.set('lastFacility', f.facility_id);
      if (f.hours_specified) prefs.set(`hours.${f.facility_id}`, { start_time: f.start_time, end_time: f.end_time, end_offset: f.end_offset });
      closeDrawer();
      clearSelection();
      toast(editing ? 'Changes saved' : (dates.length > 1 ? `Added to ${dates.length} dates` : r ? 'Recurring schedule created' : 'Shift added'));
      await refresh();
    } catch (e) {
      showError(e.message);
      btn.disabled = false;
    }
  }

  renderDates();
  if (!occ && !opts.prefill?.end_offset && !base.end_offset) autoEndDate();
  updateVisibility();
  updateRepeat();
  loadPresets();
}

function normRule(r) {
  if (!r) return null;
  return { s: r.start_date, i: Number(r.interval_weeks), w: [...r.weekdays].sort(), e: r.end_type, u: r.end_type === 'until' ? r.until_date : null, c: r.end_type === 'count' ? Number(r.count) : null };
}

// ---------------------------------------------------------------------------
// Details panel
// ---------------------------------------------------------------------------

async function openDetails(id) {
  let res;
  try { res = await api('GET', `/api/occurrences/${encodeURIComponent(id)}`); } catch (e) { toast(e.message); return; }
  const o = res.occurrence;
  const series = res.series;
  const cov = S.data.coverage[o.id] || S.attention.open.find((x) => x.occurrence.id === o.id);
  const tz = tzOf(o.facility_id);
  const working = o.nurse_id != null && !o.vacated && o.status !== 'unfilled';
  const open = o.status === 'unfilled' || o.vacated;
  const tags = `<span class="pill ${entryClasses(o).replace('entry', '')}">${esc(typeLabel(o))}</span>
    ${o.status === 'tentative' ? '<span class="pill status-tentative" style="background:#fff4dc;color:#7a4b00">Tentative</span>' : ''}
    ${o.status === 'confirmed' && !o.vacated ? '<span class="pill" style="background:#e6f6ec;color:#17643a">Confirmed</span>' : ''}`;
  let covHtml = '';
  if (open && cov) {
    const coverers = (cov.coverers || []).map((cid) => S.data.occurrences.find((x) => x.id === (typeof cid === 'string' ? cid : cid.id))).filter(Boolean);
    const lines = coverers.map((c) => `<li>${esc(nurseName(c.nurse_id))}: ${esc(hoursLabel(c))}${c.status === 'tentative' ? ' (tentative)' : ''}</li>`).join('');
    const rem = (cov.remaining || []).map((s) => fmtSeg(s, tz));
    const tent = (cov.tentative || []).map((s) => fmtSeg(s, tz));
    covHtml = `<div class="subtle-box"><b>Coverage</b>
      ${lines ? `<ul style="margin:6px 0;padding-left:18px">${lines}</ul>` : '<p class="muted" style="margin:6px 0">No one assigned yet.</p>'}
      ${cov.fully_covered ? '<p style="margin:4px 0;color:#17643a">✓ Fully covered</p>' : ''}
      ${rem.length ? `<p style="margin:4px 0;color:#8f1414"><b>Still unfilled:</b> ${esc(rem.join(', '))}</p>` : ''}
      ${tent.length ? `<p style="margin:4px 0;color:#7a4b00"><b>Tentative only:</b> ${esc(tent.join(', '))}</p>` : ''}
      ${!o.hours_specified && !cov.fully_covered ? '<p style="margin:4px 0;color:#8f1414">Needs a nurse (hours not specified)</p>' : ''}
    </div>`;
  }
  let coversHtml = '';
  if (o.covers_ref) {
    coversHtml = `<div class="subtle-box">Covers part or all of an existing shift. <button class="btn" data-open-occ="${esc(o.covers_ref)}">View original shift</button></div>`;
  }
  const seriesHtml = series ? `<dt>Repeats</dt><dd>${esc(describeRule({ ...series }, { ...series }))}${o.is_exception ? '<br><span class="muted small">This occurrence has been changed individually.</span>' : ''}</dd>` : '';
  const body = `<div class="details">
    <p>${tags}</p>
    <dl>
      <dt>Nurse</dt><dd>${o.status === 'unfilled' ? '<i>Unfilled</i>' : esc(nurseName(o.nurse_id))}${o.vacated ? ' <span class="muted">(released — replaced by coverage)</span>' : ''}</dd>
      <dt>Date</dt><dd>${esc(formatDateLong(o.date))}${o.end_date !== o.date ? ` → ${esc(formatDateLong(o.end_date))}` : ''}</dd>
      <dt>Hours</dt><dd>${esc(hoursLabel(o))}</dd>
      <dt>Facility</dt><dd>${esc(facilityName(o.facility_id))} <span class="muted small">(${esc(tz)})</span></dd>
      ${o.covering_for_id ? `<dt>Covering for</dt><dd>${esc(nurseName(o.covering_for_id))}</dd>` : ''}
      ${o.notes ? `<dt>Notes</dt><dd>${esc(o.notes)}</dd>` : ''}
      ${seriesHtml}
    </dl>
    ${covHtml}${coversHtml}
  </div>`;
  const footer = `
    ${o.vacated ? '<button class="btn" data-act="restore" title="The original nurse works this shift again">Restore original nurse</button>' : ''}
    <button class="btn danger" data-act="delete">Delete</button>
    <button class="btn" data-act="duplicate">Duplicate</button>
    ${working || open ? `<button class="btn" data-act="coverage">${open ? 'Fill / assign coverage' : 'Assign coverage'}</button>` : ''}
    <button class="btn primary" data-act="edit">Edit</button>`;
  const d = openDrawer('Assignment', body, footer);
  d.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.openOcc) return openDetails(b.dataset.openOcc);
    const act = b.dataset.act;
    if (act === 'edit') openShiftForm({ mode: 'edit', occ: o, series });
    else if (act === 'duplicate') {
      openShiftForm({ mode: 'duplicate', prefill: { ...o, end_offset: diffDays(o.end_date, o.date), date: addDays(o.date, 1) }, dates: [addDays(o.date, 1)] });
    } else if (act === 'coverage') openCoverageForm(o, cov);
    else if (act === 'restore') {
      try { await api('POST', `/api/occurrences/${encodeURIComponent(o.id)}/restore`); closeDrawer(); toast('Original nurse restored'); refresh(); } catch (e) { toast(e.message); }
    } else if (act === 'delete') {
      let scope = 'this';
      if (o.recurring) {
        scope = await modal({ title: 'Delete recurring assignment', choices: scopeChoices('delete') });
        if (!scope) return;
      } else {
        const ok = await modal({ title: 'Delete this assignment?', html: `<p>${esc(describe(o))}</p>`, choices: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'danger' }], inline: true });
        if (!ok) return;
      }
      try {
        await api('DELETE', `/api/occurrences/${encodeURIComponent(o.id)}?scope=${scope}`);
        closeDrawer();
        toast('Deleted');
        refresh();
      } catch (e) { toast(e.message); }
    }
  });
}

// ---------------------------------------------------------------------------
// Coverage form
// ---------------------------------------------------------------------------

function openCoverageForm(o, cov) {
  const tz = tzOf(o.facility_id);
  const isOpen = o.status === 'unfilled' || o.vacated;
  const who = isOpen ? (o.vacated ? nurseName(o.nurse_id) : null) : nurseName(o.nurse_id);
  const multiDay = o.end_date !== o.date;
  const body = `<form id="cov-form" novalidate>
    <div class="error" id="form-error" hidden></div>
    <div class="summary" style="margin-bottom:12px">
      <b>${esc(formatDateShort(o.date))}</b> · ${esc(hoursLabel(o))} · ${esc(facilityName(o.facility_id))}<br>
      ${who ? `Original nurse: <b>${esc(who)}</b> — will be recorded as “covering for” and no longer counted on this shift.` : 'Unfilled shift.'}
    </div>
    <div class="field"><label for="c-nurse">Replacement nurse</label><select id="c-nurse">${nurseOptions(null, { exclude: o.nurse_id })}</select></div>
    <div class="field"><span class="lbl">Status</span>${segGroup('cstatus', [['confirmed', 'Confirmed'], ['tentative', 'Tentative']], 'confirmed')}</div>
    ${o.hours_specified ? `<div class="field"><span class="lbl">Hours covered <span class="muted small">(change for partial coverage)</span></span>
      <div class="row">
        ${multiDay ? `<select id="c-date"><option value="${o.date}">${esc(formatDateShort(o.date))}</option><option value="${o.end_date}">${esc(formatDateShort(o.end_date))}</option></select>` : ''}
        <input type="time" id="c-start" value="${esc(o.start_time)}"> – <input type="time" id="c-end" value="${esc(o.end_time)}">
        <select id="c-end-date"><option value="0">same day</option><option value="1">next day</option></select>
      </div>
      <div class="hint" id="c-remaining"></div></div>` : '<p class="hint">Hours are not specified for this shift; the replacement covers the whole shift.</p>'}
    <div class="field"><label for="c-notes">Notes <span class="muted small">(optional)</span></label><input type="text" id="c-notes"></div>
  </form>`;
  const footer = '<button class="btn" data-close>Cancel</button><button class="btn primary" id="save-cov">Assign coverage</button>';
  const d = openDrawer(isOpen ? 'Fill shift' : 'Assign coverage', body, footer);
  const val = (id) => $(id, d)?.value;
  if (o.hours_specified) $('#c-end-date', d).value = String(diffDays(o.end_date, o.date));

  // Base gap before this new assignment: existing remaining time (if already
  // open) or the whole shift.
  const baseGap = isOpen && cov ? [...(cov.remaining || []), ...(cov.tentative || [])] : (o.start_utc != null ? [[o.start_utc, o.end_utc]] : []);

  function proposed() {
    const date = val('#c-date') || o.date;
    const s = val('#c-start');
    const e = val('#c-end');
    if (!s || !e) return null;
    const endDate = addDays(date, Number(val('#c-end-date')) || 0);
    return [zonedToUtc(date, s, tz), zonedToUtc(endDate, e, tz)];
  }

  function updateRemaining() {
    if (!o.hours_specified) return;
    const autoNext = timeToMinutes(val('#c-end')) <= timeToMinutes(val('#c-start'));
    $('#c-end-date', d).value = autoNext ? '1' : '0';
    const p = proposed();
    const el = $('#c-remaining', d);
    if (!p) { el.textContent = ''; return; }
    if (p[0] < o.start_utc || p[1] > o.end_utc) { el.innerHTML = '<span style="color:#8f1414">Coverage hours must fall within the original shift.</span>'; return; }
    const left = subtractIntervals(baseGap, [p]);
    el.innerHTML = left.length
      ? `<span style="color:#8f1414">Remaining unfilled after this: ${esc(left.map((x) => fmtSeg(x, tz)).join(', '))}</span>`
      : '<span style="color:#17643a">Shift fully covered.</span>';
  }
  d.addEventListener('change', updateRemaining);
  d.addEventListener('input', updateRemaining);
  updateRemaining();

  const showError = (m) => { const e = $('#form-error', d); e.textContent = m; e.hidden = !m; };
  async function save() {
    const nurseId = Number(val('#c-nurse'));
    if (!nurseId) return showError('Choose the replacement nurse.');
    const status = $('input[name="cstatus"]:checked', d).value;
    const payload = { nurse_id: nurseId, status, notes: val('#c-notes').trim() };
    if (o.hours_specified) {
      Object.assign(payload, {
        hours_specified: true, start_time: val('#c-start'), end_time: val('#c-end'),
        end_offset: Number(val('#c-end-date')) || 0, date: val('#c-date') || o.date,
      });
    } else payload.hours_specified = false;
    const btn = $('#save-cov', d);
    btn.disabled = true;
    try {
      const r = await saveWithOverlapCheck((force) => api('POST', `/api/occurrences/${encodeURIComponent(o.id)}/coverage`, { ...payload, force }));
      if (!r) { btn.disabled = false; return; }
      closeDrawer();
      toast('Coverage assigned');
      refresh();
    } catch (e) {
      showError(e.message);
      btn.disabled = false;
    }
  }
  d.addEventListener('click', (ev) => { if (ev.target.id === 'save-cov') save(); });
  $('#cov-form', d).addEventListener('submit', (ev) => { ev.preventDefault(); save(); });
}

// ---------------------------------------------------------------------------
// Day panel (all assignments of one day)
// ---------------------------------------------------------------------------

function openDay(date) {
  const occs = occsOn(date);
  const reqs = S.data.requirements.filter((r) => r.date === date);
  const reqHtml = reqs.map((r) => `<div class="subtle-box"><b>${esc(facilityName(r.facility_id))}</b> requires ${r.min_nurses} nurse${r.min_nurses === 1 ? '' : 's'}
    ${r.label ? `(${esc(r.label)})` : ''}: ${r.met ? '<span style="color:#17643a">✓ met</span>'
      : r.shortfalls.map((s) => `<br><span style="color:#8f1414">${esc(formatTime(s.start_local.time))}–${esc(formatTime(s.end_local.time))}: ${s.confirmed} confirmed${s.with_tentative > s.confirmed ? `, ${s.with_tentative - s.confirmed} tentative` : ''}</span>`).join('')}</div>`).join('');
  const d = openDrawer(formatDateLong(date), `${reqHtml}<div style="display:flex;flex-direction:column;gap:6px">${occs.map((o) => entryHtml(o, { short: false })).join('') || '<p class="muted">No assignments.</p>'}</div>`,
    '<button class="btn" data-close>Close</button><button class="btn primary" id="day-add">+ Add shift</button>');
  d.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-occ]');
    if (b) openDetails(b.dataset.occ);
    if (ev.target.id === 'day-add') openShiftForm({ dates: [date] });
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico', 'America/Toronto', 'America/Vancouver', 'Europe/London', 'UTC'];

function openSettings(tab = 'nurses') {
  const tzOptions = (sel) => {
    const list = TIMEZONES.includes(sel) || !sel ? TIMEZONES : [sel, ...TIMEZONES];
    return list.map((t) => `<option ${t === sel ? 'selected' : ''}>${esc(t)}</option>`).join('');
  };
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tabs = `<div class="tabs" role="tablist">${[['nurses', 'Nurses'], ['facilities', 'Facilities'], ['requirements', 'Coverage requirements']]
    .map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div>`;
  let content = '';
  if (tab === 'nurses') {
    content = `<form class="row" id="add-nurse" style="margin-bottom:10px"><input type="text" id="new-nurse" placeholder="Nurse name" style="flex:1" required><button class="btn primary">Add</button></form>
      ${S.nurses.map((n) => `<div class="list-row ${n.active ? '' : 'inactive'}"><input type="text" class="grow" value="${esc(n.name)}" data-nurse-name="${n.id}" aria-label="Name">
        <button class="btn" data-nurse-toggle="${n.id}">${n.active ? 'Deactivate' : 'Reactivate'}</button></div>`).join('') || '<p class="muted">No nurses yet.</p>'}
      <p class="hint">Inactive nurses are hidden from new assignments but keep their past and existing assignments.</p>`;
  } else if (tab === 'facilities') {
    content = `<form id="add-facility" class="subtle-box"><div class="field"><label for="new-fac">New facility</label><input type="text" id="new-fac" placeholder="Facility name" required></div>
      <div class="field"><label for="new-fac-tz">Timezone</label><select id="new-fac-tz">${tzOptions(TIMEZONES.includes(browserTz) ? browserTz : 'America/New_York')}</select></div>
      <button class="btn primary">Add facility</button></form>
      ${S.facilities.map((f) => `<div class="list-row ${f.active ? '' : 'inactive'}"><input type="text" class="grow" value="${esc(f.name)}" data-fac-name="${f.id}" aria-label="Name">
        <select data-fac-tz="${f.id}" aria-label="Timezone" style="max-width:150px">${tzOptions(f.timezone)}</select>
        <button class="btn" data-fac-toggle="${f.id}">${f.active ? 'Deactivate' : 'Reactivate'}</button></div>`).join('')}
      <p class="hint">Shift times are entered and shown in each facility's local time.</p>`;
  } else {
    content = `<p class="hint" style="margin-top:0">Optional. When a facility has a requirement, days that fall short of it are flagged. Days without a requirement are never treated as gaps. Only confirmed assignments count; tentative ones are shown separately.</p>
      ${S.requirements.map((r) => `<div class="list-row ${r.active ? '' : 'inactive'}"><div class="grow"><b>${esc(facilityName(r.facility_id))}</b>${r.label ? ` · ${esc(r.label)}` : ''}<br>
        <span class="small">${r.weekdays.map((w) => WEEKDAYS_SHORT[w]).join(', ')} · ${esc(formatTime(r.start_time))}–${esc(formatTime(r.end_time))}${timeToMinutes(r.end_time) <= timeToMinutes(r.start_time) ? ' (next day)' : ''} · min ${r.min_nurses}</span></div>
        <button class="btn" data-req-toggle="${r.id}">${r.active ? 'Pause' : 'Resume'}</button><button class="btn danger" data-req-del="${r.id}" aria-label="Delete requirement">×</button></div>`).join('') || '<p class="muted">No requirements configured.</p>'}
      <form id="add-req" class="subtle-box" style="margin-top:12px"><b>Add requirement</b>
        <div class="field" style="margin-top:8px"><label for="rq-fac">Facility</label><select id="rq-fac">${facilityOptions(Number(S.filter.facility) || S.facilities[0]?.id)}</select></div>
        <div class="field"><label for="rq-label">Label <span class="muted small">(optional)</span></label><input type="text" id="rq-label" placeholder="e.g. Day shift"></div>
        <div class="field"><span class="lbl">Weekdays</span>${weekdayToggles('rqwd', [1, 2, 3, 4, 5])}</div>
        <div class="field"><span class="lbl">Required time window</span><div class="row"><input type="time" id="rq-start" value="07:00"> – <input type="time" id="rq-end" value="19:00"></div>
          <div class="hint">An end time at or before the start time means the window ends the next day.</div></div>
        <div class="field"><label for="rq-min">Minimum nurses</label><input type="number" id="rq-min" min="1" max="50" value="1" style="width:80px"></div>
        <button class="btn primary">Add requirement</button></form>`;
  }
  const d = openDrawer('Setup', tabs + content, '<button class="btn" data-close>Done</button>');
  drawerOnClose = () => { renderFilters(); refresh(); };

  const reload = async (t = tab) => { await loadSetup(); drawerOnClose = null; openSettings(t); };
  const guard = async (fn) => { try { await fn(); } catch (e) { toast(e.message); } };

  d.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.tab) { drawerOnClose = null; openSettings(b.dataset.tab); return; }
    if (b.dataset.nurseToggle) {
      const n = nurse(Number(b.dataset.nurseToggle));
      guard(async () => { await api('PUT', `/api/nurses/${n.id}`, { name: n.name, active: !n.active }); await reload(); });
    }
    if (b.dataset.facToggle) {
      const f = facility(Number(b.dataset.facToggle));
      guard(async () => { await api('PUT', `/api/facilities/${f.id}`, { ...f, active: !f.active }); await reload(); });
    }
    if (b.dataset.reqToggle) {
      const r = S.requirements.find((x) => x.id === Number(b.dataset.reqToggle));
      guard(async () => { await api('PUT', `/api/requirements/${r.id}`, { ...r, active: !r.active }); await reload(); });
    }
    if (b.dataset.reqDel) guard(async () => { await api('DELETE', `/api/requirements/${b.dataset.reqDel}`); await reload(); });
  });
  d.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.nurseName) {
      const n = nurse(Number(t.dataset.nurseName));
      guard(async () => { await api('PUT', `/api/nurses/${n.id}`, { name: t.value, active: n.active }); await loadSetup(); toast('Saved'); });
    }
    if (t.dataset.facName || t.dataset.facTz) {
      const f = facility(Number(t.dataset.facName || t.dataset.facTz));
      const patch = t.dataset.facName ? { name: t.value } : { timezone: t.value };
      guard(async () => { await api('PUT', `/api/facilities/${f.id}`, { ...f, ...patch }); await loadSetup(); toast('Saved'); });
    }
  });
  d.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const id = ev.target.id;
    if (id === 'add-nurse') guard(async () => { await api('POST', '/api/nurses', { name: $('#new-nurse', d).value }); await reload(); $('#new-nurse').focus(); });
    if (id === 'add-facility') guard(async () => { await api('POST', '/api/facilities', { name: $('#new-fac', d).value, timezone: $('#new-fac-tz', d).value }); await reload(); });
    if (id === 'add-req') {
      guard(async () => {
        await api('POST', '/api/requirements', {
          facility_id: Number($('#rq-fac', d).value), label: $('#rq-label', d).value,
          weekdays: $$('input[name="rqwd"]:checked', d).map((x) => Number(x.value)),
          start_time: $('#rq-start', d).value, end_time: $('#rq-end', d).value, min_nurses: Number($('#rq-min', d).value),
        });
        await reload();
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Navigation & global events
// ---------------------------------------------------------------------------

function move(dir) {
  if (S.view === 'month') S.cursor = addMonths(startOfMonth(S.cursor), dir);
  else if (S.view === 'week') S.cursor = addDays(S.cursor, 7 * dir);
  else S.cursor = addDays(S.cursor, 30 * dir);
  refresh();
}

function clearSelection() {
  S.selecting = false;
  S.selected.clear();
  renderTitle();
  $$('.day.selected, .week-col.selected').forEach((el) => el.classList.remove('selected'));
}

function onDateClick(date) {
  if (S.selecting) {
    if (S.selected.has(date)) S.selected.delete(date); else S.selected.add(date);
    render();
    return;
  }
  openShiftForm({ dates: [date] });
}

document.addEventListener('click', (ev) => {
  if (!$('#modal').hidden) {
    if (signInPromise) return;
    const c = ev.target.closest('[data-choice]');
    if (c && modalResolve) modalResolve(Number(c.dataset.choice));
    else if (ev.target.id === 'modal-backdrop' && modalResolve) modalResolve(null);
    return;
  }
  if (ev.target.closest('[data-close]') || ev.target.id === 'drawer-backdrop') { closeDrawer(); return; }
  if (ev.target.closest('#drawer')) return;

  const act = ev.target.closest('[data-action]')?.dataset.action;
  if (act) {
    if (act === 'today') { S.cursor = localToday(); refresh(); }
    if (act === 'prev') move(-1);
    if (act === 'next') move(1);
    if (act === 'add') openShiftForm({ dates: [S.cursor >= localToday() || S.view !== 'month' ? S.cursor : localToday()] });
    if (act === 'settings') openSettings(S.facilities.length ? 'nurses' : 'facilities');
    if (act === 'select-mode') { S.selecting = !S.selecting; if (!S.selecting) S.selected.clear(); render(); }
    if (act === 'select-clear') { clearSelection(); render(); }
    if (act === 'add-selected' && S.selected.size) openShiftForm({ dates: [...S.selected].sort() });
    return;
  }
  const v = ev.target.closest('[data-view]');
  if (v) { S.view = v.dataset.view; prefs.set('view', S.view); refresh(); return; }

  const occ = ev.target.closest('[data-occ]');
  if (occ) {
    if (S.selecting) { const cell = occ.closest('[data-date]'); if (cell) onDateClick(cell.dataset.date); return; }
    openDetails(occ.dataset.occ);
    return;
  }
  const more = ev.target.closest('[data-more]');
  if (more) { openDay(more.dataset.more); return; }
  const gap = ev.target.closest('[data-gap]');
  if (gap) {
    const [fid, date, s, e, off, startDate] = gap.dataset.gap.split('|');
    openShiftForm({ prefill: { facility_id: Number(fid), start_time: s, end_time: e, end_offset: diffDays(addDays(date, Number(off)), startDate), hours_specified: true }, dates: [startDate] });
    return;
  }
  const cell = ev.target.closest('[data-date]');
  if (cell && cell.closest('#calendar')) onDateClick(cell.dataset.date);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (signInPromise) return;
    if (!$('#modal').hidden && modalResolve) modalResolve(null);
    else if (!$('#drawer').hidden) closeDrawer();
    else if (S.selecting) { clearSelection(); render(); }
  }
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('#calendar [data-date][role="button"]')) {
    ev.preventDefault();
    onDateClick(ev.target.dataset.date);
  }
});

$('#jump').addEventListener('change', (ev) => { if (isValidDate(ev.target.value)) { S.cursor = ev.target.value; refresh(); } });
$('#filter-facility').addEventListener('change', (ev) => { S.filter.facility = ev.target.value; prefs.set('filter', S.filter); refresh(); });
$('#filter-nurse').addEventListener('change', (ev) => { S.filter.nurse = ev.target.value; prefs.set('filter', S.filter); refresh(); });
window.addEventListener('resize', () => { if (S.view === 'month') render(); });

(async function init() {
  try {
    await loadSetup();
  } catch (e) {
    $('#calendar').innerHTML = `<div class="empty">Could not load data: ${esc(e.message)}</div>`;
    return;
  }
  await refresh();
  if (!S.facilities.length) openSettings('facilities');
})();
