// Round 13: overtime guard, phone clock-in by location, punch photos, shift handoff notes, payroll files for Gusto and ADP,
// use-first stock (ingredient lots), table turn report, and private room bookings.
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, forEachLocation } from './db.js';
import { findUserByPin } from './security.js';
import { timeCard } from './timeclock.js';
import { dayBounds } from './ops.js';
import { emailEnabled, emailGuest, pushToUsers } from './notify.js';

registerSchema((db) => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS punch_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_punch_photos_at ON punch_photos(at);
  CREATE TABLE IF NOT EXISTS handoff_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS ingredient_lots (id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER NOT NULL, qty REAL NOT NULL, received_on TEXT NOT NULL, use_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','used','tossed')), source TEXT, alerted TEXT, closed_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_lots_open ON ingredient_lots(status, use_by);
  CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, capacity INTEGER NOT NULL DEFAULT 20, min_spend_cents INTEGER NOT NULL DEFAULT 0,
    deposit_pct REAL NOT NULL DEFAULT 0, fee_cents INTEGER NOT NULL DEFAULT 0, table_ids TEXT NOT NULL DEFAULT '[]', description TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS room_bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT, phone TEXT,
    date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, guests INTEGER NOT NULL, occasion TEXT, notes TEXT,
    status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','declined','cancelled','done')),
    min_spend_cents INTEGER NOT NULL DEFAULT 0, fee_cents INTEGER NOT NULL DEFAULT 0, deposit_cents INTEGER NOT NULL DEFAULT 0, deposit_paid_cents INTEGER NOT NULL DEFAULT 0,
    credit_code TEXT, source TEXT NOT NULL DEFAULT 'online', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_room_bookings_date ON room_bookings(date);`);
  const u = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!u.includes('payroll_id')) db.exec('ALTER TABLE users ADD COLUMN payroll_id TEXT');
  const g = db.prepare('PRAGMA table_info(ingredients)').all().map((c) => c.name);
  if (!g.includes('shelf_days')) db.exec('ALTER TABLE ingredients ADD COLUMN shelf_days INTEGER');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysUntil = (d) => Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${localToday()}T12:00:00Z`)) / 86400000);
