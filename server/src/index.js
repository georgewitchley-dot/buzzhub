import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server as IOServer } from 'socket.io';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, seedDemoData } from './db.js';
import {
  SESSION_COOKIE, ROLE_RANK, hashPin, findUserByPin, pinInUse, pinProblem, loginBlocked, recordLoginFail,
  clearLoginFails, issueSession, clearSession, userFromToken, requireAuth, csrfGuard, newGuestToken, clientIp,
} from './security.js';
import { sendSms, smsEnabled } from './sms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: false }, serveClient: false });

app.set('trust proxy', 1); // Railway / reverse proxy in front
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'wss:', 'ws:'],
      'worker-src': ["'self'"],
      'media-src': ["'self'", 'data:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use('/api', csrfGuard);
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Slow down.' } });
const publicLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
const joinLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many check-ins from this device. Please see the host.' } });
app.use('/api', apiLimiter);

/* ---------- helpers ---------- */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) { const e = new Error(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')); e.status = 400; throw e; }
  return r.data;
};
const idParam = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n < 1) { const e = new Error('Bad id'); e.status = 400; throw e; } return n; };
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const firstName = (n) => (n || '').trim().split(/\s+/)[0].slice(0, 24);
const publicBase = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
const notifyStaff = (scope) => io.to('staff').emit('sync', { scope, at: Date.now() });

function queueFor(kind) {
  return db.prepare("SELECT id FROM guests WHERE kind = ? AND status IN ('waiting','buzzed','acknowledged') ORDER BY created_at, id").all(kind).map((r) => r.id);
}

function guestPublicView(g) {
  const s = getSettings();
  const queue = queueFor(g.kind);
  const pos = queue.indexOf(g.id) + 1;
  const table = g.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(g.table_id) : null;
  const order = g.order_id ? db.prepare('SELECT number, status FROM orders WHERE id = ?').get(g.order_id) : null;
  return {
    kind: g.kind,
    name: firstName(g.name),
    partySize: g.party_size,
    status: g.status,
    position: pos || null,
    estMinutes: pos ? Math.max(1, pos * Number(s.avg_turn_minutes || 10)) : 0,
    lastMessage: g.last_message,
    buzzCount: g.buzz_count,
    tableLabel: table?.label || null,
    orderNumber: order?.number || null,
    orderStatus: order?.status || null,
    joinedAt: g.created_at,
    business: { name: s.business_name, accent: s.accent, unitLabel: s.unit_label, type: s.business_type, welcome: s.welcome_message },
  };
}

function pushGuest(guestId) {
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
  if (g) io.to(`guest:${g.id}`).emit('guest:update', guestPublicView(g));
}
function pushAllWaiting() {
  for (const { id } of db.prepare("SELECT id FROM guests WHERE status IN ('waiting','buzzed','acknowledged')").all()) pushGuest(id);
}

