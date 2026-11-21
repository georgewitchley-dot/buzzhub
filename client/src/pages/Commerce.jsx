import { useEffect, useState } from 'react';
import { api, money, timeOf, withLoc } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);

/* ================= Menu options (add-ons and choices) ================= */
function GroupModal({ group, items, currency, onClose }) {
  const toast = useToast();
  const [f, setF] = useState(group ? { ...group, options: group.options.map((o) => ({ name: o.name, price: (o.price_cents / 100).toFixed(2) })) } : { name: '', min_pick: 0, max_pick: 1, options: [{ name: '', price: '0.00' }], itemIds: [] });
  const save = async () => {
    const body = { name: f.name, min_pick: Number(f.min_pick), max_pick: Number(f.max_pick), options: f.options.filter((o) => o.name.trim()).map((o) => ({ name: o.name.trim(), price_cents: dollars(o.price) })), itemIds: f.itemIds };
    try { await api(group ? `/staff/mods/${group.id}` : '/staff/mods', { method: group ? 'PUT' : 'POST', body }); onClose(); } catch (e) { toast(e.message, 'err'); }
  };
  const setOpt = (i, k, v) => setF({ ...f, options: f.options.map((o, j) => (j === i ? { ...o, [k]: v } : o)) });
  const kind = f.min_pick >= 1 && f.max_pick === 1 ? 'one' : f.max_pick === 1 ? 'optional' : 'many';
  return (
    <Modal title={group ? `Edit ${group.name}` : 'Add a set of options'} onClose={onClose} width={560}>
      <label className="field"><span>Name customers see</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} placeholder="Cook temperature, Milk, Add-ons…" /></label>
      <div className="field"><span>How many can they choose?</span>
        <div className="seg" style={{ width: '100%' }}>
          <button aria-pressed={kind === 'one'} onClick={() => setF({ ...f, min_pick: 1, max_pick: 1 })} style={{ flex: 1 }}>Exactly one (required)</button>
          <button aria-pressed={kind === 'optional'} onClick={() => setF({ ...f, min_pick: 0, max_pick: 1 })} style={{ flex: 1 }}>One, optional</button>
          <button aria-pressed={kind === 'many'} onClick={() => setF({ ...f, min_pick: 0, max_pick: Math.max(2, f.options.length) })} style={{ flex: 1 }}>Several</button>
        </div>
        {kind === 'many' && <div className="row"><span className="muted">Up to</span><input className="input" type="number" min={2} max={20} value={f.max_pick} onChange={(e) => setF({ ...f, max_pick: e.target.value })} style={{ width: 80 }} /></div>}
      </div>
      <div className="field"><span>Options and extra price ({currency})</span>
        {f.options.map((o, i) => (
          <div key={i} className="row"><input className="input grow" value={o.name} onChange={(e) => setOpt(i, 'name', e.target.value)} placeholder="Option" maxLength={40} aria-label="Option name" /><input className="input" style={{ width: 100 }} inputMode="decimal" value={o.price} onChange={(e) => setOpt(i, 'price', e.target.value)} aria-label="Extra price" /><button className="btn ghost sm" onClick={() => setF({ ...f, options: f.options.filter((_, j) => j !== i) })} aria-label="Remove option"><Icon name="x" size={15} /></button></div>
        ))}
        <button className="btn sm" onClick={() => setF({ ...f, options: [...f.options, { name: '', price: '0.00' }] })}>Add an option</button>
      </div>
      <div className="field"><span>Which items offer these options?</span>
        <div className="pick-grid">{items.map((m) => <label key={m.id} className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.itemIds.includes(m.id)} onChange={(e) => setF({ ...f, itemIds: e.target.checked ? [...f.itemIds, m.id] : f.itemIds.filter((x) => x !== m.id) })} />{m.name}</label>)}</div>
      </div>
      <button className="btn primary lg block" disabled={!f.name || !f.options.some((o) => o.name.trim())} onClick={save}>{group ? 'Save options' : 'Add options'}</button>
    </Modal>
  );
}

