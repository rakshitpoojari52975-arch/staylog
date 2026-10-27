/* Mark paid for every source. Airbnb and the other platforms pay out the full
   amount: one tap on "Mark payout received" records it, with a few seconds'
   Undo, and nothing else — no amount sheet, no round off, no receipt, no
   message to the guest, no balance alert. Direct and Booking.com keep their
   own Mark paid ("Amount received?", the ₹5 round off, the receipt offer). */
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
const BK=o=>Object.assign({id:'air',propertyId:'p1',guestName:'Mia Clarke',phone:'9876543210',checkIn:D(-1),checkOut:D(1),
  guests:2,totalAmount:7200,paid:0,source:'Airbnb',status:'checkedin',notes:'',msgSent:{}},o);
const SEED=bookings=>({properties:[{id:'p1',name:'Raaya Vasyam',upiId:'staylog.test@fakebank'}],staff:[],loans:[],expenses:[],attendance:[],bookings});

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async seed=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**','**vendor/supabase.umd.js'])await ctx.route(g,r=>r.abort());
  const page=await ctx.newPage(); const errs=[], dialogs=[];
  page.on('pageerror',e=>errs.push(e.message));
  page.on('dialog',async d=>{dialogs.push(d.message());await d.accept(d.type()==='prompt'?(page.__answer??d.defaultValue()):undefined);});
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));
    window.__opened=[];window.open=u=>{window.__opened.push(u);return null;};
    window.__shared=[];navigator.canShare=()=>true;navigator.share=async o=>{window.__shared.push(o);};},seed);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(()=>{state.loggedIn=true;render();});
  return {ctx,page,errs,dialogs};
};
const expand=async(page,id)=>{await page.evaluate(id=>{state.tab='bookings';state.modal=null;state.expandedBooking=id;render();},id);await page.waitForTimeout(100);};
const card=(page,id)=>page.evaluate(id=>[...document.querySelectorAll('[data-checkin]')].find(el=>el.innerText.includes(
  state.data.bookings.find(b=>b.id===id).guestName)).innerText,id);
const B=(page,id)=>page.evaluate(id=>{const b=state.data.bookings.find(x=>x.id===id);
  return {paid:b.paid,roundOff:b.roundOff,due:balanceDue(b),receipt:canReceipt(b),ask:canAskForPayment(b),modal:state.modal};},id);

console.log('\n— an Airbnb booking with a balance —');
{ const {ctx,page,errs,dialogs}=await open(SEED([BK({paid:1000,roundOff:0})]));
  await expand(page,'air');
  ok('shows "Mark payout received"', await page.locator('[data-mark-payout]').innerText()==='Mark payout received');
  ok('and not the Direct "Mark paid"', await page.locator('[data-mark-paid]').count()===0);
  await page.locator('[data-mark-payout]').click(); await page.waitForTimeout(200);
  let b=await B(page,'air');
  ok('one tap: paid is the total', b.paid===7200, b);
  ok('round off 0', b.roundOff===0, b);
  ok('nothing due, and the card says paid', b.due===0&&/\bpaid\b/.test(await card(page,'air'))&&!/due/.test(await card(page,'air')), await card(page,'air'));
  ok('no amount sheet: nothing was asked', dialogs.length===0, dialogs);
  ok('no sheet opened, no receipt offered', b.modal===null&&await page.locator('[data-offer-receipt]').count()===0);
  ok('no receipt for Airbnb at all', b.receipt===false);
  ok('no WhatsApp message, nothing shared', (await page.evaluate(()=>window.__opened.length+window.__shared.length))===0);
  ok('the button is gone', await page.locator('[data-mark-payout]').count()===0);
  ok('a "Marked paid · Undo" note shows', /Marked paid/.test(await page.locator('[data-toast]').innerText())
     &&await page.locator('[data-toast-action]').innerText()==='Undo');
  await page.locator('[data-toast-action]').click(); await page.waitForTimeout(150);
  b=await B(page,'air');
  ok('Undo restores the previous amount', b.paid===1000&&b.due===6200, b);
  ok('  and the note goes', await page.locator('[data-toast]').count()===0);
  ok('  and the button is back', await page.locator('[data-mark-payout]').count()===1);
  await page.locator('[data-mark-payout]').click(); await page.waitForTimeout(100);
  ok('the note lasts about 5 seconds', await page.locator('[data-toast]').count()===1);
  await page.waitForTimeout(5300);
  ok('  then goes, and the payment stays', await page.locator('[data-toast]').count()===0&&(await B(page,'air')).paid===7200);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const {ctx,page}=await open(SEED([BK({paid:'',roundOff:undefined})]));
  await expand(page,'air'); await page.locator('[data-mark-payout]').click(); await page.waitForTimeout(100);
  await page.locator('[data-toast-action]').click(); await page.waitForTimeout(100);
  ok('Undo on a booking with nothing recorded puts it back as it was', JSON.stringify(await B(page,'air'))===JSON.stringify({paid:'',due:7200,receipt:false,ask:false,modal:null}),
    await B(page,'air'));
  await ctx.close(); }