function createGuest({ kind = 'table', name, phone, party_size = 1, notes, source = 'staff', order_id = null }) {
  const token = newGuestToken();
  const info = db.prepare('INSERT INTO guests (kind, name, phone, party_size, notes, token, source, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(kind, name, phone || null, party_size, notes || null, token, source, order_id);
  return db.prepare('SELECT * FROM guests WHERE id = ?').get(info.lastInsertRowid);
}

async function buzzGuest(g, message, user, ip) {
  const s = getSettings();
  const table = g.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(g.table_id) : null;
  const order = g.order_id ? db.prepare('SELECT number FROM orders WHERE id = ?').get(g.order_id) : null;
  const msg = message?.trim() || (g.kind === 'order'
    ? `Order #${order?.number ?? ''} is ready for pickup!`
    : `Your ${s.unit_label.toLowerCase()}${table ? ` (${table.label})` : ''} is ready — please come to the host stand.`);
  db.prepare("UPDATE guests SET status = 'buzzed', buzz_count = buzz_count + 1, buzzed_at = ?, last_message = ? WHERE id = ?").run(now(), msg, g.id);
  io.to(`guest:${g.id}`).emit('buzz', { message: msg, at: Date.now() });
  pushGuest(g.id);
  audit(user, 'guest.buzz', `${g.name} (#${g.id}) — ${msg}`, ip);
  let sms = null;
  if (g.phone && smsEnabled()) sms = await sendSms(g.phone, `${s.business_name}: ${msg}`).catch((e) => ({ ok: false, error: e.message }));
  notifyStaff('guests');
  return { message: msg, sms };
}

/* ======================================================================
   SETUP (first run only)
   ====================================================================== */
const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;
let SETUP_CODE = process.env.SETUP_CODE || null;
if (!userCount() && !SETUP_CODE) {
  SETUP_CODE = crypto.randomInt(100000, 999999).toString();
}
if (!userCount()) {
  console.log('\n================================================');
  console.log(' BuzzHub first-run setup required.');
  console.log(` Setup code: ${SETUP_CODE}`);
  console.log('================================================\n');
}

app.get('/api/setup/status', (req, res) => res.json({ needsSetup: userCount() === 0 }));

app.post('/api/setup', authLimiter, wrap(async (req, res) => {
  if (userCount() > 0) return res.status(409).json({ error: 'Already set up' });
  const body = parse(z.object({
    setupCode: z.string().min(1).max(64),
    businessName: z.string().trim().min(1).max(60),
    businessType: z.enum(['restaurant', 'cafe', 'service']),
    ownerName: z.string().trim().min(1).max(40),
    pin: z.string(),
    seed: z.boolean().optional(),
  }), req.body);
  const a = Buffer.from(body.setupCode); const b = Buffer.from(String(SETUP_CODE));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    recordLoginFail(clientIp(req));
    return res.status(403).json({ error: 'Wrong setup code. Check the server logs.' });
  }
  const problem = pinProblem(body.pin);
  if (problem) return res.status(400).json({ error: problem });
  const unit = { restaurant: 'Table', cafe: 'Order', service: 'Appointment' }[body.businessType];
  setSettings({ business_name: body.businessName, business_type: body.businessType, unit_label: unit });
  const info = db.prepare("INSERT INTO users (name, role, pin_hash) VALUES (?, 'owner', ?)").run(body.ownerName, await hashPin(body.pin));
  if (body.seed !== false) seedDemoData(body.businessType);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  audit(user, 'setup.complete', body.businessName, clientIp(req));
  SETUP_CODE = null;
  issueSession(res, user);
  res.json({ ok: true });
}));

/* ======================================================================
   AUTH (PIN)
   ====================================================================== */
app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const ip = clientIp(req);
  const wait = loginBlocked(ip);
  if (wait) return res.status(429).json({ error: `Terminal locked. Try again in ${wait}s.`, lockedFor: wait });
  const { pin } = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/, 'Enter your 4–8 digit PIN') }), req.body);
  const user = await findUserByPin(pin);
  if (!user) {
    const r = recordLoginFail(ip);
    audit(null, 'auth.fail', `bad PIN (${r.remaining} left)`, ip);
    io.to('owners').emit('security', { type: 'bad_pin', ip, at: Date.now() });
    return res.status(401).json({ error: r.lockedFor ? `Too many wrong PINs. Locked for ${r.lockedFor}s.` : 'Wrong PIN', remaining: r.remaining, lockedFor: r.lockedFor });
  }
  clearLoginFails(ip);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
  issueSession(res, user);
  audit(user, 'auth.login', null, ip);
  res.json({ user: { id: user.id, name: user.name, role: user.role } });
}));

app.post('/api/auth/logout', (req, res) => {
  const user = userFromToken(req.cookies?.[SESSION_COOKIE]);
  if (user) audit(user, 'auth.lock', null, clientIp(req));
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = userFromToken(req.cookies?.[SESSION_COOKIE]);
  if (!user) return res.status(401).json({ error: 'Locked' });
  res.json({ user });
});

/* ======================================================================
   PUBLIC: business info, self check-in, guest buzzer
   ====================================================================== */
app.get('/api/public/business', publicLimiter, (req, res) => {
  const s = getSettings();
  res.json({ name: s.business_name, accent: s.accent, type: s.business_type, unitLabel: s.unit_label, selfCheckin: s.self_checkin === '1', waiting: queueFor('table').length, avgTurn: Number(s.avg_turn_minutes) });
});

