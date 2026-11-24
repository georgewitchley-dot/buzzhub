"""kds.js vs kds.go: area screens, device tokens, bump/complete/recall/packed, lists, menu board."""
from contractlib import *
JN, JG = '/tmp/j2k_n', '/tmp/j2k_g'
login(N, '8642', JN); login(G, '8642', JG)
for p in ['/api/staff/kds/setup', '/api/menuboard', '/api/kds', '/api/kds?area=Grill', '/api/kds?area=Fryer', '/api/kds?area=Bar', '/api/kds?area=Expo',
          '/api/kds?area=Packing', '/api/kds?area=Runner', '/api/kds?area=Nowhere']:
    same_get(p, JN, JG)
# signed out / no session
for p in ['/api/kds', '/api/menuboard']:
    a, b = call(N, 'GET', p), call(G, 'GET', p)
    check(f'{p} signed out identical', a == b, (a, b))
a, b = call(N, 'GET', '/api/kds', headers={'X-Kds': 'junk'}), call(G, 'GET', '/api/kds', headers={'X-Kds': 'junk'})
check('bad screen token identical', a == b, (a, b))
res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = {}
    r['badarea'] = call(base, 'POST', '/api/staff/kds/start', {'area': 'Moon'}, jar=jar)
    r['badbody'] = call(base, 'POST', '/api/staff/kds/start', {}, jar=jar)
    c, d = call(base, 'POST', '/api/staff/kds/start', {'area': 'Grill'}, jar=jar)
    check(f'{lab}: start screen', c == 200 and d.get('token') and d['area'] == 'Grill', (c, d))
    tok = d['token']; r['startkeys'] = sorted(d)
    c, v = call(base, 'GET', '/api/kds', headers={'X-Kds': tok})
    check(f'{lab}: screen token works', c == 200 and v['area'] == 'Grill' and v['device'] is True and v['kind'] == 'station', (c, str(v)[:200]))
    r['screen'] = v
    c, ex = call(base, 'POST', '/api/staff/kds/start', {'area': 'Expo'}, jar=jar); etok = ex['token']
    c, pk = call(base, 'POST', '/api/staff/kds/start', {'area': 'Packing'}, jar=jar); ptok = pk['token']
    # an order to work
    c, menu = call(base, 'GET', '/api/staff/menu', jar=jar)
    items = [m for m in menu if m['active'] and (m.get('stock') is None or m['stock'] > 5)]
    oid = None
    for item in items:
        c, d = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 2}], 'customerName': 'KDS CT', 'fulfillment': 'pickup'}, jar=jar)
        if c == 200: oid = d['id']; break
    check(f'{lab}: make order', oid, (c, d))
    c, v = call(base, 'GET', '/api/kds', jar=jar)
    o = next((x for x in v['orders'] if x['id'] == oid), None)
    check(f'{lab}: order on all-areas board', o is not None, [x['id'] for x in v['orders']])
    r['boardorder'] = o; r['allDay'] = v['allDay']
    area = o['items'][0]['area']
    c, v = call(base, 'GET', f'/api/kds?area={area}', jar=jar)
    r['station'] = next((x for x in v['orders'] if x['id'] == oid), None)
    r['bump_none'] = call(base, 'POST', '/api/kds/bump', {'orderId': oid, 'itemIds': [999999]}, headers={'X-Kds': tok})
    r['bump_404'] = call(base, 'POST', '/api/kds/bump', {'orderId': 99999999}, headers={'X-Kds': tok})
    r['bump_bad'] = call(base, 'POST', '/api/kds/bump', {'orderId': 'x'}, headers={'X-Kds': tok})
    c, d = call(base, 'POST', '/api/kds/bump', {'orderId': oid, 'area': area}, jar=jar)
    r['bump'] = (c, d)
    c, d = call(base, 'POST', '/api/kds/bump', {'orderId': oid, 'undo': True, 'area': area}, jar=jar)
    r['undo'] = (c, d)
    r['complete_pack'] = call(base, 'POST', '/api/kds/complete', {'orderId': oid}, headers={'X-Kds': ptok})
    r['packed_wrong'] = call(base, 'POST', '/api/kds/packed', {'orderId': oid}, headers={'X-Kds': tok})
    r['packed'] = call(base, 'POST', '/api/kds/packed', {'orderId': oid, 'shelf': 'A1'}, headers={'X-Kds': ptok})
    c, v = call(base, 'GET', '/api/kds', headers={'X-Kds': ptok}); r['packscreen'] = (c, v)
    r['recall_pack'] = call(base, 'POST', '/api/kds/recall', {'orderId': oid, 'reason': 'missing'}, headers={'X-Kds': ptok})
    r['recall_bad'] = call(base, 'POST', '/api/kds/recall', {'orderId': oid, 'reason': 'nope'}, headers={'X-Kds': ptok})
    r['complete'] = call(base, 'POST', '/api/kds/complete', {'orderId': oid}, headers={'X-Kds': etok})
    r['complete_again'] = call(base, 'POST', '/api/kds/complete', {'orderId': oid}, headers={'X-Kds': etok})
    c, v = call(base, 'GET', '/api/kds', headers={'X-Kds': etok}); r['exporecent'] = any(x['id'] == oid for x in v['recent'])
    r['recall_station'] = call(base, 'POST', '/api/kds/recall', {'orderId': oid}, headers={'X-Kds': tok})
    c, d = call(base, 'GET', f'/api/staff/orders', jar=jar)
    r['status_after_recall'] = next((x['status'] for x in d if x['id'] == oid), None) if isinstance(d, list) else None
    r['list_404'] = call(base, 'POST', '/api/kds/list-check', {'templateId': 999999, 'index': 0, 'done': True}, headers={'X-Kds': tok})
    r['list_bad'] = call(base, 'POST', '/api/kds/list-check', {'templateId': 1, 'index': 101, 'done': True}, headers={'X-Kds': tok})
    r['handed'] = call(base, 'POST', '/api/kds/handed', {'orderId': oid}, headers={'X-Kds': ptok})
    r['handed_404'] = call(base, 'POST', '/api/kds/handed', {'orderId': 99999999}, headers={'X-Kds': ptok})
    r['itemst_bad'] = call(base, 'PUT', '/api/staff/kds/item-station', {'itemId': items[0]['id'], 'station': 'Moon'}, jar=jar)
    r['itemst'] = call(base, 'PUT', '/api/staff/kds/item-station', {'itemId': items[0]['id'], 'station': None}, jar=jar)
    c, b = call(base, 'POST', '/api/staff/menuboard/start', {}, jar=jar)
    check(f'{lab}: board token', c == 200 and b.get('token'), (c, b))
    c2, v = call(base, 'GET', '/api/menuboard', headers={'X-Board': b['token']})
    r['board'] = (c2, shape(v))
    r['board_out'] = call(base, 'POST', '/api/staff/menuboard/signout-all', {}, jar=jar)
    r['board_after'] = call(base, 'GET', '/api/menuboard', headers={'X-Board': b['token']})
    r['so'] = call(base, 'POST', '/api/staff/kds/signout-all', {}, jar=jar)
    r['after_so'] = call(base, 'GET', '/api/kds', headers={'X-Kds': tok})
    r['staffkds'] = call(base, 'POST', '/api/staff/kds/start', {'area': 'Grill'})
    c, au = call(base, 'GET', '/api/staff/audit', jar=jar)
    r['audit'] = sorted({a['action'] for a in au[:40] if a['action'].startswith(('kds.', 'board.', 'order.ready'))}) if isinstance(au, list) else au
for k in res['node']:
    a, b = res['node'][k], res['go'][k]
    if k in ('screen', 'boardorder', 'station'):
        check(f'{k}: same shape', not diff(shape(a), shape(b)), diff(shape(a), shape(b)))
    elif k == 'packscreen':
        check(f'{k}: same', a[0] == b[0] and not diff(shape(a[1]), shape(b[1])), diff(shape(a[1]), shape(b[1])))
    elif k == 'board':
        check(f'{k}: same (calories come from another module\'s menu hook)', a[0] == b[0] and not diff(a[1], b[1]), diff(a[1], b[1]))
    elif k == 'allDay':
        check(f'{k}: same shape', not diff(shape(a), shape(b)), (a, b))
    else:
        check(f'{k}: identical', a == b, (a, b))
import json as _j
if os.environ.get("SHOW"): print(_j.dumps({k: v for k, v in res["go"].items() if k not in ("screen","boardorder","station","packscreen","board")}, default=str)[:3000])
done()
