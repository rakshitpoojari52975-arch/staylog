/* supabase/ical.sql against a real Postgres, with stand-ins for what Supabase
   provides (auth.users, auth.uid(), the anon/authenticated roles, and its
   default of granting those roles ALL on new tables). Checks it runs twice
   and that the access rules hold.

   Needs a throwaway Postgres you can be superuser on, e.g.:
     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_ical_sql.js
   Without STAYLOG_PG it says so and skips. It creates and drops its own
   database, staylog_ical_test. */
const {execFileSync}=require('child_process');
const path=require('path');
const SQL=path.resolve(__dirname,'../supabase/ical.sql');
const SETUP=path.resolve(__dirname,'../supabase/setup.sql'), REPORT=path.resolve(__dirname,'../supabase/ical-report.sql');
const CONN=(process.env.STAYLOG_PG||'').split(/\s+/).filter(Boolean);
if(!CONN.length){console.log('STAYLOG_PG not set — skipping the SQL checks (see the header).');process.exit(0);}
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const psql=(db,args,input)=>{try{return{out:execFileSync('psql',[...CONN,'-d',db,'-q','-t','-A','-v','ON_ERROR_STOP=1',...args],
  {input,encoding:'utf8',stdio:['pipe','pipe','pipe']}),err:''};}catch(e){return{out:'',err:String(e.stderr||e.message)};}};
const DB='staylog_ical_test', U1='11111111-1111-1111-1111-111111111111', U2='22222222-2222-2222-2222-222222222222';
const as=(role,uid,sql)=>psql(DB,['-c',`begin; set local role ${role}; set local request.jwt.uid='${uid}'; ${sql}; rollback;`]);

psql('postgres',['-c',`drop database if exists ${DB}`]);
psql('postgres',['-c',`create database ${DB}`]);
const setup=psql(DB,[],`
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $f$ select nullif(current_setting('request.jwt.uid', true),'')::uuid $f$;
  create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  insert into auth.users values ('${U1}'),('${U2}');`);
ok('Supabase stand-ins are in place', !setup.err, setup.err);

let r=psql(DB,['-f',SETUP]); ok('setup.sql loads first, as in the real project', !r.err, r.err);
console.log('\n— runs, and runs again —');
r=psql(DB,['-f',SQL]); ok('first run', !r.err, r.err);
r=psql(DB,['-f',SQL]);     ok('second run changes nothing and does not fail', !r.err, r.err);
r=psql(DB,[],`insert into ical_feeds (id,owner_id,property_id,platform,url) values
   ('aaaaaaaa-0000-0000-0000-000000000001','${U1}','p1','Airbnb','https://a/1.ics'),
   ('aaaaaaaa-0000-0000-0000-000000000002','${U2}','q1','Airbnb','https://a/2.ics');
 insert into ical_events (feed_id,uid,owner_id,property_id,platform,start_date,end_date,kind) values
   ('aaaaaaaa-0000-0000-0000-000000000001','e1','${U1}','p1','Airbnb','2026-10-15','2026-10-18','reserved'),
   ('aaaaaaaa-0000-0000-0000-000000000002','e2','${U2}','q1','Airbnb','2026-10-15','2026-10-18','reserved');`);
ok('the function (service role) can write feeds and events', !r.err, r.err);

console.log('\n— the owner —');
r=as('authenticated',U1,'select count(*) from ical_events'); ok('reads only their own events', r.out.trim()==='1', r);
r=as('authenticated',U1,'select count(*) from ical_feeds');  ok('reads only their own feeds', r.out.trim()==='1', r);
r=as('authenticated',U1,"update ical_events set imported_booking_id='ics_x' where uid='e1' returning uid");
ok('may stamp the booking id', r.out.trim()==='e1', r);
r=as('authenticated',U1,"update ical_events set imported_booking_id='x' where uid='e2' returning uid");
ok('stamping another owner\'s event touches nothing', !r.err&&r.out.trim()==='', r);
for(const [n,sql] of [['change dates',"update ical_events set end_date='2027-01-01' where uid='e1'"],
  ['clear gone_at',"update ical_events set gone_at=null where uid='e1'"],
  ['insert events',`insert into ical_events (feed_id,uid,owner_id,property_id,platform,start_date,end_date,kind) values ('aaaaaaaa-0000-0000-0000-000000000001','zz','${U1}','p1','Airbnb','2026-10-15','2026-10-18','reserved')`],
  ['delete events',"delete from ical_events where uid='e1'"],
  ['truncate events','truncate ical_events cascade'],['truncate feeds','truncate ical_feeds cascade']]){
  r=as('authenticated',U1,sql); ok(`may not ${n}`, /permission denied/.test(r.err), r.err||r.out);
}
r=as('authenticated',U1,"insert into ical_feeds (property_id,platform,url) values ('p1','Booking.com','https://b/1.ics') returning platform");
ok('adds a feed, owner filled in for them', r.out.trim()==='Booking.com', r);
r=as('authenticated',U1,`insert into ical_feeds (owner_id,property_id,platform,url) values ('${U1}','p1','Airbnb','https://a/new.ics')
  on conflict (owner_id,property_id,platform) do update set url=excluded.url returning url`);
