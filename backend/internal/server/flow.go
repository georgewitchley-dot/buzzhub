package server

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of flow.js: transfer a table, prep par levels, delivery signatures, pre-order reminders.

func init() { modules = append(modules, (*App).registerFlow) }

var flowPngRE = regexp.MustCompile(`^data:image/png;base64,[A-Za-z0-9+/=]+$`)

func flowPlural(n int64) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// flowApplyPars is h.applyPars(items, keep): forecast items plus par levels, minus what was counted.
func (c *C) flowApplyPars(items []M, keep func(M) bool) ([]M, error) {
	date := c.tableToday()
	var order []int64
	byID := map[int64]M{}
	for _, i := range items {
		m := M{}
		for k, v := range i {
			m[k] = v
		}
		m["forecast"] = i["prep"]
		id := i64(i["id"])
		if _, ok := byID[id]; !ok {
			order = append(order, id)
		}
		byID[id] = m
	}
	pars, err := c.All(`SELECT id, name, category, station, prep_par FROM menu_items WHERE prep_par > 0 AND active = 1`)
	if err != nil {
		return nil, err
	}
	for _, m := range pars {
		if keep != nil && !keep(m) {
			continue
		}
		id := i64(m["id"])
		cur, ok := byID[id]
		if !ok {
			cur = M{"id": m["id"], "name": m["name"], "prep": int64(0), "forecast": int64(0)}
			order = append(order, id)
		}
		cur["par"] = m["prep_par"]
		byID[id] = cur
	}
	rows, err := c.All(`SELECT item_id, qty, by_label FROM prep_counts WHERE date = ?`, date)
	if err != nil {
		return nil, err
	}
	counts := map[int64]store.Row{}
	for _, r := range rows {
		counts[i64(r["item_id"])] = r
	}
	out := make([]M, 0, len(order))
	for _, id := range order {
		i := byID[id]
		target := math.Max(f64(i["forecast"]), f64(i["par"]))
		cnt := counts[id]
		i["target"] = tableNumAny(target)
		i["onHand"], i["countedBy"] = nil, nil
		have := 0.0
		if cnt != nil {
			i["onHand"] = cnt["qty"]
			i["countedBy"] = orNil(cnt["by_label"])
			have = f64(cnt["qty"])
		}
		i["prep"] = tableNumAny(math.Max(0, target-have))
		out = append(out, i)
	}
	sort.SliceStable(out, func(a, b int) bool {
		pa, pb := f64(out[a]["prep"]), f64(out[b]["prep"])
		if pa != pb {
			return pb < pa
		}
		na, nb := str(out[a]["name"]), str(out[b]["name"])
		if la, lb := strings.ToLower(na), strings.ToLower(nb); la != lb {
			return la < lb
		}
		return na < nb
	})
	return out, nil
}

// flowRemind sends the day-before pre-order reminders for this location.
func (c *C) flowRemind() error {
	s := c.S()
	if s["booking_preorder"] != "1" || s["preorder_reminder"] != "1" {
		return nil
	}
	hour := time.Now().In(loadTZ(c.tableTZ())).Hour()
	h := s["preorder_reminder_hour"]
	if h == "" {
		h = "15"
	}
	if lim := tableJSNumber(h); float64(hour) < lim {
		return nil
	}
	tomorrow := addDays(c.tableToday(), 1)
	due, err := c.All(`SELECT b.*, c.name, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.status = 'booked' AND b.preorder IS NULL AND b.preorder_reminded IS NULL AND substr(b.start_local,1,10) = ?`, tomorrow)
	if err != nil {
		return err
	}
	for _, b := range due {
		if _, err := c.Run(`UPDATE bookings SET preorder_reminded = datetime('now') WHERE id = ?`, b["id"]); err != nil {
			return err
		}
		start := str(b["start_local"])
		at := ""
		if len(start) > 11 {
			at = start[11:]
		}
		body := fmt.Sprintf("You're booked tomorrow at %s. Want your food started the moment you sit down? Order ahead from your account.", at)
		url := "/account"
		if c.Slug() != "main" {
			url = "/account?l=" + c.Slug()
		}
		c.a.pushToCustomer(c.Ctx, c.Tx, i64(b["customer_id"]), M{"title": s["business_name"] + ": order ahead", "body": body, "tag": "preorder-" + str(b["id"]), "url": url})
		if emailEnabled() && truthy(b["email"]) {
			if _, err := emailGuest(str(b["email"]), emailMsg{BusinessName: s["business_name"], Subject: "Order ahead for tomorrow", Message: body, Link: c.a.cfg.PublicURL + "/account", Accent: s["accent"]}); err != nil {
				c.a.log.Error("preorder reminder email", "err", err)
			}
		}
		if err := c.AuditAs(nil, "booking.preorder_reminder", fmt.Sprintf("#%s %s", str(b["id"]), str(b["name"])), ""); err != nil {
			return err
		}
	}
	return nil
}

