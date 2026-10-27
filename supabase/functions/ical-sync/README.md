# ical-sync — setting it up

Once notifications are set up (`supabase/functions/notify/README.md`), this
function also hands each **new** reservation to `notify` for a "New booking"
push, using the `PUSH_CRON_SECRET` secret it already sees. Nothing else to do.

Reads the Booking.com and Airbnb calendar export links every 30 minutes and
records what is in them in `public.ical_events`. The phone turns new stays into
bookings at its next sync. The app works the same whether or not this is set up.

Do these in order, once.

1. **Run the SQL.** Supabase → SQL editor → paste `supabase/ical.sql` → Run.
   It is safe to run again.

2. **Deploy the function.** Supabase → Edge Functions → Deploy a new function →
   name it exactly `ical-sync` → paste `index.ts` → Deploy.
   (Or, with the Supabase CLI: `supabase functions deploy ical-sync --no-verify-jwt`.)

3. **Turn off "Verify JWT"** in the function's settings. The function checks
   who is calling itself: a signed-in owner, or the cron job's secret.

4. **Add the secret.** Edge Functions → Secrets → add `ICAL_CRON_SECRET` with a
   long random value (a password generator is fine). Keep a copy for step 5.
   It is never put in the repo.

5. **Schedule it.** Integrations → Cron → enable it if asked → Create job:
   - Schedule `*/30 * * * *`
   - Type: Supabase Edge Function → `ical-sync`, method POST
   - Add header `x-cron-secret` with the value from step 4

   (`supabase/ical.sql` has the same job as an SQL snippet at the bottom.)

6. **Paste the links in the app.** ⋯ → Cloud sync → Calendar import. One link
   per platform per property, then Import now.
   - Booking.com: extranet → Rates & Availability → Sync calendars → export link
   - Airbnb: Calendar → Availability → Connect to another calendar → export link

   Menu names on these sites move around; look for "export calendar".

## Checking it works

- Under each link the panel shows when it was last read and how many dates the
  feed held, or why the last read failed.
- Edge Functions → ical-sync → Logs shows each run.
- A 401 in the logs means the cron header and the secret do not match.

## What it can and cannot know

- Booking.com's feed carries dates only ("CLOSED - Not available"), with no name,
  amount, or difference between a guest and dates you closed yourself. Each
  becomes a "Booking.com guest" booking to fill in; delete one that was only
  closed dates and it stays deleted.
- Airbnb's feed says "Reserved" for guests (with a reservation link and the
  last 4 digits of the phone) and "Not available" for blocks. Blocks never
  become bookings.
- Because the two calendars are connected, each feed also shows the other's
  stays. Those are matched by property and exact dates and linked to the one
  booking, never doubled. The same rule links a stay you already typed in.
- The platforms refresh their feeds on their own schedule, sometimes hours late.
  Treat a double-booking flag as an early warning, not a lock.
