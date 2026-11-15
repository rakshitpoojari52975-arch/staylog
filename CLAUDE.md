# StayLog — notes for Claude

StayLog is the management app for **Raaya Vasyam**, a homestay in Kaup, Udupi.
Owner: Rakshit. It is a vanilla-JS PWA (no build step) deployed by GitHub Pages
from `main`, backed by Supabase. The house help (Lakshmi Walikar) uses
`staff.html`, a separate read-mostly page.

Every rule below was learned from a real failure. Read them before changing
anything.

## The revamp in progress (Nov 2026) — read first

Rakshit approved a multi-account redesign (his spec, "You are revamping
StayLog", Nov 2026; it wins over this file on design): accounts with owners,
managers (per-property access and permissions) and several staff; **guest data
moves into Supabase, readable, protected by login and RLS** (his decision —
it reverses the minimal cloud below). Supabase becomes the source of truth;
each device keeps a local copy and syncs per row (pull + merge + outbox), no
more whole-state push with tombstones. The sections below describe the app as
it is **today** and stay true until each phase replaces them.

Agreed decisions (his answers, 15 Nov 2026):
- The new tables live in a new schema **`stay`**, beside the old `public`
  ones, exposed to the API; primary keys `(account_id, id)`; every existing
  id kept; unknown fields go to a `legacy jsonb` column, never dropped.
- **Guest ID photos are not uploaded** and not in new backups: they stay
  viewable from the phone's old local copy until the clean-up (phase 10).
- **Order changed from the spec:** the new sync engine (and server-side
  wages/utensils) comes **before** the migration cutover, so the app has
  something to sync with the moment it switches.
- **Revenue is per property. Expenses are per property or "Shared"**
  (property_id null). Wage expenses that already exist keep the property they
  have (so the migration matches the Inventory screenshot); new ones follow
  the new rule.
- Phases, one PR each: 0 safety net (v60) · 1 `stay` schema + RLS + functions
  + `check.sql` · 2 sync engine (dormant until switch-over) · 3 migration +
  report + cutover + rollback (**gate**: he checks) · 4 properties as data ·
  5 staff · 6 team · 7 calendar import on the server · 8 notifications ·
  9 onboarding · 10 clean-up (after 90 days, his written OK).
- Cutover: old `public` tables become read-only; `public.app_status.min_version`
  is raised so any older copy stops syncing and says "StayLog has been updated
  — close and reopen"; her `staff_*` functions are redefined over `stay`
  (same names and output; old ones kept as `*_v58` for the rollback).
- Every release from v60 bumps `APP_VERSION`/`APP_BUILT`, `CACHE_NAME`
  (`staylog-v<N>`), and `PAGE_VERSION` when `staff.js` changes.

### Phase 0 — v60 (safety net)
- **⋯ → Inventory** (`inventoryOf(data)`, pure; `renderInventoryModal`):
  counts per table (cancelled included, ID photos counted), per month
  revenue / expenses / net / paid / due / round off (bookings by check-in
  month, cancelled left out, the money rule's functions), per loan principal /
  repaid / outstanding, per staff unpaid wages, highest receipt per series.
  He screenshots it; the migration report must match it. Phase 3 reuses
  `inventoryOf` for the phone's side.
- **`supabase/security-v60.sql`** (after `utensils.sql`): a RESTRICTIVE policy
  "owners only" (`public.is_owner()`) on every owner table — ANDed with the
  existing owner policies, so re-running older scripts cannot undo it; staff
  logins and strangers read and write nothing; her page is unaffected (SECURITY
  DEFINER functions); `staff_access` also lets her read her own row. It refuses
  if `public.owners` is empty (would lock him out) or if `staff_standing` lacks
  the owner match. Mark ids must equal `attendance_id(staff,date)` /
  `utensil_mark_id(...)` (NOT VALID + validate; misfits listed, kept).
  `attendance` loses the default ALL. `sync_status` gains `device_id`,
  `device_name`. `public.app_status(min_version)` readable by anyone.
  **Public sign-up must be off** (dashboard). Composite foreign keys (review
  1.3) wait for the `stay` schema: with sign-up off and owners-only, no second
  owner can exist.
- `staff_standing()` (`utensils.sql`) and `staff_calendar()` match every row by
  owner (review 1.2).
- **Arrival instructions are property data** (`arrivalInstructions`, phone and
  backup only, not mirrored): the key location and house-finding text left the
  code. Blank → the arrival message leaves it out and the Send sheet says so.
  The old text is still in the public git history before v60 (not rewritten);
  `tests/test_one_phone.js` fails if any later commit adds it back.
- `notify` re-reads a webhook's mark by id and takes owner, staff and date from
  the row; staff looked up with `owner_id` (review 1.6).
- **One login per phone's data** (`staylog_owner`, set by the first sync):
  another login is refused while the phone holds data (an empty phone is
  free); a kept session for another login is dropped at start. Sign-out
  forgets the backup key, the logs, the inbox cache and this phone's push
  subscription; the data and its owner stay (review 1.7).
- **One phone per account** (`staylog_device`, a UUID, written to
  `sync_status.device_id` each good sync): a phone whose id is not the one on
  record pauses before writing anything ("Sync paused on this phone"), until
  **This is now my only phone** (confirm) takes over (review 1.8). A record
  without a device id is claimed by the first phone to sync.
- **Retired detector**: each push and each start read
  `public.app_status.min_version`; an app below it writes nothing and shows
  "StayLog has been updated — close and reopen" (a strip, not an error).
- New ids are `crypto.randomUUID()` (`uid()`, `StayLogCloud.newId`).

### Phase 1 — the `stay` schema (SQL only; the app does not use it yet)
- `supabase/stay/01-schema.sql` → `02-functions.sql` → `03-access.sql` →
  `check.sql` (all rows "ok"); exposed to the API in the dashboard (Data API →
  Exposed schemas). `rollback-phase1.sql` drops the schema again, refusing
  once any account exists in it. Nothing reads or changes `public`.
- Tables: `accounts` (code, time_zone, currency, `pays_directly_sources`),
  `platform_admins` (seeded from `public.owners`), `members` (owner/manager,
  `permissions` jsonb), `member_properties`, `staff_logins` (replaces
  `staff_access`, keeps `display_name`), `invites`, `properties` (every
  property setting as a column, `receipt_prefix` unique per account),
  `bookings`, `staff`, `staff_properties`, `loans`, `expenses`
  (`property_id` null = Shared, `paid_on`, `source_mark_id`),
  `loan_repayments`, `attendance`, `utensil_marks` (id = staff + date, a
  check), `receipt_series`, `ical_feeds`, `ical_events` (+ `announced_at`),
  `push_subscriptions`, `notification_prefs`, `push_log` (per recipient),
  `sync_status` (per device), `backups` (per device). Business rows: PK
  `(account_id, id)`, composite FKs, `version`, `updated_by`, `deleted_at`,
  `legacy jsonb`; `stay.touch()` bumps `version` on every change.
- Access (`03-access.sql`): `stay.holds(acct, property)` and
  `stay.can(acct, perm)` (defaults: edit_bookings, send_messages, mark_paid,
  add_expenses on; see_money, manage_staff, edit_properties off;
  manage_calendar never). Owners see all; managers their properties' bookings
  (guest details included) and only what `can` allows; Shared expenses need
  see_money; staff lines, staff, loans and marks need manage_staff; calendar
  links owner-only. Staff logins read no base table. No TRUNCATE; DELETE
  only on `member_properties`, `staff_properties`, `push_subscriptions`,
  `backups`. Bookings can't be soft-deleted (trigger). An account keeps one
  owner (trigger). `stay.create_account` for platform admins.
- `stay.apply_change(table, row, base_version)`: security invoker (RLS
  decides); new rows refused if the id exists; edits land only `where version
  = base`; returns ok / conflict (with the server row) / missing.
- Money in SQL: `pays_directly` (blank source = Direct), `round_off_of`,
  `balance_due` (under ₹1 = 0), `revenue` — the app's rules.
- Receipts: `stay.issue_receipt(acct, booking)` — once per booking, only for
  sources that pay directly, needs mark_paid; counter per prefix and Indian
  financial year (`financial_year`), seeded from the highest number already
  used (`seed_receipt_series`), row-locked so devices issuing at once get
  different numbers; a unique index refuses duplicates anyway.
- **Her marks become lines on the server, at once** (`on_mark` trigger →
  `process_mark`): `wag_<staff>_<yyyymmdd>` / the utensil mark id; an existing
  line is only stamped; a line deleted on purpose stays deleted; no rate →
  held (released by `process_pending` when a rate or her properties change);
  the checkout rate counts checkouts at her properties (all when none
  assigned); charged to the mark's property, else her one property, else
  Shared. `reprice_wages` runs when bookings or rates change (unpaid,
  app-priced, no loan cut; paid and hand edits never). **Undo changed:**
  because the line exists at once, her 15-minute undo (`undo_mark`) also
  soft-deletes the line while it is untouched (unpaid, no loan cut, still the
  app's amount), flagged `legacy.undone`, so marking again revives the same
  line. Undoing attendance undoes that day's utensils. `stay.importing`
  (`set_config('stay.importing','on', true)`) turns these triggers off for a
  migration.
- Her page over `stay`: `stay.staff_calendar / staff_standing /
  staff_mark_today / staff_unmark_today / staff_mark_utensils_today /
  staff_unmark_utensils_today` — the public ones' output, in the account's
  time zone, her assigned properties only (all when none). Not wired: the
  cutover (phase 3) points the public functions at them.

### Phase 2 — v61 (the sync engine, dormant)
- **`sync.js`** (after `cloud.js` in `index.html`, in the worker's list).
  Active only when localStorage `staylog_model` = `{mode:'stay', user,
  account}`, which only the switch-over (phase 3) sets. Until then nothing in
  it runs and `cloud.js` syncs as before. Once active, `cloud.js`'s `push`,
  `markDirty` and `checkIn` stand down (`newModel()`).
- **Mappers** (`SPEC`): phone camelCase ⇄ `stay` columns. Unknown fields →
  `legacy`; a value a column can't hold as it is (a number typed as text, a
  bad date) is kept in `legacy.$orig` and comes back until another device
  changes that column. `idProofImage` never leaves the phone and is carried
  across every merge. Loan repayments are their own rows (`loan_id`), nested
  under their loan on the phone. A notNull column left empty is not sent.
- **Outbox is worked out, not kept**: each row is compared with its `base`
  (the server copy last seen, `{v, row}`) field by field; only changed fields
  go up, through `stay.apply_change(..., base_version)`.
- **Merge** (`merge()`): fields only one side changed are both kept; a field
  both changed differently is a conflict — the server's value stands, mine is
  kept (`conflicts`) for **Use mine** (`reapply`) or **Keep the saved one**
  (`dismiss`). `money` flags paid/total/round off/receipt/source/status,
  amounts, wages. A row deleted here but changed elsewhere comes back
  (`why:'deleted'`).
- **Pull** per table by `updated_at > cursor − 2 min`, merged by version.
  **No deleting by absence**: a row is soft-deleted only because this device
  removed it; more than 5 at once wait (`held`) until Sync now asks
  (`STAYLOG_CONFIRM_TOMBSTONE`). Bookings are never deleted.
- A sync works on a copy and hands back only the rows it touched
  (`handBack`); a row typed during the sync keeps the typed value and its old
  base, so the next sync merges it properly.
- Local state in IndexedDB `staylog_stay` per `user:account`; the app's own
  copy under `staylog_stay_data:<user>:<account>` in `staylog_db`. The old
  keys (`staylog_main`, `staylog_v2`) are never written in the new model.
  `mutateData` does not re-price wages there (the server does).
- `stay.sync_status` heartbeat per device: last pull / push, outbox,
  conflicts, oldest unsent.
- Calendar import over `stay.ical_events` with the same `planIcal`; events
  are stamped once their booking is on the server.
- **Receipts in the new model come from `stay.issue_receipt`**
  (`stayReceiptNo`, before the PDF is built); `ensureReceiptNo` never invents
  one there. Needs the internet the first time.
- **Sync panel** (`renderStaySyncModal`, in place of the old cloud panel once
  active): last received / sent, waiting changes, held deletions, conflicts in
  plain words ("Changed on another device — your edit … wasn't saved"),
  account switcher (when a login has more than one), sign out.
- **PIN hash** (active now): `staylog_auth` = `{v:2, salt, iter:150000,
  hash}` (PBKDF2-SHA256). An old `{pin}` opens once and is converted
  (`checkPin`). The Face ID sheet checks the PIN as it is typed so Face ID is
  still asked for from the tap.
- `syncExpenseLoan` keeps a repayment's id when rebuilding it.
- `supabase/stay/04-phase2.sql`: `stay.loans.staff_id` nullable (the house's
  own loans); "changed since" indexes. `check.sql` checks it.
- Not yet in the new model (phase 3, with the cutover): the Edge Functions,
  push subscriptions, inbox and encrypted backups over `stay`.

### Phase 3 — v62 (moving in, the switch, the rollback)
- **`supabase/stay/05-migrate.sql`** (after 04; run again after any re-run of
  02, which resets function grants). `public.app_status` gains `model`
  ('public' | 'stay'), `account_id`, `switched_at`; `stay.accounts` gains
  `migrated_from` (the old owner_id), `migrated_at`. Functions (only the old
  owner, only into the account moved from them): `migration_account`,
  `migrate_rows` (the phone's rows as `sync.js` maps them; a re-run replaces —
  the phone wins until the switch; triggers off; a parent gone long ago →
  deleted placeholder `legacy.placeholder`; a repayment whose expense is gone
  → `legacy.orphan_expense_id`), `migrate_prune` (rows a re-run no longer
  carries → soft-deleted; never bookings, placeholders or server-made lines),
  `migrate_copy` → `migrate_server_side` (her login from `staff_access`, her
  marks with their stamps — misfit ids left behind and counted, calendar
  links + events, push devices, prefs, inbox with read state, encrypted
  backups), and **`stay.cutover`**: needs a copy within the hour; copies her
  marks again and runs `process_pending` (lines for marks the phone had not
  made); saves the old tables' write grants (`stay.cutover_grants`, table and
  column) and revokes insert/update/delete on them; renames her six functions
  to `*_v58` (not callable) and recreates the names as wrappers over
  `stay.staff_*`; sets model 'stay', `min_version` 62. One transaction.
  `stay.ical_feeds` gains DELETE for owners (clearing a link, as before).
- **`stay/rollback-cutover.sql`** (SQL editor): her functions back from
  `*_v58`, the saved grants back, her marks since the switch copied into
  `public.attendance` / `utensil_marks`, model 'public' (min_version stays 62).
  Nothing in `stay` deleted. Safe twice.
- **The app follows `app_status.model`** (`StayLogCloud.refreshModel`,
  `status().model`; `followModel()` at start and on every cloud change):
  `stay` and not active → joins (memberships → account → `snapshot` with its
  own ID photos → activate); `public` and active → goes back (deactivate,
  writes the new copy into the old keys, the old sync sends it). `cloud.js`
  `push` writes nothing once the model is 'stay'.
- **⋯ → Move to the new system** (`renderMoveModal`; only while signed in,
  not active, model 'public'): **Copy and compare** = old push first (her
  marks become wages), `migration_account` (named from the first property),
  `upload` (200 rows a call, then prune), `migrate_copy`, `snapshot`, then
  `moveReport`: `inventoryOf` phone vs server per section (Records, Money all
  time, by month, Loans, Unpaid wages, Receipts; her marks excluded — they
  are the cloud's now) and row by row (`compareRows`: missing / extra /
  differing fields). **Switch over** only when everything matches: confirms,
  copies and compares afresh, `cutover`, activates with the server's copy
  (ID photos kept), starts `sync.js`. Never writes the old copy.
- In the new model `cloud.js` reads and writes `stay` for calendar links
  (`listFeeds`, `saveFeed` — update-or-insert per property and platform,
  `setFeedConnected`, `importNow` then `StayLogSync.sync`), push devices,
  prefs and the inbox (by account and user / recipient); `backup.js` uses
  `stay.backups` (insert + delete only: Change passphrase inserts the
  re-encrypted copy with the old date, then deletes the old row). Backups are
  scheduled after each good new-model sync (`StayLogSync.onSynced`).
- **Edge Functions read `app_status.model` on every request** (notify and
  ical-sync; PostgREST `Accept-Profile`/`Content-Profile: stay`). notify in
  'stay': tenants are accounts with an active owner; each reminder goes to
  every active owner (members) with their own devices, prefs and inbox row
  (`push_log` by account + recipient); balance from the amounts and the
  account's `pays_directly_sources`; stale = newest `last_pull_at` of any
  device; a webhook pointer must carry `account_id`. ical-sync in 'stay':
  feeds and events by account; Import now reads only accounts the login
  owns. Same code both ways, so the rollback is one switch.
- After the switch, re-point the two notify webhooks to `stay.attendance` and
  `stay.utensil_marks` (back again on rollback). Do not re-run the old
  `public` scripts that define her functions (`setup.sql`, `attendance.sql`,
  `checkout-wage.sql`, `utensils.sql`) after the switch: they would replace
  the wrappers.

### Phase 4 — v63 (properties as data)
- **Raaya Vasyam's texts left the code** (spec §11): the six house rules
  (confirmation PDF), the house notes (house notes PDF, with the utensil
  sentence), the welcome lines of "Welcome & house info" (ending "Enjoy
  Udupi"), and the 1:00 PM / 11:00 AM times. They are property fields now:
  `houseRules` (array; each "Title\nDescription"), `houseNotes` (paragraphs
  separated by a blank line, title on the first line), `welcomeText`,
  `checkinTime` / `checkoutTime` ("HH:MM", shown "1:00 PM") — the `stay`
  columns `house_rules`, `house_notes`, `welcome_text`, `checkin_time`,
  `checkout_time`. **`supabase/stay/06-property-texts.sql`** carried his
  texts into the moved-in account's properties word for word (only empty
  fields; twice = same). `tests/fixtures/rv-texts.json` holds the texts and
  the four messages as the last release made them; `test_property_data.js`
  checks every message is identical (only "payable at check-in" →
  "payable before check-out", spec §11) and that app.js no longer has them.
- Helpers: `checkinTime(prop)`, `checkoutTime(prop)` (default 13:00 / 11:00),
  `houseRulesOf` (neutral `DEFAULT_RULES` when none), `houseNotesOf` (none →
  the PDF has only the welcome and sign-off), `welcomeOf` (`DEFAULT_WELCOME`),
  `textBlocks`, `HomeName(prop)` ("Our homestay" — no "Raaya Vasyam"
  fallback in the code).
- Property form: **The stay** (check-in / check-out times, **Rented as a whole
  unit**, **Receipt series** — up to 6 letters/digits, unique across the
  account's properties, default the initials as `stay.receipt_prefix_of`)
  and **Guest texts** (rules, notes, welcome; one paragraph each, saved as
  typed, untouched fields kept exactly).
- **Occupancy** (`occupancyOf`) in room-nights: a whole-unit property's
  booked night fills all its rooms.
- **The property picker remembers** its choice (localStorage `staylog_prop`;
  a property no longer there → All). Opening a notification switches to its
  booking's property.
- **Shared expenses** (no property): "Shared — all properties" in the
  expense form (the default for a new expense under All properties with more
  than one property); the Expenses list for one property shows its own plus
  Shared, labelled, with a "Shared only" filter; Home and Reports for one
  property leave Shared out and say so; Reports for All include it, with a
  "Shared costs" line under Property Performance; the CSV says "Shared".
- **House notes PDF** asks which property under All properties.

### Phase 5 — v64 (staff)
- **`supabase/stay/07-staff.sql`** (after 06): `stay.staff.works_at text[]`
  ("Works at"; empty = every property), filled once from `staff_properties`;
  a trigger keeps `staff_properties` equal to it (a property not the
  account's is refused by the FK, the whole change with it), so her calendar,
  the checkout-day rate and where a wage is charged follow the app.
  `stay.my_properties()` (hers, or every live one when none),
  **`stay.staff_profile()`** (her name, business = `accounts.name`, owner =
  `accounts.owner_name` else an owner member's display name, her properties
  with check-in / check-out times — no guests, no money) and
  **`stay.staff_mark_today_at(property)`** (only one of hers; the line is
  charged there). Public wrappers `public.staff_profile()`,
  `public.staff_mark_today_at(text)` for her page. `check.sql` checks it.
- **Edge Function `staff-login`** (Verify JWT off; uses the caller's token):
  `create` / `reset` / `disable` / `enable`, for an owner or a manager with
  manage_staff of that account only. A login is an Auth user
  `<username>.<code>@staff.staylog.invalid` (username 2–24 of a-z 0-9 - _,
  unique per account; password ≥ 8, never stored or returned) plus a
  `stay.staff_logins` row; if the row cannot be saved the user is deleted
  again. Disable = Auth ban + `active` false. Works on logins made before
  v64 (Laxmi's old address). `tests/test_staff_login_function.js`.
- **App:** staff form **Works at** (more than one property); the staff list
  follows the property picker; in the new model each staff member shows
  "Login: <username> · account code <code>" with Reset password / Switch
  off–on, or **Create login** (`renderStaffLoginModal`; through
  `StayLogSync.staffLogin`); the owner's name the staff page uses is set
  there (`accounts.owner_name`); **Home names marks the server holds for a
  missing rate** (`StayLogSync.status().heldMarks`, read each sync).
  Pay sheet sets `paidOn` = payday, and `syncExpenseLoan` dates the
  repayment by it (the old open item). A Shared expense saves (the form
  had still required a property).
- **Staff page (`staff.js` v12):** sign-in with **account code** (remembered,
  `staylog_staff_code`), username and password → the new address; no code,
  or no match, → the old `@staff.raayavasyam.invalid` one, so Laxmi's login
  works either way. Wrong password and no internet say different things.
  Every name from `staff_profile` (business, hers, the owner's; "Your
  workplace" / "the owner" when unknown): no business, owner or staff name
  is written in `staff.js` or `staff.html` (`test_staff_page.js` checks).
  More than one property: "Where are you working today?" (remembered,
  `staylog_staff_prop`) and `staff_mark_today_at`. Times from her
  properties. Offline copy per login (`staylog_staff_cache:<user id>`; the old
  shared `rv_staff_cache` is removed). Without 07 (no profile) it still works.

### Phase 6 — v65 (the team)
- **`supabase/stay/08-team.sql`** (after 07): `stay.invites.label` (who it
  is for); the owner's invite policies — read, **insert only `role =
  'manager'`** (new owners join by platform invite, phase 9), withdraw by
  `expires_at`; **`stay.my_access(acct)`** (role, every permission as
  `stay.can()` decides it, the properties a manager holds — null for an
  owner); **`stay.team(acct)`** (owner only: members with their Auth email,
  role, permissions, properties, `me`; invites still open). `check.sql`
  checks it.
- **Edge Function `team-invite`** (Verify JWT off): `peek` (no sign-in:
  business, property names, label — nothing private) and `accept` (name,
  email, password → makes the login with `email_confirm`, or a signed-in
  token → that login). Only a live, unused manager invite; claimed
  atomically (`PATCH … used_by=is.null&expires_at=gt.now`); member row with
  the invite's permissions (upsert, so a switched-off manager comes back) and
  `member_properties` for its live properties. Already on the team → 409,
  nothing used. A failure half-way deletes the login it made and frees the
  invite. An email that already has a login: "sign in first, then open the
  link". Public sign-up stays off.
- **App:** `myAccess()` = `StayLogSync.status().me` (read each sync, kept
  offline); `isOwner()`, `can(perm)` — the old model and "not known yet" are
  the owner. **Hidden by role:** tabs (`tabAllowed`: Expenses needs
  add_expenses or see_money, Loans manage_staff, Reports see_money; a hidden
  tab is never left showing), Home money (hero, Avg tariff) without
  see_money, the loans card without manage_staff, booking Add/Edit/Cancel/
  Check in–out without edit_bookings, Send without send_messages, Mark
  paid/payout and Receipt without mark_paid, property editing without
  edit_properties, Add property / Team / Encrypted backup / Inventory /
  calendar boxes for owners only. Row-level security is the real limit.
- **⋯ → Team** (`renderTeamModal`, owner, new model): members with emails;
  a manager's properties (`setMemberProperties`) and permissions
  (`setMember`, the whole set kept) change from their card; Switch off/on
  (`active`; the account keeps one owner). Invites waiting (Share link,
  Withdraw). **Invite a manager**: who it is for, properties (at least one),
  permissions (`PERMS`, the defaults ticked) → `StayLogSync.invite` (an
  18-byte random code) → the link `<app>#join=<code>`, shared with
  `navigator.share` or copied.
- **Joining** (`#join=<code>`, `joinCode` kept in sessionStorage until the
  app is unlocked → `renderJoinModal`): peek, then name / email / password
  (or "join as <email>" when signed in) → accept → sign in → `followModel`
  moves the phone onto the account (or `switchAccount` when it already has
  one). A new manager's phone first makes its own PIN, as any phone.
- Not yet (phase 8): notifications to managers; inbox per property.

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
  directly to her." Since v63 they are property data (Phase 4);
  `tests/test_utensils.js` checks the sentence word for word in
  `tests/fixtures/rv-texts.json` and in `06-property-texts.sql`.

## Calendar import (Booking.com / Airbnb)

- The feeds have no CORS headers, so the Edge Function
  `supabase/functions/ical-sync/index.ts` reads them (cron every 30 min, or the
  app's Import now) into `public.ical_events`. Setup steps are in the README
  beside it. One file, no imports, so it pastes into the dashboard and the
  tests run it in Node.
- `ical_events` and `ical_feeds` are **absent from `ORDER` and `MAP`**, like
  attendance, and for the same reason. Drained one way in `drainIcal()`:
  event → booking `ics_<hash>` → event stamped `imported_booking_id`.
  Stamped and the booking is gone → deleted on purpose before v55, stays deleted.
  An import knows its own booking by id, not by local fields. Once a stay is
  imported, `ical-sync` stops storing its Airbnb description (the reservation
  link and the last 4 digits of the guest's phone); the phone has it.
- The two calendars are connected, so each feed echoes the other's stays.
  `planIcal()` takes Airbnb "Reserved" first, then Booking.com, then Airbnb
  blocks; an event whose property and exact dates match a live booking is
  linked to it, never doubled. Airbnb blocks never create bookings. Stays
  already over are not imported. No amount is ever invented.
- **Bookings are cancelled, never deleted** (v55). The card has no Delete and
  nothing in the app removes a booking from the data. **Cancel**
  (`cancelBooking`, `data-cancel-booking`) is offered for confirmed and
  checked-in stays: it asks "Cancel this booking? It stays on record as
  cancelled.", then a "Cancelled · Undo" toast (`UNDO_MS`, 5 s) restores the
  previous status. A checked-out stay shows Cancel disabled and greyed with
  "Checked out — can’t be cancelled"; tapping it does nothing. Edit → Status
  can still restore a cancelled booking (the overlap check applies).
- **A cancelled import stays cancelled.** At every later `drainIcal()` its
  events are left alone: no new dates (`icalMoved`), no "No longer on…" flag,
  no rename. `sameStay` in `planIcal()` matches a live booking first, then a
  cancelled `ics_` import on those dates — by the booking's dates or by the
  dates its linked events now show — so the other feed's echo, an event
  whose stamp was lost, or a stay the platform moved after the cancel links
  to the cancelled booking and is never re-created. A hand-entered booking
  cancelled on those dates does not block a new stay. Bookings deleted before
  v55 still stay deleted (stamp → no booking → `removed`).
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
- **Airbnb's export omits the dates it copies from Booking.com** (confirmed
  on the real feed, Nov 2026: the Booking.com stays were absent from the
  Airbnb feed in `ical_events`). The calendars are connected, so Airbnb does
  block them, but the check cannot see that, and the "proven" heuristic had
  turned it on anyway: every Booking.com stay showed "Still open on Airbnb".
  Two answers (v57):
  - **"<platform> is connected to <other>'s calendar"**, per feed, in Cloud
    sync → Calendar sync (`data-feed-connected`, stored in
    `ical_feeds.connected` by `supabase/ical-connected.sql`; `setFeedConnected`
    in `cloud.js`). On, `coverageGaps()` skips bookings whose source is the
    other platform for that feed; Direct stays are still checked. The note
    under it for Airbnb: "Airbnb’s calendar link doesn’t include dates it
    copies from Booking.com, so those stays can’t be checked there." Toggling
    runs a sync so the gaps are worked out again. Until the script has run,
    feeds read as not connected (`selectFeeds` retries without the column)
    and the switch is disabled, naming the script.
  - **"Closed on <platform>"** on a "Still open on …" warning
    (`data-gap-closed`, `dismissGap`): stored on the booking as `gapClosed:
    {<platform>: '<checkIn>|<checkOut>'}` — phone and encrypted backup only,
    not in `MIRROR` — so new dates bring the warning back. `openGapsFor`
    leaves dismissed gaps out, so Home and Calendar sync do not count them.
- `ical-connected.sql` also narrows the owner's UPDATE on `ical_feeds` to
  columns: `owner_id, property_id, platform, url` (what the app's link upsert
  sets; RLS still pins `owner_id`) and `connected` — never the function's
  `last_*` fetch record. `ical.sql` and `purge-private.sql` keep those
  column grants on a re-run once the column exists.
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
  twice notifies once. **The claim and the record are separate**: the row is
  kept whether or not a device took it (`delivered` false = none did; never
  deleted). A key is claimed when it is new, or when it is undelivered and
  unheld (`claimed_at` null, or over 10 minutes old from a run that died), by
  a conditional PATCH Postgres re-checks, so an undelivered reminder is retried
  the next time it comes up and still goes once. After sending: `delivered`,
  `claimed_at` null. With no device at all the daily run (owners from
  `push_subscriptions` ∪ `sync_status`) still records it, undelivered. Before
  `inbox.sql` has run, notify falls back to the old key-only claim (deleted
  when undelivered). The test push has no key and is never logged.
- **The inbox** (`supabase/inbox.sql`, after `push.sql`): `push_log` gains
  `title`, `body`, `url`, `alert`, `delivered` (default true: old rows were),
  `read_at`, `claimed_at`. The function writes everything; the owner may read
  his rows and update **`read_at` only** (a column grant; `push.sql` and
  `purge-private.sql` re-grant it when the column exists). Home's header has a
  bell (`data-bell`) with the unread count; it opens **Notifications**
  (`renderInboxModal`): the last 30 days (`StayLogCloud.inboxList`, rows with a
  title), newest first, grouped Today / Yesterday / Earlier, each row time,
  title, body. A tap marks it read (`inboxRead`) and opens the push's own link
  through `takeOpen`. **Mark all read** reads every unread row in the cloud.
  Each push's url ends `&n=<key>`; `parseOpen` reads it and
  `applyPendingOpen` marks that row read, so tapping the phone's notification
  reads it too. Undelivered rows say "Not delivered — turn notifications on
  again?", linking to the ⋯ menu's notifications. **Done is worked out on the
  phone from current data, never stored** (`inboxDone`): arrival → Done when
  the arrival message is no longer due (`dueMessages`); balance → Done when
  `balanceDue(b) === 0` (or the booking is gone or cancelled); attendance and
  utensils (`mark:`) → Recorded once the expense exists (`att_` → `wag_`,
  `ute_` same id); stale / backup → Cleared once a sync / backup is newer than
  the alert; a new stay → Imported once the booking is on the phone. The
  **Still to do** filter shows rows with a state that is not done. The last
  list is kept in localStorage `staylog_inbox` (with reads not yet sent),
  shown offline with "As of <time>"; refreshed at start and on return (≥ 1
  min apart) and when the screen opens.
- **App icon badge.** notify puts `badge` (unread rows of the last 30 days,
  this one included) in each keyed push; the `sw.js` push handler calls
  `navigator.setAppBadge(n)` (`clearAppBadge` at 0) beside `showNotification`
  and touches no cache. The app sets it from the inbox at every open and
  every change, and clears it when everything is read.
- **Housekeeping:** the daily run deletes `push_log` rows older than 60 days.
- **The VAPID private key is a Supabase secret, never in the repo.** Only the
  public key goes in `cloud-config.js` (`vapidPublicKey`; blank = the menu says
  not set up). `tools/vapid-keys.html` makes a pair in the browser and sends
  nothing. `tests/test_push_keys.js` scans every file, every commit and the
  history bundle, and tries every 43-character token against the public key.
- `push.sql`: `push_subscriptions`, `notification_prefs`, `sync_status`
  (owner full access) and `push_log` (owner reads; only the function writes,
  but for `read_at` once `inbox.sql` has run).
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

- **The floating tab bar** (v55, `renderNav`, styles `.tabbar` in
  `index.html`): a rounded pill of Home, Bookings, Expenses, Loans, Reports,
  12px in from the sides, `--safe-bottom + 10px` above the screen's edge
  (`--safe-bottom: env(safe-area-inset-bottom, 0px)`). **Clear glass** (v58;
  v56 was frosted and read as opaque): the page is plainly readable through
  it — a 12% tint (`--nav-glass`, 14% in dark) under
  `blur(var(--nav-blur)) saturate(var(--nav-saturate))` (3px, 140%; tune
  those two tokens only), `-webkit-` prefixed. A hairline border
  (`--nav-line`, 35% white light / 18% dark) keeps the edge visible, with a
  light inner rim (`--nav-rim`) and a soft shadow (`--nav-shadow`); all theme
  tokens in light and both dark blocks. Solid `--white` only under
  `@supports not` (no backdrop-filter) and `prefers-reduced-transparency`.
  Labels (700) and icons are `--nav-ink` with a thin halo,
  `0 0 2px var(--cream), 0 0 4px var(--cream)` (the page's own background,
  light or dark). The active tab (`aria-current`) is a 22% capsule
  (`--nav-active`) with `--nav-active-ink` (the accent, deepened in light mode:
  at 22% the plain accent read 3.8:1 over busy content).
  `tests/test_glass.js` measures label contrast from real pixels (≥ 4.5:1
  over a plain and a busy card). Beside it a round **⋯** (`data-navmore`) of the same height
  opens the menu sheet, whose first row is **Notifications**; a red dot
  (`data-unread-dot`) shows while the inbox has unread rows. The header keeps
  the title, property picker and bell; the ⋯ left it. Scrolling down past
  24px adds `.compact` (60 → 54px, labels hidden, icons kept; every target
  stays ≥ 44px), up or the top removes it — toggled in place, no re-render
  (`navCompact`, `onNavScroll`). `prefers-reduced-motion` drops the animation.
  `--nav-top` (how far up the bar reaches) pads the page (`data-main`) and
  places the toast, so nothing sits behind the bar. `tests/test_tabbar.js`.
- **The status bar covers the top 47px or so.** Both pages use
  `viewport-fit=cover` with `black-translucent`, so the Home Screen app draws
  under it. Anything that reaches the top of the screen adds
  `var(--safe-top, 0px)` (`--safe-top: env(safe-area-inset-top, 0px)` on
  `:root` in `index.html` and `staff.html`; one name, so
  `tests/test_safe_area.js` can set 47px where Chromium has no notch). That
  covers: the sticky header (top padding `--safe-top + 9px`, its own background
  fills the strip in light and dark), the PIN / Face ID screen, sheets
  (`maxHeight` never past the status bar), the month picker, and on
  `staff.html` the sign-in screen and her page, plus a fixed `body::before`
  strip in the page colour for when she scrolls. The bottom is the tab bar's
  (`--safe-bottom`, above).

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
    node tests/test_ical_connected.js    # "connected" per feed: no gap for the other platform's stays, Direct still checked, survives a sync; "Closed on …" hides a gap until the dates change
    node tests/test_inventory.js         # v60 Inventory: counts, money by month to the paisa, loans, wages, receipts; changes nothing
    node tests/test_one_phone.js         # v60: one login per phone's data, one phone per account (pause + take over), retired detector, sign-out clears, UUIDs, arrival instructions as data
    node tests/test_sync.js              # phase 2 engine: two devices, field merges, conflicts (money flagged), offline, no delete by absence + brake, receipts, calendar; STAYLOG_PG adds a real apply_change round trip
    node tests/test_sync_app.js          # phase 2 in the app: hashed PIN (old plain one converted), dormant, own storage key, cloud.js stands down, Sync panel, server receipts, stable repayment id
    node tests/test_property_data.js     # phase 4: texts out of the code (messages word for word), neutral defaults, form, receipt series, whole-unit occupancy, remembered property, Shared expenses, house notes picker (+ 06 SQL with STAYLOG_PG)
    node tests/test_staff_page.js        # phase 5 staff page: code sign-in + old login, wrong password vs no internet, names from data, property pick, per-login cache
    node tests/test_staff_app.js         # phase 5 app: Works at + filter, staff logins (create/reset/switch off), owner name, held marks on Home, payday-dated loan cut, Shared expense saves
    node tests/test_staff_login_function.js   # the staff-login Edge Function: who may, the address, nothing half-made, reset/disable on old logins
    STAYLOG_PG="…" node tests/test_staff_sql.js      # 07-staff.sql: works_at ↔ staff_properties, her profile, marking at a property
    node tests/test_team_app.js          # phase 6: Team (members, permissions, properties, switch off, invites, withdraw), a manager's hidden areas, joining from a link
    node tests/test_team_invite_function.js   # the team-invite Edge Function: peek, accept (new login / signed in), once only, expired, owner invites refused, nothing half-made
    STAYLOG_PG="…" node tests/test_team_sql.js       # 08-team.sql: manager-only invites, my_access, team(), what a manager reads
    node tests/test_move_app.js          # phase 3 in the app: Move to the new system — copy, compare (match / mismatch), switch, another phone joins, rollback
    node tests/test_notify_stay.js       # notify in the new model: by account, every owner, own devices/prefs/inbox, amounts + pays_directly_sources, marks, test push
    node tests/test_ical_stay.js         # ical-sync in the new model: stay feeds/events by account, Import now = owned accounts only
    STAYLOG_PG="…" node tests/test_cutover_sql.js    # 05-migrate.sql + rollback-cutover.sql: account, rows, placeholders, prune, copy, switch, her page on stay, read-only old tables, rollback, again
    STAYLOG_PG="…" node tests/test_stay_sql.js       # phase 1 `stay` schema: twice, check.sql ok, accounts/managers/staff access, composite keys, apply_change versions, receipts (concurrent), money, wages/utensils/undo/re-pricing on the server, her functions, rollback
    STAYLOG_PG="…" node tests/test_security_sql.js   # security-v60.sql: owners only, staff/stranger locked out, her page works, owner match, mark ids, refuses to lock out
    node tests/test_cancel.js            # no Delete; Cancel confirms + Undo; checked-out disabled; cancelled import stays cancelled over drains; excluded from revenue/occupancy
    node tests/test_glass.js             # clear glass bar: tint ≤ 0.15, blur ≤ 4px, halo, page seen through, solid with reduced transparency, label contrast from pixels
    node tests/test_tabbar.js            # floating tab bar: 34px home indicator, light/dark, 44px targets, last card clear, ⋯ + dot, shrink on scroll, reduced motion
    node tests/test_safe_area.js         # 47px status bar: header ⋯ and bell below it and tappable, light/dark, PIN, sheets, month picker, toast, staff.html
    node tests/test_inbox.js             # Notifications screen: bell, groups, tap → link + read, Mark all read + badge, Done per type, Still to do, Not delivered, offline, setAppBadge
    node tests/test_push_keys.js         # STAYLOG_REAL_VAPID_PRIVATE=… also searches for your real private key
    STAYLOG_PG="…" node tests/test_push_sql.js       # push.sql + inbox.sql: twice; owner-only; read_at the owner's only write; no TRUNCATE
    STAYLOG_PG="…" node tests/test_payment_sql.js    # payment-details.sql: constraints, owner-only
    STAYLOG_PG="…" node tests/test_utensils_sql.js   # all four scripts in order; the once-a-day, present-first and undo rules
    STAYLOG_PG="…" node tests/test_checkout_sql.js   # setup.sql + attendance.sql + checkout-wage.sql; her staff_standing
    STAYLOG_PG="-h <socket dir> -p <port> -U postgres" node tests/test_ical_sql.js   # skips without a Postgres; setup.sql + ical.sql + ical-connected.sql: access, the report, column grants

The first four survived a machine reset; fifteen earlier suites (receipt, WhatsApp,
loans, PDFs, staff page, theme) did not and should be rebuilt here before those
areas are changed.

## Open items

- **The key location was in the public repository** until v60 (git history
  before commit a7115d7 still has it; history is not rewritten). Changing the
  key's hiding place is the only real fix. Type the arrival instructions into
  the property once (Properties → Edit → Arrival instructions).

- **Push notifications have not met a real iPhone or the real project yet.**
  After setup, Send test from the Home Screen app; if it never arrives,
  read the function's logs. Apple's endpoint is the only one targeted;
  the encryption is standard and was checked against its RFCs, not a device.
- Notifications go to every device the owner has turned them on for; there
  is no per-device choice of alerts. Fine for one iPhone.
- Inbox Done states follow their rules literally: an arrival whose booking has
  no WhatsApp number is never "due" in `dueMessages`, so it shows Done at once;
  an arrival not sent before check-in day passes also turns Done (no longer
  due). Read state is per owner, not per device. A retried reminder that is
  finally delivered moves to the top (its `sent_at` becomes the delivery time).
- The 9 AM run uses the bookings in the cloud, so a booking made offline and
  not yet synced gets no reminder (the stale-sync warning covers a long gap).
- The attendance webhook shows Laxmi's mark even before the phone turns it
  into a wage; that is the point, but it means a mark she undoes within the
  15 minutes was still announced.
- "New booking" trusts the feed's uid: if a platform ever re-issues a changed
  reservation under a new uid, its new dates read as a new stay and notify.
  Dates Rakshit closes by hand on Booking.com also arrive as a "stay" and
  notify, unless a booking with exactly those dates is already in the cloud.
- If a Booking.com booking is ever prepaid through Booking.com Payments, record
  it as paid in the app: the app treats every Booking.com stay as
  pay-at-property and would otherwise ask the guest for the balance.
- Payment details travel inside the encrypted backup (and its saved
  `.staylog` file), as the Wi-Fi password does; nothing readable leaves the
  phone. Old plain `staylog-backup-*.json` files made before v52 are
  readable: delete any you still have, and keep them out of the repo.

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

- **Airbnb's export leaves out the dates it imports from Booking.com** —
  confirmed on the real feed. Turn on "Airbnb is connected to Booking.com’s
  calendar" in Calendar sync, so Booking.com stays are not checked against
  Airbnb (Airbnb closes them itself); direct stays still are. Whether
  Booking.com's export carries the Airbnb dates it imports is still not
  known: if Booking.com stays clear of the check but Airbnb stays are flagged
  "Still open on Booking.com" while Booking.com shows them closed, turn its
  setting on too. A single false warning can be dismissed on the booking
  ("Closed on …").
- **The calendar import has not met a real feed or the real project yet.**
  After setup, run `supabase/ical-report.sql` and compare against the Airbnb
  calendar and the Booking.com extranet for the first few days. If a platform's
  real feed differs from the documented shape, fix `parseIcs()` and add that
  feed to `tests/test_ical_function.js`.
- Booking.com cannot tell a guest from dates closed by hand, so a closure
  arrives as a "Booking.com guest" booking: cancel it (it stays cancelled, and
  stays on the Bookings list under Cancelled). If that becomes a chore: a "not
  a stay" button that stamps the event without a booking.
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
