# BuzzHub

A POS command center and phone-based table buzzer you can set up for any business: restaurants and bars, cafés and counters, salons, clinics and shops.

Guests scan a QR code and their own phone becomes the buzzer, so there's no app or hardware to buy. Staff run the waitlist, floor, register and orders from a PIN-locked command center that updates live on every screen.

## What's in it

**Command center** (`/`)
- PIN keypad unlock, a separate PIN for each person, and auto-lock when idle
- Overview: live waits, tables in use, sales, tips, best sellers and an activity feed
- Waitlist: add a party, show the buzzer QR, buzz (optionally assigning a table), seat, mark a no-show. Quoted wait times and late warnings. Pickup queue for order-ready buzzers.
- Floor: tables by area with open / held / seated / needs-bussing states. Buzz and hold a table for a waiting guest.
- Register: menu grid, ticket, discounts, tax, tips, cash change, and an optional pickup buzzer per order
- Orders: open tickets. Marking one ready buzzes the customer.
- Menu, Staff, Settings and Security log for managers and owners

**Guest buzzer** (`/b/:token`)
- Shows place in line and estimated wait, updated live
- When buzzed: alarm sound, vibration (Android), screen flash, a notification, and a repeat every 20s until they tap "I'm on my way"
- Keeps the screen awake while waiting, and lets the guest leave the list

**Self check-in** (`/join`): guests scan the printed door sign (with your logo in the middle of the QR code) and add themselves.

**Phone notifications, free**: guests tap "Turn on alerts" and allow notifications. Their phone then gets a real notification when they're almost up and when they're buzzed, even with the page closed. This uses standard Web Push, so there's no SMS and no paid service. On iPhone (iOS 16.4+) the guest adds the page to their Home Screen first; the page walks them through it.

**Order ahead**: when the wait drops under the number of minutes you set, guests get an "almost ready" alert and can order drinks or sides from their phone. The order waits until you call the party, then goes to the bar or kitchen attached to their table. You choose which menu items can be ordered ahead.

**Customer accounts and booking** (`/account`): customers create a free account with email and password, book a time slot, get a reminder before it, and tap "I'm here" when they arrive. That puts them in the queue, and they get buzzed when their chair, room or table is ready. You set the open days, hours, slot length and how many bookings fit per slot.

**Email (optional, free)**: add your own mailbox (for example a Gmail app password) as `SMTP_*` variables, and guests who give an email also get alerts by email.

## Security

- **PINs**: 4–8 digits, hashed with bcrypt (cost 12), unique per person. Weak PINs (1234, 0000, repeated digits) are rejected.
- **Brute-force lockout**: 5 wrong PINs locks the terminal's IP for 30s, then 2m, 8m and 32m, capped at 1h. There's also a global rate limit on auth routes, and managers get a live alert for every wrong PIN.
- **Sessions**: signed JWT in an `httpOnly`, `SameSite=Strict` cookie (`Secure` in production) that expires after 12h. Changing a PIN or role, disabling a person, or "Sign out everywhere" kills their sessions on the next request.
- **CSRF**: every write must carry a custom `X-BuzzHub` header, on top of the SameSite cookies.
- **Roles**: staff < manager < owner, enforced on the server. Voids, discounts over 10%, menu, staff and settings need a manager or owner.
- **Server-side pricing**: the client sends item IDs and quantities only, and prices come from the database.
- **Validation**: every input is checked with zod. Helmet sets a strict CSP and security headers. JSON bodies are capped at 64 KB.
- **Guest links**: 144-bit random tokens. Guests only see their first name and their own status, and they can't reach any staff data.
- **First-run claim**: setup needs a one-time code printed to the server logs, so a fresh deploy can't be claimed by a stranger.
- **Customer accounts**: passwords are bcrypt-hashed, and a separate `SameSite=Lax` cookie that can never act as a staff session. 8 wrong passwords locks that email for 15 minutes, and a booking is checked against capacity in a write transaction so a slot can't be double-booked.
- **Uploads**: logos are re-encoded to PNG in the browser and checked by file signature on the server. SVG is never accepted, so a logo can't carry script.
- **Guest pre-orders**: prices come from the server, only items you mark as order-ahead can be ordered, quantities are capped per party size, and there's a rate limit.
- **Audit log**: every unlock, failed PIN, sale, void, buzz and settings change, with the person and IP address.

