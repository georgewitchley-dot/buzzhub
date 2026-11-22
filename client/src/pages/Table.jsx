import { useEffect, useRef, useState } from 'react';
import { api, money } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { PayExtras, SplitBySeat } from './Station.jsx';

/* ================= Pad: my tables + pay at the table ================= */
export function PadTables({ tableId, onPick }) {
  const { settings } = useCC(); const cur = settings.currency;
  const [all, setAll] = useState(() => localStorage.getItem('bh_pad_all') === '1');
  const [d] = useLive(['tables', 'orders'], () => api('/staff/pad/tables'));
  if (!d) return null;
  const mine = d.tables.filter((t) => t.mine); const list = all || !mine.length ? d.tables : mine;
  return (
    <div className="stack" style={{ gap: 8, marginBottom: 12 }}>
      <div className="row"><b className="grow">{all || !mine.length ? `All ${settings.unit_label.toLowerCase()}s` : `My ${settings.unit_label.toLowerCase()}s (${mine.length})`}</b>{mine.length > 0 && <button className="btn sm ghost" onClick={() => { setAll(!all); localStorage.setItem('bh_pad_all', all ? '0' : '1'); }}>{all ? 'Just mine' : 'Show all'}</button>}</div>
      <div className="pad-tables">{list.map((t) => (
        <button key={t.id} className={`pad-table ${String(t.id) === String(tableId) ? 'on' : ''} ${t.status}`} onClick={() => onPick(t)}>
          <b>{t.label}</b>
          <span>{t.seatedMinutes !== null ? (t.seatedMinutes >= 60 ? `${Math.floor(t.seatedMinutes / 60)}h ${t.seatedMinutes % 60}m` : `${t.seatedMinutes}m`) : t.status === 'open' ? 'Open' : t.status}</span>
          {t.openCents > 0 && <span className="num">{money(t.openCents, cur)}</span>}
          {t.foodReady && <span className="chip teal" style={{ fontSize: 10 }}>Food ready</span>}
          {t.joinedTo && <span className="dim" style={{ fontSize: 11 }}>with {t.joinedTo}</span>}{t.joinedWith?.length > 0 && <span className="dim" style={{ fontSize: 11 }}>+ {t.joinedWith.join(', ')}</span>}
        </button>
      ))}</div>
    </div>
  );
}
export function PadPay({ tableId, label, onClose }) {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [b, setB] = useState(null); const [qr, setQr] = useState(null); const [tip, setTip] = useState(''); const [splitting, setSplitting] = useState(false);
  const load = () => api('/staff/bills', { method: 'POST', body: { tableId: Number(tableId) } }).then(setB).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const take = (method) => api(`/staff/bills/${b.id}/payments`, { method: 'POST', body: { split: 'full', method, tipCents: Math.round(Number(tip || 0) * 100) } }).then((r) => { setB({ ...b, ...r }); toast(`${method === 'cash' ? 'Cash' : 'Card'} payment recorded`, 'ok'); if (r.remainingCents <= 0) onClose(true); }).catch((e) => toast(e.message, 'err'));
  return (
    <Modal title={`Check for ${settings.unit_label} ${label}`} onClose={() => onClose(false)} width={460}>
      {!b ? null : b.items.length === 0 ? <span className="muted">Nothing on this check.</span> : <>
        <div className="stack" style={{ gap: 4, maxHeight: 220, overflow: 'auto' }}>{b.items.map((i) => <div key={i.id} className="row" style={{ fontSize: 14 }}><span className="grow">{i.qty} {i.name}</span><span className="num">{money(i.shareCents ?? i.price_cents * i.qty, cur)}</span></div>)}</div>
        <div className="row"><b className="grow">Due</b><b className="num" style={{ fontSize: 22 }}>{money(b.remainingCents, cur)}</b></div>
        {b.remainingCents > 0 && <>
          <PayExtras bill={b} onChange={load} />
          {splitting ? <SplitBySeat bill={b} onPaid={load} /> : <button className="btn sm" onClick={() => setSplitting(true)}>Split by seat</button>}
          <label className="field"><span>Tip (optional)</span><input className="input" inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" /></label>
          <div className="row"><button className="btn primary lg grow" onClick={() => take('cash')}>Took cash</button><button className="btn lg grow" onClick={() => take('card')}>Paid on card reader</button></div>
          {qr ? <div className="pad-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} /> : <button className="btn block" onClick={() => api(`/staff/bills/${b.id}/qr`).then(setQr)}>Guest pays on their phone (show QR)</button>}
          {qr && <span className="dim" style={{ fontSize: 12.5, textAlign: 'center' }}>They can split it, tip and pay. This updates when they pay.</span>}
        </>}
        {b.remainingCents <= 0 && <div className="chip teal" style={{ alignSelf: 'center' }}>Paid in full</div>}
      </>}
    </Modal>
  );
}

/* ================= Area screens: offline cache + queue ================= */
const QKEY = 'bh_kds_queue';
export const kdsOffline = {
  save(area, data) { try { localStorage.setItem(`bh_kds_cache_${area}`, JSON.stringify({ at: Date.now(), data })); } catch { /* full */ } },
  load(area) { try { return JSON.parse(localStorage.getItem(`bh_kds_cache_${area}`) || 'null'); } catch { return null; } },
  queue() { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } },
  push(item) { const q = kdsOffline.queue(); q.push({ ...item, at: Date.now() }); localStorage.setItem(QKEY, JSON.stringify(q.slice(-100))); },
  async flush(send) {
    const q = kdsOffline.queue(); if (!q.length) return 0; let sent = 0;
    for (const item of q) { try { await send(item); sent++; } catch (e) { if (!e.status) break; sent++; /* the server said no: drop it */ } }
    localStorage.setItem(QKEY, JSON.stringify(q.slice(sent))); return sent;
  },
};

