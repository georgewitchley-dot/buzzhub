// Round 15: recipe cards / 86 / remakes / temperatures from the area screens, smart pickup times and rush mode,
// shift pulse, labor by area, tip-out at clock-out.
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, registerSchema, localToday, currentTz, currentSlug, getJwtSecret, forEachLocation } from './db.js';
import { userFromToken, SESSION_COOKIE } from './security.js';
import { dayBounds } from './ops.js';
import { stationFor, stationList } from './kds.js';
import { pushToUsers } from './notify.js';

registerSchema((db) => {
  db.exec(`
  CREATE TABLE IF NOT EXISTS remakes (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, order_item_id INTEGER, item_id INTEGER, name TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
    reason TEXT NOT NULL, area TEXT, cost_cents INTEGER NOT NULL DEFAULT 0, by_label TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS shift_pulse (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, shift_id INTEGER, rating INTEGER NOT NULL, note TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));`);
  const tu = db.prepare('PRAGMA table_info(temp_units)').all().map((c) => c.name);
  if (tu.length && !tu.includes('area')) db.exec('ALTER TABLE temp_units ADD COLUMN area TEXT');
  const u = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!u.includes('area')) db.exec('ALTER TABLE users ADD COLUMN area TEXT');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const ms = (sql) => Date.parse(`${String(sql).replace(' ', 'T')}Z`);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const REMAKE_REASONS = ['Wrong order', 'Cooked wrong', 'Dropped', 'Sent back', 'Allergy', 'Took too long', 'Other'];
export const FOH = 'Front of house';

/** Recent kitchen pace: average ticket minutes over the last 3 hours and tickets cooking now. */
export function kitchenPace() {
  const rows = db.prepare("SELECT sent_at, ready_at FROM orders WHERE ready_at >= datetime('now','-3 hours') AND sent_at IS NOT NULL AND ready_at > sent_at AND status <> 'void'").all();
  const mins = rows.map((r) => (ms(r.ready_at) - ms(r.sent_at)) / 60000).filter((m) => m <= 120);
  const avg = mins.length >= 3 ? mins.reduce((a, b) => a + b, 0) / mins.length : null;
  const cooking = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('open','sent')").get().c;
  const late = Number(getSettings().kds_late_minutes || 12);
  const lateNow = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('open','sent') AND sent_at < datetime('now', ?)").get(`-${late} minutes`).c;
  return { avgTicket: avg, cooking, lateNow, samples: mins.length };
}
/** Rush state: normal, busy (longer quotes) or paused (no online orders), automatic or by hand. */
export function rushState() {
  const s = getSettings(); const p = kitchenPace(); const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (s.online_paused_until && s.online_paused_until > now) return { level: 'paused', manual: true, until: s.online_paused_until, reason: 'Paused by staff', ...p };
  if (s.rush_mode !== 'auto') return { level: 'normal', ...p };
  if (p.cooking >= Number(s.rush_pause_tickets || 25) || p.lateNow >= Number(s.rush_pause_late || 8)) return { level: 'paused', reason: `${p.cooking} tickets cooking, ${p.lateNow} late`, ...p };
  if (p.cooking >= Number(s.rush_busy_tickets || 12) || p.lateNow >= Number(s.rush_busy_late || 3)) return { level: 'busy', reason: `${p.cooking} tickets cooking, ${p.lateNow} late`, ...p };
  return { level: 'normal', ...p };
}
/** Minutes to promise an online customer. */
export function quoteMinutes() {
  const s = getSettings(); const prep = Number(s.online_prep_minutes) || 15; const p = kitchenPace(); const rush = rushState();
  let m;
  if (s.smart_quotes === '1' && p.avgTicket !== null) {
    const parallel = Math.max(1, Number(s.kitchen_parallel) || 4);
    m = Math.max(prep * 0.6, p.avgTicket + Math.max(0, p.cooking - parallel) / parallel * p.avgTicket * 0.6);
  } else m = prep + Math.min(30, p.cooking * 2);
  if (rush.level === 'busy') m += Number(s.rush_extra_minutes || 15);
  return { minutes: Math.min(180, Math.max(5, Math.round(m / 5) * 5)), rush: rush.level, smart: s.smart_quotes === '1' && p.avgTicket !== null };
}

/** One shift's tip-out from the rules, for the person clocking out. */
export function shiftTipout(userId, shift) {
  const rules = pj(getSettings().tipout_rules, []).filter((r) => r.from && r.to && Number(r.pct) > 0);
  const u = db.prepare('SELECT tip_role FROM users WHERE id = ?').get(userId); if (!u?.tip_role || !shift) return null;
  const mine = rules.filter((r) => r.from === u.tip_role); if (!mine.length) return null;
  const end = shift.clock_out || new Date().toISOString().replace('T', ' ').slice(0, 19);
  const t = db.prepare("SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) s, COALESCE(SUM(tip_cents),0) t FROM orders WHERE created_by = ? AND paid_at >= ? AND paid_at <= ? AND status <> 'void'").get(userId, shift.clock_in, end);
  const tips = t.t + (shift.declared_tips_cents || 0);
  const lines = mine.map((r) => ({ to: r.to, pct: Number(r.pct), base: r.base, cents: Math.round(((r.base === 'tips' ? tips : t.s) * Number(r.pct)) / 100) })).filter((l) => l.cents > 0);
  return { salesCents: t.s, tipsCents: tips, lines, totalCents: lines.reduce((a, l) => a + l.cents, 0) };
}

export function registerLine({ app, staff, h }) {
  const { parse, clientIp, requireAuth, notifyStaff } = h;
  const mgr = requireAuth('manager');
  const secret = () => `${getJwtSecret()}:kds`;
  const who = (req) => {
    const t = req.get('X-Kds');
    if (t) { try { const p = jwt.verify(t, secret()); if (p.loc === currentSlug() && String(p.v) === String(getSettings().kds_version || '1')) return { area: p.area, user: null }; } catch { /* bad */ } throw err('This kitchen screen is signed out.', 401); }
    let user = null; try { user = req.cookies?.[SESSION_COOKIE] ? userFromToken(req.cookies[SESSION_COOKIE]) : null; } catch { user = null; }
    if (!user) throw err('Sign in first', 401);
    return { area: String(req.query.area || req.body?.area || 'All areas'), user };
  };
  const label = (w) => (w.user ? w.user.name : `${w.area} screen`);

  /* ===== recipe cards on area screens ===== */
  app.get('/api/kds/card/:id', (req, res) => {
    who(req); const m = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(Number(req.params.id)); if (!m) throw err('Not found', 404);
    const recipe = db.prepare('SELECT g.name, r.qty, g.unit FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ? ORDER BY g.name').all(m.id);
    const hasPhoto = Boolean(db.prepare('SELECT 1 FROM assets WHERE key = ?').get(`item:${m.id}`));
    res.json({ id: m.id, name: m.name, category: m.category, description: m.description, cookMinutes: m.cook_minutes ?? null, allergens: pj(m.allergens, []), steps: pj(m.build_steps, []), recipe, photo: hasPhoto ? `/api/kds/card/${m.id}/photo` : null });
  });
  app.get('/api/kds/card/:id/photo', (req, res) => {
    // the <img> can't send headers, so the screen passes its token in the query
    if (req.query.t) req.headers['x-kds'] = String(req.query.t); who(req);
    const a = db.prepare('SELECT mime, data FROM assets WHERE key = ?').get(`item:${Number(req.params.id)}`); if (!a) return res.status(404).end();
    res.set('Content-Type', a.mime).set('Cache-Control', 'private, max-age=3600').send(a.data);
  });

  /* ===== 86 from the line ===== */
  app.get('/api/kds/menu', (req, res) => {
    const w = who(req); const list = stationList();
    res.json(db.prepare('SELECT id, name, category, station, stock, active FROM menu_items WHERE active = 1 ORDER BY category, name').all()
      .filter((i) => ['All areas', 'Expo', 'Packing'].includes(w.area) || stationFor(i, list) === w.area).map((i) => ({ id: i.id, name: i.name, category: i.category, out: i.stock !== null && i.stock <= 0, stock: i.stock })));
  });
  app.post('/api/kds/86', (req, res) => {
    const w = who(req); const b = parse(z.object({ itemId: z.number().int(), out: z.boolean() }), req.body);
    const m = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(b.itemId); if (!m) throw err('Not found', 404);
    if (b.out) db.prepare('UPDATE menu_items SET stock = 0 WHERE id = ?').run(m.id); else db.prepare('UPDATE menu_items SET stock = NULL WHERE id = ? AND (stock IS NULL OR stock <= 0)').run(m.id);
    db.prepare('INSERT INTO stock_moves (item_id, delta, reason, user_id) VALUES (?, 0, ?, ?)').run(m.id, b.out ? `86 from ${w.area}` : `back on from ${w.area}`, w.user?.id || null);
    audit(w.user, b.out ? 'item.86' : 'item.back', `${m.name} (${label(w)})`, clientIp(req)); notifyStaff('menu');
    if (b.out) pushToUsers(['staff', 'manager', 'owner'], { title: `86 ${m.name}`, body: `${label(w)} marked ${m.name} sold out.`, tag: `86-${m.id}`, url: '/menu' }).catch(() => {});
    res.json({ ok: true });
  });

  /* ===== remakes ===== */
  app.post('/api/kds/remake', (req, res) => {
    const w = who(req); const b = parse(z.object({ orderItemId: z.number().int(), qty: z.number().int().min(1).max(50).optional(), reason: z.enum(REMAKE_REASONS) }), req.body);
    const oi = db.prepare('SELECT oi.*, m.category, m.station FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.id = ?').get(b.orderItemId); if (!oi) throw err('Item not found', 404);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(oi.order_id); if (!o || o.status === 'void') throw err('Order not found', 404);
    const qty = Math.min(b.qty || oi.qty, 50); const area = stationFor(oi);
    const cost = Math.round((db.prepare('SELECT SUM(r.qty * g.cost_cents) c FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ?').get(oi.item_id || 0).c || oi.price_cents * (Number(getSettings().food_cost_target) || 30) / 100) * qty);
    db.transaction(() => {
      db.prepare("INSERT INTO order_items (order_id, item_id, name, qty, price_cents, note, mods, course, fired_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))").run(o.id, oi.item_id, oi.name, qty, `REMAKE: ${b.reason}`, oi.mods, 1);
      db.prepare('INSERT INTO remakes (order_id, order_item_id, item_id, name, qty, reason, area, cost_cents, by_label) VALUES (?,?,?,?,?,?,?,?,?)').run(o.id, oi.id, oi.item_id, oi.name, qty, b.reason, area, cost, label(w));
      if (['ready', 'paid'].includes(o.status) && !o.paid_at) db.prepare("UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?").run(o.id);
      else if (o.status === 'ready') db.prepare("UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?").run(o.id);
    })();
    audit(w.user, 'kds.remake', `#${o.number} ${qty} ${oi.name}: ${b.reason} (${label(w)})`, clientIp(req)); notifyStaff('orders');
    res.json({ ok: true, area });
  });
  app.get('/api/kds/remake-reasons', (req, res) => { who(req); res.json(REMAKE_REASONS); });
  staff.get('/remakes', mgr, (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7)); const since = dayBounds(addDays(localToday(), -(days - 1))).start;
    const rows = db.prepare('SELECT r.*, o.number FROM remakes r JOIN orders o ON o.id = r.order_id WHERE r.at >= ? ORDER BY r.at DESC').all(since);
    const by = (k) => { const m = new Map(); for (const r of rows) { const key = r[k] || 'Unknown'; const a = m.get(key) || { key, count: 0, qty: 0, costCents: 0 }; a.count++; a.qty += r.qty; a.costCents += r.cost_cents; m.set(key, a); } return [...m.values()].sort((a, b) => b.count - a.count); };
    res.json({ days, total: rows.length, costCents: rows.reduce((a, r) => a + r.cost_cents, 0), byReason: by('reason'), byDish: by('name').slice(0, 10), byArea: by('area'), recent: rows.slice(0, 20) });
  });

  /* ===== temperatures on area screens ===== */
  app.get('/api/kds/temps', (req, res) => {
    const w = who(req);
    res.json(db.prepare('SELECT * FROM temp_units WHERE active = 1 AND area = ? ORDER BY name').all(w.area).map((u) => ({ id: u.id, name: u.name, min: u.min_temp, max: u.max_temp, scale: u.scale,
      last: db.prepare('SELECT value, ok, at FROM temp_logs WHERE unit_id = ? ORDER BY id DESC LIMIT 1').get(u.id) || null })));
  });
  app.post('/api/kds/temps/:unitId', (req, res) => {
    const w = who(req); const b = parse(z.object({ value: z.number().min(-60).max(250), corrective: z.string().trim().max(200).optional(), by: z.string().trim().max(30).optional() }), req.body);
    const u = db.prepare('SELECT * FROM temp_units WHERE id = ? AND active = 1 AND area = ?').get(Number(req.params.unitId), w.area); if (!u) throw err('Not found', 404);
    const ok = b.value >= u.min_temp && b.value <= u.max_temp;
    if (!ok && !b.corrective) throw Object.assign(err(`${b.value}°${u.scale} is outside ${u.min_temp}–${u.max_temp}°${u.scale}. Say what you did about it.`), { status: 409, needsCorrective: true });
    const note = w.user ? null : `${b.by ? `${b.by}, ` : ''}${w.area} screen`;
    db.prepare('INSERT INTO temp_logs (unit_id, value, ok, note, corrective, user_id) VALUES (?,?,?,?,?,?)').run(u.id, b.value, ok ? 1 : 0, note, b.corrective || null, w.user?.id || null);
    if (!ok) pushToUsers(['manager', 'owner'], { title: `${getSettings().business_name}: ${u.name} out of range`, body: `${label(w)} logged ${b.value}°${u.scale} (should be ${u.min_temp}–${u.max_temp}). Action: ${b.corrective}`, tag: 'house', url: '/checklists' }).catch(() => {});
    audit(w.user, 'temp.log', `${u.name} ${b.value}°${u.scale}${ok ? '' : ' OUT OF RANGE'} (${label(w)})`, clientIp(req)); notifyStaff('checklists'); res.json({ ok: true, inRange: ok });
  });
  staff.put('/temp-units/:id/area', mgr, (req, res) => { const { area } = parse(z.object({ area: z.string().max(24).nullable() }), req.body); db.prepare('UPDATE temp_units SET area = ? WHERE id = ?').run(area || null, Number(req.params.id)); notifyStaff('checklists'); res.json({ ok: true }); });

  /* ===== smart pickup times + rush mode ===== */
  h.quoteMinutes = quoteMinutes; h.rushState = rushState;
  const pauseSchema = z.object({ minutes: z.number().int().min(0).max(240) });
  const pause = (minutes, who2, ip) => {
    const until = minutes ? new Date(Date.now() + minutes * 60000).toISOString().replace('T', ' ').slice(0, 19) : '';
    setSettings({ online_paused_until: until }); audit(who2, minutes ? 'online.pause' : 'online.resume', minutes ? `${minutes} min` : '', ip); notifyStaff('rush');
  };
  staff.get('/rush', (req, res) => res.json({ ...rushState(), quote: quoteMinutes() }));
  staff.post('/rush/pause', (req, res) => { const { minutes } = parse(pauseSchema, req.body); pause(minutes, req.user, clientIp(req)); res.json({ ok: true, ...rushState() }); });
  app.post('/api/kds/pause', (req, res) => { const w = who(req); const { minutes } = parse(pauseSchema, req.body); pause(minutes, w.user, clientIp(req)); res.json({ ok: true, ...rushState() }); });
  let lastLevel = {};
  setInterval(() => forEachLocation(() => { try { const slug = currentSlug(); const r = rushState(); if (lastLevel[slug] && lastLevel[slug] !== r.level && !r.manual) pushToUsers(['manager', 'owner'], { title: r.level === 'normal' ? 'Online orders back to normal' : r.level === 'busy' ? 'Kitchen is busy: pickup times pushed back' : 'Online orders paused: kitchen is behind', body: r.reason || '', tag: 'rush', url: '/kitchen' }).catch(() => {}); lastLevel[slug] = r.level; } catch { /* fine */ } }), 60_000).unref();

  /* ===== shift pulse ===== */
  h.addPulse = (user, rating, note) => {
    if (getSettings().shift_pulse !== '1') return;
    const sh = db.prepare('SELECT id FROM shifts WHERE user_id = ? AND clock_out IS NOT NULL ORDER BY clock_out DESC LIMIT 1').get(user.id);
    db.prepare('INSERT INTO shift_pulse (user_id, shift_id, rating, note) VALUES (?,?,?,?)').run(user.id, sh?.id || null, rating, (note || '').trim().slice(0, 300) || null);
    if (rating <= 1) pushToUsers(['manager', 'owner'], { title: 'A rough shift', body: `Someone rated their shift ${rating}/4${note ? `: ${note}` : ''}.`, tag: 'pulse', url: '/shifts' }).catch(() => {});
    notifyStaff('pulse');
  };
  staff.post('/me/pulse', (req, res) => { const b = parse(z.object({ rating: z.number().int().min(1).max(4), note: z.string().max(300).optional() }), req.body); h.addPulse(req.user, b.rating, b.note); res.json({ ok: true }); });
  staff.get('/pulse', mgr, (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14)); const since = dayBounds(addDays(localToday(), -(days - 1))).start; const anon = getSettings().pulse_anonymous !== '0';
    const rows = db.prepare('SELECT p.*, u.name FROM shift_pulse p JOIN users u ON u.id = p.user_id WHERE p.at >= ? ORDER BY p.at DESC').all(since);
    const tz = currentTz(); const dayOf = (sql) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms(sql)));
    const daysMap = new Map(); for (const r of rows) { const d = dayOf(r.at); const a = daysMap.get(d) || { day: d, n: 0, sum: 0 }; a.n++; a.sum += r.rating; daysMap.set(d, a); }
    res.json({ days, anonymous: anon, count: rows.length, average: rows.length ? Math.round((rows.reduce((a, r) => a + r.rating, 0) / rows.length) * 10) / 10 : null,
      byDay: [...daysMap.values()].map((d) => ({ day: d.day, n: d.n, avg: Math.round((d.sum / d.n) * 10) / 10 })).sort((a, b) => a.day.localeCompare(b.day)),
      counts: [1, 2, 3, 4].map((k) => rows.filter((r) => r.rating === k).length),
      notes: rows.filter((r) => r.note).slice(0, 15).map((r) => ({ rating: r.rating, note: r.note, at: r.at, name: anon ? null : r.name })) });
  });

  /* ===== labor by area ===== */
  staff.put('/users/:id/area', mgr, (req, res) => { const { area } = parse(z.object({ area: z.string().max(24).nullable() }), req.body); db.prepare('UPDATE users SET area = ? WHERE id = ?').run(area || null, Number(req.params.id)); res.json({ ok: true }); });
  staff.get('/labor-by-area', requireAuth('owner'), (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7)); const from = addDays(localToday(), -(days - 1));
    const a = dayBounds(from).start; const z2 = dayBounds(localToday()).end; const list = stationList();
    const areas = new Map([...list, FOH].map((x) => [x, { area: x, hours: 0, laborCents: 0, salesCents: 0, people: new Set() }]));
    for (const s of db.prepare('SELECT s.*, u.area, u.hourly_cents, u.name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in < ? AND COALESCE(s.clock_out, ?) > ?').all(z2, z2, a)) {
      const st = s.clock_in < a ? a : s.clock_in; const en = !s.clock_out || s.clock_out > z2 ? new Date().toISOString().replace('T', ' ').slice(0, 19) : s.clock_out;
      const hrs = Math.max(0, (ms(en) - ms(st)) / 3600000 - (s.break_minutes || 0) / 60);
      const key = s.area && areas.has(s.area) ? s.area : FOH; const x = areas.get(key); x.hours += hrs; x.laborCents += Math.round(hrs * s.hourly_cents); x.people.add(s.name);
    }
    let total = 0;
    for (const i of db.prepare("SELECT oi.qty, oi.price_cents, m.category, m.station FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN menu_items m ON m.id = oi.item_id WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status <> 'void'").all(a, z2)) {
      const c = i.qty * i.price_cents; total += c; const x = areas.get(stationFor(i, list)); if (x) x.salesCents += c;
    }
    areas.get(FOH).salesCents = total;
    const rows = [...areas.values()].map((x) => ({ area: x.area, hours: Math.round(x.hours * 10) / 10, laborCents: x.laborCents, salesCents: x.salesCents, pct: x.salesCents ? Math.round((x.laborCents / x.salesCents) * 1000) / 10 : null, people: [...x.people] }));
    res.json({ days, areas: rows, totalSalesCents: total, totalLaborCents: rows.reduce((s, r) => s + r.laborCents, 0), team: db.prepare('SELECT id, name, area, tip_role FROM users WHERE active = 1 ORDER BY name').all(), choices: [...list, FOH] });
  });

  /* ===== tip-out at clock-out ===== */
  h.shiftTipout = (userId) => { if (getSettings().tipout_at_clockout === '0') return null; const sh = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND clock_out IS NOT NULL ORDER BY clock_out DESC LIMIT 1').get(userId); return shiftTipout(userId, sh); };
}
