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
import jwt from 'jsonwebtoken';
import { db, getSettings, setSettings, audit, seedDemoData, runIn, currentSlug, forEachLocation, locationExists, allSlugs, listLocations, createLocationDb, SLUG_RE, getJwtSecret } from './db.js';
import {
  SESSION_COOKIE, ROLE_RANK, hashPin, findUserByPin, pinInUse, pinProblem, loginBlocked, recordLoginFail,
  clearLoginFails, issueSession, clearSession, userFromToken, requireAuth, csrfGuard, newGuestToken, clientIp,
  passwordProblem, hashPassword, checkPassword, burnCompare, issueCustomerSession, clearCustomerSession, customerFromReq, requireCustomer,
} from './security.js';
import { registerOps } from './ops.js';
import { registerTeam } from './team.js';
import { registerPro } from './pro.js';
import { registerCrm } from './crm.js';
import { registerBack } from './back.js';
import { registerDelivery } from './delivery.js';
import { registerPayments } from './payments.js';
import { registerClub } from './club.js';
import { registerReach } from './reach.js';
import { registerPeople } from './people.js';
import { registerExtras } from './extras.js';
import { registerHouse } from './house.js';
import { registerPlus } from './plus.js';
import { registerMore } from './more.js';
import { registerOwner } from './owner.js';
import { registerSmart } from './smart.js';
import { registerTimeClock } from './timeclock.js';
import { registerDesk } from './desk.js';
import { registerKds } from './kds.js';
import { registerCrew } from './crew.js';
import { registerPace } from './pace.js';
import { registerLine } from './line.js';
import { registerPass } from './pass.js';
import { registerRun } from './run.js';
import { registerTable } from './table.js';
import { registerStation } from './station.js';
import { registerGuard } from './guard.js';
import { locationMiddleware, scopeSockets, registerLocations } from './locations.js';
import { registerFloorPay } from './floorpay.js';
import { registerCommerce, priceLines, insertOrder, lineSchema, returnStock, dueOf, menuWithMods } from './commerce.js';
import { registerGrowth, smartEstimate, waitModelInfo } from './growth.js';
const G = {}; // filled by registerGuard: authGate, managerOr, hasApproval, onBadPin, alertOwners
import { VAPID_PUBLIC_KEY, saveSubscription, pushToGuest, pushToCustomer, pushToUsers, devicesForGuest, forgetGuestDevices, emailEnabled, emailGuest } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: false }, serveClient: false });
const { slugForSocket } = scopeSockets(io);

app.set('trust proxy', 1); // Railway / reverse proxy in front
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://www.paypal.com'],
      'frame-src': ["'self'", 'https://www.paypal.com', 'https://*.paypal.com', 'https://*.venmo.com'],
      'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://*.paypal.com', 'https://*.paypalobjects.com'],
      'connect-src': ["'self'", 'wss:', 'ws:', 'https://*.paypal.com'],
      'worker-src': ["'self'"],
      'media-src': ["'self'", 'data:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
const smallJson = express.json({ limit: '64kb' });
const logoJson = express.json({ limit: '900kb' });
const stripeRaw = express.raw({ type: 'application/json', limit: '1mb' });
app.use((req, res, next) => (req.path === '/api/stripe/webhook' || req.path === '/api/square/webhook' ? stripeRaw : req.path === '/api/staff/logo' ? logoJson : smallJson)(req, res, next));
app.use(cookieParser());
app.use(locationMiddleware);
app.use('/api', csrfGuard);
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Every device in a business usually shares one internet address, so signed-in staff (and kiosk / lobby / display /
// time-clock screens with their own token) are not counted against the per-address limits; PIN tries still are.
const isTrustedDevice = (req) => {
  if (req._trusted !== undefined) return req._trusted;
  let ok = false;
  try { ok = Boolean(req.cookies?.[SESSION_COOKIE] && userFromToken(req.cookies[SESSION_COOKIE])); } catch { ok = false; }
  if (!ok) for (const [hdr, kind] of [['X-Kiosk', 'kiosk'], ['X-Screen', 'screen'], ['X-Display', 'display'], ['X-Clock', 'clock'], ['X-Kds', 'kds'], ['X-Board', 'board']]) {
    const t = req.get(hdr); if (!t) continue;
    try { jwt.verify(t, `${getJwtSecret()}:${kind}`); ok = true; break; } catch { /* not a real device token */ }
  }
  req._trusted = ok; return ok;
};
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: 'draft-7', legacyHeaders: false, skip: isTrustedDevice });
const authLimiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Slow down.' } });
const publicLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false, skip: (req) => isTrustedDevice(req) });
const orderLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many order changes. Please ask your server.' } });
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

const estFor = (pos, s, size = 2) => smartEstimate(pos, size, s);
const linkFor = (g) => `${process.env.PUBLIC_URL?.replace(/\/$/, '') || ''}/b/${g.token}`;

/** Is this guest allowed to pre-order right now? */
function preorderWindow(g, s, pos) {
  if (s.preorder_enabled !== '1' || g.kind !== 'table') return { enabled: false, open: false };
  if (!['waiting', 'buzzed', 'acknowledged'].includes(g.status)) return { enabled: true, open: false, closed: true };
  const est = estFor(pos, s, g.party_size);
  const open = g.preorder_open === 1 || g.status !== 'waiting' || est <= Number(s.preorder_open_minutes);
  return { enabled: true, open, opensInMinutes: open ? 0 : Math.max(1, est - Number(s.preorder_open_minutes)) };
}

function preorderFor(guestId) {
  const o = db.prepare("SELECT * FROM orders WHERE guest_id = ? AND source = 'guest' AND status <> 'void' ORDER BY id DESC LIMIT 1").get(guestId);
  if (!o) return null;
  const items = db.prepare('SELECT name, qty, price_cents, note FROM order_items WHERE order_id = ?').all(o.id);
  return { number: o.number, status: o.status, items, subtotalCents: o.subtotal_cents, taxCents: o.tax_cents, totalCents: o.total_cents };
}

function guestPublicView(g) {
  const s = getSettings();
  const queue = queueFor(g.kind);
  const pos = queue.indexOf(g.id) + 1;
  const table = g.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(g.table_id) : null;
  const order = g.order_id ? db.prepare('SELECT number, status FROM orders WHERE id = ?').get(g.order_id) : null;
  const devices = devicesForGuest(g.id).length;
  return {
    kind: g.kind,
    name: firstName(g.name),
    partySize: g.party_size,
    status: g.status,
    position: pos || null,
    estMinutes: estFor(pos, s, g.party_size),
    lastMessage: g.last_message,
    buzzCount: g.buzz_count,
    headsUp: Boolean(g.heads_up_at),
    tableLabel: table?.label || null,
    orderNumber: order?.number || null,
    orderStatus: order?.status || null,
    joinedAt: g.created_at,
    hasEmail: Boolean(g.email),
    emailAlerts: Boolean(g.email && g.notify_email && emailEnabled()),
    emailAvailable: emailEnabled(),
    customer: Boolean(g.customer_id),
    pushDevices: devices,
    preorder: { ...preorderWindow(g, s, pos), order: preorderFor(g.id) },
    delivery: G.deliveryView ? G.deliveryView(g.order_id) : null,
    curbside: G.curbsideView ? G.curbsideView(g) : null,
    shelf: G.shelfView ? G.shelfView(g) : null,
    dropPhoto: g.order_id && G.dropPhotoFor ? G.dropPhotoFor(g.order_id) : false,
    chat: s.chat_enabled === '1',
    business: { slug: currentSlug(), name: s.business_name, accent: s.accent, unitLabel: s.unit_label, type: s.business_type, welcome: s.welcome_message, booking: s.booking_enabled === '1', logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null },
  };
}

function pushGuest(guestId) {
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
  if (g) io.to(`guest:${g.id}`).emit('guest:update', guestPublicView(g));
}

/** Send a guest an alert on every channel they turned on: live page, phone notification, email. */
async function alertGuest(g, { title, body, tag, kind }) {
  const s = getSettings();
  io.to(`guest:${g.id}`).emit(kind === 'buzz' ? 'buzz' : 'headsup', { message: body, at: Date.now() });
  const push = await pushToGuest(g.id, { title, body, tag, url: `/b/${g.token}`, kind }).catch(() => ({ sent: 0 }));
  let email = null;
  if (g.email && g.notify_email && emailEnabled()) {
    email = await emailGuest(g.email, { businessName: s.business_name, subject: title, message: body, link: linkFor(g), accent: s.accent }).catch((e) => { console.error('email failed', e.message); return { ok: false }; });
  }
  return { push, email };
}

/** Automatic "almost ready" heads-up once a party's estimated wait drops under the business's threshold. */
async function sendHeadsUp(g, manual = false) {
  const s = getSettings();
  db.prepare('UPDATE guests SET heads_up_at = ?, preorder_open = 1 WHERE id = ?').run(now(), g.id);
  const canOrder = s.preorder_enabled === '1' && db.prepare('SELECT COUNT(*) c FROM menu_items WHERE active=1 AND guest_orderable=1').get().c > 0;
  const body = canOrder
    ? `Your ${s.unit_label.toLowerCase()} is almost ready. Order drinks now and they'll be waiting when you sit down.`
    : `Your ${s.unit_label.toLowerCase()} is almost ready. Please stay nearby.`;
  const r = await alertGuest(g, { title: `${s.business_name}: almost your turn`, body, tag: 'headsup', kind: 'headsup' });
  audit(null, 'guest.headsup', `${g.name} (#${g.id})${manual ? ' — sent by staff' : ''}`, null);
  pushGuest(g.id);
  return r;
}

