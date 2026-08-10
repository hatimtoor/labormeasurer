'use strict';

// Demo reset: wipes all data and creates the challenge scenario.
//   admin / admin        (manager, $0/hr)
//   workera / worker     Worker A, $20/hr
//   workerb / worker     Worker B, $25/hr
//   Task "Frame Unit 101" with a $1,000 labor budget, both workers assigned.
// Works against whichever backend .env selects (Supabase Postgres or SQLite).

require('dotenv').config();

const fs = require('fs');
const { hashPassword } = require('./src/auth');
const { openDatabase } = require('./src/backend');

async function main() {
  const usingPg = !!(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL);

  if (!usingPg) {
    // fresh SQLite file
    const file = process.env.LM_DB || 'labormeasurer.db';
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
      }
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        console.error(`Cannot reset ${file} — it is in use. Stop the server (npm start) first, then re-run npm run seed.`);
        process.exit(1);
      }
      throw err;
    }
  }

  const { db, label } = await openDatabase();

  if (usingPg) {
    // wipe rows but keep the schema (order respects foreign keys)
    for (const table of ['sessions', 'assignments', 'tasks', 'employees', 'settings']) {
      await db.run(`DELETE FROM ${table}`);
    }
  }

  const emp = (name, username, password, rate, isAdmin) =>
    db.get(
      'INSERT INTO employees (name, username, password_hash, hourly_rate_cents, is_admin) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [name, username, hashPassword(password), rate, isAdmin ? 1 : 0]
    );

  await emp('Site Manager', 'admin', 'admin', 0, true);
  const a = (await emp('Worker A', 'workera', 'worker', 2000, false)).id;
  const b = (await emp('Worker B', 'workerb', 'worker', 2500, false)).id;

  const task = (
    await db.get(
      'INSERT INTO tasks (name, budget_cents, show_countdown_to_employees) VALUES (?, ?, 1) RETURNING id',
      ['Frame Unit 101', 100_000]
    )
  ).id;

  await db.run('INSERT INTO assignments (task_id, employee_id) VALUES (?, ?)', [task, a]);
  await db.run('INSERT INTO assignments (task_id, employee_id) VALUES (?, ?)', [task, b]);

  await db.close();

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
