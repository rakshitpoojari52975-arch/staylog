/* Round off on bookings that pay us directly (Direct and Booking.com): a gap
   of up to ₹5 either way between the total and the money received is filled
   in automatically and settles the booking; above that it is a real balance.
   balanceDue = total − paid − round off; revenue = total − round off.
   The form, Mark paid, the receipt, revenue, the CSV, sync, the notify
   function's balance alert, and (with STAYLOG_PG) supabase/round-off.sql. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

const STUB = `
window.__server={upserts:{},old:false};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  from(table){const S=window.__server;const api={
    select(){return api;}, eq(){return api;}, is(){return api;}, not(){return api;},
    order(){return api;}, limit(){return api;}, update(){return api;},
    async upsert(rows){
      if(S.old&&table==='bookings'&&rows.some(r=>'round_off' in r))
        return{error:{code:'PGRST204',message:"Could not find the 'round_off' column of 'bookings' in the schema cache"}};
      (S.upserts[table]=S.upserts[table]||[]).push(...rows);return{error:null};},
    then(res){return Promise.resolve(res({data:[],error:null}));}};return api;},
})};`;

const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const PROP={id:'p1',name:'Raaya Vasyam',pricePerNight:''};
const BK=o=>Object.assign({id:'bk1',propertyId:'p1',guestName:'Anita Rao',phone:'9876543210',checkIn:D(0),checkOut:D(2),
  guests:2,totalAmount:6000,paid:2000,source:'Direct',status:'checkedin',notes:'',msgSent:{}},o);
const SEED=bookings=>({properties:[PROP],staff:[],loans:[],expenses:[],attendance:[],bookings});

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async seed=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[], dialogs=[];
  page.on('pageerror',e=>errs.push(e.message));
  page.on('dialog',async d=>{dialogs.push(d.message());await d.accept(d.type()==='prompt'?(page.__answer??d.defaultValue()):undefined);});
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));window.open=()=>null;},seed);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(()=>{state.loggedIn=true;render();});
  return {ctx,page,errs,dialogs};
};
const form=async(page,id)=>{await page.evaluate(id=>{state.modal='addBooking';state.editItem=id?state.data.bookings.find(b=>b.id===id):null;render();},id);
  await page.waitForTimeout(150);};
const type=async(page,sel,v)=>{await page.locator(sel).fill(String(v));};
const ro=page=>page.locator('[data-round-off]').inputValue();
const line=page=>page.locator('[data-money-line]').innerText();
const save=async page=>{await page.locator('button',{hasText:/^(Add|Update) Booking$/}).click();await page.waitForTimeout(200);};
const B=(page,id)=>page.evaluate(id=>{const b=state.data.bookings.find(x=>x.id===id);
  return {...b,due:balanceDue(b),stamp:receiptStamp(b).line,ask:canAskForPayment(b),rev:bookingRevenue(b),ro:roundOffOf(b)};},id);
const pdfText=(page,id)=>page.evaluate(async id=>(await buildReceiptPDF(state.data.bookings.find(b=>b.id===id))).output(),id);

console.log('\n— ₹4,632.47 total, ₹4,630 received —');
{ const {ctx,page,errs}=await open(SEED([BK({totalAmount:'',paid:''})]));
  await form(page,'bk1');
  await type(page,'[data-total]','4632.47'); await type(page,'[data-received]','4630');
  ok('Round off fills with 2.47', await ro(page)==='2.47', await ro(page));
  ok('the live line says Fully paid', await line(page)==='Fully paid', await line(page));
  await save(page);
  const b=await B(page,'bk1');
  ok('saved with the round off, amounts as typed', b.roundOff===2.47&&Number(b.totalAmount)===4632.47&&Number(b.paid)===4630, b);
  ok('nothing is due', b.due===0);
  ok('the card shows Paid', await page.evaluate(()=>{state.tab='bookings';state.modal=null;render();
    return /\bpaid\b/.test(document.querySelector('[data-checkin]').innerText)&&!/due/.test(document.querySelector('[data-checkin]').innerText);}));
  ok('the receipt is stamped PAID', b.stamp==='PAID', b.stamp);
  ok('no payment request is offered', b.ask===false);
  const t=await pdfText(page,'bk1');
  const iT=t.indexOf('(Accommodation'), iR=t.indexOf('(Round off)'), iV=t.indexOf('(-Rs. 2.47)'), iA=t.indexOf('(Amount received)');
  ok('the receipt has "Round off -Rs. 2.47" between Total and Amount received', iT>0&&iR>iT&&iV>iR&&iA>iV, {iT,iR,iV,iA});
  ok('and no balance line', !/Balance outstanding/.test(t));
  ok('revenue counts the money received: ₹4,630', b.rev===4630, b.rev);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— the ₹5 line —');
{ const {ctx,page,errs}=await open(SEED([BK({id:'a',totalAmount:'',paid:''}),BK({id:'b',totalAmount:'',paid:'',checkIn:D(3),checkOut:D(4)}),
    BK({id:'c',totalAmount:'',paid:'',checkIn:D(5),checkOut:D(6)})]));
  await form(page,'a'); await type(page,'[data-total]','4995'); await type(page,'[data-received]','5000');
  ok('₹4,995 total, ₹5,000 received fills −5.00', await ro(page)==='-5.00', await ro(page));
  ok('  Fully paid', await line(page)==='Fully paid');
  await save(page);
  let b=await B(page,'a');
  ok('  PAID, nothing due, revenue ₹5,000', b.due===0&&b.stamp==='PAID'&&b.rev===5000, b);
  ok('  the receipt says "Round off +Rs. 5"', (await pdfText(page,'a')).includes('(+Rs. 5)'));
  await form(page,'b'); await type(page,'[data-total]','1000'); await type(page,'[data-received]','995');
  ok('a difference of exactly ₹5.00 rounds off', await ro(page)==='5.00'&&await line(page)==='Fully paid', [await ro(page),await line(page)]);
  await save(page);
  ok('  and settles the booking', (await B(page,'b')).due===0);
  await form(page,'c'); await type(page,'[data-total]','1000'); await type(page,'[data-received]','994.99');
  ok('₹5.01 leaves Round off empty', await ro(page)==='', await ro(page));
  ok('  and shows "Balance due ₹5.01"', await line(page)==='Balance due ₹5.01', await line(page));
  await save(page);
  b=await B(page,'c');
  ok('  a balance due, PART PAID, payment request offered', b.due===5.01&&b.stamp==='PART PAID'&&b.roundOff===0, b);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— a round off typed by hand —');
{ const {ctx,page}=await open(SEED([BK({totalAmount:'',paid:''})]));
  await form(page,'bk1');
  await type(page,'[data-total]','1000'); await type(page,'[data-received]','990');
  ok('₹10 apart: nothing filled, "Balance due ₹10"', await ro(page)===''&&await line(page)==='Balance due ₹10');
  await type(page,'[data-round-off]','3');
  ok('typing 3 counts it: "Balance due ₹7"', await line(page)==='Balance due ₹7', await line(page));
  await type(page,'[data-received]','996');
  ok('then a 4-rupee gap does not overwrite it', await ro(page)==='3'&&await line(page)==='Balance due ₹1', [await ro(page),await line(page)]);
  await save(page);
  await form(page,'bk1');
  await type(page,'[data-received]','998');
  ok('reopened and edited later: still 3, not refilled', await ro(page)==='3.00', await ro(page));
  await save(page);
  const b=await B(page,'bk1');
  ok('kept on the booking', b.roundOff===3&&b.roundOffHand===true&&b.due===0, b);
  await ctx.close(); }

console.log('\n— Mark paid —');
{ const {ctx,page,dialogs}=await open(SEED([BK(),BK({id:'odd',totalAmount:4632.47,paid:0,checkIn:D(3),checkOut:D(4)})]));
  const mark=async(id,answer)=>{page.__answer=answer;
    await page.evaluate(id=>{state.tab='bookings';state.modal=null;state.expandedBooking=id;render();},id); await page.waitForTimeout(100);
    await page.locator('[data-mark-paid]').click(); await page.waitForTimeout(250);};
  await mark('bk1','3000');
  ok('asks "Amount received?", prefilled with the balance', dialogs.some(d=>/^Amount received\? \(balance ₹4,000\)/.test(d)), dialogs);
  let b=await B(page,'bk1');
  ok('a partial amount is added to what was paid', Number(b.paid)===5000, b.paid);
  ok('and it stays part paid', b.due===1000&&b.stamp==='PART PAID'&&(b.roundOff||0)===0, b);
  ok('no receipt is offered yet', await page.locator('[data-offer-receipt]').count()===0);
  await mark('bk1',undefined);
  b=await B(page,'bk1');
  ok('accepting the balance settles it, and offers the receipt', b.due===0&&Number(b.paid)===6000&&await page.locator('[data-offer-receipt]').count()===1);
  await page.evaluate(()=>closeModal());
  await mark('odd','4630');
  b=await B(page,'odd');
  ok('₹4,630 against ₹4,632.47: the same ₹5 round off, 2.47', b.roundOff===2.47&&b.due===0&&b.stamp==='PAID', b);
  ok('  the receipt sheet names what was received', /₹4,630 received/.test(await page.locator('body').innerText()));
  await ctx.close(); }

console.log('\n— Airbnb and other platforms —');
{ const {ctx,page}=await open(SEED([BK({source:'Airbnb',totalAmount:5000,paid:0,roundOff:4})]));
  await form(page,'bk1');
  ok('no Round off field and no money line for Airbnb', !(await page.locator('[data-round-off-row]').isVisible())&&!(await page.locator('[data-money-line]').isVisible()));
  ok('a stored round off counts as 0 for Airbnb', (await B(page,'bk1')).ro===0&&(await B(page,'bk1')).rev===5000);
  await page.locator('select').filter({has:page.locator('option[value="Airbnb"]')}).selectOption('Direct');
  ok('switching to Direct shows it', await page.locator('[data-round-off-row]').isVisible());
  await page.locator('select').filter({has:page.locator('option[value="Airbnb"]')}).selectOption('MakeMyTrip');
  ok('switching to MakeMyTrip hides it', !(await page.locator('[data-round-off-row]').isVisible()));
  await save(page);
  ok('saved with round off 0', (await B(page,'bk1')).roundOff===0);
  await ctx.close(); }

console.log('\n— revenue is the money received —');
{ const {ctx,page}=await open(SEED([BK({id:'a',totalAmount:4632.47,paid:4630,roundOff:2.47}),
    BK({id:'b',totalAmount:4995,paid:5000,roundOff:-5,source:'Booking.com',checkIn:D(1),checkOut:D(2)}),
    BK({id:'c',totalAmount:3000,paid:0,source:'Airbnb',checkIn:D(3),checkOut:D(4)})]));
  const r=await page.evaluate(()=>{const now=new Date();
    let csv='';const orig=URL.createObjectURL;URL.createObjectURL=b=>{b.text().then(t=>{window.__csv=t;});return 'about:blank';};
    HTMLAnchorElement.prototype.click=function(){}; downloadReport(state.data.bookings,[],'test'); URL.createObjectURL=orig;
    return {sum:sumRevenue(state.data.bookings),month:monthTotals(state.data.bookings,[],now.getFullYear(),now.getMonth()).rev};});
  await page.waitForTimeout(100);
  const csv=await page.evaluate(()=>window.__csv);
  ok('₹4,630 + ₹5,000 received, + Airbnb ₹3,000 = ₹12,630', r.sum===12630, r);
  ok('the monthly figure agrees', Math.abs(r.month-12630)<0.001||D(3).slice(5,7)!==D(0).slice(5,7), r);
  ok('the CSV\'s Total Revenue agrees', /Total Revenue,12630\n/.test(csv), csv.slice(0,200));
  ok('the CSV has a Round Off column', /Amount Paid,Round Off,Balance Due/.test(csv));
  const row=id=>csv.split('\n').find(l=>l.startsWith(`"${{a:D(0),b:D(1),c:D(3)}[id]}"`));
  ok('  2.47, -5 and 0 in it', /,4632\.47,4630,2\.47,0,/.test(row('a'))&&/,4995,5000,-5,0,/.test(row('b'))&&/,3000,0,0,3000,/.test(row('c')), [row('a'),row('b'),row('c')]);
  await page.evaluate(()=>{state.tab='dashboard';render();});
  ok('Home shows ₹12,630', /₹12,630/.test(await page.locator('body').innerText()));
  await ctx.close(); }

console.log('\n— sync —');
{ const {ctx,page}=await open(SEED([BK({roundOff:2.47})]));
  const push=async()=>page.evaluate(async()=>{await window.StayLogCloud.restoreSession();
    try{await window.StayLogCloud.push(state.data,{manual:true});}catch(e){return e.message;} return window.StayLogCloud.status().schemaBehind;});
  let r=await push();
  const up=await page.evaluate(()=>window.__server.upserts.bookings.slice(-1)[0]);
  ok('round_off goes up with the booking', up.round_off===2.47&&r==='', [up,r]);
  await page.evaluate(()=>{window.__server.old=true;});
  r=await push();
  ok('before round-off.sql has run: synced without it, and the script is named', r==='supabase/round-off.sql'&&
    !('round_off' in await page.evaluate(()=>window.__server.upserts.bookings.slice(-1)[0])), r);
  await ctx.close(); }
{ const cloud=fs.readFileSync(path.join(ROOT,'cloud.js'),'utf8');
  ok('the mapper reads round_off back as roundOff', /roundOff: Number\(r\.round_off\) \|\| 0/.test(cloud)); }

console.log('\n— the 9 AM balance alert —');
{ const N=await import(path.join(ROOT,'supabase/functions/notify/index.ts'));
  ok('2.47 round off: nothing owed', N.balanceDue({total_amount:4632.47,paid:4630,round_off:2.47,source:'Direct'})===0);
  ok('−5 round off: nothing owed', N.balanceDue({total_amount:4995,paid:5000,round_off:-5,source:'Booking.com'})===0);
  ok('5.01 apart with no round off: owed 5.01, so the alert fires', N.balanceDue({total_amount:1000,paid:994.99,round_off:0,source:'Direct'})===5.01);
  ok('a round off on Airbnb is ignored', N.balanceDue({total_amount:1000,paid:990,round_off:10,source:'Airbnb'})===10);
  ok('without the column yet, as before', N.balanceDue({total_amount:1000,paid:994.99,source:'Direct'})===5.01);
  const fn=fs.readFileSync(path.join(ROOT,'supabase/functions/notify/index.ts'),'utf8');
  ok('the alert asks for round_off, and copes before the column exists', /\+ ',round_off'\)\.catch\(\(\) => d\.get\(leavingQ\)\)/.test(fn)); }

const CONN=(process.env.STAYLOG_PG||'').split(/\s+/).filter(Boolean);
if(CONN.length){
  console.log('\n— supabase/round-off.sql —');
  const psql=(db,args)=>{try{return{out:execFileSync('psql',[...CONN,'-d',db,'-q','-t','-A','-v','ON_ERROR_STOP=1',...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}),err:''};}
    catch(e){return{out:'',err:String(e.stderr||e.message)};}};
  const DB='staylog_roundoff_test';
  psql('postgres',['-c',`drop database if exists ${DB}`]); psql('postgres',['-c',`create database ${DB}`]);
  psql(DB,['-c',`do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
    create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;`]);
  let r=psql(DB,['-f',path.join(ROOT,'supabase/setup.sql')]); ok('setup.sql loads', !r.err, r.err);
  r=psql(DB,['-f',path.join(ROOT,'supabase/round-off.sql')]); ok('first run', !r.err, r.err);
  r=psql(DB,['-f',path.join(ROOT,'supabase/round-off.sql')]); ok('second run', !r.err, r.err);
  r=psql(DB,['-c',`select column_default, is_nullable, data_type from information_schema.columns where table_name='bookings' and column_name='round_off'`]);
  ok('bookings.round_off: numeric, not null, default 0', /^0\|NO\|numeric/.test(r.out.trim()), r.out);
  psql('postgres',['-c',`drop database if exists ${DB}`]);
} else console.log('\n  (STAYLOG_PG not set — skipping supabase/round-off.sql)');

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