## Running the business

- **Kitchen screen**: tickets with timers that turn red when late, a chime for new tickets, full-screen mode and recall.
- **End-of-day report**: sales, discounts, tax, tips, payment methods, items, staff, refunds, labor, waits and the cash drawer, for any day in your own time zone. Export to CSV or print.
- **Cash drawer**: open with a float, record paid in and out, count by bill and coin, and see if it's over or short (managers get an alert at $5 or more).
- **Shifts**: clock in and out with your PIN on the lock screen, a weekly schedule, time-card fixes, hourly pay (owner only) and labor cost against sales.
- **Floor plan editor**: drag tables to match your room, pick round, square or bar shapes, resize them, use areas as tabs, and assign a server to each table.
- **Pay by phone**: guests scan the check, tip and pay by card, Apple Pay or Google Pay through Stripe Checkout. Set `STRIPE_SECRET_KEY`, and optionally `STRIPE_WEBHOOK_SECRET` with the webhook pointed at `/api/stripe/webhook`.
- **Multiple locations**: each location has its own database (waitlist, menu, team, customers, reports, door sign). Owners add locations, switch with one tap, and see every location live on "All locations". Terminals pick their location on the lock screen.

## Growth

- **Smart wait times** learn from the last 60 days of real seating, by party size and time of day.
- **Loyalty**: every N visits a customer earns a reward with a 6-digit code that staff redeem.
- **Feedback**: after the visit, guests get a rating request on their phone. Happy guests are sent to your review link. Unhappy ones only reach you, and 1–2 stars alert managers.

## Selling more

- **Menu options and add-ons**: required choices (cook temperature) and paid extras, on the register, kitchen tickets and customers' phones.
- **Online ordering** at `/order` for pickup or your own delivery (fee, minimum, area). Pay online with Stripe or pay at pickup. The customer's phone becomes the buzzer.
- **Table QR ordering**: guests order rounds, call their server, and see and split the check from the table.
- **Split checks**: evenly, by item, or "the rest", at the register or with each guest paying by phone.
- **Gift cards**: sell at the register or online at `/gift`, redeem with partial balances.
- **Inventory**: stock goes down with each sale, items turn off at zero, and you get a low-stock alert.
- **Promo codes and offers**: codes with rules, and offers sent by phone alert and email to customers who opted in. Each offer is tracked.

## Running the team

- **Tip pool**: split by hours times points, paid by payroll or cash, with history.
- **Staffing forecast**: people needed per hour for the next 7 days, from your own sales plus free weather data, compared to the schedule.
- **Offline register**: sales made without internet are queued and sent automatically when it returns.

## Getting paid, for less

- One pay page with every method you turn on, cheapest for you listed first: Zelle (no fees), Venmo, cards through Square (including Apple Pay, Google Pay, Cash App Pay and Afterpay), PayPal and Venmo buttons, Cash App and PayPal.me. Stripe is optional.
- Card readers at the counter: Square Terminal or Stripe readers.
- Cash discount at the register, and a report of what each way of paying costs you.

## Pro tools

- Receipts by QR code, print or email, and a kitchen ticket print station.
- Booking deposits that come off the bill at check-in.
- Customer profiles (tags like allergies, notes, birthday, usual order) and automatic birthday, win-back and thank-you offers.
- Insights: a daily summary on the owner's phone, plus alerts for unusual voids, refunds, discounts or a slow kitchen.
- Purchasing: recipes, food cost per item, suppliers and purchase orders. Payroll export with overtime.
- Delivery drivers with live location on the customer's phone. Self-order kiosk. Spanish customer pages.

