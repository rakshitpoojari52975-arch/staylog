/* The notify Edge Function, run in Node against a fake database and a fake
   push service. Each push is decrypted here with the subscription's own keys
   (RFC 8291), and its VAPID signature verified with the public key (RFC 8292),
   so what reaches Apple is proven readable and signed, not assumed. The VAPID
   keys are made fresh for each run and never written anywhere. */
const path=require('path');
const FN=path.resolve(__dirname,'../supabase/functions/notify/index.ts');
const {subtle}=globalThis.crypto;
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const b64u=b=>Buffer.from(b).toString('base64url'), unb64u=s=>new Uint8Array(Buffer.from(s,'base64url'));
const cat=(...p)=>{const o=new Uint8Array(p.reduce((n,x)=>n+x.length,0));let i=0;for(const x of p){o.set(x,i);i+=x.length;}return o;};
const te=new TextEncoder();
const hmac=async(k,d)=>new Uint8Array(await subtle.sign('HMAC',await subtle.importKey('raw',k,{name:'HMAC',hash:'SHA-256'},false,['sign']),d));

// A device: what an iPhone creates when it subscribes.
async function device(endpoint,owner){
  const kp=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const pub=new Uint8Array(await subtle.exportKey('raw',kp.publicKey)), auth=crypto.getRandomValues(new Uint8Array(16));
  return {row:{endpoint,owner_id:owner,p256dh:b64u(pub),auth:b64u(auth)},kp,pub,auth};
}
// RFC 8291, the receiving side.
async function decrypt(dev,body){
  const salt=body.slice(0,16), idlen=body[20], asPub=body.slice(21,21+idlen), ct=body.slice(21+idlen);
  const asKey=await subtle.importKey('raw',asPub,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await subtle.deriveBits({name:'ECDH',public:asKey},dev.kp.privateKey,256));
  const ikm=(await hmac(await hmac(dev.auth,shared),cat(te.encode('WebPush: info\0'),dev.pub,asPub,new Uint8Array([1])))).slice(0,32);
  const prk=await hmac(salt,ikm);
  const cek=(await hmac(prk,cat(te.encode('Content-Encoding: aes128gcm\0'),new Uint8Array([1])))).slice(0,16);
  const nonce=(await hmac(prk,cat(te.encode('Content-Encoding: nonce\0'),new Uint8Array([1])))).slice(0,12);
  const pt=new Uint8Array(await subtle.decrypt({name:'AES-GCM',iv:nonce},await subtle.importKey('raw',cek,{name:'AES-GCM'},false,['decrypt']),ct));
  if(pt[pt.length-1]!==2)throw new Error('no last-record delimiter');
  return JSON.parse(new TextDecoder().decode(pt.slice(0,-1)));
}
async function vapidKeys(){
  const kp=await subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const jwk=await subtle.exportKey('jwk',kp.privateKey);
  return {pub:b64u(new Uint8Array(await subtle.exportKey('raw',kp.publicKey))),priv:jwk.d,verifyKey:kp.publicKey};
}

