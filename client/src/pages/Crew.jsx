import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent, money } from '../lib.js';
import { Modal, Puck, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);
const at = (sql) => new Date(`${sql.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const t12 = (hm) => new Date(`2000-01-01T${hm}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const locQ = () => { const l = new URLSearchParams(location.search).get('l'); return l ? `?l=${l}` : ''; };

/* ================= Shift handoff notes (Overview, Shifts) ================= */
export function HandoffNotes() {
  const { user, can, settings } = useCC(); const toast = useToast();
  const [list, reload] = useLive(['handoff'], () => api('/staff/handoff').catch(() => []));
  const [text, setText] = useState('');
  if (!list || settings.handoff_notes === '0') return null;
  const add = () => api('/staff/handoff', { method: 'POST', body: { body: text } }).then(() => { setText(''); reload(); }).catch((e) => toast(e.message, 'err'));
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">Shift handoff</h3><span className="dim" style={{ fontSize: 12.5 }}>Notes for the next shift. Staff can also leave one when they clock out.</span></div>
      <div className="panel-b stack">
        {list.length === 0 && <span className="muted">No notes in the last day and a half.</span>}
        {list.map((n) => <div key={n.id} className="row" style={{ alignItems: 'flex-start' }}><div className="grow"><b>{n.name.split(' ')[0]}</b> <span className="dim" style={{ fontSize: 12.5 }}>{new Date(`${n.at.replace(' ', 'T')}Z`).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span><div>{n.body}</div></div>{(n.user_id === user.id || can('manager')) && <button className="btn sm ghost" onClick={() => api(`/staff/handoff/${n.id}`, { method: 'DELETE' }).then(reload)}>Remove</button>}</div>)}
        <div className="row"><input className="input grow" placeholder="Leave a note for the next shift" value={text} onChange={(e) => setText(e.target.value)} maxLength={600} onKeyDown={(e) => e.key === 'Enter' && text.trim() && add()} /><button className="btn" disabled={!text.trim()} onClick={add}>Add</button></div>
      </div>
    </section>
  );
}

/* ================= Punch photos (Shifts, managers) ================= */
export function PunchPhotos() {
  const { can, settings } = useCC();
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA'));
  const [d] = useLive(['shifts'], () => (can('manager') && settings.punch_photo === '1' ? api(`/staff/punch-photos?date=${date}`) : Promise.resolve(null)), [date]);
  if (!d) return null;
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">Clock-in photos</h3><input className="input" type="date" style={{ width: 150, height: 32 }} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day" /></div>
      {d.photos.length === 0 ? <div className="panel-b muted">No photos this day. Photos are kept for 60 days.</div> : <div className="punch-photos">{d.photos.map((p) => <figure key={p.id}><img src={p.url} alt={`${p.name} ${p.action}`} loading="lazy" /><figcaption><b>{p.name.split(' ')[0]}</b> {p.action === 'in' ? 'in' : p.action === 'out' ? 'out' : 'break'} {at(p.at)}</figcaption></figure>)}</div>}
    </section>
  );
}

/* ================= Payroll files (Payroll page) ================= */
export function PayrollFiles({ from, to }) {
  const toast = useToast(); const [ids, setIds] = useState(null);
  return (
    <>
      <a className="btn" href={`/api/staff/payroll?from=${from}&to=${to}&format=gusto`} download>Gusto file</a>
      <a className="btn" href={`/api/staff/payroll?from=${from}&to=${to}&format=adp`} download>ADP file</a>
      <button className="btn ghost" onClick={() => api('/staff/payroll-ids').then(setIds)}>Employee IDs</button>
      {ids && (
        <Modal title="Payroll employee IDs" onClose={() => setIds(null)} width={460}>
          <p className="muted" style={{ margin: 0 }}>Type each person's employee ID from Gusto, or their file number from ADP, so the file matches the right person.</p>
          <table className="list"><tbody>{ids.map((u) => <tr key={u.id}><td>{u.name}</td><td><input className="input" style={{ width: 140, height: 32 }} defaultValue={u.payroll_id || ''} maxLength={20} onBlur={(e) => e.target.value !== (u.payroll_id || '') && api(`/staff/users/${u.id}/payroll-id`, { method: 'PUT', body: { payrollId: e.target.value } }).then(() => toast('Saved', 'ok'))} aria-label={`${u.name} ID`} /></td></tr>)}</tbody></table>
        </Modal>
      )}
    </>
  );
}

