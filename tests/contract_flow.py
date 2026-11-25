"""flow.js vs flow.go: transfer a table, servers on, prep pars, delivery signatures, pre-order reminders."""
import datetime, uuid, zoneinfo
from contractlib import *
from tablekit import *

JN, JG, SN, SG = '/tmp/j10_n', '/tmp/j10_g', '/tmp/j10_sn', '/tmp/j10_sg'
login(N, '8642', JN); login(G, '8642', JG); login(N, '5791', SN); login(G, '5791', SG)
RUN = uuid.uuid4().hex[:8]

for p in ['/api/staff/servers-on', '/api/staff/prep-pars']:
    same_get(p, JN, JG)
    a, b = call(N, 'GET', p, jar=JN), call(G, 'GET', p, jar=JG)
    check(f'{p}: same values', a == b, (a, b))

both("UPDATE tables SET status = 'open', guest_id = NULL, joined_to = NULL, seated_at = NULL, server_id = NULL WHERE id IN (1, 2)")
sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
delivery = int(pg("SELECT MIN(id) FROM orders WHERE fulfillment = 'delivery'"))
plain = int(pg("SELECT MIN(id) FROM orders WHERE fulfillment IS DISTINCT FROM 'delivery'"))
res = {}
for base, jar, sjar, lab in [(N, JN, SN, 'node'), (G, JG, SG, 'go')]:
    r = res[lab] = []
    c, d = call(base, 'POST', '/api/staff/guests', {'name': f'Mover {RUN}', 'partySize': 2}, jar=jar)
    gid = d['guest']['id']
    r.append(call(base, 'POST', f'/api/staff/guests/{gid}/seat', {'tableId': 1}, jar=jar)[0])
    r.append(call(base, 'POST', '/api/staff/tables/1/transfer', {}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/1/transfer', {'toTableId': 'x'}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/9999/transfer', {'toTableId': 2}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/1/transfer', {'toTableId': 9999}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/1/transfer', {'toTableId': 3}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/1/transfer', {'toUserId': 9999}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/1/transfer', {'toTableId': 2}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/2/transfer', {'toUserId': 2}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/2/transfer', {'toTableId': 1, 'toUserId': 1}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/1/transfer', {'toTableId': 1}, jar=jar))
    t = {x['id']: (x['status'], x['server_id'], x['guest_name']) for x in call(base, 'GET', '/api/staff/pad/tables', jar=jar)[1]['tables'] if x['id'] in (1, 2)}
    r.append(t)
    # prep pars
    r.append(call(base, 'PUT', '/api/staff/menu/4/prep-par', {'par': 12}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/menu/4/prep-par', {}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/menu/4/prep-par', {'par': 1000}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/menu/4/prep-par', {'par': 3}, jar=sjar))
    r.append([x for x in call(base, 'GET', '/api/staff/prep-pars', jar=jar)[1] if x['id'] == 4])
    r.append(call(base, 'PUT', '/api/staff/menu/4/prep-par', {'par': None}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/menu/4/prep-par', {'par': 0}, jar=jar))
    # signatures
    r.append(call(base, 'POST', f'/api/staff/orders/{delivery}/signature', {'signature': 'data:image/jpeg;base64,AAAA'}, jar=jar))
    r.append(call(base, 'POST', f'/api/staff/orders/{plain}/signature', {'signature': sig}, jar=jar))
    r.append(call(base, 'POST', f'/api/staff/orders/{delivery}/signature', {'name': 5}, jar=jar))
    r.append(raw(base, '/api/staff/orders/999999/signature', jar=jar))
    r.append(call(base, 'POST', f'/api/staff/orders/{delivery}/signature', {'signature': sig, 'name': ' Sam '}, jar=jar))
    r.append(raw(base, f'/api/staff/orders/{delivery}/signature', jar=jar))
    r.append(call(base, 'POST', f'/api/staff/orders/{delivery}/signature', {'signature': sig}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/preorder-reminders/run', {}, jar=sjar))
for i, (a, b) in enumerate(zip(res['node'], res['go'])):
    check(f'step {i}: same answer', a == b, (a, b))
for act in ['table.transfer', 'prep.par', 'delivery.signature']:
    an = [x['detail'] for x in sqlite(f"SELECT detail FROM audit WHERE action = '{act}' ORDER BY id DESC LIMIT 4")]
    ag = pg(f"SELECT detail FROM audit WHERE action = '{act}' ORDER BY id DESC LIMIT 4").split('\n')
    check(f'{act} audit entries match', an == ag, (an, ag))
both("UPDATE tables SET status = 'open', guest_id = NULL, seated_at = NULL, server_id = NULL WHERE id IN (1, 2)")

# pre-order reminders: a booking tomorrow without a pre-order gets one reminder
tomorrow = (datetime.datetime.now(zoneinfo.ZoneInfo(pg("SELECT COALESCE((SELECT value FROM settings WHERE key = 'timezone'), 'America/New_York')") or 'America/New_York')) + datetime.timedelta(days=1)).strftime('%Y-%m-%d')
cust = int(pg("SELECT MIN(id) FROM customers"))
ins = f"INSERT INTO bookings (customer_id, start_local, party_size, status) VALUES ({cust}, '{tomorrow} 18:30', 4, 'booked')"
both(ins)
setting('booking_preorder', '1'); setting('preorder_reminder', '1'); setting('preorder_reminder_hour', '0')
a = call(N, 'POST', '/api/staff/preorder-reminders/run', {}, jar=JN); b = call(G, 'POST', '/api/staff/preorder-reminders/run', {}, jar=JG)
check('reminders run: same answer', a == b and a[1]['sent'] >= 1, (a, b))
a = call(N, 'POST', '/api/staff/preorder-reminders/run', {}, jar=JN); b = call(G, 'POST', '/api/staff/preorder-reminders/run', {}, jar=JG)
check('reminders run twice: same answer', a == b, (a, b))
setting('booking_preorder', None); setting('preorder_reminder', None); setting('preorder_reminder_hour', None)
an = sqlite("SELECT detail FROM audit WHERE action = 'booking.preorder_reminder' ORDER BY id DESC LIMIT 1"); ag = pg("SELECT detail FROM audit WHERE action = 'booking.preorder_reminder' ORDER BY id DESC LIMIT 1")
check('reminder audit', an and an[0]['detail'] == ag, (an, ag))
both(f"UPDATE bookings SET status = 'cancelled' WHERE start_local = '{tomorrow} 18:30'")
done()
