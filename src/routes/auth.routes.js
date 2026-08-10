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

module.exports = function authRoutes({ db, auth }) {
  const router = express.Router();
  const allowAttempt = createLoginLimiter();

  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      const key = `${String(username ?? '').toLowerCase()}|${req.ip}`;
      if (!allowAttempt(key, Date.now())) {
        return res.status(429).json({ error: 'too many login attempts — try again in 15 minutes' });
      }
      const user = username
        ? await db.get('SELECT * FROM employees WHERE username = ?', [String(username).toLowerCase()])
        : null;
      if (!user) {
        burnScrypt(password);
        return res.status(401).json({ error: 'invalid username or password' });
      }
      if (!verifyPassword(String(password ?? ''), user.password_hash)) {
        return res.status(401).json({ error: 'invalid username or password' });
      }
      auth.setLoginCookie(res, user.id);
      res.json({ id: user.id, name: user.name, is_admin: !!user.is_admin });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res) => {
    auth.clearLoginCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', auth.requireAuth, (req, res) => {
    const { id, name, username, hourly_rate_cents, is_admin } = req.user;
    res.json({ id, name, username, hourly_rate_cents, is_admin: !!is_admin });
  });

  return router;
};
