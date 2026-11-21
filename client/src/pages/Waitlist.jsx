import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { api, fmtSlot, minutesSince, timeOf, useTick } from '../lib.js';
import { Icon, Modal, Puck, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { useCustomerModal } from './Field.jsx';

const STATE_TEXT = { waiting: 'Waiting', buzzed: 'Buzzed', acknowledged: 'On the way' };
const PRE = { held: 'Pre-order waiting', sent: 'Pre-order making', ready: 'Pre-order ready', open: 'Pre-order making', paid: 'Pre-order paid' };

export function QrModal({ guestId, src, link: givenLink, svg: givenSvg, title, note, onClose }) {
  const [qr, setQr] = useState(givenSvg ? { link: givenLink, svg: givenSvg } : null);
  const toast = useToast();
  useEffect(() => { if (givenSvg) return; const path = src || (guestId && `/staff/guests/${guestId}/qr`); if (path) api(path).then(setQr); }, [guestId, src, givenSvg]);
  return (
    <Modal title={title || 'Scan to get your buzzer'} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>{note || 'Have the guest point their phone camera here. Their phone becomes the buzzer, with no app to download.'}</p>
      {qr ? <div className="qr" dangerouslySetInnerHTML={{ __html: qr.svg }} /> : <div className="qr" style={{ height: 240 }} />}
      {qr && (
        <div className="row">
          <input className="input grow" readOnly value={qr.link} onFocus={(e) => e.target.select()} aria-label="Buzzer link" />
          <button className="btn" onClick={() => navigator.clipboard?.writeText(qr.link).then(() => toast('Link copied', 'ok'))}>Copy</button>
        </div>
      )}
      <button className="btn primary block" onClick={onClose}>Done</button>
    </Modal>
  );
}

function AddGuest({ onClose, onAdded, unit }) {
  const [f, setF] = useState({ name: '', phone: '', email: '', partySize: 2, notes: '' });
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try { const r = await api('/staff/guests', { method: 'POST', body: { ...f, partySize: Number(f.partySize) } }); onAdded(r); } catch (e2) { setErr(e2.message); }
  };
  return (
    <Modal title="Add to waitlist" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Guest name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} required /></label>
        <div className="field"><span>Party size</span>
          <div className="row wrap">{[1, 2, 3, 4, 5, 6, 8].map((n) => (
            <button type="button" key={n} className={`btn sm ${Number(f.partySize) === n ? 'primary' : ''}`} onClick={() => setF({ ...f, partySize: n })} style={{ width: 44 }}>{n}</button>
          ))}<input className="input" type="number" min={1} max={50} value={f.partySize} onChange={(e) => setF({ ...f, partySize: e.target.value })} style={{ width: 80 }} aria-label="Custom party size" /></div>
        </div>
        <div className="row">
          <label className="field grow"><span>Mobile (optional, to call them)</span><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={20} /></label>
          <label className="field grow"><span>Email (optional)</span><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={120} /></label>
        </div>
        <label className="field"><span>Notes</span><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={200} placeholder={`Booth, high chair, outdoor ${unit.toLowerCase()}…`} /></label>
        {err && <div className="lock-msg">{err}</div>}
        <button className="btn primary lg block">Add and show buzzer code</button>
      </form>
    </Modal>
  );
}

