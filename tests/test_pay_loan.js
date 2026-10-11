/* Payday with a loan running. The Pay sheet offers to take the month's
   instalment out of the wages being settled. The instalment is bigger than any
   one day's wage, so it is spread across the ticked days, oldest first, and
   each day carries its share the way a single payout already does — so the
   loan, the expense list, the cloud and a later delete all agree. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

// A Supabase that records what is pushed and has nothing to say back.
const STUB = `
window.__server={upserts:{}};
window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'owner-1',email:'me@example.com'}}}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  from(table){const S=window.__server;const api={
    select(){return api;}, eq(){return api;}, is(){return api;}, not(){return api;},
    order(){return api;}, limit(){return api;}, update(){return api;},
    async upsert(rows){(S.upserts[table]=S.upserts[table]||[]).push(...rows);return{error:null};},
    then(res){return Promise.resolve(res({data:[],error:null}));}};return api;},
})};`;

const wage=(d,amt=300)=>({id:'wag_stf1_202610'+d, staffId:'stf1', category:'staff', propertyId:'p1',
  description:'Wage — Lakshmi Walikar · '+d+' Oct', date:'2026-10-'+d, amount:amt, grossAmount:amt,
  loanId:'', loanDeduction:0, paid:false, fromAttendance:'att_stf1_202610'+d});
const LOAN={id:'loan1', staffId:'stf1', propertyId:'p1', principal:40000, installmentAmount:2000,
  disbursedOn:'2026-09-01', firstDueDate:'2026-10-01', status:'active', repayments:[], notes:''};
const DAYS=['01','02','03','04','05','06','07','08','09','10'];            // ten days × ₹300 = ₹3,000
const SEED = extra => Object.assign({
  properties:[{id:'p1',name:'Raaya Vasyam'}],
  staff:[{id:'stf1',name:'Lakshmi Walikar',dailyWage:300,active:true},
         {id:'stf2',name:'Ravi',dailyWage:400,active:true}],
  loans:[JSON.parse(JSON.stringify(LOAN))], bookings:[], expenses:DAYS.map(d=>wage(d)), attendance:[]}, extra);

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open = async seed => {
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:STUB}));
  const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const dialogs=[]; let answer=true;
  page.on('dialog',async dl=>{dialogs.push(dl.message()); answer?await dl.accept():await dl.dismiss();});
  await page.addInitScript(s=>{localStorage.setItem('staylog_v2',JSON.stringify(s));},seed);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined' && !state._loading);
  return {ctx,page,errs,dialogs,setAnswer:a=>{answer=a;}};
};
const paySheet = async (page,staffId='stf1') => {
  await page.evaluate(id=>{state.loggedIn=true;state.modal='settleWages';
    state.editItem=state.data.staff.find(s=>s.id===id);render();},staffId);
  await page.waitForTimeout(350);
};
const payBtn = page => page.locator('button',{hasText:/^Mark .* as paid$/});
const snap = page => page.evaluate(()=>({
  exp:state.data.expenses.map(e=>({id:e.id,date:e.date,amount:e.amount,gross:e.grossAmount,
    loanId:e.loanId,ded:e.loanDeduction,paid:e.paid})).sort((a,b)=>a.date.localeCompare(b.date)),
  loans:state.data.loans.map(l=>({id:l.id,status:l.status,balance:loanBalance(l),
    reps:(l.repayments||[]).map(r=>({amount:r.amount,expenseId:r.expenseId,date:r.date,mode:r.mode}))})),
  modal:state.modal}));
const sum=a=>Math.round(a.reduce((t,x)=>t+Number(x||0),0)*100)/100;

console.log('\n— the split, on its own —');
{ const {ctx,page}=await open(SEED({}));
  const r=await page.evaluate(()=>({
    a:splitLoanDeduction([{id:'c',date:'2026-10-03',amount:300},{id:'a',date:'2026-10-01',amount:300},
                          {id:'b',date:'2026-10-02',amount:300}],700),
    b:splitLoanDeduction([{id:'a',date:'2026-10-01',amount:300}],1000),
    c:splitLoanDeduction([{id:'a',date:'2026-10-01',amount:300}],0)}));
  ok('oldest day first, each capped at its wage',
     JSON.stringify(r.a)===JSON.stringify([{id:'a',share:300},{id:'b',share:300},{id:'c',share:100}]), r.a);
  ok('never takes more than a day holds', r.b.length===1&&r.b[0].share===300, r.b);
  ok('nothing to deduct, nothing touched', r.c.length===0, r.c);
  await ctx.close(); }

console.log('\n— offered, not assumed —');
{ const {ctx,page,errs}=await open(SEED({}));
  await paySheet(page);
  ok('the sheet offers the deduction when a loan is running',
     await page.locator('[data-loan-toggle]').count()===1);
  ok('it starts switched off', await page.locator('[data-loan-amt]').count()===0);
  ok('so the button pays the full ₹3,000', (await payBtn(page).innerText())==='Mark ₹3,000 as paid',
     await payBtn(page).innerText());
  await payBtn(page).click(); await page.waitForTimeout(300);
  const s=await snap(page);
  ok('left off, every day is paid in full', s.exp.every(e=>e.paid&&e.amount===300&&!e.loanId), s.exp);
  ok('and the loan is not touched', s.loans[0].reps.length===0&&s.loans[0].balance===40000, s.loans[0]);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

{ const {ctx,page}=await open(SEED({}));
  await paySheet(page,'stf2');
  ok('no loan, no offer', await page.locator('[data-loan-toggle]').count()===0);
  await ctx.close(); }

console.log('\n— payday with the ₹2,000 instalment —');
{ const {ctx,page,errs,dialogs}=await open(SEED({}));
  await paySheet(page);
  await page.locator('[data-loan-toggle]').click(); await page.waitForTimeout(150);
  ok('switching it on fills in this month\'s instalment',
     (await page.locator('[data-loan-amt]').inputValue())==='2000');
  ok('the button now pays the cash that changes hands',
     (await payBtn(page).innerText())==='Mark ₹1,000 as paid', await payBtn(page).innerText());
  const sheet=await page.locator('body').innerText();
  ok('and the sheet shows the sum', /Less loan instalment/.test(sheet)&&/Cash to hand over/.test(sheet));
  ok('the header counts what goes to the loan', /₹2,000 to loan/.test(sheet));
  await payBtn(page).click(); await page.waitForTimeout(300);
  ok('the confirmation names both figures',
     dialogs.some(m=>/₹2,000 goes to the loan; ₹1,000 is handed over/.test(m)), dialogs);
  const s=await snap(page), L=s.loans[0];
  ok('the loan is credited exactly ₹2,000', sum(L.reps.map(r=>r.amount))===2000, L.reps);
  ok('its balance is ₹38,000', L.balance===38000, L.balance);
  ok('every repayment belongs to a wage, as a single payout\'s does',
     L.reps.every(r=>r.mode==='payout'&&s.exp.some(e=>e.id===r.expenseId)), L.reps);
  ok('one repayment per wage, never two', new Set(L.reps.map(r=>r.expenseId)).size===L.reps.length);
  const cut=s.exp.filter(e=>e.ded>0);
  ok('the oldest six days are taken whole, the seventh in part',
     cut.length===7 && cut.slice(0,6).every(e=>e.ded===300&&e.amount===0) && cut[6].ded===200&&cut[6].amount===100,
     cut);
  ok('and they are the oldest days', cut.map(e=>e.date.slice(-2)).join()==='01,02,03,04,05,06,07', cut.map(e=>e.date));
  ok('each cut day keeps its gross wage', cut.every(e=>e.gross===300&&e.loanId==='loan1'), cut);
  ok('every day is paid', s.exp.every(e=>e.paid), s.exp);
  ok('cash booked as expense is ₹1,000', sum(s.exp.map(e=>e.amount))===1000, sum(s.exp.map(e=>e.amount)));
  ok('the sheet closes', s.modal===null, s.modal);
  ok('no page errors', errs.length===0, errs);

  // the deduction reaches the cloud the way a single payout's does
  await page.evaluate(async()=>{await window.StayLogCloud.restoreSession(); await window.StayLogCloud.push(state.data);});
  await page.waitForTimeout(500);
  const up=await page.evaluate(()=>window.__server.upserts);
  const reps=(up.loan_repayments||[]), exps=(up.expenses||[]);
  ok('the repayments are pushed', sum(reps.map(r=>r.amount))===2000, reps);
  ok('and the wages carry their share', exps.filter(e=>Number(e.loan_deduction)>0).length===7,
     exps.map(e=>[e.id,e.loan_deduction]));

  // delete one cut day: only its share comes back off the loan
  await page.evaluate(()=>mutateData(d=>{d.expenses=d.expenses.filter(x=>x.id!=='wag_stf1_20261003');
    unlinkExpenseLoan(d,'wag_stf1_20261003');}));
  const t=await snap(page);
  ok('deleting a day reverses that day\'s share and nothing else', t.loans[0].balance===38300, t.loans[0].balance);
  await ctx.close(); }

console.log('\n— what it will not do —');
{ const {ctx,page}=await open(SEED({}));
  await paySheet(page);
  await page.locator('button',{hasText:'Clear all'}).click();
  for(const d of ['09','10'])await page.locator(`[data-exp="wag_stf1_202610${d}"]`).click();   // ₹600 ticked
  await page.locator('[data-loan-toggle]').click(); await page.waitForTimeout(150);
  ok('a deduction larger than the days ticked cannot be paid', await payBtn(page).isDisabled());
  ok('and the sheet says why', /larger than the ₹600 of wages ticked/.test(await page.locator('body').innerText()));
  await page.locator('[data-loan-amt]').fill('500'); await page.waitForTimeout(100);
  ok('bring it within reach and it can', !(await payBtn(page).isDisabled()));
  ok('₹600 less ₹500 is ₹100 in hand', (await payBtn(page).innerText())==='Mark ₹100 as paid');
  await page.locator('[data-loan-amt]').fill(''); await page.waitForTimeout(100);
  ok('switched on with no amount, it cannot be paid', await payBtn(page).isDisabled());
  await ctx.close(); }

{ const {ctx,page,setAnswer}=await open(SEED({}));
  await paySheet(page);
  await page.locator('[data-loan-toggle]').click();
  setAnswer(false);
  await payBtn(page).click(); await page.waitForTimeout(300);
  const s=await snap(page);
  ok('cancelling the confirmation changes nothing',
     s.exp.every(e=>!e.paid&&e.amount===300&&!e.loanId) && s.loans[0].reps.length===0, s);
  await ctx.close(); }

console.log('\n— the month\'s instalment, not a fixed figure —');
{ const seed=SEED({}); seed.loans[0].repayments=[{id:'r0',date:'2026-10-02',amount:1500,mode:'cash',note:''}];
  const {ctx,page}=await open(seed);
  await paySheet(page);
  await page.locator('[data-loan-toggle]').click(); await page.waitForTimeout(150);
  ok('₹1,500 already paid in cash leaves ₹500 of this instalment',
     (await page.locator('[data-loan-amt]').inputValue())==='500');
  await ctx.close(); }

{ const seed=SEED({}); seed.loans[0].principal=1200;           // ₹1,200 left, less than an instalment
  const {ctx,page}=await open(seed);
  await paySheet(page);
  await page.locator('[data-loan-toggle]').click(); await page.waitForTimeout(150);
  ok('the last instalment is only what is still owed',
     (await page.locator('[data-loan-amt]').inputValue())==='1200');
  await payBtn(page).click(); await page.waitForTimeout(300);
  const s=await snap(page);
  ok('and paying it closes the loan', s.loans[0].status==='closed'&&s.loans[0].balance===0, s.loans[0]);
  ok('after which the sheet stops offering', await (async()=>{
    await page.evaluate(()=>{state.data.expenses.push({id:'wag_stf1_20261011',staffId:'stf1',category:'staff',
      propertyId:'p1',description:'Wage',date:'2026-10-11',amount:300,grossAmount:300,loanId:'',loanDeduction:0,paid:false});});
    await paySheet(page);
    return (await page.locator('[data-loan-toggle]').count())===0;})());
  await ctx.close(); }

console.log('\n— two loans, and a day already cut —');
{ const seed=SEED({});
  seed.loans.push({...JSON.parse(JSON.stringify(LOAN)),id:'loan2',principal:5000,installmentAmount:1000,disbursedOn:'2026-08-01'});
  // 10 Oct was entered by hand with ₹100 off for loan1; that cut stays as it is
  const e10=seed.expenses.find(e=>e.date==='2026-10-10'); Object.assign(e10,{loanId:'loan1',loanDeduction:100,amount:200});
  const {ctx,page}=await open(seed);
  await paySheet(page);
  await page.locator('[data-loan-toggle]').click(); await page.waitForTimeout(150);
  ok('with two loans, it asks which', await page.locator('[data-loan-pick]').count()===1);
  ok('the existing cut counts towards loan1\'s month', (await page.locator('[data-loan-amt]').inputValue())==='1900');
  await page.locator('[data-loan-pick]').selectOption('loan2'); await page.waitForTimeout(150);
  ok('picking the other loan offers its instalment', (await page.locator('[data-loan-amt]').inputValue())==='1000');
  await payBtn(page).click(); await page.waitForTimeout(300);
  const s=await snap(page), L1=s.loans.find(l=>l.id==='loan1'), L2=s.loans.find(l=>l.id==='loan2');
  ok('the instalment goes to the loan picked', sum(L2.reps.map(r=>r.amount))===1000, L2.reps);
  ok('the hand-entered cut still goes to its own loan',
     L1.reps.length===1&&L1.reps[0].amount===100&&L1.reps[0].expenseId==='wag_stf1_20261010', L1.reps);
  const d10=s.exp.find(e=>e.date==='2026-10-10');
  ok('and that day is not cut twice', d10.ded===100&&d10.amount===200&&d10.loanId==='loan1', d10);
  await ctx.close(); }

console.log('\n— the release is stamped —');
{ const app=fs.readFileSync(ROOT+'/app.js','utf8'), sw=fs.readFileSync(ROOT+'/sw.js','utf8');
  const v=app.match(/APP_VERSION='v(\d+)'/)[1], c=sw.match(/CACHE_NAME = 'staylog-v(\d+)'/)[1];
  ok('app version and service worker cache move together', v===c, {app:v,sw:c}); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
