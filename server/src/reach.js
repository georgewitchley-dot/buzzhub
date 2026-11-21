// Round 6, batch J: allergens and diets, translated menus, accounting export, link hub with source tracking.
import fs from 'node:fs';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug } from './db.js';
import { dayBounds } from './ops.js';

export const ALLERGENS = ['milk', 'eggs', 'fish', 'shellfish', 'tree nuts', 'peanuts', 'wheat', 'soy', 'sesame'];
export const DIETS = ['vegetarian', 'vegan', 'gluten free', 'halal', 'kosher', 'spicy'];

registerSchema((db) => {
  const cols = db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name);
  for (const [c, d] of [['description', "TEXT"], ['allergens', "TEXT NOT NULL DEFAULT '[]'"], ['diet', "TEXT NOT NULL DEFAULT '[]'"], ['i18n', "TEXT NOT NULL DEFAULT '{}'"]]) if (!cols.includes(c)) db.exec(`ALTER TABLE menu_items ADD COLUMN ${c} ${d}`);
  db.exec(`CREATE TABLE IF NOT EXISTS link_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, target TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_link_hits ON link_hits(at);`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const csvCell = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');
const money = (c) => (c / 100).toFixed(2);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const parseJ = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };

/* ---------- daily books ---------- */
export function dailyBooks(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const { start, end } = dayBounds(d);
    const o = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents),0) sub, COALESCE(SUM(discount_cents),0) disc, COALESCE(SUM(tax_cents),0) tax, COALESCE(SUM(fee_cents),0) fee,
      COALESCE(SUM(tip_cents),0) tip, COALESCE(SUM(gift_cents),0) gift FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void'`).get(start, end);
    const byMethod = {};
    for (const r of db.prepare("SELECT payment_method m, subtotal_cents - discount_cents + tax_cents + COALESCE(fee_cents,0) + tip_cents - COALESCE(gift_cents,0) c FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void'").all(start, end)) {
      const k = String(r.m || 'other').split('+')[0] || 'other'; byMethod[k] = (byMethod[k] || 0) + r.c;
    }
    // other money in: gift cards sold, memberships, invoices, deposits (paid that day)
    const extra = db.prepare("SELECT kind, method, COALESCE(provider,'') provider, amount_cents + tip_cents c FROM payments WHERE status = 'paid' AND kind IN ('giftcard','membership','invoice','deposit') AND paid_at >= ? AND paid_at < ?").all(start, end);
    const giftSold = db.prepare("SELECT COALESCE(SUM(delta_cents),0) c FROM gift_txns WHERE delta_cents > 0 AND at >= ? AND at < ?").get(start, end).c;
    const sum = (k) => extra.filter((x) => x.kind === k).reduce((a, x) => a + x.c, 0);
    for (const x of extra.filter((e) => e.kind !== 'giftcard')) { const k = x.provider.startsWith('manual:') ? x.provider.slice(7) : x.method || 'card'; byMethod[k] = (byMethod[k] || 0) + x.c; }
    // register gift card sales are recorded on gift_txns with their own method
    for (const g of db.prepare("SELECT method, SUM(delta_cents) c FROM gift_txns WHERE delta_cents > 0 AND order_id IS NULL AND at >= ? AND at < ? GROUP BY method").all(start, end)) { const k = g.method || 'card'; byMethod[k] = (byMethod[k] || 0) + g.c; }
    const refunds = db.prepare('SELECT COALESCE(SUM(amount_cents),0) c FROM refunds WHERE at >= ? AND at < ?').get(start, end).c;
    out.push({ date: d, orders: o.n, grossCents: o.sub, discountCents: o.disc, netCents: o.sub - o.disc, taxCents: o.tax, deliveryCents: o.fee, tipsCents: o.tip, giftRedeemedCents: o.gift,
      giftSoldCents: giftSold, membershipCents: sum('membership'), invoiceCents: sum('invoice'), depositCents: sum('deposit'), refundsCents: refunds, byMethod });
  }
  return out;
}
const ACCT_DEFAULT = { sales: 'Sales', tax: 'Sales Tax Payable', tips: 'Tips Payable', gift: 'Gift Card Liability', delivery: 'Delivery Income', memberships: 'Membership Income', catering: 'Catering Income', deposits: 'Customer Deposits', refunds: 'Refunds', funds: 'Undeposited Funds' };

