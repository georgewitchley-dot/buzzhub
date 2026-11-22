# BuzzHub — Handoff brief for the next AI / developer

Read this first, then `README.md`. Everything you need to continue is in this repo.

## 1. What the owner asked for
"A badass POS command center and a table-buzzing app for any business I plug it into, with security on both the app and the command center, PIN login for the command center, and neat features." Use GSAP, Lenis and React Bits, keep it in a GitHub repo, and host it on Railway.

## 2. Current status (2026-11-21, round 11 deployed)
| Item | Status |
|---|---|
| App code (server + client) | ✅ Done, builds cleanly, end-to-end browser test passed |
| Git history | ✅ Local commits on `main` (this zip includes the `.git` folder) |
| GitHub repo | ❌ **Not pushed.** Target: `georgewitchley-dot/buzzhub` (private, should be empty). The previous AI session couldn't reach it because of GitHub app permissions. |
| Railway project | ✅ Created and configured, ⏳ **waiting for a source repo** |
| Live URL | https://buzzhub-web-production.up.railway.app (returns nothing until deployed) |

### Railway details
- Project **buzzhub**: `2ad22ef6-44c0-4c61-b856-8142f89898f4`, environment `production` (`7de7b4f2-4cd3-499a-8b62-2bbe5ccc8955`)
- Service **buzzhub-web**: `109e58b7-8b9e-4426-b879-ea93a7112c6a`. Domain is set, target port 8080.
- Volume **buzzhub-data** (`de4b2686-4c1e-4288-bf26-de10585016c8`) mounted at `/data`
- Variables already set: `NODE_ENV=production`, `PORT=8080`, `DATA_DIR=/data`, `JWT_SECRET` (random, 96 hex chars), `SETUP_CODE` (6 digits; the owner has it, or read it in Railway → Variables), `PUBLIC_URL=https://buzzhub-web-production.up.railway.app`
- `railway.json` sets the build (`npm run build`), start (`npm start`) and the `/healthz` health check.

## 3. Your next steps
1. Push this repo to GitHub:
   ```bash
   git remote add origin https://github.com/georgewitchley-dot/buzzhub.git   # or any repo the owner picks
   git push -u origin main
   ```
2. Connect the Railway service `buzzhub-web` to that repo (branch `main`). In the dashboard: Service → Settings → Source → Connect Repo. Railway's own GitHub app must be allowed to see the repo.
3. Watch the deploy logs. `better-sqlite3` compiles or downloads a native binary, which works on Railway's default Node builder. Root `npm install` runs a `postinstall` that installs `server/` and `client/`.
4. Open the live URL. The owner enters the setup code, business name, type and an owner PIN.
5. Smoke test: add a guest, scan the QR code on a phone, Buzz, tap "I'm on my way", ring up a sale, take payment, lock, then unlock with the PIN.

## 3b. Features added on 2026-11-20 (round 2)
- No SMS or Twilio (removed). Free Web Push via `web-push` and `client/public/sw.js`. Keys are auto-generated in `DATA_DIR/.vapid.json`.
- Logo upload (`PUT /api/staff/logo`, stored in the `assets` table) and a printable door sign (`PrintSign.jsx`) with the logo centred in a QR code with high error correction.
- Order ahead: `menu_items.guest_orderable`, orders `status='held'` + `source='guest'`. Held orders fire on buzz-with-table or on seat. Settings `preorder_open_minutes` and `heads_up_minutes`, plus automatic "almost ready" alerts.
- Customer accounts (`customers`, cookie `bh_customer`), bookings (`bookings`, times stored as local 'YYYY-MM-DD HH:MM' in the setting `timezone`), reminders, check-in into the queue, staff Bookings page and Customers tab.
- Optional SMTP email alerts (`notify.js`).
- Migrations in `db.js` are idempotent and rebuild `orders` to allow 'held'. Tested against an older database.

## 3c. Round 3 (2026-11-21): all 10 upgrades
New server modules: `ops.js` (kitchen, reports, cash, shifts), `guard.js` (TOTP, devices, approvals, refunds, staff push), `growth.js` (smart waits, loyalty, feedback), `floorpay.js` (floor layout, Stripe Checkout + webhook), `locations.js` (multi-location).
- **Multi-location design:** `db.js` exports `db` as a Proxy to the current location's SQLite file (`DATA_DIR/buzzhub.db` = 'main', `DATA_DIR/locations/<slug>.db` for others), chosen per request by AsyncLocalStorage in `locationMiddleware`. The order is guest/feedback/pay token lookup, then the `X-Location` header, `?l=`, the session `loc` claim, the `bh_loc` cookie, then 'main'. Migrations must use `registerSchema((db) => …)` so they run for every location. Background jobs use `forEachLocation`. Socket.IO rooms are prefixed `<slug>:` via the patched `io.to` / `io.emit`. All JWTs carry `loc`. The same person across locations is linked by `users.hub_key`.
- 'Today' is the business's local day everywhere (SQL `localdate()` / `localtoday()`).

## 3d. Round 4 (2026-11-21): commerce + team
New server modules:
- `commerce.js`: one order builder for every channel (`priceLines`, `insertOrder` with `clientKey` idempotency). It also covers menu options (mod_groups / mod_options / item_mod_groups), inventory (menu_items.stock, stock_moves, auto sold-out), gift cards (gift_cards / gift_txns) and bills with split checks (bills / bill_orders / payments, settled by `settleBill`, Stripe webhook).
  - Channels: online ordering (`/api/o/*`, settings `online_*` and `delivery_*`) and table QR ordering (`tables.qr_token`, `/api/t/:token/*`).
  - Order rule: `prepaid=1` means paid while still cooking. Revenue is `paid_at IS NOT NULL AND status <> 'void'`.
- `team.js`:
  - Promo codes (`promos`, `G.promoDiscount` throws 400 with a readable reason; uses are counted from orders.promo_code).
  - Campaigns (`campaigns`, customers.marketing_opt_in, HMAC unsubscribe link `/api/unsub/:slug/:id/:sig?l=slug`, 12-hour guard overridable with header `X-Confirm-Repeat: 1`).
  - Tip pool (users.tip_points, `tip_payouts`; payouts never overlap).
  - Staffing forecast (`/staff/forecast`: 8 weeks of the same weekday by local hour; Open-Meteo geocoding, forecast and archive with no key; the rain effect is learned when there are at least 3 rainy days, otherwise `forecast_rain_pct`).
- Client: `order-ui.jsx` (ModPicker, useCart, GuestMenu), `offline.js` (register sale queue, synced with idempotent clientKey), service worker app-shell cache `buzzhub-shell-v4`. Pages: `Commerce.jsx` (options, inventory, gift cards, online settings, table QR), `Team.jsx` (marketing, tips, forecast, settings panel), `OrderOnline.jsx` (/order, /t/:token, /gift).
- Fixed: `dayBounds` in ops.js mis-parsed days 1–9 of a month. It now uses formatToParts.

