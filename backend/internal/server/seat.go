package server

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of seat.js: join tables, seat allergies, split by seat, top dishes, prep leftovers, prepay
// pre-orders, proof on receipts, ticket recall list, auto-VIP, course pacing hints.

func init() { modules = append(modules, (*App).registerSeat) }

/* ---------- joined tables ---------- */

func (c *C) seatJoinedSeats(t store.Row) (int64, error) {
	n, err := c.Val(`SELECT COALESCE(SUM(seats),0) n FROM tables WHERE joined_to = ?`, t["id"])
	if err != nil {
		return 0, err
	}
	seats := i64(t["seats"])
	if seats == 0 {
		seats = 4
	}
	return seats + i64(n), nil
}

func (c *C) seatJoinedTo() (map[int64]any, error) {
	rows, err := c.All(`SELECT t.id, j.label FROM tables t JOIN tables j ON j.id = t.joined_to`)
	out := map[int64]any{}
	for _, r := range rows {
		out[i64(r["id"])] = r["label"]
	}
	return out, err
}

func (c *C) seatJoinedWith(id any) ([]any, error) {
	rows, err := c.All(`SELECT label FROM tables WHERE joined_to = ? ORDER BY label`, id)
	out := []any{}
	for _, r := range rows {
		out = append(out, r["label"])
	}
	return out, err
}

/* ---------- seat allergies ---------- */

func (c *C) seatApplyAllergies(orderID, tableID any) error {
	if !truthy(tableID) {
		return nil
	}
	rows, err := c.All(`SELECT seat, allergy FROM seat_allergies WHERE table_id = ? AND allergy <> ''`, tableID)
	if err != nil || len(rows) == 0 {
		return err
	}
	al := map[int64]string{}
	for _, r := range rows {
		al[i64(r["seat"])] = str(r["allergy"])
	}
	var found []string
	seen := map[string]bool{}
	items, err := c.All(`SELECT id, seat, note FROM order_items WHERE order_id = ? AND seat > 0`, orderID)
	if err != nil {
		return err
	}
	for _, i := range items {
		a := al[i64(i["seat"])]
		if a == "" {
			continue
		}
		f := fmt.Sprintf("Seat %d: %s", i64(i["seat"]), a)
		if !seen[f] {
			seen[f] = true
			found = append(found, f)
		}
		note := "ALLERGY " + a
		if truthy(i["note"]) {
			note += " · " + str(i["note"])
		}
		if _, err := c.Run(`UPDATE order_items SET note = ? WHERE id = ?`, tableSlice(note, 160), i["id"]); err != nil {
			return err
		}
	}
	if len(found) > 0 {
		o, err := c.Get(`SELECT allergy_note FROM orders WHERE id = ?`, orderID)
		if err != nil {
			return err
		}
		parts := []string{}
		if truthy(o["allergy_note"]) {
			parts = append(parts, str(o["allergy_note"]))
		}
		parts = append(parts, found...)
		if _, err := c.Run(`UPDATE orders SET allergy_note = ? WHERE id = ?`, tableSlice(strings.Join(parts, "; "), 300), orderID); err != nil {
			return err
		}
	}
	return nil
}

/* ---------- prep leftovers ---------- */

