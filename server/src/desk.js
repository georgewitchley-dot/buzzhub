// Round 12: allergen chart, seating rotation, delivery credits, sales tax report, stock transfers between locations,
// staff certificates, cash flow forecast, delivery zones, catering follow-up.
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, currentTz, forEachLocation, runIn, listLocations, locationExists } from './db.js';
import { pushToUsers, emailEnabled, emailGuest } from './notify.js';
import { dayBounds } from './ops.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS supplier_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, po_id INTEGER, amount_cents INTEGER NOT NULL, reason TEXT NOT NULL, items TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','void')), bill_id INTEGER, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), applied_at TEXT
);
CREATE TABLE IF NOT EXISTS stock_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL CHECK (direction IN ('out','in')), other_slug TEXT NOT NULL, other_name TEXT, lines TEXT NOT NULL, note TEXT,
  user_name TEXT, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, number TEXT, issued TEXT, expires TEXT, photo_version TEXT NOT NULL DEFAULT '0',
  verified_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS delivery_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, points TEXT NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, min_cents INTEGER NOT NULL DEFAULT 0, color TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS catering_feedback (
  invoice_id INTEGER PRIMARY KEY, rating INTEGER, comment TEXT, sent_at TEXT, responded_at TEXT
);
CREATE TABLE IF NOT EXISTS desk_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')));`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const parseJ = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const dowOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const fmt = (c) => `$${(c / 100).toFixed(2)}`;
const once = (key) => db.prepare('INSERT OR IGNORE INTO desk_alerts (key) VALUES (?)').run(key).changes > 0;
const localHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: currentTz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
export const CERT_KINDS = ['Food handler', 'Food protection manager', 'Alcohol server', 'Allergen awareness', 'First aid / CPR', 'Other'];

/* ---------- seating rotation ---------- */
export function rotation() {
  const { start } = dayBounds(localToday());
  const servers = db.prepare("SELECT DISTINCT u.id, u.name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_out IS NULL AND s.break_started IS NULL AND u.active = 1").all();
  const sections = db.prepare('SELECT id, label, seats, status, server_id FROM tables').all();
  const seats = db.prepare("SELECT t.server_id sid, COUNT(*) n, COALESCE(SUM(g.party_size),0) covers, MAX(g.seated_at) last FROM guests g JOIN tables t ON t.id = g.table_id WHERE g.seated_at >= ? AND t.server_id IS NOT NULL GROUP BY t.server_id").all(start);
  const by = Object.fromEntries(seats.map((r) => [r.sid, r]));
  const list = servers.map((u) => {
    const mine = sections.filter((t) => t.server_id === u.id);
    return { userId: u.id, name: u.name, tables: mine.length, open: mine.filter((t) => t.status === 'open').map((t) => t.label), seated: mine.filter((t) => t.status === 'seated').length,
      partiesToday: by[u.id]?.n || 0, coversToday: by[u.id]?.covers || 0, lastSeated: by[u.id]?.last || null };
  }).filter((x) => x.tables > 0);
  // next up: has an open table, then fewest seated right now, then longest since last seat, then fewest covers today
  const ranked = [...list].filter((x) => x.open.length).sort((a, b) => a.seated - b.seated || (a.lastSeated || '').localeCompare(b.lastSeated || '') || a.coversToday - b.coversToday);
  return { servers: list, nextUp: ranked[0] || null, order: ranked.map((x) => x.userId), unassignedOpen: sections.filter((t) => !t.server_id && t.status === 'open').map((t) => t.label) };
}