## 3e. Round 5 (2026-11-21): pro features + every way to get paid
New server modules:
- `payments.js`: one pay page (`/pay/:token`, `payments.pay_token`). Every online flow (bill shares, online orders, online gift cards, deposits) inserts a `payments` row and calls `G.startPay(pid, {base, lines, successUrl ({TOKEN} placeholder), cancelUrl})`.
  - Card goes to the Square payment link or Stripe Checkout; it comes back to `/pay/:token?back=1` and is verified with `/verify`.
  - PayPal and Venmo use JS SDK buttons with server-side create and capture.
  - Handles (Zelle, Venmo, Cash App, PayPal.me): `/claim` sets `claimed_at`; staff confirm or reject at `/staff/payments/:id/confirm|reject`. Everything ends in `completePayment`.
  - Refunds go through `G.refundRef('stripe:pi|square:pay|paypal:cap|manual:x')`.
  - Webhooks: `/api/square/webhook` (HMAC of URL+body).
  - Env: `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENVIRONMENT` (sandbox|production), `SQUARE_WEBHOOK_SIGNATURE_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`. Stripe is optional.
- `pro.js`: Stripe Terminal (server-driven) and Square Terminal readers (`sq_` ids), with `terminal_charges` and `G.startReaderCharge`. Also receipts (`orders.receipt_token`, `/api/r/:token`) and booking deposits (bookings.deposit_*; the deposit is credited at check-in as a one-time gift card).
- `crm.js`: customer profiles (customers.tags/notes/birthday), automatic offers (`auto_sends`, one-time promo codes, a daily run after 10am local), and insights (daily owner summary, `insight_alerts`, `/staff/insights/fees` payment cost estimates from setting `fee_rates`).
- `back.js`: ingredients, recipes, ingredient moves through `orderHooks` in commerce.js; suppliers and purchase orders; payroll (`/staff/payroll`, CSV, weekly overtime); overtime and break alerts.
- `delivery.js`: drivers (users.is_driver, orders.driver_id/out_at/delivered_at, driver_pos), Nominatim geocoding, and `deliveryView` shown on the buzzer. Kiosk uses a JWT in the `X-Kiosk` header (secret is jwt+':kiosk', revoked with `kiosk_version`); orders go through `/api/k/*`, and exit needs a manager PIN.
- Cash discount: setting `cash_discount_pct`, applied in `/staff/orders/:id/pay` for cash.
- Client: `pro-ui.jsx`, `i18n.jsx` (en/es), `track.jsx` (Leaflet + OSM tiles), and pages `PayPage`, `Receipt`, `Kiosk`, `Back.jsx` (Insights, Purchasing, Payroll) and `Field.jsx` (Deliveries, customer profile, auto offers, settings panels, payment claims bar, payment costs).

## 3f. Round 6 (2026-11-21)
- `club.js`
  - Memberships: `membership_plans`, `memberships`. Payments use kind 'membership' through `G.payHooks.membership`; there is an hourly renewal job. Member discount at the register goes through `G.memberDiscount` from `customerId` on `POST /staff/orders`.
  - Invoices: `invoices`, `invoice_payments`, public `/api/i/:token`, kind 'invoice'.
  - Wallet: `customers.card_token` and `gift_cards.wallet_token`, public `/api/w/:token`, scan value `BH-C-<token>`, register search at `/staff/customer-search`.
  - Google Wallet needs `GOOGLE_WALLET_ISSUER_ID` plus `GOOGLE_WALLET_SERVICE_ACCOUNT` (JSON). Apple Wallet needs `APPLE_PASS_TYPE_ID`, `APPLE_TEAM_ID`, `APPLE_PASS_CERT`, `APPLE_PASS_KEY`, `APPLE_PASS_KEY_PASSPHRASE` and `APPLE_WWDR_CERT` (PEM, \n escaped), and uses passkit-generator.
  - `completePayment` dispatches `G.payHooks[kind]`.
- `reach.js`
  - menu_items.description/allergens/diet/i18n (es); `menuWithMods` returns them.
  - Accounting: `/staff/accounting?format=quickbooks|xero|csv` (balanced daily journal, `acct_map` setting).
  - Link hub: `/go` is server-rendered with schema.org JSON-LD; `link_hits` tracking; `/staff/links`.
- `people.js`
  - Availability, time_off, shift_swaps and `/staff/me/*` routes; manager approvals; `shiftConflicts` warnings on `POST /staff/schedule`.
  - `/staff/performance`.
  - Chat: `messages`, guest `/api/g/:token/messages`, staff `/staff/chats` and `/staff/guests/:id/messages`, socket `chat` / `chat:new`.
- orders.customer_id and orders.allergy_note; the kitchen shows allergies, including the customer's allergy tags.
- Client: `Club.jsx`, `Reach.jsx`, `People.jsx`; `GuestMenu` takes `lang` and `viewOnly`.
- `/healthz` is now registered before the static fallback.

## 3g. Round 7 (2026-11-21)
Server: `server/src/extras.js` (lobby screen, add-on pairs, referrals, recovery, menu sync) and `server/src/house.js` (checklists + temperature logs, event tickets, bank deposits, menu engineering, prep list). Client: `client/src/pages/House.jsx`; `PairsHint` in `order-ui.jsx`.
- **Lobby screen** `/screen`: manager starts it from Settings; JWT in `localStorage.bh_screen`, sent as `X-Screen` (secret `jwt+':screen'`, revoked by bumping `screen_version`). Polls `/api/screen` every 5 s.
- **Add-ons**: `/api/public/pairs` = item → top co-ordered items over 60 days (`upsell_enabled`). Shown in the register cart, online order and kiosk.
- **Referrals (OPTIONAL, off by default: `referral_enabled='0'`)**: `customers.ref_code/referred_by/referral_rewarded`. `/account?ref=CODE` sends `ref` on sign-up; a 30-min job issues two single-use THANKS- codes once the friend has a visit.
- **Recovery**: feedback at or below `recovery_max_rating` creates a single-use SORRY- code, shown on the thank-you page, pushed and emailed; `recoveries` table tracks came-back.
- **Menu sync**: `POST /staff/menu/sync` (owner) matches items by name across locations via `runIn`.
- **Checklists/temps**: `checklist_templates`, `checklist_runs` (done JSON per item), `temp_units`, `temp_logs`; out-of-range requires a corrective action and alerts managers; 10-min job alerts overdue lists once a day (`house_alerts`). `/staff/inspection-log` feeds a printable report.
- **Events**: `events`, `tickets` (code, qty, status). Public `/events`, ticket `/ticket/:code` (API `/api/e/:code`, added to `resolveSlug`). Paid tickets use pay kind `ticket` → `h.payHooks.ticket`. Pending holds expire after 45 min. Staff page path is `/ticketing` (public `/events` owns that path).
- **Bank deposits**: `bank_deposits`; expected = `dailyBooks` by method group (cash/card/app) minus cash tip payouts; fees estimated from `fee_rates`. Import pulls Stripe payouts and Square payouts (`h.squareGet`).
- **Menu engineering**: `menuEngineering(days)`; popularity line 70% of equal share, margin vs weighted average; recipe cost or `food_cost_target` estimate. Tab in Purchasing.
- **Prep list**: same weekday over 8 weeks × (1 + `prep_buffer_pct`), ingredient needs via recipes vs stock.

