'use strict';

const express = require('express');
const { verifyPassword, burnScrypt } = require('../auth');

// Small fixed-window rate limiter for login: 10 attempts / 15 min per
// username+IP. In-memory — resets on restart, which is fine at this scale.
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

function createLoginLimiter() {
  const attempts = new Map(); // key -> {count, windowStart}
  return function check(key, nowMs) {
    const entry = attempts.get(key);
    if (!entry || nowMs - entry.windowStart > WINDOW_MS) {
      attempts.set(key, { count: 1, windowStart: nowMs });
      if (attempts.size > 10_000) attempts.clear(); // crude memory bound
      return true;
    }
    entry.count += 1;
    return entry.count <= MAX_ATTEMPTS;
  };
}

module.exports = function authRoutes({ data, auth, audit }) {
  const router = express.Router();
  const allowAttempt = createLoginLimiter();

  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      const key = `${String(username ?? '').toLowerCase()}|${req.ip}`;
      if (!allowAttempt(key, Date.now())) {
        return res.status(429).json({ error: 'too many login attempts — try again in 15 minutes' });
      }
      const user = username ? await data.getEmployeeByUsername(String(username).toLowerCase()) : null;
      if (!user) {
        burnScrypt(password);
        return res.status(401).json({ error: 'invalid username or password' });
      }
      if (!verifyPassword(String(password ?? ''), user.password_hash)) {
        audit(req, 'auth.login_failed', 'employee', user.id, { username: user.username });
        return res.status(401).json({ error: 'invalid username or password' });
      }
      await auth.issueSession(res, user.id);
      audit({ user }, 'auth.login', 'employee', user.id, null);
      res.json({ id: user.id, name: user.name, is_admin: !!user.is_admin });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await auth.revokeCurrentSession(req, res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', auth.requireAuth, (req, res) => {
    const { id, name, username, hourly_rate_cents, is_admin } = req.user;
    res.json({ id, name, username, hourly_rate_cents, is_admin: !!is_admin });
  });

  return router;
};
