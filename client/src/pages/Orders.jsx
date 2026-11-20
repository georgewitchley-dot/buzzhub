import { useState } from 'react';
import { api, minutesSince, money, timeOf, useTick } from '../lib.js';
import { Icon, Puck, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { PayModal } from './Register.jsx';

const LABEL = { held: 'Ordered ahead, waiting for table', open: 'Open', sent: 'In progress', ready: 'Ready', paid: 'Paid', void: 'Voided' };

export default function Orders() {
  const { settings, can } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [scope, setScope] = useState('open');
  const [orders] = useLive(['orders'], () => api(`/staff/orders?scope=${scope}`), [scope]);
  const [paying, setPaying] = useState(null);
  useTick(30000);

  const act = async (path, msg) => { try { const r = await api(path, { method: 'POST' }); toast(r.buzz ? `${msg}. Customer buzzed.` : msg, 'ok'); } catch (e) { toast(e.message, 'err'); } };

  return (
    <>
      <PageHead title="Orders" sub={scope === 'open' ? 'Mark an order ready and the customer\'s phone buzzes.' : 'Closed today'}>
        <div className="seg" role="group" aria-label="Which orders">
          <button aria-pressed={scope === 'open'} onClick={() => setScope('open')}>Open</button>
          <button aria-pressed={scope === 'paid'} onClick={() => setScope('paid')}>Closed today</button>
        </div>
      </PageHead>
      {orders && orders.length === 0 && <div className="panel empty"><b>No {scope === 'open' ? 'open' : 'closed'} orders</b><span>New sales from the register land here.</span></div>}
      <div className="board">
        {(orders || []).map((o) => (
          <article key={o.id} className="panel order" data-status={o.status}>
            <header>
              <b>#{o.number}</b>
              <span className="grow muted">{o.customer_name || (o.table_label ? `${settings.unit_label} ${o.table_label}` : 'Walk-in')}</span>
              {o.guest_id && <Puck state={o.status === 'ready' ? 'buzzed' : 'waiting'} size={26} />}
            </header>
            <div className="row wrap" style={{ gap: 6 }}>
              <span className={`chip ${o.status === 'ready' ? 'teal' : o.status === 'void' ? 'rose' : o.status === 'paid' ? '' : o.status === 'held' ? 'blue' : 'amber'}`}>{LABEL[o.status]}</span>
              {o.source === 'guest' && o.status !== 'held' && <span className="chip blue">Ordered ahead</span>}
              <span className="dim" style={{ fontSize: 13 }}>{scope === 'open' ? `${minutesSince(o.created_at)} min ago` : timeOf(o.paid_at || o.created_at)}{o.staff_name ? `, by ${o.staff_name}` : ''}</span>
            </div>
            <ul>{o.items.map((i) => <li key={i.id} className="row"><b className="num" style={{ width: 24 }}>{i.qty}</b><span className="grow">{i.name}{i.note && <span className="dim"> ({i.note})</span>}</span></li>)}</ul>
            <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <span className="grow muted">{o.payment_method ? `Paid by ${o.payment_method}` : 'Unpaid'}</span>
              <b className="num">{money(o.total_cents, cur)}</b>
            </div>
            {scope === 'open' && (
              <div className="row wrap">
                {o.status === 'held' && <button className="btn sm primary grow" onClick={() => act(`/staff/orders/${o.id}/fire`, `Pre-order #${o.number} started`)}>Start now</button>}
                {o.status !== 'ready' && o.status !== 'held' && <button className="btn sm primary grow" onClick={() => act(`/staff/orders/${o.id}/ready`, `Order #${o.number} ready`)}><Icon name="bell" size={16} />Ready</button>}
                <button className="btn sm grow" onClick={() => setPaying(o)}>Take payment</button>
                {can('manager') && <button className="btn sm ghost danger" onClick={() => confirm(`Void order #${o.number}?`) && act(`/staff/orders/${o.id}/void`, `Order #${o.number} voided`)}>Void</button>}
              </div>
            )}
          </article>
        ))}
      </div>
      {paying && <PayModal order={paying} currency={cur} onClose={() => setPaying(null)} onPaid={() => setPaying(null)} />}
    </>
  );
}
