import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import Aurora from '../bits/Aurora';
import { api, applyAccent, money } from '../lib';
import { Icon, Modal, Puck, useToast } from '../ui';
import { PageHead, useCC, useLive } from './CommandCenter';
import { printPage } from '../printing';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);
const pj = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const fileToDataUrl = (file) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });

/* ================= Allergen chart (staff + public /allergens) ================= */
function ChartTable({ d }: { d?: any; }) {
  const cats = [...new Set<any>(d.items.map((i) => i.category))];
  return (
    <div className="allergen-chart">
      <table className="list"><thead><tr><th>Dish</th>{d.allergens.map((a) => <th key={a} style={{ textAlign: 'center', textTransform: 'capitalize' }}>{a}</th>)}<th>Diet</th></tr></thead>
        <tbody>{cats.map((c) => [<tr key={c} className="cat-row"><td colSpan={d.allergens.length + 2}><b>{c}</b></td></tr>, ...d.items.filter((i) => i.category === c).map((i) => (
          <tr key={i.id}><td>{i.name}</td>{d.allergens.map((a) => <td key={a} style={{ textAlign: 'center' }}>{i.allergens.includes(a) ? <b aria-label={`contains ${a}`}>●</b> : ''}</td>)}<td className="muted" style={{ fontSize: 12.5 }}>{i.diet.join(', ')}</td></tr>
        ))])}</tbody></table>
    </div>
  );
}
export function AllergenChart() {
  const toast = useToast();
  const [d] = useLive(['menu'], () => api('/staff/allergen-chart'));
  if (!d) return null;
  const link = `${location.origin}/allergens${localStorage.getItem('bh_loc') ? `?l=${localStorage.getItem('bh_loc')}` : ''}`;
  return (
    <>
      <PageHead title="Allergen chart" sub={`Every dish against every allergen. Updated ${d.updated}.${d.untagged ? ` ${d.untagged} dish${d.untagged === 1 ? ' has' : 'es have'} no allergens marked yet; set them in Menu details.` : ''}`}>
        <button className="btn" onClick={() => { navigator.clipboard?.writeText(link); toast('Customer link copied', 'ok'); }}>Copy customer link</button>
        <button className="btn primary" onClick={() => printPage('Report')}><Icon name="print" size={16} />Print</button>
      </PageHead>
      <section className="panel print-area"><div className="print-only"><h2>{d.business}: allergen chart</h2><p>Updated {d.updated}. Ask staff about cross-contact.</p></div><ChartTable d={d} /></section>
      <p className="dim" style={{ fontSize: 12.5 }}>This chart shows what you've marked in Menu details. Kitchens share equipment, so tell guests with serious allergies to speak with a manager.</p>
    </>
  );
}
export function PublicAllergens() {
  const [d, setD] = useState(null);
  useEffect(() => { api('/public/allergens').then((x) => { setD(x); document.title = `${x.business}: allergens`; }).catch(() => {}); }, []);
  if (!d) return <div className="receipt-page" />;
  return (
    <div className="receipt-page" style={{ padding: 20 }}>
      <h1 style={{ margin: '0 0 4px' }}>{d.business}</h1><p className="muted" style={{ marginTop: 0 }}>Allergen chart, updated {d.updated}. Please tell your server about any serious allergy; our kitchen shares equipment.</p>
      <ChartTable d={d} />
    </div>
  );
}

/* ================= Seating rotation (Waitlist + Floor) ================= */
export function NextUp() {
  const [d] = useLive(['tables', 'guests', 'shifts'], () => api('/staff/rotation').catch(() => null));
  if (!d || !d.servers.length) return null;
  return (
    <div className="next-up row wrap" style={{ gap: 8, marginBottom: 12 }}>
      <span className="muted" style={{ fontSize: 13.5 }}>Seat next:</span>
      {d.nextUp ? <span className="chip teal" title={`Open: ${d.nextUp.open.join(', ')}`}><b>{d.nextUp.name.split(' ')[0]}</b>&nbsp;· tables {d.nextUp.open.slice(0, 4).join(', ')}</span> : <span className="chip">Every section is full</span>}
      {d.order.slice(1, 4).map((id) => { const s = d.servers.find((x) => x.userId === id); return s ? <span key={id} className="chip">{s.name.split(' ')[0]} ({s.coversToday} covers)</span> : null; })}
      {d.unassignedOpen.length > 0 && <span className="dim" style={{ fontSize: 12.5 }}>Open, no server: {d.unassignedOpen.slice(0, 6).join(', ')}</span>}
    </div>
  );
}

