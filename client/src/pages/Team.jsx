import { useState } from 'react';
import { api, money } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { AutoOffers } from './Field.jsx';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);
const dayLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
const offText = (p, cur) => (p.kind === 'pct' ? `${p.value}% off` : `${money(p.value, cur)} off`);

/* ================= Marketing: promo codes + campaigns ================= */
function PromoModal({ currency, onClose }) {
  const toast = useToast();
  const [f, setF] = useState({ code: '', kind: 'pct', value: '10', min: '', starts_on: '', ends_on: '', max_uses: '', note: '' });
  const save = async () => {
    try {
      await api('/staff/promos', { method: 'POST', body: { code: f.code, kind: f.kind, value: f.kind === 'pct' ? Number(f.value) : dollars(f.value), min_cents: f.min ? dollars(f.min) : 0, starts_on: f.starts_on || null, ends_on: f.ends_on || null, max_uses: f.max_uses ? Number(f.max_uses) : null, note: f.note || undefined } });
      toast(`${f.code.toUpperCase()} is ready to use`, 'ok'); onClose();
    } catch (e) { toast(e.message, 'err'); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="New promo code" onClose={onClose} width={520}>
      <label className="field"><span>Code customers type</span><input className="input num" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })} maxLength={20} placeholder="TUESDAY20" /></label>
      <div className="row">
        <div className="seg"><button aria-pressed={f.kind === 'pct'} onClick={() => setF({ ...f, kind: 'pct' })}>Percent off</button><button aria-pressed={f.kind === 'amount'} onClick={() => setF({ ...f, kind: 'amount' })}>Amount off</button></div>
        <input className="input grow" inputMode="decimal" value={f.value} onChange={set('value')} aria-label={f.kind === 'pct' ? 'Percent' : `Amount in ${currency}`} />
        <span className="muted">{f.kind === 'pct' ? '%' : currency}</span>
      </div>
      <div className="row">
        <label className="field grow"><span>Minimum order (optional)</span><input className="input" inputMode="decimal" value={f.min} onChange={set('min')} /></label>
        <label className="field grow"><span>Total uses allowed (optional)</span><input className="input" inputMode="numeric" value={f.max_uses} onChange={set('max_uses')} /></label>
      </div>
      <div className="row">
        <label className="field grow"><span>Starts (optional)</span><input className="input" type="date" value={f.starts_on} onChange={set('starts_on')} /></label>
        <label className="field grow"><span>Ends (optional)</span><input className="input" type="date" value={f.ends_on} onChange={set('ends_on')} /></label>
      </div>
      <label className="field"><span>Note for your team (optional)</span><input className="input" value={f.note} onChange={set('note')} maxLength={80} /></label>
      <button className="btn primary lg block" disabled={f.code.length < 3 || !Number(f.value)} onClick={save}>Create code</button>
    </Modal>
  );
}

