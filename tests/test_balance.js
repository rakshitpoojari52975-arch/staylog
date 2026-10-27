/* One rule for what a guest owes: balanceDue(b). Under ₹1 counts as fully
   paid — paise left over from a rounded payment are not a debt — and every
   balance the app shows, stamps, exports or asks for comes from it. Stored
   amounts are never rounded, and a real balance keeps its paise (₹250.50).
   The notify Edge Function's 9 AM balance alert follows the same rule. */
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
// All leave today, so each also has a line under Home's "Today".
const BK=(id,total,paid,o)=>Object.assign({id,propertyId:'p1',guestName:'Guest '+id,phone:'9876543210',checkIn:D(-2),checkOut:D(0),
  guests:2,totalAmount:total,paid,source:'Direct',status:'checkedin',notes:'',msgSent:{}},o);
const CASES=[
  // id, total, paid, what it is, balance wanted
  ['half',  4999.5, 4999,   '₹4,999.50 total, ₹4,999 paid',      0],
  ['p99',   1000,   999.01, '₹0.99 due',                         0],
  ['one',   1000,   999,    '₹1.00 due',                         1],
  ['real',  1000,   749.5,  '₹250.50 due',                       250.5],
  ['over',  1000,   1000.4, 'overpaid by 40 paise',              0],
];
const SEED={properties:[{id:'p1',name:'Raaya Vasyam',upiId:'staylog.test@fakebank',upiPayee:'Test Payee'}],
  staff:[],loans:[],expenses:[],attendance:[],bookings:CASES.map(([id,t,p])=>BK(id,t,p))};

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**','**vendor/supabase.umd.js'])await ctx.route(g,r=>r.abort());
const page=await ctx.newPage(); const errs=[];
page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',d=>d.accept());
await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));window.open=()=>null;},SEED);
await page.goto(base+'/index.html');
await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
await page.evaluate(()=>{state.loggedIn=true;render();});

const facts=await page.evaluate(()=>state.data.bookings.map(b=>({id:b.id,due:balanceDue(b),stamp:receiptStamp(b),
  ask:canAskForPayment(b),paidInFull:justPaidInFull(b),departure:departureText(b),request:paymentRequestText(b)})));
const F=Object.fromEntries(facts.map(f=>[f.id,f]));
// The card: the line under the amount, and the detail's paid line.
await page.evaluate(()=>{state.tab='bookings';state.bookingFilter='all';render();});
const card=async id=>{await page.evaluate(id=>{state.tab='bookings';state.modal=null;state.expandedBooking=id;render();},id);
  const el=page.locator('.card',{hasText:'Guest '+id}).first();
  return {text:await el.innerText(),markPaid:await el.locator('[data-mark-paid]').count()};};
const sheet=async id=>{await page.evaluate(id=>{state.modal='sendConfirm';state.editItem=state.data.bookings.find(b=>b.id===id);render();},id);
  const n=await page.locator('[data-pay-row]').count(); await page.evaluate(()=>closeModal()); return n;};
await page.evaluate(()=>{state.tab='dashboard';render();});
const home=await page.locator('body').innerText();
const csv=await page.evaluate(async()=>{let blob;const orig=URL.createObjectURL;URL.createObjectURL=b=>{blob=b;return 'about:blank';};
  HTMLAnchorElement.prototype.click=function(){};
  downloadReport(state.data.bookings,[], 'test'); URL.createObjectURL=orig; return blob.text();});
const csvDue=id=>{const line=csv.split('\n').find(l=>l.includes('"Guest '+id+'"'));return line&&line.split(',').slice(-2)[0];};

console.log('\n— ₹4,999.50 total, ₹4,999 paid: fully paid —');
{ const c=await card('half');
  ok('the rule says nothing is owed', F.half.due===0, F.half.due);
  ok('the card shows Paid, not "₹0.5 due"', /\bpaid\b/.test(c.text)&&!/due/.test(c.text)&&/fully paid/.test(c.text), c.text);
  ok('no Mark paid button', c.markPaid===0);
  ok('the receipt is stamped PAID', F.half.stamp.line==='PAID', F.half.stamp);
  ok('no Payment request is offered', F.half.ask===false&&await sheet('half')===0);
  ok('and asking anyway sends nothing', F.half.request===null, F.half.request);
  ok('the check-out reminder mentions no balance', !/balance|Balance due/i.test(F.half.departure||''), F.half.departure);
  ok('it counts as paid in full (the Send receipt offer)', F.half.paidInFull===true);
  ok('Home\'s Today line shows no balance', !/Guest half[^\n]*\n[^\n]*due/.test(home)&&!home.includes('₹0.5'), home.match(/Guest half[^\n]*\n[^\n]*/));
  ok('the CSV\'s Balance Due is 0', csvDue('half')==='0', csvDue('half'));
  ok('the stored amounts keep their decimals', await page.evaluate(()=>{const b=state.data.bookings.find(x=>x.id==='half');return b.totalAmount===4999.5&&b.paid===4999;})); }

