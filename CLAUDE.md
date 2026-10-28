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

## Sync model (`cloud.js`) — the phone holds everything, the cloud a minimum

- **The full data exists only on the phone and in the encrypted backup**
  (`backup.js`). Never anywhere else in readable form.
- **The cloud holds only allowlisted columns.** `MIRROR` in `cloud.js` names
  every column that may leave the phone, per table; `push()` sends exactly
  those (`pick`), so a field not on the list — a guest's name, a note, a field
  added next year — cannot reach Supabase. `tests/test_minimal_cloud.js` keeps
  its own copy of the list and fails if what goes up is ever wider. Each
  column is there for one reader:

  | table | columns (plus owner_id, deleted_at, timestamps) | needed by |
  |---|---|---|
  | properties | id, name | Laxmi's calendar, notify text |
  | bookings | id, property_id, check_in, check_out, guests, status, balance_due | her calendar, arrivals, new-booking check; `balance_due` (Direct/Booking.com only, else null; `STAYLOG_BALANCE_DUE` = the app's `balanceDue`) for the balance alert |
  | staff | id, name | her page, notify "Laxmi came in today" |
  | expenses (staff payouts only) | id, staff_id, description, date, amount, gross_amount, loan_deduction, paid, wage_kind | her page (`staff_standing`) |
  | loans (staff loans) | id, staff_id, principal, installment_amount, disbursed_on, first_due_date, status | her loan card |
  | loan_repayments (of those) | id, loan_id, amount | her "repaid" total |

  Widening it is a privacy decision for Rakshit, not a code change: update
  this table, `MIRROR`, the test's copy and `purge-private.sql` together.
- Sync is a whole-state push of that mirror: upsert, then tombstone
  (`deleted_at`) any cloud row the mirror lacks. Rows the phone keeps but no
  longer mirrors (expenses that are not staff payouts, non-staff loans) are
  tombstoned too — on purpose, so they do not count toward the brake.
- **There is no pull.** "Replace this phone from the cloud" is gone: the
  cloud no longer holds the data, so it would wipe the phone. A new phone
  signs in and uses Encrypted backup → Restore from backup.
- Sync runs on app open, on focus, on coming back online, and 4s after any
  change. Overlapping pushes are queued, not dropped. Each good sync writes
  `sync_status` (last_sync_at, **app_version**) and schedules a backup.
- **An empty phone tombstones nothing** (`isEmpty`): no plan, no prompt, no
  update — whatever is in the cloud stays.
- **Safety brake.** Before writing anything, `push()` counts what the
  tombstone pass would delete **from rows the phone no longer has**. More than
  5 rows in one sync, or more than 20% of any table, stops the sync and asks
  (`STAYLOG_CONFIRM_TOMBSTONE` in `app.js`), naming each table and count.
  Cancel writes nothing and the cloud panel shows "Sync paused". Background
  syncs do not re-ask about the same deletions; Sync now and Check now always
  ask. Rows left out on purpose never trip it: the first minimal sync instead
  says once, "Removing private details from the cloud" (a toast and a box in
  the cloud panel; `privacyNote`, remembered in `staylog_minimal_explained`).
- **Moving a database to the minimal cloud** (done once, in this order):
  `minimal-cloud.sql` (adds `bookings.balance_due`, `sync_status.app_version`,
  drops NOT NULL from the old `guest_name` and repayment `date`; until it has
  run, v51's sync stops with an instruction naming it), open v51 and let it
  sync and back up, then `purge-private.sql`. The purge refuses unless every
  owner has a backup from the last 24 hours and their last sync came from
  v51+; it drops the removed columns, hard-deletes non-staff expenses and every
  tombstoned row (a parent only when nothing live points at it), clears the
  Airbnb reservation text from imported calendar events, and revokes
  Supabase's default ALL on every table, granting back only what the app uses.
  One DO block: a refusal changes nothing. Safe to run twice. Supabase's own
  automatic backups keep the old data until they age out (see
  `supabase/README.md`). `tests/test_purge_sql.js` checks Laxmi's page is
  byte-for-byte the same before and after.

## Encrypted backup (`backup.js`)

- **It is the only backup. There is no plain export.** The old ⋯ menu rows
  "Back up data" / "Restore from backup" (`downloadBackup`, `restoreBackup`)
  wrote and read the whole data as readable JSON — guest names, phone and ID
  numbers, ID photos — and are gone. Do not bring a readable export back. The
  ⋯ menu has one row, **Encrypted backup** (subtitle: `bkSubtitle()`, the last
  backup time), which opens the same panel as Cloud sync → Encrypted backup
  (`openBackupPanel`); **Save backup file** there is the only file, and it is
  ciphertext.
- **The full data lives on the phone; the cloud's full copy is one it cannot
  read.** Cloud sync → **Encrypted backup**: a passphrase (≥ 12 characters,
  typed twice, not the PIN; the sheet warns it cannot be recovered).
  PBKDF2-SHA256, 600,000 iterations, random 16-byte salt → AES-256-GCM, a
  fresh 12-byte IV for every backup. The derived key is kept on the phone as
  a **non-extractable** CryptoKey in its own IndexedDB database
  (`staylog_keys`), with a small encrypted check value to test a passphrase
  offline. The passphrase is never stored, sent or kept in app state.
- The plaintext is the whole app data as JSON **minus `idProofImage`** (ID
  photos never leave the phone, even encrypted). `public.backups`
  (`supabase/backups.sql`, owner-only RLS, default ALL revoked) holds only
  ciphertext, salt, IV, iterations, app_version, size, created_at: no counts,
  no names.
- Runs after each successful sync (`StayLogCloud.onSynced`, debounced 15 s),
  skipped when nothing changed since a backup made the same day (IST). Keeps
  the latest plus the newest of each day for 30 days (`planPrune`).
- **Test restore** decrypts the latest with the passphrase typed now and
  compares counts per table with the phone ("Backup verified"); changes
  nothing. **Restore from backup** (latest, a dated one, or a saved file):
  wrong passphrase → "Wrong passphrase", nothing changed; otherwise it asks,
  keeps the phone's data aside in IndexedDB (`staylog_before_restore`),
  carries the phone's own ID photos across by booking id, then replaces, and
  keeps that passphrase's key for future backups. **Save backup file** shares
  the same ciphertext as a `.staylog` file. **Change passphrase** checks the
  current one, stores a new key, makes a fresh backup, and re-encrypts every
  stored backup; any it cannot rewrite still open with the old passphrase.
- `notify` alert `backup`: the newest backup older than 3 days (quiet until
  the first backup exists, or if `backups.sql` has not run). Opens
  `#open=backup`.

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
  amount the app set: `autoAmount` (phone and backup only), or, for days
  made before it existed, an amount equal to the daily wage, the only rate
  there was. A different amount, or any loan cut taken on the expense, is a
  hand edit: never changed. Paid: never changed. It prices with the current
  rates, so editing a wage also re-prices unpaid app-priced days.
- `wageKind` ('daily' / 'checkout', mirrored as `wage_kind`) drives the
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
  the mark id, then stamped. At `staff.utensilRate` (on the phone; the cloud has no rates); blank →
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
  An import knows its own booking by id, not by local fields. Once a stay is
  imported, `ical-sync` stops storing its Airbnb description (the reservation
  link and the last 4 digits of the guest's phone); the phone has it.
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
  - `newBookings`: a reservation the **calendar import** finds — Airbnb
    "Reserved" or any Booking.com stay; Airbnb blocks never (as `planIcal()`).
    Server side, no app needed: `ical-sync` collects events whose uid its feed
    had never shown **on a feed that already had a good read** (`last_ok_at`
    set before this read — a first read finds everything and announces
    nothing) and POSTs `{"job":"new-bookings","events":[{feed_id,uid}]}` to
    notify with `PUSH_CRON_SECRET` (function secrets are project-wide; without
    it, nothing is sent and the import is unaffected). Not a webhook on
    `ical_events`: the feed's `last_ok_at` is stamped after its events are
    written, so a webhook could not tell a first read from a later one.
    notify re-reads each event and skips blocks, `gone_at`, check-in before
    today (IST), and dates that already match a live booking (one Rakshit made).
    Key `stay:<property>:<check-in>:<check-out>`, so the other feed's echo of
    the same stay is not announced again; Airbnb rows go first, so a stay in
    both feeds at once is named Airbnb, else the first feed to show it names
    the platform. Title "New Airbnb booking" / "New Booking.com booking", body
    "12 → 14 Nov · 2 nights · <property>" (no guest name: the feed has none).
    Moved dates (same uid) and "No longer on …" are updates, never new.
    Opens `#open=stay&prop=&in=&out=`: the app runs a sync (the import
    drain), then opens the booking with those dates; if it is still not on the
    phone, Bookings scrolled to that check-in with a note saying so.
  - `arrivals`: check-in **tomorrow** (IST), not cancelled. No guest name:
    "Guest arriving tomorrow" / "2 guests · 3 nights · <property>". Opens
    `#open=<id>&send=arrival` (the name is on the phone).
  - `balances`: check-out **tomorrow**, `source` Direct (or blank) or
    Booking.com, not cancelled, `balance_due` > 0 (the phone works it out by
    its own rule and mirrors it; null for other platforms). Only a database
    from before `minimal-cloud.sql` falls back to the old amounts and its own
    `balanceDue`. Body "₹X to collect · <property>", no name. Never on the day itself, never
    Airbnb or other platforms (the same pair as `paysUsDirectly`). Opens
    `#open=<id>&send=payment`.
  - `backup`: no encrypted backup in 3 days (see Encrypted backup).
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

## Face ID unlock

- **A second key to the same local lock, never a replacement.** The PIN
  always works. WebAuthn with the phone's own authenticator
  (`authenticatorAttachment: 'platform'`, `userVerification: 'required'`).
  Unlock = `navigator.credentials.get` for the stored credential returns an
  assertion whose authenticator data has the UV flag (bit 2 of byte 32). No
  server and nothing in Supabase, as with the PIN, so the signature is not
  checked against a public key: the phone's own lock is the trust, as it is
  for the PIN.
- **Only the credential id is kept**, in localStorage `staylog_faceid`: not in
  `state.data`, backups or the cloud.
- **RP ID is the full host `rakshitpoojari52975-arch.github.io`** (github.io is
  a public suffix). On any other host the option is hidden: a credential is
  bound to its RP. A custom domain would need a new setup.
- Menu → **Unlock with Face ID** (shown only if
  `isUserVerifyingPlatformAuthenticatorAvailable()` says yes) asks for the
  current PIN, then calls `create()` straight from that tap. The same row turns
  it off, also behind the PIN. Turning off forgets the id; the passkey itself
  stays in the iPhone's Passwords app until deleted there.
- **Lock screen:** one automatic prompt when it opens (`faceIdAuto`, re-armed by
  Lock app and each start), plus an "Unlock with Face ID" button for when
  Safari refuses a prompt without a tap. Cancel or failure shows "enter your
  PIN" and asks nothing more; the pad works throughout, and a PIN unlock
  aborts a pending prompt. **Forgot / Reset PIN clears the Face ID setup.**
- No WebAuthn (old iOS, a Safari tab where it fails), or the check takes over
  1.5 s at start: no option, and the PIN screen is never held up.

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
  first issue, never reused. Kept on the phone and in the encrypted backup
  (`receipt_no` left the cloud with the minimal cloud).
- The stamp states what is true: PAID, PART PAID (with balance) or UNPAID.
- **Round off (Direct and Booking.com only).** `roundOff` (phone and backup
  only; the cloud gets just the resulting `balance_due`) is signed rupees settled without being paid: + what we let go
  (₹4,632.47 billed, ₹4,630 taken → 2.47), − what the guest paid over
  (₹4,995 billed, ₹5,000 taken → −5.00). `roundOffOf(b)` is 0 for Airbnb and
  every other platform whatever is stored; the form never shows the field for
  them and saving makes it 0. **The limit is one constant,
  `ROUND_OFF_LIMIT = 5`, inclusive.** In the booking form (Total, Payment
  received, Round off, and a live "Balance due ₹X" / "Fully paid") and in
  **Mark paid** (now "Amount received?", prefilled with the balance, added to
  `paid`), a gap total − received of ₹5.00 or less either way fills Round off
  (`autoRoundOff`); above it Round off is left as it is. Typing in Round off
  sets `roundOffHand` and it is never filled again for that booking
  (phone and backup only).
- **The money rule.** `balanceDue(b)` = total − paid − `roundOffOf(b)` is the
  one balance; under ₹1 still counts as paid, a safety net for bookings from
  before round off (paise left over once showed as PART PAID and "₹0.5 due").
  The card, Home's Today lines, `receiptStamp` (PAID = total > 0 and
  `balanceDue` 0), `buildReceiptPDF`, Mark paid, the CSV's Balance Due and the
  notify function all use it; never subtract on your own. **Revenue** (Home,
  Reports, the CSV's Total Revenue) is `bookingRevenue(b)` = total − round off:
  for a settled stay, the money received. The CSV has a Round Off column. The
  receipt prints "Round off -Rs. X" (or "+Rs. X") between the total and
  "Amount received" (a hyphen: jsPDF's fonts have no U+2212). Stored amounts
  are never rounded, and a real balance keeps its paise: `fmtCur`/`fmtCurPdf`
  show two places whenever there are paise (₹250.50). `tests/test_balance.js`
  checks every place and that no other line of `app.js` subtracts paid from
  total; `tests/test_round_off.js` covers round off.
- **The cloud never holds money details.** Totals, payments, round offs,
  receipt numbers, UPI and bank details stay on the phone and in the encrypted
  backup; the cloud gets only `balance_due` for Direct and Booking.com stays.
- **Mark paid, by source.** Direct and Booking.com: **Mark paid**
  (`data-mark-paid`) asks "Amount received?" with the ₹5 round off, then
  offers the receipt. Airbnb and every other platform (not `paysUsDirectly`):
  **Mark payout received** (`data-mark-payout`, `markPayoutReceived`) on any
  booking not cancelled with `balanceDue(b) > 0` — one tap sets
  `paid = totalAmount` and `roundOff = 0`, since the platform pays the full
  amount: no amount sheet, no round off, no receipt, no message. A "Marked
  paid · Undo" toast (`showToast`, outside `#app`, `UNDO_MS` 5 s) restores the
  previous `paid`. **Receipts, the payment request, the checkout-tomorrow
  balance alert and the receipt offer stay Direct and Booking.com only.**
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
  directly, not cancelled, `balanceDue(b) > 0` (total − paid − round off;
  under ₹1 counts as paid; see Receipts), and the property has a UPI ID
  or bank details. The check-out reminder carries them with the exact
  balance; the Send sheet's **Payment request** sends the same any time;
  `sendMessage` refuses a payment request that fails the check. Without
  details set, the reminder keeps its one-line balance sentence.
- The details are **property data** (`upiId`, `upiPayee`, `upiQr`,
  `bankDetails` → `properties.upi_id`, `upi_payee`, `upi_qr`,
  `bank_details`, added by `supabase/payment-details.sql`): on the phone and
  in the encrypted backup only, like the Wi-Fi — never mirrored to the cloud
  (dropped by `purge-private.sql`). **Never in the code: the repo is public.** `tests/test_payment.js`
  scans every file and every commit for UPI IDs on real bank handles, IFSC
  codes and embedded images; only its own fake values are allowed. Run it
  with `STAYLOG_REAL_UPI=<your id>` to also search for the real one by value.
- What a guest owes reaches the cloud only as `bookings.balance_due`
  (Direct and Booking.com; null otherwise), for the checkout-tomorrow alert.
  The alert names no guest: "₹4,000 to collect · Raaya Vasyam".
- Platform bookings are settled with one-tap **Mark payout received** (full
  amount, no round off; see Receipts); that never sends the guest anything,
  and receipts and payment requests remain Direct and Booking.com only.
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
    node tests/test_faceid.js            # Face ID: setup behind the PIN, unlock, cancel → PIN, off, Reset PIN, no WebAuthn
    node tests/test_new_bookings.js      # ical-sync + notify together: new stays announced once, echoes/blocks/first reads never; the tap
    node tests/test_minimal_cloud.js     # the mirror is the allowlist only; no pull; empty phone tombstones nothing; first sync explained once
    STAYLOG_PG="…" node tests/test_purge_sql.js      # minimal-cloud.sql + purge-private.sql: refuses unsafely, drops, revokes; Laxmi's page identical
    node tests/test_backup.js            # encrypted backup: round trip, wrong passphrase, nothing readable sent, key non-extractable, restore, change (+ backups.sql)
    node tests/test_payout.js            # platform bookings: one-tap Mark payout received + Undo; Direct/Booking.com unchanged
    node tests/test_round_off.js         # round off ≤ ₹5: form, Mark paid, receipt, revenue, CSV, sync, notify (+ round-off.sql with STAYLOG_PG)
    node tests/test_balance.js           # under ₹1 is paid: card, Home, stamp, PDF, CSV, requests, notify
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
- "New booking" trusts the feed's uid: if a platform ever re-issues a changed
  reservation under a new uid, its new dates read as a new stay and notify.
  Dates Rakshit closes by hand on Booking.com also arrive as a "stay" and
  notify, unless a booking with exactly those dates is already in the cloud.
- `push_log` grows by a few rows a day and is never pruned. Harmless for
  years; delete rows older than a month in SQL if it ever matters.

- If a Booking.com booking is ever prepaid through Booking.com Payments, record
  it as paid in the app: the app treats every Booking.com stay as
  pay-at-property and would otherwise ask the guest for the balance.
- Payment details travel inside the encrypted backup (and its saved
  `.staylog` file), as the Wi-Fi password does; nothing readable leaves the
  phone. Old plain `staylog-backup-*.json` files made before v52 are
  readable: delete any you still have, and keep them out of the repo.
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
  (`icalMoved`, `icalGone`). They travel in the encrypted backup; a restore
  from an older backup re-derives the flag at the next sync, but "Updated"
  restarts from that backup's figure.
- `setup.sql` still grants Supabase's default `ALL` on a fresh database;
  `purge-private.sql` closes it (revoke all, then only what the app uses —
  tested: no TRUNCATE anywhere, Laxmi's functions and the phone's writes still
  work). A database set up again from scratch needs the purge run again.
- Her page shows "Received so far ₹0" — wages may be paid in cash without being
  marked paid in the app. Raise it before it becomes a misunderstanding.
- Pay-sheet loan repayments are dated by each wage's day, not the payday
  (`syncExpenseLoan` uses `exp.date`, as single payouts do). Arrears are
  unaffected, but the CSV's monthly "Loan repayments" section files an
  instalment taken on 2 Nov for October's wages under October. Fix by recording a
  paid-on date on the expense and using it for the repayment row.
