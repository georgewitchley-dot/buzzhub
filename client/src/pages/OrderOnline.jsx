import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent, money, withLoc } from '../lib.js';
import { Puck } from '../ui.jsx';
import { CartLines, GuestMenu, useCart } from '../order-ui.jsx';

function Shell({ biz, children }) {
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[biz.accent, '#2a1f55', biz.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in" style={{ alignContent: 'start', textAlign: 'left', justifyItems: 'stretch' }}>
        <div style={{ justifySelf: 'center' }}>{biz.logo ? <img className="guest-logo" src={biz.logo} alt={biz.name} /> : <Puck state="buzzed" size={44} />}</div>
        {children}
      </main>
    </div>
  );
}

/* ---------- online ordering for pickup or delivery ---------- */
export function OrderOnline() {
  const nav = useNavigate();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const cart = useCart();
  const [step, setStep] = useState('menu');
  const [f, setF] = useState(() => { try { return { fulfillment: 'pickup', name: '', phone: '', email: '', address: '', notes: '', ...JSON.parse(localStorage.getItem('bh_online_profile') || '{}') }; } catch { return { fulfillment: 'pickup' }; } });
  const [pct, setPct] = useState(15);
  const [promo, setPromo] = useState(() => (new URLSearchParams(location.search).get('promo') || '').toUpperCase().slice(0, 30));
  const [promoRes, setPromoRes] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/o/menu').then((x) => { setD(x); applyAccent(x.business.accent); document.title = `Order from ${x.business.name}`; if (!x.pickup && x.delivery) setF((p) => ({ ...p, fulfillment: 'delivery' })); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => {
    if (!promo) { setPromoRes(null); return undefined; }
    const id = setTimeout(() => api(`/public/promo?code=${encodeURIComponent(promo)}&subtotal=${cart.subtotal}`).then(setPromoRes).catch(() => setPromoRes(null)), 350);
    return () => clearTimeout(id);
  }, [promo, cart.subtotal]);
  if (err && !d) return <div className="guest"><main className="guest-in"><h1>Ordering unavailable</h1><p>{err}</p></main></div>;
  if (!d) return <div className="guest" />;
  if (!d.enabled) return <Shell biz={d.business}><h1 style={{ textAlign: 'center' }}>Online ordering is closed</h1><p style={{ textAlign: 'center', margin: '0 auto' }}>Please call or visit {d.business.name}.</p></Shell>;
  const fee = f.fulfillment === 'delivery' ? d.deliveryFeeCents : 0;
  const off = promoRes?.ok ? promoRes.cents : 0;
  const tax = Math.round((cart.subtotal - off) * d.taxRate / 100);
  const tip = Math.round(cart.subtotal * pct / 100);
  const short = f.fulfillment === 'delivery' && cart.subtotal < d.deliveryMinCents;
  const place = async (payNow) => {
    setBusy(true); setErr('');
    try {
      try { localStorage.setItem('bh_online_profile', JSON.stringify({ name: f.name, phone: f.phone, email: f.email, address: f.address })); } catch { /* ignore */ }
      const r = await api('/o/checkout', { method: 'POST', body: { items: cart.payload, ...f, payNow, tipCents: payNow ? tip : 0, promoCode: promoRes?.ok ? promo : undefined } });
      if (r.url) window.location.href = r.url; else nav(r.buzzer, { replace: true });
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <Shell biz={d.business}>
      <div style={{ display: 'grid', gap: 6, textAlign: 'center' }}><h1>Order from {d.business.name}</h1><p style={{ margin: '0 auto' }}>{d.pickup ? `Pickup in about ${d.readyInMinutes} minutes` : ''}{d.pickup && d.delivery ? ' or ' : ''}{d.delivery ? `delivery${d.deliveryFeeCents ? ` for ${money(d.deliveryFeeCents, d.currency)}` : ''}` : ''}.{d.delivery && d.deliveryArea ? ` We deliver to ${d.deliveryArea}.` : ''}</p></div>
      {step === 'menu' ? (
        <>
          <div className="card"><GuestMenu items={d.items} currency={d.currency} onAdd={cart.add} /></div>
          {cart.count > 0 && <div className="sticky-cta"><button className="btn primary lg block" onClick={() => setStep('checkout')}>Review order: {cart.count} item{cart.count === 1 ? '' : 's'}, {money(cart.subtotal, d.currency)}</button></div>}
        </>
      ) : (
        <>
          <div className="card"><div className="row"><b className="grow">Your order</b><button className="btn ghost sm" onClick={() => setStep('menu')}>Add more</button></div><CartLines cart={cart} currency={d.currency} /></div>
          <div className="card">
            {d.pickup && d.delivery && <div className="seg" style={{ width: '100%' }}>{['pickup', 'delivery'].map((x) => <button key={x} aria-pressed={f.fulfillment === x} onClick={() => setF({ ...f, fulfillment: x })} style={{ flex: 1, textTransform: 'capitalize' }}>{x}</button>)}</div>}
            <label className="field"><span>Your name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} autoComplete="name" /></label>
            <label className="field"><span>Mobile number</span><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={20} autoComplete="tel" /></label>
            <label className="field"><span>Email for the receipt (optional)</span><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={120} autoComplete="email" /></label>
            {f.fulfillment === 'delivery' && <label className="field"><span>Delivery address</span><textarea className="input" rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={200} autoComplete="street-address" /></label>}
            <label className="field"><span>Notes (optional)</span><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={200} placeholder={f.fulfillment === 'delivery' ? 'Gate code, leave at door…' : 'Anything we should know'} /></label>
            <input className="input" placeholder="Promo code (optional)" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} maxLength={30} aria-label="Promo code" />
            {promo && promoRes && !promoRes.ok && <span className="dim" style={{ fontSize: 13 }}>{promoRes.error}</span>}
          </div>
          {d.payOnline && <div className="card"><b>Tip the team</b><div className="row wrap">{[0, 10, 15, 20].map((p) => <button key={p} className={`btn sm ${pct === p ? 'primary' : ''}`} onClick={() => setPct(p)}>{p ? `${p}%` : 'No tip'}</button>)}</div></div>}
          <div className="card totals">
            <div><span>Subtotal</span><span>{money(cart.subtotal, d.currency)}</span></div>
            {off > 0 && <div><span>Promo {promoRes.code}</span><span>−{money(off, d.currency)}</span></div>}
            <div><span>Tax</span><span>{money(tax, d.currency)}</span></div>
            {fee > 0 && <div><span>Delivery fee</span><span>{money(fee, d.currency)}</span></div>}
            {d.payOnline && tip > 0 && <div><span>Tip</span><span>{money(tip, d.currency)}</span></div>}
            <div className="grand"><span>Total</span><span>{money(cart.subtotal - off + tax + fee + (d.payOnline ? tip : 0), d.currency)}</span></div>
          </div>
          {short && <div className="lock-msg">Delivery needs at least {money(d.deliveryMinCents, d.currency)} of food.</div>}
          {err && <div className="lock-msg">{err}</div>}
          {d.payOnline && <button className="btn primary lg block" disabled={busy || short || !f.name || f.phone.length < 7} onClick={() => place(true)}>{busy ? 'One moment…' : 'Pay and place order'}</button>}
          {d.payAtPickup && <button className={`btn lg block ${d.payOnline ? '' : 'primary'}`} disabled={busy || short || !f.name || f.phone.length < 7} onClick={() => place(false)}>Place order, pay at {f.fulfillment === 'delivery' ? 'the door' : 'pickup'}</button>}
          <span className="dim" style={{ fontSize: 13, textAlign: 'center' }}>After you order, your phone becomes your buzzer and tells you when it's ready.</span>
        </>
      )}
    </Shell>
  );
}

