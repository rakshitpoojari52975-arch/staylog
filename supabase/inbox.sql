-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — the notification inbox.
--
-- push_log becomes the record of every reminder as well as the claim that
-- stops one going twice. The notify function writes everything; the owner may
-- read their own rows and set read_at, nothing else.
--
--   title, body, url, alert   what the push said, and which toggle it belongs to
--   delivered                 false when no device took it (kept, retried)
--   read_at                   set by the app: tapped, or Mark all read
--   claimed_at                set while a run is sending it (the claim)
--
-- Run in the Supabase SQL editor after push.sql. Safe to run twice.
-- Rows from before this script were delivered and have no title: the inbox
-- shows only rows with a title.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.push_log add column if not exists title      text;
alter table public.push_log add column if not exists body       text;
alter table public.push_log add column if not exists url        text;
alter table public.push_log add column if not exists alert      text;
alter table public.push_log add column if not exists delivered  boolean not null default true;
alter table public.push_log add column if not exists read_at    timestamptz;
alter table public.push_log add column if not exists claimed_at timestamptz;

create index if not exists push_log_owner_sent on public.push_log (owner_id, sent_at desc);

alter table public.push_log enable row level security;
revoke all on public.push_log from anon, authenticated;

drop policy if exists "owner reads" on public.push_log;
create policy "owner reads" on public.push_log for select using (owner_id = auth.uid());
drop policy if exists "owner marks read" on public.push_log;
create policy "owner marks read" on public.push_log for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select on public.push_log to authenticated;
grant update (read_at) on public.push_log to authenticated;   -- read_at only: the column grant is the rule
