// Round 9: menu schedules, kitchen stations, gift card bonuses, punch cards, scheduled orders,
// live labor percent, reservation timeline, waste tracker, grab-and-go labels.
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, currentTz, forEachLocation } from './db.js';
import { menuHooks, insertOrder } from './commerce.js';
import { pushToUsers, emailEnabled, emailGuest } from './notify.js';
import { dayBounds } from './ops.js';
import { customerFromReq } from './security.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS menu_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]', start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  item_ids TEXT NOT NULL DEFAULT '[]', categories TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS gift_promos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, min_cents INTEGER NOT NULL, bonus_cents INTEGER NOT NULL, starts TEXT NOT NULL, ends TEXT NOT NULL,
  bonus_from TEXT, bonus_until TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS punch_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, uses INTEGER NOT NULL, price_cents INTEGER NOT NULL, item_ids TEXT NOT NULL DEFAULT '[]', categories TEXT NOT NULL DEFAULT '[]',
  valid_days INTEGER NOT NULL DEFAULT 365, online INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS punch_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, uses_left INTEGER NOT NULL, expires_on TEXT NOT NULL,
  payment_id INTEGER, order_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS punch_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, order_id INTEGER NOT NULL, item_name TEXT NOT NULL, cents INTEGER NOT NULL, user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS waste_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, ingredient_id INTEGER, name TEXT NOT NULL, qty REAL NOT NULL, unit TEXT, reason TEXT NOT NULL,
  cost_cents INTEGER NOT NULL, note TEXT, user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('orders').includes('scheduled_for')) db.exec('ALTER TABLE orders ADD COLUMN scheduled_for TEXT; ALTER TABLE orders ADD COLUMN sched_pay TEXT;');
  if (!cols('order_items').includes('done_at')) db.exec('ALTER TABLE order_items ADD COLUMN done_at TEXT');
  if (!cols('gift_cards').includes('valid_from')) db.exec('ALTER TABLE gift_cards ADD COLUMN valid_from TEXT; ALTER TABLE gift_cards ADD COLUMN valid_until TEXT;');
  if (!cols('bookings').includes('table_id')) db.exec('ALTER TABLE bookings ADD COLUMN table_id INTEGER; ALTER TABLE bookings ADD COLUMN duration_minutes INTEGER;');
  if (!cols('menu_items').includes('shelf_days')) db.exec('ALTER TABLE menu_items ADD COLUMN shelf_days INTEGER');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const parseJ = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };
const parts = (offsetMin = 0) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: currentTz(), year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date(Date.now() + offsetMin * 60000)).map((x) => [x.type, x.value]));
export const localStamp = (offsetMin = 0) => { const p = parts(offsetMin); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };
const localNowDH = () => { const p = parts(); return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hm: `${p.hour}:${p.minute}` }; };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const REASONS = ['expired', 'dropped', 'overcooked', 'returned', 'over-prepped', 'other'];

/* ---------- menu schedules ---------- */
function inWindow(r, now) {
  const days = parseJ(r.days, []); const st = r.start_time; const en = r.end_time;
  if (en > st) return days.includes(now.dow) && now.hm >= st && now.hm < en;
  return (days.includes(now.dow) && now.hm >= st) || (days.includes((now.dow + 6) % 7) && now.hm < en);
}
const covers = (r, i) => parseJ(r.item_ids, []).includes(i.id) || parseJ(r.categories, []).includes(i.category);
export function scheduleState() {
  const now = localNowDH(); const all = db.prepare('SELECT * FROM menu_schedules WHERE active = 1').all();
  return { all, live: all.filter((r) => inWindow(r, now)) };
}
menuHooks.adjust.push((items) => {
  const { all, live } = scheduleState();
  if (!all.length) return items;
  return items.filter((i) => { const mine = all.filter((r) => covers(r, i)); return !mine.length || mine.some((r) => live.includes(r)); });
});

