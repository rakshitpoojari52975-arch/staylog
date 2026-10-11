/* The phone's side of the calendar import. ical_events (written by the Edge
   Function) is drained one way into ordinary bookings, like attendance marks
   into wage expenses. With Airbnb and Booking.com connected to each other,
   each feed echoes the other's stays: those must be linked, never doubled.
   Double bookings are flagged on the card and on Home. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

// Dates relative to today, local time, as the app counts them.
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

const ev=(o)=>Object.assign({feed_id:'f-air',uid:'u'+Math.random().toString(36).slice(2,8),owner_id:'owner-1',property_id:'p1',
  platform:'Airbnb',start_date:D(5),end_date:D(8),summary:'Reserved',description:'',kind:'reserved',gone_at:null,imported_booking_id:null},o);
const AIR=o=>ev(Object.assign({feed_id:'f-air',platform:'Airbnb',summary:'Reserved',kind:'reserved'},o));
const AIRBLOCK=o=>ev(Object.assign({feed_id:'f-air',platform:'Airbnb',summary:'Airbnb (Not available)',kind:'blocked'},o));
const BDC=o=>ev(Object.assign({feed_id:'f-bdc',platform:'Booking.com',summary:'CLOSED - Not available',kind:'reserved'},o));
const bk=o=>Object.assign({id:'bk'+Math.random().toString(36).slice(2,8),propertyId:'p1',guestName:'Anita Rao',phone:'',
  checkIn:D(5),checkOut:D(8),guests:2,totalAmount:6000,paid:0,source:'Direct',status:'confirmed',notes:''},o);
const SEED=o=>Object.assign({properties:[{id:'p1',name:'Raaya Vasyam'}],staff:[],loans:[],expenses:[],attendance:[],bookings:[]},o);

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open = async seed => {
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[], dialogs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));},seed);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined' && !state._loading);
  await page.evaluate(async()=>{ await window.StayLogCloud.restoreSession(); });
  return {ctx,page,errs,dialogs};
};
const plan=(page,events,seed)=>page.evaluate(([e,s,t])=>window.StayLogCloud._planIcal(e,s,t),[events,seed,D(0)]);

console.log('\n— what each event means (the planner on its own) —');
{ const {ctx,page}=await open(SEED({}));
  const a=AIR({uid:'a1',description:'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCDE123\nPhone Number (Last 4 Digits): 4321'});
  let p=await plan(page,[a],SEED({}));
  const b=p.create[0];
  ok('an Airbnb stay becomes a booking', p.create.length===1&&b.source==='Airbnb'&&b.guestName==='Airbnb guest', p);
  ok('on the right property and dates', b.propertyId==='p1'&&b.checkIn===D(5)&&b.checkOut===D(8), b);
  ok('with an id the sync accepts', /^ics_[0-9a-f]{16}$/.test(b.id), b.id);
  ok('the notes carry the reservation link and phone digits',
     /HMABCDE123/.test(b.notes)&&/ends 4321/.test(b.notes), b.notes);
  ok('no amount is invented', b.totalAmount===''&&b.paid==='', b);
  ok('and the event is to be stamped with it', p.stamp.length===1&&p.stamp[0].booking_id===b.id, p.stamp);
  const again=await plan(page,[a],SEED({}));
  ok('the same event always gives the same id', again.create[0].id===b.id);

  p=await plan(page,[BDC({uid:'m1'}),AIR({uid:'a1'})],SEED({}));
  ok('Booking.com\'s copy of an Airbnb stay is linked, not doubled',
     p.create.length===1&&p.create[0].source==='Airbnb'&&p.counts.linked===1, p);
  ok('both events point at the one booking', p.stamp.every(s=>s.booking_id===p.create[0].id), p.stamp);

  p=await plan(page,[AIRBLOCK({uid:'x1'}),BDC({uid:'b1'})],SEED({}));
  ok('Airbnb\'s block for a Booking.com stay is linked, not doubled',
     p.create.length===1&&p.create[0].source==='Booking.com'&&p.counts.linked===1, p);
  ok('and the Booking.com booking says to fill in the name', /fill them in/.test(p.create[0].notes), p.create[0].notes);

  p=await plan(page,[AIRBLOCK({uid:'x2',start_date:D(20),end_date:D(22)})],SEED({}));
  ok('an Airbnb block on its own never makes a booking', p.create.length===0&&p.counts.blocks===1, p);
  ok('and is not stamped, so a later stay can still claim it', p.stamp.length===0);

  const typed=bk({id:'bkTyped',source:'Booking.com',guestName:'Rahul Menon'});
  p=await plan(page,[BDC({uid:'b2'})],SEED({bookings:[typed]}));
  ok('a stay already typed in by hand is linked, not doubled',
     p.create.length===0&&p.stamp[0]?.booking_id==='bkTyped', p);
  const direct=bk({id:'bkDirect',source:'Direct'});
  p=await plan(page,[AIRBLOCK({uid:'x3'}),BDC({uid:'b3'})],SEED({bookings:[direct]}));
  ok('dates closed for a direct guest are linked to that booking', p.create.length===0&&p.counts.linked===2, p);
  const cancelled=bk({id:'bkCan',status:'cancelled'});
  p=await plan(page,[AIR({uid:'a9'})],SEED({bookings:[cancelled]}));
  ok('a cancelled booking does not swallow a new stay on its dates', p.create.length===1, p);

  p=await plan(page,[AIR({uid:'old',start_date:D(-10),end_date:D(-7)}),AIR({uid:'leaving',start_date:D(-2),end_date:D(0)})],SEED({}));
  ok('stays already over are not imported', p.create.length===0&&p.counts.past===2, p.counts);
  p=await plan(page,[AIR({uid:'now',start_date:D(-1),end_date:D(2)})],SEED({}));
  ok('a stay in progress is', p.create.length===1, p.counts);

  p=await plan(page,[AIR({uid:'q',property_id:'p-unknown'})],SEED({}));
  ok('a feed for a property not on this phone waits', p.create.length===0&&p.counts.held===1, p.counts);

  const e1=AIR({uid:'del'}); const id1=(await plan(page,[e1],SEED({}))).create[0].id;
  p=await plan(page,[{...e1,imported_booking_id:id1}],SEED({}));
  ok('a booking you deleted stays deleted', p.create.length===0&&p.counts.removed===1, p);

  const mine={...(await plan(page,[e1],SEED({}))).create[0],guestName:'Kavya S',totalAmount:9000};
  p=await plan(page,[{...e1,imported_booking_id:id1,start_date:D(6),end_date:D(9)}],SEED({bookings:[mine]}));
  ok('new dates on the platform move the booking',
     p.update.length===1&&p.update[0].fields.checkIn===D(6)&&p.update[0].fields.checkOut===D(9), p.update);
  ok('without touching what you filled in', !('guestName' in p.update[0].fields)&&!('totalAmount' in p.update[0].fields));

  p=await plan(page,[{...e1,imported_booking_id:id1,gone_at:'2026-10-11T10:00:00Z'}],SEED({bookings:[mine]}));
  ok('gone from the feed: flagged, not cancelled', p.update[0]?.fields.icalGone===true&&!('status' in p.update[0].fields), p.update);
  p=await plan(page,[{...e1,imported_booking_id:id1}],SEED({bookings:[{...mine,icalGone:true}]}));
  ok('back in the feed: the flag comes off', p.update[0]?.fields.icalGone===false, p.update);
  const untouched=await page.evaluate(([e,b,t])=>{const data={properties:[{id:'p1'}],bookings:[b]};
    window.StayLogCloud._planIcal([e],data,t); return data.bookings[0];},[{...e1,imported_booking_id:id1,start_date:D(6),end_date:D(9),gone_at:'x'},mine,D(0)]);
  ok('planning changes nothing by itself; only the apply step writes',
     untouched.checkIn===mine.checkIn&&!untouched.icalGone, untouched);

  // Booking.com's mirror arrives before Airbnb's own event does
  const early=(await plan(page,[BDC({uid:'mm'})],SEED({}))).create[0];
  p=await plan(page,[AIR({uid:'aa',description:'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMZZ'})],
    SEED({bookings:[early]}));
  ok('a stay first seen through the mirror takes Airbnb\'s name when Airbnb\'s event arrives',
     p.create.length===0&&p.update[0]?.fields.source==='Airbnb'&&p.update[0]?.fields.guestName==='Airbnb guest', p);
  p=await plan(page,[AIR({uid:'aa'})],SEED({bookings:[{...early,guestName:'Meera J'}]}));
  ok('but not once you have named the guest', p.update.length===0&&p.counts.linked===1, p);
  await ctx.close(); }

console.log('\n— through a real sync —');
{ const {ctx,page,errs}=await open(SEED({}));
  const airStay=AIR({uid:'s1',start_date:D(3),end_date:D(6)}), mirror=BDC({uid:'s1m',start_date:D(3),end_date:D(6)});
  const bdcStay=BDC({uid:'s2',start_date:D(10),end_date:D(12)}), block=AIRBLOCK({uid:'s2m',start_date:D(10),end_date:D(12)});
  await page.evaluate(ev=>{window.__server.rows.ical_events=ev;},[airStay,mirror,bdcStay,block]);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  const r=await page.evaluate(()=>({
    bookings:state.data.bookings.map(b=>({id:b.id,source:b.source,in:b.checkIn})),
    events:window.__server.rows.ical_events.map(e=>({uid:e.uid,b:e.imported_booking_id})),
    pushed:(window.__server.rows.bookings||[]).map(b=>b.id),
    log:window.StayLogCloud.status().icalLog, err:window.StayLogCloud.status().lastError}));
  ok('two stays, four events, two bookings', r.bookings.length===2, r.bookings);
  ok('one from each platform', r.bookings.map(b=>b.source).sort().join()==='Airbnb,Booking.com', r.bookings);
  ok('every event is stamped', r.events.every(e=>e.b), r.events);
  ok('the mirrors point at the real stays',
     r.events.find(e=>e.uid==='s1m').b===r.events.find(e=>e.uid==='s1').b
     &&r.events.find(e=>e.uid==='s2m').b===r.events.find(e=>e.uid==='s2').b, r.events);
  ok('the bookings go up in the same sync', r.bookings.every(b=>r.pushed.includes(b.id)), r.pushed);
  ok('the panel log says what happened', r.log&&r.log.created===2&&r.log.linked===2&&!r.log.error, r.log);
  ok('the sync itself is clean', !r.err, r.err);

  await page.evaluate(async()=>{window.__server.writes=[];await window.StayLogCloud.push(state.data);});
  const again=await page.evaluate(()=>({n:state.data.bookings.length,
    stamps:window.__server.writes.filter(w=>w.table==='ical_events').length}));
  ok('syncing again changes nothing', again.n===2&&again.stamps===0, again);
  const writes=await page.evaluate(()=>window.__server.writes.filter(w=>w.op==='upsert').map(w=>w.table));
  ok('ical_events is never pushed as app data', !writes.includes('ical_events')&&!writes.includes('ical_feeds'), writes);

  // you delete the Booking.com one (it was dates you closed yourself)
  await page.evaluate(async()=>{const b=state.data.bookings.find(x=>x.source==='Booking.com');
    mutateData(d=>{d.bookings=d.bookings.filter(x=>x.id!==b.id);}); await window.StayLogCloud.push(state.data);});
  ok('a deleted import does not come back',
     (await page.evaluate(()=>state.data.bookings.map(b=>b.source)))+''==='Airbnb');
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— before ical.sql has been run —');
{ const {ctx,page,errs}=await open(SEED({bookings:[bk({})]}));
  await page.evaluate(()=>{window.__server.missing.ical_events=true;window.__server.missing.ical_feeds=true;});
  const r=await page.evaluate(async()=>{try{await window.StayLogCloud.push(state.data);return{ok:true};}catch(e){return{ok:false,e:e.message};}});
  const st=await page.evaluate(()=>window.StayLogCloud.status());
  ok('the sync still works', r.ok&&!st.lastError, {r,err:st.lastError});
  ok('and no error is shown for a feature not set up', st.icalLog===null, st.icalLog);
  await page.evaluate(()=>{state.loggedIn=true;state.modal='cloud';render();}); await page.waitForTimeout(400);
  ok('the panel says what to set up',
     /Not set up in Supabase yet: run supabase\/ical\.sql/.test(await page.locator('[data-ical]').innerText()));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— double bookings, on screen —');
{ const direct=bk({id:'bkD',guestName:'Anita Rao',checkIn:D(4),checkOut:D(7)});
  const {ctx,page,errs}=await open(SEED({bookings:[direct,bk({id:'bkOther',guestName:'Later Guest',checkIn:D(7),checkOut:D(9)})]}));
  await page.evaluate(ev=>{window.__server.rows.ical_events=ev;},[AIR({uid:'clash',start_date:D(6),end_date:D(8)})]);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  await page.evaluate(()=>{state.loggedIn=true;state.tab='bookings';state.bookingFilter='all';render();});
  await page.waitForTimeout(300);
  const clashes=await page.locator('[data-clash]').allInnerTexts();
  ok('every booking in a clash is flagged, once per clash', clashes.length===4, clashes);   // the Airbnb stay overlaps both
  ok('naming the other guest and dates', clashes.some(t=>/Double booking: overlaps Anita Rao/.test(t))
     &&clashes.some(t=>/overlaps Airbnb guest/.test(t)), clashes);
  ok('check-out day is free: back-to-back stays do not clash',
     !(await page.evaluate(()=>clashesFor(state.data.bookings.find(b=>b.id==='bkD')).some(o=>o.id==='bkOther'))));
  await page.evaluate(()=>{state.tab='dashboard';render();}); await page.waitForTimeout(200);
  const alert=await page.locator('[data-cal-alert]').innerText().catch(()=>'');
  ok('Home says so', /2 double bookings/.test(alert), alert);
  await page.locator('[data-cal-alert]').click(); await page.waitForTimeout(200);
  ok('and takes you to Bookings', await page.evaluate(()=>state.tab)==='bookings');
  await page.evaluate(()=>{mutateData(d=>{d.bookings.find(b=>b.id==='bkD').status='cancelled';});});
  const left=await page.locator('[data-clash]').allInnerTexts();
  ok('cancel one and only the clash with it goes', left.length===2&&!left.some(t=>/Anita Rao/.test(t)), left);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— a stay that leaves the feed —');
{ const {ctx,page}=await open(SEED({}));
  const e=AIR({uid:'leave',start_date:D(3),end_date:D(5)});
  await page.evaluate(ev=>{window.__server.rows.ical_events=ev;},[e]);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  await page.evaluate(()=>{window.__server.rows.ical_events[0].gone_at=new Date().toISOString();});
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  await page.evaluate(()=>{state.loggedIn=true;state.tab='bookings';render();}); await page.waitForTimeout(200);
  ok('its card asks whether it was cancelled',
     /No longer on Airbnb — cancelled\?/.test(await page.locator('[data-gone]').innerText().catch(()=>'')));
  ok('it is still a booking until you cancel it', await page.evaluate(()=>state.data.bookings[0].status)==='confirmed');
  ok('an imported stay with no amount does not claim to be paid',
     /—\s*add amount/.test(await page.locator('.card').first().innerText()), await page.locator('.card').first().innerText());
  await page.evaluate(()=>{state.tab='dashboard';render();}); await page.waitForTimeout(200);
  ok('Home mentions it', /no longer on the platform/.test(await page.locator('[data-cal-alert]').innerText().catch(()=>'')));
  await ctx.close(); }

console.log('\n— the calendar links box —');
{ const {ctx,page,errs,dialogs}=await open(SEED({}));
  await page.evaluate(()=>{window.__server.rows.ical_feeds=[{id:'f1',owner_id:'owner-1',property_id:'p1',platform:'Airbnb',
    url:'https://www.airbnb.com/calendar/ical/1.ics?s=x',last_fetched_at:new Date().toISOString(),
    last_ok_at:new Date().toISOString(),last_count:4,last_error:null}];
    state.loggedIn=true;state.modal='cloud';render();});
  await page.waitForTimeout(400);
  ok('a saved link is shown', await page.locator('[data-feed="p1|Airbnb"]').inputValue()==='https://www.airbnb.com/calendar/ical/1.ics?s=x');
  await page.locator('[data-feed="p1|Booking.com"]').fill('http://admin.booking.com/ical.ics');
  await page.locator('[data-feed-save="p1|Booking.com"]').click(); await page.waitForTimeout(300);
  ok('a link that is not https is refused', dialogs.some(d=>/start with https/.test(d)), dialogs);
  await page.locator('[data-feed="p1|Booking.com"]').fill('https://admin.booking.com/hotel/ical.ics?t=y');
  await page.locator('[data-feed-save="p1|Booking.com"]').click(); await page.waitForTimeout(500);
  const feeds=await page.evaluate(()=>window.__server.rows.ical_feeds.map(f=>`${f.owner_id}|${f.property_id}|${f.platform}|${f.url}`));
  ok('saving stores it in the cloud for this owner, property and platform',
     feeds.includes('owner-1|p1|Booking.com|https://admin.booking.com/hotel/ical.ics?t=y'), feeds);
  const report=await page.locator('[data-ical]').innerText();
  ok('and Calendar sync lists it, not fetched yet', /Booking\.com · Raaya Vasyam[\s\S]*Not fetched yet/.test(report), report);
  const local=await page.evaluate(()=>{const all={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);all[k]=localStorage.getItem(k);}
    return JSON.stringify(all)+JSON.stringify(state.data);});
  ok('the links are not kept on the phone: not in its data, backups or storage',
     !/ical\.ics|calendar\/ical/.test(local), local.match(/.{40}ical.{40}/));
  await page.locator('[data-feed="p1|Airbnb"]').fill('');
  await page.locator('[data-feed-save="p1|Airbnb"]').click(); await page.waitForTimeout(500);
  ok('clearing a link removes it', !(await page.evaluate(()=>window.__server.rows.ical_feeds.some(f=>f.platform==='Airbnb'))));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— Calendar sync: feed by feed —');
{ // Airbnb: A1 new, A2 moved by the platform, A3 gone from the feed, A4 a block with no stay.
  // Booking.com: B1 is its copy of A1; B2 made a booking that was deleted here.
  // One fetch worked; Booking.com's last one failed.
  const A2=AIR({uid:'A2',start_date:D(20),end_date:D(23)}), A3=AIR({uid:'A3',start_date:D(30),end_date:D(32)});
  const B2=BDC({uid:'B2',start_date:D(40),end_date:D(42)});
  const {ctx,page,errs}=await open(SEED({}));
  const ids=await page.evaluate(es=>es.map(e=>window.StayLogCloud._icalBookingId(e)),[A2,A3,B2]);
  const own=(e,id,o)=>({...e,imported_booking_id:id,...o});
  await page.evaluate(([bs])=>{mutateData(d=>{d.bookings.push(...bs);});},
    [[{id:ids[0],propertyId:'p1',guestName:'Airbnb guest',checkIn:D(19),checkOut:D(22),guests:1,totalAmount:'',paid:'',source:'Airbnb',status:'confirmed',notes:''},
      {id:ids[1],propertyId:'p1',guestName:'Airbnb guest',checkIn:D(30),checkOut:D(32),guests:1,totalAmount:'',paid:'',source:'Airbnb',status:'confirmed',notes:''}]]);
  const earlier=new Date(Date.now()-3*3600e3).toISOString(), now=new Date().toISOString();
  await page.evaluate(([ev,fe])=>{window.__server.rows.ical_events=ev;window.__server.rows.ical_feeds=fe;},[[
    AIR({uid:'A1',start_date:D(10),end_date:D(12)}), own(A2,ids[0]), own(A3,ids[1],{gone_at:now}),
    AIRBLOCK({uid:'A4',start_date:D(50),end_date:D(52)}),
    BDC({uid:'B1',start_date:D(10),end_date:D(12)}), own(B2,ids[2])],
   [{id:'f-air',owner_id:'owner-1',property_id:'p1',platform:'Airbnb',url:'https://a/1.ics',
     last_fetched_at:now,last_ok_at:now,last_count:4,last_error:null},
    {id:'f-bdc',owner_id:'owner-1',property_id:'p1',platform:'Booking.com',url:'https://b/1.ics',
     last_fetched_at:now,last_ok_at:earlier,last_count:2,last_error:'the feed answered HTTP 403'}]]);
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  const look=async()=>{await page.evaluate(()=>{state.loggedIn=true;state.modal='cloud';render();});await page.waitForTimeout(400);
    const f=id=>page.locator(`[data-feed-report="${id}"]`);
    const n=async(id,k)=>Number(await f(id).locator(`[data-n-${k}]`).getAttribute(`data-n-${k}`));
    return {air:{text:await f('f-air').innerText(),added:await n('f-air','added'),updated:await n('f-air','updated'),removed:await n('f-air','removed')},
            bdc:{text:await f('f-bdc').innerText(),added:await n('f-bdc','added'),updated:await n('f-bdc','updated'),removed:await n('f-bdc','removed')}};};
  let r=await look();
  ok('Airbnb: when it was fetched and how many events it found', /Fetched .* · 4 events in the feed/.test(r.air.text), r.air.text);
  ok('Airbnb: 3 added, 1 updated, 1 removed', r.air.added===3&&r.air.updated===1&&r.air.removed===1, r.air);
  ok('removed is explained as flagged, not cancelled', /no longer on Airbnb: its booking is flagged to check, not cancelled/.test(r.air.text), r.air.text);
  ok('the block with no stay is accounted for', /1 blocked date range with no stay behind it/.test(r.air.text), r.air.text);
  ok('and what this check changed', /Last change .*: 1 added, 1 updated, 1 removed/.test(r.air.text), r.air.text);
  ok('Booking.com: the failed fetch, in red, with the reason', await page.locator('[data-feed-report="f-bdc"] [data-feed-error]').count()===1
     &&/Last fetch failed .*: the feed answered HTTP 403/.test(r.bdc.text), r.bdc.text);
  ok('and when it last worked', /Last good fetch/.test(r.bdc.text), r.bdc.text);
  ok('Booking.com: its copy of the Airbnb stay is matched, not added', r.bdc.added===1&&/1 stay matched to bookings you already had/.test(r.bdc.text), r.bdc);
  ok('and the booking deleted here is counted as staying deleted', /1 booking from this feed deleted here afterwards\. It stays deleted/.test(r.bdc.text), r.bdc.text);

  // the follow-up sync a few seconds later finds nothing new
  await page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
  let r2=await look();
  ok('a quiet sync afterwards keeps the figures', r2.air.added===3&&r2.air.updated===1&&r2.air.removed===1, r2.air);
  ok('and the last change', /Last change .*: 1 added, 1 updated, 1 removed/.test(r2.air.text), r2.air.text);
  ok('the overall line says nothing new this time', /Nothing new from the calendars/.test(await page.locator('[data-ical-log]').innerText()));

  await page.evaluate(()=>sessionStorage.setItem('__srv',JSON.stringify(window.__server)));   // the cloud outlives the app
  await page.reload(); await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(async()=>{await window.StayLogCloud.restoreSession();});
  let r3=await look();
  ok('reopening the app keeps them too', r3.air.added===3&&/Last change/.test(r3.air.text), r3.air);

  await page.evaluate(()=>{window.__server.writes=[];window.__server.invoked=[];});
  await page.locator('[data-ical-check]').click(); await page.waitForTimeout(600);
  const after=await page.evaluate(()=>({inv:window.__server.invoked,ups:window.__server.writes.filter(w=>w.op==='upsert').length}));
  ok('Check now fetches the feeds', after.inv.includes('ical-sync'), after);
  ok('and then syncs', after.ups>0, after);
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
