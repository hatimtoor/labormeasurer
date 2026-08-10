'use strict';

require('dotenv').config();

const { createSystemClock } = require('./clock');
const { createApp } = require('./app');
const { openDatabase } = require('./backend');

async function main() {
  const { data, label } = await openDatabase();
  const clock = await createSystemClock(data);
  const app = await createApp({ data, clock });

  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, async () => {
    console.log(`LaborMeasurer running at http://localhost:${port} [${label}]`);
    if ((await data.countEmployees()) === 0) {
      console.log('No users yet — run `npm run seed` for demo data (admin/admin).');
    }
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async () => {
      await data.close();
      process.exit(0);
    });
    // open SSE streams keep the server alive — force-exit shortly after
    setTimeout(async () => {
      try { await data.close(); } catch { /* already closed */ }
      process.exit(0);
    }, 2000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
