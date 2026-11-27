/* v76: the day a wage was paid (expenses.paidOn), wherever paid wages appear.
   - Expenses list: "Paid on 20 Nov" for a paid wage or utensil line;
     "unpaid"; "Paid · date not recorded" for one paid before v64; other
     expenses keep "paid"; Mark as paid / Mark unpaid set and clear it
   - Expense form: Paid on shown when Paid is ticked, today or the stored
     day, editable; it re-dates the loan repayment from that payout (same
     id); Unpaid clears it; an old undated line stays undated; no future day
   - Pay sheet: Paid on, today unless changed, used for every line and the
     loan deduction
   - Reports: "Wages paid this month" by the day paid; totals by expense date
   - CSV: a Paid On column */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const srv = http.createServer((q, r) => { const p = path.join(ROOT, (q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'text/plain' }); r.end(fs.readFileSync(p)); }).listen(0);
const STUB = `window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  from(){const api={select(){return api;},eq(){return api;},is(){return api;},not(){return api;},order(){return api;},limit(){return api;},
    update(){return api;},async upsert(){return{error:null};},then(res){return Promise.resolve(res({data:[],error:null}));}};return api;}})};`;

// Dates around the real today, so "this month" and "this year" hold whenever it runs.
const D = n => { const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const TODAY = D(0), Y = new Date().getFullYear(), M = new Date().getMonth();
const firstOfMonth = `${Y}-${String(M + 1).padStart(2, '0')}-01`;
const lastMonthDay = (() => { const d = new Date(Y, M, 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const short = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const w = (id, date, o = {}) => ({ id, staffId: 'stf1', category: 'staff', propertyId: 'p1', description: 'Wage — Lakshmi Walikar', date,
  amount: 500, grossAmount: 500, loanId: '', loanDeduction: 0, paid: false, ...o });
const SEED = () => ({
  properties: [{ id: 'p1', name: 'Raaya Vasyam' }],
  staff: [{ id: 'stf1', name: 'Lakshmi Walikar', dailyWage: 500, active: true }],
  loans: [{ id: 'L1', staffId: 'stf1', propertyId: 'p1', principal: 5000, installmentAmount: 500, disbursedOn: `${Y - 1}-12-01`, firstDueDate: `${Y}-01-01`,
    status: 'active', notes: '', repayments: [{ id: 'rep-1', date: lastMonthDay, amount: 100, mode: 'payout', expenseId: 'wLoan', note: 'Deducted' }] }],
  bookings: [], attendance: [],
  expenses: [
    w('wPaid', lastMonthDay, { paid: true, paidOn: firstOfMonth }),                 // worked last month, paid this month
    w('ute_stf1_x', lastMonthDay, { description: 'Utensil cleaning — Lakshmi Walikar', amount: 100, grossAmount: 100, paid: true, paidOn: firstOfMonth }),
    w('wOld', `${Y}-01-05`, { paid: true }),                                           // paid before v64: no payday
    w('wUnpaid', D(-1)),
    w('wUnpaid2', D(-2)),
    w('wLoan', lastMonthDay, { amount: 400, grossAmount: 500, loanId: 'L1', loanDeduction: 100, paid: true, paidOn: lastMonthDay }),
    { id: 'elec', category: 'utilities', propertyId: 'p1', description: 'Electricity', date: D(-3), amount: 900, paid: true, paidOn: D(-3) },
  ] });

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  const open = async () => {
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    for (const g of ['**://*.supabase.co/**', '**fonts.googleapis.com**', '**cdn.jsdelivr.net**']) await ctx.route(g, r => r.abort());
    await ctx.route('**vendor/supabase.umd.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    const page = await ctx.newPage(); const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    await page.addInitScript(s => { if (!sessionStorage.getItem('__s')) { sessionStorage.setItem('__s', '1'); localStorage.setItem('staylog_v2', JSON.stringify(s)); } }, SEED());
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    await page.evaluate(() => { state.loggedIn = true; setState({ tab: 'expenses' }); });
    await page.waitForTimeout(250);
    return { ctx, page, errs, dialogs };
  };
  const exp = (page, id) => page.evaluate(id => JSON.parse(JSON.stringify(state.data.expenses.find(e => e.id === id) || null)), id);
  const reps = page => page.evaluate(() => JSON.parse(JSON.stringify(state.data.loans[0].repayments)));
  const label = (page, id) => page.locator(`[data-paid-label="${id}"]`).innerText().catch(() => '');
  const editForm = async (page, id) => { await page.evaluate(id => setState({ modal: 'addExpense', editItem: state.data.expenses.find(e => e.id === id) }), id); await page.waitForTimeout(200); };
  const save = page => page.click('button:has-text("Update Expense")');
  const paidOnBox = page => page.locator('[data-paid-on]');

  console.log('\n— the Expenses list —');
  { const { ctx, page, errs } = await open();
    ok(`a paid wage: "Paid on ${short(firstOfMonth)}"`, await label(page, 'wPaid') === `Paid on ${short(firstOfMonth)}`, await label(page, 'wPaid'));
    ok('a paid utensil line too', await label(page, 'ute_stf1_x') === `Paid on ${short(firstOfMonth)}`);
    ok('an unpaid one: "unpaid"', await label(page, 'wUnpaid') === 'unpaid');
    ok('paid before v64: "Paid · date not recorded" (no date invented)', await label(page, 'wOld') === 'Paid · date not recorded');
    ok('another expense keeps "paid"', await label(page, 'elec') === 'paid');
    await page.evaluate(() => setState({ expandedExpense: 'wUnpaid' })); await page.waitForTimeout(150);
    await page.click('button:has-text("Mark as paid")'); await page.waitForTimeout(200);
    ok('Mark as paid: paid today, and the list says so', (await exp(page, 'wUnpaid')).paidOn === TODAY && await label(page, 'wUnpaid') === `Paid on ${short(TODAY)}`);
    await page.click('button:has-text("Mark unpaid")'); await page.waitForTimeout(200);
    ok('Mark unpaid: the payday is cleared', (await exp(page, 'wUnpaid')).paidOn === '' && (await exp(page, 'wUnpaid')).paid === false && await label(page, 'wUnpaid') === 'unpaid');
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— the expense form —');
  { const { ctx, page, errs, dialogs } = await open();
    await editForm(page, 'wUnpaid');
    ok('unpaid: no Paid on field', !(await paidOnBox(page).isVisible()));
    await page.click('button:has-text("Paid")'); await page.waitForTimeout(100);
    ok('Paid ticked: Paid on shown, today', await paidOnBox(page).isVisible() && await paidOnBox(page).inputValue() === TODAY);
    await paidOnBox(page).fill(D(-5)); await save(page); await page.waitForTimeout(200);
    ok('a wage paid on another day: that day is saved', (await exp(page, 'wUnpaid')).paidOn === D(-5) && (await exp(page, 'wUnpaid')).paid === true);
    ok('…and shown in the list', await label(page, 'wUnpaid') === `Paid on ${short(D(-5))}`);

    await editForm(page, 'wLoan');
    ok('a paid payout: Paid on prefilled with its payday', await paidOnBox(page).inputValue() === lastMonthDay);
    await paidOnBox(page).fill(D(-2)); await save(page); await page.waitForTimeout(200);
    let r = await reps(page);
    ok('changing it moves the loan repayment\'s date (same repayment, same amount)', r.length === 1 && r[0].id === 'rep-1' && r[0].date === D(-2)
      && Number(r[0].amount) === 100 && (await exp(page, 'wLoan')).paidOn === D(-2), r);

    await editForm(page, 'wLoan');
    await page.click('button:has-text("Unpaid")'); await page.waitForTimeout(100);
    ok('Unpaid: the field goes', !(await paidOnBox(page).isVisible()));
    await save(page); await page.waitForTimeout(200);
    ok('…and saving clears the payday (the loan is not credited until paid again)', (await exp(page, 'wLoan')).paidOn === '' && (await reps(page)).length === 0);

    await editForm(page, 'wOld');
    ok('an old paid line: Paid on blank, with a note that it was not recorded', await paidOnBox(page).inputValue() === ''
      && await page.locator('[data-paid-on-note]').isVisible());
    await save(page); await page.waitForTimeout(200);
    ok('…saved untouched, it stays undated (nothing invented)', !(await exp(page, 'wOld')).paidOn && (await exp(page, 'wOld')).paid === true, await exp(page, 'wOld'));

    await editForm(page, 'wUnpaid2');
    await page.click('button:has-text("Paid")'); await page.waitForTimeout(100);
    await paidOnBox(page).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }, D(3));
    await save(page); await page.waitForTimeout(200);
    ok('a day in the future is refused', dialogs.some(d => /cannot be in the future/.test(d)) && (await exp(page, 'wUnpaid2')).paid === false);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— the Pay sheet —');
  { const { ctx, page, errs, dialogs } = await open();
    await page.evaluate(() => { state.modal = 'settleWages'; state.editItem = state.data.staff[0]; render(); }); await page.waitForTimeout(300);
    ok('Paid on: today unless changed', await page.locator('[data-pay-on]').inputValue() === TODAY);
    await page.locator('[data-pay-on]').fill(D(-1));
    await page.locator('[data-loan-toggle]').click(); await page.waitForTimeout(100);
    await page.locator('[data-loan-amt]').fill('200');
    await page.locator('button', { hasText: /^Mark .* as paid$/ }).click(); await page.waitForTimeout(300);
    ok('the confirmation names the day', dialogs.some(d => d.includes(' on ') && d.includes('as paid to Lakshmi Walikar')), dialogs);
    const a = await exp(page, 'wUnpaid'), b = await exp(page, 'wUnpaid2');
    ok('every line marked paid carries that day', a.paid && b.paid && a.paidOn === D(-1) && b.paidOn === D(-1), { a, b });
    const r = (await reps(page)).filter(x => x.expenseId === 'wUnpaid' || x.expenseId === 'wUnpaid2');
    ok('…and so does the loan deduction', r.length >= 1 && r.every(x => x.date === D(-1)) && Math.round(r.reduce((t, x) => t + Number(x.amount), 0)) === 200, r);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— Reports and the CSV —');
  { const { ctx, page, errs } = await open();
    await page.evaluate((m) => setState({ tab: 'reports', reportMonth: m }), { year: Y, month: M }); await page.waitForTimeout(250);
    const card = await page.locator('[data-wages-paid]').innerText().catch(() => '');
    ok('"Wages paid this month", by the day paid: last month\'s work paid this month counts (₹500 + ₹100)',
      /Wages paid this month/i.test(card) && await page.locator('[data-wages-paid-amount]').innerText() === '₹600', card);
    ok('…old undated lines are said to be left out, not guessed', /no payday recorded/.test(card), card);
    const totals = await page.evaluate(() => [...document.querySelectorAll('.card')].map(c => c.innerText.trim()).find(t => /^Expenses\n/i.test(t)) || '');
    const want = SEED().expenses.filter(e => e.date.startsWith(firstOfMonth.slice(0, 7))).reduce((t, e) => t + e.amount, 0);
    ok('the Expenses total stays by expense date (this month\'s expense dates only)', totals.split('\n').pop() === '₹' + want.toLocaleString('en-IN'), { totals, want });
    const csv = await page.evaluate(() => new Promise(res => {
      const real = URL.createObjectURL; URL.createObjectURL = b => { b.text().then(res); return real.call(URL, b); };
      downloadReport(state.data.bookings, state.data.expenses, 'test'); }));
    const head = csv.split('\n').find(l => l.startsWith('Date,Description'));
    ok('the CSV has a Paid On column', /Status,Paid On,Notes/.test(head), head);
    const wp = csv.split('\n').find(l => l.includes(lastMonthDay) && l.includes('"Paid"') && l.includes(firstOfMonth));
    ok('…with the payday of a paid line', !!wp, csv.slice(0, 600));
    const wo = csv.split('\n').find(l => l.startsWith(`"${Y}-01-05"`));
    ok('…and blank for one paid before v64', wo && /"Paid",""/.test(wo), wo);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
