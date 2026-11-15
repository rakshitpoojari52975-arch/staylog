/* supabase/security-v60.sql on a real Postgres (review, Appendix A §1), after
   every script the live project has run, with stand-ins for what Supabase
   provides. A signed-in account that is not an owner — her staff login, or a
   stranger who signed up — reads and writes nothing; her page still works;
   staff_standing matches by owner; a mark's id must be its staff and date;
   the script refuses to lock the owner out, runs twice, and changes no data.

     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_security_sql.js
   Without STAYLOG_PG it says so and skips. Uses its own database. */
const {execFileSync}=require('child_process');
const path=require('path');
const F=n=>path.resolve(__dirname,'../supabase/'+n);
const CONN=(process.env.STAYLOG_PG||'').split(/\s+/).filter(Boolean);
if(!CONN.length){console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).');process.exit(0);}
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const psql=(db,args,input)=>{try{return{out:execFileSync('psql',[...CONN,'-d',db,'-q','-t','-A','-v','ON_ERROR_STOP=1',...args],
  {input,encoding:'utf8',stdio:['pipe','pipe','pipe']}),err:''};}catch(e){return{out:'',err:String(e.stderr||e.message)};}};
const DB='staylog_security_test', OWNER='11111111-1111-1111-1111-111111111111', HER='33333333-3333-3333-3333-333333333333',
  STRANGER='44444444-4444-4444-4444-444444444444', OTHER='55555555-5555-5555-5555-555555555555';
