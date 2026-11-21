// Round 6, batch K: team scheduling (availability, time off, shift swaps), server performance, two-way customer chat.
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday } from './db.js';
import { pushToGuest, pushToUsers } from './notify.js';
import { dayBounds } from './ops.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS availability (
  user_id INTEGER NOT NULL, dow INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 1, start_time TEXT, end_time TEXT, PRIMARY KEY (user_id, dow)
);
CREATE TABLE IF NOT EXISTS time_off (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')), decided_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shift_swaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL, from_user INTEGER NOT NULL, to_user INTEGER, claimed_by INTEGER, note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','approved','denied','cancelled')), decided_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id INTEGER NOT NULL, sender TEXT NOT NULL CHECK (sender IN ('guest','staff')), user_id INTEGER, body TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')), read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_guest ON messages(guest_id, id);`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dowOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nice = (sl) => { const [d, t] = sl.split(' '); return `${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} ${t}`; };

/** Problems with putting someone on a shift: time off, or outside their availability. */
export function shiftConflicts(userId, date, start, end) {
  const out = [];
  const off = db.prepare("SELECT * FROM time_off WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?").get(userId, date, date);
  if (off) out.push(`approved time off${off.reason ? ` (${off.reason})` : ''}`);
  const pend = db.prepare("SELECT 1 FROM time_off WHERE user_id = ? AND status = 'pending' AND start_date <= ? AND end_date >= ?").get(userId, date, date);
  if (pend) out.push('a time-off request waiting for approval');
  const a = db.prepare('SELECT * FROM availability WHERE user_id = ? AND dow = ?').get(userId, dowOf(date));
  if (a && !a.available) out.push(`not available on ${DAYS[a.dow]}s`);
  else if (a?.start_time && a?.end_time && (start < a.start_time || end > a.end_time)) out.push(`available ${a.start_time}–${a.end_time} on ${DAYS[a.dow]}s`);
  return out;
}

