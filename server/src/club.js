// Round 6, batch I: memberships, catering quotes and invoices, wallet cards (web, Google Wallet, Apple Wallet).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, localToday, currentSlug, forEachLocation } from './db.js';
import { pushToCustomer, emailEnabled, emailGuest } from './notify.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS membership_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, price_cents INTEGER NOT NULL, period TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('month','year')),
  discount_pct REAL NOT NULL DEFAULT 0, perk_name TEXT, perk_qty INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, plan_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','past_due','cancelled')),
  current_until TEXT, perks_used INTEGER NOT NULL DEFAULT 0, cancel_at_end INTEGER NOT NULL DEFAULT 0, renewal_payment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_customer ON memberships(customer_id);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, title TEXT NOT NULL, customer_name TEXT NOT NULL, email TEXT, phone TEXT,
  event_date TEXT, event_notes TEXT, lines TEXT NOT NULL DEFAULT '[]', tax_rate REAL NOT NULL DEFAULT 0, deposit_pct REAL NOT NULL DEFAULT 0, fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','deposit_paid','paid','cancelled')),
  accepted_name TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, accepted_at TEXT, paid_at TEXT, due_date TEXT
);
CREATE TABLE IF NOT EXISTS invoice_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, method TEXT NOT NULL, note TEXT, payment_id INTEGER, user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('customers').includes('card_token')) db.exec('ALTER TABLE customers ADD COLUMN card_token TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_card ON customers(card_token)');
  if (!cols('gift_cards').includes('wallet_token')) db.exec('ALTER TABLE gift_cards ADD COLUMN wallet_token TEXT');
  const o = cols('orders');
  if (!o.includes('customer_id')) db.exec('ALTER TABLE orders ADD COLUMN customer_id INTEGER');
  if (!o.includes('allergy_note')) db.exec('ALTER TABLE orders ADD COLUMN allergy_note TEXT');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fmt = (c) => `$${(c / 100).toFixed(2)}`;
