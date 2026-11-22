import { useEffect, useRef, useState } from 'react';
import { api } from '../lib.js';
import { Modal } from '../ui.jsx';
import { useCC, useLive } from './CommandCenter.jsx';

const left = (sql) => Math.round((Date.parse(`${String(sql).replace(' ', 'T')}Z`) - Date.now()) / 1000);
const mmss = (s) => `${s < 0 ? '-' : ''}${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, '0')}`;

/* ================= Area screen: messages, timers, cook, shelf ================= */
export function KdsMessages({ d, call, flash }) {
  const [open, setOpen] = useState(false); const [to, setTo] = useState('Expo'); const [text, setText] = useState('');
  const incoming = d.messages.filter((m) => !m.mine && !m.acked);
  const seen = useRef(new Set());
  useEffect(() => { const fresh = incoming.filter((m) => !seen.current.has(m.id)); if (fresh.length && seen.current.size) { try { const a = new AudioContext(); const o = a.createOscillator(); o.frequency.value = 880; o.connect(a.destination); o.start(); o.stop(a.currentTime + 0.15); } catch { /* no audio */ } } fresh.forEach((m) => seen.current.add(m.id)); if (!seen.current.size) seen.current.add(-1); });
  const send = (body) => call('/kds/msg', { to, body }, () => { flash(`Sent to ${to}`); setOpen(false); setText(''); });
  const targets = [...d.areas.filter((a) => a !== d.area), 'All'];
  return (
    <>
      <button className="btn sm" onClick={() => { setTo(targets.includes('Expo') ? 'Expo' : targets[0]); setOpen(true); }}>Message</button>
      {incoming.length > 0 && <div className="kds-banner msg" style={{ position: 'fixed', left: 16, right: 16, bottom: 64, zIndex: 30 }}>{incoming.map((m) => <span key={m.id} className="row" style={{ gap: 8 }}><b>{m.from}{m.by && m.by !== m.from ? ` (${m.by})` : ''}:</b> {m.body}<button className="btn sm" onClick={() => call(`/kds/msg/${m.id}/ack`, {})}>Got it</button></span>)}</div>}
      {open && (
        <Modal title="Message another area" onClose={() => setOpen(false)} width={480}>
          <div className="row wrap" style={{ gap: 6 }}>{targets.map((a) => <button key={a} className={`btn sm ${to === a ? 'primary' : ''}`} onClick={() => setTo(a)}>{a === 'All' ? 'Everyone' : a}</button>)}</div>
          <div className="row wrap" style={{ gap: 6 }}>{d.quick.map((q) => <button key={q} className="btn" onClick={() => send(q)}>{q}</button>)}</div>
          <div className="row"><input className="input grow" placeholder="Or type a message" value={text} onChange={(e) => setText(e.target.value)} maxLength={120} onKeyDown={(e) => e.key === 'Enter' && text.trim() && send(text.trim())} /><button className="btn primary" disabled={!text.trim()} onClick={() => send(text.trim())}>Send</button></div>
          {d.messages.filter((m) => m.mine).length > 0 && <div className="dim" style={{ fontSize: 13 }}>{d.messages.filter((m) => m.mine).slice(0, 4).map((m) => <div key={m.id}>To {m.to}: {m.body} · {m.acked ? `seen by ${m.ackBy}` : 'not seen yet'}</div>)}</div>}
        </Modal>
      )}
    </>
  );
}
export function KdsTimers({ d, call, flash }) {
  const [, tick] = useState(0); const [add, setAdd] = useState(null);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const due = d.timers.filter((t) => t.dueAt && left(t.dueAt) <= 0);
  useEffect(() => {
    if (!due.length) return undefined;
    const beep = () => { try { const a = new AudioContext(); [0, 0.25].forEach((w) => { const o = a.createOscillator(); o.frequency.value = 1200; o.connect(a.destination); o.start(a.currentTime + w); o.stop(a.currentTime + w + 0.15); }); } catch { /* no audio */ } navigator.vibrate?.(200); };
    beep(); const t = setInterval(beep, 2500); return () => clearInterval(t);
  }, [due.length]);
  return (
    <>
      {d.timers.map((t) => { const s = t.dueAt ? left(t.dueAt) : null; return (
        <button key={t.id} className={`btn sm kds-timer ${s !== null && s <= 0 ? 'ring' : ''}`} onClick={() => (s !== null && s <= 0 ? call(`/kds/timers/${t.id}/done`, {}, () => flash(`${t.name}: ${t.repeat ? 'started again' : 'done'}`)) : s === null ? call(`/kds/timers/${t.id}/restart`, {}) : confirm(`Stop or delete the ${t.name} timer? OK deletes it, Cancel keeps it running.`) && call(`/kds/timers/${t.id}/delete`, {}))} title={t.repeat ? `Every ${t.minutes} min` : `${t.minutes} min`}>
          {t.name} <span className="num">{s === null ? 'start' : s <= 0 ? 'NOW' : mmss(s)}</span>
        </button>); })}
      <button className="btn sm ghost" onClick={() => setAdd({ name: '', minutes: 7, repeat: true })} aria-label="Add a timer">+ Timer</button>
      {add && (
        <Modal title="Add a timer" onClose={() => setAdd(null)} width={400}>
          <label className="field"><span>Name</span><input className="input" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} maxLength={30} placeholder="Fresh fries, drop wings, rice" /></label>
          <label className="field"><span>Minutes</span><input className="input" type="number" min={0.5} max={240} step={0.5} value={add.minutes} onChange={(e) => setAdd({ ...add, minutes: e.target.value })} /></label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={add.repeat} onChange={(e) => setAdd({ ...add, repeat: e.target.checked })} />Start again when I tap it (repeating)</label>
          <button className="btn primary lg block" disabled={!add.name || !Number(add.minutes)} onClick={() => call('/kds/timers', { name: add.name, minutes: Number(add.minutes), repeat: add.repeat }, () => setAdd(null))}>Start timer</button>
        </Modal>
      )}
    </>
  );
}
export function CookPicker({ d, cook, setCook }) {
  if (!d.crew?.length || d.kind === 'pack' || d.kind === 'expo' || d.kind === 'runner') return null;
  return <select className="input" style={{ width: 160, height: 34 }} value={cook || ''} onChange={(e) => setCook(e.target.value)} aria-label="Who is cooking"><option value="">Who's cooking?</option>{d.crew.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>;
}
export function ShelfPicker({ d, order, onPick, onClose }) {
  const used = new Set(d.shelvesUsed);
  return (
    <Modal title={`Which shelf for #${order.number}?`} onClose={onClose} width={480}>
      <div className="shelf-grid">{d.shelves.map((s) => <button key={s} className={`btn lg ${used.has(s) ? '' : 'primary'}`} disabled={used.has(s)} onClick={() => onPick(s)}>{s}</button>)}</div>
      <button className="btn ghost block" onClick={() => onPick(null)}>No shelf, just bagged</button>
    </Modal>
  );
}

