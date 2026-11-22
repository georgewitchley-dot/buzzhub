import { useEffect, useRef, useState } from 'react';
import { api, money } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { useCC, useLive } from './CommandCenter.jsx';

/* ================= Server station: fire the next course ================= */
export function StationFire({ tableId }) {
  const toast = useToast();
  const [held, reload] = useLive(['orders'], () => (tableId ? api(`/staff/tables/${tableId}/held`) : Promise.resolve([])), [tableId]);
  if (!held?.length) return null;
  const fire = (course) => api(`/staff/tables/${tableId}/fire-course`, { method: 'POST', body: { course } }).then((r) => { toast(`Course ${r.course} fired`, 'ok'); reload?.(); }).catch((e) => toast(e.message, 'err'));
  return (
    <div className="station-fire">{held.map((c) => (
      <span key={c.course} className="fire-wrap">
        <button className={`btn ${c.pace?.due ? 'primary fire-due' : c.pace?.since === null && c.pace?.hint ? '' : 'primary'}`} onClick={() => fire(c.course)} title={c.items}>
          Fire course {c.course}<span className="dim" style={{ fontSize: 12, marginLeft: 6 }}>{c.n} dish{c.n === 1 ? '' : 'es'}</span>
        </button>
        {c.pace?.hint && <span className={`pace-hint ${c.pace.due ? 'due' : ''}`}>{c.pace.hint}</span>}
      </span>
    ))}</div>
  );
}

