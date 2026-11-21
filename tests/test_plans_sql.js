/* Stage 2 of billing and data protection (v74) on a real Postgres:
   supabase/stay/12-plans.sql. Postgres decides, whatever the app does.
     - the first run: the account moved in from the old app is plan 'owner';
       any other a 7-day trial with 5 properties; runs twice
     - a trial writes for 7 days and not after; refused by SQL for the app's
       role (row-level security) and for the server's own key (the trigger);
       reads still work; the reason is in words
     - active until the period end; past due for its 3 days' grace; never after
     - plan 'owner' (Raaya Vasyam) writes whatever its status and dates say
     - the property limit, and rule B: paused properties are read-only; the
       owner chooses which stay active; a smaller plan pauses the newest
     - on a read-only account: a manager can still be switched off, their
       properties removed, an invite withdrawn; nothing else
     - her marks: "Paused by your employer's account"
     - the platform admin's functions: admins only, audited, append-only log,
       no guest data; an owner plan is never cancelled; the plan columns
       cannot be set from the app
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_plans_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/stay/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_plans_test';
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

const J = s => { try { return JSON.parse(s); } catch { return s; } };
const RV = '22222222-2222-2222-2222-222222222222', OWN2 = 'cccccccc-0000-0000-0000-00000000000c', STAFF = 'eeeeeeee-0000-0000-0000-00000000000e';
const BIG = '33333333-3333-3333-3333-333333333333';

psql('postgres', ['-c', `drop database if exists ${DB}`]); psql('postgres', ['-c', `create database ${DB}`]);
let r = psql(DB, [], `
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  alter role service_role bypassrls;            -- as in Supabase: the server's key skips row-level security, not triggers
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  create table public.owners (user_id uuid primary key);
  create table public.app_status (id int primary key default 1, min_version int not null default 0, message text, updated_at timestamptz default now());
  insert into public.app_status (id) values (1);
  insert into auth.users (id, email) values ('${ADMIN}','me@example.com'),('${MGR}','m@example.com'),('${X}','x@example.com'),
    ('${OWN2}','asha@example.com'),('${STAFF}','laxmi@staff.invalid');`);
for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql', '07-staff.sql', '08-team.sql', '09-calendar.sql', '10-onboarding.sql', '11-legal.sql']) {
  r = load(f); if (r.err) { ok(f, false, r.err); break; } }
// Raaya Vasyam (moved in, so migrated_from is set) and Asha's new account; her
// public marking function as the switch-over left it (a wrapper, old kept as _v58).
r = sql(`set stay.importing='on';
  insert into stay.platform_admins (user_id) values ('${ADMIN}');
  insert into stay.accounts (id, name, code, migrated_from) values ('${RV}', 'Raaya Vasyam', 'raaya', '${ADMIN}');
  insert into stay.accounts (id, name, code) values ('${ACC}', 'Sea Breeze', 'seabreeze');
  insert into stay.members (account_id, user_id, role) values ('${RV}','${ADMIN}','owner'),('${ACC}','${OWN2}','owner'),('${ACC}','${MGR}','manager');
  insert into stay.properties (account_id, id, name) values ('${RV}','rv1','Raaya Vasyam'),('${ACC}','p1','Sea Breeze');
  insert into stay.member_properties (account_id, user_id, property_id) values ('${ACC}','${MGR}','p1');
  insert into stay.staff (account_id, id, name, daily_wage) values ('${ACC}','stf1','Lakshmi', 500);
  insert into stay.staff_logins (account_id, user_id, staff_id, username) values ('${ACC}','${STAFF}','stf1','laxmi');
  create function public.staff_mark_today_v58() returns jsonb language sql as $f$ select '{}'::jsonb $f$;
  create function public.staff_mark_today() returns jsonb language sql volatile as $w$ select * from stay.staff_mark_today() $w$;
  grant execute on function public.staff_mark_today() to authenticated;
  update public.app_status set min_version = 71;
  alter table public.app_status add column if not exists model text; update public.app_status set model = 'stay';`);
ok('set up', !r.err, r.err);

console.log('\n— the script —');
r = load('12-plans.sql'); ok('12-plans.sql runs', !r.err, r.err);
r = load('12-plans.sql'); ok('runs twice', !r.err, r.err);
const check = psql(DB, ['-F', '|', '-f', F('check.sql')]).out.trim().split('\n').filter(Boolean).filter(l => !/^old table|^platform admin|13-billing|billing never/.test(l));
ok('check.sql: every row about the new schema ok, plans among them', check.every(l => /\|ok/.test(l)) && check.some(l => /12-plans/.test(l)), check.filter(l => !/\|ok/.test(l)));
ok('Raaya Vasyam: plan owner, unlimited properties', v(`select plan || '|' || status || '|' || coalesce(properties_allowed::text, 'none') from stay.accounts where id = '${RV}'`) === 'owner|active|none');
ok('any other account: a 7-day trial with 5 properties', v(`select plan || '|' || status || '|' || properties_allowed || '|' || round(extract(epoch from trial_ends_at - trial_started_at) / 86400) from stay.accounts where id = '${ACC}'`) === 'trial|trialing|5|7');
ok('min_version raised to 74', v(`select min_version from public.app_status`) === '74');

// writes the app makes: through apply_change (security invoker: row-level security applies)
const booking = (uid, acct, id, prop = 'p1') => asv(uid, `select stay.apply_change('bookings', '${JSON.stringify({ account_id: acct, id, property_id: prop, check_in: '2026-12-01', check_out: '2026-12-03', guest_name: 'Anita' })}'::jsonb, null)`);
const editBooking = (uid, acct, id) => asv(uid, `select stay.apply_change('bookings', jsonb_build_object('account_id','${acct}','id','${id}','notes','edited'), (select version from stay.bookings where account_id = '${acct}' and id = '${id}'))`);

console.log('\n— a trial —');
ok('day 1: the owner adds a booking', /"status": ?"ok"/.test(booking(OWN2, ACC, 'b1')));
ok('…and the manager edits it', /"status": ?"ok"/.test(editBooking(MGR, ACC, 'b1')));
let st = J(asv(OWN2, `select stay.account_state('${ACC}')`));
ok('account_state: trialing, 7 days left, can write', st && st.status === 'trialing' && st.days_left === 7 && st.can_write === true && st.reason === null, st);
sql(`update stay.accounts set trial_ends_at = now() - interval '1 second' where id = '${ACC}'`);
let w = booking(OWN2, ACC, 'b2');
ok('day 8: a new booking is refused by Postgres, with the reason in words', /Your free trial has ended — subscribe to keep adding bookings/.test(w), w);
ok('…an edit too', /free trial has ended/.test(editBooking(MGR, ACC, 'b1')));
ok('…a direct write without apply_change too (row-level security)', /ERR/.test(asv(OWN2, `insert into stay.expenses (account_id, id, date, category, amount, paid) values ('${ACC}','e1','2026-11-20','other',100,false)`)));
ok('…and with the server\'s own key (the trigger), e.g. an Edge Function', /free trial has ended/.test(svc(`insert into stay.bookings (account_id, id, property_id, check_in, check_out) values ('${ACC}','b9','p1','2026-12-01','2026-12-03')`)));
ok('…for every kind of data: staff, loans, a calendar link', ['staff', 'loans', 'ical_feeds'].every(t => /ERR/.test(svc(
  t === 'staff' ? `insert into stay.staff (account_id, id, name) values ('${ACC}','s2','X')`
  : t === 'loans' ? `insert into stay.loans (account_id, id, principal) values ('${ACC}','l1',100)`
  : `insert into stay.ical_feeds (account_id, property_id, platform, url) values ('${ACC}','p1','Airbnb','https://www.airbnb.com/x.ics')`))));
ok('reads still work: the owner sees every booking', asv(OWN2, `select count(*) from stay.bookings where account_id = '${ACC}'`) === '1');
st = J(asv(OWN2, `select stay.account_state('${ACC}')`));
ok('account_state: expired, cannot write, the reason', st.status === 'expired' && st.can_write === false && /free trial has ended/.test(st.reason), st);
ok('the plan columns cannot be set from the app (to un-expire it)', /permission denied/.test(asv(OWN2, `update stay.accounts set trial_ends_at = now() + interval '1 year' where id = '${ACC}'`))
  && /permission denied/.test(asv(OWN2, `update stay.accounts set plan = 'owner' where id = '${ACC}'`)));
ok('…but the business settings still can', !/ERR/.test(asv(OWN2, `update stay.accounts set name = 'Sea Breeze Stays' where id = '${ACC}'`)));

console.log('\n— on a read-only account, taking access away still works —');
ok('switch a manager off', !/ERR/.test(asv(OWN2, `update stay.members set active = false where account_id = '${ACC}' and user_id = '${MGR}'`)));
ok('…but not switch them back on', /ERR/.test(asv(OWN2, `update stay.members set active = true where account_id = '${ACC}' and user_id = '${MGR}'`)));
ok('remove a manager\'s property', !/ERR/.test(asv(OWN2, `delete from stay.member_properties where account_id = '${ACC}' and user_id = '${MGR}'`)));
sql(`set stay.importing='on'; insert into stay.invites (code, account_id, role, label) values ('invite-code-0000000001','${ACC}','manager','Ravi')`);
ok('withdraw an invite', !/ERR/.test(asv(OWN2, `update stay.invites set expires_at = now() where code = 'invite-code-0000000001'`)));
ok('…but not make a new one', /ERR/.test(asv(OWN2, `insert into stay.invites (code, account_id, role) values ('invite-code-0000000002','${ACC}','manager')`)));

ok('a new staff login: refused', /ERR/.test(svc(`insert into stay.staff_logins (account_id, user_id, staff_id, username) values ('${ACC}','${X}','stf1','other')`)));
ok('…switching a staff login off: allowed', !/ERR/.test(svc(`update stay.staff_logins set active = false where user_id = '${STAFF}'; update stay.staff_logins set notice_version = null where user_id = '${STAFF}'`)) );
sql(`set stay.importing='on'; update stay.staff_logins set active = true where user_id = '${STAFF}'`);
ok('…her acknowledging the notice: allowed', /"ok": ?true/.test(asv(STAFF, `select stay.staff_ack_notice('2026-11-21')`)));

console.log('\n— her page —');
let m = J(asv(STAFF, `select public.staff_mark_today()`));
ok('"I came in today": refused, "Paused by your employer\'s account"', m && m.ok === false && m.reason === 'paused' && /Paused by your employer/.test(m.message), m);
ok('…and the page can ask (staff_paused)', asv(STAFF, `select public.staff_paused()`) === 't');
ok('the underlying function, called directly, is refused by the guard', /Paused by your employer/.test(asv(STAFF, `select stay.staff_mark_today()`)));

console.log('\n— paid: active until the period end, past due for 3 days —');
sql(`update stay.accounts set plan = 'starter', status = 'active', current_period_end = now() + interval '20 days', properties_allowed = 1 where id = '${ACC}'`);
ok('active within the period: writes', /"status": ?"ok"/.test(booking(OWN2, ACC, 'b3')));
sql(`update stay.accounts set current_period_end = now() - interval '1 second' where id = '${ACC}'`);
ok('after the period end: refused ("plan has ended")', /Your plan has ended/.test(booking(OWN2, ACC, 'b4')));
sql(`update stay.accounts set status = 'past_due', grace_ends_at = now() + interval '3 days' where id = '${ACC}'`);
ok('past due within the grace: writes', /"status": ?"ok"/.test(booking(OWN2, ACC, 'b5')));
sql(`update stay.accounts set grace_ends_at = now() - interval '1 second' where id = '${ACC}'`);
ok('after the grace: refused ("payment did not go through")', /payment did not go through/.test(booking(OWN2, ACC, 'b6')));
for (const s of ['expired', 'cancelled']) {
  sql(`update stay.accounts set status = '${s}', current_period_end = now() + interval '9 days' where id = '${ACC}'`);
  ok(`${s}: refused even with a period end ahead`, /ERR/.test(booking(OWN2, ACC, 'b7' + s)));
}

console.log('\n— Raaya Vasyam (plan owner) is never blocked —');
let allOk = true;
for (const [s, extra] of [['trialing', `trial_ends_at = '2000-01-01'`], ['active', `current_period_end = '2000-01-01'`], ['past_due', `grace_ends_at = '2000-01-01'`],
                          ['expired', `trial_ends_at = null`], ['cancelled', `current_period_end = '2000-01-01', inactive_since = '2000-01-01'`]]) {
  sql(`update stay.accounts set status = '${s}', ${extra} where id = '${RV}'`);
  const res = booking(ADMIN, RV, 'rv-' + s, 'rv1');
  const svcw = svc(`insert into stay.expenses (account_id, id, date, category, amount, paid) values ('${RV}','rv-e-${s}','2026-11-20','other',100,false)`);
  if (!/"status": ?"ok"/.test(res) || /ERR/.test(svcw)) { allOk = false; console.log('     ', s, res, svcw); }
}
ok('whatever its status and dates (trialing, active, past due, expired, cancelled, all in the past): every write goes through', allOk);
ok('account_can_write is true for it, and it has no property limit', v(`select stay.account_can_write('${RV}')`) === 't'
  && /"status": ?"ok"/.test(asv(ADMIN, `select stay.apply_change('properties', '{"account_id":"${RV}","id":"rv2","name":"Second"}'::jsonb, null)`)));
ok('the admin cannot cancel it', /never cancelled/.test(asv(ADMIN, `select stay.admin_cancel('${RV}')`)));
sql(`update stay.accounts set status = 'active', trial_ends_at = null, current_period_end = null, grace_ends_at = null, inactive_since = null where id = '${RV}'`);

console.log('\n— properties: the limit and rule B —');
r = sql(`set stay.importing='on';
  insert into stay.accounts (id, name, code) values ('${BIG}', 'Hill Homes', 'hillhomes');
  insert into stay.members (account_id, user_id, role) values ('${BIG}','${OWN2}','owner');`);
ok('a new account starts a 7-day trial with 5 properties (the insert defaults)', v(`select plan || '|' || status || '|' || properties_allowed || '|' || (trial_ends_at > now() + interval '6 days') from stay.accounts where id = '${BIG}'`) === 'trial|trialing|5|true');
const addProp = i => asv(OWN2, `select stay.apply_change('properties', '{"account_id":"${BIG}","id":"h${i}","name":"Home ${i}"}'::jsonb, null)`);
let five = true; for (let i = 1; i <= 5; i++) { if (!/"status": ?"ok"/.test(addProp(i))) five = false; sql(`select pg_sleep(0.01)`); }
ok('five properties in the trial', five);
ok('a sixth: refused ("Your plan allows 5 properties")', /Your plan allows 5 properties/.test(addProp(6)));
r = J(asv(ADMIN, `select stay.admin_set_plan('${BIG}', 'starter')`));
ok('moved to Starter (1 property): the oldest stays active, the newest four are paused', r && r.plan === 'starter'
  && v(`select string_agg(id, ',' order by id) from stay.properties where account_id = '${BIG}' and not paused`) === 'h1', r);
ok('a booking at a paused property: refused ("read-only on your plan")', /read-only on your plan/.test(booking(OWN2, BIG, 'hb1', 'h3')));
ok('…at the active one: fine', /"status": ?"ok"/.test(booking(OWN2, BIG, 'hb2', 'h1')));
ok('the owner cannot un-pause one by editing it', /ERR/.test(asv(OWN2, `update stay.properties set paused = false where account_id = '${BIG}' and id = 'h3'`)));
r = J(asv(OWN2, `select stay.choose_active_properties('${BIG}', array['h3'])`));
ok('the owner chooses which stays active (h3), and h1 becomes read-only', r && JSON.stringify(r.paused_properties) === '["h1","h2","h4","h5"]', r);
ok('choosing two on Starter: refused', /allows 1 active property/.test(asv(OWN2, `select stay.choose_active_properties('${BIG}', array['h1','h3'])`)));
ok('someone who is not the owner cannot choose (a manager, or a stranger)', /Only the owner/.test(asv(MGR, `select stay.choose_active_properties('${BIG}', array['h1'])`))
  && /Only the owner/.test(asv(X, `select stay.choose_active_properties('${BIG}', array['h1'])`)));
r = J(asv(ADMIN, `select stay.admin_set_plan('${BIG}', 'pro')`));
ok('moved to Pro (5): every property active again', v(`select count(*) from stay.properties where account_id = '${BIG}' and paused`) === '0', r);

console.log('\n— the platform admin —');
ok('only platform admins: the list, extend, set plan, cancel', ['admin_accounts()', `admin_extend_trial('${ACC}', 7)`, `admin_set_plan('${ACC}', 'pro')`, `admin_cancel('${ACC}')`]
  .every(f => /Platform admins only/.test(asv(OWN2, `select stay.${f}`))));
const list = J(asv(ADMIN, `select stay.admin_accounts()`));
ok('the list: every account with plan, status, trial end, properties and last activity — no guest data', Array.isArray(list) && list.length === 3
  && list.every(a => 'plan' in a && 'status' in a && 'trial_ends_at' in a && 'properties' in a && 'last_activity' in a)
  && !/Anita|guest_name|phone/.test(JSON.stringify(list)), list);
sql(`update stay.accounts set plan = 'trial', status = 'trialing', trial_ends_at = now() - interval '1 day', properties_allowed = 5 where id = '${ACC}'`);
r = J(asv(ADMIN, `select stay.admin_extend_trial('${ACC}', 7)`));
ok('extend a lapsed trial by 7 days: writable again', r && r.can_write === true && /"status": ?"ok"/.test(booking(OWN2, ACC, 'b8')), r);
r = J(asv(ADMIN, `select stay.admin_cancel('${ACC}')`));
ok('cancel: read-only at once', r && r.status === 'cancelled' && r.can_write === false);
ok('every action is in the audit log', v(`select string_agg(action, ',' order by id) from stay.admin_audit`) === 'set_plan,set_plan,extend_trial,cancel');
ok('the log is append-only, even for the database owner', /append-only/.test(sql(`update stay.admin_audit set action = 'x'`).err) && /append-only/.test(sql(`delete from stay.admin_audit`).err));
ok('owners cannot read it', asv(OWN2, `select count(*) from stay.admin_audit`) === '0');
ok('the functions for the Edge Functions are the server\'s only', /permission denied/.test(asv(OWN2, `select * from stay.accounts_can_write(array['${ACC}'::uuid])`))
  && /f/.test(svc(`select can_write from stay.accounts_can_write(array['${ACC}'::uuid])`)));

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
