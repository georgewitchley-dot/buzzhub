// Round 8: happy hour pricing, combos, daily specials, customer display, recipe cards and training,
// supplier price watch, table timers, course firing, sales goals and contests.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, registerSchema, localToday, currentSlug, currentTz, forEachLocation, getJwtSecret } from './db.js';
import { menuHooks, menuWithMods } from './commerce.js';
import { pushToUsers } from './notify.js';
import { dayBounds } from './ops.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS price_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]', start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pct','amount','price')), value INTEGER NOT NULL, item_ids TEXT NOT NULL DEFAULT '[]', categories TEXT NOT NULL DEFAULT '[]',
  channels TEXT NOT NULL DEFAULT 'all', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS specials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, day TEXT, dow INTEGER, price_cents INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, price_cents INTEGER NOT NULL, slots TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  online INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS training_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', roles TEXT NOT NULL DEFAULT '["staff","manager"]', item_id INTEGER,
  required INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS training_progress (
  user_id INTEGER NOT NULL, module_id INTEGER NOT NULL, read_at TEXT, signed_by INTEGER, signed_at TEXT, PRIMARY KEY (user_id, module_id)
);
CREATE TABLE IF NOT EXISTS ingredient_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER NOT NULL, old_cents REAL, new_cents REAL NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')), alerted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ingredient_costs ON ingredient_costs(ingredient_id, id);
CREATE TABLE IF NOT EXISTS contests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, metric TEXT NOT NULL CHECK (metric IN ('items','sales','avg_ticket','orders')), item_ids TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]', starts TEXT NOT NULL, ends TEXT NOT NULL, prize TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS plus_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')));`);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const mi = cols('menu_items');
  if (!mi.includes('special_only')) db.exec('ALTER TABLE menu_items ADD COLUMN special_only INTEGER NOT NULL DEFAULT 0');
  if (!mi.includes('build_steps')) db.exec("ALTER TABLE menu_items ADD COLUMN build_steps TEXT NOT NULL DEFAULT '[]'");
  if (!mi.includes('photo_version')) db.exec("ALTER TABLE menu_items ADD COLUMN photo_version TEXT NOT NULL DEFAULT '0'");
  const oi = cols('order_items');
  if (!oi.includes('course')) db.exec('ALTER TABLE order_items ADD COLUMN course INTEGER NOT NULL DEFAULT 1');
  if (!oi.includes('fired_at')) db.exec('ALTER TABLE order_items ADD COLUMN fired_at TEXT');
  if (!cols('orders').includes('table_alerted')) db.exec('ALTER TABLE orders ADD COLUMN table_alerted INTEGER NOT NULL DEFAULT 0');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const parseJ = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };
const once = (key) => db.prepare('INSERT OR IGNORE INTO plus_alerts (key) VALUES (?)').run(key).changes > 0;
const localNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: currentTz(), weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hm: `${p.hour}:${p.minute}` };
};
const dowOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

/* ---------- specials + happy hour, applied to every menu the system builds ---------- */
export function todaysSpecials() {
  const today = localToday();
  return db.prepare('SELECT * FROM specials WHERE day = ? OR (day IS NULL AND dow = ?) ORDER BY id').all(today, dowOf(today));
}
function inWindow(rule, now) {
  const days = parseJ(rule.days, []); const st = rule.start_time; const en = rule.end_time;
  if (en > st) return days.includes(now.dow) && now.hm >= st && now.hm < en;
  // crosses midnight: belongs to the day it started
  return (days.includes(now.dow) && now.hm >= st) || (days.includes((now.dow + 6) % 7) && now.hm < en);
}
export function activeRules() {
  const now = localNow();
  return db.prepare('SELECT * FROM price_rules WHERE active = 1').all().filter((r) => inWindow(r, now));
}
menuHooks.adjust.push((items) => {
  const specials = todaysSpecials(); const sp = Object.fromEntries(specials.map((s) => [s.item_id, s]));
  const rules = activeRules();
  return items.filter((i) => !i.special_only || sp[i.id]).map((i) => {
    const regular = i.price_cents; let price = regular; let deal = null; let special = null;
    if (sp[i.id]) { special = { note: sp[i.id].note || '' }; if (sp[i.id].price_cents !== null) price = sp[i.id].price_cents; }
    for (const r of rules) {
      if (!parseJ(r.item_ids, []).includes(i.id) && !parseJ(r.categories, []).includes(i.category)) continue;
      const p = r.kind === 'pct' ? Math.round(price * (100 - r.value) / 100) : r.kind === 'amount' ? Math.max(0, price - r.value) : Math.min(price, r.value);
      if (p < price) { price = p; deal = r.name; }
    }
    return { ...i, price_cents: price, regularCents: price !== regular ? regular : undefined, deal: deal || undefined, special: special || undefined };
  });
});

/* ---------- combos ---------- */
const comboView = (c) => ({ id: c.id, name: c.name, description: c.description, priceCents: c.price_cents, slots: parseJ(c.slots, []), active: Boolean(c.active), online: Boolean(c.online) });
export function combosFor(menu, { online = false } = {}) {
  const byId = new Map(menu.map((m) => [m.id, m]));
  return db.prepare(`SELECT * FROM combos WHERE active = 1 ${online ? 'AND online = 1' : ''} ORDER BY sort, id`).all().map(comboView).map((c) => ({
    ...c, slots: c.slots.map((s) => ({ label: s.label, itemIds: menu.filter((m) => (s.itemIds || []).includes(m.id) || (s.categories || []).includes(m.category)).filter((m) => byId.has(m.id) && !m.soldOut).map((m) => m.id) })),
  })).filter((c) => c.slots.length && c.slots.every((s) => s.itemIds.length));
}
menuHooks.combo = (l, menu, pickMods) => {
  const c = db.prepare('SELECT * FROM combos WHERE id = ? AND active = 1').get(l.comboId);
  if (!c) throw err('That combo is no longer available');
  const slots = parseJ(c.slots, []);
  if (l.picks.length !== slots.length) throw err(`Choose one item for each part of the ${c.name}`);
  const parts = l.picks.map((p, i) => {
    const m = menu.get(p.itemId); const s = slots[i];
    if (!m || !((s.itemIds || []).includes(m.id) || (s.categories || []).includes(m.category))) throw err(`That choice isn't part of the ${c.name}`);
    const mods = pickMods(m, p.mods);
    return { m, mods, base: m.regularCents ?? m.price_cents };
  });
  const sumBase = parts.reduce((a, p) => a + p.base, 0) || 1;
  let left = c.price_cents;
  return parts.map((p, i) => {
    const share = i === parts.length - 1 ? left : Math.round(c.price_cents * p.base / sumBase); left -= share;
    return { item_id: p.m.id, name: `${p.m.name} (${c.name})`, qty: l.qty, price_cents: share + p.mods.reduce((a, o) => a + o.price_cents, 0), note: i === 0 ? l.note || null : null, mods: p.mods };
  });
};

