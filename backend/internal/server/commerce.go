package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of commerce.js: menu options, inventory, gift cards, bills with split payments, Stripe
// Checkout + webhook, online ordering (pickup/delivery) and table QR ordering. The order builder
// (priceLines, insertOrder, ...) lives in orders.go.

func init() { modules = append(modules, (*App).registerCommerce) }

/* ======================================================================
   Stripe (REST, no SDK)
   ====================================================================== */

func commerceStripeKey() string     { return os.Getenv("STRIPE_SECRET_KEY") }
func commerceWebhookSecret() string { return os.Getenv("STRIPE_WEBHOOK_SECRET") }

var commerceStripeKeyRE = regexp.MustCompile(`^sk_(live|test)_`)

func commerceStripeEnabled() bool { return commerceStripeKeyRE.MatchString(commerceStripeKey()) }

func commerceStripeStatus() M {
	k := commerceStripeKey()
	var mode any
	if strings.HasPrefix(k, "sk_live_") {
		mode = "live"
	} else if k != "" {
		mode = "test"
	}
	return M{"cardsEnabled": commerceStripeEnabled(), "webhook": commerceWebhookSecret() != "", "mode": mode}
}

var commerceHTTP = &http.Client{Timeout: 30 * time.Second}

// commerceStripe calls the Stripe REST API with a form body (nil for GET).
func commerceStripe(ctx context.Context, method, path string, form url.Values) (M, error) {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://api.stripe.com/v1"+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+commerceStripeKey())
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.Header.Set("Stripe-Version", "2024-06-20")
	r, err := commerceHTTP.Do(req)
	if err != nil {
		return nil, fail(http.StatusBadGateway, "Couldn't reach the card processor. Please try again or pay your server.")
	}
	defer r.Body.Close()
	var data M
	_ = json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&data)
	if r.StatusCode < 200 || r.StatusCode > 299 {
		msg := "Card payments are not available right now"
		if e, ok := data["error"].(M); ok && str(e["message"]) != "" {
			msg = str(e["message"])
		}
		return nil, fail(http.StatusBadGateway, msg)
	}
	return data, nil
}

/* ---------- small helpers ---------- */

// commerceNum is JavaScript's Number(setting): missing -> NaN (null), "" -> 0.
func commerceNum(s map[string]string, key string) any {
	v, ok := s[key]
	if !ok {
		return nil
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return float64(0)
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return nil
	}
	return f
}

func commerceLogo(c *C) any {
	s := c.S()
	if s["logo_version"] != "0" {
		return fmt.Sprintf("/api/public/logo?l=%s&v=%s", c.Slug(), s["logo_version"])
	}
	return nil
}

// commerceLQ is "?l=slug" outside the main location.
func commerceLQ(c *C) string {
	if c.Slug() == "main" {
		return ""
	}
	return "?l=" + c.Slug()
}

// commerceLAmp is "l=slug&" outside the main location (Node's `l`).
func commerceLAmp(c *C) string {
	if c.Slug() == "main" {
		return ""
	}
	return "l=" + c.Slug() + "&"
}

// commerceParse validates the body against several schemas (zod's a.and(b)), joining their errors.
func commerceParse(c *C, schemas ...*valid.ObjectS) (valid.M, error) {
	raw := c.Raw()
	out := valid.M{}
	errs := []string{}
	for _, s := range schemas {
		m, err := valid.Obj(s, raw)
		if err != nil {
			errs = append(errs, err.Error())
			continue
		}
		for k, v := range m {
			out[k] = v
		}
	}
	if len(errs) > 0 {
		return nil, bad(strings.Join(errs, "; "))
	}
	return out, nil
}

func commerceBodyField(c *C, k string) any {
	if m, ok := c.Raw().(map[string]any); ok {
		return m[k]
	}
	return nil
}

func commerceJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func commerceInts(v any) []int64 {
	out := []int64{}
	if arr, ok := v.([]any); ok {
		for _, x := range arr {
			out = append(out, i64(x))
		}
	}
	return out
}

func commerceUID(c *C) any {
	if c.U != nil {
		return c.U.ID
	}
	return nil
}

// commerceIn runs fn in another location (runIn), reusing this request when it is the same one.
func commerceIn(c *C, loc string, fn func(c *C) error) error {
	if loc == c.Slug() {
		return fn(c)
	}
	return c.a.db.In(c.Ctx, loc, func(tx *store.Tx) error {
		return fn(&C{a: c.a, Tx: tx, Ctx: c.Ctx, R: c.R, W: newBuf()})
	})
}

type commerceCachedBody struct {
	data []byte
	r    *strings.Reader
}

func (b *commerceCachedBody) Read(p []byte) (int, error) { return b.r.Read(p) }
func (b *commerceCachedBody) Close() error               { return nil }

// commerceRawBody is express.raw({type: 'application/json', limit: '1mb'}): the body as text, or ""
// for other content types. Cached on the request so a retried transaction sees it again.
func commerceRawBody(c *C) string {
	if cb, ok := c.R.Body.(*commerceCachedBody); ok {
		return string(cb.data)
	}
	mt, _, _ := mime.ParseMediaType(c.R.Header.Get("Content-Type"))
	if mt != "application/json" || c.R.Body == nil {
		return ""
	}
	b, _ := io.ReadAll(io.LimitReader(c.R.Body, 1<<20))
	c.R.Body = &commerceCachedBody{data: b, r: strings.NewReader("")}
	return string(b)
}

func commerceText(c *C, status int, text string) error {
	if text == "" {
		c.W.WriteHeader(status)
		return nil
	}
	c.W.Header().Set("Content-Type", "text/html; charset=utf-8")
	c.W.WriteHeader(status)
	_, _ = c.W.Write([]byte(text))
	return nil
}

/* ---------- gift codes ---------- */

func commerceNewGiftCode(c *C) (string, error) {
	for {
		parts := make([]string, 4)
		for i := range parts {
			var b [2]byte
			_, _ = rand.Read(b[:])
			parts[i] = fmt.Sprintf("%04d", binary.BigEndian.Uint16(b[:])%10000)
		}
		code := strings.Join(parts, "-")
		hit, err := c.One(`SELECT 1 FROM gift_cards WHERE code = ?`, code)
		if err != nil {
			return "", err
		}
		if hit == nil {
			return code, nil
		}
	}
}

// commerceNormCode keeps the digits and puts a dash after every 4 that are followed by another.
func commerceNormCode(v any) string {
	var d []byte
	for _, ch := range []byte(str(v)) {
		if ch >= '0' && ch <= '9' {
			d = append(d, ch)
		}
	}
	var b strings.Builder
	for i, ch := range d {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteByte(ch)
	}
	return b.String()
}

type commerceCard struct {
	ID   int64
	Code string
}

func (c *C) commerceIssueCard(cents int64, name, email any, source string, userID any, method string) (commerceCard, error) {
	code, err := commerceNewGiftCode(c)
	if err != nil {
		return commerceCard{}, err
	}
	res, err := c.Run(`INSERT INTO gift_cards (code, initial_cents, balance_cents, name, email, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`, code, cents, cents, orNil(name), orNil(email), source, orNil(userID))
	if err != nil {
		return commerceCard{}, err
	}
	if _, err := c.Run(`INSERT INTO gift_txns (card_id, delta_cents, method, user_id) VALUES (?, ?, ?, ?)`, res.LastID, cents, method, orNil(userID)); err != nil {
		return commerceCard{}, err
	}
	return commerceCard{res.LastID, code}, nil
}

func (c *C) commerceEmailCard(code, email string, cents int64) {
	s := c.S()
	if email == "" || !emailEnabled() {
		return
	}
	link := c.a.cfg.PublicURL + "/gift" + commerceLQ(c)
	msg := emailMsg{BusinessName: s["business_name"], Subject: "Your gift card", Message: fmt.Sprintf("Here's your %s gift card for $%s. Code: %s. Show this code when you pay.", s["business_name"], dollars(cents), code), Link: link, Accent: s["accent"]}
	c.Tx.AfterCommit(func() { go func() { _, _ = emailGuest(email, msg) }() })
}

// commerceRedeem takes a gift card off an order (inside the request's transaction).
func (c *C) commerceRedeem(o store.Row, code any, userID any, needDue bool) (int64, int64, error) {
	card, err := c.One(`SELECT * FROM gift_cards WHERE code = ? AND status = 'active'`, commerceNormCode(code))
	if err != nil {
		return 0, 0, err
	}
	if card == nil {
		return 0, 0, notFound("That gift card code is not valid")
	}
	if i64(card["balance_cents"]) <= 0 {
		return 0, 0, conflict("That gift card is empty")
	}
	if _, err := c.G("giftUsable", card); err != nil {
		return 0, 0, err
	}
	use := i64(card["balance_cents"])
	if d := dueOf(o); d < use {
		use = d
	}
	if needDue && use <= 0 {
		return 0, 0, conflict("Nothing left to pay on this order")
	}
	if _, err := c.Run(`UPDATE gift_cards SET balance_cents = balance_cents - ? WHERE id = ?`, use, card["id"]); err != nil {
		return 0, 0, err
	}
	if _, err := c.Run(`INSERT INTO gift_txns (card_id, delta_cents, order_id, method, user_id) VALUES (?, ?, ?, ?, ?)`, card["id"], -use, o["id"], "redeem", orNil(userID)); err != nil {
		return 0, 0, err
	}
	if _, err := c.Run(`UPDATE orders SET gift_cents = gift_cents + ? WHERE id = ?`, use, o["id"]); err != nil {
		return 0, 0, err
	}
	return use, i64(card["balance_cents"]) - use, nil
}

