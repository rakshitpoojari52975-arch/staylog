/* Phase 7 on a real Postgres: supabase/stay/09-calendar.sql.
     - runs twice; check.sql all ok
     - the first run counts every stored event as announced; a second run
       leaves a new, not-yet-announced event alone (nothing lost)
     - stay.ical_runs: the owner reads their account's row; a manager, a
       stranger and another account's owner read nothing; nobody signed in
       writes it (only the function, with the service key)
     - min_version: raised to 68 in the new model, never lowered, untouched
       in the old one
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_ical_server_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/stay/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_ical_server_test';
const psql = (db, args, input) => { try { return { out: execFileSync('psql', [...CONN, '-d', db, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args],
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; } };
const sql = s => psql(DB, ['-c', 'set client_min_messages=warning;' + s]);
const v = s => sql(s).out.trim();
const ACC = '11111111-1111-1111-1111-111111111111', ACC2 = '22222222-2222-2222-2222-222222222222';
const OWNER = 'aaaaaaaa-0000-0000-0000-00000000000a', MGR = 'bbbbbbbb-0000-0000-0000-00000000000b',
  X = 'ffffffff-0000-0000-0000-00000000000f', OWNER2 = 'cccccccc-0000-0000-0000-00000000000c';
const as = (uid, q) => psql(DB, ['-c', `set client_min_messages=warning; begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
const asv = (uid, q) => { const r = as(uid, q); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const load = f => psql(DB, ['-c', 'set client_min_messages=warning', '-f', F(f)]);

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
  insert into auth.users (id, email) values ('${OWNER}','owner@example.com'),('${MGR}','priya@example.com'),('${X}','x@example.com'),('${OWNER2}','other@example.com');`);
for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql', '07-staff.sql', '08-team.sql']) {
  r = load(f); if (r.err) { ok(f, false, r.err); break; } }
r = sql(`set stay.importing='on';
  insert into stay.accounts (id, name, code) values ('${ACC}', 'Raaya Vasyam', 'raaya'), ('${ACC2}', 'Elsewhere', 'else');
  insert into stay.members (account_id, user_id, role, display_name) values ('${ACC}','${OWNER}','owner','Rakshit'),
    ('${ACC}','${MGR}','manager','Priya'), ('${ACC2}','${OWNER2}','owner','Other');
  insert into stay.properties (account_id, id, name) values ('${ACC}','p1','Raaya Vasyam'),('${ACC2}','q1','Elsewhere');
  insert into stay.member_properties (account_id, user_id, property_id) values ('${ACC}','${MGR}','p1');
  insert into stay.ical_feeds (account_id, id, property_id, platform, url) values
    ('${ACC}','f0000000-0000-0000-0000-000000000001','p1','Airbnb','https://www.airbnb.com/calendar/ical/1.ics?s=made-up');
  insert into stay.ical_events (account_id, feed_id, uid, property_id, platform, start_date, end_date, kind) values
    ('${ACC}','f0000000-0000-0000-0000-000000000001','old@airbnb','p1','Airbnb','2026-12-01','2026-12-03','reserved');
  update public.app_status set model = 'stay', min_version = 62;`);
ok('the test account is set up', !r.err, r.err);

console.log('\n— the script —');
r = load('09-calendar.sql');
ok('09-calendar.sql runs', !r.err, r.err);
ok('the first run: every event already stored counts as announced', v(`select count(*) from stay.ical_events where announced_at is null`) === '0');
sql(`insert into stay.ical_events (account_id, feed_id, uid, property_id, platform, start_date, end_date, kind) values
  ('${ACC}','f0000000-0000-0000-0000-000000000001','new@airbnb','p1','Airbnb','2026-12-10','2026-12-12','reserved')`);
r = load('09-calendar.sql');
ok('runs twice', !r.err, r.err);
ok('…and a second run leaves an event waiting to be announced alone', v(`select count(*) from stay.ical_events where announced_at is null and uid = 'new@airbnb'`) === '1');
const check = psql(DB, ['-F', '|', '-f', F('check.sql')]).out.trim().split('\n').filter(Boolean);
const mine = check.filter(l => !/^old table|^platform admin|10-onboarding/.test(l));
ok('check.sql: every row about the new schema ok, the calendar row among them', mine.every(l => /\|ok/.test(l)) && mine.some(l => /09-calendar/.test(l)), mine.filter(l => !/\|ok/.test(l)));

console.log('\n— the run record —');
sql(`insert into stay.ical_runs (account_id, last_run_at, result) values ('${ACC}', now(), '{"created":1}'), ('${ACC2}', now(), '{"created":5}')`);
ok('the owner reads their account\'s run', asv(OWNER, `select string_agg(result->>'created', ',') from stay.ical_runs`) === '1');
ok('a manager reads none (calendar is the owner\'s)', asv(MGR, `select count(*) from stay.ical_runs`) === '0');
ok('a stranger reads none', asv(X, `select count(*) from stay.ical_runs`) === '0');
ok('another account\'s owner reads only theirs', asv(OWNER2, `select string_agg(result->>'created', ',') from stay.ical_runs`) === '5');
ok('the owner cannot write it (only the function does)', /permission denied/.test(asv(OWNER, `update stay.ical_runs set last_manual_at = null`))
  && /permission denied/.test(asv(OWNER, `insert into stay.ical_runs (account_id) values ('${ACC}')`)));
r = psql(DB, ['-c', `set role service_role; update stay.ical_runs set last_manual_at = now() where account_id = '${ACC}'`]);
ok('the function\'s role can', !r.err, r.err);

console.log('\n— min_version —');
ok('raised to 68 in the new model', v(`select min_version from public.app_status`) === '68');
sql(`update public.app_status set min_version = 70`); load('09-calendar.sql');
ok('never lowered', v(`select min_version from public.app_status`) === '70');
sql(`update public.app_status set model = 'public', min_version = 62`); load('09-calendar.sql');
ok('untouched in the old model (after a rollback)', v(`select min_version from public.app_status`) === '62');

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
