// Round 23: seat history, allergy hand-off, saved table combos, prep labels data, prep learns from waste,
// driver checkout, remake alerts, VIP profile, pacing by party size.
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, forEachLocation } from './db.js';
import { dayBounds } from './ops.js';
import { pushToUsers } from './notify.js';

registerSchema((db) => {
  const o = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!o.includes('allergy_handed_by')) db.exec('ALTER TABLE orders ADD COLUMN allergy_handed_by TEXT; ALTER TABLE orders ADD COLUMN allergy_handed_at TEXT');
  const b = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  if (b.length && !b.includes('combo_id')) db.exec('ALTER TABLE bookings ADD COLUMN combo_id INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS table_combos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, table_ids TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS remake_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')));`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v) ?? d; } catch { return d; } };
const ms = (sql) => Date.parse(`${String(sql).replace(' ', 'T')}Z`);
const bucket = (n) => (n <= 2 ? '1-2' : n <= 4 ? '3-4' : n <= 8 ? '5-8' : '9+');

export function registerCare({ app, staff, io, h }) {
  const { parse, clientIp, requireAuth, notifyStaff } = h;
  const mgr = requireAuth('manager');
  const unit = () => getSettings().unit_label;

  /* ===== 1. seat history ===== */
  staff.get('/tables/:id/seat/:seat/history', (req, res) => {
    const t = db.prepare('SELECT * FROM tables WHERE id = ?').get(Number(req.params.id)); if (!t) throw err('Not found', 404);
    const since = t.seated_at || db.prepare("SELECT datetime('now','-6 hours') d").get().d;
    const rows = db.prepare(`SELECT oi.name, oi.qty, oi.price_cents, oi.note, oi.course, oi.fired_at, oi.done_at, oi.mods, o.number, o.created_at, o.paid_at, o.served_at
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND oi.seat = ? AND o.status <> 'void' AND o.created_at >= ? ORDER BY o.created_at, oi.id`).all(t.id, Number(req.params.seat), since);
    res.json({ seat: Number(req.params.seat), name: h.seatNames ? h.seatNames(t.id)[req.params.seat] || null : null,
      items: rows.map((r) => ({ name: r.name, qty: r.qty, cents: r.qty * r.price_cents, note: r.note, mods: pj(r.mods || '[]', []).map((m) => m.name).filter(Boolean), number: r.number, at: r.created_at, state: r.paid_at ? 'paid' : r.served_at || r.done_at ? 'served' : r.fired_at || r.course <= 1 ? 'cooking' : 'held' })),
      totalCents: rows.reduce((a, r) => a + r.qty * r.price_cents, 0) });
  });

  /* ===== 2. allergy hand-off ===== */
  h.allergyHandoff = (orderId, by) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId); if (!o) throw err('Not found', 404);
    if (!o.allergy_note) throw err('This order has no allergy', 409);
    db.prepare("UPDATE orders SET allergy_handed_by = ?, allergy_handed_at = datetime('now') WHERE id = ?").run(by || 'Unknown', o.id);
    audit(null, 'allergy.handoff', `#${o.number}: ${o.allergy_note} handed over by ${by || 'unknown'}`, null); notifyStaff('orders');
    return o;
  };
  staff.post('/orders/:id/allergy-handoff', (req, res) => { h.allergyHandoff(Number(req.params.id), req.user.name); res.json({ ok: true }); });
  staff.get('/allergy-handoffs', mgr, (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    res.json(db.prepare(`SELECT o.number, o.allergy_note, o.allergy_checked_by, o.allergy_handed_by, o.allergy_handed_at, o.created_at, t.label table_label FROM orders o LEFT JOIN tables t ON t.id = o.table_id
      WHERE o.allergy_note IS NOT NULL AND o.created_at > datetime('now', ?) AND o.status <> 'void' ORDER BY o.created_at DESC LIMIT 200`).all(`-${days} days`));
  });

  /* ===== 3. saved table combos ===== */
  const comboOut = (c) => { const ids = pj(c.table_ids, []); const t = ids.length ? db.prepare(`SELECT id, label, seats FROM tables WHERE id IN (${ids.map(Number).join(',')})`).all() : []; return { id: c.id, name: c.name, tableIds: ids, labels: ids.map((i) => t.find((x) => x.id === i)?.label).filter(Boolean), seats: t.reduce((a, x) => a + (x.seats || 4), 0) }; };
  staff.get('/table-combos', (req, res) => res.json(db.prepare('SELECT * FROM table_combos ORDER BY name').all().map(comboOut)));
  staff.post('/table-combos', mgr, (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(40), tableIds: z.array(z.number().int()).min(2).max(10) }), req.body);
    const id = db.prepare('INSERT INTO table_combos (name, table_ids) VALUES (?, ?)').run(b.name, JSON.stringify(b.tableIds)).lastInsertRowid;
    audit(req.user, 'combo.create', b.name, clientIp(req)); res.json(comboOut(db.prepare('SELECT * FROM table_combos WHERE id = ?').get(id)));
  });
  staff.delete('/table-combos/:id', mgr, (req, res) => { db.prepare('DELETE FROM table_combos WHERE id = ?').run(Number(req.params.id)); db.prepare('UPDATE bookings SET combo_id = NULL WHERE combo_id = ?').run(Number(req.params.id)); res.json({ ok: true }); });
  staff.put('/bookings/:id/combo', (req, res) => {
    const { comboId } = parse(z.object({ comboId: z.number().int().nullable() }), req.body);
    const bk = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id)); if (!bk) throw err('Not found', 404);
    const c = comboId ? db.prepare('SELECT * FROM table_combos WHERE id = ?').get(comboId) : null; if (comboId && !c) throw err('That combo is gone', 404);
    db.prepare('UPDATE bookings SET combo_id = ?, table_id = COALESCE(?, table_id) WHERE id = ?').run(comboId, c ? pj(c.table_ids, [])[0] : null, bk.id);
    audit(req.user, 'booking.combo', `#${bk.id}: ${c ? c.name : 'none'}`, clientIp(req)); notifyStaff('bookings'); res.json({ ok: true });
  });
  /** Join a saved combo onto its first table. Skips tables that are busy. */
  h.joinCombo = (comboId, user) => {
    const c = db.prepare('SELECT * FROM table_combos WHERE id = ?').get(comboId); if (!c) return [];
    const [first, ...rest] = pj(c.table_ids, []); const main = db.prepare('SELECT * FROM tables WHERE id = ?').get(first); if (!main) return [];
    const joined = [];
    for (const id of rest) {
      const t = db.prepare("SELECT * FROM tables WHERE id = ? AND joined_to IS NULL AND (status = 'open' OR guest_id = ?) AND id NOT IN (SELECT table_id FROM orders WHERE table_id IS NOT NULL AND paid_at IS NULL AND status <> 'void')").get(id, main.guest_id || -1);
      if (!t) continue;
      db.prepare("UPDATE tables SET joined_to = ?, status = 'seated', guest_id = ? WHERE id = ?").run(main.id, main.guest_id, t.id); joined.push(t.label);
    }
    if (joined.length) { audit(user || null, 'table.combo_join', `${c.name}: ${unit()} ${main.label} + ${joined.join(', ')}`, null); notifyStaff('tables'); }
    return joined;
  };
  staff.post('/table-combos/:id/join', (req, res) => {
    const c = db.prepare('SELECT * FROM table_combos WHERE id = ?').get(Number(req.params.id)); if (!c) throw err('Not found', 404);
    res.json({ ok: true, mainId: pj(c.table_ids, [])[0], joined: h.joinCombo(c.id, req.user) });
  });
  h.bookingCombo = (guest) => (guest.booking_id ? db.prepare('SELECT combo_id FROM bookings WHERE id = ?').get(guest.booking_id)?.combo_id || null : null);

  /* ===== 6. prep learns from waste ===== */
  h.wasteAdjust = (items) => {
    if (getSettings().prep_learn === '0') return items;
    const dow = new Date(`${localToday()}T12:00:00Z`).getUTCDay();
    const rows = db.prepare("SELECT item_id, qty, at FROM waste_log WHERE reason = 'over-prepped' AND item_id IS NOT NULL AND at > datetime('now','-29 days')").all();
    const left = {}; for (const r of rows) { if (new Date(ms(r.at) - 5 * 3600_000).getUTCDay() !== dow) continue; left[r.item_id] = (left[r.item_id] || 0) + r.qty; }
    return items.map((i) => {
      const avg = (left[i.id] || 0) / 4; if (!avg || !i.forecast) return i;
      const cut = Math.min(Math.round(avg * 0.75), Math.floor(i.forecast * 0.3)); if (!cut) return i;
      const forecast = i.forecast - cut; const target = Math.max(forecast, i.par || 0);
      return { ...i, forecast, wasteCut: cut, target, prep: Math.max(0, target - (i.onHand || 0)) };
    });
  };

  /* ===== 7. driver checkout ===== */
  const driverCheckout = (userId, date) => {
    const { start, end } = dayBounds(date); const u = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
    const rows = db.prepare("SELECT number, payment_method, prepaid, total_cents, tip_cents, fee_cents, delivered_at, out_at FROM orders WHERE driver_id = ? AND delivered_at >= ? AND delivered_at < ? AND status <> 'void'").all(userId, start, end);
    const cash = rows.filter((r) => r.payment_method === 'cash' && !r.prepaid);
    const door = db.prepare("SELECT COALESCE(SUM(CAST(substr(detail, instr(detail, '$') + 1) AS REAL)),0) d FROM audit WHERE action = 'delivery.door_tip' AND user_id = ? AND ts >= ? AND ts < ?").get(userId, start, end);
    const avgMin = rows.filter((r) => r.out_at).map((r) => (ms(r.delivered_at) - ms(r.out_at)) / 60000);
    return { date, user: u, deliveries: rows.length, cashCollectedCents: cash.reduce((a, r) => a + r.total_cents, 0), cashTipsCents: cash.reduce((a, r) => a + r.tip_cents, 0),
      tipsCents: rows.reduce((a, r) => a + r.tip_cents, 0), doorTipsCents: Math.round((door?.d || 0) * 100), feesCents: rows.reduce((a, r) => a + (r.fee_cents || 0), 0),
      avgMinutes: avgMin.length ? Math.round(avgMin.reduce((a, b) => a + b, 0) / avgMin.length) : null,
      cashToHandInCents: cash.reduce((a, r) => a + r.total_cents - r.tip_cents, 0), orders: rows.map((r) => ({ number: r.number, cents: r.total_cents, tip: r.tip_cents, cash: r.payment_method === 'cash' && !r.prepaid })) };
  };
  staff.get('/me/driver-checkout', (req, res) => res.json(driverCheckout(req.user.id, /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : localToday())));
  staff.get('/driver-checkouts', mgr, (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : localToday(); const { start, end } = dayBounds(date);
    const ids = db.prepare('SELECT DISTINCT driver_id FROM orders WHERE driver_id IS NOT NULL AND delivered_at >= ? AND delivered_at < ?').all(start, end).map((r) => r.driver_id);
    res.json({ date, drivers: ids.map((id) => driverCheckout(id, date)) });
  });

  /* ===== 8. remake alerts ===== */
  const remakeSweep = () => forEachLocation(async () => {
    try {
      const s = getSettings(); if (s.remake_alerts === '0') return;
      const n = Math.max(2, Number(s.remake_alert_count || 3));
      const rows = db.prepare(`SELECT COALESCE(oi.name, r.name) dish, COUNT(*) c, GROUP_CONCAT(DISTINCT r.reason) reasons FROM remakes r LEFT JOIN order_items oi ON oi.id = r.order_item_id
        WHERE r.at > datetime('now','-60 minutes') AND r.name NOT LIKE 'Ticket #%' GROUP BY COALESCE(oi.name, r.name) HAVING COUNT(*) >= ?`).all(n);
      for (const r of rows) {
        const key = `${r.dish}:${new Date().toISOString().slice(0, 13)}`;
        if (db.prepare("SELECT 1 FROM remake_alerts WHERE key LIKE ? AND at > datetime('now','-2 hours')").get(`${r.dish}:%`)) continue;
        db.prepare('INSERT OR IGNORE INTO remake_alerts (key) VALUES (?)').run(key);
        const body = `${r.dish} came back ${r.c} times in the last hour (${r.reasons}). Check the station.`;
        audit(null, 'remake.alert', body, null); io.to('staff').emit('security', { type: 'fire', detail: body });
        await pushToUsers(['manager', 'owner'], { title: `${s.business_name}: dish keeps coming back`, body, tag: `remake-${r.dish}`, url: '/kitchen-speed' }).catch(() => {});
      }
      db.prepare("DELETE FROM remake_alerts WHERE at < datetime('now','-2 days')").run();
    } catch (e) { if (!/no such/.test(e.message)) console.error('remake alerts', e.message); }
  });
  h.remakeSweep = remakeSweep;
  setInterval(remakeSweep, 120_000).unref();

  /* ===== 9. VIP profile ===== */
  staff.get('/customers/:id/vip-card', (req, res) => {
    const c = db.prepare('SELECT id, name, phone, email, tags, notes, birthday, visits FROM customers WHERE id = ?').get(Number(req.params.id)); if (!c) throw err('Not found', 404);
    const last = db.prepare("SELECT id, number, created_at, total_cents FROM orders WHERE customer_id = ? AND status <> 'void' ORDER BY id DESC LIMIT 1").get(c.id);
    const lastItems = last ? db.prepare('SELECT qty, name FROM order_items WHERE order_id = ? AND price_cents > 0').all(last.id).map((i) => `${i.qty} ${i.name}`) : [];
    const fav = db.prepare("SELECT oi.name, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.customer_id = ? AND o.status <> 'void' AND oi.price_cents > 0 GROUP BY oi.name ORDER BY n DESC LIMIT 3").all(c.id).map((r) => r.name);
    const spend = db.prepare("SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE customer_id = ? AND paid_at > datetime('now','-365 days') AND status <> 'void'").get(c.id).c;
    const plan = db.prepare("SELECT p.name FROM memberships ms JOIN membership_plans p ON p.id = ms.plan_id WHERE ms.customer_id = ? AND ms.status = 'active'").get(c.id)?.name || null;
    const tags = pj(c.tags || '[]', []);
    res.json({ id: c.id, name: c.name, visits: c.visits, notes: c.notes, birthday: c.birthday, tags, allergies: tags.filter((t) => /allerg|free|vegan|celiac|dairy|lactose|nut|shellfish/i.test(t)),
      plan, yearSpendCents: spend, favourites: fav, last: last ? { number: last.number, at: last.created_at, cents: last.total_cents, items: lastItems } : null });
  });

  /* ===== 10. pacing by party size ===== */
  let gapCache = { at: 0, by: {} };
  h.partyGap = (course, party) => {
    if (Date.now() - gapCache.at > 10 * 60_000) {
      const rows = db.prepare("SELECT oi.order_id, oi.course, oi.seat, oi.fired_at, oi.done_at FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id IS NOT NULL AND o.created_at > datetime('now','-60 days') AND oi.course IS NOT NULL").all();
      const per = {};
      for (const r of rows) { const o = (per[r.order_id] = per[r.order_id] || { seats: new Set(), c: {} }); if (r.seat > 0) o.seats.add(r.seat); const c = (o.c[r.course] = o.c[r.course] || { f: [], d: [] }); if (r.fired_at) c.f.push(ms(r.fired_at)); if (r.done_at) c.d.push(ms(r.done_at)); }
      const gaps = {};
      for (const o of Object.values(per)) {
        const b = bucket(o.seats.size || 2);
        for (const c of Object.keys(o.c).map(Number)) { if (c < 2 || !o.c[c - 1]?.d.length || !o.c[c].f.length) continue; const g = (Math.min(...o.c[c].f) - Math.max(...o.c[c - 1].d)) / 60000; if (g > 0 && g < 120) (gaps[`${c}:${b}`] = gaps[`${c}:${b}`] || []).push(g); }
      }
      const by = {}; for (const [k, list] of Object.entries(gaps)) { if (list.length < 3) continue; list.sort((a, b) => a - b); by[k] = Math.round(list[Math.floor(list.length / 2)]); }
      gapCache = { at: Date.now(), by };
    }
    return gapCache.by[`${course}:${bucket(party || 2)}`] ?? null;
  };
  h.partySizeAt = (tableId) => {
    const g = db.prepare('SELECT g.party_size FROM tables t JOIN guests g ON g.id = t.guest_id WHERE t.id = ?').get(tableId);
    if (g?.party_size) return g.party_size;
    return db.prepare("SELECT COUNT(DISTINCT oi.seat) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND o.paid_at IS NULL AND oi.seat > 0").get(tableId).n || 2;
  };
}
