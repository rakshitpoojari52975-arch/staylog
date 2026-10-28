# Supabase — what lives here

StayLog keeps your data on your phone. Supabase holds only what something
online needs — Laxmi's page, the attendance / utensil / calendar drains and the
reminders — plus an **encrypted backup** it cannot read (`backups`, see
`backups.sql`). The exact columns are listed under "Sync model" in
`CLAUDE.md`.

Scripts are run by hand in the SQL editor, and every one is safe to run twice.

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
