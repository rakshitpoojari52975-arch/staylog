# StayLog tests

These live in the repository so they survive. An earlier set of nineteen was
kept outside it and was lost when the machine running them was reset.

    npm i -D playwright            # once
    node tests/test_sw_routes.js   # no browser — the caching rule
    node tests/test_sw_live.js     # real worker, real Supabase client, fake database
    node tests/test_sw_upgrade.js  # from the broken worker to the fixed one
    node tests/test_att_gap.js     # attendance → expense reconciliation

`fixtures/sw-before-fix.js` is the service worker that cached the Supabase API.
It is kept so `test_sw_upgrade.js` can prove the fix recovers from it.

None of this needs uploading to GitHub Pages — the app never loads it.
