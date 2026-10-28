/* "New booking" pushes for stays the calendar import finds. The real ical-sync
   and notify functions run together against one fake database, with fake
   Airbnb and Booking.com feeds and a fake push service: ical-sync reads the
   feeds and hands what is new to notify, which decides and sends. Each push
   is decrypted with the device's keys, as Apple's would be. Then the app:
   the toggle, and what a tap opens. */
const path=require('path'),fs=require('fs'),http=require('http');
const ROOT=path.resolve(__dirname,'..');
const {subtle}=globalThis.crypto;
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const b64u=b=>Buffer.from(b).toString('base64url');
const cat=(...p)=>{const o=new Uint8Array(p.reduce((n,x)=>n+x.length,0));let i=0;for(const x of p){o.set(x,i);i+=x.length;}return o;};
const te=new TextEncoder();
const hmac=async(k,d)=>new Uint8Array(await subtle.sign('HMAC',await subtle.importKey('raw',k,{name:'HMAC',hash:'SHA-256'},false,['sign']),d));
async function device(endpoint,owner){
  const kp=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const pub=new Uint8Array(await subtle.exportKey('raw',kp.publicKey)), auth=crypto.getRandomValues(new Uint8Array(16));
  return {row:{endpoint,owner_id:owner,p256dh:b64u(pub),auth:b64u(auth)},kp,pub,auth};
}
async function decrypt(dev,body){
  const salt=body.slice(0,16), idlen=body[20], asPub=body.slice(21,21+idlen), ct=body.slice(21+idlen);
  const asKey=await subtle.importKey('raw',asPub,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await subtle.deriveBits({name:'ECDH',public:asKey},dev.kp.privateKey,256));
  const ikm=(await hmac(await hmac(dev.auth,shared),cat(te.encode('WebPush: info\0'),dev.pub,asPub,new Uint8Array([1])))).slice(0,32);
  const prk=await hmac(salt,ikm);
  const cek=(await hmac(prk,cat(te.encode('Content-Encoding: aes128gcm\0'),new Uint8Array([1])))).slice(0,16);
  const nonce=(await hmac(prk,cat(te.encode('Content-Encoding: nonce\0'),new Uint8Array([1])))).slice(0,12);
  const pt=new Uint8Array(await subtle.decrypt({name:'AES-GCM',iv:nonce},await subtle.importKey('raw',cek,{name:'AES-GCM'},false,['decrypt']),ct));
  return JSON.parse(new TextDecoder().decode(pt.slice(0,-1)));
}
const ics=evs=>['BEGIN:VCALENDAR','VERSION:2.0',...evs.flatMap(e=>['BEGIN:VEVENT',`UID:${e.uid}`,
  `DTSTART;VALUE=DATE:${e.in.replace(/-/g,'')}`,`DTEND;VALUE=DATE:${e.out.replace(/-/g,'')}`,`SUMMARY:${e.summary}`,
  ...(e.desc?[`DESCRIPTION:${e.desc}`]:[]),'END:VEVENT']),
  'END:VCALENDAR'].join('\r\n');
const RES=(uid,i,o)=>({uid,in:i,out:o,summary:'Reserved'});               // an Airbnb guest
const BLK=(uid,i,o)=>({uid,in:i,out:o,summary:'Airbnb (Not available)'});  // an Airbnb block
const BDC=(uid,i,o)=>({uid,in:i,out:o,summary:'CLOSED - Not available'});  // anything on Booking.com

const OWNER='owner-1', BASE='https://proj.supabase.co';
const NOW=Date.parse('2026-10-27T03:00:00Z');   // 27 Oct, 8:30 AM IST
const FEED_A='https://www.airbnb.example/calendar/ical/1.ics?s=made-up';
const FEED_B='https://admin.booking.example/hotel/ical.html?t=made-up';

