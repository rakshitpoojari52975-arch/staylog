-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · encrypted backups
--
-- The phone encrypts the whole app data (less guest ID photos) with a key made
-- from a passphrase that never leaves it, and uploads the result here. This
-- table can hold ciphertext and the few things needed to decrypt it with that
-- passphrase — the salt, the IV and the iteration count — plus the app version,
-- the size and when it was made. Nothing readable: no names, no counts.
--
-- Owner-only. The notify function (service role) reads created_at for the
-- "no backup in 3 days" reminder. Run in the Supabase SQL editor after
-- setup.sql. Safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.backups (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users on delete cascade,
  created_at  timestamptz not null default now(),
  ciphertext  text not null,               -- base64 AES-256-GCM output (tag included)
  salt        text not null,               -- base64, PBKDF2 salt
  iv          text not null,               -- base64, 12 bytes, fresh for every backup
  iterations  integer not null check (iterations >= 100000),
  app_version text,
  size        integer not null check (size > 0)
);
create index if not exists backups_owner_created_idx on public.backups (owner_id, created_at desc);

alter table public.backups enable row level security;
-- Supabase grants ALL on new tables (TRUNCATE included, which ignores RLS).
revoke all on public.backups from anon, authenticated;

drop policy if exists "owner full access" on public.backups;
create policy "owner full access" on public.backups
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
-- insert: a new backup; select: restore and test restore; update: a changed
-- passphrase re-encrypts in place; delete: keeping the latest plus one a day.
grant select, insert, update, delete on public.backups to authenticated;
