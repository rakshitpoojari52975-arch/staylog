/* Six marks in the cloud, four expenses here. The mark whose expense went
   missing must be rebuilt, not skipped for ever. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=require('path').resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

const STUB = `
window.__server={attendance:[],upserts:{}};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  from(table){const S=window.__server;const q={_f:[],_upd:null};const api={
    select(){q._sel=true;return api;}, eq(k,v){q._f.push([k,v]);return api;},
    is(k,v){q._f.push([k,v,'is']);return api;}, not(){return api;},
    order(){return api;}, limit(){return api;},
    async upsert(rows){(S.upserts[table]=S.upserts[table]||[]).push(...rows);return{error:null};},
    update(p){q._upd=p;return api;},
    then(res){
      if(table!=='attendance')return Promise.resolve(res({data:[],error:null}));
      if(q._upd){const id=(q._f.find(f=>f[0]==='id')||[])[1];
        const row=S.attendance.find(r=>r.id===id); if(row)Object.assign(row,q._upd);
        return Promise.resolve(res({data:row?[{id:row.id}]:[],error:null}));}
      const wantsUnstamped=q._f.some(f=>f[0]==='expense_id'&&f[2]==='is');
      let rows=S.attendance.filter(r=>r.deleted_at==null);
      if(wantsUnstamped)rows=rows.filter(r=>r.expense_id==null);
      return Promise.resolve(res({data:rows.map(r=>({id:r.id,staff_id:r.staff_id,
        date:r.date,expense_id:r.expense_id})),error:null}));
    }};return api;},
})};`;

const mark=(d,stamped)=>({id:'att_stf1_202610'+d, staff_id:'stf1', date:'2026-10-'+d,
  expense_id: stamped ? 'wag_stf1_202610'+d : null, deleted_at:null});
const expense=d=>({id:'wag_stf1_202610'+d, staffId:'stf1', category:'staff', propertyId:'p1',
  description:'Wage · '+d+' Oct', date:'2026-10-'+d, amount:300, grossAmount:300,
  loanId:'', loanDeduction:0, paid:false, fromAttendance:'att_stf1_202610'+d});

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open = async seed => {
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));
    localStorage.removeItem('staylog_att_log');localStorage.removeItem('staylog_att_last');},seed);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined' && !state._loading);
  return {ctx,page,errs};
};
const SEED = extra => Object.assign({
  properties:[{id:'p1',name:'Raaya Vasyam'}],
  staff:[{id:'stf1',name:'Lakshmi Walikar',dailyWage:300,active:true}],
  loans:[],bookings:[],expenses:[],attendance:[]}, extra);

console.log('\n— the exact reported situation —');
// Six marks in the cloud. Four expenses here. Two marks are in the local
// bookkeeping list but their expenses are gone — the hole.
{ const seed=SEED({
    expenses:['03','04','05','09'].map(expense),
    attendance:['03','04','05','06','07','09'].map(d=>({id:'att_stf1_202610'+d,
      staffId:'stf1',date:'2026-10-'+d,expenseId:'wag_stf1_202610'+d})),
  });
  const {ctx,page,errs}=await open(seed);
  await page.evaluate(ms=>{window.__server.attendance=ms;},
    [['03',true],['04',true],['05',true],['06',false],['07',false],['09',true]].map(([d,s])=>mark(d,s)));
  const before=await page.evaluate(()=>state.data.expenses.filter(e=>e.fromAttendance).length);
  ok('starts with four recorded against six marks', before===4, before);

  await page.evaluate(async()=>{ await window.StayLogCloud.restoreSession();
    await window.StayLogCloud.push(state.data); });
  await page.waitForTimeout(600);
  const r=await page.evaluate(()=>({
    born:state.data.expenses.filter(e=>e.fromAttendance).map(e=>e.date).sort(),
    status:window.StayLogCloud.status()}));
  ok('the two missing days are rebuilt', r.born.length===6, r.born);
  ok('and they are the right days',
     r.born.includes('2026-10-06') && r.born.includes('2026-10-07'), r.born);
  ok('nothing is duplicated', new Set(r.born).size===r.born.length, r.born);
  ok('the panel knows how many marks the cloud holds', r.status.attLog.cloudMarks===6, r.status.attLog);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— a day you deleted on purpose stays deleted —');
{ const seed=SEED({
    expenses:['03'].map(expense),
    attendance:[{id:'att_stf1_20261004',staffId:'stf1',date:'2026-10-04',expenseId:'wag_stf1_20261004'}],
  });
  const {ctx,page}=await open(seed);
  // 04 is ticked off in the cloud and its expense is gone from here: deleted.
  await page.evaluate(ms=>{window.__server.attendance=ms;},[mark('03',true),mark('04',true)]);
  await page.evaluate(async()=>{ await window.StayLogCloud.restoreSession();
    await window.StayLogCloud.push(state.data); });
  await page.waitForTimeout(600);
  const r=await page.evaluate(()=>({
    dates:state.data.expenses.filter(e=>e.fromAttendance).map(e=>e.date),
    status:window.StayLogCloud.status()}));
  ok('it is not resurrected', !r.dates.includes('2026-10-04'), r.dates);
  ok('but it is accounted for, not a silent gap', r.status.attLog.removed===1, r.status.attLog);
  await ctx.close(); }

console.log('\n— the counts show up in the panel —');
{ const seed=SEED({
    expenses:['03'].map(expense),
    attendance:[{id:'att_stf1_20261003',staffId:'stf1',date:'2026-10-03',expenseId:'wag_stf1_20261003'}],
  });
  const {ctx,page}=await open(seed);
  await page.evaluate(ms=>{window.__server.attendance=ms;},[mark('03',true),mark('08',false)]);
  await page.evaluate(async()=>{ await window.StayLogCloud.restoreSession();
    await window.StayLogCloud.push(state.data);
    state.loggedIn=true; state.modal='cloud'; render(); });
  await page.waitForTimeout(500);
  const t=await page.locator('body').innerText();
  ok('both numbers are on screen', /Marks in cloud/i.test(t) && /Recorded here/i.test(t), t.slice(0,200));
  ok('and they agree once the gap is filled',
     (await page.evaluate(()=>state.data.expenses.filter(e=>e.fromAttendance).length))===2);
  await ctx.close(); }

console.log('\n— the invariants that must never break —');
{ const {ctx,page}=await open(SEED({}));
  await page.evaluate(ms=>{window.__server.attendance=ms;},
    ['03','04','05','06','07'].map(d=>mark(d,false)));
  await page.evaluate(async()=>{ await window.StayLogCloud.restoreSession();
    await window.StayLogCloud.push(state.data); });
  await page.waitForTimeout(700);
  const r=await page.evaluate(()=>({
    born:state.data.expenses.filter(e=>e.fromAttendance),
    up:Object.keys(window.__server.upserts),
    server:window.__server.attendance}));
  ok('a week of marks all convert at once', r.born.length===5, r.born.length);
  ok('each at the daily wage, unpaid', r.born.every(e=>e.amount===300&&e.paid===false));
  ok('attendance is never pushed as app data', !r.up.includes('attendance'), r.up);
  ok('every mark is ticked off', r.server.every(m=>m.expense_id), r.server);

  // a second sync must change nothing
  await page.evaluate(async()=>{ await window.StayLogCloud.push(state.data); });
  await page.waitForTimeout(500);
  ok('syncing again creates no duplicates',
     (await page.evaluate(()=>state.data.expenses.filter(e=>e.fromAttendance).length))===5);
  await ctx.close(); }

{ const seed=SEED({}); seed.staff[0].dailyWage='';
  const {ctx,page}=await open(seed);
  await page.evaluate(ms=>{window.__server.attendance=ms;},[mark('03',false)]);
  await page.evaluate(async()=>{ await window.StayLogCloud.restoreSession();
    await window.StayLogCloud.push(state.data); });
  await page.waitForTimeout(600);
  const r=await page.evaluate(()=>({n:state.data.expenses.length,s:window.StayLogCloud.status()}));
  ok('no daily wage means no invented figure', r.n===0, r.n);
  ok('and the mark is reported as held', r.s.heldMarks===1, r.s.heldMarks);
  ok('and left untouched in the cloud',
     (await page.evaluate(()=>window.__server.attendance[0].expense_id))==null);
  await ctx.close(); }

{ const {ctx,page}=await open(SEED({}));
  await page.evaluate(()=>{window.__server.attendance=[{id:'att_stf1_20261003',staff_id:'stf1',
    date:'2026-10-03',expense_id:null,deleted_at:'2026-10-03T10:00:00Z'}];});
  await page.evaluate(async()=>{ await window.StayLogCloud.restoreSession();
    await window.StayLogCloud.push(state.data); });
  await page.waitForTimeout(600);
  ok('a withdrawn mark produces nothing',
     (await page.evaluate(()=>state.data.expenses.length))===0); 
  await ctx.close(); }

console.log('\n— the build stamp tells the truth —');
{ const src=fs.readFileSync(ROOT+'/app.js','utf8');
  const m=src.match(/APP_VERSION='(v\d+)', APP_BUILT='([^']+)'/);
  ok('version and date are both present', !!m, m);
  ok('and the date is no longer 28 Sept', m && m[2]!=='28 Sept 2026', m && m[2]); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
