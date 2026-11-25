from contractlib import *
JN, JG = '/tmp/j5_n', '/tmp/j5_g'; SN, SG = '/tmp/j5_sn', '/tmp/j5_sg'
login(N, '8642', JN); login(G, '8642', JG); login(N, '5791', SN); login(G, '5791', SG)

def both(method, path, body=None, jn=JN, jg=JG):
    return call(N, method, path, body, jar=jn), call(G, method, path, body, jar=jg)
def pair(method, pn, pg, body=None, jn=JN, jg=JG):
    return call(N, method, pn, body, jar=jn), call(G, method, pg, body, jar=jg)
def same(label, a, b, exact=False):
    check(f'{label}: status {a[0]}', a[0] == b[0], (a, b))
    if a[0] == b[0] == 200 and isinstance(a[1], (dict, list)):
        if exact: check(f'{label}: same value', a[1] == b[1], (a[1], b[1]))
        else:
            d = diff(shape(a[1]), shape(b[1])); check(f'{label}: same shape', not d, d)
    elif a[0] >= 400: check(f'{label}: same error', a[1] == b[1], (a[1], b[1]))

gets = ['/api/staff/tables/1/seat/1/history', '/api/staff/tables/3/seat/1/history', '/api/staff/tables/2/seat/1/history', '/api/staff/tables/999/seat/1/history',
        '/api/staff/tables/1/seat/x/history', '/api/staff/allergy-handoffs', '/api/staff/allergy-handoffs?days=90', '/api/staff/table-combos', '/api/staff/me/driver-checkout',
        '/api/staff/me/driver-checkout?date=2026-11-21', '/api/staff/driver-checkouts', '/api/staff/driver-checkouts?date=2026-11-21', '/api/staff/customers/1/vip-card',
        '/api/staff/customers/2/vip-card', '/api/staff/customers/9999/vip-card']
for p in gets:
    same_get(p, JN, JG)
    same(f'{p} values', *both('GET', p), exact=True)
same_get('/api/staff/allergy-handoffs', SN, SG, 'allergy-handoffs as staff')

# allergy hand-off
same('handoff missing order', *both('POST', '/api/staff/orders/999999/allergy-handoff', {}))
a, b = both('GET', '/api/staff/orders?scope=paid')
noal = next((o['id'] for o in a[1] if not o.get('allergy_note')), None)
if noal: same('handoff no allergy', *both('POST', f'/api/staff/orders/{noal}/allergy-handoff', {}))
same('handoff', *both('POST', '/api/staff/orders/1823/allergy-handoff', {}, SN, SG), exact=True)
a, b = both('GET', '/api/staff/allergy-handoffs?days=90')
check('handoff recorded by name', [x for x in a[1] if x['allergy_handed_by']][:1] and [(x['number'], x['allergy_handed_by']) for x in a[1]] == [(x['number'], x['allergy_handed_by']) for x in b[1]], (a[1][:2], b[1][:2]))

# table combos
same('combo bad', *both('POST', '/api/staff/table-combos', {'name': '', 'tableIds': [1]}))
same('combo staff forbidden', *both('POST', '/api/staff/table-combos', {'name': 'X', 'tableIds': [1, 2]}, SN, SG))
a, b = both('POST', '/api/staff/table-combos', {'name': 'CT 5+6', 'tableIds': [5, 6]})
same('combo add', a, b)
check('combo out same (id aside)', {**a[1], 'id': 0} == {**b[1], 'id': 0}, (a[1], b[1]))
cn, cg = a[1]['id'], b[1]['id']
same('combos list', *both('GET', '/api/staff/table-combos'), exact=True)
same('booking combo missing booking', *both('PUT', '/api/staff/bookings/99999/combo', {'comboId': None}))
same('booking combo gone', *both('PUT', '/api/staff/bookings/1/combo', {'comboId': 99999}))
same('booking combo bad', *both('PUT', '/api/staff/bookings/1/combo', {}))
same('booking combo set', *pair('PUT', '/api/staff/bookings/1/combo', '/api/staff/bookings/1/combo', {'comboId': cn}) if cn == cg else (call(N, 'PUT', '/api/staff/bookings/1/combo', {'comboId': cn}, jar=JN), call(G, 'PUT', '/api/staff/bookings/1/combo', {'comboId': cg}, jar=JG)), exact=True)
same('booking combo clear', *both('PUT', '/api/staff/bookings/1/combo', {'comboId': None}), exact=True)
same('combo join missing', *both('POST', '/api/staff/table-combos/99999/join', {}))
same('combo join', *pair('POST', f'/api/staff/table-combos/{cn}/join', f'/api/staff/table-combos/{cg}/join', {}), exact=True)
same_get('/api/staff/tables', JN, JG, 'tables after join')
a, b = both('GET', '/api/staff/tables')
pick = lambda l: sorted((t['id'], t.get('joined_to'), t['status']) for t in (l if isinstance(l, list) else l.get('tables', [])))
check('tables same after join', pick(a[1]) == pick(b[1]), '')
same('combo delete', *pair('DELETE', f'/api/staff/table-combos/{cn}', f'/api/staff/table-combos/{cg}'), exact=True)
done()
