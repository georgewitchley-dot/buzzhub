// Round 19: server workstation (fire a table's next course), rush/VIP tickets, prep batch recipes, delivery photos,
// pre-orders with bookings, "same again" on tabs, gift cards and member perks on table checks, server checkout.
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, getJwtSecret } from './db.js';
import { userFromToken, SESSION_COOKIE } from './security.js';
import { dayBounds } from './ops.js';
import { priceLines, insertOrder } from './commerce.js';
import { shiftTipout } from './line.js';

registerSchema((db) => {
  const o = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!o.includes('priority')) db.exec('ALTER TABLE orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  const b = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  if (b.length && !b.includes('preorder')) db.exec('ALTER TABLE bookings ADD COLUMN preorder TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS delivery_photos (order_id INTEGER PRIMARY KEY, data TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v) ?? d; } catch { return d; } };
export const PRIORITY = { 0: null, 1: 'RUSH', 2: 'VIP' };

export function registerStation({ app, staff, h }) {
  const { parse, clientIp, requireAuth, notifyStaff, publicLimiter, requireCustomer } = h;
  const mgr = requireAuth('manager');
  const who = (req) => {
    const t = req.get('X-Kds');
    if (t) { try { const p = jwt.verify(t, `${getJwtSecret()}:kds`); if (p.loc === currentSlug() && String(p.v) === String(getSettings().kds_version || '1')) return { area: p.area, user: null }; } catch { /* bad */ } throw err('This kitchen screen is signed out.', 401); }
    let user = null; try { user = req.cookies?.[SESSION_COOKIE] ? userFromToken(req.cookies[SESSION_COOKIE]) : null; } catch { user = null; }
    if (!user) throw err('Sign in first', 401);
    return { area: String(req.query.area || req.body?.area || 'All areas'), user };
  };

  /* ===== fire a table's next course from the workstation ===== */
  const heldFor = (tableId) => db.prepare("SELECT oi.course, COUNT(*) n, GROUP_CONCAT(oi.qty || ' ' || oi.name, ', ') items FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND o.status IN ('open','sent','ready') AND oi.fired_at IS NULL AND oi.course > 1 GROUP BY oi.course ORDER BY oi.course").all(tableId);
  staff.get('/tables/:id/held', (req, res) => res.json(heldFor(Number(req.params.id)).map((c) => ({ ...c, fireIn: null }))));
  staff.post('/tables/:id/fire-course', (req, res) => {
    const tid = Number(req.params.id); const held = heldFor(tid); if (!held.length) throw err('Nothing is waiting to be fired', 409);
    const { course } = parse(z.object({ course: z.number().int().min(2).max(3).optional() }), req.body || {});
    const c = course || held[0].course;
    const orders = db.prepare("SELECT DISTINCT o.id, o.number, o.status FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.table_id = ? AND o.status IN ('open','sent','ready') AND oi.fired_at IS NULL AND oi.course = ?").all(tid, c);
    for (const o of orders) {
      db.prepare("UPDATE order_items SET fired_at = datetime('now') WHERE order_id = ? AND fired_at IS NULL AND course = ?").run(o.id, c);
      if (o.status === 'ready') db.prepare("UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?").run(o.id);
    }
    const t = db.prepare('SELECT label FROM tables WHERE id = ?').get(tid);
    audit(req.user, 'order.fire', `${getSettings().unit_label} ${t?.label} course ${c} (${orders.map((o) => `#${o.number}`).join(' ')})`, clientIp(req)); notifyStaff('orders');
    res.json({ ok: true, course: c, orders: orders.length });
  });

  /* ===== rush / VIP tickets ===== */
  const setPriority = (orderId, p, user, ip, by) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId); if (!o) throw err('Not found', 404);
    db.prepare('UPDATE orders SET priority = ? WHERE id = ?').run(p, o.id);
    audit(user, 'order.priority', `#${o.number} ${PRIORITY[p] || 'normal'}${by ? ` (${by})` : ''}`, ip); notifyStaff('orders');
  };
  staff.post('/orders/:id/priority', (req, res) => { const { priority } = parse(z.object({ priority: z.number().int().min(0).max(2) }), req.body); setPriority(Number(req.params.id), priority, req.user, clientIp(req)); res.json({ ok: true }); });
  app.post('/api/kds/priority', (req, res) => { const w = who(req); const b = parse(z.object({ orderId: z.number().int(), priority: z.number().int().min(0).max(2) }), req.body); setPriority(b.orderId, b.priority, w.user, clientIp(req), w.user ? null : `${w.area} screen`); res.json({ ok: true }); });

  /* ===== prep batch recipes ===== */
  h.prepRecipe = (itemId, qty) => db.prepare('SELECT g.id, g.name, g.unit, r.qty FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ? ORDER BY g.name').all(itemId)
    .map((r) => ({ id: r.id, name: r.name, unit: r.unit, per: r.qty, total: Math.round(r.qty * qty * 100) / 100 }));

  /* ===== delivery photos ===== */
  staff.post('/orders/:id/drop-photo', (req, res) => {
    const { photo } = parse(z.object({ photo: z.string().max(400000) }), req.body);
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo)) throw err('Bad photo');
    const o = db.prepare("SELECT * FROM orders WHERE id = ? AND fulfillment = 'delivery'").get(Number(req.params.id)); if (!o) throw err('Not found', 404);
    db.prepare('INSERT OR REPLACE INTO delivery_photos (order_id, data) VALUES (?, ?)').run(o.id, photo);
    audit(req.user, 'delivery.photo', `#${o.number}`, clientIp(req)); if (o.guest_id) h.pushGuest?.(o.guest_id); notifyStaff('orders'); res.json({ ok: true });
  });
  h.dropPhotoFor = (orderId) => (db.prepare('SELECT 1 FROM delivery_photos WHERE order_id = ?').get(orderId) ? true : false);
  app.get('/api/g/:token/drop-photo', publicLimiter, (req, res) => {
    const g = db.prepare('SELECT order_id FROM guests WHERE token = ?').get(String(req.params.token)); if (!g?.order_id) return res.status(404).end();
    const p = db.prepare('SELECT data FROM delivery_photos WHERE order_id = ?').get(g.order_id); if (!p) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=600').send(Buffer.from(p.data.split(',')[1], 'base64'));
  });
  staff.get('/orders/:id/drop-photo', (req, res) => { const p = db.prepare('SELECT data FROM delivery_photos WHERE order_id = ?').get(Number(req.params.id)); if (!p) return res.status(404).end(); res.set('Content-Type', 'image/jpeg').send(Buffer.from(p.data.split(',')[1], 'base64')); });

  /* ===== pre-order with a booking ===== */
  const lineSchema = z.array(z.object({ itemId: z.number().int(), qty: z.number().int().min(1).max(20), mods: z.array(z.number().int()).max(20).optional(), note: z.string().max(80).optional() })).max(30);
  app.put('/api/c/bookings/:id/preorder', requireCustomer, (req, res) => {
    if (getSettings().booking_preorder !== '1') throw err('Pre-ordering is not available', 403);
    const { lines } = parse(z.object({ lines: lineSchema }), req.body);
    const bk = db.prepare("SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'booked'").get(Number(req.params.id), req.customer.id); if (!bk) throw err('Booking not found', 404);
    const priced = lines.length ? priceLines(lines) : [];
    db.prepare('UPDATE bookings SET preorder = ? WHERE id = ?').run(lines.length ? JSON.stringify(lines) : null, bk.id);
    audit(null, 'booking.preorder', `#${bk.id}: ${priced.map((l) => `${l.qty} ${l.name}`).join(', ') || 'cleared'}`, clientIp(req)); notifyStaff('bookings');
    res.json({ ok: true, items: priced.map((l) => ({ name: l.name, qty: l.qty, cents: l.price_cents * l.qty })), subtotalCents: priced.reduce((a, l) => a + l.price_cents * l.qty, 0) });
  });
  h.preorderSummary = (bk) => { const lines = pj(bk.preorder, []); if (!lines.length) return null; try { return priceLines(lines).map((l) => `${l.qty} ${l.name}`).join(', '); } catch { return 'Pre-order (some dishes are no longer available)'; } };
  const prevCheckin = h.onBookingCheckin;
  h.onBookingCheckin = (bk, customer) => {
    prevCheckin?.(bk, customer);
    const lines = pj(bk.preorder, []); if (!lines.length) return;
    const fresh = db.prepare('SELECT guest_id FROM bookings WHERE id = ?').get(bk.id);
    try {
      const o = insertOrder({ lines: priceLines(lines), status: 'held', source: 'guest', guestId: fresh.guest_id, customerName: customer.name, notes: 'Booking pre-order' });
      db.prepare('UPDATE orders SET customer_id = ? WHERE id = ?').run(customer.id, o.id);
      audit(null, 'booking.preorder_held', `#${o.number} for ${customer.name}`, null); notifyStaff('orders');
    } catch (e) { audit(null, 'booking.preorder_failed', `${customer.name}: ${e.message}`, null); }
  };

  /* ===== "same again" on tabs and tables ===== */
  app.get('/api/t/:token/last-round', publicLimiter, (req, res) => {
    const t = /^[A-Za-z0-9_-]{16}$/.test(req.params.token) ? db.prepare('SELECT * FROM tables WHERE qr_token = ?').get(req.params.token) : null; if (!t) throw err('Not found', 404);
    const tab = req.query.tab ? db.prepare('SELECT * FROM tabs WHERE token = ?').get(String(req.query.tab)) : null;
    const member = typeof req.query.member === 'string' ? req.query.member.slice(0, 30) : null;
    const o = tab ? db.prepare(`SELECT * FROM orders WHERE tab_id = ? AND status <> 'void' ${member ? 'AND tab_member = ?' : ''} ORDER BY id DESC LIMIT 1`).get(...[tab.id, ...(member ? [member] : [])])
      : db.prepare("SELECT * FROM orders WHERE table_id = ? AND source = 'table' AND status <> 'void' AND created_at > datetime('now','-6 hours') ORDER BY id DESC LIMIT 1").get(t.id);
    if (!o) return res.json({ items: [] });
    const items = db.prepare('SELECT item_id, name, qty, mods, price_cents FROM order_items WHERE order_id = ? AND item_id IS NOT NULL AND price_cents > 0').all(o.id)
      .map((i) => ({ itemId: i.item_id, name: i.name, qty: i.qty, mods: pj(i.mods || '[]', []).map((m) => m.id).filter(Boolean), modNames: pj(i.mods || '[]', []).map((m) => m.name).filter(Boolean), unitCents: i.price_cents, cents: i.price_cents * i.qty }));
    res.json({ number: o.number, items });
  });

  /* ===== gift cards and member perks on a table check ===== */
  const billOrders = (bill) => db.prepare("SELECT o.* FROM orders o JOIN bill_orders bo ON bo.order_id = o.id WHERE bo.bill_id = ? AND o.paid_at IS NULL AND o.status <> 'void'").all(bill.id);
  staff.post('/bills/:id/gift', (req, res) => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(req.params.id)); if (!bill || bill.status !== 'open') throw err('This check is already settled', 409);
    const { code } = parse(z.object({ code: z.string().trim().max(30) }), req.body);
    let used = 0; let balance = null;
    for (const o of billOrders(bill)) {
      const r = h.applyGift ? h.applyGift(o, code, req.user) : null; if (!r) break;
      used += r.used; balance = r.balance; if (r.balance <= 0) break;
    }
    if (!used) throw err('Nothing was taken off: check the code and balance', 409);
    audit(req.user, 'gift.redeem', `check ${bill.id}: $${(used / 100).toFixed(2)}`, clientIp(req)); notifyStaff('orders');
    res.json({ ok: true, usedCents: used, cardBalanceCents: balance });
  });
  staff.post('/bills/:id/member', (req, res) => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(req.params.id)); if (!bill || bill.status !== 'open') throw err('This check is already settled', 409);
    const { customerId } = parse(z.object({ customerId: z.number().int() }), req.body);
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId); if (!c) throw err('Customer not found', 404);
    let off = 0; let plan = null;
    for (const o of billOrders(bill)) {
      if (o.customer_id && o.customer_id !== c.id) continue;
      const sub = o.subtotal_cents; const d = h.memberDiscount ? h.memberDiscount(c.id, sub) : null;
      db.prepare('UPDATE orders SET customer_id = ? WHERE id = ?').run(c.id, o.id);
      if (!d || d.cents <= o.discount_cents) continue;
      const extra = d.cents - o.discount_cents; plan = d.plan || d.tier || plan;
      const tax = Math.round(((sub - d.cents) * Number(getSettings().tax_rate)) / 100);
      db.prepare('UPDATE orders SET discount_cents = ?, tax_cents = ?, total_cents = ? WHERE id = ?').run(d.cents, tax, sub - d.cents + tax + (o.fee_cents || 0), o.id);
      off += extra;
    }
    audit(req.user, 'member.perk', `check ${bill.id}: ${c.name} ${off ? `$${(off / 100).toFixed(2)} off` : 'no perk'}`, clientIp(req)); notifyStaff('orders');
    res.json({ ok: true, offCents: off, plan, name: c.name });
  });

  staff.get('/customer-find', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 40); if (q.length < 3) return res.json([]);
    const digits = q.replace(/\D/g, '');
    const rows = db.prepare(`SELECT id, name, phone FROM customers WHERE name LIKE ? ${digits.length >= 4 ? 'OR phone LIKE ?' : ''} ORDER BY visits DESC LIMIT 8`).all(...[`%${q}%`, ...(digits.length >= 4 ? [`%${digits}%`] : [])]);
    res.json(rows.map((c) => { const d = h.memberDiscount ? h.memberDiscount(c.id, 10000) : null; return { id: c.id, name: c.name, phoneEnd: c.phone ? String(c.phone).slice(-4) : null, plan: d ? `${d.plan || 'Member'} ${d.pct}%` : null }; }));
  });

  /* ===== server checkout ===== */
  const checkout = (userId, date) => {
    const { start, end } = dayBounds(date); const u = db.prepare('SELECT id, name, tip_role FROM users WHERE id = ?').get(userId);
    const shifts = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND clock_in < ? AND COALESCE(clock_out, datetime(\'now\')) > ? ORDER BY clock_in').all(userId, end, start);
    const sales = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents - discount_cents),0) net, COALESCE(SUM(tax_cents),0) tax, COALESCE(SUM(tip_cents),0) tips FROM orders WHERE created_by = ? AND paid_at >= ? AND paid_at < ? AND status <> 'void'").get(userId, start, end);
    const cashOrders = db.prepare("SELECT COALESCE(SUM(total_cents),0) c, COALESCE(SUM(tip_cents),0) t FROM orders WHERE created_by = ? AND paid_at >= ? AND paid_at < ? AND status <> 'void' AND payment_method = 'cash' AND id NOT IN (SELECT order_id FROM bill_orders)").get(userId, start, end);
    const cashBills = db.prepare("SELECT COALESCE(SUM(amount_cents + tip_cents),0) c, COALESCE(SUM(tip_cents),0) t FROM payments WHERE user_id = ? AND method = 'cash' AND status = 'paid' AND paid_at >= ? AND paid_at < ?").get(userId, start, end);
    const cardTips = sales.tips - cashOrders.t - cashBills.t;
    const declared = shifts.reduce((a, s) => a + (s.declared_tips_cents || 0), 0);
    const tipouts = shifts.map((s) => shiftTipout(userId, s)).filter(Boolean);
    const tipoutLines = {}; for (const t of tipouts) for (const l of t.lines) tipoutLines[l.to] = (tipoutLines[l.to] || 0) + l.cents;
    const tipoutCents = Object.values(tipoutLines).reduce((a, b) => a + b, 0);
    const cashCollected = cashOrders.c + cashBills.c;
    const hours = shifts.reduce((a, s) => a + Math.max(0, (Date.parse(`${(s.clock_out || new Date().toISOString().slice(0, 19).replace('T', ' ')).replace(' ', 'T')}Z`) - Date.parse(`${s.clock_in.replace(' ', 'T')}Z`)) / 3600000 - (s.break_minutes || 0) / 60), 0);
    return { date, user: u, hours: Math.round(hours * 100) / 100, stillOn: shifts.some((s) => !s.clock_out), checks: sales.n, salesCents: sales.net, taxCents: sales.tax,
      cashCollectedCents: cashCollected, cardTipsCents: Math.max(0, cardTips), cashTipsCents: cashOrders.t + cashBills.t, declaredTipsCents: declared,
      tipouts: Object.entries(tipoutLines).map(([to, cents]) => ({ to, cents })), tipoutCents,
      dueToHouseCents: cashCollected - (cashOrders.t + cashBills.t) - Math.max(0, cardTips), takeHomeTipsCents: Math.max(0, cardTips) + cashOrders.t + cashBills.t + declared - tipoutCents };
  };
  h.serverCheckout = checkout;
  staff.get('/me/checkout', (req, res) => res.json(checkout(req.user.id, /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : localToday())));
  staff.get('/checkouts', mgr, (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : localToday(); const { start, end } = dayBounds(date);
    const ids = db.prepare("SELECT DISTINCT user_id FROM shifts WHERE clock_in < ? AND COALESCE(clock_out, datetime('now')) > ?").all(end, start).map((r) => r.user_id);
    res.json({ date, people: ids.map((id) => checkout(id, date)).filter((c) => c.checks || c.hours) });
  });
}
