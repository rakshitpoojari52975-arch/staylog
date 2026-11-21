/* Stage 3 of billing and data protection in the app (v75): paying for a plan.
   The billing Edge Function and Postgres decide (test_billing_function.js,
   test_billing_sql.js); the app shows and asks:
   - sales closed: "Paid plans open soon"; open: the plans on sale with their
     prices, Subscribe → the billing function → Razorpay's page opened from
     the tap; a refusal said in words; an order waiting: "Waiting for
     Razorpay…" with Check again
   - a live plan: Cancel plan (confirmed) → runs to the period's end;
     cancelling: says when it ends and offers the plans again
   - the GSTIN for invoices (checked before sending); invoices listed, each a
     PDF — a tax invoice or a receipt as it was issued
   - a store build (cloud-config storeBuild): no price, no Subscribe, no word
     of buying anywhere, the read-only reason in plain words
   - the platform admin: prices with the Razorpay plan id, sales and GST,
     billing and repeat trials per account
   - Raaya Vasyam (plan owner): no billing at all */
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
  expired: { plan: 'trial', status: 'expired', can_write: false, days_left: null, trial_ends_at: new Date(Date.now() - 864e5).toISOString(),
    reason: 'Your free trial has ended — subscribe to keep adding bookings. Your data is safe and you can still view and export it.',
    properties_allowed: 5, properties_active: 2, paused_properties: [] },
  pro: { plan: 'pro', status: 'active', can_write: true, reason: null, current_period_end: '2026-12-21T00:00:00Z',
    properties_allowed: 5, properties_active: 2, paused_properties: [] },
  owner: { plan: 'owner', status: 'active', can_write: true, reason: null, properties_allowed: null, properties_active: 2, paused_properties: [] },
};
const BILL = {
  closed: { open: false, has_subscription: false, cancel_at_period_end: false, pending: false, gstin: null, repeat_trial: false },
  open: { open: true, has_subscription: false, cancel_at_period_end: false, pending: false, gstin: null, repeat_trial: false },
  pending: { open: true, has_subscription: false, cancel_at_period_end: false, pending: true, gstin: null, repeat_trial: false },
  live: { open: true, subscription_plan: 'pro_monthly', has_subscription: true, cancel_at_period_end: false, pending: false, gstin: '29ABCDE1234F1Z5', repeat_trial: false },
  cancelling: { open: true, subscription_plan: 'pro_monthly', has_subscription: true, cancel_at_period_end: true, pending: false, gstin: null, repeat_trial: false },
  repeat: { open: true, has_subscription: false, cancel_at_period_end: false, pending: false, gstin: null, repeat_trial: true },
};
const PLANS = [{ id: 'starter_monthly', plan: 'starter', period: 'monthly', amount_paise: 49900, currency: 'INR', properties_allowed: 1, active: true, sort: 1 },
  { id: 'pro_yearly', plan: 'pro', period: 'yearly', amount_paise: 999900, currency: 'INR', properties_allowed: 5, active: true, sort: 4 }];
const INVOICES = [
  { id: 'i2', number: 'SL/2026-27/0002', issued_at: '2026-11-20T10:00:00Z', description: 'StayLog Pro — monthly subscription', amount_paise: 118000, taxable_paise: 100000,
    gst_paise: 18000, gst_rate: 18, tax_invoice: true, seller: { name: 'Rakshit Poojari', address: '1331, 3rd floor, Sector 37, Faridabad - 121003', gstin: '06ABCDE1234F1Z5', sac: '998314' },
    buyer: { name: 'Sea Breeze', gstin: '29ABCDE1234F1Z5' }, razorpay_payment_id: 'pay_2', period_start: '2026-11-20T00:00:00Z', period_end: '2026-12-20T00:00:00Z' },
  { id: 'i1', number: 'SL/2026-27/0001', issued_at: '2026-10-20T10:00:00Z', description: 'StayLog Pro — monthly subscription', amount_paise: 99900, taxable_paise: 99900,
    gst_paise: 0, gst_rate: 0, tax_invoice: false, seller: { name: 'Rakshit Poojari', address: '1331, 3rd floor, Sector 37, Faridabad - 121003', gstin: null },
    buyer: { name: 'Sea Breeze', gstin: null }, razorpay_payment_id: 'pay_1' }];
