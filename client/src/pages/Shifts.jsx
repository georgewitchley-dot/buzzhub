import { useState } from 'react';
import { api, fmtSlot, minutesSince, money, timeOf, useTick } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { Forecast } from './Team.jsx';
import { TeamRequests } from './People.jsx';
import { AutoSchedule } from './Smart.jsx';
import { WhosOn } from './Clock.jsx';
import { HandoffNotes, PunchPhotos } from './Crew.jsx';
import { BreakPlanner } from './Pace.jsx';
import { PulsePanel } from './Line.jsx';

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const hm = (h) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m`;

function AddSchedule({ people, date, onClose }) {
  const toast = useToast();
  const [f, setF] = useState({ userId: people[0]?.id || '', date, start: '09:00', end: '17:00', note: '' });
  const save = async (e) => { e.preventDefault(); try { const r = await api('/staff/schedule', { method: 'POST', body: { ...f, userId: Number(f.userId), note: f.note || undefined } }); if (r.warnings?.length) toast(`Added, but check: ${r.warnings.join(', ')}`, 'err'); onClose(); } catch (e2) { toast(e2.message, 'err'); } };
  return (
    <Modal title="Add to the schedule" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <label className="field"><span>Who</span><select className="input" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field"><span>Day</span><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <div className="row"><label className="field grow"><span>Start</span><input className="input" type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label><label className="field grow"><span>End</span><input className="input" type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label></div>
        <label className="field"><span>Position (optional)</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={40} placeholder="Host, bar, kitchen…" /></label>
        <button className="btn primary block">Add shift</button>
      </form>
    </Modal>
  );
}

function EditShift({ shift, onClose }) {
  const toast = useToast();
  const toLocal = (ts) => (ts ? new Date(ts.replace(' ', 'T') + 'Z').toLocaleString('sv-SE').slice(0, 16).replace(' ', 'T') : '');
  const toUtc = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 19) : null);
  const [f, setF] = useState({ in: toLocal(shift.clock_in), out: toLocal(shift.clock_out), brk: shift.break_minutes });
  const save = async () => { try { await api(`/staff/shifts/${shift.id}`, { method: 'PUT', body: { clock_in: toUtc(f.in), clock_out: toUtc(f.out), break_minutes: Number(f.brk) || 0 } }); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`Fix ${shift.name}'s shift`} onClose={onClose}>
      <label className="field"><span>Clocked in</span><input className="input" type="datetime-local" value={f.in} onChange={(e) => setF({ ...f, in: e.target.value })} /></label>
      <label className="field"><span>Clocked out (leave empty if still working)</span><input className="input" type="datetime-local" value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} /></label>
      <label className="field"><span>Unpaid break, minutes</span><input className="input" type="number" min={0} max={600} value={f.brk} onChange={(e) => setF({ ...f, brk: e.target.value })} /></label>
      <button className="btn primary block" onClick={save}>Save, it's noted in the security log</button>
    </Modal>
  );
}

