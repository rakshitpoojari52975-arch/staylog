/* Phase 6 in the app (v65): the team.
   - Team (owner, ⋯ menu): members with emails; a manager's properties and
     permissions change from here; switch a manager off; invites waiting with
     Share / Withdraw; Invite a manager → an invite row with the chosen
     properties and permissions, and a link to share
   - a manager's app shows only what they may: tabs, Home money, booking
     actions, owner-only menu rows, property editing
   - joining from #join=<code>: after unlocking, the Join sheet says what the
     invite is for; Join makes the login, signs in and the app moves across */
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
const CODE = 'abcdefghijklmnopqrstuvwx';

const STUB = (role) => `(function(){
  const S=window.__server={role:'${role}',invites:[{code:'open-invite-000000000001',label:'Ravi',role:'manager',property_ids:['p1'],permissions:{},expires_at:'2026-11-22T00:00:00Z'}],
    members:[{user_id:'u1',role:'owner',name:'Rakshit',email:'me@example.com',active:true,permissions:{},properties:[],me:true},
      {user_id:'u2',role:'manager',name:'Priya',email:'priya@example.com',active:true,permissions:{see_money:true},properties:['p2']}],
    mp:[{user_id:'u2',property_id:'p2'}],writes:[],invoked:[],session:${role === 'none' ? 'null' : "{user:{id:'u1',email:'me@example.com'},access_token:'t'}"},
    model:'stay',signedInAs:null};
  const access=()=>S.role==='owner'?{role:'owner',permissions:{edit_bookings:true,send_messages:true,mark_paid:true,see_money:true,add_expenses:true,manage_staff:true,edit_properties:true},properties:null}
    :{role:'manager',permissions:{edit_bookings:false,send_messages:false,mark_paid:false,see_money:false,add_expenses:true,manage_staff:false,edit_properties:false},properties:['p2']};
  function q(table){const st={f:[],op:'select',val:null};
    const api={select(){return api;},eq(k,v){st.f.push([k,v]);return api;},in(k,v){st.f.push([k,v]);return api;},is(){return api;},gt(){return api;},order(){return api;},range(){return api;},not(){return api;},gte(){return api;},limit(){return api;},
      update(v){st.op='update';st.val=v;return api;},insert(v){st.op='insert';st.val=v;return api;},delete(){st.op='delete';return api;},upsert(v){st.op='upsert';st.val=v;return api;},
      then(res,rej){let data=[];
        if(st.op!=='select')S.writes.push([table,st.op,st.val,st.f]);
        if(table==='app_status')data=[{id:1,min_version:62,model:S.model}];
        else if(table==='members'&&st.op==='select')data=[{account_id:'acct-1',role:S.role,active:true,accounts:{name:'Raaya Vasyam',code:'raaya'}}];
        else if(table==='member_properties'&&st.op==='select')data=S.mp.filter(x=>st.f.every(([k,v])=>k!=='user_id'||x.user_id===v));
        return Promise.resolve({data,error:null}).then(res,rej);}};
    return api;}
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:S.session}}),signOut:async()=>({error:null}),
      signInWithPassword:async({email,password})=>{S.signedInAs=email;S.session={user:{id:'u-new',email},access_token:'t2'};return{data:{session:S.session},error:null};},
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    functions:{async invoke(name,{body}){S.invoked.push([name,body]);
      if(name==='team-invite'&&body.action==='peek')return{data:{ok:true,business:'Raaya Vasyam',label:'Priya',properties:['Sea View']},error:null};
      if(name==='team-invite'&&body.action==='accept'){S.role='manager';return{data:{ok:true,account:'acct-1',business:'Raaya Vasyam',properties:['Sea View']},error:null};}
      return{data:{},error:null};}},
    from:t=>q(t), rpc:async()=>({data:null,error:null}),
    schema:()=>({from:t=>q(t),async rpc(n,a){
      if(n==='my_access')return{data:access(),error:null};
      if(n==='team')return{data:{members:S.members,invites:S.invites},error:null};
      if(n==='apply_change')return{data:{status:'ok',row:{...a.p_row,version:1,updated_at:new Date().toISOString(),deleted_at:null,legacy:null}},error:null};
      return{data:null,error:null};}}),
  })};})();`;

