package server

import (
	"fmt"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

// qrSVG draws a QR code as SVG like the Node "qrcode" package (margin in modules).
func qrSVG(text string, margin int, dark, light string, high bool) (string, error) {
	level := qrcode.Medium
	if high {
		level = qrcode.High
	}
	q, err := qrcode.New(text, level)
	if err != nil {
		return "", err
	}
	q.DisableBorder = true
	bm := q.Bitmap()
	n := len(bm) + 2*margin
	if dark == "" {
		dark = "#000000"
	}
	if light == "" {
		light = "#ffffff"
	}
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges"><path fill="%s" d="M0 0h%dv%dH0z"/><path stroke="%s" d="`, n, n, light, n, n, dark)
	for y, row := range bm {
		for x := 0; x < len(row); {
			if !row[x] {
				x++
				continue
			}
			start := x
			for x < len(row) && row[x] {
				x++
			}
			fmt.Fprintf(&b, "M%d %d.5h%d", start+margin, y+margin, x-start)
		}
	}
	b.WriteString(`"/></svg>`)
	return b.String(), nil
}
