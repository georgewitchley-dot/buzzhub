// Round 11: pay by bank, dish photos, online catering orders, auto-built schedules, barcode stock counts, cook timers,
// supplier price comparison, supplier bills in the accounting export, review themes, safe log (optional).
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, currentTz } from './db.js';
import { menuHooks, stripe, stripeEnabled } from './commerce.js';
import { pushToUsers, emailEnabled, emailGuest } from './notify.js';
import { dayBounds } from './ops.js';
import { findUserByPin, loginBlocked, recordLoginFail, clearLoginFails } from './security.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS catering_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, price_cents INTEGER NOT NULL, unit TEXT NOT NULL DEFAULT 'each' CHECK (unit IN ('each','person')),
  min_qty INTEGER NOT NULL DEFAULT 1, serves INTEGER, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ingredient_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, cost_cents REAL NOT NULL, source TEXT NOT NULL DEFAULT 'quote', note TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (ingredient_id, supplier_id)
);
CREATE TABLE IF NOT EXISTS safe_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('count','drop','to_bank','adjust')), amount_cents INTEGER NOT NULL, expected_cents INTEGER,
  note TEXT, user_id INTEGER NOT NULL, witness_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const mi = cols('menu_items');
  if (!mi.includes('cook_minutes')) db.exec('ALTER TABLE menu_items ADD COLUMN cook_minutes INTEGER');
  if (!mi.includes('show_photo')) db.exec('ALTER TABLE menu_items ADD COLUMN show_photo INTEGER NOT NULL DEFAULT 1');
  if (!cols('ingredients').includes('barcode')) db.exec('ALTER TABLE ingredients ADD COLUMN barcode TEXT');
  if (!cols('payments').includes('bank_status')) db.exec('ALTER TABLE payments ADD COLUMN bank_status TEXT');
  if (!cols('invoices').includes('source')) db.exec("ALTER TABLE invoices ADD COLUMN source TEXT NOT NULL DEFAULT 'staff'");
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const parseJ = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dowOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const fmt = (c) => `$${(c / 100).toFixed(2)}`;
const pad = (n) => String(n).padStart(2, '0');
const localStampNow = (offsetMin = 0) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: currentTz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + offsetMin * 60000)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };

/* ---------- dish photos on customer menus ---------- */
menuHooks.adjust.push((items) => {
  if (getSettings().menu_photos !== '1') return items;
  const rows = Object.fromEntries(db.prepare("SELECT id, photo_version, show_photo FROM menu_items WHERE photo_version <> '0' AND show_photo = 1").all().map((r) => [r.id, r.photo_version]));
  return items.map((i) => (rows[i.id] ? { ...i, photo: `/api/public/item-photo/${i.id}?l=${currentSlug()}&v=${rows[i.id]}` } : i));
});

/* ---------- review themes (no outside service: keyword groups) ---------- */
const THEMES = [
  ['Food quality', /\b(delicious|tasty|flavou?r|fresh|bland|salty|greasy|soggy|dry|overcooked|undercooked|raw|burnt|stale|amazing food|great food|good food|bad food)\b/i],
  ['Temperature', /\b(cold|lukewarm|warm|hot food|not hot|room temp)/i],
  ['Wait and speed', /\b(slow|wait|waited|waiting|forever|took long|long time|quick|fast|prompt|minutes late)\b/i],
  ['Staff and service', /\b(rude|friendly|server|waiter|waitress|staff|service|attentive|ignored|helpful|nice|kind|manager)\b/i],
  ['Order accuracy', /\b(wrong|missing|forgot|forgotten|incorrect|mixed up|not what i ordered|left out)\b/i],
  ['Price and value', /\b(price|pricey|expensive|overpriced|value|worth|cheap|portion|small portion|big portion)\b/i],
  ['Cleanliness', /\b(dirty|clean|sticky|bathroom|restroom|hair|smell|smelled|gross)\b/i],
  ['Atmosphere', /\b(loud|noisy|music|vibe|atmosphere|cozy|crowded|decor|seating|parking)\b/i],
];
export function reviewThemes(days = 90) {
  const rows = db.prepare("SELECT rating, comment, responded_at FROM feedback WHERE comment IS NOT NULL AND TRIM(comment) <> '' AND responded_at > datetime('now', ?) ORDER BY responded_at DESC").all(`-${days} days`);
  const out = THEMES.map(([name]) => ({ name, praise: 0, complaints: 0, mentions: 0, samples: [] }));
  for (const r of rows) {
    THEMES.forEach(([, re], i) => {
      if (!re.test(r.comment)) return;
      const t = out[i]; t.mentions += 1;
      if (r.rating >= 4) t.praise += 1; else if (r.rating <= 2) t.complaints += 1;
      if (t.samples.length < 3) t.samples.push({ rating: r.rating, text: r.comment.slice(0, 160) });
    });
  }
  const avg = db.prepare("SELECT ROUND(AVG(rating),2) a, COUNT(*) n FROM feedback WHERE rating IS NOT NULL AND responded_at > datetime('now', ?)").get(`-${days} days`);
  return { days, comments: rows.length, ratings: avg.n, average: avg.a, themes: out.filter((t) => t.mentions).sort((a, b) => b.complaints - a.complaints || b.mentions - a.mentions) };
}