/* ================= Customer pages ================= */
export function ShelfCard({ s }) {
  return <div className="card" style={{ textAlign: 'center' }}><span className="muted">{s.ready ? 'Your order is ready on shelf' : 'Your order will be on shelf'}</span><b style={{ fontSize: 44, lineHeight: 1.1 }}>{s.shelf}</b></div>;
}
export function OnMyWay({ token }) {
  const [on, setOn] = useState(false); const [eta, setEta] = useState(null); const [err, setErr] = useState(''); const watch = useRef(null); const last = useRef(0);
  const stop = () => { if (watch.current !== null) navigator.geolocation.clearWatch(watch.current); watch.current = null; setOn(false); };
  useEffect(() => () => { if (watch.current !== null) navigator.geolocation.clearWatch(watch.current); }, []);
  const start = () => {
    if (!navigator.geolocation) { setErr('This phone cannot share location.'); return; }
    setErr(''); setOn(true);
    watch.current = navigator.geolocation.watchPosition((p) => {
      if (Date.now() - last.current < 25000) return; last.current = Date.now();
      api(`/g/${token}/eta`, { method: 'POST', body: { lat: p.coords.latitude, lng: p.coords.longitude } }).then((r) => { setEta(r); if (r.arrived) stop(); }).catch((e) => { setErr(e.message); stop(); });
    }, () => { setErr('Allow location to share how far away you are.'); stop(); }, { enableHighAccuracy: true, maximumAge: 15000 });
  };
  return on || eta ? (
    <div className="stack" style={{ gap: 6 }}>
      <span style={{ fontSize: 14 }}>{eta ? (eta.arrived ? "You're here. We'll bring it out." : `About ${eta.etaMinutes} min away (${eta.km} km). We'll have it ready.`) : 'Sharing your location…'}</span>
      {on && <button className="btn ghost sm" onClick={() => { stop(); api(`/g/${token}/eta`, { method: 'POST', body: { lat: 0, lng: 0, stop: true } }).catch(() => {}); }}>Stop sharing</button>}
    </div>
  ) : <><button className="btn block" onClick={start}>I'm on my way (share location)</button>{err && <span className="lock-msg">{err}</span>}</>;
}

