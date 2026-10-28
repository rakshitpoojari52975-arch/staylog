/* supabase/push.sql on a real Postgres, after setup.sql, with stand-ins for
   what Supabase provides: runs twice, and every table is the owner's alone —
   another account, the house help and anyone not signed in see and change
   nothing, and the owner cannot forge the function's send log.

     STAYLOG_PG="-h /var/tmp/staylog-pg -p 54329 -U postgres" node tests/test_push_sql.js
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
const DB='staylog_push_test', OWNER='11111111-1111-1111-1111-111111111111', OTHER='22222222-2222-2222-2222-222222222222',
  HER='33333333-3333-3333-3333-333333333333';
const as=(role,uid,q)=>psql(DB,['-c',`begin; set local role ${role}; set local request.jwt.uid='${uid}'; ${q}; commit;`]);
const sql=q=>psql(DB,[],q);
const n=r=>r.err?'error':r.out.trim();

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
  insert into auth.users(id) values ('${OWNER}'),('${OTHER}'),('${HER}');`);
ok('Supabase stand-ins are in place', !r.err, r.err);
r=psql(DB,['-f',F('setup.sql')]); ok('setup.sql loads', !r.err, r.err);

console.log('\n— runs, and runs again —');
r=psql(DB,['-f',F('push.sql')]); ok('first run', !r.err, r.err);
r=psql(DB,['-f',F('push.sql')]); ok('second run changes nothing and does not fail', !r.err, r.err);
ok('the private key is nowhere in the script', !/VAPID_PRIVATE|BEGIN [A-Z ]*PRIVATE KEY|"d"\s*:/.test(require('fs').readFileSync(F('push.sql'),'utf8')));

console.log('\n— the owner\'s devices and settings —');
r=as('authenticated',OWNER,`insert into public.push_subscriptions (endpoint,p256dh,auth,device) values ('https://web.push.apple.com/A','pk','au','iPhone')`);
ok('the owner saves his iPhone (owner filled in for him)', !r.err, r.err);
ok('it is recorded as his', sql(`select owner_id from public.push_subscriptions`).out.trim()===OWNER);
r=as('authenticated',OWNER,`insert into public.push_subscriptions (endpoint,p256dh,auth) values ('https://web.push.apple.com/A','pk2','au2')
  on conflict (endpoint) do update set p256dh=excluded.p256dh, last_seen_at=now()`);
ok('re-saving on every open updates the same row', !r.err&&sql(`select count(*)||p256dh from public.push_subscriptions group by p256dh`).out.trim()==='1pk2', r.err);
r=as('authenticated',OWNER,`insert into public.notification_prefs (prefs) values ('{"arrivals":false}') on conflict (owner_id) do update set prefs=excluded.prefs`);
ok('he saves his alert settings', !r.err, r.err);
r=as('authenticated',OWNER,`insert into public.sync_status (last_sync_at) values (now()) on conflict (owner_id) do update set last_sync_at=excluded.last_sync_at`);
ok('his phone records a sync', !r.err, r.err);
r=as('authenticated',OWNER,`insert into public.sync_status (last_sync_at) values (now()) on conflict (owner_id) do update set last_sync_at=excluded.last_sync_at`);
ok('and again, as an upsert', !r.err, r.err);
r=as('authenticated',OWNER,`delete from public.push_subscriptions where endpoint='https://web.push.apple.com/A' returning 1`);
ok('he removes a device', n(r)==='1', r.err||r.out);
as('authenticated',OWNER,`insert into public.push_subscriptions (endpoint,p256dh,auth) values ('https://web.push.apple.com/A','pk','au')`);
sql(`insert into public.push_log (owner_id,key) values ('${OWNER}','arrival:b1:2026-10-21')`);
ok('he may read what was sent to him', n(as('authenticated',OWNER,`select count(*) from public.push_log`))==='1');

console.log('\n— nobody else —');
for(const [who,role,uid] of [['another account','authenticated',OTHER],['the house help','authenticated',HER],['someone not signed in','anon','']]){
  const counts=['push_subscriptions','notification_prefs','sync_status','push_log']
    .map(t=>n(as(role,uid,`select count(*) from public.${t}`)));
  ok(`${who} sees none of it`, counts.every(c=>c==='0'||c==='error'), counts);
  r=as(role,uid,`insert into public.push_subscriptions (endpoint,owner_id,p256dh,auth) values ('https://evil/${role}${uid}','${OWNER}','x','y')`);
  ok(`${who} cannot add a device to the owner's account`, !!r.err, r.out);
  r=as(role,uid,`update public.notification_prefs set prefs='{}' returning 1`);
  ok(`${who} cannot change his settings`, !!r.err||r.out.trim()==='', r.out);
  r=as(role,uid,`update public.sync_status set last_sync_at=now() returning 1`);
  ok(`${who} cannot fake a sync`, !!r.err||r.out.trim()==='', r.out);
  r=as(role,uid,`delete from public.push_subscriptions returning 1`);
  ok(`${who} cannot remove his devices`, !!r.err||r.out.trim()==='', r.out);
}
r=as('authenticated',OWNER,`insert into public.push_log (owner_id,key) values ('${OWNER}','x')`);
ok('the owner cannot write the send log (the function\'s, via the service role)', !!r.err, r.out);
for(const t of ['push_subscriptions','notification_prefs','sync_status','push_log']){
  r=as('authenticated',OWNER,`truncate public.${t}`);
  ok(`no one can TRUNCATE ${t} (which ignores RLS)`, /permission denied/.test(r.err), r.err||'truncated');
}
ok('his rows are all still there', sql(`select (select count(*) from public.push_subscriptions)||','||(select count(*) from public.notification_prefs)||','||(select count(*) from public.sync_status)||','||(select count(*) from public.push_log)`).out.trim()==='1,1,1,1');

console.log('\n— inbox.sql: the owner may mark read, nothing more —');
r=psql(DB,['-f',F('inbox.sql')]); ok('inbox.sql runs', !r.err, r.err);
r=psql(DB,['-f',F('inbox.sql')]); ok('and runs again', !r.err, r.err);
ok('the old row is kept, counted as delivered and unread', sql(`select delivered::text||','||coalesce(read_at::text,'unread') from public.push_log`).out.trim()==='true,unread');
sql(`insert into public.push_log (owner_id,key,title,body,url,alert,delivered) values
  ('${OWNER}','balance:b2:2026-10-22','Balance due','₹4,000 to collect','./#open=b2&send=payment','balances',false),
  ('${OTHER}','stale:2026-10-20','StayLog has not synced','x','./#open=cloud','stale',true)`);
r=as('authenticated',OWNER,`select key||':'||delivered from public.push_log where title is not null`);
ok('the owner reads his inbox, undelivered included, and only his', r.out.trim()==='balance:b2:2026-10-22:false', r.err||r.out);
r=as('authenticated',OWNER,`update public.push_log set read_at=now() where read_at is null returning key`);
ok('he marks his rows read', !r.err&&r.out.trim().split('\n').length===2, r.err||r.out);
for(const [col,val] of [['title',"'forged'"],['delivered','true'],['body',"'x'"],['url',"'https://evil'"],['sent_at','now()'],['key',"'k'"],['claimed_at','now()']]){
  r=as('authenticated',OWNER,`update public.push_log set ${col}=${val} returning 1`);
  ok(`but cannot change ${col}`, /permission denied/.test(r.err), r.err||r.out);
}
r=as('authenticated',OWNER,`delete from public.push_log returning 1`);
ok('nor delete a row', !!r.err||r.out.trim()==='', r.err||r.out);
r=as('authenticated',OTHER,`update public.push_log set read_at=now() where owner_id='${OWNER}' returning 1`);
ok('another account cannot mark his rows', r.out.trim()==='', r.err||r.out);
r=as('anon','',`update public.push_log set read_at=now() returning 1`);
ok('nor can anyone not signed in', !!r.err||r.out.trim()==='', r.out);
r=as('authenticated',OWNER,`truncate public.push_log`);
ok('still no TRUNCATE', /permission denied/.test(r.err), r.err||'truncated');
r=psql(DB,['-f',F('push.sql')]);
r=as('authenticated',OWNER,`update public.push_log set read_at=null returning 1`);
ok('re-running push.sql afterwards keeps the mark-read grant', !r.err&&r.out.trim()!=='', r.err||r.out);

psql('postgres',['-c',`drop database if exists ${DB}`]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
