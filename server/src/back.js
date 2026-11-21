// Round 5, batch G: recipes and food cost, suppliers and purchase orders, payroll export with overtime and break alerts.
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentTz, forEachLocation } from './db.js';
import { orderHooks } from './commerce.js';
import { pushToUsers, emailEnabled, emailGuest } from './notify.js';
import { dayBounds } from './ops.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, phone TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'each', cost_cents REAL NOT NULL DEFAULT 0,
  stock REAL, low REAL NOT NULL DEFAULT 0, par REAL, supplier_id INTEGER, low_alerted INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS item_recipes (
  item_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL, qty REAL NOT NULL, PRIMARY KEY (item_id, ingredient_id)
);
CREATE TABLE IF NOT EXISTS ingredient_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER NOT NULL, delta REAL NOT NULL, reason TEXT, order_id INTEGER, user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ing_moves ON ingredient_moves(ingredient_id, at);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','received','cancelled')),
  notes TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, received_at TEXT
);
CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, po_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL, qty REAL NOT NULL, cost_cents REAL NOT NULL DEFAULT 0, received_qty REAL
);
CREATE TABLE IF NOT EXISTS labor_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/* ---------- ingredient stock follows sales ---------- */
function lowCheck(ingId) {
  const g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ingId);
  if (!g || g.stock === null) return;
  if (g.stock <= g.low && !g.low_alerted) {
    db.prepare('UPDATE ingredients SET low_alerted = 1 WHERE id = ?').run(g.id);
    pushToUsers(['manager', 'owner'], { title: `${getSettings().business_name}: running low`, body: `${g.name} is down to ${round(g.stock)} ${g.unit}. Add it to a supplier order.`, tag: `ing-${g.id}`, url: '/purchasing' }).catch(() => {});
  } else if (g.stock > g.low && g.low_alerted) db.prepare('UPDATE ingredients SET low_alerted = 0 WHERE id = ?').run(g.id);
}
orderHooks.inserted.push((orderId, lines, userId) => {
  const rec = db.prepare('SELECT r.ingredient_id, r.qty FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ? AND g.stock IS NOT NULL');
  const touched = new Set();
  for (const l of lines) for (const r of rec.all(l.item_id)) {
    const d = -(r.qty * l.qty);
    db.prepare('UPDATE ingredients SET stock = stock + ? WHERE id = ?').run(d, r.ingredient_id);
    db.prepare("INSERT INTO ingredient_moves (ingredient_id, delta, reason, order_id, user_id) VALUES (?, ?, 'sale', ?, ?)").run(r.ingredient_id, d, orderId, userId || null);
    touched.add(r.ingredient_id);
  }
  touched.forEach(lowCheck);
});
orderHooks.voided.push((orderId, userId) => {
  for (const m of db.prepare("SELECT ingredient_id, SUM(delta) d FROM ingredient_moves WHERE order_id = ? GROUP BY ingredient_id").all(orderId)) {
    if (!m.d) continue;
    db.prepare('UPDATE ingredients SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL').run(m.d, m.ingredient_id);
    db.prepare("INSERT INTO ingredient_moves (ingredient_id, delta, reason, order_id, user_id) VALUES (?, ?, 'void', ?, ?)").run(m.ingredient_id, -m.d, orderId, userId || null);
    lowCheck(m.ingredient_id);
  }
});

/* ---------- payroll ---------- */
const localDate = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: currentTz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(`${ts.replace(' ', 'T')}Z`));
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekStartOf = (date, startDow) => { const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); return addDays(date, -((dow - startDow + 7) % 7)); };
const nowTs = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const hoursOf = (s) => Math.max(0, (Date.parse(`${(s.clock_out || nowTs()).replace(' ', 'T')}Z`) - Date.parse(`${s.clock_in.replace(' ', 'T')}Z`)) / 3600000 - (s.break_minutes || 0) / 60);

