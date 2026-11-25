from contractlib import *
JN, JG = '/tmp/j1p_n', '/tmp/j1p_g'
login(N, '8642', JN); login(G, '8642', JG)
for p in ['/api/staff/payments/claims', '/api/staff/payments/providers', '/api/pay/AAAAAAAAAAAAAAAAAAAAAA', '/api/pay/short']:
    same_get(p, JN, JG)

def both(method, path, body=None, label=None):
    a = call(N, method, path, body, jar=JN); b = call(G, method, path, body, jar=JG)
    lab = label or f'{method} {path}'
    check(f'{lab}: status {a[0]}', a[0] == b[0], (a, b))
    if isinstance(a[1], dict) and 'error' in a[1]: check(f'{lab}: same error', a[1] == b[1], (a[1], b[1]))
    return a, b

both('POST', '/api/pay/AAAAAAAAAAAAAAAAAAAAAA/card', {}, 'card: bad token')
both('POST', '/api/pay/AAAAAAAAAAAAAAAAAAAAAA/claim', {'app': 'venmo', 'name': 'x'}, 'claim: bad token')
both('POST', '/api/staff/payments/999999/confirm', {}, 'confirm: unknown')
both('POST', '/api/staff/payments/999999/reject', {}, 'reject: unknown')
both('POST', '/api/staff/square/devices/code', {'name': 'Counter'}, 'square pair: not set up')

