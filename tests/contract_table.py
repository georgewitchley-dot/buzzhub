"""table.js vs table.go: pad tables, timeline, prep log, delivery route, coaching, plate photos, tab join."""
from contractlib import *
from tablekit import *

JN, JG, SN, SG = '/tmp/j10_n', '/tmp/j10_g', '/tmp/j10_sn', '/tmp/j10_sg'
login(N, '8642', JN); login(G, '8642', JG)
login(N, '5791', SN); login(G, '5791', SG)
both("UPDATE tables SET status = 'seated', seated_at = '2026-01-01 10:00:00' WHERE id = 3")

for p in ['/api/staff/pad/tables', '/api/staff/table-timeline', '/api/staff/deliveries/route', '/api/staff/deliveries/route?driver=2',
          '/api/staff/deliveries/route?driver=abc', '/api/staff/coaching', '/api/staff/coaching?days=7', '/api/staff/coaching?days=abc',
          '/api/staff/coaching?days=500', '/api/staff/plate-photos', '/api/staff/plate-photos?date=2026-11-01', '/api/staff/plate-photos?date=bad',
          '/api/kds/prep-log', '/api/kds/prep-log?area=Grill', '/api/staff/plate-photos/999999', '/api/staff/plate-photos/abc']:
    same_get(p, JN, JG)
# compare values that should be identical
for p in ['/api/staff/pad/tables', '/api/staff/coaching?days=90', '/api/staff/deliveries/route']:
    a, b = call(N, 'GET', p, jar=JN), call(G, 'GET', p, jar=JG)
    if p.endswith('tables'):
        for t in a[1]['tables'] + b[1]['tables']: t.pop('seatedMinutes', None)
    check(f'{p}: same values', a[1] == b[1], (a[1], b[1]))
# role / auth checks
same_get('/api/staff/deliveries/route?driver=1', SN, SG, 'staff asks for another route')
same_get('/api/staff/coaching', SN, SG, 'staff coaching (manager only)')
same_get('/api/staff/plate-photos', SN, SG, 'staff plate photos (manager only)')
same_get('/api/kds/prep-log', None, None, 'prep log signed out')
for lab, tok in [('good kds token', kds_token('Grill')), ('old kds version', kds_token('Grill', v='7')), ('wrong key', kds_token(key_suffix=':x'))]:
    a = call(N, 'GET', '/api/kds/prep-log', headers={'X-Kds': tok}); b = call(G, 'GET', '/api/kds/prep-log', headers={'X-Kds': tok})
    check(f'{lab}: same answer', a == b, (a, b))