function BuzzModal({ guest, onClose, onDone, unit }) {
  const [tables] = useLive(['tables'], () => api('/staff/tables'));
  const [tableId, setTableId] = useState(guest.table_id || '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const fit = (tables || []).filter((t) => t.status === 'open' || t.id === guest.table_id).sort((a, b) => (a.seats >= guest.party_size) === (b.seats >= guest.party_size) ? a.seats - b.seats : a.seats >= guest.party_size ? -1 : 1);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api(`/staff/guests/${guest.id}/buzz`, { method: 'POST', body: { message: message || undefined, tableId: tableId ? Number(tableId) : undefined } });
      toast(`Buzzed ${guest.name}${r.push?.sent ? ' on their phone' : ''}${r.preorderFired ? `. Pre-order #${r.preorderFired} is being made` : ''}`, 'ok'); onDone();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Buzz ${guest.name}`} onClose={onClose}>
      {guest.kind === 'table' && (
        <label className="field"><span>Assign a {unit.toLowerCase()} (optional)</span>
          <select className="input" value={tableId} onChange={(e) => setTableId(e.target.value)}>
            <option value="">No {unit.toLowerCase()} yet</option>
            {fit.map((t) => <option key={t.id} value={t.id}>{unit} {t.label}, seats {t.seats}{t.seats < guest.party_size ? ' (too small)' : ''} — {t.zone}</option>)}
          </select>
        </label>
      )}
      <label className="field"><span>Message (leave blank for the standard one)</span><input className="input" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={160} placeholder={`Your ${unit.toLowerCase()} is ready — please come to the host stand.`} /></label>
      <div className="row wrap">{['Almost ready, 5 more minutes', 'Please come to the bar', 'Please come to the front'].map((m) => <button key={m} className="btn sm" type="button" onClick={() => setMessage(m)}>{m}</button>)}</div>
      <button className="btn primary lg block" onClick={send} disabled={busy}><Icon name="bell" size={18} />{busy ? 'Buzzing…' : 'Buzz now'}</button>
    </Modal>
  );
}

export function RedeemModal({ customerId, name, code: initialCode, onClose }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [code, setCode] = useState(initialCode || '');
  useEffect(() => { if (customerId) api(`/staff/customers/${customerId}/rewards`).then(setList); }, [customerId]);
  const redeem = async (id) => { try { const r = await api(`/staff/rewards/${id}/redeem`, { method: 'POST' }); toast(`Redeemed ${r.title} for ${r.name}`, 'ok'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  const lookup = async () => { try { const r = await api(`/staff/rewards/lookup?code=${code}`); setList([{ ...r, code }]); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={name ? `${name}'s rewards` : 'Redeem a reward'} onClose={onClose}>
      {!customerId && (
        <div className="row"><input className="input grow" inputMode="numeric" placeholder="6-digit code from their phone" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="Reward code" /><button className="btn" disabled={code.length !== 6} onClick={lookup}>Find</button></div>
      )}
      {list && (list.length ? list.map((r) => (
        <div key={r.id} className="row" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}><span className="grow"><b>{r.title}</b>{r.name && <div className="muted" style={{ fontSize: 14 }}>{r.name}</div>}</span><button className="btn primary sm" onClick={() => redeem(r.id)}>Redeem</button></div>
      )) : <p className="muted">No rewards ready.</p>)}
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>Give them the reward, then tap Redeem so it can't be used twice.</p>
    </Modal>
  );
}

export default function Waitlist() {
  const { settings } = useCC();
  const unit = settings.unit_label;
  const toast = useToast();
  const [data] = useLive(['guests'], () => api('/staff/guests'));
  const [adding, setAdding] = useState(false);
  const [qr, setQr] = useState(null);
  const [buzzing, setBuzzing] = useState(null);
  const [redeeming, setRedeeming] = useState(null);
  const [customerModal, openCustomer] = useCustomerModal();
  const [view, setView] = useState('table');
  const listRef = useRef(null);
  const seen = useRef(new Set());
  useTick(20000);

  // animate rows that just arrived (answers a real event, not decoration)
  useEffect(() => {
    if (!data || !listRef.current) return;
    const fresh = [];
    listRef.current.querySelectorAll('[data-id]').forEach((el) => { if (!seen.current.has(el.dataset.id)) { if (seen.current.size) fresh.push(el); seen.current.add(el.dataset.id); } });
    if (fresh.length) gsap.from(fresh, { x: -24, opacity: 0, duration: 0.45, ease: 'power3.out', stagger: 0.05 });
  }, [data]);

  const act = async (path, body, msg) => { try { await api(path, { method: 'POST', body }); if (msg) toast(msg, 'ok'); } catch (e) { toast(e.message, 'err'); } };
  const active = (data?.active || []).filter((g) => g.kind === view);
  const turn = Number(settings.avg_turn_minutes);

  return (
    <>
      <PageHead title="Waitlist" sub={`${active.length} ${view === 'table' ? 'parties waiting' : 'orders waiting for pickup'}`}>
        <div className="seg" role="group" aria-label="Queue type">
          <button aria-pressed={view === 'table'} onClick={() => setView('table')}>{unit}s</button>
          <button aria-pressed={view === 'order'} onClick={() => setView('order')}>Pickup</button>
        </div>
        {settings.self_checkin === '1' && <button className="btn" onClick={() => setQr({ src: '/staff/join-qr', title: 'Self check-in code', note: 'Print this and put it at the door. Guests scan it to join the waitlist themselves.' })}><Icon name="qr" size={17} />Door code</button>}
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={17} />Add guest</button>
      </PageHead>

      <section className="panel" ref={listRef}>
        {active.length === 0 ? (
          <div className="empty"><Puck state="waiting" size={48} /><b>Nobody is waiting</b><span>Add a guest and hand them a buzzer code, or let them scan the door code.</span><button className="btn primary" onClick={() => setAdding(true)}>Add guest</button></div>
        ) : active.map((g, i) => {
          const waited = minutesSince(g.created_at);
          const quoted = g.est_minutes ?? (i + 1) * turn;
          return (
            <div className="wl-row" key={g.id} data-id={g.id} data-state={g.status}>
              <Puck state={g.status} />
              <div style={{ minWidth: 0 }}>
                <div className="wl-name">{g.name} <span className="muted" style={{ fontWeight: 500 }}>{g.kind === 'order' ? `order #${g.order_number}` : `party of ${g.party_size}`}</span></div>
                <div className="wl-meta">
                  <span className={`chip ${g.status === 'buzzed' ? 'amber' : g.status === 'acknowledged' ? 'teal' : ''}`}>{STATE_TEXT[g.status]}{g.buzz_count > 1 ? ` ×${g.buzz_count}` : ''}</span>
                  {g.devices > 0 ? <span className="chip teal" title="Gets phone notifications"><Icon name="phone" size={13} />Alerts on</span> : <span className="chip" title="Has not turned on phone alerts">No alerts</span>}
                  {g.preorder && <span className="chip amber"><Icon name="glass" size={13} />{PRE[g.preorder.split(':')[0]] || 'Pre-order'} ({g.preorder.split(':')[2]})</span>}
                  {g.customer_visits >= 2 && <span className="chip blue" title="Has a customer account">Regular, {g.customer_visits} visits</span>}
                  {(() => { try { return JSON.parse(g.customer_tags || '[]'); } catch { return []; } })().map((t) => <span key={t} className={`chip ${/allerg|free|vegan/i.test(t) ? 'rose' : 'amber'}`}>{t}</span>)}
                  {g.customer_birthday && g.customer_birthday === new Date().toISOString().slice(5, 10) && <span className="chip amber">Birthday today</span>}
                  {g.customer_id && <button className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => openCustomer(g.customer_id)}>Profile{g.customer_notes ? ' and notes' : ''}</button>}
                  {g.rewards > 0 && <button className="chip amber" style={{ border: 0, cursor: 'pointer' }} onClick={() => setRedeeming(g)}><Icon name="gift" size={13} />Reward ready</button>}
                  {g.booking_start && <span className="chip blue">Booked {fmtSlot(g.booking_start).time}{g.booking_service ? `, ${g.booking_service}` : ''}</span>}
                  {g.table_label && <span>{unit} {g.table_label}</span>}
                  <span>Joined {timeOf(g.created_at)}{g.source === 'self' ? ' by self check-in' : g.source === 'booking' ? ' from a booking' : ''}</span>
                  {g.notes && <span>{g.notes}</span>}
                </div>
              </div>
              <div className={`wl-wait ${waited > quoted + 5 && g.kind === 'table' ? 'late' : ''}`}>{waited}m<small>{g.kind === 'table' ? `quoted ${quoted}m` : 'waiting'}</small></div>
              <div className="wl-actions">
                <button className="btn sm" onClick={() => setQr({ guestId: g.id })} aria-label={`Show buzzer code for ${g.name}`}><Icon name="qr" size={16} /></button>
                {g.status === 'waiting' && g.kind === 'table' && !g.heads_up_at && <button className="btn sm" onClick={() => act(`/staff/guests/${g.id}/headsup`, undefined, `Sent ${g.name} an almost-ready alert`)}>Almost ready</button>}
                <button className="btn sm primary" onClick={() => setBuzzing(g)}><Icon name="bell" size={16} />{g.buzz_count ? 'Buzz again' : 'Buzz'}</button>
                <button className="btn sm" onClick={() => act(`/staff/guests/${g.id}/seat`, {}, g.kind === 'order' ? `${g.name} picked up` : `${g.name} seated`)}><Icon name="check" size={16} />{g.kind === 'order' ? 'Picked up' : 'Seat'}</button>
                <button className="btn sm ghost danger" onClick={() => act(`/staff/guests/${g.id}/remove`, { reason: g.status === 'buzzed' ? 'noshow' : 'cancelled' }, `${g.name} removed`)} aria-label={`Remove ${g.name}`}><Icon name="x" size={16} /></button>
              </div>
            </div>
          );
        })}
      </section>

      {data?.recent?.length > 0 && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-h"><h3>Earlier today</h3></div>
          <table className="list"><tbody>
            {data.recent.map((g) => (
              <tr key={g.id}><td>{g.name}</td><td className="muted">{g.kind === 'table' ? `party of ${g.party_size}` : 'pickup'}</td><td><span className={`chip ${['seated', 'done'].includes(g.status) ? 'teal' : 'rose'}`}>{{ seated: 'Seated', done: 'Done', cancelled: 'Cancelled', noshow: 'No-show' }[g.status]}</span></td><td className="muted num">{timeOf(g.created_at)}</td></tr>
            ))}
          </tbody></table>
        </section>
      )}

      {adding && <AddGuest unit={unit} onClose={() => setAdding(false)} onAdded={(r) => { setAdding(false); setQr({ guestId: r.guest.id }); }} />}
      {qr && <QrModal {...qr} onClose={() => setQr(null)} />}
      {redeeming && <RedeemModal customerId={redeeming.customer_id} name={redeeming.name} onClose={() => setRedeeming(null)} />}
      {buzzing && <BuzzModal guest={buzzing} unit={unit} onClose={() => setBuzzing(null)} onDone={() => setBuzzing(null)} />}
      {customerModal}
    </>
  );
}
