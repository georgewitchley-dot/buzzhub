"""pace.js vs pace.go: curbside "I'm here" and ETA, hand-off, kitchen speed, event menus, break plan, declared tips."""
from contractlib import *
JN, JG = '/tmp/j2c_n', '/tmp/j2c_g'
login(N, '8642', JN); login(G, '8642', JG)
for p in ['/api/staff/curbside', '/api/staff/kitchen-speed', '/api/staff/kitchen-speed?days=90', '/api/staff/break-plan']:
    same_get(p, JN, JG)
a, b = call(N, 'GET', '/api/staff/kitchen-speed?days=90', jar=JN), call(G, 'GET', '/api/staff/kitchen-speed?days=90', jar=JG)
for k in ('overall', 'late', 'byHour', 'byDay', 'byChannel', 'lateMinutes'):
    check(f'kitchen-speed {k} identical', a[1][k] == b[1][k], (a[1][k], b[1][k]))
a, b = call(N, 'GET', '/api/staff/break-plan', jar=JN), call(G, 'GET', '/api/staff/break-plan', jar=JG)
check('break-plan identical', a == b, (a, b))
res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = {}
    c, menu = call(base, 'GET', '/api/kds/menu', jar=jar)
    for item in [x for x in menu if not x['out'] and (x['stock'] is None or x['stock'] > 3)]:
        c, d = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 1}], 'attachBuzzer': True, 'customerName': 'Pat Quinn', 'fulfillment': 'pickup'}, jar=jar)
        if c == 200: break
    oid, tok = d['id'], d['buzzer']['link'].rsplit('/', 1)[1]
    c, v = call(base, 'GET', f'/api/g/{tok}'); r['view'] = (c, v.get('curbside'), v.get('shelf'), v.get('dropPhoto'))
    r['here_bad'] = call(base, 'POST', f'/api/g/{tok}/here', {'note': 'x' * 81})
    r['here'] = call(base, 'POST', f'/api/g/{tok}/here', {'note': 'Blue Honda'})
    c, v = call(base, 'GET', f'/api/g/{tok}'); r['view2'] = v.get('curbside')
    c, cl = call(base, 'GET', '/api/staff/curbside', jar=jar)
    row = next(x for x in cl if x['id'] == oid); r['curbrow'] = {k: row[k] for k in ('arrival_note', 'customer_name', 'status')}
    r['here_404'] = call(base, 'POST', '/api/g/AAAAAAAAAAAAAAAAAAAAAAAA/here', {})
    r['eta_bad'] = call(base, 'POST', f'/api/g/{tok}/eta', {'lat': 100, 'lng': 0})
    r['eta_far'] = call(base, 'POST', f'/api/g/{tok}/eta', {'lat': 40.80, 'lng': -74.0})
    c, v = call(base, 'GET', '/api/kds?area=Packing', jar=jar); r['enroute'] = [(x['etaMinutes'], x['km'], x['ready']) for x in v['enRoute'] if x['id'] == oid]
    r['arrivals'] = [(x['note'], x['ready']) for x in v['arrivals'] if x['id'] == oid]
    r['eta_stop'] = call(base, 'POST', f'/api/g/{tok}/eta', {'lat': 0, 'lng': 0, 'stop': True})
    r['shelf'] = call(base, 'POST', '/api/kds/shelf', {'orderId': oid, 'shelf': 'A3', 'area': 'Packing'}, jar=jar)
    c, v = call(base, 'GET', f'/api/g/{tok}'); r['view3'] = v.get('shelf')
    r['shelf_shelfused'] = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 1}]}, jar=jar)[0]
    r['handed'] = call(base, 'POST', f'/api/staff/orders/{oid}/handed', {}, jar=jar)
    r['handed_404'] = call(base, 'POST', '/api/staff/orders/99999999/handed', {}, jar=jar)
    c, v = call(base, 'GET', f'/api/g/{tok}'); r['view4'] = (v.get('status'), v.get('curbside'))
    r['menu_404'] = call(base, 'PUT', '/api/staff/rooms/bookings/99999999/menu', {'lines': []}, jar=jar)
    r['menu_bad'] = call(base, 'PUT', '/api/staff/rooms/bookings/1/menu', {'lines': [], 'fireTime': '9am'}, jar=jar)
    r['fire_404'] = call(base, 'POST', '/api/staff/rooms/bookings/99999999/fire', {}, jar=jar)
    r['tips_404'] = call(base, 'PUT', '/api/staff/shifts/99999999/declared-tips', {'cents': 100}, jar=jar)
    r['tips_bad'] = call(base, 'PUT', '/api/staff/shifts/1/declared-tips', {'cents': -1}, jar=jar)
    r['tips'] = call(base, 'PUT', '/api/staff/shifts/1/declared-tips', {'cents': 1234}, jar=jar)
    c, au = call(base, 'GET', '/api/staff/audit', jar=jar)
    r['audit'] = [(a['action'], a['detail']) for a in au[:15] if a['action'].startswith(('curbside.', 'tips.'))]
for k in res['node']:
    a, b = res['node'][k], res['go'][k]
    check(f'{k}: identical', a == b, (a, b))
done()