/* ---------- sales tax ---------- */
export function salesTax(from, to) {
  const a = dayBounds(from).start; const z2 = dayBounds(to).end;
  const tzOff = (() => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: currentTz(), timeZoneName: 'shortOffset' }).formatToParts(new Date(`${from}T12:00:00Z`)).map((x) => [x.type, x.value])); const m = /GMT([+-]\d+)(?::(\d+))?/.exec(p.timeZoneName || ''); return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 0; })();
  const rows = db.prepare(`SELECT substr(datetime(paid_at, '${tzOff} minutes'),1,7) month, COUNT(*) n, COALESCE(SUM(subtotal_cents),0) gross, COALESCE(SUM(discount_cents),0) disc,
    COALESCE(SUM(CASE WHEN tax_cents > 0 THEN subtotal_cents - discount_cents ELSE 0 END),0) taxable, COALESCE(SUM(CASE WHEN tax_cents = 0 THEN subtotal_cents - discount_cents ELSE 0 END),0) exempt,
    COALESCE(SUM(tax_cents),0) tax, COALESCE(SUM(tip_cents),0) tips, COALESCE(SUM(fee_cents),0) fees
    FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void' GROUP BY month ORDER BY month`).all(a, z2);
  let refunds = []; try { refunds = db.prepare(`SELECT substr(datetime(r.created_at, '${tzOff} minutes'),1,7) month, COALESCE(SUM(r.amount_cents),0) c FROM refunds r WHERE r.created_at >= ? AND r.created_at < ? GROUP BY month`).all(a, z2); } catch { /* none */ }
  const rf = Object.fromEntries(refunds.map((r) => [r.month, r.c]));
  let invTax = []; try { invTax = db.prepare("SELECT substr(created_at,1,7) month, COALESCE(SUM(amount_cents),0) c FROM invoice_payments WHERE created_at >= ? AND created_at < ? GROUP BY month").all(a, z2); } catch { /* none */ }
  const months = rows.map((r) => ({ month: r.month, orders: r.n, grossCents: r.gross, discountCents: r.disc, netCents: r.gross - r.disc, taxableCents: r.taxable, exemptCents: r.exempt, taxCents: r.tax, tipsCents: r.tips, feesCents: r.fees, refundsCents: rf[r.month] || 0 }));
  const sum = (k) => months.reduce((x, m) => x + m[k], 0);
  return { from, to, rate: Number(getSettings().tax_rate), months, totals: { orders: sum('orders'), grossCents: sum('grossCents'), discountCents: sum('discountCents'), netCents: sum('netCents'), taxableCents: sum('taxableCents'), exemptCents: sum('exemptCents'), taxCents: sum('taxCents'), tipsCents: sum('tipsCents'), feesCents: sum('feesCents'), refundsCents: sum('refundsCents') }, invoicePaymentsCents: invTax.reduce((x, r) => x + r.c, 0) };
}

/* ---------- cash flow ---------- */
export function cashFlow(days = 30) {
  const s = getSettings(); const today = localToday();
  const start = Number(s.cash_balance_cents || 0); const asOf = s.cash_balance_on || null;
  const hist = {}; const seen = {};
  const tzOff = (() => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: currentTz(), timeZoneName: 'shortOffset' }).formatToParts(new Date()).map((x) => [x.type, x.value])); const m = /GMT([+-]\d+)(?::(\d+))?/.exec(p.timeZoneName || ''); return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 0; })();
  for (const r of db.prepare(`SELECT substr(datetime(paid_at, '${tzOff} minutes'),1,10) d, SUM(total_cents - tip_cents) c FROM orders WHERE paid_at >= ? AND status <> 'void' GROUP BY d`).all(dayBounds(addDays(today, -56)).start)) {
    if (r.d >= today) continue; const w = dowOf(r.d); hist[w] = (hist[w] || 0) + r.c; seen[w] = (seen[w] || 0) + 1;
  }
  let rates = {}; try { rates = JSON.parse(s.fee_rates || '{}'); } catch { /* none */ }
  const feePct = (rates.card?.[0] ?? 2.6) / 100;
  const laborRow = db.prepare("SELECT COALESCE(SUM((julianday(COALESCE(s.clock_out, datetime('now'))) - julianday(s.clock_in)) * 24 * u.hourly_cents - s.break_minutes / 60.0 * u.hourly_cents),0) c FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in >= ?").get(dayBounds(addDays(today, -28)).start);
  const laborPerDay = Math.round(laborRow.c / 28);
  const sched = db.prepare("SELECT substr(s.start_local,1,10) d, SUM((julianday(replace(s.end_local,' ','T')) - julianday(replace(s.start_local,' ','T'))) * 24 * u.hourly_cents) c FROM schedule s JOIN users u ON u.id = s.user_id WHERE substr(s.start_local,1,10) BETWEEN ? AND ? GROUP BY d").all(today, addDays(today, days));
  const schedBy = Object.fromEntries(sched.map((r) => [r.d, Math.round(r.c)]));
  let bills = []; try { bills = db.prepare("SELECT b.id, b.due_date, b.amount_cents - COALESCE((SELECT SUM(amount_cents) FROM bill_payments p WHERE p.bill_id = b.id),0) owed, s.name FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.status = 'open'").all().filter((b) => b.owed > 0); } catch { /* none */ }
  const fixed = parseJ(s.fixed_costs, []).filter((f) => f.name && Number(f.cents) > 0);
  const payDow = Number(s.payroll_dow ?? 5); const payEvery = s.payroll_every === 'biweekly' ? 14 : 7;
  let bal = start; let low = { cents: start, date: today }; const out = []; let laborAcc = 0;
  for (let i = 0; i <= days; i += 1) {
    const d = addDays(today, i); const w = dowOf(d);
    const salesIn = seen[w] ? Math.round(hist[w] / seen[w] * (1 - feePct)) : 0;
    laborAcc += schedBy[d] ?? laborPerDay;
    const items = [];
    if (salesIn) items.push({ label: 'Expected sales (after card fees)', cents: salesIn });
    for (const b of bills) { const due = b.due_date < today ? today : b.due_date; if (due === d) items.push({ label: `${b.name} bill${b.due_date < today ? ' (late)' : ''}`, cents: -b.owed }); }
    for (const f of fixed) { const day = Math.min(28, Math.max(1, Number(f.day) || 1)); if (Number(d.slice(8)) === day) items.push({ label: f.name, cents: -Number(f.cents) }); }
    if (w === payDow && daysBetween('2026-01-02', d) % payEvery < 7) { items.push({ label: 'Payroll (estimated)', cents: -laborAcc }); laborAcc = 0; }
    const net = items.reduce((a, x) => a + x.cents, 0); bal += net;
    if (bal < low.cents) low = { cents: bal, date: d };
    out.push({ date: d, items, netCents: net, balanceCents: bal });
  }
  return { startCents: start, asOf, days: out, low, billsCents: bills.reduce((a, b) => a + b.owed, 0), laborPerDayCents: laborPerDay, fixed };
}