## Grow and run the business

- **Memberships:** monthly or yearly plans with a member discount and perks. Customers join online, and renewals come with a pay link.
- **Catering quotes and invoices:** customers accept online, then pay a deposit and the balance.
- **Wallet cards:** member and gift cards on the phone, with Google Wallet and Apple Wallet when set up.
- **Allergens and diets** on every item. Customers can filter by allergen, and allergies show on kitchen tickets. Menus are in Spanish too.
- **Accounting export** for QuickBooks Online and Xero.
- **One link page** for Instagram, Facebook, TikTok and Google, with tracking.
- **Team app:** availability, time off, shift swaps, and team performance stats.
- **Two-way messages** with guests on their buzzer.

## Round 7: run the floor and the back office
- **Lobby screen**: a TV shows order numbers being made and ready, plus the waitlist.
- **Add-on suggestions**: "Goes great with" picks from what customers order together, on the register, online and kiosk.
- **Referrals (optional, off until you turn it on)**: customers share a link; both get money off after the friend's first visit.
- **Unhappy guest recovery**: a low rating gets an apology and a single-use come-back code automatically.
- **Checklists and temperature logs**: opening, closing and cleaning lists; fridge and freezer logs with alerts and a printable inspection log.
- **Event tickets**: sell or give seats, QR tickets, check in at the door.
- **Menu sync**: owners send prices and details to other locations.
- **Bank deposits**: record deposits (or import Stripe/Square payouts) and see what matches sales.
- **Menu engineering**: stars, plowhorses, puzzles and dogs, with what to do about each.
- **Prep list**: tomorrow's prep from past sales, and ingredients you're short on.

## Round 8: sell smarter, run tighter
- **Happy hour pricing**: prices change on their own by day and time.
- **Combos**: meal deals with a set price and a choice for each part.
- **Customer display**: a second screen shows the order and lets the customer tap a tip.
- **Recipe cards and training**: step-by-step cards with photos on the kitchen screen; lessons with manager sign-off.
- **Supplier price watch**: alerts when an ingredient costs more, with the dishes that lost profit.
- **Daily specials**: on top of every menu, the lobby screen and the link page, for that day only.
- **Table timers**: long tables are outlined and managers are alerted; slow orders too.
- **Course firing**: hold mains until the server fires them.
- **Sales goals and contests**: a daily target on the register and staff leaderboards.

## Round 9: menus, kitchen and back office
- **Menu schedules**: brunch, lunch and dinner menus switch on their own.
- **Kitchen stations**: a bar screen sees drinks, the kitchen sees food; the order is ready when both are done.
- **Gift card bonuses**: buy $50, get a $10 bonus card, usable in the dates you choose.
- **Punch cards**: sell 10 coffees up front; used one at a time from the customer's account.
- **Scheduled orders**: customers order online for a later day and time.
- **Live labor**: labor against sales on the overview, with who could go home early.
- **Reservation timeline**: bookings by table, drag to move.
- **Waste tracker**: what's thrown out, why and what it cost.
- **Grab-and-go labels**: price, allergens, made-on and use-by dates.

## Round 10: owner tools
- **Order again**: past orders in the customer's account, reordered with one tap.
- **Tip-outs by role**: servers share a percent of sales or tips with bussers, bar and kitchen.
- **Calories**: from recipes or typed in, shown on customer menus.
- **Log book**: shift notes with must-read flags.
- **Equipment**: service schedules, warranties, vendor numbers, problems and repair costs.
- **Auto reorder**: supplier orders drafted when ingredients run low.
- **Member levels**: Silver and Gold by yearly spend, with automatic discounts.
- **Call server**: guests ask for their server, water or the check from the table QR page.
- **Weekly owner report**: every Monday by email and phone.
- **More languages**: French, Chinese and Vietnamese on customer pages.
- **Supplier bills**: what you owe, when it's due, partial payments, aging and CSV.

