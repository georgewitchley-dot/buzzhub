// Round 10: order again, tip-out by role, calories, manager log book, equipment maintenance, auto reorder,
// loyalty tiers, call server button, weekly owner report, more languages, supplier bills (accounts payable).
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, currentTz, forEachLocation } from './db.js';
import { menuHooks } from './commerce.js';
import { pushToUsers, emailEnabled, emailGuest } from './notify.js';
import { dayBounds } from './ops.js';
import { customerFromReq } from './security.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS log_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL, must_read INTEGER NOT NULL DEFAULT 0,
  audience TEXT NOT NULL DEFAULT 'managers', user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS log_reads (entry_id INTEGER NOT NULL, user_id INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (entry_id, user_id));
CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT, make_model TEXT, serial TEXT, vendor TEXT, vendor_phone TEXT, warranty_until TEXT,
  service_every_days INTEGER, last_service TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS equipment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, equipment_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('service','repair','issue','note')), notes TEXT, cost_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('open','done')), user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS table_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')), ack_at TEXT, ack_by INTEGER
);
CREATE TABLE IF NOT EXISTS supplier_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, po_id INTEGER, number TEXT, bill_date TEXT NOT NULL, due_date TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')), category TEXT NOT NULL DEFAULT 'food', note TEXT, photo_version TEXT NOT NULL DEFAULT '0',
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT
);
CREATE TABLE IF NOT EXISTS bill_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, method TEXT NOT NULL, reference TEXT, paid_on TEXT NOT NULL, user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS owner_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')));`);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('users').includes('tip_role')) db.exec("ALTER TABLE users ADD COLUMN tip_role TEXT NOT NULL DEFAULT ''");
  if (!cols('ingredients').includes('kcal')) db.exec('ALTER TABLE ingredients ADD COLUMN kcal REAL');
  if (!cols('menu_items').includes('calories')) db.exec('ALTER TABLE menu_items ADD COLUMN calories INTEGER');
  if (!cols('suppliers').includes('terms_days')) db.exec('ALTER TABLE suppliers ADD COLUMN terms_days INTEGER NOT NULL DEFAULT 30');
  if (!cols('purchase_orders').includes('auto')) db.exec('ALTER TABLE purchase_orders ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const parseJ = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const once = (key) => db.prepare('INSERT OR IGNORE INTO owner_alerts (key) VALUES (?)').run(key).changes > 0;
const fmt = (c) => `$${(c / 100).toFixed(2)}`;
const localHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: currentTz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const localDow = () => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: currentTz(), weekday: 'short' }).format(new Date()));
export const LANGS = { en: 'English', es: 'Español', fr: 'Français', zh: '中文', vi: 'Tiếng Việt' };

/* ---------- calories on every menu ---------- */
export function caloriesMap() {
  const rows = db.prepare('SELECT r.item_id, SUM(r.qty * g.kcal) k, SUM(CASE WHEN g.kcal IS NULL THEN 1 ELSE 0 END) missing FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id GROUP BY r.item_id').all();
  const fromRecipe = Object.fromEntries(rows.filter((r) => !r.missing && r.k).map((r) => [r.item_id, Math.round(r.k)]));
  const manual = Object.fromEntries(db.prepare('SELECT id, calories FROM menu_items WHERE calories IS NOT NULL').all().map((r) => [r.id, r.calories]));
  return { ...fromRecipe, ...manual };
}
menuHooks.adjust.push((items) => {
  if (getSettings().show_calories !== '1') return items;
  const cal = caloriesMap();
  return items.map((i) => (cal[i.id] !== undefined ? { ...i, calories: cal[i.id] } : i));
});

/* ---------- loyalty tiers ---------- */
export function tierFor(customerId) {
  const tiers = parseJ(getSettings().loyalty_tiers, []).filter((t) => t.name && Number(t.minCents) > 0).sort((a, b) => b.minCents - a.minCents);
  if (!tiers.length || !customerId) return null;
  const spent = db.prepare("SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) c FROM orders WHERE customer_id = ? AND paid_at > datetime('now','-365 days') AND status <> 'void'").get(customerId).c;
  const tier = tiers.find((t) => spent >= t.minCents) || null;
  const asc = [...tiers].reverse(); const next = asc.find((t) => spent < t.minCents) || null;
  return { spentCents: spent, tier: tier ? { name: tier.name, pct: Number(tier.pct) || 0, perk: tier.perk || '' } : null, next: next ? { name: next.name, needCents: next.minCents - spent } : null };
}

