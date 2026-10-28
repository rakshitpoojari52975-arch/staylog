/* Utensil cleaning, beside attendance. Her mark becomes one unpaid staff
   expense at her utensil rate — a line of its own, so a checkout day with
   utensils pays the checkout wage plus the rate. No rate: held, never invented.
   The once-a-day, present-first and undo rules are SQL's: tests/test_utensils_sql.js. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

// The guest-facing sentence that must not move, as it was written.
const UTENSIL_SENTENCE='If you’d prefer, our househelp can do this for you at a nominal charge of Rs. 100, payable directly to her.';

// Supabase with two mark tables (attendance, utensil_marks), stamps applied,
// everything pushed recorded. missing.<table> makes a table not exist yet;
// oldSchema refuses staff.utensil_rate the way PostgREST does.
const STUB = `
window.__server={attendance:[],utensil_marks:[],upserts:{},missing:{},oldSchema:false};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  from(table){const S=window.__server;const q={_f:[],_upd:null};const api={
    select(){return api;}, eq(k,v){q._f.push([k,v]);return api;},
    is(k,v){q._f.push([k,v,'is']);return api;}, not(){return api;},
    order(){return api;}, limit(){return api;},
    async upsert(rows){
      if(S.oldSchema&&table==='staff'&&rows.some(r=>'utensil_rate' in r))
        return{error:{code:'PGRST204',message:"Could not find the 'utensil_rate' column of 'staff' in the schema cache"}};
      (S.upserts[table]=S.upserts[table]||[]).push(...rows);return{error:null};},
    update(p){q._upd=p;return api;},
    then(res){
      const marks=table==='attendance'||table==='utensil_marks';
      if(marks&&S.missing[table])return Promise.resolve(res({data:null,error:{code:'PGRST205',message:"Could not find the table 'public."+table+"' in the schema cache"}}));
      if(!marks)return Promise.resolve(res({data:[],error:null}));
      const T=S[table];
      if(q._upd){const id=(q._f.find(f=>f[0]==='id')||[])[1];
        const row=T.find(r=>r.id===id); if(row)Object.assign(row,q._upd);
        return Promise.resolve(res({data:row?[{id:row.id}]:[],error:null}));}
      const wantsUnstamped=q._f.some(f=>f[0]==='expense_id'&&f[2]==='is');
      let rows=T.filter(r=>r.deleted_at==null);
      if(wantsUnstamped)rows=rows.filter(r=>r.expense_id==null);
      return Promise.resolve(res({data:rows.map(r=>({id:r.id,staff_id:r.staff_id,date:r.date,expense_id:r.expense_id})),error:null}));
    }};return api;},
})};`;
const att=d=>({id:'att_stf1_202610'+d,staff_id:'stf1',date:'2026-10-'+d,expense_id:null,deleted_at:null});
const ute=d=>({id:'ute_stf1_202610'+d,staff_id:'stf1',date:'2026-10-'+d,expense_id:null,deleted_at:null});
const SEED=o=>Object.assign({properties:[{id:'p1',name:'Raaya Vasyam'}],
  staff:[{id:'stf1',name:'Laxmi Walikar',dailyWage:300,checkoutWage:500,utensilRate:100,active:true}],
  loans:[],bookings:[],expenses:[],attendance:[]},o);

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async seed=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  page.on('dialog',d=>d.accept());
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));
    ['staylog_att_log','staylog_att_last','staylog_ute_last'].forEach(k=>localStorage.removeItem(k));},seed);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(async()=>{await window.StayLogCloud.restoreSession();});
  return {ctx,page,errs};
};
const sync=async(page,marks)=>{
  if(marks)await page.evaluate(m=>{window.__server.attendance=m.att;window.__server.utensil_marks=m.ute;},marks);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  await page.waitForTimeout(250);
};
const exps=page=>page.evaluate(()=>state.data.expenses.map(e=>({id:e.id,amount:e.amount,desc:e.description,paid:e.paid,
  category:e.category,staffId:e.staffId,date:e.date})).sort((a,b)=>a.id.localeCompare(b.id)));

console.log('\n— her mark becomes an expense —');
{ const {ctx,page,errs}=await open(SEED({}));
  await sync(page,{att:[att('12')],ute:[ute('12')]});
  const e=(await exps(page)).find(x=>x.id==='ute_stf1_20261012');
  ok('one unpaid staff expense at the utensil rate', e&&e.amount===100&&e.paid===false&&e.category==='staff'&&e.staffId==='stf1', e);
  ok('named as asked', e&&e.desc==='Utensil cleaning — Laxmi Walikar · 12 Oct', e&&e.desc);
  ok('beside the day\'s wage, not instead of it', (await exps(page)).some(x=>x.id==='wag_stf1_20261012'&&x.amount===300));
  ok('the mark is ticked off in the cloud', (await page.evaluate(()=>window.__server.utensil_marks[0].expense_id))==='ute_stf1_20261012');
  await sync(page); await sync(page);
  ok('syncing again creates no duplicate', (await exps(page)).filter(x=>x.id.startsWith('ute_')).length===1);
  const up=await page.evaluate(()=>(window.__server.upserts.expenses||[]).filter(e=>e.id.startsWith('ute_')));
  ok('and it goes up as an ordinary expense', up.length>0&&up.every(e=>e.amount===100&&e.paid===false), up.slice(-1));
  ok('the utensil table is never pushed as app data', !(await page.evaluate(()=>Object.keys(window.__server.upserts))).includes('utensil_marks'));
  // you delete it: it stays deleted
  await page.evaluate(()=>mutateData(d=>{d.expenses=d.expenses.filter(e=>e.id!=='ute_stf1_20261012');}));
  await sync(page);
  ok('a utensil expense you delete stays deleted', !(await exps(page)).some(x=>x.id.startsWith('ute_')));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

{ const s=SEED({}); s.staff[0].utensilRate='';
  const {ctx,page}=await open(s);
  await sync(page,{att:[att('12')],ute:[ute('12')]});
  ok('a blank rate holds it: no expense', !(await exps(page)).some(x=>x.id.startsWith('ute_')));
  ok('and no invented amount, and the mark stays open in the cloud', (await page.evaluate(()=>window.__server.utensil_marks[0].expense_id))===null);
  ok('the wage itself is unaffected', (await exps(page)).some(x=>x.id==='wag_stf1_20261012'&&x.amount===300));
  const st=await page.evaluate(()=>window.StayLogCloud.status().utensils);
  ok('it is reported as held', st.held===1, st);
  await page.evaluate(()=>{state.loggedIn=true;state.modal='cloud';render();}); await page.waitForTimeout(300);
  ok('the cloud panel says why, and for whom',
     /1 utensil cleaning mark is waiting — no utensil cleaning rate is set for Laxmi Walikar/.test(await page.locator('[data-ute-held]').innerText().catch(()=>'')));
  await page.evaluate(()=>{state.modal=null;mutateData(d=>{d.staff[0].utensilRate='120';});});
  await sync(page);
  ok('set the rate and it converts at the next sync', (await exps(page)).find(x=>x.id==='ute_stf1_20261012')?.amount===120);
  await ctx.close(); }

console.log('\n— a separate line —');
{ const {ctx,page}=await open(SEED({bookings:[{id:'b1',propertyId:'p1',guestName:'G',checkIn:'2026-10-10',checkOut:'2026-10-12',
    guests:2,totalAmount:3000,paid:0,source:'Direct',status:'confirmed'}]}));
  await sync(page,{att:[att('12')],ute:[ute('12')]});
  const all=await exps(page), w=all.find(x=>x.id==='wag_stf1_20261012'), u=all.find(x=>x.id==='ute_stf1_20261012');
  ok('a checkout day with utensils pays both', w&&w.amount===500&&u&&u.amount===100, all);
  // bookings change: the wage is re-priced, the utensil line is not
  await page.evaluate(()=>mutateData(d=>{d.bookings[0].status='cancelled';}));
  const all2=await exps(page);
  ok('re-pricing the wage leaves the utensil line alone',
     all2.find(x=>x.id==='wag_stf1_20261012').amount===300&&all2.find(x=>x.id==='ute_stf1_20261012').amount===100, all2);
  // the Pay sheet
  await page.evaluate(()=>{state.loggedIn=true;state.modal='settleWages';state.editItem=state.data.staff[0];render();});
  await page.waitForTimeout(300);
  const rows=await page.locator('[data-exp]').allInnerTexts();
  ok('both appear on the Pay sheet with the other unpaid days', rows.length===2&&rows.some(t=>/Utensil cleaning/.test(t)), rows);
  ok('and the total pays both', /Mark ₹400 as paid/.test(await page.locator('button',{hasText:/^Mark .* as paid$/}).innerText()));
  await ctx.close(); }

{ // a utensil rate equal to the daily wage must still never be taken for a wage
  const s=SEED({}); s.staff[0].utensilRate=300;
  const {ctx,page}=await open(s);
  await sync(page,{att:[att('12')],ute:[ute('12')]});
  await page.evaluate(()=>mutateData(d=>{d.bookings.push({id:'late',propertyId:'p1',guestName:'Late',checkIn:'2026-10-10',
    checkOut:'2026-10-12',guests:1,totalAmount:0,paid:0,source:'Airbnb',status:'confirmed'});}));
  const all=await exps(page);
  ok('a late checkout re-prices the wage', all.find(x=>x.id==='wag_stf1_20261012').amount===500, all);
  ok('but never the utensil line, even at the same amount as a wage', all.find(x=>x.id==='ute_stf1_20261012').amount===300
     &&!/checkout/.test(all.find(x=>x.id==='ute_stf1_20261012').desc), all);
  await ctx.close(); }

console.log('\n— before utensils.sql has been run —');
{ const {ctx,page,errs}=await open(SEED({}));
  await page.evaluate(()=>{window.__server.missing.utensil_marks=true;});
  await sync(page,{att:[att('12')],ute:[]});
  const st=await page.evaluate(()=>window.StayLogCloud.status());
  ok('attendance and the sync carry on as before', !st.lastError&&(await exps(page)).some(x=>x.id==='wag_stf1_20261012'), st.lastError);
  ok('and nothing is reported as wrong', !st.utensils.error&&st.utensils.held===0, st.utensils);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

{ const {ctx,page}=await open(SEED({}));
  await page.evaluate(()=>{window.__server.oldSchema=true;window.__server.upserts={};});
  const r=await page.evaluate(async()=>{try{await window.StayLogCloud.push(state.data);return'ok';}catch(e){return e.message;}});
  const v=await page.evaluate(()=>({st:window.StayLogCloud.status(),staff:window.__server.upserts.staff||[]}));
  // The minimal cloud never sends a rate, so a database without the column has nothing to refuse.
  ok('a database without staff.utensil_rate syncs: no rate is ever sent', r==='ok'&&v.staff.length>0&&!v.staff.some(s=>'utensil_rate' in s||'checkout_wage' in s), {r,v:v.staff});
  ok('and there is no script to ask for', v.st.schemaBehind==='', v.st.schemaBehind);
  await ctx.close(); }

console.log('\n— the staff record —');
{ const {ctx,page,errs}=await open(SEED({}));
  await page.evaluate(()=>{state.loggedIn=true;state.modal='addStaff';state.editItem=state.data.staff[0];render();});
  await page.waitForTimeout(250);
  const box=page.locator('input[placeholder="Utensil cleaning rate (₹)"]');
  ok('the form has a Utensil cleaning rate field', await box.count()===1&&await box.inputValue()==='100');
  await box.fill('150'); await page.locator('button',{hasText:'Update Staff'}).click(); await page.waitForTimeout(200);
  ok('saving keeps it', (await page.evaluate(()=>state.data.staff[0].utensilRate))==='150');
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  ok('and it stays on the phone: the rate is not sent to the cloud', !('utensil_rate' in (await page.evaluate(()=>(window.__server.upserts.staff||[]).slice(-1)[0]))));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— her page —');
const staffPage=async standing=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  const STAFF_STUB=`window.__calls=[];window.__standing=${JSON.stringify(standing)};
    window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:{user:{id:'u-laxmi'}}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    rpc:async(n)=>{window.__calls.push(n);
      if(n==='staff_calendar')return{data:[],error:null};
      if(n==='staff_standing')return{data:window.__standing,error:null};
      if(n==='staff_mark_utensils_today'){Object.assign(window.__standing.utensils,{marked:true,marked_at:new Date().toISOString(),can_undo:true});return{data:{ok:true},error:null};}
      if(n==='staff_unmark_utensils_today'){Object.assign(window.__standing.utensils,{marked:false,undone_at:new Date().toISOString(),can_undo:false});return{data:{ok:true},error:null};}
      return{data:{ok:true},error:null};}})};`;
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STAFF_STUB}));
  const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',d=>d.accept());
  await page.goto(base+'/staff.html'); await page.waitForTimeout(700);
  return {ctx,page,errs};
};
const STANDING=(over)=>Object.assign({name:'Laxmi',
  attendance:{today:'2026-10-18',marked:false,this_month:3,can_undo:false},
  utensils:{available:false,marked:false,can_undo:false,locked:false},
  pending:{amount:600,count:2,oldest:'2026-10-12',earlier:0,days:[
    {date:'2026-10-12',gross:500,deducted:0,net:500,note:'Wage — Laxmi · 12 Oct · checkout day',checkout:true,kind:'wage'},
    {date:'2026-10-12',gross:100,deducted:0,net:100,note:'Utensil cleaning — Laxmi · 12 Oct',checkout:false,kind:'utensils'}]},
  this_month:{amount:600,deducted:0},overall:{paid:0,deducted:0},last_payout:null,loans:[]},over);
{ const {ctx,page,errs}=await staffPage(STANDING({}));
  const t=await page.locator('body').innerText();
  ok('"I cleaned the utensils today" sits under "I came in today"', /I came in today[\s\S]*I cleaned the utensils today/.test(t), t.slice(0,300));
  ok('with its line beneath', /I cleaned the utensils today\s*Only if a guest didn’t pay you for it\./.test(t), t.slice(0,400));
  ok('not available before she is marked present', await page.locator('[data-ute-btn]').isDisabled());
  ok('and it says why', /Available once you have marked yourself present/.test(t));
  await page.locator('button',{hasText:'See the days'}).click(); await page.waitForTimeout(150);
  const kinds=await page.locator('[data-line-kind]').evaluateAll(els=>els.map(e=>e.getAttribute('data-line-kind')+':'+e.textContent));
  ok('each line in her breakdown says what it is', kinds.length===2&&kinds.includes('wage:Wage · Checkout day')&&kinds.includes('utensils:Utensil cleaning'), kinds);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

{ const {ctx,page,errs}=await staffPage(STANDING({attendance:{today:'2026-10-18',marked:true,marked_at:new Date().toISOString(),this_month:4,can_undo:true},
    utensils:{available:true,marked:false,can_undo:false,locked:false}}));
  ok('once present, it can be tapped', !(await page.locator('[data-ute-btn]').isDisabled()));
  await page.locator('[data-ute-btn]').click(); await page.waitForTimeout(500);
  ok('tapping it calls the utensil function', (await page.evaluate(()=>window.__calls)).includes('staff_mark_utensils_today'));
  ok('and she sees it saved, with an undo', /Utensils cleaned/.test(await page.locator('body').innerText())&&await page.locator('[data-ute-undo]').count()===1);
  await page.locator('[data-ute-undo]').click(); await page.waitForTimeout(500);
  ok('undo calls the utensil undo', (await page.evaluate(()=>window.__calls)).includes('staff_unmark_utensils_today'));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

{ const old=STANDING({}); delete old.utensils; old.pending.days.forEach(d=>delete d.kind); old.pending.days.pop();
  const {ctx,page,errs}=await staffPage(old);
  ok('against a database without utensils.sql, the page offers nothing it cannot do', await page.locator('[data-utensils]').count()===0);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— nothing guest-facing moved —');
{ const {ctx,page}=await open(SEED({}));
  const notes=await page.evaluate(()=>HOUSE_NOTES);
  const v=notes.find(n=>n[0]==='Vessels & Utensils');
  ok('the house notes still contain the original utensil sentence, word for word', !!v&&v[1].includes(UTENSIL_SENTENCE), v);
  ok('and that note is unchanged as a whole',
     v&&v[1]==='As mentioned in the house rules, please clean vessels after use. '+UTENSIL_SENTENCE, v);
  await ctx.close();
  // every guest-facing block is identical to the last release
  let base='';try{base=execFileSync('git',['show','origin/main:app.js'],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{}
  if(base){
    const now=fs.readFileSync(ROOT+'/app.js','utf8');
    const block=(s,a,b)=>{const i=s.indexOf(a);return i<0?null:s.slice(i,s.indexOf(b,i));};
    ok('the house notes block is byte-for-byte as before',
       block(now,'const HOUSE_NOTES=[','];')===block(base,'const HOUSE_NOTES=[','];'));
  } else console.log('  (no origin/main to compare against; skipped the byte-for-byte check)'); }

console.log('\n— the release is stamped —');
{ const app=fs.readFileSync(ROOT+'/app.js','utf8'), sw=fs.readFileSync(ROOT+'/sw.js','utf8');
  ok('app version and service worker cache move together',
     app.match(/APP_VERSION='v(\d+)'/)[1]===sw.match(/CACHE_NAME = 'staylog-v(\d+)'/)[1]); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
