from contractlib import *
login(N, '8642', '/tmp/cn'); login(G, '8642', '/tmp/cg')
for p in ['/api/staff/dashboard', '/api/staff/guests', '/api/staff/tables', '/api/staff/menu', '/api/staff/orders', '/api/staff/orders?scope=paid',
          '/api/staff/users', '/api/staff/audit', '/api/staff/bookings', '/api/staff/customers', '/api/staff/join-qr', '/api/staff/security/me',
          '/api/staff/security/devices', '/api/public/vapid', '/api/c/booking-info']:
    same_get(p, '/tmp/cn', '/tmp/cg')
# waitlist flow on both servers
for base, jar, lab in [(N, '/tmp/cn', 'node'), (G, '/tmp/cg', 'go')]:
    c, d = call(base, 'POST', '/api/staff/guests', {'name': 'Contract Test', 'partySize': 2}, jar=jar)
    check(f'{lab}: add guest', c == 200 and d['guest']['token'], (c, d))
    gid, tok = d['guest']['id'], d['guest']['token']
    c, v = call(base, 'GET', f'/api/g/{tok}')
    check(f'{lab}: guest page', c == 200 and v['status'] == 'waiting', (c, v))
    globals()[f'view_{lab}'] = v
    c, d = call(base, 'POST', f'/api/staff/guests/{gid}/buzz', {}, jar=jar)
    check(f'{lab}: buzz', c == 200 and 'message' in d, (c, d))
    c, d = call(base, 'POST', f'/api/g/{tok}/ack', {})
    check(f'{lab}: guest acknowledges', c == 200, (c, d))
    c, d = call(base, 'POST', f'/api/staff/guests/{gid}/seat', {}, jar=jar)
    check(f'{lab}: seat', c == 200 and d.get('ok'), (c, d))
    c, d = call(base, 'POST', f'/api/staff/guests/{gid}/remove', {'reason': 'bogus'}, jar=jar)
    globals()[f'err_{lab}'] = (c, d)
check('guest view same shape', not diff(shape(view_node), shape(view_go)), diff(shape(view_node), shape(view_go)))
check('validation error identical', err_node == err_go, (err_node, err_go))
# register order flow
for base, jar, lab in [(N, '/tmp/cn', 'node'), (G, '/tmp/cg', 'go')]:
    c, menu = call(base, 'GET', '/api/staff/menu', jar=jar)
    item = next(m for m in menu if m['active'] and (m.get('stock') is None or m['stock'] > 5))
    c, mods = call(base, 'GET', '/api/staff/mods', jar=jar)
    c, d = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 2}], 'attachBuzzer': True, 'customerName': 'CT'}, jar=jar)
    if c == 400 and 'Choose' in str(d): check(f'{lab}: order needs options (skipped)', True); continue
    check(f'{lab}: create order', c == 200 and d.get('number'), (c, d))
    oid = d['id']
    c, d = call(base, 'POST', f'/api/staff/orders/{oid}/ready', {}, jar=jar)
    check(f'{lab}: ready', c == 200, (c, d))
    c, d = call(base, 'POST', f'/api/staff/orders/{oid}/pay', {'method': 'cash', 'tenderedCents': 100000}, jar=jar)
    check(f'{lab}: pay cash', c == 200 and d.get('changeCents', -1) >= 0, (c, d))
    globals()[f'pay_{lab}'] = d
if 'pay_node' in globals() and 'pay_go' in globals(): check('pay answer same fields', set(pay_node) == set(pay_go), (pay_node, pay_go))
done()
