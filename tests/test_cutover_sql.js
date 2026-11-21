/* Phase 3 on a real Postgres: moving in (stay/05-migrate.sql), the switch and
   its undo (stay/rollback-cutover.sql), beside the old tables.
     - only the old owner can open the account and move rows into it; twice is
       the same account; a re-run replaces (the phone wins) and prunes, never a
       booking; parents gone long ago become deleted placeholders; a repayment
       whose expense is gone keeps the link in legacy
     - "Copy and compare" brings what only the cloud has (her login and marks,
       calendar links and events, devices, preferences, inbox with read state,
       encrypted backups) and makes no wage line
     - the switch: refuses without a recent copy; makes the lines for marks the
       phone had not; old tables read-only for the app; her page's functions
       by the same names now over `stay` (old ones kept as *_v58, not callable);
       model 'stay', min_version 62; twice = already; no more migrate_rows
     - her page after the switch: mark / undo / mark again on `stay`; the old
       attendance table untouched
     - the rollback: functions and grants back as they were, her marks since
       the switch copied back, model 'public'; twice is fine; switching again
       works
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_cutover_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_cutover_test';
const psql = (db, args, input) => { try { return { out: execFileSync('psql', [...CONN, '-d', db, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args],
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; } };
const sql = s => psql(DB, ['-c', 'set client_min_messages=warning;' + s]);
const v = s => sql(s).out.trim();
const OWNER = '11111111-1111-1111-1111-111111111111', HER = '22222222-2222-2222-2222-222222222222', X = '44444444-4444-4444-4444-444444444444';
const as = (uid, q) => psql(DB, ['-c', `set client_min_messages=warning; begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
const asv = (uid, q) => { const r = as(uid, q); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const J = s => { try { return JSON.parse(String(s).split('\n').pop()); } catch { return null; } };
const T = `(now() at time zone 'Asia/Kolkata')::date`;
const ymd = psql('postgres', ['-c', `select to_char(${T}, 'YYYYMMDD')`]).out.trim();   // before this test's database exists

psql('postgres', ['-c', `drop database if exists ${DB}`]);
psql('postgres', ['-c', `create database ${DB}`]);
let r = psql(DB, [], `
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  grant usage on schema public, auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  insert into auth.users(id, email) values ('${OWNER}','owner@example.com'),('${HER}','laxmi@staff.example'),('${X}','x@example.com');`);
ok('Supabase stand-ins are in place', !r.err, r.err);
for (const f of ['setup.sql', 'attendance.sql', 'checkout-wage.sql', 'utensils.sql', 'ical.sql', 'ical-connected.sql', 'push.sql', 'inbox.sql', 'backups.sql']) {
  r = psql(DB, ['-c', 'set client_min_messages=warning', '-f', F(f)]); ok('old ' + f + ' loads', !r.err, r.err);
}
sql(`insert into public.owners (user_id) values ('${OWNER}')`);
r = psql(DB, ['-c', 'set client_min_messages=warning', '-f', F('security-v60.sql')]); ok('old security-v60.sql loads', !r.err, r.err);
r = sql(`insert into public.properties (id,owner_id,name) values ('p1','${OWNER}','Raaya Vasyam');
  insert into public.staff (id,owner_id,name,daily_wage) values ('stf1','${OWNER}','Laxmi Walikar',300);
  insert into public.staff_access (user_id,owner_id,staff_id,display_name) values ('${HER}','${OWNER}','stf1','Laxmi');
  insert into public.attendance (id,owner_id,staff_id,date,expense_id) values ('att_stf1_20261101','${OWNER}','stf1','2026-11-01','wag_stf1_20261101');
  insert into public.attendance (id,owner_id,staff_id,date,expense_id) values ('att_stf1_20261102','${OWNER}','stf1','2026-11-02','wag_stf1_20261102');
  insert into public.attendance (id,owner_id,staff_id,date,marked_at) values ('att_stf1_${ymd}','${OWNER}','stf1',${T},now());
  insert into public.ical_feeds (id,owner_id,property_id,platform,url,connected,last_ok_at) values ('aaaaaaaa-0000-0000-0000-000000000001','${OWNER}','p1','Airbnb','https://example.invalid/feed.ics',true,now());
  insert into public.ical_events (feed_id,uid,owner_id,property_id,platform,start_date,end_date,kind,imported_booking_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001','u1@airbnb','${OWNER}','p1','Airbnb',${T}+5,${T}+7,'reserved','ics_abc');
  insert into public.push_subscriptions (endpoint,owner_id,p256dh,auth,device) values ('https://push.example/1','${OWNER}','k','a','iPhone');
  insert into public.notification_prefs (owner_id,prefs) values ('${OWNER}','{"stale":false}');
  insert into public.push_log (owner_id,key,title,body,url,alert,delivered,read_at) values ('${OWNER}','arrival:b1:x','Guest arriving tomorrow','2 guests','./#open=b1','arrivals',true,now());
  insert into public.backups (owner_id,ciphertext,salt,iv,iterations,app_version,size) values ('${OWNER}','CIPHER','SALT','IV',600000,'v61',6);`);
ok('the old tables seeded (a stamped mark whose line is on the phone, one deleted on purpose, one from today not yet made)', !r.err, r.err);
for (const f of ['stay/01-schema.sql', 'stay/02-functions.sql', 'stay/03-access.sql', 'stay/04-phase2.sql', 'stay/05-migrate.sql', 'stay/05-migrate.sql', 'stay/07-staff.sql', 'stay/08-team.sql', 'stay/09-calendar.sql', 'stay/10-onboarding.sql', 'stay/11-legal.sql']) {
  r = psql(DB, ['-c', 'set client_min_messages=warning', '-f', F(f)]); ok(f + ' loads', !r.err, r.err);
}
const check = psql(DB, ['-F', '|', '-f', F('stay/check.sql')]).out.trim().split('\n').filter(Boolean);
ok('check.sql: every row ok', check.every(l => /\|ok/.test(l)), check.filter(l => !/\|ok/.test(l)));
const oldBefore = () => v(`select md5(string_agg(t,'|' order by t)) from (
  select row_to_json(x)::text t from public.attendance x union all select row_to_json(x)::text from public.staff x
  union all select row_to_json(x)::text from public.properties x union all select row_to_json(x)::text from public.ical_events x) s`);
const before = oldBefore();

console.log('\n— the account —');
ok('a stranger cannot open one', /Only the owner/.test(asv(X, `select stay.migration_account('Mine','mine')`)));
const ACC = asv(OWNER, `select stay.migration_account('Raaya Vasyam','Raaya!')`);
ok('the owner opens one (code from the name)', /^[0-9a-f-]{36}$/.test(ACC) && v(`select code from stay.accounts where id='${ACC}'`) === 'raaya', ACC);
ok('twice is the same account', asv(OWNER, `select stay.migration_account('Other','x')`) === ACC);
ok('the owner is its owner', v(`select role from stay.members where account_id='${ACC}' and user_id='${OWNER}'`) === 'owner');

console.log('\n— the phone\'s rows —');
const rows = (t, list) => asv(OWNER, `select stay.migrate_rows('${ACC}', '${t}', $j$${JSON.stringify(list)}$j$::jsonb)`);
ok('a stranger cannot write into it', /Not your account/.test(asv(X, `select stay.migrate_rows('${ACC}','properties','[]')`)));
let res = J(rows('properties', [{ id: 'p1', name: 'Raaya Vasyam', wifi_name: 'RV', legacy: { colour: 'green' } }]));
ok('properties', res && res.written === 1, res);
J(rows('staff', [{ id: 'stf1', name: 'Laxmi Walikar', daily_wage: 300, active: true }]));
res = J(rows('loans', [{ id: 'l1', staff_id: 'stf1', principal: 5000, status: 'active' }, { id: 'l2', staff_id: null, principal: 90000, status: 'active', notes: 'Bank' }]));
ok('loans (one with no staff member)', res && res.written === 2, res);
res = J(rows('bookings', [{ id: 'b1', property_id: 'p1', guest_name: 'Anita Rao', check_in: '2026-11-20', check_out: '2026-11-22', status: 'confirmed', total_amount: 6000, paid: 2000 },
  { id: 'b0', property_id: 'p_gone', guest_name: 'Old guest', check_in: '2025-01-01', check_out: '2025-01-02', status: 'checkedout', total_amount: 1000, paid: 1000 }]));
ok('bookings; a property gone long ago becomes a deleted placeholder', res && res.written === 2 && res.placeholders.length === 1
  && v(`select name || '|' || (deleted_at is not null) from stay.properties where account_id='${ACC}' and id='p_gone'`) === '(removed property)|true', res);
res = J(rows('expenses', [{ id: 'wag_stf1_20261101', property_id: 'p1', date: '2026-11-01', category: 'staff', amount: 300, staff_id: 'stf1', paid: false, auto_amount: 300, wage_kind: 'daily' },
  { id: 'e2', property_id: null, date: '2026-11-03', category: 'staff', amount: 500, staff_id: 's_gone', paid: true },
  { id: 'e3', property_id: null, date: '2026-11-04', category: 'utilities', amount: 1100, paid: true }]));
ok('expenses (a Shared one; a staff member gone long ago → placeholder)', res && res.written === 3 && res.placeholders.some(p => p.kind === 'staff'), res);
res = J(rows('loan_repayments', [{ id: 'r1', loan_id: 'l1', amount: 1000, mode: 'payout', expense_id: 'e_gone' }]));
ok('a repayment whose expense is gone keeps the link in legacy', res && res.written === 1
  && v(`select coalesce(expense_id,'null') || '|' || (legacy->>'orphan_expense_id') from stay.loan_repayments where account_id='${ACC}' and id='r1'`) === 'null|e_gone', res);
ok('no wage line or re-pricing ran while moving in', v(`select count(*) from stay.expenses where account_id='${ACC}' and source_mark_id is not null`) === '0');
rows('bookings', [{ id: 'b1', property_id: 'p1', guest_name: 'Anita Rao', check_in: '2026-11-20', check_out: '2026-11-22', status: 'confirmed', total_amount: 6000, paid: 6000 }]);
ok('a re-run replaces: the phone wins', v(`select paid from stay.bookings where account_id='${ACC}' and id='b1'`) === '6000');
const pruned = asv(OWNER, `select stay.migrate_prune('${ACC}','expenses',array['wag_stf1_20261101','e3'])`);
ok('a re-run without a row soft-deletes it', pruned === '1' && v(`select deleted_at is not null from stay.expenses where account_id='${ACC}' and id='e2'`) === 't', pruned);
ok('bookings are never pruned', asv(OWNER, `select stay.migrate_prune('${ACC}','bookings',array[]::text[])`) === '0'
  && v(`select count(*) from stay.bookings where account_id='${ACC}' and deleted_at is null`) === '2');
asv(OWNER, `select stay.migrate_prune('${ACC}','expenses',array['wag_stf1_20261101','e2','e3'])`);
ok('carried again, it comes back', v(`select deleted_at is null from stay.expenses where account_id='${ACC}' and id='e2'`) === 't');

console.log('\n— what only the cloud has —');
ok('a switch before any copy is refused', /Copy and compare/.test(asv(OWNER, `select stay.cutover('${ACC}')`)));
res = J(asv(OWNER, `select stay.migrate_copy('${ACC}')`));
ok('copied', res && res.attendance === 3 && res.staff_logins === 1 && res.ical_feeds === 1 && res.ical_events === 1
  && res.push_subscriptions === 1 && res.notification_prefs === 1 && res.push_log === 1 && res.backups === 1, res);
ok('her login: by her username, her staff record', v(`select username || '|' || staff_id from stay.staff_logins where user_id='${HER}'`) === 'laxmi|stf1');
ok('her marks as they were, stamps included', v(`select string_agg(id || ':' || coalesce(expense_id,'-'), ',' order by id) from stay.attendance where account_id='${ACC}'`)
  === `att_stf1_20261101:wag_stf1_20261101,att_stf1_20261102:wag_stf1_20261102,att_stf1_${ymd}:-`);
ok('…and no wage line made before the switch', v(`select count(*) from stay.expenses where account_id='${ACC}' and id='wag_stf1_${ymd}'`) === '0');
ok('the calendar link kept "connected"; the event its stamp', v(`select connected from stay.ical_feeds where account_id='${ACC}'`) === 't'
  && v(`select imported_booking_id from stay.ical_events where account_id='${ACC}'`) === 'ics_abc');
ok('the inbox keeps what was read', v(`select read_at is not null from stay.push_log where account_id='${ACC}' and recipient='${OWNER}'`) === 't');
ok('her page still works the old way', J(asv(HER, `select public.staff_standing()`)) !== null);
ok('the old tables are untouched', oldBefore() === before);

console.log('\n— the switch —');
ok('a stranger cannot switch', /Not your account/.test(asv(X, `select stay.cutover('${ACC}')`)));
res = J(asv(OWNER, `select stay.cutover('${ACC}')`));
ok('the owner switches', res && res.status === 'ok', res);
ok('the mark the phone had not made became a wage line', v(`select amount || '|' || source_mark_id from stay.expenses where account_id='${ACC}' and id='wag_stf1_${ymd}'`) === `300|att_stf1_${ymd}`);
ok('a mark whose line was deleted on purpose stays without one', v(`select count(*) from stay.expenses where account_id='${ACC}' and id='wag_stf1_20261102'`) === '0');
ok('model stay, min_version 62', v(`select model || '|' || min_version || '|' || (account_id = '${ACC}') from public.app_status`) === 'stay|62|true');
ok('the old tables are read-only for the app', /permission denied/.test(asv(OWNER, `insert into public.properties (id,owner_id,name) values ('p9','${OWNER}','New')`))
  && /permission denied/.test(asv(OWNER, `update public.bookings set guests = 3`)));
ok('…and still readable', !/ERR/.test(asv(OWNER, `select count(*) from public.properties`)));
ok('her functions keep their names, now over stay', /stay\.staff_standing/.test(v(`select prosrc from pg_proc where proname='staff_standing' and pronamespace='public'::regnamespace`)));
ok('the old ones are kept as *_v58, not callable by her', v(`select count(*) from pg_proc where proname like 'staff_%_v58' or proname = 'staff_standing_v58'`) >= '5'
  && /permission denied/.test(asv(HER, `select public.staff_mark_today_v58()`)));
const st = J(asv(HER, `select public.staff_standing()`));
ok('her page reads stay: today\'s line pending', st && JSON.stringify(st).includes(`${v(`select ${T}`)}`), st);
let m = J(asv(HER, `select public.staff_unmark_today()`));
ok('her undo works on stay (line soft-deleted, flagged)', m && v(`select deleted_at is not null from stay.attendance where account_id='${ACC}' and id='att_stf1_${ymd}'`) === 't'
  && v(`select legacy->>'undone' from stay.expenses where account_id='${ACC}' and id='wag_stf1_${ymd}'`) === 'true', m);
m = J(asv(HER, `select public.staff_mark_today()`));
ok('marking again brings the same line back', v(`select deleted_at is null from stay.expenses where account_id='${ACC}' and id='wag_stf1_${ymd}'`) === 't', m);
ok('the old attendance table did not change', v(`select deleted_at is null from public.attendance where id='att_stf1_${ymd}'`) === 't'
  && v(`select count(*) from public.attendance`) === '3');
ok('twice: already', J(asv(OWNER, `select stay.cutover('${ACC}')`)).status === 'already');
ok('no more moving rows in once switched', /Already switched/.test(asv(OWNER, `select stay.migrate_rows('${ACC}','properties','[]')`)));
const check2 = psql(DB, ['-F', '|', '-f', F('stay/check.sql')]).out.trim().split('\n').filter(Boolean);
ok('check.sql still all ok after the switch', check2.every(l => /\|ok/.test(l)), check2.filter(l => !/\|ok/.test(l)));

console.log('\n— a mark after the switch, then the rollback —');
sql(`set stay.importing='on'; update stay.attendance set deleted_at=null, expense_id='wag_stf1_20261105' where false;
     insert into stay.attendance (account_id,id,staff_id,date) values ('${ACC}','att_stf1_20261105','stf1','2026-11-05')`);
r = psql(DB, ['-c', 'set client_min_messages=warning', '-f', F('stay/rollback-cutover.sql')]);
ok('rollback runs', !r.err, r.err);
ok('model public; min_version stays 62', v(`select model || '|' || min_version from public.app_status`) === 'public|62');
ok('her functions are the old ones again', !/stay\./.test(v(`select prosrc from pg_proc where proname='staff_standing' and pronamespace='public'::regnamespace`))
  && v(`select count(*) from pg_proc where proname like '%_v58'`) === '0');
ok('her page works the old way', J(asv(HER, `select public.staff_standing()`)) !== null);
ok('the app can write the old tables again', !/ERR/.test(asv(OWNER, `update public.bookings set guests = guests where false`))
  && !/ERR/.test(asv(OWNER, `insert into public.properties (id,owner_id,name) values ('p9','${OWNER}','New')`)));
ok('the inbox column grant came back (read_at only)', /permission denied/.test(asv(OWNER, `update public.push_log set title='x'`))
  && !/ERR/.test(asv(OWNER, `update public.push_log set read_at=now() where false`)));
ok('her mark made since the switch is copied back', v(`select count(*) from public.attendance where id='att_stf1_20261105'`) === '1');
r = psql(DB, ['-c', 'set client_min_messages=warning', '-f', F('stay/rollback-cutover.sql')]);
ok('rollback twice is fine', !r.err, r.err);
ok('nothing in stay was deleted', v(`select count(*) from stay.bookings where account_id='${ACC}'`) === '2');

console.log('\n— switching again —');
asv(OWNER, `select stay.migrate_copy('${ACC}')`);
res = J(asv(OWNER, `select stay.cutover('${ACC}')`));
ok('works', res && res.status === 'ok' && v(`select model from public.app_status`) === 'stay', res);
r = psql(DB, ['-c', 'set client_min_messages=warning', '-f', F('stay/rollback-cutover.sql')]);
ok('and rolls back again', !r.err && v(`select model from public.app_status`) === 'public', r.err);

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
