import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, applyAccent, connectStaff, playChime, useLenis } from '../lib.js';
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
  { to: '/waitlist', icon: 'list', label: 'Waitlist', count: true },
  { to: '/bookings', icon: 'calendar', label: 'Bookings', when: (s) => s?.booking_enabled === '1' },
  { to: '/floor', icon: 'floor', label: 'Floor', when: (s) => s?.business_type !== 'service' },
  { to: '/register', icon: 'register', label: 'Register' },
  { to: '/orders', icon: 'ticket', label: 'Orders' },
  { to: '/kitchen', icon: 'flame', label: 'Kitchen', when: (s) => s?.business_type !== 'service' },
  { to: '/cash', icon: 'cash', label: 'Cash drawer' },
  { to: '/shifts', icon: 'clock', label: 'Shifts' },
  { to: '/reports', icon: 'chart', label: 'Reports', min: 'manager' },
  { to: '/menu', icon: 'menu', label: 'Menu', min: 'manager' },
  { to: '/staff', icon: 'staff', label: 'Staff', min: 'manager' },
  { to: '/security', icon: 'shield', label: 'Security log', min: 'manager' },
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
    s.on('booking:arrived', ({ name, time }) => { playChime(); toast(`${name} checked in for their ${time} booking`, 'ok'); });
    s.on('security', ({ type, ip }) => { if (type === 'bad_pin') toast(`Wrong PIN entered from ${ip}`, 'err'); });
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
            <span className={`live ${online ? '' : 'off'}`}><i />{online ? 'Live' : 'Reconnecting'}</span>
            <span className="clock">{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            <button className="btn sm tab-lock" onClick={onLock} aria-label="Lock terminal"><Icon name="lock" size={16} /></button>
          </header>
          <div className="scroller" ref={scrollRef}>
            <div className="content" ref={contentRef}>
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
                  <Route path="register" element={<Register />} />
                  <Route path="orders" element={<Orders />} />
                  {can('manager') && <Route path="menu" element={<MenuAdmin />} />}
                  {can('manager') && <Route path="staff" element={<StaffAdmin />} />}
                  {can('manager') && <Route path="security" element={<AuditLog />} />}
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
