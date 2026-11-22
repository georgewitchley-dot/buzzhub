// Round 4 commerce: menu options (modifiers), inventory, gift cards, promo codes, bills with split payments,
// Stripe Checkout for bills and gift cards, online ordering (pickup/delivery) and table QR ordering.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, runIn, currentSlug, locationExists } from './db.js';
import { pushToGuest, pushToUsers, emailEnabled, emailGuest } from './notify.js';

registerSchema((db) => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const add = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add('menu_items', 'stock', 'INTEGER');            // NULL = not tracked
  add('menu_items', 'low_stock', 'INTEGER NOT NULL DEFAULT 5');
  add('order_items', 'mods', 'TEXT');               // JSON [{name, price_cents}]
  for (const [c, d] of [['fee_cents', 'INTEGER NOT NULL DEFAULT 0'], ['gift_cents', 'INTEGER NOT NULL DEFAULT 0'], ['promo_code', 'TEXT'],
    ['fulfillment', "TEXT NOT NULL DEFAULT 'dine_in'"], ['delivery_address', 'TEXT'], ['contact_phone', 'TEXT'], ['contact_email', 'TEXT'],
    ['client_key', 'TEXT'], ['prepaid', 'INTEGER NOT NULL DEFAULT 0'], ['order_notes', 'TEXT']]) add('orders', c, d);
  add('tables', 'qr_token', 'TEXT');
  db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_key ON orders(client_key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_qr ON tables(qr_token);
  CREATE TABLE IF NOT EXISTS mod_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, min_pick INTEGER NOT NULL DEFAULT 0, max_pick INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS mod_options (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL REFERENCES mod_groups(id) ON DELETE CASCADE, name TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS item_mod_groups (item_id INTEGER NOT NULL, group_id INTEGER NOT NULL, PRIMARY KEY (item_id, group_id));
  CREATE TABLE IF NOT EXISTS stock_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, delta INTEGER NOT NULL, reason TEXT, user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS gift_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, initial_cents INTEGER NOT NULL, balance_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')), name TEXT, email TEXT, source TEXT NOT NULL DEFAULT 'staff',
    created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS gift_txns (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, delta_cents INTEGER NOT NULL, order_id INTEGER, method TEXT, user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS bills (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, table_id INTEGER, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT);
  CREATE TABLE IF NOT EXISTS bill_orders (bill_id INTEGER NOT NULL, order_id INTEGER NOT NULL, PRIMARY KEY (bill_id, order_id));
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'bill', bill_id INTEGER, amount_cents INTEGER NOT NULL, tip_cents INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', label TEXT, items TEXT, meta TEXT, stripe_session TEXT, user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id);
  `);
});

/* ======================================================================
   Stripe (REST, no SDK)
   ====================================================================== */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
export const stripeEnabled = () => /^sk_(live|test)_/.test(STRIPE_KEY);
export const stripeStatus = () => ({ cardsEnabled: stripeEnabled(), webhook: Boolean(WEBHOOK_SECRET), mode: STRIPE_KEY.startsWith('sk_live_') ? 'live' : STRIPE_KEY ? 'test' : null });
export async function stripe(method, path, form) {
  let r;
  try {
    r = await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { Authorization: `Bearer ${STRIPE_KEY}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), 'Stripe-Version': '2024-06-20' }, body: form ? new URLSearchParams(form) : undefined });
  } catch { const e = new Error("Couldn't reach the card processor. Please try again or pay your server."); e.status = 502; throw e; }
  const data = await r.json();
  if (!r.ok) { const e = new Error(data.error?.message || 'Card payments are not available right now'); e.status = 502; throw e; }
  return data;
}

/* ======================================================================
   Order builder (used by register, order-ahead, online and table orders)
   ====================================================================== */
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const lineSchema = z.object({
  itemId: z.number().int().optional(), comboId: z.number().int().optional(),
  picks: z.array(z.object({ itemId: z.number().int(), mods: z.array(z.number().int()).max(20).optional() })).max(8).optional(),
  qty: z.number().int().min(1).max(99), note: z.string().trim().max(80).optional(), mods: z.array(z.number().int()).max(20).optional(), course: z.number().int().min(1).max(3).optional(), seat: z.number().int().min(1).max(40).optional(),
}).refine((l) => l.itemId !== undefined || (l.comboId !== undefined && l.picks?.length), { message: 'Each line needs an item or a combo' });

export function menuWithMods({ where = 'active = 1' } = {}) {
  const items = db.prepare(`SELECT id, name, category, price_cents, color, active, guest_orderable, stock, low_stock, description, allergens, diet, i18n FROM menu_items WHERE ${where} ORDER BY sort, id`).all()
    .map((i) => { const j = (v, d) => { try { return JSON.parse(v || ''); } catch { return d; } }; return { ...i, allergens: j(i.allergens, []), diet: j(i.diet, []), i18n: j(i.i18n, {}) }; });
  const groups = db.prepare('SELECT * FROM mod_groups ORDER BY sort, id').all();
  const opts = db.prepare('SELECT * FROM mod_options ORDER BY sort, id').all();
  const links = db.prepare('SELECT * FROM item_mod_groups').all();
  const g = Object.fromEntries(groups.map((x) => [x.id, { id: x.id, name: x.name, min: x.min_pick, max: x.max_pick, options: opts.filter((o) => o.group_id === x.id).map((o) => ({ id: o.id, name: o.name, price_cents: o.price_cents })) }]));
  let out = items.map((i) => ({ ...i, soldOut: i.stock !== null && i.stock <= 0, groups: links.filter((l) => l.item_id === i.id).map((l) => g[l.group_id]).filter(Boolean) }));
  for (const f of menuHooks.adjust) out = f(out);
  return out;
}
/** Other modules adjust prices and visibility (specials, happy hour) and expand combos. */
export const menuHooks = { adjust: [], combo: null };

