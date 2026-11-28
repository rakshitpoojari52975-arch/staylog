/* The new model's schema (supabase/stay/01-03 + check.sql) on a real
   Postgres, with stand-ins for what Supabase provides, BESIDE the old tables
   (which it must not touch). Phase 1 of the revamp: nothing uses it yet.
     - runs twice; check.sql says ok; no TRUNCATE, no ALL, anon has nothing
     - owner A cannot read or write account B; a cross-account key is refused
     - a manager sees only their properties (guest details included) and only
       what their permissions allow; a staff login reads no base table
     - apply_change lands only on the version it was edited from
     - receipts: seeded from numbers already used, never twice, even at once
     - money: under ₹1 is paid; round off only for sources that pay directly
     - her marks become wage / utensil lines on the server, with every rule
       the phone has today (deterministic ids, held without a rate, deleted on
       purpose stays deleted, checkout rate per her properties, re-pricing,
       15-minute undo) — and her page's functions over the new tables

     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_stay_sql.js
   Without STAYLOG_PG it says so and skips. Uses its own database. */
const {execFileSync,execFile}=require('child_process');
const path=require('path');
const F=n=>path.resolve(__dirname,'../supabase/'+n);
const CONN=(process.env.STAYLOG_PG||'').split(/\s+/).filter(Boolean);
if(!CONN.length){console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).');process.exit(0);}
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const DB='staylog_stay_test';
const psql=(db,args,input)=>{try{return{out:execFileSync('psql',[...CONN,'-d',db,'-q','-t','-A','-v','ON_ERROR_STOP=1',...args],
  {input,encoding:'utf8',stdio:['pipe','pipe','pipe']}),err:''};}catch(e){return{out:'',err:String(e.stderr||e.message)};}};
const sql=s=>psql(DB,['-c','set client_min_messages=warning;'+s]);
const v=s=>sql(s).out.trim();
const U={A:'aaaaaaaa-0000-0000-0000-00000000000a',B:'bbbbbbbb-0000-0000-0000-00000000000b',M:'cccccccc-0000-0000-0000-00000000000c',
  M2:'dddddddd-0000-0000-0000-00000000000d',S:'eeeeeeee-0000-0000-0000-00000000000e',X:'ffffffff-0000-0000-0000-00000000000f'};
// as a signed-in user; rolled back unless commit
const as=(uid,q,commit)=>psql(DB,['-c',`set client_min_messages=warning; begin; set local role authenticated; set local request.jwt.uid='${uid}'; ${q}; ${commit?'commit':'rollback'};`]);
const asv=(uid,q,commit)=>{const r=as(uid,q,commit);return r.err?'ERR: '+r.err.split('\n')[0]:r.out.trim();};
const J=s=>{try{return JSON.parse(s.split('\n').pop());}catch{return null;}};
const TODAY=`(now() at time zone 'Asia/Kolkata')::date`;