const tok = () => crypto.randomBytes(15).toString('base64url');
const addPeriod = (date, period) => { const d = new Date(`${date}T12:00:00Z`); if (period === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/* ---------------- memberships ---------------- */
export function activeMembership(customerId) {
  if (!customerId) return null;
  const m = db.prepare("SELECT m.*, p.name plan_name, p.discount_pct, p.perk_name, p.perk_qty, p.period, p.price_cents FROM memberships m JOIN membership_plans p ON p.id = m.plan_id WHERE m.customer_id = ? AND m.status IN ('active','past_due') ORDER BY m.id DESC LIMIT 1").get(customerId);
  if (!m) return null;
  return { ...m, perksLeft: Math.max(0, m.perk_qty - m.perks_used), good: m.status === 'active' && m.current_until >= localToday() };
}
function activate(m) {
  const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(m.plan_id);
  const today = localToday();
  const from = m.status === 'active' && m.current_until && m.current_until >= today ? m.current_until : today;
  db.prepare("UPDATE memberships SET status = 'active', current_until = ?, perks_used = 0, renewal_payment_id = NULL, started_at = COALESCE(started_at, ?) WHERE id = ?").run(addPeriod(from, plan.period), today, m.id);
}

/* ---------------- invoices ---------------- */
export function invoiceTotals(inv) {
  const lines = JSON.parse(inv.lines || '[]');
  const subtotal = lines.reduce((a, l) => a + Math.round(l.qty * l.cents), 0);
  const tax = Math.round(subtotal * inv.tax_rate / 100);
  const total = subtotal + tax + (inv.fee_cents || 0);
  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) c FROM invoice_payments WHERE invoice_id = ?').get(inv.id).c;
  const deposit = Math.round(total * inv.deposit_pct / 100);
  return { lines, subtotalCents: subtotal, taxCents: tax, feeCents: inv.fee_cents || 0, totalCents: total, depositCents: deposit, paidCents: paid, dueCents: Math.max(0, total - paid), depositDueCents: Math.max(0, deposit - paid) };
}
function recordInvoicePayment(inv, cents, method, note, paymentId, userId) {
  db.prepare('INSERT INTO invoice_payments (invoice_id, amount_cents, method, note, payment_id, user_id) VALUES (?,?,?,?,?,?)').run(inv.id, cents, method, note || null, paymentId || null, userId || null);
  const t = invoiceTotals(inv);
  const status = t.dueCents <= 0 ? 'paid' : t.paidCents >= t.depositCents && t.depositCents > 0 ? 'deposit_paid' : inv.status === 'draft' ? 'sent' : inv.status;
  db.prepare("UPDATE invoices SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE paid_at END WHERE id = ?").run(status, status, inv.id);
  return status;
}

/* ---------------- wallet ---------------- */
const here = path.dirname(fileURLToPath(import.meta.url));
const iconPath = [path.join(here, '../../client/dist/icon-192.png'), path.join(here, '../../client/public/icon-192.png')].find((p) => fs.existsSync(p));
function customerCardToken(id) {
  const c = db.prepare('SELECT card_token FROM customers WHERE id = ?').get(id);
  if (c?.card_token) return c.card_token;
  const t = tok(); db.prepare('UPDATE customers SET card_token = ? WHERE id = ?').run(t, id); return t;
}
function giftWalletToken(cardId) {
  const c = db.prepare('SELECT wallet_token FROM gift_cards WHERE id = ?').get(cardId);
  if (c?.wallet_token) return c.wallet_token;
  const t = tok(); db.prepare('UPDATE gift_cards SET wallet_token = ? WHERE id = ?').run(t, cardId); return t;
}
export function findByScan(value) {
  const v = String(value || '').trim();
  const m = /^BH-C-([A-Za-z0-9_-]{16,30})$/.exec(v);
  if (m) return db.prepare('SELECT * FROM customers WHERE card_token = ?').get(m[1]) || null;
  return null;
}
function walletCard(t) {
  if (!/^[A-Za-z0-9_-]{16,30}$/.test(t || '')) return null;
  const s = getSettings();
  const c = db.prepare('SELECT * FROM customers WHERE card_token = ?').get(t);
  if (c) {
    const m = activeMembership(c.id);
    const reward = db.prepare("SELECT title, code FROM rewards WHERE customer_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(c.id);
    const every = Number(s.loyalty_every) || 0;
    return { kind: 'member', token: t, title: s.business_name, name: c.name, qr: `BH-C-${t}`, accent: s.accent,
      fields: [m ? { label: 'Membership', value: `${m.plan_name}${m.good ? '' : ' (renew)'}` } : null, m?.perk_qty ? { label: m.perk_name || 'Perks', value: `${m.perksLeft} of ${m.perk_qty} left` } : null,
        s.loyalty_enabled === '1' && every ? { label: 'Visits', value: `${(c.visits || 0) % every} of ${every} to your next reward` } : null, reward ? { label: 'Reward ready', value: reward.title } : null].filter(Boolean) };
  }
  const g = db.prepare('SELECT * FROM gift_cards WHERE wallet_token = ?').get(t);
  if (g) return { kind: 'gift', token: t, title: `${s.business_name} gift card`, name: g.name || 'Gift card', qr: g.code, accent: s.accent, fields: [{ label: 'Balance', value: fmt(g.balance_cents) }, { label: 'Card', value: g.code }] };
  return null;
}
const google = () => {
  const issuer = process.env.GOOGLE_WALLET_ISSUER_ID; const raw = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT;
  if (!issuer || !raw) return null;
  try { const sa = JSON.parse(raw); return sa.client_email && sa.private_key ? { issuer, sa } : null; } catch { return null; }
};
const apple = () => {
  const e = process.env;
  return e.APPLE_PASS_TYPE_ID && e.APPLE_TEAM_ID && e.APPLE_PASS_CERT && e.APPLE_PASS_KEY && e.APPLE_WWDR_CERT ? e : null;
};
export const walletStatus = () => ({ google: Boolean(google()), apple: Boolean(apple()) });
function googleSaveUrl(card, base) {
  const g = google(); if (!g) return null;
  const slug = currentSlug(); const classId = `${g.issuer}.buzzhub_${slug.replace(/[^a-z0-9_]/g, '_')}`;
  const objectId = `${g.issuer}.${slug}_${card.token}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const token = jwt.sign({
    iss: g.sa.client_email, aud: 'google', typ: 'savetowallet', origins: [base],
    payload: {
      genericClasses: [{ id: classId }],
      genericObjects: [{
        id: objectId, classId, state: 'ACTIVE', hexBackgroundColor: card.accent,
        cardTitle: { defaultValue: { language: 'en', value: card.title.slice(0, 60) } },
        header: { defaultValue: { language: 'en', value: card.name.slice(0, 60) } },
        barcode: { type: 'QR_CODE', value: card.qr },
        textModulesData: card.fields.map((f, i) => ({ id: `f${i}`, header: f.label, body: f.value })),
        linksModuleData: { uris: [{ uri: `${base}/w/${card.token}`, description: 'Open my card' }] },
      }],
    },
  }, g.sa.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}
async function applePass(card, base) {
  const e = apple(); if (!e) throw err('Apple Wallet is not set up', 404);
  const { PKPass } = await import('passkit-generator');
  const icon = iconPath ? fs.readFileSync(iconPath) : Buffer.alloc(0);
  const hex = card.accent.replace('#', '');
  const rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;
  const passJson = {
    formatVersion: 1, passTypeIdentifier: e.APPLE_PASS_TYPE_ID, teamIdentifier: e.APPLE_TEAM_ID, serialNumber: `${currentSlug()}-${card.token}`,
    organizationName: getSettings().business_name, description: card.title, backgroundColor: rgb, foregroundColor: 'rgb(20,20,24)', labelColor: 'rgb(40,40,48)',
    storeCard: { primaryFields: [{ key: 'name', label: card.kind === 'gift' ? 'Gift card' : 'Member', value: card.name }], secondaryFields: card.fields.slice(0, 3).map((f, i) => ({ key: `f${i}`, label: f.label, value: f.value })), backFields: [{ key: 'link', label: 'Your card online', value: `${base}/w/${card.token}` }] },
    barcodes: [{ format: 'PKBarcodeFormatQR', message: card.qr, messageEncoding: 'iso-8859-1' }],
  };
  const pass = new PKPass({ 'pass.json': Buffer.from(JSON.stringify(passJson)), 'icon.png': icon, 'icon@2x.png': icon, 'logo.png': icon }, {
    wwdr: e.APPLE_WWDR_CERT.replace(/\\n/g, '\n'), signerCert: e.APPLE_PASS_CERT.replace(/\\n/g, '\n'), signerKey: e.APPLE_PASS_KEY.replace(/\\n/g, '\n'), signerKeyPassphrase: e.APPLE_PASS_KEY_PASSPHRASE || undefined,
  });
  return pass.getAsBuffer();
}

export function registerClub({ app, staff, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, requireCustomer, publicBase, publicLimiter, notifyStaff } = h;
  const mgr = requireAuth('manager');
  h.activeMembership = activeMembership; h.findByScan = findByScan;
  /** member pricing at the register: their plan's percent off */
  h.memberDiscount = (customerId, subtotal) => { const m = activeMembership(customerId); return m?.good && m.discount_pct > 0 ? { cents: Math.round(subtotal * m.discount_pct / 100), pct: m.discount_pct, plan: m.plan_name } : null; };

  h.payHooks = h.payHooks || {};
  h.payHooks.membership = (p) => {
    const meta = JSON.parse(p.meta || '{}'); const m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(meta.membershipId);
    if (!m) return; activate(m);
    audit(null, 'member.paid', `membership ${m.id} ${fmt(p.amount_cents)}`, null); notifyStaff('members');
  };
  h.payHooks.invoice = (p) => {
    const meta = JSON.parse(p.meta || '{}'); const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(meta.invoiceId);
    if (!inv) return; const st = recordInvoicePayment(inv, p.amount_cents, p.method || p.provider || 'online', meta.part, p.id, null);
    audit(null, 'invoice.paid', `${inv.title}: ${fmt(p.amount_cents)} (${st})`, null); notifyStaff('invoices');
    h.alertOwners?.(`${getSettings().business_name}: invoice payment`, `${inv.customer_name} paid ${fmt(p.amount_cents)} on "${inv.title}".`, 'invoice');
  };

  /* ===== plans + members (staff) ===== */
  const planSchema = z.object({ name: z.string().trim().min(1).max(50), description: z.string().trim().max(200).optional(), priceCents: z.number().int().min(100).max(1000000), period: z.enum(['month', 'year']), discountPct: z.number().min(0).max(50).default(0), perkName: z.string().trim().max(40).optional(), perkQty: z.number().int().min(0).max(100).default(0) });
  staff.get('/memberships', mgr, (req, res) => {
    const plans = db.prepare('SELECT p.*, (SELECT COUNT(*) FROM memberships m WHERE m.plan_id = p.id AND m.status = \'active\') members FROM membership_plans p ORDER BY p.active DESC, p.price_cents').all();
    const members = db.prepare('SELECT m.*, c.name, c.email, p.name plan_name, p.price_cents, p.period, p.perk_qty, p.perk_name FROM memberships m JOIN customers c ON c.id = m.customer_id JOIN membership_plans p ON p.id = m.plan_id WHERE m.status <> \'pending\' OR m.created_at > datetime(\'now\',\'-1 day\') ORDER BY m.status, c.name LIMIT 500').all();
    const monthly = members.filter((m) => m.status === 'active').reduce((a, m) => a + (m.period === 'year' ? Math.round(m.price_cents / 12) : m.price_cents), 0);
    res.json({ plans, members, monthlyCents: monthly });
  });
  staff.post('/membership-plans', mgr, (req, res) => {
    const b = parse(planSchema, req.body);
    const id = db.prepare('INSERT INTO membership_plans (name, description, price_cents, period, discount_pct, perk_name, perk_qty) VALUES (?,?,?,?,?,?,?)').run(b.name, b.description || null, b.priceCents, b.period, b.discountPct, b.perkName || null, b.perkQty).lastInsertRowid;
    audit(req.user, 'plan.create', `${b.name} ${fmt(b.priceCents)}/${b.period}`, clientIp(req)); res.json({ id });
  });
  staff.put('/membership-plans/:id', mgr, (req, res) => {
    const b = parse(planSchema.extend({ active: z.boolean().optional() }), req.body);
    db.prepare('UPDATE membership_plans SET name=?, description=?, price_cents=?, period=?, discount_pct=?, perk_name=?, perk_qty=?, active=COALESCE(?, active) WHERE id=?').run(b.name, b.description || null, b.priceCents, b.period, b.discountPct, b.perkName || null, b.perkQty, b.active === undefined ? null : b.active ? 1 : 0, idParam(req));
    audit(req.user, 'plan.edit', b.name, clientIp(req)); res.json({ ok: true });
  });
  // sell at the counter for cash or card on your own terminal
  staff.post('/memberships', (req, res) => {
    const b = parse(z.object({ customerId: z.number().int(), planId: z.number().int(), method: z.enum(['cash', 'card', 'other']) }), req.body);
    const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND active = 1').get(b.planId); if (!plan) throw err('Pick a plan');
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customerId)) throw err('Customer not found', 404);
    let m = db.prepare("SELECT * FROM memberships WHERE customer_id = ? AND status IN ('active','past_due','pending') ORDER BY id DESC LIMIT 1").get(b.customerId);
    if (!m || m.plan_id !== plan.id) { if (m) db.prepare("UPDATE memberships SET status = 'cancelled' WHERE id = ?").run(m.id); m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(db.prepare('INSERT INTO memberships (customer_id, plan_id) VALUES (?, ?)').run(b.customerId, plan.id).lastInsertRowid); }
    activate(m);
    db.prepare("INSERT INTO payments (kind, amount_cents, method, status, label, meta, user_id, paid_at) VALUES ('membership', ?, ?, 'paid', ?, ?, ?, datetime('now'))").run(plan.price_cents, b.method, `${plan.name} membership`, JSON.stringify({ membershipId: m.id }), req.user.id);
    if (b.method === 'cash') { const cs = db.prepare('SELECT id FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get(); if (cs) db.prepare("INSERT INTO cash_moves (session_id, kind, amount_cents, reason, user_id) VALUES (?, 'in', ?, ?, ?)").run(cs.id, plan.price_cents, `${plan.name} membership`, req.user.id); }
    audit(req.user, 'member.sell', `${plan.name} to customer ${b.customerId} (${b.method})`, clientIp(req)); notifyStaff('members'); res.json(activeMembership(b.customerId));
  });
  staff.post('/memberships/:id/perk', (req, res) => {
    const m = db.prepare("SELECT m.*, p.perk_qty, p.perk_name FROM memberships m JOIN membership_plans p ON p.id = m.plan_id WHERE m.id = ? AND m.status = 'active'").get(idParam(req));
    if (!m) throw err('This membership is not active', 409);
    if (m.perks_used >= m.perk_qty) throw err(`No ${m.perk_name || 'perks'} left this period`, 409);
    db.prepare('UPDATE memberships SET perks_used = perks_used + 1 WHERE id = ?').run(m.id);
    audit(req.user, 'member.perk', `${m.perk_name} for membership ${m.id}`, clientIp(req)); res.json({ left: m.perk_qty - m.perks_used - 1 });
  });
  staff.post('/memberships/:id/cancel', mgr, (req, res) => {
    db.prepare("UPDATE memberships SET status = 'cancelled' WHERE id = ?").run(idParam(req)); audit(req.user, 'member.cancel', `membership ${req.params.id}`, clientIp(req)); res.json({ ok: true });
  });
  // find a customer at the register: name, email, phone, or a scanned wallet card
  staff.get('/customer-search', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return res.json([]);
    const scanned = findByScan(q);
    const rows = scanned ? [scanned] : db.prepare("SELECT * FROM customers WHERE name LIKE ? OR email LIKE ? OR REPLACE(REPLACE(REPLACE(phone,'-',''),' ',''),'(','') LIKE ? ORDER BY visits DESC LIMIT 8").all(`%${q}%`, `%${q}%`, `%${q.replace(/\D/g, '') || '~'}%`);
    res.json(rows.map((c) => { const m = activeMembership(c.id); let tags = []; try { tags = JSON.parse(c.tags || '[]'); } catch { /* none */ } return { id: c.id, name: c.name, email: c.email, phone: c.phone, visits: c.visits || 0, tags, member: m ? { id: m.id, plan: m.plan_name, good: m.good, discountPct: m.discount_pct, perkName: m.perk_name, perksLeft: m.perksLeft, until: m.current_until } : null }; }));
  });

  /* ===== memberships (customers) ===== */
  app.get('/api/c/plans', requireCustomer, (req, res) => {
    const plans = db.prepare('SELECT id, name, description, price_cents, period, discount_pct, perk_name, perk_qty FROM membership_plans WHERE active = 1 ORDER BY price_cents').all();
    const m = activeMembership(req.customer.id) || db.prepare("SELECT m.*, p.name plan_name FROM memberships m JOIN membership_plans p ON p.id = m.plan_id WHERE m.customer_id = ? AND m.status = 'pending' ORDER BY m.id DESC LIMIT 1").get(req.customer.id) || null;
    res.json({ plans, membership: m, payOnline: h.onlinePayEnabled?.() || false, currency: getSettings().currency });
  });
  app.post('/api/c/memberships', requireCustomer, wrap(async (req, res) => {
    const { planId } = parse(z.object({ planId: z.number().int() }), req.body);
    const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND active = 1').get(planId); if (!plan) throw err('That plan is not available');
    if (!h.onlinePayEnabled?.()) throw err('Online payments are not set up yet. Join at the counter.', 503);
    const cur = activeMembership(req.customer.id); if (cur?.good) throw err('You already have a membership', 409);
    db.prepare("UPDATE memberships SET status = 'cancelled' WHERE customer_id = ? AND status = 'pending'").run(req.customer.id);
    const mid = db.prepare('INSERT INTO memberships (customer_id, plan_id) VALUES (?, ?)').run(req.customer.id, plan.id).lastInsertRowid;
    const pid = db.prepare("INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('membership', ?, 'card', ?, ?)").run(plan.price_cents, `${plan.name} membership`, JSON.stringify({ membershipId: mid })).lastInsertRowid;
    const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `?l=${currentSlug()}`;
    res.json({ url: h.startPay(pid, { base, lines: [{ name: `${getSettings().business_name}: ${plan.name} (1 ${plan.period})`, cents: plan.price_cents }], successUrl: `${base}/account${l}`, cancelUrl: `${base}/account${l}`, email: req.customer.email, descr: `${plan.name} membership` }) });
  }));
  app.post('/api/c/memberships/cancel', requireCustomer, (req, res) => {
    const m = activeMembership(req.customer.id); if (!m) throw err('No membership to cancel', 404);
    db.prepare('UPDATE memberships SET cancel_at_end = 1 WHERE id = ?').run(m.id);
    audit(null, 'member.cancel_end', `${req.customer.name}`, clientIp(req)); res.json({ ok: true, until: m.current_until });
  });
  // renewals: 3 days before the end, send a pay link; lapse after the end date
  async function renewals() {
    const today = localToday(); const s = getSettings();
    for (const m of db.prepare("SELECT m.*, p.name plan_name, p.price_cents, p.period, c.email, c.name cname FROM memberships m JOIN membership_plans p ON p.id = m.plan_id JOIN customers c ON c.id = m.customer_id WHERE m.status IN ('active','past_due') AND m.current_until <= ?").all(addDays(today, 3))) {
      if (m.cancel_at_end) { if (m.current_until < today) db.prepare("UPDATE memberships SET status = 'cancelled' WHERE id = ?").run(m.id); continue; }
      if (m.current_until < today && m.status === 'active') db.prepare("UPDATE memberships SET status = 'past_due' WHERE id = ?").run(m.id);
      if (m.renewal_payment_id || !h.onlinePayEnabled?.()) continue;
      const pid = db.prepare("INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('membership', ?, 'card', ?, ?)").run(m.price_cents, `${m.plan_name} renewal`, JSON.stringify({ membershipId: m.id, renew: true })).lastInsertRowid;
      const base = process.env.PUBLIC_URL?.replace(/\/$/, '') || '';
      const url = h.startPay(pid, { base, lines: [{ name: `${s.business_name}: ${m.plan_name} renewal`, cents: m.price_cents }], successUrl: `${base}/account`, cancelUrl: `${base}/account`, email: m.email, descr: `${m.plan_name} renewal` });
      db.prepare('UPDATE memberships SET renewal_payment_id = ? WHERE id = ?').run(pid, m.id);
      const msg = `Your ${m.plan_name} membership renews on ${m.current_until}. Tap to renew for ${fmt(m.price_cents)}.`;
      pushToCustomer(m.customer_id, { title: `${s.business_name}: time to renew`, body: msg, tag: 'renew', url: url.replace(base, '') }).catch(() => {});
      if (emailEnabled() && m.email) emailGuest(m.email, { businessName: s.business_name, subject: `Renew your ${m.plan_name} membership`, message: msg, link: url, accent: s.accent, button: 'Renew now' }).catch(() => {});
    }
  }
  setInterval(() => forEachLocation(() => renewals().catch((e) => console.error('renewals', e.message))), 60 * 60_000).unref();
  setTimeout(() => forEachLocation(() => renewals().catch(() => {})), 20_000).unref();

  /* ===== catering quotes and invoices ===== */
  const invSchema = z.object({
    title: z.string().trim().min(1).max(80), customerName: z.string().trim().min(1).max(80), email: z.string().trim().email().max(120).optional().or(z.literal('')), phone: z.string().trim().max(30).optional(),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), eventNotes: z.string().trim().max(500).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
    lines: z.array(z.object({ name: z.string().trim().min(1).max(80), qty: z.number().min(0.01).max(10000), cents: z.number().int().min(0).max(10000000) })).min(1).max(60),
    taxRate: z.number().min(0).max(30), depositPct: z.number().min(0).max(100), feeCents: z.number().int().min(0).max(1000000).default(0),
  });
  const view = (inv, base) => ({ ...inv, ...invoiceTotals(inv), link: base ? `${base}/i/${inv.token}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}` : undefined, payments: db.prepare('SELECT amount_cents, method, note, at FROM invoice_payments WHERE invoice_id = ? ORDER BY id').all(inv.id) });
  staff.get('/invoices', mgr, (req, res) => res.json({ invoices: db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 200').all().map((i) => view(i, publicBase(req))), emailEnabled: emailEnabled(), payOnline: h.onlinePayEnabled?.() || false }));
  staff.post('/invoices', mgr, (req, res) => {
    const b = parse(invSchema, req.body);
    const id = db.prepare('INSERT INTO invoices (token, title, customer_name, email, phone, event_date, event_notes, lines, tax_rate, deposit_pct, fee_cents, due_date, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(tok(), b.title, b.customerName, b.email || null, b.phone || null, b.eventDate || null, b.eventNotes || null, JSON.stringify(b.lines), b.taxRate, b.depositPct, b.feeCents, b.dueDate || null, req.user.id).lastInsertRowid;
    audit(req.user, 'invoice.create', b.title, clientIp(req)); res.json(view(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id), publicBase(req)));
  });
  staff.put('/invoices/:id', mgr, (req, res) => {
    const b = parse(invSchema, req.body); const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(idParam(req));
    if (!inv || ['paid', 'cancelled'].includes(inv.status)) throw err('This invoice is closed', 409);
    db.prepare('UPDATE invoices SET title=?, customer_name=?, email=?, phone=?, event_date=?, event_notes=?, lines=?, tax_rate=?, deposit_pct=?, fee_cents=?, due_date=? WHERE id=?')
      .run(b.title, b.customerName, b.email || null, b.phone || null, b.eventDate || null, b.eventNotes || null, JSON.stringify(b.lines), b.taxRate, b.depositPct, b.feeCents, b.dueDate || null, inv.id);
    audit(req.user, 'invoice.edit', b.title, clientIp(req)); res.json({ ok: true });
  });
  staff.post('/invoices/:id/send', mgr, wrap(async (req, res) => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(idParam(req)); if (!inv) throw err('Not found', 404);
    const v = view(inv, publicBase(req)); const s = getSettings(); let emailed = false;
    if (inv.email && emailEnabled()) {
      const r = await emailGuest(inv.email, { businessName: s.business_name, subject: `${inv.status === 'draft' ? 'Quote' : 'Invoice'}: ${inv.title}`, message: `Hi ${inv.customer_name},\n\nHere is your ${inv.title} for ${fmt(v.totalCents)}${v.depositCents ? `, with a ${fmt(v.depositCents)} deposit to confirm` : ''}. Review it and pay securely at the link below.`, link: v.link, accent: s.accent, button: 'View and pay' }).catch(() => ({ ok: false }));
      emailed = r.ok;
    }
    db.prepare("UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = datetime('now') WHERE id = ?").run(inv.id);
    audit(req.user, 'invoice.send', `${inv.title}${emailed ? ' (emailed)' : ''}`, clientIp(req)); res.json({ ok: true, emailed, link: v.link });
  }));
  staff.post('/invoices/:id/payment', mgr, (req, res) => {
    const b = parse(z.object({ cents: z.number().int().min(1).max(100000000), method: z.enum(['cash', 'check', 'card', 'bank', 'other']), note: z.string().trim().max(80).optional() }), req.body);
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(idParam(req)); if (!inv || inv.status === 'cancelled') throw err('This invoice is closed', 409);
    const st = recordInvoicePayment(inv, b.cents, b.method, b.note, null, req.user.id);
    audit(req.user, 'invoice.payment', `${inv.title}: ${fmt(b.cents)} ${b.method}`, clientIp(req)); res.json({ ok: true, status: st });
  });
  staff.post('/invoices/:id/cancel', mgr, (req, res) => { db.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ? AND status <> 'paid'").run(idParam(req)); audit(req.user, 'invoice.cancel', `#${req.params.id}`, clientIp(req)); res.json({ ok: true }); });

  const invByToken = (t) => (/^[A-Za-z0-9_-]{16,30}$/.test(t || '') ? db.prepare("SELECT * FROM invoices WHERE token = ? AND status <> 'draft'").get(t) : null);
  app.get('/api/i/:token', publicLimiter, (req, res) => {
    const inv = invByToken(req.params.token); if (!inv) return res.status(404).json({ error: 'This quote link is not valid.' });
    const s = getSettings(); const v = view(inv);
    res.json({ title: inv.title, customerName: inv.customer_name, eventDate: inv.event_date, eventNotes: inv.event_notes, dueDate: inv.due_date, status: inv.status, acceptedName: inv.accepted_name, acceptedAt: inv.accepted_at,
      lines: v.lines, subtotalCents: v.subtotalCents, taxCents: v.taxCents, taxRate: inv.tax_rate, feeCents: v.feeCents, totalCents: v.totalCents, depositCents: v.depositCents, depositPct: inv.deposit_pct, paidCents: v.paidCents, dueCents: v.dueCents, depositDueCents: v.depositDueCents,
      business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null, address: s.business_address || '' }, currency: s.currency, payOnline: h.onlinePayEnabled?.() || false });
  });
  app.post('/api/i/:token/accept', publicLimiter, (req, res) => {
    const inv = invByToken(req.params.token); if (!inv || inv.status === 'cancelled') throw err('This quote is no longer open', 409);
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(80) }), req.body);
    if (!inv.accepted_at) db.prepare("UPDATE invoices SET accepted_name = ?, accepted_at = datetime('now'), status = CASE WHEN status = 'sent' THEN 'accepted' ELSE status END WHERE id = ?").run(name, inv.id);
    audit(null, 'invoice.accept', `${inv.title} by ${name}`, clientIp(req)); notifyStaff('invoices');
    h.alertOwners?.(`${getSettings().business_name}: quote accepted`, `${name} accepted "${inv.title}".`, 'invoice');
    res.json({ ok: true });
  });
  app.post('/api/i/:token/pay', publicLimiter, wrap(async (req, res) => {
    const inv = invByToken(req.params.token); if (!inv || ['cancelled', 'paid'].includes(inv.status)) throw err('Nothing to pay on this invoice', 409);
    if (!h.onlinePayEnabled?.()) throw err('Online payment is not set up. Contact us to pay.', 503);
    const { part } = parse(z.object({ part: z.enum(['deposit', 'balance']) }), req.body);
    const t = invoiceTotals(inv); const cents = part === 'deposit' ? t.depositDueCents : t.dueCents;
    if (cents <= 0) throw err('Nothing left to pay', 409);
    const pid = db.prepare("INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('invoice', ?, 'card', ?, ?)").run(cents, `${inv.title} ${part}`, JSON.stringify({ invoiceId: inv.id, part })).lastInsertRowid;
    const base = publicBase(req); const back = `${base}/i/${inv.token}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`;
    res.json({ url: h.startPay(pid, { base, lines: [{ name: `${inv.title} (${part === 'deposit' ? 'deposit' : 'balance'})`, cents }], successUrl: back, cancelUrl: back, email: inv.email, descr: `${inv.title} ${part}` }) });
  }));

  /* ===== wallet cards ===== */
  app.get('/api/c/wallet', requireCustomer, (req, res) => {
    const t = customerCardToken(req.customer.id); const base = publicBase(req);
    res.json({ token: t, url: `/w/${t}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`, ...walletStatus() });
    void base;
  });
  staff.get('/giftcards/:id/wallet', (req, res) => {
    const t = giftWalletToken(idParam(req)); res.json({ url: `${publicBase(req)}/w/${t}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}` });
  });
  h.giftWalletLink = (cardId, base) => `${base}/w/${giftWalletToken(cardId)}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`;
  app.get('/api/w/:token', publicLimiter, wrap(async (req, res) => {
    const card = walletCard(req.params.token); if (!card) return res.status(404).json({ error: 'This card link is not valid.' });
    const base = publicBase(req); const s = getSettings();
    res.json({ ...card, svg: await QRCode.toString(card.qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), google: googleSaveUrl(card, base), apple: Boolean(apple()), logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null });
  }));
  app.get('/api/w/:token/pass.pkpass', publicLimiter, wrap(async (req, res) => {
    const card = walletCard(req.params.token); if (!card) return res.status(404).end();
    const buf = await applePass(card, publicBase(req));
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass'); res.setHeader('Content-Disposition', 'attachment; filename="card.pkpass"'); res.send(buf);
  }));
  staff.get('/wallet/status', mgr, (req, res) => res.json(walletStatus()));
}
