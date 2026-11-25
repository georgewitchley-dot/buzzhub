"""serve.js vs serve.go: seat names, auto-join for a big party, VIP arrival alerts (timer), auto-VIP (seat.js timer)."""
import time, uuid
RUN = uuid.uuid4().hex[:10]
from contractlib import *
from tablekit import *

JN, JG = '/tmp/j10_n', '/tmp/j10_g'
login(N, '8642', JN); login(G, '8642', JG)
both("UPDATE tables SET status = 'open', guest_id = NULL, joined_to = NULL, seated_at = NULL WHERE id IN (7, 8, 9)")
both("DELETE FROM seat_allergies WHERE table_id = 7")

res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = []
    r.append(call(base, 'PUT', '/api/staff/tables/7/seat-name', {'seat': 1, 'name': ' Ann '}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/tables/7/seat-name', {'seat': 41, 'name': 'x' * 31}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/tables/9999/seat-name', {'seat': 1, 'name': 'Bo'}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/tables/7/seat-name', {'seat': 2, 'name': ''}, jar=jar))
    r.append(call(base, 'GET', '/api/staff/tables/7/seat-allergies', jar=jar)[1])
    r.append(call(base, 'PUT', '/api/staff/tables/7/seat-allergies', {'seat': 1, 'allergy': 'dairy'}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/tables/7/seat-name', {'seat': 1, 'name': ''}, jar=jar))
    r.append(call(base, 'GET', '/api/staff/tables/7/seat-allergies', jar=jar)[1])
    r.append(call(base, 'PUT', '/api/staff/tables/7/seat-allergies', {'seat': 1, 'allergy': ''}, jar=jar))
    r.append(call(base, 'GET', '/api/staff/tables/7/seat-allergies', jar=jar)[1])
    r.append(call(base, 'PUT', '/api/staff/tables/7/seat-name', {'seat': 3, 'name': 'Cy'}, jar=jar))
    r.append(call(base, 'GET', '/api/staff/tables/7/seat-allergies', jar=jar)[1])
    # auto-join: a party of 5 seated at B1 (2 seats) pulls in B2 and B3
    c, d = call(base, 'POST', '/api/staff/guests', {'name': 'Big Party', 'partySize': 5}, jar=jar)
    gid = d['guest']['id']
    r.append(call(base, 'POST', f'/api/staff/guests/{gid}/seat', {'tableId': 7}, jar=jar))
    t = [x for x in call(base, 'GET', '/api/staff/pad/tables', jar=jar)[1]['tables'] if x['id'] in (7, 8, 9)]
    for x in t: x.pop('seatedMinutes', None)
    r.append([(x['id'], x['status'], x['joinedTo'], x['joinedWith'], x['seatsAll']) for x in t])
    r.append(call(base, 'POST', '/api/staff/tables/7/unjoin', {}, jar=jar))
    # a party that fits does not join
    c, d = call(base, 'POST', '/api/staff/guests', {'name': 'Pair', 'partySize': 2}, jar=jar)
    r.append(call(base, 'POST', f"/api/staff/guests/{d['guest']['id']}/seat", {'tableId': 10}, jar=jar))
for i, (a, b) in enumerate(zip(res['node'], res['go'])):
    check(f'step {i}: same answer', a == b, (a, b))
an = sqlite("SELECT detail FROM audit WHERE action = 'table.auto_join' ORDER BY id DESC LIMIT 1")[0]['detail']
ag = pg("SELECT detail FROM audit WHERE action = 'table.auto_join' ORDER BY id DESC LIMIT 1")
check('auto-join audit', an == ag, (an, ag))
both("UPDATE tables SET status = 'open', guest_id = NULL, joined_to = NULL, seated_at = NULL WHERE id IN (7, 8, 9, 10)")
both("DELETE FROM seat_allergies WHERE table_id = 7")

# background sweeps: VIP arrival (serve.js, 20s) and auto-VIP orders (seat.js, 15s)
cust = int(pg("SELECT customer_id FROM orders WHERE customer_id IS NOT NULL AND paid_at IS NOT NULL AND status <> 'void' GROUP BY customer_id ORDER BY customer_id LIMIT 1") or 1)
setting('auto_vip_spend_cents', '1'); setting('auto_vip', '1'); setting('vip_arrival_alert', '1')
ins = f"INSERT INTO guests (name, party_size, kind, status, token, customer_id, created_at) VALUES ('Vee Ip', 3, 'table', 'waiting', '%s', {cust}, %s)"
sqlite(ins % (f'vipct{RUN}n', "datetime('now')")); pg(ins % (f'vipct{RUN}g', "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"))
on = sqlite("SELECT MAX(id) id FROM orders")[0]['id']; og = int(pg("SELECT MAX(id) FROM orders"))
sqlite(f"UPDATE orders SET customer_id = {cust}, vip_checked = 0, priority = 0, status = 'sent', created_at = datetime('now') WHERE id = {on}")
pg(f"UPDATE orders SET customer_id = {cust}, vip_checked = 0, priority = 0, status = 'sent', created_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = {og}")
time.sleep(26)
setting('auto_vip_spend_cents', None); setting('auto_vip', None); setting('vip_arrival_alert', None)
an = sqlite(f"SELECT vip_alerted FROM guests WHERE token = 'vipct{RUN}n'")[0]['vip_alerted']; ag = pg(f"SELECT vip_alerted FROM guests WHERE token = 'vipct{RUN}g'")
check('vip arrival sweep ran on both', str(an) == ag == '1', (an, ag))
an = sqlite("SELECT detail FROM audit WHERE action = 'guest.vip_arrived' ORDER BY id DESC LIMIT 1"); ag = pg("SELECT detail FROM audit WHERE action = 'guest.vip_arrived' ORDER BY id DESC LIMIT 1")
check('vip arrival audit', an and an[0]['detail'] == ag, (an, ag))
an = sqlite(f"SELECT priority FROM orders WHERE id = {on}")[0]['priority']; ag = pg(f"SELECT priority FROM orders WHERE id = {og}")
check('auto-VIP raised priority on both', str(an) == ag == '2', (an, ag))
an = sqlite("SELECT detail FROM audit WHERE action = 'order.auto_vip' ORDER BY id DESC LIMIT 1"); ag = pg("SELECT detail FROM audit WHERE action = 'order.auto_vip' ORDER BY id DESC LIMIT 1")
check('auto-VIP audit', an and an[0]['detail'] == ag, (an, ag))
both("UPDATE guests SET status = 'cancelled' WHERE token LIKE 'vipct%'")
done()
