// Round 5, batch F: customer profiles, automatic offers, owner insights (daily summary + unusual activity alerts).
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, registerSchema, localToday, currentTz, currentSlug, forEachLocation, getJwtSecret } from './db.js';
import { pushToCustomer, pushToUsers, emailEnabled, emailGuest } from './notify.js';
import { dayBounds } from './ops.js';

registerSchema((db) => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const c = cols('customers');
  if (!c.includes('birthday')) db.exec('ALTER TABLE customers ADD COLUMN birthday TEXT');
  if (!c.includes('notes')) db.exec('ALTER TABLE customers ADD COLUMN notes TEXT');
  if (!c.includes('tags')) db.exec("ALTER TABLE customers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  db.exec(`
CREATE TABLE IF NOT EXISTS auto_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, flow TEXT NOT NULL, code TEXT, sent_at TEXT NOT NULL DEFAULT (datetime('now')), reached INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_auto_sends ON auto_sends(customer_id, flow);
CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL UNIQUE, data TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS insight_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fmt = (c) => `$${(c / 100).toFixed(2)}`;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const localHourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: currentTz(), hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const tagsOf = (s) => { try { const t = JSON.parse(s || '[]'); return Array.isArray(t) ? t : []; } catch { return []; } };

/* ---------- customer profile ---------- */
function ordersOfCustomer(c) {
  return db.prepare(`SELECT DISTINCT o.* FROM orders o LEFT JOIN guests g ON g.id = o.guest_id
    WHERE o.status <> 'void' AND (g.customer_id = ? OR (o.contact_email IS NOT NULL AND o.contact_email = ? COLLATE NOCASE)) ORDER BY o.id DESC LIMIT 200`).all(c.id, c.email);
}
export function customerProfile(id) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!c) return null;
  const orders = ordersOfCustomer(c);
  const ids = orders.map((o) => o.id);
  const fav = ids.length ? db.prepare(`SELECT name, SUM(qty) n FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) GROUP BY name ORDER BY n DESC LIMIT 5`).all(...ids) : [];
  const visits = db.prepare("SELECT g.id, g.created_at, g.seated_at, g.party_size, t.label table_label, g.status FROM guests g LEFT JOIN tables t ON t.id = g.table_id WHERE g.customer_id = ? ORDER BY g.id DESC LIMIT 30").all(id);
  const bookings = db.prepare('SELECT id, start_local, service_name, status, party_size, deposit_cents, deposit_status FROM bookings WHERE customer_id = ? ORDER BY start_local DESC LIMIT 20').all(id);
  const fb = db.prepare('SELECT rating, comment, responded_at FROM feedback WHERE customer_id = ? AND rating IS NOT NULL ORDER BY id DESC LIMIT 10').all(id);
  const spent = orders.filter((o) => o.paid_at).reduce((a, o) => a + o.total_cents, 0);
  const lastVisit = db.prepare("SELECT MAX(COALESCE(seated_at, created_at)) d FROM guests WHERE customer_id = ? AND status IN ('seated','done')").get(id).d;
  const rewards = db.prepare("SELECT title, code, status FROM rewards WHERE customer_id = ? ORDER BY id DESC LIMIT 5").all(id);
  const offers = db.prepare('SELECT flow, code, sent_at FROM auto_sends WHERE customer_id = ? ORDER BY id DESC LIMIT 10').all(id);
  return {
    id: c.id, name: c.name, email: c.email, phone: c.phone, created_at: c.created_at, birthday: c.birthday, notes: c.notes || '', tags: tagsOf(c.tags),
    marketing: Boolean(c.marketing_opt_in), visitsCount: c.visits || 0, lastVisit, spentCents: spent, orderCount: orders.length,
    avgCents: orders.filter((o) => o.paid_at).length ? Math.round(spent / orders.filter((o) => o.paid_at).length) : 0,
    usual: fav.map((f) => ({ name: f.name, times: f.n })),
    recentOrders: orders.slice(0, 8).map((o) => ({ id: o.id, number: o.number, at: o.created_at, totalCents: o.total_cents, source: o.source, status: o.status })),
    visits, bookings, feedback: fb, rewards, offers,
    avgRating: fb.length ? Math.round((fb.reduce((a, f) => a + f.rating, 0) / fb.length) * 10) / 10 : null,
  };
}