function world(){
  const W={feeds:{[FEED_A]:[],[FEED_B]:[]},pushes:[],notifyCalls:[],gone:new Set(),
    t:{ical_feeds:[{id:'fA',owner_id:OWNER,property_id:'p1',platform:'Airbnb',url:FEED_A,last_ok_at:null},
                   {id:'fB',owner_id:OWNER,property_id:'p1',platform:'Booking.com',url:FEED_B,last_ok_at:null}],
       ical_events:[],push_subscriptions:[],notification_prefs:[],push_log:[],
       bookings:[],properties:[{id:'p1',owner_id:OWNER,name:'Raaya Vasyam'}]}};
  let clock=0;
  const res=(s,b)=>new Response(b==null?null:JSON.stringify(b),{status:s});
  const match=(row,q)=>{for(const [k,v] of q){if(['select','on_conflict','order','limit'].includes(k))continue;
    const val=row[k]; if(v==='is.null'){if(val!=null)return false;}
    else if(v.startsWith('eq.')){if(String(val)!==decodeURIComponent(v.slice(3)))return false;}
    else if(v.startsWith('neq.')){if(String(val)===decodeURIComponent(v.slice(4)))return false;}}return true;};
  W.fetch=async(url,init={})=>{
    const u=new URL(url), m=(init.method||'GET').toUpperCase(), h=init.headers||{};
    if(url in W.feeds)return new Response(ics(W.feeds[url]),{status:200});
    if(u.origin===BASE&&u.pathname==='/functions/v1/notify'){
      W.notifyCalls.push(JSON.parse(init.body));
      return W.notify(new Request(url,{method:'POST',headers:h,body:init.body}));
    }
    if(u.origin===BASE){
      if(h.apikey!=='service-key')return res(401,{});
      const t=u.pathname.replace('/rest/v1/',''), T=W.t[t], q=[...u.searchParams];
      if(!T)return res(404,{});
      if(m==='GET')return res(200,T.filter(r=>match(r,q)));
      if(m==='DELETE'){W.t[t]=T.filter(r=>!match(r,q));return res(204);}
      if(m==='PATCH'){const b=JSON.parse(init.body);T.filter(r=>match(r,q)).forEach(r=>Object.assign(r,b));return res(204);}
      if(m==='POST'){const rows=JSON.parse(init.body),out=[];
        if(t==='ical_events'){for(const r of rows){const x=T.find(e=>e.feed_id===r.feed_id&&e.uid===r.uid);
            if(x)Object.assign(x,r);else T.push({...r,first_seen_at:new Date(NOW+(++clock)).toISOString(),imported_booking_id:null});}
          return res(201);}
        for(const r of rows){if(!T.some(x=>x.owner_id===r.owner_id&&x.key===r.key)){T.push({...r});out.push(r);}}
        return res(201,out);}
    }
    W.pushes.push({endpoint:url,body:new Uint8Array(init.body)});
    return new Response(null,{status:W.gone.has(url)?410:201});
  };
  return W;
}

