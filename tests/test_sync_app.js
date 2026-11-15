/* Phase 2 in the real app (v61): the new sync engine wired in, still dormant.
   - the PIN is stored as a salted hash; an old plain PIN opens once and is
     converted; a wrong PIN is refused; a new PIN is hashed from the start
   - dormant: with no switch-over, the app saves and syncs exactly as before,
     and sync.js sends nothing
   - switched over: the app keeps its copy under its own key (the old copy is
     never written), syncs through stay.apply_change, cloud.js stands down
   - the Sync panel: waiting changes, a conflict with "Use mine" and "Keep the
     saved one"; a money conflict says so
   - receipts take their number from the server in the new model
   - a payday repayment keeps its id when its expense is saved again */
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

// Supabase, with the old public tables (writes logged) and the `stay` schema
// following apply_change's rules. Kept across reloads in sessionStorage.
const STUB = `
window.__auth={session:{user:{id:'u1',email:'me@example.com'},access_token:'tok'}};
window.__server=JSON.parse(sessionStorage.getItem('__srv')||'null')||{pub:{},stay:{properties:{},bookings:{},expenses:{},staff:{},loans:{},loan_repayments:{}},
  publicWrites:0,stayCalls:0,clock:Date.parse('2026-11-15T04:00:00Z'),receipts:0};
const save=()=>sessionStorage.setItem('__srv',JSON.stringify(window.__server));
const now=()=>new Date(window.__server.clock+=1000).toISOString();
const DEF={bookings:{status:'confirmed',round_off:0,round_off_hand:false,msg_sent:{},ical_gone:false,gap_closed:{}},
  expenses:{category:'other',amount:0,paid:false},properties:{rented_as_whole_unit:false,checkin_time:'13:00:00',checkout_time:'11:00:00',house_rules:[]},
  staff:{active:true},loans:{status:'active'},loan_repayments:{mode:'direct'}};
window.__stayWrite=(t,id,f)=>{const r=window.__server.stay[t][id];Object.assign(r,f);r.version++;r.updated_at=now();save();};
function applyChange(t,row,base){
  const S=window.__server,tab=S.stay[t],cur=tab[row.id];S.stayCalls++;
  if(base===null){ if(cur)return{status:'conflict',server:cur};
    const r=Object.assign({},DEF[t]||{},row,{version:1,created_at:now(),updated_at:now()});tab[row.id]=r;save();return{status:'ok',row:r};}
  if(!cur)return{status:'missing'};
  if(cur.version!==base)return{status:'conflict',server:cur};
  Object.assign(cur,row);cur.version++;cur.updated_at=now();save();return{status:'ok',row:cur};
}
function q(schema,table){
  const S=window.__server,st={f:[],gt:null,op:'select',val:null};
  const api={select(){return api;},eq(k,v){st.f.push([k,v]);return api;},gt(k,v){st.gt=v;return api;},is(){return api;},not(){return api;},
    order(){return api;},range(){return api;},limit(){return api;},
    update(v){st.op='update';st.val=v;return api;},delete(){st.op='delete';return api;},
    upsert(v){st.op='upsert';st.val=v;return api;},insert(v){st.op='insert';st.val=v;return api;},
    then(res,rej){
      if(schema==='public'){ if(st.op!=='select'&&table!=='app_status'){S.publicWrites++;save();}
        const rows=(S.pub[table]||[]);return Promise.resolve({data:rows,error:null}).then(res,rej);}
      if(table==='sync_status'||table==='ical_events'||table==='members'){if(table==='members')return Promise.resolve({data:[{account_id:'acct-1',role:'owner',accounts:{name:'Raaya Vasyam'}}],error:null}).then(res,rej);
        return Promise.resolve({data:[],error:null}).then(res,rej);}
      const rows=Object.values(S.stay[table]||{}).filter(r=>st.f.every(([k,v])=>r[k]===v)&&(!st.gt||r.updated_at>st.gt))
        .sort((a,b)=>a.updated_at.localeCompare(b.updated_at));
      return Promise.resolve({data:JSON.parse(JSON.stringify(rows)),error:null}).then(res,rej);
    }};
  return api;
}
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:window.__auth.session}}),signOut:async()=>({error:null}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  functions:{async invoke(){return{data:window.__invokeData||{},error:null};}},
  from:t=>q('public',t),
  rpc:async()=>({data:null,error:null}),
  schema:s=>({from:t=>q(s,t),async rpc(name,a){
    if(name==='apply_change')return{data:JSON.parse(JSON.stringify(applyChange(a.p_table,a.p_row,a.p_base_version))),error:null};
    if(name==='issue_receipt'){const b=window.__server.stay.bookings[a.p_booking];
      if(!b.receipt_no){b.receipt_no='RV/2026-27/0'+(41+window.__server.receipts++);b.receipt_on='2026-11-15';b.version++;b.updated_at=now();save();}
      return{data:b.receipt_no,error:null};}
    return{data:null,error:{message:'no '+name}};}}),
})};`;