/* ---------- automatic offers ---------- */
const FLOWS = {
  birthday: { label: 'Birthday', prefix: 'BDAY' },
  winback: { label: 'We miss you', prefix: 'BACK' },
  welcome: { label: 'First-visit thank you', prefix: 'HELLO' },
};
const unsubSig = (id, slug) => crypto.createHmac('sha256', getJwtSecret()).update(`unsub:${slug}:${id}`).digest('base64url').slice(0, 22);
function makeCode(prefix, pct, days) {
  for (let i = 0; i < 5; i += 1) {
    const code = `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    try {
      db.prepare("INSERT INTO promos (code, kind, value, min_cents, starts_on, ends_on, max_uses, note) VALUES (?, 'pct', ?, 0, ?, ?, 1, ?)").run(code, pct, localToday(), addDays(localToday(), days), `Automatic ${prefix.toLowerCase()} offer`);
      return code;
    } catch { /* clash, try again */ }
  }
  throw new Error('could not make code');
}
function candidates(flow, s) {
  const today = localToday();
  if (flow === 'birthday') {
    return db.prepare(`SELECT c.* FROM customers c WHERE c.marketing_opt_in = 1 AND c.birthday = ?
      AND NOT EXISTS (SELECT 1 FROM auto_sends a WHERE a.customer_id = c.id AND a.flow = 'birthday' AND a.sent_at > datetime('now','-300 days'))`).all(today.slice(5));
  }
  if (flow === 'winback') {
    const days = Math.max(14, Number(s.auto_winback_days) || 45);
    return db.prepare(`SELECT c.* FROM customers c WHERE c.marketing_opt_in = 1 AND c.visits >= 1
      AND (SELECT MAX(COALESCE(g.seated_at, g.created_at)) FROM guests g WHERE g.customer_id = c.id AND g.status IN ('seated','done')) < datetime('now', ?)
      AND NOT EXISTS (SELECT 1 FROM auto_sends a WHERE a.customer_id = c.id AND a.flow = 'winback' AND a.sent_at > datetime('now', ?))`).all(`-${days} days`, `-${days} days`);
  }
  if (flow === 'welcome') {
    return db.prepare(`SELECT c.* FROM customers c WHERE c.marketing_opt_in = 1 AND c.visits = 1
      AND (SELECT MAX(COALESCE(g.seated_at, g.created_at)) FROM guests g WHERE g.customer_id = c.id AND g.status IN ('seated','done')) > datetime('now','-3 days')
      AND NOT EXISTS (SELECT 1 FROM auto_sends a WHERE a.customer_id = c.id AND a.flow = 'welcome')`).all();
  }
  return [];
}
async function sendFlow(flow, c, s, base) {
  const pct = Math.max(1, Math.min(100, Number(s[`auto_${flow}_pct`]) || 10));
  const code = makeCode(FLOWS[flow].prefix, pct, 14);
  const first = c.name.split(' ')[0];
  const msg = {
    birthday: `Happy birthday, ${first}! Here's ${pct}% off to celebrate. Code ${code}, good for 14 days.`,
    winback: `We miss you, ${first}. Come back for ${pct}% off. Code ${code}, good for 14 days.`,
    welcome: `Thanks for your first visit, ${first}! Here's ${pct}% off next time. Code ${code}, good for 14 days.`,
  }[flow];
  const slug = currentSlug();
  const url = `/order?${slug === 'main' ? '' : `l=${slug}&`}promo=${code}`;
  let reached = 0;
  const r = await pushToCustomer(c.id, { title: `${s.business_name}: ${FLOWS[flow].label.toLowerCase()} treat`, body: msg, tag: `auto-${flow}`, url }).catch(() => null);
  if (r?.sent) reached = 1;
  if (emailEnabled() && base) {
    const e = await emailGuest(c.email, { businessName: s.business_name, subject: FLOWS[flow].label, message: msg, link: `${base}${url}`, accent: s.accent, button: 'Use my offer', unsubscribe: `${base}/api/unsub/${slug}/${c.id}/${unsubSig(c.id, slug)}?l=${slug}` }).catch(() => ({ ok: false }));
    if (e.ok) reached = 1;
  }
  db.prepare('INSERT INTO auto_sends (customer_id, flow, code, reached) VALUES (?, ?, ?, ?)').run(c.id, flow, code, reached);
  return reached;
}
export async function runFlows(base = process.env.PUBLIC_URL?.replace(/\/$/, '') || '') {
  const s = getSettings(); const out = {};
  for (const flow of Object.keys(FLOWS)) {
    if (s[`auto_${flow}`] !== '1') continue;
    const list = candidates(flow, s).slice(0, 200);
    let n = 0;
    for (const c of list) n += await sendFlow(flow, c, s, base);
    out[flow] = { candidates: list.length, reached: n };
    if (list.length) audit(null, 'auto.offer', `${FLOWS[flow].label}: ${list.length} sent, ${n} reached`, null);
  }
  return out;
}