app.post('/api/public/join', joinLimiter, wrap(async (req, res) => {
  if (getSettings().self_checkin !== '1') return res.status(403).json({ error: 'Self check-in is turned off. Please see the host.' });
  const body = parse(z.object({
    name: z.string().trim().min(1).max(40),
    phone: z.string().trim().max(20).regex(/^[+\d\s()-]*$/, 'Phone looks wrong').optional().or(z.literal('')),
    partySize: z.number().int().min(1).max(30),
  }), req.body);
  const g = createGuest({ name: body.name, phone: body.phone, party_size: body.partySize, source: 'self' });
  audit(null, 'guest.selfjoin', `${g.name} party of ${g.party_size}`, clientIp(req));
  notifyStaff('guests');
  pushAllWaiting();
  res.json({ token: g.token });
}));

const guestByToken = (token) => (typeof token === 'string' && /^[A-Za-z0-9_-]{20,40}$/.test(token))
  ? db.prepare('SELECT * FROM guests WHERE token = ?').get(token) : null;

app.get('/api/g/:token', publicLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g) return res.status(404).json({ error: 'This buzzer link is not valid.' });
  res.json(guestPublicView(g));
});

app.post('/api/g/:token/ack', publicLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g || g.status !== 'buzzed') return res.status(409).json({ error: 'Nothing to acknowledge' });
  db.prepare("UPDATE guests SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?").run(now(), g.id);
  audit(null, 'guest.ack', `${g.name} (#${g.id}) is on the way`, clientIp(req));
  io.to('staff').emit('guest:ack', { id: g.id, name: g.name });
  notifyStaff('guests');
  pushGuest(g.id);
  res.json({ ok: true });
});

app.post('/api/g/:token/leave', publicLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g || !['waiting', 'buzzed', 'acknowledged'].includes(g.status)) return res.status(409).json({ error: 'Not on the list' });
  db.prepare("UPDATE guests SET status = 'cancelled', closed_at = ? WHERE id = ?").run(now(), g.id);
  audit(null, 'guest.leave', `${g.name} (#${g.id}) left the list`, clientIp(req));
  notifyStaff('guests');
  pushAllWaiting();
  pushGuest(g.id);
  res.json({ ok: true });
});

/* ======================================================================
   STAFF API (PIN session required)
   ====================================================================== */
const staff = express.Router();
staff.use(requireAuth('staff'));

staff.get('/settings', (req, res) => res.json({ ...getSettings(), sms_enabled: smsEnabled() }));
staff.put('/settings', requireAuth('manager'), (req, res) => {
  const body = parse(z.object({
    business_name: z.string().trim().min(1).max(60),
    business_type: z.enum(['restaurant', 'cafe', 'service']),
    unit_label: z.string().trim().min(1).max(20),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    tax_rate: z.coerce.number().min(0).max(30),
    avg_turn_minutes: z.coerce.number().int().min(1).max(240),
    idle_lock_minutes: z.coerce.number().int().min(1).max(60),
    self_checkin: z.union([z.literal('0'), z.literal('1')]),
    welcome_message: z.string().trim().max(240),
  }).partial(), req.body);
  setSettings(body);
  audit(req.user, 'settings.update', Object.keys(body).join(', '), clientIp(req));
  io.emit('settings', getSettings());
  pushAllWaiting();
  res.json(getSettings());
});