// ── the fake world ───────────────────────────────────────────────────────────
const OWNER='owner-1', OTHER='owner-2';
// "Now" is 20 Oct 2026, 03:30 UTC = 9:00 AM IST. Tomorrow (IST) is 21 Oct.
const NOW=Date.parse('2026-10-20T03:30:00Z');
function world(over={}){
  const W={tables:{push_subscriptions:[],notification_prefs:[],sync_status:[],push_log:[],bookings:[],properties:[],staff:[]},
    pushes:[],gone:new Set(),users:{'tok-owner':OWNER}};
  Object.assign(W.tables,over);
  const res=(s,b)=>new Response(s===204||s===201&&b==null||b==null?null:JSON.stringify(b),{status:s});
  const match=(row,q)=>{for(const [k,v] of q){if(['select','on_conflict','order','limit'].includes(k))continue;
    const val=row[k]; if(v==='is.null'){if(val!=null)return false;}
    else if(v.startsWith('eq.')){if(String(val)!==decodeURIComponent(v.slice(3)))return false;}
    else if(v.startsWith('neq.')){if(String(val)===decodeURIComponent(v.slice(4)))return false;}}return true;};
  W.fetch=async(url,init={})=>{
    const u=new URL(url), m=(init.method||'GET').toUpperCase(), h=init.headers||{};
    if(u.host==='proj.supabase.co'){
      if(h.apikey!=='service-key')return res(401,{});
      if(u.pathname==='/auth/v1/user'){const id=W.users[(h.Authorization||'').replace('Bearer ','')];return id?res(200,{id}):res(401,{});}
      const t=u.pathname.replace('/rest/v1/',''), T=W.tables[t], q=[...u.searchParams];
      if(!T)return res(404,{});
      if(m==='GET')return res(200,T.filter(r=>match(r,q)));
      if(m==='DELETE'){W.tables[t]=T.filter(r=>!match(r,q));return res(204);}
      if(m==='POST'){const rows=JSON.parse(init.body),out=[];
        for(const r of rows){const dup=T.some(x=>x.owner_id===r.owner_id&&x.key===r.key);if(!dup){T.push({...r});out.push(r);}}
        return res(201,out);}
      return res(400,{});
    }
    // the push service
    const body=new Uint8Array(init.body);
    W.pushes.push({endpoint:url,headers:h,body});
    return new Response(null,{status:W.gone.has(url)?410:201});
  };
  return W;
}
const post=(body,headers={})=>new Request('https://proj.supabase.co/functions/v1/notify',
  {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});

