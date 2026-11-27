/* Phase 9 on a real Postgres: supabase/stay/10-onboarding.sql.
     - runs twice; check.sql all ok
     - platform invites: a platform admin makes, reads and withdraws them;
       an owner, a manager or a stranger cannot
     - stay.open_account: only the service key; claims the invite and opens
       the account with its owner in one go; used, withdrawn or expired
       invites, a bad or taken code, a bad time zone change nothing
     - account settings: a real time zone, a three-letter currency, at least
       one source that pays directly; the code never changes
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_onboarding_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/stay/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_onboarding_test';
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
for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql', '07-staff.sql', '08-team.sql', '09-calendar.sql', '11-legal.sql']) {
  r = load(f); if (r.err) { ok(f, false, r.err); break; } }
r = sql(`set stay.importing='on';
  insert into stay.platform_admins (user_id) values ('${ADMIN}');
  insert into stay.accounts (id, name, code) values ('${ACC}', 'Raaya Vasyam', 'raaya');
  insert into stay.members (account_id, user_id, role) values ('${ACC}','${ADMIN}','owner'),('${ACC}','${MGR}','manager');`);
ok('set up', !r.err, r.err);

console.log('\n— the script —');
r = load('10-onboarding.sql'); ok('10-onboarding.sql runs', !r.err, r.err);
r = load('10-onboarding.sql'); ok('runs twice', !r.err, r.err);
const check = psql(DB, ['-F', '|', '-f', F('check.sql')]).out.trim().split('\n').filter(Boolean).filter(l => !/^old table|^platform admin|12-plans|plan of the account|13-billing|billing never|14-paid-on|15-privacy/.test(l));
ok('check.sql: every row about the new schema ok, onboarding among them', check.every(l => /\|ok/.test(l)) && check.some(l => /10-onboarding/.test(l)), check.filter(l => !/\|ok/.test(l)));
ok('the existing account passes the new checks untouched', v(`select name || '|' || code from stay.accounts`) === 'Raaya Vasyam|raaya');

console.log('\n— platform invites —');
const mk = (uid, code, label = 'Asha, Goa') => asv(uid, `insert into stay.platform_invites (code, label, created_by) values ('${code}', '${label}', '${uid}')`);
ok('a platform admin makes one', !/ERR/.test(mk(ADMIN, 'owner-invite-000000001')));
ok('…and reads it', asv(ADMIN, `select count(*) from stay.platform_invites`) === '1');
ok('am_platform_admin: yes for the admin, no for others', asv(ADMIN, `select stay.am_platform_admin()`) === 't' && asv(MGR, `select stay.am_platform_admin()`) === 'f');
ok('a manager cannot make one', /ERR/.test(mk(MGR, 'owner-invite-000000002')));
ok('a stranger cannot make one, or see any', /ERR/.test(mk(X, 'owner-invite-000000003')) && asv(X, `select count(*) from stay.platform_invites`) === '0');
ok('nobody makes one already used', /ERR/.test(asv(ADMIN, `insert into stay.platform_invites (code, created_by, used_by) values ('owner-invite-000000004','${ADMIN}','${X}')`)));
ok('the admin withdraws one (expires_at only)', !/ERR/.test(asv(ADMIN, `update stay.platform_invites set expires_at = now() where code = 'owner-invite-000000001'`))
  && /permission denied/.test(asv(ADMIN, `update stay.platform_invites set used_by = '${X}'`)));

console.log('\n— opening an account —');
sql(`insert into stay.platform_invites (code, label, created_by) values ('owner-invite-live00001', 'Asha', '${ADMIN}'),
  ('owner-invite-live00002', 'B', '${ADMIN}'), ('owner-invite-expired01', 'C', '${ADMIN}');
  update stay.platform_invites set expires_at = now() - interval '1 minute' where code = 'owner-invite-expired01';`);
const open = (code, user, acode, tz = 'Asia/Kolkata', cur = 'INR') => svc(`select stay.open_account('${code}', '${user}', 'Sea Breeze Stays', '${acode}', '${tz}', '${cur}', 'Asha')`);
ok('a signed-in login cannot call it', /permission denied/.test(asv(NEW, `select stay.open_account('owner-invite-live00001', '${NEW}', 'X', 'xx')`)));
ok('a bad code: refused, nothing made', /code: 2 to 12/.test(open('owner-invite-live00001', NEW, 'Sea Breeze')) && v(`select count(*) from stay.accounts`) === '1');
ok('a taken code: refused', /code: taken/.test(open('owner-invite-live00001', NEW, 'raaya')));
ok('a bad time zone: refused, the invite still free', /Unknown time zone/.test(open('owner-invite-live00001', NEW, 'seabreeze', 'Mars/Olympus'))
  && v(`select used_by is null from stay.platform_invites where code = 'owner-invite-live00001'`) === 't');
const id = open('owner-invite-live00001', NEW, 'SeaBreeze', 'Asia/Kolkata', 'inr');
ok('opened: the account, its owner, the invite used', /^[0-9a-f-]{36}$/.test(id)
  && v(`select name || '|' || code || '|' || currency || '|' || owner_name from stay.accounts where id = '${id}'`) === 'Sea Breeze Stays|seabreeze|INR|Asha'
  && v(`select role from stay.members where account_id = '${id}' and user_id = '${NEW}'`) === 'owner'
  && v(`select used_by || '|' || account_id from stay.platform_invites where code = 'owner-invite-live00001'`) === `${NEW}|${id}`, id);
ok('…and they see it as its owner, and nothing of the other account', asv(NEW, `select stay.is_owner('${id}')`) === 't' && asv(NEW, `select count(*) from stay.accounts`) === '1');
ok('used once only', /invite:/.test(open('owner-invite-live00001', NEW2, 'another')));
ok('an expired or withdrawn invite opens nothing', /invite:/.test(open('owner-invite-expired01', NEW2, 'another2')) && /invite:/.test(open('owner-invite-000000001', NEW2, 'another3')));

console.log('\n— account settings —');
const set = (q) => asv(NEW, `update stay.accounts set ${q} where id = '${id}'`);
ok('the owner renames and moves to another time zone and currency', !/ERR/.test(set(`name = 'Sea Breeze', time_zone = 'Asia/Dubai', currency = 'AED'`))
  && v(`select name || '|' || time_zone || '|' || currency from stay.accounts where id = '${id}'`) === 'Sea Breeze|Asia/Dubai|AED');
ok('…and chooses who pays them directly', !/ERR/.test(set(`pays_directly_sources = '{Direct,Airbnb}'`)));
ok('a time zone that does not exist: refused', /Unknown time zone/.test(set(`time_zone = 'Asia/Atlantis'`)));
ok('a currency not three capital letters: refused', /three capital letters/.test(set(`currency = 'rupees'`)));
ok('no source that pays directly: refused', /At least one source/.test(set(`pays_directly_sources = '{}'`)));
ok('a blank name: refused', /needs a name/.test(set(`name = '   '`)));
ok('the code cannot change (not even by the database owner)', /permission denied/.test(set(`code = 'other'`)) && /cannot change/.test(sql(`update stay.accounts set code = 'other' where id = '${id}'`).err));
ok('a manager cannot change settings', /ERR|^$/.test(asv(MGR, `update stay.accounts set name = 'Mine' where id = '${ACC}'`)) && v(`select name from stay.accounts where id = '${ACC}'`) === 'Raaya Vasyam');

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
