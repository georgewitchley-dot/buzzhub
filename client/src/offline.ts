// Offline mode: sales rung up without a connection wait on this device and sync when it's back.
const KEY = 'bh_offline_queue';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const write = (q) => { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage full */ } window.dispatchEvent(new Event('bh:queue')); };

export const isNetworkError = (e) => e instanceof TypeError || /Failed to fetch|NetworkError|Load failed|network/i.test(e?.message || '');
export const pendingSales = () => read();

export function queueSale({ body, pay }) {
  const q = read();
  q.push({ key: body.clientKey, body, pay, at: Date.now() });
  write(q);
  return body.clientKey;
}
export function attachPayment(key, pay) { write(read().map((s) => (s.key === key ? { ...s, pay } : s))); }

let syncing = false;
/** Send waiting sales. Orders carry a client key, so a sale is never created twice. */
export async function syncQueue(api) {
  if (syncing) return { sent: 0 };
  syncing = true;
  let sent = 0;
  try {
    for (const sale of read()) {
      try {
        const r = await api('/staff/orders', { method: 'POST', body: sale.body });
        if (sale.pay) await api(`/staff/orders/${r.id}/pay`, { method: 'POST', body: sale.pay }).catch((e) => { if (e.status !== 409) throw e; });
        write(read().filter((s) => s.key !== sale.key));
        sent++;
      } catch (e) {
        if (isNetworkError(e) || e.status === 401) break; // still offline or locked: try again later
        write(read().map((s) => (s.key === sale.key ? { ...s, error: e.message } : s)));
      }
    }
  } finally { syncing = false; }
  return { sent };
}
export function dropSale(key) { write(read().filter((s) => s.key !== key)); }