/* ================= Server station: host the waitlist ================= */
export function StationHost({ tableId, tableLabel }) {
  const { settings } = useCC(); const toast = useToast();
  const [d, reload] = useLive(['guests'], () => api('/staff/guests'));
  const [f, setF] = useState({ name: '', phone: '', partySize: 2 });
  const list = (d?.active || []).filter((g) => g.kind !== 'order' && ['waiting', 'buzzed', 'notified', 'confirmed'].includes(g.status));
  const add = (e) => { e.preventDefault(); api('/staff/guests', { method: 'POST', body: { name: f.name.trim(), phone: f.phone || undefined, partySize: Number(f.partySize) || 1 } }).then(() => { setF({ name: '', phone: '', partySize: 2 }); toast('Added to the list', 'ok'); reload?.(); }).catch((x) => toast(x.message, 'err')); };
  const buzz = (g) => api(`/staff/guests/${g.id}/buzz`, { method: 'POST', body: tableId ? { tableId: Number(tableId) } : {} }).then(() => { toast(`${g.name} buzzed`, 'ok'); reload?.(); }).catch((x) => toast(x.message, 'err'));
  const seat = (g) => api(`/staff/guests/${g.id}/seat`, { method: 'POST', body: tableId ? { tableId: Number(tableId) } : {} }).then(() => { toast(`${g.name} seated${tableLabel ? ` at ${settings.unit_label} ${tableLabel}` : ''}`, 'ok'); reload?.(); }).catch((x) => toast(x.message, 'err'));
  return (
    <section className="station-box">
      <div className="row"><b className="grow">Waitlist</b><span className="dim" style={{ fontSize: 12 }}>{list.length} waiting</span></div>
      <form className="row" style={{ gap: 6 }} onSubmit={add}>
        <input className="input grow" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} required />
        <input className="input" style={{ width: 54 }} type="number" min={1} max={40} value={f.partySize} onChange={(e) => setF({ ...f, partySize: e.target.value })} aria-label="Party size" />
        <button className="btn" disabled={!f.name.trim()}>Add</button>
      </form>
      <input className="input" placeholder="Phone (optional, for the buzz link)" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      <div className="stack" style={{ gap: 4, maxHeight: 260, overflow: 'auto' }}>
        {list.length === 0 ? <span className="dim" style={{ fontSize: 13 }}>Nobody is waiting.</span> : list.map((g) => (
          <div key={g.id} className="row station-guest">
            <span className="grow"><b>{g.name}</b> <span className="dim">{g.party_size}</span>{g.status === 'buzzed' && <span className="chip amber" style={{ marginLeft: 6, fontSize: 10 }}>Buzzed</span>}</span>
            <button className="btn sm" onClick={() => buzz(g)}>Buzz</button>
            <button className="btn sm primary" onClick={() => seat(g)} title={tableLabel ? `Seat at ${settings.unit_label} ${tableLabel}` : 'Seat'}>Seat{tableLabel ? ` at ${tableLabel}` : ''}</button>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ================= Rush / VIP ================= */
export const PRIORITY_LABEL = { 1: 'RUSH', 2: 'VIP' };
export function PriorityPick({ value, onChange }) {
  return (
    <div className="row" style={{ gap: 4 }} role="group" aria-label="Ticket priority">
      {[[0, 'Normal'], [1, 'Rush'], [2, 'VIP']].map(([v, l]) => <button key={v} type="button" className={`btn sm ${value === v ? (v ? 'primary' : 'on') : ''}`} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}
export function PriorityChip({ p }) { return p ? <span className={`chip ${p === 2 ? 'violet' : 'rose'} prio-chip`}>{PRIORITY_LABEL[p]}</span> : null; }

/* ================= Check extras: gift card and member perk ================= */
export function PayExtras({ bill, onChange }) {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [code, setCode] = useState(''); const [q, setQ] = useState(''); const [found, setFound] = useState([]); const [open, setOpen] = useState(null);
  useEffect(() => { if (q.trim().length < 3) { setFound([]); return undefined; } const t = setTimeout(() => api(`/staff/customer-find?q=${encodeURIComponent(q.trim())}`).then(setFound).catch(() => setFound([])), 250); return () => clearTimeout(t); }, [q]);
  const gift = () => api(`/staff/bills/${bill.id}/gift`, { method: 'POST', body: { code } }).then((r) => { toast(`${money(r.usedCents, cur)} off the gift card. ${money(r.cardBalanceCents, cur)} left on it.`, 'ok'); setCode(''); setOpen(null); onChange(); }).catch((e) => toast(e.message, 'err'));
  const member = (c) => api(`/staff/bills/${bill.id}/member`, { method: 'POST', body: { customerId: c.id } }).then((r) => { toast(r.offCents ? `${r.plan || 'Member'} perk: ${money(r.offCents, cur)} off` : `${r.name} is on the check (no perk to apply)`, r.offCents ? 'ok' : 'info'); setQ(''); setOpen(null); onChange(); }).catch((e) => toast(e.message, 'err'));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <button className={`btn sm grow ${open === 'gift' ? 'on' : ''}`} onClick={() => setOpen(open === 'gift' ? null : 'gift')}>Gift card</button>
        <button className={`btn sm grow ${open === 'member' ? 'on' : ''}`} onClick={() => setOpen(open === 'member' ? null : 'member')}>Member perk</button>
      </div>
      {open === 'gift' && <div className="row" style={{ gap: 6 }}><input className="input grow" placeholder="Gift card code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus /><button className="btn primary" disabled={code.trim().length < 4} onClick={gift}>Take it off</button></div>}
      {open === 'member' && <>
        <input className="input" placeholder="Member name or phone" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {found.map((c) => <button key={c.id} className="btn sm row" style={{ justifyContent: 'space-between' }} onClick={() => member(c)}><span>{c.name}{c.phoneEnd ? <span className="dim"> ···{c.phoneEnd}</span> : null}</span>{c.plan ? <span className="chip teal" style={{ fontSize: 10 }}>{c.plan}</span> : <span className="dim" style={{ fontSize: 11 }}>No plan</span>}</button>)}
      </>}
    </div>
  );
}

/* ================= Server checkout ================= */
export function CheckoutCard({ data: c, cur }) {
  const r = (label, v, strong) => <tr><td>{strong ? <b>{label}</b> : label}</td><td className="num" style={{ textAlign: 'right' }}>{strong ? <b>{money(v, cur)}</b> : money(v, cur)}</td></tr>;
  return (
    <div className="checkout-card">
      <div className="row"><b className="grow" style={{ fontSize: 17 }}>{c.user?.name}</b><span className="dim">{c.date} · {c.hours} h{c.stillOn ? ' (still on)' : ''}</span></div>
      <table className="list"><tbody>
        <tr><td>Checks closed</td><td className="num" style={{ textAlign: 'right' }}>{c.checks}</td></tr>
        {r('Sales (after discounts)', c.salesCents)}
        {r('Cash collected', c.cashCollectedCents)}
        {r('Card tips', c.cardTipsCents)}
        {r('Cash tips', c.cashTipsCents)}
        {c.declaredTipsCents > 0 && r('Tips declared at clock-out', c.declaredTipsCents)}
        {c.tipouts.map((t) => <tr key={t.to}><td className="dim">Tip-out to {t.to}</td><td className="num dim" style={{ textAlign: 'right' }}>−{money(t.cents, cur)}</td></tr>)}
        {r(c.dueToHouseCents >= 0 ? 'Cash to hand in' : 'House owes you', Math.abs(c.dueToHouseCents), true)}
        {r('Your tips tonight', c.takeHomeTipsCents, true)}
      </tbody></table>
      <span className="dim" style={{ fontSize: 12 }}>Cash to hand in is the cash you took, less your cash tips and the card tips the house pays you out of the drawer. Tip-outs come out of your tips.</span>
    </div>
  );
}
export function MyCheckout() {
  const { settings } = useCC(); const [c, setC] = useState(null); const [open, setOpen] = useState(false);
  useEffect(() => { api('/staff/me/checkout').then(setC).catch(() => {}); }, []);
  if (!c || (!c.checks && !c.hours)) return null;
  return (
    <section className="panel" style={{ marginBottom: 12 }}>
      <div className="panel-h"><h3 className="grow">Tonight's checkout</h3><button className="btn sm" onClick={() => setOpen(true)}>Open</button></div>
      <div className="panel-b row wrap" style={{ gap: 18 }}>
        <span><span className="dim">Sales</span> <b className="num">{money(c.salesCents, settings.currency)}</b></span>
        <span><span className="dim">{c.dueToHouseCents >= 0 ? 'Cash to hand in' : 'House owes you'}</span> <b className="num">{money(Math.abs(c.dueToHouseCents), settings.currency)}</b></span>
        <span><span className="dim">Your tips</span> <b className="num">{money(c.takeHomeTipsCents, settings.currency)}</b></span>
      </div>
      {open && <Modal title="Server checkout" onClose={() => setOpen(false)} width={440}><div id="print-checkout"><CheckoutCard data={c} cur={settings.currency} /></div><button className="btn" onClick={() => window.print()}>Print</button></Modal>}
    </section>
  );
}
export function Checkouts() {
  const { settings } = useCC(); const [d] = useLive(['orders'], () => api('/staff/checkouts'));
  if (!d?.people?.length) return null;
  return (
    <section className="panel" style={{ marginBottom: 12 }}>
      <div className="panel-h"><h3 className="grow">Server checkouts</h3><span className="dim" style={{ fontSize: 12 }}>{d.date}</span><button className="btn sm" onClick={() => window.print()}>Print</button></div>
      <div className="panel-b checkout-grid">{d.people.map((c) => <CheckoutCard key={c.user.id} data={c} cur={settings.currency} />)}</div>
    </section>
  );
}

/* ================= Delivery photo at drop-off ================= */
export function shrinkPhoto(file, max = 1024) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.7)); };
    img.onerror = rej; img.src = url;
  });
}
export function DropPhoto({ orderId, onSaved }) {
  const toast = useToast(); const ref = useRef(null); const [shot, setShot] = useState(null);
  const pick = async (e) => { const f = e.target.files?.[0]; if (!f) return; try { const data = await shrinkPhoto(f); await api(`/staff/orders/${orderId}/drop-photo`, { method: 'POST', body: { photo: data } }); setShot(data); toast('Photo saved. The customer can see it.', 'ok'); onSaved?.(); } catch (x) { toast(x.message || 'Could not save the photo', 'err'); } };
  return (
    <div className="row" style={{ gap: 8 }}>
      <input ref={ref} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      <button type="button" className="btn grow" onClick={() => ref.current?.click()}>{shot ? 'Retake drop-off photo' : 'Take drop-off photo'}</button>
      {shot && <img src={shot} alt="Drop-off" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} />}
    </div>
  );
}

