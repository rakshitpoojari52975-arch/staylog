/* Phase 3 in the app (v62): ⋯ → Move to the new system.
   - the row shows only while the old model is live and 05-migrate.sql has run
   - Copy and compare: syncs the old way first, opens the account, copies
     every row (no ID photo), copies what only the cloud has, reads it back and
     compares — Inventory figures and row by row. Nothing switches.
   - a mismatch says so, lists it, and offers no switch
   - Switch over: compares afresh, switches (stay.cutover), the phone now syncs
     the new way; its old copy is untouched; its ID photos stay
   - another phone with the old app data joins by itself at its next start
     (pulls everything, keeps its own photos)
   - after rollback-cutover.sql the phone goes back to the old system with
     every change made since */
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

// Supabase: the old tables (a plain store, writes counted) and `stay` (the
// migration functions and apply_change, following their SQL's rules).
const STUB = `
window.__auth={session:{user:{id:'owner-1',email:'me@example.com'},access_token:'tok'}};
const S=window.__server=JSON.parse(sessionStorage.getItem('__srv')||'null')||{pub:{},stay:{},calls:[],clock:Date.parse('2026-11-15T04:00:00Z')};
const save=()=>sessionStorage.setItem('__srv',JSON.stringify(S));
const now=()=>new Date(S.clock+=1000).toISOString();
const STAY=['properties','bookings','expenses','staff','loans','loan_repayments'];
STAY.forEach(t=>S.stay[t]=S.stay[t]||{});
const DEF={bookings:{status:'confirmed',round_off:0,round_off_hand:false,msg_sent:{},ical_gone:false,gap_closed:{}},
  expenses:{category:'other',amount:0,paid:false},properties:{rented_as_whole_unit:false,checkin_time:'13:00:00',checkout_time:'11:00:00',house_rules:[]},
  staff:{active:true},loans:{status:'active'},loan_repayments:{mode:'direct'}};
const put=(t,r)=>{const old=S.stay[t][r.id];S.stay[t][r.id]=Object.assign({},DEF[t]||{},old||{},r,{version:old?old.version+1:1,updated_at:now(),created_at:old?old.created_at:now()});};
const RPC={
  migration_account:()=>{S.stay.account='acct-1';return 'acct-1';},
  migrate_rows:a=>{if((S.pub.app_status||[{}])[0].model==='stay')throw new Error('Already switched over');
    let n=0;for(const r of a.p_rows){if(window.__drop&&window.__drop===r.id)continue;put(a.p_table,{...r,account_id:a.p_account});n++;}return{written:n,placeholders:[]};},
  migrate_prune:a=>{let n=0;for(const r of Object.values(S.stay[a.p_table]))if(!r.deleted_at&&!a.p_ids.includes(r.id)){r.deleted_at=now();r.version++;r.updated_at=now();n++;}return n;},
  migrate_copy:()=>({attendance:3,utensil_marks:1,staff_logins:1,ical_feeds:2,ical_events:5,push_subscriptions:1,push_log:4,backups:6}),
  cutover:()=>{S.pub.app_status[0].model='stay';S.pub.app_status[0].min_version=62;S.cutovers=(S.cutovers||0)+1;return{status:'ok'};},
  apply_change:a=>{const t=S.stay[a.p_table],cur=t[a.p_row.id];S.applied=(S.applied||0)+1;
    if(a.p_base_version===null){if(cur)return{status:'conflict',server:cur};put(a.p_table,a.p_row);return{status:'ok',row:t[a.p_row.id]};}
    if(!cur)return{status:'missing'};if(cur.version!==a.p_base_version)return{status:'conflict',server:cur};
    put(a.p_table,a.p_row);return{status:'ok',row:t[a.p_row.id]};},
};
function q(schema,table){
  const st={f:[],gt:null,op:'select',val:null};
  const api={select(){return api;},eq(k,v){st.f.push([k,v]);return api;},gt(k,v){st.gt=v;return api;},is(){return api;},not(){return api;},in(){return api;},
    order(){return api;},range(){return api;},limit(){return api;},gte(){return api;},
    update(v){st.op='update';st.val=v;return api;},delete(){st.op='delete';return api;},
    upsert(v){st.op='upsert';st.val=v;return api;},insert(v){st.op='insert';st.val=v;return api;},
    then(res,rej){
      let out={data:[],error:null};
      if(schema==='public'){
        if(st.op!=='select'){S.calls.push('public '+st.op+' '+table);
          if((S.pub.app_status||[{}])[0].model==='stay'&&table!=='app_status')out={data:null,error:{message:'permission denied for table '+table}};
          else if(st.op==='upsert'||st.op==='insert'){const t=S.pub[table]=S.pub[table]||[];[].concat(st.val).forEach(r=>t.push(r));}}
        else out={data:JSON.parse(JSON.stringify(S.pub[table]||[])),error:null};
        if(table==='app_status'&&st.op==='select'&&window.__noModel)out={data:null,error:{message:'column app_status.model does not exist'}};
      }else{
        if(table==='members')out={data:[{account_id:'acct-1',role:'owner',active:true,accounts:{name:'Raaya Vasyam'}}],error:null};
        else if(STAY.includes(table))out={data:JSON.parse(JSON.stringify(Object.values(S.stay[table]).filter(r=>st.f.every(([k,v])=>r[k]===v)&&(!st.gt||r.updated_at>st.gt))
          .sort((a,b)=>a.updated_at.localeCompare(b.updated_at)))),error:null};
      }
      save();return Promise.resolve(out).then(res,rej);
    }};
  return api;
}
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:window.__auth.session}}),signOut:async()=>({error:null}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  functions:{async invoke(){return{data:{},error:null};}},
  from:t=>q('public',t), rpc:async()=>({data:null,error:null}),
  schema:s=>({from:t=>q(s,t),async rpc(name,a){S.calls.push('rpc '+name);
    try{const d=RPC[name](a);save();return{data:JSON.parse(JSON.stringify(d===undefined?null:d)),error:null};}
    catch(e){return{data:null,error:{message:e.message}};}}}),
})};`;

