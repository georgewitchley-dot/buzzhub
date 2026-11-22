import { useEffect, useRef, useState } from 'react';
import { api, money } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { CustomerPicker } from './Club.jsx';
import { printPage } from '../printing.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);
const t12 = (hm) => new Date(`2000-01-01T${hm}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const today = () => new Date().toLocaleDateString('en-CA');
const pj = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

function Chooser({ menu, itemIds, categories, onChange }) {
  const cats = [...new Set(menu.map((m) => m.category))];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row wrap" style={{ gap: 6 }}>{cats.map((c) => { const on = categories.includes(c); return <button key={c} type="button" className={`chip ${on ? 'teal' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={on} onClick={() => onChange({ itemIds, categories: on ? categories.filter((x) => x !== c) : [...categories, c] })}>All {c}</button>; })}</div>
      <div className="row wrap" style={{ gap: 6 }}>{menu.filter((m) => !categories.includes(m.category)).map((m) => { const on = itemIds.includes(m.id); return <button key={m.id} type="button" className={`chip ${on ? 'amber' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={on} onClick={() => onChange({ categories, itemIds: on ? itemIds.filter((x) => x !== m.id) : [...itemIds, m.id] })}>{m.name}</button>; })}</div>
    </div>
  );
}

/* ================= Kitchen stations ================= */
export function stationOf(settings, item) {
  const list = pj(settings.kitchen_stations, ['Kitchen']); const map = pj(settings.station_map, {});
  const st = map[item.category];
  return st && list.includes(st) ? st : list[0];
}
export function StationPicker({ value, onChange }) {
  const { settings, can, reloadSettings } = useCC(); const toast = useToast();
  const list = pj(settings.kitchen_stations, ['Kitchen']);
  const [setup, setSetup] = useState(null);
  const [menu] = useLive(['menu'], () => (setup ? api('/staff/menu') : Promise.resolve(null)), [Boolean(setup)]);
  const save = () => api('/staff/settings', { method: 'PUT', body: { kitchen_stations: JSON.stringify(setup.list.map((x) => x.trim()).filter(Boolean)), station_map: JSON.stringify(setup.map) } }).then(() => { reloadSettings?.(); setSetup(null); toast('Stations saved', 'ok'); }).catch((e) => toast(e.message, 'err'));
  const cats = [...new Set((menu || []).map((m) => m.category))];
  return (
    <>
      <select className="input" style={{ width: 160 }} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Station">
        <option value="">All stations</option>{list.map((s) => <option key={s} value={s}>{s} only</option>)}
      </select>
      {can('manager') && <button className="btn" onClick={() => setSetup({ list: [...list], map: pj(settings.station_map, {}) })}>Stations</button>}
      {setup && (
        <Modal title="Kitchen stations" onClose={() => setSetup(null)} width={520}>
          <span className="muted" style={{ fontSize: 14 }}>Each screen can show one station, like a bar tablet that only sees drinks. When every station is done, the order is ready and the customer is buzzed.</span>
          <label className="field"><span>Stations, one per line</span><textarea className="input" rows={3} value={setup.list.join('\n')} onChange={(e) => setSetup({ ...setup, list: e.target.value.split('\n') })} /></label>
          <div className="field"><span>Which station makes each category</span>
            {cats.map((c) => <div key={c} className="row"><span className="grow">{c}</span><select className="input" style={{ width: 160 }} value={setup.map[c] || setup.list[0]} onChange={(e) => setSetup({ ...setup, map: { ...setup.map, [c]: e.target.value } })}>{setup.list.filter((x) => x.trim()).map((s) => <option key={s}>{s}</option>)}</select></div>)}
          </div>
          <button className="btn primary lg block" onClick={save}>Save</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Menu schedules (Deals tab) ================= */
export function MenuSchedules() {
  const toast = useToast();
  const [d, reload] = useLive(['menu'], () => api('/staff/menu-schedules'));
  const [menu] = useLive(['menu'], () => api('/staff/menu'));
  const [edit, setEdit] = useState(null);
  if (!d || !menu) return null;
  const save = async () => { try { await api(edit.id ? `/staff/menu-schedules/${edit.id}` : '/staff/menu-schedules', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, days: edit.days, start: edit.start, end: edit.end, itemIds: edit.itemIds, categories: edit.categories, active: edit.active } }); setEdit(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <section className="panel">
      <div className="panel-h"><h3 className="grow">Menu schedules</h3><button className="btn primary sm" onClick={() => setEdit({ name: 'Brunch', days: [0, 6], start: '09:00', end: '14:00', itemIds: [], categories: [] })}>New menu time</button></div>
      <div className="panel-b muted" style={{ fontSize: 14 }}>Items on a schedule are only offered during its hours, everywhere (register, online, kiosk, table menus). Items on no schedule are always offered.</div>
      {d.schedules.length > 0 && <table className="list"><tbody>{d.schedules.map((r) => (
        <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}><td><b>{r.name}</b> {r.live && <span className="chip teal">On now</span>}<div className="dim" style={{ fontSize: 12.5 }}>{r.days.length === 7 ? 'Every day' : r.days.map((x) => DAYS[x]).join(', ')}, {t12(r.start_time)} to {t12(r.end_time)}</div></td>
          <td className="muted" style={{ fontSize: 13 }}>{[...r.categories.map((c) => `all ${c}`), ...r.item_ids.map((id) => menu.find((m) => m.id === id)?.name).filter(Boolean)].join(', ')}</td>
          <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setEdit({ ...r, start: r.start_time, end: r.end_time, itemIds: r.item_ids, active: Boolean(r.active) })}>Edit</button><button className="btn sm ghost" onClick={() => confirm(`Delete ${r.name}?`) && api(`/staff/menu-schedules/${r.id}`, { method: 'DELETE' }).then(reload)}>Delete</button></td></tr>
      ))}</tbody></table>}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New menu time'} onClose={() => setEdit(null)} width={560}>
          <label className="field"><span>Name</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={40} /></label>
          <div className="field"><span>Days</span><div className="row wrap" style={{ gap: 6 }}>{DAYS.map((x, i) => <button key={x} type="button" className={`btn sm ${edit.days.includes(i) ? 'primary' : ''}`} onClick={() => setEdit({ ...edit, days: edit.days.includes(i) ? edit.days.filter((y) => y !== i) : [...edit.days, i].sort() })}>{x}</button>)}</div></div>
          <div className="row"><label className="field grow"><span>From</span><input className="input" type="time" value={edit.start} onChange={(e) => setEdit({ ...edit, start: e.target.value })} /></label><label className="field grow"><span>Until</span><input className="input" type="time" value={edit.end} onChange={(e) => setEdit({ ...edit, end: e.target.value })} /></label></div>
          <div className="field"><span>On this menu</span><Chooser menu={menu} itemIds={edit.itemIds} categories={edit.categories} onChange={(v) => setEdit({ ...edit, ...v })} /></div>
          {edit.id && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />On</label>}
          <button className="btn primary lg block" disabled={!edit.name || !edit.days.length} onClick={save}>Save</button>
        </Modal>
      )}
    </section>
  );
}

/* ================= Gift card bonuses (Deals tab) ================= */
export function GiftBonuses() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [list, reload] = useLive(['cash'], () => api('/staff/gift-promos'));
  const [edit, setEdit] = useState(null);
  if (!list) return null;
  const save = async () => { try { await api(edit.id ? `/staff/gift-promos/${edit.id}` : '/staff/gift-promos', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, minCents: dollars(edit.min), bonusCents: dollars(edit.bonus), starts: edit.starts, ends: edit.ends, bonusFrom: edit.bonusFrom || '', bonusUntil: edit.bonusUntil || '', active: edit.active } }); setEdit(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <section className="panel">
      <div className="panel-h"><h3 className="grow">Gift card bonuses</h3><button className="btn primary sm" onClick={() => setEdit({ name: 'Holiday bonus', min: '50', bonus: '10', starts: today(), ends: today(), bonusFrom: '', bonusUntil: '' })}>New bonus offer</button></div>
      <div className="panel-b muted" style={{ fontSize: 14 }}>Buy a gift card for at least the amount, get a bonus card free, at the register and online. Set when the bonus can be used to bring customers back in a slower month.</div>
      {list.length > 0 && <table className="list"><tbody>{list.map((p) => (
        <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}><td><b>{p.name}</b><div className="dim" style={{ fontSize: 12.5 }}>Buy {money(p.min_cents, cur)}, get {money(p.bonus_cents, cur)}. Sells {p.starts} to {p.ends}{p.bonus_from || p.bonus_until ? `. Bonus good ${p.bonus_from || 'now'} to ${p.bonus_until || 'any time'}` : ''}</div></td>
          <td className="num">{p.issued.n} bonus card{p.issued.n === 1 ? '' : 's'}<div className="dim" style={{ fontSize: 12 }}>{money(p.issued.c, cur)}</div></td>
          <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setEdit({ ...p, min: (p.min_cents / 100).toFixed(0), bonus: (p.bonus_cents / 100).toFixed(0), bonusFrom: p.bonus_from || '', bonusUntil: p.bonus_until || '', active: Boolean(p.active) })}>Edit</button></td></tr>
      ))}</tbody></table>}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New bonus offer'} onClose={() => setEdit(null)} width={500}>
          <label className="field"><span>Name</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={60} /></label>
          <div className="row"><label className="field grow"><span>For every</span><input className="input" inputMode="decimal" value={edit.min} onChange={(e) => setEdit({ ...edit, min: e.target.value })} /></label><label className="field grow"><span>Bonus card</span><input className="input" inputMode="decimal" value={edit.bonus} onChange={(e) => setEdit({ ...edit, bonus: e.target.value })} /></label></div>
          <div className="row"><label className="field grow"><span>Offer starts</span><input className="input" type="date" value={edit.starts} onChange={(e) => setEdit({ ...edit, starts: e.target.value })} /></label><label className="field grow"><span>Offer ends</span><input className="input" type="date" value={edit.ends} onChange={(e) => setEdit({ ...edit, ends: e.target.value })} /></label></div>
          <div className="row"><label className="field grow"><span>Bonus usable from (optional)</span><input className="input" type="date" value={edit.bonusFrom} onChange={(e) => setEdit({ ...edit, bonusFrom: e.target.value })} /></label><label className="field grow"><span>Bonus usable until (optional)</span><input className="input" type="date" value={edit.bonusUntil} onChange={(e) => setEdit({ ...edit, bonusUntil: e.target.value })} /></label></div>
          <span className="dim" style={{ fontSize: 12.5 }}>A $100 card with "for every $50, get $10" earns $20 in bonus. Check your local rules on gift card expiry: in many places bonus cards may expire but paid cards may not.</span>
          {edit.id && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />On</label>}
          <button className="btn primary lg block" disabled={!edit.name || !dollars(edit.min) || !dollars(edit.bonus)} onClick={save}>Save</button>
        </Modal>
      )}
    </section>
  );
}

/* ================= Punch cards ================= */
export function PunchPlans() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [list, reload] = useLive(['punch'], () => api('/staff/punch-plans'));
  const [menu] = useLive(['menu'], () => api('/staff/menu'));
  const [edit, setEdit] = useState(null);
  if (!list || !menu) return null;
  const save = async () => { try { await api(edit.id ? `/staff/punch-plans/${edit.id}` : '/staff/punch-plans', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, uses: Number(edit.uses), priceCents: dollars(edit.price), itemIds: edit.itemIds, categories: edit.categories, validDays: Number(edit.validDays), online: edit.online, active: edit.active } }); setEdit(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <section className="panel">
      <div className="panel-h"><h3 className="grow">Punch cards</h3><button className="btn primary sm" onClick={() => setEdit({ name: 'Coffee card', uses: '10', price: '30', itemIds: [], categories: [], validDays: '365', online: true })}>New punch card</button></div>
      <div className="panel-b muted" style={{ fontSize: 14 }}>Sell a bundle up front, like 10 coffees for the price of 8. Customers use one at a time at the register; it's saved on their account.</div>
      {list.length > 0 && <table className="list"><tbody>{list.map((p) => (
        <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}><td><b>{p.name}</b><div className="dim" style={{ fontSize: 12.5 }}>{p.uses} uses for {money(p.price_cents, cur)} ({money(Math.round(p.price_cents / p.uses), cur)} each), good {p.valid_days} days</div></td>
          <td className="num">{p.sold} sold<div className="dim" style={{ fontSize: 12 }}>{p.outstanding} uses still out</div></td>
          <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setEdit({ ...p, uses: String(p.uses), price: (p.price_cents / 100).toFixed(2), itemIds: p.item_ids, validDays: String(p.valid_days), online: Boolean(p.online), active: Boolean(p.active) })}>Edit</button></td></tr>
      ))}</tbody></table>}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New punch card'} onClose={() => setEdit(null)} width={560}>
          <label className="field"><span>Name</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={40} /></label>
          <div className="row"><label className="field grow"><span>Uses</span><input className="input" type="number" min={2} max={100} value={edit.uses} onChange={(e) => setEdit({ ...edit, uses: e.target.value })} /></label><label className="field grow"><span>Price</span><input className="input" inputMode="decimal" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></label><label className="field grow"><span>Good for (days)</span><input className="input" type="number" min={7} value={edit.validDays} onChange={(e) => setEdit({ ...edit, validDays: e.target.value })} /></label></div>
          <div className="field"><span>Can be used for</span><Chooser menu={menu} itemIds={edit.itemIds} categories={edit.categories} onChange={(v) => setEdit({ ...edit, ...v })} /></div>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.online} onChange={(e) => setEdit({ ...edit, online: e.target.checked })} />Customers can buy it from their account online</label>
          {edit.id && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />On sale</label>}
          <button className="btn primary lg block" disabled={!edit.name || !dollars(edit.price)} onClick={save}>Save</button>
        </Modal>
      )}
    </section>
  );
}
export function SellPunch({ onClose }) {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [plans] = useLive(['punch'], () => api('/staff/punch-plans'));
  const [cust, setCust] = useState(null); const [al, setAl] = useState([]);
  const [planId, setPlanId] = useState(''); const [method, setMethod] = useState('card');
  const live = (plans || []).filter((p) => p.active);
  const sell = () => api('/staff/punch-cards', { method: 'POST', body: { customerId: cust.id, planId: Number(planId || live[0]?.id), method } }).then(() => { toast(`Punch card added to ${cust.name}'s account`, 'ok'); onClose(); }).catch((e) => toast(e.message, 'err'));
  return (
    <Modal title="Sell a punch card" onClose={onClose} width={480}>
      {live.length === 0 ? <span className="muted">No punch cards yet. A manager can add them under Deals.</span> : <>
        <CustomerPicker value={cust} onChange={setCust} allergies={al} setAllergies={setAl} currency={cur} />
        <label className="field"><span>Card</span><select className="input" value={planId || live[0].id} onChange={(e) => setPlanId(e.target.value)}>{live.map((p) => <option key={p.id} value={p.id}>{p.name}: {p.uses} for {money(p.price_cents, cur)}</option>)}</select></label>
        <div className="seg" style={{ width: '100%' }}>{['card', 'cash', 'other'].map((m) => <button key={m} aria-pressed={method === m} onClick={() => setMethod(m)} style={{ flex: 1, textTransform: 'capitalize' }}>{m}</button>)}</div>
        <button className="btn primary lg block" disabled={!cust} onClick={sell}>{cust ? `Charge and add to ${cust.name}` : 'Pick the customer first'}</button>
      </>}
    </Modal>
  );
}
/** On the register ticket: the picked customer's punch cards, each tap uses one on this order. */
export function PunchUse({ customer, picks, setPicks }) {
  const [cards, setCards] = useState([]);
  useEffect(() => { setPicks({}); if (customer?.id) api(`/staff/customers/${customer.id}/punches`).then(setCards).catch(() => setCards([])); else setCards([]); }, [customer?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cards.length) return null;
  return (
    <div className="row wrap" style={{ gap: 6, fontSize: 13.5 }}><span className="muted">Punch cards:</span>
      {cards.map((c) => { const n = picks[c.id] || 0; return <span key={c.id} className="chip teal" style={{ gap: 4 }}>{c.name} ({c.usesLeft - n} left){n > 0 && <b> use {n}</b>}<button className="btn ghost sm" style={{ height: 22, padding: '0 6px' }} disabled={n >= c.usesLeft} onClick={() => setPicks({ ...picks, [c.id]: n + 1 })}>+1</button>{n > 0 && <button className="btn ghost sm" style={{ height: 22, padding: '0 6px' }} onClick={() => setPicks({ ...picks, [c.id]: n - 1 })}>−</button>}</span>; })}
    </div>
  );
}
export async function applyPunches(orderId, picks) {
  let last = null; const used = [];
  for (const [id, n] of Object.entries(picks)) for (let i = 0; i < n; i += 1) { try { last = await api(`/staff/orders/${orderId}/punch`, { method: 'POST', body: { cardId: Number(id) } }); used.push(last.item); } catch (e) { return { last, used, error: e.message }; } }
  return { last, used };
}
export function AccountPunches() {
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { api('/c/punches').then(setD).catch(() => {}); }, []);
  if (!d || (!d.cards.length && (!d.plans.length || !d.canBuy))) return null;
  const buy = (p) => api(`/c/punch-plans/${p.id}/buy`, { method: 'POST' }).then((r) => { location.href = r.url; }).catch((e) => setErr(e.message));
  return (
    <div className="card stack">
      <b>Punch cards</b>
      {d.cards.map((c) => <div key={c.id} className="stack" style={{ gap: 4 }}><div className="row"><span className="grow">{c.name}</span><b>{c.usesLeft} of {c.uses} left</b></div><div className="punches">{Array.from({ length: c.uses }, (_, i) => <i key={i} className={i < c.uses - c.usesLeft ? 'used' : ''} />)}</div><small className="dim">Good until {c.expiresOn}. Tell us at the counter to use one.</small></div>)}
      {d.canBuy && d.plans.map((p) => <button key={p.id} className="btn block" onClick={() => buy(p)}>Buy {p.name}: {p.uses} for {money(p.price_cents)}</button>)}
      {err && <div className="lock-msg">{err}</div>}
    </div>
  );
}

/* ================= Scheduled orders (online checkout) ================= */
export function WhenPicker({ info, value, onChange, t = (x) => x }) {
  if (!info.schedule) return null;
  const days = Array.from({ length: Math.min(14, info.scheduleDays) + 1 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d.toLocaleDateString('en-CA'); });
  const [day, time] = value ? value.split(' ') : [days[0], ''];
  const slots = []; for (let m = 0; m < 24 * 60; m += 15) { const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; const at = new Date(`${day}T${hm}`); if (at.getTime() > Date.now() + (info.prepMinutes + 5) * 60000) slots.push(hm); }
  return (
    <div className="field"><span>{t('When')}</span>
      <div className="seg" style={{ width: '100%' }}><button type="button" aria-pressed={!value} onClick={() => onChange('')} style={{ flex: 1 }}>{t('As soon as possible')}</button><button type="button" aria-pressed={Boolean(value)} onClick={() => onChange(`${days[0]} ${slots[0] || '12:00'}`)} style={{ flex: 1 }}>{t('Later')}</button></div>
      {value && <div className="row"><select className="input grow" value={day} onChange={(e) => onChange(`${e.target.value} ${time}`)} aria-label="Day">{days.map((d) => <option key={d} value={d}>{new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</option>)}</select>
        <select className="input" style={{ width: 120 }} value={time} onChange={(e) => onChange(`${day} ${e.target.value}`)} aria-label="Time">{(slots.includes(time) ? slots : [time, ...slots]).filter(Boolean).map((s) => <option key={s} value={s}>{t12(s)}</option>)}</select></div>}
    </div>
  );
}
export function ScheduledList() {
  const { settings } = useCC();
  const [list] = useLive(['orders'], () => api('/staff/scheduled-orders'));
  if (!list?.length) return null;
  return (
    <section className="panel" style={{ marginBottom: 16 }}><div className="panel-h"><h3>Scheduled for later</h3></div>
      <table className="list"><tbody>{list.map((o) => (
        <tr key={o.id}><td><b>#{o.number}</b> {o.customer_name}</td><td>{new Date(o.scheduled_for.replace(' ', 'T')).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</td><td className="muted" style={{ textTransform: 'capitalize' }}>{o.fulfillment}</td><td className="num">{money(o.total_cents, settings.currency)}</td><td>{o.prepaid ? <span className="chip teal">Paid</span> : o.sched_pay === 'later' ? <span className="chip">Pay at pickup</span> : <span className="chip amber">Paying</span>}</td></tr>
      ))}</tbody></table>
      <div className="panel-b dim" style={{ fontSize: 12.5 }}>Each goes to the kitchen on its own, {settings.online_prep_minutes} minutes before its time.</div>
    </section>
  );
}

/* ================= Live labor ================= */
export function LaborCard() {
  const { settings, can } = useCC(); const cur = settings.currency;
  const [d] = useLive(['orders', 'shifts'], () => (can('manager') ? api('/staff/labor-now').catch(() => null) : Promise.resolve(null)));
  if (!d || (!d.people.length && !d.salesCents)) return null;
  const over = d.pct !== null && d.pct > d.targetPct;
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">Labor today</h3><span className={`chip ${d.pct === null ? '' : over ? 'rose' : 'teal'}`}>{d.pct === null ? 'No sales yet' : `${d.pct}% of sales`}</span><span className="dim" style={{ fontSize: 12.5 }}>target {d.targetPct}%</span></div>
      <div className="panel-b stack" style={{ gap: 8 }}>
        <div className="meter"><i style={{ width: `${Math.min(100, (d.pct || 0) / Math.max(1, d.targetPct * 2) * 100)}%`, background: over ? 'var(--dirty)' : undefined }} /></div>
        <div className="row wrap" style={{ fontSize: 14, gap: 16 }}><span>{money(d.laborCents, cur)} labor</span><span>{money(d.salesCents, cur)} sales</span><span>{d.onNow} on the clock, {money(d.burnPerHourCents, cur)}/hour</span></div>
        {d.suggestHome.length > 0 && <div className="ticket-allergy" style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--text)' }}>Over target. If it's slow, consider sending {d.suggestHome.map((p) => `${p.name.split(' ')[0]} (on ${p.hours}h, saves ${money(p.savesPerHourCents, cur)}/hr)`).join(' or ')} home.</div>}
      </div>
    </section>
  );
}

/* ================= Reservation timeline ================= */
export function Timeline() {
  const { settings } = useCC(); const toast = useToast();
  const [day, setDay] = useState('');
  const [d, reload] = useLive(['bookings'], () => api(`/staff/timeline${day ? `?day=${day}` : ''}`), [day]);
  const [drag, setDrag] = useState(null);
  const gridRef = useRef(null);
  if (!d) return null;
  const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const starts = d.bookings.map((b) => toMin(b.start_local.slice(11)));
  const ends = d.bookings.map((b, i) => starts[i] + b.duration);
  const lo = Math.floor(Math.min(toMin(d.open), ...starts, 17 * 60) / 60) * 60;
  const hi = Math.min(24 * 60, Math.ceil(Math.max(toMin(d.close), ...ends, 22 * 60) / 60) * 60);
  const span = hi - lo; const rows = [{ id: null, label: 'Not seated yet', seats: '' }, ...d.tables];
  const pct = (m) => `${((m - lo) / span) * 100}%`;
  const place = async (b, tableId, minute, force = false) => {
    try { await api(`/staff/bookings/${b.id}/place`, { method: 'PUT', body: { tableId, startLocal: `${d.day} ${fromMin(minute)}`, force } }); reload(); }
    catch (e) { if (e.status === 409 && confirm(`${e.message}. Place it anyway?`)) place(b, tableId, minute, true); else if (e.status !== 409) toast(e.message, 'err'); }
  };
  const onMove = (e) => { if (!drag) return; const r = gridRef.current.getBoundingClientRect(); setDrag({ ...drag, x: e.clientX - r.left, y: e.clientY - r.top, moved: true }); };
  const onUp = () => {
    if (!drag) return; const r = gridRef.current.getBoundingClientRect();
    if (drag.moved) {
      const labelW = 120; const rowH = 44;
      const minute = Math.round((lo + ((drag.x - drag.dx - labelW) / (r.width - labelW)) * span) / d.step) * d.step;
      const row = Math.max(0, Math.min(rows.length - 1, Math.floor((drag.y - 32) / rowH)));
      place(drag.b, rows[row].id, Math.max(lo, Math.min(hi - d.step, minute)));
    }
    setDrag(null);
  };
  const hours = []; for (let m = lo; m < hi; m += 60) hours.push(m);
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}><input className="input" type="date" style={{ width: 160 }} value={day || d.day} onChange={(e) => setDay(e.target.value)} aria-label="Day" /><span className="muted" style={{ fontSize: 13.5 }}>Drag a booking to another {settings.unit_label.toLowerCase()} or time. Each booking holds its table for {settings.booking_duration_minutes || 90} minutes.</span></div>
      <section className="panel timeline" ref={gridRef} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        <div className="tl-head"><span />{hours.map((m) => <span key={m} style={{ left: pct(m) }}>{t12(fromMin(m))}</span>)}</div>
        {rows.map((t) => (
          <div key={t.id ?? 'none'} className="tl-row"><span className="tl-label">{t.id ? `${settings.unit_label} ${t.label}` : t.label}{t.seats ? <small> {t.seats} seats</small> : null}</span>
            <div className="tl-track">{d.bookings.filter((b) => (b.table_id ?? null) === t.id).map((b) => { const s = toMin(b.start_local.slice(11)); const dragging = drag?.b.id === b.id && drag.moved; return (
              <button key={b.id} type="button" className={`tl-b ${b.status}`} style={{ left: pct(s), width: `${(b.duration / span) * 100}%`, opacity: dragging ? 0.35 : 1 }}
                onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); const g = gridRef.current.getBoundingClientRect(); setDrag({ b, dx: e.clientX - r.left, x: e.clientX - g.left, y: e.clientY - g.top, moved: false }); }}
                title={`${b.name}, party of ${b.party_size}${b.notes ? `. ${b.notes}` : ''}`}>
                <b>{b.name.split(' ')[0]}</b> {b.party_size}p <small>{t12(b.start_local.slice(11))}</small>
              </button>); })}</div>
          </div>
        ))}
        {drag?.moved && <div className="tl-ghost" style={{ left: drag.x - drag.dx, top: drag.y - 16 }}>{drag.b.name.split(' ')[0]}</div>}
      </section>
    </>
  );
}

