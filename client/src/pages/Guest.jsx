import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gsap } from 'gsap';
import { DeliveryMap } from '../track.jsx';
import { LangSwitch, getLang, useLang } from '../i18n.jsx';
import Aurora from '../bits/Aurora.jsx';
import StarBorder from '../bits/StarBorder.jsx';
import { CartLines, GuestMenu, useCart } from '../order-ui.jsx';
import {
  api, applyAccent, connectGuest, enablePush, isIOS, isStandalone, money, playBuzz, playChime, pushSupported,
  pushIsOn, registerSW, withLoc, setManifest, unlockAudio, useLenis,
} from '../lib.js';
import { Curbside } from './Pace.jsx';
import { ShelfCard } from './Pass.jsx';

const ACTIVE = ['waiting', 'buzzed', 'acknowledged'];
const ORDER_STATUS = { held: 'Waiting for your table', sent: 'Being made now', ready: 'Ready', open: 'Being made now', paid: 'Paid', void: 'Cancelled' };

/* ---------- order-ahead menu sheet ---------- */
function ChatSheet({ token, t, onClose, onSeen }) {
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const log = useRef(null);
  const load = useCallback(() => api(`/g/${token}/messages`).then((x) => { setD(x); onSeen(); }).catch(() => {}), [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); const id = setInterval(load, 5000); window.addEventListener('bh:chat', load); return () => { clearInterval(id); window.removeEventListener('bh:chat', load); }; }, [load]);
  useEffect(() => { log.current?.scrollTo(0, log.current.scrollHeight); }, [d?.messages?.length]);
  const send = async () => { if (!text.trim()) return; try { await api(`/g/${token}/messages`, { method: 'POST', body: { body: text } }); setText(''); setErr(''); load(); } catch (e) { setErr(e.message); } };
  return (
    <div className="overlay sheet-wrap" role="dialog" aria-label={t('Messages')} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="row"><b className="grow" style={{ fontSize: 18 }}>{t('Messages')}</b><button className="btn ghost sm" onClick={onClose}>×</button></div>
        <div className="chat">
          <div className="chat-log" ref={log}>
            {d && d.messages.length === 0 && <span className="muted" style={{ fontSize: 14 }}>{t('Ask us anything: a high chair, a change to your order, running late.')}</span>}
            {d?.messages.map((m) => <div key={m.id} className={`bubble ${m.sender === 'guest' ? 'me' : 'them'}`}>{m.body}<small>{m.from}</small></div>)}
          </div>
          {err && <div className="lock-msg">{err}</div>}
          <div className="row"><input className="input grow" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} maxLength={500} placeholder={t('Type a message')} aria-label={t('Type a message')} /><button className="btn primary" onClick={send} disabled={!text.trim()}>{t('Send')}</button></div>
        </div>
      </div>
    </div>
  );
}

