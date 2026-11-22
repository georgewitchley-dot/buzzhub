import { useEffect, useRef, useState } from 'react';
import { api, applyAccent } from '../lib.js';
import { Puck, useToast } from '../ui.jsx';
import { useCC, useLive } from './CommandCenter.jsx';
import { PulseButtons } from './Line.jsx';
import { Checkouts, MyCheckout } from './Station.jsx';

const since = (sql) => Math.max(0, Math.round((Date.now() - Date.parse(`${sql.replace(' ', 'T')}Z`)) / 60000));
const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`);
const hhmm = (h) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m`;
const t12 = (hm) => new Date(`2000-01-01T${hm}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const at = (sql) => new Date(`${sql.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* ================= Time clock wall screen (/timeclock) ================= */
export function TimeClockScreen() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [pin, setPin] = useState('');
  const [who, setWho] = useState(null); // response from /clock/punch (check)
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(new Date());
  const resetRef = useRef(null);
  const [mgr, setMgr] = useState(null); // { message, pin } while a manager approves overtime
  const [note, setNote] = useState(null);
  const [tips, setTips] = useState(null); // cash tips typed before clocking out // text of a handoff note after clocking out
  const lastPin = useRef('');
  const cam = useRef(null); const stream = useRef(null);
  useEffect(() => {
    if (!d?.punchPhoto || stream.current || !navigator.mediaDevices?.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false }).then((st) => { stream.current = st; if (cam.current) { cam.current.srcObject = st; cam.current.play().catch(() => {}); } }).catch(() => {});
  }, [d?.punchPhoto]);
  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);
  const snap = () => {
    const v = cam.current; if (!v || !stream.current || !v.videoWidth) return undefined;
    const c = document.createElement('canvas'); c.width = 240; c.height = Math.round((240 * v.videoHeight) / v.videoWidth);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.6);
  };
  const hdr = () => ({ 'X-Clock': localStorage.getItem('bh_clock') || '' });
  const load = () => api('/clock', { headers: hdr() }).then((x) => { setD(x); setErr(''); applyAccent(x.business.accent); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const a = setInterval(load, 20000); const b = setInterval(() => setNow(new Date()), 1000); navigator.wakeLock?.request('screen').catch(() => {}); return () => { clearInterval(a); clearInterval(b); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = (ms = 0) => { clearTimeout(resetRef.current); resetRef.current = setTimeout(() => { setPin(''); setWho(null); setDone(null); setErr(''); setMgr(null); setNote(null); setTips(null); lastPin.current = ''; }, ms); };
  const send = async (action = 'check', p = pin, extra = {}) => {
    if (busy) return; setBusy(true); setErr('');
    try {
      const photo = action !== 'check' && action !== 'note' && d?.punchPhoto ? snap() : undefined;
      const r = await api('/clock/punch', { method: 'POST', body: { pin: p, action, ...(photo ? { photo } : {}), ...extra }, headers: hdr() });
      if (action === 'check') { lastPin.current = p; setWho(r); reset(20000); }
      else if (action === 'note') { setNote(null); setDone((x) => ({ ...x, noteSaved: true })); reset(4000); }
      else if (action === 'pulse') { setDone((x) => ({ ...x, pulsed: true })); reset(note !== null ? 60000 : 8000); }
      else { setMgr(null); setDone(r); setWho(null); setPin(''); load(); reset(r.notes?.length || (r.result?.action === 'out' && (d?.handoff || d?.pulse || r.tipout)) ? 25000 : 7000); }
    } catch (e) {
      if (e.data?.needsManager && action === 'in') { setMgr({ message: e.message, pin: '' }); setWho(null); reset(30000); }
      else { setErr(e.message); setPin(''); if (e.status === 401 && /signed out/.test(e.message)) setD(null); }
    }
    setBusy(false);
  };
  const key = (k) => {
    if (mgr) { if (k === 'del') setMgr({ ...mgr, pin: mgr.pin.slice(0, -1) }); else if (k === 'ok') { if (mgr.pin.length >= 4) send('in', lastPin.current, { managerPin: mgr.pin }); } else if (mgr.pin.length < 8) setMgr({ ...mgr, pin: mgr.pin + k }); return; }
    if (who || done) return; if (k === 'del') setPin((x) => x.slice(0, -1)); else if (k === 'ok') { if (pin.length >= 4) send('check'); } else if (pin.length < 8) setPin((x) => x + k);
  };
  useEffect(() => {
    const onKey = (e) => { if (note !== null || tips !== null) return; if (/^\d$/.test(e.key)) key(e.key); else if (e.key === 'Backspace') key('del'); else if (e.key === 'Enter') key('ok'); else if (e.key === 'Escape') reset(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  if (err && !d) return <div className="lobby"><div className="lobby-msg"><h1>{err}</h1><a className="btn" href="/">Open the command center</a></div></div>;
  if (!d) return <div className="lobby" />;
  const label = { in: 'Clock in', out: 'Clock out', break_start: 'Start break', break_end: 'End break' };
  const card = (who || done)?.card;
  return (
    <div className="lobby tclock">
      <header className="lobby-top">{d.business.logo ? <img src={d.business.logo} alt="" /> : <Puck state="buzzed" size={40} />}<b>{d.business.name}</b><span className="grow" /><span className="dim" style={{ fontSize: '2.2vh' }}>Time clock</span></header>
      <div className="tclock-grid">
        <section className="tclock-main">
          <div className="tclock-time num">{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</div>
          <div className="tclock-date">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          {done ? (
            <div className="tclock-card ok" role="status">
              <b>{done.result.action === 'in' ? `Welcome, ${done.firstName}!` : done.result.action === 'out' ? `Thanks, ${done.firstName}. See you next time.` : done.result.action === 'break_start' ? `Enjoy your break, ${done.firstName}.` : `Welcome back, ${done.firstName}.`}</b>
              <span>{done.result.action === 'in' ? `Clocked in at ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${done.result.lateMinutes ? `, ${done.result.lateMinutes} minutes after your shift start` : ''}.` : done.result.action === 'out' ? `You worked ${hhmm(done.result.hours)} this shift.` : done.result.action === 'break_end' ? `Break: ${done.result.breakMinutes} minutes.` : 'Your break is being timed.'}</span>
              {done.notes?.length > 0 && <div className="tclock-notes"><b>Notes from the last shift</b>{done.notes.map((n) => <p key={n.id}><span className="dim">{n.name.split(' ')[0]}, {at(n.at)}:</span> {n.body}</p>)}</div>}
              <TimeCardSummary card={card} />
              {done.tipout?.lines?.length > 0 && <div className="tclock-notes"><b>Your tip-out this shift: ${(done.tipout.totalCents / 100).toFixed(2)}</b>{done.tipout.lines.map((l, i) => <p key={i}>${(l.cents / 100).toFixed(2)} to {l.to} ({l.pct}% of {l.base === 'tips' ? `tips, $${(done.tipout.tipsCents / 100).toFixed(2)}` : `sales, $${(done.tipout.salesCents / 100).toFixed(2)}`})</p>)}</div>}
              {done.result.action === 'out' && d.pulse && !done.pulsed && <div className="stack"><span>How was your shift?</span><PulseButtons onPick={(r) => send('pulse', lastPin.current, { rating: r })} /></div>}
              {done.pulsed && <span>Thanks for telling us.</span>}
              {done.result.action === 'out' && d.handoff && !done.noteSaved && (note === null
                ? <button className="btn block" onClick={() => { setNote(''); reset(60000); }}>Leave a note for the next shift</button>
                : <div className="stack"><textarea className="input" rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={600} placeholder="The walk-in door sticks, we're low on lemons…" /><button className="btn primary block" disabled={!note.trim() || busy} onClick={() => send('note', lastPin.current, { note })}>Save note</button></div>)}
              {done.noteSaved && <span>Note saved for the next shift.</span>}
            </div>
          ) : mgr ? (
            <div className="tclock-pad">
              <div className="tclock-card"><b>Overtime check</b><span>{mgr.message}</span></div>
              <div className="tclock-dots">{Array.from({ length: Math.max(4, mgr.pin.length) }, (_, i) => <i key={i} className={i < mgr.pin.length ? 'on' : ''} />)}</div>
              <span className="dim" style={{ fontSize: '2vh' }}>{err || 'Manager: enter your PIN to approve'}</span>
              <div className="keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map((k) => <button key={k} type="button" className={`key ${k.length > 1 ? 'fn' : ''}`} onClick={() => key(k)} disabled={busy} aria-label={k === 'del' ? 'Delete' : k === 'ok' ? 'Approve' : k}>{k === 'del' ? 'Delete' : k === 'ok' ? 'Approve' : k}</button>)}</div>
              <button className="btn ghost" onClick={() => reset()}>Cancel</button>
            </div>
          ) : who ? (
            <div className="tclock-card">
              <b>Hi, {who.firstName}</b>
              <span>{who.card.clockedIn ? (who.card.onBreak ? `On break. Clocked in since ${at(who.card.since)}.` : `Clocked in since ${at(who.card.since)}.`) : who.card.scheduledToday.length ? `Your shift today: ${who.card.scheduledToday.map((x) => `${t12(x.start)}–${t12(x.end)}`).join(', ')}` : 'Not on the schedule today.'}</span>
              {who.otWarn && <span className="warn">{who.otWarn}</span>}
              {tips !== null ? (
                <div className="stack"><span>Cash tips this shift</span><input className="input" style={{ fontSize: '3vh', height: '7vh', textAlign: 'center' }} inputMode="decimal" autoFocus value={tips} onChange={(e) => setTips(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" aria-label="Cash tips" />
                  <button className="btn primary lg block" disabled={busy} onClick={() => { const c = Math.round(Number(tips || 0) * 100); setTips(null); send('out', pin, { tipsCents: c }); }}>Clock out</button></div>
              ) : <div className="tclock-actions">{who.choices.map((c) => <button key={c} className={`btn lg ${c === 'in' || c === 'out' ? 'primary' : ''}`} disabled={busy} onClick={() => (c === 'out' && d.declareTips ? (setTips(''), reset(60000)) : send(c, pin))}>{label[c]}</button>)}</div>}
              <TimeCardSummary card={card} />
              <button className="btn ghost block" onClick={() => reset()}>Cancel</button>
            </div>
          ) : (
            <div className="tclock-pad">
              <div className="tclock-dots" aria-label={`${pin.length} digits entered`}>{Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}</div>
              <span className="dim" style={{ fontSize: '2vh' }}>{err || 'Enter your PIN to clock in or out'}</span>
              <div className="keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map((k) => <button key={k} type="button" className={`key ${k.length > 1 ? 'fn' : ''}`} onClick={() => key(k)} disabled={busy} aria-label={k === 'del' ? 'Delete' : k === 'ok' ? 'Enter' : k}>{k === 'del' ? 'Delete' : k === 'ok' ? 'Enter' : k}</button>)}</div>
            </div>
          )}
        </section>
        <section className="tclock-on">
          <h2>On the clock <span className="dim">{d.on.length}</span></h2>
          {d.on.length === 0 && <span className="dim">Nobody yet.</span>}
          {d.on.map((p, i) => {
            const m = since(p.since); const longNoBreak = !p.onBreak && d.breakReminderHours && m >= d.breakReminderHours * 60;
            return <div key={i} className={`tclock-row ${p.onBreak ? 'brk' : ''}`}><b>{p.name}</b><span className="dim">{p.position}</span><span className="grow" />{p.onBreak ? <span className="chip amber">Break {dur(since(p.breakSince))}</span> : <span className={`num ${longNoBreak ? 'warn' : ''}`}>{dur(m)}</span>}</div>;
          })}
          {d.message && <p className="dim" style={{ marginTop: 'auto' }}>{d.message}</p>}
          {d.punchPhoto && <video ref={cam} className="tclock-cam" muted playsInline aria-label="Camera for clock-in photos" />}
          {d.punchPhoto && <span className="dim" style={{ fontSize: '1.6vh' }}>A photo is taken with each punch.</span>}
        </section>
      </div>
    </div>
  );
}
function TimeCardSummary({ card }) {
  if (!card) return null;
  return (
    <div className="tclock-stats">
      <div><b className="num">{hhmm(card.todayHours)}</b><small>today</small></div>
      <div><b className="num">{hhmm(card.weekHours)}</b><small>this week</small></div>
      <div><b className="num">{card.next ? `${new Date(card.next.start.replace(' ', 'T')).toLocaleDateString([], { weekday: 'short' })} ${t12(card.next.start.slice(11))}` : '—'}</b><small>next shift</small></div>
      {card.overtimeHours > 0 && <div className="warn"><b className="num">{hhmm(card.overtimeHours)}</b><small>overtime</small></div>}
    </div>
  );
}

/* ================= Who's on (Overview, Shifts) ================= */
export function WhosOn({ compact = false }) {
  const { can, settings } = useCC(); const toast = useToast();
  const [d, reload] = useLive(['shifts'], () => api('/staff/whos-on'));
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  if (!d) return null;
  const punch = (p, action) => api(`/staff/users/${p.userId}/punch`, { method: 'POST', body: { action } }).then(() => { toast(`${p.name.split(' ')[0]}: ${action === 'out' ? 'clocked out' : action === 'break_start' ? 'on break' : 'back from break'}`, 'ok'); reload(); }).catch((e) => toast(e.message, 'err'));
  const startScreen = () => api('/staff/timeclock/start', { method: 'POST' }).then((r) => { localStorage.setItem('bh_clock', r.token); location.href = `/timeclock${r.loc && r.loc !== 'main' ? `?l=${r.loc}` : ''}`; }).catch((e) => toast(e.message, 'err'));
  const brk = Number(settings.break_after_hours || 0);
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">On the clock now</h3><span className="chip teal">{d.count} working</span>{d.onBreak > 0 && <span className="chip amber">{d.onBreak} on break</span>}{can('manager') && !compact && <button className="btn sm" onClick={startScreen}>Make this a time clock screen</button>}</div>
      {d.on.length === 0 ? <div className="panel-b muted">Nobody is clocked in. Staff clock in with their PIN on the lock screen or the time clock screen.</div> : (
        <div className="whos-on">{d.on.map((p) => { const m = since(p.since); const late = p.scheduledEnd && !p.onBreak && new Date().toTimeString().slice(0, 5) > p.scheduledEnd; const noBreak = brk && !p.onBreak && m >= brk * 60; return (
          <div key={p.userId || p.name} className={`who ${p.onBreak ? 'brk' : ''}`}>
            <div className="row"><span className={`dot ${p.onBreak ? 'amber' : 'teal'}`} /><b className="grow">{p.name}</b><span className="num">{p.onBreak ? `break ${dur(since(p.breakSince || p.since))}` : dur(m)}</span></div>
            <div className="row dim" style={{ fontSize: 12.5 }}><span className="grow">{p.position || p.role || ''}{p.since ? ` · in at ${at(p.since)}` : ''}</span>{late && <span className="chip rose">past {t12(p.scheduledEnd)}</span>}{noBreak && <span className="chip amber">no break yet</span>}</div>
            {can('manager') && p.userId && <div className="row" style={{ gap: 4 }}>{p.onBreak ? <button className="btn sm" onClick={() => punch(p, 'break_end')}>End break</button> : <button className="btn sm ghost" onClick={() => punch(p, 'break_start')}>Break</button>}<button className="btn sm ghost" onClick={() => confirm(`Clock out ${p.name}?`) && punch(p, 'out')}>Clock out</button></div>}
          </div>); })}</div>
      )}
    </section>
  );
}
export function OnClockChip() {
  const [d] = useLive(['shifts'], () => api('/staff/whos-on').catch(() => null));
  if (!d) return null;
  return <a className="chip teal" href="/shifts" title={d.on.map((p) => p.name).join(', ')} style={{ textDecoration: 'none' }}>{d.count} on the clock{d.onBreak ? `, ${d.onBreak} on break` : ''}</a>;
}

/* ================= My time card (My shifts) ================= */
export function MyTimeCard() {
  const { settings, can } = useCC(); const toast = useToast();
  const [c, reload] = useLive(['shifts'], () => api('/staff/me/timecard'));
  if (!c) return null;
  const where = () => new Promise((ok) => { if (settings.punch_geofence !== '1' || !navigator.geolocation) return ok({}); navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }), () => ok({}), { enableHighAccuracy: true, timeout: 10000 }); });
  const punch = async (action) => { let tipsCents; if (action === 'out' && settings.declare_tips === '1') { const v = prompt('Cash tips this shift (0 if none)', ''); if (v === null) return; tipsCents = Math.round(Number(String(v).replace(/[^\d.]/g, '') || 0) * 100); } try { const r = await api('/staff/me/punch', { method: 'POST', body: { action, ...(tipsCents !== undefined ? { tipsCents } : {}), ...(await where()) } }); if (r.notes?.length) toast(`Note from ${r.notes[0].name.split(' ')[0]}: ${r.notes[0].body}`, 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <><MyCheckout />{can?.('manager') && <Checkouts />}
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">My time card</h3>{c.clockedIn ? <span className={`chip ${c.onBreak ? 'amber' : 'teal'}`}>{c.onBreak ? 'On break' : `Clocked in at ${at(c.since)}`}</span> : <span className="chip">Clocked out</span>}</div>
      <div className="panel-b stack">
        <TimeCardSummary card={c} />
        {c.scheduledToday.length > 0 && <span className="muted" style={{ fontSize: 14 }}>Scheduled today: {c.scheduledToday.map((x) => `${t12(x.start)}–${t12(x.end)}${x.position ? ` (${x.position})` : ''}`).join(', ')}</span>}
        {settings.app_punch === '1' && <div className="row">{c.clockedIn ? <>{c.onBreak ? <button className="btn" onClick={() => punch('break_end')}>End break</button> : <button className="btn" onClick={() => punch('break_start')}>Start break</button>}<button className="btn primary" onClick={() => punch('out')}>Clock out</button></> : <button className="btn primary" onClick={() => punch('in')}>Clock in</button>}</div>}
        {c.recent.length > 0 && <table className="list"><tbody>{c.recent.map((r, i) => <tr key={i}><td>{new Date(`${r.in.replace(' ', 'T')}Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</td><td className="muted">{at(r.in)} – {at(r.out)}</td><td className="num">{hhmm(r.hours)}</td></tr>)}</tbody></table>}
      </div>
    </section></>
  );
}