export function payroll(from, to) {
  const s = getSettings(); const otAt = Number(s.ot_weekly_hours) || 40; const startDow = Number(s.payroll_week_start) || 1;
  // load whole weeks so overtime is counted correctly at the edges of the pay period
  const wkFrom = weekStartOf(from, startDow);
  const rows = db.prepare('SELECT s.*, u.name, u.role, u.hourly_cents FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in >= ? AND s.clock_in < ? ORDER BY s.clock_in').all(dayBounds(wkFrom).start, dayBounds(to).end);
  const people = new Map();
  const weekHours = new Map();
  for (const r of rows) {
    const d = localDate(r.clock_in); const wk = weekStartOf(d, startDow);
    const hrs = hoursOf(r); const key = `${r.user_id}|${wk}`;
    const before = weekHours.get(key) || 0; weekHours.set(key, before + hrs);
    if (d < from || d > to) continue;
    const ot = Math.max(0, before + hrs - otAt) - Math.max(0, before - otAt);
    const p = people.get(r.user_id) || { userId: r.user_id, name: r.name, role: r.role, rateCents: r.hourly_cents, regular: 0, overtime: 0, shifts: 0, openShift: false, noBreak: 0, declared: 0 };
    p.declared += r.declared_tips_cents || 0;
    p.regular += hrs - ot; p.overtime += ot; p.shifts += 1; if (!r.clock_out) p.openShift = true;
    if (hrs > (Number(s.break_after_hours) || 6) && !r.break_minutes) p.noBreak += 1;
    people.set(r.user_id, p);
  }
  const tips = db.prepare('SELECT user_id, SUM(cents) c FROM tip_payouts WHERE period_to >= ? AND period_from <= ? GROUP BY user_id').all(from, to);
  const tipMap = Object.fromEntries(tips.map((t) => [t.user_id, t.c]));
  const out = [...people.values()].map((p) => {
    const reg = round(p.regular); const ot = round(p.overtime);
    const regPay = Math.round(reg * p.rateCents); const otPay = Math.round(ot * p.rateCents * 1.5);
    return { ...p, declaredTipsCents: p.declared, regular: reg, overtime: ot, regularPayCents: regPay, overtimePayCents: otPay, tipsCents: tipMap[p.userId] || 0, grossCents: regPay + otPay + (tipMap[p.userId] || 0) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { from, to, overtimeAfter: otAt, people: out, totals: out.reduce((t, p) => ({ hours: round(t.hours + p.regular + p.overtime), overtime: round(t.overtime + p.overtime), grossCents: t.grossCents + p.grossCents, tipsCents: t.tipsCents + p.tipsCents }), { hours: 0, overtime: 0, grossCents: 0, tipsCents: 0 }) };
}
const csvCell = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? `'${s}` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function laborAlerts() {
  const s = getSettings(); if (s.ot_alerts !== '1') return;
  const otAt = Number(s.ot_weekly_hours) || 40; const startDow = Number(s.payroll_week_start) || 1; const breakAfter = Number(s.break_after_hours) || 6;
  const today = localToday(); const wk = weekStartOf(today, startDow);
  const open = db.prepare('SELECT s.*, u.name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_out IS NULL').all();
  for (const sh of open) {
    const week = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND clock_in >= ?').all(sh.user_id, dayBounds(wk).start).reduce((a, x) => a + hoursOf(x), 0);
    const fire = async (key, title, body) => { const r = db.prepare('INSERT OR IGNORE INTO labor_alerts (key) VALUES (?)').run(key); if (r.changes) await pushToUsers(['manager', 'owner'], { title, body, tag: key, url: '/shifts' }).catch(() => {}); };
    if (week >= otAt - 2) await fire(`ot:${sh.user_id}:${wk}`, `${s.business_name}: overtime soon`, `${sh.name} has worked ${round(week, 1)} hours this week. Overtime starts at ${otAt}.`);
    if (hoursOf(sh) >= breakAfter && !sh.break_minutes) await fire(`break:${sh.id}`, `${s.business_name}: break needed`, `${sh.name} has worked ${round(hoursOf(sh), 1)} hours without a break.`);
  }
}

export function registerBack({ app, staff, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, notifyStaff } = h;
  const mgr = requireAuth('manager');

  /* ================= Ingredients and recipes ================= */
  const ingSchema = z.object({
    name: z.string().trim().min(1).max(60), unit: z.string().trim().min(1).max(12), costCents: z.number().min(0).max(1000000),
    low: z.number().min(0).max(1e6).default(0), par: z.number().min(0).max(1e6).nullable().optional(), supplierId: z.number().int().nullable().optional(), track: z.boolean().default(true),
  });
  function ingRows() {
    const used7 = Object.fromEntries(db.prepare("SELECT ingredient_id, -SUM(delta) u FROM ingredient_moves WHERE reason = 'sale' AND at > datetime('now','-7 days') GROUP BY ingredient_id").all().map((r) => [r.ingredient_id, r.u]));
    return db.prepare('SELECT g.*, s.name supplier FROM ingredients g LEFT JOIN suppliers s ON s.id = g.supplier_id WHERE g.active = 1 ORDER BY g.name').all().map((g) => {
      const per = (used7[g.id] || 0) / 7;
      return { ...g, lowMark: g.low, stock: g.stock === null ? null : round(g.stock), used7: round(used7[g.id] || 0), daysLeft: g.stock !== null && per > 0 ? Math.max(0, Math.floor(g.stock / per)) : null, low: g.stock !== null && g.stock <= g.low };
    });
  }
  function costing() {
    const items = db.prepare('SELECT id, name, category, price_cents FROM menu_items WHERE active = 1 ORDER BY category, name').all();
    const rec = db.prepare('SELECT r.ingredient_id, r.qty, g.name, g.unit, g.cost_cents FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ?');
    const sold = Object.fromEntries(db.prepare("SELECT oi.item_id, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.paid_at > datetime('now','-30 days') AND o.status <> 'void' GROUP BY oi.item_id").all().map((r) => [r.item_id, r.n]));
    return items.map((m) => {
      const lines = rec.all(m.id).map((r) => ({ ingredientId: r.ingredient_id, name: r.name, unit: r.unit, qty: r.qty, costCents: round(r.qty * r.cost_cents, 1) }));
      const cost = Math.round(lines.reduce((a, l) => a + l.costCents, 0));
      return { id: m.id, name: m.name, category: m.category, priceCents: m.price_cents, costCents: cost, costPct: lines.length && m.price_cents ? round((cost / m.price_cents) * 100, 1) : null, profitCents: m.price_cents - cost, sold30: sold[m.id] || 0, lines };
    });
  }
  staff.get('/ingredients', mgr, (req, res) => {
    const items = costing(); const withRecipe = items.filter((i) => i.lines.length);
    const sales = withRecipe.reduce((a, i) => a + i.sold30 * i.priceCents, 0); const cost = withRecipe.reduce((a, i) => a + i.sold30 * i.costCents, 0);
    res.json({ ingredients: ingRows(), items, suppliers: db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name').all(), foodCostPct: sales ? round((cost / sales) * 100, 1) : null, target: Number(getSettings().food_cost_target) || 30 });
  });
  staff.post('/ingredients', mgr, (req, res) => {
    const b = parse(ingSchema, req.body);
    const id = db.prepare('INSERT INTO ingredients (name, unit, cost_cents, stock, low, par, supplier_id) VALUES (?,?,?,?,?,?,?)').run(b.name, b.unit, b.costCents, b.track ? 0 : null, b.low, b.par ?? null, b.supplierId || null).lastInsertRowid;
    audit(req.user, 'ingredient.add', b.name, clientIp(req)); notifyStaff('menu'); res.json({ id });
  });
  staff.put('/ingredients/:id', mgr, (req, res) => {
    const b = parse(ingSchema.partial(), req.body); const id = idParam(req);
    const g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id); if (!g) throw err('Not found', 404);
    db.prepare('UPDATE ingredients SET name=?, unit=?, cost_cents=?, low=?, par=?, supplier_id=?, stock=? WHERE id=?').run(b.name ?? g.name, b.unit ?? g.unit, b.costCents ?? g.cost_cents, b.low ?? g.low, b.par === undefined ? g.par : b.par, b.supplierId === undefined ? g.supplier_id : b.supplierId, b.track === false ? null : g.stock === null && b.track ? 0 : g.stock, id);
    notifyStaff('menu'); res.json({ ok: true });
  });
  staff.delete('/ingredients/:id', mgr, (req, res) => {
    const id = idParam(req); db.prepare('UPDATE ingredients SET active = 0 WHERE id = ?').run(id); db.prepare('DELETE FROM item_recipes WHERE ingredient_id = ?').run(id);
    notifyStaff('menu'); res.json({ ok: true });
  });
  staff.post('/ingredients/:id/count', mgr, (req, res) => {
    const { qty, mode } = parse(z.object({ qty: z.number().min(-1e6).max(1e6), mode: z.enum(['set', 'add', 'waste']) }), req.body);
    const g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(idParam(req)); if (!g) throw err('Not found', 404);
    const cur = g.stock ?? 0; const next = mode === 'set' ? qty : mode === 'add' ? cur + qty : cur - Math.abs(qty);
    db.prepare('UPDATE ingredients SET stock = ? WHERE id = ?').run(next, g.id);
    db.prepare('INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?, ?, ?, ?)').run(g.id, next - cur, mode === 'set' ? 'count' : mode === 'waste' ? 'waste' : 'added', req.user.id);
    lowCheck(g.id); audit(req.user, `ingredient.${mode}`, `${g.name}: ${round(cur)} → ${round(next)} ${g.unit}`, clientIp(req));
    notifyStaff('menu'); res.json({ ok: true, stock: round(next) });
  });
  staff.put('/recipes/:itemId', mgr, (req, res) => {
    const itemId = Number(req.params.itemId); if (!Number.isInteger(itemId)) throw err('Bad item');
    const { lines } = parse(z.object({ lines: z.array(z.object({ ingredientId: z.number().int(), qty: z.number().positive().max(10000) })).max(40) }), req.body);
    db.transaction(() => {
      db.prepare('DELETE FROM item_recipes WHERE item_id = ?').run(itemId);
      const ins = db.prepare('INSERT OR REPLACE INTO item_recipes (item_id, ingredient_id, qty) VALUES (?, ?, ?)');
      for (const l of lines) ins.run(itemId, l.ingredientId, l.qty);
    })();
    audit(req.user, 'recipe.save', `item ${itemId}: ${lines.length} ingredients`, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
  });

  /* ================= Suppliers and purchase orders ================= */
  const supSchema = z.object({ name: z.string().trim().min(1).max(60), email: z.string().trim().email().max(120).optional().or(z.literal('')), phone: z.string().trim().max(30).optional(), notes: z.string().trim().max(200).optional() });
  staff.post('/suppliers', mgr, (req, res) => { const b = parse(supSchema, req.body); const id = db.prepare('INSERT INTO suppliers (name, email, phone, notes) VALUES (?,?,?,?)').run(b.name, b.email || null, b.phone || null, b.notes || null).lastInsertRowid; audit(req.user, 'supplier.add', b.name, clientIp(req)); res.json({ id }); });
  staff.put('/suppliers/:id', mgr, (req, res) => { const b = parse(supSchema, req.body); db.prepare('UPDATE suppliers SET name=?, email=?, phone=?, notes=? WHERE id=?').run(b.name, b.email || null, b.phone || null, b.notes || null, idParam(req)); res.json({ ok: true }); });
  staff.delete('/suppliers/:id', mgr, (req, res) => { db.prepare('UPDATE suppliers SET active = 0 WHERE id = ?').run(idParam(req)); res.json({ ok: true }); });

  function poView(po) {
    const lines = db.prepare('SELECT l.*, g.name, g.unit FROM po_lines l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.po_id = ?').all(po.id);
    const sup = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(po.supplier_id);
    return { ...po, supplier: sup, lines: lines.map((l) => ({ ...l, lineCents: Math.round(l.qty * l.cost_cents) })), totalCents: Math.round(lines.reduce((a, l) => a + l.qty * l.cost_cents, 0)) };
  }
  staff.get('/purchase-orders', mgr, (req, res) => {
    const list = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC LIMIT 50').all().map(poView);
    // suggestion: everything at or under its low mark, ordered up to par (or 3× low)
    const sugg = db.prepare('SELECT * FROM ingredients WHERE active = 1 AND stock IS NOT NULL AND stock <= low').all().map((g) => ({ ingredientId: g.id, name: g.name, unit: g.unit, supplierId: g.supplier_id, stock: round(g.stock), qty: round(Math.max(1, (g.par ?? g.low * 3) - g.stock)), costCents: g.cost_cents }));
    res.json({ orders: list, suggested: sugg, emailEnabled: emailEnabled() });
  });
  staff.post('/purchase-orders', mgr, (req, res) => {
    const b = parse(z.object({ supplierId: z.number().int(), notes: z.string().trim().max(300).optional(), lines: z.array(z.object({ ingredientId: z.number().int(), qty: z.number().positive().max(1e6), costCents: z.number().min(0).max(1e6).optional() })).min(1).max(100) }), req.body);
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ? AND active = 1').get(b.supplierId)) throw err('Pick a supplier');
    const id = db.transaction(() => {
      const pid = db.prepare('INSERT INTO purchase_orders (supplier_id, notes, created_by) VALUES (?,?,?)').run(b.supplierId, b.notes || null, req.user.id).lastInsertRowid;
      for (const l of b.lines) { const g = db.prepare('SELECT cost_cents FROM ingredients WHERE id = ?').get(l.ingredientId); if (g) db.prepare('INSERT INTO po_lines (po_id, ingredient_id, qty, cost_cents) VALUES (?,?,?,?)').run(pid, l.ingredientId, l.qty, l.costCents ?? g.cost_cents); }
      return pid;
    })();
    audit(req.user, 'po.create', `PO ${id}`, clientIp(req)); res.json(poView(db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id)));
  });
  staff.post('/purchase-orders/:id/send', mgr, wrap(async (req, res) => {
    const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ? AND status = 'draft'").get(idParam(req)); if (!po) throw err('This order was already sent', 409);
    const v = poView(po); const s = getSettings(); let emailed = false;
    if (req.body?.email && v.supplier?.email && emailEnabled()) {
      const text = v.lines.map((l) => `${round(l.qty)} ${l.unit} ${l.name}`).join('\n');
      const r = await emailGuest(v.supplier.email, { businessName: s.business_name, subject: `Order ${po.id} from ${s.business_name}`, message: `Hello ${v.supplier.name},\n\nPlease send:\n${text}${po.notes ? `\n\nNotes: ${po.notes}` : ''}\n\nThank you.`, link: process.env.PUBLIC_URL || '', accent: s.accent, button: s.business_name }).catch(() => ({ ok: false }));
      emailed = r.ok;
    }
    db.prepare("UPDATE purchase_orders SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(po.id);
    audit(req.user, 'po.send', `PO ${po.id}${emailed ? ' emailed' : ''}`, clientIp(req)); res.json({ ok: true, emailed });
  }));
  staff.post('/purchase-orders/:id/receive', mgr, (req, res) => {
    const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ? AND status IN ('draft','sent')").get(idParam(req)); if (!po) throw err('This order is already closed', 409);
    const { lines } = parse(z.object({ lines: z.array(z.object({ lineId: z.number().int(), qty: z.number().min(0).max(1e6), costCents: z.number().min(0).max(1e6) })) }), req.body);
    db.transaction(() => {
      for (const l of lines) {
        const row = db.prepare('SELECT * FROM po_lines WHERE id = ? AND po_id = ?').get(l.lineId, po.id); if (!row) continue;
        db.prepare('UPDATE po_lines SET received_qty = ?, cost_cents = ? WHERE id = ?').run(l.qty, l.costCents, row.id);
        if (l.qty > 0) {
          db.prepare('UPDATE ingredients SET stock = COALESCE(stock, 0) + ?, cost_cents = ? WHERE id = ?').run(l.qty, l.costCents, row.ingredient_id);
          db.prepare("INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?, ?, ?, ?)").run(row.ingredient_id, l.qty, `received PO ${po.id}`, req.user.id);
          lowCheck(row.ingredient_id);
          h.onReceive?.(row.ingredient_id, l.qty, `PO ${po.id}`);
        }
      }
      db.prepare("UPDATE purchase_orders SET status = 'received', received_at = datetime('now') WHERE id = ?").run(po.id);
    })();
    audit(req.user, 'po.receive', `PO ${po.id}`, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
  });
  staff.post('/purchase-orders/:id/cancel', mgr, (req, res) => {
    db.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ? AND status IN ('draft','sent')").run(idParam(req)); res.json({ ok: true });
  });

  /* ================= Payroll ================= */
  staff.get('/payroll', requireAuth('owner'), (req, res) => {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const to = ok(req.query.to) ? req.query.to : localToday(); const from = ok(req.query.from) ? req.query.from : addDays(to, -13);
    if (to < from) throw err('The end date is before the start date');
    const p = payroll(from, to);
    if (req.query.format === 'gusto' || req.query.format === 'adp') {
      audit(req.user, 'payroll.export', `${req.query.format} ${from}..${to}`, clientIp(req));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${req.query.format}-hours-${from}-to-${to}.csv"`);
      return res.send(h.payrollFile(p, req.query.format));
    }
    if (req.query.format === 'csv') {
      const head = ['Name', 'Role', 'Shifts', 'Regular hours', 'Overtime hours', 'Hourly rate', 'Regular pay', 'Overtime pay', 'Tips paid', 'Cash tips declared', 'Gross'];
      const body = p.people.map((x) => [x.name, x.role, x.shifts, x.regular, x.overtime, (x.rateCents / 100).toFixed(2), (x.regularPayCents / 100).toFixed(2), (x.overtimePayCents / 100).toFixed(2), (x.tipsCents / 100).toFixed(2), (x.declaredTipsCents / 100).toFixed(2), (x.grossCents / 100).toFixed(2)]);
      audit(req.user, 'payroll.export', `${from}..${to}`, clientIp(req));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="payroll-${from}-to-${to}.csv"`);
      return res.send([head, ...body].map((r) => r.map(csvCell).join(',')).join('\n'));
    }
    res.json(p);
  });

  setInterval(() => forEachLocation(() => laborAlerts().catch((e) => console.error('labor alerts', e.message))), 10 * 60_000).unref();
}