ok('the app\'s upsert replaces the link in place', r.out.trim()==='https://a/new.ics', r);
r=as('authenticated',U1,`insert into ical_feeds (owner_id,property_id,platform,url) values ('${U2}','p1','Airbnb','https://x')`);
ok('may not add a feed for someone else', /row-level security/.test(r.err), r.err);
r=as('authenticated',U1,"insert into ical_feeds (property_id,platform,url) values ('p2','Airbnb','http://a/1.ics')");
ok('an http:// link is refused', /check constraint/.test(r.err), r.err);
r=as('authenticated',U1,"insert into ical_feeds (property_id,platform,url) values ('p2','Vrbo','https://v')");
ok('an unknown platform is refused', /check constraint/.test(r.err), r.err);

console.log('\n— anyone not signed in —');
for(const tb of ['ical_events','ical_feeds']){
  r=as('anon','',`select count(*) from ${tb}`); ok(`cannot read ${tb}`, /permission denied/.test(r.err), r.err||r.out);
  r=as('anon','',`truncate ${tb} cascade`);      ok(`cannot truncate ${tb}`, /permission denied/.test(r.err), r.err||r.out);
}

console.log('\n— the comparison report (supabase/ical-report.sql) —');
r=psql(DB,[],`delete from ical_events; delete from ical_feeds;
 insert into public.properties (id, owner_id, name) values ('p1','${U1}','Raaya Vasyam');
 insert into ical_feeds (id, owner_id, property_id, platform, url) values
  ('aaaaaaaa-0000-0000-0000-000000000001','${U1}','p1','Airbnb','https://a/1.ics'),
  ('aaaaaaaa-0000-0000-0000-000000000002','${U1}','p1','Booking.com','https://b/1.ics');
 insert into public.bookings (id, owner_id, property_id, guest_name, check_in, check_out, source, status, total_amount, deleted_at) values
  ('ics_a1','${U1}','p1','Airbnb guest','2026-10-20','2026-10-23','Airbnb','confirmed',0,null),
  ('ics_b2','${U1}','p1','Kavya S','2026-11-02','2026-11-04','Booking.com','confirmed',5200,null),
  ('bkTyped','${U1}','p1','Rahul Menon','2026-11-10','2026-11-12','Booking.com','confirmed',4800,null),
  ('ics_b4','${U1}','p1','Booking.com guest','2026-12-01','2026-12-03','Booking.com','confirmed',0,now()),
  ('bkDirect','${U1}','p1','Walk-in','2026-12-10','2026-12-11','Direct','confirmed',2000,null);
 insert into ical_events (feed_id,uid,owner_id,property_id,platform,start_date,end_date,kind,gone_at,imported_booking_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001','A1','${U1}','p1','Airbnb','2026-10-20','2026-10-23','reserved',null,'ics_a1'),
  ('aaaaaaaa-0000-0000-0000-000000000002','B1','${U1}','p1','Booking.com','2026-10-20','2026-10-23','reserved',null,'ics_a1'),
  ('aaaaaaaa-0000-0000-0000-000000000002','B2','${U1}','p1','Booking.com','2026-11-02','2026-11-04','reserved',now(),'ics_b2'),
  ('aaaaaaaa-0000-0000-0000-000000000002','B3','${U1}','p1','Booking.com','2026-11-10','2026-11-12','reserved',null,'bkTyped'),
  ('aaaaaaaa-0000-0000-0000-000000000002','B4','${U1}','p1','Booking.com','2026-12-01','2026-12-03','reserved',null,'ics_b4'),
  ('aaaaaaaa-0000-0000-0000-000000000001','A9','${U1}','p1','Airbnb','2026-12-20','2026-12-22','blocked',null,null);`);
ok('seeded', !r.err, r.err);
r=psql(DB,['-F','|','-f',REPORT]);
const rows=r.out.trim().split('\n').filter(Boolean).map(l=>l.split('|'));
ok('it runs', !r.err, r.err);
ok('one row per booking that a feed lists, deleted ones and plain blocks left out',
   rows.map(x=>x[8]).join()==='ics_a1,ics_b2,bkTyped', rows);
const row=id=>rows.find(x=>x[8]===id)||[];   // no source, guest name or amount since the minimal cloud
ok('a stay and its copy on the other platform are one row, listed by both feeds',
   row('ics_a1')[5]==='imported'&&row('ics_a1')[6]==='Airbnb, Booking.com', row('ics_a1'));
ok('a stay gone from its feed says so', row('ics_b2')[6]==='Booking.com (gone)'&&row('ics_b2')[7]==='t', row('ics_b2'));
ok('a stay you typed in is shown as matched', row('bkTyped')[5]==='matched'&&row('bkTyped')[7]==='f', row('bkTyped'));
ok('and the report shows no guest name, source or amount', !rows.some(x=>x.some(v=>/Kavya|Rahul|Walk-in|5200|4800|Airbnb guest/.test(v))), rows);
ok('with dates and nights to compare', row('ics_a1')[0]==='2026-10-20'&&row('ics_a1')[1]==='2026-10-23'&&row('ics_a1')[2]==='3', row('ics_a1'));
r=psql(DB,[],`select count(*) from public.bookings where deleted_at is null`);
const before=r.out.trim(); psql(DB,['-f',REPORT]);
ok('the report changes nothing', psql(DB,[],`select count(*) from public.bookings where deleted_at is null`).out.trim()===before);

psql('postgres',['-c',`drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
