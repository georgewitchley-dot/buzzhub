import { useState } from 'react';
import { api, money, setLoc } from '../lib';
import { Icon, Modal, useToast } from '../ui';
import { PageHead, useLive } from './CommandCenter';

export async function switchLocation(slug) {
  await api('/staff/locations/switch', { method: 'POST', body: { slug } });
  setLoc(slug);
  window.location.href = '/';
}

function AddLocation({ onClose }: { onClose?: any; }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ name: '', type: 'restaurant', copyMenu: true, copyTeam: false, copyBrand: true });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try { const r = await api('/staff/locations', { method: 'POST', body: f }); toast(`${f.name} is ready`, 'ok'); onClose(r.slug); } catch (e2) { toast(e2.message, 'err'); setBusy(false); }
  };
  const box = (k, label) => <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {label}</label>;
  return (
    <Modal title="Add a location" onClose={() => onClose(null)}>
      <form className="stack" onSubmit={save}>
        <label className="field"><span>Name guests see</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} placeholder="Ember & Oak Downtown" required /></label>
        <label className="field"><span>Kind of business</span><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="restaurant">Restaurant or bar</option><option value="cafe">Café or counter</option><option value="service">Salon, clinic, shop</option></select></label>
        {box('copyMenu', 'Copy this menu')}
        {box('copyBrand', 'Copy the logo, color and review link')}
        {box('copyTeam', 'Copy the whole team with their PINs (otherwise only you)')}
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>Each location has its own waitlist, floor, orders, bookings, customers, reports and door sign. You can switch between them any time.</p>
        <button className="btn primary lg block" disabled={busy}>{busy ? 'Setting up…' : 'Create location'}</button>
      </form>
    </Modal>
  );
}

export default function Locations() {
  const toast = useToast();
  const [d, reload] = useLive(['guests', 'orders'], () => api('/staff/locations'));
  const [adding, setAdding] = useState(false);
  if (!d) return null;
  const totals = d.locations.reduce((a, l) => ({ sales: a.sales + l.salesCents, waiting: a.waiting + l.waiting, orders: a.orders + l.orders, clock: a.clock + l.onClock }), { sales: 0, waiting: 0, orders: 0, clock: 0 });
  const cur = d.locations[0]?.currency || 'USD';
  const go = (slug) => switchLocation(slug).catch((e) => toast(e.message, 'err'));

  return (
    <>
      <PageHead title="All locations" sub={`${d.locations.length} location${d.locations.length === 1 ? '' : 's'}, live.`}>
        {d.canAdd && <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={17} />Add a location</button>}
      </PageHead>
      <div className="kpis">
        <div className="kpi"><div className="v">{money(totals.sales, cur)}</div><div className="l">Sales today, all locations</div></div>
        <div className="kpi"><div className="v">{totals.orders}</div><div className="l">Orders paid today</div></div>
        <div className="kpi"><div className="v">{totals.waiting}</div><div className="l">Parties waiting now</div></div>
        <div className="kpi"><div className="v">{totals.clock}</div><div className="l">Team on the clock</div></div>
      </div>
      <div className="loc-grid" style={{ marginTop: 18 }}>
        {d.locations.map((l) => (
          <article key={l.slug} className={`panel loc-card ${l.slug === d.current ? 'here' : ''}`} style={{ '--c': l.accent }}>
            <header className="row"><h3 className="grow">{l.name}</h3>{l.slug === d.current ? <span className="chip amber">You're here</span> : <button className="btn sm" onClick={() => go(l.slug)}>Open</button>}</header>
            <div className="loc-stats">
              <div><b className="num">{money(l.salesCents, l.currency)}</b><span>sales today</span></div>
              <div><b className="num">{l.waiting}</b><span>waiting</span></div>
              {l.type !== 'service' ? <div><b className="num">{l.seated}/{l.tables}</b><span>tables in use</span></div> : <div><b className="num">{l.bookingsToday}</b><span>bookings today</span></div>}
              <div><b className="num">{l.openOrders}</b><span>open orders</span></div>
              <div><b className="num">{l.onClock}</b><span>on the clock</span></div>
              <div><b className="num">{l.rating7 ?? '–'}</b><span>rating this week</span></div>
            </div>
          </article>
        ))}
      </div>
      {adding && <AddLocation onClose={(slug) => { setAdding(false); reload(); if (slug && confirm('Open the new location now?')) go(slug); }} />}
    </>
  );
}