/* ---------- auto-built schedule ---------- */
let h0 = {};
export function proposeSchedule(weekStart) {
  const s = getSettings(); const today = localToday();
  const perStaff = Math.max(1000, Number(s.staff_sales_per_hour_cents) || 15000); const minStaff = Math.max(0, Number(s.staff_min) || 1);
  const maxWeek = Number(s.ot_weekly_hours) || 40; const minShift = 4; const maxShift = 9;
  const histFrom = addDays(today, -56);
  const tzOff = (() => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: currentTz(), timeZoneName: 'shortOffset' }).formatToParts(new Date()).map((x) => [x.type, x.value])); const m = /GMT([+-]\d+)(?::(\d+))?/.exec(p.timeZoneName || ''); return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 0; })();
  const sales = db.prepare(`SELECT substr(datetime(paid_at, '${tzOff} minutes'),1,10) d, CAST(substr(datetime(paid_at, '${tzOff} minutes'),12,2) AS INTEGER) h, SUM(subtotal_cents - discount_cents) c FROM orders WHERE paid_at >= ? AND status <> 'void' GROUP BY d, h`).all(dayBounds(histFrom).start);
  const byDow = Array.from({ length: 7 }, () => Array(24).fill(0)); const seen = Array.from({ length: 7 }, () => new Set());
  for (const r of sales) { if (r.d >= today) continue; const dw = dowOf(r.d); byDow[dw][r.h] += r.c; seen[dw].add(r.d); }
  const allStaff = db.prepare("SELECT id, name, role, area FROM users WHERE active = 1 AND role = 'staff'").all();
  const byArea = s.schedule_by_area === '1' && h0.areaSalesByDow ? h0.areaSalesByDow(dayBounds(histFrom).start, tzOff, today) : null;
  const areaNames = byArea ? Object.keys(byArea).filter((a) => allStaff.some((u) => u.area === a)) : [];
  const staff = allStaff;
  const avail = db.prepare('SELECT * FROM availability').all();
  const off = db.prepare("SELECT * FROM time_off WHERE status IN ('approved','pending') AND end_date >= ? AND start_date <= ?").all(weekStart, addDays(weekStart, 6));
  const existing = db.prepare('SELECT user_id, start_local, end_local FROM schedule WHERE substr(start_local,1,10) BETWEEN ? AND ?').all(weekStart, addDays(weekStart, 6));
  const hrsOf = (a, b) => (Date.parse(`${b.replace(' ', 'T')}:00Z`) - Date.parse(`${a.replace(' ', 'T')}:00Z`)) / 3600000;
  const weekHours = Object.fromEntries(staff.map((u) => [u.id, existing.filter((e) => e.user_id === u.id).reduce((a, e) => a + hrsOf(e.start_local, e.end_local), 0)]));
  const shifts = []; const gaps = [];
  const groups = byArea ? [...areaNames.map((a) => ({ area: a, people: allStaff.filter((u) => u.area === a), sales: byArea[a], per: Math.max(1000, Number(s.area_sales_per_hour_cents) || 20000), min: 1 })), { area: 'Front of house', people: allStaff.filter((u) => !areaNames.includes(u.area)), sales: byDow, per: perStaff, min: minStaff }]
    : [{ area: null, people: allStaff, sales: byDow, per: perStaff, min: minStaff }];
  for (const grp of groups) for (let i = 0; i < 7; i += 1) {
    const date = addDays(weekStart, i); const dw = dowOf(date); const n = Math.max(1, seen[dw].size);
    const need = grp.sales[dw].map((c) => (c ? Math.max(grp.min, Math.ceil(c / n / grp.per)) : 0));
    const already = Array(24).fill(0);
    const groupIds = new Set(grp.people.map((u) => u.id));
    for (const e of existing.filter((x) => x.start_local.startsWith(date) && (!grp.area || groupIds.has(x.user_id)))) for (let h = Number(e.start_local.slice(11, 13)); h < Math.ceil(Number(e.end_local.slice(11, 13)) + Number(e.end_local.slice(14, 16)) / 60); h += 1) if (h < 24) already[h] += 1;
    const peak = Math.max(0, ...need);
    for (let k = 1; k <= peak; k += 1) {
      const hrs = need.map((x, h) => (x - already[h] >= k ? h : -1)).filter((h) => h >= 0);
      if (!hrs.length) continue;
      let start = hrs[0]; let end = hrs[hrs.length - 1] + 1;
      if (end - start < minShift) end = Math.min(24, start + minShift);
      const blocks = end - start > maxShift ? [[start, start + Math.ceil((end - start) / 2)], [start + Math.ceil((end - start) / 2), end]] : [[start, end]];
      for (const [a, b] of blocks) {
        const len = b - a; const st = `${pad(a)}:00`; const en = b >= 24 ? '23:59' : `${pad(b)}:00`;
        const free = grp.people.filter((u) => {
          if (off.some((t) => t.user_id === u.id && t.start_date <= date && t.end_date >= date)) return false;
          const av = avail.find((x) => x.user_id === u.id && x.dow === dw);
          if (av && !av.available) return false;
          if (av?.start_time && av.start_time > st) return false;
          if (av?.end_time && av.end_time < en) return false;
          if (shifts.some((x) => x.userId === u.id && x.date === date) || existing.some((x) => x.user_id === u.id && x.start_local.startsWith(date))) return false;
          return weekHours[u.id] + len <= maxWeek;
        }).sort((x, y) => weekHours[x.id] - weekHours[y.id]);
        const pick = free[0];
        if (pick) { weekHours[pick.id] += len; shifts.push({ userId: pick.id, name: pick.name, date, start: st, end: en, hours: len, area: grp.area }); } else gaps.push({ date, start: st, end: en, area: grp.area });
      }
    }
  }
  return { weekStart, byArea: Boolean(byArea), shifts, gaps, hours: Object.entries(weekHours).map(([id, hrs]) => ({ name: staff.find((u) => u.id === Number(id))?.name, hours: hrs })).filter((x) => x.hours > 0), historyDays: seen.reduce((a, x) => a + x.size, 0) };
}

