// Round 21: join tables, seat allergies, split by seat, top dishes, prep leftovers, prepay pre-orders,
// proof on receipts, ticket recall list, auto-VIP, course pacing hints.
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, forEachLocation, currentSlug } from './db.js';
import { priceLines } from './commerce.js';
import { emailReceipt, proofHook } from './pro.js';
import { emailEnabled } from './notify.js';

registerSchema((db) => {
  const t = db.prepare('PRAGMA table_info(tables)').all().map((c) => c.name);
  if (!t.includes('joined_to')) db.exec('ALTER TABLE tables ADD COLUMN joined_to INTEGER');
  const o = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!o.includes('vip_checked')) db.exec('ALTER TABLE orders ADD COLUMN vip_checked INTEGER NOT NULL DEFAULT 0');
  const b = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  if (b.length && !b.includes('preorder_paid_cents')) db.exec('ALTER TABLE bookings ADD COLUMN preorder_paid_cents INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS seat_allergies (table_id INTEGER NOT NULL, seat INTEGER NOT NULL, allergy TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (table_id, seat));
    CREATE TABLE IF NOT EXISTS prep_leftovers (date TEXT NOT NULL, item_id INTEGER NOT NULL, qty INTEGER NOT NULL, by_label TEXT, at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (date, item_id));`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v) ?? d; } catch { return d; } };
const ms = (sql) => Date.parse(`${String(sql).replace(' ', 'T')}Z`);

export function registerSeat({ app, staff, h }) {
  const { parse, clientIp, notifyStaff, publicLimiter, requireCustomer, publicBase } = h;
  const unit = () => getSettings().unit_label;

  /* ===== 1. join tables ===== */
  staff.post('/tables/:id/join', (req, res) => {
    const main = db.prepare('SELECT * FROM tables WHERE id = ?').get(Number(req.params.id)); if (!main) throw err('Not found', 404);
    const { withTableId } = parse(z.object({ withTableId: z.number().int() }), req.body);
    const other = db.prepare('SELECT * FROM tables WHERE id = ?').get(withTableId); if (!other || other.id === main.id) throw err('Pick another table');
    if (other.joined_to) throw err(`${unit()} ${other.label} is already joined to another table`, 409);
    const offset = main.seats || 4;
    db.transaction(() => {
      db.prepare("UPDATE order_items SET seat = seat + ? WHERE seat > 0 AND order_id IN (SELECT id FROM orders WHERE table_id = ? AND paid_at IS NULL AND status <> 'void')").run(offset, other.id);
      db.prepare("UPDATE orders SET table_id = ? WHERE table_id = ? AND paid_at IS NULL AND status <> 'void'").run(main.id, other.id);
      db.prepare("UPDATE bills SET status = 'void', closed_at = datetime('now') WHERE table_id = ? AND status = 'open' AND id NOT IN (SELECT bill_id FROM payments WHERE status = 'paid' AND bill_id IS NOT NULL)").run(other.id);
      db.prepare("UPDATE tables SET joined_to = ?, status = 'seated', guest_id = COALESCE(guest_id, ?) WHERE id = ?").run(main.id, main.guest_id, other.id);
      if (main.status !== 'seated' && other.guest_id) db.prepare("UPDATE tables SET status = 'seated', guest_id = ?, seated_at = COALESCE(seated_at, ?) WHERE id = ?").run(other.guest_id, other.seated_at, main.id);
      for (const a of db.prepare('SELECT * FROM seat_allergies WHERE table_id = ?').all(other.id)) db.prepare('INSERT OR REPLACE INTO seat_allergies (table_id, seat, allergy) VALUES (?, ?, ?)').run(main.id, a.seat + offset, a.allergy);
      db.prepare('DELETE FROM seat_allergies WHERE table_id = ?').run(other.id);
    })();
    audit(req.user, 'table.join', `${unit()} ${main.label} + ${other.label}`, clientIp(req)); notifyStaff('tables'); notifyStaff('orders');
    res.json({ ok: true, seats: (main.seats || 4) + (other.seats || 4) });
  });
  staff.post('/tables/:id/unjoin', (req, res) => {
    const main = db.prepare('SELECT * FROM tables WHERE id = ?').get(Number(req.params.id)); if (!main) throw err('Not found', 404);
    const n = db.prepare("UPDATE tables SET joined_to = NULL, status = 'dirty', guest_id = NULL WHERE joined_to = ?").run(main.id).changes;
    audit(req.user, 'table.unjoin', `${unit()} ${main.label} (${n})`, clientIp(req)); notifyStaff('tables'); res.json({ ok: true, released: n });
  });
  h.joinedSeats = (t) => (t.seats || 4) + db.prepare('SELECT COALESCE(SUM(seats),0) n FROM tables WHERE joined_to = ?').get(t.id).n;
  h.joinedTo = () => Object.fromEntries(db.prepare('SELECT t.id, j.label FROM tables t JOIN tables j ON j.id = t.joined_to').all().map((r) => [r.id, r.label]));
  h.joinedWith = (id) => db.prepare('SELECT label FROM tables WHERE joined_to = ? ORDER BY label').all(id).map((r) => r.label);

  /* ===== 2. seat allergies ===== */
  staff.get('/tables/:id/seat-allergies', (req, res) => res.json(db.prepare('SELECT seat, allergy FROM seat_allergies WHERE table_id = ? ORDER BY seat').all(Number(req.params.id))));
  staff.put('/tables/:id/seat-allergies', (req, res) => {
    const { seat, allergy } = parse(z.object({ seat: z.number().int().min(1).max(40), allergy: z.string().trim().max(80) }), req.body);
    const tid = Number(req.params.id); const t = db.prepare('SELECT label FROM tables WHERE id = ?').get(tid); if (!t) throw err('Not found', 404);
    if (allergy) db.prepare('INSERT OR REPLACE INTO seat_allergies (table_id, seat, allergy) VALUES (?, ?, ?)').run(tid, seat, allergy);
    else db.prepare('DELETE FROM seat_allergies WHERE table_id = ? AND seat = ?').run(tid, seat);
    audit(req.user, 'seat.allergy', `${unit()} ${t.label} seat ${seat}: ${allergy || 'cleared'}`, clientIp(req)); res.json({ ok: true });
  });
  /** Called after a table order is created: tags each seat's dishes and the order's allergy note. */
  h.applySeatAllergies = (orderId, tableId) => {
    if (!tableId) return;
    const al = Object.fromEntries(db.prepare('SELECT seat, allergy FROM seat_allergies WHERE table_id = ?').all(tableId).map((r) => [r.seat, r.allergy])); if (!Object.keys(al).length) return;
    const found = new Set();
    for (const i of db.prepare('SELECT id, seat, note FROM order_items WHERE order_id = ? AND seat > 0').all(orderId)) {
      const a = al[i.seat]; if (!a) continue; found.add(`Seat ${i.seat}: ${a}`);
      db.prepare('UPDATE order_items SET note = ? WHERE id = ?').run(`ALLERGY ${a}${i.note ? ` · ${i.note}` : ''}`.slice(0, 160), i.id);
    }
    if (found.size) { const o = db.prepare('SELECT allergy_note FROM orders WHERE id = ?').get(orderId); db.prepare('UPDATE orders SET allergy_note = ? WHERE id = ?').run([o.allergy_note, ...found].filter(Boolean).join('; ').slice(0, 300), orderId); }
  };
  // clear a table's seat allergies once nobody is sitting there
  setInterval(() => forEachLocation(() => { try { db.prepare("DELETE FROM seat_allergies WHERE at < datetime('now','-10 minutes') AND table_id IN (SELECT id FROM tables WHERE status <> 'seated')").run(); } catch { /* table gone */ } }), 120_000).unref();

  /* ===== 3. split by seat ===== */
  staff.get('/bills/:id/seats', (req, res) => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(req.params.id)); if (!bill) throw err('Not found', 404);
    const sum = h.billSummary(bill);
    const seatOf = Object.fromEntries(sum.items.length ? db.prepare(`SELECT id, seat FROM order_items WHERE id IN (${sum.items.map((i) => i.id).join(',')})`).all().map((r) => [r.id, r.seat || 0]) : []);
    const seats = {}; const shared = [];
    for (const i of sum.items) { if (i.paid || i.claimed) continue; const s = seatOf[i.id] || 0; if (s) (seats[s] = seats[s] || []).push(i); else shared.push(i); }
    const keys = Object.keys(seats).map(Number).sort((a, b) => a - b);
    // shared dishes are spread across the seats as an even split of their value, shown but paid by whoever pays last
    const sharedCents = shared.reduce((a, i) => a + i.shareCents, 0);
    res.json({ billId: bill.id, remainingCents: sum.remainingCents, sharedCents, sharedItems: shared.map((i) => ({ id: i.id, name: i.name, qty: i.qty, cents: i.shareCents })),
      seats: keys.map((s) => ({ seat: s, itemIds: seats[s].map((i) => i.id), items: seats[s].map((i) => `${i.qty} ${i.name}`), cents: seats[s].reduce((a, i) => a + i.shareCents, 0), sharedPartCents: keys.length ? Math.round(sharedCents / keys.length) : 0 })) });
  });

  /* ===== 4. my top dishes ===== */
  staff.get('/me/top-items', (req, res) => res.json(db.prepare(`SELECT oi.item_id id, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.created_by = ? AND o.created_at > datetime('now','-30 days') AND o.status <> 'void' AND oi.item_id IS NOT NULL AND oi.price_cents > 0 GROUP BY oi.item_id ORDER BY n DESC LIMIT 8`).all(req.user.id)));

  /* ===== 5. prep leftovers at close ===== */
  h.prepLeftovers = (lines, by, user) => {
    const date = localToday(); let costCents = 0; let n = 0;
    for (const l of lines) {
      if (!l.qty) continue;
      if (db.prepare('SELECT 1 FROM prep_leftovers WHERE date = ? AND item_id = ?').get(date, l.itemId)) continue; // already logged today
      costCents += h.logWaste({ itemId: l.itemId, qty: l.qty, reason: 'over-prepped', note: `Leftover at close${by ? ` (${by})` : ''}` }, user) || 0;
      db.prepare('INSERT INTO prep_leftovers (date, item_id, qty, by_label) VALUES (?, ?, ?, ?)').run(date, l.itemId, l.qty, by || null); n++;
    }
    if (n) { audit(user || null, 'prep.leftovers', `${n} dish${n === 1 ? '' : 'es'}, $${(costCents / 100).toFixed(2)}`, null); notifyStaff('waste'); }
    return { logged: n, costCents };
  };
  h.prepLeftoversToday = () => Object.fromEntries(db.prepare('SELECT item_id, qty FROM prep_leftovers WHERE date = ?').all(localToday()).map((r) => [r.item_id, r.qty]));

  /* ===== 6. prepay a pre-order ===== */
  app.post('/api/c/bookings/:id/preorder/pay', requireCustomer, (req, res) => {
    const s = getSettings(); if (s.booking_preorder_pay !== '1') throw err('Paying ahead is not available', 403);
    if (!h.onlinePayEnabled?.()) throw err('Online payments are not set up. Pay at the table instead.', 503);
    const bk = db.prepare("SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'booked'").get(Number(req.params.id), req.customer.id); if (!bk) throw err('Booking not found', 404);
    const lines = pj(bk.preorder, []); if (!lines.length) throw err('Pick your dishes first');
    const priced = priceLines(lines); const sub = priced.reduce((a, l) => a + l.price_cents * l.qty, 0);
    const owed = sub + Math.round((sub * Number(s.tax_rate)) / 100) - (bk.preorder_paid_cents || 0);
    if (owed <= 0) throw err('Your pre-order is already paid', 409);
    const pid = db.prepare("INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('preorder', ?, 'card', ?, ?)").run(owed, `Pre-order for ${bk.start_local}`, JSON.stringify({ bookingId: bk.id })).lastInsertRowid;
    const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `l=${currentSlug()}&`;
    res.json({ url: h.startPay(pid, { base, lines: [{ name: `${s.business_name}: food ordered ahead (${bk.start_local})`, cents: owed }], successUrl: `${base}/account?${l}paid=preorder`, cancelUrl: `${base}/account${l ? `?${l.slice(0, -1)}` : ''}`, email: req.customer.email, descr: 'Pre-order' }) });
  });
  h.payHooks = h.payHooks || {};
  h.payHooks.preorder = (p) => {
    const meta = pj(p.meta || '{}', {}); const bk = db.prepare('SELECT * FROM bookings WHERE id = ?').get(meta.bookingId); if (!bk) return;
    db.prepare('UPDATE bookings SET preorder_paid_cents = preorder_paid_cents + ? WHERE id = ?').run(p.amount_cents, bk.id);
    // already checked in: apply to the held order now
    const o = bk.guest_id ? db.prepare("SELECT * FROM orders WHERE guest_id = ? AND order_notes = 'Booking pre-order' AND paid_at IS NULL ORDER BY id DESC LIMIT 1").get(bk.guest_id) : null;
    if (o) db.prepare('UPDATE orders SET gift_cents = gift_cents + ? WHERE id = ?').run(Math.min(p.amount_cents, o.total_cents - o.gift_cents), o.id);
    audit(null, 'booking.preorder_paid', `#${bk.id}: $${(p.amount_cents / 100).toFixed(2)}`, null); notifyStaff('bookings');
  };
  /** At check-in the paid amount is credited on the held order, the same way gift cards are. */
  h.preorderCredit = (bk, orderId) => {
    const paid = db.prepare('SELECT preorder_paid_cents FROM bookings WHERE id = ?').get(bk.id)?.preorder_paid_cents || 0; if (!paid) return;
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const use = Math.min(paid, o.subtotal_cents - o.discount_cents + o.tax_cents);
    db.prepare('UPDATE orders SET gift_cents = gift_cents + ? WHERE id = ?').run(use, o.id);
    audit(null, 'booking.preorder_credit', `#${o.number}: $${(use / 100).toFixed(2)} paid ahead`, null);
  };

  /* ===== 7. proof of delivery on the receipt ===== */
  h.proofFor = (orderId) => {
    const ph = db.prepare('SELECT 1 FROM delivery_photos WHERE order_id = ?').get(orderId);
    const sg = db.prepare('SELECT name FROM delivery_signatures WHERE order_id = ?').get(orderId);
    return ph || sg ? { photo: Boolean(ph), signature: Boolean(sg), signedBy: sg?.name || null } : null;
  };
  proofHook.fn = h.proofFor;
  h.afterDelivered = (o, req) => {
    if (!o.contact_email || !emailEnabled() || !h.proofFor(o.id)) return;
    emailReceipt(o, o.contact_email, publicBase(req)).then((ok) => { if (ok) audit(null, 'receipt.proof_email', `#${o.number}`, null); }).catch(() => {});
  };
  app.get('/api/r/:token/proof/:what', publicLimiter, (req, res) => {
    const o = h.orderByReceipt ? h.orderByReceipt(req.params.token) : null; if (!o) return res.status(404).end();
    const row = req.params.what === 'photo' ? db.prepare('SELECT data FROM delivery_photos WHERE order_id = ?').get(o.id) : req.params.what === 'signature' ? db.prepare('SELECT data FROM delivery_signatures WHERE order_id = ?').get(o.id) : null;
    if (!row) return res.status(404).end();
    res.set('Content-Type', req.params.what === 'photo' ? 'image/jpeg' : 'image/png').set('Cache-Control', 'private, max-age=3600').send(Buffer.from(row.data.split(',')[1], 'base64'));
  });

  /* ===== 8. ticket recall list ===== */
  h.recentDone = (area, isAll) => {
    if (isAll) return db.prepare("SELECT o.id, o.number, o.customer_name, t.label table_label, COALESCE(o.ready_at, o.paid_at) done_at FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.status IN ('ready','paid') AND COALESCE(o.ready_at, o.paid_at) > datetime('now','-16 hours') AND o.sent_at IS NOT NULL ORDER BY COALESCE(o.ready_at, o.paid_at) DESC LIMIT 20").all();
    return db.prepare("SELECT o.id, o.number, o.customer_name, t.label table_label, MAX(oi.done_at) done_at, GROUP_CONCAT(oi.qty || ' ' || oi.name, ', ') items FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN tables t ON t.id = o.table_id WHERE oi.done_station = ? AND oi.done_at > datetime('now','-16 hours') GROUP BY o.id ORDER BY MAX(oi.done_at) DESC LIMIT 20").all(area);
  };

  /* ===== 9. auto-VIP ===== */
  const vipSweep = () => forEachLocation(() => {
    try {
      const s = getSettings(); if (s.auto_vip !== '1') return;
      const min = Number(s.auto_vip_spend_cents || 0);
      const rows = db.prepare("SELECT id, number, customer_id FROM orders WHERE vip_checked = 0 AND status IN ('held','open','sent') AND created_at > datetime('now','-3 hours')").all();
      for (const o of rows) {
        db.prepare('UPDATE orders SET vip_checked = 1 WHERE id = ?').run(o.id);
        if (!o.customer_id) continue;
        const member = s.auto_vip_members !== '0' && db.prepare("SELECT 1 FROM memberships WHERE customer_id = ? AND status = 'active'").get(o.customer_id);
        const spend = min ? db.prepare("SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE customer_id = ? AND paid_at > datetime('now','-365 days') AND status <> 'void'").get(o.customer_id).c : 0;
        if (member || (min && spend >= min)) {
          const r = db.prepare('UPDATE orders SET priority = 2 WHERE id = ? AND priority = 0').run(o.id);
          if (r.changes) { audit(null, 'order.auto_vip', `#${o.number} (${member ? 'member' : 'top guest'})`, null); notifyStaff('orders'); }
        }
      }
    } catch (e) { if (!/no such table/.test(e.message)) console.error('auto vip', e.message); }
  });
  h.vipSweep = vipSweep;
  setInterval(vipSweep, 15_000).unref();

  /* ===== 10. course pacing hints ===== */
  let gapCache = { at: 0, by: {} };
  const typicalGap = (course) => {
    if (Date.now() - gapCache.at > 10 * 60_000) {
      const rows = db.prepare("SELECT oi.order_id, oi.course, oi.fired_at, oi.done_at FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id IS NOT NULL AND o.created_at > datetime('now','-30 days') AND oi.course IS NOT NULL").all();
      const per = {}; for (const r of rows) { const k = r.order_id; (per[k] = per[k] || {}); const c = (per[k][r.course] = per[k][r.course] || { fired: [], done: [] }); if (r.fired_at) c.fired.push(ms(r.fired_at)); if (r.done_at) c.done.push(ms(r.done_at)); }
      const gaps = {};
      for (const o of Object.values(per)) for (const c of Object.keys(o).map(Number)) {
        if (c < 2 || !o[c - 1]?.done.length || !o[c].fired.length) continue;
        const g = (Math.min(...o[c].fired) - Math.max(...o[c - 1].done)) / 60000; if (g > 0 && g < 120) (gaps[c] = gaps[c] || []).push(g);
      }
      const by = {}; for (const [c, list] of Object.entries(gaps)) { if (list.length < 3) continue; list.sort((a, b) => a - b); by[c] = Math.round(list[Math.floor(list.length / 2)]); }
      gapCache = { at: Date.now(), by };
    }
    return gapCache.by[course] ?? null;
  };
  h.coursePace = (tableId, course) => {
    const prev = db.prepare("SELECT MAX(oi.done_at) d, SUM(oi.done_at IS NULL) waiting FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND o.status IN ('open','sent','ready') AND oi.course = ? AND oi.fired_at IS NOT NULL").get(tableId, course - 1);
    const typical = typicalGap(course) ?? Number(getSettings().pace_default_minutes || 15);
    if (!prev?.d) return { typical, since: null, hint: prev?.waiting ? `Course ${course - 1} is still cooking` : null, due: false };
    if (prev.waiting) return { typical, since: null, hint: `Course ${course - 1} is still cooking`, due: false };
    const since = Math.max(0, Math.round((Date.now() - ms(prev.d)) / 60000));
    return { typical, since, due: since >= typical, hint: since >= typical ? `Course ${course - 1} landed ${since} min ago; tables usually get the next course after ${typical}` : `Course ${course - 1} landed ${since} min ago. Usually fired at about ${typical} min` };
  };
}
