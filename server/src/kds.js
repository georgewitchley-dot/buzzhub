// Kitchen area screens: one tablet per area (grill, fryer, bar, pastry…), an expo screen that completes orders,
// a packing screen for to-go and delivery, all-day counts, and the menu board TV. Each screen is its own device
// token (like the time clock), or a signed-in staff member can open any area.
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, registerSchema, currentSlug, getJwtSecret, localToday } from './db.js';
import { userFromToken, SESSION_COOKIE } from './security.js';
import { menuWithMods } from './commerce.js';

registerSchema((db) => {
  const mi = db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name);
  if (!mi.includes('station')) db.exec('ALTER TABLE menu_items ADD COLUMN station TEXT');
  const oi = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
  if (!oi.includes('done_station')) db.exec('ALTER TABLE order_items ADD COLUMN done_station TEXT');
  const o = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!o.includes('packed_at')) db.exec('ALTER TABLE orders ADD COLUMN packed_at TEXT');
  if (!o.includes('expo_at')) db.exec('ALTER TABLE orders ADD COLUMN expo_at TEXT');
  if (!o.includes('allergy_checked_by')) db.exec('ALTER TABLE orders ADD COLUMN allergy_checked_by TEXT');
  const ct = db.prepare('PRAGMA table_info(checklist_templates)').all().map((c) => c.name);
  if (ct.length && !ct.includes('area')) db.exec('ALTER TABLE checklist_templates ADD COLUMN area TEXT');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
export const EXPO = 'Expo'; export const PACK = 'Packing'; export const ALL = 'All areas';

export function stationList() { const l = pj(getSettings().kitchen_stations, ['Kitchen']); return Array.isArray(l) && l.length ? l : ['Kitchen']; }
/** Which area makes this item: the item's own choice, else its category's, else the first area. */
export function stationFor(item, list = stationList(), map = pj(getSettings().station_map, {})) {
  if (item.station && list.includes(item.station)) return item.station;
  const st = map[item.category]; return st && list.includes(st) ? st : list[0];
}
const live = (i) => i.course <= 1 || i.fired_at; // held courses don't count until fired

