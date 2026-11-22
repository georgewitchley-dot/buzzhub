// Round 5, batch H: driver dispatch with live location, and a self-order kiosk.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, registerSchema, currentSlug, getJwtSecret } from './db.js';
import { priceLines, insertOrder, menuWithMods, stripeEnabled, lineSchema } from './commerce.js';
import { pushToGuest } from './notify.js';

registerSchema((db) => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('users').includes('is_driver')) db.exec('ALTER TABLE users ADD COLUMN is_driver INTEGER NOT NULL DEFAULT 0');
  const o = cols('orders');
  for (const [c, t] of [['driver_id', 'INTEGER'], ['out_at', 'TEXT'], ['delivered_at', 'TEXT'], ['drop_lat', 'REAL'], ['drop_lng', 'REAL']]) if (!o.includes(c)) db.exec(`ALTER TABLE orders ADD COLUMN ${c} ${t}`);
  db.exec('CREATE TABLE IF NOT EXISTS driver_pos (user_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, at TEXT NOT NULL)');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const km = (a, b) => {
  const R = 6371; const r = (x) => (x * Math.PI) / 180;
  const d = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(d));
};
const geoCache = new Map();
async function geocode(address) {
  if (!address) return null;
  if (geoCache.has(address)) return geoCache.get(address);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`, { headers: { 'User-Agent': 'BuzzHub/1.0 (restaurant delivery)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(6000) });
    const j = await r.json(); const hit = j?.[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
    geoCache.set(address, hit); return hit;
  } catch { return null; }
}

export function deliveryView(orderId) {
  if (!orderId) return null;
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.fulfillment !== 'delivery') return null;
  const d = o.driver_id ? db.prepare('SELECT u.name, p.lat, p.lng, p.at FROM users u LEFT JOIN driver_pos p ON p.user_id = u.id WHERE u.id = ?').get(o.driver_id) : null;
  const status = o.delivered_at ? 'delivered' : o.out_at ? 'out' : o.driver_id ? 'assigned' : 'waiting';
  const fresh = d?.at && Date.now() - Date.parse(`${d.at.replace(' ', 'T')}Z`) < 5 * 60_000;
  const drop = o.drop_lat != null ? { lat: o.drop_lat, lng: o.drop_lng } : null;
  let eta = null; let dist = null;
  if (status === 'out' && fresh && drop) { dist = km({ lat: d.lat, lng: d.lng }, drop); eta = Math.max(1, Math.round((dist / 28) * 60 * 1.3)); }
  return { status, driverName: d?.name?.split(' ')[0] || null, driver: status === 'out' && fresh ? { lat: d.lat, lng: d.lng } : null, drop: status === 'out' ? drop : null, etaMinutes: eta, distanceKm: dist !== null ? Math.round(dist * 10) / 10 : null };
}

export function registerDelivery({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, notifyStaff, publicBase, publicLimiter, createGuest, pushGuest, findUserByPin } = h;
  h.deliveryView = deliveryView; h.geocode = geocode;
  const guestOf = (o) => (o.guest_id ? db.prepare('SELECT * FROM guests WHERE id = ?').get(o.guest_id) : null);

  /* ================= Drivers ================= */
  staff.put('/users/:id/driver', requireAuth('manager'), (req, res) => {
    const { driver } = parse(z.object({ driver: z.boolean() }), req.body);
    db.prepare('UPDATE users SET is_driver = ? WHERE id = ?').run(driver ? 1 : 0, idParam(req));
    audit(req.user, driver ? 'driver.on' : 'driver.off', `user ${req.params.id}`, clientIp(req)); res.json({ ok: true });
  });
  staff.get('/deliveries', (req, res) => {
    const me = db.prepare('SELECT is_driver FROM users WHERE id = ?').get(req.user.id);
    const rows = db.prepare(`SELECT o.id, o.number, o.status, o.customer_name, o.delivery_address, o.contact_phone, o.order_notes, o.total_cents, o.subtotal_cents, o.discount_cents, o.tax_cents, o.fee_cents, o.gift_cents, o.prepaid, o.paid_at,
        o.driver_id, o.out_at, o.delivered_at, o.ready_at, o.created_at, u.name driver_name,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) lines
      FROM orders o LEFT JOIN users u ON u.id = o.driver_id
      WHERE o.fulfillment = 'delivery' AND o.status <> 'void' AND (o.delivered_at IS NULL OR o.delivered_at > datetime('now','-3 hours')) ORDER BY o.id DESC LIMIT 60`).all();
    const drivers = db.prepare('SELECT u.id, u.name, p.lat, p.lng, p.at, (SELECT COUNT(*) FROM orders o WHERE o.driver_id = u.id AND o.delivered_at IS NULL AND o.status <> \'void\') active FROM users u LEFT JOIN driver_pos p ON p.user_id = u.id WHERE u.active = 1 AND u.is_driver = 1 ORDER BY u.name').all();
    const due = (o) => o.subtotal_cents - o.discount_cents + o.tax_cents + (o.fee_cents || 0) - (o.gift_cents || 0);
    const list = rows.map((o) => ({ ...o, dueCents: o.prepaid || o.paid_at ? 0 : due(o), mapsUrl: o.delivery_address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(o.delivery_address)}` : null }));
    const visible = ['manager', 'owner'].includes(req.user.role) ? list : list.filter((o) => o.driver_id === req.user.id);
    res.json({ isDriver: Boolean(me?.is_driver), canDispatch: ['manager', 'owner'].includes(req.user.role), orders: visible, mine: list.filter((o) => o.driver_id === req.user.id && !o.delivered_at), drivers });
  });
  staff.post('/orders/:id/assign', requireAuth('manager'), wrap(async (req, res) => {
    const { driverId } = parse(z.object({ driverId: z.number().int().nullable() }), req.body);
    const o = db.prepare("SELECT * FROM orders WHERE id = ? AND fulfillment = 'delivery'").get(idParam(req));
    if (!o || o.delivered_at || o.status === 'void') throw err('This delivery is closed', 409);
    if (driverId && !db.prepare('SELECT 1 FROM users WHERE id = ? AND is_driver = 1 AND active = 1').get(driverId)) throw err('Pick a driver');
    db.prepare('UPDATE orders SET driver_id = ? WHERE id = ?').run(driverId, o.id);
    if (driverId && o.drop_lat == null) { const g = await geocode(o.delivery_address); if (g) db.prepare('UPDATE orders SET drop_lat = ?, drop_lng = ? WHERE id = ?').run(g.lat, g.lng, o.id); }
    if (driverId) { io.to(`user:${driverId}`).emit('delivery:assigned', { number: o.number }); h.pushToUsers?.(['staff', 'manager', 'owner'], { title: 'New delivery', body: `Order #${o.number}: ${o.delivery_address || ''}`, tag: `drv-${o.id}`, url: '/deliveries' }, driverId); }
    audit(req.user, 'delivery.assign', `#${o.number} → ${driverId || 'none'}`, clientIp(req));
    notifyStaff('orders'); res.json({ ok: true });
  }));
  const mineOrMgr = (req, o) => o.driver_id === req.user.id || ['manager', 'owner'].includes(req.user.role);
  staff.post('/orders/:id/out', wrap(async (req, res) => {
    const o = db.prepare("SELECT * FROM orders WHERE id = ? AND fulfillment = 'delivery'").get(idParam(req));
    if (!o || o.delivered_at) throw err('This delivery is closed', 409);
    if (!o.driver_id) db.prepare('UPDATE orders SET driver_id = ? WHERE id = ?').run(req.user.id, o.id);
    else if (!mineOrMgr(req, o)) throw err('This delivery is assigned to someone else', 403);
    if (o.drop_lat == null) { const g = await geocode(o.delivery_address); if (g) db.prepare('UPDATE orders SET drop_lat = ?, drop_lng = ? WHERE id = ?').run(g.lat, g.lng, o.id); }
    db.prepare("UPDATE orders SET out_at = ?, status = CASE WHEN status IN ('sent','open') THEN 'ready' ELSE status END, ready_at = COALESCE(ready_at, ?) WHERE id = ?").run(now(), now(), o.id);
    const g = guestOf(o);
    if (g) { pushToGuest(g.id, { title: `${getSettings().business_name}: on its way`, body: `${req.user.name.split(' ')[0]} is bringing order #${o.number}. Tap to watch it arrive.`, tag: 'delivery', url: `/b/${g.token}` }).catch(() => {}); pushGuest(g.id); }
    audit(req.user, 'delivery.out', `#${o.number}`, clientIp(req)); notifyStaff('orders'); res.json({ ok: true });
  }));
  staff.post('/orders/:id/delivered', (req, res) => {
    const b = parse(z.object({ method: z.enum(['cash', 'card', 'other']).optional(), tipCents: z.number().int().min(0).max(100000).default(0) }), req.body);
    const o = db.prepare("SELECT * FROM orders WHERE id = ? AND fulfillment = 'delivery'").get(idParam(req));
    if (!o || o.delivered_at) throw err('Already delivered', 409);
    if (!mineOrMgr(req, o)) throw err('This delivery is assigned to someone else', 403);
    if (h.needsSignature?.(o)) throw Object.assign(err('Get the customer to sign first', 409), { needsSignature: true });
    const t = now();
    if (o.prepaid || o.paid_at) { db.prepare("UPDATE orders SET delivered_at = ?, status = 'paid' WHERE id = ?").run(t, o.id); h.doorTip?.(o, b.tipCents, req.user); }
    else {
      if (!b.method) throw err('How did they pay? Pick cash, card or other.');
      const total = o.subtotal_cents - o.discount_cents + o.tax_cents + (o.fee_cents || 0) + b.tipCents;
      db.prepare("UPDATE orders SET delivered_at = ?, status = 'paid', paid_at = ?, payment_method = ?, tip_cents = ?, total_cents = ? WHERE id = ?").run(t, t, b.method, b.tipCents, total, o.id);
    }
    const g = guestOf(o);
    if (g) { db.prepare("UPDATE guests SET status = 'done', closed_at = ? WHERE id = ? AND status IN ('waiting','buzzed','acknowledged')").run(t, g.id); pushGuest(g.id); }
    audit(req.user, 'delivery.done', `#${o.number}${b.method ? ` collected ${b.method}` : ''}`, clientIp(req));
    h.afterDelivered?.(db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id), req);
    notifyStaff('orders'); notifyStaff('guests'); res.json({ ok: true });
  });
  const lastPush = new Map();
  staff.post('/driver/location', (req, res) => {
    const b = parse(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }), req.body);
    db.prepare('INSERT INTO driver_pos (user_id, lat, lng, at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, at = excluded.at').run(req.user.id, b.lat, b.lng, now());
    const out = db.prepare("SELECT guest_id FROM orders WHERE driver_id = ? AND out_at IS NOT NULL AND delivered_at IS NULL AND guest_id IS NOT NULL").all(req.user.id);
    const k = `${currentSlug()}:${req.user.id}`;
    if (Date.now() - (lastPush.get(k) || 0) > 8000) { lastPush.set(k, Date.now()); out.forEach((x) => pushGuest(x.guest_id)); io.to('owners').emit('driver:pos', { id: req.user.id, ...b }); }
    res.json({ ok: true, live: out.length });
  });

  /* ================= Self-order kiosk ================= */
  const kioskSecret = () => `${getJwtSecret()}:kiosk`;
  const kioskFrom = (req) => {
    const t = String(req.get('X-Kiosk') || '');
    try { const p = jwt.verify(t, kioskSecret()); if (p.loc !== currentSlug() || String(p.v) !== String(getSettings().kiosk_version || '1')) return null; return p; } catch { return null; }
  };
  const needKiosk = (req, res, next) => { const k = kioskFrom(req); if (!k) return res.status(401).json({ error: 'This kiosk is signed out. A manager needs to start it again.' }); req.kiosk = k; next(); };
  staff.post('/kiosk/start', requireAuth('manager'), (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(30).default('Kiosk') }), req.body || {});
    const token = jwt.sign({ kind: 'kiosk', loc: currentSlug(), name, v: getSettings().kiosk_version || '1', by: req.user.id }, kioskSecret(), { expiresIn: '180d' });
    audit(req.user, 'kiosk.start', name, clientIp(req)); res.json({ token, loc: currentSlug() });
  });
  staff.post('/kiosk/signout-all', requireAuth('manager'), (req, res) => {
    setSettings({ kiosk_version: String(Number(getSettings().kiosk_version || '1') + 1) });
    audit(req.user, 'kiosk.signout_all', '', clientIp(req)); res.json({ ok: true });
  });
  app.get('/api/k/menu', publicLimiter, needKiosk, (req, res) => {
    const s = getSettings();
    res.json({ name: req.kiosk.name, business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null, type: s.business_type },
      currency: s.currency, taxRate: Number(s.tax_rate), items: menuWithMods(), payCard: stripeEnabled() && Boolean(s.kiosk_reader_id), dineIn: s.business_type !== 'service', message: s.kiosk_message || '' });
  });
  app.post('/api/k/order', publicLimiter, needKiosk, wrap(async (req, res) => {
    const b = parse(z.object({
      items: z.array(lineSchema).min(1).max(40),
      name: z.string().trim().min(1).max(40), where: z.enum(['here', 'togo']).default('togo'), pay: z.enum(['counter', 'card']), promoCode: z.string().trim().max(30).optional(), clientKey: z.string().max(64).optional(),
    }), req.body);
    const lines = priceLines(b.items);
    const subtotal = lines.reduce((a, l) => a + l.qty * l.price_cents, 0);
    const promo = b.promoCode && h.promoDiscount ? h.promoDiscount(b.promoCode, subtotal) : null;
    const made = insertOrder({ lines, status: 'sent', source: 'kiosk', customerName: b.name, discountCents: promo?.cents || 0, promoCode: promo?.code || null, fulfillment: b.where === 'here' ? 'dine_in' : 'pickup', clientKey: b.clientKey || null, notes: b.where === 'here' ? 'Eat here' : 'To go' });
    const g = createGuest({ kind: 'order', name: b.name, party_size: 1, order_id: made.id, source: 'kiosk' });
    db.prepare('UPDATE orders SET guest_id = ? WHERE id = ?').run(g.id, made.id);
    const link = `${publicBase(req)}/b/${g.token}`;
    let charge = null;
    const s = getSettings();
    if (b.pay === 'card') {
      if (!stripeEnabled() || !s.kiosk_reader_id) throw err('Card payment is not set up on this kiosk. Pay at the counter.');
      charge = await h.startReaderCharge({ orderId: made.id, readerId: s.kiosk_reader_id, label: 'Kiosk' }, null);
    }
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(made.id);
    audit(null, 'kiosk.order', `#${made.number} ${req.kiosk.name} ${(o.total_cents / 100).toFixed(2)} ${b.pay}`, clientIp(req));
    notifyStaff('orders'); notifyStaff('guests');
    io.to('staff').emit('online:new', { number: made.number, kind: 'kiosk' });
    res.json({ number: made.number, totalCents: o.total_cents, buzzer: link, svg: await QRCode.toString(link, { type: 'svg', margin: 1 }), charge });
  }));
  app.get('/api/k/charge/:id', publicLimiter, needKiosk, wrap(async (req, res) => {
    const r = await h.readerChargeStatus(idParam(req)); if (!r) throw err('Not found', 404); res.json(r);
  }));
  app.post('/api/k/exit', publicLimiter, needKiosk, wrap(async (req, res) => {
    const { pin } = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/) }), req.body);
    const ip = clientIp(req); const blocked = h.loginBlocked?.(ip);
    if (blocked) throw err(`Too many wrong PINs. Try again in ${blocked}s.`, 429);
    const u = await findUserByPin(pin);
    if (!u || !['manager', 'owner'].includes(u.role)) { h.recordLoginFail?.(ip); throw err('A manager PIN is needed to leave the kiosk', 401); }
    audit(u, 'kiosk.exit', req.kiosk.name, clientIp(req)); res.json({ ok: true });
  }));
}
