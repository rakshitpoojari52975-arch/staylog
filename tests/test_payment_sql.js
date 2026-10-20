/* supabase/payment-details.sql on a real Postgres, after setup.sql, with
   stand-ins for what Supabase provides: runs twice, refuses a malformed UPI ID
   or a non-image QR, and keeps the details the owner's alone — the house help
   and anyone not signed in see none of it.

     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_payment_sql.js
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
const DB='staylog_payment_test', OWNER='11111111-1111-1111-1111-111111111111', HER='33333333-3333-3333-3333-333333333333';
const as=(role,uid,q)=>psql(DB,['-c',`begin; set local role ${role}; set local request.jwt.uid='${uid}'; ${q}; rollback;`]);
const sql=q=>psql(DB,[],q);

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
r=psql(DB,['-f',F('setup.sql')]); ok('setup.sql loads', !r.err, r.err);

console.log('\n— runs, and runs again —');
r=psql(DB,['-f',F('payment-details.sql')]); ok('first run', !r.err, r.err);
r=psql(DB,['-f',F('payment-details.sql')]); ok('second run changes nothing and does not fail', !r.err, r.err);
const cols=sql(`select string_agg(column_name,',' order by column_name) from information_schema.columns
  where table_schema='public' and table_name='properties' and column_name in ('upi_id','upi_payee','upi_qr','bank_details')`).out.trim();
ok('the four columns exist', cols==='bank_details,upi_id,upi_payee,upi_qr', cols);

console.log('\n— what it will hold —');
r=sql(`insert into public.properties (id,owner_id,name,upi_id,upi_payee,upi_qr,bank_details) values
  ('p1','${OWNER}','Raaya Vasyam','staylog.test@fakebank','Test Payee','data:image/png;base64,iVBORw0KGgo=','Test Account · IFSC TEST0000000')`);
ok('good payment details are stored', !r.err, r.err);
r=sql(`update public.properties set upi_id='not a upi id' where id='p1'`);
ok('a malformed UPI ID is refused', /properties_upi_id_shape/.test(r.err), r.err);
r=sql(`update public.properties set upi_qr='https://example.com/qr.png' where id='p1'`);
ok('a QR that is not an image is refused', /properties_upi_qr_image/.test(r.err), r.err);
r=sql(`update public.properties set upi_id=null, upi_qr=null, bank_details=null where id='p1'`);
ok('all of it is optional', !r.err, r.err);
sql(`update public.properties set upi_id='staylog.test@fakebank', bank_details='Test Account' where id='p1'`);

console.log('\n— whose it is —');
r=as('authenticated',OWNER,`select upi_id from public.properties where id='p1'`);
ok('the owner reads it', r.out.trim()==='staylog.test@fakebank', r.err||r.out);
sql(`insert into public.staff (id,owner_id,name) values ('stf1','${OWNER}','Laxmi');
     insert into public.staff_access (user_id,owner_id,staff_id,display_name) values ('${HER}','${OWNER}','stf1','Laxmi');`);
r=as('authenticated',HER,`select count(*) from public.properties`);
ok('the house help cannot read the properties table', r.err||r.out.trim()==='0', r.err||r.out);
r=sql(`select pg_get_function_result('public.staff_calendar()'::regprocedure)`);
ok('her calendar still returns no payment column', !/upi|bank/i.test(r.out)&&/property/.test(r.out), r.out.trim());
r=as('anon','',`select count(*) from public.properties`);
ok('someone not signed in sees none of it', r.err||r.out.trim()==='0', r.err||r.out);

psql('postgres',['-c',`drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
