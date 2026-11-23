package server

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// The order builder shared by the register, order-ahead, online and table orders (commerce.js).

var lineSchema = valid.Object(map[string]valid.Schema{
	"itemId":  valid.Int().Optional(),
	"comboId": valid.Int().Optional(),
	"picks": valid.Array(valid.Object(map[string]valid.Schema{
		"itemId": valid.Int(),
		"mods":   valid.Array(valid.Int()).Max(20).Optional(),
	})).Max(8).Optional(),
	"qty":    valid.Int().Min(1).Max(99),
	"note":   valid.String().Trim().Max(80).Optional(),
	"mods":   valid.Array(valid.Int()).Max(20).Optional(),
	"course": valid.Int().Min(1).Max(3).Optional(),
	"seat":   valid.Int().Min(1).Max(40).Optional(),
}).Refine(func(l valid.M) bool {
	if _, ok := l["itemId"]; ok {
		return true
	}
	p, _ := l["picks"].([]any)
	_, hasCombo := l["comboId"]
	return hasCombo && len(p) > 0
}, "Each line needs an item or a combo")

// jparse is JSON.parse with a fallback (the j() helper in menuWithMods).
func jparse(v any, def any) any {
	s, ok := v.(string)
	if !ok || s == "" {
		return def
	}
	var out any
	if json.Unmarshal([]byte(s), &out) != nil || out == nil {
		return def
	}
	return out
}

type modOpt struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	PriceCents int64  `json:"price_cents"`
}
type modGroup struct {
	ID      int64    `json:"id"`
	Name    string   `json:"name"`
	Min     int64    `json:"min"`
	Max     int64    `json:"max"`
	Options []modOpt `json:"options"`
}

// menuHooks: other modules adjust prices/visibility and expand combos.
type menuHookSet struct {
	adjust []func(c *C, items []M) ([]M, error)
	combo  func(c *C, line valid.M, menu map[int64]M, pick func(m M, ids []any) ([]modOpt, error)) ([]M, error)
}

// orderHookSet: other modules (recipes) listen for sales and voids.
type orderHookSet struct {
	inserted []func(c *C, orderID int64, lines []M, userID any) error
	voided   []func(c *C, orderID int64, userID any) error
	stock    func(c *C, kind string, m store.Row)
}

