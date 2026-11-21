import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, getJwtSecret, currentSlug } from './db.js';

export const SESSION_COOKIE = 'bh_session';
const SESSION_HOURS = 12;
const JWT_SECRET = getJwtSecret();
const IS_PROD = process.env.NODE_ENV === 'production';

export const ROLE_RANK = { staff: 1, manager: 2, owner: 3 };

/* ---------- PIN hashing ---------- */
export const hashPin = (pin) => bcrypt.hash(pin, 12);

/** Find the active user whose PIN matches. PINs are unique, so at most one matches. */
export async function findUserByPin(pin) {
  const users = db.prepare('SELECT * FROM users WHERE active = 1').all();
  let match = null;
  // Compare against every user (no early exit) so timing doesn't reveal position.
  for (const u of users) {
    if (await bcrypt.compare(pin, u.pin_hash)) match = match || u;
  }
  return match;
}

export async function pinInUse(pin, exceptId = null) {
  const users = db.prepare('SELECT id, pin_hash FROM users WHERE active = 1').all();
  for (const u of users) {
    if (u.id !== exceptId && (await bcrypt.compare(pin, u.pin_hash))) return true;
  }
  return false;
}

const WEAK = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '1212', '6969', '1004', '2000', '2580', '00000', '12345', '000000', '111111', '123456', '654321', '123123']);
export function pinProblem(pin) {
  if (!/^\d{4,8}$/.test(pin)) return 'PIN must be 4–8 digits';
  if (WEAK.has(pin)) return 'That PIN is too easy to guess';
  if (/^(\d)\1+$/.test(pin)) return 'PIN cannot be one repeated digit';
  return null;
}

/* ---------- Brute-force protection (per IP, escalating lockout) ---------- */
const attempts = new Map(); // ip -> { fails, lockedUntil, lastFail }
const MAX_FAILS = 5;

export function loginBlocked(ip) {
  const a = attempts.get(ip);
  if (!a) return 0;
  const left = a.lockedUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export function recordLoginFail(ip) {
  const a = attempts.get(ip) || { fails: 0, lockedUntil: 0, strikes: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) {
    a.strikes += 1;
    // 30s, 2m, 8m, 32m ... capped at 1h
    a.lockedUntil = Date.now() + Math.min(30_000 * 4 ** (a.strikes - 1), 3_600_000);
    a.fails = 0;
  }
  a.lastFail = Date.now();
  attempts.set(ip, a);
  const lockedFor = loginBlocked(ip);
  return { remaining: lockedFor ? 0 : MAX_FAILS - a.fails, lockedFor };
}

export const clearLoginFails = (ip) => attempts.delete(ip);

setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (a.lockedUntil < now && now - a.lastFail > 3_600_000) attempts.delete(ip);
}, 600_000).unref();

/* ---------- Sessions ---------- */
export function issueSession(res, user) {
  const token = jwt.sign({ typ: 's', loc: currentSlug(), uid: user.id, sv: user.session_version }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: SESSION_HOURS * 3600 * 1000,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: IS_PROD, sameSite: 'strict', path: '/' });
}

export function userFromToken(token) {
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.typ && p.typ !== 's') return null;
    if ((p.loc || 'main') !== currentSlug()) return null;
    const u = db.prepare('SELECT id, name, role, session_version, active FROM users WHERE id = ?').get(p.uid);
    if (!u || !u.active || u.session_version !== p.sv) return null;
    return { id: u.id, name: u.name, role: u.role };
  } catch {
    return null;
  }
}

/* ---------- Middleware ---------- */
export function requireAuth(minRole = 'staff') {
  return (req, res, next) => {
    const user = userFromToken(req.cookies?.[SESSION_COOKIE]);
    if (!user) return res.status(401).json({ error: 'Locked' });
    if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) return res.status(403).json({ error: 'Not allowed for your role' });
    req.user = user;
    next();
  };
}

/**
 * CSRF defence: every state-changing request must carry a custom header.
 * Browsers can't send custom headers cross-origin without a CORS preflight, which we never approve.
 * Combined with SameSite=Strict cookies.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/stripe/webhook') return next();
  if (req.get('X-BuzzHub') !== '1') return res.status(403).json({ error: 'Bad request origin' });
  next();
}

export const newGuestToken = () => crypto.randomBytes(18).toString('base64url');
export const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/* ---------- Customer accounts (separate cookie + token type) ---------- */
export const CUSTOMER_COOKIE = 'bh_customer';
const CUSTOMER_DAYS = 60;

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters';
  if (pw.length > 128) return 'Password is too long';
  if (/^(.)\1+$/.test(pw) || ['password', '12345678', 'qwertyui', '11111111'].includes(pw.toLowerCase())) return 'Pick a harder password';
  return null;
}
export const hashPassword = (pw) => bcrypt.hash(pw, 12);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);
// Equalise timing when the email doesn't exist
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);
export const burnCompare = (pw) => bcrypt.compare(pw, DUMMY_HASH);

export function issueCustomerSession(res, c) {
  const token = jwt.sign({ typ: 'c', loc: currentSlug(), cid: c.id, sv: c.session_version }, JWT_SECRET, { expiresIn: `${CUSTOMER_DAYS}d` });
  res.cookie(CUSTOMER_COOKIE, token, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: CUSTOMER_DAYS * 86400 * 1000, path: '/' });
}
export function clearCustomerSession(res) {
  res.clearCookie(CUSTOMER_COOKIE, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', path: '/' });
}
export function customerFromReq(req) {
  const token = req.cookies?.[CUSTOMER_COOKIE];
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.typ !== 'c' || (p.loc || 'main') !== currentSlug()) return null;
    const c = db.prepare('SELECT id, name, email, phone, session_version FROM customers WHERE id = ?').get(p.cid);
    if (!c || c.session_version !== p.sv) return null;
    return { id: c.id, name: c.name, email: c.email, phone: c.phone };
  } catch { return null; }
}
export function requireCustomer(req, res, next) {
  const c = customerFromReq(req);
  if (!c) return res.status(401).json({ error: 'Please sign in' });
  req.customer = c; next();
}

/** Location claim inside a cookie token, without trusting anything else in it. */
export function locOfToken(token) {
  try { const p = jwt.verify(token, JWT_SECRET); return p.loc || 'main'; } catch { return null; }
}
