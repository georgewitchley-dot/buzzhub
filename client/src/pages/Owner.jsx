import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { SupplierCredits } from './Desk.jsx';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);
const today = () => new Date().toLocaleDateString('en-CA');
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
const pj = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const when = (sql) => new Date(`${sql.replace(' ', 'T')}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fileToDataUrl = (file) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });

/* ================= Order again (customer account) ================= */
export function AccountOrders({ t = (x) => x }) {
  const nav = useNavigate();
  const [list, setList] = useState(null);
  useEffect(() => { api('/c/orders').then(setList).catch(() => {}); }, []);
  if (!list?.length) return null;
  const again = (o) => { try { localStorage.setItem('bh_reorder', JSON.stringify(o.items)); } catch { /* private */ } nav(`/order${location.search}`); };
  return (
    <div className="card stack">
      <b>{t('Your past orders')}</b>
      {list.slice(0, 5).map((o) => (
        <div key={o.id} className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ fontSize: 14 }}><b>#{o.number}</b> <span className="dim">{new Date(`${o.created_at.replace(' ', 'T')}Z`).toLocaleDateString()}</span><div className="muted">{o.items.map((i) => `${i.qty} ${i.name}`).join(', ')}</div></div>
          {o.items.length > 0 && <button className="btn sm primary" onClick={() => again(o)}>{t('Order again')}</button>}
        </div>
      ))}
    </div>
  );
}
/** On the online order page: add a saved reorder to the cart, skipping anything no longer offered. */
export function useReorder(items, cart, onSkipped) {
  useEffect(() => {
    if (!items) return;
    let saved = null; try { saved = JSON.parse(localStorage.getItem('bh_reorder') || 'null'); localStorage.removeItem('bh_reorder'); } catch { /* none */ }
    if (!saved?.length) return;
    const byId = Object.fromEntries(items.map((i) => [i.id, i])); let skipped = 0;
    for (const l of saved) {
      const m = byId[l.itemId]; if (!m || m.soldOut) { skipped += 1; continue; }
      const opts = (m.groups || []).flatMap((g) => g.options); const mods = (l.mods || []).filter((id) => opts.some((o) => o.id === id));
      const okGroups = (m.groups || []).every((g) => { const n = g.options.filter((o) => mods.includes(o.id)).length; return n >= g.min && n <= g.max; });
      if (!okGroups) { skipped += 1; continue; }
      const extra = opts.filter((o) => mods.includes(o.id)).reduce((a, o) => a + o.price_cents, 0);
      cart.add({ itemId: m.id, qty: l.qty, mods, note: l.note || undefined, name: m.name, modNames: opts.filter((o) => mods.includes(o.id)).map((o) => o.name), unitCents: m.price_cents + extra });
    }
    if (skipped) onSkipped?.();
  }, [Boolean(items)]); // eslint-disable-line react-hooks/exhaustive-deps
}

/* ================= Tip-outs by role ================= */
export function TipOuts() {
  const { settings, reloadSettings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [range, setRange] = useState({ from: addDays(today(), -6), to: today() });
  const [d, reload] = useLive(['shifts', 'orders'], () => api(`/staff/tipouts?from=${range.from}&to=${range.to}`), [range.from, range.to]);
  const [rules, setRules] = useState(() => pj(settings.tipout_rules, []));
  if (!d) return null;
  const roleName = (r) => r ? r[0].toUpperCase() + r.slice(1) : 'No tip-out';
  const saveRules = () => api('/staff/settings', { method: 'PUT', body: { tipout_rules: JSON.stringify(rules.filter((r) => r.from && r.to && Number(r.pct) > 0).map((r) => ({ ...r, pct: Number(r.pct) }))) } }).then(() => { reloadSettings?.(); toast('Tip-out rules saved', 'ok'); reload(); }).catch((e) => toast(e.message, 'err'));
  const setRole = (u, v) => api(`/staff/users/${u.id}/tip-role`, { method: 'PUT', body: { tipRole: v } }).then(reload).catch((e) => toast(e.message, 'err'));
  const csv = () => { const rows = [['Name', 'Role', 'Sales', 'Tips', 'Hours', 'Tips out', 'Tips in', 'Take home'], ...d.people.map((p) => [p.name, p.role, p.salesCents / 100, p.tipsCents / 100, p.hours, p.givesCents / 100, p.getsCents / 100, p.netCents / 100])]; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })); a.download = `tip-outs-${range.from}-to-${range.to}.csv`; a.click(); };
  return (
    <>
      <PageHead title="Tip-outs" sub="Servers keep their own tips and share a percent with bussers, bar and kitchen. Shares are split by hours worked.">
        <input className="input" type="date" style={{ width: 150 }} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
        <input className="input" type="date" style={{ width: 150 }} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
        <button className="btn" onClick={csv} disabled={!d.people.length}>Download CSV</button>
      </PageHead>
      <div className="grid-2" style={{ marginBottom: 18 }}>
        <section className="panel"><div className="panel-h"><h3 className="grow">Rules</h3><button className="btn sm primary" onClick={saveRules}>Save rules</button></div><div className="panel-b stack">
          {rules.map((r, i) => (
            <div key={i} className="row wrap" style={{ gap: 6, fontSize: 14 }}>
              <select className="input" style={{ width: 120 }} value={r.from} onChange={(e) => setRules(rules.map((x, k) => (k === i ? { ...x, from: e.target.value } : x)))} aria-label="Who gives">{d.roles.map((x) => <option key={x} value={x}>{roleName(x)}s</option>)}</select>
              <span>give</span><input className="input" style={{ width: 64 }} inputMode="decimal" value={r.pct} onChange={(e) => setRules(rules.map((x, k) => (k === i ? { ...x, pct: e.target.value } : x)))} aria-label="Percent" /><span>% of</span>
              <select className="input" style={{ width: 100 }} value={r.base || 'sales'} onChange={(e) => setRules(rules.map((x, k) => (k === i ? { ...x, base: e.target.value } : x)))} aria-label="Of what"><option value="sales">sales</option><option value="tips">tips</option></select><span>to</span>
              <select className="input" style={{ width: 120 }} value={r.to} onChange={(e) => setRules(rules.map((x, k) => (k === i ? { ...x, to: e.target.value } : x)))} aria-label="Who gets">{d.roles.map((x) => <option key={x} value={x}>{roleName(x)}s</option>)}</select>
              <button className="btn sm ghost" onClick={() => setRules(rules.filter((_, k) => k !== i))}>Remove</button>
            </div>
          ))}
          <button className="btn" onClick={() => setRules([...rules, { from: 'server', to: 'busser', pct: 2, base: 'sales' }])}>Add a rule</button>
          <span className="dim" style={{ fontSize: 12.5 }}>Common: servers give 1–3% of sales to bussers, 10% of tips to the bar. Use this or the tip pool, not both.</span>
        </div></section>
        <section className="panel"><div className="panel-h"><h3>Who does what</h3></div>
          <table className="list"><tbody>{d.team.map((u) => <tr key={u.id}><td>{u.name}</td><td><select className="input" style={{ height: 32 }} value={u.tip_role} onChange={(e) => setRole(u, e.target.value)} aria-label={`${u.name} tip role`}><option value="">No tip-out</option>{d.roles.map((x) => <option key={x} value={x}>{roleName(x)}</option>)}</select></td></tr>)}</tbody></table>
        </section>
      </div>
      <section className="panel">
        {d.people.length === 0 ? <div className="panel-b muted">Set roles and rules to see tip-outs for these days.</div> : (
          <table className="list"><thead><tr><th>Name</th><th>Role</th><th>Sales</th><th>Tips</th><th>Hours</th><th>Tips out</th><th>Tips in</th><th>Take home</th></tr></thead>
            <tbody>{d.people.map((p) => <tr key={p.userId}><td><b>{p.name}</b></td><td className="muted">{roleName(p.role)}</td><td className="num">{money(p.salesCents, cur)}</td><td className="num">{money(p.tipsCents, cur)}</td><td className="num">{p.hours}</td><td className="num">{p.givesCents ? `−${money(p.givesCents, cur)}` : '—'}</td><td className="num">{p.getsCents ? `+${money(p.getsCents, cur)}` : '—'}</td><td className="num"><b>{money(p.netCents, cur)}</b></td></tr>)}</tbody></table>
        )}
      </section>
    </>
  );
}

/* ================= Nutrition (Purchasing tab) ================= */
export function Nutrition() {
  const { reloadSettings } = useCC(); const toast = useToast();
  const [d, reload] = useLive(['menu'], () => api('/staff/nutrition'));
  if (!d) return null;
  const put = (path, body) => api(path, { method: 'PUT', body }).then(reload).catch((e) => toast(e.message, 'err'));
  const num = (v) => (v === '' ? null : Number(v));
  return (
    <>
      <label className="row" style={{ fontSize: 14, marginBottom: 12 }}><input type="checkbox" checked={d.show} onChange={(e) => api('/staff/settings', { method: 'PUT', body: { show_calories: e.target.checked ? '1' : '0' } }).then(() => { reloadSettings?.(); reload(); })} />Show calories on customer menus, the kiosk and labels</label>
      <div className="grid-2">
        <section className="panel"><div className="panel-h"><h3>Calories per ingredient unit</h3></div>
          {d.ingredients.length === 0 ? <div className="panel-b muted">Add ingredients and recipes to work out calories, or type them per dish.</div> : <table className="list"><tbody>{d.ingredients.map((g) => <tr key={g.id}><td>{g.name}</td><td className="muted">per {g.unit}</td><td><input className="input" style={{ width: 90, height: 32 }} inputMode="decimal" defaultValue={g.kcal ?? ''} onBlur={(e) => String(g.kcal ?? '') !== e.target.value && put(`/staff/ingredients/${g.id}/kcal`, { kcal: num(e.target.value) })} aria-label={`${g.name} calories`} /></td></tr>)}</tbody></table>}
        </section>
        <section className="panel"><div className="panel-h"><h3>Calories per dish</h3></div>
          <table className="list"><tbody>{d.items.map((m) => <tr key={m.id}><td>{m.name}<div className="dim" style={{ fontSize: 12 }}>{m.calories !== null ? 'Typed in' : m.computed !== null ? 'From the recipe' : m.hasRecipe ? 'Recipe missing some calories' : 'No recipe'}</div></td>
            <td><input className="input" style={{ width: 90, height: 32 }} inputMode="numeric" placeholder={m.computed ?? ''} defaultValue={m.calories ?? ''} onBlur={(e) => String(m.calories ?? '') !== e.target.value && put(`/staff/menu/${m.id}/calories`, { calories: num(e.target.value) })} aria-label={`${m.name} calories`} /></td></tr>)}</tbody></table>
        </section>
      </div>
      <p className="dim" style={{ fontSize: 12.5 }}>Typed-in numbers win over recipe math. Chains with 20 or more locations must post calories on menus; for everyone else it's optional.</p>
    </>
  );
}

/* ================= Manager log book ================= */
export function LogBook() {
  const { can } = useCC(); const toast = useToast();
  const [d, reload] = useLive(['logbook'], () => api('/staff/logbook?days=30'));
  const [f, setF] = useState({ kind: 'note', body: '', mustRead: false, audience: 'managers' });
  const [readers, setReaders] = useState(null);
  if (!d) return null;
  const add = () => api('/staff/logbook', { method: 'POST', body: f }).then(() => { setF({ ...f, body: '', mustRead: false }); reload(); }).catch((e) => toast(e.message, 'err'));
  const kinds = { note: 'Note', incident: 'Incident', maintenance: 'Maintenance', staffing: 'Staffing', guest: 'Guest', 86: '86 / out of' };
  const tone = { incident: 'rose', maintenance: 'amber', staffing: 'blue', guest: 'teal', 86: 'amber' };
  const byDay = d.reduce((a, e) => { (a[e.day] = a[e.day] || []).push(e); return a; }, {});
  return (
    <>
      <PageHead title="Log book" sub="Notes for the next shift: what happened, what's broken, who called out. Must-read notes stay flagged until each person opens them." />
      <section className="panel" style={{ marginBottom: 18 }}><div className="panel-b stack">
        <div className="row wrap" style={{ gap: 6 }}>{Object.entries(kinds).map(([k, l]) => <button key={k} className={`btn sm ${f.kind === k ? 'primary' : ''}`} onClick={() => setF({ ...f, kind: k })}>{l}</button>)}</div>
        <textarea className="input" rows={3} placeholder="What should the next shift know?" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={2000} />
        <div className="row wrap"><label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.mustRead} onChange={(e) => setF({ ...f, mustRead: e.target.checked })} />Must read</label>
          {can('manager') && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.audience === 'all'} onChange={(e) => setF({ ...f, audience: e.target.checked ? 'all' : 'managers' })} />Whole team can see it</label>}
          <span className="grow" /><button className="btn primary" disabled={!f.body.trim()} onClick={add}>Add to log</button></div>
      </div></section>
      {Object.keys(byDay).length === 0 && <div className="panel empty"><b>Nothing logged yet</b><span>Start each shift by reading the log and end it by writing one line.</span></div>}
      {Object.entries(byDay).map(([day, list]) => (
        <section key={day} className="panel" style={{ marginBottom: 12 }}><div className="panel-h"><h3>{day === today() ? 'Today' : new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</h3></div>
          <div className="panel-b stack">{list.map((e) => (
            <div key={e.id} className="stack" style={{ gap: 4, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,.06)', opacity: e.read || !e.must_read ? 1 : 1 }}>
              <div className="row" style={{ fontSize: 13 }}><span className={`chip ${tone[e.kind] || ''}`}>{kinds[e.kind]}</span>{e.must_read ? <span className={`chip ${e.read ? '' : 'rose'}`}>{e.read ? 'Read' : 'Must read'}</span> : null}{e.audience === 'all' && <span className="chip">Team</span>}<span className="grow" /><span className="dim">{e.by_name}, {when(e.created_at)}</span></div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 15 }}>{e.body}</div>
              <div className="row">{!e.read && <button className="btn sm primary" onClick={() => api(`/staff/logbook/${e.id}/read`, { method: 'POST' }).then(reload)}>Mark read</button>}{can('manager') && e.must_read ? <button className="btn sm ghost" onClick={() => api(`/staff/logbook/${e.id}/readers`).then(setReaders)}>Read by {e.reads}</button> : null}</div>
            </div>
          ))}</div>
        </section>
      ))}
      {readers && <Modal title="Read by" onClose={() => setReaders(null)} width={360}>{readers.length ? readers.map((r) => <div key={r.name} className="row"><span className="grow">{r.name}</span><span className="dim">{when(r.at)}</span></div>) : <span className="muted">Nobody yet.</span>}</Modal>}
    </>
  );
}
export function LogBanner() {
  const nav = useNavigate();
  const [d] = useLive(['logbook'], () => api('/staff/logbook/unread').catch(() => ({ n: 0 })));
  if (!d?.n) return null;
  return <div className="claims"><div className="row claim" role="status" style={{ cursor: 'pointer' }} onClick={() => nav('/logbook')}><Icon name="bell" size={16} /><span className="grow">{d.n} log note{d.n === 1 ? '' : 's'} to read before your shift.</span><button className="btn sm primary">Read now</button></div></div>;
}

/* ================= Equipment ================= */
export function Equipment() {
  const { settings, can } = useCC(); const cur = settings.currency; const toast = useToast();
  const [list, reload] = useLive(['equipment'], () => api('/staff/equipment'));
  const [edit, setEdit] = useState(null);
  const [open, setOpen] = useState(null);
  const [ev, setEv] = useState({ kind: 'issue', notes: '', cost: '' });
  const [detail, reloadDetail] = useLive(['equipment'], () => (open ? api(`/staff/equipment/${open}`) : Promise.resolve(null)), [open]);
  if (!list) return null;
  const save = () => api(edit.id ? `/staff/equipment/${edit.id}` : '/staff/equipment', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, location: edit.location || undefined, makeModel: edit.make_model || undefined, serial: edit.serial || undefined, vendor: edit.vendor || undefined, vendorPhone: edit.vendor_phone || undefined, warrantyUntil: edit.warranty_until || '', serviceEveryDays: edit.service_every_days ? Number(edit.service_every_days) : null, lastService: edit.last_service || '', notes: edit.notes || undefined } }).then(() => { setEdit(null); reload(); }).catch((e) => toast(e.message, 'err'));
  const logEv = () => api(`/staff/equipment/${open}/events`, { method: 'POST', body: { kind: ev.kind, notes: ev.notes || undefined, costCents: dollars(ev.cost) } }).then(() => { setEv({ kind: 'issue', notes: '', cost: '' }); reloadDetail(); reload(); }).catch((e) => toast(e.message, 'err'));
  const dueChip = (e) => (e.dueInDays === null ? null : e.dueInDays < 0 ? <span className="chip rose">Service {-e.dueInDays} days late</span> : e.dueInDays <= 14 ? <span className="chip amber">Service in {e.dueInDays} days</span> : <span className="chip">Next service {e.nextService}</span>);
  const F = (k, label, type = 'text', ph = '') => <label className="field grow"><span>{label}</span><input className="input" type={type} value={edit[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} placeholder={ph} /></label>;
  return (
    <>
      <PageHead title="Equipment" sub="Every machine with its service schedule, warranty, vendor and repair history. Anyone can report a problem; managers get an alert.">
        {can('manager') && <button className="btn primary" onClick={() => setEdit({ name: '' })}>Add equipment</button>}
      </PageHead>
      {list.length === 0 && <div className="panel empty"><b>No equipment yet</b><span>Add your fridges, ovens, fryers, ice and coffee machines to track service and repairs.</span></div>}
      <div className="grid-2">{list.map((e) => (
        <section key={e.id} className="panel" style={{ cursor: 'pointer' }} onClick={() => setOpen(e.id)}>
          <div className="panel-h"><h3 className="grow">{e.name}</h3>{e.openIssues > 0 && <span className="chip rose">{e.openIssues} open problem{e.openIssues === 1 ? '' : 's'}</span>}</div>
          <div className="panel-b stack" style={{ gap: 4, fontSize: 14 }}>
            <div className="row wrap" style={{ gap: 6 }}>{dueChip(e)}{e.warrantyOk === true && <span className="chip teal">Warranty to {e.warranty_until}</span>}{e.warrantyOk === false && <span className="chip">Warranty ended</span>}</div>
            {e.vendor && <span className="muted">{e.vendor}{e.vendor_phone ? `, ${e.vendor_phone}` : ''}</span>}
            {can('manager') && e.spentYearCents > 0 && <span className="dim">{money(e.spentYearCents, cur)} on repairs and service this year</span>}
          </div>
        </section>
      ))}</div>
      {open && detail && (
        <Modal title={detail.name} onClose={() => setOpen(null)} width={600}>
          <div className="row wrap" style={{ gap: 6 }}>{dueChip(detail)}{detail.location && <span className="chip">{detail.location}</span>}{detail.make_model && <span className="chip">{detail.make_model}</span>}{detail.serial && <span className="chip">SN {detail.serial}</span>}</div>
          {detail.vendor_phone && <a className="btn" href={`tel:${detail.vendor_phone.replace(/[^\d+]/g, '')}`}><Icon name="phone" size={16} />Call {detail.vendor || 'the vendor'}</a>}
          <div className="seg" style={{ width: '100%' }}>{[['issue', 'Report a problem'], ['service', 'Serviced'], ['repair', 'Repaired'], ['note', 'Note']].map(([k, l]) => <button key={k} aria-pressed={ev.kind === k} onClick={() => setEv({ ...ev, kind: k })} style={{ flex: 1 }}>{l}</button>)}</div>
          <div className="row"><input className="input grow" placeholder={ev.kind === 'issue' ? "What's wrong?" : 'What was done?'} value={ev.notes} onChange={(e) => setEv({ ...ev, notes: e.target.value })} maxLength={500} />{can('manager') && ev.kind !== 'issue' && ev.kind !== 'note' && <input className="input" style={{ width: 100 }} inputMode="decimal" placeholder="Cost" value={ev.cost} onChange={(e) => setEv({ ...ev, cost: e.target.value })} />}<button className="btn primary" onClick={logEv}>Save</button></div>
          <div className="stack" style={{ gap: 6, maxHeight: 280, overflow: 'auto' }}>{detail.events.map((x) => <div key={x.id} className="row" style={{ fontSize: 13.5 }}><span className={`chip ${x.kind === 'issue' ? (x.status === 'open' ? 'rose' : '') : x.kind === 'service' ? 'teal' : 'amber'}`}>{x.kind}</span><span className="grow">{x.notes}</span>{x.cost_cents > 0 && <span className="num">{money(x.cost_cents, cur)}</span>}<span className="dim">{x.by_name}, {when(x.at)}</span></div>)}</div>
          {can('manager') && <div className="row"><button className="btn ghost" onClick={() => { setEdit(detail); setOpen(null); }}>Edit details</button><button className="btn ghost" onClick={() => confirm(`Remove ${detail.name}?`) && api(`/staff/equipment/${detail.id}`, { method: 'DELETE' }).then(() => { setOpen(null); reload(); })}>Remove</button></div>}
        </Modal>
      )}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'Add equipment'} onClose={() => setEdit(null)} width={560}>
          <div className="row">{F('name', 'Name', 'text', 'Walk-in cooler')}{F('location', 'Where', 'text', 'Back of house')}</div>
          <div className="row">{F('make_model', 'Make and model')}{F('serial', 'Serial number')}</div>
          <div className="row">{F('vendor', 'Service company')}{F('vendor_phone', 'Their phone', 'tel')}</div>
          <div className="row">{F('service_every_days', 'Service every (days)', 'number', '90')}{F('last_service', 'Last serviced', 'date')}{F('warranty_until', 'Warranty until', 'date')}</div>
          <label className="field"><span>Notes</span><input className="input" value={edit.notes || ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} maxLength={500} /></label>
          <button className="btn primary lg block" disabled={!edit.name} onClick={save}>Save</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Loyalty tiers ================= */
export function TierChip({ customer }) {
  const { settings } = useCC();
  const [t, setT] = useState(null);
  useEffect(() => { if (customer?.id) api(`/staff/customers/${customer.id}/tier`).then(setT).catch(() => setT(null)); else setT(null); }, [customer?.id]);
  if (!t?.tier && !t?.next) return null;
  return <div className="row wrap" style={{ gap: 6, fontSize: 13 }}>{t.tier && <span className="chip amber">{t.tier.name}{t.tier.pct ? `: ${t.tier.pct}% off` : ''}</span>}{t.tier?.perk && <span className="dim">{t.tier.perk}</span>}{t.next && <span className="dim">{money(t.next.needCents, settings.currency)} more to {t.next.name}</span>}</div>;
}
export function AccountTier() {
  const [d, setD] = useState(null);
  useEffect(() => { api('/c/tier').then(setD).catch(() => {}); }, []);
  if (!d?.tiers?.length || !d.me) return null;
  const top = Math.max(...d.tiers.map((x) => x.minCents));
  return (
    <div className="card stack">
      <div className="row"><b className="grow">{d.me.tier ? `${d.me.tier.name} member` : 'Member levels'}</b>{d.me.tier?.pct ? <span className="chip amber">{d.me.tier.pct}% off every visit</span> : null}</div>
      <div className="meter"><i style={{ width: `${Math.min(100, d.me.spentCents / top * 100)}%` }} /></div>
      <span className="muted" style={{ fontSize: 14 }}>{money(d.me.spentCents)} spent in the last 12 months.{d.me.next ? ` ${money(d.me.next.needCents)} more to reach ${d.me.next.name}.` : ' You are at the top level. Thank you!'}</span>
      {d.me.tier?.perk && <span style={{ fontSize: 14 }}>Your perk: {d.me.tier.perk}</span>}
    </div>
  );
}

/* ================= Call server (floor + kitchen) ================= */
export function TableCalls() {
  const { settings } = useCC();
  const [list, reload] = useLive(['tables'], () => api('/staff/table-calls').catch(() => []));
  if (!list?.length) return null;
  const label = { server: 'needs their server', check: 'wants the check', water: 'would like water', help: 'needs help' };
  return (
    <div className="claims"><div className="row claim" role="status" style={{ background: 'color-mix(in srgb, var(--dirty) 18%, transparent)', flexWrap: 'wrap' }}>
      <Icon name="bell" size={16} /><span className="grow">{list.map((c) => `${settings.unit_label} ${c.label} ${label[c.kind]} (${Math.max(0, Math.round((Date.now() - Date.parse(`${c.at.replace(' ', 'T')}Z`)) / 60000))}m)`).join(' · ')}</span>
      {list.map((c) => <button key={c.id} className="btn sm primary" onClick={() => api(`/staff/table-calls/${c.id}/ack`, { method: 'POST' }).then(reload)}>{settings.unit_label} {c.label}: on it</button>)}
    </div></div>
  );
}

/* ================= Weekly report ================= */
export function WeeklyReport() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [week, setWeek] = useState('');
  const [d] = useLive([], () => api(`/staff/weekly-report${week ? `?week=${week}` : ''}`), [week]);
  if (!d) return null;
  const n = d.now; const p = d.prev;
  const delta = (a, b) => (b ? Math.round((a - b) / b * 1000) / 10 : null);
  const Row = ({ label, a, b, fmt = (x) => money(x, cur), invert = false }) => { const ch = typeof a === 'number' && typeof b === 'number' ? delta(a, b) : null; const good = ch === null ? null : invert ? ch < 0 : ch > 0; return <tr><td>{label}</td><td className="num"><b>{a === null ? '—' : fmt(a)}</b></td><td className="num muted">{b === null ? '—' : fmt(b)}</td><td className="num">{ch === null ? '' : <span className={`chip ${good ? 'teal' : 'rose'}`}>{ch > 0 ? '+' : ''}{ch}%</span>}</td></tr>; };
  const pct = (x) => `${x}%`;
  return (
    <>
      <PageHead title="Weekly report" sub={`${d.from} to ${d.to}. ${settings.weekly_report === '1' ? `Sent every Monday${settings.report_email ? ` to ${settings.report_email}` : ' to your phone'}.` : 'Turn on the Monday report in Settings.'}`}>
        <button className="btn" onClick={() => setWeek(addDays(d.from, -7))}>Week before</button>
        <button className="btn" disabled={!week} onClick={() => setWeek(addDays(d.from, 7))}>Week after</button>
        <button className="btn primary" onClick={() => api('/staff/weekly-report/send', { method: 'POST', body: { week: d.from } }).then((r) => toast(r.emailed ? `Emailed to ${r.emailed} address${r.emailed === 1 ? '' : 'es'}` : 'Sent to your phone', 'ok')).catch((e) => toast(e.message, 'err'))}>Send it now</button>
      </PageHead>
      <div className="grid-2">
        <section className="panel"><table className="list"><thead><tr><th /><th>This week</th><th>Week before</th><th /></tr></thead><tbody>
          <Row label="Sales" a={n.salesCents} b={p.salesCents} />
          <Row label="Orders" a={n.orders} b={p.orders} fmt={(x) => x} />
          <Row label="Average ticket" a={n.avgCents} b={p.avgCents} />
          <Row label="Tips" a={n.tipsCents} b={p.tipsCents} />
          <Row label="Labor" a={n.laborCents} b={p.laborCents} invert />
          <Row label="Labor % of sales" a={n.laborPct} b={p.laborPct} fmt={pct} invert />
          <Row label="Food cost %" a={n.foodCostPct} b={p.foodCostPct} fmt={pct} invert />
          <Row label="Waste" a={n.wasteCents} b={p.wasteCents} invert />
        </tbody></table></section>
        <section className="panel"><div className="panel-h"><h3>Highlights</h3></div><div className="panel-b stack" style={{ gap: 6, fontSize: 14.5 }}>
          {n.bestDay && <span>Best day: <b>{new Date(`${n.bestDay}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</b></span>}
          {n.rating?.n > 0 && <span>Guest rating: <b>{n.rating.r} / 5</b> from {n.rating.n}</span>}
          {n.top.length > 0 && <><b>Top sellers</b>{n.top.map((x) => <div key={x.name} className="row"><span className="grow">{x.name}</span><span className="muted num">{x.q}</span><span className="num" style={{ width: 90, textAlign: 'right' }}>{money(x.c, cur)}</span></div>)}</>}
          {d.billsDue.length > 0 && <><b style={{ marginTop: 8 }}>Supplier bills due soon</b>{d.billsDue.map((b, i) => <div key={i} className="row"><span className="grow">{b.name}</span><span className="muted">{b.due_date}</span><span className="num" style={{ width: 90, textAlign: 'right' }}>{money(b.owed, cur)}</span></div>)}</>}
        </div></section>
      </div>
    </>
  );
}

