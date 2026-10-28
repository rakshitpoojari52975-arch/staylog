/* The notification inbox: every reminder kept in push_log (supabase/inbox.sql)
   and shown on the phone behind a bell on Home. The bell's count, the groups
   (Today / Yesterday / Earlier), a tap opening the push's own link and marking
   it read, Mark all read (count and app badge to zero), the Done state of each
   alert type worked out from the phone's data, the Still to do filter, an
   undelivered row, a phone notification tap marking its row read, offline
   "As of", and the service worker setting the app icon's badge. Supabase is
   stubbed: push_log answers as PostgREST would; every other table refuses, so
   no sync runs underneath the test. */
process.env.TZ='Asia/Kolkata';                 // the page runs in IST too: the same "today"
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

const STUB = `
window.__server={rows:window.__seedRows||[],reads:[],offline:!!window.__offline};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  functions:{async invoke(){return {data:{ok:true},error:null};}},
  from(table){const S=window.__server;let op='select',arg=null;const f=[];const api={
    select(){return api;}, eq(k,v){f.push(r=>String(r[k])===String(v));return api;},
    is(k,v){f.push(r=>v===null?r[k]==null:r[k]===v);return api;},
    not(k,o,v){f.push(r=>!(o==='is'&&v===null?r[k]==null:r[k]===v));return api;},
    gte(k,v){f.push(r=>String(r[k])>=String(v));return api;},
    in(k,vs){f.push(r=>vs.includes(r[k]));return api;},
    order(){return api;}, limit(){return api;},
    update(p){op='update';arg=p;return api;}, upsert(){op='upsert';return api;}, delete(){op='delete';return api;}, insert(){op='insert';return api;},
    then(res){
      if(S.offline)return Promise.resolve(res({data:null,error:{message:'Failed to fetch'}}));
      if(table!=='push_log')return Promise.resolve(res({data:null,error:{code:'XX000',message:'not in this test'}}));
      const hit=S.rows.filter(r=>f.every(g=>g(r)));
      if(op==='update'){Object.keys(arg).forEach(k=>{if(k!=='read_at')throw new Error('only read_at may change');});
        hit.forEach(r=>Object.assign(r,arg));S.reads.push(hit.map(r=>r.key));return Promise.resolve(res({data:null,error:null}));}
      return Promise.resolve(res({data:JSON.parse(JSON.stringify(hit.sort((a,b)=>b.sent_at.localeCompare(a.sent_at)))),error:null}));}};
    return api;},
})};`;

const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const at=(days,h=12)=>{const d=new Date();d.setDate(d.getDate()+days);d.setHours(h,0,0,0);return d.toISOString();};
const nowMinus=min=>new Date(Date.now()-min*60e3).toISOString();
const BK=(id,o)=>Object.assign({id,propertyId:'p1',guestName:'Guest '+id,phone:'9876543210',checkIn:D(-1),checkOut:D(2),guests:2,
  totalAmount:5000,paid:1000,source:'Direct',status:'checkedin',notes:'',msgSent:{}},o);
const SEED={properties:[{id:'p1',name:'Raaya Vasyam'}],staff:[{id:'stf1',name:'Laxmi Walikar',dailyWage:500}],loans:[],attendance:[],
  bookings:[
    BK('arrDue',{checkIn:D(1),checkOut:D(3),status:'confirmed'}),                        // arrival message still to send
    BK('arrSent',{checkIn:D(1),checkOut:D(3),status:'confirmed',msgSent:{arrival:D(0)}}), // sent: Done
    BK('balDue',{checkOut:D(1)}),                                                         // ₹4,000 owed
    BK('balPaid',{checkOut:D(1),paid:5000}),                                              // settled: Done
    BK('stayHere',{checkIn:D(5),checkOut:D(7),status:'confirmed',source:'Airbnb'}),
  ],
  expenses:[{id:'wag_stf1_'+D(0).replace(/-/g,''),staffId:'stf1',description:'Wage',date:D(0),amount:500,paid:false,category:'Staff'}]};
const ymd=s=>s.replace(/-/g,'');
const R=(key,alert,title,sent_at,o)=>Object.assign({owner_id:'owner-1',key,alert,title,body:title+' body',url:'./#open=cloud',
  sent_at,delivered:true,read_at:null},o);
