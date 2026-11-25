"""line.js vs line.go: recipe cards, 86, remakes, temps, rush/pause, pulse, labor by area."""
from contractlib import *
JN, JG = '/tmp/j2l_n', '/tmp/j2l_g'
login(N, '8642', JN); login(G, '8642', JG)
for p in ['/api/kds/menu', '/api/kds/menu?area=Grill', '/api/kds/menu?area=Bar', '/api/kds/remake-reasons', '/api/kds/temps', '/api/kds/temps?area=Grill',
          '/api/staff/remakes', '/api/staff/remakes?days=30', '/api/staff/rush', '/api/staff/pulse', '/api/staff/pulse?days=60',
          '/api/staff/labor-by-area', '/api/staff/labor-by-area?days=30', '/api/kds/card/1', '/api/kds/card/999999', '/api/kds/card/abc']:
    same_get(p, JN, JG)
for p in ['/api/kds/menu', '/api/kds/remake-reasons']:
    a, b = call(N, 'GET', p), call(G, 'GET', p)
    check(f'{p} signed out identical', a == b, (a, b))
a, b = call(N, 'GET', '/api/kds/menu', headers={'X-Kds': 'junk'}), call(G, 'GET', '/api/kds/menu', headers={'X-Kds': 'junk'})
check('bad token identical', a == b, (a, b))
a, b = call(N, 'GET', '/api/kds/menu?area=Grill', jar=JN), call(G, 'GET', '/api/kds/menu?area=Grill', jar=JG)
check('86 list identical', a == b, (a, b))
a, b = call(N, 'GET', '/api/staff/labor-by-area', jar=JN), call(G, 'GET', '/api/staff/labor-by-area', jar=JG)
check('labor-by-area identical', a[1]['areas'] == b[1]['areas'] and a[1]['totalSalesCents'] == b[1]['totalSalesCents'], (a[1].get('areas'), b[1].get('areas')))
a, b = call(N, 'GET', '/api/staff/remakes?days=90', jar=JN), call(G, 'GET', '/api/staff/remakes?days=90', jar=JG)
# recalls on the area screens add 'Brought back' remakes through serve.js's recallReason hook (not ported here)
own = lambda d: sorted((x['key'], x['count'], x['qty'], x['costCents']) for x in d['byReason'] if not x['key'].startswith('Brought back'))
check('remakes report identical (own reasons)', own(a[1]) == own(b[1]), (a[1]['byReason'], b[1]['byReason']))
login(N, '5791', '/tmp/j2l_sn'); login(G, '5791', '/tmp/j2l_sg')
a, b = call(N, 'GET', '/api/staff/labor-by-area', jar='/tmp/j2l_sn'), call(G, 'GET', '/api/staff/labor-by-area', jar='/tmp/j2l_sg')
check('labor-by-area owner only', a == b, (a, b))
res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = {}
    c, menu = call(base, 'GET', '/api/kds/menu', jar=jar)
    oid = None
    cands = [m for m in menu if not m['out'] and (m['stock'] is None or m['stock'] > 3)]
    if lab == 'go': cands = [m for m in cands if m['id'] == picked] + cands
    for item in cands:
        c, d = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 1}], 'customerName': 'Line CT'}, jar=jar)
        if c == 200: oid = d['id']; picked = item['id']; break
    c, card = call(base, 'GET', f"/api/kds/card/{item['id']}", jar=jar); r['card'] = card
    r['photo404'] = call(base, 'GET', f"/api/kds/card/{item['id']}/photo", jar=jar)[0]
    r['86'] = call(base, 'POST', '/api/kds/86', {'itemId': item['id'], 'out': True, 'area': 'Grill'}, jar=jar)
    c, m2 = call(base, 'GET', '/api/kds/menu', jar=jar); r['out'] = next(m for m in m2 if m['id'] == item['id'])
    r['back'] = call(base, 'POST', '/api/kds/86', {'itemId': item['id'], 'out': False}, jar=jar)
    c, m2 = call(base, 'GET', '/api/kds/menu', jar=jar); r['backrow'] = next(m for m in m2 if m['id'] == item['id'])
    r['86_404'] = call(base, 'POST', '/api/kds/86', {'itemId': 99999999, 'out': True}, jar=jar)
    r['86_bad'] = call(base, 'POST', '/api/kds/86', {'itemId': item['id']}, jar=jar)
    c, od = call(base, 'GET', '/api/staff/orders', jar=jar)
    o = next(x for x in od if x['id'] == oid); oiid = o['items'][0]['id']
    r['remake'] = call(base, 'POST', '/api/kds/remake', {'orderItemId': oiid, 'reason': 'Dropped'}, jar=jar)
    r['remake_bad'] = call(base, 'POST', '/api/kds/remake', {'orderItemId': oiid, 'reason': 'Bored'}, jar=jar)
    r['remake_404'] = call(base, 'POST', '/api/kds/remake', {'orderItemId': 99999999, 'reason': 'Dropped'}, jar=jar)
    c, rm = call(base, 'GET', '/api/staff/remakes', jar=jar); rec = rm['recent'][0]
    r['remake_row'] = {k: rec[k] for k in ('name', 'qty', 'reason', 'area', 'cost_cents', 'by_label')}
    r['temp_404'] = call(base, 'POST', '/api/kds/temps/99999999', {'value': 3}, jar=jar)
    r['temp_bad'] = call(base, 'POST', '/api/kds/temps/1', {'value': 999}, jar=jar)
    r['tu_area'] = call(base, 'PUT', '/api/staff/temp-units/99999999/area', {'area': None}, jar=jar)
    r['tu_area_bad'] = call(base, 'PUT', '/api/staff/temp-units/1/area', {}, jar=jar)
    r['pause_bad'] = call(base, 'POST', '/api/staff/rush/pause', {'minutes': 999}, jar=jar)
    c, d = call(base, 'POST', '/api/staff/rush/pause', {'minutes': 10}, jar=jar); r['pause'] = (c, d['level'], d.get('manual'), d.get('reason'), d['ok'])
    c, d = call(base, 'POST', '/api/kds/pause', {'minutes': 0}, jar=jar); r['resume'] = (c, d['level'], d['ok'])
    c, d = call(base, 'GET', '/api/staff/rush', jar=jar); r['rush'] = (d['level'], sorted(d), sorted(d['quote']))
    r['pulse_bad'] = call(base, 'POST', '/api/staff/me/pulse', {'rating': 9}, jar=jar)
    r['pulse'] = call(base, 'POST', '/api/staff/me/pulse', {'rating': 3, 'note': 'fine'}, jar=jar)
    c, p = call(base, 'GET', '/api/staff/pulse', jar=jar); r['pulse_count'] = (c, sorted(p))
    r['user_area'] = call(base, 'PUT', '/api/staff/users/99999999/area', {'area': 'Grill'}, jar=jar)
    c, au = call(base, 'GET', '/api/staff/audit', jar=jar)
    r['audit'] = [(a['action'], a['detail']) for a in au[:12] if a['action'] in ('item.86', 'item.back', 'kds.remake', 'online.pause', 'online.resume')]
for k in res['node']:
    a, b = res['node'][k], res['go'][k]
    if k == 'card': check(f'{k}: same shape', not diff(shape(a), shape(b)) and a == b, (a, b))
    else: check(f'{k}: identical', a == b, (a, b))
done()
