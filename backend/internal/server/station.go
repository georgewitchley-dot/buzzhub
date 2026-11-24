package server

// Port of server/src/station.js: server workstation (fire a table's next course), rush/VIP tickets,
// prep batch recipes, delivery photos, pre-orders with bookings, "same again" on tabs, gift cards and
// member perks on table checks, server checkout.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

func init() { modules = append(modules, (*App).registerStation) }

var stationPriority = map[int64]string{1: "RUSH", 2: "VIP"}

// stationPJ is station.js pj(): JSON.parse(v) ?? d.
func stationPJ(v any, d any) any {
	if r := kdsPJ(v, d); r != nil {
		return r
	}
	return d
}

func (c *C) stationHeldFor(tableID any) ([]store.Row, error) {
	return c.All(`SELECT oi.course, COUNT(*) n, GROUP_CONCAT(oi.qty || ' ' || oi.name, ', ') items FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND o.status IN ('open','sent','ready') AND oi.fired_at IS NULL AND oi.course > 1 GROUP BY oi.course ORDER BY oi.course`, tableID)
}

func (c *C) stationSetPriority(orderID any, p int64, user *auth.User, by string) error {
	o, err := c.One(`SELECT * FROM orders WHERE id = ?`, orderID)
	if err != nil {
		return err
	}
	if o == nil {
		return notFound("Not found")
	}
	if _, err := c.Run(`UPDATE orders SET priority = ? WHERE id = ?`, p, o["id"]); err != nil {
		return err
	}
	name := stationPriority[p]
	if name == "" {
		name = "normal"
	}
	if by != "" {
		name += " (" + by + ")"
	}
	if err := c.AuditAs(user, "order.priority", fmt.Sprintf("#%s %s", kdsJS(o["number"]), name), c.IP()); err != nil {
		return err
	}
	c.Notify("orders")
	return nil
}

