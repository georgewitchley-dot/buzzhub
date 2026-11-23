import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Aurora from '../bits/Aurora';
import { api, applyAccent, money } from '../lib';
import { Icon, Modal, Puck, useToast } from '../ui';
import { PageHead, useCC, useLive } from './CommandCenter';
import { CateringPackages } from './Smart';
import { CateringFeedback } from './Desk';
import { LangSwitch, useLang } from '../i18n';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);
export const ALLERGENS = ['milk', 'eggs', 'fish', 'shellfish', 'tree nuts', 'peanuts', 'wheat', 'soy', 'sesame'];
const allergyFromTags = (tags = []) => ALLERGENS.filter((a) => tags.some((t) => t.toLowerCase().includes(a.replace('tree ', '')) || (a === 'wheat' && /gluten/i.test(t)) || (a === 'milk' && /dairy|lactose/i.test(t)) || (a === 'peanuts' && /\bnut/i.test(t))));

/* ================= Register: find a customer, member price, perks, allergies ================= */
export function CustomerPicker({ value, onChange, allergies, setAllergies, currency }: { value?: any; onChange?: any; allergies?: any; setAllergies?: any; currency?: any; }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [sell, setSell] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return undefined; }
    const id = setTimeout(() => api(`/staff/customer-search?q=${encodeURIComponent(q.trim())}`).then((r) => { setHits(r); if (r.length === 1 && q.startsWith('BH-C-')) { pick(r[0]); } }).catch(() => {}), 250);
    return () => clearTimeout(id);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (c) => { onChange(c); setQ(''); setHits([]); setAllergies([...new Set<any>([...allergies, ...allergyFromTags(c.tags)])]); };
  const perk = async () => { try { const r = await api(`/staff/memberships/${value.member.id}/perk`, { method: 'POST' }); onChange({ ...value, member: { ...value.member, perksLeft: r.left } }); toast(`${value.member.perkName || 'Perk'} used. ${r.left} left.`, 'ok'); } catch (e) { toast(e.message, 'err'); } };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value ? (
        <div className="card cust-chip">
          <div className="row"><b className="grow">{value.name}</b><button className="btn ghost sm" onClick={() => { onChange(null); setAllergies([]); }} aria-label="Remove customer"><Icon name="x" size={14} /></button></div>
          <div className="row wrap" style={{ gap: 6 }}>
            {value.member ? <span className={`chip ${value.member.good ? 'teal' : 'amber'}`}>{value.member.plan}{value.member.good ? `: ${value.member.discountPct}% off` : ': needs renewal'}</span> : <button className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => setSell(true)}>Not a member: sell a plan</button>}
            {value.tags.map((t) => <span key={t} className={`chip ${/allerg|free|vegan/i.test(t) ? 'rose' : ''}`}>{t}</span>)}
          </div>
          {value.member?.good && value.member.perksLeft !== undefined && value.member.perkName && <button className="btn sm" disabled={!value.member.perksLeft} onClick={perk}>Use a {value.member.perkName.replace(/s$/, '').toLowerCase()} ({value.member.perksLeft} left)</button>}
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <input className="input" placeholder="Find a customer or scan their card" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a customer" />
          {hits.length > 0 && <div className="hits">{hits.map((c) => <button key={c.id} onClick={() => pick(c)}><b>{c.name}</b><small>{[c.member?.plan, c.phone || c.email, c.visits ? `${c.visits} visits` : ''].filter(Boolean).join(' · ')}</small></button>)}</div>}
        </div>
      )}
      <div className="row wrap" style={{ gap: 4 }}>
        <span className="muted" style={{ fontSize: 13 }}>Allergies:</span>
        {ALLERGENS.map((a) => <button key={a} className={`chip ${allergies.includes(a) ? 'rose' : ''}`} style={{ cursor: 'pointer', border: 0 }} aria-pressed={allergies.includes(a)} onClick={() => setAllergies(allergies.includes(a) ? allergies.filter((x) => x !== a) : [...allergies, a])}>{a}</button>)}
      </div>
      {sell && <SellPlanModal customer={value} currency={currency} onClose={(m) => { setSell(false); if (m) onChange({ ...value, member: { id: m.id, plan: m.plan_name, good: m.good, discountPct: m.discount_pct, perkName: m.perk_name, perksLeft: m.perksLeft } }); }} />}
    </div>
  );
}
function SellPlanModal({ customer, currency, onClose }: { customer?: any; currency?: any; onClose?: any; }) {
  const toast = useToast();
  const [d] = useLive(['members'], () => api('/staff/memberships').catch(() => ({ plans: [] })));
  const [planId, setPlanId] = useState(null);
  const [method, setMethod] = useState('cash');
  if (!d) return null;
  const plans = d.plans.filter((p) => p.active);
  const sell = async () => { try { const m = await api('/staff/memberships', { method: 'POST', body: { customerId: customer.id, planId, method } }); toast(`${customer.name} joined ${m.plan_name}`, 'ok'); onClose(m); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`Membership for ${customer.name}`} onClose={() => onClose(null)} width={460}>
      {plans.length === 0 ? <p className="muted">No plans yet. A manager can add them under Memberships.</p> : plans.map((p) => (
        <button key={p.id} className={`pay-opt ${planId === p.id ? 'cheap' : ''}`} onClick={() => setPlanId(p.id)}><span className="grow"><b>{p.name}</b><small>{[p.discount_pct ? `${p.discount_pct}% off` : '', p.perk_qty ? `${p.perk_qty} ${p.perk_name || 'perks'}` : ''].filter(Boolean).join(', ')}</small></span><b>{money(p.price_cents, currency)}/{p.period}</b></button>
      ))}
      <div className="seg" style={{ width: '100%' }}>{['cash', 'card', 'other'].map((m) => <button key={m} aria-pressed={method === m} onClick={() => setMethod(m)} style={{ flex: 1, textTransform: 'capitalize' }}>{m}</button>)}</div>
      <button className="btn primary lg block" disabled={!planId} onClick={sell}>Take payment and start</button>
    </Modal>
  );
}

