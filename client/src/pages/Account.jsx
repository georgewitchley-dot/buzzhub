import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent, enablePush, fmtSlot, isIOS, isStandalone, money, pushIsOn, registerSW, setManifest, useLenis, withLoc } from '../lib.js';
import { Puck } from '../ui.jsx';
import { AccountClub } from './Club.jsx';
import { ReferralCard } from './House.jsx';
import { AccountPunches } from './More.jsx';

function AuthForm({ onIn }) {
  const [mode, setMode] = useState('register');
  const [f, setF] = useState({ name: '', email: '', phone: '', password: '', marketingOptIn: false });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const ref = new URLSearchParams(location.search).get('ref') || undefined;
      const body = mode === 'register' ? { ...f, ref } : { email: f.email, password: f.password };
      const { customer } = await api(`/c/${mode === 'register' ? 'register' : 'login'}`, { method: 'POST', body });
      onIn(customer);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <div className="seg" role="group" style={{ width: '100%' }}>
        <button type="button" aria-pressed={mode === 'register'} onClick={() => setMode('register')} style={{ flex: 1 }}>Create account</button>
        <button type="button" aria-pressed={mode === 'login'} onClick={() => setMode('login')} style={{ flex: 1 }}>Sign in</button>
      </div>
      {mode === 'register' && <label className="field"><span>Your name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} autoComplete="name" required /></label>}
      <label className="field"><span>Email</span><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={120} autoComplete="email" required /></label>
      {mode === 'register' && <label className="field"><span>Mobile number (optional)</span><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={20} autoComplete="tel" /></label>}
      {mode === 'register' && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.marketingOptIn} onChange={(e) => setF({ ...f, marketingOptIn: e.target.checked })} />Send me offers and news (you can turn this off any time)</label>}
      <label className="field"><span>Password {mode === 'register' && '(at least 8 characters)'}</span><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} minLength={mode === 'register' ? 8 : 1} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required /></label>
      {err && <div className="lock-msg">{err}</div>}
      <button className="btn primary lg block" disabled={busy}>{busy ? 'One moment…' : mode === 'register' ? 'Create account' : 'Sign in'}</button>
    </form>
  );
}

function Booker({ info, onBooked }) {
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(info.days[0] || '');
  const [slots, setSlots] = useState(null);
  const [time, setTime] = useState('');
  const [party, setParty] = useState(info.type === 'service' ? 1 : 2);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSlots = useCallback(() => { if (date) { setSlots(null); setTime(''); api(`/c/slots?date=${date}`).then((r) => setSlots(r.slots)); } }, [date]);
  useEffect(() => { loadSlots(); }, [loadSlots]);

  const book = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/c/bookings', { method: 'POST', body: { date, time, serviceId: serviceId ? Number(serviceId) : undefined, partySize: party, notes: notes || undefined } });
      if (r.depositUrl) { location.href = r.depositUrl; return; }
      setTime(''); setNotes(''); onBooked(); loadSlots();
    } catch (e) { setErr(e.message); loadSlots(); } finally { setBusy(false); }
  };

  if (!info.days.length) return <p className="muted">There are no open days to book right now.</p>;
  const open = (slots || []).filter((s) => s.left > 0);
  return (
    <div className="stack">
      {info.services.length > 0 && (
        <label className="field"><span>What would you like?</span>
          <select className="input" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Choose a service</option>
            {info.services.map((s) => <option key={s.id} value={s.id}>{s.name}, {money(s.price_cents, info.currency)}</option>)}
          </select>
        </label>
      )}
      <div className="field"><span>Day</span>
        <div className="day-strip">
          {info.days.map((d) => { const f = fmtSlot(`${d} 12:00`); const [wd, rest] = [f.day.split(',')[0], f.day.split(', ')[1]]; return (
            <button key={d} type="button" className={`day ${d === date ? 'on' : ''}`} onClick={() => setDate(d)} aria-pressed={d === date}><small>{wd}</small><b>{rest?.split(' ')[1]}</b><small>{rest?.split(' ')[0]}</small></button>
          ); })}
        </div>
      </div>
      <div className="field"><span>Time</span>
        {slots === null ? <span className="muted">Checking openings…</span> : open.length === 0 ? <span className="muted">No openings this day. Try another.</span> : (
          <div className="slot-grid">{open.map((s) => <button key={s.time} type="button" className={`btn sm ${time === s.time ? 'primary' : ''}`} onClick={() => setTime(s.time)}>{fmtSlot(`${date} ${s.time}`).time}</button>)}</div>
        )}
      </div>
      {info.type !== 'service' && (
        <div className="field"><span>Party size</span><div className="row wrap">{[1, 2, 3, 4, 5, 6, 8].map((n) => <button type="button" key={n} className={`btn sm ${party === n ? 'primary' : ''}`} style={{ width: 44 }} onClick={() => setParty(n)}>{n}</button>)}</div></div>
      )}
      <label className="field"><span>Anything we should know? (optional)</span><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} /></label>
      {err && <div className="lock-msg">{err}</div>}
      <button className="btn primary lg block" disabled={!time || busy || (info.services.length > 0 && !serviceId)} onClick={book}>
        {busy ? 'Booking…' : time ? `Book ${fmtSlot(`${date} ${time}`).day} at ${fmtSlot(`${date} ${time}`).time}` : 'Pick a time'}
      </button>
    </div>
  );
}

