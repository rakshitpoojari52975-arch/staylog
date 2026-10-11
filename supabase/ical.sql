-- StayLog · Booking.com / Airbnb calendar import
-- ─────────────────────────────────────────────────────────────────────────────
-- Run in the Supabase SQL editor. Safe to run twice.
--
-- The feeds cannot be read from the browser (no CORS headers), so the Edge
-- Function `ical-sync` reads them and writes what it finds into ical_events.
-- The phone then turns new stays into ordinary bookings, one way — exactly
-- as attendance marks become wage expenses. ical_events is NOT synced like
-- the other tables: if it were, the phone's tombstone pass would delete it.
--
-- ical_feeds  — one row per (property, platform): the export link. A calendar
--               link reads your calendar without a password, so only you can
--               see these rows.
-- ical_events — one row per event in a feed, kept up to date by the function.
--               gone_at is set when an event leaves its feed (likely cancelled)
--               and cleared if it comes back. imported_booking_id is the only
--               thing the phone writes: the booking it made or matched.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

create table if not exists public.ical_feeds (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references auth.users on delete cascade,
  property_id     text not null,
  platform        text not null check (platform in ('Airbnb','Booking.com')),
  url             text not null check (url ~* '^https://'),
  created_at      timestamptz not null default now(),
  last_fetched_at timestamptz,     -- last attempt
  last_ok_at      timestamptz,     -- last attempt that worked
  last_error      text,            -- why the last attempt failed, or null
  last_count      integer,         -- events in the feed at the last good read
  unique (owner_id, property_id, platform)
);

create table if not exists public.ical_events (
  feed_id             uuid not null references public.ical_feeds on delete cascade,
  uid                 text not null,
  owner_id            uuid not null references auth.users on delete cascade,
  property_id         text not null,
  platform            text not null,
  start_date          date not null,
  end_date            date not null,
  summary             text,
  description         text,
  kind                text not null check (kind in ('reserved','blocked')),
  first_seen_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  gone_at             timestamptz,
  imported_booking_id text,
  primary key (feed_id, uid)
);
create index if not exists ical_events_owner_idx on public.ical_events (owner_id, end_date);

alter table public.ical_feeds  enable row level security;
alter table public.ical_events enable row level security;

drop policy if exists "owner full access" on public.ical_feeds;
create policy "owner full access" on public.ical_feeds
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Events are written by the function (service role, which bypasses RLS).
-- The owner reads them, and may set imported_booking_id and nothing else.
drop policy if exists "owner reads" on public.ical_events;
create policy "owner reads" on public.ical_events
  for select using (owner_id = auth.uid());
drop policy if exists "owner stamps" on public.ical_events;
create policy "owner stamps" on public.ical_events
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Supabase grants anon and authenticated ALL on new public tables (TRUNCATE
-- included, which ignores RLS). Take it all back, then give exactly this.
revoke all on public.ical_events from anon, authenticated;
revoke all on public.ical_feeds  from anon, authenticated;
grant select on public.ical_events to authenticated;
grant update (imported_booking_id) on public.ical_events to authenticated;
grant select, insert, update, delete on public.ical_feeds to authenticated;

-- ── Scheduling (do this after deploying the function) ───────────────────────
-- Dashboard → Integrations → Cron → create a job:
--   schedule  : */30 * * * *
--   type      : Supabase Edge Function → ical-sync, method POST
--   header    : x-cron-secret: <the value of the ICAL_CRON_SECRET secret>
--
-- Or, the same thing in SQL (replace both <…>; this is not committed with
-- real values, because the secret must stay out of the public repo):
--
--   select cron.schedule('ical-sync', '*/30 * * * *', $job$
--     select net.http_post(
--       url     := 'https://<project-ref>.supabase.co/functions/v1/ical-sync',
--       headers := jsonb_build_object('Content-Type','application/json',
--                                     'x-cron-secret','<ICAL_CRON_SECRET>'),
--       body    := '{}'::jsonb);
--   $job$);
--
-- Run cron.schedule again with the same name to change it;
-- select cron.unschedule('ical-sync') to stop it.