// commerceCloseIfCovered marks the order paid by gift card when nothing is owed. Returns what's left.
func (c *C) commerceCloseIfCovered(id any) (int64, error) {
	after, err := c.Get(`SELECT * FROM orders WHERE id = ?`, id)
	if err != nil {
		return 0, err
	}
	remaining := dueOf(after)
	if remaining <= 0 {
		total := i64(after["subtotal_cents"]) - i64(after["discount_cents"]) + i64(after["tax_cents"]) + i64(after["fee_cents"])
		if _, err := c.Run(`UPDATE orders SET status='paid', payment_method='gift', paid_at=?, total_cents=? WHERE id=?`, store.Now(), total, id); err != nil {
			return 0, err
		}
	}
	return remaining, nil
}

/* ======================================================================
   Bills and split payments
   ====================================================================== */

func (c *C) commerceBillOrders(bill store.Row) ([]store.Row, error) {
	if truthy(bill["table_id"]) && str(bill["status"]) == "open" {
		rows, err := c.All(`SELECT id FROM orders WHERE table_id = ? AND status IN ('open','sent','ready','held') AND prepaid = 0 AND tab_id IS NULL`, bill["table_id"])
		if err != nil {
			return nil, err
		}
		for _, o := range rows {
			if _, err := c.Run(`INSERT OR IGNORE INTO bill_orders (bill_id, order_id) VALUES (?, ?)`, bill["id"], o["id"]); err != nil {
				return nil, err
			}
		}
	}
	return c.All(`SELECT o.* FROM orders o JOIN bill_orders bo ON bo.order_id = o.id WHERE bo.bill_id = ? AND o.status <> 'void' ORDER BY o.id`, bill["id"])
}

func commerceIDs(v any) []any {
	var arr []any
	_ = json.Unmarshal([]byte(str(v)), &arr)
	return arr
}

func (c *C) commerceBillSummary(bill store.Row) (M, error) {
	s := c.S()
	orders, err := c.commerceBillOrders(bill)
	if err != nil {
		return nil, err
	}
	items := []store.Row{}
	if len(orders) > 0 {
		ph := make([]string, len(orders))
		args := make([]any, len(orders))
		for i, o := range orders {
			ph[i], args[i] = "?", o["id"]
		}
		if items, err = c.All(`SELECT id, order_id, name, qty, price_cents, mods FROM order_items WHERE order_id IN (`+strings.Join(ph, ",")+`) ORDER BY id`, args...); err != nil {
			return nil, err
		}
	}
	var due, subtotal, discount, tax, fee, gift int64
	numbers := []any{}
	for _, o := range orders {
		due += dueOf(o)
		subtotal += i64(o["subtotal_cents"])
		discount += i64(o["discount_cents"])
		tax += i64(o["tax_cents"])
		fee += i64(o["fee_cents"])
		gift += i64(o["gift_cents"])
		numbers = append(numbers, o["number"])
	}
	pays, err := c.All(`SELECT * FROM payments WHERE bill_id = ? AND (status = 'paid' OR (status = 'pending' AND created_at > datetime('now','-30 minutes'))) ORDER BY id`, bill["id"])
	if err != nil {
		return nil, err
	}
	claimed, paidItems := map[int64]bool{}, map[int64]bool{}
	var paidCents, tips int64
	payments := []M{}
	for _, p := range pays {
		ids := commerceIDs(p["items"])
		for _, id := range ids {
			claimed[i64(id)] = true
		}
		if str(p["status"]) == "paid" {
			paidCents += i64(p["amount_cents"])
			tips += i64(p["tip_cents"])
			for _, id := range ids {
				paidItems[i64(id)] = true
			}
			payments = append(payments, M{"label": p["label"], "method": p["method"], "amountCents": p["amount_cents"], "tipCents": p["tip_cents"]})
		}
	}
	sub := subtotal
	if sub == 0 {
		sub = 1
	}
	ratio := float64(due) / float64(sub)
	outItems := []M{}
	for _, i := range items {
		id := i64(i["id"])
		line := i64(i["qty"]) * i64(i["price_cents"])
		outItems = append(outItems, M{"id": i["id"], "name": i["name"], "qty": i["qty"], "mods": jparse(i["mods"], []any{}), "lineCents": line, "shareCents": roundJS(float64(line) * ratio), "paid": paidItems[id], "claimed": claimed[id] && !paidItems[id]})
	}
	var table any
	if truthy(bill["table_id"]) {
		t, err := c.One(`SELECT label FROM tables WHERE id = ?`, bill["table_id"])
		if err != nil {
			return nil, err
		}
		if t != nil {
			table = orNil(t["label"])
		}
	}
	remaining := due - paidCents
	if remaining < 0 {
		remaining = 0
	}
	return M{
		"token": bill["token"], "status": bill["status"], "table": table, "numbers": numbers, "currency": s["currency"],
		"items": outItems, "subtotalCents": subtotal, "discountCents": discount, "taxCents": tax, "feeCents": fee, "giftCents": gift,
		"dueCents": due, "paidCents": paidCents, "remainingCents": remaining, "tipCents": tips, "payments": payments,
		"business":     M{"name": s["business_name"], "accent": s["accent"], "unitLabel": s["unit_label"], "slug": c.Slug(), "logo": commerceLogo(c)},
		"cardsEnabled": c.paymentsOnlinePayEnabled(),
	}, nil
}

// commerceSettleBill closes a covered bill's orders (prepaid ones keep cooking until served/picked up).
func (c *C) commerceSettleBill(bill store.Row) (bool, error) {
	sum, err := c.commerceBillSummary(bill)
	if err != nil {
		return false, err
	}
	if i64(sum["dueCents"]) <= 0 || i64(sum["paidCents"]) < i64(sum["dueCents"]) || str(bill["status"]) != "open" {
		return false, nil
	}
	orders, err := c.commerceBillOrders(bill)
	if err != nil {
		return false, err
	}
	pays, err := c.All(`SELECT * FROM payments WHERE bill_id = ? AND status = 'paid' ORDER BY id`, bill["id"])
	if err != nil {
		return false, err
	}
	methods := map[string]bool{}
	method := ""
	var tips int64
	for _, p := range pays {
		if !methods[str(p["method"])] {
			methods[str(p["method"])] = true
			method = str(p["method"])
		}
		tips += i64(p["tip_cents"])
	}
	if len(methods) != 1 {
		method = "split"
	}
	t := store.Now()
	for i, o := range orders {
		tip := int64(0)
		if i == 0 {
			tip = tips
		}
		total := i64(o["subtotal_cents"]) - i64(o["discount_cents"]) + i64(o["tax_cents"]) + i64(o["fee_cents"]) + tip
		st := str(o["status"])
		if st == "ready" || (st == "open" && str(o["source"]) == "staff") {
			_, err = c.Run(`UPDATE orders SET status='paid', tip_cents=?, total_cents=?, payment_method=?, paid_at=? WHERE id=?`, tip, total, method, t, o["id"])
		} else {
			_, err = c.Run(`UPDATE orders SET status = CASE WHEN status = 'held' AND source = 'online' AND scheduled_for IS NULL THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, ?), prepaid=1, tip_cents=?, total_cents=?, payment_method=?, paid_at=? WHERE id=?`, t, tip, total, method, t, o["id"])
		}
		if err != nil {
			return false, err
		}
	}
	if _, err := c.Run(`UPDATE bills SET status='paid', closed_at=? WHERE id=?`, t, bill["id"]); err != nil {
		return false, err
	}
	nums := []string{}
	for _, o := range orders {
		if truthy(o["guest_id"]) {
			if err := c.pushGuest(i64(o["guest_id"])); err != nil {
				return false, err
			}
		}
		nums = append(nums, str(o["number"]))
	}
	c.Emit("staff", "paid:phone", M{"number": strings.Join(nums, ", #"), "totalCents": i64(sum["dueCents"]) + tips})
	c.Notify("orders")
	c.Notify("tables")
	return true, nil
}