/* ---------- customer display (long-poll, no extra sockets) ---------- */
const displays = new Map(); // `${slug}:${code}` -> { v, state }
const bus = new EventEmitter(); bus.setMaxListeners(500);

/* ---------- sales goals + contests ---------- */
function goalToday() {
  const goals = parseJ(getSettings().sales_goals, []);
  const g = Number(goals[dowOf(localToday())] || 0);
  if (!g) return null;
  const { start, end } = dayBounds(localToday());
  const sold = db.prepare("SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) c FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void'").get(start, end).c;
  return { goalCents: g, soldCents: sold, pct: Math.min(100, Math.round(sold * 100 / g)) };
}
function leaderboard(c) {
  const a = dayBounds(c.starts).start; const z2 = dayBounds(c.ends).end;
  const base = "FROM orders o JOIN users u ON u.id = o.created_by WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status <> 'void'";
  let rows;
  if (c.metric === 'items') {
    const ids = parseJ(c.item_ids, []); const cats = parseJ(c.categories, []);
    const itemIds = [...new Set([...ids, ...(cats.length ? db.prepare(`SELECT id FROM menu_items WHERE category IN (${cats.map(() => '?').join(',')})`).all(...cats).map((r) => r.id) : [])])];
    if (!itemIds.length) return [];
    rows = db.prepare(`SELECT u.id, u.name, SUM(oi.qty) score FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN users u ON u.id = o.created_by WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status <> 'void' AND oi.item_id IN (${itemIds.join(',')}) GROUP BY u.id ORDER BY score DESC`).all(a, z2);
  } else if (c.metric === 'sales') rows = db.prepare(`SELECT u.id, u.name, SUM(o.subtotal_cents - o.discount_cents) score ${base} GROUP BY u.id ORDER BY score DESC`).all(a, z2);
  else if (c.metric === 'orders') rows = db.prepare(`SELECT u.id, u.name, COUNT(*) score ${base} GROUP BY u.id ORDER BY score DESC`).all(a, z2);
  else rows = db.prepare(`SELECT u.id, u.name, CAST(AVG(o.subtotal_cents - o.discount_cents) AS INTEGER) score, COUNT(*) n ${base} GROUP BY u.id HAVING n >= 3 ORDER BY score DESC`).all(a, z2);
  return rows.map((r, i) => ({ rank: i + 1, userId: r.id, name: r.name.split(' ')[0], score: r.score }));
}

