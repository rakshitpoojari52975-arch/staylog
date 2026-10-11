/* The ical-sync Edge Function, run in Node against a fake network: the two
   platforms' feeds and an in-memory PostgREST. No Supabase account needed.
   The function file is TypeScript; Node strips the types on import. */
const path=require('path');
const FN=path.resolve(__dirname,'../supabase/functions/ical-sync/index.ts');
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const CRLF=s=>s.replace(/\n/g,'\r\n');

// What Airbnb's export looks like: CRLF, a folded DESCRIPTION, a Reserved stay
// and a block. The long line is folded the way RFC 5545 folds it.
const AIRBNB=CRLF(`BEGIN:VCALENDAR
PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN
CALSCALE:GREGORIAN
VERSION:2.0
BEGIN:VEVENT
DTEND;VALUE=DATE:20261018
DTSTART;VALUE=DATE:20261015
UID:1418fb94e984-0a1b2c3d4e5f60718293a4b5c6d7e8f9@airbnb.com
DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/d
 etails/HMABCDE123\\nPhone Number (Last 4 Digits): 4321
SUMMARY:Reserved
END:VEVENT
BEGIN:VEVENT
DTEND;VALUE=DATE:20261025
DTSTART;VALUE=DATE:20261022
UID:7f3b2a1c9d8e-11aa22bb33cc44dd55ee66ff7788@airbnb.com
SUMMARY:Airbnb (Not available)
END:VEVENT
END:VCALENDAR
`);
// Booking.com: every event is "CLOSED - Not available"
const BOOKING=CRLF(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//admin.booking.com//EN
BEGIN:VEVENT
UID:b9c8d7e6f5a4@booking.com
DTSTAMP:20261011T120000Z
DTSTART;VALUE=DATE:20261022
DTEND;VALUE=DATE:20261025
SUMMARY:CLOSED - Not available
END:VEVENT
BEGIN:VEVENT
UID:c0ffee000111@booking.com
DTSTAMP:20261011T120000Z
DTSTART;VALUE=DATE:20261101
DTEND;VALUE=DATE:20261103
SUMMARY:CLOSED - Not available
END:VEVENT
END:VCALENDAR
`);

// ── fake world ───────────────────────────────────────────────────────────────
function world(){
  const W={
    feeds:[
      {id:'f-air',owner_id:'owner-1',property_id:'p1',platform:'Airbnb',url:'https://www.airbnb.com/calendar/ical/1.ics?s=x'},
      {id:'f-bdc',owner_id:'owner-1',property_id:'p1',platform:'Booking.com',url:'https://admin.booking.com/hotel/ical.ics?t=y'},
      {id:'f-oth',owner_id:'owner-2',property_id:'q1',platform:'Airbnb',url:'https://www.airbnb.com/calendar/ical/2.ics?s=z'},
    ],
    events:[], feedBodies:{}, feedStatus:{}, calls:[], userTokens:{'tok-owner-1':'owner-1'},
  };
  W.feedBodies['https://www.airbnb.com/calendar/ical/1.ics?s=x']=AIRBNB;
  W.feedBodies['https://admin.booking.com/hotel/ical.ics?t=y']=BOOKING;
  W.feedBodies['https://www.airbnb.com/calendar/ical/2.ics?s=z']=CRLF('BEGIN:VCALENDAR\nEND:VCALENDAR\n');
  const res=(status,body)=>new Response(status===204||body==null?null:typeof body==='string'?body:JSON.stringify(body),{status});
  W.fetch=async(url,init={})=>{
    const u=new URL(url), method=(init.method||'GET').toUpperCase(), h=init.headers||{};
    W.calls.push({method,url,headers:h});
    if(u.host==='proj.supabase.co'){
      if(h.apikey!=='service-key-123')return res(401,{message:'bad apikey'});
      if(u.pathname==='/auth/v1/user'){const id=W.userTokens[(h.Authorization||'').replace('Bearer ','')];
        return id?res(200,{id}):res(401,{msg:'invalid token'});}
      const table=u.pathname.replace('/rest/v1/',''), q=u.searchParams;
      const eq=k=>{const v=q.get(k);return v&&v.startsWith('eq.')?decodeURIComponent(v.slice(3)):null;};
      if(table==='ical_feeds'&&method==='GET'){
        let rows=W.feeds; if(eq('owner_id'))rows=rows.filter(f=>f.owner_id===eq('owner_id'));return res(200,rows);}
      if(table==='ical_feeds'&&method==='PATCH'){
        const id=eq('id'); W.feedStatus[id]={...(W.feedStatus[id]||{}),...JSON.parse(init.body)};return res(204);}
      if(table==='ical_events'&&method==='GET')
        return res(200,W.events.filter(e=>e.feed_id===eq('feed_id')).map(e=>({uid:e.uid,gone_at:e.gone_at})));
      if(table==='ical_events'&&method==='POST'){
        if(q.get('on_conflict')!=='feed_id,uid')return res(400,'bad on_conflict');
        for(const r of JSON.parse(init.body)){
          const i=W.events.findIndex(e=>e.feed_id===r.feed_id&&e.uid===r.uid);
          if(i<0)W.events.push({first_seen_at:'FIRST',imported_booking_id:null,...r});
          else W.events[i]={...W.events[i],...r};            // merge: unspecified columns kept
        }
        return res(201);}
      if(table==='ical_events'&&method==='PATCH'){
        const body=JSON.parse(init.body);
        W.events.filter(e=>e.feed_id===eq('feed_id')&&e.uid===eq('uid')).forEach(e=>Object.assign(e,body));
        return res(204);}
      return res(404,'no route '+table);
    }
    if(url in W.feedBodies){const b=W.feedBodies[url];return typeof b==='number'?res(b,'nope'):res(200,b);}
    return res(404,'unknown host');
  };
  return W;
}
const ENV={SUPABASE_URL:'https://proj.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service-key-123',ICAL_CRON_SECRET:'s3cret-cron-value'};
const post=(headers={})=>new Request('https://proj.supabase.co/functions/v1/ical-sync',{method:'POST',headers});

(async()=>{
const F=await import(FN);

console.log('\n— parsing what the platforms send —');
{ const a=F.parseIcs(AIRBNB);
  ok('both Airbnb events are read', a.length===2, a);
  ok('dates come out as plain dates', a[0].start==='2026-10-15'&&a[0].end==='2026-10-18', a[0]);
  ok('a folded line is unfolded', a[0].description.includes('/reservations/details/HMABCDE123'), a[0].description);
  ok('escaped newlines become real ones', a[0].description.includes('\nPhone Number (Last 4 Digits): 4321'), a[0].description);
  ok('Reserved is a stay', F.kindOf('Airbnb',a[0].summary)==='reserved');
  ok('Not available is a block', F.kindOf('Airbnb',a[1].summary)==='blocked');
  const b=F.parseIcs(BOOKING);
  ok('Booking.com events are read', b.length===2&&b[0].uid==='b9c8d7e6f5a4@booking.com', b);
  ok('every Booking.com event counts as a stay', b.every(e=>F.kindOf('Booking.com',e.summary)==='reserved'));
  const odd=F.parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:20261031T140000Z\nSUMMARY:Reserved\nEND:VEVENT\n'+
    'BEGIN:VEVENT\nUID:y\nDTSTART;VALUE=DATE:20261105\nDTEND;VALUE=DATE:20261106\nSTATUS:CANCELLED\nEND:VEVENT\n'+
    'BEGIN:VEVENT\nUID:z\nDTSTART;VALUE=DATE:20261231\nEND:VEVENT\nEND:VCALENDAR');
  ok('a datetime is cut to its date', odd[0]&&odd[0].start==='2026-10-31', odd);
  ok('no end means one night', odd[0]&&odd[0].end==='2026-11-01', odd[0]);
  ok('one night across New Year', odd.find(e=>e.uid==='z')?.end==='2027-01-01', odd);
  ok('a cancelled event is dropped', !odd.some(e=>e.uid==='y'), odd);
  ok('garbage parses to nothing, not an error', F.parseIcs('<html>login</html>').length===0); }

console.log('\n— who may run it —');
{ const W=world();
  let r=await F.handle(post(),ENV,W.fetch);
  ok('no credentials: 401', r.status===401);
  r=await F.handle(post({'x-cron-secret':'wrong-value-same-len'}),ENV,W.fetch);
  ok('wrong cron secret: 401', r.status===401);
  r=await F.handle(post({'x-cron-secret':'s3cret-cron-value'}),{...ENV,ICAL_CRON_SECRET:''},W.fetch);
  ok('no secret configured: the cron header opens nothing', r.status===401);
  r=await F.handle(post({authorization:'Bearer forged'}),ENV,W.fetch);
  ok('an invalid user token: 401', r.status===401);
  ok('and no feed was read', !W.calls.some(c=>c.url.includes('airbnb')||c.url.includes('booking')));
  r=await F.handle(new Request('https://x/functions/v1/ical-sync',{method:'OPTIONS'}),ENV,W.fetch);
  ok('CORS preflight answers', r.status===204&&r.headers.get('access-control-allow-origin')==='*'
     &&/authorization/.test(r.headers.get('access-control-allow-headers')));
  r=await F.handle(new Request('https://x/f',{method:'GET'}),ENV,W.fetch);
  ok('GET is refused', r.status===405);
  r=await F.handle(post({'x-cron-secret':'s3cret-cron-value'}),{SUPABASE_URL:'https://proj.supabase.co'},W.fetch);
  ok('missing settings say so', r.status===500); }

console.log('\n— the owner\'s Import now —');
{ const W=world();
  const r=await F.handle(post({authorization:'Bearer tok-owner-1'}),ENV,W.fetch), body=await r.json();
  ok('it runs', r.status===200&&body.ok, body);
  ok('only their own feeds', body.feeds.length===2&&!W.calls.some(c=>c.url.includes('2.ics')), body.feeds.map(f=>f.id));
  ok('every event is recorded', W.events.length===4, W.events.map(e=>e.uid));
  const air=W.events.find(e=>e.platform==='Airbnb'&&e.kind==='reserved');
  ok('with property, platform, dates and kind',
     air&&air.property_id==='p1'&&air.start_date==='2026-10-15'&&air.end_date==='2026-10-18'&&air.owner_id==='owner-1', air);
  ok('the feed status is written', W.feedStatus['f-air']?.last_count===2&&W.feedStatus['f-air']?.last_error===null, W.feedStatus);
  ok('the service key is sent as apikey only (a non-JWT key)',
     W.calls.filter(c=>c.url.includes('/rest/v1/')).every(c=>c.headers.apikey==='service-key-123'&&!c.headers.Authorization)); }

{ const W=world();
  await F.handle(post({authorization:'Bearer tok-owner-1'}),{...ENV,SUPABASE_SERVICE_ROLE_KEY:'eyJhbGciOi.legacy'},
    async(u,i)=>{ if(String(u).includes('/rest/v1/'))W.lastAuth=(i.headers||{}).Authorization; return W.fetch(u,{...i,headers:{...i.headers,apikey:'service-key-123'}}); });
  ok('a legacy JWT service key also goes in Authorization', W.lastAuth==='Bearer eyJhbGciOi.legacy', W.lastAuth); }

console.log('\n— the cron run —');
{ const W=world();
  const r=await F.handle(post({'x-cron-secret':'s3cret-cron-value'}),ENV,W.fetch), body=await r.json();
  ok('reads every feed', body.feeds.length===3, body.feeds);
  ok('an empty calendar is fine', body.feeds.find(f=>f.id==='f-oth').ok===true); }

console.log('\n— runs again: updates, disappearances, comebacks —');
{ const W=world(); const go=()=>F.handle(post({'x-cron-secret':'s3cret-cron-value'}),ENV,W.fetch);
  await go();
  W.events.find(e=>e.uid.startsWith('1418')).imported_booking_id='ics_abc';
  // the Airbnb guest moves their stay by a day; the block is lifted
  W.feedBodies['https://www.airbnb.com/calendar/ical/1.ics?s=x']=AIRBNB.replace('20261018','20261019')
    .replace(/BEGIN:VEVENT\r\nDTEND;VALUE=DATE:20261025[\s\S]*?END:VEVENT\r\n/,'');
  const body=await (await go()).json();
  const stay=W.events.find(e=>e.uid.startsWith('1418')), block=W.events.find(e=>e.uid.startsWith('7f3b'));
  ok('changed dates are written', stay.end_date==='2026-10-19', stay);
  ok('without losing what the phone stamped', stay.imported_booking_id==='ics_abc', stay);
  ok('or when it was first seen', stay.first_seen_at==='FIRST', stay);
  ok('an event no longer in the feed is marked gone', !!block.gone_at, block);
  ok('not deleted', W.events.length===4);
  ok('and reported', body.feeds.find(f=>f.id==='f-air').gone===1, body.feeds);
  W.feedBodies['https://www.airbnb.com/calendar/ical/1.ics?s=x']=AIRBNB;
  await go();
  const back=W.events.find(e=>e.uid.startsWith('7f3b'));
  ok('if it comes back, it is no longer gone', back.gone_at===null, back); }

console.log('\n— failures stay with their feed —');
{ const W=world(); W.feedBodies['https://admin.booking.com/hotel/ical.ics?t=y']=403;
  const body=await (await F.handle(post({'x-cron-secret':'s3cret-cron-value'}),ENV,W.fetch)).json();
  const b=body.feeds.find(f=>f.id==='f-bdc');
  ok('a refused feed reports why', b.ok===false&&/HTTP 403/.test(b.error), b);
  ok('and it is written on the feed', /HTTP 403/.test(W.feedStatus['f-bdc'].last_error), W.feedStatus['f-bdc']);
  ok('the other feeds still run', body.feeds.find(f=>f.id==='f-air').ok===true);
  ok('nothing of the failed feed is marked gone', !W.events.some(e=>e.gone_at)); }

{ const W=world(); W.feedBodies['https://admin.booking.com/hotel/ical.ics?t=y']='<html>Please sign in</html>';
  const body=await (await F.handle(post({'x-cron-secret':'s3cret-cron-value'}),ENV,W.fetch)).json();
  ok('a login page is not a calendar', /did not return a calendar/.test(body.feeds.find(f=>f.id==='f-bdc').error), body.feeds); }

{ const W=world(); const go=()=>F.handle(post({'x-cron-secret':'s3cret-cron-value'}),ENV,W.fetch);
  W.feedBodies['https://admin.booking.com/hotel/ical.ics?t=y']=BOOKING.replace('END:VCALENDAR',
    'BEGIN:VEVENT\r\nUID:extra1\r\nDTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261203\r\nEND:VEVENT\r\nEND:VCALENDAR');
  await go();
  W.feedBodies['https://admin.booking.com/hotel/ical.ics?t=y']=CRLF('BEGIN:VCALENDAR\nEND:VCALENDAR\n');
  const body=await (await go()).json(), b=body.feeds.find(f=>f.id==='f-bdc');
  ok('a feed that suddenly comes back empty flags nothing', !W.events.some(e=>e.gone_at), W.events);
  ok('and says why', /came back empty; 3 stays/.test(b.error||''), b);
  ok('the feed shows it as a problem', /came back empty/.test(W.feedStatus['f-bdc'].last_error), W.feedStatus['f-bdc']); }

console.log('\n— the link never leaks into an error —');
{ const W=world(); const real=W.fetch;
  // Deno's fetch quotes the URL in a network error, and the URL is the feed's password
  W.fetch=async(url,init)=>{ if(String(url).startsWith('https://admin.booking.com/'))
    throw new TypeError('error sending request for url (https://admin.booking.com/hotel/ical.ics?t=y): connection refused');
    return real(url,init); };
  const body=await (await F.handle(post({'x-cron-secret':'s3cret-cron-value'}),ENV,W.fetch)).json();
  const stored=W.feedStatus['f-bdc'].last_error, sent=JSON.stringify(body);
  ok('the stored error keeps the reason', /connection refused/.test(stored), stored);
  ok('but not the link', !/ical\.ics|t=y|admin\.booking\.com/.test(stored), stored);
  ok('nor does the reply', !/ical\.ics\?t=y/.test(sent), sent); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