const mins = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
const fmt = (c) => `$${(c / 100).toFixed(2)}`;
const csvCell = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? `'${s}` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');
const dist = (a, b, c, d) => { const R = 6371000; const r = Math.PI / 180; const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

/** Would clocking in now put this person into overtime this week? */
export function overtimeRisk(uid) {
  const s = getSettings(); if (s.ot_guard !== '1') return null;
  const c = timeCard(uid); const ot = c.overtimeAt;
  const planned = c.scheduledToday.reduce((h, x) => { let m = mins(x.end) - mins(x.start); if (m < 0) m += 1440; return h + m / 60; }, 0);
  const projected = c.weekHours + planned;
  if (c.weekHours >= ot - 0.01 || projected > ot + 0.01) return { weekHours: c.weekHours, projected: Math.round(projected * 10) / 10, overtimeAt: ot, already: c.weekHours >= ot - 0.01 };
  return null;
}
const otMessage = (r, name) => (r.already ? `${name} already has ${r.weekHours} hours this week (overtime starts at ${r.overtimeAt}).` : `Today's shift would bring ${name} to about ${r.projected} hours this week (overtime starts at ${r.overtimeAt}).`);

export function registerCrew({ app, staff, h }) {
  const { parse, clientIp, requireAuth, notifyStaff, wrap, publicBase, publicLimiter } = h;
  const mgr = requireAuth('manager'); const owner = requireAuth('owner');

  /* ===== overtime guard: used by the time clock, the lock screen, the phone and manager punches ===== */
  h.punchGuard = async ({ user, action, managerPin, approvedBy, ip, where }) => {
    if (action !== 'in' && action !== 'auto') return null;
    const r = overtimeRisk(user.id); if (!r) return null;
    if (approvedBy) { audit(approvedBy, 'overtime.approve', `${user.name}: ${r.projected} h`, ip); return { approvedBy: approvedBy.name }; }
    if (managerPin) {
      const m = await findUserByPin(managerPin);
      if (!m || !['manager', 'owner'].includes(m.role)) throw Object.assign(err('That PIN is not a manager PIN'), { status: 403, needsManager: true });
      if (m.id === user.id && m.role !== 'owner') throw Object.assign(err('A different manager has to approve your overtime'), { status: 403, needsManager: true });
      audit(m, 'overtime.approve', `${user.name}: ${r.projected} h (${where})`, ip); return { approvedBy: m.name };
    }
    throw Object.assign(err(`${otMessage(r, user.name.split(' ')[0])} A manager needs to approve.`), { status: 409, needsManager: true, overtime: r });
  };

  /* ===== phone clock-in by location ===== */
  h.phonePunchCheck = (b) => {
    const s = getSettings(); if (s.punch_geofence !== '1') return;
    const lat = Number(s.biz_lat); const lng = Number(s.biz_lng);
    if (!s.biz_lat || !s.biz_lng || Number.isNaN(lat)) throw err('Ask a manager to set the business location in Settings first.', 409);
    if (typeof b.lat !== 'number' || typeof b.lng !== 'number') throw err('Allow location so BuzzHub can check you are at work.', 400);
    const radius = Number(s.punch_radius_m) || 150; const d = dist(lat, lng, b.lat, b.lng);
    if (d > radius + Math.min(Number(b.acc) || 0, 100)) throw err(`You are about ${Math.round(d)} m away. Clock in when you are at work (within ${radius} m).`, 403);
  };

  /* ===== punch photos ===== */
  h.afterPunch = ({ user, result, photo }) => {
    if (!photo || getSettings().punch_photo !== '1' || !result) return;
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 120000) return;
    db.prepare('INSERT INTO punch_photos (user_id, action, data) VALUES (?, ?, ?)').run(user.id, result.action, photo);
  };
  staff.get('/punch-photos', mgr, (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : localToday(); const { start, end } = dayBounds(date);
    res.json({ date, photos: db.prepare('SELECT p.id, p.user_id, p.action, p.at, u.name FROM punch_photos p JOIN users u ON u.id = p.user_id WHERE p.at >= ? AND p.at < ? ORDER BY p.at DESC').all(start, end).map((p) => ({ ...p, url: `/api/staff/punch-photos/${p.id}` })) });
  });
  staff.get('/punch-photos/:id', mgr, (req, res) => {
    const p = db.prepare('SELECT data FROM punch_photos WHERE id = ?').get(Number(req.params.id)); if (!p) throw err('Not found', 404);
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('Cache-Control', 'private, max-age=3600'); res.send(Buffer.from(p.data.split(',')[1], 'base64'));
  });

  /* ===== shift handoff notes ===== */
  const recentNotes = (exceptUid) => db.prepare("SELECT n.id, n.body, n.at, u.name FROM handoff_notes n JOIN users u ON u.id = n.user_id WHERE n.at >= datetime('now','-24 hours') AND n.user_id <> ? ORDER BY n.at DESC LIMIT 6").all(exceptUid || 0);
  h.handoffFor = (uid) => (getSettings().handoff_notes === '0' ? [] : recentNotes(uid));
  h.addHandoff = (user, body, ip) => { const t = String(body || '').trim().slice(0, 600); if (!t) return; db.prepare('INSERT INTO handoff_notes (user_id, body) VALUES (?, ?)').run(user.id, t); audit(user, 'handoff.note', t.slice(0, 60), ip); notifyStaff('handoff'); };
  staff.get('/handoff', (req, res) => res.json(db.prepare("SELECT n.id, n.body, n.at, n.user_id, u.name FROM handoff_notes n JOIN users u ON u.id = n.user_id WHERE n.at >= datetime('now','-36 hours') ORDER BY n.at DESC LIMIT 20").all()));
  staff.post('/handoff', (req, res) => { const { body } = parse(z.object({ body: z.string().trim().min(1).max(600) }), req.body); h.addHandoff(req.user, body, clientIp(req)); res.json({ ok: true }); });
  staff.delete('/handoff/:id', (req, res) => {
    const n = db.prepare('SELECT * FROM handoff_notes WHERE id = ?').get(Number(req.params.id)); if (!n) throw err('Not found', 404);
    if (n.user_id !== req.user.id && !['manager', 'owner'].includes(req.user.role)) throw err('Only the writer or a manager can remove this', 403);
    db.prepare('DELETE FROM handoff_notes WHERE id = ?').run(n.id); notifyStaff('handoff'); res.json({ ok: true });
  });

  /* ===== payroll files ===== */
  staff.put('/users/:id/payroll-id', owner, (req, res) => {
    const { payrollId } = parse(z.object({ payrollId: z.string().trim().max(20) }), req.body);
    db.prepare('UPDATE users SET payroll_id = ? WHERE id = ?').run(payrollId || null, Number(req.params.id)); res.json({ ok: true });
  });
  h.payrollFile = (p, format) => {
    const ids = Object.fromEntries(db.prepare('SELECT id, payroll_id FROM users').all().map((u) => [u.id, u.payroll_id || '']));
    const split = (n) => { const parts = n.trim().split(/\s+/); return [parts[0], parts.slice(1).join(' ')]; };
    const money = (c) => (c / 100).toFixed(2);
    if (format === 'gusto') {
      return csv([['first_name', 'last_name', 'employee_id', 'regular_hours', 'overtime_hours', 'paycheck_tips'],
        ...p.people.map((x) => { const [f, l] = split(x.name); return [f, l, ids[x.userId], x.regular, x.overtime, money(x.tipsCents)]; })]);
    }
    const co = getSettings().adp_company_code || ''; const batch = `BH${p.to.replace(/-/g, '')}`;
    return csv([['Co Code', 'Batch ID', 'File #', 'Employee Name', 'Reg Hours', 'O/T Hours', 'Earnings 3 Code', 'Earnings 3 Amount'],
      ...p.people.map((x) => [co, batch, ids[x.userId], x.name, x.regular, x.overtime, x.tipsCents ? 'T' : '', x.tipsCents ? money(x.tipsCents) : ''])]);
  };
  staff.get('/payroll-ids', owner, (req, res) => res.json(db.prepare('SELECT id, name, payroll_id FROM users WHERE active = 1 ORDER BY name').all()));

  /* ===== use-first stock ===== */
  h.onReceive = (ingredientId, qty, source) => {
    const g = db.prepare('SELECT shelf_days FROM ingredients WHERE id = ?').get(ingredientId); if (!g?.shelf_days || qty <= 0) return;
    const today = localToday(); db.prepare('INSERT INTO ingredient_lots (ingredient_id, qty, received_on, use_by, source) VALUES (?,?,?,?,?)').run(ingredientId, qty, today, addDays(today, g.shelf_days), source || null);
  };
  const lotView = (l) => ({ ...l, daysLeft: daysUntil(l.use_by), state: daysUntil(l.use_by) < 0 ? 'expired' : daysUntil(l.use_by) <= 1 ? 'soon' : 'ok' });
  staff.get('/lots', (req, res) => {
    const lots = db.prepare("SELECT l.*, g.name, g.unit FROM ingredient_lots l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.status = 'open' ORDER BY l.use_by, l.id").all().map(lotView);
    const first = {}; for (const l of lots) if (!first[l.ingredient_id]) first[l.ingredient_id] = l.id;
    res.json({ lots: lots.map((l) => ({ ...l, useFirst: first[l.ingredient_id] === l.id && lots.filter((x) => x.ingredient_id === l.ingredient_id).length > 1 })),
      ingredients: db.prepare('SELECT id, name, unit, shelf_days FROM ingredients WHERE active = 1 ORDER BY name').all(),
      closed: db.prepare("SELECT l.*, g.name, g.unit FROM ingredient_lots l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.status <> 'open' ORDER BY l.closed_at DESC LIMIT 20").all() });
  });
  staff.post('/lots', (req, res) => {
    const b = parse(z.object({ ingredientId: z.number().int(), qty: z.number().positive().max(1e6), useBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body);
    const g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(b.ingredientId); if (!g) throw err('Ingredient not found', 404);
    const rec = b.receivedOn || localToday(); const useBy = b.useBy || (g.shelf_days ? addDays(rec, g.shelf_days) : null);
    if (!useBy) throw err('Set a use-by date, or how many days this keeps');
    db.prepare("INSERT INTO ingredient_lots (ingredient_id, qty, received_on, use_by, source) VALUES (?,?,?,?, 'manual')").run(g.id, b.qty, rec, useBy);
    audit(req.user, 'lot.add', `${b.qty} ${g.unit} ${g.name} use by ${useBy}`, clientIp(req)); notifyStaff('lots'); res.json({ ok: true });
  });
  staff.put('/ingredients/:id/shelf-days', mgr, (req, res) => { const { days } = parse(z.object({ days: z.number().int().min(0).max(730) }), req.body); db.prepare('UPDATE ingredients SET shelf_days = ? WHERE id = ?').run(days || null, Number(req.params.id)); notifyStaff('lots'); res.json({ ok: true }); });
  staff.post('/lots/:id/:what', (req, res) => {
    const l = db.prepare("SELECT l.*, g.name, g.unit, g.cost_cents, g.stock FROM ingredient_lots l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.id = ? AND l.status = 'open'").get(Number(req.params.id));
    if (!l) throw err('This batch is already closed', 409);
    if (req.params.what === 'used') db.prepare("UPDATE ingredient_lots SET status = 'used', closed_at = datetime('now') WHERE id = ?").run(l.id);
    else if (req.params.what === 'toss') {
      const { qty } = parse(z.object({ qty: z.number().positive().max(1e6).optional() }), req.body || {}); const q = qty || l.qty;
      db.transaction(() => {
        db.prepare("UPDATE ingredient_lots SET status = 'tossed', closed_at = datetime('now') WHERE id = ?").run(l.id);
        if (l.stock !== null) { db.prepare('UPDATE ingredients SET stock = stock - ? WHERE id = ?').run(q, l.ingredient_id); db.prepare("INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?, ?, 'waste: expired', ?)").run(l.ingredient_id, -q, req.user.id); }
        db.prepare("INSERT INTO waste_log (ingredient_id, name, qty, unit, reason, cost_cents, note, user_id) VALUES (?,?,?,?, 'expired', ?, ?, ?)").run(l.ingredient_id, l.name, q, l.unit, Math.round(l.cost_cents * q), `use by ${l.use_by}`, req.user.id);
      })();
      notifyStaff('waste');
    } else throw err('Unknown action', 404);
    audit(req.user, `lot.${req.params.what}`, `${l.name} (use by ${l.use_by})`, clientIp(req)); notifyStaff('lots'); res.json({ ok: true });
  });
  async function lotAlerts() {
    const s = getSettings(); const hr = Number(new Intl.DateTimeFormat('en-US', { timeZone: s.timezone || 'UTC', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    if (hr < 7) return; const today = localToday();
    const due = db.prepare("SELECT l.*, g.name, g.unit FROM ingredient_lots l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.status = 'open' AND l.use_by <= ? AND (l.alerted IS NULL OR l.alerted <> ?)").all(addDays(today, 1), today);
    if (!due.length) return;
    db.prepare(`UPDATE ingredient_lots SET alerted = ? WHERE id IN (${due.map((d) => d.id).join(',')})`).run(today);
    const text = due.map((d) => `${d.qty} ${d.unit} ${d.name} (${d.use_by < today ? 'expired' : d.use_by === today ? 'today' : 'tomorrow'})`).join(', ');
    await pushToUsers(['manager', 'owner'], { title: `${s.business_name}: use these first`, body: text, tag: `lots-${today}`, url: '/use-first' }).catch(() => {});
  }
  setInterval(() => forEachLocation(() => lotAlerts().catch((e) => console.error('lot alerts', e.message))), 15 * 60_000).unref();
  setInterval(() => forEachLocation(() => { try { db.prepare("DELETE FROM punch_photos WHERE at < datetime('now','-60 days')").run(); } catch { /* fine */ } }), 6 * 3600_000).unref();

  /* ===== table turn report ===== */
  staff.get('/table-turns', mgr, (req, res) => {
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    const since = dayBounds(addDays(localToday(), -(days - 1))).start;
    const rows = db.prepare(`SELECT g.id, g.party_size, g.seated_at, g.closed_at, t.id table_id, t.label, t.zone, t.seats, u.name server,
        (SELECT COALESCE(SUM(o.total_cents),0) FROM orders o WHERE o.status <> 'void' AND o.paid_at IS NOT NULL AND (o.guest_id = g.id OR (o.table_id = t.id AND o.created_at BETWEEN g.seated_at AND g.closed_at))) spend
      FROM guests g JOIN tables t ON t.id = g.table_id LEFT JOIN users u ON u.id = t.server_id
      WHERE g.kind = 'table' AND g.seated_at >= ? AND g.closed_at IS NOT NULL AND g.closed_at > g.seated_at`).all(since)
      .map((r) => ({ ...r, minutes: (Date.parse(`${r.closed_at.replace(' ', 'T')}Z`) - Date.parse(`${r.seated_at.replace(' ', 'T')}Z`)) / 60000 })).filter((r) => r.minutes >= 5 && r.minutes <= 600);
    const tz = getSettings().timezone || 'UTC';
    const dow = (ts) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(`${ts.replace(' ', 'T')}Z`));
    const hour = (ts) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(`${ts.replace(' ', 'T')}Z`)));
    const size = (n) => (n <= 2 ? '1–2' : n <= 4 ? '3–4' : n <= 6 ? '5–6' : '7+');
    const group = (key) => {
      const m = new Map(); for (const r of rows) { const k = key(r); const a = m.get(k) || { key: k, turns: 0, minutes: 0, spend: 0, covers: 0, list: [] }; a.turns++; a.minutes += r.minutes; a.spend += r.spend; a.covers += r.party_size; a.list.push(r.minutes); m.set(k, a); }
      return [...m.values()].map((a) => { const s = a.list.sort((x, y) => x - y); return { key: a.key, turns: a.turns, avgMinutes: Math.round(a.minutes / a.turns), medianMinutes: Math.round(s[Math.floor(s.length / 2)]), avgSpendCents: Math.round(a.spend / a.turns), spendPerCoverCents: a.covers ? Math.round(a.spend / a.covers) : 0, spendPerHourCents: a.minutes ? Math.round(a.spend / (a.minutes / 60)) : 0 }; });
    };
    const order = { '1–2': 1, '3–4': 2, '5–6': 3, '7+': 4 }; const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const tables = db.prepare('SELECT COUNT(*) c FROM tables').get().c;
    const bySize = group((r) => size(r.party_size)).sort((a, b) => order[a.key] - order[b.key]);
    const now = db.prepare("SELECT t.label, t.zone, t.seated_at, g.party_size, g.name FROM tables t LEFT JOIN guests g ON g.id = t.guest_id WHERE t.status = 'seated' AND t.seated_at IS NOT NULL").all()
      .map((t) => { const m = Math.round((Date.now() - Date.parse(`${t.seated_at.replace(' ', 'T')}Z`)) / 60000); const avg = bySize.find((x) => x.key === size(t.party_size || 2))?.avgMinutes || null; return { ...t, minutes: m, typical: avg, over: avg ? m > avg * 1.25 : false }; });
    res.json({ days, total: rows.length, turnsPerTablePerDay: tables ? Math.round((rows.length / tables / days) * 10) / 10 : 0,
      avgMinutes: rows.length ? Math.round(rows.reduce((a, r) => a + r.minutes, 0) / rows.length) : 0,
      bySize, byZone: group((r) => r.zone).sort((a, b) => b.turns - a.turns), byDay: group((r) => dow(r.seated_at)).sort((a, b) => dows.indexOf(a.key) - dows.indexOf(b.key)),
      byHour: group((r) => hour(r.seated_at)).sort((a, b) => a.key - b.key), byServer: group((r) => r.server || 'No server').sort((a, b) => b.turns - a.turns), seatedNow: now });
  });

  /* ===== private rooms ===== */
  const roomSchema = z.object({ name: z.string().trim().min(1).max(40), capacity: z.number().int().min(1).max(1000), minSpendCents: z.number().int().min(0).max(10_000_000), depositPct: z.number().min(0).max(100),
    feeCents: z.number().int().min(0).max(1_000_000).default(0), tableIds: z.array(z.number().int()).max(100).default([]), description: z.string().trim().max(300).optional(), active: z.boolean().optional() });
  const roomView = (r) => ({ ...r, table_ids: pj(r.table_ids, []) });
  const quote = (room) => { const deposit = Math.round(((room.min_spend_cents + room.fee_cents) * room.deposit_pct) / 100); return { minSpendCents: room.min_spend_cents, feeCents: room.fee_cents, depositCents: deposit }; };
  const clash = (roomId, date, st, en, exceptId) => db.prepare("SELECT id, name, start_time, end_time FROM room_bookings WHERE room_id = ? AND date = ? AND status IN ('requested','confirmed') AND id <> ?").all(roomId, date, exceptId || 0)
    .find((b) => mins(st) < mins(b.end_time) && mins(b.start_time) < mins(en));
  const bookingView = (b) => { const r = db.prepare('SELECT name, table_ids FROM rooms WHERE id = ?').get(b.room_id); return { ...b, room: r?.name || 'Room', tables: r ? db.prepare(`SELECT label FROM tables WHERE id IN (${pj(r.table_ids, []).map(Number).join(',') || 0})`).all().map((t) => t.label) : [] }; };
  const spendFor = (b) => {
    const r = db.prepare('SELECT table_ids FROM rooms WHERE id = ?').get(b.room_id); const ids = pj(r?.table_ids, []).map(Number); if (!ids.length) return 0;
    const { start } = dayBounds(b.date); const off = (Date.parse(`${b.date}T00:00:00Z`) - Date.parse(`${start.replace(' ', 'T')}Z`)) / 60000;
    const at = (t) => new Date(Date.parse(`${b.date}T00:00:00Z`) - off * 60000 + mins(t) * 60000).toISOString().replace('T', ' ').slice(0, 19);
    return db.prepare(`SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) c FROM orders WHERE status <> 'void' AND table_id IN (${ids.join(',')}) AND created_at BETWEEN ? AND ?`).get(at(b.start_time), at(b.end_time)).c;
  };
  const tellCustomer = (b, subject, message) => { if (!b.email || !emailEnabled()) return; const s = getSettings(); emailGuest(b.email, { businessName: s.business_name, subject, message, accent: s.accent, link: `${process.env.PUBLIC_URL || ''}/event-room/${b.token}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`, button: 'See your booking' }).catch(() => {}); };

  staff.get('/rooms', mgr, (req, res) => {
    const bookings = db.prepare('SELECT * FROM room_bookings WHERE date >= ? ORDER BY date, start_time').all(addDays(localToday(), -7)).map((b) => { const v = bookingView(b); return b.date === localToday() || b.status === 'done' ? { ...v, spendCents: spendFor(b) } : v; });
    res.json({ rooms: db.prepare('SELECT * FROM rooms ORDER BY name').all().map(roomView), bookings, tables: db.prepare('SELECT id, label, zone FROM tables ORDER BY zone, id').all(), link: `${publicBase(req)}/event-rooms${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}` });
  });
  staff.post('/rooms', mgr, (req, res) => { const b = parse(roomSchema, req.body); db.prepare('INSERT INTO rooms (name, capacity, min_spend_cents, deposit_pct, fee_cents, table_ids, description) VALUES (?,?,?,?,?,?,?)').run(b.name, b.capacity, b.minSpendCents, b.depositPct, b.feeCents, JSON.stringify(b.tableIds), b.description || null); audit(req.user, 'room.add', b.name, clientIp(req)); notifyStaff('rooms'); res.json({ ok: true }); });
  staff.put('/rooms/:id', mgr, (req, res) => { const b = parse(roomSchema, req.body); db.prepare('UPDATE rooms SET name=?, capacity=?, min_spend_cents=?, deposit_pct=?, fee_cents=?, table_ids=?, description=?, active=COALESCE(?, active) WHERE id=?').run(b.name, b.capacity, b.minSpendCents, b.depositPct, b.feeCents, JSON.stringify(b.tableIds), b.description || null, b.active === undefined ? null : b.active ? 1 : 0, Number(req.params.id)); notifyStaff('rooms'); res.json({ ok: true }); });
  const bookSchema = z.object({ roomId: z.number().int(), name: z.string().trim().min(1).max(60), email: z.string().trim().email().max(120).optional().or(z.literal('')), phone: z.string().trim().max(30).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), guests: z.number().int().min(1).max(1000), occasion: z.string().trim().max(60).optional(), notes: z.string().trim().max(600).optional() });
  const createBooking = (b, source) => {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND active = 1').get(b.roomId); if (!room) throw err('That room is not available');
    if (mins(b.end) <= mins(b.start)) throw err('The end time must be after the start time');
    if (b.date < localToday()) throw err('Pick a date in the future');
    if (b.guests > room.capacity) throw err(`${room.name} holds up to ${room.capacity} guests`);
    const c = clash(room.id, b.date, b.start, b.end); if (c) throw err(`${room.name} is already booked ${c.start_time}–${c.end_time} that day`, 409);
    const q = quote(room); const token = crypto.randomBytes(16).toString('base64url');
    const id = db.prepare('INSERT INTO room_bookings (room_id, token, name, email, phone, date, start_time, end_time, guests, occasion, notes, min_spend_cents, fee_cents, deposit_cents, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(room.id, token, b.name, b.email || null, b.phone || null, b.date, b.start, b.end, b.guests, b.occasion || null, b.notes || null, q.minSpendCents, q.feeCents, q.depositCents, source).lastInsertRowid;
    return db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(id);
  };
  staff.post('/rooms/bookings', mgr, (req, res) => { const b = parse(bookSchema, req.body); const bk = createBooking(b, 'staff'); db.prepare("UPDATE room_bookings SET status = 'confirmed' WHERE id = ?").run(bk.id); audit(req.user, 'room.book', `${bk.name} ${bk.date}`, clientIp(req)); notifyStaff('rooms'); res.json({ ok: true, token: bk.token }); });
  staff.post('/rooms/bookings/:id/:what', mgr, (req, res) => {
    const bk = db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(Number(req.params.id)); if (!bk) throw err('Not found', 404);
    const w = req.params.what;
    if (w === 'confirm') { const c = clash(bk.room_id, bk.date, bk.start_time, bk.end_time, bk.id); if (c && c.id) { /* the clash is another request */ } db.prepare("UPDATE room_bookings SET status = 'confirmed' WHERE id = ?").run(bk.id); tellCustomer(bk, 'Your event is confirmed', `Hi ${bk.name.split(' ')[0]}, your booking on ${bk.date} from ${bk.start_time} to ${bk.end_time} is confirmed.${bk.deposit_cents > bk.deposit_paid_cents ? ` Please pay the ${fmt(bk.deposit_cents - bk.deposit_paid_cents)} deposit to hold it.` : ''}`); }
    else if (w === 'decline' || w === 'cancel') { db.prepare('UPDATE room_bookings SET status = ? WHERE id = ?').run(w === 'decline' ? 'declined' : 'cancelled', bk.id); tellCustomer(bk, w === 'decline' ? 'About your event request' : 'Your event was cancelled', `Hi ${bk.name.split(' ')[0]}, ${w === 'decline' ? `we can't host your event on ${bk.date}. Please call us to find another time.` : `your booking on ${bk.date} has been cancelled.`}${bk.deposit_paid_cents ? ' We will be in touch about your deposit.' : ''}`); }
    else if (w === 'checkin') {
      if (bk.credit_code) return res.json({ ok: true, code: bk.credit_code });
      if (!bk.deposit_paid_cents) throw err('No deposit was paid for this booking');
      const card = h.issueCard({ cents: bk.deposit_paid_cents, name: `Room deposit: ${bk.name}`, email: bk.email, source: 'deposit', userId: req.user.id, method: 'card' });
      db.prepare('UPDATE room_bookings SET credit_code = ? WHERE id = ?').run(card.code, bk.id); audit(req.user, 'room.checkin', `${bk.name}: deposit ${fmt(bk.deposit_paid_cents)}`, clientIp(req)); notifyStaff('rooms'); return res.json({ ok: true, code: card.code });
    } else if (w === 'done') db.prepare("UPDATE room_bookings SET status = 'done' WHERE id = ?").run(bk.id);
    else if (w === 'paid') { const { cents } = parse(z.object({ cents: z.number().int().min(1).max(10_000_000) }), req.body); db.prepare('UPDATE room_bookings SET deposit_paid_cents = deposit_paid_cents + ? WHERE id = ?').run(cents, bk.id); }
    else throw err('Unknown action', 404);
    audit(req.user, `room.${w}`, `${bk.name} ${bk.date}`, clientIp(req)); notifyStaff('rooms'); res.json({ ok: true });
  });
  /** Today's private events, for the floor. */
  staff.get('/rooms/today', (req, res) => res.json(db.prepare("SELECT * FROM room_bookings WHERE date = ? AND status = 'confirmed' ORDER BY start_time").all(localToday()).map((b) => ({ ...bookingView(b), spendCents: spendFor(b) }))));

  // public
  app.get('/api/public/rooms', (req, res) => {
    const s = getSettings(); if (s.rooms_online !== '1') return res.json({ enabled: false, business: { name: s.business_name, accent: s.accent } });
    res.json({ enabled: true, business: { name: s.business_name, accent: s.accent }, currency: s.currency, leadDays: Number(s.rooms_lead_days || 2),
      rooms: db.prepare('SELECT * FROM rooms WHERE active = 1 ORDER BY name').all().map((r) => ({ id: r.id, name: r.name, capacity: r.capacity, description: r.description, ...quote(r) })) });
  });
  app.get('/api/public/rooms/:id/taken', (req, res) => {
    const d = String(req.query.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.json([]);
    res.json(db.prepare("SELECT start_time, end_time FROM room_bookings WHERE room_id = ? AND date = ? AND status IN ('requested','confirmed')").all(Number(req.params.id), d));
  });
  app.post('/api/public/rooms/book', publicLimiter, wrap(async (req, res) => {
    const s = getSettings(); if (s.rooms_online !== '1') throw err('Online room booking is off. Please call us.', 403);
    const b = parse(bookSchema, req.body);
    if (!b.email) throw err('Add your email so we can confirm');
    if (b.date < addDays(localToday(), Number(s.rooms_lead_days || 2))) throw err(`Book at least ${s.rooms_lead_days || 2} days ahead`);
    const bk = createBooking(b, 'online');
    audit(null, 'room.request', `${bk.name} ${bk.date} ${bk.start_time}`, clientIp(req)); notifyStaff('rooms');
    h.alertOwners?.(`${s.business_name}: event request`, `${bk.name} asked for ${bk.guests} guests on ${bk.date} ${bk.start_time}–${bk.end_time}.`, 'rooms');
    res.json({ token: bk.token, url: `/event-room/${bk.token}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}` });
  }));
  app.get('/api/v/:token', (req, res) => {
    const b = db.prepare('SELECT * FROM room_bookings WHERE token = ?').get(String(req.params.token)); if (!b) throw err('Booking not found', 404);
    const s = getSettings(); const v = bookingView(b);
    res.json({ business: { name: s.business_name, accent: s.accent }, currency: s.currency, booking: { room: v.room, name: b.name, date: b.date, start: b.start_time, end: b.end_time, guests: b.guests, occasion: b.occasion, status: b.status, minSpendCents: b.min_spend_cents, feeCents: b.fee_cents, depositCents: b.deposit_cents, depositPaidCents: b.deposit_paid_cents },
      canPay: b.deposit_cents > b.deposit_paid_cents && ['requested', 'confirmed'].includes(b.status) && Boolean(h.onlinePayEnabled?.()) });
  });
  app.post('/api/v/:token/pay', publicLimiter, (req, res) => {
    const b = db.prepare('SELECT * FROM room_bookings WHERE token = ?').get(String(req.params.token)); if (!b) throw err('Booking not found', 404);
    const owed = b.deposit_cents - b.deposit_paid_cents; if (owed <= 0) throw err('The deposit is already paid', 409);
    if (!h.onlinePayEnabled?.()) throw err('Online payments are not set up. Please call us.', 503);
    const pid = db.prepare("INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('room', ?, 'card', ?, ?)").run(owed, `Event deposit ${b.date}`, JSON.stringify({ roomBookingId: b.id })).lastInsertRowid;
    const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `?l=${currentSlug()}`;
    res.json({ url: h.startPay(pid, { base, lines: [{ name: `${getSettings().business_name}: event deposit (${b.date})`, cents: owed }], successUrl: `${base}/event-room/${b.token}${l}`, cancelUrl: `${base}/event-room/${b.token}${l}`, email: b.email, descr: 'Event deposit' }) });
  });
  h.payHooks.room = (p) => {
    const meta = pj(p.meta || '{}', {}); const b = db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(meta.roomBookingId); if (!b) return;
    db.prepare('UPDATE room_bookings SET deposit_paid_cents = deposit_paid_cents + ? WHERE id = ?').run(p.amount_cents, b.id);
    audit(null, 'room.deposit', `${b.name}: ${fmt(p.amount_cents)}`, null); notifyStaff('rooms');
    h.alertOwners?.(`${getSettings().business_name}: event deposit`, `${b.name} paid ${fmt(p.amount_cents)} for ${b.date}.`, 'rooms');
  };
}
