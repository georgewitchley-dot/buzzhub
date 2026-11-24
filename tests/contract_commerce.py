from contractlib import *
JN, JG = '/tmp/j1_n', '/tmp/j1_g'
login(N, '8642', JN); login(G, '8642', JG)
IGNORE = {'calories'}  # added to the menu by another module (menu adjust hook) that isn't ported yet
def strip(v):
    if isinstance(v, dict): return {k: strip(x) for k, x in v.items() if k not in IGNORE}
    if isinstance(v, list): return [strip(x) for x in v]
    return v
_call = call
def call(*a, **k):
    c, d = _call(*a, **k); return c, strip(d)
def same_get(path, jar_n, jar_g, label=None):
    a, b = call(N, 'GET', path, jar=jar_n), call(G, 'GET', path, jar=jar_g)
    check(f'{label or path}: status {a[0]}', a[0] == b[0], (a[0], b[0], b[1] if b[0] >= 400 else ''))
    if a[0] == b[0] == 200:
        d = diff(shape(a[1]), shape(b[1])); check(f'{label or path}: same shape', not d, d)
    return a, b
def both(method, path, body=None, label=None, same_body=False, nb=None, gb=None):
    """Run the same call on both servers; compare status, error text and field shapes."""
    a = call(N, method, path if nb is None else nb, body, jar=JN); b = call(G, method, path if gb is None else gb, body, jar=JG)
    lab = label or f'{method} {path}'
    check(f'{lab}: status {a[0]}', a[0] == b[0], (a, b))
    if isinstance(a[1], dict) and 'error' in a[1]: check(f'{lab}: same error', a[1] == b[1], (a[1], b[1]))
    elif a[0] == b[0] == 200:
        d = diff(shape(a[1]), shape(b[1])); check(f'{lab}: same shape', not d, d)
        if same_body: check(f'{lab}: same body', a[1] == b[1], (a[1], b[1]))
    return a, b

for p in ['/api/staff/mods', '/api/staff/menu/full', '/api/staff/inventory', '/api/staff/giftcards', '/api/staff/giftcards/check?code=1234-0000-0000-0000',
          '/api/staff/payments/status', '/api/o/menu', '/api/public/gift', '/api/public/gift?code=1111-2222-3333-4444', '/api/p/AAAAAAAAAAAAAAAAAAAAAA',
          '/api/t/AAAAAAAAAAAAAAAA', '/api/staff/bills/999999/qr', '/api/staff/tables/999999/qr']:
    same_get(p, JN, JG)

# validation errors and refusals
both('POST', '/api/staff/mods', {'name': '', 'min_pick': 3, 'max_pick': 1, 'options': [], 'itemIds': []}, 'mods: bad input')
both('POST', '/api/staff/mods', {'name': 'Bad', 'min_pick': 2, 'max_pick': 1, 'options': [{'name': 'a', 'price_cents': 0}], 'itemIds': []}, 'mods: refine')
both('POST', '/api/staff/inventory/999999', {'mode': 'set', 'qty': 1}, 'inventory: missing item')
both('POST', '/api/staff/inventory/1', {'mode': 'nope'}, 'inventory: bad mode')
both('POST', '/api/staff/giftcards', {'amountCents': 50, 'method': 'cash'}, 'gift: too small')
both('POST', '/api/staff/giftcards', {'amountCents': 500, 'method': 'cash', 'email': 'not-an-email'}, 'gift: bad email')
both('POST', '/api/staff/orders/999999/gift', {'code': '1'}, 'gift redeem: no order')
both('POST', '/api/staff/bills', {}, 'bills: nothing chosen')
both('POST', '/api/staff/mods', {'name': 'x', 'min_pick': 'a', 'max_pick': 1, 'options': [{'name': 'a', 'price_cents': 0}], 'itemIds': []}, 'mods: wrong type')
both('POST', '/api/staff/bills/999999/payments', {'method': 'cash'}, 'bill payment: unknown bill')
both('POST', '/api/public/gift/checkout', {'amountCents': 2000, 'name': 'A', 'email': 'a@b.co'}, 'public gift checkout off')
both('POST', '/api/p/AAAAAAAAAAAAAAAAAAAAAA/checkout', {}, 'phone checkout: bad token')
both('POST', '/api/o/checkout', {'items': []}, 'online checkout')
both('POST', '/api/t/AAAAAAAAAAAAAAAA/order', {'items': []}, 'table order: bad token')
both('POST', '/api/t/AAAAAAAAAAAAAAAA/help', {'reason': 'water'}, 'table help: bad token')
both('POST', '/api/staff/orders/999999/paylink', {}, 'paylink: no order')
for base in (N, G):
    c, d = call(base, 'POST', '/api/stripe/webhook', {'type': 'x'}, csrf=False)
    check(f'{base}: stripe webhook off -> 404', c == 404, (c, d))
    c, d = call(base, 'POST', '/api/square/webhook', {'type': 'x'}, csrf=False)
    check(f'{base}: square webhook off -> 404', c == 404, (c, d))

