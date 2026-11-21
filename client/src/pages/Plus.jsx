import { useEffect, useRef, useState } from 'react';
import { api, applyAccent, imageToPng, money } from '../lib.js';
import { Icon, Modal, Puck, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { GiftBonuses, MenuSchedules, PunchPlans } from './More.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);
const t12 = (hm) => new Date(`2000-01-01T${hm}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const today = () => new Date().toLocaleDateString('en-CA');

function ItemChooser({ menu, itemIds, categories, onChange }) {
  const cats = [...new Set(menu.map((m) => m.category))];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row wrap" style={{ gap: 6 }}>{cats.map((c) => { const on = categories.includes(c); return <button key={c} type="button" className={`chip ${on ? 'teal' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={on} onClick={() => onChange({ itemIds, categories: on ? categories.filter((x) => x !== c) : [...categories, c] })}>All {c}</button>; })}</div>
      <div className="row wrap" style={{ gap: 6 }}>{menu.filter((m) => !categories.includes(m.category)).map((m) => { const on = itemIds.includes(m.id); return <button key={m.id} type="button" className={`chip ${on ? 'amber' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={on} onClick={() => onChange({ categories, itemIds: on ? itemIds.filter((x) => x !== m.id) : [...itemIds, m.id] })}>{m.name}</button>; })}</div>
    </div>
  );
}

/* ================= Deals: happy hour, specials, combos ================= */
export function Deals() {
  const [tab, setTab] = useState('happy');
  return (
    <>
      <PageHead title="Deals" sub="Happy hour prices, daily specials and combos. They show on the register, online, on the kiosk and on table QR menus.">
        <div className="seg">{[['happy', 'Happy hour'], ['specials', 'Specials'], ['combos', 'Combos'], ['menus', 'Menu times'], ['punch', 'Punch cards'], ['bonus', 'Gift bonuses']].map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      </PageHead>
      {tab === 'happy' && <HappyHour />}
      {tab === 'specials' && <Specials />}
      {tab === 'combos' && <Combos />}
      {tab === 'menus' && <MenuSchedules />}
      {tab === 'punch' && <PunchPlans />}
      {tab === 'bonus' && <GiftBonuses />}
    </>
  );
}
function HappyHour() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [d, reload] = useLive(['menu'], () => api('/staff/price-rules'));
  const [menu] = useLive(['menu'], () => api('/staff/menu'));
  const [edit, setEdit] = useState(null);
  if (!d || !menu) return null;
  const blank = { name: 'Happy hour', days: [1, 2, 3, 4, 5], start: '16:00', end: '18:00', kind: 'pct', value: '20', itemIds: [], categories: [] };
  const save = async () => { try { const body = { name: edit.name, days: edit.days, start: edit.start, end: edit.end, kind: edit.kind, value: edit.kind === 'pct' ? Number(edit.value) : dollars(edit.value), itemIds: edit.itemIds, categories: edit.categories }; await api(edit.id ? `/staff/price-rules/${edit.id}` : '/staff/price-rules', { method: edit.id ? 'PUT' : 'POST', body: { ...body, active: edit.active } }); setEdit(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const label = (r) => (r.kind === 'pct' ? `${r.value}% off` : r.kind === 'amount' ? `${money(r.value, cur)} off` : `${money(r.value, cur)} each`);
  return (
    <section className="panel">
      <div className="panel-h"><h3 className="grow">Timed prices</h3><button className="btn primary sm" onClick={() => setEdit(blank)}>New happy hour</button></div>
      {d.rules.length === 0 ? <div className="panel-b muted">No happy hours yet. Prices change on their own at the times you set, then go back.</div> : (
        <table className="list"><tbody>{d.rules.map((r) => (
          <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}><td><b>{r.name}</b> {d.live.includes(r.id) && <span className="chip teal">On now</span>}<div className="dim" style={{ fontSize: 12.5 }}>{r.days.length === 7 ? 'Every day' : r.days.map((x) => DAYS[x]).join(', ')}, {t12(r.start_time)} to {t12(r.end_time)}</div></td>
            <td>{label(r)}<div className="dim" style={{ fontSize: 12.5 }}>{[...r.categories.map((c) => `all ${c}`), ...r.item_ids.map((id) => menu.find((m) => m.id === id)?.name).filter(Boolean)].join(', ')}</div></td>
            <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setEdit({ ...r, start: r.start_time, end: r.end_time, itemIds: r.item_ids, value: r.kind === 'pct' ? String(r.value) : (r.value / 100).toFixed(2), active: Boolean(r.active) })}>Edit</button><button className="btn sm ghost" onClick={() => confirm(`Delete ${r.name}?`) && api(`/staff/price-rules/${r.id}`, { method: 'DELETE' }).then(reload)}>Delete</button></td></tr>
        ))}</tbody></table>
      )}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New happy hour'} onClose={() => setEdit(null)} width={560}>
          <label className="field"><span>Name (customers see it)</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={40} /></label>
          <div className="field"><span>Days</span><div className="row wrap" style={{ gap: 6 }}>{DAYS.map((x, i) => <button key={x} type="button" className={`btn sm ${edit.days.includes(i) ? 'primary' : ''}`} onClick={() => setEdit({ ...edit, days: edit.days.includes(i) ? edit.days.filter((y) => y !== i) : [...edit.days, i].sort() })}>{x}</button>)}</div></div>
          <div className="row"><label className="field grow"><span>Starts</span><input className="input" type="time" value={edit.start} onChange={(e) => setEdit({ ...edit, start: e.target.value })} /></label><label className="field grow"><span>Ends</span><input className="input" type="time" value={edit.end} onChange={(e) => setEdit({ ...edit, end: e.target.value })} /></label></div>
          <div className="row"><label className="field"><span>Deal</span><select className="input" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}><option value="pct">Percent off</option><option value="amount">Dollars off</option><option value="price">Set price</option></select></label>
            <label className="field grow"><span>{edit.kind === 'pct' ? 'Percent' : 'Amount'}</span><input className="input" inputMode="decimal" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></label></div>
          <div className="field"><span>Applies to</span><ItemChooser menu={menu} itemIds={edit.itemIds} categories={edit.categories} onChange={(v) => setEdit({ ...edit, ...v })} /></div>
          {edit.id && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />On</label>}
          <button className="btn primary lg block" disabled={!edit.name || !edit.days.length} onClick={save}>Save</button>
        </Modal>
      )}
    </section>
  );
}
function Specials() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [d, reload] = useLive(['menu'], () => api('/staff/specials'));
  const [menu] = useLive(['menu'], () => api('/staff/menu'));
  const [f, setF] = useState(null);
  if (!d || !menu) return null;
  const add = async () => { try { await api('/staff/specials', { method: 'POST', body: { itemId: Number(f.itemId), ...(f.repeat ? { dow: Number(f.dow) } : { day: f.day }), priceCents: f.price ? dollars(f.price) : null, note: f.note || undefined, specialOnly: f.specialOnly } }); setF(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const when = (s) => (s.day ? (s.day === today() ? 'Today' : new Date(`${s.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })) : `Every ${DAYS[s.dow]}`);
  return (
    <section className="panel">
      <div className="panel-h"><h3 className="grow">Specials</h3><button className="btn primary sm" onClick={() => setF({ itemId: menu[0]?.id, day: today(), repeat: false, dow: new Date().getDay(), price: '', note: '', specialOnly: false })}>Add a special</button></div>
      <div className="panel-b muted" style={{ fontSize: 14 }}>Specials show at the top of every menu, on the lobby screen and on your link page for the day, then disappear. Items marked "special only" are hidden on other days.</div>
      {d.upcoming.length > 0 && <table className="list"><tbody>{d.upcoming.map((s) => (
        <tr key={s.id}><td><b>{s.name}</b>{s.specialOnly && <span className="chip" style={{ marginLeft: 6 }}>Special only</span>}<div className="dim" style={{ fontSize: 12.5 }}>{s.note}</div></td><td>{when(s)}</td><td className="num">{s.price_cents !== null ? <><s className="dim">{money(s.regularCents, cur)}</s> {money(s.price_cents, cur)}</> : money(s.regularCents, cur)}</td>
          <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => api(`/staff/specials/${s.id}`, { method: 'DELETE' }).then(reload)}>Remove</button></td></tr>
      ))}</tbody></table>}
      {f && (
        <Modal title="Add a special" onClose={() => setF(null)} width={480}>
          <label className="field"><span>Item</span><select className="input" value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}>{menu.map((m) => <option key={m.id} value={m.id}>{m.name} ({money(m.price_cents, cur)})</option>)}</select></label>
          <div className="seg" style={{ width: '100%' }}><button aria-pressed={!f.repeat} onClick={() => setF({ ...f, repeat: false })} style={{ flex: 1 }}>One day</button><button aria-pressed={f.repeat} onClick={() => setF({ ...f, repeat: true })} style={{ flex: 1 }}>Every week</button></div>
          {f.repeat ? <label className="field"><span>Day</span><select className="input" value={f.dow} onChange={(e) => setF({ ...f, dow: e.target.value })}>{DAYS.map((x, i) => <option key={x} value={i}>{x}</option>)}</select></label> : <label className="field"><span>Date</span><input className="input" type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></label>}
          <div className="row"><label className="field grow"><span>Special price (blank = regular)</span><input className="input" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label></div>
          <label className="field"><span>Note (optional)</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={120} placeholder="Chef's pick, only 20 made" /></label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.specialOnly} onChange={(e) => setF({ ...f, specialOnly: e.target.checked })} />Only sell this item on its special days</label>
          <button className="btn primary lg block" onClick={add}>Add special</button>
        </Modal>
      )}
    </section>
  );
}
function Combos() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [list, reload] = useLive(['menu'], () => api('/staff/combos'));
  const [menu] = useLive(['menu'], () => api('/staff/menu'));
  const [edit, setEdit] = useState(null);
  if (!list || !menu) return null;
  const save = async () => { try { await api(edit.id ? `/staff/combos/${edit.id}` : '/staff/combos', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, description: edit.description || undefined, priceCents: dollars(edit.price), slots: edit.slots, online: edit.online, active: edit.active } }); setEdit(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const regular = (c) => c.slots.reduce((a, s) => { const opts = menu.filter((m) => s.itemIds.includes(m.id) || s.categories.includes(m.category)); return a + (opts.length ? Math.min(...opts.map((m) => m.price_cents)) : 0); }, 0);
  return (
    <section className="panel">
      <div className="panel-h"><h3 className="grow">Combos</h3><button className="btn primary sm" onClick={() => setEdit({ name: '', description: '', price: '', online: true, slots: [{ label: 'Main', itemIds: [], categories: [] }, { label: 'Side', itemIds: [], categories: [] }, { label: 'Drink', itemIds: [], categories: [] }] })}>New combo</button></div>
      {list.length === 0 ? <div className="panel-b muted">No combos yet. A combo has a set price and a choice for each part, like a main, a side and a drink.</div> : (
        <table className="list"><tbody>{list.map((c) => (
          <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}><td><b>{c.name}</b><div className="dim" style={{ fontSize: 12.5 }}>{c.slots.map((s) => s.label).join(' + ')}</div></td><td className="num">{money(c.priceCents, cur)}<div className="dim" style={{ fontSize: 12 }}>saves from {money(Math.max(0, regular(c) - c.priceCents), cur)}</div></td><td>{c.online ? <span className="chip teal">Online too</span> : <span className="chip">Register only</span>}</td>
            <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setEdit({ ...c, price: (c.priceCents / 100).toFixed(2) })}>Edit</button></td></tr>
        ))}</tbody></table>
      )}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New combo'} onClose={() => setEdit(null)} width={600}>
          <div className="row"><label className="field grow"><span>Name</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={40} placeholder="Lunch combo" /></label><label className="field"><span>Price</span><input className="input" style={{ width: 110 }} inputMode="decimal" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></label></div>
          <label className="field"><span>Description (optional)</span><input className="input" value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} maxLength={200} /></label>
          {edit.slots.map((s, k) => (
            <div key={k} className="card stack" style={{ gap: 6 }}>
              <div className="row"><input className="input grow" value={s.label} onChange={(e) => setEdit({ ...edit, slots: edit.slots.map((x, i) => (i === k ? { ...x, label: e.target.value } : x)) })} maxLength={30} aria-label="Part name" />{edit.slots.length > 2 && <button className="btn sm ghost" onClick={() => setEdit({ ...edit, slots: edit.slots.filter((_, i) => i !== k) })}>Remove</button>}</div>
              <ItemChooser menu={menu} itemIds={s.itemIds} categories={s.categories} onChange={(v) => setEdit({ ...edit, slots: edit.slots.map((x, i) => (i === k ? { ...x, ...v } : x)) })} />
            </div>
          ))}
          {edit.slots.length < 6 && <button className="btn" onClick={() => setEdit({ ...edit, slots: [...edit.slots, { label: 'Extra', itemIds: [], categories: [] }] })}>Add a part</button>}
          <span className="dim" style={{ fontSize: 12.5 }}>Paid options (like bacon) are added on top of the combo price. Each item still goes to the kitchen and comes off stock.</span>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.online} onChange={(e) => setEdit({ ...edit, online: e.target.checked })} />Offer online, on the kiosk and on table QR menus</label>
          {edit.id && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />On</label>}
          <button className="btn primary lg block" disabled={!edit.name || !dollars(edit.price)} onClick={save}>Save combo</button>
        </Modal>
      )}
    </section>
  );
}

