// Round 16: seat numbers (schema), pass timer, screen-to-screen messages, batch timers, online order slots,
// pickup shelves, curbside ETA, who made it (cook on area screens), dish ratings, schedules by area.
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentTz, currentSlug, getJwtSecret, forEachLocation } from './db.js';
import { userFromToken, SESSION_COOKIE } from './security.js';
import { dayBounds } from './ops.js';
import { whosOn } from './timeclock.js';
import { stationFor, stationList } from './kds.js';
import { pushToUsers } from './notify.js';

registerSchema((db) => {
  const oi = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
  if (!oi.includes('seat')) db.exec('ALTER TABLE order_items ADD COLUMN seat INTEGER');
  if (!oi.includes('done_by')) db.exec('ALTER TABLE order_items ADD COLUMN done_by INTEGER');
  const o = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  for (const [c, t] of [['pass_alerted', 'TEXT'], ['promised_at', 'TEXT'], ['shelf', 'TEXT'], ['eta_minutes', 'INTEGER'], ['eta_km', 'REAL'], ['eta_at', 'TEXT']]) if (!o.includes(c)) db.exec(`ALTER TABLE orders ADD COLUMN ${c} ${t}`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS kds_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_area TEXT NOT NULL, to_area TEXT NOT NULL, body TEXT NOT NULL, by_label TEXT, at TEXT NOT NULL DEFAULT (datetime('now')), ack_at TEXT, ack_by TEXT);
  CREATE TABLE IF NOT EXISTS kds_timers (id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT NOT NULL, name TEXT NOT NULL, minutes REAL NOT NULL, repeat INTEGER NOT NULL DEFAULT 1, due_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS dish_ratings (id INTEGER PRIMARY KEY AUTOINCREMENT, feedback_id INTEGER NOT NULL, item_id INTEGER, name TEXT NOT NULL, liked INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (feedback_id, name));`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const ms = (sql) => Date.parse(`${String(sql).replace(' ', 'T')}Z`);
const sqlAt = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dist = (a, b, c, d) => { const R = 6371000; const r = Math.PI / 180; const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
/** Local "YYYY-MM-DD HH:MM" → UTC sql time, using the business time zone. */
function localToUtc(local) {
  const guess = Date.parse(`${local.replace(' ', 'T')}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: currentTz(), timeZoneName: 'shortOffset' }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(parts.timeZoneName || ''); const off = m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 0;
  return sqlAt(guess - off * 60000);
}
const toLocalHM = (sql) => new Intl.DateTimeFormat('en-GB', { timeZone: currentTz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms(sql)));

/** Shelves/cubbies from the setting: "A1-A6, B1-B6" or a count like "12". */
export function shelfList() {
  const raw = String(getSettings().pickup_shelves || '').trim(); if (!raw) return [];
  if (/^\d+$/.test(raw)) return Array.from({ length: Math.min(200, Number(raw)) }, (_, i) => String(i + 1));
  const out = [];
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const m = /^([A-Za-z]*)(\d+)-\1?(\d+)$/.exec(part);
    if (m) for (let i = Number(m[2]); i <= Number(m[3]) && out.length < 200; i++) out.push(`${m[1]}${i}`); else out.push(part.slice(0, 8));
  }
  return [...new Set(out)];
}
export const shelvesInUse = () => db.prepare("SELECT shelf FROM orders WHERE shelf IS NOT NULL AND handed_at IS NULL AND status <> 'void' AND created_at > datetime('now','-8 hours')").all().map((r) => r.shelf);

