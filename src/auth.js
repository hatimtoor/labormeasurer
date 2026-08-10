'use strict';

const crypto = require('crypto');

// Password hashing: scrypt (built-in, no native deps beyond better-sqlite3).
// Cookie: stateless HMAC-signed "id.expiry.sig" so server restarts keep users
// logged in and no session table is needed.

const COOKIE_NAME = 'lm_session';
const SESSION_TTL_MS = 7 * 24 * 3_600_000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

function getSecret(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cookie_secret'").get();
  if (row) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('cookie_secret', ?)").run(secret);
  return secret;
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function makeCookie(employeeId, secret) {
  const payload = `${employeeId}.${Date.now() + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload, secret)}`;
}

function parseCookie(raw, secret) {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload, secret);
  const given = parts[2];
  if (expected.length !== given.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return Number(parts[0]);
}

function readCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

// middleware factory: attaches req.user (employee row) when the cookie is valid
function createAuth(db) {
  const secret = getSecret(db);
  const getEmployee = db.prepare('SELECT * FROM employees WHERE id = ?');

  function attachUser(req, _res, next) {
    const id = parseCookie(readCookies(req)[COOKIE_NAME], secret);
    req.user = id != null ? getEmployee.get(id) || null : null;
    next();
  }

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'not logged in' });
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'not logged in' });
    if (!req.user.is_admin) return res.status(403).json({ error: 'admin only' });
    next();
  }

  function setLoginCookie(res, employeeId) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${makeCookie(employeeId, secret)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
    );
  }

  function clearLoginCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  }

  return { attachUser, requireAuth, requireAdmin, setLoginCookie, clearLoginCookie };
}

module.exports = { createAuth, hashPassword, verifyPassword, COOKIE_NAME };