export function registerPeople({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, notifyStaff, publicLimiter, pushGuest } = h;
  const mgr = requireAuth('manager');
  h.shiftConflicts = shiftConflicts;
  const name = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || 'Someone';
  const tellManagers = (title, body) => pushToUsers(['manager', 'owner'], { title, body, tag: 'team', url: '/shifts' }).catch(() => {});
  const tellUser = (uid, title, body) => pushToUsers(['staff', 'manager', 'owner'], { title, body, tag: 'team', url: '/my-shifts' }, uid).catch(() => {});

  /* ===== my schedule (any staff, usually on their phone) ===== */
  staff.get('/me/schedule', (req, res) => {
    const today = localToday(); const uid = req.user.id;
    const shifts = db.prepare('SELECT s.*, (SELECT status FROM shift_swaps w WHERE w.schedule_id = s.id AND w.status IN (\'open\',\'claimed\') LIMIT 1) swap_status FROM schedule s WHERE s.user_id = ? AND substr(s.start_local,1,10) >= ? ORDER BY s.start_local LIMIT 60').all(uid, today);
    const openSwaps = db.prepare("SELECT w.id, w.note, w.status, s.start_local, s.end_local, s.role_note, u.name from_name FROM shift_swaps w JOIN schedule s ON s.id = w.schedule_id JOIN users u ON u.id = w.from_user WHERE w.status = 'open' AND w.from_user <> ? AND (w.to_user IS NULL OR w.to_user = ?) AND substr(s.start_local,1,10) >= ? ORDER BY s.start_local").all(uid, uid, today);
    const avail = db.prepare('SELECT * FROM availability WHERE user_id = ?').all(uid);
    res.json({
      shifts, openSwaps, timeOff: db.prepare('SELECT * FROM time_off WHERE user_id = ? AND end_date >= ? ORDER BY start_date').all(uid, addDays(today, -30)),
      availability: DAYS.map((d, i) => { const a = avail.find((x) => x.dow === i); return { dow: i, day: d, available: a ? Boolean(a.available) : true, start: a?.start_time || '', end: a?.end_time || '' }; }),
      team: db.prepare('SELECT id, name FROM users WHERE active = 1 AND id <> ? ORDER BY name').all(uid),
    });
  });
  staff.put('/me/availability', (req, res) => {
    const { days } = parse(z.object({ days: z.array(z.object({ dow: z.number().int().min(0).max(6), available: z.boolean(), start: z.string().regex(/^(\d{2}:\d{2})?$/), end: z.string().regex(/^(\d{2}:\d{2})?$/) })).length(7) }), req.body);
    const up = db.prepare('INSERT INTO availability (user_id, dow, available, start_time, end_time) VALUES (?,?,?,?,?) ON CONFLICT(user_id, dow) DO UPDATE SET available = excluded.available, start_time = excluded.start_time, end_time = excluded.end_time');
    db.transaction(() => days.forEach((d) => up.run(req.user.id, d.dow, d.available ? 1 : 0, d.start || null, d.end || null)))();
    audit(req.user, 'availability.set', '', clientIp(req)); notifyStaff('shifts'); res.json({ ok: true });
  });
  staff.post('/me/time-off', (req, res) => {
    const b = parse(z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().trim().max(120).optional() }), req.body);
    if (b.end < b.start) throw err('The last day is before the first day');
    if (b.start < localToday()) throw err('Pick days from today on');
    db.prepare('INSERT INTO time_off (user_id, start_date, end_date, reason) VALUES (?,?,?,?)').run(req.user.id, b.start, b.end, b.reason || null);
    const clash = db.prepare('SELECT COUNT(*) n FROM schedule WHERE user_id = ? AND substr(start_local,1,10) BETWEEN ? AND ?').get(req.user.id, b.start, b.end).n;
    tellManagers(`${getSettings().business_name}: time off request`, `${req.user.name} asked for ${b.start}${b.end !== b.start ? ` to ${b.end}` : ''} off${clash ? ` (they're scheduled for ${clash} shift${clash === 1 ? '' : 's'})` : ''}.`);
    audit(req.user, 'timeoff.request', `${b.start}..${b.end}`, clientIp(req)); notifyStaff('shifts'); res.json({ ok: true });
  });
  staff.post('/me/time-off/:id/cancel', (req, res) => { db.prepare("UPDATE time_off SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status IN ('pending','approved')").run(idParam(req), req.user.id); notifyStaff('shifts'); res.json({ ok: true }); });
  staff.post('/me/swaps', (req, res) => {
    const b = parse(z.object({ scheduleId: z.number().int(), toUser: z.number().int().nullable().optional(), note: z.string().trim().max(120).optional() }), req.body);
    const sh = db.prepare('SELECT * FROM schedule WHERE id = ? AND user_id = ?').get(b.scheduleId, req.user.id);
    if (!sh) throw err('That is not your shift', 403);
    if (sh.start_local.slice(0, 10) < localToday()) throw err('That shift has passed');
    if (db.prepare("SELECT 1 FROM shift_swaps WHERE schedule_id = ? AND status IN ('open','claimed')").get(sh.id)) throw err('You already offered this shift', 409);
    db.prepare('INSERT INTO shift_swaps (schedule_id, from_user, to_user, note) VALUES (?,?,?,?)').run(sh.id, req.user.id, b.toUser || null, b.note || null);
    const msg = `${req.user.name} wants someone to take ${nice(sh.start_local)}–${sh.end_local.slice(11)}.`;
    if (b.toUser) tellUser(b.toUser, 'Can you take a shift?', msg); else pushToUsers(['staff', 'manager'], { title: 'Shift up for grabs', body: msg, tag: 'swap', url: '/my-shifts' }).catch(() => {});
    audit(req.user, 'swap.offer', nice(sh.start_local), clientIp(req)); notifyStaff('shifts'); res.json({ ok: true });
  });
  staff.post('/swaps/:id/claim', (req, res) => {
    const w = db.prepare("SELECT w.*, s.start_local, s.end_local FROM shift_swaps w JOIN schedule s ON s.id = w.schedule_id WHERE w.id = ? AND w.status = 'open'").get(idParam(req));
    if (!w || w.from_user === req.user.id || (w.to_user && w.to_user !== req.user.id)) throw err('This shift is no longer open', 409);
    const date = w.start_local.slice(0, 10);
    const issues = shiftConflicts(req.user.id, date, w.start_local.slice(11), w.end_local.slice(11));
    db.prepare("UPDATE shift_swaps SET status = 'claimed', claimed_by = ? WHERE id = ?").run(req.user.id, w.id);
    tellManagers(`${getSettings().business_name}: approve a shift swap`, `${req.user.name} will take ${name(w.from_user)}'s ${nice(w.start_local)} shift.${issues.length ? ` Note: ${issues.join(', ')}.` : ''}`);
    audit(req.user, 'swap.claim', nice(w.start_local), clientIp(req)); notifyStaff('shifts'); res.json({ ok: true });
  });
  staff.post('/swaps/:id/cancel', (req, res) => { db.prepare("UPDATE shift_swaps SET status = 'cancelled' WHERE id = ? AND from_user = ? AND status IN ('open','claimed')").run(idParam(req), req.user.id); notifyStaff('shifts'); res.json({ ok: true }); });

  /* ===== manager: approve requests ===== */
  staff.get('/team/requests', mgr, (req, res) => {
    const timeOff = db.prepare("SELECT t.*, u.name, (SELECT COUNT(*) FROM schedule s WHERE s.user_id = t.user_id AND substr(s.start_local,1,10) BETWEEN t.start_date AND t.end_date) shifts FROM time_off t JOIN users u ON u.id = t.user_id WHERE t.status = 'pending' ORDER BY t.start_date").all();
    const swaps = db.prepare("SELECT w.*, s.start_local, s.end_local, f.name from_name, c.name claimed_name FROM shift_swaps w JOIN schedule s ON s.id = w.schedule_id JOIN users f ON f.id = w.from_user LEFT JOIN users c ON c.id = w.claimed_by WHERE w.status IN ('open','claimed') ORDER BY s.start_local").all()
      .map((w) => ({ ...w, issues: w.claimed_by ? shiftConflicts(w.claimed_by, w.start_local.slice(0, 10), w.start_local.slice(11), w.end_local.slice(11)) : [] }));
    const upcomingOff = db.prepare("SELECT t.start_date, t.end_date, u.name FROM time_off t JOIN users u ON u.id = t.user_id WHERE t.status = 'approved' AND t.end_date >= ? ORDER BY t.start_date LIMIT 30").all(localToday());
    const avail = db.prepare('SELECT a.*, u.name FROM availability a JOIN users u ON u.id = a.user_id WHERE u.active = 1').all();
    res.json({ timeOff, swaps, upcomingOff, availability: avail });
  });
  staff.post('/time-off/:id/decide', mgr, (req, res) => {
    const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
    const t = db.prepare("SELECT * FROM time_off WHERE id = ? AND status = 'pending'").get(idParam(req)); if (!t) throw err('Already decided', 409);
    db.prepare('UPDATE time_off SET status = ?, decided_by = ? WHERE id = ?').run(approve ? 'approved' : 'denied', req.user.id, t.id);
    tellUser(t.user_id, approve ? 'Time off approved' : 'Time off not approved', `${t.start_date}${t.end_date !== t.start_date ? ` to ${t.end_date}` : ''}${approve ? ' is approved.' : `: talk to ${req.user.name}.`}`);
    audit(req.user, approve ? 'timeoff.approve' : 'timeoff.deny', `${name(t.user_id)} ${t.start_date}..${t.end_date}`, clientIp(req)); notifyStaff('shifts'); res.json({ ok: true });
  });
  staff.post('/swaps/:id/decide', mgr, (req, res) => {
    const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
    const w = db.prepare("SELECT w.*, s.start_local FROM shift_swaps w JOIN schedule s ON s.id = w.schedule_id WHERE w.id = ? AND w.status = 'claimed'").get(idParam(req));
    if (!w) throw err('Nobody has taken this shift yet', 409);
    db.transaction(() => {
      db.prepare('UPDATE shift_swaps SET status = ?, decided_by = ? WHERE id = ?').run(approve ? 'approved' : 'denied', req.user.id, w.id);
      if (approve) db.prepare('UPDATE schedule SET user_id = ? WHERE id = ?').run(w.claimed_by, w.schedule_id);
    })();
    const when = nice(w.start_local);
    tellUser(w.from_user, approve ? 'Shift swap approved' : 'Shift swap not approved', approve ? `${name(w.claimed_by)} is taking your ${when} shift.` : `You're still on for ${when}.`);
    tellUser(w.claimed_by, approve ? 'Shift swap approved' : 'Shift swap not approved', approve ? `You're now on for ${when}.` : `The ${when} shift stays with ${name(w.from_user)}.`);
    audit(req.user, approve ? 'swap.approve' : 'swap.deny', `${when} ${name(w.from_user)} → ${name(w.claimed_by)}`, clientIp(req)); notifyStaff('shifts'); res.json({ ok: true });
  });

  /* ===== server performance ===== */
  staff.get('/performance', mgr, (req, res) => {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const to = ok(req.query.to) ? req.query.to : localToday(); const from = ok(req.query.from) ? req.query.from : addDays(to, -13);
    const a = dayBounds(from).start; const z2 = dayBounds(to).end;
    const rows = db.prepare(`SELECT u.id, u.name, u.role,
        COUNT(o.id) orders, COALESCE(SUM(CASE WHEN o.status <> 'void' AND o.paid_at IS NOT NULL THEN o.subtotal_cents - o.discount_cents END),0) sales,
        COALESCE(SUM(CASE WHEN o.status <> 'void' THEN o.tip_cents END),0) tips, SUM(CASE WHEN o.status = 'void' THEN 1 ELSE 0 END) voids,
        COALESCE(SUM(CASE WHEN o.status <> 'void' THEN o.discount_cents END),0) discounts,
        AVG(CASE WHEN o.table_id IS NOT NULL AND o.paid_at IS NOT NULL AND o.status <> 'void' THEN (julianday(o.paid_at) - julianday(o.created_at)) * 1440 END) turn,
        SUM(CASE WHEN o.table_id IS NOT NULL THEN 1 ELSE 0 END) table_orders
      FROM users u JOIN orders o ON o.created_by = u.id AND o.created_at >= ? AND o.created_at < ? GROUP BY u.id ORDER BY sales DESC`).all(a, z2);
    const items = Object.fromEntries(db.prepare("SELECT o.created_by uid, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> 'void' GROUP BY o.created_by").all(a, z2).map((r) => [r.uid, r.n]));
    const ratings = Object.fromEntries(db.prepare('SELECT o.created_by uid, AVG(f.rating) r, COUNT(*) n FROM feedback f JOIN orders o ON o.guest_id = f.guest_id WHERE f.rating IS NOT NULL AND f.responded_at >= ? AND f.responded_at < ? GROUP BY o.created_by').all(a, z2).map((r) => [r.uid, r]));
    const hours = {};
    for (const s of db.prepare('SELECT user_id, clock_in, clock_out, break_minutes FROM shifts WHERE clock_in >= ? AND clock_in < ?').all(a, z2)) {
      const hr = Math.max(0, (Date.parse(`${(s.clock_out || new Date().toISOString().slice(0, 19)).replace(' ', 'T')}Z`) - Date.parse(`${s.clock_in.replace(' ', 'T')}Z`)) / 3600000 - (s.break_minutes || 0) / 60);
      hours[s.user_id] = (hours[s.user_id] || 0) + hr;
    }
    const paidOrders = Object.fromEntries(db.prepare("SELECT created_by uid, COUNT(*) n FROM orders WHERE created_at >= ? AND created_at < ? AND status <> 'void' AND paid_at IS NOT NULL GROUP BY created_by").all(a, z2).map((r) => [r.uid, r.n]));
    res.json({ from, to, people: rows.map((r) => { const n = paidOrders[r.id] || 0; const hr = hours[r.id] || 0; return {
      userId: r.id, name: r.name, role: r.role, orders: r.orders, salesCents: r.sales, avgCheckCents: n ? Math.round(r.sales / n) : 0, tipsCents: r.tips, tipPct: r.sales ? Math.round((r.tips / r.sales) * 1000) / 10 : 0,
      itemsPerCheck: n ? Math.round(((items[r.id] || 0) / n) * 10) / 10 : 0, voids: r.voids, discountCents: r.discounts, turnMinutes: r.turn ? Math.round(r.turn) : null,
      hours: Math.round(hr * 10) / 10, salesPerHourCents: hr ? Math.round(r.sales / hr) : null, rating: ratings[r.id] ? Math.round(ratings[r.id].r * 10) / 10 : null, ratings: ratings[r.id]?.n || 0 }; }) });
  });

  /* ===== two-way chat ===== */
  const guestByToken = (t) => (/^[A-Za-z0-9_-]{16,40}$/.test(t || '') ? db.prepare('SELECT * FROM guests WHERE token = ?').get(t) : null);
  const thread = (gid) => db.prepare('SELECT m.id, m.sender, m.body, m.at, m.read_at, u.name staff_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.guest_id = ? ORDER BY m.id DESC LIMIT 80').all(gid).reverse();
  const quick = () => { try { const q = JSON.parse(getSettings().chat_quick || '[]'); return Array.isArray(q) ? q.slice(0, 8) : []; } catch { return []; } };
  app.get('/api/g/:token/messages', publicLimiter, (req, res) => {
    const g = guestByToken(req.params.token); if (!g) throw err('Not found', 404);
    db.prepare("UPDATE messages SET read_at = datetime('now') WHERE guest_id = ? AND sender = 'staff' AND read_at IS NULL").run(g.id);
    res.json({ enabled: getSettings().chat_enabled === '1', messages: thread(g.id).map(({ staff_name: s, ...m }) => ({ ...m, from: m.sender === 'staff' ? (s ? s.split(' ')[0] : 'Team') : 'You' })) });
  });
  const recent = new Map();
  app.post('/api/g/:token/messages', publicLimiter, (req, res) => {
    const g = guestByToken(req.params.token); if (!g) throw err('Not found', 404);
    if (getSettings().chat_enabled !== '1') throw err('Messaging is turned off', 403);
    if (['done', 'removed', 'no_show'].includes(g.status) && g.closed_at && Date.now() - Date.parse(`${g.closed_at.replace(' ', 'T')}Z`) > 3 * 3600_000) throw err('This conversation has closed', 403);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(500) }), req.body);
    const k = `${g.id}`; const list = (recent.get(k) || []).filter((t) => Date.now() - t < 10 * 60_000);
    if (list.length >= 15) throw err('Please wait a moment before sending more', 429);
    list.push(Date.now()); recent.set(k, list);
    db.prepare("INSERT INTO messages (guest_id, sender, body) VALUES (?, 'guest', ?)").run(g.id, body);
    io.to('staff').emit('chat:new', { guestId: g.id, name: g.name, body: body.slice(0, 120) }); notifyStaff('chat');
    res.json({ ok: true });
  });
  staff.get('/chats', (req, res) => {
    const rows = db.prepare(`SELECT g.id guest_id, g.name, g.status, g.kind, g.party_size, t.label table_label,
        (SELECT body FROM messages m WHERE m.guest_id = g.id ORDER BY m.id DESC LIMIT 1) last, (SELECT sender FROM messages m WHERE m.guest_id = g.id ORDER BY m.id DESC LIMIT 1) last_sender,
        (SELECT at FROM messages m WHERE m.guest_id = g.id ORDER BY m.id DESC LIMIT 1) last_at,
        (SELECT COUNT(*) FROM messages m WHERE m.guest_id = g.id AND m.sender = 'guest' AND m.read_at IS NULL) unread
      FROM guests g LEFT JOIN tables t ON t.id = g.table_id WHERE EXISTS (SELECT 1 FROM messages m WHERE m.guest_id = g.id AND m.at > datetime('now','-1 day')) ORDER BY last_at DESC LIMIT 50`).all();
    res.json({ chats: rows, unread: rows.reduce((a, r) => a + r.unread, 0), quick: quick() });
  });
  staff.get('/guests/:id/messages', (req, res) => {
    const gid = idParam(req); const g = db.prepare('SELECT id, name, status, kind, token FROM guests WHERE id = ?').get(gid); if (!g) throw err('Not found', 404);
    db.prepare("UPDATE messages SET read_at = datetime('now') WHERE guest_id = ? AND sender = 'guest' AND read_at IS NULL").run(gid);
    notifyStaff('chat');
    res.json({ guest: { id: g.id, name: g.name, status: g.status, kind: g.kind }, messages: thread(gid), quick: quick() });
  });
  staff.post('/guests/:id/messages', (req, res) => {
    const gid = idParam(req); const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(gid); if (!g) throw err('Not found', 404);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(500) }), req.body);
    db.prepare("INSERT INTO messages (guest_id, sender, user_id, body) VALUES (?, 'staff', ?, ?)").run(gid, req.user.id, body);
    io.to(`guest:${gid}`).emit('chat', { from: req.user.name.split(' ')[0], body });
    pushToGuest(gid, { title: `${getSettings().business_name}: new message`, body: body.slice(0, 140), tag: 'chat', url: `/b/${g.token}?chat=1` }).catch(() => {});
    audit(req.user, 'chat.send', `to ${g.name}`, clientIp(req)); notifyStaff('chat'); pushGuest?.(gid);
    res.json({ ok: true });
  });
}
