-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · minimal cloud, step 2 of 2: remove the old private data for good
--
-- Hard-removes what the cloud no longer needs, so old copies do not linger:
--   • drops the columns the phone no longer sends (guest names, phone numbers,
--     ID type and number, notes, amounts, receipt numbers, the signature, UPI
--     and bank details, Wi-Fi, wage rates, …);
--   • hard-deletes expenses that are not staff payouts;
--   • hard-deletes every tombstoned (deleted_at) row of the mirrored tables —
--     a parent only once nothing live still points at it;
--   • clears the Airbnb reservation text (link, last 4 phone digits) from
--     calendar events the phone has already imported;
--   • revokes Supabase's default ALL (TRUNCATE included, which ignores RLS)
--     on every table, and grants back only what the app and RLS expect.
-- Everything removed is on the phone and in the encrypted backup.
--
-- It REFUSES to run unless, for every owner with data here:
--   1. an encrypted backup was made in the last 24 hours, and
--   2. the last sync came from StayLog v51 or later (the minimal cloud).
-- All of it is one block: a refusal changes nothing.
--
-- Run after minimal-cloud.sql, once StayLog v51 has synced and backed up.
-- Safe to run twice. The check queries at the bottom are read-only; run them
-- any time.
--
-- Note: Supabase's own automatic database backups (and point-in-time recovery,
-- if enabled) still hold the old data until they age out under your plan's
-- retention. This script cannot reach them.
-- ─────────────────────────────────────────────────────────────────────────────

do $purge$
declare
  minimal_from constant int := 51;
  o uuid; last_backup timestamptz; ver text; t text; c text;
  drops constant jsonb := '{
    "properties":      ["location","rooms","price_per_night","description","maps_link","wifi_name","wifi_password",
                        "upi_id","upi_payee","upi_qr","bank_details","signature","signature_ratio"],
    "bookings":        ["guest_name","phone","total_amount","paid","round_off","source","notes",
                        "id_proof_type","id_proof_number","msg_sent","receipt_no","receipt_on"],
    "staff":           ["role","phone","monthly_salary","active","joined_on","daily_wage","checkout_wage","utensil_rate"],
    "expenses":        ["property_id","loan_id","category","notes","auto_amount"],
    "loans":           ["property_id","notes","written_off_on"],
    "loan_repayments": ["date","mode","expense_id","note"]
  }';