/* ---------- punch cards ---------- */
const planCovers = (p, item) => parseJ(p.item_ids, []).includes(item.item_id) || (item.category && parseJ(p.categories, []).includes(item.category));
export function customerPunches(customerId) {
  return db.prepare("SELECT c.*, p.name, p.uses, p.item_ids, p.categories FROM punch_cards c JOIN punch_plans p ON p.id = c.plan_id WHERE c.customer_id = ? AND c.uses_left > 0 AND c.expires_on >= ? ORDER BY c.expires_on").all(customerId, localToday())
    .map((c) => ({ id: c.id, name: c.name, usesLeft: c.uses_left, uses: c.uses, expiresOn: c.expires_on }));
}
function issuePunch(customerId, planId, { paymentId = null, orderId = null } = {}) {
  const p = db.prepare('SELECT * FROM punch_plans WHERE id = ?').get(planId); if (!p) throw err('Plan not found', 404);
  return db.prepare('INSERT INTO punch_cards (customer_id, plan_id, uses_left, expires_on, payment_id, order_id) VALUES (?,?,?,?,?,?)').run(customerId, p.id, p.uses, addDays(localToday(), p.valid_days), paymentId, orderId).lastInsertRowid;
}

/* ---------- labor ---------- */
export function laborNow() {
  const s = getSettings(); const { start, end } = dayBounds(localToday());
  const nowSql = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const shifts = db.prepare('SELECT s.*, u.name, u.role, u.hourly_cents FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in < ? AND (s.clock_out IS NULL OR s.clock_out >= ?)').all(end, start);
  const hrs = (a, b) => Math.max(0, (Date.parse(`${b.replace(' ', 'T')}Z`) - Date.parse(`${a.replace(' ', 'T')}Z`)) / 3600000);
  const people = shifts.map((x) => { const h = Math.max(0, hrs(x.clock_in < start ? start : x.clock_in, x.clock_out || nowSql) - (x.break_minutes || 0) / 60); return { userId: x.user_id, name: x.name, role: x.role, on: !x.clock_out, hours: Math.round(h * 10) / 10, cents: Math.round(h * x.hourly_cents), rate: x.hourly_cents }; });
  const laborCents = people.reduce((a, p) => a + p.cents, 0);
  const sales = db.prepare("SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) c FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void'").get(start, end).c;
  const target = Number(s.labor_target_pct || 25);
  const pct = sales ? Math.round((laborCents / sales) * 1000) / 10 : null;
  const onNow = people.filter((p) => p.on);
  // suggest sending home the longest-on hourly staff while keeping at least the minimum crew
  const minCrew = Math.max(1, Number(s.staff_min || 1));
  const canGo = pct !== null && pct > target && onNow.length > minCrew ? onNow.filter((p) => p.role === 'staff' && p.rate > 0).sort((a, b) => b.hours - a.hours || b.rate - a.rate).slice(0, onNow.length - minCrew) : [];
  const perHour = onNow.reduce((a, p) => a + p.rate, 0);
  return { salesCents: sales, laborCents, pct, targetPct: target, onNow: onNow.length, burnPerHourCents: perHour, people, suggestHome: canGo.slice(0, 2).map((p) => ({ name: p.name, hours: p.hours, savesPerHourCents: p.rate })) };
}

/* ---------- waste cost ---------- */
function itemCost(itemId) {
  const c = db.prepare('SELECT SUM(r.qty * g.cost_cents) c FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ?').get(itemId).c;
  if (c) return c;
  const m = db.prepare('SELECT price_cents FROM menu_items WHERE id = ?').get(itemId);
  return m ? m.price_cents * (Number(getSettings().food_cost_target) || 30) / 100 : 0;
}

