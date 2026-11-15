/* Phase 4 (v63): properties as data.
   - Raaya Vasyam's texts left the code: the house rules, house notes, welcome
     lines ("Enjoy Udupi"), the check-in / check-out times. With them carried
     into the property (06-property-texts.sql), every guest message is exactly
     as before (the one deliberate change: "payable before check-out").
   - a property without them gets neutral wording, and its own times
   - the property form keeps them as they are when not touched, and edits them
   - a receipt series per property, unique
   - occupancy counts a whole-unit property as full with one booking
   - the property picker remembers its choice; a notification switches to its property
   - Shared expenses: a choice in the form, labelled in lists, a filter of
     their own, kept out of one property's figures
   - the house notes PDF asks which property
   - STAYLOG_PG: 06-property-texts.sql fills the texts word for word, twice is
     the same, and never overwrites what was typed in the app */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rv-texts.json'), 'utf8'));
const srv = http.createServer((q, r) => { const p = path.join(ROOT, (q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'text/plain' }); r.end(fs.readFileSync(p)); }).listen(0);
const D = n => { const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const RV = { id: 'p1', name: 'Raaya Vasyam', location: 'Kaup', mapsLink: 'https://maps.example/x', wifiName: 'RV-Home', wifiPassword: 'pass1234',
  arrivalInstructions: 'Ring the bell.', rooms: 3, checkinTime: '13:00', checkoutTime: '11:00',
  houseRules: FX.seed.houseRules, houseNotes: FX.seed.houseNotes, welcomeText: FX.seed.welcomeText };
const NEW = { id: 'p2', name: 'Sea View Cottage', location: 'Malpe', rooms: 2 };

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch();
  const open = async (data, o = {}) => {
    const ctx = o.ctx || await br.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    await ctx.route('**vendor/supabase.umd.js', r => r.abort());
    const page = await ctx.newPage(); const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    if (data) await page.addInitScript(d => { if (!sessionStorage.getItem('__s')) { sessionStorage.setItem('__s', '1'); localStorage.setItem('staylog_v2', JSON.stringify(d)); } }, data);
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    await page.evaluate(() => { state.loggedIn = true; render(); });
    return { ctx, page, errs, dialogs };
  };
  const data = (extra = {}) => ({ properties: [RV, NEW], bookings: [], expenses: [], staff: [], loans: [], attendance: [], ...extra });
  const B = { id: 'abcdef123456', propertyId: 'p1', guestName: 'Anita Rao', phone: '9876543210', checkIn: '2026-12-10', checkOut: '2026-12-12', guests: 2,
    totalAmount: 6000, paid: 2000, source: 'Direct', status: 'confirmed', msgSent: {} };

  console.log('\n— the texts left the code —');
  { const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const left = [...FX.houseRules.flat(), ...FX.houseNotes.flat().filter(t => t.length > 12), 'Enjoy Udupi', "'1:00 PM'", "'11:00 AM'"]
      .filter(t => app.includes(t));
    ok('no house rule, house note, "Enjoy Udupi" or fixed time in app.js', !left.length, left);
    ok('no "Raaya Vasyam" fallback left in the code', !/\|\|'Raaya[ -]Vasyam'/.test(app)); }

  console.log('\n— Raaya Vasyam\'s messages, word for word —');
  { const { ctx, page, errs } = await open(data());
    const got = await page.evaluate(b => { state.data.bookings.push(b);
      return { stayText: stayText(b), arrivalText: arrivalText(b), confirmText: whatsappText(b), departureText: departureText({ ...b, status: 'checkedin' }),
        rules: houseRulesOf(state.data.properties[0]), notes: houseNotesOf(state.data.properties[0]) }; }, B);
    ok('welcome & house info: exactly as before ("Enjoy Udupi")', got.stayText === FX.stayText, got.stayText);
    ok('directions & arrival: exactly as before (1:00 PM)', got.arrivalText === FX.arrivalText, got.arrivalText);
    ok('check-out reminder: exactly as before (11:00 AM)', got.departureText === FX.departureText, got.departureText);
    ok('confirmation: as before, but the balance is "payable before check-out"', got.confirmText === FX.confirmText.replace('(payable at check-in)', '(payable before check-out)')
      && /payable before check-out/.test(got.confirmText), got.confirmText);
    ok('the six house rules, as they were', JSON.stringify(got.rules) === JSON.stringify(FX.houseRules));
    ok('the house notes, as they were', JSON.stringify(got.notes) === JSON.stringify(FX.houseNotes));
    const pdfs = await page.evaluate(async b => { const r = {};
      for (const [k, f] of [['confirm', () => buildConfirmationPDF(b)], ['notes', () => buildHouseNotesPDF(state.data.properties[0])],
        ['notesNew', () => buildHouseNotesPDF(state.data.properties[1])]]) { try { const d = await f(); r[k] = d.internal.getNumberOfPages(); } catch (e) { r[k] = 'ERR ' + e.message; } }
      return r; }, B);
    ok('the confirmation and house notes PDFs build from property data', typeof pdfs.confirm === 'number' && typeof pdfs.notes === 'number' && typeof pdfs.notesNew === 'number', pdfs);
    ok('no page errors', errs.length === 0, errs);
    await ctx.close(); }

  console.log('\n— a property without them —');
  { const { ctx, page } = await open(data());
    const got = await page.evaluate(b => { const x = { ...b, propertyId: 'p2' };
      const p = state.data.properties[1]; p.checkinTime = '14:30'; p.checkoutTime = '10:00';
      return { stay: stayText(x), arr: arrivalText(x), dep: departureText({ ...x, status: 'checkedin' }), conf: whatsappText(x), rules: houseRulesOf(p), notes: houseNotesOf(p),
        def: checkinTime({}) + '|' + checkoutTime({}) }; }, B);
    ok('neutral welcome lines, nothing about Udupi or the old house', /Enjoy your stay\./.test(got.stay) && !/Udupi|10 PM|Footwear/.test(got.stay), got.stay);
    ok('neutral house rules', got.rules.length && !got.rules.some(([t]) => /10 PM|Shoes/.test(t)), got.rules);
    ok('no house notes until typed in', got.notes.length === 0);
    ok('its own times in every message', /after 2:30 PM/.test(got.arr) && /by 10:00 AM/.test(got.dep) && /from 2:30 PM/.test(got.conf) && /by 10:00 AM/.test(got.conf));
    ok('with none set: 1:00 PM and 11:00 AM', got.def === '1:00 PM|11:00 AM', got.def);
    await ctx.close(); }

  console.log('\n— the property form —');
  { const { ctx, page, dialogs } = await open(data());
    await page.evaluate(() => setState({ modal: 'addProp', editItem: state.data.properties[0] }));
    ok('it shows the times, whole unit, series and the texts', await page.locator('[data-prop-checkinTime]').inputValue() === '13:00'
      && await page.locator('[data-prop-rules]').count() === 1 && await page.locator('[data-prop-notes]').count() === 1 && await page.locator('[data-prop-welcome]').count() === 1);
    await page.click('text=Update Property');
    const after = await page.evaluate(() => state.data.properties[0]);
    ok('saved untouched: the texts are exactly as they were', JSON.stringify(after.houseRules) === JSON.stringify(RVR()) || JSON.stringify(after.houseRules) === JSON.stringify(FX_RULES()), after.houseRules);
    function RVR() { return FX.seed.houseRules; } function FX_RULES() { return FX.seed.houseRules; }
    ok('…notes and welcome too', after.houseNotes === FX.seed.houseNotes && after.welcomeText === FX.seed.welcomeText);
    await page.evaluate(() => setState({ modal: 'addProp', editItem: state.data.properties[0] }));
    await page.fill('[data-prop-rules]', 'No pets\nSorry, we cannot host pets.\n\nQuiet after 10\nPlease keep it down.');
    await page.fill('[data-prop-checkinTime]', '12:00');
    await page.click('[data-prop-whole]');
    await page.click('text=Update Property');
    const p = await page.evaluate(() => state.data.properties[0]);
    ok('edited rules are saved one per paragraph', JSON.stringify(p.houseRules) === JSON.stringify(['No pets\nSorry, we cannot host pets.', 'Quiet after 10\nPlease keep it down.']), p.houseRules);
    ok('…and used', await page.evaluate(() => JSON.stringify(houseRulesOf(state.data.properties[0]))) === JSON.stringify([['No pets', 'Sorry, we cannot host pets.'], ['Quiet after 10', 'Please keep it down.']]));
    ok('time and whole unit saved', p.checkinTime === '12:00' && p.rentedAsWholeUnit === true, p);

    console.log('\n— receipt series —');
    ok('by default the initials', await page.evaluate(() => receiptPrefix(state.data.properties[0]) + '|' + receiptPrefix(state.data.properties[1])) === 'RV|SVC');
    await page.evaluate(() => setState({ modal: 'addProp', editItem: state.data.properties[1] }));
    await page.fill('[data-prop-prefix]', 'rv');
    await page.click('text=Update Property');
    ok('another property\'s series is refused', dialogs.some(d => /already uses the receipt series RV/.test(d)) && await page.evaluate(() => !state.data.properties[1].receiptPrefix), dialogs);
    await page.fill('[data-prop-prefix]', 'sv2');
    await page.click('text=Update Property');
    ok('a series of its own is saved (capitals) and used', await page.evaluate(() => state.data.properties[1].receiptPrefix === 'SV2' && receiptPrefix(state.data.properties[1]) === 'SV2'));
    await ctx.close(); }

  console.log('\n— occupancy —');
  { const month = new Date(); const y = month.getFullYear(), m = month.getMonth();
    const days = new Date(y, m + 1, 0).getDate();
    const first = `${y}-${String(m + 1).padStart(2, '0')}-01`, mid = `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.floor(days / 2) + 1).padStart(2, '0')}`;
    const { ctx, page } = await open(data());
    const r = await page.evaluate(([a, b]) => {
      const bk = [{ id: 'x', propertyId: 'p1', checkIn: a, checkOut: b, status: 'confirmed' }];
      const now = new Date(), y = now.getFullYear(), m = now.getMonth(), days = new Date(y, m + 1, 0).getDate();
      const P = { ...state.data.properties[0], rooms: 3 };
      return [occupancyOf([P], bk, y, m, days), occupancyOf([{ ...P, rentedAsWholeUnit: true }], bk, y, m, days)]; }, [first, mid]);
    ok('a 3-room house booked half the month: 17% by rooms, 50% as a whole unit', r[1] === Math.round(Math.floor(days / 2) / days * 100) && r[0] === Math.round(Math.floor(days / 2) / days / 3 * 100), r);
    await ctx.close(); }

  console.log('\n— the property picker remembers —');
  { const ctx = await br.newContext({ serviceWorkers: 'block' });
    let { page } = await open(data(), { ctx });
    await page.evaluate(() => setState({ filterProp: 'p2' }));
    await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    ok('reopened: still on the property last chosen', await page.evaluate(() => state.filterProp) === 'p2');
    await page.evaluate(() => { localStorage.setItem('staylog_prop', 'gone'); });
    await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && !state._loading);
    ok('a property no longer there: All properties', await page.evaluate(() => state.filterProp) === 'all');
    await page.evaluate(b => { state.data.bookings.push({ ...b, propertyId: 'p2' }); state.loggedIn = true; state.filterProp = 'p1'; render(); takeOpen('#open=' + b.id + '&send=arrival'); }, B);
    await page.waitForTimeout(200);
    ok('opening a notification switches to its booking\'s property', await page.evaluate(() => state.filterProp) === 'p2');
    await ctx.close(); }

  console.log('\n— Shared expenses —');
  { const E = [{ id: 'e1', propertyId: 'p1', description: 'Plumber', amount: 800, date: D(0), category: 'maintenance', paid: true },
      { id: 'e2', propertyId: '', description: 'Accountant', amount: 1500, date: D(0), category: 'other', paid: true },
      { id: 'e3', propertyId: 'p2', description: 'Paint', amount: 900, date: D(0), category: 'maintenance', paid: true }];
    const { ctx, page } = await open(data({ expenses: E }));
    await page.evaluate(() => setState({ modal: 'addExpense', editItem: null }));
    ok('the form offers Shared, and with All properties a new one starts there', await page.locator('[data-exp-prop] option[value=""]').count() === 1
      && await page.locator('[data-exp-prop]').inputValue() === '');
    await page.evaluate(() => setState({ modal: null, filterProp: 'p1' }));
    await page.evaluate(() => setState({ modal: 'addExpense', editItem: null }));
    ok('with one property picked, a new expense starts on it', await page.locator('[data-exp-prop]').inputValue() === 'p1');
    await page.evaluate(() => setState({ modal: null, tab: 'expenses' })); await page.waitForTimeout(100);
    const list = await page.locator('[data-main]').innerText();
    ok('one property: its own and the Shared ones, labelled', /Plumber/.test(list) && /Accountant/.test(list) && /Shared/.test(list) && !/Paint/.test(list), list.slice(0, 400));
    ok('…saying Shared is not in its profit', /not counted in this property’s profit/.test(await page.locator('[data-shared-note]').innerText()));
    await page.click('[data-exp-shared="true"]'); await page.waitForTimeout(100);
    const only = await page.locator('[data-main]').innerText();
    ok('Shared only: just the Shared ones', /Accountant/.test(only) && !/Plumber/.test(only));
    await page.evaluate(() => setState({ tab: 'dashboard', expShared: false })); await page.waitForTimeout(100);
    ok('Home for one property leaves Shared out and says so', /Shared costs of ₹1,500 are not counted/.test(await page.locator('[data-dash-shared]').innerText()));
    await page.evaluate(() => setState({ tab: 'reports', reportMonth: null })); await page.waitForTimeout(100);
    ok('Reports for one property: Shared shown apart', /left out of this property/.test(await page.locator('[data-report-shared]').innerText()));
    await page.evaluate(() => setState({ filterProp: 'all' })); await page.waitForTimeout(100);
    ok('Reports for All: Shared in the totals, with its own line', /Includes ₹1,500/.test(await page.locator('[data-report-shared]').innerText())
      && /Shared costs/.test(await page.locator('[data-perf-shared]').innerText()));
    await ctx.close(); }

  console.log('\n— house notes PDF —');
  { const { ctx, page } = await open(data());
    await page.evaluate(() => setState({ filterProp: 'all', modal: 'menu' }));
    await page.locator('button', { hasText: 'House notes PDF' }).click();
    ok('with All properties, it asks which', await page.locator('[data-notes-pick]').count() === 1
      && /Sea View Cottage/.test(await page.locator('[data-notes-pick]').innerText()));
    await ctx.close(); }

  console.log('\n— 06-property-texts.sql —');
  if (!process.env.STAYLOG_PG) console.log('   (STAYLOG_PG not set — skipped)');
  else {
    const { execFileSync } = require('child_process');
    const CONN = process.env.STAYLOG_PG.split(/\s+/).filter(Boolean), DBN = 'staylog_props_test';
    const psql = (db, args, input) => { try { return { out: execFileSync('psql', [...CONN, '-d', db, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args],
      { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; } };
    psql('postgres', ['-c', `drop database if exists ${DBN}`]); psql('postgres', ['-c', `create database ${DBN}`]);
    let r = psql(DBN, [], `
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role; exception when duplicate_object then null; end $$;
      create schema auth; create table auth.users (id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
      create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
      create table public.owners (user_id uuid primary key);
      create table public.app_status (id int primary key default 1, min_version int not null default 0, message text, updated_at timestamptz default now());
      insert into public.app_status (id) values (1);`);
    for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql']) {
      const x = psql(DBN, ['-c', 'set client_min_messages=warning', '-f', path.join(ROOT, 'supabase/stay', f)]); if (x.err) r = x; }
    ok('stay 01 → 05 load', !r.err, r.err);
    const sql = s => psql(DBN, ['-c', 'set client_min_messages=warning;' + s]);
    sql(`insert into stay.accounts (id, name, code, migrated_from) values ('11111111-1111-1111-1111-111111111111','Raaya Vasyam','raaya','22222222-2222-2222-2222-222222222222');
      insert into stay.accounts (id, name, code) values ('33333333-3333-3333-3333-333333333333','Someone else','other');
      set stay.importing='on';
      insert into stay.properties (account_id, id, name) values ('11111111-1111-1111-1111-111111111111','p1','Raaya Vasyam'),
        ('11111111-1111-1111-1111-111111111111','p2','Annexe'), ('33333333-3333-3333-3333-333333333333','q1','Other house');
      update stay.properties set welcome_text = 'My own words' where id = 'p2';`);
    r = psql(DBN, ['-f', path.join(ROOT, 'supabase/stay/06-property-texts.sql')]);
    ok('06-property-texts.sql runs', !r.err, r.err);
    const row = id => JSON.parse(sql(`select row_to_json(x) from (select house_rules, house_notes, welcome_text, version from stay.properties where id = '${id}') x`).out.trim());
    const p1 = row('p1');
    ok('the six house rules, word for word', JSON.stringify(p1.house_rules) === JSON.stringify(FX.seed.houseRules), p1.house_rules);
    ok('the house notes, word for word', p1.house_notes === FX.seed.houseNotes);
    ok('the welcome lines, word for word ("Enjoy Udupi")', p1.welcome_text === FX.seed.welcomeText && /Enjoy Udupi\.$/.test(p1.welcome_text));
    ok('what was typed in the app is never overwritten', row('p2').welcome_text === 'My own words' && row('p2').house_notes === FX.seed.houseNotes);
    ok('another account is not touched', row('q1').house_notes === null);
    const v1 = row('p1').version;
    r = psql(DBN, ['-f', path.join(ROOT, 'supabase/stay/06-property-texts.sql')]);
    ok('twice is the same (no change, no new version)', !r.err && row('p1').version === v1, r.err);
    if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DBN}`]);
  }

  await br.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