## Round 11: money in, money out
- **Pay by bank**: big invoices, catering, deposits and tickets paid from the customer's bank (Stripe ACH).
- **Dish photos** on customer menus.
- **Online catering orders** with lead time and deposit.
- **Auto-built schedules** from the forecast and availability.
- **Barcode stock counts** with a phone camera or scanner.
- **Cook timers** on kitchen tickets.
- **Supplier price comparison** with savings and one-tap switch.
- **Supplier bills in the QuickBooks/Xero export.**
- **Review themes**: what guests praise and complain about.
- **Safe log (optional)** with two-person counts.

## Round 21: tables, seats and proof

- **Join tables**: Join on the station moves another table's open checks onto this one; its seats continue the numbering (`tables.joined_to`, `POST /api/staff/tables/:id/join|unjoin`).
- **Seat allergies**: mark an allergy on a seat; that seat's dishes get `ALLERGY …` on the ticket and the order's allergy note, so the allergy check applies (`seat_allergies`, cleared when the table is no longer seated).
- **Split by seat** on the check: each seat pays its own dishes (cash or card); shared dishes stay for the last payer (`GET /api/staff/bills/:id/seats`).
- **Your usual**: the station shows each server's 8 most-rung dishes for one-tap adding (`GET /api/staff/me/top-items`).
- **Leftovers at close** on the Prep list log what's left as over-prep waste, once per dish per day (`prep_leftovers`, `POST /api/kds/leftovers`, shared `h.logWaste`).
- **Pay ahead for a pre-order** (`booking_preorder_pay`): pay kind `preorder`; the paid amount is credited on the held order at check-in.
- **Proof on receipts**: delivery photo and signature show on the receipt page (`/api/r/:token/proof/photo|signature`), and the receipt is emailed after delivery when there's proof and an email.
- **Recent** on area screens lists the last 20 finished tickets (16 hours) to bring one back (`GET /api/kds/done-list`).
- **Auto-VIP** (`auto_vip`, `auto_vip_members`, `auto_vip_spend_cents`): a 15-second sweep marks members' and top guests' open tickets VIP.
- **Course pacing hints**: the Fire button shows how long ago the last course landed against the usual gap (median of the last 30 days, else `pace_default_minutes`) and lights up when it's time.

## Round 20: station speed, kitchen visibility

- **Seat map** on the server station: tap seats on a drawing of the table (round or rectangular, from the floor plan).
- **Move a table**: move open checks, the party and the open bill to another table and/or hand them to another server (`POST /api/staff/tables/:id/transfer`, `GET /api/staff/servers-on`).
- **Rush from expo**: expo and all-areas screens can rush or un-rush a ticket.
- **Kitchen colours**: each area screen cycles Standard, High contrast, and Colour-safe (blue/orange plus written LATE/SOON tags).
- **Prep par levels** (Settings, in the courses/deliveries panel): the prep list asks for the bigger of par and forecast, minus what's counted on hand (`menu_items.prep_par`, `prep_counts`, `POST /api/kds/prep-count`).
- **Delivery signature** for orders at or above `delivery_signature_cents` (`delivery_signatures`, `POST /api/staff/orders/:id/signature`). Mark delivered is refused with `needsSignature` until it's signed.
- **Pre-order reminders**: the day before a booking (from `preorder_reminder_hour`), guests without a pre-order get a push/email nudge (`bookings.preorder_reminded`).
- **Station keyboard shortcuts**: 1–9 seat, 0 share, H hold, F fire, R rush, V VIP, Enter send, Esc clear, C check, ? help.
- Fix: the staff Bookings list failed when a booking had no pre-order (round 19).

## Round 19: the server station

