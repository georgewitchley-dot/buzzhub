// Batch 4: multiple locations. One database per location; this module picks the right one for each
// request and live connection, and lets owners add locations, switch between them, and see them all at once.
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, runIn, currentSlug, allSlugs, locationExists, listLocations, createLocationDb, SLUG_RE, localToday } from './db.js';
import { SESSION_COOKIE, CUSTOMER_COOKIE, locOfToken, ROLE_RANK } from './security.js';

/* ---------- which location is this request for? ---------- */
const tokenCache = new Map();
function slugForToken(table, token, column = 'token') {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token || '')) return null;
  const key = `${table}:${token}`;
  if (tokenCache.has(key)) return tokenCache.get(key);
  for (const slug of allSlugs()) {
    const hit = runIn(slug, () => db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(token));
    if (hit) { if (tokenCache.size > 5000) tokenCache.clear(); tokenCache.set(key, slug); return slug; }
  }
  return null;
}
export function resolveSlug(req) {
  const m = /^\/api\/(g|f|p|t|r)\/([A-Za-z0-9_-]{16,40})/.exec(req.path);
  if (m) { const s = m[1] === 'p' ? slugForToken('bills', m[2]) : m[1] === 't' ? slugForToken('tables', m[2], 'qr_token') : m[1] === 'r' ? slugForToken('orders', m[2], 'receipt_token') : slugForToken(m[1] === 'g' ? 'guests' : 'feedback', m[2]); if (s) return s; }
  const pick = [req.get('X-Location'), req.query?.l, locOfToken(req.cookies?.[SESSION_COOKIE] || ''), locOfToken(req.cookies?.[CUSTOMER_COOKIE] || ''), req.cookies?.bh_loc];
  for (const p of pick) if (typeof p === 'string' && p && locationExists(p)) return p;
  return 'main';
}
export const locationMiddleware = (req, res, next) => runIn(resolveSlug(req), next);