## 3h. Round 8 (2026-11-21)
Server: `server/src/plus.js`. Client: `client/src/pages/Plus.jsx`; `ComboPicker`, `PriceTag`, `useCombos` in `order-ui.jsx`. House accounts were skipped by the owner.
- **Pricing hook**: `commerce.js` exports `menuHooks = { adjust: [], combo }`. `menuWithMods` runs every `adjust` function, so happy hour (`price_rules`, local time window, may cross midnight) and daily specials (`specials` by date or weekday, optional price, `menu_items.special_only`) change prices everywhere orders are priced. Items carry `regularCents`, `deal`, `special`. Admin `/staff/menu` stays raw.
- **Combos**: `combos` (slots JSON of itemIds/categories). `lineSchema` now accepts `{comboId, picks:[{itemId, mods}]}` and `course`. `menuHooks.combo` expands a combo into one order_item per pick, splitting the combo price by regular price; paid options add on top. Kiosk now uses the shared `lineSchema`.
- **Course firing**: `order_items.course` (1 now, 2+ held) and `fired_at`. Register "hold" checkbox; kitchen shows held items and a Fire button → `POST /staff/orders/:id/fire-course` (the old `/fire` is the pre-order start).
- **Customer display**: `/display`, JWT in `localStorage.bh_display_token` sent as `X-Display` (secret `jwt+':display'`, `display_version`). The register pairs by 4-digit code (`localStorage.bh_display`) and pushes state to `/staff/display/push`; the display long-polls `/api/display?v=`. Tip taps go to `/api/display/tip` → socket `display:tip` → PayModal.
- **Recipe cards**: `menu_items.build_steps`, photo in `assets` key `item:<id>`; `/staff/menu/:id/card`. **Training**: `training_modules`, `training_progress` (read, signed_by); managers can't sign themselves off (owners can).
- **Price watch**: `ingredient_costs` history, scanned every minute and on page load; alerts at `price_watch_pct`.
- **Table timers**: `table_long_minutes`, `kitchen_slow_minutes`; once-only alerts in `plus_alerts`; floor outlines long tables.
- **Goals and contests**: `sales_goals` (JSON of 7 cents values, Sun..Sat), `contests` ranked by `orders.created_by`.

## 3i. Round 9 (2026-11-21)
Server: `server/src/more.js`. Client: `client/src/pages/More.jsx`. House accounts are still not built (owner skipped them twice).
- **Menu schedules**: `menu_schedules`; a `menuHooks.adjust` filter hides items on a schedule outside its window (items on no schedule always show). Deals → Menu times.
- **Kitchen stations**: settings `kitchen_stations` (JSON list) and `station_map` (category → station). The kitchen query now returns `category` and `done_at`. A station screen bumps its items with `POST /staff/kitchen/:id/station`; when nothing is left the client calls `/orders/:id/ready`.
- **Gift bonuses**: `gift_promos`; `h.giftBonus` runs after staff and online gift sales (not comps or deposits) and issues a `source='bonus'` card with `gift_cards.valid_from/valid_until`; `h.giftUsable` blocks redemption outside that window.
- **Punch cards**: `punch_plans`, `punch_cards`, `punch_uses`. Sold at the register as a paid order with a null item line, or online (pay kind `punch`). Each use adds the eligible item's price to `orders.discount_cents` and recomputes tax.
- **Scheduled orders**: checkout accepts `scheduledFor` (local 'YYYY-MM-DD HH:MM'), checked by `h.checkSchedule`; the order is `held` with `orders.scheduled_for` and `sched_pay`. A one-minute job sends it to the kitchen `online_prep_minutes` before the time; unpaid pay-now holds are voided after 2 hours.
- **Live labor**: `/staff/labor-now` (open shifts × hourly rate vs paid sales), `labor_target_pct`, hourly alert when well over target.
- **Reservation timeline**: `bookings.table_id`, `duration_minutes` (default `booking_duration_minutes`); `PUT /staff/bookings/:id/place` with clash and seat checks (`force` to override).
- **Waste**: `waste_log`; logging deducts item stock and recipe ingredients (or the ingredient) and costs it.
- **Labels**: `menu_items.shelf_days` (default `label_shelf_days`); printed client-side with print CSS for 2×1, 4×2 and a 30-up letter sheet.

## 3j. Round 10 (2026-11-21)
Server: `server/src/owner.js`. Client: `client/src/pages/Owner.jsx`; dictionaries in `client/src/i18n.jsx` (ES, FR, ZH, VI). Pay by bank (ACH) is discussed but NOT built: offered to the owner as an option for large amounts.
- **Order again**: online checkout links `orders.customer_id` (`h.linkOrderCustomer`); order_items `mods` JSON now include option `id`; `/api/c/orders`; the account stores `bh_reorder` and `/order` re-adds still-valid lines (`useReorder`).
- **Tip-outs**: `users.tip_role`, setting `tipout_rules` [{from,to,pct,base:'sales'|'tips'}]; `/staff/tipouts` report (shares by hours). Separate from the hours×points tip pool.
- **Calories**: `ingredients.kcal` (per unit), `menu_items.calories` (override); a `menuHooks.adjust` adds `calories` when `show_calories='1'`.
- **Log book**: `log_entries`, `log_reads`; must-read notes show a banner (`/staff/logbook/unread`) until opened.
- **Equipment**: `equipment`, `equipment_events` (issue → open until a repair/service); daily due/overdue alert.
- **Auto reorder**: `autoReorder()` drafts POs (auto=1) for low ingredients with a supplier and no open PO; job every 2h when `auto_reorder='1'`, or the "Make orders for low stock" button.
- **Loyalty tiers**: setting `loyalty_tiers` [{name,minCents,pct,perk}], 365-day spend by `orders.customer_id`; wraps `h.memberDiscount` (better of membership or tier).
- **Call server**: `POST /api/t/:token/call` (server|check|water|help) → `table_calls`, push to the table's `server_id` (or everyone); banner with "on it" ack; auto-clears after 30 min. Setting `table_calls`.
- **Weekly report**: `weeklyReport(monday)`; Monday job at `weekly_report_hour` emails `report_email` (comma list) and pushes owners. `/report` page.
- **Languages**: setting `languages` (JSON, must include en); `/api/public/langs`; LangSwitch becomes a select with 3+; menu item `i18n` supports es/fr/zh/vi.
- **Supplier bills**: `supplier_bills`, `bill_payments` (partial payments, cash ones leave the drawer), `suppliers.terms_days`, photo/PDF in `assets` key `bill:<id>`; aging buckets, unbilled received POs, CSV, due-in-3-days owner alert. Route prefix is `/staff/supplier-bills` (`/staff/bills` is split checks).