export function OptionsAdmin() {
  const { settings } = useCC();
  const toast = useToast();
  const [groups, reload] = useLive(['menu'], () => api('/staff/mods'));
  const [items] = useLive(['menu'], () => api('/staff/menu'));
  const [edit, setEdit] = useState(undefined);
  if (!groups || !items) return null;
  const del = async (g) => { if (!confirm(`Delete ${g.name}?`)) return; try { await api(`/staff/mods/${g.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">Options and add-ons</h3><button className="btn sm primary" onClick={() => setEdit(null)}>Add a set of options</button></div>
      {groups.length === 0 ? <div className="panel-b muted">Add choices like cook temperature or milk type, and paid add-ons like extra cheese. They show on the register, the kitchen ticket and customers' phones.</div> : (
        <table className="list"><tbody>{groups.map((g) => (
          <tr key={g.id}><td><b>{g.name}</b><div className="dim" style={{ fontSize: 13 }}>{g.min_pick >= 1 ? 'Required' : 'Optional'}, {g.max_pick === 1 ? 'pick one' : `up to ${g.max_pick}`}</div></td>
            <td className="muted" style={{ fontSize: 14 }}>{g.options.map((o) => `${o.name}${o.price_cents ? ` (+${money(o.price_cents, settings.currency)})` : ''}`).join(', ')}</td>
            <td className="muted" style={{ fontSize: 14 }}>{g.itemIds.length} item{g.itemIds.length === 1 ? '' : 's'}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn sm ghost" onClick={() => setEdit(g)}>Edit</button><button className="btn sm ghost danger" onClick={() => del(g)}>Delete</button></td></tr>
        ))}</tbody></table>
      )}
      {edit !== undefined && <GroupModal group={edit} items={items} currency={settings.currency} onClose={() => { setEdit(undefined); reload(); }} />}
    </section>
  );
}

/* ================= Inventory ================= */
export function Inventory() {
  const toast = useToast();
  const [d, reload] = useLive(['menu', 'orders'], () => api('/staff/inventory'));
  const [counts, setCounts] = useState({});
  if (!d) return null;
  const run = async (i, body, msg) => { try { await api(`/staff/inventory/${i.id}`, { method: 'POST', body }); toast(msg, 'ok'); setCounts({ ...counts, [i.id]: '' }); reload(); } catch (e) { toast(e.message, 'err'); } };
  const tracked = d.items.filter((i) => i.stock !== null);
  const low = tracked.filter((i) => i.stock <= i.low_stock);
  return (
    <>
      <PageHead title="Inventory" sub={`${tracked.length} items tracked, ${low.length} low or sold out. Stock goes down with every sale. At zero, an item turns itself off.`} />
      <section className="panel"><table className="list">
        <thead><tr><th>Item</th><th>In stock</th><th>Warn at</th><th>Sold, 7 days</th><th>Lasts about</th><th>Count or delivery</th><th /></tr></thead>
        <tbody>{d.items.map((i) => (
          <tr key={i.id}>
            <td>{i.name}<div className="dim" style={{ fontSize: 12.5 }}>{i.category}</div></td>
            <td>{i.stock === null ? <span className="dim">Not tracked</span> : <span className={`chip ${i.stock <= 0 ? 'rose' : i.stock <= i.low_stock ? 'amber' : 'teal'}`}>{i.stock}</span>}</td>
            <td>{i.stock !== null && <input className="input" style={{ width: 70, height: 32 }} type="number" min={0} defaultValue={i.low_stock} onBlur={(e) => Number(e.target.value) !== i.low_stock && run(i, { mode: 'add', qty: 0, lowStock: Number(e.target.value) }, 'Saved')} aria-label={`Warn when ${i.name} is at`} />}</td>
            <td className="num">{i.sold7}</td>
            <td className="muted">{i.daysLeft === null ? '' : i.daysLeft === 0 ? 'Out today' : `${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'}`}</td>
            <td><input className="input" style={{ width: 80, height: 32 }} inputMode="numeric" value={counts[i.id] || ''} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value.replace(/[^\d-]/g, '') })} placeholder="Qty" aria-label={`Quantity for ${i.name}`} /></td>
            <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
              <button className="btn sm" disabled={!counts[i.id]} onClick={() => run(i, { mode: 'set', qty: Number(counts[i.id]), reason: 'count' }, `${i.name} set to ${counts[i.id]}`)}>Set count</button>
              <button className="btn sm ghost" disabled={!counts[i.id]} onClick={() => run(i, { mode: 'add', qty: Number(counts[i.id]), reason: 'delivery' }, `Added ${counts[i.id]} ${i.name}`)}>Add delivery</button>
              {i.stock !== null && <button className="btn sm ghost" onClick={() => run(i, { mode: 'untrack' }, `${i.name} no longer tracked`)}>Stop tracking</button>}
            </td>
          </tr>
        ))}</tbody>
      </table></section>
      {d.moves.length > 0 && (
        <section className="panel" style={{ marginTop: 18 }}><div className="panel-h"><h3>Recent stock changes</h3></div>
          <table className="list"><tbody>{d.moves.slice(0, 25).map((m) => <tr key={m.id}><td className="muted num">{timeOf(m.at)}</td><td>{m.item}</td><td className="num" style={{ color: m.delta < 0 ? 'var(--muted)' : 'var(--seated)' }}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td><td className="muted">{m.reason}</td><td className="muted">{m.user || ''}</td></tr>)}</tbody></table>
        </section>
      )}
    </>
  );
}

