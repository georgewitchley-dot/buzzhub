// Round 14: curbside "I'm here", kitchen speed report, event menus for private rooms, break planner, declared tips.
// (Bump bars, talking tickets, allergy check, area lists and pacing live with the area screens in kds.js.)
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentTz, forEachLocation } from './db.js';
import { dayBounds } from './ops.js';
import { whosOn } from './timeclock.js';
import { priceLines, insertOrder } from './commerce.js';
import { pushToUsers } from './notify.js';

registerSchema((db) => {
  const o = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!o.includes('arrived_at')) db.exec('ALTER TABLE orders ADD COLUMN arrived_at TEXT');
  if (!o.includes('arrival_note')) db.exec('ALTER TABLE orders ADD COLUMN arrival_note TEXT');
  if (!o.includes('handed_at')) db.exec('ALTER TABLE orders ADD COLUMN handed_at TEXT');
  const s = db.prepare('PRAGMA table_info(shifts)').all().map((c) => c.name);
  if (!s.includes('declared_tips_cents')) db.exec('ALTER TABLE shifts ADD COLUMN declared_tips_cents INTEGER NOT NULL DEFAULT 0');
  const rb = db.prepare('PRAGMA table_info(room_bookings)').all().map((c) => c.name);
  if (rb.length && !rb.includes('menu')) db.exec("ALTER TABLE room_bookings ADD COLUMN menu TEXT NOT NULL DEFAULT '[]'");
  if (rb.length && !rb.includes('fire_time')) db.exec('ALTER TABLE room_bookings ADD COLUMN fire_time TEXT');
  if (rb.length && !rb.includes('fired_order_id')) db.exec('ALTER TABLE room_bookings ADD COLUMN fired_order_id INTEGER');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const ms = (sql) => Date.parse(`${String(sql).replace(' ', 'T')}Z`);
const localHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: currentTz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const localHour = (sql) => Number(new Intl.DateTimeFormat('en-US', { timeZone: currentTz(), hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms(sql))));
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const r1 = (x) => Math.round(x * 10) / 10;

export function registerPace({ app, staff, io, h }) {
  const { parse, clientIp, requireAuth, notifyStaff, wrap, publicLimiter } = h;
  const mgr = requireAuth('manager');

  /* ===== curbside: "I'm here" from the customer's order page ===== */
  h.curbsideView = (g) => {
    const s = getSettings(); if (s.curbside !== '1' || g.kind !== 'order' || !g.order_id) return null;
    const o = db.prepare('SELECT status, fulfillment, arrived_at, arrival_note, handed_at FROM orders WHERE id = ?').get(g.order_id);
    if (!o || o.fulfillment === 'delivery' || o.status === 'void' || o.handed_at) return null;
    return { arrived: Boolean(o.arrived_at), note: o.arrival_note || '', prompt: s.curbside_prompt || 'Car color and make, or parking spot' };
  };
  app.post('/api/g/:token/here', publicLimiter, (req, res) => {
    if (getSettings().curbside !== '1') throw err('Curbside pickup is off', 403);
    const g = db.prepare('SELECT * FROM guests WHERE token = ?').get(String(req.params.token)); if (!g || g.kind !== 'order' || !g.order_id) throw err('Order not found', 404);
    const { note } = parse(z.object({ note: z.string().trim().max(80).optional() }), req.body);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(g.order_id);
    db.prepare("UPDATE orders SET arrived_at = COALESCE(arrived_at, datetime('now')), arrival_note = ? WHERE id = ?").run(note || null, o.id);
    const detail = `Curbside: #${o.number} ${g.name.split(' ')[0]} is here${note ? ` (${note})` : ''}`;
    io.to('staff').emit('security', { type: 'curbside', detail }); notifyStaff('orders');
    pushToUsers(['staff', 'manager', 'owner'], { title: `#${o.number} is here`, body: `${g.name.split(' ')[0]}${note ? `: ${note}` : ''}`, tag: `here-${o.id}`, url: '/orders' }).catch(() => {});
    audit(null, 'curbside.here', `#${o.number}${note ? ` ${note}` : ''}`, clientIp(req)); h.pushGuest?.(g.id);
    res.json({ ok: true });
  });
  // staff: brought out to the car (also closes the pickup buzzer)
  const handOff = (o, user, ip) => {
    db.prepare("UPDATE orders SET handed_at = datetime('now') WHERE id = ?").run(o.id);
    if (o.guest_id) db.prepare("UPDATE guests SET status = 'done', closed_at = COALESCE(closed_at, datetime('now')) WHERE id = ? AND kind = 'order' AND status IN ('waiting','buzzed','acknowledged')").run(o.guest_id);
    audit(user, 'curbside.handed', `#${o.number}`, ip); notifyStaff('orders'); notifyStaff('guests'); if (o.guest_id) h.pushGuest?.(o.guest_id);
  };
  h.handOff = handOff;
  staff.post('/orders/:id/handed', (req, res) => { const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id)); if (!o) throw err('Not found', 404); handOff(o, req.user, clientIp(req)); res.json({ ok: true }); });
  staff.get('/curbside', (req, res) => res.json(db.prepare("SELECT o.id, o.number, o.status, o.arrived_at, o.arrival_note, o.customer_name, g.name guest_name FROM orders o LEFT JOIN guests g ON g.id = o.guest_id WHERE o.arrived_at IS NOT NULL AND o.handed_at IS NULL AND o.status <> 'void' AND o.arrived_at > datetime('now','-6 hours') ORDER BY o.arrived_at").all()));

  /* ===== kitchen speed report ===== */
  staff.get('/kitchen-speed', mgr, (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7)); const since = dayBounds(addDays(localToday(), -(days - 1))).start;
    const late = Number(getSettings().kds_late_minutes || 12);
    const tickets = db.prepare("SELECT o.id, o.number, o.sent_at, o.ready_at, o.source, o.fulfillment, (SELECT SUM(qty) FROM order_items WHERE order_id = o.id) items FROM orders o WHERE o.sent_at >= ? AND o.ready_at IS NOT NULL AND o.status <> 'void' AND o.ready_at > o.sent_at").all(since)
      .map((t) => ({ ...t, minutes: (ms(t.ready_at) - ms(t.sent_at)) / 60000 })).filter((t) => t.minutes <= 240);
    const stat = (list) => { if (!list.length) return { n: 0, avg: 0, p90: 0 }; const s = [...list].sort((a, b) => a - b); return { n: s.length, avg: r1(s.reduce((a, x) => a + x, 0) / s.length), p90: r1(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]) }; };
    const groupBy = (rows, key, val) => { const m = new Map(); for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(val(r)); } return [...m.entries()].map(([k, v]) => ({ key: k, ...stat(v) })); };
    const items = db.prepare("SELECT oi.name, oi.done_station area, oi.done_at, COALESCE(oi.fired_at, o.sent_at) start FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.sent_at >= ? AND oi.done_at IS NOT NULL AND o.status <> 'void'").all(since)
      .map((i) => ({ ...i, minutes: (ms(i.done_at) - ms(i.start)) / 60000 })).filter((i) => i.minutes >= 0 && i.minutes <= 240);
    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow = (sql) => dows[new Date(new Date(ms(sql)).toLocaleString('en-US', { timeZone: currentTz() })).getDay()];
    res.json({ days, lateMinutes: late, overall: stat(tickets.map((t) => t.minutes)), late: tickets.filter((t) => t.minutes >= late).length,
      byHour: groupBy(tickets, (t) => localHour(t.sent_at), (t) => t.minutes).sort((a, b) => a.key - b.key),
      byDay: groupBy(tickets, (t) => dow(t.sent_at), (t) => t.minutes).sort((a, b) => dows.indexOf(a.key) - dows.indexOf(b.key)),
      byChannel: groupBy(tickets, (t) => (t.fulfillment === 'delivery' ? 'Delivery' : t.source === 'online' ? 'Online' : t.source === 'table' ? 'Table QR' : t.source === 'kiosk' ? 'Kiosk' : 'Register'), (t) => t.minutes).sort((a, b) => b.n - a.n),
      byArea: groupBy(items.filter((i) => i.area), (i) => i.area, (i) => i.minutes).sort((a, b) => b.avg - a.avg),
      byDish: groupBy(items, (i) => i.name, (i) => i.minutes).filter((x) => x.n >= 2).sort((a, b) => b.avg - a.avg).slice(0, 15),
      slowest: tickets.sort((a, b) => b.minutes - a.minutes).slice(0, 10).map((t) => ({ id: t.id, number: t.number, minutes: r1(t.minutes), items: t.items, at: t.sent_at })) });
  });

  /* ===== event menus for private rooms ===== */
  const menuSchema = z.object({ lines: z.array(z.object({ itemId: z.number().int(), qty: z.number().int().min(1).max(500), note: z.string().trim().max(80).optional() })).max(40), fireTime: z.string().regex(/^(\d{2}:\d{2})?$/).optional() });
  staff.put('/rooms/bookings/:id/menu', mgr, (req, res) => {
    const b = parse(menuSchema, req.body); const bk = db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(Number(req.params.id)); if (!bk) throw err('Not found', 404);
    if (bk.fired_order_id) throw err('This menu was already sent to the kitchen', 409);
    if (b.lines.length) priceLines(b.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, mods: [] }))); // checks every dish exists and needs no required options
    db.prepare('UPDATE room_bookings SET menu = ?, fire_time = ? WHERE id = ?').run(JSON.stringify(b.lines), b.fireTime || null, bk.id);
    audit(req.user, 'room.menu', `${bk.name}: ${b.lines.length} dishes`, clientIp(req)); notifyStaff('rooms'); res.json({ ok: true });
  });
  const fire = (bk, user) => {
    const lines = pj(bk.menu, []); if (!lines.length) throw err('Add the event menu first');
    if (bk.fired_order_id) throw err('Already sent to the kitchen', 409);
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(bk.room_id); const tableId = pj(room?.table_ids, [])[0] || null;
    const priced = priceLines(lines.map((l) => ({ itemId: l.itemId, qty: l.qty, mods: [], note: l.note })));
    const o = insertOrder({ lines: priced, status: 'sent', source: 'event', tableId, customerName: `Event: ${bk.name}`, createdBy: user?.id || null, notes: `${bk.guests} guests, ${room?.name || 'private room'}${bk.occasion ? `, ${bk.occasion}` : ''}` });
    db.prepare('UPDATE room_bookings SET fired_order_id = ? WHERE id = ?').run(o.id, bk.id);
    audit(user, 'room.fire', `${bk.name}: order #${o.number}`, null); notifyStaff('orders'); notifyStaff('rooms');
    return o;
  };
  staff.post('/rooms/bookings/:id/fire', mgr, (req, res) => { const bk = db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(Number(req.params.id)); if (!bk) throw err('Not found', 404); const o = fire(bk, req.user); res.json({ ok: true, number: o.number }); });
  h.eventsToday = () => db.prepare("SELECT b.*, r.name room FROM room_bookings b JOIN rooms r ON r.id = b.room_id WHERE b.date = ? AND b.status = 'confirmed' ORDER BY b.start_time").all(localToday())
    .filter((b) => pj(b.menu, []).length).map((b) => {
      const names = Object.fromEntries(db.prepare(`SELECT id, name, category, station FROM menu_items WHERE id IN (${pj(b.menu, []).map((l) => Number(l.itemId)).join(',') || 0})`).all().map((m) => [m.id, m]));
      return { id: b.id, name: b.name, room: b.room, guests: b.guests, start: b.start_time, fireTime: b.fire_time, fired: Boolean(b.fired_order_id), items: pj(b.menu, []).map((l) => ({ ...names[l.itemId], qty: l.qty, note: l.note })).filter((x) => x.name) };
    });
  setInterval(() => forEachLocation(() => {
    try {
      const hm = localHM();
      for (const bk of db.prepare("SELECT * FROM room_bookings WHERE date = ? AND status = 'confirmed' AND fired_order_id IS NULL AND fire_time IS NOT NULL AND fire_time <= ?").all(localToday(), hm)) {
        try { fire(bk, null); } catch (e) { audit(null, 'room.fire_failed', `${bk.name}: ${e.message}`, null); db.prepare('UPDATE room_bookings SET fire_time = NULL WHERE id = ?').run(bk.id); }
      }
    } catch (e) { console.error('event fire', e.message); }
  }), 60_000).unref();

  /* ===== break planner ===== */
  staff.get('/break-plan', mgr, (req, res) => {
    const s = getSettings(); const breakAfter = Number(s.break_after_hours) || 6; const breakLen = Number(s.break_minutes_planned) || 30;
    // expected sales by local hour today: same weekday over the last 8 weeks
    const today = localToday(); const curve = Array.from({ length: 24 }, () => 0);
    for (let w = 1; w <= 8; w++) { const { start, end } = dayBounds(addDays(today, -7 * w)); for (const o of db.prepare("SELECT paid_at, total_cents FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void'").all(start, end)) curve[localHour(o.paid_at)] += o.total_cents / 8; }
    const nowMin = (() => { const [a, b] = localHM().split(':').map(Number); return a * 60 + b; })();
    const minOf = (sql) => { const d = new Date(ms(sql)); const [a, b] = new Intl.DateTimeFormat('en-GB', { timeZone: currentTz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).split(':').map(Number); return a * 60 + b + (sql < dayBounds(today).start ? -1440 : 0); };
    const on = whosOn(); const max = Math.max(1, Math.floor(on.length / 4));
    const takenNow = on.filter((p) => p.onBreak).length;
    const people = on.filter((p) => !p.onBreak).map((p) => {
      const sh = db.prepare('SELECT break_minutes FROM shifts WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(p.userId);
      const start = minOf(p.since); return { ...p, start, hadBreak: (sh?.break_minutes || 0) >= 10, earliest: Math.max(nowMin, start + 120), due: start + breakAfter * 60 };
    }).filter((p) => !p.hadBreak && p.due - p.start >= 180).sort((a, b) => a.due - b.due);
    const load = {}; // 15-minute slot -> breaks planned
    const busy = (m) => curve[Math.floor(((m % 1440) + 1440) % 1440 / 60)] || 0;
    const plan = people.map((p) => {
      let best = null;
      for (let m = Math.ceil(p.earliest / 15) * 15; m <= Math.max(p.earliest, p.due - breakLen); m += 15) {
        const slots = Array.from({ length: Math.ceil(breakLen / 15) }, (_, k) => m + k * 15);
        if (slots.some((x) => (load[x] || 0) + (x <= nowMin + breakLen ? takenNow : 0) >= max)) continue;
        const score = slots.reduce((a, x) => a + busy(x), 0);
        if (!best || score < best.score - 1) best = { m, score, slots };
      }
      if (!best) { const m = Math.max(p.earliest, nowMin); best = { m, score: busy(m), slots: [m], forced: true }; }
      for (const x of best.slots) load[x] = (load[x] || 0) + 1;
      const hm = (x) => `${String(Math.floor(((x % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((x % 60) + 60) % 60).padStart(2, '0')}`;
      return { userId: p.userId, name: p.name, position: p.position, since: p.since, suggest: hm(best.m), dueBy: hm(p.due), overdue: p.due < nowMin, now: best.m <= nowMin + 10, quiet: !best.forced };
    });
    res.json({ breakAfterHours: breakAfter, breakMinutes: breakLen, maxAtOnce: max, onBreak: takenNow, plan, curve: curve.map((c) => Math.round(c)), nowHour: Math.floor(nowMin / 60) });
  });

  /* ===== declared tips ===== */
  h.declareTips = (userId, cents) => {
    if (getSettings().declare_tips !== '1' || !(cents >= 0)) return;
    const sh = db.prepare('SELECT id FROM shifts WHERE user_id = ? AND clock_out IS NOT NULL ORDER BY clock_out DESC LIMIT 1').get(userId); if (!sh) return;
    db.prepare('UPDATE shifts SET declared_tips_cents = ? WHERE id = ?').run(Math.min(1_000_000, Math.round(cents)), sh.id);
  };
  staff.put('/shifts/:id/declared-tips', mgr, (req, res) => {
    const { cents } = parse(z.object({ cents: z.number().int().min(0).max(1_000_000) }), req.body);
    const sh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id)); if (!sh) throw err('Not found', 404);
    db.prepare('UPDATE shifts SET declared_tips_cents = ? WHERE id = ?').run(cents, sh.id); audit(req.user, 'tips.declared_edit', `shift ${sh.id}: $${(cents / 100).toFixed(2)}`, clientIp(req)); notifyStaff('shifts'); res.json({ ok: true });
  });
  void wrap;
}
