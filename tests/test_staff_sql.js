/* Phase 5 on a real Postgres: supabase/stay/07-staff.sql.
     - runs twice; "Works at" filled from staff_properties already there
     - works_at drives staff_properties (add, remove, a property not the
       account's refused as a whole) and with it her calendar and where a
       wage is charged
     - staff_profile: her name, the business and owner names, her properties
       with their times; nothing for a stranger
     - staff_mark_today_at: only at one of her properties; the line is charged
       there; an ordinary mark still works
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_staff_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/stay/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_staff_test';
const psql = (db, args, input) => { try { return { out: execFileSync('psql', [...CONN, '-d', db, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args],
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; } };
const sql = s => psql(DB, ['-c', 'set client_min_messages=warning;' + s]);
const v = s => sql(s).out.trim();
const ACC = '11111111-1111-1111-1111-111111111111', OWNER = 'aaaaaaaa-0000-0000-0000-00000000000a',
  HER = 'eeeeeeee-0000-0000-0000-00000000000e', HIM = 'dddddddd-0000-0000-0000-00000000000d', X = 'ffffffff-0000-0000-0000-00000000000f';
const as = (uid, q) => psql(DB, ['-c', `set client_min_messages=warning; begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
const asv = (uid, q) => { const r = as(uid, q); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const J = s => { try { return JSON.parse(String(s).split('\n').pop()); } catch { return null; } };
const T = `(now() at time zone 'Asia/Kolkata')::date`;

psql('postgres', ['-c', `drop database if exists ${DB}`]); psql('postgres', ['-c', `create database ${DB}`]);
let r = psql(DB, [], `
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  grant usage on schema public, auth to anon, authenticated;
  create table public.owners (user_id uuid primary key);
  create table public.app_status (id int primary key default 1, min_version int not null default 0, message text, updated_at timestamptz default now());
  insert into public.app_status (id) values (1);
  insert into auth.users (id) values ('${OWNER}'),('${HER}'),('${HIM}'),('${X}');`);
ok('stand-ins', !r.err, r.err);
for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql']) {
  r = psql(DB, ['-c', 'set client_min_messages=warning', '-f', F(f)]); if (r.err) break; }
ok('stay 01 → 05', !r.err, r.err);
r = sql(`set stay.importing='on';
  insert into stay.accounts (id, name, code, owner_name) values ('${ACC}', 'Raaya Vasyam', 'raaya', null);
  insert into stay.members (account_id, user_id, role, display_name) values ('${ACC}', '${OWNER}', 'owner', 'Rakshit');
  insert into stay.properties (account_id, id, name, checkin_time, checkout_time) values ('${ACC}','p1','Raaya Vasyam','13:00','11:00'),
    ('${ACC}','p2','Sea View Cottage','14:30','10:00'), ('${ACC}','p3','Old annexe','13:00','11:00');
  update stay.properties set deleted_at = now() where id = 'p3';
  insert into stay.staff (account_id, id, name, daily_wage) values ('${ACC}','s1','Lakshmi Walikar',500), ('${ACC}','s2','Ravi',400);
  insert into stay.staff_properties (account_id, staff_id, property_id) values ('${ACC}','s2','p2');
  insert into stay.staff_logins (user_id, account_id, staff_id, username, display_name) values ('${HER}','${ACC}','s1','laxmi','Lakshmi'),
    ('${HIM}','${ACC}','s2','ravi','Ravi');
  insert into stay.bookings (account_id, id, property_id, guest_name, check_in, check_out, guests) values
    ('${ACC}','b1','p1','Anita',${T}+1,${T}+3,2), ('${ACC}','b2','p2','Kiran',${T}+2,${T}+4,3);`);
ok('seeded: two live properties, one deleted; Ravi already at Sea View', !r.err, r.err);
for (const run of [1, 2]) { r = psql(DB, ['-c', 'set client_min_messages=warning', '-f', F('07-staff.sql')]); ok(`07-staff.sql (run ${run})`, !r.err, r.err); }

console.log('\n— Works at —');
ok('filled from what staff_properties already said', v(`select works_at::text from stay.staff where id='s2'`) === '{p2}');
ok('none set = empty', v(`select works_at::text from stay.staff where id='s1'`) === '{}');
let res = J(asv(OWNER, `select stay.apply_change('staff', '{"account_id":"${ACC}","id":"s1","works_at":["p1"]}'::jsonb, (select version from stay.staff where id='s1'))`));
ok('the app sets it through apply_change', res && res.status === 'ok', res);
ok('staff_properties follows', v(`select string_agg(property_id, ',' order by property_id) from stay.staff_properties where staff_id='s1'`) === 'p1');
ok('…(stay.staff_calendar: only p1 bookings)', asv(HER, `select string_agg(property, ',') from stay.staff_calendar()`) === 'Raaya Vasyam');
res = J(asv(OWNER, `select stay.apply_change('staff', '{"account_id":"${ACC}","id":"s1","works_at":["p1","nope"]}'::jsonb, (select version from stay.staff where id='s1'))`));
ok('a property not in the account is refused, nothing changed', (!res || res.status !== 'ok') && v(`select works_at::text from stay.staff where id='s1'`) === '{p1}', res);
sql(`update stay.staff set works_at = '{}' where id='s1'`);
ok('emptied: every property again', v(`select count(*) from stay.staff_properties where staff_id='s1'`) === '0'
  && asv(HER, `select string_agg(property, ',' order by property) from stay.staff_calendar()`) === 'Raaya Vasyam,Sea View Cottage');

console.log('\n— her profile —');
let p = J(asv(HER, `select stay.staff_profile()`));
ok('her name, the business, the owner (from the members when the account has none)', p && p.name === 'Lakshmi' && p.business === 'Raaya Vasyam' && p.owner === 'Rakshit', p);
ok('her properties: every live one when none set, with their times; not the deleted one', p && p.properties.map(x => x.id).join() === 'p1,p2'
  && p.properties[1].checkin === '2:30 PM' && p.properties[1].checkout === '10:00 AM' && p.properties[0].checkin === '1:00 PM', p && p.properties);
sql(`update stay.accounts set owner_name = 'Rakshit P' where id='${ACC}'`);
ok('the account\'s owner name wins when set', J(asv(HER, `select public.staff_profile()`)).owner === 'Rakshit P');
p = J(asv(HIM, `select public.staff_profile()`));
ok('Ravi works at Sea View only: that is all he sees', p && p.properties.map(x => x.id).join() === 'p2', p);
ok('no guests, no money in it', !/Anita|Kiran|amount|paid|guest/i.test(JSON.stringify(p)));
ok('a stranger gets nothing', asv(X, `select coalesce(public.staff_profile()::text, 'none')`) === 'none');
ok('anon cannot call it', /permission denied/.test(psql(DB, ['-c', `begin; set local role anon; select public.staff_profile(); rollback;`]).err));

console.log('\n— marking at a property —');
let m = J(asv(HIM, `select public.staff_mark_today_at('p1')`));
ok('not one of his properties: refused', m && m.ok === false && m.reason === 'not_your_property', m);
m = J(asv(HER, `select public.staff_mark_today_at('p2')`));
ok('at one of hers: marked, with the property', m && m.ok === true && v(`select property_id from stay.attendance where staff_id='s1'`) === 'p2', m);
ok('the wage line is charged there', v(`select property_id || '|' || amount from stay.expenses where staff_id='s1' and source_mark_id is not null`) === 'p2|500');
m = J(asv(HIM, `select stay.staff_mark_today()`));   // the public wrapper comes with the cutover
ok('the plain mark still works (his one property)', m && m.ok === true && v(`select property_id from stay.attendance where staff_id='s2'`) === 'p2', m);

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