/* ---------- tip-out by role ---------- */
export const TIP_ROLES = ['server', 'bartender', 'busser', 'runner', 'host', 'kitchen'];
export function tipouts(from, to) {
  const a = dayBounds(from).start; const z2 = dayBounds(to).end;
  const rules = parseJ(getSettings().tipout_rules, []).filter((r) => r.from && r.to && Number(r.pct) > 0);
  const users = db.prepare('SELECT id, name, tip_role FROM users WHERE active = 1').all();
  const sales = Object.fromEntries(db.prepare("SELECT created_by u, COALESCE(SUM(subtotal_cents - discount_cents),0) s, COALESCE(SUM(tip_cents),0) t FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void' AND created_by IS NOT NULL GROUP BY created_by").all(a, z2).map((r) => [r.u, r]));
  const hours = {};
  for (const s of db.prepare('SELECT user_id, clock_in, clock_out, break_minutes FROM shifts WHERE clock_in < ? AND COALESCE(clock_out, ?) > ?').all(z2, z2, a)) {
    const st = s.clock_in < a ? a : s.clock_in; const en = !s.clock_out || s.clock_out > z2 ? z2 : s.clock_out;
    hours[s.user_id] = (hours[s.user_id] || 0) + Math.max(0, (Date.parse(`${en.replace(' ', 'T')}Z`) - Date.parse(`${st.replace(' ', 'T')}Z`)) / 3600000 - (s.break_minutes || 0) / 60);
  }
  const people = Object.fromEntries(users.map((u) => [u.id, { userId: u.id, name: u.name, role: u.tip_role || '', salesCents: sales[u.id]?.s || 0, tipsCents: sales[u.id]?.t || 0, hours: Math.round((hours[u.id] || 0) * 100) / 100, givesCents: 0, getsCents: 0 }]));
  const lines = [];
  for (const r of rules) {
    const givers = Object.values(people).filter((p) => p.role === r.from);
    const takers = Object.values(people).filter((p) => p.role === r.to && p.hours > 0);
    if (!takers.length) continue;
    let pot = 0;
    for (const g of givers) { const amt = Math.round((r.base === 'tips' ? g.tipsCents : g.salesCents) * Number(r.pct) / 100); if (amt > 0) { g.givesCents += amt; pot += amt; } }
    const hrs = takers.reduce((x, t) => x + t.hours, 0); let left = pot;
    takers.forEach((t, i) => { const share = i === takers.length - 1 ? left : Math.round(pot * t.hours / hrs); left -= share; t.getsCents += share; });
    lines.push({ ...r, potCents: pot });
  }
  const list = Object.values(people).filter((p) => p.role && (p.salesCents || p.tipsCents || p.hours || p.getsCents)).map((p) => ({ ...p, netCents: p.tipsCents - p.givesCents + p.getsCents })).sort((x, y) => x.name.localeCompare(y.name));
  return { from, to, rules: lines, people: list };
}

/* ---------- weekly owner report ---------- */
export function weeklyReport(weekStart) {
  const end = addDays(weekStart, 6); const prevStart = addDays(weekStart, -7);
  const sum = (from, to) => {
    const a = dayBounds(from).start; const z2 = dayBounds(to).end;
    const o = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents - discount_cents),0) s, COALESCE(SUM(tip_cents),0) t FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void'").get(a, z2);
    const shifts = db.prepare('SELECT s.clock_in, s.clock_out, s.break_minutes, u.hourly_cents FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in < ? AND COALESCE(s.clock_out, ?) > ?').all(z2, z2, a);
    const labor = Math.round(shifts.reduce((x, s) => { const st = s.clock_in < a ? a : s.clock_in; const en = !s.clock_out || s.clock_out > z2 ? z2 : s.clock_out; return x + Math.max(0, (Date.parse(`${en.replace(' ', 'T')}Z`) - Date.parse(`${st.replace(' ', 'T')}Z`)) / 3600000 - (s.break_minutes || 0) / 60) * s.hourly_cents; }, 0));
    const food = db.prepare("SELECT COALESCE(SUM(oi.qty * (SELECT SUM(r.qty * g.cost_cents) FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = oi.item_id)),0) c, COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM item_recipes r WHERE r.item_id = oi.item_id) THEN oi.qty * oi.price_cents ELSE 0 END),0) base FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status <> 'void'").get(a, z2);
    let waste = 0; try { waste = db.prepare('SELECT COALESCE(SUM(cost_cents),0) c FROM waste_log WHERE at >= ? AND at < ?').get(a, z2).c; } catch { /* no table */ }
    const top = db.prepare("SELECT oi.name, SUM(oi.qty) q, SUM(oi.qty * oi.price_cents) c FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status <> 'void' GROUP BY oi.name ORDER BY c DESC LIMIT 5").all(a, z2);
    const best = db.prepare(`SELECT substr(datetime(paid_at, ?),1,10) d, SUM(subtotal_cents - discount_cents) s FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void' GROUP BY d ORDER BY s DESC LIMIT 1`).get(`${tzOffsetMin()} minutes`, a, z2);
    let rating = null; try { rating = db.prepare("SELECT ROUND(AVG(rating),1) r, COUNT(*) n FROM feedback WHERE rating IS NOT NULL AND responded_at >= ? AND responded_at < ?").get(a, z2); } catch { /* none */ }
    return { orders: o.n, salesCents: o.s, tipsCents: o.t, avgCents: o.n ? Math.round(o.s / o.n) : 0, laborCents: labor, laborPct: o.s ? Math.round(labor / o.s * 1000) / 10 : null, foodCostPct: food.base ? Math.round(food.c / food.base * 1000) / 10 : null, wasteCents: waste, top, bestDay: best?.d || null, rating };
  };
  const now = sum(weekStart, end); const prev = sum(prevStart, addDays(weekStart, -1));
  let billsDue = []; try { billsDue = db.prepare("SELECT b.due_date, b.amount_cents - COALESCE((SELECT SUM(amount_cents) FROM bill_payments p WHERE p.bill_id = b.id),0) owed, s.name FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.status = 'open' AND b.due_date <= ? ORDER BY b.due_date").all(addDays(end, 14)); } catch { /* none */ }
  return { business: getSettings().business_name, from: weekStart, to: end, now, prev, changePct: prev.salesCents ? Math.round((now.salesCents - prev.salesCents) / prev.salesCents * 1000) / 10 : null, billsDue };
}
function tzOffsetMin() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: currentTz(), timeZoneName: 'shortOffset' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(p.timeZoneName || ''); return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 0;
}
export function reportText(r) {
  const n = r.now; const pp = (v) => (v === null ? 'n/a' : `${v}%`);
  return [`Week of ${r.from} to ${r.to}`, '',
    `Sales: ${fmt(n.salesCents)} from ${n.orders} orders${r.changePct !== null ? ` (${r.changePct >= 0 ? '+' : ''}${r.changePct}% vs the week before)` : ''}`,
    `Average ticket: ${fmt(n.avgCents)}. Tips: ${fmt(n.tipsCents)}.`, `Labor: ${fmt(n.laborCents)} (${pp(n.laborPct)} of sales). Food cost: ${pp(n.foodCostPct)}. Waste: ${fmt(n.wasteCents)}.`,
    n.bestDay ? `Best day: ${n.bestDay}.` : '', n.rating?.n ? `Guest rating: ${n.rating.r} / 5 from ${n.rating.n} reviews.` : '', '',
    n.top.length ? `Top sellers: ${n.top.map((t) => `${t.name} (${t.q})`).join(', ')}.` : '',
    r.billsDue.length ? `\nSupplier bills due in the next two weeks: ${r.billsDue.map((b) => `${b.name} ${fmt(b.owed)} on ${b.due_date}`).join('; ')}.` : ''].filter((x) => x !== '').join('\n');
}
const lastMonday = () => { const t = localToday(); const dow = new Date(`${t}T12:00:00Z`).getUTCDay(); return addDays(t, -((dow + 6) % 7) - 7); };

