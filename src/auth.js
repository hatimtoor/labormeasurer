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
  const candidateBuf = crypto.scryptSync(password, salt, 32);
  const hashBuf = Buffer.from(hash, 'hex');
  if (candidateBuf.length !== hashBuf.length) return false; // corrupted hash → clean 401, not a 500
  return crypto.timingSafeEqual(candidateBuf, hashBuf);
}

// burn the same scrypt cost when the username doesn't exist, so response
// timing can't be used to enumerate valid usernames
function burnScrypt(password) {
  crypto.scryptSync(String(password ?? ''), 'timing-equalizer-salt', 32);
}

async function getSecret(data) {
  const existing = await data.getSetting('cookie_secret');
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('hex');
  await data.setSetting('cookie_secret', secret);
  return (await data.getSetting('cookie_secret')) || secret;
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
async function createAuth(data) {
  const secret = await getSecret(data);

  function attachUser(req, _res, next) {
    const id = parseCookie(readCookies(req)[COOKIE_NAME], secret);
    if (id == null) {
      req.user = null;
      return next();
    }
    // data.getEmployee never includes password_hash
    data
      .getEmployee(id)
      .then((user) => {
        req.user = user || null;
        next();
      })
      .catch(next);
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

  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';

  function setLoginCookie(res, employeeId) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${makeCookie(employeeId, secret)}; HttpOnly; Path=/; SameSite=Lax${secureFlag}; Max-Age=${SESSION_TTL_MS / 1000}`
    );
  }

  function clearLoginCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  }

  return { attachUser, requireAuth, requireAdmin, setLoginCookie, clearLoginCookie };
}

module.exports = { createAuth, hashPassword, verifyPassword, burnScrypt, COOKIE_NAME };
