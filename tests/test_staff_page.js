/* Phase 5: the staff page (staff.html, v64).
   - sign-in with the account code, username and password → the address made
     in the app; no code (or no match) → the login made before v64 still works
   - a wrong password and a network failure say different things
   - every name from the data: the business, her own, the owner's; none written in the page
   - more than one property: she picks where she works, remembered, and the
     mark carries it
   - times from her properties
   - the offline copy is per login: the next person never sees the last one's wages
   - an older database (no staff_profile) still works */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const srv = http.createServer((q, r) => { const p = path.join(ROOT, (q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'text/plain' }); r.end(fs.readFileSync(p)); }).listen(0);

const STANDING = { name: 'Lakshmi', attendance: { today: '2026-11-15', marked: false, this_month: 3, can_undo: false },
  utensils: { available: false, marked: false, can_undo: false, locked: false },
  pending: { amount: 500, count: 1, oldest: '2026-11-14', earlier: 0, days: [{ date: '2026-11-14', gross: 500, deducted: 0, net: 500, kind: 'wage' }] },
  this_month: { amount: 1500, deducted: 0 }, overall: { paid: 4000, deducted: 0 }, last_payout: null, loans: [] };
const PROFILE = { name: 'Lakshmi', business: 'Raaya Vasyam', owner: 'Rakshit',
  properties: [{ id: 'p1', name: 'Raaya Vasyam', checkin: '1:00 PM', checkout: '11:00 AM' }, { id: 'p2', name: 'Sea View Cottage', checkin: '2:30 PM', checkout: '10:00 AM' }] };
