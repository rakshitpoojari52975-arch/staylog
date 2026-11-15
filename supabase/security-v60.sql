-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog v60 — security fixes for the current single-owner setup
-- (review, Appendix A §1). Run in the Supabase SQL editor. Safe to run twice.
-- Changes no data.
--
-- Run order for v60:
--   1. Authentication → Sign In / Providers → turn OFF "Allow new users to sign up"
--   2. utensils.sql      (her staff_standing now matches every row by owner)
--   3. this file
--
-- What it does
--   1.1  Writes need an owner. A RESTRICTIVE policy "owners only" on every
--        table the owner app uses: Postgres ANDs it with the existing owner
--        policies, so a signed-in account that is not in public.owners (a staff
--        login, a stranger) can read and change nothing — whatever older
--        scripts re-create. Her page is unaffected: it only calls SECURITY
--        DEFINER functions. staff_access also lets her read her own row.
--   1.2  Refuses to finish unless staff_standing() matches rows by owner
--        (utensils.sql, step 2).
--   1.4  A mark's id must be its staff and date: att_<staff>_<yyyymmdd>,
--        ute_<staff>_<yyyymmdd>. Existing rows are checked; any that do not
--        fit are listed and left as they are (the rule still holds for every
--        new or changed row).
--        attendance loses Supabase's default ALL grant (TRUNCATE included):
--        the owner app reads it and stamps expense_id, nothing more.
--   1.8  sync_status gains device_id and device_name: one phone syncs an account.
--   +    public.app_status: one row the apps read to learn whether their
--        version has been retired (min_version, set at the cutover). 0 = none.
-- ─────────────────────────────────────────────────────────────────────────────

do $guard$
declare n int;
begin
  select count(*) into n from public.owners;
  if n = 0 then
    raise exception 'public.owners is empty. Add your own user id first (setup.sql, step 5): '
      'without it these rules would lock you out of your own data. Nothing was changed.';
  end if;
  if pg_get_functiondef('public.staff_standing()'::regprocedure) not like '%owner_id = me.owner_id%' then
    raise exception 'Run supabase/utensils.sql first: her staff_standing() must match rows by owner. Nothing was changed.';
  end if;
end $guard$;

-- ── 1.1 owners only ──────────────────────────────────────────────────────────
do $owners$
declare t text;
begin
  foreach t in array array['properties','bookings','staff','loans','loan_repayments','expenses',
                           'attendance','utensil_marks','ical_feeds','ical_events',
                           'push_subscriptions','notification_prefs','sync_status','push_log','backups']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists "owners only" on public.%I', t);
      execute format('create policy "owners only" on public.%I as restrictive for all
                      using (public.is_owner()) with check (public.is_owner())', t);
    end if;
  end loop;
end $owners$;

-- staff_access: the owner manages it; she may still read her own row.
drop policy if exists "owners only" on public.staff_access;
create policy "owners only" on public.staff_access as restrictive for all
  using (public.is_owner() or user_id = auth.uid())
  with check (public.is_owner());

-- ── 1.4 a mark's id is its staff and date ────────────────────────────────────
do $marks$
declare bad text;
begin
  begin
    alter table public.attendance add constraint attendance_id_matches
      check (id = public.attendance_id(staff_id, date)) not valid;
  exception when duplicate_object then null; end;
  begin
    alter table public.attendance validate constraint attendance_id_matches;
  exception when check_violation then
    select string_agg(id, ', ') into bad from public.attendance where id <> public.attendance_id(staff_id, date);
    raise notice 'attendance rows whose id does not match staff and date (left as they are): %', bad;
  end;

  if to_regclass('public.utensil_marks') is not null then
    begin
      alter table public.utensil_marks add constraint utensil_marks_id_matches
        check (id = public.utensil_mark_id(staff_id, date)) not valid;
    exception when duplicate_object then null; end;
    begin
      alter table public.utensil_marks validate constraint utensil_marks_id_matches;
    exception when check_violation then
      select string_agg(id, ', ') into bad from public.utensil_marks where id <> public.utensil_mark_id(staff_id, date);
      raise notice 'utensil_marks rows whose id does not match staff and date (left as they are): %', bad;
    end;
  end if;
end $marks$;

revoke all on public.attendance from anon, authenticated;
grant select on public.attendance to authenticated;
grant update (expense_id) on public.attendance to authenticated;

-- ── 1.8 which phone syncs this account ───────────────────────────────────────
-- v60 records its device id with every good sync; a second phone pauses until
-- "This is now my only phone" (two whole-state pushes delete each other's rows).
do $dev$ begin
  if to_regclass('public.sync_status') is not null then
    alter table public.sync_status add column if not exists device_id   text;
    alter table public.sync_status add column if not exists device_name text;
  end if;
end $dev$;

-- ── app_status: is this version of the app retired? ──────────────────────────
-- min_version: any app older than this stops syncing and says "StayLog has
-- been updated — close and reopen" (set at the cutover to the new cloud; 0 =
-- nothing retired). A version number, not a flag, so the new app is never
-- caught by it.
create table if not exists public.app_status (
  id          int primary key default 1 check (id = 1),
  min_version int not null default 0,
  message     text,
  updated_at  timestamptz not null default now()
);
insert into public.app_status (id) values (1) on conflict (id) do nothing;
alter table public.app_status enable row level security;
drop policy if exists "anyone reads" on public.app_status;
create policy "anyone reads" on public.app_status for select using (true);
revoke all on public.app_status from anon, authenticated;
grant select on public.app_status to anon, authenticated;

-- ── Check (read-only): every row should say "ok" ─────────────────────────────
select t as "table",
       case when exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t
                         and p.policyname = 'owners only' and p.permissive = 'RESTRICTIVE')
            then 'ok' else 'MISSING' end as "owners only"
from unnest(array['properties','bookings','staff','loans','loan_repayments','expenses','staff_access',
                  'attendance','utensil_marks','ical_feeds','ical_events','push_subscriptions',
                  'notification_prefs','sync_status','push_log','backups']) t
where to_regclass('public.' || t) is not null;
