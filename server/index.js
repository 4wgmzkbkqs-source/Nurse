import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { Store, HttpError } from './store.js';
import { isValidDate, addDays } from '../shared/time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIRS = { '/shared/': join(ROOT, 'shared'), '/': join(ROOT, 'public') };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) throw new HttpError(413, 'Request too large.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function requireDate(v, name) {
  if (!isValidDate(v)) throw new HttpError(400, `Query parameter "${name}" must be YYYY-MM-DD.`);
  return v;
}

// Optional HTTP Basic auth when APP_USER / APP_PASSWORD are set.
function authorized(req) {
  const user = process.env.APP_USER;
  const pass = process.env.APP_PASSWORD;
  if (!user || !pass) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const given = Buffer.from(h.slice(6), 'base64');
  const expected = Buffer.from(`${user}:${pass}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createApp(store) {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
  const id = (p) => Number(p.id);

  route('GET', /^\/api\/bootstrap$/, () => ({
    facilities: store.listFacilities(),
    nurses: store.listNurses(),
    requirements: store.listRequirements(),
  }));

  route('POST', /^\/api\/facilities$/, (p, b) => store.saveFacility(b));
  route('PUT', /^\/api\/facilities\/(?<id>\d+)$/, (p, b) => store.saveFacility(b, id(p)));
  route('POST', /^\/api\/nurses$/, (p, b) => store.saveNurse(b));
  route('PUT', /^\/api\/nurses\/(?<id>\d+)$/, (p, b) => store.saveNurse(b, id(p)));
  route('POST', /^\/api\/requirements$/, (p, b) => store.saveRequirement(b));
  route('PUT', /^\/api\/requirements\/(?<id>\d+)$/, (p, b) => store.saveRequirement(b, id(p)));
  route('DELETE', /^\/api\/requirements\/(?<id>\d+)$/, (p) => { store.deleteRequirement(id(p)); return { ok: true }; });

  route('GET', /^\/api\/schedule$/, (p, b, q) => {
    const from = requireDate(q.get('from'), 'from');
    const to = requireDate(q.get('to'), 'to');
    if (to < from || to > addDays(from, 120)) throw new HttpError(400, 'Date range must be 0–120 days.');
    return store.schedule(from, to, {
      facility_id: Number(q.get('facility_id')) || null,
      nurse_id: Number(q.get('nurse_id')) || null,
    });
  });
  route('GET', /^\/api\/attention$/, (p, b, q) => {
    const from = requireDate(q.get('from'), 'from');
    const days = Math.min(120, Math.max(1, Number(q.get('days')) || 60));
    return store.attention(from, days);
  });
  route('GET', /^\/api\/presets$/, (p, b, q) => store.presets(Number(q.get('facility_id')) || 0));

  route('POST', /^\/api\/shifts$/, (p, b) => ({ ids: store.createShifts(b) }));
  route('POST', /^\/api\/series$/, (p, b) => ({ series_id: store.createSeries(b) }));
  route('GET', /^\/api\/occurrences\/(?<oid>[^/]+)$/, (p) => {
    const { occ, series } = store.getOccurrence(decodeURIComponent(p.oid));
    return { occurrence: occ, series: series || null };
  });
  route('PUT', /^\/api\/occurrences\/(?<oid>[^/]+)$/, (p, b) => store.updateOccurrence(decodeURIComponent(p.oid), b));
  route('DELETE', /^\/api\/occurrences\/(?<oid>[^/]+)$/, (p, b, q) =>
    store.deleteOccurrence(decodeURIComponent(p.oid), q.get('scope') || 'this'));
  route('POST', /^\/api\/occurrences\/(?<oid>[^/]+)\/coverage$/, (p, b) =>
    store.assignCoverage(decodeURIComponent(p.oid), b));
  route('POST', /^\/api\/occurrences\/(?<oid>[^/]+)\/restore$/, (p) =>
    store.restoreOccurrence(decodeURIComponent(p.oid)));

  async function serveStatic(pathname, res) {
    const base = pathname.startsWith('/shared/') ? '/shared/' : '/';
    const dir = STATIC_DIRS[base];
    let rel = pathname.slice(base.length) || 'index.html';
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir)) return send(res, 403, { error: 'Forbidden' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      send(res, 404, { error: 'Not found' });
    }
  }

  return async function handler(req, res) {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Nurse schedule"' });
      return res.end('Authentication required');
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        return await serveStatic(url.pathname, res);
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
        const result = r.handler(m.groups || {}, body, url.searchParams);
        return send(res, req.method === 'POST' ? 201 : 200, result ?? { ok: true });
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      console.error(e);
      send(res, 500, { error: 'Internal error' });
    }
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const dbFile = process.env.DB_FILE || join(ROOT, 'data', 'schedule.db');
  const store = new Store(openDb(dbFile));
  const port = Number(process.env.PORT) || 3000;
  createServer(createApp(store)).listen(port, () => {
    console.log(`Nurse schedule running at http://localhost:${port}  (data: ${dbFile})`);
  });
}
