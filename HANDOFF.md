# BuzzHub — Handoff brief for the next AI / developer

Read this first, then `README.md`. Everything you need to continue is in this repo.

## 1. What the owner asked for
"A badass POS command center and a table-buzzing app for any business I plug it into, with security on both the app and the command center, PIN login for the command center, and neat features." Use GSAP, Lenis and React Bits, keep it in a GitHub repo, and host it on Railway.

## 2. Current status (2026-11-21, round 7 deployed)
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
