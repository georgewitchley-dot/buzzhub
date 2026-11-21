// Round 4, batch C: promo codes + marketing campaigns, tip pooling + payouts, staffing forecast.
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentTz, currentSlug, getJwtSecret } from './db.js';
import { pushToCustomer, emailEnabled, emailGuest } from './notify.js';
import { dayBounds } from './ops.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS promos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('pct','amount')), value INTEGER NOT NULL,
  min_cents INTEGER NOT NULL DEFAULT 0, starts_on TEXT, ends_on TEXT, max_uses INTEGER,
  active INTEGER NOT NULL DEFAULT 1, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, message TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all', promo_id INTEGER, link TEXT NOT NULL DEFAULT 'order',
  sent_at TEXT, pushed INTEGER NOT NULL DEFAULT 0, emailed INTEGER NOT NULL DEFAULT 0, reached INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tip_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, period_from TEXT NOT NULL, period_to TEXT NOT NULL,
  user_id INTEGER NOT NULL, hours REAL NOT NULL, points REAL NOT NULL, cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'payroll', paid_by INTEGER, paid_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('customers').includes('marketing_opt_in')) db.exec('ALTER TABLE customers ADD COLUMN marketing_opt_in INTEGER NOT NULL DEFAULT 0');
  if (!cols('users').includes('tip_points')) db.exec('ALTER TABLE users ADD COLUMN tip_points REAL NOT NULL DEFAULT 1');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const t = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const localParts = (ts) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: currentTz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(`${ts.replace(' ', 'T')}Z`)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), dow: new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay() };
};
const dowOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

/* ================= Promo codes ================= */
const usesOf = (code) => db.prepare("SELECT COUNT(*) n FROM orders WHERE promo_code = ? COLLATE NOCASE AND status <> 'void'").get(code).n;
export function promoDiscount(code, subtotal) {
  const p = db.prepare('SELECT * FROM promos WHERE code = ? COLLATE NOCASE').get(String(code).trim());
  if (!p || !p.active) throw err(`Promo code ${code} isn't valid`);
  const today = localToday();
  if (p.starts_on && today < p.starts_on) throw err(`Promo code ${p.code} starts ${p.starts_on}`);
  if (p.ends_on && today > p.ends_on) throw err(`Promo code ${p.code} has ended`);
  if (p.min_cents && subtotal < p.min_cents) throw err(`Promo code ${p.code} needs an order of at least ${(p.min_cents / 100).toFixed(2)}`);
  if (p.max_uses && usesOf(p.code) >= p.max_uses) throw err(`Promo code ${p.code} has been fully used`);
  const cents = p.kind === 'pct' ? Math.round(subtotal * p.value / 100) : Math.min(p.value, subtotal);
  return { code: p.code, cents };
}

const unsubSig = (id, slug) => crypto.createHmac('sha256', getJwtSecret()).update(`unsub:${slug}:${id}`).digest('base64url').slice(0, 22);

