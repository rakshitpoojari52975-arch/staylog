# Where StayLog's data is stored

## Check (2 minutes)

Supabase Dashboard → your project → **Project Settings → General**: the
**Region** line. India (Mumbai) is shown as `ap-south-1` / "South Asia
(Mumbai)". The project URL (`https://fnpuswexdaeqebrordvv.supabase.co`) does
not say the region, which is why this has to be read in the dashboard.

Write the answer into `privacy.html` (section 6) in the next release.

Note: the DPDP Act does not, as understood when this was written, require
personal data to stay in India; it lets the government restrict transfers to
named countries. Keeping it in Mumbai is a sound choice (latency, and fewer
questions from owners), not a legal must. **Confirm with the lawyer.**

## If the project is not in Mumbai: a plan to move (not run)

Supabase cannot move a project between regions; the move is to a **new
project** in Mumbai and a switch of the app's address. Plan for an evening
with no guests arriving, and tell owners and staff beforehand.

1. **Create** a new project in South Asia (Mumbai). Same plan tier.
2. **Schema and data:** with the database paused for writes (set
   `public.app_status.min_version` above every running app, so phones stop
   syncing and keep their changes), take a full dump of the old database
   (`pg_dump` with the connection string from Project Settings → Database,
   including the `auth`, `stay`, `public` and `vault` schemas' data) and
   restore it into the new one. Auth users and their password hashes come
   across with the `auth` schema, so nobody has to reset a password.
   Vault secrets: re-create them in the new project (they are encrypted with
   the old project's key).
3. **Exposed schemas:** Data API → Exposed schemas → add `stay`.
4. **Edge Functions:** paste each function again (`notify`, `ical-sync`,
   `staff-login`, `team-invite`, and from v75 `billing`), with Verify JWT off
   as before; re-add every secret (Edge Functions → Secrets).
5. **Cron jobs and webhooks:** re-create the calendar import (every 30 min),
   notify (hourly) and the daily jobs; re-create the two Database Webhooks on
   `stay.attendance` and `stay.utensil_marks`.
6. **Storage:** StayLog keeps no files in Supabase Storage today (photos never
   leave the phone; backups are rows). If that changes, copy the buckets.
7. **Auth settings:** sign-up off, rate limits, redirect URLs, email settings.
8. **Razorpay** (once live): change the webhook URL to the new project.
9. **The app:** change `url` and `publishableKey` in `cloud-config.js` and
   bump the versions (a release). Phones then sync with the new project and
   send their held changes; check every device in the Sync panel.
10. **Check:** run `supabase/stay/check.sql` (all ok), open the staff page,
    send a test notification, run Import now, make and restore a test backup.
11. **Old project:** keep it paused (not deleted) for 30 days, then delete it,
    including its backups.
