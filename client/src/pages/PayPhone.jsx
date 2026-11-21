import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent, money } from '../lib.js';
import { Puck } from '../ui.jsx';

/** Guest's phone: see the check, split it (evenly or by item), tip, and pay with card / Apple Pay / Google Pay. */
export default function PayPhone() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [b, setB] = useState(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('full');
  const [ways, setWays] = useState(2);
  const [picked, setPicked] = useState([]);
  const [pct, setPct] = useState(18);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const just = Boolean(params.get('session_id') || params.get('paid'));

  const load = () => { const sid = params.get('session_id'); return api(`/p/${token}${sid ? `?session_id=${encodeURIComponent(sid)}` : ''}`).then((d) => { setB(d); applyAccent(d.business.accent); document.title = `${d.business.name}: your check`; }).catch((e) => setErr(e.message)); };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="guest"><main className="guest-in"><h1>Check not found</h1><p>{err} Please ask your server.</p></main></div>;
  if (!b) return <div className="guest" />;
  const share = mode === 'even' ? Math.min(b.remainingCents, Math.ceil(b.dueCents / ways)) : mode === 'items' ? Math.min(b.remainingCents, b.items.filter((i) => picked.includes(i.id)).reduce((a, i) => a + i.shareCents, 0)) : b.remainingCents;
  const tip = custom !== '' ? Math.round(Number(custom) * 100) || 0 : Math.round((share * pct) / 100);
  const pay = async () => {
    setBusy(true); setErr('');
    try { const r = await api(`/p/${token}/checkout`, { method: 'POST', body: { split: mode, ways: mode === 'even' ? ways : undefined, itemIds: mode === 'items' ? picked : undefined, tipCents: tip } }); window.location.href = r.url; }
    catch (e) { setErr(e.message); setBusy(false); load(); }
  };
  const where = b.table ? `${b.business.unitLabel.toLowerCase()} ${b.table}` : `order #${b.numbers.join(', #')}`;

  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[b.business.accent, '#2a1f55', b.business.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in" style={{ alignContent: 'start' }}>
        {b.business.logo ? <img className="guest-logo" src={b.business.logo} alt={b.business.name} /> : <Puck state="buzzed" size={48} />}
        {b.status === 'paid' || b.remainingCents <= 0 ? (
          <div style={{ display: 'grid', gap: 8 }}><h1>{just ? 'Paid, thank you!' : 'All paid'}</h1><p>The check for {where} at {b.business.name} is settled{b.tipCents ? `, with ${money(b.tipCents, b.currency)} in tips` : ''}. You're all set.</p></div>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 6 }}><h1>{just ? 'Thanks! Your share is paid' : 'Your check'}</h1><p>{where} at {b.business.name}{b.paidCents > 0 ? `. ${money(b.paidCents, b.currency)} paid so far.` : ''}</p></div>
            <div className="card">
              {b.items.map((i) => (
                <div key={i.id} className="row" style={{ fontSize: 15, opacity: i.paid ? 0.45 : 1 }}>
                  <span className="grow" style={{ textDecoration: i.paid ? 'line-through' : 'none' }}>{i.qty} × {i.name}{i.mods.length ? <small className="mods">{i.mods.map((m) => m.name).join(', ')}</small> : null}</span>
                  <span className="num">{money(i.lineCents, b.currency)}</span>
                </div>
              ))}
              <div className="totals" style={{ borderTop: '1px solid var(--line)' }}>
                <div><span>Subtotal</span><span>{money(b.subtotalCents, b.currency)}</span></div>
                {b.discountCents > 0 && <div><span>Discount</span><span>−{money(b.discountCents, b.currency)}</span></div>}
                <div><span>Tax</span><span>{money(b.taxCents, b.currency)}</span></div>
                {b.feeCents > 0 && <div><span>Delivery fee</span><span>{money(b.feeCents, b.currency)}</span></div>}
                {b.giftCents > 0 && <div><span>Gift card</span><span>−{money(b.giftCents, b.currency)}</span></div>}
                {b.paidCents > 0 && <div><span>Already paid</span><span>−{money(b.paidCents, b.currency)}</span></div>}
                <div className="grand"><span>Left to pay</span><span>{money(b.remainingCents, b.currency)}</span></div>
              </div>
            </div>
            {b.cardsEnabled ? (
              <>
                <div className="card">
                  <b>What are you paying?</b>
                  <div className="seg" style={{ width: '100%' }}>
                    {[['full', b.paidCents ? 'The rest' : 'Everything'], ['even', 'Split evenly'], ['items', 'My items']].map(([k, l]) => <button key={k} aria-pressed={mode === k} onClick={() => setMode(k)} style={{ flex: 1 }}>{l}</button>)}
                  </div>
                  {mode === 'even' && <div className="row"><span className="muted grow">Split between</span>{[2, 3, 4, 5, 6].map((n) => <button key={n} className={`btn sm ${ways === n ? 'primary' : ''}`} onClick={() => setWays(n)} style={{ width: 40 }}>{n}</button>)}</div>}
                  {mode === 'items' && b.items.map((i) => (
                    <label key={i.id} className="row" style={{ fontSize: 15, opacity: i.paid || i.claimed ? 0.45 : 1 }}>
                      <input type="checkbox" disabled={i.paid || i.claimed} checked={picked.includes(i.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))} />
                      <span className="grow">{i.qty} × {i.name}</span><span className="num">{i.paid ? 'Paid' : i.claimed ? 'Paying' : money(i.shareCents, b.currency)}</span>
                    </label>
                  ))}
                  {mode === 'items' && <span className="dim" style={{ fontSize: 12.5 }}>Item prices include their share of tax.</span>}
                </div>
                <div className="card">
                  <b>Add a tip</b>
                  <div className="row wrap">{[0, 15, 18, 20, 25].map((p) => <button key={p} className={`btn sm ${custom === '' && pct === p ? 'primary' : ''}`} onClick={() => { setPct(p); setCustom(''); }}>{p ? `${p}%` : 'No tip'}</button>)}
                    <input className="input" style={{ width: 100, height: 34 }} inputMode="decimal" placeholder="Other" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Custom tip" /></div>
                </div>
                {err && <div className="lock-msg">{err}</div>}
                <button className="btn primary lg block" style={{ height: 60, fontSize: 18 }} disabled={busy || share <= 0} onClick={pay}>{busy ? 'Opening secure checkout…' : share > 0 ? `Pay ${money(share + tip, b.currency)}` : 'Pick your items'}</button>
                <span className="dim" style={{ fontSize: 13 }}>Card, Apple Pay or Google Pay through Stripe's secure checkout. Your card details never touch this app.</span>
              </>
            ) : <div className="card"><b>{money(b.remainingCents, b.currency)} due</b><span className="muted" style={{ fontSize: 14 }}>Paying by phone isn't set up here yet. Please pay your server.</span></div>}
          </>
        )}
      </main>
    </div>
  );
}
