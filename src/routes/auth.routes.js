'use strict';

const express = require('express');
const { verifyPassword } = require('../auth');

module.exports = function authRoutes({ db, auth }) {
  const router = express.Router();
  const byUsername = db.prepare('SELECT * FROM employees WHERE username = ?');

  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = username ? byUsername.get(String(username).toLowerCase()) : null;
    if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
      return res.status(401).json({ error: 'invalid username or password' });
    }
    auth.setLoginCookie(res, user.id);
    res.json({ id: user.id, name: user.name, is_admin: !!user.is_admin });
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