- **Server station (/pad, was "Order pad")** is now a workstation layout: tables and the waitlist on the left, the menu in the middle, the new round on the right. It stacks on narrower screens.
- **Fire the next course** from the station: one button per held course on the selected table (`POST /api/staff/tables/:id/fire-course`, `GET /api/staff/tables/:id/held`).
- **Host from the station**: add a party, buzz them, seat them at the selected table.
- **Rush and VIP tickets**: pick Normal, Rush or VIP before sending. Kitchen screens sort these to the top with a chip (`orders.priority`, `POST /api/staff/orders/:id/priority`, `POST /api/kds/priority`).
- **Big text** button on kitchen screens (saved per screen).
- **Prep batch recipes**: the Prep list shows the ingredient totals for each batch, from the dish's recipe.
- **Delivery photo**: drivers take a drop-off photo in the Deliver window; the customer sees it on their buzzer page (`delivery_photos`, `POST /api/staff/orders/:id/drop-photo`, `GET /api/g/:token/drop-photo`).
- **Order ahead with a booking** (Settings > Bookings): guests pick dishes from their account; it becomes a held order at check-in and fires when seated (`bookings.preorder`, `PUT /api/c/bookings/:id/preorder`). Staff see it on Bookings.
- **Same again** on the table QR page re-adds the last round, per tab member when on a tab (`GET /api/t/:token/last-round`).
- **Gift cards and member perks on a table check** (`POST /api/staff/bills/:id/gift`, `POST /api/staff/bills/:id/member`, `GET /api/staff/customer-find`).
- **Server checkout** on My shifts: sales, cash taken, card and cash tips, tip-outs, cash to hand in. Managers see everyone's (`GET /api/staff/me/checkout`, `GET /api/staff/checkouts`).

## Round 18: table to till
- **Split a tab** with friends.
- **My tables** and **pay at the table** on the order pad.
- **Kitchen screens keep working offline.**
- **Table timeline** on expo and the floor.
- **Prep log** that feeds Use first.
- **Delivery route order** with a Google Maps link.
- **"Running late"** for bookings.
- **Server coaching.**
- **Expo photo check.**

## Round 17: front to back
- **Order pad** for servers, by seat.
- **Auto-fire courses.**
- **Ingredient 86** across every dish that uses it.
- **Prep lists per area.**
- **Runner screen** by table and seat.
- **Late-ticket make-goods.**
- **Shelf numbers on the lobby screen.**
- **Delivery batching.**
- **Bar tabs** from the table QR code.
- **Area staffing alerts.**

## Round 16: every seat, shelf and second
- **Seat numbers** on tickets.
- **Pass timer** for food waiting to go out.
- **Messages between kitchen screens.**
- **Batch timers** with alarms.
- **Online pickup slots** with a per-slot limit.
- **Pickup shelves** shown to customers.
- **"On my way"** with live ETA for curbside.
- **Who made it**: speed and remakes per cook.
- **Rate each dish** in guest feedback.
- **Schedules by area.**

## Round 15: the line runs itself
- **Print at each area**, **recipe cards** and **86** right on the area screens.
- **Remakes** with reasons and their cost.
- **Temperature logs** on area screens.
- **Smart pickup times** from the live kitchen speed.
- **Rush mode**: pushes pickup times back, then pauses online orders, automatically or by hand.
- **Shift pulse** at clock-out.
- **Labor by area.**
- **Tip-out at clock-out.**

## Round 14: a faster, safer kitchen
- **Bump bars and keyboard keys** on area screens.
- **Curbside "I'm here"** with car details on the packing screen.
- **Allergy check** before an order can be completed.
- **Kitchen speed report.**
- **Talking tickets** (optional, per screen).
- **Event menus** for private rooms, sent to the kitchen on time.
- **Break planner.**
- **Declared cash tips** in the payroll files.
- **Opening and closing lists** on each area's screen.
- **Ticket pacing** so every area finishes together.

