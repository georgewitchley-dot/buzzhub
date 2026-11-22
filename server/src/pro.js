// Round 5, batch E: Stripe card readers (server-driven Terminal), receipts, booking deposits.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, registerSchema, currentSlug, forEachLocation } from './db.js';
import { stripe, stripeEnabled, dueOf } from './commerce.js';
import { emailEnabled, emailGuest, pushToCustomer } from './notify.js';

registerSchema((db) => {
  db.exec(`
CREATE TABLE IF NOT EXISTS terminal_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER NOT NULL, reader_id TEXT NOT NULL, pi_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL, tip_cents INTEGER NOT NULL DEFAULT 0, share TEXT, status TEXT NOT NULL DEFAULT 'waiting',
  error TEXT, user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT
);`);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('orders').includes('receipt_token')) db.exec('ALTER TABLE orders ADD COLUMN receipt_token TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_receipt ON orders(receipt_token)');
  const b = cols('bookings');
  if (!b.includes('deposit_cents')) db.exec("ALTER TABLE bookings ADD COLUMN deposit_cents INTEGER NOT NULL DEFAULT 0; ALTER TABLE bookings ADD COLUMN deposit_status TEXT NOT NULL DEFAULT 'none'; ALTER TABLE bookings ADD COLUMN deposit_pi TEXT; ALTER TABLE bookings ADD COLUMN deposit_code TEXT;");
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const fmt = (c) => `$${(c / 100).toFixed(2)}`;

export function receiptToken(orderId) {
  const o = db.prepare('SELECT receipt_token FROM orders WHERE id = ?').get(orderId);
  if (!o) return null;
  if (o.receipt_token) return o.receipt_token;
  const t = crypto.randomBytes(15).toString('base64url');
  db.prepare('UPDATE orders SET receipt_token = ? WHERE id = ?').run(t, orderId);
  return t;
}

export function receiptData(o) {
  const s = getSettings();
  const items = db.prepare('SELECT oi.qty, oi.name, oi.price_cents, oi.mods, oi.note FROM order_items oi WHERE oi.order_id = ? ORDER BY oi.id').all(o.id)
    .map((i) => { let mods = []; try { mods = JSON.parse(i.mods || '[]').map((m) => m.name || m); } catch { /* old rows */ } return { qty: i.qty, name: i.name, cents: i.qty * i.price_cents, mods, note: i.note }; });
  const table = o.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(o.table_id)?.label : null;
  const pays = db.prepare("SELECT p.method, p.amount_cents, p.tip_cents, p.label FROM payments p JOIN bill_orders bo ON bo.bill_id = p.bill_id WHERE bo.order_id = ? AND p.status = 'paid'").all(o.id);
  return {
    business: { name: s.business_name, accent: s.accent, logo: s.logo_version && s.logo_version !== '0' ? `/api/public/logo?v=${s.logo_version}${currentSlug() === 'main' ? '' : `&l=${currentSlug()}`}` : null, unit: s.unit_label },
    number: o.number, at: o.paid_at || o.created_at, table, name: o.customer_name, fulfillment: o.fulfillment || null,
    items, subtotalCents: o.subtotal_cents, discountCents: o.discount_cents, promo: o.promo_code, taxCents: o.tax_cents, feeCents: o.fee_cents || 0,
    giftCents: o.gift_cents || 0, tipCents: o.tip_cents, totalCents: o.total_cents, method: o.payment_method, paid: Boolean(o.paid_at), status: o.status,
    payments: pays.map((p) => ({ method: p.method, label: p.label, cents: p.amount_cents + p.tip_cents })),
    proof: o.fulfillment === 'delivery' && proofHook.fn ? proofHook.fn(o.id) : null,
    currency: s.currency, taxRate: Number(s.tax_rate),
  };
}

export const proofHook = { fn: null };
export async function emailReceipt(o, to, base) {
  if (!emailEnabled() || !to) return false;
  const s = getSettings(); const r = receiptData(o);
  const lines = r.items.map((i) => `${i.qty} × ${i.name}${i.mods.length ? ` (${i.mods.join(', ')})` : ''}  ${fmt(i.cents)}`).join('\n');
  const tot = [`Subtotal ${fmt(r.subtotalCents)}`, r.discountCents ? `Discount −${fmt(r.discountCents)}` : '', `Tax ${fmt(r.taxCents)}`, r.feeCents ? `Delivery ${fmt(r.feeCents)}` : '', r.tipCents ? `Tip ${fmt(r.tipCents)}` : '', `Total ${fmt(r.totalCents)}`].filter(Boolean).join('\n');
  const tok = receiptToken(o.id);
  const res = await emailGuest(to, { businessName: s.business_name, subject: `Receipt for order #${o.number}`, message: `Thanks for visiting!\n\n${lines}\n\n${tot}${r.proof ? `\n\nYour delivery ${r.proof.photo && r.proof.signature ? 'photo and signature are' : r.proof.photo ? 'photo is' : 'signature is'} on the receipt.` : ''}`, link: `${base}/r/${tok}`, accent: s.accent, button: 'View receipt' }).catch(() => ({ ok: false }));
  return res.ok;
}

export function registerPro({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, requireCustomer, publicBase, publicLimiter, notifyStaff } = h;

  /* ================= Card readers (Stripe Terminal, server-driven) ================= */
  const needStripe = () => { if (!stripeEnabled()) throw err('Connect Stripe first: add your Stripe secret key in Railway.', 503); };
  staff.get('/terminal/readers', wrap(async (req, res) => {
    const s = getSettings();
    const sq = h.squareReaders ? await h.squareReaders() : [];
    if (!stripeEnabled()) return res.json({ enabled: sq.length > 0, square: Boolean(h.squareOn?.()), stripe: false, readers: sq, location: null, test: sq.some((r) => r.type.includes('sandbox')) });
    const loc = s.terminal_location_id;
    const list = loc ? await stripe('GET', `/terminal/readers?location=${encodeURIComponent(loc)}&limit=20`).catch(() => ({ data: [] })) : { data: [] };
    res.json({ enabled: true, stripe: true, square: Boolean(h.squareOn?.()), test: !process.env.STRIPE_SECRET_KEY.startsWith('sk_live_'), location: loc || null, readers: [...list.data.map((r) => ({ id: r.id, label: r.label, type: r.device_type, status: r.status, serial: r.serial_number, provider: 'stripe' })), ...sq] });
  }));
  staff.post('/terminal/readers', requireAuth('manager'), wrap(async (req, res) => {
    needStripe();
    const b = parse(z.object({
      code: z.string().trim().min(3).max(60), label: z.string().trim().min(1).max(40),
      address: z.object({ line1: z.string().trim().min(1).max(100), city: z.string().trim().min(1).max(60), state: z.string().trim().max(40).optional(), postal: z.string().trim().min(1).max(20), country: z.string().trim().length(2) }).optional(),
    }), req.body);
    const s = getSettings();
    let loc = s.terminal_location_id;
    if (!loc) {
      if (!b.address) throw err('Enter your business address the first time you add a reader');
      const L = await stripe('POST', '/terminal/locations', { display_name: s.business_name, 'address[line1]': b.address.line1, 'address[city]': b.address.city, 'address[state]': b.address.state || '', 'address[postal_code]': b.address.postal, 'address[country]': b.address.country.toUpperCase() });
      loc = L.id; setSettings({ terminal_location_id: loc });
    }
    const r = await stripe('POST', '/terminal/readers', { registration_code: b.code, label: b.label, location: loc });
    audit(req.user, 'terminal.add', `${b.label} (${r.device_type})`, clientIp(req));
    res.json({ id: r.id, label: r.label, type: r.device_type, status: r.status });
  }));
  staff.delete('/terminal/readers/:rid', requireAuth('manager'), wrap(async (req, res) => {
    needStripe(); const rid = String(req.params.rid); if (!/^tmr_[A-Za-z0-9]+$/.test(rid)) throw err('Bad reader');
    await stripe('DELETE', `/terminal/readers/${rid}`); audit(req.user, 'terminal.remove', rid, clientIp(req)); res.json({ ok: true });
  }));

  function finishCharge(ch, pi) {
    if (ch.status === 'paid') return;
    const r = db.prepare("UPDATE terminal_charges SET status = 'paid', done_at = ? WHERE id = ? AND status <> 'paid'").run(now(), ch.id);
    if (!r.changes) return;
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(ch.bill_id);
    const share = JSON.parse(ch.share || '{}');
    db.prepare("INSERT INTO payments (bill_id, amount_cents, tip_cents, method, status, label, items, user_id, paid_at, stripe_session) VALUES (?, ?, ?, 'card', 'paid', ?, ?, ?, ?, ?)")
      .run(ch.bill_id, ch.amount_cents, ch.tip_cents, share.label || 'Card reader', JSON.stringify(share.itemIds || []), ch.user_id, now(), pi?.id || ch.pi_id);
    audit({ id: ch.user_id, name: 'card reader' }, 'terminal.paid', `${fmt(ch.amount_cents + ch.tip_cents)} on ${ch.reader_id}`, null);
    if (bill) h.settleBill(bill);
    notifyStaff('orders'); io.to('staff').emit('terminal', { id: ch.id, status: 'paid' });
  }
  h.finishCharge = finishCharge;
  h.onIntentSucceeded = (pi) => {
    const ch = db.prepare('SELECT * FROM terminal_charges WHERE pi_id = ?').get(pi.id);
    if (ch) finishCharge(ch, pi);
  };

  // start a charge on a reader: whole order, or a share of a check
  async function startReaderCharge(b, user) {
    const isSq = String(b.readerId).startsWith('sq_');
    if (!isSq) needStripe();
    let bill;
    if (b.billId) bill = db.prepare("SELECT * FROM bills WHERE id = ? AND status = 'open'").get(b.billId);
    else if (b.orderId) {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(b.orderId);
      if (!o || o.status === 'void' || o.paid_at) throw err('This order is already closed', 409);
      bill = h.billFor({ orderId: o.id });
    }
    if (!bill) throw err('That check is already settled', 409);
    const sum = h.billSummary(bill);
    if (sum.remainingCents <= 0) throw err('Nothing left to pay', 409);
    const amount = h.shareAmount(sum, { split: 'full', ...b }); const total = amount + (b.tipCents || 0);
    const s = getSettings();
    if (isSq) {
      const cid = await h.squareCharge(b.readerId.slice(3), total, `Order #${sum.numbers.join(', #')}`);
      const label = b.label || (b.split === 'even' ? `1 of ${b.ways}` : b.split === 'items' ? 'Own items' : 'Card reader');
      const id = db.prepare('INSERT INTO terminal_charges (bill_id, reader_id, pi_id, amount_cents, tip_cents, share, user_id) VALUES (?,?,?,?,?,?,?)').run(bill.id, b.readerId, `sqc:${cid}`, amount, b.tipCents || 0, JSON.stringify({ label, itemIds: b.itemIds || [] }), user?.id || null).lastInsertRowid;
      audit(user, 'terminal.charge', `${fmt(total)} on Square order #${sum.numbers.join(', #')}`, null);
      return { id, amountCents: total, status: 'waiting' };
    }
    const pi = await stripe('POST', '/payment_intents', { amount: String(total), currency: s.currency.toLowerCase(), 'payment_method_types[]': 'card_present', capture_method: 'automatic', 'metadata[loc]': currentSlug(), 'metadata[bill_id]': String(bill.id), description: `${s.business_name} order #${sum.numbers.join(', #')}` });
    const label = b.label || (b.split === 'even' ? `1 of ${b.ways}` : b.split === 'items' ? 'Own items' : 'Card reader');
    const id = db.prepare('INSERT INTO terminal_charges (bill_id, reader_id, pi_id, amount_cents, tip_cents, share, user_id) VALUES (?,?,?,?,?,?,?)').run(bill.id, b.readerId, pi.id, amount, b.tipCents || 0, JSON.stringify({ label, itemIds: b.itemIds || [] }), user?.id || null).lastInsertRowid;
    try { await stripe('POST', `/terminal/readers/${b.readerId}/process_payment_intent`, { payment_intent: pi.id }); } catch (e) {
      db.prepare("UPDATE terminal_charges SET status = 'failed', error = ? WHERE id = ?").run(e.message, id);
      await stripe('POST', `/payment_intents/${pi.id}/cancel`).catch(() => {});
      throw err(`The reader didn't respond: ${e.message}`, 502);
    }
    audit(user, 'terminal.charge', `${fmt(total)} order #${sum.numbers.join(', #')}`, null);
    return { id, amountCents: total, status: 'waiting' };
  }
  h.startReaderCharge = startReaderCharge;
  h.readerChargeStatus = async (id) => {
    const ch = db.prepare('SELECT * FROM terminal_charges WHERE id = ?').get(id);
    if (!ch) return null;
    if (ch.status === 'waiting' && ch.pi_id.startsWith('sqc:')) {
      const st = await h.squareChargeStatus(ch.pi_id.slice(4));
      if (st?.status === 'COMPLETED') finishCharge(ch, { id: st.paymentId ? `square:${st.paymentId}` : ch.pi_id });
      else if (st?.status === 'CANCELED') db.prepare("UPDATE terminal_charges SET status = 'cancelled', error = ? WHERE id = ?").run(st.reason || null, ch.id);
    } else if (ch.status === 'waiting' && stripeEnabled()) {
      const pi = await stripe('GET', `/payment_intents/${ch.pi_id}`).catch(() => null);
      if (pi?.status === 'succeeded') finishCharge(ch, pi);
      else if (pi?.last_payment_error) db.prepare('UPDATE terminal_charges SET error = ? WHERE id = ?').run(pi.last_payment_error.message || 'Card declined', ch.id);
      else if (pi?.status === 'canceled') db.prepare("UPDATE terminal_charges SET status = 'cancelled' WHERE id = ?").run(ch.id);
    }
    const c = db.prepare('SELECT * FROM terminal_charges WHERE id = ?').get(ch.id);
    return { id: c.id, status: c.status, error: c.error, amountCents: c.amount_cents + c.tip_cents };
  };
  staff.post('/terminal/charge', wrap(async (req, res) => {
    const b = parse(h.shareSchema.and(z.object({ readerId: z.string().regex(/^tmr_[A-Za-z0-9]+$/), orderId: z.number().int().optional(), billId: z.number().int().optional(), label: z.string().trim().max(30).optional() })), req.body);
    res.json(await startReaderCharge(b, req.user));
  }));
  staff.get('/terminal/charge/:id', wrap(async (req, res) => {
    const r = await h.readerChargeStatus(idParam(req)); if (!r) throw err('Not found', 404); res.json(r);
  }));
  staff.post('/terminal/charge/:id/cancel', wrap(async (req, res) => {
    const ch = db.prepare('SELECT * FROM terminal_charges WHERE id = ?').get(idParam(req));
    if (!ch || ch.status !== 'waiting') return res.json({ ok: true });
    if (ch.pi_id.startsWith('sqc:')) await h.squareCancel(ch.pi_id.slice(4));
    else { await stripe('POST', `/terminal/readers/${ch.reader_id}/cancel_action`).catch(() => {}); await stripe('POST', `/payment_intents/${ch.pi_id}/cancel`).catch(() => {}); }
    db.prepare("UPDATE terminal_charges SET status = 'cancelled', done_at = ? WHERE id = ?").run(now(), ch.id);
    audit(req.user, 'terminal.cancel', `charge ${ch.id}`, clientIp(req));
    res.json({ ok: true });
  }));
  // test mode only: pretend a card was tapped on a simulated reader
  staff.post('/terminal/charge/:id/simulate', wrap(async (req, res) => {
    const ch = db.prepare('SELECT * FROM terminal_charges WHERE id = ?').get(idParam(req));
    if (ch?.pi_id.startsWith('sqc:')) return res.json({ ok: true, note: 'The Square test terminal approves on its own.' });
    if (!ch || !String(process.env.STRIPE_SECRET_KEY).startsWith('sk_test_')) throw err('Only available in test mode');
    await stripe('POST', `/test_helpers/terminal/readers/${ch.reader_id}/present_payment_method`);
    res.json({ ok: true });
  }));

  /* ================= Receipts ================= */
  const orderByReceipt = (t) => (/^[A-Za-z0-9_-]{16,30}$/.test(t || '') ? db.prepare('SELECT * FROM orders WHERE receipt_token = ?').get(t) : null);
  h.orderByReceipt = orderByReceipt;
  app.get('/api/r/:token', publicLimiter, (req, res) => {
    const o = orderByReceipt(req.params.token);
    if (!o || o.status === 'void') return res.status(404).json({ error: 'This receipt link is not valid.' });
    res.json(receiptData(o));
  });
  staff.get('/orders/:id/receipt', wrap(async (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req));
    if (!o) throw err('Not found', 404);
    const t = receiptToken(o.id); const link = `${publicBase(req)}/r/${t}`;
    res.json({ ...receiptData(o), token: t, link, svg: await QRCode.toString(link, { type: 'svg', margin: 1 }), email: o.contact_email || null, emailEnabled: emailEnabled() });
  }));
  staff.post('/orders/:id/receipt/email', wrap(async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().email().max(120) }), req.body);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req));
    if (!o) throw err('Not found', 404);
    if (!emailEnabled()) throw err('Email is not set up. Add SMTP settings in Railway.', 503);
    if (!(await emailReceipt(o, email, publicBase(req)))) throw err("The email didn't send. Check the address.", 502);
    audit(req.user, 'receipt.email', `#${o.number}`, clientIp(req));
    res.json({ ok: true });
  }));

  /* ================= Booking deposits ================= */
  const depositOn = () => h.onlinePayEnabled() && Number(getSettings().booking_deposit_cents) > 0;
  async function depositCheckout(bk, req) {
    const s = getSettings(); const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `l=${currentSlug()}&`;
    const pid = db.prepare("INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('deposit', ?, 'card', ?, ?)").run(bk.deposit_cents, `Deposit for booking ${bk.id}`, JSON.stringify({ bookingId: bk.id })).lastInsertRowid;
    const c = db.prepare('SELECT email FROM customers WHERE id = ?').get(bk.customer_id);
    return h.startPay(pid, { base, lines: [{ name: `${s.business_name} booking deposit (${bk.start_local})`, cents: bk.deposit_cents }], successUrl: `${base}/account?${l}deposit={TOKEN}`, cancelUrl: `${base}/account${l ? `?${l.slice(0, -1)}` : ''}`, email: c?.email, descr: 'Booking deposit' });
  }
  h.depositOn = depositOn;
  h.startDeposit = async (bookingId, req) => {
    if (!depositOn()) return null;
    const cents = Number(getSettings().booking_deposit_cents);
    db.prepare("UPDATE bookings SET deposit_cents = ?, deposit_status = 'pending' WHERE id = ?").run(cents, bookingId);
    return { url: await depositCheckout(db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId), req) };
  };
  h.onDepositPaid = async (p) => {
    const meta = JSON.parse(p.meta || '{}');
    const fresh = db.prepare('SELECT refund_ref FROM payments WHERE id = ?').get(p.id);
    db.prepare("UPDATE bookings SET deposit_status = 'paid', deposit_pi = ? WHERE id = ? AND deposit_status IN ('pending','none')").run(fresh?.refund_ref || null, meta.bookingId);
    audit(null, 'deposit.paid', `booking ${meta.bookingId} ${fmt(p.amount_cents)}`, null);
    notifyStaff('bookings');
  };
  async function refundDeposit(bk, why) {
    if (bk.deposit_status !== 'paid') return false;
    const how = await h.refundRef(bk.deposit_pi, bk.deposit_cents);
    db.prepare('UPDATE bookings SET deposit_status = ? WHERE id = ?').run(how === 'manual' ? 'refund_due' : 'refunded', bk.id);
    audit(null, 'deposit.refund', `booking ${bk.id} ${fmt(bk.deposit_cents)} (${why})${how === 'manual' ? ': refund it by hand in the app they paid with' : ''}`, null);
    if (how === 'manual') h.alertOwners?.(`${getSettings().business_name}: refund a deposit`, `A ${fmt(bk.deposit_cents)} deposit paid by app needs to be sent back by hand (booking ${bk.id}).`, 'refund');
    return how !== 'manual';
  }
  /** Called when a booking is cancelled. Returns a short note for the customer. */
  h.onBookingCancel = async (bk, { byBusiness = false, minutesUntil = 0 } = {}) => {
    if (bk.deposit_status === 'pending') { db.prepare("UPDATE bookings SET deposit_status = 'none' WHERE id = ?").run(bk.id); return null; }
    if (bk.deposit_status !== 'paid') return null;
    const hours = Number(getSettings().deposit_refund_hours) || 0;
    if (byBusiness || minutesUntil >= hours * 60) { await refundDeposit(bk, byBusiness ? 'cancelled by business' : 'cancelled in time').catch(() => {}); return `Your ${fmt(bk.deposit_cents)} deposit is on its way back to your card.`; }
    db.prepare("UPDATE bookings SET deposit_status = 'kept' WHERE id = ?").run(bk.id);
    return `Cancelled less than ${hours} hours ahead, so the ${fmt(bk.deposit_cents)} deposit is kept.`;
  };
  h.onBookingNoShow = (bk) => { if (bk.deposit_status === 'paid') db.prepare("UPDATE bookings SET deposit_status = 'kept' WHERE id = ?").run(bk.id); };
  /** At check-in the deposit becomes credit on their bill (a one-time gift card). */
  h.onBookingCheckin = (bk, customer) => {
    if (bk.deposit_status !== 'paid') return null;
    const card = h.issueCard({ cents: bk.deposit_cents, name: `Deposit: ${customer.name}`, email: customer.email, source: 'deposit', method: 'card' });
    db.prepare("UPDATE bookings SET deposit_status = 'applied', deposit_code = ? WHERE id = ?").run(card.code, bk.id);
    pushToCustomer(customer.id, { title: `${getSettings().business_name}: deposit credit`, body: `Your ${fmt(bk.deposit_cents)} deposit comes off your bill. Code ${card.code}.`, tag: 'deposit', url: '/account' }).catch(() => {});
    return card.code;
  };
  app.post('/api/c/bookings/:id/deposit', requireCustomer, wrap(async (req, res) => {
    const bk = db.prepare("SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'booked' AND deposit_status = 'pending'").get(idParam(req), req.customer.id);
    if (!bk) throw err('Nothing to pay for this booking', 409);
    res.json({ url: await depositCheckout(bk, req) });
  }));
  app.post('/api/c/deposit/confirm', requireCustomer, wrap(async (req, res) => {
    const tok = String(req.body?.sessionId || '');
    const p = /^[A-Za-z0-9_-]{20,30}$/.test(tok) ? db.prepare("SELECT p.* FROM payments p WHERE p.pay_token = ? AND p.kind = 'deposit'").get(tok) : null;
    if (!p) return res.json({ ok: false });
    if (p.status !== 'paid') await h.verifyPayment?.(p);
    res.json({ ok: db.prepare('SELECT status FROM payments WHERE id = ?').get(p.id).status === 'paid' });
  }));
  // unpaid deposits release their slot after 30 minutes
  setInterval(() => forEachLocation(() => {
    const stale = db.prepare("SELECT id FROM bookings WHERE status = 'booked' AND deposit_status = 'pending' AND created_at < datetime('now','-32 minutes')").all();
    for (const b of stale) db.prepare("UPDATE bookings SET status = 'cancelled', deposit_status = 'none' WHERE id = ?").run(b.id);
    if (stale.length) notifyStaff('bookings');
  }), 60_000).unref();
}
