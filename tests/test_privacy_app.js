/* Stage 4 of billing and data protection in the app (v77): less kept, a
   log of what happens, support only when the owner allows it.
   - Aadhaar: the form asks for the last 4 digits; an old full number opens
     and saves as "XXXX XXXX 1234"; a pasted one keeps its last 4; 12 digits
     under another type are shortened; a passport is kept
   - notes: a hint, and a 12-digit number there is not saved
   - Account settings: Support access (allow 7 days, stop), past support
     reads, the activity log in words — drawn in place
   - Export everything is logged with counts only
   - the admin's Support access block: only accounts that allowed it,
     through support_read
   - sync.js: an app older than min_version neither pulls nor sends */
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
    invokeAnswer:${JSON.stringify(o.invokeAnswer || null)},froms:[],minVersion:${o.minVersion || 62},
    support:${JSON.stringify(o.support || { live: null, reads: [] })},activity:${JSON.stringify(o.activity || [])},
    supportAccounts:${JSON.stringify(o.supportAccounts || [])},
    session:{user:{id:'u1',email:'me@example.com'},access_token:'t'},
    settings:{name:'Sea Breeze',code:'seabreeze',time_zone:'Asia/Kolkata',currency:'INR',pays_directly_sources:['Direct','Booking.com'],owner_name:'Asha',migrated_from:${o.plan === 'owner' ? "'old'" : 'null'}},
    accounts:[{id:'acct-1',name:'Sea Breeze',code:'seabreeze',plan:'trial',status:'trialing',can_write:true,trial_ends_at:'2026-11-28T00:00:00Z',properties:2,properties_allowed:5,owner:'Asha',last_activity:'2026-11-20T00:00:00Z'},
      {id:'acct-2',name:'Hill View',code:'hill',plan:'pro',status:'active',can_write:true,properties:1,properties_allowed:5,owner:'Ravi',last_activity:'2026-11-20T00:00:00Z'},
      {id:'acct-rv',name:'Raaya Vasyam',code:'raaya',plan:'owner',status:'active',can_write:true,properties:1,properties_allowed:null,owner:'Rakshit',last_activity:'2026-11-21T00:00:00Z'}]};
  const access=()=>({role:'owner',permissions:{edit_bookings:true,send_messages:true,mark_paid:true,see_money:true,add_expenses:true,manage_staff:true,edit_properties:true},properties:null});
  function q(table){const st={op:'select'};
    const api={select(){return api;},eq(){return api;},in(){return api;},is(){return api;},gt(){return api;},order(){return api;},range(){return api;},not(){return api;},gte(){return api;},limit(){return api;},
      update(v){st.op='update';st.v=v;return api;},insert(){st.op='insert';return api;},delete(){st.op='delete';return api;},upsert(){st.op='upsert';return api;},
      then(res,rej){let data=[],error=null;S.froms.push(table+':'+st.op);
        if(table==='app_status')data=[{id:1,min_version:S.minVersion,model:'stay'}];
        else if(table==='audit_log')data=S.activity;
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
      if(n==='support_state')return{data:S.support,error:null};
      if(n==='grant_support'){S.support={live:{granted_at:new Date().toISOString(),expires_at:new Date(Date.now()+7*864e5).toISOString(),note:null},reads:S.support.reads};return{data:S.support,error:null};}
      if(n==='revoke_support'){S.support={live:null,reads:S.support.reads};return{data:S.support,error:null};}
      if(n==='log_event')return{data:null,error:null};
      if(n==='support_accounts')return{data:S.supportAccounts,error:null};
      if(n==='support_read')return{data:[{account_id:'acct-2',id:'b9',guest_name:'Visible Guest'}],error:null};
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

  const calls = async (page, n) => (await S(page, 'calls')).filter(c => c[0] === n);
  const bookingForm = async (page, id) => { await page.evaluate(id => setState({ modal: 'addBooking', editItem: id ? state.data.bookings.find(b => b.id === id) : null }), id);
    await page.waitForTimeout(250); };
  const saveBooking = page => page.click('button:has-text("Update Booking"), button:has-text("Add Booking")');
  const bk = (page, id) => page.evaluate(id => JSON.parse(JSON.stringify(state.data.bookings.find(b => b.id === id))), id);

  console.log('\n— Aadhaar: the last 4 digits only —');
  { const { ctx, page, errs, dialogs } = await open({ plan: 'owner', bill: 'open' });
    await page.evaluate(() => { state.data.bookings[0].idProofType = 'Aadhaar'; state.data.bookings[0].idProofNumber = '1234 5678 9012'; render(); });
    await bookingForm(page, 'b1');
    ok('an old full number opens as its last 4 digits', await page.locator('[data-id-number]').inputValue() === '9012'
      && await page.locator('[data-id-number]').getAttribute('placeholder') === 'Last 4 digits');
    ok('the form says only the last 4 are kept', /only the last 4 digits are kept/.test(await page.locator('[data-aadhaar-hint]').innerText()));
    await saveBooking(page); await page.waitForTimeout(300);
    ok('saved, it is kept as XXXX XXXX 9012', (await bk(page, 'b1')).idProofNumber === 'XXXX XXXX 9012', await bk(page, 'b1'));
    await bookingForm(page, 'b2');
    await page.selectOption('.modal select >> nth=-1', 'Aadhaar').catch(() => {});
    await page.evaluate(() => { const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'Aadhaar'));
      s.value = 'Aadhaar'; s.dispatchEvent(new Event('change')); });
    await page.locator('[data-id-number]').fill('4321 8765 2109');
    ok('a full number pasted: only its last 4 digits stay in the box', await page.locator('[data-id-number]').inputValue() === '2109');
    await saveBooking(page); await page.waitForTimeout(300);
    ok('…and that is what is saved', (await bk(page, 'b2')).idProofNumber === 'XXXX XXXX 2109');
    await bookingForm(page, 'b2');
    await page.locator('[data-id-number]').fill('21');
    await saveBooking(page); await page.waitForTimeout(200);
    ok('fewer than 4 digits: asked for all 4, nothing saved', dialogs.some(d => /Type the last 4 digits of the Aadhaar/.test(d)) && (await bk(page, 'b2')).idProofNumber === 'XXXX XXXX 2109');
    await page.evaluate(() => closeModal());
    await page.evaluate(() => { const b = state.data.bookings[1]; b.idProofType = 'Other'; b.idProofNumber = '5555 6666 7777'; render(); });
    await bookingForm(page, 'b2'); await saveBooking(page); await page.waitForTimeout(300);
    ok('12 digits under another type are shortened too', (await bk(page, 'b2')).idProofNumber === 'XXXX XXXX 7777');
    await page.evaluate(() => { const b = state.data.bookings[1]; b.idProofType = 'Passport'; b.idProofNumber = 'Z1234567'; render(); });
    await bookingForm(page, 'b2'); await saveBooking(page); await page.waitForTimeout(300);
    ok('a passport number is kept as typed', (await bk(page, 'b2')).idProofNumber === 'Z1234567');

    console.log('\n— notes —');
    await bookingForm(page, 'b2');
    ok('the notes say not to type ID numbers there', /Don’t type ID numbers in the notes/.test(await page.locator('[data-notes-hint]').innerText()));
    await page.locator('[data-booking-notes]').fill('Aadhaar 1234 5678 9012 seen at check-in');
    await saveBooking(page); await page.waitForTimeout(200);
    ok('a 12-digit number in the notes: said, nothing saved', dialogs.some(d => /notes look like they hold a 12-digit ID number/.test(d))
      && !/1234 5678 9012/.test((await bk(page, 'b2')).notes || ''));
    await page.locator('[data-booking-notes]').fill('Late arrival, room 2');
    await saveBooking(page); await page.waitForTimeout(300);
    ok('ordinary notes save', (await bk(page, 'b2')).notes === 'Late arrival, room 2');
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— support access and the activity log —');
  { const act = [{ at: new Date().toISOString(), action: 'members.insert', detail: {} }, { at: new Date().toISOString(), action: 'support_read', target: 'bookings', detail: { rows: 4 } },
      { at: new Date().toISOString(), action: 'auth.login', detail: {} }];
    const { ctx, page, errs, dialogs } = await open({ plan: 'trial5', bill: 'open', activity: act });
    await page.evaluate(() => setState({ modal: 'account' })); await page.waitForTimeout(500);
    const t = await page.locator('[data-privacy]').innerText();
    ok('Account settings: support cannot see your records unless you allow it', /cannot see your bookings, guests, staff or money/.test(t), t);
    ok('the activity log, in words', /Team member added/.test(t) && /Support read your records/.test(t) && /auth login/.test(t), t);
    await page.click('[data-support-allow]'); await page.waitForTimeout(400);
    ok('Allow asks first, saying what is hidden', dialogs.some(d => /for 7 days\? Wi-Fi passwords, bank and UPI details and calendar links stay hidden/.test(d)));
    ok('…then grant_support for 7 days', (await calls(page, 'grant_support')).some(c => c[1].p_days === 7 && c[1].p_account === 'acct-1'));
    ok('…and says until when', /StayLog support can read this account’s records until/.test(await page.locator('[data-support-live]').innerText()));
    ok('the sheet\'s own fields were not redrawn', await page.locator('[data-account-name]').count() === 1);
    await page.click('[data-support-stop]'); await page.waitForTimeout(400);
    ok('Stop: revoke_support, and Allow is offered again', (await calls(page, 'revoke_support')).length === 1 && await page.locator('[data-support-allow]').count() === 1);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({ plan: 'trial5', bill: 'open', support: { live: null, reads: [{ at: new Date().toISOString(), table: 'bookings', rows: 4 }] } });
    await page.evaluate(() => setState({ modal: 'account' })); await page.waitForTimeout(500);
    ok('past support reads are listed for the owner', /Support read: bookings \(4 rows/.test(await page.locator('[data-support-reads]').innerText()));
    await ctx.close(); }

  console.log('\n— exports are logged —');
  { const { ctx, page } = await open({ plan: 'trial5', bill: 'open' });
    await page.evaluate(() => { window.__realShare = navigator.share; navigator.canShare = () => false; HTMLAnchorElement.prototype.click = function () {}; });
    await page.evaluate(() => setState({ modal: 'exportAll' })); await page.waitForTimeout(200);
    await page.fill('[data-export-pin]', '1234'); await page.click('[data-export-go]'); await page.waitForTimeout(600);
    const le = await calls(page, 'log_event');
    ok('Export everything: log_event with counts, never names', le.length === 1 && le[0][1].p_action === 'export_everything' && le[0][1].p_detail.bookings === 2
      && !JSON.stringify(le[0][1]).includes('Anita'), le);
    await ctx.close(); }

  console.log('\n— the platform admin —');
  { const { ctx, page, errs } = await open({ plan: 'owner', admin: true });
    await page.evaluate(() => setState({ modal: 'admin' })); await page.waitForTimeout(600);
    ok('no account has allowed support: says the admin cannot read', /cannot read an owner’s records until they allow it/.test(await page.locator('[data-admin-support]').innerText()));
    await ctx.close(); }
  { const { ctx, page, errs } = await open({ plan: 'owner', admin: true, supportAccounts: [{ account: 'acct-2', name: 'Hill View', expires_at: new Date(Date.now() + 3 * 864e5).toISOString() }] });
    await page.evaluate(() => setState({ modal: 'admin' })); await page.waitForTimeout(600);
    await page.click('[data-admin-support-read="acct-2"]'); await page.waitForTimeout(400);
    const sr = await calls(page, 'support_read');
    ok('an account that allowed it: read through support_read', sr.length === 1 && sr[0][1].p_account === 'acct-2' && sr[0][1].p_table === 'bookings', sr);
    ok('…the rows shown', /1 row of bookings/.test(await page.locator('[data-admin-support-rows]').innerText()) && /Visible Guest/.test(await page.locator('[data-admin-support-rows]').innerText()));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— an app older than min_version stops syncing (v77) —');
  { const { ctx, page } = await open({ plan: 'owner', minVersion: 999 });
    await page.evaluate(() => { window.__server.froms = []; window.__server.calls = []; });
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(500);
    const froms = await S(page, 'froms'), cs = await S(page, 'calls');
    ok('nothing pulled (no table but app_status read) and nothing sent', froms.every(f => f.startsWith('app_status')) && !cs.some(c => c[0] === 'apply_change'), { froms, cs });
    ok('…and the app says to close and reopen', /close and reopen/i.test(await page.locator('[data-retired]').innerText().catch(() => '')));
    await ctx.close(); }
  { const { ctx, page } = await open({ plan: 'owner', minVersion: 62 });
    await page.evaluate(() => { window.__server.froms = []; });
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(500);
    ok('a current app syncs as before', (await S(page, 'froms')).some(f => f.startsWith('bookings')));
    await ctx.close(); }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
