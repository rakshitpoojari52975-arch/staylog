# billing — setting it up (v75)

Takes payment for paid plans through Razorpay and keeps each account's plan
true. What it does:

- **Subscribe** (owner, in Account settings): makes a Razorpay subscription
  for the chosen plan and opens Razorpay's own payment page. No Razorpay code
  or key is in the app.
- **Razorpay's webhook**: every event is checked against its signature,
  recorded once in `stay.billing_events` and applied. Paid → the account is
  active until the period's end; a failed renewal → 3 days' grace; cancelled
  → runs to the period's end. Each payment gets an invoice in
  `stay.invoices`.
- **Cancel plan** (owner): cancelled at the end of the period paid for.
- **The daily sweep**: statuses catch up with the clock.

Postgres decides what an account may do (`12-plans.sql`, `13-billing.sql`);
this function only tells it what Razorpay said. **Raaya Vasyam (plan
`owner`) is never touched.**

Do these in order, once. Do it all in Razorpay's **test mode** first, then
again with the live keys.

1. **Run the SQL.** SQL editor → `supabase/stay/13-billing.sql` → Run, then
   `check.sql`. Every row should say ok.

2. **Razorpay** (Dashboard, test mode first):
   - Turn on **Subscriptions** (and UPI Autopay, if offered).
   - **Plans**: make one per plan you sell (Starter / Pro, monthly / yearly),
     with the price **including GST** if you charge it. Copy each plan id
     (`plan_…`).
   - **API keys**: generate a key pair. The key secret is shown once.

3. **Supabase secrets** (Edge Functions → Secrets):
   - `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`: the key pair.
   - `RAZORPAY_WEBHOOK_SECRET`: a long random value. You'll type the same
     value into Razorpay in step 5.
   - `FINGERPRINT_PEPPER`: a long random value, set **once and never changed**
     (changing it forgets every trial seen before). It is used by
     `team-invite` and `ical-sync`, so paste those again too.
   - `PUSH_CRON_SECRET` is already set (notify uses it).

   **Never put any of these in the repository, a chat or a screenshot.**
   `tests/test_secrets.js` fails if one ever lands in a file or a commit.

4. **Deploy the function**: Edge Functions → Deploy a new function → name it
   `billing` → paste `index.ts` → **turn off Verify JWT** (Razorpay sends no
   token; the function checks the signature, the cron secret, or the owner's
   token itself) → Deploy. Copy its URL:
   `https://<project>.supabase.co/functions/v1/billing`.

5. **Razorpay webhook** (Settings → Webhooks → Add):
   - URL: the function's URL.
   - Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`.
   - Events: `subscription.authenticated`, `subscription.activated`,
     `subscription.charged`, `subscription.pending`, `subscription.halted`,
     `subscription.cancelled`, `subscription.completed`,
     `subscription.paused`, `subscription.resumed`.
     *(Names from Razorpay's SDK and memory — tick whatever the dashboard
     calls these.)*

6. **The daily sweep**: Integrations → Cron → a job once a day (any hour),
   an HTTP request:
   - POST to the function's URL;
   - header `x-cron-secret`: your `PUSH_CRON_SECRET`;
   - body `{"job":"sweep"}`.

7. **Prices and sales** (the app → ⋯ → All accounts):
   - **Plans and prices**: for each plan, the price in rupees, its Razorpay
     plan id and the number of properties; tick **On sale**; Save. **The
     price here must match Razorpay's.** The app shows this price; Razorpay
     charges its own.
   - **Sales and GST**: the name and address on invoices. Leave **Charge GST**
     off until your CA says to register; then add your GSTIN and SAC code
     (your CA confirms which), and tick it. Tick **Paid plans open** when
     you're ready: owners then see Subscribe.
   - Every save goes into the admin audit log.

8. **A test payment** (test mode keys): on a test account (not Raaya
   Vasyam), Account settings → Subscribe → pay with Razorpay's test card or
   UPI id. Within a minute the plan shows Active, the invoice appears, and
   `select event, result from stay.billing_events order by received_at desc`
   shows each event once. Then Cancel plan: it says when the plan ends.

9. **Going live**: swap the two key secrets for the live ones, make the live
   plans and paste their ids, add the webhook again in live mode (same secret
   or a new one, also set in Supabase), and redeploy the function.

## If something goes wrong

- **Paid, but the plan still shows the trial**: Razorpay → Webhooks → the
  delivery log. A 401 means the two webhook secrets differ. A 500 means the
  database did not take it; Razorpay sends it again. You can also extend the
  trial from ⋯ → All accounts while you look.
- **Two subscriptions for one account**: the second is cancelled at once by
  the function. Its log says so; if Razorpay refused, cancel it in Razorpay
  and refund the charge.
- **Turn billing off**: ⋯ → All accounts → Sales and GST → untick **Paid
  plans open**. Paid accounts keep their plans; no new orders.