const headsUpRunning = new Set();
async function checkHeadsUps() {
  const slugNow = currentSlug();
  if (headsUpRunning.has(slugNow)) return; headsUpRunning.add(slugNow);
  try {
    const s = getSettings();
    const limit = Number(s.heads_up_minutes);
    if (!limit) return;
    const queue = queueFor('table');
    for (const [i, id] of queue.entries()) {
      const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
      if (!g || estFor(i + 1, s, g.party_size) > limit) continue;
      if (g.status === 'waiting' && !g.heads_up_at) await sendHeadsUp(g);
    }
  } finally { headsUpRunning.delete(slugNow); }
}

function pushAllWaiting() {
  for (const { id } of db.prepare("SELECT id FROM guests WHERE status IN ('waiting','buzzed','acknowledged')").all()) pushGuest(id);
  checkHeadsUps().catch((e) => console.error('heads-up', e));
}

function createGuest({ kind = 'table', name, phone, email, notifyEmail, party_size = 1, notes, source = 'staff', order_id = null, customer_id = null, booking_id = null }) {
  const token = newGuestToken();
  const ahead = queueFor(kind).length;
  const info = db.prepare('INSERT INTO guests (kind, name, phone, email, notify_email, party_size, notes, token, source, order_id, customer_id, booking_id, ahead_at_join) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(kind, name, phone || null, email || null, email && notifyEmail ? 1 : 0, party_size, notes || null, token, source, order_id, customer_id, booking_id, ahead);
  return db.prepare('SELECT * FROM guests WHERE id = ?').get(info.lastInsertRowid);
}

/** Move a guest's held pre-order to the kitchen/bar and attach it to their table. */
function fireHeldPreorder(guestId, tableId) {
  const o = db.prepare("SELECT * FROM orders WHERE guest_id = ? AND source = 'guest' AND status = 'held' ORDER BY id DESC LIMIT 1").get(guestId);
  if (!o) return null;
  db.prepare("UPDATE orders SET status = 'sent', sent_at = ?, table_id = COALESCE(?, table_id) WHERE id = ?").run(now(), tableId || null, o.id);
  io.to('staff').emit('preorder:fired', { number: o.number, table: tableId ? db.prepare('SELECT label FROM tables WHERE id=?').get(tableId)?.label : null });
  notifyStaff('orders');
  return o.number;
}
function voidHeldPreorder(guestId) {
  const r = db.prepare("UPDATE orders SET status = 'void' WHERE guest_id = ? AND source = 'guest' AND status = 'held'").run(guestId);
  if (r.changes) notifyStaff('orders');
}

async function buzzGuest(g, message, user, ip) {
  const s = getSettings();
  const table = g.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(g.table_id) : null;
  const order = g.order_id ? db.prepare('SELECT number FROM orders WHERE id = ?').get(g.order_id) : null;
  const msg = message?.trim() || (g.kind === 'order'
    ? `Order #${order?.number ?? ''} is ready for pickup!`
    : `Your ${s.unit_label.toLowerCase()}${table ? ` (${table.label})` : ''} is ready. Please come to the host stand.`);
  db.prepare("UPDATE guests SET status = 'buzzed', buzz_count = buzz_count + 1, buzzed_at = ?, last_message = ? WHERE id = ?").run(now(), msg, g.id);
  // their table is set: start making any drinks they pre-ordered so they're waiting when they sit
  const fired = g.kind === 'table' && g.table_id ? fireHeldPreorder(g.id, g.table_id) : null;
  const title = g.kind === 'order' ? `${s.business_name}: order ready` : `${s.business_name}: your ${s.unit_label.toLowerCase()} is ready`;
  const sent = await alertGuest(g, { title, body: msg, tag: 'buzz', kind: 'buzz' });
  pushGuest(g.id);
  audit(user, 'guest.buzz', `${g.name} (#${g.id}) — ${msg}${sent.push?.sent ? ` [phone alert to ${sent.push.sent} device(s)]` : ''}${fired ? ` [pre-order #${fired} sent]` : ''}`, ip);
  notifyStaff('guests');
  return { message: msg, push: sent.push, email: sent.email, preorderFired: fired };
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

app.post('/api/stripe/webhook', (req, res) => (G.stripeWebhook ? G.stripeWebhook(req, res) : res.status(404).end()));
app.post('/api/square/webhook', (req, res) => (G.squareWebhook ? G.squareWebhook(req, res) : res.status(404).end()));

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
  setSettings({ business_name: body.businessName, business_type: body.businessType, unit_label: unit, booking_enabled: body.businessType === 'service' ? '1' : '0', preorder_enabled: body.businessType === 'service' ? '0' : '1' });
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
    G.onBadPin?.(ip);
    return res.status(401).json({ error: r.lockedFor ? `Too many wrong PINs. Locked for ${r.lockedFor}s.` : 'Wrong PIN', remaining: r.remaining, lockedFor: r.lockedFor });
  }
  clearLoginFails(ip);
  if (!G.authGate(req, res, user)) return;
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
  res.json({
    name: s.business_name, accent: s.accent, type: s.business_type, unitLabel: s.unit_label, selfCheckin: s.self_checkin === '1',
    waiting: queueFor('table').length, avgTurn: Number(s.avg_turn_minutes), emailAlerts: emailEnabled(),
    slug: currentSlug(), preorder: s.preorder_enabled === '1', booking: s.booking_enabled === '1', logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null,
  });
});

app.get('/api/public/logo', (req, res) => {
  const a = db.prepare("SELECT mime, data FROM assets WHERE key = 'logo'").get();
  if (!a) return res.status(404).end();
  res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'" });
  res.send(a.data);
});

app.get('/api/public/vapid', (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

const emailField = z.string().trim().max(120).email('Email looks wrong').optional().or(z.literal(''));

app.post('/api/public/join', joinLimiter, wrap(async (req, res) => {
  if (getSettings().self_checkin !== '1') return res.status(403).json({ error: 'Self check-in is turned off. Please see the host.' });
  const body = parse(z.object({
    name: z.string().trim().min(1).max(40),
    phone: z.string().trim().max(20).regex(/^[+\d\s()-]*$/, 'Phone looks wrong').optional().or(z.literal('')),
    email: emailField,
    notifyEmail: z.boolean().optional(),
    partySize: z.number().int().min(1).max(30),
  }), req.body);
  const cust = customerFromReq(req);
  const g = createGuest({ name: body.name, phone: body.phone, email: body.email || cust?.email, notifyEmail: body.notifyEmail, party_size: body.partySize, source: 'self', customer_id: cust?.id || null });
  audit(null, 'guest.selfjoin', `${g.name} party of ${g.party_size}`, clientIp(req));
  notifyStaff('guests');
  pushAllWaiting();
  res.json({ token: g.token });
}));

const guestByToken = (token) => (typeof token === 'string' && /^[A-Za-z0-9_-]{20,40}$/.test(token))
  ? db.prepare('SELECT * FROM guests WHERE token = ?').get(token) : null;
const ACTIVE = ['waiting', 'buzzed', 'acknowledged'];

app.get('/api/g/:token', publicLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g) return res.status(404).json({ error: 'This buzzer link is not valid.' });
  res.json(guestPublicView(g));
});

// Per-guest install manifest so "Add to Home Screen" opens THIS buzzer (needed for iPhone notifications)
app.get('/api/g/:token/manifest.webmanifest', publicLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g) return res.status(404).end();
  const s = getSettings();
  const icon = s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : '/icon-512.png';
  res.type('application/manifest+json').json({
    name: `${s.business_name} buzzer`, short_name: s.business_name.slice(0, 12), start_url: `/b/${g.token}`, scope: '/b/',
    display: 'standalone', background_color: '#0f1015', theme_color: '#0f1015',
    icons: [{ src: icon, sizes: '512x512', type: 'image/png', purpose: 'any' }],
  });
});

app.post('/api/g/:token/push', publicLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g || !ACTIVE.includes(g.status)) return res.status(409).json({ error: 'This buzzer is no longer active' });
  const sub = parse(z.object({
    endpoint: z.string().url().max(800).refine((u) => u.startsWith('https://'), 'Must be https'),
    keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
  }), req.body);
  saveSubscription({ guestId: g.id, customerId: g.customer_id || null }, sub);
  audit(null, 'guest.alerts_on', `${g.name} (#${g.id}) turned on phone alerts`, clientIp(req));
  pushGuest(g.id);
  res.json({ ok: true });
});

app.post('/api/g/:token/push/test', publicLimiter, wrap(async (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const s = getSettings();
  const r = await pushToGuest(g.id, { title: s.business_name, body: "Alerts are on. We'll buzz you here when it's your turn.", tag: 'test', url: `/b/${g.token}` });
  res.json(r);
}));

app.post('/api/g/:token/email', publicLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g || !ACTIVE.includes(g.status)) return res.status(409).json({ error: 'This buzzer is no longer active' });
  const { email, notify } = parse(z.object({ email: emailField, notify: z.boolean() }), req.body);
  db.prepare('UPDATE guests SET email = ?, notify_email = ? WHERE id = ?').run(email || null, email && notify ? 1 : 0, g.id);
  pushGuest(g.id);
  res.json({ ok: true });
});

app.get('/api/g/:token/menu', publicLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const s = getSettings();
  const items = menuWithMods({ where: 'active = 1 AND guest_orderable = 1' }).map(({ stock, low_stock, guest_orderable, active, ...m }) => m);
  res.json({ items, currency: s.currency, taxRate: Number(s.tax_rate) });
});

