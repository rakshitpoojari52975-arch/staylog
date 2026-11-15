# Supabase — what lives here

StayLog keeps your data on your phone. Supabase holds only what something
online needs — Laxmi's page, the attendance / utensil / calendar drains and the
reminders — plus an **encrypted backup** it cannot read (`backups`, see
`backups.sql`). The exact columns are listed under "Sync model" in
`CLAUDE.md`.

Scripts are run by hand in the SQL editor, and every one is safe to run twice.

## The new `stay` schema (revamp phase 1)

Built beside the tables above; the app does not use it yet, and nothing in
`public` changes.

1. Project Settings → **Data API** → **Exposed schemas**: add `stay` → Save.
2. In the SQL editor, in this order: `stay/01-schema.sql`,
   `stay/02-functions.sql`, `stay/03-access.sql`.
3. `stay/check.sql`: every row should say `ok` (the last rows confirm the old
   tables are still there, unchanged).

To undo: `stay/rollback-phase1.sql` (refuses once an account exists in
`stay`), then remove `stay` from Exposed schemas.

**Phase 3 (v62) — moving in and switching over.** In this order:

1. Merge the PR (the app becomes v62; nothing changes yet).
2. SQL editor: `stay/05-migrate.sql`, then `stay/check.sql` (all `ok`).
3. Edge Functions → **notify** and **ical-sync**: paste the new `index.ts`
   of each and deploy (Verify JWT stays off). They read
   `public.app_status.model` and keep working on the old tables until the
   switch.
4. On the iPhone: ⋯ → **Inventory**, screenshot it all.
5. ⋯ → **Move to the new system** → **Copy and compare**. Check the report
   against the screenshots. Run it again as often as you like; nothing
   changes until step 6.
6. **Switch over** (it compares once more first).
7. Database → **Webhooks**: point the attendance webhook at
   `stay.attendance` and the utensils one at `stay.utensil_marks`.
8. Ask Lakshmi to reopen her page and check it shows as before.

To undo: `stay/rollback-cutover.sql`, point the two webhooks back at
`public.attendance` / `public.utensil_marks`, reopen StayLog (it goes back
to the old system with every change made since).

**Phase 2 (v61):** `stay/04-phase2.sql` after 03 (lets a loan have no staff
member, as the house's own loans do; adds "changed since" indexes). Then
`stay/check.sql` again: all `ok`. The app ships the new sync engine but does
not use it until the switch-over (phase 3); nothing in `public` changes.

## v60 security fixes (once)

1. Dashboard → **Authentication → Sign In / Providers** → turn off
   **Allow new users to sign up**.
2. **`utensils.sql`** again — her `staff_standing()` now matches every row by
   owner.
3. **`security-v60.sql`** — only owners can read or write; mark ids must match
   staff and date; `sync_status` gains `device_id`; `app_status` is created. It
   refuses (changing nothing) if `public.owners` is empty or step 2 was
   skipped. Its last query should say `ok` for every table.
4. Redeploy **`notify`** (paste `functions/notify/index.ts`).

## Moving to the minimal cloud (once)

1. **`backups.sql`**, then in StayLog: Cloud sync → Encrypted backup → set a
   passphrase → **Test restore** ("Backup verified").
2. **`minimal-cloud.sql`** — adds `bookings.balance_due` and
   `sync_status.app_version`, and lets rows be written without the old private
   columns. Deletes nothing.
3. Open **StayLog v51** and let it sync. Once, it says "Removing private
   details from the cloud". Let it make a backup (it does after each sync).
4. **`purge-private.sql`** — drops the old private columns, hard-deletes
   expenses that are not staff payouts and every tombstoned row, clears the
   Airbnb reservation text from imported calendar events, and leaves every
   table with only the privileges the app uses (no TRUNCATE). It refuses to
   run unless there is an encrypted backup from the last 24 hours and the last
   sync came from v51 or later. The check queries at its end show what is left.

Redeploy the `notify` and `ical-sync` functions with this release (paste each
`index.ts`): `notify` reads `balance_due` and sends no guest names;
`ical-sync` stops storing an imported stay's reservation text.

## Supabase's own backups

Supabase may keep its own automatic backups of the database, depending on your
plan (Database → Backups in the dashboard shows what exists and for how long).
**Those still contain the old data — names, phone numbers, amounts — until they
age out under your plan's retention.** Nothing in this repository can reach
them. If you need them gone sooner, ask Supabase support.
