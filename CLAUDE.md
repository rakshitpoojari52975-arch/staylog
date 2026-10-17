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
    STAYLOG_PG="…" node tests/test_checkout_sql.js   # setup.sql + attendance.sql + checkout-wage.sql; her staff_standing
    STAYLOG_PG="-h <socket dir> -p <port> -U postgres" node tests/test_ical_sql.js   # skips without a Postgres; loads setup.sql + ical.sql, checks access and the report

The first four survived a machine reset; fifteen earlier suites (receipt, WhatsApp,
loans, PDFs, staff page, theme) did not and should be rebuilt here before those
areas are changed.

## Open items

- Editing a wage re-prices every unpaid, app-priced attendance day to the new
  rate (re-pricing always uses current rates). Confirm that is wanted; if a
  rise should apply only from a date, rates need an effective-from date.
- `staff_standing()` is defined in `setup.sql`, `attendance.sql` and
  `checkout-wage.sql`; re-running an earlier one drops what a later one added.
  Keep one definition (e.g. a `staff-functions.sql` run last) when next touched.
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