## Round 13: every area gets a screen
- **Kitchen area screens**: one tablet per area (grill, fryer, bar…), an expo screen that completes orders, and a packing screen for to-go.
- **All-day counts** on every kitchen screen.
- **Menu board TV** with live specials and happy-hour prices.
- **Overtime guard** with manager approval at the time clock.
- **Phone clock-in only at work** (optional).
- **Photo at clock-in** (optional).
- **Shift handoff notes.**
- **Gusto and ADP payroll files.**
- **Use-first stock** with use-by dates.
- **Table turn report.**
- **Private room bookings** with minimum spend and deposits.

## Round 12: the clock and the back office
- **Time clock screen**: a big clock and PIN pad on any tablet for clocking in, out and breaks, with who's on.
- **Who's on** everywhere: dashboard, shifts, top bar, plus each person's own time card.
- **Allergen chart**, printable and online for guests.
- **Seating rotation**: who to seat next.
- **Supplier credits** for short or damaged deliveries.
- **Sales tax report** with CSV.
- **Stock transfers** between locations.
- **Staff certificates** with expiry reminders.
- **Cash flow forecast.**
- **Delivery zones** drawn on a map, each with its own fee and minimum.
- **Catering follow-up** emails with ratings.
- Fixed: windows flickering while open.

## More security

- **Two-step sign-in** (authenticator app codes) for owners and managers, with 8 recovery codes. Secrets are encrypted at rest.
- **Approved devices only**: new tablets need the owner's approval, using a code, before anyone can sign in on them.
- **Manager approval** by PIN for voids, discounts over 10%, refunds and closing the drawer. Every approval is logged with who approved it.
- **Security alerts on the owner's phone**: repeated wrong PINs, new devices, big voids and refunds, drawer variance and recovery code use.
- Sessions, approvals and two-step trust are all bound to one location.

## Stack

Node + Express + Socket.IO + SQLite (better-sqlite3) on the server. React + Vite on the client, with [GSAP](https://github.com/greensock/GSAP) for motion, [Lenis](https://github.com/darkroomengineering/lenis) for smooth scrolling, and components from [React Bits](https://github.com/DavidHDev/react-bits) (Aurora, SplitText, ShinyText, SpotlightCard, ClickSpark, StarBorder; MIT + Commons Clause, see `client/src/bits/LICENSE-react-bits.md`).

## Run locally

```bash
npm install          # installs server + client
npm run build        # builds the client
npm start            # http://localhost:8080
```

Watch the logs for the **setup code**, open the app and create the owner PIN.

For development, run `npm run dev:server` (port 8080) and `npm run dev:client` (Vite on 5173, which proxies the API).

## Deploy on Railway

1. Create a service from this repo. `railway.json` sets the build and start commands and a `/healthz` health check.
2. Add a **volume** mounted at `/data` and set `DATA_DIR=/data`. Without it, data is lost on every deploy.
3. Set `JWT_SECRET` (64 random characters) and, optionally, `SETUP_CODE`.
4. Generate a domain and set `PUBLIC_URL` to it so QR codes point to the right place.
5. Open the deploy logs, copy the setup code and finish setup in the browser.

Optional email alerts: set `SMTP_HOST` (e.g. smtp.gmail.com), `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS` (a Gmail app password) and optionally `SMTP_FROM`. Web Push keys are generated automatically and stored on the volume; you can pin them with `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`.

## Limits worth knowing

- iPhones only deliver web notifications to pages added to the Home Screen (iOS 16.4+), and websites can't vibrate on iOS. Guests who skip that step still get the alarm, flash and on-screen alert while the page is open.
- There's no password reset by email unless SMTP is configured. Staff can see customers under Bookings → Customers.
- Card payments at the counter are recorded, not processed. Run cards on your existing terminal. Online, table and phone payments go through Stripe once you add your Stripe key.
- SQLite on one volume means one server instance. That's plenty for a single location.
