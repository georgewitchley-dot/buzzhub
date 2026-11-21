import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent, money } from '../lib.js';
import { Puck } from '../ui.jsx';

/** Guest's phone: see the check, pick a tip, pay with card / Apple Pay / Google Pay through Stripe. */
export default function PayPhone() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [b, setB] = useState(null);
  const [err, setErr] = useState('');
  const [pct, setPct] = useState(18);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sid = params.get('session_id');
    api(`/p/${token}${sid ? `?session_id=${encodeURIComponent(sid)}` : ''}`).then((d) => { setB(d); applyAccent(d.business.accent); document.title = `${d.business.name}: your check`; }).catch((e) => setErr(e.message));
  }, [token, params]);

  if (err) return <div className="guest"><main className="guest-in"><h1>Check not found</h1><p>{err} Please ask your server.</p></main></div>;
  if (!b) return <div className="guest" />;
  const base = b.subtotalCents - b.discountCents;
  const tip = custom !== '' ? Math.round(Number(custom) * 100) || 0 : Math.round((base * pct) / 100);
  const total = b.dueCents + tip;
  const pay = async () => {
    setBusy(true); setErr('');
    try { const r = await api(`/p/${token}/checkout`, { method: 'POST', body: { tipCents: tip } }); window.location.href = r.url; } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[b.business.accent, '#2a1f55', b.business.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in" style={{ alignContent: 'start' }}>
        {b.business.logo ? <img className="guest-logo" src={b.business.logo} alt={b.business.name} /> : <Puck state="buzzed" size={48} />}
        {b.status === 'paid' ? (
          <>
            <div style={{ display: 'grid', gap: 8 }}><h1>Paid, thank you!</h1><p>{money(b.totalCents, b.currency)} for order #{b.number}{b.tipCents ? `, including a ${money(b.tipCents, b.currency)} tip` : ''}. You're all set.</p></div>
          </>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 6 }}><h1>Your check</h1><p>Order #{b.number}{b.table ? `, ${b.business.unitLabel.toLowerCase()} ${b.table}` : ''} at {b.business.name}</p></div>
            <div className="card">
              {b.items.map((i, k) => <div key={k} className="row" style={{ fontSize: 15 }}><span className="grow">{i.qty} × {i.name}</span><span className="num">{money(i.qty * i.price_cents, b.currency)}</span></div>)}
              <div className="totals" style={{ borderTop: '1px solid var(--line)' }}>
                <div><span>Subtotal</span><span>{money(b.subtotalCents, b.currency)}</span></div>
                {b.discountCents > 0 && <div><span>Discount</span><span>−{money(b.discountCents, b.currency)}</span></div>}
                <div><span>Tax</span><span>{money(b.taxCents, b.currency)}</span></div>
              </div>
            </div>
            {b.cardsEnabled ? (
              <>
                <div className="card">
                  <b>Add a tip</b>
                  <div className="row wrap">{[0, 15, 18, 20, 25].map((p) => <button key={p} className={`btn sm ${custom === '' && pct === p ? 'primary' : ''}`} onClick={() => { setPct(p); setCustom(''); }}>{p ? `${p}%` : 'No tip'}</button>)}
                    <input className="input" style={{ width: 100, height: 34 }} inputMode="decimal" placeholder="Other" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Custom tip" /></div>
                </div>
                {err && <div className="lock-msg">{err}</div>}
                <button className="btn primary lg block" style={{ height: 60, fontSize: 18 }} disabled={busy} onClick={pay}>{busy ? 'Opening secure checkout…' : `Pay ${money(total, b.currency)}`}</button>
                <span className="dim" style={{ fontSize: 13 }}>Card, Apple Pay or Google Pay through Stripe's secure checkout. Your card details never touch this app.</span>
              </>
            ) : <div className="card"><b>{money(b.dueCents, b.currency)} due</b><span className="muted" style={{ fontSize: 14 }}>Paying by phone isn't set up here yet. Please pay your server.</span></div>}
          </>
        )}
      </main>
    </div>
  );
}
