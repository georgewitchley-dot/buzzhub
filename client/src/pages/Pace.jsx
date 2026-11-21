import { useState } from 'react';
import { api } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';

const t12 = (hm) => new Date(`2000-01-01T${hm}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* ================= Curbside: on the customer's order page ================= */
export function Curbside({ token, c }) {
  const [note, setNote] = useState(c.note || ''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const send = async () => { setBusy(true); setErr(''); try { await api(`/g/${token}/here`, { method: 'POST', body: { note: note || undefined } }); navigator.vibrate?.(40); } catch (e) { setErr(e.message); } setBusy(false); };
  return (
    <div className="card stack">
      <b>{c.arrived ? "We know you're here" : 'Picking up from the car?'}</b>
      {c.arrived ? <span className="muted" style={{ fontSize: 14 }}>Hang tight. We'll bring it out{c.note ? ` to: ${c.note}` : ''}.</span> : <>
        <span className="muted" style={{ fontSize: 14 }}>Tap when you arrive and we'll bring your order out.</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} placeholder={c.prompt} aria-label={c.prompt} />
        {err && <div className="lock-msg">{err}</div>}
        <button className="btn primary lg block" disabled={busy} onClick={send}>I'm here</button>
      </>}
      {c.arrived && <button className="btn ghost sm" onClick={send} disabled={busy}>Update where I am</button>}
    </div>
  );
}
/** Orders board: "here" chip and "Brought out" button. */
export function HereChip({ o }) {
  const toast = useToast();
  if (!o.arrived_at || o.handed_at) return null;
  return <><span className="chip rose">Here{o.arrival_note ? `: ${o.arrival_note}` : ''}</span><button className="btn sm" onClick={() => api(`/staff/orders/${o.id}/handed`, { method: 'POST' }).then(() => toast(`#${o.number} brought out`, 'ok')).catch((e) => toast(e.message, 'err'))}>Brought out</button></>;
}

/* ================= Break planner (Shifts) ================= */
export function BreakPlanner() {
  const { can } = useCC(); const toast = useToast();
  const [d, reload] = useLive(['shifts'], () => (can('manager') ? api('/staff/break-plan') : Promise.resolve(null)));
  if (!d || !d.plan.length) return null;
  const start = (p) => api(`/staff/users/${p.userId}/punch`, { method: 'POST', body: { action: 'break_start' } }).then(() => { toast(`${p.name.split(' ')[0]} is on break`, 'ok'); reload(); }).catch((e) => toast(e.message, 'err'));
  const max = Math.max(1, ...d.curve);
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">Break plan</h3><span className="dim" style={{ fontSize: 12.5 }}>{d.breakMinutes}-minute breaks at the quietest times, at most {d.maxAtOnce} at once, before {d.breakAfterHours} hours on the clock.</span></div>
      <div className="break-curve" aria-hidden="true">{d.curve.map((c, i) => <i key={i} className={i === d.nowHour ? 'now' : ''} style={{ height: `${Math.max(3, (c / max) * 100)}%` }} title={`${new Date(2000, 0, 1, i).toLocaleTimeString([], { hour: 'numeric' })}`} />)}</div>
      <table className="list"><tbody>{d.plan.map((p) => <tr key={p.userId}><td><b>{p.name}</b><div className="dim" style={{ fontSize: 12 }}>{p.position}</div></td><td>{p.overdue ? <span className="chip rose">Overdue</span> : p.now ? <span className="chip amber">Now</span> : <span className="chip">{t12(p.suggest)}</span>}<span className="dim" style={{ fontSize: 12.5 }}> due by {t12(p.dueBy)}</span></td><td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => start(p)}>Start break</button></td></tr>)}</tbody></table>
    </section>
  );
}