func (c *C) menuWithMods(where string) ([]M, error) {
	if where == "" {
		where = "active = 1"
	}
	rows, err := c.All(`SELECT id, name, category, price_cents, color, active, guest_orderable, stock, low_stock, description, allergens, diet, i18n FROM menu_items WHERE ` + where + ` ORDER BY sort, id`)
	if err != nil {
		return nil, err
	}
	groups, err := c.All(`SELECT * FROM mod_groups ORDER BY sort, id`)
	if err != nil {
		return nil, err
	}
	opts, err := c.All(`SELECT * FROM mod_options ORDER BY sort, id`)
	if err != nil {
		return nil, err
	}
	links, err := c.All(`SELECT * FROM item_mod_groups`)
	if err != nil {
		return nil, err
	}
	g := map[int64]*modGroup{}
	for _, x := range groups {
		mg := &modGroup{ID: i64(x["id"]), Name: str(x["name"]), Min: i64(x["min_pick"]), Max: i64(x["max_pick"]), Options: []modOpt{}}
		for _, o := range opts {
			if i64(o["group_id"]) == mg.ID {
				mg.Options = append(mg.Options, modOpt{i64(o["id"]), str(o["name"]), i64(o["price_cents"])})
			}
		}
		g[mg.ID] = mg
	}
	out := make([]M, 0, len(rows))
	for _, r := range rows {
		m := M(r)
		m["allergens"] = jparse(r["allergens"], []any{})
		m["diet"] = jparse(r["diet"], []any{})
		m["i18n"] = jparse(r["i18n"], M{})
		m["soldOut"] = r["stock"] != nil && i64(r["stock"]) <= 0
		gs := []*modGroup{}
		for _, l := range links {
			if i64(l["item_id"]) == i64(r["id"]) {
				if mg := g[i64(l["group_id"])]; mg != nil {
					gs = append(gs, mg)
				}
			}
		}
		m["groups"] = gs
		out = append(out, m)
	}
	for _, f := range c.a.menu.adjust {
		if out, err = f(c, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func groupsOf(m M) []*modGroup {
	gs, _ := m["groups"].([]*modGroup)
	return gs
}

// pickMods checks a line's chosen options against the item's option groups.
func pickMods(m M, ids []any) ([]modOpt, error) {
	picked := map[int64]bool{}
	for _, id := range ids {
		picked[i64(id)] = true
	}
	mods := []modOpt{}
	name := str(m["name"])
	for _, g := range groupsOf(m) {
		chosen := []modOpt{}
		for _, o := range g.Options {
			if picked[o.ID] {
				chosen = append(chosen, o)
			}
		}
		if int64(len(chosen)) < g.Min {
			what := "an option"
			if g.Min != 1 {
				what = fmt.Sprintf("%d options", g.Min)
			}
			return nil, bad(fmt.Sprintf("Choose %s for %s on %s", what, g.Name, name))
		}
		if int64(len(chosen)) > g.Max {
			return nil, bad(fmt.Sprintf("Choose at most %d for %s on %s", g.Max, g.Name, name))
		}
		for _, o := range chosen {
			mods = append(mods, o)
			delete(picked, o.ID)
		}
	}
	if len(picked) > 0 {
		return nil, bad("An option on " + name + " is no longer available")
	}
	return mods, nil
}

// priceLines validates order lines against the menu. Prices always come from the server.
func (c *C) priceLines(lines []any, guestOnly bool) ([]M, error) {
	where := "active = 1"
	if guestOnly {
		where = "active = 1 AND guest_orderable = 1"
	}
	items, err := c.menuWithMods(where)
	if err != nil {
		return nil, err
	}
	menu := map[int64]M{}
	for _, m := range items {
		menu[i64(m["id"])] = m
	}
	need := map[int64]int64{}
	order := []int64{}
	addNeed := func(id, q int64) {
		if _, ok := need[id]; !ok {
			order = append(order, id)
		}
		need[id] += q
	}
	out := []M{}
	for _, raw := range lines {
		l := raw.(valid.M)
		course := int64(1)
		if v, ok := l["course"]; ok {
			course = i64(v)
		}
		seat := orNil(l["seat"])
		if _, ok := l["comboId"]; ok {
			if c.a.menu.combo == nil {
				return nil, bad("Combos are not available")
			}
			parts, err := c.a.menu.combo(c, l, menu, pickMods)
			if err != nil {
				return nil, err
			}
			for _, p := range parts {
				addNeed(i64(p["item_id"]), i64(p["qty"]))
				p["course"], p["seat"] = course, seat
				out = append(out, p)
			}
			continue
		}
		m, ok := menu[i64(l["itemId"])]
		if !ok {
			return nil, bad("An item is no longer available")
		}
		ids, _ := l["mods"].([]any)
		mods, err := pickMods(m, ids)
		if err != nil {
			return nil, err
		}
		qty := i64(l["qty"])
		addNeed(i64(m["id"]), qty)
		price := i64(m["price_cents"])
		for _, o := range mods {
			price += o.PriceCents
		}
		out = append(out, M{"item_id": m["id"], "name": m["name"], "qty": qty, "price_cents": price, "note": orNil(l["note"]), "mods": mods, "course": course, "seat": seat})
	}
	sort.SliceStable(order, func(i, j int) bool { return order[i] < order[j] })
	for _, id := range order {
		m := menu[id]
		if m == nil || m["stock"] == nil {
			continue
		}
		st := i64(m["stock"])
		if st < need[id] {
			if st <= 0 {
				return nil, bad(str(m["name"]) + " is sold out")
			}
			return nil, bad(fmt.Sprintf("Only %d %s left", st, str(m["name"])))
		}
	}
	return out, nil
}

func lineMods(l M) []modOpt {
	m, _ := l["mods"].([]modOpt)
	return m
}

func (c *C) takeStock(lines []M, userID any, reason string) error {
	touched := []int64{}
	seen := map[int64]bool{}
	for _, l := range lines {
		r, err := c.Run(`UPDATE menu_items SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL`, l["qty"], l["item_id"])
		if err != nil {
			return err
		}
		if r.Changes > 0 {
			if _, err := c.Run(`INSERT INTO stock_moves (item_id, delta, reason, user_id) VALUES (?, ?, ?, ?)`, l["item_id"], -i64(l["qty"]), reason, orNil(userID)); err != nil {
				return err
			}
			if id := i64(l["item_id"]); !seen[id] {
				seen[id] = true
				touched = append(touched, id)
			}
		}
	}
	for _, id := range touched {
		m, err := c.Get(`SELECT id, name, stock, low_stock, active FROM menu_items WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if i64(m["stock"]) <= 0 && truthy(m["active"]) {
			if _, err := c.Run(`UPDATE menu_items SET active = 0 WHERE id = ?`, id); err != nil {
				return err
			}
			c.stockEvent("out", m)
		} else if i64(m["stock"]) > 0 && i64(m["stock"]) <= i64(m["low_stock"]) {
			c.stockEvent("low", m)
		}
	}
	return nil
}

func (c *C) stockEvent(kind string, m store.Row) {
	if c.a.orders.stock != nil {
		c.a.orders.stock(c, kind, m)
	}
}

func (c *C) returnStock(orderID int64, userID any) error {
	for _, f := range c.a.orders.voided {
		if err := c.Tx.Savepoint(c.Ctx, func() error { return f(c, orderID, userID) }); err != nil {
			c.a.log.Error("void hook", "err", err)
		}
	}
	lines, err := c.All(`SELECT item_id, qty FROM order_items WHERE order_id = ?`, orderID)
	if err != nil {
		return err
	}
	for _, l := range lines {
		r, err := c.Run(`UPDATE menu_items SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL`, l["qty"], l["item_id"])
		if err != nil {
			return err
		}
		if r.Changes > 0 {
			if _, err := c.Run(`INSERT INTO stock_moves (item_id, delta, reason, user_id) VALUES (?, ?, ?, ?)`, l["item_id"], l["qty"], fmt.Sprintf("order %d voided", orderID), orNil(userID)); err != nil {
				return err
			}
		}
	}
	return nil
}

func dueOf(o store.Row) int64 {
	return i64(o["subtotal_cents"]) - i64(o["discount_cents"]) + i64(o["tax_cents"]) + i64(o["fee_cents"]) - i64(o["gift_cents"])
}

type newOrder struct {
	Lines                                []M
	Status, Source, Fulfillment          string
	TableID, GuestID, CustomerName       any
	CreatedBy, PromoCode, Address, Phone any
	Email, Notes, ClientKey              any
	DiscountCents, FeeCents              int64
}

type madeOrder struct {
	ID        int64 `json:"id"`
	Number    int64 `json:"number"`
	Duplicate bool  `json:"duplicate,omitempty"`
}

func roundJS(f float64) int64 { return int64(math.Floor(f + 0.5)) }

// insertOrder saves an order and its lines, takes stock and runs the order hooks.
func (c *C) insertOrder(o newOrder) (madeOrder, error) {
	if o.Status == "" {
		o.Status = "sent"
	}
	if o.Source == "" {
		o.Source = "staff"
	}
	if o.Fulfillment == "" {
		o.Fulfillment = "dine_in"
	}
	if truthy(o.ClientKey) {
		if dup, err := c.One(`SELECT id, number FROM orders WHERE client_key = ?`, o.ClientKey); err != nil || dup != nil {
			if err != nil {
				return madeOrder{}, err
			}
			return madeOrder{i64(dup["id"]), i64(dup["number"]), true}, nil
		}
	}
	var subtotal int64
	for _, l := range o.Lines {
		subtotal += i64(l["qty"]) * i64(l["price_cents"])
	}
	discount := o.DiscountCents
	if discount > subtotal {
		discount = subtotal
	}
	tax := roundJS(float64(subtotal-discount) * f64(c.S()["tax_rate"]) / 100)
	maxN, err := c.Val(`SELECT MAX(number) n FROM orders WHERE localdate(created_at) = localtoday()`)
	if err != nil {
		return madeOrder{}, err
	}
	number := i64(maxN)
	if number == 0 {
		number = 100
	}
	number++
	now := store.Now()
	var sentAt any
	if o.Status == "sent" {
		sentAt = now
	}
	res, err := c.Run(`INSERT INTO orders (number, status, table_id, guest_id, customer_name, subtotal_cents, tax_cents, discount_cents, fee_cents, total_cents, created_by, sent_at, source,
		promo_code, fulfillment, delivery_address, contact_phone, contact_email, order_notes, client_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		number, o.Status, o.TableID, o.GuestID, o.CustomerName, subtotal, tax, discount, o.FeeCents, subtotal-discount+tax+o.FeeCents, o.CreatedBy, sentAt, o.Source,
		o.PromoCode, o.Fulfillment, o.Address, o.Phone, o.Email, o.Notes, o.ClientKey)
	if err != nil {
		return madeOrder{}, err
	}
	id := res.LastID
	for _, l := range o.Lines {
		var mods any
		if ms := lineMods(l); len(ms) > 0 {
			b, _ := json.Marshal(ms)
			mods = string(b)
		} else if raw, ok := l["mods"].([]any); ok && len(raw) > 0 {
			b, _ := json.Marshal(raw)
			mods = string(b)
		}
		course := i64(l["course"])
		if course == 0 {
			course = 1
		}
		var fired any
		if course <= 1 {
			fired = now
		}
		if _, err := c.Run(`INSERT INTO order_items (order_id, item_id, name, qty, price_cents, note, mods, course, fired_at, seat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, l["item_id"], l["name"], l["qty"], l["price_cents"], l["note"], mods, course, fired, orNil(l["seat"])); err != nil {
			return madeOrder{}, err
		}
	}
	if err := c.takeStock(o.Lines, o.CreatedBy, fmt.Sprintf("order #%d", number)); err != nil {
		return madeOrder{}, err
	}
	for _, f := range c.a.orders.inserted {
		if err := f(c, id, o.Lines, o.CreatedBy); err != nil {
			return madeOrder{}, err
		}
	}
	return madeOrder{ID: id, Number: number}, nil
}
