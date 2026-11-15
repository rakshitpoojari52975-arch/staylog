/* ⋯ → Inventory (v60): a read-only count of everything on the phone and the
   money it adds up to — the numbers the move to the new cloud must match.
   Checked against figures worked out here independently, on data with
   cancelled stays, paise, round offs on Direct/Booking.com (and a stray one on
   Airbnb, which counts as 0), receipts in two series, wages paid and unpaid,
   and a loan with repayments. Opening it changes nothing. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

const BK=(id,o)=>Object.assign({id,propertyId:'p1',guestName:'G '+id,phone:'',guests:2,source:'Direct',status:'checkedout',notes:'',msgSent:{}},o);
const SEED={properties:[{id:'p1',name:'Raaya Vasyam',rooms:3},{id:'p2',name:'Second House',rooms:2}],
  staff:[{id:'stf1',name:'Laxmi Walikar',dailyWage:300},{id:'stf2',name:'Ravi',dailyWage:400}],
  bookings:[
    BK('b1',{checkIn:'2025-10-03',checkOut:'2025-10-05',totalAmount:4999.5,paid:4999,receiptNo:'RV/2025-26/001'}),        // 0.5 left: paid
    BK('b2',{checkIn:'2025-10-10',checkOut:'2025-10-12',totalAmount:4632.47,paid:4630,roundOff:2.47,receiptNo:'RV/2025-26/007'}),
    BK('b3',{checkIn:'2025-10-20',checkOut:'2025-10-22',totalAmount:6000,paid:2000,source:'Booking.com',status:'confirmed'}),   // 4000 due
    BK('b4',{checkIn:'2025-10-25',checkOut:'2025-10-27',totalAmount:9000,paid:0,status:'cancelled'}),                           // left out
    BK('b5',{checkIn:'2025-11-01',checkOut:'2025-11-03',totalAmount:5000,paid:5000,source:'Airbnb',roundOff:3}),              // Airbnb: no round off
    BK('b6',{checkIn:'2025-11-05',checkOut:'2025-11-06',totalAmount:4995,paid:5000,roundOff:-5,propertyId:'p2',receiptNo:'SH/2025-26/003'}),
    BK('b7',{checkIn:'2026-04-02',checkOut:'2026-04-04',totalAmount:1000,paid:1000,receiptNo:'RV/2026-27/001'}),
  ],
  expenses:[
    {id:'wag_stf1_20251003',date:'2025-10-03',amount:300,category:'staff',staffId:'stf1',paid:true,propertyId:'p1',description:'Wage'},
    {id:'wag_stf1_20251004',date:'2025-10-04',amount:250.5,category:'staff',staffId:'stf1',paid:false,propertyId:'p1',description:'Wage'},
    {id:'wag_stf2_20251101',date:'2025-11-01',amount:400,category:'staff',staffId:'stf2',paid:false,propertyId:'p1',description:'Wage'},
    {id:'e1',date:'2025-11-02',amount:1234.25,category:'utilities',paid:true,propertyId:'p2',description:'Power'},
  ],
  loans:[{id:'l1',staffId:'stf1',principal:5000,installmentAmount:500,disbursedOn:'2025-09-01',firstDueDate:'2025-10-01',status:'active',
    repayments:[{id:'r1',date:'2025-10-01',amount:500,mode:'direct'},{id:'r2',date:'2025-11-01',amount:249.75,mode:'payout'}]}],
  attendance:[]};
// Worked out by hand from the rules (bookings by check-in month; cancelled left out).
const WANT={
  '2025-10':{revenue:r2(4999.5+(4632.47-2.47)+6000),expenses:550.5,paid:r2(4999+4630+2000),due:4000,roundOff:2.47},
  '2025-11':{revenue:r2(5000+(4995+5)),expenses:1634.25,paid:10000,due:0,roundOff:-5},
  '2026-04':{revenue:1000,expenses:0,paid:1000,due:0,roundOff:0}};
function r2(n){return Math.round(n*100)/100;}

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**','**vendor/supabase.umd.js'])await ctx.route(g,r=>r.abort());
const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.addInitScript(s=>localStorage.setItem('staylog_v2',JSON.stringify(s)),SEED);
await page.goto(base+'/index.html');
await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
await page.evaluate(()=>{state.loggedIn=true;render();});
const before=await page.evaluate(()=>JSON.stringify(state.data));
const inv=await page.evaluate(()=>inventoryOf(state.data));

console.log('\n— counts —');
ok('every table counted, cancelled stays included', JSON.stringify(inv.counts)===JSON.stringify({properties:2,bookings:7,cancelled:1,expenses:4,staff:2,loans:1,repayments:2,attendance:0,idPhotos:0}), inv.counts);

console.log('\n— money by month —');
for(const [m,w] of Object.entries(WANT)){
  const got=inv.months.find(x=>x.month===m);
  ok(`${m}: revenue, expenses, paid, due and round off to the paisa`, got&&['revenue','expenses','paid','due','roundOff'].every(k=>got[k]===w[k]), {got,w});
  ok(`${m}: net = revenue − expenses`, got&&got.net===r2(w.revenue-w.expenses), got);
}
ok('the cancelled stay is left out of every money figure', inv.months.find(x=>x.month==='2025-10').bookings===3);
ok('Airbnb\'s stored round off counts as 0', inv.months.find(x=>x.month==='2025-11').roundOff===-5);
ok('under ₹1 left over counts as paid (balance due 0)', inv.months.find(x=>x.month==='2025-10').due===4000);
ok('all-time totals add the months', inv.totals.revenue===r2(Object.values(WANT).reduce((t,w)=>t+w.revenue,0))&&inv.totals.expenses===2184.75, inv.totals);
ok('newest month first', inv.months[0].month==='2026-04');

console.log('\n— loans, wages, receipts —');
ok('the loan: principal, repaid, outstanding', JSON.stringify(inv.loans)===JSON.stringify([{id:'l1',staff:'Laxmi Walikar',principal:5000,repaid:749.75,outstanding:4250.25,status:'active'}]), inv.loans);
ok('unpaid wages per staff member, with paise', inv.staff.find(x=>x.id==='stf1').unpaid===250.5&&inv.staff.find(x=>x.id==='stf2').unpaid===400, inv.staff);
ok('the highest receipt in each series', JSON.stringify(inv.receipts.map(r=>[r.series,r.last,r.count]))
   ===JSON.stringify([['RV/2025-26','RV/2025-26/007',2],['RV/2026-27','RV/2026-27/001',1],['SH/2025-26','SH/2025-26/003',1]]), inv.receipts);

console.log('\n— on screen —');
await page.evaluate(()=>{state.modal='menu';render();});
await page.locator('button',{hasText:'Inventory'}).click(); await page.waitForTimeout(200);
ok('⋯ → Inventory opens it', await page.evaluate(()=>state.modal)==='inventory'&&await page.locator('[data-inventory]').count()===1);
const text=await page.locator('[data-inventory]').innerText();
ok('it tells him to screenshot it', /screenshots/.test(text));
ok('counts on screen', /Bookings \(all\)\s*7/.test(text)&&/of them cancelled\s*1/.test(text)&&/Loan repayments\s*2/.test(text), text.slice(0,400));
ok('money on screen, in ₹ with Indian grouping and paise', /₹26,629\.50/.test(text)&&/₹2,184\.75/.test(text), text);
ok('a negative round off reads -₹2.53, not ₹-2.53', /-₹2\.53/.test(text)&&!/₹-/.test(text));
ok('a month on screen', await page.locator('[data-inv-month="2025-10"]').count()===1);
ok('the loan on screen', /₹4,250\.25/.test(await page.locator('[data-inv-loan="l1"]').innerText()));
ok('the receipts on screen', /SH\/2025-26\/003/.test(await page.locator('[data-inv-receipts]').innerText()));
ok('opening it changed no data', await page.evaluate(()=>JSON.stringify(state.data))===before);
ok('no page errors', errs.length===0, errs);
await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
