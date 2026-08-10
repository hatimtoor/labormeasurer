'use strict';

const express = require('express');
const { hashPassword } = require('../auth');

function parseRateCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

module.exports = function employeeRoutes({ db, store, auth, broadcast }) {
  const router = express.Router();

  router.get('/', auth.requireAdmin, (_req, res) => {
    res.json(store.q.employees.all().map((e) => ({ ...e, is_admin: !!e.is_admin })));
  });

  router.post('/', auth.requireAdmin, (req, res) => {
    const { name, username, password, hourly_rate_cents, is_admin } = req.body || {};
    const rate = parseRateCents(hourly_rate_cents);
    if (!name || !username || !password || rate == null) {
      return res.status(400).json({ error: 'name, username, password, hourly_rate_cents required' });
    }
    try {
      const info = db
        .prepare(
          'INSERT INTO employees (name, username, password_hash, hourly_rate_cents, is_admin) VALUES (?, ?, ?, ?, ?)'
        )
        .run(String(name), String(username).toLowerCase(), hashPassword(String(password)), rate, is_admin ? 1 : 0);
      broadcast();
      res.status(201).json({ id: info.lastInsertRowid });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'username taken' });
      throw err;
    }
  });

  router.patch('/:id', auth.requireAdmin, (req, res) => {
    const emp = store.q.employee.get(Number(req.params.id));
    if (!emp) return res.status(404).json({ error: 'no such employee' });
    const { name, hourly_rate_cents, password } = req.body || {};
    const updates = [];
    const params = [];
    if (name != null) { updates.push('name = ?'); params.push(String(name)); }
    if (hourly_rate_cents != null) {
      const rate = parseRateCents(hourly_rate_cents);
      if (rate == null) return res.status(400).json({ error: 'invalid hourly_rate_cents' });
      // NOTE: open sessions keep their rate snapshot; new rate applies to future clock-ins
      updates.push('hourly_rate_cents = ?'); params.push(rate);
    }
    if (password != null) { updates.push('password_hash = ?'); params.push(hashPassword(String(password))); }
    if (!updates.length) return res.status(400).json({ error: 'nothing to update' });
    db.prepare(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`).run(...params, emp.id);
    broadcast();
    res.json({ ok: true });
  });

  return router;
};