export function registerPass({ app, staff, h }) {
  const { parse, clientIp, requireAuth, notifyStaff, publicLimiter } = h;
  const mgr = requireAuth('manager');
  const secret = () => `${getJwtSecret()}:kds`;
  const who = (req) => {
    const t = req.get('X-Kds');
    if (t) { try { const p = jwt.verify(t, secret()); if (p.loc === currentSlug() && String(p.v) === String(getSettings().kds_version || '1')) return { area: p.area, user: null }; } catch { /* bad */ } throw err('This kitchen screen is signed out.', 401); }
    let user = null; try { user = req.cookies?.[SESSION_COOKIE] ? userFromToken(req.cookies[SESSION_COOKIE]) : null; } catch { user = null; }
    if (!user) throw err('Sign in first', 401);
    return { area: String(req.query.area || req.body?.area || 'All areas'), user };
  };
  const label = (w) => (w.user ? w.user.name.split(' ')[0] : w.area);

  /* ===== extra data for each area screen ===== */
  h.kdsExtra = (area) => {
    const s = getSettings();
    const messages = db.prepare("SELECT * FROM kds_messages WHERE (to_area = ? OR to_area = 'All' OR from_area = ?) AND at > datetime('now','-45 minutes') ORDER BY id DESC LIMIT 12").all(area, area)
      .map((m) => ({ id: m.id, from: m.from_area, to: m.to_area, body: m.body, by: m.by_label, at: m.at, acked: Boolean(m.ack_at), ackBy: m.ack_by, mine: m.from_area === area }));
    const timers = db.prepare('SELECT * FROM kds_timers WHERE area = ? ORDER BY id').all(area).map((t) => ({ id: t.id, name: t.name, minutes: t.minutes, repeat: Boolean(t.repeat), dueAt: t.due_at }));
    const crew = whosOn().filter((p) => !p.onBreak).map((p) => ({ id: p.userId, name: p.name.split(' ')[0] }));
    return { messages, timers, crew, passMinutes: Number(s.pass_alert_minutes || 0), shelves: s.pickup_shelves ? shelfList() : [], shelvesUsed: shelvesInUse(),
      quick: pj(s.kds_quick_messages, ['Need 2 more fries', 'Need hands here', 'Behind, 5 minutes', 'Fire the next course', '86 coming', 'Pick up at the pass']) };
  };

  /* ===== screen-to-screen messages ===== */
  app.post('/api/kds/msg', (req, res) => {
    const w = who(req); const b = parse(z.object({ to: z.string().trim().min(1).max(24), body: z.string().trim().min(1).max(120) }), req.body);
    const valid = [...stationList(), 'Expo', 'Packing', 'All areas', 'All'];
    if (!valid.includes(b.to)) throw err('Pick an area');
    db.prepare('INSERT INTO kds_messages (from_area, to_area, body, by_label) VALUES (?,?,?,?)').run(w.area, b.to, b.body, label(w));
    notifyStaff('kds'); res.json({ ok: true });
  });
  app.post('/api/kds/msg/:id/ack', (req, res) => { const w = who(req); db.prepare("UPDATE kds_messages SET ack_at = datetime('now'), ack_by = ? WHERE id = ? AND ack_at IS NULL").run(`${label(w)}${w.user ? '' : ` (${w.area})`}`, Number(req.params.id)); notifyStaff('kds'); res.json({ ok: true }); });

  /* ===== batch timers ===== */
  app.post('/api/kds/timers', (req, res) => {
    const w = who(req); const b = parse(z.object({ name: z.string().trim().min(1).max(30), minutes: z.number().min(0.5).max(240), repeat: z.boolean().default(true) }), req.body);
    if (db.prepare('SELECT COUNT(*) c FROM kds_timers WHERE area = ?').get(w.area).c >= 8) throw err('Up to 8 timers per area');
    db.prepare('INSERT INTO kds_timers (area, name, minutes, repeat, due_at) VALUES (?,?,?,?,?)').run(w.area, b.name, b.minutes, b.repeat ? 1 : 0, sqlAt(Date.now() + b.minutes * 60000)); res.json({ ok: true });
  });
  app.post('/api/kds/timers/:id/:what', (req, res) => {
    const w = who(req); const t = db.prepare('SELECT * FROM kds_timers WHERE id = ? AND area = ?').get(Number(req.params.id), w.area); if (!t) throw err('Not found', 404);
    if (req.params.what === 'restart') db.prepare('UPDATE kds_timers SET due_at = ? WHERE id = ?').run(sqlAt(Date.now() + t.minutes * 60000), t.id);
    else if (req.params.what === 'stop') db.prepare('UPDATE kds_timers SET due_at = NULL WHERE id = ?').run(t.id);
    else if (req.params.what === 'done') { if (t.repeat) db.prepare('UPDATE kds_timers SET due_at = ? WHERE id = ?').run(sqlAt(Date.now() + t.minutes * 60000), t.id); else db.prepare('UPDATE kds_timers SET due_at = NULL WHERE id = ?').run(t.id); }
    else if (req.params.what === 'delete') db.prepare('DELETE FROM kds_timers WHERE id = ?').run(t.id);
    else throw err('Unknown', 404);
    res.json({ ok: true });
  });

  /* ===== who made it ===== */
  h.cookFor = (body) => { const id = Number(body?.cookId); if (!id) return null; return db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(id)?.id || null; };

  /* ===== pass timer: food finished but not completed ===== */
  async function passCheck() {
    const s = getSettings(); const lim = Number(s.pass_alert_minutes || 0); if (!lim || s.kds_expo !== '1') return;
    for (const o of db.prepare("SELECT o.id, o.number, (SELECT MAX(done_at) FROM order_items WHERE order_id = o.id) last FROM orders o WHERE o.status IN ('open','sent') AND o.pass_alerted IS NULL AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = o.id AND done_at IS NULL AND (course <= 1 OR fired_at IS NOT NULL)) AND EXISTS (SELECT 1 FROM order_items WHERE order_id = o.id)").all()) {
      if (!o.last || Date.now() - ms(o.last) < lim * 60000) continue;
      db.prepare("UPDATE orders SET pass_alerted = datetime('now') WHERE id = ?").run(o.id);
      await pushToUsers(['staff', 'manager', 'owner'], { title: `#${o.number} waiting at the pass`, body: `Finished ${Math.round((Date.now() - ms(o.last)) / 60000)} minutes ago. Run it out.`, tag: `pass-${o.id}`, url: '/kitchen' }).catch(() => {});
    }
  }
  setInterval(() => forEachLocation(() => passCheck().catch((e) => console.error('pass check', e.message))), 30_000).unref();

  /* ===== online order slots ===== */
  const cap = () => Number(getSettings().slot_capacity || 0);
  const slotStart = (t) => Math.floor(t / 900000) * 900000;
  const countIn = (start) => db.prepare("SELECT COUNT(*) c FROM orders WHERE promised_at >= ? AND promised_at < ? AND status <> 'void'").get(sqlAt(start), sqlAt(start + 900000)).c;
  /** When this online order will be ready: the first slot with room at or after the kitchen's quote, or the chosen time. */
  h.slotFor = (scheduledFor) => {
    if (scheduledFor) { const at = ms(localToUtc(scheduledFor)); if (cap() && countIn(slotStart(at)) >= cap()) throw err('That pickup time is full. Please pick another time.', 409); return { promisedAt: sqlAt(at), minutes: Math.round((at - Date.now()) / 60000) }; }
    const q = h.quoteMinutes ? h.quoteMinutes().minutes : Number(getSettings().online_prep_minutes) || 15;
    let at = Date.now() + q * 60000;
    if (cap()) { let start = slotStart(at); for (let k = 0; k < 96 && countIn(start) >= cap(); k++) start += 900000; if (start > at) at = start; }
    return { promisedAt: sqlAt(at), minutes: Math.max(1, Math.round((at - Date.now()) / 60000)) };
  };
  h.slotQuote = () => h.slotFor().minutes;
  app.get('/api/o/slots', publicLimiter, (req, res) => {
    const d = String(req.query.date || localToday()); if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !cap()) return res.json({ capacity: cap(), full: [] });
    const { start, end } = dayBounds(d);
    const rows = db.prepare("SELECT promised_at FROM orders WHERE promised_at >= ? AND promised_at < ? AND status <> 'void'").all(start, end);
    const counts = {}; for (const r of rows) { const k = toLocalHM(sqlAt(slotStart(ms(r.promised_at)))); counts[k] = (counts[k] || 0) + 1; }
    res.json({ capacity: cap(), full: Object.entries(counts).filter(([, n]) => n >= cap()).map(([k]) => k) });
  });

  /* ===== pickup shelves ===== */
  h.shelfFree = () => { const used = new Set(shelvesInUse()); return shelfList().filter((x) => !used.has(x)); };
  app.post('/api/kds/shelf', (req, res) => {
    const w = who(req); const b = parse(z.object({ orderId: z.number().int(), shelf: z.string().trim().max(8).nullable() }), req.body);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(b.orderId); if (!o) throw err('Not found', 404);
    if (b.shelf && !shelfList().includes(b.shelf)) throw err('Unknown shelf');
    if (b.shelf && shelvesInUse().includes(b.shelf) && o.shelf !== b.shelf) throw err(`Shelf ${b.shelf} already has an order`, 409);
    db.prepare('UPDATE orders SET shelf = ? WHERE id = ?').run(b.shelf || null, o.id);
    audit(w.user, 'order.shelf', `#${o.number} → ${b.shelf || 'none'} (${label(w)})`, clientIp(req)); notifyStaff('orders'); if (o.guest_id) h.pushGuest?.(o.guest_id);
    res.json({ ok: true });
  });
  staff.post('/orders/:id/shelf', (req, res) => {
    const { shelf } = parse(z.object({ shelf: z.string().trim().max(8).nullable() }), req.body);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id)); if (!o) throw err('Not found', 404);
    db.prepare('UPDATE orders SET shelf = ? WHERE id = ?').run(shelf || null, o.id); notifyStaff('orders'); if (o.guest_id) h.pushGuest?.(o.guest_id); res.json({ ok: true });
  });
  h.shelfView = (g) => { if (!g.order_id) return null; const o = db.prepare('SELECT shelf, status FROM orders WHERE id = ?').get(g.order_id); return o?.shelf ? { shelf: o.shelf, ready: ['ready', 'paid'].includes(o.status) } : null; };

  /* ===== curbside ETA ===== */
  app.post('/api/g/:token/eta', publicLimiter, (req, res) => {
    const s = getSettings(); if (s.curbside !== '1') throw err('Curbside pickup is off', 403);
    const g = db.prepare('SELECT * FROM guests WHERE token = ?').get(String(req.params.token)); if (!g || g.kind !== 'order' || !g.order_id) throw err('Order not found', 404);
    const b = parse(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), stop: z.boolean().optional() }), req.body);
    if (b.stop) { db.prepare('UPDATE orders SET eta_minutes = NULL, eta_km = NULL, eta_at = NULL WHERE id = ?').run(g.order_id); notifyStaff('orders'); return res.json({ ok: true }); }
    if (!s.biz_lat || !s.biz_lng) throw err('The business location is not set up', 409);
    const m = dist(Number(s.biz_lat), Number(s.biz_lng), b.lat, b.lng); const km = Math.round(m / 100) / 10;
    const eta = m < 150 ? 0 : Math.max(1, Math.round(m / 1000 / (m < 3000 ? 25 : 45) * 60 + 1));
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(g.order_id);
    db.prepare("UPDATE orders SET eta_minutes = ?, eta_km = ?, eta_at = datetime('now') WHERE id = ?").run(eta, km, o.id);
    if (m < 150 && !o.arrived_at) { db.prepare("UPDATE orders SET arrived_at = datetime('now') WHERE id = ?").run(o.id); pushToUsers(['staff', 'manager', 'owner'], { title: `#${o.number} is here`, body: `${g.name.split(' ')[0]} just pulled up.`, tag: `here-${o.id}`, url: '/orders' }).catch(() => {}); }
    notifyStaff('orders'); res.json({ ok: true, etaMinutes: eta, km, arrived: m < 150 });
  });
  h.enRoute = () => db.prepare("SELECT o.id, o.number, o.eta_minutes, o.eta_km, o.eta_at, o.status, o.customer_name, g.name guest_name FROM orders o LEFT JOIN guests g ON g.id = o.guest_id WHERE o.eta_at > datetime('now','-10 minutes') AND o.arrived_at IS NULL AND o.handed_at IS NULL AND o.status <> 'void' ORDER BY o.eta_minutes").all()
    .map((o) => ({ id: o.id, number: o.number, name: o.customer_name || o.guest_name, etaMinutes: o.eta_minutes, km: o.eta_km, ready: ['ready', 'paid'].includes(o.status) }));

  /* ===== rate each dish ===== */
  h.feedbackDishes = (f) => {
    const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(f.guest_id); if (!g) return [];
    const rows = db.prepare(`SELECT DISTINCT oi.item_id, oi.name FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status <> 'void' AND oi.price_cents > 0 AND (o.guest_id = ? OR o.id = ? OR (o.table_id = ? AND o.created_at BETWEEN ? AND COALESCE(?, datetime('now')))) LIMIT 12`)
      .all(g.id, g.order_id || 0, g.table_id || 0, g.seated_at || g.created_at, g.closed_at);
    const mine = Object.fromEntries(db.prepare('SELECT name, liked FROM dish_ratings WHERE feedback_id = ?').all(f.id).map((r) => [r.name, r.liked]));
    return rows.map((r) => ({ itemId: r.item_id, name: r.name, liked: mine[r.name] ?? null }));
  };
  h.saveDishRatings = (f, list) => {
    const up = db.prepare('INSERT INTO dish_ratings (feedback_id, item_id, name, liked) VALUES (?,?,?,?) ON CONFLICT (feedback_id, name) DO UPDATE SET liked = excluded.liked');
    const allowed = new Map(h.feedbackDishes(f).map((d) => [d.name, d.itemId]));
    for (const d of list || []) if (allowed.has(d.name) && (d.liked === 0 || d.liked === 1)) up.run(f.id, allowed.get(d.name), d.name, d.liked);
  };
  staff.get('/dish-ratings', (req, res) => {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30)); const since = dayBounds(addDays(localToday(), -(days - 1))).start;
    const rows = db.prepare('SELECT name, SUM(liked) up, COUNT(*) n FROM dish_ratings WHERE at >= ? GROUP BY name ORDER BY n DESC').all(since);
    res.json({ days, dishes: rows.map((r) => ({ name: r.name, up: r.up, down: r.n - r.up, n: r.n, pct: Math.round((r.up / r.n) * 100) })) });
  });

  /* ===== who made it: speed and remakes per cook ===== */
  staff.get('/cook-stats', mgr, (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7)); const since = dayBounds(addDays(localToday(), -(days - 1))).start;
    const items = db.prepare("SELECT oi.done_by, u.name, oi.qty, (julianday(oi.done_at) - julianday(COALESCE(oi.fired_at, o.sent_at))) * 1440 m FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN users u ON u.id = oi.done_by WHERE oi.done_at >= ? AND oi.done_by IS NOT NULL").all(since);
    const rm = Object.fromEntries(db.prepare('SELECT oi.done_by u, COUNT(*) n FROM remakes r JOIN order_items oi ON oi.id = r.order_item_id WHERE r.at >= ? AND oi.done_by IS NOT NULL GROUP BY oi.done_by').all(since).map((r) => [r.u, r.n]));
    const by = new Map(); for (const i of items) { if (i.m < 0 || i.m > 240) continue; const a = by.get(i.done_by) || { userId: i.done_by, name: i.name, items: 0, minutes: 0, n: 0 }; a.items += i.qty; a.minutes += i.m; a.n++; by.set(i.done_by, a); }
    res.json({ days, cooks: [...by.values()].map((a) => ({ userId: a.userId, name: a.name, items: a.items, avgMinutes: Math.round((a.minutes / a.n) * 10) / 10, remakes: rm[a.userId] || 0, remakePct: Math.round(((rm[a.userId] || 0) / a.n) * 1000) / 10 })).sort((a, b) => b.items - a.items) });
  });

  /* ===== schedules by area: sales per area per weekday hour ===== */
  h.areaSalesByDow = (histFromStart, tzOff, today) => {
    const list = stationList(); const out = Object.fromEntries(list.map((a) => [a, Array.from({ length: 7 }, () => Array(24).fill(0))]));
    const rows = db.prepare(`SELECT substr(datetime(o.paid_at, '${tzOff} minutes'),1,10) d, CAST(substr(datetime(o.paid_at, '${tzOff} minutes'),12,2) AS INTEGER) hr, oi.qty * oi.price_cents c, m.category, m.station FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN menu_items m ON m.id = oi.item_id WHERE o.paid_at >= ? AND o.status <> 'void'`).all(histFromStart);
    for (const r of rows) { if (r.d >= today) continue; const a = stationFor(r, list); const dw = new Date(`${r.d}T12:00:00Z`).getUTCDay(); out[a][dw][r.hr] += r.c; }
    return out;
  };
}