/* ================= Table timeline (expo, runner, floor) ================= */
const STATE = { held: 'Waiting', cooking: 'Cooking', ready: 'At the pass', served: 'Served' };
export function TimelineStrip({ list, unit }) {
  if (!list?.length) return null;
  return (
    <div className="timeline-strip">{list.map((t) => (
      <div key={t.id} className="tl-table"><b>{unit} {t.label}</b><span className="dim">{t.minutes !== null ? (t.minutes >= 60 ? `${Math.floor(t.minutes / 60)}h ${t.minutes % 60}m` : `${t.minutes}m`) : ''}{t.party ? ` · ${t.party}` : ''}</span>
        <div className="row" style={{ gap: 3 }}>{t.courses.length ? t.courses.map((c) => <span key={c.course} className={`tl-c ${c.state}`} title={`Course ${c.course}: ${STATE[c.state]}`}>{c.course}</span>) : <span className="dim" style={{ fontSize: 12 }}>Not ordered</span>}</div>
      </div>
    ))}</div>
  );
}
export function FloorTimeline() {
  const { settings } = useCC();
  const [list] = useLive(['orders', 'tables'], () => api('/staff/table-timeline').catch(() => []));
  if (!list?.length) return null;
  return <section className="panel" style={{ marginBottom: 12 }}><div className="panel-h"><h3 className="grow">Where each table is</h3><span className="dim" style={{ fontSize: 12 }}>Numbers are courses: grey waiting, amber cooking, teal at the pass, dim served</span></div><div className="panel-b"><TimelineStrip list={list} unit={settings.unit_label} /></div></section>;
}

/* ================= Expo photo check ================= */
export function PlatePhoto({ order, hdr, onDone, onClose }) {
  const v = useRef(null); const st = useRef(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment', width: 960 }, audio: false }).then((s) => { st.current = s; if (v.current) { v.current.srcObject = s; v.current.play().catch(() => {}); } }).catch(() => setErr('Allow the camera on this tablet to take plate photos.'));
    return () => st.current?.getTracks().forEach((t) => t.stop());
  }, []);
  const snap = async () => {
    const el = v.current; if (!el?.videoWidth) return; setBusy(true);
    const c = document.createElement('canvas'); c.width = 640; c.height = Math.round((640 * el.videoHeight) / el.videoWidth); c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
    try { await api('/kds/plate-photo', { method: 'POST', body: { orderId: order.id, photo: c.toDataURL('image/jpeg', 0.7) }, headers: hdr }); onDone(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`Plate photo: #${order.number}`} onClose={onClose} width={560}>
      {order.allergy && <div className="ticket-allergy">ALLERGY: {order.allergy}</div>}
      <video ref={v} muted playsInline style={{ width: '100%', borderRadius: 12, background: '#000' }} />
      {err && <div className="lock-msg">{err}</div>}
      <button className="btn primary lg block" disabled={busy} onClick={snap}>Take photo and complete</button>
    </Modal>
  );
}
export function PlatePhotos() {
  const { can } = useCC(); const [date, setDate] = useState(new Date().toLocaleDateString('en-CA'));
  const [list] = useLive(['orders'], () => (can('manager') ? api(`/staff/plate-photos?date=${date}`).catch(() => []) : Promise.resolve([])), [date]);
  if (!list?.length) return null;
  return <section className="panel"><div className="panel-h"><h3 className="grow">Plate photos</h3><input className="input" type="date" style={{ width: 150, height: 32 }} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day" /></div><div className="punch-photos">{list.map((p) => <figure key={p.id}><img src={p.url} alt={`Order ${p.number}`} loading="lazy" /><figcaption><b>#{p.number}</b> {p.allergy_note ? `allergy: ${p.allergy_note}` : ''} · {p.by_label}</figcaption></figure>)}</div></section>;
}