(async()=>{
const ICAL=await import(path.join(ROOT,'supabase/functions/ical-sync/index.ts'));
const NOTIFY=await import(path.join(ROOT,'supabase/functions/notify/index.ts'));
const vk=await subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const ENV={SUPABASE_URL:BASE,SUPABASE_SERVICE_ROLE_KEY:'service-key',
  VAPID_PUBLIC_KEY:b64u(new Uint8Array(await subtle.exportKey('raw',vk.publicKey))),
  VAPID_PRIVATE_KEY:(await subtle.exportKey('jwk',vk.privateKey)).d,VAPID_SUBJECT:'mailto:owner@example.invalid',
  PUSH_CRON_SECRET:'push-secret',ICAL_CRON_SECRET:'ical-secret'};
const iphone=await device('https://web.push.apple.com/QGVzNew',OWNER);
const make=()=>{const W=world();W.t.push_subscriptions.push({...iphone.row});
  W.notify=req=>NOTIFY.handle(req,ENV,W.fetch,NOW);return W;};
const sync=(W,env=ENV)=>ICAL.handle(new Request(BASE+'/functions/v1/ical-sync',{method:'POST',
  headers:{'x-cron-secret':'ical-secret','content-type':'application/json'},body:'{}'}),env,W.fetch).then(r=>r.json());
const got=async W=>Promise.all(W.pushes.map(p=>decrypt(iphone,p.body)));

console.log('\n— a feed\'s first read announces nothing —');
const W=make();
W.feeds[FEED_A]=[RES('a-old','2026-11-01','2026-11-03')];
W.feeds[FEED_B]=[BDC('b-old','2026-11-01','2026-11-03'),BDC('b-old2','2026-11-05','2026-11-07')];
await sync(W);
ok('two feeds full of stays: no push', W.pushes.length===0&&W.notifyCalls.length===0, W.notifyCalls);
await sync(W);
ok('reading them again, nothing new: still none', W.pushes.length===0);

console.log('\n— a new Airbnb reservation —');
W.feeds[FEED_A].push(RES('a-new','2026-11-12','2026-11-14'));
await sync(W);
let ms=await got(W);
ok('one push', ms.length===1, ms);
ok('"New Airbnb booking"', ms[0]&&ms[0].title==='New Airbnb booking', ms[0]);
ok('"12 → 14 Nov · 2 nights · Raaya Vasyam", no guest name invented', ms[0]&&ms[0].body==='12 → 14 Nov · 2 nights · Raaya Vasyam', ms[0]);
ok('a tap opens that stay, and marks its inbox row read', ms[0]&&ms[0].url==='./#open=stay&prop=p1&in=2026-11-12&out=2026-11-14&n=stay%3Ap1%3A2026-11-12%3A2026-11-14', ms[0]);
ok('claimed once, by property and dates', W.t.push_log.filter(l=>l.key==='stay:p1:2026-11-12:2026-11-14').length===1);
await sync(W);
ok('the next read does not announce it again', W.pushes.length===1);
W.feeds[FEED_B].push(BDC('b-echo','2026-11-12','2026-11-14'));
await sync(W);
ok('the same dates then in the Booking.com feed: no second push', W.pushes.length===1);

console.log('\n— a new Booking.com stay —');
W.feeds[FEED_B].push(BDC('b-new','2026-11-20','2026-11-23'));
W.feeds[FEED_A].push(BLK('a-blk','2026-11-20','2026-11-23'));
await sync(W);
ms=await got(W);
ok('one push, "New Booking.com booking"', ms.length===2&&ms[1].title==='New Booking.com booking', ms.map(m=>m.title));
ok('its body', ms[1]&&ms[1].body==='20 → 23 Nov · 3 nights · Raaya Vasyam', ms[1]);
ok('its Airbnb block echo announces nothing', !W.notifyCalls.some(c=>c.events.some(e=>e.uid==='a-blk')));
W.feeds[FEED_A].push(BLK('a-blk2','2026-12-20','2026-12-22'));
await sync(W);
ok('nor does an Airbnb block on its own', W.pushes.length===2);

console.log('\n— what never notifies —');
W.feeds[FEED_A].push(RES('a-past','2026-10-25','2026-10-29'));
await sync(W);
ok('a stay whose check-in has passed', W.pushes.length===2);
W.feeds[FEED_A].find(e=>e.uid==='a-new').in='2026-11-13';
W.feeds[FEED_A].find(e=>e.uid==='a-new').out='2026-11-15';
await sync(W);
ok('moved dates (same reservation, new dates)', W.pushes.length===2);
W.feeds[FEED_A]=W.feeds[FEED_A].filter(e=>e.uid!=='a-new');
await sync(W);
ok('a cancellation ("No longer on Airbnb")', W.pushes.length===2&&W.t.ical_events.find(e=>e.uid==='a-new').gone_at);
W.t.bookings.push({id:'bk-mine',owner_id:OWNER,property_id:'p1',check_in:'2026-12-01',check_out:'2026-12-03',status:'confirmed',deleted_at:null});
W.feeds[FEED_B].push(BDC('b-mine','2026-12-01','2026-12-03'));
await sync(W);
ok('dates closed for a booking I added myself', W.pushes.length===2);
ok('a booking I add in the app sends nothing either (no trigger on bookings)', !/bookings/.test(fs.readFileSync(path.join(ROOT,'supabase/push.sql'),'utf8').match(/create or replace trigger[\s\S]*$/)?.[0]||''));

console.log('\n— the stay that arrives in both feeds at once —');
{ const X=make();
  X.t.ical_feeds.reverse();                          // Booking.com read first this time
  await sync(X);
  X.feeds[FEED_B].push(BDC('b-both','2026-11-28','2026-11-30'));
  X.feeds[FEED_A].push(RES('a-both','2026-11-28','2026-11-30'));
  await sync(X);
  const m=await got(X);
  ok('one push, not two', m.length===1, m.map(x=>x.title));
  ok('naming Airbnb, as the import itself prefers its "Reserved"', m[0]&&m[0].title==='New Airbnb booking', m[0]); }

console.log('\n— once, and only when wanted —');
{ const X=make(); await sync(X);
  X.feeds[FEED_A].push(RES('a-x','2026-11-16','2026-11-18'));
  X.t.notification_prefs.push({owner_id:OWNER,prefs:{newBookings:false}});
  const r=await sync(X);
  ok('the toggle off: no push', X.pushes.length===0&&X.notifyCalls.length===1, X.notifyCalls);
  X.t.notification_prefs[0].prefs={};
  const call=X.notifyCalls[0];
  const post=()=>NOTIFY.handle(new Request(BASE+'/functions/v1/notify',{method:'POST',
    headers:{'x-cron-secret':'push-secret','content-type':'application/json'},body:JSON.stringify(call)}),ENV,X.fetch,NOW);
  await post(); await post();
  ok('the same call arriving twice notifies once', X.pushes.length===1, X.pushes.length);
  await sync(X); await sync(X);
  ok('the import cron firing twice more adds nothing', X.pushes.length===1); }
{ const X=make(); await sync(X);
  X.feeds[FEED_A].push(RES('a-y','2026-11-16','2026-11-18'));
  await sync(X,{...ENV,PUSH_CRON_SECRET:''});
  ok('without notifications set up, the import calls nothing and still works',
     X.notifyCalls.length===0&&X.t.ical_events.some(e=>e.uid==='a-y')); }
{ const X=make();
  const r=await NOTIFY.handle(new Request(BASE+'/functions/v1/notify',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({job:'new-bookings',events:[{feed_id:'fA',uid:'x'}]})}),ENV,X.fetch,NOW);
  ok('nobody but the import can ask for one (no secret: 401)', r.status===401);
  const r2=await NOTIFY.handle(new Request(BASE+'/functions/v1/notify',{method:'POST',headers:{'x-cron-secret':'push-secret'},
    body:JSON.stringify({job:'new-bookings',events:[{feed_id:'fA',uid:'not-in-the-database'}]})}),ENV,X.fetch,NOW);
  ok('and an event the database does not hold sends nothing', r2.status===200&&X.pushes.length===0); }
ok('two months: "30 Nov → 2 Dec"', NOTIFY.stayDates('2026-11-30','2026-12-02')==='30 Nov → 2 Dec');

console.log('\n— the reservation text leaves the cloud once imported —');
{ const X=make(); await sync(X);
  const D1='Reservation URL: https://www.airbnb.example/hosting/reservations/details/HMABC\\nPhone Number (Last 4 Digits): 4471';
  X.feeds[FEED_A].push({...RES('a-d1','2026-11-24','2026-11-26'),desc:D1},{...RES('a-d2','2026-12-04','2026-12-06'),desc:D1});
  await sync(X);
  ok('until the phone imports it, the event keeps its text (the phone needs it)', X.t.ical_events.filter(e=>/^a-d/.test(e.uid)).every(e=>/4471/.test(e.description||'')));
  X.t.ical_events.find(e=>e.uid==='a-d1').imported_booking_id='ics_x';      // the phone's drain stamps it
  await sync(X);
  ok('once imported, the next read stores it without the link and phone digits', X.t.ical_events.find(e=>e.uid==='a-d1').description===null);
  ok('one not yet imported keeps it', /4471/.test(X.t.ical_events.find(e=>e.uid==='a-d2').description||'')); }

console.log('\n— the app —');
const { chromium } = require('playwright');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
  if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
  r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);