/* ================= Gift cards ================= */
export function GiftCards() {
  const { settings } = useCC();
  const toast = useToast();
  const [d, reload] = useLive(['cash'], () => api('/staff/giftcards'));
  const [code, setCode] = useState('');
  const [found, setFound] = useState(null);
  if (!d) return null;
  const check = async () => { try { setFound(await api(`/staff/giftcards/check?code=${encodeURIComponent(code)}`)); } catch (e) { toast(e.message, 'err'); setFound(null); } };
  return (
    <>
      <PageHead title="Gift cards" sub={`${money(d.outstandingCents, settings.currency)} still to be spent on active cards. Sell cards from the register, or online at your gift page.`}>
        <a className="btn" href={withLoc('/gift')} target="_blank" rel="noreferrer">Open the online gift page</a>
      </PageHead>
      <section className="panel" style={{ marginBottom: 18 }}><div className="panel-b row">
        <input className="input grow" inputMode="numeric" placeholder="Check a gift card code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Gift card code" />
        <button className="btn" onClick={check}>Check balance</button>
        {found && <span className="chip teal" style={{ fontSize: 14 }}>{money(found.balance_cents, settings.currency)} of {money(found.initial_cents, settings.currency)}{found.name ? `, ${found.name}` : ''}</span>}
      </div></section>
      <section className="panel"><table className="list">
        <thead><tr><th>Card</th><th>For</th><th>Sold</th><th>Value</th><th>Balance</th><th>Where</th><th /></tr></thead>
        <tbody>{d.cards.map((c) => (
          <tr key={c.id} style={{ opacity: c.status === 'disabled' ? 0.5 : 1 }}>
            <td className="num">…{c.code.slice(-4)}</td><td>{c.name || <span className="dim">No name</span>}</td>
            <td className="muted">{new Date(c.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()}</td>
            <td className="num">{money(c.initial_cents, settings.currency)}</td><td className="num">{money(c.balance_cents, settings.currency)}{c.status === 'active' && <button className="btn sm ghost" title="Phone wallet card for this gift card" onClick={() => api(`/staff/giftcards/${c.id}/wallet`).then((r) => { navigator.clipboard?.writeText(r.url); toast('Card link copied. Text or email it to them.', 'ok'); })}>Card link</button>}</td>
            <td className="muted" style={{ textTransform: 'capitalize' }}>{c.source}</td>
            <td style={{ textAlign: 'right' }}>{c.status === 'active' && <button className="btn sm ghost danger" onClick={() => confirm('Disable this card? Its balance can no longer be used.') && api(`/staff/giftcards/${c.id}/disable`, { method: 'POST' }).then(reload)}>Disable</button>}</td>
          </tr>
        ))}</tbody>
      </table></section>
    </>
  );
}

/* ================= Online ordering settings panel (inside Settings) ================= */
export function OnlinePanel({ f, setF }) {
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  const link = `${location.origin}${withLoc('/order')}`;
  return (
    <section className="panel"><div className="panel-h"><h3>Online ordering</h3></div><div className="panel-b stack">
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.online_enabled === '1'} onChange={flag('online_enabled')} /> Take orders online from your own page</label>
      {f.online_enabled === '1' && (
        <>
          <div className="row" style={{ fontSize: 14 }}>
            <label className="row grow"><input type="checkbox" checked={f.online_pickup === '1'} onChange={flag('online_pickup')} /> Pickup</label>
            <label className="row grow"><input type="checkbox" checked={f.online_delivery === '1'} onChange={flag('online_delivery')} /> Delivery (your own drivers)</label>
          </div>
          {f.online_delivery === '1' && (
            <>
              <div className="row">
                <label className="field grow"><span>Delivery fee</span><input className="input" inputMode="decimal" value={(Number(f.delivery_fee_cents) / 100).toFixed(2)} onChange={(e) => setF({ ...f, delivery_fee_cents: String(dollars(e.target.value)) })} /></label>
                <label className="field grow"><span>Minimum order</span><input className="input" inputMode="decimal" value={(Number(f.delivery_min_cents) / 100).toFixed(2)} onChange={(e) => setF({ ...f, delivery_min_cents: String(dollars(e.target.value)) })} /></label>
              </div>
              <label className="field"><span>Where you deliver (shown to customers)</span><input className="input" value={f.delivery_area} onChange={(e) => setF({ ...f, delivery_area: e.target.value })} maxLength={120} placeholder="Within 3 miles of Main St" /></label>
            </>
          )}
          <label className="field"><span>Usual minutes to have an order ready (busy times add more)</span><input className="input" type="number" min={1} max={180} value={f.online_prep_minutes} onChange={(e) => setF({ ...f, online_prep_minutes: e.target.value })} /></label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.online_pay_later === '1'} onChange={flag('online_pay_later')} /> Let customers pay at pickup or the door (with any way to get paid turned on, they can also pay online)</label>
          <label className="field"><span>Your ordering page</span><input className="input" readOnly value={link} onFocus={(e) => e.target.select()} /></label>
        </>
      )}
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.table_ordering === '1'} onChange={flag('table_ordering')} /> Let seated guests order from a QR code on their table</label>
      {f.table_ordering === '1' && <span className="dim" style={{ fontSize: 12.5 }}>Print each table's code from Floor: tap a table, then "Table QR code".</span>}
    </div></section>
  );
}