/* ================= Supplier bills ================= */
export function SupplierBills() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [status, setStatus] = useState('open');
  const [d, reload] = useLive(['bills'], () => api(`/staff/supplier-bills?status=${status}`), [status]);
  const [edit, setEdit] = useState(null);
  const [pay, setPay] = useState(null);
  if (!d) return null;
  const blank = (po) => { const sup = d.suppliers.find((s) => s.id === po?.supplier_id) || d.suppliers[0]; return { supplierId: sup?.id || '', poId: po?.id ?? null, number: '', billDate: today(), dueDate: addDays(today(), sup?.terms_days ?? 30), amount: po ? (po.totalCents / 100).toFixed(2) : '', category: 'food', note: '' }; };
  const save = async () => { try { const body = { supplierId: Number(edit.supplierId), poId: edit.poId, number: edit.number || undefined, billDate: edit.billDate, dueDate: edit.dueDate, amountCents: dollars(edit.amount), category: edit.category, note: edit.note || undefined }; const r = await api(edit.id ? `/staff/supplier-bills/${edit.id}` : '/staff/supplier-bills', { method: edit.id ? 'PUT' : 'POST', body }); const id = edit.id || r.id; if (edit.file) await api(`/staff/supplier-bills/${id}/photo`, { method: 'PUT', body: { dataUrl: await fileToDataUrl(edit.file) } }); setEdit(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const doPay = () => api(`/staff/supplier-bills/${pay.bill.id}/pay`, { method: 'POST', body: { amountCents: dollars(pay.amount), method: pay.method, reference: pay.reference || undefined, paidOn: pay.paidOn } }).then(() => { setPay(null); reload(); toast('Payment recorded', 'ok'); }).catch((e) => toast(e.message, 'err'));
  const age = [['current', 'Not due yet'], ['d1_30', '1–30 days late'], ['d31_60', '31–60 days late'], ['d60', 'Over 60 days late']];
  return (
    <>
      <PageHead title="Supplier bills" sub={`${money(d.owedCents, cur)} owed to suppliers, ${money(d.dueWeekCents, cur)} due in the next 7 days. You get a reminder 3 days before each bill is due.`}>
        <div className="seg">{[['open', 'To pay'], ['paid', 'Paid'], ['all', 'All']].map(([k, l]) => <button key={k} aria-pressed={status === k} onClick={() => setStatus(k)}>{l}</button>)}</div>
        <a className="btn" href="/api/staff/supplier-bills.csv">Download CSV</a>
        <button className="btn primary" disabled={!d.suppliers.length} onClick={() => setEdit(blank())}>Add a bill</button>
      </PageHead>
      <div className="kpis" style={{ marginBottom: 18 }}>{age.map(([k, l]) => <div key={k} className="kpi"><div className="v" style={{ fontSize: '1.6rem', color: k !== 'current' && d.aging[k] ? 'var(--dirty)' : undefined }}>{money(d.aging[k], cur)}</div><div className="l">{l}</div></div>)}</div>
      {d.unbilled.length > 0 && status === 'open' && <section className="panel" style={{ marginBottom: 18 }}><div className="panel-h"><h3>Deliveries without a bill yet</h3></div>
        <table className="list"><tbody>{d.unbilled.map((p) => <tr key={p.id}><td>{p.supplier}</td><td className="muted">Order {p.id}, received {p.received_at?.slice(0, 10)}</td><td className="num">{money(p.totalCents, cur)}</td><td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setEdit(blank(p))}>Enter the bill</button></td></tr>)}</tbody></table></section>}
      {d.suppliers.length === 0 && <div className="panel empty"><b>No suppliers yet</b><span>Add suppliers in Purchasing first.</span></div>}
      <section className="panel">
        {d.bills.length === 0 ? <div className="panel-b muted">{status === 'open' ? 'Nothing to pay. Nice.' : 'No bills here.'}</div> : (
          <table className="list"><thead><tr><th>Supplier</th><th>Bill</th><th>Due</th><th>Amount</th><th>Owed</th><th /></tr></thead>
            <tbody>{d.bills.map((b) => (
              <tr key={b.id} style={{ opacity: b.status === 'void' ? 0.5 : 1 }}><td><b>{b.supplier}</b><div className="dim" style={{ fontSize: 12, textTransform: 'capitalize' }}>{b.category}{b.note ? `, ${b.note}` : ''}</div></td>
                <td>{b.number || `#${b.id}`}{b.photo && <> <a href={b.photo} target="_blank" rel="noreferrer" className="dim">copy</a></>}<div className="dim" style={{ fontSize: 12 }}>{b.bill_date}</div></td>
                <td>{b.due_date}{b.status === 'open' && (b.overdueDays ? <div><span className="chip rose">{b.overdueDays} days late</span></div> : b.due_date <= addDays(today(), 7) ? <div><span className="chip amber">Due soon</span></div> : null)}</td>
                <td className="num">{money(b.amount_cents, cur)}</td><td className="num">{b.status === 'paid' ? <span className="chip teal">Paid</span> : <b>{money(b.owedCents, cur)}</b>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{b.status === 'open' && <button className="btn sm primary" onClick={() => setPay({ bill: b, amount: (b.owedCents / 100).toFixed(2), method: 'ach', reference: '', paidOn: today() })}>Pay</button>}<button className="btn sm ghost" onClick={() => setEdit({ id: b.id, supplierId: b.supplier_id, poId: b.po_id, number: b.number || '', billDate: b.bill_date, dueDate: b.due_date, amount: (b.amount_cents / 100).toFixed(2), category: b.category, note: b.note || '' })}>Edit</button>{b.status === 'open' && !b.paidCents && <button className="btn sm ghost" onClick={() => confirm('Void this bill?') && api(`/staff/supplier-bills/${b.id}/void`, { method: 'POST' }).then(reload).catch((e) => toast(e.message, 'err'))}>Void</button>}</td></tr>
            ))}</tbody></table>
        )}
      </section>
      <SupplierCredits />
      {edit && (
        <Modal title={edit.id ? 'Edit bill' : 'Add a supplier bill'} onClose={() => setEdit(null)} width={520}>
          <div className="row"><label className="field grow"><span>Supplier</span><select className="input" value={edit.supplierId} onChange={(e) => { const s = d.suppliers.find((x) => x.id === Number(e.target.value)); setEdit({ ...edit, supplierId: e.target.value, dueDate: addDays(edit.billDate, s?.terms_days ?? 30) }); }}>{d.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field"><span>Bill number</span><input className="input" style={{ width: 140 }} value={edit.number} onChange={(e) => setEdit({ ...edit, number: e.target.value })} maxLength={40} /></label></div>
          <div className="row"><label className="field grow"><span>Bill date</span><input className="input" type="date" value={edit.billDate} onChange={(e) => setEdit({ ...edit, billDate: e.target.value })} /></label><label className="field grow"><span>Due</span><input className="input" type="date" value={edit.dueDate} onChange={(e) => setEdit({ ...edit, dueDate: e.target.value })} /></label><label className="field"><span>Amount</span><input className="input" style={{ width: 110 }} inputMode="decimal" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></label></div>
          <div className="row"><label className="field"><span>Type</span><select className="input" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{['food', 'drinks', 'supplies', 'equipment', 'rent', 'utilities', 'services', 'other'].map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</select></label><label className="field grow"><span>Note</span><input className="input" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} maxLength={300} /></label></div>
          <label className="field"><span>Photo or PDF of the bill (optional)</span><input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setEdit({ ...edit, file: e.target.files?.[0] })} /></label>
          <button className="btn primary lg block" disabled={!edit.supplierId || !dollars(edit.amount)} onClick={save}>Save bill</button>
        </Modal>
      )}
      {pay && (
        <Modal title={`Pay ${pay.bill.supplier}`} onClose={() => setPay(null)} width={440}>
          <span className="muted">{money(pay.bill.owedCents, cur)} owed on {pay.bill.number || `bill #${pay.bill.id}`}. Record it here after you send the money from your bank.</span>
          <div className="row"><label className="field grow"><span>Amount</span><input className="input" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></label><label className="field grow"><span>Paid on</span><input className="input" type="date" value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} /></label></div>
          <div className="row wrap" style={{ gap: 6 }}>{[['ach', 'Bank transfer'], ['check', 'Check'], ['zelle', 'Zelle'], ['card', 'Card'], ['cash', 'Cash drawer'], ['other', 'Other']].map(([k, l]) => <button key={k} className={`btn sm ${pay.method === k ? 'primary' : ''}`} onClick={() => setPay({ ...pay, method: k })}>{l}</button>)}</div>
          <label className="field"><span>Check or confirmation number (optional)</span><input className="input" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} maxLength={60} /></label>
          <button className="btn primary lg block" disabled={!dollars(pay.amount)} onClick={doPay}>Record payment</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Settings panel ================= */
export function OwnerPanel({ f, setF }) {
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const langs = pj(f.languages, ['en', 'es']);
  const tiers = pj(f.loyalty_tiers, []);
  const setTiers = (t) => setF({ ...f, loyalty_tiers: JSON.stringify(t) });
  const LN = { es: 'Spanish', fr: 'French', zh: 'Chinese', vi: 'Vietnamese' };
  return (
    <section className="panel"><div className="panel-h"><h3>Languages, member levels, reports and reorders</h3></div><div className="panel-b stack">
      <div className="field"><span>Languages customers can pick (English is always on)</span><div className="row wrap">{Object.entries(LN).map(([k, l]) => <label key={k} className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={langs.includes(k)} onChange={(e) => setF({ ...f, languages: JSON.stringify(e.target.checked ? [...langs, k] : langs.filter((x) => x !== k)) })} />{l}</label>)}</div>
        <span className="dim" style={{ fontSize: 12.5 }}>Buttons and messages are translated for you. Translate dish names in Menu details.</span></div>
      <hr className="sep" />
      <b>Member levels</b>
      <span className="muted" style={{ fontSize: 14 }}>Customers with an account move up by what they spend in 12 months. The level's discount is applied at the register when you pick the customer (the better of this or a membership).</span>
      {tiers.map((t, i) => (
        <div key={i} className="row wrap" style={{ gap: 6 }}>
          <input className="input" style={{ width: 110 }} value={t.name} onChange={(e) => setTiers(tiers.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} placeholder="Gold" aria-label="Level name" />
          <span className="muted" style={{ fontSize: 13 }}>at</span><input className="input" style={{ width: 90 }} inputMode="decimal" value={(Number(t.minCents) / 100) || ''} onChange={(e) => setTiers(tiers.map((x, k) => (k === i ? { ...x, minCents: dollars(e.target.value) } : x)))} aria-label="Spend to reach" />
          <input className="input" style={{ width: 70 }} inputMode="numeric" value={t.pct ?? ''} onChange={(e) => setTiers(tiers.map((x, k) => (k === i ? { ...x, pct: Number(e.target.value.replace(/\D/g, '')) || 0 } : x)))} placeholder="% off" aria-label="Percent off" />
          <input className="input grow" value={t.perk || ''} onChange={(e) => setTiers(tiers.map((x, k) => (k === i ? { ...x, perk: e.target.value } : x)))} placeholder="Perk, like a free dessert on your birthday" aria-label="Perk" />
          <button className="btn sm ghost" onClick={() => setTiers(tiers.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <button className="btn" onClick={() => setTiers([...tiers, { name: tiers.length ? 'Gold' : 'Silver', minCents: tiers.length ? 100000 : 30000, pct: tiers.length ? 10 : 5, perk: '' }])}>Add a level</button>
      <hr className="sep" />
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.table_calls === '1'} onChange={flag('table_calls')} /> Guests can call their server, ask for water or the check from the table QR page</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.auto_reorder === '1'} onChange={flag('auto_reorder')} /> Draft supplier orders automatically when ingredients run low (you still check and send them)</label>
      <div className="row wrap"><label className="row grow" style={{ fontSize: 14 }}><input type="checkbox" checked={f.weekly_report === '1'} onChange={flag('weekly_report')} /> Weekly report every Monday at</label>
        <select className="input" style={{ width: 110 }} value={f.weekly_report_hour} onChange={set('weekly_report_hour')} aria-label="Report hour">{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>)}</select></div>
      <label className="field"><span>Email the report to (comma-separated, optional)</span><input className="input" value={f.report_email} onChange={set('report_email')} placeholder="owner@example.com, partner@example.com" /></label>
    </div></section>
  );
}