app.post('/api/g/:token/preorder', orderLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const s = getSettings();
  const win = preorderWindow(g, s, queueFor(g.kind).indexOf(g.id) + 1);
  if (!win.open) return res.status(409).json({ error: win.enabled ? `Ordering opens in about ${win.opensInMinutes} minutes.` : 'Ordering ahead is not available.' });
  const body = parse(z.object({ items: z.array(lineSchema).min(1).max(20) }), req.body);
  const lines = priceLines(body.items, { guestOnly: true });
  if (lines.reduce((a, l) => a + l.qty, 0) > Math.max(12, g.party_size * 4)) return res.status(400).json({ error: 'That is a lot for one party. Please order the rest at your table.' });
  const existing = db.prepare("SELECT * FROM orders WHERE guest_id = ? AND source = 'guest' AND status <> 'void' ORDER BY id DESC LIMIT 1").get(g.id);
  if (existing && existing.status !== 'held') return res.status(409).json({ error: 'Your order is already being made. Please add more with your server.' });
  if (existing) { db.prepare("UPDATE orders SET status = 'void' WHERE id = ?").run(existing.id); returnStock(existing.id, null); }
  const made = insertOrder({ lines, status: 'held', source: 'guest', guestId: g.id, customerName: g.name });
  const id = made.id;
  audit(null, existing ? 'preorder.update' : 'preorder.create', `${g.name} (#${g.id}) — ${lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}`, clientIp(req));
  io.to('staff').emit('preorder:new', { name: g.name, count: lines.reduce((a, l) => a + l.qty, 0), updated: Boolean(existing) });
  // if their table is already called, start it right away
  if (g.status !== 'waiting' && g.table_id) fireHeldPreorder(g.id, g.table_id);
  notifyStaff('orders'); notifyStaff('guests');
  pushGuest(g.id);
  res.json({ ok: true, orderId: id });
});

app.post('/api/g/:token/preorder/cancel', orderLimiter, (req, res) => {
  const g = guestByToken(req.params.token);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const r = db.prepare("UPDATE orders SET status = 'void' WHERE guest_id = ? AND source = 'guest' AND status = 'held'").run(g.id);
  if (!r.changes) return res.status(409).json({ error: 'Your order is already being made.' });
  audit(null, 'preorder.cancel', `${g.name} (#${g.id})`, clientIp(req));
  notifyStaff('orders'); pushGuest(g.id);
  res.json({ ok: true });
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
  if (!g || !ACTIVE.includes(g.status)) return res.status(409).json({ error: 'Not on the list' });
  db.prepare("UPDATE guests SET status = 'cancelled', closed_at = ? WHERE id = ?").run(now(), g.id);
  voidHeldPreorder(g.id);
  forgetGuestDevices(g.id);
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

staff.get('/settings', (req, res) => res.json({ ...getSettings(), email_enabled: emailEnabled() }));
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
    preorder_enabled: z.union([z.literal('0'), z.literal('1')]),
    preorder_open_minutes: z.coerce.number().int().min(0).max(240),
    heads_up_minutes: z.coerce.number().int().min(0).max(240),
    sign_headline: z.string().trim().min(1).max(60),
    timezone: z.string().refine((tz) => { try { Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone'),
    booking_enabled: z.union([z.literal('0'), z.literal('1')]),
    booking_open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    booking_close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    booking_days: z.string().regex(/^[01]{7}$/),
    booking_slot_minutes: z.coerce.number().int().min(5).max(480),
    booking_capacity: z.coerce.number().int().min(1).max(50),
    booking_days_ahead: z.coerce.number().int().min(1).max(120),
    booking_reminder_minutes: z.coerce.number().int().min(0).max(1440),
    kds_late_minutes: z.coerce.number().int().min(1).max(120),
    smart_waits: z.union([z.literal('0'), z.literal('1')]),
    loyalty_enabled: z.union([z.literal('0'), z.literal('1')]),
    loyalty_visits: z.coerce.number().int().min(2).max(50),
    loyalty_reward: z.string().trim().min(1).max(60),
    feedback_enabled: z.union([z.literal('0'), z.literal('1')]),
    feedback_delay_minutes: z.coerce.number().int().min(5).max(1440),
    feedback_review_threshold: z.coerce.number().int().min(3).max(5),
    review_url: z.string().trim().max(300).refine((u) => u === '' || /^https:\/\//.test(u), 'Review link must start with https://'),
    online_enabled: z.union([z.literal('0'), z.literal('1')]),
    online_pickup: z.union([z.literal('0'), z.literal('1')]),
    online_delivery: z.union([z.literal('0'), z.literal('1')]),
    delivery_fee_cents: z.coerce.number().int().min(0).max(10000),
    delivery_min_cents: z.coerce.number().int().min(0).max(100000),
    delivery_area: z.string().trim().max(120),
    online_prep_minutes: z.coerce.number().int().min(1).max(180),
    online_pay_later: z.union([z.literal('0'), z.literal('1')]),
    table_ordering: z.union([z.literal('0'), z.literal('1')]),
    tip_pool_enabled: z.union([z.literal('0'), z.literal('1')]),
    tip_pool_managers: z.union([z.literal('0'), z.literal('1')]),
    forecast_city: z.string().trim().max(80),
    forecast_rain_pct: z.coerce.number().int().min(-60).max(60),
    staff_sales_per_hour_cents: z.coerce.number().int().min(1000).max(1000000),
    staff_min: z.coerce.number().int().min(0).max(20),
    booking_deposit_cents: z.coerce.number().int().min(0).max(100000),
    deposit_refund_hours: z.coerce.number().int().min(0).max(168),
    auto_birthday: z.union([z.literal('0'), z.literal('1')]),
    auto_winback: z.union([z.literal('0'), z.literal('1')]),
    auto_welcome: z.union([z.literal('0'), z.literal('1')]),
    insights_summary: z.union([z.literal('0'), z.literal('1')]),
    insights_alerts: z.union([z.literal('0'), z.literal('1')]),
    auto_birthday_pct: z.coerce.number().int().min(1).max(100),
    auto_winback_pct: z.coerce.number().int().min(1).max(100),
    auto_welcome_pct: z.coerce.number().int().min(1).max(100),
    auto_winback_days: z.coerce.number().int().min(14).max(365),
    insights_hour: z.coerce.number().int().min(0).max(23),
    ot_weekly_hours: z.coerce.number().int().min(20).max(80),
    payroll_week_start: z.coerce.number().int().min(0).max(6),
    ot_alerts: z.union([z.literal('0'), z.literal('1')]),
    break_after_hours: z.coerce.number().min(2).max(12),
    food_cost_target: z.coerce.number().int().min(5).max(80),
    kiosk_reader_id: z.string().regex(/^(tmr_[A-Za-z0-9]+)?$/),
    kiosk_message: z.string().trim().max(120),
    business_address: z.string().trim().max(160),
    chat_enabled: z.union([z.literal('0'), z.literal('1')]),
    upsell_enabled: z.union([z.literal('0'), z.literal('1')]),
    referral_enabled: z.union([z.literal('0'), z.literal('1')]),
    recovery_enabled: z.union([z.literal('0'), z.literal('1')]),
    screen_message: z.string().trim().max(120),
    sales_goals: z.string().max(200).refine((v) => { try { const a = JSON.parse(v); return Array.isArray(a) && a.length <= 7 && a.every((x) => Number.isInteger(Number(x)) && Number(x) >= 0); } catch { return false; } }, 'Goals must be a list of 7 amounts'),
    table_long_minutes: z.coerce.number().int().min(0).max(600),
    labor_target_pct: z.coerce.number().int().min(5).max(80),
    catering_followup: z.union([z.literal('0'), z.literal('1')]), app_punch: z.union([z.literal('0'), z.literal('1')]), ot_guard: z.enum(['0', '1']), punch_geofence: z.enum(['0', '1']), punch_radius_m: z.string().regex(/^\d{2,4}$/), biz_lat: z.string().regex(/^-?\d{1,2}(\.\d+)?$|^$/), biz_lng: z.string().regex(/^-?\d{1,3}(\.\d+)?$|^$/),
    punch_photo: z.enum(['0', '1']), handoff_notes: z.enum(['0', '1']), adp_company_code: z.string().trim().max(10), kds_expo: z.enum(['0', '1']), kds_pack: z.enum(['0', '1']),
    board_categories: z.string().max(2000).refine((v) => { try { return Array.isArray(JSON.parse(v)); } catch { return false; } }, 'Must be a list'), board_title: z.string().trim().max(60), board_rotate_seconds: z.string().regex(/^\d{1,3}$/), board_cols: z.enum(['1', '2', '3', '4']), board_photos: z.enum(['0', '1']),
    rooms_online: z.enum(['0', '1']), curbside: z.enum(['0', '1']), booking_preorder: z.enum(['0', '1']), photo_check: z.enum(['off', 'allergy', 'special', 'all']), course_gap_minutes: z.string().regex(/^\d{1,2}$/), ingredient_86: z.enum(['0', '1']), makegood_minutes: z.string().regex(/^\d{1,3}$/), makegood_item_id: z.string().regex(/^\d*$/), makegood_pct: z.string().regex(/^\d{1,3}$/), batch_radius_km: z.string().regex(/^\d{1,2}(\.\d)?$/), batch_window_minutes: z.string().regex(/^\d{1,3}$/), bar_tabs: z.enum(['0', '1']), area_alerts: z.enum(['0', '1']), area_alert_high: z.string().regex(/^\d{1,3}$/), area_alert_quiet_minutes: z.string().regex(/^\d{1,3}$/), pass_alert_minutes: z.string().regex(/^\d{1,2}$/), slot_capacity: z.string().regex(/^\d{1,3}$/), pickup_shelves: z.string().trim().max(200), kds_quick_messages: z.string().max(1000).refine((v) => { try { return Array.isArray(JSON.parse(v)); } catch { return false; } }, 'Must be a list'), dish_ratings: z.enum(['0', '1']), schedule_by_area: z.enum(['0', '1']), area_sales_per_hour_cents: z.string().regex(/^\d{3,7}$/), smart_quotes: z.enum(['0', '1']), kitchen_parallel: z.string().regex(/^\d{1,2}$/), rush_mode: z.enum(['off', 'auto']), rush_busy_tickets: z.string().regex(/^\d{1,3}$/), rush_busy_late: z.string().regex(/^\d{1,3}$/), rush_pause_tickets: z.string().regex(/^\d{1,3}$/), rush_pause_late: z.string().regex(/^\d{1,3}$/), rush_extra_minutes: z.string().regex(/^\d{1,3}$/), shift_pulse: z.enum(['0', '1']), pulse_anonymous: z.enum(['0', '1']), tipout_at_clockout: z.enum(['0', '1']), curbside_prompt: z.string().trim().max(60), kds_allergy_check: z.enum(['0', '1']), kds_pacing: z.enum(['0', '1']), declare_tips: z.enum(['0', '1']), break_minutes_planned: z.string().regex(/^\d{1,3}$/), rooms_lead_days: z.string().regex(/^\d{1,2}$/), clock_message: z.string().trim().max(120), required_certs: z.string().max(4000).refine((v) => { try { return Array.isArray(JSON.parse(v)); } catch { return false; } }, 'Must be a list'), fixed_costs: z.string().max(4000).refine((v) => { try { return Array.isArray(JSON.parse(v)); } catch { return false; } }, 'Must be a list'),
    cash_balance_cents: z.coerce.number().int().min(-100_000_000).max(1_000_000_000), cash_balance_on: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/), payroll_dow: z.coerce.number().int().min(0).max(6), payroll_every: z.enum(['weekly', 'biweekly']),
    show_calories: z.union([z.literal('0'), z.literal('1')]), pay_bank_enabled: z.union([z.literal('0'), z.literal('1')]), menu_photos: z.union([z.literal('0'), z.literal('1')]), catering_online: z.union([z.literal('0'), z.literal('1')]), safe_log_enabled: z.union([z.literal('0'), z.literal('1')]), safe_two_person: z.union([z.literal('0'), z.literal('1')]),
    pay_bank_min_cents: z.coerce.number().int().min(1000).max(10_000_000), catering_lead_hours: z.coerce.number().int().min(1).max(720), catering_deposit_pct: z.coerce.number().int().min(0).max(100),
    catering_delivery_cents: z.coerce.number().int().min(0).max(100000), catering_min_cents: z.coerce.number().int().min(0).max(10_000_000), table_calls: z.union([z.literal('0'), z.literal('1')]), weekly_report: z.union([z.literal('0'), z.literal('1')]), auto_reorder: z.union([z.literal('0'), z.literal('1')]),
    weekly_report_hour: z.coerce.number().int().min(0).max(23),
    report_email: z.string().trim().max(300).refine((v) => !v || v.split(',').every((e) => /^\S+@\S+\.\S+$/.test(e.trim())), 'Enter email addresses separated by commas'),
    loyalty_tiers: z.string().max(4000).refine((v) => { try { return Array.isArray(JSON.parse(v)); } catch { return false; } }, 'Must be a list'), tipout_rules: z.string().max(4000).refine((v) => { try { return Array.isArray(JSON.parse(v)); } catch { return false; } }, 'Must be a list'),
    languages: z.string().max(200).refine((v) => { try { const a = JSON.parse(v); return Array.isArray(a) && a.includes('en') && a.every((x) => ['en', 'es', 'fr', 'zh', 'vi'].includes(x)); } catch { return false; } }, 'Pick the languages to offer'),
    labor_alerts: z.union([z.literal('0'), z.literal('1')]),
    online_schedule: z.union([z.literal('0'), z.literal('1')]),
    online_schedule_days: z.coerce.number().int().min(1).max(60),
    booking_duration_minutes: z.coerce.number().int().min(15).max(600),
    kitchen_stations: z.string().max(400).refine((v) => { try { const a = JSON.parse(v); return Array.isArray(a) && a.length >= 1 && a.length <= 8 && a.every((x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 20); } catch { return false; } }, 'Stations must be 1 to 8 names'),
    station_map: z.string().max(4000).refine((v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o); } catch { return false; } }, 'Bad station map'),
    label_shelf_days: z.coerce.number().int().min(0).max(365),
    kitchen_slow_minutes: z.coerce.number().int().min(0).max(240),
    price_watch_pct: z.coerce.number().int().min(1).max(100),
    prep_buffer_pct: z.coerce.number().int().min(0).max(100),
    referral_reward_cents: z.coerce.number().int().min(100).max(10000),
    referral_min_cents: z.coerce.number().int().min(0).max(100000),
    recovery_max_rating: z.coerce.number().int().min(1).max(3),
    recovery_kind: z.enum(['pct', 'amount']),
    recovery_value: z.coerce.number().int().min(1).max(100),
    recovery_days: z.coerce.number().int().min(7).max(180),
    recovery_message: z.string().trim().max(200),
    chat_quick: z.string().max(1200).refine((v) => { try { const a = JSON.parse(v); return Array.isArray(a) && a.length <= 8 && a.every((x) => typeof x === 'string' && x.length <= 120); } catch { return false; } }, 'Quick replies look wrong'),
    business_phone: z.string().trim().max(30),
    acct_map: z.string().max(1500).refine((v) => { try { const o = JSON.parse(v); return typeof o === 'object' && Object.values(o).every((x) => typeof x === 'string' && x.length <= 60); } catch { return false; } }, 'Account names look wrong'),
    pay_handles_enabled: z.union([z.literal('0'), z.literal('1')]),
    pay_cashapp: z.string().trim().regex(/^(\$[A-Za-z][A-Za-z0-9_-]{0,20})?$/, 'Cash App $cashtag looks wrong'),
    pay_venmo: z.string().trim().regex(/^(@?[A-Za-z0-9_-]{3,30})?$/, 'Venmo username looks wrong'),
    pay_paypalme: z.string().trim().regex(/^([A-Za-z0-9]{1,20})?$/, 'PayPal.me name looks wrong'),
    pay_zelle: z.string().trim().max(80),
    card_provider: z.enum(['auto', 'square', 'stripe']),
    cash_discount_pct: z.coerce.number().min(0).max(4),
    fee_rates: z.string().max(600).refine((v) => { try { const o = JSON.parse(v); return Object.values(o).every((r) => Array.isArray(r) && r.length === 2 && r.every((n) => typeof n === 'number' && n >= 0 && n < 100)); } catch { return false; } }, 'Fee rates look wrong'),
    insights_void_limit: z.coerce.number().int().min(1).max(50),
    insights_refund_cents: z.coerce.number().int().min(100).max(10000000),
  }).partial(), req.body);
  setSettings(body);
  audit(req.user, 'settings.update', Object.keys(body).join(', '), clientIp(req));
  io.emit('settings', getSettings());
  pushAllWaiting();
  res.json(getSettings());
});