/* ---------- delivery zones ---------- */
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [yi, xi] = poly[i]; const [yj, xj] = poly[j];
    if (((yi > pt.lat) !== (yj > pt.lat)) && (pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
const geoCache = new Map();
async function geocode(address) {
  if (geoCache.has(address)) return geoCache.get(address);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`, { headers: { 'User-Agent': 'BuzzHub/1.0 (delivery zones)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(6000) });
    const j = await r.json(); const hit = j?.[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null; geoCache.set(address, hit); return hit;
  } catch { return null; }
}
export async function zoneFor(address) {
  const zones = db.prepare('SELECT * FROM delivery_zones WHERE active = 1 ORDER BY sort, id').all();
  if (!zones.length) return null; // no zones drawn: the regular delivery fee applies
  const pt = await geocode(address);
  if (!pt) return { unknown: true, error: null };
  const z2 = zones.find((z) => inside(pt, parseJ(z.points, [])));
  if (!z2) return { outside: true, error: "Sorry, that address is outside our delivery area. Pickup is available." };
  return { zone: z2.name, feeCents: z2.fee_cents, minCents: z2.min_cents, point: pt };
}

export function registerDesk({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, publicLimiter, notifyStaff, publicBase } = h;
  const mgr = requireAuth('manager'); const owner = requireAuth('owner');

  /* ===== allergen chart ===== */
  const chart = () => {
    const items = db.prepare("SELECT id, name, category, allergens, diet, price_cents FROM menu_items WHERE active = 1 ORDER BY category, sort, name").all().map((m) => ({ id: m.id, name: m.name, category: m.category, allergens: parseJ(m.allergens, []), diet: parseJ(m.diet, []), priceCents: m.price_cents }));
    const used = [...new Set(items.flatMap((i) => i.allergens))];
    return { business: getSettings().business_name, updated: localToday(), allergens: used, items, untagged: items.filter((i) => !i.allergens.length && !i.diet.length).length };
  };
  staff.get('/allergen-chart', (req, res) => res.json(chart()));
  app.get('/api/public/allergens', publicLimiter, (req, res) => { const c = chart(); res.json({ ...c, items: c.items.map(({ priceCents, ...i }) => i) }); });

  /* ===== seating rotation ===== */
  staff.get('/rotation', (req, res) => res.json(rotation()));

  /* ===== delivery credits ===== */
  const creditView = (c) => ({ ...c, supplier: db.prepare('SELECT name FROM suppliers WHERE id = ?').get(c.supplier_id)?.name || '?', items: parseJ(c.items, []) });
  staff.get('/supplier-credits', owner, (req, res) => res.json(db.prepare("SELECT * FROM supplier_credits WHERE status <> 'void' ORDER BY status = 'open' DESC, id DESC LIMIT 200").all().map(creditView)));
  staff.post('/supplier-credits', mgr, (req, res) => {
    const b = parse(z.object({ supplierId: z.number().int(), poId: z.number().int().nullable().optional(), amountCents: z.number().int().min(1).max(10_000_000), reason: z.enum(['short', 'damaged', 'wrong item', 'quality', 'price error', 'returned', 'other']),
      items: z.array(z.object({ name: z.string().trim().max(60), qty: z.number().min(0).max(100000), note: z.string().trim().max(80).optional() })).max(40).default([]), adjustStock: z.boolean().default(false) }), req.body);
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(b.supplierId)) throw err('Pick a supplier');
    const id = db.prepare('INSERT INTO supplier_credits (supplier_id, po_id, amount_cents, reason, items, created_by) VALUES (?,?,?,?,?,?)').run(b.supplierId, b.poId ?? null, b.amountCents, b.reason, JSON.stringify(b.items), req.user.id).lastInsertRowid;
    if (b.adjustStock) for (const it of b.items) { const g = db.prepare('SELECT id, stock FROM ingredients WHERE lower(name) = lower(?)').get(it.name); if (g && g.stock !== null && it.qty > 0) { db.prepare('UPDATE ingredients SET stock = stock - ? WHERE id = ?').run(it.qty, g.id); db.prepare('INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?,?,?,?)').run(g.id, -it.qty, `credit: ${b.reason}`, req.user.id); } }
    // apply automatically to the open bill for the same delivery, if there is one
    const bill = b.poId ? db.prepare("SELECT id FROM supplier_bills WHERE po_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(b.poId) : null;
    if (bill) applyCredit(id, bill.id, req.user);
    audit(req.user, 'credit.add', `${fmt(b.amountCents)} ${b.reason}`, clientIp(req)); notifyStaff('bills'); res.json({ id, appliedTo: bill?.id || null });
  });
  function applyCredit(creditId, billId, user) {
    const c = db.prepare("SELECT * FROM supplier_credits WHERE id = ? AND status = 'open'").get(creditId); if (!c) throw err('This credit is already used', 409);
    const bill = db.prepare("SELECT * FROM supplier_bills WHERE id = ? AND status = 'open' AND supplier_id = ?").get(billId, c.supplier_id); if (!bill) throw err('Pick an open bill from the same supplier', 409);
    const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) c FROM bill_payments WHERE bill_id = ?').get(bill.id).c; const owed = bill.amount_cents - paid;
    const use = Math.min(owed, c.amount_cents);
    db.transaction(() => {
      db.prepare("INSERT INTO bill_payments (bill_id, amount_cents, method, reference, paid_on, user_id) VALUES (?, ?, 'credit', ?, ?, ?)").run(bill.id, use, `Credit #${c.id} (${c.reason})`, localToday(), user?.id || null);
      if (use >= owed) db.prepare("UPDATE supplier_bills SET status = 'paid', paid_at = datetime('now') WHERE id = ?").run(bill.id);
      if (use < c.amount_cents) { db.prepare('UPDATE supplier_credits SET amount_cents = amount_cents - ? WHERE id = ?').run(use, c.id); db.prepare('INSERT INTO supplier_credits (supplier_id, po_id, amount_cents, reason, items, status, bill_id, created_by, applied_at) VALUES (?,?,?,?,?,?,?,?, datetime(\'now\'))').run(c.supplier_id, c.po_id, use, c.reason, c.items, 'applied', bill.id, user?.id || null); }
      else db.prepare("UPDATE supplier_credits SET status = 'applied', bill_id = ?, applied_at = datetime('now') WHERE id = ?").run(bill.id, c.id);
    })();
    return use;
  }
  staff.post('/supplier-credits/:id/apply', owner, (req, res) => { const b = parse(z.object({ billId: z.number().int() }), req.body); const used = applyCredit(idParam(req), b.billId, req.user); audit(req.user, 'credit.apply', `#${req.params.id} → bill ${b.billId} ${fmt(used)}`, clientIp(req)); notifyStaff('bills'); res.json({ ok: true, usedCents: used }); });
  staff.post('/supplier-credits/:id/void', owner, (req, res) => { db.prepare("UPDATE supplier_credits SET status = 'void' WHERE id = ? AND status = 'open'").run(idParam(req)); notifyStaff('bills'); res.json({ ok: true }); });

  /* ===== sales tax ===== */
  staff.get('/sales-tax', owner, (req, res) => {
    const y = Number(req.query.year) || Number(localToday().slice(0, 4));
    const period = ['month', 'quarter', 'year', 'custom'].includes(req.query.period) ? req.query.period : 'quarter';
    let from; let to;
    if (period === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { from = req.query.from; to = req.query.to; }
    else if (period === 'year') { from = `${y}-01-01`; to = `${y}-12-31`; }
    else if (period === 'month') { const m = Math.min(12, Math.max(1, Number(req.query.n) || Number(localToday().slice(5, 7)))); from = `${y}-${String(m).padStart(2, '0')}-01`; to = addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1); }
    else { const q = Math.min(4, Math.max(1, Number(req.query.n) || Math.ceil(Number(localToday().slice(5, 7)) / 3))); from = `${y}-${String(q * 3 - 2).padStart(2, '0')}-01`; to = addDays(q === 4 ? `${y + 1}-01-01` : `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`, -1); }
    const r = salesTax(from, to < localToday() ? to : localToday());
    if (req.query.format === 'csv') {
      const m = (c) => (c / 100).toFixed(2);
      res.set('Content-Type', 'text/csv').set('Content-Disposition', `attachment; filename="sales-tax-${from}-to-${to}.csv"`);
      return res.send(['Month,Orders,Gross sales,Discounts,Net sales,Taxable sales,Non-taxable sales,Tax collected,Tips,Fees,Refunds', ...r.months.map((x) => [x.month, x.orders, m(x.grossCents), m(x.discountCents), m(x.netCents), m(x.taxableCents), m(x.exemptCents), m(x.taxCents), m(x.tipsCents), m(x.feesCents), m(x.refundsCents)].join(',')),
        ['Total', r.totals.orders, m(r.totals.grossCents), m(r.totals.discountCents), m(r.totals.netCents), m(r.totals.taxableCents), m(r.totals.exemptCents), m(r.totals.taxCents), m(r.totals.tipsCents), m(r.totals.feesCents), m(r.totals.refundsCents)].join(',')].join('\n'));
    }
    res.json({ ...r, period, year: y, periodTo: to });
  });

  /* ===== stock transfers ===== */
  staff.get('/transfers', owner, (req, res) => res.json({ locations: listLocations().filter((l) => l.slug !== currentSlug()), history: db.prepare('SELECT * FROM stock_transfers ORDER BY id DESC LIMIT 50').all().map((t) => ({ ...t, lines: parseJ(t.lines, []) })),
    ingredients: db.prepare('SELECT id, name, unit, stock FROM ingredients WHERE active = 1 ORDER BY name').all() }));
  staff.post('/transfers', owner, (req, res) => {
    const b = parse(z.object({ to: z.string().max(40), lines: z.array(z.object({ ingredientId: z.number().int(), qty: z.number().positive().max(100000) })).min(1).max(60), note: z.string().trim().max(200).optional() }), req.body);
    const here = currentSlug(); if (b.to === here || !locationExists(b.to)) throw err('Pick another location');
    const toName = listLocations().find((l) => l.slug === b.to)?.name || b.to; const fromName = listLocations().find((l) => l.slug === here)?.name || here;
    const moved = b.lines.map((l) => { const g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(l.ingredientId); if (!g) throw err('An ingredient was not found'); if (g.stock !== null && g.stock < l.qty) throw err(`Only ${g.stock} ${g.unit} of ${g.name} here`); return { g, qty: l.qty }; });
    db.transaction(() => { for (const { g, qty } of moved) { if (g.stock !== null) db.prepare('UPDATE ingredients SET stock = stock - ? WHERE id = ?').run(qty, g.id); db.prepare('INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?,?,?,?)').run(g.id, -qty, `transfer to ${toName}`, req.user.id); } })();
    const lines = moved.map(({ g, qty }) => ({ name: g.name, unit: g.unit, qty, costCents: g.cost_cents }));
    db.prepare("INSERT INTO stock_transfers (direction, other_slug, other_name, lines, note, user_name) VALUES ('out',?,?,?,?,?)").run(b.to, toName, JSON.stringify(lines), b.note || null, req.user.name);
    runIn(b.to, () => {
      for (const l of lines) {
        let g = db.prepare('SELECT * FROM ingredients WHERE lower(name) = lower(?)').get(l.name);
        if (!g) { const id = db.prepare('INSERT INTO ingredients (name, unit, cost_cents, stock) VALUES (?,?,?,0)').run(l.name, l.unit, l.costCents).lastInsertRowid; g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id); }
        db.prepare('UPDATE ingredients SET stock = COALESCE(stock, 0) + ? WHERE id = ?').run(l.qty, g.id);
        db.prepare('INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?,?,?,NULL)').run(g.id, l.qty, `transfer from ${fromName}`);
      }
      db.prepare("INSERT INTO stock_transfers (direction, other_slug, other_name, lines, note, user_name) VALUES ('in',?,?,?,?,?)").run(here, fromName, JSON.stringify(lines), b.note || null, req.user.name);
      audit(null, 'stock.transfer_in', `${lines.length} items from ${fromName}`, null);
    });
    audit(req.user, 'stock.transfer_out', `${lines.length} items to ${toName}`, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
  });

  /* ===== staff certificates ===== */
  const certView = (c) => ({ ...c, daysLeft: c.expires ? daysBetween(localToday(), c.expires) : null, photo: c.photo_version !== '0' ? `/api/staff/certificates/${c.id}/photo?v=${c.photo_version}` : null });
  staff.get('/certificates', (req, res) => {
    const isMgr = ['manager', 'owner'].includes(req.user.role);
    const rows = db.prepare(`SELECT c.*, u.name, v.name verified_name FROM certificates c JOIN users u ON u.id = c.user_id LEFT JOIN users v ON v.id = c.verified_by WHERE u.active = 1 ${isMgr ? '' : 'AND c.user_id = ?'} ORDER BY c.expires`).all(...(isMgr ? [] : [req.user.id])).map(certView);
    const required = parseJ(getSettings().required_certs, []);
    const missing = isMgr ? db.prepare("SELECT id, name, role FROM users WHERE active = 1 AND role <> 'owner'").all().flatMap((u) => required.filter((k) => !rows.some((c) => c.user_id === u.id && c.kind === k && (c.daysLeft === null || c.daysLeft >= 0))).map((k) => ({ userId: u.id, name: u.name, kind: k }))) : [];
    res.json({ certificates: rows, kinds: CERT_KINDS, required, missing, team: isMgr ? db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all() : [] });
  });
  const certSchema = z.object({ userId: z.number().int().optional(), kind: z.string().trim().min(1).max(40), number: z.string().trim().max(40).optional(), issued: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')) });
  staff.post('/certificates', (req, res) => {
    const b = parse(certSchema, req.body); const isMgr = ['manager', 'owner'].includes(req.user.role);
    const uid = isMgr && b.userId ? b.userId : req.user.id;
    const id = db.prepare('INSERT INTO certificates (user_id, kind, number, issued, expires, verified_by) VALUES (?,?,?,?,?,?)').run(uid, b.kind, b.number || null, b.issued || null, b.expires || null, isMgr ? req.user.id : null).lastInsertRowid;
    audit(req.user, 'cert.add', `${b.kind} for user ${uid}`, clientIp(req)); notifyStaff('certs'); res.json({ id });
  });
  staff.post('/certificates/:id/verify', mgr, (req, res) => { db.prepare('UPDATE certificates SET verified_by = ? WHERE id = ?').run(req.user.id, idParam(req)); notifyStaff('certs'); res.json({ ok: true }); });
  staff.delete('/certificates/:id', (req, res) => { const c = db.prepare('SELECT * FROM certificates WHERE id = ?').get(idParam(req)); if (!c) throw err('Not found', 404); if (c.user_id !== req.user.id && !['manager', 'owner'].includes(req.user.role)) throw err('Not allowed', 403); db.prepare('DELETE FROM certificates WHERE id = ?').run(c.id); notifyStaff('certs'); res.json({ ok: true }); });
  staff.put('/certificates/:id/photo', (req, res) => {
    const c = db.prepare('SELECT * FROM certificates WHERE id = ?').get(idParam(req)); if (!c) throw err('Not found', 404);
    if (c.user_id !== req.user.id && !['manager', 'owner'].includes(req.user.role)) throw err('Not allowed', 403);
    const { dataUrl } = parse(z.object({ dataUrl: z.string().max(1_400_000) }), req.body);
    const m = /^data:(image\/(png|jpeg|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl); if (!m) throw err('Upload a photo or a PDF');
    const buf = Buffer.from(m[3], 'base64'); if (buf.length > 1_000_000) throw err('Max 1 MB');
    db.prepare("INSERT INTO assets (key, mime, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=datetime('now')").run(`cert:${c.id}`, m[1], buf);
    db.prepare('UPDATE certificates SET photo_version = ? WHERE id = ?').run(String(Date.now()), c.id); notifyStaff('certs'); res.json({ ok: true });
  });
  staff.get('/certificates/:id/photo', (req, res) => {
    const c = db.prepare('SELECT * FROM certificates WHERE id = ?').get(idParam(req));
    if (!c || (c.user_id !== req.user.id && !['manager', 'owner'].includes(req.user.role))) return res.status(404).end();
    const a = db.prepare('SELECT mime, data FROM assets WHERE key = ?').get(`cert:${c.id}`); if (!a) return res.status(404).end();
    res.set('Content-Type', a.mime).set('Cache-Control', 'private, max-age=3600').send(a.data);
  });

  /* ===== cash flow ===== */
  staff.get('/cash-flow', owner, (req, res) => res.json(cashFlow(Math.min(90, Math.max(7, Number(req.query.days) || 30)))));

  /* ===== delivery zones ===== */
  const zoneSchema = z.object({ name: z.string().trim().min(1).max(40), points: z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).min(3).max(200), feeCents: z.number().int().min(0).max(100000), minCents: z.number().int().min(0).max(1_000_000), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), active: z.boolean().optional() });
  staff.get('/delivery-zones', mgr, (req, res) => { const s = getSettings(); res.json({ zones: db.prepare('SELECT * FROM delivery_zones ORDER BY sort, id').all().map((z) => ({ ...z, points: parseJ(z.points, []) })), center: null, address: s.business_address || '' }); });
  staff.post('/delivery-zones', mgr, (req, res) => { const b = parse(zoneSchema, req.body); db.prepare('INSERT INTO delivery_zones (name, points, fee_cents, min_cents, color) VALUES (?,?,?,?,?)').run(b.name, JSON.stringify(b.points), b.feeCents, b.minCents, b.color || null); audit(req.user, 'delivery.zone', b.name, clientIp(req)); res.json({ ok: true }); });
  staff.put('/delivery-zones/:id', mgr, (req, res) => { const b = parse(zoneSchema, req.body); db.prepare('UPDATE delivery_zones SET name=?, points=?, fee_cents=?, min_cents=?, color=?, active=COALESCE(?, active) WHERE id=?').run(b.name, JSON.stringify(b.points), b.feeCents, b.minCents, b.color || null, b.active === undefined ? null : b.active ? 1 : 0, idParam(req)); res.json({ ok: true }); });
  staff.delete('/delivery-zones/:id', mgr, (req, res) => { db.prepare('DELETE FROM delivery_zones WHERE id = ?').run(idParam(req)); res.json({ ok: true }); });
  staff.post('/delivery-zones/geocode', mgr, wrap(async (req, res) => { const b = parse(z.object({ address: z.string().trim().min(5).max(200) }), req.body); const p = await geocode(b.address); if (!p) throw err('Could not find that address on the map'); res.json(p); }));
  h.deliveryZone = zoneFor;
  app.post('/api/o/delivery-quote', publicLimiter, wrap(async (req, res) => {
    const b = parse(z.object({ address: z.string().trim().min(5).max(200) }), req.body);
    const zq = await zoneFor(b.address); const s = getSettings();
    if (!zq) return res.json({ ok: true, feeCents: Number(s.delivery_fee_cents), minCents: Number(s.delivery_min_cents) });
    if (zq.outside) return res.json({ ok: false, error: zq.error });
    if (zq.unknown) return res.json({ ok: true, feeCents: Number(s.delivery_fee_cents), minCents: Number(s.delivery_min_cents), note: "We couldn't find that address on the map. We'll confirm the fee." });
    res.json({ ok: true, zone: zq.zone, feeCents: zq.feeCents, minCents: zq.minCents });
  }));

  /* ===== catering follow-up ===== */
  const invByToken = (t) => (/^[A-Za-z0-9_-]{16,40}$/.test(t || '') ? db.prepare('SELECT * FROM invoices WHERE token = ?').get(t) : null);
  app.get('/api/i/:token/feedback', publicLimiter, (req, res) => { const inv = invByToken(req.params.token); if (!inv) return res.status(404).json({ error: 'Not found' }); const f = db.prepare('SELECT * FROM catering_feedback WHERE invoice_id = ?').get(inv.id); const s = getSettings(); res.json({ title: inv.title, name: inv.customer_name, business: { name: s.business_name, accent: s.accent, review: s.review_url || '' }, rated: Boolean(f?.rating), rebook: `${publicBase(req)}/catering-order${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}` }); });
  app.post('/api/i/:token/feedback', publicLimiter, (req, res) => {
    const inv = invByToken(req.params.token); if (!inv) return res.status(404).json({ error: 'Not found' });
    const b = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(800).optional() }), req.body);
    if (db.prepare('SELECT rating FROM catering_feedback WHERE invoice_id = ?').get(inv.id)?.rating) return res.json({ ok: true, already: true });
    db.prepare("INSERT INTO catering_feedback (invoice_id, rating, comment, responded_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(invoice_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, responded_at = excluded.responded_at").run(inv.id, b.rating, b.comment || null);
    const s = getSettings();
    pushToUsers(['manager', 'owner'], { title: `${s.business_name}: catering rated ${b.rating}★`, body: `${inv.customer_name}: ${b.comment || inv.title}`.slice(0, 140), tag: `catfb-${inv.id}`, url: '/catering' }).catch(() => {});
    audit(null, 'catering.feedback', `${inv.title} ${b.rating}★`, null); notifyStaff('invoices');
    res.json({ ok: true, review: b.rating >= 4 ? s.review_url || '' : '' });
  });
  staff.get('/catering-feedback', mgr, (req, res) => res.json(db.prepare('SELECT f.*, i.title, i.customer_name, i.event_date FROM catering_feedback f JOIN invoices i ON i.id = f.invoice_id ORDER BY f.invoice_id DESC LIMIT 50').all()));

  /* ===== jobs ===== */
  setInterval(() => forEachLocation(async () => {
    const s = getSettings(); const today = localToday(); const hm = localHM();
    if (hm < '09:00') return;
    // certificates expiring in 30 days (and on the day), once each
    for (const c of db.prepare('SELECT c.*, u.name FROM certificates c JOIN users u ON u.id = c.user_id WHERE u.active = 1 AND c.expires IS NOT NULL AND c.expires <= ?').all(addDays(today, 30))) {
      const dl = daysBetween(today, c.expires); const stage = dl < 0 ? 'expired' : dl <= 7 ? 'week' : 'month';
      if (!once(`cert:${c.id}:${stage}`)) continue;
      const msg = `${c.name}'s ${c.kind} ${dl < 0 ? `expired ${-dl} days ago` : dl === 0 ? 'expires today' : `expires in ${dl} days`}`;
      await pushToUsers(['manager', 'owner'], { title: `${s.business_name}: certificate ${dl < 0 ? 'expired' : 'expiring'}`, body: msg, tag: `cert-${c.id}`, url: '/certificates' }).catch(() => {});
      await pushToUsers(['staff', 'manager', 'owner'], { title: 'Your certificate', body: `Your ${c.kind} ${dl < 0 ? 'has expired' : dl === 0 ? 'expires today' : `expires in ${dl} days`}. Renew it and add the new one in BuzzHub.`, tag: `mycert-${c.id}`, url: '/certificates' }, c.user_id).catch(() => {});
    }
    // catering follow-up the day after the event, after 10am
    if (s.catering_followup === '1' && hm >= '10:00' && emailEnabled()) {
      for (const inv of db.prepare("SELECT * FROM invoices WHERE event_date IS NOT NULL AND event_date < ? AND event_date >= ? AND status IN ('accepted','deposit_paid','paid') AND email IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catering_feedback f WHERE f.invoice_id = invoices.id AND f.sent_at IS NOT NULL)").all(today, addDays(today, -7))) {
        db.prepare("INSERT INTO catering_feedback (invoice_id, sent_at) VALUES (?, datetime('now')) ON CONFLICT(invoice_id) DO UPDATE SET sent_at = datetime('now')").run(inv.id);
        const base = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); const l = currentSlug() === 'main' ? '' : `?l=${currentSlug()}`;
        await emailGuest(inv.email, { businessName: s.business_name, subject: `Thanks for choosing ${s.business_name}`, message: `Hi ${inv.customer_name.split(' ')[0]},\n\nThank you for having us cater ${inv.title}. How did we do? It takes 10 seconds, and it helps a lot.\n\nPlanning another event? You can book again from the same link.`, link: `${base}/rate/${inv.token}${l}`, accent: s.accent, button: 'Rate your catering' }).catch(() => {});
      }
    }
  }), 10 * 60_000).unref();
}
