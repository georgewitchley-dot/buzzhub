package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of payments.js: one pay page for every online payment (Square, PayPal/Venmo, Stripe,
// pay-to-handle apps), refunds, the Square webhook and Square Terminal readers.

func init() { modules = append(modules, (*App).registerPayments) }

/* ---------------- Square ---------------- */

type paymentsSquareCfg struct{ token, loc, env, hook string }

func paymentsSQ() paymentsSquareCfg {
	env := strings.ToLower(os.Getenv("SQUARE_ENVIRONMENT"))
	if env == "" {
		env = "production"
	}
	return paymentsSquareCfg{os.Getenv("SQUARE_ACCESS_TOKEN"), os.Getenv("SQUARE_LOCATION_ID"), env, os.Getenv("SQUARE_WEBHOOK_SIGNATURE_KEY")}
}

func paymentsSquareEnabled() bool { q := paymentsSQ(); return q.token != "" && q.loc != "" }

func paymentsSqBase() string {
	if paymentsSQ().env == "sandbox" {
		return "https://connect.squareupsandbox.com"
	}
	return "https://connect.squareup.com"
}

var paymentsHTTP = &http.Client{Timeout: 15 * time.Second}

func paymentsUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func paymentsJSONCall(ctx context.Context, method, u string, headers map[string]string, body any) (*http.Response, M, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	r, err := paymentsHTTP.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer r.Body.Close()
	data := M{}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&data)
	if data == nil {
		data = M{}
	}
	return r, data, nil
}

// paymentsSquare calls the Square API.
func paymentsSquare(ctx context.Context, method, path string, body any) (M, error) {
	r, data, err := paymentsJSONCall(ctx, method, paymentsSqBase()+path, map[string]string{"Authorization": "Bearer " + paymentsSQ().token, "Content-Type": "application/json", "Square-Version": "2025-01-23"}, body)
	if err != nil {
		return nil, fail(http.StatusBadGateway, "Couldn't reach Square. Please try again.")
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		msg := "Square payments are not available right now"
		if errs, ok := data["errors"].([]any); ok && len(errs) > 0 {
			if e, ok := errs[0].(M); ok && str(e["detail"]) != "" {
				msg = str(e["detail"])
			}
		}
		return nil, fail(http.StatusBadGateway, msg)
	}
	return data, nil
}

/* ---------------- PayPal ---------------- */

type paymentsPayPalCfg struct{ id, secret, env string }

func paymentsPP() paymentsPayPalCfg {
	env := strings.ToLower(os.Getenv("PAYPAL_ENVIRONMENT"))
	if env == "" {
		env = "production"
	}
	return paymentsPayPalCfg{os.Getenv("PAYPAL_CLIENT_ID"), os.Getenv("PAYPAL_CLIENT_SECRET"), env}
}

func paymentsPayPalEnabled() bool { p := paymentsPP(); return p.id != "" && p.secret != "" }

func paymentsPPBase() string {
	if paymentsPP().env == "sandbox" {
		return "https://api-m.sandbox.paypal.com"
	}
	return "https://api-m.paypal.com"
}

var paymentsPPTok struct {
	sync.Mutex
	t     string
	until time.Time
}

func paymentsPayPal(ctx context.Context, method, path string, body any) (M, error) {
	pp := paymentsPP()
	paymentsPPTok.Lock()
	tok := paymentsPPTok.t
	if time.Now().After(paymentsPPTok.until) {
		req, _ := http.NewRequestWithContext(ctx, "POST", paymentsPPBase()+"/v1/oauth2/token", strings.NewReader("grant_type=client_credentials"))
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(pp.id+":"+pp.secret)))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		var j struct {
			AccessToken string  `json:"access_token"`
			ExpiresIn   float64 `json:"expires_in"`
		}
		if r, err := paymentsHTTP.Do(req); err == nil {
			_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&j)
			r.Body.Close()
		}
		if j.AccessToken == "" {
			paymentsPPTok.Unlock()
			return nil, fail(http.StatusBadGateway, "Couldn't reach PayPal. Please try again.")
		}
		paymentsPPTok.t, paymentsPPTok.until = j.AccessToken, time.Now().Add(time.Duration((j.ExpiresIn-120)*float64(time.Second)))
		tok = j.AccessToken
	}
	paymentsPPTok.Unlock()
	r, data, err := paymentsJSONCall(ctx, method, paymentsPPBase()+path, map[string]string{"Authorization": "Bearer " + tok, "Content-Type": "application/json", "Prefer": "return=representation"}, body)
	if err != nil {
		return nil, fail(http.StatusBadGateway, "Couldn't reach PayPal. Please try again.")
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		msg := "PayPal is not available right now"
		if det, ok := data["details"].([]any); ok && len(det) > 0 {
			if d, ok := det[0].(M); ok && str(d["description"]) != "" {
				msg = str(d["description"])
			}
		}
		if msg == "PayPal is not available right now" && str(data["message"]) != "" {
			msg = str(data["message"])
		}
		return nil, fail(http.StatusBadGateway, msg)
	}
	return data, nil
}