(async()=>{
const F=await import(FN);
const V=await vapidKeys();
const ENV={SUPABASE_URL:'https://proj.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service-key',
  VAPID_PUBLIC_KEY:V.pub,VAPID_PRIVATE_KEY:V.priv,VAPID_SUBJECT:'mailto:owner@example.invalid',PUSH_CRON_SECRET:'cron-secret-123'};
const CRON={'x-cron-secret':'cron-secret-123'};
const iphone=await device('https://web.push.apple.com/QGVzAbc123',OWNER);
const ipad=await device('https://web.push.apple.com/QGVzDef456',OWNER);
const someoneElse=await device('https://web.push.apple.com/QGVzOther',OTHER);
const pushesFor=async(W,dev)=>Promise.all(W.pushes.filter(p=>p.endpoint===dev.row.endpoint).map(p=>decrypt(dev,p.body)));
const base=()=>({push_subscriptions:[{...iphone.row},{...someoneElse.row}],
  properties:[{id:'p1',owner_id:OWNER,name:'Raaya Vasyam',deleted_at:null}],
  staff:[{id:'stf1',owner_id:OWNER,name:'Laxmi Walikar'}],
  sync_status:[{owner_id:OWNER,last_sync_at:'2026-10-19T20:00:00Z'}]});
const B=o=>Object.assign({id:'b',owner_id:OWNER,guest_name:'Anita Rao',guests:2,property_id:'p1',check_in:'2026-10-18',
  check_out:'2026-10-21',source:'Direct',total_amount:6000,paid:2000,status:'checkedin',deleted_at:null},o);

console.log('\n— who may run it —');
{ const W=world(base());
  ok('no credentials: 401', (await F.handle(post({job:'daily'}),ENV,W.fetch,NOW)).status===401);
  ok('a wrong cron secret: 401', (await F.handle(post({job:'daily'},{'x-cron-secret':'cron-secret-XXX'}),ENV,W.fetch,NOW)).status===401);
  ok('a secret header with no secret configured opens nothing',
     (await F.handle(post({job:'daily'},CRON),{...ENV,PUSH_CRON_SECRET:''},W.fetch,NOW)).status===401);
  ok('a forged user token: 401', (await F.handle(post({job:'test'},{authorization:'Bearer forged'}),ENV,W.fetch,NOW)).status===401);
  ok('a signed-in owner cannot run the daily job', (await F.handle(post({job:'daily'},{authorization:'Bearer tok-owner'}),ENV,W.fetch,NOW)).status===400);
  ok('nothing was pushed by any of that', W.pushes.length===0);
  const pre=await F.handle(new Request('https://x/f',{method:'OPTIONS'}),ENV,W.fetch,NOW);
  ok('CORS preflight answers, for the app\'s Send test', pre.status===204&&/authorization/.test(pre.headers.get('access-control-allow-headers'))); }

console.log('\n— Send test, and what reaches Apple —');
{ const W=world({...base(),push_subscriptions:[{...iphone.row},{...ipad.row},{...someoneElse.row}]});
  const r=await (await F.handle(post({job:'test'},{authorization:'Bearer tok-owner'}),ENV,W.fetch,NOW)).json();
  ok('the test goes to each of the owner\'s devices', r.sent===2&&W.pushes.length===2, r);
  ok('and to nobody else\'s', !W.pushes.some(p=>p.endpoint===someoneElse.row.endpoint));
  const [m]=await pushesFor(W,iphone);
  ok('the payload decrypts with the device\'s own keys (RFC 8291)', m&&m.title==='StayLog test'&&/on for this iPhone/.test(m.body), m);
  ok('it carries a visible title and body, and where to go on tap', !!(m.title&&m.body&&m.url&&m.tag), m);
  const h=W.pushes[0].headers;
  ok('sent as aes128gcm with a TTL', h['Content-Encoding']==='aes128gcm'&&h.TTL==='86400');
  const [,jwt,k]=/^vapid t=([^,]+), k=(.+)$/.exec(h.Authorization)||[];
  ok('VAPID header names the public key', k===V.pub, h.Authorization);
  const [hd,cl,sig]=(jwt||'..').split('.');
  const claims=JSON.parse(Buffer.from(cl,'base64url').toString());
  ok('its claims: Apple\'s origin, a short expiry, the contact', claims.aud==='https://web.push.apple.com'
     &&claims.exp>NOW/1000&&claims.exp<=NOW/1000+24*3600&&claims.sub==='mailto:owner@example.invalid', claims);
  ok('and its ES256 signature verifies with the public key (RFC 8292)',
     await subtle.verify({name:'ECDSA',hash:'SHA-256'},V.verifyKey,unb64u(sig),te.encode(`${hd}.${cl}`)));
  ok('the private key is not in anything sent', !W.pushes.some(p=>JSON.stringify(p.headers).includes(V.priv)||Buffer.from(p.body).toString('latin1').includes(V.priv))); }

console.log('\n— 9 AM: guests arriving tomorrow —');
{ const W=world({...base(),bookings:[B({id:'arr',check_in:'2026-10-21',check_out:'2026-10-24',status:'confirmed'}),
    B({id:'today',check_in:'2026-10-20',check_out:'2026-10-23',status:'confirmed'}),
    B({id:'later',check_in:'2026-10-22',check_out:'2026-10-24',status:'confirmed'}),
    B({id:'can',check_in:'2026-10-21',check_out:'2026-10-23',status:'cancelled'}),
    B({id:'del',check_in:'2026-10-21',check_out:'2026-10-23',status:'confirmed',deleted_at:'2026-10-19T00:00:00Z'})]});
  await F.handle(post({job:'daily'},CRON),ENV,W.fetch,NOW);
  const ms=(await pushesFor(W,iphone)).filter(m=>/arriving tomorrow/i.test(m.title));
  ok('one for the guest arriving tomorrow', ms.length===1&&ms[0].title==='Guest arriving tomorrow', ms);
  ok('"2 guests · 3 nights · Raaya Vasyam", and no guest name', ms[0]&&ms[0].body.startsWith('2 guests · 3 nights · Raaya Vasyam')&&!/Anita/.test(JSON.stringify(ms)), ms[0]);
  ok('opening that booking, ready to send the arrival message', ms[0]&&ms[0].url==='./#open=arr&send=arrival', ms[0]);
  ok('none for today, the day after, cancelled or deleted stays', ms.length===1); }

console.log('\n— 9 AM: a balance due at check-out tomorrow —');
{ const W=world({...base(),bookings:[
    B({id:'direct',check_out:'2026-10-21'}),                                   // Direct, ₹4,000 owed, leaves tomorrow
    B({id:'bdc',check_out:'2026-10-21',source:'Booking.com',guest_name:'Rahul Menon'}),
    B({id:'air',check_out:'2026-10-21',source:'Airbnb'}),
    B({id:'mmt',check_out:'2026-10-21',source:'MakeMyTrip'}),
    B({id:'blank',check_out:'2026-10-21',source:'  '}),                       // no source recorded = Direct, as in the app
    B({id:'zero',check_out:'2026-10-21',paid:6000}),
    B({id:'over',check_out:'2026-10-21',paid:7000}),
    B({id:'leavingToday',check_out:'2026-10-20'}),
    B({id:'canc',check_out:'2026-10-21',status:'cancelled'})]});
  await F.handle(post({job:'daily'},CRON),ENV,W.fetch,NOW);
  const ms=(await pushesFor(W,iphone)).filter(m=>/^Balance due/.test(m.title));
  const urls=ms.map(m=>m.url).sort();
  ok('it fires for a Direct booking leaving tomorrow with a balance', urls.includes('./#open=direct&send=payment'), urls);
  ok('and for a Booking.com one', urls.includes('./#open=bdc&send=payment'), urls);
  ok('stating the exact amount, without the guest\'s name', ms.some(m=>m.body.startsWith('₹4,000 to collect · Raaya Vasyam'))&&!ms.some(m=>/Anita|Rahul/.test(m.body)), ms.map(m=>m.body));
  ok('never for Airbnb or other platforms', !urls.some(u=>/air|mmt/.test(u)), urls);
  ok('never for a zero or overpaid balance', !urls.some(u=>/zero|over/.test(u)), urls);
  ok('never on the day of check-out itself', !urls.some(u=>/leavingToday/.test(u)), urls);
  ok('never for a cancelled booking', !urls.some(u=>/canc/.test(u)), urls);
  ok('a booking with no source counts as Direct, as in the app', urls.includes('./#open=blank&send=payment'), urls);
  ok('so exactly three', ms.length===3, urls); }

{ // paise left over are not a debt: under ₹1 counts as paid, as in the app
  const W=world({...base(),bookings:[B({id:'half',check_out:'2026-10-21',total_amount:4999.5,paid:4999}),
    B({id:'p99',check_out:'2026-10-21',total_amount:1000,paid:999.01}),
    B({id:'overp',check_out:'2026-10-21',total_amount:1000,paid:1000.4}),
    B({id:'one',check_out:'2026-10-21',total_amount:1000,paid:999}),
    B({id:'real',check_out:'2026-10-21',total_amount:1000,paid:749.5})]});
  await F.handle(post({job:'daily'},CRON),ENV,W.fetch,NOW);
  const ms=(await pushesFor(W,iphone)).filter(m=>/^Balance/.test(m.title));
  const urls=ms.map(m=>m.url);
  ok('no alert for ₹4,999.50 with ₹4,999 paid, ₹0.99, or paise overpaid', !urls.some(u=>/half|p99|overp/.test(u)), urls);
  ok('₹1.00 and ₹250.50 still alert', urls.includes('./#open=one&send=payment')&&urls.includes('./#open=real&send=payment'), urls);
  ok('stating ₹250.50 with its paise', ms.some(m=>/^₹250\.50 to collect/.test(m.body)), ms.map(m=>m.body)); }

console.log('\n— from the minimal cloud: no names, no amounts, only balance_due —');
{ const M=o=>Object.assign({id:'m',owner_id:OWNER,guests:2,property_id:'p1',check_in:'2026-10-18',check_out:'2026-10-21',
    status:'checkedin',deleted_at:null,balance_due:null},o);
  const W=world({...base(),bookings:[M({id:'owes',balance_due:4000}),M({id:'paise',balance_due:250.5}),M({id:'settled',balance_due:0}),
    M({id:'air',balance_due:null}),M({id:'today',check_out:'2026-10-20',balance_due:900}),M({id:'can',status:'cancelled',balance_due:500}),
    M({id:'arr',check_in:'2026-10-21',check_out:'2026-10-24',guests:3})]});
  await F.handle(post({job:'daily'},CRON),ENV,W.fetch,NOW);
  const ms=await pushesFor(W,iphone), bal=ms.filter(m=>/^Balance/.test(m.title)).map(m=>m.url).sort();
  ok('the balance alert fires from balance_due alone', JSON.stringify(bal)===JSON.stringify(['./#open=owes&send=payment','./#open=paise&send=payment']), bal);
  ok('a zero or empty balance_due (paid, or a platform) never alerts', !bal.some(u=>/settled|air/.test(u)));
  ok('not on check-out day, not when cancelled', !bal.some(u=>/today|can/.test(u)));
  const a=ms.find(m=>/arriving/i.test(m.title));
  ok('the arrival reads "Guest arriving tomorrow · 3 guests · 3 nights · Raaya Vasyam"', a&&a.title==='Guest arriving tomorrow'
     &&a.body.startsWith('3 guests · 3 nights · Raaya Vasyam')&&a.url==='./#open=arr&send=arrival', a); }

{ // the evening before is still "tomorrow" in IST: 20 Oct 19:00 UTC is 21 Oct 00:30 IST
  const W=world({...base(),bookings:[B({id:'d21',check_out:'2026-10-21'}),B({id:'d22',check_out:'2026-10-22'})]});
  await F.handle(post({job:'daily'},CRON),ENV,W.fetch,Date.parse('2026-10-20T19:00:00Z'));
  const urls=(await pushesFor(W,iphone)).filter(m=>/^Balance/.test(m.title)).map(m=>m.url);
  ok('"tomorrow" is counted in IST, not UTC', urls.length===1&&urls[0]==='./#open=d22&send=payment', urls); }

console.log('\n— 9 AM: the app has not synced —');
for(const [label,last,want] of [['3 days ago','2026-10-17T03:00:00Z',1],['1 day ago','2026-10-19T03:00:00Z',0],['never recorded',null,0]]){
  const W=world({...base(),sync_status:last?[{owner_id:OWNER,last_sync_at:last}]:[]});
  await F.handle(post({job:'daily'},CRON),ENV,W.fetch,NOW);
  const ms=(await pushesFor(W,iphone)).filter(m=>/not synced/.test(m.title));
  ok(`last sync ${label}: ${want?'a warning':'no warning'}`, ms.length===want, ms);
  if(want) ok('and it opens the cloud panel', ms[0].url==='./#open=cloud'&&/3 days ago/.test(ms[0].body), ms[0]);
}

console.log('\n— once, and only when wanted —');
{ const W=world({...base(),bookings:[B({id:'arr',check_in:'2026-10-21',check_out:'2026-10-24',status:'confirmed'})]});
  await F.handle(post({job:'daily'},CRON),ENV,W.fetch,NOW);
  await F.handle(post({job:'daily'},CRON),ENV,W.fetch,NOW);
  ok('a cron that fires twice notifies once', (await pushesFor(W,iphone)).length===1); }
{ const W=world({...base(),bookings:[B({id:'arr',check_in:'2026-10-21',status:'confirmed'}),B({id:'bal',check_out:'2026-10-21'})],
    notification_prefs:[{owner_id:OWNER,prefs:{arrivals:false}}]});
  const r=await (await F.handle(post({job:'daily'},CRON),ENV,W.fetch,NOW)).json();
  const ms=await pushesFor(W,iphone);
  ok('an alert turned off is not sent', !ms.some(m=>/arriving/i.test(m.title))&&r.report.some(x=>x.skipped==='turned off'), r.report);
  ok('the others still are', ms.some(m=>/^Balance/.test(m.title))); }
{ const W=world({...base(),bookings:[B({id:'arr',check_in:'2026-10-21',status:'confirmed'})]});
  W.gone.add(iphone.row.endpoint);
  await F.handle(post({job:'daily'},CRON),ENV,W.fetch,NOW);
  ok('a device Apple says is gone (410) is removed', !W.tables.push_subscriptions.some(s=>s.endpoint===iphone.row.endpoint));
  ok('and the reminder is not marked sent, since no device took it', !W.tables.push_log.some(l=>l.key==='arrival:arr:2026-10-21'));
  ok('another owner\'s device is untouched', W.tables.push_subscriptions.some(s=>s.endpoint===someoneElse.row.endpoint)); }

console.log('\n— Laxmi\'s marks —');
const att=(type,rec,old)=>post({type,table:'attendance',schema:'public',record:rec,old_record:old||null},CRON);
const mark={id:'att_stf1_20261020',owner_id:OWNER,staff_id:'stf1',date:'2026-10-20',marked_at:'2026-10-20T03:42:00Z',expense_id:null,deleted_at:null};
{ const W=world(base());
  await F.handle(att('INSERT',mark),ENV,W.fetch,NOW);
  let ms=await pushesFor(W,iphone);
  ok('she marks attendance: a push', ms.length===1&&ms[0].title==='Laxmi came in today'&&/Marked present at 9:12\s?am, 20 Oct/i.test(ms[0].body), ms);
  ok('opening the cloud panel', ms[0]&&ms[0].url==='./#open=cloud');
  await F.handle(att('UPDATE',{...mark,expense_id:'wag_stf1_20261020'},mark),ENV,W.fetch,NOW);
  ok('the app stamping it is not news', (await pushesFor(W,iphone)).length===1);
  await F.handle(att('UPDATE',{...mark,deleted_at:'2026-10-20T03:45:00Z'},mark),ENV,W.fetch,NOW);
  ok('nor is her undo', (await pushesFor(W,iphone)).length===1);
  await F.handle(att('UPDATE',mark,{...mark,deleted_at:'2026-10-20T03:45:00Z'}),ENV,W.fetch,NOW);
  ok('marking again after an undo does not notify a second time', (await pushesFor(W,iphone)).length===1);
  await F.handle(post({type:'INSERT',table:'utensil_marks',record:{...mark,id:'ute_stf1_20261020'}},CRON),ENV,W.fetch,NOW);
  ms=await pushesFor(W,iphone);
  ok('she reports utensil cleaning: a push', ms.length===2&&ms[1].title==='Laxmi cleaned the utensils'&&/to be paid by you/.test(ms[1].body), ms[1]);
  await F.handle(post({type:'INSERT',table:'bookings',record:{id:'x',owner_id:OWNER}},CRON),ENV,W.fetch,NOW);
  ok('another table\'s webhook sends nothing', (await pushesFor(W,iphone)).length===2); }
{ const W=world({...base(),notification_prefs:[{owner_id:OWNER,prefs:{attendance:false}}]});
  await F.handle(att('INSERT',mark),ENV,W.fetch,NOW);
  ok('with attendance alerts off, her mark sends nothing', W.pushes.length===0);
  await F.handle(post({type:'INSERT',table:'utensil_marks',record:{...mark,id:'ute_x'}},CRON),ENV,W.fetch,NOW);
  ok('while utensil alerts still do', W.pushes.length===1); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
