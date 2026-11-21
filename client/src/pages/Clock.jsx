import { useEffect, useRef, useState } from 'react';
import { api, applyAccent } from '../lib.js';
import { Puck, useToast } from '../ui.jsx';
import { useCC, useLive } from './CommandCenter.jsx';

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
  const hdr = () => ({ 'X-Clock': localStorage.getItem('bh_clock') || '' });
  const load = () => api('/clock', { headers: hdr() }).then((x) => { setD(x); setErr(''); applyAccent(x.business.accent); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const a = setInterval(load, 20000); const b = setInterval(() => setNow(new Date()), 1000); navigator.wakeLock?.request('screen').catch(() => {}); return () => { clearInterval(a); clearInterval(b); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = (ms = 0) => { clearTimeout(resetRef.current); resetRef.current = setTimeout(() => { setPin(''); setWho(null); setDone(null); setErr(''); }, ms); };
  const send = async (action = 'check', p = pin) => {
    if (busy) return; setBusy(true); setErr('');
    try {
      const r = await api('/clock/punch', { method: 'POST', body: { pin: p, action }, headers: hdr() });
      if (action === 'check') { setWho(r); reset(20000); } else { setDone(r); setWho(null); setPin(''); load(); reset(7000); }
    } catch (e) { setErr(e.message); setPin(''); if (e.status === 401 && /signed out/.test(e.message)) setD(null); }
    setBusy(false);
  };
  const key = (k) => { if (who || done) return; if (k === 'del') setPin((x) => x.slice(0, -1)); else if (k === 'ok') { if (pin.length >= 4) send('check'); } else if (pin.length < 8) setPin((x) => x + k); };
  useEffect(() => {
    const onKey = (e) => { if (/^\d$/.test(e.key)) key(e.key); else if (e.key === 'Backspace') key('del'); else if (e.key === 'Enter') key('ok'); else if (e.key === 'Escape') reset(); };
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
              <TimeCardSummary card={card} />
            </div>
          ) : who ? (
            <div className="tclock-card">
              <b>Hi, {who.firstName}</b>
              <span>{who.card.clockedIn ? (who.card.onBreak ? `On break. Clocked in since ${at(who.card.since)}.` : `Clocked in since ${at(who.card.since)}.`) : who.card.scheduledToday.length ? `Your shift today: ${who.card.scheduledToday.map((x) => `${t12(x.start)}–${t12(x.end)}`).join(', ')}` : 'Not on the schedule today.'}</span>
              <div className="tclock-actions">{who.choices.map((c) => <button key={c} className={`btn lg ${c === 'in' || c === 'out' ? 'primary' : ''}`} disabled={busy} onClick={() => send(c, pin)}>{label[c]}</button>)}</div>
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
  const { settings } = useCC(); const toast = useToast();
  const [c, reload] = useLive(['shifts'], () => api('/staff/me/timecard'));
  if (!c) return null;
  const punch = (action) => api('/staff/me/punch', { method: 'POST', body: { action } }).then(() => reload()).catch((e) => toast(e.message, 'err'));
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">My time card</h3>{c.clockedIn ? <span className={`chip ${c.onBreak ? 'amber' : 'teal'}`}>{c.onBreak ? 'On break' : `Clocked in at ${at(c.since)}`}</span> : <span className="chip">Clocked out</span>}</div>
      <div className="panel-b stack">
        <TimeCardSummary card={c} />
        {c.scheduledToday.length > 0 && <span className="muted" style={{ fontSize: 14 }}>Scheduled today: {c.scheduledToday.map((x) => `${t12(x.start)}–${t12(x.end)}${x.position ? ` (${x.position})` : ''}`).join(', ')}</span>}
        {settings.app_punch === '1' && <div className="row">{c.clockedIn ? <>{c.onBreak ? <button className="btn" onClick={() => punch('break_end')}>End break</button> : <button className="btn" onClick={() => punch('break_start')}>Start break</button>}<button className="btn primary" onClick={() => punch('out')}>Clock out</button></> : <button className="btn primary" onClick={() => punch('in')}>Clock in</button>}</div>}
        {c.recent.length > 0 && <table className="list"><tbody>{c.recent.map((r, i) => <tr key={i}><td>{new Date(`${r.in.replace(' ', 'T')}Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</td><td className="muted">{at(r.in)} – {at(r.out)}</td><td className="num">{hhmm(r.hours)}</td></tr>)}</tbody></table>}
      </div>
    </section>
  );
}
