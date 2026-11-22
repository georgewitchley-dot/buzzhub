import { useEffect, useRef, useState } from 'react';
import { api, money } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { CartLines, GuestMenu, useCart } from '../order-ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { PadPay, PadTables } from './Table.jsx';
import { JoinTable, MoveTable, PrepPars, PriorityPick, SeatMap, StationFire, StationHost, TopDishes, useSeatAllergies } from './Station.jsx';

/* ================= Server order pad (/pad) ================= */
export function OrderPad() {
  const { settings } = useCC(); const toast = useToast(); const cur = settings.currency;
  const [menu, setMenu] = useState(null); const [tables] = useLive(['tables'], () => api('/staff/tables'));
  const [tableId, setTableId] = useState(() => localStorage.getItem('bh_pad_table') || '');
  const [seat, setSeat] = useState(1); const [hold, setHold] = useState(false); const [paying, setPaying] = useState(false); const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
  const [priority, setPriority] = useState(0); const [host, setHost] = useState(() => localStorage.getItem('bh_station_host') !== '0'); const [moving, setMoving] = useState(false); const [joining, setJoining] = useState(false);
  const cart = useCart();
  const keys = useRef({});
  useEffect(() => { api('/o/menu').then(setMenu).catch(() => api('/staff/menu').then((m) => setMenu({ items: Array.isArray(m) ? m : m.items }))); }, []);
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target; if (e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable || document.querySelector('.modal')) return;
      const k = keys.current;
      if (/^[0-9]$/.test(e.key) && k.t) { const n = Number(e.key); if (n === 0) k.setSeat(0); else if (n <= (k.seatsAll || 4)) k.setSeat(n); e.preventDefault(); }
      else if (e.key.toLowerCase() === 'f' && k.t) { const b = document.querySelector('.station-fire button'); if (b) { b.click(); e.preventDefault(); } }
      else if (e.key.toLowerCase() === 'h' && k.t) { k.setHold((v) => !v); e.preventDefault(); }
      else if (e.key.toLowerCase() === 'r') { k.setPriority((v) => (v === 1 ? 0 : 1)); e.preventDefault(); }
      else if (e.key.toLowerCase() === 'v') { k.setPriority((v) => (v === 2 ? 0 : 2)); e.preventDefault(); }
      else if (e.key.toLowerCase() === 'c' && k.t) { k.setPaying(true); e.preventDefault(); }
      else if (e.key === 'Enter' && k.count && k.t && !k.busy) { k.send(); e.preventDefault(); }
      else if (e.key === 'Escape' && k.count) { k.clear(); e.preventDefault(); }
      else if (e.key === '?') { k.setHelp((v) => !v); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [help, setHelp] = useState(false);
  const [allergies, setAllergy] = useSeatAllergies(tableId);
  if (!menu || !tables) return null;
  const t = tables.find((x) => String(x.id) === String(tableId));
  const joinedWith = t ? tables.filter((x) => x.joined_to === t.id) : [];
  const seatsAll = t ? (t.seats || 4) + joinedWith.reduce((a, x) => a + (x.seats || 4), 0) : 0;
  const joinedTo = t?.joined_to ? tables.find((x) => x.id === t.joined_to) : null;
  const pick = (id) => { setTableId(String(id)); localStorage.setItem('bh_pad_table', String(id)); setSeat(1); };
  const add = (l) => cart.add({ ...l, seat: seat || undefined, course: hold ? 2 : 1, note: note || l.note });
  const send = async () => {
    setBusy(true);
    try { const r = await api('/staff/orders', { method: 'POST', body: { items: cart.payload, tableId: Number(tableId), ...(priority ? { priority } : {}) } }); toast(`#${r.number} sent to the kitchen${priority ? ` as ${priority === 2 ? 'VIP' : 'a rush'}` : ''}`, 'ok'); cart.clear(); setHold(false); setNote(''); setPriority(0); }
    catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  keys.current = { t, seatsAll, setSeat, setHold, setPriority, setPaying, setHelp, send, count: cart.count, busy, clear: cart.clear };
  const toggleHost = () => { setHost(!host); localStorage.setItem('bh_station_host', host ? '0' : '1'); };
  return (
    <div className={`station ${host ? 'with-host' : ''}`}>
      <PageHead title="Server station" sub="Pick a table, tap a seat, add dishes, send. Fire the next course and run the waitlist from here.">
        <button className="btn ghost" aria-pressed={help} onClick={() => setHelp(!help)} title="Keyboard shortcuts (?)">Keys</button>
        <button className="btn" aria-pressed={host} onClick={toggleHost}>{host ? 'Hide waitlist' : 'Waitlist'}</button>
      </PageHead>
      <div className="station-grid">
        <aside className="station-col station-tables">
          <PadTables tableId={tableId} onPick={(x) => pick(x.id)} />
          {host && <StationHost tableId={tableId} tableLabel={t?.label} />}
        </aside>
        <main className="station-col station-menu">
          {joinedTo ? <div className="panel empty"><b>{settings.unit_label} {t.label} is joined to {joinedTo.label}</b><span>Its orders go on {joinedTo.label}'s check.</span><button className="btn primary" onClick={() => pick(joinedTo.id)}>Open {settings.unit_label} {joinedTo.label}</button></div> : t ? <>
            <div className="station-bar">
              <b className="station-t">{settings.unit_label} {t.label}{joinedWith.length > 0 && <span className="dim" style={{ fontSize: 13, display: 'block' }}>with {joinedWith.map((x) => x.label).join(', ')}</span>}</b>
              <SeatMap table={t} seat={seat} onSeat={setSeat} seats={seatsAll} allergies={allergies} onAllergy={setAllergy} />
              <span className="grow" />
              <div className="row wrap" style={{ gap: 6 }}><StationFire tableId={t.id} /><button className="btn" onClick={() => setMoving(true)}>Move</button>{joinedWith.length ? <button className="btn" onClick={() => api(`/staff/tables/${t.id}/unjoin`, { method: 'POST' }).then(() => toast('Tables split back apart', 'ok')).catch((e) => toast(e.message, 'err'))}>Unjoin</button> : <button className="btn" onClick={() => setJoining(true)}>Join</button>}<button className="btn" onClick={() => setPaying(true)}>Check</button></div>
            </div>
            <div className="row wrap" style={{ gap: 8 }}><label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />Hold as the next course</label><input className="input grow" style={{ minWidth: 160 }} placeholder="Note for the next dish (no onions…)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} /></div>
            <TopDishes items={menu.items} onAdd={add} currency={cur} />
            <div className="card"><GuestMenu items={menu.items} currency={cur} onAdd={add} /></div>
          </> : <div className="panel empty"><b>Pick a {settings.unit_label.toLowerCase()}</b><span>Tap one on the left, then a seat, then add each guest's dishes.</span></div>}
        </main>
        <aside className="station-col station-check">
          <b>New round{t ? ` for ${t.label}` : ''}</b>
          {cart.count === 0 ? <span className="dim" style={{ fontSize: 13.5 }}>Dishes you add show here with their seat.</span> : <>
            <div className="grow" style={{ overflow: 'auto' }}><CartLines cart={cart} currency={cur} /></div>
            <PriorityPick value={priority} onChange={setPriority} />
            <button className="btn primary lg block" disabled={busy || !t} onClick={send}>Send {cart.count} to kitchen · {money(cart.subtotal, cur)}</button>
            <button className="btn ghost sm" onClick={cart.clear}>Clear</button>
          </>}
        </aside>
      </div>
      {paying && t && <PadPay tableId={t.id} label={t.label} onClose={() => setPaying(false)} />}
      {joining && t && <JoinTable table={t} onClose={() => setJoining(false)} />}
      {moving && t && <MoveTable table={t} onClose={(to) => { setMoving(false); if (to) pick(to); }} />}
      {help && <div className="station-keys" role="note"><b>Keyboard</b><span><kbd>1</kbd>–<kbd>9</kbd> seat · <kbd>0</kbd> share · <kbd>H</kbd> hold next course · <kbd>F</kbd> fire course · <kbd>R</kbd> rush · <kbd>V</kbd> VIP · <kbd>Enter</kbd> send · <kbd>Esc</kbd> clear · <kbd>C</kbd> check · <kbd>?</kbd> this help</span></div>}
    </div>
  );
}

/* ================= Area screen extras ================= */
export function KdsIngredients({ hdr, q, flash }) {
  const [list, setList] = useState(null);
  const load = () => api(`/kds/ingredients${q}`, { headers: hdr }).then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (g, out) => api('/kds/ingredient-86', { method: 'POST', body: { ingredientId: g.id, out }, headers: hdr }).then(() => { flash(out ? `Out of ${g.name}: ${g.dishes.length} dish${g.dishes.length === 1 ? '' : 'es'} 86'd` : `${g.name} is back`); load(); }).catch((e) => flash(e.message));
  if (!list?.length) return null;
  return (<><b>Ingredients</b><table className="list"><tbody>{list.map((g) => <tr key={g.id}><td><b>{g.name}</b><div className="dim" style={{ fontSize: 12 }}>Used in {g.dishes.join(', ')}</div></td><td style={{ textAlign: 'right' }}>{g.out ? <button className="btn sm primary" onClick={() => set(g, false)}>Back in</button> : <button className="btn sm" onClick={() => set(g, true)}>Out of it</button>}</td></tr>)}</tbody></table></>);
}
export function KdsPrep({ hdr, q, onClose }) {
  const [d, setD] = useState(null); const [done, setDone] = useState({}); const [note, setNote] = useState('');
  const loadLog = () => api(`/kds/prep-log${q}`, { headers: hdr }).then((rows) => setDone(Object.fromEntries(rows.map((r) => [`${r.kind === 'item' ? 'i' : 'g'}${r.ref_id}`, r]))));
  useEffect(() => { api(`/kds/prep${q}`, { headers: hdr }).then(setD); loadLog(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [left, setLeft] = useState(null);
  const logLeft = () => api(`/kds/leftovers${q}`, { method: 'POST', headers: hdr, body: { lines: Object.entries(left).filter(([, v]) => Number(v) > 0).map(([k, v]) => ({ itemId: Number(k), qty: Math.round(Number(v)) })), by: localStorage.getItem('bh_kds_name') || undefined } }).then((r) => { setNote(r.logged ? `${r.logged} logged as waste` : 'Nothing new to log'); setLeft(null); reloadPrep(); }).catch((e) => setNote(e.message));
  const reloadPrep = () => api(`/kds/prep${q}`, { headers: hdr }).then(setD);
  const count = (i, v) => { const qty = v === '' ? null : Math.max(0, Math.round(Number(v))); if (qty !== null && Number.isNaN(qty)) return; api(`/kds/prep-count${q}`, { method: 'POST', headers: hdr, body: { itemId: i.id, qty, by: localStorage.getItem('bh_kds_name') || undefined } }).then(reloadPrep).catch((e) => setNote(e.message)); };
  const tick = (k) => { const kind = k[0] === 'i' ? 'item' : 'ingredient'; const id = Number(k.slice(1)); const row = kind === 'item' ? d.items.find((x) => x.id === id) : d.ingredients.find((x) => x.id === id);
    api(`/kds/prep-log${q}`, { method: 'POST', headers: hdr, body: { kind, refId: id, qty: kind === 'item' ? row.prep : row.need, done: !done[k], by: localStorage.getItem('bh_kds_name') || undefined } }).then((r) => { if (r.lot) setNote(`${row.name} added to Use first`); loadLog(); }); };
  return (
    <Modal title={d ? `Prep for ${d.weekday}` : 'Prep'} onClose={onClose} width={520}>
      {d && <>
        <span className="muted" style={{ fontSize: 13.5 }}>From the last {d.weeksOfData} {d.weekday}s plus {d.bufferPct}% extra. Ticks show on every screen; prepped ingredients with a shelf life go into Use first.</span>
        {note && <span className="chip teal">{note}</span>}
        {d.items.length === 0 ? <span className="muted">Not enough history yet.</span> : d.items.map((i) => <label key={i.id} className="row" style={{ fontSize: 16 }}><input type="checkbox" checked={Boolean(done[`i${i.id}`])} onChange={() => tick(`i${i.id}`)} /><span className="grow" style={{ textDecoration: done[`i${i.id}`] ? 'line-through' : 'none' }}>{i.name}{done[`i${i.id}`]?.by_label && <span className="dim" style={{ fontSize: 12 }}> · {done[`i${i.id}`].by_label}</span>}{(i.par || i.onHand !== null) && <span className="prep-recipe">{i.par ? `Par ${i.par} · forecast ${i.forecast} · ` : ''}On hand <input className="input prep-onhand" type="number" min={0} defaultValue={i.onHand ?? ''} onClick={(e) => e.preventDefault()} onBlur={(e) => count(i, e.target.value)} aria-label={`On hand ${i.name}`} /></span>}{!(i.par || i.onHand !== null) && <button type="button" className="linkish prep-recipe" onClick={(e) => { e.preventDefault(); const v = prompt(`How many ${i.name} are already made?`, ''); if (v !== null) count(i, v); }}>Count what's on hand</button>}{i.recipe?.length > 0 && <span className="prep-recipe">{i.recipe.map((r) => `${r.total} ${r.unit === 'each' ? '' : `${r.unit} `}${r.name}`).join(' · ')}</span>}</span><b className="num">{i.prep}</b></label>)}
        {d.items.length > 0 && (left === null ? <button type="button" className="btn sm" onClick={() => setLeft({})}>Leftovers at close</button> : <div className="stack" style={{ gap: 4, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <b>Leftovers at close</b><span className="dim" style={{ fontSize: 12.5 }}>Count what's left of each prepped dish. It's logged as over-prep waste.</span>
          {d.items.map((i) => <label key={i.id} className="row" style={{ fontSize: 14 }}><span className="grow">{i.name}</span>{d.leftovers?.[i.id] !== undefined ? <span className="chip">logged {d.leftovers[i.id]}</span> : <input className="input prep-onhand" type="number" min={0} value={left[i.id] ?? ''} onChange={(e) => setLeft({ ...left, [i.id]: e.target.value })} aria-label={`Leftover ${i.name}`} />}</label>)}
          <button type="button" className="btn primary" onClick={logLeft}>Log leftovers</button>
        </div>)}
        {d.ingredients.length > 0 && <><b>Ingredients</b>{d.ingredients.map((g) => <label key={g.id} className="row" style={{ fontSize: 15 }}><input type="checkbox" checked={Boolean(done[`g${g.id}`])} onChange={() => tick(`g${g.id}`)} /><span className="grow">{g.name}</span><span className="num">{g.need} {g.unit}</span>{g.short > 0 && <span className="chip rose">short {g.short}</span>}</label>)}</>}
      </>}
    </Modal>
  );
}
export function RunnerTicket({ o, unit, onServed }) {
  const seats = {}; for (const i of o.items.filter((x) => !x.held)) (seats[i.seat || 0] = seats[i.seat || 0] || []).push(i);
  return (
    <>
      <div className="runner-table">{unit} {o.table_label}</div>
      {Object.entries(seats).map(([s, its]) => <div key={s} className="runner-seat"><b>{Number(s) ? `Seat ${s}` : 'Share'}</b>{its.map((i) => <div key={i.id}>{i.qty} {i.name}{i.mods.length ? <em className="dim"> ({i.mods.join(', ')})</em> : null}</div>)}</div>)}
      <button className="btn primary lg block" onClick={(e) => { e.stopPropagation(); onServed(o); }}>Taken to the table</button>
    </>
  );
}
export function MakeGoodButtons({ o, onPick }) {
  return <div className="row" style={{ gap: 6 }}><span className="chip rose">Very late</span><button className="btn sm" onClick={(e) => { e.stopPropagation(); onPick(o, 'item'); }}>Send it on us</button><button className="btn sm" onClick={(e) => { e.stopPropagation(); onPick(o, 'discount'); }}>Take % off</button></div>;
}

/* ================= Orders board / Floor / Kitchen ================= */
export function OrderMakeGood({ o }) {
  const { settings, can } = useCC(); const toast = useToast();
  const lim = Number(settings.makegood_minutes || 0);
  if (!lim || !can('manager') || o.makegood_at || o.paid_at || !['open', 'sent'].includes(o.status) || !o.sent_at) return null;
  if (Date.now() - Date.parse(`${o.sent_at.replace(' ', 'T')}Z`) < lim * 60000) return null;
  const go = (kind) => api(`/staff/orders/${o.id}/makegood`, { method: 'POST', body: { kind } }).then((r) => toast(`#${o.number}: ${r.what}`, 'ok')).catch((e) => toast(e.message, 'err'));
  return <><span className="chip rose">Very late</span><button className="btn sm" onClick={() => go('item')}>On us</button><button className="btn sm" onClick={() => go('discount')}>{settings.makegood_pct || 10}% off</button></>;
}
export function TabsPanel() {
  const { settings } = useCC(); const toast = useToast();
  const [list, reload] = useLive(['tabs', 'orders'], () => (settings.bar_tabs === '1' ? api('/staff/tabs') : Promise.resolve([])));
  if (!list?.length) return null;
  const close = (t) => api(`/staff/tabs/${t.id}/close`, { method: 'POST' }).then((r) => { if (r.billToken) { navigator.clipboard?.writeText(`${location.origin}/p/${r.billToken}`); toast('Check ready; link copied', 'ok'); } else toast('Tab closed', 'ok'); reload(); }).catch((e) => toast(e.message, 'err'));
  return (
    <section className="panel" style={{ marginBottom: 18 }}><div className="panel-h"><h3 className="grow">Open tabs</h3><span className="chip">{list.length}</span></div>
      <table className="list"><tbody>{list.map((t) => <tr key={t.id}><td><b>{t.name}</b><div className="dim" style={{ fontSize: 12 }}>{t.table ? `${settings.unit_label} ${t.table} · ` : ''}{t.rounds} rounds · {t.items.map((i) => `${i.qty} ${i.name}`).join(', ')}</div></td><td className="num">{money(t.totalCents, settings.currency)}</td><td>{t.status === 'closing' ? <span className="chip amber">Paying</span> : null}</td><td style={{ textAlign: 'right' }}>{t.billToken ? <a className="btn sm ghost" href={`/p/${t.billToken}`} target="_blank" rel="noreferrer">Check</a> : <button className="btn sm" onClick={() => close(t)}>Close tab</button>}</td></tr>)}</tbody></table></section>
  );
}
export function AreaLoad() {
  const [d] = useLive(['orders', 'shifts'], () => api('/staff/area-load').catch(() => null));
  if (!d?.areas.length) return null;
  return <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>{d.areas.map((a) => <span key={a.area} className={`chip ${a.items && (!a.cooks || a.perCook > d.high) ? 'rose' : a.items === 0 && a.cooks >= 2 ? 'amber' : ''}`} title={a.names.join(', ')}>{a.area}: {a.items} items, {a.cooks} {a.cooks === 1 ? 'cook' : 'cooks'}</span>)}</div>;
}
export function DeliveryBatches() {
  const { can } = useCC(); const toast = useToast();
  const [d, reload] = useLive(['orders'], () => (can('manager') ? api('/staff/delivery-batches').catch(() => null) : Promise.resolve(null)));
  const [driver, setDriver] = useState('');
  if (!d || !d.batches.length) return null;
  const assign = (b) => api('/staff/delivery-batches/assign', { method: 'POST', body: { orderIds: b.orders.map((o) => o.id), driverId: Number(driver || d.drivers[0]?.id) } }).then((r) => { toast(`${r.assigned} deliveries assigned`, 'ok'); reload(); }).catch((e) => toast(e.message, 'err'));
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">Deliveries that can go together</h3><select className="input" style={{ width: 160, height: 32 }} value={driver} onChange={(e) => setDriver(e.target.value)} aria-label="Driver">{d.drivers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      <table className="list"><tbody>{d.batches.map((b, i) => <tr key={i}><td><b>{b.orders.map((o) => `#${o.number}`).join(' + ')}</b><div className="dim" style={{ fontSize: 12 }}>{b.orders.map((o) => o.address).join(' · ')}</div></td><td className="muted">within {b.spreadKm} km</td><td>{b.orders.every((o) => o.ready) ? <span className="chip teal">All ready</span> : <span className="chip">Some cooking</span>}</td><td style={{ textAlign: 'right' }}><button className="btn sm primary" disabled={!d.drivers.length} onClick={() => assign(b)}>Send together</button></td></tr>)}</tbody></table>
    </section>
  );
}

/* ================= Customer: bar tab on the table QR page ================= */
export function TabCard({ token, info, onTab, nav }) {
  const key = `bh_tab_${token}`; const mkey = `bh_tab_member_${token}`;
  const [tab, setTab] = useState(null); const [name, setName] = useState(''); const [err, setErr] = useState(''); const [join, setJoin] = useState(null);
  const member = localStorage.getItem(mkey) || '';
  const saved = localStorage.getItem(key);
  useEffect(() => { if (saved) api(`/t/${token}/tab/${saved}`).then((t) => { if (t.status === 'closed') { localStorage.removeItem(key); onTab(null); } else { setTab(t); onTab(t.token, localStorage.getItem(mkey) || t.name); } }).catch(() => { localStorage.removeItem(key); onTab(null); }); }, [info?.rounds?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!info.tabs) return null;
  const open = () => api(`/t/${token}/tab`, { method: 'POST', body: { name } }).then((t) => { localStorage.setItem(key, t.token); localStorage.setItem(mkey, name); setTab(t); onTab(t.token, name); }).catch((e) => setErr(e.message));
  const joinTab = () => api(`/t/${token}/tab/join`, { method: 'POST', body: join }).then((r) => { localStorage.setItem(key, r.token); localStorage.setItem(mkey, r.member); setJoin(null); api(`/t/${token}/tab/${r.token}`).then((t) => { setTab(t); onTab(t.token, r.member); }); }).catch((e) => setErr(e.message));
  const close = (mine) => api(`/t/${token}/tab/${tab.token}/close`, { method: 'POST', body: mine ? { member: member || tab.name } : {} }).then((r) => { if (r.billToken) nav(`/p/${r.billToken}${mine && r.items?.length ? `?items=${r.items.join(',')}` : ''}`); else { localStorage.removeItem(key); setTab(null); onTab(null); } }).catch((e) => setErr(e.message));
  return (
    <div className="card stack">
      {tab ? <>
        <div className="row"><b className="grow">{tab.name}'s tab</b><b className="num">{money(tab.totalCents, info.currency)}</b></div>
        {tab.items.length > 0 ? <span className="muted" style={{ fontSize: 14 }}>{tab.items.map((i) => `${i.qty} ${i.name}`).join(', ')}</span> : <span className="muted" style={{ fontSize: 14 }}>Order below; everything goes on your tab.</span>}
        {tab.members.length > 1 && <span className="muted" style={{ fontSize: 13 }}>{tab.members.map((m) => `${m.name} ${money(m.cents, info.currency)}`).join(' · ')}</span>}
        {tab.code && <span className="dim" style={{ fontSize: 13 }}>Friends can join this tab with code <b style={{ letterSpacing: 2 }}>{tab.code}</b></span>}
        <div className="row">{tab.members.length > 1 && <button className="btn grow" onClick={() => close(true)}>Pay my part</button>}<button className="btn grow" onClick={() => close(false)}>{tab.members.length > 1 ? 'Pay the whole tab' : 'Close my tab and pay'}</button></div>
      </> : <>
        <b>Start a tab</b><span className="muted" style={{ fontSize: 14 }}>Order rounds all night and pay once at the end.</span>
        <div className="row"><input className="input grow" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={30} /><button className="btn primary" disabled={!name.trim()} onClick={open}>Start</button></div>
        {join ? <div className="row"><input className="input" style={{ width: 90, textTransform: 'uppercase', letterSpacing: 2 }} placeholder="CODE" value={join.code} onChange={(e) => setJoin({ ...join, code: e.target.value.toUpperCase().slice(0, 4) })} /><input className="input grow" placeholder="Your name" value={join.name} onChange={(e) => setJoin({ ...join, name: e.target.value })} maxLength={30} /><button className="btn" disabled={join.code.length !== 4 || !join.name.trim()} onClick={joinTab}>Join</button></div>
          : <button className="btn ghost sm" onClick={() => setJoin({ code: '', name })}>Join a friend's tab</button>}
      </>}
      {err && <div className="lock-msg">{err}</div>}
    </div>
  );
}

/* ================= Settings ================= */
export function RunPanel({ f, setF }) {
  const [items, setItems] = useState([]);
  useEffect(() => { api('/staff/menu').then((m) => setItems(Array.isArray(m) ? m : m.items || [])).catch(() => {}); }, []);
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  const num = (k, label, w = 90) => <label className="field"><span>{label}</span><input className="input" style={{ width: w }} type="number" min={0} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <section className="panel"><div className="panel-h"><h3>Courses, make-goods, deliveries and tabs</h3></div><div className="panel-b stack">
      {num('course_gap_minutes', 'Send the next course this many minutes after the last one is done (0 = only when someone taps Fire)')}
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.ingredient_86 !== '0'} onChange={flag('ingredient_86')} />When an ingredient runs out, 86 every dish that uses it (and bring them back when it's restocked)</label>
      <div className="row wrap">{num('makegood_minutes', 'Late-ticket make-good after (minutes, 0 = off)')}
        <label className="field"><span>Dish to send "on us"</span><select className="input" value={f.makegood_item_id} onChange={(e) => setF({ ...f, makegood_item_id: e.target.value })}><option value="">Pick a dish</option>{items.filter((i) => i.active).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        {num('makegood_pct', 'Or % off')}</div>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.auto_vip === '1'} onChange={flag('auto_vip')} />Send members' and top guests' tickets as VIP automatically</label>
      {f.auto_vip === '1' && <div className="row wrap"><label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.auto_vip_members !== '0'} onChange={flag('auto_vip_members')} />Members</label>{num('auto_vip_spend_cents', 'and guests who spent this many cents in the last year (0 = off)', 120)}</div>}
      {num('pace_default_minutes', 'Course pacing: suggest the next course this many minutes after the last lands (used until there is enough history)')}
      {num('delivery_signature_cents', 'Ask for a customer signature on deliveries of this many cents or more (0 = never)', 120)}
      <PrepPars />
      <div className="row wrap">{num('batch_radius_km', 'Group deliveries within (km)')}{num('batch_window_minutes', 'and ready within (minutes)')}</div>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.bar_tabs === '1'} onChange={flag('bar_tabs')} />Bar tabs: guests start a tab from the table QR code and pay once at the end</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.area_alerts === '1'} onChange={flag('area_alerts')} />Area staffing alerts: tell managers when an area is slammed or overstaffed</label>
      {f.area_alerts === '1' && <div className="row wrap">{num('area_alert_high', 'Slammed above (items per cook)')}{num('area_alert_quiet_minutes', 'Quiet for (minutes)')}</div>}
    </div></section>
  );
}
