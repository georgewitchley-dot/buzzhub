"""Node vs Go: run.js (KDS ingredient 86, prep, runner, make-good, delivery batches, bar tabs, area load)."""
import base64, hashlib, hmac, json
from contractlib import *
JN, JG, SN, SG = '/tmp/j7r_n', '/tmp/j7r_g', '/tmp/j7r_sn', '/tmp/j7r_sg'
login(N, '8642', JN); login(G, '8642', JG); login(N, '5791', SN); login(G, '5791', SG)
def both(method, path, body=None, jarn=JN, jarg=JG, label=None, cmp_body=True, headers=None):
    a = call(N, method, path, body, jar=jarn, headers=headers); b = call(G, method, path, body, jar=jarg, headers=headers)
    good = a[0] == b[0] and (not cmp_body or a[0] == 200 or a[1] == b[1])
    if a[0] == b[0] == 200 and isinstance(a[1], (dict, list)): good = good and not diff(shape(a[1]), shape(b[1]))
    check(f'{label or method + " " + path}: {a[0]}', good, (a, b)); return a, b
def kds_token(area, v):
    secret = open('/tmp/bh7/.jwt_secret').read().strip() + ':kds'
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d, separators=(',', ':')).encode()).rstrip(b'=').decode()
    head = enc({'alg': 'HS256', 'typ': 'JWT'}) + '.' + enc({'loc': 'main', 'area': area, 'v': v})
    return head + '.' + base64.urlsafe_b64encode(hmac.new(secret.encode(), head.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
c, st = call(N, 'GET', '/api/staff/settings', jar=JN)
KDS = {'X-Kds': kds_token('Kitchen', st.get('kds_version') or '1')}
BADKDS = {'X-Kds': kds_token('Kitchen', 'stale')}
# GETs
for p in ['/api/staff/tabs', '/api/staff/area-load', '/api/staff/delivery-batches', '/api/kds/ingredients', '/api/kds/ingredients?area=Kitchen', '/api/kds/done-list']:
    same_get(p, JN, JG)
# prep: applyPars / prepSplit / prepRecipe come from other modules (house/table) and add fields there
HOOK_FIELDS = {'countedBy', 'forecast', 'onHand', 'split', 'target', 'par'}
for p in ['/api/kds/prep', '/api/kds/prep?area=Bar']:
    a, b = call(N, 'GET', p, jar=JN), call(G, 'GET', p, jar=JG)
    d = [x for x in diff(shape(a[1]), shape(b[1])) if not any(f'.{f} only in node' in x for f in HOOK_FIELDS)]
    check(f'{p}: status + shape (minus other modules\' hook fields)', a[0] == b[0] == 200 and not d, d)
same_get('/api/staff/delivery-batches', SN, SG, 'delivery batches as staff')
for p in ['/api/kds/ingredients', '/api/kds/prep', '/api/kds/done-list']:
    both('GET', p, None, None, None, label=p + ' signed out')
    both('GET', p, None, None, None, label=p + ' kds screen', headers=KDS)
    both('GET', p, None, None, None, label=p + ' stale kds token', headers=BADKDS)
a, b = call(N, 'GET', '/api/kds/prep', jar=JN), call(G, 'GET', '/api/kds/prep', jar=JG)
check('prep list same items', sorted((i['id'], i['avg'], i.get('forecast', i['prep'])) for i in a[1]['items']) == sorted((i['id'], i['avg'], i['prep']) for i in b[1]['items']) and a[1]['weeksOfData'] == b[1]['weeksOfData'], (a[1]['items'][:3], b[1]['items'][:3]))
check('prep list same ingredients', [(g['id'], g['need'], g['short']) for g in a[1]['ingredients']] == [(g['id'], g['need'], g['short']) for g in b[1]['ingredients']], (a[1]['ingredients'][:3], b[1]['ingredients'][:3]))
a, b = call(N, 'GET', '/api/staff/area-load', jar=JN), call(G, 'GET', '/api/staff/area-load', jar=JG)
check('area load identical', a == b, (a, b))
# ingredient 86
c, ings = call(N, 'GET', '/api/kds/ingredients', jar=JN)
gid = next((g['id'] for g in ings if not g['out']), None)
both('POST', '/api/kds/ingredient-86', {'ingredientId': 'x'}, label='86 bad body')
both('POST', '/api/kds/ingredient-86', {'ingredientId': 999999, 'out': True}, label='86 unknown')
if gid:
    both('POST', '/api/kds/ingredient-86', {'ingredientId': gid, 'out': True}, None, None, label='86 out (kds screen)', headers=KDS)
    a, b = both('GET', '/api/kds/ingredients', label='ingredients after 86')
    check('86 shows out', [g['out'] for g in a[1] if g['id'] == gid] == [g['out'] for g in b[1] if g['id'] == gid] == [True], (a, b))
    a, b = call(N, 'GET', '/api/staff/menu', jar=JN), call(G, 'GET', '/api/staff/menu', jar=JG)
    check('86 marks dishes out', sorted(m['id'] for m in a[1] if m.get('stock') == 0) == sorted(m['id'] for m in b[1] if m.get('stock') == 0))
    both('POST', '/api/kds/ingredient-86', {'ingredientId': gid, 'out': False}, label='86 back')
    a, b = call(N, 'GET', '/api/staff/menu', jar=JN), call(G, 'GET', '/api/staff/menu', jar=JG)
    check('back releases dishes', sorted(m['id'] for m in a[1] if m.get('stock') == 0) == sorted(m['id'] for m in b[1] if m.get('stock') == 0))
# served / make-good on a fresh order
both('PUT', '/api/staff/settings', {'makegood_pct': '15'} , label='set makegood pct', cmp_body=False)
both('POST', '/api/kds/served', {'orderId': 999999}, label='served unknown')
both('POST', '/api/kds/makegood', {'orderId': 1, 'kind': 'cake'}, label='makegood bad kind')
both('POST', '/api/staff/orders/999999/makegood', {'kind': 'item'}, label='makegood staff unknown')
both('POST', '/api/staff/orders/1/makegood', {'kind': 'item'}, SN, SG, label='makegood as staff')
res = {}
for base, jar, lab in [(N, JN, 'n'), (G, JG, 'g')]:
    c, menu = call(base, 'GET', '/api/staff/menu', jar=jar)
    item = next(m for m in sorted(menu, key=lambda m: m['id']) if m['active'] and (m.get('stock') is None or m['stock'] > 5) and not m.get('mods'))
    c, o = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 2}], 'customerName': 'CT run'}, jar=jar)
    oid = o.get('id')
    r = [call(base, 'POST', '/api/kds/makegood', {'orderId': oid, 'kind': 'discount'}, headers=KDS),
         call(base, 'POST', '/api/kds/makegood', {'orderId': oid, 'kind': 'discount'}, jar=jar),
         call(base, 'POST', f'/api/staff/orders/{oid}/makegood', {'kind': 'item'}, jar=jar),
         call(base, 'POST', '/api/kds/served', {'orderId': oid}, jar=jar)]
    c, ol = call(base, 'GET', '/api/staff/orders', jar=jar)
    oo = next((x for x in ol if x['id'] == oid), {}) if isinstance(ol, list) else {}
    res[lab] = (o.get('number') is not None, r, (oo.get('discount_cents'), oo.get('total_cents'), oo.get('order_notes')))
    call(base, 'POST', f'/api/staff/orders/{oid}/void', {'reason': 'contract test'}, jar=jar)