## 3k. Round 11 (2026-11-21)
Server: `server/src/smart.js`. Client: `client/src/pages/Smart.jsx`.
- **Pay by bank**: Stripe Checkout with `payment_method_types[0]=us_bank_account` via `POST /api/pay/:token/bank`, offered by `h.bankOption` only for kinds invoice/ticket/deposit at or above `pay_bank_min_cents` when `pay_bank_enabled='1'` and Stripe is connected. Returning sessions that are complete but unpaid set `payments.bank_status='processing'`; the Stripe webhook now handles `checkout.session.async_payment_succeeded` (completes) and `..._failed` (`h.bankFailed`, alerts). Square ACH is not wired (Square only offers it on its own invoices/links).
- **Dish photos**: reuses the recipe-card photo (`assets` `item:<id>`), public `/api/public/item-photo/:id` when `menu_photos='1'` and `menu_items.show_photo=1`; a menu hook adds `photo`.
- **Online catering**: `catering_packages`; public `/catering-order` → `POST /api/public/catering` creates an invoice (`source='online'`, status sent, deposit `catering_deposit_pct`) and returns the `/i/:token` link. Lead time `catering_lead_hours`.
- **Auto schedule**: `proposeSchedule(weekStart)` layers shifts from 8-week same-weekday sales ÷ `staff_sales_per_hour_cents`, assigns staff by availability, time off and weekly hours (≤ `ot_weekly_hours`); `POST /staff/schedule/auto` inserts the kept shifts.
- **Barcode counts**: `ingredients.barcode`; `/count` uses `BarcodeDetector` (camera) or keyboard-wedge scanners; unknown codes can be linked to an ingredient.
- **Cook timers**: `menu_items.cook_minutes` (set on the recipe card); kitchen tickets show "start in N min" so items finish together.
- **Supplier prices**: `ingredient_prices` (learned from received POs and typed quotes); `/staff/price-compare` with monthly savings and one-tap switch.
- **Bills in accounting**: `apJournal()` adds bill (Dr expense / Cr AP) and payment (Dr AP / Cr bank or cash) journals to the QuickBooks and Xero exports when `bills=1`. Account names come from `acct_map` (keys ap, bank, cash, food, drinks, supplies, equipment, rent, utilities, services, other).
- **Review themes**: keyword groups over feedback comments (praise 4–5★, complaints 1–2★) on the Feedback page.
- **Safe log (optional, `safe_log_enabled='0'` by default)**: `safe_log` counts/drops/bank runs/adjustments; `safe_two_person` requires a different user's PIN (rate-limited with the login lockout); drops also leave the open cash drawer; owner alert when a count is off by $1+.

## 3l. Round 12 (2026-11-21)
Server: `server/src/timeclock.js`, `server/src/desk.js`. Client: `client/src/pages/Clock.jsx`, `client/src/pages/Desk.jsx`.
- **Flicker fix**: `Modal` (ui.jsx) keeps `onClose` in a ref so its GSAP/focus effect runs once; parents with ticking clocks no longer re-animate open windows.
- **Trusted-device rate limits**: `isTrustedDevice(req)` skips `apiLimiter`/`publicLimiter` for a valid staff cookie or X-Kiosk / X-Screen / X-Display / X-Clock token (devices in one business share one IP).
- **Time clock screen** `/timeclock`: token from `POST /staff/timeclock/start` (manager) in `localStorage.bh_clock`, sent as `X-Clock`, revoked by `clock_version`. `POST /api/clock/punch {pin, action}` (check → choices → in/out/break_start/break_end) uses the login lockout. Shows who's on with break timers; `clock_message` banner. `shifts.break_started`, `shifts.source`.
- **Who's on** (`GET /staff/whos-on`): Dashboard, Shifts, top-bar chip; managers can start/end breaks and clock people out. **My time card** (`/staff/me/timecard`) on My shifts; phone punching only when `app_punch='1'`.
- **Allergen chart**: `/allergens-chart` (staff, printable) and public `/allergens`.
- **Seating rotation**: `/staff/rotation` → "Seat next" on Waitlist and Floor.
- **Supplier credits**: `supplier_credits`; auto-applied to the open bill for the same PO, else applied manually (bill_payments method `credit`, journal Dr AP / Cr expense).
- **Sales tax report** `/sales-tax` (owner) by month/quarter/year, CSV.
- **Stock transfers**: Purchasing → Transfers; matches ingredients by name at the other location (creates if missing).
- **Certificates** `/certificates`: photo upload, verify, `required_certs`, missing list, alerts 30/7/0 days.
- **Cash flow** `/cash-flow` (owner): `cash_balance_cents`, `fixed_costs`, `payroll_dow`, `payroll_every`.
- **Delivery zones** `/delivery-zones`: Leaflet polygons with fee/minimum; `h.deliveryZone` used at checkout and `/api/o/delivery-quote`; outside all zones = error; no zones = flat fee.
- **Catering follow-up**: day-after email (`catering_followup='1'`) to `/rate/:token`; ratings list on Catering.