/* ---- dashboard ---- */
staff.get('/dashboard', (req, res) => {
  const today = "date(created_at) = date('now')";
  const waiting = db.prepare("SELECT COUNT(*) c FROM guests WHERE kind='table' AND status IN ('waiting','buzzed','acknowledged')").get().c;
  const seatedToday = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(party_size),0) covers FROM guests WHERE status IN ('seated','done') AND ${today}`).get();
  const avgWait = db.prepare(`SELECT AVG((julianday(seated_at) - julianday(created_at)) * 1440) m FROM guests WHERE seated_at IS NOT NULL AND ${today}`).get().m;
  const sales = db.prepare("SELECT COALESCE(SUM(total_cents),0) total, COUNT(*) n, COALESCE(SUM(tip_cents),0) tips FROM orders WHERE status='paid' AND date(paid_at) = date('now')").get();
  const openOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('open','sent','ready')").get().c;
  const tables = db.prepare('SELECT status, COUNT(*) c FROM tables GROUP BY status').all();
  const buzzesToday = db.prepare(`SELECT COALESCE(SUM(buzz_count),0) c FROM guests WHERE ${today}`).get().c;
  const hourly = db.prepare("SELECT CAST(strftime('%H', paid_at) AS INTEGER) h, SUM(total_cents) t FROM orders WHERE status='paid' AND date(paid_at)=date('now') GROUP BY h").all();
  const top = db.prepare("SELECT oi.name, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status='paid' AND date(o.paid_at)=date('now') GROUP BY oi.name ORDER BY q DESC LIMIT 5").all();
  const activity = db.prepare('SELECT ts, user_name, action, detail FROM audit ORDER BY id DESC LIMIT 12').all();
  res.json({ waiting, seatedToday: seatedToday.c, coversToday: seatedToday.covers, avgWait: avgWait ? Math.round(avgWait) : 0, salesCents: sales.total, ordersPaid: sales.n, tipsCents: sales.tips, openOrders, tables, buzzesToday, hourly, top, activity });
});

/* ---- guests / waitlist ---- */
staff.get('/guests', (req, res) => {
  const active = db.prepare("SELECT g.*, t.label table_label, o.number order_number FROM guests g LEFT JOIN tables t ON t.id=g.table_id LEFT JOIN orders o ON o.id=g.order_id WHERE g.status IN ('waiting','buzzed','acknowledged') ORDER BY g.created_at, g.id").all();
  const recent = db.prepare("SELECT g.*, t.label table_label FROM guests g LEFT JOIN tables t ON t.id=g.table_id WHERE g.status NOT IN ('waiting','buzzed','acknowledged') AND date(g.created_at)=date('now') ORDER BY g.id DESC LIMIT 30").all();
  res.json({ active, recent });
});

staff.post('/guests', wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1).max(40),
    phone: z.string().trim().max(20).regex(/^[+\d\s()-]*$/).optional().or(z.literal('')),
    partySize: z.number().int().min(1).max(50),
    notes: z.string().trim().max(200).optional(),
    kind: z.enum(['table', 'order']).optional(),
  }), req.body);
  const g = createGuest({ name: body.name, phone: body.phone, party_size: body.partySize, notes: body.notes, kind: body.kind || 'table' });
  audit(req.user, 'guest.add', `${g.name} party of ${g.party_size}`, clientIp(req));
  notifyStaff('guests');
  pushAllWaiting();
  res.json({ guest: g, link: `${publicBase(req)}/b/${g.token}` });
}));

staff.get('/guests/:id/qr', wrap(async (req, res) => {
  const g = db.prepare('SELECT token FROM guests WHERE id = ?').get(idParam(req));
  if (!g) return res.status(404).json({ error: 'Not found' });
  const link = `${publicBase(req)}/b/${g.token}`;
  const svg = await QRCode.toString(link, { type: 'svg', margin: 1, color: { dark: '#0b0b12', light: '#ffffff' } });
  res.json({ link, svg });
}));

staff.get('/join-qr', wrap(async (req, res) => {
  const link = `${publicBase(req)}/join`;
  res.json({ link, svg: await QRCode.toString(link, { type: 'svg', margin: 1 }) });
}));

staff.post('/guests/:id/buzz', wrap(async (req, res) => {
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(idParam(req));
  if (!g || !['waiting', 'buzzed', 'acknowledged'].includes(g.status)) return res.status(409).json({ error: 'Guest is not waiting' });
  const { message, tableId } = parse(z.object({ message: z.string().max(160).optional(), tableId: z.number().int().optional() }), req.body || {});
  if (tableId) {
    const t = db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId);
    if (!t) return res.status(404).json({ error: 'Table not found' });
    db.prepare("UPDATE tables SET status='reserved', guest_id=? WHERE id=?").run(g.id, t.id);
    db.prepare('UPDATE guests SET table_id=? WHERE id=?').run(t.id, g.id);
    notifyStaff('tables');
  }
  const result = await buzzGuest(db.prepare('SELECT * FROM guests WHERE id = ?').get(g.id), message, req.user, clientIp(req));
  res.json(result);
}));

staff.post('/guests/:id/seat', (req, res) => {
  const id = idParam(req);
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const { tableId } = parse(z.object({ tableId: z.number().int().optional() }), req.body || {});
  const tid = tableId || g.table_id;
  const tx = db.transaction(() => {
    if (tid) {
      db.prepare("UPDATE tables SET status='open', guest_id=NULL WHERE guest_id=? AND id<>?").run(id, tid);
      db.prepare("UPDATE tables SET status='seated', guest_id=?, seated_at=? WHERE id=?").run(id, now(), tid);
    }
    db.prepare("UPDATE guests SET status=?, table_id=?, seated_at=?, closed_at=? WHERE id=?")
      .run(g.kind === 'order' ? 'done' : 'seated', tid || null, now(), now(), id);
  });
  tx();
  audit(req.user, g.kind === 'order' ? 'guest.pickedup' : 'guest.seat', `${g.name}${tid ? ` → table ${tid}` : ''}`, clientIp(req));
  notifyStaff('guests'); notifyStaff('tables');
  pushGuest(id); pushAllWaiting();
  res.json({ ok: true });
});

staff.post('/guests/:id/remove', (req, res) => {
  const id = idParam(req);
  const { reason } = parse(z.object({ reason: z.enum(['cancelled', 'noshow']) }), req.body);
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE guests SET status=?, closed_at=? WHERE id=?').run(reason, now(), id);
  db.prepare("UPDATE tables SET status='open', guest_id=NULL WHERE guest_id=? AND status='reserved'").run(id);
  audit(req.user, `guest.${reason}`, g.name, clientIp(req));
  notifyStaff('guests'); notifyStaff('tables');
  pushGuest(id); pushAllWaiting();
  res.json({ ok: true });
});

/* ---- tables ---- */
staff.get('/tables', (req, res) => {
  res.json(db.prepare('SELECT t.*, g.name guest_name, g.party_size FROM tables t LEFT JOIN guests g ON g.id=t.guest_id ORDER BY t.id').all());
});
staff.post('/tables', requireAuth('manager'), (req, res) => {
  const b = parse(z.object({ label: z.string().trim().min(1).max(10), seats: z.number().int().min(1).max(40), zone: z.string().trim().min(1).max(20) }), req.body);
  db.prepare('INSERT INTO tables (label, seats, zone) VALUES (?, ?, ?)').run(b.label, b.seats, b.zone);
  audit(req.user, 'table.add', b.label, clientIp(req)); notifyStaff('tables'); res.json({ ok: true });
});
staff.post('/tables/:id/status', (req, res) => {
  const id = idParam(req);
  const { status } = parse(z.object({ status: z.enum(['open', 'reserved', 'seated', 'dirty']) }), req.body);
  const t = db.prepare('SELECT * FROM tables WHERE id=?').get(id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (status === 'open' || status === 'dirty') {
    if (t.guest_id) db.prepare("UPDATE guests SET status='done', closed_at=? WHERE id=? AND status='seated'").run(now(), t.guest_id);
    db.prepare('UPDATE tables SET status=?, guest_id=NULL, seated_at=NULL WHERE id=?').run(status, id);
  } else db.prepare('UPDATE tables SET status=? WHERE id=?').run(status, id);
  audit(req.user, 'table.status', `${t.label} → ${status}`, clientIp(req)); notifyStaff('tables'); res.json({ ok: true });
});
staff.delete('/tables/:id', requireAuth('manager'), (req, res) => {
  const id = idParam(req);
  db.prepare('DELETE FROM tables WHERE id=?').run(id);
  audit(req.user, 'table.delete', String(id), clientIp(req)); notifyStaff('tables'); res.json({ ok: true });
});

/* ---- menu ---- */
staff.get('/menu', (req, res) => res.json(db.prepare('SELECT * FROM menu_items ORDER BY sort, id').all()));
const menuSchema = z.object({ name: z.string().trim().min(1).max(40), category: z.string().trim().min(1).max(24), price_cents: z.number().int().min(0).max(10_000_000), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), active: z.boolean().optional() });
staff.post('/menu', requireAuth('manager'), (req, res) => {
  const b = parse(menuSchema, req.body);
  db.prepare('INSERT INTO menu_items (name, category, price_cents, color) VALUES (?, ?, ?, ?)').run(b.name, b.category, b.price_cents, b.color || '#7c5cff');
  audit(req.user, 'menu.add', b.name, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
});
staff.put('/menu/:id', requireAuth('manager'), (req, res) => {
  const id = idParam(req); const b = parse(menuSchema.partial(), req.body);
  const cur = db.prepare('SELECT * FROM menu_items WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const m = { ...cur, ...b, active: b.active === undefined ? cur.active : (b.active ? 1 : 0) };
  db.prepare('UPDATE menu_items SET name=?, category=?, price_cents=?, color=?, active=? WHERE id=?').run(m.name, m.category, m.price_cents, m.color, m.active, id);
  audit(req.user, 'menu.update', m.name, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
});
staff.delete('/menu/:id', requireAuth('manager'), (req, res) => {
  db.prepare('DELETE FROM menu_items WHERE id=?').run(idParam(req));
  audit(req.user, 'menu.delete', req.params.id, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
});

/* ---- orders / POS ---- */
function priceItems(items) {
  const byId = new Map(db.prepare('SELECT * FROM menu_items WHERE active=1').all().map((m) => [m.id, m]));
  return items.map((i) => {
    const m = byId.get(i.itemId);
    if (!m) { const e = new Error('An item is no longer on the menu'); e.status = 400; throw e; }
    return { item_id: m.id, name: m.name, qty: i.qty, price_cents: m.price_cents, note: i.note || null }; // prices always from server
  });
}
const orderSchema = z.object({
  items: z.array(z.object({ itemId: z.number().int(), qty: z.number().int().min(1).max(99), note: z.string().max(80).optional() })).min(1).max(100),
  tableId: z.number().int().nullable().optional(),
  customerName: z.string().trim().max(40).optional(),
  discountPct: z.number().min(0).max(100).optional(),
  attachBuzzer: z.boolean().optional(),
  phone: z.string().trim().max(20).regex(/^[+\d\s()-]*$/).optional().or(z.literal('')),
});

staff.post('/orders', wrap(async (req, res) => {
  const b = parse(orderSchema, req.body);
  if ((b.discountPct || 0) > 0 && ROLE_RANK[req.user.role] < ROLE_RANK.manager && b.discountPct > 10) return res.status(403).json({ error: 'Discounts over 10% need a manager PIN' });
  const lines = priceItems(b.items);
  const s = getSettings();
  const subtotal = lines.reduce((a, l) => a + l.qty * l.price_cents, 0);
  const discount = Math.round(subtotal * (b.discountPct || 0) / 100);
  const tax = Math.round((subtotal - discount) * Number(s.tax_rate) / 100);
  const number = (db.prepare("SELECT MAX(number) n FROM orders WHERE date(created_at)=date('now')").get().n || 100) + 1;
  const tx = db.transaction(() => {
    const info = db.prepare("INSERT INTO orders (number, status, table_id, customer_name, subtotal_cents, tax_cents, discount_cents, total_cents, created_by, sent_at) VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(number, b.tableId || null, b.customerName || null, subtotal, tax, discount, subtotal - discount + tax, req.user.id, now());
    const ins = db.prepare('INSERT INTO order_items (order_id, item_id, name, qty, price_cents, note) VALUES (?, ?, ?, ?, ?, ?)');
    for (const l of lines) ins.run(info.lastInsertRowid, l.item_id, l.name, l.qty, l.price_cents, l.note);
    return info.lastInsertRowid;
  });
  const orderId = tx();
  let buzzer = null;
  if (b.attachBuzzer) {
    const g = createGuest({ kind: 'order', name: b.customerName || `Order ${number}`, phone: b.phone, party_size: 1, order_id: orderId });
    db.prepare('UPDATE orders SET guest_id=? WHERE id=?').run(g.id, orderId);
    const link = `${publicBase(req)}/b/${g.token}`;
    buzzer = { guestId: g.id, link, svg: await QRCode.toString(link, { type: 'svg', margin: 1 }) };
  }
  audit(req.user, 'order.create', `#${number} ${(subtotal / 100).toFixed(2)}`, clientIp(req));
  notifyStaff('orders'); notifyStaff('guests');
  res.json({ id: orderId, number, buzzer });
}));