export function registerPlus({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, publicLimiter, notifyStaff } = h;
  const mgr = requireAuth('manager');
  const tellManagers = (title, body, url, tag = 'plus') => pushToUsers(['manager', 'owner'], { title, body, tag, url }).catch(() => {});

  /* ===== happy hour rules ===== */
  const ruleSchema = z.object({ name: z.string().trim().min(1).max(40), days: z.array(z.number().int().min(0).max(6)).min(1), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/),
    kind: z.enum(['pct', 'amount', 'price']), value: z.number().int().min(1).max(1_000_000), itemIds: z.array(z.number().int()).max(200).default([]), categories: z.array(z.string().max(24)).max(30).default([]), active: z.boolean().optional() });
  staff.get('/price-rules', mgr, (req, res) => res.json({ rules: db.prepare('SELECT * FROM price_rules ORDER BY active DESC, start_time').all().map((r) => ({ ...r, days: parseJ(r.days, []), item_ids: parseJ(r.item_ids, []), categories: parseJ(r.categories, []) })), live: activeRules().map((r) => r.id) }));
  const saveRule = (b, id) => {
    if (b.kind === 'pct' && b.value > 100) throw err('A percent off must be 100 or less');
    if (!b.itemIds.length && !b.categories.length) throw err('Pick the items or categories this applies to');
    if (b.start === b.end) throw err('Start and end times must be different');
    const args = [b.name, JSON.stringify(b.days), b.start, b.end, b.kind, b.value, JSON.stringify(b.itemIds), JSON.stringify(b.categories)];
    if (id) db.prepare('UPDATE price_rules SET name=?, days=?, start_time=?, end_time=?, kind=?, value=?, item_ids=?, categories=?, active=COALESCE(?, active) WHERE id=?').run(...args, b.active === undefined ? null : b.active ? 1 : 0, id);
    else db.prepare('INSERT INTO price_rules (name, days, start_time, end_time, kind, value, item_ids, categories) VALUES (?,?,?,?,?,?,?,?)').run(...args);
  };
  staff.post('/price-rules', mgr, (req, res) => { const b = parse(ruleSchema, req.body); saveRule(b); audit(req.user, 'pricing.rule', b.name, clientIp(req)); notifyStaff('menu'); res.json({ ok: true }); });
  staff.put('/price-rules/:id', mgr, (req, res) => { const b = parse(ruleSchema, req.body); saveRule(b, idParam(req)); audit(req.user, 'pricing.rule', b.name, clientIp(req)); notifyStaff('menu'); res.json({ ok: true }); });
  staff.delete('/price-rules/:id', mgr, (req, res) => { db.prepare('DELETE FROM price_rules WHERE id = ?').run(idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });

  /* ===== daily specials ===== */
  const specialView = (s) => { const m = db.prepare('SELECT name, price_cents, special_only FROM menu_items WHERE id = ?').get(s.item_id); return m ? { ...s, name: m.name, regularCents: m.price_cents, specialOnly: Boolean(m.special_only) } : null; };
  staff.get('/specials', mgr, (req, res) => res.json({ today: todaysSpecials().map(specialView).filter(Boolean), upcoming: db.prepare('SELECT * FROM specials WHERE day >= ? OR dow IS NOT NULL ORDER BY day, dow').all(localToday()).map(specialView).filter(Boolean) }));
  staff.post('/specials', mgr, (req, res) => {
    const b = parse(z.object({ itemId: z.number().int(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dow: z.number().int().min(0).max(6).optional(), priceCents: z.number().int().min(0).max(1_000_000).nullable().optional(), note: z.string().trim().max(120).optional(), specialOnly: z.boolean().optional() }), req.body);
    if (!b.day && b.dow === undefined) throw err('Pick a date, or a day of the week');
    if (!db.prepare('SELECT 1 FROM menu_items WHERE id = ?').get(b.itemId)) throw err('Item not found', 404);
    db.prepare('INSERT INTO specials (item_id, day, dow, price_cents, note) VALUES (?,?,?,?,?)').run(b.itemId, b.day || null, b.day ? null : b.dow, b.priceCents ?? null, b.note || null);
    if (b.specialOnly !== undefined) db.prepare('UPDATE menu_items SET special_only = ? WHERE id = ?').run(b.specialOnly ? 1 : 0, b.itemId);
    audit(req.user, 'special.add', `item ${b.itemId} ${b.day || `dow ${b.dow}`}`, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
  });
  staff.delete('/specials/:id', mgr, (req, res) => { db.prepare('DELETE FROM specials WHERE id = ?').run(idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });
  app.get('/api/public/specials', publicLimiter, (req, res) => res.json(todaysSpecials().map((s) => { const m = db.prepare('SELECT id, name, price_cents, description FROM menu_items WHERE id = ? AND active = 1').get(s.item_id); return m ? { id: m.id, name: m.name, description: m.description, note: s.note, priceCents: s.price_cents ?? m.price_cents } : null; }).filter(Boolean)));
  h.specialsLine = () => todaysSpecials().map((s) => db.prepare('SELECT name FROM menu_items WHERE id = ? AND active = 1').get(s.item_id)?.name).filter(Boolean);

  /* ===== combos ===== */
  const comboSchema = z.object({ name: z.string().trim().min(1).max(40), description: z.string().trim().max(200).optional(), priceCents: z.number().int().min(0).max(1_000_000),
    slots: z.array(z.object({ label: z.string().trim().min(1).max(30), itemIds: z.array(z.number().int()).max(100).default([]), categories: z.array(z.string().max(24)).max(20).default([]) })).min(2).max(6),
    online: z.boolean().default(true), active: z.boolean().optional() });
  const checkSlots = (b) => { for (const s of b.slots) if (!s.itemIds.length && !s.categories.length) throw err(`Pick items or a category for "${s.label}"`); };
  staff.get('/combos', mgr, (req, res) => res.json(db.prepare('SELECT * FROM combos ORDER BY active DESC, sort, id').all().map(comboView)));
  staff.post('/combos', mgr, (req, res) => { const b = parse(comboSchema, req.body); checkSlots(b); db.prepare('INSERT INTO combos (name, description, price_cents, slots, online) VALUES (?,?,?,?,?)').run(b.name, b.description || null, b.priceCents, JSON.stringify(b.slots), b.online ? 1 : 0); audit(req.user, 'combo.create', b.name, clientIp(req)); notifyStaff('menu'); res.json({ ok: true }); });
  staff.put('/combos/:id', mgr, (req, res) => { const b = parse(comboSchema, req.body); checkSlots(b); db.prepare('UPDATE combos SET name=?, description=?, price_cents=?, slots=?, online=?, active=COALESCE(?, active) WHERE id=?').run(b.name, b.description || null, b.priceCents, JSON.stringify(b.slots), b.online ? 1 : 0, b.active === undefined ? null : b.active ? 1 : 0, idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });
  staff.get('/combos/live', (req, res) => res.json(combosFor(menuWithMods())));
  app.get('/api/public/combos', publicLimiter, (req, res) => res.json(combosFor(menuWithMods({ where: 'active = 1 AND guest_orderable = 1' }), { online: true })));
  app.get('/api/public/combos/all', publicLimiter, (req, res) => res.json(combosFor(menuWithMods(), { online: true })));

  /* ===== customer display ===== */
  const dispSecret = () => `${getJwtSecret()}:display`;
  const dispAuth = (req) => {
    try { const p = jwt.verify(String(req.get('X-Display') || ''), dispSecret()); if (p.loc === currentSlug() && String(p.v) === String(getSettings().display_version || '1')) return p; } catch { /* bad */ }
    throw err('This display is signed out. A manager needs to start it again.', 401);
  };
  staff.post('/display/start', mgr, (req, res) => {
    const code = String(crypto.randomInt(1000, 10000));
    const token = jwt.sign({ kind: 'display', code, loc: currentSlug(), v: getSettings().display_version || '1' }, dispSecret(), { expiresIn: '365d' });
    audit(req.user, 'display.start', code, clientIp(req)); res.json({ token, code, loc: currentSlug() });
  });
  staff.post('/display/signout-all', mgr, (req, res) => { setSettings({ display_version: String(Number(getSettings().display_version || '1') + 1) }); res.json({ ok: true }); });
  staff.post('/display/push', (req, res) => {
    const b = parse(z.object({ code: z.string().regex(/^\d{4}$/), stage: z.enum(['idle', 'cart', 'tip', 'paid']), lines: z.array(z.object({ name: z.string().max(80), qty: z.number().int(), cents: z.number().int() })).max(60).default([]),
      subtotalCents: z.number().int().default(0), discountCents: z.number().int().default(0), taxCents: z.number().int().default(0), totalCents: z.number().int().default(0), tipBaseCents: z.number().int().optional(), message: z.string().max(80).optional() }), req.body);
    const key = `${currentSlug()}:${b.code}`; const cur = displays.get(key) || { v: 0 };
    const next = { v: cur.v + 1, state: { ...b, cashier: req.user.name.split(' ')[0], at: Date.now() } };
    displays.set(key, next); bus.emit(key, next); res.json({ ok: true });
  });
  app.get('/api/display', wrap(async (req, res) => {
    const p = dispAuth(req); const key = `${currentSlug()}:${p.code}`;
    const since = Number(req.query.v || -1); const s = getSettings();
    const send = (d) => res.json({ v: d?.v ?? 0, code: p.code, state: d?.state || { stage: 'idle' }, business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null }, currency: s.currency, tips: [15, 18, 20, 25] });
    const cur = displays.get(key);
    if ((cur?.v ?? 0) !== since) return send(cur);
    const t = setTimeout(() => { bus.off(key, on); send(displays.get(key)); }, 25_000);
    function on(d) { clearTimeout(t); bus.off(key, on); send(d); }
    bus.on(key, on); req.on('close', () => { clearTimeout(t); bus.off(key, on); });
  }));
  app.post('/api/display/tip', publicLimiter, (req, res) => {
    const p = dispAuth(req);
    const b = parse(z.object({ pct: z.number().int().min(0).max(50).optional(), cents: z.number().int().min(0).max(100000).optional() }), req.body);
    io.to('staff').emit('display:tip', { code: p.code, pct: b.pct ?? null, cents: b.cents ?? null });
    const key = `${currentSlug()}:${p.code}`; const cur = displays.get(key);
    if (cur) { const next = { v: cur.v + 1, state: { ...cur.state, tipChosen: b } }; displays.set(key, next); bus.emit(key, next); }
    res.json({ ok: true });
  });

  /* ===== recipe cards ===== */
  staff.get('/menu/:id/card', (req, res) => {
    const m = db.prepare('SELECT id, name, category, description, allergens, build_steps, photo_version FROM menu_items WHERE id = ?').get(idParam(req)); if (!m) throw err('Not found', 404);
    const recipe = db.prepare('SELECT g.name, r.qty, g.unit FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ? ORDER BY g.name').all(m.id);
    res.json({ id: m.id, name: m.name, category: m.category, description: m.description, allergens: parseJ(m.allergens, []), steps: parseJ(m.build_steps, []), photo: m.photo_version !== '0' ? `/api/staff/menu/${m.id}/photo?v=${m.photo_version}` : null, recipe });
  });
  staff.put('/menu/:id/card', mgr, (req, res) => {
    const b = parse(z.object({ steps: z.array(z.string().trim().min(1).max(240)).max(30), photo: z.string().max(900_000).nullable().optional() }), req.body);
    const id = idParam(req); if (!db.prepare('SELECT 1 FROM menu_items WHERE id = ?').get(id)) throw err('Not found', 404);
    db.prepare('UPDATE menu_items SET build_steps = ? WHERE id = ?').run(JSON.stringify(b.steps), id);
    if (b.photo === null) { db.prepare('DELETE FROM assets WHERE key = ?').run(`item:${id}`); db.prepare("UPDATE menu_items SET photo_version = '0' WHERE id = ?").run(id); }
    else if (b.photo) {
      const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.photo); if (!m) throw err('Upload a PNG, JPG or WebP image');
      const buf = Buffer.from(m[3], 'base64'); const sig = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] }[m[2]];
      if (buf.length > 600_000 || !sig.every((x, i) => buf[i] === x)) throw err('That file is not a valid image (max 600 KB)');
      db.prepare("INSERT INTO assets (key, mime, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=datetime('now')").run(`item:${id}`, m[1], buf);
      db.prepare('UPDATE menu_items SET photo_version = ? WHERE id = ?').run(String(Date.now()), id);
    }
    audit(req.user, 'menu.card', `item ${id}`, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
  });
  staff.get('/menu/:id/photo', (req, res) => {
    const a = db.prepare('SELECT mime, data FROM assets WHERE key = ?').get(`item:${idParam(req)}`); if (!a) return res.status(404).end();
    res.set('Content-Type', a.mime).set('Cache-Control', 'private, max-age=86400').send(a.data);
  });

  /* ===== training ===== */
  const modsFor = (role) => db.prepare('SELECT * FROM training_modules WHERE active = 1 ORDER BY sort, id').all().filter((m) => role === 'owner' || parseJ(m.roles, []).includes(role));
  staff.get('/training/me', (req, res) => {
    const prog = Object.fromEntries(db.prepare('SELECT * FROM training_progress WHERE user_id = ?').all(req.user.id).map((p) => [p.module_id, p]));
    res.json(modsFor(req.user.role).map((m) => ({ id: m.id, title: m.title, body: m.body, itemId: m.item_id, required: Boolean(m.required), readAt: prog[m.id]?.read_at || null, signedAt: prog[m.id]?.signed_at || null })));
  });
  staff.post('/training/:id/read', (req, res) => {
    db.prepare("INSERT INTO training_progress (user_id, module_id, read_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_id, module_id) DO UPDATE SET read_at = COALESCE(read_at, excluded.read_at)").run(req.user.id, idParam(req));
    notifyStaff('training'); res.json({ ok: true });
  });
  staff.get('/training', mgr, (req, res) => {
    const modules = db.prepare('SELECT * FROM training_modules ORDER BY active DESC, sort, id').all().map((m) => ({ ...m, roles: parseJ(m.roles, []) }));
    const users = db.prepare("SELECT id, name, role, created_at FROM users WHERE active = 1 ORDER BY name").all();
    const prog = db.prepare('SELECT * FROM training_progress').all();
    res.json({ modules, people: users.map((u) => { const mine = modules.filter((m) => m.active && m.roles.includes(u.role)); const p = prog.filter((x) => x.user_id === u.id);
      return { id: u.id, name: u.name, role: u.role, total: mine.filter((m) => m.required).length, signed: mine.filter((m) => m.required && p.some((x) => x.module_id === m.id && x.signed_at)).length,
        items: mine.map((m) => { const x = p.find((y) => y.module_id === m.id); return { moduleId: m.id, title: m.title, readAt: x?.read_at || null, signedAt: x?.signed_at || null }; }) }; }) });
  });
  const modSchema = z.object({ title: z.string().trim().min(1).max(80), body: z.string().max(8000).default(''), roles: z.array(z.enum(['staff', 'manager', 'owner'])).min(1), itemId: z.number().int().nullable().optional(), required: z.boolean().default(true), active: z.boolean().optional() });
  staff.post('/training', mgr, (req, res) => { const b = parse(modSchema, req.body); db.prepare('INSERT INTO training_modules (title, body, roles, item_id, required) VALUES (?,?,?,?,?)').run(b.title, b.body, JSON.stringify(b.roles), b.itemId ?? null, b.required ? 1 : 0); notifyStaff('training'); res.json({ ok: true }); });
  staff.put('/training/:id', mgr, (req, res) => { const b = parse(modSchema, req.body); db.prepare('UPDATE training_modules SET title=?, body=?, roles=?, item_id=?, required=?, active=COALESCE(?, active) WHERE id=?').run(b.title, b.body, JSON.stringify(b.roles), b.itemId ?? null, b.required ? 1 : 0, b.active === undefined ? null : b.active ? 1 : 0, idParam(req)); notifyStaff('training'); res.json({ ok: true }); });
  staff.post('/training/:id/signoff', mgr, (req, res) => {
    const b = parse(z.object({ userId: z.number().int(), undo: z.boolean().optional() }), req.body);
    if (b.userId === req.user.id && req.user.role !== 'owner') throw err('Another manager needs to sign off your own training', 403);
    if (b.undo) db.prepare('UPDATE training_progress SET signed_by = NULL, signed_at = NULL WHERE user_id = ? AND module_id = ?').run(b.userId, idParam(req));
    else db.prepare("INSERT INTO training_progress (user_id, module_id, read_at, signed_by, signed_at) VALUES (?, ?, datetime('now'), ?, datetime('now')) ON CONFLICT(user_id, module_id) DO UPDATE SET signed_by = excluded.signed_by, signed_at = excluded.signed_at").run(b.userId, idParam(req), req.user.id);
    audit(req.user, b.undo ? 'training.unsign' : 'training.signoff', `user ${b.userId} module ${req.params.id}`, clientIp(req)); notifyStaff('training'); res.json({ ok: true });
  });
  staff.post('/training/from-menu', mgr, (req, res) => {
    let n = 0;
    for (const m of db.prepare("SELECT id, name, build_steps FROM menu_items WHERE active = 1 AND build_steps <> '[]'").all()) {
      if (db.prepare('SELECT 1 FROM training_modules WHERE item_id = ?').get(m.id)) continue;
      db.prepare('INSERT INTO training_modules (title, body, roles, item_id, required) VALUES (?,?,?,?,1)').run(`How to make: ${m.name}`, parseJ(m.build_steps, []).map((s, i) => `${i + 1}. ${s}`).join('\n'), JSON.stringify(['staff', 'manager']), m.id); n += 1;
    }
    notifyStaff('training'); res.json({ added: n });
  });

  /* ===== supplier price watch ===== */
  function dishesFor(ingId, oldC, newC) {
    return db.prepare('SELECT m.id, m.name, m.price_cents, r.qty FROM item_recipes r JOIN menu_items m ON m.id = r.item_id WHERE r.ingredient_id = ? AND m.active = 1').all(ingId).map((d) => {
      const cost = db.prepare('SELECT SUM(r.qty * g.cost_cents) c FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ?').get(d.id).c || 0;
      const before = cost - d.qty * (newC - oldC);
      return { id: d.id, name: d.name, priceCents: d.price_cents, costBefore: Math.round(before), costNow: Math.round(cost), lostCents: Math.round(cost - before), marginPctBefore: d.price_cents ? Math.round((1 - before / d.price_cents) * 100) : 0, marginPctNow: d.price_cents ? Math.round((1 - cost / d.price_cents) * 100) : 0 };
    });
  }
  function scanCosts() {
    const pct = Number(getSettings().price_watch_pct || 5);
    for (const g of db.prepare('SELECT id, name, unit, cost_cents FROM ingredients').all()) {
      const last = db.prepare('SELECT new_cents FROM ingredient_costs WHERE ingredient_id = ? ORDER BY id DESC LIMIT 1').get(g.id);
      if (!last) { db.prepare('INSERT INTO ingredient_costs (ingredient_id, old_cents, new_cents, alerted) VALUES (?, NULL, ?, 1)').run(g.id, g.cost_cents); continue; }
      if (Math.abs(last.new_cents - g.cost_cents) < 0.005) continue;
      const up = last.new_cents > 0 ? ((g.cost_cents - last.new_cents) / last.new_cents) * 100 : 0;
      db.prepare('INSERT INTO ingredient_costs (ingredient_id, old_cents, new_cents, alerted) VALUES (?, ?, ?, ?)').run(g.id, last.new_cents, g.cost_cents, up >= pct ? 1 : 0);
      if (up >= pct) {
        const hit = dishesFor(g.id, last.new_cents, g.cost_cents);
        tellManagers(`${getSettings().business_name}: ${g.name} costs ${Math.round(up)}% more`, `${hit.length ? `${hit.length} dish${hit.length === 1 ? '' : 'es'} lost profit: ${hit.slice(0, 3).map((d) => d.name).join(', ')}.` : 'No recipes use it yet.'} Check Price watch.`, '/purchasing', `cost-${g.id}`);
      }
    }
  }
  h.scanCosts = scanCosts;
  staff.get('/price-watch', mgr, (req, res) => {
    scanCosts();
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
    const rows = db.prepare(`SELECT c.*, g.name, g.unit FROM ingredient_costs c JOIN ingredients g ON g.id = c.ingredient_id WHERE c.old_cents IS NOT NULL AND c.at > datetime('now', ?) ORDER BY c.id DESC`).all(`-${days} days`);
    res.json({ thresholdPct: Number(getSettings().price_watch_pct || 5), changes: rows.map((r) => ({ id: r.id, ingredientId: r.ingredient_id, name: r.name, unit: r.unit, oldCents: r.old_cents, newCents: r.new_cents, pct: r.old_cents ? Math.round(((r.new_cents - r.old_cents) / r.old_cents) * 1000) / 10 : null, at: r.at, dishes: r.new_cents > r.old_cents ? dishesFor(r.ingredient_id, r.old_cents, r.new_cents) : [] })) });
  });

  /* ===== table timers + course firing ===== */
  staff.get('/table-timers', (req, res) => {
    const s = getSettings();
    const rows = db.prepare("SELECT t.id, t.label, t.seated_at, (SELECT MAX(COALESCE(oi.fired_at, o.created_at)) FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.table_id = t.id AND o.created_at >= t.seated_at) last_food, (SELECT COUNT(*) FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.table_id = t.id AND o.created_at >= t.seated_at AND oi.course > 1 AND oi.fired_at IS NULL) held, (SELECT COUNT(*) FROM orders o WHERE o.table_id = t.id AND o.created_at >= t.seated_at AND o.status IN ('open','sent')) cooking FROM tables t WHERE t.status = 'seated' AND t.seated_at IS NOT NULL").all();
    res.json({ longMinutes: Number(s.table_long_minutes || 90), slowMinutes: Number(s.kitchen_slow_minutes || 20), tables: rows.map((r) => ({ id: r.id, label: r.label, seatedAt: r.seated_at, lastFoodAt: r.last_food, held: r.held, cooking: r.cooking })) });
  });
  staff.post('/orders/:id/fire-course', (req, res) => {
    const b = parse(z.object({ course: z.number().int().min(2).max(3).optional() }), req.body || {});
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req)); if (!o) throw err('Not found', 404);
    const r = db.prepare(`UPDATE order_items SET fired_at = datetime('now') WHERE order_id = ? AND fired_at IS NULL ${b.course ? 'AND course = ?' : ''}`).run(...[o.id, ...(b.course ? [b.course] : [])]);
    if (!r.changes) throw err('Nothing is waiting to be fired', 409);
    if (o.status === 'ready') db.prepare("UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?").run(o.id);
    audit(req.user, 'order.fire', `#${o.number}${b.course ? ` course ${b.course}` : ''}`, clientIp(req)); notifyStaff('orders');
    io.to('staff').emit('security', { type: 'fire', detail: `Fire: order #${o.number}${o.table_id ? ` (table ${db.prepare('SELECT label FROM tables WHERE id = ?').get(o.table_id)?.label || ''})` : ''}` });
    res.json({ fired: r.changes });
  });

  /* ===== sales goals + contests ===== */
  staff.get('/goals', (req, res) => {
    const today = localToday();
    const live = db.prepare('SELECT * FROM contests WHERE active = 1 AND starts <= ? AND ends >= ? ORDER BY ends').all(today, today);
    res.json({ goal: goalToday(), contests: live.map((c) => { const board = leaderboard(c); return { id: c.id, name: c.name, metric: c.metric, prize: c.prize, ends: c.ends, top: board.slice(0, 3), me: board.find((x) => x.userId === req.user.id) || null }; }) });
  });
  const contestSchema = z.object({ name: z.string().trim().min(1).max(60), metric: z.enum(['items', 'sales', 'avg_ticket', 'orders']), itemIds: z.array(z.number().int()).max(100).default([]), categories: z.array(z.string().max(24)).max(20).default([]),
    starts: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ends: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), prize: z.string().trim().max(80).optional(), active: z.boolean().optional() });
  staff.get('/contests', mgr, (req, res) => res.json(db.prepare('SELECT * FROM contests ORDER BY ends DESC LIMIT 50').all().map((c) => ({ ...c, item_ids: parseJ(c.item_ids, []), categories: parseJ(c.categories, []), board: leaderboard(c) }))));
  staff.post('/contests', mgr, (req, res) => {
    const b = parse(contestSchema, req.body);
    if (b.ends < b.starts) throw err('The end date is before the start');
    if (b.metric === 'items' && !b.itemIds.length && !b.categories.length) throw err('Pick the items or categories to count');
    db.prepare('INSERT INTO contests (name, metric, item_ids, categories, starts, ends, prize) VALUES (?,?,?,?,?,?,?)').run(b.name, b.metric, JSON.stringify(b.itemIds), JSON.stringify(b.categories), b.starts, b.ends, b.prize || null);
    audit(req.user, 'contest.create', b.name, clientIp(req)); notifyStaff('goals'); res.json({ ok: true });
  });
  staff.put('/contests/:id', mgr, (req, res) => { const b = parse(contestSchema, req.body); db.prepare('UPDATE contests SET name=?, metric=?, item_ids=?, categories=?, starts=?, ends=?, prize=?, active=COALESCE(?, active) WHERE id=?').run(b.name, b.metric, JSON.stringify(b.itemIds), JSON.stringify(b.categories), b.starts, b.ends, b.prize || null, b.active === undefined ? null : b.active ? 1 : 0, idParam(req)); notifyStaff('goals'); res.json({ ok: true }); });

  /* ===== jobs: long tables, slow tickets, goal hit, cost scan ===== */
  setInterval(() => forEachLocation(async () => {
    const s = getSettings(); const name = s.business_name; const today = localToday();
    const longM = Number(s.table_long_minutes || 0); const slowM = Number(s.kitchen_slow_minutes || 0);
    if (longM) for (const t of db.prepare("SELECT id, label, seated_at FROM tables WHERE status = 'seated' AND seated_at IS NOT NULL AND seated_at < datetime('now', ?)").all(`-${longM} minutes`))
      if (once(`tl:${t.id}:${t.seated_at}`)) { io.to('staff').emit('security', { type: 'table', detail: `Table ${t.label} has been seated over ${longM} minutes` }); await tellManagers(`${name}: table ${t.label} seated ${longM}+ min`, 'Check in on them: dessert, the check, or a quick hello.', '/floor', `table-${t.id}`); }
    if (slowM) for (const o of db.prepare("SELECT o.id, o.number, t.label FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.status = 'sent' AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.fired_at IS NOT NULL AND oi.fired_at < datetime('now', ?)) AND o.created_at > datetime('now','-6 hours')").all(`-${slowM} minutes`))
      if (once(`slow:${o.id}`)) { io.to('staff').emit('security', { type: 'slow', detail: `Order #${o.number}${o.label ? ` (table ${o.label})` : ''} has been cooking over ${slowM} minutes` }); await tellManagers(`${name}: order #${o.number} is slow`, `Cooking over ${slowM} minutes${o.label ? ` for table ${o.label}` : ''}.`, '/kitchen', `slow-${o.id}`); }
    const g = goalToday();
    if (g && g.soldCents >= g.goalCents && once(`goal:${today}`)) { io.to('staff').emit('security', { type: 'goal', detail: "Today's sales goal is hit. Nice work, team!" }); await pushToUsers(['staff', 'manager', 'owner'], { title: `${name}: goal hit!`, body: "Today's sales goal is done. Nice work, team!", tag: 'goal', url: '/register' }).catch(() => {}); }
    scanCosts();
  }), 60_000).unref();
}