/* ---------------- what this business accepts ---------------- */

var (
	paymentsCashappRE  = regexp.MustCompile(`^\$[A-Za-z][A-Za-z0-9_-]{0,20}$`)
	paymentsVenmoRE    = regexp.MustCompile(`^@?[A-Za-z0-9_-]{3,30}$`)
	paymentsPaypalmeRE = regexp.MustCompile(`^[A-Za-z0-9]{1,20}$`)
	paymentsZelleRE    = regexp.MustCompile(`^[^\s<>]{3,80}$`)
	paymentsTokenRE    = regexp.MustCompile(`^[A-Za-z0-9_-]{20,30}$`)
)

func paymentsClean(v string, re *regexp.Regexp) string {
	s := strings.TrimSpace(v)
	if re.MatchString(s) {
		return s
	}
	return ""
}

func paymentsHandles(s map[string]string) map[string]string {
	return map[string]string{
		"cashapp":  paymentsClean(s["pay_cashapp"], paymentsCashappRE),
		"venmo":    strings.TrimPrefix(paymentsClean(s["pay_venmo"], paymentsVenmoRE), "@"),
		"paypalme": paymentsClean(s["pay_paypalme"], paymentsPaypalmeRE),
		"zelle":    paymentsClean(s["pay_zelle"], paymentsZelleRE),
	}
}

func paymentsCardProvider(s map[string]string) string {
	pref := s["card_provider"]
	if pref == "" {
		pref = "auto"
	}
	if pref == "square" && paymentsSquareEnabled() {
		return "square"
	}
	if pref == "stripe" && commerceStripeEnabled() {
		return "stripe"
	}
	if paymentsSquareEnabled() {
		return "square"
	}
	if commerceStripeEnabled() {
		return "stripe"
	}
	return ""
}

func (c *C) paymentsOnlinePayEnabled() bool {
	s := c.S()
	if paymentsCardProvider(s) != "" || paymentsPayPalEnabled() {
		return true
	}
	if s["pay_handles_enabled"] == "1" {
		for _, v := range paymentsHandles(s) {
			if v != "" {
				return true
			}
		}
	}
	return false
}

func orNilStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (c *C) paymentsProvidersStatus() M {
	sq, pp := paymentsSQ(), paymentsPP()
	var sqEnv, ppEnv any
	if paymentsSquareEnabled() {
		sqEnv = sq.env
	}
	if paymentsPayPalEnabled() {
		ppEnv = pp.env
	}
	return M{"stripe": commerceStripeEnabled(), "square": paymentsSquareEnabled(), "squareEnv": sqEnv, "squareWebhook": sq.hook != "", "paypal": paymentsPayPalEnabled(), "paypalEnv": ppEnv, "cardProvider": orNilStr(paymentsCardProvider(c.S()))}
}

type paymentsStart struct {
	Base                                string
	Lines                               []M // {name, cents}
	SuccessURL, CancelURL, Email, Descr string
}

// paymentsStartPay points a pending payment row at the BuzzHub pay page and returns its URL.
func (c *C) paymentsStartPay(pid int64, o paymentsStart) (string, error) {
	token := newToken(16)
	lines := o.Lines
	if lines == nil {
		lines = []M{}
	}
	if _, err := c.Run(`UPDATE payments SET pay_token = ?, success_url = ?, cancel_url = ?, lines_json = ?, email = ?, descr = ? WHERE id = ?`,
		token, strings.Replace(o.SuccessURL, "{TOKEN}", token, 1), o.CancelURL, commerceJSON(lines), orNilStr(o.Email), orNilStr(o.Descr), pid); err != nil {
		return "", err
	}
	return o.Base + "/pay/" + token + commerceLQ(c), nil
}

