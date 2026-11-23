import { useState } from 'react';
import { api, money } from '../lib';
import { Icon } from '../ui';
import { PageHead, useCC, useLive } from './CommandCenter';
import { AccountingExport } from './Reach';
import { printPage } from '../printing';

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nice = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

export default function Reports() {
  const { settings, can } = useCC();
  const cur = settings.currency;
  const [date, setDate] = useState('');
  const [r] = useLive(['orders', 'cash', 'shifts'], () => api(`/staff/reports/day${date ? `?date=${date}` : ''}`), [date]);
  if (!r) return null;
  const t = r.totals;
  const maxH = Math.max(1, ...r.hourly);
  const firstH = r.hourly.findIndex((v) => v > 0); const lastH = 23 - [...r.hourly].reverse().findIndex((v) => v > 0);
  const hours = firstH < 0 ? Array.from({ length: 13 }, (_, i) => i + 9) : Array.from({ length: Math.max(6, lastH - firstH + 1) }, (_, i) => Math.min(23, Math.max(0, firstH - 1) + i));
  const seated = (r.guests.seated?.count || 0) + (r.guests.done?.count || 0);

  return (
    <div className="report">
      <PageHead title="End of day" sub={nice(r.date)}>
        <div className="row no-print">
          <button className="btn sm" onClick={() => setDate(addDays(r.date, -1))} aria-label="Previous day">Previous</button>
          <input className="input" type="date" value={r.date} onChange={(e) => setDate(e.target.value)} style={{ width: 160, height: 34 }} aria-label="Report date" />
          <button className="btn sm" onClick={() => setDate(addDays(r.date, 1))} aria-label="Next day">Next</button>
          <a className="btn sm" href={`/api/staff/reports/day.csv?date=${r.date}`} download>Export CSV</a>
          <button className="btn sm primary" onClick={() => printPage('Report')}><Icon name="print" size={16} />Print</button>
        </div>
      </PageHead>

      <div className="kpis">
        <div className="kpi"><div className="v">{money(t.collectedCents, cur)}</div><div className="l">Collected from {t.orders} orders</div></div>
        <div className="kpi"><div className="v">{money(t.netCents, cur)}</div><div className="l">Net sales (after discounts)</div></div>
        <div className="kpi"><div className="v">{money(t.tipsCents, cur)}</div><div className="l">Tips</div></div>
        <div className="kpi"><div className="v">{money(t.avgTicketCents, cur)}</div><div className="l">Average ticket</div></div>
        <div className="kpi"><div className="v">{t.laborPct}%</div><div className="l">Labor cost, {money(t.laborCents, cur)}</div></div>
        <div className="kpi"><div className="v">{r.avgWait}<small style={{ fontSize: '1rem' }}> min</small></div><div className="l">Average wait, {seated} parties seated</div></div>
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <section className="panel"><div className="panel-h"><h3>Sales by hour</h3></div><div className="panel-b">
          <div className="bars" role="img" aria-label="Sales by hour">
            {hours.map((h) => <div key={h} title={`${h}:00, ${money(r.hourly[h], cur)}`}><span style={{ height: `${(r.hourly[h] / maxH) * 100}%` }} /><small>{h % 12 || 12}{h < 12 ? 'a' : 'p'}</small></div>)}
          </div>
        </div></section>
        <section className="panel"><div className="panel-h"><h3>Money</h3></div><div className="panel-b">
          <table className="list"><tbody>
            <tr><td>Gross sales</td><td className="num" style={{ textAlign: 'right' }}>{money(t.grossCents, cur)}</td></tr>
            <tr><td>Discounts</td><td className="num" style={{ textAlign: 'right' }}>−{money(t.discountCents, cur)}</td></tr>
            <tr><td>Tax collected</td><td className="num" style={{ textAlign: 'right' }}>{money(t.taxCents, cur)}</td></tr>
            <tr><td>Tips</td><td className="num" style={{ textAlign: 'right' }}>{money(t.tipsCents, cur)}</td></tr>
            {Object.entries<any>(r.byMethod).map(([m, v]) => <tr key={m}><td style={{ textTransform: 'capitalize' }}>Paid by {m} ({v.count})</td><td className="num" style={{ textAlign: 'right' }}>{money(v.cents, cur)}</td></tr>)}
            <tr><td>Voided orders ({t.voids})</td><td className="num" style={{ textAlign: 'right' }}>{money(t.voidCents, cur)}</td></tr>
          </tbody></table>
        </div></section>
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <section className="panel"><div className="panel-h"><h3>Items sold</h3></div>
          {r.items.length ? <table className="list"><thead><tr><th>Item</th><th>Qty</th><th style={{ textAlign: 'right' }}>Sales</th></tr></thead><tbody>
            {r.items.map((i) => <tr key={i.name}><td>{i.name}</td><td className="num">{i.qty}</td><td className="num" style={{ textAlign: 'right' }}>{money(i.cents, cur)}</td></tr>)}
          </tbody></table> : <div className="panel-b muted">No sales this day.</div>}
        </section>
        <div className="stack">
          <section className="panel"><div className="panel-h"><h3>By team member</h3></div>
            {r.byStaff.length ? <table className="list"><tbody>{r.byStaff.map((s) => <tr key={s.name}><td>{s.name}</td><td className="muted">{s.orders} orders</td><td className="num">{money(s.cents, cur)}</td><td className="num muted">tips {money(s.tips, cur)}</td></tr>)}</tbody></table> : <div className="panel-b muted">No sales this day.</div>}
          </section>
          <section className="panel"><div className="panel-h"><h3>Hours worked</h3></div>
            {r.labor.length ? <table className="list"><tbody>{r.labor.map((l, i) => <tr key={i}><td>{l.name}</td><td className="num">{l.hours.toFixed(2)} h</td><td className="num">{money(l.cents, cur)}</td></tr>)}</tbody></table> : <div className="panel-b muted">Nobody clocked in this day.</div>}
          </section>
          <section className="panel"><div className="panel-h"><h3>Cash drawer</h3></div>
            {r.cash.length ? <table className="list"><tbody>{r.cash.map((c) => (
              <tr key={c.id}><td>{c.closed_at ? `Closed by ${c.closedByName || 'someone'}` : 'Still open'}</td><td className="num">expected {money(c.expectedCents, cur)}</td>
                <td className="num" style={{ color: c.varianceCents === null ? undefined : c.varianceCents === 0 ? 'var(--seated)' : 'var(--dirty)' }}>{c.varianceCents === null ? '' : c.varianceCents === 0 ? 'Balanced' : `${c.varianceCents > 0 ? 'Over' : 'Short'} ${money(Math.abs(c.varianceCents), cur)}`}</td></tr>
            ))}</tbody></table> : <div className="panel-b muted">The drawer wasn't opened this day.</div>}
          </section>
        </div>
      </div>
      {can('owner') && <div className="no-print"><AccountingExport /></div>}
    </div>
  );
}
