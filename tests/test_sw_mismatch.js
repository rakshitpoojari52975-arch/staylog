/* app.js knows the sw.js CACHE_NAME it was released with. When the running
   worker reports a different one — or is too old to answer — a quiet banner
   says the app is part-updated and to reopen it. A matching worker, or none at
   all, shows nothing. Real worker, real registration, swapped sw.js source. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png'};
const REAL=fs.readFileSync(ROOT+'/sw.js','utf8');
const OLD=fs.readFileSync(__dirname+'/fixtures/sw-before-fix.js','utf8');   // has no version reply
const CACHE=REAL.match(/CACHE_NAME = '([^']+)'/)[1];
const [,APP_V]=fs.readFileSync(ROOT+'/app.js','utf8').match(/APP_VERSION='([^']+)'/);
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};

let SW_SRC=REAL;
const srv=http.createServer((q,r)=>{
  const p=decodeURIComponent(q.url.split('?')[0]);
  if(p==='/sw.js'){r.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});return r.end(SW_SRC);}
  const f=path.join(ROOT,p==='/'?'index.html':p.replace(/^\/+/,''));
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);return r.end();}
  r.writeHead(200,{'Content-Type':T[path.extname(f)]||'text/plain'});r.end(fs.readFileSync(f));
});
const SEED={properties:[{id:'p1',name:'Raaya Vasyam'}],staff:[],loans:[],bookings:[],expenses:[],attendance:[]};

(async()=>{
await new Promise(res=>srv.listen(0,'127.0.0.1',res));
const APP='http://127.0.0.1:'+srv.address().port;
const br=await chromium.launch();

// Installs `src` as the worker, then reopens the app under it, signed in.
const openUnder = async (src,{workers='allow'}={}) => {
  SW_SRC=src;
  const ctx=await br.newContext({serviceWorkers:workers,viewport:{width:390,height:844}});
  for(const g of ['**fonts.googleapis.com**','**fonts.gstatic.com**','**cdn.jsdelivr.net**','**://*.supabase.co/**'])
    await ctx.route(g,r=>r.abort());
  const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));},SEED);
  await page.goto(APP+'/index.html');
  if(workers==='allow'){
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller,null,{timeout:10000}).catch(()=>{});
    await page.reload();
  }
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(()=>{state.loggedIn=true;render();});
  return {ctx,page,errs};
};
const banner = page => page.locator('[data-sw-banner]');
const settle = page => page.waitForTimeout(5200);    // the boot check waits 4s for a normal takeover

console.log('\n— the release knows its own worker —');
ok('app.js expects the CACHE_NAME sw.js ships with', 'staylog-'+APP_V===CACHE, {app:'staylog-'+APP_V,sw:CACHE});

console.log('\n— matching worker: nothing to say —');
{ const {ctx,page,errs}=await openUnder(REAL);
  ok('the page is under the worker', await page.evaluate(()=>!!navigator.serviceWorker.controller));
  await settle(page);
  ok('no banner', await banner(page).count()===0);
  ok('and nothing recorded', await page.evaluate(()=>state.swMismatch)===null);
  await page.evaluate(()=>{state.swMismatch='staylog-v29';render();});
  ok('(a banner left from earlier…)', await banner(page).count()===1);
  await page.evaluate(()=>checkSwMatch()); await page.waitForTimeout(200);
  ok('…is cleared by the next check, without a reload', await banner(page).count()===0);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— a worker from another release —');
{ const {ctx,page,errs}=await openUnder(REAL.replace(`CACHE_NAME = '${CACHE}'`,`CACHE_NAME = 'staylog-v29'`));
  ok('the running worker really is the other one',
     await page.evaluate(()=>swVersion())==='staylog-v29');
  await settle(page);
  ok('the banner appears on its own after opening', await banner(page).count()===1);
  const t=(await banner(page).count())?await banner(page).innerText():'';
  ok('it says the app is part-updated and to reopen it', /part-updated/.test(t)&&/reopen/i.test(t), t);
  ok('and names both halves', t.includes(APP_V)&&t.includes('staylog-v29'), t);
  ok('it is a quiet strip, not a dialog', await page.locator('[data-sw-banner][role=status]').count()===1
     && await page.evaluate(()=>state.modal)===null);
  await page.evaluate(()=>{state.tab='expenses';render();});
  ok('it stays put across screens', await banner(page).count()===1);
  await banner(page).locator('button').click();
  ok('× puts it away', await banner(page).count()===0);
  await page.evaluate(()=>checkSwMatch()); await page.waitForTimeout(200);
  ok('and it stays away for this visit', await banner(page).count()===0);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— a worker too old to answer —');
{ const {ctx,page}=await openUnder(OLD);
  await page.evaluate(()=>checkSwMatch()); await page.waitForTimeout(300);
  const t=await banner(page).count()?await banner(page).innerText():'';
  ok('silence counts as a mismatch', /part-updated/.test(t), t);
  ok('and reads as an older offline cache', /an older offline cache/.test(t), t);
  await ctx.close(); }

console.log('\n— the worker catches up —');
{ const {ctx,page}=await openUnder(REAL.replace(`CACHE_NAME = '${CACHE}'`,`CACHE_NAME = 'staylog-v29'`));
  await page.evaluate(()=>checkSwMatch()); await page.waitForTimeout(200);
  ok('banner while they disagree', await banner(page).count()===1);
  SW_SRC=REAL;                                  // the right sw.js lands
  await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});
  await page.waitForFunction(c=>swVersion().then(v=>v===c),CACHE,{timeout:10000}).catch(()=>{});
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(()=>{state.loggedIn=true;render();});
  await page.evaluate(()=>checkSwMatch()); await page.waitForTimeout(200);
  ok('once the right worker runs, the banner is gone', await banner(page).count()===0);
  await ctx.close(); }

console.log('\n— no worker at all —');
{ const {ctx,page,errs}=await openUnder(REAL,{workers:'block'});
  await settle(page);
  ok('nothing to compare, nothing shown', await banner(page).count()===0);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— the PIN screen is left alone —');
{ const {ctx,page}=await openUnder(REAL.replace(`CACHE_NAME = '${CACHE}'`,`CACHE_NAME = 'staylog-v29'`));
  await page.evaluate(()=>{state.loggedIn=false;state.swMismatch=null;render();
    window.__pinScreen=document.getElementById('app').firstElementChild;});
  await page.evaluate(()=>checkSwMatch()); await page.waitForTimeout(300);
  ok('the check does not repaint the PIN screen',
     await page.evaluate(()=>document.getElementById('app').firstElementChild===window.__pinScreen));
  await page.evaluate(()=>{state.loggedIn=true;render();});
  ok('the banner is waiting once he is in', await banner(page).count()===1);
  await ctx.close(); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
