import { useCallback, useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import Aurora from '../bits/Aurora.jsx';
import SplitText from '../bits/SplitText.jsx';
import ShinyText from '../bits/ShinyText.jsx';
import { api, setLoc } from '../lib.js';
import { Puck } from '../ui.jsx';

export function PinPad({ value, onChange, onSubmit, max = 8, disabled }) {
  const press = useCallback((k) => {
    if (disabled) return;
    if (k === 'del') onChange(value.slice(0, -1));
    else if (k === 'ok') onSubmit();
    else if (value.length < max) onChange(value + k);
  }, [value, onChange, onSubmit, max, disabled]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') press('ok');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  return (
    <div className="keypad" role="group" aria-label="PIN keypad">
      {keys.map((k) => (
        <button key={k} type="button" className={`key ${k.length > 1 ? 'fn' : ''}`} onClick={() => press(k)} disabled={disabled}
          aria-label={k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k}>
          {k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k}
        </button>
      ))}
    </div>
  );
}

export default function Lock({ business, onUnlocked }) {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [lockedFor, setLockedFor] = useState(0);
  const [mode, setMode] = useState('unlock');
  const [ticket, setTicket] = useState(null); // two-step: { ticket, name }
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [ok, setOk] = useState('');
  const [locs, setLocs] = useState(null);
  useEffect(() => { api('/public/locations').then(setLocs).catch(() => {}); }, []);
  const dotsRef = useRef(null);

  useEffect(() => {
    if (!lockedFor) return;
    const t = setInterval(() => setLockedFor((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [lockedFor]);

  const submit = async () => {
    if (busy || lockedFor) return;
    if (ticket ? (useRecovery ? recovery.length < 10 : pin.length !== 6) : pin.length < 4) return;
    setBusy(true); setMsg(''); setOk('');
    try {
      if (mode === 'clock') {
        const r = await api('/auth/clock', { method: 'POST', body: { pin } });
        setPin(''); setMode('unlock');
        setOk(r.action === 'in' ? `${r.name}, you're clocked in. Have a good shift.` : `${r.name}, you're clocked out after ${Math.floor(r.hours)}h ${Math.round((r.hours % 1) * 60)}m.`);
        setTimeout(() => setOk(''), 6000);
        return;
      }
      if (ticket) {
        const { user } = await api('/auth/2fa', { method: 'POST', body: { ticket: ticket.ticket, code: useRecovery ? recovery : pin } });
        onUnlocked(user); return;
      }
      const r = await api('/auth/login', { method: 'POST', body: { pin } });
      if (r.needs2fa) { setTicket({ ticket: r.ticket, name: r.name }); setPin(''); return; }
      onUnlocked(r.user);
    } catch (e) {
      setPin(''); setRecovery('');
      if (e.data?.deviceApproval) { setMsg(`This device needs the owner's approval. Ask them to approve code ${e.data.code} in Security.`); return; }
      if (ticket && !e.data?.needs2fa) setTicket(null);
      setMsg(e.data?.remaining > 0 ? `Wrong PIN. ${e.data.remaining} tries left before this terminal locks.` : e.message);
      if (e.data?.lockedFor) setLockedFor(e.data.lockedFor);
      gsap.fromTo(dotsRef.current, { x: 0 }, { keyframes: { x: [-14, 12, -9, 6, -3, 0] }, duration: 0.45, ease: 'power2.out' });
    } finally { setBusy(false); }
  };

  return (
    <div className="lock">
      <div className="lock-bg"><Aurora colorStops={[business?.accent || '#ffb020', '#3a2a6b', business?.accent || '#ffb020']} amplitude={0.8} blend={0.6} speed={0.5} mouseInteraction={false} /></div>
      <div className="lock-card">
        <Puck state="buzzed" size={46} />
        <SplitText text={business?.name || 'BuzzHub'} tag="h1" splitType="chars" delay={28} duration={0.9} trigger="load" />
        <ShinyText text={lockedFor ? `Terminal locked for ${lockedFor}s` : ticket ? `${ticket.name}, enter the 6-digit code from your authenticator app` : mode === 'clock' ? 'Enter your PIN to clock in or out' : 'Enter your PIN to open the command center'} color="#8c8fa0" shineColor="#ece8df" speed={3} />
        <div className="dots" ref={dotsRef} aria-live="polite" aria-label={`${pin.length} digits entered`}>
          {Array.from({ length: Math.max(ticket ? 6 : 4, pin.length) }).map((_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
        </div>
        {ticket && useRecovery ? (
          <form className="stack" style={{ width: '100%' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <input className="input" value={recovery} onChange={(e) => setRecovery(e.target.value.trim().toLowerCase())} placeholder="Recovery code" maxLength={12} autoFocus aria-label="Recovery code" style={{ textAlign: 'center', fontSize: 18, letterSpacing: 2 }} />
            <button className="btn primary block" disabled={recovery.length < 10}>Unlock</button>
          </form>
        ) : <PinPad value={pin} onChange={(v) => { setPin(v); setMsg(''); }} onSubmit={submit} disabled={busy || lockedFor > 0} max={ticket ? 6 : 8} />}
        <div className="lock-msg" role="alert" style={ok ? { color: 'var(--seated)' } : undefined}>{ok || msg}</div>
        {locs?.locations.length > 0 && !ticket && (
          <select className="input" style={{ maxWidth: 300 }} value={locs.current} onChange={(e) => { setLoc(e.target.value); window.location.reload(); }} aria-label="Which location is this terminal at?">
            {locs.locations.map((l) => <option key={l.slug} value={l.slug}>This terminal is at {l.name}</option>)}
          </select>
        )}
        {ticket ? (
          <div className="row">
            <button type="button" className="btn ghost sm" onClick={() => setUseRecovery(!useRecovery)}>{useRecovery ? 'Use the app code' : 'Lost your phone? Use a recovery code'}</button>
            <button type="button" className="btn ghost sm" onClick={() => { setTicket(null); setPin(''); setUseRecovery(false); }}>Start over</button>
          </div>
        ) : (
        <div className="seg" role="group" aria-label="What the PIN does">
          <button type="button" aria-pressed={mode === 'unlock'} onClick={() => setMode('unlock')}>Open command center</button>
          <button type="button" aria-pressed={mode === 'clock'} onClick={() => setMode('clock')}>Clock in or out</button>
        </div>
        )}
      </div>
    </div>
  );
}
