import { useEffect, useRef, useState } from 'react';
import { api, money, timeOf } from './lib.js';
import { Icon, Modal, useToast } from './ui.jsx';

/* ---------- card readers ---------- */
let readerCache = null;
export function useReaders() {
  const [r, setR] = useState(readerCache);
  useEffect(() => { if (!readerCache) api('/staff/terminal/readers').then((x) => { readerCache = x; setR(x); }).catch(() => setR({ enabled: false, readers: [] })); }, []);
  return r;
}
export const forgetReaders = () => { readerCache = null; };

/** "Charge on card reader": starts a charge on a Stripe reader and waits for the tap. */
export function ReaderCharge({ body, label, currency, onPaid, disabled }) {
  const toast = useToast();
  const readers = useReaders();
  const online = (readers?.readers || []).filter((r) => r.status === 'online' || readers.test);
  const [pick, setPick] = useState(() => localStorage.getItem('bh_reader') || '');
  const [charge, setCharge] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);
  if (!readers?.enabled || !online.length) return null;
  const readerId = online.some((r) => r.id === pick) ? pick : online[0].id;
  const start = async () => {
    try {
      localStorage.setItem('bh_reader', readerId);
      const c = await api('/staff/terminal/charge', { method: 'POST', body: { ...body, readerId } });
      setCharge(c);
      clearInterval(timer.current);
      timer.current = setInterval(async () => {
        const s = await api(`/staff/terminal/charge/${c.id}`).catch(() => null);
        if (!s) return;
        setCharge(s);
        if (s.status === 'paid') { clearInterval(timer.current); toast(`Card approved, ${money(s.amountCents, currency)}`, 'ok'); onPaid?.(s); }
        if (['cancelled', 'failed'].includes(s.status)) clearInterval(timer.current);
      }, 2000);
    } catch (e) { toast(e.message, 'err'); }
  };
  const cancel = async () => { clearInterval(timer.current); await api(`/staff/terminal/charge/${charge.id}/cancel`, { method: 'POST' }).catch(() => {}); setCharge(null); };
  if (charge && charge.status === 'waiting') return (
    <div className="card reader-wait" role="status">
      <div className="row"><span className="pulse-dot" /><b className="grow">Tap, insert or swipe on the reader: {money(charge.amountCents, currency)}</b></div>
      {charge.error && <span style={{ color: 'var(--dirty)', fontSize: 14 }}>{charge.error}. Ask for another card, or cancel.</span>}
      <div className="row">
        {readers.test && <button className="btn sm grow" onClick={() => api(`/staff/terminal/charge/${charge.id}/simulate`, { method: 'POST' }).catch((e) => toast(e.message, 'err'))}>Simulate a tap (test mode)</button>}
        <button className="btn sm ghost danger grow" onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
  return (
    <div className="row">
      {online.length > 1 && <select className="input" style={{ width: 150 }} value={readerId} onChange={(e) => setPick(e.target.value)} aria-label="Card reader">{online.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>}
      <button className="btn primary lg grow" disabled={disabled} onClick={start}><Icon name="cash" size={18} />{label || 'Charge on card reader'}</button>
      {charge?.status === 'cancelled' && <span className="dim">Cancelled</span>}
    </div>
  );
}

/* ---------- receipts ---------- */
export function ReceiptBody({ r }) {
  const cur = r.currency;
  return (
    <div className="receipt">
      {r.business.logo && <img src={r.business.logo} alt="" className="receipt-logo" />}
      <h2>{r.business.name}</h2>
      <p className="receipt-meta">Order #{r.number}{r.table ? `, ${r.business.unit} ${r.table}` : ''}{r.name ? `, ${r.name}` : ''}<br />{new Date(`${r.at.replace(' ', 'T')}Z`).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
      <table><tbody>
        {r.items.map((i, k) => <tr key={k}><td>{i.qty} × {i.name}{i.mods.length > 0 && <small>{i.mods.join(', ')}</small>}{i.note && <small>{i.note}</small>}</td><td>{money(i.cents, cur)}</td></tr>)}
      </tbody></table>
      <table className="receipt-tot"><tbody>
        <tr><td>Subtotal</td><td>{money(r.subtotalCents, cur)}</td></tr>
        {r.discountCents > 0 && <tr><td>Discount{r.promo ? ` (${r.promo})` : ''}</td><td>−{money(r.discountCents, cur)}</td></tr>}
        <tr><td>Tax ({r.taxRate}%)</td><td>{money(r.taxCents, cur)}</td></tr>
        {r.feeCents > 0 && <tr><td>Delivery</td><td>{money(r.feeCents, cur)}</td></tr>}
        {r.giftCents > 0 && <tr><td>Gift card</td><td>−{money(r.giftCents, cur)}</td></tr>}
        {r.tipCents > 0 && <tr><td>Tip</td><td>{money(r.tipCents, cur)}</td></tr>}
        <tr className="grand"><td>Total</td><td>{money(r.totalCents, cur)}</td></tr>
      </tbody></table>
      <p className="receipt-meta">{r.paid ? `Paid${r.method ? ` by ${r.method.replace('+', ' and ')}` : ''}` : 'Not paid yet'}</p>
      <p className="receipt-meta">Thank you!</p>
    </div>
  );
}
export function printPart(cls) {
  document.body.classList.add(cls);
  const off = () => document.body.classList.remove(cls);
  window.addEventListener('afterprint', off, { once: true });
  setTimeout(() => { window.print(); setTimeout(off, 1500); }, 60);
}
export function ReceiptModal({ order, onClose }) {
  const toast = useToast();
  const [r, setR] = useState(null);
  const [email, setEmail] = useState('');
  useEffect(() => { api(`/staff/orders/${order.id}/receipt`).then((x) => { setR(x); setEmail(x.email || ''); }).catch((e) => toast(e.message, 'err')); }, [order.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return null;
  const send = async () => { try { await api(`/staff/orders/${order.id}/receipt/email`, { method: 'POST', body: { email } }); toast(`Receipt sent to ${email}`, 'ok'); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`Receipt #${r.number}`} onClose={onClose} width={520}>
      <div className="grid-2" style={{ gap: 14, alignItems: 'start' }}>
        <div className="receipt-preview print-receipt"><ReceiptBody r={r} /></div>
        <div className="stack">
          <span className="muted" style={{ fontSize: 14 }}>Let them scan for a copy on their phone:</span>
          <div className="qr" dangerouslySetInnerHTML={{ __html: r.svg }} />
          <button className="btn" onClick={() => printPart('printing-receipt')}><Icon name="print" size={16} />Print</button>
          {r.emailEnabled && <div className="row"><input className="input grow" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email receipt to" /><button className="btn" disabled={!/^\S+@\S+\.\S+$/.test(email)} onClick={send}>Send</button></div>}
        </div>
      </div>
    </Modal>
  );
}

/* ---------- kitchen print ticket ---------- */
export function TicketPrint({ orders, unit }) {
  return (
    <div className="print-ticket">
      {orders.map((o) => (
        <div key={o.id} className="ticket-slip">
          <h2>#{o.number}</h2>
          <p>{o.table_label ? `${unit} ${o.table_label}` : o.fulfillment === 'delivery' ? 'DELIVERY' : o.fulfillment === 'pickup' ? 'PICKUP' : o.customer_name || 'To go'}{o.customer_name && o.table_label ? `, ${o.customer_name}` : ''}</p>
          <p>{timeOf(o.sent_at || o.created_at)}</p>
          {o.items.map((i, k) => <div key={k} className="slip-line"><b>{i.qty}</b> {i.name}{i.mods?.length ? <div>  {i.mods.map((m) => m.name || m).join(', ')}</div> : null}{i.note && <div>  * {i.note}</div>}</div>)}
          {(o.allergy_note || /allerg/i.test(o.customer_tags || '')) && <p><b>ALLERGY: {[o.allergy_note, ...(() => { try { return JSON.parse(o.customer_tags || '[]').filter((t) => /allerg|free|vegan/i.test(t)); } catch { return []; } })()].filter(Boolean).join(', ')}</b></p>}
          {o.order_notes && <p>Note: {o.order_notes}</p>}
          {o.delivery_address && <p>{o.delivery_address}</p>}
        </div>
      ))}
    </div>
  );
}