## 3m. Round 13 (2026-11-21)
Server: `server/src/kds.js`, `server/src/crew.js`. Client: `client/src/pages/Areas.jsx`, `client/src/pages/Crew.jsx`.
- **Kitchen area screens** `/kds`: device token `X-Kds` (secret `jwt+':kds'`, `kds_version`, area in the token) from `POST /staff/kds/start {area}`, or a signed-in staff member with `?area=`. Areas = `kitchen_stations` + Expo + Packing + All areas. Routing: `menu_items.station` (per-item) → `station_map[category]` → first area (`stationFor`). `POST /api/kds/bump` sets `order_items.done_at` + `done_station`; when every live item is done the order goes ready via `h.markReady` (extracted from `/staff/orders/:id/ready`), unless `kds_expo='1'`, then Expo's `POST /api/kds/complete` finishes and buzzes. Packing (`kds_pack`) lists to-go/delivery orders until `POST /api/kds/packed` (`orders.packed_at`). `/api/kds/recall` undoes. All-day counts per area; `/staff/kds/setup` adds per-area average minutes today. Polls every 4 s.
- **Menu board TV** `/menuboard`: `X-Board` token (`board_version`), `GET /api/menuboard` uses `menuWithMods()` so specials, happy hour, sold-out and photos are live. Settings `board_title`, `board_categories`, `board_cols`, `board_rotate_seconds`, `board_photos`.
- **Overtime guard** (`ot_guard`): `h.punchGuard` blocks a clock-in projected past `ot_weekly_hours` (week so far + today's schedule) unless a different manager's PIN (`managerPin`) approves; lock screen refuses with a message; manager punches self-approve. Errors carry `needsManager` / `overtime`.
- **Phone clock-in by location** (`punch_geofence`, `punch_radius_m`, `biz_lat`, `biz_lng`): `/staff/me/punch` takes `lat/lng/acc` and checks distance (`h.phonePunchCheck`).
- **Punch photos** (`punch_photo`): the time clock sends a 240px JPEG; `punch_photos`, `/staff/punch-photos`, purged after 60 days.
- **Handoff notes** (`handoff_notes`): `handoff_notes` table; written at clock-out on the time clock (`action: note`) or the Overview/Shifts panel; returned on the next clock-in (time clock, lock screen, phone).
- **Payroll files**: `/staff/payroll?format=gusto|adp` via `h.payrollFile`; `users.payroll_id`, `adp_company_code`. Column layouts are generic; check them against the owner's import template.
- **Use first**: `ingredient_lots` (use_by from `ingredients.shelf_days`), created on PO receive (`h.onReceive`) or by hand; used up / thrown out (logs waste, takes stock off); alerts for today/tomorrow.
- **Table turns** `/staff/table-turns`: guests seated→closed with spend, by size, section, day, hour, server; tables over 125% of typical.
- **Private rooms**: `rooms`, `room_bookings`; public `/event-rooms` (`rooms_online`, `rooms_lead_days`), status page `/event-room/:token` (API `/api/v/:token`, added to `resolveSlug`), deposit via pay kind `room`; staff confirm/decline/check in (deposit becomes a one-time gift card)/done; spend toward the minimum counts orders on the room's tables in the time window; Floor banner.

## 3n. Round 14 (2026-11-21)
Server: `server/src/pace.js` plus additions to `kds.js`, `timeclock.js`, `house.js`, `back.js`, `crew.js`. Client: `client/src/pages/Pace.jsx`, `Areas.jsx`.
- **Bump bars** (client only): on `/kds`, keys 1–9 select a ticket, arrows move, Enter/Space runs the ticket's main button, R/Backspace recalls the last finished, A toggles all-day. Most bump bars send these keys.
- **Talking tickets** (client only, per screen `localStorage.bh_kds_speak`): `speechSynthesis` reads new tickets for that area, with allergies.
- **Allergy check** (`kds_allergy_check`): `/api/kds/complete` needs `allergyConfirmed` when the order has an allergy (note or customer allergy tags); `/api/kds/bump` returns `needsAllergyCheck` instead of finishing; `orders.allergy_checked_by` + audit `allergy.check`. With `kds_expo='0'`, any area may call `/complete`.
- **Ticket pacing** (`kds_pacing`): per item `startIn` = fire time + (longest cook on the ticket − this cook), from `menu_items.cook_minutes`.
- **Area lists**: `checklist_templates.area`; `/api/kds` returns that area's lists; `POST /api/kds/list-check` ticks them (by the screen or the signed-in user).
- **Curbside** (`curbside`, `curbside_prompt`): `orders.arrived_at`, `arrival_note`, `handed_at`; guest view `curbside`; `POST /api/g/:token/here`; staff `POST /staff/orders/:id/handed` and `/api/kds/handed` (closes the pickup buzzer); arrivals banner on packing/expo/all screens; socket `security` type `curbside` toasts staff.
- **Kitchen speed** `/staff/kitchen-speed?days=`: sent→ready by hour, day, channel; area and dish times from `order_items.done_at − COALESCE(fired_at, sent_at)`; slowest tickets.
- **Event menus**: `room_bookings.menu` (JSON lines), `fire_time`, `fired_order_id`; `PUT /staff/rooms/bookings/:id/menu`, `POST .../fire` (creates an order, source `event`, on the room's first table); a minute job fires at `fire_time`; `h.eventsToday` feeds a banner on area screens.
- **Break planner** `/staff/break-plan`: on-clock staff without a break, earliest 2 h in, due by `break_after_hours`; picks the quietest 15-minute slots from the same-weekday 8-week sales curve, at most a quarter of the team at once; `break_minutes_planned`.
- **Declared tips** (`declare_tips`): `shifts.declared_tips_cents`, asked at time-clock and phone clock-out (`tipsCents`); `PUT /staff/shifts/:id/declared-tips`; payroll CSV "Cash tips declared", Gusto `cash_tips`, ADP Earnings 4 `CT`.

## 3o. Round 15 (2026-11-21)
Server: `server/src/line.js` plus hooks in `commerce.js` (online quote/pause), `timeclock.js` (pulse, tip-out), `kds.js` (rush, recent items). Client: `client/src/pages/Line.jsx`, `Areas.jsx`.
- **Print at each area** (client): area screen "Print" toggle (`localStorage.bh_kds_print`) prints that area's new tickets with `TicketPrint` + `printPart('printing-ticket')`. Use Chrome `--kiosk-printing` to skip the dialog.
- **Recipe cards on area screens**: `GET /api/kds/card/:id` (+ `/photo?t=<token>` since an <img> can't send headers); the "i" button on each item.
- **86 from the line**: `GET /api/kds/menu`, `POST /api/kds/86 {itemId, out}` sets `menu_items.stock` 0 / NULL, logs a stock move, pushes everyone.
- **Remakes**: `POST /api/kds/remake {orderItemId, qty, reason}` adds a $0 `order_items` row noted `REMAKE: reason` (fired now), reopens a ready order, logs `remakes` (cost from recipe or `food_cost_target`); `/staff/remakes` on the Kitchen speed page. Reasons in `REMAKE_REASONS`.
- **Temps on area screens**: `temp_units.area`; `GET/POST /api/kds/temps` (corrective action required out of range, `by` name stored in the note, managers pushed).
- **Smart pickup times** (`smart_quotes`, `kitchen_parallel`): `quoteMinutes()` from the last 3 hours' ticket average and tickets cooking; replaces `onlineInfo().readyInMinutes`.
- **Rush mode** (`rush_mode` off|auto, `rush_busy_*`, `rush_pause_*`, `rush_extra_minutes`, manual `online_paused_until`): `rushState()` = normal / busy (+minutes) / paused (online checkout refused with a friendly message); `/staff/rush`, `/staff/rush/pause`, `/api/kds/pause`; managers pushed when the level changes; rush bar on Kitchen page and expo/all screens.
- **Shift pulse** (`shift_pulse`, `pulse_anonymous`): `shift_pulse` table; time-clock action `pulse {rating 1–4}` after clock-out; `/staff/pulse`; rating 1 pushes managers.
- **Labor by area**: `users.area`; `/staff/labor-by-area` (owner) = hours and wages per area vs. sales of dishes that area makes (`stationFor`), Front of house vs. all sales.
- **Tip-out at clock-out** (`tipout_at_clockout`): `shiftTipout()` applies `tipout_rules` for the person's `tip_role` to their sales and tips (card tips + declared) for that shift; returned as `tipout` on the clock-out punch.

## 3p. Round 16 (2026-11-21)
Server: `server/src/pass.js` plus hooks in `commerce.js` (seat on lines, slots), `kds.js` (seat, cook, pass, shelf, extra data), `growth.js` (dish ratings), `smart.js` (schedules by area). Client: `client/src/pages/Pass.jsx`, `Areas.jsx`.
- **Seat numbers**: `order_items.seat`; `lineSchema.seat` (1–40); register seat chips for the next items when a table is chosen; shown on tickets, area screens and printed slips.
- **Pass timer** (`pass_alert_minutes`, needs `kds_expo`): order `passSince` = last item done when all are done; expo shows "At the pass Nm", red past the limit; a 30-second job pushes staff once (`orders.pass_alerted`).
- **Screen-to-screen messages**: `kds_messages`; `POST /api/kds/msg {to, body}`, `/api/kds/msg/:id/ack`; quick messages from `kds_quick_messages`; banner with "Got it".
- **Batch timers**: `kds_timers` per area (≤ 8), `POST /api/kds/timers`, `/api/kds/timers/:id/restart|done|stop|delete`; the screen beeps until tapped.
- **Order slots** (`slot_capacity` per 15 min): `h.slotFor(scheduledFor)` picks the first slot with room after the quote (or rejects a full chosen time); `orders.promised_at`; `/api/o/slots`; `onlineInfo().readyInMinutes` uses it.
- **Pickup shelves** (`pickup_shelves` "A1-A6, B1-B6" or a count): packing asks for a free shelf on Bagged (`orders.shelf`), guest page shows it; `/api/kds/shelf`, `/staff/orders/:id/shelf`.
- **On my way**: `POST /api/g/:token/eta {lat,lng}` (needs `biz_lat/biz_lng`) stores `eta_minutes/eta_km`; within 150 m marks arrived; packing/expo banner.
- **Who made it**: area screen cook picker (on-clock staff) → `order_items.done_by`; `/staff/cook-stats` (dishes, average minutes, remakes) on Kitchen speed.
- **Rate each dish** (`dish_ratings`): `/api/f/:token` returns `dishes`; POST accepts `dishes [{name, liked}]` → `dish_ratings`; `/staff/dish-ratings` on Feedback.
- **Schedules by area** (`schedule_by_area`, `area_sales_per_hour_cents`): `proposeSchedule` runs once per area team (`users.area`) on that area's item sales (`h.areaSalesByDow`), plus Front of house; shifts carry `area` into `schedule.role_note`.

## 3q. Round 17 (2026-11-21)
Server: `server/src/run.js` plus hooks in `kds.js` (Runner area, fireIn, makegood flag), `commerce.js` (tabs on table orders, table bills skip tab orders, `business.unitLabel`), `extras.js` (lobby shelf), `delivery.js` (`h.geocode`). Client: `client/src/pages/Run.jsx`.
- **Server order pad** `/pad` (client only): table → seat chips → `GuestMenu` from `/api/o/menu` → `POST /staff/orders` with `seat`/`course`.
- **Auto-fire courses** (`course_gap_minutes`): a 30-second job fires the next held course once every earlier-course item is done and the gap has passed; `h.fireIn` shows "Fires in Nm" on held items.
- **Ingredient 86** (`ingredient_86`): ingredients at stock ≤ 0 86 every active dish in their recipes (`ingredient_86` table), released when restocked; area screens' 86 window has "Out of it / Back in" (`/api/kds/ingredients`, `/api/kds/ingredient-86`, `ingredients.manual_out`, `prev_stock` restores the count).
- **Prep per area**: `/api/kds/prep` filters `prepList()` to the area's dishes and their ingredients; ticks are kept on the device for the day.
- **Runner screen**: area "Runner" lists table orders that are finished (all items done, or ready in the last hour) and not served; items grouped by seat; `POST /api/kds/served` sets `orders.served_at`.
- **Late-ticket make-good** (`makegood_minutes`, `makegood_item_id`, `makegood_pct`): late open orders flagged on expo/all screens and Orders; managers pushed once (`makegood_alerted`); `POST /api/kds/makegood` or `/staff/orders/:id/makegood {kind: item|discount}` adds a $0 dish or a % discount (totals recomputed), notes the order, `makegood_at`.
- **Shelves on lobby screen**: `/api/screen` ready orders include `shelf`.
- **Delivery batching** (`batch_radius_km`, `batch_window_minutes`): `/staff/delivery-batches` geocodes and groups unassigned deliveries (≤ 4, all within the radius, ready within the window); `/staff/delivery-batches/assign` sets one driver.
- **Bar tabs** (`bar_tabs`): `tabs` table; `POST /api/t/:token/tab {name}`, `GET .../tab/:tab`, table orders with `tab` set `orders.tab_id`; closing makes a bill of the tab's unpaid orders (`/api/t/:token/tab/:tab/close`, `/staff/tabs/:id/close`); a sweep closes paid tabs. The client keeps the tab token per table in `localStorage`.
- **Area staffing alerts** (`area_alerts`, `area_alert_high`, `area_alert_quiet_minutes`): `areaLoad()` = waiting items vs. on-clock cooks per area (`users.area`); `/staff/area-load` chips on Kitchen; 5-minute job pushes "needs help" / "is quiet" (once per 45 / 120 minutes, `area_alerts`).

## 3r. Round 18 (2026-11-21)
Server: `server/src/table.js` plus hooks in `run.js` (tab code/members, close with `member`), `commerce.js` (`orders.tab_member`), `kds.js` (timeline, photo check), `index.js` (`/api/c/bookings/:id/late`). Client: `client/src/pages/Table.jsx`, changes in `Run.jsx`, `Areas.jsx`, `PayPhone.jsx`, `Account.jsx`.
- **Split a tab**: each tab gets a 4-letter `tabs.code`; `POST /api/t/:token/tab/join {code, name}`; table orders carry `member` → `orders.tab_member`; tab view lists members; closing with `member` returns that member's `items`, and `/p/:token?items=1,2` opens the pay page on "My items".
- **My tables on the pad**: `/staff/pad/tables` (server section `tables.server_id`, seated minutes, open checks and totals, food ready); pad shows mine first with "Show all".
- **Pay at the table from the pad** (client): `POST /staff/bills {tableId}` → summary; "Took cash" / "Paid on card reader" → `/staff/bills/:id/payments`; or the bill QR for the guest's phone.
- **Area screens offline** (client): last `/api/kds` response cached per area in `localStorage`; network failures queue bump/complete/packed/served/recall/msg/timers/list/handed calls in `bh_kds_queue`, flushed in order on the next successful load (server rejections are dropped).
- **Table timeline**: `h.tableTimeline()` = seated tables with course states (held/cooking/ready/served); on expo, all and runner screens and the Floor page (`/staff/table-timeline`).
- **Prep log**: `prep_log` per day/area shared across screens (`/api/kds/prep-log`); ticking an ingredient with `shelf_days` adds an `ingredient_lots` batch (removed if unticked).
- **Delivery route order**: `/staff/deliveries/route?driver=` nearest-neighbour from the business location; Google Maps multi-stop link.
- **Running late**: `bookings.late_minutes/late_at`; customers tap "Running late" on their account; staff pushed; Bookings shows the chip.
- **Server coaching** `/staff/coaching`: check average, items per check, add-on rate (categories matching drink/dessert/side/starter…), tip %, against the team, with coaching hints after 5 checks.
- **Expo photo check** (`photo_check` off|allergy|special|all): `/api/kds/complete` returns `needsPhoto` until `POST /api/kds/plate-photo`; `plate_photos` kept 60 days; `/staff/plate-photos` on Kitchen speed.

## 3s. Round 19 (2026-11-22)

New module `server/src/station.js` (`registerStation`, after `registerTable`) and client `pages/Station.jsx`.
- Station layout lives in `OrderPad` (Run.jsx): CSS grid `.station-grid`, three columns at 1000px and up. The nav label is now "Server station".
- Schema: `orders.priority` (0 normal, 1 rush, 2 VIP), `bookings.preorder` (JSON lines), `delivery_photos (order_id, data)`.
- KDS sort is `o.priority DESC` first (kds.js). Area screen toggle `bh_kds_big` adds `.kds-big`.
- Booking pre-order chains `h.onBookingCheckin` (keeps the pro.js hook) and inserts a held `source='guest'` order for the booking's guest, so the existing `fireHeldPreorder` fires it on seat. Setting `booking_preorder`.
- Gift on checks uses the new `h.applyGift(order, code, user)` in commerce.js (shared with the order route's logic).
- Checkout: cash to hand in = cash collected − cash tips − card tips. Tip-outs come from `shiftTipout`.
- Staff customer lookup is `/staff/customer-find` (not `/customers/find`, which `/customers/:id` would catch).

## 3t. Round 20 (2026-11-22)
New module `server/src/flow.js` (`registerFlow`, after `registerStation`). Client additions in `pages/Station.jsx` (SeatMap, MoveTable, SignaturePad, PrepPars), `Run.jsx` (station shortcuts, prep counts), `Areas.jsx` (rush toggle, `bh_kds_theme` standard|contrast|safe → `.kds-theme-*`), `Field.jsx` (signature).
- Transfer moves unpaid orders, open bills and open tabs to the new table, moves the guest and marks the old table dirty; handing to a server sets `tables.server_id` and the unpaid orders' `created_by` (so server checkout follows the checks).
- Pars: `h.applyPars(items, keep)` runs inside `/api/kds/prep` before recipe totals; `prep = max(forecast, par) − onHand` (today's `prep_counts`).
- Signature gate lives in delivery.js `/orders/:id/delivered` via `h.needsSignature`; error flag `needsSignature` added to the error handler.
- Pre-order reminder job every 10 minutes; manager trigger `POST /staff/preorder-reminders/run`. Settings `preorder_reminder`, `preorder_reminder_hour`, `delivery_signature_cents`.
- Fixed `pj()` in station.js: `JSON.parse(null)` returns null, which broke `/staff/bookings`.

## 3u. Round 21 (2026-11-22)
New module `server/src/seat.js` (`registerSeat`, after `registerFlow`). `more.js` waste logging is now `h.logWaste(body, user)`. Client: more components in `pages/Station.jsx` (JoinTable, useSeatAllergies, SplitBySeat, TopDishes, RecallList), wiring in `Run.jsx`, `Table.jsx`, `Areas.jsx`, `Account.jsx`, `Receipt.jsx` / `pro-ui.jsx` ReceiptBody.
- Join moves unpaid orders (seat numbers + main table's seat count) and voids the other table's unpaid open bill; the other table keeps `joined_to` and shows "joined to" on the station. Unjoin releases joined tables as dirty.
- Seat allergies are applied in `POST /staff/orders` via `G.applySeatAllergies(orderId, tableId)`.
- Pre-order prepay: `payments.kind='preorder'`, `h.payHooks.preorder` adds to `bookings.preorder_paid_cents`; `h.preorderCredit` (called from the station.js check-in hook) adds it to the held order's `gift_cents`. The payment itself is not counted as sales; the order is, when it's paid.
- Receipts: `receiptData` adds `proof` via `proofHook.fn` (pro.js); delivery.js calls `h.afterDelivered(order, req)`.
- Auto-VIP uses `orders.vip_checked` so each order is checked once.
- Pacing: `h.coursePace(tableId, course)`; median gaps cached 10 minutes.

## 3v. Round 22 (2026-11-22)
New module `server/src/serve.js` (`registerServe`, after `registerSeat`). Client changes in `Station.jsx` (seat names in `useSeatAllergies` → `[allergies, setAllergy, names, setName]`, recall reasons, signature tip, `GuestScreenCheck`), `Run.jsx`, `Areas.jsx` (allergy slip), `Table.jsx`, `Field.jsx`, `Plus.jsx` (display lines with qty 0 show no count).
- Seat names share the `seat_allergies` row (allergy may be ''); allergies only apply where allergy <> ''.
- Auto-join runs in `/staff/guests/:id/seat` (response `joined`), only over tables that are open with no unpaid orders.
- `h.prepSplit` adds `split {hour, first, second}` to prep items (cached 30 minutes).
- Leftover rollover writes tomorrow's `prep_counts` for items with `menu_items.shelf_days > 0`.
- `/api/kds/recall` takes an optional `reason` (missing|wrong|remake|cold|other) → a `remakes` row with qty 0.
- VIP arrival sweep every 20 s (`guests.vip_alerted`); fire reminders every 60 s (`fire_reminders` keys). Both emit socket `security` with type `vip`/`fire`.

## 3w. Round 23 (2026-11-22)
New modules `server/src/care.js` (`registerCare`) and `server/src/print.js` (`registerPrint`), both registered after `registerServe`; `tools/print-agent.mjs`; client `src/printing.js`, `pages/Devices.jsx` (DevicesPage at `/devices`, PrintAgentPage at `/print-agent`), more in `Station.jsx`.
- Printing: helper JWT `X-Print` (secret `jwt+':print'`, `print_version`, `agent` id), trusted for rate limits. Tables `print_agents`, `printers` (jobs JSON, area for tickets, connection network|usb|bluetooth|browser|device), `print_jobs` (queued → sent → done/failed, 3 tries, re-queued if not answered in 2 min, failed after 30 min unclaimed, purged after 3 days). Long-poll wakes via an EventEmitter keyed `slug:agentId`.
- Jobs are plain `lines` ({text, bold, big, center, right, invert}) or `html`; helpers turn lines into ESC/POS (`escpos()` in both printing.js and print-agent.mjs; keep them in step). Browser printers print the HTML/lines with the `printing-agent` print mode.
- Auto kitchen tickets: `orderHooks.inserted` (status sent) and `h.printTickets(orderId, reprint, course)` from station/plus/run fire paths. Area screens skip their own browser printing when a printer covers their area.
- Client `devicePrint(kind, job, fallback, headers)` posts to `/api/print` and falls back when nothing is routed. `printPage(title)` sends the page HTML as a `report`.
- care.js: seat history `/staff/tables/:id/seat/:seat/history`; allergy hand-off (`orders.allergy_handed_by/at`, `/api/kds/allergy-handoff`); `table_combos` + `bookings.combo_id` (joined in the seat route before auto-join); `h.wasteAdjust` (over-prepped waste on the same weekday over 4 weeks, cut ≤ 30%); driver checkout; remake alerts (2-minute sweep); `/staff/customers/:id/vip-card` (not `/card`, which crm.js owns); `h.partyGap` (median gap by course and party bucket, used before the general gap).
- Bug caught in testing: VIP banner state must live in `Shell`, not the boot component.

## 4. Architecture
```
package.json        root: postinstall installs server+client; build → client; start → server
railway.json        Railway build/deploy config
server/src/
  index.js          Express app, all REST routes, Socket.IO, static hosting of client/dist
  db.js             SQLite schema (settings, users, tables, guests, menu_items, orders, order_items, audit), settings, demo seed
  security.js       PIN hashing/lookup, weak-PIN rules, IP lockout, JWT cookie sessions, role middleware, CSRF guard
  sms.js            Optional Twilio SMS fallback (env-gated)
client/src/
  main.jsx          Routes: /b/:token (guest), /join (self check-in), /* (command center)
  lib.js            fetch wrapper (adds X-BuzzHub header), sockets, money/time utils, Lenis hook, WebAudio buzz sounds, accent theming
  ui.jsx            Icons, Puck (pager LED), Modal, Toasts
  styles.css        All styling. Design tokens at top (graphite + amber "pager LED" palette, Bricolage Grotesque + Instrument Sans)
  bits/             React Bits components copied in (Aurora, SplitText, ShinyText, SpotlightCard, ClickSpark, StarBorder) + license
  pages/
    CommandCenter.jsx  Boot (setup → lock → shell), nav rail, idle auto-lock, staff socket, useLive() data hook
    Lock.jsx           PIN keypad (keyboard too), wrong-PIN shake, lockout countdown
    Setup.jsx          First-run claim with setup code
    Dashboard.jsx      KPIs, sales by hour, best sellers, activity feed
    Waitlist.jsx       Queue (tables + pickup), add guest, QR modal, buzz modal (assign table + message), seat/remove, door code
    Floor.jsx          Tables by zone; open/held/seated/dirty; buzz-and-hold
    Register.jsx       POS grid, ticket, discount, tax, pickup buzzer, PayModal (tips, cash change)
    Orders.jsx         Open/closed orders; Ready → buzzes customer; pay; void (manager)
    Admin.jsx          Menu, Staff (PINs/roles/revoke), Settings, Security log
    Guest.jsx          Phone buzzer: big puck, position/ETA, alarm (sound/vibrate/flash/notification), ack, wake lock
    Join.jsx           Self check-in form
```

### Realtime model
- Staff sockets authenticate with the session cookie and join `staff`, `user:<id>`, and `owners` (manager+).
- Guest sockets authenticate with `auth.guestToken` and join `guest:<id>`.
- The server emits `sync {scope}` (guests/tables/orders/menu). Pages refetch through `useLive()`.
- `buzz` and `guest:update` go to guests. `guest:ack`, `security`, `force-lock` and `settings` go to staff.

### Key API routes
- Public: `GET /api/setup/status`, `POST /api/setup`, `POST /api/auth/login|logout`, `GET /api/auth/me`, `GET /api/public/business`, `POST /api/public/join`, `GET /api/g/:token`, `POST /api/g/:token/ack|leave`, `GET /healthz`
- Staff (cookie): `/api/staff/settings`, `/dashboard`, `/guests` (+ `/:id/qr|buzz|seat|remove`), `/join-qr`, `/tables` (+ `/:id/status`), `/menu`, `/orders` (+ `/:id/ready|pay|void`), `/users` (+ `/:id/revoke`), `/audit`
- Every non-GET `/api` request must send the header `X-BuzzHub: 1` (CSRF guard).

## 5. Security design (keep these guarantees)
- PINs are 4–8 digits, bcrypt cost 12, and unique across active users. A weak list and repeated digits are rejected.
- Login: 15 requests per minute per IP, plus escalating lockout after 5 failures (30s → 2m → 8m → 32m → 1h cap). Managers get a live alert on each bad PIN.
- Session: JWT in an httpOnly, SameSite=Strict cookie (Secure in production), 12h. `users.session_version` must match, so PIN/role changes, disabling and "sign out everywhere" revoke sessions immediately.
- Roles staff < manager < owner are enforced server-side. Only the owner changes roles, and the last active owner can't be removed.
- Prices are computed on the server from item IDs. Discounts over 10% need a manager.
- zod validation on every input, Helmet CSP, 64 KB JSON limit, `Cache-Control: no-store` on the API.
- Guest tokens are 18 random bytes (base64url). The guest view exposes only the first name and their own status.
- First-run claim requires `SETUP_CODE` (or a random code printed to the logs).
- The audit log records every auth event, change, sale and buzz, with IP.

## 6. Known limits / good next features
- iOS Safari can't vibrate from the web. Sound, flash and notifications are used instead (Web Push needs a home-screen PWA on iOS). Possible upgrade: a service worker + Web Push so alerts work with the page closed.
- Card-present payments are recorded only; phone/online payments use Stripe Checkout once `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`) is set on Railway. Next step: Stripe Terminal.
- SQLite = a single instance. Fine for one location. Move to Postgres for multi-location.
- Ideas: printable receipts/kitchen tickets, reservations, multiple locations, end-of-day report export (CSV), menu modifiers, per-terminal device registration, optional 2FA for owners.

## 7. Run locally
```bash
npm install && npm run build
SETUP_CODE=123456 DATA_DIR=./data npm start   # http://localhost:8080
```
Dev: `npm run dev:server` (8080) + `npm run dev:client` (Vite 5173, proxies the API and sockets).

## 8. Owner context
- GitHub user: `georgewitchley-dot`. The owner hosts other apps (e.g. HazardHarbor) on Railway.
- The owner prefers having everything done for them end to end, including deploys.
