import { useEffect, useRef, useState } from 'react';
import { api, applyAccent, money, playChime } from '../lib.js';
import { Icon, Modal, Puck, useToast } from '../ui.jsx';
import { useCC } from './CommandCenter.jsx';
import { KdsCard, KdsEightySix, KdsRemake, KdsTemps, RushBar } from './Line.jsx';
import { TicketPrint, printPart } from '../pro-ui.jsx';
import { CookPicker, KdsMessages, KdsTimers, ShelfPicker } from './Pass.jsx';
import { KdsIngredients, KdsPrep, MakeGoodButtons, RunnerTicket } from './Run.jsx';
import { PlatePhoto, TimelineStrip, kdsOffline } from './Table.jsx';
import { PriorityChip, RecallList } from './Station.jsx';

const ago = (sql) => Math.max(0, Math.round((Date.now() - Date.parse(`${String(sql).replace(' ', 'T')}Z`)) / 60000));
const pj = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const qsArea = () => new URLSearchParams(location.search).get('area') || '';
const t12k = (hm) => new Date(`2000-01-01T${hm}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const withLoc = (path, loc) => `${path}${loc && loc !== 'main' ? `${path.includes('?') ? '&' : '?'}l=${loc}` : ''}`;

/* ================= Kitchen area screen (/kds) ================= */
export function KdsScreen() {
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(0);
  const [struck, setStruck] = useState({}); // orderId -> Set(itemId) the cook tapped
  const [showAll, setShowAll] = useState(() => localStorage.getItem('bh_kds_allday') !== '0');
  const [msg, setMsg] = useState(''); const [now, setNow] = useState(new Date());
  const seen = useRef(null);
  const [sel, setSel] = useState(0); // bump bar / keyboard selection
  const [speak, setSpeak] = useState(() => localStorage.getItem('bh_kds_speak') === '1');
  const [big, setBig] = useState(() => localStorage.getItem('bh_kds_big') === '1');
  const [theme, setTheme] = useState(() => localStorage.getItem('bh_kds_theme') || 'standard');
  const speakRef = useRef(speak); speakRef.current = speak;
  const [allergy, setAllergy] = useState(null); // { order, text } waiting for an allergy check
  const [lists, setLists] = useState(false);
  const [card, setCard] = useState(null); const [eightySix, setEightySix] = useState(false); const [remake, setRemake] = useState(null); const [temps, setTemps] = useState(false); const [tempCount, setTempCount] = useState(0);
  const [reasons, setReasons] = useState([]); const [shelfFor, setShelfFor] = useState(null); const [prep, setPrep] = useState(false); const [recall, setRecall] = useState(false); const [slip, setSlip] = useState(null);
  const [cook, setCookState] = useState(() => localStorage.getItem('bh_kds_cook') || ''); const setCook = (v) => { setCookState(v); localStorage.setItem('bh_kds_cook', v); }; const [toPrint, setToPrint] = useState([]);
  const [printHere, setPrintHere] = useState(() => localStorage.getItem('bh_kds_print') === '1'); const printRef = useRef(printHere); printRef.current = printHere;
  const dRef = useRef(null);
  const token = localStorage.getItem('bh_kds') || '';
  const area = qsArea();
  const hdr = () => (token && !area ? { 'X-Kds': token } : {});
  const q = area ? `?area=${encodeURIComponent(area)}` : '';
  const [offline, setOffline] = useState(false); const [photoFor, setPhotoFor] = useState(null);
  const cacheKey = area || 'device';
  const load = () => api(`/kds${q}`, { headers: hdr() }).then(async (x) => {
    if (offline || kdsOffline.queue().length) { const n = await kdsOffline.flush((it) => api(it.path, { method: 'POST', body: it.body, headers: hdr() })); if (n) setMsg(`Back online: sent ${n} saved change${n === 1 ? '' : 's'}`); }
    setOffline(false); kdsOffline.save(cacheKey, x);
    setD(x); setErr(''); applyAccent(x.business.accent);
    const ids = new Set(x.orders.map((o) => o.id));
    const fresh = seen.current ? x.orders.filter((o) => !seen.current.has(o.id)) : [];
    if (fresh.length) { playChime(); if (speakRef.current && window.speechSynthesis) for (const o of fresh) say(o, x); if (printRef.current) { setToPrint(fresh.map((o) => ({ ...o, allergy_note: o.allergy, items: (x.kind === 'station' ? o.mine : o.items).filter((i) => !i.held) }))); setTimeout(() => printPart('printing-ticket'), 150); } }
    seen.current = ids; dRef.current = x;
  }).catch((e) => { if (!e.status) { setOffline(true); if (!dRef.current) { const c = kdsOffline.load(cacheKey); if (c) { setD(c.data); dRef.current = c.data; } } } else setErr(e.message); });
  useEffect(() => { api(`/kds/remake-reasons${q}`, { headers: hdr() }).then(setReasons).catch(() => {}); const lt = () => api(`/kds/temps${q}`, { headers: hdr() }).then((t) => setTempCount(t.length)).catch(() => {}); lt(); const c = setInterval(lt, 120000); return () => clearInterval(c); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); const a = setInterval(load, 4000); const b = setInterval(() => setNow(new Date()), 15000); navigator.wakeLock?.request('screen').catch(() => {}); return () => { clearInterval(a); clearInterval(b); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const say = (o, x) => {
    const its = (x.kind === 'station' ? o.mine : o.items).filter((i) => !i.held);
    const u = new SpeechSynthesisUtterance(`Ticket ${o.number}. ${its.map((i) => `${i.qty} ${i.name}${i.mods.length ? `, ${i.mods.join(', ')}` : ''}`).join('. ')}${o.allergy ? `. Allergy: ${o.allergy}` : ''}`);
    u.rate = 1.02; window.speechSynthesis.speak(u);
  };
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3500); };
  const call = async (path, body, ok) => {
    setBusy((x) => x + 1);
    try { const r = await api(path, { method: 'POST', body: { ...body, ...(area ? { area } : {}) }, headers: hdr() }); ok?.(r); await load(); }
    catch (e) {
      if (!e.status && /\/kds\/(bump|complete|packed|served|recall|msg|timers|list-check|handed)/.test(path)) { kdsOffline.push({ path, body: { ...body, ...(area ? { area } : {}) } }); setOffline(true); flash('Offline: saved, it will send when the connection is back'); }
      else if (e.data?.needsPhoto) { const o = dRef.current?.orders.find((x) => x.id === body.orderId); if (o) setPhotoFor(o); }
      else flash(e.message);
    }
    setBusy((x) => x - 1);
  };
  const tap = (o, i) => setStruck((s) => { const set = new Set(s[o.id] || []); if (set.has(i.id)) set.delete(i.id); else set.add(i.id); return { ...s, [o.id]: set }; });
  const bump = (o, all) => { const ids = all ? undefined : [...(struck[o.id] || [])]; call('/kds/bump', { orderId: o.id, ...(ids?.length ? { itemIds: ids } : {}), ...(cook ? { cookId: Number(cook) } : {}) }, (r) => { setStruck((s) => ({ ...s, [o.id]: new Set() })); if (r.needsAllergyCheck) { setAllergy({ order: o, text: r.allergy }); return; } flash(r.ready ? `#${o.number} ready${r.buzz ? ', customer buzzed' : ''}` : r.waitingForExpo ? `#${o.number} done, sent to expo` : `#${o.number} updated`); }); };
  const complete = (o, confirmed) => {
    if (o.photoNeeded && !confirmed && !photoFor) { setPhotoFor(o); return; }
    if (o.allergy && dRef.current?.allergyCheck && !confirmed) { setAllergy({ order: o, text: o.allergy }); return; }
    call('/kds/complete', { orderId: o.id, ...(confirmed ? { allergyConfirmed: true } : {}) }, (r) => { setAllergy(null); flash(`#${o.number} complete${r.buzz ? ', customer buzzed' : ''}`); });
  };
  const pack = (o) => { if (dRef.current?.shelves?.length) setShelfFor(o); else call('/kds/packed', { orderId: o.id }, () => flash(`#${o.number} bagged`)); };
  const served = (o) => call('/kds/served', { orderId: o.id }, () => flash(`#${o.number} taken to ${x0().unit} ${o.table_label}`));
  const x0 = () => dRef.current || {};
  const makeGood = (o, kind) => call('/kds/makegood', { orderId: o.id, kind }, (r) => flash(`#${o.number}: ${r.what}`));
  // the main button on a ticket (also what the bump bar's Enter does)
  const primary = (o) => {
    const x = dRef.current; if (!x) return;
    if (x.kind === 'station') bump(o, !struck[o.id]?.size);
    else if (x.kind === 'expo') { const done = Object.values(o.areas).every((a) => a.done >= a.total); if (done || confirm(`Some areas are still cooking #${o.number}. Complete it anyway?`)) complete(o); }
    else if (x.kind === 'all') { if (x.expo) bump(o, !struck[o.id]?.size); else complete(o); }
    else if (x.kind === 'runner') served(o);
    else if (x.kind === 'pack') { const need = o.items.filter((i) => !i.held).length; if ((struck[o.id]?.size || 0) >= need) pack(o); else flash('Check each item first'); }
  };
  // Bump bars and keyboards: 1-9 pick a ticket, arrows move, Enter/Space bumps, R or Backspace recalls the last one.
  useEffect(() => {
    const onKey = (e) => {
      const x = dRef.current; if (!x || allergy || lists || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const n = x.orders.length;
      if (/^[1-9]$/.test(e.key)) { const i = Number(e.key) - 1; if (i < n) setSel(i); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { setSel((v) => Math.min(n - 1, v + 1)); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { setSel((v) => Math.max(0, v - 1)); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === ' ') { const o = x.orders[Math.min(sel, n - 1)]; if (o) primary(o); e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R' || e.key === 'Backspace') { const r = x.recent[0]; if (r) call('/kds/recall', { orderId: r.id }, () => flash(`#${r.number} back on the screen`)); e.preventDefault(); }
      else if (e.key === 'a' || e.key === 'A') setShowAll((v) => { localStorage.setItem('bh_kds_allday', v ? '0' : '1'); return !v; });
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());

  if (err && !d) return <div className="lobby"><div className="lobby-msg"><h1>{err}</h1><a className="btn" href="/kitchen">Open the kitchen page</a></div></div>;
  if (!d) return <div className="lobby" />;
  const late = d.lateMinutes;
  const tone = (o) => { const a = ago(o.sent_at || o.created_at); return a >= late ? 'late' : a >= late * 0.66 ? 'warn' : ''; };
  const who = (o) => (o.table_label ? `${d.unit} ${o.table_label}` : o.customer_name || o.guest_name || (o.fulfillment === 'delivery' ? 'Delivery' : 'To go'));
  const kindLabel = { station: 'Station', expo: 'Expo: complete orders here', pack: 'Packing: check and bag to-go orders', all: 'Every area' }[d.kind];
  const itemLine = (o, i, { tappable, showArea }) => (
    <li key={i.id} className={`${i.done || struck[o.id]?.has(i.id) ? 'done' : ''} ${i.held ? 'held' : ''} ${d.pacing && i.startIn > 0 && !i.done ? 'wait' : ''}`} onClick={tappable && !i.done && !i.held ? (e) => { e.stopPropagation(); tap(o, i); } : undefined} role={tappable ? 'button' : undefined}>
      <b className="num">{i.qty}</b>
      <span>{i.seat ? <span className="chip" style={{ marginRight: 6, fontSize: 11 }}>S{i.seat}{i.seatName ? ` ${i.seatName}` : ''}</span> : null}<button type="button" className="kds-info" aria-label={`Recipe for ${i.name}`} onClick={(e) => { e.stopPropagation(); if (i.itemId) setCard(i.itemId); }}>i</button>{d.pacing && i.startIn !== null && i.startIn !== undefined && !i.done && o.items.some((x) => x.startIn > 0) && <span className={`chip ${i.startIn <= 0 ? 'amber' : ''}`} style={{ marginRight: 6, fontSize: 11 }}>{i.startIn <= 0 ? 'Start now' : `Wait ${i.startIn}m`}</span>}{i.name}{showArea && <span className="chip" style={{ marginLeft: 6, fontSize: 11 }}>{i.area}</span>}{i.held && <span className="chip amber" style={{ marginLeft: 6, fontSize: 11 }}>{i.fireIn !== null && i.fireIn !== undefined ? (i.fireIn <= 0 ? 'Firing now' : `Fires in ${i.fireIn}m`) : 'Held'}</span>}{i.mods.length > 0 && <em>{i.mods.join(', ')}</em>}{i.note && <em>{i.note}</em>}{i.done && <Icon name="check" size={14} />}</span>
    </li>
  );
  return (
    <div className={`kds-screen ${big ? 'kds-big' : ''} kds-theme-${theme}`}>
      <header className="kds-top">
        <Puck state="buzzed" size={30} />
        <div className="grow"><b className="kds-area">{d.area}</b><span className="dim">{kindLabel}</span></div>
        <span className="chip">{d.orders.length} ticket{d.orders.length === 1 ? '' : 's'}</span>
        {d.held > 0 && d.kind !== 'pack' && <span className="chip amber">{d.held} pre-order{d.held === 1 ? '' : 's'} waiting</span>}
        <span className="num kds-clock">{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        <CookPicker d={d} cook={cook} setCook={setCook} />
        <KdsTimers d={d} call={call} flash={flash} />
        <KdsMessages d={d} call={call} flash={flash} />
        {tempCount > 0 && <button className="btn sm" onClick={() => setTemps(true)}>Temps</button>}
        <button className="btn sm" onClick={() => setEightySix(true)}>86</button>
        {d.kind !== 'runner' && d.kind !== 'pack' && <button className="btn sm" onClick={() => setPrep(true)}>Prep</button>}
        <button className="btn sm" title="Bring back a finished ticket" onClick={() => setRecall(true)}>Recent</button>
        <button className="btn sm" aria-pressed={printHere} title="Print this area's new tickets on this device's printer" onClick={() => { const v = !printHere; setPrintHere(v); localStorage.setItem('bh_kds_print', v ? '1' : '0'); }}>{printHere ? 'Printing' : 'Print'}</button>
        {d.lists.length > 0 && <button className="btn sm" onClick={() => setLists(true)}>Lists {d.lists.reduce((a, l) => a + l.count, 0)}/{d.lists.reduce((a, l) => a + l.total, 0)}</button>}
        <button className="btn sm" aria-pressed={speak} title="Read new tickets out loud" onClick={() => { const v = !speak; setSpeak(v); localStorage.setItem('bh_kds_speak', v ? '1' : '0'); if (v && window.speechSynthesis) window.speechSynthesis.speak(new SpeechSynthesisUtterance('Talking tickets on')); }}>{speak ? 'Talking' : 'Silent'}</button>
        {d.kind !== 'pack' && d.kind !== 'runner' && <button className="btn sm" aria-pressed={showAll} onClick={() => { setShowAll(!showAll); localStorage.setItem('bh_kds_allday', showAll ? '0' : '1'); }}>All day</button>}
        {!d.device && <select className="input" style={{ width: 150, height: 34 }} value={d.area} onChange={(e) => { location.href = withLoc(`/kds?area=${encodeURIComponent(e.target.value)}`, new URLSearchParams(location.search).get('l')); }} aria-label="Area">{d.areas.map((a) => <option key={a}>{a}</option>)}</select>}
        <button className="btn sm" aria-pressed={big} title="Bigger text for screens across the kitchen" onClick={() => { setBig(!big); localStorage.setItem('bh_kds_big', big ? '0' : '1'); }}>{big ? 'Big text' : 'Aa'}</button>
        <button className="btn sm" title="Ticket colours: standard, high contrast, or colour-blind safe" onClick={() => { const n = { standard: 'contrast', contrast: 'safe', safe: 'standard' }[theme]; setTheme(n); localStorage.setItem('bh_kds_theme', n); }}>{{ standard: 'Colours', contrast: 'High contrast', safe: 'Colour-safe' }[theme]}</button>
        <button className="btn sm" onClick={full} aria-label="Full screen"><Icon name="expand" size={16} /></button>
      </header>
      {msg && <div className="kds-msg" role="status">{msg}</div>}
      {offline && <div className="kds-banner here"><b>Offline.</b> Showing the last tickets this screen saw. Taps are saved and sent when the connection is back{kdsOffline.queue().length ? ` (${kdsOffline.queue().length} waiting)` : ''}.</div>}
      {d.timeline?.length > 0 && <TimelineStrip list={d.timeline} unit={d.unit} />}
      {d.rush && (d.rush.level !== 'normal' || d.kind === 'expo' || d.kind === 'all') && <RushBar rush={d.rush} quote={d.quote} canPause={d.kind === 'expo' || d.kind === 'all'} onPause={(m) => call('/kds/pause', { minutes: m }, () => flash(m ? `Online orders paused for ${m} minutes` : 'Online orders back on'))} />}
      {d.arrivals.length > 0 && <div className="kds-banner here">{d.arrivals.map((a) => <span key={a.id} className="row" style={{ gap: 8 }}><b>#{a.number} {a.name ? a.name.split(' ')[0] : ''} is here</b>{a.note && <span>{a.note}</span>}<span className="dim">{a.ready ? 'ready' : 'still cooking'}</span><button className="btn sm" onClick={() => call('/kds/handed', { orderId: a.id }, () => flash(`#${a.number} brought out`))}>Brought out</button></span>)}</div>}
      {d.enRoute?.length > 0 && <div className="kds-banner">{d.enRoute.map((a) => <span key={a.id}><b>#{a.number} {a.name ? a.name.split(' ')[0] : ''}</b> is about {a.etaMinutes} min away ({a.km} km){a.ready ? ', order ready' : ', still cooking'}</span>)}</div>}
      {d.events.length > 0 && <div className="kds-banner">{d.events.map((e) => <span key={e.id}><b>Event {t12k(e.start)}: {e.name}</b> ({e.room}, {e.guests} guests): {e.items.map((i) => `${i.qty} ${i.name}`).join(', ')}{e.fired ? ' · sent' : e.fireTime ? ` · fires ${t12k(e.fireTime)}` : ''}</span>)}</div>}
      <div className={`kds-body ${showAll && d.kind !== 'pack' && d.kind !== 'runner' ? 'with-side' : ''}`}>
        <div className="kds-grid">
          {d.orders.length === 0 && <div className="kds-empty"><b>All caught up</b><span className="dim">{d.kind === 'runner' ? 'Finished plates for tables show up here with their seats.' : d.kind === 'pack' ? 'To-go and delivery orders show up here to check and bag.' : 'New tickets for this area show up here with a chime.'}</span></div>}
          {d.orders.map((o, idx) => {
            const areas = Object.entries(o.areas);
            const allDone = areas.every(([, a]) => a.done >= a.total);
            return (
              <article key={o.id} className={`ticket-card ${tone(o)} ${o.passSince && d.passMinutes && Date.now() - Date.parse(`${o.passSince.replace(' ', 'T')}Z`) >= d.passMinutes * 60000 ? 'pass-late' : ''} ${idx === Math.min(sel, d.orders.length - 1) ? 'kds-sel' : ''} ${o.priority ? 'prio' : ''}`} onClick={() => setSel(idx)}>
                <header>{idx < 9 && <span className="kds-key" aria-hidden="true">{idx + 1}</span>}<b>#{o.number}</b><PriorityChip p={o.priority} /><span className="grow">{who(o)}</span><span className="age num">{(() => { const m = ago(o.sent_at || o.created_at); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; })()}</span></header>{['expo', 'all'].includes(d.kind) && <button type="button" className={`rush-tog ${o.priority ? 'on' : ''}`} title={o.priority ? 'Back to normal' : 'Make this a rush'} onClick={(e) => { e.stopPropagation(); call('/kds/priority', { orderId: o.id, priority: o.priority ? 0 : 1 }, () => flash(o.priority ? `#${o.number} back to normal` : `#${o.number} is a rush`)); }}>{o.priority ? 'Take off rush' : 'Rush this'}</button>}
                <div className="row wrap" style={{ gap: 6 }}>
                  {o.fulfillment === 'delivery' && <span className="chip rose">Delivery{o.driver_name ? `: ${o.driver_name.split(' ')[0]}` : ''}</span>}
                  {o.fulfillment === 'pickup' && o.source !== 'staff' && <span className="chip amber">Pickup</span>}
                  {o.source === 'table' && <span className="chip blue">Table order</span>}
                  {d.kind === 'pack' && <span className={`chip ${o.cooking ? '' : 'teal'}`}>{o.cooking ? 'Still cooking' : 'Ready to bag'}</span>}
                  {d.kind !== 'station' && areas.length > 1 && areas.map(([n, a]) => <span key={n} className={`chip ${a.done >= a.total ? 'teal' : ''}`}>{n} {a.done}/{a.total}</span>)}
                  {d.kind === 'station' && areas.filter(([n]) => n !== d.area).map(([n, a]) => <span key={n} className={`chip ${a.done >= a.total ? 'teal' : ''}`} title="Other areas on this ticket">{n} {a.done >= a.total ? 'done' : 'cooking'}</span>)}
                </div>
                {o.allergy && <div className="ticket-allergy">ALLERGY: {o.allergy}{o.allergy_checked_by ? ` (checked by ${o.allergy_checked_by})` : ''}{['expo', 'all', 'runner'].includes(d.kind) && <button type="button" className="slip-btn" onClick={(e) => { e.stopPropagation(); setSlip(o); setTimeout(() => printPart('printing-slip'), 80); }}>Print slip</button>}</div>}
                {o.passSince && d.kind !== 'station' && (() => { const m = Math.max(0, Math.round((Date.now() - Date.parse(`${o.passSince.replace(' ', 'T')}Z`)) / 60000)); return <span className={`chip ${d.passMinutes && m >= d.passMinutes ? 'rose' : 'teal'}`}>At the pass {m}m</span>; })()}
                {o.makegood && (d.kind === 'expo' || d.kind === 'all') && <MakeGoodButtons o={o} onPick={makeGood} />}
                {o.arrived && <span className="chip rose">Customer is here{o.arrival_note ? `: ${o.arrival_note}` : ''}</span>}
                {o.order_notes && <div style={{ color: 'var(--accent)', fontSize: 14 }}>{o.order_notes}</div>}
                {d.kind === 'runner' ? <RunnerTicket o={o} unit={d.unit} onServed={served} /> : <ul>{(d.kind === 'station' ? o.mine : o.items).map((i) => itemLine(o, i, { tappable: d.kind === 'station' || d.kind === 'all' || d.kind === 'pack', showArea: d.kind === 'expo' || d.kind === 'all' }))}</ul>}
                {d.kind === 'station' && <button className="btn primary lg block" disabled={busy > 0} onClick={(e) => { e.stopPropagation(); bump(o, !struck[o.id]?.size); }}><Icon name="check" size={18} />{struck[o.id]?.size ? `Done: ${struck[o.id].size} item${struck[o.id].size === 1 ? '' : 's'}` : `${d.area} done`}</button>}
                {d.kind === 'all' && <button className="btn primary lg block" disabled={busy > 0} onClick={(e) => { e.stopPropagation(); primary(o); }}><Icon name="check" size={18} />{d.expo ? 'Done, send to expo' : 'Ready'}</button>}
                {d.kind === 'expo' && <button className={`btn lg block ${allDone ? 'primary' : ''}`} disabled={busy > 0} onClick={(e) => { e.stopPropagation(); primary(o); }}><Icon name="check" size={18} />{allDone ? 'Complete and buzz' : 'Waiting on areas'}</button>}
                {d.kind === 'pack' && <button className="btn primary lg block" disabled={busy > 0 || (struck[o.id]?.size || 0) < o.items.filter((i) => !i.held).length} onClick={(e) => { e.stopPropagation(); pack(o); }} title="Tap each item as it goes in the bag">{(struck[o.id]?.size || 0) < o.items.filter((i) => !i.held).length ? `Check items (${struck[o.id]?.size || 0}/${o.items.filter((i) => !i.held).length})` : 'Bagged'}</button>}
              </article>
            );
          })}
        </div>
        {showAll && d.kind !== 'pack' && d.kind !== 'runner' && (
          <aside className="kds-side">
            <h3>All day</h3>
            {d.allDay.length === 0 ? <span className="dim">Nothing waiting.</span> : d.allDay.map((c) => (
              <div key={c.name} className="allday-row"><b className="num">{c.qty}</b><span className="grow">{c.name}{d.kind !== 'station' && <span className="dim"> · {c.area}</span>}{c.mods.length > 0 && <em>{c.mods.map((m) => `${m.qty} ${m.name}`).join(', ')}</em>}</span></div>
            ))}
          </aside>
        )}
      </div>
      {allergy && (
        <Modal title={`Allergy check: #${allergy.order.number}`} onClose={() => setAllergy(null)} width={460}>
          <div className="ticket-allergy" style={{ fontSize: 20 }}>ALLERGY: {allergy.text}</div>
          <p style={{ margin: 0 }}>Check every plate on this order is safe for this allergy before it goes out.</p>
          <button className="btn primary lg block" onClick={() => complete(allergy.order, true)}>I checked it, complete the order</button>
          <button className="btn ghost block" onClick={() => setAllergy(null)}>Not yet</button>
        </Modal>
      )}
      {prep && <KdsPrep hdr={hdr()} q={q} onClose={() => setPrep(false)} />}
      {slip && <div className="print-slip" aria-hidden="true"><div className="slip-head">ALLERGY</div><div className="slip-where">#{slip.number}{slip.table_label ? ` · ${x0().unit} ${slip.table_label}` : ''}</div><div className="slip-what">{slip.allergy}</div>{slip.items.filter((i) => /^ALLERGY/.test(i.note || '')).map((i) => <div key={i.id} className="slip-dish">{i.seat ? `Seat ${i.seat}${i.seatName ? ` (${i.seatName})` : ''}: ` : ''}{i.qty} {i.name}</div>)}<div className="slip-foot">Hand this dish to the right guest. Checked by: ________</div></div>}
      {recall && <RecallList hdr={hdr()} q={q} call={call} flash={flash} onClose={() => setRecall(false)} />}
      {photoFor && <PlatePhoto order={photoFor} hdr={hdr()} onClose={() => setPhotoFor(null)} onDone={() => { const o = photoFor; setPhotoFor(null); complete(o, Boolean(o.allergy && d.allergyCheck)); }} />}
      {shelfFor && <ShelfPicker d={d} order={shelfFor} onClose={() => setShelfFor(null)} onPick={(s) => { const o = shelfFor; setShelfFor(null); call('/kds/packed', { orderId: o.id, ...(s ? { shelf: s } : {}) }, () => flash(`#${o.number} bagged${s ? ` on shelf ${s}` : ''}`)); }} />}
      {card && <KdsCard itemId={card} hdr={hdr()} q={q} onClose={() => setCard(null)} />}
      {eightySix && <KdsEightySix hdr={hdr()} q={q} flash={flash} onClose={() => setEightySix(false)} />}
      {remake && <KdsRemake order={remake} hdr={hdr()} reasons={reasons} flash={(t) => { flash(t); load(); }} onClose={() => setRemake(null)} />}
      {temps && <KdsTemps hdr={hdr()} q={q} user={!d.device} flash={flash} onClose={() => setTemps(false)} />}
      <TicketPrint orders={toPrint} unit={d.unit} />
      {lists && (
        <Modal title={`${d.area} lists`} onClose={() => setLists(false)} width={520}>
          {d.lists.map((l) => <div key={l.id} className="stack" style={{ gap: 6 }}><b>{l.name} <span className="dim">{l.count}/{l.total}{l.dueTime ? `, due ${t12k(l.dueTime)}` : ''}</span></b>
            {l.items.map((it, i) => <label key={i} className="row" style={{ fontSize: 16 }}><input type="checkbox" checked={Boolean(it.done)} onChange={(e) => call('/kds/list-check', { templateId: l.id, index: i, done: e.target.checked })} /><span className="grow" style={{ textDecoration: it.done ? 'line-through' : 'none', opacity: it.done ? 0.6 : 1 }}>{it.text}</span>{it.done && <span className="dim" style={{ fontSize: 12 }}>{it.done.by}</span>}</label>)}</div>)}
        </Modal>
      )}
      {d.recent.length > 0 && (
        <footer className="kds-recent"><span className="dim">Just finished:</span>{d.recent.map((r) => <span key={r.id} className="chip teal">#{r.number}{r.table ? ` ${d.unit} ${r.table}` : r.name ? ` ${r.name.split(' ')[0]}` : ''}<button className="btn ghost sm" style={{ height: 24, padding: '0 6px' }} onClick={() => call('/kds/recall', { orderId: r.id }, () => flash(`#${r.number} back on the screen`))}>Recall</button>{r.items?.length > 0 && <button className="btn ghost sm" style={{ height: 24, padding: '0 6px' }} onClick={() => setRemake(r)}>Remake</button>}</span>)}</footer>
      )}
    </div>
  );
}

/* ================= Set up area screens (Kitchen page) ================= */
export function AreaScreens() {
  const { can, reloadSettings } = useCC(); const toast = useToast();
  const [d, setD] = useState(null);
  const load = () => api('/staff/kds/setup').then(setD).catch((e) => toast(e.message, 'err'));
  if (!can('manager')) return <a className="btn" href="/kds">Area screens</a>;
  const start = (area) => api('/staff/kds/start', { method: 'POST', body: { area } }).then((r) => { localStorage.setItem('bh_kds', r.token); location.href = withLoc('/kds', r.loc); }).catch((e) => toast(e.message, 'err'));
  const flag = (k, v) => api('/staff/settings', { method: 'PUT', body: { [k]: v ? '1' : '0' } }).then(() => { reloadSettings?.(); load(); });
  const setItem = (itemId, station) => api('/staff/kds/item-station', { method: 'PUT', body: { itemId, station: station || null } }).then(load).catch((e) => toast(e.message, 'err'));
  const saveMap = (map) => api('/staff/settings', { method: 'PUT', body: { station_map: JSON.stringify(map) } }).then(() => { reloadSettings?.(); load(); });
  const saveList = (list) => api('/staff/settings', { method: 'PUT', body: { kitchen_stations: JSON.stringify(list) } }).then(() => { reloadSettings?.(); load(); }).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <button className="btn" onClick={load}><Icon name="flame" size={16} />Area screens</button>
      {d && (
        <Modal title="Kitchen area screens" onClose={() => setD(null)} width={680}>
          <p className="muted" style={{ margin: 0 }}>Put a tablet at each area. Each screen shows only that area's items, with all-day counts. Open this window on the tablet itself and choose <b>Make this device</b>.</p>
          <b>Areas</b>
          <div className="row wrap" style={{ gap: 6 }}>
            {d.stations.map((s, i) => <span key={s} className="chip">{s}<button className="btn ghost sm" style={{ height: 22, padding: '0 4px' }} aria-label={`Remove ${s}`} disabled={d.stations.length < 2} onClick={() => confirm(`Remove the ${s} area? Its items move to ${d.stations.filter((x) => x !== s)[0]}.`) && saveList(d.stations.filter((_, k) => k !== i))}>×</button></span>)}
            {d.stations.length < 8 && <button className="btn sm" onClick={() => { const n = prompt('New area name (like Grill, Fryer, Pastry, Bar)'); if (n?.trim()) saveList([...d.stations, n.trim().slice(0, 20)]); }}>Add an area</button>}
          </div>
          <table className="list"><tbody>
            {[...d.stations.map((s) => [s, 'Makes its own items']), ['Expo', 'Sees every ticket and every area, and completes orders'], ['Packing', 'Checks and bags to-go and delivery orders'], ['Runner', 'Finished plates by table and seat, for food runners'], ['All areas', 'One screen for a small kitchen']].map(([a, what]) => (
              <tr key={a}><td><b>{a}</b><div className="dim" style={{ fontSize: 12 }}>{what}{d.speed.find((x) => x.area === a) ? `, ${d.speed.find((x) => x.area === a).minutes} min average today` : ''}</div></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><a className="btn sm ghost" href={`/kds?area=${encodeURIComponent(a)}`}>Open here</a><button className="btn sm" onClick={() => start(a)}>Make this device the {a} screen</button></td></tr>
            ))}
          </tbody></table>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={d.expo} onChange={(e) => flag('kds_expo', e.target.checked)} />Orders wait for expo. When every area is done, expo checks the plate and completes the order (that's when the customer is buzzed). Off: the last area to finish completes it.</label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={d.allergyCheck} onChange={(e) => flag('kds_allergy_check', e.target.checked)} />Allergy check: orders with an allergy can't be completed until someone confirms they checked it (logged with the screen or name)</label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={d.pacing} onChange={(e) => flag('kds_pacing', e.target.checked)} />Ticket pacing: quick dishes show "Wait 6m" so every area finishes together (uses each dish's cook time from its recipe card)</label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={d.pack} onChange={(e) => flag('kds_pack', e.target.checked)} />Use a packing screen for to-go and delivery orders</label>
          <b>Which area makes what</b>
          <div className="grid-2" style={{ gap: 8 }}>{d.categories.map((c) => <label key={c} className="row" style={{ fontSize: 14 }}><span className="grow">{c}</span><select className="input" style={{ width: 140, height: 32 }} value={d.map[c] || d.stations[0]} onChange={(e) => saveMap({ ...d.map, [c]: e.target.value })}>{d.stations.map((s) => <option key={s}>{s}</option>)}</select></label>)}</div>
          <details><summary className="muted" style={{ cursor: 'pointer' }}>Exceptions for single items</summary>
            <table className="list"><tbody>{d.items.map((i) => <tr key={i.id}><td>{i.name}<div className="dim" style={{ fontSize: 12 }}>{i.category}</div></td><td><select className="input" style={{ width: 160, height: 32 }} value={i.station || ''} onChange={(e) => setItem(i.id, e.target.value)} aria-label={`Area for ${i.name}`}><option value="">Same as {i.category} ({d.map[i.category] || d.stations[0]})</option>{d.stations.map((s) => <option key={s}>{s}</option>)}</select></td></tr>)}</tbody></table>
          </details>
          <p className="dim" style={{ fontSize: 12.5, margin: 0 }}>Bump bars and keyboards: 1–9 pick a ticket, arrows move, Enter or Space finishes it, R brings back the last one, A shows or hides all-day counts. Tap <b>Silent</b> on a screen to have it read new tickets out loud.</p>
          <button className="btn ghost" onClick={() => confirm('Sign out every area screen? Each tablet will need setting up again.') && api('/staff/kds/signout-all', { method: 'POST' }).then(() => toast('All area screens signed out', 'ok'))}>Sign out all area screens</button>
        </Modal>
      )}
    </>
  );
}

/** All-day counts for the Kitchen page. */
export function AllDay({ orders }) {
  const counts = new Map();
  for (const o of orders) for (const i of o.items) { if (i.done_at || (i.course > 1 && !i.fired_at)) continue; const c = counts.get(i.name) || { name: i.name, qty: 0 }; c.qty += i.qty; counts.set(i.name, c); }
  const list = [...counts.values()].sort((a, b) => b.qty - a.qty);
  if (!list.length) return null;
  return <section className="panel" style={{ marginBottom: 14 }}><div className="panel-h"><h3>All day</h3></div><div className="panel-b row wrap" style={{ gap: 8 }}>{list.map((c) => <span key={c.name} className="chip"><b className="num">{c.qty}</b>&nbsp;{c.name}</span>)}</div></section>;
}

/* ================= Menu board TV (/menuboard) ================= */
export function MenuBoard() {
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [page, setPage] = useState(0);
  const hdr = () => ({ 'X-Board': localStorage.getItem('bh_board') || '' });
  const load = () => api('/menuboard', { headers: hdr() }).then((x) => { setD(x); setErr(''); applyAccent(x.business.accent); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const a = setInterval(load, 30000); navigator.wakeLock?.request('screen').catch(() => {}); return () => clearInterval(a); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = (() => {
    if (!d) return [];
    const per = d.columns * 13; const out = [[]]; let n = 0;
    for (const s of d.sections) { const size = s.items.length + 2; if (n + size > per && out[out.length - 1].length) { out.push([]); n = 0; } out[out.length - 1].push(s); n += size; }
    return out;
  })();
  useEffect(() => { if (pages.length < 2) return undefined; const t = setInterval(() => setPage((p) => (p + 1) % pages.length), (d?.rotateSeconds || 12) * 1000); return () => clearInterval(t); }, [pages.length, d?.rotateSeconds]);
  if (err && !d) return <div className="lobby"><div className="lobby-msg"><h1>{err}</h1><a className="btn" href="/">Open the command center</a></div></div>;
  if (!d) return <div className="lobby" />;
  const cur = pages[page % Math.max(1, pages.length)] || [];
  return (
    <div className="menuboard">
      <header>{d.business.logo ? <img src={d.business.logo} alt="" /> : <Puck state="buzzed" size={44} />}<b>{d.title || d.business.name}</b>{pages.length > 1 && <span className="dim">{page % pages.length + 1} / {pages.length}</span>}</header>
      <div className="mb-cols" style={{ columnCount: d.columns }}>
        {cur.map((s) => (
          <section key={s.name} className="mb-sec"><h2>{s.name}</h2>
            {s.items.map((i) => (
              <div key={i.id} className={`mb-item ${i.soldOut ? 'out' : ''}`}>
                {d.showPhotos && i.photo && <img src={i.photo} alt="" />}
                <div className="grow"><div className="row"><b className="grow">{i.name}</b>{i.special && <span className="chip amber">Today</span>}{i.deal && <span className="chip teal">{i.deal}</span>}</div>
                  {i.description && <div className="dim mb-desc">{i.description}</div>}
                  {(i.calories || i.diet?.length) ? <div className="dim mb-desc">{[i.calories ? `${i.calories} cal` : '', ...(i.diet || [])].filter(Boolean).join(' · ')}</div> : null}</div>
                <span className="mb-price num">{i.soldOut ? 'Sold out' : <>{i.regularCents !== i.priceCents && <s className="dim">{money(i.regularCents, d.currency)}</s>} {money(i.priceCents, d.currency)}</>}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
export function MenuBoardPanel({ f, setF }) {
  const toast = useToast(); const [cats, setCats] = useState([]);
  useEffect(() => { api('/staff/kds/setup').then((x) => setCats(x.categories)).catch(() => {}); }, []);
  const chosen = pj(f.board_categories, []);
  const start = () => api('/staff/menuboard/start', { method: 'POST' }).then((r) => { localStorage.setItem('bh_board', r.token); location.href = withLoc('/menuboard', r.loc); }).catch((e) => toast(e.message, 'err'));
  return (
    <section className="panel"><div className="panel-h"><h3 className="grow">Menu board TV</h3><a className="btn sm ghost" href="/menuboard" target="_blank" rel="noreferrer">Preview</a><button className="btn sm" onClick={start}>Make this device the menu board</button></div><div className="panel-b stack">
      <span className="muted" style={{ fontSize: 13.5 }}>Shows your live menu on a TV: today's specials, happy-hour prices and sold-out items update by themselves. Save settings before starting the board.</span>
      <div className="row"><label className="field grow"><span>Title (blank uses your business name)</span><input className="input" value={f.board_title} onChange={(e) => setF({ ...f, board_title: e.target.value })} maxLength={60} /></label>
        <label className="field"><span>Columns</span><select className="input" value={f.board_cols} onChange={(e) => setF({ ...f, board_cols: e.target.value })}>{['1', '2', '3', '4'].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field"><span>Seconds per page</span><input className="input" style={{ width: 90 }} type="number" min={5} max={120} value={f.board_rotate_seconds} onChange={(e) => setF({ ...f, board_rotate_seconds: e.target.value })} /></label></div>
      <div className="row wrap" style={{ gap: 6 }}><span className="muted" style={{ fontSize: 13.5 }}>Categories (none picked shows all):</span>{cats.map((c) => <button key={c} type="button" className={`chip ${chosen.includes(c) ? 'teal' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={chosen.includes(c)} onClick={() => setF({ ...f, board_categories: JSON.stringify(chosen.includes(c) ? chosen.filter((x) => x !== c) : [...chosen, c]) })}>{c}</button>)}</div>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.board_photos === '1'} onChange={(e) => setF({ ...f, board_photos: e.target.checked ? '1' : '0' })} />Show dish photos</label>
      <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => api('/staff/menuboard/signout-all', { method: 'POST' }).then(() => toast('Menu boards signed out', 'ok'))}>Sign out all menu boards</button>
    </div></section>
  );
}
