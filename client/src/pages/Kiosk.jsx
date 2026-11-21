import { useEffect, useRef, useState } from 'react';
import { api, applyAccent, money } from '../lib.js';
import { Puck } from '../ui.jsx';
import { CartLines, GuestMenu, PairsHint, useCart, useCombos } from '../order-ui.jsx';
import { LangSwitch, useLang } from '../i18n.jsx';

const kioskApi = (path, opts = {}) => api(path, { ...opts, headers: { 'X-Kiosk': localStorage.getItem('bh_kiosk') || '' } });

export default function Kiosk() {
  const { lang, setLang, t } = useLang();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const cart = useCart();
  const combos = useCombos(true);
  const [step, setStep] = useState('start');
  const [name, setName] = useState('');
  const [where, setWhere] = useState('togo');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [charge, setCharge] = useState(null);
  const [exit, setExit] = useState(null);
  const idle = useRef(null);
  const reset = () => { cart.clear(); setStep('start'); setName(''); setDone(null); setCharge(null); setErr(''); setLang(navigator.language?.startsWith('es') ? 'es' : 'en'); };
  useEffect(() => {
    kioskApi('/k/menu').then((x) => { setD(x); applyAccent(x.business.accent); document.title = `${x.business.name} kiosk`; }).catch((e) => setErr(e.message));
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  // go back to the start screen after a minute of no touches
  useEffect(() => {
    const poke = () => { clearTimeout(idle.current); idle.current = setTimeout(() => { if (!charge) reset(); }, done ? 25000 : 75000); };
    poke(); ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, poke));
    return () => { clearTimeout(idle.current); ['pointerdown', 'keydown'].forEach((e) => window.removeEventListener(e, poke)); };
  }, [done, charge]); // eslint-disable-line react-hooks/exhaustive-deps
  // card reader progress
  useEffect(() => {
    if (!charge || charge.status !== 'waiting') return undefined;
    const id = setInterval(() => kioskApi(`/k/charge/${charge.id}`).then(setCharge).catch(() => {}), 2000);
    return () => clearInterval(id);
  }, [charge]);

  if (err && !d) return <div className="kiosk"><div className="kiosk-start"><h1>{err}</h1><a className="btn" href="/">Open the command center</a></div></div>;
  if (!d) return <div className="kiosk" />;
  const tax = Math.round(cart.subtotal * d.taxRate / 100);
  const place = async (pay) => {
    setBusy(true); setErr('');
    try {
      const r = await kioskApi('/k/order', { method: 'POST', body: { items: cart.payload, name: name.trim(), where, pay, clientKey: crypto.randomUUID?.() } });
      setDone(r); setStep('done'); if (r.charge) setCharge(r.charge);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const leave = async () => { try { await kioskApi('/k/exit', { method: 'POST', body: { pin: exit } }); localStorage.removeItem('bh_kiosk'); document.exitFullscreen?.().catch(() => {}); location.href = '/'; } catch (e) { setErr(e.message); setExit(null); } };

  return (
    <div className="kiosk">
      <header className="kiosk-top">
        {d.business.logo ? <img src={d.business.logo} alt={d.business.name} style={{ height: 44 }} /> : <b style={{ fontSize: 22 }}>{d.business.name}</b>}
        <div className="grow" />
        <LangSwitch lang={lang} setLang={setLang} />
        <button className="kiosk-exit" onClick={() => setExit('')} aria-label="Staff: leave kiosk">·</button>
      </header>
      {exit !== null && (
        <div className="kiosk-pin"><b>Manager PIN to leave the kiosk</b><input className="input" type="password" inputMode="numeric" autoFocus value={exit} onChange={(e) => setExit(e.target.value.replace(/\D/g, '').slice(0, 8))} onKeyDown={(e) => e.key === 'Enter' && leave()} /><div className="row"><button className="btn grow" onClick={() => setExit(null)}>Cancel</button><button className="btn primary grow" onClick={leave}>Leave</button></div></div>
      )}
      {step === 'start' && (
        <button className="kiosk-start" onClick={() => setStep('menu')}>
          <Puck state="buzzed" size={120} />
          <h1>{t('Tap to start your order')}</h1>
          {d.message && <p>{d.message}</p>}
        </button>
      )}
      {step === 'menu' && (
        <div className="kiosk-grid">
          <div className="card kiosk-menu"><GuestMenu items={d.items} currency={d.currency} onAdd={cart.add} lang={lang} combos={combos} /></div>
          <aside className="card kiosk-cart">
            <b>{t('Your order')}</b>
            {cart.lines.length ? <><CartLines cart={cart} currency={d.currency} /><PairsHint cart={cart} items={d.items} currency={d.currency} label={t('Goes great with')} /></> : <span className="muted">{t('Nothing here yet. Tap an item to add it.')}</span>}
            <div className="totals"><div><span>{t('Subtotal')}</span><span>{money(cart.subtotal, d.currency)}</span></div><div><span>{t('Tax')}</span><span>{money(tax, d.currency)}</span></div><div className="grand"><span>{t('Total')}</span><span>{money(cart.subtotal + tax, d.currency)}</span></div></div>
            {d.dineIn && <div className="seg" style={{ width: '100%' }}><button aria-pressed={where === 'here'} onClick={() => setWhere('here')} style={{ flex: 1 }}>{t('Eat here')}</button><button aria-pressed={where === 'togo'} onClick={() => setWhere('togo')} style={{ flex: 1 }}>{t('To go')}</button></div>}
            <label className="field"><span>{t('Your name')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="off" /></label>
            {err && <div className="lock-msg">{err}</div>}
            {d.payCard && <button className="btn primary lg block" disabled={busy || !cart.count || !name.trim()} onClick={() => place('card')}>{t('Pay with card here')}</button>}
            <button className={`btn lg block ${d.payCard ? '' : 'primary'}`} disabled={busy || !cart.count || !name.trim()} onClick={() => place('counter')}>{d.payCard ? t('Pay at the counter') : t('Place order')}</button>
            <button className="btn ghost block" onClick={reset}>{t('Start over')}</button>
          </aside>
        </div>
      )}
      {step === 'done' && done && (
        <div className="kiosk-start" style={{ cursor: 'default' }}>
          {charge && charge.status !== 'paid' ? (
            <>
              <span className="pulse-dot" style={{ width: 28, height: 28 }} />
              <h1>{t('Tap, insert or swipe your card on the reader')}</h1>
              <p className="num" style={{ fontSize: 40 }}>{money(charge.amountCents, d.currency)}</p>
              {charge.error && <p style={{ color: 'var(--dirty)' }}>{charge.error}</p>}
              {charge.status === 'cancelled' && <p>{t('Pay at the counter when you pick it up.')}</p>}
            </>
          ) : (
            <>
              <span className="muted">{t('Your number')}</span>
              <div className="kiosk-number num">#{done.number}</div>
              {charge?.status === 'paid' ? <p>{t('Paid. Thank you!!')}</p> : <p>{t('Pay at the counter when you pick it up.')}</p>}
              <div className="row" style={{ alignItems: 'center', gap: 18 }}><div className="qr" style={{ width: 180, background: '#fff', padding: 10, borderRadius: 12 }} dangerouslySetInnerHTML={{ __html: done.svg }} /><p style={{ maxWidth: 260, textAlign: 'left' }}>{t('Scan to get a buzz on your phone when it’s ready')}</p></div>
              <button className="btn primary lg" onClick={reset}>{t('Done')}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