/* ================= Delivery credits (Supplier bills) ================= */
export function SupplierCredits() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [list, reload] = useLive(['bills'], () => api('/staff/supplier-credits'));
  const [bills] = useLive(['bills'], () => api('/staff/supplier-bills?status=open'));
  const [f, setF] = useState(null);
  if (!list || !bills) return null;
  const save = () => api('/staff/supplier-credits', { method: 'POST', body: { supplierId: Number(f.supplierId), amountCents: dollars(f.amount), reason: f.reason, items: f.items ? f.items.split('\n').map((l) => { const m = /^\s*(\d+(?:\.\d+)?)\s+(.+)$/.exec(l); return m ? { qty: Number(m[1]), name: m[2].trim() } : { qty: 0, name: l.trim() }; }).filter((x) => x.name) : [], adjustStock: f.adjust } }).then((r) => { toast(r.appliedTo ? 'Credit saved and taken off the open bill' : 'Credit saved', 'ok'); setF(null); reload(); }).catch((e) => toast(e.message, 'err'));
  const apply = (c, billId) => api(`/staff/supplier-credits/${c.id}/apply`, { method: 'POST', body: { billId } }).then((r) => { toast(`${money(r.usedCents, cur)} taken off the bill`, 'ok'); reload(); }).catch((e) => toast(e.message, 'err'));
  const open = list.filter((c) => c.status === 'open');
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">Credits from suppliers</h3>{open.length > 0 && <span className="chip amber">{money(open.reduce((a, c) => a + c.amount_cents, 0), cur)} not used yet</span>}<button className="btn sm primary" disabled={!bills.suppliers.length} onClick={() => setF({ supplierId: bills.suppliers[0]?.id, amount: '', reason: 'short', items: '', adjust: true })}>Log a credit</button></div>
      {list.length === 0 ? <div className="panel-b muted">When a delivery is short, damaged or wrong, log the credit here. It's taken off that supplier's next bill.</div> : (
        <table className="list"><tbody>{list.slice(0, 30).map((c) => {
          const options = bills.bills.filter((b) => b.supplier_id === c.supplier_id && b.status === 'open');
          return (<tr key={c.id}><td><b>{c.supplier}</b><div className="dim" style={{ fontSize: 12, textTransform: 'capitalize' }}>{c.reason}{c.items.length ? `: ${c.items.map((i) => `${i.qty || ''} ${i.name}`.trim()).join(', ')}` : ''}</div></td><td className="num">{money(c.amount_cents, cur)}</td>
            <td>{c.status === 'applied' ? <span className="chip teal">Used on bill {c.bill_id}</span> : options.length ? <select className="input" style={{ height: 32 }} defaultValue="" onChange={(e) => e.target.value && apply(c, Number(e.target.value))} aria-label="Apply to bill"><option value="">Take off a bill…</option>{options.map((b) => <option key={b.id} value={b.id}>{b.number || `#${b.id}`}, owes {money(b.owedCents, cur)}</option>)}</select> : <span className="dim">Waiting for their next bill</span>}</td>
            <td style={{ textAlign: 'right' }}>{c.status === 'open' && <button className="btn sm ghost" onClick={() => api(`/staff/supplier-credits/${c.id}/void`, { method: 'POST' }).then(reload)}>Void</button>}</td></tr>);
        })}</tbody></table>
      )}
      {f && (
        <Modal title="Log a supplier credit" onClose={() => setF(null)} width={480}>
          <div className="row"><label className="field grow"><span>Supplier</span><select className="input" value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>{bills.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field"><span>Credit amount</span><input className="input" style={{ width: 110 }} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label></div>
          <div className="row wrap" style={{ gap: 6 }}>{['short', 'damaged', 'wrong item', 'quality', 'price error', 'returned', 'other'].map((r) => <button key={r} className={`btn sm ${f.reason === r ? 'primary' : ''}`} onClick={() => setF({ ...f, reason: r })} style={{ textTransform: 'capitalize' }}>{r}</button>)}</div>
          <label className="field"><span>What was affected (one per line, like "10 Beef patty")</span><textarea className="input" rows={3} value={f.items} onChange={(e) => setF({ ...f, items: e.target.value })} /></label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.adjust} onChange={(e) => setF({ ...f, adjust: e.target.checked })} />Take those amounts off stock (if they were already received)</label>
          <button className="btn primary lg block" disabled={!dollars(f.amount)} onClick={save}>Save credit</button>
        </Modal>
      )}
    </section>
  );
}

