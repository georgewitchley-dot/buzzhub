// Round 17: auto-fire courses, ingredient 86, prep lists per area, runner screen, late-ticket make-good,
// delivery batching, bar tabs from table QR, area staffing alerts. (The server order pad is client only.)
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, getJwtSecret, forEachLocation } from './db.js';
import { userFromToken, SESSION_COOKIE } from './security.js';
import { whosOn } from './timeclock.js';
import { prepList } from './house.js';
import { stationFor, stationList } from './kds.js';
import { pushToUsers } from './notify.js';

registerSchema((db) => {
  const o = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  for (const [c, t] of [['served_at', 'TEXT'], ['makegood_at', 'TEXT'], ['makegood_alerted', 'TEXT'], ['tab_id', 'INTEGER']]) if (!o.includes(c)) db.exec(`ALTER TABLE orders ADD COLUMN ${c} ${t}`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS ingredient_86 (item_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (item_id, ingredient_id));
  CREATE TABLE IF NOT EXISTS tabs (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, table_id INTEGER, name TEXT NOT NULL, phone TEXT, status TEXT NOT NULL DEFAULT 'open', bill_id INTEGER,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT);
  CREATE TABLE IF NOT EXISTS area_alerts (area TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (area, kind));`);
  const g = db.prepare('PRAGMA table_info(ingredients)').all().map((c) => c.name);
  if (g.length && !g.includes('manual_out')) db.exec('ALTER TABLE ingredients ADD COLUMN manual_out INTEGER NOT NULL DEFAULT 0');
  if (g.length && !g.includes('prev_stock')) db.exec('ALTER TABLE ingredients ADD COLUMN prev_stock REAL');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ms = (sql) => Date.parse(`${String(sql).replace(' ', 'T')}Z`);
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const dist = (a, b, c, d) => { const R = 6371; const r = Math.PI / 180; const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

/** Recompute an order's totals after a change in discount. */
function retotal(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const sub = db.prepare('SELECT COALESCE(SUM(qty * price_cents),0) c FROM order_items WHERE order_id = ?').get(orderId).c;
  const disc = Math.min(o.discount_cents, sub); const tax = Math.round(((sub - disc) * Number(getSettings().tax_rate)) / 100);
  db.prepare('UPDATE orders SET subtotal_cents = ?, discount_cents = ?, tax_cents = ?, total_cents = ? WHERE id = ?').run(sub, disc, tax, sub - disc + tax + (o.fee_cents || 0), orderId);
}

export function registerRun({ app, staff, io, h }) {
  const { parse, clientIp, requireAuth, notifyStaff, wrap, publicLimiter } = h;
  const mgr = requireAuth('manager');
  const secret = () => `${getJwtSecret()}:kds`;
  const who = (req) => {
    const t = req.get('X-Kds');
    if (t) { try { const p = jwt.verify(t, secret()); if (p.loc === currentSlug() && String(p.v) === String(getSettings().kds_version || '1')) return { area: p.area, user: null }; } catch { /* bad */ } throw err('This kitchen screen is signed out.', 401); }
    let user = null; try { user = req.cookies?.[SESSION_COOKIE] ? userFromToken(req.cookies[SESSION_COOKIE]) : null; } catch { user = null; }
    if (!user) throw err('Sign in first', 401);
    return { area: String(req.query.area || req.body?.area || 'All areas'), user };
  };
  const label = (w) => (w.user ? w.user.name : `${w.area} screen`);

  /* ===== auto-fire courses ===== */
  const gap = () => Number(getSettings().course_gap_minutes || 0);
  /** Minutes until a held course fires on its own, or null if it waits on earlier courses / is manual. */
  h.fireIn = (orderId, course) => {
    const g = gap(); if (!g) return null;
    const prev = db.prepare('SELECT COUNT(*) n, SUM(done_at IS NULL) open, MAX(done_at) last FROM order_items WHERE order_id = ? AND course < ? AND price_cents >= 0').get(orderId, course);
    if (!prev.n || prev.open) return null;
    return Math.max(0, Math.ceil((ms(prev.last) + g * 60000 - Date.now()) / 60000));
  };
  function autoFire() {
    const g = gap(); if (!g) return;
    for (const r of db.prepare("SELECT DISTINCT oi.order_id, MIN(oi.course) course FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.fired_at IS NULL AND oi.course > 1 AND o.status IN ('open','sent') GROUP BY oi.order_id").all()) {
      if (h.fireIn(r.order_id, r.course) !== 0) continue;
      db.prepare("UPDATE order_items SET fired_at = datetime('now') WHERE order_id = ? AND course = ? AND fired_at IS NULL").run(r.order_id, r.course);
      const o = db.prepare('SELECT number FROM orders WHERE id = ?').get(r.order_id);
      audit(null, 'course.autofire', `#${o.number} course ${r.course}`, null); notifyStaff('orders');
      try { h.printTickets?.(r.order_id, false, r.course); } catch { /* best-effort */ }
    }
  }

  /* ===== ingredient 86 ===== */
  function ingredientSweep() {
    if (getSettings().ingredient_86 === '0') return;
    const out = db.prepare('SELECT id, name FROM ingredients WHERE active = 1 AND stock IS NOT NULL AND stock <= 0').all();
    for (const g of out) {
      for (const m of db.prepare('SELECT m.id, m.name, m.stock FROM item_recipes r JOIN menu_items m ON m.id = r.item_id WHERE r.ingredient_id = ? AND m.active = 1').all(g.id)) {
        if (db.prepare('SELECT 1 FROM ingredient_86 WHERE item_id = ? AND ingredient_id = ?').get(m.id, g.id)) continue;
        db.prepare('INSERT INTO ingredient_86 (item_id, ingredient_id) VALUES (?, ?)').run(m.id, g.id);
        if (m.stock === null || m.stock > 0) { db.prepare('UPDATE menu_items SET stock = 0 WHERE id = ?').run(m.id); audit(null, 'item.86', `${m.name}: out of ${g.name}`, null); pushToUsers(['staff', 'manager', 'owner'], { title: `86 ${m.name}`, body: `Out of ${g.name}.`, tag: `86-${m.id}`, url: '/menu' }).catch(() => {}); notifyStaff('menu'); }
      }
    }
    // back in stock: release dishes no other empty ingredient is holding
    for (const row of db.prepare('SELECT x.item_id, x.ingredient_id FROM ingredient_86 x JOIN ingredients g ON g.id = x.ingredient_id WHERE g.stock IS NULL OR g.stock > 0').all()) {
      db.prepare('DELETE FROM ingredient_86 WHERE item_id = ? AND ingredient_id = ?').run(row.item_id, row.ingredient_id);
      if (!db.prepare('SELECT 1 FROM ingredient_86 WHERE item_id = ?').get(row.item_id)) { db.prepare('UPDATE menu_items SET stock = NULL WHERE id = ? AND stock <= 0').run(row.item_id); notifyStaff('menu'); }
    }
  }
  h.ingredientSweep = ingredientSweep;
  app.get('/api/kds/ingredients', (req, res) => {
    const w = who(req); const list = stationList(); const all = ['All areas', 'Expo', 'Packing', 'Runner'].includes(w.area);
    const dishes = db.prepare('SELECT id, category, station FROM menu_items WHERE active = 1').all().filter((m) => all || stationFor(m, list) === w.area).map((m) => m.id);
    if (!dishes.length) return res.json([]);
    res.json(db.prepare(`SELECT DISTINCT g.id, g.name, g.unit, g.stock, g.manual_out FROM ingredients g JOIN item_recipes r ON r.ingredient_id = g.id WHERE g.active = 1 AND r.item_id IN (${dishes.join(',')}) ORDER BY g.name`).all()
      .map((g) => ({ id: g.id, name: g.name, unit: g.unit, out: g.stock !== null && g.stock <= 0, stock: g.stock, dishes: db.prepare('SELECT m.name FROM item_recipes r JOIN menu_items m ON m.id = r.item_id WHERE r.ingredient_id = ? AND m.active = 1').all(g.id).map((x) => x.name) })));
  });
  app.post('/api/kds/ingredient-86', (req, res) => {
    const w = who(req); const b = parse(z.object({ ingredientId: z.number().int(), out: z.boolean() }), req.body);
    const g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(b.ingredientId); if (!g) throw err('Not found', 404);
    if (b.out) { if (!g.manual_out) db.prepare('UPDATE ingredients SET manual_out = 1, prev_stock = stock, stock = 0 WHERE id = ?').run(g.id); }
    else {
      if (!g.manual_out && g.stock !== null && g.stock <= 0) throw err(`${g.name} ran out by count. Add the delivery or a new count in Inventory to put it back.`, 409);
      db.prepare('UPDATE ingredients SET stock = CASE WHEN manual_out = 1 THEN prev_stock ELSE stock END, manual_out = 0, prev_stock = NULL WHERE id = ?').run(g.id);
    }
    db.prepare("INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?, 0, ?, ?)").run(g.id, b.out ? `out (${label(w)})` : `back (${label(w)})`, w.user?.id || null);
    audit(w.user, b.out ? 'ingredient.out' : 'ingredient.back', `${g.name} (${label(w)})`, clientIp(req));
    ingredientSweep(); notifyStaff('menu'); res.json({ ok: true });
  });

  /* ===== prep list per area ===== */
  app.get('/api/kds/prep', (req, res) => {
    const w = who(req); const list = stationList(); const p = prepList(localToday()); const all = ['All areas', 'Expo', 'Packing', 'Runner'].includes(w.area);
    const meta = Object.fromEntries(db.prepare('SELECT id, category, station FROM menu_items').all().map((m) => [m.id, m]));
    const keep = (i) => all || stationFor(meta[i.id] || i, list) === w.area;
    const items0 = h.applyPars ? h.applyPars(p.items.filter(keep), keep) : p.items.filter(keep);
    const items1 = h.wasteAdjust ? h.wasteAdjust(items0) : items0;
    const shelf = Object.fromEntries(db.prepare('SELECT id, shelf_days FROM menu_items').all().map((m) => [m.id, m.shelf_days]));
    const items = (h.prepSplit ? h.prepSplit(items1) : items1).map((i) => ({ ...i, shelfDays: shelf[i.id] ?? null }));
    const ingIds = new Set(db.prepare(`SELECT ingredient_id FROM item_recipes WHERE item_id IN (${items.map((i) => i.id).join(',') || 0})`).all().map((r) => r.ingredient_id));
    res.json({ date: p.date, weekday: p.weekday, weeksOfData: p.weeksOfData, bufferPct: p.bufferPct, prepLabels: getSettings().prep_labels === '1', business: getSettings().business_name, leftovers: h.prepLeftoversToday ? h.prepLeftoversToday() : {}, items: items.map((i) => ({ ...i, recipe: h.prepRecipe ? h.prepRecipe(i.id, i.prep) : [] })), ingredients: p.ingredients.filter((g) => ingIds.has(g.id)) });
  });

  app.get('/api/kds/done-list', (req, res) => {
    const w = who(req); const all = ['All areas', 'Expo', 'Packing', 'Runner'].includes(w.area);
    res.json(h.recentDone ? h.recentDone(w.area, all) : []);
  });
  app.post('/api/kds/leftovers', (req, res) => {
    const w = who(req); const b = parse(z.object({ lines: z.array(z.object({ itemId: z.number().int(), qty: z.number().int().min(0).max(9999) })).max(200), by: z.string().trim().max(30).optional() }), req.body);
    res.json(h.prepLeftovers(b.lines, w.user ? w.user.name : b.by || label(w), w.user));
  });
  app.post('/api/kds/allergy-handoff', (req, res) => {
    const w = who(req); const { orderId, by } = parse(z.object({ orderId: z.number().int(), by: z.string().trim().max(30).optional() }), req.body);
    h.allergyHandoff(orderId, w.user ? w.user.name : by || label(w)); res.json({ ok: true });
  });
  app.post('/api/kds/prep-count', (req, res) => {
    const w = who(req); const b = parse(z.object({ itemId: z.number().int(), qty: z.number().int().min(0).max(9999).nullable(), by: z.string().trim().max(30).optional() }), req.body);
    h.prepCount(b.itemId, b.qty, w.user ? w.user.name : b.by || label(w)); res.json({ ok: true });
  });

  /* ===== runner screen ===== */
  h.runnerOrders = (all) => all.filter((o) => o.table_label && !o.served_at && (o.passSince || (['ready', 'paid'].includes(o.status) && o.ready_at && Date.now() - ms(o.ready_at) < 60 * 60000)));
  app.post('/api/kds/served', (req, res) => {
    const w = who(req); const { orderId } = parse(z.object({ orderId: z.number().int() }), req.body);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId); if (!o) throw err('Not found', 404);
    db.prepare("UPDATE orders SET served_at = datetime('now') WHERE id = ?").run(o.id);
    audit(w.user, 'order.served', `#${o.number} (${label(w)})`, clientIp(req)); notifyStaff('orders'); res.json({ ok: true });
  });

  /* ===== late-ticket make-good ===== */
  const lateLimit = () => Number(getSettings().makegood_minutes || 0);
  h.makegoodDue = (o) => { const l = lateLimit(); return Boolean(l && !o.makegood_at && ['open', 'sent'].includes(o.status) && o.sent_at && Date.now() - ms(o.sent_at) >= l * 60000); };
  const makeGood = (o, kind, w, ip) => {
    const s = getSettings();
    if (o.makegood_at) throw err('Already made good', 409);
    if (o.paid_at) throw err('This order is already paid; take care of it at the table', 409);
    let what;
    if (kind === 'item') {
      const m = db.prepare('SELECT * FROM menu_items WHERE id = ? AND active = 1').get(Number(s.makegood_item_id || 0)); if (!m) throw err('Pick the make-good dish in Settings first');
      db.prepare("INSERT INTO order_items (order_id, item_id, name, qty, price_cents, note, course, fired_at) VALUES (?, ?, ?, 1, 0, 'On us: sorry for the wait', 1, datetime('now'))").run(o.id, m.id, m.name);
      what = `free ${m.name}`;
    } else {
      const pct = Math.min(100, Math.max(1, Number(s.makegood_pct || 10)));
      const sub = db.prepare('SELECT COALESCE(SUM(qty * price_cents),0) c FROM order_items WHERE order_id = ?').get(o.id).c;
      const off = Math.round((sub * pct) / 100); db.prepare('UPDATE orders SET discount_cents = discount_cents + ? WHERE id = ?').run(off, o.id); retotal(o.id);
      what = `${pct}% off ($${(off / 100).toFixed(2)})`;
    }
    db.prepare("UPDATE orders SET makegood_at = datetime('now'), order_notes = TRIM(COALESCE(order_notes, '') || ' ' || ?) WHERE id = ?").run(`[Make-good: ${what}]`, o.id);
    audit(w?.user || w, 'order.makegood', `#${o.number}: ${what} (${w?.area ? label(w) : w?.name || ''})`, ip); notifyStaff('orders');
    return what;
  };
  app.post('/api/kds/makegood', (req, res) => { const w = who(req); const b = parse(z.object({ orderId: z.number().int(), kind: z.enum(['item', 'discount']) }), req.body); const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(b.orderId); if (!o) throw err('Not found', 404); res.json({ ok: true, what: makeGood(o, b.kind, w, clientIp(req)) }); });
  staff.post('/orders/:id/makegood', mgr, (req, res) => { const b = parse(z.object({ kind: z.enum(['item', 'discount']) }), req.body); const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id)); if (!o) throw err('Not found', 404); res.json({ ok: true, what: makeGood(o, b.kind, req.user, clientIp(req)) }); });
  async function lateAlerts() {
    const l = lateLimit(); if (!l) return;
    for (const o of db.prepare("SELECT o.id, o.number, o.sent_at, t.label FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.status IN ('open','sent') AND o.makegood_at IS NULL AND o.makegood_alerted IS NULL AND o.sent_at < datetime('now', ?)").all(`-${l} minutes`)) {
      db.prepare("UPDATE orders SET makegood_alerted = datetime('now') WHERE id = ?").run(o.id);
      await pushToUsers(['manager', 'owner'], { title: `#${o.number} is ${Math.round((Date.now() - ms(o.sent_at)) / 60000)} minutes late`, body: `${o.label ? `${getSettings().unit_label} ${o.label}. ` : ''}Offer a make-good from the expo screen or Orders.`, tag: `late-${o.id}`, url: '/orders' }).catch(() => {});
    }
  }

  /* ===== delivery batching ===== */
  staff.get('/delivery-batches', mgr, wrap(async (req, res) => {
    const radius = Number(getSettings().batch_radius_km || 2); const windowMin = Number(getSettings().batch_window_minutes || 15);
    const list = db.prepare("SELECT id, number, delivery_address, drop_lat, drop_lng, status, sent_at, ready_at, customer_name FROM orders WHERE fulfillment = 'delivery' AND driver_id IS NULL AND delivered_at IS NULL AND status IN ('open','sent','ready','paid') AND created_at > datetime('now','-4 hours') ORDER BY COALESCE(ready_at, sent_at)").all();
    for (const o of list) if (o.drop_lat == null && o.delivery_address && h.geocode) { const g = await h.geocode(o.delivery_address).catch(() => null); if (g) { db.prepare('UPDATE orders SET drop_lat = ?, drop_lng = ? WHERE id = ?').run(g.lat, g.lng, o.id); o.drop_lat = g.lat; o.drop_lng = g.lng; } }
    const placed = list.filter((o) => o.drop_lat != null); const used = new Set(); const batches = [];
    for (const a of placed) {
      if (used.has(a.id)) continue; const group = [a]; used.add(a.id);
      for (const b of placed) { if (used.has(b.id) || group.length >= 4) continue; const t = (x) => ms(x.ready_at || x.sent_at || nowSql());
        if (group.every((g) => dist(g.drop_lat, g.drop_lng, b.drop_lat, b.drop_lng) <= radius) && Math.abs(t(a) - t(b)) <= windowMin * 60000) { group.push(b); used.add(b.id); } }
      if (group.length > 1) batches.push({ orders: group.map((o) => ({ id: o.id, number: o.number, address: o.delivery_address, name: o.customer_name, ready: ['ready', 'paid'].includes(o.status) })), spreadKm: Math.round(Math.max(0, ...group.flatMap((x) => group.map((y) => dist(x.drop_lat, x.drop_lng, y.drop_lat, y.drop_lng)))) * 10) / 10 });
    }
    res.json({ radiusKm: radius, windowMinutes: windowMin, batches, unplaced: list.filter((o) => o.drop_lat == null).map((o) => ({ id: o.id, number: o.number, address: o.delivery_address })), drivers: db.prepare('SELECT id, name FROM users WHERE is_driver = 1 AND active = 1 ORDER BY name').all() });
  }));
  staff.post('/delivery-batches/assign', mgr, (req, res) => {
    const b = parse(z.object({ orderIds: z.array(z.number().int()).min(1).max(6), driverId: z.number().int() }), req.body);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND is_driver = 1 AND active = 1').get(b.driverId)) throw err('Pick a driver');
    const nums = [];
    for (const id of b.orderIds) { const o = db.prepare("SELECT * FROM orders WHERE id = ? AND fulfillment = 'delivery' AND delivered_at IS NULL").get(id); if (!o) continue; db.prepare('UPDATE orders SET driver_id = ? WHERE id = ?').run(b.driverId, o.id); nums.push(`#${o.number}`); }
    io.to(`user:${b.driverId}`).emit('delivery:assigned', { number: nums.join(', ') });
    pushToUsers(['staff', 'manager', 'owner'], { title: `${nums.length} deliveries for you`, body: `Orders ${nums.join(', ')}`, tag: 'drv-batch', url: '/deliveries' }, b.driverId).catch(() => {});
    audit(req.user, 'delivery.batch', `${nums.join(', ')} → driver ${b.driverId}`, clientIp(req)); notifyStaff('orders'); res.json({ ok: true, assigned: nums.length });
  });

  /* ===== bar tabs from table QR ===== */
  const tableByToken = (t) => (/^[A-Za-z0-9_-]{16}$/.test(t || '') ? db.prepare('SELECT * FROM tables WHERE qr_token = ?').get(t) : null);
  const tabByToken = (t) => (/^[A-Za-z0-9_-]{16,30}$/.test(t || '') ? db.prepare('SELECT * FROM tabs WHERE token = ?').get(t) : null);
  const tabView = (tab) => {
    const orders = db.prepare("SELECT id, number, status, total_cents, created_at FROM orders WHERE tab_id = ? AND status <> 'void' ORDER BY id").all(tab.id);
    const items = orders.length ? db.prepare(`SELECT name, SUM(qty) qty, SUM(qty * price_cents) cents FROM order_items WHERE order_id IN (${orders.map((o) => o.id).join(',')}) GROUP BY name ORDER BY MIN(id)`).all() : [];
    return { token: tab.token, name: tab.name, code: h.tabCode ? h.tabCode(tab.id) : null, members: h.tabMembers ? h.tabMembers(tab) : [], status: tab.status, openedAt: tab.opened_at, rounds: orders.length, totalCents: orders.reduce((a, o) => a + o.total_cents, 0), items, billToken: tab.bill_id ? db.prepare('SELECT token FROM bills WHERE id = ?').get(tab.bill_id)?.token : null };
  };
  h.tabForOrder = (tabToken, tableId) => {
    if (!tabToken) return null; const tab = tabByToken(tabToken);
    if (!tab || tab.status !== 'open' || (tab.table_id && tableId && tab.table_id !== tableId)) throw err('This tab is closed. Start a new one.', 409);
    return tab;
  };
  app.post('/api/t/:token/tab', publicLimiter, (req, res) => {
    if (getSettings().bar_tabs !== '1') throw err('Tabs are not available here', 403);
    const t = tableByToken(req.params.token); if (!t) throw err('This table code is not valid.', 404);
    const b = parse(z.object({ name: z.string().trim().min(1).max(30), phone: z.string().trim().max(20).optional() }), req.body);
    const token = crypto.randomBytes(12).toString('base64url');
    db.prepare('INSERT INTO tabs (token, table_id, name, phone) VALUES (?,?,?,?)').run(token, t.id, b.name, b.phone || null);
    audit(null, 'tab.open', `${b.name} at ${t.label}`, clientIp(req)); notifyStaff('tabs'); res.json(tabView(tabByToken(token)));
  });
  app.get('/api/t/:token/tab/:tab', publicLimiter, (req, res) => { const tab = tabByToken(req.params.tab); if (!tab) throw err('Tab not found', 404); res.json(tabView(tab)); });
  const closeTab = (tab) => {
    const orders = db.prepare("SELECT id FROM orders WHERE tab_id = ? AND status <> 'void' AND paid_at IS NULL").all(tab.id);
    let billId = tab.bill_id;
    if (!billId) {
      billId = db.prepare('INSERT INTO bills (token) VALUES (?)').run(crypto.randomBytes(16).toString('base64url')).lastInsertRowid;
      db.prepare("UPDATE tabs SET bill_id = ?, status = 'closing' WHERE id = ?").run(billId, tab.id);
    }
    for (const o of orders) db.prepare('INSERT OR IGNORE INTO bill_orders (bill_id, order_id) VALUES (?, ?)').run(billId, o.id);
    return db.prepare('SELECT token FROM bills WHERE id = ?').get(billId).token;
  };
  app.post('/api/t/:token/tab/:tab/close', publicLimiter, (req, res) => {
    const tab = tabByToken(req.params.tab); if (!tab) throw err('Tab not found', 404);
    if (!db.prepare("SELECT 1 FROM orders WHERE tab_id = ? AND status <> 'void'").get(tab.id)) { db.prepare("UPDATE tabs SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(tab.id); return res.json({ closed: true }); }
    const token = closeTab(tab); notifyStaff('tabs'); const member = typeof req.body?.member === 'string' ? req.body.member.slice(0, 30) : null; res.json({ billToken: token, items: h.memberItems ? h.memberItems(tab, member) : [] });
  });
  staff.get('/tabs', (req, res) => res.json(db.prepare("SELECT t.*, tb.label table_label FROM tabs t LEFT JOIN tables tb ON tb.id = t.table_id WHERE t.status <> 'closed' AND t.opened_at > datetime('now','-24 hours') ORDER BY t.opened_at").all().map((t) => ({ ...tabView(t), id: t.id, table: t.table_label }))));
  staff.post('/tabs/:id/close', (req, res) => {
    const tab = db.prepare('SELECT * FROM tabs WHERE id = ?').get(Number(req.params.id)); if (!tab) throw err('Not found', 404);
    const paid = !db.prepare("SELECT 1 FROM orders WHERE tab_id = ? AND status <> 'void' AND paid_at IS NULL").get(tab.id);
    if (paid) { db.prepare("UPDATE tabs SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(tab.id); notifyStaff('tabs'); return res.json({ closed: true }); }
    const token = closeTab(tab); audit(req.user, 'tab.close', tab.name, clientIp(req)); notifyStaff('tabs'); res.json({ billToken: token });
  });
  // tabs whose orders are all paid close themselves
  function tabSweep() { for (const t of db.prepare("SELECT id FROM tabs WHERE status = 'closing'").all()) if (!db.prepare("SELECT 1 FROM orders WHERE tab_id = ? AND status <> 'void' AND paid_at IS NULL").get(t.id)) db.prepare("UPDATE tabs SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(t.id); }

  /* ===== area staffing alerts ===== */
  function areaLoad() {
    const list = stationList(); const on = whosOn().filter((p) => !p.onBreak);
    const areaOf = Object.fromEntries(db.prepare('SELECT id, area FROM users').all().map((u) => [u.id, u.area]));
    const items = db.prepare("SELECT oi.qty, m.category, m.station FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN menu_items m ON m.id = oi.item_id WHERE o.status IN ('open','sent') AND oi.done_at IS NULL AND (oi.course <= 1 OR oi.fired_at IS NOT NULL)").all();
    return list.map((a) => { const cooks = on.filter((p) => areaOf[p.userId] === a); const n = items.filter((i) => stationFor(i, list) === a).reduce((s, i) => s + i.qty, 0); return { area: a, items: n, cooks: cooks.length, names: cooks.map((c) => c.name.split(' ')[0]), perCook: cooks.length ? Math.round((n / cooks.length) * 10) / 10 : n }; });
  }
  h.areaLoad = areaLoad;
  staff.get('/area-load', (req, res) => { const s = getSettings(); res.json({ high: Number(s.area_alert_high || 12), areas: areaLoad() }); });
  async function staffingAlerts() {
    const s = getSettings(); if (s.area_alerts !== '1') return;
    const high = Number(s.area_alert_high || 12); const quietMin = Number(s.area_alert_quiet_minutes || 30);
    const once = (area, kind, mins) => { const r = db.prepare('SELECT at FROM area_alerts WHERE area = ? AND kind = ?').get(area, kind); if (r && Date.now() - ms(r.at) < mins * 60000) return false; db.prepare('INSERT INTO area_alerts (area, kind, at) VALUES (?, ?, ?) ON CONFLICT (area, kind) DO UPDATE SET at = excluded.at').run(area, kind, nowSql()); return true; };
    for (const a of areaLoad()) {
      if (a.items > 0 && (a.cooks === 0 || a.perCook > high) && once(a.area, 'high', 45)) await pushToUsers(['manager', 'owner'], { title: `${a.area} needs help`, body: `${a.items} items waiting, ${a.cooks ? `${a.cooks} cook${a.cooks === 1 ? '' : 's'}` : 'nobody clocked in for it'}.`, tag: `area-${a.area}`, url: '/kitchen' }).catch(() => {});
      if (a.items === 0 && a.cooks >= 2) {
        const last = db.prepare("SELECT MAX(oi.done_at) t FROM order_items oi WHERE oi.done_station = ?").get(a.area).t;
        if ((!last || Date.now() - ms(last) > quietMin * 60000) && once(a.area, 'quiet', 120)) await pushToUsers(['manager', 'owner'], { title: `${a.area} is quiet`, body: `${a.cooks} on the clock (${a.names.join(', ')}) and nothing cooking for ${quietMin}+ minutes. Send someone on break or home?`, tag: `area-${a.area}`, url: '/labor-areas' }).catch(() => {});
      }
    }
  }

  setInterval(() => forEachLocation(() => { try { autoFire(); ingredientSweep(); tabSweep(); } catch (e) { console.error('run jobs', e.message); } lateAlerts().catch(() => {}); }), 30_000).unref();
  setInterval(() => forEachLocation(() => staffingAlerts().catch((e) => console.error('area alerts', e.message))), 5 * 60_000).unref();
}
