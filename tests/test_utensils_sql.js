/* supabase/utensils.sql on a real Postgres, after setup.sql, attendance.sql
   and checkout-wage.sql as in the real project, with stand-ins for what
   Supabase provides. The rules live in SQL, so they are tested there:
   once a day, only when present, the 15-minute undo, undone with attendance,
   and her access no wider than before.

     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_utensils_sql.js
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
const DB='staylog_utensils_test', OWNER='11111111-1111-1111-1111-111111111111', HER='33333333-3333-3333-3333-333333333333';
// As her, committed (her taps are real writes). Returns parsed JSON when it is JSON.
const her=sql=>{const r=psql(DB,['-c',`begin; set local role authenticated; set local request.jwt.uid='${HER}'; ${sql}; commit;`]);
  try{return{...r,json:JSON.parse(r.out.trim().split('\n').pop())};}catch{return r;}};
const sql=s=>psql(DB,[],s);
const today=`(now() at time zone 'Asia/Kolkata')::date`;
const uRow=()=>sql(`select coalesce(json_agg(json_build_object('id',id,'deleted',deleted_at is not null,'expense',expense_id))::text,'[]')
  from public.utensil_marks`).out.trim();

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
  insert into auth.users(id) values ('${OWNER}'),('${HER}');`);
ok('Supabase stand-ins are in place', !r.err, r.err);
for(const f of ['setup.sql','attendance.sql','checkout-wage.sql']){r=psql(DB,['-f',F(f)]); ok(f+' loads', !r.err, r.err);}
const attFns=sql(`select string_agg(pg_get_functiondef(p.oid),'' order by p.proname) from pg_proc p
  where p.proname in ('staff_mark_today','staff_unmark_today','attendance_id','attendance_undo_window')`).out;
const standingBefore=sql(`select pg_get_functiondef('public.staff_standing()'::regprocedure)`).out;

console.log('\n— runs, and runs again —');
r=psql(DB,['-f',F('utensils.sql')]); ok('first run', !r.err, r.err);
r=psql(DB,['-f',F('utensils.sql')]); ok('second run changes nothing and does not fail', !r.err, r.err);
ok('attendance\'s own functions are untouched', sql(`select string_agg(pg_get_functiondef(p.oid),'' order by p.proname) from pg_proc p
  where p.proname in ('staff_mark_today','staff_unmark_today','attendance_id','attendance_undo_window')`).out===attFns);
r=sql(`insert into public.properties (id,owner_id,name) values ('p1','${OWNER}','Raaya Vasyam');
  insert into public.staff (id,owner_id,name,daily_wage,utensil_rate) values ('stf1','${OWNER}','Laxmi',300,100);
  insert into public.staff_access (user_id,owner_id,staff_id,display_name) values ('${HER}','${OWNER}','stf1','Laxmi');`);
ok('seeded (a utensil rate is stored)', !r.err, r.err);
r=sql(`insert into public.staff (id,owner_id,name,utensil_rate) values ('stfN','${OWNER}','N',-1)`);
ok('a negative rate is refused', /staff_utensil_rate_positive/.test(r.err), r.err);

console.log('\n— only once she is present —');
r=her('select public.staff_mark_utensils_today()');
ok('it cannot be marked without attendance that day', r.json&&r.json.ok===false&&r.json.reason==='not_present', r.json||r.err);
ok('and nothing is written', uRow()==='[]', uRow());
let st=her('select public.staff_standing()').json;
ok('her page is told it is not available yet', st&&st.utensils&&st.utensils.available===false&&st.utensils.marked===false, st&&st.utensils);

her('select public.staff_mark_today()');
r=her('select public.staff_mark_utensils_today()');
ok('once present, it can', r.json&&r.json.ok===true, r.json||r.err);
r=her('select public.staff_mark_utensils_today()');
ok('a second tap is fine', r.json&&r.json.ok===true, r.json||r.err);
let rows=JSON.parse(uRow());
ok('marking twice in one day counts once', rows.length===1&&rows[0].id===`ute_stf1_${sql(`select to_char(${today},'YYYYMMDD')`).out.trim()}`, rows);
st=her('select public.staff_standing()').json;
ok('her page sees it marked, with undo open', st.utensils.available&&st.utensils.marked&&st.utensils.can_undo===true, st.utensils);

console.log('\n— undo —');
r=her('select public.staff_unmark_utensils_today()');
ok('within 15 minutes she can undo it', r.json&&r.json.ok===true&&JSON.parse(uRow())[0].deleted, r.json||r.err);
her('select public.staff_mark_utensils_today()');
ok('and mark it again: the same row, alive', JSON.parse(uRow()).length===1&&!JSON.parse(uRow())[0].deleted);
sql(`update public.utensil_marks set marked_at = now() - interval '16 minutes'`);
r=her('select public.staff_unmark_utensils_today()');
ok('after 15 minutes she cannot', r.json&&r.json.ok===false&&r.json.reason==='too_late', r.json);
ok('and her page stops offering it', her('select public.staff_standing()').json.utensils.can_undo===false);

console.log('\n— undoing attendance undoes it —');
sql(`update public.utensil_marks set marked_at = now()`);      // fresh again
r=her('select public.staff_unmark_today()');
ok('her attendance undo works as before', r.json&&r.json.ok===true, r.json||r.err);
ok('and takes the day\'s utensil mark with it', JSON.parse(uRow())[0].deleted===true, uRow());
st=her('select public.staff_standing()').json;
ok('so her page shows neither', st.attendance.marked===false&&st.utensils.marked===false&&st.utensils.available===false, st.utensils);
r=her('select public.staff_mark_today()');
ok('marking present again does not bring the utensils back by itself', JSON.parse(uRow())[0].deleted===true);

console.log('\n— once counted —');
her('select public.staff_mark_utensils_today()');
r=sql(`begin; set local role authenticated; set local request.jwt.uid='${OWNER}';
  update public.utensil_marks set expense_id = id where owner_id = auth.uid() returning id; commit;`);
ok('the owner\'s app can stamp it as converted', !r.err&&/ute_stf1_/.test(r.out), r.err||r.out);
r=her('select public.staff_unmark_utensils_today()');
ok('a counted mark cannot be undone by her', r.json&&r.json.ok===false&&r.json.reason==='already_counted', r.json);
sql(`update public.attendance set expense_id = null`);          // attendance itself still open
her('select public.staff_unmark_today()');
ok('nor is it undone along with attendance', JSON.parse(uRow())[0].deleted===false&&!!JSON.parse(uRow())[0].expense, uRow());
r=sql(`begin; set local role authenticated; set local request.jwt.uid='${OWNER}';
  update public.utensil_marks set date = date - 1; commit;`);
ok('the owner may only stamp, not rewrite a mark', /permission denied/.test(r.err), r.err);

console.log('\n— her standing —');
her('select public.staff_mark_today()');
r=sql(`insert into public.expenses (id,owner_id,property_id,staff_id,description,date,category,amount,gross_amount,loan_deduction,paid,wage_kind,auto_amount) values
   ('wag_stf1_20261012','${OWNER}','p1','stf1','Wage — Laxmi · 12 Oct · checkout day','2026-10-12','staff',500,500,0,false,'checkout',500),
   ('ute_stf1_20261012','${OWNER}','p1','stf1','Utensil cleaning — Laxmi · 12 Oct','2026-10-12','staff',100,100,0,false,null,null)`);
st=her('select public.staff_standing()').json;
const days=(st&&st.pending&&st.pending.days)||[];
ok('the wage and the utensil cleaning on one date are two lines', days.length===2, days);
ok('each says which it is', days.some(d=>d.kind==='wage'&&d.net===500&&d.checkout===true)&&days.some(d=>d.kind==='utensils'&&d.net===100&&d.checkout===false), days);
ok('the total owed counts both', st.pending.amount===600&&st.pending.count===2, st.pending);
const standingAfter=sql(`select pg_get_functiondef('public.staff_standing()'::regprocedure)`).out;
const strip=s=>s.replace(/\s+/g,' ');
ok('staff_standing only gained the utensils state and the line kind',
   strip(standingAfter
     .replace(/,\s*-- which line this is[^\n]*\n[^\n]*\n\s*'kind',[^\n]*\n/,'\n')
     .replace(/order by d\.date desc, d\.id\)/,'order by d.date desc)')
     .replace(/\s*-- Today's utensil mark, beside attendance[\s\S]*?on u\.id = public\.utensil_mark_id\(me\.staff_id, t\.d\)\s*\),/,''))
   ===strip(standingBefore));

console.log('\n— her access is no wider —');
for(const [n,q] of [['read the utensil table','select count(*) from public.utensil_marks'],
                    ['write to it',`insert into public.utensil_marks (id,owner_id,staff_id,date) values ('x','${OWNER}','stf1','2026-10-01')`],
                    ['empty it','truncate public.utensil_marks']]){
  r=psql(DB,['-c',`begin; set local role authenticated; set local request.jwt.uid='${HER}'; ${q}; rollback;`]);
  ok(`she cannot ${n} directly`, /permission denied|row-level security/.test(r.err)||r.out.trim()==='0', r.err||r.out);
}
r=psql(DB,['-c',`begin; set local role anon; select public.staff_mark_utensils_today(); rollback;`]);
ok('someone not signed in cannot mark', /permission denied/.test(r.err), r.err||r.out);

psql('postgres',['-c',`drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