/* ================= Same again (table QR and tabs) ================= */
export function SameAgain({ token, tab, member, onAdd, currency }) {
  const [d, setD] = useState(null);
  useEffect(() => { const qs = new URLSearchParams(); if (tab) qs.set('tab', tab); if (member) qs.set('member', member); api(`/t/${token}/last-round?${qs}`).then(setD).catch(() => setD(null)); }, [token, tab, member]);
  if (!d?.items?.length) return null;
  const total = d.items.reduce((a, i) => a + i.cents, 0);
  return (
    <div className="card row">
      <span className="grow"><b>Same again?</b><div className="muted" style={{ fontSize: 13.5 }}>{d.items.map((i) => `${i.qty} ${i.name}`).join(', ')}</div></span>
      <button className="btn primary" onClick={() => d.items.forEach((i) => onAdd({ itemId: i.itemId, qty: i.qty, mods: i.mods, name: i.name, modNames: i.modNames || [], unitCents: i.unitCents }))}>Add {money(total, currency)}</button>
    </div>
  );
}

/* ================= Pre-order with a booking (customer account) ================= */
export function BookingPreorder({ booking, onClose }) {
  const [menu, setMenu] = useState(null); const [lines, setLines] = useState(() => (booking.preorder || []).map((l) => ({ ...l }))); const [msg, setMsg] = useState(''); const [cur, setCur] = useState('USD');
  useEffect(() => { api('/o/menu').then((m) => { setMenu(m.items.filter((i) => !i.groups?.length)); if (m.currency) setCur(m.currency); }).catch(() => setMenu([])); }, []);
  const qty = (id) => lines.find((l) => l.itemId === id)?.qty || 0;
  const set = (id, n) => setLines((c) => { const rest = c.filter((l) => l.itemId !== id); return n > 0 ? [...rest, { itemId: id, qty: n }] : rest; });
  const save = () => api(`/c/bookings/${booking.id}/preorder`, { method: 'PUT', body: { lines } }).then((r) => { setMsg(r.items.length ? `Saved: ${r.items.map((i) => `${i.qty} ${i.name}`).join(', ')}. It goes to the kitchen when you're seated.` : 'Pre-order cleared.'); setTimeout(() => onClose(true), 1400); }).catch((e) => setMsg(e.message));
  const total = (menu || []).reduce((a, i) => a + qty(i.id) * i.price_cents, 0);
  return (
    <Modal title="Order ahead" onClose={() => onClose(false)} width={480}>
      <span className="muted" style={{ fontSize: 14 }}>Pick dishes now and we start them as soon as you're seated. You pay at the table as usual.</span>
      <div className="stack" style={{ gap: 4, maxHeight: 360, overflow: 'auto' }}>{(menu || []).map((i) => (
        <div key={i.id} className="row"><span className="grow">{i.name} <span className="dim">{money(i.price_cents, cur)}</span></span>
          <button className="btn sm" disabled={!qty(i.id)} onClick={() => set(i.id, qty(i.id) - 1)} aria-label={`Fewer ${i.name}`}>−</button><b className="num" style={{ width: 20, textAlign: 'center' }}>{qty(i.id)}</b><button className="btn sm" onClick={() => set(i.id, Math.min(20, qty(i.id) + 1))} aria-label={`More ${i.name}`}>+</button></div>
      ))}</div>
      {msg && <div className="card banner">{msg}</div>}
      <button className="btn primary lg block" onClick={save}>{lines.length ? `Save pre-order, ${money(total, cur)}` : 'Clear pre-order'}</button>
    </Modal>
  );
}

