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
      <button key={c.course} className="btn primary" onClick={() => fire(c.course)} title={c.items}>
        Fire course {c.course}<span className="dim" style={{ fontSize: 12, marginLeft: 6 }}>{c.n} dish{c.n === 1 ? '' : 'es'}</span>
      </button>
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
