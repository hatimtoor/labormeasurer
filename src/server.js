'use strict';

const { openDb } = require('./db');
const { createSystemClock } = require('./clock');
const { createApp } = require('./app');

const db = openDb(process.env.LM_DB || 'labormeasurer.db');
const clock = createSystemClock(db);
const app = createApp({ db, clock });

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`LaborMeasurer running at http://localhost:${port}`);
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM employees').get().n > 0;
  if (!hasUsers) console.log('No users yet — run `npm run seed` for demo data (admin/admin).');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // open SSE streams keep the server alive — force-exit shortly after
  setTimeout(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  }, 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