const SEED = { properties: [{ id: 'p1', name: 'Raaya Vasyam' }, { id: 'p2', name: 'Sea View' }], staff: [], loans: [], expenses: [], attendance: [],
  bookings: [{ id: 'b2', propertyId: 'p2', guestName: 'Kiran', phone: '9876543210', checkIn: D(1), checkOut: D(3), guests: 2, totalAmount: 6000, paid: 1000,
    source: 'Direct', status: 'confirmed', msgSent: {} }] };

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  const open = async (role, o = {}) => {
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    for (const g of ['**fonts.googleapis.com**', '**cdn.jsdelivr.net**']) await ctx.route(g, r => r.abort());
    await ctx.route('**vendor/supabase.umd.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB(role) }));
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
    }, [SEED, role !== 'none']);
    await page.goto(base + '/index.html' + (o.hash || ''));
    await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    if (role !== 'none') { await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading); }
    await page.evaluate(() => { state.loggedIn = true; render(); });
    await page.waitForTimeout(400);
    if (role !== 'none') { await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(400); await page.evaluate(() => render()); }
    return { ctx, page, errs, dialogs };
  };

  console.log('\n— the owner\'s Team —');
  { const { ctx, page, errs, dialogs } = await open('owner');
    ok('⋯ offers Team to the owner', await page.evaluate(() => { state.modal = 'menu'; render(); return /Team/.test(document.body.innerText); }));
    await page.evaluate(() => setState({ modal: 'team' })); await page.waitForTimeout(300);
    const t = await page.locator('[data-team]').innerText();
    ok('members with their emails and roles', /Rakshit \(you\)/.test(t) && /priya@example\.com/.test(t) && /Manager/.test(t), t.slice(0, 300));
    ok('the invite still open, with its property', /Ravi/.test(t) && /Raaya Vasyam · until/.test(t));
    await page.click('[data-member="u2"] [data-member-perm-mark_paid]'); await page.waitForTimeout(300);
    const w1 = await page.evaluate(() => window.__server.writes.find(x => x[0] === 'members'));
    ok('a permission changed is saved on the member, the rest kept', w1 && w1[1] === 'update' && w1[2].permissions.mark_paid === false && w1[2].permissions.see_money === true, w1);
    await page.click('[data-member="u2"] [data-member-prop-p1]'); await page.waitForTimeout(300);
    ok('a property given is added to what they hold', await page.evaluate(() => JSON.stringify(window.__server.writes.find(x => x[0] === 'member_properties' && x[1] === 'insert')[2]))
      === JSON.stringify([{ account_id: 'acct-1', user_id: 'u2', property_id: 'p1' }]));
    await page.click('[data-member-active="u2"]'); await page.waitForTimeout(300);
    ok('switching a manager off asks first', dialogs.some(d => /Switch off Priya/.test(d)) && await page.evaluate(() => window.__server.writes.some(x => x[0] === 'members' && x[2].active === false)));
    await page.click('[data-invite-new]');
    await page.fill('[data-invite-label]', 'Anil');
    await page.click('[data-invite-create]');
    ok('no property picked: asked to pick one', dialogs.some(d => /Pick at least one property/.test(d)));
    await page.check('[data-invite-prop-p2]'); await page.check('[data-invite-perm-see_money]'); await page.uncheck('[data-invite-perm-send_messages]');
    await page.click('[data-invite-create]'); await page.waitForTimeout(400);
    const w2 = await page.evaluate(() => window.__server.writes.find(x => x[0] === 'invites' && x[1] === 'insert'));
    ok('an invite: a manager, for Anil, Sea View, with the chosen permissions and a long code', w2 && w2[2].role === 'manager' && w2[2].label === 'Anil'
      && JSON.stringify(w2[2].property_ids) === '["p2"]' && w2[2].permissions.see_money === true && w2[2].permissions.send_messages === false
      && w2[2].permissions.edit_bookings === true && /^[A-Za-z0-9_-]{20,}$/.test(w2[2].code), w2);
    const link = await page.evaluate(() => (document.querySelector('[data-invite-link]') || {}).textContent || '');
    ok('its link is #join=<code> on this app', link.endsWith('#join=' + w2[2].code) && link.startsWith(base), link);
    await page.click('[data-invite-withdraw="open-invite-000000000001"]'); await page.waitForTimeout(300);
    ok('Withdraw ends the invite (expires now)', await page.evaluate(() => window.__server.writes.some(x => x[0] === 'invites' && x[1] === 'update' && x[2].expires_at)));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— a manager sees only what they may —');
  { const { ctx, page, errs } = await open('manager');
    const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-tab]')].map(b => b.dataset.tab).join());
    ok('tabs: no Loans, no Reports (no money, no staff)', tabs === 'dashboard,bookings,expenses', tabs);
    await page.evaluate(() => setState({ tab: 'reports' }));
    ok('a hidden tab never shows', await page.evaluate(() => state.tab) === 'dashboard');
    const home = await page.locator('[data-main]').innerText();
    ok('Home: no money figures', !/Avg tariff|Net|Revenue/i.test(home), home.slice(0, 300));
    await page.evaluate(() => setState({ tab: 'bookings', expandedBooking: 'b2' })); await page.waitForTimeout(150);
    const card = await page.locator('[data-main]').innerText();
    ok('a booking: no Edit, Send, Mark paid, Receipt, Cancel or Check in', !/\bEdit\b|\bSend\b|Mark paid|Receipt|Check In/.test(card)
      && await page.locator('[data-cancel-booking]').count() === 0, card.slice(0, 500));
    ok('no Add booking', await page.locator('button', { hasText: /^Add$/ }).count() === 0);
    const menu = await page.evaluate(() => { state.modal = 'menu'; render(); return document.body.innerText; });
    ok('⋯: no Team, Add property, Encrypted backup or Inventory', !/\bTeam\b|Add property|Encrypted backup|Inventory/.test(menu));
    ok('the property picker: no editing', await page.evaluate(() => { state.modal = 'propPicker'; render(); return document.querySelectorAll('[aria-label^="Edit "]').length; }) === 0);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— joining from a link —');
  { const { ctx, page, errs } = await open('none', { hash: '#join=' + CODE });
    await page.waitForTimeout(400);
    const t = await page.locator('[data-join]').innerText().catch(() => '');
    ok('after unlocking, the Join sheet says what it is for', /Priya, you are invited to help manage Sea View for Raaya Vasyam/.test(t), t);
    ok('the link is cleared from the address', !/join=/.test(await page.evaluate(() => location.hash)));
    await page.fill('[data-join-email]', 'priya@example.com'); await page.fill('[data-join-pass]', 'priya-pass-1');
    await page.click('[data-join-go]'); await page.waitForTimeout(900);
    const inv = await page.evaluate(() => window.__server.invoked.find(x => x[1].action === 'accept'));
    ok('accept sends the code, her name, email and password', inv && inv[1].code === CODE && inv[1].name === 'Priya' && inv[1].email === 'priya@example.com' && inv[1].password === 'priya-pass-1', inv);
    ok('then she is signed in with that login', await page.evaluate(() => window.__server.signedInAs) === 'priya@example.com');
    ok('and the app moves onto the account', await page.evaluate(() => window.StayLogSync.isActive() && window.StayLogSync.model().account === 'acct-1'));
    ok('the invite is not offered again', await page.locator('[data-join]').count() === 0 && await page.evaluate(() => sessionStorage.getItem('staylog_join')) === null);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
