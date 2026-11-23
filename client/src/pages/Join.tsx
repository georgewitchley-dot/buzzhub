import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Aurora from '../bits/Aurora';
import { api, applyAccent, withLoc } from '../lib';
import { Puck } from '../ui';

const REMEMBER = 'bh_guest_profile';
const loadProfile = () => { try { return JSON.parse(localStorage.getItem(REMEMBER) || '{}'); } catch { return {}; } };

export default function Join() {
  const nav = useNavigate();
  const [biz, setBiz] = useState(null);
  const [me, setMe] = useState(null);
  const saved = loadProfile();
  const [f, setF] = useState<any>({ name: saved.name || '', phone: saved.phone || '', email: saved.email || '', notifyEmail: true, partySize: 2 });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/public/business').then((b) => { setBiz(b); applyAccent(b.accent); document.title = `Join the list at ${b.name}`; });
    api('/c/me').then(({ customer }) => { setMe(customer); setF((x) => ({ ...x, name: x.name || customer.name, email: customer.email, phone: x.phone || customer.phone || '' })); }).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const { token } = await api('/public/join', { method: 'POST', body: { ...f, partySize: Number(f.partySize) } });
      try { localStorage.setItem(REMEMBER, JSON.stringify({ name: f.name, phone: f.phone, email: f.email })); } catch { /* private mode */ }
      nav(`/b/${token}`, { replace: true });
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  if (!biz) return <div className="guest" />;
  const service = biz.type === 'service';
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[biz.accent, '#2a1f55', biz.accent]} amplitude={0.7} speed={0.4} mouseInteraction={false} /></div>
      <main className="guest-in">
        {biz.logo ? <img className="guest-logo" src={biz.logo} alt={biz.name} /> : <Puck state="buzzed" size={56} />}
        <div style={{ display: 'grid', gap: 8 }}>
          <h1>{service ? `Check in at ${biz.name}` : `Join the list at ${biz.name}`}</h1>
          <p>{biz.waiting ? `${biz.waiting} ${biz.waiting === 1 ? 'party' : 'parties'} ahead of you, about ${biz.waiting * biz.avgTurn} minutes.` : 'No wait right now.'} Your phone becomes your buzzer.</p>
        </div>
        {biz.booking && (
          <Link className="btn lg block" to={withLoc('/account')}>{me ? `Book a time, ${me.name.split(' ')[0]}` : 'Book an appointment instead'}</Link>
        )}
        {!biz.selfCheckin ? <p>Walk-in check-in is off right now. Please see the front desk.</p> : (
          <form className="card" onSubmit={submit}>
            <label className="field"><span>Your name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} autoComplete="given-name" required /></label>
            <div className="field"><span>{service ? 'How many people?' : 'How many in your party?'}</span>
              <div className="row wrap">{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <button type="button" key={n} className={`btn sm ${f.partySize === n ? 'primary' : ''}`} style={{ width: 44 }} onClick={() => setF({ ...f, partySize: n })}>{n}</button>)}</div>
            </div>
            {!me && biz.emailAlerts && (
              <label className="field"><span>Email (optional, for an alert by email too)</span><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={120} autoComplete="email" /></label>
            )}
            {err && <div className="lock-msg">{err}</div>}
            <button className="btn primary lg block" disabled={busy}>{busy ? 'Adding you…' : service ? 'Check in now' : 'Join the list'}</button>
            <span className="dim" style={{ fontSize: 13 }}>Next you'll turn on alerts so your phone buzzes when it's your turn. No app download.</span>
          </form>
        )}
        {!me && biz.booking && <Link className="btn ghost sm" to={withLoc('/account')}>Already have an account? Sign in</Link>}
      </main>
    </div>
  );
}
