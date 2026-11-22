import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent, money, timeOf } from '../lib.js';
import { Icon, Modal, Puck, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { LangSwitch, useLang } from '../i18n.jsx';
import { printPage } from '../printing.js';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.-]/g, '') || 0) * 100);
const whenLocal = (sl) => { const [d, t] = sl.split(' '); return `${new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${new Date(`2000-01-01T${t}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; };

/* ================= Lobby screen (TV) ================= */
export function LobbyScreen() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const load = () => api('/screen', { headers: { 'X-Screen': localStorage.getItem('bh_screen') || '' } }).then((x) => { setD(x); setErr(''); applyAccent(x.business.accent); }).catch((e) => setErr(e.message));
    load(); const a = setInterval(load, 5000); const b = setInterval(() => setClock(new Date()), 30000);
    document.documentElement.requestFullscreen?.().catch(() => {});
    navigator.wakeLock?.request('screen').catch(() => {});
    return () => { clearInterval(a); clearInterval(b); };
  }, []);
  if (err && !d) return <div className="lobby"><div className="lobby-msg"><h1>{err}</h1><a className="btn" href="/">Open the command center</a></div></div>;
  if (!d) return <div className="lobby" />;
  const showWait = d.business.type !== 'service' && (d.waitlist.count > 0 || d.waitlist.ready.length > 0);
  return (
    <div className="lobby">
      <header className="lobby-top">{d.business.logo ? <img src={d.business.logo} alt="" /> : <Puck state="buzzed" size={44} />}<b>{d.business.name}</b><span className="grow" /><span className="num">{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></header>
      <div className={`lobby-grid ${showWait ? 'three' : ''}`}>
        <section><h2>Preparing</h2><div className="lobby-nums">{d.preparing.map((o) => <div key={o.number} className="ln"><b>{o.number}</b>{o.name && <small>{o.name}</small>}</div>)}{!d.preparing.length && <span className="dim">Nothing cooking right now</span>}</div></section>
        <section className="ready"><h2>Ready</h2><div className="lobby-nums">{d.ready.map((o) => <div key={o.number} className="ln on"><b>{o.number}</b>{o.name && <small>{o.name}</small>}{o.shelf && <small className="ln-shelf">Shelf {o.shelf}</small>}</div>)}{!d.ready.length && <span className="dim">We'll show your number here</span>}</div></section>
        {showWait && <section><h2>{d.business.unit}s</h2>
          {d.waitlist.ready.map((g, i) => <div key={i} className="lw on"><b>{g.name}</b><span>{g.table ? `${d.business.unit} ${g.table}` : 'Your table is ready'}</span></div>)}
          <p className="lobby-wait">{d.waitlist.count} waiting{d.waitlist.minutes ? `, about ${d.waitlist.minutes} min for a new party` : ''}</p>
          {d.waitlist.next.map((g, i) => <div key={i} className="lw"><b>{i + 1}. {g.name}</b><span>{g.party}</span></div>)}
        </section>}
      </div>
      <footer className="lobby-foot">{d.specials?.length > 0 && <div style={{ color: 'var(--accent)', marginBottom: '1vh' }}>Today's specials: {d.specials.join(', ')}</div>}{d.message || 'Scan the code at the door to join the line and get a buzz on your phone.'}</footer>
    </div>
  );
}

/* ================= Settings: lobby screen, add-ons, referrals, recovery ================= */
export function GrowPanel({ f, setF }) {
  const toast = useToast();
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const startScreen = async () => { try { const r = await api('/staff/screen/start', { method: 'POST' }); localStorage.setItem('bh_screen', r.token); location.href = `/screen${r.loc && r.loc !== 'main' ? `?l=${r.loc}` : ''}`; } catch (e) { toast(e.message, 'err'); } };
  return (
    <section className="panel"><div className="panel-h"><h3>Lobby screen, add-ons, referrals and recovery</h3></div><div className="panel-b stack">
      <b>Lobby screen</b>
      <span className="muted" style={{ fontSize: 14 }}>Show order numbers being made and ready, and the waitlist, on a TV. Open this on a smart TV browser, a streaming stick or a laptop connected to the TV.</span>
      <label className="field"><span>Message at the bottom of the screen</span><input className="input" value={f.screen_message} onChange={set('screen_message')} maxLength={120} placeholder="Scan the code at the door to join the line" /></label>
      <div className="row"><button className="btn primary grow" onClick={startScreen}>Open the lobby screen on this device</button><button className="btn grow" onClick={() => api('/staff/screen/signout-all', { method: 'POST' }).then(() => toast('All lobby screens signed out', 'ok'))}>Sign out all screens</button></div>
      <hr className="sep" />
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.upsell_enabled === '1'} onChange={flag('upsell_enabled')} /> Suggest add-ons ("goes great with") from what customers order together</label>
      <hr className="sep" />
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.referral_enabled === '1'} onChange={flag('referral_enabled')} /> <b>Referral program (optional)</b>: customers share a link, and both get money off after the friend's first visit</label>
      {f.referral_enabled === '1' && <div className="row">
        <label className="field grow"><span>Each person gets</span><input className="input" inputMode="decimal" value={(Number(f.referral_reward_cents) / 100).toFixed(2)} onChange={(e) => setF({ ...f, referral_reward_cents: String(dollars(e.target.value)) })} /></label>
        <label className="field grow"><span>On orders of at least</span><input className="input" inputMode="decimal" value={(Number(f.referral_min_cents) / 100).toFixed(2)} onChange={(e) => setF({ ...f, referral_min_cents: String(dollars(e.target.value)) })} /></label></div>}
      <hr className="sep" />
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.recovery_enabled === '1'} onChange={flag('recovery_enabled')} /> When a guest rates us low, send an apology and a come-back offer automatically</label>
      {f.recovery_enabled === '1' && <>
        <div className="row">
          <label className="field grow"><span>For ratings of</span><select className="input" value={f.recovery_max_rating} onChange={set('recovery_max_rating')}><option value="1">1 star</option><option value="2">2 stars or less</option><option value="3">3 stars or less</option></select></label>
          <label className="field grow"><span>Offer</span><div className="row"><input className="input" style={{ width: 80 }} inputMode="numeric" value={f.recovery_value} onChange={set('recovery_value')} /><select className="input" value={f.recovery_kind} onChange={set('recovery_kind')}><option value="pct">% off</option><option value="amount">dollars off</option></select></div></label>
          <label className="field grow"><span>Good for (days)</span><input className="input" type="number" min={7} max={180} value={f.recovery_days} onChange={set('recovery_days')} /></label>
        </div>
        <label className="field"><span>Apology message</span><input className="input" value={f.recovery_message} onChange={set('recovery_message')} maxLength={200} placeholder="We're sorry your visit wasn't great. We'd love the chance to make it right." /></label>
      </>}
      <label className="field"><span>Prep list extra (%)</span><input className="input" type="number" min={0} max={100} value={f.prep_buffer_pct} onChange={set('prep_buffer_pct')} /></label>
    </div></section>
  );
}

