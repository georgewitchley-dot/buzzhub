// Round 20: transfer a table, prep par levels, delivery signatures, pre-order reminders.
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, forEachLocation, currentSlug } from './db.js';
import { pushToCustomer, emailEnabled, emailGuest } from './notify.js';

registerSchema((db) => {
  const m = db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name);
  if (!m.includes('prep_par')) db.exec('ALTER TABLE menu_items ADD COLUMN prep_par INTEGER');
  const b = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  if (b.length && !b.includes('preorder_reminded')) db.exec('ALTER TABLE bookings ADD COLUMN preorder_reminded TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS prep_counts (date TEXT NOT NULL, item_id INTEGER NOT NULL, qty INTEGER NOT NULL, by_label TEXT, at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (date, item_id));
    CREATE TABLE IF NOT EXISTS delivery_signatures (order_id INTEGER PRIMARY KEY, data TEXT NOT NULL, name TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));`);
});

const err = (msg, status = 400, extra = {}) => Object.assign(new Error(msg), { status, ...extra });
const addDay = (d) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

export function registerFlow({ app, staff, h }) {
  const { parse, clientIp, requireAuth, notifyStaff } = h;
  const mgr = requireAuth('manager');

  /* ===== transfer a table ===== */
  staff.post('/tables/:id/transfer', (req, res) => {
    const from = db.prepare('SELECT * FROM tables WHERE id = ?').get(Number(req.params.id)); if (!from) throw err('Not found', 404);
    const b = parse(z.object({ toTableId: z.number().int().optional(), toUserId: z.number().int().optional() }), req.body);
    if (!b.toTableId && !b.toUserId) throw err('Pick a table or a server');
    const unit = getSettings().unit_label; const did = [];
    db.transaction(() => {
      if (b.toTableId && b.toTableId !== from.id) {
        const to = db.prepare('SELECT * FROM tables WHERE id = ?').get(b.toTableId); if (!to) throw err('That table is gone', 404);
        if (to.status === 'seated' && from.guest_id) throw err(`${unit} ${to.label} already has guests. Clear it first.`, 409);
        const moved = db.prepare("UPDATE orders SET table_id = ? WHERE table_id = ? AND paid_at IS NULL AND status <> 'void'").run(to.id, from.id).changes;
        db.prepare("UPDATE bills SET table_id = ? WHERE table_id = ? AND status = 'open'").run(to.id, from.id);
        if (from.guest_id) {
          db.prepare("UPDATE tables SET status = 'seated', guest_id = ?, seated_at = ? WHERE id = ?").run(from.guest_id, from.seated_at, to.id);
          db.prepare('UPDATE guests SET table_id = ? WHERE id = ?').run(to.id, from.guest_id);
          db.prepare("UPDATE tables SET status = 'dirty', guest_id = NULL, seated_at = NULL WHERE id = ?").run(from.id);
        }
        if (from.server_id && !b.toUserId) db.prepare('UPDATE tables SET server_id = ? WHERE id = ?').run(from.server_id, to.id);
        try { db.prepare("UPDATE tabs SET table_id = ? WHERE table_id = ? AND status = 'open'").run(to.id, from.id); } catch { /* no tabs */ }
        did.push(`moved to ${unit} ${to.label} (${moved} check${moved === 1 ? '' : 's'})`);
      }
      if (b.toUserId) {
        const u = db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(b.toUserId); if (!u) throw err('That person is not active', 404);
        const tid = b.toTableId || from.id;
        db.prepare('UPDATE tables SET server_id = ? WHERE id = ?').run(u.id, tid);
        const n = db.prepare("UPDATE orders SET created_by = ? WHERE table_id = ? AND paid_at IS NULL AND status <> 'void'").run(u.id, tid).changes;
        did.push(`handed to ${u.name} (${n} check${n === 1 ? '' : 's'})`);
      }
    })();
    audit(req.user, 'table.transfer', `${unit} ${from.label} ${did.join(', ')}`, clientIp(req));
    notifyStaff('tables'); notifyStaff('orders'); notifyStaff('guests');
    res.json({ ok: true, done: did });
  });
  staff.get('/servers-on', (req, res) => res.json(db.prepare("SELECT DISTINCT u.id, u.name FROM users u JOIN shifts s ON s.user_id = u.id AND s.clock_out IS NULL WHERE u.active = 1 ORDER BY u.name").all()));

  /* ===== prep par levels ===== */
  h.applyPars = (items, keep) => {
    const date = localToday(); const byId = new Map(items.map((i) => [i.id, { ...i, forecast: i.prep }]));
    for (const m of db.prepare('SELECT id, name, category, station, prep_par FROM menu_items WHERE prep_par > 0 AND active = 1').all()) {
      if (!keep(m)) continue;
      const cur = byId.get(m.id) || { id: m.id, name: m.name, prep: 0, forecast: 0 };
      byId.set(m.id, { ...cur, par: m.prep_par });
    }
    const counts = Object.fromEntries(db.prepare('SELECT item_id, qty, by_label FROM prep_counts WHERE date = ?').all(date).map((r) => [r.item_id, r]));
    return [...byId.values()].map((i) => {
      const target = Math.max(i.forecast || 0, i.par || 0); const c = counts[i.id];
      return { ...i, target, onHand: c ? c.qty : null, countedBy: c?.by_label || null, prep: Math.max(0, target - (c ? c.qty : 0)) };
    }).sort((a, b) => b.prep - a.prep || a.name.localeCompare(b.name));
  };
  h.prepCount = (itemId, qty, by) => {
    if (!db.prepare('SELECT 1 FROM menu_items WHERE id = ?').get(itemId)) throw err('Not found', 404);
    if (qty === null) db.prepare('DELETE FROM prep_counts WHERE date = ? AND item_id = ?').run(localToday(), itemId);
    else db.prepare('INSERT OR REPLACE INTO prep_counts (date, item_id, qty, by_label) VALUES (?, ?, ?, ?)').run(localToday(), itemId, qty, by || null);
  };
  staff.get('/prep-pars', (req, res) => res.json(db.prepare('SELECT id, name, category, prep_par FROM menu_items WHERE active = 1 ORDER BY category, name').all()));
  staff.put('/menu/:id/prep-par', mgr, (req, res) => {
    const { par } = parse(z.object({ par: z.number().int().min(0).max(999).nullable() }), req.body);
    db.prepare('UPDATE menu_items SET prep_par = ? WHERE id = ?').run(par || null, Number(req.params.id));
    audit(req.user, 'prep.par', `item ${req.params.id}: ${par || 'none'}`, clientIp(req)); res.json({ ok: true });
  });

  /* ===== delivery signatures ===== */
  h.needsSignature = (o) => {
    const min = Number(getSettings().delivery_signature_cents || 0); if (!min) return false;
    const total = o.subtotal_cents - o.discount_cents + o.tax_cents + (o.fee_cents || 0);
    return total >= min && !db.prepare('SELECT 1 FROM delivery_signatures WHERE order_id = ?').get(o.id);
  };
  staff.post('/orders/:id/signature', (req, res) => {
    const b = parse(z.object({ signature: z.string().max(200000), name: z.string().trim().max(60).optional() }), req.body);
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature)) throw err('Bad signature');
    const o = db.prepare("SELECT * FROM orders WHERE id = ? AND fulfillment = 'delivery'").get(Number(req.params.id)); if (!o) throw err('Not found', 404);
    db.prepare('INSERT OR REPLACE INTO delivery_signatures (order_id, data, name) VALUES (?, ?, ?)').run(o.id, b.signature, b.name || null);
    audit(req.user, 'delivery.signature', `#${o.number}${b.name ? ` ${b.name}` : ''}`, clientIp(req)); res.json({ ok: true });
  });
  staff.get('/orders/:id/signature', (req, res) => {
    const s = db.prepare('SELECT data FROM delivery_signatures WHERE order_id = ?').get(Number(req.params.id)); if (!s) return res.status(404).end();
    res.set('Content-Type', 'image/png').send(Buffer.from(s.data.split(',')[1], 'base64'));
  });
  h.signatureMin = () => Number(getSettings().delivery_signature_cents || 0);

  /* ===== pre-order reminders (day before) ===== */
  const remind = () => forEachLocation(async () => {
    try {
      const s = getSettings(); if (s.booking_preorder !== '1' || s.preorder_reminder !== '1') return;
      const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: s.timezone || 'America/New_York' }).format(new Date()));
      if (hour < Number(s.preorder_reminder_hour || 15)) return;
      const tomorrow = addDay(localToday());
      const due = db.prepare("SELECT b.*, c.name, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.status = 'booked' AND b.preorder IS NULL AND b.preorder_reminded IS NULL AND substr(b.start_local,1,10) = ?").all(tomorrow);
      for (const b of due) {
        db.prepare("UPDATE bookings SET preorder_reminded = datetime('now') WHERE id = ?").run(b.id);
        const time = b.start_local.slice(11);
        const body = `You're booked tomorrow at ${time}. Want your food started the moment you sit down? Order ahead from your account.`;
        await pushToCustomer(b.customer_id, { title: `${s.business_name}: order ahead`, body, tag: `preorder-${b.id}`, url: currentSlug() === 'main' ? '/account' : `/account?l=${currentSlug()}` }).catch(() => {});
        if (emailEnabled() && b.email) await emailGuest(b.email, { businessName: s.business_name, subject: 'Order ahead for tomorrow', message: body, link: `${process.env.PUBLIC_URL || ''}/account`, accent: s.accent }).catch(() => {});
        audit(null, 'booking.preorder_reminder', `#${b.id} ${b.name}`, null);
      }
    } catch (e) { console.error('preorder reminders', e); }
  });
  h.runPreorderReminders = remind;
  staff.post('/preorder-reminders/run', mgr, async (req, res) => { await remind(); res.json({ ok: true, sent: db.prepare("SELECT COUNT(*) n FROM bookings WHERE preorder_reminded > datetime('now','-1 minute')").get().n }); });
  setInterval(remind, 10 * 60_000).unref();
}