/* ================= Use first (ingredient batches) ================= */
export function UseFirst() {
  const toast = useToast();
  const [d, reload] = useLive(['lots', 'menu'], () => api('/staff/lots'));
  const [f, setF] = useState(null); const [shelf, setShelf] = useState(false);
  if (!d) return null;
  const act = (l, what) => api(`/staff/lots/${l.id}/${what}`, { method: 'POST', body: {} }).then(() => { toast(what === 'used' ? 'Marked used up' : 'Logged as waste', 'ok'); reload(); }).catch((e) => toast(e.message, 'err'));
  const chip = (l) => (l.state === 'expired' ? <span className="chip rose">Expired {-l.daysLeft}d ago</span> : l.daysLeft === 0 ? <span className="chip rose">Use today</span> : l.daysLeft === 1 ? <span className="chip amber">Use by tomorrow</span> : <span className="chip">Use by {day(l.use_by)}</span>);
  return (
    <>
      <PageHead title="Use first" sub="Batches of ingredients with their use-by dates, oldest first. Received orders add batches by themselves for ingredients with a shelf life set.">
        <button className="btn" onClick={() => setShelf(true)}>Shelf life</button>
        <button className="btn primary" onClick={() => setF({ ingredientId: d.ingredients[0]?.id, qty: '', useBy: '' })} disabled={!d.ingredients.length}>Add a batch</button>
      </PageHead>
      <section className="panel">{d.lots.length === 0 ? <div className="panel-b muted">No open batches. Set how many days each ingredient keeps under Shelf life, then receive an order or add a batch.</div> : (
        <table className="list"><tbody>{d.lots.map((l) => <tr key={l.id} className={l.state !== 'ok' ? 'warn-row' : ''}><td><b>{l.name}</b>{l.useFirst && <span className="chip teal" style={{ marginLeft: 6 }}>Use this one first</span>}<div className="dim" style={{ fontSize: 12 }}>{l.qty} {l.unit}, received {day(l.received_on)}{l.source ? ` (${l.source})` : ''}</div></td><td>{chip(l)}</td>
          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn sm" onClick={() => act(l, 'used')}>Used up</button><button className="btn sm ghost" onClick={() => confirm(`Throw out ${l.qty} ${l.unit} ${l.name}? It's logged as waste and taken off stock.`) && act(l, 'toss')}>Thrown out</button></td></tr>)}</tbody></table>
      )}</section>
      {d.closed.length > 0 && <details style={{ marginTop: 14 }}><summary className="muted" style={{ cursor: 'pointer' }}>Recently closed</summary><table className="list"><tbody>{d.closed.map((l) => <tr key={l.id}><td>{l.name}</td><td className="muted">{l.qty} {l.unit}</td><td>{l.status === 'tossed' ? <span className="chip rose">Thrown out</span> : <span className="chip teal">Used</span>}</td></tr>)}</tbody></table></details>}
      {f && (
        <Modal title="Add a batch" onClose={() => setF(null)} width={420}>
          <label className="field"><span>Ingredient</span><select className="input" value={f.ingredientId} onChange={(e) => setF({ ...f, ingredientId: Number(e.target.value) })}>{d.ingredients.map((g) => <option key={g.id} value={g.id}>{g.name}{g.shelf_days ? ` (keeps ${g.shelf_days} days)` : ''}</option>)}</select></label>
          <div className="row"><label className="field grow"><span>Amount</span><input className="input" inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label><label className="field grow"><span>Use by {d.ingredients.find((g) => g.id === f.ingredientId)?.shelf_days ? '(optional)' : ''}</span><input className="input" type="date" value={f.useBy} onChange={(e) => setF({ ...f, useBy: e.target.value })} /></label></div>
          <button className="btn primary lg block" disabled={!Number(f.qty)} onClick={() => api('/staff/lots', { method: 'POST', body: { ingredientId: f.ingredientId, qty: Number(f.qty), ...(f.useBy ? { useBy: f.useBy } : {}) } }).then(() => { setF(null); reload(); }).catch((e) => toast(e.message, 'err'))}>Save</button>
        </Modal>
      )}
      {shelf && (
        <Modal title="How long each ingredient keeps" onClose={() => setShelf(false)} width={440}>
          <p className="muted" style={{ margin: 0 }}>Days from delivery to use-by. Leave blank for things you don't track (dry goods).</p>
          <table className="list"><tbody>{d.ingredients.map((g) => <tr key={g.id}><td>{g.name}</td><td><input className="input" style={{ width: 80, height: 32 }} type="number" min={0} max={730} defaultValue={g.shelf_days || ''} onBlur={(e) => Number(e.target.value || 0) !== (g.shelf_days || 0) && api(`/staff/ingredients/${g.id}/shelf-days`, { method: 'PUT', body: { days: Number(e.target.value || 0) } }).then(reload)} aria-label={`${g.name} days`} /> days</td></tr>)}</tbody></table>
        </Modal>
      )}
    </>
  );
}

/* ================= Table turn report ================= */
export function TableTurns() {
  const { settings } = useCC(); const cur = settings.currency; const unit = settings.unit_label || 'Table';
  const [days, setDays] = useState(30);
  const [d] = useLive(['tables'], () => api(`/staff/table-turns?days=${days}`), [days]);
  if (!d) return null;
  const T = ({ title, rows, label = (k) => k }) => rows.length === 0 ? null : (
    <section className="panel"><div className="panel-h"><h3>{title}</h3></div><table className="list"><thead><tr><th /><th>Turns</th><th>Average</th><th>Middle</th><th>Spend per {unit.toLowerCase()}</th><th>Per guest</th><th>Per hour</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.key}><td><b>{label(r.key)}</b></td><td className="num">{r.turns}</td><td className="num">{r.avgMinutes} min</td><td className="num muted">{r.medianMinutes} min</td><td className="num">{money(r.avgSpendCents, cur)}</td><td className="num">{money(r.spendPerCoverCents, cur)}</td><td className="num">{money(r.spendPerHourCents, cur)}</td></tr>)}</tbody></table></section>
  );
  return (
    <>
      <PageHead title="Table turns" sub={`How long parties stay, from seated to cleared, and what they spend. ${d.total} parties in the last ${days} days.`}>
        <div className="seg">{[7, 30, 90].map((n) => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>)}</div>
      </PageHead>
      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{d.avgMinutes} min</div><div className="l">Average stay</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{d.turnsPerTablePerDay}</div><div className="l">Turns per {unit.toLowerCase()} per day</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{d.total}</div><div className="l">Parties</div></div>
      </div>
      {d.seatedNow.length > 0 && <section className="panel" style={{ marginBottom: 18 }}><div className="panel-h"><h3>Seated now</h3></div><div className="panel-b row wrap" style={{ gap: 8 }}>{d.seatedNow.map((t) => <span key={t.label} className={`chip ${t.over ? 'rose' : ''}`}>{unit} {t.label}: {t.minutes} min{t.typical ? ` (usually ${t.typical})` : ''}</span>)}</div></section>}
      {d.total === 0 ? <div className="panel empty"><b>No finished tables yet</b><span>Seat parties from the waitlist and clear their tables on the Floor. Each stay is counted here.</span></div> : (
        <div className="stack" style={{ gap: 18 }}>
          <T title="By party size" rows={d.bySize} label={(k) => `${k} guests`} />
          <T title="By section" rows={d.byZone} />
          <T title="By day" rows={d.byDay} />
          <T title="By time seated" rows={d.byHour} label={(k) => new Date(2000, 0, 1, Number(k)).toLocaleTimeString([], { hour: 'numeric' })} />
          <T title="By server" rows={d.byServer} />
        </div>
      )}
    </>
  );
}