item = int(pg("SELECT id FROM menu_items WHERE active = 1 ORDER BY id LIMIT 1"))
ing = pg("SELECT id FROM ingredients ORDER BY id LIMIT 1")
order = int(pg("SELECT id FROM orders ORDER BY id LIMIT 1"))
tok = kds_token('Grill')
res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = []
    r.append(call(base, 'POST', '/api/kds/prep-log', {'kind': 'item', 'refId': item, 'qty': 2.5, 'done': True, 'by': 'Zed'}, jar=jar))
    r.append(call(base, 'POST', '/api/kds/prep-log', {'kind': 'item', 'refId': item, 'qty': 3, 'done': True}, headers={'X-Kds': tok}))
    r.append(call(base, 'POST', '/api/kds/prep-log', {'kind': 'item', 'refId': 99999, 'qty': 1, 'done': True}, jar=jar))
    r.append(call(base, 'POST', '/api/kds/prep-log', {'kind': 'bogus', 'refId': 'x', 'qty': -1}, jar=jar))
    if ing: r.append(call(base, 'POST', '/api/kds/prep-log', {'kind': 'ingredient', 'refId': int(ing), 'qty': 0, 'done': True}, jar=jar))
    c, d = call(base, 'GET', '/api/kds/prep-log?area=Grill', headers={'X-Kds': tok})
    r.append((c, [(x['kind'], x['ref_id'], x['qty'], x['by_label']) for x in d]))
    c, d = call(base, 'GET', '/api/kds/prep-log', jar=jar)
    r.append((c, sorted((x['kind'], x['ref_id'], x['qty'], x['by_label']) for x in d)))
    r.append(call(base, 'POST', '/api/kds/prep-log', {'kind': 'item', 'refId': item, 'qty': 0, 'done': False}, headers={'X-Kds': tok}))
    r.append(call(base, 'POST', '/api/kds/prep-log', {'kind': 'item', 'refId': item, 'qty': 1, 'done': True}))
    # plate photos
    r.append(call(base, 'POST', '/api/kds/plate-photo', {'orderId': order, 'photo': 'data:image/png;base64,AAAA'}, headers={'X-Kds': tok}))
    r.append(call(base, 'POST', '/api/kds/plate-photo', {'orderId': 9999999, 'photo': 'data:image/jpeg;base64,/9j/4AAQ'}, headers={'X-Kds': tok}))
    r.append(call(base, 'POST', '/api/kds/plate-photo', {'orderId': order, 'photo': 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='}, headers={'X-Kds': tok}))
    r.append(call(base, 'POST', '/api/kds/plate-photo', {'orderId': 'x'}, jar=jar))
    c, d = call(base, 'GET', '/api/staff/plate-photos', jar=jar)
    r.append((c, [(x['order_id'], x['by_label']) for x in d][:1]))
    pid = d[0]['id']
    r.append(raw(base, f'/api/staff/plate-photos/{pid}', jar=jar))
    # tab join
    r.append(call(base, 'POST', '/api/t/whatever/tab/join', {'code': 'ab', 'name': ''}))
    r.append(call(base, 'POST', '/api/t/whatever/tab/join', {'code': 'zzzz', 'name': 'Kim'}))
for i, (a, b) in enumerate(zip(res['node'], res['go'])):
    check(f'write step {i}: same answer', a == b, (a, b))

# tab join with a fresh code
both("UPDATE tabs SET status = 'open', code = 'QWER', opened_at = datetime('now') WHERE id = (SELECT MAX(id) FROM tabs)".replace("datetime('now')", "'2099-01-01 00:00:00'"))
a = call(N, 'POST', '/api/t/x/tab/join', {'code': ' qwer ', 'name': ' Kim '}); b = call(G, 'POST', '/api/t/x/tab/join', {'code': ' qwer ', 'name': ' Kim '})
check('tab join works', a == b and a[0] == 200, (a, b))
an = sqlite("SELECT action, detail FROM audit ORDER BY id DESC LIMIT 1")[0]; ag = pg("SELECT action || '|' || detail FROM audit ORDER BY id DESC LIMIT 1")
check('tab join audit', f"{an['action']}|{an['detail']}" == ag, (an, ag))

# delivery route with stops
both("UPDATE orders SET fulfillment = 'delivery', driver_id = 1, delivered_at = NULL, status = 'ready', delivery_address = '1 Main St, Town', drop_lat = 40.7, drop_lng = -74.0 WHERE id = (SELECT MIN(id) FROM orders)")
both("UPDATE orders SET fulfillment = 'delivery', driver_id = 1, delivered_at = NULL, status = 'sent', delivery_address = '9 Elm & Oak', drop_lat = 40.8, drop_lng = -73.9 WHERE id = (SELECT MIN(id) + 1 FROM orders)")
both("UPDATE orders SET fulfillment = 'delivery', driver_id = 1, delivered_at = NULL, status = 'sent', delivery_address = 'No pin', drop_lat = NULL, drop_lng = NULL WHERE id = (SELECT MIN(id) + 2 FROM orders)")
a, b = call(N, 'GET', '/api/staff/deliveries/route', jar=JN), call(G, 'GET', '/api/staff/deliveries/route', jar=JG)
check('route with stops: same', a == b and len(a[1]['stops']) >= 3, (a, b))
setting('biz_lat', '40.75'); setting('biz_lng', '-73.95')
a, b = call(N, 'GET', '/api/staff/deliveries/route?driver=1', jar=JN), call(G, 'GET', '/api/staff/deliveries/route?driver=1', jar=JG)
check('route from the business: same', a == b, (a, b))
setting('biz_lat', None); setting('biz_lng', None)
done()