(async()=>{
psql('postgres',['-c',`drop database if exists ${DB}`]);
psql('postgres',['-c',`create database ${DB}`]);
let r=psql(DB,[],`
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  insert into auth.users(id) values ${Object.values(U).map(u=>`('${u}')`).join(',')};`);
ok('Supabase stand-ins are in place', !r.err, r.err);
for(const f of ['setup.sql','attendance.sql','checkout-wage.sql','utensils.sql']){r=psql(DB,['-f',F(f)]); ok('old '+f+' loads', !r.err, r.err);}
sql(`insert into public.owners values ('${U.A}');
  insert into public.properties (id,owner_id,name) values ('p1','${U.A}','Raaya Vasyam');
  insert into public.bookings (id,owner_id,property_id,guest_name,check_in,check_out,guests,status) values ('b1','${U.A}','p1','Anita',${TODAY},${TODAY}+2,2,'confirmed');`);
const oldBefore=v(`select md5(coalesce((select string_agg(row_to_json(b)::text,'|' order by id) from public.bookings b),'')
     ||coalesce((select string_agg(row_to_json(p)::text,'|' order by id) from public.properties p),'')
     ||(select string_agg(table_name||privilege_type||grantee,',' order by table_name,privilege_type,grantee) from information_schema.role_table_grants where table_schema='public')
     ||(select string_agg(tablename||policyname,',' order by tablename,policyname) from pg_policies where schemaname='public'))`);

console.log('\n— runs, and runs again —');
for(const run of [1,2]){
  for(const f of ['stay/01-schema.sql','stay/02-functions.sql','stay/03-access.sql','stay/04-phase2.sql','stay/07-staff.sql','stay/08-team.sql','stay/09-calendar.sql','stay/10-onboarding.sql','stay/11-legal.sql','stay/12-plans.sql','stay/13-billing.sql','stay/14-paid-on.sql','stay/15-privacy.sql']){
    r=psql(DB,['-c','set client_min_messages=warning','-f',F(f)]); ok(`${f} (run ${run})`, !r.err, r.err);
  }
}
const check=psql(DB,['-F','|','-f',F('stay/check.sql')]).out.trim().split('\n').filter(Boolean);
const bad=check.filter(l=>!/\|ok/.test(l)&&!/public\.attendance\|ok/.test(l));
ok('check.sql: every row ok', bad.length===0&&check.length>40, bad.length?bad:check.length);
ok('the old public tables are untouched', oldBefore===v(`select md5(coalesce((select string_agg(row_to_json(b)::text,'|' order by id) from public.bookings b),'')
     ||coalesce((select string_agg(row_to_json(p)::text,'|' order by id) from public.properties p),'')
     ||(select string_agg(table_name||privilege_type||grantee,',' order by table_name,privilege_type,grantee) from information_schema.role_table_grants where table_schema='public')
     ||(select string_agg(tablename||policyname,',' order by tablename,policyname) from pg_policies where schemaname='public'))`));
ok('you are a platform admin (from public.owners)', v(`select count(*) from stay.platform_admins where user_id='${U.A}'`)==='1');
ok('anon has no privilege on any stay table', v(`select count(*) from information_schema.role_table_grants where table_schema='stay' and grantee='anon'`)==='0');
ok('no TRUNCATE for anyone signed in', v(`select count(*) from information_schema.role_table_grants where table_schema='stay' and grantee='authenticated' and privilege_type='TRUNCATE'`)==='0');
ok('DELETE only on links and devices', v(`select string_agg(distinct table_name, ',' order by table_name) from information_schema.role_table_grants
   where table_schema='stay' and grantee='authenticated' and privilege_type='DELETE'`)==='backups,member_properties,push_subscriptions,staff_properties');

console.log('\n— accounts —');
const A=asv(U.A,`select stay.create_account('Raaya Vasyam','rv','Rakshit')`,true);
ok('a platform admin opens an account and owns it', /^[0-9a-f-]{36}$/.test(A), A);
ok('someone else cannot', /Only a platform admin/.test(asv(U.B,`select stay.create_account('Other','ot')`)));
sql(`insert into stay.platform_admins values ('${U.B}')`);
const B=asv(U.B,`select stay.create_account('Other Homestay','ot','Bina')`,true);
sql(`delete from stay.platform_admins where user_id='${U.B}'`);
r=sql(`set stay.x='1';
  insert into stay.properties (account_id,id,name,receipt_prefix) values ('${A}','p1','Raaya Vasyam','RV'),('${A}','p2','Second House','SH'),('${B}','q1','Bina Stay','BS');
  insert into stay.members (account_id,user_id,role,display_name) values ('${A}','${U.M}','manager','Manju'),('${A}','${U.M2}','manager','Mohan');
  update stay.members set permissions='{"see_money":true,"manage_staff":true,"mark_paid":false}' where user_id='${U.M2}';
  insert into stay.member_properties values ('${A}','${U.M}','p1'),('${A}','${U.M2}','p1');
  insert into stay.staff (account_id,id,name,daily_wage,checkout_wage,utensil_rate) values
    ('${A}','stf1','Laxmi Walikar',300,450,100),('${A}','stf2','Ravi',null,null,null),('${B}','stf1','Bina Help',999,999,999);
  insert into stay.staff_logins (user_id,account_id,staff_id,username,display_name) values ('${U.S}','${A}','stf1','laxmi','Laxmi');
  insert into stay.bookings (account_id,id,property_id,guest_name,phone,check_in,check_out,guests,source,status,total_amount,paid) values
    ('${A}','b1','p1','Anita Rao','9876543210',${TODAY}+1,${TODAY}+3,2,'Direct','confirmed',6000,2000),
    ('${A}','b2','p2','Rahul Menon','9876500000',${TODAY}+1,${TODAY}+4,2,'Booking.com','confirmed',5000,0),
    ('${B}','x1','q1','B guest','9000000000',${TODAY},${TODAY}+1,1,'Direct','confirmed',1000,0);
  insert into stay.expenses (account_id,id,property_id,date,category,description,amount) values
    ('${A}','e1','p1',${TODAY},'utilities','Power p1',500),('${A}','e2','p2',${TODAY},'utilities','Power p2',600),
    ('${A}','e3',null,${TODAY},'supplies','Shared soap',70);`);
ok('seeded two accounts (as the server would)', !r.err, r.err);

console.log('\n— owner A and account B —');
ok('owner A reads A\'s bookings only', asv(U.A,`select string_agg(id,',' order by id) from stay.bookings`)==='b1,b2');
ok('owner B reads B\'s only', asv(U.B,`select string_agg(id,',' order by id) from stay.bookings`)==='x1');
ok('A cannot write a row into B', /row-level security/.test(asv(U.A,`insert into stay.expenses (account_id,id,date,amount) values ('${B}','evil',${TODAY},1)`)));
ok('nor change B\'s', asv(U.A,`update stay.bookings set guests=9 where account_id='${B}' returning id`)==='');
r=sql(`insert into stay.bookings (account_id,id,property_id,check_in,check_out) values ('${A}','cross','q1',${TODAY},${TODAY}+1)`);
ok('a booking pointing at another account\'s property is refused (composite key)', /foreign key/.test(r.err), r.err);
r=sql(`insert into stay.expenses (account_id,id,date,amount,staff_id) values ('${B}','cross2',${TODAY},1,'stf2')`);
ok('an expense naming another account\'s staff is refused', /foreign key/.test(r.err), r.err);
ok('a stranger (no membership) reads nothing', ['accounts','bookings','properties','expenses','staff','members']
  .every(t=>asv(U.X,`select count(*) from stay.${t}`)==='0'));
ok('bookings cannot be deleted, only cancelled', /cancelled, never deleted/.test(asv(U.A,`update stay.bookings set deleted_at=now() where id='b1'`)));
ok('and nobody may DELETE one', /permission denied/.test(asv(U.A,`delete from stay.bookings where id='b1'`)));

console.log('\n— a manager —');
ok('sees only their property\'s bookings, guest details included', asv(U.M,`select string_agg(id||':'||guest_name||':'||phone,',') from stay.bookings`)==='b1:Anita Rao:9876543210');
ok('only that property', asv(U.M,`select string_agg(id,',') from stay.properties`)==='p1');
ok('may edit a booking there', asv(U.M,`update stay.bookings set guests=3 where id='b1' returning id`)==='b1');
ok('not one elsewhere', asv(U.M,`update stay.bookings set guests=3 where id='b2' returning id`)==='');
ok('may not add a booking elsewhere', /row-level security/.test(asv(U.M,`insert into stay.bookings (account_id,id,property_id,check_in,check_out) values ('${A}','n1','p2',${TODAY},${TODAY}+1)`)));
ok('sees their property\'s expenses, not another\'s, not Shared', asv(U.M,`select string_agg(id,',' order by id) from stay.expenses`)==='e1');
ok('cannot see staff, loans, marks or receipts counters', ['staff','loans','attendance','receipt_series'].every(t=>asv(U.M,`select count(*) from stay.${t}`)==='0'));
ok('never sees the calendar links', asv(U.M,`select count(*) from stay.ical_feeds`)==='0');
ok('cannot edit property settings by default', asv(U.M,`update stay.properties set wifi_password='x' where id='p1' returning id`)==='');
ok('cannot add members', /row-level security/.test(asv(U.M,`insert into stay.members (account_id,user_id,role) values ('${A}','${U.X}','owner')`)));
ok('with see_money, Shared expenses show too', asv(U.M2,`select string_agg(id,',' order by id) from stay.expenses`)==='e1,e3');
ok('with manage_staff, staff show', asv(U.M2,`select count(*) from stay.staff`)==='2');
ok('owner edits a manager\'s permissions', asv(U.A,`update stay.members set permissions='{"edit_properties":true}' where user_id='${U.M}' returning user_id`)===U.M);
ok('the last owner cannot be demoted', /at least one owner/.test(asv(U.A,`update stay.members set role='manager' where user_id='${U.A}'`)));

console.log('\n— a staff login —');
ok('reads no base table', ['bookings','properties','expenses','staff','attendance','loans','members','staff_logins']
  .every(t=>{const x=asv(U.S,`select count(*) from stay.${t}`);return x==='0'||/permission/.test(x);}));
ok('writes none', /row-level security|permission denied/.test(asv(U.S,`insert into stay.attendance (account_id,id,staff_id,date) values ('${A}','att_stf1_20991231','stf1','2099-12-31')`)));

console.log('\n— apply_change: lands only on the version it was edited from —');
let x=J(asv(U.A,`select stay.apply_change('expenses','{"account_id":"${A}","id":"n1","date":"2026-11-01","amount":100,"category":"supplies","property_id":"p1"}',null)`,true));
ok('a new row lands at version 1', x&&x.status==='ok'&&x.row.version===1&&x.row.updated_by===U.A, x);
x=J(asv(U.A,`select stay.apply_change('expenses','{"account_id":"${A}","id":"n1","amount":120}',1)`,true));
ok('an edit from version 1 lands, version 2', x&&x.status==='ok'&&x.row.version===2&&Number(x.row.amount)===120&&x.row.category==='supplies', x);
x=J(asv(U.A,`select stay.apply_change('expenses','{"account_id":"${A}","id":"n1","amount":999}',1)`,true));
ok('a second edit from version 1 is a conflict, with the server row', x&&x.status==='conflict'&&Number(x.server.amount)===120&&x.server.version===2, x);
ok('and nothing was overwritten', v(`select amount from stay.expenses where id='n1'`)==='120');
x=J(asv(U.A,`select stay.apply_change('expenses','{"account_id":"${A}","id":"n1","date":"2026-11-02","amount":1}',null)`));
ok('a "new" row whose id exists is a conflict', x&&x.status==='conflict', x);
x=J(asv(U.A,`select stay.apply_change('expenses','{"account_id":"${A}","id":"nope","amount":1}',3)`));
ok('an edit to a row that does not exist says missing', x&&x.status==='missing', x);
x=J(asv(U.M,`select stay.apply_change('bookings','{"account_id":"${A}","id":"b2","guests":9}',1)`));
ok('a manager\'s edit to a property they do not hold changes nothing', x&&x.status==='missing'&&v(`select guests from stay.bookings where id='b2'`)==='2', x);
ok('only synced tables', /not a synced table/.test(asv(U.A,`select stay.apply_change('members','{"account_id":"${A}","id":"x"}',null)`)));

console.log('\n— money —');
sql(`insert into stay.bookings (account_id,id,property_id,check_in,check_out,source,total_amount,paid,round_off) values
  ('${A}','m1','p1','2026-01-01','2026-01-02','Direct',4999.5,4999,0),('${A}','m2','p1','2026-01-03','2026-01-04','Direct',1000,999,0),
  ('${A}','m3','p1','2026-01-05','2026-01-06','Airbnb',5000,4995,5),('${A}','m4','p1','2026-01-07','2026-01-08','  ',4632.47,4630,2.47),
  ('${A}','m5','p1','2026-01-09','2026-01-10','Direct',1000,749.5,0)`);
const bal=id=>v(`select stay.balance_due(b) from stay.bookings b where id='${id}'`);
ok('₹4,999.50 total, ₹4,999 paid: nothing owed (under ₹1)', Number(bal('m1'))===0);
ok('₹1.00 owed is owed', Number(bal('m2'))===1);
ok('Airbnb gets no round off: ₹5 still owed', Number(bal('m3'))===5);
ok('a blank source counts as Direct: its round off applies', Number(bal('m4'))===0);
ok('paise kept: ₹250.50', Number(bal('m5'))===250.5);
ok('revenue = total − round off; a cancelled stay earns nothing', Number(v(`select stay.revenue(b) from stay.bookings b where id='m4'`))===4630
   &&Number(v(`select stay.revenue(b) from stay.bookings b where id='m3'`))===5000);

console.log('\n— receipts —');
const fy=v(`select stay.financial_year(${TODAY})`);
ok('the Indian financial year', v(`select stay.financial_year('2026-03-31')`)==='2025-26'&&v(`select stay.financial_year('2026-04-01')`)==='2026-27');
sql(`update stay.bookings set receipt_no='RV/${fy}/004' where id='m1'; update stay.bookings set receipt_no='RV/2025-26/009' where id='m2';
  insert into stay.bookings (account_id,id,property_id,check_in,check_out,source,total_amount,paid) select '${A}','r'||g,'p1','2026-02-01','2026-02-02','Direct',100,0 from generate_series(1,8) g;
  insert into stay.bookings (account_id,id,property_id,check_in,check_out,source,total_amount,paid) values ('${A}','rs','p2','2026-02-01','2026-02-02','Booking.com',100,0),('${A}','ra','p1','2026-02-01','2026-02-02','Airbnb',100,0)`);
const rcp=id=>asv(U.A,`select stay.issue_receipt('${A}','${id}')`,true);
ok('the next number follows the highest used in that series and year', rcp('r1')===`RV/${fy}/005`, rcp('r1'));
ok('the same booking keeps its number', rcp('r1')===`RV/${fy}/005`);
ok('each property its own series', rcp('rs')===`SH/${fy}/001`);
ok('receipts only for sources that pay directly', /only for guests who pay the house/.test(rcp('ra')));
ok('a manager without mark_paid may not issue one', /Not allowed/.test(asv(U.M2,`select stay.issue_receipt('${A}','r2')`)));
ok('the issue date is stored', v(`select receipt_on = ${TODAY} from stay.bookings where id='r1'`)==='t');
{ // seven devices issue at the same moment: seven different numbers, no gaps
  const ids=['r2','r3','r4','r5','r6','r7','r8'];
  const run=id=>new Promise(res=>execFile('psql',[...CONN,'-d',DB,'-q','-t','-A','-c',
    `begin; set local role authenticated; set local request.jwt.uid='${U.A}'; select stay.issue_receipt('${A}','${id}'); commit;`],
    {encoding:'utf8'},(e,out)=>res(String(out||(e&&e.message)||'').trim().split('\n').filter(l=>/\//.test(l)).pop()||'')));
  const got=await Promise.all(ids.map(run));
  const nums=got.map(n=>Number(String(n).split('/').pop())).sort((a,b)=>a-b);
  ok('issued at the same moment, every number is different and none is skipped', new Set(got).size===7&&nums.join()==='6,7,8,9,10,11,12', got);
  ok('the database refuses a duplicate anyway', /duplicate key/.test(sql(`update stay.bookings set receipt_no='RV/${fy}/005' where id='m5'`).err));
}

console.log('\n— her marks become lines on the server —');
const D=n=>v(`select (${TODAY}+${n})::text`);
const mark=(day,staff='stf1')=>sql(`insert into stay.attendance (account_id,id,staff_id,date) values ('${A}',stay.attendance_id('${staff}','${day}'),'${staff}','${day}')`);
const exp=id=>J(v(`select coalesce(row_to_json(e)::text,'null') from stay.expenses e where account_id='${A}' and id='${id}'`));
const ymd=d=>d.replace(/-/g,'');
{ const d0=D(-10);
  r=mark(d0); const e=exp('wag_stf1_'+ymd(d0));
  ok('a mark becomes one unpaid wage line, id wag_<staff>_<yyyymmdd>', !r.err&&e&&!e.paid&&Number(e.amount)===300&&e.category==='staff', r.err||e);
  ok('described as the phone does', e&&new RegExp('^Wage — Laxmi Walikar · \\d{1,2} [A-Z][a-z]{2}$').test(e.description), e&&e.description);
  ok('priced by the app (auto_amount), kind daily, from her mark', e&&Number(e.auto_amount)===300&&e.wage_kind==='daily'&&e.source_mark_id==='att_stf1_'+ymd(d0), e);
  ok('with no properties assigned to her, it is Shared', e&&e.property_id===null, e);
  ok('and the mark is stamped', v(`select expense_id from stay.attendance where id='att_stf1_${ymd(d0)}'`)==='wag_stf1_'+ymd(d0));
}
{ const d1=D(-9);
  sql(`insert into stay.bookings (account_id,id,property_id,check_in,check_out,status) values ('${A}','co1','p2','${D(-11)}','${d1}','checkedout')`);
  mark(d1); const e=exp('wag_stf1_'+ymd(d1));
  ok('a day a guest checks out pays the checkout-day wage', e&&Number(e.amount)===450&&e.wage_kind==='checkout'&&/ · checkout day$/.test(e.description), e);
}
{ const d2=D(-8);
  sql(`insert into stay.expenses (account_id,id,date,category,amount,staff_id,description) values ('${A}','wag_stf1_${ymd(d2)}','${d2}','staff',275,'stf1','Wage — typed by hand')`);
  mark(d2);
  ok('an existing wage line is recognised, never doubled', v(`select count(*) from stay.expenses where id like 'wag_stf1_${ymd(d2)}%'`)==='1'
     &&Number(exp('wag_stf1_'+ymd(d2)).amount)===275&&v(`select expense_id from stay.attendance where id='att_stf1_${ymd(d2)}'`)==='wag_stf1_'+ymd(d2));
}
{ const d3=D(-7);
  sql(`insert into stay.expenses (account_id,id,date,category,amount,staff_id,deleted_at) values ('${A}','wag_stf1_${ymd(d3)}','${d3}','staff',300,'stf1',now())`);
  mark(d3);
  ok('a line deleted on purpose stays deleted (the mark is just stamped)', exp('wag_stf1_'+ymd(d3)).deleted_at!==null
     &&v(`select expense_id from stay.attendance where id='att_stf1_${ymd(d3)}'`)==='wag_stf1_'+ymd(d3));
  sql(`set stay.importing='on'; insert into stay.attendance (account_id,id,staff_id,date,expense_id) values ('${A}','att_stf1_${ymd(D(-6))}','stf1','${D(-6)}','wag_stf1_${ymd(D(-6))}')`);
  sql(`select stay.process_pending('${A}')`);
  ok('a stamped mark whose line is gone is left alone', exp('wag_stf1_'+ymd(D(-6)))===null);
}
{ const d4=D(-5);
  mark(d4,'stf2');
  ok('no daily wage: the mark is held, no amount invented', exp('wag_stf2_'+ymd(d4))===null&&v(`select expense_id is null from stay.attendance where id='att_stf2_${ymd(d4)}'`)==='t');
  sql(`update stay.staff set daily_wage=350 where account_id='${A}' and id='stf2'`);
  ok('setting the rate releases it', Number((exp('wag_stf2_'+ymd(d4))||{}).amount)===350);
}
{ const d5=D(-4);
  sql(`insert into stay.staff_properties values ('${A}','stf2','p1');
       insert into stay.bookings (account_id,id,property_id,check_in,check_out,status) values ('${A}','co2','p2','${D(-6)}','${d5}','checkedout')`);
  sql(`update stay.staff set checkout_wage=500 where account_id='${A}' and id='stf2'`);
  mark(d5,'stf2'); const e=exp('wag_stf2_'+ymd(d5));
  ok('the checkout rate counts only checkouts at her properties', e&&Number(e.amount)===350&&e.wage_kind==='daily', e);
  ok('working at one property, her line is charged to it', e&&e.property_id==='p1', e);
}
console.log('\n— re-pricing —');
{ const d6=D(-3), d7=D(-2), d8=D(-1);
  mark(d6); mark(d7); mark(d8);
  sql(`update stay.expenses set amount=280 where id='wag_stf1_${ymd(d7)}'; update stay.expenses set paid=true where id='wag_stf1_${ymd(d8)}'`);
  sql(`insert into stay.bookings (account_id,id,property_id,check_in,check_out,status) values ('${A}','late','p1','${D(-5)}','${d6}','checkedout'),
       ('${A}','late2','p1','${D(-5)}','${d7}','checkedout'),('${A}','late3','p1','${D(-5)}','${d8}','checkedout')`);
  ok('a late-found checkout re-prices an unpaid, app-priced day', Number(exp('wag_stf1_'+ymd(d6)).amount)===450&&exp('wag_stf1_'+ymd(d6)).wage_kind==='checkout');
  ok('a hand-edited amount is never changed', Number(exp('wag_stf1_'+ymd(d7)).amount)===280);
  ok('a paid day is never changed', Number(exp('wag_stf1_'+ymd(d8)).amount)===300);
  sql(`update stay.bookings set status='cancelled' where id='late'`);
  ok('cancelling that stay puts it back to the daily wage, tag removed', Number(exp('wag_stf1_'+ymd(d6)).amount)===300&&!/checkout day/.test(exp('wag_stf1_'+ymd(d6)).description));
  sql(`update stay.staff set daily_wage=320 where account_id='${A}' and id='stf1'`);
  ok('a new daily wage re-prices unpaid app-priced days', Number(exp('wag_stf1_'+ymd(d6)).amount)===320&&Number(exp('wag_stf1_'+ymd(D(-10))).amount)===320);
}

console.log('\n— her page, over the new tables —');
const her=(q,commit=true)=>J(asv(U.S,`select ${q}::text`,commit));
x=her('stay.staff_mark_today()');
ok('I came in today', x&&x.ok===true, x);
const today=v(`select ${TODAY}::text`);
ok('which becomes her wage line at once', exp('wag_stf1_'+ymd(today))!==null);
x=her('stay.staff_mark_utensils_today()');
ok('I cleaned the utensils today', x&&x.ok===true, x);
const ute=exp('ute_stf1_'+ymd(today));
ok('a utensil line of its own, id = the mark id, at her utensil rate', ute&&Number(ute.amount)===100&&ute.description.startsWith('Utensil cleaning — Laxmi Walikar · ')&&ute.wage_kind===null, ute);
let st=her('stay.staff_standing()',false);
ok('her standing: her name, both lines, labelled', st&&st.name==='Laxmi'&&st.pending.days.some(d=>d.kind==='utensils')&&st.pending.days.some(d=>d.kind==='wage'), st&&st.pending);
ok('the account B staff member with the same id is not hers', st&&!JSON.stringify(st).includes('999'));
ok('today: marked, counted, and she can still undo', st&&st.attendance.marked===true&&st.attendance.locked===true&&st.attendance.can_undo===true, st&&st.attendance);
x=her('stay.staff_unmark_today()');
ok('undo within 15 minutes', x&&x.ok===true, x);
ok('takes the untouched wage line with it, and that day\'s utensils', exp('wag_stf1_'+ymd(today)).deleted_at!==null&&exp('ute_stf1_'+ymd(today)).deleted_at!==null);
x=her('stay.staff_mark_today()');
ok('marking again brings the same line back: one line, not two', x&&x.ok&&exp('wag_stf1_'+ymd(today)).deleted_at===null
   &&v(`select count(*) from stay.expenses where id like 'wag_stf1_${ymd(today)}%'`)==='1');
sql(`update stay.expenses set paid=true where id='wag_stf1_${ymd(today)}'`);
x=her('stay.staff_unmark_today()');
ok('once the line is paid, undo says already counted', x&&x.ok===false&&x.reason==='already_counted', x);
sql(`update stay.expenses set paid=false where id='wag_stf1_${ymd(today)}'; update stay.attendance set marked_at=now()-interval '20 minutes' where id='att_stf1_${ymd(today)}'`);
x=her('stay.staff_unmark_today()');
ok('after 15 minutes, too late', x&&x.ok===false&&x.reason==='too_late', x);
ok('utensils need her attendance first', (()=>{sql(`update stay.attendance set deleted_at=now() where id='att_stf1_${ymd(today)}'`);
  const y=her('stay.staff_mark_utensils_today()');return y&&y.ok===false&&y.reason==='not_present';})());
const cal=asv(U.S,`select string_agg(property,',') from stay.staff_calendar()`);
ok('her calendar: the next fortnight, all properties while none are assigned to her', cal.includes('Raaya Vasyam')&&cal.includes('Second House'), cal);
sql(`insert into stay.staff_properties values ('${A}','stf1','p1')`);
ok('only her properties once assigned', asv(U.S,`select string_agg(distinct property,',') from stay.staff_calendar()`)==='Raaya Vasyam');
ok('a booking\'s guest name never reaches her', !/Anita|Rahul/.test(asv(U.S,`select string_agg(row_to_json(c)::text,'') from stay.staff_calendar() c`)));
ok('another login gets nothing from her functions', asv(U.X,`select stay.staff_standing()::text`)===''&&J(asv(U.X,`select stay.staff_mark_today()::text`)).reason==='no_access');

console.log('\n— a migration can load rows without the server reacting —');
sql(`set stay.importing='on'; insert into stay.attendance (account_id,id,staff_id,date) values ('${A}','att_stf1_20250101','stf1','2025-01-01')`);
ok('with stay.importing on, an old mark is loaded as it was (no line made)', exp('wag_stf1_20250101')===null);

console.log('\n— undoing phase 1 —');
r=psql(DB,['-f',F('stay/rollback-phase1.sql')]);
ok('the rollback refuses while an account exists in stay', /already holds an account/.test(r.err)&&v(`select to_regclass('stay.accounts') is not null`)==='t', r.err);
sql(`set stay.importing='on'; drop schema stay cascade`);
for(const f of ['stay/01-schema.sql','stay/02-functions.sql','stay/03-access.sql','stay/04-phase2.sql','stay/07-staff.sql','stay/08-team.sql','stay/09-calendar.sql','stay/10-onboarding.sql','stay/11-legal.sql','stay/12-plans.sql','stay/13-billing.sql','stay/14-paid-on.sql','stay/15-privacy.sql'])psql(DB,['-c','set client_min_messages=warning','-f',F(f)]);
r=psql(DB,['-f',F('stay/rollback-phase1.sql')]); ok('with no account, it removes the schema', !r.err&&v(`select to_regclass('stay.accounts') is null`)==='t', r.err);
r=psql(DB,['-f',F('stay/rollback-phase1.sql')]); ok('and runs twice', !r.err, r.err);
ok('the old public tables are still untouched', oldBefore===v(`select md5(coalesce((select string_agg(row_to_json(b)::text,'|' order by id) from public.bookings b),'')
     ||coalesce((select string_agg(row_to_json(p)::text,'|' order by id) from public.properties p),'')
     ||(select string_agg(table_name||privilege_type||grantee,',' order by table_name,privilege_type,grantee) from information_schema.role_table_grants where table_schema='public')
     ||(select string_agg(tablename||policyname,',' order by tablename,policyname) from pg_policies where schemaname='public'))`));

if(!process.env.KEEP_DB)psql('postgres',['-c',`drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
