"""station.js vs station.go: fire next course, rush/VIP, delivery photos, same again, checks, customer find, server checkout."""
from contractlib import *
JN, JG = '/tmp/j2s_n', '/tmp/j2s_g'
login(N, '8642', JN); login(G, '8642', JG)
c, tables = call(N, 'GET', '/api/staff/tables', jar=JN)
qr = next((t for t in tables if t.get('qr_token')), None)
paths = ['/api/staff/tables/1/held', '/api/staff/customer-find?q=an', '/api/staff/customer-find?q=ana', '/api/staff/customer-find?q=5551',
         '/api/staff/me/checkout', '/api/staff/me/checkout?date=2026-11-21', '/api/staff/checkouts', '/api/staff/checkouts?date=2026-11-22',
         '/api/staff/orders/99999999/drop-photo', '/api/g/AAAAAAAAAAAAAAAAAAAAAAAA/drop-photo', '/api/t/AAAAAAAAAAAAAAAA/last-round', '/api/t/short/last-round']
if qr: paths += [f"/api/t/{qr['qr_token']}/last-round", f"/api/t/{qr['qr_token']}/last-round?tab=nope&member=Al"]
for p in paths:
    same_get(p, JN, JG)
for p in ['/api/staff/customer-find?q=ana', '/api/staff/checkouts?date=2026-11-22', '/api/staff/me/checkout?date=2026-11-21'] + ([f"/api/t/{qr['qr_token']}/last-round"] if qr else []):
    a, b = call(N, 'GET', p, jar=JN), call(G, 'GET', p, jar=JG)
    check(f'{p} identical', a == b, (a, b))
a, b = call(N, 'PUT', '/api/c/bookings/1/preorder', {'lines': []}), call(G, 'PUT', '/api/c/bookings/1/preorder', {'lines': []})
check('preorder needs a customer', a == b, (a, b))
res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = {}
    c, menu = call(base, 'GET', '/api/kds/menu', jar=jar)
    cands = [x for x in menu if not x['out'] and (x['stock'] is None or x['stock'] > 5)]
    if lab == 'go': cands = [x for x in menu if x['id'] == picked] + cands
    for item in cands:
        c, d = call(base, 'POST', '/api/staff/orders', {'tableId': 1, 'items': [{'itemId': item['id'], 'qty': 1}, {'itemId': item['id'], 'qty': 2, 'course': 2}]}, jar=jar)
        if c == 200: picked = item['id']; break
    oid = d['id']
    c, h = call(base, 'GET', '/api/staff/tables/1/held', jar=jar); r['held'] = [(x['course'], x['n'], x['items'], x['fireIn']) for x in h]
    r['fire_bad'] = call(base, 'POST', '/api/staff/tables/1/fire-course', {'course': 7}, jar=jar)
    r['fire'] = call(base, 'POST', '/api/staff/tables/1/fire-course', {}, jar=jar)
    r['fire_none'] = call(base, 'POST', '/api/staff/tables/1/fire-course', {}, jar=jar)
    r['prio_bad'] = call(base, 'POST', f'/api/staff/orders/{oid}/priority', {'priority': 5}, jar=jar)
    r['prio'] = call(base, 'POST', f'/api/staff/orders/{oid}/priority', {'priority': 2}, jar=jar)
    r['prio_404'] = call(base, 'POST', '/api/staff/orders/99999999/priority', {'priority': 1}, jar=jar)
    c, k = call(base, 'POST', '/api/staff/kds/start', {'area': 'Grill'}, jar=jar)
    r['kprio'] = call(base, 'POST', '/api/kds/priority', {'orderId': oid, 'priority': 1}, headers={'X-Kds': k['token']})
    c, v = call(base, 'GET', '/api/kds', jar=jar); r['board_prio'] = next(x['priority'] for x in v['orders'] if x['id'] == oid)
    r['photo_bad'] = call(base, 'POST', f'/api/staff/orders/{oid}/drop-photo', {'photo': 'nope'}, jar=jar)
    r['photo_404'] = call(base, 'POST', f'/api/staff/orders/{oid}/drop-photo', {'photo': 'data:image/jpeg;base64,AAAA'}, jar=jar)
    r['gift_404'] = call(base, 'POST', '/api/staff/bills/99999999/gift', {'code': 'X'}, jar=jar)
    r['member_404'] = call(base, 'POST', '/api/staff/bills/99999999/member', {'customerId': 1}, jar=jar)
    c, au = call(base, 'GET', '/api/staff/audit', jar=jar)
    r['audit'] = [(a['action'], a['detail'].split('(#')[0]) for a in au[:10] if a['action'] in ('order.fire', 'order.priority')]
    login(base, '5791', jar + 's')
    r['checkouts_staff'] = call(base, 'GET', '/api/staff/checkouts', jar=jar + 's')
    c, mc = call(base, 'GET', '/api/staff/me/checkout?date=2026-11-21', jar=jar + 's'); r['me_staff'] = (c, mc)
for k in res['node']:
    a, b = res['node'][k], res['go'][k]
    check(f'{k}: identical', a == b, (a, b))
done()
