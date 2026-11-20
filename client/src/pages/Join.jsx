import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent } from '../lib.js';
import { Puck } from '../ui.jsx';

export default function Join() {
  const nav = useNavigate();
  const [biz, setBiz] = useState(null);
  const [f, setF] = useState({ name: '', phone: '', partySize: 2 });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/public/business').then((b) => { setBiz(b); applyAccent(b.accent); document.title = `Join the list at ${b.name}`; }); }, []);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const { token } = await api('/public/join', { method: 'POST', body: { ...f, partySize: Number(f.partySize) } }); nav(`/b/${token}`, { replace: true }); }
    catch (e2) { setErr(e2.message); setBusy(false); }
  };
  if (!biz) return <div className="guest" />;
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[biz.accent, '#2a1f55', biz.accent]} amplitude={0.7} speed={0.4} mouseInteraction={false} /></div>
      <main className="guest-in">
        <Puck state="buzzed" size={56} />
        <div style={{ display: 'grid', gap: 8 }}>
          <h1>Join the list at {biz.name}</h1>
          <p>{biz.waiting ? `${biz.waiting} ${biz.waiting === 1 ? 'party' : 'parties'} ahead of you, about ${biz.waiting * biz.avgTurn} minutes.` : 'No wait right now.'} Your phone becomes your buzzer.</p>
        </div>
        {!biz.selfCheckin ? <p>Self check-in is off right now. Please see the host.</p> : (
          <form className="card" onSubmit={submit}>
            <label className="field"><span>Your name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} autoComplete="given-name" required /></label>
            <div className="field"><span>How many in your party?</span>
              <div className="row wrap">{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <button type="button" key={n} className={`btn sm ${f.partySize === n ? 'primary' : ''}`} style={{ width: 44 }} onClick={() => setF({ ...f, partySize: n })}>{n}</button>)}</div>
            </div>
            <label className="field"><span>Mobile number (optional, for a text when it's your turn)</span><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={20} autoComplete="tel" /></label>
            {err && <div className="lock-msg">{err}</div>}
            <button className="btn primary lg block" disabled={busy}>{busy ? 'Adding you…' : 'Join the list'}</button>
          </form>
        )}
      </main>
    </div>
  );
}