/** Validate lines against the menu (prices, options, stock). Prices always come from the server. */
export function priceLines(lines, { guestOnly = false } = {}) {
  const menu = new Map(menuWithMods({ where: guestOnly ? 'active = 1 AND guest_orderable = 1' : 'active = 1' }).map((m) => [m.id, m]));
  const need = {};
  const pickMods = (m, ids) => {
    const picked = new Set(ids || []);
    const mods = [];
    for (const g of m.groups) {
      const chosen = g.options.filter((o) => picked.has(o.id));
      if (chosen.length < g.min) throw err(`Choose ${g.min === 1 ? 'an option' : `${g.min} options`} for ${g.name} on ${m.name}`);
      if (chosen.length > g.max) throw err(`Choose at most ${g.max} for ${g.name} on ${m.name}`);
      for (const o of chosen) { mods.push({ id: o.id, name: o.name, price_cents: o.price_cents }); picked.delete(o.id); }
    }
    if (picked.size) throw err(`An option on ${m.name} is no longer available`);
    return mods;
  };
  const out = lines.flatMap((l) => {
    const course = l.course || 1;
    if (l.comboId !== undefined) {
      if (!menuHooks.combo) throw err('Combos are not available');
      const parts = menuHooks.combo(l, menu, pickMods);
      for (const p of parts) need[p.item_id] = (need[p.item_id] || 0) + p.qty;
      return parts.map((p) => ({ ...p, course, seat: l.seat || null }));
    }
    const m = menu.get(l.itemId);
    if (!m) throw err('An item is no longer available');
    const mods = pickMods(m, l.mods);
    need[m.id] = (need[m.id] || 0) + l.qty;
    return [{ item_id: m.id, name: m.name, qty: l.qty, price_cents: m.price_cents + mods.reduce((a, o) => a + o.price_cents, 0), note: l.note || null, mods, course, seat: l.seat || null }];
  });
  for (const [id, q] of Object.entries(need)) {
    const m = menu.get(Number(id));
    if (m.stock !== null && m.stock < q) throw err(m.stock <= 0 ? `${m.name} is sold out` : `Only ${m.stock} ${m.name} left`);
  }
  return out;
}

let onStockEvent = () => {};
function takeStock(lines, userId, reason) {
  const up = db.prepare('UPDATE menu_items SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL');
  const log = db.prepare('INSERT INTO stock_moves (item_id, delta, reason, user_id) VALUES (?, ?, ?, ?)');
  const touched = new Set();
  for (const l of lines) { const r = up.run(l.qty, l.item_id); if (r.changes) { log.run(l.item_id, -l.qty, reason, userId || null); touched.add(l.item_id); } }
  for (const id of touched) {
    const m = db.prepare('SELECT id, name, stock, low_stock, active FROM menu_items WHERE id = ?').get(id);
    if (m.stock <= 0 && m.active) { db.prepare('UPDATE menu_items SET active = 0 WHERE id = ?').run(id); onStockEvent('out', m); }
    else if (m.stock > 0 && m.stock <= m.low_stock) onStockEvent('low', m);
  }
}
/** Other modules (recipes) listen for sales and voids. */
export const orderHooks = { inserted: [], voided: [] };
export function returnStock(orderId, userId) {
  for (const f of orderHooks.voided) { try { f(orderId, userId); } catch (e) { console.error('void hook', e.message); } }
  const lines = db.prepare('SELECT item_id, qty FROM order_items WHERE order_id = ?').all(orderId);
  for (const l of lines) {
    const r = db.prepare('UPDATE menu_items SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').run(l.qty, l.item_id);
    if (r.changes) db.prepare('INSERT INTO stock_moves (item_id, delta, reason, user_id) VALUES (?, ?, ?, ?)').run(l.item_id, l.qty, `order ${orderId} voided`, userId || null);
  }
}

export const dueOf = (o) => o.subtotal_cents - o.discount_cents + o.tax_cents + (o.fee_cents || 0) - (o.gift_cents || 0);

