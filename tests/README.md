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

`fixtures/sw-before-fix.js` is the service worker that cached the Supabase API.
It is kept so `test_sw_upgrade.js` can prove the fix recovers from it.

None of this needs uploading to GitHub Pages — the app never loads it.
