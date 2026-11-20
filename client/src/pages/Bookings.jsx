import { useState } from 'react';
import { api, fmtSlot } from '../lib.js';
import { useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';

const STATUS = { booked: ['Booked', 'blue'], checked_in: ['Here now', 'teal'], done: ['Done', ''], cancelled: ['Cancelled', 'rose'], noshow: ['No-show', 'rose'] };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export default function Bookings() {
  const { can } = useCC();
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [tab, setTab] = useState('bookings');
  const [data] = useLive(['bookings', 'guests'], () => api(`/staff/bookings${from ? `?from=${from}` : ''}`), [from]);
  const [customers] = useLive([], () => (tab === 'customers' && can('manager') ? api('/staff/customers') : Promise.resolve(null)), [tab]);
  const act = async (path, body, msg) => { try { await api(path, { method: 'POST', body }); toast(msg, 'ok'); } catch (e) { toast(e.message, 'err'); } };

  const start = from || data?.today;
  const days = start ? Array.from({ length: 7 }, (_, i) => addDays(start, i)) : [];
  const todayCount = (data?.bookings || []).filter((b) => b.start_local.startsWith(data.today) && b.status !== 'cancelled').length;

  return (
    <>
      <PageHead title="Bookings" sub={data ? `${todayCount} booked today. Customers book from the door sign or ${location.host}/account.` : ''}>
        {can('manager') && <div className="seg"><button aria-pressed={tab === 'bookings'} onClick={() => setTab('bookings')}>Bookings</button><button aria-pressed={tab === 'customers'} onClick={() => setTab('customers')}>Customers</button></div>}
        {tab === 'bookings' && start && (
          <div className="row">
            <button className="btn sm" onClick={() => setFrom(addDays(start, -7))} disabled={start <= data?.today}>Earlier</button>
            <button className="btn sm" onClick={() => setFrom('')}>This week</button>
            <button className="btn sm" onClick={() => setFrom(addDays(start, 7))}>Later</button>
          </div>
        )}
      </PageHead>

      {tab === 'customers' ? (
        <section className="panel"><table className="list">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Bookings</th><th>Visits</th><th>Joined</th></tr></thead>
          <tbody>{(customers || []).map((c) => (
            <tr key={c.id}><td>{c.name}</td><td className="muted">{c.email}</td><td className="muted">{c.phone || ''}</td><td className="num">{c.bookings}</td><td className="num">{c.visits}</td><td className="muted">{new Date(c.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()}</td></tr>
          ))}</tbody>
        </table></section>
      ) : (
        <div className="stack">
          {days.map((d) => {
            const list = (data?.bookings || []).filter((b) => b.start_local.startsWith(d));
            const f = fmtSlot(`${d} 12:00`);
            return (
              <section className="panel" key={d}>
                <div className="panel-h"><h3 className="grow">{d === data.today ? 'Today' : f.day}</h3><span className="muted">{list.filter((b) => b.status !== 'cancelled').length} booked</span></div>
                {list.length === 0 ? <div className="panel-b muted">Nothing booked.</div> : (
                  <table className="list"><tbody>{list.map((b) => {
                    const [label, tone] = STATUS[b.status];
                    return (
                      <tr key={b.id} style={{ opacity: ['cancelled', 'noshow'].includes(b.status) ? 0.55 : 1 }}>
                        <td className="num" style={{ width: 90 }}><b>{fmtSlot(b.start_local).time}</b></td>
                        <td><b>{b.name}</b><div className="muted" style={{ fontSize: 13 }}>{b.service_name || `Party of ${b.party_size}`}{b.notes ? `. ${b.notes}` : ''}</div></td>
                        <td className="muted" style={{ fontSize: 13 }}>{b.phone || b.email}</td>
                        <td><span className={`chip ${tone}`}>{label}</span></td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {b.status === 'booked' && <>
                            <button className="btn sm primary" onClick={() => act(`/staff/bookings/${b.id}/checkin`, undefined, `${b.name} checked in`)}>Check in</button>
                            <button className="btn sm ghost" onClick={() => act(`/staff/bookings/${b.id}/status`, { status: 'noshow' }, 'Marked no-show')}>No-show</button>
                            <button className="btn sm ghost danger" onClick={() => confirm(`Cancel ${b.name}'s booking?`) && act(`/staff/bookings/${b.id}/status`, { status: 'cancelled' }, 'Booking cancelled')}>Cancel</button>
                          </>}
                        </td>
                      </tr>
                    );
                  })}</tbody></table>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
