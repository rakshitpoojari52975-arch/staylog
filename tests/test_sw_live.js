/* The real app, the real service worker, the real Supabase client — talking to
   a fake PostgREST on a SEPARATE origin, the way the phone talks to Supabase.
   The question: when a new mark appears in the database, does the next sync
   see it? */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=require('path').resolve(__dirname,'..'), TMP=require('path').join(__dirname,'fixtures');
const SW_VARIANT = process.argv[2] || 'current';           // 'shipped' | 'current'
const SW_SRC = SW_VARIANT==='shipped' ? fs.readFileSync(TMP+'/sw-before-fix.js','utf8')
                                      : fs.readFileSync(ROOT+'/sw.js','utf8');
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
console.log(`\n[service worker: ${SW_VARIANT}]`);

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

// Day one: one mark in the database.
DB.attendance=[mark('03')];
await page.reload();
await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
const sync=()=>page.evaluate(async()=>{await window.StayLogCloud.restoreSession();
  await window.StayLogCloud.push(state.data); return true;});
await sync(); await page.waitForTimeout(600);
let days=await page.evaluate(()=>state.data.expenses.filter(e=>e.fromAttendance).map(e=>e.date).sort());
ok('the first mark becomes an expense', days.length===1, days);

// Day two: she marks again. A NEW row in the database.
DB.attendance.push(mark('04'));
const before=attendanceGETs;
await sync(); await page.waitForTimeout(600);
days=await page.evaluate(()=>state.data.expenses.filter(e=>e.fromAttendance).map(e=>e.date).sort());
ok('the sync actually asked the database', attendanceGETs>before, {before,after:attendanceGETs});
ok('the new mark is seen and recorded', days.includes('2026-10-04'), days);

// Day three, and a fourth — it must keep working, not just once after a deploy.
DB.attendance.push(mark('05'),mark('06'));
await sync(); await page.waitForTimeout(600);
days=await page.evaluate(()=>state.data.expenses.filter(e=>e.fromAttendance).map(e=>e.date).sort());
ok('and keeps seeing new marks, sync after sync', days.length===4, days);
const st=await page.evaluate(()=>window.StayLogCloud.status().attLog);
ok('the panel count matches the database', st.cloudMarks===DB.attendance.length,
   {panel:st.cloudMarks, database:DB.attendance.length});
ok('no page errors', errs.length===0, errs);

await br.close(); api.close(); app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