/* ================= Private rooms ================= */
export function Rooms() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [d, reload] = useLive(['rooms', 'orders'], () => api('/staff/rooms'));
  const [room, setRoom] = useState(null); const [bk, setBk] = useState(null);
  if (!d) return null;
  const saveRoom = () => api(room.id ? `/staff/rooms/${room.id}` : '/staff/rooms', { method: room.id ? 'PUT' : 'POST', body: { name: room.name, capacity: Number(room.capacity), minSpendCents: dollars(room.min), depositPct: Number(room.dep) || 0, feeCents: dollars(room.fee), tableIds: room.tables, description: room.description || undefined, ...(room.id ? { active: room.active } : {}) } }).then(() => { setRoom(null); reload(); }).catch((e) => toast(e.message, 'err'));
  const act = (b, what, body) => api(`/staff/rooms/bookings/${b.id}/${what}`, { method: 'POST', body: body || {} }).then((r) => { if (r.code) toast(`Deposit credit: gift card ${r.code}. Take it off their bill.`, 'ok'); reload(); }).catch((e) => toast(e.message, 'err'));
  const saveBk = () => api('/staff/rooms/bookings', { method: 'POST', body: { roomId: Number(bk.roomId), name: bk.name, email: bk.email || '', phone: bk.phone || undefined, date: bk.date, start: bk.start, end: bk.end, guests: Number(bk.guests), occasion: bk.occasion || undefined, notes: bk.notes || undefined } }).then(() => { setBk(null); reload(); }).catch((e) => toast(e.message, 'err'));
  const status = { requested: <span className="chip amber">Requested</span>, confirmed: <span className="chip teal">Confirmed</span>, declined: <span className="chip">Declined</span>, cancelled: <span className="chip">Cancelled</span>, done: <span className="chip">Done</span> };
  return (
    <>
      <PageHead title="Private rooms" sub="Rooms or the whole place for parties and events, with a minimum spend and a deposit.">
        {settings.rooms_online === '1' && <button className="btn" onClick={() => { navigator.clipboard?.writeText(d.link); toast('Booking link copied', 'ok'); }}>Copy booking link</button>}
        <button className="btn" onClick={() => setRoom({ name: '', capacity: 20, min: '500', dep: '25', fee: '0', tables: [], description: '' })}>Add a room</button>
        <button className="btn primary" disabled={!d.rooms.length} onClick={() => setBk({ roomId: d.rooms[0]?.id, name: '', email: '', date: '', start: '18:00', end: '21:00', guests: 10 })}>Book an event</button>
      </PageHead>
      {d.rooms.length === 0 ? <div className="panel empty"><b>No rooms yet</b><span>Add a room (or "Whole restaurant"), its size, minimum spend and deposit.</span></div> : (
        <div className="row wrap" style={{ gap: 10, marginBottom: 18 }}>{d.rooms.map((r) => <button key={r.id} className="panel" style={{ padding: 12, textAlign: 'left', cursor: 'pointer', opacity: r.active ? 1 : 0.5, minWidth: 200 }} onClick={() => setRoom({ id: r.id, name: r.name, capacity: r.capacity, min: (r.min_spend_cents / 100).toFixed(2), dep: r.deposit_pct, fee: (r.fee_cents / 100).toFixed(2), tables: r.table_ids, description: r.description || '', active: Boolean(r.active) })}>
          <b>{r.name}</b><div className="dim" style={{ fontSize: 12.5 }}>Up to {r.capacity} guests · {money(r.min_spend_cents, cur)} minimum{r.deposit_pct ? ` · ${r.deposit_pct}% deposit` : ''}{r.fee_cents ? ` · ${money(r.fee_cents, cur)} room fee` : ''}</div></button>)}</div>
      )}
      <section className="panel"><div className="panel-h"><h3>Bookings</h3></div>{d.bookings.length === 0 ? <div className="panel-b muted">No upcoming events.</div> : (
        <table className="list"><tbody>{d.bookings.map((b) => {
          const short = b.spendCents !== undefined ? Math.max(0, b.min_spend_cents - b.spendCents) : null;
          return (<tr key={b.id}><td><b>{b.name}</b> <span className="dim">{b.guests} guests{b.occasion ? `, ${b.occasion}` : ''}</span><div className="dim" style={{ fontSize: 12.5 }}>{b.room} · {day(b.date)} {t12(b.start_time)}–{t12(b.end_time)}{b.tables.length ? ` · ${settings.unit_label} ${b.tables.join(', ')}` : ''}{b.email ? ` · ${b.email}` : ''}{b.phone ? ` · ${b.phone}` : ''}</div>{b.notes && <div className="muted" style={{ fontSize: 13 }}>{b.notes}</div>}</td>
            <td>{status[b.status]}<div className="dim" style={{ fontSize: 12 }}>Deposit {money(b.deposit_paid_cents, cur)} of {money(b.deposit_cents, cur)}</div>{short !== null && <div style={{ fontSize: 12.5 }} className={short ? 'rose-text' : ''}>Spent {money(b.spendCents, cur)}{short ? `, ${money(short, cur)} to reach the minimum` : ', minimum reached'}</div>}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {b.status === 'requested' && <><button className="btn sm primary" onClick={() => act(b, 'confirm')}>Confirm</button><button className="btn sm ghost" onClick={() => act(b, 'decline')}>Decline</button></>}
              {b.status === 'confirmed' && <>{b.deposit_paid_cents < b.deposit_cents && <button className="btn sm ghost" onClick={() => { const v = prompt('Deposit taken in person (amount)'); if (dollars(v)) act(b, 'paid', { cents: dollars(v) }); }}>Took deposit</button>}{b.deposit_paid_cents > 0 && !b.credit_code && <button className="btn sm" onClick={() => act(b, 'checkin')}>Check in</button>}{b.credit_code && <span className="chip teal">Credit {b.credit_code}</span>}<button className="btn sm ghost" onClick={() => act(b, 'done')}>Done</button><button className="btn sm ghost" onClick={() => confirm(`Cancel ${b.name}'s event?`) && act(b, 'cancel')}>Cancel</button></>}
            </td></tr>);
        })}</tbody></table>
      )}</section>
      {room && (
        <Modal title={room.id ? room.name : 'Add a room'} onClose={() => setRoom(null)} width={520}>
          <div className="row"><label className="field grow"><span>Name</span><input className="input" value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} maxLength={40} placeholder="Wine room, Patio, Whole restaurant" /></label><label className="field"><span>Guests</span><input className="input" style={{ width: 80 }} type="number" min={1} value={room.capacity} onChange={(e) => setRoom({ ...room, capacity: e.target.value })} /></label></div>
          <div className="row"><label className="field grow"><span>Minimum spend</span><input className="input" inputMode="decimal" value={room.min} onChange={(e) => setRoom({ ...room, min: e.target.value })} /></label><label className="field grow"><span>Room fee</span><input className="input" inputMode="decimal" value={room.fee} onChange={(e) => setRoom({ ...room, fee: e.target.value })} /></label><label className="field"><span>Deposit %</span><input className="input" style={{ width: 80 }} type="number" min={0} max={100} value={room.dep} onChange={(e) => setRoom({ ...room, dep: e.target.value })} /></label></div>
          <label className="field"><span>What guests should know (optional)</span><input className="input" value={room.description} onChange={(e) => setRoom({ ...room, description: e.target.value })} maxLength={300} /></label>
          <span className="muted" style={{ fontSize: 13.5 }}>Tables in this room (so the event's spend is counted toward the minimum):</span>
          <div className="row wrap" style={{ gap: 6 }}>{d.tables.map((t) => <button key={t.id} type="button" className={`chip ${room.tables.includes(t.id) ? 'teal' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={room.tables.includes(t.id)} onClick={() => setRoom({ ...room, tables: room.tables.includes(t.id) ? room.tables.filter((x) => x !== t.id) : [...room.tables, t.id] })}>{t.label} <span className="dim">{t.zone}</span></button>)}</div>
          {room.id && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={room.active} onChange={(e) => setRoom({ ...room, active: e.target.checked })} />Taking bookings</label>}
          <button className="btn primary lg block" disabled={!room.name} onClick={saveRoom}>Save</button>
        </Modal>
      )}
      {bk && (
        <Modal title="Book an event" onClose={() => setBk(null)} width={500}>
          <label className="field"><span>Room</span><select className="input" value={bk.roomId} onChange={(e) => setBk({ ...bk, roomId: e.target.value })}>{d.rooms.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <div className="row"><label className="field grow"><span>Name</span><input className="input" value={bk.name} onChange={(e) => setBk({ ...bk, name: e.target.value })} /></label><label className="field grow"><span>Email</span><input className="input" type="email" value={bk.email} onChange={(e) => setBk({ ...bk, email: e.target.value })} /></label></div>
          <div className="row"><label className="field grow"><span>Date</span><input className="input" type="date" value={bk.date} onChange={(e) => setBk({ ...bk, date: e.target.value })} /></label><label className="field"><span>From</span><input className="input" type="time" value={bk.start} onChange={(e) => setBk({ ...bk, start: e.target.value })} /></label><label className="field"><span>To</span><input className="input" type="time" value={bk.end} onChange={(e) => setBk({ ...bk, end: e.target.value })} /></label><label className="field"><span>Guests</span><input className="input" style={{ width: 70 }} type="number" min={1} value={bk.guests} onChange={(e) => setBk({ ...bk, guests: e.target.value })} /></label></div>
          <div className="row"><label className="field grow"><span>Occasion</span><input className="input" value={bk.occasion || ''} onChange={(e) => setBk({ ...bk, occasion: e.target.value })} maxLength={60} /></label><label className="field grow"><span>Phone</span><input className="input" value={bk.phone || ''} onChange={(e) => setBk({ ...bk, phone: e.target.value })} /></label></div>
          <label className="field"><span>Notes</span><textarea className="input" rows={2} value={bk.notes || ''} onChange={(e) => setBk({ ...bk, notes: e.target.value })} /></label>
          <button className="btn primary lg block" disabled={!bk.name || !bk.date} onClick={saveBk}>Book it</button>
        </Modal>
      )}
    </>
  );
}
/** Floor banner: private events today. */
export function RoomsToday() {
  const { settings } = useCC();
  const [list] = useLive(['rooms', 'orders'], () => api('/staff/rooms/today').catch(() => []));
  if (!list?.length) return null;
  return <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>{list.map((b) => <span key={b.id} className="chip blue">Private event: {b.name}, {b.room} {t12(b.start_time)}–{t12(b.end_time)}{b.tables.length ? ` (${settings.unit_label} ${b.tables.join(', ')})` : ''}, {money(b.spendCents, settings.currency)} of {money(b.min_spend_cents, settings.currency)}</span>)}</div>;
}

/* ================= Public: request a room (/event-rooms) and booking status (/event-room/:token) ================= */
export function PublicRooms() {
  const [d, setD] = useState(null); const [f, setF] = useState({ roomId: null, name: '', email: '', phone: '', date: '', start: '18:00', end: '21:00', guests: 10, occasion: '', notes: '' });
  const [taken, setTaken] = useState([]); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api('/public/rooms').then((x) => { setD(x); applyAccent(x.business.accent); document.title = `${x.business.name}: private events`; if (x.rooms?.[0]) setF((y) => ({ ...y, roomId: x.rooms[0].id })); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { if (f.roomId && f.date) api(`/public/rooms/${f.roomId}/taken?date=${f.date}`).then(setTaken).catch(() => setTaken([])); }, [f.roomId, f.date]);
  if (!d) return <div className="guest">{err && <main className="guest-in"><h1>{err}</h1></main>}</div>;
  const room = d.rooms?.find((r) => r.id === f.roomId);
  const send = async () => { setBusy(true); setErr(''); try { const r = await api('/public/rooms/book', { method: 'POST', body: { ...f, guests: Number(f.guests), phone: f.phone || undefined, occasion: f.occasion || undefined, notes: f.notes || undefined } }); location.href = r.url; } catch (e) { setErr(e.message); } setBusy(false); };
  const min = new Date(Date.now() + (d.leadDays || 2) * 86400000).toLocaleDateString('en-CA');
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.business.accent, '#2a1f55', d.business.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in" style={{ maxWidth: 560 }}>
        <Puck state="buzzed" size={44} />
        <h1>Private events at {d.business.name}</h1>
        {!d.enabled || !d.rooms.length ? <p>Please call us to plan your event.</p> : (
          <div className="card stack" style={{ width: '100%' }}>
            <div className="stack" style={{ gap: 8 }}>{d.rooms.map((r) => <button key={r.id} type="button" className={`btn block ${f.roomId === r.id ? 'primary' : ''}`} style={{ height: 'auto', padding: '10px 14px', textAlign: 'left', display: 'block' }} onClick={() => setF({ ...f, roomId: r.id })}><b>{r.name}</b> <span style={{ opacity: 0.75 }}>up to {r.capacity} guests</span><div style={{ fontSize: 13, opacity: 0.8 }}>{r.minSpendCents ? `${money(r.minSpendCents, d.currency)} minimum spend` : 'No minimum'}{r.feeCents ? `, ${money(r.feeCents, d.currency)} room fee` : ''}{r.depositCents ? `, ${money(r.depositCents, d.currency)} deposit` : ''}</div>{r.description && <div style={{ fontSize: 13, opacity: 0.8 }}>{r.description}</div>}</button>)}</div>
            <div className="row"><label className="field grow"><span>Date</span><input className="input" type="date" min={min} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label><label className="field"><span>Guests</span><input className="input" style={{ width: 80 }} type="number" min={1} max={room?.capacity} value={f.guests} onChange={(e) => setF({ ...f, guests: e.target.value })} /></label></div>
            <div className="row"><label className="field grow"><span>From</span><input className="input" type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label><label className="field grow"><span>To</span><input className="input" type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label></div>
            {taken.length > 0 && <span className="muted" style={{ fontSize: 13 }}>Already booked that day: {taken.map((t) => `${t12(t.start_time)}–${t12(t.end_time)}`).join(', ')}</span>}
            <div className="row"><label className="field grow"><span>Your name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></label><label className="field grow"><span>Phone</span><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" /></label></div>
            <label className="field"><span>Email</span><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></label>
            <label className="field"><span>Occasion (optional)</span><input className="input" value={f.occasion} onChange={(e) => setF({ ...f, occasion: e.target.value })} maxLength={60} placeholder="Birthday, rehearsal dinner, team party" /></label>
            <label className="field"><span>Anything else (optional)</span><textarea className="input" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={600} /></label>
            {err && <div className="lock-msg">{err}</div>}
            <button className="btn primary lg block" disabled={busy || !f.name || !f.email || !f.date} onClick={send}>Request this event</button>
          </div>
        )}
      </main>
    </div>
  );
}
export function RoomBooking() {
  const { token } = useParams(); const [d, setD] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { api(`/v/${token}`).then((x) => { setD(x); applyAccent(x.business.accent); }).catch((e) => setErr(e.message)); }, [token]);
  if (!d) return <div className="guest">{err && <main className="guest-in"><h1>{err}</h1></main>}</div>;
  const b = d.booking; const owed = b.depositCents - b.depositPaidCents;
  const head = { requested: 'Request received', confirmed: 'Your event is booked', declined: 'We can\'t host this one', cancelled: 'This event was cancelled', done: 'Thanks for celebrating with us' }[b.status];
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.business.accent, '#2a1f55', d.business.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in">
        <Puck state={b.status === 'confirmed' ? 'buzzed' : 'idle'} size={44} />
        <h1>{head}</h1>
        <div className="card stack" style={{ width: '100%' }}>
          <b>{b.room} at {d.business.name}</b>
          <span>{day(b.date)}, {t12(b.start)}–{t12(b.end)}, {b.guests} guests{b.occasion ? ` (${b.occasion})` : ''}</span>
          {b.minSpendCents > 0 && <span className="muted">Minimum spend {money(b.minSpendCents, d.currency)}{b.feeCents ? ` plus a ${money(b.feeCents, d.currency)} room fee` : ''}. Your deposit counts toward your bill.</span>}
          {b.status === 'requested' && <span className="muted">We'll email you when it's confirmed.{owed > 0 ? ' Paying the deposit now holds the room.' : ''}</span>}
          {b.depositCents > 0 && <span>{owed > 0 ? `Deposit due: ${money(owed, d.currency)}` : `Deposit paid: ${money(b.depositPaidCents, d.currency)}`}</span>}
          {d.canPay && <button className="btn primary lg block" onClick={() => api(`/v/${token}/pay`, { method: 'POST' }).then((r) => { location.href = r.url; }).catch((e) => setErr(e.message))}>Pay the {money(owed, d.currency)} deposit</button>}
          {err && <div className="lock-msg">{err}</div>}
        </div>
        <a className="btn ghost" href={`/event-rooms${locQ()}`}>Plan another event</a>
      </main>
    </div>
  );
}

/* ================= Settings panel ================= */
export function CrewPanel({ f, setF }) {
  const toast = useToast();
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  const here = () => navigator.geolocation?.getCurrentPosition((p) => { setF({ ...f, biz_lat: p.coords.latitude.toFixed(6), biz_lng: p.coords.longitude.toFixed(6) }); toast('Location set. Save settings to keep it.', 'ok'); }, () => toast('Allow location on this device first', 'err'), { enableHighAccuracy: true, timeout: 10000 });
  const fromAddress = () => api('/staff/delivery-zones/geocode', { method: 'POST', body: { address: f.business_address || '' } }).then((p) => { setF({ ...f, biz_lat: String(p.lat.toFixed(6)), biz_lng: String(p.lng.toFixed(6)) }); toast('Location found. Save settings to keep it.', 'ok'); }).catch((e) => toast(e.message, 'err'));
  return (
    <section className="panel"><div className="panel-h"><h3>Clocking in, payroll and events</h3></div><div className="panel-b stack">
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.ot_guard === '1'} onChange={flag('ot_guard')} />Overtime guard: when a clock-in would go past {f.ot_weekly_hours || 40} hours this week, a manager has to approve it with their PIN</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.punch_photo === '1'} onChange={flag('punch_photo')} />Take a photo at the time clock with each punch (kept 60 days, managers only)</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.handoff_notes !== '0'} onChange={flag('handoff_notes')} />Shift handoff notes (left at clock-out, shown at the next clock-in)</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.punch_geofence === '1'} onChange={flag('punch_geofence')} />Phone clock-in only works at the business</label>
      {f.punch_geofence === '1' && <div className="row wrap"><label className="field"><span>Within (meters)</span><input className="input" style={{ width: 100 }} type="number" min={30} max={2000} value={f.punch_radius_m} onChange={(e) => setF({ ...f, punch_radius_m: e.target.value })} /></label>
        <span className="muted grow" style={{ fontSize: 13.5 }}>{f.biz_lat ? `Business location: ${f.biz_lat}, ${f.biz_lng}` : 'Business location not set yet.'}</span>
        <button className="btn sm" onClick={here}>Use this device's location</button>{f.business_address && <button className="btn sm ghost" onClick={fromAddress}>Use my address</button>}</div>}
      <label className="field"><span>ADP company code (for the ADP payroll file)</span><input className="input" style={{ width: 140 }} value={f.adp_company_code} onChange={(e) => setF({ ...f, adp_company_code: e.target.value })} maxLength={10} /></label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.rooms_online === '1'} onChange={flag('rooms_online')} />Let customers request private rooms online</label>
      {f.rooms_online === '1' && <label className="field"><span>Book at least this many days ahead</span><input className="input" style={{ width: 90 }} type="number" min={0} max={90} value={f.rooms_lead_days} onChange={(e) => setF({ ...f, rooms_lead_days: e.target.value })} /></label>}
    </div></section>
  );
}