/** Make every Socket.IO room and broadcast location-scoped, using the current location. */
export function scopeSockets(io) {
  const rawTo = io.to.bind(io);
  io.to = (room) => rawTo(`${currentSlug()}:${room}`);
  io.emit = (...args) => rawTo(`${currentSlug()}:all`).emit(...args);
  return { slugForSocket(socket) {
    const cookies = Object.fromEntries((socket.handshake.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
    const gt = socket.handshake.auth?.guestToken;
    if (gt) { const s = slugForToken('guests', gt); if (s) return s; }
    const pick = [socket.handshake.auth?.loc, locOfToken(cookies[SESSION_COOKIE] || ''), cookies.bh_loc];
    for (const p of pick) if (typeof p === 'string' && p && locationExists(p)) return p;
    return 'main';
  } };
}

const slugify = (name) => name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 24) || 'location';

export function registerLocations({ app, staff, h }) {
  const { parse, clientIp, requireAuth, issueSession, wrap } = h;

  app.get('/api/public/locations', (req, res) => {
    const list = listLocations();
    res.json({ current: currentSlug(), locations: list.length > 1 ? list.map((l) => ({ slug: l.slug, name: l.name })) : [] });
  });

  const hubKeyOf = (uid) => {
    const u = db.prepare('SELECT hub_key FROM users WHERE id = ?').get(uid);
    if (u?.hub_key) return u.hub_key;
    const k = crypto.randomBytes(12).toString('base64url');
    db.prepare('UPDATE users SET hub_key = ? WHERE id = ?').run(k, uid);
    return k;
  };
  /** Locations where this person (same hub key) is a manager or owner. */
  const myLocations = (key) => allSlugs().map((slug) => runIn(slug, () => {
    const u = db.prepare('SELECT id, role FROM users WHERE hub_key = ? AND active = 1').get(key);
    return u && ROLE_RANK[u.role] >= ROLE_RANK.manager ? { slug, userId: u.id, role: u.role, name: getSettings().business_name } : null;
  })).filter(Boolean);

  function snapshot() {
    const s = getSettings();
    const waiting = db.prepare("SELECT COUNT(*) c FROM guests WHERE kind='table' AND status IN ('waiting','buzzed','acknowledged')").get().c;
    const sales = db.prepare("SELECT COALESCE(SUM(total_cents),0) t, COUNT(*) n FROM orders WHERE paid_at IS NOT NULL AND status <> 'void' AND localdate(paid_at) = localtoday()").get();
    const open = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('open','sent','ready','held')").get().c;
    const tables = db.prepare("SELECT COUNT(*) total, SUM(status='seated') seated FROM tables").get();
    const clock = db.prepare('SELECT COUNT(*) c FROM shifts WHERE clock_out IS NULL').get().c;
    const rating = db.prepare("SELECT AVG(rating) a FROM feedback WHERE responded_at > datetime('now','-7 days')").get().a;
    const bookings = db.prepare("SELECT COUNT(*) c FROM bookings WHERE substr(start_local,1,10) = ? AND status IN ('booked','checked_in')").get(localToday()).c;
    return { name: s.business_name, type: s.business_type, currency: s.currency, accent: s.accent, waiting, salesCents: sales.t, orders: sales.n, openOrders: open, seated: tables.seated || 0, tables: tables.total, onClock: clock, rating7: rating ? Math.round(rating * 10) / 10 : null, bookingsToday: bookings };
  }

  staff.get('/locations', requireAuth('manager'), (req, res) => {
    const key = hubKeyOf(req.user.id);
    const mine = myLocations(key);
    res.json({ current: currentSlug(), canAdd: req.user.role === 'owner', locations: mine.map((l) => ({ slug: l.slug, name: l.name, role: l.role, ...runIn(l.slug, snapshot) })) });
  });

  staff.post('/locations', requireAuth('owner'), wrap(async (req, res) => {
    const b = parse(z.object({
      name: z.string().trim().min(1).max(60), type: z.enum(['restaurant', 'cafe', 'service']),
      copyMenu: z.boolean().optional(), copyTeam: z.boolean().optional(), copyBrand: z.boolean().optional(),
    }), req.body);
    let slug = slugify(b.name); let n = 2;
    while (locationExists(slug) || slug === 'main' || !SLUG_RE.test(slug)) slug = `${slugify(b.name).slice(0, 20)}-${n++}`;
    const from = getSettings();
    const key = hubKeyOf(req.user.id);
    const users = db.prepare(`SELECT * FROM users WHERE active = 1 ${b.copyTeam ? '' : 'AND id = ?'}`).all(...(b.copyTeam ? [] : [req.user.id]));
    for (const u of users) if (!u.hub_key) { u.hub_key = crypto.randomBytes(12).toString('base64url'); db.prepare('UPDATE users SET hub_key = ? WHERE id = ?').run(u.hub_key, u.id); }
    const owner = users.find((u) => u.id === req.user.id); owner.hub_key = key;
    const menu = b.copyMenu ? db.prepare('SELECT * FROM menu_items').all() : [];
    const logo = b.copyBrand ? db.prepare("SELECT * FROM assets WHERE key = 'logo'").get() : null;
    createLocationDb(slug, b.name);
    runIn(slug, () => {
      const unit = { restaurant: 'Table', cafe: 'Order', service: 'Appointment' }[b.type];
      setSettings({ business_name: b.name, business_type: b.type, unit_label: unit, timezone: from.timezone, currency: from.currency, tax_rate: from.tax_rate,
        accent: b.copyBrand ? from.accent : '#ffb020', booking_enabled: b.type === 'service' ? '1' : '0', preorder_enabled: b.type === 'service' ? '0' : '1', review_url: b.copyBrand ? from.review_url : '' });
      const ins = db.prepare('INSERT INTO users (name, role, pin_hash, hub_key, totp_secret, totp_enabled, hourly_cents) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const u of users) ins.run(u.name, u.role, u.pin_hash, u.hub_key, u.totp_secret, u.totp_enabled, u.hourly_cents || 0);
      if (menu.length) { const im = db.prepare('INSERT INTO menu_items (name, category, price_cents, color, active, sort, guest_orderable) VALUES (?, ?, ?, ?, ?, ?, ?)'); for (const m of menu) im.run(m.name, m.category, m.price_cents, m.color, m.active, m.sort, m.guest_orderable); }
      if (logo) { db.prepare('INSERT INTO assets (key, mime, data) VALUES (?, ?, ?)').run('logo', logo.mime, logo.data); setSettings({ logo_version: String(Date.now()) }); }
      h.seedDemoData(b.type);
      audit({ id: null, name: req.user.name }, 'location.created', `from ${from.business_name}`, clientIp(req));
    });
    audit(req.user, 'location.add', `${b.name} (${slug})${b.copyTeam ? ', with team' : ''}${b.copyMenu ? ', with menu' : ''}`, clientIp(req));
    res.json({ ok: true, slug });
  }));

  staff.post('/locations/switch', requireAuth('manager'), (req, res) => {
    const { slug } = parse(z.object({ slug: z.string().max(40) }), req.body);
    const key = hubKeyOf(req.user.id);
    const target = myLocations(key).find((l) => l.slug === slug);
    if (!target) return res.status(403).json({ error: 'You are not a manager or owner there' });
    runIn(slug, () => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(target.userId);
      issueSession(res, u);
      audit(u, 'auth.switch_location', `from ${req.user.name}'s session`, clientIp(req));
    });
    res.cookie('bh_loc', slug, { httpOnly: false, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 400 * 86400 * 1000, path: '/' });
    res.json({ ok: true, slug });
  });
}