staff.get('/orders', (req, res) => {
  const scope = req.query.scope === 'paid' ? "o.status IN ('paid','void') AND date(o.created_at)=date('now')" : "o.status IN ('open','sent','ready')";
  const orders = db.prepare(`SELECT o.*, t.label table_label, u.name staff_name FROM orders o LEFT JOIN tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.created_by WHERE ${scope} ORDER BY o.id DESC LIMIT 100`).all();
  const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${orders.map((o) => o.id).join(',') || 0})`).all();
  res.json(orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id) })));
});

staff.post('/orders/:id/ready', wrap(async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(idParam(req));
  if (!o || !['open', 'sent'].includes(o.status)) return res.status(409).json({ error: 'Order not in progress' });
  db.prepare("UPDATE orders SET status='ready', ready_at=? WHERE id=?").run(now(), o.id);
  audit(req.user, 'order.ready', `#${o.number}`, clientIp(req));
  let buzz = null;
  if (o.guest_id) {
    const g = db.prepare('SELECT * FROM guests WHERE id=?').get(o.guest_id);
    if (g && ['waiting', 'buzzed', 'acknowledged'].includes(g.status)) buzz = await buzzGuest(g, null, req.user, clientIp(req));
  }
  notifyStaff('orders');
  res.json({ ok: true, buzz });
}));

