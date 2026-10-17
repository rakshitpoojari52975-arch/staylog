/* supabase/checkout-wage.sql on a real Postgres, after setup.sql and
   attendance.sql as in the real project, with stand-ins for what Supabase
   provides. Checks it runs twice, keeps what it adds within sane values, and
   that staff_standing() now marks checkout days — and nothing else about it
   moved, and her access is no wider than before.

     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_checkout_sql.js
   Without STAYLOG_PG it says so and skips. Uses its own database,
   staylog_checkout_test, and drops it at the end. */
const {execFileSync}=require('child_process');
const path=require('path');
const F=n=>path.resolve(__dirname,'../supabase/'+n);
const CONN=(process.env.STAYLOG_PG||'').split(/\s+/).filter(Boolean);
if(!CONN.length){console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).');process.exit(0);}
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const psql=(db,args,input)=>{try{return{out:execFileSync('psql',[...CONN,'-d',db,'-q','-t','-A','-v','ON_ERROR_STOP=1',...args],
  {input,encoding:'utf8',stdio:['pipe','pipe','pipe']}),err:''};}catch(e){return{out:'',err:String(e.stderr||e.message)};}};
const DB='staylog_checkout_test', OWNER='11111111-1111-1111-1111-111111111111', HER='33333333-3333-3333-3333-333333333333';
const as=(role,uid,sql)=>psql(DB,['-c',`begin; set local role ${role}; set local request.jwt.uid='${uid}'; ${sql}; rollback;`]);

psql('postgres',['-c',`drop database if exists ${DB}`]);
psql('postgres',['-c',`create database ${DB}`]);
let r=psql(DB,[],`
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  grant usage on schema public, auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  insert into auth.users(id) values ('${OWNER}'),('${HER}');`);
ok('Supabase stand-ins are in place', !r.err, r.err);
r=psql(DB,['-f',F('setup.sql')]);      ok('setup.sql loads', !r.err, r.err);
r=psql(DB,['-f',F('attendance.sql')]); ok('attendance.sql loads', !r.err, r.err);
const standingBefore=psql(DB,[],`select pg_get_functiondef('public.staff_standing()'::regprocedure)`).out;

console.log('\n— runs, and runs again —');
r=psql(DB,['-f',F('checkout-wage.sql')]); ok('first run', !r.err, r.err);
r=psql(DB,['-f',F('checkout-wage.sql')]); ok('second run changes nothing and does not fail', !r.err, r.err);
const cols=psql(DB,[],`select table_name||'.'||column_name from information_schema.columns
  where table_schema='public' and column_name in ('checkout_wage','wage_kind','auto_amount') order by 1`).out.trim().split('\n');
ok('the three columns exist', cols.join()==='expenses.auto_amount,expenses.wage_kind,staff.checkout_wage', cols);

console.log('\n— what it will hold —');
r=psql(DB,[],`insert into public.staff (id,owner_id,name,daily_wage,checkout_wage) values ('stf1','${OWNER}','Lakshmi Walikar',300,500)`);
ok('a checkout-day wage is stored', !r.err, r.err);
r=psql(DB,[],`insert into public.staff (id,owner_id,name,daily_wage,checkout_wage) values ('stfX','${OWNER}','X',300,null)`);
ok('blank is allowed (it means the daily wage)', !r.err, r.err);
r=psql(DB,[],`insert into public.staff (id,owner_id,name,checkout_wage) values ('stfY','${OWNER}','Y',-5)`);
ok('a negative wage is refused', /staff_checkout_wage_positive/.test(r.err), r.err);
r=psql(DB,[],`insert into public.expenses (id,owner_id,description,date,category,amount,wage_kind) values ('x1','${OWNER}','x','2026-10-01','staff',1,'weekend')`);
ok('an unknown wage kind is refused', /expenses_wage_kind_known/.test(r.err), r.err);

console.log('\n— her page —');
r=psql(DB,[],`
  insert into public.properties (id,owner_id,name) values ('p1','${OWNER}','Raaya Vasyam');
  insert into public.staff_access (user_id,owner_id,staff_id,display_name) values ('${HER}','${OWNER}','stf1','Lakshmi');
  insert into public.expenses (id,owner_id,property_id,staff_id,description,date,category,amount,gross_amount,loan_deduction,paid,wage_kind,auto_amount) values
   ('wag_stf1_20261012','${OWNER}','p1','stf1','Wage — Lakshmi Walikar · 12 Oct · checkout day','2026-10-12','staff',500,500,0,false,'checkout',500),
   ('wag_stf1_20261011','${OWNER}','p1','stf1','Wage — Lakshmi Walikar · 11 Oct','2026-10-11','staff',300,300,0,false,'daily',300),
   ('wag_stf1_20261010','${OWNER}','p1','stf1','Wage — Lakshmi Walikar · 10 Oct','2026-10-10','staff',300,300,0,false,null,null);`);
ok('seeded', !r.err, r.err);
r=as('authenticated',HER,'select public.staff_standing()');
let st=null; try{st=JSON.parse(r.out.trim());}catch{}
ok('she can still read her standing', !!st&&!r.err, r.err||r.out);
const days=(st&&st.pending&&st.pending.days)||[];
const day=d=>days.find(x=>x.date===d)||{};
ok('the checkout day is marked', day('2026-10-12').checkout===true, days);
ok('an ordinary day is not', day('2026-10-11').checkout===false, days);
ok('a day made before this release reads as ordinary, not as an error', day('2026-10-10').checkout===false, days);
ok('the figures are unchanged', st&&st.pending.amount===1100&&st.pending.count===3&&day('2026-10-12').net===500, st&&st.pending);
ok('and so is everything else she is sent', st&&'attendance' in st&&'this_month' in st&&'overall' in st&&'loans' in st, st&&Object.keys(st));
const standingAfter=psql(DB,[],`select pg_get_functiondef('public.staff_standing()'::regprocedure)`).out;
ok('the only change to the function is the checkout key',
   standingAfter.replace(/,\s*-- paid at the checkout-day rate: a guest left that day\s*'checkout', coalesce\(d\.wage_kind = 'checkout', false\)/,'')
     .replace(/\s+/g,' ')===standingBefore.replace(/\s+/g,' '));

console.log('\n— her access is no wider —');
r=as('authenticated',HER,'select count(*) from public.expenses');
ok('she still cannot read the expenses table', r.err||r.out.trim()==='0', r.err||r.out);
r=as('authenticated',HER,'select count(*) from public.staff');
ok('nor the staff table, with its wages', r.err||r.out.trim()==='0', r.err||r.out);
r=as('anon','','select public.staff_standing()');
ok('and someone not signed in gets nothing', /permission denied/.test(r.err)||r.out.trim()==='', r.err||r.out);

psql('postgres',['-c',`drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
