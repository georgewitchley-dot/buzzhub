import { useState } from 'react';
import { api, money } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { PaymentCosts } from './Field.jsx';

const dayLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const num = (v) => Number(String(v).replace(/[^\d.-]/g, '')) || 0;
const r2 = (n) => Math.round(n * 100) / 100;

/* ================= Insights ================= */
export function Insights() {
  const { settings, user } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [d] = useLive(['orders'], () => api('/staff/insights'));
  if (!d) return null;
  const t = d.today;
  const max = Math.max(1, ...d.history.map((x) => x.salesCents), t.salesCents);
  const send = async () => { try { const r = await api('/staff/insights/send', { method: 'POST' }); toast(r.sent ? 'Sent to your phone' : `Not sent: turn on alerts on your phone first. "${r.text}"`, r.sent ? 'ok' : 'err'); } catch (e) { toast(e.message, 'err'); } };
  return (
    <>
      <PageHead title="Insights" sub={`${d.settings.summary ? `Owners get a summary on their phone at ${new Date(2000, 0, 1, d.settings.hour).toLocaleTimeString([], { hour: 'numeric' })}.` : 'The daily summary is off.'} ${d.settings.alerts ? 'Managers are alerted about unusual voids, refunds, discounts and slow tickets.' : ''}`}>
        {user.role === 'owner' && <button className="btn" onClick={send}><Icon name="bell" size={16} />Send today so far to my phone</button>}
      </PageHead>
      <div className="kpis">
        <div className="kpi"><div className="v">{money(t.salesCents, cur)}</div><div className="l">Sales today{t.changePct !== null ? `, ${t.changePct >= 0 ? '+' : ''}${t.changePct}% vs last ${new Date(`${t.day}T12:00:00`).toLocaleDateString([], { weekday: 'long' })}` : ''}</div></div>
        <div className="kpi"><div className="v">{t.orders}</div><div className="l">Orders, {money(t.avgCents, cur)} average</div></div>
        <div className="kpi"><div className="v" style={{ color: t.laborPct > 35 ? 'var(--dirty)' : undefined }}>{t.laborPct === null ? 'No sales' : `${t.laborPct}%`}</div><div className="l">Labor ({t.laborHours} hours)</div></div>
        <div className="kpi"><div className="v">{t.rating ? `${t.rating}★` : 'None'}</div><div className="l">Guest rating today ({t.ratings})</div></div>
      </div>
      <div className="grid-2" style={{ marginTop: 18 }}>
        <section className="panel"><div className="panel-h"><h3>Last 14 days</h3></div>
          <table className="list"><thead><tr><th>Day</th><th>Sales</th><th /><th>vs week before</th><th>Labor</th><th>Voids</th><th>Rating</th></tr></thead>
            <tbody>{[t, ...d.history].map((x) => (
              <tr key={x.day}><td>{x.day === t.day ? 'Today' : dayLabel(x.day)}</td><td className="num">{money(x.salesCents, cur)}</td>
                <td style={{ width: '24%' }}><div className="bar"><i style={{ width: `${(x.salesCents / max) * 100}%` }} /></div></td>
                <td className="num" style={{ color: x.changePct < -10 ? 'var(--dirty)' : x.changePct > 10 ? 'var(--seated)' : undefined }}>{x.changePct === null ? '' : `${x.changePct >= 0 ? '+' : ''}${x.changePct}%`}</td>
                <td className="num muted">{x.laborPct === null || !x.laborCents ? '' : `${x.laborPct}%`}</td><td className="num muted">{x.voids || ''}</td><td className="num muted">{x.rating ? `${x.rating}★` : ''}</td></tr>
            ))}</tbody></table>
        </section>
        <div className="stack">
          <section className="panel"><div className="panel-h"><h3>Today in short</h3></div><div className="panel-b stack" style={{ gap: 8, fontSize: 14.5 }}>
            <div>Best sellers: {t.top.length ? t.top.map((x) => `${x.name} (${x.qty})`).join(', ') : 'none yet'}</div>
            <div>Guests in line: {t.guests} parties, {t.covers} people</div>
            <div>Kitchen time: {t.kitchenMinutes ? `${t.kitchenMinutes} minutes per ticket` : 'no tickets yet'}</div>
            <div>Tips: {money(t.tipsCents, cur)}</div>
            <div>Voids: {t.voids} ({money(t.voidCents, cur)}), refunds: {t.refunds} ({money(t.refundCents, cur)})</div>
          </div></section>
          <section className="panel"><div className="panel-h"><h3>Alerts</h3></div>
            {d.alerts.length ? <table className="list"><tbody>{d.alerts.map((a) => <tr key={a.id}><td className="muted" style={{ whiteSpace: 'nowrap' }}>{new Date(`${a.at.replace(' ', 'T')}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td><b>{a.title.split(': ').slice(1).join(': ') || a.title}</b><div className="dim" style={{ fontSize: 13 }}>{a.body}</div></td></tr>)}</tbody></table>
              : <div className="panel-b muted">Nothing unusual. You'll be alerted when someone voids a lot, refunds run high, discounts climb or the kitchen falls behind.</div>}
          </section>
        </div>
      </div>
      <PaymentCosts />
    </>
  );
}

/* ================= Purchasing: ingredients, recipes, suppliers, orders ================= */
function IngredientModal({ ing, suppliers, currency, onClose }) {
  const toast = useToast();
  const [f, setF] = useState(ing ? { name: ing.name, unit: ing.unit, cost: (ing.cost_cents / 100).toFixed(2), low: String(ing.low_raw ?? ing.lowMark ?? 0), par: ing.par ?? '', supplierId: ing.supplier_id || '', track: ing.stock !== null } : { name: '', unit: 'each', cost: '', low: '0', par: '', supplierId: '', track: true });
  const save = async () => {
    const body = { name: f.name, unit: f.unit, costCents: r2(num(f.cost) * 100), low: num(f.low), par: f.par === '' ? null : num(f.par), supplierId: f.supplierId ? Number(f.supplierId) : null, track: f.track };
    try { await api(ing ? `/staff/ingredients/${ing.id}` : '/staff/ingredients', { method: ing ? 'PUT' : 'POST', body }); onClose(); } catch (e) { toast(e.message, 'err'); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={ing ? `Edit ${ing.name}` : 'Add an ingredient'} onClose={onClose} width={520}>
      <div className="row"><label className="field grow"><span>Name</span><input className="input" value={f.name} onChange={set('name')} maxLength={60} placeholder="Beef patty" /></label>
        <label className="field" style={{ width: 120 }}><span>Counted in</span><input className="input" value={f.unit} onChange={set('unit')} maxLength={12} placeholder="each, lb, oz" /></label></div>
      <div className="row"><label className="field grow"><span>Cost per {f.unit || 'unit'} ({currency})</span><input className="input" inputMode="decimal" value={f.cost} onChange={set('cost')} /></label>
        <label className="field grow"><span>Supplier</span><select className="input" value={f.supplierId} onChange={set('supplierId')}><option value="">None</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.track} onChange={(e) => setF({ ...f, track: e.target.checked })} />Track how much is on hand</label>
      {f.track && <div className="row"><label className="field grow"><span>Warn me at</span><input className="input" inputMode="decimal" value={f.low} onChange={set('low')} /></label>
        <label className="field grow"><span>Order up to (optional)</span><input className="input" inputMode="decimal" value={f.par} onChange={set('par')} /></label></div>}
      <button className="btn primary lg block" disabled={!f.name || !f.unit} onClick={save}>{ing ? 'Save' : 'Add ingredient'}</button>
    </Modal>
  );
}
function RecipeModal({ item, ingredients, currency, onClose }) {
  const toast = useToast();
  const [lines, setLines] = useState(item.lines.map((l) => ({ ingredientId: l.ingredientId, qty: String(l.qty) })));
  const byId = Object.fromEntries(ingredients.map((g) => [g.id, g]));
  const cost = lines.reduce((a, l) => a + (byId[l.ingredientId]?.cost_cents || 0) * num(l.qty), 0);
  const pct = item.priceCents ? Math.round((cost / item.priceCents) * 1000) / 10 : 0;
  const save = async () => { try { await api(`/staff/recipes/${item.id}`, { method: 'PUT', body: { lines: lines.filter((l) => l.ingredientId && num(l.qty) > 0).map((l) => ({ ingredientId: Number(l.ingredientId), qty: num(l.qty) })) } }); toast(`${item.name} recipe saved`, 'ok'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`What goes into ${item.name}`} onClose={onClose} width={560}>
      {lines.map((l, i) => (
        <div key={i} className="row">
          <select className="input grow" value={l.ingredientId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, ingredientId: Number(e.target.value) } : x)))} aria-label="Ingredient"><option value="">Pick an ingredient</option>{ingredients.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
          <input className="input" style={{ width: 90 }} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label="Amount" />
          <span className="muted" style={{ width: 50 }}>{byId[l.ingredientId]?.unit || ''}</span>
          <button className="btn ghost sm" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove"><Icon name="x" size={15} /></button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setLines([...lines, { ingredientId: '', qty: '1' }])}>Add an ingredient</button>
      <div className="totals"><div><span>Cost to make</span><span>{money(Math.round(cost), currency)}</span></div><div><span>Menu price</span><span>{money(item.priceCents, currency)}</span></div><div className="grand"><span>Food cost</span><span style={{ color: pct > 35 ? 'var(--dirty)' : undefined }}>{pct}%</span></div></div>
      <button className="btn primary lg block" onClick={save}>Save recipe</button>
    </Modal>
  );
}
function SupplierModal({ sup, onClose }) {
  const toast = useToast();
  const [f, setF] = useState(sup || { name: '', email: '', phone: '', notes: '' });
  const save = async () => { try { await api(sup ? `/staff/suppliers/${sup.id}` : '/staff/suppliers', { method: sup ? 'PUT' : 'POST', body: { name: f.name, email: f.email || '', phone: f.phone || undefined, notes: f.notes || undefined } }); onClose(); } catch (e) { toast(e.message, 'err'); } };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={sup ? `Edit ${sup.name}` : 'Add a supplier'} onClose={onClose} width={480}>
      <label className="field"><span>Name</span><input className="input" value={f.name} onChange={set('name')} maxLength={60} /></label>
      <div className="row"><label className="field grow"><span>Email for orders</span><input className="input" type="email" value={f.email || ''} onChange={set('email')} /></label><label className="field grow"><span>Phone</span><input className="input" value={f.phone || ''} onChange={set('phone')} /></label></div>
      <label className="field"><span>Notes</span><input className="input" value={f.notes || ''} onChange={set('notes')} maxLength={200} placeholder="Delivers Tue and Fri, order by 2 PM" /></label>
      <button className="btn primary lg block" disabled={!f.name} onClick={save}>Save supplier</button>
    </Modal>
  );
}
function NewPoModal({ data, po, currency, onClose }) {
  const toast = useToast();
  const [supplierId, setSupplierId] = useState(po?.supplierId || data.suppliers[0]?.id || '');
  const [lines, setLines] = useState(po?.lines || [{ ingredientId: '', qty: '1' }]);
  const [notes, setNotes] = useState('');
  const byId = Object.fromEntries(data.ingredients.map((g) => [g.id, g]));
  const total = lines.reduce((a, l) => a + (byId[l.ingredientId]?.cost_cents || 0) * num(l.qty), 0);
  const save = async () => { try { await api('/staff/purchase-orders', { method: 'POST', body: { supplierId: Number(supplierId), notes: notes || undefined, lines: lines.filter((l) => l.ingredientId && num(l.qty) > 0).map((l) => ({ ingredientId: Number(l.ingredientId), qty: num(l.qty) })) } }); toast('Order saved as a draft', 'ok'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title="New supplier order" onClose={onClose} width={560}>
      <label className="field"><span>Supplier</span><select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>{data.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      {lines.map((l, i) => (
        <div key={i} className="row">
          <select className="input grow" value={l.ingredientId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, ingredientId: Number(e.target.value) } : x)))} aria-label="Ingredient"><option value="">Pick an ingredient</option>{data.ingredients.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
          <input className="input" style={{ width: 90 }} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label="Quantity" />
          <span className="muted" style={{ width: 50 }}>{byId[l.ingredientId]?.unit || ''}</span>
          <button className="btn ghost sm" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove"><Icon name="x" size={15} /></button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setLines([...lines, { ingredientId: '', qty: '1' }])}>Add a line</button>
      <label className="field"><span>Notes for the supplier</span><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></label>
      <div className="totals"><div className="grand"><span>Estimated cost</span><span>{money(Math.round(total), currency)}</span></div></div>
      <button className="btn primary lg block" disabled={!supplierId} onClick={save}>Save order</button>
    </Modal>
  );
}
function ReceiveModal({ po, currency, onClose }) {
  const toast = useToast();
  const [lines, setLines] = useState(po.lines.map((l) => ({ lineId: l.id, name: l.name, unit: l.unit, qty: String(l.qty), cost: (l.cost_cents / 100).toFixed(2) })));
  const save = async () => { try { await api(`/staff/purchase-orders/${po.id}/receive`, { method: 'POST', body: { lines: lines.map((l) => ({ lineId: l.lineId, qty: num(l.qty), costCents: r2(num(l.cost) * 100) })) } }); toast('Delivery received. Stock updated.', 'ok'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`Receive order ${po.id} from ${po.supplier?.name}`} onClose={onClose} width={560}>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>Enter what actually arrived and what it cost per unit. Stock and costs update for food cost.</p>
      {lines.map((l, i) => (
        <div key={l.lineId} className="row"><span className="grow">{l.name}</span>
          <input className="input" style={{ width: 80 }} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label={`${l.name} received`} /><span className="muted" style={{ width: 40 }}>{l.unit}</span>
          <input className="input" style={{ width: 90 }} inputMode="decimal" value={l.cost} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))} aria-label={`${l.name} cost per unit`} /><span className="muted">each</span></div>
      ))}
      <button className="btn primary lg block" onClick={save}>Mark received</button>
    </Modal>
  );
}
export function Purchasing() {
  const { settings } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [tab, setTab] = useState('stock');
  const [d, reload] = useLive(['menu'], () => api('/staff/ingredients'));
  const [pos, reloadPos] = useLive(['menu'], () => api('/staff/purchase-orders'));
  const [modal, setModal] = useState(null);
  const [qty, setQty] = useState({});
  if (!d || !pos) return null;
  const close = () => { setModal(null); reload(); reloadPos(); };
  const count = async (g, mode) => { try { await api(`/staff/ingredients/${g.id}/count`, { method: 'POST', body: { qty: num(qty[g.id]), mode } }); setQty({ ...qty, [g.id]: '' }); reload(); } catch (e) { toast(e.message, 'err'); } };
  const send = async (po) => { try { const r = await api(`/staff/purchase-orders/${po.id}/send`, { method: 'POST', body: { email: true } }); toast(r.emailed ? `Emailed to ${po.supplier.name}` : 'Marked as sent. Call or text it to your supplier.', 'ok'); reloadPos(); } catch (e) { toast(e.message, 'err'); } };
  const low = d.ingredients.filter((g) => g.low);
  const fromSuggested = (supplierId) => ({ supplierId, lines: pos.suggested.filter((s) => !supplierId || s.supplierId === supplierId).map((s) => ({ ingredientId: s.ingredientId, qty: String(s.qty) })) });
  return (
    <>
      <PageHead title="Purchasing" sub={`Food cost over the last 30 days: ${d.foodCostPct === null ? 'add recipes to see it' : `${d.foodCostPct}% (your target is ${d.target}%)`}. ${low.length} ingredient${low.length === 1 ? '' : 's'} running low.`}>
        <div className="seg">{[['stock', 'Ingredients'], ['recipes', 'Recipes and food cost'], ['orders', 'Supplier orders']].map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      </PageHead>
      {tab === 'stock' && (
        <section className="panel"><div className="panel-h"><h3 className="grow">Ingredients</h3><button className="btn sm" onClick={() => setModal({ kind: 'sup' })}>Add supplier</button><button className="btn sm primary" onClick={() => setModal({ kind: 'ing' })}>Add ingredient</button></div>
          {d.ingredients.length === 0 ? <div className="panel-b muted">Add what you buy, like patties, buns, milk or shampoo. Then set what goes into each menu item, and stock goes down with every sale.</div> : (
            <table className="list"><thead><tr><th>Ingredient</th><th>On hand</th><th>Cost</th><th>Used, 7 days</th><th>Lasts about</th><th>Supplier</th><th>Count, add or waste</th><th /></tr></thead>
              <tbody>{d.ingredients.map((g) => (
                <tr key={g.id}><td><b>{g.name}</b></td>
                  <td>{g.stock === null ? <span className="dim">Not tracked</span> : <span className={`chip ${g.low ? 'rose' : 'teal'}`}>{g.stock} {g.unit}</span>}</td>
                  <td className="num muted">{money(Math.round(g.cost_cents), cur)} / {g.unit}</td><td className="num">{g.used7}</td>
                  <td className="muted">{g.daysLeft === null ? '' : `${g.daysLeft} day${g.daysLeft === 1 ? '' : 's'}`}</td><td className="muted">{g.supplier || ''}</td>
                  <td>{g.stock !== null && <div className="row" style={{ gap: 4 }}><input className="input" style={{ width: 70, height: 32 }} inputMode="decimal" value={qty[g.id] || ''} onChange={(e) => setQty({ ...qty, [g.id]: e.target.value })} placeholder="Qty" aria-label={`Quantity of ${g.name}`} />
                    <button className="btn sm" disabled={!qty[g.id]} onClick={() => count(g, 'set')}>Count</button><button className="btn sm ghost" disabled={!qty[g.id]} onClick={() => count(g, 'add')}>Add</button><button className="btn sm ghost" disabled={!qty[g.id]} onClick={() => count(g, 'waste')}>Waste</button></div>}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setModal({ kind: 'ing', ing: g })}>Edit</button></td></tr>
              ))}</tbody></table>
          )}
          {d.suppliers.length > 0 && <div className="panel-b row wrap" style={{ gap: 6 }}><span className="muted">Suppliers:</span>{d.suppliers.map((s) => <button key={s.id} className="chip" onClick={() => setModal({ kind: 'sup', sup: s })}>{s.name}</button>)}</div>}
        </section>
      )}
      {tab === 'recipes' && (
        <section className="panel"><table className="list"><thead><tr><th>Item</th><th>Price</th><th>Cost to make</th><th>Food cost</th><th>Profit each</th><th>Sold, 30 days</th><th /></tr></thead>
          <tbody>{d.items.map((m) => (
            <tr key={m.id}><td><b>{m.name}</b><div className="dim" style={{ fontSize: 12.5 }}>{m.lines.length ? m.lines.map((l) => `${l.qty} ${l.unit} ${l.name}`).join(', ') : 'No recipe yet'}</div></td>
              <td className="num">{money(m.priceCents, cur)}</td><td className="num">{m.lines.length ? money(m.costCents, cur) : ''}</td>
              <td>{m.costPct !== null && <span className={`chip ${m.costPct > d.target + 5 ? 'rose' : m.costPct > d.target ? 'amber' : 'teal'}`}>{m.costPct}%</span>}</td>
              <td className="num">{m.lines.length ? money(m.profitCents, cur) : ''}</td><td className="num muted">{m.sold30}</td>
              <td style={{ textAlign: 'right' }}><button className="btn sm ghost" disabled={!d.ingredients.length} onClick={() => setModal({ kind: 'recipe', item: m })}>{m.lines.length ? 'Edit recipe' : 'Add recipe'}</button></td></tr>
          ))}</tbody></table></section>
      )}
      {tab === 'orders' && (
        <>
          {pos.suggested.length > 0 && (
            <section className="panel" style={{ marginBottom: 18 }}><div className="panel-h"><h3 className="grow">Suggested order</h3><button className="btn sm primary" disabled={!d.suppliers.length} onClick={() => setModal({ kind: 'po', po: fromSuggested(pos.suggested[0].supplierId || d.suppliers[0]?.id) })}>Start an order from this</button></div>
              <div className="panel-b muted" style={{ fontSize: 14 }}>{pos.suggested.map((s) => `${s.qty} ${s.unit} ${s.name} (have ${s.stock})`).join(', ')}</div></section>
          )}
          <section className="panel"><div className="panel-h"><h3 className="grow">Supplier orders</h3><button className="btn sm primary" disabled={!d.suppliers.length} onClick={() => setModal({ kind: 'po' })}>New order</button></div>
            {pos.orders.length === 0 ? <div className="panel-b muted">{d.suppliers.length ? 'No orders yet.' : 'Add a supplier first, from the Ingredients tab.'}</div> : (
              <table className="list"><thead><tr><th>Order</th><th>Supplier</th><th>Items</th><th>Cost</th><th>Status</th><th /></tr></thead>
                <tbody>{pos.orders.map((po) => (
                  <tr key={po.id}><td className="num">#{po.id}<div className="dim" style={{ fontSize: 12 }}>{new Date(`${po.created_at.replace(' ', 'T')}Z`).toLocaleDateString()}</div></td><td>{po.supplier?.name}</td>
                    <td className="muted" style={{ fontSize: 13.5 }}>{po.lines.map((l) => `${l.received_qty ?? l.qty} ${l.unit} ${l.name}`).join(', ')}</td><td className="num">{money(po.totalCents, cur)}</td>
                    <td><span className={`chip ${po.status === 'received' ? 'teal' : po.status === 'sent' ? 'amber' : po.status === 'cancelled' ? '' : 'blue'}`} style={{ textTransform: 'capitalize' }}>{po.status === 'draft' ? 'Draft' : po.status}</span></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {po.status === 'draft' && <button className="btn sm" onClick={() => send(po)}>{pos.emailEnabled && po.supplier?.email ? 'Email it' : 'Mark sent'}</button>}
                      {['draft', 'sent'].includes(po.status) && <button className="btn sm primary" onClick={() => setModal({ kind: 'recv', po })}>Receive</button>}
                      {['draft', 'sent'].includes(po.status) && <button className="btn sm ghost danger" onClick={() => api(`/staff/purchase-orders/${po.id}/cancel`, { method: 'POST' }).then(reloadPos)}>Cancel</button>}
                    </td></tr>
                ))}</tbody></table>
            )}
          </section>
        </>
      )}
      {modal?.kind === 'ing' && <IngredientModal ing={modal.ing} suppliers={d.suppliers} currency={cur} onClose={close} />}
      {modal?.kind === 'sup' && <SupplierModal sup={modal.sup} onClose={close} />}
      {modal?.kind === 'recipe' && <RecipeModal item={modal.item} ingredients={d.ingredients} currency={cur} onClose={close} />}
      {modal?.kind === 'po' && <NewPoModal data={d} po={modal.po} currency={cur} onClose={close} />}
      {modal?.kind === 'recv' && <ReceiveModal po={modal.po} currency={cur} onClose={close} />}
    </>
  );
}

/* ================= Payroll ================= */
export function Payroll() {
  const { settings } = useCC();
  const cur = settings.currency;
  const [range, setRange] = useState({ from: '', to: '' });
  const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v));
  const [d] = useLive(['shifts'], () => api(`/staff/payroll${q.size ? `?${q}` : ''}`), [range.from, range.to]);
  if (!d) return null;
  const csv = `/api/staff/payroll?from=${d.from}&to=${d.to}&format=csv`;
  return (
    <>
      <PageHead title="Payroll" sub={`Hours, overtime after ${d.overtimeAfter} hours a week at 1.5×, and tips paid out. Download the file for your payroll service.`}>
        <input className="input" type="date" style={{ width: 150 }} value={range.from || d.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
        <input className="input" type="date" style={{ width: 150 }} value={range.to || d.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
        <a className="btn primary" href={csv} download>Download CSV</a>
      </PageHead>
      <div className="kpis">
        <div className="kpi"><div className="v">{d.totals.hours}</div><div className="l">Hours worked</div></div>
        <div className="kpi"><div className="v" style={{ color: d.totals.overtime ? 'var(--dirty)' : undefined }}>{d.totals.overtime}</div><div className="l">Overtime hours</div></div>
        <div className="kpi"><div className="v">{money(d.totals.tipsCents, cur)}</div><div className="l">Tips paid out</div></div>
        <div className="kpi"><div className="v">{money(d.totals.grossCents, cur)}</div><div className="l">Gross pay</div></div>
      </div>
      <section className="panel" style={{ marginTop: 18 }}>
        {d.people.length === 0 ? <div className="panel-b muted">Nobody clocked in during these days.</div> : (
          <table className="list"><thead><tr><th>Person</th><th>Shifts</th><th>Regular</th><th>Overtime</th><th>Rate</th><th>Regular pay</th><th>Overtime pay</th><th>Tips</th><th>Gross</th></tr></thead>
            <tbody>{d.people.map((p) => (
              <tr key={p.userId}><td>{p.name} <span className="dim" style={{ textTransform: 'capitalize' }}>{p.role}</span>{p.openShift && <span className="chip amber" style={{ marginLeft: 6 }}>On the clock</span>}{p.noBreak > 0 && <span className="chip rose" style={{ marginLeft: 6 }}>{p.noBreak} long shift{p.noBreak === 1 ? '' : 's'} without a break</span>}</td>
                <td className="num">{p.shifts}</td><td className="num">{p.regular}</td><td className="num" style={{ color: p.overtime ? 'var(--dirty)' : undefined }}>{p.overtime}</td>
                <td className="num muted">{money(p.rateCents, cur)}</td><td className="num">{money(p.regularPayCents, cur)}</td><td className="num">{money(p.overtimePayCents, cur)}</td><td className="num">{money(p.tipsCents, cur)}</td><td className="num"><b>{money(p.grossCents, cur)}</b></td></tr>
            ))}</tbody></table>
        )}
      </section>
      <p className="dim" style={{ fontSize: 13, marginTop: 10 }}>Set hourly pay on the Shifts page. Overtime and break rules are under Settings → Staffing and tips. Check local labor laws: some places also count daily overtime.</p>
    </>
  );
}
