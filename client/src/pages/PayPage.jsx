import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent, money } from '../lib.js';
import { Puck } from '../ui.jsx';
import { LangSwitch, useLang } from '../i18n.jsx';

// cheapest for the business first
const ORDER = { zelle: 0, venmo: 1, card: 2, cashapp: 3, paypal: 4, paypalme: 5 };
const FEE_NOTE = { zelle: 'No fees for us', venmo: 'Lowest fee', bank: 'Lowest fee' };

function loadPayPal(clientId, currency) {
  if (window.paypal) return Promise.resolve(window.paypal);
  return new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${currency}&components=buttons&enable-funding=venmo&disable-funding=paylater,card`;
    s.onload = () => ok(window.paypal); s.onerror = bad; document.head.appendChild(s);
  });
}

function PayPalButtons({ token, method, onPaid, onError }) {
  const box = useRef(null);
  useEffect(() => {
    let dead = false;
    loadPayPal(method.clientId, method.currency).then((pp) => {
      if (dead || !box.current) return;
      box.current.innerHTML = '';
      const opts = (fundingSource) => ({
        fundingSource, style: { layout: 'vertical', shape: 'rect', height: 48 },
        createOrder: () => api(`/pay/${token}/paypal`, { method: 'POST' }).then((r) => r.id),
        onApprove: (d) => api(`/pay/${token}/paypal/capture`, { method: 'POST', body: { orderId: d.orderID } }).then(onPaid).catch((e) => onError(e.message)),
        onError: () => onError('PayPal could not finish. Please try again or choose another way to pay.'),
      });
      for (const f of [pp.FUNDING.VENMO, pp.FUNDING.PAYPAL]) { const b = pp.Buttons(opts(f)); if (b.isEligible()) b.render(box.current); }
    }).catch(() => onError("PayPal didn't load. Check your connection."));
    return () => { dead = true; };
  }, [token, method.clientId]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={box} className="pp-box" />;
}

export default function PayPage() {
  const { token } = useParams();
  const { lang, setLang, t } = useLang();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [picked, setPicked] = useState(null);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const params = new URLSearchParams(location.search);
  const go = (next) => { if (next) location.href = next; };
  const load = () => api(`/pay/${token}`).then((x) => { setD(x); applyAccent(x.business.accent); document.title = `${x.business.name}: ${t('Pay')}`; if (x.status === 'paid' && x.successUrl) setTimeout(() => go(x.successUrl), 900); return x; });
  useEffect(() => {
    (params.get('back') ? (setChecking(true), api(`/pay/${token}/verify`, { method: 'POST', body: { ref: params.get('ref') || '' } }).then((r) => { if (r.paid) go(r.next); else { setChecking(false); if (r.processing) setD((x) => (x ? { ...x, bankStatus: 'processing' } : x)); } })) : Promise.resolve())
      .catch(() => setChecking(false)).finally(() => load().catch((e) => setErr(e.message)));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // waiting for staff to confirm an app payment
  useEffect(() => { if (!d?.claimed || d.status === 'paid') return undefined; const id = setInterval(() => load().catch(() => {}), 5000); return () => clearInterval(id); }, [d?.claimed, d?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="guest"><main className="guest-in"><h1>{t('This payment link is not valid.')}</h1></main></div>;
  if (!d) return <div className="guest"><main className="guest-in">{checking && <p>{t('Confirming your payment…')}</p>}</main></div>;
  const amount = money(d.amountCents, d.currency);
  const methods = [...d.methods].sort((a, b) => (ORDER[a.app || a.kind] ?? 9) - (ORDER[b.app || b.kind] ?? 9));
  const bank = async () => { try { const r = await api(`/pay/${token}/bank`, { method: 'POST' }); if (r.url) location.href = r.url; else go(r.next); } catch (e) { setMsg(e.message); } };
  const card = async () => { try { const r = await api(`/pay/${token}/card`, { method: 'POST' }); if (r.url) location.href = r.url; else go(r.next); } catch (e) { setMsg(e.message); } };
  const claim = async () => { try { await api(`/pay/${token}/claim`, { method: 'POST', body: { app: picked.app, name } }); await load(); } catch (e) { setMsg(e.message); } };

  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.business.accent, '#2a1f55', d.business.accent]} amplitude={0.6} speed={0.35} mouseInteraction={false} /></div>
      <main className="guest-in" style={{ alignContent: 'start' }}>
        <LangSwitch lang={lang} setLang={setLang} />
        {d.business.logo ? <img className="guest-logo" src={d.business.logo} alt={d.business.name} /> : <Puck state="buzzed" size={48} />}
        <div style={{ display: 'grid', gap: 4, textAlign: 'center' }}><h1>{amount}</h1><p>{d.business.name}{d.descr ? `, ${d.descr}` : ''}</p></div>
        {d.lines.length > 1 && <div className="card totals">{d.lines.map((l, i) => <div key={i}><span>{l.name}</span><span>{money(l.cents, d.currency)}</span></div>)}</div>}
        {msg && <div className="card banner" role="alert">{msg}</div>}

        {d.status === 'paid' ? <div className="card"><b>{t('Paid. Thank you!')}</b></div>
          : d.bankStatus === 'processing' ? <div className="card"><b>{t('Your bank payment has started')}</b><span className="muted" style={{ fontSize: 14 }}>{t('Bank payments take 3–5 business days to clear. You can close this page. We will email you if anything goes wrong.')}</span></div>
          : d.claimed ? (
            <div className="card"><b>{t("Thanks! We're checking your payment")}</b><span className="muted" style={{ fontSize: 14 }}>{t('This page updates on its own as soon as the team confirms it.')}</span></div>
          ) : picked ? (
            <div className="card stack">
              {picked.app === 'zelle' ? (
                <>
                  <span>{t('Send with Zelle from your bank app to')}</span>
                  <div className="row"><b className="grow num" style={{ fontSize: 18, wordBreak: 'break-all' }}>{picked.handle}</b><button className="btn sm" onClick={() => { navigator.clipboard?.writeText(picked.handle); setCopied(true); }}>{copied ? t('Copied') : t('Copy')}</button></div>
                  <b style={{ fontSize: 22 }}>{amount}</b>
                </>
              ) : (
                <>
                  <span>{t('Send {amount} to {handle}', { amount, handle: picked.handle })}</span>
                  <a className="btn primary lg block" href={picked.url} target="_blank" rel="noreferrer">{t('Open {app}', { app: picked.label })}</a>
                </>
              )}
              <label className="field"><span>{t('Your name as it shows in the app')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="name" /></label>
              <button className="btn primary block" disabled={!name.trim()} onClick={claim}>{t("I've sent it")}</button>
              <button className="btn ghost block" onClick={() => setPicked(null)}>{t('Choose another way to pay')}</button>
            </div>
          ) : (
            <div className="card stack">
              <b>{t('How would you like to pay?')}</b>
              {methods.map((m, i) => {
                const key = m.app || m.kind;
                if (m.kind === 'paypal') return <PayPalButtons key={i} token={token} method={m} onPaid={(r) => go(r.next)} onError={setMsg} />;
                return (
                  <button key={i} className={`pay-opt ${key === 'zelle' || key === 'venmo' ? 'cheap' : ''}`} onClick={() => (m.kind === 'card' ? card() : m.kind === 'bank' ? bank() : setPicked(m))}>
                    <span className="grow"><b>{m.kind === 'card' ? t('Pay by card') : t(m.label)}</b><small>{m.kind === 'card' ? t(m.label) : m.kind === 'bank' ? t(m.note) : m.handle}</small></span>
                    {FEE_NOTE[key] && <span className="chip teal">{t(FEE_NOTE[key])}</span>}
                  </button>
                );
              })}
            </div>
          )}
        {d.cancelUrl && d.status !== 'paid' && <a className="btn ghost" href={d.cancelUrl}>{t('Back')}</a>}
      </main>
    </div>
  );
}