// paymentsURIComponent is JavaScript's encodeURIComponent.
func paymentsURIComponent(s string) string {
	var b strings.Builder
	for _, ch := range []byte(s) {
		if ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || strings.IndexByte("-_.!~*'()", ch) >= 0 {
			b.WriteByte(ch)
		} else {
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

func paymentsTotal(p store.Row) int64 { return i64(p["amount_cents"]) + i64(p["tip_cents"]) }

func paymentsLines(p store.Row) any {
	v := jparse(p["lines_json"], []any{})
	if _, ok := v.([]any); !ok {
		return []any{}
	}
	return v
}

func (c *C) paymentsByToken(t string) (store.Row, error) {
	if !paymentsTokenRE.MatchString(t) {
		return nil, nil
	}
	return c.One(`SELECT * FROM payments WHERE pay_token = ?`, t)
}

func (c *C) paymentsMustToken() (store.Row, error) {
	p, err := c.paymentsByToken(c.Param("token"))
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, notFound("This payment link is not valid.")
	}
	return p, nil
}

func (c *C) paymentsFinish(p store.Row, provider, ref, refundRef string) error {
	if _, err := c.Run(`UPDATE payments SET provider = ?, provider_ref = COALESCE(?, provider_ref), refund_ref = ? WHERE id = ?`, provider, orNilStr(ref), orNilStr(refundRef), p["id"]); err != nil {
		return err
	}
	fresh, err := c.Get(`SELECT * FROM payments WHERE id = ?`, p["id"])
	if err != nil {
		return err
	}
	if ref == "" {
		ref = provider
	}
	return c.commerceCompletePayment(fresh, ref)
}

var paymentsStripeSessRE = regexp.MustCompile(`^cs_(test|live)_[A-Za-z0-9]+$`)

func (c *C) paymentsVerify(p store.Row, ref string) (bool, error) {
	if str(p["status"]) == "paid" {
		return true, nil
	}
	if str(p["provider"]) == "stripe" && commerceStripeEnabled() {
		sid := str(p["provider_ref"])
		if paymentsStripeSessRE.MatchString(ref) {
			sid = ref
		}
		if sid != "" {
			if sess, err := commerceStripe(c.Ctx, "GET", "/checkout/sessions/"+sid, nil); err == nil {
				md, _ := sess["metadata"].(M)
				if str(sess["payment_status"]) == "paid" && str(md["payment_id"]) == str(p["id"]) {
					return true, c.paymentsFinish(p, "stripe", str(sess["id"]), "stripe:"+str(sess["payment_intent"]))
				}
			}
		}
	}
	if str(p["provider"]) == "square" && paymentsSquareEnabled() && truthy(p["provider_ref"]) {
		if o, err := paymentsSquare(c.Ctx, "GET", "/v2/orders/"+str(p["provider_ref"]), nil); err == nil {
			order, _ := o["order"].(M)
			tenders, _ := order["tenders"].([]any)
			var amount float64
			first := ""
			for _, t := range tenders {
				tm, _ := t.(M)
				if !truthy(tm["payment_id"]) {
					continue
				}
				if first == "" {
					first = str(tm["payment_id"])
				}
				am, _ := tm["amount_money"].(M)
				amount += f64(am["amount"])
			}
			if order != nil && (str(order["state"]) == "COMPLETED" || amount >= float64(paymentsTotal(p))) {
				rr := ""
				if first != "" {
					rr = "square:" + first
				}
				return true, c.paymentsFinish(p, "square", str(p["provider_ref"]), rr)
			}
		}
	}
	return false, nil
}

func (c *C) paymentsRefundRef(ref string, cents int64) (string, error) {
	prov, id, _ := strings.Cut(ref, ":")
	if id == "" {
		return "manual", nil
	}
	switch prov {
	case "stripe":
		form := url.Values{"payment_intent": {id}}
		if cents != 0 {
			form.Set("amount", fmt.Sprint(cents))
		}
		if _, err := commerceStripe(c.Ctx, "POST", "/refunds", form); err != nil {
			return "", err
		}
		return "card", nil
	case "square":
		if _, err := paymentsSquare(c.Ctx, "POST", "/v2/refunds", M{"idempotency_key": paymentsUUID(), "payment_id": id, "amount_money": M{"amount": cents, "currency": c.S()["currency"]}}); err != nil {
			return "", err
		}
		return "card", nil
	case "paypal":
		body := M{}
		if cents != 0 {
			body = M{"amount": M{"value": dollars(cents), "currency_code": c.S()["currency"]}}
		}
		if _, err := paymentsPayPal(c.Ctx, "POST", "/v2/payments/captures/"+id+"/refund", body); err != nil {
			return "", err
		}
		return "paypal", nil
	}
	return "manual", nil
}

func paymentsTrunc(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

func (a *App) registerPayments(rt *router) {
	/* ---------- hooks for other modules ---------- */
	a.G["onlinePayEnabled"] = func(c *C, args ...any) (any, error) { return c.paymentsOnlinePayEnabled(), nil }
	a.G["handles"] = func(c *C, args ...any) (any, error) { return paymentsHandles(c.S()), nil }
	// startPay(pid, {base, lines: [{name, cents}], successUrl, cancelUrl, email, descr}) -> url
	a.G["startPay"] = func(c *C, args ...any) (any, error) {
		o := commerceRow(args[1])
		var lines []M
		if ls, ok := o["lines"].([]M); ok {
			lines = ls
		} else if ls, ok := o["lines"].([]any); ok {
			for _, l := range ls {
				lines = append(lines, commerceRow(l))
			}
		}
		return c.paymentsStartPay(i64(args[0]), paymentsStart{Base: str(o["base"]), Lines: lines, SuccessURL: str(o["successUrl"]), CancelURL: str(o["cancelUrl"]), Email: str(o["email"]), Descr: str(o["descr"])})
	}
	// verifyPayment(payment, ref?) -> bool
	a.G["verifyPayment"] = func(c *C, args ...any) (any, error) {
		ref := ""
		if len(args) > 1 {
			ref = str(args[1])
		}
		return c.paymentsVerify(store.Row(commerceRow(args[0])), ref)
	}
	// refundRef(ref, cents) -> 'card' | 'paypal' | 'manual'
	a.G["refundRef"] = func(c *C, args ...any) (any, error) {
		var cents int64
		if len(args) > 1 {
			cents = i64(args[1])
		}
		return c.paymentsRefundRef(str(args[0]), cents)
	}
	a.G["squareOn"] = func(c *C, args ...any) (any, error) { return paymentsSquareEnabled(), nil }
	a.G["squareGet"] = func(c *C, args ...any) (any, error) { return paymentsSquare(c.Ctx, "GET", str(args[0]), nil) }
	a.G["squareReaders"] = func(c *C, args ...any) (any, error) {
		list := []M{}
		if !paymentsSquareEnabled() {
			return list, nil
		}
		sq := paymentsSQ()
		r, err := paymentsSquare(c.Ctx, "GET", "/v2/devices/codes?location_id="+sq.loc+"&product_type=TERMINAL_API&status=PAIRED", nil)
		if err != nil {
			r = M{}
		}
		codes, _ := r["device_codes"].([]any)
		for _, d := range codes {
			dm, _ := d.(M)
			label := str(dm["name"])
			if label == "" {
				label = "Square Terminal"
			}
			list = append(list, M{"id": "sq_" + str(dm["device_id"]), "label": label, "type": "Square Terminal", "status": "online", "provider": "square"})
		}
		if sq.env == "sandbox" && len(list) == 0 {
			list = append(list, M{"id": "sq_9fa747a2-25ff-48ee-b078-04381f7c828f", "label": "Square test terminal", "type": "Square Terminal (sandbox)", "status": "online", "provider": "square"})
		}
		return list, nil
	}
	// squareCharge(deviceId, amountCents, note) -> checkout id
	a.G["squareCharge"] = func(c *C, args ...any) (any, error) {
		note := str(args[2])
		r, err := paymentsSquare(c.Ctx, "POST", "/v2/terminals/checkouts", M{"idempotency_key": paymentsUUID(), "checkout": M{"amount_money": M{"amount": i64(args[1]), "currency": c.S()["currency"]}, "reference_id": paymentsTrunc(note, 40), "note": paymentsTrunc(note, 250),
			"device_options": M{"device_id": str(args[0]), "skip_receipt_screen": true, "tip_settings": M{"allow_tipping": false}}}})
		if err != nil {
			return nil, err
		}
		co, _ := r["checkout"].(M)
		return str(co["id"]), nil
	}
	// squareChargeStatus(checkoutId) -> {status, paymentId, reason} or nil
	a.G["squareChargeStatus"] = func(c *C, args ...any) (any, error) {
		r, err := paymentsSquare(c.Ctx, "GET", "/v2/terminals/checkouts/"+str(args[0]), nil)
		if err != nil {
			return nil, nil
		}
		co, _ := r["checkout"].(M)
		if co == nil {
			return nil, nil
		}
		var pid any
		if ids, ok := co["payment_ids"].([]any); ok && len(ids) > 0 {
			pid = ids[0]
		}
		return M{"status": co["status"], "paymentId": pid, "reason": orNil(co["cancel_reason"])}, nil
	}
	a.G["squareCancel"] = func(c *C, args ...any) (any, error) {
		_, _ = paymentsSquare(c.Ctx, "POST", "/v2/terminals/checkouts/"+str(args[0])+"/cancel", nil)
		return nil, nil
	}

	rt.pub("GET /api/pay/{token}", func(c *C) error {
		p, err := c.paymentsMustToken()
		if err != nil {
			return err
		}
		s := c.S()
		hd := paymentsHandles(s)
		cp := paymentsCardProvider(s)
		amt := dollars(paymentsTotal(p))
		methods := []any{}
		if bank, err := c.G("bankOption", p); err != nil {
			return err
		} else if truthy(bank) {
			methods = append(methods, bank)
		}
		if cp != "" {
			label := "Card, Apple Pay or Google Pay"
			if cp == "square" {
				label = "Card, Apple Pay, Google Pay, Cash App Pay or Afterpay"
			}
			methods = append(methods, M{"kind": "card", "provider": cp, "label": label})
		}
		if paymentsPayPalEnabled() {
			pp := paymentsPP()
			methods = append(methods, M{"kind": "paypal", "clientId": pp.id, "sandbox": pp.env == "sandbox", "currency": s["currency"]})
		}
		if s["pay_handles_enabled"] == "1" {
			note := paymentsURIComponent(paymentsTrunc(strings.TrimSpace(s["business_name"]+" "+str(p["descr"])), 60))
			if hd["cashapp"] != "" {
				methods = append(methods, M{"kind": "handle", "app": "cashapp", "label": "Cash App", "handle": hd["cashapp"], "url": "https://cash.app/" + hd["cashapp"] + "/" + amt})
			}
			if hd["venmo"] != "" {
				methods = append(methods, M{"kind": "handle", "app": "venmo", "label": "Venmo", "handle": "@" + hd["venmo"], "url": "https://venmo.com/?txn=pay&audience=private&recipients=" + paymentsURIComponent(hd["venmo"]) + "&amount=" + amt + "&note=" + note})
			}
			if hd["paypalme"] != "" {
				methods = append(methods, M{"kind": "handle", "app": "paypalme", "label": "PayPal.me", "handle": "paypal.me/" + hd["paypalme"], "url": "https://paypal.me/" + hd["paypalme"] + "/" + amt + s["currency"]})
			}
			if hd["zelle"] != "" {
				methods = append(methods, M{"kind": "handle", "app": "zelle", "label": "Zelle", "handle": hd["zelle"], "url": nil})
			}
		}
		return c.JSON(M{"status": p["status"], "bankStatus": orNil(p["bank_status"]), "claimed": truthy(p["claimed_at"]), "amountCents": paymentsTotal(p), "currency": s["currency"], "descr": p["descr"], "lines": paymentsLines(p),
			"successUrl": p["success_url"], "cancelUrl": p["cancel_url"], "business": M{"name": s["business_name"], "accent": s["accent"], "logo": commerceLogo(c)}, "methods": methods})
	}, a.publicLim())

	// card: hosted checkout at Square or Stripe, coming back here to confirm
	rt.pub("POST /api/pay/{token}/card", func(c *C) error {
		p, err := c.paymentsMustToken()
		if err != nil {
			return err
		}
		if str(p["status"]) == "paid" {
			return c.JSON(M{"paid": true, "next": p["success_url"]})
		}
		s := c.S()
		cp := paymentsCardProvider(s)
		if cp == "" {
			return fail(http.StatusServiceUnavailable, "Card payments are not set up.")
		}
		base := c.PublicBase()
		l := commerceLAmp(c)
		back := base + "/pay/" + str(p["pay_token"]) + "?" + l + "back=1"
		total := paymentsTotal(p)
		if cp == "square" {
			name := s["business_name"]
			if truthy(p["descr"]) {
				name += ": " + str(p["descr"])
			}
			body := M{"idempotency_key": paymentsUUID(),
				"quick_pay":        M{"name": paymentsTrunc(name, 255), "price_money": M{"amount": total, "currency": s["currency"]}, "location_id": paymentsSQ().loc},
				"checkout_options": M{"redirect_url": back, "ask_for_shipping_address": false}, "payment_note": fmt.Sprintf("BuzzHub %s:%d", c.Slug(), i64(p["id"]))}
			if truthy(p["email"]) {
				body["pre_populated_data"] = M{"buyer_email": p["email"]}
			}
			r, err := paymentsSquare(c.Ctx, "POST", "/v2/online-checkout/payment-links", body)
			if err != nil {
				return err
			}
			link, _ := r["payment_link"].(M)
			if _, err := c.Run(`UPDATE payments SET provider = 'square', provider_ref = ? WHERE id = ?`, link["order_id"], p["id"]); err != nil {
				return err
			}
			return c.JSON(M{"url": link["url"]})
		}
		cancel := base + "/pay/" + str(p["pay_token"])
		if l != "" {
			cancel += "?" + l[:len(l)-1]
		}
		form := url.Values{"mode": {"payment"}, "success_url": {back + "&ref={CHECKOUT_SESSION_ID}"}, "cancel_url": {cancel}, "metadata[payment_id]": {str(p["id"])}, "metadata[loc]": {c.Slug()}, "payment_intent_data[metadata][loc]": {c.Slug()}}
		if truthy(p["email"]) {
			form.Set("customer_email", str(p["email"]))
		}
		var lines []any
		if ls, ok := paymentsLines(p).([]any); ok {
			lines = ls
		}
		if len(lines) == 0 {
			name := str(p["descr"])
			if name == "" {
				name = s["business_name"]
			}
			lines = []any{M{"name": name, "cents": total}}
		}
		for i, li := range lines {
			lm := commerceRow(li)
			k := fmt.Sprintf("line_items[%d]", i)
			form.Set(k+"[quantity]", "1")
			form.Set(k+"[price_data][currency]", strings.ToLower(s["currency"]))
			form.Set(k+"[price_data][unit_amount]", str(lm["cents"]))
			form.Set(k+"[price_data][product_data][name]", paymentsTrunc(str(lm["name"]), 120))
		}
		sess, err := commerceStripe(c.Ctx, "POST", "/checkout/sessions", form)
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE payments SET provider = 'stripe', provider_ref = ?, stripe_session = ? WHERE id = ?`, sess["id"], sess["id"], p["id"]); err != nil {
			return err
		}
		return c.JSON(M{"url": sess["url"]})
	}, a.publicLim())
	rt.pub("POST /api/pay/{token}/verify", func(c *C) error {
		p, err := c.paymentsMustToken()
		if err != nil {
			return err
		}
		ref := ""
		if v := commerceBodyField(c, "ref"); truthy(v) {
			ref = str(v)
		}
		ok, err := c.paymentsVerify(p, ref)
		if err != nil {
			return err
		}
		processing := false
		if !ok && c.Has("bankCheck") {
			fresh, err := c.Get(`SELECT * FROM payments WHERE id = ?`, p["id"])
			if err != nil {
				return err
			}
			st, err := c.G("bankCheck", fresh)
			processing = err == nil && str(st) == "processing"
		}
		return c.JSON(M{"paid": ok, "processing": processing, "next": p["success_url"]})
	}, a.publicLim())

	// PayPal and Venmo: buttons on the pay page create and capture orders here
	rt.pub("POST /api/pay/{token}/paypal", func(c *C) error {
		p, err := c.paymentsMustToken()
		if err != nil {
			return err
		}
		if !paymentsPayPalEnabled() {
			return fail(http.StatusServiceUnavailable, "PayPal is not set up.")
		}
		if str(p["status"]) == "paid" {
			return conflict("Already paid. Thank you!")
		}
		s := c.S()
		ref := fmt.Sprintf("%s:%d", c.Slug(), i64(p["id"]))
		descr := s["business_name"]
		if truthy(p["descr"]) {
			descr += ": " + str(p["descr"])
		}
		o, err := paymentsPayPal(c.Ctx, "POST", "/v2/checkout/orders", M{"intent": "CAPTURE", "purchase_units": []any{M{"reference_id": ref, "custom_id": ref, "description": paymentsTrunc(descr, 127), "amount": M{"currency_code": s["currency"], "value": dollars(paymentsTotal(p))}}},
			"application_context": M{"shipping_preference": "NO_SHIPPING", "brand_name": paymentsTrunc(s["business_name"], 127)}})
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE payments SET provider = 'paypal', provider_ref = ? WHERE id = ?`, o["id"], p["id"]); err != nil {
			return err
		}
		return c.JSON(M{"id": o["id"]})
	}, a.publicLim())
	captureSchema := valid.Object(map[string]valid.Schema{"orderId": valid.String().Regex(`^[A-Z0-9]{10,30}$`)})
	rt.pub("POST /api/pay/{token}/paypal/capture", func(c *C) error {
		p, err := c.paymentsMustToken()
		if err != nil {
			return err
		}
		b, err := c.Body(captureSchema)
		if err != nil {
			return err
		}
		if str(p["status"]) == "paid" {
			return c.JSON(M{"paid": true, "next": p["success_url"]})
		}
		orderID := str(b["orderId"])
		if str(p["provider_ref"]) != orderID {
			return conflict("That PayPal order does not match this payment")
		}
		cp, err := paymentsPayPal(c.Ctx, "POST", "/v2/checkout/orders/"+orderID+"/capture", M{})
		if err != nil {
			return err
		}
		var capt M
		if pu, ok := cp["purchase_units"].([]any); ok && len(pu) > 0 {
			pm, _ := commerceRow(pu[0])["payments"].(M)
			if caps, ok := pm["captures"].([]any); ok && len(caps) > 0 {
				capt = commerceRow(caps[0])
			}
		}
		am, _ := capt["amount"].(M)
		got := roundJS(f64(am["value"]) * 100)
		if str(cp["status"]) != "COMPLETED" || got < paymentsTotal(p) {
			return fail(http.StatusPaymentRequired, "PayPal did not complete the payment. Please try again.")
		}
		via := "paypal"
		if src, ok := cp["payment_source"].(M); ok && truthy(src["venmo"]) {
			via = "venmo"
		}
		if _, err := c.Run(`UPDATE payments SET method = ? WHERE id = ?`, via, p["id"]); err != nil {
			return err
		}
		if err := c.paymentsFinish(p, "paypal", orderID, "paypal:"+str(capt["id"])); err != nil {
			return err
		}
		if err := c.AuditAs(nil, "pay.paypal", fmt.Sprintf("%s %s payment %d", via, dollars(got), i64(p["id"])), c.IP()); err != nil {
			return err
		}
		return c.JSON(M{"paid": true, "next": p["success_url"]})
	}, a.publicLim())

	// pay-to-handle: the customer says they sent it; staff confirm when it shows up
	claimSchema := valid.Ordered("app", valid.Enum("cashapp", "venmo", "paypalme", "zelle"), "name", valid.String().Trim().Min(1).Max(60))
	rt.pub("POST /api/pay/{token}/claim", func(c *C) error {
		p, err := c.paymentsMustToken()
		if err != nil {
			return err
		}
		b, err := c.Body(claimSchema)
		if err != nil {
			return err
		}
		s := c.S()
		app := str(b["app"])
		if s["pay_handles_enabled"] != "1" || paymentsHandles(s)[app] == "" {
			return bad("That way to pay is not available")
		}
		if str(p["status"]) == "paid" {
			return c.JSON(M{"ok": true, "paid": true})
		}
		if _, err := c.Run(`UPDATE payments SET claim_app = ?, claim_name = ?, claimed_at = ? WHERE id = ?`, app, b["name"], store.Now(), p["id"]); err != nil {
			return err
		}
		appName := map[string]string{"cashapp": "Cash App", "venmo": "Venmo", "paypalme": "PayPal", "zelle": "Zelle"}[app]
		forText := ""
		if truthy(p["descr"]) {
			forText = " for " + str(p["descr"])
		}
		msg := fmt.Sprintf("%s says they sent %s by %s%s. Check, then confirm it.", str(b["name"]), dollars(paymentsTotal(p)), appName, forText)
		c.Emit("staff", "pay:claim", M{"id": p["id"], "text": msg})
		c.Notify("payments")
		a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": s["business_name"] + ": confirm a payment", "body": msg, "tag": fmt.Sprintf("claim-%d", i64(p["id"])), "url": "/orders"}, 0)
		if err := c.AuditAs(nil, "pay.claim", msg, c.IP()); err != nil {
			return err
		}
		return c.OK()
	}, a.publicLim())
	rt.staff("GET /payments/claims", "staff", func(c *C) error {
		rows, err := c.All(`SELECT id, amount_cents + tip_cents total_cents, descr, claim_app, claim_name, claimed_at, kind FROM payments WHERE claimed_at IS NOT NULL AND status <> 'paid' AND claimed_at > datetime('now','-3 days') ORDER BY claimed_at`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
	rt.staff("POST /payments/{id}/confirm", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		p, err := c.One(`SELECT * FROM payments WHERE id = ? AND status <> 'paid' AND claimed_at IS NOT NULL`, id)
		if err != nil {
			return err
		}
		if p == nil {
			return conflict("Already confirmed")
		}
		app := str(p["claim_app"])
		if _, err := c.Run(`UPDATE payments SET method = ? WHERE id = ?`, p["claim_app"], p["id"]); err != nil {
			return err
		}
		if err := c.paymentsFinish(p, "manual:"+app, fmt.Sprintf("manual:%s:%d", app, c.U.ID), "manual:"+app); err != nil {
			return err
		}
		if err := c.Audit("pay.confirm", fmt.Sprintf("%s %s from %s", app, dollars(paymentsTotal(p)), str(p["claim_name"]))); err != nil {
			return err
		}
		c.Notify("payments")
		return c.OK()
	})
	rt.staff("POST /payments/{id}/reject", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		p, err := c.One(`SELECT * FROM payments WHERE id = ? AND status <> 'paid'`, id)
		if err != nil {
			return err
		}
		if p == nil {
			return conflict("Already confirmed")
		}
		if _, err := c.Run(`UPDATE payments SET claimed_at = NULL WHERE id = ?`, p["id"]); err != nil {
			return err
		}
		if err := c.Audit("pay.reject", fmt.Sprintf("%s from %s", paymentsJSStr(p["claim_app"]), paymentsJSStr(p["claim_name"]))); err != nil {
			return err
		}
		c.Notify("payments")
		return c.OK()
	})

	// Square tells us when a payment completes, even if the customer closes the page
	rt.pub("POST /api/square/webhook", func(c *C) error {
		sq := paymentsSQ()
		if sq.hook == "" {
			return commerceText(c, http.StatusNotFound, "")
		}
		body := commerceRawBody(c)
		base := strings.TrimRight(a.cfg.PublicURL, "/")
		if a.cfg.PublicURL == "" {
			base = c.PublicBase()
		}
		mac := hmac.New(sha256.New, []byte(sq.hook))
		mac.Write([]byte(base + "/api/square/webhook" + body))
		expect := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		got := c.R.Header.Get("X-Square-Hmacsha256-Signature")
		if len(got) != len(expect) || subtle.ConstantTimeCompare([]byte(got), []byte(expect)) != 1 {
			return commerceText(c, http.StatusBadRequest, "bad signature")
		}
		var ev M
		if json.Unmarshal([]byte(body), &ev) != nil {
			return commerceText(c, http.StatusBadRequest, "")
		}
		data, _ := ev["data"].(M)
		obj, _ := data["object"].(M)
		pay, _ := obj["payment"].(M)
		if str(pay["status"]) == "COMPLETED" && truthy(pay["order_id"]) {
			for _, slug := range a.allSlugs(c.Ctx) {
				if err := commerceIn(c, slug, func(c *C) error {
					p, err := c.One(`SELECT * FROM payments WHERE provider = 'square' AND provider_ref = ? AND status <> 'paid'`, str(pay["order_id"]))
					if err != nil || p == nil {
						return err
					}
					return c.paymentsFinish(p, "square", str(pay["order_id"]), "square:"+str(pay["id"]))
				}); err != nil {
					a.log.Error("square webhook", "location", slug, "err", err)
				}
			}
		}
		return c.OK()
	})

	/* ---------------- Square Terminal (counter card reader) ---------------- */
	pairSchema := valid.Object(map[string]valid.Schema{"name": valid.String().Trim().Min(1).Max(40)})
	rt.staff("POST /square/devices/code", "manager", func(c *C) error {
		if !paymentsSquareEnabled() {
			return fail(http.StatusServiceUnavailable, "Connect Square first: add your Square access token and location ID in Railway.")
		}
		b, err := c.Body(pairSchema)
		if err != nil {
			return err
		}
		r, err := paymentsSquare(c.Ctx, "POST", "/v2/devices/codes", M{"idempotency_key": paymentsUUID(), "device_code": M{"product_type": "TERMINAL_API", "location_id": paymentsSQ().loc, "name": b["name"]}})
		if err != nil {
			return err
		}
		if err := c.Audit("square.pair", str(b["name"])); err != nil {
			return err
		}
		dc, _ := r["device_code"].(M)
		return c.JSON(M{"code": dc["code"], "expires": dc["pair_by"]})
	})

	rt.staff("GET /payments/providers", "manager", func(c *C) error {
		out := c.paymentsProvidersStatus()
		out["handles"] = paymentsHandles(c.S())
		out["handlesOn"] = c.S()["pay_handles_enabled"] == "1"
		return c.JSON(out)
	})
	_ = math.Abs
}

// paymentsJSStr is `${v}` in JavaScript (null -> "null").
func paymentsJSStr(v any) string {
	if v == nil {
		return "null"
	}
	return str(v)
}
