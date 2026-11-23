import { useState } from 'react';
import Aurora from '../bits/Aurora';
import { api } from '../lib';
import { Puck } from '../ui';

export default function Setup({ onDone }: { onDone?: any; }) {
  const [f, setF] = useState<any>({ setupCode: '', businessName: '', businessType: 'restaurant', ownerName: '', pin: '', pin2: '', seed: true });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (f.pin !== f.pin2) return setErr("The two PINs don't match.");
    setBusy(true); setErr('');
    try {
      const { pin2, ...body } = f;
      await api('/setup', { method: 'POST', body });
      onDone();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  return (
    <div className="lock" style={{ overflow: 'auto' }}>
      <div className="lock-bg"><Aurora colorStops={['#ffb020', '#3a2a6b', '#ffb020']} amplitude={0.7} speed={0.4} mouseInteraction={false} /></div>
      <form className="lock-card" onSubmit={submit} style={{ textAlign: 'left', justifyItems: 'stretch', width: 'min(440px, 92vw)' }}>
        <div className="row"><Puck state="buzzed" size={40} /><div><h1 style={{ fontSize: '1.75rem' }}>Set up your command center</h1></div></div>
        <p className="muted" style={{ margin: 0 }}>Enter the six-digit setup code from your server logs. Only someone with server access can claim a new install.</p>
        <label className="field"><span>Setup code</span><input className="input" value={f.setupCode} onChange={set('setupCode')} inputMode="numeric" autoComplete="one-time-code" required /></label>
        <label className="field"><span>Business name</span><input className="input" value={f.businessName} onChange={set('businessName')} maxLength={60} required /></label>
        <label className="field"><span>Kind of business</span>
          <select className="input" value={f.businessType} onChange={set('businessType')}>
            <option value="restaurant">Restaurant or bar (tables + waitlist)</option>
            <option value="cafe">Café or counter service (order-ready buzzers)</option>
            <option value="service">Salon, clinic, shop (appointments + queue)</option>
          </select>
        </label>
        <label className="field"><span>Your name</span><input className="input" value={f.ownerName} onChange={set('ownerName')} maxLength={40} required /></label>
        <div className="row">
          <label className="field grow"><span>Owner PIN (4–8 digits)</span><input className="input" type="password" inputMode="numeric" pattern="\d{4,8}" value={f.pin} onChange={set('pin')} autoComplete="new-password" required /></label>
          <label className="field grow"><span>Repeat PIN</span><input className="input" type="password" inputMode="numeric" pattern="\d{4,8}" value={f.pin2} onChange={set('pin2')} autoComplete="new-password" required /></label>
        </div>
        <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.seed} onChange={set('seed')} /> Start with a sample floor plan and menu</label>
        {err && <div className="lock-msg" role="alert">{err}</div>}
        <button className="btn primary lg block" disabled={busy}>{busy ? 'Setting up…' : 'Create command center'}</button>
      </form>
    </div>
  );
}