/* ---------- supplier bills for the accounting export ---------- */
const AP_DEFAULT = { ap: 'Accounts Payable', bank: 'Checking', cash: 'Cash on Hand', food: 'Cost of Goods Sold', drinks: 'Cost of Goods Sold', supplies: 'Supplies', equipment: 'Equipment', rent: 'Rent', utilities: 'Utilities', services: 'Professional Services', other: 'Other Expenses' };
export function apJournal(from, to) {
  let bills = []; let pays = [];
  try {
    bills = db.prepare("SELECT b.*, s.name supplier FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.status <> 'void' AND b.bill_date BETWEEN ? AND ?").all(from, to);
    pays = db.prepare("SELECT p.*, b.number, b.category, s.name supplier FROM bill_payments p JOIN supplier_bills b ON b.id = p.bill_id JOIN suppliers s ON s.id = b.supplier_id WHERE p.paid_on BETWEEN ? AND ?").all(from, to);
  } catch { return []; }
  const a = { ...AP_DEFAULT, ...parseJ(getSettings().acct_map, {}) };
  const out = [];
  for (const b of bills) out.push({ no: `BHB${b.id}`, date: b.bill_date, name: b.supplier, memo: `Bill ${b.number || b.id}`, lines: [[a[b.category] || a.other, b.amount_cents, 0, `${b.supplier} bill ${b.number || b.id}`], [a.ap, 0, b.amount_cents, `${b.supplier} bill ${b.number || b.id}`]] });
  for (const p of pays) out.push({ no: `BHP${p.id}`, date: p.paid_on, name: p.supplier, memo: `${p.method === 'credit' ? 'Credit' : 'Payment'} ${p.reference || ''}`.trim(), lines: [[a.ap, p.amount_cents, 0, `${p.method === 'credit' ? 'Credit from' : 'Paid'} ${p.supplier}`], [p.method === 'credit' ? (a[p.category] || a.food) : p.method === 'cash' ? a.cash : a.bank, 0, p.amount_cents, `${p.method === 'credit' ? 'Credit from' : 'Paid'} ${p.supplier} (${p.method})`]] });
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/* ---------- safe ---------- */
function safeBalance() {
  const last = db.prepare("SELECT * FROM safe_log WHERE kind = 'count' ORDER BY id DESC LIMIT 1").get();
  const since = last ? last.id : 0;
  const moves = db.prepare("SELECT kind, SUM(amount_cents) c FROM safe_log WHERE id > ? AND kind <> 'count' GROUP BY kind").all(since);
  const m = Object.fromEntries(moves.map((x) => [x.kind, x.c]));
  return { lastCount: last || null, expectedCents: (last?.amount_cents || 0) + (m.drop || 0) - (m.to_bank || 0) + (m.adjust || 0) };
}

export function registerSmart({ app, staff, io, h }) {
  h0 = h;
  const { wrap, parse, idParam, clientIp, requireAuth, publicLimiter, notifyStaff, publicBase } = h;
  const mgr = requireAuth('manager'); const owner = requireAuth('owner');

  /* ===== pay by bank (Stripe ACH) ===== */
  const BANK_KINDS = ['invoice', 'ticket', 'deposit'];
  h.bankOption = (p) => {
    const s = getSettings();
    if (s.pay_bank_enabled !== '1' || !stripeEnabled()) return null;
    if (!BANK_KINDS.includes(p.kind) || p.amount_cents + (p.tip_cents || 0) < Number(s.pay_bank_min_cents || 10000)) return null;
    return { kind: 'bank', label: 'Pay from your bank account', note: 'Lowest fee. Takes 3–5 business days to clear.' };
  };
  app.post('/api/pay/:token/bank', publicLimiter, wrap(async (req, res) => {
    const p = /^[A-Za-z0-9_-]{20,30}$/.test(req.params.token) ? db.prepare('SELECT * FROM payments WHERE pay_token = ?').get(req.params.token) : null;
    if (!p) throw err('This payment link is not valid.', 404);
    if (p.status === 'paid') return res.json({ paid: true, next: p.success_url });
    if (!h.bankOption(p)) throw err('Bank payment is not available for this amount.', 409);
    const s = getSettings(); const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `l=${currentSlug()}&`;
    const total = p.amount_cents + (p.tip_cents || 0);
    const form = { mode: 'payment', 'payment_method_types[0]': 'us_bank_account', success_url: `${base}/pay/${p.pay_token}?${l}back=1&ref={CHECKOUT_SESSION_ID}`, cancel_url: `${base}/pay/${p.pay_token}${l ? `?${l.slice(0, -1)}` : ''}`,
      'metadata[payment_id]': String(p.id), 'metadata[loc]': currentSlug(), 'payment_intent_data[metadata][loc]': currentSlug(), 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': s.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(total), 'line_items[0][price_data][product_data][name]': `${s.business_name}${p.descr ? `: ${p.descr}` : ''}`.slice(0, 120) };
    if (p.email) form.customer_email = p.email;
    const sess = await stripe('POST', '/checkout/sessions', form);
    db.prepare("UPDATE payments SET provider = 'stripe', provider_ref = ?, stripe_session = ?, method = 'bank' WHERE id = ?").run(sess.id, sess.id, p.id);
    res.json({ url: sess.url });
  }));
  // a returning bank payment is "processing" until Stripe says the money arrived
  h.bankCheck = async (p) => {
    if (p.method !== 'bank' || !p.provider_ref || !stripeEnabled()) return null;
    const sess = await stripe('GET', `/checkout/sessions/${p.provider_ref}`).catch(() => null);
    if (sess?.status === 'complete' && sess.payment_status === 'unpaid') {
      if (p.bank_status !== 'processing') {
        db.prepare("UPDATE payments SET bank_status = 'processing' WHERE id = ?").run(p.id);
        audit(null, 'pay.bank_started', `${fmt(p.amount_cents)} ${p.descr || ''}`, null);
        pushToUsers(['manager', 'owner'], { title: `${getSettings().business_name}: bank payment started`, body: `${fmt(p.amount_cents)} for ${p.descr || 'a payment'}. It clears in 3–5 business days.`, tag: `bank-${p.id}`, url: '/' }).catch(() => {});
      }
      return 'processing';
    }
    return null;
  };
  h.bankFailed = (p) => {
    db.prepare("UPDATE payments SET bank_status = 'failed' WHERE id = ?").run(p.id);
    audit(null, 'pay.bank_failed', `${fmt(p.amount_cents)} ${p.descr || ''}`, null);
    pushToUsers(['manager', 'owner'], { title: `${getSettings().business_name}: bank payment failed`, body: `${fmt(p.amount_cents)} for ${p.descr || 'a payment'} did not go through. Contact the customer.`, tag: `bank-${p.id}`, url: '/' }).catch(() => {});
  };
  staff.get('/bank-payments', mgr, (req, res) => res.json(db.prepare("SELECT id, amount_cents, descr, bank_status, status, created_at, paid_at FROM payments WHERE method = 'bank' ORDER BY id DESC LIMIT 50").all()));

  /* ===== dish photos ===== */
  app.get('/api/public/item-photo/:id', publicLimiter, (req, res) => {
    const id = idParam(req);
    if (getSettings().menu_photos !== '1' || !db.prepare('SELECT 1 FROM menu_items WHERE id = ? AND show_photo = 1').get(id)) return res.status(404).end();
    const a = db.prepare('SELECT mime, data FROM assets WHERE key = ?').get(`item:${id}`); if (!a) return res.status(404).end();
    res.set('Content-Type', a.mime).set('Cache-Control', 'public, max-age=604800, immutable').send(a.data);
  });
  staff.put('/menu/:id/show-photo', mgr, (req, res) => { const b = parse(z.object({ show: z.boolean() }), req.body); db.prepare('UPDATE menu_items SET show_photo = ? WHERE id = ?').run(b.show ? 1 : 0, idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });

  /* ===== online catering orders ===== */
  const pkgSchema = z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(400).optional(), priceCents: z.number().int().min(0).max(10_000_000), unit: z.enum(['each', 'person']), minQty: z.number().int().min(1).max(10000).default(1), serves: z.number().int().min(1).max(10000).nullable().optional(), active: z.boolean().optional() });
  staff.get('/catering-packages', mgr, (req, res) => res.json(db.prepare('SELECT * FROM catering_packages ORDER BY active DESC, sort, id').all()));
  staff.post('/catering-packages', mgr, (req, res) => { const b = parse(pkgSchema, req.body); db.prepare('INSERT INTO catering_packages (name, description, price_cents, unit, min_qty, serves) VALUES (?,?,?,?,?,?)').run(b.name, b.description || null, b.priceCents, b.unit, b.minQty, b.serves ?? null); audit(req.user, 'catering.package', b.name, clientIp(req)); res.json({ ok: true }); });
  staff.put('/catering-packages/:id', mgr, (req, res) => { const b = parse(pkgSchema, req.body); db.prepare('UPDATE catering_packages SET name=?, description=?, price_cents=?, unit=?, min_qty=?, serves=?, active=COALESCE(?, active) WHERE id=?').run(b.name, b.description || null, b.priceCents, b.unit, b.minQty, b.serves ?? null, b.active === undefined ? null : b.active ? 1 : 0, idParam(req)); res.json({ ok: true }); });
  app.get('/api/public/catering', publicLimiter, (req, res) => {
    const s = getSettings();
    res.json({ enabled: s.catering_online === '1', business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null, phone: s.business_phone || '' },
      currency: s.currency, leadHours: Number(s.catering_lead_hours || 48), depositPct: Number(s.catering_deposit_pct || 50), delivery: s.online_delivery === '1', deliveryFeeCents: Number(s.catering_delivery_cents || 0), minCents: Number(s.catering_min_cents || 0),
      packages: db.prepare('SELECT id, name, description, price_cents, unit, min_qty, serves FROM catering_packages WHERE active = 1 ORDER BY sort, id').all() });
  });
  app.post('/api/public/catering', h.orderLimiter || publicLimiter, wrap(async (req, res) => {
    const s = getSettings(); if (s.catering_online !== '1') throw err('Online catering orders are closed. Please call us.', 403);
    const b = parse(z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().email().max(120), phone: z.string().trim().min(7).max(30), when: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
      fulfillment: z.enum(['pickup', 'delivery']), address: z.string().trim().max(200).optional(), notes: z.string().trim().max(500).optional(), items: z.array(z.object({ id: z.number().int(), qty: z.number().int().min(1).max(10000) })).min(1).max(30) }), req.body);
    if (b.when < localStampNow(Number(s.catering_lead_hours || 48) * 60)) throw err(`Please order at least ${s.catering_lead_hours || 48} hours ahead`);
    if (b.fulfillment === 'delivery' && (!b.address || b.address.length < 8)) throw err('Enter the delivery address');
    const lines = b.items.map((it) => {
      const pk = db.prepare('SELECT * FROM catering_packages WHERE id = ? AND active = 1').get(it.id); if (!pk) throw err('A package is no longer available');
      if (it.qty < pk.min_qty) throw err(`${pk.name}: at least ${pk.min_qty}${pk.unit === 'person' ? ' people' : ''}`);
      return { name: `${pk.name}${pk.unit === 'person' ? ' (per person)' : ''}`, qty: it.qty, cents: pk.price_cents };
    });
    const sub = lines.reduce((a, l) => a + l.qty * l.cents, 0);
    if (sub < Number(s.catering_min_cents || 0)) throw err(`Catering orders start at ${fmt(Number(s.catering_min_cents))}`);
    const fee = b.fulfillment === 'delivery' ? Number(s.catering_delivery_cents || 0) : 0;
    const token = crypto.randomBytes(15).toString('base64url');
    const id = db.prepare("INSERT INTO invoices (token, title, customer_name, email, phone, event_date, event_notes, lines, tax_rate, deposit_pct, fee_cents, status, source, due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'sent', 'online', ?)")
      .run(token, `Catering, ${b.when.slice(0, 10)}`, b.name, b.email, b.phone, b.when.slice(0, 10), [`${b.fulfillment === 'delivery' ? 'Delivery to' : 'Pickup at'} ${b.when.slice(11)}${b.fulfillment === 'delivery' ? `: ${b.address}` : ''}`, b.notes].filter(Boolean).join('\n'), JSON.stringify(lines), Number(s.tax_rate), Number(s.catering_deposit_pct || 50), fee, b.when.slice(0, 10)).lastInsertRowid;
    audit(null, 'catering.online', `${b.name} ${fmt(sub)} for ${b.when}`, clientIp(req));
    pushToUsers(['manager', 'owner'], { title: `${s.business_name}: new catering order`, body: `${b.name}, ${fmt(sub)} for ${b.when}. Waiting for the deposit.`, tag: `cat-${id}`, url: '/catering' }).catch(() => {});
    const link = `${publicBase(req)}/i/${token}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`;
    if (emailEnabled()) emailGuest(b.email, { businessName: s.business_name, subject: 'Your catering order', message: `Hi ${b.name.split(' ')[0]},\n\nThanks for your catering order for ${b.when}. Open the link to review it and pay the deposit to lock in your date.`, link, accent: s.accent, button: 'Review and pay the deposit' }).catch(() => {});
    notifyStaff('invoices'); res.json({ link });
  }));

  /* ===== auto-built schedule ===== */
  staff.get('/schedule/auto', mgr, (req, res) => {
    const w = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : (() => { const t = localToday(); return addDays(t, (8 - dowOf(t)) % 7 || 7); })();
    res.json(proposeSchedule(w));
  });
  staff.post('/schedule/auto', mgr, (req, res) => {
    const b = parse(z.object({ shifts: z.array(z.object({ userId: z.number().int(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), area: z.string().max(24).nullable().optional() })).min(1).max(300) }), req.body);
    const ins = db.prepare('INSERT INTO schedule (user_id, start_local, end_local, role_note) VALUES (?, ?, ?, ?)');
    db.transaction(() => { for (const x of b.shifts) { if (x.end <= x.start) continue; if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(x.userId)) continue; ins.run(x.userId, `${x.date} ${x.start}`, `${x.date} ${x.end}`, x.area || 'Auto'); } })();
    audit(req.user, 'schedule.auto', `${b.shifts.length} shifts`, clientIp(req)); notifyStaff('shifts'); res.json({ ok: true, added: b.shifts.length });
  });

  /* ===== barcode stock counts ===== */
  staff.get('/ingredients/by-barcode/:code', mgr, (req, res) => {
    const code = String(req.params.code).replace(/[^\w-]/g, '').slice(0, 64);
    const g = db.prepare('SELECT id, name, unit, stock, low, par FROM ingredients WHERE barcode = ? AND active = 1').get(code);
    if (!g) return res.status(404).json({ error: 'No ingredient has that barcode yet', code });
    res.json(g);
  });
  staff.put('/ingredients/:id/barcode', mgr, (req, res) => {
    const b = parse(z.object({ code: z.string().trim().regex(/^[\w-]{3,64}$/).nullable() }), req.body);
    if (b.code) { const other = db.prepare('SELECT name FROM ingredients WHERE barcode = ? AND id <> ?').get(b.code, idParam(req)); if (other) throw err(`That barcode is already on ${other.name}`, 409); }
    db.prepare('UPDATE ingredients SET barcode = ? WHERE id = ?').run(b.code, idParam(req)); res.json({ ok: true });
  });
  staff.get('/count-list', mgr, (req, res) => res.json(db.prepare('SELECT id, name, unit, stock, barcode FROM ingredients WHERE active = 1 ORDER BY name').all()));

  /* ===== cook timers ===== */
  staff.put('/menu/:id/cook', mgr, (req, res) => { const b = parse(z.object({ minutes: z.number().int().min(0).max(240).nullable() }), req.body); db.prepare('UPDATE menu_items SET cook_minutes = ? WHERE id = ?').run(b.minutes, idParam(req)); notifyStaff('menu'); res.json({ ok: true }); });
  staff.get('/cook-times', (req, res) => res.json(Object.fromEntries(db.prepare('SELECT id, cook_minutes FROM menu_items WHERE cook_minutes IS NOT NULL').all().map((r) => [r.id, r.cook_minutes]))));

  /* ===== supplier price comparison ===== */
  h.notePrice = (ingredientId, supplierId, cents, source = 'delivery') => {
    if (!ingredientId || !supplierId || !(cents >= 0)) return;
    db.prepare("INSERT INTO ingredient_prices (ingredient_id, supplier_id, cost_cents, source, at) VALUES (?,?,?,?, datetime('now')) ON CONFLICT(ingredient_id, supplier_id) DO UPDATE SET cost_cents = excluded.cost_cents, source = excluded.source, at = excluded.at").run(ingredientId, supplierId, cents, source);
  };
  staff.get('/price-compare', mgr, (req, res) => {
    // learn from every received delivery
    for (const r of db.prepare("SELECT l.ingredient_id, p.supplier_id, l.cost_cents, p.received_at FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE p.status = 'received' ORDER BY p.received_at").all()) {
      const cur = db.prepare('SELECT at FROM ingredient_prices WHERE ingredient_id = ? AND supplier_id = ?').get(r.ingredient_id, r.supplier_id);
      if (!cur || cur.at < r.received_at) h.notePrice(r.ingredient_id, r.supplier_id, r.cost_cents, 'delivery');
    }
    const used = Object.fromEntries(db.prepare("SELECT ingredient_id, -SUM(delta) q FROM ingredient_moves WHERE delta < 0 AND at > datetime('now','-30 days') GROUP BY ingredient_id").all().map((r) => [r.ingredient_id, r.q]));
    const ings = db.prepare('SELECT id, name, unit, cost_cents, supplier_id FROM ingredients WHERE active = 1 ORDER BY name').all();
    const suppliers = db.prepare('SELECT id, name FROM suppliers WHERE active = 1 ORDER BY name').all();
    const rows = ings.map((g) => {
      const quotes = db.prepare('SELECT ip.*, s.name supplier FROM ingredient_prices ip JOIN suppliers s ON s.id = ip.supplier_id WHERE ip.ingredient_id = ? AND s.active = 1 ORDER BY ip.cost_cents').all(g.id);
      const best = quotes[0] || null; const curQ = quotes.find((q) => q.supplier_id === g.supplier_id);
      const save = best && curQ && best.supplier_id !== g.supplier_id ? Math.round((curQ.cost_cents - best.cost_cents) * (used[g.id] || 0)) : 0;
      return { id: g.id, name: g.name, unit: g.unit, supplierId: g.supplier_id, quotes: quotes.map((q) => ({ supplierId: q.supplier_id, supplier: q.supplier, cents: q.cost_cents, source: q.source, at: q.at })), best: best ? { supplierId: best.supplier_id, supplier: best.supplier, cents: best.cost_cents } : null, monthlyUse: Math.round((used[g.id] || 0) * 10) / 10, saveMonthCents: save };
    });
    res.json({ rows, suppliers, possibleSaveCents: rows.reduce((a, r) => a + Math.max(0, r.saveMonthCents), 0) });
  });
  staff.post('/price-compare/quote', mgr, (req, res) => { const b = parse(z.object({ ingredientId: z.number().int(), supplierId: z.number().int(), cents: z.number().min(0).max(1e6), note: z.string().trim().max(80).optional() }), req.body); h.notePrice(b.ingredientId, b.supplierId, b.cents, 'quote'); audit(req.user, 'price.quote', `ing ${b.ingredientId} sup ${b.supplierId} ${b.cents}`, clientIp(req)); res.json({ ok: true }); });
  staff.post('/price-compare/switch', mgr, (req, res) => {
    const b = parse(z.object({ ingredientId: z.number().int(), supplierId: z.number().int() }), req.body);
    const q = db.prepare('SELECT cost_cents FROM ingredient_prices WHERE ingredient_id = ? AND supplier_id = ?').get(b.ingredientId, b.supplierId);
    db.prepare('UPDATE ingredients SET supplier_id = ?, cost_cents = COALESCE(?, cost_cents) WHERE id = ?').run(b.supplierId, q?.cost_cents ?? null, b.ingredientId);
    audit(req.user, 'price.switch', `ing ${b.ingredientId} → sup ${b.supplierId}`, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
  });

  /* ===== supplier bills in the accounting export ===== */
  h.apJournal = apJournal;

  /* ===== review themes ===== */
  staff.get('/review-themes', mgr, (req, res) => res.json(reviewThemes(Math.min(365, Math.max(7, Number(req.query.days) || 90)))));

  /* ===== safe log (optional) ===== */
  const safeOn = () => { if (getSettings().safe_log_enabled !== '1') throw err('The safe log is turned off. An owner can turn it on in Settings.', 403); };
  staff.get('/safe', mgr, (req, res) => {
    safeOn();
    const rows = db.prepare('SELECT l.*, u.name by_name, w.name witness_name FROM safe_log l JOIN users u ON u.id = l.user_id LEFT JOIN users w ON w.id = l.witness_id ORDER BY l.id DESC LIMIT 100').all();
    res.json({ ...safeBalance(), rows, needWitness: getSettings().safe_two_person === '1' });
  });
  staff.post('/safe', mgr, wrap(async (req, res) => {
    safeOn();
    const b = parse(z.object({ kind: z.enum(['count', 'drop', 'to_bank', 'adjust']), amountCents: z.number().int().min(-10_000_000).max(10_000_000), note: z.string().trim().max(200).optional(), witnessPin: z.string().regex(/^\d{4,8}$/).optional() }), req.body);
    if (b.kind !== 'adjust' && b.amountCents < 0) throw err('Enter a positive amount');
    if (b.kind === 'adjust' && !b.note) throw err('Say why you are adjusting the safe');
    let witness = null;
    if (getSettings().safe_two_person === '1') {
      const ip = clientIp(req);
      if (loginBlocked(ip)) throw err('Too many wrong PINs. Wait a minute.', 429);
      if (!b.witnessPin) throw err('A second person needs to enter their PIN', 400);
      witness = await findUserByPin(b.witnessPin);
      if (!witness) { recordLoginFail(ip); throw err('That witness PIN is not right', 403); }
      clearLoginFails(ip);
      if (witness.id === req.user.id) throw err('The witness has to be someone else', 400);
    }
    const bal = safeBalance();
    db.prepare('INSERT INTO safe_log (kind, amount_cents, expected_cents, note, user_id, witness_id) VALUES (?,?,?,?,?,?)').run(b.kind, b.amountCents, b.kind === 'count' ? bal.expectedCents : null, b.note || null, req.user.id, witness?.id || null);
    if (b.kind === 'drop') { const cs = db.prepare('SELECT id FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get(); if (cs) db.prepare("INSERT INTO cash_moves (session_id, kind, amount_cents, reason, user_id) VALUES (?, 'out', ?, ?, ?)").run(cs.id, b.amountCents, 'Drop to safe', req.user.id); }
    const diff = b.kind === 'count' ? b.amountCents - bal.expectedCents : 0;
    if (b.kind === 'count' && Math.abs(diff) >= 100) pushToUsers(['owner'], { title: `${getSettings().business_name}: safe is ${diff > 0 ? 'over' : 'short'} ${fmt(Math.abs(diff))}`, body: `${req.user.name} counted ${fmt(b.amountCents)}, expected ${fmt(bal.expectedCents)}${witness ? `, witnessed by ${witness.name}` : ''}.`, tag: 'safe', url: '/safe' }).catch(() => {});
    audit(req.user, `safe.${b.kind}`, `${fmt(b.amountCents)}${witness ? ` witness ${witness.name}` : ''}${diff ? ` (${diff > 0 ? 'over' : 'short'} ${fmt(Math.abs(diff))})` : ''}`, clientIp(req));
    notifyStaff('safe'); notifyStaff('cash'); res.json({ ok: true, diffCents: diff });
  }));
}
