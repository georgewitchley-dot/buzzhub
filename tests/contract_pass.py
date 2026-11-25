"""pass.js vs pass.go: screen messages, batch timers, shelves, slots, curbside ETA, dish ratings, cook stats."""
from contractlib import *
JN, JG = '/tmp/j2p_n', '/tmp/j2p_g'
login(N, '8642', JN); login(G, '8642', JG)
for p in ['/api/o/slots', '/api/o/slots?date=2026-11-24', '/api/o/slots?date=bad', '/api/staff/dish-ratings', '/api/staff/dish-ratings?days=365',
          '/api/staff/cook-stats', '/api/staff/cook-stats?days=90']:
    same_get(p, JN, JG)
norm = lambda d: {k: (sorted(json.dumps(x, sort_keys=True) for x in v) if isinstance(v, list) else v) for k, v in d.items()} if isinstance(d, dict) else d  # ties in ORDER BY n come out in any order
for p in ['/api/staff/dish-ratings?days=365', '/api/staff/cook-stats?days=90', '/api/o/slots']:
    a, b = call(N, 'GET', p, jar=JN), call(G, 'GET', p, jar=JG)
    check(f'{p} identical', a[0] == b[0] and norm(a[1]) == norm(b[1]), (a, b))
a, b = call(N, 'POST', '/api/kds/msg', {'to': 'Bar', 'body': 'x'}), call(G, 'POST', '/api/kds/msg', {'to': 'Bar', 'body': 'x'})
check('msg signed out identical', a == b, (a, b))
a, b = call(N, 'POST', '/api/kds/msg', {'to': 'Bar', 'body': 'x'}, headers={'X-Kds': 'junk'}), call(G, 'POST', '/api/kds/msg', {'to': 'Bar', 'body': 'x'}, headers={'X-Kds': 'junk'})
check('msg bad token identical', a == b, (a, b))
res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = {}
    c, d = call(base, 'POST', '/api/staff/kds/start', {'area': 'Grill'}, jar=jar); tok = d['token']; H = {'X-Kds': tok}
    r['msg_bad'] = call(base, 'POST', '/api/kds/msg', {'to': 'Moon', 'body': 'hi'}, headers=H)
    r['msg_empty'] = call(base, 'POST', '/api/kds/msg', {'to': 'Bar', 'body': ''}, headers=H)
    r['msg'] = call(base, 'POST', '/api/kds/msg', {'to': 'Bar', 'body': 'Need 2 more fries'}, headers=H)
    c, v = call(base, 'GET', '/api/kds?area=Bar', jar=jar)
    m = v['messages'][0]; r['msg_row'] = {k: m[k] for k in ('from', 'to', 'body', 'by', 'acked', 'mine')}
    r['ack'] = call(base, 'POST', f"/api/kds/msg/{m['id']}/ack", {'area': 'Bar'}, jar=jar)
    c, v = call(base, 'GET', '/api/kds?area=Bar', jar=jar); r['acked'] = (v['messages'][0]['acked'], v['messages'][0]['ackBy'])
    r['extra_keys'] = sorted(k for k in ('messages', 'timers', 'crew', 'passMinutes', 'shelves', 'shelvesUsed', 'quick') if k in v)
    r['quick'] = v['quick']
    r['timer_bad'] = call(base, 'POST', '/api/kds/timers', {'name': 'Fries', 'minutes': 0.1}, headers=H)
    r['timer'] = call(base, 'POST', '/api/kds/timers', {'name': 'Fries', 'minutes': 3.5}, headers=H)
    c, v = call(base, 'GET', '/api/kds', headers=H); t = v['timers'][-1]
    r['timer_row'] = {k: t[k] for k in ('name', 'minutes', 'repeat')}
    for what in ('restart', 'stop', 'done', 'bogus', 'delete'):
        r[f'timer_{what}'] = call(base, 'POST', f"/api/kds/timers/{t['id']}/{what}", {}, headers=H)
    r['timer_404'] = call(base, 'POST', f"/api/kds/timers/{t['id']}/stop", {}, headers=H)
    c, menu = call(base, 'GET', '/api/kds/menu', jar=jar)
    oid = None
    for item in [x for x in menu if not x['out'] and (x['stock'] is None or x['stock'] > 3)]:
        c, d = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 1}], 'customerName': 'Pass CT'}, jar=jar)
        if c == 200: oid = d['id']; break
    r['shelf_unknown'] = call(base, 'POST', '/api/kds/shelf', {'orderId': oid, 'shelf': 'Z9'}, headers=H)
    r['shelf_none'] = call(base, 'POST', '/api/kds/shelf', {'orderId': oid, 'shelf': None}, headers=H)
    r['shelf_404'] = call(base, 'POST', '/api/kds/shelf', {'orderId': 99999999, 'shelf': None}, headers=H)
    r['shelf_bad'] = call(base, 'POST', '/api/kds/shelf', {'orderId': oid}, headers=H)
    r['oshelf'] = call(base, 'POST', f'/api/staff/orders/{oid}/shelf', {'shelf': 'B2'}, jar=jar)
    r['oshelf_404'] = call(base, 'POST', '/api/staff/orders/99999999/shelf', {'shelf': None}, jar=jar)
    r['eta_off'] = call(base, 'POST', '/api/g/AAAAAAAAAAAAAAAAAAAA/eta', {'lat': 1, 'lng': 2})
    r['bump_cook'] = call(base, 'POST', '/api/kds/bump', {'orderId': oid, 'cookId': 1, 'area': 'All areas'}, jar=jar)
    c, au = call(base, 'GET', '/api/staff/audit', jar=jar)
    r['audit'] = [(a['action'], a['detail']) for a in au[:10] if a['action'] in ('order.shelf',)]
for k in res['node']:
    a, b = res['node'][k], res['go'][k]
    check(f'{k}: identical', a == b, (a, b))
done()
