'use strict';

const { createSqliteAdapter } = require('../src/db');
const { createFakeClock } = require('../src/clock');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const HOUR_MS = 3_600_000;

// Tests always run on in-memory SQLite — fast, isolated, and they never touch
// the Supabase project configured in .env.
async function createTestApp() {
  const db = createSqliteAdapter(':memory:');
  const clock = createFakeClock(1_000_000); // arbitrary fixed epoch
  const app = await createApp({ db, clock });
  return { db, clock, app };
}

async function createEmployee(db, { name, username, password = 'pw', rateCents = 0, isAdmin = false }) {
  const row = await db.get(
    'INSERT INTO employees (name, username, password_hash, hourly_rate_cents, is_admin) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [name, username, hashPassword(password), rateCents, isAdmin ? 1 : 0]
  );
  return Number(row.id);
}

async function login(request, app, username, password = 'pw') {
  const res = await request(app).post('/api/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return res.headers['set-cookie'][0].split(';')[0];
}

module.exports = { createTestApp, createEmployee, login, HOUR_MS };
