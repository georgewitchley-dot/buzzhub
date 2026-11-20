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

**Self check-in** (`/join`): print the door code and guests add themselves.

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
- **Audit log**: every unlock, failed PIN, sale, void, buzz and settings change, with the person and IP address.

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

Optional text alerts: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`.

## Limits worth knowing

- iPhones don't let websites vibrate. On iOS the buzz is sound, a screen flash and the on-screen alert. The guest has to tap "Turn on sound and alerts" once, and keep the page open (the app keeps the screen awake).
- Card payments are recorded, not processed. Run cards on your existing terminal. A Stripe Terminal integration would be the next step.
- SQLite on one volume means one server instance. That's plenty for a single location.