/* ---------- insights ---------- */
function salesBetween(a, b) {
  return db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents - tip_cents),0) c, COALESCE(SUM(tip_cents),0) tips FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void'").get(a, b);
}
export function daySummary(day = localToday()) {
  const { start, end } = dayBounds(day);
  const lw = dayBounds(addDays(day, -7));
  const t = salesBetween(start, end); const p = salesBetween(lw.start, lw.end);
  const top = db.prepare("SELECT oi.name, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status <> 'void' GROUP BY oi.name ORDER BY n DESC LIMIT 3").all(start, end);
  const shifts = db.prepare('SELECT s.clock_in, s.clock_out, s.break_minutes, u.hourly_cents FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in < ? AND COALESCE(s.clock_out, datetime(\'now\')) > ?').all(end, start);
  const ms = (x) => Date.parse(`${x.replace(' ', 'T')}Z`);
  let laborCents = 0; let hours = 0;
  for (const s of shifts) {
    const a = Math.max(ms(s.clock_in), ms(start)); const b = Math.min(ms(s.clock_out || new Date().toISOString().slice(0, 19)), ms(end));
    const hr = Math.max(0, (b - a) / 3600000 - s.break_minutes / 60); hours += hr; laborCents += Math.round(hr * s.hourly_cents);
  }
  const voids = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) c FROM orders WHERE status = 'void' AND created_at >= ? AND created_at < ?").get(start, end);
  const refunds = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM refunds WHERE at >= ? AND at < ?').get(start, end);
  const fb = db.prepare('SELECT COUNT(*) n, AVG(rating) avg FROM feedback WHERE responded_at >= ? AND responded_at < ? AND rating IS NOT NULL').get(start, end);
  const guests = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(party_size),0) p FROM guests WHERE created_at >= ? AND created_at < ? AND kind <> 'order'").get(start, end);
  const kitchen = db.prepare("SELECT AVG((julianday(ready_at) - julianday(sent_at)) * 1440) m FROM orders WHERE sent_at >= ? AND sent_at < ? AND ready_at IS NOT NULL").get(start, end);
  return {
    day, salesCents: t.c, orders: t.n, tipsCents: t.tips, avgCents: t.n ? Math.round(t.c / t.n) : 0,
    lastWeekCents: p.c, changePct: p.c ? Math.round(((t.c - p.c) / p.c) * 100) : null,
    laborCents, laborHours: Math.round(hours * 10) / 10, laborPct: t.c ? Math.round((laborCents / t.c) * 1000) / 10 : null,
    top: top.map((x) => ({ name: x.name, qty: x.n })), voids: voids.n, voidCents: voids.c, refunds: refunds.n, refundCents: refunds.c,
    rating: fb.avg ? Math.round(fb.avg * 10) / 10 : null, ratings: fb.n, guests: guests.n, covers: guests.p,
    kitchenMinutes: kitchen.m ? Math.round(kitchen.m * 10) / 10 : null,
  };
}
const summaryText = (d, s) => {
  const parts = [`${fmt(d.salesCents)} from ${d.orders} orders`];
  if (d.changePct !== null) parts.push(`${d.changePct >= 0 ? 'up' : 'down'} ${Math.abs(d.changePct)}% on last week`);
  if (d.laborPct !== null && d.laborCents) parts.push(`labor ${d.laborPct}%`);
  if (d.top[0]) parts.push(`top seller ${d.top[0].name}`);
  if (d.rating) parts.push(`rated ${d.rating}★`);
  if (d.voids) parts.push(`${d.voids} void${d.voids === 1 ? '' : 's'}`);
  return `${s.business_name} today: ${parts.join(', ')}.`;
};
async function raise(kind, key, title, body) {
  const r = db.prepare('INSERT OR IGNORE INTO insight_alerts (kind, key, title, body) VALUES (?, ?, ?, ?)').run(kind, key, title, body);
  if (!r.changes) return;
  await pushToUsers(['owner', 'manager'], { title, body, tag: `insight-${kind}`, url: '/insights' }).catch(() => {});
}
async function checkAnomalies() {
  const s = getSettings(); if (s.insights_alerts !== '1') return;
  const today = localToday(); const { start, end } = dayBounds(today);
  const vLimit = Math.max(1, Number(s.insights_void_limit) || 3);
  for (const v of db.prepare("SELECT u.id, u.name, COUNT(*) n, SUM(o.total_cents) c FROM orders o JOIN users u ON u.id = o.created_by WHERE o.status = 'void' AND o.created_at >= ? AND o.created_at < ? GROUP BY u.id HAVING n >= ?").all(start, end, vLimit)) {
    await raise('voids', `voids:${today}:${v.id}`, `${s.business_name}: lots of voids`, `${v.name} has voided ${v.n} orders today (${fmt(v.c)}).`);
  }
  const rLimit = Math.max(100, Number(s.insights_refund_cents) || 10000);
  const rf = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM refunds WHERE at >= ? AND at < ?').get(start, end);
  if (rf.c >= rLimit) await raise('refunds', `refunds:${today}`, `${s.business_name}: refunds are high`, `${rf.n} refunds today totalling ${fmt(rf.c)}.`);
  const late = Math.max(1, Number(s.kds_late_minutes) || 12);
  const slow = db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('sent','open') AND sent_at IS NOT NULL AND sent_at < datetime('now', ?)").get(`-${late} minutes`).n;
  if (slow >= 3) await raise('slow', `slow:${today}:${localHourNow()}`, `${s.business_name}: kitchen running behind`, `${slow} tickets are over ${late} minutes right now.`);
  const disc = db.prepare('SELECT COALESCE(SUM(discount_cents),0) d, COALESCE(SUM(subtotal_cents),0) s FROM orders WHERE created_at >= ? AND created_at < ? AND status <> \'void\'').get(start, end);
  if (disc.s > 20000 && disc.d / disc.s > 0.15) await raise('discounts', `discounts:${today}`, `${s.business_name}: discounts are high`, `${Math.round((disc.d / disc.s) * 100)}% of today's sales were discounted (${fmt(disc.d)}).`);
}
async function maybeDailySummary() {
  const s = getSettings(); if (s.insights_summary !== '1') return;
  const today = localToday(); const hour = Math.max(0, Math.min(23, Number(s.insights_hour) || 22));
  if (localHourNow() < hour) return;
  if (db.prepare('SELECT 1 FROM insights WHERE day = ? AND sent_at IS NOT NULL').get(today)) return;
  const d = daySummary(today);
  db.prepare('INSERT INTO insights (day, data, sent_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(day) DO UPDATE SET data = excluded.data, sent_at = excluded.sent_at').run(today, JSON.stringify(d));
  await pushToUsers(['owner'], { title: `${s.business_name}: today's summary`, body: summaryText(d, s), tag: 'summary', url: '/insights' }).catch(() => {});
}

