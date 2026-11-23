import { useState } from 'react';
import { ReceiptModal } from '../pro-ui';
import { api, minutesSince, money, timeOf, useTick } from '../lib';
import { Icon, Modal, Puck, useToast } from '../ui';
import { PageHead, useCC, useLive } from './CommandCenter';
import { ScheduledList } from './More';
import { PayModal } from './Register';
import { HereChip } from './Pace';
import { OrderMakeGood, TabsPanel } from './Run';

const LABEL = { held: 'Waiting',  open: 'Open', sent: 'In progress', ready: 'Ready', paid: 'Paid', void: 'Voided' };

function RefundModal({ order, currency, onClose }: { order?: any; currency?: any; onClose?: any; }) {
  const toast = useToast();
  const [amount, setAmount] = useState((order.total_cents / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const go = async () => {
    try { await api(`/staff/orders/${order.id}/refund`, { method: 'POST', body: { amountCents: Math.round(Number(amount) * 100), reason } }); toast(`Refunded ${money(Math.round(Number(amount) * 100), currency)}. Give it back by ${order.payment_method}.`, 'ok'); onClose(); }
    catch (e) { if (e.message !== 'Not approved') toast(e.message, 'err'); }
  };
  return (
    <Modal title={`Refund order #${order.number}`} onClose={onClose}>
      <label className="field"><span>Amount (paid {money(order.total_cents, currency)} by {order.payment_method})</span><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></label>
      <label className="field"><span>Reason</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} placeholder="Wrong order, cold food…" /></label>
      <button className="btn primary block" disabled={!reason || !Number(amount)} onClick={go}>Refund</button>
    </Modal>
  );
}

export default function Orders() {
  const { settings, can } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [scope, setScope] = useState('open');
  const [orders] = useLive(['orders'], () => api(`/staff/orders?scope=${scope}`), [scope]);
  const [paying, setPaying] = useState(null);
  const [refunding, setRefunding] = useState(null);
  const [receipt, setReceipt] = useState(null);
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
      <TabsPanel />
      {scope === 'open' && <ScheduledList />}
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
              {o.source === 'guest' && <span className="chip blue">Ordered ahead</span>}
              {o.source === 'online' && <span className="chip amber">Online {o.fulfillment}</span>}
              {o.source === 'table' && <span className="chip blue">Table QR</span>}
              <HereChip o={o} />
              <OrderMakeGood o={o} />
              {o.prepaid ? <span className="chip teal">Paid {o.payment_method}</span> : null}
              <span className="dim" style={{ fontSize: 13 }}>{scope === 'open' ? `${minutesSince(o.created_at)} min ago` : timeOf(o.paid_at || o.created_at)}{o.staff_name ? `, by ${o.staff_name}` : ''}</span>
            </div>
            {o.delivery_address && <div className="muted" style={{ fontSize: 13 }}>{o.delivery_address}{o.contact_phone ? `, ${o.contact_phone}` : ''}</div>}
            <ul>{o.items.map((i) => { const mods = JSON.parse(i.mods || '[]'); return <li key={i.id} className="row"><b className="num" style={{ width: 24 }}>{i.qty}</b><span className="grow">{i.name}{(mods.length > 0 || i.note) && <span className="dim"> ({[...mods.map((m) => m.name), i.note].filter(Boolean).join(', ')})</span>}</span></li>; })}</ul>
            <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <span className="grow muted">{o.payment_method ? `Paid by ${o.payment_method}` : 'Unpaid'}</span>
              <b className="num">{money(o.total_cents, cur)}</b>
            </div>
            {o.paid_at && <button className="btn sm ghost" onClick={() => setReceipt(o)}>Receipt</button>}
            {o.status !== 'void' && <button className="btn sm ghost" title="Print this order's kitchen tickets again" onClick={() => api(`/staff/orders/${o.id}/print-tickets`, { method: 'POST' }).then((r) => toast(r.queued ? `Ticket${r.queued === 1 ? '' : 's'} sent to the kitchen printer${r.queued === 1 ? '' : 's'}` : 'No kitchen printer is set up for these dishes (Devices)', r.queued ? 'ok' : 'err')).catch((e) => toast(e.message, 'err'))}>Reprint</button>}
            {o.fulfillment && o.fulfillment !== 'dine_in' && !o.table_id && <button className="btn sm ghost" onClick={() => api(`/staff/orders/${o.id}/print-sticker`, { method: 'POST' }).then((r) => toast(r.queued ? 'Bag sticker printing' : 'No printer takes bag stickers yet (Devices)', r.queued ? 'ok' : 'err')).catch((e) => toast(e.message, 'err'))}>Sticker</button>}
            {scope !== 'open' && o.status === 'paid' && <button className="btn sm ghost" onClick={() => setRefunding(o)}>Refund</button>}
            {scope === 'open' && (
              <div className="row wrap">
                {o.status === 'held' && <button className="btn sm primary grow" onClick={() => act(`/staff/orders/${o.id}/fire`, `Pre-order #${o.number} started`)}>Start now</button>}
                {o.status !== 'ready' && o.status !== 'held' && <button className="btn sm primary grow" onClick={() => act(`/staff/orders/${o.id}/ready`, `Order #${o.number} ready`)}><Icon name="bell" size={16} />Ready</button>}
                {!o.prepaid && <button className="btn sm grow" onClick={() => setPaying(o)}>Take payment</button>}
                <button className="btn sm ghost danger" onClick={() => confirm(`Void order #${o.number}?`) && act(`/staff/orders/${o.id}/void`, `Order #${o.number} voided`)}>Void</button>
              </div>
            )}
          </article>
        ))}
      </div>
      {receipt && <ReceiptModal order={receipt} onClose={() => setReceipt(null)} />}
      {refunding && <RefundModal order={refunding} currency={cur} onClose={() => setRefunding(null)} />}
      {paying && <PayModal order={paying} currency={cur} onClose={() => setPaying(null)} onPaid={() => setPaying(null)} />}
    </>
  );
}