# turn on pay-to-handle apps so online payments work without a card processor
SET = {'pay_handles_enabled': '1', 'pay_cashapp': '$ctcafe', 'pay_venmo': '@ct-cafe', 'pay_zelle': 'pay@ct.example', 'pay_paypalme': ''}
c, before = call(N, 'GET', '/api/staff/settings', jar=JN)
OLD = {k: before.get(k, '') for k in SET}
res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = {}
    c, d = call(base, 'PUT', '/api/staff/settings', SET, jar=jar); check(f'{lab}: enable pay apps', c == 200, (c, d))
    c, d = call(base, 'GET', '/api/staff/payments/providers', jar=jar); r['providers'] = d
    c, menu = call(base, 'GET', '/api/staff/menu/full', jar=jar)
    item = next(m for m in menu if m['active'] and not m['groups'] and (m.get('stock') is None or m['stock'] > 5))
    c, o = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 2}], 'customerName': 'CT pay'}, jar=jar)
    c, link = call(base, 'POST', f'/api/staff/orders/{o["id"]}/paylink', {}, jar=jar)
    btok = link['link'].split('/p/')[1]
    r['tip_high'] = call(base, 'POST', f'/api/p/{btok}/checkout', {'tipCents': 999999})
    c, d = call(base, 'POST', f'/api/p/{btok}/checkout', {'tipCents': 100}); check(f'{lab}: phone checkout', c == 200 and '/pay/' in d.get('url', ''), (c, d))
    ptok = d['url'].split('/pay/')[1].split('?')[0]
    c, page = call(base, 'GET', f'/api/pay/{ptok}'); globals()[f'page_{lab}'] = page
    r['page'] = (c, page.get('status'), page.get('claimed'), page.get('lines'), [(m['app'], m['handle'], m['url']) for m in page.get('methods', [])], page.get('successUrl', '').endswith('?paid=1'))
    r['card'] = call(base, 'POST', f'/api/pay/{ptok}/card', {})
    r['paypal'] = call(base, 'POST', f'/api/pay/{ptok}/paypal', {})
    r['capture_bad'] = call(base, 'POST', f'/api/pay/{ptok}/paypal/capture', {'orderId': 'lower'})
    r['capture_mismatch'] = call(base, 'POST', f'/api/pay/{ptok}/paypal/capture', {'orderId': 'ABCDEFGHIJ12'})[0]
    c, d = call(base, 'POST', f'/api/pay/{ptok}/verify', {}); r['verify'] = (c, d.get('paid'), d.get('processing'))
    r['claim_bad'] = call(base, 'POST', f'/api/pay/{ptok}/claim', {'app': 'paypalme', 'name': 'Sam'})
    r['claim'] = call(base, 'POST', f'/api/pay/{ptok}/claim', {'app': 'venmo', 'name': 'Sam'})
    c, claims = call(base, 'GET', '/api/staff/payments/claims', jar=jar)
    cl = next(x for x in claims if x['claim_name'] == 'Sam' and x['claim_app'] == 'venmo')
    r['claim_row'] = {k: cl[k] for k in ('claim_app', 'claim_name', 'descr', 'kind', 'total_cents')}
    r['reject'] = call(base, 'POST', f'/api/staff/payments/{cl["id"]}/reject', {}, jar=jar)
    r['confirm_rejected'] = call(base, 'POST', f'/api/staff/payments/{cl["id"]}/confirm', {}, jar=jar)
    call(base, 'POST', f'/api/pay/{ptok}/claim', {'app': 'venmo', 'name': 'Sam'})
    r['confirm'] = call(base, 'POST', f'/api/staff/payments/{cl["id"]}/confirm', {}, jar=jar)
    c, d = call(base, 'GET', f'/api/pay/{ptok}'); r['page_after'] = (c, d.get('status'))
    c, d = call(base, 'GET', f'/api/p/{btok}'); r['bill_after'] = (c, d.get('status'), d.get('remainingCents'), d.get('tipCents'), [(p['label'], p['method']) for p in d.get('payments', [])])
    c, d = call(base, 'GET', '/api/staff/orders?scope=paid', jar=jar)
    od = next((x for x in d if x['id'] == o['id']), None) if isinstance(d, list) else None
    r['order_after'] = od and (od['status'], od.get('payment_method'), od.get('tip_cents'))
    r['verify_paid'] = call(base, 'POST', f'/api/pay/{ptok}/verify', {})[1].get('paid')
    r['claim_paid'] = call(base, 'POST', f'/api/pay/{ptok}/claim', {'app': 'venmo', 'name': 'Sam'})
    # online gift card bought by a pay app
    c, d = call(base, 'POST', '/api/public/gift/checkout', {'amountCents': 2500, 'name': 'Gift CT', 'email': 'gift@ct.example'})
    check(f'{lab}: gift checkout', c == 200 and '/pay/' in d.get('url', ''), (c, d))
    gtok = d['url'].split('/pay/')[1].split('?')[0]
    call(base, 'POST', f'/api/pay/{gtok}/claim', {'app': 'cashapp', 'name': 'Gina'})
    c, d = call(base, 'GET', f'/api/public/gift?paid={gtok}'); r['gift_awaiting'] = d.get('awaiting')
    c, claims = call(base, 'GET', '/api/staff/payments/claims', jar=jar)
    cl = next(x for x in claims if x['claim_name'] == 'Gina')
    r['gift_confirm'] = call(base, 'POST', f'/api/staff/payments/{cl["id"]}/confirm', {}, jar=jar)
    c, d = call(base, 'GET', f'/api/public/gift?paid={gtok}'); p = d.get('purchased') or {}
    r['gift_purchased'] = (sorted(p), p.get('amountCents'), p.get('name'))
    c, d = call(base, 'GET', '/api/staff/giftcards/check?code=' + p.get('code', 'x'), jar=jar); r['gift_card'] = (c, d.get('balance_cents'), d.get('name'))
    c, d = call(base, 'GET', '/api/staff/audit', jar=jar)
    rows = d if isinstance(d, list) else d.get('entries', d.get('audit', []))
    r['audit'] = sorted({(x.get('action'), x.get('detail')) for x in rows[:12] if x.get('action', '').startswith(('pay.', 'gift.online', 'bill.payment'))})
    call(base, 'PUT', '/api/staff/settings', OLD, jar=jar)
d = diff(shape(page_node), shape(page_go)); check('pay page same shape', not d, d)
for k in res['node']:
    check(f'flow {k} matches', res['node'][k] == res['go'][k], (res['node'][k], res['go'][k]))
done()