/* ================= Round 20: seat map ================= */
export function SeatMap({ table, seat, onSeat, seats, allergies = {}, onAllergy }) {
  const n = Math.max(1, Math.min(24, seats || table.seats || 4)); const round = table.shape === 'round';
  const W = 220; const H = 128; const cx = W / 2; const cy = H / 2;
  const pos = Array.from({ length: n }, (_, i) => {
    if (round) { const a = (-Math.PI / 2) + (i * 2 * Math.PI) / n; return [cx + Math.cos(a) * 88, cy + Math.sin(a) * 50]; }
    const top = Math.ceil(n / 2); const onTop = i < top; const k = onTop ? i : i - top; const cnt = onTop ? top : n - top;
    return [cx - 70 + ((k + 0.5) * 140) / cnt, onTop ? 14 : H - 14];
  });
  return (
    <div className="seatmap" role="group" aria-label="Seats">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
        {round ? <ellipse cx={cx} cy={cy} rx={64} ry={32} className="seatmap-table" /> : <rect x={cx - 78} y={cy - 30} width={156} height={60} rx={10} className="seatmap-table" />}
        <text x={cx} y={cy + 5} textAnchor="middle" className="seatmap-label">{table.label}</text>
        {pos.map(([x, y], i) => (
          <g key={i} className={`seatmap-seat ${seat === i + 1 ? 'on' : ''} ${allergies[i + 1] ? 'allergy' : ''}`} onClick={() => onSeat(i + 1)} role="button" tabIndex={0} aria-label={`Seat ${i + 1}`} aria-pressed={seat === i + 1} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSeat(i + 1); } }}>
            <circle cx={x} cy={y} r={12} /><text x={x} y={y + 4} textAnchor="middle">{i + 1}</text>{allergies[i + 1] && <title>{`Seat ${i + 1}: ${allergies[i + 1]}`}</title>}
          </g>
        ))}
      </svg>
      <div className="stack" style={{ gap: 4 }}>
        <button type="button" className={`btn sm ${seat === 0 ? 'primary' : ''}`} onClick={() => onSeat(0)}>Share</button>
        {onAllergy && seat > 0 && <button type="button" className={`btn sm ${allergies[seat] ? 'danger' : ''}`} onClick={() => { const v = prompt(`Allergy for seat ${seat} (leave empty to clear)`, allergies[seat] || ''); if (v !== null) onAllergy(seat, v.trim()); }}>{allergies[seat] ? `S${seat}: ${allergies[seat]}` : `Allergy S${seat}`}</button>}
      </div>
    </div>
  );
}