/* ================= Reports ================= */
export function DishRatings() {
  const [d] = useLive(['feedback'], () => api('/staff/dish-ratings').catch(() => null));
  if (!d?.dishes.length) return null;
  return (
    <section className="panel" style={{ marginTop: 18 }}><div className="panel-h"><h3 className="grow">How each dish rated</h3><span className="dim" style={{ fontSize: 12.5 }}>Last {d.days} days</span></div>
      <table className="list"><tbody>{d.dishes.map((x) => <tr key={x.name}><td><b>{x.name}</b></td><td className="num">{x.up} loved</td><td className="num muted">{x.down} not great</td><td style={{ width: '30%' }}><div className="bar"><i style={{ display: 'block', height: '100%', width: `${x.pct}%`, background: x.pct < 60 ? 'var(--dirty)' : 'var(--seated, #3cb4a0)' }} /></div></td><td className="num">{x.pct}%</td></tr>)}</tbody></table>
    </section>
  );
}
export function CookStats({ days }) {
  const [d] = useLive(['orders'], () => api(`/staff/cook-stats?days=${days}`).catch(() => null), [days]);
  if (!d) return null;
  return (
    <section className="panel"><div className="panel-h"><h3>By cook</h3></div>{d.cooks.length === 0 ? <div className="panel-b muted">Cooks pick their name on the area screen ("Who's cooking?") so their dishes and remakes are counted here.</div> : (
      <table className="list"><thead><tr><th>Cook</th><th>Dishes</th><th>Average</th><th>Remakes</th></tr></thead><tbody>{d.cooks.map((c) => <tr key={c.userId}><td><b>{c.name}</b></td><td className="num">{c.items}</td><td className="num">{c.avgMinutes} min</td><td className="num">{c.remakes} <span className="dim">({c.remakePct}%)</span></td></tr>)}</tbody></table>)}</section>
  );
}

/* ================= Settings ================= */
export function PassPanel({ f, setF }) {
  const { settings } = useCC();
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  let quick = []; try { quick = JSON.parse(f.kds_quick_messages || '[]'); } catch { quick = []; }
  return (
    <section className="panel"><div className="panel-h"><h3>Pass, pickup and schedules</h3></div><div className="panel-b stack">
      <label className="field"><span>Alert when finished food waits at the pass this many minutes (0 = off; needs "Orders wait for expo")</span><input className="input" style={{ width: 90 }} type="number" min={0} max={30} value={f.pass_alert_minutes} onChange={(e) => setF({ ...f, pass_alert_minutes: e.target.value })} /></label>
      <label className="field"><span>Online orders per 15-minute pickup slot (0 = no limit)</span><input className="input" style={{ width: 90 }} type="number" min={0} max={200} value={f.slot_capacity} onChange={(e) => setF({ ...f, slot_capacity: e.target.value })} /></label>
      <label className="field"><span>Pickup shelves or cubbies (like "A1-A6, B1-B6", or just a number)</span><input className="input" value={f.pickup_shelves} onChange={(e) => setF({ ...f, pickup_shelves: e.target.value })} maxLength={200} placeholder="Leave blank if you don't use shelves" /></label>
      <label className="field"><span>Quick messages on kitchen screens (one per line)</span><textarea className="input" rows={4} value={quick.join('\n')} onChange={(e) => setF({ ...f, kds_quick_messages: JSON.stringify(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12)) })} /></label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.dish_ratings !== '0'} onChange={flag('dish_ratings')} />Ask guests to rate each dish in their feedback</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.schedule_by_area === '1'} onChange={flag('schedule_by_area')} />Build schedules by area: kitchen areas get cooks from their own team (set in Labor by area), based on that area's sales</label>
      {f.schedule_by_area === '1' && <label className="field"><span>Kitchen sales one cook can handle per hour ({settings.currency})</span><input className="input" style={{ width: 120 }} inputMode="decimal" value={(Number(f.area_sales_per_hour_cents || 0) / 100).toFixed(0)} onChange={(e) => setF({ ...f, area_sales_per_hour_cents: String(Math.max(100, Math.round(Number(e.target.value.replace(/[^\d.]/g, '') || 0) * 100))) })} /></label>}
    </div></section>
  );
}
