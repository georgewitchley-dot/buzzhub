// Round 18: split a tab (tab members), my tables on the pad, table timeline, prep log feeding Use first,
// delivery route order, running late for bookings, server coaching, expo photo check.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, getJwtSecret, forEachLocation } from './db.js';
import { userFromToken, SESSION_COOKIE } from './security.js';
import { dayBounds } from './ops.js';
import { pushToUsers } from './notify.js';

registerSchema((db) => {
  const o = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!o.includes('tab_member')) db.exec('ALTER TABLE orders ADD COLUMN tab_member TEXT');
  const t = db.prepare('PRAGMA table_info(tabs)').all().map((c) => c.name);
  if (t.length && !t.includes('code')) db.exec('ALTER TABLE tabs ADD COLUMN code TEXT');
  const b = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  if (b.length && !b.includes('late_minutes')) db.exec('ALTER TABLE bookings ADD COLUMN late_minutes INTEGER');
  if (b.length && !b.includes('late_at')) db.exec('ALTER TABLE bookings ADD COLUMN late_at TEXT');
  db.exec(`
  CREATE TABLE IF NOT EXISTS prep_log (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, area TEXT NOT NULL, kind TEXT NOT NULL, ref_id INTEGER NOT NULL, name TEXT NOT NULL, qty REAL NOT NULL, by_label TEXT, lot_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (day, area, kind, ref_id));
  CREATE TABLE IF NOT EXISTS plate_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, data TEXT NOT NULL, by_label TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ms = (sql) => Date.parse(`${String(sql).replace(' ', 'T')}Z`);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dist = (a, b, c, d) => { const R = 6371; const r = Math.PI / 180; const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

export function registerTable({ app, staff, h }) {
  const { parse, clientIp, requireAuth, notifyStaff, publicLimiter } = h;
  const mgr = requireAuth('manager');
  const who = (req) => {
    const t = req.get('X-Kds');
    if (t) { try { const p = jwt.verify(t, `${getJwtSecret()}:kds`); if (p.loc === currentSlug() && String(p.v) === String(getSettings().kds_version || '1')) return { area: p.area, user: null }; } catch { /* bad */ } throw err('This kitchen screen is signed out.', 401); }
    let user = null; try { user = req.cookies?.[SESSION_COOKIE] ? userFromToken(req.cookies[SESSION_COOKIE]) : null; } catch { user = null; }
    if (!user) throw err('Sign in first', 401);
    return { area: String(req.query.area || req.body?.area || 'All areas'), user };
  };
  const label = (w) => (w.user ? w.user.name.split(' ')[0] : `${w.area} screen`);

  /* ===== split a tab: friends join with a 4-letter code, each pays their own ===== */
  const tabByToken = (t) => (/^[A-Za-z0-9_-]{16,30}$/.test(t || '') ? db.prepare('SELECT * FROM tabs WHERE token = ?').get(t) : null);
  h.tabCode = (tabId) => {
    let tab = db.prepare('SELECT * FROM tabs WHERE id = ?').get(tabId); if (tab.code) return tab.code;
    let code; do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]).join(''); } while (db.prepare("SELECT 1 FROM tabs WHERE code = ? AND status <> 'closed'").get(code));
    db.prepare('UPDATE tabs SET code = ? WHERE id = ?').run(code, tabId); return code;
  };
  app.post('/api/t/:token/tab/join', publicLimiter, (req, res) => {
    const b = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z]{4}$/, 'Type the 4-letter tab code'), name: z.string().trim().min(1).max(30) }), req.body);
    const tab = db.prepare("SELECT * FROM tabs WHERE code = ? AND status = 'open' AND opened_at > datetime('now','-24 hours')").get(b.code); if (!tab) throw err('No open tab with that code', 404);
    audit(null, 'tab.join', `${b.name} joined ${tab.name}'s tab`, clientIp(req)); notifyStaff('tabs');
    res.json({ token: tab.token, member: b.name });
  });
  h.tabMemberFor = (body) => (typeof body?.member === 'string' ? body.member.trim().slice(0, 30) || null : null);
  /** Close (or reuse) the tab's check and return the bill items one member ordered, for paying "my items". */
  h.memberItems = (tab, member) => {
    if (!member) return [];
    return db.prepare("SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.tab_id = ? AND o.tab_member = ? AND o.status <> 'void'").all(tab.id, member).map((r) => r.id);
  };
  h.tabMembers = (tab) => db.prepare("SELECT tab_member name, COUNT(*) rounds, SUM(total_cents) cents FROM orders WHERE tab_id = ? AND status <> 'void' AND tab_member IS NOT NULL GROUP BY tab_member").all(tab.id);

  /* ===== my tables on the pad ===== */
  staff.get('/pad/tables', (req, res) => {
    const rows = db.prepare('SELECT t.id, t.label, t.seats, t.zone, t.status, t.server_id, t.seated_at, g.name guest_name, g.party_size, u.name server_name FROM tables t LEFT JOIN guests g ON g.id = t.guest_id LEFT JOIN users u ON u.id = t.server_id ORDER BY t.zone, t.id').all();
    const open = Object.fromEntries(db.prepare("SELECT table_id, COUNT(*) n, SUM(total_cents) c, MAX(status = 'ready') ready FROM orders WHERE table_id IS NOT NULL AND status IN ('open','sent','ready','held') AND paid_at IS NULL AND tab_id IS NULL GROUP BY table_id").all().map((r) => [r.table_id, r]));
    res.json({ me: req.user.id, tables: rows.map((t) => ({ ...t, mine: t.server_id === req.user.id, openChecks: open[t.id]?.n || 0, openCents: open[t.id]?.c || 0, foodReady: Boolean(open[t.id]?.ready), seatedMinutes: t.seated_at ? Math.round((Date.now() - ms(t.seated_at)) / 60000) : null })) });
  });

  /* ===== table timeline (expo + floor) ===== */
  h.tableTimeline = () => {
    const tables = db.prepare("SELECT t.id, t.label, t.seated_at, g.party_size FROM tables t LEFT JOIN guests g ON g.id = t.guest_id WHERE t.status = 'seated'").all();
    return tables.map((t) => {
      const items = db.prepare("SELECT oi.course, oi.fired_at, oi.done_at, o.served_at, o.status, o.created_at FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND o.status <> 'void' AND o.created_at >= COALESCE(?, datetime('now','-6 hours')) AND oi.price_cents >= 0").all(t.id, t.seated_at);
      const courses = [...new Set(items.map((i) => i.course))].sort().map((c) => {
        const its = items.filter((i) => i.course === c);
        const state = its.every((i) => i.served_at) ? 'served' : its.every((i) => i.done_at) ? 'ready' : its.some((i) => i.fired_at) ? 'cooking' : 'held';
        return { course: c, state, items: its.reduce((a, i) => a + 1, 0) };
      });
      return { id: t.id, label: t.label, party: t.party_size, minutes: t.seated_at ? Math.round((Date.now() - ms(t.seated_at)) / 60000) : null, courses, ordered: items.length > 0 };
    }).sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
  };
  staff.get('/table-timeline', (req, res) => res.json(h.tableTimeline()));

  /* ===== prep log (shared across screens) feeding Use first ===== */
  app.get('/api/kds/prep-log', (req, res) => { const w = who(req); res.json(db.prepare('SELECT kind, ref_id, qty, by_label, lot_id, at FROM prep_log WHERE day = ? AND area = ?').all(localToday(), w.area)); });
  app.post('/api/kds/prep-log', (req, res) => {
    const w = who(req); const b = parse(z.object({ kind: z.enum(['item', 'ingredient']), refId: z.number().int(), qty: z.number().min(0).max(1e6), done: z.boolean(), by: z.string().trim().max(30).optional() }), req.body);
    const day = localToday();
    if (!b.done) {
      const row = db.prepare('SELECT * FROM prep_log WHERE day = ? AND area = ? AND kind = ? AND ref_id = ?').get(day, w.area, b.kind, b.refId);
      if (row?.lot_id) db.prepare("DELETE FROM ingredient_lots WHERE id = ? AND status = 'open'").run(row.lot_id);
      db.prepare('DELETE FROM prep_log WHERE day = ? AND area = ? AND kind = ? AND ref_id = ?').run(day, w.area, b.kind, b.refId);
      notifyStaff('lots'); return res.json({ ok: true });
    }
    const name = b.kind === 'item' ? db.prepare('SELECT name FROM menu_items WHERE id = ?').get(b.refId)?.name : db.prepare('SELECT name FROM ingredients WHERE id = ?').get(b.refId)?.name;
    if (!name) throw err('Not found', 404);
    let lotId = null;
    if (b.kind === 'ingredient' && b.qty > 0) { const before = db.prepare('SELECT MAX(id) m FROM ingredient_lots').get()?.m || 0; h.onReceive?.(b.refId, b.qty, `prep (${w.area})`); const after = db.prepare('SELECT MAX(id) m FROM ingredient_lots').get()?.m || 0; if (after > before) lotId = after; }
    db.prepare('INSERT OR REPLACE INTO prep_log (day, area, kind, ref_id, name, qty, by_label, lot_id) VALUES (?,?,?,?,?,?,?,?)').run(day, w.area, b.kind, b.refId, name, b.qty, w.user ? label(w) : b.by || label(w), lotId);
    audit(w.user, 'prep.done', `${b.qty} ${name} (${label(w)})`, clientIp(req)); notifyStaff('lots'); res.json({ ok: true, lot: Boolean(lotId) });
  });

  /* ===== delivery route order ===== */
  staff.get('/deliveries/route', (req, res) => {
    const s = getSettings(); const driverId = Number(req.query.driver) || req.user.id;
    if (driverId !== req.user.id && !['manager', 'owner'].includes(req.user.role)) throw err('Only your own route', 403);
    const stops = db.prepare("SELECT id, number, delivery_address, drop_lat, drop_lng, customer_name, contact_phone, out_at, status FROM orders WHERE fulfillment = 'delivery' AND driver_id = ? AND delivered_at IS NULL AND status <> 'void' ORDER BY id").all(driverId);
    const placed = stops.filter((o) => o.drop_lat != null); const rest = stops.filter((o) => o.drop_lat == null);
    let cur = s.biz_lat ? [Number(s.biz_lat), Number(s.biz_lng)] : placed[0] ? [placed[0].drop_lat, placed[0].drop_lng] : null; const order = []; let km = 0;
    const left = [...placed];
    while (left.length && cur) { let bi = 0; let bd = Infinity; left.forEach((o, i) => { const d = dist(cur[0], cur[1], o.drop_lat, o.drop_lng); if (d < bd) { bd = d; bi = i; } }); const o = left.splice(bi, 1)[0]; km += bd; order.push({ ...o, legKm: Math.round(bd * 10) / 10 }); cur = [o.drop_lat, o.drop_lng]; }
    const all = [...order, ...rest];
    const maps = all.length ? `https://www.google.com/maps/dir/?api=1${s.biz_lat ? `&origin=${s.biz_lat},${s.biz_lng}` : ''}&destination=${encodeURIComponent(all[all.length - 1].delivery_address || '')}${all.length > 1 ? `&waypoints=${all.slice(0, -1).map((o) => encodeURIComponent(o.delivery_address || '')).join('|')}` : ''}&travelmode=driving` : null;
    res.json({ driverId, stops: all.map((o, i) => ({ stop: i + 1, id: o.id, number: o.number, address: o.delivery_address, name: o.customer_name, phone: o.contact_phone, legKm: o.legKm ?? null, out: Boolean(o.out_at), ready: ['ready', 'paid'].includes(o.status) })), totalKm: Math.round(km * 10) / 10, mapsUrl: maps, unplaced: rest.length });
  });

  /* ===== running late (customer booking) ===== */
  h.bookingLate = (customerId, bookingId, minutes) => {
    const bk = db.prepare("SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'booked'").get(bookingId, customerId); if (!bk) throw err('Booking not found', 404);
    db.prepare("UPDATE bookings SET late_minutes = ?, late_at = datetime('now') WHERE id = ?").run(minutes, bk.id);
    const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
    pushToUsers(['staff', 'manager', 'owner'], { title: `${c?.name?.split(' ')[0] || 'A guest'} is running ${minutes} min late`, body: `Booking at ${bk.start_local.slice(11)} for ${bk.party_size}.`, tag: `late-${bk.id}`, url: '/bookings' }).catch(() => {});
    audit(null, 'booking.late', `${c?.name}: ${minutes} min (${bk.start_local})`, null); notifyStaff('bookings');
  };

  /* ===== server coaching ===== */
  staff.get('/coaching', mgr, (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30)); const since = dayBounds(addDays(localToday(), -(days - 1))).start;
    const addon = /drink|dessert|side|app|starter|beer|wine|cocktail/i;
    const rows = db.prepare("SELECT o.id, o.created_by, u.name, o.subtotal_cents - o.discount_cents net, o.tip_cents, o.table_id FROM orders o JOIN users u ON u.id = o.created_by WHERE o.paid_at >= ? AND o.status <> 'void' AND o.created_by IS NOT NULL").all(since);
    const items = rows.length ? db.prepare(`SELECT oi.order_id, oi.qty, m.category FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id IN (${rows.map((r) => r.id).join(',')}) AND oi.price_cents > 0`).all() : [];
    const byOrder = new Map(); for (const i of items) { const a = byOrder.get(i.order_id) || { n: 0, addon: false }; a.n += i.qty; if (addon.test(i.category || '')) a.addon = true; byOrder.set(i.order_id, a); }
    const people = new Map();
    for (const r of rows) { const p = people.get(r.created_by) || { userId: r.created_by, name: r.name, checks: 0, net: 0, tips: 0, items: 0, addons: 0 }; const b = byOrder.get(r.id) || { n: 0, addon: false }; p.checks++; p.net += r.net; p.tips += r.tip_cents || 0; p.items += b.n; if (b.addon) p.addons++; people.set(r.created_by, p); }
    const fmt = (p) => ({ userId: p.userId, name: p.name, checks: p.checks, salesCents: p.net, avgCheckCents: p.checks ? Math.round(p.net / p.checks) : 0, itemsPerCheck: p.checks ? Math.round((p.items / p.checks) * 10) / 10 : 0, addonPct: p.checks ? Math.round((p.addons / p.checks) * 100) : 0, tipPct: p.net ? Math.round((p.tips / p.net) * 1000) / 10 : 0 });
    const list = [...people.values()].filter((p) => p.checks >= 1).map(fmt).sort((a, b) => b.salesCents - a.salesCents);
    const team = fmt([...people.values()].reduce((t, p) => ({ ...t, checks: t.checks + p.checks, net: t.net + p.net, tips: t.tips + p.tips, items: t.items + p.items, addons: t.addons + p.addons }), { userId: 0, name: 'Team', checks: 0, net: 0, tips: 0, items: 0, addons: 0 }));
    res.json({ days, team, people: list.map((p) => ({ ...p, tips: p.checks < 5 ? [] : [p.avgCheckCents < team.avgCheckCents * 0.85 ? 'Check average is below the team: suggest a starter or dessert' : null, p.addonPct < team.addonPct - 15 ? 'Fewer add-ons than the team: offer drinks and sides' : null, p.tipPct < team.tipPct - 3 ? 'Tips are lower than the team: check in at the table more' : null].filter(Boolean) })) });
  });

  /* ===== expo photo check ===== */
  h.photoNeeded = (o) => { const m = getSettings().photo_check || 'off'; if (m === 'off') return false; if (m === 'all') return true; const allergy = Boolean(o.allergy || o.allergy_note); return (m === 'allergy' || m === 'special') && allergy || (m === 'special' && (o.source === 'event' || /event|vip/i.test(o.order_notes || ''))); };
  h.hasPlatePhoto = (orderId) => Boolean(db.prepare('SELECT 1 FROM plate_photos WHERE order_id = ?').get(orderId));
  app.post('/api/kds/plate-photo', (req, res) => {
    const w = who(req); const b = parse(z.object({ orderId: z.number().int(), photo: z.string().max(400000) }), req.body);
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b.photo)) throw err('Bad photo');
    const o = db.prepare('SELECT number FROM orders WHERE id = ?').get(b.orderId); if (!o) throw err('Not found', 404);
    db.prepare('INSERT INTO plate_photos (order_id, data, by_label) VALUES (?,?,?)').run(b.orderId, b.photo, label(w));
    audit(w.user, 'plate.photo', `#${o.number} (${label(w)})`, clientIp(req)); res.json({ ok: true });
  });
  staff.get('/plate-photos', mgr, (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : localToday(); const { start, end } = dayBounds(date);
    res.json(db.prepare('SELECT p.id, p.order_id, p.by_label, p.at, o.number, o.allergy_note, o.order_notes FROM plate_photos p JOIN orders o ON o.id = p.order_id WHERE p.at >= ? AND p.at < ? ORDER BY p.at DESC').all(start, end).map((p) => ({ ...p, url: `/api/staff/plate-photos/${p.id}` })));
  });
  setInterval(() => forEachLocation(() => { try { db.prepare("DELETE FROM plate_photos WHERE at < datetime('now','-60 days')").run(); } catch { /* fine */ } }), 6 * 3600_000).unref();
  staff.get('/plate-photos/:id', mgr, (req, res) => { const p = db.prepare('SELECT data FROM plate_photos WHERE id = ?').get(Number(req.params.id)); if (!p) throw err('Not found', 404); res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=3600').send(Buffer.from(p.data.split(',')[1], 'base64')); });
}
