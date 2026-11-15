/* Phase 5 in the app (v64): staff.
   - Works at: ticked properties saved on the staff member (works_at), and the
     property picker filters the staff list by it
   - Staff logins (new model): who has one, its username and the account code;
     Create login / Reset password / Switch off go to the staff-login function
   - the owner's name the staff page shows can be set here
   - marks the server holds for a missing rate show on Home, naming her
   - Pay sheet: paid_on is the payday, and a loan cut taken there is dated by it
   - a Shared expense (no property) can be saved */
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

// The new model's server: rows by table, the staff-login function, held marks.
const STUB = `(function(){
  const S=window.__server={stay:{properties:{},bookings:{},expenses:{},staff:{},loans:{},loan_repayments:{}},
    logins:[{staff_id:'s1',username:'laxmi',active:true}],acct:{code:'raaya',owner_name:null},
    held:{attendance:[{staff_id:'s2',date:'${D(-1)}'},{staff_id:'s2',date:'${D(0)}'}],utensil_marks:[]},invoked:[],applied:[],clock:Date.parse('2026-11-15T04:00:00Z')};
  const now=()=>new Date(S.clock+=1000).toISOString();
  const put=(t,r)=>{const o=S.stay[t][r.id];S.stay[t][r.id]=Object.assign({},o||{},r,{version:o?o.version+1:1,updated_at:now()});return S.stay[t][r.id];};
  function q(table){const st={f:[],op:'select',val:null};
    const api={select(){return api;},eq(k,v){st.f.push([k,v]);return api;},is(k,v){st.f.push([k,v]);return api;},gt(){return api;},order(){return api;},range(){return api;},
      update(v){st.op='update';st.val=v;return api;},upsert(v){st.op='upsert';return api;},
      then(res,rej){let data=[];
        if(table==='staff_logins')data=S.logins;
        else if(table==='accounts'){if(st.op==='update')Object.assign(S.acct,st.val);data=[S.acct];}
        else if(table==='attendance'||table==='utensil_marks')data=S.held[table];
        else if(table==='members')data=[{account_id:'acct-1',role:'owner',active:true}];
        else if(S.stay[table])data=Object.values(S.stay[table]);
        return Promise.resolve({data:JSON.parse(JSON.stringify(data)),error:null}).then(res,rej);}};
    return api;}
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:{user:{id:'u1',email:'me@example.com'},access_token:'t'}}}),signOut:async()=>({error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    functions:{async invoke(name,{body}){S.invoked.push([name,body]);
      if(name!=='staff-login')return{data:{},error:null};
      if(body.action==='create'){if(body.password.length<8)return{data:null,error:{message:'400',context:{json:async()=>({error:'The password needs at least 8 characters.'})}}};
        S.logins.push({staff_id:body.staff_id,username:body.username,active:true});return{data:{ok:true,username:body.username,code:'raaya'},error:null};}
      if(body.action==='disable'||body.action==='enable'){S.logins.find(l=>l.staff_id===body.staff_id).active=body.action==='enable';}
      return{data:{ok:true},error:null};}},
    from:t=>q(t), rpc:async()=>({data:null,error:null}),
    schema:()=>({from:t=>q(t),async rpc(n,a){if(n==='apply_change'){S.applied.push(a);const t=S.stay[a.p_table],cur=t[a.p_row.id];
      if(a.p_base_version===null&&cur)return{data:{status:'conflict',server:cur},error:null};
      return{data:{status:'ok',row:put(a.p_table,{account_id:'acct-1',deleted_at:null,legacy:null,...a.p_row})},error:null};}
      return{data:null,error:null};}}),
  })};})();`;