func (c *C) commerceBillFor(orderID, tableID any) (store.Row, error) {
	if truthy(tableID) {
		b, err := c.One(`SELECT * FROM bills WHERE table_id = ? AND status = 'open' ORDER BY id DESC`, tableID)
		if err != nil || b != nil {
			return b, err
		}
		if _, err := c.Run(`INSERT INTO bills (token, table_id) VALUES (?, ?)`, newToken(16), tableID); err != nil {
			return nil, err
		}
		return c.Get(`SELECT * FROM bills WHERE table_id = ? AND status = 'open' ORDER BY id DESC`, tableID)
	}
	b, err := c.One(`SELECT b.* FROM bills b JOIN bill_orders bo ON bo.bill_id = b.id WHERE bo.order_id = ? AND b.status = 'open' AND b.table_id IS NULL`, orderID)
	if err != nil || b != nil {
		return b, err
	}
	res, err := c.Run(`INSERT INTO bills (token) VALUES (?)`, newToken(16))
	if err != nil {
		return nil, err
	}
	if _, err := c.Run(`INSERT INTO bill_orders (bill_id, order_id) VALUES (?, ?)`, res.LastID, orderID); err != nil {
		return nil, err
	}
	return c.Get(`SELECT * FROM bills WHERE id = ?`, res.LastID)
}

// commerceShareAmount: the whole remainder, an even split, or the chosen items.
func commerceShareAmount(sum M, b map[string]any) (int64, error) {
	remaining := i64(sum["remainingCents"])
	switch str(b["split"]) {
	case "even":
		ways := i64(b["ways"])
		if ways == 0 {
			return remaining, nil
		}
		n := int64(math.Ceil(float64(i64(sum["dueCents"])) / float64(ways)))
		if n < remaining {
			return n, nil
		}
		return remaining, nil
	case "items":
		want := commerceInts(b["itemIds"])
		items, _ := sum["items"].([]M)
		var total int64
		n := 0
		for _, it := range items {
			id := i64(it["id"])
			has := false
			for _, w := range want {
				if w == id {
					has = true
					break
				}
			}
			if has && !truthy(it["paid"]) && !truthy(it["claimed"]) {
				n++
				total += i64(it["shareCents"])
			}
		}
		if n != len(want) {
			return 0, conflict("Someone already paid for one of those items. Refresh and choose again.")
		}
		if total < remaining {
			return total, nil
		}
		return remaining, nil
	}
	return remaining, nil
}

var commerceShareSchema = valid.Ordered(
	"split", valid.Enum("full", "even", "items").Default("full"),
	"ways", valid.Int().Min(2).Max(20).Optional(),
	"itemIds", valid.Array(valid.Int()).Max(200).Optional(),
	"tipCents", valid.Int().Min(0).Max(1_000_000).Default(0),
).Refine(func(b valid.M) bool {
	_, ok := b["ways"]
	return str(b["split"]) != "even" || (ok && i64(b["ways"]) != 0)
}, "Pick how many ways to split").
	Refine(func(b valid.M) bool {
		ids, _ := b["itemIds"].([]any)
		return str(b["split"]) != "items" || len(ids) > 0
	}, "Pick your items")

var commerceBillTokenRE = regexp.MustCompile(`^[A-Za-z0-9_-]{20,30}$`)

func (c *C) commerceBillByToken(t string) (store.Row, error) {
	if !commerceBillTokenRE.MatchString(t) {
		return nil, nil
	}
	return c.One(`SELECT * FROM bills WHERE token = ?`, t)
}

var commerceSessRE = regexp.MustCompile(`^cs_(test|live)_[A-Za-z0-9]+$`)

func (c *C) commerceConfirmSession(sid string) error {
	if !commerceStripeEnabled() || !commerceSessRE.MatchString(sid) {
		return nil
	}
	p, err := c.One(`SELECT * FROM payments WHERE stripe_session = ?`, sid)
	if err != nil || p == nil || str(p["status"]) == "paid" {
		return err
	}
	sess, err := commerceStripe(c.Ctx, "GET", "/checkout/sessions/"+sid, nil)
	if err != nil {
		return nil
	}
	md, _ := sess["metadata"].(M)
	if str(sess["payment_status"]) == "paid" && str(md["payment_id"]) == str(p["id"]) {
		return c.commerceCompletePayment(p, str(sess["id"]))
	}
	return nil
}

// commerceCompletePayment marks a payment paid and does what its kind needs (bill, gift card, hooks).
func (c *C) commerceCompletePayment(p store.Row, sessionID string) error {
	r, err := c.Run(`UPDATE payments SET status='paid', paid_at=?, stripe_session=? WHERE id=? AND status <> 'paid'`, store.Now(), sessionID, p["id"])
	if err != nil || r.Changes == 0 {
		return err
	}
	kind := str(p["kind"])
	if kind == "deposit" {
		_, err := c.G("onDepositPaid", p, sessionID)
		return err
	}
	if c.Has("payHooks." + kind) {
		fresh, err := c.Get(`SELECT * FROM payments WHERE id = ?`, p["id"])
		if err != nil {
			return err
		}
		_, err = c.G("payHooks."+kind, fresh)
		return err
	}
	if kind == "giftcard" {
		meta, _ := jparse(p["meta"], M{}).(M)
		if meta == nil {
			meta = M{}
		}
		cents := i64(p["amount_cents"])
		card, err := c.commerceIssueCard(cents, meta["name"], meta["email"], "online", nil, "card")
		if err != nil {
			return err
		}
		meta["code"], meta["amountCents"] = card.Code, cents
		if _, err := c.Run(`UPDATE payments SET meta = ? WHERE id = ?`, commerceJSON(meta), p["id"]); err != nil {
			return err
		}
		if err := c.AuditAs(nil, "gift.online", fmt.Sprintf("$%s for %s", dollars(cents), str(meta["name"])), ""); err != nil {
			return err
		}
		c.commerceEmailCard(card.Code, str(meta["email"]), cents)
		_, err = c.G("giftBonus", M{"cents": cents, "name": meta["name"], "email": meta["email"]})
		return err
	}
	bill, err := c.One(`SELECT * FROM bills WHERE id = ?`, p["bill_id"])
	if err != nil {
		return err
	}
	tip := ""
	if i64(p["tip_cents"]) > 0 {
		tip = " + tip " + dollars(i64(p["tip_cents"]))
	}
	if err := c.AuditAs(nil, "bill.payment", fmt.Sprintf("phone %s %s%s", str(p["label"]), dollars(i64(p["amount_cents"])), tip), ""); err != nil {
		return err
	}
	if bill != nil {
		if _, err := c.commerceSettleBill(bill); err != nil {
			return err
		}
	}
	c.Notify("orders")
	return nil
}

/* ======================================================================
   Online ordering
   ====================================================================== */

func (c *C) commerceRushLevel() (string, error) {
	if !c.Has("rushState") {
		return "", nil
	}
	r, err := c.G("rushState")
	if err != nil {
		return "", err
	}
	if m, ok := r.(M); ok {
		return str(m["level"]), nil
	}
	if m, ok := r.(store.Row); ok {
		return str(m["level"]), nil
	}
	return "", nil
}

func (c *C) commerceOnlineInfo() (M, error) {
	s := c.S()
	load, err := c.N(`SELECT COUNT(*) c FROM orders WHERE status IN ('sent','open')`)
	if err != nil {
		return nil, err
	}
	level, err := c.commerceRushLevel()
	if err != nil {
		return nil, err
	}
	var ready any
	switch {
	case c.Has("slotQuote"):
		if ready, err = c.G("slotQuote"); err != nil {
			return nil, err
		}
	case c.Has("quoteMinutes"):
		q, err := c.G("quoteMinutes")
		if err != nil {
			return nil, err
		}
		if m, ok := q.(M); ok {
			ready = m["minutes"]
		}
	default:
		prep := commerceNum(s, "online_prep_minutes")
		if prep == nil {
			ready = nil
		} else {
			ready = prep.(float64) + math.Min(30, float64(load*2))
		}
	}
	payOn := c.paymentsOnlinePayEnabled()
	days := commerceNum(s, "online_schedule_days")
	if f, ok := days.(float64); !ok || f == 0 {
		days = float64(7)
	}
	return M{
		"enabled": s["online_enabled"] == "1" && level != "paused", "paused": s["online_enabled"] == "1" && level == "paused", "busy": level == "busy",
		"pickup": s["online_pickup"] == "1", "delivery": s["online_delivery"] == "1",
		"deliveryFeeCents": commerceNum(s, "delivery_fee_cents"), "deliveryMinCents": commerceNum(s, "delivery_min_cents"), "deliveryArea": s["delivery_area"],
		"readyInMinutes": ready, "payOnline": payOn, "payAtPickup": s["online_pay_later"] == "1" || !payOn,
		"taxRate": commerceNum(s, "tax_rate"), "currency": s["currency"], "tableOrdering": s["table_ordering"] == "1", "schedule": s["online_schedule"] == "1",
		"scheduleDays": days, "prepMinutes": commerceNum(s, "online_prep_minutes"),
		"business": M{"name": s["business_name"], "accent": s["accent"], "type": s["business_type"], "unitLabel": s["unit_label"], "slug": c.Slug(), "logo": commerceLogo(c)},
	}, nil
}