/* ================= Kitchen speed report ================= */
export function KitchenSpeed() {
  const [days, setDays] = useState(7);
  const [d] = useLive(['orders'], () => api(`/staff/kitchen-speed?days=${days}`), [days]);
  if (!d) return null;
  const T = ({ title, rows, label = (k) => k, empty }) => (
    <section className="panel"><div className="panel-h"><h3>{title}</h3></div>{rows.length === 0 ? <div className="panel-b muted">{empty || 'Not enough tickets yet.'}</div> : (
      <table className="list"><thead><tr><th /><th>Tickets</th><th>Average</th><th>Slowest 10%</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key}><td><b>{label(r.key)}</b></td><td className="num">{r.n}</td><td className="num">{r.avg} min</td><td className="num muted">{r.p90} min</td><td style={{ width: '30%' }}><div className="bar"><i style={{ width: `${Math.min(100, (r.avg / Math.max(d.lateMinutes, 1)) * 100)}%`, background: r.avg >= d.lateMinutes ? 'var(--dirty)' : undefined }} /></div></td></tr>)}</tbody></table>)}</section>
  );
  return (
    <>
      <PageHead title="Kitchen speed" sub={`Time from ticket in to ready. Tickets count as late after ${d.lateMinutes} minutes.`}>
        <div className="seg">{[1, 7, 30].map((n) => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n === 1 ? 'Today' : `${n} days`}</button>)}</div>
      </PageHead>
      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{d.overall.avg} min</div><div className="l">Average ticket</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{d.overall.p90} min</div><div className="l">Slowest 10%</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem', color: d.late ? 'var(--dirty)' : undefined }}>{d.late}</div><div className="l">Late tickets</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{d.overall.n}</div><div className="l">Tickets</div></div>
      </div>
      <div className="stack" style={{ gap: 18 }}>
        <T title="By area" rows={d.byArea} empty="Area times appear once cooks mark items done on the area screens." />
        <T title="By hour" rows={d.byHour} label={(k) => new Date(2000, 0, 1, Number(k)).toLocaleTimeString([], { hour: 'numeric' })} />
        <T title="By day" rows={d.byDay} />
        <T title="By how it was ordered" rows={d.byChannel} />
        <T title="Slowest dishes" rows={d.byDish} />
        {d.slowest.length > 0 && <section className="panel"><div className="panel-h"><h3>Slowest tickets</h3></div><table className="list"><tbody>{d.slowest.map((t) => <tr key={t.id}><td><b>#{t.number}</b> <span className="dim">{t.items} items</span></td><td className="muted">{new Date(`${t.at.replace(' ', 'T')}Z`).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</td><td className="num">{t.minutes} min</td></tr>)}</tbody></table></section>}
      </div>
    </>
  );
}

/* ================= Event menu (Private rooms) ================= */
export function EventMenu({ b, onSaved }) {
  const toast = useToast(); const [f, setF] = useState(null); const [menu, setMenu] = useState([]);
  const open = () => api('/staff/menu').then((m) => { const list = (Array.isArray(m) ? m : m.items).filter((i) => i.active); setMenu(list); let lines = []; try { lines = JSON.parse(b.menu || '[]'); } catch { /* none */ } setF({ qty: Object.fromEntries(lines.map((l) => [l.itemId, l.qty])), fire: b.fire_time || '' }); });
  const lines = f ? Object.entries(f.qty).filter(([, q]) => Number(q) > 0).map(([id, q]) => ({ itemId: Number(id), qty: Number(q) })) : [];
  const save = () => api(`/staff/rooms/bookings/${b.id}/menu`, { method: 'PUT', body: { lines, fireTime: f.fire } }).then(() => { toast('Event menu saved', 'ok'); setF(null); onSaved?.(); }).catch((e) => toast(e.message, 'err'));
  const fire = () => api(`/staff/rooms/bookings/${b.id}/fire`, { method: 'POST' }).then((r) => { toast(`Sent to the kitchen as order #${r.number}`, 'ok'); onSaved?.(); }).catch((e) => toast(e.message, 'err'));
  let count = 0; try { count = JSON.parse(b.menu || '[]').length; } catch { count = 0; }
  return (
    <>
      {b.fired_order_id ? <span className="chip teal">Menu sent</span> : <button className="btn sm ghost" onClick={open}>{count ? `Menu (${count})` : 'Event menu'}</button>}
      {count > 0 && !b.fired_order_id && b.status === 'confirmed' && <button className="btn sm" onClick={() => confirm('Send the event menu to the kitchen now?') && fire()}>Send to kitchen</button>}
      {f && (
        <Modal title={`Event menu: ${b.name}, ${b.guests} guests`} onClose={() => setF(null)} width={520}>
          <p className="muted" style={{ margin: 0 }}>How many of each dish. The kitchen screens show today's event menus ahead of time, and the order is sent to the kitchen at the time you choose (or tap Send to kitchen).</p>
          <div className="event-menu">{menu.map((m) => <label key={m.id} className="row"><span className="grow">{m.name} <span className="dim">{m.category}</span></span><input className="input" style={{ width: 80, height: 32 }} type="number" min={0} max={500} value={f.qty[m.id] || ''} onChange={(e) => setF({ ...f, qty: { ...f.qty, [m.id]: e.target.value } })} aria-label={`${m.name} count`} /></label>)}</div>
          <label className="field"><span>Send to the kitchen at (optional)</span><input className="input" type="time" value={f.fire} onChange={(e) => setF({ ...f, fire: e.target.value })} /></label>
          <button className="btn primary lg block" onClick={save}>Save menu ({lines.reduce((a, l) => a + l.qty, 0)} dishes)</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Settings panel ================= */
export function PacePanel({ f, setF }) {
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  return (
    <section className="panel"><div className="panel-h"><h3>Curbside, breaks and tips</h3></div><div className="panel-b stack">
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.curbside === '1'} onChange={flag('curbside')} />Curbside pickup: customers tap "I'm here" on their order page</label>
      {f.curbside === '1' && <label className="field"><span>What to ask them</span><input className="input" value={f.curbside_prompt} onChange={(e) => setF({ ...f, curbside_prompt: e.target.value })} maxLength={60} placeholder="Car color and make, or parking spot" /></label>}
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.declare_tips === '1'} onChange={flag('declare_tips')} />Ask staff for cash tips when they clock out (goes into the payroll files)</label>
      <label className="field"><span>Planned break length (minutes, for the break plan)</span><input className="input" style={{ width: 90 }} type="number" min={10} max={120} value={f.break_minutes_planned} onChange={(e) => setF({ ...f, break_minutes_planned: e.target.value })} /></label>
    </div></section>
  );
}