/* ---- dashboard ---- */
staff.get('/dashboard', (req, res) => {
  const today = "localdate(created_at) = localtoday()";
  const waiting = db.prepare("SELECT COUNT(*) c FROM guests WHERE kind='table' AND status IN ('waiting','buzzed','acknowledged')").get().c;
  const seatedToday = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(party_size),0) covers FROM guests WHERE status IN ('seated','done') AND ${today}`).get();
  const avgWait = db.prepare(`SELECT AVG((julianday(seated_at) - julianday(created_at)) * 1440) m FROM guests WHERE seated_at IS NOT NULL AND ${today}`).get().m;
  const sales = db.prepare("SELECT COALESCE(SUM(total_cents),0) total, COUNT(*) n, COALESCE(SUM(tip_cents),0) tips FROM orders WHERE paid_at IS NOT NULL AND status <> 'void' AND localdate(paid_at) = localtoday()").get();
  const openOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('open','sent','ready')").get().c;
  const tables = db.prepare('SELECT status, COUNT(*) c FROM tables GROUP BY status').all();
  const buzzesToday = db.prepare(`SELECT COALESCE(SUM(buzz_count),0) c FROM guests WHERE ${today}`).get().c;
  const hourly = db.prepare("SELECT CAST(strftime('%H', paid_at) AS INTEGER) h, SUM(total_cents) t FROM orders WHERE paid_at IS NOT NULL AND status <> 'void' AND localdate(paid_at) = localtoday() GROUP BY h").all();
  const top = db.prepare("SELECT oi.name, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.paid_at IS NOT NULL AND o.status <> 'void' AND localdate(o.paid_at) = localtoday() GROUP BY oi.name ORDER BY q DESC LIMIT 5").all();
  const activity = db.prepare('SELECT ts, user_name, action, detail FROM audit ORDER BY id DESC LIMIT 12').all();
  const rating7 = db.prepare("SELECT AVG(rating) a, COUNT(rating) n FROM feedback WHERE responded_at > datetime('now','-7 days')").get();
  res.json({ rating7: rating7.a ? Math.round(rating7.a * 10) / 10 : null, ratings7: rating7.n, waitModel: waitModelInfo(), waiting, seatedToday: seatedToday.c, coversToday: seatedToday.covers, avgWait: avgWait ? Math.round(avgWait) : 0, salesCents: sales.total, ordersPaid: sales.n, tipsCents: sales.tips, openOrders, tables, buzzesToday, hourly, top, activity });
});

/* ---- guests / waitlist ---- */
staff.get('/guests', (req, res) => {
  const active = db.prepare(`SELECT g.*, t.label table_label, o.number order_number,
      (SELECT COUNT(*) FROM push_subs p WHERE p.guest_id = g.id OR (g.customer_id IS NOT NULL AND p.customer_id = g.customer_id)) devices,
      (SELECT po.status || ':' || po.number || ':' || (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = po.id) FROM orders po WHERE po.guest_id = g.id AND po.source = 'guest' AND po.status <> 'void' ORDER BY po.id DESC LIMIT 1) preorder,
      b.start_local booking_start, b.service_name booking_service, c.visits customer_visits, c.tags customer_tags, c.notes customer_notes, c.birthday customer_birthday,
      (SELECT COUNT(*) FROM rewards r WHERE r.customer_id = g.customer_id AND r.status = 'active') rewards
    FROM guests g LEFT JOIN tables t ON t.id=g.table_id LEFT JOIN orders o ON o.id=g.order_id LEFT JOIN bookings b ON b.id = g.booking_id LEFT JOIN customers c ON c.id = g.customer_id
    WHERE g.status IN ('waiting','buzzed','acknowledged') ORDER BY g.created_at, g.id`).all()
    .map(({ token, ...g }) => g);
  const s = getSettings(); const pos = { table: 0, order: 0 };
  for (const g of active) { pos[g.kind] += 1; g.est_minutes = smartEstimate(pos[g.kind], g.party_size, s); }
  const recent = db.prepare("SELECT g.*, t.label table_label FROM guests g LEFT JOIN tables t ON t.id=g.table_id WHERE g.status NOT IN ('waiting','buzzed','acknowledged') AND localdate(g.created_at) = localtoday() ORDER BY g.id DESC LIMIT 30").all();
  res.json({ active, recent });
});

staff.post('/guests', wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1).max(40),
    phone: z.string().trim().max(20).regex(/^[+\d\s()-]*$/).optional().or(z.literal('')),
    partySize: z.number().int().min(1).max(50),
    notes: z.string().trim().max(200).optional(),
    email: emailField,
    kind: z.enum(['table', 'order']).optional(),
  }), req.body);
  const g = createGuest({ name: body.name, phone: body.phone, email: body.email, notifyEmail: Boolean(body.email), party_size: body.partySize, notes: body.notes, kind: body.kind || 'table' });
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
  const link = `${publicBase(req)}/join${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`;
  res.json({ link, svg: await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'H', color: { dark: '#0b0b12', light: '#ffffff' } }) });
}));

/* ---- logo (PNG/JPEG/WebP only — never SVG, which can carry script) ---- */
staff.put('/logo', requireAuth('manager'), (req, res) => {
  const { dataUrl } = parse(z.object({ dataUrl: z.string().max(900_000) }), req.body);
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'Upload a PNG, JPG or WebP image' });
  const buf = Buffer.from(m[3], 'base64');
  const sig = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] }[m[2]];
  if (buf.length > 600_000 || !sig.every((b, i) => buf[i] === b)) return res.status(400).json({ error: 'That file is not a valid image (max 600 KB)' });
  db.prepare("INSERT INTO assets (key, mime, data) VALUES ('logo', ?, ?) ON CONFLICT(key) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=datetime('now')").run(m[1], buf);
  setSettings({ logo_version: String(Date.now()) });
  audit(req.user, 'settings.logo', `${Math.round(buf.length / 1024)} KB`, clientIp(req));
  io.emit('settings', getSettings());
  res.json({ ok: true, logo: `/api/public/logo?v=${getSettings().logo_version}` });
});
staff.delete('/logo', requireAuth('manager'), (req, res) => {
  db.prepare("DELETE FROM assets WHERE key='logo'").run();
  setSettings({ logo_version: '0' });
  audit(req.user, 'settings.logo_removed', null, clientIp(req));
  io.emit('settings', getSettings());
  res.json({ ok: true });
});

staff.post('/guests/:id/headsup', wrap(async (req, res) => {
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(idParam(req));
  if (!g || g.status !== 'waiting') return res.status(409).json({ error: 'Guest is not waiting' });
  const r = await sendHeadsUp(g, true);
  notifyStaff('guests');
  res.json(r);
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
  const fired = g.kind === 'table' ? fireHeldPreorder(id, tid) : null;
  if (g.kind === 'order' && g.order_id) db.prepare("UPDATE orders SET status='paid' WHERE id=? AND prepaid=1 AND status IN ('ready','sent','open')").run(g.order_id);
  Promise.resolve(G.countVisit?.(g.customer_id)).catch(() => {});
  G.scheduleFeedback?.(id);
  if (g.booking_id) db.prepare("UPDATE bookings SET status='done' WHERE id=?").run(g.booking_id);
  audit(req.user, g.kind === 'order' ? 'guest.pickedup' : 'guest.seat', `${g.name}${tid ? ` → table ${tid}` : ''}`, clientIp(req));
  notifyStaff('guests'); notifyStaff('tables');
  pushGuest(id); pushAllWaiting();
  res.json({ ok: true, preorderFired: fired });
});

staff.post('/guests/:id/remove', (req, res) => {
  const id = idParam(req);
  const { reason } = parse(z.object({ reason: z.enum(['cancelled', 'noshow']) }), req.body);
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE guests SET status=?, closed_at=? WHERE id=?').run(reason, now(), id);
  db.prepare("UPDATE tables SET status='open', guest_id=NULL WHERE guest_id=? AND status='reserved'").run(id);
  voidHeldPreorder(id);
  forgetGuestDevices(id);
  if (g.booking_id) db.prepare('UPDATE bookings SET status=? WHERE id=?').run(reason === 'noshow' ? 'noshow' : 'cancelled', g.booking_id);
  audit(req.user, `guest.${reason}`, g.name, clientIp(req));
  notifyStaff('guests'); notifyStaff('tables');
  pushGuest(id); pushAllWaiting();
  res.json({ ok: true });
});

/* ---- tables ---- */
staff.get('/tables', (req, res) => {
  res.json(db.prepare('SELECT t.*, g.name guest_name, g.party_size, u.name server_name FROM tables t LEFT JOIN guests g ON g.id=t.guest_id LEFT JOIN users u ON u.id=t.server_id ORDER BY t.id').all());
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
const menuSchema = z.object({ name: z.string().trim().min(1).max(40), category: z.string().trim().min(1).max(24), price_cents: z.number().int().min(0).max(10_000_000), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), active: z.boolean().optional(), guest_orderable: z.boolean().optional() });
staff.post('/menu', requireAuth('manager'), (req, res) => {
  const b = parse(menuSchema, req.body);
  db.prepare('INSERT INTO menu_items (name, category, price_cents, color, guest_orderable) VALUES (?, ?, ?, ?, ?)').run(b.name, b.category, b.price_cents, b.color || '#ffb020', b.guest_orderable ? 1 : 0);
  audit(req.user, 'menu.add', b.name, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
});
staff.put('/menu/:id', requireAuth('manager'), (req, res) => {
  const id = idParam(req); const b = parse(menuSchema.partial(), req.body);
  const cur = db.prepare('SELECT * FROM menu_items WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const m = { ...cur, ...b, active: b.active === undefined ? cur.active : (b.active ? 1 : 0), guest_orderable: b.guest_orderable === undefined ? cur.guest_orderable : (b.guest_orderable ? 1 : 0) };
  db.prepare('UPDATE menu_items SET name=?, category=?, price_cents=?, color=?, active=?, guest_orderable=? WHERE id=?').run(m.name, m.category, m.price_cents, m.color, m.active, m.guest_orderable, id);
  audit(req.user, 'menu.update', m.name, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
});
staff.delete('/menu/:id', requireAuth('manager'), (req, res) => {
  db.prepare('DELETE FROM menu_items WHERE id=?').run(idParam(req));
  audit(req.user, 'menu.delete', req.params.id, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
});

/* ---- orders / POS ---- */
const orderSchema = z.object({
  items: z.array(lineSchema).min(1).max(100),
  priority: z.number().int().min(0).max(2).optional(),
  clientKey: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/).optional(),
  promoCode: z.string().trim().max(30).optional(),
  tableId: z.number().int().nullable().optional(),
  customerName: z.string().trim().max(40).optional(),
  discountPct: z.number().min(0).max(100).optional(),
  attachBuzzer: z.boolean().optional(),
  phone: z.string().trim().max(20).regex(/^[+\d\s()-]*$/).optional().or(z.literal('')),
  customerId: z.number().int().optional(),
  allergies: z.array(z.string().trim().min(1).max(30)).max(12).optional(),
});

staff.post('/orders', wrap(async (req, res) => {
  const b = parse(orderSchema, req.body);
  const discountApprover = (b.discountPct || 0) > 10 && ROLE_RANK[req.user.role] < ROLE_RANK.manager ? G.hasApproval(req, 'discount') : null;
  if ((b.discountPct || 0) > 10 && ROLE_RANK[req.user.role] < ROLE_RANK.manager && !discountApprover) return res.status(403).json({ error: 'Discounts over 10% need a manager to approve', needsApproval: 'discount' });
  const lines = priceLines(b.items);
  const subtotal = lines.reduce((a, l) => a + l.qty * l.price_cents, 0);
  let discount = Math.round(subtotal * (b.discountPct || 0) / 100);
  const promo = b.promoCode && G.promoDiscount ? G.promoDiscount(b.promoCode, subtotal) : null;
  if (promo) discount = Math.max(discount, promo.cents);
  const member = b.customerId && G.memberDiscount ? G.memberDiscount(b.customerId, subtotal) : null;
  if (member) discount = Math.max(discount, member.cents);
  const made = insertOrder({ lines, status: 'sent', source: 'staff', tableId: b.tableId || null, customerName: b.customerName || null, createdBy: req.user.id, discountCents: discount, promoCode: promo?.code || null, clientKey: b.clientKey || null });
  if (made.duplicate) return res.json({ id: made.id, number: made.number, duplicate: true });
  const orderId = made.id; const number = made.number;
  if (b.priority) db.prepare('UPDATE orders SET priority = ? WHERE id = ?').run(b.priority, orderId);
  if (b.customerId || b.allergies?.length) db.prepare('UPDATE orders SET customer_id = ?, allergy_note = ? WHERE id = ?').run(b.customerId || null, b.allergies?.length ? b.allergies.join(', ') : null, orderId);
  let buzzer = null;
  if (b.attachBuzzer) {
    const g = createGuest({ kind: 'order', name: b.customerName || `Order ${number}`, phone: b.phone, party_size: 1, order_id: orderId });
    db.prepare('UPDATE orders SET guest_id=? WHERE id=?').run(g.id, orderId);
    const link = `${publicBase(req)}/b/${g.token}`;
    buzzer = { guestId: g.id, link, svg: await QRCode.toString(link, { type: 'svg', margin: 1 }) };
  }
  audit(req.user, 'order.create', `#${number} ${(subtotal / 100).toFixed(2)}${discount ? `, ${member && member.cents >= discount ? `${member.plan} ${member.pct}%` : `${b.discountPct}%`} off${discountApprover ? ` approved by ${discountApprover.name}` : ''}` : ''}`, clientIp(req));
  notifyStaff('orders'); notifyStaff('guests');
  res.json({ id: orderId, number, buzzer });
}));