/* ================= Round 20: move a table ================= */
export function MoveTable({ table, onClose }) {
  const { settings } = useCC(); const toast = useToast();
  const [tables, setTables] = useState([]); const [people, setPeople] = useState([]); const [to, setTo] = useState(''); const [who, setWho] = useState('');
  useEffect(() => { api('/staff/tables').then((t) => setTables(t.filter((x) => x.id !== table.id))); api('/staff/servers-on').then(setPeople).catch(() => {}); }, [table.id]);
  const go = () => api(`/staff/tables/${table.id}/transfer`, { method: 'POST', body: { ...(to ? { toTableId: Number(to) } : {}), ...(who ? { toUserId: Number(who) } : {}) } })
    .then((r) => { toast(`${settings.unit_label} ${table.label} ${r.done.join(', ')}`, 'ok'); onClose(to ? Number(to) : null); }).catch((e) => toast(e.message, 'err'));
  return (
    <Modal title={`Move ${settings.unit_label} ${table.label}`} onClose={() => onClose(null)} width={420}>
      <span className="muted" style={{ fontSize: 14 }}>Open checks, the party and the bill move together. Paid checks stay where they were.</span>
      <label className="field"><span>Move to {settings.unit_label.toLowerCase()}</span><select className="input" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Keep this {settings.unit_label.toLowerCase()}</option>{tables.map((t) => <option key={t.id} value={t.id} disabled={t.status === 'seated'}>{settings.unit_label} {t.label}{t.status === 'seated' ? ' (seated)' : ''}</option>)}</select></label>
      <label className="field"><span>Hand to server</span><select className="input" value={who} onChange={(e) => setWho(e.target.value)}><option value="">Keep the same server</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <button className="btn primary lg block" disabled={!to && !who} onClick={go}>Move</button>
    </Modal>
  );
}

