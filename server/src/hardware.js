// Round 24: printer lights, bag stickers, no-sale drawer, barcode scan lookup, bump bar keys,
// end-of-day print. (Reprints, backup printers and receipt QR codes live in print.js.)
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { db, getSettings, setSettings, audit, registerSchema, localToday, forEachLocation, currentSlug, getJwtSecret } from './db.js';
import { userFromToken, SESSION_COOKIE } from './security.js';
import { findByScan } from './club.js';
import { dailyBooks } from './reach.js';
import { dayBounds } from './ops.js';

registerSchema(() => {});
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v) ?? d; } catch { return d; } };
const fmt = (c) => `$${(c / 100).toFixed(2)}`;
export const DEFAULT_KEYS = { next: 'ArrowRight', prev: 'ArrowLeft', bump: 'Enter', recall: 'r', allday: 'a', select: '1-9' };

export function registerHardware({ app, staff, io, h }) {
  const { parse, clientIp, requireAuth, notifyStaff } = h;
  const mgr = requireAuth('manager');
  const anyone = (req) => {
    const t = req.get('X-Kds');
    if (t) { try { const p = jwt.verify(t, `${getJwtSecret()}:kds`); if (p.loc === currentSlug()) return { area: p.area }; } catch { /* bad */ } throw err('This screen is signed out.', 401); }
    let u = null; try { u = req.cookies?.[SESSION_COOKIE] ? userFromToken(req.cookies[SESSION_COOKIE]) : null; } catch { u = null; }
    if (!u) throw err('Sign in first', 401); return { user: u };
  };

  /* ===== 1. printer lights ===== */
  app.get('/api/print/status', (req, res) => {
    anyone(req);
    const kinds = String(req.query.kinds || '').split(',').filter(Boolean); const area = req.query.area ? String(req.query.area) : null;
    const rows = db.prepare('SELECT p.*, a.last_seen FROM printers p LEFT JOIN print_agents a ON a.id = p.agent_id WHERE p.active = 1').all()
      .filter((p) => { const j = pj(p.jobs, []); return (!kinds.length || kinds.some((k) => j.includes(k))) && (!area || !j.includes('ticket') || kinds.some((k) => k !== 'ticket' && j.includes(k)) || !p.area || p.area === 'All areas' || p.area === area); });
    res.json(rows.map((p) => {
      const online = p.last_seen && Date.now() - Date.parse(`${p.last_seen.replace(' ', 'T')}Z`) < 90_000;
      const failed = db.prepare("SELECT error FROM print_jobs WHERE printer_id = ? AND status = 'failed' AND created_at > datetime('now','-30 minutes') AND (? IS NULL OR created_at > ?) ORDER BY id DESC LIMIT 1").get(p.id, p.last_ok, p.last_ok);
      const waiting = db.prepare("SELECT COUNT(*) n FROM print_jobs WHERE printer_id = ? AND status IN ('queued','sent') AND created_at < datetime('now','-1 minute')").get(p.id).n;
      return { id: p.id, name: p.name, state: !online ? 'offline' : failed ? 'error' : waiting ? 'stuck' : 'ok', error: failed?.error || (waiting ? `${waiting} waiting` : null) };
    }));
  });

  /* ===== 4. to-go bag stickers ===== */
  h.stickerLines = (orderId) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId); if (!o) return null;
    const items = db.prepare('SELECT qty, name, mods FROM order_items WHERE order_id = ? AND price_cents >= 0 ORDER BY id').all(o.id);
    const lines = [{ text: o.customer_name || `Order ${o.number}`, big: true, center: true }, { text: `#${o.number}${o.shelf ? `  ·  Shelf ${o.shelf}` : ''}`, bold: true, center: true },
      { text: o.fulfillment === 'delivery' ? 'DELIVERY' : o.fulfillment === 'curbside' ? 'CURBSIDE' : 'PICKUP', invert: true, center: true }];
    for (const i of items) { lines.push({ text: `${i.qty} ${i.name}` }); const m = pj(i.mods || '[]', []).map((x) => x.name || x).filter(Boolean); if (m.length) lines.push({ text: `   ${m.join(', ')}` }); }
    if (o.allergy_note) lines.push({ text: `ALLERGY: ${o.allergy_note}`, bold: true });
    lines.push({ text: `Bagged ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: getSettings().timezone || 'America/New_York' })}`, center: true });
    return lines;
  };
  h.printSticker = (orderId, by) => { const lines = h.stickerLines(orderId); return lines && h.printJob ? h.printJob({ kind: 'sticker', title: `Bag sticker #${db.prepare('SELECT number FROM orders WHERE id = ?').get(orderId)?.number}`, lines }, by || 'Packing') : 0; };
  staff.post('/orders/:id/print-sticker', (req, res) => res.json({ queued: h.printSticker(Number(req.params.id), req.user.name) }));

  /* ===== 6. no-sale drawer open ===== */
  staff.post('/drawer/no-sale', (req, res, next) => h.managerOr('nosale')(req, res, next), (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().max(80).optional() }), req.body || {});
    const n = db.prepare('SELECT * FROM printers WHERE active = 1 AND drawer = 1').all();
    if (!n.length) throw err('No printer is set to open a cash drawer. Tick "Open the cash drawer" on a printer in Devices.', 409);
    for (const p of n) h.printJob({ kind: 'receipt', printerId: p.id, title: 'No sale', drawer: true, lines: [{ text: 'NO SALE', big: true, center: true }, { text: `${req.user.name}${req.approvedBy ? `, approved by ${req.approvedBy.name}` : ''}`, center: true }, { text: new Date().toLocaleString('en-US', { timeZone: getSettings().timezone || 'America/New_York' }), center: true }, ...(reason ? [{ text: reason, center: true }] : [])] }, req.user.name);
    audit(req.user, 'drawer.no_sale', `${reason || 'no reason'}${req.approvedBy ? ` (approved by ${req.approvedBy.name})` : ''}`, clientIp(req));
    io.to('owners').emit('security', { type: 'printer', detail: `No-sale drawer open by ${req.user.name}${reason ? `: ${reason}` : ''}` });
    res.json({ ok: true, drawers: n.length });
  });
  staff.get('/drawer/no-sales', mgr, (req, res) => res.json(db.prepare("SELECT ts, user_name, detail FROM audit WHERE action = 'drawer.no_sale' AND ts > datetime('now','-30 days') ORDER BY id DESC LIMIT 100").all()));

  /* ===== 7. barcode scans ===== */
  staff.get('/scan', (req, res) => {
    const code = String(req.query.code || '').trim().slice(0, 80); if (!code) return res.json({ type: 'none' });
    const c = findByScan(code); if (c) return res.json({ type: 'customer', id: c.id, name: c.name });
    const digits = code.replace(/\D/g, '');
    if (digits.length >= 12 && digits.length <= 20) {
      const g = db.prepare('SELECT code, balance_cents, status FROM gift_cards WHERE code = ?').get(digits.replace(/(\d{4})(?=\d)/g, '$1-'));
      if (g) return res.json({ type: 'gift', code: g.code, balanceCents: g.balance_cents, status: g.status });
    }
    const ing = db.prepare('SELECT id, name, stock, unit FROM ingredients WHERE barcode = ?').get(code); if (ing) return res.json({ type: 'ingredient', ...ing });
    const t = db.prepare('SELECT code FROM tickets WHERE code = ?').get(code.toUpperCase()); if (t) return res.json({ type: 'ticket', code: code.toUpperCase() });
    res.json({ type: 'none', code });
  });

  /* ===== 8. bump bar keys ===== */
  h.bumpKeys = () => ({ ...DEFAULT_KEYS, ...pj(getSettings().bumpbar_keys || '{}', {}) });
  staff.put('/bumpbar-keys', mgr, (req, res) => {
    const k = z.string().max(20);
    const b = parse(z.object({ next: k, prev: k, bump: k, recall: k, allday: k, select: z.enum(['1-9', 'off']) }), req.body);
    setSettings({ bumpbar_keys: JSON.stringify(b) }); audit(req.user, 'bumpbar.keys', JSON.stringify(b), clientIp(req)); notifyStaff('orders'); res.json({ ok: true });
  });

  /* ===== 9. end-of-day print ===== */
  h.eodLines = (date) => {
    const d = dailyBooks(date, date)[0]; const s = getSettings(); const { start, end } = dayBounds(date);
    const voids = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents),0) c FROM orders WHERE status = 'void' AND created_at >= ? AND created_at < ?").get(start, end);
    const top = db.prepare("SELECT oi.name, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status <> 'void' AND oi.price_cents > 0 GROUP BY oi.name ORDER BY n DESC LIMIT 5").all(start, end);
    const hours = db.prepare("SELECT COALESCE(SUM((julianday(COALESCE(clock_out, datetime('now'))) - julianday(clock_in)) * 24 - COALESCE(break_minutes,0) / 60.0),0) h FROM shifts WHERE clock_in < ? AND COALESCE(clock_out, datetime('now')) > ?").get(end, start).h;
    const lines = [{ text: s.business_name, big: true, center: true }, { text: `End of day  ${date}`, bold: true, center: true }, { text: '' },
      { text: 'Orders', right: String(d.orders) }, { text: 'Gross sales', right: fmt(d.grossCents) }, { text: 'Discounts', right: `-${fmt(d.discountCents)}` }, { text: 'Net sales', right: fmt(d.netCents), bold: true },
      { text: 'Tax', right: fmt(d.taxCents) }, ...(d.deliveryCents ? [{ text: 'Delivery fees', right: fmt(d.deliveryCents) }] : []), { text: 'Tips', right: fmt(d.tipsCents) },
      ...(d.refundsCents ? [{ text: 'Refunds', right: `-${fmt(d.refundsCents)}` }] : []), ...(voids.n ? [{ text: `Voids (${voids.n})`, right: fmt(voids.c) }] : []),
      { text: '' }, { text: 'Taken by', bold: true }, ...Object.entries(d.byMethod).map(([m, c]) => ({ text: `  ${m}`, right: fmt(c) })),
      ...(d.giftSoldCents ? [{ text: 'Gift cards sold', right: fmt(d.giftSoldCents) }] : []), { text: '' },
      { text: 'Hours worked', right: hours.toFixed(1) }, ...(d.netCents && hours ? [{ text: 'Sales per hour worked', right: fmt(Math.round(d.netCents / hours)) }] : []),
      ...(top.length ? [{ text: '' }, { text: 'Best sellers', bold: true }, ...top.map((t) => ({ text: `  ${t.name}`, right: String(t.n) }))] : []), { text: '' }, { text: `Printed ${new Date().toLocaleString('en-US', { timeZone: s.timezone || 'America/New_York' })}`, center: true }];
    return lines;
  };
  staff.post('/eod/print', mgr, (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || '')) ? req.body.date : localToday();
    const lines = h.eodLines(date); const n = h.printJob({ kind: 'report', title: `End of day ${date}`, lines }, req.user.name);
    res.json({ queued: n, lines });
  });
  setInterval(() => forEachLocation(() => {
    try {
      const s = getSettings(); if (s.eod_print !== '1') return;
      const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: s.timezone || 'America/New_York' }).format(new Date()));
      const today = localToday(); if (hour < Number(s.eod_print_hour || 23) || s.eod_printed === today) return;
      setSettings({ eod_printed: today });
      const n = h.printJob({ kind: 'report', title: `End of day ${today}`, lines: h.eodLines(today) }, 'Auto');
      audit(null, 'eod.print', `${today}: ${n} printer${n === 1 ? '' : 's'}`, null);
    } catch (e) { if (!/no such/.test(e.message)) console.error('eod print', e.message); }
  }), 5 * 60_000).unref();
}