/* ================= Register helpers: combos, goal bar, display push ================= */
export function useLiveCombos() {
  const [c] = useLive(['menu'], () => api('/staff/combos/live').catch(() => []));
  return c || [];
}
export function GoalBar() {
  const { settings } = useCC();
  const [d] = useLive(['orders', 'goals'], () => api('/staff/goals').catch(() => null));
  if (!d || (!d.goal && !d.contests.length)) return null;
  return (
    <div className="goal-bar">
      {d.goal && <div className="grow" title={`${money(d.goal.soldCents, settings.currency)} of ${money(d.goal.goalCents, settings.currency)}`}>
        <div className="row" style={{ fontSize: 12.5 }}><span className="grow">{d.goal.pct >= 100 ? 'Goal hit today!' : "Today's goal"}</span><span className="num">{money(d.goal.soldCents, settings.currency)} / {money(d.goal.goalCents, settings.currency)}</span></div>
        <div className="meter"><i style={{ width: `${d.goal.pct}%` }} /></div></div>}
      {d.contests.map((c) => <span key={c.id} className="chip amber" title={c.top.map((x) => `${x.rank}. ${x.name}`).join('  ')}>{c.name}: {c.me ? `you're #${c.me.rank}` : 'not on the board yet'}{c.top[0] && (!c.me || c.me.rank !== 1) ? `, ${c.top[0].name} leads` : ''}</span>)}
    </div>
  );
}
export function useDisplayPush(payload) {
  const code = (() => { try { return localStorage.getItem('bh_display') || ''; } catch { return ''; } })();
  const json = JSON.stringify(payload);
  const last = useRef('');
  useEffect(() => {
    if (!code || json === last.current) return undefined;
    const t = setTimeout(() => { last.current = json; api('/staff/display/push', { method: 'POST', body: { code, ...payload } }).catch(() => {}); }, 250);
    return () => clearTimeout(t);
  }, [json, code]); // eslint-disable-line react-hooks/exhaustive-deps
  return code;
}
export function PairDisplay({ onClose }) {
  const [code, setCode] = useState(() => { try { return localStorage.getItem('bh_display') || ''; } catch { return ''; } });
  const save = (v) => { try { if (v) localStorage.setItem('bh_display', v); else localStorage.removeItem('bh_display'); } catch { /* private */ } onClose(); };
  return (
    <Modal title="Customer display" onClose={onClose} width={400}>
      <span className="muted">Type the 4-digit code shown on the customer display. A manager starts the display from Settings on that screen.</span>
      <input className="input" inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ fontSize: 28, textAlign: 'center', letterSpacing: 8 }} aria-label="Display code" />
      <button className="btn primary lg block" disabled={code.length !== 4} onClick={() => save(code)}>Pair this register</button>
      <button className="btn ghost block" onClick={() => save('')}>Unpair</button>
    </Modal>
  );
}

