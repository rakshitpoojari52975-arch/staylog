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

These four survived a machine reset; fifteen earlier suites (receipt, WhatsApp,
loans, PDFs, staff page, theme) did not and should be rebuilt here before those
areas are changed.

## Open items

- Her page shows "Received so far ₹0" — wages may be paid in cash without being
  marked paid in the app. Raise it before it becomes a misunderstanding.
- The ₹40,000 loan shows 0% repaid; the settle sheet could offer to deduct the
  monthly ₹2,000 instalment.
- A sync safety brake: refuse to tombstone an unusual number of rows without
  asking.
- `app.js` could check the expected `sw.js` version and warn on a mismatch.
- Booking.com/Airbnb iCal import (needs a Supabase Edge Function; the feeds
  have no CORS headers).