func (c *C) commerceCleanMenu() ([]M, error) {
	items, err := c.menuWithMods("")
	if err != nil {
		return nil, err
	}
	out := make([]M, 0, len(items))
	for _, m := range items {
		n := M{}
		for k, v := range m {
			switch k {
			case "stock", "low_stock", "guest_orderable", "active":
			default:
				n[k] = v
			}
		}
		out = append(out, n)
	}
	return out, nil
}

var commerceTableTokRE = regexp.MustCompile(`^[A-Za-z0-9_-]{16}$`)

func (c *C) commerceTableByToken(t string) (store.Row, error) {
	if !commerceTableTokRE.MatchString(t) {
		return nil, nil
	}
	return c.One(`SELECT * FROM tables WHERE qr_token = ?`, t)
}

func commerceRow(v any) M {
	switch x := v.(type) {
	case M:
		return x
	}
	return nil
}

/* ======================================================================
   Routes
   ====================================================================== */

var commerceGroupSchema = valid.Ordered(
	"name", valid.String().Trim().Min(1).Max(40),
	"min_pick", valid.Int().Min(0).Max(10),
	"max_pick", valid.Int().Min(1).Max(20),
	"options", valid.Array(valid.Ordered("name", valid.String().Trim().Min(1).Max(40), "price_cents", valid.Int().Min(-100000).Max(100000))).Min(1).Max(30),
	"itemIds", valid.Array(valid.Int()).Max(500),
).Refine(func(g valid.M) bool {
	opts, _ := g["options"].([]any)
	return i64(g["min_pick"]) <= i64(g["max_pick"]) && i64(g["min_pick"]) <= int64(len(opts))
}, "The minimum must be no more than the maximum and the number of options")

func (c *C) commerceSaveGroup(id int64, g valid.M) (int64, error) {
	if id > 0 {
		if _, err := c.Run(`UPDATE mod_groups SET name=?, min_pick=?, max_pick=? WHERE id=?`, g["name"], g["min_pick"], g["max_pick"], id); err != nil {
			return 0, err
		}
	} else {
		res, err := c.Run(`INSERT INTO mod_groups (name, min_pick, max_pick) VALUES (?, ?, ?)`, g["name"], g["min_pick"], g["max_pick"])
		if err != nil {
			return 0, err
		}
		id = res.LastID
	}
	if _, err := c.Run(`DELETE FROM mod_options WHERE group_id = ?`, id); err != nil {
		return 0, err
	}
	opts, _ := g["options"].([]any)
	for i, o := range opts {
		om := o.(valid.M)
		if _, err := c.Run(`INSERT INTO mod_options (group_id, name, price_cents, sort) VALUES (?, ?, ?, ?)`, id, om["name"], om["price_cents"], i); err != nil {
			return 0, err
		}
	}
	if _, err := c.Run(`DELETE FROM item_mod_groups WHERE group_id = ?`, id); err != nil {
		return 0, err
	}
	for _, it := range commerceInts(g["itemIds"]) {
		if _, err := c.Run(`INSERT OR IGNORE INTO item_mod_groups (item_id, group_id) VALUES (?, ?)`, it, id); err != nil {
			return 0, err
		}
	}
	return id, nil
}

var commerceEmailOpt = valid.String().Trim().Email().Max(120).Optional().Or(valid.Literal(""))

