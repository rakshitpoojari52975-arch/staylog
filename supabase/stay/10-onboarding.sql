-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — phase 9: onboarding new accounts.
-- After 09-calendar.sql. Safe to run twice. Changes no data.
--
-- Public sign-up stays off. A new owner joins only through a platform invite
-- that a platform admin (Rakshit) makes in the app (⋯ → Invite a new owner):
-- a link with a long random code. The new owner opens it, makes their login
-- (through the team-invite Edge Function) and names their business; the
-- account and their owner membership are made in one transaction here.
--   stay.platform_invites      the invites (who for, made by, expiry, used)
--   stay.am_platform_admin()   may this login make platform invites?
--   stay.open_account(...)     claims the invite and opens the account, at
--                              once or not at all; only the function's
--                              service key may call it
--   accounts settings checked  time zone must be a real one, currency three
--                              capital letters, at least one source that
--                              pays directly; the code never changes (staff
--                              sign in with it)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists stay.platform_invites (
  code        text primary key check (length(code) between 16 and 64),
  label       text,                                -- who it is for ("Asha, Goa")
  created_by  uuid not null references auth.users on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  used_by     uuid,
  used_at     timestamptz,
  account_id  uuid references stay.accounts on delete set null
);
alter table stay.platform_invites enable row level security;
drop policy if exists "admins read" on stay.platform_invites;
drop policy if exists "admins invite" on stay.platform_invites;
drop policy if exists "admins withdraw" on stay.platform_invites;
create policy "admins read" on stay.platform_invites for select using (stay.is_platform_admin());
create policy "admins invite" on stay.platform_invites for insert
  with check (stay.is_platform_admin() and created_by = auth.uid() and used_by is null and account_id is null);
create policy "admins withdraw" on stay.platform_invites for update using (stay.is_platform_admin()) with check (stay.is_platform_admin());
revoke all on stay.platform_invites from anon, authenticated;
grant select, insert (code, label, created_by, expires_at) on stay.platform_invites to authenticated;
grant update (expires_at) on stay.platform_invites to authenticated;

create or replace function stay.am_platform_admin() returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$ select stay.is_platform_admin() $$;
revoke all on function stay.am_platform_admin() from public;
grant execute on function stay.am_platform_admin() to authenticated;

-- Account settings, checked on every write (the owner edits them in the app).
create or replace function stay.check_account() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.time_zone) then
    raise exception 'Unknown time zone: %', new.time_zone using errcode = '22023';
  end if;
  if new.currency !~ '^[A-Z]{3}$' then
    raise exception 'A currency is three capital letters, like INR' using errcode = '22023';
  end if;
  if coalesce(array_length(new.pays_directly_sources, 1), 0) = 0 then
    raise exception 'At least one source must pay you directly (Direct, usually)' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.code is distinct from old.code then
    raise exception 'The account code cannot change: staff sign in with it' using errcode = '22023';
  end if;
  new.name := btrim(new.name);
  if new.name = '' then raise exception 'The business needs a name' using errcode = '22023'; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists check_account on stay.accounts;
create trigger check_account before insert or update on stay.accounts for each row execute function stay.check_account();

-- Opens an account from a platform invite: the invite is claimed (locked,
-- still unused, not expired), the account made, the user its owner. Any
-- refusal changes nothing. Called by the team-invite Edge Function with the
-- service key, after it has made (or checked) the login.
create or replace function stay.open_account(p_invite text, p_user uuid, p_business text, p_code text,
  p_time_zone text default 'Asia/Kolkata', p_currency text default 'INR', p_owner_name text default null)
returns uuid language plpgsql security definer set search_path = stay, pg_temp as $$
declare v_inv stay.platform_invites; v_id uuid; v_code text := lower(btrim(coalesce(p_code, '')));
begin
  select * into v_inv from stay.platform_invites where code = p_invite for update;
  if not found or v_inv.used_by is not null or v_inv.expires_at <= now() then
    raise exception 'invite: used, withdrawn or expired' using errcode = 'P0002';
  end if;
  if v_code !~ '^[a-z0-9]{2,12}$' then
    raise exception 'code: 2 to 12 small letters or digits' using errcode = '22023';
  end if;
  if exists (select 1 from stay.accounts where code = v_code) then
    raise exception 'code: taken' using errcode = '23505';
  end if;
  insert into stay.accounts (name, code, time_zone, currency, owner_name)
  values (coalesce(nullif(btrim(p_business), ''), 'My homestay'), v_code, coalesce(nullif(p_time_zone, ''), 'Asia/Kolkata'),
          upper(coalesce(nullif(p_currency, ''), 'INR')), nullif(btrim(coalesce(p_owner_name, '')), ''))
  returning id into v_id;
  insert into stay.members (account_id, user_id, role, display_name)
  values (v_id, p_user, 'owner', nullif(btrim(coalesce(p_owner_name, '')), ''));
  update stay.platform_invites set used_by = p_user, used_at = now(), account_id = v_id where code = p_invite;
  return v_id;
end $$;
revoke all on function stay.open_account(text, uuid, text, text, text, text, text) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on stay.platform_invites to service_role;
    grant execute on function stay.open_account(text, uuid, text, text, text, text, text) to service_role;
  end if;
end $g$;