func (c *C) seatPrepLeftovers(lines []M, by string, user any) (M, error) {
	date := c.tableToday()
	var cost float64
	var n, rolled int64
	for _, l := range lines {
		if !truthy(l["qty"]) {
			continue
		}
		hit, err := c.One(`SELECT 1 FROM prep_leftovers WHERE date = ? AND item_id = ?`, date, l["itemId"])
		if err != nil {
			return nil, err
		}
		if hit != nil {
			continue
		}
		keeps, err := c.serveLeftoverKeeps(l["itemId"])
		if err != nil {
			return nil, err
		}
		if keeps {
			if err := c.serveRollLeftover(l["itemId"], i64(l["qty"]), by); err != nil {
				return nil, err
			}
			rolled++
		} else {
			note := "Leftover at close"
			if by != "" {
				note += " (" + by + ")"
			}
			w, err := c.G("logWaste", M{"itemId": l["itemId"], "qty": l["qty"], "reason": "over-prepped", "note": note}, user)
			if err != nil {
				return nil, err
			}
			cost += f64(w)
		}
		if _, err := c.Run(`INSERT INTO prep_leftovers (date, item_id, qty, by_label) VALUES (?, ?, ?, ?)`, date, l["itemId"], l["qty"], orNil(by)); err != nil {
			return nil, err
		}
		n++
	}
	if n > 0 {
		es := "es"
		if n == 1 {
			es = ""
		}
		if err := c.AuditAs(tableUser(user), "prep.leftovers", fmt.Sprintf("%d dish%s, $%.2f", n, es, cost/100), ""); err != nil {
			return nil, err
		}
		c.Notify("waste")
	}
	return M{"logged": n, "rolled": rolled, "wasted": n - rolled, "costCents": tableNumAny(cost)}, nil
}

/* ---------- proof of delivery ---------- */

func (c *C) seatProofFor(orderID any) (any, error) {
	ph, err := c.One(`SELECT 1 FROM delivery_photos WHERE order_id = ?`, orderID)
	if err != nil {
		return nil, err
	}
	sg, err := c.One(`SELECT name FROM delivery_signatures WHERE order_id = ?`, orderID)
	if err != nil {
		return nil, err
	}
	if ph == nil && sg == nil {
		return nil, nil
	}
	var by any
	if sg != nil {
		by = orNil(sg["name"])
	}
	return M{"photo": ph != nil, "signature": sg != nil, "signedBy": by}, nil
}

/* ---------- ticket recall list ---------- */

func (c *C) seatRecentDone(area any, isAll bool) ([]store.Row, error) {
	if isAll {
		return c.All(`SELECT o.id, o.number, o.customer_name, t.label table_label, COALESCE(o.ready_at, o.paid_at) done_at FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.status IN ('ready','paid') AND COALESCE(o.ready_at, o.paid_at) > datetime('now','-16 hours') AND o.sent_at IS NOT NULL ORDER BY COALESCE(o.ready_at, o.paid_at) DESC LIMIT 20`)
	}
	return c.All(`SELECT o.id, o.number, o.customer_name, t.label table_label, MAX(oi.done_at) done_at, GROUP_CONCAT(oi.qty || ' ' || oi.name, ', ') items FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN tables t ON t.id = o.table_id WHERE oi.done_station = ? AND oi.done_at > datetime('now','-16 hours') GROUP BY o.id, t.label ORDER BY MAX(oi.done_at) DESC LIMIT 20`, area)
}

/* ---------- auto-VIP ---------- */

func (c *C) seatVipSweep() error {
	s := c.S()
	if s["auto_vip"] != "1" {
		return nil
	}
	min := tableJSNumber(s["auto_vip_spend_cents"])
	if math.IsNaN(min) {
		min = 0
	}
	rows, err := c.All(`SELECT id, number, customer_id FROM orders WHERE vip_checked = 0 AND status IN ('held','open','sent') AND created_at > datetime('now','-3 hours')`)
	if err != nil {
		return err
	}
	for _, o := range rows {
		if _, err := c.Run(`UPDATE orders SET vip_checked = 1 WHERE id = ?`, o["id"]); err != nil {
			return err
		}
		if o["customer_id"] == nil {
			continue
		}
		member := false
		if s["auto_vip_members"] != "0" {
			m, err := c.One(`SELECT 1 FROM memberships WHERE customer_id = ? AND status = 'active'`, o["customer_id"])
			if err != nil {
				return err
			}
			member = m != nil
		}
		var spend float64
		if min != 0 {
			v, err := c.Val(`SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE customer_id = ? AND paid_at > datetime('now','-365 days') AND status <> 'void'`, o["customer_id"])
			if err != nil {
				return err
			}
			spend = f64(v)
		}
		if member || (min != 0 && spend >= min) {
			r, err := c.Run(`UPDATE orders SET priority = 2 WHERE id = ? AND priority = 0`, o["id"])
			if err != nil {
				return err
			}
			if r.Changes > 0 {
				why := "top guest"
				if member {
					why = "member"
				}
				if err := c.AuditAs(nil, "order.auto_vip", fmt.Sprintf("#%s (%s)", str(o["number"]), why), ""); err != nil {
					return err
				}
				c.Notify("orders")
			}
		}
	}
	return nil
}