/* ================= Sales tax ================= */
export function SalesTax() {
  const { settings } = useCC(); const cur = settings.currency;
  const y0 = new Date().getFullYear(); const q0 = Math.ceil((new Date().getMonth() + 1) / 3);
  const [p, setP] = useState<any>({ period: 'quarter', year: y0, n: q0 });
  const qs = `period=${p.period}&year=${p.year}&n=${p.n}`;
  const [d] = useLive(['orders'], () => api(`/staff/sales-tax?${qs}`), [qs]);
  if (!d) return null;
  const t = d.totals;
  return (
    <>
      <PageHead title="Sales tax" sub={`${d.from} to ${d.periodTo}. Paid orders only, after discounts. Your tax rate is ${d.rate}%.`}>
        <div className="seg">{[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']].map(([k, l]) => <button key={k} aria-pressed={p.period === k} onClick={() => setP({ ...p, period: k, n: k === 'month' ? new Date().getMonth() + 1 : q0 })}>{l}</button>)}</div>
        {p.period !== 'year' && <select className="input" style={{ width: 110 }} value={p.n} onChange={(e) => setP({ ...p, n: Number(e.target.value) })} aria-label="Which">{(p.period === 'month' ? Array.from({ length: 12 }, (_, i) => [i + 1, new Date(2000, i, 1).toLocaleDateString([], { month: 'short' })]) : [[1, 'Q1'], [2, 'Q2'], [3, 'Q3'], [4, 'Q4']]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
        <select className="input" style={{ width: 100 }} value={p.year} onChange={(e) => setP({ ...p, year: Number(e.target.value) })} aria-label="Year">{[y0, y0 - 1, y0 - 2].map((y) => <option key={y}>{y}</option>)}</select>
        <a className="btn" href={`/api/staff/sales-tax?${qs}&format=csv`}>Download CSV</a>
      </PageHead>
      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{money(t.taxCents, cur)}</div><div className="l">Tax collected</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{money(t.taxableCents, cur)}</div><div className="l">Taxable sales</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{money(t.exemptCents, cur)}</div><div className="l">Non-taxable sales</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{money(t.netCents, cur)}</div><div className="l">Net sales</div></div>
      </div>
      <section className="panel"><table className="list"><thead><tr><th>Month</th><th>Orders</th><th>Gross</th><th>Discounts</th><th>Net</th><th>Taxable</th><th>Non-taxable</th><th>Tax</th><th>Refunds</th></tr></thead>
        <tbody>{d.months.map((m) => <tr key={m.month}><td>{new Date(`${m.month}-15T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' })}</td><td className="num">{m.orders}</td><td className="num">{money(m.grossCents, cur)}</td><td className="num muted">{money(m.discountCents, cur)}</td><td className="num">{money(m.netCents, cur)}</td><td className="num">{money(m.taxableCents, cur)}</td><td className="num muted">{money(m.exemptCents, cur)}</td><td className="num"><b>{money(m.taxCents, cur)}</b></td><td className="num muted">{money(m.refundsCents, cur)}</td></tr>)}</tbody></table></section>
      <p className="dim" style={{ fontSize: 12.5 }}>Tips and service fees are listed in the CSV and are usually not taxable; check your state's rules. Refunds shown here were given back to customers in that month. This report helps you file; it isn't tax advice.</p>
    </>
  );
}

/* ================= Stock transfers (Purchasing tab) ================= */
export function Transfers() {
  const toast = useToast();
  const [d, reload] = useLive(['menu'], () => api('/staff/transfers'));
  const [f, setF] = useState<any>({ to: '', lines: {}, note: '' });
  if (!d) return null;
  if (!d.locations.length) return <div className="panel empty"><b>Only one location</b><span>Add another location to move stock between them.</span></div>;
  const lines = Object.entries<any>(f.lines).filter(([, q]) => Number(q) > 0).map(([id, q]) => ({ ingredientId: Number(id), qty: Number(q) }));
  const send = () => api('/staff/transfers', { method: 'POST', body: { to: f.to || d.locations[0].slug, lines, note: f.note || undefined } }).then(() => { toast('Stock moved', 'ok'); setF({ to: f.to, lines: {}, note: '' }); reload(); }).catch((e) => toast(e.message, 'err'));
  return (
    <div className="grid-2">
      <section className="panel"><div className="panel-h"><h3 className="grow">Send stock to</h3><select className="input" style={{ width: 180, height: 34 }} value={f.to || d.locations[0].slug} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="Location">{d.locations.map((l) => <option key={l.slug} value={l.slug}>{l.name}</option>)}</select></div>
        <table className="list"><tbody>{d.ingredients.map((g) => <tr key={g.id}><td>{g.name}<div className="dim" style={{ fontSize: 12 }}>{g.stock === null ? 'Not tracked' : `${g.stock} ${g.unit} here`}</div></td><td><input className="input" style={{ width: 90, height: 32 }} inputMode="decimal" placeholder="0" value={f.lines[g.id] || ''} onChange={(e) => setF({ ...f, lines: { ...f.lines, [g.id]: e.target.value.replace(/[^\d.]/g, '') } })} aria-label={`${g.name} to send`} /></td><td className="muted">{g.unit}</td></tr>)}</tbody></table>
        <div className="panel-b stack"><input className="input" placeholder="Note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} /><button className="btn primary lg block" disabled={!lines.length} onClick={send}>Move {lines.length} item{lines.length === 1 ? '' : 's'}</button></div>
      </section>
      <section className="panel"><div className="panel-h"><h3>Transfers</h3></div>
        {d.history.length === 0 ? <div className="panel-b muted">None yet.</div> : <table className="list"><tbody>{d.history.map((t) => <tr key={t.id}><td>{t.direction === 'out' ? `To ${t.other_name}` : `From ${t.other_name}`}<div className="dim" style={{ fontSize: 12 }}>{t.lines.map((l) => `${l.qty} ${l.unit} ${l.name}`).join(', ')}</div></td><td className="muted" style={{ fontSize: 12.5 }}>{new Date(`${t.at.replace(' ', 'T')}Z`).toLocaleDateString()}<div>{t.user_name}</div></td></tr>)}</tbody></table>}
      </section>
    </div>
  );
}

/* ================= Staff certificates ================= */
export function Certificates() {
  const { can, user, reloadSettings } = useCC(); const toast = useToast();
  const [d, reload] = useLive(['certs'], () => api('/staff/certificates'));
  const [f, setF] = useState(null);
  if (!d) return null;
  const save = async () => { try { const r = await api('/staff/certificates', { method: 'POST', body: { userId: f.userId ? Number(f.userId) : undefined, kind: f.kind, number: f.number || undefined, issued: f.issued || '', expires: f.expires || '' } }); if (f.file) await api(`/staff/certificates/${r.id}/photo`, { method: 'PUT', body: { dataUrl: await fileToDataUrl(f.file) } }); setF(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const toggleReq = (k) => { const next = d.required.includes(k) ? d.required.filter((x) => x !== k) : [...d.required, k]; api('/staff/settings', { method: 'PUT', body: { required_certs: JSON.stringify(next) } }).then(() => { reloadSettings?.(); reload(); }); };
  const chip = (c) => (c.daysLeft === null ? <span className="chip">No expiry</span> : c.daysLeft < 0 ? <span className="chip rose">Expired {-c.daysLeft} days ago</span> : c.daysLeft <= 30 ? <span className="chip amber">Expires in {c.daysLeft} days</span> : <span className="chip teal">Good to {c.expires}</span>);
  return (
    <>
      <PageHead title="Certificates" sub="Food handler cards, alcohol server permits and other required training, with reminders 30 and 7 days before they expire.">
        <button className="btn primary" onClick={() => setF({ userId: can('manager') ? d.team[0]?.id : '', kind: d.kinds[0], number: '', issued: '', expires: '' })}>{can('manager') ? 'Add a certificate' : 'Add mine'}</button>
      </PageHead>
      {can('manager') && <section className="panel" style={{ marginBottom: 18 }}><div className="panel-h"><h3>Required for everyone</h3></div><div className="panel-b row wrap" style={{ gap: 6 }}>{d.kinds.filter((k) => k !== 'Other').map((k) => <button key={k} className={`chip ${d.required.includes(k) ? 'teal' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={d.required.includes(k)} onClick={() => toggleReq(k)}>{k}</button>)}</div>
        {d.missing.length > 0 && <div className="panel-b" style={{ paddingTop: 0 }}><b className="rose-text">Missing:</b> <span className="muted">{d.missing.map((m) => `${m.name} (${m.kind})`).join(', ')}</span></div>}</section>}
      <section className="panel">{d.certificates.length === 0 ? <div className="panel-b muted">No certificates on file yet.</div> : (
        <table className="list"><thead><tr><th>Person</th><th>Certificate</th><th>Number</th><th>Status</th><th>Checked</th><th /></tr></thead>
          <tbody>{d.certificates.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td>{c.kind}</td><td className="muted">{c.number || '—'}</td><td>{chip(c)}</td><td className="muted">{c.verified_name ? `by ${c.verified_name.split(' ')[0]}` : can('manager') ? <button className="btn sm" onClick={() => api(`/staff/certificates/${c.id}/verify`, { method: 'POST' }).then(reload)}>Mark checked</button> : 'Not yet'}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{c.photo && <a className="btn sm ghost" href={c.photo} target="_blank" rel="noreferrer">View</a>}{(can('manager') || c.user_id === user.id) && <button className="btn sm ghost" onClick={() => confirm('Remove this certificate?') && api(`/staff/certificates/${c.id}`, { method: 'DELETE' }).then(reload)}>Remove</button>}</td></tr>)}</tbody></table>
      )}</section>
      {f && (
        <Modal title="Add a certificate" onClose={() => setF(null)} width={460}>
          {can('manager') && <label className="field"><span>Person</span><select className="input" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{d.team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
          <label className="field"><span>Type</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{d.kinds.map((k) => <option key={k}>{k}</option>)}</select></label>
          <div className="row"><label className="field grow"><span>Number</span><input className="input" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} maxLength={40} /></label><label className="field grow"><span>Issued</span><input className="input" type="date" value={f.issued} onChange={(e) => setF({ ...f, issued: e.target.value })} /></label><label className="field grow"><span>Expires</span><input className="input" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></label></div>
          <label className="field"><span>Photo or PDF of the card (optional)</span><input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setF({ ...f, file: e.target.files?.[0] })} /></label>
          <button className="btn primary lg block" onClick={save}>Save</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Cash flow ================= */
export function CashFlow() {
  const { settings, reloadSettings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [days, setDays] = useState(30);
  const [d, reload] = useLive(['bills', 'shifts'], () => api(`/staff/cash-flow?days=${days}`), [days]);
  const [edit, setEdit] = useState(null);
  if (!d) return null;
  const max = Math.max(1, ...d.days.map((x) => Math.abs(x.balanceCents)));
  const saveSetup = () => api('/staff/settings', { method: 'PUT', body: { cash_balance_cents: String(dollars(edit.bal)), cash_balance_on: new Date().toLocaleDateString('en-CA'), fixed_costs: JSON.stringify(edit.fixed.filter((x) => x.name && dollars(x.amount)).map((x) => ({ name: x.name, cents: dollars(x.amount), day: Number(x.day) || 1 }))), payroll_dow: String(edit.payDow), payroll_every: edit.payEvery } }).then(() => { reloadSettings?.(); setEdit(null); reload(); }).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <PageHead title="Cash flow" sub={`Starting from ${money(d.startCents, cur)}${d.asOf ? ` in the bank on ${d.asOf}` : ' (set your bank balance)'}. Expected sales come from the same weekday over the last 8 weeks.`}>
        <div className="seg">{[30, 60, 90].map((n) => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>)}</div>
        <button className="btn primary" onClick={() => setEdit({ bal: (d.startCents / 100).toFixed(2), fixed: (d.fixed.length ? d.fixed : [{ name: 'Rent', cents: 0, day: 1 }]).map((x) => ({ name: x.name, amount: (x.cents / 100).toFixed(2), day: x.day })), payDow: Number(settings.payroll_dow ?? 5), payEvery: settings.payroll_every || 'weekly' })}>Bank balance and fixed costs</button>
      </PageHead>
      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem', color: d.low.cents < 0 ? 'var(--dirty)' : undefined }}>{money(d.low.cents, cur)}</div><div className="l">Lowest point, {new Date(`${d.low.date}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{money(d.days[d.days.length - 1].balanceCents, cur)}</div><div className="l">In {days} days</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{money(d.billsCents, cur)}</div><div className="l">Supplier bills still owed</div></div>
        <div className="kpi"><div className="v" style={{ fontSize: '1.7rem' }}>{money(d.laborPerDayCents, cur)}</div><div className="l">Average labor per day</div></div>
      </div>
      {d.low.cents < 0 && <div className="ticket-allergy" style={{ marginBottom: 12 }}>You could run short around {new Date(`${d.low.date}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}. Move a bill, ask a supplier for more time, or plan for the gap.</div>}
      <section className="panel"><div className="cashflow-bars">{d.days.map((x) => <div key={x.date} className={`cf-bar ${x.balanceCents < 0 ? 'neg' : ''}`} style={{ height: `${Math.max(2, Math.abs(x.balanceCents) / max * 100)}%` }} title={`${x.date}: ${money(x.balanceCents, cur)}`} />)}</div>
        <table className="list"><tbody>{d.days.filter((x) => x.items.some((i) => i.cents < 0)).map((x) => <tr key={x.date}><td>{new Date(`${x.date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</td><td className="muted" style={{ fontSize: 13 }}>{x.items.filter((i) => i.cents < 0).map((i) => `${i.label} ${money(-i.cents, cur)}`).join(', ')}</td><td className="num"><b style={{ color: x.balanceCents < 0 ? 'var(--dirty)' : undefined }}>{money(x.balanceCents, cur)}</b></td></tr>)}</tbody></table>
      </section>
      <p className="dim" style={{ fontSize: 12.5 }}>An estimate, not a guarantee. Payroll uses the schedule where there is one, otherwise your average labor.</p>
      {edit && (
        <Modal title="Bank balance and fixed costs" onClose={() => setEdit(null)} width={520}>
          <label className="field"><span>Money in the bank today</span><input className="input" inputMode="decimal" value={edit.bal} onChange={(e) => setEdit({ ...edit, bal: e.target.value })} /></label>
          <div className="row"><label className="field grow"><span>Payday</span><select className="input" value={edit.payDow} onChange={(e) => setEdit({ ...edit, payDow: Number(e.target.value) })}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((x, i) => <option key={x} value={i}>{x}</option>)}</select></label><label className="field grow"><span>How often</span><select className="input" value={edit.payEvery} onChange={(e) => setEdit({ ...edit, payEvery: e.target.value })}><option value="weekly">Every week</option><option value="biweekly">Every 2 weeks</option></select></label></div>
          <b>Fixed monthly costs</b>
          {edit.fixed.map((x, i) => <div key={i} className="row"><input className="input grow" placeholder="Rent, loan, insurance" value={x.name} onChange={(e) => setEdit({ ...edit, fixed: edit.fixed.map((y, k) => (k === i ? { ...y, name: e.target.value } : y)) })} aria-label="Name" /><input className="input" style={{ width: 100 }} inputMode="decimal" placeholder="Amount" value={x.amount} onChange={(e) => setEdit({ ...edit, fixed: edit.fixed.map((y, k) => (k === i ? { ...y, amount: e.target.value } : y)) })} aria-label="Amount" /><input className="input" style={{ width: 70 }} type="number" min={1} max={28} value={x.day} onChange={(e) => setEdit({ ...edit, fixed: edit.fixed.map((y, k) => (k === i ? { ...y, day: e.target.value } : y)) })} aria-label="Day of month" /><button className="btn sm ghost" onClick={() => setEdit({ ...edit, fixed: edit.fixed.filter((_, k) => k !== i) })}>Remove</button></div>)}
          <button className="btn" onClick={() => setEdit({ ...edit, fixed: [...edit.fixed, { name: '', amount: '', day: 1 }] })}>Add a cost</button>
          <button className="btn primary lg block" onClick={saveSetup}>Save</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Delivery zones (map editor) ================= */
export function DeliveryZones() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [d, reload] = useLive([], () => api('/staff/delivery-zones'));
  const [draft, setDraft] = useState(null); // { id?, name, fee, min, points: [] }
  const el = useRef<any>(null); const map = useRef<any>(null); const layers = useRef<any>(null); const draftRef = useRef<any>(null);
  draftRef.current = draft;
  useEffect(() => {
    if (!d || map.current || !el.current) return;
    map.current = L.map(el.current).setView(d.zones[0]?.points[0] || [40.7128, -74.006], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
    layers.current = L.layerGroup().addTo(map.current);
    map.current.on('click', (e) => { if (draftRef.current) setDraft({ ...draftRef.current, points: [...draftRef.current.points, [Math.round(e.latlng.lat * 1e5) / 1e5, Math.round(e.latlng.lng * 1e5) / 1e5]] }); });
    if (d.address && !d.zones.length) api('/staff/delivery-zones/geocode', { method: 'POST', body: { address: d.address } }).then((p) => map.current?.setView([p.lat, p.lng], 13)).catch(() => {});
  }, [d]);
  useEffect(() => {
    if (!layers.current || !d) return;
    layers.current.clearLayers();
    const colors = ['#ffb020', '#3cb4a0', '#6aa5ff', '#e5534b', '#b38cff'];
    d.zones.filter((z) => !draft || z.id !== draft.id).forEach((z, i) => L.polygon(z.points, { color: z.color || colors[i % colors.length], weight: 2, fillOpacity: z.active ? 0.18 : 0.05 }).bindTooltip(`${z.name}: ${money(z.fee_cents, cur)} fee, ${money(z.min_cents, cur)} min`).addTo(layers.current));
    if (draft?.points.length) { L.polygon(draft.points, { color: '#ffffff', dashArray: '6 6', weight: 2, fillOpacity: 0.12 }).addTo(layers.current); draft.points.forEach((p) => L.circleMarker(p, { radius: 5, color: '#fff' }).addTo(layers.current)); }
  }, [d, draft, cur]);
  if (!d) return null;
  const save = () => api(draft.id ? `/staff/delivery-zones/${draft.id}` : '/staff/delivery-zones', { method: draft.id ? 'PUT' : 'POST', body: { name: draft.name, points: draft.points, feeCents: dollars(draft.fee), minCents: dollars(draft.min) } }).then(() => { setDraft(null); reload(); }).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <PageHead title="Delivery zones" sub="Draw the areas you deliver to. Each zone has its own fee and minimum. Addresses outside every zone are offered pickup instead. With no zones, your regular delivery fee applies everywhere.">
        {!draft && <button className="btn primary" onClick={() => setDraft({ name: `Zone ${d.zones.length + 1}`, fee: '3.99', min: '15', points: [] })}>Draw a zone</button>}
      </PageHead>
      {draft && <section className="panel" style={{ marginBottom: 12 }}><div className="panel-b row wrap">
        <span className="muted grow" style={{ fontSize: 14 }}>Click the map to add corners ({draft.points.length} so far, at least 3).</span>
        <input className="input" style={{ width: 140 }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Zone name" />
        <label className="row" style={{ fontSize: 13 }}>Fee <input className="input" style={{ width: 80 }} inputMode="decimal" value={draft.fee} onChange={(e) => setDraft({ ...draft, fee: e.target.value })} /></label>
        <label className="row" style={{ fontSize: 13 }}>Minimum <input className="input" style={{ width: 80 }} inputMode="decimal" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} /></label>
        <button className="btn" disabled={!draft.points.length} onClick={() => setDraft({ ...draft, points: draft.points.slice(0, -1) })}>Undo corner</button>
        <button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={draft.points.length < 3 || !draft.name} onClick={save}>Save zone</button>
      </div></section>}
      <div ref={el} className="zone-map" />
      {d.zones.length > 0 && <section className="panel" style={{ marginTop: 12 }}><table className="list"><tbody>{d.zones.map((z) => <tr key={z.id} style={{ opacity: z.active ? 1 : 0.5 }}><td><b>{z.name}</b></td><td className="num">{money(z.fee_cents, cur)} fee</td><td className="num">{money(z.min_cents, cur)} minimum</td>
        <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setDraft({ id: z.id, name: z.name, fee: (z.fee_cents / 100).toFixed(2), min: (z.min_cents / 100).toFixed(2), points: z.points })}>Edit</button><button className="btn sm ghost" onClick={() => api(`/staff/delivery-zones/${z.id}`, { method: 'PUT', body: { name: z.name, points: z.points, feeCents: z.fee_cents, minCents: z.min_cents, active: !z.active } }).then(reload)}>{z.active ? 'Turn off' : 'Turn on'}</button><button className="btn sm ghost" onClick={() => confirm(`Delete ${z.name}?`) && api(`/staff/delivery-zones/${z.id}`, { method: 'DELETE' }).then(reload)}>Delete</button></td></tr>)}</tbody></table></section>}
    </>
  );
}
/** Online checkout: shows the zone fee for the typed address, or that it's outside the area. */
export function useDeliveryQuote(address, enabled) {
  const [q, setQ] = useState(null);
  useEffect(() => {
    if (!enabled || !address || address.length < 8) { setQ(null); return undefined; }
    const t = setTimeout(() => api('/o/delivery-quote', { method: 'POST', body: { address } }).then(setQ).catch(() => setQ(null)), 700);
    return () => clearTimeout(t);
  }, [address, enabled]);
  return q;
}

/* ================= Catering follow-up (public /rate/:token + list) ================= */
export function RateCatering() {
  const { token } = useParams();
  const [d, setD] = useState(null); const [rating, setRating] = useState(0); const [comment, setComment] = useState(''); const [sent, setSent] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { api(`/i/${token}/feedback`).then((x) => { setD(x); applyAccent(x.business.accent); }).catch((e) => setErr(e.message)); }, [token]);
  if (!d) return <div className="guest">{err && <main className="guest-in"><h1>{err}</h1></main>}</div>;
  const send = () => api(`/i/${token}/feedback`, { method: 'POST', body: { rating, comment: comment || undefined } }).then(setSent).catch((e) => setErr(e.message));
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.business.accent, '#2a1f55', d.business.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in">
        <Puck state="buzzed" size={44} />
        <h1>{sent || d.rated ? 'Thank you!' : `How was your catering, ${d.name.split(' ')[0]}?`}</h1>
        {sent || d.rated ? (
          <div className="stack" style={{ width: '100%' }}>
            <p>We read every note.</p>
            {sent?.review && <a className="btn primary lg block" href={sent.review} target="_blank" rel="noreferrer">Share it in a review</a>}
            <a className="btn lg block" href={d.rebook}>Plan your next event</a>
          </div>
        ) : (
          <div className="card stack" style={{ width: '100%' }}>
            <span className="muted">{d.title}</span>
            <div className="stars" role="radiogroup" aria-label="Rating">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className={`star ${n <= rating ? 'on' : ''}`} role="radio" aria-checked={n === rating} aria-label={`${n} star${n === 1 ? '' : 's'}`} onClick={() => setRating(n)}>★</button>)}</div>
            <textarea className="input" rows={3} placeholder="Anything we should know? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={800} />
            {err && <div className="lock-msg">{err}</div>}
            <button className="btn primary lg block" disabled={!rating} onClick={send}>Send</button>
          </div>
        )}
      </main>
    </div>
  );
}
export function CateringFeedback() {
  const [list] = useLive(['invoices'], () => api('/staff/catering-feedback').catch(() => []));
  const rated = (list || []).filter((f) => f.rating);
  if (!rated.length) return null;
  return (
    <section className="panel" style={{ marginTop: 18 }}><div className="panel-h"><h3 className="grow">Catering ratings</h3><span className="chip teal">{(rated.reduce((a, f) => a + f.rating, 0) / rated.length).toFixed(1)} average</span></div>
      <table className="list"><tbody>{rated.map((f) => <tr key={f.invoice_id}><td><b>{f.customer_name}</b><div className="dim" style={{ fontSize: 12 }}>{f.title}</div></td><td>{'★'.repeat(f.rating)}<span className="dim">{'★'.repeat(5 - f.rating)}</span></td><td className="muted" style={{ fontSize: 13.5 }}>{f.comment}</td></tr>)}</tbody></table>
    </section>
  );
}

/* ================= Settings panel ================= */
export function DeskPanel({ f, setF }: { f?: any; setF?: any; }) {
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  return (
    <section className="panel"><div className="panel-h"><h3>Time clock and follow-ups</h3></div><div className="panel-b stack">
      <label className="field"><span>Message on the time clock screen (optional)</span><input className="input" value={f.clock_message} onChange={(e) => setF({ ...f, clock_message: e.target.value })} maxLength={120} placeholder="Wash your hands before your shift" /></label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.app_punch === '1'} onChange={flag('app_punch')} /> Let staff clock in and out from their own phone (My shifts). Off means PIN at the lock screen or time clock only.</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.catering_followup === '1'} onChange={flag('catering_followup')} /> Email catering customers a thank-you and rating request the day after their event</label>
    </div></section>
  );
}