function CampaignModal({ data, promos, onClose }) {
  const toast = useToast();
  const [f, setF] = useState({ title: '', message: '', audience: 'all', promoId: '', link: 'order', email: true });
  const [busy, setBusy] = useState(false);
  const groups = [['all', 'Everyone who said yes'], ['regulars', 'Regulars (3+ visits)'], ['lapsed', "Haven't been in 30 days"], ['new', 'Joined in the last 30 days']];
  const promo = promos.find((p) => String(p.id) === String(f.promoId));
  const send = async (repeat = false) => {
    setBusy(true);
    try {
      const r = await api('/staff/campaigns', { method: 'POST', headers: repeat ? { 'X-Confirm-Repeat': '1' } : undefined, body: { ...f, promoId: f.promoId ? Number(f.promoId) : null } });
      toast(`Sent. ${r.reached} customer${r.reached === 1 ? '' : 's'} reached.`, 'ok'); onClose();
    } catch (e) {
      if (/last 12 hours/.test(e.message) && confirm(`${e.message}\n\nSend anyway?`)) return send(true);
      toast(e.message, 'err');
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Send an offer" onClose={onClose} width={560}>
      <label className="field"><span>Headline</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={60} placeholder="Half-price wings tonight" /></label>
      <label className="field"><span>Message</span><textarea className="input" rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={240} placeholder="Come in after 5 and bring a friend." /></label>
      <div className="field"><span>Who gets it</span>
        <div className="stack" style={{ gap: 6 }}>{groups.map(([k, label]) => (
          <label key={k} className="row" style={{ fontSize: 14 }}><input type="radio" name="aud" checked={f.audience === k} onChange={() => setF({ ...f, audience: k })} /><span className="grow">{label}</span><span className="muted num">{data.audiences[k]}</span></label>
        ))}</div>
      </div>
      <div className="row">
        <label className="field grow"><span>Attach a promo code</span>
          <select className="input" value={f.promoId} onChange={(e) => setF({ ...f, promoId: e.target.value })}><option value="">No code</option>{promos.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select>
        </label>
        <label className="field grow"><span>Button opens</span>
          <select className="input" value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })}><option value="order">Online ordering</option><option value="account">Booking / account</option><option value="gift">Gift cards</option></select>
        </label>
      </div>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.email} disabled={!data.emailEnabled} onChange={(e) => setF({ ...f, email: e.target.checked })} />Also send by email{!data.emailEnabled && <span className="dim">(set up email in Railway first)</span>}</label>
      {(f.title || f.message) && (
        <div className="card" style={{ background: 'var(--bg)' }}><b>{f.title || 'Headline'}</b><span className="muted" style={{ fontSize: 14 }}>{f.message}{promo ? ` Use code ${promo.code}.` : ''}</span></div>
      )}
      <button className="btn primary lg block" disabled={busy || !f.title || !f.message || !data.audiences[f.audience]} onClick={() => send()}>{busy ? 'Sending…' : `Send to ${data.audiences[f.audience]} customer${data.audiences[f.audience] === 1 ? '' : 's'}`}</button>
      <span className="dim" style={{ fontSize: 12.5 }}>Only customers who said yes to offers get these. Every email has an unsubscribe link.</span>
    </Modal>
  );
}