staff.get('/orders', (req, res) => {
  const scope = req.query.scope === 'paid' ? "o.status IN ('paid','void') AND localdate(o.created_at) = localtoday()" : "o.status IN ('held','open','sent','ready')";
  const orders = db.prepare(`SELECT o.*, t.label table_label, u.name staff_name, g.status guest_status, g.kind guest_kind FROM orders o LEFT JOIN guests g ON g.id=o.guest_id LEFT JOIN tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.created_by WHERE ${scope} ORDER BY o.id DESC LIMIT 100`).all();
  const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${orders.map((o) => o.id).join(',') || 0})`).all();
  res.json(orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id) })));
});

/** Mark an order ready (or paid, if it was prepaid) and buzz the waiting customer. Used by the orders board and kitchen screens. */
async function markReady(o, user, ip, by) {
  const pickupGuest = o.guest_id ? db.prepare('SELECT kind FROM guests WHERE id=?').get(o.guest_id)?.kind === 'order' : false;
  db.prepare("UPDATE orders SET status=?, ready_at=? WHERE id=?").run(o.prepaid && !pickupGuest ? 'paid' : 'ready', now(), o.id);
  audit(user, 'order.ready', `#${o.number}${by && !user ? ` (${by})` : ''}`, ip);
  let buzz = null;
  if (o.guest_id && o.source !== 'guest') {
    const g = db.prepare('SELECT * FROM guests WHERE id=?').get(o.guest_id);
    const msg = o.fulfillment === 'delivery' ? `Order #${o.number} is on its way to you!` : null;
    if (g && g.kind === 'order' && ACTIVE.includes(g.status)) buzz = await buzzGuest(g, msg, user, ip);
  }
  notifyStaff('orders');
  return { ok: true, buzz };
}
G.markReady = markReady;
staff.post('/orders/:id/ready', wrap(async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(idParam(req));
  if (!o || !['held', 'open', 'sent'].includes(o.status)) return res.status(409).json({ error: 'Order not in progress' });
  res.json(await markReady(o, req.user, clientIp(req)));
}));

