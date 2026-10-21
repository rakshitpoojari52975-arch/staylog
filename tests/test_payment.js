/* Payment details for guests who pay at the property. Direct and Booking.com
   guests are sent the exact balance and how to pay — in the check-out reminder
   and in a "Payment request" — never Airbnb or other platforms that collect
   payment themselves, and never when nothing is owed. The details are property
   data: they must appear in no file of this public repository. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

// Obviously fake. The repository scan at the end allows these exact strings and nothing else.
const FAKE={upi:'staylog.test@fakebank', payee:'Test Payee', bank:'Test Account · A/c 000000000000 · IFSC TEST0000000 · Test Bank'};

const STUB = `
window.__server={upserts:{},oldSchema:false};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  from(table){const S=window.__server;const api={
    select(){return api;}, eq(){return api;}, is(){return api;}, not(){return api;},
    order(){return api;}, limit(){return api;}, update(){return api;},
    async upsert(rows){
      if(S.oldSchema&&table==='properties'&&rows.some(r=>'upi_id' in r))
        return{error:{code:'PGRST204',message:"Could not find the 'upi_id' column of 'properties' in the schema cache"}};
      (S.upserts[table]=S.upserts[table]||[]).push(...rows);return{error:null};},
    then(res){return Promise.resolve(res({data:[],error:null}));}};return api;},
})};`;

const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const PROP=o=>Object.assign({id:'p1',name:'Raaya Vasyam',upiId:FAKE.upi,upiPayee:FAKE.payee,upiQr:'',bankDetails:FAKE.bank},o);
const BK=o=>Object.assign({id:'bk1',propertyId:'p1',guestName:'Anita Rao',phone:'9876543210',checkIn:D(-2),checkOut:D(1),
  guests:2,totalAmount:6000,paid:2000,source:'Direct',status:'checkedin',notes:'',msgSent:{}},o);
const SEED=(props,bookings)=>({properties:props,staff:[],loans:[],expenses:[],attendance:[],bookings});

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async seed=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[], dialogs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));
    window.__opened=[]; window.open=u=>{window.__opened.push(u);return null;};
    window.__shared=[]; navigator.canShare=()=>true;
    navigator.share=async o=>{window.__shared.push((o.files||[]).map(f=>({name:f.name,type:f.type,size:f.size})));};},seed);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(()=>{state.loggedIn=true;render();});
  return {ctx,page,errs,dialogs};
};
const msg=(page,fn,id='bk1')=>page.evaluate(([fn,id])=>{const b=state.data.bookings.find(x=>x.id===id);
  const t=({departure:departureText,request:paymentRequestText,confirm:whatsappText})[fn](b);return t===null?null:String(t);},[fn,id]);
const sheet=async(page,id='bk1')=>{await page.evaluate(id=>{state.modal='sendConfirm';state.editItem=state.data.bookings.find(b=>b.id===id);render();},id);
  await page.waitForTimeout(150); return page.locator('body').innerText();};

console.log('\n— the message states the right balance —');
{ const {ctx,page,errs}=await open(SEED([PROP()],[BK(),BK({id:'bk2',totalAmount:4999.5,paid:1000})]));
  const t=await msg(page,'departure');
  ok('the check-out reminder states the exact balance', /A balance of ₹4,000 is pending/.test(t)&&/\*Balance due:\* ₹4,000/.test(t), t);
  ok('and how to pay it', t.includes('*Pay by UPI* to this ID:')&&t.includes('Payee name: '+FAKE.payee)&&t.includes(FAKE.bank), t);
  ok('the UPI ID is plain text on a line of its own, to copy', t.split('\n').includes(FAKE.upi), t.split('\n'));
  ok('the rest of the reminder is still there', /check-out is by 11:00 AM/.test(t)&&/review would mean a great deal/.test(t));
  const r=await msg(page,'request');
  ok('a Payment request states the same balance', /\*Balance due:\* ₹4,000/.test(r)&&r.split('\n').includes(FAKE.upi), r);
  ok('a balance with paise is stated exactly', /\*Balance due:\* ₹3,999\.50\b/.test(await msg(page,'request','bk2')), await msg(page,'request','bk2'));
  ok('no QR line when no QR is set', !/QR code/.test(t));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— nothing is sent when nothing is owed —');
{ const {ctx,page}=await open(SEED([PROP()],[BK({paid:6000}),BK({id:'bk2',paid:7000}),BK({id:'bk3',status:'cancelled'})]));
  for(const [id,why] of [['bk1','a zero balance'],['bk2','an overpaid booking'],['bk3','a cancelled booking']]){
    const t=await msg(page,'departure',id);
    ok(`${why}: the reminder carries no balance or payment details`, !/Balance|balance|UPI|IFSC|fakebank/.test(t), t);
    ok(`${why}: there is no payment request to send`, (await msg(page,'request',id))===null);
  }
  const s=await sheet(page);
  ok('and the Send sheet offers none', await page.locator('[data-pay-row]').count()===0&&!/Payment request/.test(s));
  await page.evaluate(()=>sendMessage(state.data.bookings[0],'payment'));
  ok('even asked directly, nothing opens', (await page.evaluate(()=>window.__opened)).length===0);
  await ctx.close(); }

console.log('\n— Airbnb and other platforms never get it —');
{ const {ctx,page}=await open(SEED([PROP({upiQr:'x'})],[BK({source:'Airbnb'}),BK({id:'bk2',source:'MakeMyTrip'}),BK({id:'bk3',source:'Goibibo'})]));
  for(const [id,src] of [['bk1','Airbnb'],['bk2','MakeMyTrip'],['bk3','Goibibo']]){
    const d=await msg(page,'departure',id), c=await msg(page,'confirm',id);
    ok(`${src}: no balance and no payment details in the reminder, even with ₹4,000 unpaid`, !/Balance|balance|UPI|fakebank|IFSC/.test(d), d);
    ok(`${src}: no total or balance in the confirmation`, !/Total|Balance/.test(c), c);
    ok(`${src}: no payment request`, (await msg(page,'request',id))===null);
  }
  const s=await sheet(page);
  ok('the Send sheet says why, and offers no request', await page.locator('[data-pay-row]').count()===0
     &&/Airbnb collects payment from the guest, so no balance or payment details are ever sent/.test(s), s.slice(0,600));
  ok('and no QR to share', await page.locator('[data-pay-qr-share]').count()===0);
  await page.evaluate(async()=>{await sharePaymentQR(state.data.bookings[0]);sendMessage(state.data.bookings[0],'payment');});
  ok('even asked directly, nothing is shared or opened',
     (await page.evaluate(()=>window.__shared.length+window.__opened.length))===0);
  ok('no Mark paid on an Airbnb booking', await (async()=>{await page.evaluate(()=>{state.modal=null;state.tab='bookings';state.expandedBooking='bk1';render();});
    return (await page.locator('[data-mark-paid]').count())===0;})());
  await ctx.close(); }

console.log('\n— a Booking.com booking does —');
{ const {ctx,page}=await open(SEED([PROP()],[BK({source:'Booking.com'})]));
  const d=await msg(page,'departure');
  ok('the reminder asks for the balance, with the details', /A balance of ₹4,000 is pending/.test(d)&&d.split('\n').includes(FAKE.upi), d);
  ok('the confirmation states the balance — the old "never tell Booking.com guests" rule is gone',
     /\*Balance due:\* ₹4,000/.test(await msg(page,'confirm')), await msg(page,'confirm'));
  ok('a payment request can be sent', /₹4,000/.test(await msg(page,'request')));
  await sheet(page);
  ok('the Send sheet offers it', await page.locator('[data-pay-row]').count()===1);
  await page.locator('[data-send="payment"]').click(); await page.waitForTimeout(150);
  const opened=await page.evaluate(()=>window.__opened);
  const sent=opened[0]?decodeURIComponent(opened[0].split('text=')[1]):'';
  ok('tapping Send opens WhatsApp to the guest with the request', /^https:\/\/wa\.me\/919876543210\?text=/.test(opened[0]||'')&&/₹4,000/.test(sent)&&sent.includes(FAKE.upi), opened);
  ok('and it is noted as sent', !!(await page.evaluate(()=>state.data.bookings[0].msgSent.payment)));
  await ctx.close(); }

console.log('\n— without payment details set —');
{ const {ctx,page}=await open(SEED([PROP({upiId:'',upiPayee:'',bankDetails:''})],[BK(),BK({id:'bk2',source:'Booking.com'})]));
  ok('a direct guest still gets the one-line balance reminder', /A balance of ₹4,000 is pending — you can settle it before you leave\./.test(await msg(page,'departure')));
  ok('so does a Booking.com guest now', /A balance of ₹4,000 is pending/.test(await msg(page,'departure','bk2')));
  ok('there is no payment request without details to send', (await msg(page,'request'))===null);
  const s=await sheet(page);
  ok('and the Send sheet says to add them', /no payment details yet\. Add a UPI ID or bank details/.test(s));
  await ctx.close(); }

console.log('\n— the QR goes through the share sheet —');
{ const {ctx,page,errs}=await open(SEED([PROP()],[BK()]));
  // a real PNG, made here rather than pasted into the repo
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=120;const g=c.getContext('2d');
    g.fillStyle='#fff';g.fillRect(0,0,120,120);g.fillStyle='#000';for(let i=0;i<12;i++)for(let j=0;j<12;j++)if((i*7+j*3)%5<2)g.fillRect(i*10,j*10,10,10);
    return c.toDataURL('image/png');});
  await page.evaluate(()=>{state.modal='addProp';state.editItem=state.data.properties[0];render();}); await page.waitForTimeout(200);
  await page.locator('[data-pay-qr-input]').setInputFiles(
    {name:'qr.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});
  await page.waitForTimeout(400);
  ok('a QR image can be added to the property', await page.locator('[data-pay-qr] img').count()===1);
  await page.locator('button',{hasText:'Update Property'}).click(); await page.waitForTimeout(200);
  ok('and is kept as a PNG data URL with the property', /^data:image\/png;base64,/.test(await page.evaluate(()=>state.data.properties[0].upiQr)));
  ok('the message then says a QR follows', /A QR code to scan follows in the next message\./.test(await msg(page,'departure')));
  await sheet(page);
  await page.locator('[data-pay-qr-share]').click(); await page.waitForTimeout(400);
  const shared=await page.evaluate(()=>window.__shared);
  ok('tapping it opens the share sheet with the image', shared.length===1&&shared[0][0].type==='image/png'&&/^UPI-QR-Raaya-Vasyam\.png$/.test(shared[0][0].name), shared);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— paid, then the receipt is offered —');
{ const {ctx,page,dialogs}=await open(SEED([PROP()],[BK()]));
  await page.evaluate(()=>{window.__receipts=[];window.shareReceipt=b=>{window.__receipts.push(b.id);};
    state.tab='bookings';state.expandedBooking='bk1';render();}); await page.waitForTimeout(200);
  await page.locator('[data-mark-paid]').click(); await page.waitForTimeout(250);
  ok('Mark paid asks first, naming the amount', dialogs.some(d=>/Record ₹4,000 received from Anita Rao/.test(d)), dialogs);
  ok('the booking is then paid in full', (await page.evaluate(()=>state.data.bookings[0].paid))===6000);
  ok('and the receipt is offered', await page.locator('[data-offer-receipt]').count()===1
     &&/₹6,000 received from Anita Rao/.test(await page.locator('body').innerText()));
  await page.locator('[data-offer-receipt]').click(); await page.waitForTimeout(150);
  ok('Send receipt sends that booking\'s receipt', JSON.stringify(await page.evaluate(()=>window.__receipts))==='["bk1"]');
  ok('and the payment request is no longer offered', (await msg(page,'request'))===null);
  await ctx.close(); }

{ const {ctx,page}=await open(SEED([PROP()],[BK({source:'Booking.com'})]));
  await page.evaluate(()=>{state.modal='addBooking';state.editItem=state.data.bookings[0];render();}); await page.waitForTimeout(200);
  await page.locator('input[placeholder="Paid (₹)"]').fill('5000');
  await page.locator('button',{hasText:'Update Booking'}).click(); await page.waitForTimeout(200);
  ok('a part payment typed in offers no receipt', await page.locator('[data-offer-receipt]').count()===0);
  await page.evaluate(()=>{state.modal='addBooking';state.editItem=state.data.bookings[0];render();}); await page.waitForTimeout(200);
  await page.locator('input[placeholder="Paid (₹)"]').fill('6000');
  await page.locator('button',{hasText:'Update Booking'}).click(); await page.waitForTimeout(200);
  ok('typing in the full amount offers the receipt (Booking.com too)', await page.locator('[data-offer-receipt]').count()===1);
  await ctx.close(); }

console.log('\n— property settings and sync —');
{ const {ctx,page,errs,dialogs}=await open(SEED([PROP({upiId:'',upiPayee:'',bankDetails:''})],[]));
  await page.evaluate(()=>{state.modal='addProp';state.editItem=state.data.properties[0];render();}); await page.waitForTimeout(200);
  ok('the property form has UPI ID, payee name, QR and bank details',
     await page.locator('[data-pay="upiId"]').count()===1&&await page.locator('[data-pay="upiPayee"]').count()===1
     &&await page.locator('[data-pay="bankDetails"]').count()===1&&await page.locator('[data-pay-qr]').count()===1);
  await page.locator('[data-pay="upiId"]').fill('not a upi id');
  await page.locator('button',{hasText:'Update Property'}).click(); await page.waitForTimeout(150);
  ok('a mistyped UPI ID is refused', dialogs.some(d=>/does not look right/.test(d))&&!(await page.evaluate(()=>state.data.properties[0].upiId)));
  await page.locator('[data-pay="upiId"]').fill(' '+FAKE.upi+' '); await page.locator('[data-pay="upiPayee"]').fill(FAKE.payee);
  await page.locator('[data-pay="bankDetails"]').fill(FAKE.bank);
  await page.locator('button',{hasText:'Update Property'}).click(); await page.waitForTimeout(150);
  ok('a good one is saved, trimmed', (await page.evaluate(()=>state.data.properties[0].upiId))===FAKE.upi);
  await page.evaluate(async()=>{await window.StayLogCloud.restoreSession();await window.StayLogCloud.push(state.data);});
  const row=await page.evaluate(()=>(window.__server.upserts.properties||[]).slice(-1)[0]);
  ok('they sync with the property, like the Wi-Fi', row&&row.upi_id===FAKE.upi&&row.upi_payee===FAKE.payee&&row.bank_details===FAKE.bank&&'upi_qr' in row, row);
  await page.evaluate(()=>{window.__server.oldSchema=true;window.__server.upserts={};});
  const r=await page.evaluate(async()=>{try{await window.StayLogCloud.push(state.data);return'ok';}catch(e){return e.message;}});
  const st=await page.evaluate(()=>({s:window.StayLogCloud.status().schemaBehind,p:window.__server.upserts.properties||[]}));
  ok('before payment-details.sql has run, the sync still works without them', r==='ok'&&st.p.length>0&&!st.p.some(x=>'upi_id' in x), {r,st});
  ok('and the cloud panel names the script', /supabase\/payment-details\.sql/.test(st.s), st.s);
  ok('the phone keeps them meanwhile', (await page.evaluate(()=>state.data.properties[0].upiId))===FAKE.upi);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

console.log('\n— the payment details appear in no file in the repo —');
{ // UPI IDs on real bank handles, IFSC codes, and embedded images: in every
  // file the repo has or is about to have, and in every commit. Only the fake
  // values above are allowed. Set STAYLOG_REAL_UPI / STAYLOG_REAL_ACCOUNT to
  // also search for your actual details by value.
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:ROOT,encoding:'utf8'}).trim().split('\n');
  const UPI=/\b[A-Za-z0-9._-]{2,}@(?:ok(?:axis|sbi|hdfcbank|icici)|ybl|ibl|axl|paytm|apl|upi|icici|sbi|hdfcbank|axisbank|kotak|yesbank|yesbankltd|idfcbank|idfcfirst|federal|indus|aubank|fbl|waaxis|wahdfcbank|waicici|wasbi|pthdfc|ptsbi|ptaxis|ptyes|freecharge|airtel|jio|slc|barodampay|cnrb|pnb|uboi|unionbank|mahb|kbl|rbl|dbs|hsbc|citi|abfspay|axisb|ikwik|timecosmos|naviaxis|superyes|tapicici|yapl|zoicici)\b/gi;
  const IFSC=/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, IMG=/data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+\/]{200,}/g;
  const allowed=new Set(['TEST0000000']);
  const real=[process.env.STAYLOG_REAL_UPI,process.env.STAYLOG_REAL_ACCOUNT].filter(Boolean);
  const hits=[]; let scanned=0;
  for(const f of files){
    let s; try{const b=fs.readFileSync(path.join(ROOT,f)); if(b.includes(0))continue; s=b.toString('utf8');}catch{continue;}
    scanned++;
    for(const [kind,re] of [['UPI ID',UPI],['IFSC',IFSC],['embedded image',IMG]])
      for(const m of s.match(re)||[]) if(!allowed.has(m)) hits.push(`${f}: ${kind} ${m.slice(0,40)}`);
    for(const v of real) if(s.includes(v)) hits.push(`${f}: your real details`);
  }
  ok(`no UPI ID, IFSC code or embedded image in any of the ${scanned} text files`, hits.length===0, hits);
  let hist='';try{hist=execFileSync('git',['log','--all','-p','--no-color'],{cwd:ROOT,encoding:'utf8',maxBuffer:1<<30});}catch{}
  const histHits=[...(hist.match(UPI)||[]),...(hist.match(IFSC)||[]).filter(m=>!allowed.has(m)),...(hist.match(IMG)||[])];
  ok('nor anywhere in the history', hist.length>0&&histHits.length===0, histHits.slice(0,5));
  ok('the fake UPI ID is not on a real bank handle', !(FAKE.upi.match(UPI)));
  if(real.length) for(const v of real) ok('your real details are in no commit', !hist.includes(v));
  else console.log('  (set STAYLOG_REAL_UPI to also search for your actual UPI ID by value)'); }

console.log('\n— the release is stamped —');
{ const app=fs.readFileSync(ROOT+'/app.js','utf8'), sw=fs.readFileSync(ROOT+'/sw.js','utf8');
  ok('app version and service worker cache move together',
     app.match(/APP_VERSION='v(\d+)'/)[1]===sw.match(/CACHE_NAME = 'staylog-v(\d+)'/)[1]); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
