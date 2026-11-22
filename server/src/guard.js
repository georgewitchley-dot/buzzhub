// Batch 2: owner/manager two-step codes (TOTP), approved devices, manager approval for risky actions,
// refunds, and security alerts pushed to owners' phones.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, getJwtSecret, registerSchema, forEachLocation, currentSlug } from './db.js';
import { ROLE_RANK, SESSION_COOKIE, userFromToken } from './security.js';

const SECRET = getJwtSecret();
const IS_PROD = process.env.NODE_ENV === 'production';
const KEY = crypto.createHash('sha256').update(`buzzhub-totp:${SECRET}`).digest();

/* ---------- schema ---------- */
registerSchema((db) => {
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('users').includes('totp_secret')) db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
if (!cols('users').includes('totp_enabled')) db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
if (!cols('users').includes('totp_last_step')) db.exec('ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0');
if (!cols('push_subs').includes('user_id')) db.exec('ALTER TABLE push_subs ADD COLUMN user_id INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS recovery_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL UNIQUE, name TEXT, user_agent TEXT, ip TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','blocked')),
  code TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT, approved_by INTEGER
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, reason TEXT,
  method TEXT, user_id INTEGER, approved_by INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

});
/* ---------- AES-GCM for TOTP secrets at rest ---------- */
const seal = (plain) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY, iv); const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.'); };
const open = (box) => { const [iv, tag, enc] = box.split('.').map((s) => Buffer.from(s, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); };

/* ---------- TOTP (RFC 6238) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = (buf) => { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; };
const b32decode = (s) => { let bits = 0, val = 0; const out = []; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
function hotp(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** Returns the matched time step, or 0. Accepts ±1 step for clock drift. */
function checkTotp(secret, code, lastStep) {
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue; // no replays
    const a = Buffer.from(hotp(secret, s)); const b = Buffer.from(String(code).padStart(6, '0').slice(0, 6));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return s;
  }
  return 0;
}
function verifySecondFactor(user, code) {
  code = String(code || '').replace(/\s|-/g, '');
  if (/^\d{6}$/.test(code)) {
    const s = checkTotp(open(user.totp_secret), code, user.totp_last_step);
    if (s) { db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(s, user.id); return 'totp'; }
    return null;
  }
  if (/^[a-z0-9]{10}$/i.test(code)) {
    for (const r of db.prepare('SELECT * FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').all(user.id)) {
      if (bcrypt.compareSync(code.toLowerCase(), r.code_hash)) { db.prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?").run(r.id); return 'recovery'; }
    }
  }
  return null;
}

/* ---------- device identity ---------- */
const DEVICE_COOKIE = 'bh_device';
const TRUST_COOKIE = 'bh_2fa';
export function deviceIdOf(req, res) {
  let id = req.cookies?.[DEVICE_COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{22,40}$/.test(id)) {
    id = crypto.randomBytes(18).toString('base64url');
    res.cookie(DEVICE_COOKIE, id, { httpOnly: true, secure: IS_PROD, sameSite: 'strict', maxAge: 400 * 86400 * 1000, path: '/' });
  }
  return id;
}
const deviceLabel = (ua = '') => {
  const os = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /CrOS/.test(ua) ? 'Chromebook' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${os}${br ? `, ${br}` : ''}`;
};

// forget device requests nobody approved within 14 days
setInterval(() => forEachLocation(() => db.prepare("DELETE FROM devices WHERE status = 'pending' AND COALESCE(last_seen, created_at) < datetime('now','-14 days')").run()), 6 * 3600_000).unref();

export function registerGuard({ app, staff, io, h }) {
  const { wrap, parse, idParam, now, clientIp, requireAuth, issueSession, findUserByPin, loginBlocked, recordLoginFail, clearLoginFails, authLimiter, notifyStaff, pushToUsers } = h;

  /* ---------- alerts to owners & managers ---------- */
  const recentFails = [];
  async function alertOwners(title, body, tag = 'security') {
    io.to('owners').emit('security', { type: 'alert', detail: body, at: Date.now() });
    await pushToUsers(['owner', 'manager'], { title, body, tag, url: '/security', kind: 'security' }).catch(() => {});
  }
  h.onBadPin = (ip) => {
    const t = Date.now(); recentFails.push({ t, ip });
    while (recentFails.length && t - recentFails[0].t > 5 * 60_000) recentFails.shift();
    const fromIp = recentFails.filter((f) => f.ip === ip).length;
    if (fromIp === 3 || recentFails.length === 6) alertOwners(`${getSettings().business_name}: wrong PINs`, `${fromIp >= 3 ? fromIp : recentFails.length} wrong PIN attempts in the last 5 minutes${fromIp >= 3 ? ` from ${ip}` : ''}.`, 'badpin');
  };
  h.alertOwners = alertOwners;

  /* ---------- the login gate: device approval + two-step ---------- */
  const trustOk = (req, uid) => { try { const p = jwt.verify(req.cookies?.[TRUST_COOKIE] || '', SECRET); return p.typ === '2fa' && p.uid === uid && (p.loc || 'main') === currentSlug(); } catch { return false; } };
  const grantTrust = (res, uid) => res.cookie(TRUST_COOKIE, jwt.sign({ typ: '2fa', loc: currentSlug(), uid }, SECRET, { expiresIn: '12h' }), { httpOnly: true, secure: IS_PROD, sameSite: 'strict', maxAge: 12 * 3600 * 1000, path: '/' });

  function deviceRow(req, res) {
    const did = deviceIdOf(req, res);
    let d = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(did);
    if (!d) {
      const code = String(crypto.randomInt(1000, 9999));
      db.prepare('INSERT INTO devices (device_id, name, user_agent, ip, code) VALUES (?, ?, ?, ?, ?)').run(did, deviceLabel(req.get('user-agent')), (req.get('user-agent') || '').slice(0, 200), clientIp(req), code);
      d = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(did);
    }
    db.prepare('UPDATE devices SET last_seen = ?, ip = ? WHERE id = ?').run(now(), clientIp(req), d.id);
    return d;
  }

  /** Called after a correct PIN. Returns true when the session may be issued; otherwise it has replied. */
  h.authGate = (req, res, user, { secondFactor } = {}) => {
    const s = getSettings();
    const d = deviceRow(req, res);
    const needs2fa = user.totp_enabled && ROLE_RANK[user.role] >= ROLE_RANK.manager && !trustOk(req, user.id);
    if (needs2fa) {
      if (!secondFactor) {
        const ticket = jwt.sign({ typ: '2fa-ticket', loc: currentSlug(), uid: user.id }, SECRET, { expiresIn: '5m' });
        res.json({ needs2fa: true, ticket, name: user.name });
        return false;
      }
      const how = verifySecondFactor(user, secondFactor);
      if (!how) { audit(user, 'auth.2fa_fail', null, clientIp(req)); recordLoginFail(clientIp(req)); res.status(401).json({ error: 'That code is not right. Check the time on your phone and try again.', needs2fa: true }); return false; }
      if (how === 'recovery') alertOwners(`${s.business_name}: recovery code used`, `${user.name} signed in with a one-time recovery code.`);
      grantTrust(res, user.id);
    }
    if (d.status === 'blocked') { audit(user, 'auth.blocked_device', d.name, clientIp(req)); res.status(403).json({ error: 'This device has been blocked by the owner.' }); return false; }
    if (s.require_approved_devices === '1' && d.status !== 'approved') {
      // an owner who just passed two-step can approve their own new device
      if (user.role === 'owner' && user.totp_enabled && (secondFactor || trustOk(req, user.id))) {
        db.prepare("UPDATE devices SET status='approved', approved_by=? WHERE id=?").run(user.id, d.id);
        audit(user, 'device.self_approve', d.name, clientIp(req));
      } else {
        audit(user, 'device.pending', `${d.name} (code ${d.code})`, clientIp(req));
        alertOwners(`${s.business_name}: new device`, `${user.name} is trying to sign in on a new ${d.name}. Code ${d.code}. Approve it in Security.`, 'device');
        notifyStaff('devices');
        res.status(403).json({ error: 'This device needs the owner\'s approval first.', deviceApproval: true, code: d.code });
        return false;
      }
    }
    return true;
  };

  app.post('/api/auth/2fa', authLimiter, wrap(async (req, res) => {
    const { ticket, code } = parse(z.object({ ticket: z.string().max(600), code: z.string().max(20) }), req.body);
    let p; try { p = jwt.verify(ticket, SECRET); } catch { return res.status(401).json({ error: 'That took too long. Enter your PIN again.' }); }
    if (p.typ !== '2fa-ticket' || (p.loc || 'main') !== currentSlug()) return res.status(401).json({ error: 'Enter your PIN again.' });
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(p.uid);
    if (!user) return res.status(401).json({ error: 'Enter your PIN again.' });
    if (!h.authGate(req, res, user, { secondFactor: code })) return;
    clearLoginFails(clientIp(req));
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
    issueSession(res, user);
    audit(user, 'auth.login', 'with two-step code', clientIp(req));
    res.json({ user: { id: user.id, name: user.name, role: user.role } });
  }));

  /* ---------- two-step setup (for the signed-in owner/manager) ---------- */
  staff.get('/security/me', (req, res) => {
    const u = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
    const left = db.prepare('SELECT COUNT(*) c FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(req.user.id).c;
    const alerts = db.prepare('SELECT COUNT(*) c FROM push_subs WHERE user_id = ?').get(req.user.id).c;
    res.json({ twoStep: Boolean(u.totp_enabled), recoveryLeft: left, phoneAlerts: alerts });
  });
  staff.post('/security/2fa/setup', requireAuth('manager'), wrap(async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (u.totp_enabled) return res.status(409).json({ error: 'Two-step sign-in is already on' });
    const secret = b32encode(crypto.randomBytes(20));
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(seal(secret), u.id);
    const label = encodeURIComponent(`${getSettings().business_name}:${u.name}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('BuzzHub')}&algorithm=SHA1&digits=6&period=30`;
    res.json({ secret: secret.match(/.{1,4}/g).join(' '), svg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) });
  }));
  staff.post('/security/2fa/enable', requireAuth('manager'), (req, res) => {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!u.totp_secret || u.totp_enabled) return res.status(409).json({ error: 'Start setup first' });
    const s = checkTotp(open(u.totp_secret), code, 0);
    if (!s) return res.status(400).json({ error: "That code didn't match. Make sure your phone's clock is right." });
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase().padEnd(10, '7'));
    db.transaction(() => {
      db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(s, u.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
      const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
      for (const c of codes) ins.run(u.id, bcrypt.hashSync(c, 10));
    })();
    grantTrust(res, u.id);
    audit(req.user, 'auth.2fa_on', null, clientIp(req));
    res.json({ ok: true, recoveryCodes: codes });
  });
  staff.post('/security/2fa/disable', requireAuth('manager'), (req, res) => {
    const { code } = parse(z.object({ code: z.string().max(20) }), req.body);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!u.totp_enabled) return res.status(409).json({ error: 'Two-step sign-in is off' });
    if (!verifySecondFactor(u, code)) return res.status(400).json({ error: 'That code is not right' });
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
    audit(req.user, 'auth.2fa_off', null, clientIp(req));
    alertOwners(`${getSettings().business_name}: two-step turned off`, `${u.name} turned off two-step sign-in.`);
    res.json({ ok: true });
  });
  // owner can reset another person's two-step (lost phone)
  staff.post('/users/:id/reset-2fa', requireAuth('owner'), (req, res) => {
    const id = idParam(req);
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, session_version = session_version + 1 WHERE id = ?').run(id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id);
    audit(req.user, 'user.reset_2fa', `#${id}`, clientIp(req));
    io.to(`user:${id}`).emit('force-lock');
    res.json({ ok: true });
  });

  /* ---------- devices ---------- */
  staff.get('/security/devices', requireAuth('manager'), (req, res) => {
    const mine = req.cookies?.[DEVICE_COOKIE];
    res.json({ requireApproved: getSettings().require_approved_devices === '1',
      devices: db.prepare('SELECT d.id, d.name, d.ip, d.status, d.code, d.created_at, d.last_seen, d.device_id = ? AS this_device, u.name approved_by_name FROM devices d LEFT JOIN users u ON u.id = d.approved_by ORDER BY d.status = \'pending\' DESC, d.last_seen DESC LIMIT 100').all(mine || '') });
  });
  staff.post('/security/devices/:id', requireAuth('owner'), (req, res) => {
    const b = parse(z.object({ status: z.enum(['approved', 'blocked', 'pending']).optional(), name: z.string().trim().min(1).max(40).optional() }), req.body);
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(idParam(req)); if (!d) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE devices SET status = COALESCE(?, status), name = COALESCE(?, name), approved_by = CASE WHEN ? = \'approved\' THEN ? ELSE approved_by END WHERE id = ?').run(b.status || null, b.name || null, b.status || '', req.user.id, d.id);
    audit(req.user, `device.${b.status || 'rename'}`, b.name || d.name, clientIp(req));
    notifyStaff('devices'); res.json({ ok: true });
  });
  staff.post('/security/require-devices', requireAuth('owner'), (req, res) => {
    const { on } = parse(z.object({ on: z.boolean() }), req.body);
    if (on) { // approve the device turning it on, so the owner can't lock themselves out
      const did = deviceIdOf(req, res);
      db.prepare("INSERT INTO devices (device_id, name, user_agent, ip, status, approved_by) VALUES (?, ?, ?, ?, 'approved', ?) ON CONFLICT(device_id) DO UPDATE SET status='approved', approved_by=excluded.approved_by")
        .run(did, deviceLabel(req.get('user-agent')), (req.get('user-agent') || '').slice(0, 200), clientIp(req), req.user.id);
    }
    setSettings({ require_approved_devices: on ? '1' : '0' });
    audit(req.user, 'settings.devices', on ? 'approved devices only' : 'any device', clientIp(req));
    notifyStaff('devices'); res.json({ ok: true });
  });

  /* ---------- manager approval for risky actions ---------- */
  const ACTIONS = { void: 'Void an order', discount: 'Give a big discount', refund: 'Refund an order', cash_close: 'Close the cash drawer', nosale: 'Open the cash drawer without a sale' };
  staff.post('/approve', authLimiter, wrap(async (req, res) => {
    const ip = clientIp(req);
    const wait = loginBlocked(ip); if (wait) return res.status(429).json({ error: `Locked for ${wait}s` });
    const { pin, action, ref } = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/), action: z.enum(Object.keys(ACTIONS)), ref: z.string().max(40).optional() }), req.body);
    const approver = await findUserByPin(pin);
    if (!approver) { recordLoginFail(ip); h.onBadPin(ip); audit(req.user, 'approve.fail', ACTIONS[action], ip); return res.status(401).json({ error: 'Wrong PIN' }); }
    if (ROLE_RANK[approver.role] < ROLE_RANK.manager) return res.status(403).json({ error: `${approver.name} can't approve this. A manager or owner has to.` });
    clearLoginFails(ip);
    const token = jwt.sign({ typ: 'approval', loc: currentSlug(), act: action, by: approver.id, for: req.user.id, ref: ref || null }, SECRET, { expiresIn: '2m' });
    audit(req.user, 'approve.ok', `${ACTIONS[action]} approved by ${approver.name}`, ip);
    res.json({ token, by: approver.name });
  }));
  /** Lets a request through if the user is a manager, or carries a fresh approval for this action. */
  /** Approver for this action from the X-Approval header, or null. */
  h.hasApproval = (req, action) => {
    try {
      const p = jwt.verify(req.get('X-Approval') || '', SECRET);
      if (p.typ === 'approval' && (p.loc || 'main') === currentSlug() && p.act === action && p.for === req.user?.id) return db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(p.by);
    } catch { /* none */ }
    return null;
  };
  h.managerOr = (action) => (req, res, next) => {
    const user = userFromToken(req.cookies?.[SESSION_COOKIE]);
    if (!user) return res.status(401).json({ error: 'Locked' });
    req.user = user;
    if (ROLE_RANK[user.role] >= ROLE_RANK.manager) return next();
    try {
      const p = jwt.verify(req.get('X-Approval') || '', SECRET);
      if (p.typ === 'approval' && (p.loc || 'main') === currentSlug() && p.act === action && p.for === user.id) { req.approvedBy = db.prepare('SELECT id, name FROM users WHERE id = ?').get(p.by); return next(); }
    } catch { /* fall through */ }
    res.status(403).json({ error: 'A manager needs to approve this', needsApproval: action });
  };

  /* ---------- refunds ---------- */
  staff.post('/orders/:id/refund', (req, res, next) => h.managerOr('refund')(req, res, next), (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req));
    if (!o || !o.paid_at || o.status === 'void') return res.status(409).json({ error: 'Only paid orders can be refunded' });
    const done = db.prepare('SELECT COALESCE(SUM(amount_cents),0) c FROM refunds WHERE order_id = ?').get(o.id).c;
    const b = parse(z.object({ amountCents: z.number().int().min(1), reason: z.string().trim().min(1).max(120) }), req.body);
    if (b.amountCents > o.total_cents - done) return res.status(400).json({ error: `You can refund at most ${((o.total_cents - done) / 100).toFixed(2)}` });
    db.prepare('INSERT INTO refunds (order_id, amount_cents, reason, method, user_id, approved_by) VALUES (?, ?, ?, ?, ?, ?)').run(o.id, b.amountCents, b.reason, o.payment_method, req.user.id, req.approvedBy?.id || req.user.id);
    audit(req.user, 'order.refund', `#${o.number} ${(b.amountCents / 100).toFixed(2)}: ${b.reason}${req.approvedBy ? ` (approved by ${req.approvedBy.name})` : ''}`, clientIp(req));
    if (b.amountCents >= 5000) alertOwners(`${getSettings().business_name}: refund`, `${req.user.name} refunded $${(b.amountCents / 100).toFixed(2)} on order #${o.number}: ${b.reason}`, 'refund');
    notifyStaff('orders'); res.json({ ok: true });
  });

  /* ---------- this phone gets security alerts ---------- */
  staff.post('/security/push', requireAuth('manager'), (req, res) => {
    const sub = parse(z.object({ endpoint: z.string().url().max(800).refine((u) => u.startsWith('https://')), keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }) }), req.body);
    db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`).run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
    audit(req.user, 'security.alerts_on', null, clientIp(req));
    res.json({ ok: true });
  });
  staff.post('/security/push/test', requireAuth('manager'), wrap(async (req, res) => {
    res.json(await pushToUsers([req.user.role], { title: 'BuzzHub security alerts', body: "You'll get alerts like this on this phone.", tag: 'test', url: '/security' }, req.user.id));
  }));
}
