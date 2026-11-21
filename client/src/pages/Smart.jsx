import { useEffect, useRef, useState } from 'react';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent, money } from '../lib.js';
import { Icon, Modal, Puck, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { LangSwitch, useLang } from '../i18n.jsx';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);
const pad = (n) => String(n).padStart(2, '0');
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
const t12 = (hm) => new Date(`2000-01-01T${hm}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* ================= Online catering order (public) ================= */
export function CateringOrder() {
  const { lang, setLang, t } = useLang();
  const [d, setD] = useState(null);
  const [qty, setQty] = useState({});
  const [f, setF] = useState({ name: '', email: '', phone: '', date: '', time: '12:00', fulfillment: 'pickup', address: '', notes: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api('/public/catering').then((x) => { setD(x); applyAccent(x.business.accent); document.title = `${x.business.name}: catering`; const min = new Date(Date.now() + (x.leadHours + 12) * 3600000).toLocaleDateString('en-CA'); setF((y) => ({ ...y, date: min })); }).catch((e) => setErr(e.message)); }, []);
  if (!d) return <div className="guest">{err && <main className="guest-in"><h1>{err}</h1></main>}</div>;
  const picked = d.packages.filter((p) => qty[p.id] > 0);
  const sub = picked.reduce((a, p) => a + p.price_cents * qty[p.id], 0);
  const fee = f.fulfillment === 'delivery' ? d.deliveryFeeCents : 0;
  const send = async () => { setBusy(true); setErr(''); try { const r = await api('/public/catering', { method: 'POST', body: { name: f.name, email: f.email, phone: f.phone, when: `${f.date} ${f.time}`, fulfillment: f.fulfillment, address: f.address || undefined, notes: f.notes || undefined, items: picked.map((p) => ({ id: p.id, qty: qty[p.id] })) } }); location.href = r.link; } catch (e) { setErr(e.message); setBusy(false); } };
  const times = []; for (let m = 7 * 60; m <= 21 * 60; m += 30) times.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.business.accent, '#2a1f55', d.business.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in" style={{ alignContent: 'start' }}>
        <LangSwitch lang={lang} setLang={setLang} />
        {d.business.logo ? <img className="guest-logo" src={d.business.logo} alt={d.business.name} /> : <Puck state="buzzed" size={44} />}
        <h1>{t('Catering')}: {d.business.name}</h1>
        {!d.enabled ? <p>Online catering orders are closed. {d.business.phone ? `Call ${d.business.phone}.` : 'Please call us.'}</p> : <>
          <p style={{ margin: 0 }}>Order at least {d.leadHours} hours ahead. A {d.depositPct}% deposit holds your date.</p>
          {d.packages.map((p) => (
            <div key={p.id} className="card stack" style={{ width: '100%', textAlign: 'left' }}>
              <div className="row"><b className="grow" style={{ fontSize: 17 }}>{p.name}</b><b>{money(p.price_cents, d.currency)}{p.unit === 'person' ? ' / person' : ''}</b></div>
              {p.description && <span className="muted" style={{ fontSize: 14 }}>{p.description}</span>}
              <div className="row"><span className="dim grow" style={{ fontSize: 13 }}>{p.min_qty > 1 ? `Minimum ${p.min_qty}${p.unit === 'person' ? ' people' : ''}` : ''}{p.serves ? `${p.min_qty > 1 ? '. ' : ''}Serves ${p.serves}` : ''}</span>
                <span className="qty"><button onClick={() => setQty({ ...qty, [p.id]: Math.max(0, (qty[p.id] || 0) - (qty[p.id] > p.min_qty ? 1 : qty[p.id] || 0)) })} aria-label="Less">−</button><span>{qty[p.id] || 0}</span><button onClick={() => setQty({ ...qty, [p.id]: Math.max(p.min_qty, (qty[p.id] || 0) + 1) })} aria-label="More">+</button></span></div>
            </div>
          ))}
          {picked.length > 0 && (
            <div className="card stack" style={{ width: '100%' }}>
              {d.delivery && <div className="seg" style={{ width: '100%' }}>{['pickup', 'delivery'].map((x) => <button key={x} aria-pressed={f.fulfillment === x} onClick={() => setF({ ...f, fulfillment: x })} style={{ flex: 1, textTransform: 'capitalize' }}>{x}</button>)}</div>}
              <div className="row"><input className="input grow" type="date" value={f.date} min={new Date(Date.now() + d.leadHours * 3600000).toLocaleDateString('en-CA')} onChange={(e) => setF({ ...f, date: e.target.value })} aria-label="Date" /><select className="input" style={{ width: 120 }} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} aria-label="Time">{times.map((x) => <option key={x} value={x}>{t12(x)}</option>)}</select></div>
              {f.fulfillment === 'delivery' && <input className="input" placeholder="Delivery address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} autoComplete="street-address" />}
              <input className="input" placeholder={t('Your name')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
              <input className="input" type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
              <input className="input" type="tel" placeholder="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" />
              <textarea className="input" rows={2} placeholder="Notes: allergies, setup, utensils" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={500} />
              <div className="totals"><div><span>{t('Subtotal')}</span><span>{money(sub, d.currency)}</span></div>{fee > 0 && <div><span>Delivery</span><span>{money(fee, d.currency)}</span></div>}<div className="grand"><span>Deposit now</span><span>{money(Math.round((sub + fee) * d.depositPct / 100), d.currency)}</span></div></div>
              {err && <div className="lock-msg">{err}</div>}
              <button className="btn primary lg block" disabled={busy || !f.name || !/^\S+@\S+\.\S+$/.test(f.email) || f.phone.length < 7 || sub < d.minCents} onClick={send}>{busy ? 'One moment…' : 'Review and pay the deposit'}</button>
              <span className="dim" style={{ fontSize: 12 }}>Tax is added on the next page.{sub < d.minCents ? ` Catering orders start at ${money(d.minCents, d.currency)}.` : ''}</span>
            </div>
          )}
        </>}
      </main>
    </div>
  );
}
export function CateringPackages() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [list, reload] = useLive(['invoices'], () => api('/staff/catering-packages'));
  const [edit, setEdit] = useState(null);
  if (!list) return null;
  const link = `${location.origin}/catering-order${localStorage.getItem('bh_loc') ? `?l=${localStorage.getItem('bh_loc')}` : ''}`;
  const save = () => api(edit.id ? `/staff/catering-packages/${edit.id}` : '/staff/catering-packages', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, description: edit.description || undefined, priceCents: dollars(edit.price), unit: edit.unit, minQty: Number(edit.min_qty) || 1, serves: edit.serves ? Number(edit.serves) : null, active: edit.active } }).then(() => { setEdit(null); reload(); }).catch((e) => toast(e.message, 'err'));
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">Online catering menu</h3>{settings.catering_online === '1' ? <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(link); toast('Catering order link copied', 'ok'); }}>Copy order link</button> : <span className="chip">Off. Turn it on in Settings</span>}<button className="btn sm primary" onClick={() => setEdit({ name: '', description: '', price: '', unit: 'person', min_qty: '10', serves: '' })}>Add a package</button></div>
      {list.length === 0 ? <div className="panel-b muted">Add trays and packages customers can order online. Each order becomes a quote here, and the customer pays the deposit online.</div> : (
        <table className="list"><tbody>{list.map((p) => <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}><td><b>{p.name}</b><div className="dim" style={{ fontSize: 12.5 }}>{p.description}</div></td><td className="num">{money(p.price_cents, cur)}{p.unit === 'person' ? ' / person' : ''}</td><td className="muted">min {p.min_qty}</td><td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setEdit({ ...p, price: (p.price_cents / 100).toFixed(2), active: Boolean(p.active) })}>Edit</button></td></tr>)}</tbody></table>
      )}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'Add a catering package'} onClose={() => setEdit(null)} width={500}>
          <label className="field"><span>Name</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={60} placeholder="Taco bar" /></label>
          <label className="field"><span>What's included</span><textarea className="input" rows={2} value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} maxLength={400} /></label>
          <div className="row"><label className="field grow"><span>Price</span><input className="input" inputMode="decimal" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></label><label className="field"><span>Per</span><select className="input" value={edit.unit} onChange={(e) => setEdit({ ...edit, unit: e.target.value })}><option value="person">person</option><option value="each">tray or item</option></select></label>
            <label className="field grow"><span>Minimum</span><input className="input" type="number" min={1} value={edit.min_qty} onChange={(e) => setEdit({ ...edit, min_qty: e.target.value })} /></label>{edit.unit === 'each' && <label className="field grow"><span>Serves</span><input className="input" type="number" min={1} value={edit.serves || ''} onChange={(e) => setEdit({ ...edit, serves: e.target.value })} /></label>}</div>
          {edit.id && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />On the online menu</label>}
          <button className="btn primary lg block" disabled={!edit.name || !dollars(edit.price)} onClick={save}>Save</button>
        </Modal>
      )}
    </section>
  );
}

/* ================= Auto-built schedule (Shifts page) ================= */
export function AutoSchedule() {
  const { can } = useCC(); const toast = useToast();
  const [d, setD] = useState(null); const [off, setOff] = useState({});
  if (!can('manager')) return null;
  const open = (week) => api(`/staff/schedule/auto${week ? `?week=${week}` : ''}`).then((x) => { setD(x); setOff({}); }).catch((e) => toast(e.message, 'err'));
  const keep = d ? d.shifts.filter((_, i) => !off[i]) : [];
  const add = () => api('/staff/schedule/auto', { method: 'POST', body: { shifts: keep.map((x) => ({ userId: x.userId, date: x.date, start: x.start, end: x.end })) } }).then((r) => { toast(`${r.added} shifts added`, 'ok'); setD(null); }).catch((e) => toast(e.message, 'err'));
  const day = (x) => new Date(`${x}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <>
      <button className="btn" onClick={() => open()}>Build next week</button>
      {d && (
        <Modal title={`Suggested schedule, week of ${day(d.weekStart)}`} onClose={() => setD(null)} width={620}>
          <div className="row"><button className="btn sm" onClick={() => open(addDays(d.weekStart, -7))}>Week before</button><button className="btn sm" onClick={() => open(addDays(d.weekStart, 7))}>Week after</button><span className="grow" /><span className="dim" style={{ fontSize: 12.5 }}>From {d.historyDays} days of sales, everyone's availability and time off</span></div>
          {d.shifts.length === 0 ? <span className="muted">Nothing to add. Either the week is already covered, or there isn't enough sales history yet.</span> : (
            <div className="stack" style={{ gap: 4, maxHeight: 340, overflow: 'auto' }}>{d.shifts.map((x, i) => (
              <label key={i} className="row" style={{ fontSize: 14, opacity: off[i] ? 0.45 : 1 }}><input type="checkbox" checked={!off[i]} onChange={(e) => setOff({ ...off, [i]: !e.target.checked })} /><span style={{ width: 110 }}>{day(x.date)}</span><b className="grow">{x.name}</b><span className="num">{t12(x.start)} – {t12(x.end)}</span><span className="dim num" style={{ width: 40, textAlign: 'right' }}>{x.hours}h</span></label>
            ))}</div>
          )}
          {d.gaps.length > 0 && <div className="ticket-allergy" style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--text)' }}>Nobody free for {d.gaps.length} shift{d.gaps.length === 1 ? '' : 's'}: {d.gaps.slice(0, 4).map((g) => `${day(g.date)} ${t12(g.start)}–${t12(g.end)}`).join(', ')}{d.gaps.length > 4 ? '…' : ''}. Hire, ask for more availability, or cover it yourself.</div>}
          {d.hours.length > 0 && <span className="dim" style={{ fontSize: 12.5 }}>Hours for the week: {d.hours.map((h) => `${h.name.split(' ')[0]} ${h.hours}`).join(', ')}</span>}
          <button className="btn primary lg block" disabled={!keep.length} onClick={add}>Add {keep.length} shift{keep.length === 1 ? '' : 's'} to the schedule</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Barcode stock count ================= */
export function StockCount() {
  const toast = useToast();
  const [list, reload] = useLive(['menu'], () => api('/staff/count-list'));
  const [code, setCode] = useState('');
  const [hit, setHit] = useState(null);
  const [qty, setQty] = useState('');
  const [assign, setAssign] = useState(null);
  const [cam, setCam] = useState(false);
  const [counted, setCounted] = useState([]);
  const videoRef = useRef(null); const streamRef = useRef(null); const qtyRef = useRef(null);
  const lookup = async (c) => {
    const v = String(c).trim(); if (!v) return; setCode('');
    try { const g = await api(`/staff/ingredients/by-barcode/${encodeURIComponent(v)}`); setHit(g); setQty(''); setTimeout(() => qtyRef.current?.focus(), 50); }
    catch { setAssign(v); }
  };
  useEffect(() => {
    if (!cam) return undefined;
    let stop = false; let timer;
    (async () => {
      if (!('BarcodeDetector' in window)) { toast('This browser cannot scan with the camera. Use a USB or Bluetooth scanner, or type the code.', 'err'); setCam(false); return; }
      try {
        const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
        streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        videoRef.current.srcObject = streamRef.current; await videoRef.current.play();
        const tick = async () => { if (stop) return; try { const r = await det.detect(videoRef.current); if (r[0]?.rawValue) { setCam(false); lookup(r[0].rawValue); return; } } catch { /* keep trying */ } timer = setTimeout(tick, 250); };
        tick();
      } catch { toast('Camera not available. Allow camera access, or type the code.', 'err'); setCam(false); }
    })();
    return () => { stop = true; clearTimeout(timer); streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, [cam]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => api(`/staff/ingredients/${hit.id}/count`, { method: 'POST', body: { qty: Number(qty), mode: 'set' } }).then(() => { setCounted([{ name: hit.name, qty: Number(qty), unit: hit.unit, was: hit.stock }, ...counted]); setHit(null); reload(); }).catch((e) => toast(e.message, 'err'));
  const link = (id) => api(`/staff/ingredients/${id}/barcode`, { method: 'PUT', body: { code: assign } }).then(() => { const v = assign; setAssign(null); reload(); lookup(v); }).catch((e) => toast(e.message, 'err'));
  if (!list) return null;
  return (
    <>
      <PageHead title="Stock count" sub="Scan a product's barcode, type how many you have, and move to the next. Works with the phone camera, or any USB or Bluetooth scanner.">
        <button className="btn primary" onClick={() => setCam(true)}><Icon name="qr" size={16} />Scan with camera</button>
      </PageHead>
      <section className="panel" style={{ marginBottom: 16 }}><div className="panel-b stack">
        {cam && <div style={{ position: 'relative' }}><video ref={videoRef} playsInline muted style={{ width: '100%', maxHeight: 320, borderRadius: 12, background: '#000' }} /><button className="btn sm" style={{ position: 'absolute', top: 8, right: 8 }} onClick={() => setCam(false)}>Stop</button></div>}
        <form className="row" onSubmit={(e) => { e.preventDefault(); lookup(code); }}><input className="input grow" autoFocus placeholder="Scan or type a barcode" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Barcode" /><button className="btn">Look up</button></form>
        {hit && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (qty !== '') save(); }} style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', padding: 10, borderRadius: 12 }}>
            <b className="grow">{hit.name}<div className="dim" style={{ fontSize: 12.5, fontWeight: 400 }}>System says {hit.stock ?? 'not tracked'} {hit.unit}</div></b>
            <input ref={qtyRef} className="input" style={{ width: 110 }} inputMode="decimal" placeholder={`How many ${hit.unit}`} value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Count" />
            <button className="btn primary" disabled={qty === ''}>Save count</button>
          </form>
        )}
      </div></section>
      <div className="grid-2">
        <section className="panel"><div className="panel-h"><h3>Counted this session</h3></div>
          {counted.length === 0 ? <div className="panel-b muted">Nothing yet.</div> : <table className="list"><tbody>{counted.map((c, i) => <tr key={i}><td>{c.name}</td><td className="num">{c.qty} {c.unit}</td><td className="num dim">{c.was !== null && c.was !== c.qty ? `${c.qty - c.was > 0 ? '+' : ''}${Math.round((c.qty - c.was) * 100) / 100}` : ''}</td></tr>)}</tbody></table>}
        </section>
        <section className="panel"><div className="panel-h"><h3>Barcodes</h3></div>
          <table className="list"><tbody>{list.map((g) => <tr key={g.id}><td>{g.name}</td><td className="muted num" style={{ fontSize: 12.5 }}>{g.barcode || 'No barcode'}</td><td style={{ textAlign: 'right' }}>{g.barcode && <button className="btn sm ghost" onClick={() => api(`/staff/ingredients/${g.id}/barcode`, { method: 'PUT', body: { code: null } }).then(reload)}>Clear</button>}</td></tr>)}</tbody></table>
        </section>
      </div>
      {assign && (
        <Modal title="New barcode" onClose={() => setAssign(null)} width={420}>
          <span className="muted">Which ingredient is <b className="num">{assign}</b>? It will be recognized next time.</span>
          <div className="stack" style={{ gap: 4, maxHeight: 320, overflow: 'auto' }}>{list.map((g) => <button key={g.id} className="btn block" style={{ justifyContent: 'flex-start' }} onClick={() => link(g.id)}>{g.name}{g.barcode ? <span className="dim" style={{ marginLeft: 6 }}>(replaces {g.barcode})</span> : null}</button>)}</div>
        </Modal>
      )}
    </>
  );
}

/* ================= Cook timers (kitchen tickets) ================= */
export function useCookTimes() {
  const [m] = useLive(['menu'], () => api('/staff/cook-times').catch(() => ({})));
  return m || {};
}
/** Minutes until each item should start, so everything on the ticket finishes together. */
export function cookPlan(order, times) {
  const items = order.items.filter((i) => !(i.course > 1 && !i.fired_at));
  const longest = Math.max(0, ...items.map((i) => times[i.item_id] || 0));
  if (!longest) return null;
  const sent = Date.parse(`${(order.sent_at || order.created_at).replace(' ', 'T')}Z`);
  const elapsed = (Date.now() - sent) / 60000;
  return { readyIn: Math.max(0, Math.round(longest - elapsed)), startIn: (i) => (times[i.item_id] ? Math.round(longest - times[i.item_id] - elapsed) : null) };
}

/* ================= Supplier price comparison (Purchasing tab) ================= */
export function PriceCompare() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [d, reload] = useLive(['menu'], () => api('/staff/price-compare'));
  const [quote, setQuote] = useState(null);
  if (!d) return null;
  const c2 = (c) => money(Math.round(c), cur);
  const sw = (r, sid) => api('/staff/price-compare/switch', { method: 'POST', body: { ingredientId: r.id, supplierId: sid } }).then(() => { toast('Supplier switched', 'ok'); reload(); }).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>Prices come from every delivery you receive, plus quotes you type in. {d.possibleSaveCents > 0 ? <b>Switching to the cheapest supplier could save about {money(d.possibleSaveCents, cur)} a month.</b> : null}</p>
      <section className="panel"><table className="list"><thead><tr><th>Ingredient</th><th>Prices</th><th>Monthly use</th><th>Could save</th><th /></tr></thead>
        <tbody>{d.rows.map((r) => (
          <tr key={r.id}><td><b>{r.name}</b><div className="dim" style={{ fontSize: 12 }}>per {r.unit}</div></td>
            <td>{r.quotes.length === 0 ? <span className="dim">No prices yet</span> : <div className="row wrap" style={{ gap: 6 }}>{r.quotes.map((q, i) => <span key={q.supplierId} className={`chip ${i === 0 ? 'teal' : ''}`} title={`${q.source === 'quote' ? 'Quote' : 'Last delivery'}, ${q.at.slice(0, 10)}`}>{q.supplier} {c2(q.cents)}{q.supplierId === r.supplierId ? ' (yours)' : ''}</span>)}</div>}</td>
            <td className="num muted">{r.monthlyUse || '—'}</td><td className="num">{r.saveMonthCents > 0 ? money(r.saveMonthCents, cur) : '—'}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{r.best && r.best.supplierId !== r.supplierId && <button className="btn sm primary" onClick={() => sw(r, r.best.supplierId)}>Switch to {r.best.supplier}</button>}<button className="btn sm ghost" onClick={() => setQuote({ ingredientId: r.id, name: r.name, unit: r.unit, supplierId: d.suppliers[0]?.id, price: '' })}>Add a quote</button></td></tr>
        ))}</tbody></table></section>
      {quote && (
        <Modal title={`Price for ${quote.name}`} onClose={() => setQuote(null)} width={400}>
          <label className="field"><span>Supplier</span><select className="input" value={quote.supplierId} onChange={(e) => setQuote({ ...quote, supplierId: Number(e.target.value) })}>{d.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="field"><span>Price per {quote.unit}</span><input className="input" inputMode="decimal" value={quote.price} onChange={(e) => setQuote({ ...quote, price: e.target.value })} /></label>
          <button className="btn primary lg block" disabled={!quote.price} onClick={() => api('/staff/price-compare/quote', { method: 'POST', body: { ingredientId: quote.ingredientId, supplierId: Number(quote.supplierId), cents: Number(quote.price) * 100 } }).then(() => { setQuote(null); reload(); }).catch((e) => toast(e.message, 'err'))}>Save price</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Review themes (Feedback) ================= */
export function ReviewThemes() {
  const [days, setDays] = useState(90);
  const [d] = useLive(['feedback'], () => api(`/staff/review-themes?days=${days}`), [days]);
  if (!d) return null;
  const max = Math.max(1, ...d.themes.map((t) => t.mentions));
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">What guests talk about</h3><div className="seg">{[30, 90, 365].map((n) => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n === 365 ? 'Year' : `${n} days`}</button>)}</div></div>
      {d.themes.length === 0 ? <div className="panel-b muted">Not enough written comments yet. Themes appear as guests leave notes with their ratings.</div> : (
        <div className="panel-b stack">
          <span className="dim" style={{ fontSize: 12.5 }}>From {d.comments} written comment{d.comments === 1 ? '' : 's'}. Praise is from 4–5 star ratings, complaints from 1–2 stars.</span>
          {d.themes.map((t) => (
            <details key={t.name} className="theme-row">
              <summary className="row"><b style={{ width: 150 }}>{t.name}</b><span className="grow theme-bar"><i className="good" style={{ width: `${t.praise / max * 100}%` }} /><i className="bad" style={{ width: `${t.complaints / max * 100}%` }} /></span><span className="chip teal">{t.praise} praise</span><span className={`chip ${t.complaints ? 'rose' : ''}`}>{t.complaints} complaints</span></summary>
              <div className="stack" style={{ gap: 4, margin: '6px 0 6px 150px' }}>{t.samples.map((s, i) => <span key={i} className="muted" style={{ fontSize: 13.5 }}>{'★'.repeat(s.rating)} "{s.text}"</span>)}</div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

/* ================= Safe log (optional) ================= */
export function Safe() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [d, reload] = useLive(['safe'], () => api('/staff/safe'));
  const [f, setF] = useState(null);
  if (!d) return null;
  const label = { count: 'Count', drop: 'Drop from drawer', to_bank: 'Taken to bank', adjust: 'Adjustment' };
  const save = () => api('/staff/safe', { method: 'POST', body: { kind: f.kind, amountCents: f.kind === 'adjust' ? dollars(f.amount) * (f.sign === '-' ? -1 : 1) : dollars(f.amount), note: f.note || undefined, witnessPin: f.pin || undefined } })
    .then((r) => { toast(f.kind === 'count' ? (r.diffCents ? `Saved. The safe is ${r.diffCents > 0 ? 'over' : 'short'} ${money(Math.abs(r.diffCents), cur)}` : 'Saved. The count matches.') : 'Saved', r.diffCents ? 'err' : 'ok'); setF(null); reload(); }).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <PageHead title="Safe" sub={`Should hold ${money(d.expectedCents, cur)}.${d.lastCount ? ` Last counted ${new Date(`${d.lastCount.at.replace(' ', 'T')}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : ' Not counted yet.'}${d.needWitness ? ' Every entry needs a second person to enter their PIN.' : ''}`}>
        {Object.entries(label).map(([k, l]) => <button key={k} className={`btn ${k === 'count' ? 'primary' : ''}`} onClick={() => setF({ kind: k, amount: '', note: '', pin: '', sign: '+' })}>{l}</button>)}
      </PageHead>
      <section className="panel">{d.rows.length === 0 ? <div className="panel-b muted">Start with a count of what's in the safe now.</div> : (
        <table className="list"><thead><tr><th>When</th><th>What</th><th>Amount</th><th>Expected</th><th>By</th><th>Witness</th></tr></thead>
          <tbody>{d.rows.map((r) => { const diff = r.kind === 'count' && r.expected_cents !== null ? r.amount_cents - r.expected_cents : 0; return (
            <tr key={r.id}><td className="muted">{new Date(`${r.at.replace(' ', 'T')}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td>{label[r.kind]}{r.note && <div className="dim" style={{ fontSize: 12 }}>{r.note}</div>}</td>
              <td className="num">{money(r.amount_cents, cur)}</td><td className="num">{r.kind === 'count' && r.expected_cents !== null ? <>{money(r.expected_cents, cur)} {diff !== 0 && <span className={`chip ${Math.abs(diff) < 100 ? '' : 'rose'}`}>{diff > 0 ? '+' : '−'}{money(Math.abs(diff), cur)}</span>}</> : '—'}</td>
              <td>{r.by_name}</td><td className="muted">{r.witness_name || '—'}</td></tr>); })}</tbody></table>
      )}</section>
      {f && (
        <Modal title={label[f.kind]} onClose={() => setF(null)} width={400}>
          {f.kind === 'adjust' && <div className="seg" style={{ width: '100%' }}><button aria-pressed={f.sign === '+'} onClick={() => setF({ ...f, sign: '+' })} style={{ flex: 1 }}>Add</button><button aria-pressed={f.sign === '-'} onClick={() => setF({ ...f, sign: '-' })} style={{ flex: 1 }}>Remove</button></div>}
          <label className="field"><span>{f.kind === 'count' ? 'Total counted in the safe' : 'Amount'}</span><input className="input" inputMode="decimal" autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ fontSize: 22 }} /></label>
          <label className="field"><span>Note{f.kind === 'adjust' ? ' (required)' : ' (optional)'}</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} placeholder={f.kind === 'to_bank' ? 'Deposit slip number' : ''} /></label>
          {d.needWitness && <label className="field"><span>Witness PIN (a second person)</span><input className="input" type="password" inputMode="numeric" autoComplete="off" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 8) })} /></label>}
          <button className="btn primary lg block" disabled={f.amount === '' || (d.needWitness && f.pin.length < 4) || (f.kind === 'adjust' && !f.note)} onClick={save}>Save</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Settings panel ================= */
export function SmartPanel({ f, setF }) {
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const cents = (k) => (e) => setF({ ...f, [k]: String(dollars(e.target.value)) });
  return (
    <section className="panel"><div className="panel-h"><h3>Bank payments, photos, catering and safe</h3></div><div className="panel-b stack">
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.pay_bank_enabled === '1'} onChange={flag('pay_bank_enabled')} /> <b>Pay by bank</b>: offer "pay from your bank account" on invoices, catering, deposits and event tickets (Stripe, about 0.8% capped at $5)</label>
      {f.pay_bank_enabled === '1' && <label className="field"><span>Only for amounts of at least</span><input className="input" style={{ width: 140 }} inputMode="decimal" defaultValue={(Number(f.pay_bank_min_cents) / 100).toFixed(2)} onBlur={cents('pay_bank_min_cents')} /></label>}
      <span className="dim" style={{ fontSize: 12.5 }}>Bank payments take 3–5 business days and can fail if the account is short. You'll get a notification when one starts, clears or fails. Needs Stripe connected.</span>
      <hr className="sep" />
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.menu_photos === '1'} onChange={flag('menu_photos')} /> Show dish photos on the online menu, kiosk and table menus (add them on each item's recipe card)</label>
      <hr className="sep" />
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.catering_online === '1'} onChange={flag('catering_online')} /> Take catering orders online at <b>/catering-order</b></label>
      {f.catering_online === '1' && <div className="row wrap">
        <label className="field grow"><span>Hours of notice</span><input className="input" type="number" min={1} value={f.catering_lead_hours} onChange={set('catering_lead_hours')} /></label>
        <label className="field grow"><span>Deposit %</span><input className="input" type="number" min={0} max={100} value={f.catering_deposit_pct} onChange={set('catering_deposit_pct')} /></label>
        <label className="field grow"><span>Minimum order</span><input className="input" inputMode="decimal" defaultValue={(Number(f.catering_min_cents) / 100).toFixed(2)} onBlur={cents('catering_min_cents')} /></label>
        <label className="field grow"><span>Delivery fee</span><input className="input" inputMode="decimal" defaultValue={(Number(f.catering_delivery_cents) / 100).toFixed(2)} onBlur={cents('catering_delivery_cents')} /></label></div>}
      <hr className="sep" />
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.safe_log_enabled === '1'} onChange={flag('safe_log_enabled')} /> <b>Safe log (optional)</b>: record safe counts, drops from the drawer and bank runs</label>
      {f.safe_log_enabled === '1' && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.safe_two_person === '1'} onChange={flag('safe_two_person')} /> Every safe entry needs a second person's PIN</label>}
    </div></section>
  );
}
