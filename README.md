# SuitesByHeadPoets — Barbershop Booking + SMS

A booking site for a booth-rental barbershop. Customers book online with a specific
barber; the barber gets a text the moment it's booked. Customers can also create an
account to save a preferred barber and manage their bookings. Front desk can blast a
single text to every barber when a walk-in comes in the door. Everyone gets a text
reminder the day before their appointment with a link to change or cancel it. A
management page lets staff add barbers (photo, bio, availability, services & pricing)
and customers.

## What's included

- **Public site** (`/`) — barber directory with photos/bios, a haircut-styles showcase carousel, live availability, and a booking flow.
- **Customer accounts** (`/account.html`) — sign in with just a phone number (we text a
  one-time code, no password to remember). Customers can set a preferred barber, book
  future appointments without retyping their info, and view/cancel their bookings.
- **Appointment reminders** — every confirmed appointment gets an automatic SMS the day
  before, with a link to change or cancel it — no login required to use that link.
- **Management page** (`/management.html`) — password-protected. Add/edit barbers (including each barber's own services and pricing),
  add customers, view/manage appointments, and send the walk-in alert.
- **SMS via Twilio**:
  - New booking → text to that barber only.
  - Walk-in button → text to every *active* barber at once.
  - Day-before reminder → text to the customer with a manage/cancel link.
  - Customer login → text with a 6-digit sign-in code.
- **SQLite database** — no external database server needed, single file on disk.

## 1. Install prerequisites

You need [Node.js](https://nodejs.org) 18+ installed, and a [Twilio](https://www.twilio.com) account
with a phone number capable of sending SMS (a trial account works for testing).

## 2. Install dependencies

```bash
cd barbershop-app
npm install
```

**Important if you're on Node 18:** `sharp` and `node-cron` are intentionally pinned
below their latest majors (`sharp@0.32.x`, `node-cron@3.x`) because newer releases of
both require Node 20+ and will crash on startup (`sharp`) or silently run unsupported
(`node-cron`) on Node 18. Running `npm install sharp` or `npm install node-cron` on
their own — without the version — pulls latest and overwrites these pins.

That's self-healing now: `scripts/verify-native-deps.js` runs automatically after
every `npm install` (see the `postinstall` script) and re-pins both packages if they
drift, so a stray `npm install sharp` no longer requires manually fixing it afterward.
This whole problem — and that script — goes away once the project moves to Node 20+,
at which point the pins can be dropped and both packages updated normally.

## 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio Console dashboard (twilio.com/console) |
| `TWILIO_PHONE_NUMBER` | A phone number you bought in Twilio, e.g. `+15551234567` |
| `ADMIN_PASSWORD` | Whatever password your front desk/manager should use to log into `/management.html` |
| `SESSION_SECRET` | Any long random string (used to sign login cookies) |
| `SHOP_NAME` | Shown on the site and in the SMS text signatures |
| `BASE_URL` | Your site's public URL, no trailing slash (e.g. `https://suitesbyheadpoets.up.railway.app`). Used to build the change/cancel link sent in reminder texts. Use `http://localhost:3000` while testing locally. |
| `REMINDER_HOUR` | Hour (0–23, server local time) the daily reminder job runs. Defaults to 9 (9am). |

**Important on barber phone numbers:** when you add a barber in the Management page,
enter their number in the form Twilio expects: `+1` followed by the 10-digit number
(e.g. `+14045551234`). Missing the `+1` will cause sends to fail.

**No Twilio account yet?** The app still works — with Twilio unset, SMS sends are
logged to the server console instead of actually sent, so you can test booking end to
end before signing up.

## 4. Run it

```bash
npm start
```

Visit `http://localhost:3000` for the booking site, and
`http://localhost:3000/management.html` to log in and add your barbers.

## 5. First-time setup checklist

1. Go to **Management → Barbers → Add barber** for each of your 10 barbers: name,
   phone number, booth number, specialty, bio, photo, and weekly hours.
2. In the same form, set each barber's **services and pricing** (e.g. "Skin Fade — $35",
   "Beard Trim — $20"). This list is what customers pick from when booking that barber
   — different barbers can charge different prices for the same service.
3. Confirm each barber's availability (days off, start/end times) — this drives which
   time slots customers can book on the public site.
4. Test a booking from `/` yourself and confirm the barber's phone receives the text
   (or check the server console log if Twilio isn't configured yet).
5. Test the **Walk-In Alert** button from Management and confirm all active barbers
   get the text.
6. Set `BASE_URL` in `.env` to your real site URL once deployed — this is what makes
   the "change or cancel" link in reminder texts point somewhere real. It's easy to
   forget after deploying, and reminders will otherwise link to `localhost`.
7. Test the reminder flow: book an appointment for tomorrow, then either wait for the
   scheduled `REMINDER_HOUR`, or as an admin call `POST /api/admin/send-reminders-now`
   (e.g. from your browser's dev console while logged into Management) to fire it
   immediately and confirm the text and its link both work.
8. Test customer login at `/account.html`: request a code, sign in, set a preferred
   barber, and book/cancel an appointment as that customer.

## How the SMS logic works

- **Booking a slot** (`POST /api/appointments` or `POST /api/customer/appointments`)
  looks up the chosen barber's phone number and sends them one SMS with the customer
  name, date/time, service, and booth number. It also blocks double-booking the same
  barber/date/time, and generates a private `manage_token` for that appointment used
  by the reminder link.
- **Walk-in alert** (`POST /api/walkin`, management-only) pulls every barber marked
  *active*, and fires a text to all of them concurrently: `"Walk-in at [shop]! First
  available barber, please head to the front."` plus an optional note the front desk
  can type in (e.g. "wants a fade").
- **Day-before reminders** (`reminders.js`, run daily by a cron job in `server.js`)
  find every confirmed appointment happening tomorrow that hasn't been reminded yet,
  text the customer a reminder with a `/manage.html?token=...` link, and mark it sent
  so it's never texted twice. That link lets the customer view, reschedule, or cancel
  the appointment without logging in — anyone with the link can use it, so treat it
  like a one-time-use password (it's only ever sent to that customer's own phone).
- **Customer login** (`POST /api/customer/request-otp` / `verify-otp`) texts a 6-digit
  code good for 10 minutes, capped at 5 attempts before a new code is required.
- **Walk-in self check-in** (`POST /api/walkin/join`, public) texts every active
  barber that a customer just checked in and invites them to reply **"2"** to claim
  that customer. The first reply wins; everyone else who was offered it gets a
  follow-up text saying it's taken. This needs Twilio's inbound webhook pointed at
  your server — see the next section.
- All of the above use `sms.js`, a small wrapper around the Twilio SDK. If a text
  fails to send to one recipient in a batch, it doesn't block the others — failures
  are logged and returned in the response.

## Setting up inbound SMS (barbers replying "2" to claim a walk-in)

Sending texts and *receiving* replies are configured separately in Twilio. Once
you've deployed somewhere with a public URL:

1. Go to the [Twilio Console](https://console.twilio.com) → **Phone Numbers** →
   **Manage** → **Active Numbers**, and click your number.
2. Under **Messaging Configuration**, find **"A message comes in"**.
3. Set it to **Webhook**, method **HTTP POST**, and point it at:
   `https://<your-domain>/api/sms/inbound`
4. Save.

Now when a barber texts "2" back, Twilio POSTs it to that endpoint, the app matches
their phone number to a barber record, and claims the most recent walk-in they were
offered. Testing locally requires a tunnel (e.g. `ngrok http 3000`) since Twilio needs
a real public URL to reach — it can't call `localhost`.

## Barber accounts (invite-only self-service profiles)

Barbers don't sign themselves up. From **Management → Barbers**, click **Invite** on
a barber's card — this texts them a one-time link (`/barber-signup.html?token=...`,
valid 7 days) to set a password. After that they sign in at `/barber-portal.html`
with their phone number and password.

A barber's session can only ever touch their **own** profile: bio, specialty, email,
photo, weekly hours, services & pricing, haircut gallery, and payment QR code. They
can't see or edit other barbers, appointments, customers, or shop settings — that
stays exclusive to the single shared Management password (`ADMIN_PASSWORD`), which
can still see and edit everyone, including uploading a QR code on a barber's behalf
if they haven't set one up yet.

## A note on timezones

The reminder job figures out "tomorrow" using the server's local clock. If you deploy
somewhere that defaults to UTC (most cloud hosts do) and your shop isn't in UTC,
reminders could fire at the wrong local time or, in edge cases, calculate the wrong
date. Set a `TZ` environment variable on your host to your shop's timezone (e.g.
`TZ=America/New_York`) so `REMINDER_HOUR` and "tomorrow" line up with your actual
shop hours.

## Deploying so barbers get real texts

This needs to run on a server with a public URL and outbound internet access (this
build environment has neither, so it hasn't been able to place live test texts — you
should test on your machine or a host once Twilio is configured). Any Node-friendly
host works well for a shop this size:

- **Render** or **Railway** — connect your GitHub repo, add the `.env` values as
  environment variables in their dashboard, deploy. Both give you a persistent disk
  or you can switch `data/shop.db` to their managed Postgres if you outgrow SQLite.
- **A small VPS** (e.g. DigitalOcean droplet) — `git clone`, `npm install`, run with
  `pm2` or a `systemd` service, put Nginx in front for HTTPS.

Wherever you deploy, copy your `.env` values into that platform's environment
variable settings — never commit `.env` itself.

## Project structure

```
barbershop-app/
├── server.js          # Express app + all API routes
├── db.js              # SQLite schema (barbers, customers, appointments, otp_codes, walkin_log)
├── sms.js             # Twilio wrapper (single + mass send)
├── reminders.js        # Day-before appointment reminder job
├── .env.example        # Copy to .env and fill in
├── data/shop.db        # SQLite file (created automatically on first run)
└── public/
    ├── index.html        # Public booking site
    ├── account.html       # Customer login + self-service booking/management
    ├── manage.html         # No-login cancel/reschedule page (reached via SMS reminder link)
    ├── management.html    # Staff dashboard
    ├── css/style.css
    ├── js/booking.js       # Public site logic
    ├── js/account.js       # Customer account page logic
    ├── js/manage.js        # Token-based manage page logic
    ├── js/management.js    # Staff dashboard logic
    └── uploads/            # Barber profile photos land here
```

## Notes & things you may want to extend

- Auth on the management page is a single shared password stored in `.env`. For a
  shop with more staff, consider per-user logins if you need to track who made
  changes.
- Customer accounts use SMS one-time codes instead of passwords — nothing extra to
  remember, and it reuses the Twilio setup you already have for the rest of the app.
- Login sessions (both staff and customer) are stored in server memory by default. On
  most hosts that means everyone gets logged out if the app restarts or redeploys —
  fine for a shop this size, but if that becomes annoying, swap in a persistent
  session store like `connect-sqlite3` or Redis.
- **Rate limiting** (in-memory, via `express-rate-limit`) guards the endpoints that
  spend money or gate accounts: texted verification codes are capped at 8/hour per IP
  and 5/hour per phone number (plus a 45-second per-number resend cooldown), the
  walk-in check-in at 6/hour per IP, logins/signups at 12 per 15 min per IP, and
  customer bookings at 15/hour. Tune the numbers at the top of `server.js` under
  "rate limiting". Counters reset on restart. Also set a Twilio spending limit and
  disable countries you don't serve in the Twilio console — that caps SMS-pumping
  damage regardless of app code.
- **CORS** is scoped to `BASE_URL` (plus localhost for dev). The site is served from
  the same server, so this doesn't affect normal use — but set `BASE_URL` to your
  real URL in production or cross-origin API calls from your own domain will fail.
- Appointment slots are generated in 30-minute increments from each barber's daily
  start/end time. Change the `30` in `renderSlotsForDate()` (in `booking.js` and
  `account.js`) if you want a different increment.
- Customer phone numbers are treated as the unique key — booking again with the same
  number updates their existing customer record instead of creating a duplicate.
- The reminder link (`manage_token`) doesn't expire and isn't tied to a login — it's a
  private, hard-to-guess link, similar to how many delivery or scheduling texts work.
  If you'd rather it expire after use or after a set time, that's a small addition to
  the token check in `server.js`.