staff.post('/orders/:id/fire', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(idParam(req));
  if (!o || o.status !== 'held') return res.status(409).json({ error: 'Only waiting pre-orders can be started' });
  db.prepare("UPDATE orders SET status='sent', sent_at=? WHERE id=?").run(now(), o.id);
  audit(req.user, 'preorder.fire', `#${o.number}`, clientIp(req));
  notifyStaff('orders'); if (o.guest_id) pushGuest(o.guest_id);
  res.json({ ok: true });
});

staff.post('/orders/:id/pay', (req, res) => {
  const id = idParam(req);
  const b = parse(z.object({ method: z.enum(['cash', 'card', 'other']), tipCents: z.number().int().min(0).max(1_000_000).optional(), tenderedCents: z.number().int().min(0).optional() }), req.body);
  let o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o || ['paid', 'void'].includes(o.status)) return res.status(409).json({ error: 'Order already closed' });
  if (o.guest_id) setTimeout(() => pushGuest(o.guest_id), 0);
  const tip = b.tipCents || 0;
  if (o.prepaid) return res.status(409).json({ error: 'This order was already paid online' });
  // cash discount: posted prices are card prices; paying cash takes a little off
  const cashPct = Number(getSettings().cash_discount_pct) || 0;
  let cashOff = 0;
  if (b.method === 'cash' && cashPct > 0) {
    cashOff = Math.round((o.subtotal_cents - o.discount_cents) * cashPct / 100);
    const disc = o.discount_cents + cashOff;
    db.prepare('UPDATE orders SET discount_cents = ?, tax_cents = ? WHERE id = ?').run(disc, Math.round((o.subtotal_cents - disc) * Number(getSettings().tax_rate) / 100), o.id);
    o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  }
  const total = o.subtotal_cents - o.discount_cents + o.tax_cents + (o.fee_cents || 0) + tip;
  const owed = dueOf(o) + tip;
  if (b.method === 'cash' && b.tenderedCents !== undefined && b.tenderedCents < owed) return res.status(400).json({ error: 'Not enough cash tendered' });
  // still being made → stays on the kitchen screen as paid; closes when served or picked up
  const stillCooking = ['sent', 'open', 'held'].includes(o.status);
  db.prepare(`UPDATE orders SET status=?, prepaid=?, tip_cents=?, total_cents=?, payment_method=?, paid_at=?, sent_at=COALESCE(sent_at, ?) WHERE id=?`)
    .run(stillCooking ? (o.status === 'held' ? 'sent' : o.status) : 'paid', stillCooking ? 1 : 0, tip, total, o.gift_cents ? `${b.method}+gift` : b.method, now(), now(), id);
  if (o.guest_id && o.source !== 'guest') { db.prepare("UPDATE guests SET status='done', closed_at=? WHERE id=? AND kind='order' AND status IN ('waiting','buzzed','acknowledged')").run(now(), o.guest_id); pushGuest(o.guest_id); }
  audit(req.user, 'order.pay', `#${o.number} ${b.method} ${(total / 100).toFixed(2)}`, clientIp(req));
  notifyStaff('orders'); notifyStaff('guests');
  res.json({ ok: true, totalCents: owed, cashDiscountCents: cashOff, changeCents: b.tenderedCents !== undefined ? b.tenderedCents - owed : 0 });
});

staff.post('/orders/:id/void', (req, res, next) => G.managerOr('void')(req, res, next), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(idParam(req));
  if (!o || o.status === 'void') return res.status(409).json({ error: 'Cannot void' });
  db.prepare("UPDATE orders SET status='void' WHERE id=?").run(o.id);
  returnStock(o.id, req.user.id);
  if (o.guest_id && o.source !== 'guest') { db.prepare("UPDATE guests SET status='cancelled', closed_at=? WHERE id=? AND kind='order' AND status IN ('waiting','buzzed','acknowledged')").run(now(), o.guest_id); }
  if (o.guest_id) pushGuest(o.guest_id);
  audit(req.user, 'order.void', `#${o.number} ${(o.total_cents / 100).toFixed(2)}${req.approvedBy ? ` (approved by ${req.approvedBy.name})` : ''}`, clientIp(req));
  if (o.total_cents >= 5000) G.alertOwners?.(`${getSettings().business_name}: order voided`, `${req.user.name} voided order #${o.number} ($${(o.total_cents / 100).toFixed(2)})${req.approvedBy ? `, approved by ${req.approvedBy.name}` : ''}.`, 'void');
  notifyStaff('orders'); notifyStaff('guests');
  res.json({ ok: true });
});