/* ================= Checklists and temperature logs ================= */
function TemplateModal({ tpl, onClose }) {
  const toast = useToast(); const { settings } = useCC();
  const areas = (() => { try { return [...JSON.parse(settings.kitchen_stations || '[]'), 'Expo', 'Packing', 'All areas']; } catch { return []; } })();
  const [f, setF] = useState(tpl ? { name: tpl.name, kind: tpl.kind, dow: tpl.dow ?? 1, dueTime: tpl.due_time || '', items: tpl.items.map((i) => i.text).join('\n'), area: tpl.area || '' } : { name: '', kind: 'open', dow: 1, dueTime: '', items: '', area: '' });
  const save = async (active) => { try { await api(tpl ? `/staff/checklist-templates/${tpl.id}` : '/staff/checklist-templates', { method: tpl ? 'PUT' : 'POST', body: { name: f.name, kind: f.kind, dow: Number(f.dow), dueTime: f.dueTime, area: f.area || null, items: f.items.split('\n').map((t) => t.trim()).filter(Boolean).map((t) => ({ text: t, needsValue: /temperature|temp\b/i.test(t) })), ...(active !== undefined ? { active } : {}) } }); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={tpl ? `Edit ${tpl.name}` : 'New checklist'} onClose={onClose} width={520}>
      <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} /></label>
      <div className="row"><label className="field grow"><span>When</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="open">Opening</option><option value="close">Closing</option><option value="daily">Every day</option><option value="weekly">Once a week</option></select></label>
        {f.kind === 'weekly' && <label className="field grow"><span>Day</span><select className="input" value={f.dow} onChange={(e) => setF({ ...f, dow: e.target.value })}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
        <label className="field grow"><span>Due by (managers get an alert)</span><input className="input" type="time" value={f.dueTime} onChange={(e) => setF({ ...f, dueTime: e.target.value })} /></label></div>
      <label className="field"><span>Show on a kitchen area screen (optional)</span><select className="input" value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}><option value="">No, only on the Checklists page</option>{areas.map((a) => <option key={a}>{a}</option>)}</select></label>
      <label className="field"><span>Tasks, one per line</span><textarea className="input" rows={8} value={f.items} onChange={(e) => setF({ ...f, items: e.target.value })} /></label>
      <button className="btn primary lg block" disabled={!f.name || !f.items.trim()} onClick={() => save()}>Save</button>
      {tpl && <button className="btn ghost block" onClick={() => save(!tpl.active)}>{tpl.active ? 'Turn off this checklist' : 'Turn it back on'}</button>}
    </Modal>
  );
}
function TempModal({ unit, onClose }) {
  const toast = useToast();
  const [v, setV] = useState(''); const [fix, setFix] = useState('');
  const out = v !== '' && (Number(v) < unit.min_temp || Number(v) > unit.max_temp);
  const save = async () => { try { const r = await api(`/staff/temps/${unit.id}`, { method: 'POST', body: { value: Number(v), corrective: fix || undefined } }); toast(r.inRange ? `${unit.name}: ${v}° logged` : 'Logged. Managers were alerted.', r.inRange ? 'ok' : 'err'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`${unit.name} temperature`} onClose={onClose} width={380}>
      <span className="muted">Should be {unit.min_temp}° to {unit.max_temp}°{unit.scale}</span>
      <input className="input" inputMode="decimal" autoFocus value={v} onChange={(e) => setV(e.target.value.replace(/[^\d.-]/g, ''))} style={{ fontSize: 28, textAlign: 'center' }} aria-label="Temperature" />
      {out && <label className="field"><span style={{ color: 'var(--dirty)' }}>Out of range. What did you do about it?</span><input className="input" value={fix} onChange={(e) => setFix(e.target.value)} maxLength={200} placeholder="Moved food, adjusted thermostat, called repair" /></label>}
      <button className="btn primary lg block" disabled={v === '' || (out && !fix.trim())} onClick={save}>Log it</button>
    </Modal>
  );
}
export function Checklists() {
  const { can } = useCC();
  const toast = useToast();
  const [d, reload] = useLive(['checklists'], () => api('/staff/checklists'));
  const [t, reloadT] = useLive(['checklists'], () => api('/staff/temps'));
  const [tpl, setTpl] = useState(undefined);
  const [temp, setTemp] = useState(null);
  const [unit, setUnit] = useState(null);
  if (!d || !t) return null;
  const check = async (l, i, done) => { try { let value; if (done && l.items[i].needsValue) { value = prompt(`${l.items[i].text}: what was it?`) || undefined; } await api(`/staff/checklists/${l.id}/check`, { method: 'POST', body: { index: i, done, value } }); reload(); } catch (e) { toast(e.message, 'err'); } };
  const printLog = async () => { const r = await api('/staff/inspection-log'); const w = window.open('', '_blank'); const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    w.document.write(`<title>Inspection log</title><body style="font-family:sans-serif;padding:24px"><h1>${esc(r.business)}: food safety log</h1><p>${r.from} to ${r.to}</p><h2>Temperatures</h2><table border="1" cellpadding="6" style="border-collapse:collapse;font-size:13px"><tr><th>When</th><th>Unit</th><th>Reading</th><th>Range</th><th>OK</th><th>Action taken</th><th>By</th></tr>${r.temps.map((x) => `<tr><td>${esc(new Date(`${x.at.replace(' ', 'T')}Z`).toLocaleString())}</td><td>${esc(x.unit)}</td><td>${x.value}°${x.scale}</td><td>${x.min_temp}–${x.max_temp}</td><td>${x.ok ? 'Yes' : '<b>No</b>'}</td><td>${esc(x.corrective)}</td><td>${esc(x.by_name)}</td></tr>`).join('')}</table><h2>Checklists</h2><table border="1" cellpadding="6" style="border-collapse:collapse;font-size:13px"><tr><th>Day</th><th>Checklist</th><th>Done</th><th>Completed</th><th>By</th></tr>${r.runs.map((x) => `<tr><td>${x.day}</td><td>${esc(x.name)}</td><td>${x.done} of ${x.total}</td><td>${x.completedAt ? esc(new Date(`${x.completedAt.replace(' ', 'T')}Z`).toLocaleTimeString()) : 'Not finished'}</td><td>${esc(x.by)}</td></tr>`).join('')}</table></body>`); w.document.close(); w.print(); };
  return (
    <>
      <PageHead title="Checklists" sub="Opening, closing and cleaning tasks, plus fridge and freezer temperatures. Everything is saved with who did it and when.">
        {can('manager') && <button className="btn" onClick={printLog}><Icon name="print" size={16} />Inspection log</button>}
        {can('manager') && <button className="btn primary" onClick={() => setTpl(null)}>New checklist</button>}
      </PageHead>
      {d.lists.length === 0 && (
        <div className="panel empty"><b>No checklists yet</b><span>Start with ready-made opening, closing and weekly cleaning lists for your type of business, then edit them.</span>{can('manager') && <button className="btn primary" onClick={() => api('/staff/checklist-templates/starter', { method: 'POST' }).then(() => { reload(); reloadT(); }).catch((e) => toast(e.message, 'err'))}>Add starter checklists</button>}</div>
      )}
      <div className="grid-2">
        <div className="stack">
          {d.lists.map((l) => (
            <section key={l.id} className="panel">
              <div className="panel-h"><h3 className="grow">{l.name}</h3>
                {l.completedAt ? <span className="chip teal">Done{l.completedBy ? `, ${l.completedBy}` : ''}</span> : l.overdue ? <span className="chip rose">Overdue ({l.dueTime})</span> : <span className="chip">{l.count} of {l.total}</span>}
                {can('manager') && <button className="btn sm ghost" onClick={() => setTpl(d.templates.find((x) => x.id === l.id))}>Edit</button>}</div>
              <div className="panel-b stack" style={{ gap: 4 }}>
                {l.items.map((it, i) => (
                  <label key={i} className="row check-row"><input type="checkbox" checked={Boolean(it.done)} onChange={(e) => check(l, i, e.target.checked)} /><span className="grow" style={{ textDecoration: it.done ? 'line-through' : 'none', opacity: it.done ? 0.6 : 1 }}>{it.text}</span>{it.done && <small className="dim">{it.done.value ? `${it.done.value}, ` : ''}{it.done.by} {new Date(it.done.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>}</label>
                ))}
              </div>
            </section>
          ))}
        </div>
        <section className="panel">
          <div className="panel-h"><h3 className="grow">Temperatures</h3>{can('manager') && <button className="btn sm ghost" onClick={() => setUnit({ name: '', min: '33', max: '41', scale: 'F' })}>Add a fridge or freezer</button>}</div>
          {t.units.length === 0 ? <div className="panel-b muted">Add your fridges, freezers and hot-holding units to log temperatures.</div> : (
            <table className="list"><tbody>{t.units.map((u) => (
              <tr key={u.id}><td><b>{u.name}</b><div className="dim" style={{ fontSize: 12.5 }}>{u.min_temp}° to {u.max_temp}°{u.scale}</div></td>
                <td>{u.last ? <span className={`chip ${u.last.ok ? 'teal' : 'rose'}`}>{u.last.value}° {timeOf(u.last.at)}</span> : <span className="dim">Not logged</span>}<div className="dim" style={{ fontSize: 12 }}>{u.today.length} reading{u.today.length === 1 ? '' : 's'} today</div></td>
                <td style={{ textAlign: 'right' }}>{can('manager') && <TempArea u={u} onDone={reloadT} />}<button className="btn sm primary" onClick={() => setTemp(u)}>Log</button>{can('manager') && <button className="btn sm ghost" onClick={() => confirm(`Remove ${u.name}?`) && api(`/staff/temp-units/${u.id}`, { method: 'DELETE' }).then(reloadT)}>Remove</button>}</td></tr>
            ))}</tbody></table>
          )}
        </section>
      </div>
      {tpl !== undefined && <TemplateModal tpl={tpl} onClose={() => { setTpl(undefined); reload(); }} />}
      {temp && <TempModal unit={temp} onClose={() => { setTemp(null); reloadT(); }} />}
      {unit && (
        <Modal title="Add a fridge, freezer or hot-holding unit" onClose={() => setUnit(null)} width={420}>
          <label className="field"><span>Name</span><input className="input" value={unit.name} onChange={(e) => setUnit({ ...unit, name: e.target.value })} maxLength={40} placeholder="Bar fridge" /></label>
          <div className="row"><label className="field grow"><span>Lowest OK</span><input className="input" inputMode="decimal" value={unit.min} onChange={(e) => setUnit({ ...unit, min: e.target.value })} /></label><label className="field grow"><span>Highest OK</span><input className="input" inputMode="decimal" value={unit.max} onChange={(e) => setUnit({ ...unit, max: e.target.value })} /></label>
            <label className="field"><span>Scale</span><select className="input" value={unit.scale} onChange={(e) => setUnit({ ...unit, scale: e.target.value })}><option>F</option><option>C</option></select></label></div>
          <button className="btn primary lg block" disabled={!unit.name} onClick={() => api('/staff/temp-units', { method: 'POST', body: { name: unit.name, min: Number(unit.min), max: Number(unit.max), scale: unit.scale } }).then(() => { setUnit(null); reloadT(); }).catch((e) => toast(e.message, 'err'))}>Add</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Events and tickets (staff) ================= */
function EventModal({ ev, currency, onClose }) {
  const toast = useToast();
  const [f, setF] = useState(ev ? { title: ev.title, description: ev.description || '', date: ev.startsLocal.slice(0, 10), start: ev.startsLocal.slice(11), end: ev.endsLocal?.slice(11) || '', capacity: String(ev.capacity), price: (ev.priceCents / 100).toFixed(2), max: String(ev.maxPerOrder) } : { title: '', description: '', date: '', start: '19:00', end: '', capacity: '20', price: '0.00', max: '6' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (active) => { try { await api(ev ? `/staff/events/${ev.id}` : '/staff/events', { method: ev ? 'PUT' : 'POST', body: { title: f.title, description: f.description || undefined, startsLocal: `${f.date} ${f.start}`, endsLocal: f.end ? `${f.date} ${f.end}` : '', capacity: Number(f.capacity), priceCents: dollars(f.price), maxPerOrder: Number(f.max), ...(active !== undefined ? { active } : {}) } }); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={ev ? `Edit ${ev.title}` : 'New event'} onClose={onClose} width={520}>
      <label className="field"><span>Title</span><input className="input" value={f.title} onChange={set('title')} maxLength={80} placeholder="Wine tasting, cooking class, trivia night" /></label>
      <label className="field"><span>Description</span><textarea className="input" rows={3} value={f.description} onChange={set('description')} maxLength={600} /></label>
      <div className="row"><label className="field grow"><span>Date</span><input className="input" type="date" value={f.date} onChange={set('date')} /></label><label className="field"><span>Starts</span><input className="input" type="time" value={f.start} onChange={set('start')} /></label><label className="field"><span>Ends</span><input className="input" type="time" value={f.end} onChange={set('end')} /></label></div>
      <div className="row"><label className="field grow"><span>Seats</span><input className="input" type="number" min={1} value={f.capacity} onChange={set('capacity')} /></label><label className="field grow"><span>Price per ticket ({currency}, 0 = free)</span><input className="input" inputMode="decimal" value={f.price} onChange={set('price')} /></label><label className="field grow"><span>Most per order</span><input className="input" type="number" min={1} max={50} value={f.max} onChange={set('max')} /></label></div>
      <button className="btn primary lg block" disabled={!f.title || !f.date || !f.start} onClick={() => save()}>Save event</button>
      {ev && <button className="btn ghost block" onClick={() => save(!ev.active)}>{ev.active ? 'Stop selling tickets' : 'Sell tickets again'}</button>}
    </Modal>
  );
}
export function Events() {
  const { settings } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [d, reload] = useLive(['events'], () => api('/staff/events'));
  const [edit, setEdit] = useState(undefined);
  const [door, setDoor] = useState(null);
  if (!d) return null;
  return (
    <>
      <PageHead title="Events" sub="Sell seats for classes, tastings and nights out. Guests get a QR ticket, and you check them in at the door.">
        <button className="btn" onClick={() => { navigator.clipboard?.writeText(d.link); toast('Events page link copied', 'ok'); }}>Copy events page link</button>
        <button className="btn primary" onClick={() => setEdit(null)}>New event</button>
      </PageHead>
      <section className="panel">
        {d.events.length === 0 ? <div className="panel-b muted">No events yet.</div> : (
          <table className="list"><thead><tr><th>Event</th><th>When</th><th>Price</th><th>Sold</th><th>Checked in</th><th /></tr></thead>
            <tbody>{d.events.map((e) => (
              <tr key={e.id} style={{ opacity: e.active ? 1 : 0.55 }}><td><b>{e.title}</b></td><td>{whenLocal(e.startsLocal)}</td><td className="num">{e.priceCents ? money(e.priceCents, cur) : 'Free'}</td>
                <td className="num">{e.sold} of {e.capacity}</td><td className="num">{e.checkedIn}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn sm primary" onClick={() => setDoor(e)}>Door</button><button className="btn sm ghost" onClick={() => setEdit(e)}>Edit</button></td></tr>
            ))}</tbody></table>
        )}
      </section>
      {edit !== undefined && <EventModal ev={edit} currency={cur} onClose={() => { setEdit(undefined); reload(); }} />}
      {door && <DoorModal ev={door} onClose={() => { setDoor(null); reload(); }} />}
    </>
  );
}
function DoorModal({ ev, onClose }) {
  const toast = useToast();
  const [list, reload] = useLive(['events'], () => api(`/staff/events/${ev.id}/attendees`));
  const [code, setCode] = useState('');
  const checkin = async (body) => { try { const r = await api('/staff/tickets/checkin', { method: 'POST', body }); toast(`${r.name}: ${r.checkedIn} of ${r.qty} in`, 'ok'); setCode(''); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`Door: ${ev.title}`} onClose={onClose} width={560}>
      <div className="row"><input className="input grow" autoFocus placeholder="Scan or type the ticket code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code && checkin({ code })} aria-label="Ticket code" /><button className="btn primary" disabled={!code} onClick={() => checkin({ code })}>Check in</button></div>
      <table className="list"><tbody>{(list || []).map((t) => (
        <tr key={t.id}><td><b>{t.name}</b><div className="dim" style={{ fontSize: 12.5 }}>{t.email}</div></td><td className="num">{t.checked_in} of {t.qty}</td><td>{t.status === 'pending' ? <span className="chip amber">Paying</span> : null}</td>
          <td style={{ textAlign: 'right' }}>{t.status !== 'pending' && t.checked_in < t.qty && <button className="btn sm" onClick={() => checkin({ ticketId: t.id, count: 1 })}>+1 in</button>}</td></tr>
      ))}</tbody></table>
    </Modal>
  );
}

/* ================= Public events + ticket pages ================= */
export function EventsPage() {
  const { lang, setLang, t } = useLang();
  const [d, setD] = useState(null);
  const [buy, setBuy] = useState(null);
  const [f, setF] = useState({ name: '', email: '', qty: 1 });
  const [err, setErr] = useState('');
  useEffect(() => { api('/public/events').then((x) => { setD(x); applyAccent(x.business.accent); document.title = `${x.business.name}: events`; }).catch((e) => setErr(e.message)); }, []);
  if (!d) return <div className="guest">{err && <main className="guest-in"><h1>{err}</h1></main>}</div>;
  const go = async () => { setErr(''); try { const r = await api(`/public/events/${buy.id}/tickets`, { method: 'POST', body: { name: f.name, email: f.email, qty: Number(f.qty) } }); location.href = r.url; } catch (e) { setErr(e.message); } };
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.business.accent, '#2a1f55', d.business.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in" style={{ alignContent: 'start' }}>
        <LangSwitch lang={lang} setLang={setLang} />
        {d.business.logo ? <img className="guest-logo" src={d.business.logo} alt={d.business.name} /> : <Puck state="buzzed" size={44} />}
        <h1>{t('Events at {name}', { name: d.business.name })}</h1>
        {d.events.length === 0 && <p>{t('No upcoming events right now. Check back soon!')}</p>}
        {d.events.map((e) => (
          <div key={e.id} className="card stack" style={{ width: '100%', textAlign: 'left' }}>
            <b style={{ fontSize: 18 }}>{e.title}</b><span className="muted">{whenLocal(e.startsLocal)}{e.endsLocal ? ` – ${new Date(`2000-01-01T${e.endsLocal.slice(11)}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
            {e.description && <span style={{ fontSize: 14.5, whiteSpace: 'pre-wrap' }}>{e.description}</span>}
            <div className="row"><b className="grow">{e.priceCents ? money(e.priceCents, d.currency) : t('Free')}</b><span className="dim">{e.left ? t('{n} seats left', { n: e.left }) : t('Sold out')}</span></div>
            {e.left > 0 && (buy?.id === e.id ? (
              <div className="stack">
                <input className="input" placeholder={t('Your name')} value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} autoComplete="name" />
                <input className="input" type="email" placeholder="Email" value={f.email} onChange={(x) => setF({ ...f, email: x.target.value })} autoComplete="email" />
                <div className="row"><span className="grow">{t('Tickets')}</span><select className="input" style={{ width: 90 }} value={f.qty} onChange={(x) => setF({ ...f, qty: x.target.value })}>{Array.from({ length: Math.min(e.maxPerOrder, e.left) }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select></div>
                {err && <div className="lock-msg">{err}</div>}
                <button className="btn primary lg block" disabled={!f.name || !/^\S+@\S+\.\S+$/.test(f.email)} onClick={go}>{e.priceCents ? `${t('Pay')} ${money(e.priceCents * f.qty, d.currency)}` : t('Get my tickets')}</button>
              </div>
            ) : <button className="btn primary block" onClick={() => { setBuy(e); setErr(''); }}>{e.priceCents ? t('Get tickets') : t('Save my seat')}</button>)}
          </div>
        ))}
      </main>
    </div>
  );
}
export function TicketPage() {
  const { code } = useParams();
  const { lang, setLang, t } = useLang();
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { const load = () => api(`/e/${code}`).then((x) => { setD(x); applyAccent(x.business.accent); }).catch((e) => setErr(e.message)); load(); const id = setInterval(() => { if (!d || d.status === 'pending') load(); }, 5000); return () => clearInterval(id); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="guest"><main className="guest-in"><h1>{err}</h1></main></div>;
  if (!d) return <div className="guest" />;
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.business.accent, '#2a1f55', d.business.accent]} amplitude={0.5} speed={0.3} mouseInteraction={false} /></div>
      <main className="guest-in">
        <LangSwitch lang={lang} setLang={setLang} />
        <div className="wallet-card" style={{ '--c': d.business.accent }}>
          <b style={{ fontSize: 15, opacity: 0.8 }}>{d.business.name}</b>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{d.event.title}</div>
          <div>{whenLocal(d.event.startsLocal)}</div>
          <div className="row"><span className="grow">{d.name}</span><b>{t('{n} tickets', { n: d.qty })}</b></div>
          {d.svg ? <div className="qr" style={{ background: '#fff', padding: 10, borderRadius: 12, width: 200, justifySelf: 'center' }} dangerouslySetInnerHTML={{ __html: d.svg }} /> : <b style={{ textAlign: 'center' }}>{t('Confirming your payment…')}</b>}
          <span style={{ textAlign: 'center', fontSize: 13, opacity: 0.75 }}>{d.checkedIn ? t('Checked in: {n}', { n: d.checkedIn }) : t('Show this at the door')}</span>
        </div>
        {d.business.address && <p>{d.business.address}</p>}
      </main>
    </div>
  );
}

/* ================= Bank deposits (owner) ================= */
export function Deposits() {
  const { settings } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [range, setRange] = useState({ from: '', to: '' });
  const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v));
  const [d, reload] = useLive(['cash'], () => api(`/staff/deposits${q.size ? `?${q}` : ''}`), [range.from, range.to]);
  const [add, setAdd] = useState(null);
  if (!d) return null;
  const imp = async () => { try { const r = await api('/staff/deposits/import', { method: 'POST' }); toast(`${r.added} payout${r.added === 1 ? '' : 's'} imported${r.notes.length ? `. ${r.notes.join(' ')}` : ''}`, r.notes.length ? 'err' : 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  const label = { cash: 'Cash', card: 'Cards', app: 'Apps (Zelle, Venmo…)' };
  return (
    <>
      <PageHead title="Bank deposits" sub="Record what reached the bank and check it against what you sold. Card payouts are usually a little less because of fees.">
        <input className="input" type="date" style={{ width: 150 }} value={range.from || d.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
        <input className="input" type="date" style={{ width: 150 }} value={range.to || d.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
        {(d.providers.stripe || d.providers.square) && <button className="btn" onClick={imp}>Import payouts</button>}
        <button className="btn primary" onClick={() => setAdd({ source: 'cash', amount: '', depositDate: new Date().toISOString().slice(0, 10), coverFrom: d.to, coverTo: d.to, reference: '' })}>Record a deposit</button>
      </PageHead>
      <section className="panel" style={{ marginBottom: 18 }}><div className="panel-h"><h3>Deposits</h3></div>
        {d.deposits.length === 0 ? <div className="panel-b muted">No deposits recorded for these days.</div> : (
          <table className="list"><thead><tr><th>Arrived</th><th>Type</th><th>For sales on</th><th>Deposited</th><th>Sold</th><th>Fees (est.)</th><th>Unexplained</th><th /></tr></thead>
            <tbody>{d.deposits.map((x) => (
              <tr key={x.id}><td>{x.deposit_date}<div className="dim" style={{ fontSize: 12 }}>{x.reference || x.note || ''}</div></td><td>{label[x.source]}</td><td className="muted">{x.cover_from}{x.cover_to !== x.cover_from ? ` to ${x.cover_to}` : ''}</td>
                <td className="num">{money(x.amount_cents, cur)}</td><td className="num">{money(x.expectedCents, cur)}</td><td className="num muted">{money(x.estFeesCents, cur)}</td>
                <td className="num"><span className={`chip ${x.matched ? 'teal' : 'rose'}`}>{x.matched ? 'Matches' : `${x.unexplainedCents > 0 ? '+' : '−'}${money(Math.abs(x.unexplainedCents), cur)}`}</span></td>
                <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => confirm('Delete this deposit?') && api(`/staff/deposits/${x.id}`, { method: 'DELETE' }).then(reload)}>Delete</button></td></tr>
            ))}</tbody></table>
        )}
      </section>
      <section className="panel"><div className="panel-h"><h3>Sales by day</h3></div>
        <table className="list"><thead><tr><th>Day</th><th>Cash</th><th>Cards</th><th>Apps</th></tr></thead>
          <tbody>{d.days.slice().reverse().map((x) => (
            <tr key={x.date}><td>{x.date}</td>{['cash', 'card', 'app'].map((k) => <td key={k} className="num">{x[`${k}Cents`] ? <>{money(x[`${k}Cents`], cur)} {x.covered[k] ? <span className="chip teal">Deposited</span> : <span className="chip amber">Not yet</span>}</> : <span className="dim">—</span>}</td>)}</tr>
          ))}</tbody></table>
      </section>
      {add && (
        <Modal title="Record a deposit" onClose={() => setAdd(null)} width={460}>
          <div className="seg" style={{ width: '100%' }}>{Object.entries(label).map(([k, l]) => <button key={k} aria-pressed={add.source === k} onClick={() => setAdd({ ...add, source: k })} style={{ flex: 1 }}>{l.split(' ')[0]}</button>)}</div>
          <div className="row"><label className="field grow"><span>Amount</span><input className="input" inputMode="decimal" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} /></label><label className="field grow"><span>Date it arrived</span><input className="input" type="date" value={add.depositDate} onChange={(e) => setAdd({ ...add, depositDate: e.target.value })} /></label></div>
          <div className="row"><label className="field grow"><span>For sales from</span><input className="input" type="date" value={add.coverFrom} onChange={(e) => setAdd({ ...add, coverFrom: e.target.value })} /></label><label className="field grow"><span>to</span><input className="input" type="date" value={add.coverTo} onChange={(e) => setAdd({ ...add, coverTo: e.target.value })} /></label></div>
          <label className="field"><span>Reference (optional)</span><input className="input" value={add.reference} onChange={(e) => setAdd({ ...add, reference: e.target.value })} maxLength={60} placeholder="Deposit slip number" /></label>
          <button className="btn primary lg block" disabled={!dollars(add.amount)} onClick={() => api('/staff/deposits', { method: 'POST', body: { source: add.source, amountCents: dollars(add.amount), depositDate: add.depositDate, coverFrom: add.coverFrom, coverTo: add.coverTo, reference: add.reference || undefined } }).then(() => { setAdd(null); reload(); }).catch((e) => toast(e.message, 'err'))}>Save</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Menu engineering (tab in Purchasing) ================= */
export function MenuEngineering() {
  const { settings } = useCC();
  const cur = settings.currency;
  const [days, setDays] = useState(30);
  const [d] = useLive(['menu', 'orders'], () => api(`/staff/menu-engineering?days=${days}`), [days]);
  if (!d) return null;
  const meta = { star: ['Stars', 'teal', 'Popular and profitable'], plowhorse: ['Plowhorses', 'amber', 'Popular, low profit'], puzzle: ['Puzzles', 'blue', 'Profitable, slow sellers'], dog: ['Dogs', 'rose', 'Slow and low profit'] };
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><span className="muted grow">Based on the last <select className="input" style={{ width: 110, height: 32, display: "inline-block" }} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[14, 30, 60, 90].map((n) => <option key={n} value={n}>{n} days</option>)}</select> of sales. Average profit per item {money(d.averageMarginCents, cur)}.</span></div>
      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 18 }}>
        {Object.entries(meta).map(([k, [name, color, sub]]) => { const list = d.items.filter((i) => i.class === k); return (
          <section key={k} className="panel"><div className="panel-h"><h3 className="grow">{name}</h3><span className={`chip ${color}`}>{list.length}</span></div><div className="panel-b stack" style={{ gap: 4 }}><span className="dim" style={{ fontSize: 12.5 }}>{sub}</span>{list.slice(0, 6).map((i) => <span key={i.id} style={{ fontSize: 14 }}>{i.name}</span>)}</div></section>
        ); })}
      </div>
      <section className="panel"><table className="list"><thead><tr><th>Item</th><th>Sold</th><th>Share</th><th>Price</th><th>Cost</th><th>Profit each</th><th>Total profit</th><th>What to do</th></tr></thead>
        <tbody>{d.items.map((i) => (
          <tr key={i.id}><td><b>{i.name}</b> <span className={`chip ${meta[i.class][1]}`}>{meta[i.class][0].replace(/s$/, '')}</span></td><td className="num">{i.qty}</td><td className="num muted">{i.mixPct}%</td><td className="num">{money(i.price_cents, cur)}</td>
            <td className="num muted">{i.costCents === null ? 'est.' : money(i.costCents, cur)}</td><td className="num">{money(i.marginCents, cur)}</td><td className="num">{money(i.contributionCents, cur)}</td><td className="muted" style={{ fontSize: 13 }}>{i.advice}</td></tr>
        ))}</tbody></table></section>
      <p className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>Items without a recipe use your food cost target to estimate cost. Add recipes for exact numbers.</p>
    </>
  );
}

/* ================= Prep list ================= */
export function Prep() {
  const [date, setDate] = useState('');
  const [d] = useLive(['menu'], () => api(`/staff/prep${date ? `?date=${date}` : ''}`), [date]);
  if (!d) return null;
  return (
    <>
      <PageHead title={`Prep list for ${d.weekday}`} sub={d.weeksOfData ? `Based on the last ${d.weeksOfData} ${d.weekday}s, plus ${d.bufferPct}% extra.` : `Not enough ${d.weekday}s yet. After a few weeks of sales this fills in on its own.`}>
        <input className="input" type="date" style={{ width: 160 }} value={date || d.date} onChange={(e) => setDate(e.target.value)} aria-label="Day" />
        <button className="btn" onClick={() => printPage('Report')}><Icon name="print" size={16} />Print</button>
      </PageHead>
      <div className="grid-2">
        <section className="panel"><div className="panel-h"><h3>Make</h3></div>
          {d.items.length === 0 ? <div className="panel-b muted">Nothing to prep yet.</div> : <table className="list"><thead><tr><th>Item</th><th>Usually sell</th><th>Prep</th><th>Done</th></tr></thead><tbody>{d.items.map((i) => <tr key={i.id}><td>{i.name}<div className="dim" style={{ fontSize: 12 }}>{i.category}</div></td><td className="num muted">{i.avg}</td><td className="num"><b>{i.prep}</b></td><td><input type="checkbox" aria-label={`${i.name} prepped`} /></td></tr>)}</tbody></table>}
        </section>
        <section className="panel"><div className="panel-h"><h3>Ingredients needed</h3></div>
          {d.ingredients.length === 0 ? <div className="panel-b muted">Add recipes in Purchasing to see ingredients here.</div> : <table className="list"><thead><tr><th>Ingredient</th><th>Need</th><th>Have</th><th /></tr></thead><tbody>{d.ingredients.map((g) => <tr key={g.id}><td>{g.name}</td><td className="num">{g.need} {g.unit}</td><td className="num muted">{g.have === null ? 'Not tracked' : `${g.have} ${g.unit}`}</td><td>{g.short > 0 && <span className="chip rose">Short {g.short}</span>}</td></tr>)}</tbody></table>}
        </section>
      </div>
    </>
  );
}

/* ================= Menu sync (owner, inside Menu) ================= */
export function MenuSync() {
  const { can } = useCC();
  const toast = useToast();
  const [locs, setLocs] = useState(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ targets: [], prices: true, details: true, availability: false, addMissing: true });
  useEffect(() => { if (can('owner')) api('/staff/locations').then((r) => setLocs(Array.isArray(r) ? r : r.locations || [])).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const others = (locs || []).filter((l) => !l.current && l.slug !== (localStorage.getItem('bh_loc') || 'main'));
  if (!can('owner') || others.length === 0) return null;
  const send = async () => { try { const r = await api('/staff/menu/sync', { method: 'POST', body: f }); toast(r.results.map((x) => `${x.slug}: ${x.updated} updated, ${x.added} added`).join('; ') || 'Nothing changed', 'ok'); setOpen(false); } catch (e) { toast(e.message, 'err'); } };
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>Send menu to other locations</button>
      {open && (
        <Modal title="Send this menu to other locations" onClose={() => setOpen(false)} width={480}>
          <div className="field"><span>To</span>{others.map((l) => <label key={l.slug} className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.targets.includes(l.slug)} onChange={(e) => setF({ ...f, targets: e.target.checked ? [...f.targets, l.slug] : f.targets.filter((x) => x !== l.slug) })} />{l.name}</label>)}</div>
          <div className="field"><span>What to send</span>
            <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.prices} onChange={(e) => setF({ ...f, prices: e.target.checked })} />Prices</label>
            <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.details} onChange={(e) => setF({ ...f, details: e.target.checked })} />Categories, descriptions, allergens and Spanish names</label>
            <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.availability} onChange={(e) => setF({ ...f, availability: e.target.checked })} />On or off for online ordering</label>
            <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.addMissing} onChange={(e) => setF({ ...f, addMissing: e.target.checked })} />Add items they don't have yet</label>
          </div>
          <span className="dim" style={{ fontSize: 12.5 }}>Items are matched by name. Stock counts, options and recipes stay separate at each location.</span>
          <button className="btn primary lg block" disabled={!f.targets.length} onClick={send}>Send</button>
        </Modal>
      )}
    </>
  );
}

/* ================= Referral card in the customer account ================= */
export function ReferralCard() {
  const [d, setD] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api('/c/referral').then(setD).catch(() => {}); }, []);
  if (!d?.enabled) return null;
  const off = money(d.rewardCents, d.currency);
  const share = async () => { const text = `Here's ${off} off at our favorite spot: ${d.link}`; if (navigator.share) { navigator.share({ text, url: d.link }).catch(() => {}); } else { navigator.clipboard?.writeText(d.link); setCopied(true); } };
  return (
    <div className="card stack">
      <b>Give {off}, get {off}</b>
      <span className="muted" style={{ fontSize: 14 }}>Share your link. When a friend makes an account and visits, you both get {off} off{d.minCents ? ` an order of ${money(d.minCents, d.currency)} or more` : ''}.</span>
      <div className="row"><input className="input grow" readOnly value={d.link} onFocus={(e) => e.target.select()} aria-label="Your referral link" /><button className="btn primary" onClick={share}>{copied ? 'Copied' : 'Share'}</button></div>
      {d.joined > 0 && <span className="dim" style={{ fontSize: 13 }}>{d.joined} friend{d.joined === 1 ? '' : 's'} joined, {d.rewarded} rewarded</span>}
    </div>
  );
}

/** Which kitchen area screen shows this unit's temperature log. */
function TempArea({ u, onDone }) {
  const { settings } = useCC();
  let areas = []; try { areas = [...JSON.parse(settings.kitchen_stations || '[]'), 'Expo', 'Packing', 'All areas']; } catch { areas = []; }
  return <select className="input" style={{ width: 130, height: 30, marginRight: 6 }} value={u.area || ''} onChange={(e) => api(`/staff/temp-units/${u.id}/area`, { method: 'PUT', body: { area: e.target.value || null } }).then(onDone)} aria-label={`Area screen for ${u.name}`}><option value="">No area screen</option>{areas.map((a) => <option key={a}>{a}</option>)}</select>;
}
