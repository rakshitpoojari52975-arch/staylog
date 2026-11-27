/* v76 on a real Postgres: supabase/stay/14-paid-on.sql — her page's paydays.
     - runs twice; check.sql's row ok; grants unchanged (she still calls it)
     - paydays: grouped by the day paid, newest first, last 6; days counted
       once per date (a wage and utensil cleaning the same day = 1 day);
       received and loan deducted per payday
     - last_payout by paid_on, not the day worked
     - paid lines with no payday (before v64) are counted, never dated
     - everything else her page reads is as before
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_paid_on_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/stay/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_paid_on_test';
const psql = (db, args, input) => { try { return { out: execFileSync('psql', [...CONN, '-d', db, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args],
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; } };
const sql = s => psql(DB, ['-c', 'set client_min_messages=warning;' + s]);
const as = (uid, q) => { const r = psql(DB, ['-c', `set client_min_messages=warning; begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
  return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const load = f => psql(DB, ['-c', 'set client_min_messages=warning', '-f', F(f)]);
const ACC = '11111111-1111-1111-1111-111111111111', OWNER = 'aaaaaaaa-0000-0000-0000-00000000000a', STAFF = 'eeeeeeee-0000-0000-0000-00000000000e';

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
  insert into auth.users (id, email) values ('${OWNER}','owner@example.com'),('${STAFF}','laxmi@staff.invalid');`);
for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql', '07-staff.sql', '08-team.sql',
  '09-calendar.sql', '10-onboarding.sql', '11-legal.sql', '12-plans.sql', '13-billing.sql']) { r = load(f); if (r.err) { ok(f, false, r.err); break; } }
// paydays: 20 Nov (3 wage days + utensils on one of them, ₹100 to the loan), 10 Nov (2 days),
// six more earlier paydays (only 6 in all are listed), two paid lines with no payday, one unpaid
const line = (id, date, amt, paid, on, extra = '') => `('${ACC}','${id}','${date}','staff','Wage',${amt},${paid},${on ? `'${on}'` : 'null'},'s1'${extra})`;
r = sql(`set stay.importing='on';
  insert into stay.accounts (id, name, code, migrated_from) values ('${ACC}', 'Raaya Vasyam', 'raaya', '${OWNER}');
  insert into stay.members (account_id, user_id, role) values ('${ACC}','${OWNER}','owner');
  insert into stay.properties (account_id, id, name) values ('${ACC}','p1','Raaya Vasyam');
  insert into stay.staff (account_id, id, name, daily_wage) values ('${ACC}','s1','Lakshmi Walikar', 500);
  insert into stay.staff_logins (account_id, user_id, staff_id, username) values ('${ACC}','${STAFF}','s1','laxmi');
  insert into stay.loans (account_id, id, staff_id, principal, installment_amount, disbursed_on, first_due_date, status)
    values ('${ACC}','L1','s1',5000,500,'2026-09-01','2026-10-01','active');
  insert into stay.expenses (account_id, id, date, category, description, amount, paid, paid_on, staff_id) values
    ${line('w1', '2026-11-12', 500, true, '2026-11-20')}, ${line('w2', '2026-11-13', 500, true, '2026-11-20')},
    ${line('ute_s1_20261113', '2026-11-13', 100, true, '2026-11-20')},
    ${line('w4', '2026-11-05', 500, true, '2026-11-10')}, ${line('w5', '2026-11-06', 500, true, '2026-11-10')},
    ${[1, 2, 3, 4, 5, 6].map(i => line('e' + i, `2026-0${i + 1}-01`, 500, true, `2026-0${i + 1}-03`)).join(',')},
    ${line('old1', '2026-01-10', 500, true, null)}, ${line('old2', '2026-01-11', 500, true, null)},
    ${line('u1', '2026-11-25', 500, false, null)};
  insert into stay.expenses (account_id, id, date, category, description, amount, paid, paid_on, staff_id, loan_id, loan_deduction, gross_amount) values
    ('${ACC}','w3','2026-11-14','staff','Wage',400,true,'2026-11-20','s1','L1',100,500);`);
ok('set up', !r.err, r.err);

console.log('\n— the script —');
r = load('14-paid-on.sql'); ok('14-paid-on.sql runs', !r.err, r.err);
r = load('14-paid-on.sql'); ok('runs twice', !r.err, r.err);
const row = psql(DB, ['-F', '|', '-f', F('check.sql')]).out.split('\n').find(l => /14-paid-on/.test(l)) || '';
ok('check.sql: her paydays row ok', /\|ok$/.test(row), row);
const st = JSON.parse(as(STAFF, 'select stay.staff_standing()') || '{}');
ok('she still reads her page (grants kept)', !!st.pending && !!st.overall, st);

console.log('\n— paydays —');
const P = st.paydays || [];
ok('the last 6 paydays, newest first', P.length === 6 && P[0].date === '2026-11-20' && P[1].date === '2026-11-10'
  && P.map(p => p.date).join() === '2026-11-20,2026-11-10,2026-07-03,2026-06-03,2026-05-03,2026-04-03', P.map(p => p.date));
ok('20 Nov: 3 days (the utensils on 13 Nov is the same day), ₹1,500 received, ₹100 to the loan',
  Number(P[0].days) === 3 && Number(P[0].received) === 1500 && Number(P[0].deducted) === 100, P[0]);
ok('10 Nov: 2 days, ₹1,000, nothing to the loan', Number(P[1].days) === 2 && Number(P[1].received) === 1000 && Number(P[1].deducted) === 0, P[1]);
ok('last payout: the latest day paid, with what she received', st.last_payout && st.last_payout.date === '2026-11-20'
  && Number(st.last_payout.amount) === 1500 && Number(st.last_payout.deducted) === 100, st.last_payout);
ok('paid lines with no payday are counted, never dated', Number(st.paid_undated) === 2 && !P.some(p => !p.date));
ok('the unpaid line is still pending', Number(st.pending.count) === 1 && Number(st.pending.amount) === 500);
ok('what she received in all is unchanged (paid lines, dated or not)', Number(st.overall.paid) === 1500 + 1000 + 6 * 500 + 1000, st.overall);
sql(`update stay.expenses set paid_on = null where account_id = '${ACC}' and paid_on is not null`);
const st2 = JSON.parse(as(STAFF, 'select stay.staff_standing()') || '{}');
ok('no payday recorded at all: no paydays, no last payout (not the day worked)', (st2.paydays || []).length === 0 && st2.last_payout === null
  && Number(st2.paid_undated) === 14, { p: st2.paydays, l: st2.last_payout, u: st2.paid_undated });
ok('the owner (not her login) gets nothing from it', as(OWNER, 'select stay.staff_standing()') === '');

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
