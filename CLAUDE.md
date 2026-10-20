# StayLog — notes for Claude

StayLog is the management app for **Raaya Vasyam**, a homestay in Kaup, Udupi.
Owner: Rakshit. It is a vanilla-JS PWA (no build step) deployed by GitHub Pages
from `main`, backed by Supabase. The house help (Lakshmi Walikar) uses
`staff.html`, a separate read-mostly page.

Every rule below was learned from a real failure. Read them before changing
anything.

## Deploying

- GitHub Pages serves `main`. Work on a branch and open a PR; Rakshit merges.
- **Every release bumps three things together:** `APP_VERSION` and `APP_BUILT`
  in `app.js`, and `CACHE_NAME` in `sw.js`. Also `PAGE_VERSION` in `staff.js`
  when that file changes. `APP_BUILT` once sat at "28 Sept" for a dozen
  releases and was read, reasonably, as proof uploads were not landing.
- **Editing `cloud-config.js` is a release too.** The VAPID key was once
  committed on its own: `sw.js` was unchanged, so no new worker, no reload,
  and the resumed Home Screen app kept the blank key it had loaded. Since v44
  the worker fetches the app's files with `cache: 'no-cache'` (so a GitHub
  Pages copy up to 10 minutes old is never served), and when the key is blank
  the menu re-reads the deployed `cloud-config.js` (`refreshConfigKey()`).
  Still bump the versions.
- The ⋯ menu footer shows the app version and the running service worker's
  cache name. If they disagree with what was shipped, an upload did not land.
- `app.js` expects the worker `'staylog-'+APP_VERSION` (`SW_CACHE`), so
  `APP_VERSION` and `CACHE_NAME` must carry the same number. 4s after opening
  (and on returning to the app) it asks the running worker; if it is another
  release's, or too old to answer, a quiet dismissible strip under the header
  says the app is part-updated and to reopen it. No worker at all shows
  nothing. The check never repaints the PIN screen.
- SQL lives in `supabase/` and is run by hand in the Supabase SQL editor.
  Every script must be safe to run twice (`if not exists`, `create or replace`).

## The service worker — never cache live data

`sw.js` caches by **allowlist only**: the app's own files (network-first) and a
named set of static hosts — fonts and the icon font (cache-first). Everything
else, Supabase included, passes through untouched, and any request carrying an
`Authorization` header is never touched.

A previous version cached every cross-origin GET as a "third-party asset". It
swept up the Supabase API, so attendance syncs were served a stored answer and
new marks never appeared — for a week, through many wrong fixes, because each
deploy cleared the cache and made the bug look fixed for one sync.
`tests/test_sw_routes.js` fails if live data is ever cached again. Both clients
also fetch from Supabase with `cache: 'no-store'` as a second layer.

## Sync model (`cloud.js`)

- **The phone is the master copy.** Sync is a whole-state push: upsert
  everything, then tombstone (`deleted_at`) any server row the phone lacks.
  Deletes are soft, so they are recoverable in SQL.
- `pull()` ("Replace this phone from the cloud") is for bringing up a new
  device, not for merging. Two devices editing at once are not supported.
- Sync runs on app open, on focus, on coming back online, and 4s after any
  change. Overlapping pushes are queued, not dropped.
- **Safety brake.** Before writing anything, `push()` counts what the
  tombstone pass would delete. More than 5 rows in one sync, or more than 20%
  of any table, stops the sync and asks (`STAYLOG_CONFIRM_TOMBSTONE` in
  `app.js`), naming each table and count. Cancel writes nothing and the cloud
  panel shows "Sync paused". Background syncs do not re-ask about the same
  deletions; Sync now and Check now always ask. An empty new phone that signs
  in before "Replace this phone from the cloud" hits this brake instead of
  wiping the cloud.

## Attendance → wage expenses

- The house help taps "I came in today" on `staff.html`. That writes
  `public.attendance` through `staff_mark_today()`.
- `attendance` is **deliberately absent from `ORDER` and `MAP`** in `cloud.js`.
  If it were synced like other tables, the tombstone pass would delete her
  marks. It is drained one way: mark → unpaid staff expense → mark stamped.
