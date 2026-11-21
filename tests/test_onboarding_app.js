/* Phase 9 in the app (v71): onboarding new accounts.
   - ⋯ → Account settings (owner, new model): name, your name, the code (shown,
     not editable), time zone, currency, who pays directly → saved to the
     account; the app's money follows the currency and the who-pays rule
   - ⋯ → Invite a new owner (a platform admin only): a link (#start=…), the
     invites with Share / Withdraw
   - #start=<code>: after unlocking, the Start sheet; the account code is
     suggested from the business name; Open my account makes the login and
     opens the account through the team-invite function, then signs in
   - the first-run guide on Home: for a new account's owner only (never one
     moved in from the old app, never a manager), ticks worked out from the
     data, and it can be hidden
   - a manager sees neither settings nor invites */
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
const START = 'startstartstartstartstart';

const STUB = (o) => `(function(){
  const S=window.__server={role:'${o.role}',admin:${!!o.admin},writes:[],invoked:[],
    session:${o.role === 'none' ? 'null' : "{user:{id:'u1',email:'me@example.com'},access_token:'t'}"},model:'stay',signedInAs:null,
    settings:{name:'${o.name || 'Raaya Vasyam'}',code:'${o.code || 'raaya'}',time_zone:'Asia/Kolkata',currency:'INR',pays_directly_sources:['Direct','Booking.com'],owner_name:'Rakshit',
      migrated_from:${o.migrated === false ? 'null' : "'old-owner'"}},
    legalPending:${o.legal ? "[{document:'privacy',version:'2026-11-21'},{document:'terms',version:'2026-11-21'}]" : '[]'},
    pinv:[{code:'waiting-invite-0000000001',label:'Asha, Goa',created_at:'2026-11-15T10:00:00Z',expires_at:'2026-11-29T00:00:00Z',used_by:null}]};
  const access=()=>S.role==='owner'?{role:'owner',permissions:{edit_bookings:true,send_messages:true,mark_paid:true,see_money:true,add_expenses:true,manage_staff:true,edit_properties:true},properties:null}
    :{role:'manager',permissions:{edit_bookings:true,send_messages:true,mark_paid:true,see_money:false,add_expenses:true,manage_staff:false,edit_properties:false},properties:['p1']};
  function q(table){const st={f:[],op:'select',val:null};
    const api={select(){return api;},eq(k,v){st.f.push([k,v]);return api;},in(){return api;},is(){return api;},gt(){return api;},order(){return api;},range(){return api;},not(){return api;},gte(){return api;},limit(){return api;},
      update(v){st.op='update';st.val=v;return api;},insert(v){st.op='insert';st.val=v;return api;},delete(){st.op='delete';return api;},upsert(v){st.op='upsert';st.val=v;return api;},
      then(res,rej){let data=[];
        if(st.op!=='select')S.writes.push([table,st.op,st.val,st.f]);
        if(table==='app_status')data=[{id:1,min_version:62,model:S.model}];
        else if(table==='members'&&st.op==='select')data=[{account_id:'acct-1',role:S.role,active:true,accounts:{name:S.settings.name,code:S.settings.code}}];
        else if(table==='accounts'){if(st.op==='update')Object.assign(S.settings,st.val);data=[JSON.parse(JSON.stringify(S.settings))];}
        else if(table==='platform_invites'){if(st.op==='insert')S.pinv.unshift({...st.val,created_at:new Date().toISOString(),expires_at:'2026-11-30T00:00:00Z',used_by:null});
          if(st.op==='update')S.pinv.forEach(i=>{if(st.f.some(([k,v])=>k==='code'&&v===i.code))Object.assign(i,st.val);});
          data=S.pinv.map(x=>({...x}));}
        return Promise.resolve({data,error:null}).then(res,rej);}};
    return api;}
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:S.session}}),signOut:async()=>({error:null}),
      signInWithPassword:async({email,password})=>{S.signedInAs=email;S.session={user:{id:'u-new',email},access_token:'t2'};return{data:{session:S.session},error:null};},
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    functions:{async invoke(name,{body}){S.invoked.push([name,body]);
      if(name==='team-invite'&&body.action==='owner-peek')return{data:{ok:true,label:'Asha, Goa',expires_at:'2026-11-29T00:00:00Z'},error:null};
      if(name==='team-invite'&&body.action==='owner-accept'){S.role='owner';S.settings={...S.settings,name:body.business,code:body.account_code,migrated_from:null};
        return{data:{ok:true,account:'acct-1',business:body.business,code:body.account_code},error:null};}
      return{data:{},error:null};}},
    from:t=>q(t), rpc:async()=>({data:null,error:null}),
    schema:()=>({from:t=>q(t),async rpc(n,a){
      if(n==='my_access')return{data:access(),error:null};
      if(n==='am_platform_admin')return{data:S.admin,error:null};
      if(n==='legal_pending')return{data:S.legalPending,error:null};
      if(n==='accept_legal'){S.accepted=(S.accepted||[]).concat(a.p_documents);S.legalPending=[];return{data:[],error:null};}
      if(n==='apply_change')return{data:{status:'ok',row:{...a.p_row,version:1,updated_at:new Date().toISOString(),deleted_at:null,legacy:null}},error:null};
      return{data:null,error:null};}}),
  })};})();`;

