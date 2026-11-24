"""seat.js vs seat.go: join tables, seat allergies (and tagging new orders), split by seat, top dishes,
prepay a pre-order, proof images."""
import subprocess, uuid
from contractlib import *
from tablekit import *

JN, JG = '/tmp/j10_n', '/tmp/j10_g'
CN, CG = '/tmp/j10_cn', '/tmp/j10_cg'
login(N, '8642', JN); login(G, '8642', JG)

for p in ['/api/staff/tables/5/seat-allergies', '/api/staff/tables/1/seat-allergies', '/api/staff/tables/abc/seat-allergies',
          '/api/staff/me/top-items', '/api/staff/bills/999999/seats', '/api/r/nope/proof/photo', '/api/r/aaaaaaaaaaaaaaaaaaaa/proof/signature']:
    same_get(p, JN, JG)
a, b = call(N, 'GET', '/api/staff/tables/5/seat-allergies', jar=JN), call(G, 'GET', '/api/staff/tables/5/seat-allergies', jar=JG)
check('seat allergies same values', a == b, (a, b))

item = int(pg("SELECT id FROM menu_items m WHERE active = 1 AND (stock IS NULL OR stock > 20) AND NOT EXISTS (SELECT 1 FROM item_mod_groups g WHERE g.item_id = m.id) ORDER BY id LIMIT 1"))
res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = []
    r.append(call(base, 'PUT', '/api/staff/tables/1/seat-allergies', {'seat': 2, 'allergy': ' shellfish '}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/tables/1/seat-allergies', {'seat': 0, 'allergy': 5}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/tables/9999/seat-allergies', {'seat': 1, 'allergy': 'x'}, jar=jar))
    r.append(call(base, 'GET', '/api/staff/tables/1/seat-allergies', jar=jar)[1])
    r.append(call(base, 'PUT', '/api/staff/tables/1/seat-allergies', {'seat': 2, 'allergy': ''}, jar=jar))
    r.append(call(base, 'GET', '/api/staff/tables/1/seat-allergies', jar=jar)[1])
    r.append(call(base, 'PUT', '/api/staff/tables/2/seat-allergies', {'seat': 1, 'allergy': 'gluten'}, jar=jar))
    # an order on table 5: seat 2 has peanuts, seat 1 is named Maria
    c, d = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item, 'qty': 1, 'seat': 2, 'note': 'no salt'}, {'itemId': item, 'qty': 1, 'seat': 1}, {'itemId': item, 'qty': 1}], 'tableId': 5}, jar=jar)
    r.append(c)
    oid = d.get('id')
    db = sqlite if lab == 'node' else None
    if lab == 'node':
        rows = sqlite(f"SELECT seat, note, seat_name FROM order_items WHERE order_id = {oid} ORDER BY id")
        note = sqlite(f"SELECT allergy_note FROM orders WHERE id = {oid}")[0]['allergy_note']
        r.append(([(x['seat'], x['note'], x['seat_name']) for x in rows], note))
    else:
        rows = pg(f"SELECT coalesce(seat::text,'-') || '|' || coalesce(note,'-') || '|' || coalesce(seat_name,'-') FROM order_items WHERE order_id = {oid} ORDER BY id").split('\n')
        note = pg(f"SELECT allergy_note FROM orders WHERE id = {oid}")
        r.append(([tuple(None if v == '-' else (int(v) if i == 0 else v) for i, v in enumerate(x.split('|'))) for x in rows], note or None))
    # join tables 1 + 2 (1 has an order on seat 1, 2 has a seat allergy)
    r.append(call(base, 'POST', '/api/staff/tables/1/join', {'withTableId': 1}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/1/join', {'withTableId': 'x'}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/9999/join', {'withTableId': 2}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/1/join', {'withTableId': 4}, jar=jar))  # 4 is joined to 5
    r.append(call(base, 'POST', '/api/staff/tables/1/join', {'withTableId': 2}, jar=jar))
    r.append(call(base, 'GET', '/api/staff/tables/1/seat-allergies', jar=jar)[1])
    t = [x for x in call(base, 'GET', '/api/staff/pad/tables', jar=jar)[1]['tables'] if x['id'] in (1, 2)]
    for x in t: x.pop('seatedMinutes', None)
    r.append(t)
    r.append(call(base, 'POST', '/api/staff/tables/1/unjoin', {}, jar=jar))
    r.append(call(base, 'POST', '/api/staff/tables/9999/unjoin', {}, jar=jar))
    r.append(call(base, 'PUT', '/api/staff/tables/1/seat-allergies', {'seat': 2 + 2, 'allergy': ''}, jar=jar))
for i, (a, b) in enumerate(zip(res['node'], res['go'])):
    check(f'step {i}: same answer', a == b, (a, b))
an = sqlite("SELECT action, detail FROM audit WHERE action LIKE 'table.%' OR action = 'seat.allergy' ORDER BY id DESC LIMIT 4")
ag = pg("SELECT action || '|' || detail FROM audit WHERE action LIKE 'table.%' OR action = 'seat.allergy' ORDER BY id DESC LIMIT 4").split('\n')
check('audit entries match', [f"{x['action']}|{x['detail']}" for x in an] == ag, (an, ag))
both("UPDATE tables SET status = 'open', guest_id = NULL WHERE id IN (1, 2)")

# prepay a pre-order (customer account)
email = f'ct{uuid.uuid4().hex[:8]}@example.com'
for base, jar, lab in [(N, CN, 'node'), (G, CG, 'go')]:
    subprocess.run(['rm', '-f', jar])
    c, d = call(base, 'POST', '/api/c/register', {'name': 'Pat Late', 'email': (lab + email), 'password': 'Sunny-Days-42!'}, jar=jar)
    check(f'{lab}: customer registered', c == 200, (c, d))
cn = sqlite(f"SELECT id FROM customers WHERE email = 'node{email}'")[0]['id']; cg = int(pg(f"SELECT id FROM customers WHERE email = 'go{email}'"))
pre = '[{"itemId": %d, "qty": 2}]' % item
sqlite(f"INSERT INTO bookings (customer_id, start_local, party_size, status, preorder) VALUES ({cn}, '2099-01-01 19:00', 2, 'booked', '{pre}')")
pg(f"INSERT INTO bookings (customer_id, start_local, party_size, status, preorder) VALUES ({cg}, '2099-01-01 19:00', 2, 'booked', '{pre}')")
bn = sqlite(f"SELECT MAX(id) id FROM bookings WHERE customer_id = {cn}")[0]['id']; bg = int(pg(f"SELECT MAX(id) FROM bookings WHERE customer_id = {cg}"))
both_ = [(N, CN, 'node', bn), (G, CG, 'go', bg)]
def pair(name, fn):
    a, b = [fn(base, jar, bid) for base, jar, lab, bid in both_]
    check(name, a == b, (a, b)); return a, b
pair('pay ahead signed out', lambda base, jar, bid: call(base, 'POST', f'/api/c/bookings/{bid}/preorder/pay', {}))
pair('pay ahead turned off', lambda base, jar, bid: call(base, 'POST', f'/api/c/bookings/{bid}/preorder/pay', {}, jar=jar))
setting('booking_preorder_pay', '1')
a, b = [call(base, 'POST', f'/api/c/bookings/{bid}/preorder/pay', {}, jar=jar) for base, jar, lab, bid in both_]
# payments.js (onlinePayEnabled/startPay) is ported by another module: until then Go answers 503
check('pay ahead turned on', a == b or (a[0] == 200 and 'url' in a[1] and b == (503, {'error': 'Online payments are not set up. Pay at the table instead.'})), (a, b))
setting('booking_preorder_pay', None)
pair('running late', lambda base, jar, bid: call(base, 'POST', f'/api/c/bookings/{bid}/late', {'minutes': 15}, jar=jar))
pair('running late, bad booking', lambda base, jar, bid: call(base, 'POST', '/api/c/bookings/999999/late', {'minutes': 15}, jar=jar))
pair('running late, bad minutes', lambda base, jar, bid: call(base, 'POST', f'/api/c/bookings/{bid}/late', {'minutes': 2}, jar=jar))
an = sqlite(f"SELECT late_minutes FROM bookings WHERE id = {bn}")[0]['late_minutes']; ag = pg(f"SELECT late_minutes FROM bookings WHERE id = {bg}")
check('running late saved', str(an) == ag == '15', (an, ag))
an = sqlite("SELECT detail FROM audit WHERE action = 'booking.late' ORDER BY id DESC LIMIT 1")[0]['detail']; ag = pg("SELECT detail FROM audit WHERE action = 'booking.late' ORDER BY id DESC LIMIT 1")
check('running late audit', an == ag, (an, ag))
done()
