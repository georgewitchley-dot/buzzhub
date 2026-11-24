package server

import (
	"fmt"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of floorpay.js: drag-and-drop floor plan and server assignment.

func init() { modules = append(modules, (*App).registerFloorPay) }

var floorpayBox = valid.Ordered(
	"id", valid.Int(),
	"x", valid.Number().Min(0).Max(100),
	"y", valid.Number().Min(0).Max(100),
	"w", valid.Number().Min(3).Max(60),
	"h", valid.Number().Min(3).Max(60),
	"shape", valid.Enum("square", "round", "bar"),
)

func (a *App) registerFloorPay(rt *router) {
	layout := valid.Array(floorpayBox).Max(300)
	rt.staff("PUT /tables/layout", "manager", func(c *C) error {
		raw := c.Raw()
		if raw == nil {
			return bad("input: Invalid input: expected array, received undefined")
		}
		v, err := valid.Parse(layout, raw)
		if err != nil {
			return bad(err.Error())
		}
		list, _ := v.([]any)
		for _, x := range list {
			t := x.(valid.M)
			if _, err := c.Run(`UPDATE tables SET x=?, y=?, w=?, h=?, shape=? WHERE id=?`, f64(t["x"]), f64(t["y"]), f64(t["w"]), f64(t["h"]), t["shape"], t["id"]); err != nil {
				return err
			}
		}
		if err := c.Audit("floor.layout", fmt.Sprintf("%d tables", len(list))); err != nil {
			return err
		}
		c.Notify("tables")
		return c.OK()
	})
	edit := valid.Ordered(
		"label", valid.String().Trim().Min(1).Max(10),
		"seats", valid.Int().Min(1).Max(40),
		"zone", valid.String().Trim().Min(1).Max(20),
	).Partial()
	rt.staff("PUT /tables/{id}", "manager", func(c *C) error {
		b, err := c.Body(edit)
		if err != nil {
			return err
		}
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
		pick := func(k string) any {
			if v, ok := b[k]; ok && v != nil {
				return v
			}
			return t[k]
		}
		if _, err := c.Run(`UPDATE tables SET label=?, seats=?, zone=? WHERE id=?`, pick("label"), pick("seats"), pick("zone"), t["id"]); err != nil {
			return err
		}
		c.Notify("tables")
		return c.OK()
	})
	server := valid.Object(map[string]valid.Schema{"userId": valid.Int().Nullable()})
	rt.staff("POST /tables/{id}/server", "staff", func(c *C) error {
		b, err := c.Body(server)
		if err != nil {
			return err
		}
		uid := b["userId"]
		if truthy(uid) {
			u, err := c.One(`SELECT 1 FROM users WHERE id = ? AND active = 1`, uid)
			if err != nil {
				return err
			}
			if u == nil {
				return notFound("Unknown team member")
			}
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE tables SET server_id = ? WHERE id = ?`, uid, id); err != nil {
			return err
		}
		c.Notify("tables")
		return c.OK()
	})
	rt.staff("GET /team", "staff", func(c *C) error {
		rows, err := c.All(`SELECT id, name, role FROM users WHERE active = 1 ORDER BY name`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
}
