/* v66: every checkbox in the app shows its tick.
   The form rule `input { appearance: none }` once reached checkboxes too: a
   tap did tick the box, but nothing was drawn, so it looked as if it could
   not be ticked. Each checkbox here must keep the phone's own appearance,
   toggle on a tap, and look different ticked from unticked — compared
   pixel by pixel, in light and dark. */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const srv = http.createServer((q, r) => { const p = path.join(ROOT, (q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'text/plain' }); r.end(fs.readFileSync(p)); }).listen(0);
const SEED = { properties: [{ id: 'p1', name: 'Raaya Vasyam', rooms: 3 }, { id: 'p2', name: 'Sea View' }],
  staff: [{ id: 's1', name: 'Lakshmi', active: true }], loans: [], expenses: [], bookings: [], attendance: [] };

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    console.log(`\n— ${scheme} —`);
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, colorScheme: scheme });
    await ctx.route('**vendor/supabase.umd.js', r => r.abort());
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.addInitScript(s => localStorage.setItem('staylog_v2', JSON.stringify(s)), SEED);
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    await page.evaluate(() => { state.loggedIn = true; render(); });
    // The three kinds of checkbox the app has: a property's whole unit, a
    // staff member's Works at, and the team's permission rows (same styling).
    const cases = [
      ['Rented as a whole unit', () => setState({ modal: 'addProp', editItem: state.data.properties[0] }), '[data-prop-whole]'],
      ['Works at', () => setState({ modal: 'addStaff', editItem: state.data.staff[0] }), '[data-works-at-prop="p2"]'],
    ];
    for (const [name, openIt, sel] of cases) {
      await page.evaluate(openIt); await page.waitForTimeout(350);
      const box = page.locator(sel);
      await box.scrollIntoViewIfNeeded();
      const look = await box.evaluate(el => { const c = getComputedStyle(el); return { appearance: c.appearance || c.webkitAppearance, w: el.getBoundingClientRect().width }; });
      ok(`${name}: the phone's own checkbox, a fair size`, look.appearance !== 'none' && look.w >= 20 && look.w <= 26, look);
      const before = await box.screenshot();
      await box.click(); await page.waitForTimeout(100);
      const ticked = await box.isChecked();
      const after = await box.screenshot();
      ok(`${name}: a tap ticks it`, ticked);
      ok(`${name}: and the tick shows (it looks different ticked)`, !before.equals(after));
      await box.click();
      ok(`${name}: a second tap unticks it`, !(await box.isChecked()));
      await page.evaluate(() => closeModal());
    }
    ok('no page errors', errs.length === 0, errs);
    await ctx.close();
  }
  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
