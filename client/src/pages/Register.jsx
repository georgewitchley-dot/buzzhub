import { useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import SpotlightCard from '../bits/SpotlightCard.jsx';
import ClickSpark from '../bits/ClickSpark.jsx';
import { api, money } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { QrModal } from './Waitlist.jsx';

export function PayModal({ order, currency, onClose, onPaid }) {
  const toast = useToast();
  const base = order.subtotal_cents - order.discount_cents + order.tax_cents;
  const [method, setMethod] = useState('card');
  const [tipPct, setTipPct] = useState(0);
  const [customTip, setCustomTip] = useState('');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const tip = customTip !== '' ? Math.round(Number(customTip) * 100) : Math.round((order.subtotal_cents - order.discount_cents) * tipPct / 100);
  const total = base + tip;
  const tenderedCents = tendered === '' ? undefined : Math.round(Number(tendered) * 100);
  const pay = async () => {
    setBusy(true);
    try {
      const r = await api(`/staff/orders/${order.id}/pay`, { method: 'POST', body: { method, tipCents: tip, tenderedCents: method === 'cash' ? tenderedCents : undefined } });
      toast(r.changeCents > 0 ? `Paid. Change due ${money(r.changeCents, currency)}` : `Paid ${money(r.totalCents, currency)}`, 'ok');
      onPaid(r);
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Take payment for #${order.number}`} onClose={onClose}>
      <div className="seg" role="group" aria-label="Payment method" style={{ width: '100%' }}>
        {['card', 'cash', 'other'].map((m) => <button key={m} aria-pressed={method === m} onClick={() => setMethod(m)} style={{ flex: 1, textTransform: 'capitalize' }}>{m}</button>)}
      </div>
      <div className="field"><span>Tip</span>
        <div className="row wrap">
          {[0, 15, 18, 20, 25].map((p) => <button key={p} className={`btn sm ${customTip === '' && tipPct === p ? 'primary' : ''}`} onClick={() => { setTipPct(p); setCustomTip(''); }}>{p ? `${p}%` : 'None'}</button>)}
          <input className="input" style={{ width: 110, height: 34 }} inputMode="decimal" placeholder="Custom" value={customTip} onChange={(e) => setCustomTip(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Custom tip amount" />
        </div>
      </div>
      {method === 'cash' && (
        <label className="field"><span>Cash received</span>
          <input className="input" inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))} placeholder={(total / 100).toFixed(2)} />
          {tenderedCents !== undefined && <span className="num" style={{ color: tenderedCents >= total ? 'var(--seated)' : 'var(--dirty)' }}>{tenderedCents >= total ? `Change ${money(tenderedCents - total, currency)}` : `Short ${money(total - tenderedCents, currency)}`}</span>}
        </label>
      )}
      <div className="totals">
        <div><span>Before tip</span><span>{money(base, currency)}</span></div>
        <div><span>Tip</span><span>{money(tip, currency)}</span></div>
        <div className="grand"><span>Total</span><span>{money(total, currency)}</span></div>
      </div>
      {method === 'card' && <p className="dim" style={{ margin: 0, fontSize: 13 }}>Run the card on your terminal, then record it here.</p>}
      <button className="btn primary lg block" onClick={pay} disabled={busy}>{busy ? 'Recording…' : `Record ${money(total, currency)} paid`}</button>
    </Modal>
  );
}

export default function Register() {
  const { settings } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [menu] = useLive(['menu'], () => api('/staff/menu'));
  const [tables] = useLive(['tables'], () => api('/staff/tables'));
  const [cat, setCat] = useState('All');
  const [cart, setCart] = useState([]);
  const [customer, setCustomer] = useState('');
  const [tableId, setTableId] = useState('');
  const [discount, setDiscount] = useState(0);
  const [buzzer, setBuzzer] = useState(settings.business_type !== 'restaurant');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(null);
  const [qr, setQr] = useState(null);
  const totalRef = useRef(null);

  const items = (menu || []).filter((m) => m.active);
  const cats = ['All', ...new Set(items.map((m) => m.category))];
  const shown = cat === 'All' ? items : items.filter((m) => m.category === cat);

  const sums = useMemo(() => {
    const sub = cart.reduce((a, l) => a + l.qty * l.price_cents, 0);
    const disc = Math.round(sub * discount / 100);
    const tax = Math.round((sub - disc) * Number(settings.tax_rate) / 100);
    return { sub, disc, tax, total: sub - disc + tax };
  }, [cart, discount, settings.tax_rate]);

  const add = (m) => {
    setCart((c) => { const i = c.findIndex((l) => l.id === m.id); if (i >= 0) { const n = [...c]; n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; } return [...c, { ...m, qty: 1 }]; });
    gsap.fromTo(totalRef.current, { scale: 1.06 }, { scale: 1, duration: 0.3, ease: 'back.out(3)' });
  };
  const setQty = (id, d) => setCart((c) => c.map((l) => (l.id === id ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));
  const reset = () => { setCart([]); setCustomer(''); setTableId(''); setDiscount(0); setPhone(''); };

  const submit = async (payNow) => {
    if (!cart.length) return;
    setBusy(true);
    try {
      const r = await api('/staff/orders', { method: 'POST', body: { items: cart.map((l) => ({ itemId: l.id, qty: l.qty })), tableId: tableId ? Number(tableId) : null, customerName: customer || undefined, discountPct: discount || undefined, attachBuzzer: buzzer, phone } });
      const order = { id: r.id, number: r.number, subtotal_cents: sums.sub, discount_cents: sums.disc, tax_cents: sums.tax };
      reset();
      if (r.buzzer) setQr({ link: r.buzzer.link, svg: r.buzzer.svg, title: `Buzzer for order #${r.number}`, note: 'The customer scans this. Their phone buzzes when you mark the order ready.' });
      if (payNow) setPaying(order); else toast(`Order #${r.number} sent`, 'ok');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title="Register" sub="Tap items to add them to the ticket." />
      <div className="register">
        <div>
          <div className="cats">{cats.map((c) => <button key={c} className={`btn sm ${c === cat ? 'primary' : ''}`} onClick={() => setCat(c)}>{c}</button>)}</div>
          <ClickSpark sparkColor={settings.accent} sparkCount={10} sparkRadius={26}>
            <div className="items">
              {shown.map((m) => (
                <button key={m.id} className="item-btn" onClick={() => add(m)} aria-label={`Add ${m.name}, ${money(m.price_cents, cur)}`}>
                  <SpotlightCard className="item-card" spotlightColor={`${m.color}55`} style={{ '--c': m.color }}>
                    <b>{m.name}</b><span className="p">{money(m.price_cents, cur)}</span>
                  </SpotlightCard>
                </button>
              ))}
            </div>
          </ClickSpark>
        </div>

        <aside className="panel ticket">
          <div className="panel-h"><h3 className="grow">Ticket</h3>{cart.length > 0 && <button className="btn ghost sm" onClick={reset}>Clear</button>}</div>
          <div className="panel-b stack">
            {cart.length === 0 ? <p className="muted" style={{ margin: 0 }}>The ticket is empty.</p> : (
              <div>{cart.map((l) => (
                <div className="line" key={l.id}>
                  <span className="qty"><button onClick={() => setQty(l.id, -1)} aria-label={`Remove one ${l.name}`}>−</button><span>{l.qty}</span><button onClick={() => setQty(l.id, 1)} aria-label={`Add one ${l.name}`}>+</button></span>
                  <span>{l.name}</span><span className="num">{money(l.qty * l.price_cents, cur)}</span>
                </div>
              ))}</div>
            )}
            <div className="row">
              <input className="input grow" placeholder="Customer name" value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={40} aria-label="Customer name" />
              {settings.business_type === 'restaurant' && (
                <select className="input" style={{ width: 120 }} value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label={settings.unit_label}>
                  <option value="">To go</option>{(tables || []).map((t) => <option key={t.id} value={t.id}>{settings.unit_label} {t.label}</option>)}
                </select>
              )}
            </div>
            <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={buzzer} onChange={(e) => setBuzzer(e.target.checked)} /> Give the customer a phone buzzer for pickup</label>
            {buzzer && <input className="input" type="tel" placeholder="Mobile number for a text too (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} aria-label="Mobile number" />}
            <div className="row" style={{ fontSize: 14 }}><span className="muted grow">Discount</span>{[0, 10, 15, 50].map((p) => <button key={p} className={`btn sm ${discount === p ? 'primary' : ''}`} onClick={() => setDiscount(p)}>{p}%</button>)}</div>
            <div className="totals">
              <div><span>Subtotal</span><span>{money(sums.sub, cur)}</span></div>
              {sums.disc > 0 && <div><span>Discount</span><span>−{money(sums.disc, cur)}</span></div>}
              <div><span>Tax {settings.tax_rate}%</span><span>{money(sums.tax, cur)}</span></div>
              <div className="grand" ref={totalRef}><span>Total</span><span>{money(sums.total, cur)}</span></div>
            </div>
            <div className="row">
              <button className="btn lg grow" disabled={!cart.length || busy} onClick={() => submit(false)}>Send, pay later</button>
              <button className="btn primary lg grow" disabled={!cart.length || busy} onClick={() => submit(true)}>Charge</button>
            </div>
            {discount > 10 && <p className="dim" style={{ margin: 0, fontSize: 13 }}>Discounts above 10% need a manager or owner signed in.</p>}
          </div>
        </aside>
      </div>
      {paying && <PayModal order={paying} currency={cur} onClose={() => setPaying(null)} onPaid={() => setPaying(null)} />}
      {qr && !paying && <QrModal {...qr} onClose={() => setQr(null)} />}
    </>
  );
}
