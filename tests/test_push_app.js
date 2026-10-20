/* Push notifications on the phone: the menu's button, status line, test and
   toggles; the quiet re-subscribe on every open; the deep links a tapped
   notification opens; and the service worker's push and click handlers.
   The browser's push machinery (PushManager, Notification) is stubbed, the
   way an iPhone Home Screen app would present it, and so is Supabase. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

const IPHONE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// A made-up public key of the right shape (65 bytes, uncompressed point). Public keys are public.
const KEY=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,7)]).toString('base64url');

const STUB = `
window.__server={subs:{},prefs:null,invoked:[],upserts:{},missing:false};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:window.__noSession?null:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  functions:{async invoke(name,o){window.__server.invoked.push({name,body:o&&o.body});
    return {data:{ok:true,sent:Object.keys(window.__server.subs).length,gone:0},error:null};}},
  from(table){const S=window.__server;let op='select',arg=null,filt={};const api={
    select(){return api;}, eq(k,v){filt[k]=v;return api;}, is(){return api;}, not(){return api;},
    order(){return api;}, limit(){return api;}, update(){op='update';return api;},
    delete(){op='delete';return api;},
    upsert(rows){op='upsert';arg=Array.isArray(rows)?rows:[rows];return api;},
    then(res,rej){
      const missing=S.missing&&['push_subscriptions','notification_prefs'].includes(table);
      if(missing)return Promise.resolve(res({data:null,error:{code:'PGRST205',message:"Could not find the table 'public."+table+"' in the schema cache"}}));
      if(op==='upsert'){(S.upserts[table]=S.upserts[table]||[]).push(...arg);
        if(table==='push_subscriptions')arg.forEach(r=>S.subs[r.endpoint]=r);
        if(table==='notification_prefs')S.prefs=arg[0].prefs;}
      if(op==='delete'&&table==='push_subscriptions')delete S.subs[filt.endpoint];
      const data=op==='select'&&table==='notification_prefs'?(S.prefs?[{prefs:S.prefs}]:[]):[];
      return Promise.resolve(res({data,error:null}));}};return api;},
})};`;

// The browser side of push, as an iPhone Home Screen app has it.
function fakePush(o){
  window.__push={requested:0,subscribed:[],unsubscribed:0,sub:null};
  const P=window.__push;
  const makeSub=(key)=>({endpoint:'https://web.push.apple.com/QGVzTEST'+(P.subscribed.length),
    options:{applicationServerKey:key.buffer},
    toJSON(){return{endpoint:this.endpoint,keys:{p256dh:'BPUBLICKEYOFTHEDEVICE',auth:'AUTHSECRET'}};},
    async unsubscribe(){P.unsubscribed++;P.sub=null;return true;}});
  if(o.existingSub)P.sub=makeSub(new Uint8Array(o.existingSub));
  const reg={pushManager:{
    async getSubscription(){return P.sub;},
    async subscribe(opts){if(window.Notification.permission!=='granted')throw new Error('NotAllowedError');
      P.subscribed.push({userVisibleOnly:opts.userVisibleOnly,key:Array.from(opts.applicationServerKey)});
      P.sub=makeSub(opts.applicationServerKey);return P.sub;}},
    showNotification(){} };
  const listeners=[];
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{ready:Promise.resolve(reg),controller:null,
    register:async()=>reg,addEventListener:(t,f)=>listeners.push([t,f]),
    __emit:(t,data)=>listeners.filter(l=>l[0]===t).forEach(l=>l[1]({data}))}});
  window.PushManager=function(){};
  window.Notification={permission:o.permission||'default',
    requestPermission:async()=>{P.requested++;window.Notification.permission=o.grant||'granted';return window.Notification.permission;}};
  Object.defineProperty(navigator,'standalone',{configurable:true,get:()=>o.standalone!==false});
  if(o.noSession)window.__noSession=true;
}

const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const SEED={properties:[{id:'p1',name:'Raaya Vasyam',upiId:'staylog.test@fakebank'}],staff:[],loans:[],expenses:[],attendance:[],
  bookings:[{id:'bk1',propertyId:'p1',guestName:'Anita Rao',phone:'9876543210',checkIn:D(-2),checkOut:D(1),guests:2,
    totalAmount:6000,paid:2000,source:'Direct',status:'checkedin',notes:'',msgSent:{}},
   {id:'bk2',propertyId:'p1',guestName:'Rahul Menon',phone:'9876500000',checkIn:D(1),checkOut:D(3),guests:2,
    totalAmount:5000,paid:5000,source:'Booking.com',status:'confirmed',notes:'',msgSent:{}}]};

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(o={},hash='')=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844},userAgent:IPHONE});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const cfg=fs.readFileSync(path.join(ROOT,'cloud-config.js'),'utf8')
    .replace(/vapidPublicKey:\s*'[^']*'/,`vapidPublicKey: '${o.noKey?'':KEY}'`);
  await ctx.route('**/cloud-config.js',r=>r.fulfill({contentType:'text/javascript',body:cfg}));
  const page=await ctx.newPage(); const errs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',d=>d.accept());
  await page.addInitScript(([s,o,fp])=>{localStorage.setItem('staylog_v2',JSON.stringify(s));
    window.open=()=>null; eval('('+fp+')')(o);},[SEED,o,fakePush.toString()]);
  await page.goto(base+'/index.html'+hash);
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.waitForTimeout(250);                       // the quiet re-subscribe on open
  return {ctx,page,errs};
};
const login=page=>page.evaluate(()=>{state.loggedIn=true;render();});
const menu=async page=>{await page.evaluate(()=>{state.loggedIn=true;state.modal='menu';render();});
  await page.waitForTimeout(250); return page.locator('[data-push]').innerText();};