const ROWS=[
  R('arrival:arrDue:'+D(1),'arrivals','Guest arriving tomorrow',nowMinus(2),{url:'./#open=arrDue&send=arrival'}),
  R('arrival:arrSent:'+D(1),'arrivals','Guest arriving tomorrow',nowMinus(3),{url:'./#open=arrSent&send=arrival'}),
  R('balance:balDue:'+D(1),'balances','Balance due at check-out tomorrow',nowMinus(4),{url:'./#open=balDue&send=payment'}),
  R('balance:balPaid:'+D(1),'balances','Balance due at check-out tomorrow',nowMinus(5),{url:'./#open=balPaid&send=payment'}),
  R('mark:att_stf1_'+ymd(D(0)),'attendance','Laxmi came in today',nowMinus(6)),                 // its wage exists: Recorded
  R('mark:ute_stf1_'+ymd(D(0)),'utensils','Laxmi cleaned the utensils',nowMinus(7)),            // no expense yet
  R('stale:'+D(-1),'stale','StayLog has not synced',at(-1,9)),                                  // yesterday
  R('backup:'+D(-1),'backup','No encrypted backup in 3 days',at(-1,10),{delivered:false}),      // yesterday, not delivered
  R(`stay:p1:${D(5)}:${D(7)}`,'newBookings','New Airbnb booking',at(-4,9),{read_at:at(-4,10)}),// earlier, read, imported
  R('mark:att_stf1_old','attendance','Laxmi came in today',at(-40,9)),                         // past the 30 days
];

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(o={})=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844},timezoneId:'Asia/Kolkata'});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',d=>d.accept());
  await page.addInitScript(([s,rows,o])=>{
    if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');
      localStorage.setItem('staylog_v2',JSON.stringify(s));
      localStorage.setItem('staylog_last_sync',o.lastSync||new Date(Date.now()-3*86400e3).toISOString());
      if(o.cache)localStorage.setItem('staylog_inbox',JSON.stringify(o.cache));}
    window.__seedRows=rows; window.__offline=!!o.offline; window.open=()=>null;
    window.__badge=[]; navigator.setAppBadge=async n=>{window.__badge.push(n);}; navigator.clearAppBadge=async()=>{window.__badge.push(0);};
  },[SEED,o.rows||JSON.parse(JSON.stringify(ROWS)),o]);
  await page.goto(base+'/index.html'+(o.hash||''));
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(()=>{state.loggedIn=true;state.tab='dashboard';render();});
  await page.waitForTimeout(400);
  return {ctx,page,errs};
};
const badge=page=>page.evaluate(()=>window.__badge[window.__badge.length-1]);
const bell=page=>page.locator('[data-bell]').getAttribute('data-bell');
const rowState=(page,key)=>page.locator(`[data-inbox-row="${key}"] [data-inbox-state]`).getAttribute('data-inbox-state');

