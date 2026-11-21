// Batch 4: drag-and-drop floor plan + server assignment, and pay-by-phone with Stripe Checkout.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, getSettings, audit, registerSchema, runIn, currentSlug, locationExists } from './db.js';
import { pushToGuest } from './notify.js';

registerSchema((db) => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const t = cols('tables');
  for (const [c, def] of [['x', 'REAL'], ['y', 'REAL'], ['w', 'REAL'], ['h', 'REAL'], ['shape', "TEXT NOT NULL DEFAULT 'square'"], ['server_id', 'INTEGER']]) if (!t.includes(c)) db.exec(`ALTER TABLE tables ADD COLUMN ${c} ${def}`);
  const o = cols('orders');
  for (const [c, def] of [['pay_token', 'TEXT'], ['stripe_session', 'TEXT']]) if (!o.includes(c)) db.exec(`ALTER TABLE orders ADD COLUMN ${c} ${def}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pay_token ON orders(pay_token)');
});

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
export const stripeEnabled = () => /^sk_(live|test)_/.test(STRIPE_KEY);

async function stripe(method, path, form) {
  let r;
  try { r = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), 'Stripe-Version': '2024-06-20' },
    body: form ? new URLSearchParams(form) : undefined,
  }); } catch { const e = new Error("Couldn't reach the card processor. Please try again or pay your server."); e.status = 502; throw e; }
  const data = await r.json();
  if (!r.ok) { const e = new Error(data.error?.message || 'Card payments are not available right now'); e.status = 502; throw e; }
  return data;
}

export function registerFloorPay({ app, staff, io, h }) {
  const { wrap, parse, idParam, now, clientIp, requireAuth, notifyStaff, publicLimiter, publicBase } = h;

  /* ================= Floor plan ================= */
  const box = z.object({ id: z.number().int(), x: z.number().min(0).max(100), y: z.number().min(0).max(100), w: z.number().min(3).max(60), h: z.number().min(3).max(60), shape: z.enum(['square', 'round', 'bar']) });
  staff.put('/tables/layout', requireAuth('manager'), (req, res) => {
    const list = parse(z.array(box).max(300), req.body);
    const up = db.prepare('UPDATE tables SET x=?, y=?, w=?, h=?, shape=? WHERE id=?');
    db.transaction(() => { for (const t of list) up.run(t.x, t.y, t.w, t.h, t.shape, t.id); })();
    audit(req.user, 'floor.layout', `${list.length} tables`, clientIp(req));
    notifyStaff('tables'); res.json({ ok: true });
  });
  staff.put('/tables/:id', requireAuth('manager'), (req, res) => {
    const b = parse(z.object({ label: z.string().trim().min(1).max(10), seats: z.number().int().min(1).max(40), zone: z.string().trim().min(1).max(20) }).partial(), req.body);
    const t = db.prepare('SELECT * FROM tables WHERE id = ?').get(idParam(req)); if (!t) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE tables SET label=?, seats=?, zone=? WHERE id=?').run(b.label ?? t.label, b.seats ?? t.seats, b.zone ?? t.zone, t.id);
    notifyStaff('tables'); res.json({ ok: true });
  });
  staff.post('/tables/:id/server', (req, res) => {
    const { userId } = parse(z.object({ userId: z.number().int().nullable() }), req.body);
    if (userId && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(userId)) return res.status(404).json({ error: 'Unknown team member' });
    db.prepare('UPDATE tables SET server_id = ? WHERE id = ?').run(userId, idParam(req));
    notifyStaff('tables'); res.json({ ok: true });
  });
  staff.get('/team', (req, res) => res.json(db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all()));

  /* ================= Pay by phone (Stripe Checkout) ================= */
  const orderByPayToken = (t) => (/^[A-Za-z0-9_-]{20,30}$/.test(t || '') ? db.prepare('SELECT * FROM orders WHERE pay_token = ?').get(t) : null);
  function bill(o) {
    const s = getSettings();
    return {
      number: o.number, status: o.status, items: db.prepare('SELECT name, qty, price_cents FROM order_items WHERE order_id = ?').all(o.id),
      subtotalCents: o.subtotal_cents, discountCents: o.discount_cents, taxCents: o.tax_cents, dueCents: o.subtotal_cents - o.discount_cents + o.tax_cents,
      tipCents: o.tip_cents, totalCents: o.total_cents, currency: s.currency, table: o.table_id ? db.prepare('SELECT label FROM tables WHERE id = ?').get(o.table_id)?.label : null,
      business: { name: s.business_name, accent: s.accent, unitLabel: s.unit_label, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null },
      cardsEnabled: stripeEnabled(),
    };
  }

  function markPaid(o, { tipCents, sessionId }) {
    if (o.status === 'paid') return false;
    const total = o.subtotal_cents - o.discount_cents + o.tax_cents + tipCents;
    db.prepare("UPDATE orders SET status='paid', tip_cents=?, total_cents=?, payment_method='card', paid_at=?, stripe_session=? WHERE id=? AND status <> 'paid'").run(tipCents, total, now(), sessionId, o.id);
    audit(null, 'order.pay', `#${o.number} card by phone ${(total / 100).toFixed(2)}`, null);
    io.to('staff').emit('paid:phone', { number: o.number, totalCents: total });
    notifyStaff('orders');
    return true;
  }

  staff.post('/orders/:id/paylink', wrap(async (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req));
    if (!o || ['paid', 'void'].includes(o.status)) return res.status(409).json({ error: 'This order is already closed' });
    let token = o.pay_token;
    if (!token) { token = crypto.randomBytes(16).toString('base64url'); db.prepare('UPDATE orders SET pay_token = ? WHERE id = ?').run(token, o.id); }
    const link = `${publicBase(req)}/p/${token}`;
    let pushed = 0;
    if (req.body?.notify && o.guest_id) {
      const r = await pushToGuest(o.guest_id, { title: `${getSettings().business_name}: your check`, body: `Your check for order #${o.number} is ready. Tap to pay from your phone.`, tag: 'check', url: `/p/${token}` }).catch(() => ({ sent: 0 }));
      pushed = r.sent;
    }
    audit(req.user, 'order.paylink', `#${o.number}${pushed ? ' sent to guest phone' : ''}`, clientIp(req));
    res.json({ link, svg: await QRCode.toString(link, { type: 'svg', margin: 1 }), pushed, cardsEnabled: stripeEnabled() });
  }));

  app.get('/api/p/:token', publicLimiter, wrap(async (req, res) => {
    const o = orderByPayToken(req.params.token);
    if (!o) return res.status(404).json({ error: 'This check link is not valid.' });
    // returning from Stripe: confirm the payment directly with Stripe (works even without a webhook)
    const sid = String(req.query.session_id || '');
    if (o.status !== 'paid' && stripeEnabled() && /^cs_(test|live)_[A-Za-z0-9]+$/.test(sid)) {
      const sess = await stripe('GET', `/checkout/sessions/${sid}`).catch(() => null);
      if (sess?.payment_status === 'paid' && sess.metadata?.pay_token === o.pay_token) markPaid(o, { tipCents: Number(sess.metadata.tip_cents || 0), sessionId: sess.id });
    }
    res.json(bill(db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id)));
  }));

  app.post('/api/p/:token/checkout', publicLimiter, wrap(async (req, res) => {
    const o = orderByPayToken(req.params.token);
    if (!o) return res.status(404).json({ error: 'This check link is not valid.' });
    if (o.status === 'paid') return res.status(409).json({ error: 'This check is already paid. Thank you!' });
    if (o.status === 'void') return res.status(409).json({ error: 'This check was cancelled.' });
    if (!stripeEnabled()) return res.status(503).json({ error: 'Card payments by phone are not set up yet. Please pay your server.' });
    const { tipCents } = parse(z.object({ tipCents: z.number().int().min(0).max(1_000_000) }), req.body);
    const s = getSettings();
    const due = o.subtotal_cents - o.discount_cents + o.tax_cents;
    if (tipCents > Math.max(due, 2000) * 2) return res.status(400).json({ error: 'That tip looks too high' });
    const base = publicBase(req);
    const cur = s.currency.toLowerCase();
    const form = {
      mode: 'payment',
      success_url: `${base}/p/${o.pay_token}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/p/${o.pay_token}`,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': cur,
      'line_items[0][price_data][unit_amount]': String(due),
      'line_items[0][price_data][product_data][name]': `${s.business_name}, order #${o.number}`,
      'metadata[order_id]': String(o.id), 'metadata[pay_token]': o.pay_token, 'metadata[loc]': currentSlug(), 'metadata[tip_cents]': String(tipCents),
      'payment_intent_data[metadata][order_number]': String(o.number),
    };
    if (tipCents > 0) Object.assign(form, { 'line_items[1][quantity]': '1', 'line_items[1][price_data][currency]': cur, 'line_items[1][price_data][unit_amount]': String(tipCents), 'line_items[1][price_data][product_data][name]': 'Tip' });
    const sess = await stripe('POST', '/checkout/sessions', form);
    db.prepare('UPDATE orders SET stripe_session = ? WHERE id = ?').run(sess.id, o.id);
    res.json({ url: sess.url });
  }));

  // Stripe webhook (optional but recommended): marks orders paid even if the guest closes the page early.
  h.stripeWebhook = (req, res) => {
    if (!WEBHOOK_SECRET) return res.status(404).end();
    const sig = String(req.get('stripe-signature') || '');
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')));
    const payload = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${parts.t}.${payload}`).digest('hex');
    const ok = parts.v1 && parts.v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
    if (!ok || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return res.status(400).send('bad signature');
    let event; try { event = JSON.parse(payload); } catch { return res.status(400).end(); }
    if (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') {
      const sess = event.data.object; const loc = sess.metadata?.loc || 'main';
      if (locationExists(loc)) runIn(loc, () => {
        const o = orderByPayToken(sess.metadata?.pay_token);
        if (o) markPaid(o, { tipCents: Number(sess.metadata.tip_cents || 0), sessionId: sess.id });
      });
    }
    res.json({ received: true });
  };

  staff.get('/payments/status', (req, res) => res.json({ cardsEnabled: stripeEnabled(), webhook: Boolean(WEBHOOK_SECRET), mode: STRIPE_KEY.startsWith('sk_live_') ? 'live' : STRIPE_KEY ? 'test' : null, webhookUrl: `${publicBase(req)}/api/stripe/webhook` }));
}