- Ids are deterministic: `att_<staffId>_<yyyymmdd>` becomes expense
  `wag_<staffId>_<yyyymmdd>`. A re-run rewrites; it never duplicates.
- "Already done" means **the expense exists on the phone**, not that the phone
  once noted the mark. A mark ticked off in the cloud whose expense is gone was
  deleted on purpose and stays deleted (counted as `removed`).
- No daily wage set → the mark is held and reported, never given an invented
  amount. Undo is allowed for 15 minutes after marking, enforced in SQL.
- **The rate depends on the day** (`wageFor()` in `app.js`, used by the drain
  through `STAYLOG_WAGE_FOR`). A marked day pays `dailyWage`, or
  `checkoutWage` if any booking that is not cancelled has its check-out that
  date — any property, a flat rate however many leave, turnover days
  included. A blank or non-positive checkout wage means the daily wage. The
  description ends " · checkout day" on those days. Daily wage blank → an
  ordinary day is held, a checkout day is still paid its own rate.
- **Re-pricing** (`repriceWages()`): runs inside `mutateData` (every change,
  so a late iCal import or an extended stay is caught), once at every start,
  and after a restore. It touches only unpaid attendance wages
  (`wag_` id — `fromAttendance` does not survive a restore) still at the
  amount the app set: `autoAmount` (synced as `auto_amount`), or, for days
  made before it existed, an amount equal to the daily wage, the only rate
  there was. A different amount, or any loan cut taken on the expense, is a
  hand edit: never changed. Paid: never changed. It prices with the current
  rates, so editing a wage also re-prices unpaid app-priced days.
- `wageKind` ('daily' / 'checkout', synced as `wage_kind`) drives the
  "Checkout day" label on her page, via a `checkout` key per pending day in
  `staff_standing()`.
- `supabase/checkout-wage.sql` adds `staff.checkout_wage`,
  `expenses.wage_kind`, `expenses.auto_amount` and that key. Run it **after**
  `attendance.sql` (which also defines `staff_standing`). Until it has run,
  `push()` sees Supabase refuse the columns, retries without them
  (`LATER_COLUMNS` in `cloud.js`) and the cloud panel names the script.
- **Utensil cleaning** (`supabase/utensils.sql`, `drainUtensils()` in
  `cloud.js`) sits beside attendance and changes nothing about it. Laxmi taps
  "I cleaned the utensils today" (under "I came in today", with "Only if a
  guest didn't pay you for it.") only when Rakshit pays her for it — guests
  sometimes pay her directly, as the house notes say. Rules, all in SQL:
  once a day (id `ute_<staffId>_<yyyymmdd>`, one row), only once she is
  marked present that day, the same 15-minute undo, and undoing attendance
  undoes that day's mark (a trigger on `attendance`; the attendance functions
  are untouched). A mark already turned into an expense is not undone.
- `utensil_marks` is **absent from `ORDER` and `MAP`** too; drained one way into
  an unpaid staff expense "Utensil cleaning — <name> · <date>" whose id is
  the mark id, then stamped. At `staff.utensilRate` (`utensil_rate`); blank →
  held and reported in the cloud panel, never an invented amount. It is a
  line of its own: a checkout day with utensils pays both, both show on the
  Pay sheet, and `repriceWages()` never touches it (only `wag_` ids).