/* ================= Customer display (second screen) ================= */
export function CustomerDisplay() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    let stop = false; let v = -1;
    const loop = async () => {
      while (!stop) {
        try { const x = await api(`/display?v=${v}`, { headers: { 'X-Display': localStorage.getItem('bh_display_token') || '' } }); v = x.v; setD(x); setErr(''); applyAccent(x.business.accent); }
        catch (e) { setErr(e.message); if (e.status === 401) return; await new Promise((r) => setTimeout(r, 3000)); }
      }
    };
    loop(); navigator.wakeLock?.request('screen').catch(() => {});
    return () => { stop = true; };
  }, []);
  if (err && !d) return <div className="lobby"><div className="lobby-msg"><h1>{err}</h1><a className="btn" href="/">Open the command center</a></div></div>;
  if (!d) return <div className="lobby" />;
  const s = d.state; const cur = d.currency;
  const tip = (body) => api('/display/tip', { method: 'POST', body, headers: { 'X-Display': localStorage.getItem('bh_display_token') || '' } }).then(() => setCustom(false)).catch(() => {});
  return (
    <div className="lobby cdisp">
      <header className="lobby-top">{d.business.logo ? <img src={d.business.logo} alt="" /> : <Puck state="buzzed" size={40} />}<b>{d.business.name}</b><span className="grow" />{s.stage === 'idle' && <span className="dim" style={{ fontSize: '2vh' }}>Display {d.code}</span>}</header>
      {s.stage === 'idle' && <div className="lobby-msg"><h1 style={{ fontSize: '6vh' }}>Welcome!</h1></div>}
      {s.stage === 'paid' && <div className="lobby-msg"><h1 style={{ fontSize: '7vh' }}>Thank you!</h1><p style={{ fontSize: '3vh' }}>{s.message || 'See you again soon.'}</p></div>}
      {(s.stage === 'cart' || s.stage === 'tip') && (
        <div className="cdisp-grid">
          <section className="cdisp-lines">{s.lines.map((l, i) => <div key={i} className="row"><span className="num" style={{ width: '3em' }}>{l.qty}</span><span className="grow">{l.name}</span><span className="num">{money(l.cents, cur)}</span></div>)}</section>
          <section className="cdisp-tot">
            {s.discountCents > 0 && <div className="row"><span className="grow">Discount</span><span className="num">−{money(s.discountCents, cur)}</span></div>}
            <div className="row"><span className="grow">Tax</span><span className="num">{money(s.taxCents, cur)}</span></div>
            <div className="row big"><span className="grow">Total</span><span className="num">{money(s.totalCents, cur)}</span></div>
            {s.stage === 'tip' && (
              <div className="stack">
                <b style={{ fontSize: '3vh' }}>Add a tip?</b>
                <div className="cdisp-tips">{d.tips.map((p) => <button key={p} className="btn lg" onClick={() => tip({ pct: p })}><b>{p}%</b><small>{money(Math.round((s.tipBaseCents ?? s.totalCents) * p / 100), cur)}</small></button>)}</div>
                {custom ? <form className="row" onSubmit={(e) => { e.preventDefault(); tip({ cents: dollars(e.target.amt.value) }); }}><input name="amt" className="input grow" inputMode="decimal" autoFocus placeholder="Amount" /><button className="btn primary lg">Add</button></form>
                  : <div className="row"><button className="btn lg grow" onClick={() => setCustom(true)}>Other amount</button><button className="btn lg grow ghost" onClick={() => tip({ pct: 0 })}>No tip</button></div>}
                {s.tipChosen && <span className="dim">Tip sent to the cashier.</span>}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/* ================= Recipe card (kitchen + menu) ================= */
export function RecipeCard({ itemId, onClose }) {
  const { can } = useCC(); const toast = useToast();
  const [d, setD] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => api(`/staff/menu/${itemId}/card`).then(setD).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  const save = async () => { try { await api(`/staff/menu/${itemId}/card`, { method: 'PUT', body: { steps: edit.steps.split('\n').map((x) => x.trim()).filter(Boolean), photo: edit.photo } }); setEdit(null); load(); } catch (e) { toast(e.message, 'err'); } };
  const pickPhoto = async (file) => { if (!file) return; try { setEdit({ ...edit, photo: await imageToPng(file, 900) }); } catch { toast('Could not read that image', 'err'); } };
  return (
    <Modal title={`How to make: ${d.name}`} onClose={onClose} width={560}>
      {edit ? (
        <>
          <label className="field"><span>Steps, one per line</span><textarea className="input" rows={8} value={edit.steps} onChange={(e) => setEdit({ ...edit, steps: e.target.value })} /></label>
          <label className="field"><span>Photo of the finished plate</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pickPhoto(e.target.files?.[0])} /></label>
          {d.photo && <button className="btn ghost sm" onClick={() => setEdit({ ...edit, photo: null })}>Remove photo</button>}
          <button className="btn primary lg block" onClick={save}>Save card</button>
        </>
      ) : (
        <>
          {d.photo && <img src={d.photo} alt={d.name} style={{ width: '100%', borderRadius: 12, maxHeight: 280, objectFit: 'cover' }} />}
          {d.allergens.length > 0 && <div className="ticket-allergy">Contains: {d.allergens.join(', ')}</div>}
          {d.steps.length ? <ol className="steps-list">{d.steps.map((x, i) => <li key={i}>{x}</li>)}</ol> : <span className="muted">No steps yet.{can('manager') ? ' Add them so anyone can make it the same way.' : ''}</span>}
          {d.recipe.length > 0 && <div className="field"><span>Portions</span><div className="row wrap" style={{ gap: 6 }}>{d.recipe.map((r) => <span key={r.name} className="chip">{r.qty} {r.unit} {r.name}</span>)}</div></div>}
          {can('manager') && <button className="btn block" onClick={() => setEdit({ steps: d.steps.join('\n'), photo: undefined })}>Edit card</button>}
        </>
      )}
    </Modal>
  );
}

/* ================= Training ================= */
export function Training() {
  const { can, user } = useCC(); const toast = useToast();
  const [mine, reloadMine] = useLive(['training'], () => api('/staff/training/me'));
  const [all, reloadAll] = useLive(['training'], () => (can('manager') ? api('/staff/training') : Promise.resolve(null)));
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);
  const [card, setCard] = useState(null);
  if (!mine) return null;
  const done = mine.filter((m) => m.signedAt).length;
  const save = async () => { try { await api(edit.id ? `/staff/training/${edit.id}` : '/staff/training', { method: edit.id ? 'PUT' : 'POST', body: { title: edit.title, body: edit.body, roles: edit.roles, required: edit.required, active: edit.active } }); setEdit(null); reloadAll(); reloadMine(); } catch (e) { toast(e.message, 'err'); } };
  const sign = (moduleId, userId, undo) => api(`/staff/training/${moduleId}/signoff`, { method: 'POST', body: { userId, undo } }).then(() => { reloadAll(); reloadMine(); }).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <PageHead title="Training" sub={`Read each lesson, then a manager signs you off. ${done} of ${mine.length} signed off for you.`}>
        {can('manager') && <button className="btn" onClick={() => api('/staff/training/from-menu', { method: 'POST' }).then((r) => { toast(`${r.added} lesson${r.added === 1 ? '' : 's'} added from recipe cards`, 'ok'); reloadAll(); reloadMine(); })}>Add lessons from recipe cards</button>}
        {can('manager') && <button className="btn primary" onClick={() => setEdit({ title: '', body: '', roles: ['staff', 'manager'], required: true })}>New lesson</button>}
      </PageHead>
      <div className="grid-2">
        <section className="panel"><div className="panel-h"><h3>My lessons</h3></div>
          {mine.length === 0 ? <div className="panel-b muted">No lessons yet.</div> : <table className="list"><tbody>{mine.map((m) => (
            <tr key={m.id}><td><button className="btn ghost sm" style={{ padding: 0 }} onClick={() => setOpen(m)}><b>{m.title}</b></button></td>
              <td>{m.signedAt ? <span className="chip teal">Signed off</span> : m.readAt ? <span className="chip amber">Read, waiting for sign-off</span> : <span className="chip">Not started</span>}</td></tr>
          ))}</tbody></table>}
        </section>
        {all && <section className="panel"><div className="panel-h"><h3>Team progress</h3></div>
          <table className="list"><tbody>{all.people.filter((p) => p.total).map((p) => (
            <tr key={p.id}><td><b>{p.name}</b><div className="meter" style={{ marginTop: 4 }}><i style={{ width: `${Math.round(p.signed * 100 / p.total)}%` }} /></div></td><td className="num">{p.signed} of {p.total}</td>
              <td><details><summary className="btn sm ghost">Sign off</summary><div className="stack" style={{ gap: 4, marginTop: 6 }}>{p.items.map((it) => (
                <label key={it.moduleId} className="row" style={{ fontSize: 13 }}><input type="checkbox" checked={Boolean(it.signedAt)} disabled={p.id === user.id && user.role !== 'owner'} onChange={(e) => sign(it.moduleId, p.id, !e.target.checked)} />{it.title}{it.readAt && !it.signedAt && <span className="dim">(read)</span>}</label>
              ))}</div></details></td></tr>
          ))}</tbody></table>
          <div className="panel-b stack" style={{ gap: 4 }}>{all.modules.map((m) => <div key={m.id} className="row" style={{ fontSize: 13.5 }}><span className="grow" style={{ opacity: m.active ? 1 : 0.5 }}>{m.title}</span><button className="btn sm ghost" onClick={() => setEdit({ ...m, required: Boolean(m.required), active: Boolean(m.active) })}>Edit</button></div>)}</div>
        </section>}
      </div>
      {open && (
        <Modal title={open.title} onClose={() => setOpen(null)} width={560}>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{open.body || 'No text yet.'}</div>
          {open.itemId && <button className="btn" onClick={() => setCard(open.itemId)}>Open the recipe card</button>}
          {!open.readAt && <button className="btn primary lg block" onClick={() => api(`/staff/training/${open.id}/read`, { method: 'POST' }).then(() => { setOpen(null); reloadMine(); reloadAll(); })}>I've read this</button>}
        </Modal>
      )}
      {card && <RecipeCard itemId={card} onClose={() => setCard(null)} />}
      {edit && (
        <Modal title={edit.id ? 'Edit lesson' : 'New lesson'} onClose={() => setEdit(null)} width={560}>
          <label className="field"><span>Title</span><input className="input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} maxLength={80} placeholder="Opening the register" /></label>
          <label className="field"><span>Lesson</span><textarea className="input" rows={10} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
          <div className="field"><span>Who needs it</span><div className="row">{['staff', 'manager'].map((r) => <label key={r} className="row" style={{ fontSize: 14, textTransform: 'capitalize' }}><input type="checkbox" checked={edit.roles.includes(r)} onChange={(e) => setEdit({ ...edit, roles: e.target.checked ? [...edit.roles, r] : edit.roles.filter((x) => x !== r) })} />{r}</label>)}</div></div>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.required} onChange={(e) => setEdit({ ...edit, required: e.target.checked })} />Required (counts toward progress)</label>
          {edit.id && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />On</label>}
          <button className="btn primary lg block" disabled={!edit.title || !edit.roles.length} onClick={save}>Save</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Price watch (tab in Purchasing) ================= */
export function PriceWatch() {
  const { settings } = useCC(); const cur = settings.currency;
  const [d] = useLive(['menu'], () => api('/staff/price-watch'));
  if (!d) return null;
  const c2 = (c) => money(Math.round(c), cur);
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>Every change to an ingredient's cost in the last 90 days. Managers get an alert when a cost goes up {d.thresholdPct}% or more.</p>
      {d.changes.length === 0 ? <div className="panel empty"><b>No cost changes yet</b><span>When you update a cost or receive a supplier order at a new price, it shows here with the dishes it affects.</span></div> : (
        <div className="stack">{d.changes.map((x) => (
          <section key={x.id} className="panel"><div className="panel-h"><h3 className="grow">{x.name}</h3><span className="muted num">{c2(x.oldCents)} → {c2(x.newCents)} per {x.unit}</span>{x.pct !== null && <span className={`chip ${x.pct > 0 ? 'rose' : 'teal'}`}>{x.pct > 0 ? '+' : ''}{x.pct}%</span>}<span className="dim" style={{ fontSize: 12 }}>{new Date(`${x.at.replace(' ', 'T')}Z`).toLocaleDateString()}</span></div>
            {x.dishes.length > 0 && <table className="list"><thead><tr><th>Dish</th><th>Price</th><th>Cost before</th><th>Cost now</th><th>Profit lost each</th><th>Margin</th></tr></thead><tbody>{x.dishes.map((d2) => (
              <tr key={d2.id}><td>{d2.name}</td><td className="num">{money(d2.priceCents, cur)}</td><td className="num muted">{c2(d2.costBefore)}</td><td className="num">{c2(d2.costNow)}</td><td className="num">{c2(d2.lostCents)}</td><td className="num">{d2.marginPctBefore}% → <b style={{ color: d2.marginPctNow < 65 ? 'var(--dirty)' : undefined }}>{d2.marginPctNow}%</b></td></tr>
            ))}</tbody></table>}
          </section>
        ))}</div>
      )}
    </>
  );
}

/* ================= Goals and contests ================= */
export function Goals() {
  const { settings, reloadSettings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [list, reload] = useLive(['orders', 'goals'], () => api('/staff/contests'));
  const [menu] = useLive(['menu'], () => api('/staff/menu'));
  const [goals, setGoals] = useState(() => { try { const a = JSON.parse(settings.sales_goals || '[]'); return DAYS.map((_, i) => (a[i] ? (a[i] / 100).toFixed(0) : '')); } catch { return DAYS.map(() => ''); } });
  const [edit, setEdit] = useState(null);
  if (!list || !menu) return null;
  const saveGoals = () => api('/staff/settings', { method: 'PUT', body: { sales_goals: JSON.stringify(goals.map((g) => dollars(g || 0))) } }).then(() => { reloadSettings?.(); toast('Goals saved', 'ok'); }).catch((e) => toast(e.message, 'err'));
  const metricName = { items: 'Items sold', sales: 'Sales', avg_ticket: 'Average ticket', orders: 'Orders rung' };
  const score = (c, v) => (c.metric === 'sales' || c.metric === 'avg_ticket' ? money(v, cur) : v);
  const save = async () => { try { await api(edit.id ? `/staff/contests/${edit.id}` : '/staff/contests', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, metric: edit.metric, itemIds: edit.itemIds, categories: edit.categories, starts: edit.starts, ends: edit.ends, prize: edit.prize || undefined, active: edit.active } }); setEdit(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <>
      <PageHead title="Goals and contests" sub="A daily sales target shows on the register for everyone. Contests rank staff by what they sell.">
        <button className="btn primary" onClick={() => setEdit({ name: '', metric: 'items', itemIds: [], categories: [], starts: today(), ends: today(), prize: '' })}>New contest</button>
      </PageHead>
      <section className="panel" style={{ marginBottom: 18 }}><div className="panel-h"><h3 className="grow">Daily sales goal</h3><button className="btn sm primary" onClick={saveGoals}>Save goals</button></div>
        <div className="panel-b row wrap">{DAYS.map((x, i) => <label key={x} className="field" style={{ width: 100 }}><span>{x}</span><input className="input" inputMode="numeric" placeholder="Off" value={goals[i]} onChange={(e) => setGoals(goals.map((g, k) => (k === i ? e.target.value.replace(/\D/g, '') : g)))} /></label>)}</div>
        <div className="panel-b dim" style={{ fontSize: 12.5, paddingTop: 0 }}>In whole {cur}, before tax and tips. The team gets a notification when the day's goal is hit.</div>
      </section>
      <div className="grid-2">{list.map((c) => (
        <section key={c.id} className="panel" style={{ opacity: c.active ? 1 : 0.55 }}>
          <div className="panel-h"><h3 className="grow">{c.name}</h3>{c.starts <= today() && c.ends >= today() && c.active ? <span className="chip teal">Running</span> : c.ends < today() ? <span className="chip">Finished</span> : <span className="chip amber">Upcoming</span>}<button className="btn sm ghost" onClick={() => setEdit({ ...c, itemIds: c.item_ids, active: Boolean(c.active) })}>Edit</button></div>
          <div className="panel-b stack" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 13 }}>{metricName[c.metric]}, {c.starts} to {c.ends}{c.prize ? `. Prize: ${c.prize}` : ''}</span>
            {c.board.length === 0 ? <span className="dim">No sales counted yet.</span> : c.board.slice(0, 8).map((b) => <div key={b.userId} className="row"><b className="num" style={{ width: 24 }}>{b.rank}</b><span className="grow">{b.name}</span><span className="num">{score(c, b.score)}</span></div>)}
          </div>
        </section>
      ))}</div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New contest'} onClose={() => setEdit(null)} width={560}>
          <label className="field"><span>Name</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={60} placeholder="Most desserts this week" /></label>
          <label className="field"><span>Rank by</span><select className="input" value={edit.metric} onChange={(e) => setEdit({ ...edit, metric: e.target.value })}>{Object.entries(metricName).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {edit.metric === 'items' && <div className="field"><span>Which items count</span><ItemChooser menu={menu} itemIds={edit.itemIds} categories={edit.categories} onChange={(v) => setEdit({ ...edit, ...v })} /></div>}
          <div className="row"><label className="field grow"><span>Starts</span><input className="input" type="date" value={edit.starts} onChange={(e) => setEdit({ ...edit, starts: e.target.value })} /></label><label className="field grow"><span>Ends</span><input className="input" type="date" value={edit.ends} onChange={(e) => setEdit({ ...edit, ends: e.target.value })} /></label></div>
          <label className="field"><span>Prize (optional)</span><input className="input" value={edit.prize || ''} onChange={(e) => setEdit({ ...edit, prize: e.target.value })} maxLength={80} placeholder="$25 gift card, first pick of shifts" /></label>
          {edit.id && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />On</label>}
          <button className="btn primary lg block" disabled={!edit.name} onClick={save}>Save contest</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Settings panel ================= */
export function FloorPanel({ f, setF }) {
  const toast = useToast();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const startDisplay = async () => { try { const r = await api('/staff/display/start', { method: 'POST' }); localStorage.setItem('bh_display_token', r.token); location.href = `/display${r.loc && r.loc !== 'main' ? `?l=${r.loc}` : ''}`; } catch (e) { toast(e.message, 'err'); } };
  return (
    <section className="panel"><div className="panel-h"><h3>Customer display, timers, labor and scheduling</h3></div><div className="panel-b stack">
      <span className="muted" style={{ fontSize: 14 }}>A customer display is a second screen (a tablet or monitor) facing the customer. It shows the order as you ring it up and lets them pick a tip. Open this on that screen, then type its code on the register.</span>
      <div className="row"><button className="btn primary grow" onClick={startDisplay}>Make this device a customer display</button><button className="btn grow" onClick={() => api('/staff/display/signout-all', { method: 'POST' }).then(() => toast('All customer displays signed out', 'ok'))}>Sign out all displays</button></div>
      <div className="row">
        <label className="field grow"><span>Alert when a table is seated longer than (minutes, 0 = off)</span><input className="input" type="number" min={0} max={600} value={f.table_long_minutes} onChange={set('table_long_minutes')} /></label>
        <label className="field grow"><span>Alert when an order is cooking longer than (minutes, 0 = off)</span><input className="input" type="number" min={0} max={240} value={f.kitchen_slow_minutes} onChange={set('kitchen_slow_minutes')} /></label>
      </div>
      <label className="field"><span>Alert when an ingredient's cost goes up by (%)</span><input className="input" type="number" min={1} max={100} value={f.price_watch_pct} onChange={set('price_watch_pct')} /></label>
      <div className="row"><label className="field grow"><span>Labor target (% of sales)</span><input className="input" type="number" min={5} max={80} value={f.labor_target_pct} onChange={set('labor_target_pct')} /></label>
        <label className="field grow"><span>Each booking holds a table for (minutes)</span><input className="input" type="number" min={15} max={600} value={f.booking_duration_minutes} onChange={set('booking_duration_minutes')} /></label></div>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.labor_alerts === '1'} onChange={(e) => setF({ ...f, labor_alerts: e.target.checked ? '1' : '0' })} /> Alert managers when labor runs well over target</label>
      <div className="row"><label className="row grow" style={{ fontSize: 14 }}><input type="checkbox" checked={f.online_schedule === '1'} onChange={(e) => setF({ ...f, online_schedule: e.target.checked ? '1' : '0' })} /> Let online customers order for a later time</label>
        <label className="field"><span>Up to (days ahead)</span><input className="input" style={{ width: 90 }} type="number" min={1} max={60} value={f.online_schedule_days} onChange={set('online_schedule_days')} /></label>
        <label className="field"><span>Labels: items keep (days)</span><input className="input" style={{ width: 90 }} type="number" min={0} max={365} value={f.label_shelf_days} onChange={set('label_shelf_days')} /></label></div>
    </div></section>
  );
}

export function FireButton({ orderId, held, onDone }) {
  const toast = useToast();
  if (!held) return null;
  return <button className="btn sm primary" onClick={() => api(`/staff/orders/${orderId}/fire-course`, { method: 'POST', body: {} }).then((r) => { toast(`${r.fired} held item${r.fired === 1 ? '' : 's'} fired`, 'ok'); onDone?.(); }).catch((e) => toast(e.message, 'err'))}><Icon name="flame" size={14} />Fire {held} held</button>;
}
