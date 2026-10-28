/* The minimal cloud, from the phone's side: what a sync sends is the
   allowlist and nothing else — not a guest's name, a note, an amount, a
   receipt number, a rate, a UPI ID, and not a field invented after this test
   was written. There is no pull; an empty phone takes nothing out of the
   cloud; the first minimal sync explains itself once instead of tripping the
   brake, and the brake still guards every real deletion. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x).slice(0,500):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

// The allowlist, written out again here on purpose: if cloud.js ever widens
// what it sends, this copy does not follow and the test fails.
const ALLOW={
  properties:['id','owner_id','name'],
  staff:['id','owner_id','name'],
  bookings:['id','owner_id','property_id','check_in','check_out','guests','status','balance_due'],
  loans:['id','owner_id','staff_id','principal','installment_amount','disbursed_on','first_due_date','status'],
  loan_repayments:['id','owner_id','loan_id','amount'],
  expenses:['id','owner_id','staff_id','description','date','amount','gross_amount','loan_deduction','paid','wage_kind'],
};

const STUB = `
window.__db=window.__db||{};
const T=n=>(window.__db[n]=window.__db[n]||[]);
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  functions:{invoke:async()=>({data:{},error:null})},
  from(table){
    let op='select',payload=null,filters=[];
    const api={
      select(){return api;}, order(){return api;}, limit(){return api;},
      eq(k,v){filters.push(r=>String(r[k])===String(v));return api;},
      is(k,v){filters.push(r=>v===null?r[k]==null:r[k]===v);return api;},
      in(k,vs){filters.push(r=>vs.map(String).includes(String(r[k])));return api;},
      not(k,o,v){if(o==='in'){const l=String(v).replace(/^\\(|\\)$/g,'').split(',').map(x=>x.replace(/^"|"$/g,''));filters.push(r=>!l.includes(String(r[k])));}return api;},
      upsert(rows){op='upsert';payload=Array.isArray(rows)?rows:[rows];return api;},
      insert(rows){op='insert';payload=Array.isArray(rows)?rows:[rows];return api;},
      update(o){op='update';payload=o;return api;}, delete(){op='delete';return api;},
      then(res){
        const F=window.__fail&&window.__fail(table,op,payload); if(F)return Promise.resolve(res({data:null,error:F}));
        const rows=T(table), hit=r=>filters.every(f=>f(r));
        let data=null;
        if(op==='select')data=JSON.parse(JSON.stringify(rows.filter(hit)));
        if(op==='upsert'||op==='insert')payload.forEach(r=>{const i=rows.findIndex(x=>x.id!==undefined&&x.id===r.id);if(i>=0)Object.assign(rows[i],r);else rows.push({...r});});
        if(op==='update')rows.filter(hit).forEach(r=>Object.assign(r,payload));
        if(op==='delete')window.__db[table]=rows.filter(r=>!hit(r));
        (window.__db.__log=window.__db.__log||[]).push({table,op,payload:op==='select'?null:JSON.parse(JSON.stringify(payload))});
        return Promise.resolve(res({data,error:null}));
      }};
    return api;}
})};`;

const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const SECRETS=['Anita Raghunathan','9845012345','AADH-5512-8890','Prefers the upstairs room','RV/2026-27/014','staylog.test@fakebank',
  'Test Account · IFSC TEST0000000','TideAndPalm#2026','data:image/png;base64,SIGNATURE','LEAK-CANARY','9800000000','For her son','Groceries for the Rao family'];
const SEED=()=>({
  properties:[{id:'p1',name:'Raaya Vasyam',location:'Kaup',wifiName:'RaayaGuest',wifiPassword:'TideAndPalm#2026',upiId:'staylog.test@fakebank',
    bankDetails:'Test Account · IFSC TEST0000000',signature:'data:image/png;base64,SIGNATURE',pricePerNight:3000,futureField:'LEAK-CANARY'}],
  staff:[{id:'s1',name:'Laxmi Walikar',phone:'9800000000',role:'House help',dailyWage:300,checkoutWage:500,utensilRate:100,futureField:'LEAK-CANARY'}],
  loans:[{id:'l1',staffId:'s1',principal:5000,installmentAmount:500,disbursedOn:D(-60),firstDueDate:D(-30),status:'active',notes:'For her son',
           repayments:[{id:'r1',date:D(-30),amount:500,mode:'payout',expenseId:'wag_s1_x',note:'October'}]},
         {id:'l2',staffId:'',principal:900,installmentAmount:100,disbursedOn:D(-5),status:'active',notes:'not a staff loan',repayments:[{id:'r9',date:D(-1),amount:100}]}],
  expenses:[{id:'wag_s1_a',staffId:'s1',description:'Wage — Laxmi · checkout day',date:D(-2),category:'staff',amount:500,grossAmount:500,
             loanDeduction:0,paid:false,wageKind:'checkout',autoAmount:500,notes:'LEAK-CANARY',propertyId:'p1',loanId:'l1'},
            {id:'gro',description:'Groceries for the Rao family',date:D(-1),category:'supplies',amount:820,paid:true,notes:'receipt in drawer'}],
  attendance:[],
  bookings:[
    {id:'b1',propertyId:'p1',guestName:'Anita Raghunathan',phone:'9845012345',checkIn:D(-1),checkOut:D(1),guests:2,totalAmount:6000,paid:2000,
     source:'Direct',status:'checkedin',notes:'Prefers the upstairs room',idProofType:'Aadhaar',idProofNumber:'AADH-5512-8890',
     idProofImage:'data:image/jpeg;base64,PHOTO',receiptNo:'RV/2026-27/014',receiptOn:D(-1),msgSent:{confirm:D(-5)},roundOff:0,secretNewField:'LEAK-CANARY'},
    {id:'b2',propertyId:'p1',guestName:'Rahul Menon',phone:'9876500000',checkIn:D(3),checkOut:D(5),guests:3,totalAmount:5000,paid:5000,source:'Booking.com',status:'confirmed',msgSent:{}},
    {id:'b3',propertyId:'p1',guestName:'Mia Clarke',checkIn:D(6),checkOut:D(8),guests:2,totalAmount:7200,paid:0,source:'Airbnb',status:'confirmed',msgSent:{}},
    {id:'b4',propertyId:'p1',guestName:'Odd Paise',checkIn:D(9),checkOut:D(10),guests:1,totalAmount:4632.47,paid:4630,roundOff:2.47,source:'Direct',status:'confirmed',msgSent:{}}]});

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(seed,cloud)=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[], dialogs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',async d=>{dialogs.push(d.message());await d.dismiss();});
  await page.addInitScript(([s,c])=>{localStorage.setItem('staylog_v2',JSON.stringify(s));window.__db=c||{};
    window.__asked=[];window.STAYLOG_CONFIRM_TOMBSTONE_TEST=true;},[seed,cloud]);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(async()=>{window.STAYLOG_CONFIRM_TOMBSTONE=({plan,message})=>{window.__asked.push({plan,message});return false;};
    state.loggedIn=true;await StayLogCloud.restoreSession();render();});
  return {ctx,page,errs,dialogs};
};
const sync=page=>page.evaluate(async()=>{try{await StayLogCloud.push(state.data,{manual:true});return '';}catch(e){return e.message;}});
const log=page=>page.evaluate(()=>window.__db.__log||[]);

console.log('\n— what a sync sends —');
{ const {ctx,page,errs}=await open(SEED());
  ok('it syncs', await sync(page)==='');
  const L=await log(page), ups=L.filter(l=>l.op==='upsert'&&ALLOW[l.table]);
  ok('every mirrored table was written', Object.keys(ALLOW).every(t=>ups.some(u=>u.table===t)), ups.map(u=>u.table));
  const bad=[];
  ups.forEach(u=>u.payload.forEach(row=>Object.keys(row).forEach(k=>{if(!ALLOW[u.table].includes(k))bad.push(`${u.table}.${k}`);})));
  ok('every row carries only allowlisted columns', bad.length===0, bad);
  const wire=JSON.stringify(L);
  const leaked=SECRETS.filter(s=>wire.includes(s));
  ok('no guest name, phone, ID number, note, receipt number, UPI, bank, Wi-Fi, signature or rate went up', leaked.length===0, leaked);
  ok('a field added to a booking later (secretNewField) is not sent', !wire.includes('secretNewField')&&!wire.includes('futureField'));
  ok('no amount: total, paid or round off', !/total_amount|"paid":2000|round_off|price_per_night|daily_wage|checkout_wage|utensil_rate/.test(wire));
  const ex=ups.filter(u=>u.table==='expenses').flatMap(u=>u.payload);
  const ids=a=>[...new Set(a.map(x=>x.id))].join();     // the sync on opening and this one each send them
  ok('only staff payouts: the groceries stay on the phone', ids(ex)==='wag_s1_a'&&ex.every(e=>/^Wage — Laxmi/.test(e.description)&&e.wage_kind), ex);
  const lo=ups.filter(u=>u.table==='loans').flatMap(u=>u.payload), rp=ups.filter(u=>u.table==='loan_repayments').flatMap(u=>u.payload);
  ok('only staff loans, and only their repayments', ids(lo)==='l1'&&ids(rp)==='r1', {lo,rp});
  const bk=Object.fromEntries(ups.filter(u=>u.table==='bookings').flatMap(u=>u.payload).map(b=>[b.id,b.balance_due]));
  ok('balance_due: ₹4,000 for the Direct guest who owes it', bk.b1===4000, bk);
  ok('0 for the Booking.com guest who has paid', bk.b2===0, bk);
  ok('empty for Airbnb, which collects payment itself', bk.b3===null, bk);
  ok('0 for a Direct stay settled with a round off', bk.b4===0, bk);
  const st=L.filter(l=>l.table==='sync_status'&&l.op==='upsert').pop();
  ok('sync_status records the app version', st&&st.payload[0].app_version===await page.evaluate(()=>APP_VERSION)&&st.payload[0].app_version==='v51', st);
  ok('the phone still has everything', await page.evaluate(()=>state.data.bookings[0].guestName==='Anita Raghunathan'&&state.data.expenses.length===2&&state.data.properties[0].upiId));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— no pull —');
{ const {ctx,page}=await open(SEED());
  ok('StayLogCloud has no pull()', await page.evaluate(()=>typeof StayLogCloud.pull)==='undefined');
  await page.evaluate(()=>setState({modal:'cloud'})); await page.waitForTimeout(150);
  const t=await page.locator('body').innerText();
  ok('the cloud panel has no "Replace this phone from the cloud"', !/Replace this phone from the cloud/.test(t));
  ok('it points a new phone to Restore from backup', /New phone\? Sign in, then Encrypted backup → Restore from backup/.test(t));
  await ctx.close(); }

console.log('\n— an empty phone takes nothing out of the cloud —');
{ const cloud={bookings:[{id:'b1',owner_id:'owner-1',check_in:D(1),check_out:D(2),deleted_at:null},{id:'b2',owner_id:'owner-1',deleted_at:null}],
               expenses:[{id:'wag_s1_a',owner_id:'owner-1',staff_id:'s1',deleted_at:null}],properties:[{id:'p1',owner_id:'owner-1',deleted_at:null}]};
  const {ctx,page}=await open({properties:[],bookings:[],expenses:[],staff:[],loans:[],attendance:[]},cloud);
  ok('it syncs', await sync(page)==='');
  const L=await log(page);
  ok('no tombstone, no update, no delete was sent', !L.some(l=>l.op==='update'&&['properties','staff','bookings','loans','loan_repayments','expenses'].includes(l.table))&&!L.some(l=>l.op==='delete'), L.filter(l=>l.op!=='select').map(l=>l.table+':'+l.op));
  ok('the cloud rows are as they were', await page.evaluate(()=>window.__db.bookings.every(b=>b.deleted_at===null)&&window.__db.expenses[0].deleted_at===null));
  ok('and nothing was asked', (await page.evaluate(()=>window.__asked.length))===0);
  await ctx.close(); }

console.log('\n— the first minimal sync explains itself once —');
{ const seed=SEED();
  for(let i=0;i<7;i++)seed.expenses.push({id:'x'+i,description:'Supplies '+i,date:D(-i),amount:100,paid:true});
  // The cloud as the old full sync left it: every row of the phone, groceries and supplies included.
  const cloud={expenses:seed.expenses.map(e=>({id:e.id,owner_id:'owner-1',deleted_at:null})),
    bookings:seed.bookings.map(b=>({id:b.id,owner_id:'owner-1',deleted_at:null})),properties:[{id:'p1',owner_id:'owner-1',deleted_at:null}],
    staff:[{id:'s1',owner_id:'owner-1',deleted_at:null}],loans:[{id:'l1',owner_id:'owner-1',deleted_at:null},{id:'l2',owner_id:'owner-1',deleted_at:null}],
    loan_repayments:[{id:'r1',owner_id:'owner-1',deleted_at:null},{id:'r9',owner_id:'owner-1',deleted_at:null}]};
  const {ctx,page,errs}=await open(seed,cloud);
  ok('it syncs', await sync(page)==='');
  ok('without the deletion prompt, although 10 rows leave the cloud', (await page.evaluate(()=>window.__asked.length))===0);
  const gone=await page.evaluate(()=>Object.entries(window.__db).filter(([k])=>k!=='__log').flatMap(([t,rows])=>rows.filter(r=>r.deleted_at).map(r=>t+':'+r.id)).sort());
  ok('the 8 non-staff expenses, the non-staff loan and its repayment are taken out of the cloud',
     JSON.stringify(gone)===JSON.stringify(['expenses:gro',...[0,1,2,3,4,5,6].map(i=>'expenses:x'+i),'loan_repayments:r9','loans:l2'].sort()), gone);
  ok('every one of them is still on the phone', await page.evaluate(()=>state.data.expenses.length===9&&state.data.loans.length===2));
  await page.waitForTimeout(200);
  ok('a note says so: "Removing private details from the cloud"', /Removing private details from the cloud/.test(await page.locator('[data-toast]').innerText().catch(()=>'')));
  await page.evaluate(()=>setState({modal:'cloud'})); await page.waitForTimeout(150);
  ok('and the cloud panel explains it', /Removing private details from the cloud[\s\S]*10 rows[\s\S]*Nothing is deleted from this phone/.test(await page.locator('[data-privacy-note]').innerText()));
  ok('no page errors', errs.length===0, errs);
  // Once: a reload, a sync, no note.
  await page.reload(); await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(async()=>{window.STAYLOG_CONFIRM_TOMBSTONE=({plan,message})=>{window.__asked=(window.__asked||[]);window.__asked.push({plan,message});return false;};state.loggedIn=true;await StayLogCloud.restoreSession();});
  ok('the next sync is quiet', await sync(page)===''&&!(await page.evaluate(()=>StayLogCloud.status().privacyNote)));

  console.log('\n— the brake still guards every real deletion —');
  await page.evaluate(()=>{for(let i=0;i<6;i++)window.__db.bookings.push({id:'gone'+i,owner_id:'owner-1',deleted_at:null});});
  const m=await sync(page);
  const asked=await page.evaluate(()=>window.__asked||[]);
  ok('6 bookings this phone does not have: it stops and asks', asked.length===1&&/6 of 10 bookings/.test(asked[0].message), asked.map(a=>a.message));
  ok('naming only the real deletions', asked[0]&&asked[0].plan.length===1&&asked[0].plan[0].table==='bookings', asked[0]&&asked[0].plan);
  ok('and the answer No writes nothing', /^Sync paused/.test(m)&&await page.evaluate(()=>window.__db.bookings.filter(b=>/^gone/.test(b.id)).every(b=>!b.deleted_at)), m);
  ok('the message points a new phone to Restore from backup', /Encrypted backup → Restore from backup/.test(asked[0]&&asked[0].message));
  await ctx.close(); }

console.log('\n— before minimal-cloud.sql has run —');
{ const {ctx,page}=await open(SEED());
  await page.evaluate(()=>{window.__fail=(t,op,p)=>t==='bookings'&&op==='upsert'
    ?{code:'23502',message:'null value in column "guest_name" of relation "bookings" violates not-null constraint'}:null;});
  const m=await sync(page);
  ok('the old NOT NULL columns stop the sync with a plain instruction', /Run supabase\/minimal-cloud\.sql in the Supabase SQL editor/.test(m)&&/Nothing was lost/.test(m), m);
  await page.evaluate(()=>{window.__fail=(t,op,p)=>t==='bookings'&&op==='upsert'&&p.some(r=>'balance_due' in r)
    ?{code:'PGRST204',message:"Could not find the 'balance_due' column of 'bookings' in the schema cache"}:null;});
  ok('a database without balance_due still syncs, without it', await sync(page)===''&&
     await page.evaluate(()=>StayLogCloud.status().schemaBehind)==='supabase/minimal-cloud.sql');
  await ctx.close(); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
