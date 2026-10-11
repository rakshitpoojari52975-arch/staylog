/* The real app, the real service worker, the real Supabase client — talking to
   a fake PostgREST on a SEPARATE origin, the way the phone talks to Supabase.
   The question: when a new mark appears in the database, does the next sync
   see it? */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=require('path').resolve(__dirname,'..'), TMP=require('path').join(__dirname,'fixtures');
const SHIPPED=fs.readFileSync(TMP+'/sw-before-fix.js','utf8'), FIXED=fs.readFileSync(ROOT+'/sw.js','utf8');
let SW_SRC=SHIPPED;                                  // the phone starts on the broken one
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png'};

// ── fake PostgREST, its own origin ──────────────────────────────────────────
const DB={attendance:[]}; let attendanceGETs=0;
const OWNER='11111111-1111-1111-1111-111111111111';
function filt(rows,sp){
  for(const [k,v] of sp){
    if(['select','order','limit','offset','on_conflict','columns'].includes(k))continue;
    if(v==='is.null')rows=rows.filter(r=>r[k]==null);
    else if(v.startsWith('eq.')){const x=v.slice(3);rows=rows.filter(r=>String(r[k])===x);}
  }
  return rows;
}
const api=http.createServer((q,r)=>{
  const H={'Access-Control-Allow-Origin':q.headers.origin||'*','Access-Control-Allow-Credentials':'true',
    'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':q.headers['access-control-request-headers']||'*',
    'Access-Control-Expose-Headers':'content-range','Content-Type':'application/json'};
  if(q.method==='OPTIONS'){r.writeHead(204,H);return r.end();}
  const u=new URL(q.url,'http://x'); const table=u.pathname.replace('/rest/v1/','');
  let body='';q.on('data',d=>body+=d);q.on('end',()=>{
    if(table==='attendance'&&q.method==='GET'){
      attendanceGETs++;
      let rows=filt(DB.attendance.slice(),u.searchParams);
      const sel=(u.searchParams.get('select')||'*').split(',');
      if(sel[0]!=='*')rows=rows.map(x=>Object.fromEntries(sel.map(c=>[c,x[c]])));
      r.writeHead(200,H);return r.end(JSON.stringify(rows));
    }
    if(table==='attendance'&&q.method==='PATCH'){
      const patch=JSON.parse(body||'{}'); const hit=filt(DB.attendance,u.searchParams);
      hit.forEach(x=>Object.assign(x,patch));
      r.writeHead(200,H);return r.end(JSON.stringify(hit.map(x=>({id:x.id}))));
    }
    if(q.method==='POST'){r.writeHead(201,H);return r.end('[]');}
    if(q.method==='PATCH'){r.writeHead(204,H);return r.end();}
    r.writeHead(200,H);r.end('[]');
  });
});

// ── the app, on its own origin ──────────────────────────────────────────────
let API_ORIGIN='';
const app=http.createServer((q,r)=>{
  const p=decodeURIComponent(q.url.split('?')[0]);
  if(p==='/sw.js'){r.writeHead(200,{'Content-Type':'text/javascript'});return r.end(SW_SRC);}
  if(p==='/cloud-config.js'){r.writeHead(200,{'Content-Type':'text/javascript'});
    return r.end(`window.STAYLOG_CLOUD={url:'${API_ORIGIN}',publishableKey:'pk_test',staffEmailDomain:'staff.test'};`);}
  const f=path.join(ROOT,p==='/'?'index.html':p.replace(/^\/+/,''));
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);return r.end();}
  r.writeHead(200,{'Content-Type':T[path.extname(f)]||'text/plain'});r.end(fs.readFileSync(f));
});

const mark=d=>({id:'att_stf1_202610'+d,owner_id:OWNER,staff_id:'stf1',date:'2026-10-'+d,expense_id:null,deleted_at:null});