const P=page=>page.evaluate(()=>window.__push), S=page=>page.evaluate(()=>window.__server);

console.log('\n— opened in a Safari tab —');
{ const {ctx,page,errs}=await open({standalone:false});
  const t=await menu(page);
  ok('the status line says why not', /Not available in a Safari tab/.test(t), t);
  ok('and how to add it to the Home Screen', /Share/.test(t)&&/Add to Home Screen/.test(t)&&/from that new icon/.test(t), t);
  ok('no Turn on button there', await page.locator('[data-push-on]').count()===0);
  ok('nothing was asked or subscribed', (await P(page)).requested===0&&(await P(page)).subscribed.length===0);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— turning it on from the Home Screen app —');
{ const {ctx,page,errs}=await open({});
  ok('opening the app never prompts', (await P(page)).requested===0&&(await P(page)).subscribed.length===0);
  let t=await menu(page);
  ok('status: off for this iPhone', /Off for this iPhone/.test(t), t);
  await page.click('[data-push-on]'); await page.waitForTimeout(300);
  const p=await P(page), s=await S(page);
  ok('the tap asks for permission, once', p.requested===1, p.requested);
  ok('subscribes with visible notifications only, under the public key', p.subscribed.length===1&&p.subscribed[0].userVisibleOnly===true
     &&Buffer.from(p.subscribed[0].key).toString('base64url')===KEY, p.subscribed);
  const row=Object.values(s.subs)[0];
  ok('the subscription is stored in the cloud, owner and keys included', row&&row.owner_id==='owner-1'&&row.p256dh&&row.auth&&row.device==='iPhone', row);
  t=await page.locator('[data-push]').innerText();
  ok('status: on for this iPhone', /On for this iPhone/.test(t), t);
  ok('every alert has a toggle, all on by default', await page.locator('[data-push-pref]').count()===5
     &&(await page.locator('[data-push-pref][aria-checked="true"]').count())===5);
  await page.click('[data-push-pref="arrivals"]'); await page.waitForTimeout(150);
  ok('turning one off saves just that one off', JSON.stringify((await S(page)).prefs)===
     JSON.stringify({attendance:true,utensils:true,arrivals:false,balances:true,stale:true}), (await S(page)).prefs);
  ok('and the toggle shows it', await page.locator('[data-push-pref="arrivals"]').getAttribute('aria-checked')==='false');
  await page.click('[data-push-test]'); await page.waitForTimeout(150);
  const inv=(await S(page)).invoked;
  ok('Send test asks the notify function for a test', inv.length===1&&inv[0].name==='notify'&&inv[0].body.job==='test', inv);
  ok('and says it went', /Sent to 1 device/.test(await page.locator('[data-push-msg]').innerText()));
  await page.click('[data-push-off]'); await page.waitForTimeout(200);
  ok('Turn off unsubscribes the browser', (await P(page)).unsubscribed===1);
  ok('and removes this device from the cloud', Object.keys((await S(page)).subs).length===0, (await S(page)).subs);
  ok('status: off again', /Off for this iPhone/.test(await page.locator('[data-push]').innerText()));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— re-subscribing quietly on every open —');
{ const {ctx,page}=await open({permission:'granted'});   // iOS dropped the subscription
  const p=await P(page), s=await S(page);
  ok('a dropped subscription is made again without a prompt', p.requested===0&&p.subscribed.length===1, p);
  ok('and saved to the cloud', Object.keys(s.subs).length===1);
  ok('status: on', /On for this iPhone/.test(await menu(page)));
  await ctx.close(); }
{ const {ctx,page}=await open({permission:'granted',existingSub:Array.from(Buffer.from(KEY,'base64url'))});
  const p=await P(page), s=await S(page);
  ok('a live subscription is kept, not remade', p.subscribed.length===0&&p.unsubscribed===0, p);
  ok('but re-saved, so the cloud has it even if it lost it', (s.upserts.push_subscriptions||[]).length===1);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
    document.dispatchEvent(new Event('visibilitychange'));}); await page.waitForTimeout(200);
  ok('coming back to the app re-saves it too', ((await S(page)).upserts.push_subscriptions||[]).length===2);
  await ctx.close(); }
{ const {ctx,page}=await open({permission:'granted',existingSub:Array.from(Buffer.alloc(65,9))});
  const p=await P(page);
  ok('a subscription under an old key is replaced', p.unsubscribed===1&&p.subscribed.length===1, p);
  await ctx.close(); }

