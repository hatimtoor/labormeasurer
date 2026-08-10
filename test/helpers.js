'use strict';

const { openDb } = require('../src/db');
const { createFakeClock } = require('../src/clock');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const HOUR_MS = 3_600_000;

function createTestApp() {
  const db = openDb(':memory:');
  const clock = createFakeClock(1_000_000); // arbitrary fixed epoch
  const app = createApp({ db, clock });
  return { db, clock, app };
}

function createEmployee(db, { name, username, password = 'pw', rateCents = 0, isAdmin = false }) {
  const info = db
    .prepare(
      'INSERT INTO employees (name, username, password_hash, hourly_rate_cents, is_admin) VALUES (?, ?, ?, ?, ?)'
    )
    .run(name, username, hashPassword(password), rateCents, isAdmin ? 1 : 0);
  return Number(info.lastInsertRowid);
}

async function login(request, app, username, password = 'pw') {
  const res = await request(app).post('/api/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return res.headers['set-cookie'][0].split(';')[0];
}

module.exports = { createTestApp, createEmployee, login, HOUR_MS };
