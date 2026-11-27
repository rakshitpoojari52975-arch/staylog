/* Phase 6 on a real Postgres: supabase/stay/08-team.sql.
     - runs twice; check.sql all ok
     - the owner's invites: managers only; a manager or stranger sees none
     - my_access: the owner has everything; a manager the defaults, the
       owner's choices, and the properties they hold; a stranger nothing
     - team(): the owner's alone — members with sign-in emails, properties,
       open invites (not used, not expired)
     - and what a manager reads is what my_access says (row-level security)
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_team_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/stay/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_team_test';
const psql = (db, args, input) => { try { return { out: execFileSync('psql', [...CONN, '-d', db, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args],
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; } };
const sql = s => psql(DB, ['-c', 'set client_min_messages=warning;' + s]);
const v = s => sql(s).out.trim();
const ACC = '11111111-1111-1111-1111-111111111111', OWNER = 'aaaaaaaa-0000-0000-0000-00000000000a',
  MGR = 'bbbbbbbb-0000-0000-0000-00000000000b', X = 'ffffffff-0000-0000-0000-00000000000f';
const as = (uid, q) => psql(DB, ['-c', `set client_min_messages=warning; begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
const asv = (uid, q) => { const r = as(uid, q); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const J = s => { try { return JSON.parse(String(s).split('\n').pop()); } catch { return null; } };

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
  insert into auth.users (id, email) values ('${OWNER}','owner@example.com'),('${MGR}','priya@example.com'),('${X}','x@example.com');`);
for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql', '07-staff.sql', '08-team.sql', '08-team.sql', '09-calendar.sql', '10-onboarding.sql', '11-legal.sql', '12-plans.sql', '13-billing.sql', '14-paid-on.sql']) {
  r = psql(DB, ['-c', 'set client_min_messages=warning', '-f', F(f)]); if (r.err) { ok(f, false, r.err); break; } }
ok('stay 01 → 08 load (08 twice)', !r.err, r.err);
const check = psql(DB, ['-F', '|', '-f', F('check.sql')]).out.trim().split('\n').filter(Boolean);
// This database has no old tables and no platform admin: only the new schema's rows count here.
const mine = check.filter(l => !/^old table|^platform admin/.test(l));
ok('check.sql: every row about the new schema ok', mine.every(l => /\|ok/.test(l)), mine.filter(l => !/\|ok/.test(l)));
sql(`set stay.importing='on';
  insert into stay.accounts (id, name, code) values ('${ACC}', 'Raaya Vasyam', 'raaya');
  insert into stay.members (account_id, user_id, role, display_name) values ('${ACC}','${OWNER}','owner','Rakshit'),
    ('${ACC}','${MGR}','manager','Priya');
  update stay.members set permissions = '{"see_money":true,"send_messages":false}' where user_id='${MGR}';
  insert into stay.properties (account_id, id, name) values ('${ACC}','p1','Raaya Vasyam'),('${ACC}','p2','Sea View');
  insert into stay.member_properties (account_id, user_id, property_id) values ('${ACC}','${MGR}','p2');
  insert into stay.bookings (account_id, id, property_id, guest_name, check_in, check_out) values
    ('${ACC}','b1','p1','Anita','2026-12-01','2026-12-03'),('${ACC}','b2','p2','Kiran','2026-12-05','2026-12-07');`);

console.log('\n— invites —');
const inv = (uid, code, role) => asv(uid, `insert into stay.invites (code, account_id, role, property_ids, label) values ('${code}','${ACC}','${role}','{p2}','Someone')`);
ok('the owner invites a manager', !/ERR/.test(inv(OWNER, 'code-manager-0000000001', 'manager')));
ok('…but cannot invite an owner', /row-level security|violates/.test(inv(OWNER, 'code-owner-000000000001', 'owner')));
ok('a manager cannot invite', /ERR/.test(inv(MGR, 'code-bymgr-000000000001', 'manager')));
ok('a manager sees no invites', asv(MGR, `select count(*) from stay.invites`) === '0');
ok('a stranger sees no invites', asv(X, `select count(*) from stay.invites`) === '0');
ok('the owner withdraws one (expires_at only)', !/ERR/.test(asv(OWNER, `update stay.invites set expires_at = now() where code='code-manager-0000000001'`))
  && /permission denied/.test(asv(OWNER, `update stay.invites set used_by='${X}' where code='code-manager-0000000001'`)));

console.log('\n— my_access —');
let a = J(asv(OWNER, `select stay.my_access('${ACC}')`));
ok('owner: every permission (but calendar links never for anyone else), all properties', a && a.role === 'owner' && a.permissions.see_money && a.permissions.manage_staff && a.properties === null, a);
a = J(asv(MGR, `select stay.my_access('${ACC}')`));
ok('manager: the defaults, then the owner\'s choices', a && a.role === 'manager' && a.permissions.edit_bookings === true && a.permissions.send_messages === false
  && a.permissions.see_money === true && a.permissions.manage_staff === false && a.permissions.manage_calendar === false, a);
ok('…and the properties they hold', a && JSON.stringify(a.properties) === '["p2"]');
ok('a stranger: nothing', asv(X, `select coalesce(stay.my_access('${ACC}')::text,'none')`) === 'none');
ok('what the manager reads matches: Sea View\'s booking only', asv(MGR, `select string_agg(id, ',') from stay.bookings`) === 'b2');

console.log('\n— team() —');
sql(`insert into stay.invites (code, account_id, role, property_ids, label) values ('code-open-0000000000001','${ACC}','manager','{p1}','Ravi'),
  ('code-used-0000000000001','${ACC}','manager','{p1}','Old');
  update stay.invites set used_by='${X}' where code='code-used-0000000000001';`);
const t = J(asv(OWNER, `select stay.team('${ACC}')`));
ok('members with their sign-in emails, roles, properties', t && t.members.length === 2 && t.members[0].role === 'owner' && t.members[0].me === true
  && t.members[1].email === 'priya@example.com' && JSON.stringify(t.members[1].properties) === '["p2"]', t && t.members);
ok('only the invites still open', t && t.invites.map(i => i.code).join() === 'code-open-0000000000001', t && t.invites);
ok('the owner\'s alone: a manager is refused', /Only the owner/.test(asv(MGR, `select stay.team('${ACC}')`)));
ok('…and so is someone outside the account (v74: is_owner said null, not false, and let them in)', /Only the owner/.test(asv(X, `select stay.team('${ACC}')`)));

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
