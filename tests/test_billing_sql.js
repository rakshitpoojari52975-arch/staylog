/* Stage 3 of billing and data protection (v75) on a real Postgres:
   supabase/stay/13-billing.sql.
     - runs twice; check.sql ok; plans not on sale until priced and ticked
     - who reads what: plans on sale and the settings (signed in), invoices
       (the account's owner), events (platform admins); nothing written from
       the app but the owner's GSTIN; the service functions are the server's
     - each Razorpay event applied once (a repeat delivery changes nothing):
       activated / charged → active with the plan's properties and period;
       charged → one invoice per payment, numbered per financial year, GST
       split only when switched on; pending / halted → 3 days' grace, kept;
       cancelled → runs to the period's end; older events change nothing; a
       second subscription is answered "cancel it"; Raaya Vasyam untouched
     - the daily sweep; who may order; one trial per business
     - invoices and events are append-only, even for the database owner
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_billing_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/stay/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_billing_test';
const psql = (db, args, input) => { try { return { out: execFileSync('psql', [...CONN, '-d', db, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args],
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; } };
const sql = s => psql(DB, ['-c', 'set client_min_messages=warning;' + s]);
const v = s => { const r = sql(s); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const as = (uid, q) => psql(DB, ['-c', `set client_min_messages=warning; begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
const asv = (uid, q) => { const r = as(uid, q); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const svc = q => { const r = psql(DB, ['-c', `set client_min_messages=warning; begin; set local role service_role; ${q}; commit;`]); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const load = f => psql(DB, ['-c', 'set client_min_messages=warning', '-f', F(f)]);
const J = s => { try { return JSON.parse(s); } catch { return s; } };

const RV = '22222222-2222-2222-2222-222222222222', ACC = '11111111-1111-1111-1111-111111111111', ACC2 = '44444444-4444-4444-4444-444444444444';
const ADMIN = 'aaaaaaaa-0000-0000-0000-00000000000a', OWN = 'cccccccc-0000-0000-0000-00000000000c', MGR = 'bbbbbbbb-0000-0000-0000-00000000000b',
  OWN2 = 'dddddddd-0000-0000-0000-00000000000d', X = 'ffffffff-0000-0000-0000-00000000000f';

psql('postgres', ['-c', `drop database if exists ${DB}`]); psql('postgres', ['-c', `create database ${DB}`]);
let r = psql(DB, [], `
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  alter role service_role bypassrls;
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  create table public.owners (user_id uuid primary key);
  create table public.app_status (id int primary key default 1, min_version int not null default 0, message text, updated_at timestamptz default now());
  insert into public.app_status (id) values (1);
  insert into auth.users (id, email) values ('${ADMIN}','me@example.com'),('${OWN}','asha@example.com'),('${MGR}','m@example.com'),
    ('${OWN2}','ravi@example.com'),('${X}','x@example.com');`);
for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql', '07-staff.sql', '08-team.sql',
  '09-calendar.sql', '10-onboarding.sql', '11-legal.sql']) { r = load(f); if (r.err) { ok(f, false, r.err); break; } }
r = sql(`set stay.importing='on';
  insert into stay.platform_admins (user_id) values ('${ADMIN}');
  insert into stay.accounts (id, name, code, migrated_from) values ('${RV}', 'Raaya Vasyam', 'raaya', '${ADMIN}');
  insert into stay.accounts (id, name, code) values ('${ACC}', 'Sea Breeze', 'seabreeze'), ('${ACC2}', 'Hill View', 'hillview');
  insert into stay.members (account_id, user_id, role) values ('${RV}','${ADMIN}','owner'),('${ACC}','${OWN}','owner'),
    ('${ACC}','${MGR}','manager'),('${ACC2}','${OWN2}','owner');
  insert into stay.properties (account_id, id, name, created_at) values ('${RV}','rv1','Raaya Vasyam', now()),
    ('${ACC}','p1','One', now() - interval '3 days'),('${ACC}','p2','Two', now() - interval '2 days'),('${ACC}','p3','Three', now() - interval '1 day');`);
ok('set up', !r.err, r.err);
r = load('12-plans.sql'); ok('12-plans.sql runs', !r.err, r.err);

console.log('\n— the script —');
r = load('13-billing.sql'); ok('13-billing.sql runs', !r.err, r.err);
r = load('13-billing.sql'); ok('runs twice', !r.err, r.err);
const check = psql(DB, ['-F', '|', '-f', F('check.sql')]).out.trim().split('\n').filter(Boolean);
const mine = check.filter(l => /13-billing|billing never/.test(l));
ok('check.sql: both billing rows ok', mine.length === 2 && mine.every(l => /\|ok/.test(l)), mine);
ok('no plan is on sale yet', v(`select count(*) from stay.plans where active`) === '0' && v(`select count(*) from stay.plans`) === '4');
ok('sales closed and GST off to start', v(`select billing_open::text || gst_enabled::text from stay.platform_settings`) === 'falsefalse');
ok('a plan cannot go on sale without a price and a Razorpay plan id', /plans_on_sale_check/.test(v(`update stay.plans set active = true where id = 'pro_monthly'`)));
ok('GST cannot be switched on without a GSTIN', /settings_gst_needs_gstin/.test(v(`update stay.platform_settings set gst_enabled = true`)));

console.log('\n— the admin screen —');
ok('only a platform admin prices a plan', /Platform admins only/.test(asv(OWN, `select stay.admin_save_plan('pro_monthly', 99900, 'plan_P', 5, true)`)));
let p = J(asv(ADMIN, `select stay.admin_save_plan('pro_monthly', 99900, 'plan_PROM', 5, true)`));
ok('the admin prices Pro monthly and puts it on sale', p.active === true && p.amount_paise === 99900, p);
asv(ADMIN, `select stay.admin_save_plan('starter_monthly', 49900, 'plan_STM', 1, true)`);
asv(ADMIN, `select stay.admin_save_plan('pro_yearly', 999900, 'plan_PROY', 5, true)`);
ok('…each change in the admin audit log', v(`select count(*) from stay.admin_audit where action = 'save_plan'`) === '3');
ok('only a platform admin changes the settings', /Platform admins only/.test(asv(OWN, `select stay.admin_save_settings('{"billing_open":true}')`)));
let st = J(asv(ADMIN, `select stay.admin_save_settings('{"billing_open":true}')`));
ok('the admin opens sales (audited)', st.billing_open === true && v(`select count(*) from stay.admin_audit where action = 'save_settings'`) === '1');
ok('a signed-in owner reads only the plans on sale', asv(OWN, `select string_agg(id, ',' order by sort) from stay.plans`) === 'starter_monthly,pro_monthly,pro_yearly');
ok('the admin reads every plan', asv(ADMIN, `select count(*) from stay.plans`) === '4');
ok('nobody signed out reads plans', /permission denied/.test(psql(DB, ['-c', `set role anon; select * from stay.plans`]).err));
ok('the app cannot change a plan or the settings directly', /permission denied/.test(asv(ADMIN, `update stay.plans set amount_paise = 1`))
  && /permission denied/.test(asv(ADMIN, `update stay.platform_settings set gst_enabled = false`)));

console.log('\n— who may order —');
const prep = (acct, user, plan) => J(svc(`select stay.billing_prepare('${acct}', '${user}', ${plan ? `'${plan}'` : 'null'})`));
ok('a manager cannot buy', /Only the owner/.test(prep(ACC, MGR, 'pro_monthly').error));
ok('a stranger cannot buy', /Only the owner/.test(prep(ACC, X, 'pro_monthly').error));
ok('Raaya Vasyam has no billing', /no billing/.test(prep(RV, ADMIN, 'pro_monthly').error));
ok('a plan not on sale', /not on sale/.test(prep(ACC, OWN, 'starter_yearly').error));
p = prep(ACC, OWN, 'pro_monthly');
ok('the owner may buy a plan on sale (its Razorpay plan id)', p.razorpay_plan_id === 'plan_PROM' && p.period === 'monthly', p);
asv(ADMIN, `select stay.admin_save_settings('{"billing_open":false}')`);
ok('sales closed: owners are told so', /not open yet/.test(prep(ACC, OWN, 'pro_monthly').error));
ok('…a platform admin may still test', !prep(RV, ADMIN, 'pro_monthly').error || /no billing/.test(prep(RV, ADMIN, 'pro_monthly').error));
asv(ADMIN, `select stay.admin_save_settings('{"billing_open":true}')`);
ok('the app cannot call the server\'s functions', /permission denied/.test(asv(OWN, `select stay.billing_prepare('${ACC}', '${OWN}', 'pro_monthly')`))
  && /permission denied/.test(asv(OWN, `select stay.billing_record('e', '{}')`)) && /permission denied/.test(asv(OWN, `select stay.billing_sweep()`)));
svc(`select stay.billing_pending('${ACC}', 'sub_A')`);
ok('an order is noted as pending', J(asv(OWN, `select stay.billing_state('${ACC}')`)).pending === true);
ok('billing_state is the owner\'s only', asv(MGR, `select stay.billing_state('${ACC}')`) === '' && asv(X, `select stay.billing_state('${ACC}')`) === '');

console.log('\n— Razorpay events —');
const evt = (id, event, sub, o = {}) => svc(`select stay.billing_record('${id}', jsonb_build_object(
  'entity','event','event','${event}','created_at', extract(epoch from now() + interval '${o.at || '0 seconds'}')::bigint,
  'payload', jsonb_build_object('subscription', jsonb_build_object('entity', jsonb_build_object('id','${sub}','plan_id','${o.plan || 'plan_PROM'}',
     'customer_id','cust_1','current_start', extract(epoch from now())::bigint,
     'current_end', extract(epoch from now() + interval '${o.end || '30 days'}')::bigint,
     'notes', ${o.acct === null ? `'{}'::jsonb` : `jsonb_build_object('account_id','${o.acct || ACC}')`}))
     ${o.pay ? `, 'payment', jsonb_build_object('entity', jsonb_build_object('id','${o.pay}','amount',${o.amount || 99900},'currency','INR','invoice_id','inv_1'))` : ''})))`);
const acct = (id = ACC) => J(v(`select to_jsonb(a) from stay.accounts a where id = '${id}'`));
const canw = (id = ACC) => v(`select stay.account_can_write('${id}')`);
sql(`update stay.accounts set trial_ends_at = now() - interval '1 day' where id = '${ACC}'`);
ok('(the trial has ended: read-only)', canw() === 'f');
r = J(evt('evt_1', 'subscription.authenticated', 'sub_A'));
ok('authenticated: on order', r.result === 'on order' && acct().pending_subscription_id === 'sub_A', r);
r = J(evt('evt_2', 'subscription.activated', 'sub_A', { at: '1 second' }));
let a = acct();
ok('activated: Pro, active, paid for 30 days, 5 properties', r.result === 'active' && a.plan === 'pro' && a.status === 'active'
  && a.properties_allowed === 5 && a.subscription_plan_id === 'pro_monthly' && a.razorpay_subscription_id === 'sub_A' && !a.pending_subscription_id, { r, a });
ok('…and the account can be written again', canw() === 't');
ok('a repeat delivery changes nothing', J(evt('evt_2', 'subscription.activated', 'sub_A', { at: '1 second' })).result === 'duplicate'
  && v(`select count(*) from stay.billing_events where event_id = 'evt_2'`) === '1');
r = J(evt('evt_3', 'subscription.charged', 'sub_A', { at: '2 seconds', pay: 'pay_1' }));
const fy = v(`select stay.financial_year_of(now())`);
let inv = J(v(`select to_jsonb(i) from stay.invoices i where razorpay_payment_id = 'pay_1'`));
ok('charged: one invoice, numbered for the financial year', inv.number === `SL/${fy}/0001` && inv.amount_paise === 99900 && inv.account_id === ACC, inv);
ok('…a receipt, not a tax invoice, while GST is off', inv.tax_invoice === false && inv.gst_paise === 0 && inv.taxable_paise === 99900);
ok('…with the seller and buyer as they stood', inv.seller.name === 'Rakshit Poojari' && inv.buyer.name === 'Sea Breeze');
evt('evt_3b', 'subscription.charged', 'sub_A', { at: '3 seconds', pay: 'pay_1' });
ok('the same payment in another event: still one invoice', v(`select count(*) from stay.invoices where razorpay_payment_id = 'pay_1'`) === '1');
asv(ADMIN, `select stay.admin_save_settings('{"seller_gstin":"06ABCDE1234F1Z5","gst_enabled":true,"sac_code":"998314"}')`);
evt('evt_4', 'subscription.charged', 'sub_A', { at: '4 seconds', pay: 'pay_2', amount: 118000 });
inv = J(v(`select to_jsonb(i) from stay.invoices i where razorpay_payment_id = 'pay_2'`));
ok('GST on: a tax invoice, 18% inside the amount (₹1,180 = ₹1,000 + ₹180)', inv.number === `SL/${fy}/0002` && inv.tax_invoice === true
  && inv.taxable_paise === 100000 && inv.gst_paise === 18000 && inv.seller.gstin === '06ABCDE1234F1Z5', inv);
asv(ADMIN, `select stay.admin_save_settings('{"gst_enabled":false}')`);
ok('the owner reads their invoices', asv(OWN, `select count(*) from stay.invoices`) === '2');
ok('a manager and another owner read none', asv(MGR, `select count(*) from stay.invoices`) === '0' && asv(OWN2, `select count(*) from stay.invoices`) === '0');
ok('invoices are append-only, even for the database owner', /append-only/.test(v(`update stay.invoices set amount_paise = 1`))
  && /append-only/.test(v(`delete from stay.invoices`)));
ok('events are append-only, even for the database owner', /append-only/.test(v(`delete from stay.billing_events`)));
ok('the app reads no events; the admin does', asv(OWN, `select count(*) from stay.billing_events`) === '0' && Number(asv(ADMIN, `select count(*) from stay.billing_events`)) >= 4);
ok('the app writes no events or invoices', /permission denied/.test(asv(ADMIN, `insert into stay.billing_events (event_id, event, payload, result) values ('x','x','{}','x')`)));

r = J(evt('evt_old', 'subscription.halted', 'sub_A', { at: '-1 hour' }));
ok('an older event changes nothing', r.result === 'older event' && acct().status === 'active', r);
r = J(evt('evt_5', 'subscription.pending', 'sub_A', { at: '5 seconds' }));
a = acct();
const grace1 = a.grace_ends_at;
ok('pending: payment due, 3 days\' grace past the period, still writes', a.status === 'past_due' && !!grace1 && canw() === 't', a);
evt('evt_6', 'subscription.halted', 'sub_A', { at: '6 seconds' });
ok('halted: the grace is kept, not started again', acct().grace_ends_at === grace1 && acct().status === 'past_due');
evt('evt_7', 'subscription.charged', 'sub_A', { at: '7 seconds', pay: 'pay_3' });
ok('charged again: active, grace gone', acct().status === 'active' && acct().grace_ends_at === null);

r = J(evt('evt_8', 'subscription.activated', 'sub_B', { at: '8 seconds' }));
ok('a second subscription while one is live: answered "cancel it", account unchanged', r.result === 'second subscription'
  && r.cancel_subscription === 'sub_B' && acct().razorpay_subscription_id === 'sub_A', r);
ok('ordering again while a plan is live is refused', /already have a plan/.test(prep(ACC, OWN, 'pro_yearly').error));

svc(`select stay.billing_cancelling('${ACC}')`);
ok('cancel: runs to the period\'s end', acct().cancel_at_period_end === true && acct().status === 'active' && canw() === 't');
r = J(evt('evt_9', 'subscription.cancelled', 'sub_A', { at: '9 seconds' }));
ok('…and the cancelled event keeps it running till then', acct().status === 'active' && acct().cancel_at_period_end === true && canw() === 't', r);
ok('a new order is allowed once the live one is cancelling', prep(ACC, OWN, 'pro_yearly').razorpay_plan_id === 'plan_PROY');
sql(`update stay.accounts set current_period_end = now() - interval '1 minute' where id = '${ACC}'`);
r = J(svc(`select stay.billing_sweep()`));
ok('the sweep: a cancelled plan past its end is cancelled, read-only', acct().status === 'cancelled' && !!acct().inactive_since && canw() === 'f', r);
r = J(evt('evt_10', 'subscription.activated', 'sub_C', { at: '10 seconds', plan: 'plan_STM' }));
a = acct();
ok('subscribing again (Starter): active, 1 property allowed, the newest two paused (rule B)', a.plan === 'starter' && a.properties_allowed === 1
  && v(`select string_agg(id, ',' order by id) from stay.properties where account_id = '${ACC}' and paused`) === 'p2,p3', a);
r = J(evt('evt_11', 'subscription.cancelled', 'sub_A', { at: '11 seconds' }));
ok('an event of the old subscription is ignored', r.result === 'old subscription ignored' && acct().status === 'active');
r = J(evt('evt_12', 'subscription.activated', 'sub_Z', { at: '12 seconds', acct: null }));
ok('an event naming no known account changes nothing', r.result === 'unknown account');
r = J(evt('evt_13', 'subscription.halted', 'sub_RV', { at: '13 seconds', acct: RV }));
ok('Raaya Vasyam: never touched by an event', r.result === 'owner plan untouched' && acct(RV).plan === 'owner' && canw(RV) === 't');

console.log('\n— the sweep —');
sql(`update stay.accounts set status = 'active', cancel_at_period_end = false, current_period_end = now() - interval '1 hour' where id = '${ACC}'`);
svc(`select stay.billing_sweep()`);
ok('a period run out with no renewal heard of: payment due with grace, not an end', acct().status === 'past_due' && canw() === 't');
sql(`update stay.accounts set grace_ends_at = now() - interval '1 minute' where id = '${ACC}'`);
svc(`select stay.billing_sweep()`);
ok('…and expired when the grace has gone', acct().status === 'expired' && canw() === 'f');
sql(`update stay.accounts set trial_ends_at = now() - interval '1 minute' where id = '${ACC2}'`);
svc(`select stay.billing_sweep()`);
ok('a trial past its end: expired', acct(ACC2).status === 'expired' && !!acct(ACC2).inactive_since);
sql(`update stay.accounts set status = 'active', current_period_end = now() - interval '1 year' where id = '${RV}'`);
svc(`select stay.billing_sweep()`);
ok('Raaya Vasyam: never swept, whatever its dates', acct(RV).status === 'active' && canw(RV) === 't');

console.log('\n— the owner\'s GSTIN —');
ok('the owner sets their GSTIN', asv(OWN, `update stay.accounts set gstin = '29ABCDE1234F1Z5' where id = '${ACC}'`) === '' && acct().gstin === '29ABCDE1234F1Z5');
ok('a malformed one is refused', /accounts_gstin_check/.test(asv(OWN, `update stay.accounts set gstin = 'nope' where id = '${ACC}'`)));
ok('a manager cannot set it', asv(MGR, `update stay.accounts set gstin = null where id = '${ACC}' returning 1`) === '' && acct().gstin === '29ABCDE1234F1Z5');
ok('the app cannot set the billing columns', /permission denied/.test(asv(OWN, `update stay.accounts set status = 'active' where id = '${ACC}'`))
  && /permission denied/.test(asv(OWN, `update stay.accounts set razorpay_subscription_id = 'x' where id = '${ACC}'`))
  && /permission denied/.test(asv(OWN, `update stay.accounts set cancel_at_period_end = false where id = '${ACC}'`)));

console.log('\n— one trial per business —');
const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
const NEWA = '55555555-5555-5555-5555-555555555555', NEWB = '66666666-6666-6666-6666-666666666666';
sql(`insert into stay.accounts (id, name, code) values ('${NEWA}', 'New A', 'newa'), ('${NEWB}', 'New B', 'newb')`);
r = J(svc(`select stay.trial_fingerprint('${NEWA}', 'email', array['${H1}'])`));
ok('a new email: the trial stands', r.repeat === false && canw(NEWA) === 't');
r = J(svc(`select stay.trial_fingerprint('${NEWB}', 'email', array['${H1}'])`));
ok('the same email again: no free trial (read-only until it subscribes), flagged', r.repeat === true && r.trial === false
  && canw(NEWB) === 'f' && acct(NEWB).trial_repeat_of === NEWA, r);
ok('…the same account again is not a repeat', J(svc(`select stay.trial_fingerprint('${NEWA}', 'email', array['${H1}'])`)).repeat === false);
r = J(svc(`select stay.trial_fingerprint('${NEWA}', 'airbnb_listing', array['${H2}'])`));
sql(`update stay.accounts set trial_ends_at = now() + interval '5 days', trial_repeat_of = null where id = '${NEWB}'`);
r = J(svc(`select stay.trial_fingerprint('${NEWB}', 'airbnb_listing', array['${H2}'])`));
ok('an Airbnb listing seen before: flagged only, the trial stands', r.repeat === true && canw(NEWB) === 't' && acct(NEWB).trial_repeat_of === NEWA);
ok('only hashes are kept (64 hex)', /violates check/.test(svc(`select stay.trial_fingerprint('${NEWA}', 'email', array['asha@example.com'])`)));
ok('nobody signed in reads the fingerprints', /permission denied/.test(asv(ADMIN, `select * from stay.trial_fingerprints`)));
let ab = J(asv(ADMIN, `select stay.admin_billing()`));
ok('the admin sees repeats, invoices and the last event per account', ab[NEWB].repeat_trial === true && ab[NEWB].repeat_of === 'New A'
  && ab[ACC].invoices === 3 && !!ab[ACC].last_event, ab[ACC]);
ok('admin_billing is the admin\'s only', /Platform admins only/.test(asv(OWN, `select stay.admin_billing()`)));

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
