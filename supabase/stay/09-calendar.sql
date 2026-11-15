-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — phase 7: the calendar import runs on the server.
-- After 08-team.sql. Safe to run twice. Changes no booking.
--
-- Until now the ical-sync Edge Function only stored what the Booking.com and
-- Airbnb links show (stay.ical_events), and a phone turned new stays into
-- bookings the next time it synced. From v68 the function does that itself,
-- with the same rules, so a stay is on every phone (owner's and managers')
-- whether or not the owner's phone is open. This adds:
--   stay.ical_runs        one row per account: when the import last ran, when
--                         Import now was last asked for (once in 5 minutes per
--                         account), and what it did per feed — for the
--                         Calendar sync panel. Owner reads; only the function
--                         writes. Its row is also how a phone knows the server
--                         imports now and stops importing on its own.
--   announced_at          (already a column) is now kept: a new stay's "New
--                         booking" push is recorded per event, so a run cut
--                         short is picked up by the next one. The first time
--                         this script runs, every event already stored counts
--                         as announced (the old way had dealt with them).
--   min_version 68        in the new model, a copy of the app older than v68
--                         stops syncing and asks to be reopened, so no phone
--                         imports beside the server.
-- ─────────────────────────────────────────────────────────────────────────────

do $first$
begin
  if to_regclass('stay.ical_runs') is null then
    create table stay.ical_runs (
      account_id     uuid primary key references stay.accounts on delete cascade,
      last_run_at    timestamptz,
      last_manual_at timestamptz,
      result         jsonb not null default '{}'::jsonb,
      updated_at     timestamptz not null default now()
    );
    -- Only on the first run of this script: what is already stored was seen
    -- (and announced, or not) by the old import. A second run leaves
    -- announced_at alone, so nothing waiting to be announced is lost.
    update stay.ical_events set announced_at = coalesce(announced_at, now()) where announced_at is null;
  end if;
end $first$;

alter table stay.ical_runs enable row level security;
drop policy if exists "owner reads" on stay.ical_runs;
create policy "owner reads" on stay.ical_runs for select using (stay.is_owner(account_id));
revoke all on stay.ical_runs from anon, authenticated;
grant select on stay.ical_runs to authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on stay.ical_runs to service_role;
  end if;
end $g$;

-- The function looks for events not yet announced on every run.
create index if not exists ical_events_unannounced on stay.ical_events (account_id) where announced_at is null;

-- Only v68 and later may sync in the new model (they leave the import to the
-- server). Never lowers it; does nothing before the switch-over.
do $v$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'app_status' and column_name = 'model') then
    update public.app_status set min_version = greatest(min_version, 68) where id = 1 and model = 'stay';
  end if;
end $v$;