export function registerMore({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, publicLimiter, notifyStaff, publicBase } = h;
  const mgr = requireAuth('manager');
  const s0 = () => getSettings();

  /* ===== menu schedules ===== */
  const schedSchema = z.object({ name: z.string().trim().min(1).max(40), days: z.array(z.number().int().min(0).max(6)).min(1), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/),
    itemIds: z.array(z.number().int()).max(300).default([]), categories: z.array(z.string().max(24)).max(40).default([]), active: z.boolean().optional() });
  staff.get('/menu-schedules', mgr, (req, res) => { const st = scheduleState(); res.json({ schedules: db.prepare('SELECT * FROM menu_schedules ORDER BY start_time').all().map((r) => ({ ...r, days: parseJ(r.days, []), item_ids: parseJ(r.item_ids, []), categories: parseJ(r.categories, []), live: st.live.some((x) => x.id === r.id) })) }); });
  const saveSched = (b, id) => {
    if (!b.itemIds.length && !b.categories.length) throw err('Pick the items or categories on this menu');
    if (b.start === b.end) throw err('Start and end times must be different');
    const args = [b.name, JSON.stringify(b.days), b.start, b.end, JSON.stringify(b.itemIds), JSON.stringify(b.categories)];
    if (id) db.prepare('UPDATE menu_schedules SET name=?, days=?, start_time=?, end_time=?, item_ids=?, categories=?, active=COALESCE(?, active) WHERE id=?').run(...args, b.active === undefined ? null : b.active ? 1 : 0, id);
    else db.prepare('INSERT INTO menu_schedules (name, days, start_time, end_time, item_ids, categories) VALUES (?,?,?,?,?,?)').run(...args);
  };
  staff.post('/menu-schedules', mgr, (req, res) => { const b = parse(schedSchema, req.body); saveSched(b); audit(req.user, 'menu.schedule', b.name, clientIp(req)); notifyStaff('menu'); res.json({ ok: true }); });
  staff.put('/menu-schedules/:id', mgr, (req, res) => { const b = parse(schedSchema, req.body); saveSched(b, idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });
  staff.delete('/menu-schedules/:id', mgr, (req, res) => { db.prepare('DELETE FROM menu_schedules WHERE id = ?').run(idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });

  /* ===== kitchen stations ===== */
  staff.post('/kitchen/:id/station', (req, res) => {
    const b = parse(z.object({ itemIds: z.array(z.number().int()).min(1).max(100), undo: z.boolean().optional() }), req.body);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req)); if (!o) throw err('Not found', 404);
    const q = db.prepare(`UPDATE order_items SET done_at = ${b.undo ? 'NULL' : "datetime('now')"} WHERE order_id = ? AND id = ?`);
    for (const id of b.itemIds) q.run(o.id, id);
    const left = db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND done_at IS NULL AND (course = 1 OR fired_at IS NOT NULL)').get(o.id).c;
    const held = db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND fired_at IS NULL AND course > 1').get(o.id).c;
    notifyStaff('orders'); res.json({ allDone: left === 0 && held === 0 });
  });

  /* ===== gift card bonuses ===== */
  h.giftBonus = ({ cents, name, email, userId }) => {
    const today = localToday();
    const p = db.prepare('SELECT * FROM gift_promos WHERE active = 1 AND starts <= ? AND ends >= ? AND min_cents <= ? ORDER BY bonus_cents DESC LIMIT 1').get(today, today, cents);
    if (!p) return null;
    const times = Math.max(1, Math.floor(cents / p.min_cents));
    const bonusCents = p.bonus_cents * times;
    const card = h.issueCard({ cents: bonusCents, name: `Bonus: ${name || 'guest'}`, email, source: 'bonus', userId, method: 'comp' });
    db.prepare('UPDATE gift_cards SET valid_from = ?, valid_until = ? WHERE id = ?').run(p.bonus_from || null, p.bonus_until || null, card.id);
    if (email && emailEnabled()) { const s = s0(); emailGuest(email, { businessName: s.business_name, subject: 'Your bonus card', message: `Thanks for buying a gift card! Here's your $${(bonusCents / 100).toFixed(2)} bonus card. Code: ${card.code}.${p.bonus_from ? ` Good from ${p.bonus_from}` : ''}${p.bonus_until ? ` until ${p.bonus_until}` : ''}.`, accent: s.accent }).catch(() => {}); }
    audit(null, 'gift.bonus', `${p.name}: $${(bonusCents / 100).toFixed(2)} …${card.code.slice(-4)}`, null);
    return { code: card.code, cents: bonusCents, validFrom: p.bonus_from, validUntil: p.bonus_until, promo: p.name };
  };
  h.giftUsable = (c) => {
    const today = localToday();
    if (c.valid_from && today < c.valid_from) throw err(`This bonus card can be used from ${c.valid_from}`, 409);
    if (c.valid_until && today > c.valid_until) throw err(`This bonus card expired on ${c.valid_until}`, 409);
  };
  const gpSchema = z.object({ name: z.string().trim().min(1).max(60), minCents: z.number().int().min(100).max(100000), bonusCents: z.number().int().min(100).max(100000),
    starts: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ends: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bonusFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), bonusUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), active: z.boolean().optional() });
  staff.get('/gift-promos', mgr, (req, res) => res.json(db.prepare('SELECT * FROM gift_promos ORDER BY ends DESC').all().map((p) => ({ ...p, issued: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(initial_cents),0) c FROM gift_cards WHERE source = 'bonus' AND created_at BETWEEN ? AND ?").get(`${p.starts} 00:00`, `${p.ends} 23:59`) }))));
  staff.post('/gift-promos', mgr, (req, res) => { const b = parse(gpSchema, req.body); if (b.ends < b.starts) throw err('The end date is before the start'); db.prepare('INSERT INTO gift_promos (name, min_cents, bonus_cents, starts, ends, bonus_from, bonus_until) VALUES (?,?,?,?,?,?,?)').run(b.name, b.minCents, b.bonusCents, b.starts, b.ends, b.bonusFrom || null, b.bonusUntil || null); audit(req.user, 'gift.promo', b.name, clientIp(req)); res.json({ ok: true }); });
  staff.put('/gift-promos/:id', mgr, (req, res) => { const b = parse(gpSchema, req.body); db.prepare('UPDATE gift_promos SET name=?, min_cents=?, bonus_cents=?, starts=?, ends=?, bonus_from=?, bonus_until=?, active=COALESCE(?, active) WHERE id=?').run(b.name, b.minCents, b.bonusCents, b.starts, b.ends, b.bonusFrom || null, b.bonusUntil || null, b.active === undefined ? null : b.active ? 1 : 0, idParam(req)); res.json({ ok: true }); });
  app.get('/api/public/gift-promo', publicLimiter, (req, res) => { const t = localToday(); const p = db.prepare('SELECT name, min_cents, bonus_cents, ends, bonus_from, bonus_until FROM gift_promos WHERE active = 1 AND starts <= ? AND ends >= ? ORDER BY bonus_cents DESC LIMIT 1').get(t, t); res.json(p || null); });

  /* ===== punch cards ===== */
  const planSchema = z.object({ name: z.string().trim().min(1).max(40), uses: z.number().int().min(2).max(100), priceCents: z.number().int().min(100).max(1000000), itemIds: z.array(z.number().int()).max(100).default([]), categories: z.array(z.string().max(24)).max(20).default([]), validDays: z.number().int().min(7).max(1095).default(365), online: z.boolean().default(true), active: z.boolean().optional() });
  staff.get('/punch-plans', (req, res) => res.json(db.prepare('SELECT * FROM punch_plans ORDER BY active DESC, id').all().map((p) => ({ ...p, item_ids: parseJ(p.item_ids, []), categories: parseJ(p.categories, []), sold: db.prepare('SELECT COUNT(*) n FROM punch_cards WHERE plan_id = ?').get(p.id).n, outstanding: db.prepare('SELECT COALESCE(SUM(uses_left),0) n FROM punch_cards WHERE plan_id = ? AND expires_on >= ?').get(p.id, localToday()).n }))));
  const savePlan = (b, id) => { if (!b.itemIds.length && !b.categories.length) throw err('Pick the items this card can be used for');
    const args = [b.name, b.uses, b.priceCents, JSON.stringify(b.itemIds), JSON.stringify(b.categories), b.validDays, b.online ? 1 : 0];
    if (id) db.prepare('UPDATE punch_plans SET name=?, uses=?, price_cents=?, item_ids=?, categories=?, valid_days=?, online=?, active=COALESCE(?, active) WHERE id=?').run(...args, b.active === undefined ? null : b.active ? 1 : 0, id);
    else db.prepare('INSERT INTO punch_plans (name, uses, price_cents, item_ids, categories, valid_days, online) VALUES (?,?,?,?,?,?,?)').run(...args); };
  staff.post('/punch-plans', mgr, (req, res) => { const b = parse(planSchema, req.body); savePlan(b); audit(req.user, 'punch.plan', b.name, clientIp(req)); notifyStaff('punch'); res.json({ ok: true }); });
  staff.put('/punch-plans/:id', mgr, (req, res) => { const b = parse(planSchema, req.body); savePlan(b, idParam(req)); notifyStaff('punch'); res.json({ ok: true }); });
  staff.get('/customers/:id/punches', (req, res) => res.json(customerPunches(idParam(req))));
  staff.post('/punch-cards', (req, res) => {
    const b = parse(z.object({ customerId: z.number().int(), planId: z.number().int(), method: z.enum(['cash', 'card', 'other']) }), req.body);
    const p = db.prepare('SELECT * FROM punch_plans WHERE id = ? AND active = 1').get(b.planId); if (!p) throw err('Plan not found', 404);
    const c = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(b.customerId); if (!c) throw err('Customer not found', 404);
    const o = insertOrder({ lines: [{ item_id: null, name: `${p.name} (${p.uses} uses)`, qty: 1, price_cents: p.price_cents, note: null, mods: [] }], status: 'paid', source: 'staff', customerName: c.name, createdBy: req.user.id });
    const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare("UPDATE orders SET paid_at = ?, payment_method = ?, customer_id = ?, prepaid = 1 WHERE id = ?").run(t, b.method, c.id, o.id);
    const id = issuePunch(c.id, p.id, { orderId: o.id });
    audit(req.user, 'punch.sell', `${p.name} to ${c.name} (${b.method})`, clientIp(req)); notifyStaff('orders'); notifyStaff('punch');
    res.json({ ok: true, cardId: id, number: o.number });
  });
  staff.post('/orders/:id/punch', (req, res) => {
    const b = parse(z.object({ cardId: z.number().int() }), req.body);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req));
    if (!o || ['paid', 'void'].includes(o.status) || o.prepaid) throw err('This order is already closed', 409);
    const r = db.transaction(() => {
      const c = db.prepare('SELECT c.*, p.name, p.item_ids, p.categories FROM punch_cards c JOIN punch_plans p ON p.id = c.plan_id WHERE c.id = ?').get(b.cardId);
      if (!c || c.uses_left <= 0) throw err('That card has no uses left', 409);
      if (c.expires_on < localToday()) throw err(`That card expired on ${c.expires_on}`, 409);
      const used = db.prepare('SELECT COUNT(*) n FROM punch_uses WHERE order_id = ?').get(o.id).n;
      const lines = db.prepare('SELECT oi.*, m.category FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id = ? ORDER BY oi.price_cents DESC').all(o.id);
      const units = lines.flatMap((l) => Array.from({ length: l.qty }, () => l)).filter((l) => planCovers(c, l));
      const pick = units[used];
      if (!pick) throw err(`Nothing on this order can use the ${c.name}`, 409);
      const disc = o.discount_cents + pick.price_cents;
      const tax = Math.round((o.subtotal_cents - Math.min(disc, o.subtotal_cents)) * Number(s0().tax_rate) / 100);
      db.prepare('UPDATE orders SET discount_cents = ?, tax_cents = ?, total_cents = ? WHERE id = ?').run(Math.min(disc, o.subtotal_cents), tax, o.subtotal_cents - Math.min(disc, o.subtotal_cents) + tax + (o.fee_cents || 0), o.id);
      db.prepare('UPDATE punch_cards SET uses_left = uses_left - 1 WHERE id = ?').run(c.id);
      db.prepare('INSERT INTO punch_uses (card_id, order_id, item_name, cents, user_id) VALUES (?,?,?,?,?)').run(c.id, o.id, pick.name, pick.price_cents, req.user.id);
      return { item: pick.name, cents: pick.price_cents, usesLeft: c.uses_left - 1 };
    })();
    const after = db.prepare('SELECT subtotal_cents, discount_cents, tax_cents FROM orders WHERE id = ?').get(o.id);
    audit(req.user, 'punch.use', `#${o.number} ${r.item}`, clientIp(req)); notifyStaff('orders');
    res.json({ ...r, discountCents: after.discount_cents, taxCents: after.tax_cents });
  });
  // customers: see and buy punch cards
  app.get('/api/c/punches', publicLimiter, (req, res) => {
    const c = customerFromReq(req);
    const plans = db.prepare('SELECT id, name, uses, price_cents, valid_days FROM punch_plans WHERE active = 1 AND online = 1 ORDER BY price_cents').all();
    res.json({ cards: c ? customerPunches(c.id) : [], plans, canBuy: Boolean(h.onlinePayEnabled?.()) });
  });
  app.post('/api/c/punch-plans/:id/buy', publicLimiter, wrap(async (req, res) => {
    const c = customerFromReq(req); if (!c) throw err('Sign in first', 401);
    const p = db.prepare('SELECT * FROM punch_plans WHERE id = ? AND active = 1 AND online = 1').get(idParam(req)); if (!p) throw err('Not available', 404);
    if (!h.onlinePayEnabled?.()) throw err('Online payment is not set up. Buy it in person.', 503);
    const pid = db.prepare("INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('punch', ?, 'card', ?, ?)").run(p.price_cents, p.name, JSON.stringify({ customerId: c.id, planId: p.id })).lastInsertRowid;
    const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `?l=${currentSlug()}`;
    res.json({ url: h.startPay(pid, { base, lines: [{ name: `${p.name} (${p.uses} uses)`, cents: p.price_cents }], successUrl: `${base}/account${l}`, cancelUrl: `${base}/account${l}`, email: c.email, descr: p.name }) });
  }));
  h.payHooks = h.payHooks || {};
  h.payHooks.punch = (pay) => { const m = parseJ(pay.meta, {}); if (db.prepare('SELECT 1 FROM punch_cards WHERE payment_id = ?').get(pay.id)) return; issuePunch(m.customerId, m.planId, { paymentId: pay.id }); audit(null, 'punch.online', `plan ${m.planId} customer ${m.customerId}`, null); notifyStaff('punch'); };

  /* ===== scheduled orders ===== */
  h.checkSchedule = (when) => {
    const s = s0(); if (s.online_schedule !== '1') throw err('Ordering ahead for later is not available');
    if (when < localStamp(Number(s.online_prep_minutes || 15))) throw err('Pick a later time');
    if (when.slice(0, 10) > addDays(localToday(), Number(s.online_schedule_days || 7))) throw err(`You can order up to ${s.online_schedule_days || 7} days ahead`);
  };
  staff.get('/scheduled-orders', (req, res) => res.json(db.prepare("SELECT o.id, o.number, o.customer_name, o.scheduled_for, o.fulfillment, o.prepaid, o.sched_pay, o.total_cents FROM orders o WHERE o.status = 'held' AND o.scheduled_for IS NOT NULL ORDER BY o.scheduled_for").all()));

  /* ===== live labor ===== */
  staff.get('/labor-now', mgr, (req, res) => res.json(laborNow()));

  /* ===== reservation timeline ===== */
  staff.get('/timeline', (req, res) => {
    const s = s0(); const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : localToday();
    const tables = db.prepare('SELECT id, label, seats, zone FROM tables ORDER BY zone, id').all();
    const bookings = db.prepare("SELECT b.id, b.start_local, b.party_size, b.status, b.table_id, b.notes, b.service_name, COALESCE(b.duration_minutes, ?) duration, c.name, c.phone FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE substr(b.start_local,1,10) = ? AND b.status NOT IN ('cancelled') ORDER BY b.start_local").all(Number(s.booking_duration_minutes || 90), day);
    res.json({ day, open: s.booking_open || '09:00', close: s.booking_close || '22:00', step: Number(s.booking_slot_minutes || 30), tables, bookings });
  });
  staff.put('/bookings/:id/place', (req, res) => {
    const b = parse(z.object({ tableId: z.number().int().nullable(), startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), duration: z.number().int().min(15).max(600).optional(), force: z.boolean().optional() }), req.body);
    const bk = db.prepare('SELECT * FROM bookings WHERE id = ?').get(idParam(req)); if (!bk) throw err('Not found', 404);
    const dur = b.duration || bk.duration_minutes || Number(s0().booking_duration_minutes || 90);
    if (b.tableId && !b.force) {
      const toMin = (x) => Date.parse(`${x.replace(' ', 'T')}:00Z`) / 60000;
      const a0 = toMin(b.startLocal); const a1 = a0 + dur;
      const clash = db.prepare("SELECT b.id, b.start_local, COALESCE(b.duration_minutes, ?) d, c.name FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.table_id = ? AND b.id <> ? AND substr(b.start_local,1,10) = ? AND b.status IN ('booked','checked_in')").all(Number(s0().booking_duration_minutes || 90), b.tableId, bk.id, b.startLocal.slice(0, 10))
        .find((x) => { const s1 = toMin(x.start_local); return s1 < a1 && s1 + x.d > a0; });
      if (clash) throw Object.assign(err(`That table is booked for ${clash.name} at ${clash.start_local.slice(11)}`, 409), { clash: true });
      const t = db.prepare('SELECT seats, label FROM tables WHERE id = ?').get(b.tableId);
      if (t && t.seats < bk.party_size && !b.force) throw Object.assign(err(`Table ${t.label} seats ${t.seats}, the party is ${bk.party_size}`, 409), { clash: true });
    }
    db.prepare('UPDATE bookings SET table_id = ?, start_local = ?, duration_minutes = ? WHERE id = ?').run(b.tableId, b.startLocal, dur, bk.id);
    audit(req.user, 'booking.place', `#${bk.id} ${b.startLocal} table ${b.tableId ?? '-'}`, clientIp(req)); notifyStaff('bookings'); res.json({ ok: true });
  });

  /* ===== waste tracker ===== */
  staff.post('/waste', (req, res) => {
    const b = parse(z.object({ itemId: z.number().int().optional(), ingredientId: z.number().int().optional(), qty: z.number().positive().max(10000), reason: z.enum(REASONS), note: z.string().trim().max(120).optional() }), req.body);
    if (!b.itemId === !b.ingredientId) throw err('Pick a menu item or an ingredient');
    let name; let unit = null; let cost;
    if (b.itemId) {
      const m = db.prepare('SELECT id, name, stock FROM menu_items WHERE id = ?').get(b.itemId); if (!m) throw err('Item not found', 404);
      name = m.name; cost = Math.round(itemCost(m.id) * b.qty);
      if (m.stock !== null) { db.prepare('UPDATE menu_items SET stock = MAX(0, stock - ?) WHERE id = ?').run(Math.round(b.qty), m.id); db.prepare('INSERT INTO stock_moves (item_id, delta, reason, user_id) VALUES (?, ?, ?, ?)').run(m.id, -Math.round(b.qty), `waste: ${b.reason}`, req.user.id); }
      for (const r of db.prepare('SELECT ingredient_id, qty FROM item_recipes WHERE item_id = ?').all(m.id)) {
        const g = db.prepare('SELECT stock FROM ingredients WHERE id = ?').get(r.ingredient_id);
        if (g?.stock !== null && g?.stock !== undefined) { db.prepare('UPDATE ingredients SET stock = stock - ? WHERE id = ?').run(r.qty * b.qty, r.ingredient_id); db.prepare('INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?, ?, ?, ?)').run(r.ingredient_id, -r.qty * b.qty, 'waste', req.user.id); }
      }
    } else {
      const g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(b.ingredientId); if (!g) throw err('Ingredient not found', 404);
      name = g.name; unit = g.unit; cost = Math.round(g.cost_cents * b.qty);
      if (g.stock !== null) { db.prepare('UPDATE ingredients SET stock = stock - ? WHERE id = ?').run(b.qty, g.id); db.prepare('INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?, ?, ?, ?)').run(g.id, -b.qty, 'waste', req.user.id); }
    }
    db.prepare('INSERT INTO waste_log (item_id, ingredient_id, name, qty, unit, reason, cost_cents, note, user_id) VALUES (?,?,?,?,?,?,?,?,?)').run(b.itemId || null, b.ingredientId || null, name, b.qty, unit, b.reason, cost, b.note || null, req.user.id);
    audit(req.user, 'waste.log', `${b.qty} ${name} (${b.reason})`, clientIp(req)); notifyStaff('waste'); notifyStaff('menu');
    res.json({ ok: true, costCents: cost });
  });
  staff.get('/waste/options', (req, res) => res.json({ items: db.prepare('SELECT id, name, category FROM menu_items ORDER BY category, name').all(), ingredients: db.prepare('SELECT id, name, unit FROM ingredients WHERE active = 1 ORDER BY name').all(), reasons: REASONS }));
  staff.get('/waste', (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 7));
    const since = dayBounds(addDays(localToday(), -(days - 1))).start;
    const rows = db.prepare('SELECT w.*, u.name by_name FROM waste_log w LEFT JOIN users u ON u.id = w.user_id WHERE w.at >= ? ORDER BY w.id DESC').all(since);
    const sum = (k) => Object.values(rows.reduce((a, r) => { const key = r[k]; a[key] = a[key] || { key, cents: 0, qty: 0, n: 0 }; a[key].cents += r.cost_cents; a[key].qty += r.qty; a[key].n += 1; return a; }, {})).sort((a, b) => b.cents - a.cents);
    const { start } = dayBounds(addDays(localToday(), -(days - 1)));
    const sales = db.prepare("SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) c FROM orders WHERE paid_at >= ? AND status <> 'void'").get(start).c;
    const total = rows.reduce((a, r) => a + r.cost_cents, 0);
    res.json({ days, totalCents: total, pctOfSales: sales ? Math.round(total / sales * 1000) / 10 : null, byReason: sum('reason'), top: sum('name').slice(0, 8), rows: rows.slice(0, 100), reasons: REASONS });
  });

  /* ===== labels ===== */
  staff.put('/menu/:id/shelf', mgr, (req, res) => { const b = parse(z.object({ days: z.number().int().min(0).max(365).nullable() }), req.body); db.prepare('UPDATE menu_items SET shelf_days = ? WHERE id = ?').run(b.days, idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });

  /* ===== jobs: start scheduled orders, labor alert ===== */
  setInterval(() => forEachLocation(async () => {
    const s = s0(); const startAt = localStamp(Number(s.online_prep_minutes || 15));
    const due = db.prepare("SELECT id, number, customer_name FROM orders WHERE status = 'held' AND scheduled_for IS NOT NULL AND scheduled_for <= ? AND (prepaid = 1 OR sched_pay = 'later')").all(startAt);
    for (const o of due) {
      db.prepare("UPDATE orders SET status = 'sent', sent_at = datetime('now') WHERE id = ? AND status = 'held'").run(o.id);
      io.to('staff').emit('online:new', { number: o.number, name: o.customer_name || 'Scheduled order', fulfillment: 'scheduled' });
    }
    if (due.length) notifyStaff('orders');
    // abandoned unpaid scheduled orders (pay now, never paid) are voided after 2 hours
    db.prepare("UPDATE orders SET status = 'void' WHERE status = 'held' AND scheduled_for IS NOT NULL AND sched_pay = 'now' AND prepaid = 0 AND created_at < datetime('now','-2 hours')").run();
    if (s.labor_alerts === '1') {
      const l = laborNow();
      if (l.pct !== null && l.salesCents > 20000 && l.pct > l.targetPct + 5 && l.suggestHome.length) {
        const key = `labor:${localToday()}:${new Date().getUTCHours()}`;
        if (db.prepare('INSERT OR IGNORE INTO plus_alerts (key) VALUES (?)').run(key).changes) await pushToUsers(['manager', 'owner'], { title: `${s.business_name}: labor at ${l.pct}%`, body: `Target is ${l.targetPct}%. Consider sending ${l.suggestHome.map((p) => p.name.split(' ')[0]).join(' or ')} home.`, tag: 'labor', url: '/' }).catch(() => {});
      }
    }
  }), 60_000).unref();
}