// flowRemindAll is remind(): every location, errors logged and swallowed.
func (c *C) flowRemindAll() {
	if err := c.Tx.Savepoint(c.Ctx, c.flowRemind); err != nil {
		c.a.log.Error("preorder reminders", "err", err)
	}
	for _, slug := range c.a.allSlugs(c.Ctx) {
		if slug == c.Slug() {
			continue
		}
		if err := c.a.db.In(c.Ctx, slug, func(tx *store.Tx) error {
			return (&C{a: c.a, Tx: tx, Ctx: c.Ctx, R: c.R, W: newBuf()}).flowRemind()
		}); err != nil {
			c.a.log.Error("preorder reminders", "location", slug, "err", err)
		}
	}
}

func (a *App) registerFlow(rt *router) {
	// applyPars(items, keep func(M) bool)
	a.G["applyPars"] = func(c *C, args ...any) (any, error) {
		var keep func(M) bool
		if len(args) > 1 {
			switch k := args[1].(type) {
			case func(M) bool:
				keep = k
			}
		}
		return c.flowApplyPars(tableList(args[0]), keep)
	}
	// prepCount(itemId, qty or nil, by)
	a.G["prepCount"] = func(c *C, args ...any) (any, error) {
		r, err := c.One(`SELECT 1 FROM menu_items WHERE id = ?`, args[0])
		if err != nil {
			return nil, err
		}
		if r == nil {
			return nil, notFound("Not found")
		}
		var by any
		if len(args) > 2 {
			by = orNil(args[2])
		}
		if args[1] == nil {
			_, err = c.Run(`DELETE FROM prep_counts WHERE date = ? AND item_id = ?`, c.tableToday(), args[0])
		} else {
			_, err = c.Run(`INSERT INTO prep_counts (date, item_id, qty, by_label) VALUES (?, ?, ?, ?) ON CONFLICT (date, item_id) DO UPDATE SET qty = excluded.qty, by_label = excluded.by_label, at = excluded.at`, c.tableToday(), args[0], args[1], by)
		}
		return nil, err
	}
	a.G["needsSignature"] = func(c *C, args ...any) (any, error) {
		min := tableJSNumber(c.S()["delivery_signature_cents"])
		if min == 0 || math.IsNaN(min) {
			return false, nil
		}
		o := tableRow(args[0])
		total := f64(o["subtotal_cents"]) - f64(o["discount_cents"]) + f64(o["tax_cents"]) + f64(o["fee_cents"])
		if total < min {
			return false, nil
		}
		r, err := c.One(`SELECT 1 FROM delivery_signatures WHERE order_id = ?`, o["id"])
		return r == nil, err
	}
	a.G["signatureMin"] = func(c *C, args ...any) (any, error) {
		f := tableJSNumber(c.S()["delivery_signature_cents"])
		if math.IsNaN(f) {
			f = 0
		}
		return tableNumAny(f), nil
	}
	a.G["runPreorderReminders"] = func(c *C, args ...any) (any, error) { c.flowRemindAll(); return nil, nil }

	/* ===== transfer a table ===== */
	rt.staff("POST /tables/{id}/transfer", "staff", func(c *C) error {
		from, err := c.One(`SELECT * FROM tables WHERE id = ?`, tableNumParam(c.Param("id")))
		if err != nil {
			return err
		}
		if from == nil {
			return notFound("Not found")
		}
		b, err := c.Body(valid.Ordered("toTableId", valid.Int().Optional(), "toUserId", valid.Int().Optional()))
		if err != nil {
			return err
		}
		if !truthy(b["toTableId"]) && !truthy(b["toUserId"]) {
			return bad("Pick a table or a server")
		}
		unit := tableUnit(c)
		did := []string{}
		if truthy(b["toTableId"]) && i64(b["toTableId"]) != i64(from["id"]) {
			to, err := c.One(`SELECT * FROM tables WHERE id = ?`, b["toTableId"])
			if err != nil {
				return err
			}
			if to == nil {
				return notFound("That table is gone")
			}
			if str(to["status"]) == "seated" && truthy(from["guest_id"]) {
				return conflict(fmt.Sprintf("%s %s already has guests. Clear it first.", unit, str(to["label"])))
			}
			moved, err := c.Run(`UPDATE orders SET table_id = ? WHERE table_id = ? AND paid_at IS NULL AND status <> 'void'`, to["id"], from["id"])
			if err != nil {
				return err
			}
			if _, err := c.Run(`UPDATE bills SET table_id = ? WHERE table_id = ? AND status = 'open'`, to["id"], from["id"]); err != nil {
				return err
			}
			if truthy(from["guest_id"]) {
				if _, err := c.Run(`UPDATE tables SET status = 'seated', guest_id = ?, seated_at = ? WHERE id = ?`, from["guest_id"], from["seated_at"], to["id"]); err != nil {
					return err
				}
				if _, err := c.Run(`UPDATE guests SET table_id = ? WHERE id = ?`, to["id"], from["guest_id"]); err != nil {
					return err
				}
				if _, err := c.Run(`UPDATE tables SET status = 'dirty', guest_id = NULL, seated_at = NULL WHERE id = ?`, from["id"]); err != nil {
					return err
				}
			}
			if truthy(from["server_id"]) && !truthy(b["toUserId"]) {
				if _, err := c.Run(`UPDATE tables SET server_id = ? WHERE id = ?`, from["server_id"], to["id"]); err != nil {
					return err
				}
			}
			if _, err := c.Run(`UPDATE tabs SET table_id = ? WHERE table_id = ? AND status = 'open'`, to["id"], from["id"]); err != nil {
				return err
			}
			did = append(did, fmt.Sprintf("moved to %s %s (%d check%s)", unit, str(to["label"]), moved.Changes, flowPlural(moved.Changes)))
		}
		if truthy(b["toUserId"]) {
			u, err := c.One(`SELECT id, name FROM users WHERE id = ? AND active = 1`, b["toUserId"])
			if err != nil {
				return err
			}
			if u == nil {
				return notFound("That person is not active")
			}
			tid := from["id"]
			if truthy(b["toTableId"]) {
				tid = b["toTableId"]
			}
			if _, err := c.Run(`UPDATE tables SET server_id = ? WHERE id = ?`, u["id"], tid); err != nil {
				return err
			}
			n, err := c.Run(`UPDATE orders SET created_by = ? WHERE table_id = ? AND paid_at IS NULL AND status <> 'void'`, u["id"], tid)
			if err != nil {
				return err
			}
			did = append(did, fmt.Sprintf("handed to %s (%d check%s)", str(u["name"]), n.Changes, flowPlural(n.Changes)))
		}
		if err := c.Audit("table.transfer", fmt.Sprintf("%s %s %s", unit, str(from["label"]), strings.Join(did, ", "))); err != nil {
			return err
		}
		c.Notify("tables")
		c.Notify("orders")
		c.Notify("guests")
		return c.JSON(M{"ok": true, "done": did})
	})
	rt.staff("GET /servers-on", "staff", func(c *C) error {
		rows, err := c.All(`SELECT DISTINCT u.id, u.name FROM users u JOIN shifts s ON s.user_id = u.id AND s.clock_out IS NULL WHERE u.active = 1 ORDER BY u.name`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})

	/* ===== prep par levels ===== */
	rt.staff("GET /prep-pars", "staff", func(c *C) error {
		rows, err := c.All(`SELECT id, name, category, prep_par FROM menu_items WHERE active = 1 ORDER BY category, name`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
	rt.staff("PUT /menu/{id}/prep-par", "manager", func(c *C) error {
		b, err := c.Body(valid.Ordered("par", valid.Int().Min(0).Max(999).Nullable()))
		if err != nil {
			return err
		}
		par := orNil(b["par"])
		if _, err := c.Run(`UPDATE menu_items SET prep_par = ? WHERE id = ?`, par, tableNumParam(c.Param("id"))); err != nil {
			return err
		}
		shown := "none"
		if par != nil {
			shown = str(par)
		}
		if err := c.Audit("prep.par", fmt.Sprintf("item %s: %s", c.Param("id"), shown)); err != nil {
			return err
		}
		return c.OK()
	})

	/* ===== delivery signatures ===== */
	rt.staff("POST /orders/{id}/signature", "staff", func(c *C) error {
		b, err := c.Body(valid.Ordered("signature", valid.String().Max(200000), "name", valid.String().Trim().Max(60).Optional()))
		if err != nil {
			return err
		}
		if !flowPngRE.MatchString(str(b["signature"])) {
			return bad("Bad signature")
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ? AND fulfillment = 'delivery'`, tableNumParam(c.Param("id")))
		if err != nil {
			return err
		}
		if o == nil {
			return notFound("Not found")
		}
		name := orNil(b["name"])
		if _, err := c.Run(`INSERT INTO delivery_signatures (order_id, data, name) VALUES (?, ?, ?) ON CONFLICT (order_id) DO UPDATE SET data = excluded.data, name = excluded.name, at = excluded.at`, o["id"], b["signature"], name); err != nil {
			return err
		}
		detail := "#" + str(o["number"])
		if name != nil {
			detail += " " + str(name)
		}
		if err := c.Audit("delivery.signature", detail); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("GET /orders/{id}/signature", "staff", func(c *C) error {
		s, err := c.One(`SELECT data FROM delivery_signatures WHERE order_id = ?`, tableNumParam(c.Param("id")))
		if err != nil {
			return err
		}
		if s == nil {
			c.W.WriteHeader(404)
			return nil
		}
		c.W.Header().Set("Content-Type", "image/png")
		_, _ = c.W.Write(tableB64(tableDataPart(str(s["data"]))))
		return nil
	})

	/* ===== pre-order reminders (day before) ===== */
	rt.staff("POST /preorder-reminders/run", "manager", func(c *C) error {
		c.flowRemindAll()
		n, err := c.Val(`SELECT COUNT(*) n FROM bookings WHERE preorder_reminded > datetime('now','-1 minute')`)
		if err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "sent": n})
	})
	a.every("preorder-reminders", 10*time.Minute, func(c *C) error {
		if err := c.Tx.Savepoint(c.Ctx, c.flowRemind); err != nil {
			a.log.Error("preorder reminders", "err", err)
		}
		return nil
	})
}
