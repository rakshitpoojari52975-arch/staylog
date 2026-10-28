# StayLog tests

These live in the repository so they survive. An earlier set of nineteen was
kept outside it and was lost when the machine running them was reset.

    npm i -D playwright            # once (match the installed Chromium if it complains)
    node tests/test_sw_routes.js   # no browser — the caching rule
    node tests/test_sw_live.js     # real worker, real Supabase client, fake database
    node tests/test_sw_upgrade.js  # from the broken worker to the fixed one
    node tests/test_att_gap.js     # attendance → expense reconciliation
    node tests/test_pay_loan.js    # Pay sheet: loan instalment taken out of wages
    node tests/test_sync_brake.js  # sync stops and asks before deleting an unusual number of rows
    node tests/test_sw_mismatch.js # banner when the running worker is another release's
    node tests/test_ical_function.js  # the ical-sync Edge Function, in Node, fake network
    node tests/test_ical_import.js    # calendar events → bookings, mirrors, double bookings
    STAYLOG_PG="-h /tmp -p 5432 -U postgres" node tests/test_ical_sql.js
                                      # setup.sql + ical.sql on a real Postgres: access rules and
                                      # supabase/ical-report.sql; skips without one
    node tests/test_checkout_wage.js  # checkout-day wages: the rule, re-pricing, sync, her page
    STAYLOG_PG="-h /tmp -p 5432 -U postgres" node tests/test_checkout_sql.js
                                      # checkout-wage.sql after setup.sql + attendance.sql; skips without one
    node tests/test_utensils.js       # utensil cleaning: the expense, holding, both lines, her page, house notes untouched
    STAYLOG_PG="-h /tmp -p 5432 -U postgres" node tests/test_utensils_sql.js
                                      # utensils.sql after the other three: once a day, present first, undo; skips without one
    node tests/test_payment.js        # payment details: who gets them, the balance, QR, receipt offer, repo scan
    STAYLOG_PG="-h /tmp -p 5432 -U postgres" node tests/test_payment_sql.js
                                      # payment-details.sql after setup.sql; skips without one
    node tests/test_faceid.js         # Face ID unlock: PIN-gated setup and off, cancel falls back, Reset PIN clears it
    node tests/test_new_bookings.js   # "New booking" pushes: ical-sync and notify run together; once per stay; the tap
    node tests/test_minimal_cloud.js  # what a sync sends is the allowlist only; no pull; empty phone; brake vs. the first minimal sync
    STAYLOG_PG="-h /tmp -p 5432 -U postgres" node tests/test_purge_sql.js
                                      # every script, then minimal-cloud.sql + purge-private.sql; Laxmi's page before = after
    node tests/test_backup.js         # encrypted backup: real WebCrypto; round trip, wrong passphrase, no plaintext sent, restore, change passphrase
    node tests/test_payout.js         # Airbnb and other platforms: one-tap "Mark payout received", Undo; no receipt or message
    node tests/test_round_off.js      # round off up to ₹5 on Direct/Booking.com: form, Mark paid, receipt, revenue, CSV, sync, notify
    node tests/test_balance.js        # under ₹1 is paid: one balanceDue() everywhere, the notify alert too
    node tests/test_notify_function.js   # the notify Edge Function in Node: each alert only when its condition holds,
                                         # pushes decrypted (RFC 8291) and VAPID-verified (RFC 8292)
    node tests/test_push_app.js       # menu, subscribe/unsubscribe, quiet re-subscribe, deep links, sw.js push handlers
    node tests/test_push_keys.js      # the VAPID private key is in no file, commit or bundle
    STAYLOG_PG="-h /tmp -p 5432 -U postgres" node tests/test_push_sql.js
                                      # push.sql after setup.sql: twice, owner-only, no TRUNCATE; skips without one

`fixtures/sw-before-fix.js` is the service worker that cached the Supabase API.
It is kept so `test_sw_upgrade.js` can prove the fix recovers from it.

None of this needs uploading to GitHub Pages — the app never loads it.
