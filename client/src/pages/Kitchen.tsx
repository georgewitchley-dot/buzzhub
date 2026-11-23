import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { api, minutesSince, playChime, useTick } from '../lib';
import { Icon, useToast } from '../ui';
import { PageHead, useCC, useLive } from './CommandCenter';
import { TicketPrint, printPart } from '../pro-ui';
import { FireButton, RecipeCard } from './Plus';
import { StationPicker, stationOf } from './More';
import { cookPlan, useCookTimes } from './Smart';
import { AllDay, AreaScreens } from './Areas';
import { RushPanel } from './Line';
import { AreaLoad } from './Run';
import { printRoutes } from '../printing';

export default function Kitchen() {
  const { settings } = useCC();
  const toast = useToast();
  const [data] = useLive(['orders'], () => api('/staff/kitchen'));
  const seen = useRef<any>(null);
  const [card, setCard] = useState(null);
  const cookTimes = useCookTimes();
  const [myStation, setMyStation] = useState(() => localStorage.getItem('bh_station') || '');
  const [station, setStation] = useState(() => localStorage.getItem('bh_print_station') === '1');
  const [toPrint, setToPrint] = useState<any[]>([]);
  const stationRef = useRef(station); stationRef.current = station;
  const ticketPrinters = useRef(0); useEffect(() => { printRoutes().then((r) => { ticketPrinters.current = (r.ticket || []).length; }); }, []);
  const boardRef = useRef<any>(null);
  useTick(15000);

  // chime + flash for tickets that just arrived
  useEffect(() => {
    if (!data) return;
    const ids = new Set<any>(data.orders.filter((o) => o.status !== 'ready').map((o) => o.id));
    if (seen.current) {
      const fresh = [...ids].filter((id) => !seen.current.has(id));
      if (fresh.length) {
        playChime();
        if (stationRef.current && !ticketPrinters.current) { setToPrint(data.orders.filter((o) => fresh.includes(o.id))); setTimeout(() => printPart('printing-ticket'), 120); }
        requestAnimationFrame(() => fresh.forEach((id) => { const el = boardRef.current?.querySelector(`[data-id="${id}"]`); if (el) gsap.fromTo(el, { boxShadow: '0 0 0 4px rgba(var(--accent-rgb), .9)' }, { boxShadow: '0 0 0 0px rgba(var(--accent-rgb), 0)', duration: 1.6 }); }));
      }
    }
    seen.current = ids;
  }, [data]);

  const act = async (path, msg) => { try { const r = await api(path, { method: 'POST' }); toast(r.buzz ? `${msg}. Customer buzzed.` : msg, 'ok'); } catch (e) { toast(e.message, 'err'); } };
  const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
  if (!data) return null;
  const late = data.lateMinutes;
  const mine = (i) => !myStation || stationOf(settings, i) === myStation;
  const cooking = data.orders.filter((o) => o.status !== 'ready' && o.status !== 'paid')
    .map((o) => (myStation ? { ...o, items: o.items.filter((i) => mine(i) && !i.done_at) } : o)).filter((o) => o.items.length);
  const stationDone = async (o) => { try { const r = await api(`/staff/kitchen/${o.id}/station`, { method: 'POST', body: { itemIds: o.items.filter((i) => !(i.course > 1 && !i.fired_at)).map((i) => i.id) } }); if (r.allDone) await act(`/staff/orders/${o.id}/ready`, `#${o.number} ready`); else toast(`#${o.number}: ${myStation} done`, 'ok'); } catch (e) { toast(e.message, 'err'); } };
  const done = data.orders.filter((o) => o.status === 'ready' || o.status === 'paid');

  return (
    <>
      <PageHead title="Kitchen" sub={`${cooking.length} ticket${cooking.length === 1 ? '' : 's'} to make${data.held ? `, ${data.held} pre-order${data.held === 1 ? '' : 's'} waiting for a table` : ''}. Tickets turn red after ${late} minutes.`}>
        <label className="btn" title="Prints each new ticket on this device's printer. In Chrome, start with --kiosk-printing to skip the print dialog."><input type="checkbox" checked={station} onChange={(e) => { setStation(e.target.checked); localStorage.setItem('bh_print_station', e.target.checked ? '1' : '0'); }} />Print new tickets here</label>
        <AreaScreens />
        <StationPicker value={myStation} onChange={(v) => { setMyStation(v); localStorage.setItem('bh_station', v); }} />
        <button className="btn" onClick={full}><Icon name="expand" size={17} />Full screen</button>
      </PageHead>
      <RushPanel />
      <AreaLoad />
      {localStorage.getItem('bh_kitchen_allday') !== '0' && <AllDay orders={cooking} />}
      {cooking.length === 0 && <div className="panel empty"><b>All caught up</b><span>New orders from the register and pre-orders from called parties show up here.</span></div>}
      <div className="kds" ref={boardRef}>
        {cooking.map((o) => {
          const age = minutesSince(o.sent_at || o.created_at);
          const tone = age >= late ? 'late' : age >= late * 0.66 ? 'warn' : '';
          return (
            <article key={o.id} data-id={o.id} className={`ticket-card ${tone}`}>
              <header>
                <b>#{o.number}</b>
                <span className="grow">{o.table_label ? `${settings.unit_label} ${o.table_label}` : o.customer_name || o.guest_name || 'To go'}</span>
                <span className="age num">{age >= 60 ? `${Math.floor(age / 60)}h ${age % 60}m` : `${age}m`}</span>
              </header>
              <div className="row wrap" style={{ gap: 6 }}>
                {o.source === 'guest' && <span className="chip blue">Ordered ahead</span>}
                {o.source === 'table' && <span className="chip blue">Ordered at table</span>}
                {o.fulfillment === 'delivery' && <span className="chip rose">Delivery</span>}
                {o.fulfillment === 'pickup' && o.source === 'online' && <span className="chip amber">Online pickup</span>}
                {o.prepaid ? <span className="chip teal">Paid</span> : null}
              </div>
              {o.delivery_address && <div className="muted" style={{ fontSize: 14 }}>{o.delivery_address}</div>}
              {(() => { let tags = []; try { tags = JSON.parse(o.customer_tags || '[]'); } catch { /* none */ } const al = [o.allergy_note, ...tags.filter((t) => /allerg|free|vegan|celiac|dairy|lactose/i.test(t))].filter(Boolean); return al.length ? <div className="ticket-allergy">ALLERGY: {al.join(', ')}</div> : null; })()}
              {o.order_notes && <div style={{ color: 'var(--accent)', fontSize: 14 }}>{o.order_notes}</div>}
              {(() => { const pl = cookPlan(o, cookTimes); return pl ? <div className="row" style={{ fontSize: 13 }}><span className="chip blue">Ready in about {pl.readyIn} min</span></div> : null; })()}
              <ul>{o.items.map((i, k) => <li key={k} className={i.course > 1 && !i.fired_at ? 'held' : ''}><b className="num">{i.qty}</b><span>{(() => { const pl = cookPlan(o, cookTimes); const s = pl?.startIn(i); if (s === null || s === undefined || (i.course > 1 && !i.fired_at)) return null; return <span className={`chip ${s <= 0 ? 'amber' : ''}`} style={{ marginRight: 6, fontSize: 11 }}>{s <= 0 ? 'Start now' : `Start in ${s}m`}</span>; })()}<button type="button" className="linkish" onClick={() => i.item_id && setCard(i.item_id)}>{i.name}</button>{i.course > 1 && !i.fired_at && <span className="chip amber" style={{ marginLeft: 6, fontSize: 11 }}>Held</span>}{i.mods?.length > 0 && <em>{i.mods.map((m) => m.name).join(', ')}</em>}{i.note && <em>{i.note}</em>}</span></li>)}</ul>
              <FireButton orderId={o.id} held={o.items.filter((i) => i.course > 1 && !i.fired_at).length} />
              {myStation ? <button className="btn primary lg block" onClick={() => stationDone(o)}><Icon name="check" size={18} />{myStation} done</button>
                : <button className="btn primary lg block" onClick={() => act(`/staff/orders/${o.id}/ready`, `#${o.number} ready`)}><Icon name="check" size={18} />Ready</button>}
            </article>
          );
        })}
      </div>
      {done.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h3 className="muted" style={{ fontFamily: 'var(--ui)', fontSize: 14, marginBottom: 10 }}>Just finished</h3>
          <div className="row wrap">{done.map((o) => (
            <span key={o.id} className="chip teal" style={{ padding: '6px 10px', fontSize: 14 }}>#{o.number} {o.table_label ? `${settings.unit_label} ${o.table_label}` : ''}
              <button className="btn ghost sm" style={{ height: 24, padding: '0 6px' }} onClick={() => act(`/staff/kitchen/${o.id}/recall`, `#${o.number} back on the board`)}>Recall</button>
            </span>
          ))}</div>
        </section>
      )}
      <TicketPrint orders={toPrint} unit={settings.unit_label} />
      {card && <RecipeCard itemId={card} onClose={() => setCard(null)} />}
    </>
  );
}
