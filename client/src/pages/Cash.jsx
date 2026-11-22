import { useState } from 'react';
import { api, money, timeOf } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { NoSaleButton } from './Devices.jsx';

const DENOMS = [[10000, '$100'], [5000, '$50'], [2000, '$20'], [1000, '$10'], [500, '$5'], [100, '$1'], [25, '25¢'], [10, '10¢'], [5, '5¢'], [1, '1¢']];
const toCents = (v) => Math.round(Number(String(v).replace(/[^\d.]/g, '') || 0) * 100);

function CountModal({ expected, currency, onClose, onDone }) {
  const toast = useToast();
  const [counts, setCounts] = useState({});
  const [notes, setNotes] = useState('');
  const total = DENOMS.reduce((a, [c]) => a + c * (Number(counts[c]) || 0), 0);
  const diff = total - expected;
  const close = async () => {
    try { const r = await api('/staff/cash/close', { method: 'POST', body: { countedCents: total, notes: notes || undefined } }); toast(r.varianceCents === 0 ? 'Drawer balanced' : `Drawer ${r.varianceCents > 0 ? 'over' : 'short'} by ${money(Math.abs(r.varianceCents), currency)}`, r.varianceCents === 0 ? 'ok' : 'err'); onDone(); }
    catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title="Count and close the drawer" onClose={onClose} width={520}>
      <div className="denoms">{DENOMS.map(([c, label]) => (
        <label key={c} className="denom"><span>{label}</span><input className="input" inputMode="numeric" value={counts[c] || ''} onChange={(e) => setCounts({ ...counts, [c]: e.target.value.replace(/\D/g, '') })} placeholder="0" aria-label={`Number of ${label}`} /></label>
      ))}</div>
      <div className="totals">
        <div><span>Counted</span><span>{money(total, currency)}</span></div>
        <div><span>Expected</span><span>{money(expected, currency)}</span></div>
        <div className="grand" style={{ color: diff === 0 ? 'var(--seated)' : 'var(--dirty)' }}><span>{diff === 0 ? 'Balanced' : diff > 0 ? 'Over' : 'Short'}</span><span>{money(Math.abs(diff), currency)}</span></div>
      </div>
      <input className="input" placeholder="Note (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} />
      <button className="btn primary lg block" onClick={close}>Close drawer at {money(total, currency)}</button>
    </Modal>
  );
}

export default function Cash() {
  const { settings, can } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [data] = useLive(['cash', 'orders'], () => api('/staff/cash'));
  const [float, setFloat] = useState('200.00');
  const [move, setMove] = useState({ kind: 'out', amount: '', reason: '' });
  const [counting, setCounting] = useState(false);
  if (!data) return null;
  const c = data.current;
  const post = async (path, body, msg) => { try { await api(path, { method: 'POST', body }); toast(msg, 'ok'); return true; } catch (e) { toast(e.message, 'err'); return false; } };

  return (
    <>
      <PageHead title="Cash drawer" sub={c ? `Opened at ${timeOf(c.opened_at)} by ${c.openedByName}` : 'The drawer is closed.'}>
        {c && <button className="btn primary" onClick={() => setCounting(true)}>Count and close</button>}
        <NoSaleButton />
      </PageHead>
      {!c ? (
        <section className="panel" style={{ maxWidth: 460 }}><div className="panel-b stack">
          <label className="field"><span>Starting cash in the drawer</span><input className="input" inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} /></label>
          <button className="btn primary lg block" onClick={() => post('/staff/cash/open', { openingCents: toCents(float) }, 'Drawer opened')}>Open drawer</button>
        </div></section>
      ) : (
        <div className="grid-2">
          <section className="panel"><div className="panel-h"><h3>Right now</h3></div><div className="panel-b">
            <div className="totals">
              <div><span>Starting cash</span><span>{money(c.opening_cents, cur)}</span></div>
              <div><span>Cash sales (with tips)</span><span>{money(c.cashSalesCents, cur)}</span></div>
              <div><span>Paid in</span><span>{money(c.paidInCents, cur)}</span></div>
              <div><span>Paid out</span><span>−{money(c.paidOutCents, cur)}</span></div>
              <div className="grand"><span>Should be in drawer</span><span>{money(c.expectedCents, cur)}</span></div>
            </div>
            {c.moves.length > 0 && <table className="list"><tbody>{c.moves.map((m) => <tr key={m.id}><td className="muted num">{timeOf(m.at)}</td><td>{m.kind === 'in' ? 'In' : 'Out'}: {m.reason}</td><td className="muted">{m.user_name}</td><td className="num">{money(m.amount_cents, cur)}</td></tr>)}</tbody></table>}
          </div></section>
          <section className="panel"><div className="panel-h"><h3>Paid in or out</h3></div><div className="panel-b stack">
            <div className="seg" style={{ width: '100%' }}><button aria-pressed={move.kind === 'out'} onClick={() => setMove({ ...move, kind: 'out' })} style={{ flex: 1 }}>Paid out</button><button aria-pressed={move.kind === 'in'} onClick={() => setMove({ ...move, kind: 'in' })} style={{ flex: 1 }}>Paid in</button></div>
            <div className="row">
              <input className="input" style={{ width: 120 }} inputMode="decimal" placeholder="Amount" value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} aria-label="Amount" />
              <input className="input grow" placeholder={move.kind === 'out' ? 'What for? (ice, supplies…)' : 'Why? (change from bank…)'} value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} maxLength={80} aria-label="Reason" />
            </div>
            <button className="btn block" disabled={!move.amount || !move.reason} onClick={async () => { if (await post('/staff/cash/move', { kind: move.kind, amountCents: toCents(move.amount), reason: move.reason }, 'Recorded')) setMove({ ...move, amount: '', reason: '' }); }}>Record {move.kind === 'out' ? 'paid out' : 'paid in'}</button>
          </div></section>
        </div>
      )}
      {data.recent.length > 0 && (
        <section className="panel" style={{ marginTop: 18 }}><div className="panel-h"><h3>Past close-outs</h3></div>
          <table className="list"><thead><tr><th>Closed</th><th>By</th><th>Expected</th><th>Counted</th><th>Result</th></tr></thead><tbody>
            {data.recent.map((s) => <tr key={s.id}><td className="muted">{new Date(s.closed_at.replace(' ', 'T') + 'Z').toLocaleDateString()} {timeOf(s.closed_at)}</td><td>{s.closedByName}</td><td className="num">{money(s.expected_cents, cur)}</td><td className="num">{money(s.counted_cents, cur)}</td>
              <td><span className={`chip ${s.varianceCents === 0 ? 'teal' : 'rose'}`}>{s.varianceCents === 0 ? 'Balanced' : `${s.varianceCents > 0 ? 'Over' : 'Short'} ${money(Math.abs(s.varianceCents), cur)}`}</span></td></tr>)}
          </tbody></table>
        </section>
      )}
      {counting && c && <CountModal expected={c.expectedCents} currency={cur} onClose={() => setCounting(false)} onDone={() => setCounting(false)} />}
    </>
  );
}