/* ---------- ordering from the table (QR code on the table) ---------- */
export function TableOrder() {
  const { token } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const cart = useCart();
  const [busy, setBusy] = useState(false);
  const load = () => api(`/t/${token}`).then((x) => { setD(x); applyAccent(x.business.accent); document.title = `${x.business.name}, table ${x.table}`; }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !d) return <div className="guest"><main className="guest-in"><h1>Table code not found</h1><p>{err}</p></main></div>;
  if (!d) return <div className="guest" />;
  const send = async () => {
    setBusy(true); setErr('');
    try { const r = await api(`/t/${token}/order`, { method: 'POST', body: { items: cart.payload } }); cart.clear(); setMsg(`Order #${r.number} is in. We'll bring it to your table.`); load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const help = (reason) => api(`/t/${token}/help`, { method: 'POST', body: { reason } }).then(() => setMsg(reason === 'water' ? 'Water is on the way.' : 'Your server is on the way.')).catch((e) => setErr(e.message));
  const pay = async () => { try { const r = await api(`/t/${token}/bill`, { method: 'POST' }); nav(`/p/${r.token}`); } catch (e) { setErr(e.message); } };

  return (
    <Shell biz={d.business}>
      <div style={{ display: 'grid', gap: 6, textAlign: 'center' }}><h1>{d.business.unitLabel} {d.table}</h1><p style={{ margin: '0 auto' }}>{d.tableOrdering ? 'Order from your phone. It goes straight to the kitchen.' : 'Your server will take your order.'}</p></div>
      {msg && <div className="card banner" role="status">{msg}</div>}
      {d.rounds.length > 0 && <div className="card"><b>On its way</b>{d.rounds.map((r) => <div key={r.number} className="row muted" style={{ fontSize: 14 }}><span className="grow">Order #{r.number}</span><span>{{ sent: 'Being made', open: 'Being made', ready: 'Ready', held: 'Waiting' }[r.status]}</span></div>)}</div>}
      {d.tableOrdering && <div className="card"><GuestMenu items={d.items} currency={d.currency} onAdd={cart.add} /></div>}
      {cart.count > 0 && (
        <div className="card">
          <b>Your order</b><CartLines cart={cart} currency={d.currency} />
          {err && <div className="lock-msg">{err}</div>}
          <button className="btn primary lg block" disabled={busy} onClick={send}>{busy ? 'Sending…' : `Send to kitchen, ${money(cart.subtotal, d.currency)} + tax`}</button>
        </div>
      )}
      <div className="row wrap">
        <button className="btn grow" onClick={() => help('server')}>Call my server</button>
        <button className="btn grow" onClick={() => help('water')}>Water, please</button>
        <button className="btn primary grow" onClick={pay}>See the check and pay</button>
      </div>
    </Shell>
  );
}

/* ---------- gift cards: buy online, check balance ---------- */
export function GiftPage() {
  const [d, setD] = useState(null);
  const [amount, setAmount] = useState(25);
  const [f, setF] = useState({ name: '', email: '' });
  const [code, setCode] = useState('');
  const [balance, setBalance] = useState(undefined);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const sid = new URLSearchParams(location.search).get('paid'); api(`/public/gift${sid ? `?paid=${encodeURIComponent(sid)}` : ''}`).then((x) => { setD(x); applyAccent(x.business.accent); }); }, []);
  if (!d) return <div className="guest" />;
  const buy = async () => { setBusy(true); setErr(''); try { const r = await api('/public/gift/checkout', { method: 'POST', body: { amountCents: amount * 100, ...f } }); window.location.href = r.url; } catch (e) { setErr(e.message); setBusy(false); } };
  const check = async () => { const r = await api(`/public/gift?code=${encodeURIComponent(code)}`); setBalance(r.balance); };
  return (
    <Shell biz={d.business}>
      <div style={{ display: 'grid', gap: 6, textAlign: 'center' }}><h1>{d.business.name} gift cards</h1></div>
      {d.awaiting && <div className="card"><b>Thanks! We're checking your payment</b><span className="muted" style={{ fontSize: 14 }}>As soon as the team confirms it, your gift card code is emailed to you.</span></div>}
      {d.purchased && (
        <div className="card"><b>Thank you! Here's your gift card</b><span className="muted" style={{ fontSize: 14 }}>{money(d.purchased.amountCents, d.currency)} for {d.purchased.name}. Show this code when you pay. {d.purchased.email ? 'We emailed it too, if email is set up.' : ''}</span><div className="reward-code num" style={{ fontSize: '1.4rem' }}>{d.purchased.code}</div></div>
      )}
      {d.cardsEnabled ? (
        <div className="card">
          <b>Buy a gift card</b>
          <div className="row wrap">{[10, 25, 50, 100].map((a) => <button key={a} className={`btn ${amount === a ? 'primary' : ''}`} onClick={() => setAmount(a)}>{money(a * 100, d.currency)}</button>)}</div>
          <label className="field"><span>Who it's for</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} /></label>
          <label className="field"><span>Email to send it to</span><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={120} /></label>
          {err && <div className="lock-msg">{err}</div>}
          <button className="btn primary lg block" disabled={busy || !f.name || !f.email} onClick={buy}>{busy ? 'One moment…' : `Buy ${money(amount * 100, d.currency)} gift card`}</button>
        </div>
      ) : <div className="card"><span className="muted">Gift cards are sold at {d.business.name}. Ask the staff.</span></div>}
      <div className="card">
        <b>Check a balance</b>
        <div className="row"><input className="input grow" inputMode="numeric" placeholder="Gift card code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Gift card code" /><button className="btn" onClick={check} disabled={code.replace(/\D/g, '').length < 16}>Check</button></div>
        {balance !== undefined && <span>{balance === null ? 'That code was not found.' : `Balance: ${money(balance, d.currency)}`}</span>}
      </div>
      <a className="btn ghost sm" href={withLoc('/order', d.business.slug)} style={{ justifySelf: 'center' }}>Order online</a>
    </Shell>
  );
}