const SEED = { properties: [{ id: 'p1', name: 'Raaya Vasyam', location: 'Kaup', rooms: 3, pricePerNight: 4000, wifiName: 'RV', wifiPassword: 'not-a-real-one' }],
  staff: [{ id: 's1', name: 'Lakshmi', dailyWage: 500, active: true }],
  loans: [{ id: 'l1', staffId: 's1', principal: 5000, installmentAmount: 1000, disbursedOn: D(-40), firstDueDate: D(-10), status: 'active',
    repayments: [{ id: 'r1', date: D(-5), amount: 1000, mode: 'direct', note: '' }] }],
  expenses: [{ id: 'e1', propertyId: '', description: 'Gas', amount: 1100.25, date: D(-2), category: 'utilities', paid: true, notes: '' },
    { id: 'wag_s1_x', propertyId: 'p1', description: 'Wage — Lakshmi', amount: 500, date: D(-1), category: 'staff', staffId: 's1', paid: false }],
  attendance: [],
  bookings: [{ id: 'b1', propertyId: 'p1', guestName: 'Anita Rao', phone: '9876543210', checkIn: D(1), checkOut: D(3), guests: 2,
    totalAmount: 6000, paid: 2000, source: 'Direct', status: 'confirmed', notes: '', msgSent: {}, idProofImage: 'data:image/jpeg;base64,AAAA', receiptNo: 'RV/2026-27/007' },
    { id: 'b2', propertyId: 'p1', guestName: 'Ravi', phone: '', checkIn: D(-20), checkOut: D(-18), guests: 1, totalAmount: 4632.47, paid: 4630,
      roundOff: 2.47, source: 'Booking.com', status: 'checkedout', notes: '', msgSent: {} },
    { id: 'b3', propertyId: 'p1', guestName: 'Cancelled guest', checkIn: D(4), checkOut: D(5), guests: 1, totalAmount: 3000, paid: 0, source: 'Airbnb', status: 'cancelled' }] };

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  const open = async (o = {}) => {
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    for (const g of ['**://*.supabase.co/**', '**fonts.googleapis.com**', '**cdn.jsdelivr.net**']) await ctx.route(g, r => r.abort());
    await ctx.route('**vendor/supabase.umd.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    const page = await ctx.newPage(); const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    await page.addInitScript(([s, o]) => {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      localStorage.setItem('staylog_v2', JSON.stringify(s));
      localStorage.setItem('staylog_owner', 'owner-1');
      sessionStorage.setItem('__srv', JSON.stringify(o.server || { pub: { app_status: [{ id: 1, min_version: 0, model: 'public' }], sync_status: [] },
        stay: {}, calls: [], clock: Date.parse('2026-11-15T04:00:00Z') }));
    }, [o.seed || SEED, o]);
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    await page.waitForTimeout(500);
    await page.evaluate(() => { state.loggedIn = true; render(); });
    return { ctx, page, errs, dialogs };
  };
  const menuHas = page => page.evaluate(() => { state.modal = 'menu'; render(); return !!Array.from(document.querySelectorAll('button')).find(b => /Move to the new system/.test(b.textContent)); });

  console.log('\n— the menu row —');
  { const { ctx, page } = await open({ server: { pub: { app_status: [{ id: 1, min_version: 0 }] }, stay: {}, calls: [], clock: 0 } });
    await page.evaluate(() => { window.__noModel = true; }); await page.evaluate(() => window.StayLogCloud.refreshModel());
    ok('before 05-migrate.sql: not offered', !(await menuHas(page)));
    await ctx.close(); }

  console.log('\n— Copy and compare —');
  const { ctx, page, errs, dialogs } = await open();
  ok('with the old model live: offered', await menuHas(page));
  const oldCopy = await page.evaluate(() => localStorage.getItem('staylog_v2'));
  await page.evaluate(() => { state.modal = 'move'; render(); });
  await page.click('[data-move-copy]');
  await page.waitForSelector('[data-move-verdict]', { timeout: 15000 });
  const calls = await page.evaluate(() => window.__server.calls);
  ok('it synced the old way first, then moved in', calls.indexOf('rpc migration_account') > 0 && calls.slice(0, calls.indexOf('rpc migration_account')).some(c => /^public (upsert|update)/.test(c)), calls.slice(0, 12));
  ok('every row copied', await page.evaluate(() => Object.keys(window.__server.stay.bookings).length === 3 && Object.keys(window.__server.stay.loan_repayments).length === 1
    && Object.keys(window.__server.stay.expenses).length === 2));
  ok('no ID photo copied', await page.evaluate(() => !JSON.stringify(window.__server.stay).includes('base64')));
  ok('money, Wi-Fi and receipts go across (his decision: guest data readable in Supabase, behind login)', await page.evaluate(() =>
    window.__server.stay.bookings.b1.total_amount === 6000 && window.__server.stay.bookings.b1.receipt_no === 'RV/2026-27/007' && window.__server.stay.properties.p1.wifi_name === 'RV'));
  let verdict = await page.locator('[data-move-verdict]').innerText();
  ok('everything matches', /Everything matches/.test(verdict), verdict);
  ok('every section ticked', (await page.locator('[data-move-section]').allInnerTexts()).every(t => t.startsWith('✓')), await page.locator('[data-move-section]').allInnerTexts());
  const figs = await page.locator('[data-move-figures]').innerText();
  ok('the figures shown: 3 bookings (1 cancelled), ID photos counted from this phone, revenue', /3 bookings \(1 cancelled\)/.test(figs) && /1 ID photos/.test(figs) && /Revenue ₹10,630/.test(figs), figs);
  ok('what came from the cloud is listed', /Lakshmi’s marks 4/.test(await page.locator('[data-move-copied]').innerText()));
  ok('nothing switched yet', await page.evaluate(() => !window.StayLogSync.isActive() && window.__server.pub.app_status[0].model === 'public'));
  ok('the old copy untouched by the move', await page.evaluate(() => localStorage.getItem('staylog_v2')) === oldCopy);
  ok('a Switch over button', await page.locator('[data-move-switch]').count() === 1);

  console.log('\n— a mismatch —');
  await page.evaluate(() => { window.__drop = 'e1'; mutateData(d => { d.expenses.find(e => e.id === 'e1').amount = 1200; }); });
  await page.click('[data-move-copy]'); await page.waitForTimeout(300);
  await page.waitForSelector('[data-move-verdict]', { timeout: 15000 });
  verdict = await page.locator('[data-move-verdict]').innerText();
  ok('says it does not match', /Something does not match/.test(verdict), verdict);
  ok('names the section and the row', /✗ Money/.test(await page.locator('[data-move-section="totals"]').innerText())
    && /e1/.test(await page.locator('[data-move-rows]').innerText()), await page.locator('[data-move-rows]').innerText());
  ok('and offers no switch', await page.locator('[data-move-switch]').count() === 0);
  await page.evaluate(() => { window.__drop = null; });
  await page.click('[data-move-copy]'); await page.waitForTimeout(300);
  await page.waitForSelector('[data-move-switch]', { timeout: 15000 });
  ok('fixed: matches again', /Everything matches/.test(await page.locator('[data-move-verdict]').innerText()));

  console.log('\n— Switch over —');
  await page.click('[data-move-switch]');
  await page.waitForSelector('[data-move-done]', { timeout: 15000 });
  ok('it asked first', dialogs.some(d => /Switch StayLog to the new system now/.test(d)));
  ok('switched: the database says so, once', await page.evaluate(() => window.__server.pub.app_status[0].model === 'stay' && window.__server.cutovers === 1));
  ok('this phone now syncs the new way', await page.evaluate(() => window.StayLogSync.isActive() && window.StayLogSync.model().account === 'acct-1'));
  ok('its data is the server\'s, with its own ID photo kept', await page.evaluate(() => state.data.bookings.length === 3
    && state.data.bookings.find(b => b.id === 'b1').idProofImage === 'data:image/jpeg;base64,AAAA' && state.data.expenses.find(e => e.id === 'e1').amount === 1200));
  const oldNow = await page.evaluate(() => localStorage.getItem('staylog_v2'));
  await page.evaluate(() => mutateData(d => { d.bookings.find(b => b.id === 'b1').notes = 'Arriving late'; }));
  await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(400);
  ok('an edit now goes up through apply_change', await page.evaluate(() => window.__server.stay.bookings.b1.notes === 'Arriving late' && window.__server.applied > 0));
  ok('the old copy is never written again', await page.evaluate(() => localStorage.getItem('staylog_v2')) === oldNow);
  ok('nothing more to the old tables', await page.evaluate(() => !window.__server.calls.slice(window.__server.calls.indexOf('rpc cutover')).some(c => /^public/.test(c))));
  ok('the menu no longer offers the move', !(await menuHas(page)));
  ok('the Sync panel is the new one, with the calendar boxes', await page.evaluate(() => { state.modal = 'cloud'; render();
    return !!document.querySelector('[data-stay-sync]') && !!document.querySelector('[data-ical]'); }));
  ok('no page errors', errs.length === 0, errs);
  const serverAfter = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__srv')));

  console.log('\n— another phone joins by itself —');
  { const other = JSON.parse(JSON.stringify(SEED));
    other.bookings = other.bookings.map(b => ({ ...b, idProofImage: b.id === 'b2' ? 'data:image/jpeg;base64,BBBB' : '' }));
    const p2 = await open({ seed: other, server: serverAfter });
    await page.waitForTimeout(100);
    ok('at start it sees the switch and moves across', await p2.page.evaluate(() => window.StayLogSync.isActive()));
    ok('it has everything from the server', await p2.page.evaluate(() => state.data.bookings.find(b => b.id === 'b1').notes === 'Arriving late'
      && state.data.expenses.find(e => e.id === 'e1').amount === 1200));
    ok('and keeps its own ID photo (not the other phone\'s)', await p2.page.evaluate(() => state.data.bookings.find(b => b.id === 'b2').idProofImage === 'data:image/jpeg;base64,BBBB'
      && !state.data.bookings.find(b => b.id === 'b1').idProofImage));
    ok('its old copy untouched', /Anita Rao/.test(await p2.page.evaluate(() => localStorage.getItem('staylog_v2')))
      && !/Arriving late/.test(await p2.page.evaluate(() => localStorage.getItem('staylog_v2'))));
    ok('no page errors', p2.errs.length === 0, p2.errs);
    await p2.ctx.close(); }

  console.log('\n— the rollback —');
  await page.evaluate(() => { window.__server.pub.app_status[0].model = 'public'; sessionStorage.setItem('__srv', JSON.stringify(window.__server)); });
  await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading); await page.waitForTimeout(800);
  ok('back on the old system', await page.evaluate(() => !window.StayLogSync.isActive()));
  ok('with every change made since in its old copy', /Arriving late/.test(await page.evaluate(() => localStorage.getItem('staylog_v2'))));
  ok('ID photo still there', await page.evaluate(() => state.data.bookings.find(b => b.id === 'b1').idProofImage === 'data:image/jpeg;base64,AAAA'));

  await ctx.close(); await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