staff.post('/orders/:id/pay', (req, res) => {
  const id = idParam(req);
  const b = parse(z.object({ method: z.enum(['cash', 'card', 'other']), tipCents: z.number().int().min(0).max(1_000_000).optional(), tenderedCents: z.number().int().min(0).optional() }), req.body);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o || ['paid', 'void'].includes(o.status)) return res.status(409).json({ error: 'Order already closed' });
  const tip = b.tipCents || 0;
  const total = o.subtotal_cents - o.discount_cents + o.tax_cents + tip;
  if (b.method === 'cash' && b.tenderedCents !== undefined && b.tenderedCents < total) return res.status(400).json({ error: 'Not enough cash tendered' });
  db.prepare("UPDATE orders SET status='paid', tip_cents=?, total_cents=?, payment_method=?, paid_at=? WHERE id=?").run(tip, total, b.method, now(), id);
  if (o.guest_id) { db.prepare("UPDATE guests SET status='done', closed_at=? WHERE id=? AND status IN ('waiting','buzzed','acknowledged')").run(now(), o.guest_id); pushGuest(o.guest_id); }
  audit(req.user, 'order.pay', `#${o.number} ${b.method} ${(total / 100).toFixed(2)}`, clientIp(req));
  notifyStaff('orders'); notifyStaff('guests');
  res.json({ ok: true, totalCents: total, changeCents: b.tenderedCents !== undefined ? b.tenderedCents - total : 0 });
});

