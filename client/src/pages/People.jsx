import { useEffect, useRef, useState } from 'react';
import { api, money, timeOf } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { MyTimeCard } from './Clock.jsx';

const nice = (sl) => { const [d, t] = sl.split(' '); return `${new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${new Date(`2000-01-01T${t}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; };
const tm = (t) => new Date(`2000-01-01T${t}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* ================= My shifts (every team member, on their phone) ================= */
export function MyShifts() {
  const toast = useToast();
  const [d, reload] = useLive(['shifts'], () => api('/staff/me/schedule'));
  const [offer, setOffer] = useState(null);
  const [off, setOff] = useState(null);
  const [avail, setAvail] = useState(null);
  if (!d) return null;
  const act = async (path, body, msg) => { try { await api(path, { method: 'POST', body }); toast(msg, 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <>
      <PageHead title="My shifts" sub="Your schedule, shifts others want covered, time off and when you can work.">
        <button className="btn" onClick={() => setAvail(d.availability.map((a) => ({ ...a })))}>When I can work</button>
        <button className="btn primary" onClick={() => setOff({ start: '', end: '', reason: '' })}>Ask for time off</button>
      </PageHead>
      <MyTimeCard />
      <div className="grid-2">
        <section className="panel"><div className="panel-h"><h3>Coming up</h3></div>
          {d.shifts.length === 0 ? <div className="panel-b muted">Nothing scheduled yet.</div> : (
            <table className="list"><tbody>{d.shifts.map((s) => (
              <tr key={s.id}><td><b>{nice(s.start_local)}</b> to {tm(s.end_local.slice(11))}{s.role_note && <div className="dim" style={{ fontSize: 12.5 }}>{s.role_note}</div>}</td>
                <td style={{ textAlign: 'right' }}>{s.swap_status ? <span className="chip amber">{s.swap_status === 'claimed' ? 'Covered, waiting for approval' : 'Offered'}</span> : <button className="btn sm" onClick={() => setOffer({ shift: s, toUser: '', note: '' })}>Get it covered</button>}</td></tr>
            ))}</tbody></table>
          )}
        </section>
        <div className="stack">
          <section className="panel"><div className="panel-h"><h3>Shifts you can pick up</h3></div>
            {d.openSwaps.length === 0 ? <div className="panel-b muted">No open shifts right now. You'll get an alert when one comes up.</div> : (
              <table className="list"><tbody>{d.openSwaps.map((w) => (
                <tr key={w.id}><td><b>{nice(w.start_local)}</b> to {tm(w.end_local.slice(11))}<div className="dim" style={{ fontSize: 12.5 }}>From {w.from_name}{w.note ? `: ${w.note}` : ''}</div></td>
                  <td style={{ textAlign: 'right' }}><button className="btn sm primary" onClick={() => act(`/staff/swaps/${w.id}/claim`, {}, 'Sent to your manager to approve')}>I'll take it</button></td></tr>
              ))}</tbody></table>
            )}
          </section>
          <section className="panel"><div className="panel-h"><h3>Time off</h3></div>
            {d.timeOff.length === 0 ? <div className="panel-b muted">No requests.</div> : (
              <table className="list"><tbody>{d.timeOff.map((t) => (
                <tr key={t.id}><td>{t.start_date}{t.end_date !== t.start_date ? ` to ${t.end_date}` : ''}{t.reason && <div className="dim" style={{ fontSize: 12.5 }}>{t.reason}</div>}</td>
                  <td><span className={`chip ${t.status === 'approved' ? 'teal' : t.status === 'denied' ? 'rose' : t.status === 'pending' ? 'amber' : ''}`}>{t.status}</span></td>
                  <td style={{ textAlign: 'right' }}>{['pending', 'approved'].includes(t.status) && <button className="btn sm ghost" onClick={() => act(`/staff/me/time-off/${t.id}/cancel`, {}, 'Request withdrawn')}>Withdraw</button>}</td></tr>
              ))}</tbody></table>
            )}
          </section>
        </div>
      </div>
      {offer && (
        <Modal title={`Get ${nice(offer.shift.start_local)} covered`} onClose={() => setOffer(null)} width={440}>
          <label className="field"><span>Ask</span><select className="input" value={offer.toUser} onChange={(e) => setOffer({ ...offer, toUser: e.target.value })}><option value="">Anyone on the team</option>{d.team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label className="field"><span>Note (optional)</span><input className="input" value={offer.note} onChange={(e) => setOffer({ ...offer, note: e.target.value })} maxLength={120} /></label>
          <button className="btn primary lg block" onClick={() => { act('/staff/me/swaps', { scheduleId: offer.shift.id, toUser: offer.toUser ? Number(offer.toUser) : null, note: offer.note || undefined }, 'Sent. You stay on the shift until someone takes it and a manager approves.'); setOffer(null); }}>Send</button>
        </Modal>
      )}
      {off && (
        <Modal title="Ask for time off" onClose={() => setOff(null)} width={420}>
          <div className="row"><label className="field grow"><span>First day</span><input className="input" type="date" value={off.start} onChange={(e) => setOff({ ...off, start: e.target.value, end: off.end || e.target.value })} /></label><label className="field grow"><span>Last day</span><input className="input" type="date" value={off.end} onChange={(e) => setOff({ ...off, end: e.target.value })} /></label></div>
          <label className="field"><span>Reason (optional)</span><input className="input" value={off.reason} onChange={(e) => setOff({ ...off, reason: e.target.value })} maxLength={120} /></label>
          <button className="btn primary lg block" disabled={!off.start || !off.end} onClick={() => { act('/staff/me/time-off', { start: off.start, end: off.end, reason: off.reason || undefined }, 'Request sent to your manager'); setOff(null); }}>Send request</button>
        </Modal>
      )}
      {avail && (
        <Modal title="When I can work" onClose={() => setAvail(null)} width={520}>
          {avail.map((a, i) => (
            <div key={a.dow} className="row"><label className="row grow" style={{ fontSize: 14 }}><input type="checkbox" checked={a.available} onChange={(e) => setAvail(avail.map((x, j) => (j === i ? { ...x, available: e.target.checked } : x)))} />{a.day}</label>
              {a.available && <><input className="input" type="time" style={{ width: 120 }} value={a.start} onChange={(e) => setAvail(avail.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} aria-label={`${a.day} from`} /><span className="muted">to</span><input className="input" type="time" style={{ width: 120 }} value={a.end} onChange={(e) => setAvail(avail.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} aria-label={`${a.day} until`} /></>}
              {!a.available && <span className="dim">Can't work</span>}</div>
          ))}
          <span className="dim" style={{ fontSize: 12.5 }}>Leave times blank if you can work any time that day.</span>
          <button className="btn primary lg block" onClick={async () => { try { await api('/staff/me/availability', { method: 'PUT', body: { days: avail.map((a) => ({ dow: a.dow, available: a.available, start: a.available ? a.start : '', end: a.available ? a.end : '' })) } }); toast('Saved', 'ok'); setAvail(null); reload(); } catch (e) { toast(e.message, 'err'); } }}>Save</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Team requests (managers, inside Shifts) ================= */
export function TeamRequests() {
  const toast = useToast();
  const [d, reload] = useLive(['shifts'], () => api('/staff/team/requests'));
  if (!d || (!d.timeOff.length && !d.swaps.length && !d.upcomingOff.length)) return null;
  const decide = async (path, approve) => { try { await api(path, { method: 'POST', body: { approve } }); toast(approve ? 'Approved' : 'Declined', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3>Team requests</h3></div>
      <table className="list"><tbody>
        {d.timeOff.map((t) => (
          <tr key={`t${t.id}`}><td><b>{t.name}</b> wants {t.start_date}{t.end_date !== t.start_date ? ` to ${t.end_date}` : ''} off{t.reason ? `: ${t.reason}` : ''}{t.shifts > 0 && <div style={{ color: 'var(--dirty)', fontSize: 13 }}>Scheduled for {t.shifts} shift{t.shifts === 1 ? '' : 's'} then</div>}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn sm primary" onClick={() => decide(`/staff/time-off/${t.id}/decide`, true)}>Approve</button><button className="btn sm ghost" onClick={() => decide(`/staff/time-off/${t.id}/decide`, false)}>Decline</button></td></tr>
        ))}
        {d.swaps.map((w) => (
          <tr key={`w${w.id}`}><td><b>{w.from_name}</b>'s {nice(w.start_local)} shift: {w.claimed_name ? <><b>{w.claimed_name}</b> will take it</> : 'waiting for someone to take it'}{w.issues.length > 0 && <div style={{ color: 'var(--dirty)', fontSize: 13 }}>Note: {w.issues.join(', ')}</div>}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{w.claimed_name && <><button className="btn sm primary" onClick={() => decide(`/staff/swaps/${w.id}/decide`, true)}>Approve swap</button><button className="btn sm ghost" onClick={() => decide(`/staff/swaps/${w.id}/decide`, false)}>Decline</button></>}</td></tr>
        ))}
        {d.upcomingOff.length > 0 && <tr><td colSpan={2} className="muted" style={{ fontSize: 13.5 }}>Approved time off: {d.upcomingOff.map((t) => `${t.name} ${t.start_date}${t.end_date !== t.start_date ? `–${t.end_date.slice(5)}` : ''}`).join(', ')}</td></tr>}
      </tbody></table>
    </section>
  );
}

/* ================= Server performance ================= */
export function Performance() {
  const { settings } = useCC();
  const cur = settings.currency;
  const [range, setRange] = useState({ from: '', to: '' });
  const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v));
  const [d] = useLive(['orders'], () => api(`/staff/performance${q.size ? `?${q}` : ''}`), [range.from, range.to]);
  if (!d) return null;
  const best = (k) => Math.max(0, ...d.people.map((p) => p[k] || 0));
  const top = (p, k) => p[k] && p[k] === best(k) && d.people.length > 1;
  return (
    <>
      <PageHead title="Team performance" sub="Who sells what, by the person who rang up each order. Use it to coach, not to compare unfairly: shifts and sections differ.">
        <input className="input" type="date" style={{ width: 150 }} value={range.from || d.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
        <input className="input" type="date" style={{ width: 150 }} value={range.to || d.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
      </PageHead>
      <section className="panel">
        {d.people.length === 0 ? <div className="panel-b muted">No orders in these days.</div> : (
          <table className="list"><thead><tr><th>Person</th><th>Sales</th><th>Orders</th><th>Average check</th><th>Items per check</th><th>Tips</th><th>Sales per hour</th><th>Time to pay</th><th>Rating</th><th>Voids</th><th>Discounts</th></tr></thead>
            <tbody>{d.people.map((p) => (
              <tr key={p.userId}><td><b>{p.name}</b> <span className="dim" style={{ textTransform: 'capitalize' }}>{p.role}</span><div className="dim" style={{ fontSize: 12 }}>{p.hours} hours</div></td>
                <td className="num">{money(p.salesCents, cur)}{top(p, 'salesCents') && ' ★'}</td><td className="num">{p.orders}</td>
                <td className="num">{money(p.avgCheckCents, cur)}{top(p, 'avgCheckCents') && ' ★'}</td><td className="num">{p.itemsPerCheck}</td>
                <td className="num">{money(p.tipsCents, cur)}<div className="dim" style={{ fontSize: 12 }}>{p.tipPct}%</div></td>
                <td className="num">{p.salesPerHourCents === null ? '' : money(p.salesPerHourCents, cur)}</td>
                <td className="num muted">{p.turnMinutes === null ? '' : `${p.turnMinutes} min`}</td>
                <td className="num">{p.rating ? `${p.rating}★ (${p.ratings})` : ''}</td>
                <td className="num" style={{ color: p.voids > 3 ? 'var(--dirty)' : undefined }}>{p.voids || ''}</td><td className="num muted">{p.discountCents ? money(p.discountCents, cur) : ''}</td></tr>
            ))}</tbody></table>
        )}
      </section>
      <p className="dim" style={{ fontSize: 13, marginTop: 10 }}>Time to pay is from ringing up a table order to payment. Ratings come from guests' feedback on orders that person rang up.</p>
    </>
  );
}

/* ================= Chat ================= */
export function ChatModal({ guestId, onClose }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const log = useRef(null);
  const load = () => api(`/staff/guests/${guestId}/messages`).then(setD).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, [guestId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { log.current?.scrollTo(0, log.current.scrollHeight); }, [d?.messages?.length]);
  const send = async (body) => { if (!body.trim()) return; try { await api(`/staff/guests/${guestId}/messages`, { method: 'POST', body: { body } }); setText(''); load(); } catch (e) { toast(e.message, 'err'); } };
  if (!d) return null;
  return (
    <Modal title={`Messages with ${d.guest.name}`} onClose={onClose} width={480}>
      <div className="chat">
        <div className="chat-log" ref={log}>
          {d.messages.length === 0 && <span className="muted" style={{ fontSize: 14 }}>Send a message to their buzzer. They get a phone alert if alerts are on.</span>}
          {d.messages.map((m) => <div key={m.id} className={`bubble ${m.sender === 'staff' ? 'me' : 'them'}`}>{m.body}<small>{m.sender === 'staff' ? m.staff_name?.split(' ')[0] || 'Team' : d.guest.name} · {timeOf(m.at)}{m.sender === 'staff' && m.read_at ? ' · Seen' : ''}</small></div>)}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          {d.quick.length > 0 && <div className="quick">{d.quick.map((q) => <button key={q} className="btn sm" onClick={() => send(q)}>{q}</button>)}</div>}
          <div className="row"><input className="input grow" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send(text)} maxLength={500} placeholder="Type a message" aria-label="Message" autoFocus /><button className="btn primary" onClick={() => send(text)} disabled={!text.trim()}>Send</button></div>
        </div>
      </div>
    </Modal>
  );
}
export function Chats() {
  const [d] = useLive(['chat'], () => api('/staff/chats'));
  const [open, setOpen] = useState(null);
  if (!d) return null;
  return (
    <>
      <PageHead title="Messages" sub="Conversations with guests from the last day. Message anyone from the waitlist or orders, and they can reply from their buzzer." />
      <section className="panel">
        {d.chats.length === 0 ? <div className="panel-b muted">No messages yet. Use "Message" on the waitlist to start one.</div> : (
          <table className="list"><tbody>{d.chats.map((c) => (
            <tr key={c.guest_id} onClick={() => setOpen(c.guest_id)} style={{ cursor: 'pointer' }}>
              <td><b>{c.name}</b>{c.table_label && <span className="dim"> · table {c.table_label}</span>}<div className="muted" style={{ fontSize: 13.5 }}>{c.last_sender === 'staff' ? 'You: ' : ''}{c.last}</div></td>
              <td className="muted num">{timeOf(c.last_at)}</td><td>{c.unread > 0 && <span className="nav-badge">{c.unread}</span>}</td></tr>
          ))}</tbody></table>
        )}
      </section>
      {open && <ChatModal guestId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
export function useUnreadChats(socket) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const load = () => api('/staff/chats').then((r) => setN(r.unread)).catch(() => {});
    load(); const id = setInterval(load, 30000);
    socket?.on('chat:new', load); socket?.on('sync', (x) => x?.scope === 'chat' && load());
    return () => { clearInterval(id); socket?.off('chat:new', load); };
  }, [socket]);
  return n;
}
export { Icon };
