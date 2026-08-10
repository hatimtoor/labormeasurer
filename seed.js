'use strict';

// Demo reset: wipes all data and creates the challenge scenario.
//   admin / admin        (manager, $0/hr)
//   workera / worker     Worker A, $20/hr
//   workerb / worker     Worker B, $25/hr
//   Task "Frame Unit 101" with a $1,000 labor budget, both workers assigned.
// Works against whichever backend .env selects (Supabase REST, direct
// Postgres, or local SQLite). Restart the server afterwards so its cached
// time-warp offset and cookie secret reload.

require('dotenv').config();

const { hashPassword } = require('./src/auth');
const { openDatabase } = require('./src/backend');

async function main() {
  const { data, label } = await openDatabase();

  await data.wipeAll();

  const employees = [
    { name: 'Site Manager', username: 'admin', password: 'admin', hourly_rate_cents: 0, is_admin: 1 },
    { name: 'Worker A', username: 'workera', password: 'worker', hourly_rate_cents: 2000, is_admin: 0 },
    { name: 'Worker B', username: 'workerb', password: 'worker', hourly_rate_cents: 2500, is_admin: 0 },
  ];
  const ids = {};
  for (const { password, ...emp } of employees) {
    ids[emp.username] = await data.insertEmployee({ ...emp, password_hash: hashPassword(password) });
  }

  const taskId = await data.insertTask({
    name: 'Frame Unit 101',
    budget_cents: 100_000,
    show_countdown_to_employees: 1,
  });
  await data.replaceAssignments(taskId, [ids.workera, ids.workerb], Date.now());

  await data.close();

  console.log(`Seeded demo data into ${label}`);
  console.log('NOTE: demo credentials are for local demos only — change them before any network deployment.');
  console.log('  admin   / admin   (manager)');
  console.log('  workera / worker  ($20/hr)');
  console.log('  workerb / worker  ($25/hr)');
  console.log('  Task "Frame Unit 101" — $1,000 labor budget');
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
