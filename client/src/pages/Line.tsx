import { useEffect, useState } from 'react';
import { api, money } from '../lib';
import { Modal, useToast } from '../ui';
import { PageHead, useCC, useLive } from './CommandCenter';
import { KdsIngredients } from './Run';

/* ================= Area screen tools: recipe card, 86, remake, temps, rush ================= */
export function KdsCard({ itemId, hdr, q, onClose }: { itemId?: any; hdr?: any; q?: any; onClose?: any; }) {
  const [c, setC] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { api(`/kds/card/${itemId}${q}`, { headers: hdr }).then(setC).catch((e) => setErr(e.message)); }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = hdr['X-Kds'];
  return (
    <Modal title={c?.name || 'Recipe card'} onClose={onClose} width={560}>
      {err && <div className="lock-msg">{err}</div>}
      {c && <>
        {c.photo && <img src={`${c.photo}${t ? `?t=${encodeURIComponent(t)}` : ''}`} alt={c.name} style={{ width: '100%', maxHeight: 260, objectFit: 'cover', borderRadius: 12 }} />}
        <div className="row wrap" style={{ gap: 6 }}>{c.cookMinutes ? <span className="chip">{c.cookMinutes} min</span> : null}{c.allergens.map((a) => <span key={a} className="chip rose" style={{ textTransform: 'capitalize' }}>{a}</span>)}</div>
        {c.steps.length > 0 ? <ol className="card-steps">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : <span className="muted">No build steps yet. Add them on the recipe card in Menu.</span>}
        {c.recipe.length > 0 && <div className="muted" style={{ fontSize: 14 }}>{c.recipe.map((r) => `${r.qty} ${r.unit} ${r.name}`).join(' · ')}</div>}
      </>}
    </Modal>
  );
}
export function KdsEightySix({ hdr, q, onClose, flash }: { hdr?: any; q?: any; onClose?: any; flash?: any; }) {
  const [list, setList] = useState(null);
  const load = () => api(`/kds/menu${q}`, { headers: hdr }).then(setList);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i, out) => api('/kds/86', { method: 'POST', body: { itemId: i.id, out }, headers: hdr }).then(() => { flash(out ? `86 ${i.name}` : `${i.name} is back on`); load(); }).catch((e) => flash(e.message));
  return (
    <Modal title="86: sold out" onClose={onClose} width={520}>
      <p className="muted" style={{ margin: 0 }}>Sold-out dishes come off the register, online menu, kiosk and menu board right away. Everyone gets an alert.</p>
      <KdsIngredients hdr={hdr} q={q} flash={(t) => { flash(t); load(); }} />
      <b>Dishes</b>
      {!list ? null : <table className="list"><tbody>{list.map((i) => <tr key={i.id}><td><b>{i.name}</b><div className="dim" style={{ fontSize: 12 }}>{i.category}</div></td><td style={{ textAlign: 'right' }}>{i.out ? <button className="btn sm primary" onClick={() => set(i, false)}>Back on</button> : <button className="btn sm" onClick={() => set(i, true)}>86 it</button>}</td></tr>)}</tbody></table>}
    </Modal>
  );
}
export function KdsRemake({ order, hdr, onClose, flash, reasons }: { order?: any; hdr?: any; onClose?: any; flash?: any; reasons?: any; }) {
  const [pick, setPick] = useState(order.items[0]?.id); const [qty, setQty] = useState(1); const [reason, setReason] = useState(null);
  const send = () => api('/kds/remake', { method: 'POST', body: { orderItemId: pick, qty, reason }, headers: hdr }).then((r) => { flash(`Remake sent to ${r.area}`); onClose(); }).catch((e) => flash(e.message));
  return (
    <Modal title={`Remake from #${order.number}`} onClose={onClose} width={480}>
      <div className="stack" style={{ gap: 6 }}>{order.items.map((i) => <label key={i.id} className="row" style={{ fontSize: 16 }}><input type="radio" name="rm" checked={pick === i.id} onChange={() => { setPick(i.id); setQty(1); }} /><span className="grow">{i.qty} {i.name}</span><span className="dim">{i.area}</span></label>)}</div>
      <label className="row">How many <input className="input" style={{ width: 70 }} type="number" min={1} max={order.items.find((i) => i.id === pick)?.qty || 1} value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)} /></label>
      <div className="row wrap" style={{ gap: 6 }}>{reasons.map((r) => <button key={r} className={`btn sm ${reason === r ? 'primary' : ''}`} onClick={() => setReason(r)}>{r}</button>)}</div>
      <button className="btn primary lg block" disabled={!pick || !reason} onClick={send}>Send remake</button>
    </Modal>
  );
}
export function KdsTemps({ hdr, q, onClose, flash, user }: { hdr?: any; q?: any; onClose?: any; flash?: any; user?: any; }) {
  const [list, setList] = useState(null); const [v, setV] = useState<any>({}); const [fix, setFix] = useState<any>({}); const [by, setBy] = useState(() => localStorage.getItem('bh_kds_name') || '');
  const load = () => api(`/kds/temps${q}`, { headers: hdr }).then(setList);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const log = (u) => api(`/kds/temps/${u.id}${q}`, { method: 'POST', body: { value: Number(v[u.id]), ...(fix[u.id] ? { corrective: fix[u.id] } : {}), ...(by && !user ? { by } : {}) }, headers: hdr })
    .then((r) => { flash(r.inRange ? `${u.name} logged` : `${u.name} logged out of range; managers told`); setV({ ...v, [u.id]: '' }); setFix({ ...fix, [u.id]: undefined }); load(); })
    .catch((e) => { if (e.data?.needsCorrective) setFix({ ...fix, [u.id]: '' }); flash(e.message); });
  return (
    <Modal title="Temperatures" onClose={onClose} width={520}>
      {!user && <label className="field"><span>Your name</span><input className="input" value={by} onChange={(e) => { setBy(e.target.value); localStorage.setItem('bh_kds_name', e.target.value); }} maxLength={30} /></label>}
      {list && list.map((u) => (
        <div key={u.id} className="stack" style={{ gap: 6, paddingBottom: 10, borderBottom: '1px solid var(--line)' }}>
          <div className="row"><b className="grow">{u.name}</b><span className="dim">{u.min}–{u.max}°{u.scale}</span>{u.last && <span className={`chip ${u.last.ok ? 'teal' : 'rose'}`}>last {u.last.value}°</span>}</div>
          <div className="row"><input className="input grow" inputMode="decimal" placeholder={`°${u.scale}`} value={v[u.id] || ''} onChange={(e) => setV({ ...v, [u.id]: e.target.value.replace(/[^\d.-]/g, '') })} aria-label={`${u.name} temperature`} /><button className="btn primary" disabled={v[u.id] === undefined || v[u.id] === '' || (fix[u.id] !== undefined && !fix[u.id])} onClick={() => log(u)}>Log</button></div>
          {fix[u.id] !== undefined && <input className="input" placeholder="What did you do about it?" value={fix[u.id]} onChange={(e) => setFix({ ...fix, [u.id]: e.target.value })} maxLength={200} />}
        </div>
      ))}
    </Modal>
  );
}
export function RushBar({ rush, quote, canPause, onPause }: { rush?: any; quote?: any; canPause?: any; onPause?: any; }) {
  if (!rush) return null;
  const tone = rush.level === 'paused' ? 'rose' : rush.level === 'busy' ? 'amber' : '';
  return (
    <div className={`rush-bar ${tone}`}>
      <b>{rush.level === 'paused' ? 'Online orders paused' : rush.level === 'busy' ? 'Busy: pickup times pushed back' : 'Online orders normal'}</b>
      <span className="dim">{quote ? `Quoting ${quote.minutes} min for pickup` : ''}{rush.reason ? ` · ${rush.reason}` : ''}{rush.until ? ` · until ${new Date(`${rush.until.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
      <span className="grow" />
      {canPause && (rush.manual ? <button className="btn sm" onClick={() => onPause(0)}>Resume online orders</button> : <><button className="btn sm ghost" onClick={() => onPause(15)}>Pause 15 min</button><button className="btn sm ghost" onClick={() => onPause(30)}>Pause 30 min</button></>)}
    </div>
  );
}
/** Kitchen page version of the rush bar. */
export function RushPanel() {
  const toast = useToast();
  const [d, reload] = useLive(['orders', 'rush'], () => api('/staff/rush').catch(() => null));
  if (!d) return null;
  return <RushBar rush={d} quote={d.quote} canPause onPause={(m) => api('/staff/rush/pause', { method: 'POST', body: { minutes: m } }).then(() => { toast(m ? `Online orders paused for ${m} minutes` : 'Online orders back on', 'ok'); reload(); }).catch((e) => toast(e.message, 'err'))} />;
}

/* ================= Remakes (Kitchen speed page) ================= */
export function RemakesPanel({ days }: { days?: any; }) {
  const { settings } = useCC();
  const [d] = useLive(['orders'], () => api(`/staff/remakes?days=${days}`), [days]);
  if (!d) return null;
  return (
    <section className="panel"><div className="panel-h"><h3 className="grow">Remakes</h3><span className="chip">{d.total} remakes · {money(d.costCents, settings.currency)} food cost</span></div>
      {d.total === 0 ? <div className="panel-b muted">None. Cooks send remakes from the area screens with a reason.</div> : (
        <div className="grid-2" style={{ padding: '0 16px 16px' }}>
          <table className="list"><thead><tr><th>Why</th><th>Times</th><th>Cost</th></tr></thead><tbody>{d.byReason.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num">{r.count}</td><td className="num">{money(r.costCents, settings.currency)}</td></tr>)}</tbody></table>
          <table className="list"><thead><tr><th>Dish</th><th>Times</th><th>Area</th></tr></thead><tbody>{d.byDish.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num">{r.count}</td><td className="muted">{d.recent.find((x) => x.name === r.key)?.area || ''}</td></tr>)}</tbody></table>
        </div>
      )}
    </section>
  );
}

/* ================= Shift pulse (Shifts) ================= */
const FACES = ['Rough', 'Okay', 'Good', 'Great'];
export function PulsePanel() {
  const { can, settings } = useCC();
  const [d] = useLive(['pulse'], () => (can('manager') && settings.shift_pulse !== '0' ? api('/staff/pulse') : Promise.resolve(null)));
  if (!d || !d.count) return null;
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h"><h3 className="grow">Shift pulse</h3><span className="chip teal">{d.average} of 4 average</span><span className="dim" style={{ fontSize: 12.5 }}>{d.count} answers in {d.days} days{d.anonymous ? ', names hidden' : ''}</span></div>
      <div className="panel-b stack">
        <div className="row wrap" style={{ gap: 8 }}>{FACES.map((f, i) => <span key={f} className={`chip ${i === 0 && d.counts[0] ? 'rose' : ''}`}>{f}: {d.counts[i]}</span>)}</div>
        {d.byDay.length > 1 && <div className="break-curve" style={{ padding: 0 }}>{d.byDay.map((x) => <i key={x.day} title={`${x.day}: ${x.avg}`} style={{ height: `${(x.avg / 4) * 100}%` }} />)}</div>}
        {d.notes.map((n, i) => <div key={i} style={{ fontSize: 14 }}><span className={`chip ${n.rating <= 1 ? 'rose' : n.rating === 2 ? 'amber' : 'teal'}`}>{FACES[n.rating - 1]}</span> {n.note}{n.name ? <span className="dim"> ({n.name.split(' ')[0]})</span> : null}</div>)}
      </div>
    </section>
  );
}
export function PulseButtons({ onPick }: { onPick?: any; }) {
  return <div className="tclock-actions">{FACES.map((f, i) => <button key={f} className="btn lg" onClick={() => onPick(i + 1)}>{f}</button>)}</div>;
}

/* ================= Labor by area (owner) ================= */
export function LaborByArea() {
  const { settings } = useCC(); const cur = settings.currency; const toast = useToast();
  const [days, setDays] = useState(7);
  const [d, reload] = useLive(['shifts'], () => api(`/staff/labor-by-area?days=${days}`), [days]);
  if (!d) return null;
  const setArea = (u, area) => api(`/staff/users/${u.id}/area`, { method: 'PUT', body: { area: area === 'Front of house' ? null : area } }).then(reload).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <PageHead title="Labor by area" sub="Hours and wages for each kitchen area, against the sales of the dishes that area makes. Front of house is measured against all sales.">
        <div className="seg">{[1, 7, 30].map((n) => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n === 1 ? 'Today' : `${n} days`}</button>)}</div>
      </PageHead>
      <section className="panel" style={{ marginBottom: 18 }}><table className="list"><thead><tr><th>Area</th><th>Hours</th><th>Labor</th><th>Sales</th><th>Labor %</th><th>Who</th></tr></thead>
        <tbody>{d.areas.map((a) => <tr key={a.area}><td><b>{a.area}</b></td><td className="num">{a.hours}</td><td className="num">{money(a.laborCents, cur)}</td><td className="num">{money(a.salesCents, cur)}</td><td className="num">{a.pct === null ? '—' : <span className={a.pct > Number(settings.labor_target_pct || 25) ? 'rose-text' : ''}>{a.pct}%</span>}</td><td className="muted" style={{ fontSize: 13 }}>{a.people.join(', ')}</td></tr>)}</tbody></table></section>
      <section className="panel"><div className="panel-h"><h3>Where each person works</h3></div>
        <table className="list"><tbody>{d.team.map((u) => <tr key={u.id}><td>{u.name}<div className="dim" style={{ fontSize: 12 }}>{u.tip_role || ''}</div></td><td><select className="input" style={{ width: 200, height: 32 }} value={u.area || 'Front of house'} onChange={(e) => setArea(u, e.target.value)} aria-label={`${u.name} area`}>{d.choices.map((c) => <option key={c}>{c}</option>)}</select></td></tr>)}</tbody></table></section>
    </>
  );
}

/* ================= Settings ================= */
export function LinePanel({ f, setF }: { f?: any; setF?: any; }) {
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  const num = (k, label, w = 80) => <label className="field"><span>{label}</span><input className="input" style={{ width: w }} type="number" min={0} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <section className="panel"><div className="panel-h"><h3>Pickup times, rush and shift wrap-up</h3></div><div className="panel-b stack">
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.smart_quotes === '1'} onChange={flag('smart_quotes')} />Smart pickup times: quote online customers from how fast the kitchen is actually going (last 3 hours) and how many tickets are cooking</label>
      {f.smart_quotes === '1' && num('kitchen_parallel', 'Tickets the kitchen can work on at once')}
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.rush_mode === 'auto'} onChange={(e) => setF({ ...f, rush_mode: e.target.checked ? 'auto' : 'off' })} />Rush mode: when the kitchen falls behind, push pickup times back, then pause online orders until it catches up</label>
      {f.rush_mode === 'auto' && <div className="row wrap">{num('rush_busy_tickets', 'Busy at tickets cooking')}{num('rush_busy_late', 'or late tickets')}{num('rush_extra_minutes', 'Add minutes when busy')}{num('rush_pause_tickets', 'Pause at tickets cooking')}{num('rush_pause_late', 'or late tickets')}</div>}
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.shift_pulse !== '0'} onChange={flag('shift_pulse')} />Shift pulse: ask "How was your shift?" at clock-out on the time clock</label>
      {f.shift_pulse !== '0' && <label className="row" style={{ fontSize: 14, paddingLeft: 24 }}><input type="checkbox" checked={f.pulse_anonymous !== '0'} onChange={flag('pulse_anonymous')} />Hide names from managers</label>}
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.tipout_at_clockout !== '0'} onChange={flag('tipout_at_clockout')} />Show each person's tip-out when they clock out (uses your tip-out rules)</label>
    </div></section>
  );
}