/* ---- staff / users (manager+) ---- */
staff.get('/users', requireAuth('manager'), (req, res) => {
  res.json(db.prepare('SELECT id, name, role, active, last_login_at, created_at, hourly_cents, totp_enabled, is_driver FROM users ORDER BY active DESC, role DESC, name').all().map((u) => (req.user.role === 'owner' ? u : { ...u, hourly_cents: undefined })));
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


/* ======================================================================
   CUSTOMER ACCOUNTS + BOOKING
   ====================================================================== */
/** Current wall-clock time in the business's timezone, as 'YYYY-MM-DD' + minutes since midnight. */
function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { date, minutes, stamp: `${date} ${parts.hour}:${parts.minute}` };
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutesUntil = (startLocal, tz) => (Date.parse(`${startLocal.replace(' ', 'T')}:00Z`) - Date.parse(`${localNow(tz).stamp.replace(' ', 'T')}:00Z`)) / 60000;
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

function slotsFor(date, s) {
  const { date: today, minutes: nowMin } = localNow(s.timezone);
  if (s.booking_enabled !== '1' || s.booking_days[dow(date)] !== '1') return [];
  if (date < today || date > addDays(today, Number(s.booking_days_ahead))) return [];
  const step = Number(s.booking_slot_minutes); const cap = Number(s.booking_capacity);
  const taken = Object.fromEntries(db.prepare("SELECT substr(start_local, 12, 5) t, COUNT(*) c FROM bookings WHERE substr(start_local,1,10) = ? AND status IN ('booked','checked_in') GROUP BY t").all(date).map((r) => [r.t, r.c]));
  const out = [];
  for (let m = toMin(s.booking_open); m + step <= toMin(s.booking_close); m += step) {
    if (date === today && m <= nowMin + 5) continue;
    const t = fromMin(m);
    out.push({ time: t, left: Math.max(0, cap - (taken[t] || 0)) });
  }
  return out;
}

const customerAttempts = new Map();
const custLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Try again in a few minutes.' } });

app.get('/api/c/me', (req, res) => {
  const c = customerFromReq(req);
  if (!c) return res.status(401).json({ error: 'Please sign in' });
  res.json({ customer: c });
});

app.post('/api/c/register', custLimiter, wrap(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1).max(40),
    email: z.string().trim().toLowerCase().max(120).email('Email looks wrong'),
    phone: z.string().trim().max(20).regex(/^[+\d\s()-]*$/, 'Phone looks wrong').optional().or(z.literal('')),
    password: z.string(),
    marketingOptIn: z.boolean().optional(),
    ref: z.string().trim().max(20).optional(),
  }), req.body);
  const problem = passwordProblem(b.password); if (problem) return res.status(400).json({ error: problem });
  if (db.prepare('SELECT 1 FROM customers WHERE email = ?').get(b.email)) return res.status(409).json({ error: 'That email already has an account. Sign in instead.' });
  const id = db.prepare('INSERT INTO customers (name, email, phone, pw_hash) VALUES (?, ?, ?, ?)').run(b.name, b.email, b.phone || null, await hashPassword(b.password)).lastInsertRowid;
  if (b.marketingOptIn) db.prepare('UPDATE customers SET marketing_opt_in = 1 WHERE id = ?').run(id);
  if (b.ref) G.onCustomerJoined?.(id, b.ref);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  issueCustomerSession(res, c);
  audit(null, 'customer.register', `${c.name} <${c.email}>`, clientIp(req));
  res.json({ customer: { id: c.id, name: c.name, email: c.email, phone: c.phone } });
}));

app.post('/api/c/login', custLimiter, wrap(async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().max(120), password: z.string().max(128) }), req.body);
  const key = `${b.email}`;
  const a = customerAttempts.get(key);
  if (a && a.until > Date.now()) return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil((a.until - Date.now()) / 60000)} min.` });
  const c = db.prepare('SELECT * FROM customers WHERE email = ?').get(b.email);
  const ok = c ? await checkPassword(b.password, c.pw_hash) : (await burnCompare(b.password), false);
  if (!ok) {
    const n = (a?.n || 0) + 1;
    customerAttempts.set(key, { n: n >= 8 ? 0 : n, until: n >= 8 ? Date.now() + 15 * 60_000 : 0 });
    return res.status(401).json({ error: 'Email or password is wrong' });
  }
  customerAttempts.delete(key);
  db.prepare('UPDATE customers SET last_login_at = ? WHERE id = ?').run(now(), c.id);
  issueCustomerSession(res, c);
  res.json({ customer: { id: c.id, name: c.name, email: c.email, phone: c.phone } });
}));

app.post('/api/c/logout', (req, res) => { clearCustomerSession(res); res.json({ ok: true }); });

app.post('/api/c/push', requireCustomer, (req, res) => {
  const sub = parse(z.object({
    endpoint: z.string().url().max(800).refine((u) => u.startsWith('https://'), 'Must be https'),
    keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
  }), req.body);
  saveSubscription({ customerId: req.customer.id }, sub);
  res.json({ ok: true });
});

app.get('/api/c/booking-info', (req, res) => {
  const s = getSettings();
  const { date: today } = localNow(s.timezone);
  const days = [];
  for (let i = 0; i <= Number(s.booking_days_ahead); i++) { const d = addDays(today, i); if (s.booking_days[dow(d)] === '1') days.push(d); }
  const services = s.business_type === 'service' ? db.prepare('SELECT id, name, category, price_cents FROM menu_items WHERE active = 1 ORDER BY sort, id').all() : [];
  res.json({ enabled: s.booking_enabled === '1', days, services, slotMinutes: Number(s.booking_slot_minutes), currency: s.currency, unitLabel: s.unit_label, type: s.business_type,
    depositCents: G.depositOn?.() ? Number(s.booking_deposit_cents) : 0, refundHours: Number(s.deposit_refund_hours) });
});

app.get('/api/c/slots', publicLimiter, (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });
  res.json({ date, slots: slotsFor(date, getSettings()) });
});

app.get('/api/c/bookings', requireCustomer, (req, res) => {
  const s = getSettings();
  const rows = db.prepare("SELECT b.*, g.token FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id WHERE b.customer_id = ? AND (b.status IN ('booked','checked_in') OR b.created_at > datetime('now','-30 days')) ORDER BY b.start_local DESC LIMIT 30").all(req.customer.id);
  res.json(rows.map((b) => {
    const until = minutesUntil(b.start_local, s.timezone);
    return { id: b.id, start: b.start_local, service: b.service_name, partySize: b.party_size, notes: b.notes, status: b.status, lateMinutes: b.late_minutes || null, preorder: (() => { try { return JSON.parse(b.preorder || '[]'); } catch { return []; } })(), preorderText: G.preorderSummary ? G.preorderSummary(b) : null, canPreorder: getSettings().booking_preorder === '1' && b.status === 'booked',
      buzzer: b.status === 'checked_in' && b.token ? `/b/${b.token}` : null,
      canCheckIn: b.status === 'booked' && until <= 60 && until >= -60 && b.deposit_status !== 'pending', minutesUntil: Math.round(until),
      deposit: b.deposit_cents ? { cents: b.deposit_cents, status: b.deposit_status, code: b.deposit_code } : null };
  }));
});

app.post('/api/c/bookings', requireCustomer, custLimiter, wrap(async (req, res) => {
  const s = getSettings();
  if (s.booking_enabled !== '1') return res.status(403).json({ error: 'Online booking is turned off.' });
  const b = parse(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/),
    serviceId: z.number().int().optional(), partySize: z.number().int().min(1).max(20).optional(), notes: z.string().trim().max(200).optional(),
  }), req.body);
  const mine = db.prepare("SELECT COUNT(*) c FROM bookings WHERE customer_id = ? AND status = 'booked'").get(req.customer.id).c;
  if (mine >= 3) return res.status(409).json({ error: 'You already have 3 upcoming bookings. Cancel one to book another.' });
  const service = b.serviceId ? db.prepare('SELECT id, name FROM menu_items WHERE id = ? AND active = 1').get(b.serviceId) : null;
  const start = `${b.date} ${b.time}`;
  const id = db.transaction(() => {
    const slot = slotsFor(b.date, s).find((x) => x.time === b.time);
    if (!slot || slot.left < 1) { const e = new Error('That time was just taken. Please pick another.'); e.status = 409; throw e; }
    return db.prepare('INSERT INTO bookings (customer_id, service_id, service_name, party_size, start_local, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.customer.id, service?.id || null, service?.name || null, b.partySize || 1, start, b.notes || null).lastInsertRowid;
  }).immediate();
  audit(null, 'booking.create', `${req.customer.name} — ${start}${service ? ` (${service.name})` : ''}`, clientIp(req));
  let depositUrl = null;
  try { depositUrl = (await G.startDeposit?.(id, req))?.url || null; } catch (e) { db.prepare("UPDATE bookings SET status='cancelled', deposit_status='none' WHERE id=?").run(id); throw e; }
  notifyStaff('bookings');
  res.json({ ok: true, id, depositUrl });
}));

app.post('/api/c/bookings/:id/late', requireCustomer, (req, res) => {
  const { minutes } = parse(z.object({ minutes: z.number().int().min(5).max(60) }), req.body);
  G.bookingLate(req.customer.id, Number(req.params.id), minutes); res.json({ ok: true });
});
app.post('/api/c/bookings/:id/cancel', requireCustomer, wrap(async (req, res) => {
  const bk = db.prepare("SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'booked'").get(idParam(req), req.customer.id);
  if (!bk) return res.status(409).json({ error: 'That booking can no longer be cancelled here.' });
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(bk.id);
  const note = await G.onBookingCancel?.(bk, { minutesUntil: minutesUntil(bk.start_local, getSettings().timezone) });
  audit(null, 'booking.cancel', `${req.customer.name} #${req.params.id}`, clientIp(req));
  notifyStaff('bookings');
  res.json({ ok: true, note: note || null });
}));