// Auth: who signs in with what. Network failures on demand.
const STUB = (o) => `(function(){window.__calls=[];window.__tries=[];
  window.__o=${JSON.stringify(o)};
  const users={'laxmi.raaya@staff.staylog.invalid':['pass-new-1','u-new'],'laxmi@staff.raayavasyam.invalid':['pass-old-1','u-old'],'ravi.raaya@staff.staylog.invalid':['pass-ravi-1','u-ravi']};
  let session=window.__o.session?{user:{id:window.__o.session}}:null;
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session}}),signOut:async()=>{session=null;return{error:null};},
      signInWithPassword:async({email,password})=>{window.__tries.push(email);
        if(window.__o.offline)throw new TypeError('Failed to fetch');
        const u=users[email];if(!u||u[0]!==password)return{data:{},error:{message:'Invalid login credentials'}};
        session={user:{id:u[1]}};return{data:{session},error:null};},
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    rpc:async(n,args)=>{window.__calls.push([n,args||null]);
      if(n==='staff_calendar')return{data:[],error:null};
      if(n==='staff_standing')return{data:window.__o.standing,error:null};
      if(n==='staff_paused')return window.__o.paused===undefined?{data:null,error:{message:'function public.staff_paused() does not exist'}}:{data:window.__o.paused,error:null};
      if((n==='staff_mark_today'||n==='staff_mark_today_at')&&window.__o.paused)return{data:{ok:false,reason:'paused',message:"Paused by your employer's account."},error:null};
      if(n==='staff_notice')return window.__o.notice?{data:window.__o.notice,error:null}:{data:null,error:{message:'function public.staff_notice() does not exist'}};
      if(n==='staff_ack_notice'){window.__o.notice={...window.__o.notice,acknowledged:true};return{data:{ok:args.p_version===window.__o.notice.version,version:window.__o.notice.version},error:null};}
      if(n==='staff_profile')return window.__o.noProfile?{data:null,error:{message:'function public.staff_profile() does not exist'}}:{data:window.__o.profile,error:null};
      return{data:{ok:true},error:null};}})};})();`;

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  const open = async (o = {}, ctx0) => {
    const ctx = ctx0 || await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    for (const g of ['**fonts.googleapis.com**', '**cdn.jsdelivr.net**']) await ctx.route(g, r => r.abort());
    await ctx.unroute('**vendor/supabase.umd.js').catch(() => {});
    await ctx.route('**vendor/supabase.umd.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB({ standing: STANDING, profile: PROFILE, ...o }) }));
    const page = await ctx.newPage(); const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    await page.goto(base + '/staff.html'); await page.waitForTimeout(500);
    if (process.env.DEBUG) console.log(errs, (await page.locator('body').innerText()).slice(0, 200));
    return { ctx, page, errs, dialogs };
  };
  const signIn = async (page, code, user, pass) => {
    await page.fill('[data-code]', code); await page.fill('[data-user]', user); await page.fill('[data-pass]', pass);
    await page.click('button:has-text("Sign in")'); await page.waitForTimeout(500);
  };

  console.log('\n— nothing written in the page —');
  { const src = fs.readFileSync(path.join(ROOT, 'staff.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'staff.html'), 'utf8');
    ok('no business, owner or staff name in staff.js / staff.html', !/Raaya|Rakshit|Laxmi|Lakshmi/.test(src), (src.match(/Raaya|Rakshit|Laxmi|Lakshmi/g) || []));
    ok('the page version moved', /PAGE_VERSION = 'v15/.test(src)); }

  console.log('\n— signing in —');
  { const { ctx, page, errs } = await open();
    await signIn(page, 'RAAYA', 'Laxmi', 'pass-new-1');
    ok('code + username → <username>.<code>@staff.staylog.invalid', await page.evaluate(() => window.__tries[0]) === 'laxmi.raaya@staff.staylog.invalid');
    ok('signed in, the business named from the data', /Raaya Vasyam/.test(await page.locator('[data-business]').innerText()));
    ok('the code is remembered for next time', await page.evaluate(() => localStorage.getItem('staylog_staff_code')) === 'raaya');
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open();
    await signIn(page, '', 'laxmi', 'pass-old-1');
    ok('no code: the login made before v64 still works', await page.evaluate(() => window.__tries.join()) === 'laxmi@staff.raayavasyam.invalid'
      && await page.locator('[data-business]').count() === 1);
    await ctx.close(); }
  { const { ctx, page } = await open();
    await signIn(page, 'raaya', 'laxmi', 'pass-old-1');
    ok('a code typed for an old login: it tries the old address too', await page.evaluate(() => window.__tries.join()) === 'laxmi.raaya@staff.staylog.invalid,laxmi@staff.raayavasyam.invalid'
      && await page.locator('[data-business]').count() === 1);
    await ctx.close(); }
  { const { ctx, page } = await open();
    await signIn(page, 'raaya', 'laxmi', 'wrong-pass');
    ok('a wrong password says so', /did not match/.test(await page.locator('[data-login-msg]').innerText()));
    await ctx.close(); }
  { const { ctx, page } = await open({ offline: true });
    await signIn(page, 'raaya', 'laxmi', 'pass-new-1');
    ok('no internet says that instead — not a wrong password', /Could not reach the internet/.test(await page.locator('[data-login-msg]').innerText())
      && !/did not match/.test(await page.locator('[data-login-msg]').innerText()));
    await ctx.close(); }

  console.log('\n— names and times from the data —');
  { const { ctx, page, dialogs } = await open({ session: 'u-new' });
    await page.waitForTimeout(300);
    const t = await page.locator('body').innerText();
    ok('header: business; her name · "Your schedule, wages and loan"', /Raaya Vasyam/.test(t) && /Lakshmi · Your schedule, wages and loan/.test(t), t.slice(0, 200));
    ok('her two properties\' times, each its own', /Raaya Vasyam: in from 1:00 PM, out by 11:00 AM\. Sea View Cottage: in from 2:30 PM, out by 10:00 AM\./.test(await page.locator('[data-times]').innerText()));
    ok('the page title is the business', await page.title() === 'Raaya Vasyam — Staff');

    console.log('\n— where she works today —');
    ok('two properties: she picks one', await page.locator('[data-prop-pick]').count() === 1);
    await page.click('button:has-text("I came in today")'); await page.waitForTimeout(300);
    ok('not picked yet: asked to choose, nothing sent', dialogs.some(d => /Choose where you are working today/.test(d))
      && !(await page.evaluate(() => window.__calls.some(c => /mark/.test(c[0])))));
    await page.selectOption('[data-prop-pick]', 'p2');
    await page.click('button:has-text("I came in today")'); await page.waitForTimeout(400);
    ok('the mark carries the property', await page.evaluate(() => JSON.stringify(window.__calls.find(c => c[0] === 'staff_mark_today_at'))) === JSON.stringify(['staff_mark_today_at', { p_property: 'p2' }]));
    ok('the choice is remembered', await page.evaluate(() => localStorage.getItem('staylog_staff_prop')) === 'p2');
    await ctx.close(); }
  { const { ctx, page } = await open({ session: 'u-ravi', profile: { ...PROFILE, name: 'Ravi', properties: [PROFILE.properties[1]] } });
    await page.waitForTimeout(300);
    ok('one property: no picking; times from it', await page.locator('[data-prop-pick]').count() === 0
      && /Guests arrive from 2:30 PM and leave by 10:00 AM\./.test(await page.locator('[data-times]').innerText()));
    await page.click('button:has-text("I came in today")'); await page.waitForTimeout(300);
    ok('…and the plain mark', await page.evaluate(() => window.__calls.some(c => c[0] === 'staff_mark_today')));
    await ctx.close(); }

  console.log('\n— the offline copy is per login —');
  { const ctx = await br.newContext({ serviceWorkers: 'block' });
    let { page } = await open({ session: 'u-new' }, ctx);
    await page.waitForTimeout(300);
    ok('saved under her own login', await page.evaluate(() => !!localStorage.getItem('staylog_staff_cache:u-new') && !localStorage.getItem('rv_staff_cache')));
    await page.evaluate(() => { localStorage.setItem('rv_staff_cache', '{"standing":{"name":"old"}}'); });
    await page.close();
    ({ page } = await open({ session: 'u-ravi', standing: null, profile: null }, ctx));
    const t = await page.locator('body').innerText();
    ok('another login on the same phone never sees her wages', !/₹1,500|₹4,000|Lakshmi/.test(t), t.slice(0, 300));
    ok('the old shared copy is gone', await page.evaluate(() => localStorage.getItem('rv_staff_cache')) === null);
    await ctx.close(); }

  console.log('\n— an older database —');
  { const { ctx, page, errs } = await open({ session: 'u-new', noProfile: true });
    await page.waitForTimeout(300);
    const t = await page.locator('body').innerText();
    ok('no staff_profile yet: the page still works, in plain words', /I came in today/.test(t) && /Your workplace/.test(t) && errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— the one-time notice (v13) —');
  { const { ctx, page, errs } = await open({ session: 'u-new', notice: { version: '2026-11-21', acknowledged: false } });
    await page.waitForTimeout(300);
    const t = await page.locator('[data-staff-notice]').innerText().catch(() => '');
    ok('first sign-in: the notice comes before her page, naming the business and the owner', /Before you start/.test(t) && /Raaya Vasyam/.test(t)
      && /Rakshit and the managers Rakshit allows to manage staff/.test(t) && await page.locator('[data-attendance], [data-wage]').count() === 0, t.slice(0, 300));
    ok('…it says what is kept: attendance, wages, loan', /I came in today/.test(t) && /wages/.test(t) && /loan/i.test(t));
    await page.click('[data-staff-notice-ok]'); await page.waitForTimeout(300);
    const calls = await page.evaluate(() => window.__calls.filter(c => c[0] === 'staff_ack_notice'));
    ok('I understand: her acknowledgement of this version is recorded', calls.length === 1 && calls[0][1].p_version === '2026-11-21', calls);
    ok('…and her page shows', await page.locator('[data-staff-notice]').count() === 0 && /I came in today/.test(await page.locator('body').innerText()));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({ session: 'u-new', notice: { version: '2026-11-21', acknowledged: true } });
    await page.waitForTimeout(300);
    ok('already acknowledged (as the server says): not shown again', await page.locator('[data-staff-notice]').count() === 0);
    await ctx.close(); }
  { const { ctx, page } = await open({ session: 'u-new' });
    await page.waitForTimeout(300);
    ok('before 11-legal.sql (no notice function): no notice, the page works', await page.locator('[data-staff-notice]').count() === 0
      && /I came in today/.test(await page.locator('body').innerText()));
    await ctx.close(); }

  console.log('\n— her employer\'s account is read-only (v14) —');
  { const { ctx, page, errs, dialogs } = await open({ session: 'u-new', paused: true });
    await page.waitForTimeout(300);
    const t = await page.locator('[data-paused]').innerText().catch(() => '');
    ok('"Paused by your employer\'s account", and she still sees her days, wages and loan', /Paused by your employer/.test(t) && /still see your days, wages and loan/.test(t), t);
    ok('"I came in today" is off', await page.locator('button:has-text("I came in today")').isDisabled());
    await page.evaluate(() => { lsSet(PROP_KEY, myProps()[0].id); return markToday(true); }); await page.waitForTimeout(300);
    ok('…and if it is tried anyway, the server\'s refusal is said in the same words', dialogs.some(d => /Paused by your employer/.test(d)), dialogs);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({ session: 'u-new', paused: false });
    await page.waitForTimeout(300);
    ok('not paused: no notice, marking on', await page.locator('[data-paused]').count() === 0 && !(await page.locator('button:has-text("I came in today")').isDisabled()));
    await ctx.close(); }

  console.log('\n— her paydays (v76) —');
  { const paid = { ...STANDING, pending: { amount: 0, count: 0, oldest: null, earlier: 0, days: [] },
      last_payout: { date: '2026-11-20', amount: 1500, deducted: 100 }, paid_undated: 2,
      paydays: [{ date: '2026-11-20', days: 3, received: 1500, deducted: 100 }, { date: '2026-11-10', days: 1, received: 500, deducted: 0 }] };
    const { ctx, page, errs } = await open({ session: 'u-new', standing: paid });
    await page.waitForTimeout(300);
    const card = await page.locator('[data-paydays]').innerText().catch(() => '');
    const rows = await page.locator('[data-payday]').evaluateAll(els => els.map(e => e.getAttribute('data-payday')));
    ok('a "Paid" section: each payday, newest first', /^Paid/i.test(card) && rows.join() === '2026-11-20,2026-11-10', { card, rows });
    ok('…with the day, how many days, what she received and the loan taken', /20 Nov 2026/.test(card) && /3 days/.test(card) && /₹1,500/.test(card)
      && /₹100 to loan/.test(card) && /1 day\b/.test(card) && await page.locator('[data-payday="2026-11-10"] [data-payday-loan]').count() === 0, card);
    ok('…and says earlier pay was recorded without the day', /recorded without the day it was paid/.test(card));
    ok('"Last paid" is the day she was paid', /Last paid 20 Nov 2026/.test(await page.locator('body').innerText()));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const old = { ...STANDING, pending: { amount: 0, count: 0, oldest: null, earlier: 0, days: [] }, last_payout: null, paid_undated: 3, paydays: [] };
    const { ctx, page } = await open({ session: 'u-new', standing: old });
    await page.waitForTimeout(300);
    ok('paid only before paydays were recorded: "Paid · date not recorded", no Paid section', /Paid · date not recorded/.test(await page.locator('body').innerText())
      && await page.locator('[data-paydays]').count() === 0);
    await ctx.close(); }
  { const { ctx, page } = await open({ session: 'u-new' });
    await page.waitForTimeout(300);
    ok('an older database (no paydays sent): no Paid section, the page works', await page.locator('[data-paydays]').count() === 0
      && /I came in today/.test(await page.locator('body').innerText()));
    await ctx.close(); }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
