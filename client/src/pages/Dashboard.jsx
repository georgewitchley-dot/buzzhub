import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { gsap } from 'gsap';
import { api, money, timeOf } from '../lib.js';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';

const ACTION_LABEL = {
  'auth.login': 'unlocked the terminal', 'auth.lock': 'locked the terminal', 'auth.fail': 'Wrong PIN attempt',
  'guest.add': 'added to waitlist', 'guest.selfjoin': 'Self check-in', 'guest.buzz': 'buzzed', 'guest.ack': 'Guest on the way',
  'guest.seat': 'seated', 'guest.pickedup': 'picked up', 'guest.cancelled': 'removed', 'guest.noshow': 'marked no-show', 'guest.leave': 'Guest left the list',
  'order.create': 'rang up order', 'order.pay': 'took payment', 'order.ready': 'marked order ready', 'order.void': 'voided order',
  'table.status': 'updated table', 'setup.complete': 'set up the business', 'settings.update': 'changed settings',
  'user.add': 'added staff', 'user.update': 'updated staff', 'menu.add': 'added menu item', 'menu.update': 'edited menu item',
};

export default function Dashboard() {
  const { settings } = useCC();
  const [d] = useLive(['guests', 'orders', 'tables'], () => api('/staff/dashboard'));
  const kpiRef = useRef(null);
  const played = useRef(false);

  useEffect(() => {
    if (!d || played.current) return;
    played.current = true;
    gsap.from(kpiRef.current.children, { y: 14, opacity: 0, stagger: 0.05, duration: 0.5, ease: 'power3.out' });
  }, [d]);

  if (!d) return null;
  const cur = settings.currency;
  const tableMap = Object.fromEntries(d.tables.map((t) => [t.status, t.c]));
  const totalTables = d.tables.reduce((a, t) => a + t.c, 0);
  const hours = Array.from({ length: 15 }, (_, i) => i + 8);
  const maxH = Math.max(1, ...d.hourly.map((h) => h.t));
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHead title={greeting} sub={`Here's how ${settings.business_name} is running today.`}>
        <Link className="btn" to="/waitlist">Add to waitlist</Link>
        <Link className="btn primary" to="/register">New sale</Link>
      </PageHead>

      <div className="kpis" ref={kpiRef}>
        <div className="kpi"><div className="v">{d.waiting}</div><div className="l">Waiting now</div></div>
        <div className="kpi"><div className="v">{d.avgWait}<small style={{ fontSize: '1rem' }}> min</small></div><div className="l">Average wait today</div></div>
        <div className="kpi"><div className="v">{tableMap.seated || 0}/{totalTables}</div><div className="l">{settings.unit_label}s in use</div></div>
        <div className="kpi"><div className="v">{money(d.salesCents, cur)}</div><div className="l">Sales from {d.ordersPaid} orders</div></div>
        <div className="kpi"><div className="v">{d.coversToday}</div><div className="l">Guests served</div></div>
        <div className="kpi"><div className="v">{d.rating7 ?? '–'}{d.rating7 ? <small style={{ fontSize: '1rem' }}> / 5</small> : null}</div><div className="l">{d.ratings7 ? `Guest rating, ${d.ratings7} this week` : 'Guest rating this week'}</div></div>
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <section className="panel">
          <div className="panel-h"><h3 className="grow">Sales by hour</h3><span className="muted num">Tips {money(d.tipsCents, cur)}</span></div>
          <div className="panel-b">
            <div className="bars" role="img" aria-label="Sales by hour today">
              {hours.map((h) => {
                const v = d.hourly.find((x) => x.h === h)?.t || 0;
                return <div key={h} title={`${h}:00 — ${money(v, cur)}`}><span style={{ height: `${(v / maxH) * 100}%` }} /><small>{h % 12 || 12}</small></div>;
              })}
            </div>
            <h3 style={{ margin: '22px 0 8px' }}>Best sellers</h3>
            {d.top.length ? d.top.map((t) => (
              <div key={t.name} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}><span className="grow">{t.name}</span><b className="num">{t.q}</b></div>
            )) : <p className="muted" style={{ margin: 0 }}>Ring up a sale and your best sellers show here.</p>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-h"><h3 className="grow">Activity</h3><span className="muted">{d.openOrders} open orders</span></div>
          <div className="panel-b feed">
            {d.activity.map((a, i) => (
              <div key={i}><span className="dim num">{timeOf(a.ts)}</span><span>{a.user_name ? <b>{a.user_name} </b> : null}{ACTION_LABEL[a.action] || a.action}{a.detail ? <span className="muted"> — {a.detail}</span> : null}</span></div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
