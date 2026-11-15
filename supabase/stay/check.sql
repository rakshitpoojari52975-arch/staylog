-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — check the new `stay` schema. Read-only: changes nothing.
-- Run after 01 → 02 → 03 → 04. Every row should say "ok"; anything else names
-- what to fix (usually: run the scripts again, in order).
-- ─────────────────────────────────────────────────────────────────────────────
with expected(t) as (values
  ('accounts'),('platform_admins'),('members'),('member_properties'),('staff_logins'),('invites'),
  ('properties'),('bookings'),('staff'),('staff_properties'),('expenses'),('loans'),('loan_repayments'),
  ('attendance'),('utensil_marks'),('receipt_series'),('ical_feeds'),('ical_events'),
  ('push_subscriptions'),('notification_prefs'),('push_log'),('sync_status'),('backups')),
allowed_delete(t) as (values ('member_properties'),('staff_properties'),('push_subscriptions'),('backups'),('ical_feeds')),
checks as (
  -- 1. every table exists, with row-level security on and at least one policy
  select 'table ' || e.t as "check",
         case when c.oid is null then 'MISSING — run 01-schema.sql'
              when not c.relrowsecurity then 'row-level security OFF — run 03-access.sql'
              when not exists (select 1 from pg_policies p where p.schemaname = 'stay' and p.tablename = e.t) then 'no policy — run 03-access.sql'
              else 'ok' end as result
  from expected e
  left join pg_class c on c.relname = e.t and c.relnamespace = 'stay'::regnamespace
  union all
  -- 2. anon has nothing; signed-in users have no TRUNCATE, and DELETE only on links and devices
  select 'grants on ' || g.table_name || ' to ' || g.grantee,
         'PROBLEM: ' || string_agg(g.privilege_type, ', ') || ' — run 03-access.sql'
  from information_schema.role_table_grants g
  where g.table_schema = 'stay' and g.grantee in ('anon','authenticated','PUBLIC')
    and (g.grantee <> 'authenticated' or g.privilege_type in ('TRUNCATE','REFERENCES','TRIGGER')
         or (g.privilege_type = 'DELETE' and g.table_name not in (select t from allowed_delete)))
  group by g.table_name, g.grantee
  union all
  -- 3. every foreign key between stay tables starts with account_id
  select 'foreign key ' || con.conname,
         case when (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) = 'account_id'
              then 'ok' else 'PROBLEM: not composite on account_id' end
  from pg_constraint con
  where con.contype = 'f' and con.connamespace = 'stay'::regnamespace
    and con.confrelid in (select oid from pg_class where relnamespace = 'stay'::regnamespace and relname <> 'accounts')
  union all
  -- 4. the functions the app and her page will call
  select 'function ' || f, case when to_regprocedure(f) is null then 'MISSING — run 02-functions.sql' else 'ok' end
  from unnest(array['stay.apply_change(text,jsonb,integer)','stay.issue_receipt(uuid,text)','stay.balance_due(stay.bookings)',
                    'stay.staff_calendar()','stay.staff_standing()','stay.staff_mark_today()','stay.staff_unmark_today()',
                    'stay.staff_mark_utensils_today()','stay.staff_unmark_utensils_today()','stay.process_pending(uuid)',
                    'stay.reprice_wages(uuid)','stay.create_account(text,text,text)']) f
  union all
  -- 5. a platform admin exists (you, from public.owners)
  select 'platform admin', case when exists (select 1 from stay.platform_admins) then 'ok'
                                else 'none — is your user id in public.owners?' end
  union all
  -- 6. phase 2: a loan need not belong to a staff member
  select 'loans without a staff member (04-phase2.sql)',
         case when (select is_nullable from information_schema.columns
                    where table_schema = 'stay' and table_name = 'loans' and column_name = 'staff_id') = 'YES'
              then 'ok' else 'not yet — run 04-phase2.sql' end
  union all
  -- 8. phase 5: staff "Works at" and her page's profile
  select 'staff Works at and her profile (07-staff.sql)',
         case when exists (select 1 from information_schema.columns where table_schema = 'stay' and table_name = 'staff' and column_name = 'works_at')
                   and to_regprocedure('public.staff_profile()') is not null
              then 'ok' else 'not yet — run 07-staff.sql' end
  union all
  -- 9. phase 6: the team
  select 'the team: invites, my_access, team() (08-team.sql)',
         case when to_regprocedure('stay.team(uuid)') is not null and to_regprocedure('stay.my_access(uuid)') is not null
              then 'ok' else 'not yet — run 08-team.sql' end
  union all
  -- 7. the old app's tables are still there and untouched by this phase
  select 'old table public.' || t, case when to_regclass('public.' || t) is not null then 'ok (unchanged)' else 'not found' end
  from unnest(array['properties','bookings','expenses','staff','loans','loan_repayments','attendance']) t
)
select * from checks order by (result like 'ok%'), "check";
