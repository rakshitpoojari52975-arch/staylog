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
    STAYLOG_PG="-h <socket dir> -p <port> -U postgres" node tests/test_ical_sql.js   # skips without a Postgres

The first four survived a machine reset; fifteen earlier suites (receipt, WhatsApp,
loans, PDFs, staff page, theme) did not and should be rebuilt here before those
areas are changed.

## Open items

- Her page shows "Received so far ₹0" — wages may be paid in cash without being
  marked paid in the app. Raise it before it becomes a misunderstanding.
- Pay-sheet loan repayments are dated by each wage's day, not the payday
  (`syncExpenseLoan` uses `exp.date`, as single payouts do). Arrears are
  unaffected, but the CSV's monthly "Loan repayments" section files an
  instalment taken on 2 Nov for October's wages under October. Fix by recording a
  paid-on date on the expense and using it for the repayment row.
