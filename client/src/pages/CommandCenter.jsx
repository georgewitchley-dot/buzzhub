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
import { Catering, Memberships } from './Club.jsx';
import { Chats, MyShifts, Performance, useUnreadChats } from './People.jsx';
import { Checklists, Deposits, Events, Prep } from './House.jsx';
import { Deals, Goals, Training } from './Plus.jsx';
import { Labels, Waste } from './More.jsx';
import { Equipment, LogBanner, LogBook, SupplierBills, TableCalls, TipOuts, WeeklyReport } from './Owner.jsx';
import { Safe, StockCount } from './Smart.jsx';
import { OnClockChip } from './Clock.jsx';
import { Rooms, TableTurns, UseFirst } from './Crew.jsx';
import { KitchenSpeed } from './Pace.jsx';
import { LaborByArea } from './Line.jsx';
import { OrderPad } from './Run.jsx';
import { Coaching } from './Table.jsx';
import { AllergenChart, CashFlow, Certificates, DeliveryZones, SalesTax } from './Desk.jsx';
import { DevicesPage } from './Devices.jsx';
import { VipCard } from './Station.jsx';

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
  { to: '/chats', icon: 'bell', label: 'Messages', chat: true, when: (s) => s?.chat_enabled === '1' },
  { to: '/bookings', icon: 'calendar', label: 'Bookings', when: (s) => s?.booking_enabled === '1' },
  { to: '/floor', icon: 'floor', label: 'Floor', when: (s) => s?.business_type !== 'service' },
  { to: '/register', icon: 'register', label: 'Register' },
  { to: '/orders', icon: 'ticket', label: 'Orders' },
  { to: '/kitchen', icon: 'flame', label: 'Kitchen', when: (s) => s?.business_type !== 'service' },
  { to: '/pad', icon: 'register', label: 'Server station', when: (s) => s?.business_type === 'restaurant' },
  { to: '/deliveries', icon: 'pin', label: 'Deliveries', when: (s) => s?.online_enabled === '1' && s?.online_delivery === '1' },
  { to: '/cash', icon: 'cash', label: 'Cash drawer' },
  { to: '/safe', icon: 'lock', label: 'Safe', min: 'manager', when: (s) => s?.safe_log_enabled === '1' },
  { to: '/checklists', icon: 'list', label: 'Checklists' },
  { to: '/training', icon: 'star', label: 'Training' },
  { to: '/certificates', icon: 'check', label: 'Certificates' },
  { to: '/allergens-chart', icon: 'list', label: 'Allergen chart' },
  { to: '/logbook', icon: 'list', label: 'Log book' },
  { to: '/equipment', icon: 'gear', label: 'Equipment' },
  { to: '/waste', icon: 'box', label: 'Waste' },
  { to: '/use-first', icon: 'box', label: 'Use first' },
  { to: '/labels', icon: 'print', label: 'Labels' },
  { to: '/prep', icon: 'flame', label: 'Prep list', when: (s) => s?.business_type !== 'service' },
  { to: '/shifts', icon: 'clock', label: 'Shifts' },
  { to: '/my-shifts', icon: 'calendar', label: 'My shifts' },
  { to: '/performance', icon: 'star', label: 'Team performance', min: 'manager' },
  { to: '/reports', icon: 'chart', label: 'Reports', min: 'manager' },
  { to: '/feedback', icon: 'star', label: 'Feedback', min: 'manager', when: (s) => s?.feedback_enabled === '1' },
  { to: '/menu', icon: 'menu', label: 'Menu', min: 'manager' },
  { to: '/deals', icon: 'gift', label: 'Deals', min: 'manager' },
  { to: '/goals', icon: 'chart', label: 'Goals and contests', min: 'manager' },
  { to: '/inventory', icon: 'box', label: 'Inventory', min: 'manager' },
  { to: '/count', icon: 'qr', label: 'Stock count', min: 'manager' },
  { to: '/purchasing', icon: 'bag', label: 'Purchasing', min: 'manager' },
  { to: '/giftcards', icon: 'gift', label: 'Gift cards', min: 'manager' },
  { to: '/marketing', icon: 'bell', label: 'Marketing', min: 'manager' },
  { to: '/memberships', icon: 'star', label: 'Memberships', min: 'manager' },
  { to: '/catering', icon: 'calendar', label: 'Catering', min: 'manager' },
  { to: '/ticketing', icon: 'ticket', label: 'Events', min: 'manager' },
  { to: '/deposits', icon: 'cash', label: 'Bank deposits', min: 'owner' },
  { to: '/tips', icon: 'cash', label: 'Tips', min: 'manager' },
  { to: '/tipouts', icon: 'cash', label: 'Tip-outs', min: 'manager' },
  { to: '/payroll', icon: 'clock', label: 'Payroll', min: 'owner' },
  { to: '/supplier-bills', icon: 'bag', label: 'Supplier bills', min: 'owner' },
  { to: '/report', icon: 'chart', label: 'Weekly report', min: 'owner' },
  { to: '/labor-areas', icon: 'chart', label: 'Labor by area', min: 'owner', when: (s) => s?.business_type !== 'service' },
  { to: '/coaching', icon: 'star', label: 'Server coaching', min: 'manager' },
  { to: '/kitchen-speed', icon: 'flame', label: 'Kitchen speed', min: 'manager', when: (s) => s?.business_type !== 'service' },
  { to: '/table-turns', icon: 'floor', label: 'Table turns', min: 'manager', when: (s) => s?.business_type !== 'service' },
  { to: '/rooms', icon: 'calendar', label: 'Private rooms', min: 'manager' },
  { to: '/cash-flow', icon: 'chart', label: 'Cash flow', min: 'owner' },
  { to: '/sales-tax', icon: 'cash', label: 'Sales tax', min: 'owner' },
  { to: '/delivery-zones', icon: 'pin', label: 'Delivery zones', min: 'manager', when: (s) => s?.online_delivery === '1' },
  { to: '/staff', icon: 'staff', label: 'Staff', min: 'manager' },
  { to: '/security', icon: 'shield', label: 'Security', min: 'manager' },
  { to: '/devices', icon: 'print', label: 'Devices', min: 'manager' },
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
  const [vip, setVip] = useState(null); const [vipOpen, setVipOpen] = useState(null);
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
    s.on('chat:new', ({ name, body }) => { playChime(); toast(`${name}: ${body}`, 'ok'); });
    s.on('booking:arrived', ({ name, time }) => { playChime(); toast(`${name} checked in for their ${time} booking`, 'ok'); });
    s.on('security', ({ type, ip, detail, customerId }) => { if (type === 'vip' && customerId) setVip({ detail, customerId }); if (type === 'curbside' || type === 'vip' || type === 'fire' || type === 'printer') { toast(detail, 'ok'); playChime?.(); } else if (type === 'bad_pin') toast(`Wrong PIN entered from ${ip}`, 'err'); else if (detail) toast(detail, 'err'); });
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

  const unread = useUnreadChats(socket);
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
              <NavLink key={n.to} to={n.to} end={n.end}><Icon name={n.icon} />{n.label}{n.count && waitCount > 0 && <span className="count">{waitCount}</span>}{n.chat && unread > 0 && <span className="count">{unread}</span>}</NavLink>
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
            {socket && <OnClockChip />}
            <span className={`live ${online ? '' : 'off'}`}><i />{online ? 'Live' : 'Reconnecting'}</span>
            <span className="clock">{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            <button className="btn sm tab-lock" onClick={onLock} aria-label="Lock terminal"><Icon name="lock" size={16} /></button>
          </header>
          <div className="scroller" ref={scrollRef}>
            <div className="content" ref={contentRef}>
              {settings && socket && <PaymentClaims />}
              {settings && socket && <TableCalls />}
              {settings && socket && <LogBanner />}
              {vip && <div className="vip-banner" role="status"><span className="chip violet">VIP</span><span className="grow">{vip.detail}</span><button className="btn sm primary" onClick={() => { setVipOpen(vip.customerId); setVip(null); }}>Open profile</button><button className="btn sm ghost" onClick={() => setVip(null)}>Dismiss</button></div>}
              {vipOpen && <VipCard id={vipOpen} onClose={() => setVipOpen(null)} />}
              {settings && socket && (
                <Routes>
                  <Route index element={<Dashboard />} />
                  <Route path="waitlist" element={<Waitlist />} />
                  <Route path="floor" element={<Floor />} />
                  <Route path="bookings" element={<Bookings />} />
                  <Route path="kitchen" element={<Kitchen />} />
                  <Route path="pad" element={<OrderPad />} />
                  {can('manager') && <Route path="coaching" element={<Coaching />} />}
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
                  <Route path="chats" element={<Chats />} />
                  <Route path="checklists" element={<Checklists />} />
                  <Route path="training" element={<Training />} />
                  <Route path="waste" element={<Waste />} />
                  <Route path="logbook" element={<LogBook />} />
                  <Route path="certificates" element={<Certificates />} />
                  <Route path="use-first" element={<UseFirst />} />
                  {can('manager') && <Route path="table-turns" element={<TableTurns />} />}
                  {can('manager') && <Route path="kitchen-speed" element={<KitchenSpeed />} />}
                  {can('owner') && <Route path="labor-areas" element={<LaborByArea />} />}
                  {can('manager') && <Route path="rooms" element={<Rooms />} />}
                  <Route path="allergens-chart" element={<AllergenChart />} />
                  <Route path="devices" element={<DevicesPage />} />
                  {can('owner') && <Route path="cash-flow" element={<CashFlow />} />}
                  {can('owner') && <Route path="sales-tax" element={<SalesTax />} />}
                  {can('manager') && <Route path="delivery-zones" element={<DeliveryZones />} />}
                  {can('manager') && <Route path="count" element={<StockCount />} />}
                  {can('manager') && settings?.safe_log_enabled === '1' && <Route path="safe" element={<Safe />} />}
                  <Route path="equipment" element={<Equipment />} />
                  {can('manager') && <Route path="tipouts" element={<TipOuts />} />}
                  {can('owner') && <Route path="supplier-bills" element={<SupplierBills />} />}
                  {can('owner') && <Route path="report" element={<WeeklyReport />} />}
                  <Route path="labels" element={<Labels />} />
                  {can('manager') && <Route path="deals" element={<Deals />} />}
                  {can('manager') && <Route path="goals" element={<Goals />} />}
                  <Route path="prep" element={<Prep />} />
                  {can('manager') && <Route path="ticketing" element={<Events />} />}
                  {can('owner') && <Route path="deposits" element={<Deposits />} />}
                  <Route path="my-shifts" element={<MyShifts />} />
                  {can('manager') && <Route path="performance" element={<Performance />} />}
                  {can('manager') && <Route path="memberships" element={<Memberships />} />}
                  {can('manager') && <Route path="catering" element={<Catering />} />}
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
