/* Bookings are cancelled, never deleted. The card has no Delete; Cancel asks,
   then offers Undo for 5 s; a checked-out stay shows Cancel greyed out with a
   note and cannot be cancelled. A cancelled import stays cancelled through
   every later calendar drain: never revived, moved or made again, including
   by the other platform's echo. Cancelled stays count for nothing: revenue,
   occupancy, clashes, still-open gaps, messages and the balance alert. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);
const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};

// A Supabase with tables as arrays. Filters are honoured; every write is logged.
const STUB = `
window.__server=JSON.parse(sessionStorage.getItem('__srv')||'null')||{rows:{ical_events:[],ical_feeds:[]},writes:[],invoked:[],missing:{}};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'},access_token:'tok'}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  functions:{async invoke(name,opts){window.__server.invoked.push(name);return{data:{ok:true},error:null};}},
  from(table){const S=window.__server;const q={f:[],op:'select',val:null,notIn:null};
    const match=r=>q.f.every(([k,v])=>v===null?r[k]==null:r[k]===v)&&(!q.notIn||!q.notIn.includes(r.id));
    const api={
    select(){return api;}, eq(k,v){q.f.push([k,v]);return api;}, is(k,v){q.f.push([k,v]);return api;},
    not(k,op,list){q.notIn=String(list).replace(/^\\(|\\)$/g,'').split(',').map(x=>x.replace(/"/g,''));return api;},
    order(){return api;}, limit(){return api;},
    update(v){q.op='update';q.val=v;return api;}, delete(){q.op='delete';return api;},
    async upsert(rows,o){S.writes.push({table,op:'upsert',rows});const t=S.rows[table]=S.rows[table]||[];
      rows.forEach(r=>{const keys=(o&&o.onConflict||'id').split(',');
        const i=t.findIndex(x=>keys.every(k=>x[k]===r[k]));i<0?t.push({...r}):Object.assign(t[i],r);});
      return{error:null};},
    then(res){
      if(S.missing[table])return Promise.resolve(res({data:null,error:{code:'PGRST205',message:"Could not find the table 'public."+table+"' in the schema cache"}}));
      const t=S.rows[table]||[];
      if(table==='attendance')return Promise.resolve(res({data:[],error:null}));
      if(q.op==='update'){const hit=t.filter(match);hit.forEach(r=>Object.assign(r,q.val));
        if(hit.length)S.writes.push({table,op:'update',val:q.val,n:hit.length});return Promise.resolve(res({data:null,error:null}));}
      if(q.op==='delete'){const keep=t.filter(r=>!match(r));S.writes.push({table,op:'delete',n:t.length-keep.length});
        S.rows[table]=keep;return Promise.resolve(res({data:null,error:null}));}
      return Promise.resolve(res({data:t.filter(match).map(r=>({...r})),error:null}));
    }};return api;},
})};`;


const ev=o=>Object.assign({feed_id:'f-air',uid:'u1',owner_id:'owner-1',property_id:'p1',platform:'Airbnb',start_date:D(5),end_date:D(8),
  summary:'Reserved',description:'',kind:'reserved',gone_at:null,imported_booking_id:null},o);
const BK=(id,o)=>Object.assign({id,propertyId:'p1',guestName:'Guest '+id,phone:'9876543210',checkIn:D(2),checkOut:D(4),guests:2,
  totalAmount:5000,paid:1000,source:'Direct',status:'confirmed',notes:'',msgSent:{}},o);
const SEED=b=>({properties:[{id:'p1',name:'Raaya Vasyam',rooms:1}],staff:[],loans:[],expenses:[],attendance:[],bookings:b});

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(seed,o={})=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  if(o.cloud)await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  else await ctx.route('**vendor/supabase.umd.js',r=>r.abort());
  const page=await ctx.newPage(); const errs=[], dialogs=[];
  page.answer=true;
  page.on('pageerror',e=>errs.push(e.message));
  page.on('dialog',async d=>{dialogs.push(d.message()); page.answer?await d.accept():await d.dismiss();});
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));window.open=()=>null;},seed);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(()=>{state.loggedIn=true;state.tab='bookings';state.bookingFilter='all';render();});
  if(o.cloud)await page.evaluate(async()=>{await window.StayLogCloud.restoreSession();});
  return {ctx,page,errs,dialogs};
};
const expand=(page,id)=>page.evaluate(id=>{state.modal=null;state.tab='bookings';state.bookingFilter='all';state.expandedBooking=id;render();},id);
const status=(page,id)=>page.evaluate(id=>state.data.bookings.find(b=>b.id===id).status,id);

console.log('\n— no Delete, anywhere —');
{ const seed=SEED([BK('c'),BK('i',{status:'checkedin',checkIn:D(-1)}),BK('o',{status:'checkedout',checkIn:D(-5),checkOut:D(-2)}),
    BK('x',{status:'cancelled'}),BK('ics_0123456789abcdef',{source:'Airbnb',guestName:'Airbnb guest'})]);
  const {ctx,page,errs}=await open(seed);
  let found=[];
  for(const b of seed.bookings){await expand(page,b.id);
    const n=await page.locator('#app button').evaluateAll(els=>els.filter(e=>/delete/i.test(e.textContent)||e.querySelector('.ti-trash')).length);
    if(n)found.push(b.id);}
  ok('no booking card, in any status, has a Delete control', found.length===0, found);
  await page.evaluate(()=>{state.modal='addBooking';state.editItem=state.data.bookings[0];render();});
  ok('nor the booking form', await page.locator('body button').evaluateAll(els=>els.filter(e=>/delete/i.test(e.textContent)||e.querySelector('.ti-trash')).length)===0);
  ok('and app.js no longer filters a booking out of the data', !/d\.bookings\s*=\s*d\.bookings\.filter\(/.test(fs.readFileSync(path.join(ROOT,'app.js'),'utf8')));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— Cancel asks, then offers Undo —');
{ const {ctx,page,dialogs,errs}=await open(SEED([BK('c'),BK('i',{status:'checkedin',checkIn:D(-1),checkOut:D(1)})]));
  await expand(page,'c');
  page.answer=false; await page.click('[data-cancel-booking]'); await page.waitForTimeout(100);
  ok('it asks first, in those words', dialogs[0]==='Cancel this booking? It stays on record as cancelled.', dialogs);
  ok('saying no changes nothing', await status(page,'c')==='confirmed');
  page.answer=true; await page.click('[data-cancel-booking]'); await page.waitForTimeout(100);
  ok('saying yes cancels it, and it stays on record', await status(page,'c')==='cancelled'&&await page.evaluate(()=>state.data.bookings.length)===2);
  const toast=await page.locator('[data-toast]').innerText();
  ok('a "Cancelled · Undo" toast appears', /Cancelled/.test(toast)&&/Undo/.test(toast), toast);
  await page.click('[data-toast-action]'); await page.waitForTimeout(100);
  ok('Undo restores the previous status', await status(page,'c')==='confirmed');
  await expand(page,'i'); await page.click('[data-cancel-booking]'); await page.waitForTimeout(100);
  ok('a checked-in stay can be cancelled too', await status(page,'i')==='cancelled');
  await page.click('[data-toast-action]'); await page.waitForTimeout(100);
  ok('and Undo puts it back to checked in', await status(page,'i')==='checkedin');
  await page.evaluate(()=>cancelBooking('c'));
  const t0=Date.now(); await page.waitForSelector('[data-toast]',{state:'detached',timeout:8000});
  ok('the toast goes after about 5 seconds', Date.now()-t0>3500&&Date.now()-t0<7000, Date.now()-t0);
  ok('and the cancellation stands', await status(page,'c')==='cancelled');
  await expand(page,'c');
  ok('a cancelled booking offers no Cancel', await page.locator('[data-cancel-booking]').count()===0);
  await page.evaluate(()=>{state.modal='addBooking';state.editItem=state.data.bookings.find(b=>b.id==='c');render();});
  await page.locator('select').filter({has:page.locator('option[value="cancelled"]')}).selectOption('confirmed');
  await page.locator('button',{hasText:/Update Booking|Save/}).first().click(); await page.waitForTimeout(200);
  ok('Edit → Status still restores it', await status(page,'c')==='confirmed', await status(page,'c'));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— a checked-out stay —');
{ const {ctx,page,dialogs}=await open(SEED([BK('o',{status:'checkedout',checkIn:D(-5),checkOut:D(-2)})]));
  await expand(page,'o');
  const btn=page.locator('[data-cancel-booking]');
  ok('shows Cancel, disabled', await btn.count()===1&&await btn.isDisabled());
  ok('greyed out', Number(await btn.evaluate(e=>getComputedStyle(e).opacity))<0.6);
  ok('with the note "Checked out — can’t be cancelled"', (await page.locator('[data-cancel-note]').innerText())==='Checked out — can’t be cancelled');
  await btn.evaluate(e=>e.click()); await btn.click({force:true}).catch(()=>{}); await page.waitForTimeout(150);
  ok('tapping it asks nothing and changes nothing', dialogs.length===0&&await status(page,'o')==='checkedout'&&await page.locator('[data-toast]').count()===0);
  ok('and cancelBooking itself refuses one', await page.evaluate(()=>{cancelBooking('o');return state.data.bookings[0].status;})==='checkedout'&&dialogs.length===0);
  await ctx.close(); }

console.log('\n— a cancelled import stays cancelled —');
{ const {ctx,page,errs}=await open(SEED([]),{cloud:true});
  const air=ev({uid:'a1'}), bdc=ev({feed_id:'f-bdc',platform:'Booking.com',uid:'b1',summary:'CLOSED - Not available'});
  await page.evaluate(e=>{window.__server.rows.ical_events=e;},[air]);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  const id=await page.evaluate(()=>state.data.bookings[0]&&state.data.bookings[0].id);
  ok('the stay is imported', /^ics_/.test(id||''), id);
  await expand(page,id); await page.click('[data-cancel-booking]'); await page.waitForTimeout(100);
  ok('and cancelled here', await status(page,id)==='cancelled');
  const look=()=>page.evaluate(id=>state.data.bookings.filter(b=>b.checkIn===b.checkIn).map(b=>({id:b.id,st:b.status,in:b.checkIn,out:b.checkOut,gone:!!b.icalGone})),id);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  let r=await look();
  ok('a second drain leaves it cancelled, and makes nothing new', r.length===1&&r[0].st==='cancelled', r);
  // the platform still lists it, moves it, and the other platform echoes it
  await page.evaluate(([d1,d2,b])=>{const e=window.__server.rows.ical_events[0];e.start_date=d1;e.end_date=d2;
    window.__server.rows.ical_events.push({...b,start_date:d1,end_date:d2});},[D(5),D(9),bdc]);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  r=await look();
  ok('a third drain, with new dates on the platform: still cancelled, dates untouched', r.length===1&&r[0].st==='cancelled'&&r[0].out===D(8), r);
  // the echo arrives on the cancelled dates
  await page.evaluate(([d1,d2])=>{const e=window.__server.rows.ical_events[0];e.start_date=d1;e.end_date=d2;
    const m=window.__server.rows.ical_events[1];m.start_date=d1;m.end_date=d2;m.imported_booking_id=null;},[D(5),D(8)]);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  r=await look();
  const echo=await page.evaluate(()=>window.__server.rows.ical_events.find(e=>e.uid==='b1').imported_booking_id);
  ok('the other platform\'s echo links to the cancelled booking, never re-creating it', r.length===1&&r[0].st==='cancelled'&&echo===id, {r,echo});
  // the stamp is lost (a failed write): the import is not made again
  await page.evaluate(()=>window.__server.rows.ical_events.forEach(e=>e.imported_booking_id=null));
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  r=await look();
  ok('with its stamps lost, it is still not made again', r.length===1&&r[0].st==='cancelled', r);
  await page.evaluate(()=>{window.__server.rows.ical_events[0].gone_at=new Date().toISOString();});
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  r=await look();
  ok('leaving the feed flags nothing on a cancelled stay', r.length===1&&!r[0].gone, r);
  ok('the cloud holds it as cancelled', await page.evaluate(id=>(window.__server.rows.bookings||[]).find(b=>b.id===id).status,id)==='cancelled');
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const {ctx,page}=await open(SEED([]),{cloud:true});
  const r=await page.evaluate(([e,t])=>{const P=window.StayLogCloud._planIcal;
    const can={id:'bkHand',propertyId:'p1',checkIn:e.start_date,checkOut:e.end_date,status:'cancelled',source:'Direct'};
    return P([e],{properties:[{id:'p1'}],bookings:[can]},t).create.length;},[ev({uid:'n1'}),D(0)]);
  ok('a hand-entered booking cancelled on those dates still lets a new stay in', r===1, r);
  await ctx.close(); }

console.log('\n— cancelled counts for nothing —');
{ const y=new Date().getFullYear(), m=new Date().getMonth();
  const first=`${y}-${String(m+1).padStart(2,'0')}-01`, add=(iso,n)=>{const d=new Date(iso+'T00:00:00');d.setDate(d.getDate()+n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  const live=BK('live',{checkIn:add(first,1),checkOut:add(first,4),totalAmount:6000,paid:6000,status:'checkedout'});
  const gone=BK('gone',{checkIn:add(first,1),checkOut:add(first,4),totalAmount:9000,paid:0,status:'cancelled',source:'Direct'});
  const soon=BK('soon',{checkIn:D(1),checkOut:D(3),status:'cancelled',totalAmount:4000,paid:0});
  const {ctx,page,errs}=await open(SEED([live,gone,soon]));
  const r=await page.evaluate(([y,m])=>{
    const B=state.data.bookings;
    return {rev:monthTotals(B,[],y,m).rev, clashes:Object.keys(bookingClashes(B)||{}).filter(k=>(bookingClashes(B)[k]||[]).length),
      due:dueMessages(B).map(x=>x.b.id), ask:canAskForPayment(B.find(b=>b.id==='soon')),
      wageDay:checkoutDates(B).has(B.find(b=>b.id==='gone').checkOut)&&checkoutDates(B).size,
      balance:window.STAYLOG_BALANCE_DUE(B.find(b=>b.id==='soon'))};},[y,m]);
  ok('revenue: only the live stay', r.rev===6000, r.rev);
  ok('no clash between a cancelled and a live stay on the same nights', r.clashes.length===0, r.clashes);
  ok('no messages due for a cancelled stay', !r.due.includes('soon')&&!r.due.includes('gone'), r.due);
  ok('no payment request for one', r.ask===false);
  await page.evaluate(([y,m])=>{state.tab='dashboard';state.dashMonth={year:y,month:m};render();},[y,m]);
  const home=await page.locator('#app').innerText();
  ok('Home: the month\'s revenue leaves the cancelled stay out', /₹6,000/.test(home)&&!/₹15,000/.test(home), home.slice(0,400));
  const nights=await page.evaluate(()=>{const k=[...document.querySelectorAll('.kicker')].find(e=>e.textContent==='Nights');return k&&k.nextSibling.textContent;});
  ok('occupancy: 3 nights, not 6', nights==='3', nights);
  await page.evaluate(([y,m])=>{state.tab='reports';state.reportMonth={year:y,month:m};render();},[y,m]);
  const rep=await page.locator('#app').innerText();
  ok('Reports: revenue ₹6,000', /₹6,000/.test(rep)&&!/₹15,000/.test(rep), rep.slice(0,300));
  const cal=await page.evaluate(()=>{state.tab='calendar';render();return document.querySelector('#app').innerText;});
  ok('the calendar shows no cancelled stay', !/Guest soon|Guest gone/.test(cal));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const F=await import(path.resolve(ROOT,'supabase/functions/notify/index.ts'));
  ok('the notify function\'s alerts skip cancelled stays', /status[^\n]*cancelled/.test(fs.readFileSync(path.resolve(ROOT,'supabase/functions/notify/index.ts'),'utf8'))&&typeof F.dailyPushes==='function'); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
