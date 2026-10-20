-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · iPhone push notifications
--
-- The Edge Function `notify` (supabase/functions/notify) sends reminders to
-- the owner's devices: when Laxmi marks attendance or reports utensil
-- cleaning, and once a day at 9 AM IST. Notifications are reminders only —
-- nothing in the app depends on one arriving.
--
--   push_subscriptions  one row per device (the browser's push endpoint and
--                       its keys). Re-written on every app open: iOS can drop
--                       a subscription without saying so.
--   notification_prefs  the owner's on/off per alert type. No row = all on.
--   sync_status         when the owner's phone last synced, for the "has not
--                       synced in 2 days" warning.
--   push_log            what has been sent, by key, so a cron that fires twice
--                       or a mark tapped twice never notifies twice.
--
-- All owner-only. The function uses the service role, which bypasses RLS.
-- Run in the Supabase SQL editor after setup.sql. Safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.push_subscriptions (
  endpoint     text primary key,
  owner_id     uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh       text not null,
  auth         text not null,
  device       text,                      -- a label for the panel, e.g. "iPhone"
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_subscriptions_owner_idx on public.push_subscriptions (owner_id);

create table if not exists public.notification_prefs (
  owner_id   uuid primary key default auth.uid() references auth.users on delete cascade,
  prefs      jsonb not null default '{}'::jsonb,   -- {"attendance":false,...}; missing = on
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_status (
  owner_id     uuid primary key default auth.uid() references auth.users on delete cascade,
  last_sync_at timestamptz not null default now()
);

create table if not exists public.push_log (
  owner_id uuid not null references auth.users on delete cascade,
  key      text not null,                 -- e.g. arrival:<booking>:<date>
  sent_at  timestamptz not null default now(),
  primary key (owner_id, key)
);

do $$
declare t text;
begin
  foreach t in array array['push_subscriptions','notification_prefs','sync_status','push_log'] loop
    execute format('alter table public.%I enable row level security', t);
    -- Supabase grants ALL on new tables (TRUNCATE included, which ignores RLS).
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- The owner manages his own devices, preferences and heartbeat. The log is
-- the function's; he may read it, not write it.
drop policy if exists "owner full access" on public.push_subscriptions;
create policy "owner full access" on public.push_subscriptions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select, insert, update, delete on public.push_subscriptions to authenticated;

drop policy if exists "owner full access" on public.notification_prefs;
create policy "owner full access" on public.notification_prefs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select, insert, update on public.notification_prefs to authenticated;

drop policy if exists "owner full access" on public.sync_status;
create policy "owner full access" on public.sync_status
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select, insert, update on public.sync_status to authenticated;

drop policy if exists "owner reads" on public.push_log;
create policy "owner reads" on public.push_log for select using (owner_id = auth.uid());
grant select on public.push_log to authenticated;

-- ── Scheduling and webhooks (after deploying the function) ──────────────────
-- Daily, 9:00 AM IST = 03:30 UTC. Dashboard → Integrations → Cron, or:
--
--   select cron.schedule('notify-daily', '30 3 * * *', $job$
--     select net.http_post(
--       url     := 'https://<project-ref>.supabase.co/functions/v1/notify',
--       headers := jsonb_build_object('Content-Type','application/json',
--                                     'x-cron-secret','<PUSH_CRON_SECRET>'),
--       body    := '{"job":"daily"}'::jsonb);
--   $job$);
--
-- Laxmi's marks. Dashboard → Database → Webhooks, one for each table
-- (attendance, utensil_marks), events Insert and Update, type Supabase Edge
-- Function → notify, POST, header x-cron-secret: <PUSH_CRON_SECRET>.
-- Or in SQL (replace both <…>; not committed with real values):
--
--   create or replace trigger notify_attendance
--     after insert or update on public.attendance for each row
--     execute function supabase_functions.http_request(
--       'https://<project-ref>.supabase.co/functions/v1/notify', 'POST',
--       '{"Content-Type":"application/json","x-cron-secret":"<PUSH_CRON_SECRET>"}', '{}', '5000');
--   create or replace trigger notify_utensils
--     after insert or update on public.utensil_marks for each row
--     execute function supabase_functions.http_request(
--       'https://<project-ref>.supabase.co/functions/v1/notify', 'POST',
--       '{"Content-Type":"application/json","x-cron-secret":"<PUSH_CRON_SECRET>"}', '{}', '5000');