console.log('\n— every platform, and when there is nothing to mark —');
{ const {ctx,page}=await open(SEED([BK({id:'mmt',source:'MakeMyTrip',guestName:'A One'}),BK({id:'oth',source:'Other',guestName:'B Two'}),
    BK({id:'can',status:'cancelled',guestName:'C Three'}),BK({id:'done',paid:7200,guestName:'D Four'}),
    BK({id:'imp',totalAmount:'',guestName:'E Five'})]));
  for(const [id,want,label] of [['mmt',1,'MakeMyTrip'],['oth',1,'"Other"'],['can',0,'a cancelled booking'],['done',0,'one already paid'],['imp',0,'an import with no amount yet']]){
    await expand(page,id);
    ok(`${label}: ${want?'the button':'no button'}`, await page.locator('[data-mark-payout]').count()===want);
  }
  await ctx.close(); }

console.log('\n— no Round off on Airbnb —');
{ const {ctx,page}=await open(SEED([BK()]));
  await page.evaluate(()=>{state.modal='addBooking';state.editItem=state.data.bookings[0];render();}); await page.waitForTimeout(150);
  ok('the field stays hidden', !(await page.locator('[data-round-off-row]').isVisible()));
  await ctx.close(); }

console.log('\n— no balance alert —');
{ const N=await import(path.join(ROOT,'supabase/functions/notify/index.ts'));
  ok('after the payout nothing is owed', N.balanceDue({total_amount:7200,paid:7200,round_off:0,source:'Airbnb'})===0);
  ok('and Airbnb is never asked for a balance anyway (only Direct and Booking.com)',
     /PAYS_US = new Set\(\['Direct', 'Booking\.com'\]\)/.test(fs.readFileSync(path.join(ROOT,'supabase/functions/notify/index.ts'),'utf8'))); }

console.log('\n— Direct and Booking.com: as before —');
for(const src of ['Direct','Booking.com']){
  const {ctx,page,dialogs}=await open(SEED([BK({id:'d',source:src,totalAmount:4632.47,paid:0})]));
  await expand(page,'d');
  ok(`${src}: "Mark paid", not the payout button`, await page.locator('[data-mark-paid]').count()===1&&await page.locator('[data-mark-payout]').count()===0);
  page.__answer='4630';
  await page.locator('[data-mark-paid]').click(); await page.waitForTimeout(250);
  const b=await B(page,'d');
  ok(`${src}: asks "Amount received?"`, dialogs.some(d=>/^Amount received\?/.test(d)), dialogs);
  ok(`${src}: the ₹5 round off applies`, b.roundOff===2.47&&b.due===0, b);
  ok(`${src}: and the receipt is offered`, await page.locator('[data-offer-receipt]').count()===1&&b.receipt===true);
  ok(`${src}: no undo note`, await page.locator('[data-toast]').count()===0);
  await ctx.close();
}

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