/* ================= Delivery route ================= */
export function DeliveryRoute() {
  const { user, can } = useCC();
  const [drv, setDrv] = useState(String(user.id));
  const [d] = useLive(['orders'], () => api(`/staff/deliveries/route?driver=${drv}`).catch(() => null), [drv]);
  const [drivers] = useLive([], () => (can('manager') ? api('/staff/delivery-batches').then((x) => x.drivers).catch(() => []) : Promise.resolve([])));
  if (!d || (!d.stops.length && !can('manager'))) return null;
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">Route</h3>{can('manager') && drivers?.length > 0 && <select className="input" style={{ width: 160, height: 32 }} value={drv} onChange={(e) => setDrv(e.target.value)} aria-label="Driver">{drivers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}{d.mapsUrl && <a className="btn sm primary" href={d.mapsUrl} target="_blank" rel="noreferrer">Open in Google Maps</a>}</div>
      {d.stops.length === 0 ? <div className="panel-b muted">No deliveries assigned.</div> : <table className="list"><tbody>{d.stops.map((s) => <tr key={s.id}><td><b>Stop {s.stop}</b></td><td>#{s.number} {s.name}<div className="dim" style={{ fontSize: 12 }}>{s.address}{s.phone ? ` · ${s.phone}` : ''}</div></td><td className="muted">{s.legKm !== null ? `${s.legKm} km` : 'no map pin'}</td><td>{s.out ? <span className="chip amber">On the way</span> : s.ready ? <span className="chip teal">Ready</span> : <span className="chip">Cooking</span>}</td></tr>)}</tbody></table>}
      {d.stops.length > 1 && <div className="panel-b dim" style={{ fontSize: 12.5 }}>About {d.totalKm} km in this order, nearest stop first.</div>}
    </section>
  );
}

/* ================= Server coaching ================= */
export function Coaching() {
  const { settings } = useCC(); const cur = settings.currency; const [days, setDays] = useState(30);
  const [d] = useLive(['orders'], () => api(`/staff/coaching?days=${days}`), [days]);
  if (!d) return null;
  const vs = (v, t) => (t ? <span className={v >= t ? 'dim' : 'rose-text'} style={{ fontSize: 12 }}> {v >= t ? '▲' : '▼'}</span> : null);
  return (
    <>
      <PageHead title="Server coaching" sub="Each person's checks against the team: what they sell per check, how often they add a drink, side or dessert, and tips.">
        <div className="seg">{[7, 30, 90].map((n) => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>)}</div>
      </PageHead>
      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{money(d.team.avgCheckCents, cur)}</div><div className="l">Team check average</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{d.team.itemsPerCheck}</div><div className="l">Items per check</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{d.team.addonPct}%</div><div className="l">Checks with an add-on</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{d.team.tipPct}%</div><div className="l">Tips</div></div>
      </div>
      <section className="panel">{d.people.length === 0 ? <div className="panel-b muted">No paid checks yet in this period.</div> : (
        <table className="list"><thead><tr><th>Who</th><th>Checks</th><th>Sales</th><th>Check average</th><th>Items</th><th>Add-ons</th><th>Tips</th><th>To work on</th></tr></thead>
          <tbody>{d.people.map((p) => <tr key={p.userId}><td><b>{p.name}</b></td><td className="num">{p.checks}</td><td className="num">{money(p.salesCents, cur)}</td><td className="num">{money(p.avgCheckCents, cur)}{vs(p.avgCheckCents, d.team.avgCheckCents)}</td><td className="num">{p.itemsPerCheck}</td><td className="num">{p.addonPct}%{vs(p.addonPct, d.team.addonPct)}</td><td className="num">{p.tipPct}%{vs(p.tipPct, d.team.tipPct)}</td><td className="muted" style={{ fontSize: 13 }}>{p.tips.length ? p.tips.join('. ') : p.checks < 5 ? 'Not enough checks yet' : 'On track'}</td></tr>)}</tbody></table>
      )}</section>
      <p className="dim" style={{ fontSize: 12.5 }}>Add-ons count drinks, sides, starters and desserts (by menu category name). Use this for coaching, not ranking: sections and shifts differ.</p>
    </>
  );
}

/* ================= Settings ================= */
export function TablePanel({ f, setF }) {
  return (
    <section className="panel"><div className="panel-h"><h3>Plate photos</h3></div><div className="panel-b stack">
      <label className="field"><span>Expo takes a photo of the plate before completing</span><select className="input" value={f.photo_check} onChange={(e) => setF({ ...f, photo_check: e.target.value })}><option value="off">Never</option><option value="allergy">Allergy orders</option><option value="special">Allergy and event orders</option><option value="all">Every order</option></select></label>
      <span className="dim" style={{ fontSize: 12.5 }}>Photos are kept 60 days and shown to managers on Kitchen speed.</span>
    </div></section>
  );
}
