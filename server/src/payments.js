// One pay page for every online payment, with any mix of providers:
//   Square (cards, Apple/Google Pay, Cash App Pay, Afterpay; next-day bank deposit)
//   PayPal + Venmo (PayPal JS buttons, server-side capture)
//   Stripe (cards and wallets)
//   Pay-to-handle: Cash App $cashtag, Venmo, PayPal.me, Zelle (staff confirm by hand)
// Plus Square Terminal readers for the counter.
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, currentSlug, forEachLocation, runIn, locationExists } from './db.js';
import { stripe, stripeEnabled } from './commerce.js';
import { pushToUsers } from './notify.js';

registerSchema((db) => {
  const cols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
  for (const [c, t] of [['pay_token', 'TEXT'], ['success_url', 'TEXT'], ['cancel_url', 'TEXT'], ['descr', 'TEXT'], ['lines_json', 'TEXT'], ['email', 'TEXT'], ['provider', 'TEXT'], ['provider_ref', 'TEXT'], ['refund_ref', 'TEXT'], ['claim_app', 'TEXT'], ['claim_name', 'TEXT'], ['claimed_at', 'TEXT']]) if (!cols.includes(c)) db.exec(`ALTER TABLE payments ADD COLUMN ${c} ${t}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_token ON payments(pay_token)');
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/* ---------------- Square ---------------- */
const SQ = { token: process.env.SQUARE_ACCESS_TOKEN || '', loc: process.env.SQUARE_LOCATION_ID || '', env: (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase(), hook: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '' };
export const squareEnabled = () => Boolean(SQ.token && SQ.loc);
const sqBase = () => (SQ.env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com');
export async function square(method, path, body) {
  let r;
  try { r = await fetch(`${sqBase()}${path}`, { method, headers: { Authorization: `Bearer ${SQ.token}`, 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); } catch { throw err("Couldn't reach Square. Please try again.", 502); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw err(data.errors?.[0]?.detail || 'Square payments are not available right now', 502);
  return data;
}
/* ---------------- PayPal ---------------- */
const PP = { id: process.env.PAYPAL_CLIENT_ID || '', secret: process.env.PAYPAL_CLIENT_SECRET || '', env: (process.env.PAYPAL_ENVIRONMENT || 'production').toLowerCase() };
export const paypalEnabled = () => Boolean(PP.id && PP.secret);
const ppBase = () => (PP.env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com');
let ppTok = { t: '', until: 0 };
async function paypal(method, path, body) {
  if (Date.now() > ppTok.until) {
    const r = await fetch(`${ppBase()}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${PP.id}:${PP.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000) }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (!j?.access_token) throw err("Couldn't reach PayPal. Please try again.", 502);
    ppTok = { t: j.access_token, until: Date.now() + (j.expires_in - 120) * 1000 };
  }
  let r;
  try { r = await fetch(`${ppBase()}${path}`, { method, headers: { Authorization: `Bearer ${ppTok.t}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); } catch { throw err("Couldn't reach PayPal. Please try again.", 502); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw err(data.details?.[0]?.description || data.message || 'PayPal is not available right now', 502);
  return data;
}

/* ---------------- what this business accepts ---------------- */
const cleanHandle = (v, re) => { const s = String(v || '').trim(); return re.test(s) ? s : ''; };
export function handles(s = getSettings()) {
  return {
    cashapp: cleanHandle(s.pay_cashapp, /^\$[A-Za-z][A-Za-z0-9_-]{0,20}$/),
    venmo: cleanHandle(s.pay_venmo, /^@?[A-Za-z0-9_-]{3,30}$/).replace(/^@/, ''),
    paypalme: cleanHandle(s.pay_paypalme, /^[A-Za-z0-9]{1,20}$/),
    zelle: cleanHandle(s.pay_zelle, /^[^\s<>]{3,80}$/),
  };
}
const cardProvider = (s = getSettings()) => {
  const pref = s.card_provider || 'auto';
  if (pref === 'square' && squareEnabled()) return 'square';
  if (pref === 'stripe' && stripeEnabled()) return 'stripe';
  return squareEnabled() ? 'square' : stripeEnabled() ? 'stripe' : null;
};
export function onlinePayEnabled(s = getSettings()) {
  const hd = handles(s);
  return Boolean(cardProvider(s) || paypalEnabled() || (s.pay_handles_enabled === '1' && Object.values(hd).some(Boolean)));
}
export const providersStatus = () => ({ stripe: stripeEnabled(), square: squareEnabled(), squareEnv: squareEnabled() ? SQ.env : null, squareWebhook: Boolean(SQ.hook), paypal: paypalEnabled(), paypalEnv: paypalEnabled() ? PP.env : null, cardProvider: cardProvider() });

/** Point any pending payment row at the BuzzHub pay page. Returns its absolute URL. */
export function startPay(pid, { base, lines, successUrl, cancelUrl, email, descr }) {
  const token = crypto.randomBytes(16).toString('base64url');
  db.prepare('UPDATE payments SET pay_token = ?, success_url = ?, cancel_url = ?, lines_json = ?, email = ?, descr = ? WHERE id = ?').run(token, successUrl.replace('{TOKEN}', token), cancelUrl, JSON.stringify(lines), email || null, descr || null, pid);
  return `${base}/pay/${token}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`;
}

export function registerPayments({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, publicBase, publicLimiter, notifyStaff } = h;
  h.startPay = startPay; h.onlinePayEnabled = onlinePayEnabled; h.handles = handles;
  const byToken = (t) => (/^[A-Za-z0-9_-]{20,30}$/.test(t || '') ? db.prepare('SELECT * FROM payments WHERE pay_token = ?').get(t) : null);
  const total = (p) => p.amount_cents + (p.tip_cents || 0);
  const finish = (p, provider, ref, refundRef) => {
    db.prepare('UPDATE payments SET provider = ?, provider_ref = COALESCE(?, provider_ref), refund_ref = ? WHERE id = ?').run(provider, ref || null, refundRef || null, p.id);
    h.completePayment(db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id), ref || provider);
  };
  const lineItems = (p) => { try { return JSON.parse(p.lines_json || '[]'); } catch { return []; } };

  app.get('/api/pay/:token', publicLimiter, (req, res) => {
    const p = byToken(req.params.token); if (!p) throw err('This payment link is not valid.', 404);
    const s = getSettings(); const hd = handles(s); const cp = cardProvider(s); const amt = (total(p) / 100).toFixed(2);
    const methods = [];
    if (cp) methods.push({ kind: 'card', provider: cp, label: cp === 'square' ? 'Card, Apple Pay, Google Pay, Cash App Pay or Afterpay' : 'Card, Apple Pay or Google Pay' });
    if (paypalEnabled()) methods.push({ kind: 'paypal', clientId: PP.id, sandbox: PP.env === 'sandbox', currency: s.currency });
    if (s.pay_handles_enabled === '1') {
      const note = encodeURIComponent(`${s.business_name} ${p.descr || ''}`.trim().slice(0, 60));
      if (hd.cashapp) methods.push({ kind: 'handle', app: 'cashapp', label: 'Cash App', handle: hd.cashapp, url: `https://cash.app/${hd.cashapp}/${amt}` });
      if (hd.venmo) methods.push({ kind: 'handle', app: 'venmo', label: 'Venmo', handle: `@${hd.venmo}`, url: `https://venmo.com/?txn=pay&audience=private&recipients=${encodeURIComponent(hd.venmo)}&amount=${amt}&note=${note}` });
      if (hd.paypalme) methods.push({ kind: 'handle', app: 'paypalme', label: 'PayPal.me', handle: `paypal.me/${hd.paypalme}`, url: `https://paypal.me/${hd.paypalme}/${amt}${s.currency}` });
      if (hd.zelle) methods.push({ kind: 'handle', app: 'zelle', label: 'Zelle', handle: hd.zelle, url: null });
    }
    res.json({ status: p.status, claimed: Boolean(p.claimed_at), amountCents: total(p), currency: s.currency, descr: p.descr, lines: lineItems(p), successUrl: p.success_url, cancelUrl: p.cancel_url,
      business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null }, methods });
  });

  // card: hosted checkout at Square or Stripe, coming back here to confirm
  app.post('/api/pay/:token/card', publicLimiter, wrap(async (req, res) => {
    const p = byToken(req.params.token); if (!p) throw err('This payment link is not valid.', 404);
    if (p.status === 'paid') return res.json({ paid: true, next: p.success_url });
    const s = getSettings(); const cp = cardProvider(s); if (!cp) throw err('Card payments are not set up.', 503);
    const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `l=${currentSlug()}&`;
    const back = `${base}/pay/${p.pay_token}?${l}back=1`;
    const lines = lineItems(p);
    if (cp === 'square') {
      const r = await square('POST', '/v2/online-checkout/payment-links', {
        idempotency_key: crypto.randomUUID(),
        quick_pay: { name: `${s.business_name}${p.descr ? `: ${p.descr}` : ''}`.slice(0, 255), price_money: { amount: total(p), currency: s.currency }, location_id: SQ.loc },
        checkout_options: { redirect_url: back, ask_for_shipping_address: false }, pre_populated_data: p.email ? { buyer_email: p.email } : undefined,
        payment_note: `BuzzHub ${currentSlug()}:${p.id}`,
      });
      db.prepare("UPDATE payments SET provider = 'square', provider_ref = ? WHERE id = ?").run(r.payment_link.order_id, p.id);
      return res.json({ url: r.payment_link.url });
    }
    const form = { mode: 'payment', success_url: `${back}&ref={CHECKOUT_SESSION_ID}`, cancel_url: `${base}/pay/${p.pay_token}${l ? `?${l.slice(0, -1)}` : ''}`, 'metadata[payment_id]': String(p.id), 'metadata[loc]': currentSlug(), 'payment_intent_data[metadata][loc]': currentSlug() };
    if (p.email) form.customer_email = p.email;
    (lines.length ? lines : [{ name: p.descr || s.business_name, cents: total(p) }]).forEach((li, i) => Object.assign(form, { [`line_items[${i}][quantity]`]: '1', [`line_items[${i}][price_data][currency]`]: s.currency.toLowerCase(), [`line_items[${i}][price_data][unit_amount]`]: String(li.cents), [`line_items[${i}][price_data][product_data][name]`]: String(li.name).slice(0, 120) }));
    const sess = await stripe('POST', '/checkout/sessions', form);
    db.prepare("UPDATE payments SET provider = 'stripe', provider_ref = ?, stripe_session = ? WHERE id = ?").run(sess.id, sess.id, p.id);
    res.json({ url: sess.url });
  }));
  async function verify(p, ref) {
    if (p.status === 'paid') return true;
    if (p.provider === 'stripe' && stripeEnabled()) {
      const sid = /^cs_(test|live)_[A-Za-z0-9]+$/.test(ref || '') ? ref : p.provider_ref;
      const sess = sid ? await stripe('GET', `/checkout/sessions/${sid}`).catch(() => null) : null;
      if (sess?.payment_status === 'paid' && String(sess.metadata?.payment_id) === String(p.id)) { finish(p, 'stripe', sess.id, `stripe:${sess.payment_intent}`); return true; }
    }
    if (p.provider === 'square' && squareEnabled() && p.provider_ref) {
      const o = await square('GET', `/v2/orders/${p.provider_ref}`).catch(() => null);
      const paid = (o?.order?.tenders || []).filter((t) => t.payment_id);
      const amount = paid.reduce((a, t) => a + Number(t.amount_money?.amount || 0), 0);
      if (o?.order && (o.order.state === 'COMPLETED' || amount >= total(p))) { finish(p, 'square', p.provider_ref, paid[0] ? `square:${paid[0].payment_id}` : null); return true; }
    }
    return false;
  }
  h.verifyPayment = verify;
  app.post('/api/pay/:token/verify', publicLimiter, wrap(async (req, res) => {
    const p = byToken(req.params.token); if (!p) throw err('This payment link is not valid.', 404);
    const ok = await verify(p, String(req.body?.ref || ''));
    res.json({ paid: ok, next: p.success_url });
  }));

  // PayPal and Venmo: buttons on the pay page create and capture orders here
  app.post('/api/pay/:token/paypal', publicLimiter, wrap(async (req, res) => {
    const p = byToken(req.params.token); if (!p) throw err('This payment link is not valid.', 404);
    if (!paypalEnabled()) throw err('PayPal is not set up.', 503);
    if (p.status === 'paid') throw err('Already paid. Thank you!', 409);
    const s = getSettings();
    const o = await paypal('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ reference_id: `${currentSlug()}:${p.id}`, custom_id: `${currentSlug()}:${p.id}`, description: `${s.business_name}${p.descr ? `: ${p.descr}` : ''}`.slice(0, 127), amount: { currency_code: s.currency, value: (total(p) / 100).toFixed(2) } }], application_context: { shipping_preference: 'NO_SHIPPING', brand_name: s.business_name.slice(0, 127) } });
    db.prepare("UPDATE payments SET provider = 'paypal', provider_ref = ? WHERE id = ?").run(o.id, p.id);
    res.json({ id: o.id });
  }));
  app.post('/api/pay/:token/paypal/capture', publicLimiter, wrap(async (req, res) => {
    const p = byToken(req.params.token); if (!p) throw err('This payment link is not valid.', 404);
    const { orderId } = parse(z.object({ orderId: z.string().regex(/^[A-Z0-9]{10,30}$/) }), req.body);
    if (p.status === 'paid') return res.json({ paid: true, next: p.success_url });
    if (p.provider_ref !== orderId) throw err('That PayPal order does not match this payment', 409);
    const c = await paypal('POST', `/v2/checkout/orders/${orderId}/capture`, {});
    const cap = c.purchase_units?.[0]?.payments?.captures?.[0];
    const got = Math.round(Number(cap?.amount?.value || 0) * 100);
    if (c.status !== 'COMPLETED' || got < total(p)) throw err('PayPal did not complete the payment. Please try again.', 402);
    const via = c.payment_source?.venmo ? 'venmo' : 'paypal';
    db.prepare('UPDATE payments SET method = ? WHERE id = ?').run(via, p.id);
    finish(p, 'paypal', orderId, `paypal:${cap.id}`);
    audit(null, 'pay.paypal', `${via} ${(got / 100).toFixed(2)} payment ${p.id}`, clientIp(req));
    res.json({ paid: true, next: p.success_url });
  }));

  // pay-to-handle: the customer says they sent it; staff confirm when it shows up
  app.post('/api/pay/:token/claim', publicLimiter, (req, res) => {
    const p = byToken(req.params.token); if (!p) throw err('This payment link is not valid.', 404);
    const b = parse(z.object({ app: z.enum(['cashapp', 'venmo', 'paypalme', 'zelle']), name: z.string().trim().min(1).max(60) }), req.body);
    if (getSettings().pay_handles_enabled !== '1' || !handles()[b.app]) throw err('That way to pay is not available');
    if (p.status === 'paid') return res.json({ ok: true, paid: true });
    db.prepare('UPDATE payments SET claim_app = ?, claim_name = ?, claimed_at = ? WHERE id = ?').run(b.app, b.name, now(), p.id);
    const appName = { cashapp: 'Cash App', venmo: 'Venmo', paypalme: 'PayPal', zelle: 'Zelle' }[b.app];
    const msg = `${b.name} says they sent ${(total(p) / 100).toFixed(2)} by ${appName}${p.descr ? ` for ${p.descr}` : ''}. Check, then confirm it.`;
    io.to('staff').emit('pay:claim', { id: p.id, text: msg }); notifyStaff('payments');
    pushToUsers(['manager', 'owner'], { title: `${getSettings().business_name}: confirm a payment`, body: msg, tag: `claim-${p.id}`, url: '/orders' }).catch(() => {});
    audit(null, 'pay.claim', msg, clientIp(req));
    res.json({ ok: true });
  });
  staff.get('/payments/claims', (req, res) => {
    res.json(db.prepare("SELECT id, amount_cents + tip_cents total_cents, descr, claim_app, claim_name, claimed_at, kind FROM payments WHERE claimed_at IS NOT NULL AND status <> 'paid' AND claimed_at > datetime('now','-3 days') ORDER BY claimed_at").all());
  });
  staff.post('/payments/:id/confirm', (req, res) => {
    const p = db.prepare("SELECT * FROM payments WHERE id = ? AND status <> 'paid' AND claimed_at IS NOT NULL").get(idParam(req));
    if (!p) throw err('Already confirmed', 409);
    db.prepare('UPDATE payments SET method = ? WHERE id = ?').run(p.claim_app, p.id);
    finish(p, `manual:${p.claim_app}`, `manual:${p.claim_app}:${req.user.id}`, `manual:${p.claim_app}`);
    audit(req.user, 'pay.confirm', `${p.claim_app} ${(total(p) / 100).toFixed(2)} from ${p.claim_name}`, clientIp(req));
    notifyStaff('payments'); res.json({ ok: true });
  });
  staff.post('/payments/:id/reject', (req, res) => {
    const p = db.prepare("SELECT * FROM payments WHERE id = ? AND status <> 'paid'").get(idParam(req)); if (!p) throw err('Already confirmed', 409);
    db.prepare('UPDATE payments SET claimed_at = NULL WHERE id = ?').run(p.id);
    audit(req.user, 'pay.reject', `${p.claim_app} from ${p.claim_name}`, clientIp(req)); notifyStaff('payments'); res.json({ ok: true });
  });

  /* refunds for any provider; manual handles must be refunded by hand */
  h.refundRef = async (ref, cents) => {
    const [prov, id] = String(ref || '').split(/:(.+)/);
    if (prov === 'stripe' && id) { await stripe('POST', '/refunds', { payment_intent: id, ...(cents ? { amount: String(cents) } : {}) }); return 'card'; }
    if (prov === 'square' && id) { await square('POST', '/v2/refunds', { idempotency_key: crypto.randomUUID(), payment_id: id, amount_money: { amount: cents, currency: getSettings().currency } }); return 'card'; }
    if (prov === 'paypal' && id) { await paypal('POST', `/v2/payments/captures/${id}/refund`, cents ? { amount: { value: (cents / 100).toFixed(2), currency_code: getSettings().currency } } : {}); return 'paypal'; }
    return 'manual';
  };

  // Square tells us when a payment completes, even if the customer closes the page
  h.squareWebhook = (req, res) => {
    if (!SQ.hook) return res.status(404).end();
    const body = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    const url = `${process.env.PUBLIC_URL?.replace(/\/$/, '') || publicBase(req)}/api/square/webhook`;
    const expect = crypto.createHmac('sha256', SQ.hook).update(url + body).digest('base64');
    const got = String(req.get('x-square-hmacsha256-signature') || '');
    if (got.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expect))) return res.status(400).send('bad signature');
    let ev; try { ev = JSON.parse(body); } catch { return res.status(400).end(); }
    const pay = ev?.data?.object?.payment;
    if (pay?.status === 'COMPLETED' && pay.order_id) {
      forEachLocation(() => {
        const p = db.prepare("SELECT * FROM payments WHERE provider = 'square' AND provider_ref = ? AND status <> 'paid'").get(pay.order_id);
        if (p) finish(p, 'square', pay.order_id, `square:${pay.id}`);
      });
    }
    res.json({ ok: true });
  };

  /* ---------------- Square Terminal (counter card reader) ---------------- */
  staff.post('/square/devices/code', requireAuth('manager'), wrap(async (req, res) => {
    if (!squareEnabled()) throw err('Connect Square first: add your Square access token and location ID in Railway.', 503);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body);
    const r = await square('POST', '/v2/devices/codes', { idempotency_key: crypto.randomUUID(), device_code: { product_type: 'TERMINAL_API', location_id: SQ.loc, name } });
    audit(req.user, 'square.pair', name, clientIp(req));
    res.json({ code: r.device_code.code, expires: r.device_code.pair_by });
  }));
  h.squareReaders = async () => {
    if (!squareEnabled()) return [];
    const r = await square('GET', `/v2/devices/codes?location_id=${SQ.loc}&product_type=TERMINAL_API&status=PAIRED`).catch(() => ({ device_codes: [] }));
    const list = (r.device_codes || []).map((d) => ({ id: `sq_${d.device_id}`, label: d.name || 'Square Terminal', type: 'Square Terminal', status: 'online', provider: 'square' }));
    if (SQ.env === 'sandbox' && !list.length) list.push({ id: 'sq_9fa747a2-25ff-48ee-b078-04381f7c828f', label: 'Square test terminal', type: 'Square Terminal (sandbox)', status: 'online', provider: 'square' });
    return list;
  };
  h.squareCharge = async (deviceId, amountCents, note) => {
    const r = await square('POST', '/v2/terminals/checkouts', { idempotency_key: crypto.randomUUID(), checkout: { amount_money: { amount: amountCents, currency: getSettings().currency }, reference_id: note.slice(0, 40), note: note.slice(0, 250), device_options: { device_id: deviceId, skip_receipt_screen: true, tip_settings: { allow_tipping: false } } } });
    return r.checkout.id;
  };
  h.squareChargeStatus = async (checkoutId) => {
    const r = await square('GET', `/v2/terminals/checkouts/${checkoutId}`).catch(() => null);
    const c = r?.checkout; if (!c) return null;
    return { status: c.status, paymentId: c.payment_ids?.[0] || null, reason: c.cancel_reason || null };
  };
  h.squareCancel = (checkoutId) => square('POST', `/v2/terminals/checkouts/${checkoutId}/cancel`).catch(() => {});

  h.squareOn = squareEnabled;
  h.squareGet = (p) => square('GET', p);
  staff.get('/payments/providers', requireAuth('manager'), (req, res) => res.json({ ...providersStatus(), handles: handles(), handlesOn: getSettings().pay_handles_enabled === '1' }));
}
