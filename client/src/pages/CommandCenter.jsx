import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, applyAccent, connectStaff, money, playChime, registerSW, useLenis } from '../lib.js';
import { pendingSales, syncQueue } from '../offline.js';
import { Icon, Puck, useToast } from '../ui.jsx';
import Lock from './Lock.jsx';
import Setup from './Setup.jsx';
import Dashboard from './Dashboard.jsx';
import Waitlist from './Waitlist.jsx';
import Floor from './Floor.jsx';
import Register from './Register.jsx';
import Orders from './Orders.jsx';
import { MenuAdmin, StaffAdmin, SettingsAdmin, AuditLog } from './Admin.jsx';
import Bookings from './Bookings.jsx';
import Kitchen from './Kitchen.jsx';
import Reports from './Reports.jsx';
import Cash from './Cash.jsx';
import Shifts from './Shifts.jsx';
import Security from './Security.jsx';
import { FeedbackAdmin } from './Feedback.jsx';
import Locations, { switchLocation } from './Locations.jsx';
import { GiftCards, Inventory } from './Commerce.jsx';
import { Marketing, Tips } from './Team.jsx';
import { Insights, Payroll, Purchasing } from './Back.jsx';
import { Deliveries, PaymentClaims } from './Field.jsx';

const Ctx = createContext(null);
export const useCC = () => useContext(Ctx);

/** Fetch data and refetch whenever the server says a scope changed. */
export function useLive(scopes, fetcher, deps = []) {
  const { socket } = useCC();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const fRef = useRef(fetcher); fRef.current = fetcher;
  const load = useCallback(() => fRef.current().then((d) => { setData(d); setError(null); }).catch(setError), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, deps);
  useEffect(() => {
    if (!socket) return;
    const on = ({ scope }) => { if (scopes.includes(scope)) load(); };
    socket.on('sync', on); socket.on('connect', load);
    return () => { socket.off('sync', on); socket.off('connect', load); };
  }, [socket, load, scopes.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  return [data, load, error];
}

const NAV = [
  { to: '/', icon: 'home', label: 'Overview', end: true },
  { to: '/insights', icon: 'chart', label: 'Insights', min: 'manager' },
  { to: '/locations', icon: 'pin', label: 'All locations', min: 'manager' },
  { to: '/waitlist', icon: 'list', label: 'Waitlist', count: true },
  { to: '/bookings', icon: 'calendar', label: 'Bookings', when: (s) => s?.booking_enabled === '1' },
  { to: '/floor', icon: 'floor', label: 'Floor', when: (s) => s?.business_type !== 'service' },
  { to: '/register', icon: 'register', label: 'Register' },
  { to: '/orders', icon: 'ticket', label: 'Orders' },
  { to: '/kitchen', icon: 'flame', label: 'Kitchen', when: (s) => s?.business_type !== 'service' },
  { to: '/deliveries', icon: 'pin', label: 'Deliveries', when: (s) => s?.online_enabled === '1' && s?.online_delivery === '1' },
  { to: '/cash', icon: 'cash', label: 'Cash drawer' },
  { to: '/shifts', icon: 'clock', label: 'Shifts' },
  { to: '/reports', icon: 'chart', label: 'Reports', min: 'manager' },
  { to: '/feedback', icon: 'star', label: 'Feedback', min: 'manager', when: (s) => s?.feedback_enabled === '1' },
  { to: '/menu', icon: 'menu', label: 'Menu', min: 'manager' },
  { to: '/inventory', icon: 'box', label: 'Inventory', min: 'manager' },
  { to: '/purchasing', icon: 'bag', label: 'Purchasing', min: 'manager' },
  { to: '/giftcards', icon: 'gift', label: 'Gift cards', min: 'manager' },
  { to: '/marketing', icon: 'bell', label: 'Marketing', min: 'manager' },
  { to: '/tips', icon: 'cash', label: 'Tips', min: 'manager' },
  { to: '/payroll', icon: 'clock', label: 'Payroll', min: 'owner' },
  { to: '/staff', icon: 'staff', label: 'Staff', min: 'manager' },
  { to: '/security', icon: 'shield', label: 'Security', min: 'manager' },
  { to: '/settings', icon: 'gear', label: 'Settings', min: 'manager' },
];
const RANK = { staff: 1, manager: 2, owner: 3 };

export default function CommandCenter() {
  const [phase, setPhase] = useState('loading'); // loading | setup | locked | open
  const [user, setUser] = useState(null);
  const [business, setBusiness] = useState(null);

  const loadBusiness = useCallback(() => api('/public/business').then((b) => { setBusiness(b); applyAccent(b.accent); }).catch(() => {}), []);

  const boot = useCallback(async () => {
    loadBusiness();
    const { needsSetup } = await api('/setup/status');
    if (needsSetup) return setPhase('setup');
    try { const { user: u } = await api('/auth/me'); setUser(u); setPhase('open'); } catch { setPhase('locked'); }
  }, [loadBusiness]);

  useEffect(() => { boot(); }, [boot]);
  useEffect(() => {
    const onLocked = () => { setUser(null); setPhase((p) => (p === 'open' ? 'locked' : p)); };
    window.addEventListener('bh:locked', onLocked);
    return () => window.removeEventListener('bh:locked', onLocked);
  }, []);

  const lock = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null); setPhase('locked'); loadBusiness();
  }, [loadBusiness]);

  if (phase === 'loading') return <div className="lock"><Puck state="waiting" size={46} /></div>;
  if (phase === 'setup') return <Setup onDone={boot} />;
  if (phase === 'locked') return <Lock business={business} onUnlocked={(u) => { setUser(u); setPhase('open'); }} />;
  return <Shell user={user} business={business} onLock={lock} reloadBusiness={loadBusiness} />;
}