/* ================= Round 20: signature pad ================= */
export function SignaturePad({ orderId, onSigned }) {
  const ref = useRef(null); const drawing = useRef(false); const [has, setHas] = useState(false); const [name, setName] = useState(''); const [saved, setSaved] = useState(false); const toast = useToast();
  const pt = (e) => { const r = ref.current.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return [(p.clientX - r.left) * (ref.current.width / r.width), (p.clientY - r.top) * (ref.current.height / r.height)]; };
  const start = (e) => { e.preventDefault(); drawing.current = true; const c = ref.current.getContext('2d'); c.lineWidth = 3; c.lineCap = 'round'; c.strokeStyle = '#111'; const [x, y] = pt(e); c.beginPath(); c.moveTo(x, y); };
  const move = (e) => { if (!drawing.current) return; e.preventDefault(); const c = ref.current.getContext('2d'); const [x, y] = pt(e); c.lineTo(x, y); c.stroke(); setHas(true); };
  const end = () => { drawing.current = false; };
  const clear = () => { ref.current.getContext('2d').clearRect(0, 0, ref.current.width, ref.current.height); setHas(false); setSaved(false); };
  const save = () => api(`/staff/orders/${orderId}/signature`, { method: 'POST', body: { signature: ref.current.toDataURL('image/png'), name: name.trim() || undefined } }).then(() => { setSaved(true); toast('Signature saved', 'ok'); onSigned?.(); }).catch((e) => toast(e.message, 'err'));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <b>Customer signature</b>
      <canvas ref={ref} width={600} height={200} className="sigpad" onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end} onTouchStart={start} onTouchMove={move} onTouchEnd={end} aria-label="Sign here" />
      <div className="row" style={{ gap: 6 }}><input className="input grow" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /><button type="button" className="btn" onClick={clear}>Clear</button><button type="button" className="btn primary" disabled={!has || saved} onClick={save}>{saved ? 'Signed' : 'Save signature'}</button></div>
    </div>
  );
}

/* ================= Round 20: prep pars (settings) ================= */
export function PrepPars() {
  const toast = useToast(); const [items, setItems] = useState(null);
  useEffect(() => { api('/staff/prep-pars').then(setItems).catch(() => setItems([])); }, []);
  if (!items?.length) return null;
  const save = (i, v) => api(`/staff/menu/${i.id}/prep-par`, { method: 'PUT', body: { par: v === '' ? null : Number(v) } }).then(() => toast(`${i.name}: ${v === '' ? 'no par' : `par ${v}`}`, 'ok')).catch((e) => toast(e.message, 'err'));
  return (
    <details className="stack"><summary style={{ cursor: 'pointer', fontSize: 14 }}><b>Prep par levels</b> <span className="dim">How many of each to have ready. The prep list asks for the bigger of the par and the forecast, minus what's on hand.</span></summary>
      <div className="par-grid">{items.map((i) => <label key={i.id} className="row" style={{ fontSize: 14, gap: 6 }}><span className="grow">{i.name}</span><input className="input" style={{ width: 72 }} type="number" min={0} max={999} defaultValue={i.prep_par ?? ''} onBlur={(e) => { if (String(e.target.value) !== String(i.prep_par ?? '')) { save(i, e.target.value); i.prep_par = e.target.value === '' ? null : Number(e.target.value); } }} aria-label={`Par for ${i.name}`} /></label>)}</div>
    </details>
  );
}

/* ================= Round 21: join tables ================= */
export function JoinTable({ table, onClose }) {
  const { settings } = useCC(); const toast = useToast(); const [tables, setTables] = useState([]); const [pick, setPick] = useState('');
  useEffect(() => { api('/staff/tables').then((t) => setTables(t.filter((x) => x.id !== table.id && !x.joined_to))); }, [table.id]);
  const go = () => api(`/staff/tables/${table.id}/join`, { method: 'POST', body: { withTableId: Number(pick) } }).then((r) => { toast(`Joined. ${r.seats} seats on one check.`, 'ok'); onClose(true); }).catch((e) => toast(e.message, 'err'));
  return (
    <Modal title={`Join a ${settings.unit_label.toLowerCase()} to ${table.label}`} onClose={() => onClose(false)} width={400}>
      <span className="muted" style={{ fontSize: 14 }}>The other {settings.unit_label.toLowerCase()}'s open checks move onto {table.label}, and its seats carry on the numbering.</span>
      <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Table to join"><option value="">Pick a {settings.unit_label.toLowerCase()}</option>{tables.map((t) => <option key={t.id} value={t.id}>{settings.unit_label} {t.label} ({t.seats} seats{t.status === 'seated' ? ', seated' : ''})</option>)}</select>
      <button className="btn primary lg block" disabled={!pick} onClick={go}>Join</button>
    </Modal>
  );
}

