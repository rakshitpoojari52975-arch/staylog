/* Stage 1 of billing and data protection (v73) on a real Postgres:
   supabase/stay/11-legal.sql.
     - runs twice; check.sql all ok
     - legal_pending: Terms and Privacy Policy not yet accepted; accept_legal
       records the current versions for the signed-in login only; a new
       version is asked again; nobody writes acceptances directly
     - the staff notice: shown until she acknowledges the current version;
       only her own login; an old version is refused; an owner or a stranger
       has no notice
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_legal_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/stay/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_legal_test';
const psql = (db, args, input) => { try { return { out: execFileSync('psql', [...CONN, '-d', db, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args],
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; } };
const sql = s => psql(DB, ['-c', 'set client_min_messages=warning;' + s]);
const v = s => sql(s).out.trim();
const ACC = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'aaaaaaaa-0000-0000-0000-00000000000a', MGR = 'bbbbbbbb-0000-0000-0000-00000000000b',
  X = 'ffffffff-0000-0000-0000-00000000000f', NEW = 'cccccccc-0000-0000-0000-00000000000c', NEW2 = 'dddddddd-0000-0000-0000-00000000000d';
const as = (uid, q) => psql(DB, ['-c', `set client_min_messages=warning; begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
const asv = (uid, q) => { const r = as(uid, q); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const svc = q => { const r = psql(DB, ['-c', `set client_min_messages=warning; begin; set local role service_role; ${q}; commit;`]); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const load = f => psql(DB, ['-c', 'set client_min_messages=warning', '-f', F(f)]);

psql('postgres', ['-c', `drop database if exists ${DB}`]); psql('postgres', ['-c', `create database ${DB}`]);
let r = psql(DB, [], `
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  create table public.owners (user_id uuid primary key);
  create table public.app_status (id int primary key default 1, min_version int not null default 0, message text, updated_at timestamptz default now());
  insert into public.app_status (id) values (1);
  insert into auth.users (id, email) values ('${ADMIN}','admin@example.com'),('${MGR}','m@example.com'),('${X}','x@example.com'),
    ('${NEW}','asha@example.com'),('${NEW2}','b@example.com');`);
for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql', '07-staff.sql', '08-team.sql', '09-calendar.sql', '10-onboarding.sql']) {
  r = load(f); if (r.err) { ok(f, false, r.err); break; } }
const STAFF = 'eeeeeeee-0000-0000-0000-00000000000e';
r = sql(`set stay.importing='on';
  insert into auth.users (id, email) values ('${STAFF}','laxmi.raaya@staff.staylog.invalid');
  insert into stay.accounts (id, name, code) values ('${ACC}', 'Raaya Vasyam', 'raaya');
  insert into stay.members (account_id, user_id, role) values ('${ACC}','${ADMIN}','owner'),('${ACC}','${MGR}','manager');
  insert into stay.staff (account_id, id, name) values ('${ACC}','stf1','Lakshmi Walikar');
  insert into stay.staff_logins (account_id, user_id, staff_id, username, active) values ('${ACC}','${STAFF}','stf1','laxmi',true);`);
ok('set up', !r.err, r.err);

console.log('\n— the script —');
r = load('11-legal.sql'); ok('11-legal.sql runs', !r.err, r.err);
r = load('11-legal.sql'); ok('runs twice', !r.err, r.err);
const check = psql(DB, ['-F', '|', '-f', F('check.sql')]).out.trim().split('\n').filter(Boolean).filter(l => !/^old table|^platform admin|12-plans|plan of the account|13-billing|billing never/.test(l));
ok('check.sql: every row about the new schema ok, the legal row among them', check.every(l => /\|ok/.test(l)) && check.some(l => /11-legal/.test(l)), check.filter(l => !/\|ok/.test(l)));
ok('the versions in force', v(`select string_agg(document || '=' || version, ',' order by document) from stay.legal_versions`)
  === 'privacy=2026-11-21,refund=2026-11-21,staff_notice=2026-11-21,terms=2026-11-21');

console.log('\n— accepting the Terms and Privacy Policy —');
const J = s => { try { return JSON.parse(s); } catch { return s; } };
ok('a member who has not accepted: both are pending', JSON.stringify(J(asv(MGR, `select stay.legal_pending()`)).map(x => x.document)) === '["privacy","terms"]');
const acc = J(asv(MGR, `select stay.accept_legal(array['terms','privacy'])`));
ok('accept_legal records the current versions, and nothing is left pending', Array.isArray(acc) && acc.length === 0
  && v(`select string_agg(document || ':' || version || ':' || via, ',' order by document) from stay.legal_acceptances where user_id = '${MGR}'`)
     === 'privacy:2026-11-21:app,terms:2026-11-21:app', acc);
ok('…only for the login that accepted', v(`select count(*) from stay.legal_acceptances where user_id <> '${MGR}'`) === '0');
ok('accepting again changes nothing', !/ERR/.test(asv(MGR, `select stay.accept_legal(array['terms'])`)) && v(`select count(*) from stay.legal_acceptances`) === '2');
ok('nobody writes acceptances directly', /permission denied/.test(asv(MGR, `insert into stay.legal_acceptances (user_id, document, version) values ('${X}','terms','x')`)));
ok('each login reads only its own', asv(X, `select count(*) from stay.legal_acceptances`) === '0' && asv(MGR, `select count(*) from stay.legal_acceptances`) === '2');
ok('not signed in: refused', /Not signed in/.test(psql(DB, ['-c', `select stay.accept_legal(array['terms'])`]).err));
sql(`update stay.legal_versions set version = '2027-01-01' where document = 'terms'`);
ok('a new version of the Terms: asked again, for the Terms only', JSON.stringify(J(asv(MGR, `select stay.legal_pending()`)).map(x => x.document + '@' + x.version)) === '["terms@2027-01-01"]');
r = load('11-legal.sql');
ok('a re-run sets the version in the script again', v(`select version from stay.legal_versions where document = 'terms'`) === '2026-11-21');

console.log('\n— the staff notice —');
let n = J(asv(STAFF, `select public.staff_notice()`));
ok('her first sign-in: the notice, not yet acknowledged', n && n.version === '2026-11-21' && n.acknowledged === false, n);
ok('an old version is refused', J(asv(STAFF, `select public.staff_ack_notice('2025-01-01')`)).reason === 'old_notice');
n = J(asv(STAFF, `select public.staff_ack_notice('2026-11-21')`));
ok('acknowledged: recorded with the time', n.ok === true && v(`select notice_version || ':' || (notice_acknowledged_at is not null) from stay.staff_logins where user_id = '${STAFF}'`) === '2026-11-21:true', n);
ok('…and not asked again', J(asv(STAFF, `select public.staff_notice()`)).acknowledged === true);
ok('an owner or a stranger has no staff notice', asv(MGR, `select coalesce(public.staff_notice()::text, 'none')`) === 'none'
  && J(asv(X, `select public.staff_ack_notice('2026-11-21')`)).reason === 'no_access');
ok('anonymous callers cannot use the functions', /permission denied/.test(psql(DB, ['-c', `set role anon; select public.staff_notice()`]).err));

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
