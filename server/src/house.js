// Round 7, batch M: checklists and temperature logs, event tickets, bank deposit matching, menu engineering, prep list.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, currentTz, forEachLocation } from './db.js';
import { stripe, stripeEnabled } from './commerce.js';
import { pushToUsers, emailEnabled, emailGuest } from './notify.js';
import { dayBounds } from './ops.js';
import { dailyBooks } from './reach.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS checklist_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'daily' CHECK (kind IN ('open','close','daily','weekly')),
  dow INTEGER, due_time TEXT, items TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS checklist_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL, day TEXT NOT NULL, done TEXT NOT NULL DEFAULT '{}', completed_at TEXT, completed_by INTEGER,
  UNIQUE (template_id, day)
);
CREATE TABLE IF NOT EXISTS temp_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, min_temp REAL NOT NULL, max_temp REAL NOT NULL, scale TEXT NOT NULL DEFAULT 'F', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS temp_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, unit_id INTEGER NOT NULL, value REAL NOT NULL, ok INTEGER NOT NULL, note TEXT, corrective TEXT, user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_temp_logs ON temp_logs(unit_id, at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, starts_local TEXT NOT NULL, ends_local TEXT, capacity INTEGER NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0,
  max_per_order INTEGER NOT NULL DEFAULT 6, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT, phone TEXT, qty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','checked_in','cancelled')), payment_id INTEGER, checked_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), checked_in_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
CREATE TABLE IF NOT EXISTS bank_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL CHECK (source IN ('cash','card','app')), amount_cents INTEGER NOT NULL, deposit_date TEXT NOT NULL,
  cover_from TEXT NOT NULL, cover_to TEXT NOT NULL, reference TEXT, note TEXT, external_id TEXT UNIQUE, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS house_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')));`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fmt = (c) => `$${(c / 100).toFixed(2)}`;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dowOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const nowLocalHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: currentTz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const parseJ = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };
const once = (key) => db.prepare('INSERT OR IGNORE INTO house_alerts (key) VALUES (?)').run(key).changes > 0;

/* ---------- checklists for a day ---------- */
function checklistsFor(day) {
  const tpls = db.prepare('SELECT * FROM checklist_templates WHERE active = 1 ORDER BY sort, id').all().filter((t) => t.kind !== 'weekly' || t.dow === dowOf(day));
  return tpls.map((t) => {
    const items = parseJ(t.items, []); const run = db.prepare('SELECT r.*, u.name by_name FROM checklist_runs r LEFT JOIN users u ON u.id = r.completed_by WHERE r.template_id = ? AND r.day = ?').get(t.id, day);
    const done = parseJ(run?.done, {});
    const count = items.filter((_, i) => done[i]).length;
    return { id: t.id, name: t.name, kind: t.kind, area: t.area || null, dueTime: t.due_time, items: items.map((it, i) => ({ text: it.text, needsValue: Boolean(it.needsValue), done: done[i] || null })), count, total: items.length, completedAt: run?.completed_at || null, completedBy: run?.by_name || null,
      overdue: !run?.completed_at && t.due_time && day === localToday() && nowLocalHM() > t.due_time };
  });
}

/* ---------- menu engineering ---------- */
export function menuEngineering(days = 30) {
  const s = getSettings(); const target = (Number(s.food_cost_target) || 30) / 100;
  const sold = db.prepare(`SELECT oi.item_id id, SUM(oi.qty) qty FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.paid_at > datetime('now', ?) AND o.status <> 'void' GROUP BY oi.item_id`).all(`-${days} days`);
  const soldMap = Object.fromEntries(sold.map((r) => [r.id, r.qty]));
  const cost = Object.fromEntries(db.prepare('SELECT r.item_id id, SUM(r.qty * g.cost_cents) c FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id GROUP BY r.item_id').all().map((r) => [r.id, r.c]));
  const items = db.prepare('SELECT id, name, category, price_cents FROM menu_items WHERE active = 1').all().map((m) => {
    const c = cost[m.id] !== undefined ? Math.round(cost[m.id]) : null;
    const cm = m.price_cents - (c ?? Math.round(m.price_cents * target));
    return { ...m, qty: soldMap[m.id] || 0, costCents: c, estimated: c === null, marginCents: cm };
  });
  const totalQty = items.reduce((a, i) => a + i.qty, 0) || 1;
  const popLine = (1 / Math.max(1, items.length)) * 0.7;
  const avgCm = items.reduce((a, i) => a + i.marginCents * i.qty, 0) / totalQty;
  const advice = { star: 'Keep it front and center. Protect quality, and consider a small price rise.', plowhorse: 'Popular but low profit: trim portion or cost, raise the price a little, or pair it with a high-margin add-on.', puzzle: 'Profitable but slow: move it higher on the menu, rename or describe it better, or have staff suggest it.', dog: 'Low sales and low profit: rework it, or take it off the menu.' };
  return { days, averageMarginCents: Math.round(avgCm), popularityLinePct: Math.round(popLine * 1000) / 10, items: items.map((i) => {
    const mix = i.qty / totalQty; const popular = mix >= popLine; const profitable = i.marginCents >= avgCm;
    const cls = popular && profitable ? 'star' : popular ? 'plowhorse' : profitable ? 'puzzle' : 'dog';
    return { ...i, mixPct: Math.round(mix * 1000) / 10, class: cls, advice: advice[cls], contributionCents: i.marginCents * i.qty };
  }).sort((a, b) => b.contributionCents - a.contributionCents) };
}

/* ---------- prep list ---------- */
export function prepList(date) {
  const s = getSettings(); const buffer = 1 + (Number(s.prep_buffer_pct) || 10) / 100; const dow = dowOf(date);
  const weeks = []; for (let k = 1; k <= 8; k += 1) weeks.push(addDays(date, -7 * k));
  const counts = {}; let seen = 0;
  for (const d of weeks) {
    const { start, end } = dayBounds(d);
    const rows = db.prepare("SELECT oi.item_id id, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> 'void' GROUP BY oi.item_id").all(start, end);
    if (rows.length) seen += 1;
    for (const r of rows) counts[r.id] = (counts[r.id] || 0) + r.q;
  }
  const n = Math.max(1, seen);
  const items = db.prepare('SELECT id, name, category FROM menu_items WHERE active = 1 ORDER BY category, sort, id').all()
    .map((m) => ({ ...m, avg: Math.round(((counts[m.id] || 0) / n) * 10) / 10, prep: Math.ceil(((counts[m.id] || 0) / n) * buffer) })).filter((m) => m.prep > 0);
  const need = {};
  for (const m of items) for (const r of db.prepare('SELECT r.ingredient_id, r.qty FROM item_recipes r WHERE r.item_id = ?').all(m.id)) need[r.ingredient_id] = (need[r.ingredient_id] || 0) + r.qty * m.prep;
  const ingredients = Object.entries(need).map(([id, q]) => { const g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id); if (!g) return null; const have = g.stock; return { id: g.id, name: g.name, unit: g.unit, need: Math.round(q * 100) / 100, have: have === null ? null : Math.round(have * 100) / 100, short: have !== null && have < q ? Math.round((q - have) * 100) / 100 : 0 }; }).filter(Boolean).sort((a, b) => b.short - a.short || a.name.localeCompare(b.name));
  return { date, weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow], weeksOfData: seen, bufferPct: Number(s.prep_buffer_pct) || 10, items, ingredients };
}

