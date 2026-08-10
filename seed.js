'use strict';

// Demo reset: wipes the database and creates the challenge scenario.
//   admin / admin        (manager, $0/hr)
//   workera / worker     Worker A, $20/hr
//   workerb / worker     Worker B, $25/hr
//   Task "Frame Unit 101" with a $1,000 labor budget, both workers assigned.

const fs = require('fs');
const { openDb } = require('./src/db');
const { hashPassword } = require('./src/auth');

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

const db = openDb(file);

const emp = db.prepare(
  'INSERT INTO employees (name, username, password_hash, hourly_rate_cents, is_admin) VALUES (?, ?, ?, ?, ?)'
);
emp.run('Site Manager', 'admin', hashPassword('admin'), 0, 1);
const a = emp.run('Worker A', 'workera', hashPassword('worker'), 2000, 0).lastInsertRowid;
const b = emp.run('Worker B', 'workerb', hashPassword('worker'), 2500, 0).lastInsertRowid;

const task = db
  .prepare('INSERT INTO tasks (name, budget_cents, show_countdown_to_employees) VALUES (?, ?, 1)')
  .run('Frame Unit 101', 100_000).lastInsertRowid;

const assign = db.prepare('INSERT INTO assignments (task_id, employee_id) VALUES (?, ?)');
assign.run(task, a);
assign.run(task, b);

db.close();

console.log('Seeded demo data into', file);
console.log('NOTE: demo credentials are for local demos only — change them before any network deployment.');
console.log('  admin   / admin   (manager)');
console.log('  workera / worker  ($20/hr)');
console.log('  workerb / worker  ($25/hr)');
console.log('  Task "Frame Unit 101" — $1,000 labor budget');
