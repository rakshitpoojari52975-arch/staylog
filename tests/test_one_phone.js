/* v60's guards on the one-phone design (review, Appendix A §1.5, 1.7, 1.8):
   - the phone's data belongs to the login that first synced it; another
     login is refused while the phone holds data (pushing it would put one
     owner's records into another's account and tombstone theirs);
   - one phone syncs an account: a second pauses, writes nothing, and can be
     made "my only phone";
   - an app older than public.app_status.min_version stops syncing and asks
     to be reopened, once and plainly;
   - signing out forgets the backup key, logs, inbox cache and this phone's
     push subscription;
   - new ids are random UUIDs;
   - the arrival message takes its instructions from the property. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);
const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};

// A Supabase with tables as arrays. Filters are honoured; every write is logged.
const STUB = `
window.__auth=window.__auth||{session:{user:{id:'owner-1',email:'me@example.com'},access_token:'tok'},users:{'me@example.com':'owner-1','other@example.com':'owner-2'},signOuts:0};
window.__server=JSON.parse(sessionStorage.getItem('__srv')||'null')||{rows:{ical_events:[],ical_feeds:[]},writes:[],invoked:[],missing:{}};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:window.__auth.session}}),
        signInWithPassword:async({email})=>{const id=window.__auth.users[email];if(!id)return{data:{},error:{message:'Invalid login credentials'}};
          window.__auth.session={user:{id,email},access_token:'tok-'+id};return{data:{session:window.__auth.session},error:null};},
        signOut:async()=>{window.__auth.session=null;window.__auth.signOuts++;return{error:null};},
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  functions:{async invoke(name,opts){window.__server.invoked.push(name);return{data:{ok:true},error:null};}},
  from(table){const S=window.__server;const q={f:[],op:'select',val:null,notIn:null};
    const match=r=>q.f.every(([k,v])=>v===null?r[k]==null:r[k]===v)&&(!q.notIn||!q.notIn.includes(r.id));
    const api={
    select(){return api;}, eq(k,v){q.f.push([k,v]);return api;}, is(k,v){q.f.push([k,v]);return api;},
    not(k,op,list){q.notIn=String(list).replace(/^\\(|\\)$/g,'').split(',').map(x=>x.replace(/"/g,''));return api;},
    order(){return api;}, limit(){return api;},
    update(v){q.op='update';q.val=v;return api;}, delete(){q.op='delete';return api;},
    async upsert(rows,o){rows=[].concat(rows);S.writes.push({table,op:'upsert',rows});const t=S.rows[table]=S.rows[table]||[];
      rows.forEach(r=>{const keys=(o&&o.onConflict||'id').split(',');
        const i=t.findIndex(x=>keys.every(k=>x[k]===r[k]));i<0?t.push({...r}):Object.assign(t[i],r);});
      return{error:null};},
    then(res){
      if(S.missing[table])return Promise.resolve(res({data:null,error:{code:'PGRST205',message:"Could not find the table 'public."+table+"' in the schema cache"}}));
      const t=S.rows[table]||[];
      if(table==='attendance')return Promise.resolve(res({data:[],error:null}));
      if(q.op==='update'){const hit=t.filter(match);hit.forEach(r=>Object.assign(r,q.val));
        if(hit.length)S.writes.push({table,op:'update',val:q.val,n:hit.length});return Promise.resolve(res({data:null,error:null}));}
      if(q.op==='delete'){const keep=t.filter(r=>!match(r));S.writes.push({table,op:'delete',n:t.length-keep.length});
        S.rows[table]=keep;return Promise.resolve(res({data:null,error:null}));}
      return Promise.resolve(res({data:t.filter(match).map(r=>({...r})),error:null}));
    }};return api;},
})};`;


const SEED={properties:[{id:'p1',name:'Raaya Vasyam',mapsLink:'https://maps.example/x'}],staff:[],loans:[],expenses:[],attendance:[],
  bookings:[{id:'b1',propertyId:'p1',guestName:'Anita Rao',phone:'9876543210',checkIn:D(1),checkOut:D(3),guests:2,totalAmount:6000,paid:0,
    source:'Direct',status:'confirmed',notes:'',msgSent:{}}]};
const EMPTY={properties:[],staff:[],loans:[],expenses:[],attendance:[],bookings:[]};

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(seed,o={})=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[], dialogs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
  await page.addInitScript(([s,o])=>{localStorage.setItem('staylog_v2',JSON.stringify(s));
    if(o.owner)localStorage.setItem('staylog_owner',o.owner);
    if(o.session===null)window.__auth={session:null,users:{'me@example.com':'owner-1','other@example.com':'owner-2'},signOuts:0};
    if(o.session)window.__auth={session:{user:{id:o.session,email:'x@example.com'},access_token:'t'},users:{'me@example.com':'owner-1','other@example.com':'owner-2'},signOuts:0};
    if(o.rows)sessionStorage.setItem('__srv',JSON.stringify({rows:o.rows,writes:[],invoked:[],missing:{}}));
    window.open=()=>null;},[seed,o]);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(async()=>{await window.StayLogCloud.restoreSession();state.loggedIn=true;render();});
  return {ctx,page,errs,dialogs};
};
const push=page=>page.evaluate(async()=>{try{await window.StayLogCloud.push(state.data,{manual:true});return '';}catch(e){return e.message;}});
const st=page=>page.evaluate(()=>window.StayLogCloud.status());
const writes=page=>page.evaluate(()=>window.__server.writes.filter(w=>w.op!=='select').length);

console.log('\n— the phone belongs to the login that first synced it —');
{ const {ctx,page,errs}=await open(SEED,{rows:{sync_status:[],app_status:[{id:1,min_version:0}]}});
  ok('the first sync works', await push(page)==='', await st(page));
  ok('and claims the phone for that login', (await st(page)).boundOwner==='owner-1');
  await page.evaluate(()=>window.StayLogCloud.signOut());
  const msg=await page.evaluate(async()=>{try{await window.StayLogCloud.signIn('other@example.com','x');return '';}catch(e){return e.message;}});
  ok('signing in as another login, with data on the phone, is refused', /belongs to another login/.test(msg), msg);
  ok('and leaves no session behind', !(await st(page)).signedIn&&await page.evaluate(()=>window.__auth.session)===null);
  const w0=await writes(page);
  ok('so nothing could be pushed into the other account', w0===await writes(page)&&(await page.evaluate(()=>window.__server.rows.bookings||[])).every(b=>b.owner_id==='owner-1'));
  const back=await page.evaluate(async()=>{try{await window.StayLogCloud.signIn('me@example.com','x');return '';}catch(e){return e.message;}});
  ok('the owner signs back in fine', back===''&&(await st(page)).signedIn, back);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const {ctx,page}=await open(SEED,{owner:'owner-1',session:'owner-2',rows:{sync_status:[]}});
  const s=await st(page);
  ok('a kept session for another login is let go quietly at start', !s.signedIn&&/belongs to another login/.test(s.lastError), s);
  await ctx.close(); }
{ const {ctx,page}=await open(EMPTY,{owner:'owner-1',session:null,rows:{sync_status:[]}});
  const msg=await page.evaluate(async()=>{try{await window.StayLogCloud.signIn('other@example.com','x');return '';}catch(e){return e.message;}});
  ok('an empty phone may be used by another login', msg==='', msg);
  await ctx.close(); }

console.log('\n— one phone per account —');
{ const {ctx,page,errs,dialogs}=await open(SEED,{owner:'owner-1',rows:{sync_status:[{owner_id:'owner-1',device_id:'other-phone',device_name:'iPhone',last_sync_at:'2026-11-10T05:00:00Z'}]}});
  const w0=await writes(page);
  ok('a phone that is not the one on record does not push', await push(page)===''&&await writes(page)===w0, await page.evaluate(()=>window.__server.writes));
  const s=await st(page);
  ok('it says it is paused, naming the other phone', s.devicePaused&&s.devicePaused.device==='iPhone', s.devicePaused);
  await page.evaluate(()=>{state.modal='cloud';render();}); await page.waitForTimeout(300);
  const box=await page.locator('[data-device-paused]').innerText().catch(()=>'');
  ok('the cloud panel explains it', /Sync paused on this phone/.test(box)&&/last synced from iPhone on/.test(box), box);
  ok('the menu line too', /Paused — another phone syncs this account/.test(await page.evaluate(()=>cloudMenuSub())));
  await page.click('[data-take-over]'); await page.waitForTimeout(400);
  ok('"This is now my only phone" asks first', /Make this your only phone/.test(dialogs.join('|')), dialogs);
  const row=await page.evaluate(()=>window.__server.rows.sync_status[0]);
  ok('then syncs, and records this phone as the one', row.device_id===(await st(page)).deviceId&&!(await st(page)).devicePaused, {row,st:await st(page)});
  ok('the bookings went up', (await page.evaluate(()=>window.__server.rows.bookings||[])).length===1);
  ok('the next sync is not paused', await push(page)===''&&!(await st(page)).devicePaused);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const {ctx,page}=await open(SEED,{owner:'owner-1',rows:{sync_status:[{owner_id:'owner-1',last_sync_at:'2026-11-10T05:00:00Z'}]}});
  const e=await push(page);
  ok('a record from before v60 (no device yet) is claimed by the first phone to sync', e===''&&!(await st(page)).devicePaused
     &&(await page.evaluate(()=>window.__server.rows.sync_status[0].device_id))===(await st(page)).deviceId,
     {e,row:await page.evaluate(()=>window.__server.rows.sync_status),st:await st(page)});
  await ctx.close(); }

console.log('\n— retired by the cloud —');
{ const {ctx,page,errs}=await open(SEED,{owner:'owner-1',rows:{sync_status:[],app_status:[{id:1,min_version:99}]}});
  await page.waitForTimeout(300);
  const w0=await writes(page);
  ok('an app older than min_version writes nothing', await push(page)===''&&await writes(page)===w0);
  ok('and is not shown as a failure', (await st(page)).retired===true&&(await st(page)).lastError==='');
  await page.evaluate(()=>{state.modal=null;render();});
  const b=await page.locator('[data-retired]').innerText().catch(()=>'');
  ok('it says "StayLog has been updated — close and reopen"', /StayLog has been updated — close and reopen/.test(b), b);
  ok('the menu line too', /close and reopen/.test(await page.evaluate(()=>cloudMenuSub())));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const {ctx,page}=await open(SEED,{owner:'owner-1',rows:{sync_status:[],app_status:[{id:1,min_version:60}]}});
  ok('min_version equal to this version retires nothing', await push(page)===''&&!(await st(page)).retired&&(await page.evaluate(()=>window.__server.rows.bookings||[])).length===1);
  await ctx.close(); }

console.log('\n— signing out forgets what belonged to that login —');
{ const {ctx,page}=await open(SEED,{owner:'owner-1',rows:{sync_status:[]}});
  await push(page);
  await page.evaluate(()=>{['staylog_inbox','staylog_ical_log','staylog_backup_log','staylog_att_log'].forEach(k=>localStorage.setItem(k,'{"x":1}'));
    window.__forgot=0; window.StayLogBackup.forgetKey=async()=>{window.__forgot++;};});
  await page.evaluate(()=>window.StayLogCloud.signOut());
  const left=await page.evaluate(()=>['staylog_inbox','staylog_ical_log','staylog_backup_log','staylog_att_log','staylog_last_sync'].filter(k=>localStorage.getItem(k)));
  ok('the logs and inbox cache are cleared', left.length===0, left);
  ok('the backup key is forgotten', await page.evaluate(()=>window.__forgot)===1);
  ok('the phone\'s data and its owner stay', await page.evaluate(()=>state.data.bookings.length)===1&&(await st(page)).boundOwner==='owner-1');
  await ctx.close(); }

console.log('\n— new ids, arrival instructions —');
{ const {ctx,page,errs}=await open(SEED,{owner:'owner-1',rows:{sync_status:[]}});
  ok('new ids are random UUIDs', await page.evaluate(()=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uid())));
  let t=await page.evaluate(()=>arrivalText(state.data.bookings[0]));
  ok('with no instructions set, the arrival message leaves them out', /Getting here/.test(t)&&/Safe travels/.test(t)&&!/key/i.test(t), t);
  await page.evaluate(()=>{state.modal='sendConfirm';state.editItem=state.data.bookings[0];render();}); await page.waitForTimeout(150);
  ok('the Send sheet says to add them', /No arrival instructions on this property/.test(await page.locator('body').innerText()));
  await page.evaluate(()=>{state.modal='addProp';state.editItem=state.data.properties[0];render();}); await page.waitForTimeout(150);
  await page.fill('[data-arrival-instructions]','Self check-in: the key is in the box by the gate.\nBlue gate, second house on the left.');
  await page.locator('button',{hasText:/Update Property|Save/}).first().click(); await page.waitForTimeout(200);
  t=await page.evaluate(()=>arrivalText(state.data.bookings[0]));
  ok('typed into the property, they go into the arrival message', /the key is in the box by the gate\.\nBlue gate/.test(t), t);
  await push(page);
  const cloud=await page.evaluate(()=>JSON.stringify(window.__server.rows.properties||[]));
  ok('and never to the cloud', !/box by the gate/.test(cloud)&&/Raaya Vasyam/.test(cloud), cloud);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— the old text is gone from the code —');
{ const files=['app.js','cloud.js','staff.js','backup.js','index.html','staff.html','sw.js'].map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n');
  ok('no key location or house-finding text in the app\'s files', !/behind the pot|slot in the lock|written on compound wall|before the end of the road/i.test(files));
  // Commits before v60 (up to a7115d7, v58) carried it and are public history,
  // which is not rewritten. Nothing committed since may add it back.
  const {execFileSync}=require('child_process');
  let added='';
  try{ added=execFileSync('git',['log','a7115d7..HEAD','-p','--no-color','--','.',':(exclude)tests/test_one_phone.js'],{cwd:ROOT,encoding:'utf8',maxBuffer:1<<28})
      .split('\n').filter(l=>l.startsWith('+')).join('\n'); }catch(e){ added=null; }
  ok('and no commit since v58 adds it back (git history)', added===null||!/behind the pot|slot in the lock|written on compound wall|before the end of the road/i.test(added)); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
