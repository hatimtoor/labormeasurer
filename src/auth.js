'use strict';

const crypto = require('crypto');

// Password hashing: scrypt (built-in, no native deps beyond better-sqlite3).
// Sessions: server-side rows in auth_sessions — the cookie carries a random
// token whose SHA-256 hash is stored, so a database leak exposes no usable
// tokens, and logout / password change revoke sessions instantly.

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

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
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

async function createAuth(data) {
  // Short-lived cache: against a REST backend every request would otherwise
  // cost network round-trips to resolve the cookie. 5s bounds how stale a
  // revocation can be — an acceptable trade for interactive latency.
  const CACHE_TTL_MS = 5000;
  const sessionCache = new Map(); // tokenHash -> {user, at}

  async function resolveSession(tokenHash) {
    const hit = sessionCache.get(tokenHash);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.user;
    let user = null;
    const session = await data.getAuthSession(tokenHash);
    if (session && !session.revoked && Number(session.expires_ms) > Date.now()) {
      user = (await data.getEmployee(session.employee_id)) || null;
    }
    sessionCache.set(tokenHash, { user, at: Date.now() });
    if (sessionCache.size > 5000) sessionCache.clear();
    return user;
  }

  function attachUser(req, _res, next) {
    const token = readCookies(req)[COOKIE_NAME];
    if (!token) {
      req.user = null;
      return next();
    }
    const tokenHash = hashToken(token);
    resolveSession(tokenHash)
      .then((user) => {
        req.user = user;
        req.sessionTokenHash = tokenHash;
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

  async function issueSession(res, employeeId) {
    const token = crypto.randomBytes(32).toString('hex');
    await data.createAuthSession({
      token_hash: hashToken(token),
      employee_id: employeeId,
      created_ms: Date.now(),
      expires_ms: Date.now() + SESSION_TTL_MS,
    });
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax${secureFlag}; Max-Age=${SESSION_TTL_MS / 1000}`
    );
  }

  async function revokeCurrentSession(req, res) {
    if (req.sessionTokenHash) {
      await data.revokeAuthSession(req.sessionTokenHash);
      sessionCache.delete(req.sessionTokenHash);
    }
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax${secureFlag}; Max-Age=0`);
  }

  // password change / employee delete: kill every session for that user
  async function revokeAllFor(employeeId) {
    await data.revokeAllAuthSessionsFor(employeeId);
    sessionCache.clear();
  }

  return { attachUser, requireAuth, requireAdmin, issueSession, revokeCurrentSession, revokeAllFor };
}

module.exports = { createAuth, hashPassword, verifyPassword, burnScrypt, COOKIE_NAME };