/* ================= Waste tracker ================= */
export function Waste() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [days, setDays] = useState(7);
  const [d, reload] = useLive(['waste'], () => api(`/staff/waste?days=${days}`), [days]);
  const [opts] = useLive(['menu'], () => api('/staff/waste/options'));
  const [f, setF] = useState({ kind: 'item', id: '', qty: '1', reason: 'dropped', note: '' });
  if (!d || !opts) return null;
  const list = f.kind === 'item' ? opts.items : opts.ingredients;
  const log = () => api('/staff/waste', { method: 'POST', body: { [f.kind === 'item' ? 'itemId' : 'ingredientId']: Number(f.id || list[0]?.id), qty: Number(f.qty), reason: f.reason, note: f.note || undefined } }).then((r) => { toast(`Logged. ${money(r.costCents, cur)} lost`, 'ok'); setF({ ...f, qty: '1', note: '' }); reload(); }).catch((e) => toast(e.message, 'err'));
  const max = Math.max(1, ...d.byReason.map((r) => r.cents));
  return (
    <>
      <PageHead title="Waste" sub="Log what gets thrown out and why. Stock comes off automatically, and you can see what it costs you.">
        <div className="seg">{[7, 30, 90].map((n) => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>)}</div>
      </PageHead>
      <div className="grid-2">
        <section className="panel"><div className="panel-h"><h3>Log waste</h3></div><div className="panel-b stack">
          <div className="seg" style={{ width: '100%' }}><button aria-pressed={f.kind === 'item'} onClick={() => setF({ ...f, kind: 'item', id: '' })} style={{ flex: 1 }}>Menu item</button><button aria-pressed={f.kind === 'ing'} onClick={() => setF({ ...f, kind: 'ing', id: '' })} style={{ flex: 1 }} disabled={!opts.ingredients.length}>Ingredient</button></div>
          <div className="row"><select className="input grow" value={f.id || list[0]?.id || ''} onChange={(e) => setF({ ...f, id: e.target.value })} aria-label="What">{list.map((x) => <option key={x.id} value={x.id}>{x.name}{x.unit ? ` (${x.unit})` : ''}</option>)}</select><input className="input" style={{ width: 90 }} inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/[^\d.]/g, '') })} aria-label="How many" /></div>
          <div className="row wrap" style={{ gap: 6 }}>{opts.reasons.map((r) => <button key={r} className={`btn sm ${f.reason === r ? 'primary' : ''}`} onClick={() => setF({ ...f, reason: r })} style={{ textTransform: 'capitalize' }}>{r}</button>)}</div>
          <input className="input" placeholder="Note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={120} />
          <button className="btn primary lg block" disabled={!Number(f.qty) || !list.length} onClick={log}>Log it</button>
        </div></section>
        <section className="panel"><div className="panel-h"><h3 className="grow">Last {days} days</h3><b className="num">{money(d.totalCents, cur)}</b>{d.pctOfSales !== null && <span className="chip">{d.pctOfSales}% of sales</span>}</div><div className="panel-b stack" style={{ gap: 8 }}>
          {d.byReason.length === 0 ? <span className="muted">Nothing logged yet.</span> : d.byReason.map((r) => <div key={r.key}><div className="row" style={{ fontSize: 14 }}><span className="grow" style={{ textTransform: 'capitalize' }}>{r.key}</span><span className="num">{money(r.cents, cur)}</span></div><div className="meter"><i style={{ width: `${(r.cents / max) * 100}%` }} /></div></div>)}
          {d.top.length > 0 && <><b style={{ marginTop: 8 }}>Biggest losses</b>{d.top.slice(0, 5).map((x) => <div key={x.key} className="row" style={{ fontSize: 14 }}><span className="grow">{x.key}</span><span className="muted num">{Math.round(x.qty * 10) / 10}</span><span className="num" style={{ width: 80, textAlign: 'right' }}>{money(x.cents, cur)}</span></div>)}</>}
        </div></section>
      </div>
      {d.rows.length > 0 && <section className="panel" style={{ marginTop: 18 }}><table className="list"><thead><tr><th>When</th><th>What</th><th>Amount</th><th>Why</th><th>Cost</th><th>By</th></tr></thead><tbody>{d.rows.slice(0, 40).map((r) => (
        <tr key={r.id}><td className="muted">{new Date(`${r.at.replace(' ', 'T')}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td>{r.name}{r.note && <div className="dim" style={{ fontSize: 12 }}>{r.note}</div>}</td><td className="num">{r.qty} {r.unit || ''}</td><td style={{ textTransform: 'capitalize' }}>{r.reason}</td><td className="num">{money(r.cost_cents, cur)}</td><td className="muted">{r.by_name}</td></tr>
      ))}</tbody></table></section>}
    </>
  );
}

/* ================= Grab-and-go labels ================= */
export function Labels() {
  const { settings, can } = useCC(); const cur = settings.currency; const toast = useToast();
  const [menu, reload] = useLive(['menu'], () => api('/staff/menu'));
  const [counts, setCounts] = useState({});
  const [made, setMade] = useState(today());
  const [size, setSize] = useState('2x1');
  const [showPrice, setShowPrice] = useState(true);
  if (!menu) return null;
  const def = Number(settings.label_shelf_days || 3);
  const shelf = (m) => (m.shelf_days ?? def);
  const useBy = (m) => { const d = new Date(`${made}T12:00:00`); d.setDate(d.getDate() + shelf(m)); return d; };
  const fmt = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const labels = menu.filter((m) => counts[m.id] > 0).flatMap((m) => Array.from({ length: counts[m.id] }, () => m));
  const setShelf = (m, v) => api(`/staff/menu/${m.id}/shelf`, { method: 'PUT', body: { days: v === '' ? null : Number(v) } }).then(reload).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <PageHead title="Labels" sub="Print labels for grab-and-go items with price, allergens, the day it was made and its use-by date.">
        <input className="input" type="date" style={{ width: 160 }} value={made} onChange={(e) => setMade(e.target.value)} aria-label="Made on" />
        <select className="input" style={{ width: 150 }} value={size} onChange={(e) => setSize(e.target.value)} aria-label="Label size"><option value="2x1">2 × 1 in labels</option><option value="4x2">4 × 2 in labels</option><option value="sheet">Letter sheet (30)</option></select>
        <button className="btn primary" disabled={!labels.length} onClick={() => printPage('Labels')}><Icon name="print" size={16} />Print {labels.length || ''}</button>
      </PageHead>
      <label className="row no-print" style={{ fontSize: 14, marginBottom: 10 }}><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />Show price</label>
      <section className="panel no-print"><table className="list"><thead><tr><th>Item</th><th>Keeps (days)</th><th>Use by</th><th>How many</th></tr></thead><tbody>{menu.filter((m) => m.active).map((m) => (
        <tr key={m.id}><td>{m.name}<div className="dim" style={{ fontSize: 12 }}>{pj(m.allergens, []).join(', ')}</div></td>
          <td>{can('manager') ? <input className="input" style={{ width: 80, height: 32 }} type="number" min={0} max={365} defaultValue={m.shelf_days ?? ''} placeholder={String(def)} onBlur={(e) => e.target.value !== String(m.shelf_days ?? '') && setShelf(m, e.target.value)} aria-label={`${m.name} keeps days`} /> : shelf(m)}</td>
          <td className="muted">{fmt(useBy(m))}</td>
          <td><span className="qty"><button onClick={() => setCounts({ ...counts, [m.id]: Math.max(0, (counts[m.id] || 0) - 1) })} aria-label="One less">−</button><span>{counts[m.id] || 0}</span><button onClick={() => setCounts({ ...counts, [m.id]: (counts[m.id] || 0) + 1 })} aria-label="One more">+</button></span></td></tr>
      ))}</tbody></table></section>
      <div className={`label-sheet size-${size}`}>{labels.map((m, i) => (
        <div key={i} className="glabel"><b className="gl-name">{m.name}</b>{showPrice && <span className="gl-price">{money(m.price_cents, cur)}</span>}
          {pj(m.allergens, []).length > 0 && <span className="gl-al">Contains: {pj(m.allergens, []).join(', ')}</span>}
          <span className="gl-dates">Made {fmt(new Date(`${made}T12:00:00`))} · Use by {fmt(useBy(m))}</span><span className="gl-biz">{settings.business_name}</span></div>
      ))}</div>
    </>
  );
}