console.log('\n— the line is ₹1 —');
ok('₹0.99 due counts as paid', F.p99.due===0&&F.p99.stamp.line==='PAID'&&F.p99.ask===false&&csvDue('p99')==='0', F.p99);
ok('an overpayment by paise shows Paid', F.over.due===0&&F.over.stamp.line==='PAID'&&/\bpaid\b/.test((await card('over')).text), F.over);
ok('₹1.00 due is still a balance', F.one.due===1&&F.one.stamp.line==='PART PAID'&&F.one.stamp.sub==='Rs. 1 due'&&F.one.ask===true, F.one);
{ const c=await card('one');
  ok('shown on the card, with Mark paid', /₹1 due/.test(c.text)&&c.markPaid===1, c.text); }
ok('₹250.50 due is a balance, with its paise', F.real.due===250.5&&F.real.stamp.line==='PART PAID'&&F.real.stamp.sub==='Rs. 250.50 due', F.real);
{ const c=await card('real');
  ok('the card says ₹250.50 due', /₹250\.50 due/.test(c.text), c.text);
  ok('the payment request asks for ₹250.50', /\*Balance due:\* ₹250\.50/.test(F.real.request||''), F.real.request);
  ok('the check-out reminder too', /₹250\.50/.test(F.real.departure||''));
  ok('Home\'s Today line too', /₹250\.50 due/.test(home));
  ok('the CSV\'s Balance Due is 250.5', csvDue('real')==='250.5', csvDue('real'));
  ok('the Send sheet offers the request', await sheet('real')===1); }
{ const pdf=await page.evaluate(async()=>{
    const ok={};for(const id of ['half','real']){const b=state.data.bookings.find(x=>x.id===id);
      const doc=await buildReceiptPDF(b); ok[id]=doc.output();} return ok;});
  ok('the receipt PDF has no "Balance outstanding" line when paid', !/Balance outstanding/.test(pdf.half));
  ok('and shows it for a real balance, with its paise', /Balance outstanding/.test(pdf.real)&&/Rs\. 250\.50/.test(pdf.real)); }
ok('no page errors', errs.length===0, errs);
await br.close();

console.log('\n— the 9 AM alert follows the same rule —');
{ const F=await import(path.resolve(ROOT,'supabase/functions/notify/index.ts'));
  const row=(t,p)=>({total_amount:t,paid:p});
  ok('₹4,999.50 / ₹4,999: nothing owed', F.balanceDue(row(4999.5,4999))===0);
  ok('₹0.99: nothing owed', F.balanceDue(row(1000,999.01))===0);
  ok('overpaid by paise: nothing owed', F.balanceDue(row(1000,1000.4))===0);
  ok('₹1.00: owed', F.balanceDue(row(1000,999))===1);
  ok('₹250.50: owed, with its paise', F.balanceDue(row(1000,749.5))===250.5);
  ok('amounts arriving as text (Postgres numeric) work the same', F.balanceDue(row('4999.50','4999.00'))===0&&F.balanceDue(row('1000','749.5'))===250.5);
  const fn=fs.readFileSync(path.join(ROOT,'supabase/functions/notify/index.ts'),'utf8');
  ok('the alert uses it', /const due = balanceDue\(b\);/.test(fn)); }

console.log('\n— nothing subtracts on its own any more —');
{ const app=fs.readFileSync(path.join(ROOT,'app.js'),'utf8');
  const own=app.split('\n').map((l,i)=>[i+1,l]).filter(([,l])=>/totalAmount[^;\n]*-[^;\n]*\bpaid\b|total\s*-\s*paid/.test(l)&&!/^const balanceDue|^const d = r2\(Number\(b\.totalAmount/.test(l.trim()));
  ok('every booking balance in app.js goes through balanceDue()', own.length===0, own); }

srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