const as=(uid,q,role='authenticated')=>psql(DB,['-c',`begin; set local role ${role}; set local request.jwt.uid='${uid}'; ${q}; rollback;`]);
const asCommit=(uid,q)=>psql(DB,['-c',`begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
const sql=s=>psql(DB,[],s);
const n=r=>r.err?'error':r.out.trim();
const json=r=>{try{return JSON.parse(r.out.trim().split('\n').pop());}catch{return null;}};
const today=`(now() at time zone 'Asia/Kolkata')::date`;

psql('postgres',['-c',`drop database if exists ${DB}`]);
psql('postgres',['-c',`create database ${DB}`]);
let r=sql(`
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  grant usage on schema public, auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  insert into auth.users(id) values ('${OWNER}'),('${HER}'),('${STRANGER}'),('${OTHER}');`);
ok('Supabase stand-ins are in place', !r.err, r.err);
for(const f of ['setup.sql','attendance.sql','checkout-wage.sql','utensils.sql','ical.sql','push.sql','inbox.sql','backups.sql']){
  r=psql(DB,['-f',F(f)]); ok(f+' loads', !r.err, r.err);}
r=sql(`insert into public.properties (id,owner_id,name) values ('p1','${OWNER}','Raaya Vasyam');
  insert into public.staff (id,owner_id,name,daily_wage) values ('stf1','${OWNER}','Laxmi Walikar',300);
  insert into public.staff_access (user_id,owner_id,staff_id,display_name) values ('${HER}','${OWNER}','stf1','Laxmi');
  insert into public.bookings (id,owner_id,property_id,guest_name,check_in,check_out,guests,status)
    values ('b1','${OWNER}','p1','Anita Rao',${today}+1,${today}+3,2,'confirmed');
  insert into public.expenses (id,owner_id,property_id,description,date,amount,category,staff_id,paid)
    values ('wag_stf1_20261101','${OWNER}','p1','Wage — Laxmi',${today}-3,300,'staff','stf1',false);
  -- a stray row under another account carrying her staff_id: before v60 it showed on her page
  insert into public.expenses (id,owner_id,description,date,amount,category,staff_id,paid)
    values ('x_other','${OTHER}','Not hers',${today}-2,999,'staff','stf1',false);
  insert into public.attendance (id,owner_id,staff_id,date) values ('legacy_odd_id','${OWNER}','stf1','2026-01-05');
  insert into public.attendance (id,owner_id,staff_id,date) values ('att_stf1_20260106','${OWNER}','stf1','2026-01-06');`);
ok('seeded, with one old mark whose id does not fit the rule', !r.err, r.err);
const dataBefore=sql(`select md5(string_agg(t::text,'|' order by t::text)) from (
  select row_to_json(x)::text t from public.bookings x union all select row_to_json(x)::text from public.expenses x
  union all select row_to_json(x)::text from public.attendance x union all select row_to_json(x)::text from public.staff x) s`).out.trim();

console.log('\n— it will not lock the owner out —');
r=psql(DB,['-f',F('security-v60.sql')]);
ok('with public.owners empty it refuses, naming the fix', /public\.owners is empty/.test(r.err), r.err);
ok('and changes nothing', sql(`select count(*) from pg_policies where policyname='owners only'`).out.trim()==='0'
   &&sql(`select to_regclass('public.app_status') is null`).out.trim()==='t');
sql(`insert into public.owners (user_id) values ('${OWNER}')`);
r=psql(DB,['-f',F('checkout-wage.sql')]);   // an older staff_standing, without the owner match
r=psql(DB,['-f',F('security-v60.sql')]);
ok('with an old staff_standing in place it refuses: run utensils.sql first', /Run supabase\/utensils\.sql first/.test(r.err), r.err);
r=psql(DB,['-f',F('utensils.sql')]); ok('utensils.sql (the v60 staff_standing) loads', !r.err, r.err);

console.log('\n— runs, and runs again —');
r=psql(DB,['-f',F('security-v60.sql')]); ok('first run', !r.err, r.err);
{ const sp=require('child_process').spawnSync('psql',[...CONN,'-d',DB,'-q','-f',F('security-v60.sql')],{encoding:'utf8'});
  ok('it names the old mark whose id does not fit, and leaves it', /legacy_odd_id/.test(sp.stderr||''), sp.stderr); }
ok('so the rule holds for new rows but is not claimed for old ones (not validated)',
   sql(`select convalidated from pg_constraint where conname='attendance_id_matches'`).out.trim()==='f');
r=psql(DB,['-f',F('security-v60.sql')]); ok('second run', !r.err, r.err);
const check=r.out.trim().split('\n').filter(Boolean);
ok('its check says ok for every table', check.length>=15&&check.every(l=>/\|ok$/.test(l)), check);
ok('sync_status gains device_id and device_name', sql(`select count(*) from information_schema.columns where table_name='sync_status' and column_name in ('device_id','device_name')`).out.trim()==='2');
ok('no data changed', sql(`select md5(string_agg(t::text,'|' order by t::text)) from (
  select row_to_json(x)::text t from public.bookings x union all select row_to_json(x)::text from public.expenses x
  union all select row_to_json(x)::text from public.attendance x union all select row_to_json(x)::text from public.staff x) s`).out.trim()===dataBefore);
ok('the old odd mark is still there', sql(`select count(*) from public.attendance where id='legacy_odd_id'`).out.trim()==='1');

console.log('\n— the owner works as before —');
ok('reads his bookings', n(as(OWNER,`select count(*) from public.bookings`))==='1');
r=as(OWNER,`insert into public.bookings (id,owner_id,property_id,guest_name,check_in,check_out,guests,status) values
  ('b2','${OWNER}','p1','New guest',${today}+10,${today}+12,2,'confirmed') returning id`);
ok('adds a booking', /b2/.test(r.out), r.err);
ok('updates one', /b1/.test(as(OWNER,`update public.bookings set guests=3 where id='b1' returning id`).out));
ok('stamps a mark', /att_stf1_20260106/.test(as(OWNER,`update public.attendance set expense_id='wag_stf1_20260106' where id='att_stf1_20260106' returning id`).out));

console.log('\n— a signed-in account that is not an owner —');
for(const [who,uid] of [['her staff login',HER],['a stranger who signed up',STRANGER]]){
  const counts=['properties','bookings','staff','expenses','loans','attendance','push_log','backups']
    .map(t=>n(as(uid,`select count(*) from public.${t}`)));
  ok(`${who} reads nothing`, counts.every(c=>c==='0'||c==='error'), counts);
  r=as(uid,`insert into public.bookings (id,owner_id,property_id,guest_name,check_in,check_out,guests,status) values
    ('evil','${uid}','p1','x',${today},${today}+1,1,'confirmed')`);
  ok(`${who} cannot write rows, even under their own id`, /row-level security|permission denied/.test(r.err), r.err||r.out);
  r=as(uid,`insert into public.properties (id,owner_id,name) values ('evilp','${uid}','x')`);
  ok(`${who} cannot add a property`, /row-level security|permission denied/.test(r.err), r.err||r.out);
  r=as(uid,`insert into public.push_subscriptions (endpoint,owner_id,p256dh,auth) values ('https://x/${uid}','${uid}','a','b')`);
  ok(`${who} cannot register a device for alerts`, /row-level security|permission denied/.test(r.err), r.err||r.out);
}
ok('her staff login still reads her own access row', n(as(HER,`select count(*) from public.staff_access`))==='1');
ok('but no one else\'s, and cannot change it', /row-level security|permission denied/.test(as(HER,`update public.staff_access set active=true where user_id='${HER}' returning 1`).err)
   ||as(HER,`update public.staff_access set active=true where user_id='${HER}' returning 1`).out.trim()==='');

console.log('\n— her page still works —');
const cal=as(HER,`select count(*) from public.staff_calendar()`);
ok('her calendar', n(cal)==='1', cal.err||cal.out);
const st=json(as(HER,`select public.staff_standing()::text`));
ok('her standing', st&&st.name==='Laxmi', st);
ok('owes her only her own account\'s wage (₹300), not the stray ₹999 row', st&&Number(st.pending.amount)===300&&st.pending.count===1, st&&st.pending);
r=asCommit(HER,`select public.staff_mark_today()`);
ok('she marks attendance', !r.err&&/"ok": ?true/.test(r.out), r.err||r.out);
ok('which wrote one row with the right id', sql(`select count(*) from public.attendance where id=public.attendance_id('stf1',${today})`).out.trim()==='1');

console.log('\n— a mark\'s id is its staff and date —');
r=sql(`insert into public.attendance (id,owner_id,staff_id,date) values ('att_stf1_19990101','${OWNER}','stf1','2026-02-02')`);
ok('a new mark with the wrong id is refused', /attendance_id_matches/.test(r.err), r.err);
r=sql(`insert into public.attendance (id,owner_id,staff_id,date) values (public.attendance_id('stf1','2026-02-02'),'${OWNER}','stf1','2026-02-02')`);
ok('the right one is accepted', !r.err, r.err);
r=sql(`insert into public.utensil_marks (id,owner_id,staff_id,date) values ('att_stf1_20260202','${OWNER}','stf1','2026-02-02')`);
ok('a utensil mark with the wrong id is refused', /utensil_marks_id_matches/.test(r.err), r.err);

console.log('\n— attendance: no default ALL —');
r=as(OWNER,`delete from public.attendance`);
ok('the owner cannot delete marks', /permission denied/.test(r.err), r.err||r.out);
r=as(OWNER,`truncate public.attendance`);
ok('nor TRUNCATE them', /permission denied/.test(r.err), r.err||r.out);
r=as(OWNER,`update public.attendance set date='2020-01-01'`);
ok('nor change anything but the stamp', /permission denied/.test(r.err), r.err||r.out);

console.log('\n— app_status —');
ok('anyone can read it, and it retires nothing', as('',`select min_version from public.app_status`,'anon').out.trim()==='0');
r=as(OWNER,`update public.app_status set min_version=99`);
ok('nobody but the SQL editor can change it', /permission denied/.test(r.err), r.err||r.out);
r=psql(DB,['-f',F('setup.sql')]);
ok('re-running setup.sql afterwards keeps the rules (restrictive policies are separate)',
   !r.err&&n(as(STRANGER,`select count(*) from public.bookings`))==='0'&&/row-level security|permission denied/.test(as(STRANGER,`insert into public.properties (id,owner_id,name) values ('q','${STRANGER}','x')`).err));

console.log('\n— the rollback script —');
const beforeUndo=sql(`select md5(string_agg(row_to_json(x)::text,'|' order by x.id)) from public.bookings x`).out.trim();
r=psql(DB,['-f',F('security-v60-rollback.sql')]); ok('runs', !r.err, r.err);
r=psql(DB,['-f',F('security-v60-rollback.sql')]); ok('and runs again', !r.err, r.err);
ok('no "owners only" policy is left', sql(`select count(*) from pg_policies where policyname='owners only'`).out.trim()==='0');
ok('nor the mark-id checks', sql(`select count(*) from pg_constraint where conname in ('attendance_id_matches','utensil_marks_id_matches')`).out.trim()==='0');
ok('no data changed', sql(`select md5(string_agg(row_to_json(x)::text,'|' order by x.id)) from public.bookings x`).out.trim()===beforeUndo);
ok('the owner still works', n(as(OWNER,`select count(*) from public.bookings`))!=='error');
r=psql(DB,['-f',F('security-v60.sql')]); ok('and security-v60.sql can be run again after it', !r.err, r.err);

psql('postgres',['-c',`drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