export default function Account() {
  const nav = useNavigate();
  const [biz, setBiz] = useState(null);
  const [me, setMe] = useState(undefined);
  const [info, setInfo] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [alerts, setAlerts] = useState('off');
  const [msg, setMsg] = useState('');
  const [loyal, setLoyal] = useState(null);
  const [offers, setOffers] = useState(null);
  const [bday, setBday] = useState('');
  useLenis();

  const loadBookings = useCallback(() => api('/c/bookings').then(setBookings).catch(() => {}), []);
  useEffect(() => {
    setManifest('/manifest.webmanifest'); registerSW();
    api('/public/business').then((b) => { setBiz(b); applyAccent(b.accent); document.title = `${b.name}: my account`; });
    api('/c/booking-info').then(setInfo);
    api('/c/me').then(({ customer }) => setMe(customer)).catch(() => setMe(null));
  }, []);
  useEffect(() => { if (me) { api('/c/profile').then((r) => setBday(r.birthday || '')).catch(() => {}); const dep = new URLSearchParams(location.search).get('deposit'); if (dep) api('/c/deposit/confirm', { method: 'POST', body: { sessionId: dep } }).then(() => { setMsg('Deposit paid. Your booking is confirmed.'); loadBookings(); history.replaceState(null, '', location.pathname + location.search.replace(/[?&]deposit=[^&]+/, '').replace(/^&/, '?')); }).catch(() => {}); api('/c/marketing').then((r) => setOffers(r.optIn)).catch(() => {}); api('/c/loyalty').then(setLoyal).catch(() => {}); loadBookings(); pushIsOn('/c/push').then((on) => on && setAlerts('on')); } }, [me, loadBookings]);

  const turnOn = async () => { try { const r = await enablePush('/c/push'); setAlerts(r); } catch { setAlerts('unsupported'); } };
  const checkIn = async (b) => { try { const r = await api(`/c/bookings/${b.id}/checkin`, { method: 'POST' }); nav(r.buzzer); } catch (e) { setMsg(e.message); } };
  const cancel = async (b) => {
    const warn = b.deposit?.status === 'paid' ? (b.minutesUntil >= (info?.refundHours || 0) * 60 ? ' Your deposit will be refunded.' : ` It's less than ${info?.refundHours} hours away, so the deposit is kept.`) : '';
    if (!confirm(`Cancel this booking?${warn}`)) return;
    try { const r = await api(`/c/bookings/${b.id}/cancel`, { method: 'POST' }); if (r.note) setMsg(r.note); loadBookings(); } catch (e) { setMsg(e.message); }
  };
  const payDeposit = async (b) => { try { const r = await api(`/c/bookings/${b.id}/deposit`, { method: 'POST' }); location.href = r.url; } catch (e) { setMsg(e.message); } };
  const saveBirthday = async (v) => { try { await api('/c/profile', { method: 'PUT', body: { birthday: v || null } }); setBday(v); } catch (e) { setMsg(e.message); } };
  const signOut = async () => { await api('/c/logout', { method: 'POST' }); setMe(null); setBookings([]); };

  if (!biz || me === undefined) return <div className="guest" />;
  const upcoming = bookings.filter((b) => ['booked', 'checked_in'].includes(b.status));
  const past = bookings.filter((b) => !['booked', 'checked_in'].includes(b.status));

  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[biz.accent, '#2a1f55', biz.accent]} amplitude={0.6} speed={0.35} mouseInteraction={false} /></div>
      <main className="guest-in" style={{ alignContent: 'start' }}>
        {biz.logo ? <img className="guest-logo" src={biz.logo} alt={biz.name} /> : <Puck state="buzzed" size={48} />}
        {!me ? (
          <>
            <div style={{ display: 'grid', gap: 8 }}><h1>{biz.name}</h1><p>Create a free account to book ahead, get a reminder before your time, and check in from your phone when you arrive.</p></div>
            <AuthForm onIn={setMe} />
            {biz.selfCheckin && <Link className="btn ghost" to={withLoc('/join')}>Just walking in? Join the line without an account</Link>}
          </>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 6 }}><h1>Hi {me.name.split(' ')[0]}</h1><p>{me.email}</p></div>

            <div className="card">
              <b>{alerts === 'on' ? 'Phone alerts are on' : 'Get reminders on this phone'}</b>
              {alerts === 'on' ? <span className="muted" style={{ fontSize: 14 }}>You'll get a reminder before each booking and a buzz when we're ready for you.</span> : (
                <>
                  {isIOS() && !isStandalone() ? (
                    <ol className="steps"><li>Tap <b>Share</b> in Safari.</li><li>Choose <b>Add to Home Screen</b>.</li><li>Open it from your home screen and turn on alerts.</li></ol>
                  ) : <span className="muted" style={{ fontSize: 14 }}>{alerts === 'denied' ? 'Notifications are blocked. Allow them in your browser settings.' : alerts === 'unsupported' ? "This browser can't receive notifications." : 'Allow notifications and we will remind you before your time.'}</span>}
                  {!(isIOS() && !isStandalone()) && alerts !== 'denied' && <button className="btn primary block" onClick={turnOn}>Turn on alerts</button>}
                </>
              )}
            </div>

            <label className="card row" style={{ fontSize: 14.5 }}><span className="grow"><b>Your birthday</b><br /><span className="muted">For a treat on your day. Month and day only.</span></span>
              <select className="input" style={{ width: 90 }} value={bday.slice(0, 2)} onChange={(e) => saveBirthday(e.target.value ? `${e.target.value}-${bday.slice(3) || '01'}` : '')} aria-label="Birth month"><option value="">Month</option>{Array.from({ length: 12 }, (_, i) => <option key={i} value={String(i + 1).padStart(2, '0')}>{new Date(2000, i, 1).toLocaleDateString([], { month: 'short' })}</option>)}</select>
              <select className="input" style={{ width: 70 }} value={bday.slice(3)} disabled={!bday} onChange={(e) => saveBirthday(`${bday.slice(0, 2)}-${e.target.value}`)} aria-label="Birth day">{Array.from({ length: 31 }, (_, i) => <option key={i} value={String(i + 1).padStart(2, '0')}>{i + 1}</option>)}</select></label>

            <ReferralCard />
            <AccountPunches />
            <AccountClub />

            {offers !== null && (
              <label className="card row" style={{ fontSize: 14.5 }}><input type="checkbox" checked={offers} onChange={(e) => api('/c/marketing', { method: 'PUT', body: { optIn: e.target.checked } }).then((r) => setOffers(r.optIn))} /><span className="grow"><b>Offers and news</b><br /><span className="muted">{offers ? "You'll get the occasional deal on this phone and by email." : 'Off. You still get booking reminders and buzzes.'}</span></span></label>
            )}

            {msg && <div className="card banner" role="alert">{msg}</div>}

            {loyal?.enabled && (
              <div className="card">
                <b>{loyal.rewards.length ? 'You have a reward!' : `${loyal.toNext} more visit${loyal.toNext === 1 ? '' : 's'} to ${loyal.reward.toLowerCase()}`}</b>
                {loyal.rewards.map((r) => (
                  <div key={r.id} className="stack" style={{ gap: 6 }}><span>{r.title}. Show this code to the staff:</span><div className="reward-code num">{r.code}</div></div>
                ))}
                <div className="loyal-dots" aria-label={`${loyal.visits % loyal.every} of ${loyal.every} visits`}>
                  {Array.from({ length: loyal.every }, (_, i) => <i key={i} className={i < loyal.visits % loyal.every ? 'on' : ''}>{i + 1}</i>)}
                </div>
                <span className="dim" style={{ fontSize: 13 }}>{loyal.visits} visit{loyal.visits === 1 ? '' : 's'} so far. Visits count when you check in with this account.</span>
              </div>
            )}

            {upcoming.length > 0 && (
              <div className="card">
                <b>Your bookings</b>
                {upcoming.map((b) => { const f = fmtSlot(b.start); return (
                  <div key={b.id} className="booking-row">
                    <div className="grow"><b>{f.day}, {f.time}</b><div className="muted" style={{ fontSize: 14 }}>{b.service || `Party of ${b.partySize}`}{b.deposit && ` · ${b.deposit.status === 'paid' ? `${money(b.deposit.cents, info?.currency)} deposit paid` : b.deposit.status === 'applied' ? `${money(b.deposit.cents, info?.currency)} deposit off your bill, code ${b.deposit.code}` : b.deposit.status === 'pending' ? 'Deposit not paid yet' : `Deposit ${b.deposit.status}`}`}</div></div>
                    {b.deposit?.status === 'pending' ? <button className="btn primary sm" onClick={() => payDeposit(b)}>Pay deposit</button> : b.buzzer ? <button className="btn primary sm" onClick={() => nav(b.buzzer)}>Open my buzzer</button>
                      : b.canCheckIn ? <button className="btn primary sm" onClick={() => checkIn(b)}>I'm here</button>
                      : <button className="btn ghost sm danger" onClick={() => cancel(b)}>Cancel</button>}
                  </div>
                ); })}
                <span className="dim" style={{ fontSize: 13 }}>"I'm here" appears an hour before your time. Tap it when you arrive and we'll buzz you when we're ready.</span>
              </div>
            )}

            {info?.enabled ? (
              <div className="card"><b>Book a time</b><Booker info={info} onBooked={() => { loadBookings(); setMsg('Booked! You can find it under Your bookings.'); }} /></div>
            ) : <div className="card"><b>Online booking is off</b><span className="muted" style={{ fontSize: 14 }}>You can still check in when you arrive.</span>{biz.selfCheckin && <Link className="btn block" to={withLoc('/join')}>Check in now</Link>}</div>}

            {past.length > 0 && (
              <div className="card"><b>Past visits</b>{past.slice(0, 5).map((b) => { const f = fmtSlot(b.start); return <div key={b.id} className="row muted" style={{ fontSize: 14 }}><span className="grow">{f.day}, {f.time}{b.service ? `, ${b.service}` : ''}</span><span>{{ done: 'Done', cancelled: 'Cancelled', noshow: 'Missed' }[b.status]}</span></div>; })}</div>
            )}
            <button className="btn ghost sm" onClick={signOut}>Sign out</button>
          </>
        )}
      </main>
    </div>
  );
}