/* ---------- course pacing hints ---------- */

type seatGapCache struct {
	at int64
	by map[int64]int64
}

var (
	seatGapMu sync.Mutex
	seatGaps  = map[string]seatGapCache{}
)

func (c *C) seatTypicalGap(course int64) (any, error) {
	seatGapMu.Lock()
	gc, ok := seatGaps[c.Slug()]
	seatGapMu.Unlock()
	if !ok || nowMs()-gc.at > 10*60_000 {
		rows, err := c.All(`SELECT oi.order_id, oi.course, oi.fired_at, oi.done_at FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id IS NOT NULL AND o.created_at > datetime('now','-30 days') AND oi.course IS NOT NULL`)
		if err != nil {
			return nil, err
		}
		type fd struct{ fired, done []float64 }
		per := map[int64]map[int64]*fd{}
		for _, r := range rows {
			k := i64(r["order_id"])
			if per[k] == nil {
				per[k] = map[int64]*fd{}
			}
			cr := i64(r["course"])
			x := per[k][cr]
			if x == nil {
				x = &fd{}
				per[k][cr] = x
			}
			if truthy(r["fired_at"]) {
				x.fired = append(x.fired, tableMs(r["fired_at"]))
			}
			if truthy(r["done_at"]) {
				x.done = append(x.done, tableMs(r["done_at"]))
			}
		}
		gaps := map[int64][]float64{}
		for _, o := range per {
			for cr, x := range o {
				prev := o[cr-1]
				if cr < 2 || prev == nil || len(prev.done) == 0 || len(x.fired) == 0 {
					continue
				}
				mn, mx := math.Inf(1), math.Inf(-1)
				for _, f := range x.fired {
					mn = math.Min(mn, f)
				}
				for _, d := range prev.done {
					mx = math.Max(mx, d)
				}
				if g := (mn - mx) / 60000; g > 0 && g < 120 {
					gaps[cr] = append(gaps[cr], g)
				}
			}
		}
		by := map[int64]int64{}
		for cr, list := range gaps {
			if len(list) < 3 {
				continue
			}
			sort.Float64s(list)
			by[cr] = roundJS(list[len(list)/2])
		}
		gc = seatGapCache{at: nowMs(), by: by}
		seatGapMu.Lock()
		seatGaps[c.Slug()] = gc
		seatGapMu.Unlock()
	}
	if v, ok := gc.by[course]; ok {
		return v, nil
	}
	return nil, nil
}

func (c *C) seatCoursePace(tableID any, course int64) (M, error) {
	prev, err := c.Get(`SELECT MAX(oi.done_at) d, SUM(CASE WHEN oi.done_at IS NULL THEN 1 ELSE 0 END) waiting FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.table_id = ? AND o.status IN ('open','sent','ready') AND oi.course = ? AND oi.fired_at IS NOT NULL`, tableID, course-1)
	if err != nil {
		return nil, err
	}
	var party any
	if c.Has("partySizeAt") {
		if party, err = c.G("partySizeAt", tableID); err != nil {
			return nil, err
		}
	}
	var typical any
	if c.Has("partyGap") {
		if typical, err = c.G("partyGap", course, party); err != nil {
			return nil, err
		}
	}
	if typical == nil {
		if typical, err = c.seatTypicalGap(course); err != nil {
			return nil, err
		}
	}
	if typical == nil {
		d := c.S()["pace_default_minutes"]
		if d == "" {
			d = "15"
		}
		typical = tableNumAny(tableJSNumber(d))
	}
	cooking := fmt.Sprintf("Course %d is still cooking", course-1)
	if !truthy(prev["d"]) {
		var hint any
		if truthy(prev["waiting"]) {
			hint = cooking
		}
		return M{"typical": typical, "since": nil, "hint": hint, "due": false}, nil
	}
	if truthy(prev["waiting"]) {
		return M{"typical": typical, "since": nil, "hint": cooking, "due": false}, nil
	}
	since := roundJS((float64(nowMs()) - tableMs(prev["d"])) / 60000)
	if since < 0 {
		since = 0
	}
	ty := f64(typical)
	due := float64(since) >= ty
	tys := fmtJSNum(ty)
	hint := fmt.Sprintf("Course %d landed %d min ago. Usually fired at about %s min", course-1, since, tys)
	if due {
		hint = fmt.Sprintf("Course %d landed %d min ago; tables usually get the next course after %s", course-1, since, tys)
	}
	return M{"typical": typical, "since": since, "due": due, "hint": hint}, nil
}