function checkInBooking(bk, customer, by = null) {
  const [h, m] = bk.start_local.slice(11).split(':').map(Number);
  const time = `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  const g = createGuest({ name: customer.name, phone: customer.phone, email: customer.email, notifyEmail: true, party_size: bk.party_size,
    notes: bk.notes || null, source: 'booking', customer_id: customer.id, booking_id: bk.id });
  db.prepare("UPDATE bookings SET status = 'checked_in', guest_id = ? WHERE id = ?").run(g.id, bk.id);
  G.onBookingCheckin?.(bk, customer);
  audit(by, 'booking.checkin', `${customer.name} — ${bk.start_local}`, null);
  io.to('staff').emit('booking:arrived', { name: customer.name, time });
  notifyStaff('guests'); notifyStaff('bookings'); pushAllWaiting();
  return g;
}

app.post('/api/c/bookings/:id/checkin', requireCustomer, (req, res) => {
  const s = getSettings();
  const bk = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(idParam(req), req.customer.id);
  if (!bk || bk.status !== 'booked') return res.status(409).json({ error: 'This booking is not open for check-in.' });
  const until = minutesUntil(bk.start_local, s.timezone);
  if (until > 60) return res.status(409).json({ error: 'Check-in opens 60 minutes before your time.' });
  if (until < -60) return res.status(409).json({ error: 'This booking time has passed. Please see the front desk.' });
  const g = checkInBooking(bk, req.customer);
  res.json({ ok: true, buzzer: `/b/${g.token}` });
});

// Reminders before appointments (phone notification + optional email)
setInterval(() => forEachLocation(async () => {
  try {
    const s = getSettings();
    const lead = Number(s.booking_reminder_minutes);
    if (s.booking_enabled !== '1' || !lead) return;
    const { date } = localNow(s.timezone);
    const due = db.prepare("SELECT b.*, c.name, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.status = 'booked' AND b.reminded_at IS NULL AND substr(b.start_local,1,10) BETWEEN ? AND ?").all(date, addDays(date, 1));
    for (const b of due) {
      const until = minutesUntil(b.start_local, s.timezone);
      if (until > lead || until < 0) continue;
      db.prepare('UPDATE bookings SET reminded_at = ? WHERE id = ?').run(now(), b.id);
      const when = new Date(`${b.start_local.replace(' ', 'T')}:00Z`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
      const body = `See you at ${when}${b.service_name ? ` for ${b.service_name}` : ''}. When you arrive, open the app and tap "I'm here" to check in.`;
      await pushToCustomer(b.customer_id, { title: `${s.business_name}: appointment reminder`, body, tag: `booking-${b.id}`, url: currentSlug() === 'main' ? '/account' : `/account?l=${currentSlug()}` }).catch(() => {});
      if (emailEnabled()) await emailGuest(b.email, { businessName: s.business_name, subject: 'Appointment reminder', message: body, link: `${process.env.PUBLIC_URL || ''}/account`, accent: s.accent }).catch(() => {});
    }
  } catch (e) { console.error('reminders', e); }
}), 60_000).unref();

/* ---- staff side of bookings ---- */
staff.get('/bookings', (req, res) => {
  const s = getSettings();
  const { date } = localNow(s.timezone);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : date;
  const rows = db.prepare(`SELECT b.*, c.name, c.email, c.phone FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE substr(b.start_local,1,10) BETWEEN ? AND ? ORDER BY b.start_local`).all(from, addDays(from, 6));
  res.json({ today: date, from, bookings: rows.map((r) => ({ ...r, preorderText: G.preorderSummary ? G.preorderSummary(r) : null })), capacity: Number(s.booking_capacity) });
});
staff.post('/bookings/:id/checkin', (req, res) => {
  const bk = db.prepare('SELECT * FROM bookings WHERE id = ?').get(idParam(req));
  if (!bk || bk.status !== 'booked') return res.status(409).json({ error: 'Not open for check-in' });
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(bk.customer_id);
  checkInBooking(bk, c, req.user);
  res.json({ ok: true });
});
staff.post('/bookings/:id/status', wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['cancelled', 'noshow', 'done']) }), req.body);
  const bk = db.prepare('SELECT * FROM bookings WHERE id = ?').get(idParam(req));
  if (!bk) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, bk.id);
  if (status === 'cancelled' && bk.status === 'booked') await G.onBookingCancel?.(bk, { byBusiness: true });
  if (status === 'noshow') G.onBookingNoShow?.(bk);
  audit(req.user, `booking.${status}`, `#${bk.id} ${bk.start_local}`, clientIp(req));
  notifyStaff('bookings');
  res.json({ ok: true });
}));
staff.get('/customers', requireAuth('manager'), (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.name, c.email, c.phone, c.created_at, c.last_login_at,
    (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id) bookings,
    (SELECT COUNT(*) FROM guests g WHERE g.customer_id = c.id AND g.status IN ('seated','done')) visits
    FROM customers c ORDER BY c.id DESC LIMIT 500`).all());
});

registerCommerce({ app, staff, io, h: Object.assign(G, { wrap, parse, idParam, now, clientIp, requireAuth, notifyStaff, publicLimiter, publicBase, createGuest, pushGuest, buzzGuest, orderLimiter }) });
registerFloorPay({ app, staff, io, h: Object.assign(G, { wrap, parse, idParam, now, clientIp, requireAuth, notifyStaff, publicLimiter, publicBase }) });
registerLocations({ app, staff, h: { parse, clientIp, requireAuth, issueSession, wrap, seedDemoData } });
registerGuard({ app, staff, io, h: Object.assign(G, { wrap, parse, idParam, now, clientIp, requireAuth, issueSession, findUserByPin, loginBlocked, recordLoginFail, clearLoginFails, authLimiter, notifyStaff, pushToUsers }) });
registerGrowth({ app, staff, io, h: Object.assign(G, { parse, idParam, now, clientIp, requireAuth, notifyStaff, requireCustomer, publicLimiter }) });
registerPro({ app, staff, io, h: Object.assign(G, { wrap, parse, idParam, clientIp, requireAuth, requireCustomer, publicBase, publicLimiter, notifyStaff }) });
registerCrm({ app, staff, h: G });
registerBack({ app, staff, h: G });
registerPayments({ app, staff, io, h: G });
registerClub({ app, staff, h: G });
registerReach({ app, staff, h: G });
registerPeople({ app, staff, io, h: G });
registerExtras({ app, staff, io, h: G });
registerHouse({ app, staff, io, h: G });
registerPlus({ app, staff, io, h: G });
registerMore({ app, staff, io, h: G });
registerOwner({ app, staff, io, h: G });
registerSmart({ app, staff, io, h: G });
registerTimeClock({ app, staff, io, h: G });
registerDesk({ app, staff, io, h: G });
registerKds({ app, staff, io, h: G });
registerCrew({ app, staff, io, h: G });
registerPace({ app, staff, io, h: G });
registerLine({ app, staff, io, h: G });
registerPass({ app, staff, io, h: G });
registerRun({ app, staff, io, h: G });
registerTable({ app, staff, io, h: G });
G.requireCustomer = requireCustomer;
registerStation({ app, staff, io, h: G });
registerDelivery({ app, staff, io, h: Object.assign(G, { createGuest, pushGuest, findUserByPin }) });
registerTeam({ app, staff, h: Object.assign(G, { wrap, parse, idParam, clientIp, requireAuth, requireCustomer, publicBase, publicLimiter, notifyStaff }) });
registerOps({ app, staff, io, h: { managerOr: G.managerOr, shiftConflicts: (...a) => (G.shiftConflicts ? G.shiftConflicts(...a) : []), wrap, parse, idParam, now, notifyStaff, clientIp, requireAuth, authLimiter, findUserByPin, loginBlocked, recordLoginFail, clearLoginFails } });

app.use('/api/staff', staff);

app.get('/healthz', (req, res) => res.json({ ok: true }));

/* ---------- static client ---------- */
const DIST = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false, maxAge: IS_PROD ? '1h' : 0, setHeaders: (res, p) => { if (p.includes('/assets/')) res.set('Cache-Control', 'public, max-age=31536000, immutable'); if (p.endsWith('sw.js') || p.endsWith('.webmanifest')) res.set('Cache-Control', 'no-cache'); } }));
  app.get('/go', (req, res, next) => (G.linkHubHtml ? G.linkHubHtml(DIST)(req, res) : next()));
  app.get(/^\/(?!api|socket\.io).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Server error' : err.message, ...(err.needsManager ? { needsManager: true } : {}), ...(err.overtime ? { overtime: err.overtime } : {}), ...(err.needsAllergyCheck ? { needsAllergyCheck: true } : {}), ...(err.needsCorrective ? { needsCorrective: true } : {}), ...(err.needsPhoto ? { needsPhoto: true } : {}) });
});

/* ---------- realtime ---------- */
io.use((socket, next) => runIn((socket.data.slug = slugForSocket(socket)), () => {
  const cookies = Object.fromEntries((socket.handshake.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
  const user = userFromToken(cookies[SESSION_COOKIE]);
  const guestToken = socket.handshake.auth?.guestToken;
  if (user) { socket.data.user = user; return next(); }
  if (guestToken) { const g = guestByToken(guestToken); if (g) { socket.data.guestId = g.id; return next(); } }
  next(new Error('unauthorized'));
}));
io.on('connection', (socket) => runIn(socket.data.slug, () => {
  const L = socket.data.slug;
  socket.join(`${L}:all`);
  if (socket.data.user) {
    socket.join(`${L}:staff`);
    socket.join(`${L}:user:${socket.data.user.id}`);
    if (ROLE_RANK[socket.data.user.role] >= ROLE_RANK.manager) socket.join(`${L}:owners`);
  } else if (socket.data.guestId) {
    socket.join(`${L}:guest:${socket.data.guestId}`);
    pushGuest(socket.data.guestId);
  }
}));

server.listen(PORT, () => console.log(`BuzzHub listening on :${PORT}`));
