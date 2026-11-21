import { useEffect, useRef, useState } from 'react';
import { api, minutesSince, money, timeOf, useTick } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { forgetReaders } from '../pro-ui.jsx';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);

/* ================= Deliveries: dispatch board + driver view ================= */
function useShareLocation(on) {
  const [state, setState] = useState('off');
  useEffect(() => {
    if (!on) { setState('off'); return undefined; }
    if (!navigator.geolocation) { setState('unsupported'); return undefined; }
    let last = 0;
    const id = navigator.geolocation.watchPosition((p) => {
      setState('on');
      if (Date.now() - last < 10000) return; last = Date.now();
      api('/staff/driver/location', { method: 'POST', body: { lat: p.coords.latitude, lng: p.coords.longitude } }).catch(() => {});
    }, (e) => setState(e.code === 1 ? 'denied' : 'error'), { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
    let wake = null; navigator.wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => {});
    return () => { navigator.geolocation.clearWatch(id); wake?.release?.(); };
  }, [on]);
  return state;
}
function DeliveredModal({ o, currency, onClose }) {
  const toast = useToast();
  const [method, setMethod] = useState('cash');
  const [tip, setTip] = useState('');
  const done = async () => { try { await api(`/staff/orders/${o.id}/delivered`, { method: 'POST', body: o.dueCents ? { method, tipCents: dollars(tip) } : {} }); toast(`#${o.number} delivered`, 'ok'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`Deliver #${o.number}`} onClose={onClose} width={420}>
      {o.dueCents > 0 ? (
        <>
          <div className="totals"><div className="grand"><span>Collect</span><span>{money(o.dueCents, currency)}</span></div></div>
          <div className="seg" style={{ width: '100%' }}>{['cash', 'card', 'other'].map((m) => <button key={m} aria-pressed={method === m} onClick={() => setMethod(m)} style={{ flex: 1, textTransform: 'capitalize' }}>{m}</button>)}</div>
          <input className="input" inputMode="decimal" placeholder="Tip they gave (optional)" value={tip} onChange={(e) => setTip(e.target.value)} aria-label="Tip" />
        </>
      ) : <p className="muted" style={{ margin: 0 }}>Already paid. Just hand it over.</p>}
      <button className="btn primary lg block" onClick={done}>Mark delivered</button>
    </Modal>
  );
}
export function Deliveries() {
  const { settings, user } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [d, reload] = useLive(['orders'], () => api('/staff/deliveries'));
  const [delivering, setDelivering] = useState(null);
  useTick(30000);
  const sharing = useShareLocation(Boolean(d?.mine?.some((o) => o.out_at)));
  if (!d) return null;
  const act = async (path, body, msg) => { try { await api(path, { method: 'POST', body }); toast(msg, 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  const open = d.orders.filter((o) => !o.delivered_at);
  const done = d.orders.filter((o) => o.delivered_at);
  const card = (o, driverView) => (
    <div key={o.id} className="panel dlv">
      <div className="panel-b stack" style={{ gap: 8 }}>
        <div className="row"><b className="num" style={{ fontSize: 22 }}>#{o.number}</b><span className="grow">{o.customer_name}</span>
          <span className={`chip ${o.out_at ? 'blue' : o.status === 'ready' ? 'teal' : 'amber'}`}>{o.out_at ? `Out ${minutesSince(o.out_at)}m` : o.status === 'ready' ? 'Ready' : 'Cooking'}</span></div>
        <div>{o.delivery_address}</div>
        {o.order_notes && <div className="dim" style={{ fontSize: 13.5 }}>{o.order_notes}</div>}
        <div className="row muted" style={{ fontSize: 14 }}><span className="grow">{o.lines} item{o.lines === 1 ? '' : 's'}, {o.dueCents ? `collect ${money(o.dueCents, cur)}` : 'paid'}</span>{o.contact_phone && <a href={`tel:${o.contact_phone.replace(/[^\d+]/g, '')}`}>{o.contact_phone}</a>}</div>
        {d.canDispatch && !driverView && (
          <select className="input" value={o.driver_id || ''} onChange={(e) => act(`/staff/orders/${o.id}/assign`, { driverId: e.target.value ? Number(e.target.value) : null }, e.target.value ? 'Driver assigned' : 'Driver removed')} aria-label="Driver">
            <option value="">{d.drivers.length ? 'Pick a driver' : 'No drivers yet: turn on "Driver" in Staff'}</option>{d.drivers.map((x) => <option key={x.id} value={x.id}>{x.name}{x.active ? ` (${x.active} on the road)` : ''}</option>)}
          </select>
        )}
        <div className="row">
          {o.mapsUrl && <a className="btn grow" href={o.mapsUrl} target="_blank" rel="noreferrer"><Icon name="pin" size={16} />Directions</a>}
          {!o.out_at && (o.driver_id === user.id || d.canDispatch) && <button className="btn primary grow" onClick={() => act(`/staff/orders/${o.id}/out`, {}, 'On the way. The customer can see you coming.')}>Start delivery</button>}
          {o.out_at && (o.driver_id === user.id || d.canDispatch) && <button className="btn primary grow" onClick={() => setDelivering(o)}>Delivered</button>}
        </div>
      </div>
    </div>
  );
  return (
    <>
      <PageHead title="Deliveries" sub={d.canDispatch ? `${open.length} open. Assign a driver, and the customer sees them coming live on their phone.` : 'Your deliveries. Keep this page open while you drive so customers can see you coming.'}>
        {d.mine.some((o) => o.out_at) && <span className={`chip ${sharing === 'on' ? 'teal' : 'rose'}`}>{sharing === 'on' ? 'Sharing your location' : sharing === 'denied' ? 'Location blocked: allow it in your browser' : 'Finding your location…'}</span>}
      </PageHead>
      {d.isDriver && d.mine.length > 0 && <><h3 style={{ margin: '0 0 10px' }}>My deliveries</h3><div className="dlv-grid" style={{ marginBottom: 22 }}>{d.mine.map((o) => card(o, true))}</div></>}
      {d.canDispatch && (
        <>
          {open.length === 0 ? <div className="panel empty"><b>No deliveries right now</b><span>Delivery orders from your online ordering page show up here.</span></div> : <div className="dlv-grid">{open.map((o) => card(o, false))}</div>}
          {d.drivers.length > 0 && <section className="panel" style={{ marginTop: 18 }}><div className="panel-h"><h3>Drivers</h3></div><table className="list"><tbody>{d.drivers.map((x) => <tr key={x.id}><td>{x.name}</td><td className="muted">{x.active} on the road</td><td className="muted">{x.at ? `Location ${minutesSince(x.at) < 1 ? 'just now' : `${minutesSince(x.at)} min ago`}` : 'No location yet'}</td></tr>)}</tbody></table></section>}
          {done.length > 0 && <section className="panel" style={{ marginTop: 18 }}><div className="panel-h"><h3>Delivered in the last 3 hours</h3></div><table className="list"><tbody>{done.map((o) => <tr key={o.id}><td className="num">#{o.number}</td><td>{o.customer_name}</td><td className="muted">{o.driver_name}</td><td className="muted num">{timeOf(o.delivered_at)}</td><td className="num muted">{o.out_at ? `${Math.round((Date.parse(`${o.delivered_at.replace(' ', 'T')}Z`) - Date.parse(`${o.out_at.replace(' ', 'T')}Z`)) / 60000)} min on the road` : ''}</td></tr>)}</tbody></table></section>}
        </>
      )}
      {!d.canDispatch && !d.isDriver && <div className="panel empty"><b>You're not set up as a driver</b><span>Ask a manager to turn on "Driver" for you in Staff.</span></div>}
      {delivering && <DeliveredModal o={delivering} currency={cur} onClose={() => { setDelivering(null); reload(); }} />}
    </>
  );
}

/* ================= Customer profile ================= */
const TAG_IDEAS = ['VIP', 'Regular', 'Nut allergy', 'Gluten free', 'Vegan', 'Shellfish allergy', 'High chair', 'Wheelchair', 'Birthday club', 'Prefers booth'];
export function CustomerModal({ id, onClose }) {
  const { settings, can } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [p, setP] = useState(null);
  const [notes, setNotes] = useState('');
  const [tag, setTag] = useState('');
  const load = () => api(can('manager') ? `/staff/customers/${id}` : `/staff/customers/${id}/card`).then((x) => { setP(x); setNotes(x.notes || ''); });
  useEffect(() => { load().catch((e) => toast(e.message, 'err')); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return null;
  const save = async (body) => { try { await api(`/staff/customers/${id}`, { method: 'PUT', body }); await load(); } catch (e) { toast(e.message, 'err'); } };
  const addTag = (t) => { const v = t.trim(); if (v && !p.tags.includes(v)) save({ tags: [...p.tags, v] }); setTag(''); };
  return (
    <Modal title={p.name} onClose={onClose} width={620}>
      <div className="row wrap" style={{ gap: 6 }}>
        {p.tags.map((t) => <span key={t} className={`chip ${/allerg|free|vegan/i.test(t) ? 'rose' : 'amber'}`}>{t}<button className="btn ghost sm" style={{ height: 20, padding: '0 4px' }} onClick={() => save({ tags: p.tags.filter((x) => x !== t) })} aria-label={`Remove ${t}`}>×</button></span>)}
        <input className="input" style={{ width: 150, height: 32 }} list="tag-ideas" placeholder="Add a tag" value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTag(tag)} aria-label="Add a tag" maxLength={24} />
        <datalist id="tag-ideas">{TAG_IDEAS.map((t) => <option key={t} value={t} />)}</datalist>
      </div>
      {p.email && (
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="kpi"><div className="v">{p.visitsCount}</div><div className="l">Visits</div></div>
          <div className="kpi"><div className="v">{money(p.spentCents, cur)}</div><div className="l">Spent</div></div>
          <div className="kpi"><div className="v">{money(p.avgCents, cur)}</div><div className="l">Average order</div></div>
          <div className="kpi"><div className="v">{p.avgRating ? `${p.avgRating}★` : 'None'}</div><div className="l">Their ratings</div></div>
        </div>
      )}
      {p.usual.length > 0 && <div><b>Usually orders:</b> <span className="muted">{p.usual.map((u) => `${u.name}${u.times > 1 ? ` (${u.times})` : ''}`).join(', ')}</span></div>}
      <label className="field"><span>Notes for the team</span><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (p.notes || '') && save({ notes })} maxLength={500} placeholder="Likes the window table, celebrates anniversaries in June" /></label>
      {p.email && (
        <>
          <div className="row muted" style={{ fontSize: 14 }}><span className="grow">{p.email}{p.phone ? `, ${p.phone}` : ''}</span><span>Birthday {p.birthday ? new Date(`2000-${p.birthday}T12:00:00`).toLocaleDateString([], { month: 'long', day: 'numeric' }) : 'not set'}</span><span>{p.marketing ? 'Gets offers' : 'No offers'}</span></div>
          {p.bookings.length > 0 && <div className="dim" style={{ fontSize: 13.5 }}><b>Bookings:</b> {p.bookings.slice(0, 5).map((b) => `${b.start_local} (${b.status}${b.deposit_cents ? `, ${money(b.deposit_cents, cur)} deposit ${b.deposit_status}` : ''})`).join('; ')}</div>}
          {p.recentOrders.length > 0 && <div className="dim" style={{ fontSize: 13.5 }}><b>Recent orders:</b> {p.recentOrders.map((o) => `#${o.number} ${money(o.totalCents, cur)}`).join(', ')}</div>}
          {p.offers.length > 0 && <div className="dim" style={{ fontSize: 13.5 }}><b>Automatic offers:</b> {p.offers.map((o) => `${o.flow} ${o.code}`).join(', ')}</div>}
        </>
      )}
      {p.birthdayToday && <div className="card banner">It's their birthday today!</div>}
    </Modal>
  );
}

/* ================= Automatic offers (inside Marketing) ================= */
export function AutoOffers() {
  const toast = useToast();
  const { settings } = useCC();
  const [d, reload] = useLive(['promos'], () => api('/staff/autooffers'));
  if (!d) return null;
  const set = async (body) => { try { await api('/staff/settings', { method: 'PUT', body }); reload(); } catch (e) { toast(e.message, 'err'); } };
  const run = async () => { try { const r = await api('/staff/autooffers/run', { method: 'POST' }); const n = Object.values(r).reduce((a, x) => a + x.candidates, 0); toast(n ? `Sent ${n} offer${n === 1 ? '' : 's'}` : 'Nobody is due an offer right now', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  const help = { birthday: 'On their birthday. Customers add their birthday in their account.', winback: `When a regular hasn't been back for ${d.winbackDays} days.`, welcome: 'Within 3 days of their first visit.' };
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">Automatic offers</h3><button className="btn sm" onClick={run}>Send what's due now</button></div>
      <table className="list"><thead><tr><th>Offer</th><th>When</th><th>Discount</th><th>Due now</th><th>Sent</th><th>Used</th><th>Sales</th><th /></tr></thead>
        <tbody>{d.flows.map((f) => (
          <tr key={f.key}><td><b>{f.label}</b></td><td className="muted" style={{ fontSize: 13.5 }}>{help[f.key]}</td>
            <td><select className="input" style={{ width: 80, height: 32 }} value={f.pct} onChange={(e) => set({ [`auto_${f.key}_pct`]: e.target.value })} aria-label={`${f.label} discount`}>{[5, 10, 15, 20, 25, 30, 50].map((v) => <option key={v} value={v}>{v}%</option>)}</select></td>
            <td className="num">{f.waiting}</td><td className="num">{f.sent}</td><td className="num">{f.used}</td><td className="num">{money(f.salesCents, settings.currency)}</td>
            <td style={{ textAlign: 'right' }}><button className={`btn sm ${f.on ? 'primary' : ''}`} onClick={() => set({ [`auto_${f.key}`]: f.on ? '0' : '1' })}>{f.on ? 'On' : 'Off'}</button></td></tr>
        ))}</tbody></table>
      <div className="panel-b dim" style={{ fontSize: 13 }}>Each customer gets their own one-time code, good for 14 days. Offers go out each morning to customers who said yes to offers.{d.flows.find((f) => f.key === 'winback') && <> Win back after <select className="input" style={{ width: 80, height: 28, display: 'inline-block' }} value={d.winbackDays} onChange={(e) => set({ auto_winback_days: e.target.value })} aria-label="Days before a win-back offer">{[21, 30, 45, 60, 90].map((v) => <option key={v} value={v}>{v} days</option>)}</select>.</>}</div>
    </section>
  );
}

/* ================= Settings panels ================= */
export function ReadersPanel({ f, setF }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [add, setAdd] = useState(null);
  const load = () => { forgetReaders(); api('/staff/terminal/readers').then(setD).catch(() => setD({ enabled: false, readers: [] })); };
  useEffect(load, []);
  const save = async () => {
    try { await api('/staff/terminal/readers', { method: 'POST', body: { code: add.code, label: add.label, address: d.location ? undefined : { line1: add.line1, city: add.city, state: add.state, postal: add.postal, country: add.country || 'US' } } }); toast(`${add.label} added`, 'ok'); setAdd(null); load(); } catch (e) { toast(e.message, 'err'); }
  };
  if (!d) return null;
  return (
    <section className="panel"><div className="panel-h"><h3 className="grow">Card readers</h3>{d.enabled && <button className="btn sm" onClick={() => setAdd({ code: '', label: 'Front counter', country: 'US' })}>Add a reader</button>}</div><div className="panel-b stack">
      {!d.enabled ? <span className="muted" style={{ fontSize: 14 }}>Connect Stripe first (add your Stripe key in Railway). Then add a Stripe smart reader, like the WisePOS E or S700, and the register charges cards directly.</span> : (
        <>
          {d.readers.length === 0 ? <span className="muted" style={{ fontSize: 14 }}>No readers yet. On the reader, open settings and choose "Generate pairing code", then add it here.{d.test ? ' In test mode, use the code simulated-wpe for a pretend reader.' : ''}</span>
            : d.readers.map((r) => <div key={r.id} className="row"><span className={`chip ${r.status === 'online' ? 'teal' : ''}`}>{r.status || 'unknown'}</span><span className="grow">{r.label} <span className="dim">{r.type}</span></span><button className="btn sm ghost danger" onClick={() => confirm(`Remove ${r.label}?`) && api(`/staff/terminal/readers/${r.id}`, { method: 'DELETE' }).then(load)}>Remove</button></div>)}
          {d.readers.length > 0 && <label className="field"><span>Reader for the self-order kiosk</span><select className="input" value={f.kiosk_reader_id} onChange={(e) => setF({ ...f, kiosk_reader_id: e.target.value })}><option value="">None (pay at the counter)</option>{d.readers.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>}
        </>
      )}
      {add && (
        <Modal title="Add a card reader" onClose={() => setAdd(null)} width={480}>
          <label className="field"><span>Pairing code shown on the reader</span><input className="input" value={add.code} onChange={(e) => setAdd({ ...add, code: e.target.value })} placeholder="apple-grape-orange" /></label>
          <label className="field"><span>Name</span><input className="input" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} maxLength={40} /></label>
          {!d.location && (
            <>
              <span className="muted" style={{ fontSize: 13.5 }}>Your business address, needed once by Stripe:</span>
              <input className="input" placeholder="Street address" value={add.line1 || ''} onChange={(e) => setAdd({ ...add, line1: e.target.value })} />
              <div className="row"><input className="input grow" placeholder="City" value={add.city || ''} onChange={(e) => setAdd({ ...add, city: e.target.value })} /><input className="input" style={{ width: 80 }} placeholder="State" value={add.state || ''} onChange={(e) => setAdd({ ...add, state: e.target.value })} /></div>
              <div className="row"><input className="input grow" placeholder="ZIP / postal code" value={add.postal || ''} onChange={(e) => setAdd({ ...add, postal: e.target.value })} /><input className="input" style={{ width: 80 }} placeholder="Country" maxLength={2} value={add.country || ''} onChange={(e) => setAdd({ ...add, country: e.target.value.toUpperCase() })} /></div>
            </>
          )}
          <button className="btn primary lg block" disabled={!add.code || !add.label} onClick={save}>Add reader</button>
        </Modal>
      )}
    </div></section>
  );
}

export function KioskPanel({ f, setF }) {
  const toast = useToast();
  const start = async () => {
    const name = prompt('Name this kiosk', 'Front kiosk'); if (!name) return;
    try { const r = await api('/staff/kiosk/start', { method: 'POST', body: { name } }); localStorage.setItem('bh_kiosk', r.token); localStorage.setItem('bh_kiosk_loc', r.loc); location.href = `/kiosk${r.loc && r.loc !== 'main' ? `?l=${r.loc}` : ''}`; } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <section className="panel"><div className="panel-h"><h3>Self-order kiosk</h3></div><div className="panel-b stack">
      <span className="muted" style={{ fontSize: 14 }}>Turn a tablet into a counter kiosk. Customers order, pay at the counter or on the card reader, and scan to get their buzzer. Leaving the kiosk needs a manager PIN.</span>
      <label className="field"><span>Welcome message on the kiosk</span><input className="input" value={f.kiosk_message} onChange={(e) => setF({ ...f, kiosk_message: e.target.value })} maxLength={120} placeholder="Order here, we'll buzz your phone" /></label>
      <div className="row"><button className="btn primary grow" onClick={start}>Start a kiosk on this device</button><button className="btn grow" onClick={() => confirm('Sign out every kiosk? Each one will need a manager to start it again.') && api('/staff/kiosk/signout-all', { method: 'POST' }).then(() => toast('All kiosks signed out', 'ok'))}>Sign out all kiosks</button></div>
    </div></section>
  );
}

export function MorePanel({ f, setF }) {
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="panel"><div className="panel-h"><h3>Deposits, payroll and owner alerts</h3></div><div className="panel-b stack">
      <div className="row">
        <label className="field grow"><span>Booking deposit (0 for none; needs Stripe)</span><input className="input" inputMode="decimal" value={(Number(f.booking_deposit_cents) / 100).toFixed(2)} onChange={(e) => setF({ ...f, booking_deposit_cents: String(dollars(e.target.value)) })} /></label>
        <label className="field grow"><span>Refund it if they cancel this many hours ahead</span><input className="input" type="number" min={0} max={168} value={f.deposit_refund_hours} onChange={set('deposit_refund_hours')} /></label>
      </div>
      <span className="dim" style={{ fontSize: 12.5 }}>The deposit comes off their bill when they check in. It's kept on a no-show or a late cancel.</span>
      <div className="row">
        <label className="field grow"><span>Overtime after (hours a week)</span><input className="input" type="number" min={20} max={80} value={f.ot_weekly_hours} onChange={set('ot_weekly_hours')} /></label>
        <label className="field grow"><span>Work week starts</span><select className="input" value={f.payroll_week_start} onChange={set('payroll_week_start')}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
        <label className="field grow"><span>Break needed after (hours)</span><input className="input" type="number" min={2} max={12} step={0.5} value={f.break_after_hours} onChange={set('break_after_hours')} /></label>
      </div>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.ot_alerts === '1'} onChange={flag('ot_alerts')} /> Alert managers when someone nears overtime or skips a break</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.chat_enabled === '1'} onChange={flag('chat_enabled')} /> Let guests message the team from their buzzer</label>
      {f.chat_enabled === '1' && <label className="field"><span>Quick replies (one per line)</span><textarea className="input" rows={4} value={(() => { try { return JSON.parse(f.chat_quick || '[]').join('\n'); } catch { return ''; } })()} onChange={(e) => setF({ ...f, chat_quick: JSON.stringify(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8).map((x) => x.slice(0, 120))) })} /></label>}
      <label className="field"><span>Food cost target (%)</span><input className="input" type="number" min={5} max={80} value={f.food_cost_target} onChange={set('food_cost_target')} /></label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.insights_summary === '1'} onChange={flag('insights_summary')} /> Send owners a daily summary at
        <select className="input" style={{ width: 110, height: 32 }} value={f.insights_hour} onChange={set('insights_hour')}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>)}</select></label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.insights_alerts === '1'} onChange={flag('insights_alerts')} /> Alert managers about unusual voids, refunds, discounts or slow tickets</label>
      {f.insights_alerts === '1' && <div className="row">
        <label className="field grow"><span>Voids by one person in a day</span><input className="input" type="number" min={1} max={50} value={f.insights_void_limit} onChange={set('insights_void_limit')} /></label>
        <label className="field grow"><span>Refunds in a day over</span><input className="input" inputMode="decimal" value={(Number(f.insights_refund_cents) / 100).toFixed(0)} onChange={(e) => setF({ ...f, insights_refund_cents: String(dollars(e.target.value)) })} /></label>
      </div>}
    </div></section>
  );
}

export function useCustomerModal() {
  const [id, setId] = useState(null);
  const ref = useRef(setId); ref.current = setId;
  return [id ? <CustomerModal key={id} id={id} onClose={() => setId(null)} /> : null, setId];
}

/* ================= Ways to get paid (settings) ================= */
export function PaymentsSetup({ f, setF }) {
  const [p, setP] = useState(null);
  useEffect(() => { api('/staff/payments/providers').then(setP).catch(() => setP({})); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  let rates = {}; try { rates = JSON.parse(f.fee_rates || '{}'); } catch { /* keep */ }
  const setRate = (k, i, v) => { const r = { ...rates, [k]: [...(rates[k] || [0, 0])] }; r[k][i] = Number(v) || 0; setF({ ...f, fee_rates: JSON.stringify(r) }); };
  const Row = ({ on, name, detail, env }) => <div className="row" style={{ fontSize: 14 }}><span className={`chip ${on ? 'teal' : ''}`}>{on ? `Connected${env === 'sandbox' ? ' (test)' : ''}` : 'Not connected'}</span><b>{name}</b><span className="muted grow">{detail}</span></div>;
  if (!p) return null;
  return (
    <section className="panel"><div className="panel-h"><h3>Ways to get paid</h3></div><div className="panel-b stack">
      <span className="muted" style={{ fontSize: 14 }}>Turn on as many as you like. Customers see them on one pay page, with the ones that cost you least listed first.</span>
      <Row on={p.square} env={p.squareEnv} name="Square" detail="Cards, Apple Pay, Google Pay, Cash App Pay, Afterpay, and Square Terminal at the counter. Free next-day deposit to your bank." />
      <Row on={p.paypal} env={p.paypalEnv} name="PayPal and Venmo" detail="PayPal and Venmo buttons on the pay page." />
      <Row on={p.stripe} name="Stripe" detail="Optional. Cards and wallets, and Stripe readers." />
      <span className="dim" style={{ fontSize: 12.5 }}>These connect with keys added in Railway (your provider shows them in its developer settings). Ask your BuzzHub provider, or see the user manual, section "Ways to get paid".</span>
      {(p.square && p.stripe) && <label className="field"><span>Use for card payments</span><select className="input" value={f.card_provider} onChange={set('card_provider')}><option value="auto">Automatic (Square first)</option><option value="square">Square</option><option value="stripe">Stripe</option></select></label>}
      <label className="row" style={{ fontSize: 14, marginTop: 6 }}><input type="checkbox" checked={f.pay_handles_enabled === '1'} onChange={(e) => setF({ ...f, pay_handles_enabled: e.target.checked ? '1' : '0' })} /> Also let customers pay my own app accounts (staff confirm each payment)</label>
      {f.pay_handles_enabled === '1' && (
        <>
          <div className="row">
            <label className="field grow"><span>Zelle email or phone (no fees)</span><input className="input" value={f.pay_zelle} onChange={set('pay_zelle')} maxLength={80} placeholder="pay@yourbusiness.com" /></label>
            <label className="field grow"><span>Venmo business username</span><input className="input" value={f.pay_venmo} onChange={set('pay_venmo')} maxLength={31} placeholder="@yourbusiness" /></label>
          </div>
          <div className="row">
            <label className="field grow"><span>Cash App $cashtag</span><input className="input" value={f.pay_cashapp} onChange={set('pay_cashapp')} maxLength={21} placeholder="$yourbusiness" /></label>
            <label className="field grow"><span>PayPal.me name</span><input className="input" value={f.pay_paypalme} onChange={set('pay_paypalme')} maxLength={20} placeholder="yourbusiness" /></label>
          </div>
          <span className="dim" style={{ fontSize: 12.5 }}>When a customer says they've paid, managers get an alert and a "Confirm" button. Check the app first. These can't be refunded from BuzzHub.</span>
        </>
      )}
      <label className="field" style={{ marginTop: 6 }}><span>Cash discount (%, 0 for none)</span><input className="input" type="number" min={0} max={4} step={0.5} value={f.cash_discount_pct} onChange={set('cash_discount_pct')} /></label>
      <span className="dim" style={{ fontSize: 12.5 }}>Your menu prices are the card prices. Cash payments at the register get this much off. This is a cash discount, not a card fee. Post a sign saying "cash price is X% less".</span>
      <details><summary className="muted" style={{ fontSize: 14, cursor: 'pointer' }}>Fee rates used for the payment costs report</summary>
        <div className="pick-grid" style={{ maxHeight: 'none', marginTop: 8 }}>
          {Object.entries(rates).map(([k, [pct, fixed]]) => (
            <label key={k} className="field"><span style={{ textTransform: 'capitalize' }}>{k === 'online' ? 'Card online' : k === 'card' ? 'Card in person' : k}</span>
              <div className="row" style={{ gap: 4 }}><input className="input" style={{ width: 64 }} inputMode="decimal" defaultValue={pct} onBlur={(e) => setRate(k, 0, e.target.value)} aria-label={`${k} percent`} /><span className="muted">% +</span><input className="input" style={{ width: 56 }} inputMode="numeric" defaultValue={fixed} onBlur={(e) => setRate(k, 1, e.target.value)} aria-label={`${k} cents`} /><span className="muted">¢</span></div></label>
          ))}
        </div>
      </details>
    </div></section>
  );
}

/* ================= App payments waiting for a staff check ================= */
export function PaymentClaims() {
  const { settings } = useCC();
  const toast = useToast();
  const [list, reload] = useLive(['payments'], () => api('/staff/payments/claims'));
  if (!list?.length) return null;
  const act = async (c, ok) => { try { await api(`/staff/payments/${c.id}/${ok ? 'confirm' : 'reject'}`, { method: 'POST' }); toast(ok ? 'Payment confirmed' : 'Marked as not received', ok ? 'ok' : 'err'); reload(); } catch (e) { toast(e.message, 'err'); } };
  const appName = { cashapp: 'Cash App', venmo: 'Venmo', paypalme: 'PayPal', zelle: 'Zelle' };
  return (
    <div className="claims" role="region" aria-label="Payments to confirm">
      {list.map((c) => (
        <div key={c.id} className="row claim">
          <Icon name="bell" size={16} />
          <span className="grow"><b>{c.claim_name}</b> says they sent <b>{money(c.total_cents, settings.currency)}</b> by {appName[c.claim_app]}{c.descr ? ` for ${c.descr}` : ''}, {timeOf(c.claimed_at)}. Check {appName[c.claim_app]}, then:</span>
          <button className="btn sm primary" onClick={() => act(c, true)}>It arrived</button>
          <button className="btn sm ghost danger" onClick={() => act(c, false)}>Not received</button>
        </div>
      ))}
    </div>
  );
}

/* ================= Payment costs (inside Insights) ================= */
export function PaymentCosts() {
  const { settings } = useCC();
  const cur = settings.currency;
  const [d] = useLive(['orders'], () => api('/staff/insights/fees'));
  if (!d) return null;
  const label = { card: 'Card in person', online: 'Card online', cash: 'Cash', zelle: 'Zelle', venmo: 'Venmo', cashapp: 'Cash App', paypal: 'PayPal', paypalme: 'PayPal.me', gift: 'Gift card', other: 'Other' };
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">What payments cost you, last 30 days</h3><span className="muted">About {money(d.feeCents, cur)} in fees, {d.effectivePct}% of sales</span></div>
      <table className="list"><thead><tr><th>How they paid</th><th>Payments</th><th>Amount</th><th>Estimated fees</th></tr></thead>
        <tbody>{d.methods.map((m) => <tr key={m.method}><td>{label[m.method] || m.method}</td><td className="num">{m.count}</td><td className="num">{money(m.cents, cur)}</td><td className="num">{money(m.feeCents, cur)}</td></tr>)}</tbody></table>
      <div className="panel-b stack" style={{ gap: 6, fontSize: 14 }}>
        <b>Ways to pay less</b>
        {!d.ideas.zelleOn && <span>Add Zelle in Settings → Ways to get paid. It's bank to bank with no fee to you. Moving just 1 in 10 card payments there saves about {money(d.ideas.tenPctToZelleCents, cur)} a month.</span>}
        {!d.ideas.cashDiscountOn && <span>Offer a cash discount (Settings → Ways to get paid). Card prices stay as posted, and cash customers pay a little less.</span>}
        <span>Ask your card provider about lower rates once you're processing more each month. Rates are often negotiable.</span>
        <span className="dim" style={{ fontSize: 12.5 }}>Estimates use the rates in Settings. Your statements from each provider are the final word.</span>
      </div>
    </section>
  );
}