const br=await chromium.launch();
const BK=o=>Object.assign({id:'bk',propertyId:'p1',guestName:'Airbnb guest',phone:'',checkIn:'2026-11-12',checkOut:'2026-11-14',
  guests:1,totalAmount:'',paid:0,source:'Airbnb',status:'confirmed',notes:'',msgSent:{}},o);
const open=async(bookings,hash,drainAdds)=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**','**vendor/supabase.umd.js'])await ctx.route(g,r=>r.abort());
  const page=await ctx.newPage(); const errs=[];
  page.on('pageerror',e=>errs.push(e.message));
  await page.addInitScript(s=>localStorage.setItem('staylog_v2',JSON.stringify(s)),
    {properties:[{id:'p1',name:'Raaya Vasyam'}],staff:[],loans:[],expenses:[],attendance:[],bookings});
  await page.goto(`http://127.0.0.1:${srv.address().port}/index.html${hash}`);
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  // The import drain, as a sync would run it: it may add the booking.
  await page.evaluate(b=>{window.__drains=0;window.StayLogCloud.checkIn=async()=>{window.__drains++;
    if(b)mutateData(d=>d.bookings.push(b));};window.StayLogCloud.status=()=>({pushing:false});},drainAdds||null);
  await page.evaluate(()=>{state.loggedIn=true;render();}); await page.waitForTimeout(400);
  return {ctx,page,errs};
};
const st=page=>page.evaluate(()=>({tab:state.tab,exp:state.expandedBooking,hint:state.stayHint,drains:window.__drains}));
const LINK='#open=stay&prop=p1&in=2026-11-12&out=2026-11-14';
{ const {ctx,page,errs}=await open([BK({id:'ics_1'})],LINK);
  const s=await st(page);
  ok('a tap with the booking already on the phone opens it', s.tab==='bookings'&&s.exp==='ics_1', s);
  ok('no page errors', errs.length===0, errs); await ctx.close(); }
{ const {ctx,page,errs}=await open([BK({id:'old',checkIn:'2026-11-01',checkOut:'2026-11-03'})],LINK,BK({id:'ics_new'}));
  const s=await st(page);
  ok('not on the phone yet: it runs the import drain, then opens the booking it made', s.drains===1&&s.exp==='ics_new'&&!s.hint, s);
  ok('no page errors', errs.length===0, errs); await ctx.close(); }
{ const many=Array.from({length:14},(_,i)=>BK({id:'later'+i,checkIn:`2026-12-${String(i+10).padStart(2,'0')}`,checkOut:`2026-12-${String(i+12).padStart(2,'0')}`}));
  const {ctx,page,errs}=await open([...many,BK({id:'earlier',checkIn:'2026-11-01',checkOut:'2026-11-03'})],LINK);
  const s=await st(page);
  ok('still not there (offline): Bookings, at that check-in date, saying so', s.tab==='bookings'&&s.drains===1&&s.exp===null
     &&/not on this phone yet/.test(await page.locator('[data-stay-hint]').innerText()), s);
  ok('the list is scrolled to where that date falls', await page.evaluate(()=>{const el=document.querySelector('[data-checkin="2026-11-01"]');
    const r=el.getBoundingClientRect();return scrollY>0&&r.top>=0&&r.bottom<=innerHeight;}));
  ok('no page errors', errs.length===0, errs); await ctx.close(); }
{ const {ctx,page}=await open([BK({id:'ics_c',status:'cancelled'})],LINK);
  ok('a cancelled booking on those dates is not the one opened', (await st(page)).exp===null); await ctx.close(); }
{ const {ctx,page}=await open([],'#open=stay&prop=p1&in=junk&out=2026-11-14');
  ok('a malformed link just opens Bookings', (await st(page)).tab==='bookings'&&(await st(page)).drains===0); await ctx.close(); }
ok('the menu has a "New bookings" toggle, on unless turned off',
   /\['newBookings','New bookings'/.test(fs.readFileSync(path.join(ROOT,'app.js'),'utf8'))&&NOTIFY.ALERTS.includes('newBookings'));
await br.close(); srv.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