/* ================= Memberships (manager) ================= */
function PlanModal({ plan, currency, onClose }: { plan?: any; currency?: any; onClose?: any; }) {
  const toast = useToast();
  const [f, setF] = useState(plan ? { name: plan.name, description: plan.description || '', price: (plan.price_cents / 100).toFixed(2), period: plan.period, discount: String(plan.discount_pct), perkName: plan.perk_name || '', perkQty: String(plan.perk_qty) } : { name: '', description: '', price: '', period: 'month', discount: '10', perkName: '', perkQty: '0' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (active?) => { try { await api(plan ? `/staff/membership-plans/${plan.id}` : '/staff/membership-plans', { method: plan ? 'PUT' : 'POST', body: { name: f.name, description: f.description || undefined, priceCents: dollars(f.price), period: f.period, discountPct: Number(f.discount) || 0, perkName: f.perkName || undefined, perkQty: Number(f.perkQty) || 0, ...(active !== undefined ? { active } : {}) } }); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={plan ? `Edit ${plan.name}` : 'New membership plan'} onClose={onClose} width={500}>
      <label className="field"><span>Name</span><input className="input" value={f.name} onChange={set('name')} maxLength={50} placeholder="Coffee Club, Unlimited Washes, VIP" /></label>
      <label className="field"><span>What members get (shown to customers)</span><input className="input" value={f.description} onChange={set('description')} maxLength={200} /></label>
      <div className="row"><label className="field grow"><span>Price ({currency})</span><input className="input" inputMode="decimal" value={f.price} onChange={set('price')} /></label>
        <label className="field grow"><span>Every</span><select className="input" value={f.period} onChange={set('period')}><option value="month">Month</option><option value="year">Year</option></select></label></div>
      <div className="row"><label className="field grow"><span>Member discount on everything (%)</span><input className="input" type="number" min={0} max={50} value={f.discount} onChange={set('discount')} /></label></div>
      <div className="row"><label className="field grow"><span>Included perk (optional)</span><input className="input" value={f.perkName} onChange={set('perkName')} maxLength={40} placeholder="Free drinks, Washes, Blowouts" /></label>
        <label className="field" style={{ width: 120 }}><span>How many each {f.period}</span><input className="input" type="number" min={0} max={100} value={f.perkQty} onChange={set('perkQty')} /></label></div>
      <button className="btn primary lg block" disabled={!f.name || dollars(f.price) < 100} onClick={() => save()}>Save plan</button>
      {plan && <button className="btn ghost block" onClick={() => save(!plan.active)}>{plan.active ? 'Stop selling this plan' : 'Sell this plan again'}</button>}
    </Modal>
  );
}
export function Memberships() {
  const { settings } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [d, reload] = useLive(['members'], () => api('/staff/memberships'));
  const [edit, setEdit] = useState(undefined);
  if (!d) return null;
  const active = d.members.filter((m) => m.status === 'active');
  return (
    <>
      <PageHead title="Memberships" sub={`${active.length} active member${active.length === 1 ? '' : 's'}, about ${money(d.monthlyCents, cur)} a month. Members get their discount at the register when you find them on the ticket.`}>
        <button className="btn primary" onClick={() => setEdit(null)}>New plan</button>
      </PageHead>
      <div className="grid-3" style={{ marginBottom: 18 }}>
        {d.plans.map((p) => (
          <button key={p.id} className="panel plan-card" style={{ opacity: p.active ? 1 : 0.55 }} onClick={() => setEdit(p)}>
            <b style={{ fontSize: 18 }}>{p.name}</b><span className="num" style={{ fontSize: 24, fontWeight: 800 }}>{money(p.price_cents, cur)}<small className="muted">/{p.period}</small></span>
            <span className="muted" style={{ fontSize: 14 }}>{[p.discount_pct ? `${p.discount_pct}% off everything` : '', p.perk_qty ? `${p.perk_qty} ${p.perk_name || 'perks'} a ${p.period}` : ''].filter(Boolean).join(', ') || 'No perks yet'}</span>
            <span className="chip teal" style={{ justifySelf: 'start' }}>{p.members} member{p.members === 1 ? '' : 's'}</span>
          </button>
        ))}
        {d.plans.length === 0 && <div className="panel empty"><b>No plans yet</b><span>Ideas: a coffee club with free drinks, unlimited washes, a monthly blowout, VIP tables. Customers join from their account and renew with a tap.</span></div>}
      </div>
      {d.members.length > 0 && (
        <section className="panel"><table className="list"><thead><tr><th>Member</th><th>Plan</th><th>Status</th><th>Good until</th><th>Perks used</th><th /></tr></thead>
          <tbody>{d.members.map((m) => (
            <tr key={m.id}><td><b>{m.name}</b><div className="dim" style={{ fontSize: 12.5 }}>{m.email}</div></td><td>{m.plan_name}</td>
              <td><span className={`chip ${m.status === 'active' ? 'teal' : m.status === 'past_due' ? 'amber' : ''}`}>{m.status === 'past_due' ? 'Needs renewal' : m.cancel_at_end ? 'Ending' : m.status}</span></td>
              <td className="muted">{m.current_until || ''}</td><td className="num">{m.perk_qty ? `${m.perks_used} of ${m.perk_qty}` : ''}</td>
              <td style={{ textAlign: 'right' }}>{m.status !== 'cancelled' && <button className="btn sm ghost danger" onClick={() => confirm(`Cancel ${m.name}'s membership now?`) && api(`/staff/memberships/${m.id}/cancel`, { method: 'POST' }).then(reload).catch((e) => toast(e.message, 'err'))}>Cancel</button>}</td></tr>
          ))}</tbody></table></section>
      )}
      {edit !== undefined && <PlanModal plan={edit} currency={cur} onClose={() => { setEdit(undefined); reload(); }} />}
    </>
  );
}

/* ================= Catering quotes and invoices (manager) ================= */
function InvoiceModal({ inv, menu, settings, onClose }: { inv?: any; menu?: any; settings?: any; onClose?: any; }) {
  const toast = useToast();
  const cur = settings.currency;
  const [f, setF] = useState(inv ? { title: inv.title, customerName: inv.customer_name, email: inv.email || '', phone: inv.phone || '', eventDate: inv.event_date || '', eventNotes: inv.event_notes || '', dueDate: inv.due_date || '', lines: inv.lines.map((l) => ({ ...l, price: (l.cents / 100).toFixed(2) })), taxRate: String(inv.tax_rate), depositPct: String(inv.deposit_pct), fee: ((inv.fee_cents || 0) / 100).toFixed(2) }
    : { title: '', customerName: '', email: '', phone: '', eventDate: '', eventNotes: '', dueDate: '', lines: [{ name: '', qty: 1, price: '' }], taxRate: settings.tax_rate, depositPct: '25', fee: '0.00' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setLine = (i, k, v) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const sub = f.lines.reduce((a, l) => a + Math.round((Number(l.qty) || 0) * dollars(l.price)), 0);
  const tax = Math.round(sub * (Number(f.taxRate) || 0) / 100); const total = sub + tax + dollars(f.fee);
  const save = async () => {
    const body = { title: f.title, customerName: f.customerName, email: f.email, phone: f.phone || undefined, eventDate: f.eventDate, eventNotes: f.eventNotes || undefined, dueDate: f.dueDate, lines: f.lines.filter((l) => l.name.trim()).map((l) => ({ name: l.name.trim(), qty: Number(l.qty) || 1, cents: dollars(l.price) })), taxRate: Number(f.taxRate) || 0, depositPct: Number(f.depositPct) || 0, feeCents: dollars(f.fee) };
    try { await api(inv ? `/staff/invoices/${inv.id}` : '/staff/invoices', { method: inv ? 'PUT' : 'POST', body }); onClose(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title={inv ? `Edit ${inv.title}` : 'New quote'} onClose={onClose} width={680}>
      <div className="row"><label className="field grow"><span>What it's for</span><input className="input" value={f.title} onChange={set('title')} maxLength={80} placeholder="Office lunch for 40" /></label><label className="field" style={{ width: 170 }}><span>Event date</span><input className="input" type="date" value={f.eventDate} onChange={set('eventDate')} /></label></div>
      <div className="row"><label className="field grow"><span>Customer</span><input className="input" value={f.customerName} onChange={set('customerName')} maxLength={80} /></label><label className="field grow"><span>Email</span><input className="input" type="email" value={f.email} onChange={set('email')} /></label><label className="field" style={{ width: 150 }}><span>Phone</span><input className="input" value={f.phone} onChange={set('phone')} /></label></div>
      <div className="field"><span>Items</span>
        {f.lines.map((l, i) => (
          <div key={i} className="row"><input className="input grow" list="menu-names" value={l.name} onChange={(e) => { const m = menu.find((x) => x.name === e.target.value); setLine(i, 'name', e.target.value); if (m && !l.price) setLine(i, 'price', (m.price_cents / 100).toFixed(2)); }} placeholder="Item or service" aria-label="Item" />
            <input className="input" style={{ width: 70 }} inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} aria-label="Quantity" /><span className="muted">×</span>
            <input className="input" style={{ width: 100 }} inputMode="decimal" value={l.price} onChange={(e) => setLine(i, 'price', e.target.value)} placeholder="Price" aria-label="Price each" />
            <button className="btn ghost sm" onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })} aria-label="Remove"><Icon name="x" size={15} /></button></div>
        ))}
        <datalist id="menu-names">{menu.map((m) => <option key={m.id} value={m.name} />)}</datalist>
        <button className="btn sm" onClick={() => setF({ ...f, lines: [...f.lines, { name: '', qty: 1, price: '' }] })}>Add a line</button>
      </div>
      <div className="row"><label className="field grow"><span>Tax %</span><input className="input" inputMode="decimal" value={f.taxRate} onChange={set('taxRate')} /></label><label className="field grow"><span>Delivery or service fee</span><input className="input" inputMode="decimal" value={f.fee} onChange={set('fee')} /></label><label className="field grow"><span>Deposit to confirm (%)</span><input className="input" inputMode="decimal" value={f.depositPct} onChange={set('depositPct')} /></label><label className="field grow"><span>Balance due by</span><input className="input" type="date" value={f.dueDate} onChange={set('dueDate')} /></label></div>
      <label className="field"><span>Notes for the customer</span><textarea className="input" rows={2} value={f.eventNotes} onChange={set('eventNotes')} maxLength={500} placeholder="Delivery at 11:30 to 5th floor. Includes plates and napkins." /></label>
      <div className="totals"><div><span>Subtotal</span><span>{money(sub, cur)}</span></div><div><span>Tax</span><span>{money(tax, cur)}</span></div><div className="grand"><span>Total</span><span>{money(total, cur)}</span></div>{Number(f.depositPct) > 0 && <div><span>Deposit</span><span>{money(Math.round(total * Number(f.depositPct) / 100), cur)}</span></div>}</div>
      <button className="btn primary lg block" disabled={!f.title || !f.customerName || !sub} onClick={save}>Save</button>
    </Modal>
  );
}
function InvPayModal({ inv, currency, onClose }: { inv?: any; currency?: any; onClose?: any; }) {
  const toast = useToast();
  const [amt, setAmt] = useState((inv.dueCents / 100).toFixed(2));
  const [method, setMethod] = useState('check');
  const save = async () => { try { await api(`/staff/invoices/${inv.id}/payment`, { method: 'POST', body: { cents: dollars(amt), method } }); toast('Payment recorded', 'ok'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`Record a payment on ${inv.title}`} onClose={onClose} width={420}>
      <div className="totals"><div><span>Still owed</span><span>{money(inv.dueCents, currency)}</span></div></div>
      <input className="input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount" />
      <div className="seg" style={{ width: '100%' }}>{['check', 'cash', 'card', 'bank', 'other'].map((m) => <button key={m} aria-pressed={method === m} onClick={() => setMethod(m)} style={{ flex: 1, textTransform: 'capitalize' }}>{m}</button>)}</div>
      <button className="btn primary lg block" disabled={dollars(amt) <= 0} onClick={save}>Record</button>
    </Modal>
  );
}
export function Catering() {
  const { settings } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [d, reload] = useLive(['invoices'], () => api('/staff/invoices'));
  const [menu] = useLive(['menu'], () => api('/staff/menu'));
  const [edit, setEdit] = useState(undefined);
  const [paying, setPaying] = useState(null);
  if (!d || !menu) return null;
  const send = async (inv) => { try { const r = await api(`/staff/invoices/${inv.id}/send`, { method: 'POST' }); navigator.clipboard?.writeText(r.link).catch(() => {}); toast(r.emailed ? `Emailed to ${inv.email}. Link copied too.` : 'Link copied. Text or email it to the customer.', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  const label = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', deposit_paid: 'Deposit paid', paid: 'Paid', cancelled: 'Cancelled' };
  const open = d.invoices.filter((i) => !['paid', 'cancelled'].includes(i.status));
  return (
    <>
      <PageHead title="Catering and invoices" sub={`${open.length} open, ${money(open.reduce((a, i) => a + i.dueCents, 0), cur)} still owed. Customers accept and pay online${d.payOnline ? '' : ' once a way to get paid is set up'}.`}>
        <button className="btn primary" onClick={() => setEdit(null)}>New quote</button>
      </PageHead>
      <section className="panel">
        {d.invoices.length === 0 ? <div className="panel-b muted">Quote big orders, events, parties or services. Send a link, the customer accepts and pays a deposit, then the balance.</div> : (
          <table className="list"><thead><tr><th>Quote</th><th>Customer</th><th>Event</th><th>Total</th><th>Paid</th><th>Status</th><th /></tr></thead>
            <tbody>{d.invoices.map((i) => (
              <tr key={i.id} style={{ opacity: i.status === 'cancelled' ? 0.5 : 1 }}>
                <td><b>{i.title}</b>{i.accepted_name && <div className="dim" style={{ fontSize: 12.5 }}>Accepted by {i.accepted_name}</div>}</td><td>{i.customer_name}</td><td className="muted">{i.event_date || ''}</td>
                <td className="num">{money(i.totalCents, cur)}</td><td className="num">{money(i.paidCents, cur)}</td>
                <td><span className={`chip ${i.status === 'paid' ? 'teal' : ['accepted', 'deposit_paid'].includes(i.status) ? 'blue' : i.status === 'sent' ? 'amber' : ''}`}>{label[i.status]}</span></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {!['paid', 'cancelled'].includes(i.status) && <><button className="btn sm" onClick={() => send(i)}>{i.status === 'draft' ? 'Send' : 'Send again'}</button><button className="btn sm ghost" onClick={() => setPaying(i)}>Record payment</button><button className="btn sm ghost" onClick={() => setEdit(i)}>Edit</button></>}
                  <a className="btn sm ghost" href={i.link} target="_blank" rel="noreferrer">View</a>
                  {!['paid', 'cancelled'].includes(i.status) && <button className="btn sm ghost danger" onClick={() => confirm('Cancel this quote?') && api(`/staff/invoices/${i.id}/cancel`, { method: 'POST' }).then(reload)}>Cancel</button>}
                </td></tr>
            ))}</tbody></table>
        )}
      </section>
      {edit !== undefined && <InvoiceModal inv={edit} menu={menu} settings={settings} onClose={() => { setEdit(undefined); reload(); }} />}
      {paying && <InvPayModal inv={paying} currency={cur} onClose={() => { setPaying(null); reload(); }} />}
      <CateringPackages />
      <CateringFeedback />
    </>
  );
}

/* ================= Customer-facing invoice page ================= */
export function InvoicePage() {
  const { token } = useParams();
  const { lang, setLang, t } = useLang();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api(`/i/${token}`).then((x) => { setD(x); applyAccent(x.business.accent); document.title = `${x.title}, ${x.business.name}`; }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="receipt-page"><div className="receipt"><h2>{err}</h2></div></div>;
  if (!d) return <div className="receipt-page" />;
  const cur = d.currency;
  const accept = async () => { setBusy(true); try { await api(`/i/${token}/accept`, { method: 'POST', body: { name } }); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const pay = async (part) => { setBusy(true); try { const r = await api(`/i/${token}/pay`, { method: 'POST', body: { part } }); location.href = r.url; } catch (e) { alert(e.message); setBusy(false); } };
  return (
    <div className="receipt-page">
      <div className="stack" style={{ width: '100%', maxWidth: 560 }}>
        <div className="no-print" style={{ justifySelf: 'end' }}><LangSwitch lang={lang} setLang={setLang} /></div>
        <div className="receipt invoice print-receipt">
          {d.business.logo && <img src={d.business.logo} alt="" className="receipt-logo" />}
          <h2>{d.business.name}</h2>
          {d.business.address && <p className="receipt-meta">{d.business.address}</p>}
          <h3 style={{ margin: '14px 0 2px' }}>{d.title}</h3>
          <p className="receipt-meta" style={{ textAlign: 'left' }}>{t('For')} {d.customerName}{d.eventDate ? ` · ${t('Event')} ${d.eventDate}` : ''}{d.dueDate ? ` · ${t('Due')} ${d.dueDate}` : ''}</p>
          <table><tbody>{d.lines.map((l, i) => <tr key={i}><td>{l.qty} × {l.name}</td><td>{money(Math.round(l.qty * l.cents), cur)}</td></tr>)}</tbody></table>
          <table className="receipt-tot"><tbody>
            <tr><td>{t('Subtotal')}</td><td>{money(d.subtotalCents, cur)}</td></tr><tr><td>{t('Tax')} ({d.taxRate}%)</td><td>{money(d.taxCents, cur)}</td></tr>
            {d.feeCents > 0 && <tr><td>{t('Fee')}</td><td>{money(d.feeCents, cur)}</td></tr>}
            <tr className="grand"><td>{t('Total')}</td><td>{money(d.totalCents, cur)}</td></tr>
            {d.paidCents > 0 && <tr><td>{t('Paid')}</td><td>−{money(d.paidCents, cur)}</td></tr>}
            {d.paidCents > 0 && <tr><td><b>{t('Balance')}</b></td><td><b>{money(d.dueCents, cur)}</b></td></tr>}
          </tbody></table>
          {d.eventNotes && <p style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{d.eventNotes}</p>}
          {d.acceptedName && <p className="receipt-meta">{t('Accepted by')} {d.acceptedName}</p>}
        </div>
        {d.status === 'cancelled' ? <div className="card banner">{t('This quote was cancelled.')}</div> : d.status === 'paid' ? <div className="card"><b>{t('Paid in full. Thank you!')}</b></div> : (
          <div className="card stack no-print">
            {!d.acceptedName && (
              <>
                <b>{t('Accept this quote')}</b>
                <input className="input" placeholder={t('Your full name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
                <button className="btn primary lg block" disabled={busy || name.trim().length < 2} onClick={accept}>{t('I accept')}</button>
              </>
            )}
            {d.acceptedName && d.payOnline && d.depositDueCents > 0 && <button className="btn primary lg block" disabled={busy} onClick={() => pay('deposit')}>{t('Pay deposit')} {money(d.depositDueCents, cur)}</button>}
            {d.acceptedName && d.payOnline && d.dueCents > 0 && <button className={`btn lg block ${d.depositDueCents > 0 ? '' : 'primary'}`} disabled={busy} onClick={() => pay('balance')}>{t('Pay the full balance')} {money(d.dueCents, cur)}</button>}
            {d.acceptedName && !d.payOnline && <span className="muted">{t('We will be in touch about payment.')}</span>}
          </div>
        )}
        <button className="btn no-print" onClick={() => window.print()}>{t('Print or save as PDF')}</button>
      </div>
    </div>
  );
}

/* ================= Wallet card page ================= */
export function WalletPage() {
  const { token } = useParams();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/w/${token}`).then((x) => { setD(x); applyAccent(x.accent); document.title = x.title; }).catch((e) => setErr(e.message)); }, [token]);
  if (err) return <div className="guest"><main className="guest-in"><h1>{err}</h1></main></div>;
  if (!d) return <div className="guest" />;
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.accent, '#2a1f55', d.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in">
        <div className="wallet-card" style={{ '--c': d.accent }}>
          <div className="row">{d.logo ? <img src={d.logo} alt="" style={{ height: 34 }} /> : <Puck state="idle" size={30} />}<b className="grow" style={{ fontSize: 17 }}>{d.title}</b></div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{d.name}</div>
          {d.fields.map((f) => <div key={f.label} className="row" style={{ fontSize: 14 }}><span className="grow" style={{ opacity: 0.75 }}>{f.label}</span><b>{f.value}</b></div>)}
          <div className="qr" style={{ background: '#fff', padding: 10, borderRadius: 12, width: 190, justifySelf: 'center' }} dangerouslySetInnerHTML={{ __html: d.svg }} />
          <span style={{ textAlign: 'center', fontSize: 13, opacity: 0.75 }}>{d.kind === 'gift' ? 'Show this to pay with your gift card' : 'Show this at the counter'}</span>
        </div>
        {d.google && <a className="btn block" href={d.google} target="_blank" rel="noreferrer">Add to Google Wallet</a>}
        {d.apple && <a className="btn block" href={`/api/w/${token}/pass.pkpass${location.search}`}>Add to Apple Wallet</a>}
        <p className="dim" style={{ fontSize: 13, textAlign: 'center' }}>Tip: add this page to your home screen to keep your card one tap away.</p>
      </main>
    </div>
  );
}

/* ================= Customer account: plans + card ================= */
export function AccountClub() {
  const [d, setD] = useState(null);
  const [card, setCard] = useState(null);
  const [msg, setMsg] = useState('');
  const load = () => api('/c/plans').then(setD).catch(() => {});
  useEffect(() => { load(); api('/c/wallet').then(setCard).catch(() => {}); }, []);
  if (!d) return null;
  const join = async (p) => { try { const r = await api('/c/memberships', { method: 'POST', body: { planId: p.id } }); location.href = r.url; } catch (e) { setMsg(e.message); } };
  const cancel = async () => { if (!confirm('Stop your membership at the end of this period?')) return; try { const r = await api('/c/memberships/cancel', { method: 'POST' }); setMsg(`Your membership ends on ${r.until}.`); load(); } catch (e) { setMsg(e.message); } };
  const m = d.membership;
  return (
    <>
      {card && <a className="card row" href={card.url} style={{ textDecoration: 'none', color: 'inherit' }}><Icon name="star" size={20} /><span className="grow"><b>My card</b><br /><span className="muted" style={{ fontSize: 14 }}>Show it at the counter{card.google || card.apple ? ', or add it to your phone wallet' : ''}</span></span><span className="muted">›</span></a>}
      {(d.plans.length > 0 || m) && (
        <div className="card stack" id="plans">
          <b>Membership</b>
          {msg && <span className="muted" style={{ fontSize: 14 }}>{msg}</span>}
          {m && m.status !== 'pending' ? (
            <>
              <span>{m.plan_name}: {m.good ? `active until ${m.current_until}` : 'needs renewal'}{m.cancel_at_end ? ' (ending)' : ''}</span>
              {m.perk_qty > 0 && <span className="muted" style={{ fontSize: 14 }}>{m.perksLeft} of {m.perk_qty} {m.perk_name || 'perks'} left this {m.period}</span>}
              {!m.cancel_at_end && <button className="btn ghost sm" onClick={cancel}>Stop at the end of this period</button>}
            </>
          ) : d.plans.map((p) => (
            <div key={p.id} className="row" style={{ alignItems: 'start' }}>
              <span className="grow"><b>{p.name}</b> <span className="num">{money(p.price_cents, d.currency)}/{p.period}</span><br /><span className="muted" style={{ fontSize: 14 }}>{p.description || [p.discount_pct ? `${p.discount_pct}% off every visit` : '', p.perk_qty ? `${p.perk_qty} ${p.perk_name || 'perks'} a ${p.period}` : ''].filter(Boolean).join(', ')}</span></span>
              {d.payOnline ? <button className="btn primary sm" onClick={() => join(p)}>Join</button> : <span className="dim" style={{ fontSize: 13 }}>Join at the counter</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