staff.post('/orders/:id/void', requireAuth('manager'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(idParam(req));
  if (!o || o.status === 'void') return res.status(409).json({ error: 'Cannot void' });
  db.prepare("UPDATE orders SET status='void' WHERE id=?").run(o.id);
  if (o.guest_id) { db.prepare("UPDATE guests SET status='cancelled', closed_at=? WHERE id=? AND status IN ('waiting','buzzed','acknowledged')").run(now(), o.guest_id); pushGuest(o.guest_id); }
  audit(req.user, 'order.void', `#${o.number}`, clientIp(req));
  notifyStaff('orders'); notifyStaff('guests');
  res.json({ ok: true });
});

/* ---- staff / users (manager+) ---- */
staff.get('/users', requireAuth('manager'), (req, res) => {
  res.json(db.prepare('SELECT id, name, role, active, last_login_at, created_at FROM users ORDER BY active DESC, role DESC, name').all());
});
staff.post('/users', requireAuth('manager'), wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(40), role: z.enum(['owner', 'manager', 'staff']), pin: z.string() }), req.body);
  if (ROLE_RANK[b.role] >= ROLE_RANK[req.user.role] && req.user.role !== 'owner') return res.status(403).json({ error: 'You can only add roles below yours' });
  const problem = pinProblem(b.pin); if (problem) return res.status(400).json({ error: problem });
  if (await pinInUse(b.pin)) return res.status(409).json({ error: 'That PIN is already taken — pick another' });
  db.prepare('INSERT INTO users (name, role, pin_hash) VALUES (?, ?, ?)').run(b.name, b.role, await hashPin(b.pin));
  audit(req.user, 'user.add', `${b.name} (${b.role})`, clientIp(req));
  res.json({ ok: true });
}));
staff.put('/users/:id', requireAuth('manager'), wrap(async (req, res) => {
  const id = idParam(req);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'owner' && ROLE_RANK[target.role] >= ROLE_RANK[req.user.role] && target.id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  const b = parse(z.object({ name: z.string().trim().min(1).max(40).optional(), role: z.enum(['owner', 'manager', 'staff']).optional(), pin: z.string().optional(), active: z.boolean().optional() }), req.body);
  if (b.role && req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change roles' });
  if ((b.active === false || (b.role && b.role !== 'owner')) && target.role === 'owner') {
    const owners = db.prepare("SELECT COUNT(*) c FROM users WHERE role='owner' AND active=1").get().c;
    if (owners <= 1) return res.status(400).json({ error: 'You need at least one active owner' });
  }
  let pinHash = target.pin_hash; let sv = target.session_version;
  if (b.pin) {
    const problem = pinProblem(b.pin); if (problem) return res.status(400).json({ error: problem });
    if (await pinInUse(b.pin, id)) return res.status(409).json({ error: 'That PIN is already taken' });
    pinHash = await hashPin(b.pin); sv += 1;
  }
  if (b.active === false || b.role) sv += 1; // force re-login
  db.prepare('UPDATE users SET name=?, role=?, pin_hash=?, active=?, session_version=? WHERE id=?')
    .run(b.name ?? target.name, b.role ?? target.role, pinHash, b.active === undefined ? target.active : (b.active ? 1 : 0), sv, id);
  audit(req.user, 'user.update', `${target.name}${b.pin ? ' (PIN reset)' : ''}${b.active === false ? ' (disabled)' : ''}`, clientIp(req));
  io.to(`user:${id}`).emit('force-lock');
  res.json({ ok: true });
}));
staff.post('/users/:id/revoke', requireAuth('manager'), (req, res) => {
  const id = idParam(req);
  db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id=?').run(id);
  audit(req.user, 'user.revoke_sessions', String(id), clientIp(req));
  io.to(`user:${id}`).emit('force-lock');
  res.json({ ok: true });
});

staff.get('/audit', requireAuth('manager'), (req, res) => {
  res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all());
});