export function registerReach({ app, staff, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, publicBase, publicLimiter, notifyStaff } = h;
  const mgr = requireAuth('manager');

  /* ===== allergens, diets, Spanish names ===== */
  staff.get('/menu/details', mgr, (req, res) => res.json({ allergens: ALLERGENS, diets: DIETS, items: db.prepare('SELECT id, name, category, description, allergens, diet, i18n FROM menu_items WHERE active = 1 ORDER BY category, sort, id').all().map((m) => ({ ...m, allergens: parseJ(m.allergens, []), diet: parseJ(m.diet, []), i18n: parseJ(m.i18n, {}) })) }));
  staff.put('/menu/:id/details', mgr, (req, res) => {
    const b = parse(z.object({ description: z.string().trim().max(200).optional(), allergens: z.array(z.enum(ALLERGENS)).max(9), diet: z.array(z.enum(DIETS)).max(6), es: z.object({ name: z.string().trim().max(60).optional(), description: z.string().trim().max(200).optional(), category: z.string().trim().max(40).optional() }).optional(), fr: z.object({ name: z.string().trim().max(60).optional(), description: z.string().trim().max(200).optional(), category: z.string().trim().max(40).optional() }).optional(), zh: z.object({ name: z.string().trim().max(60).optional(), description: z.string().trim().max(200).optional(), category: z.string().trim().max(40).optional() }).optional(), vi: z.object({ name: z.string().trim().max(60).optional(), description: z.string().trim().max(200).optional(), category: z.string().trim().max(40).optional() }).optional() }), req.body);
    const id = idParam(req); const cur = db.prepare('SELECT i18n FROM menu_items WHERE id = ?').get(id); if (!cur) throw err('Not found', 404);
    const i18n = { ...parseJ(cur.i18n, {}) };
    for (const l of ['es', 'fr', 'zh', 'vi']) if (b[l]) i18n[l] = Object.fromEntries(Object.entries(b[l]).filter(([, v]) => v));
    db.prepare('UPDATE menu_items SET description = ?, allergens = ?, diet = ?, i18n = ? WHERE id = ?').run(b.description || null, JSON.stringify(b.allergens), JSON.stringify(b.diet), JSON.stringify(i18n), id);
    audit(req.user, 'menu.details', `item ${id}`, clientIp(req)); notifyStaff('menu'); res.json({ ok: true });
  });

  /* ===== accounting export ===== */
  staff.get('/accounting', requireAuth('owner'), (req, res) => {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const to = ok(req.query.to) ? req.query.to : addDays(localToday(), -1); const from = ok(req.query.from) ? req.query.from : addDays(to, -6);
    if (to < from) throw err('The end date is before the start date');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 370) throw err('Pick a year or less');
    const days = dailyBooks(from, to); const acct = { ...ACCT_DEFAULT, ...parseJ(getSettings().acct_map, {}) };
    const fmt = String(req.query.format || '');
    const methods = [...new Set(days.flatMap((d) => Object.keys(d.byMethod)))].sort();
    const send = (name, body) => { audit(req.user, 'accounting.export', `${fmt} ${from}..${to}`, clientIp(req)); res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}-${from}-to-${to}.csv"`); res.send(body); };
    // one balanced entry per day: money in (debits) = income, tax, tips, liabilities (credits)
    const entry = (d) => {
      const debits = Object.entries(d.byMethod).filter(([, c]) => c).map(([m, c]) => [acct.funds, c, `${m} payments`]);
      if (d.giftRedeemedCents) debits.push([acct.gift, d.giftRedeemedCents, 'Gift cards redeemed']);
      const credits = [[acct.sales, d.netCents, `Net sales, ${d.orders} orders`], [acct.tax, d.taxCents, 'Sales tax collected'], [acct.tips, d.tipsCents, 'Tips collected'], [acct.delivery, d.deliveryCents, 'Delivery fees'],
        [acct.gift, d.giftSoldCents, 'Gift cards sold'], [acct.memberships, d.membershipCents, 'Memberships'], [acct.catering, d.invoiceCents, 'Catering and invoices'], [acct.deposits, d.depositCents, 'Booking deposits']].filter((x) => x[1]);
      const diff = debits.reduce((a, x) => a + x[1], 0) - credits.reduce((a, x) => a + x[1], 0);
      if (diff) credits.push([acct.sales, diff, 'Rounding and other']);
      return { debits, credits };
    };
    if (fmt === 'quickbooks') {
      const rows = [['*JournalNo', '*JournalDate', '*AccountName', '*Debits', '*Credits', 'Description', 'Name', 'Memo']];
      days.forEach((d, i) => { const e = entry(d); const no = `BH${d.date.replace(/-/g, '')}`; void i;
        e.debits.forEach(([a, c, t]) => rows.push([no, d.date, a, money(c), '', t, '', 'BuzzHub daily sales']));
        e.credits.forEach(([a, c, t]) => rows.push([no, d.date, a, '', money(c), t, '', 'BuzzHub daily sales'])); });
      if (req.query.bills === '1') for (const j of h.apJournal?.(from, to) || []) j.lines.forEach(([ac, dr, cr, t]) => rows.push([j.no, j.date, ac, dr ? money(dr) : '', cr ? money(cr) : '', t, j.name, j.memo]));
      return send('quickbooks-journal', csv(rows));
    }
    if (fmt === 'xero') {
      const rows = [['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount']];
      days.forEach((d) => { const e = entry(d);
        e.debits.forEach(([a, c, t]) => rows.push([`BuzzHub sales ${d.date}`, d.date, t, a, 'Tax Exempt', money(c)]));
        e.credits.forEach(([a, c, t]) => rows.push([`BuzzHub sales ${d.date}`, d.date, t, a, 'Tax Exempt', money(-c)])); });
      if (req.query.bills === '1') for (const j of h.apJournal?.(from, to) || []) j.lines.forEach(([ac, dr, cr, t]) => rows.push([`${j.name} ${j.memo}`, j.date, t, ac, 'Tax Exempt', money(dr || -cr)]));
      return send('xero-manual-journal', csv(rows));
    }
    if (fmt === 'csv') {
      const head = ['Date', 'Orders', 'Gross sales', 'Discounts', 'Net sales', 'Sales tax', 'Delivery fees', 'Tips', 'Gift cards sold', 'Gift cards redeemed', 'Memberships', 'Catering/invoices', 'Deposits', 'Refunds', ...methods.map((m) => `Paid by ${m}`)];
      return send('daily-sales', csv([head, ...days.map((d) => [d.date, d.orders, money(d.grossCents), money(d.discountCents), money(d.netCents), money(d.taxCents), money(d.deliveryCents), money(d.tipsCents), money(d.giftSoldCents), money(d.giftRedeemedCents), money(d.membershipCents), money(d.invoiceCents), money(d.depositCents), money(d.refundsCents), ...methods.map((m) => money(d.byMethod[m] || 0))])]));
    }
    res.json({ from, to, days, methods, accounts: acct });
  });

  /* ===== link hub ===== */
  const SOURCES = ['instagram', 'facebook', 'tiktok', 'google', 'x', 'website', 'qr', 'email', 'other'];
  app.get('/api/public/links', publicLimiter, (req, res) => {
    const s = getSettings(); const l = currentSlug() === 'main' ? '' : `l=${currentSlug()}`;
    const q = (p) => `${p}${l ? `${p.includes('?') ? '&' : '?'}${l}` : ''}`;
    const links = [];
    if (s.business_type !== 'service') links.push({ key: 'join', label: s.business_type === 'restaurant' ? 'Join the waitlist' : 'Get in line', url: q('/join') });
    if (s.booking_enabled === '1') links.push({ key: 'book', label: s.business_type === 'restaurant' ? 'Book a table' : 'Book an appointment', url: q('/account?book=1') });
    if (s.online_enabled === '1') links.push({ key: 'order', label: s.online_delivery === '1' && s.online_pickup === '1' ? 'Order pickup or delivery' : s.online_delivery === '1' ? 'Order delivery' : 'Order for pickup', url: q('/order') });
    links.push({ key: 'menu', label: 'See the menu', url: q('/order?view=menu') });
    if (db.prepare('SELECT 1 FROM membership_plans WHERE active = 1').get()) links.push({ key: 'members', label: 'Memberships', url: q('/account?plans=1') });
    links.push({ key: 'gift', label: 'Buy a gift card', url: q('/gift') });
    if (s.review_url) links.push({ key: 'review', label: 'Leave us a review', url: s.review_url });
    res.json({ business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null, welcome: s.welcome_message, address: s.business_address || '', phone: s.business_phone || '' }, links });
  });
  app.post('/api/public/hit', publicLimiter, (req, res) => {
    const b = z.object({ src: z.string().max(20), target: z.string().max(20) }).safeParse(req.body);
    if (b.success) db.prepare('INSERT INTO link_hits (src, target) VALUES (?, ?)').run(SOURCES.includes(b.data.src) ? b.data.src : 'other', b.data.target.replace(/[^a-z]/g, '').slice(0, 20) || 'view');
    res.json({ ok: true });
  });
  staff.get('/links', mgr, wrap(async (req, res) => {
    const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `&l=${currentSlug()}`;
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const rows = db.prepare("SELECT src, target, COUNT(*) n FROM link_hits WHERE at > datetime('now', ?) GROUP BY src, target").all(`-${days} days`);
    const bySrc = {};
    for (const r of rows) { const x = bySrc[r.src] || (bySrc[r.src] = { src: r.src, visits: 0, clicks: {} }); if (r.target === 'view') x.visits += r.n; else x.clicks[r.target] = (x.clicks[r.target] || 0) + r.n; }
    const links = await Promise.all(SOURCES.filter((s) => s !== 'other').map(async (src) => { const url = `${base}/go?src=${src}${l}`; return { src, url, svg: src === 'qr' ? await QRCode.toString(url, { type: 'svg', margin: 1 }) : null }; }));
    res.json({ links, stats: Object.values(bySrc).sort((a, b) => b.visits - a.visits), days });
  }));

  /* server-rendered tags on the link hub so Google and social previews show the business */
  h.linkHubHtml = (DIST) => (req, res) => {
    const s = getSettings(); const base = publicBase(req);
    let html = fs.readFileSync(`${DIST}/index.html`, 'utf8');
    const esc = (v) => String(v || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const type = s.business_type === 'restaurant' ? 'Restaurant' : s.business_type === 'cafe' ? 'CafeOrCoffeeShop' : s.business_type === 'salon' ? 'BeautySalon' : s.business_type === 'clinic' ? 'MedicalClinic' : 'LocalBusiness';
    const ld = { '@context': 'https://schema.org', '@type': type, name: s.business_name, url: `${base}/go`, ...(s.business_address ? { address: s.business_address } : {}), ...(s.business_phone ? { telephone: s.business_phone } : {}),
      ...(s.logo_version !== '0' ? { logo: `${base}/api/public/logo?v=${s.logo_version}` } : {}),
      potentialAction: [s.online_enabled === '1' ? { '@type': 'OrderAction', target: `${base}/order` } : null, s.booking_enabled === '1' ? { '@type': 'ReserveAction', target: `${base}/account?book=1` } : null].filter(Boolean),
      ...(s.business_type === 'restaurant' || s.business_type === 'cafe' ? { hasMenu: `${base}/order?view=menu` } : {}) };
    const tags = `<title>${esc(s.business_name)}</title><meta name="description" content="${esc(s.welcome_message || `Order, book and join the line at ${s.business_name}.`)}"><meta property="og:title" content="${esc(s.business_name)}"><meta property="og:description" content="${esc(s.welcome_message || '')}"><meta property="og:url" content="${esc(`${base}/go`)}">${s.logo_version !== '0' ? `<meta property="og:image" content="${esc(`${base}/api/public/logo?v=${s.logo_version}`)}">` : ''}<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
    html = html.replace(/<title>[^<]*<\/title>/, '').replace('</head>', `${tags}</head>`);
    res.type('html').send(html);
  };
}