function Shell({ user, business, onLock, reloadBusiness }) {
  const toast = useToast();
  const [socket, setSocket] = useState(null);
  const [online, setOnline] = useState(true);
  const [settings, setSettings] = useState(null);
  const [waitCount, setWaitCount] = useState(0);
  const [clock, setClock] = useState(() => new Date());
  const [locs, setLocs] = useState(null);
  const [queued, setQueued] = useState(() => pendingSales().length);
  const [netOk, setNetOk] = useState(() => navigator.onLine);
  useEffect(() => {
    registerSW();
    const upd = () => setQueued(pendingSales().length);
    const sync = async () => { const r = await syncQueue(api); upd(); if (r.sent) toast(`Sent ${r.sent} sale${r.sent === 1 ? '' : 's'} made while offline`, 'ok'); };
    const on = () => { setNetOk(true); sync(); }; const off = () => setNetOk(false);
    window.addEventListener('bh:queue', upd); window.addEventListener('online', on); window.addEventListener('offline', off);
    sync(); const t = setInterval(sync, 30000);
    return () => { window.removeEventListener('bh:queue', upd); window.removeEventListener('online', on); window.removeEventListener('offline', off); clearInterval(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (RANK[user.role] >= RANK.manager) api('/staff/locations').then(setLocs).catch(() => {}); }, [user.role]);
  const scrollRef = useRef(null); const contentRef = useRef(null);
  useLenis(scrollRef, contentRef);

  const loadSettings = useCallback(() => api('/staff/settings').then((s) => { setSettings(s); applyAccent(s.accent); }).catch(() => {}), []);
  const loadCount = useCallback(() => api('/staff/guests').then((d) => setWaitCount(d.active.filter((g) => g.kind === 'table').length)).catch(() => {}), []);
  useEffect(() => { loadSettings(); loadCount(); }, [loadSettings, loadCount]);

  // realtime connection
  useEffect(() => {
    const s = connectStaff();
    s.on('connect', () => setOnline(true));
    s.on('disconnect', () => setOnline(false));
    s.on('connect_error', () => setOnline(false));
    s.on('force-lock', () => { toast('Your access changed. Enter your PIN again.', 'err'); onLock(); });
    s.on('guest:ack', ({ name }) => { playChime(); toast(`${name} is on the way`, 'ok'); });
    s.on('preorder:new', ({ name, count, updated }) => { playChime(); toast(`${name} ${updated ? 'changed their order' : `ordered ${count} item${count === 1 ? '' : 's'} ahead`}`, 'ok'); });
    s.on('preorder:fired', ({ number, table }) => toast(`Pre-order #${number} sent to make${table ? ` for ${table}` : ''}`, 'ok'));
    s.on('paid:phone', ({ number, totalCents }) => { playChime(); toast(`Order #${number} paid by phone, ${money(totalCents, settings?.currency || 'USD')}`, 'ok'); });
    s.on('online:new', ({ number, name, fulfillment, kind }) => { playChime(); toast(kind === 'kiosk' ? `New kiosk order #${number}` : fulfillment === 'paid' ? 'An online order was paid' : `New ${fulfillment === 'table' ? 'table' : fulfillment} order${number ? ` #${number}` : ''} from ${name}`, 'ok'); });
    s.on('pay:claim', ({ text }) => { playChime(); toast(text, 'ok'); });
    s.on('booking:arrived', ({ name, time }) => { playChime(); toast(`${name} checked in for their ${time} booking`, 'ok'); });
    s.on('security', ({ type, ip, detail }) => { if (type === 'bad_pin') toast(`Wrong PIN entered from ${ip}`, 'err'); else if (detail) toast(detail, 'err'); });
    s.on('settings', (st) => { setSettings((p) => ({ ...p, ...st })); applyAccent(st.accent); reloadBusiness(); });
    s.on('sync', ({ scope }) => { if (scope === 'guests') loadCount(); });
    setSocket(s);
    return () => s.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // auto-lock after inactivity
  const idleMin = Number(settings?.idle_lock_minutes || 5);
  useEffect(() => {
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const evts = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    evts.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => { if (Date.now() - last > idleMin * 60_000) onLock(); setClock(new Date()); }, 5000);
    return () => { evts.forEach((e) => window.removeEventListener(e, bump)); clearInterval(t); };
  }, [idleMin, onLock]);

  const nav = NAV.filter((n) => (!n.min || RANK[user.role] >= RANK[n.min]) && (!n.when || n.when(settings)));
  const can = (min) => RANK[user.role] >= RANK[min];

  return (
    <Ctx.Provider value={{ user, socket, settings, can, reloadSettings: loadSettings }}>
      <div className="shell">
        <aside className="rail">
          <div className="brand"><Puck state={waitCount ? 'buzzed' : 'waiting'} size={34} /><div><b>{settings?.business_name || business?.name}</b><small>Command center</small></div></div>
          {locs?.locations.length > 1 && (
            <select className="input loc-switch" value={locs.current} onChange={(e) => switchLocation(e.target.value).catch((x) => toast(x.message, 'err'))} aria-label="Switch location">
              {locs.locations.map((l) => <option key={l.slug} value={l.slug}>{l.name}</option>)}
            </select>
          )}
          <nav className="nav">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}><Icon name={n.icon} />{n.label}{n.count && waitCount > 0 && <span className="count">{waitCount}</span>}</NavLink>
            ))}
          </nav>
          <div className="rail-foot">
            <div className="me"><div className="avatar">{user.name[0]}</div><div className="grow"><b style={{ fontSize: 14 }}>{user.name}</b><div className="dim" style={{ fontSize: 12, textTransform: 'capitalize' }}>{user.role}</div></div></div>
            <button className="btn block" onClick={onLock}><Icon name="lock" size={17} />Lock terminal</button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="grow" />
            {(!netOk || queued > 0) && <span className="chip amber" role="status">{!netOk ? 'Offline. Sales are saved on this device' : `${queued} offline sale${queued === 1 ? '' : 's'} waiting to send`}</span>}
            <span className={`live ${online ? '' : 'off'}`}><i />{online ? 'Live' : 'Reconnecting'}</span>
            <span className="clock">{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            <button className="btn sm tab-lock" onClick={onLock} aria-label="Lock terminal"><Icon name="lock" size={16} /></button>
          </header>
          <div className="scroller" ref={scrollRef}>
            <div className="content" ref={contentRef}>
              {settings && socket && <PaymentClaims />}
              {settings && socket && (
                <Routes>
                  <Route index element={<Dashboard />} />
                  <Route path="waitlist" element={<Waitlist />} />
                  <Route path="floor" element={<Floor />} />
                  <Route path="bookings" element={<Bookings />} />
                  <Route path="kitchen" element={<Kitchen />} />
                  <Route path="cash" element={<Cash />} />
                  <Route path="shifts" element={<Shifts />} />
                  {can('manager') && <Route path="reports" element={<Reports />} />}
                  {can('manager') && <Route path="feedback" element={<FeedbackAdmin />} />}
                  {can('manager') && <Route path="locations" element={<Locations />} />}
                  {can('manager') && <Route path="inventory" element={<Inventory />} />}
                  {can('manager') && <Route path="giftcards" element={<GiftCards />} />}
                  {can('manager') && <Route path="marketing" element={<Marketing />} />}
                  {can('manager') && <Route path="tips" element={<Tips />} />}
                  {can('manager') && <Route path="insights" element={<Insights />} />}
                  {can('manager') && <Route path="purchasing" element={<Purchasing />} />}
                  {can('owner') && <Route path="payroll" element={<Payroll />} />}
                  <Route path="deliveries" element={<Deliveries />} />
                  <Route path="register" element={<Register />} />
                  <Route path="orders" element={<Orders />} />
                  {can('manager') && <Route path="menu" element={<MenuAdmin />} />}
                  {can('manager') && <Route path="staff" element={<StaffAdmin />} />}
                  {can('manager') && <Route path="security" element={<Security />} />}
                  {can('manager') && <Route path="settings" element={<SettingsAdmin />} />}
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              )}
            </div>
          </div>
        </div>
        <nav className="tabbar">
          {nav.slice(0, 5).concat(nav.slice(5)).map((n) => <NavLink key={n.to} to={n.to} end={n.end}><Icon name={n.icon} />{n.label.split(' ')[0]}</NavLink>)}
        </nav>
      </div>
    </Ctx.Provider>
  );
}

export function PageHead({ title, sub, children }) {
  return (
    <div className="row wrap" style={{ marginBottom: 20, alignItems: 'flex-end' }}>
      <div className="grow"><h1>{title}</h1>{sub && <div className="muted" style={{ marginTop: 4 }}>{sub}</div>}</div>
      {children}
    </div>
  );
}