app.use('/api/staff', staff);

/* ---------- static client ---------- */
const DIST = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false, maxAge: IS_PROD ? '1h' : 0, setHeaders: (res, p) => { if (p.includes('/assets/')) res.set('Cache-Control', 'public, max-age=31536000, immutable'); } }));
  app.get(/^\/(?!api|socket\.io).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

/* ---------- realtime ---------- */
io.use((socket, next) => {
  const cookies = Object.fromEntries((socket.handshake.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
  const user = userFromToken(cookies[SESSION_COOKIE]);
  const guestToken = socket.handshake.auth?.guestToken;
  if (user) { socket.data.user = user; return next(); }
  if (guestToken) { const g = guestByToken(guestToken); if (g) { socket.data.guestId = g.id; return next(); } }
  next(new Error('unauthorized'));
});
io.on('connection', (socket) => {
  if (socket.data.user) {
    socket.join('staff');
    socket.join(`user:${socket.data.user.id}`);
    if (ROLE_RANK[socket.data.user.role] >= ROLE_RANK.manager) socket.join('owners');
  } else if (socket.data.guestId) {
    socket.join(`guest:${socket.data.guestId}`);
    pushGuest(socket.data.guestId);
  }
});

server.listen(PORT, () => console.log(`BuzzHub listening on :${PORT}`));
