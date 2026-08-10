'use strict';

const express = require('express');
const { hashPassword } = require('../auth');
const { isUniqueViolation } = require('../db');

const MAX_RATE_CENTS = 10_000_000; // $100,000/hr — generous sanity bound
const MIN_PASSWORD_LENGTH = 8;

function parseRateCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_RATE_CENTS) return null;
  return Math.round(n);
}

module.exports = function employeeRoutes({ data, auth, broadcast }) {
  const router = express.Router();

  router.get('/', auth.requireAdmin, async (_req, res, next) => {
    try {
      const rows = await data.getEmployees();
      res.json(rows.map((e) => ({ ...e, is_admin: !!e.is_admin })));
    } catch (err) {
      next(err);
    }
  });

  router.post('/', auth.requireAdmin, async (req, res, next) => {
    try {
      const { name, username, password, hourly_rate_cents, is_admin } = req.body || {};
      const rate = parseRateCents(hourly_rate_cents);
      if (!name || !username || !password || rate == null) {
        return res.status(400).json({ error: 'name, username, password, hourly_rate_cents required' });
      }
      if (String(password).length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      const id = await data.insertEmployee({
        name: String(name),
        username: String(username).toLowerCase(),
        password_hash: hashPassword(String(password)),
        hourly_rate_cents: rate,
        is_admin: is_admin ? 1 : 0,
      });
      broadcast();
      res.status(201).json({ id });
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'username taken' });
      next(err);
    }
  });

  router.patch('/:id', auth.requireAdmin, async (req, res, next) => {
    try {
      const emp = await data.getEmployee(Number(req.params.id));
      if (!emp) return res.status(404).json({ error: 'no such employee' });
      const { name, hourly_rate_cents, password } = req.body || {};
      const fields = {};
      if (name != null) fields.name = String(name);
      if (hourly_rate_cents != null) {
        const rate = parseRateCents(hourly_rate_cents);
        if (rate == null) return res.status(400).json({ error: 'invalid hourly_rate_cents' });
        // NOTE: open sessions keep their rate snapshot; new rate applies to future clock-ins
        fields.hourly_rate_cents = rate;
      }
      if (password != null) {
        if (String(password).length < MIN_PASSWORD_LENGTH) {
          return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }
        fields.password_hash = hashPassword(String(password));
      }
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to update' });
      await data.updateEmployee(emp.id, fields);
      broadcast();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