const STUB = o => `(function(){
  const S=window.__server={admin:${!!o.admin},calls:[],invokes:[],updates:[],plan:${JSON.stringify(PLAN[o.plan] || null)},
    billing:${JSON.stringify(BILL[o.bill] || null)},plans:${JSON.stringify(PLANS)},invoices:${JSON.stringify(o.invoices ? INVOICES : [])},
    pset:{id:1,billing_open:true,gst_enabled:false,gst_rate:18,seller_name:'Rakshit Poojari',seller_address:'1331, 3rd floor, Sector 37, Faridabad - 121003',seller_gstin:null,sac_code:null,invoice_prefix:'SL'},
    allPlans:${JSON.stringify([...PLANS, { id: 'pro_monthly', plan: 'pro', period: 'monthly', amount_paise: null, razorpay_plan_id: null, properties_allowed: 5, active: false, sort: 3 }])},
    invokeAnswer:${JSON.stringify(o.invokeAnswer || null)},
    session:{user:{id:'u1',email:'me@example.com'},access_token:'t'},
    settings:{name:'Sea Breeze',code:'seabreeze',time_zone:'Asia/Kolkata',currency:'INR',pays_directly_sources:['Direct','Booking.com'],owner_name:'Asha',migrated_from:${o.plan === 'owner' ? "'old'" : 'null'}},
    accounts:[{id:'acct-1',name:'Sea Breeze',code:'seabreeze',plan:'trial',status:'trialing',can_write:true,trial_ends_at:'2026-11-28T00:00:00Z',properties:2,properties_allowed:5,owner:'Asha',last_activity:'2026-11-20T00:00:00Z'},
      {id:'acct-2',name:'Hill View',code:'hill',plan:'pro',status:'active',can_write:true,properties:1,properties_allowed:5,owner:'Ravi',last_activity:'2026-11-20T00:00:00Z'},
      {id:'acct-rv',name:'Raaya Vasyam',code:'raaya',plan:'owner',status:'active',can_write:true,properties:1,properties_allowed:null,owner:'Rakshit',last_activity:'2026-11-21T00:00:00Z'}]};
  const access=()=>({role:'owner',permissions:{edit_bookings:true,send_messages:true,mark_paid:true,see_money:true,add_expenses:true,manage_staff:true,edit_properties:true},properties:null});
  function q(table){const st={op:'select'};
    const api={select(){return api;},eq(){return api;},in(){return api;},is(){return api;},gt(){return api;},order(){return api;},range(){return api;},not(){return api;},gte(){return api;},limit(){return api;},
      update(v){st.op='update';st.v=v;return api;},insert(){st.op='insert';return api;},delete(){st.op='delete';return api;},upsert(){st.op='upsert';return api;},
      then(res,rej){let data=[],error=null;
        if(table==='app_status')data=[{id:1,min_version:62,model:'stay'}];
        else if(table==='members'&&st.op==='select')data=[{account_id:'acct-1',role:'owner',active:true,accounts:{name:'Sea Breeze',code:'seabreeze'}}];
        else if(table==='accounts'&&st.op==='update'){S.updates.push(st.v);if(S.billing&&'gstin' in st.v)S.billing={...S.billing,gstin:st.v.gstin};}
        else if(table==='accounts')data=[S.settings];
        else if(table==='plans')data=S.admin?S.allPlans:S.plans;
        else if(table==='platform_settings')data=[S.pset];
        else if(table==='invoices')data=S.invoices;
        return Promise.resolve({data,error}).then(res,rej);}};
    return api;}
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:S.session}}),signOut:async()=>({error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    functions:{async invoke(name,{body}){S.invokes.push([name,body]);
      if(S.invokeAnswer&&S.invokeAnswer.error)return{data:null,error:{message:'non-2xx',context:{json:async()=>({error:S.invokeAnswer.error})}}};
      if(body.action==='subscribe'){S.billing={...S.billing,pending:true};return{data:{ok:true,url:'https://rzp.io/i/abc',subscription:'sub_1'},error:null};}
      if(body.action==='cancel'){S.billing={...S.billing,cancel_at_period_end:true};return{data:{ok:true,until:'2026-12-21T00:00:00Z'},error:null};}
      return{data:{},error:null};}},
    from:t=>q(t), rpc:async()=>({data:null,error:null}),
    schema:()=>({from:t=>q(t),async rpc(n,a){S.calls.push([n,a]);
      if(n==='my_access')return{data:access(),error:null};
      if(n==='am_platform_admin')return{data:S.admin,error:null};
      if(n==='legal_pending')return{data:[],error:null};
      if(n==='account_state')return{data:S.plan,error:null};
      if(n==='billing_state')return{data:S.billing,error:null};
      if(n==='admin_accounts')return{data:S.accounts,error:null};
      if(n==='admin_billing')return{data:{'acct-1':{repeat_trial:true,repeat_of:'Old Stay',invoices:0,paid_paise:0},'acct-2':{subscription_plan:'pro_monthly',invoices:2,paid_paise:217900,has_subscription:true}},error:null};
      if(n==='admin_save_plan'||n==='admin_save_settings')return{data:{ok:true},error:null};
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
    if (o.store) await ctx.route('**/cloud-config.js', r => r.fulfill({ contentType: 'text/javascript',
      body: fs.readFileSync(path.join(ROOT, 'cloud-config.js'), 'utf8').replace('storeBuild: false', 'storeBuild: true') }));
    await ctx.route('**vendor/supabase.umd.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB(o) }));
    const page = await ctx.newPage(); const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    await page.addInitScript(() => { window.__opened = []; window.open = (u) => { const w = { u, location: {}, closed: false, close() { this.closed = true; }, opener: 1 };
      window.__opened.push(w); return w; }; });
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
  const toast = page => page.locator('[data-toast]').innerText().catch(() => '');
  const account = async page => { await page.evaluate(() => setState({ modal: 'account' })); await page.waitForTimeout(400);
    return page.locator('[data-plan]').innerText().catch(() => ''); };
  const S = (page, k) => page.evaluate(k => window.__server[k], k);

  console.log('\n— sales closed —');
  { const { ctx, page, errs } = await open({ plan: 'trial5', bill: 'closed' });
    const t = await account(page);
    ok('"Paid plans open soon", nothing to buy', await page.locator('[data-subscribe-soon]').count() === 1 && await page.locator('[data-subscribe]').count() === 0, t);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— subscribing —');
  { const { ctx, page, errs } = await open({ plan: 'trial5', bill: 'open' });
    const t = await account(page);
    ok('the plans on sale with their prices', /Starter · ₹499 a month/.test(t) && /Pro · ₹9,999 a year/.test(t) && /Up to 5 properties · billed yearly/.test(t)
      && await page.locator('[data-subscribe]').count() === 2, t);
    ok('…how it is paid, renewal and the refund policy', /Razorpay/.test(t) && /Renews automatically/.test(t) && await page.locator('[data-billing] a[href="refund.html"]').count() === 1);
    await page.click('[data-subscribe="starter_monthly"]'); await page.waitForTimeout(600);
    const inv = await S(page, 'invokes');
    ok('Subscribe asks the billing function, with the account and the plan only', inv.length === 1 && inv[0][0] === 'billing'
      && JSON.stringify(inv[0][1]) === JSON.stringify({ action: 'subscribe', account: 'acct-1', plan: 'starter_monthly' }), inv);
    const opened = await page.evaluate(() => window.__opened.map(w => ({ u: w.u, href: w.location.href, opener: w.opener })));
    ok('…Razorpay\'s page opens in a window opened by the tap itself', opened.length === 1 && opened[0].u === '' && opened[0].href === 'https://rzp.io/i/abc'
      && opened[0].opener === null, opened);
    ok('…and says to come back once paid', /come back here once you have paid/.test(await toast(page)));
    ok('…then waits for Razorpay\'s word', /Waiting for Razorpay to confirm/.test(await page.locator('[data-billing]').innerText()) && await page.locator('[data-billing-refresh]').count() === 1);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page, dialogs } = await open({ plan: 'expired', bill: 'open', invokeAnswer: { error: 'Paid plans are not open yet.' } });
    await account(page);
    await page.click('[data-subscribe="pro_yearly"]'); await page.waitForTimeout(500);
    ok('a refusal: said in its own words, the blank window closed', dialogs.includes('Paid plans are not open yet.')
      && await page.evaluate(() => window.__opened[0].closed) === true, dialogs);
    ok('a read-only account can subscribe (it is the way out)', await page.locator('[data-subscribe]').count() === 2);
    await ctx.close(); }
  { const { ctx, page } = await open({ plan: 'trial5', bill: 'repeat' });
    ok('a repeat trial: says why there is none', /had a free trial before/.test(await account(page)));
    await ctx.close(); }

  console.log('\n— a live plan —');
  { const { ctx, page, dialogs } = await open({ plan: 'pro', bill: 'live', invoices: true });
    let t = await account(page);
    ok('Pro, active, renews; Cancel plan; nothing to buy', /Pro — up to 5 properties/.test(t) && /Renews/.test(t)
      && await page.locator('[data-plan-cancel]').count() === 1 && await page.locator('[data-subscribe]').count() === 0, t);
    await page.click('[data-plan-cancel]'); await page.waitForTimeout(600);
    ok('cancel asks first, saying it runs to the end and nothing is deleted', dialogs.some(d => /runs until .*read-only. Nothing is deleted/.test(d)), dialogs);
    ok('…then the billing function cancels', (await S(page, 'invokes')).some(x => x[1].action === 'cancel' && x[1].account === 'acct-1'));
    ok('…"Your plan ends on …"', /Your plan ends on/.test(await toast(page)));
    t = await page.locator('[data-billing]').innerText();
    ok('…and the plans are offered again', /Your plan ends on/.test(t) && await page.locator('[data-subscribe]').count() === 2, t);

    console.log('\n— GSTIN and invoices —');
    ok('the GSTIN on file is shown', await page.locator('[data-gstin]').inputValue() === '29ABCDE1234F1Z5');
    await page.fill('[data-gstin]', 'nope'); await page.click('[data-gstin-save]'); await page.waitForTimeout(200);
    ok('a malformed GSTIN is caught before sending', dialogs.some(d => /15 letters and digits/.test(d)) && (await S(page, 'updates')).length === 0);
    await page.fill('[data-gstin]', '27abcde1234f1z5'); await page.click('[data-gstin-save]'); await page.waitForTimeout(400);
    ok('a good one is saved (upper-cased)', (await S(page, 'updates')).some(u => u.gstin === '27ABCDE1234F1Z5'));
    const rows = await page.locator('[data-invoice]').allInnerTexts();
    ok('invoices listed, newest first, with number and amount', rows.length === 2 && /SL\/2026-27\/0002 · ₹1,180/.test(rows[0]) && /₹999/.test(rows[1]), rows);
    const pdf = await page.evaluate(async () => {
      const txt = async inv => { const d = await buildInvoicePDF(inv); return d.output(); };
      const inv = await window.StayLogSync.invoices();
      return { tax: await txt(inv[0]), rec: await txt(inv[1]) }; });
    ok('a GST invoice prints as a TAX INVOICE: GSTINs, SAC, taxable value and GST', /TAX INVOICE/.test(pdf.tax) && /06ABCDE1234F1Z5/.test(pdf.tax)
      && /29ABCDE1234F1Z5/.test(pdf.tax) && /SAC 998314/.test(pdf.tax) && /GST @ 18%/.test(pdf.tax) && /Rs\. 1,000/.test(pdf.tax) && /Rs\. 180/.test(pdf.tax) && /Rs\. 1,180/.test(pdf.tax));
    ok('…one without GST prints as a RECEIPT saying no GST was charged', /RECEIPT/.test(pdf.rec) && !/TAX INVOICE/.test(pdf.rec) && /No GST was charged/.test(pdf.rec)
      && /Rs\. 999/.test(pdf.rec) && !/GSTIN/.test(pdf.rec));
    await ctx.close(); }
  { const { ctx, page } = await open({ plan: 'pro', bill: 'pending' });
    await account(page);
    await page.click('[data-billing-refresh]'); await page.waitForTimeout(400);
    ok('Check again reads the plan again', (await S(page, 'calls')).filter(c => c[0] === 'billing_state').length >= 2);
    await ctx.close(); }

  console.log('\n— a store build —');
  { const { ctx, page, errs } = await open({ plan: 'expired', bill: 'open', store: true });
    const b = await page.locator('[data-plan-banner]').innerText().catch(() => '');
    ok('the read-only banner in plain words, no "subscribe"', /This account is read-only. Your data is safe/.test(b) && !/subscri/i.test(b), b);
    const t = await account(page);
    const sheet = await page.locator('.modal, [data-modal], body').first().innerText();
    ok('Account settings: no price, no Subscribe, no Razorpay, no "paid plans", no GSTIN', await page.locator('[data-billing]').count() === 0
      && !/₹|subscri|razorpay|paid plans|GSTIN/i.test(t), t);
    ok('…nowhere on the page either', !/subscribe|razorpay|paid plans open/i.test(sheet), sheet.match(/.{0,60}(subscribe|razorpay|paid plans open).{0,60}/i));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({ plan: 'trial5', bill: 'open', store: true });
    await page.evaluate(() => { window.__server.plan = { ...window.__server.plan, days_left: 1 }; });
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(400); await page.evaluate(() => render());
    const b = await page.locator('[data-plan-banner]').innerText().catch(() => '');
    ok('the trial\'s last day: no "Subscribe" in a store build', /ends in 1 day/.test(b) && !/subscri/i.test(b), b);
    await ctx.close(); }

  console.log('\n— Raaya Vasyam —');
  { const { ctx, page } = await open({ plan: 'owner', bill: 'open' });
    const t = await account(page);
    ok('plan owner: no billing at all', await page.locator('[data-billing]').count() === 0 && !/Subscribe|₹/.test(t), t);
    await ctx.close(); }

  console.log('\n— the platform admin —');
  { const { ctx, page, errs, dialogs } = await open({ plan: 'owner', admin: true });
    await page.evaluate(() => setState({ modal: 'admin' })); await page.waitForTimeout(600);
    ok('sales and GST, and every plan with its price and Razorpay id', await page.locator('[data-admin-settings]').count() === 1
      && await page.locator('[data-admin-plan-save]').count() === 3);
    ok('repeat trials flagged, billing per account', /Repeat trial — first seen on Old Stay/.test(await page.locator('[data-admin-repeat="acct-1"]').innerText())
      && /bought pro monthly · 2 invoices, ₹2,179 paid/.test(await page.locator('[data-admin-billing="acct-2"]').innerText()));
    await page.check('[data-admin-plan-active="pro_monthly"]'); await page.click('[data-admin-plan-save="pro_monthly"]'); await page.waitForTimeout(300);
    ok('on sale without a price or plan id: caught, nothing sent', dialogs.some(d => /needs a price and its Razorpay plan id/.test(d))
      && !(await S(page, 'calls')).some(c => c[0] === 'admin_save_plan'));
    await page.fill('[data-admin-plan-amount="pro_monthly"]', '999'); await page.fill('[data-admin-plan-rzp="pro_monthly"]', 'plan_ABC');
    await page.check('[data-admin-plan-active="pro_monthly"]');
    await page.click('[data-admin-plan-save="pro_monthly"]'); await page.waitForTimeout(500);
    const sp = (await S(page, 'calls')).find(c => c[0] === 'admin_save_plan');
    ok('saved in paise through the audited function', sp && sp[1].p_id === 'pro_monthly' && sp[1].p_amount_paise === 99900 && sp[1].p_razorpay_plan_id === 'plan_ABC'
      && sp[1].p_active === true && sp[1].p_properties === 5, sp);
    await page.check('[data-admin-set-gst_enabled]'); await page.click('[data-admin-settings-save]'); await page.waitForTimeout(300);
    ok('GST without a GSTIN: caught, nothing sent', dialogs.some(d => /GST needs your GSTIN/.test(d)) && !(await S(page, 'calls')).some(c => c[0] === 'admin_save_settings'));
    await page.check('[data-admin-set-gst_enabled]');
    await page.fill('[data-admin-set-seller_gstin]', '06abcde1234f1z5'); await page.click('[data-admin-settings-save]'); await page.waitForTimeout(400);
    const ss = (await S(page, 'calls')).find(c => c[0] === 'admin_save_settings');
    ok('settings saved through the audited function', ss && ss[1].p.gst_enabled === true && ss[1].p.seller_gstin === '06ABCDE1234F1Z5' && ss[1].p.billing_open === true, ss);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
