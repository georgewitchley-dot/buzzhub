import { useCallback, useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import Aurora from '../bits/Aurora.jsx';
import SplitText from '../bits/SplitText.jsx';
import ShinyText from '../bits/ShinyText.jsx';
import { api } from '../lib.js';
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
  const dotsRef = useRef(null);

  useEffect(() => {
    if (!lockedFor) return;
    const t = setInterval(() => setLockedFor((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [lockedFor]);

  const submit = async () => {
    if (pin.length < 4 || busy || lockedFor) return;
    setBusy(true); setMsg('');
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { pin } });
      onUnlocked(user);
    } catch (e) {
      setPin('');
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
        <ShinyText text={lockedFor ? `Terminal locked for ${lockedFor}s` : 'Enter your PIN to open the command center'} color="#8c8fa0" shineColor="#ece8df" speed={3} />
        <div className="dots" ref={dotsRef} aria-live="polite" aria-label={`${pin.length} digits entered`}>
          {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
        </div>
        <PinPad value={pin} onChange={(v) => { setPin(v); setMsg(''); }} onSubmit={submit} disabled={busy || lockedFor > 0} />
        <div className="lock-msg" role="alert">{msg}</div>
      </div>
    </div>
  );
}
