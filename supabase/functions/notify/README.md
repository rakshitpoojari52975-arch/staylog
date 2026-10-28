# notify — setting it up

Sends the owner's iPhone push notifications:

- when Laxmi marks attendance, or reports utensil cleaning (database webhooks);
- when the calendar import finds a new Airbnb or Booking.com reservation
  ("New booking": the `ical-sync` function hands it over, no webhook);
- at 9:00 AM IST: guests arriving tomorrow, a balance due at check-out
  tomorrow (Direct and Booking.com only), and a warning if the app has not
  synced for 2 days, or has made no encrypted backup for 3 (a cron job);
- a test, when the owner taps **Send test** in the app's ⋯ menu.

They are reminders only. The app works the same whether or not any of this is
set up, and nothing in it waits on a notification arriving.

Do these in order, once.

1. **Run the SQL.** Supabase → SQL editor → paste `supabase/push.sql` → Run,
   then `supabase/inbox.sql` (the in-app Notifications screen). Both are safe
   to run again. Without `inbox.sql` reminders still go out, the old way, and
   the app's Notifications screen says to run it.

2. **Make the keys.** Open `tools/vapid-keys.html` (on the deployed site, or
   from a local copy) and tap **Make a key pair**, or run
   `npx web-push generate-vapid-keys`. Make one pair, once: a new pair means
   every device has to turn notifications on again.
   **The private key goes only into Supabase (step 3).** Never into
   `cloud-config.js`, a commit, a chat, or a screenshot.

3. **Add the secrets.** Edge Functions → Secrets:
   - `VAPID_PUBLIC_KEY`: the public key
   - `VAPID_PRIVATE_KEY`: the private key
   - `VAPID_SUBJECT`: `mailto:` plus your email address (Apple uses it to
     contact the sender if something goes wrong)
   - `PUSH_CRON_SECRET`: a long random value (a password generator is fine).
     Keep a copy for steps 5 and 6.

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.

4. **Deploy the function.** Edge Functions → Deploy a new function → name it
   exactly `notify` → paste `index.ts` → Deploy. Then, in its settings, turn
   **Verify JWT off**: the function checks its callers itself (a signed-in
   owner for Send test, or the `x-cron-secret` header).
   (Or, with the Supabase CLI: `supabase functions deploy notify --no-verify-jwt`.)

5. **Schedule the 9 AM run.** Integrations → Cron → Create job:
   - Schedule `30 3 * * *` (03:30 UTC is 9:00 AM IST)
   - Type: Supabase Edge Function → `notify`, method POST
   - Body `{"job":"daily"}`
   - Header `x-cron-secret` with the value from step 3

6. **Hook up Laxmi's taps.** Database → Webhooks → Create, twice: one on
   table `attendance`, one on `utensil_marks`. Events **Insert** and
   **Update**; type Supabase Edge Function → `notify`, POST; header
   `x-cron-secret` with the value from step 3. Only a fresh mark notifies:
   the app stamping it, her undo, or marking again after an undo send nothing.

   (`supabase/push.sql` has steps 5 and 6 as SQL snippets at the bottom.)

   **New bookings need no webhook.** `ical-sync` calls `notify` itself with
   the same `PUSH_CRON_SECRET` (secrets are shared by every function in the
   project). Just redeploy `ical-sync` (paste its new `index.ts`) after this
   release. A feed's first read never notifies; only stays it shows after that.

7. **Put the public key in the app.** `cloud-config.js` → `vapidPublicKey`.
   Commit, merge, let GitHub Pages deploy.

8. **On the iPhone** (iOS 16.4 or later): open StayLog **from the Home Screen
   icon**, not a Safari tab. ⋯ → Turn on notifications → Allow → Send test.

## When something is wrong

- **Send test says "the notify function is not deployed"**: step 4.
- **"Not set up yet — the public key is missing"**: step 7.
- **"run supabase/push.sql"**: step 1.
- **Notifications screen: "the inbox is not set up"**: run `supabase/inbox.sql`.
- **A reminder shows "Not delivered" in the app**: no device took it (none
  subscribed, or Apple said the subscription is gone). Turn notifications on
  again from the ⋯ menu; the reminder is retried the next time it comes up.
- **The test sends but nothing appears**: check the iPhone's Settings →
  Notifications → StayLog, and Focus modes. The VAPID public key in
  `cloud-config.js` and in the secret must be the same pair as the private key.
- **Nothing at 9 AM**: Integrations → Cron → the job's run history. The
  function's reply lists what it did for each alert, including
  `skipped: "turned off"`, `"already sent"` or `"no devices"`.
- Each reminder is sent once (`push_log`), so running the cron twice is
  harmless. A device Apple reports gone (404/410) is removed; the app adds it
  back the next time it is opened, if notifications are still allowed.