/* ---------- supplier bills ---------- */
function billView(b) {
  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) c FROM bill_payments WHERE bill_id = ?').get(b.id).c;
  const s = db.prepare('SELECT name, email, phone FROM suppliers WHERE id = ?').get(b.supplier_id);
  const owed = b.status === 'void' ? 0 : Math.max(0, b.amount_cents - paid);
  const overdue = b.status === 'open' && b.due_date < localToday() ? daysBetween(b.due_date, localToday()) : 0;
  return { ...b, supplier: s?.name || '?', supplierEmail: s?.email || '', paidCents: paid, owedCents: owed, overdueDays: overdue, photo: b.photo_version !== '0' ? `/api/staff/supplier-bills/${b.id}/photo?v=${b.photo_version}` : null,
    payments: db.prepare('SELECT p.*, u.name by_name FROM bill_payments p LEFT JOIN users u ON u.id = p.user_id WHERE bill_id = ? ORDER BY p.id').all(b.id) };
}
function poTotal(poId) { return Math.round(db.prepare('SELECT COALESCE(SUM(COALESCE(received_qty, qty) * cost_cents),0) c FROM po_lines WHERE po_id = ?').get(poId).c); }

/* ---------- auto reorder ---------- */
export function autoReorder(userId = null) {
  const s = getSettings(); const made = [];
  const low = db.prepare('SELECT * FROM ingredients WHERE active = 1 AND stock IS NOT NULL AND stock <= low AND supplier_id IS NOT NULL').all();
  const openIds = new Set(db.prepare("SELECT l.ingredient_id FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE p.status IN ('draft','sent')").all().map((r) => r.ingredient_id));
  const bySup = {};
  for (const g of low) { if (openIds.has(g.id)) continue; const qty = Math.max(1, Math.round(((g.par ?? g.low * 3) - g.stock) * 100) / 100); (bySup[g.supplier_id] = bySup[g.supplier_id] || []).push({ g, qty }); }
  for (const [sid, lines] of Object.entries(bySup)) {
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ? AND active = 1').get(sid)) continue;
    const pid = db.transaction(() => {
      const id = db.prepare("INSERT INTO purchase_orders (supplier_id, notes, created_by, auto) VALUES (?, 'Made automatically for low stock', ?, 1)").run(sid, userId).lastInsertRowid;
      for (const l of lines) db.prepare('INSERT INTO po_lines (po_id, ingredient_id, qty, cost_cents) VALUES (?,?,?,?)').run(id, l.g.id, l.qty, l.g.cost_cents);
      return id;
    })();
    made.push({ poId: pid, supplierId: Number(sid), items: lines.map((l) => `${l.qty} ${l.g.unit} ${l.g.name}`) });
  }
  if (made.length) {
    audit(null, 'po.auto', `${made.length} draft order${made.length === 1 ? '' : 's'}`, null);
    pushToUsers(['manager', 'owner'], { title: `${s.business_name}: supplier order${made.length === 1 ? '' : 's'} ready`, body: `${made.length} draft order${made.length === 1 ? '' : 's'} for low stock. Check and send them in Purchasing.`, tag: 'auto-po', url: '/purchasing' }).catch(() => {});
  }
  return made;
}