// stationLineJSON is JSON.stringify of validated pre-order lines (zod keeps the schema's key order).
func stationLineJSON(lines []any) string {
	parts := []string{}
	for _, x := range lines {
		l, _ := x.(map[string]any)
		var sb strings.Builder
		sb.WriteByte('{')
		first := true
		for _, k := range []string{"itemId", "qty", "mods", "note"} {
			v, ok := l[k]
			if !ok {
				continue
			}
			if !first {
				sb.WriteByte(',')
			}
			first = false
			kb, _ := json.Marshal(k)
			vb, _ := json.Marshal(v)
			sb.Write(kb)
			sb.WriteByte(':')
			sb.Write(vb)
		}
		sb.WriteByte('}')
		parts = append(parts, sb.String())
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func stationLinesText(priced []M) string {
	p := []string{}
	for _, l := range priced {
		p = append(p, fmt.Sprintf("%d %s", i64(l["qty"]), str(l["name"])))
	}
	return strings.Join(p, ", ")
}

// stationCheckout: one person's server checkout for a day.
func (c *C) stationCheckout(userID any, date string) (M, error) {
	start, end := c.kdsDayBounds(date)
	u, err := c.One(`SELECT id, name, tip_role FROM users WHERE id = ?`, userID)
	if err != nil {
		return nil, err
	}
	shifts, err := c.All(`SELECT * FROM shifts WHERE user_id = ? AND clock_in < ? AND COALESCE(clock_out, datetime('now')) > ? ORDER BY clock_in`, userID, end, start)
	if err != nil {
		return nil, err
	}
	sales, err := c.Get(`SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents - discount_cents),0) net, COALESCE(SUM(tax_cents),0) tax, COALESCE(SUM(tip_cents),0) tips FROM orders WHERE created_by = ? AND paid_at >= ? AND paid_at < ? AND status <> 'void'`, userID, start, end)
	if err != nil {
		return nil, err
	}
	cashOrders, err := c.Get(`SELECT COALESCE(SUM(total_cents),0) c, COALESCE(SUM(tip_cents),0) t FROM orders WHERE created_by = ? AND paid_at >= ? AND paid_at < ? AND status <> 'void' AND payment_method = 'cash' AND id NOT IN (SELECT order_id FROM bill_orders)`, userID, start, end)
	if err != nil {
		return nil, err
	}
	cashBills, err := c.Get(`SELECT COALESCE(SUM(amount_cents + tip_cents),0) c, COALESCE(SUM(tip_cents),0) t FROM payments WHERE user_id = ? AND method = 'cash' AND status = 'paid' AND paid_at >= ? AND paid_at < ?`, userID, start, end)
	if err != nil {
		return nil, err
	}
	cashTips := i64(cashOrders["t"]) + i64(cashBills["t"])
	cardTips := i64(sales["tips"]) - cashTips
	if cardTips < 0 {
		cardTips = 0
	}
	var declared int64
	hours := 0.0
	still := false
	lines := map[string]int64{}
	order := []string{}
	for _, s := range shifts {
		declared += i64(s["declared_tips_cents"])
		end := s["clock_out"]
		if !truthy(end) {
			end = kdsNowSQL()
			still = true
		}
		hours += math.Max(0, (kdsMs(end)-kdsMs(s["clock_in"]))/3600000-f64(s["break_minutes"])/60)
		t, err := c.lineShiftTipout(userID, s)
		if err != nil {
			return nil, err
		}
		if tm, ok := t.(M); ok {
			for _, l := range tm["lines"].([]M) {
				k := kdsJS(l["to"])
				if _, ok := lines[k]; !ok {
					order = append(order, k)
				}
				lines[k] += i64(l["cents"])
			}
		}
	}
	tipouts := []M{}
	var tipoutCents int64
	for _, k := range order {
		tipouts = append(tipouts, M{"to": k, "cents": lines[k]})
		tipoutCents += lines[k]
	}
	cash := i64(cashOrders["c"]) + i64(cashBills["c"])
	var user any
	if u != nil {
		user = u
	}
	return M{"date": date, "user": user, "hours": kdsR2(hours), "stillOn": still, "checks": sales["n"], "salesCents": sales["net"], "taxCents": sales["tax"],
		"cashCollectedCents": cash, "cardTipsCents": cardTips, "cashTipsCents": cashTips, "declaredTipsCents": declared,
		"tipouts": tipouts, "tipoutCents": tipoutCents,
		"dueToHouseCents": cash - cashTips - cardTips, "takeHomeTipsCents": cardTips + cashTips + declared - tipoutCents}, nil
}

var (
	stationJpegRE = regexp.MustCompile(`^data:image/jpeg;base64,[A-Za-z0-9+/=]+$`)
	stationTokRE  = regexp.MustCompile(`^[A-Za-z0-9_-]{16}$`)
	stationDateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	stationNonDig = regexp.MustCompile(`\D`)
)

func stationSendJpeg(c *C, data string, cache string) error {
	parts := strings.SplitN(data, ",", 2)
	b := []byte{}
	if len(parts) == 2 {
		b, _ = base64.StdEncoding.DecodeString(parts[1])
	}
	c.W.Header().Set("Content-Type", "image/jpeg")
	if cache != "" {
		c.W.Header().Set("Cache-Control", cache)
	}
	_, _ = c.W.Write(b)
	return nil
}

func (a *App) registerStation(rt *router) {
	/* ===== fire a table's next course from the workstation ===== */
	rt.staff("GET /tables/{id}/held", "staff", func(c *C) error {
		tid := c.kdsPID("id")
		held, err := c.stationHeldFor(tid)
		if err != nil {
			return err
		}
		for _, h := range held {
			h["fireIn"] = nil
			if h["pace"], err = c.G("coursePace", tid, h["course"]); err != nil {
				return err
			}
		}
		return c.JSON(held)
	})
	rt.staff("POST /tables/{id}/fire-course", "staff", func(c *C) error {
		tid := c.kdsPID("id")
		held, err := c.stationHeldFor(tid)
		if err != nil {
			return err
		}
		if len(held) == 0 {
			return conflict("Nothing is waiting to be fired")
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"course": valid.Int().Min(2).Max(3).Optional()}))
		if err != nil {
			return err
		}
		course := held[0]["course"]
		if truthy(b["course"]) {
			course = b["course"]
		}
		orders, err := c.All(`SELECT DISTINCT o.id, o.number, o.status FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.table_id = ? AND o.status IN ('open','sent','ready') AND oi.fired_at IS NULL AND oi.course = ? ORDER BY o.id`, tid, course)
		if err != nil {
			return err
		}
		nums := []string{}
		for _, o := range orders {
			if _, err := c.Run(`UPDATE order_items SET fired_at = datetime('now') WHERE order_id = ? AND fired_at IS NULL AND course = ?`, o["id"], course); err != nil {
				return err
			}
			if str(o["status"]) == "ready" {
				if _, err := c.Run(`UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?`, o["id"]); err != nil {
					return err
				}
			}
			if c.Has("printTickets") {
				c.kdsSavepoint(func() error { _, e := c.G("printTickets", o["id"], false, course); return e })
			}
			nums = append(nums, "#"+kdsJS(o["number"]))
		}
		label := "undefined"
		if t, err := c.One(`SELECT label FROM tables WHERE id = ?`, tid); err != nil {
			return err
		} else if t != nil {
			label = kdsJS(t["label"])
		}
		if err := c.Audit("order.fire", fmt.Sprintf("%s %s course %s (%s)", c.S()["unit_label"], label, kdsJS(course), strings.Join(nums, " "))); err != nil {
			return err
		}
		c.Notify("orders")
		return c.JSON(M{"ok": true, "course": course, "orders": len(orders)})
	})

	/* ===== rush / VIP tickets ===== */
	rt.staff("POST /orders/{id}/priority", "staff", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"priority": valid.Int().Min(0).Max(2)}))
		if err != nil {
			return err
		}
		if err := c.stationSetPriority(c.kdsPID("id"), i64(b["priority"]), c.U, ""); err != nil {
			return err
		}
		return c.OK()
	})
	rt.pub("POST /api/kds/priority", func(c *C) error {
		w, err := c.kdsWho(false)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("orderId", valid.Int(), "priority", valid.Int().Min(0).Max(2)))
		if err != nil {
			return err
		}
		by := ""
		if w.user == nil {
			by = w.area + " screen"
		}
		if err := c.stationSetPriority(b["orderId"], i64(b["priority"]), w.user, by); err != nil {
			return err
		}
		return c.OK()
	})

	/* ===== prep batch recipes ===== */
	a.G["prepRecipe"] = func(c *C, args ...any) (any, error) {
		rows, err := c.All(`SELECT g.id, g.name, g.unit, r.qty FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ? ORDER BY g.name`, args[0])
		if err != nil {
			return nil, err
		}
		qty := kdsNum(args[1])
		out := []M{}
		for _, r := range rows {
			out = append(out, M{"id": r["id"], "name": r["name"], "unit": r["unit"], "per": r["qty"], "total": kdsOut(kdsR2(f64(r["qty"]) * qty))})
		}
		return out, nil
	}

	/* ===== delivery photos ===== */
	rt.staff("POST /orders/{id}/drop-photo", "staff", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"photo": valid.String().Max(400000)}))
		if err != nil {
			return err
		}
		photo := str(b["photo"])
		if !stationJpegRE.MatchString(photo) {
			return bad("Bad photo")
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ? AND fulfillment = 'delivery'`, c.kdsPID("id"))
		if err != nil {
			return err
		}
		if o == nil {
			return notFound("Not found")
		}
		if _, err := c.Run(`INSERT OR REPLACE INTO delivery_photos (order_id, data) VALUES (?, ?)`, o["id"], photo); err != nil {
			return err
		}
		if err := c.Audit("delivery.photo", "#"+kdsJS(o["number"])); err != nil {
			return err
		}
		if truthy(o["guest_id"]) {
			if err := c.pushGuest(i64(o["guest_id"])); err != nil {
				return err
			}
		}
		c.Notify("orders")
		return c.OK()
	})
	a.G["dropPhotoFor"] = func(c *C, args ...any) (any, error) {
		r, err := c.One(`SELECT 1 FROM delivery_photos WHERE order_id = ?`, args[0])
		return r != nil, err
	}
	rt.pub("GET /api/g/{token}/drop-photo", func(c *C) error {
		g, err := c.One(`SELECT order_id FROM guests WHERE token = ?`, c.Param("token"))
		if err != nil {
			return err
		}
		if g == nil || !truthy(g["order_id"]) {
			c.W.WriteHeader(http.StatusNotFound)
			return nil
		}
		p, err := c.One(`SELECT data FROM delivery_photos WHERE order_id = ?`, g["order_id"])
		if err != nil {
			return err
		}
		if p == nil {
			c.W.WriteHeader(http.StatusNotFound)
			return nil
		}
		return stationSendJpeg(c, str(p["data"]), "private, max-age=600")
	}, a.publicLim())
	rt.staff("GET /orders/{id}/drop-photo", "staff", func(c *C) error {
		p, err := c.One(`SELECT data FROM delivery_photos WHERE order_id = ?`, c.kdsPID("id"))
		if err != nil {
			return err
		}
		if p == nil {
			c.W.WriteHeader(http.StatusNotFound)
			return nil
		}
		return stationSendJpeg(c, str(p["data"]), "")
	})

	/* ===== pre-order with a booking ===== */
	preLine := valid.Array(valid.Ordered("itemId", valid.Int(), "qty", valid.Int().Min(1).Max(20), "mods", valid.Array(valid.Int()).Max(20).Optional(), "note", valid.String().Max(80).Optional())).Max(30)
	rt.pub("PUT /api/c/bookings/{id}/preorder", func(c *C) error {
		cu, err := c.requireCustomer()
		if err != nil {
			return err
		}
		if c.S()["booking_preorder"] != "1" {
			return forbidden("Pre-ordering is not available")
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"lines": preLine}))
		if err != nil {
			return err
		}
		lines, _ := b["lines"].([]any)
		bk, err := c.One(`SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'booked'`, c.kdsPID("id"), cu.ID)
		if err != nil {
			return err
		}
		if bk == nil {
			return notFound("Booking not found")
		}
		priced := []M{}
		if len(lines) > 0 {
			if priced, err = c.priceLines(lines, false); err != nil {
				return err
			}
		}
		var pre any
		if len(lines) > 0 {
			pre = stationLineJSON(lines)
		}
		if _, err := c.Run(`UPDATE bookings SET preorder = ? WHERE id = ?`, pre, bk["id"]); err != nil {
			return err
		}
		text := stationLinesText(priced)
		if text == "" {
			text = "cleared"
		}
		if err := c.AuditAs(nil, "booking.preorder", fmt.Sprintf("#%s: %s", kdsJS(bk["id"]), text), c.IP()); err != nil {
			return err
		}
		c.Notify("bookings")
		items := []M{}
		var sub int64
		for _, l := range priced {
			items = append(items, M{"name": l["name"], "qty": l["qty"], "cents": i64(l["price_cents"]) * i64(l["qty"])})
			sub += i64(l["price_cents"]) * i64(l["qty"])
		}
		return c.JSON(M{"ok": true, "items": items, "subtotalCents": sub})
	})
	a.G["preorderSummary"] = func(c *C, args ...any) (any, error) {
		bk, _ := args[0].(map[string]any)
		lines := kdsList(stationPJ(bk["preorder"], []any{}))
		if len(lines) == 0 {
			return nil, nil
		}
		for _, l := range lines {
			if _, ok := l.(map[string]any); !ok {
				return "Pre-order (some dishes are no longer available)", nil
			}
		}
		priced, err := c.priceLines(lines, false)
		var he *HTTPError
		if errors.As(err, &he) {
			return "Pre-order (some dishes are no longer available)", nil
		}
		if err != nil {
			return nil, err
		}
		return stationLinesText(priced), nil
	}
	prevCheckin := a.G["onBookingCheckin"]
	a.G["onBookingCheckin"] = func(c *C, args ...any) (any, error) {
		if prevCheckin != nil {
			if _, err := prevCheckin(c, args...); err != nil {
				return nil, err
			}
		}
		bk, _ := args[0].(map[string]any)
		var cname string
		var cid any
		switch cu := args[1].(type) {
		case *auth.Customer:
			cname, cid = cu.Name, cu.ID
		case map[string]any:
			cname, cid = str(cu["name"]), cu["id"]
		}
		lines := kdsList(stationPJ(bk["preorder"], []any{}))
		if len(lines) == 0 {
			return nil, nil
		}
		err := c.Tx.Savepoint(c.Ctx, func() error {
			fresh, err := c.Get(`SELECT guest_id FROM bookings WHERE id = ?`, bk["id"])
			if err != nil {
				return err
			}
			for _, l := range lines {
				if _, ok := l.(map[string]any); !ok {
					return bad("Bad pre-order")
				}
			}
			priced, err := c.priceLines(lines, false)
			if err != nil {
				return err
			}
			o, err := c.insertOrder(newOrder{Lines: priced, Status: "held", Source: "guest", GuestID: fresh["guest_id"], CustomerName: cname, Notes: "Booking pre-order"})
			if err != nil {
				return err
			}
			if _, err := c.Run(`UPDATE orders SET customer_id = ? WHERE id = ?`, cid, o.ID); err != nil {
				return err
			}
			if _, err := c.G("preorderCredit", bk, o.ID); err != nil {
				return err
			}
			if err := c.AuditAs(nil, "booking.preorder_held", fmt.Sprintf("#%d for %s", o.Number, cname), ""); err != nil {
				return err
			}
			c.Notify("orders")
			return nil
		})
		if err != nil {
			if aerr := c.AuditAs(nil, "booking.preorder_failed", cname+": "+err.Error(), ""); aerr != nil {
				return nil, aerr
			}
		}
		return nil, nil
	}

	/* ===== "same again" on tabs and tables ===== */
	rt.pub("GET /api/t/{token}/last-round", func(c *C) error {
		tok := c.Param("token")
		var t store.Row
		var err error
		if stationTokRE.MatchString(tok) {
			if t, err = c.One(`SELECT * FROM tables WHERE qr_token = ?`, tok); err != nil {
				return err
			}
		}
		if t == nil {
			return notFound("Not found")
		}
		var tab store.Row
		if q := c.Q("tab"); q != "" {
			if tab, err = c.One(`SELECT * FROM tabs WHERE token = ?`, q); err != nil {
				return err
			}
		}
		_, hasMember := c.R.URL.Query()["member"]
		member := ""
		if hasMember {
			r := []rune(c.Q("member"))
			if len(r) > 30 {
				r = r[:30]
			}
			member = string(r)
		}
		var o store.Row
		if tab != nil {
			if member != "" {
				o, err = c.One(`SELECT * FROM orders WHERE tab_id = ? AND status <> 'void' AND tab_member = ? ORDER BY id DESC LIMIT 1`, tab["id"], member)
			} else {
				o, err = c.One(`SELECT * FROM orders WHERE tab_id = ? AND status <> 'void' ORDER BY id DESC LIMIT 1`, tab["id"])
			}
		} else {
			o, err = c.One(`SELECT * FROM orders WHERE table_id = ? AND source = 'table' AND status <> 'void' AND created_at > datetime('now','-6 hours') ORDER BY id DESC LIMIT 1`, t["id"])
		}
		if err != nil {
			return err
		}
		if o == nil {
			return c.JSON(M{"items": []any{}})
		}
		rows, err := c.All(`SELECT item_id, name, qty, mods, price_cents FROM order_items WHERE order_id = ? AND item_id IS NOT NULL AND price_cents > 0 ORDER BY id`, o["id"])
		if err != nil {
			return err
		}
		items := []M{}
		for _, i := range rows {
			ids, names := []any{}, []any{}
			for _, m := range kdsList(stationPJ(orEmptyList(i["mods"]), []any{})) {
				mm, _ := m.(map[string]any)
				if truthy(mm["id"]) {
					ids = append(ids, mm["id"])
				}
				if truthy(mm["name"]) {
					names = append(names, mm["name"])
				}
			}
			items = append(items, M{"itemId": i["item_id"], "name": i["name"], "qty": i["qty"], "mods": ids, "modNames": names, "unitCents": i["price_cents"], "cents": i64(i["price_cents"]) * i64(i["qty"])})
		}
		return c.JSON(M{"number": o["number"], "items": items})
	}, a.publicLim())

	/* ===== gift cards and member perks on a table check ===== */
	openBill := func(c *C) (store.Row, []store.Row, error) {
		bill, err := c.One(`SELECT * FROM bills WHERE id = ?`, c.kdsPID("id"))
		if err != nil {
			return nil, nil, err
		}
		if bill == nil || str(bill["status"]) != "open" {
			return nil, nil, conflict("This check is already settled")
		}
		return bill, nil, nil
	}
	billOrders := func(c *C, bill store.Row) ([]store.Row, error) {
		return c.All(`SELECT o.* FROM orders o JOIN bill_orders bo ON bo.order_id = o.id WHERE bo.bill_id = ? AND o.paid_at IS NULL AND o.status <> 'void' ORDER BY o.id`, bill["id"])
	}
	rt.staff("POST /bills/{id}/gift", "staff", func(c *C) error {
		bill, _, err := openBill(c)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"code": valid.String().Trim().Max(30)}))
		if err != nil {
			return err
		}
		orders, err := billOrders(c, bill)
		if err != nil {
			return err
		}
		var used int64
		var balance any
		for _, o := range orders {
			if !c.Has("applyGift") {
				break
			}
			r, err := c.G("applyGift", o, b["code"], c.U)
			if err != nil {
				return err
			}
			rm, _ := r.(map[string]any)
			if rm == nil {
				break
			}
			used += i64(rm["used"])
			balance = rm["balance"]
			if f64(rm["balance"]) <= 0 {
				break
			}
		}
		if used == 0 {
			return conflict("Nothing was taken off: check the code and balance")
		}
		if err := c.Audit("gift.redeem", fmt.Sprintf("check %s: $%s", kdsJS(bill["id"]), dollars(used))); err != nil {
			return err
		}
		c.Notify("orders")
		return c.JSON(M{"ok": true, "usedCents": used, "cardBalanceCents": balance})
	})
	rt.staff("POST /bills/{id}/member", "staff", func(c *C) error {
		bill, _, err := openBill(c)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"customerId": valid.Int()}))
		if err != nil {
			return err
		}
		cu, err := c.One(`SELECT * FROM customers WHERE id = ?`, b["customerId"])
		if err != nil {
			return err
		}
		if cu == nil {
			return notFound("Customer not found")
		}
		orders, err := billOrders(c, bill)
		if err != nil {
			return err
		}
		var off int64
		var plan any
		for _, o := range orders {
			if truthy(o["customer_id"]) && i64(o["customer_id"]) != i64(cu["id"]) {
				continue
			}
			sub := i64(o["subtotal_cents"])
			var d map[string]any
			if c.Has("memberDiscount") {
				r, err := c.G("memberDiscount", cu["id"], sub)
				if err != nil {
					return err
				}
				d, _ = r.(map[string]any)
			}
			if _, err := c.Run(`UPDATE orders SET customer_id = ? WHERE id = ?`, cu["id"], o["id"]); err != nil {
				return err
			}
			if d == nil || i64(d["cents"]) <= i64(o["discount_cents"]) {
				continue
			}
			dc := i64(d["cents"])
			extra := dc - i64(o["discount_cents"])
			if truthy(d["plan"]) {
				plan = d["plan"]
			} else if truthy(d["tier"]) {
				plan = d["tier"]
			}
			tax := roundJS(float64(sub-dc) * kdsNum(c.S()["tax_rate"]) / 100)
			if _, err := c.Run(`UPDATE orders SET discount_cents = ?, tax_cents = ?, total_cents = ? WHERE id = ?`, dc, tax, sub-dc+tax+i64(o["fee_cents"]), o["id"]); err != nil {
				return err
			}
			off += extra
		}
		perk := "no perk"
		if off != 0 {
			perk = "$" + dollars(off) + " off"
		}
		if err := c.Audit("member.perk", fmt.Sprintf("check %s: %s %s", kdsJS(bill["id"]), str(cu["name"]), perk)); err != nil {
			return err
		}
		c.Notify("orders")
		return c.JSON(M{"ok": true, "offCents": off, "plan": plan, "name": cu["name"]})
	})

	rt.staff("GET /customer-find", "staff", func(c *C) error {
		q := []rune(strings.TrimSpace(c.Q("q")))
		if len(q) > 40 {
			q = q[:40]
		}
		qs := strings.TrimSpace(string(q))
		if len([]rune(qs)) < 3 {
			return c.JSON([]any{})
		}
		digits := stationNonDig.ReplaceAllString(qs, "")
		var rows []store.Row
		var err error
		if len(digits) >= 4 {
			rows, err = c.All(`SELECT id, name, phone FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY visits DESC, id LIMIT 8`, "%"+qs+"%", "%"+digits+"%")
		} else {
			rows, err = c.All(`SELECT id, name, phone FROM customers WHERE name LIKE ? ORDER BY visits DESC, id LIMIT 8`, "%"+qs+"%")
		}
		if err != nil {
			return err
		}
		out := []M{}
		for _, r := range rows {
			var plan, end any
			if c.Has("memberDiscount") {
				d, err := c.G("memberDiscount", r["id"], int64(10000))
				if err != nil {
					return err
				}
				if dm, ok := d.(map[string]any); ok && dm != nil {
					p := "Member"
					if truthy(dm["plan"]) {
						p = kdsJS(dm["plan"])
					}
					plan = fmt.Sprintf("%s %s%%", p, kdsJS(dm["pct"]))
				}
			}
			if truthy(r["phone"]) {
				ph := []rune(kdsJS(r["phone"]))
				if len(ph) > 4 {
					ph = ph[len(ph)-4:]
				}
				end = string(ph)
			}
			out = append(out, M{"id": r["id"], "name": r["name"], "phoneEnd": end, "plan": plan})
		}
		return c.JSON(out)
	})

	/* ===== server checkout ===== */
	a.G["serverCheckout"] = func(c *C, args ...any) (any, error) { return c.stationCheckout(args[0], kdsJS(args[1])) }
	dateOf := func(c *C) string {
		if d := c.Q("date"); stationDateRE.MatchString(d) {
			return d
		}
		return c.kdsLocalToday()
	}
	rt.staff("GET /me/checkout", "staff", func(c *C) error {
		r, err := c.stationCheckout(c.U.ID, dateOf(c))
		if err != nil {
			return err
		}
		return c.JSON(r)
	})
	rt.staff("GET /checkouts", "manager", func(c *C) error {
		date := dateOf(c)
		start, end := c.kdsDayBounds(date)
		ids, err := c.All(`SELECT DISTINCT user_id FROM shifts WHERE clock_in < ? AND COALESCE(clock_out, datetime('now')) > ? ORDER BY user_id`, end, start)
		if err != nil {
			return err
		}
		people := []M{}
		for _, r := range ids {
			co, err := c.stationCheckout(r["user_id"], date)
			if err != nil {
				return err
			}
			if truthy(co["checks"]) || truthy(co["hours"]) {
				people = append(people, co)
			}
		}
		return c.JSON(M{"date": date, "people": people})
	})
}