export default function Shifts() {
  const { settings, can, user } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [data] = useLive(['shifts'], () => api(`/staff/shifts${from ? `?from=${from}` : ''}`), [from]);
  const [people, reloadPeople] = useLive([], () => (can('manager') ? api('/staff/users') : Promise.resolve([])));
  const [adding, setAdding] = useState(null);
  const [editing, setEditing] = useState(null);
  useTick(30000);
  if (!data) return null;
  const week = Array.from({ length: 7 }, (_, i) => addDays(data.from, i));
  const mgr = can('manager');
  const laborPct = data.salesTodayCents ? Math.round((data.laborTodayCents / data.salesTodayCents) * 1000) / 10 : 0;
  const totalHours = data.shifts.reduce((a, s) => a + s.hours, 0);
  const setWage = async (p, v) => { try { await api(`/staff/users/${p.id}/wage`, { method: 'PUT', body: { hourlyCents: Math.round(Number(v || 0) * 100) } }); toast(`${p.name}'s rate saved`, 'ok'); reloadPeople(); } catch (e) { toast(e.message, 'err'); } };

  return (
    <>
      {mgr && <TeamRequests />}
      <PageHead title="Shifts" sub="Clock in and out from the lock screen with your PIN.">
        <AutoSchedule />
        <div className="row">
          <button className="btn sm" onClick={() => setFrom(addDays(data.from, -7))}>Earlier</button>
          <button className="btn sm" onClick={() => setFrom('')}>This week</button>
          <button className="btn sm" onClick={() => setFrom(addDays(data.from, 7))}>Later</button>
        </div>
      </PageHead>
      <WhosOn />
      <BreakPlanner />
      <PulsePanel />
      <HandoffNotes />
      <PunchPhotos />

      <div className="kpis">
        <div className="kpi"><div className="v">{data.onNow.length}</div><div className="l">On the clock now</div></div>
        <div className="kpi"><div className="v">{hm(totalHours)}</div><div className="l">{mgr ? 'Team hours' : 'Your hours'} from {dayName(data.from)}</div></div>
        {mgr && <div className="kpi"><div className="v">{money(data.laborTodayCents, cur)}</div><div className="l">Labor cost today</div></div>}
        {mgr && <div className="kpi"><div className="v" style={{ color: laborPct > 35 ? 'var(--dirty)' : undefined }}>{laborPct}%</div><div className="l">Labor vs sales today ({money(data.salesTodayCents, cur)})</div></div>}
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <section className="panel"><div className="panel-h"><h3 className="grow">Schedule</h3>{mgr && <button className="btn sm primary" onClick={() => setAdding(data.today >= data.from ? data.today : data.from)}>Add shift</button>}</div>
          <div className="panel-b sched">
            {week.map((d) => {
              const items = data.schedule.filter((s) => s.start_local.startsWith(d));
              return (
                <div key={d} className="sched-day">
                  <b className={d === data.today ? 'today' : ''}>{d === data.today ? 'Today' : dayName(d)}</b>
                  <div className="row wrap" style={{ gap: 6 }}>
                    {items.length === 0 ? <span className="dim" style={{ fontSize: 13 }}>Nobody scheduled</span> : items.map((s) => (
                      <span key={s.id} className={`chip ${s.user_id === user.id ? 'amber' : ''}`}>{s.name} {fmtSlot(s.start_local).time}–{fmtSlot(s.end_local).time}{s.role_note ? `, ${s.role_note}` : ''}
                        {mgr && <button className="btn ghost sm" style={{ height: 20, padding: '0 4px' }} aria-label="Remove" onClick={() => api(`/staff/schedule/${s.id}`, { method: 'DELETE' })}>×</button>}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <div className="stack">
          <section className="panel"><div className="panel-h"><h3>On the clock</h3></div>
            {data.onNow.length ? <table className="list"><tbody>{data.onNow.map((s) => <tr key={s.id}><td>{s.name}</td><td className="muted" style={{ textTransform: 'capitalize' }}>{s.role}</td><td className="muted num">since {timeOf(s.clock_in)}</td><td className="num">{hm(minutesSince(s.clock_in) / 60)}</td></tr>)}</tbody></table> : <div className="panel-b muted">Nobody is clocked in.</div>}
          </section>
          <section className="panel"><div className="panel-h"><h3>Time cards</h3></div>
            {data.shifts.length ? <table className="list"><tbody>{data.shifts.map((s) => (
              <tr key={s.id}><td>{s.name}</td><td className="muted num">{new Date(s.clock_in.replace(' ', 'T') + 'Z').toLocaleDateString([], { month: 'short', day: 'numeric' })} {timeOf(s.clock_in)}–{s.clock_out ? timeOf(s.clock_out) : 'now'}</td>
                <td className="num">{hm(s.hours)}</td>{mgr && <td className="num muted">{money(s.cost_cents, cur)}</td>}
                {mgr && <td style={{ textAlign: 'right' }}><button className="btn ghost sm" onClick={() => setEditing(s)}>Fix</button></td>}</tr>
            ))}</tbody></table> : <div className="panel-b muted">No time cards this week.</div>}
          </section>
          {user.role === 'owner' && people?.length > 0 && (
            <section className="panel"><div className="panel-h"><h3>Hourly pay</h3></div><div className="panel-b stack" style={{ gap: 8 }}>
              {people.filter((p) => p.active).map((p) => (
                <div key={p.id} className="row"><span className="grow">{p.name}</span>
                  <input className="input" style={{ width: 110, height: 36 }} inputMode="decimal" defaultValue={((p.hourly_cents || 0) / 100).toFixed(2)} onBlur={(e) => Number(e.target.value) * 100 !== p.hourly_cents && setWage(p, e.target.value)} aria-label={`${p.name} hourly rate`} />
                  <span className="muted">/ hr</span></div>
              ))}
              <span className="dim" style={{ fontSize: 12.5 }}>Only the owner sees pay. It's used for labor cost.</span>
            </div></section>
          )}
        </div>
      </div>
      {mgr && <Forecast />}
      {adding && <AddSchedule people={(people || []).filter((p) => p.active)} date={adding} onClose={() => setAdding(null)} />}
      {editing && <EditShift shift={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