export function registerOwner({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, publicLimiter, notifyStaff } = h;
  const mgr = requireAuth('manager'); const owner = requireAuth('owner');

  /* ===== order again ===== */
  h.linkOrderCustomer = (req, orderId) => { const c = customerFromReq(req); if (c) db.prepare('UPDATE orders SET customer_id = ? WHERE id = ? AND customer_id IS NULL').run(c.id, orderId); };
  app.get('/api/c/orders', publicLimiter, (req, res) => {
    const c = customerFromReq(req); if (!c) return res.json([]);
    const orders = db.prepare("SELECT id, number, created_at, fulfillment, total_cents, status FROM orders WHERE customer_id = ? AND status <> 'void' ORDER BY id DESC LIMIT 10").all(c.id);
    res.json(orders.map((o) => ({ ...o, items: db.prepare('SELECT item_id, name, qty, price_cents, mods, note FROM order_items WHERE order_id = ? AND item_id IS NOT NULL').all(o.id).map((i) => ({ itemId: i.item_id, name: i.name, qty: i.qty, cents: i.price_cents, note: i.note, mods: parseJ(i.mods, []).map((m) => m.id).filter(Boolean), modNames: parseJ(i.mods, []).map((m) => m.name) })) })));
  });

  /* ===== tip-out by role ===== */
  staff.get('/tipouts', mgr, (req, res) => {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || ''); const to = ok(req.query.to) ? req.query.to : localToday(); const from = ok(req.query.from) ? req.query.from : addDays(to, -6);
    res.json({ ...tipouts(from, to), roles: TIP_ROLES, team: db.prepare('SELECT id, name, role, tip_role FROM users WHERE active = 1 ORDER BY name').all() });
  });
  staff.put('/users/:id/tip-role', mgr, (req, res) => { const b = parse(z.object({ tipRole: z.enum(['', ...TIP_ROLES]) }), req.body); db.prepare('UPDATE users SET tip_role = ? WHERE id = ?').run(b.tipRole, idParam(req)); audit(req.user, 'tips.role', `user ${req.params.id} → ${b.tipRole || 'none'}`, clientIp(req)); res.json({ ok: true }); });

  /* ===== calories ===== */
  staff.get('/nutrition', mgr, (req, res) => {
    const cal = caloriesMap();
    res.json({ show: getSettings().show_calories === '1', ingredients: db.prepare('SELECT id, name, unit, kcal FROM ingredients WHERE active = 1 ORDER BY name').all(),
      items: db.prepare('SELECT id, name, category, calories FROM menu_items ORDER BY category, name').all().map((m) => ({ ...m, computed: m.calories === null ? cal[m.id] ?? null : null, hasRecipe: Boolean(db.prepare('SELECT 1 FROM item_recipes WHERE item_id = ?').get(m.id)) })) });
  });
  staff.put('/ingredients/:id/kcal', mgr, (req, res) => { const b = parse(z.object({ kcal: z.number().min(0).max(100000).nullable() }), req.body); db.prepare('UPDATE ingredients SET kcal = ? WHERE id = ?').run(b.kcal, idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });
  staff.put('/menu/:id/calories', mgr, (req, res) => { const b = parse(z.object({ calories: z.number().int().min(0).max(10000).nullable() }), req.body); db.prepare('UPDATE menu_items SET calories = ? WHERE id = ?').run(b.calories, idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });

  /* ===== manager log book ===== */
  const canSee = (u, e) => e.audience === 'all' || ['manager', 'owner'].includes(u.role);
  staff.get('/logbook', (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const rows = db.prepare('SELECT e.*, u.name by_name, (SELECT COUNT(*) FROM log_reads r WHERE r.entry_id = e.id) reads, (SELECT 1 FROM log_reads r WHERE r.entry_id = e.id AND r.user_id = ?) mine FROM log_entries e LEFT JOIN users u ON u.id = e.user_id WHERE e.day >= ? ORDER BY e.id DESC').all(req.user.id, addDays(localToday(), -days)).filter((e) => canSee(req.user, e));
    res.json(rows.map((e) => ({ ...e, read: Boolean(e.mine) || e.user_id === req.user.id })));
  });
  staff.get('/logbook/unread', (req, res) => res.json({ n: db.prepare("SELECT e.* FROM log_entries e WHERE e.must_read = 1 AND e.day >= ? AND (e.user_id IS NULL OR e.user_id <> ?) AND NOT EXISTS (SELECT 1 FROM log_reads r WHERE r.entry_id = e.id AND r.user_id = ?)").all(addDays(localToday(), -7), req.user.id, req.user.id).filter((e) => canSee(req.user, e)).length }));
  staff.post('/logbook', (req, res) => {
    const b = parse(z.object({ kind: z.enum(['note', 'incident', 'maintenance', 'staffing', 'guest', '86']), body: z.string().trim().min(1).max(2000), mustRead: z.boolean().default(false), audience: z.enum(['managers', 'all']).default('managers') }), req.body);
    if (b.audience === 'managers' && !['manager', 'owner'].includes(req.user.role)) b.audience = 'all';
    db.prepare('INSERT INTO log_entries (day, kind, body, must_read, audience, user_id) VALUES (?,?,?,?,?,?)').run(localToday(), b.kind, b.body, b.mustRead ? 1 : 0, b.audience, req.user.id);
    if (b.mustRead) pushToUsers(b.audience === 'all' ? ['staff', 'manager', 'owner'] : ['manager', 'owner'], { title: `${getSettings().business_name}: log note to read`, body: b.body.slice(0, 120), tag: 'logbook', url: '/logbook' }).catch(() => {});
    audit(req.user, 'log.add', b.kind, clientIp(req)); notifyStaff('logbook'); res.json({ ok: true });
  });
  staff.post('/logbook/:id/read', (req, res) => { db.prepare('INSERT OR IGNORE INTO log_reads (entry_id, user_id) VALUES (?, ?)').run(idParam(req), req.user.id); notifyStaff('logbook'); res.json({ ok: true }); });
  staff.get('/logbook/:id/readers', mgr, (req, res) => res.json(db.prepare('SELECT u.name, r.at FROM log_reads r JOIN users u ON u.id = r.user_id WHERE r.entry_id = ? ORDER BY r.at').all(idParam(req))));

  /* ===== equipment ===== */
  const eqView = (e) => {
    const next = e.service_every_days && e.last_service ? addDays(e.last_service, e.service_every_days) : null;
    const openIssues = db.prepare("SELECT COUNT(*) n FROM equipment_events WHERE equipment_id = ? AND status = 'open'").get(e.id).n;
    const spent = db.prepare("SELECT COALESCE(SUM(cost_cents),0) c FROM equipment_events WHERE equipment_id = ? AND at > datetime('now','-365 days')").get(e.id).c;
    return { ...e, nextService: next, dueInDays: next ? daysBetween(localToday(), next) : null, openIssues, spentYearCents: spent, warrantyOk: e.warranty_until ? e.warranty_until >= localToday() : null };
  };
  staff.get('/equipment', (req, res) => res.json(db.prepare('SELECT * FROM equipment WHERE active = 1 ORDER BY name').all().map(eqView)));
  staff.get('/equipment/:id', (req, res) => { const e = db.prepare('SELECT * FROM equipment WHERE id = ?').get(idParam(req)); if (!e) throw err('Not found', 404); res.json({ ...eqView(e), events: db.prepare('SELECT v.*, u.name by_name FROM equipment_events v LEFT JOIN users u ON u.id = v.user_id WHERE equipment_id = ? ORDER BY v.id DESC').all(e.id) }); });
  const eqSchema = z.object({ name: z.string().trim().min(1).max(60), location: z.string().trim().max(60).optional(), makeModel: z.string().trim().max(80).optional(), serial: z.string().trim().max(60).optional(), vendor: z.string().trim().max(60).optional(), vendorPhone: z.string().trim().max(30).optional(),
    warrantyUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), serviceEveryDays: z.number().int().min(1).max(1095).nullable().optional(), lastService: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), notes: z.string().trim().max(500).optional() });
  const eqArgs = (b) => [b.name, b.location || null, b.makeModel || null, b.serial || null, b.vendor || null, b.vendorPhone || null, b.warrantyUntil || null, b.serviceEveryDays ?? null, b.lastService || null, b.notes || null];
  staff.post('/equipment', mgr, (req, res) => { const b = parse(eqSchema, req.body); db.prepare('INSERT INTO equipment (name, location, make_model, serial, vendor, vendor_phone, warranty_until, service_every_days, last_service, notes) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...eqArgs(b)); audit(req.user, 'equipment.add', b.name, clientIp(req)); notifyStaff('equipment'); res.json({ ok: true }); });
  staff.put('/equipment/:id', mgr, (req, res) => { const b = parse(eqSchema, req.body); db.prepare('UPDATE equipment SET name=?, location=?, make_model=?, serial=?, vendor=?, vendor_phone=?, warranty_until=?, service_every_days=?, last_service=?, notes=? WHERE id=?').run(...eqArgs(b), idParam(req)); notifyStaff('equipment'); res.json({ ok: true }); });
  staff.delete('/equipment/:id', mgr, (req, res) => { db.prepare('UPDATE equipment SET active = 0 WHERE id = ?').run(idParam(req)); notifyStaff('equipment'); res.json({ ok: true }); });
  staff.post('/equipment/:id/events', (req, res) => {
    const b = parse(z.object({ kind: z.enum(['service', 'repair', 'issue', 'note']), notes: z.string().trim().max(500).optional(), costCents: z.number().int().min(0).max(10_000_000).default(0) }), req.body);
    const e = db.prepare('SELECT * FROM equipment WHERE id = ?').get(idParam(req)); if (!e) throw err('Not found', 404);
    if (b.costCents && !['manager', 'owner'].includes(req.user.role)) b.costCents = 0;
    db.prepare('INSERT INTO equipment_events (equipment_id, kind, notes, cost_cents, status, user_id) VALUES (?,?,?,?,?,?)').run(e.id, b.kind, b.notes || null, b.costCents, b.kind === 'issue' ? 'open' : 'done', req.user.id);
    if (b.kind === 'service') db.prepare('UPDATE equipment SET last_service = ? WHERE id = ?').run(localToday(), e.id);
    if (b.kind === 'repair' || b.kind === 'service') db.prepare("UPDATE equipment_events SET status = 'done' WHERE equipment_id = ? AND status = 'open'").run(e.id);
    if (b.kind === 'issue') pushToUsers(['manager', 'owner'], { title: `${getSettings().business_name}: ${e.name} problem`, body: `${req.user.name.split(' ')[0]}: ${b.notes || 'reported an issue'}${e.vendor_phone ? `. Vendor: ${e.vendor || ''} ${e.vendor_phone}` : ''}`, tag: `eq-${e.id}`, url: '/equipment' }).catch(() => {});
    audit(req.user, `equipment.${b.kind}`, e.name, clientIp(req)); notifyStaff('equipment'); res.json({ ok: true });
  });

  /* ===== auto reorder ===== */
  staff.post('/purchase-orders/auto', mgr, (req, res) => { const made = autoReorder(req.user.id); notifyStaff('menu'); res.json({ made }); });

  /* ===== loyalty tiers ===== */
  const prevMember = h.memberDiscount;
  h.memberDiscount = (customerId, subtotal) => {
    const m = prevMember?.(customerId, subtotal) || null;
    const t = tierFor(customerId);
    const tc = t?.tier?.pct ? { cents: Math.round(subtotal * t.tier.pct / 100), pct: t.tier.pct, plan: `${t.tier.name} tier` } : null;
    if (!m) return tc; if (!tc) return m; return tc.pct > m.pct ? tc : m;
  };
  app.get('/api/c/tier', publicLimiter, (req, res) => { const c = customerFromReq(req); const tiers = parseJ(getSettings().loyalty_tiers, []); res.json({ tiers: tiers.map((t) => ({ name: t.name, minCents: t.minCents, pct: t.pct, perk: t.perk })), me: c ? tierFor(c.id) : null }); });
  staff.get('/customers/:id/tier', (req, res) => res.json(tierFor(idParam(req))));

  /* ===== call server ===== */
  const tableByToken = (t) => (/^[A-Za-z0-9_-]{16}$/.test(t || '') ? db.prepare('SELECT * FROM tables WHERE qr_token = ?').get(t) : null);
  const KINDS = { server: 'needs their server', check: 'wants the check', water: 'would like water', help: 'needs help' };
  app.post('/api/t/:token/call', publicLimiter, wrap(async (req, res) => {
    const b = parse(z.object({ kind: z.enum(Object.keys(KINDS)) }), req.body);
    const t = tableByToken(req.params.token); if (!t) throw err('This table code is not valid', 404);
    if (getSettings().table_calls !== '1') throw err('Please wave to your server.', 403);
    const recent = db.prepare("SELECT id FROM table_calls WHERE table_id = ? AND kind = ? AND ack_at IS NULL AND at > datetime('now','-2 minutes')").get(t.id, b.kind);
    if (recent) return res.json({ ok: true, already: true });
    db.prepare('INSERT INTO table_calls (table_id, kind) VALUES (?, ?)').run(t.id, b.kind);
    const label = `${getSettings().unit_label} ${t.label}`;
    io.to('staff').emit('security', { type: 'call', detail: `${label} ${KINDS[b.kind]}` });
    const payload = { title: `${label} ${KINDS[b.kind]}`, body: 'Tap to open the floor.', tag: `call-${t.id}`, url: '/floor' };
    if (t.server_id) await pushToUsers(['staff', 'manager', 'owner'], payload, t.server_id).catch(() => {}); else await pushToUsers(['staff', 'manager', 'owner'], payload).catch(() => {});
    notifyStaff('tables'); res.json({ ok: true });
  }));
  staff.get('/table-calls', (req, res) => res.json(db.prepare("SELECT c.*, t.label FROM table_calls c JOIN tables t ON t.id = c.table_id WHERE c.ack_at IS NULL AND c.at > datetime('now','-2 hours') ORDER BY c.id").all()));
  staff.post('/table-calls/:id/ack', (req, res) => { db.prepare("UPDATE table_calls SET ack_at = datetime('now'), ack_by = ? WHERE id = ? OR (table_id = (SELECT table_id FROM table_calls WHERE id = ?) AND ack_at IS NULL)").run(req.user.id, idParam(req), idParam(req)); notifyStaff('tables'); res.json({ ok: true }); });

  /* ===== weekly owner report ===== */
  staff.get('/weekly-report', owner, (req, res) => { const w = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : lastMonday(); const r = weeklyReport(w); res.json({ ...r, text: reportText(r) }); });
  async function sendReport(week) {
    const s = getSettings(); const r = weeklyReport(week); const text = reportText(r); const to = (s.report_email || '').split(',').map((x) => x.trim()).filter(Boolean);
    let emailed = 0;
    if (to.length && emailEnabled()) for (const addr of to) { const x = await emailGuest(addr, { businessName: s.business_name, subject: `${s.business_name}: weekly report, ${r.from} to ${r.to}`, message: text, accent: s.accent, button: 'Open the command center', link: process.env.PUBLIC_URL || '' }).catch(() => ({ ok: false })); if (x?.ok) emailed += 1; }
    await pushToUsers(['owner'], { title: `${s.business_name}: last week ${fmt(r.now.salesCents)}`, body: `${r.changePct !== null ? `${r.changePct >= 0 ? '+' : ''}${r.changePct}% vs the week before. ` : ''}Labor ${r.now.laborPct ?? 'n/a'}%. Tap for the full report.`, tag: 'weekly', url: '/report' }).catch(() => {});
    return { emailed, text };
  }
  staff.post('/weekly-report/send', owner, wrap(async (req, res) => { const w = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.week || '') ? req.body.week : lastMonday(); const r = await sendReport(w); audit(req.user, 'report.weekly', w, clientIp(req)); res.json(r); }));

  /* ===== languages ===== */
  app.get('/api/public/langs', publicLimiter, (req, res) => { const on = parseJ(getSettings().languages, ['en', 'es']).filter((l) => LANGS[l]); res.json(on.map((code) => ({ code, name: LANGS[code] }))); });

  /* ===== supplier bills ===== */
  const billSchema = z.object({ supplierId: z.number().int(), poId: z.number().int().nullable().optional(), number: z.string().trim().max(40).optional(), billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amountCents: z.number().int().min(1).max(100_000_000), category: z.enum(['food', 'drinks', 'supplies', 'equipment', 'rent', 'utilities', 'services', 'other']).default('food'), note: z.string().trim().max(300).optional() });
  staff.get('/supplier-bills', owner, (req, res) => {
    const status = ['open', 'paid', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const list = db.prepare(`SELECT * FROM supplier_bills ${status === 'all' ? "WHERE status <> 'void'" : 'WHERE status = ?'} ORDER BY due_date, id LIMIT 300`).all(...(status === 'all' ? [] : [status])).map(billView);
    const open = db.prepare("SELECT * FROM supplier_bills WHERE status = 'open'").all().map(billView);
    const aging = { current: 0, d1_30: 0, d31_60: 0, d60: 0 };
    for (const b of open) { if (!b.overdueDays) aging.current += b.owedCents; else if (b.overdueDays <= 30) aging.d1_30 += b.owedCents; else if (b.overdueDays <= 60) aging.d31_60 += b.owedCents; else aging.d60 += b.owedCents; }
    const dueWeek = open.filter((b) => b.due_date <= addDays(localToday(), 7)).reduce((a, b) => a + b.owedCents, 0);
    const unbilled = db.prepare("SELECT p.id, p.received_at, s.name supplier, p.supplier_id FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.status = 'received' AND NOT EXISTS (SELECT 1 FROM supplier_bills b WHERE b.po_id = p.id AND b.status <> 'void') ORDER BY p.received_at DESC LIMIT 20").all().map((p) => ({ ...p, totalCents: poTotal(p.id) }));
    res.json({ bills: list, aging, owedCents: open.reduce((a, b) => a + b.owedCents, 0), dueWeekCents: dueWeek, unbilled, suppliers: db.prepare('SELECT id, name, terms_days FROM suppliers WHERE active = 1 ORDER BY name').all() });
  });
  staff.post('/supplier-bills', owner, (req, res) => {
    const b = parse(billSchema, req.body);
    if (b.dueDate < b.billDate) throw err('The due date is before the bill date');
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(b.supplierId)) throw err('Pick a supplier');
    if (b.number && db.prepare("SELECT 1 FROM supplier_bills WHERE supplier_id = ? AND number = ? AND status <> 'void'").get(b.supplierId, b.number)) throw err(`Bill ${b.number} from this supplier is already entered`, 409);
    const id = db.prepare('INSERT INTO supplier_bills (supplier_id, po_id, number, bill_date, due_date, amount_cents, category, note, created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(b.supplierId, b.poId ?? null, b.number || null, b.billDate, b.dueDate, b.amountCents, b.category, b.note || null, req.user.id).lastInsertRowid;
    audit(req.user, 'bill.add', `${fmt(b.amountCents)} due ${b.dueDate}`, clientIp(req)); notifyStaff('bills'); res.json({ id });
  });
  staff.put('/supplier-bills/:id', owner, (req, res) => { const b = parse(billSchema, req.body); db.prepare("UPDATE supplier_bills SET supplier_id=?, po_id=?, number=?, bill_date=?, due_date=?, amount_cents=?, category=?, note=? WHERE id=? AND status <> 'void'").run(b.supplierId, b.poId ?? null, b.number || null, b.billDate, b.dueDate, b.amountCents, b.category, b.note || null, idParam(req)); notifyStaff('bills'); res.json({ ok: true }); });
  staff.post('/supplier-bills/:id/pay', owner, (req, res) => {
    const b = parse(z.object({ amountCents: z.number().int().min(1).max(100_000_000), method: z.enum(['ach', 'check', 'card', 'cash', 'zelle', 'other']), reference: z.string().trim().max(60).optional(), paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body);
    const bill = db.prepare("SELECT * FROM supplier_bills WHERE id = ? AND status = 'open'").get(idParam(req)); if (!bill) throw err('This bill is not open', 409);
    const v = billView(bill); if (b.amountCents > v.owedCents) throw err(`Only ${fmt(v.owedCents)} is owed on this bill`);
    db.transaction(() => {
      db.prepare('INSERT INTO bill_payments (bill_id, amount_cents, method, reference, paid_on, user_id) VALUES (?,?,?,?,?,?)').run(bill.id, b.amountCents, b.method, b.reference || null, b.paidOn, req.user.id);
      if (b.amountCents === v.owedCents) db.prepare("UPDATE supplier_bills SET status = 'paid', paid_at = datetime('now') WHERE id = ?").run(bill.id);
      if (b.method === 'cash') { const cs = db.prepare('SELECT id FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get(); if (cs) db.prepare("INSERT INTO cash_moves (session_id, kind, amount_cents, reason, user_id) VALUES (?, 'out', ?, ?, ?)").run(cs.id, b.amountCents, `Paid ${v.supplier} bill ${bill.number || bill.id}`, req.user.id); }
    })();
    audit(req.user, 'bill.pay', `${v.supplier} ${fmt(b.amountCents)} ${b.method}`, clientIp(req)); notifyStaff('bills'); notifyStaff('cash'); res.json({ ok: true });
  });
  staff.post('/supplier-bills/:id/void', owner, (req, res) => { const r = db.prepare("UPDATE supplier_bills SET status = 'void' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM bill_payments p WHERE p.bill_id = supplier_bills.id)").run(idParam(req)); if (!r.changes) throw err('A bill with payments cannot be voided', 409); audit(req.user, 'bill.void', `#${req.params.id}`, clientIp(req)); notifyStaff('bills'); res.json({ ok: true }); });
  staff.put('/supplier-bills/:id/photo', owner, (req, res) => {
    const { dataUrl } = parse(z.object({ dataUrl: z.string().max(1_400_000) }), req.body);
    const m = /^data:(image\/(png|jpeg|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl); if (!m) throw err('Upload a photo or a PDF');
    const buf = Buffer.from(m[3], 'base64');
    const sig = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46], undefined: [0x25, 0x50, 0x44, 0x46] }[m[2]];
    if (buf.length > 1_000_000 || !sig.every((x, i) => buf[i] === x)) throw err('That file is not valid (max 1 MB)');
    const id = idParam(req);
    db.prepare("INSERT INTO assets (key, mime, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=datetime('now')").run(`bill:${id}`, m[1], buf);
    db.prepare('UPDATE supplier_bills SET photo_version = ? WHERE id = ?').run(String(Date.now()), id); notifyStaff('bills'); res.json({ ok: true });
  });
  staff.get('/supplier-bills/:id/photo', owner, (req, res) => { const a = db.prepare('SELECT mime, data FROM assets WHERE key = ?').get(`bill:${idParam(req)}`); if (!a) return res.status(404).end(); res.set('Content-Type', a.mime).set('Cache-Control', 'private, max-age=3600').send(a.data); });
  staff.get('/supplier-bills.csv', owner, (req, res) => {
    const rows = db.prepare("SELECT * FROM supplier_bills WHERE status <> 'void' ORDER BY bill_date").all().map(billView);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="supplier-bills.csv"')
      .send(['Supplier,Bill number,Bill date,Due date,Category,Amount,Paid,Owed,Status', ...rows.map((b) => [q(b.supplier), q(b.number), b.bill_date, b.due_date, b.category, (b.amount_cents / 100).toFixed(2), (b.paidCents / 100).toFixed(2), (b.owedCents / 100).toFixed(2), b.status].join(','))].join('\n'));
  });
  staff.put('/suppliers/:id/terms', owner, (req, res) => { const b = parse(z.object({ days: z.number().int().min(0).max(180) }), req.body); db.prepare('UPDATE suppliers SET terms_days = ? WHERE id = ?').run(b.days, idParam(req)); res.json({ ok: true }); });

  /* ===== jobs ===== */
  setInterval(() => forEachLocation(async () => {
    const s = getSettings(); const today = localToday(); const name = s.business_name; const hm = localHM();
    // equipment service due / overdue, once a day after 9am
    if (hm >= '09:00' && once(`eq:${today}`)) {
      const due = db.prepare('SELECT * FROM equipment WHERE active = 1 AND service_every_days IS NOT NULL AND last_service IS NOT NULL').all().map(eqView).filter((e) => e.dueInDays !== null && e.dueInDays <= 7);
      if (due.length) await pushToUsers(['manager', 'owner'], { title: `${name}: equipment service ${due.some((e) => e.dueInDays < 0) ? 'overdue' : 'due soon'}`, body: due.slice(0, 3).map((e) => `${e.name} ${e.dueInDays < 0 ? `${-e.dueInDays} days overdue` : e.dueInDays === 0 ? 'today' : `in ${e.dueInDays} days`}`).join(', '), tag: 'equipment', url: '/equipment' }).catch(() => {});
      // supplier bills due in 3 days or overdue
      const bills = db.prepare("SELECT * FROM supplier_bills WHERE status = 'open' AND due_date <= ?").all(addDays(today, 3)).map(billView).filter((b) => b.owedCents > 0);
      if (bills.length) await pushToUsers(['owner'], { title: `${name}: ${bills.length} supplier bill${bills.length === 1 ? '' : 's'} due`, body: bills.slice(0, 3).map((b) => `${b.supplier} ${fmt(b.owedCents)} ${b.overdueDays ? `(${b.overdueDays} days late)` : `due ${b.due_date}`}`).join(', '), tag: 'bills', url: '/bills' }).catch(() => {});
    }
    // auto reorder, at most every 2 hours during the day
    if (s.auto_reorder === '1' && hm >= '06:00' && hm <= '22:00' && once(`ar:${today}:${Math.floor(Number(hm.slice(0, 2)) / 2)}`)) autoReorder();
    // weekly owner report on Monday at the chosen hour
    if (s.weekly_report === '1' && localDow() === 1 && Number(hm.slice(0, 2)) >= Number(s.weekly_report_hour || 8) && once(`wr:${today}`)) await sendReport(lastMonday());
    // stale table calls clear themselves
    db.prepare("UPDATE table_calls SET ack_at = datetime('now') WHERE ack_at IS NULL AND at < datetime('now','-30 minutes')").run();
  }), 60_000).unref();
}