const SEED = { properties: [{ id: 'p1', name: 'Raaya Vasyam' }], staff: [{ id: 's1', name: 'Lakshmi', dailyWage: 500, active: true }],
  loans: [{ id: 'l1', staffId: 's1', principal: 5000, installmentAmount: 1000, disbursedOn: D(-40), firstDueDate: D(-10), status: 'active', repayments: [] }],
  expenses: [], attendance: [],
  bookings: [{ id: 'b1', propertyId: 'p1', guestName: 'Anita Rao', phone: '9876543210', checkIn: D(1), checkOut: D(3), guests: 2,
    totalAmount: 6000, paid: 6000, source: 'Direct', status: 'confirmed', notes: '', msgSent: {} }] };

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  const ctxs = [];
  const open = async (o = {}) => {
    const ctx = o.ctx || await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    if (!o.ctx) {
      ctxs.push(ctx);
      for (const g of ['**://*.supabase.co/**', '**fonts.googleapis.com**', '**cdn.jsdelivr.net**']) await ctx.route(g, r => r.abort());
      await ctx.route('**vendor/supabase.umd.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    }
    const page = await ctx.newPage(); const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    if (!o.ctx) await page.addInitScript(([s, o]) => {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      localStorage.setItem('staylog_v2', JSON.stringify(s));
      localStorage.setItem('staylog_owner', 'u1');
      if (o.pin) localStorage.setItem('staylog_auth', JSON.stringify(o.pin));
      if (o.model) localStorage.setItem('staylog_model', JSON.stringify({ mode: 'stay', user: 'u1', account: 'acct-1' }));
      if (o.stay) sessionStorage.setItem('__srv', JSON.stringify(o.stay));
    }, [SEED, o]);
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    await page.waitForTimeout(300);
    return { ctx, page, errs, dialogs };
  };
  const typePin = async (page, pin) => { for (const d of pin)
    await page.locator('.numkey').filter({ hasText: new RegExp('^' + d + '$') }).dispatchEvent('pointerup');
    await page.waitForTimeout(700); };
  const auth = page => page.evaluate(() => JSON.parse(localStorage.getItem('staylog_auth') || 'null'));

  console.log('\n— the PIN is kept as a salted hash —');
  { const { ctx, page, errs } = await open({ pin: { pin: '1234' } });
    await typePin(page, '9999');
    ok('a wrong PIN is refused', !(await page.evaluate(() => state.loggedIn)));
    await page.waitForTimeout(600);
    await typePin(page, '1234');
    ok('an old plain PIN still opens the app', await page.evaluate(() => state.loggedIn));
    const a = await auth(page);
    ok('…and is converted on the spot: salted PBKDF2, no PIN kept', a && a.v === 2 && a.hash && a.salt && a.iter >= 100000 && !('pin' in a), a);
    ok('the PIN appears nowhere in storage', !JSON.stringify(a).includes('1234'));
    await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading); await page.waitForTimeout(200);
    await typePin(page, '1235');
    ok('after a restart a wrong PIN is still refused', !(await page.evaluate(() => state.loggedIn)));
    await page.waitForTimeout(600);                        // the pad clears after a wrong PIN
    await typePin(page, '1234');
    ok('and the right one opens it', await page.evaluate(() => state.loggedIn));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }
  { const { ctx, page } = await open({});
    await typePin(page, '2580'); await typePin(page, '2580');
    const a = await auth(page);
    ok('a new PIN is hashed from the start', await page.evaluate(() => state.loggedIn) && a && a.hash && !('pin' in a), a);
    await ctx.close(); }

  const unlocked = async (o) => { const r = await open({ pin: { pin: '1234' }, ...o }); await typePin(r.page, '1234'); return r; };

  console.log('\n— dormant until the switch-over —');
  { const { ctx, page, errs } = await unlocked({});
    ok('sync.js is loaded and inactive', await page.evaluate(() => !!window.StayLogSync && window.StayLogSync.isActive() === false));
    await page.evaluate(() => mutateData(d => { d.bookings[0].notes = 'Dormant edit'; }));
    await page.waitForTimeout(300);
    ok('the app saves to its usual key, as before', /Dormant edit/.test(await page.evaluate(() => localStorage.getItem('staylog_v2'))));
    await page.evaluate(() => window.StayLogSync.sync({ manual: true }));
    ok('nothing goes to the new tables', await page.evaluate(() => window.__server.stayCalls) === 0);
    ok('the cloud panel is the old one', await page.evaluate(() => { state.modal = 'cloud'; render(); return !document.querySelector('[data-stay-sync]'); }));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— switched over —');
  const stay = { pub: {}, stay: { properties: {}, bookings: {}, expenses: {}, staff: {}, loans: {}, loan_repayments: {} },
    publicWrites: 0, stayCalls: 0, clock: Date.parse('2026-11-15T04:00:00Z'), receipts: 0 };
  const row = (extra) => ({ account_id: 'acct-1', version: 1, created_at: '2026-11-15T03:00:00.000Z', updated_at: '2026-11-15T03:00:00.000Z', deleted_at: null, legacy: null, ...extra });
  stay.stay.properties.p1 = row({ id: 'p1', name: 'Raaya Vasyam', rented_as_whole_unit: false, checkin_time: '13:00:00', checkout_time: '11:00:00', house_rules: [] });
  stay.stay.bookings.b9 = row({ id: 'b9', property_id: 'p1', guest_name: 'Kiran Shetty', phone: '9900990099', check_in: D(5), check_out: D(7), guests: 3,
    source: 'Direct', status: 'confirmed', total_amount: 9000, paid: 3000, round_off: 0, round_off_hand: false, msg_sent: {}, ical_gone: false, gap_closed: {} });
  { const { ctx, page, errs } = await unlocked({ model: true, stay });
    const oldCopy = await page.evaluate(() => localStorage.getItem('staylog_v2'));
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(300);
    ok('the server\'s bookings arrive in the app', await page.evaluate(() => state.data.bookings.some(b => b.id === 'b9' && b.guestName === 'Kiran Shetty' && b.paid === 3000)));
    ok('the old copy is not loaded into the new model', await page.evaluate(() => !state.data.bookings.some(b => b.id === 'b1')));
    await page.evaluate(() => mutateData(d => { d.bookings.find(b => b.id === 'b9').notes = 'Vegetarian breakfast'; }));
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(300);
    ok('an edit goes up as that one field', await page.evaluate(() => window.__server.stay.bookings.b9.notes === 'Vegetarian breakfast' && window.__server.stay.bookings.b9.version === 2));
    ok('the old copy on this phone is never written', await page.evaluate(() => localStorage.getItem('staylog_v2')) === oldCopy);
    ok('the new copy is kept under its own key', await page.evaluate(async () => {
      const d = await idbGet('staylog_stay_data:u1:acct-1'); return !!(d && d.bookings.some(b => b.notes === 'Vegetarian breakfast')); }));
    await page.evaluate(() => window.StayLogCloud.push(state.data, { manual: true }).catch(() => {}));
    await page.evaluate(() => window.StayLogCloud.checkIn(true));
    ok('the old sync stands down: nothing written to the old tables', await page.evaluate(() => window.__server.publicWrites) === 0);
    ok('the menu line speaks for the new sync', /Synced|Not synced/.test(await page.evaluate(() => cloudMenuSub())), await page.evaluate(() => cloudMenuSub()));

    // A conflict on money: another device saved a payment first.
    await page.evaluate(() => window.__stayWrite('bookings', 'b9', { paid: 9000 }));
    await page.evaluate(() => mutateData(d => { d.bookings.find(b => b.id === 'b9').paid = 5000; }));
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(300);
    ok('the saved payment stands (no blind overwrite)', await page.evaluate(() => window.__server.stay.bookings.b9.paid === 9000 && state.data.bookings.find(b => b.id === 'b9').paid === 9000));
    await page.evaluate(() => { state.modal = 'cloud'; render(); }); await page.waitForTimeout(200);
    const box = await page.locator('[data-sync-conflict="bookings:b9"]').innerText().catch(() => '');
    ok('the Sync panel names it, as money, with both amounts', /Money changed on another device/.test(box) && /Kiran Shetty/.test(box) && /Payment received/.test(box)
      && /₹9,000/.test(box) && /₹5,000/.test(box), box);
    ok('the menu says there is something to look at', /1 change to look at/.test(await page.evaluate(() => cloudMenuSub())));
    await page.click('[data-sync-reapply]'); await page.waitForTimeout(500);
    ok('"Use mine" puts mine on the server', await page.evaluate(() => window.__server.stay.bookings.b9.paid === 5000 && state.data.bookings.find(b => b.id === 'b9').paid === 5000));
    ok('…and the conflict is gone', await page.locator('[data-sync-conflict]').count() === 0);

    console.log('\n— receipts from the server —');
    ok('without a server number, the phone does not make one up', await page.evaluate(() => ensureReceiptNo(state.data.bookings.find(b => b.id === 'b9')) === null));
    const no = await page.evaluate(async () => { const b = state.data.bookings.find(x => x.id === 'b9'); await stayReceiptNo(b); return b.receiptNo; });
    ok('the number comes from stay.issue_receipt', no === 'RV/2026-27/041', no);
    ok('and is kept on the booking', await page.evaluate(() => state.data.bookings.find(b => b.id === 'b9').receiptNo === 'RV/2026-27/041'));
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— v68: the calendar import is the server\'s —');
  { const st = JSON.parse(JSON.stringify(stay));
    st.stay.ical_feeds = { f1: { account_id: 'acct-1', id: 'f1', property_id: 'p1', platform: 'Airbnb', url: 'https://www.airbnb.com/calendar/ical/1.ics?s=made-up',
      connected: true, last_fetched_at: '2026-11-15T03:30:00Z', last_ok_at: '2026-11-15T03:30:00Z', last_error: null, last_count: 3, updated_at: '2026-11-15T03:30:00Z' } };
    st.stay.ical_runs = { 'acct-1': { account_id: 'acct-1', last_run_at: new Date(Date.now() - 10 * 60e3).toISOString(),
      result: { created: 1, updated: 0, gone: 0, held: 0, feeds: {} }, updated_at: '2026-11-15T03:30:00Z' } };
    const { ctx, page, errs } = await unlocked({ model: true, stay: st });
    await page.evaluate(() => window.StayLogSync.sync()); await page.waitForTimeout(300);
    await page.evaluate(() => { state.modal = 'cloud'; render(); }); await page.waitForTimeout(400);
    const log = await page.locator('[data-ical-log]').innerText().catch(() => '');
    ok('Calendar sync shows what the server\'s last run did, not an old log', /1 new booking/.test(log) && /checked/.test(log), log);
    ok('…and says the server makes the bookings, phone open or not', /even when no phone is open/.test(await page.locator('[data-ical-server]').innerText().catch(() => '')));
    await page.evaluate(() => { window.__invokeData = { ok: true, throttled: [{ account: 'acct-1', next_at: new Date(Date.now() + 3 * 60e3).toISOString() }] }; });
    await page.click('[data-ical-check]'); await page.waitForTimeout(600);
    const toast = await page.locator('[data-toast]').innerText().catch(() => '');
    ok('Check now within 5 minutes: says when it can be asked again', /Checked a few minutes ago\. You can check again at/.test(toast), toast);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— a payday repayment keeps its id —');
  { const { ctx, page } = await unlocked({});
    const ids = await page.evaluate(() => { const d = state.data;
      const exp = { id: 'e1', staffId: 's1', loanId: 'l1', loanDeduction: 500, paid: true, date: today(), description: 'Wage' };
      syncExpenseLoan(d, exp); const a = d.loans[0].repayments.map(r => r.id);
      exp.loanDeduction = 400; syncExpenseLoan(d, exp); const b = d.loans[0].repayments.map(r => r.id + ':' + r.amount);
      return { a, b }; });
    ok('saving the expense again rebuilds the row under the same id', ids.a.length === 1 && ids.b.length === 1 && ids.b[0] === ids.a[0] + ':400', ids);
    await ctx.close(); }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