export function registerTeam({ app, staff, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, requireCustomer, publicBase, publicLimiter, notifyStaff } = h;
  h.promoDiscount = promoDiscount;

  const promoSchema = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, 'Codes are 3 to 20 letters, numbers or dashes'),
    kind: z.enum(['pct', 'amount']), value: z.coerce.number().int().min(1).max(100000),
    min_cents: z.coerce.number().int().min(0).max(1000000).default(0),
    starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    max_uses: z.coerce.number().int().min(1).max(100000).nullable().optional(), note: z.string().trim().max(80).optional(),
  }).refine((p) => p.kind !== 'pct' || p.value <= 100, 'A percent off must be 100 or less');

  const promoRow = (p) => {
    const r = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) sales, COALESCE(SUM(discount_cents),0) given FROM orders WHERE promo_code = ? COLLATE NOCASE AND status <> 'void'").get(p.code);
    return { ...p, uses: r.n, salesCents: r.sales, discountCents: r.given };
  };
  staff.get('/promos', requireAuth('manager'), (req, res) => res.json(db.prepare('SELECT * FROM promos ORDER BY active DESC, id DESC').all().map(promoRow)));
  staff.post('/promos', requireAuth('manager'), (req, res) => {
    const b = parse(promoSchema, req.body);
    if (db.prepare('SELECT 1 FROM promos WHERE code = ? COLLATE NOCASE').get(b.code)) throw err('That code already exists', 409);
    const id = db.prepare('INSERT INTO promos (code, kind, value, min_cents, starts_on, ends_on, max_uses, note) VALUES (?,?,?,?,?,?,?,?)')
      .run(b.code, b.kind, b.value, b.min_cents, b.starts_on || null, b.ends_on || null, b.max_uses || null, b.note || null).lastInsertRowid;
    audit(req.user, 'promo.create', `${b.code}: ${b.kind === 'pct' ? `${b.value}%` : (b.value / 100).toFixed(2)} off`, clientIp(req));
    notifyStaff('promos');
    res.json(promoRow(db.prepare('SELECT * FROM promos WHERE id = ?').get(id)));
  });
  staff.post('/promos/:id/active', requireAuth('manager'), (req, res) => {
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    db.prepare('UPDATE promos SET active = ? WHERE id = ?').run(active ? 1 : 0, idParam(req));
    audit(req.user, active ? 'promo.on' : 'promo.off', `#${req.params.id}`, clientIp(req));
    notifyStaff('promos'); res.json({ ok: true });
  });
  app.get('/api/public/promo', publicLimiter, (req, res) => {
    const code = String(req.query.code || '').slice(0, 30); const subtotal = Math.max(0, Number(req.query.subtotal) || 0);
    try { res.json({ ok: true, ...promoDiscount(code, subtotal) }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  /* ================= Customers who said yes to offers ================= */
  app.get('/api/c/marketing', requireCustomer, (req, res) => res.json({ optIn: Boolean(db.prepare('SELECT marketing_opt_in m FROM customers WHERE id = ?').get(req.customer.id)?.m) }));
  app.put('/api/c/marketing', requireCustomer, (req, res) => {
    const { optIn } = parse(z.object({ optIn: z.boolean() }), req.body);
    db.prepare('UPDATE customers SET marketing_opt_in = ? WHERE id = ?').run(optIn ? 1 : 0, req.customer.id);
    res.json({ optIn });
  });
  app.get('/api/unsub/:slug/:id/:sig', (req, res) => {
    const id = Number(req.params.id);
    const ok = req.params.slug === currentSlug() && Number.isInteger(id) && crypto.timingSafeEqual(Buffer.from(unsubSig(id, currentSlug())), Buffer.from(String(req.params.sig).padEnd(22).slice(0, 22)));
    if (ok) db.prepare('UPDATE customers SET marketing_opt_in = 0 WHERE id = ?').run(id);
    res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#111318;color:#eee;display:grid;place-items:center;min-height:90vh;text-align:center"><div><h2>${ok ? "You're unsubscribed" : 'That link has expired'}</h2><p>${ok ? `You won't get offers from ${getSettings().business_name.replace(/[<>&]/g, '')} anymore. Booking reminders and buzzes still work.` : 'Turn offers off from your account page instead.'}</p></div></body>`);
  });

  /* ================= Campaigns ================= */
  const audienceSql = {
    all: '',
    regulars: 'AND visits >= 3',
    lapsed: "AND COALESCE(last_login_at, created_at) < datetime('now','-30 days')",
    new: "AND created_at >= datetime('now','-30 days')",
  };
  const audienceOf = (a) => db.prepare(`SELECT id, name, email FROM customers WHERE marketing_opt_in = 1 ${audienceSql[a] ?? ''}`).all();
  const campaignRow = (c) => {
    const promo = c.promo_id ? db.prepare('SELECT * FROM promos WHERE id = ?').get(c.promo_id) : null;
    return { ...c, promo: promo ? promoRow(promo) : null };
  };
  staff.get('/campaigns', requireAuth('manager'), (req, res) => {
    const counts = Object.fromEntries(Object.keys(audienceSql).map((a) => [a, audienceOf(a).length]));
    const total = db.prepare('SELECT COUNT(*) n FROM customers').get().n;
    res.json({ campaigns: db.prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT 50').all().map(campaignRow), audiences: counts, customers: total, emailEnabled: emailEnabled() });
  });
  staff.post('/campaigns', requireAuth('manager'), wrap(async (req, res) => {
    const b = parse(z.object({
      title: z.string().trim().min(1).max(60), message: z.string().trim().min(1).max(240),
      audience: z.enum(['all', 'regulars', 'lapsed', 'new']), promoId: z.number().int().positive().nullable().optional(),
      link: z.enum(['order', 'account', 'gift']).default('order'), email: z.boolean().default(true),
    }), req.body);
    const promo = b.promoId ? db.prepare('SELECT * FROM promos WHERE id = ? AND active = 1').get(b.promoId) : null;
    if (b.promoId && !promo) throw err('That promo code is turned off');
    const people = audienceOf(b.audience);
    if (!people.length) throw err('Nobody in that group has said yes to offers yet');
    const recent = db.prepare("SELECT 1 FROM campaigns WHERE sent_at > datetime('now','-12 hours')").get();
    if (recent && req.get('X-Confirm-Repeat') !== '1') throw err('A campaign went out in the last 12 hours. Wait a bit so customers do not get too many messages.', 429);
    const id = db.prepare('INSERT INTO campaigns (title, message, audience, promo_id, link, created_by) VALUES (?,?,?,?,?,?)').run(b.title, b.message, b.audience, promo?.id || null, b.link, req.user.id).lastInsertRowid;
    const s = getSettings(); const base = publicBase(req); const slug = currentSlug();
    const path = b.link === 'order' ? '/order' : b.link === 'gift' ? '/gift' : '/account';
    const q = new URLSearchParams(); if (slug !== 'main') q.set('l', slug); if (promo && b.link === 'order') q.set('promo', promo.code);
    const url = `${path}${q.size ? `?${q}` : ''}`;
    const body = promo ? `${b.message} Use code ${promo.code}.` : b.message;
    let pushed = 0; let emailed = 0; const reached = new Set();
    for (const c of people) {
      const r = await pushToCustomer(c.id, { title: `${s.business_name}: ${b.title}`, body, tag: `campaign-${id}`, url }).catch(() => 0);
      if (r?.sent) { pushed += 1; reached.add(c.id); }
      if (b.email && emailEnabled()) {
        const sent = await emailGuest(c.email, { businessName: s.business_name, subject: b.title, message: body, link: `${base}${url}`, accent: s.accent, button: b.link === 'order' ? 'Order now' : b.link === 'gift' ? 'Buy a gift card' : 'Book now', unsubscribe: `${base}/api/unsub/${slug}/${c.id}/${unsubSig(c.id, slug)}?l=${slug}` }).then((x) => x.ok).catch(() => false);
        if (sent) { emailed += 1; reached.add(c.id); }
      }
    }
    db.prepare('UPDATE campaigns SET sent_at = ?, pushed = ?, emailed = ?, reached = ? WHERE id = ?').run(t(), pushed, emailed, reached.size, id);
    audit(req.user, 'campaign.send', `"${b.title}" to ${b.audience}: ${reached.size} of ${people.length} reached`, clientIp(req));
    res.json(campaignRow(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id)));
  }));

  /* ================= Tip pool ================= */
  const lastPayout = () => db.prepare('SELECT MAX(period_to) d FROM tip_payouts').get().d;
  function tipPool(from, to) {
    const a = dayBounds(from).start; const z2 = dayBounds(to).end;
    const tips = db.prepare("SELECT COALESCE(SUM(tip_cents),0) c, COUNT(*) n FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void' AND tip_cents > 0").get(a, z2);
    const s = getSettings();
    const rows = db.prepare('SELECT s.user_id, s.clock_in, s.clock_out, s.break_minutes, u.name, u.role, u.tip_points FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in < ? AND COALESCE(s.clock_out, ?) > ?').all(z2, t(), a);
    const by = new Map();
    for (const r of rows) {
      if (s.tip_pool_managers !== '1' && r.role !== 'staff') continue;
      const st = r.clock_in < a ? a : r.clock_in; const en = (r.clock_out || t()) > z2 ? z2 : (r.clock_out || t());
      const hrs = Math.max(0, (Date.parse(`${en.replace(' ', 'T')}Z`) - Date.parse(`${st.replace(' ', 'T')}Z`)) / 3600000 - r.break_minutes / 60);
      const p = by.get(r.user_id) || { userId: r.user_id, name: r.name, role: r.role, points: r.tip_points, hours: 0 };
      p.hours += hrs; by.set(r.user_id, p);
    }
    const people = [...by.values()].filter((p) => p.hours > 0.01);
    const weight = people.reduce((x, p) => x + p.hours * p.points, 0);
    let left = tips.c;
    people.sort((x, y) => y.hours * y.points - x.hours * x.points).forEach((p, i) => {
      p.hours = Math.round(p.hours * 100) / 100;
      p.cents = i === people.length - 1 ? left : Math.floor(tips.c * (p.hours * p.points) / (weight || 1));
      left -= p.cents;
      p.perHourCents = p.hours ? Math.round(p.cents / p.hours) : 0;
    });
    return { from, to, tipsCents: tips.c, tippedOrders: tips.n, people };
  }
  staff.get('/tips', requireAuth('manager'), (req, res) => {
    const last = lastPayout();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : (last ? addDays(last, 1) : addDays(localToday(), -13));
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : localToday();
    if (to < from) throw err('The end date is before the start date');
    const team = db.prepare('SELECT id, name, role, tip_points FROM users WHERE active = 1 ORDER BY name').all();
    const history = db.prepare('SELECT p.period_from, p.period_to, MAX(p.paid_at) paid_at, SUM(p.cents) cents, COUNT(*) people, MAX(u.name) paid_by_name, MAX(p.method) method FROM tip_payouts p LEFT JOIN users u ON u.id = p.paid_by GROUP BY p.period_from, p.period_to ORDER BY p.period_to DESC LIMIT 20').all();
    res.json({ ...tipPool(from, to), lastPaidThrough: last, team, history, includeManagers: getSettings().tip_pool_managers === '1' });
  });
  staff.put('/tips/points', requireAuth('manager'), (req, res) => {
    const b = parse(z.object({ userId: z.number().int().positive(), points: z.number().min(0).max(10) }), req.body);
    db.prepare('UPDATE users SET tip_points = ? WHERE id = ?').run(b.points, b.userId);
    audit(req.user, 'tips.points', `user ${b.userId} → ${b.points}`, clientIp(req)); res.json({ ok: true });
  });
  staff.post('/tips/payout', requireAuth('manager'), (req, res) => {
    const b = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), method: z.enum(['payroll', 'cash']) }), req.body);
    if (b.to > localToday()) throw err('You can only pay out days that have started');
    const clash = db.prepare('SELECT period_from, period_to FROM tip_payouts WHERE period_from <= ? AND period_to >= ? LIMIT 1').get(b.to, b.from);
    if (clash) throw err(`Tips from ${clash.period_from} to ${clash.period_to} were already paid out. Pick days after ${clash.period_to}.`, 409);
    const pool = tipPool(b.from, b.to);
    if (!pool.tipsCents || !pool.people.length) throw err('There are no tips or hours to pay out for those days');
    const ins = db.prepare('INSERT INTO tip_payouts (period_from, period_to, user_id, hours, points, cents, method, paid_by) VALUES (?,?,?,?,?,?,?,?)');
    db.transaction(() => pool.people.forEach((p) => ins.run(b.from, b.to, p.userId, p.hours, p.points, p.cents, b.method, req.user.id)))();
    if (b.method === 'cash') {
      const cs = db.prepare('SELECT id FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get();
      if (cs) db.prepare("INSERT INTO cash_moves (session_id, kind, amount_cents, reason, user_id) VALUES (?, 'out', ?, ?, ?)").run(cs.id, pool.tipsCents, `Tip payout ${b.from} to ${b.to}`, req.user.id);
    }
    audit(req.user, 'tips.payout', `${b.from}..${b.to}: ${(pool.tipsCents / 100).toFixed(2)} to ${pool.people.length} people (${b.method})`, clientIp(req));
    notifyStaff('cash'); notifyStaff('shifts');
    res.json(pool);
  });
  staff.get('/tips/mine', (req, res) => {
    const rows = db.prepare('SELECT period_from, period_to, hours, cents, method, paid_at FROM tip_payouts WHERE user_id = ? ORDER BY period_to DESC LIMIT 12').all(req.user.id);
    res.json(rows);
  });

  /* ================= Staffing forecast ================= */
  const weatherCache = new Map();
  async function getJson(url) {
    const ctl = AbortSignal.timeout(6000);
    const r = await fetch(url, { signal: ctl }); if (!r.ok) throw new Error(`weather ${r.status}`); return r.json();
  }
  async function weatherFor(city) {
    if (!city) return null;
    const key = `${currentSlug()}:${city}`; const hit = weatherCache.get(key);
    if (hit && Date.now() - hit.at < 60 * 60_000) return hit.v;
    try {
      const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city.split(',')[0].trim())}`);
      const place = g.results?.[0]; if (!place) throw new Error('place not found');
      const { latitude: la, longitude: lo } = place;
      const end = localToday(); const start = addDays(end, -56);
      const [fc, past] = await Promise.all([
        getJson(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&daily=weather_code,temperature_2m_max,precipitation_probability_max,precipitation_sum&timezone=${encodeURIComponent(currentTz())}&forecast_days=7`),
        getJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${la}&longitude=${lo}&start_date=${start}&end_date=${addDays(end, -2)}&daily=precipitation_sum&timezone=${encodeURIComponent(currentTz())}`).catch(() => null),
      ]);
      const days = Object.fromEntries(fc.daily.time.map((d, i) => [d, { code: fc.daily.weather_code[i], maxC: fc.daily.temperature_2m_max[i], rainPct: fc.daily.precipitation_probability_max[i], rainMm: fc.daily.precipitation_sum[i] }]));
      const pastRain = past ? Object.fromEntries(past.daily.time.map((d, i) => [d, past.daily.precipitation_sum[i]])) : {};
      const v = { place: `${place.name}${place.admin1 ? `, ${place.admin1}` : ''}`, days, pastRain };
      weatherCache.set(key, { at: Date.now(), v }); return v;
    } catch (e) {
      weatherCache.set(key, { at: Date.now() - 50 * 60_000, v: null }); return null;
    }
  }
  const sky = (code) => (code == null ? '' : code === 0 ? 'Clear' : code <= 3 ? 'Partly cloudy' : code <= 48 ? 'Fog' : code <= 67 ? 'Rain' : code <= 77 ? 'Snow' : code <= 82 ? 'Showers' : 'Storms');

  staff.get('/forecast', requireAuth('manager'), wrap(async (req, res) => {
    const s = getSettings();
    const today = localToday(); const histFrom = addDays(today, -56);
    const orders = db.prepare("SELECT paid_at, total_cents - tip_cents AS c FROM orders WHERE paid_at >= ? AND status <> 'void'").all(dayBounds(histFrom).start);
    const byDayHour = new Map(); const dayTotals = new Map();
    for (const o of orders) {
      const p = localParts(o.paid_at); if (p.date >= today) continue;
      const k = `${p.date}|${p.hour}`; const cur = byDayHour.get(k) || { c: 0, n: 0 }; cur.c += o.c; cur.n += 1; byDayHour.set(k, cur);
      dayTotals.set(p.date, (dayTotals.get(p.date) || 0) + o.c);
    }
    const daysSeen = [...dayTotals.keys()];
    const weeksOf = (dow) => Math.max(1, Array.from({ length: 8 }, (_, i) => addDays(today, -7 * (i + 1) - ((dowOf(today) - dow + 7) % 7))).filter((d) => d >= histFrom).length);
    const weather = await weatherFor(s.forecast_city);
    // Learn how rain changes sales here: compare rainy days to the usual for that weekday.
    let rainEffect = Number(s.forecast_rain_pct) / 100; let rainLearned = false;
    if (weather?.pastRain && daysSeen.length >= 14) {
      const avgDow = [0, 1, 2, 3, 4, 5, 6].map((d) => { const v = daysSeen.filter((x) => dowOf(x) === d).map((x) => dayTotals.get(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; });
      const ratios = daysSeen.filter((d) => (weather.pastRain[d] ?? 0) >= 2 && avgDow[dowOf(d)] > 0).map((d) => dayTotals.get(d) / avgDow[dowOf(d)]);
      if (ratios.length >= 3) { rainEffect = Math.max(-0.6, Math.min(0.6, ratios.reduce((a, b) => a + b, 0) / ratios.length - 1)); rainLearned = true; }
    }
    const perStaff = Math.max(1000, Number(s.staff_sales_per_hour_cents) || 15000); const minStaff = Math.max(0, Number(s.staff_min) || 1);
    const sched = db.prepare('SELECT start_local, end_local FROM schedule WHERE substr(start_local,1,10) >= ? AND substr(start_local,1,10) <= ?').all(today, addDays(today, 6));
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(today, i); const dow = dowOf(date); const n = weeksOf(dow);
      const w = weather?.days?.[date] || null;
      const rainy = w && (w.rainPct >= 60 || w.rainMm >= 2);
      const factor = rainy ? 1 + rainEffect : 1;
      const hours = [];
      for (let hr = 0; hr < 24; hr += 1) {
        let c = 0; let cnt = 0;
        for (let k = 1; k <= 8; k += 1) { const d = addDays(date, -7 * k); if (d < histFrom) break; const v = byDayHour.get(`${d}|${hr}`); if (v) { c += v.c; cnt += v.n; } }
        const sales = Math.round((c / n) * factor); const ordersN = Math.round((cnt / n) * factor * 10) / 10;
        const hh = String(hr).padStart(2, '0');
        const onSched = sched.filter((x) => x.start_local.startsWith(date) && x.start_local.slice(11, 13) <= hh && x.end_local.slice(11, 16) > `${hh}:00`).length;
        if (sales === 0 && onSched === 0) continue;
        const need = sales ? Math.max(minStaff, Math.ceil(sales / perStaff)) : 0;
        hours.push({ hour: hr, salesCents: sales, orders: ordersN, need, scheduled: onSched, gap: onSched - need });
      }
      const sales = hours.reduce((a, x) => a + x.salesCents, 0);
      return { date, salesCents: sales, peakNeed: hours.reduce((a, x) => Math.max(a, x.need), 0), staffHours: hours.reduce((a, x) => a + x.need, 0), schedHours: hours.reduce((a, x) => a + x.scheduled, 0), short: hours.filter((x) => x.gap < 0).map((x) => x.hour), over: hours.filter((x) => x.gap > 1).map((x) => x.hour), weather: w ? { sky: sky(w.code), maxC: w.maxC, rainPct: w.rainPct, rainy } : null, hours };
    });
    res.json({ days, historyDays: daysSeen.length, weatherPlace: weather?.place || null, weatherOn: Boolean(s.forecast_city), weatherReached: Boolean(weather), rainEffectPct: Math.round(rainEffect * 100), rainLearned, perStaffCents: perStaff, minStaff });
  }));
}
