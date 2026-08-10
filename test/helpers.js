'use strict';

const { createSqliteAdapter } = require('../src/db');
const { createSqlData } = require('../src/data-sql');
const { createFakeClock } = require('../src/clock');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const HOUR_MS = 3_600_000;

// Tests always run on in-memory SQLite — fast, isolated, and they never touch
// the Supabase project configured in .env.
async function createTestApp() {
  const data = createSqlData(createSqliteAdapter(':memory:'));
  const clock = createFakeClock(1_000_000); // arbitrary fixed epoch
  const app = await createApp({ data, clock });
  return { data, clock, app };
}

async function createEmployee(data, { name, username, password = 'pw', rateCents = 0, isAdmin = false }) {
  const id = await data.insertEmployee({
    name,
    username,
    password_hash: hashPassword(password),
    hourly_rate_cents: rateCents,
    is_admin: isAdmin ? 1 : 0,
  });
  return Number(id);
}

async function login(request, app, username, password = 'pw') {
  const res = await request(app).post('/api/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return res.headers['set-cookie'][0].split(';')[0];
}

module.exports = { createTestApp, createEmployee, login, HOUR_MS };