/* ---------- register ---------- */

func (a *App) registerSeat(rt *router) {
	a.G["joinedSeats"] = func(c *C, args ...any) (any, error) { return c.seatJoinedSeats(tableRow(args[0])) }
	a.G["joinedTo"] = func(c *C, args ...any) (any, error) {
		m, err := c.seatJoinedTo()
		out := M{}
		for k, v := range m {
			out[itoa(k)] = v
		}
		return out, err
	}
	a.G["joinedWith"] = func(c *C, args ...any) (any, error) { return c.seatJoinedWith(args[0]) }
	a.G["applySeatAllergies"] = func(c *C, args ...any) (any, error) { return nil, c.seatApplyAllergies(args[0], args[1]) }
	// prepLeftovers(lines [{itemId, qty}], by string, user *auth.User)
	a.G["prepLeftovers"] = func(c *C, args ...any) (any, error) {
		by, user := "", any(nil)
		if len(args) > 1 {
			by = str(args[1])
		}
		if len(args) > 2 {
			user = args[2]
		}
		return c.seatPrepLeftovers(tableList(args[0]), by, user)
	}
	a.G["prepLeftoversToday"] = func(c *C, args ...any) (any, error) {
		rows, err := c.All(`SELECT item_id, qty FROM prep_leftovers WHERE date = ?`, c.tableToday())
		out := M{}
		for _, r := range rows {
			out[str(r["item_id"])] = r["qty"]
		}
		return out, err
	}
	// payHooks.preorder(payment row): Node's h.payHooks[kind]; the commerce port looks up "payHooks.<kind>".
	a.G["payHooks.preorder"] = func(c *C, args ...any) (any, error) {
		p := tableRow(args[0])
		meta, _ := jparse(orNil(p["meta"]), map[string]any{}).(map[string]any)
		var bid any
		if meta != nil {
			bid = meta["bookingId"]
		}
		bk, err := c.One(`SELECT * FROM bookings WHERE id = ?`, bid)
		if err != nil || bk == nil {
			return nil, err
		}
		amt := i64(p["amount_cents"])
		if _, err := c.Run(`UPDATE bookings SET preorder_paid_cents = preorder_paid_cents + ? WHERE id = ?`, amt, bk["id"]); err != nil {
			return nil, err
		}
		if bk["guest_id"] != nil {
			o, err := c.One(`SELECT * FROM orders WHERE guest_id = ? AND order_notes = 'Booking pre-order' AND paid_at IS NULL ORDER BY id DESC LIMIT 1`, bk["guest_id"])
			if err != nil {
				return nil, err
			}
			if o != nil {
				use := amt
				if left := i64(o["total_cents"]) - i64(o["gift_cents"]); left < use {
					use = left
				}
				if _, err := c.Run(`UPDATE orders SET gift_cents = gift_cents + ? WHERE id = ?`, use, o["id"]); err != nil {
					return nil, err
				}
			}
		}
		if err := c.AuditAs(nil, "booking.preorder_paid", fmt.Sprintf("#%s: $%s", str(bk["id"]), dollars(amt)), ""); err != nil {
			return nil, err
		}
		c.Notify("bookings")
		return nil, nil
	}
	a.G["preorderCredit"] = func(c *C, args ...any) (any, error) {
		bk := tableRow(args[0])
		paid, err := c.Val(`SELECT preorder_paid_cents FROM bookings WHERE id = ?`, bk["id"])
		if err != nil && !store.IsNoRows(err) {
			return nil, err
		}
		if i64(paid) == 0 {
			return nil, nil
		}
		o, err := c.Get(`SELECT * FROM orders WHERE id = ?`, args[1])
		if err != nil {
			return nil, err
		}
		use := i64(paid)
		if due := i64(o["subtotal_cents"]) - i64(o["discount_cents"]) + i64(o["tax_cents"]); due < use {
			use = due
		}
		if _, err := c.Run(`UPDATE orders SET gift_cents = gift_cents + ? WHERE id = ?`, use, o["id"]); err != nil {
			return nil, err
		}
		return nil, c.AuditAs(nil, "booking.preorder_credit", fmt.Sprintf("#%s: $%s paid ahead", str(o["number"]), dollars(use)), "")
	}
	// proofFor is also pro.js's proofHook.fn
	a.G["proofFor"] = func(c *C, args ...any) (any, error) { return c.seatProofFor(args[0]) }
	a.G["afterDelivered"] = func(c *C, args ...any) (any, error) {
		o := tableRow(args[0])
		if !truthy(o["contact_email"]) || !emailEnabled() {
			return nil, nil
		}
		p, err := c.seatProofFor(o["id"])
		if err != nil || p == nil {
			return nil, err
		}
		// emailReceipt is a pro.js export; the pro port provides it under the same name.
		ok, err := c.G("emailReceipt", o, o["contact_email"], c.PublicBase())
		if err != nil {
			a.log.Error("proof email", "err", err)
			return nil, nil
		}
		if truthy(ok) {
			return nil, c.AuditAs(nil, "receipt.proof_email", "#"+str(o["number"]), "")
		}
		return nil, nil
	}
	a.G["recentDone"] = func(c *C, args ...any) (any, error) {
		isAll := len(args) > 1 && truthy(args[1])
		return c.seatRecentDone(args[0], isAll)
	}
	a.G["vipSweep"] = func(c *C, args ...any) (any, error) { return nil, c.seatVipSweep() }
	a.G["coursePace"] = func(c *C, args ...any) (any, error) { return c.seatCoursePace(args[0], i64(args[1])) }

	/* ===== 1. join tables ===== */
	rt.staff("POST /tables/{id}/join", "staff", func(c *C) error {
		main, err := c.One(`SELECT * FROM tables WHERE id = ?`, tableNumParam(c.Param("id")))
		if err != nil {
			return err
		}
		if main == nil {
			return notFound("Not found")
		}
		b, err := c.Body(valid.Ordered("withTableId", valid.Int()))
		if err != nil {
			return err
		}
		other, err := c.One(`SELECT * FROM tables WHERE id = ?`, b["withTableId"])
		if err != nil {
			return err
		}
		if other == nil || i64(other["id"]) == i64(main["id"]) {
			return bad("Pick another table")
		}
		unit := tableUnit(c)
		if truthy(other["joined_to"]) {
			return conflict(fmt.Sprintf("%s %s is already joined to another table", unit, str(other["label"])))
		}
		offset := i64(main["seats"])
		if offset == 0 {
			offset = 4
		}
		steps := []struct {
			q    string
			args []any
		}{
			{`UPDATE order_items SET seat = seat + ? WHERE seat > 0 AND order_id IN (SELECT id FROM orders WHERE table_id = ? AND paid_at IS NULL AND status <> 'void')`, []any{offset, other["id"]}},
			{`UPDATE orders SET table_id = ? WHERE table_id = ? AND paid_at IS NULL AND status <> 'void'`, []any{main["id"], other["id"]}},
			{`UPDATE bills SET status = 'void', closed_at = datetime('now') WHERE table_id = ? AND status = 'open' AND id NOT IN (SELECT bill_id FROM payments WHERE status = 'paid' AND bill_id IS NOT NULL)`, []any{other["id"]}},
			{`UPDATE tables SET joined_to = ?, status = 'seated', guest_id = COALESCE(guest_id, ?) WHERE id = ?`, []any{main["id"], main["guest_id"], other["id"]}},
		}
		for _, st := range steps {
			if _, err := c.Run(st.q, st.args...); err != nil {
				return err
			}
		}
		if str(main["status"]) != "seated" && truthy(other["guest_id"]) {
			if _, err := c.Run(`UPDATE tables SET status = 'seated', guest_id = ?, seated_at = COALESCE(seated_at, ?) WHERE id = ?`, other["guest_id"], other["seated_at"], main["id"]); err != nil {
				return err
			}
		}
		al, err := c.All(`SELECT * FROM seat_allergies WHERE table_id = ?`, other["id"])
		if err != nil {
			return err
		}
		for _, x := range al {
			if _, err := c.Run(`INSERT INTO seat_allergies (table_id, seat, allergy) VALUES (?, ?, ?) ON CONFLICT (table_id, seat) DO UPDATE SET allergy = excluded.allergy, name = NULL, at = excluded.at`, main["id"], i64(x["seat"])+offset, x["allergy"]); err != nil {
				return err
			}
		}
		if _, err := c.Run(`DELETE FROM seat_allergies WHERE table_id = ?`, other["id"]); err != nil {
			return err
		}
		if err := c.Audit("table.join", fmt.Sprintf("%s %s + %s", unit, str(main["label"]), str(other["label"]))); err != nil {
			return err
		}
		c.Notify("tables")
		c.Notify("orders")
		os := i64(other["seats"])
		if os == 0 {
			os = 4
		}
		return c.JSON(M{"ok": true, "seats": offset + os})
	})
	rt.staff("POST /tables/{id}/unjoin", "staff", func(c *C) error {
		main, err := c.One(`SELECT * FROM tables WHERE id = ?`, tableNumParam(c.Param("id")))
		if err != nil {
			return err
		}
		if main == nil {
			return notFound("Not found")
		}
		r, err := c.Run(`UPDATE tables SET joined_to = NULL, status = 'dirty', guest_id = NULL WHERE joined_to = ?`, main["id"])
		if err != nil {
			return err
		}
		if err := c.Audit("table.unjoin", fmt.Sprintf("%s %s (%d)", tableUnit(c), str(main["label"]), r.Changes)); err != nil {
			return err
		}
		c.Notify("tables")
		return c.JSON(M{"ok": true, "released": r.Changes})
	})

	/* ===== 2. seat allergies ===== */
	rt.staff("GET /tables/{id}/seat-allergies", "staff", func(c *C) error {
		rows, err := c.All(`SELECT seat, allergy, name FROM seat_allergies WHERE table_id = ? ORDER BY seat`, tableNumParam(c.Param("id")))
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
	rt.staff("PUT /tables/{id}/seat-allergies", "staff", func(c *C) error {
		b, err := c.Body(valid.Ordered("seat", valid.Int().Min(1).Max(40), "allergy", valid.String().Trim().Max(80)))
		if err != nil {
			return err
		}
		tid := tableNumParam(c.Param("id"))
		t, err := c.One(`SELECT label FROM tables WHERE id = ?`, tid)
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Not found")
		}
		cur, err := c.One(`SELECT name FROM seat_allergies WHERE table_id = ? AND seat = ?`, tid, b["seat"])
		if err != nil {
			return err
		}
		var name any
		if cur != nil {
			name = orNil(cur["name"])
		}
		allergy := str(b["allergy"])
		if allergy != "" || name != nil {
			if _, err := c.Run(`INSERT INTO seat_allergies (table_id, seat, allergy, name) VALUES (?, ?, ?, ?) ON CONFLICT (table_id, seat) DO UPDATE SET allergy = excluded.allergy, name = excluded.name, at = excluded.at`, tid, b["seat"], allergy, name); err != nil {
				return err
			}
		} else if _, err := c.Run(`DELETE FROM seat_allergies WHERE table_id = ? AND seat = ?`, tid, b["seat"]); err != nil {
			return err
		}
		shown := allergy
		if shown == "" {
			shown = "cleared"
		}
		if err := c.Audit("seat.allergy", fmt.Sprintf("%s %s seat %d: %s", tableUnit(c), str(t["label"]), i64(b["seat"]), shown)); err != nil {
			return err
		}
		return c.OK()
	})
	a.every("seat-allergies-cleanup", 2*time.Minute, func(c *C) error {
		_ = c.Tx.Savepoint(c.Ctx, func() error {
			_, err := c.Run(`DELETE FROM seat_allergies WHERE at < datetime('now','-10 minutes') AND table_id IN (SELECT id FROM tables WHERE status <> 'seated')`)
			return err
		})
		return nil
	})

	/* ===== 3. split by seat ===== */
	rt.staff("GET /bills/{id}/seats", "staff", func(c *C) error {
		bill, err := c.One(`SELECT * FROM bills WHERE id = ?`, tableNumParam(c.Param("id")))
		if err != nil {
			return err
		}
		if bill == nil {
			return notFound("Not found")
		}
		sv, err := c.G("billSummary", bill)
		if err != nil {
			return err
		}
		sum := seatAsMap(sv)
		if sum == nil {
			return fmt.Errorf("billSummary hook is not registered")
		}
		items := tableList(seatAsList(sum["items"]))
		seatOf := map[int64]int64{}
		if len(items) > 0 {
			ids := make([]string, len(items))
			for i, it := range items {
				ids[i] = itoa(i64(it["id"]))
			}
			rows, err := c.All(`SELECT id, seat FROM order_items WHERE id IN (` + strings.Join(ids, ",") + `)`)
			if err != nil {
				return err
			}
			for _, r := range rows {
				seatOf[i64(r["id"])] = i64(r["seat"])
			}
		}
		seats := map[int64][]M{}
		shared := []M{}
		for _, it := range items {
			if truthy(it["paid"]) || truthy(it["claimed"]) {
				continue
			}
			if s := seatOf[i64(it["id"])]; s != 0 {
				seats[s] = append(seats[s], it)
			} else {
				shared = append(shared, it)
			}
		}
		keys := []int64{}
		for k := range seats {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
		var sharedCents float64
		sharedItems := []M{}
		for _, it := range shared {
			sharedCents += f64(it["shareCents"])
			sharedItems = append(sharedItems, M{"id": it["id"], "name": it["name"], "qty": it["qty"], "cents": it["shareCents"]})
		}
		names, err := c.serveSeatNames(bill["table_id"])
		if err != nil {
			return err
		}
		out := []M{}
		for _, s := range keys {
			ids, labels := []any{}, []string{}
			var cents float64
			for _, it := range seats[s] {
				ids = append(ids, it["id"])
				labels = append(labels, fmtJSNum(f64(it["qty"]))+" "+str(it["name"]))
				cents += f64(it["shareCents"])
			}
			var nm any
			if n, ok := names[s]; ok && n != "" {
				nm = n
			}
			out = append(out, M{"seat": s, "name": nm, "itemIds": ids, "items": labels, "cents": tableNumAny(cents), "sharedPartCents": roundJS(sharedCents / float64(len(keys)))})
		}
		return c.JSON(M{"billId": bill["id"], "remainingCents": sum["remainingCents"], "sharedCents": tableNumAny(sharedCents), "sharedItems": sharedItems, "seats": out})
	})

	/* ===== 4. my top dishes ===== */
	rt.staff("GET /me/top-items", "staff", func(c *C) error {
		rows, err := c.All(`SELECT oi.item_id id, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.created_by = ? AND o.created_at > datetime('now','-30 days') AND o.status <> 'void' AND oi.item_id IS NOT NULL AND oi.price_cents > 0 GROUP BY oi.item_id ORDER BY n DESC LIMIT 8`, c.U.ID)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})

	/* ===== 6. prepay a pre-order ===== */
	rt.pub("POST /api/c/bookings/{id}/preorder/pay", func(c *C) error {
		cu, err := c.requireCustomer()
		if err != nil {
			return err
		}
		s := c.S()
		if s["booking_preorder_pay"] != "1" {
			return forbidden("Paying ahead is not available")
		}
		en, err := c.G("onlinePayEnabled")
		if err != nil {
			return err
		}
		if !truthy(en) {
			return fail(503, "Online payments are not set up. Pay at the table instead.")
		}
		bk, err := c.One(`SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'booked'`, tableNumParam(c.Param("id")), cu.ID)
		if err != nil {
			return err
		}
		if bk == nil {
			return notFound("Booking not found")
		}
		lines, _ := jparse(bk["preorder"], []any{}).([]any)
		if len(lines) == 0 {
			return bad("Pick your dishes first")
		}
		priced, err := c.priceLines(lines, false)
		if err != nil {
			return err
		}
		var sub int64
		for _, l := range priced {
			sub += i64(l["price_cents"]) * i64(l["qty"])
		}
		owed := sub + roundJS(float64(sub)*tableJSNumber(s["tax_rate"])/100) - i64(bk["preorder_paid_cents"])
		if owed <= 0 {
			return conflict("Your pre-order is already paid")
		}
		meta, _ := json.Marshal(map[string]any{"bookingId": bk["id"]})
		res, err := c.Run(`INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('preorder', ?, 'card', ?, ?)`, owed, "Pre-order for "+str(bk["start_local"]), string(meta))
		if err != nil {
			return err
		}
		base := c.PublicBase()
		l := ""
		if c.Slug() != "main" {
			l = "l=" + c.Slug() + "&"
		}
		cancel := base + "/account"
		if l != "" {
			cancel += "?" + l[:len(l)-1]
		}
		u, err := c.G("startPay", res.LastID, M{"base": base, "lines": []M{{"name": fmt.Sprintf("%s: food ordered ahead (%s)", s["business_name"], str(bk["start_local"])), "cents": owed}}, "successUrl": base + "/account?" + l + "paid=preorder", "cancelUrl": cancel, "email": cu.Email, "descr": "Pre-order"})
		if err != nil {
			return err
		}
		return c.JSON(M{"url": u})
	})

	/* ===== 7. proof of delivery on the receipt ===== */
	rt.pub("GET /api/r/{token}/proof/{what}", func(c *C) error {
		ov, err := c.G("orderByReceipt", c.Param("token"))
		if err != nil {
			return err
		}
		o := seatAsMap(ov)
		what := c.Param("what")
		if o == nil || (what != "photo" && what != "signature") {
			c.W.WriteHeader(404)
			return nil
		}
		q, mime := `SELECT data FROM delivery_photos WHERE order_id = ?`, "image/jpeg"
		if what == "signature" {
			q, mime = `SELECT data FROM delivery_signatures WHERE order_id = ?`, "image/png"
		}
		row, err := c.One(q, o["id"])
		if err != nil {
			return err
		}
		if row == nil {
			c.W.WriteHeader(404)
			return nil
		}
		c.W.Header().Set("Content-Type", mime)
		c.W.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = c.W.Write(tableB64(tableDataPart(str(row["data"]))))
		return nil
	}, a.publicLim())

	/* ===== 9. auto-VIP ===== */
	a.every("auto-vip", 15*time.Second, func(c *C) error {
		if err := c.Tx.Savepoint(c.Ctx, c.seatVipSweep); err != nil && !strings.Contains(err.Error(), "does not exist") {
			a.log.Error("auto vip", "err", err)
		}
		return nil
	})
}

// seatAsMap reads a hook result that is an object (M or store.Row).
func seatAsMap(v any) M {
	switch x := v.(type) {
	case M:
		return x
	case *M:
		if x != nil {
			return *x
		}
	}
	return nil
}

func seatAsList(v any) any {
	switch x := v.(type) {
	case []store.Row:
		out := make([]M, len(x))
		for i, r := range x {
			out[i] = r
		}
		return out
	}
	return v
}
