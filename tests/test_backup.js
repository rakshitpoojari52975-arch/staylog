/* The encrypted backup (backup.js and Cloud sync → Encrypted backup), with
   real WebCrypto in Chromium and a fake Supabase that keeps rows in memory.
   What the cloud receives is inspected byte for byte: ciphertext and the
   decrypt parameters, never a name, a phone number or an ID number. With
   STAYLOG_PG, supabase/backups.sql is loaded on a real Postgres. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x).slice(0,400):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

// A Supabase that keeps every table in memory, shared across "phones" (pages)
// of one test through window.__db, which the test seeds and reads.
const STUB = `
window.__db=window.__db||{};
const T=n=>(window.__db[n]=window.__db[n]||[]);
let seq=0;
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  functions:{invoke:async()=>({data:{},error:null})},
  from(table){
    let op='select',payload=null,filters=[],ord=null,lim=null,ret=false;
    const api={
      select(){ if(op==='select'||op==='insert'||op==='upsert')ret=true; return api; },
      eq(k,v){filters.push(r=>String(r[k])===String(v));return api;},
      in(k,vs){filters.push(r=>vs.map(String).includes(String(r[k])));return api;},
      is(k,v){filters.push(r=>v===null?r[k]==null:r[k]===v);return api;},
      not(){return api;}, neq(){return api;},
      order(k,o){ord=[k,o&&o.ascending===false?-1:1];return api;}, limit(n){lim=n;return api;},
      insert(rows){op='insert';payload=Array.isArray(rows)?rows:[rows];return api;},
      upsert(rows){op='upsert';payload=Array.isArray(rows)?rows:[rows];return api;},
      update(o){op='update';payload=o;return api;}, delete(){op='delete';return api;},
      then(res,rej){
        if(window.__dbDown&&table==='backups')return Promise.resolve(res({data:null,error:{message:'network down'}}));
        const rows=T(table), hit=r=>filters.every(f=>f(r));
        let data=null;
        if(op==='select'){data=rows.filter(hit);if(ord)data=[...data].sort((a,b)=>(a[ord[0]]>b[ord[0]]?1:-1)*ord[1]);if(lim)data=data.slice(0,lim);data=JSON.parse(JSON.stringify(data));}
        if(op==='insert'){data=payload.map(r=>{const x={id:'bk'+(++seq)+'-'+Math.random().toString(36).slice(2,6),created_at:new Date(Date.now()+seq).toISOString(),...r};rows.push(x);return x;});}
        if(op==='upsert'){payload.forEach(r=>{const i=rows.findIndex(x=>x.id&&x.id===r.id);if(i>=0)rows[i]={...rows[i],...r};else rows.push({...r});});data=ret?payload:null;}
        if(op==='update'){rows.filter(hit).forEach(r=>Object.assign(r,payload));}
        if(op==='delete'){window.__db[table]=rows.filter(r=>!hit(r));}
        (window.__db.__log=window.__db.__log||[]).push({table,op,payload:op==='select'?null:payload});
        return Promise.resolve(res({data,error:null}));
      }};
    return api;}
})};`;

const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
// Fixtures with things that must never be readable in the cloud.
const SECRET={guest:'Anita Raghunathan',phone:'9845012345',idNo:'AADH-5512-8890-4471',wifi:'TideAndPalm#2026'};
const SEED={properties:[{id:'p1',name:'Raaya Vasyam',wifiName:'RaayaGuest',wifiPassword:SECRET.wifi}],
  staff:[{id:'s1',name:'Laxmi Walikar',dailyWage:400}],
  loans:[{id:'l1',staffId:'s1',principal:5000,installmentAmount:500,disbursedOn:D(-40),status:'active',repayments:[{id:'r1',date:D(-10),amount:500}]}],
  expenses:[{id:'e1',description:'Groceries',date:D(-1),category:'supplies',amount:820,paid:true}],
  attendance:[],
  bookings:[{id:'b1',propertyId:'p1',guestName:SECRET.guest,phone:SECRET.phone,checkIn:D(-1),checkOut:D(2),guests:2,
    totalAmount:6000,paid:2000,source:'Direct',status:'checkedin',notes:'Prefers the upstairs room',
    idProofType:'Aadhaar',idProofNumber:SECRET.idNo,idProofImage:'data:image/jpeg;base64,/9j/PHOTO-NEVER-LEAVES',msgSent:{}},
   {id:'b2',propertyId:'p1',guestName:'Rahul Menon',phone:'9876500000',checkIn:D(5),checkOut:D(7),guests:3,totalAmount:5000,paid:0,source:'Airbnb',status:'confirmed',notes:'',msgSent:{}}]};
const PASS='correct horse battery', PASS2='a whole new passphrase';

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
// One "phone": its own browser context (its own IndexedDB and key), on a shared cloud.
let CLOUD={};
const phone=async(seed)=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[], dialogs=[];
  page.on('pageerror',e=>errs.push(e.message));
  page.on('dialog',async d=>{dialogs.push(d.message());await (page.__dismiss?d.dismiss():d.accept());});
  await page.addInitScript(([s,cloud])=>{if(s)localStorage.setItem('staylog_v2',JSON.stringify(s));window.__db=cloud;
    window.STAYLOG_BACKUP_DEBOUNCE_MS=300;
    window.__shared=[];navigator.canShare=()=>true;navigator.share=async o=>{window.__shared.push(o.files[0]);};},[seed,CLOUD]);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(async()=>{state.loggedIn=true;await window.StayLogCloud.restoreSession();render();});
  await page.waitForFunction(()=>window.StayLogBackup.status().hasKey!==null);
  const pull=async()=>{CLOUD=await page.evaluate(()=>JSON.parse(JSON.stringify(window.__db)));};
  return {ctx,page,errs,dialogs,pull};
};
const sheet=async page=>{await page.evaluate(()=>{bk.view='';bk.msg='';setState({modal:'backup'});});await page.waitForTimeout(100);};
const msg=page=>page.locator('[data-backup-msg]').innerText().catch(()=>'');
const until=async(page,fn,ms=20000)=>page.waitForFunction(fn,null,{timeout:ms});

console.log('\n— setting the passphrase —');
const A=await phone(SEED);
{ const {page}=A;
  await page.evaluate(()=>setState({modal:'cloud'})); await page.waitForTimeout(100);
  ok('Cloud sync shows "Encrypted backup · Off"', /Encrypted backup[\s\S]*Off · set a passphrase/.test(await page.locator('[data-open-backup]').innerText()));
  await page.click('[data-open-backup]'); await page.waitForTimeout(100);
  ok('it warns plainly that a forgotten passphrase cannot be recovered', /cannot be opened — by you, by Supabase, or by anyone/.test(await page.locator('[data-backup]').innerText()));
  await page.fill('[data-bk-p1]','short pass'); await page.fill('[data-bk-p2]','short pass'); await page.click('[data-bk-set]');
  await until(page,()=>!bk.busy);
  ok('under 12 characters is refused', /at least 12 characters/.test(await msg(page))&&!(await page.evaluate(()=>StayLogBackup.status().hasKey)));
  await page.fill('[data-bk-p1]',PASS); await page.fill('[data-bk-p2]',PASS+'x'); await page.click('[data-bk-set]');
  await until(page,()=>!bk.busy);
  ok('two different entries are refused', /do not match/.test(await msg(page))&&!(await page.evaluate(()=>StayLogBackup.status().hasKey)));
  await page.fill('[data-bk-p1]',PASS); await page.fill('[data-bk-p2]',PASS); await page.click('[data-bk-set]');
  await until(page,()=>!bk.busy&&StayLogBackup.status().hasKey&&!!StayLogBackup.status().lastAt);
  ok('then it is on, with a first backup', /first backup is in the cloud/.test(await msg(page)));
  const rows=await page.evaluate(()=>window.__db.backups);
  ok('one backup row in the cloud', rows.length===1, rows.length);
  const r=rows[0];
  ok('it holds only ciphertext, salt, IV, iterations, version, size, id, owner and time',
     JSON.stringify(Object.keys(r).sort())===JSON.stringify(['app_version','ciphertext','created_at','id','iterations','iv','owner_id','salt','size']), Object.keys(r));
  ok('PBKDF2 600,000 iterations, a 16-byte salt, a 12-byte IV', r.iterations===600000&&Buffer.from(r.salt,'base64').length===16&&Buffer.from(r.iv,'base64').length===12, r);
  ok('stamped with the app version, in plain', r.app_version===await page.evaluate(()=>APP_VERSION));
  const wire=JSON.stringify(await page.evaluate(()=>window.__db.__log.filter(l=>l.table==='backups')));
  ok('no guest name, phone, ID number or Wi-Fi password anywhere in what was sent', !Object.values(SECRET).some(v=>wire.includes(v))&&!wire.includes('Rahul'));
  const ct=Buffer.from(r.ciphertext,'base64').toString('latin1');
  ok('nor in the decoded ciphertext bytes', !Object.values(SECRET).some(v=>ct.includes(v)));
  ok('no counts or names in plain (size is the byte length only)', r.size===Buffer.from(r.ciphertext,'base64').length);
  // The key: on the phone, unusable outside it.
  const key=await page.evaluate(()=>new Promise(res=>{const q=indexedDB.open('staylog_keys');q.onsuccess=()=>{
    const g=q.result.transaction('keys').objectStore('keys').get('backup');g.onsuccess=async()=>{const rec=g.result;
      let exported='no'; try{await crypto.subtle.exportKey('raw',rec.key);exported='yes';}catch(e){}
      res({type:rec.key.type,algo:rec.key.algorithm.name,len:rec.key.algorithm.length,extractable:rec.key.extractable,exported,fields:Object.keys(rec)});};};}));
  ok('the key is a non-extractable AES-256-GCM CryptoKey in IndexedDB', key.algo==='AES-GCM'&&key.len===256&&key.extractable===false&&key.exported==='no', key);
  const everywhere=await page.evaluate(async P=>{
    const ls=JSON.stringify({...localStorage});
    const dbs=await indexedDB.databases(); let idb='';
    for(const d of dbs){const db=await new Promise(r=>{const q=indexedDB.open(d.name);q.onsuccess=()=>r(q.result);});
      for(const s of db.objectStoreNames){const all=await new Promise(r=>{const g=db.transaction(s).objectStore(s).getAll();g.onsuccess=()=>r(g.result);});
        idb+=JSON.stringify(all,(k,v)=>v instanceof CryptoKey?'[key]':v);} db.close();}
    return (ls+idb+JSON.stringify(window.__db)+JSON.stringify(state)).includes(P);},PASS);
  ok('the passphrase is stored nowhere: not in storage, IndexedDB, the cloud or app state', everywhere===false); }

console.log('\n— a round trip —');
{ const {page}=A;
  const back=await page.evaluate(async P=>{const r=await StayLogBackup.restore(P);return r.data;},PASS);
  const want=JSON.parse(JSON.stringify(SEED)); want.bookings.forEach(b=>delete b.idProofImage);
  const mine=await page.evaluate(()=>{const d=JSON.parse(JSON.stringify(state.data));d.bookings.forEach(b=>delete b.idProofImage);return d;});
  ok('decrypting gives back exactly the phone\'s data, minus ID photos', JSON.stringify(back)===JSON.stringify(mine), {back:Object.keys(back)});
  ok('ID photos are not in it, even encrypted', !JSON.stringify(back).includes('PHOTO-NEVER-LEAVES')&&back.bookings.every(b=>!('idProofImage' in b)));
  ok('everything else is: names, notes, ID numbers, Wi-Fi', JSON.stringify(back).includes(SECRET.guest)&&JSON.stringify(back).includes(SECRET.idNo)
     &&JSON.stringify(back).includes(SECRET.wifi)&&JSON.stringify(back).includes('Prefers the upstairs room')); }

console.log('\n— Test restore —');
{ const {page}=A; await sheet(page);
  await page.click('[data-bk-open-verify]'); await page.fill('[data-bk-pass]','wrong passphrase 123'); await page.click('[data-bk-verify]');
  await until(page,()=>!bk.busy);
  ok('a wrong passphrase: "Wrong passphrase"', await msg(page)==='Wrong passphrase', await msg(page));
  const before=await page.evaluate(()=>JSON.stringify(state.data));
  await page.fill('[data-bk-pass]',PASS); await page.click('[data-bk-verify]'); await until(page,()=>!bk.busy);
  ok('the right one: "Backup verified", with the counts', /^Backup verified · .* · 2 bookings, 1 expenses, 1 loans\./.test(await msg(page)), await msg(page));
  ok('and nothing on the phone changed', await page.evaluate(()=>JSON.stringify(state.data))===before);
  await page.evaluate(()=>mutateData(d=>d.expenses.push({id:'e2',description:'Gas',date:today(),amount:950,paid:true})));
  await page.evaluate(()=>{bk.view='verify';render();}); await page.fill('[data-bk-pass]',PASS); await page.click('[data-bk-verify]'); await until(page,()=>!bk.busy);
  ok('a change since the backup is reported, not hidden', /differs from this phone: expenses 1 in the backup, 2 here/.test(await msg(page)), await msg(page)); }

console.log('\n— after each sync, debounced —');
{ const {page}=A;
  await page.waitForTimeout(5000);                  // let the sync and backup from the last edit settle
  // Counted as backups made (inserts): pruning keeps one per day, so rows alone would not show it.
  const made=()=>page.evaluate(()=>window.__db.__log.filter(l=>l.table==='backups'&&l.op==='insert').length);
  const n0=await made();
  await page.evaluate(()=>{state.data.properties[0].rooms=4;saveData(state.data);});   // a change worth a backup
  await page.evaluate(async()=>{for(let i=0;i<3;i++)await StayLogCloud.push(state.data,{manual:true});});
  await page.waitForTimeout(1200);
  const n1=await made();
  ok('three syncs in a row: one new backup', n1===n0+1, {n0,n1});
  ok('and the same day\'s older copy pruned: the cloud keeps one for today', await page.evaluate(()=>window.__db.backups.length)===1);
  await page.evaluate(async()=>{await StayLogCloud.push(state.data,{manual:true});}); await page.waitForTimeout(1000);
  ok('nothing changed since, same day: no extra backup', await made()===n1);
  const ivs=await page.evaluate(()=>window.__db.__log.filter(l=>l.table==='backups'&&l.op==='insert').map(l=>l.payload[0].iv));
  ok('every backup has its own IV', new Set(ivs).size===ivs.length);
  await page.evaluate(()=>{window.__dbDown=true;});
  await page.evaluate(async()=>{try{await StayLogBackup.backupNow(state.data,{force:true});}catch(e){}});
  ok('a failed backup is reported in the panel', /network down/.test(await page.evaluate(()=>StayLogBackup.status().lastError)));
  await page.evaluate(()=>{window.__dbDown=false;});
  await page.evaluate(async()=>StayLogBackup.backupNow(state.data,{force:true}));
  ok('and cleared by the next good one', await page.evaluate(()=>StayLogBackup.status().lastError)===''); }

console.log('\n— keeping: the latest, plus one a day for 30 days —');
{ const {page}=A;
  const plan=await page.evaluate(()=>{const now=Date.parse('2026-10-28T06:00:00Z'), rows=[];
    for(let d=0;d<40;d++)for(const h of [2,9,15])rows.push({id:`d${d}h${h}`,created_at:new Date(now-d*86400e3-h*3600e3).toISOString()});
    const drop=new Set(StayLogBackup._planPrune(rows,now));return {kept:rows.filter(r=>!drop.has(r.id)).map(r=>r.id),total:rows.length};});
  ok('one per day kept', plan.kept.length>=29&&plan.kept.length<=31, plan.kept.length);
  ok('the very latest kept', plan.kept.includes('d0h2'));
  ok('nothing older than 30 days', !plan.kept.some(id=>Number(id.slice(1,id.indexOf('h')))>30), plan.kept.slice(-3));
  const after=await page.evaluate(async()=>{const now=Date.now();
    window.__db.backups.push({...window.__db.backups[0],id:'old-1',created_at:new Date(now-45*86400e3).toISOString()},
      {...window.__db.backups[0],id:'old-2',created_at:new Date(now-12*86400e3).toISOString()},
      {...window.__db.backups[0],id:'old-3',created_at:new Date(now-12*86400e3+3600e3).toISOString()});
    await StayLogBackup.prune(); return window.__db.backups.map(b=>b.id);});
  ok('pruning in the cloud drops the 45-day-old one and a second copy of a day', !after.includes('old-1')&&(after.includes('old-2')!==after.includes('old-3')), after); }

console.log('\n— Save backup file —');
{ const {page}=A; await sheet(page);
  await page.click('[data-bk-file-save]'); await until(page,()=>!bk.busy);
  const f=await page.evaluate(async()=>{const f=window.__shared[0];return {name:f.name,text:await f.text()};});
  ok('handed to the share sheet as a .staylog file', /^staylog-backup-\d{4}-\d\d-\d\d\.staylog$/.test(f.name), f.name);
  const doc=JSON.parse(f.text);
  ok('it is the encrypted backup, nothing readable', doc.ciphertext&&doc.salt&&doc.iv&&doc.iterations===600000&&!Object.values(SECRET).some(v=>f.text.includes(v)));
  const back=await page.evaluate(async([t,P])=>(await StayLogBackup.restore(P,StayLogBackup.readFile(t))).data.bookings.length,[f.text,PASS]);
  ok('and it opens again with the passphrase', back===2); }

console.log('\n— Restore from backup, on a new phone —');
await A.pull();
const B=await phone(null);
{ const {page,errs}=B;
  ok('the new phone starts empty, with no key', await page.evaluate(()=>state.data.bookings.length===0&&StayLogBackup.status().hasKey===false));
  await sheet(page); await page.click('[data-bk-open-restore]'); await page.waitForTimeout(300);
  await page.fill('[data-bk-pass]','not the passphrase'); await page.click('[data-bk-restore]');
  await until(page,()=>!bk.busy);
  ok('a wrong passphrase: "Wrong passphrase", and nothing changes', await msg(page)==='Wrong passphrase'&&await page.evaluate(()=>state.data.bookings.length===0));
  await page.fill('[data-bk-pass]',PASS); await page.click('[data-bk-restore]');
  await until(page,()=>!bk.busy&&state.data.bookings.length>0);
  ok('the right one: asks before replacing, naming the backup', B.dialogs.some(d=>/^Replace everything on this phone with the backup of/.test(d)), B.dialogs);
  ok('then the phone has the data', await page.evaluate(()=>state.data.bookings.length===2&&state.data.expenses.length===2&&state.data.loans[0].repayments.length===1));
  ok('saved on the phone too', await page.evaluate(()=>JSON.parse(localStorage.getItem('staylog_v2')).bookings.length)===2);
  ok('and it keeps the passphrase\'s key, so its own backups carry on', await page.evaluate(()=>StayLogBackup.status().hasKey)===true);
  ok('no page errors', errs.length===0, errs); }
{ const {page}=B;   // a dated backup, chosen from the list
  const dated=await page.evaluate(()=>{const rows=window.__db.backups;   // make one of them three days old
    const r={...rows[0],id:'three-days-old',created_at:new Date(Date.now()-3*86400e3).toISOString()};rows.push(r);return r.id;});
  const r=await page.evaluate(async([P,id])=>{const r=await StayLogBackup.restore(P,{id});return r.createdAt;},[PASS,dated]);
  ok('a dated backup can be chosen instead of the latest', Date.now()-Date.parse(r)>2*86400e3, r); }
{ const {page}=A;   // restoring over a phone that has an ID photo keeps it
  await page.evaluate(async P=>{const r=await StayLogBackup.restore(P);replaceWithBackup(r.data);},PASS);
  ok('restoring on the same phone keeps its own ID photos', await page.evaluate(()=>state.data.bookings[0].idProofImage==='data:image/jpeg;base64,/9j/PHOTO-NEVER-LEAVES'));
  ok('and keeps what was there aside first', await page.evaluate(()=>idbGet('staylog_before_restore').then(d=>!!(d&&d.bookings.length)))); }
{ const {page}=B; page.__dismiss=true;
  const before=await page.evaluate(()=>state.data.expenses.length);
  await page.evaluate(()=>mutateData(d=>d.expenses.push({id:'e9',description:'Only on B',date:today(),amount:1,paid:true})));
  await sheet(page); await page.click('[data-bk-open-restore]'); await page.waitForTimeout(200);
  await page.fill('[data-bk-pass]',PASS); await page.click('[data-bk-restore]'); await until(page,()=>!bk.busy);
  ok('cancelling the confirmation changes nothing', await page.evaluate(()=>state.data.expenses.some(e=>e.id==='e9'))&&/Nothing was changed/.test(await msg(page)));
  page.__dismiss=false; }

console.log('\n— Change passphrase —');
{ const {page}=A; await sheet(page);
  await page.click('[data-bk-open-change]');
  await page.fill('[data-bk-cur]','wrong passphrase 123'); await page.fill('[data-bk-p1]',PASS2); await page.fill('[data-bk-p2]',PASS2);
  await page.click('[data-bk-change]'); await until(page,()=>!bk.busy,60000);
  ok('the current passphrase is checked first', await msg(page)==='Wrong passphrase');
  const n=await page.evaluate(()=>window.__db.backups.length);
  await page.fill('[data-bk-cur]',PASS); await page.fill('[data-bk-p1]',PASS2); await page.fill('[data-bk-p2]',PASS2);
  await page.click('[data-bk-change]'); await until(page,()=>!bk.busy,120000);
  ok('changed, and every backup re-encrypted', new RegExp(`^Passphrase changed\\. ${n+1} backups now open with the new one\\.$`).test(await msg(page)), await msg(page));
  const salts=await page.evaluate(()=>new Set(window.__db.backups.map(b=>b.salt)).size);
  ok('all under one new salt', salts===1, salts);
  ok('the old passphrase opens nothing now', await page.evaluate(async P=>{try{await StayLogBackup.verify(P,state.data);return 'opened';}catch(e){return e.message;}},PASS)==='Wrong passphrase');
  ok('the new one opens the latest', (await page.evaluate(async P=>(await StayLogBackup.verify(P,state.data)).ok,PASS2))===true);
  ok('and the oldest', await page.evaluate(async P=>{const rows=[...window.__db.backups].sort((a,b)=>a.created_at<b.created_at?-1:1);
    return (await StayLogBackup.restore(P,rows[0])).data.bookings.length;},PASS2)===2);
  ok('the phone\'s stored key is replaced: new backups open with the new passphrase', await page.evaluate(async P=>{
    await StayLogBackup.backupNow(state.data,{force:true}); return (await StayLogBackup.restore(P)).data.bookings.length;},PASS2)===2); }

console.log('\n— the menu: one backup, encrypted —');
{ const {page}=A;
  await page.evaluate(()=>{bk.view='';setState({modal:'menu'});}); await page.waitForTimeout(150);
  const t=await page.locator('body').innerText();
  ok('no "Back up data" row, and no plain "Restore from backup" row', !/Back up data/.test(t)&&!/Replaces everything on this device/.test(t)&&!/Restore from backup/.test(t), t.slice(0,400));
  ok('the plain JSON export and import are gone from the app', await page.evaluate(()=>typeof window.downloadBackup==='undefined'&&typeof window.restoreBackup==='undefined'));
  const row=page.locator('button',{hasText:'Encrypted backup'});
  ok('an "Encrypted backup" row instead', await row.count()===1);
  ok('its subtitle is the last backup time', new RegExp('Last backup '+(await page.evaluate(()=>bkWhen(StayLogBackup.status().lastAt))).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).test(await row.innerText()), await row.innerText());
  await row.click(); await page.waitForTimeout(150);
  ok('and it opens the encrypted backup panel', await page.evaluate(()=>state.modal)==='backup'&&await page.locator('[data-bk-now]').count()===1); }
{ const C=await phone(null);
  await C.page.evaluate(()=>setState({modal:'menu'})); await C.page.waitForTimeout(150);
  ok('on a phone without a passphrase the row says "Off · set a passphrase"', /Encrypted backup\s*Off · set a passphrase/.test(await C.page.locator('button',{hasText:'Encrypted backup'}).innerText()));
  await C.page.locator('button',{hasText:'Encrypted backup'}).click(); await C.page.waitForTimeout(150);
  ok('and opens the panel at "set a passphrase"', await C.page.locator('[data-bk-set]').count()===1);
  await C.ctx.close(); }
{ const src=['app.js','cloud.js','backup.js','staff.js','index.html'].map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n');
  ok('nothing in the app calls downloadBackup or restoreBackup, or writes a .json backup', !/downloadBackup|restoreBackup|staylog-backup-\$\{today\(\)\}\.json/.test(src)); }

console.log('\n— the reminder, and the sync it follows —');
{ const app=fs.readFileSync(path.join(ROOT,'app.js'),'utf8'), cloud=fs.readFileSync(path.join(ROOT,'cloud.js'),'utf8');
  ok('a "No encrypted backup in 3 days" toggle, on by default', /\['backup','No encrypted backup in 3 days'/.test(app));
  ok('the existing sync is unchanged: same tables, same mappers',
     /const ORDER = \['properties', 'staff', 'loans', 'loan_repayments', 'expenses', 'bookings'\];/.test(cloud)); }
{ const N=await import(path.join(ROOT,'supabase/functions/notify/index.ts'));
  const OWNER='owner-1', NOW=Date.parse('2026-10-28T03:30:00Z');
  const run=async(rows,prefs)=>{const tables={backups:rows,bookings:[],properties:[],sync_status:[],notification_prefs:prefs?[{owner_id:OWNER,prefs}]:[]};
    const got=[];const fake=async(url,init={})=>{const u=new URL(url),t=u.pathname.replace('/rest/v1/','');
      if(u.host!=='p.supabase.co'){got.push(url);return new Response(null,{status:201});}
      if(t==='push_subscriptions')return new Response(JSON.stringify([{endpoint:'https://web.push.apple.com/x',owner_id:OWNER,p256dh:'BAbc',auth:'abc'}]));
      if(t==='push_log')return new Response(JSON.stringify((init.method==='POST')?[{}]:[]),{status:200});
      const rows=(tables[t]||[]);return new Response(JSON.stringify(rows),{status:tables[t]?200:404});};
    const r=await N.handle(new Request('https://p.supabase.co/functions/v1/notify',{method:'POST',headers:{'x-cron-secret':'s'},body:'{"job":"daily"}'}),
      {SUPABASE_URL:'https://p.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'k',PUSH_CRON_SECRET:'s',VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:'',VAPID_SUBJECT:'mailto:x@example.invalid'},fake,NOW);
    return (await r.json()).report.filter(x=>/^backup:/.test(x.key));};
  let rep=await run([{owner_id:OWNER,created_at:'2026-10-24T09:00:00Z'}]);
  ok('notify: last backup 3+ days ago → a backup reminder', rep.length===1, rep);
  rep=await run([{owner_id:OWNER,created_at:'2026-10-26T09:00:00Z'}]);
  ok('notify: 2 days ago → none', rep.length===0, rep);
  rep=await run([]);
  ok('notify: never set up → none', rep.length===0, rep);
  rep=await run([{owner_id:OWNER,created_at:'2026-10-20T09:00:00Z'}],{backup:false});
  ok('notify: the toggle off → not sent', rep.length===1&&rep[0].skipped==='turned off', rep); }

const CONN=(process.env.STAYLOG_PG||'').split(/\s+/).filter(Boolean);
if(CONN.length){
  console.log('\n— supabase/backups.sql —');
  const psql=(db,args)=>{try{return{out:execFileSync('psql',[...CONN,'-d',db,'-q','-t','-A','-v','ON_ERROR_STOP=1',...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}),err:''};}
    catch(e){return{out:'',err:String(e.stderr||e.message)};}};
  const DB='staylog_backups_test', O='11111111-1111-1111-1111-111111111111', X='22222222-2222-2222-2222-222222222222';
  psql('postgres',['-c',`drop database if exists ${DB}`]); psql('postgres',['-c',`create database ${DB}`]);
  psql(DB,['-c',`do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
    create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
    grant usage on schema public, auth to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    insert into auth.users values ('${O}'),('${X}');`]);
  let r=psql(DB,['-f',path.join(ROOT,'supabase/setup.sql')]); ok('setup.sql loads', !r.err, r.err);
  r=psql(DB,['-f',path.join(ROOT,'supabase/backups.sql')]); ok('first run', !r.err, r.err);
  r=psql(DB,['-f',path.join(ROOT,'supabase/backups.sql')]); ok('second run', !r.err, r.err);
  const as=(role,uid,q)=>psql(DB,['-c',`begin; set local role ${role}; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
  r=as('authenticated',O,`insert into public.backups (ciphertext,salt,iv,iterations,app_version,size) values ('Y3Q=','c2FsdA==','aXY=',600000,'v50',2)`);
  ok('the owner stores a backup (owner filled in)', !r.err, r.err);
  ok('he reads, updates and deletes his own', !as('authenticated',O,`select count(*) from public.backups`).err
     &&as('authenticated',O,`update public.backups set iv='bmV3' returning 1`).out.trim()==='1');
  const other=as('authenticated',X,`select count(*) from public.backups`).out.trim();
  ok('another account sees none of it', other==='0', other);
  ok('nor can it write one for him', !!as('authenticated',X,`insert into public.backups (owner_id,ciphertext,salt,iv,iterations,size) values ('${O}','x','x','x',600000,1)`).err);
  ok('anon gets nothing', !!as('anon','',`select count(*) from public.backups`).err||as('anon','',`select count(*) from public.backups`).out.trim()==='0');
  ok('no one can TRUNCATE it', /permission denied/.test(as('authenticated',O,`truncate public.backups`).err));
  ok('weak iteration counts are refused', !!psql(DB,['-c',`insert into public.backups (owner_id,ciphertext,salt,iv,iterations,size) values ('${O}','x','x','x',1000,1)`]).err);
  psql('postgres',['-c',`drop database if exists ${DB}`]);
} else console.log('\n  (STAYLOG_PG not set — skipping supabase/backups.sql)');

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
