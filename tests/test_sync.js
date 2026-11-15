/* Phase 2: the per-row sync engine (sync.js), against a stand-in for the
   `stay` schema that follows stay.apply_change's rules exactly (columns read
   from supabase/stay/01-schema.sql, a write lands only on its base version,
   new ids refused when taken, bookings never soft-deleted, version + 1 on
   every change). Two devices run side by side, each in its own window.

   Checks: dormant until switched over; mappers lossless (unknown fields to
   legacy, ID photos never sent); two devices on different rows both kept;
   different fields of one row both kept; the same field → conflict, server
   wins, mine kept to Reapply, money flagged; offline edits queue and go up on
   reconnect; a new device pulls everything; nothing deleted by absence;
   deletions explicit, more than 5 wait for Sync now; a deleted row edited
   elsewhere comes back; typing during a sync is not lost; receipts through the
   server; the calendar import makes bookings and stamps events. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const clone = x => JSON.parse(JSON.stringify(x));

// ── columns per table, from the schema itself ─────────────────────────────
const schema = fs.readFileSync(path.join(ROOT, 'supabase/stay/01-schema.sql'), 'utf8');
const COLS = {}, NOTNULL = {}, DEFAULTS = {};
for (const m of schema.matchAll(/create table if not exists stay\.(\w+) \(([\s\S]*?)\n\);/g)) {
  const t = m[1]; COLS[t] = []; NOTNULL[t] = []; DEFAULTS[t] = {};
  for (const line of m[2].split('\n')) {
    for (const part of line.split(/,\s*(?=[a-z_]+ (?:uuid|text|integer|numeric|boolean|date|time|timestamptz|jsonb|text\[\]))/)) {
      const c = part.trim().match(/^([a-z_]+)\s+(uuid|text\[\]|text|integer|numeric|boolean|date|timestamptz|time|jsonb)\b(.*)$/);
      if (!c || ['primary', 'foreign', 'unique', 'check'].includes(c[1])) continue;
      COLS[t].push(c[1]);
      if (/not null/.test(c[3])) NOTNULL[t].push(c[1]);
      const d = c[3].match(/default ('[^']*'(?:::\w+)?|true|false|-?\d+(?:\.\d+)?|now\(\))/);
      if (d) DEFAULTS[t][c[1]] = d[1] === 'true' ? true : d[1] === 'false' ? false : /^-?\d/.test(d[1]) ? Number(d[1])
        : d[1] === 'now()' ? undefined : d[1].replace(/::\w+$/, '') === "'{}'" ? (c[2] === 'jsonb' ? {} : []) : d[1].replace(/::\w+$/, '').slice(1, -1);
    }
  }
}
// later scripts' added columns on top (07-staff.sql: works_at, …)
for (const f of fs.readdirSync(path.join(ROOT, 'supabase/stay')).filter(f => /^0[4-9]-.*\.sql$/.test(f)).sort())
  for (const m of fs.readFileSync(path.join(ROOT, 'supabase/stay', f), 'utf8').matchAll(/alter table stay\.(\w+) add column if not exists (\w+) ([a-z]+(?:\[\])?)([^;]*);/g)) {
    if (!COLS[m[1]] || COLS[m[1]].includes(m[2])) continue;
    COLS[m[1]].push(m[2]);
    if (/not null/.test(m[4])) NOTNULL[m[1]].push(m[2]);
    const d = m[4].match(/default ('\{\}'|true|false|-?\d+)/);
    if (d) DEFAULTS[m[1]][m[2]] = d[1] === "'{}'" ? [] : d[1] === 'true' ? true : d[1] === 'false' ? false : Number(d[1]);
  }
// 04-phase2.sql's changes on top
for (const m of fs.readFileSync(path.join(ROOT, 'supabase/stay/04-phase2.sql'), 'utf8').matchAll(/alter table stay\.(\w+) alter column (\w+) drop not null/g))
  NOTNULL[m[1]] = NOTNULL[m[1]].filter(c => c !== m[2]);
ok('schema read: every synced table has its columns', ['properties', 'staff', 'loans', 'bookings', 'expenses', 'loan_repayments']
  .every(t => COLS[t] && COLS[t].includes('version') && COLS[t].includes('legacy')), Object.keys(COLS));

// ── the stand-in server ───────────────────────────────────────────────────
function Server() {
  const S = { t: {}, clock: Date.parse('2026-11-15T04:00:00Z'), calls: [], down: false, receipts: 0, events: [], stamps: [], heartbeats: [] };
  for (const t of Object.keys(COLS)) S.t[t] = new Map();
  S.now = () => new Date(S.clock += 1000).toISOString();
  S.check = (table, row) => {
    for (const k of Object.keys(row)) if (!COLS[table].includes(k)) throw new Error(`column "${k}" of relation "${table}" does not exist`);
  };
  S.apply = (table, row, base) => {
    S.calls.push({ table, row: clone(row), base });
    S.check(table, row);
    const key = row.id, cur = S.t[table].get(key);
    if (base === null) {
      if (cur) return { status: 'conflict', server: clone(cur) };
      const r = {};
      for (const c of COLS[table]) r[c] = DEFAULTS[table][c] !== undefined ? clone(DEFAULTS[table][c]) : null;
      for (const [k, v] of Object.entries(row)) if (!['created_at', 'updated_at', 'updated_by', 'version'].includes(k)) r[k] = clone(v);
      for (const c of NOTNULL[table]) if (r[c] === null && !['created_at', 'updated_at', 'version'].includes(c))
        throw new Error(`null value in column "${c}" of relation "${table}" violates not-null constraint`);
      r.version = 1; r.created_at = r.updated_at = S.now();
      S.t[table].set(key, r);
      return { status: 'ok', row: clone(r) };
    }
    if (!cur) return { status: 'missing' };
    if (cur.version !== base) return { status: 'conflict', server: clone(cur) };
    const cols = Object.keys(row).filter(k => !['account_id', 'id', 'created_at', 'updated_at', 'updated_by', 'version'].includes(k));
    if (!cols.length) return { status: 'ok', row: clone(cur) };
    if (table === 'bookings' && row.deleted_at) throw new Error('Bookings are cancelled, never deleted');
    for (const c of cols) { if (row[c] === null && NOTNULL[table].includes(c)) throw new Error(`null value in column "${c}" violates not-null constraint`); cur[c] = clone(row[c]); }
    cur.version++; cur.updated_at = S.now();
    return { status: 'ok', row: clone(cur) };
  };
  // Someone else (another device, a trigger) writes directly.
  S.write = (table, id, fields) => {
    const cur = S.t[table].get(id); Object.assign(cur, clone(fields)); cur.version++; cur.updated_at = S.now(); return cur;
  };
  return S;
}

function client(S, who) {
  const query = (table) => {
    const q = { f: [], gt: null, from: 0, to: 1e9, op: 'select', val: null };
    const run = () => {
      if (S.down) return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
      if (table === 'ical_events') {
        if (q.op === 'update') { S.stamps.push({ ...Object.fromEntries(q.f), ...q.val });
          const e = S.events.find(e => q.f.every(([k, v]) => e[k] === v)); if (e) Object.assign(e, q.val);
          return Promise.resolve({ data: null, error: null }); }
        return Promise.resolve({ data: clone(S.events.filter(e => q.f.every(([k, v]) => e[k] === v))), error: null });
      }
      if (table === 'sync_status') { S.heartbeats.push({ who, ...q.val }); return Promise.resolve({ data: null, error: null }); }
      let rows = [...S.t[table].values()].filter(r => q.f.every(([k, v]) => r[k] === v) && (!q.gt || r.updated_at > q.gt));
      rows.sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
      return Promise.resolve({ data: clone(rows.slice(q.from, q.to + 1)), error: null });
    };
    const api = {
      select() { return api; }, eq(k, v) { q.f.push([k, v]); return api; }, gt(k, v) { q.gt = v; return api; },
      order() { return api; }, range(a, b) { q.from = a; q.to = b; return api; },
      update(v) { q.op = 'update'; q.val = v; return api; }, upsert(v) { q.op = 'upsert'; q.val = v; return api; },
      then(res, rej) { return run().then(res, rej); },
    };
    return api;
  };
  return { schema: () => ({
    from: query,
    async rpc(name, args) {
      if (S.down) return { data: null, error: { message: 'Failed to fetch' } };
      try {
        if (name === 'apply_change') return { data: S.apply(args.p_table, args.p_row, args.p_base_version), error: null };
        if (name === 'issue_receipt') {
          const b = S.t.bookings.get(args.p_booking);
          if (!b) return { data: null, error: { message: 'No such booking' } };
          if (!b.receipt_no) { b.receipt_no = 'RV/2026-27/' + String(++S.receipts).padStart(3, '0'); b.receipt_on = '2026-11-15'; b.version++; b.updated_at = S.now(); }
          return { data: b.receipt_no, error: null };
        }
      } catch (e) { return { data: null, error: { message: e.message } }; }
      throw new Error('rpc ' + name);
    } }) };
}

// A device: its own window, localStorage, IndexedDB and app data.
function Device(S, name, opts) {
  opts = opts || {};
  const ls = new Map(), idbStore = opts.idb || new Map();
  const req = (fn) => { const r = {}; setTimeout(() => { try { r.result = fn(); r.onsuccess && r.onsuccess(); } catch (e) { r.error = e; r.onerror && r.onerror(); } }, 0); return r; };
  const indexedDB = { open() { const r = {}; setTimeout(() => {
    r.result = { objectStoreNames: { contains: () => true }, transaction: () => ({ objectStore: () => ({
      get: k => req(() => clone(idbStore.get(k) ?? undefined)), put: (v, k) => req(() => { idbStore.set(k, clone(v)); }) }) }) };
    r.onsuccess({ target: r }); }, 0); return r; } };
  const win = { listeners: {} };
  const ctx = {
    window: win, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, JSON, Date, Object, Array, Set, Map, Promise, String, Number, Math, Error, isNaN,
    localStorage: { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
    indexedDB, navigator: { onLine: true, userAgent: name === 'B' ? 'iPad' : 'iPhone' }, document: { hidden: false, addEventListener() {} },
    crypto: { randomUUID: () => 'dev-' + name },
  };
  win.addEventListener = () => {};
  ctx.addEventListener = () => {};
  vm.createContext(ctx);
  Object.assign(ctx.window, ctx);   // `window.x` and bare `x` are the same thing, as in a browser
  const d = { name, data: clone(opts.data || { properties: [], bookings: [], expenses: [], staff: [], loans: [] }), replaced: 0, signedIn: true, asked: [] };
  win.STAYLOG_GET_DATA = () => d.data;
  win.STAYLOG_REPLACE_DATA = x => { d.data = x; d.replaced++; };
  win.STAYLOG_CONFIRM_TOMBSTONE = ({ message }) => { d.asked.push(message); return d.answer !== undefined ? d.answer : true; };
  win.STAYLOG_TODAY = () => '2026-11-15';
  win.STAYLOG_APP_VERSION = '61';
  win.StayLogCloud = { status: () => ({ signedIn: d.signedIn, userId: 'u1' }), client: async () => client(S, name),
    _planIcal: opts.planIcal };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8'), ctx);
  d.ctx = ctx; d.ls = ls; d.idb = idbStore;
  d.sync = win.StayLogSync;
  d.on = () => d.sync.activate('u1', 'acct-1');
  d.run = async (o) => { await d.sync.sync(o); };
  d.edit = fn => { fn(d.data); };
  d.offline = v => { ctx.navigator.onLine = !v; };
  return d;
}
const ACC = 'acct-1';
const prop = { id: 'p1', name: 'Raaya Vasyam', location: 'Kaup', rooms: 3, pricePerNight: 4000, description: '', mapsLink: '',
  arrivalInstructions: '', wifiName: '', wifiPassword: '', upiId: '', upiPayee: '', upiQr: '', bankDetails: '', signature: '', signatureRatio: '' };
const booking = (id, extra) => ({ id, propertyId: 'p1', guestName: 'Asha Rao', phone: '9876543210', checkIn: '2026-11-20', checkOut: '2026-11-22',
  guests: 2, totalAmount: 8000, paid: 2000, source: 'Direct', status: 'confirmed', notes: '', idProofType: 'Aadhaar',
  idProofNumber: '1234 5678 9012', idProofImage: 'data:image/jpeg;base64,AAAA', msgSent: {}, roundOff: 0, ...(extra || {}) });

(async () => {
  console.log('\nDormant until switched over');
  {
    const S = Server(), a = Device(S, 'A', { data: { properties: [prop], bookings: [booking('b1')], expenses: [], staff: [], loans: [] } });
    ok('not active without staylog_model', a.sync.isActive() === false);
    await a.run(); a.sync.save();
    ok('a sync while dormant sends and reads nothing', S.calls.length === 0 && a.replaced === 0);
    a.ls.set('staylog_model', JSON.stringify({ mode: 'old' }));
    ok('a staylog_model that is not {mode:"stay", user, account} keeps it dormant', a.sync.isActive() === false);
    ok('nothing written to the old keys', ![...a.ls.keys()].some(k => /staylog_v2|staylog_main/.test(k)) && a.idb.size === 0);
  }

  console.log('\nMappers: lossless, ID photos stay on the phone');
  {
    const S = Server(), a = Device(S, 'A');
    const T = a.sync;
    const b = booking('b1', { futureField: { x: 1 }, checkIn: '2026-11-20', receiptOn: 'someday', totalAmount: '8000', icalMovedFrom: { checkIn: '2026-11-18', checkOut: '2026-11-20' } });
    const row = T._toRow('bookings', b, ACC);
    ok('every column it writes exists in stay.bookings', Object.keys(row).every(k => COLS.bookings.includes(k)), Object.keys(row).filter(k => !COLS.bookings.includes(k)));
    ok('ID photo is not in the row, nor in legacy', !JSON.stringify(row).includes('base64'));
    ok('an unknown field goes to legacy', row.legacy && row.legacy.futureField && row.legacy.futureField.x === 1);
    ok('a value the column cannot hold is kept in legacy.$orig', row.legacy.$orig.receiptOn === 'someday' && row.receipt_on === null);
    ok('a number typed as text is stored as a number, its spelling kept', row.total_amount === 8000 && row.legacy.$orig.totalAmount === '8000');
    const back = T._fromRow('bookings', row, { idProofImage: b.idProofImage });
    const want = clone(b);
    ok('round trip gives back exactly what was there (photo from the phone)', JSON.stringify(Object.keys(want).sort().map(k => [k, want[k]])) ===
      JSON.stringify(Object.keys(want).sort().map(k => [k, back[k]])), Object.keys(want).filter(k => JSON.stringify(want[k]) !== JSON.stringify(back[k])));
    const moved = clone(row); moved.total_amount = 9000;
    ok('once another device changes the column, its value wins over the old spelling', T._fromRow('bookings', moved, null).totalAmount === 9000);
    for (const t of ['properties', 'staff', 'loans', 'expenses', 'loan_repayments']) {
      const cols = T.SPEC[t].map(s => s[1]).filter(c => !COLS[t].includes(c));
      ok(`${t}: every mapped column exists in the schema`, !cols.length, cols);
    }
    const loan = { id: 'l1', staffId: 's1', principal: 10000, installmentAmount: 1000, disbursedOn: '2026-10-01', firstDueDate: '2026-11-01', status: 'active',
      notes: '', propertyId: 'p1', repayments: [{ id: 'r1', date: '2026-11-01', amount: 1000, mode: 'payout', note: '', expenseId: 'e1' }] };
    const flat = T._flatten({ loans: [loan] }, ACC);
    ok('loan repayments are their own rows, linked to their loan', flat['loan_repayments:r1'] && flat['loan_repayments:r1'].loan_id === 'l1' && !('repayments' in flat['loans:l1']));
    ok('a loan with no staff member maps (staff_id null)', T._toRow('loans', { ...loan, staffId: '' }, ACC).staff_id === null);
  }

  console.log('\nTwo devices, different rows: both kept');
  const start = () => {
    const S = Server();
    const seed = { properties: [prop], bookings: [booking('b1')], expenses: [], staff: [{ id: 's1', name: 'Lakshmi', role: 'House help', phone: '', dailyWage: 500, checkoutWage: 700, utensilRate: 100, active: true, joinedOn: '2025-04-01', monthlySalary: '' }], loans: [] };
    const a = Device(S, 'A', { data: seed }), b = Device(S, 'B');
    a.on(); b.on();
    return { S, a, b };
  };
  {
    const { S, a, b } = start();
    await a.run();
    ok('first sync sends every row of the phone', S.t.bookings.size === 1 && S.t.properties.size === 1 && S.t.staff.size === 1);
    ok('ID photo never reached the server', !JSON.stringify([...S.t.bookings.values()]).includes('base64'));
    await b.run();
    ok('a new device pulls everything', b.data.bookings.length === 1 && b.data.bookings[0].guestName === 'Asha Rao' && b.data.properties[0].name === 'Raaya Vasyam');
    ok('…without the ID photo (it stays on the phone that took it)', !b.data.bookings[0].idProofImage);
    a.edit(d => d.bookings.push(booking('b2', { guestName: 'Ravi', checkIn: '2026-12-01', checkOut: '2026-12-03', idProofImage: '' })));
    b.edit(d => d.expenses.push({ id: 'e1', propertyId: 'p1', description: 'Gas cylinder', amount: 1100, date: '2026-11-15', category: 'utilities', paid: true, notes: '' }));
    await a.run(); await b.run(); await a.run();
    ok('A has B\'s expense', a.data.expenses.some(e => e.id === 'e1' && e.amount === 1100));
    ok('B has A\'s booking', b.data.bookings.some(x => x.id === 'b2' && x.guestName === 'Ravi'));
    ok('A kept its ID photo through the merges', a.data.bookings.find(x => x.id === 'b1').idProofImage === 'data:image/jpeg;base64,AAAA');
    const calls = S.calls.length; await a.run(); await b.run();
    ok('nothing changed → nothing sent', S.calls.length === calls, S.calls.slice(calls));
    ok('outbox empty on both', a.sync.status().outbox === 0 && b.sync.status().outbox === 0, [a.sync.status().outbox, b.sync.status().outbox]);
    ok('each device reports itself', S.heartbeats.some(h => h.who === 'A' && h.device_id === 'dev-A' && h.app_version === '61' && h.outbox === 0));
  }

  console.log('\nSame row, different fields: both kept');
  {
    const { S, a, b } = start();
    await a.run(); await b.run();
    a.edit(d => { d.bookings[0].notes = 'Late arrival, 10 pm'; });
    b.edit(d => { d.bookings[0].guests = 3; });
    await a.run(); await b.run(); await a.run();
    const srvB = S.t.bookings.get('b1');
    ok('the server has both edits', srvB.notes === 'Late arrival, 10 pm' && srvB.guests === 3, srvB);
    ok('both devices have both edits', a.data.bookings[0].guests === 3 && b.data.bookings[0].notes === 'Late arrival, 10 pm');
    ok('no conflict reported', !a.sync.status().conflicts.length && !b.sync.status().conflicts.length);
    ok('only the changed field went up', S.calls.some(c => c.table === 'bookings' && Object.keys(c.row).sort().join() === 'account_id,id,notes'));
  }

  console.log('\nSame field: conflict, server wins, mine kept to Reapply');
  {
    const { S, a, b } = start();
    await a.run(); await b.run();
    a.edit(d => { d.bookings[0].paid = 8000; });
    b.edit(d => { d.bookings[0].paid = 5000; d.bookings[0].notes = 'Paid by UPI'; });
    await a.run(); await b.run();
    const c = b.sync.status().conflicts;
    ok('B is told: the payment changed on another device', c.length === 1 && c[0].table === 'bookings' && c[0].id === 'b1' && c[0].fields.join() === 'paid', c);
    ok('it is flagged as money', c[0] && c[0].money === true);
    ok('mine and theirs are both kept', c[0] && c[0].mine.paid === 5000 && c[0].theirs.paid === 8000);
    ok('the server value stands (no blind overwrite)', S.t.bookings.get('b1').paid === 8000 && b.data.bookings[0].paid === 8000);
    ok('B\'s other field still went up', S.t.bookings.get('b1').notes === 'Paid by UPI');
    b.sync.reapply('bookings', 'b1'); await b.run(); await b.run();
    ok('Reapply puts mine on the server', S.t.bookings.get('b1').paid === 5000 && !b.sync.status().conflicts.length, S.t.bookings.get('b1').paid);
    await a.run();
    ok('…and A gets it', a.data.bookings[0].paid === 5000);
  }

  console.log('\nOffline: edits queue, go up on reconnect');
  {
    const { S, a, b } = start();
    await a.run(); await b.run();
    a.offline(true);
    a.edit(d => { d.bookings[0].status = 'checkedin'; d.expenses.push({ id: 'e9', propertyId: '', description: 'Tea', amount: 60, date: '2026-11-15', category: 'supplies', paid: true, notes: '' }); });
    await a.run();
    ok('offline: nothing sent', S.t.bookings.get('b1').status === 'confirmed' && !S.t.expenses.has('e9'));
    a.offline(false); await a.run(); await b.run();
    ok('reconnected: both went up', S.t.bookings.get('b1').status === 'checkedin' && S.t.expenses.get('e9').amount === 60);
    ok('a Shared expense keeps property_id null', S.t.expenses.get('e9').property_id === null);
    ok('B has them', b.data.bookings[0].status === 'checkedin' && b.data.expenses.some(e => e.id === 'e9'));
    S.down = true; a.edit(d => { d.bookings[0].guests = 4; }); await a.run();
    ok('server unreachable: a plain message, nothing lost', /Can.t reach the server/.test(a.sync.status().lastError) && a.sync.status().outbox === 1 && a.data.bookings[0].guests === 4);
    S.down = false; await a.run();
    ok('next sync sends it', S.t.bookings.get('b1').guests === 4 && !a.sync.status().lastError);
  }

  console.log('\nNo deleting by absence; deletions explicit and braked');
  {
    const { S, a, b } = start();
    a.edit(d => { for (let i = 0; i < 8; i++) d.expenses.push({ id: 'x' + i, propertyId: 'p1', description: 'Item ' + i, amount: 10 + i, date: '2026-11-1' + (i % 9), category: 'other', paid: true, notes: '' }); });
    await a.run();
    const fresh = Device(S, 'C'); fresh.on();
    ok('a device with an empty copy deletes nothing', (await fresh.run(), [...S.t.expenses.values()].every(e => !e.deleted_at)) && fresh.data.expenses.length === 8);
    a.edit(d => { d.expenses = d.expenses.filter(e => e.id !== 'x0'); });
    await a.run();
    ok('one deletion here → soft-deleted on the server', S.t.expenses.get('x0').deleted_at && S.t.expenses.size === 8);
    await b.run();
    ok('…and gone from the other device', !b.data.expenses.some(e => e.id === 'x0') && b.data.expenses.length === 7);
    a.edit(d => { d.expenses = d.expenses.filter(e => e.id === 'x1'); });
    await a.run();
    ok('more than 5 at once: a background sync deletes nothing and does not ask', [...S.t.expenses.values()].filter(e => e.deleted_at).length === 1 && !a.asked.length);
    ok('…held, and shown', a.sync.status().held === 6);
    a.answer = false; await a.run({ manual: true });
    ok('Sync now asks, naming the count; "No" deletes nothing', a.asked.length === 1 && /6 records/.test(a.asked[0]) && [...S.t.expenses.values()].filter(e => e.deleted_at).length === 1);
    a.answer = true; await a.run({ manual: true });
    ok('"Yes" soft-deletes them', [...S.t.expenses.values()].filter(e => e.deleted_at).length === 7 && a.sync.status().held === 0);
    a.edit(d => { d.bookings = []; }); await a.run();
    ok('a booking is never deleted, even if the phone loses it', !S.t.bookings.get('b1').deleted_at);
  }

  console.log('\nDeleted here, edited elsewhere: the edit is kept');
  {
    const { S, a, b } = start();
    a.edit(d => d.expenses.push({ id: 'e1', propertyId: 'p1', description: 'Plumber', amount: 800, date: '2026-11-14', category: 'maintenance', paid: false, notes: '' }));
    await a.run(); await b.run();
    b.edit(d => { d.expenses[0].amount = 850; }); await b.run();
    a.edit(d => { d.expenses = []; }); await a.run();
    ok('the row is not deleted', !S.t.expenses.get('e1').deleted_at);
    ok('it comes back on this device with the other edit', a.data.expenses.some(e => e.id === 'e1' && e.amount === 850));
    ok('and the person is told', a.sync.status().conflicts.some(c => c.why === 'deleted'));
  }

  console.log('\nTyping during a sync is not lost');
  {
    const { S, a, b } = start();
    await a.run(); await b.run();
    b.edit(d => { d.bookings[0].notes = 'From B'; }); await b.run();
    const orig = S.apply;
    S.apply = (...x) => { a.data.bookings[0].guests = 5; return orig(...x); };   // typed while A pushes
    a.edit(d => { d.bookings[0].phone = '9000000000'; });
    await a.run(); S.apply = orig;
    ok('the typed value stays on the phone', a.data.bookings[0].guests === 5);
    await a.run();
    const r = S.t.bookings.get('b1');
    ok('and goes up next time, with everything else', r.guests === 5 && r.phone === '9000000000' && r.notes === 'From B', r);
    ok('no false conflict', !a.sync.status().conflicts.length, a.sync.status().conflicts);
  }

  console.log('\nServer-made rows and changes arrive');
  {
    const { S, a } = start();
    await a.run();
    // Her mark became a wage line on the server (stay.process_mark).
    S.t.expenses.set('wag_s1_20261115', { account_id: ACC, id: 'wag_s1_20261115', property_id: 'p1', date: '2026-11-15', category: 'staff',
      description: 'Wage — Lakshmi · 15 Nov', amount: 500, paid: false, paid_on: null, notes: null, staff_id: 's1', loan_id: null, loan_deduction: null,
      gross_amount: null, auto_amount: 500, wage_kind: 'daily', source_mark_id: 'att_s1_20261115', created_at: S.now(), updated_at: S.now(),
      updated_by: null, version: 1, deleted_at: null, legacy: null });
    await a.run();
    const w = a.data.expenses.find(e => e.id === 'wag_s1_20261115');
    ok('a wage line made on the server appears', w && w.amount === 500 && w.wageKind === 'daily' && w.staffId === 's1');
    ok('…and is not sent back', !S.calls.some(c => c.row.id === 'wag_s1_20261115'));
    S.write('expenses', 'wag_s1_20261115', { deleted_at: S.now() });   // her undo
    await a.run();
    ok('her undo removes it from the phone', !a.data.expenses.some(e => e.id === 'wag_s1_20261115'));
  }

  console.log('\nLoans and repayments');
  {
    const { S, a, b } = start();
    a.edit(d => { d.loans.push({ id: 'l1', staffId: 's1', principal: 10000, installmentAmount: 1000, disbursedOn: '2026-10-01', firstDueDate: '2026-11-01',
      status: 'active', notes: '', repayments: [{ id: 'r1', date: '2026-11-01', amount: 1000, mode: 'direct', note: '' }] });
      d.loans.push({ id: 'l2', staffId: '', principal: 50000, installmentAmount: 5000, disbursedOn: '2026-09-01', firstDueDate: '2026-10-01', status: 'active', notes: 'Bank', repayments: [] }); });
    await a.run(); await b.run();
    ok('loans and repayments reach the other device', b.data.loans.length === 2 && b.data.loans.find(l => l.id === 'l1').repayments[0].amount === 1000);
    b.edit(d => d.loans.find(l => l.id === 'l1').repayments.push({ id: 'r2', date: '2026-11-15', amount: 1000, mode: 'direct', note: '' }));
    await b.run(); await a.run();
    ok('a repayment added on B appears under its loan on A', a.data.loans.find(l => l.id === 'l1').repayments.length === 2);
    ok('the loan with no staff member synced', S.t.loans.get('l2').staff_id === null);
  }

  console.log('\nReceipts come from the server');
  {
    const { S, a, b } = start();
    await a.run(); await b.run();
    const [r1, r2] = await Promise.all([a.sync.issueReceipt('b1'), b.sync.issueReceipt('b1')]);
    ok('one number per booking, whoever asks', r1.receiptNo === 'RV/2026-27/001' && r2.receiptNo === r1.receiptNo, [r1, r2]);
    await a.run();
    ok('the number arrives with the booking', a.data.bookings[0].receiptNo === 'RV/2026-27/001');
  }

  console.log('\nCalendar import over the new tables');
  {
    const cloudSrc = fs.readFileSync(path.join(ROOT, 'cloud.js'), 'utf8');
    const cctx = { window: {}, console, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { onLine: true }, document: { addEventListener() {}, hidden: false }, addEventListener() {} };
    cctx.window.addEventListener = () => {}; cctx.window.StayLogCloudConfig = {};
    vm.createContext(cctx); Object.assign(cctx.window, cctx);
    let planIcal = null;
    try { vm.runInContext(cloudSrc, cctx); planIcal = cctx.window.StayLogCloud._planIcal; } catch (e) { console.log('   (cloud.js did not load: ' + e.message + ')'); }
    ok('planIcal from cloud.js', typeof planIcal === 'function');
    const S = Server();
    const a = Device(S, 'A', { data: { properties: [prop], bookings: [], expenses: [], staff: [], loans: [] }, planIcal }); a.on();
    S.events.push({ account_id: ACC, feed_id: 'f1', uid: 'abc@airbnb', property_id: 'p1', platform: 'Airbnb', start_date: '2026-12-10', end_date: '2026-12-12',
      summary: 'Reserved', description: '', kind: 'reserved', gone_at: null, imported_booking_id: null });
    await a.run();
    const imp = a.data.bookings.find(b => /^ics_/.test(b.id));
    ok('a new stay becomes a booking on the phone', imp && imp.checkIn === '2026-12-10' && imp.source === 'Airbnb');
    ok('…and on the server', imp && S.t.bookings.has(imp.id));
    ok('the event is stamped once the booking is there', S.events[0].imported_booking_id === (imp && imp.id));
    const n = S.t.bookings.size; await a.run();
    ok('a second sync imports nothing again', S.t.bookings.size === n && a.data.bookings.length === 1);
  }

  console.log('\nState is per login and account, and survives a restart');
  {
    const { S, a } = start();
    await a.run();
    const idb = a.idb;
    ok('kept under user:account', idb.has('u1:acct-1'));
    const a2 = Device(S, 'A', { idb, data: a.data }); a2.on();
    const calls = S.calls.length; await a2.run();
    ok('after a restart nothing is re-sent', S.calls.length === calls);
    a2.ctx.window.StayLogCloud.status = () => ({ signedIn: true, userId: 'someone-else' });
    a2.edit(d => { d.bookings[0].guests = 9; }); await a2.run();
    ok('signed in as another user: nothing sent, and it says so', S.t.bookings.get('b1').guests === 2 && /someone else/.test(a2.sync.status().lastError));
  }

  console.log('\nOn a real Postgres: every mapped row is taken by stay.apply_change and comes back the same');
  if (!process.env.STAYLOG_PG) console.log('   (STAYLOG_PG not set — skipped)');
  else {
    const { execFileSync } = require('child_process');
    const CONN = process.env.STAYLOG_PG.split(/\s+/).filter(Boolean), DBN = 'staylog_sync_test';
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
      create table public.owners (user_id uuid primary key);`);
    for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql']) {
      const x = psql(DBN, ['-c', 'set client_min_messages=warning', '-f', path.join(ROOT, 'supabase/stay', f)]); if (x.err) r = x;
    }
    ok('stay schema 01 → 04 loads', !r.err, r.err);
    const AC = '11111111-1111-1111-1111-111111111111';
    psql(DBN, ['-c', `insert into stay.accounts (id, name, code) values ('${AC}', 'Raaya Vasyam', 'raaya')`]);
    const T = Device(Server(), 'Z').sync;
    const items = {
      properties: [{ ...prop, checkinTime: '13:00', checkoutTime: '11:00', houseRules: ['No smoking'], rentedAsWholeUnit: true, futureFlag: 1 }],
      staff: [{ id: 's1', name: 'Lakshmi', role: 'House help', phone: '', dailyWage: 500, checkoutWage: 700, utensilRate: 100, active: true, joinedOn: '2025-04-01', monthlySalary: '' }],
      loans: [{ id: 'l1', staffId: 's1', principal: 10000, installmentAmount: 1000, disbursedOn: '2026-10-01', firstDueDate: '2026-11-01', status: 'active', notes: '', writtenOffOn: '' },
              { id: 'l2', staffId: '', principal: 50000, installmentAmount: '', disbursedOn: '2026-09-01', firstDueDate: '', status: 'active', notes: 'Bank', propertyId: 'p1' }],
      bookings: [booking('b1', { msgSent: { arrival: '2026-11-19' }, gapClosed: { Airbnb: '2026-11-20|2026-11-22' }, icalMovedFrom: { checkIn: '2026-11-18', checkOut: '2026-11-20' },
                   receiptNo: 'RV/2026-27/004', receiptOn: '2026-11-15', roundOff: 2.47, roundOffHand: true, paid: 2000.5, importedOn: '' }),
                 booking('b2', { totalAmount: '', paid: '', guests: '', source: '', roundOff: '', msgSent: undefined })],
      expenses: [{ id: 'e1', propertyId: '', description: 'Gas', amount: 1100.25, date: '2026-11-15', category: 'utilities', paid: true, notes: '' },
                 { id: 'wag_s1_20261115', propertyId: 'p1', description: 'Wage — Lakshmi · 15 Nov', amount: 700, date: '2026-11-15', category: 'staff', paid: false,
                   staffId: 's1', autoAmount: 700, wageKind: 'checkout', fromAttendance: true, loanId: 'l1', loanDeduction: 0, grossAmount: '' }],
      loan_repayments: [{ id: 'r1', loanId: 'l1', date: '2026-11-15', amount: 1000, mode: 'payout', note: '', expenseId: 'wag_s1_20261115' }],
    };
    for (const t of T.ORDER) for (const it of items[t]) {
      const mine = T._toRow(t, it, AC);
      const res = psql(DBN, ['-c', 'set client_min_messages=warning', '-c', `select stay.apply_change('${t}', $j$${JSON.stringify(mine)}$j$::jsonb, null)`]);
      const out = res.err ? null : JSON.parse(res.out.trim());
      ok(`${t} ${it.id}: taken`, out && out.status === 'ok', res.err || out);
      if (!out || out.status !== 'ok') continue;
      const back = T._formOf(t, out.row);
      ok(`${t} ${it.id}: comes back with no difference (no endless re-send)`, T._diff(back, mine).length === 0,
        T._diff(back, mine).map(c => [c, mine[c], back[c]]));
      const item = T._fromRow(t, out.row, it);
      const want = { ...it }; delete want.loanId; if (t === 'loans') want.repayments = [];
      for (const k of Object.keys(want)) if (want[k] === undefined) delete want[k];
      const lost = Object.keys(want).filter(k => JSON.stringify(want[k]) !== JSON.stringify(item[k]) &&
        !(want[k] === '' && (item[k] === 0 || item[k] === false)));
      ok(`${t} ${it.id}: the phone gets back what it had`, !lost.length, lost.map(k => [k, want[k], item[k]]));
    }
    const upd = psql(DBN, ['-c', `select stay.apply_change('bookings', $j${'$'}{"account_id":"${AC}","id":"b1","paid":8000}$j${'$'}::jsonb, 1)`]);
    ok('a field-only update lands on its version', /"status": ?"ok"/.test(upd.out) && /"paid": ?8000/.test(upd.out), upd.err || upd.out);
    if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DBN}`]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
