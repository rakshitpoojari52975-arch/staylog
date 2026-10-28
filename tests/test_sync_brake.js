/* The sync safety brake. A push tombstones whatever the server has and the
   phone lacks — right for a deleted booking, a disaster for a phone whose data
   is wrong. More than 5 rows in one sync, or more than 20% of any table, must
   stop before anything is written and ask. Ordinary syncs must not notice. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

// A Supabase holding real rows per table. select/update honour eq, is and
// not-in the way PostgREST does, and every write is logged.
const STUB = `
window.__server={rows:{},writes:[]};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  from(table){const S=window.__server;const q={f:[],upd:null,notIn:null};
    const match=r=>q.f.every(([k,v])=>v===null?r[k]==null:r[k]===v)&&(!q.notIn||!q.notIn.includes(r.id));
    const api={
    select(){return api;}, eq(k,v){q.f.push([k,v]);return api;}, is(k,v){q.f.push([k,v]);return api;},
    not(k,op,list){q.notIn=String(list).replace(/^\\(|\\)$/g,'').split(',').map(x=>x.replace(/"/g,''));return api;},
    order(){return api;}, limit(){return api;},
    async upsert(rows){S.writes.push({table,op:'upsert',n:rows.length});
      const t=S.rows[table]=S.rows[table]||[];
      rows.forEach(r=>{const i=t.findIndex(x=>x.id===r.id);const row={...r,deleted_at:null};i<0?t.push(row):t[i]=row;});
      return{error:null};},
    update(p){q.upd=p;return api;},
    then(res){
      const t=S.rows[table]||[];
      if(table==='attendance')return Promise.resolve(res({data:[],error:null}));
      if(q.upd){const hit=t.filter(match);hit.forEach(r=>Object.assign(r,q.upd));
        if(hit.length)S.writes.push({table,op:'tombstone',n:hit.length,ids:hit.map(r=>r.id)});
        return Promise.resolve(res({data:null,error:null}));}
      return Promise.resolve(res({data:t.filter(match).map(r=>({id:r.id})),error:null}));
    }};return api;},
})};`;

const bk=i=>({id:'bk'+i,propertyId:'p1',guestName:'Guest '+i,checkIn:'2026-09-0'+(1+i%9),checkOut:'2026-09-1'+(i%9),
  amount:3000,status:'checkedout',platform:'direct'});
// Staff payouts: since the minimal cloud, the only expenses that have a cloud copy.
const ex=i=>({id:'ex'+i,propertyId:'p1',description:'Wage '+i,date:'2026-10-01',amount:100,category:'staff',
  paid:true,notes:'',staffId:'s1',loanId:'',loanDeduction:0});
const range=n=>Array.from({length:n},(_,i)=>i+1);
const SEED=(nb,ne)=>({properties:[{id:'p1',name:'Raaya Vasyam'}],staff:[{id:'s1',name:'Laxmi'}],loans:[],attendance:[],
  bookings:range(nb).map(bk),expenses:range(ne).map(ex)});

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
// Opens the app with `phone` on the device; the server is first filled from `cloud`.
const open = async (phone,cloud) => {
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const dialogs=[],alerts=[]; let answer=false;
  page.on('dialog',async dl=>{if(dl.type()!=='confirm')alerts.push(dl.message());else dialogs.push(dl.message()); answer?await dl.accept():await dl.dismiss();});
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));},phone);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined' && !state._loading);
  await page.evaluate(async()=>{ await window.StayLogCloud.restoreSession(); });
  // fill the cloud with `cloud`, unwatched: no dialogs, no brake involved
  await page.evaluate(async c=>{const S=window.__server;
    const up=(t,rows)=>{S.rows[t]=rows.map(r=>({id:r.id,owner_id:'owner-1',deleted_at:null}));};
    up('properties',c.properties);up('bookings',c.bookings);up('expenses',c.expenses);
    up('staff',c.staff);up('loans',c.loans);up('loan_repayments',[]);},cloud);
  return {ctx,page,errs,dialogs,alerts,answer:a=>{answer=a;}};
};
const push = (page,opts) => page.evaluate(async o=>{
  window.__server.writes=[];
  try{ await window.StayLogCloud.push(state.data,o); return {ok:true}; }
  catch(e){ return {ok:false,err:e.message}; }},opts||null);
const server = page => page.evaluate(()=>({
  writes:window.__server.writes,
  live:Object.fromEntries(Object.entries(window.__server.rows).map(([t,r])=>[t,r.filter(x=>!x.deleted_at).length])),
  status:window.StayLogCloud.status()}));
const tomb = w => w.filter(x=>x.op==='tombstone').reduce((t,x)=>t+x.n,0);

console.log('\n— ordinary syncs do not notice —');
{ const s=SEED(30,30); const {ctx,page,errs,dialogs}=await open({...s,expenses:[...s.expenses,ex(31)]},s);
  const r=await push(page), v=await server(page);
  ok('adding a row syncs without a word', r.ok&&dialogs.length===0, {r,dialogs});
  ok('it is uploaded', v.live.expenses===31, v.live);
  ok('and nothing is deleted', tomb(v.writes)===0, v.writes);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

{ const s=SEED(30,30); const {ctx,page,dialogs}=await open({...s,expenses:s.expenses.slice(1)},s);
  const r=await push(page), v=await server(page);
  ok('deleting one expense of 30 syncs without a word', r.ok&&dialogs.length===0, {r,dialogs});
  ok('and it is tombstoned', tomb(v.writes)===1&&v.live.expenses===29, v);
  await ctx.close(); }

{ const s=SEED(30,30); const {ctx,page,dialogs}=await open({...s,bookings:s.bookings.slice(3),expenses:s.expenses.slice(2)},s);
  const r=await push(page), v=await server(page);
  ok('five rows across two tables is still ordinary', r.ok&&dialogs.length===0, {r,dialogs});
  ok('all five are tombstoned', tomb(v.writes)===5, v.writes);
  await ctx.close(); }

{ const s=SEED(5,30); const {ctx,page,dialogs}=await open({...s,bookings:s.bookings.slice(1)},s);
  const r=await push(page);
  ok('exactly 20% of a table (1 of 5) is still ordinary', r.ok&&dialogs.length===0, {r,dialogs});
  await ctx.close(); }

console.log('\n— more than 5 rows —');
{ const s=SEED(30,30); const {ctx,page,errs,dialogs}=await open({...s,bookings:s.bookings.slice(3),expenses:s.expenses.slice(3)},s);
  const r=await push(page,{manual:true}), v=await server(page);
  ok('six rows stop the sync and ask', !r.ok&&dialogs.length===1, {r,dialogs});
  ok('the question names each table and how many',
     /3 of 30 bookings/.test(dialogs[0])&&/3 of 30 expenses/.test(dialogs[0]), dialogs[0]);
  ok('cancelled, nothing at all is written', v.writes.length===0, v.writes);
  ok('the cloud still has every row', v.live.bookings===30&&v.live.expenses===30, v.live);
  ok('the panel says the sync is paused, and why',
     /Sync paused — it would delete 3 expenses, 3 bookings/.test(v.status.lastError), v.status.lastError);
  ok('status carries the plan', JSON.stringify(v.status.brake)===JSON.stringify(
     [{table:'expenses',count:3,of:30},{table:'bookings',count:3,of:30}]), v.status.brake);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

{ const s=SEED(30,30); const {ctx,page,dialogs,answer}=await open({...s,expenses:s.expenses.slice(6)},s);
  answer(true);
  const r=await push(page,{manual:true}), v=await server(page);
  ok('confirmed, the sync goes ahead', r.ok&&dialogs.length===1, {r,dialogs});
  ok('and the six are tombstoned', tomb(v.writes)===6&&v.live.expenses===24, {w:v.writes,live:v.live});
  ok('the pause is cleared', !v.status.lastError&&v.status.brake===null, v.status);
  await ctx.close(); }

console.log('\n— more than 20% of a table —');
{ const s=SEED(4,30); const {ctx,page,dialogs}=await open({...s,bookings:s.bookings.slice(1)},s);
  const r=await push(page), v=await server(page);
  ok('one booking of four (25%) asks', !r.ok&&dialogs.length===1, {r,dialogs});
  ok('and says so', /1 of 4 bookings \(25%\)/.test(dialogs[0]||''), dialogs[0]);
  ok('nothing is written', v.writes.length===0, v.writes);
  ok('one row reads as one', /would delete 1 booking\./.test(v.status.lastError), v.status.lastError);
  await ctx.close(); }

console.log('\n— a new phone, empty, signed in —');
{ const s=SEED(30,30);
  const {ctx,page,dialogs}=await open({properties:[],bookings:[],expenses:[],staff:[],loans:[],attendance:[]},s);
  const r=await push(page), v=await server(page);
  ok('it takes nothing out of the cloud', v.live.bookings===30&&v.live.expenses===30&&v.live.properties===1, v.live);
  ok('without even asking: an empty phone never tombstones', dialogs.length===0&&tomb(v.writes)===0, {dialogs,w:v.writes});
  await ctx.close(); }

console.log('\n— asked once, not on every background sync —');
{ const s=SEED(30,30); const {ctx,page,dialogs}=await open({...s,expenses:s.expenses.slice(10)},s);
  await push(page); await push(page); await push(page);
  ok('three background syncs ask once', dialogs.length===1, dialogs.length);
  let v=await server(page);
  ok('and none of them deletes anything', v.writes.length===0&&v.live.expenses===30, v);
  await page.evaluate(()=>{state.data.expenses=state.data.expenses.slice(1);});   // the plan changes
  await push(page);
  ok('a different set of deletions asks again', dialogs.length===2, dialogs.length);
  await push(page,{manual:true});
  ok('Sync now always asks', dialogs.length===3, dialogs.length);
  await ctx.close(); }

console.log('\n— the buttons in the cloud panel ask —');
{ const s=SEED(30,30); const {ctx,page,dialogs,alerts}=await open({...s,expenses:s.expenses.slice(10)},s);
  await push(page);                                   // background: asked and refused
  await page.evaluate(()=>{state.loggedIn=true;state.modal='cloud';render();});
  await page.waitForTimeout(300);
  ok('the panel shows the pause', /Sync paused/.test(await page.locator('body').innerText()));
  await page.locator('button',{hasText:'Sync now'}).click(); await page.waitForTimeout(500);
  ok('Sync now puts the question again', dialogs.length===2, dialogs.length);
  ok('and Cancel is not followed by a "Sync failed" alert', alerts.length===0, alerts);
  ok('the panel still shows the pause', /Sync paused/.test(await page.locator('body').innerText()));
  await page.evaluate(()=>{state.modal='cloud';render();}); await page.waitForTimeout(200);
  await page.locator('button:not([data-ical-check])',{hasText:'Check now'}).click(); await page.waitForTimeout(500);
  ok('so does Check now', dialogs.length===3, dialogs.length);
  await ctx.close(); }

console.log('\n— the release is stamped —');
{ const app=fs.readFileSync(ROOT+'/app.js','utf8'), sw=fs.readFileSync(ROOT+'/sw.js','utf8');
  const v=app.match(/APP_VERSION='v(\d+)'/)[1], c=sw.match(/CACHE_NAME = 'staylog-v(\d+)'/)[1];
  ok('app version and service worker cache move together', v===c, {app:v,sw:c}); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