- Her breakdown labels every line ("Wage", "Wage · Checkout day", "Utensil
  cleaning") from a `kind` per pending day in `staff_standing()`, which also
  carries today's `utensils` state. Its latest definition is now in
  `utensils.sql`: run order is setup → attendance → checkout-wage → utensils.
- **The house notes are guest-facing and stay as written**: "If you’d prefer,
  our househelp can do this for you at a nominal charge of Rs. 100, payable
  directly to her." `tests/test_utensils.js` checks it word for word and that
  the whole `HOUSE_NOTES` block is byte-for-byte as on `main`.

## Calendar import (Booking.com / Airbnb)

- The feeds have no CORS headers, so the Edge Function
  `supabase/functions/ical-sync/index.ts` reads them (cron every 30 min, or the
  app's Import now) into `public.ical_events`. Setup steps are in the README
  beside it. One file, no imports, so it pastes into the dashboard and the
  tests run it in Node.
- `ical_events` and `ical_feeds` are **absent from `ORDER` and `MAP`**, like
  attendance, and for the same reason. Drained one way in `drainIcal()`:
  event → booking `ics_<hash>` → event stamped `imported_booking_id`.
  Stamped and the booking is gone → deleted on purpose, stays deleted.
  An import knows its own booking by id, not by local fields (those do not
  survive "Replace this phone from the cloud").
- The two calendars are connected, so each feed echoes the other's stays.
  `planIcal()` takes Airbnb "Reserved" first, then Booking.com, then Airbnb
  blocks; an event whose property and exact dates match a live booking is
  linked to it, never doubled. Airbnb blocks never create bookings. Stays
  already over are not imported. No amount is ever invented.
- An event leaving its feed sets `gone_at`; the booking is flagged "No longer on
  …, cancelled?", never cancelled or deleted. A feed that suddenly comes back
  empty flags nothing (looks like their glitch, not a wave of cancellations).
- The owner may only `select` events and update `imported_booking_id`. The
  script revokes Supabase's default `ALL` (which includes `TRUNCATE`) first.
- Double bookings: `bookingClashes()` — same property, overlapping nights,
  check-out day free, not cancelled, not yet over. Shown on both cards and on
  Home. Computed once per render.
- **The links are secrets** (the token is in the URL). They live only in
  `ical_feeds` in Supabase — never in the app's data, its backups, browser
  storage, or this public repo (the test URLs are made up; checked across all
  history and `staylog-history.bundle`). The function strips any URL out of an
  error before storing or returning it: Deno's fetch quotes the URL.
- **Cloud sync → Calendar sync** reports each feed: fetched when, events found,
  error (from `ical_feeds`, written by the function), and Added / Updated /
  Removed (from `planIcal().feeds`, worked out from events + bookings, so any
  sync gives the same figures). "Removed" = no longer in the feed, booking
  flagged. The log is kept in localStorage (`staylog_ical_log`) with a
  per-feed "last change", for the attendance reason: the sync that adds a
  booking triggers another a few seconds later that finds nothing.
- `supabase/ical-report.sql` lists every booking a feed accounts for, with
  source, dates and which feeds list it — for comparing against the platforms.
- **Airbnb blocks stay out of StayLog** — Rakshit's decision after a block he
  set did not appear: most are Booking.com stays seen from Airbnb's side. Do
  not "fix" this.
- **Still open on the other platform** (`coverageGaps()`, run each sync): a
  live, future stay with a night that a platform's feed does not cover is a
  night that platform can still sell. Shown on the card ("Still open on
  Booking.com: …"), counted on Home and per feed. Never checked against its
  own platform; skipped for a feed whose last read failed. A feed is only
  judged once it has **shown a stay that began elsewhere** (an event linked to
  a booking from another source): whether each export carries the other's
  imported dates is undocumented, and guessing means an alarm on every stay
  or none. Until then Calendar sync says the check is waiting.
- A stay a platform moves keeps its old dates (`icalMovedFrom`); the card says
  so for 7 days.

## Notifications (iPhone push)

- **Reminders only.** Nothing in the app may depend on one arriving: whatever
  a notification points at is already on Home and on the booking.
- The Edge Function `supabase/functions/notify/index.ts` sends them. It is
  one file with no imports, does Web Push by hand (RFC 8291 aes128gcm, RFC 8292
  VAPID, via WebCrypto), and the tests run it in Node, decrypting each push with
  the device's keys and verifying the signature. Setup is in the README
  beside it: `push.sql`, four secrets, deploy with Verify JWT off, cron
  `30 3 * * *` (9:00 AM IST) with `{"job":"daily"}`, and webhooks on
  `attendance` and `utensil_marks`. Cron and webhooks prove themselves with the
  `x-cron-secret` header. The app's **Send test** uses the owner's own JWT and
  can do nothing else.
- What fires (each alert has a toggle in the ⋯ menu, all on by default; a
  missing pref means on):
  - `attendance` / `utensils`: a **fresh** mark only — an INSERT, or an UPDATE
    that brings back a mark that was undone. The app stamping it and her undo
    are not news. Once per mark id (`push_log`), so marking again after an
    undo is not announced twice.
  - `arrivals`: check-in **tomorrow** (IST), not cancelled. Opens
    `#open=<id>&send=arrival`.
  - `balances`: check-out **tomorrow**, `source` Direct (or blank) or
    Booking.com, not cancelled, balance > 0. Never on the day itself, never
    Airbnb or other platforms (the same pair as `paysUsDirectly`). Opens
    `#open=<id>&send=payment`.
  - `stale`: `sync_status.last_sync_at` older than 2 days (written by
    `push()` after every good sync; no row means no warning). Opens
    `#open=cloud`.
  Each reminder is claimed in `push_log` before sending, so a cron that fires
  twice notifies once; it is un-claimed if no device took it.
- **The VAPID private key is a Supabase secret, never in the repo.** Only the
  public key goes in `cloud-config.js` (`vapidPublicKey`; blank = the menu says
  not set up). `tools/vapid-keys.html` makes a pair in the browser and sends
  nothing. `tests/test_push_keys.js` scans every file, every commit and the
  history bundle, and tries every 43-character token against the public key.
- `push.sql`: `push_subscriptions`, `notification_prefs`, `sync_status`
  (owner full access) and `push_log` (owner reads; only the function writes).
  All revoke Supabase's default `ALL` first.
- **iOS rules.** Push exists only in the Home Screen app (iOS 16.4+), never in
  a Safari tab: the menu explains Add to Home Screen there. The permission
  prompt comes only from the **Turn on notifications** tap, and
  `requestPermission` is the first thing that tap does. iOS drops
  subscriptions, so every open (and every return after a minute) quietly
  re-subscribes if permission is granted and re-saves the row; it never
  prompts. A subscription made under a different public key is replaced.
- **Every push shows a notification** (`sw.js` `push` handler), even an
  unreadable one: iOS revokes a subscription after silent pushes. A tap opens
  the URL it carries, which must be the app's own origin: focused and told by
  `postMessage({type:'open'})` if open, `openWindow` if not. The app takes
  `#open=…` from the address or that message, waits behind the PIN, clears
  the hash, and opens the Send sheet with that message highlighted
  (`state.sendFocus`). The handlers touch no cache; the allowlist is unchanged.

## Privacy and access — do not loosen these

- The house help reads **only** through `SECURITY DEFINER` functions with fixed
  column lists (`staff_calendar`, `staff_standing`, `staff_mark_today`,
  `staff_unmark_today`). Row-level security filters rows, not columns; never
  grant her a base table.
- **Guest ID photographs (`idProofImage`) never leave the device.** They are not
  in the schema and not in any mapper.
- **The signature is data, not code.** It lives in `properties.signature`. The
  repo is public — never commit an image of it.
- `cloud-config.js` holds the Supabase URL and the *publishable* key, which are
  public by design. Never commit a `service_role` or `sb_secret_` key.

## Loans

- **Payday loan deduction.** The Pay sheet offers (off by default) to take the
  month's instalment out of the wages being settled. It is split across the
  ticked days, oldest first; each day carries its share as `loanId` /
  `loanDeduction` / `grossAmount`, exactly like a single payout, so
  `syncExpenseLoan` makes one repayment row per day and deleting a day reverses
  only its share. A day already carrying a cut keeps it and is not cut again.

## Receipts

- A **receipt, never a tax invoice**: no GSTIN, no tax lines, and it says so.
- Offered for **Direct and Booking.com** only — the guest pays Rakshit directly
  on both. Booking.com stays show "Booked via Booking.com"; the money line still
  reads "Amount received". Other platforms collect payment themselves, so they
  get no receipt.
- Numbering `RV/<FY>/<nnn>`, Indian financial year (April–March), assigned on
  first issue, never reused; unique per owner in SQL.
- The stamp states what is true: PAID, PART PAID (with balance) or UNPAID.
- After a booking is marked paid in full — the card's **Mark paid**, or typing
  the full amount into the booking — a "Paid in full" sheet offers **Send
  receipt**. A sheet of its own, so the share starts from a fresh tap.

## Payment details and asking for the balance

- **Booking.com guests pay at the property, like direct guests.** The guest
  messages were first written assuming Booking.com collects payment, with a
  rule (`isDirect = source==='Direct'`) that Booking.com guests were never
  told they owe money. That was wrong here and is gone: `paysUsDirectly(b)`
  (Direct or Booking.com, the same pair as receipts) is the one rule for
  anything about money in a guest message. Airbnb and every other platform
  collect payment themselves: their guests are never told a balance and never
  sent payment details.
- Payment details go out only through `canAskForPayment(b)`: pays us
  directly, not cancelled, `balanceDue(b) > 0`, and the property has a UPI ID
  or bank details. The check-out reminder carries them with the exact
  balance; the Send sheet's **Payment request** sends the same any time;
  `sendMessage` refuses a payment request that fails the check. Without
  details set, the reminder keeps its one-line balance sentence.
- The details are **property data** (`upiId`, `upiPayee`, `upiQr`,
  `bankDetails` → `properties.upi_id`, `upi_payee`, `upi_qr`,
  `bank_details`, added by `supabase/payment-details.sql`), synced like the
  Wi-Fi. **Never in the code: the repo is public.** `tests/test_payment.js`
  scans every file and every commit for UPI IDs on real bank handles, IFSC
  codes and embedded images; only its own fake values are allowed. Run it
  with `STAYLOG_REAL_UPI=<your id>` to also search for the real one by value.
- The UPI ID goes alone on its own line, unformatted, so a long-press copies
  just the ID. The QR (a PNG data: URL, like the signature) is shared through
  the share sheet like the PDFs (`sharePaymentQR`, same guard); the message
  says a QR follows only when one is set.

## Gotchas

- `today()` is local (IST). Never `toISOString().slice(0,10)` — that is UTC and
  is a day behind between midnight and 05:30. In SQL use
  `(now() at time zone 'Asia/Kolkata')::date`.
- The `h()`/`div()` helpers coerce numeric styles to px except the names in
  `UNITLESS_CSS`. `lineHeight: 1.5` without that list became `1.5px`.
- jsPDF's built-in fonts have no ₹ glyph. PDFs print "Rs.".
- `wa.me` links cannot carry a file. PDFs go through `navigator.share`.
- `getTextWidth` ignores `charSpace`; widen boxes around letter-spaced text.

## Tests

    npm i -D playwright
    node tests/test_sw_routes.js
    node tests/test_sw_live.js
    node tests/test_sw_upgrade.js
    node tests/test_att_gap.js
    node tests/test_pay_loan.js
    node tests/test_sync_brake.js
    node tests/test_sw_mismatch.js
    node tests/test_ical_function.js   # Node 22.18+ (strips the .ts types)
    node tests/test_ical_import.js
    node tests/test_checkout_wage.js
    node tests/test_utensils.js
    node tests/test_payment.js        # STAYLOG_REAL_UPI=… also searches the repo for your real UPI ID
    node tests/test_notify_function.js   # Node 22.18+; every alert's condition, decrypts each push, checks VAPID
    node tests/test_push_app.js          # menu, subscribe/unsubscribe, quiet re-subscribe, deep links, sw.js handlers
    node tests/test_push_keys.js         # STAYLOG_REAL_VAPID_PRIVATE=… also searches for your real private key
    STAYLOG_PG="…" node tests/test_push_sql.js       # push.sql: twice; owner-only; no TRUNCATE
    STAYLOG_PG="…" node tests/test_payment_sql.js    # payment-details.sql: constraints, owner-only
    STAYLOG_PG="…" node tests/test_utensils_sql.js   # all four scripts in order; the once-a-day, present-first and undo rules
    STAYLOG_PG="…" node tests/test_checkout_sql.js   # setup.sql + attendance.sql + checkout-wage.sql; her staff_standing
    STAYLOG_PG="-h <socket dir> -p <port> -U postgres" node tests/test_ical_sql.js   # skips without a Postgres; loads setup.sql + ical.sql, checks access and the report

The first four survived a machine reset; fifteen earlier suites (receipt, WhatsApp,
loans, PDFs, staff page, theme) did not and should be rebuilt here before those
areas are changed.

## Open items

- **Push notifications have not met a real iPhone or the real project yet.**
  After setup, Send test from the Home Screen app; if it never arrives,
  read the function's logs. Apple's endpoint is the only one targeted;
  the encryption is standard and was checked against its RFCs, not a device.
- Notifications go to every device the owner has turned them on for; there
  is no per-device choice of alerts. Fine for one iPhone.
- The 9 AM run uses the bookings in the cloud, so a booking made offline and
  not yet synced gets no reminder (the stale-sync warning covers a long gap).
- The attendance webhook shows Laxmi's mark even before the phone turns it
  into a wage; that is the point, but it means a mark she undoes within the
  15 minutes was still announced.
- `push_log` grows by a few rows a day and is never pruned. Harmless for
  years; delete rows older than a month in SQL if it ever matters.

- If a Booking.com booking is ever prepaid through Booking.com Payments, record
  it as paid in the app: the app treats every Booking.com stay as
  pay-at-property and would otherwise ask the guest for the balance.
- Payment details travel in the app's own backup file (Back up data), as the
  Wi-Fi password does. That file is yours; keep it out of the repo.
- The confirmation message still says "(payable at check-in)"; Booking.com and
  direct guests here may pay any time during the stay. Reword if it confuses.

- Editing a wage re-prices every unpaid, app-priced attendance day to the new
  rate (re-pricing always uses current rates). Confirm that is wanted; if a
  rise should apply only from a date, rates need an effective-from date.
- `staff_standing()` is now defined in four files (`setup.sql`,
  `attendance.sql`, `checkout-wage.sql`, `utensils.sql`); re-running an earlier
  one drops what a later one added — most recently the utensil state her page
  needs. Consolidate into one `staff-functions.sql` run last.
- Utensil cleaning has no owner-side "mark it for her": if she forgets, add the
  expense by hand. And a mark already converted is not undone with her
  attendance (the owner deletes the expense, as with a converted day).
- The utensil rate is one figure per staff member. The house notes quote
  Rs. 100 to guests; if Rakshit's rate differs, that is his choice, but the
  two are not linked and changing one does not change the other.
- The checkout-day rate looks at every property's bookings. Fine with one
  house help across Raaya Vasyam; revisit if staff ever belong to one property.

- Whether Booking.com's export includes the Airbnb dates it imports (and the
  reverse) decides whether the still-open check ever switches on for that
  feed. Calendar sync shows "Still-open check: waiting" until it does; if it
  never does, that platform's export does not echo the other, and closing
  dates there by hand is the only protection.
- **The calendar import has not met a real feed or the real project yet.**
  After setup, run `supabase/ical-report.sql` and compare against the Airbnb
  calendar and the Booking.com extranet for the first few days. If a platform's
  real feed differs from the documented shape, fix `parseIcs()` and add that
  feed to `tests/test_ical_function.js`.
- Booking.com cannot tell a guest from dates closed by hand, so a closure
  arrives as a "Booking.com guest" booking to delete (it stays deleted). If that
  becomes a chore: a "not a stay" button that stamps the event without a booking.
- The "Updated" figure and the "No longer on…" flag rest on phone-only fields
  (`icalMoved`, `icalGone`). After "Replace this phone from the cloud" the flag
  is re-derived at the next sync but "Updated" restarts from 0.
- `setup.sql` never revokes Supabase's default `ALL` on its tables, so
  `anon`/`authenticated` hold `TRUNCATE` (which ignores RLS) on bookings,
  expenses and the rest — confirmed on Postgres with Supabase's defaults. The
  REST API cannot issue TRUNCATE, so it needs database credentials to use, but
  it should be tightened the way `ical.sql` does: revoke all, grant what RLS
  expects. Check `staff_access` and the staff functions still work after.
- Her page shows "Received so far ₹0" — wages may be paid in cash without being
  marked paid in the app. Raise it before it becomes a misunderstanding.
- Pay-sheet loan repayments are dated by each wage's day, not the payday
  (`syncExpenseLoan` uses `exp.date`, as single payouts do). Arrears are
  unaffected, but the CSV's monthly "Loan repayments" section files an
  instalment taken on 2 Nov for October's wages under October. Fix by recording a
  paid-on date on the expense and using it for the repayment row.