let H = {};
function board() {
  const s = getSettings(); const list = stationList(); const map = pj(s.station_map, {});
  const orders = db.prepare(`SELECT o.id, o.number, o.status, o.source, o.customer_name, o.sent_at, o.ready_at, o.created_at, o.fulfillment, o.delivery_address, o.order_notes, o.prepaid, o.allergy_note, o.packed_at, o.expo_at, o.driver_id, o.arrived_at, o.arrival_note, o.handed_at, o.served_at, o.makegood_at, o.tab_id,
      t.label table_label, g.name guest_name, (SELECT c.tags FROM customers c WHERE c.id = COALESCE(o.customer_id, g.customer_id)) customer_tags, (SELECT name FROM users WHERE id = o.driver_id) driver_name
    FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN guests g ON g.id = o.guest_id
    WHERE o.status IN ('open','sent') OR (o.status IN ('ready','paid') AND o.ready_at > datetime('now','-45 minutes'))
    ORDER BY COALESCE(o.sent_at, o.created_at)`).all();
  const items = orders.length ? db.prepare(`SELECT oi.id, oi.order_id, oi.item_id, oi.name, oi.qty, oi.note, oi.mods, oi.course, oi.fired_at, oi.done_at, oi.done_station, oi.seat, oi.done_by, m.category, m.station, m.cook_minutes
    FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id IN (${orders.map((x) => x.id).join(',')})`).all() : [];
  const pacing = s.kds_pacing === '1';
  return orders.map((x) => {
    let tags = []; try { tags = JSON.parse(x.customer_tags || '[]'); } catch { /* none */ }
    const allergy = [x.allergy_note, ...tags.filter((t) => /allerg|free|vegan|celiac|dairy|lactose/i.test(t))].filter(Boolean).join(', ');
    let its = items.filter((i) => i.order_id === x.id).map((i) => ({ id: i.id, itemId: i.item_id, name: i.name, qty: i.qty, note: i.note, mods: pj(i.mods || '[]', []).map((m) => m.name), course: i.course, held: !live(i), done: Boolean(i.done_at), doneAt: i.done_at, area: stationFor(i, list, map), cook: i.cook_minutes ?? null, firedAt: i.fired_at, seat: i.seat || null, fireIn: !live(i) && H.fireIn ? H.fireIn(x.id, i.course) : null }));
    // pacing: the longest dish on the ticket starts now; shorter ones wait so everything finishes together
    if (pacing && ['open', 'sent'].includes(x.status)) {
      const open = its.filter((i) => !i.held && !i.done && i.cook);
      const maxCook = Math.max(0, ...open.map((i) => i.cook));
      its = its.map((i) => { if (i.held || i.done || !i.cook) return { ...i, startIn: null }; const base = Date.parse(`${String(i.firedAt || x.sent_at || x.created_at).replace(' ', 'T')}Z`); const at = base + (maxCook - i.cook) * 60000; return { ...i, startIn: Math.max(0, Math.ceil((at - Date.now()) / 60000)) }; });
    }
    const areas = {}; for (const i of its) if (!i.held) { const a = (areas[i.area] = areas[i.area] || { total: 0, done: 0 }); a.total += 1; if (i.done) a.done += 1; }
    const { customer_tags, ...rest } = x; // eslint-disable-line no-unused-vars
    const live2 = its.filter((i) => !i.held); const passSince = ['open', 'sent'].includes(x.status) && live2.length && live2.every((i) => i.done) ? live2.map((i) => i.doneAt).sort().pop() : null;
    return { ...rest, allergy, items: its, areas, passSince, photoNeeded: H.photoNeeded ? H.photoNeeded({ ...x, allergy }) && !H.hasPlatePhoto(x.id) : false, makegood: H.makegoodDue ? H.makegoodDue(x) : false, cooking: ['open', 'sent'].includes(x.status), arrived: Boolean(x.arrived_at && !x.handed_at) };
  });
}
/** How many of each item are still to make, for one area or all. */
export function allDay(orders, area) {
  const counts = new Map();
  for (const o of orders) if (o.cooking) for (const i of o.items) {
    if (i.held || i.done || (area && i.area !== area)) continue;
    const k = i.name; const c = counts.get(k) || { name: k, qty: 0, area: i.area, mods: {} };
    c.qty += i.qty; for (const m of i.mods) c.mods[m] = (c.mods[m] || 0) + i.qty; counts.set(k, c);
  }
  return [...counts.values()].sort((a, b) => b.qty - a.qty).map((c) => ({ ...c, mods: Object.entries(c.mods).map(([name, qty]) => ({ name, qty })) }));
}