# write flows, run on each server
res = {}
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    r = res[lab] = {}
    c, menu = call(base, 'GET', '/api/staff/menu/full', jar=jar)
    item = next(m for m in menu if m['active'] and not m['groups'] and (m.get('stock') is None or m['stock'] > 5))
    # options group
    c, d = call(base, 'POST', '/api/staff/mods', {'name': 'CT Size', 'min_pick': 0, 'max_pick': 1, 'options': [{'name': 'Big', 'price_cents': 100}], 'itemIds': []}, jar=jar)
    check(f'{lab}: add options', c == 200 and d.get('id'), (c, d)); gid = d['id']
    c, d = call(base, 'PUT', f'/api/staff/mods/{gid}', {'name': 'CT Size2', 'min_pick': 0, 'max_pick': 1, 'options': [{'name': 'Big', 'price_cents': 150}, {'name': 'Small', 'price_cents': 0}], 'itemIds': []}, jar=jar)
    r['mods_put'] = (c, d)
    c, mods = call(base, 'GET', '/api/staff/mods', jar=jar)
    g = next(x for x in mods if x['id'] == gid); r['group'] = {k: g[k] for k in ('name', 'min_pick', 'max_pick')} | {'options': [(o['name'], o['price_cents']) for o in g['options']]}
    r['mods_del'] = call(base, 'DELETE', f'/api/staff/mods/{gid}', jar=jar)
    # inventory
    r['inv_set'] = call(base, 'POST', f'/api/staff/inventory/{item["id"]}', {'mode': 'set', 'qty': 40, 'lowStock': 3, 'reason': 'CT count'}, jar=jar)
    r['inv_add'] = call(base, 'POST', f'/api/staff/inventory/{item["id"]}', {'mode': 'add', 'qty': 5}, jar=jar)
    c, inv = call(base, 'GET', '/api/staff/inventory', jar=jar)
    r['inv_move'] = {k: inv['moves'][0][k] for k in ('delta', 'reason', 'item', 'user')}
    r['inv_untrack'] = call(base, 'POST', f'/api/staff/inventory/{item["id"]}', {'mode': 'untrack'}, jar=jar)
    # gift card: sell, check, redeem on an order, disable
    c, d = call(base, 'POST', '/api/staff/giftcards', {'amountCents': 1000, 'method': 'cash', 'name': 'CT'}, jar=jar)
    check(f'{lab}: sell gift card', c == 200 and d.get('code'), (c, d)); code = d['code']; r['sell_keys'] = sorted(d)
    c, d = call(base, 'GET', '/api/staff/giftcards/check?code=' + code.replace('-', ''), jar=jar)
    r['check'] = (c, {k: d.get(k) for k in ('balance_cents', 'initial_cents', 'status', 'name')})
    c, d = call(base, 'GET', '/api/public/gift?code=' + code)
    r['public_balance'] = d.get('balance')
    c, o = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 1}], 'customerName': 'CT gift'}, jar=jar)
    check(f'{lab}: order for gift', c == 200, (c, o)); oid = o['id']
    c, d = call(base, 'POST', f'/api/staff/orders/{oid}/gift', {'code': code}, jar=jar)
    r['redeem'] = (c, sorted(d), d.get('paid'))
    c, cards = call(base, 'GET', '/api/staff/giftcards', jar=jar)
    card = next(x for x in cards['cards'] if x['code'] == code)
    r['disable'] = call(base, 'POST', f'/api/staff/giftcards/{card["id"]}/disable', {}, jar=jar)
    r['redeem_disabled'] = call(base, 'POST', f'/api/staff/orders/{oid}/gift', {'code': code}, jar=jar)
    # bill with split payments
    c, o = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 3}], 'customerName': 'CT bill'}, jar=jar)
    oid = o['id']
    c, bill = call(base, 'POST', '/api/staff/bills', {'orderId': oid}, jar=jar); r['bill_keys'] = sorted(bill)
    check(f'{lab}: open bill', c == 200 and bill.get('token'), (c, bill)); bid, tok = bill['id'], bill['token']
    c, d = call(base, 'GET', f'/api/staff/bills/{bid}/qr', jar=jar); r['qr'] = (c, sorted(d), d.get('svg', '').startswith('<svg'))
    r['pay_bad_even'] = call(base, 'POST', f'/api/staff/bills/{bid}/payments', {'method': 'cash', 'split': 'even'}, jar=jar)
    r['pay_bad_items'] = call(base, 'POST', f'/api/staff/bills/{bid}/payments', {'method': 'cash', 'split': 'items', 'itemIds': [999999]}, jar=jar)
    c, d = call(base, 'POST', f'/api/staff/bills/{bid}/payments', {'method': 'cash', 'split': 'even', 'ways': 2, 'tipCents': 100}, jar=jar)
    r['pay1'] = (c, d.get('paidCents') == d.get('dueCents') - d.get('remainingCents', 0) if c == 200 else d, d.get('payments') and d['payments'][0]['label'])
    c, d = call(base, 'POST', f'/api/staff/bills/{bid}/payments', {'method': 'card'}, jar=jar)
    r['pay2'] = (c, d.get('status'), d.get('remainingCents'), [p['label'] for p in d.get('payments', [])])
    r['pay3'] = call(base, 'POST', f'/api/staff/bills/{bid}/payments', {'method': 'card'}, jar=jar)
    c, d = call(base, 'GET', f'/api/p/{tok}'); r['phone_view'] = (c, d.get('status'), d.get('remainingCents'))
    r['phone_checkout'] = call(base, 'POST', f'/api/p/{tok}/checkout', {})
    c, orders = call(base, 'GET', '/api/staff/orders?scope=paid', jar=jar)
    # paylink for an open order
    c, o = call(base, 'POST', '/api/staff/orders', {'items': [{'itemId': item['id'], 'qty': 1}], 'customerName': 'CT link'}, jar=jar)
    c, d = call(base, 'POST', f'/api/staff/orders/{o["id"]}/paylink', {'notify': True}, jar=jar)
    r['paylink'] = (c, sorted(d), d.get('pushed'), d.get('cardsEnabled'))
    c, d = call(base, 'GET', f'/api/p/{d["link"].split("/p/")[1]}'); r['paylink_view'] = (c, len(d.get('items', [])), d.get('numbers') == [o['number']])
    c, d = call(base, 'POST', f'/api/p/{d["token"]}/checkout', {'split': 'even'}); r['paylink_checkout'] = (c, d)
    # table QR ordering
    c, tables = call(base, 'GET', '/api/staff/tables', jar=jar)
    t = tables[0] if isinstance(tables, list) else tables['tables'][0]
    c, d = call(base, 'GET', f'/api/staff/tables/{t["id"]}/qr', jar=jar); r['tqr'] = (c, sorted(d))
    ttok = d['link'].split('/t/')[1]
    c, d = call(base, 'GET', f'/api/t/{ttok}'); r['tview'] = (c, sorted(d)); globals()[f'tview_{lab}'] = d
    r['torder'] = call(base, 'POST', f'/api/t/{ttok}/order', {'items': [{'itemId': item['id'], 'qty': 1}], 'name': 'CT'})
    c, d = call(base, 'POST', f'/api/t/{ttok}/bill', {}); r['tbill'] = (c, sorted(d))
    r['thelp'] = call(base, 'POST', f'/api/t/{ttok}/help', {'reason': 'water'})
    r['thelp_bad'] = call(base, 'POST', f'/api/t/{ttok}/help', {'reason': 'pizza'})
    c, d = call(base, 'POST', '/api/o/checkout', {'items': [{'itemId': item['id'], 'qty': 1}], 'fulfillment': 'pickup', 'name': 'CT', 'phone': '555-123-4567', 'payNow': False})
    r['online'] = (c, sorted(d) if c == 200 else d)
    r['online_bad'] = call(base, 'POST', '/api/o/checkout', {'items': [{'itemId': item['id'], 'qty': 1}], 'fulfillment': 'delivery', 'name': 'CT', 'phone': 'abc', 'payNow': True})
    r['gconfirm'] = call(base, 'GET', '/api/g/AAAAAAAAAAAAAAAAAAAAAAAA/confirm')
    globals()[f'inv_{lab}'] = inv

d = diff(shape(tview_node), shape(tview_go)); check('table page same shape', not d, d)
d = diff(shape(inv_node), shape(inv_go)); check('inventory same shape', not d, d)
for k in res['node']:
    check(f'flow {k} matches', res['node'][k] == res['go'][k], (res['node'][k], res['go'][k]))
done()
