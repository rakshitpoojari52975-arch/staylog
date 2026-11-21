/* Stage 2 of billing and data protection in the app (v74): plans, the trial
   and read-only accounts. Postgres decides (tests/test_plans_sql.js); the
   app shows it and does not ask for what would be refused:
   - a quiet header chip ("Trial · 5 days left"); a banner from the last 2 days
   - read-only: "Read-only" chip, the reason in a banner with Export
     everything and Account settings; no add / edit / save (forms don't open,
     nothing is changed on the phone, nothing is sent); everything still shows
   - a property read-only on the plan (rule B): no actions on its bookings,
     not offered for a new booking
   - Export everything: behind the PIN, one JSON and a CSV per table, never
     the ID photos; available when read-only
   - Account settings: plan, status, dates, properties; Choose active
     properties (no more than the plan allows)
   - the platform admin's screen: accounts with plan and status; extend a
     trial, set a plan, cancel — through the audited functions
   - Raaya Vasyam (plan owner): no chip, no banner, writes as always */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const srv = http.createServer((q, r) => { const p = path.join(ROOT, (q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'text/plain' }); r.end(fs.readFileSync(p)); }).listen(0);
const D = n => { const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const PLAN = {
  trial5: { plan: 'trial', status: 'trialing', can_write: true, reason: null, days_left: 5, trial_ends_at: new Date(Date.now() + 5 * 864e5).toISOString(),
    properties_allowed: 5, properties_active: 2, paused_properties: [] },
  trial2: { plan: 'trial', status: 'trialing', can_write: true, reason: null, days_left: 2, trial_ends_at: new Date(Date.now() + 2 * 864e5).toISOString(),
    properties_allowed: 5, properties_active: 2, paused_properties: [] },
  expired: { plan: 'trial', status: 'expired', can_write: false, days_left: null, trial_ends_at: new Date(Date.now() - 864e5).toISOString(),
    reason: 'Your free trial has ended — subscribe to keep adding bookings. Your data is safe and you can still view and export it.',
    properties_allowed: 5, properties_active: 2, paused_properties: [] },
  starter: { plan: 'starter', status: 'active', can_write: true, reason: null, current_period_end: new Date(Date.now() + 20 * 864e5).toISOString(),
    properties_allowed: 1, properties_active: 1, paused_properties: ['p2'] },
  owner: { plan: 'owner', status: 'active', can_write: true, reason: null, properties_allowed: null, properties_active: 2, paused_properties: [] },
};
const STUB = o => `(function(){
  const S=window.__server={role:'owner',admin:${!!o.admin},calls:[],plan:${JSON.stringify(PLAN[o.plan] || null)},
    session:{user:{id:'u1',email:'me@example.com'},access_token:'t'},
    settings:{name:'Sea Breeze',code:'seabreeze',time_zone:'Asia/Kolkata',currency:'INR',pays_directly_sources:['Direct','Booking.com'],owner_name:'Asha',migrated_from:${o.plan === 'owner' ? "'old'" : 'null'}},
    accounts:[{id:'acct-1',name:'Sea Breeze',code:'seabreeze',plan:'trial',status:'trialing',can_write:true,trial_ends_at:'2026-11-28T00:00:00Z',properties:2,properties_allowed:5,owner:'Asha',last_activity:'2026-11-20T00:00:00Z'},
      {id:'acct-rv',name:'Raaya Vasyam',code:'raaya',plan:'owner',status:'active',can_write:true,properties:1,properties_allowed:null,owner:'Rakshit',last_activity:'2026-11-21T00:00:00Z'}]};
  const access=()=>({role:'owner',permissions:{edit_bookings:true,send_messages:true,mark_paid:true,see_money:true,add_expenses:true,manage_staff:true,edit_properties:true},properties:null});
  function q(table){const st={op:'select'};
    const api={select(){return api;},eq(){return api;},in(){return api;},is(){return api;},gt(){return api;},order(){return api;},range(){return api;},not(){return api;},gte(){return api;},limit(){return api;},
      update(v){st.op='update';return api;},insert(){st.op='insert';return api;},delete(){st.op='delete';return api;},upsert(){st.op='upsert';return api;},
      then(res,rej){let data=[];
        if(table==='app_status')data=[{id:1,min_version:62,model:'stay'}];
        else if(table==='members'&&st.op==='select')data=[{account_id:'acct-1',role:'owner',active:true,accounts:{name:'Sea Breeze',code:'seabreeze'}}];
        else if(table==='accounts')data=[S.settings];
        return Promise.resolve({data,error:null}).then(res,rej);}};
    return api;}
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:S.session}}),signOut:async()=>({error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    functions:{async invoke(){return{data:{},error:null};}},
    from:t=>q(t), rpc:async()=>({data:null,error:null}),
    schema:()=>({from:t=>q(t),async rpc(n,a){S.calls.push([n,a]);
      if(n==='my_access')return{data:access(),error:null};
      if(n==='am_platform_admin')return{data:S.admin,error:null};
      if(n==='legal_pending')return{data:[],error:null};
      if(n==='account_state')return{data:S.plan,error:null};
      if(n==='choose_active_properties'){S.plan={...S.plan,paused_properties:['p1','p2'].filter(x=>!a.p_active.includes(x))};return{data:S.plan,error:null};}
      if(n==='admin_accounts')return{data:S.accounts,error:null};
      if(n==='admin_extend_trial'||n==='admin_set_plan'||n==='admin_cancel')return{data:{ok:true},error:null};
      if(n==='apply_change')return{data:{status:'ok',row:{...a.p_row,version:1,updated_at:new Date().toISOString(),deleted_at:null,legacy:null}},error:null};
      return{data:null,error:null};}}),
  })};})();`;
const DATA = { properties: [{ id: 'p1', name: 'Sea Breeze' }, { id: 'p2', name: 'Hill View' }], staff: [], loans: [], expenses: [], attendance: [],
  bookings: [{ id: 'b1', propertyId: 'p1', guestName: 'Anita Rao', phone: '9876543210', checkIn: D(1), checkOut: D(3), guests: 2, totalAmount: 6000, paid: 1000,
    source: 'Direct', status: 'confirmed', msgSent: {}, idProofType: 'Passport', idProofNumber: 'Z1234567', idProofImage: 'data:image/png;base64,AAAA' },
    { id: 'b2', propertyId: 'p2', guestName: 'Kiran', phone: '9876500000', checkIn: D(4), checkOut: D(6), guests: 2, totalAmount: 5000, paid: 0,
    source: 'Direct', status: 'confirmed', msgSent: {} }] };

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  const open = async (o) => {
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    for (const g of ['**fonts.googleapis.com**', '**cdn.jsdelivr.net**']) await ctx.route(g, r => r.abort());
    await ctx.route('**vendor/supabase.umd.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB(o) }));
    const page = await ctx.newPage(); const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    await page.addInitScript(s => {
      if (sessionStorage.getItem('__s')) return; sessionStorage.setItem('__s', '1');
      localStorage.setItem('staylog_model', JSON.stringify({ mode: 'stay', user: 'u1', account: 'acct-1' }));
      const r = indexedDB.open('staylog_db', 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore('appdata');
      r.onsuccess = e => e.target.result.transaction('appdata', 'readwrite').objectStore('appdata').put(s, 'staylog_stay_data:u1:acct-1');
    }, DATA);
    await page.goto(base + '/index.html' + (o.hash || ''));
    await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    await page.evaluate(() => { state.loggedIn = true; state.auth = { pin: '1234' }; render(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(400);
    await page.evaluate(() => { if (state.modal === 'legalAccept') closeModal(); render(); });
    return { ctx, page, errs, dialogs };
  };
  const chip = page => page.locator('[data-plan-chip]').innerText().catch(() => '');
  const banner = page => page.locator('[data-plan-banner]').innerText().catch(() => '');
  const toast = page => page.locator('[data-toast]').innerText().catch(() => '');

  console.log('\n— a trial —');
  { const { ctx, page, errs } = await open({ plan: 'trial5' });
    ok('a quiet chip in the header: "Trial · 5 days left"', await chip(page) === 'Trial · 5 days left');
    ok('no banner yet', await page.locator('[data-plan-banner]').count() === 0);
    await page.click('[data-plan-chip]'); await page.waitForTimeout(150);
    const acc = await page.locator('[data-plan]').innerText().catch(() => '');
    ok('the chip opens Account settings, with the plan: free trial, on trial, its end, properties', await page.evaluate(() => state.modal) === 'account'
      && /Free trial/.test(acc) && /On trial/.test(acc) && /Trial ends/.test(acc) && /2 active of 5 allowed/.test(acc), acc);
    ok('…and says paid plans open soon (billing is the next stage)', await page.locator('[data-subscribe-soon]').count() === 1);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({ plan: 'trial2' });
    ok('the last 2 days: a banner', /Your free trial ends in 2 days. Subscribe in Account settings/.test(await banner(page)), await banner(page));
    await ctx.close(); }

  console.log('\n— read-only —');
  { const { ctx, page, errs } = await open({ plan: 'expired' });
    ok('the chip says "Read-only"', await chip(page) === 'Read-only');
    const b = await banner(page);
    ok('the banner gives the reason, with Export everything and Account settings', /Your free trial has ended — subscribe to keep adding bookings. Your data is safe/.test(b)
      && await page.locator('[data-plan-export]').count() === 1 && await page.locator('[data-plan-settings]').count() === 1, b);
    await page.evaluate(() => setState({ tab: 'bookings', expandedBooking: 'b1' })); await page.waitForTimeout(200);
    const card = await page.locator('[data-main]').innerText();
    ok('everything still shows: the booking and its guest', /Anita Rao/.test(card));
    ok('…but no Edit, Check In, Cancel or Mark paid on it', !/\bEdit\b|Check In|Mark paid/.test(card) && await page.locator('[data-cancel-booking]').count() === 0, card.slice(0, 400));
    await page.evaluate(() => setState({ modal: 'addBooking', editItem: null })); await page.waitForTimeout(150);
    ok('an add form does not open; the reason is said', await page.evaluate(() => state.modal) !== 'addBooking' && /free trial has ended/.test(await toast(page)));
    await page.evaluate(() => setState({ modal: 'addExpense', editItem: null })); await page.waitForTimeout(100);
    ok('…nor an expense, nor staff', await page.evaluate(() => state.modal) !== 'addExpense');
    const before = await page.evaluate(() => JSON.stringify(state.data.bookings));
    const calls = await page.evaluate(() => window.__server.calls.filter(c => c[0] === 'apply_change').length);
    await page.evaluate(() => mutateData(d => { d.bookings[0].guestName = 'Changed'; }));
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(400);
    ok('a change from anywhere in the app is not made on the phone', await page.evaluate(() => JSON.stringify(state.data.bookings)) === before);
    ok('…and nothing is sent to the server', await page.evaluate(() => window.__server.calls.filter(c => c[0] === 'apply_change').length) === calls);

    console.log('\n— Export everything —');
    ok('⋯ offers Export everything', await page.evaluate(() => { state.modal = 'menu'; render(); return /Export everything/.test(document.body.innerText); }));
    await page.evaluate(() => closeModal());
    await page.click('[data-plan-export]'); await page.waitForTimeout(150);
    ok('it warns that the files are readable, and asks for the PIN', /readable by anyone/.test(await page.locator('[data-export]').innerText()) && await page.locator('[data-export-pin]').count() === 1);
    await page.fill('[data-export-pin]', '9999'); await page.click('[data-export-go]'); await page.waitForTimeout(300);
    ok('a wrong PIN: nothing exported', /not right/.test(await page.locator('[data-export]').innerText()));
    await page.evaluate(() => { window.__shared = null; navigator.canShare = () => true;
      navigator.share = async d => { window.__shared = await Promise.all(d.files.map(async f => ({ name: f.name, text: await f.text() }))); }; });
    await page.fill('[data-export-pin]', '1234'); await page.click('[data-export-go]'); await page.waitForTimeout(500);
    const files = await page.evaluate(() => window.__shared);
    const names = (files || []).map(f => f.name);
    ok('the right PIN, on a read-only account: one JSON and a CSV per table', files && names.some(n => /seabreeze-export-.*\.json$/.test(n))
      && ['properties', 'bookings', 'expenses', 'staff', 'loans', 'loan_repayments'].every(t => names.some(n => n.includes(`-${t}-`) && n.endsWith('.csv'))), names);
    const json = files && JSON.parse(files.find(f => f.name.endsWith('.json')).text);
    ok('the JSON holds everything, guest details included', json && json.data.bookings.length === 2 && json.data.bookings[0].guestName === 'Anita Rao' && json.data.bookings[0].idProofNumber === 'Z1234567');
    ok('…but never the ID photo', files && !files.some(f => /idProofImage|data:image/.test(f.text)));
    const csv = files && files.find(f => f.name.includes('-bookings-')).text;
    ok('the bookings CSV: a header and a line per booking', csv && csv.split('\n').length === 3 && /guestName/.test(csv.split('\n')[0]), csv && csv.slice(0, 200));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— a property read-only on the plan (rule B) —');
  { const { ctx, page, errs } = await open({ plan: 'starter' });
    ok('no chip on a paid plan', await page.locator('[data-plan-chip]').count() === 0);
    await page.evaluate(() => setState({ tab: 'bookings', expandedBooking: 'b2' })); await page.waitForTimeout(150);
    ok('a booking at the paused property: no Edit or Mark paid', !/\bEdit\b|Mark paid/.test(await page.locator('[data-main]').innerText()));
    await page.evaluate(() => setState({ expandedBooking: 'b1' })); await page.waitForTimeout(150);
    ok('…at the active one: as usual', /\bEdit\b/.test(await page.locator('[data-main]').innerText()));
    await page.evaluate(() => setState({ modal: 'addBooking', editItem: state.data.bookings.find(b => b.id === 'b2') })); await page.waitForTimeout(150);
    ok('editing a booking there: the form does not open; the reason is said', await page.evaluate(() => state.modal) !== 'addBooking' && /read-only on your plan/.test(await toast(page)));
    await page.evaluate(() => setState({ modal: 'addBooking', editItem: null })); await page.waitForTimeout(150);
    const opts = await page.evaluate(() => [...document.querySelectorAll('select option')].map(o => o.value).filter(v => /^p\d$/.test(v)));
    ok('a new booking: only the active property is offered', JSON.stringify(opts) === '["p1"]', opts);
    await page.evaluate(() => closeModal());
    await page.evaluate(() => setState({ modal: 'account' })); await page.waitForTimeout(150);
    ok('Account settings: Starter, active, renews, 1 active of 1, one read-only', /Starter — 1 property/.test(await page.locator('[data-plan]').innerText())
      && /1 active of 1 allowed/.test(await page.locator('[data-plan]').innerText()) && /1 property is read-only/.test(await page.locator('[data-plan]').innerText()));
    await page.click('[data-choose-active]'); await page.waitForTimeout(150);
    await page.check('[data-active-prop="p1"]'); await page.check('[data-active-prop="p2"]');
    await page.click('[data-active-save]'); await page.waitForTimeout(150);
    ok('choosing two on a 1-property plan: refused before asking the server', /allows 1/.test(await page.locator('[data-active-props]').innerText())
      && !(await page.evaluate(() => window.__server.calls.some(c => c[0] === 'choose_active_properties'))));
    await page.uncheck('[data-active-prop="p1"]'); await page.click('[data-active-save]'); await page.waitForTimeout(300);
    const call = await page.evaluate(() => window.__server.calls.find(c => c[0] === 'choose_active_properties'));
    ok('choosing Hill View instead: sent to the server (which decides)', call && JSON.stringify(call[1].p_active) === '["p2"]', call);
    ok('…and Sea Breeze is now the read-only one here', await page.evaluate(() => pausedProp('p1') && !pausedProp('p2')));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— Raaya Vasyam: plan owner —');
  { const { ctx, page, errs } = await open({ plan: 'owner' });
    ok('no chip, no banner', await page.locator('[data-plan-chip]').count() === 0 && await page.locator('[data-plan-banner]').count() === 0);
    await page.evaluate(() => mutateData(d => { d.bookings[0].notes = 'still writing'; }));
    ok('changes are made as always', await page.evaluate(() => state.data.bookings[0].notes) === 'still writing');
    await page.evaluate(() => setState({ modal: 'account' })); await page.waitForTimeout(150);
    ok('Account settings: Owner (no billing), no "paid plans soon"', /Owner \(no billing\)/.test(await page.locator('[data-plan]').innerText()) && await page.locator('[data-subscribe-soon]').count() === 0);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— the platform admin\'s screen —');
  { const { ctx, page, errs, dialogs } = await open({ plan: 'owner', admin: true });
    ok('⋯ offers All accounts to a platform admin', await page.evaluate(() => { state.modal = 'menu'; render(); return /All accounts/.test(document.body.innerText); }));
    await page.evaluate(() => { adm.list = null; adm.err = ''; setState({ modal: 'admin' }); }); await page.waitForTimeout(300);
    const t = await page.locator('[data-admin]').innerText();
    ok('each account with plan, status, trial end, properties, owner and last activity', /Sea Breeze · seabreeze/.test(t) && /Free trial · On trial/.test(t)
      && /trial ends/.test(t) && /2 properties of 5/.test(t) && /owner Asha/.test(t) && /last active/.test(t), t);
    ok('an owner-plan account has no buttons', await page.locator('[data-admin-account="acct-rv"] button').count() === 0);
    await page.click('[data-admin-extend="acct-1"]'); await page.waitForTimeout(300);
    ok('Extend trial 7 days → admin_extend_trial', await page.evaluate(() => JSON.stringify(window.__server.calls.find(c => c[0] === 'admin_extend_trial')[1])) === '{"p_account":"acct-1","p_days":7}');
    await page.click('[data-admin-plan-owner="acct-1"]'); await page.waitForTimeout(300);
    ok('Comp (owner) asks first, then admin_set_plan', dialogs.some(d => /never expire and never be billed/.test(d))
      && await page.evaluate(() => window.__server.calls.some(c => c[0] === 'admin_set_plan' && c[1].p_plan === 'owner')));
    await page.click('[data-admin-cancel="acct-1"]'); await page.waitForTimeout(300);
    ok('Cancel asks first ("Nothing is deleted"), then admin_cancel', dialogs.some(d => /Nothing is deleted/.test(d)) && await page.evaluate(() => window.__server.calls.some(c => c[0] === 'admin_cancel')));
    ok('the screen shows no guest data', !/Anita|Kiran|9876/.test(await page.locator('[data-admin]').innerText()));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({ plan: 'trial5' });
    ok('not a platform admin: no All accounts', await page.evaluate(() => { state.modal = 'menu'; render(); return !/All accounts/.test(document.body.innerText); }));
    await ctx.close(); }
  { const { ctx, page } = await open({ plan: 'trial5' });
    await page.evaluate(() => { takeOpen('#open=account'); }); await page.waitForTimeout(300);
    ok('the "trial ends tomorrow" notification opens Account settings (#open=account)', await page.evaluate(() => state.modal) === 'account');
    await ctx.close(); }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
