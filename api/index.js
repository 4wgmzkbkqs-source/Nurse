// Vercel serverless entry: every /api/* request is rewritten here (see
// vercel.json). The database connection is opened once per instance.
import { createApp, databaseTarget } from '../server/index.js';
import { openDb, isPostgresUrl } from '../server/db.js';
import { Store } from '../server/store.js';

let app = null;

function getApp() {
  if (!app) {
    const target = databaseTarget();
    if (!isPostgresUrl(target)) {
      throw new Error('No database configured. Connect a Supabase database to this Vercel project (Storage tab) or set DATABASE_URL.');
    }
    const store = openDb(target).then((db) => new Store(db));
    // If connecting fails, try again on the next request.
    store.catch(() => { app = null; });
    app = createApp(store);
  }
  return app;
}

export default async function handler(req, res) {
  let h;
  try {
    h = getApp();
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: e.message, code: 'db_unconfigured' }));
  }
  return h(req, res);
}