export function registerKds({ app, staff, h }) {
  H = h;
  const { parse, clientIp, requireAuth, notifyStaff, wrap } = h;
  const mgr = requireAuth('manager');
  const secret = () => `${getJwtSecret()}:kds`;
  const areaNames = () => [...stationList(), EXPO, PACK, 'Runner', ALL];

  /** A screen token, or a signed-in staff member picking an area with ?area=. */
  const who = (req) => {
    const t = req.get('X-Kds');
    if (t) {
      try { const p = jwt.verify(t, secret()); if (p.loc === currentSlug() && String(p.v) === String(getSettings().kds_version || '1')) return { area: p.area, user: null, device: true }; } catch { /* bad */ }
      throw err('This kitchen screen is signed out. A manager needs to set it up again.', 401);
    }
    let user = null; try { user = req.cookies?.[SESSION_COOKIE] ? userFromToken(req.cookies[SESSION_COOKIE]) : null; } catch { user = null; }
    if (!user) throw err('Sign in or set this screen up from the Kitchen page.', 401);
    const area = String(req.query.area || req.body?.area || ALL);
    return { area: areaNames().includes(area) ? area : ALL, user, device: false };
  };
  const byLabel = (w) => (w.user ? w.user : null);
  const label = (w) => (w.user ? w.user.name : `${w.area} screen`);

  staff.post('/kds/start', mgr, (req, res) => {
    const { area } = parse(z.object({ area: z.string().min(1).max(24) }), req.body);
    if (!areaNames().includes(area)) throw err('Pick an area');
    const token = jwt.sign({ kind: 'kds', area, loc: currentSlug(), v: getSettings().kds_version || '1' }, secret(), { expiresIn: '365d' });
    audit(req.user, 'kds.device', `${area} screen started`, clientIp(req)); res.json({ token, loc: currentSlug(), area });
  });
  staff.post('/kds/signout-all', mgr, (req, res) => { setSettings({ kds_version: String(Number(getSettings().kds_version || '1') + 1) }); audit(req.user, 'kds.device', 'all signed out', clientIp(req)); res.json({ ok: true }); });
  staff.get('/kds/setup', mgr, (req, res) => {
    const s = getSettings(); const list = stationList();
    res.json({ stations: list, map: pj(s.station_map, {}), expo: s.kds_expo === '1', pack: s.kds_pack === '1', allergyCheck: s.kds_allergy_check === '1', pacing: s.kds_pacing === '1',
      categories: db.prepare('SELECT DISTINCT category FROM menu_items ORDER BY category').all().map((r) => r.category),
      items: db.prepare('SELECT id, name, category, station FROM menu_items WHERE active = 1 ORDER BY category, name').all().map((i) => ({ ...i, area: stationFor(i, list) })),
      speed: speed() });
  });
  staff.put('/kds/item-station', mgr, (req, res) => {
    const b = parse(z.object({ itemId: z.number().int(), station: z.string().max(20).nullable() }), req.body);
    if (b.station && !stationList().includes(b.station)) throw err('Unknown area');
    db.prepare('UPDATE menu_items SET station = ? WHERE id = ?').run(b.station || null, b.itemId); notifyStaff('menu'); res.json({ ok: true });
  });
  /** Average minutes from ticket in to area done, today, per area. */
  function speed() {
    return db.prepare(`SELECT oi.done_station area, COUNT(*) n, AVG((julianday(oi.done_at) - julianday(COALESCE(oi.fired_at, o.sent_at, o.created_at))) * 1440) m
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.done_at >= datetime('now','-1 day') AND oi.done_station IS NOT NULL GROUP BY oi.done_station`).all()
      .map((r) => ({ area: r.area, items: r.n, minutes: Math.round((r.m || 0) * 10) / 10 }));
  }

  app.get('/api/kds', (req, res) => {
    const w = who(req); const s = getSettings(); const all = board();
    const expo = s.kds_expo === '1'; const kind = w.area === EXPO ? 'expo' : w.area === PACK ? 'pack' : w.area === 'Runner' ? 'runner' : w.area === ALL ? 'all' : 'station';
    let orders;
    if (kind === 'station') orders = all.filter((o) => o.cooking && o.items.some((i) => i.area === w.area && !i.held && !i.done)).map((o) => ({ ...o, mine: o.items.filter((i) => i.area === w.area) }));
    else if (kind === 'pack') orders = all.filter((o) => o.fulfillment === 'pickup' || o.fulfillment === 'delivery' || o.source === 'online' || o.source === 'kiosk').filter((o) => !o.packed_at && (o.cooking || ['ready', 'paid'].includes(o.status)));
    else if (kind === 'runner') orders = h.runnerOrders ? h.runnerOrders(all) : [];
    else orders = all.filter((o) => o.cooking);
    const recent = (kind === 'station'
      ? all.filter((o) => o.items.some((i) => i.area === w.area && i.done && !i.held)).sort((a, b) => String(b.items.find((i) => i.area === w.area)?.doneAt).localeCompare(String(a.items.find((i) => i.area === w.area)?.doneAt)))
      : kind === 'runner' ? all.filter((o) => o.served_at).sort((a, b) => String(b.served_at).localeCompare(String(a.served_at)))
      : kind === 'pack' ? all.filter((o) => o.packed_at).sort((a, b) => String(b.packed_at).localeCompare(String(a.packed_at)))
      : all.filter((o) => !o.cooking).sort((a, b) => String(b.ready_at).localeCompare(String(a.ready_at)))).slice(0, 8).map((o) => ({ id: o.id, number: o.number, table: o.table_label, name: o.customer_name || o.guest_name, status: o.status, items: o.items.filter((i) => !i.held && (kind !== 'station' || i.area === w.area)).map((i) => ({ id: i.id, name: i.name, qty: i.qty, area: i.area })) }));
    const today = localToday();
    const lists = db.prepare('SELECT * FROM checklist_templates WHERE active = 1 AND area = ? ORDER BY sort, id').all(w.area).map((t) => { const run = db.prepare('SELECT * FROM checklist_runs WHERE template_id = ? AND day = ?').get(t.id, today); const done = pj(run?.done || '{}', {}); const items = pj(t.items, []); return { id: t.id, name: t.name, kind: t.kind, dueTime: t.due_time, items: items.map((it, i) => ({ text: it.text, needsValue: Boolean(it.needsValue), done: done[i] || null })), count: items.filter((_, i) => done[i]).length, total: items.length }; });
    const events = (h.eventsToday?.() || []).map((e) => ({ ...e, items: kind === 'station' ? e.items.filter((i) => stationFor(i) === w.area) : e.items })).filter((e) => e.items.length);
    res.json({ ...(h.kdsExtra?.(w.area) || {}), timeline: kind === 'expo' || kind === 'all' || kind === 'runner' ? (h.tableTimeline?.() || []) : [], enRoute: kind === 'pack' || kind === 'expo' || kind === 'all' ? (h.enRoute?.() || []) : [], rush: h.rushState?.() || null, quote: h.quoteMinutes?.() || null, business: { name: s.business_name, accent: s.accent }, area: w.area, kind, device: w.device, expo, pack: s.kds_pack === '1', unit: s.unit_label, allergyCheck: s.kds_allergy_check === '1', pacing: s.kds_pacing === '1', lists, events,
      arrivals: kind === 'pack' || kind === 'expo' || kind === 'all' ? all.filter((o) => o.arrived).map((o) => ({ id: o.id, number: o.number, name: o.customer_name || o.guest_name, note: o.arrival_note, ready: !o.cooking })) : [],
      stations: stationList(), areas: areaNames(), lateMinutes: Number(s.kds_late_minutes || 12), orders, recent,
      allDay: allDay(all, kind === 'station' ? w.area : null), held: db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'held'").get().c });
  });

  const order = (id) => { const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id); if (!o) throw err('Order not found', 404); return o; };
  const finished = (oid) => db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND done_at IS NULL AND (course <= 1 OR fired_at IS NOT NULL)').get(oid).c === 0
    && db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND fired_at IS NULL AND course > 1').get(oid).c === 0;

  // An area finishes some or all of its items on a ticket.
  app.post('/api/kds/bump', wrap(async (req, res) => {
    const w = who(req); const b = parse(z.object({ orderId: z.number().int(), itemIds: z.array(z.number().int()).max(100).optional(), undo: z.boolean().optional(), allergyConfirmed: z.boolean().optional(), cookId: z.number().int().optional() }), req.body);
    const cook = h.cookFor?.(b) || w.user?.id || null;
    const o = order(b.orderId); const list = stationList();
    const items = db.prepare('SELECT oi.*, m.category, m.station FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id = ?').all(o.id)
      .filter((i) => live(i) && ([ALL, EXPO].includes(w.area) || stationFor(i, list) === w.area) && (!b.itemIds || b.itemIds.includes(i.id)));
    if (!items.length) throw err('Nothing on this ticket for this area');
    const q = b.undo ? db.prepare('UPDATE order_items SET done_at = NULL, done_station = NULL, done_by = NULL WHERE id = ?') : db.prepare("UPDATE order_items SET done_at = COALESCE(done_at, datetime('now')), done_station = COALESCE(done_station, ?), done_by = COALESCE(done_by, ?) WHERE id = ?");
    for (const i of items) (b.undo ? q.run(i.id) : q.run(stationFor(i, list), cook, i.id));
    if (b.undo && ['ready', 'paid'].includes(o.status) && !o.paid_at) db.prepare("UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?").run(o.id);
    let ready = null; let needsAllergyCheck = false;
    if (!b.undo && finished(o.id) && ['open', 'sent'].includes(o.status) && getSettings().kds_expo !== '1') {
      if (allergyOf(o) && getSettings().kds_allergy_check === '1' && !b.allergyConfirmed) needsAllergyCheck = true;
      else { if (allergyOf(o)) checkAllergy(o, w, req); ready = await h.markReady(o, byLabel(w), clientIp(req), label(w)); }
    }
    audit(byLabel(w), b.undo ? 'kds.undo' : 'kds.bump', `#${o.number} ${w.area}`, clientIp(req));
    notifyStaff('orders'); res.json({ ok: true, needsAllergyCheck, allergy: needsAllergyCheck ? allergyOf(o) : undefined, allDone: finished(o.id), ready: Boolean(ready), buzz: ready?.buzz || null, waitingForExpo: !b.undo && finished(o.id) && getSettings().kds_expo === '1' });
  }));
  // Expo (or any full screen) completes the order: everything done, customer buzzed.
  app.post('/api/kds/complete', wrap(async (req, res) => {
    const w = who(req); const { orderId, allergyConfirmed } = parse(z.object({ orderId: z.number().int(), allergyConfirmed: z.boolean().optional() }), req.body);
    if (![EXPO, ALL].includes(w.area) && getSettings().kds_expo === '1') throw err('Only the expo screen completes orders');
    const o = order(orderId); if (!['open', 'sent'].includes(o.status)) throw err('This order is already done', 409);
    if (h.photoNeeded?.({ ...o, allergy: allergyOf(o) }) && !h.hasPlatePhoto(o.id)) throw Object.assign(err('Take a photo of the plate first'), { status: 409, needsPhoto: true });
    if (allergyOf(o) && getSettings().kds_allergy_check === '1') { if (!allergyConfirmed) throw Object.assign(err(`Check the allergy first: ${allergyOf(o)}`, 409), { needsAllergyCheck: true }); checkAllergy(o, w, req); }
    db.prepare("UPDATE order_items SET done_at = COALESCE(done_at, datetime('now')) WHERE order_id = ? AND (course <= 1 OR fired_at IS NOT NULL)").run(o.id);
    db.prepare("UPDATE orders SET expo_at = datetime('now') WHERE id = ?").run(o.id);
    const r = await h.markReady(o, byLabel(w), clientIp(req), label(w));
    notifyStaff('orders'); res.json({ ok: true, buzz: r?.buzz || null });
  }));
  app.post('/api/kds/recall', (req, res) => {
    const w = who(req); const { orderId } = parse(z.object({ orderId: z.number().int() }), req.body);
    const o = order(orderId);
    if (w.area !== EXPO && w.area !== ALL && w.area !== PACK) {
      const list = stationList(); const q = db.prepare('UPDATE order_items SET done_at = NULL, done_station = NULL WHERE id = ?');
      for (const i of db.prepare('SELECT oi.*, m.category, m.station FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id = ?').all(o.id)) if (stationFor(i, list) === w.area) q.run(i.id);
    }
    if (w.area === PACK) db.prepare('UPDATE orders SET packed_at = NULL WHERE id = ?').run(o.id);
    else if (['ready', 'paid'].includes(o.status) && (o.status === 'ready' || !o.paid_at || o.prepaid)) db.prepare("UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?").run(o.id);
    audit(byLabel(w), 'kds.recall', `#${o.number} ${w.area}`, clientIp(req)); notifyStaff('orders'); res.json({ ok: true });
  });
  // Packing: the bag is checked and sealed.
  app.post('/api/kds/packed', (req, res) => {
    const w = who(req); const { orderId, shelf } = parse(z.object({ orderId: z.number().int(), shelf: z.string().trim().max(8).optional() }), req.body);
    if (![PACK, ALL, EXPO].includes(w.area)) throw err('Use the packing screen');
    const o = order(orderId); db.prepare("UPDATE orders SET packed_at = datetime('now'), shelf = COALESCE(?, shelf) WHERE id = ?").run(shelf || null, o.id); if (shelf && o.guest_id) h.pushGuest?.(o.guest_id);
    audit(byLabel(w), 'kds.packed', `#${o.number}`, clientIp(req)); notifyStaff('orders'); res.json({ ok: true });
  });

  /** Allergy on an order: the note on the order plus the customer's allergy tags. */
  function allergyOf(o) {
    const c = db.prepare('SELECT c.tags FROM customers c LEFT JOIN guests g ON g.customer_id = c.id WHERE c.id = ? OR g.id = ? LIMIT 1').get(o.customer_id || 0, o.guest_id || 0);
    const tags = pj(c?.tags || '[]', []).filter((t) => /allerg|free|vegan|celiac|dairy|lactose/i.test(t));
    return [o.allergy_note, ...tags].filter(Boolean).join(', ');
  }
  function checkAllergy(o, w, req) { db.prepare('UPDATE orders SET allergy_checked_by = ? WHERE id = ?').run(label(w), o.id); audit(byLabel(w), 'allergy.check', `#${o.number}: ${allergyOf(o)} (${label(w)})`, clientIp(req)); }

  // area opening/closing lists, ticked on the area screen
  app.post('/api/kds/list-check', (req, res) => {
    const w = who(req); const b = parse(z.object({ templateId: z.number().int(), index: z.number().int().min(0).max(100), done: z.boolean(), value: z.string().trim().max(40).optional(), by: z.string().trim().max(30).optional() }), req.body);
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ? AND area = ?').get(b.templateId, w.area); if (!t) throw err('This list is not for this area', 404);
    const items = pj(t.items, []); if (b.index >= items.length) throw err('Bad item');
    const day = localToday(); db.prepare('INSERT OR IGNORE INTO checklist_runs (template_id, day) VALUES (?, ?)').run(t.id, day);
    const run = db.prepare('SELECT * FROM checklist_runs WHERE template_id = ? AND day = ?').get(t.id, day); const done = pj(run.done, {});
    const by = w.user ? w.user.name.split(' ')[0] : b.by || `${w.area} screen`;
    if (b.done) done[b.index] = { by, at: new Date().toISOString(), value: b.value || null }; else delete done[b.index];
    const complete = items.every((_, i) => done[i]);
    db.prepare('UPDATE checklist_runs SET done = ?, completed_at = ?, completed_by = ? WHERE id = ?').run(JSON.stringify(done), complete ? (run.completed_at || new Date().toISOString().replace('T', ' ').slice(0, 19)) : null, complete && w.user ? w.user.id : null, run.id);
    if (complete && !run.completed_at) audit(byLabel(w), 'checklist.done', `${t.name} ${day} (${label(w)})`, clientIp(req));
    notifyStaff('checklists'); res.json({ ok: true, complete });
  });
  // packing/expo: the curbside customer got their order
  app.post('/api/kds/handed', (req, res) => { const w = who(req); const { orderId } = parse(z.object({ orderId: z.number().int() }), req.body); const o = order(orderId); h.handOff?.(o, byLabel(w), clientIp(req)); res.json({ ok: true }); });

  /* ================= Menu board TV ================= */
  const bSecret = () => `${getJwtSecret()}:board`;
  staff.post('/menuboard/start', mgr, (req, res) => { const token = jwt.sign({ kind: 'board', loc: currentSlug(), v: getSettings().board_version || '1' }, bSecret(), { expiresIn: '365d' }); audit(req.user, 'board.device', 'started', clientIp(req)); res.json({ token, loc: currentSlug() }); });
  staff.post('/menuboard/signout-all', mgr, (req, res) => { setSettings({ board_version: String(Number(getSettings().board_version || '1') + 1) }); res.json({ ok: true }); });
  const boardData = () => {
    const s = getSettings(); const cats = pj(s.board_categories, []);
    const items = menuWithMods().filter((i) => !i.special_only || i.special).filter((i) => !cats.length || cats.includes(i.category));
    const order = cats.length ? cats : [...new Set(items.map((i) => i.category))];
    return { business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null }, currency: s.currency,
      title: s.board_title || '', rotateSeconds: Math.max(5, Number(s.board_rotate_seconds) || 12), columns: Math.min(4, Math.max(1, Number(s.board_cols) || 3)), showPhotos: s.board_photos === '1',
      sections: order.map((c) => ({ name: c, items: items.filter((i) => i.category === c).map((i) => ({ id: i.id, name: i.name, description: i.description || '', priceCents: i.price_cents, regularCents: i.regularCents ?? i.price_cents, deal: i.deal || null, special: Boolean(i.special), soldOut: i.soldOut, calories: i.calories ?? null, photo: i.photo || null, diet: i.diet })) })).filter((x) => x.items.length) };
  };
  app.get('/api/menuboard', (req, res) => {
    const t = req.get('X-Board'); let ok = false;
    try { const p = jwt.verify(String(t || ''), bSecret()); ok = p.loc === currentSlug() && String(p.v) === String(getSettings().board_version || '1'); } catch { ok = false; }
    if (!ok) { let u = null; try { u = req.cookies?.[SESSION_COOKIE] ? userFromToken(req.cookies[SESSION_COOKIE]) : null; } catch { u = null; } if (!u) throw err('This menu board is signed out. A manager needs to set it up again.', 401); }
    res.json(boardData());
  });
}
