/* The minimal cloud on a real Postgres: every script in the order the real
   project ran them, then minimal-cloud.sql and purge-private.sql. Laxmi's page
   (staff_calendar, staff_standing) must return exactly what it did before;
   the purge must refuse without a recent backup or before a minimal sync,
   remove the old private columns and rows, be safe to run twice, and leave
   every table with only the privileges the app uses (no TRUNCATE).

     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_purge_sql.js
   Without STAYLOG_PG it says so and skips. Uses its own database. */
const {execFileSync}=require('child_process');
const path=require('path');
const F=n=>path.resolve(__dirname,'../supabase/'+n);
const CONN=(process.env.STAYLOG_PG||'').split(/\s+/).filter(Boolean);
if(!CONN.length){console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).');process.exit(0);}
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x).slice(0,500):'')));};
const psql=(db,args)=>{try{return{out:execFileSync('psql',[...CONN,'-d',db,'-q','-t','-A','-v','ON_ERROR_STOP=1',...args],
  {encoding:'utf8',stdio:['pipe','pipe','pipe']}),err:''};}catch(e){return{out:String(e.stdout||''),err:String(e.stderr||e.message)};}};
const DB='staylog_purge_test', O='11111111-1111-1111-1111-111111111111', HER='33333333-3333-3333-3333-333333333333',
  X='22222222-2222-2222-2222-222222222222';