export function registerHouse({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, publicBase, publicLimiter, notifyStaff } = h;
  const mgr = requireAuth('manager');
  const tellManagers = (title, body, url) => pushToUsers(['manager', 'owner'], { title, body, tag: 'house', url }).catch(() => {});

  /* ===== checklists ===== */
  staff.get('/checklists', (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : localToday();
    res.json({ day, lists: checklistsFor(day), templates: ['manager', 'owner'].includes(req.user.role) ? db.prepare('SELECT * FROM checklist_templates ORDER BY active DESC, sort, id').all().map((t) => ({ ...t, items: parseJ(t.items, []) })) : undefined });
  });
  staff.post('/checklists/:id/check', (req, res) => {
    const b = parse(z.object({ index: z.number().int().min(0).max(100), done: z.boolean(), value: z.string().trim().max(40).optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body);
    const day = b.day && b.day <= localToday() ? b.day : localToday();
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(idParam(req)); if (!t) throw err('Not found', 404);
    const items = parseJ(t.items, []); if (b.index >= items.length) throw err('Bad item');
    db.prepare('INSERT OR IGNORE INTO checklist_runs (template_id, day) VALUES (?, ?)').run(t.id, day);
    const run = db.prepare('SELECT * FROM checklist_runs WHERE template_id = ? AND day = ?').get(t.id, day);
    const done = parseJ(run.done, {});
    if (b.done) done[b.index] = { by: req.user.name.split(' ')[0], at: new Date().toISOString(), value: b.value || null }; else delete done[b.index];
    const complete = items.every((_, i) => done[i]);
    db.prepare('UPDATE checklist_runs SET done = ?, completed_at = ?, completed_by = ? WHERE id = ?').run(JSON.stringify(done), complete ? (run.completed_at || new Date().toISOString().replace('T', ' ').slice(0, 19)) : null, complete ? req.user.id : null, run.id);
    if (complete && !run.completed_at) audit(req.user, 'checklist.done', `${t.name} ${day}`, clientIp(req));
    notifyStaff('checklists'); res.json({ ok: true, complete });
  });
  const tplSchema = z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(['open', 'close', 'daily', 'weekly']), dow: z.number().int().min(0).max(6).nullable().optional(), dueTime: z.string().regex(/^(\d{2}:\d{2})?$/).optional(), items: z.array(z.object({ text: z.string().trim().min(1).max(120), needsValue: z.boolean().optional() })).min(1).max(60), active: z.boolean().optional(), area: z.string().trim().max(24).nullable().optional() });
  staff.post('/checklist-templates', mgr, (req, res) => { const b = parse(tplSchema, req.body); const id = db.prepare('INSERT INTO checklist_templates (name, kind, dow, due_time, items, area) VALUES (?,?,?,?,?,?)').run(b.name, b.kind, b.kind === 'weekly' ? b.dow ?? 1 : null, b.dueTime || null, JSON.stringify(b.items), b.area || null).lastInsertRowid; audit(req.user, 'checklist.create', b.name, clientIp(req)); notifyStaff('checklists'); res.json({ id }); });
  staff.put('/checklist-templates/:id', mgr, (req, res) => { const b = parse(tplSchema, req.body); db.prepare('UPDATE checklist_templates SET name=?, kind=?, dow=?, due_time=?, items=?, active=COALESCE(?, active), area=? WHERE id=?').run(b.name, b.kind, b.kind === 'weekly' ? b.dow ?? 1 : null, b.dueTime || null, JSON.stringify(b.items), b.active === undefined ? null : b.active ? 1 : 0, b.area || null, idParam(req)); notifyStaff('checklists'); res.json({ ok: true }); });
  staff.post('/checklist-templates/starter', mgr, (req, res) => {
    if (db.prepare('SELECT 1 FROM checklist_templates').get()) throw err('You already have checklists', 409);
    const type = getSettings().business_type; const food = ['restaurant', 'cafe', 'bar', 'food_truck'].includes(type) || type !== 'salon' && type !== 'clinic' && type !== 'service';
    const sets = food ? [
      ['Opening', 'open', '10:30', ['Turn on equipment and check it works', 'Check fridge and freezer temperatures', 'Wash hands station stocked (soap, towels)', 'Sanitizer buckets made at the right strength', 'Prep list checked and started', 'Dining room clean, tables set', 'Restrooms clean and stocked', 'Count the cash drawer']],
      ['Closing', 'close', '23:30', ['Food labeled, dated and stored', 'Fridge and freezer temperatures checked', 'Surfaces cleaned and sanitized', 'Floors swept and mopped', 'Trash and recycling out', 'Equipment off and cleaned', 'Cash drawer counted and closed', 'Doors locked and alarm set']],
      ['Weekly deep clean', 'weekly', '', ['Clean behind and under equipment', 'Descale coffee and ice machines', 'Clean hood filters', 'Check pest traps', 'Check fire extinguisher and first aid kit']],
    ] : [
      ['Opening', 'open', '09:00', ['Lights, music and signage on', 'Stations clean and sanitized', 'Tools and supplies restocked', 'Check today’s bookings', 'Restroom clean and stocked', 'Count the cash drawer']],
      ['Closing', 'close', '20:30', ['Stations cleaned and sanitized', 'Tools cleaned or sterilized', 'Laundry started', 'Trash out', 'Cash drawer counted and closed', 'Doors locked and alarm set']],
    ];
    for (const [name, kind, due, items] of sets) db.prepare('INSERT INTO checklist_templates (name, kind, dow, due_time, items) VALUES (?,?,?,?,?)').run(name, kind, kind === 'weekly' ? 1 : null, due || null, JSON.stringify(items.map((t) => ({ text: t, needsValue: /temperature/i.test(t) }))));
    if (food && !db.prepare('SELECT 1 FROM temp_units').get()) for (const [n, a, b2] of [['Walk-in fridge', 33, 41], ['Reach-in fridge', 33, 41], ['Freezer', -10, 0]]) db.prepare('INSERT INTO temp_units (name, min_temp, max_temp) VALUES (?,?,?)').run(n, a, b2);
    audit(req.user, 'checklist.starter', type, clientIp(req)); notifyStaff('checklists'); res.json({ ok: true });
  });

  /* ===== temperature logs ===== */
  staff.get('/temps', (req, res) => {
    const units = db.prepare('SELECT * FROM temp_units WHERE active = 1 ORDER BY id').all();
    res.json({ units: units.map((u) => ({ ...u, last: db.prepare('SELECT l.*, us.name by_name FROM temp_logs l LEFT JOIN users us ON us.id = l.user_id WHERE l.unit_id = ? ORDER BY l.id DESC LIMIT 1').get(u.id) || null, today: db.prepare("SELECT value, ok, at FROM temp_logs WHERE unit_id = ? AND localdate(at) = localtoday() ORDER BY id").all(u.id) })) });
  });
  staff.post('/temps/:unitId', (req, res) => {
    const b = parse(z.object({ value: z.number().min(-60).max(250), note: z.string().trim().max(120).optional(), corrective: z.string().trim().max(200).optional() }), req.body);
    const u = db.prepare('SELECT * FROM temp_units WHERE id = ? AND active = 1').get(Number(req.params.unitId)); if (!u) throw err('Not found', 404);
    const ok = b.value >= u.min_temp && b.value <= u.max_temp;
    if (!ok && !b.corrective) throw Object.assign(err(`${b.value}°${u.scale} is outside ${u.min_temp}–${u.max_temp}°${u.scale}. Say what you did about it.`), { needsCorrective: true });
    db.prepare('INSERT INTO temp_logs (unit_id, value, ok, note, corrective, user_id) VALUES (?,?,?,?,?,?)').run(u.id, b.value, ok ? 1 : 0, b.note || null, b.corrective || null, req.user.id);
    if (!ok) tellManagers(`${getSettings().business_name}: ${u.name} out of range`, `${req.user.name} logged ${b.value}°${u.scale} (should be ${u.min_temp}–${u.max_temp}). Action: ${b.corrective}`, '/checklists');
    audit(req.user, 'temp.log', `${u.name} ${b.value}°${u.scale}${ok ? '' : ' OUT OF RANGE'}`, clientIp(req)); notifyStaff('checklists'); res.json({ ok: true, inRange: ok });
  });
  staff.post('/temp-units', mgr, (req, res) => { const b = parse(z.object({ name: z.string().trim().min(1).max(40), min: z.number().min(-60).max(250), max: z.number().min(-60).max(250), scale: z.enum(['F', 'C']) }), req.body); if (b.max <= b.min) throw err('Max must be above min'); db.prepare('INSERT INTO temp_units (name, min_temp, max_temp, scale) VALUES (?,?,?,?)').run(b.name, b.min, b.max, b.scale); notifyStaff('checklists'); res.json({ ok: true }); });
  staff.delete('/temp-units/:id', mgr, (req, res) => { db.prepare('UPDATE temp_units SET active = 0 WHERE id = ?').run(idParam(req)); notifyStaff('checklists'); res.json({ ok: true }); });
  staff.get('/inspection-log', mgr, (req, res) => {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const to = ok(req.query.to) ? req.query.to : localToday(); const from = ok(req.query.from) ? req.query.from : addDays(to, -29);
    const a = dayBounds(from).start; const z2 = dayBounds(to).end;
    const temps = db.prepare('SELECT l.at, l.value, l.ok, l.note, l.corrective, t.name unit, t.scale, t.min_temp, t.max_temp, u.name by_name FROM temp_logs l JOIN temp_units t ON t.id = l.unit_id LEFT JOIN users u ON u.id = l.user_id WHERE l.at >= ? AND l.at < ? ORDER BY l.at').all(a, z2);
    const runs = db.prepare('SELECT r.day, r.done, r.completed_at, t.name, t.items, u.name by_name FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id LEFT JOIN users u ON u.id = r.completed_by WHERE r.day BETWEEN ? AND ? ORDER BY r.day, t.sort').all(from, to)
      .map((r) => { const items = parseJ(r.items, []); const done = parseJ(r.done, {}); return { day: r.day, name: r.name, completedAt: r.completed_at, by: r.by_name, done: items.filter((_, i) => done[i]).length, total: items.length }; });
    res.json({ from, to, business: getSettings().business_name, temps, runs });
  });

  /* ===== event tickets ===== */
  const seatsTaken = (eid) => db.prepare("SELECT COALESCE(SUM(qty),0) n FROM tickets WHERE event_id = ? AND (status IN ('paid','checked_in') OR (status = 'pending' AND created_at > datetime('now','-30 minutes')))").get(eid).n;
  const eventView = (e) => ({ id: e.id, title: e.title, description: e.description, startsLocal: e.starts_local, endsLocal: e.ends_local, priceCents: e.price_cents, capacity: e.capacity, left: Math.max(0, e.capacity - seatsTaken(e.id)), maxPerOrder: e.max_per_order, active: Boolean(e.active) });
  app.get('/api/public/events', publicLimiter, (req, res) => {
    const s = getSettings(); const now = `${localToday()} 00:00`;
    res.json({ business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null }, currency: s.currency, payOnline: h.onlinePayEnabled?.() || false,
      events: db.prepare('SELECT * FROM events WHERE active = 1 AND starts_local >= ? ORDER BY starts_local LIMIT 50').all(now).map(eventView) });
  });
  app.post('/api/public/events/:id/tickets', h.orderLimiter || publicLimiter, wrap(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(60), email: z.string().trim().email().max(120), phone: z.string().trim().max(30).optional(), qty: z.number().int().min(1).max(20) }), req.body);
    const e = db.prepare('SELECT * FROM events WHERE id = ? AND active = 1').get(idParam(req)); if (!e) throw err('This event is not available', 404);
    if (e.starts_local < `${localToday()} 00:00`) throw err('This event has passed', 409);
    if (b.qty > e.max_per_order) throw err(`Up to ${e.max_per_order} tickets per order`);
    const code = crypto.randomBytes(12).toString('base64url');
    const tid = db.transaction(() => {
      if (seatsTaken(e.id) + b.qty > e.capacity) { const left = Math.max(0, e.capacity - seatsTaken(e.id)); throw err(left ? `Only ${left} seat${left === 1 ? "" : "s"} left` : "Sold out", 409); }
      return db.prepare('INSERT INTO tickets (event_id, code, name, email, phone, qty, status) VALUES (?,?,?,?,?,?,?)').run(e.id, code, b.name, b.email, b.phone || null, b.qty, e.price_cents ? 'pending' : 'paid').lastInsertRowid;
    })();
    const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `?l=${currentSlug()}`;
    const ticketUrl = `${base}/ticket/${code}${l}`;
    if (!e.price_cents) { sendTicket(db.prepare('SELECT * FROM tickets WHERE id = ?').get(tid), e, ticketUrl); notifyStaff('events'); return res.json({ url: ticketUrl }); }
    if (!h.onlinePayEnabled?.()) { db.prepare("UPDATE tickets SET status = 'cancelled' WHERE id = ?").run(tid); throw err('Online payment is not set up. Contact us for tickets.', 503); }
    const pid = db.prepare("INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('ticket', ?, 'card', ?, ?)").run(e.price_cents * b.qty, `${b.qty} × ${e.title}`, JSON.stringify({ ticketId: tid })).lastInsertRowid;
    db.prepare('UPDATE tickets SET payment_id = ? WHERE id = ?').run(pid, tid);
    res.json({ url: h.startPay(pid, { base, lines: [{ name: `${e.title} (${b.qty} ticket${b.qty === 1 ? '' : 's'})`, cents: e.price_cents * b.qty }], successUrl: ticketUrl, cancelUrl: `${base}/events${l}`, email: b.email, descr: e.title }) });
  }));
  function sendTicket(t, e, url) {
    if (!emailEnabled() || !t.email) return;
    const s = getSettings();
    emailGuest(t.email, { businessName: s.business_name, subject: `Your tickets: ${e.title}`, message: `Hi ${t.name.split(' ')[0]},\n\nYou're going to ${e.title} on ${e.starts_local}. ${t.qty} ticket${t.qty === 1 ? '' : 's'}. Show the QR code at the door.`, link: url, accent: s.accent, button: 'Show my ticket' }).catch(() => {});
  }
  h.payHooks = h.payHooks || {};
  h.payHooks.ticket = (p) => {
    const meta = parseJ(p.meta, {}); const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(meta.ticketId); if (!t) return;
    db.prepare("UPDATE tickets SET status = 'paid' WHERE id = ? AND status IN ('pending','cancelled')").run(t.id);
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(t.event_id);
    sendTicket(t, e, `${process.env.PUBLIC_URL?.replace(/\/$/, '') || ''}/ticket/${t.code}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`);
    audit(null, 'ticket.paid', `${t.qty} × ${e.title} for ${t.name}`, null); notifyStaff('events');
  };
  app.get('/api/e/:code', publicLimiter, wrap(async (req, res) => {
    const t = /^[A-Za-z0-9_-]{16}$/.test(req.params.code) ? db.prepare('SELECT * FROM tickets WHERE code = ?').get(req.params.code) : null;
    if (!t) return res.status(404).json({ error: 'This ticket link is not valid.' });
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(t.event_id); const s = getSettings();
    res.json({ status: t.status, name: t.name, qty: t.qty, checkedIn: t.checked_in, event: { title: e.title, startsLocal: e.starts_local, endsLocal: e.ends_local, description: e.description }, business: { name: s.business_name, accent: s.accent, address: s.business_address || '' },
      svg: ['paid', 'checked_in'].includes(t.status) ? await QRCode.toString(`BH-T-${t.code}`, { type: 'svg', margin: 1 }) : null });
  }));
  const evSchema = z.object({ title: z.string().trim().min(1).max(80), description: z.string().trim().max(600).optional(), startsLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), endsLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/).optional().or(z.literal('')), capacity: z.number().int().min(1).max(10000), priceCents: z.number().int().min(0).max(1000000), maxPerOrder: z.number().int().min(1).max(50).default(6), active: z.boolean().optional() });
  staff.get('/events', mgr, (req, res) => res.json({ events: db.prepare('SELECT * FROM events ORDER BY starts_local DESC LIMIT 100').all().map((e) => ({ ...eventView(e), sold: db.prepare("SELECT COALESCE(SUM(qty),0) n FROM tickets WHERE event_id = ? AND status IN ('paid','checked_in')").get(e.id).n, checkedIn: db.prepare('SELECT COALESCE(SUM(checked_in),0) n FROM tickets WHERE event_id = ?').get(e.id).n })), link: `${publicBase(req)}/events${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}` }));
  staff.post('/events', mgr, (req, res) => { const b = parse(evSchema, req.body); const id = db.prepare('INSERT INTO events (title, description, starts_local, ends_local, capacity, price_cents, max_per_order) VALUES (?,?,?,?,?,?,?)').run(b.title, b.description || null, b.startsLocal, b.endsLocal || null, b.capacity, b.priceCents, b.maxPerOrder).lastInsertRowid; audit(req.user, 'event.create', b.title, clientIp(req)); notifyStaff('events'); res.json({ id }); });
  staff.put('/events/:id', mgr, (req, res) => { const b = parse(evSchema, req.body); db.prepare('UPDATE events SET title=?, description=?, starts_local=?, ends_local=?, capacity=?, price_cents=?, max_per_order=?, active=COALESCE(?, active) WHERE id=?').run(b.title, b.description || null, b.startsLocal, b.endsLocal || null, b.capacity, b.priceCents, b.maxPerOrder, b.active === undefined ? null : b.active ? 1 : 0, idParam(req)); notifyStaff('events'); res.json({ ok: true }); });
  staff.get('/events/:id/attendees', (req, res) => res.json(db.prepare("SELECT id, name, email, phone, qty, status, checked_in, checked_in_at FROM tickets WHERE event_id = ? AND status <> 'cancelled' AND (status <> 'pending' OR created_at > datetime('now','-30 minutes')) ORDER BY name").all(idParam(req))));
  staff.post('/tickets/checkin', (req, res) => {
    const b = parse(z.object({ code: z.string().trim().max(40).optional(), ticketId: z.number().int().optional(), count: z.number().int().min(1).max(50).optional() }), req.body);
    const code = (b.code || '').replace(/^BH-T-/, '');
    const t = b.ticketId ? db.prepare('SELECT * FROM tickets WHERE id = ?').get(b.ticketId) : db.prepare('SELECT * FROM tickets WHERE code = ?').get(code);
    if (!t) throw err('Ticket not found', 404);
    if (!['paid', 'checked_in'].includes(t.status)) throw err(t.status === 'pending' ? 'This ticket was not paid' : 'This ticket was cancelled', 409);
    const add = Math.min(b.count || t.qty - t.checked_in, t.qty - t.checked_in);
    if (add <= 0) throw err(`Already checked in (${t.qty} of ${t.qty})`, 409);
    db.prepare("UPDATE tickets SET checked_in = checked_in + ?, status = 'checked_in', checked_in_at = datetime('now') WHERE id = ?").run(add, t.id);
    const e = db.prepare('SELECT title FROM events WHERE id = ?').get(t.event_id);
    audit(req.user, 'ticket.checkin', `${t.name} ×${add} ${e.title}`, clientIp(req)); notifyStaff('events');
    res.json({ name: t.name, event: e.title, checkedIn: t.checked_in + add, qty: t.qty });
  });
  staff.post('/tickets/:id/cancel', mgr, wrap(async (req, res) => {
    const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(idParam(req)); if (!t) throw err('Not found', 404);
    db.prepare("UPDATE tickets SET status = 'cancelled' WHERE id = ?").run(t.id);
    let refund = 'none';
    if (t.payment_id) { const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(t.payment_id); if (p?.status === 'paid' && p.refund_ref) refund = await h.refundRef(p.refund_ref, p.amount_cents).catch(() => 'manual'); }
    audit(req.user, 'ticket.cancel', `${t.name} (${refund})`, clientIp(req)); notifyStaff('events'); res.json({ ok: true, refund });
  }));

  /* ===== bank deposit matching ===== */
  const SRC = { cash: ['cash'], card: ['card', 'split', 'online'], app: ['zelle', 'venmo', 'cashapp', 'paypal', 'paypalme'] };
  function expected(from, to) {
    const days = dailyBooks(from, to); const out = { cash: 0, card: 0, app: 0 };
    for (const d of days) for (const [m, c] of Object.entries(d.byMethod)) { const k = Object.keys(SRC).find((x) => SRC[x].includes(m)) || 'card'; out[k] += c; }
    // cash tips paid out of the drawer never reach the bank
    out.cash -= db.prepare("SELECT COALESCE(SUM(cents),0) c FROM tip_payouts WHERE method = 'cash' AND period_to BETWEEN ? AND ?").get(from, to).c;
    return { totals: out, days };
  }
  staff.get('/deposits', requireAuth('owner'), (req, res) => {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const to = ok(req.query.to) ? req.query.to : addDays(localToday(), -1); const from = ok(req.query.from) ? req.query.from : addDays(to, -13);
    const deps = db.prepare('SELECT * FROM bank_deposits WHERE cover_to >= ? AND cover_from <= ? ORDER BY deposit_date DESC').all(from, to);
    let rates = {}; try { rates = JSON.parse(getSettings().fee_rates || '{}'); } catch { /* none */ }
    const feePct = { cash: 0, card: (rates.card?.[0] ?? 2.6), app: (rates.venmo?.[0] ?? 1.9) };
    const list = deps.map((d) => { const ex = expected(d.cover_from, d.cover_to).totals[d.source]; const fees = Math.round(ex * feePct[d.source] / 100); const diff = d.amount_cents - ex; return { ...d, expectedCents: ex, estFeesCents: fees, diffCents: diff, unexplainedCents: diff + fees, matched: Math.abs(diff + fees) <= Math.max(500, Math.round(ex * 0.01)) }; });
    const { days } = expected(from, to);
    const dayRows = days.map((d) => {
      const by = { cash: 0, card: 0, app: 0 }; for (const [m, c] of Object.entries(d.byMethod)) { const k = Object.keys(SRC).find((x) => SRC[x].includes(m)) || 'card'; by[k] += c; }
      const covered = Object.fromEntries(Object.keys(by).map((k) => [k, deps.some((x) => x.source === k && x.cover_from <= d.date && x.cover_to >= d.date)]));
      return { date: d.date, ...Object.fromEntries(Object.entries(by).map(([k, v]) => [`${k}Cents`, v])), covered };
    });
    res.json({ from, to, deposits: list, days: dayRows, providers: { stripe: stripeEnabled(), square: Boolean(h.squareOn?.()) } });
  });
  staff.post('/deposits', requireAuth('owner'), (req, res) => {
    const b = parse(z.object({ source: z.enum(['cash', 'card', 'app']), amountCents: z.number().int().min(1).max(1e9), depositDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), coverFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), coverTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reference: z.string().trim().max(60).optional(), note: z.string().trim().max(200).optional() }), req.body);
    if (b.coverTo < b.coverFrom) throw err('The last sales day is before the first');
    db.prepare('INSERT INTO bank_deposits (source, amount_cents, deposit_date, cover_from, cover_to, reference, note, created_by) VALUES (?,?,?,?,?,?,?,?)').run(b.source, b.amountCents, b.depositDate, b.coverFrom, b.coverTo, b.reference || null, b.note || null, req.user.id);
    audit(req.user, 'deposit.add', `${b.source} ${fmt(b.amountCents)} for ${b.coverFrom}..${b.coverTo}`, clientIp(req)); res.json({ ok: true });
  });
  staff.delete('/deposits/:id', requireAuth('owner'), (req, res) => { db.prepare('DELETE FROM bank_deposits WHERE id = ?').run(idParam(req)); audit(req.user, 'deposit.delete', `#${req.params.id}`, clientIp(req)); res.json({ ok: true }); });
  staff.post('/deposits/import', requireAuth('owner'), wrap(async (req, res) => {
    let added = 0; const notes = [];
    const ins = db.prepare("INSERT OR IGNORE INTO bank_deposits (source, amount_cents, deposit_date, cover_from, cover_to, reference, note, external_id, created_by) VALUES ('card', ?, ?, ?, ?, ?, ?, ?, ?)");
    const dayOf = (sec) => new Intl.DateTimeFormat('en-CA', { timeZone: currentTz() }).format(new Date(sec * 1000));
    if (stripeEnabled()) {
      const r = await stripe('GET', '/payouts?limit=30').catch((e) => { notes.push(`Stripe: ${e.message}`); return { data: [] }; });
      for (const p of r.data || []) { if (p.status !== 'paid' && p.status !== 'in_transit') continue; const d = dayOf(p.arrival_date); added += ins.run(p.amount, d, addDays(d, -2), addDays(d, -1), p.id, 'Stripe payout', `stripe:${p.id}`, req.user.id).changes; }
    }
    if (h.squareOn?.()) {
      const r = await h.squareGet?.(`/v2/payouts?location_id=${process.env.SQUARE_LOCATION_ID}&limit=30`).catch((e) => { notes.push(`Square: ${e.message}`); return { payouts: [] }; });
      for (const p of r?.payouts || []) { if (!['SENT', 'PAID'].includes(p.status)) continue; const d = (p.arrival_date || p.created_at || '').slice(0, 10); if (!d) continue; added += ins.run(Number(p.amount_money?.amount || 0), d, addDays(d, -1), addDays(d, -1), p.id, 'Square payout', `square:${p.id}`, req.user.id).changes; }
    }
    audit(req.user, 'deposit.import', `${added} payouts`, clientIp(req)); res.json({ added, notes });
  }));

  /* ===== menu engineering + prep list ===== */
  staff.get('/menu-engineering', mgr, (req, res) => res.json(menuEngineering(Math.min(180, Math.max(7, Number(req.query.days) || 30)))));
  staff.get('/prep', (req, res) => {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : addDays(localToday(), 1);
    res.json(prepList(d));
  });

  /* ===== jobs: overdue checklists, expired pending tickets ===== */
  setInterval(() => forEachLocation(async () => {
    const today = localToday();
    for (const l of checklistsFor(today).filter((x) => x.overdue)) if (once(`cl:${l.id}:${today}`)) await tellManagers(`${getSettings().business_name}: checklist overdue`, `${l.name} was due at ${l.dueTime}. ${l.count} of ${l.total} done.`, '/checklists');
    db.prepare("UPDATE tickets SET status = 'cancelled' WHERE status = 'pending' AND created_at < datetime('now','-45 minutes')").run();
  }), 10 * 60_000).unref();
}