func (a *App) registerCommerce(rt *router) {
	a.orders.stock = func(c *C, kind string, m store.Row) {
		s := c.S()
		name := str(m["name"])
		detail := fmt.Sprintf("%s is running low: %d left", name, i64(m["stock"]))
		title := s["business_name"] + ": low stock"
		body := fmt.Sprintf("%s: only %d left.", name, i64(m["stock"]))
		if kind == "out" {
			detail = name + " just sold out and was turned off"
			title = s["business_name"] + ": sold out"
			body = name + " sold out and was taken off the menu."
		}
		c.Emit("staff", "security", M{"type": "stock", "detail": detail})
		a.pushToUsers(c.Ctx, c.Tx, []string{"owner", "manager"}, M{"title": title, "body": body, "tag": fmt.Sprintf("stock-%d", i64(m["id"])), "url": "/inventory"}, 0)
		c.Notify("menu")
	}

	/* ---------- hooks for other modules (Node's G/h names) ---------- */
	a.G["stripe"] = func(c *C, args ...any) (any, error) {
		var form url.Values
		if len(args) > 2 {
			switch f := args[2].(type) {
			case url.Values:
				form = f
			case map[string]string:
				form = url.Values{}
				for k, v := range f {
					form.Set(k, v)
				}
			case M:
				form = url.Values{}
				for k, v := range f {
					form.Set(k, str(v))
				}
			}
		}
		return commerceStripe(c.Ctx, str(args[0]), str(args[1]), form)
	}
	a.G["stripeEnabled"] = func(c *C, args ...any) (any, error) { return commerceStripeEnabled(), nil }
	a.G["stripeStatus"] = func(c *C, args ...any) (any, error) { return commerceStripeStatus(), nil }
	// issueCard({cents, name, email, source, userId, method}) -> {id, code}
	a.G["issueCard"] = func(c *C, args ...any) (any, error) {
		o := commerceRow(args[0])
		card, err := c.commerceIssueCard(i64(o["cents"]), o["name"], o["email"], str(o["source"]), o["userId"], str(o["method"]))
		if err != nil {
			return nil, err
		}
		return M{"id": card.ID, "code": card.Code}, nil
	}
	// applyGift(order, code, user) -> nil when nothing is owed, else {used, balance}
	a.G["applyGift"] = func(c *C, args ...any) (any, error) {
		o := store.Row(commerceRow(args[0]))
		if dueOf(o) <= 0 {
			return nil, nil
		}
		var uid any
		if len(args) > 2 {
			if u, ok := args[2].(*auth.User); ok && u != nil {
				uid = u.ID
			}
		}
		used, bal, err := c.commerceRedeem(o, args[1], uid, false)
		if err != nil {
			return nil, err
		}
		if _, err := c.commerceCloseIfCovered(o["id"]); err != nil {
			return nil, err
		}
		return M{"used": used, "balance": bal}, nil
	}
	a.G["settleBill"] = func(c *C, args ...any) (any, error) { return c.commerceSettleBill(store.Row(commerceRow(args[0]))) }
	a.G["billSummary"] = func(c *C, args ...any) (any, error) { return c.commerceBillSummary(store.Row(commerceRow(args[0]))) }
	// billFor({orderId, tableId}) -> bill row
	a.G["billFor"] = func(c *C, args ...any) (any, error) {
		o := commerceRow(args[0])
		return c.commerceBillFor(o["orderId"], o["tableId"])
	}
	a.G["shareAmount"] = func(c *C, args ...any) (any, error) {
		return commerceShareAmount(commerceRow(args[0]), commerceRow(args[1]))
	}
	// shareSchema() returns the *valid.ObjectS (combine with commerceParse-style validation).
	a.G["shareSchema"] = func(c *C, args ...any) (any, error) { return commerceShareSchema, nil }
	a.G["completePayment"] = func(c *C, args ...any) (any, error) {
		ref := ""
		if len(args) > 1 {
			ref = str(args[1])
		}
		return nil, c.commerceCompletePayment(store.Row(commerceRow(args[0])), ref)
	}

	/* ================= Menu options (modifiers) ================= */
	rt.staff("GET /mods", "staff", func(c *C) error {
		groups, err := c.All(`SELECT * FROM mod_groups ORDER BY sort, id`)
		if err != nil {
			return err
		}
		opts, err := c.All(`SELECT * FROM mod_options ORDER BY sort, id`)
		if err != nil {
			return err
		}
		links, err := c.All(`SELECT * FROM item_mod_groups`)
		if err != nil {
			return err
		}
		out := []M{}
		for _, g := range groups {
			o := M(g)
			go2 := []store.Row{}
			for _, x := range opts {
				if i64(x["group_id"]) == i64(g["id"]) {
					go2 = append(go2, x)
				}
			}
			ids := []any{}
			for _, l := range links {
				if i64(l["group_id"]) == i64(g["id"]) {
					ids = append(ids, l["item_id"])
				}
			}
			o["options"], o["itemIds"] = go2, ids
			out = append(out, o)
		}
		return c.JSON(out)
	})
	rt.staff("POST /mods", "manager", func(c *C) error {
		g, err := c.Body(commerceGroupSchema)
		if err != nil {
			return err
		}
		id, err := c.commerceSaveGroup(0, g)
		if err != nil {
			return err
		}
		if err := c.Audit("menu.options_add", str(g["name"])); err != nil {
			return err
		}
		c.Notify("menu")
		return c.JSON(M{"id": id})
	})
	rt.staff("PUT /mods/{id}", "manager", func(c *C) error {
		g, err := c.Body(commerceGroupSchema)
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.commerceSaveGroup(id, g); err != nil {
			return err
		}
		if err := c.Audit("menu.options_edit", str(g["name"])); err != nil {
			return err
		}
		c.Notify("menu")
		return c.OK()
	})
	rt.staff("DELETE /mods/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM item_mod_groups WHERE group_id=?`, id); err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM mod_groups WHERE id=?`, id); err != nil {
			return err
		}
		c.Notify("menu")
		return c.OK()
	})
	rt.staff("GET /menu/full", "staff", func(c *C) error {
		m, err := c.menuWithMods("1=1")
		if err != nil {
			return err
		}
		return c.JSON(m)
	})

	/* ================= Inventory ================= */
	rt.staff("GET /inventory", "staff", func(c *C) error {
		items, err := c.All(`SELECT id, name, category, stock, low_stock, active FROM menu_items ORDER BY category, sort, id`)
		if err != nil {
			return err
		}
		sold, err := c.All(`SELECT oi.item_id, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status <> 'void' AND o.created_at > datetime('now','-7 days') GROUP BY oi.item_id`)
		if err != nil {
			return err
		}
		sold7 := map[int64]int64{}
		for _, r := range sold {
			sold7[i64(r["item_id"])] = i64(r["q"])
		}
		moves, err := c.All(`SELECT m.*, i.name item, u.name AS "user" FROM stock_moves m JOIN menu_items i ON i.id = m.item_id LEFT JOIN users u ON u.id = m.user_id ORDER BY m.id DESC LIMIT 60`)
		if err != nil {
			return err
		}
		out := []M{}
		for _, i := range items {
			o := M(i)
			q := sold7[i64(i["id"])]
			o["sold7"] = q
			var left any
			if i["stock"] != nil && q != 0 {
				left = int64(math.Floor(float64(i64(i["stock"])) / (float64(q) / 7)))
			}
			o["daysLeft"] = left
			out = append(out, o)
		}
		return c.JSON(M{"items": out, "moves": moves})
	})
	invSchema := valid.Ordered(
		"mode", valid.Enum("set", "add", "untrack"),
		"qty", valid.Int().Min(-100000).Max(100000).Optional(),
		"lowStock", valid.Int().Min(0).Max(100000).Optional(),
		"reason", valid.String().Trim().Max(60).Optional(),
	)
	rt.staff("POST /inventory/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		b, err := c.Body(invSchema)
		if err != nil {
			return err
		}
		m, err := c.One(`SELECT * FROM menu_items WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if m == nil {
			return notFound("Not found")
		}
		var stock any = m["stock"]
		switch str(b["mode"]) {
		case "untrack":
			stock = nil
		case "set":
			stock = i64(b["qty"])
		default:
			stock = i64(m["stock"]) + i64(b["qty"])
		}
		var low any
		if v, ok := b["lowStock"]; ok {
			low = v
		}
		if _, err := c.Run(`UPDATE menu_items SET stock = ?, low_stock = COALESCE(?, low_stock), active = CASE WHEN ? > 0 AND stock IS NOT NULL AND stock <= 0 THEN 1 ELSE active END WHERE id = ?`, stock, low, i64(stock), id); err != nil {
			return err
		}
		if stock != nil && i64(stock) > 0 && m["stock"] != nil && i64(m["stock"]) <= 0 {
			if _, err := c.Run(`UPDATE menu_items SET active = 1 WHERE id = ?`, id); err != nil {
				return err
			}
		}
		if str(b["mode"]) != "untrack" {
			reason := str(b["reason"])
			if reason == "" {
				reason = "delivery"
				if str(b["mode"]) == "set" {
					reason = "count"
				}
			}
			if _, err := c.Run(`INSERT INTO stock_moves (item_id, delta, reason, user_id) VALUES (?, ?, ?, ?)`, id, i64(stock)-i64(m["stock"]), reason, c.U.ID); err != nil {
				return err
			}
		}
		show := func(v any) string {
			if v == nil {
				return "untracked"
			}
			return str(v)
		}
		if err := c.Audit("inventory.update", fmt.Sprintf("%s: %s → %s", str(m["name"]), show(m["stock"]), show(stock))); err != nil {
			return err
		}
		c.Notify("menu")
		return c.JSON(M{"ok": true, "stock": stock})
	})

	/* ================= Gift cards ================= */
	rt.staff("GET /giftcards", "manager", func(c *C) error {
		cards, err := c.All(`SELECT * FROM gift_cards ORDER BY id DESC LIMIT 200`)
		if err != nil {
			return err
		}
		out, err := c.Val(`SELECT COALESCE(SUM(balance_cents),0) c FROM gift_cards WHERE status = 'active'`)
		if err != nil {
			return err
		}
		return c.JSON(M{"cards": cards, "outstandingCents": i64(out)})
	})
	sellSchema := valid.Ordered(
		"amountCents", valid.Int().Min(100).Max(100000),
		"method", valid.Enum("cash", "card", "other", "comp"),
		"name", valid.String().Trim().Max(40).Optional(),
		"email", commerceEmailOpt,
	)
	rt.staff("POST /giftcards", "staff", func(c *C) error {
		b, err := c.Body(sellSchema)
		if err != nil {
			return err
		}
		method := str(b["method"])
		if method == "comp" && c.U.Role != "manager" && c.U.Role != "owner" {
			return forbidden("Only a manager can give a free gift card")
		}
		cents := i64(b["amountCents"])
		card, err := c.commerceIssueCard(cents, b["name"], b["email"], "staff", c.U.ID, method)
		if err != nil {
			return err
		}
		var bonus any
		if method != "comp" {
			if bonus, err = c.G("giftBonus", M{"cents": cents, "name": b["name"], "email": b["email"], "userId": c.U.ID}); err != nil {
				return err
			}
		}
		last4 := card.Code[len(card.Code)-4:]
		if method == "cash" {
			cs, err := c.One(`SELECT id FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1`)
			if err != nil {
				return err
			}
			if cs != nil {
				if _, err := c.Run(`INSERT INTO cash_moves (session_id, kind, amount_cents, reason, user_id) VALUES (?, 'in', ?, ?, ?)`, cs["id"], cents, "Gift card "+last4, c.U.ID); err != nil {
					return err
				}
			}
		}
		c.commerceEmailCard(card.Code, str(b["email"]), cents)
		if err := c.Audit("gift.sell", fmt.Sprintf("$%s %s …%s", dollars(cents), method, last4)); err != nil {
			return err
		}
		c.Notify("cash")
		return c.JSON(M{"ok": true, "code": card.Code, "bonus": bonus})
	})
	rt.staff("GET /giftcards/check", "staff", func(c *C) error {
		card, err := c.One(`SELECT code, balance_cents, initial_cents, status, name FROM gift_cards WHERE code = ?`, commerceNormCode(c.Q("code")))
		if err != nil {
			return err
		}
		if card == nil {
			return notFound("No gift card with that code")
		}
		return c.JSON(card)
	})
	rt.staff("POST /giftcards/{id}/disable", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE gift_cards SET status = 'disabled' WHERE id = ?`, id); err != nil {
			return err
		}
		if err := c.Audit("gift.disable", "#"+c.Param("id")); err != nil {
			return err
		}
		return c.OK()
	})
	codeSchema := valid.Object(map[string]valid.Schema{"code": valid.String().Max(30)})
	rt.staff("POST /orders/{id}/gift", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if o == nil || str(o["status"]) == "paid" || str(o["status"]) == "void" || truthy(o["prepaid"]) {
			return conflict("This order is already closed")
		}
		b, err := c.Body(codeSchema)
		if err != nil {
			return err
		}
		used, bal, err := c.commerceRedeem(o, b["code"], c.U.ID, true)
		if err != nil {
			return err
		}
		remaining, err := c.commerceCloseIfCovered(o["id"])
		if err != nil {
			return err
		}
		if err := c.Audit("gift.redeem", fmt.Sprintf("#%s $%s", str(o["number"]), dollars(used))); err != nil {
			return err
		}
		c.Notify("orders")
		left := remaining
		if left < 0 {
			left = 0
		}
		return c.JSON(M{"ok": true, "usedCents": used, "cardBalanceCents": bal, "remainingCents": left, "paid": remaining <= 0})
	})

	// public: buy online + check balance
	rt.pub("GET /api/public/gift", func(c *C) error {
		s := c.S()
		out := M{"business": M{"name": s["business_name"], "accent": s["accent"], "logo": commerceLogo(c), "slug": c.Slug()}, "cardsEnabled": c.paymentsOnlinePayEnabled(), "currency": s["currency"]}
		if c.Q("code") != "" {
			card, err := c.One(`SELECT balance_cents, status FROM gift_cards WHERE code = ?`, commerceNormCode(c.Q("code")))
			if err != nil {
				return err
			}
			if card != nil && str(card["status"]) == "active" {
				out["balance"] = card["balance_cents"]
			} else {
				out["balance"] = nil
			}
		}
		if tok := c.Q("paid"); commerceBillTokenRE.MatchString(tok) {
			p, err := c.One(`SELECT * FROM payments WHERE kind = 'giftcard' AND pay_token = ?`, tok)
			if err != nil {
				return err
			}
			if p != nil && str(p["status"]) == "paid" {
				out["purchased"] = jparse(p["meta"], M{})
			} else if p != nil && truthy(p["claimed_at"]) {
				out["awaiting"] = true
			}
		}
		return c.JSON(out)
	}, a.publicLim())
	giftBuy := valid.Ordered(
		"amountCents", valid.Int().Min(1000).Max(50000),
		"name", valid.String().Trim().Min(1).Max(40),
		"email", valid.String().Trim().Email().Max(120),
	)
	rt.pub("POST /api/public/gift/checkout", func(c *C) error {
		if !c.paymentsOnlinePayEnabled() {
			return fail(http.StatusServiceUnavailable, "Online gift cards are not available yet.")
		}
		b, err := c.Body(giftBuy)
		if err != nil {
			return err
		}
		s := c.S()
		base := c.PublicBase()
		l := commerceLAmp(c)
		res, err := c.Run(`INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('giftcard', ?, 'card', ?, ?)`, b["amountCents"], "Gift card for "+str(b["name"]), commerceJSON(M{"name": b["name"], "email": b["email"]}))
		if err != nil {
			return err
		}
		cancel := base + "/gift"
		if l != "" {
			cancel += "?" + l[:len(l)-1]
		}
		u, err := c.paymentsStartPay(res.LastID, paymentsStart{Base: base, Lines: []M{{"name": s["business_name"] + " gift card", "cents": b["amountCents"]}}, SuccessURL: base + "/gift?" + l + "paid={TOKEN}", CancelURL: cancel, Email: str(b["email"]), Descr: "Gift card"})
		if err != nil {
			return err
		}
		return c.JSON(M{"url": u})
	}, a.publicLim())

	/* ================= Bills and split payments ================= */
	billSchema := valid.Object(map[string]valid.Schema{"orderId": valid.Int().Optional(), "tableId": valid.Int().Optional()})
	rt.staff("POST /bills", "staff", func(c *C) error {
		b, err := c.Body(billSchema)
		if err != nil {
			return err
		}
		if !truthy(b["orderId"]) && !truthy(b["tableId"]) {
			return bad("Choose an order or a table")
		}
		bill, err := c.commerceBillFor(b["orderId"], b["tableId"])
		if err != nil {
			return err
		}
		sum, err := c.commerceBillSummary(bill)
		if err != nil {
			return err
		}
		sum["id"], sum["link"] = bill["id"], c.PublicBase()+"/p/"+str(bill["token"])
		return c.JSON(sum)
	})
	rt.staff("GET /bills/{id}/qr", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		bill, err := c.One(`SELECT * FROM bills WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if bill == nil {
			return notFound("Not found")
		}
		link := c.PublicBase() + "/p/" + str(bill["token"])
		svg, err := qrSVG(link, 1, "", "", false)
		if err != nil {
			return err
		}
		sum, err := c.commerceBillSummary(bill)
		if err != nil {
			return err
		}
		sum["link"], sum["svg"] = link, svg
		return c.JSON(sum)
	})
	payExtra := valid.Ordered("method", valid.Enum("cash", "card", "other"), "label", valid.String().Trim().Max(30).Optional())
	rt.staff("POST /bills/{id}/payments", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		bill, err := c.One(`SELECT * FROM bills WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if bill == nil || str(bill["status"]) != "open" {
			return conflict("This check is already settled")
		}
		b, err := commerceParse(c, commerceShareSchema, payExtra)
		if err != nil {
			return err
		}
		sum, err := c.commerceBillSummary(bill)
		if err != nil {
			return err
		}
		if i64(sum["remainingCents"]) <= 0 {
			return conflict("Nothing left to pay")
		}
		amount, err := commerceShareAmount(sum, b)
		if err != nil {
			return err
		}
		label := str(b["label"])
		if label == "" {
			switch str(b["split"]) {
			case "even":
				label = fmt.Sprintf("1 of %d", i64(b["ways"]))
			case "items":
				label = "Own items"
			default:
				label = "Payment"
			}
		}
		items, ok := b["itemIds"].([]any)
		if !ok {
			items = []any{}
		}
		tip := i64(b["tipCents"])
		if _, err := c.Run(`INSERT INTO payments (bill_id, amount_cents, tip_cents, method, status, label, items, user_id, paid_at) VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?)`,
			bill["id"], amount, tip, b["method"], label, commerceJSON(items), c.U.ID, store.Now()); err != nil {
			return err
		}
		nums := []string{}
		for _, n := range sum["numbers"].([]any) {
			nums = append(nums, "#"+str(n))
		}
		tipText := ""
		if tip > 0 {
			tipText = " + tip " + dollars(tip)
		}
		if err := c.Audit("bill.payment", fmt.Sprintf("check %s %s %s%s", strings.Join(nums, " "), str(b["method"]), dollars(amount), tipText)); err != nil {
			return err
		}
		if _, err := c.commerceSettleBill(bill); err != nil {
			return err
		}
		c.Notify("orders")
		fresh, err := c.Get(`SELECT * FROM bills WHERE id = ?`, bill["id"])
		if err != nil {
			return err
		}
		out, err := c.commerceBillSummary(fresh)
		if err != nil {
			return err
		}
		return c.JSON(out)
	})

	// phone: see the check and pay a share
	rt.pub("GET /api/p/{token}", func(c *C) error {
		bill, err := c.commerceBillByToken(c.Param("token"))
		if err != nil {
			return err
		}
		if bill == nil {
			return notFound("This check link is not valid.")
		}
		if err := c.commerceConfirmSession(c.Q("session_id")); err != nil {
			return err
		}
		fresh, err := c.Get(`SELECT * FROM bills WHERE id = ?`, bill["id"])
		if err != nil {
			return err
		}
		out, err := c.commerceBillSummary(fresh)
		if err != nil {
			return err
		}
		return c.JSON(out)
	}, a.publicLim())
	rt.pub("POST /api/p/{token}/checkout", func(c *C) error {
		bill, err := c.commerceBillByToken(c.Param("token"))
		if err != nil {
			return err
		}
		if bill == nil {
			return notFound("This check link is not valid.")
		}
		if str(bill["status"]) != "open" {
			return conflict("This check is already paid. Thank you!")
		}
		if !c.paymentsOnlinePayEnabled() {
			return fail(http.StatusServiceUnavailable, "Paying by phone is not set up yet. Please pay your server.")
		}
		b, err := c.Body(commerceShareSchema)
		if err != nil {
			return err
		}
		sum, err := c.commerceBillSummary(bill)
		if err != nil {
			return err
		}
		if i64(sum["remainingCents"]) <= 0 {
			return conflict("This check is already paid. Thank you!")
		}
		amount, err := commerceShareAmount(sum, b)
		if err != nil {
			return err
		}
		tip := i64(b["tipCents"])
		if float64(tip) > math.Max(float64(amount), 2000)*2 {
			return bad("That tip looks too high")
		}
		split := str(b["split"])
		label := "Full check"
		if split == "even" {
			label = fmt.Sprintf("1 of %d", i64(b["ways"]))
		} else if split == "items" {
			label = "Own items"
		}
		items, ok := b["itemIds"].([]any)
		if !ok {
			items = []any{}
		}
		res, err := c.Run(`INSERT INTO payments (bill_id, amount_cents, tip_cents, method, label, items) VALUES (?, ?, ?, 'card', ?, ?)`, bill["id"], amount, tip, label, commerceJSON(items))
		if err != nil {
			return err
		}
		s := c.S()
		base := c.PublicBase()
		nums := []string{}
		for _, n := range sum["numbers"].([]any) {
			nums = append(nums, str(n))
		}
		table := str(sum["table"])
		where := "order #" + strings.Join(nums, ", #")
		descr := where
		if table != "" {
			where = strings.ToLower(s["unit_label"]) + " " + table
			descr = s["unit_label"] + " " + table
		}
		name := s["business_name"] + ", " + where
		if split != "full" {
			name += " (" + label + ")"
		}
		lines := []M{{"name": name, "cents": amount}}
		if tip > 0 {
			lines = append(lines, M{"name": "Tip", "cents": tip})
		}
		u, err := c.paymentsStartPay(res.LastID, paymentsStart{Base: base, Lines: lines, SuccessURL: base + "/p/" + str(bill["token"]) + "?paid=1", CancelURL: base + "/p/" + str(bill["token"]), Descr: descr})
		if err != nil {
			return err
		}
		return c.JSON(M{"url": u})
	}, a.publicLim())

	// staff: "let them pay by phone" for one order (creates the bill and its QR)
	rt.staff("POST /orders/{id}/paylink", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if o == nil || str(o["status"]) == "paid" || str(o["status"]) == "void" {
			return conflict("This order is already closed")
		}
		var bill store.Row
		if truthy(o["table_id"]) && truthy(commerceBodyField(c, "wholeTable")) {
			bill, err = c.commerceBillFor(nil, o["table_id"])
		} else {
			bill, err = c.commerceBillFor(o["id"], nil)
		}
		if err != nil {
			return err
		}
		link := c.PublicBase() + "/p/" + str(bill["token"])
		pushed := 0
		if truthy(commerceBodyField(c, "notify")) && truthy(o["guest_id"]) {
			pushed = a.pushToGuest(c.Ctx, c.Tx, i64(o["guest_id"]), M{"title": c.S()["business_name"] + ": your check", "body": "Your check is ready. Tap to pay from your phone, split it if you like.", "tag": "check", "url": "/p/" + str(bill["token"])}).Sent
		}
		sent := ""
		if pushed > 0 {
			sent = " sent to guest phone"
		}
		if err := c.Audit("order.paylink", fmt.Sprintf("#%s%s", str(o["number"]), sent)); err != nil {
			return err
		}
		svg, err := qrSVG(link, 1, "", "", false)
		if err != nil {
			return err
		}
		return c.JSON(M{"link": link, "svg": svg, "pushed": pushed, "cardsEnabled": c.paymentsOnlinePayEnabled(), "billId": bill["id"]})
	})

	// Stripe webhook: completes bill and gift card payments even if the guest closes the page
	rt.pub("POST /api/stripe/webhook", func(c *C) error {
		secret := commerceWebhookSecret()
		if secret == "" {
			return commerceText(c, http.StatusNotFound, "")
		}
		parts := map[string]string{}
		has := map[string]bool{}
		for _, p := range strings.Split(c.R.Header.Get("Stripe-Signature"), ",") {
			kv := strings.Split(p, "=")
			if len(kv) > 1 {
				parts[kv[0]], has[kv[0]] = kv[1], true
			} else {
				parts[kv[0]], has[kv[0]] = "undefined", false
			}
		}
		payload := commerceRawBody(c)
		t := parts["t"]
		if _, ok := parts["t"]; !ok {
			t = "undefined"
		}
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(t + "." + payload))
		expected := hex.EncodeToString(mac.Sum(nil))
		v1 := parts["v1"]
		ok := has["v1"] && v1 != "" && len(v1) == len(expected) && subtle.ConstantTimeCompare([]byte(v1), []byte(expected)) == 1
		ts, terr := strconv.ParseFloat(strings.TrimSpace(t), 64)
		stale := terr == nil && math.Abs(float64(time.Now().UnixMilli())/1000-ts) > 300
		if !ok || stale {
			return commerceText(c, http.StatusBadRequest, "bad signature")
		}
		var event M
		if json.Unmarshal([]byte(payload), &event) != nil {
			return commerceText(c, http.StatusBadRequest, "")
		}
		typ := str(event["type"])
		data, _ := event["data"].(M)
		obj, _ := data["object"].(M)
		md, _ := obj["metadata"].(M)
		loc := str(md["loc"])
		if loc == "" {
			loc = "main"
		}
		exists := obj != nil && a.db.LocationExists(c.Ctx, loc)
		if typ == "payment_intent.succeeded" && exists {
			if err := commerceIn(c, loc, func(c *C) error { _, err := c.G("onIntentSucceeded", obj); return err }); err != nil {
				return err
			}
		}
		if (typ == "checkout.session.async_payment_succeeded" || typ == "checkout.session.async_payment_failed") && exists {
			if err := commerceIn(c, loc, func(c *C) error {
				p, err := c.One(`SELECT * FROM payments WHERE id = ?`, i64(md["payment_id"]))
				if err != nil || p == nil {
					return err
				}
				if strings.HasSuffix(typ, "succeeded") {
					var ref any
					if truthy(obj["payment_intent"]) {
						ref = "stripe:" + str(obj["payment_intent"])
					}
					if _, err := c.Run(`UPDATE payments SET bank_status = 'cleared', refund_ref = COALESCE(refund_ref, ?) WHERE id = ?`, ref, p["id"]); err != nil {
						return err
					}
					return c.commerceCompletePayment(p, str(obj["id"]))
				}
				_, err = c.G("bankFailed", p)
				return err
			}); err != nil {
				return err
			}
		}
		if typ == "checkout.session.completed" && str(obj["payment_status"]) == "paid" && exists {
			if err := commerceIn(c, loc, func(c *C) error {
				p, err := c.One(`SELECT * FROM payments WHERE id = ?`, i64(md["payment_id"]))
				if err != nil || p == nil {
					return err
				}
				return c.commerceCompletePayment(p, str(obj["id"]))
			}); err != nil {
				return err
			}
		}
		return c.JSON(M{"received": true})
	})

	/* ================= Online ordering (pickup / delivery) ================= */
	rt.pub("GET /api/o/menu", func(c *C) error {
		info, err := c.commerceOnlineInfo()
		if err != nil {
			return err
		}
		if info["items"], err = c.commerceCleanMenu(); err != nil {
			return err
		}
		return c.JSON(info)
	}, a.publicLim())

	checkoutSchema := valid.Ordered(
		"items", valid.Array(lineSchema).Min(1).Max(50),
		"fulfillment", valid.Enum("pickup", "delivery"),
		"name", valid.String().Trim().Min(1).Max(40),
		"phone", valid.String().Trim().Min(7).Max(20).RegexMsg(`^[+\d\s()-]+$`, "Phone looks wrong"),
		"email", valid.String().Trim().Email().Max(120).Optional().Or(valid.Literal("")),
		"address", valid.String().Trim().Max(200).Optional(),
		"notes", valid.String().Trim().Max(200).Optional(),
		"payNow", valid.Bool(),
		"tipCents", valid.Int().Min(0).Max(100000).Default(0),
		"promoCode", valid.String().Trim().Max(30).Optional(),
		"scheduledFor", valid.String().Regex(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$`).Optional(),
	)
	rt.pub("POST /api/o/checkout", func(c *C) error {
		info, err := c.commerceOnlineInfo()
		if err != nil {
			return err
		}
		if !truthy(info["enabled"]) {
			if truthy(info["paused"]) {
				return forbidden("The kitchen is very busy. Online orders are paused for a few minutes; please try again soon.")
			}
			return forbidden("Online ordering is closed right now.")
		}
		b, err := c.Body(checkoutSchema)
		if err != nil {
			return err
		}
		sched := str(b["scheduledFor"])
		if sched != "" {
			if _, err := c.G("checkSchedule", sched); err != nil {
				return err
			}
		}
		var slot M
		if c.Has("slotFor") {
			var arg any
			if sched != "" {
				arg = sched
			}
			r, err := c.G("slotFor", arg)
			if err != nil {
				return err
			}
			slot = commerceRow(r)
		}
		ful := str(b["fulfillment"])
		addr := str(b["address"])
		if ful == "delivery" && (!truthy(info["delivery"]) || len([]rune(addr)) < 8) {
			if truthy(info["delivery"]) {
				return bad("Enter a delivery address")
			}
			return bad("Delivery is not available")
		}
		if ful == "pickup" && !truthy(info["pickup"]) {
			return bad("Pickup is not available")
		}
		payNow := truthy(b["payNow"])
		if payNow && !truthy(info["payOnline"]) {
			return bad("Paying online is not available")
		}
		if !payNow && !truthy(info["payAtPickup"]) {
			return bad("Please pay online to place your order")
		}
		items, _ := b["items"].([]any)
		lines, err := c.priceLines(items, false)
		if err != nil {
			return err
		}
		var subtotal int64
		for _, l := range lines {
			subtotal += i64(l["qty"]) * i64(l["price_cents"])
		}
		var zone M
		if ful == "delivery" && c.Has("deliveryZone") {
			z, err := c.G("deliveryZone", addr)
			if err != nil {
				return err
			}
			zone = commerceRow(z)
		}
		if zone != nil && truthy(zone["error"]) {
			return bad(str(zone["error"]))
		}
		deliveryMin, deliveryFee := info["deliveryMinCents"], info["deliveryFeeCents"]
		if zone != nil && zone["minCents"] != nil {
			deliveryMin = zone["minCents"]
		}
		if zone != nil && zone["feeCents"] != nil {
			deliveryFee = zone["feeCents"]
		}
		if ful == "delivery" && float64(subtotal) < f64(deliveryMin) {
			to := ""
			if zone != nil && truthy(zone["zone"]) {
				to = " to " + str(zone["zone"])
			}
			return bad(fmt.Sprintf("Delivery orders%s need at least $%.2f of food", to, f64(deliveryMin)/100))
		}
		var promo M
		if truthy(b["promoCode"]) && c.Has("promoDiscount") {
			p, err := c.G("promoDiscount", b["promoCode"], subtotal)
			if err != nil {
				return err
			}
			promo = commerceRow(p)
		}
		email := str(b["email"])
		g, err := c.createGuest(newGuest{Kind: "order", Name: str(b["name"]), Phone: str(b["phone"]), Email: email, NotifyEmail: email != "", PartySize: 1, Source: "online"})
		if err != nil {
			return err
		}
		status := "sent"
		if payNow || sched != "" {
			status = "held"
		}
		var address any
		var fee int64
		if ful == "delivery" {
			address, fee = addr, int64(f64(deliveryFee))
		}
		var discount int64
		var promoCode any
		if promo != nil {
			discount, promoCode = i64(promo["cents"]), orNil(promo["code"])
		}
		o, err := c.insertOrder(newOrder{Lines: lines, Status: status, Source: "online", GuestID: g["id"], CustomerName: b["name"], Fulfillment: ful, Address: address,
			Phone: b["phone"], Email: orNil(email), Notes: orNil(b["notes"]), FeeCents: fee, DiscountCents: discount, PromoCode: promoCode})
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE guests SET order_id = ? WHERE id = ?`, o.ID, g["id"]); err != nil {
			return err
		}
		if _, err := c.G("linkOrderCustomer", o.ID); err != nil {
			return err
		}
		if sched != "" {
			when := "later"
			if payNow {
				when = "now"
			}
			if _, err := c.Run(`UPDATE orders SET scheduled_for = ?, sched_pay = ? WHERE id = ?`, sched, when, o.ID); err != nil {
				return err
			}
		}
		if slot != nil {
			if _, err := c.Run(`UPDATE orders SET promised_at = ? WHERE id = ?`, slot["promisedAt"], o.ID); err != nil {
				return err
			}
		}
		buzzer := "/b/" + str(g["token"])
		if !payNow {
			at := "door"
			if ful == "pickup" {
				at = "pickup"
			}
			if err := c.AuditAs(nil, "online.order", fmt.Sprintf("#%d %s for %s, pay at %s", o.Number, ful, str(b["name"]), at), c.IP()); err != nil {
				return err
			}
			c.Emit("staff", "online:new", M{"number": o.Number, "name": b["name"], "fulfillment": ful})
			c.Notify("orders")
			c.Notify("guests")
			return c.JSON(M{"ok": true, "number": o.Number, "buzzer": buzzer})
		}
		bill, err := c.commerceBillFor(o.ID, nil)
		if err != nil {
			return err
		}
		sum, err := c.commerceBillSummary(bill)
		if err != nil {
			return err
		}
		tip := i64(b["tipCents"])
		rem := i64(sum["remainingCents"])
		res, err := c.Run(`INSERT INTO payments (bill_id, amount_cents, tip_cents, method, label) VALUES (?, ?, ?, 'card', 'Online order')`, bill["id"], rem, tip)
		if err != nil {
			return err
		}
		s := c.S()
		base := c.PublicBase()
		lns := []M{{"name": fmt.Sprintf("%s order #%d (%s)", s["business_name"], o.Number, ful), "cents": rem}}
		if tip > 0 {
			lns = append(lns, M{"name": "Tip", "cents": tip})
		}
		u, err := c.paymentsStartPay(res.LastID, paymentsStart{Base: base, Lines: lns, SuccessURL: base + buzzer + "?paid=1", CancelURL: base + "/order" + commerceLQ(c), Email: email, Descr: fmt.Sprintf("order #%d", o.Number)})
		if err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "number": o.Number, "url": u})
	}, a.orderLim())
	// the buzzer page confirms an online payment on return from Stripe
	rt.pub("GET /api/g/{token}/confirm", func(c *C) error {
		if err := c.commerceConfirmSession(c.Q("session_id")); err != nil {
			return err
		}
		g, err := c.One(`SELECT order_id FROM guests WHERE token = ?`, c.Param("token"))
		if err != nil {
			return err
		}
		var o store.Row
		if g != nil && truthy(g["order_id"]) {
			if o, err = c.One(`SELECT status, prepaid FROM orders WHERE id = ?`, g["order_id"]); err != nil {
				return err
			}
		}
		if o != nil && str(o["status"]) != "held" {
			c.Emit("staff", "online:new", M{"number": "", "name": "Online order", "fulfillment": "paid"})
			c.Notify("orders")
		}
		return c.JSON(M{"paid": o != nil && truthy(o["prepaid"])})
	}, a.publicLim())

	/* ================= Table QR ordering ================= */
	rt.staff("GET /tables/{id}/qr", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		t, err := c.One(`SELECT * FROM tables WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Not found")
		}
		token := str(t["qr_token"])
		if token == "" {
			token = newToken(12)
			if _, err := c.Run(`UPDATE tables SET qr_token = ? WHERE id = ?`, token, t["id"]); err != nil {
				return err
			}
		}
		link := c.PublicBase() + "/t/" + token
		svg, err := qrSVG(link, 1, "", "", true)
		if err != nil {
			return err
		}
		return c.JSON(M{"link": link, "label": t["label"], "svg": svg})
	})
	rt.pub("GET /api/t/{token}", func(c *C) error {
		t, err := c.commerceTableByToken(c.Param("token"))
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("This table code is not valid.")
		}
		info, err := c.commerceOnlineInfo()
		if err != nil {
			return err
		}
		open, err := c.All(`SELECT o.number, o.status, o.created_at FROM orders o WHERE o.table_id = ? AND o.status IN ('sent','open','ready','held') ORDER BY o.id`, t["id"])
		if err != nil {
			return err
		}
		items := []M{}
		if truthy(info["tableOrdering"]) {
			if items, err = c.commerceCleanMenu(); err != nil {
				return err
			}
		}
		info["table"], info["items"], info["rounds"], info["tabs"] = t["label"], items, open, c.S()["bar_tabs"] == "1"
		return c.JSON(info)
	}, a.publicLim())
	tableOrder := valid.Ordered(
		"items", valid.Array(lineSchema).Min(1).Max(40),
		"name", valid.String().Trim().Max(30).Optional(),
		"tab", valid.String().Max(40).Optional(),
		"member", valid.String().Trim().Max(30).Optional(),
	)
	rt.pub("POST /api/t/{token}/order", func(c *C) error {
		t, err := c.commerceTableByToken(c.Param("token"))
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("This table code is not valid.")
		}
		if c.S()["table_ordering"] != "1" {
			return forbidden("Ordering from the table is off. Please ask your server.")
		}
		b, err := c.Body(tableOrder)
		if err != nil {
			return err
		}
		var tab M
		if c.Has("tabForOrder") {
			r, err := c.G("tabForOrder", b["tab"], t["id"])
			if err != nil {
				return err
			}
			tab = commerceRow(r)
		}
		items, _ := b["items"].([]any)
		lines, err := c.priceLines(items, false)
		if err != nil {
			return err
		}
		var qty int64
		for _, l := range lines {
			qty += i64(l["qty"])
		}
		if qty > 40 {
			return bad("That is a big order. Please ask your server.")
		}
		var cust any = orNil(b["name"])
		if tab != nil {
			cust = tab["name"]
		}
		o, err := c.insertOrder(newOrder{Lines: lines, Status: "sent", Source: "table", TableID: t["id"], CustomerName: cust})
		if err != nil {
			return err
		}
		if tab != nil {
			member, err := c.G("tabMemberFor", c.Raw())
			if err != nil {
				return err
			}
			if !truthy(member) {
				member = tab["name"]
			}
			if _, err := c.Run(`UPDATE orders SET tab_id = ?, tab_member = ? WHERE id = ?`, tab["id"], member, o.ID); err != nil {
				return err
			}
		}
		if st := str(t["status"]); st == "open" || st == "reserved" {
			if _, err := c.Run(`UPDATE tables SET status='seated', seated_at=COALESCE(seated_at, ?) WHERE id=?`, store.Now(), t["id"]); err != nil {
				return err
			}
		}
		if err := c.AuditAs(nil, "table.order", fmt.Sprintf("%s: #%d", str(t["label"]), o.Number), c.IP()); err != nil {
			return err
		}
		c.Emit("staff", "online:new", M{"number": o.Number, "name": c.S()["unit_label"] + " " + str(t["label"]), "fulfillment": "table"})
		c.Notify("orders")
		c.Notify("tables")
		return c.JSON(M{"ok": true, "number": o.Number})
	}, a.orderLim())
	rt.pub("POST /api/t/{token}/bill", func(c *C) error {
		t, err := c.commerceTableByToken(c.Param("token"))
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("This table code is not valid.")
		}
		bill, err := c.commerceBillFor(nil, t["id"])
		if err != nil {
			return err
		}
		return c.JSON(M{"token": bill["token"]})
	}, a.publicLim())
	helpSchema := valid.Object(map[string]valid.Schema{"reason": valid.Enum("server", "water", "check")})
	rt.pub("POST /api/t/{token}/help", func(c *C) error {
		t, err := c.commerceTableByToken(c.Param("token"))
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Not valid")
		}
		b, err := c.Body(helpSchema)
		if err != nil {
			return err
		}
		what := map[string]string{"server": "is asking for their server", "water": "would like water", "check": "is ready for the check"}[str(b["reason"])]
		c.Emit("staff", "security", M{"type": "help", "detail": c.S()["unit_label"] + " " + str(t["label"]) + " " + what})
		return c.OK()
	}, a.publicLim())

	rt.staff("GET /payments/status", "staff", func(c *C) error {
		out := commerceStripeStatus()
		out["webhookUrl"] = c.PublicBase() + "/api/stripe/webhook"
		return c.JSON(out)
	})
}
