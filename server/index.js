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

// Postgres when a connection URL is configured (Vercel + Supabase sets
// POSTGRES_URL), otherwise a local SQLite file.
export function databaseTarget() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DB_FILE || join(ROOT, 'data', 'schedule.db');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Vercel's runtime may already have parsed the body.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try { return JSON.parse(String(req.body) || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }
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

// HTTP Basic credentials, required when APP_USER / APP_PASSWORD are set.
// On Vercel the app is public, so it refuses to serve data without them.
function authState(req) {
  const user = process.env.APP_USER;
  const pass = process.env.APP_PASSWORD;
  if (!user || !pass) return process.env.VERCEL ? 'unconfigured' : 'ok';
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return 'denied';
  const given = Buffer.from(h.slice(6), 'base64');
  const expected = Buffer.from(`${user}:${pass}`);
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'ok' : 'denied';
}

export function createApp(storeOrPromise) {
  const storeReady = Promise.resolve(storeOrPromise);
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
  const id = (p) => Number(p.id);

  route('GET', /^\/api\/bootstrap$/, async (s) => ({
    facilities: await s.listFacilities(),
    nurses: await s.listNurses(),
    requirements: await s.listRequirements(),
  }));

  route('POST', /^\/api\/facilities$/, (s, p, b) => s.saveFacility(b));
  route('PUT', /^\/api\/facilities\/(?<id>\d+)$/, (s, p, b) => s.saveFacility(b, id(p)));
  route('POST', /^\/api\/nurses$/, (s, p, b) => s.saveNurse(b));
  route('PUT', /^\/api\/nurses\/(?<id>\d+)$/, (s, p, b) => s.saveNurse(b, id(p)));
  route('POST', /^\/api\/requirements$/, (s, p, b) => s.saveRequirement(b));
  route('PUT', /^\/api\/requirements\/(?<id>\d+)$/, (s, p, b) => s.saveRequirement(b, id(p)));
  route('DELETE', /^\/api\/requirements\/(?<id>\d+)$/, async (s, p) => { await s.deleteRequirement(id(p)); return { ok: true }; });

  route('GET', /^\/api\/schedule$/, (s, p, b, q) => {
    const from = requireDate(q.get('from'), 'from');
    const to = requireDate(q.get('to'), 'to');
    if (to < from || to > addDays(from, 120)) throw new HttpError(400, 'Date range must be 0–120 days.');
    return s.schedule(from, to, {
      facility_id: Number(q.get('facility_id')) || null,
      nurse_id: Number(q.get('nurse_id')) || null,
    });
  });
  route('GET', /^\/api\/attention$/, (s, p, b, q) => {
    const from = requireDate(q.get('from'), 'from');
    const days = Math.min(120, Math.max(1, Number(q.get('days')) || 60));
    return s.attention(from, days);
  });
  route('GET', /^\/api\/presets$/, (s, p, b, q) => s.presets(Number(q.get('facility_id')) || 0));

  route('POST', /^\/api\/shifts$/, async (s, p, b) => ({ ids: await s.createShifts(b) }));
  route('POST', /^\/api\/series$/, async (s, p, b) => ({ series_id: await s.createSeries(b) }));
  route('GET', /^\/api\/occurrences\/(?<oid>[^/]+)$/, async (s, p) => {
    const { occ, series } = await s.getOccurrence(decodeURIComponent(p.oid));
    return { occurrence: occ, series: series || null };
  });
  route('PUT', /^\/api\/occurrences\/(?<oid>[^/]+)$/, (s, p, b) => s.updateOccurrence(decodeURIComponent(p.oid), b));
  route('DELETE', /^\/api\/occurrences\/(?<oid>[^/]+)$/, (s, p, b, q) =>
    s.deleteOccurrence(decodeURIComponent(p.oid), q.get('scope') || 'this'));
  route('POST', /^\/api\/occurrences\/(?<oid>[^/]+)\/coverage$/, (s, p, b) =>
    s.assignCoverage(decodeURIComponent(p.oid), b));
  route('POST', /^\/api\/occurrences\/(?<oid>[^/]+)\/restore$/, (s, p) =>
    s.restoreOccurrence(decodeURIComponent(p.oid)));

  async function serveStatic(pathname, res) {
    const base = pathname.startsWith('/shared/') ? '/shared/' : '/';
    const dir = STATIC_DIRS[base];
    const rel = pathname.slice(base.length) || 'index.html';
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
    const url = new URL(req.url, 'http://localhost');
    // Vercel routes /api/* to one function and passes the original path.
    let pathname = url.pathname;
    if (url.searchParams.has('__path')) {
      pathname = `/api/${url.searchParams.get('__path')}`;
      url.searchParams.delete('__path');
    }
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        return await serveStatic(pathname, res);
      }
      const auth = authState(req);
      if (auth === 'unconfigured') {
        return send(res, 503, { error: 'Set APP_USER and APP_PASSWORD in the Vercel project settings, then redeploy.', code: 'auth_unconfigured' });
      }
      // No WWW-Authenticate header: the page shows its own sign-in form.
      if (auth === 'denied') return send(res, 401, { error: 'Sign in required.', code: 'auth_required' });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(pathname);
        if (!m) continue;
        const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
        const store = await storeReady;
        const result = await r.handler(store, m.groups || {}, body, url.searchParams);
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
  const target = databaseTarget();
  const store = new Store(await openDb(target));
  const port = Number(process.env.PORT) || 3000;
  createServer(createApp(store)).listen(port, () => {
    const where = /^postgres/.test(target) ? 'Postgres' : target;
    console.log(`Nurse schedule running at http://localhost:${port}  (data: ${where})`);
  });
}
