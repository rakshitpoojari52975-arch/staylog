/* Checkout-day wages. A marked day pays the daily wage, or the checkout-day
   wage if any booking that is not cancelled checks out that day — once,
   however many leave, turnover days included. Unpaid days the app priced are
   re-priced whenever bookings change; paid days and hand-edited amounts never. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

// Supabase: attendance marks to drain, everything pushed recorded. With
// __server.oldSchema set it refuses the new columns the way PostgREST does.
const STUB = `
window.__server={attendance:[],upserts:{},oldSchema:false,refused:0};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  rpc:async()=>({data:null,error:null}),
  from(table){const S=window.__server;const q={_f:[],_upd:null};const api={
    select(){return api;}, eq(k,v){q._f.push([k,v]);return api;},
    is(k,v){q._f.push([k,v,'is']);return api;}, not(){return api;},
    order(){return api;}, limit(){return api;},
    async upsert(rows){
      const NEW={staff:['checkout_wage'],expenses:['wage_kind','auto_amount']}[table]||[];
      const bad=S.oldSchema&&NEW.find(c=>rows.some(r=>c in r));
      if(bad){S.refused++;return{error:{code:'PGRST204',message:"Could not find the '"+bad+"' column of '"+table+"' in the schema cache"}};}
      (S.upserts[table]=S.upserts[table]||[]).push(...rows);return{error:null};},
    update(p){q._upd=p;return api;},
    then(res){
      if(table!=='attendance')return Promise.resolve(res({data:[],error:null}));
      if(q._upd){const id=(q._f.find(f=>f[0]==='id')||[])[1];
        const row=S.attendance.find(r=>r.id===id); if(row)Object.assign(row,q._upd);
        return Promise.resolve(res({data:row?[{id:row.id}]:[],error:null}));}
      const wantsUnstamped=q._f.some(f=>f[0]==='expense_id'&&f[2]==='is');
      let rows=S.attendance.filter(r=>r.deleted_at==null);
      if(wantsUnstamped)rows=rows.filter(r=>r.expense_id==null);
      return Promise.resolve(res({data:rows.map(r=>({id:r.id,staff_id:r.staff_id,date:r.date,expense_id:r.expense_id})),error:null}));
    }};return api;},
})};`;

const mark=d=>({id:'att_stf1_202610'+d,staff_id:'stf1',date:'2026-10-'+d,expense_id:null,deleted_at:null});
const bk=(id,cin,cout,o)=>Object.assign({id,propertyId:'p1',guestName:'Guest '+id,checkIn:'2026-10-'+cin,checkOut:'2026-10-'+cout,
  guests:2,totalAmount:3000,paid:0,source:'Direct',status:'confirmed'},o);
const wage=(d,o)=>Object.assign({id:'wag_stf1_202610'+d,staffId:'stf1',category:'staff',propertyId:'p1',
  description:'Wage — Lakshmi Walikar · '+d+' Oct',date:'2026-10-'+d,amount:300,grossAmount:300,
  loanId:'',loanDeduction:0,paid:false,fromAttendance:'att_stf1_202610'+d},o);
const SEED=o=>Object.assign({properties:[{id:'p1',name:'Raaya Vasyam'}],
  staff:[{id:'stf1',name:'Lakshmi Walikar',dailyWage:300,checkoutWage:500,active:true}],
  loans:[],bookings:[],expenses:[],attendance:[]},o);

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(seed,page_='/index.html')=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));
    localStorage.removeItem('staylog_att_log');localStorage.removeItem('staylog_att_last');},seed);
  await page.goto(base+page_);
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  return {ctx,page,errs};
};
// Her marks in the cloud, then a sync: the drain turns them into expenses.
const drain=async(page,days)=>{
  await page.evaluate(ms=>{window.__server.attendance=ms;},days.map(mark));
  await page.evaluate(async()=>{await window.StayLogCloud.restoreSession();await window.StayLogCloud.push(state.data);});
  await page.waitForTimeout(300);
};
const exp=(page,d)=>page.evaluate(id=>{const e=state.data.expenses.find(x=>x.id===id);
  return e&&{amount:e.amount,gross:e.grossAmount,auto:e.autoAmount,kind:e.wageKind,desc:e.description,paid:e.paid};},'wag_stf1_202610'+d);

console.log('\n— what a marked day pays —');
{ const {ctx,page,errs}=await open(SEED({bookings:[
    bk('b1','10','12'),                                   // checks out 12th
    bk('b2','11','14'), bk('b3','12','14'),               // two leave on the 14th
    bk('b4','13','15',{status:'cancelled'}),              // cancelled: its 15th does not count
    bk('b5','14','16'), bk('b6','16','18')]}));           // 16th: one leaves, one arrives
  await drain(page,['11','12','14','15','16']);
  let e=await exp(page,'11');
  ok('a normal day pays the daily wage', e&&e.amount===300&&e.kind==='daily', e);
  ok('and says nothing about checkouts', e&&!/checkout/.test(e.desc), e&&e.desc);
  e=await exp(page,'12');
  ok('a checkout day pays the checkout-day wage', e&&e.amount===500&&e.gross===500&&e.kind==='checkout', e);
  ok('and the description says so', e&&/· 12 Oct · checkout day$/.test(e.desc), e&&e.desc);
  ok('the app records the amount it set', e&&e.auto===500, e);
  e=await exp(page,'14');
  ok('two checkouts on one day pay it once', e&&e.amount===500, e);
  ok('one expense for the day, not two', (await page.evaluate(()=>state.data.expenses.filter(x=>x.date==='2026-10-14').length))===1);
  e=await exp(page,'15');
  ok('a cancelled booking\'s checkout does not count', e&&e.amount===300&&e.kind==='daily', e);
  e=await exp(page,'16');
  ok('a turnover day counts', e&&e.amount===500&&e.kind==='checkout', e);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

{ const s=SEED({bookings:[bk('b1','10','12')]}); s.staff[0].checkoutWage='';
  const {ctx,page}=await open(s);
  await drain(page,['12']);
  const e=await exp(page,'12');
  ok('a blank checkout-day wage falls back to the daily wage', e&&e.amount===300, e);
  ok('the day is still named as a checkout day', e&&e.kind==='checkout'&&/checkout day$/.test(e.desc), e);
  await ctx.close(); }

{ const s=SEED({bookings:[bk('b1','10','12')]}); s.staff[0].dailyWage='';
  const {ctx,page}=await open(s);
  await drain(page,['11','12']);
  ok('no daily wage: a checkout day is still paid its own rate', (await exp(page,'12'))?.amount===500);
  ok('but an ordinary day is held, not invented', !(await exp(page,'11'))
     &&(await page.evaluate(()=>window.StayLogCloud.status().heldMarks))===1);
  await ctx.close(); }

console.log('\n— bookings change after the day was priced —');
{ const {ctx,page,errs}=await open(SEED({}));
  await drain(page,['20','21','22','23']);
  ok('priced as ordinary days', (await exp(page,'20')).amount===300&&(await exp(page,'21')).amount===300);
  // a late iCal import, or a stay typed in, checking out on the 20th
  await page.evaluate(()=>mutateData(d=>{d.bookings.push({id:'late',propertyId:'p1',guestName:'Late',checkIn:'2026-10-18',
    checkOut:'2026-10-20',guests:1,totalAmount:0,paid:0,source:'Airbnb',status:'confirmed'});}));
  let e=await exp(page,'20');
  ok('a booking added afterwards re-prices the day', e.amount===500&&e.gross===500&&e.auto===500&&e.kind==='checkout', e);
  ok('and its description', /checkout day$/.test(e.desc), e.desc);
  ok('the next day is untouched', (await exp(page,'21')).amount===300);
  // an extended stay: the checkout moves from the 20th to the 21st
  await page.evaluate(()=>mutateData(d=>{d.bookings.find(b=>b.id==='late').checkOut='2026-10-21';}));
  e=await exp(page,'20');
  ok('an extended stay moves the rate off the old day', e.amount===300&&e.kind==='daily'&&!/checkout/.test(e.desc), e);
  ok('and onto the new one', (await exp(page,'21')).amount===500);
  await page.evaluate(()=>mutateData(d=>{d.bookings.find(b=>b.id==='late').status='cancelled';}));
  ok('cancelling it puts the day back', (await exp(page,'21')).amount===300);
  // the iCal import writes through STAYLOG_APPLY; that path re-prices too
  await page.evaluate(()=>window.STAYLOG_APPLY(d=>{d.bookings.push({id:'ics_x',propertyId:'p1',guestName:'Airbnb guest',
    checkIn:'2026-10-21',checkOut:'2026-10-22',guests:1,totalAmount:'',paid:'',source:'Airbnb',status:'confirmed'});}));
  ok('a calendar import re-prices too', (await exp(page,'22')).amount===500);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

{ const {ctx,page}=await open(SEED({}));
  await drain(page,['20','21','22']);
  await page.evaluate(()=>mutateData(d=>{
    d.expenses.find(e=>e.id==='wag_stf1_20261020').paid=true;           // paid
    d.expenses.find(e=>e.id==='wag_stf1_20261021').amount=350;          // edited by hand
    const x=d.expenses.find(e=>e.id==='wag_stf1_20261022');             // a loan cut taken on it
    Object.assign(x,{loanId:'loan1',loanDeduction:100,amount:200});}));
  await page.evaluate(()=>mutateData(d=>{['20','21','22'].forEach(n=>d.bookings.push({id:'co'+n,propertyId:'p1',guestName:'G',
    checkIn:'2026-10-1'+n.slice(1),checkOut:'2026-10-'+n,guests:1,totalAmount:0,paid:0,source:'Direct',status:'confirmed'}));}));
  const p=await exp(page,'20'), h=await exp(page,'21'), l=await exp(page,'22');
  ok('a paid expense never changes', p.amount===300&&p.kind==='daily'&&!/checkout/.test(p.desc), p);
  ok('a hand-edited amount never changes', h.amount===350, h);
  ok('nor one with a loan cut taken on it', l.amount===200, l);
  await ctx.close(); }

console.log('\n— days made before this release (run once now) —');
{ // no autoAmount, no wageKind: made at the daily wage, the only rate there was
  const {ctx,page}=await open(SEED({bookings:[bk('b1','10','12'),bk('b2','11','13'),bk('b3','12','14')],
    expenses:[wage('12'), wage('13',{amount:280,grossAmount:280}), wage('14',{paid:true}),
              wage('15')]}));
  ok('an unpaid day at the daily wage is re-priced when the app opens', (await exp(page,'12')).amount===500);
  ok('one at another amount was set by hand and is left', (await exp(page,'13')).amount===280);
  ok('a paid one is left', (await exp(page,'14')).amount===300);
  const n=await exp(page,'15');
  ok('an ordinary day is kept, and adopted so later changes can re-price it', n.amount===300&&n.auto===300&&n.kind==='daily', n);
  ok('and it is saved, not only shown', (await page.evaluate(()=>JSON.parse(localStorage.getItem('staylog_v2')).expenses
     .find(e=>e.id==='wag_stf1_20261012').amount))===500);
  await ctx.close(); }

{ // restored from the cloud: fromAttendance does not survive, the wag_ id does
  const {ctx,page}=await open(SEED({bookings:[bk('b1','10','12')],
    expenses:[(()=>{const w=wage('12',{autoAmount:300,wageKind:'daily'});delete w.fromAttendance;return w;})()]}));
  ok('a day restored from the cloud is still recognised as hers', (await exp(page,'12')).amount===500);
  await ctx.close(); }

console.log('\n— to and from Supabase —');
{ const {ctx,page}=await open(SEED({bookings:[bk('b1','10','12')]}));
  await drain(page,['12']);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  const up=await page.evaluate(()=>window.__server.upserts);
  const st=(up.staff||[]).slice(-1)[0], ex=(up.expenses||[]).filter(e=>e.id==='wag_stf1_20261012').slice(-1)[0];
  // The minimal cloud: rates stay on the phone; her page needs only the wage itself and its kind.
  ok('the staff record carries no rate: the checkout wage stays on the phone', st&&!('checkout_wage' in st)&&!('daily_wage' in st)
     &&(await page.evaluate(()=>state.data.staff[0].checkoutWage))===500, st);
  ok('the expense carries wage_kind (her "Checkout day" label) but not auto_amount', ex&&ex.wage_kind==='checkout'&&!('auto_amount' in ex)&&ex.amount===500, ex);
  await ctx.close(); }

{ const {ctx,page}=await open(SEED({bookings:[bk('b1','10','12')]}));
  await page.evaluate(()=>{window.__server.oldSchema=true;window.__server.upserts={};});
  await drain(page,['12']);
  const r=await page.evaluate(async()=>{try{await window.StayLogCloud.push(state.data);return'ok';}catch(e){return e.message;}});
  const v=await page.evaluate(()=>({st:window.StayLogCloud.status(),up:window.__server.upserts,refused:window.__server.refused}));
  ok('before the migration the sync still succeeds', r==='ok'&&!v.st.lastError, {r,err:v.st.lastError});
  ok('having been refused and retried without the new columns',
     v.refused>0&&(v.up.expenses||[]).length>0&&!(v.up.expenses||[]).some(e=>'wage_kind' in e)&&!(v.up.staff||[]).some(s=>'checkout_wage' in s), v);
  ok('the phone keeps the values', (await exp(page,'12')).kind==='checkout'
     &&(await page.evaluate(()=>state.data.staff[0].checkoutWage))===500);
  await page.evaluate(()=>{state.loggedIn=true;state.modal='cloud';render();}); await page.waitForTimeout(300);
  ok('and the cloud panel says which script to run',
     /Run supabase\/checkout-wage\.sql/.test(await page.locator('[data-schema-behind]').innerText().catch(()=>'')));
  await page.evaluate(async()=>{window.__server.oldSchema=false;await window.StayLogCloud.push(state.data);});
  ok('once it has been run, the note goes', (await page.evaluate(()=>window.StayLogCloud.status().schemaBehind))==='');
  await ctx.close(); }

console.log('\n— the staff record —');
{ const {ctx,page,errs}=await open(SEED({}));
  await page.evaluate(()=>{state.loggedIn=true;state.modal='addStaff';state.editItem=state.data.staff[0];render();});
  await page.waitForTimeout(250);
  const box=page.locator('input[placeholder="Checkout-day wage (₹)"]');
  ok('the form has a Checkout-day wage field, after Daily wage', await box.count()===1&&await box.inputValue()==='500'
     &&(await page.evaluate(()=>{const ins=[...document.querySelectorAll('input')].map(i=>i.placeholder);
        return ins.indexOf('Checkout-day wage (₹)')===ins.indexOf('Daily wage (₹)')+1;})));
  await box.fill('450'); await page.locator('button',{hasText:'Update Staff'}).click(); await page.waitForTimeout(200);
  ok('saving keeps it', (await page.evaluate(()=>state.data.staff[0].checkoutWage))==='450');
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— her page —');
{ const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  const STAFF_STUB=`window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:{user:{id:'u-lakshmi'}}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    rpc:async(n)=>n==='staff_calendar'?{data:[],error:null}:n==='staff_standing'?{data:{name:'Lakshmi',
      attendance:{today:'2026-10-17',marked:false,this_month:3},
      pending:{amount:800,count:2,oldest:'2026-10-11',earlier:0,days:[
        {date:'2026-10-12',gross:500,deducted:0,net:500,note:'Wage — Lakshmi Walikar · 12 Oct · checkout day',checkout:true},
        {date:'2026-10-11',gross:300,deducted:0,net:300,note:'Wage — Lakshmi Walikar · 11 Oct',checkout:false}]},
      this_month:{amount:800,deducted:0},overall:{paid:0,deducted:0},last_payout:null,loans:[]},error:null}:{data:null,error:null}})};`;
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STAFF_STUB}));
  const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(base+'/staff.html'); await page.waitForTimeout(800);
  await page.locator('button',{hasText:'See the days'}).click(); await page.waitForTimeout(200);
  const labels=await page.locator('[data-checkout-day]').count();
  const text=await page.locator('body').innerText();
  ok('the checkout day is labelled in her breakdown', labels===1&&/12 Oct[\s\S]*Checkout day/.test(text), text.slice(0,400));
  ok('the ordinary day is not', labels===1);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— the release is stamped —');
{ const app=fs.readFileSync(ROOT+'/app.js','utf8'), sw=fs.readFileSync(ROOT+'/sw.js','utf8');
  ok('app version and service worker cache move together',
     app.match(/APP_VERSION='v(\d+)'/)[1]===sw.match(/CACHE_NAME = 'staylog-v(\d+)'/)[1]); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
