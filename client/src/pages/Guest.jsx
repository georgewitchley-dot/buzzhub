import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { gsap } from 'gsap';
import Aurora from '../bits/Aurora.jsx';
import StarBorder from '../bits/StarBorder.jsx';
import { api, applyAccent, connectGuest, playBuzz, unlockAudio, useLenis } from '../lib.js';

const ACTIVE = ['waiting', 'buzzed', 'acknowledged'];

export default function Guest() {
  const { token } = useParams();
  const [g, setG] = useState(null);
  const [err, setErr] = useState('');
  const [armed, setArmed] = useState(false);
  const [online, setOnline] = useState(true);
  const puckRef = useRef(null); const flashRef = useRef(null); const wakeRef = useRef(null);
  const armedRef = useRef(false); armedRef.current = armed;
  useLenis();

  const alarm = useCallback((message) => {
    if (armedRef.current) playBuzz(3);
    navigator.vibrate?.([400, 150, 400, 150, 800]);
    const waves = puckRef.current?.querySelectorAll('.wave');
    if (waves?.length) gsap.fromTo(waves, { scale: 1, opacity: 0.9 }, { scale: 1.9, opacity: 0, duration: 1.6, stagger: 0.35, ease: 'power2.out', repeat: 2 });
    gsap.fromTo(puckRef.current, { rotate: 0 }, { keyframes: { rotate: [-5, 5, -4, 4, -2, 0] }, duration: 0.6, repeat: 2 });
    gsap.fromTo(flashRef.current, { opacity: 0 }, { keyframes: { opacity: [0.55, 0, 0.45, 0, 0.35, 0] }, duration: 1.4 });
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(document.title, { body: message, tag: 'buzz', requireInteraction: true }); } catch { /* some mobile browsers only allow SW notifications */ }
    }
  }, []);

  useEffect(() => {
    api(`/g/${token}`).then((d) => { setG(d); applyAccent(d.business.accent); document.title = d.business.name; }).catch((e) => setErr(e.message));
    const s = connectGuest(token);
    s.on('connect', () => setOnline(true));
    s.on('disconnect', () => setOnline(false));
    s.on('guest:update', (d) => setG(d));
    s.on('buzz', ({ message }) => alarm(message));
    return () => s.disconnect();
  }, [token, alarm]);

  // keep nagging every 20s until they confirm
  useEffect(() => {
    if (g?.status !== 'buzzed') return;
    const t = setInterval(() => alarm(g.lastMessage), 20000);
    return () => clearInterval(t);
  }, [g?.status, g?.lastMessage, alarm]);

  const arm = async () => {
    unlockAudio(); playBuzz(1); navigator.vibrate?.(120);
    setArmed(true);
    try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch { /* ignore */ }
    try { wakeRef.current = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
  };
  useEffect(() => {
    const re = async () => { if (armed && document.visibilityState === 'visible') try { wakeRef.current = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ } };
    document.addEventListener('visibilitychange', re);
    return () => document.removeEventListener('visibilitychange', re);
  }, [armed]);

  const ack = () => api(`/g/${token}/ack`, { method: 'POST' }).catch(() => {});
  const leave = () => confirm('Leave the list? You will lose your spot.') && api(`/g/${token}/leave`, { method: 'POST' }).catch(() => {});

  if (err) return <div className="guest"><div className="guest-in"><h1>Link not found</h1><p>{err} Ask the host for a new code.</p></div></div>;
  if (!g) return <div className="guest" />;

  const isOrder = g.kind === 'order';
  const unit = g.business.unitLabel.toLowerCase();
  let headline; let sub; let core;
  if (g.status === 'buzzed') {
    headline = isOrder ? 'Your order is ready' : `Your ${unit} is ready`;
    sub = g.lastMessage; core = <><b style={{ fontSize: 'clamp(3rem,16vw,4.5rem)' }}>{g.tableLabel || (isOrder ? `#${g.orderNumber}` : 'Now')}</b><span>{g.tableLabel ? g.business.unitLabel : 'Head over'}</span></>;
  } else if (g.status === 'acknowledged') {
    headline = 'See you in a moment'; sub = "We've let the team know you're on the way.";
    core = <><b style={{ fontSize: 'clamp(3rem,16vw,4.5rem)' }}>{g.tableLabel || '✓'}</b><span>{g.tableLabel ? g.business.unitLabel : 'On the way'}</span></>;
  } else if (g.status === 'waiting') {
    headline = `Hi ${g.name}, you're on the list`;
    sub = isOrder ? `Order #${g.orderNumber} is being made. Keep this page open and your phone will buzz when it's ready.` : g.business.welcome;
    core = isOrder ? <><b>#{g.orderNumber}</b><span>Order</span></> : <><b>{g.position}</b><span>{g.position === 1 ? "You're next" : 'in line'}</span></>;
  } else {
    headline = ['seated', 'done'].includes(g.status) ? 'Enjoy!' : "You're off the list";
    sub = ['seated', 'done'].includes(g.status) ? `Thanks for visiting ${g.business.name}.` : 'If this was a mistake, see the host.';
    core = <><b style={{ fontSize: 'clamp(3rem,16vw,4.5rem)' }}>{['seated', 'done'].includes(g.status) ? '✓' : '—'}</b></>;
  }

  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[g.business.accent, '#2a1f55', g.business.accent]} amplitude={g.status === 'buzzed' ? 1.4 : 0.7} speed={g.status === 'buzzed' ? 1.6 : 0.4} mouseInteraction={false} /></div>
      <div className="flash" ref={flashRef} />
      <main className="guest-in">
        <div className="guest-biz">{g.business.name}</div>
        <div className="big-puck" ref={puckRef} data-state={g.status} role="img" aria-label={headline}>
          <span className="wave" /><span className="wave" /><span className="wave" />
          <span className="ring" />
          <div className="core">{core}</div>
        </div>
        <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }} aria-live="assertive">
          <h1>{headline}</h1>
          {sub && <p>{sub}</p>}
        </div>

        {ACTIVE.includes(g.status) && !armed && (
          <StarBorder as="button" onClick={arm} color={g.business.accent} radius={16} style={{ width: '100%' }}>
            <span style={{ display: 'block', padding: '6px 0', fontWeight: 700, fontSize: 17 }}>Turn on sound and alerts</span>
          </StarBorder>
        )}
        {g.status === 'buzzed' && (
          <button className="btn primary lg block" onClick={ack} style={{ height: 64, fontSize: 19 }}>I'm on my way</button>
        )}

        {g.status === 'waiting' && !isOrder && (
          <div className="facts">
            <div><b>{g.position}</b><span>Your place</span></div>
            <div><b>~{g.estMinutes}m</b><span>Est. wait</span></div>
            <div><b>{g.partySize}</b><span>Party</span></div>
          </div>
        )}

        {ACTIVE.includes(g.status) && (
          <div className="card">
            <b>Keep this page open</b>
            <span className="muted" style={{ fontSize: 14 }}>
              {armed ? 'Alerts are on. ' : 'Tap the button above so your phone can make noise. '}
              Your screen will stay awake while you wait. On iPhone, sound and the screen flash do the buzzing because iOS doesn't allow websites to vibrate.
            </span>
            <span className="row" style={{ fontSize: 13 }}><span className={`live ${online ? '' : 'off'}`}><i />{online ? 'Connected' : 'Reconnecting…'}</span></span>
          </div>
        )}
        {g.status === 'waiting' && !isOrder && <button className="btn ghost" onClick={leave}>Leave the list</button>}
      </main>
    </div>
  );
}