const RV = { properties: [{ id: 'p1', name: 'Raaya Vasyam' }], staff: [], loans: [], expenses: [], attendance: [],
  bookings: [{ id: 'bb', propertyId: 'p1', guestName: 'Kiran', checkIn: D(1), checkOut: D(3), guests: 2, totalAmount: 6000, paid: 1000, source: 'Booking.com', status: 'confirmed', msgSent: {} },
    { id: 'ab', propertyId: 'p1', guestName: 'Ana', checkIn: D(5), checkOut: D(7), guests: 2, totalAmount: 9000, paid: 0, source: 'Airbnb', status: 'confirmed', msgSent: {} }] };
const EMPTY = { properties: [], staff: [], loans: [], expenses: [], attendance: [], bookings: [] };

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  const open = async (o) => {
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    for (const g of ['**fonts.googleapis.com**', '**cdn.jsdelivr.net**']) await ctx.route(g, r => r.abort());
    await ctx.route('**vendor/supabase.umd.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB(o) }));
    const page = await ctx.newPage(); const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    await page.addInitScript(([s, stay]) => {
      if (sessionStorage.getItem('__s')) return; sessionStorage.setItem('__s', '1');
      try { navigator.share = undefined; } catch (e) {}
      if (stay) {
        localStorage.setItem('staylog_model', JSON.stringify({ mode: 'stay', user: 'u1', account: 'acct-1' }));
        const r = indexedDB.open('staylog_db', 1);
        r.onupgradeneeded = e => e.target.result.createObjectStore('appdata');
        r.onsuccess = e => e.target.result.transaction('appdata', 'readwrite').objectStore('appdata').put(s, 'staylog_stay_data:u1:acct-1');
      }
    }, [o.data || RV, o.role !== 'none']);
    await page.goto(base + '/index.html' + (o.hash || ''));
    await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    if (o.role !== 'none') { await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading); }
    await page.evaluate(() => { state.loggedIn = true; render(); });
    await page.waitForTimeout(400);
    if (o.role !== 'none') { await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(400); await page.evaluate(() => render()); }
    return { ctx, page, errs, dialogs };
  };
  const menuText = page => page.evaluate(() => { state.modal = 'menu'; render(); return document.body.innerText; });

  console.log('\n— Account settings —');
  { const { ctx, page, errs } = await open({ role: 'owner', admin: true });
    ok('⋯ offers Account settings and (a platform admin) Invite a new owner', /Account settings/.test(await menuText(page)) && /Invite a new owner/.test(await menuText(page)));
    ok('the moved-in account shows no first-run guide', await page.evaluate(() => { closeModal(); return !document.querySelector('[data-guide]'); }));
    ok('rupees and the old who-pays rule to begin with', await page.evaluate(() => fmtCur(1234.5) === '₹1,234.50'
      && paysUsDirectly(state.data.bookings.find(b => b.id === 'bb')) && !paysUsDirectly(state.data.bookings.find(b => b.id === 'ab'))));
    await page.evaluate(() => setState({ modal: 'account' })); await page.waitForTimeout(200);
    ok('the form shows the account: name, the code (not a field), time zone, currency, who pays', await page.evaluate(() =>
      document.querySelector('[data-account-name]').value === 'Raaya Vasyam' && document.querySelector('[data-account-code]').textContent === 'raaya'
      && !document.querySelector('input[data-account-code]') && document.querySelector('[data-account-tz]').value === 'Asia/Kolkata'
      && document.querySelector('[data-account-currency]').value === 'INR' && document.querySelector('[data-account-source="Booking.com"]').checked
      && !document.querySelector('[data-account-source="Airbnb"]').checked));
    await page.evaluate(() => {
      document.querySelector('[data-account-name]').value = 'Raaya Vasyam Homestay';
      document.querySelector('[data-account-currency]').value = 'USD';
      document.querySelector('[data-account-source="Booking.com"]').checked = false;
      document.querySelector('[data-account-source="Airbnb"]').checked = true; });
    await page.click('[data-account-save]'); await page.waitForTimeout(400);
    const w = await page.evaluate(() => window.__server.writes.filter(x => x[0] === 'accounts'));
    ok('saved to the account: only the settings, the code never sent', w.length === 1 && w[0][1] === 'update' && w[0][2].name === 'Raaya Vasyam Homestay'
      && w[0][2].currency === 'USD' && w[0][2].pays_directly_sources.join() === 'Direct,Airbnb' && !('code' in w[0][2]), w);
    ok('the app follows: dollars, and Airbnb now pays directly, Booking.com not', await page.evaluate(() => fmtCur(1234.5) === '$1,234.50'
      && !paysUsDirectly(state.data.bookings.find(b => b.id === 'bb')) && paysUsDirectly(state.data.bookings.find(b => b.id === 'ab'))
      && canReceipt(state.data.bookings.find(b => b.id === 'ab'))), await page.evaluate(() => fmtCur(1234.5)));
    ok('forms label money in the currency too', await page.evaluate(() => { setState({ modal: 'addStaff', editItem: null }); return /Daily wage \(\$\)/.test(document.body.innerHTML); }));
    await page.evaluate(() => setState({ modal: 'account' })); await page.waitForTimeout(150);
    await page.evaluate(() => { document.querySelectorAll('[data-account-source]').forEach(b => { b.checked = false; }); });
    await page.click('[data-account-save]'); await page.waitForTimeout(200);
    ok('nobody paying directly: refused before saving', /Tick at least one/.test(await page.locator('[data-account]').innerText())
      && (await page.evaluate(() => window.__server.writes.filter(x => x[0] === 'accounts').length)) === 1);

    console.log('\n— Invite a new owner —');
    await page.evaluate(() => setState({ modal: 'owners' })); await page.waitForTimeout(300);
    ok('the invites: waiting, with Share and Withdraw', await page.locator('[data-owner-invite="waiting-invite-0000000001"]').count() === 1
      && await page.locator('[data-owner-withdraw]').count() === 1);
    await page.fill('[data-owners-label]', 'Ravi, Coorg');
    await page.click('[data-owners-new]'); await page.waitForTimeout(400);
    const ins = await page.evaluate(() => window.__server.writes.find(x => x[0] === 'platform_invites' && x[1] === 'insert'));
    ok('a new invite: a long random code, who it is for, made by this login', ins && /^[A-Za-z0-9_-]{24}$/.test(ins[2].code) && ins[2].label === 'Ravi, Coorg' && ins[2].created_by === 'u1', ins);
    const link = await page.locator('[data-owners-link]').innerText().catch(() => '');
    ok('…and its link to share (#start=…)', link.endsWith('#start=' + (ins && ins[2].code)), link);
    await page.click('[data-owner-withdraw="waiting-invite-0000000001"]'); await page.waitForTimeout(300);
    ok('Withdraw ends it (asks first)', await page.evaluate(() => window.__server.writes.some(x => x[0] === 'platform_invites' && x[1] === 'update' && x[2].expires_at)));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({ role: 'owner', admin: false });
    ok('not a platform admin: no Invite a new owner', !/Invite a new owner/.test(await menuText(page)) && /Account settings/.test(await menuText(page)));
    await ctx.close(); }
  { const { ctx, page } = await open({ role: 'manager' });
    const m = await menuText(page);
    ok('a manager: neither Account settings nor Invite a new owner', !/Account settings|Invite a new owner/.test(m));
    ok('…and no first-run guide', await page.evaluate(() => { closeModal(); return !document.querySelector('[data-guide]'); }));
    await ctx.close(); }

  console.log('\n— a new account: the first-run guide —');
  { const { ctx, page, errs } = await open({ role: 'owner', migrated: false, name: 'Sea Breeze', code: 'seabreeze', data: EMPTY });
    ok('Home shows the guide, nothing done yet', await page.locator('[data-guide]').count() === 1
      && await page.locator('[data-guide-step][data-done="1"]').count() === 0 && /0 of 7 done/.test(await page.locator('[data-guide]').innerText()));
    ok('…above the welcome', /Getting started[\s\S]*Welcome to StayLog/i.test(await page.locator('[data-main]').innerText()));
    await page.click('[data-guide-step="prop"]'); await page.waitForTimeout(150);
    ok('a step opens its place (Add your property)', await page.evaluate(() => state.modal) === 'addProp');
    await page.evaluate(() => { closeModal(); mutateData(d => { d.properties.push({ id: 'p9', name: 'Sea Breeze', rooms: 2, upiId: 'seabreeze@example' }); }); render(); });
    ok('ticks come from the data: property and payment details done', await page.evaluate(() =>
      document.querySelector('[data-guide-step="prop"]').dataset.done === '1' && document.querySelector('[data-guide-step="pay"]').dataset.done === '1'
      && document.querySelector('[data-guide-step="staff"]').dataset.done === '0'));
    await page.click('[data-guide-hide]'); await page.waitForTimeout(150);
    ok('Hide this guide: gone, and stays gone', await page.locator('[data-guide]').count() === 0
      && await page.evaluate(() => { render(); return !document.querySelector('[data-guide]') && !!localStorage.getItem('staylog_guide_hidden:acct-1'); }));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— the Terms and Privacy Policy for members already here (v73) —');
  { const { ctx, page, errs } = await open({ role: 'manager', legal: true });
    await page.waitForTimeout(200);
    ok('a member who has not accepted them is asked, with links to both', await page.locator('[data-legal-accept]').count() === 1
      && await page.locator('[data-legal-accept] a[href="terms.html"]').count() >= 1 && await page.locator('[data-legal-accept] a[href="privacy.html"]').count() >= 1);
    await page.click('[data-legal-accept-go]'); await page.waitForTimeout(200);
    ok('Accept without the tick: nothing recorded', !(await page.evaluate(() => window.__server.accepted)));
    await page.check('[data-legal-accept-tick]'); await page.click('[data-legal-accept-go]'); await page.waitForTimeout(400);
    ok('ticked and accepted: both recorded on the server, the sheet closes', JSON.stringify(await page.evaluate(() => window.__server.accepted)) === '["terms","privacy"]'
      && await page.locator('[data-legal-accept]').count() === 0);
    await page.evaluate(() => { render(); }); await page.waitForTimeout(150);
    ok('not asked again', await page.locator('[data-legal-accept]').count() === 0);
    ok('⋯ has Terms, privacy and contact, for everyone', /Terms, privacy and contact/.test(await menuText(page)));
    await page.evaluate(() => setState({ modal: 'legal' })); await page.waitForTimeout(150);
    ok('…listing the four pages', (await page.evaluate(() => [...document.querySelectorAll('[data-legal-link]')].map(a => a.getAttribute('href')).join())) === 'terms.html,privacy.html,refund.html,contact.html');
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({ role: 'manager', legal: true });
    await page.waitForTimeout(200);
    await page.click('[data-legal-accept] >> text=Later'); await page.waitForTimeout(150);
    await page.evaluate(() => render()); await page.waitForTimeout(150);
    ok('Later: not asked again in this session (asked on the next open)', await page.locator('[data-legal-accept]').count() === 0);
    await ctx.close(); }
  { const { ctx, page } = await open({ role: 'owner', admin: true, legal: true });
    await page.waitForTimeout(200);
    ok('the platform admin (you, who publish them) is not asked', await page.locator('[data-legal-accept]').count() === 0);
    await ctx.close(); }

  console.log('\n— opening an account from #start= —');
  { const { ctx, page, errs } = await open({ role: 'none', hash: '#start=' + START });
    await page.waitForTimeout(400);
    ok('after unlocking, the Start sheet says who it is for', /Asha, Goa, you are invited to set up StayLog/.test(await page.locator('[data-start]').innerText().catch(() => '')));
    ok('the link is cleared from the address', await page.evaluate(() => !location.hash));
    await page.fill('[data-start-name]', 'Asha');
    await page.fill('[data-start-email]', 'asha@example.com');
    await page.fill('[data-start-pass]', 'asha-pass-1');
    await page.fill('[data-start-business]', 'Sea Breeze Stays!');
    ok('the account code is suggested from the business name', await page.inputValue('[data-start-code]') === 'seabreezesta');
    await page.fill('[data-start-code]', 'Sea-Breeze');
    ok('…and kept to small letters and digits when typed', await page.inputValue('[data-start-code]') === 'seabreeze');
    await page.selectOption('[data-start-currency]', 'INR');
    await page.click('[data-start-go]'); await page.waitForTimeout(400);
    ok('v73: without ticking the Terms and Privacy Policy: refused, nothing sent', /accept the Terms of Service/.test(await page.locator('[data-start]').innerText())
      && !(await page.evaluate(() => window.__server.invoked.some(x => x[1].action === 'owner-accept'))));
    await page.check('[data-start-accept]');
    await page.click('[data-start-go]'); await page.waitForTimeout(900);
    const inv = await page.evaluate(() => window.__server.invoked.find(x => x[1].action === 'owner-accept'));
    ok('Open my account: the function gets the invite, her login, the business, and that she accepted', inv && inv[0] === 'team-invite' && inv[1].accepted === true && inv[1].code === START
      && inv[1].email === 'asha@example.com' && inv[1].business === 'Sea Breeze Stays!' && inv[1].account_code === 'seabreeze' && inv[1].currency === 'INR'
      && inv[1].time_zone && inv[1].name === 'Asha', inv);
    ok('…then signs her in', await page.evaluate(() => window.__server.signedInAs) === 'asha@example.com');
    ok('the invite is forgotten on this phone', await page.evaluate(() => !sessionStorage.getItem('staylog_start') && state.modal !== 'start'));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({ role: 'none' });
    await page.evaluate(() => { state.modal = 'cloud'; render(); }); await page.waitForTimeout(300);
    await page.fill('[data-invite-paste-input]', 'https://example.github.io/staylog/#start=' + START);
    await page.click('[data-invite-paste-go]'); await page.waitForTimeout(400);
    ok('a pasted #start= link opens the Start sheet (from the Home Screen app)', await page.evaluate(() => state.modal) === 'start');
    await ctx.close(); }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