function MenuSheet({ token, g, onClose }) {
  const [menu, setMenu] = useState(null);
  const cart = useCart();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sheet = useRef(null);
  const canOrder = g.preorder.open && (!g.preorder.order || g.preorder.order.status === 'held');
  useEffect(() => {
    api(`/g/${token}/menu`).then(setMenu).catch((e) => setErr(e.message));
    gsap.fromTo(sheet.current, { yPercent: 100 }, { yPercent: 0, duration: 0.45, ease: 'power3.out' });
  }, [token]);
  const place = async () => {
    setBusy(true); setErr('');
    try { await api(`/g/${token}/preorder`, { method: 'POST', body: { items: cart.payload } }); navigator.vibrate?.(60); playChime(); onClose(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="overlay sheet-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" ref={sheet} role="dialog" aria-modal="true" aria-label="Menu">
        <div className="sheet-grip" />
        <header className="row"><h2 className="grow">{canOrder ? 'Order ahead' : 'Menu'}</h2><button className="btn ghost sm" onClick={onClose}>Close</button></header>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {canOrder ? `We'll start making these when your table is called, so they're waiting when you sit down. You pay at your table.${g.preorder.order ? ' Your new order replaces the one you placed.' : ''}`
            : g.preorder.order ? 'Your order is already being made. Ask your server to add more.'
            : `Ordering opens about ${g.preorder.opensInMinutes} minutes from now. Have a look in the meantime.`}
        </p>
        {!menu && !err && <p className="muted">Loading the menu…</p>}
        {menu && menu.items.length === 0 && <p className="muted">Nothing is available to order ahead right now.</p>}
        {menu && <GuestMenu items={canOrder ? menu.items : menu.items.map((i) => ({ ...i, soldOut: true }))} currency={menu.currency} onAdd={cart.add} lang={getLang()} />}
        {cart.count > 0 && <div><CartLines cart={cart} currency={menu.currency} /></div>}
        {err && <div className="lock-msg">{err}</div>}
        {canOrder && (
          <button className="btn primary lg block" disabled={!cart.count || busy} onClick={place}>
            {busy ? 'Sending…' : cart.count ? `${g.preorder.order ? 'Replace' : 'Place'} order, ${money(cart.subtotal, menu?.currency)} + tax` : 'Pick something above'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function Guest() {
  const { lang, setLang, t } = useLang();
  const { token } = useParams();
  const [g, setG] = useState(null);
  const [err, setErr] = useState('');
  const [alerts, setAlerts] = useState('off'); // off | on | denied | needs-install | unsupported
  const [online, setOnline] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(() => new URLSearchParams(location.search).get('chat') === '1');
  const [chatNew, setChatNew] = useState(0);
  const [email, setEmail] = useState('');
  const [banner, setBanner] = useState('');
  const puckRef = useRef(null); const flashRef = useRef(null); const wakeRef = useRef(null);
  const soundOn = useRef(false); const onlineRef = useRef(true);
  useLenis();

  const alarm = useCallback((message) => {
    if (soundOn.current) playBuzz(3);
    navigator.vibrate?.([400, 150, 400, 150, 800]);
    const waves = puckRef.current?.querySelectorAll('.wave');
    if (waves?.length) gsap.fromTo(waves, { scale: 1, opacity: 0.9 }, { scale: 1.9, opacity: 0, duration: 1.6, stagger: 0.35, ease: 'power2.out', repeat: 2 });
    gsap.fromTo(puckRef.current, { rotate: 0 }, { keyframes: { rotate: [-5, 5, -4, 4, -2, 0] }, duration: 0.6, repeat: 2 });
    gsap.fromTo(flashRef.current, { opacity: 0 }, { keyframes: { opacity: [0.55, 0, 0.45, 0, 0.35, 0] }, duration: 1.4 });
    if (message) setBanner('');
  }, []);
  const headsUp = useCallback((message) => {
    if (soundOn.current) playChime();
    navigator.vibrate?.([200, 100, 200]);
    setBanner(message);
  }, []);

  useEffect(() => {
    if (isIOS()) setManifest(`/api/g/${token}/manifest.webmanifest`);
    const sid = new URLSearchParams(window.location.search).get('session_id');
    if (sid) api(`/g/${token}/confirm?session_id=${encodeURIComponent(sid)}`).catch(() => {});
    registerSW();
    api(`/g/${token}`).then((d) => {
      setG(d); applyAccent(d.business.accent); document.title = d.business.name;
      if (['waiting', 'buzzed', 'acknowledged'].includes(d.status)) pushIsOn(`/g/${token}/push`).then((on) => on && setAlerts('on'));
    }).catch((e) => setErr(e.message));
    const s = connectGuest(token);
    s.on('connect', () => { setOnline(true); onlineRef.current = true; });
    s.on('disconnect', () => { setOnline(false); onlineRef.current = false; });
    s.on('guest:update', (d) => setG(d));
    s.on('buzz', ({ message }) => alarm(message));
    s.on('chat', () => { setChatNew((n) => n + 1); window.dispatchEvent(new Event('bh:chat')); try { navigator.vibrate?.([120, 60, 120]); } catch { /* not supported */ } });
    s.on('headsup', ({ message }) => headsUp(message));
    // if the live connection dropped, the service worker still relays pushes to the open page
    const onSw = (e) => { if (e.data?.type === 'push' && !onlineRef.current) (e.data.data.kind === 'buzz' ? alarm : headsUp)(e.data.data.body); };
    navigator.serviceWorker?.addEventListener('message', onSw);
    return () => { s.disconnect(); navigator.serviceWorker?.removeEventListener('message', onSw); };
  }, [token, alarm, headsUp]);

  // keep nagging every 20s until they confirm
  useEffect(() => {
    if (g?.status !== 'buzzed') return;
    const t = setInterval(() => alarm(), 20000);
    return () => clearInterval(t);
  }, [g?.status, alarm]);

  const turnOn = async () => {
    unlockAudio(); soundOn.current = true; playChime(); navigator.vibrate?.(80);
    try { wakeRef.current = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
    try { setAlerts(await enablePush(`/g/${token}/push`)); } catch { setAlerts('unsupported'); }
  };
  useEffect(() => {
    const re = async () => { if (soundOn.current && document.visibilityState === 'visible') try { wakeRef.current = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ } };
    document.addEventListener('visibilitychange', re);
    return () => document.removeEventListener('visibilitychange', re);
  }, []);

  const ack = () => api(`/g/${token}/ack`, { method: 'POST' }).catch(() => {});
  const leave = () => confirm('Leave the list? You will lose your spot.') && api(`/g/${token}/leave`, { method: 'POST' }).catch(() => {});
  const cancelOrder = () => confirm('Cancel your order?') && api(`/g/${token}/preorder/cancel`, { method: 'POST' }).catch((e) => alert(e.message));
  const saveEmail = async (e) => { e.preventDefault(); await api(`/g/${token}/email`, { method: 'POST', body: { email, notify: true } }).catch((x) => alert(x.message)); };

  if (err) return <div className="guest"><div className="guest-in"><h1>Link not found</h1><p>{err} Ask the host for a new code.</p></div></div>;
  if (!g) return <div className="guest" />;

  const isOrder = g.kind === 'order';
  const unit = g.business.unitLabel.toLowerCase();
  let headline; let sub; let core;
  if (g.status === 'buzzed') {
    headline = isOrder ? t('Your order is ready') : t('Your {unit} is ready', { unit });
    sub = g.lastMessage; core = <><b style={{ fontSize: 'clamp(3rem,16vw,4.5rem)' }}>{g.tableLabel || (isOrder ? `#${g.orderNumber}` : 'Now')}</b><span>{g.tableLabel ? g.business.unitLabel : 'Head over'}</span></>;
  } else if (g.status === 'acknowledged') {
    headline = t('See you in a moment'); sub = t("We've let the team know you're on the way.");
    core = <><b style={{ fontSize: 'clamp(3rem,16vw,4.5rem)' }}>{g.tableLabel || '✓'}</b><span>{g.tableLabel ? g.business.unitLabel : 'On the way'}</span></>;
  } else if (g.status === 'waiting') {
    headline = isOrder ? t('Thanks {name}, your order is in', { name: g.name }) : g.headsUp ? t('Almost your turn') : t("Hi {name}, you're on the list", { name: g.name });
    sub = isOrder ? t("Order #{n} is being made. We'll buzz your phone when it's ready.", { n: g.orderNumber }) : g.headsUp ? t('Please stay close. We will buzz you any minute.') : g.business.welcome;
    core = isOrder ? <><b>#{g.orderNumber}</b><span>Order</span></> : <><b>{g.position}</b><span>{g.position === 1 ? t("You're next") : t('in line')}</span></>;
  } else {
    headline = ['seated', 'done'].includes(g.status) ? t('Enjoy!') : t("You're off the list");
    sub = ['seated', 'done'].includes(g.status) ? `Thanks for visiting ${g.business.name}.` : 'If this was a mistake, see the host.';
    core = <><b style={{ fontSize: 'clamp(3rem,16vw,4.5rem)' }}>{['seated', 'done'].includes(g.status) ? '✓' : '—'}</b></>;
  }
  const dv = g.delivery;
  if (dv?.status === 'out' && ACTIVE.includes(g.status)) {
    headline = t('On its way');
    sub = `${dv.driverName || t('Your driver')} ${t('is bringing your order')}.${dv.etaMinutes ? ` ${t('About {n} minutes away', { n: dv.etaMinutes })}.` : ''}`;
    core = <><b>{dv.etaMinutes ? `${dv.etaMinutes}′` : '🚗'}</b><span>{dv.etaMinutes ? 'ETA' : `#${g.orderNumber}`}</span></>;
  }
  if (dv?.status === 'delivered') { headline = t('Delivered. Enjoy!'); }
  const active = ACTIVE.includes(g.status);
  const po = g.preorder;

  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[g.business.accent, '#2a1f55', g.business.accent]} amplitude={g.status === 'buzzed' ? 1.4 : 0.7} speed={g.status === 'buzzed' ? 1.6 : 0.4} mouseInteraction={false} /></div>
      <div className="flash" ref={flashRef} />
      <main className="guest-in">
        <LangSwitch lang={lang} setLang={setLang} />
        {g.business.logo ? <img className="guest-logo" src={g.business.logo} alt={g.business.name} /> : <div className="guest-biz">{g.business.name}</div>}
        <div className="big-puck" ref={puckRef} data-state={g.status} role="img" aria-label={headline}>
          <span className="wave" /><span className="wave" /><span className="wave" />
          <span className="ring" />
          <div className="core">{core}</div>
        </div>
        <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }} aria-live="assertive">
          <h1>{headline}</h1>
          {sub && <p>{sub}</p>}
        </div>
        {dv?.status === 'out' && dv.driver && <DeliveryMap driver={dv.driver} drop={dv.drop} />}
        {g.dropPhoto && <figure className="drop-photo"><img src={`/api/g/${token}/drop-photo`} alt={t('Where your order was left')} /><figcaption>{t('Where your order was left')}</figcaption></figure>}
        {banner && g.status === 'waiting' && <div className="card banner" role="status">{banner}</div>}

        {g.status === 'buzzed' && <button className="btn primary lg block" onClick={ack} style={{ height: 64, fontSize: 19 }}>{t("I'm on my way")}</button>}

        {active && alerts === 'off' && !(isIOS() && !isStandalone()) && (
          <StarBorder as="button" onClick={turnOn} color={g.business.accent} radius={16} style={{ width: '100%' }}>
            <span style={{ display: 'block', padding: '6px 0', fontWeight: 700, fontSize: 17 }}>{t('Turn on alerts')}</span>
          </StarBorder>
        )}

        {g.status === 'waiting' && !isOrder && (
          <div className="facts">
            <div><b>{g.position}</b><span>Your place</span></div>
            <div><b>~{g.estMinutes}m</b><span>Est. wait</span></div>
            <div><b>{g.partySize}</b><span>Party</span></div>
          </div>
        )}

        {po.enabled && (active || po.order) && (
          <div className="card">
            <div className="row"><b className="grow">{po.order ? `Your order #${po.order.number}` : 'Order drinks ahead'}</b>{po.order && <span className={`chip ${po.order.status === 'held' ? 'amber' : 'teal'}`}>{ORDER_STATUS[po.order.status]}</span>}</div>
            {po.order ? (
              <>
                <div style={{ fontSize: 14 }}>{po.order.items.map((i) => <div key={i.name} className="row"><span className="grow">{i.qty} × {i.name}</span></div>)}</div>
                <div className="muted" style={{ fontSize: 13 }}>Total {money(po.order.totalCents)} with tax. Pay at your table.</div>
                {po.order.status === 'held' && <div className="row"><button className="btn sm grow" onClick={() => setMenuOpen(true)}>Change order</button><button className="btn sm ghost danger" onClick={cancelOrder}>Cancel</button></div>}
              </>
            ) : po.open ? (
              <>
                <span className="muted" style={{ fontSize: 14 }}>Order now and your drinks will be waiting when you sit down.</span>
                <button className="btn primary block" onClick={() => setMenuOpen(true)}>See the menu and order</button>
              </>
            ) : (
              <>
                <span className="muted" style={{ fontSize: 14 }}>Ordering opens about {po.opensInMinutes} minutes from now. We'll send you an alert.</span>
                <button className="btn block" onClick={() => setMenuOpen(true)}>Browse the menu</button>
              </>
            )}
          </div>
        )}

        {g.shelf && <ShelfCard s={g.shelf} />}
        {g.curbside && <Curbside token={token} c={g.curbside} />}

        {active && (
          <div className="card">
            <b>{alerts === 'on' ? 'Alerts are on' : 'Get alerts on this phone'}</b>
            {alerts === 'on' && <span className="muted" style={{ fontSize: 14 }}>We'll send a notification to this phone when it's your turn, even if you close this page.</span>}
            {alerts === 'off' && <span className="muted" style={{ fontSize: 14 }}>Tap "Turn on alerts" and allow notifications. Your phone buzzes when it's your turn, even with this page closed.</span>}
            {alerts === 'denied' && <span className="muted" style={{ fontSize: 14 }}>Notifications are blocked for this site. Allow them in your browser settings, or keep this page open and we'll sound the alarm here.</span>}
            {alerts === 'unsupported' && <span className="muted" style={{ fontSize: 14 }}>This browser can't receive notifications. Keep this page open and we'll sound the alarm here.</span>}
            {(alerts === 'needs-install' || (isIOS() && !isStandalone() && alerts === 'off')) && (
              <ol className="steps">
                <li>Tap the <b>Share</b> button in Safari.</li>
                <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
                <li>Open <b>{g.business.name}</b> from your home screen and tap <b>Turn on alerts</b>.</li>
              </ol>
            )}
            {!pushSupported() && !isIOS() && <span className="dim" style={{ fontSize: 13 }}>Keep this page open as a backup.</span>}
            <span className="row" style={{ fontSize: 13 }}><span className={`live ${online ? '' : 'off'}`}><i />{online ? 'Connected' : 'Reconnecting…'}</span></span>
            {g.emailAvailable && !g.hasEmail && (
              <form className="row" onSubmit={saveEmail}>
                <input className="input grow" type="email" placeholder="Email me too (optional)" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} aria-label="Email" />
                <button className="btn" disabled={!email}>Save</button>
              </form>
            )}
            {g.emailAlerts && <span className="dim" style={{ fontSize: 13 }}>We'll also email you.</span>}
          </div>
        )}
        {g.chat !== false && !['removed', 'no_show'].includes(g.status) && <button className="btn block" onClick={() => setChatOpen(true)}>{t('Message us')}{chatNew > 0 ? ` (${chatNew})` : ''}</button>}
        {g.status === 'waiting' && !isOrder && <button className="btn ghost" onClick={leave}>Leave the list</button>}
        {g.business.booking && !g.customer && <Link className="btn ghost sm" to={withLoc('/account', g.business.slug)}>Create an account to book ahead next time</Link>}
      </main>
      {menuOpen && <MenuSheet token={token} g={g} onClose={() => setMenuOpen(false)} />}
      {chatOpen && <ChatSheet token={token} t={t} onClose={() => setChatOpen(false)} onSeen={() => setChatNew(0)} />}
    </div>
  );
}