const sql=q=>psql(DB,['-c',q]);
const as=(role,uid,q)=>psql(DB,['-c',`begin; set local role ${role}; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
const tryAs=(role,uid,q)=>psql(DB,['-c',`begin; set local role ${role}; set local request.jwt.uid='${uid}'; ${q}; rollback;`]);   // tried, then undone
const herPage=()=>as('authenticated',HER,`select json_build_object(
    'calendar',(select coalesce(json_agg(c order by c.check_in),'[]') from public.staff_calendar() c),
    'standing',public.staff_standing())`).out.trim();
const cols=t=>sql(`select string_agg(column_name,',' order by column_name) from information_schema.columns where table_schema='public' and table_name='${t}'`).out.trim().split(',');
const purge=()=>psql(DB,['-f',F('purge-private.sql')]);

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
  insert into auth.users(id) values ('${O}'),('${HER}'),('${X}');`);
ok('Supabase stand-ins are in place', !r.err, r.err);
for(const f of ['setup.sql','update-functions.sql','attendance.sql','checkout-wage.sql','utensils.sql','receipts.sql','signature.sql',
                'payment-details.sql','round-off.sql','ical.sql','push.sql','backups.sql']){
  r=psql(DB,['-f',F(f)]); ok(`${f} loads`, !r.err, r.err); }

console.log('\n— the database as it is today, with private details in it —');
const T=`(now() at time zone 'Asia/Kolkata')::date`;
r=sql(`
  insert into public.owners(user_id) values ('${O}');
  insert into public.properties (id,owner_id,name,location,wifi_name,wifi_password,upi_id,bank_details,signature,description)
    values ('p1','${O}','Raaya Vasyam','Kaup','RaayaGuest','TideAndPalm#2026','staylog.test@fakebank','Test Account','data:image/png;base64,SIG','A quiet house'),
           ('p0','${O}','Old place','Udupi',null,null,null,null,null,null);
  update public.properties set deleted_at=now() where id='p0';
  insert into public.staff (id,owner_id,name,role,phone,daily_wage,checkout_wage,utensil_rate)
    values ('s1','${O}','Laxmi Walikar','House help','9800000000',300,500,100),
           ('s9','${O}','Gone helper',null,null,null,null,null);
  update public.staff set deleted_at=now() where id='s9';
  insert into public.staff_access (user_id,owner_id,staff_id,display_name) values ('${HER}','${O}','s1','Laxmi');
  insert into public.bookings (id,owner_id,property_id,guest_name,phone,check_in,check_out,guests,total_amount,paid,source,status,notes,
                               id_proof_type,id_proof_number,receipt_no,round_off)
    values ('b1','${O}','p1','Anita Raghunathan','9845012345',${T}-1,${T}+2,2,6000,2000,'Direct','checkedin','Prefers upstairs','Aadhaar','AADH-5512','RV/2026-27/001',0),
           ('b2','${O}','p1','Rahul Menon','9876500000',${T}+5,${T}+7,3,5000,0,'Airbnb','confirmed',null,null,null,null,0),
           ('b3','${O}','p1','Cancelled Guest','9000000000',${T}+3,${T}+4,1,2000,0,'Direct','cancelled',null,null,null,null,0),
           ('b4','${O}','p1','Deleted Guest','9111111111',${T}+8,${T}+9,1,1000,0,'Direct','confirmed',null,null,null,null,0);
  update public.bookings set deleted_at=now() where id='b4';
  insert into public.loans (id,owner_id,staff_id,principal,installment_amount,disbursed_on,first_due_date,status,notes)
    values ('l1','${O}','s1',5000,500,${T}-60,${T}-30,'active','For her son''s fees');
  insert into public.loan_repayments (id,owner_id,loan_id,date,amount,mode,note)
    values ('r1','${O}','l1',${T}-30,500,'payout','October'),('r2','${O}','l1',${T}-20,500,'direct','undone');
  update public.loan_repayments set deleted_at=now() where id='r2';
  insert into public.expenses (id,owner_id,property_id,staff_id,loan_id,description,date,category,amount,gross_amount,loan_deduction,paid,notes,wage_kind,auto_amount)
    values ('wag_s1_a','${O}','p1','s1',null,'Wage — Laxmi · checkout day',${T}-2,'staff',500,500,0,false,null,'checkout',500),
           ('wag_s1_b','${O}','p1','s1','l1','Wage — Laxmi',${T}-3,'staff',250,300,50,false,null,'daily',300),
           ('ute_s1_c','${O}','p1','s1',null,'Utensil cleaning — Laxmi',${T}-2,'staff',100,null,0,true,null,null,null),
           ('wag_s1_d','${O}','p1','s1',null,'Wage — Laxmi (deleted)',${T}-9,'staff',300,null,0,false,null,'daily',300),
           ('gro','${O}','p1',null,null,'Groceries for the Rao family',${T}-1,'supplies',820,null,0,true,'receipt in drawer',null,null);
  update public.expenses set deleted_at=now() where id='wag_s1_d';
  insert into public.attendance (id,owner_id,staff_id,date,marked_at) values (public.attendance_id('s1',${T}),'${O}','s1',${T},now()-interval '1 hour');
  insert into public.ical_feeds (id,owner_id,property_id,platform,url) values ('00000000-0000-0000-0000-0000000000f1','${O}','p1','Airbnb','https://www.airbnb.example/x.ics');
  insert into public.ical_events (feed_id,uid,owner_id,property_id,platform,start_date,end_date,summary,description,kind,imported_booking_id)
    values ('00000000-0000-0000-0000-0000000000f1','u1','${O}','p1','Airbnb',${T}+5,${T}+7,'Reserved','Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMX\nPhone Number (Last 4 Digits): 4471','reserved','b2'),
           ('00000000-0000-0000-0000-0000000000f1','u2','${O}','p1','Airbnb',${T}+20,${T}+22,'Reserved','Reservation URL: x\nPhone Number (Last 4 Digits): 9090','reserved',null);`);
ok('seeded', !r.err, r.err);
const before=herPage();
ok('Laxmi\'s page answers, with her calendar and standing', /"calendar"/.test(before)&&/"pending"/.test(before)&&/Raaya Vasyam/.test(before)&&/checkout/.test(before), before);
ok('her page shows no guest name today either', !/Anita|Rahul|Raghunathan/.test(before));

console.log('\n— step 1: minimal-cloud.sql —');
r=psql(DB,['-f',F('minimal-cloud.sql')]); ok('runs', !r.err, r.err);
r=psql(DB,['-f',F('minimal-cloud.sql')]); ok('and runs again', !r.err, r.err);
ok('bookings gain balance_due, sync_status gains app_version', cols('bookings').includes('balance_due')&&cols('sync_status').includes('app_version'));
r=tryAs('authenticated',O,`insert into public.bookings (id,owner_id,property_id,check_in,check_out,guests,status,balance_due)
  values ('b5','${O}','p1',${T}+10,${T}+12,2,'confirmed',1500)`);
ok('a minimal booking row (no name, no amounts) is now accepted', !r.err, r.err);
r=tryAs('authenticated',O,`insert into public.loan_repayments (id,owner_id,loan_id,amount) values ('r3','${O}','l1',500)`);
ok('and a repayment without its date', !r.err, r.err);
ok('Laxmi\'s page unchanged by it', herPage()===before);

console.log('\n— step 2: purge-private.sql refuses until it is safe —');
r=purge();
ok('no encrypted backup at all: refused', /Refusing to purge: no encrypted backup in the last 24 hours \(latest: none\)/.test(r.err), r.err);
sql(`insert into public.backups (owner_id,created_at,ciphertext,salt,iv,iterations,app_version,size) values ('${O}',now()-interval '2 days','Y3Q=','c2FsdA==','aXY=',600000,'v50',2)`);
r=purge();
ok('a backup 2 days old: refused', /no encrypted backup in the last 24 hours \(latest: \d/.test(r.err), r.err);
sql(`insert into public.backups (owner_id,ciphertext,salt,iv,iterations,app_version,size) values ('${O}','Y3Q=','c2FsdA==','aXY=',600000,'v51',2)`);
r=purge();
ok('a fresh backup, but no sync from v51 yet: refused', /Refusing to purge: the last sync came from StayLog \(an older version\)/.test(r.err), r.err);
sql(`insert into public.sync_status (owner_id,last_sync_at,app_version) values ('${O}',now(),'v50')`);
r=purge();
ok('the last sync from v50: refused', /the last sync came from StayLog v50/.test(r.err), r.err);
ok('a refusal changes nothing: every column and row still there', cols('bookings').includes('guest_name')&&cols('properties').includes('upi_id')
   &&sql(`select count(*) from public.expenses`).out.trim()==='5'&&sql(`select count(*) from public.bookings where deleted_at is not null`).out.trim()==='1');

console.log('\n— step 2: it runs —');
sql(`update public.sync_status set app_version='v51', last_sync_at=now()`);
// What the first minimal sync does before the purge: the non-staff expense is tombstoned.
sql(`update public.expenses set deleted_at=now() where staff_id is null`);
r=purge();
ok('with a fresh backup and a v51 sync: it runs', !r.err, r.err);
ok('its check finds no old private column left', !/\|/.test((r.out.split('\n').find(l=>/guest_name|wifi_password|upi_id/.test(l))||'')), r.out.slice(0,300));
r=purge();
ok('and it runs again, safely', !r.err, r.err);

const want={properties:'created_at,deleted_at,id,name,owner_id,updated_at',
  bookings:'balance_due,check_in,check_out,created_at,deleted_at,guests,id,owner_id,property_id,status,updated_at',
  staff:'created_at,deleted_at,id,name,owner_id,updated_at',
  expenses:'amount,created_at,date,deleted_at,description,gross_amount,id,loan_deduction,owner_id,paid,staff_id,updated_at,wage_kind',
  loans:'created_at,deleted_at,disbursed_on,first_due_date,id,installment_amount,owner_id,principal,staff_id,status,updated_at',
  loan_repayments:'amount,created_at,deleted_at,id,loan_id,owner_id,updated_at'};
for(const [t,c] of Object.entries(want)) ok(`${t} keeps exactly: ${c.replace(/created_at,|deleted_at,|updated_at,?|owner_id,/g,'')}`, cols(t).join(',')===c, cols(t).join(','));
const all=sql(`select string_agg(t::text,' ') from (select * from public.bookings) t`).out+sql(`select string_agg(t::text,' ') from public.properties t`).out
  +sql(`select string_agg(t::text,' ') from public.expenses t`).out+sql(`select string_agg(t::text,' ') from public.staff t`).out
  +sql(`select string_agg(t::text,' ') from public.loans t`).out+sql(`select string_agg(t::text,' ') from public.loan_repayments t`).out;
ok('no guest name, phone, ID number, note, Wi-Fi, UPI or signature is left in any of them',
   !/Anita|Raghunathan|Rahul|9845012345|AADH|upstairs|TideAndPalm|fakebank|SIG|son''s fees|Groceries|drawer|9800000000|RV\/2026/.test(all), all.slice(0,300));
ok('expenses that are not staff payouts are gone', sql(`select count(*) from public.expenses where staff_id is null`).out.trim()==='0');
ok('every tombstoned row is gone', ['bookings','expenses','loan_repayments','properties','staff'].every(t=>sql(`select count(*) from public.${t} where deleted_at is not null`).out.trim()==='0'));
ok('live rows stay: 3 bookings, 3 staff payouts, the loan and its repayment, 1 property, 1 staff',
   sql(`select (select count(*) from public.bookings)||','||(select count(*) from public.expenses)||','||(select count(*) from public.loans)||','||(select count(*) from public.loan_repayments)||','||(select count(*) from public.properties)||','||(select count(*) from public.staff)`).out.trim()==='3,3,1,1,1,1',
   sql(`select (select count(*) from public.bookings)||','||(select count(*) from public.expenses)||','||(select count(*) from public.loans)||','||(select count(*) from public.loan_repayments)||','||(select count(*) from public.properties)||','||(select count(*) from public.staff)`).out.trim());
const ev=sql(`select uid||'='||coalesce(left(description,11),'NULL') from public.ical_events order by uid`).out.trim().split('\n');
ok('the imported Airbnb event loses its reservation text; one not yet imported keeps it', ev.join(',')==='u1=NULL,u2=Reservation', ev);

console.log('\n— Laxmi\'s page is exactly what it was —');
const after=herPage();
ok('staff_standing: identical', JSON.stringify(JSON.parse(after).standing)===JSON.stringify(JSON.parse(before).standing),
   {before:JSON.parse(before).standing,after:JSON.parse(after).standing});
ok('staff_calendar: identical', JSON.stringify(JSON.parse(after).calendar)===JSON.stringify(JSON.parse(before).calendar),
   {before:JSON.parse(before).calendar,after:JSON.parse(after).calendar});
ok('her whole page, byte for byte', after===before);
r=as('authenticated',HER,`select public.staff_unmark_today()`); ok('her undo still works', !r.err, r.err);
r=as('authenticated',HER,`select public.staff_mark_today()`); ok('and marking again', !r.err, r.err);

console.log('\n— privileges: only what the app uses —');
for(const t of ['properties','bookings','staff','expenses','loans','loan_repayments','attendance','utensil_marks','ical_feeds','ical_events',
                'backups','push_subscriptions','notification_prefs','sync_status','push_log','staff_access','owners']){
  r=as('authenticated',O,`truncate public.${t}`);
  ok(`no TRUNCATE on ${t}`, /permission denied/.test(r.err), r.err||'truncated!');
}
r=as('authenticated',O,`insert into public.bookings (id,owner_id,property_id,check_in,check_out,guests,status,balance_due)
  values ('b6','${O}','p1',${T}+30,${T}+31,1,'confirmed',null)
  on conflict (id) do update set guests=excluded.guests`);
ok('the owner\'s phone can still upsert a booking', !r.err, r.err);
r=as('authenticated',O,`update public.bookings set deleted_at=now() where id='b6' returning 1`);
ok('and tombstone one', !r.err&&r.out.trim()==='1', r.err||r.out);
ok('and read ids for the tombstone count', as('authenticated',O,`select count(*) from public.bookings`).out.trim()==='4');
ok('but not hard-delete', /permission denied/.test(as('authenticated',O,`delete from public.bookings where id='b6'`).err));
r=as('authenticated',O,`update public.attendance set expense_id='wag_x' where owner_id='${O}' returning 1`);
ok('the attendance drain can stamp a mark', !r.err, r.err);
ok('another account sees no bookings', as('authenticated',X,`select count(*) from public.bookings`).out.trim()==='0');
ok('Laxmi cannot read the bookings table directly', as('authenticated',HER,`select count(*) from public.bookings`).out.trim()==='0');
const anon=as('anon','',`select count(*) from public.bookings`);
ok('anon gets nothing', !!anon.err||anon.out.trim()==='0', anon);
r=psql(DB,['-f',F('minimal-cloud.sql')]); ok('minimal-cloud.sql is still safe to run after the purge', !r.err, r.err);
r=psql(DB,['-f',F('ical-report.sql')]); ok('ical-report.sql still runs', !r.err, r.err);
r=psql(DB,['-f',F('check-attendance.sql')]); ok('check-attendance.sql still runs', !r.err, r.err);
r=psql(DB,['-f',F('why-no-expense.sql')]); ok('why-no-expense.sql still runs', !r.err, r.err);

psql('postgres',['-c',`drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