export function registerCrm({ app, staff, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, requireCustomer, publicBase } = h;

  staff.get('/customers/:id', requireAuth('manager'), (req, res) => {
    const p = customerProfile(idParam(req)); if (!p) throw err('Not found', 404); res.json(p);
  });
  // quick lookup used on the waitlist, bookings and register (any staff)
  staff.get('/customers/:id/card', (req, res) => {
    const c = db.prepare('SELECT id, name, visits, tags, notes, birthday FROM customers WHERE id = ?').get(idParam(req));
    if (!c) throw err('Not found', 404);
    const p = customerProfile(c.id);
    res.json({ id: c.id, name: c.name, visits: c.visits || 0, tags: tagsOf(c.tags), notes: c.notes || '', usual: p.usual.slice(0, 3), birthdayToday: c.birthday === localToday().slice(5) });
  });
  staff.put('/customers/:id', (req, res) => {
    const b = parse(z.object({ notes: z.string().trim().max(500).optional(), tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(), birthday: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).nullable().optional() }), req.body);
    const id = idParam(req);
    if (b.notes !== undefined) db.prepare('UPDATE customers SET notes = ? WHERE id = ?').run(b.notes || null, id);
    if (b.tags !== undefined) db.prepare('UPDATE customers SET tags = ? WHERE id = ?').run(JSON.stringify([...new Set(b.tags)]), id);
    if (b.birthday !== undefined) db.prepare('UPDATE customers SET birthday = ? WHERE id = ?').run(b.birthday, id);
    audit(req.user, 'customer.edit', `#${id}`, clientIp(req));
    res.json({ ok: true });
  });
  app.get('/api/c/profile', requireCustomer, (req, res) => res.json({ birthday: db.prepare('SELECT birthday FROM customers WHERE id = ?').get(req.customer.id)?.birthday || null }));
  app.put('/api/c/profile', requireCustomer, (req, res) => {
    const b = parse(z.object({ birthday: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Pick a month and day').nullable() }), req.body);
    db.prepare('UPDATE customers SET birthday = ? WHERE id = ?').run(b.birthday, req.customer.id);
    res.json({ ok: true, birthday: b.birthday });
  });

  staff.get('/autooffers', requireAuth('manager'), (req, res) => {
    const s = getSettings();
    const flows = Object.entries(FLOWS).map(([k, f]) => {
      const st = db.prepare('SELECT COUNT(*) n, SUM(reached) r FROM auto_sends WHERE flow = ?').get(k);
      const used = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(o.total_cents),0) c FROM orders o JOIN auto_sends a ON a.code = o.promo_code COLLATE NOCASE WHERE a.flow = ? AND o.status <> 'void'").get(k);
      return { key: k, label: f.label, on: s[`auto_${k}`] === '1', pct: Number(s[`auto_${k}_pct`]) || 10, waiting: candidates(k, s).length, sent: st.n, reached: st.r || 0, used: used.n, salesCents: used.c };
    });
    res.json({ flows, winbackDays: Number(s.auto_winback_days) || 45, recent: db.prepare('SELECT a.flow, a.code, a.sent_at, a.reached, c.name FROM auto_sends a JOIN customers c ON c.id = a.customer_id ORDER BY a.id DESC LIMIT 30').all() });
  });
  staff.post('/autooffers/run', requireAuth('manager'), wrap(async (req, res) => {
    const r = await runFlows(publicBase(req));
    audit(req.user, 'auto.run', JSON.stringify(r), clientIp(req));
    res.json(r);
  }));

  staff.get('/insights', requireAuth('manager'), (req, res) => {
    const s = getSettings();
    const past = db.prepare('SELECT day, data FROM insights ORDER BY day DESC LIMIT 14').all().map((r) => JSON.parse(r.data));
    const days = Array.from({ length: 7 }, (_, i) => addDays(localToday(), -(i + 1))).filter((d) => !past.some((p) => p.day === d)).map((d) => daySummary(d));
    const history = [...past, ...days].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14);
    res.json({ today: daySummary(), history, alerts: db.prepare('SELECT * FROM insight_alerts ORDER BY id DESC LIMIT 30').all(), settings: { summary: s.insights_summary === '1', hour: Number(s.insights_hour) || 22, alerts: s.insights_alerts === '1' } });
  });
  // what each way of paying cost over the last 30 days, and what moving some of it would save
  staff.get('/insights/fees', requireAuth('manager'), (req, res) => {
    const s = getSettings(); let rates = {}; try { rates = JSON.parse(s.fee_rates || '{}'); } catch { /* defaults */ }
    const rows = db.prepare("SELECT payment_method m, source, total_cents c FROM orders WHERE paid_at > datetime('now','-30 days') AND status <> 'void' AND paid_at IS NOT NULL").all();
    const by = {};
    for (const r of rows) {
      let k = String(r.m || 'other').split('+')[0];
      if (k === 'card' && ['online', 'guest', 'table'].includes(r.source)) k = 'online';
      if (!rates[k]) k = k === 'split' ? 'card' : 'other';
      const b = by[k] || (by[k] = { method: k, count: 0, cents: 0, feeCents: 0 });
      const [pct, fixed] = rates[k] || [0, 0];
      b.count += 1; b.cents += r.c; b.feeCents += Math.round(r.c * pct / 100 + fixed);
    }
    const list = Object.values(by).sort((a, b) => b.feeCents - a.feeCents);
    const fees = list.reduce((a, x) => a + x.feeCents, 0); const sales = list.reduce((a, x) => a + x.cents, 0);
    const cardish = list.filter((x) => ['card', 'online', 'paypal', 'paypalme', 'cashapp'].includes(x.method));
    const cardFees = cardish.reduce((a, x) => a + x.feeCents, 0);
    res.json({ days: 30, salesCents: sales, feeCents: fees, effectivePct: sales ? Math.round((fees / sales) * 1000) / 10 : 0, methods: list, rates,
      ideas: { tenPctToZelleCents: Math.round(cardFees * 0.1), cashDiscountOn: Number(s.cash_discount_pct) > 0, zelleOn: s.pay_handles_enabled === '1' && Boolean(s.pay_zelle) } });
  });
  staff.post('/insights/send', requireAuth('owner'), wrap(async (req, res) => {
    const s = getSettings(); const d = daySummary();
    const r = await pushToUsers(['owner'], { title: `${s.business_name}: today so far`, body: summaryText(d, s), tag: 'summary', url: '/insights' }).catch(() => ({ sent: 0 }));
    res.json({ sent: r.sent, text: summaryText(d, s) });
  }));

  // jobs: automatic offers once a day after 10am local; summaries and checks every 10 minutes
  setInterval(() => forEachLocation(async () => {
    try {
      await checkAnomalies(); await maybeDailySummary();
      const s = getSettings(); const today = localToday();
      if (localHourNow() >= 10 && s.auto_last_run !== today && ['birthday', 'winback', 'welcome'].some((f) => s[`auto_${f}`] === '1')) {
        setSettings({ auto_last_run: today });
        await runFlows();
      }
    } catch (e) { console.error('crm job', e.message); }
  }), 10 * 60_000).unref();
}