/* ================= Round 21: seat allergies ================= */
export function useSeatAllergies(tableId) {
  const [list, setList] = useState({});
  const load = () => (tableId ? api(`/staff/tables/${tableId}/seat-allergies`).then((r) => setList(Object.fromEntries(r.map((x) => [x.seat, x.allergy])))).catch(() => setList({})) : setList({}));
  useEffect(() => { load(); }, [tableId]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (seat, allergy) => api(`/staff/tables/${tableId}/seat-allergies`, { method: 'PUT', body: { seat, allergy } }).then(load);
  return [list, set];
}

/* ================= Round 21: split the check by seat ================= */
export function SplitBySeat({ bill, onPaid }) {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast(); const [d, setD] = useState(null);
  const load = () => api(`/staff/bills/${bill.id}/seats`).then(setD).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, [bill.id, bill.remainingCents]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  if (!d.seats.length) return <span className="dim" style={{ fontSize: 13 }}>No dishes have seat numbers, so there's nothing to split by seat.</span>;
  const pay = (s, method) => api(`/staff/bills/${bill.id}/payments`, { method: 'POST', body: { split: 'items', itemIds: s.itemIds, method } }).then(() => { toast(`Seat ${s.seat} paid ${method === 'cash' ? 'cash' : 'card'}`, 'ok'); load(); onPaid(); }).catch((e) => toast(e.message, 'err'));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {d.seats.map((s) => (
        <div key={s.seat} className="row seat-split"><span className="grow"><b>Seat {s.seat}</b> <span className="num">{money(s.cents, cur)}</span><div className="dim" style={{ fontSize: 12 }}>{s.items.join(', ')}</div></span>
          <button className="btn sm" onClick={() => pay(s, 'cash')}>Cash</button><button className="btn sm" onClick={() => pay(s, 'card')}>Card</button></div>
      ))}
      {d.sharedCents > 0 && <span className="dim" style={{ fontSize: 12.5 }}>Shared dishes ({money(d.sharedCents, cur)}: {d.sharedItems.map((i) => i.name).join(', ')}) stay on the check for whoever pays last.</span>}
    </div>
  );
}

/* ================= Round 21: my most-rung dishes ================= */
export function TopDishes({ items, onAdd, currency }) {
  const [top, setTop] = useState([]);
  useEffect(() => { api('/staff/me/top-items').then(setTop).catch(() => {}); }, []);
  const byId = Object.fromEntries((items || []).map((i) => [i.id, i]));
  const list = top.map((t) => byId[t.id]).filter((i) => i && !i.soldOut && !(i.groups || []).some((g) => g.min > 0 || g.required));
  if (!list.length) return null;
  return (
    <div className="top-dishes" aria-label="Your most-rung dishes">
      <span className="dim" style={{ fontSize: 12 }}>Your usual</span>
      {list.map((i) => <button key={i.id} type="button" className="btn sm" onClick={() => onAdd({ itemId: i.id, qty: 1, mods: [], name: i.name, modNames: [], unitCents: i.price_cents })}>{i.name} <span className="dim">{money(i.price_cents, currency)}</span></button>)}
    </div>
  );
}

/* ================= Round 21: ticket recall list ================= */
export function RecallList({ hdr, q, call, flash, onClose }) {
  const [list, setList] = useState(null);
  useEffect(() => { api(`/kds/done-list${q}`, { headers: hdr }).then(setList).catch(() => setList([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const back = (o) => call('/kds/recall', { orderId: o.id }, () => { flash(`#${o.number} is back on the screen`); onClose(); });
  return (
    <Modal title="Finished tickets" onClose={onClose} width={480}>
      {!list ? null : list.length === 0 ? <span className="muted">Nothing finished here in the last 16 hours.</span> : (
        <div className="stack" style={{ gap: 4, maxHeight: 440, overflow: 'auto' }}>{list.map((o) => (
          <div key={o.id} className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
            <span className="grow"><b>#{o.number}</b> {o.table_label ? `Table ${o.table_label}` : o.customer_name || ''}<div className="dim" style={{ fontSize: 12 }}>{o.items ? `${o.items} · ` : ''}{new Date(`${String(o.done_at).replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div></span>
            <button className="btn sm" onClick={() => back(o)}>Bring back</button>
          </div>
        ))}</div>
      )}
    </Modal>
  );
}
