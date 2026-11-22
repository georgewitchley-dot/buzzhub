// Round 22: seat names, auto-join for big parties, prep by service, leftover rollover, door tips,
// recall reasons, VIP arrival alerts, fire reminders.
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, forEachLocation } from './db.js';
import { pushToUsers } from './notify.js';

registerSchema((db) => {
  const s = db.prepare('PRAGMA table_info(seat_allergies)').all().map((c) => c.name);
  if (s.length && !s.includes('name')) db.exec('ALTER TABLE seat_allergies ADD COLUMN name TEXT');
  const oi = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
  if (!oi.includes('seat_name')) db.exec('ALTER TABLE order_items ADD COLUMN seat_name TEXT');
  const g = db.prepare('PRAGMA table_info(guests)').all().map((c) => c.name);
  if (!g.includes('vip_alerted')) db.exec('ALTER TABLE guests ADD COLUMN vip_alerted INTEGER NOT NULL DEFAULT 0');
  db.exec("CREATE TABLE IF NOT EXISTS fire_reminders (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')))");
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const addDay = (d) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
const money = (c) => `$${(c / 100).toFixed(2)}`;

export function registerServe({ app, staff, io, h }) {
  const { parse, clientIp, notifyStaff } = h;
  const unit = () => getSettings().unit_label;

  /* ===== 1. seat names ===== */
  staff.put('/tables/:id/seat-name', (req, res) => {
    const { seat, name } = parse(z.object({ seat: z.number().int().min(1).max(40), name: z.string().trim().max(30) }), req.body);
    const tid = Number(req.params.id); if (!db.prepare('SELECT 1 FROM tables WHERE id = ?').get(tid)) throw err('Not found', 404);
    const cur = db.prepare('SELECT * FROM seat_allergies WHERE table_id = ? AND seat = ?').get(tid, seat);
    if (cur) {
      if (!name && !cur.allergy) db.prepare('DELETE FROM seat_allergies WHERE table_id = ? AND seat = ?').run(tid, seat);
      else db.prepare('UPDATE seat_allergies SET name = ? WHERE table_id = ? AND seat = ?').run(name || null, tid, seat);
    } else if (name) db.prepare("INSERT INTO seat_allergies (table_id, seat, allergy, name) VALUES (?, ?, '', ?)").run(tid, seat, name);
    // put the name on dishes already sent for that seat
    db.prepare("UPDATE order_items SET seat_name = ? WHERE seat = ? AND order_id IN (SELECT id FROM orders WHERE table_id = ? AND paid_at IS NULL AND status <> 'void')").run(name || null, seat, tid);
    notifyStaff('orders'); res.json({ ok: true });
  });
  h.seatNames = (tableId) => Object.fromEntries(db.prepare("SELECT seat, name FROM seat_allergies WHERE table_id = ? AND name IS NOT NULL AND name <> ''").all(tableId).map((r) => [r.seat, r.name]));
  h.applySeatNames = (orderId, tableId) => {
    const names = h.seatNames(tableId); if (!Object.keys(names).length) return;
    for (const [seat, name] of Object.entries(names)) db.prepare('UPDATE order_items SET seat_name = ? WHERE order_id = ? AND seat = ?').run(name, orderId, Number(seat));
  };

  /* ===== 3. join tables automatically for a big party ===== */
  h.autoJoinForParty = (tableId, party, user) => {
    if (getSettings().auto_join_tables !== '1' || !tableId || !party) return [];
    const main = db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId); if (!main) return [];
    let seats = h.joinedSeats ? h.joinedSeats(main) : main.seats; if (seats >= party) return [];
    const free = db.prepare("SELECT * FROM tables WHERE id <> ? AND status = 'open' AND joined_to IS NULL AND guest_id IS NULL AND zone = ? AND id NOT IN (SELECT table_id FROM orders WHERE table_id IS NOT NULL AND paid_at IS NULL AND status <> 'void') ORDER BY ABS(id - ?)").all(main.id, main.zone, main.id);
    const joined = [];
    for (const t of free) {
      if (seats >= party) break;
      db.prepare("UPDATE tables SET joined_to = ?, status = 'seated', guest_id = ? WHERE id = ?").run(main.id, main.guest_id, t.id);
      seats += t.seats || 4; joined.push(t.label);
    }
    if (joined.length) { audit(user || null, 'table.auto_join', `${unit()} ${main.label} + ${joined.join(', ')} for ${party}`, null); notifyStaff('tables'); }
    return joined;
  };

  /* ===== 5. prep by service (before / after a split hour) ===== */
  let splitCache = { key: '', at: 0, share: {} };
  h.prepSplit = (items) => {
    const s = getSettings(); const hour = Number(s.prep_split_hour || 0); if (!hour) return items;
    const tz = s.timezone || 'America/New_York';
    const key = `${localToday()}:${hour}`;
    if (splitCache.key !== key || Date.now() - splitCache.at > 30 * 60_000) {
      const dow = new Date(`${localToday()}T12:00:00Z`).getUTCDay();
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
      const rows = db.prepare("SELECT oi.item_id, oi.qty, o.created_at FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_at > datetime('now','-56 days') AND o.status <> 'void' AND oi.item_id IS NOT NULL").all();
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const tot = {}; const early = {};
      for (const r of rows) {
        const parts = Object.fromEntries(fmt.formatToParts(new Date(`${r.created_at.replace(' ', 'T')}Z`)).map((p) => [p.type, p.value]));
        if (days.indexOf(parts.weekday) !== dow) continue;
        tot[r.item_id] = (tot[r.item_id] || 0) + r.qty; if (Number(parts.hour) < hour) early[r.item_id] = (early[r.item_id] || 0) + r.qty;
      }
      const share = {}; for (const id of Object.keys(tot)) share[id] = (early[id] || 0) / tot[id];
      splitCache = { key, at: Date.now(), share };
    }
    return items.map((i) => { const sh = splitCache.share[i.id] ?? 0.5; const first = Math.round(i.prep * sh); return { ...i, split: { hour, first, second: Math.max(0, i.prep - first) } }; });
  };

  /* ===== 6. leftover rollover ===== */
  h.leftoverKeeps = (itemId) => (db.prepare('SELECT shelf_days FROM menu_items WHERE id = ?').get(itemId)?.shelf_days || 0) > 0 && getSettings().leftover_rollover !== '0';
  h.rollLeftover = (itemId, qty, by) => {
    const tomorrow = addDay(localToday());
    const cur = db.prepare('SELECT qty FROM prep_counts WHERE date = ? AND item_id = ?').get(tomorrow, itemId);
    db.prepare('INSERT OR REPLACE INTO prep_counts (date, item_id, qty, by_label) VALUES (?, ?, ?, ?)').run(tomorrow, itemId, (cur?.qty || 0) + qty, by ? `${by} (left over)` : 'Left over');
  };

  /* ===== 7. tip at the door (already-paid deliveries) ===== */
  h.doorTip = (o, tipCents, user) => {
    if (!tipCents) return;
    db.prepare('UPDATE orders SET tip_cents = tip_cents + ?, total_cents = total_cents + ? WHERE id = ?').run(tipCents, tipCents, o.id);
    audit(user, 'delivery.door_tip', `#${o.number} ${money(tipCents)}`, null);
  };

  /* ===== 8. recall reasons ===== */
  h.recallReason = (o, reason, area, by) => {
    if (!reason) return;
    db.prepare('INSERT INTO remakes (order_id, name, qty, reason, area, cost_cents, by_label) VALUES (?, ?, 0, ?, ?, 0, ?)').run(o.id, `Ticket #${o.number} brought back`, `Brought back: ${reason}`, area, by || null);
  };

  /* ===== 9. VIP arrival alerts ===== */
  const vipLabel = (customerId) => {
    const s = getSettings();
    const m = db.prepare("SELECT p.name FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id WHERE ms.customer_id = ? AND ms.status = 'active'").get(customerId);
    if (m) return `${m.name} member`;
    const min = Number(s.auto_vip_spend_cents || 0);
    if (min && db.prepare("SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE customer_id = ? AND paid_at > datetime('now','-365 days') AND status <> 'void'").get(customerId).c >= min) return 'Top guest';
    return null;
  };
  const vipSweep = () => forEachLocation(async () => {
    try {
      const s = getSettings(); if (s.vip_arrival_alert !== '1') return;
      const rows = db.prepare("SELECT g.*, c.name cname, c.notes cnotes, c.visits FROM guests g JOIN customers c ON c.id = g.customer_id WHERE g.vip_alerted = 0 AND g.kind = 'table' AND g.created_at > datetime('now','-2 hours') AND g.status IN ('waiting','buzzed','acknowledged','seated')").all();
      for (const g of rows) {
        db.prepare('UPDATE guests SET vip_alerted = 1 WHERE id = ?').run(g.id);
        const label = vipLabel(g.customer_id); if (!label) continue;
        const body = `${g.cname} (${label}, party of ${g.party_size}${g.visits ? `, visit ${g.visits + 1}` : ''}) just arrived.${g.cnotes ? ` Notes: ${g.cnotes}` : ''}`;
        audit(null, 'guest.vip_arrived', body, null);
        io.to('staff').emit('security', { type: 'vip', detail: body, customerId: g.customer_id });
        await pushToUsers(['staff', 'manager', 'owner'], { title: `${s.business_name}: VIP arrived`, body, tag: `vip-${g.id}`, url: '/waitlist' }).catch(() => {});
      }
    } catch (e) { if (!/no such/.test(e.message)) console.error('vip arrival', e.message); }
  });
  h.vipArrivalSweep = vipSweep;
  setInterval(vipSweep, 20_000).unref();

  /* ===== 10. fire reminders ===== */
  const fireSweep = () => forEachLocation(async () => {
    try {
      const s = getSettings(); if (s.fire_reminders !== '1' || !h.coursePace) return;
      const held = db.prepare("SELECT o.table_id, oi.course, t.label, t.server_id, MIN(o.id) oid FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN tables t ON t.id = o.table_id WHERE o.status IN ('open','sent','ready') AND oi.fired_at IS NULL AND oi.course > 1 GROUP BY o.table_id, oi.course").all();
      for (const r of held) {
        if (held.some((x) => x.table_id === r.table_id && x.course < r.course)) continue; // only the next course
        const p = h.coursePace(r.table_id, r.course); if (!p?.due) continue;
        const key = `${r.table_id}:${r.course}:${r.oid}`;
        if (!db.prepare('INSERT OR IGNORE INTO fire_reminders (key) VALUES (?)').run(key).changes) continue;
        const body = `${unit()} ${r.label}: course ${r.course} is due (last course landed ${p.since} min ago).`;
        if (r.server_id) await pushToUsers(['staff', 'manager', 'owner'], { title: 'Time to fire', body, tag: `fire-${key}`, url: '/pad' }, r.server_id).catch(() => {});
        else await pushToUsers(['manager', 'owner'], { title: 'Time to fire', body, tag: `fire-${key}`, url: '/pad' }).catch(() => {});
        io.to('staff').emit('security', { type: 'fire', detail: body });
      }
      db.prepare("DELETE FROM fire_reminders WHERE at < datetime('now','-1 day')").run();
    } catch (e) { if (!/no such/.test(e.message)) console.error('fire reminders', e.message); }
  });
  h.fireReminderSweep = fireSweep;
  setInterval(fireSweep, 60_000).unref();
}