(async()=>{
await new Promise(res=>api.listen(0,'127.0.0.1',res));
await new Promise(res=>app.listen(0,'127.0.0.1',res));
// localhost vs 127.0.0.1: genuinely different origins, as the phone and Supabase are
API_ORIGIN='http://localhost:'+api.address().port;
const APP='http://127.0.0.1:'+app.address().port;
console.log('\n[upgrade: broken worker on the phone, then the fix is uploaded]');

const br=await chromium.launch();
const ctx=await br.newContext({serviceWorkers:'allow'});
await ctx.route('**fonts.googleapis.com**',r=>r.abort());
await ctx.route('**fonts.gstatic.com**',r=>r.abort());
await ctx.route('**cdn.jsdelivr.net**',r=>r.abort());
const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));

// first visit installs the worker
await page.goto(APP+'/index.html');
await page.evaluate(()=>navigator.serviceWorker.ready);
await page.waitForFunction(()=>!!navigator.serviceWorker.controller,null,{timeout:10000}).catch(()=>{});
// a signed-in owner and her staff record, as on the phone
await page.evaluate(({OWNER})=>{
  localStorage.setItem('sb-localhost-auth-token',JSON.stringify({
    access_token:'test-token',token_type:'bearer',expires_in:3600,
    expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:'r',
    user:{id:OWNER,email:'me@example.com',aud:'authenticated',role:'authenticated'}}));
  localStorage.setItem('staylog_v2',JSON.stringify({properties:[{id:'p1',name:'RV'}],
    staff:[{id:'stf1',name:'Lakshmi Walikar',dailyWage:300,active:true}],
    expenses:[],loans:[],bookings:[],attendance:[]}));
  localStorage.removeItem('staylog_att_log');localStorage.removeItem('staylog_att_last');
},{OWNER});

const controlled=await page.evaluate(()=>!!navigator.serviceWorker.controller);
ok('the page is under the service worker, as on the phone', controlled);

// On the broken worker: sync once, so a stale answer gets stored, then add a mark.
DB.attendance=[mark('03')];
await page.reload();
await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
const sync=()=>page.evaluate(async()=>{await window.StayLogCloud.restoreSession();
  await window.StayLogCloud.push(state.data); return true;});
await sync(); await page.waitForTimeout(600);
DB.attendance.push(mark('04'));
await sync(); await page.waitForTimeout(600);
let days=await page.evaluate(()=>state.data.expenses.filter(e=>e.fromAttendance).map(e=>e.date).sort());
ok('before the upgrade, the broken worker hides the new mark (the bug, reproduced)',
   !days.includes('2026-10-04'), days);

// Rakshit uploads the fixed sw.js. The phone opens the app as normal.
SW_SRC=FIXED;
await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration(); await r.update();});
await page.waitForTimeout(1500);
await page.reload();                       // index.html also reloads once on controllerchange
await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
await page.waitForTimeout(800);
const caches_=await page.evaluate(()=>caches.keys());
ok('the old cache, with its stale answers, is gone', !caches_.some(k=>k!=='staylog-v33'), caches_);
ok('the fixed worker is the one in charge', caches_.includes('staylog-v33'), caches_);

await sync(); await page.waitForTimeout(800);
days=await page.evaluate(()=>state.data.expenses.filter(e=>e.fromAttendance).map(e=>e.date).sort());
ok('the mark the broken worker hid now comes through', days.includes('2026-10-04'), days);

DB.attendance.push(mark('05'));
await sync(); await page.waitForTimeout(600);
days=await page.evaluate(()=>state.data.expenses.filter(e=>e.fromAttendance).map(e=>e.date).sort());
ok('and the next new mark does too, without another upload', days.includes('2026-10-05'), days);
const st=await page.evaluate(()=>window.StayLogCloud.status().attLog);
ok('the panel count now matches the database', st.cloudMarks===DB.attendance.length,
   {panel:st.cloudMarks,database:DB.attendance.length});
// the footer must name the worker that is actually running
await page.evaluate(()=>{state.loggedIn=true;state.modal='menu';render();});
await page.waitForTimeout(1800);
const foot=await page.locator('body').innerText();
ok('the menu footer names the running worker', /Offline cache staylog-v33/.test(foot), foot.slice(-160));
ok('and the app version and build date', /StayLog v31 · built 10 Oct 2026/.test(foot), foot.slice(-160));
ok('no page errors', errs.length===0, errs);

await br.close(); api.close(); app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