export function Marketing() {
  const { settings } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [promos, reloadPromos] = useLive(['promos', 'orders'], () => api('/staff/promos'));
  const [data, reload] = useLive(['promos'], () => api('/staff/campaigns'));
  const [modal, setModal] = useState(null);
  if (!promos || !data) return null;
  const toggle = async (p) => { try { await api(`/staff/promos/${p.id}/active`, { method: 'POST', body: { active: !p.active } }); reloadPromos(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <>
      <PageHead title="Marketing" sub={`${data.audiences.all} of ${data.customers} customers said yes to offers. Messages go to their phones as alerts${data.emailEnabled ? ' and by email' : ''}.`}>
        <button className="btn" onClick={() => setModal('promo')}>New promo code</button>
        <button className="btn primary" onClick={() => setModal('campaign')}><Icon name="bell" size={17} />Send an offer</button>
      </PageHead>
      <section className="panel"><div className="panel-h"><h3>Promo codes</h3></div>
        {promos.length === 0 ? <div className="panel-b muted">Create a code, then customers type it at online checkout, or staff enter it at the register.</div> : (
          <table className="list"><thead><tr><th>Code</th><th>Offer</th><th>Rules</th><th>Used</th><th>Sales with it</th><th>Given away</th><th /></tr></thead>
            <tbody>{promos.map((p) => (
              <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                <td className="num"><b>{p.code}</b>{p.note && <div className="dim" style={{ fontSize: 12.5 }}>{p.note}</div>}</td>
                <td>{offText(p, cur)}</td>
                <td className="muted" style={{ fontSize: 13.5 }}>{[p.min_cents ? `over ${money(p.min_cents, cur)}` : '', p.starts_on ? `from ${p.starts_on}` : '', p.ends_on ? `until ${p.ends_on}` : '', p.max_uses ? `${p.max_uses} uses max` : ''].filter(Boolean).join(', ') || 'None'}</td>
                <td className="num">{p.uses}</td><td className="num">{money(p.salesCents, cur)}</td><td className="num muted">{money(p.discountCents, cur)}</td>
                <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => toggle(p)}>{p.active ? 'Turn off' : 'Turn on'}</button></td>
              </tr>
            ))}</tbody></table>
        )}
      </section>
      <section className="panel" style={{ marginTop: 18 }}><div className="panel-h"><h3>Sent offers</h3></div>
        {data.campaigns.length === 0 ? <div className="panel-b muted">Nothing sent yet. Customers opt in when they create an account, and can turn offers off at any time.</div> : (
          <table className="list"><thead><tr><th>Sent</th><th>Offer</th><th>Group</th><th>Reached</th><th>Code used</th><th>Sales from code</th></tr></thead>
            <tbody>{data.campaigns.map((c) => (
              <tr key={c.id}>
                <td className="muted">{c.sent_at ? new Date(c.sent_at.replace(' ', 'T') + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not sent'}</td>
                <td><b>{c.title}</b><div className="dim" style={{ fontSize: 13 }}>{c.message}</div></td>
                <td className="muted" style={{ textTransform: 'capitalize' }}>{c.audience}</td>
                <td className="num">{c.reached}<div className="dim" style={{ fontSize: 12 }}>{c.pushed} alerts, {c.emailed} emails</div></td>
                <td className="num">{c.promo ? `${c.promo.code}: ${c.promo.uses}` : <span className="dim">No code</span>}</td>
                <td className="num">{c.promo ? money(c.promo.salesCents, cur) : ''}</td>
              </tr>
            ))}</tbody></table>
        )}
      </section>
      <AutoOffers />
      {modal === 'promo' && <PromoModal currency={cur} onClose={() => { setModal(null); reloadPromos(); }} />}
      {modal === 'campaign' && <CampaignModal data={data} promos={promos} onClose={() => { setModal(null); reload(); }} />}
    </>
  );
}

/* ================= Tip pool ================= */
export function Tips() {
  const { settings, user } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [range, setRange] = useState({ from: '', to: '' });
  const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v));
  const [d, reload] = useLive(['shifts', 'orders', 'cash'], () => api(`/staff/tips${q.size ? `?${q}` : ''}`), [range.from, range.to]);
  const [busy, setBusy] = useState(false);
  if (!d) return null;
  const setPoints = async (u, v) => { try { await api('/staff/tips/points', { method: 'PUT', body: { userId: u.id, points: Number(v) } }); toast(`${u.name}: ${v} point${Number(v) === 1 ? '' : 's'}`, 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  const payout = async (method) => {
    if (!confirm(`Pay out ${money(d.tipsCents, cur)} in tips for ${d.from} to ${d.to}${method === 'cash' ? ' from the cash drawer' : ' through payroll'}?`)) return;
    setBusy(true);
    try { await api('/staff/tips/payout', { method: 'POST', body: { from: d.from, to: d.to, method } }); toast('Tips paid out', 'ok'); setRange({ from: '', to: '' }); reload(); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHead title="Tips" sub={`Tips are shared by hours worked times each person's points.${d.includeManagers ? '' : ' Managers and owners are left out (change in Settings).'}`} />
      {settings.tip_pool_enabled !== '1' && <div className="card banner" style={{ marginBottom: 18 }}>The tip pool is off. You can still see the split here. Turn it on in Settings, under Staffing and tips.</div>}
      <div className="kpis">
        <div className="kpi"><div className="v">{money(d.tipsCents, cur)}</div><div className="l">Tips from {dayLabel(d.from)} to {dayLabel(d.to)}</div></div>
        <div className="kpi"><div className="v">{d.tippedOrders}</div><div className="l">Tipped orders</div></div>
        <div className="kpi"><div className="v">{d.people.reduce((a, p) => a + p.hours, 0).toFixed(1)}</div><div className="l">Hours in the pool</div></div>
        <div className="kpi"><div className="v">{d.lastPaidThrough ? dayLabel(d.lastPaidThrough) : 'Never'}</div><div className="l">Paid out through</div></div>
      </div>
      <div className="grid-2" style={{ marginTop: 18 }}>
        <section className="panel"><div className="panel-h"><h3 className="grow">This payout</h3>
          <input className="input" type="date" style={{ width: 150, height: 34 }} value={range.from || d.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
          <input className="input" type="date" style={{ width: 150, height: 34 }} value={range.to || d.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
        </div>
          {d.people.length === 0 ? <div className="panel-b muted">Nobody clocked in during these days, so there is nothing to split.</div> : (
            <table className="list"><thead><tr><th>Person</th><th>Hours</th><th>Points</th><th>Per hour</th><th>Share</th></tr></thead>
              <tbody>{d.people.map((p) => <tr key={p.userId}><td>{p.name}</td><td className="num">{p.hours.toFixed(2)}</td><td className="num">{p.points}</td><td className="num muted">{money(p.perHourCents, cur)}</td><td className="num"><b>{money(p.cents, cur)}</b></td></tr>)}</tbody></table>
          )}
          <div className="panel-b row">
            <button className="btn grow" disabled={busy || !d.tipsCents || !d.people.length} onClick={() => payout('cash')}><Icon name="cash" size={17} />Pay in cash</button>
            <button className="btn primary grow" disabled={busy || !d.tipsCents || !d.people.length} onClick={() => payout('payroll')}>Add to payroll</button>
          </div>
        </section>
        <div className="stack">
          <section className="panel"><div className="panel-h"><h3>Points by person</h3></div><div className="panel-b stack" style={{ gap: 8 }}>
            {d.team.map((u) => (
              <div key={u.id} className="row"><span className="grow">{u.name} <span className="dim" style={{ textTransform: 'capitalize' }}>{u.role}</span></span>
                <select className="input" style={{ width: 90, height: 34 }} defaultValue={u.tip_points} onChange={(e) => setPoints(u, e.target.value)} aria-label={`${u.name} points`}>
                  {[0, 0.5, 1, 1.25, 1.5, 2, 3].map((v) => <option key={v} value={v}>{v}</option>)}
                </select></div>
            ))}
            <span className="dim" style={{ fontSize: 12.5 }}>1 is a full share per hour. Give bartenders or leads more, support staff less. 0 leaves someone out.</span>
          </div></section>
          <section className="panel"><div className="panel-h"><h3>Past payouts</h3></div>
            {d.history.length ? <table className="list"><tbody>{d.history.map((h) => <tr key={`${h.period_from}${h.period_to}`}><td>{dayLabel(h.period_from)} to {dayLabel(h.period_to)}</td><td className="num">{money(h.cents, cur)}</td><td className="muted">{h.people} people, {h.method}</td><td className="muted">{h.paid_by_name}</td></tr>)}</tbody></table> : <div className="panel-b muted">No payouts yet.</div>}
          </section>
        </div>
      </div>
      {user.role !== 'owner' && <p className="dim" style={{ marginTop: 12, fontSize: 13 }}>Payouts are saved in the audit log with your name.</p>}
    </>
  );
}

/* ================= Staffing forecast (shown in Shifts) ================= */
export function Forecast() {
  const { settings } = useCC();
  const cur = settings.currency;
  const [d] = useLive(['shifts'], () => api('/staff/forecast'));
  const [open, setOpen] = useState(null);
  if (!d) return null;
  if (d.historyDays < 7) return (
    <section className="panel" style={{ marginTop: 18 }}><div className="panel-h"><h3>Staffing forecast</h3></div>
      <div className="panel-b muted">After a week of sales, this shows how many people you need each hour for the next 7 days, based on the same weekday over the last 8 weeks{d.weatherOn ? ' and the weather' : ''}.</div></section>
  );
  const max = Math.max(1, ...d.days.flatMap((x) => x.hours.map((h) => Math.max(h.need, h.scheduled))));
  const day = d.days.find((x) => x.date === open);
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">Staffing forecast, next 7 days</h3>
        <span className="dim" style={{ fontSize: 12.5 }}>From {d.historyDays} days of sales. 1 person per {money(d.perStaffCents, cur)} an hour.{d.weatherPlace ? ` Weather for ${d.weatherPlace}; rain ${d.rainEffectPct >= 0 ? 'adds' : 'cuts'} about ${Math.abs(d.rainEffectPct)}%${d.rainLearned ? ' here' : ' (your setting)'}.` : d.weatherOn ? ' Weather not reachable right now.' : ' Add your city in Settings to factor in weather.'}</span>
      </div>
      <table className="list">
        <thead><tr><th>Day</th><th>Weather</th><th>Expected sales</th><th>Busiest</th><th>Staff hours needed</th><th>Scheduled</th><th /></tr></thead>
        <tbody>{d.days.map((x) => (
          <tr key={x.date} onClick={() => setOpen(open === x.date ? null : x.date)} style={{ cursor: 'pointer' }}>
            <td><b>{dayLabel(x.date)}</b></td>
            <td className="muted">{x.weather ? `${x.weather.sky}, ${Math.round(x.weather.maxC)}°C${x.weather.rainy ? `, ${x.weather.rainPct}% rain` : ''}` : ''}</td>
            <td className="num">{money(x.salesCents, cur)}</td><td className="num">{x.peakNeed} people</td>
            <td className="num">{x.staffHours}</td>
            <td className="num"><span className={`chip ${x.short.length ? 'rose' : x.over.length ? 'amber' : 'teal'}`}>{x.schedHours}</span></td>
            <td className="muted" style={{ fontSize: 13 }}>{x.short.length ? `Short ${hourLabel(x.short[0])}–${hourLabel(x.short[x.short.length - 1] + 1)}` : x.over.length ? `Extra people ${hourLabel(x.over[0])}` : x.schedHours ? 'Covered' : ''}</td>
          </tr>
        ))}</tbody>
      </table>
      {day && (
        <div className="panel-b">
          <div className="fc-bars" role="img" aria-label={`Hourly staffing for ${dayLabel(day.date)}`}>
            {day.hours.map((h) => (
              <div key={h.hour} className="fc-col" title={`${hourLabel(h.hour)}: need ${h.need}, scheduled ${h.scheduled}, about ${money(h.salesCents, cur)}`}>
                <div className="fc-stack"><i className="need" style={{ height: `${(h.need / max) * 100}%` }} /><i className={`sched ${h.gap < 0 ? 'short' : ''}`} style={{ height: `${(h.scheduled / max) * 100}%` }} /></div>
                <small>{hourLabel(h.hour)}</small><small className="num">{h.need}/{h.scheduled}</small>
              </div>
            ))}
          </div>
          <div className="row dim" style={{ fontSize: 12.5, marginTop: 8 }}><span className="fc-key need" />Needed<span className="fc-key sched" />Scheduled<span className="fc-key short" />Short</div>
        </div>
      )}
    </section>
  );
}

/* ================= Settings panel ================= */
export function TeamPanel({ f, setF }) {
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  return (
    <section className="panel"><div className="panel-h"><h3>Staffing and tips</h3></div><div className="panel-b stack">
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.tip_pool_enabled === '1'} onChange={flag('tip_pool_enabled')} /> Pool tips and split them by hours worked</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.tip_pool_managers === '1'} onChange={flag('tip_pool_managers')} /> Include managers and owners in the pool</label>
      <label className="field"><span>Your city, for weather in the forecast</span><input className="input" value={f.forecast_city} onChange={(e) => setF({ ...f, forecast_city: e.target.value })} maxLength={80} placeholder="Austin" /></label>
      <div className="row">
        <label className="field grow"><span>Sales one person handles an hour</span><input className="input" inputMode="decimal" value={(Number(f.staff_sales_per_hour_cents) / 100).toFixed(0)} onChange={(e) => setF({ ...f, staff_sales_per_hour_cents: String(dollars(e.target.value)) })} /></label>
        <label className="field grow"><span>Fewest people while open</span><input className="input" type="number" min={0} max={20} value={f.staff_min} onChange={(e) => setF({ ...f, staff_min: e.target.value })} /></label>
      </div>
      <label className="field"><span>Rain changes sales by this % until it learns from your own days</span><input className="input" type="number" min={-60} max={60} value={f.forecast_rain_pct} onChange={(e) => setF({ ...f, forecast_rain_pct: e.target.value })} /></label>
    </div></section>
  );
}