console.log('\n— when it cannot be on, the status line says why —');
for(const [label,o,re] of [
  ['blocked in Settings',{permission:'denied'},/Blocked for StayLog[\s\S]*Settings → Notifications → StayLog/],
  ['not signed in to the cloud',{noSession:true},/Sign in to Cloud sync first/],
  ['no public key configured',{noKey:true},/Not set up yet/],
]){ const {ctx,page}=await open(o); const t=await menu(page);
  ok(`${label}: “${(t.match(re)||[''])[0].split('\n')[0]}”`, re.test(t)&&await page.locator('[data-push-on]').count()===0, t);
  await ctx.close(); }
{ const {ctx,page,errs}=await open({});
  await page.evaluate(()=>{window.__server.missing=true;});
  await menu(page); await page.click('[data-push-on]'); await page.waitForTimeout(300);
  ok('push.sql not run yet: the menu names the script', /run supabase\/push\.sql/.test(await page.locator('[data-push-msg]').innerText()));
  ok('and the app carries on', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— a tapped notification opens the right place —');
{ const {ctx,page}=await open({},'#open=bk1&send=payment');
  ok('it waits behind the PIN', await page.evaluate(()=>state.modal)===null);
  await login(page); await page.waitForTimeout(250);
  const st=await page.evaluate(()=>({modal:state.modal,id:state.editItem&&state.editItem.id,tab:state.tab,hash:location.hash}));
  ok('the balance reminder opens that booking\'s Send sheet', st.modal==='sendConfirm'&&st.id==='bk1'&&st.tab==='bookings', st);
  ok('with the payment request the one to send', await page.locator('[data-send-focus="1"][data-pay-row]').count()===1);
  ok('and the address is cleaned, so a reload does not reopen it', st.hash==='', st.hash);
  await page.evaluate(()=>closeModal());
  await page.evaluate(()=>{state.modal='sendConfirm';state.editItem=state.data.bookings[0];render();});
  ok('opening the sheet by hand later highlights nothing extra', await page.locator('[data-send-focus]').count()===0);
  await ctx.close(); }
{ const {ctx,page}=await open({},'#open=bk2&send=arrival');
  await login(page); await page.waitForTimeout(250);
  ok('the arrivals reminder opens the arrival message', await page.locator('[data-send-focus="1"] [data-send="arrival"]').count()===1);
  await page.evaluate(()=>navigator.serviceWorker.__emit('message',{type:'open',url:location.origin+'/#open=cloud'}));
  await page.waitForTimeout(150);
  ok('a tap while the app is open is passed on by the worker', await page.evaluate(()=>state.modal)==='cloud');
  await ctx.close(); }
{ const {ctx,page,errs}=await open({},'#open=gone-booking&send=arrival');
  await login(page); await page.waitForTimeout(250);
  ok('a booking since deleted opens the bookings list, quietly', await page.evaluate(()=>state.tab==='bookings'&&state.modal===null)&&errs.length===0, errs);
  await ctx.close(); }

console.log('\n— the service worker shows every push and opens on tap —');
{ const shown=[], opened=[], posted=[]; let focused=0, clientsList=[];
  const sb={self:{location:{origin:'https://rakshitpoojari52975-arch.github.io'},
    registration:{scope:'https://rakshitpoojari52975-arch.github.io/staylog/',showNotification:(t,o)=>{shown.push({t,o});return Promise.resolve();}},
    clients:{claim(){},matchAll:async()=>clientsList,openWindow:async u=>{opened.push(u);}},
    skipWaiting(){}, listeners:{}, addEventListener(t,f){this.listeners[t]=f;}},
    caches:{}, fetch(){}, Response:{error(){}}, URL, module:{exports:{}}, console};
  vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(ROOT,'sw.js'),'utf8'),sb);
  const L=sb.self.listeners, run=async(t,e)=>{let w;e.waitUntil=p=>{w=p;};L[t](e);await w;};
  await run('push',{data:{json:()=>({title:'Arriving tomorrow: Anita Rao',body:'2 guests',url:'./#open=bk1&send=arrival',tag:'arrival:bk1'})}});
  ok('a push shows its notification', shown[0]&&shown[0].t==='Arriving tomorrow: Anita Rao'&&shown[0].o.body==='2 guests', shown[0]);
  ok('carrying where to go', shown[0].o.data.url==='https://rakshitpoojari52975-arch.github.io/staylog/#open=bk1&send=arrival', shown[0].o.data);
  await run('push',{data:{json:()=>{throw new Error('garbled');}}});
  await run('push',{data:null});
  ok('even an unreadable or empty push shows something (iOS revokes after silent ones)', shown.length===3&&shown[1].t==='StayLog'&&shown[2].o.body);
  await run('push',{data:{json:()=>({title:'x',body:'y',url:'https://evil.example/phish'})}});
  ok('a link to another site is not followed', shown[3].o.data.url==='https://rakshitpoojari52975-arch.github.io/staylog/', shown[3].o.data);
  const note=u=>({notification:{data:{url:u},close(){}}});
  await run('notificationclick',note(shown[0].o.data.url));
  ok('a tap with the app closed opens it at the booking', opened[0]===shown[0].o.data.url, opened);
  clientsList=[{url:'https://rakshitpoojari52975-arch.github.io/staylog/index.html',postMessage:m=>posted.push(m),focus:async()=>{focused++;}}];
  await run('notificationclick',note('https://rakshitpoojari52975-arch.github.io/staylog/#open=cloud'));
  ok('a tap with the app open brings it forward and tells it where', focused===1&&posted[0]&&posted[0].type==='open'&&/#open=cloud$/.test(posted[0].url)&&opened.length===1, posted);
  ok('the caching rules are untouched', typeof sb.module.exports.routeFor==='function'&&sb.module.exports.routeFor({method:'GET',url:'https://fnpuswexdaeqebrordvv.supabase.co/rest/v1/bookings',headers:{get:()=>null}})===null); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
