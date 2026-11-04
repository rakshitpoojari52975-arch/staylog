/* "<platform> is connected to <other>'s calendar". Airbnb and Booking.com
   are linked, so Airbnb closes Booking.com stays by itself — and Airbnb's
   export leaves those copied dates out (confirmed on the real feed). The
   still-open check would then flag every Booking.com stay as open on Airbnb.
   With the feed marked connected (ical_feeds.connected), the other
   platform's stays are not checked against it; direct stays still are. And
   one warning can be dismissed on the booking ("Closed on <platform>"),
   for those dates only. */
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
    select(c){q.cols=c||'';return api;}, eq(k,v){q.f.push([k,v]);return api;}, is(k,v){q.f.push([k,v]);return api;},
    not(k,op,list){q.notIn=String(list).replace(/^\\(|\\)$/g,'').split(',').map(x=>x.replace(/"/g,''));return api;},
    order(){return api;}, limit(){return api;},
    update(v){q.op='update';q.val=v;return api;}, delete(){q.op='delete';return api;},
    async upsert(rows,o){S.writes.push({table,op:'upsert',rows});const t=S.rows[table]=S.rows[table]||[];
      rows.forEach(r=>{const keys=(o&&o.onConflict||'id').split(',');
        const i=t.findIndex(x=>keys.every(k=>x[k]===r[k]));i<0?t.push({...r}):Object.assign(t[i],r);});
      return{error:null};},
    then(res){
      if(S.missing[table])return Promise.resolve(res({data:null,error:{code:'PGRST205',message:"Could not find the table 'public."+table+"' in the schema cache"}}));
      if(S.noConnected&&table==='ical_feeds'&&(/connected/.test(q.cols||'')||(q.op==='update'&&q.val&&'connected' in q.val)))
        return Promise.resolve(res({data:null,error:{code:'42703',message:'column ical_feeds.connected does not exist'}}));
      const t=S.rows[table]||[];
      if(table==='attendance')return Promise.resolve(res({data:[],error:null}));
      if(q.op==='update'){const hit=t.filter(match);hit.forEach(r=>Object.assign(r,q.val));
        if(hit.length)S.writes.push({table,op:'update',val:q.val,n:hit.length});return Promise.resolve(res({data:null,error:null}));}
      if(q.op==='delete'){const keep=t.filter(r=>!match(r));S.writes.push({table,op:'delete',n:t.length-keep.length});
        S.rows[table]=keep;return Promise.resolve(res({data:null,error:null}));}
      return Promise.resolve(res({data:t.filter(match).map(r=>({...r})),error:null}));
    }};return api;},
})};`;


const ev=o=>Object.assign({owner_id:'owner-1',property_id:'p1',description:'',gone_at:null,imported_booking_id:null},o);
const BDC=o=>ev(Object.assign({feed_id:'f-bdc',platform:'Booking.com',summary:'CLOSED - Not available',kind:'reserved'},o));
const AIRBLOCK=o=>ev(Object.assign({feed_id:'f-air',platform:'Airbnb',summary:'Airbnb (Not available)',kind:'blocked'},o));
const bk=(id,o)=>Object.assign({id,propertyId:'p1',guestName:'Guest '+id,phone:'',checkIn:D(5),checkOut:D(8),guests:2,
  totalAmount:6000,paid:6000,source:'Direct',status:'confirmed',notes:''},o);
const now=new Date().toISOString();
const FEED=(id,platform,o)=>Object.assign({id,owner_id:'owner-1',property_id:'p1',platform,url:'https://'+id,last_fetched_at:now,last_ok_at:now,last_count:1,last_error:null},o);
// Booking.com's stay (in its own feed, absent from Airbnb's); a direct stay closed by hand on
// Airbnb (which proves the Airbnb feed is worth judging); a direct stay nobody closed on Airbnb.
const SEED={properties:[{id:'p1',name:'Raaya Vasyam',rooms:1}],staff:[],loans:[],expenses:[],attendance:[],
  bookings:[bk('dirA',{checkIn:D(40),checkOut:D(42)}),bk('dirB',{checkIn:D(50),checkOut:D(52)})]};
const EVENTS=[BDC({uid:'b1',start_date:D(5),end_date:D(8)}),
  AIRBLOCK({uid:'blk',start_date:D(40),end_date:D(42),imported_booking_id:'dirA'}),
  BDC({uid:'bA',start_date:D(40),end_date:D(42),imported_booking_id:'dirA'}),
  BDC({uid:'bB',start_date:D(50),end_date:D(52),imported_booking_id:'dirB'})];

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(o={})=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',d=>d.accept());
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));},SEED);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(async([ev,fe,o])=>{window.__server.rows.ical_events=ev;window.__server.rows.ical_feeds=fe;
    window.__server.noConnected=!!o.noConnected;
    await window.StayLogCloud.restoreSession();await window.StayLogCloud.push(state.data);state.loggedIn=true;render();},
    [JSON.parse(JSON.stringify(EVENTS)),[FEED('f-air','Airbnb',o.air||{}),FEED('f-bdc','Booking.com')],o]);
  return {ctx,page,errs};
};
const sync=page=>page.evaluate(async()=>{await window.StayLogCloud.push(state.data);});
const gapsOf=page=>page.evaluate(()=>{const g={};state.data.bookings.forEach(b=>{const x=openGapsFor(b).map(y=>y.platform);if(x.length)g[b.id]=x;});return g;});
const bdcId=page=>page.evaluate(()=>state.data.bookings.find(b=>b.source==='Booking.com').id);
const cloudPanel=async page=>{await page.evaluate(()=>{state.modal='cloud';render();});await page.waitForTimeout(400);};
const homeAlert=async page=>{await page.evaluate(()=>{state.modal=null;state.tab='dashboard';render();});await page.waitForTimeout(150);
  return page.locator('[data-cal-alert]').innerText().catch(()=>'');};

console.log('\n— connected off: as before —');
{ const {ctx,page,errs}=await open();
  const id=await bdcId(page), g=await gapsOf(page);
  ok('the Booking.com stay is imported', /^ics_/.test(id), id);
  ok('and, Airbnb\'s export leaving it out, is called still open on Airbnb', (g[id]||[]).includes('Airbnb'), g);
  ok('the direct stay nobody closed on Airbnb is too', (g.dirB||[]).includes('Airbnb'), g);
  ok('the direct stay closed on Airbnb is not', !(g.dirA||[]).includes('Airbnb'), g);
  await cloudPanel(page);
  const sw=page.locator('[data-feed-connected="f-air"]');
  ok('Calendar sync offers "Airbnb is connected to Booking.com’s calendar", off', /Airbnb is connected to Booking\.com’s calendar/.test(await sw.innerText())&&await sw.getAttribute('aria-checked')==='false');
  ok('explained under it', (await page.locator('[data-feed-report="f-air"] [data-feed-connected-note]').innerText())
     ==='Airbnb’s calendar link doesn’t include dates it copies from Booking.com, so those stays can’t be checked there.');
  ok('and the Booking.com feed has its own', /Booking\.com is connected to Airbnb’s calendar/.test(await page.locator('[data-feed-connected="f-bdc"]').innerText()));

  console.log('\n— connected on —');
  await sw.click(); await page.waitForTimeout(600);
  ok('the setting is saved in ical_feeds', await page.evaluate(()=>window.__server.rows.ical_feeds.find(f=>f.id==='f-air').connected)===true);
  let g2=await gapsOf(page);
  ok('the Booking.com stay raises no Airbnb gap', !(g2[id]||[]).includes('Airbnb'), g2);
  ok('the direct stay still does', (g2.dirB||[]).includes('Airbnb'), g2);
  ok('the Booking.com feed is unaffected (its own setting is off)', await page.evaluate(()=>window.__server.rows.ical_feeds.find(f=>f.id==='f-bdc').connected)!==true);
  await cloudPanel(page);
  ok('the switch shows on', await page.locator('[data-feed-connected="f-air"]').getAttribute('aria-checked')==='true');
  ok('Calendar sync counts one stay still open on Airbnb, not two', /1 stay still open on Airbnb/.test(await page.locator('[data-feed-report="f-air"]').innerText()));
  await sync(page); await sync(page);
  g2=await gapsOf(page);
  ok('two more syncs: still on, still no Airbnb gap for it', await page.evaluate(()=>window.__server.rows.ical_feeds.find(f=>f.id==='f-air').connected)===true
     &&!(g2[id]||[]).includes('Airbnb')&&(g2.dirB||[]).includes('Airbnb'), g2);
  ok('ical_feeds is never pushed as app data', !(await page.evaluate(()=>window.__server.writes.some(w=>w.op==='upsert'&&w.table==='ical_feeds'))));
  await cloudPanel(page);
  await page.locator('[data-feed-connected="f-air"]').click(); await page.waitForTimeout(600);
  ok('turned off again, the Booking.com stay is checked again', ((await gapsOf(page))[id]||[]).includes('Airbnb'));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— "Closed on Airbnb" on one booking —');
{ const {ctx,page,errs}=await open({air:{connected:true}});
  let home=await homeAlert(page);
  ok('Home counts the open direct stay', /1 stay is still open on another platform — Airbnb/.test(home), home);
  await page.evaluate(()=>{state.tab='bookings';state.bookingFilter='all';render();}); await page.waitForTimeout(150);
  const card=page.locator('.card',{hasText:'Guest dirB'}).first();
  ok('its warning has "Closed on Airbnb"', await card.locator('[data-gap-closed="Airbnb"]').innerText()==='Closed on Airbnb');
  await card.locator('[data-gap-closed="Airbnb"]').click(); await page.waitForTimeout(150);
  ok('tapping it hides the warning', await page.locator('.card',{hasText:'Guest dirB'}).first().locator('[data-open]').count()===0);
  const b=await page.evaluate(()=>state.data.bookings.find(x=>x.id==='dirB'));
  ok('kept on the booking for these dates', b.gapClosed&&b.gapClosed.Airbnb===`${D(50)}|${D(52)}`, b.gapClosed);
  home=await homeAlert(page);
  ok('and left out of the count on Home', !/still open/.test(home), home);
  await cloudPanel(page);
  ok('and in Calendar sync', !/still open on Airbnb/.test(await page.locator('[data-feed-report="f-air"]').innerText()));
  await sync(page);
  const row=await page.evaluate(()=>(window.__server.rows.bookings||[]).find(r=>r.id==='dirB'));
  ok('never sent to the cloud', row&&!JSON.stringify(row).includes('gap')&&!JSON.stringify(row).includes('Closed'), row);
  ok('but in the encrypted backup\'s plaintext (the whole data, less ID photos)', await page.evaluate(()=>{
    const d=JSON.parse(JSON.stringify(state.data));return !!d.bookings.find(x=>x.id==='dirB').gapClosed;}));
  ok('still dismissed after a sync', !((await gapsOf(page)).dirB||[]).includes('Airbnb'));
  // the stay moves: the dismissal no longer applies
  await page.evaluate(d=>{mutateData(x=>{const b=x.bookings.find(y=>y.id==='dirB');b.checkOut=d;});},D(53));
  await sync(page);
  ok('new dates bring the warning back', ((await gapsOf(page)).dirB||[]).includes('Airbnb'), await gapsOf(page));
  home=await homeAlert(page);
  ok('and the count', /1 stay is still open on another platform — Airbnb/.test(home), home);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— before ical-connected.sql has run —');
{ const {ctx,page,errs}=await open({noConnected:true});
  const id=await bdcId(page);
  ok('the check runs as before', ((await gapsOf(page))[id]||[]).includes('Airbnb'));
  await cloudPanel(page);
  ok('Calendar sync still loads', await page.locator('[data-feed-report="f-air"]').count()===1);
  ok('the switch is off and disabled, naming the script', await page.locator('[data-feed-connected="f-air"]').isDisabled()
     &&/Run supabase\/ical-connected\.sql/.test(await page.locator('[data-feed-report="f-air"] [data-feed-connected-note]').innerText()));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— the check on its own —');
{ const {ctx,page}=await open();
  const t=D(0), F=[FEED('f-air','Airbnb'),FEED('f-bdc','Booking.com')];
  const evs=[BDC({uid:'mir',start_date:D(5),end_date:D(8),imported_booking_id:'ics_a'}),
    AIRBLOCK({uid:'blk',start_date:D(40),end_date:D(42),imported_booking_id:'dirA'})];
  const bs=[bk('ics_a',{source:'Airbnb',checkIn:D(5),checkOut:D(8)}),bk('ics_a2',{source:'Airbnb',checkIn:D(20),checkOut:D(22)}),
    bk('ics_b',{source:'Booking.com',checkIn:D(30),checkOut:D(32)}),bk('dirA',{checkIn:D(40),checkOut:D(42)}),bk('dirB',{checkIn:D(50),checkOut:D(52)})];
  const run=feeds=>page.evaluate(([e,f,b,t])=>window.StayLogCloud._coverageGaps(e,f,b,t),[evs,feeds,bs,t]);
  let r=await run(F);
  const has=(r,id,p)=>(r.gaps[id]||[]).some(g=>g.platform===p);
  ok('off: an Airbnb stay Booking.com has not closed is flagged there', has(r,'ics_a2','Booking.com'));
  r=await run([F[0],{...F[1],connected:true}]);
  ok('Booking.com connected: Airbnb stays are not checked against it', !has(r,'ics_a2','Booking.com'));
  ok('direct stays still are', has(r,'dirB','Booking.com'));
  ok('and the Airbnb feed is unaffected', has(r,'ics_b','Airbnb'));
  await ctx.close(); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