console.log('\n— a sent alert appears in the inbox —');
{ const {ctx,page,errs}=await open();
  ok('the bell on Home shows the unread count (30 days, read ones left out)', await bell(page)==='8', await bell(page));
  ok('and the app icon badge says the same', await badge(page)===8, await page.evaluate(()=>window.__badge));
  await page.click('[data-bell]'); await page.waitForTimeout(250);
  const keys=await page.locator('[data-inbox-row]').evaluateAll(els=>els.map(e=>e.dataset.inboxRow));
  ok('the Notifications screen lists the last 30 days, newest first', keys.length===9&&keys[0]==='arrival:arrDue:'+D(1)
     &&keys[keys.length-1]===`stay:p1:${D(5)}:${D(7)}`&&!keys.includes('mark:att_stf1_old'), keys);
  const groups=await page.locator('[data-inbox-group]').evaluateAll(els=>els.map(e=>e.dataset.inboxGroup));
  ok('grouped Today, Yesterday, Earlier', JSON.stringify(groups)==='["Today","Yesterday","Earlier"]', groups);
  const first=await page.locator(`[data-inbox-row="arrival:arrDue:${D(1)}"]`).innerText();
  ok('each row shows the time, title and body', /Guest arriving tomorrow/.test(first)&&/body/.test(first)&&/\d{1,2}:\d{2}/.test(first), first);
  const earlier=await page.locator(`[data-inbox-row="stay:p1:${D(5)}:${D(7)}"]`).innerText();
  ok('an earlier one also shows its date', /\d{1,2} \w{3}/.test(earlier), earlier);

  console.log('\n— each alert type turns Done under its own condition —');
  ok('arrival, message still due: still to do', await rowState(page,'arrival:arrDue:'+D(1))==='todo');
  ok('arrival, message sent: Done', await rowState(page,'arrival:arrSent:'+D(1))==='Done');
  ok('balance owed: still to do', await rowState(page,'balance:balDue:'+D(1))==='todo');
  ok('balance 0: Done', await rowState(page,'balance:balPaid:'+D(1))==='Done');
  ok('attendance with its wage expense: Recorded', await rowState(page,'mark:att_stf1_'+ymd(D(0)))==='Recorded');
  ok('utensils without the expense: still to do', await rowState(page,'mark:ute_stf1_'+ymd(D(0)))==='todo');
  ok('stale with no newer sync: still to do', await rowState(page,'stale:'+D(-1))==='todo');
  ok('backup with no newer backup: still to do', await rowState(page,'backup:'+D(-1))==='todo');
  ok('a new stay now on the phone: Imported', await rowState(page,`stay:p1:${D(5)}:${D(7)}`)==='Imported');
  // the conditions change on the phone: the states follow, nothing stored
  await page.evaluate(d=>{
    const b=state.data.bookings.find(x=>x.id==='arrDue'); b.msgSent={arrival:d};
    state.data.bookings.find(x=>x.id==='balDue').paid=5000;
    state.data.expenses.push({id:'ute_stf1_'+d.replace(/-/g,''),staffId:'stf1',description:'Utensil cleaning',date:d,amount:100,paid:false,category:'Staff'});
    localStorage.setItem('staylog_last_sync',new Date().toISOString());
    const st=window.StayLogBackup.status; window.StayLogBackup.status=()=>({...st(),lastAt:new Date().toISOString()});
    render();},D(0));
  ok('arrival message sent: Done', await rowState(page,'arrival:arrDue:'+D(1))==='Done');
  ok('balance paid: Done', await rowState(page,'balance:balDue:'+D(1))==='Done');
  ok('utensil expense made: Recorded', await rowState(page,'mark:ute_stf1_'+ymd(D(0)))==='Recorded');
  ok('a newer sync: Cleared', await rowState(page,'stale:'+D(-1))==='Cleared');
  ok('a newer backup: Cleared', await rowState(page,'backup:'+D(-1))==='Cleared');
  ok('Done is never stored, in the cloud or on the phone', !(await page.evaluate(()=>JSON.stringify(window.__server.rows)+localStorage.getItem('staylog_inbox'))).match(/"done"|Recorded|Cleared/));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— the Still to do filter —');
{ const {ctx,page}=await open();
  await page.click('[data-bell]'); await page.waitForTimeout(250);
  await page.click('[data-inbox-filter="todo"]'); await page.waitForTimeout(100);
  const keys=await page.locator('[data-inbox-row]').evaluateAll(els=>els.map(e=>e.dataset.inboxRow));
  ok('shows only what is not done yet', JSON.stringify(keys.sort())===JSON.stringify(['arrival:arrDue:'+D(1),'backup:'+D(-1),'balance:balDue:'+D(1),
     'mark:ute_stf1_'+ymd(D(0)),'stale:'+D(-1)].sort()), keys);
  await page.evaluate(()=>{state.data.bookings.find(x=>x.id==='balDue').paid=5000;render();});
  ok('and drops a row once it is done', !(await page.locator('[data-inbox-row]').evaluateAll(els=>els.map(e=>e.dataset.inboxRow))).includes('balance:balDue:'+D(1)));
  await page.click('[data-inbox-filter="all"]'); await page.waitForTimeout(100);
  ok('All shows everything again', await page.locator('[data-inbox-row]').count()===9);
  await ctx.close(); }

console.log('\n— undelivered —');
{ const {ctx,page}=await open();
  await page.click('[data-bell]'); await page.waitForTimeout(250);
  const r=page.locator(`[data-inbox-row="backup:${D(-1)}"]`);
  ok('an undelivered row says so', /Not delivered — turn notifications on again\?/.test(await r.innerText()));
  ok('only that one', await page.locator('[data-inbox-undelivered]').count()===1);
  await r.locator('[data-inbox-undelivered]').click(); await page.waitForTimeout(250);
  ok('its link opens the notifications menu', await page.evaluate(()=>state.modal)==='menu'&&await page.locator('[data-push]').count()===1);
  await ctx.close(); }

console.log('\n— tapping a row —');
{ const {ctx,page,errs}=await open();
  await page.click('[data-bell]'); await page.waitForTimeout(250);
  await page.click(`[data-inbox-open="balance:balDue:${D(1)}"]`); await page.waitForTimeout(300);
  const st=await page.evaluate(()=>({tab:state.tab,modal:state.modal,exp:state.expandedBooking,focus:state.sendFocus}));
  ok('opens the same deep link as the push (the booking, payment request highlighted)', st.tab==='bookings'&&st.modal==='sendConfirm'
     &&st.exp==='balDue'&&st.focus&&st.focus.kind==='payment', st);
  const s=await page.evaluate(()=>window.__server);
  ok('and marks it read in the cloud: read_at only', s.rows.find(r=>r.key==='balance:balDue:'+D(1)).read_at&&s.reads.some(k=>k.length===1&&k[0]==='balance:balDue:'+D(1)), s.reads);
  ok('the count and badge drop by one', await page.evaluate(()=>inboxUnread())===7&&await badge(page)===7);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— Mark all read —');
{ const {ctx,page}=await open();
  await page.click('[data-bell]'); await page.waitForTimeout(250);
  await page.click('[data-inbox-all-read]'); await page.waitForTimeout(250);
  const s=await page.evaluate(()=>window.__server);
  ok('every row in the cloud is read', s.rows.filter(r=>Date.parse(r.sent_at)>Date.now()-30*86400e3).every(r=>r.read_at), s.rows.filter(r=>!r.read_at).map(r=>r.key));
  ok('the count is zero', await page.evaluate(()=>inboxUnread())===0);
  ok('and the app icon badge is cleared', await badge(page)===0, await page.evaluate(()=>window.__badge));
  await page.evaluate(()=>{state.modal=null;state.tab='dashboard';render();});
  ok('the bell shows no number', await bell(page)==='0'&&await page.locator('[data-bell-count]').count()===0);
  await ctx.close(); }

console.log('\n— tapping the phone\'s notification marks it read —');
{ const key='arrival:arrDue:'+D(1);
  const {ctx,page}=await open({hash:`#open=arrDue&send=arrival&n=${encodeURIComponent(key)}`});
  await page.waitForTimeout(400);
  const s=await page.evaluate(()=>window.__server);
  ok('the push\'s link opens the booking', await page.evaluate(()=>state.expandedBooking)==='arrDue');
  ok('and its row is read, in the cloud and on the bell', s.rows.find(r=>r.key===key).read_at&&await page.evaluate(()=>inboxUnread())===7, s.reads);
  await ctx.close(); }
{ const {ctx,page}=await open();
  const key='stale:'+D(-1);
  await page.evaluate(k=>{navigator.serviceWorker&&0;takeOpen('#open=cloud&n='+encodeURIComponent(k));},key);
  await page.waitForTimeout(300);
  ok('a tap while the app is open does the same', (await page.evaluate(()=>window.__server)).rows.find(r=>r.key===key).read_at&&await page.evaluate(()=>state.modal)==='cloud');
  await ctx.close(); }

console.log('\n— offline —');
{ const cache={at:'2026-10-27T05:30:00.000Z',pending:[],rows:[R('stale:x','stale','StayLog has not synced',nowMinus(30))]};
  const {ctx,page,errs}=await open({offline:true,cache});
  ok('the bell counts the last list loaded', await bell(page)==='1');
  await page.click('[data-bell]'); await page.waitForTimeout(300);
  ok('the screen shows it', await page.locator('[data-inbox-row="stale:x"]').count()===1);
  const asof=await page.locator('[data-inbox-asof]').innerText().catch(()=>'');
  ok('labelled "As of <time>"', /^As of 27 Oct 2026, 11:00\s?am/i.test(asof), asof);
  await page.click('[data-inbox-open="stale:x"]'); await page.waitForTimeout(200);
  ok('a read made offline is kept to send later', JSON.parse(await page.evaluate(()=>localStorage.getItem('staylog_inbox'))).pending.includes('stale:x'));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— the service worker sets the app icon badge, and touches no cache —');
{ const shown=[], badges=[]; let cacheUsed=0;
  const sb={self:{location:{origin:'https://rakshitpoojari52975-arch.github.io'},
    navigator:{setAppBadge:async n=>{badges.push(n);},clearAppBadge:async()=>{badges.push(0);}},
    registration:{scope:'https://rakshitpoojari52975-arch.github.io/staylog/',showNotification:(t,o)=>{shown.push({t,o});return Promise.resolve();}},
    clients:{claim(){},matchAll:async()=>[],openWindow:async()=>{}},
    skipWaiting(){}, listeners:{}, addEventListener(t,f){this.listeners[t]=f;}},
    caches:new Proxy({},{get(){cacheUsed++;return ()=>Promise.resolve();}}), fetch(){}, Response:{error(){}}, URL, module:{exports:{}}, console};
  vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(ROOT,'sw.js'),'utf8'),sb);
  const L=sb.self.listeners, run=async(e)=>{let w;e.waitUntil=p=>{w=p;};L.push(e);await w;};
  cacheUsed=0;
  await run({data:{json:()=>({title:'Guest arriving tomorrow',body:'b',url:'./#open=x&send=arrival&n=arrival%3Ax',badge:3})}});
  ok('a push with the unread count sets the badge', badges[0]===3&&shown.length===1, badges);
  ok('and carries the key in its link, for the tap', /&n=arrival%3Ax$/.test(shown[0].o.data.url), shown[0].o.data.url);
  await run({data:{json:()=>({title:'t',body:'b',url:'./',badge:0})}});
  ok('a count of 0 clears it', badges[1]===0, badges);
  await run({data:{json:()=>({title:'StayLog test',body:'b',url:'./'})}});
  ok('a push without one leaves it alone', badges.length===2&&shown.length===3);
  sb.self.navigator={};
  await run({data:{json:()=>({title:'t',body:'b',url:'./',badge:2})}});
  ok('no badge support: the notification still shows', shown.length===4);
  ok('the push handler never touches the cache', cacheUsed===0, cacheUsed); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