/* ================= Printable QR for one table ================= */
export function TableQrModal({ table, settings, onClose }) {
  const [qr, setQr] = useState(null);
  useEffect(() => { api(`/staff/tables/${table.id}/qr`).then(setQr); }, [table.id]);
  const logo = settings.logo_version && settings.logo_version !== '0' ? withLoc(`/api/public/logo?v=${settings.logo_version}`) : null;
  return (
    <Modal title={`${settings.unit_label} ${table.label} QR code`} onClose={onClose} width={480}>
      <div className="print-area"><div className="sign">
        <h2 style={{ fontSize: '1.75rem' }}>{settings.unit_label} {table.label}</h2>
        <div className="sign-qr" style={{ width: 240 }}>{qr ? <div dangerouslySetInnerHTML={{ __html: qr.svg }} /> : <div style={{ aspectRatio: 1 }} />}{logo && <span className="mark"><img src={logo} alt="" /></span>}</div>
        <p>Scan to order, call your server, or pay and split the check from your phone.</p>
      </div></div>
      <div className="row"><button className="btn grow" onClick={onClose}>Close</button><button className="btn primary grow" onClick={() => { document.body.classList.add('printing-sign'); window.addEventListener('afterprint', () => document.body.classList.remove('printing-sign'), { once: true }); window.print(); }}><Icon name="print" size={17} />Print</button></div>
    </Modal>
  );
}