/** Insert an order with its lines; returns { id, number }. Call inside a transaction-safe context. */
export function insertOrder({ lines, status = 'sent', source = 'staff', tableId = null, guestId = null, customerName = null, createdBy = null,
  discountCents = 0, feeCents = 0, promoCode = null, fulfillment = 'dine_in', address = null, phone = null, email = null, notes = null, clientKey = null }) {
  const s = getSettings();
  return db.transaction(() => {
    if (clientKey) { const dup = db.prepare('SELECT id, number FROM orders WHERE client_key = ?').get(clientKey); if (dup) return { ...dup, duplicate: true }; }
    const subtotal = lines.reduce((a, l) => a + l.qty * l.price_cents, 0);
    const discount = Math.min(discountCents, subtotal);
    const tax = Math.round((subtotal - discount) * Number(s.tax_rate) / 100);
    const number = (db.prepare('SELECT MAX(number) n FROM orders WHERE localdate(created_at) = localtoday()').get().n || 100) + 1;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const id = db.prepare(`INSERT INTO orders (number, status, table_id, guest_id, customer_name, subtotal_cents, tax_cents, discount_cents, fee_cents, total_cents, created_by, sent_at, source,
        promo_code, fulfillment, delivery_address, contact_phone, contact_email, order_notes, client_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(number, status, tableId, guestId, customerName, subtotal, tax, discount, feeCents, subtotal - discount + tax + feeCents, createdBy, status === 'sent' ? now : null, source,
        promoCode, fulfillment, address, phone, email, notes, clientKey).lastInsertRowid;
    const ins = db.prepare('INSERT INTO order_items (order_id, item_id, name, qty, price_cents, note, mods, course, fired_at, seat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const l of lines) ins.run(id, l.item_id, l.name, l.qty, l.price_cents, l.note, l.mods?.length ? JSON.stringify(l.mods) : null, l.course || 1, (l.course || 1) > 1 ? null : now, l.seat || null);
    takeStock(lines, createdBy, `order #${number}`);
    for (const f of orderHooks.inserted) f(id, lines, createdBy);
    return { id, number };
  })();
}

export function registerCommerce({ app, staff, io, h }) {
  const { wrap, parse, idParam, now, clientIp, requireAuth, notifyStaff, publicLimiter, publicBase, createGuest, pushGuest, buzzGuest, alertOwners } = h;
  const ACTIVE = ['waiting', 'buzzed', 'acknowledged'];
  onStockEvent = (kind, m) => {
    const s = getSettings();
    io.to('staff').emit('security', { type: 'stock', detail: kind === 'out' ? `${m.name} just sold out and was turned off` : `${m.name} is running low: ${m.stock} left` });
    pushToUsers(['owner', 'manager'], { title: `${s.business_name}: ${kind === 'out' ? 'sold out' : 'low stock'}`, body: kind === 'out' ? `${m.name} sold out and was taken off the menu.` : `${m.name}: only ${m.stock} left.`, tag: `stock-${m.id}`, url: '/inventory' }).catch(() => {});
    notifyStaff('menu');
  };

  /* ================= Menu options (modifiers) ================= */
  staff.get('/mods', (req, res) => {
    const groups = db.prepare('SELECT * FROM mod_groups ORDER BY sort, id').all();
    const opts = db.prepare('SELECT * FROM mod_options ORDER BY sort, id').all();
    const links = db.prepare('SELECT * FROM item_mod_groups').all();
    res.json(groups.map((g) => ({ ...g, options: opts.filter((o) => o.group_id === g.id), itemIds: links.filter((l) => l.group_id === g.id).map((l) => l.item_id) })));
  });
  const groupSchema = z.object({
    name: z.string().trim().min(1).max(40), min_pick: z.number().int().min(0).max(10), max_pick: z.number().int().min(1).max(20),
    options: z.array(z.object({ name: z.string().trim().min(1).max(40), price_cents: z.number().int().min(-100000).max(100000) })).min(1).max(30),
    itemIds: z.array(z.number().int()).max(500),
  }).refine((g) => g.min_pick <= g.max_pick && g.min_pick <= g.options.length, 'The minimum must be no more than the maximum and the number of options');
  function saveGroup(id, g) {
    db.transaction(() => {
      if (id) db.prepare('UPDATE mod_groups SET name=?, min_pick=?, max_pick=? WHERE id=?').run(g.name, g.min_pick, g.max_pick, id);
      else id = db.prepare('INSERT INTO mod_groups (name, min_pick, max_pick) VALUES (?, ?, ?)').run(g.name, g.min_pick, g.max_pick).lastInsertRowid;
      db.prepare('DELETE FROM mod_options WHERE group_id = ?').run(id);
      g.options.forEach((o, i) => db.prepare('INSERT INTO mod_options (group_id, name, price_cents, sort) VALUES (?, ?, ?, ?)').run(id, o.name, o.price_cents, i));
      db.prepare('DELETE FROM item_mod_groups WHERE group_id = ?').run(id);
      for (const it of g.itemIds) db.prepare('INSERT OR IGNORE INTO item_mod_groups (item_id, group_id) VALUES (?, ?)').run(it, id);
    })();
    return id;
  }
  staff.post('/mods', requireAuth('manager'), (req, res) => { const g = parse(groupSchema, req.body); const id = saveGroup(null, g); audit(req.user, 'menu.options_add', g.name, clientIp(req)); notifyStaff('menu'); res.json({ id }); });
  staff.put('/mods/:id', requireAuth('manager'), (req, res) => { const g = parse(groupSchema, req.body); saveGroup(idParam(req), g); audit(req.user, 'menu.options_edit', g.name, clientIp(req)); notifyStaff('menu'); res.json({ ok: true }); });
  staff.delete('/mods/:id', requireAuth('manager'), (req, res) => { const id = idParam(req); db.prepare('DELETE FROM item_mod_groups WHERE group_id=?').run(id); db.prepare('DELETE FROM mod_groups WHERE id=?').run(id); notifyStaff('menu'); res.json({ ok: true }); });
  staff.get('/menu/full', (req, res) => res.json(menuWithMods({ where: '1=1' })));

  /* ================= Inventory ================= */
  staff.get('/inventory', (req, res) => {
    const items = db.prepare('SELECT id, name, category, stock, low_stock, active FROM menu_items ORDER BY category, sort, id').all();
    const sold7 = Object.fromEntries(db.prepare("SELECT oi.item_id, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status <> 'void' AND o.created_at > datetime('now','-7 days') GROUP BY oi.item_id").all().map((r) => [r.item_id, r.q]));
    const moves = db.prepare('SELECT m.*, i.name item, u.name user FROM stock_moves m JOIN menu_items i ON i.id = m.item_id LEFT JOIN users u ON u.id = m.user_id ORDER BY m.id DESC LIMIT 60').all();
    res.json({ items: items.map((i) => ({ ...i, sold7: sold7[i.id] || 0, daysLeft: i.stock !== null && sold7[i.id] ? Math.floor(i.stock / (sold7[i.id] / 7)) : null })), moves });
  });
  staff.post('/inventory/:id', requireAuth('manager'), (req, res) => {
    const id = idParam(req);
    const b = parse(z.object({ mode: z.enum(['set', 'add', 'untrack']), qty: z.number().int().min(-100000).max(100000).optional(), lowStock: z.number().int().min(0).max(100000).optional(), reason: z.string().trim().max(60).optional() }), req.body);
    const m = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id); if (!m) return res.status(404).json({ error: 'Not found' });
    let stock = m.stock;
    if (b.mode === 'untrack') stock = null;
    else if (b.mode === 'set') stock = b.qty ?? 0;
    else stock = (m.stock ?? 0) + (b.qty ?? 0);
    db.prepare('UPDATE menu_items SET stock = ?, low_stock = COALESCE(?, low_stock), active = CASE WHEN ? > 0 AND stock IS NOT NULL AND stock <= 0 THEN 1 ELSE active END WHERE id = ?').run(stock, b.lowStock ?? null, stock ?? 0, id);
    if (stock !== null && stock > 0 && m.stock !== null && m.stock <= 0) db.prepare('UPDATE menu_items SET active = 1 WHERE id = ?').run(id);
    if (b.mode !== 'untrack') db.prepare('INSERT INTO stock_moves (item_id, delta, reason, user_id) VALUES (?, ?, ?, ?)').run(id, (stock ?? 0) - (m.stock ?? 0), b.reason || (b.mode === 'set' ? 'count' : 'delivery'), req.user.id);
    audit(req.user, 'inventory.update', `${m.name}: ${m.stock ?? 'untracked'} → ${stock ?? 'untracked'}`, clientIp(req));
    notifyStaff('menu'); res.json({ ok: true, stock });
  });

  /* ================= Gift cards ================= */
  const newGiftCode = () => { let c; do { c = Array.from({ length: 4 }, () => crypto.randomBytes(2).readUInt16BE() % 10000).map((n) => String(n).padStart(4, '0')).join('-'); } while (db.prepare('SELECT 1 FROM gift_cards WHERE code = ?').get(c)); return c; };
  const normCode = (c) => String(c || '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1-');
  function issueCard({ cents, name, email, source, userId, method }) {
    const code = newGiftCode();
    const id = db.prepare('INSERT INTO gift_cards (code, initial_cents, balance_cents, name, email, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(code, cents, cents, name || null, email || null, source, userId || null).lastInsertRowid;
    db.prepare('INSERT INTO gift_txns (card_id, delta_cents, method, user_id) VALUES (?, ?, ?, ?)').run(id, cents, method, userId || null);
    return { id, code };
  }
  h.issueCard = issueCard;
  async function emailCard(card, cents) {
    const s = getSettings();
    if (!card.email || !emailEnabled()) return;
    await emailGuest(card.email, { businessName: s.business_name, subject: 'Your gift card', message: `Here's your ${s.business_name} gift card for $${(cents / 100).toFixed(2)}. Code: ${card.code}. Show this code when you pay.`, link: `${process.env.PUBLIC_URL || ''}/gift${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`, accent: s.accent }).catch(() => {});
  }

  staff.get('/giftcards', requireAuth('manager'), (req, res) => {
    const cards = db.prepare('SELECT * FROM gift_cards ORDER BY id DESC LIMIT 200').all();
    const out = db.prepare("SELECT COALESCE(SUM(balance_cents),0) c FROM gift_cards WHERE status = 'active'").get().c;
    res.json({ cards, outstandingCents: out });
  });
  staff.post('/giftcards', wrap(async (req, res) => {
    const b = parse(z.object({ amountCents: z.number().int().min(100).max(100000), method: z.enum(['cash', 'card', 'other', 'comp']), name: z.string().trim().max(40).optional(), email: z.string().trim().email().max(120).optional().or(z.literal('')) }), req.body);
    if (b.method === 'comp' && !['manager', 'owner'].includes(req.user.role)) return res.status(403).json({ error: 'Only a manager can give a free gift card' });
    const card = issueCard({ cents: b.amountCents, name: b.name, email: b.email, source: 'staff', userId: req.user.id, method: b.method });
    const bonus = b.method !== 'comp' ? h.giftBonus?.({ cents: b.amountCents, name: b.name, email: b.email, userId: req.user.id }) : null;
    if (b.method === 'cash') { const cs = db.prepare('SELECT id FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get(); if (cs) db.prepare("INSERT INTO cash_moves (session_id, kind, amount_cents, reason, user_id) VALUES (?, 'in', ?, ?, ?)").run(cs.id, b.amountCents, `Gift card ${card.code.slice(-4)}`, req.user.id); }
    await emailCard({ ...card, email: b.email }, b.amountCents);
    audit(req.user, 'gift.sell', `$${(b.amountCents / 100).toFixed(2)} ${b.method} …${card.code.slice(-4)}`, clientIp(req));
    notifyStaff('cash'); res.json({ ok: true, code: card.code, bonus });
  }));
  staff.get('/giftcards/check', (req, res) => {
    const c = db.prepare('SELECT code, balance_cents, initial_cents, status, name FROM gift_cards WHERE code = ?').get(normCode(req.query.code));
    if (!c) return res.status(404).json({ error: 'No gift card with that code' });
    res.json(c);
  });
  staff.post('/giftcards/:id/disable', requireAuth('manager'), (req, res) => {
    db.prepare("UPDATE gift_cards SET status = 'disabled' WHERE id = ?").run(idParam(req));
    audit(req.user, 'gift.disable', `#${req.params.id}`, clientIp(req)); res.json({ ok: true });
  });
  /** Apply a gift card to an order: takes up to the balance and up to what's still owed. */
  staff.post('/orders/:id/gift', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req));
    if (!o || ['paid', 'void'].includes(o.status) || o.prepaid) return res.status(409).json({ error: 'This order is already closed' });
    const { code } = parse(z.object({ code: z.string().max(30) }), req.body);
    const r = db.transaction(() => {
      const c = db.prepare("SELECT * FROM gift_cards WHERE code = ? AND status = 'active'").get(normCode(code));
      if (!c) throw err('That gift card code is not valid', 404);
      if (c.balance_cents <= 0) throw err('That gift card is empty', 409);
      h.giftUsable?.(c);
      const use = Math.min(c.balance_cents, dueOf(o));
      if (use <= 0) throw err('Nothing left to pay on this order', 409);
      db.prepare('UPDATE gift_cards SET balance_cents = balance_cents - ? WHERE id = ?').run(use, c.id);
      db.prepare('INSERT INTO gift_txns (card_id, delta_cents, order_id, method, user_id) VALUES (?, ?, ?, ?, ?)').run(c.id, -use, o.id, 'redeem', req.user.id);
      db.prepare('UPDATE orders SET gift_cents = gift_cents + ? WHERE id = ?').run(use, o.id);
      return { used: use, balance: c.balance_cents - use };
    })();
    const after = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    const remaining = dueOf(after);
    if (remaining <= 0) db.prepare("UPDATE orders SET status='paid', payment_method='gift', paid_at=?, total_cents=? WHERE id=?").run(now(), after.subtotal_cents - after.discount_cents + after.tax_cents + after.fee_cents, o.id);
    audit(req.user, 'gift.redeem', `#${o.number} $${(r.used / 100).toFixed(2)}`, clientIp(req));
    notifyStaff('orders'); res.json({ ok: true, usedCents: r.used, cardBalanceCents: r.balance, remainingCents: Math.max(0, remaining), paid: remaining <= 0 });
  });

  // public: buy online + check balance
  app.get('/api/public/gift', publicLimiter, (req, res) => {
    const s = getSettings();
    const out = { business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null, slug: currentSlug() }, cardsEnabled: h.onlinePayEnabled(), currency: s.currency };
    if (req.query.code) {
      const c = db.prepare('SELECT balance_cents, status FROM gift_cards WHERE code = ?').get(normCode(req.query.code));
      out.balance = c && c.status === 'active' ? c.balance_cents : null;
    }
    const tok = String(req.query.paid || '');
    if (/^[A-Za-z0-9_-]{20,30}$/.test(tok)) {
      const p = db.prepare("SELECT * FROM payments WHERE kind = 'giftcard' AND pay_token = ?").get(tok);
      if (p?.status === 'paid') out.purchased = JSON.parse(p.meta || '{}');
      else if (p?.claimed_at) out.awaiting = true;
    }
    res.json(out);
  });
  app.post('/api/public/gift/checkout', publicLimiter, wrap(async (req, res) => {
    if (!h.onlinePayEnabled()) return res.status(503).json({ error: 'Online gift cards are not available yet.' });
    const b = parse(z.object({ amountCents: z.number().int().min(1000).max(50000), name: z.string().trim().min(1).max(40), email: z.string().trim().email().max(120) }), req.body);
    const s = getSettings(); const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `l=${currentSlug()}&`;
    const pid = db.prepare("INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('giftcard', ?, 'card', ?, ?)").run(b.amountCents, `Gift card for ${b.name}`, JSON.stringify({ name: b.name, email: b.email })).lastInsertRowid;
    const url = h.startPay(pid, { base, lines: [{ name: `${s.business_name} gift card`, cents: b.amountCents }], successUrl: `${base}/gift?${l}paid={TOKEN}`, cancelUrl: `${base}/gift${l ? `?${l.slice(0, -1)}` : ''}`, email: b.email, descr: 'Gift card' });
    res.json({ url });
  }));

  /* ================= Bills and split payments ================= */
  const newToken = () => crypto.randomBytes(16).toString('base64url');
  function billOrders(bill) {
    // a table's bill always covers every unpaid order at that table
    if (bill.table_id && bill.status === 'open') {
      for (const o of db.prepare("SELECT id FROM orders WHERE table_id = ? AND status IN ('open','sent','ready','held') AND prepaid = 0").all(bill.table_id)) db.prepare('INSERT OR IGNORE INTO bill_orders (bill_id, order_id) VALUES (?, ?)').run(bill.id, o.id);
    }
    return db.prepare('SELECT o.* FROM orders o JOIN bill_orders bo ON bo.order_id = o.id WHERE bo.bill_id = ? AND o.status <> \'void\' ORDER BY o.id').all(bill.id);
  }
  function billSummary(bill) {
    const s = getSettings();
    const orders = billOrders(bill);
    const items = orders.length ? db.prepare(`SELECT id, order_id, name, qty, price_cents, mods FROM order_items WHERE order_id IN (${orders.map((o) => o.id).join(',')})`).all() : [];
    const due = orders.reduce((a, o) => a + dueOf(o), 0);
    const pays = db.prepare("SELECT * FROM payments WHERE bill_id = ? AND (status = 'paid' OR (status = 'pending' AND created_at > datetime('now','-30 minutes')))").all(bill.id);
    const paid = pays.filter((p) => p.status === 'paid');
    const paidCents = paid.reduce((a, p) => a + p.amount_cents, 0);
    const claimed = new Set(pays.flatMap((p) => JSON.parse(p.items || '[]')));
    const paidItems = new Set(paid.flatMap((p) => JSON.parse(p.items || '[]')));
    const sub = orders.reduce((a, o) => a + o.subtotal_cents, 0) || 1;
    const ratio = due / sub; // spreads tax, fees, discounts and gift cards across items
    const t = bill.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(bill.table_id) : null;
    return {
      token: bill.token, status: bill.status, table: t?.label || null, numbers: orders.map((o) => o.number), currency: s.currency,
      items: items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, mods: JSON.parse(i.mods || '[]'), lineCents: i.qty * i.price_cents, shareCents: Math.round(i.qty * i.price_cents * ratio), paid: paidItems.has(i.id), claimed: claimed.has(i.id) && !paidItems.has(i.id) })),
      subtotalCents: orders.reduce((a, o) => a + o.subtotal_cents, 0), discountCents: orders.reduce((a, o) => a + o.discount_cents, 0), taxCents: orders.reduce((a, o) => a + o.tax_cents, 0),
      feeCents: orders.reduce((a, o) => a + (o.fee_cents || 0), 0), giftCents: orders.reduce((a, o) => a + (o.gift_cents || 0), 0),
      dueCents: due, paidCents, remainingCents: Math.max(0, due - paidCents), tipCents: paid.reduce((a, p) => a + p.tip_cents, 0),
      payments: paid.map((p) => ({ label: p.label, method: p.method, amountCents: p.amount_cents, tipCents: p.tip_cents })),
      business: { name: s.business_name, accent: s.accent, unitLabel: s.unit_label, slug: currentSlug(), logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null },
      cardsEnabled: h.onlinePayEnabled ? h.onlinePayEnabled() : stripeEnabled(),
    };
  }
  /** When the bill is covered, close its orders (prepaid ones keep cooking until served/picked up). */
  function settleBill(bill) {
    const sum = billSummary(bill);
    if (sum.dueCents <= 0 || sum.paidCents < sum.dueCents || bill.status !== 'open') return false;
    const orders = billOrders(bill);
    const pays = db.prepare("SELECT * FROM payments WHERE bill_id = ? AND status = 'paid'").all(bill.id);
    const methods = [...new Set(pays.map((p) => p.method))];
    const method = methods.length === 1 ? methods[0] : 'split';
    const tips = pays.reduce((a, p) => a + p.tip_cents, 0);
    const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.transaction(() => {
      orders.forEach((o, i) => {
        const tip = i === 0 ? tips : 0;
        const total = o.subtotal_cents - o.discount_cents + o.tax_cents + (o.fee_cents || 0) + tip;
        if (['ready'].includes(o.status) || (o.status === 'open' && o.source === 'staff')) db.prepare("UPDATE orders SET status='paid', tip_cents=?, total_cents=?, payment_method=?, paid_at=? WHERE id=?").run(tip, total, method, t, o.id);
        else db.prepare("UPDATE orders SET status = CASE WHEN status = 'held' AND source = 'online' AND scheduled_for IS NULL THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, ?), prepaid=1, tip_cents=?, total_cents=?, payment_method=?, paid_at=? WHERE id=?").run(t, tip, total, method, t, o.id);
      });
      db.prepare("UPDATE bills SET status='paid', closed_at=? WHERE id=?").run(t, bill.id);
    })();
    for (const o of orders) if (o.guest_id) pushGuest(o.guest_id);
    io.to('staff').emit('paid:phone', { number: orders.map((o) => o.number).join(', #'), totalCents: sum.dueCents + tips });
    notifyStaff('orders'); notifyStaff('tables');
    return true;
  }
  h.settleBill = settleBill;
  h.billSummary = billSummary;
  function billFor({ orderId, tableId }) {
    if (tableId) {
      let b = db.prepare("SELECT * FROM bills WHERE table_id = ? AND status = 'open' ORDER BY id DESC").get(tableId);
      if (!b) { db.prepare('INSERT INTO bills (token, table_id) VALUES (?, ?)').run(newToken(), tableId); b = db.prepare("SELECT * FROM bills WHERE table_id = ? AND status = 'open' ORDER BY id DESC").get(tableId); }
      return b;
    }
    let b = db.prepare("SELECT b.* FROM bills b JOIN bill_orders bo ON bo.bill_id = b.id WHERE bo.order_id = ? AND b.status = 'open' AND b.table_id IS NULL").get(orderId);
    if (!b) { const id = db.prepare('INSERT INTO bills (token) VALUES (?)').run(newToken()).lastInsertRowid; db.prepare('INSERT INTO bill_orders (bill_id, order_id) VALUES (?, ?)').run(id, orderId); b = db.prepare('SELECT * FROM bills WHERE id = ?').get(id); }
    return b;
  }
  h.billFor = billFor;

  /** How much a share is: whole remainder, an even split, or the chosen items. */
  function shareAmount(sum, b) {
    if (b.split === 'even') return Math.min(sum.remainingCents, Math.ceil(sum.dueCents / b.ways));
    if (b.split === 'items') {
      const pick = sum.items.filter((i) => b.itemIds.includes(i.id) && !i.paid && !i.claimed);
      if (pick.length !== b.itemIds.length) throw err('Someone already paid for one of those items. Refresh and choose again.', 409);
      return Math.min(sum.remainingCents, pick.reduce((a, i) => a + i.shareCents, 0));
    }
    return sum.remainingCents;
  }
  h.shareAmount = (sum, b) => shareAmount(sum, b);
  const shareSchema = z.object({ split: z.enum(['full', 'even', 'items']).default('full'), ways: z.number().int().min(2).max(20).optional(), itemIds: z.array(z.number().int()).max(200).optional(), tipCents: z.number().int().min(0).max(1_000_000).default(0) })
    .refine((b) => b.split !== 'even' || b.ways, 'Pick how many ways to split').refine((b) => b.split !== 'items' || (b.itemIds && b.itemIds.length), 'Pick your items');
  h.shareSchema = shareSchema;

  // staff: open a bill for an order or a table, then record payments against it (cash/card/other)
  staff.post('/bills', (req, res) => {
    const b = parse(z.object({ orderId: z.number().int().optional(), tableId: z.number().int().optional() }), req.body);
    if (!b.orderId && !b.tableId) return res.status(400).json({ error: 'Choose an order or a table' });
    const bill = billFor(b);
    const link = `${publicBase(req)}/p/${bill.token}`;
    res.json({ id: bill.id, link, ...billSummary(bill) });
  });
  staff.get('/bills/:id/qr', wrap(async (req, res) => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(idParam(req)); if (!bill) return res.status(404).json({ error: 'Not found' });
    const link = `${publicBase(req)}/p/${bill.token}`;
    res.json({ link, svg: await QRCode.toString(link, { type: 'svg', margin: 1 }), ...billSummary(bill) });
  }));
  staff.post('/bills/:id/payments', (req, res) => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(idParam(req));
    if (!bill || bill.status !== 'open') return res.status(409).json({ error: 'This check is already settled' });
    const b = parse(shareSchema.and(z.object({ method: z.enum(['cash', 'card', 'other']), label: z.string().trim().max(30).optional() })), req.body);
    const sum = billSummary(bill);
    if (sum.remainingCents <= 0) return res.status(409).json({ error: 'Nothing left to pay' });
    const amount = shareAmount(sum, b);
    db.prepare("INSERT INTO payments (bill_id, amount_cents, tip_cents, method, status, label, items, user_id, paid_at) VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?)")
      .run(bill.id, amount, b.tipCents, b.method, b.label || (b.split === 'even' ? `1 of ${b.ways}` : b.split === 'items' ? 'Own items' : 'Payment'), JSON.stringify(b.itemIds || []), req.user.id, now());
    audit(req.user, 'bill.payment', `check ${sum.numbers.map((n) => `#${n}`).join(' ')} ${b.method} ${(amount / 100).toFixed(2)}${b.tipCents ? ` + tip ${(b.tipCents / 100).toFixed(2)}` : ''}`, clientIp(req));
    settleBill(bill);
    notifyStaff('orders');
    res.json(billSummary(db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id)));
  });

  // phone: see the check and pay a share through Stripe
  const billByToken = (t) => (/^[A-Za-z0-9_-]{20,30}$/.test(t || '') ? db.prepare('SELECT * FROM bills WHERE token = ?').get(t) : null);
  async function confirmSession(sid) {
    if (!stripeEnabled() || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sid)) return;
    const p = db.prepare('SELECT * FROM payments WHERE stripe_session = ?').get(sid);
    if (!p || p.status === 'paid') return;
    const sess = await stripe('GET', `/checkout/sessions/${sid}`).catch(() => null);
    if (sess?.payment_status === 'paid' && String(sess.metadata?.payment_id) === String(p.id)) completePayment(p, sess.id);
  }
  function completePayment(p, sessionId) {
    const r = db.prepare("UPDATE payments SET status='paid', paid_at=?, stripe_session=? WHERE id=? AND status <> 'paid'").run(now(), sessionId, p.id);
    if (!r.changes) return;
    if (p.kind === 'deposit') { h.onDepositPaid?.(p, sessionId); return; }
    if (h.payHooks?.[p.kind]) { h.payHooks[p.kind](db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id)); return; }
    if (p.kind === 'giftcard') {
      const meta = JSON.parse(p.meta || '{}');
      const card = issueCard({ cents: p.amount_cents, name: meta.name, email: meta.email, source: 'online', method: 'card' });
      db.prepare('UPDATE payments SET meta = ? WHERE id = ?').run(JSON.stringify({ ...meta, code: card.code, amountCents: p.amount_cents }), p.id);
      audit(null, 'gift.online', `$${(p.amount_cents / 100).toFixed(2)} for ${meta.name}`, null);
      emailCard({ ...card, email: meta.email }, p.amount_cents);
      h.giftBonus?.({ cents: p.amount_cents, name: meta.name, email: meta.email });
      return;
    }
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(p.bill_id);
    audit(null, 'bill.payment', `phone ${p.label || ''} ${(p.amount_cents / 100).toFixed(2)}${p.tip_cents ? ` + tip ${(p.tip_cents / 100).toFixed(2)}` : ''}`, null);
    if (bill) settleBill(bill);
    notifyStaff('orders');
  }
  h.completePayment = completePayment;

  app.get('/api/p/:token', publicLimiter, wrap(async (req, res) => {
    const bill = billByToken(req.params.token);
    if (!bill) return res.status(404).json({ error: 'This check link is not valid.' });
    await confirmSession(String(req.query.session_id || ''));
    res.json(billSummary(db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id)));
  }));
  app.post('/api/p/:token/checkout', publicLimiter, wrap(async (req, res) => {
    const bill = billByToken(req.params.token);
    if (!bill) return res.status(404).json({ error: 'This check link is not valid.' });
    if (bill.status !== 'open') return res.status(409).json({ error: 'This check is already paid. Thank you!' });
    if (!h.onlinePayEnabled()) return res.status(503).json({ error: 'Paying by phone is not set up yet. Please pay your server.' });
    const b = parse(shareSchema, req.body);
    const sum = billSummary(bill);
    if (sum.remainingCents <= 0) return res.status(409).json({ error: 'This check is already paid. Thank you!' });
    const amount = shareAmount(sum, b);
    if (b.tipCents > Math.max(amount, 2000) * 2) return res.status(400).json({ error: 'That tip looks too high' });
    const label = b.split === 'even' ? `1 of ${b.ways}` : b.split === 'items' ? 'Own items' : 'Full check';
    const pid = db.prepare("INSERT INTO payments (bill_id, amount_cents, tip_cents, method, label, items) VALUES (?, ?, ?, 'card', ?, ?)").run(bill.id, amount, b.tipCents, label, JSON.stringify(b.itemIds || [])).lastInsertRowid;
    const s = getSettings(); const base = publicBase(req);
    const name = `${s.business_name}, ${sum.table ? `${s.unit_label.toLowerCase()} ${sum.table}` : `order #${sum.numbers.join(', #')}`}${b.split !== 'full' ? ` (${label})` : ''}`;
    const url = h.startPay(pid, { base, lines: [{ name, cents: amount }, ...(b.tipCents > 0 ? [{ name: 'Tip', cents: b.tipCents }] : [])], successUrl: `${base}/p/${bill.token}?paid=1`, cancelUrl: `${base}/p/${bill.token}`, descr: sum.table ? `${s.unit_label} ${sum.table}` : `order #${sum.numbers.join(', #')}` });
    res.json({ url });
  }));

  // staff: "let them pay by phone" for one order (creates the bill and its QR)
  staff.post('/orders/:id/paylink', wrap(async (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req));
    if (!o || ['paid', 'void'].includes(o.status)) return res.status(409).json({ error: 'This order is already closed' });
    const bill = o.table_id && req.body?.wholeTable ? billFor({ tableId: o.table_id }) : billFor({ orderId: o.id });
    const link = `${publicBase(req)}/p/${bill.token}`;
    let pushed = 0;
    if (req.body?.notify && o.guest_id) pushed = (await pushToGuest(o.guest_id, { title: `${getSettings().business_name}: your check`, body: `Your check is ready. Tap to pay from your phone, split it if you like.`, tag: 'check', url: `/p/${bill.token}` }).catch(() => ({ sent: 0 }))).sent;
    audit(req.user, 'order.paylink', `#${o.number}${pushed ? ' sent to guest phone' : ''}`, clientIp(req));
    res.json({ link, svg: await QRCode.toString(link, { type: 'svg', margin: 1 }), pushed, cardsEnabled: h.onlinePayEnabled(), billId: bill.id });
  }));

  // Stripe webhook: completes bill and gift card payments even if the guest closes the page
  h.stripeWebhook = (req, res) => {
    if (!WEBHOOK_SECRET) return res.status(404).end();
    const sig = String(req.get('stripe-signature') || '');
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')));
    const payload = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${parts.t}.${payload}`).digest('hex');
    const ok = parts.v1 && parts.v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
    if (!ok || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return res.status(400).send('bad signature');
    let event; try { event = JSON.parse(payload); } catch { return res.status(400).end(); }
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object; const loc = pi.metadata?.loc || 'main';
      if (locationExists(loc)) runIn(loc, () => h.onIntentSucceeded?.(pi));
    }
    if (event.type === 'checkout.session.async_payment_succeeded' || event.type === 'checkout.session.async_payment_failed') {
      const sess = event.data.object; const loc = sess.metadata?.loc || 'main';
      if (locationExists(loc)) runIn(loc, () => {
        const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(sess.metadata?.payment_id)); if (!p) return;
        if (event.type.endsWith('succeeded')) { db.prepare("UPDATE payments SET bank_status = 'cleared', refund_ref = COALESCE(refund_ref, ?) WHERE id = ?").run(sess.payment_intent ? `stripe:${sess.payment_intent}` : null, p.id); completePayment(p, sess.id); }
        else h.bankFailed?.(p);
      });
    }
    if (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') {
      const sess = event.data.object; const loc = sess.metadata?.loc || 'main';
      if (locationExists(loc)) runIn(loc, () => {
        const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(sess.metadata?.payment_id));
        if (p) completePayment(p, sess.id);
      });
    }
    res.json({ received: true });
  };

  /* ================= Online ordering (pickup / delivery) ================= */
  function onlineInfo() {
    const s = getSettings();
    const load = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('sent','open')").get().c;
    return {
      enabled: s.online_enabled === '1' && h.rushState?.().level !== 'paused', paused: s.online_enabled === '1' && h.rushState?.().level === 'paused', busy: h.rushState?.().level === 'busy', pickup: s.online_pickup === '1', delivery: s.online_delivery === '1',
      deliveryFeeCents: Number(s.delivery_fee_cents), deliveryMinCents: Number(s.delivery_min_cents), deliveryArea: s.delivery_area,
      readyInMinutes: h.slotQuote ? h.slotQuote() : h.quoteMinutes ? h.quoteMinutes().minutes : Number(s.online_prep_minutes) + Math.min(30, load * 2), payOnline: h.onlinePayEnabled(), payAtPickup: s.online_pay_later === '1' || !h.onlinePayEnabled(),
      taxRate: Number(s.tax_rate), currency: s.currency, tableOrdering: s.table_ordering === '1', schedule: s.online_schedule === '1', scheduleDays: Number(s.online_schedule_days || 7), prepMinutes: Number(s.online_prep_minutes),
      business: { name: s.business_name, accent: s.accent, type: s.business_type, slug: currentSlug(), logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null },
    };
  }
  const cleanMenu = () => menuWithMods().map(({ stock, low_stock, guest_orderable, active, ...m }) => m);
  app.get('/api/o/menu', publicLimiter, (req, res) => res.json({ ...onlineInfo(), items: cleanMenu() }));

  const orderLimiter = h.orderLimiter;
  app.post('/api/o/checkout', orderLimiter, wrap(async (req, res) => {
    const info = onlineInfo();
    if (!info.enabled) return res.status(403).json({ error: info.paused ? 'The kitchen is very busy. Online orders are paused for a few minutes; please try again soon.' : 'Online ordering is closed right now.' });
    const b = parse(z.object({
      items: z.array(lineSchema).min(1).max(50), fulfillment: z.enum(['pickup', 'delivery']),
      name: z.string().trim().min(1).max(40), phone: z.string().trim().min(7).max(20).regex(/^[+\d\s()-]+$/, 'Phone looks wrong'),
      email: z.string().trim().email().max(120).optional().or(z.literal('')), address: z.string().trim().max(200).optional(), notes: z.string().trim().max(200).optional(),
      payNow: z.boolean(), tipCents: z.number().int().min(0).max(100000).default(0), promoCode: z.string().trim().max(30).optional(),
      scheduledFor: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/).optional(),
    }), req.body);
    if (b.scheduledFor) h.checkSchedule?.(b.scheduledFor);
    const slot = h.slotFor ? h.slotFor(b.scheduledFor) : null;
    if (b.fulfillment === 'delivery' && (!info.delivery || !b.address || b.address.length < 8)) return res.status(400).json({ error: info.delivery ? 'Enter a delivery address' : 'Delivery is not available' });
    if (b.fulfillment === 'pickup' && !info.pickup) return res.status(400).json({ error: 'Pickup is not available' });
    if (b.payNow && !info.payOnline) return res.status(400).json({ error: 'Paying online is not available' });
    if (!b.payNow && !info.payAtPickup) return res.status(400).json({ error: 'Please pay online to place your order' });
    const lines = priceLines(b.items);
    const subtotal = lines.reduce((a, l) => a + l.qty * l.price_cents, 0);
    const zone = b.fulfillment === 'delivery' && h.deliveryZone ? await h.deliveryZone(b.address) : null;
    if (zone?.error) return res.status(400).json({ error: zone.error });
    const deliveryMin = zone?.minCents ?? info.deliveryMinCents; const deliveryFee = zone?.feeCents ?? info.deliveryFeeCents;
    if (b.fulfillment === 'delivery' && subtotal < deliveryMin) return res.status(400).json({ error: `Delivery orders${zone?.zone ? ` to ${zone.zone}` : ''} need at least $${(deliveryMin / 100).toFixed(2)} of food` });
    const promo = b.promoCode && h.promoDiscount ? h.promoDiscount(b.promoCode, subtotal) : null;
    const g = createGuest({ kind: 'order', name: b.name, phone: b.phone, email: b.email, notifyEmail: Boolean(b.email), party_size: 1, source: 'online' });
    const o = insertOrder({ lines, status: b.payNow || b.scheduledFor ? 'held' : 'sent', source: 'online', guestId: g.id, customerName: b.name, fulfillment: b.fulfillment, address: b.fulfillment === 'delivery' ? b.address : null,
      phone: b.phone, email: b.email || null, notes: b.notes || null, feeCents: b.fulfillment === 'delivery' ? deliveryFee : 0, discountCents: promo?.cents || 0, promoCode: promo?.code || null });
    db.prepare('UPDATE guests SET order_id = ? WHERE id = ?').run(o.id, g.id);
    h.linkOrderCustomer?.(req, o.id);
    if (b.scheduledFor) db.prepare('UPDATE orders SET scheduled_for = ?, sched_pay = ? WHERE id = ?').run(b.scheduledFor, b.payNow ? 'now' : 'later', o.id);
    if (slot) db.prepare('UPDATE orders SET promised_at = ? WHERE id = ?').run(slot.promisedAt, o.id);
    const buzzer = `/b/${g.token}`;
    if (!b.payNow) {
      audit(null, 'online.order', `#${o.number} ${b.fulfillment} for ${b.name}, pay at ${b.fulfillment === 'pickup' ? 'pickup' : 'door'}`, clientIp(req));
      io.to('staff').emit('online:new', { number: o.number, name: b.name, fulfillment: b.fulfillment });
      notifyStaff('orders'); notifyStaff('guests');
      return res.json({ ok: true, number: o.number, buzzer });
    }
    const bill = billFor({ orderId: o.id });
    const sum = billSummary(bill);
    const pid = db.prepare("INSERT INTO payments (bill_id, amount_cents, tip_cents, method, label) VALUES (?, ?, ?, 'card', 'Online order')").run(bill.id, sum.remainingCents, b.tipCents).lastInsertRowid;
    const s = getSettings(); const base = publicBase(req);
    const url = h.startPay(pid, { base, lines: [{ name: `${s.business_name} order #${o.number} (${b.fulfillment})`, cents: sum.remainingCents }, ...(b.tipCents > 0 ? [{ name: 'Tip', cents: b.tipCents }] : [])], successUrl: `${base}${buzzer}?paid=1`, cancelUrl: `${base}/order${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`, email: b.email, descr: `order #${o.number}` });
    res.json({ ok: true, number: o.number, url });
  }));
  // the buzzer page confirms an online payment on return from Stripe
  app.get('/api/g/:token/confirm', publicLimiter, wrap(async (req, res) => {
    await confirmSession(String(req.query.session_id || ''));
    const g = db.prepare('SELECT order_id FROM guests WHERE token = ?').get(req.params.token);
    const o = g?.order_id ? db.prepare('SELECT status, prepaid FROM orders WHERE id = ?').get(g.order_id) : null;
    if (o && o.status !== 'held') { io.to('staff').emit('online:new', { number: '', name: 'Online order', fulfillment: 'paid' }); notifyStaff('orders'); }
    res.json({ paid: Boolean(o?.prepaid) });
  }));

  /* ================= Table QR ordering ================= */
  staff.get('/tables/:id/qr', wrap(async (req, res) => {
    const t = db.prepare('SELECT * FROM tables WHERE id = ?').get(idParam(req)); if (!t) return res.status(404).json({ error: 'Not found' });
    let token = t.qr_token;
    if (!token) { token = crypto.randomBytes(12).toString('base64url'); db.prepare('UPDATE tables SET qr_token = ? WHERE id = ?').run(token, t.id); }
    const link = `${publicBase(req)}/t/${token}`;
    res.json({ link, label: t.label, svg: await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'H' }) });
  }));
  const tableByToken = (t) => (/^[A-Za-z0-9_-]{16}$/.test(t || '') ? db.prepare('SELECT * FROM tables WHERE qr_token = ?').get(t) : null);
  app.get('/api/t/:token', publicLimiter, (req, res) => {
    const t = tableByToken(req.params.token); if (!t) return res.status(404).json({ error: 'This table code is not valid.' });
    const info = onlineInfo();
    const open = db.prepare("SELECT o.number, o.status, o.created_at FROM orders o WHERE o.table_id = ? AND o.status IN ('sent','open','ready','held') ORDER BY o.id").all(t.id);
    res.json({ ...info, table: t.label, items: info.tableOrdering ? cleanMenu() : [], rounds: open });
  });
  app.post('/api/t/:token/order', orderLimiter, (req, res) => {
    const t = tableByToken(req.params.token); if (!t) return res.status(404).json({ error: 'This table code is not valid.' });
    if (getSettings().table_ordering !== '1') return res.status(403).json({ error: 'Ordering from the table is off. Please ask your server.' });
    const b = parse(z.object({ items: z.array(lineSchema).min(1).max(40), name: z.string().trim().max(30).optional() }), req.body);
    const lines = priceLines(b.items);
    if (lines.reduce((a, l) => a + l.qty, 0) > 40) return res.status(400).json({ error: 'That is a big order. Please ask your server.' });
    const o = insertOrder({ lines, status: 'sent', source: 'table', tableId: t.id, customerName: b.name || null });
    if (t.status === 'open' || t.status === 'reserved') db.prepare("UPDATE tables SET status='seated', seated_at=COALESCE(seated_at, ?) WHERE id=?").run(now(), t.id);
    audit(null, 'table.order', `${t.label}: #${o.number}`, clientIp(req));
    io.to('staff').emit('online:new', { number: o.number, name: `${getSettings().unit_label} ${t.label}`, fulfillment: 'table' });
    notifyStaff('orders'); notifyStaff('tables');
    res.json({ ok: true, number: o.number });
  });
  app.post('/api/t/:token/bill', publicLimiter, (req, res) => {
    const t = tableByToken(req.params.token); if (!t) return res.status(404).json({ error: 'This table code is not valid.' });
    const bill = billFor({ tableId: t.id });
    res.json({ token: bill.token });
  });
  app.post('/api/t/:token/help', publicLimiter, (req, res) => {
    const t = tableByToken(req.params.token); if (!t) return res.status(404).json({ error: 'Not valid' });
    const { reason } = parse(z.object({ reason: z.enum(['server', 'water', 'check']) }), req.body);
    io.to('staff').emit('security', { type: 'help', detail: `${getSettings().unit_label} ${t.label} ${{ server: 'is asking for their server', water: 'would like water', check: 'is ready for the check' }[reason]}` });
    res.json({ ok: true });
  });

  staff.get('/payments/status', (req, res) => res.json({ ...stripeStatus(), webhookUrl: `${publicBase(req)}/api/stripe/webhook` }));
}