check('make-good + served flow identical', res['n'][1] == res['g'][1], (res['n'][1], res['g'][1]))
check('make-good totals identical', res['n'][2] == res['g'][2], (res['n'][2], res['g'][2]))
# delivery assign
both('POST', '/api/staff/delivery-batches/assign', {'orderIds': [], 'driverId': 1}, label='assign bad body')
both('POST', '/api/staff/delivery-batches/assign', {'orderIds': [1], 'driverId': 999999}, label='assign no driver')
# hooks from other modules (Node 500s too when missing; Go answers 500)
both('POST', '/api/kds/leftovers', {'lines': 'x'}, label='leftovers bad body')
both('POST', '/api/kds/prep-count', {'itemId': 'x'}, label='prep-count bad body')
both('POST', '/api/kds/allergy-handoff', {}, label='allergy-handoff bad body')
# bar tabs
c, tables = call(N, 'GET', '/api/staff/tables', jar=JN)
tok = next((t.get('qr_token') for t in tables if t.get('qr_token')), None) if isinstance(tables, list) else None
both('PUT', '/api/staff/settings', {'bar_tabs': '0'}, label='tabs off', cmp_body=False)
both('POST', f'/api/t/{tok or "AAAAAAAAAAAAAAAA"}/tab', {'name': 'Sam'}, None, None, label='open tab when off')
both('PUT', '/api/staff/settings', {'bar_tabs': '1'}, label='tabs on', cmp_body=False)
both('POST', '/api/t/AAAAAAAAAAAAAAAA/tab', {'name': 'Sam'}, None, None, label='open tab bad table')
both('GET', f'/api/t/{tok or "AAAAAAAAAAAAAAAA"}/tab/AAAAAAAAAAAAAAAA', None, None, None, label='tab unknown')
both('POST', '/api/staff/tabs/999999/close', {}, label='staff close unknown tab')
if tok:
    both('POST', f'/api/t/{tok}/tab', {'name': ''}, None, None, label='open tab bad body')
    a = call(N, 'POST', f'/api/t/{tok}/tab', {'name': 'Sam CT', 'phone': '555'}); b = call(G, 'POST', f'/api/t/{tok}/tab', {'name': 'Sam CT', 'phone': '555'})
    check('open tab', a[0] == b[0] == 200 and not diff(shape(a[1]), shape(b[1])), (a, b))
    tn, tg = a[1]['token'], b[1]['token']
    a, b = call(N, 'GET', f'/api/t/{tok}/tab/{tn}'), call(G, 'GET', f'/api/t/{tok}/tab/{tg}')
    check('tab view', a[0] == b[0] == 200 and {k: v for k, v in a[1].items() if k not in ('token', 'openedAt', 'code')} == {k: v for k, v in b[1].items() if k not in ('token', 'openedAt', 'code')}, (a, b))
    a, b = both('GET', '/api/staff/tabs', label='staff tabs list')
    a, b = call(N, 'POST', f'/api/t/{tok}/tab/{tn}/close', {}), call(G, 'POST', f'/api/t/{tok}/tab/{tg}/close', {})
    check('close empty tab', a == b, (a, b))
done()
