/* Stage 4 of billing and data protection (v77) on a real Postgres:
   supabase/stay/15-privacy.sql.
     - runs twice; check.sql's row ok; min_version 77; changes no stored data
     - Aadhaar: any new or changed number is kept as "XXXX XXXX 1234" — from
       the app's role or the server's key; any 12 digits under another type
       too; a passport is untouched; an old row edited elsewhere keeps its
       number until the counted run; count first, then mask only with the
       confirmation, audited, versions bumped so phones pull it
     - the audit log: team, invites (never the invite code), staff logins and
       settings (field names, not values); what the app reports (numbers
       only); who reads what; append-only even for the database owner; only
       rows over a year old removed; sign-ins copied once
     - support access: only with the owner's live grant (1–7 days), allowed
       tables, secrets left out, every read logged and shown to the owner;
       revoked or expired → refused
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_privacy_sql.js */
const { execFileSync } = require('child_process');
const path = require('path');
const F = n => path.resolve(__dirname, '../supabase/stay/' + n);
const CONN = (process.env.STAYLOG_PG || '').split(/\s+/).filter(Boolean);
if (!CONN.length) { console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const DB = 'staylog_privacy_test';
const psql = (db, args, input) => { try { return { out: execFileSync('psql', [...CONN, '-d', db, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args],
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; } };
const sql = s => psql(DB, ['-c', 'set client_min_messages=warning;' + s]);
const v = s => { const r = sql(s); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const as = (uid, q) => { const r = psql(DB, ['-c', `set client_min_messages=warning; begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
  return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const svc = q => { const r = psql(DB, ['-c', `set client_min_messages=warning; begin; set local role service_role; ${q}; commit;`]); return r.err ? 'ERR: ' + r.err.split('\n')[0] : r.out.trim(); };
const load = f => psql(DB, ['-c', 'set client_min_messages=warning', '-f', F(f)]);
const J = s => { try { return JSON.parse(s); } catch { return s; } };
const RV = '22222222-2222-2222-2222-222222222222', ACC = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'aaaaaaaa-0000-0000-0000-00000000000a', OWN = 'cccccccc-0000-0000-0000-00000000000c', MGR = 'bbbbbbbb-0000-0000-0000-00000000000b',
  X = 'ffffffff-0000-0000-0000-00000000000f', NEWM = 'dddddddd-0000-0000-0000-00000000000d';

psql('postgres', ['-c', `drop database if exists ${DB}`]); psql('postgres', ['-c', `create database ${DB}`]);
let r = psql(DB, [], `
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  alter role service_role bypassrls;
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  create table auth.audit_log_entries (instance_id uuid, id uuid primary key, payload json, created_at timestamptz, ip_address text);
  grant usage on schema public, auth to anon, authenticated, service_role;
  create table public.owners (user_id uuid primary key);
  create table public.app_status (id int primary key default 1, min_version int not null default 0, message text, updated_at timestamptz default now());
  insert into public.app_status (id) values (1);
  insert into auth.users (id, email) values ('${ADMIN}','me@example.com'),('${OWN}','asha@example.com'),('${MGR}','m@example.com'),
    ('${X}','x@example.com'),('${NEWM}','new@example.com');`);
for (const f of ['01-schema.sql', '02-functions.sql', '03-access.sql', '04-phase2.sql', '05-migrate.sql', '07-staff.sql', '08-team.sql',
  '09-calendar.sql', '10-onboarding.sql', '11-legal.sql', '12-plans.sql', '13-billing.sql', '14-paid-on.sql']) { r = load(f); if (r.err) { ok(f, false, r.err); break; } }
const bk = (acct, id, type, num, notes = null) => `('${acct}','${id}','p1','Guest','2026-12-01','2026-12-03',${type ? `'${type}'` : 'null'},${num ? `'${num}'` : 'null'},${notes ? `'${notes}'` : 'null'})`;
r = sql(`set stay.importing='on';
  insert into stay.platform_admins (user_id) values ('${ADMIN}');
  insert into stay.accounts (id, name, code, migrated_from) values ('${RV}', 'Raaya Vasyam', 'raaya', '${ADMIN}');
  insert into stay.accounts (id, name, code) values ('${ACC}', 'Sea Breeze', 'seabreeze');
  insert into stay.members (account_id, user_id, role) values ('${RV}','${ADMIN}','owner'),('${ACC}','${OWN}','owner'),('${ACC}','${MGR}','manager');
  insert into stay.properties (account_id, id, name, wifi_password, bank_details) values ('${RV}','p1','Raaya Vasyam','secret-wifi','A/c 123'),('${ACC}','p1','Sea Breeze','sea-wifi','A/c 456');
  insert into stay.bookings (account_id, id, property_id, guest_name, check_in, check_out, id_proof_type, id_proof_number, notes) values
    ${bk(RV, 'old1', 'Aadhaar', '1234 5678 9012')}, ${bk(RV, 'old2', 'Aadhaar', '234567890123')}, ${bk(ACC, 'old3', 'Other', '3456-7890-1234')},
    ${bk(RV, 'pass', 'Passport', 'Z1234567')}, ${bk(RV, 'note', null, null, 'Aadhaar 4567 8901 2345 seen')};`);
ok('set up (with full Aadhaar numbers stored before 15)', !r.err, r.err);

console.log('\n— the script —');
const before = v(`select string_agg(id || '=' || coalesce(id_proof_number,'') || '@' || version, ',' order by id) from stay.bookings`);
r = load('15-privacy.sql'); ok('15-privacy.sql runs', !r.err, r.err);
r = load('15-privacy.sql'); ok('runs twice', !r.err, r.err);
ok('it changes no stored number by itself', v(`select string_agg(id || '=' || coalesce(id_proof_number,'') || '@' || version, ',' order by id) from stay.bookings`) === before);
const row = psql(DB, ['-F', '|', '-f', F('check.sql')]).out.split('\n').find(l => /15-privacy/.test(l)) || '';
ok('check.sql: its row ok', /\|ok$/.test(row), row);
ok('min_version 77 in the new model', v(`select min_version from public.app_status`) === '0'
  ? (sql(`alter table public.app_status add column if not exists model text; update public.app_status set model = 'stay'`), load('15-privacy.sql'), v(`select min_version from public.app_status`) === '77') : false);

console.log('\n— Aadhaar: the last 4 digits only —');
const num = id => v(`select id_proof_number from stay.bookings where id = '${id}'`);
as(OWN, `insert into stay.bookings (account_id, id, property_id, guest_name, check_in, check_out, id_proof_type, id_proof_number)
  values ('${ACC}','n1','p1','Ravi','2026-12-05','2026-12-07','Aadhaar','9876 5432 1098')`);
ok('typed in the app (the app\'s role): kept as XXXX XXXX 1098', num('n1') === 'XXXX XXXX 1098', num('n1'));
svc(`insert into stay.bookings (account_id, id, property_id, guest_name, check_in, check_out, id_proof_type, id_proof_number)
  values ('${ACC}','n2','p1','Mina','2026-12-08','2026-12-09','Aadhaar','876543210987')`);
ok('…and through the server\'s own key', num('n2') === 'XXXX XXXX 0987');
as(OWN, `insert into stay.bookings (account_id, id, property_id, guest_name, check_in, check_out, id_proof_type, id_proof_number)
  values ('${ACC}','n3','p1','Joe','2026-12-10','2026-12-11','Other','7654 3210 9876')`);
ok('12 digits under another type are shortened too', num('n3') === 'XXXX XXXX 9876');
as(OWN, `insert into stay.bookings (account_id, id, property_id, guest_name, check_in, check_out, id_proof_type, id_proof_number)
  values ('${ACC}','n4','p1','Ann','2026-12-12','2026-12-13','Passport','K9876543')`);
ok('a passport number is kept as typed', num('n4') === 'K9876543');
as(OWN, `insert into stay.bookings (account_id, id, property_id, guest_name, check_in, check_out, id_proof_type, id_proof_number)
  values ('${ACC}','n5','p1','Bo','2026-12-14','2026-12-15','Aadhaar','XXXX XXXX 4321')`);
ok('an already short number stays as it is', num('n5') === 'XXXX XXXX 4321');
as(OWN, `update stay.bookings set id_proof_number = '1111 2222 3333' where account_id = '${ACC}' and id = 'n4'`);
ok('changing a number to a full Aadhaar one: shortened', num('n4') === 'XXXX XXXX 3333');
sql(`update stay.bookings set notes = 'late arrival' where id = 'old1'`);
ok('an old booking edited elsewhere keeps its number until the counted run', num('old1') === '1234 5678 9012');
const c = J(v(`select stay.aadhaar_count()`));
ok('the count: 3 full numbers, 1 note with a 12-digit number, by account', c.full_numbers === 3 && c.notes_with_a_12_digit_number === 1
  && c.by_account['Raaya Vasyam'] === 2 && c.by_account['Sea Breeze'] === 1, c);
ok('the app cannot count or shorten', /permission denied/.test(as(OWN, `select stay.aadhaar_count()`)) && /permission denied/.test(as(ADMIN, `select stay.mask_aadhaar('I have a fresh backup')`)));
ok('without the confirmation nothing is changed', /Count first/.test(v(`select stay.mask_aadhaar('yes')`)) && num('old2') === '234567890123');
const v0 = v(`select version from stay.bookings where id = 'old2'`);
sql(`update stay.accounts set trial_ends_at = now() - interval '1 day' where id = '${ACC}'`);       // read-only now
const m = J(v(`select stay.mask_aadhaar('I have a fresh backup')`));
ok('with it: every full number shortened, a read-only account\'s too', m.shortened === 3 && m.left === 0 && num('old1') === 'XXXX XXXX 9012'
  && num('old2') === 'XXXX XXXX 0123' && num('old3') === 'XXXX XXXX 1234', m);
ok('…their versions moved, so every phone pulls the short number', Number(v(`select version from stay.bookings where id = 'old2'`)) > Number(v0));
ok('…notes and passports untouched', num('pass') === 'Z1234567' && /4567 8901 2345/.test(v(`select notes from stay.bookings where id = 'note'`)));
ok('…and the run is in the audit log (a count, no numbers)', v(`select detail->>'bookings' from stay.audit_log where action = 'aadhaar_masked'`) === '3');
sql(`update stay.accounts set trial_ends_at = now() + interval '5 days' where id = '${ACC}'`);

console.log('\n— the audit log —');
as(OWN, `insert into stay.members (account_id, user_id, role, permissions) values ('${ACC}','${NEWM}','manager','{"see_money":false}')`);
ok('a manager added: logged with who, role and permissions', v(`select actor || '|' || (detail->>'role') from stay.audit_log where action = 'members.insert' and target = '${NEWM}'`) === `${OWN}|manager`);
as(OWN, `update stay.members set permissions = '{"see_money":true}' where account_id = '${ACC}' and user_id = '${NEWM}'`);
ok('permissions changed: logged with the new set', v(`select detail->'permissions'->>'see_money' from stay.audit_log where action = 'members.update' and target = '${NEWM}'`) === 'true');
as(OWN, `insert into stay.invites (code, account_id, role, label) values ('SECRETCODE1234567890', '${ACC}', 'manager', 'Priya')`);
const inv = v(`select target || ' ' || detail::text from stay.audit_log where action = 'invites.insert'`);
ok('an invite: logged, but never its code (the secret in the link)', /^invite:[0-9a-f]{10} /.test(inv) && !inv.includes('SECRETCODE'), inv);
as(OWN, `update stay.accounts set name = 'Sea Breeze Stays' where id = '${ACC}'`);
const setl = J(v(`select detail from stay.audit_log where action = 'accounts.update'`));
ok('account settings: which fields changed, not their values', JSON.stringify(setl.changed) === '["name"]' && !JSON.stringify(setl).includes('Sea Breeze'), setl);
as(OWN, `select stay.log_event('${ACC}', 'export_everything', '{"bookings":12,"name":"Anita Rao"}')`);
const ex = J(v(`select detail from stay.audit_log where action = 'export_everything'`));
ok('an export the app reports: numbers only (a name is dropped)', ex.bookings === 12 && !('name' in ex), ex);
ok('an unknown event, or from a stranger: refused', /Unknown event/.test(as(OWN, `select stay.log_event('${ACC}', 'anything', '{}')`))
  && /Not a member/.test(as(X, `select stay.log_event('${ACC}', 'export_everything', '{}')`)));
ok('the owner reads their account\'s log; a manager and a stranger read none of it', Number(as(OWN, `select count(*) from stay.audit_log where account_id = '${ACC}'`)) >= 5
  && as(MGR, `select count(*) from stay.audit_log where account_id = '${ACC}'`) === '0' && as(X, `select count(*) from stay.audit_log`) === '0');
ok('nobody writes it directly', /permission denied/.test(as(OWN, `insert into stay.audit_log (action) values ('x')`)));
ok('append-only, even for the database owner', /append-only/.test(v(`update stay.audit_log set action = 'x'`)) && /append-only/.test(v(`delete from stay.audit_log`)));
sql(`insert into stay.audit_log (at, action) values (now() - interval '400 days', 'ancient'), (now() - interval '300 days', 'recent')`);
sql(`insert into auth.audit_log_entries (id, payload, created_at) values
  ('${'1'.repeat(8)}-1111-1111-1111-111111111111', '{"action":"login","actor_id":"${OWN}"}', now() - interval '1 hour'),
  ('${'2'.repeat(8)}-2222-2222-2222-222222222222', '{"action":"token_refreshed","actor_id":"${OWN}"}', now() - interval '1 hour')`);
let hk = J(svc(`select stay.audit_housekeeping()`));
ok('housekeeping: rows over a year old go, the rest stay', v(`select count(*) from stay.audit_log where action = 'ancient'`) === '0'
  && v(`select count(*) from stay.audit_log where action = 'recent'`) === '1' && hk.removed === 1, hk);
ok('…sign-ins copied (not token refreshes)', hk.signins_copied === 1 && v(`select count(*) from stay.audit_log where action = 'auth.login' and actor = '${OWN}'`) === '1');
hk = J(svc(`select stay.audit_housekeeping()`));
ok('…once each', hk.signins_copied === 0 && v(`select count(*) from stay.audit_log where action = 'auth.login'`) === '1');
ok('a member reads their own sign-ins', as(OWN, `select count(*) from stay.audit_log where action = 'auth.login'`) === '1' && as(MGR, `select count(*) from stay.audit_log where action = 'auth.login'`) === '0');

console.log('\n— support access —');
ok('without a grant, the platform admin reads nothing', /not allowed support access/.test(as(ADMIN, `select stay.support_read('${ACC}', 'bookings', 10)`)));
ok('…and has no other way in (row-level security)', as(ADMIN, `select count(*) from stay.bookings where account_id = '${ACC}'`) === '0');
ok('only the owner grants it, for 1 to 7 days', /Only the owner/.test(as(MGR, `select stay.grant_support('${ACC}', 7)`))
  && /Between 1 and 7/.test(as(OWN, `select stay.grant_support('${ACC}', 8)`)));
let st = J(as(OWN, `select stay.grant_support('${ACC}', 7, 'Bookings not showing')`));
ok('granted: live, with its end and note, and logged', st.live && st.live.note === 'Bookings not showing'
  && v(`select count(*) from stay.audit_log where action = 'support_granted' and account_id = '${ACC}'`) === '1', st);
ok('the admin sees which accounts let support in', J(as(ADMIN, `select stay.support_accounts()`)).some(a => a.account === ACC));
const rows = J(as(ADMIN, `select stay.support_read('${ACC}', 'bookings', 10)`));
ok('the admin reads the account\'s bookings under it', Array.isArray(rows) && rows.length >= 5 && rows.every(x => x.account_id === ACC), rows.length);
const props = J(as(ADMIN, `select stay.support_read('${ACC}', 'properties', 10)`));
ok('…secrets left out (Wi-Fi password, bank details)', props.length === 1 && !('wifi_password' in props[0]) && !('bank_details' in props[0]) && props[0].name === 'Sea Breeze', props);
ok('…calendar links not readable at all', /Not readable/.test(as(ADMIN, `select stay.support_read('${ACC}', 'ical_feeds', 10)`)));
ok('…every read logged, and the owner sees them', J(as(OWN, `select stay.support_state('${ACC}')`)).reads.length === 2
  && v(`select string_agg(target || ':' || (detail->>'rows'), ',' order by id) from stay.audit_log where action = 'support_read'`).startsWith('bookings:'));
ok('only platform admins call support_read', /Platform admins only/.test(as(OWN, `select stay.support_read('${ACC}', 'bookings', 10)`)));
as(OWN, `select stay.revoke_support('${ACC}')`);
ok('the owner stops it: refused again, logged', /not allowed support access/.test(as(ADMIN, `select stay.support_read('${ACC}', 'bookings', 10)`))
  && v(`select count(*) from stay.audit_log where action = 'support_revoked'`) === '1');
as(OWN, `select stay.grant_support('${ACC}', 1)`);
sql(`update stay.support_grants set expires_at = now() - interval '1 minute' where account_id = '${ACC}' and revoked_at is null`);
ok('an expired grant: refused', /not allowed support access/.test(as(ADMIN, `select stay.support_read('${ACC}', 'bookings', 10)`)));
ok('nobody writes grants directly', /permission denied/.test(as(OWN, `insert into stay.support_grants (account_id, granted_by, expires_at) values ('${ACC}','${OWN}', now() + interval '30 days')`)));

if (!process.env.KEEP_DB) psql('postgres', ['-c', `drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