const SEED = { properties: [{ id: 'p1', name: 'Raaya Vasyam' }, { id: 'p2', name: 'Sea View Cottage' }],
  staff: [{ id: 's1', name: 'Lakshmi Walikar', dailyWage: 500, active: true, worksAt: ['p1'] }, { id: 's2', name: 'Ravi', active: true }],
  loans: [{ id: 'l1', staffId: 's1', principal: 5000, installmentAmount: 1000, disbursedOn: D(-60), firstDueDate: D(-30), status: 'active', repayments: [] }],
  expenses: [{ id: 'wag_s1_a', propertyId: 'p1', description: 'Wage — Lakshmi', amount: 500, date: D(-5), category: 'staff', staffId: 's1', paid: false },
    { id: 'wag_s1_b', propertyId: 'p1', description: 'Wage — Lakshmi', amount: 500, date: D(-4), category: 'staff', staffId: 's1', paid: false }],
  bookings: [], attendance: [] };

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  const open = async (o = {}) => {
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    for (const g of ['**fonts.googleapis.com**', '**cdn.jsdelivr.net**']) await ctx.route(g, r => r.abort());
    await ctx.route('**vendor/supabase.umd.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    const page = await ctx.newPage(); const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('dialog', async d => { dialogs.push(d.message()); d.type() === 'prompt' ? await d.accept('Rakshit') : await d.accept(); });
    await page.addInitScript(([s, stay]) => {
      if (stay) {
        localStorage.setItem('staylog_model', JSON.stringify({ mode: 'stay', user: 'u1', account: 'acct-1' }));
        const r = indexedDB.open('staylog_db', 1);
        r.onupgradeneeded = e => e.target.result.createObjectStore('appdata');
        r.onsuccess = e => { const tx = e.target.result.transaction('appdata', 'readwrite'); tx.objectStore('appdata').put(s, 'staylog_stay_data:u1:acct-1'); };
      } else localStorage.setItem('staylog_v2', JSON.stringify(s));
    }, [SEED, !!o.stay]);
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    if (o.stay) { await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading); }
    await page.evaluate(() => { state.loggedIn = true; render(); });
    await page.waitForTimeout(400);
    return { ctx, page, errs, dialogs };
  };

  console.log('\n— Works at —');
  { const { ctx, page, errs } = await open();
    await page.evaluate(() => setState({ modal: 'addStaff', editItem: state.data.staff[1] }));
    ok('the staff form lists the properties', await page.locator('[data-works-at-prop]').count() === 2);
    await page.check('[data-works-at-prop="p2"]');
    await page.click('text=Update Staff');
    ok('ticked properties are saved on the staff member', await page.evaluate(() => JSON.stringify(state.data.staff[1].worksAt)) === '["p2"]');
    await page.evaluate(() => setState({ tab: 'loans', showStaffPanel: true, filterProp: 'p1' })); await page.waitForTimeout(150);
    const panel = () => page.evaluate(() => staffPanel().innerText || staffPanel().textContent);
    let t = await panel();
    ok('picking a property lists only the staff who work there', /Lakshmi Walikar/.test(t) && !/Ravi/.test(t), t.slice(0, 300));
    await page.evaluate(() => setState({ filterProp: 'p2' })); await page.waitForTimeout(150);
    t = await panel();
    ok('…and the other property its own', /Ravi/.test(t) && !/Lakshmi Walikar/.test(t));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— staff logins (new model) —');
  { const { ctx, page, errs, dialogs } = await open({ stay: true });
    await page.evaluate(() => setState({ tab: 'loans', showStaffPanel: true, filterProp: 'all' })); await page.waitForTimeout(500);
    ok('a login is shown with its username and the account code', /Login: laxmi · account code raaya/.test(await page.locator('[data-staff-login="s1"]').innerText()));
    ok('none yet: Create login', await page.locator('[data-login-create="s2"]').count() === 1);
    await page.click('[data-login-create="s2"]');
    ok('the username is suggested from the name', await page.locator('[data-login-user]').inputValue() === 'ravi');
    await page.fill('[data-login-pass]', 'short'); await page.click('[data-login-save]');
    ok('a short password is refused before anything is sent', /at least 8/.test(await page.locator('.modal, body').innerText()) && !(await page.evaluate(() => window.__server.invoked.length)));
    await page.fill('[data-login-pass]', 'ravi-pass-1'); await page.click('[data-login-save]'); await page.waitForTimeout(500);
    ok('created through the staff-login function', await page.evaluate(() => JSON.stringify(window.__server.invoked[0])) ===
      JSON.stringify(['staff-login', { action: 'create', account: 'acct-1', staff_id: 's2', username: 'ravi', password: 'ravi-pass-1' }]));
    ok('…and shown', /Login: ravi/.test(await page.locator('[data-staff-login="s2"]').innerText()));
    await page.click('[data-login-toggle="s1"]'); await page.waitForTimeout(400);
    ok('switching off asks first, then says so', dialogs.some(d => /Switch off Lakshmi Walikar's login/.test(d)) && /switched off/.test(await page.locator('[data-staff-login="s1"]').innerText()));
    await page.click('[data-login-reset="s1"]');
    ok('reset keeps the username fixed', await page.locator('[data-login-user]').isDisabled() && await page.locator('[data-login-user]').inputValue() === 'laxmi');
    await page.evaluate(() => closeModal());
    ok('the staff page does not know his name yet: he can add it', /does not know your name yet/.test(await page.locator('[data-owner-name]').innerText()));
    await page.locator('[data-owner-name] button').click(); await page.waitForTimeout(400);
    ok('…saved on the account', await page.evaluate(() => window.__server.acct.owner_name) === 'Rakshit' && /Ask Rakshit if you’re stuck/.test(await page.locator('[data-owner-name]').innerText()));

    console.log('\n— marks waiting for a rate —');
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(400);
    await page.evaluate(() => setState({ tab: 'dashboard', filterProp: 'all' })); await page.waitForTimeout(200);
    ok('Home names her and says what to do', /Ravi: 2 days marked present waiting for a rate\. Set the daily wage in Staff/.test(await page.locator('[data-held-marks="s2"]').innerText()));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— Pay sheet and Shared expenses —');
  { const { ctx, page } = await open();
    const r = await page.evaluate(() => { const d = state.data, ids = ['wag_s1_a', 'wag_s1_b'];
      mutateData(dd => { dd.expenses.filter(e => ids.includes(e.id)).forEach(e => { e.loanId = 'l1'; e.loanDeduction = 200; e.grossAmount = 500; e.amount = 300; e.paid = true; e.paidOn = today(); syncExpenseLoan(dd, e); }); });
      return { paidOn: state.data.expenses.map(e => e.paidOn), reps: state.data.loans[0].repayments.map(x => x.date), today: today() }; });
    ok('a loan cut taken on payday is dated by the payday, not the wage\'s day', r.reps.length === 2 && r.reps.every(x => x === r.today), r);
    await page.evaluate(() => setState({ modal: 'addExpense', editItem: null, filterProp: 'all' }));
    await page.selectOption('[data-exp-prop]', '');
    await page.fill('input[placeholder="Description *"]', 'Accountant');
    await page.fill('input[placeholder="Amount (₹) *"]', '1500');
    await page.locator('button', { hasText: /^(Add|Save) Expense$/ }).click().catch(async () => { await page.locator('.btn-primary').last().click(); });
    await page.waitForTimeout(200);
    ok('a Shared expense (no property) is saved', await page.evaluate(() => state.data.expenses.some(e => e.description === 'Accountant' && !e.propertyId)));
    await ctx.close(); }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