begin
  -- ── 1. Refuse unless it is safe ──────────────────────────────────────────
  if to_regclass('public.backups') is null then
    raise exception 'Refusing to purge: there is no backups table. Run backups.sql and make an encrypted backup first.';
  end if;
  if to_regclass('public.sync_status') is null or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'sync_status' and column_name = 'app_version') then
    raise exception 'Refusing to purge: run minimal-cloud.sql first, then open StayLog v% and let it sync.', minimal_from;
  end if;
  for o in select distinct owner_id from public.bookings
           union select distinct owner_id from public.properties
           union select distinct owner_id from public.expenses loop
    select max(created_at) into last_backup from public.backups where owner_id = o;
    if last_backup is null or last_backup < now() - interval '24 hours' then
      raise exception 'Refusing to purge: no encrypted backup in the last 24 hours (latest: %). In StayLog: Cloud sync → Encrypted backup → Back up now, then run this again.',
        coalesce(to_char(last_backup at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'), 'none');
    end if;
    execute 'select app_version from public.sync_status where owner_id = $1' into ver using o;
    if coalesce(substring(ver from '^v(\d+)')::int, 0) < minimal_from then
      raise exception 'Refusing to purge: the last sync came from StayLog % — open v% or later and let it sync first.',
        coalesce(ver, '(an older version)'), minimal_from;
    end if;
  end loop;

  -- ── 2. Rows: what the cloud no longer mirrors, and every tombstone ───────
  delete from public.expenses where staff_id is null;
  delete from public.loan_repayments where deleted_at is not null;
  delete from public.expenses        where deleted_at is not null;
  delete from public.loans l where l.deleted_at is not null
    and not exists (select 1 from public.loan_repayments r where r.loan_id = l.id);
  delete from public.bookings        where deleted_at is not null;
  -- A staff row goes only when nothing points at it (her login, marks, loans).
  execute 'delete from public.staff s where s.deleted_at is not null
    and not exists (select 1 from public.loans l where l.staff_id = s.id)
    and not exists (select 1 from public.expenses e where e.staff_id = s.id)
    and not exists (select 1 from public.staff_access a where a.staff_id = s.id)'
    || case when to_regclass('public.attendance') is not null
            then ' and not exists (select 1 from public.attendance x where x.staff_id = s.id)' else '' end;
  delete from public.properties p where p.deleted_at is not null
    and not exists (select 1 from public.bookings b where b.property_id = p.id);

  if to_regclass('public.ical_events') is not null then
    update public.ical_events set description = null
     where imported_booking_id is not null and description is not null;
  end if;

  -- ── 3. Columns ───────────────────────────────────────────────────────────
  for t in select jsonb_object_keys(drops) loop
    for c in select jsonb_array_elements_text(drops -> t) loop
      execute format('alter table public.%I drop column if exists %I', t, c);
    end loop;
  end loop;

  -- ── 4. Privileges: nothing by default, then exactly what is used ─────────
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
  -- The phone's mirror: read ids for the tombstone count, upsert, tombstone.
  foreach t in array array['properties','staff','bookings','loans','loan_repayments','expenses'] loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
  grant select on public.owners to authenticated;          -- own row (RLS)
  grant select on public.staff_access to authenticated;    -- managed in SQL; RLS lets each read their own
  if to_regclass('public.attendance') is not null then
    grant select on public.attendance to authenticated;
    grant update (expense_id) on public.attendance to authenticated;      -- the drain's stamp
  end if;
  if to_regclass('public.utensil_marks') is not null then
    grant select on public.utensil_marks to authenticated;
    grant update (expense_id) on public.utensil_marks to authenticated;
  end if;
  if to_regclass('public.ical_feeds') is not null then
    grant select, insert, update, delete on public.ical_feeds to authenticated;
    grant select on public.ical_events to authenticated;
    grant update (imported_booking_id) on public.ical_events to authenticated;
  end if;
  if to_regclass('public.push_subscriptions') is not null then
    grant select, insert, update, delete on public.push_subscriptions to authenticated;
    grant select, insert, update on public.notification_prefs to authenticated;
    grant select, insert, update on public.sync_status to authenticated;
    grant select on public.push_log to authenticated;
  end if;
  grant select, insert, update, delete on public.backups to authenticated;

  raise notice 'Purged. The cloud now holds only what Laxmi''s page, the drains and the reminders need.';
end $purge$;


-- ── Check (read-only) ────────────────────────────────────────────────────────
-- 1. Any old private column still here? Expect no rows.
select table_name, column_name as still_here
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('properties','location'),('properties','wifi_password'),('properties','upi_id'),('properties','bank_details'),
    ('properties','signature'),('properties','upi_qr'),
    ('bookings','guest_name'),('bookings','phone'),('bookings','total_amount'),('bookings','paid'),
    ('bookings','round_off'),('bookings','source'),('bookings','notes'),('bookings','id_proof_type'),
    ('bookings','id_proof_number'),('bookings','receipt_no'),('bookings','msg_sent'),
    ('staff','phone'),('staff','daily_wage'),('staff','checkout_wage'),('staff','utensil_rate'),
    ('expenses','category'),('expenses','notes'),('loans','notes'),('loan_repayments','note'))
order by 1, 2;

-- 2. What each mirrored table keeps, and how many rows.
select c.table_name, string_agg(c.column_name, ', ' order by c.ordinal_position) as columns
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name in ('properties','staff','bookings','loans','loan_repayments','expenses')
group by c.table_name order by 1;

select 'properties' as table_name, count(*) as rows, count(*) filter (where deleted_at is not null) as tombstoned from public.properties
union all select 'bookings', count(*), count(*) filter (where deleted_at is not null) from public.bookings
union all select 'staff', count(*), count(*) filter (where deleted_at is not null) from public.staff
union all select 'expenses', count(*), count(*) filter (where deleted_at is not null) from public.expenses
union all select 'loans', count(*), count(*) filter (where deleted_at is not null) from public.loans
union all select 'loan_repayments', count(*), count(*) filter (where deleted_at is not null) from public.loan_repayments
union all select 'expenses not staff payouts', count(*), 0 from public.expenses where staff_id is null;
