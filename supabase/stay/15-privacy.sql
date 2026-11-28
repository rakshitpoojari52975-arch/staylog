-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — stage 4 of billing and data protection (v77): less kept, every
-- sensitive step written down, and support access only when an owner says so.
-- After 14-paid-on.sql. Safe to run twice. **Changes no stored data by
-- itself**: existing full Aadhaar numbers are only counted here; they are
-- shortened by stay.mask_aadhaar(...) when Rakshit runs it (see the end).
--
--   Aadhaar           stay.bookings keeps only the last 4 digits, shown as
--                     "XXXX XXXX 1234". A trigger shortens any new or changed
--                     number as it is written — from the app, an old app, the
--                     API or the server's own key. Any 12-digit number is
--                     treated as an Aadhaar number whatever type it is under.
--   stay.audit_log    every sensitive step: team and staff-login changes,
--                     account settings, support access and each support read,
--                     exports and restores (reported by the app), sign-ins
--                     (copied daily from Supabase's own log), the Aadhaar
--                     run. Ids, names of fields and counts only — never guest
--                     details. Append-only; rows go after 1 year.
--   stay.support_grants  an owner lets the platform admin read their account
--                     for up to 7 days, and can stop it at any time. The
--                     admin reads only through stay.support_read(), which
--                     checks the grant and writes each read to the log.
--   min_version 77    older apps stop syncing (v77's sync.js checks it).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Aadhaar: the last 4 digits only ──────────────────────────────────────────
-- The number as kept: "XXXX XXXX 1234". Already shortened, or fewer than 5
-- digits: returned as it is (nothing to shorten).
create or replace function stay.aadhaar_short(p text) returns text language sql immutable as $$
  select case
    when p is null then null
    when p ~ '^X{4} X{4} [0-9]{4}$' then p
    when length(regexp_replace(p, '[^0-9]', '', 'g')) >= 5
      then 'XXXX XXXX ' || right(regexp_replace(p, '[^0-9]', '', 'g'), 4)
    else p end
$$;
-- Is this a number that must be shortened? An Aadhaar-type ID with more than
-- 4 digits, or any 12 digits written as an ID (spaces or dashes allowed).
create or replace function stay.is_full_aadhaar(p_type text, p_number text) returns boolean language sql immutable as $$
  select p_number is not null and p_number !~ '^X{4} X{4} [0-9]{4}$' and (
    (p_type = 'Aadhaar' and length(regexp_replace(p_number, '[^0-9]', '', 'g')) >= 5)
    or regexp_replace(p_number, '[\s-]', '', 'g') ~ '^[0-9]{12}$')
$$;

-- New or changed numbers are shortened as they are written. A row whose number
-- is untouched keeps it until the counted run below (so editing anything else
-- on an old booking does not quietly change it).
create or replace function stay.mask_ids() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.id_proof_number is not distinct from old.id_proof_number
     and new.id_proof_type is not distinct from old.id_proof_type then
    return new;
  end if;
  if stay.is_full_aadhaar(new.id_proof_type, new.id_proof_number) then
    new.id_proof_number := stay.aadhaar_short(new.id_proof_number);
  end if;
  return new;
end $$;
drop trigger if exists b_mask_ids on stay.bookings;
create trigger b_mask_ids before insert or update on stay.bookings for each row execute function stay.mask_ids();

-- ── The audit log ────────────────────────────────────────────────────────────
create table if not exists stay.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  account_id uuid,                          -- null: not about one account (a sign-in)
  actor      uuid,                          -- the login that did it (null: the system)
  actor_kind text not null default 'member' check (actor_kind in ('member','platform_admin','staff','system','auth')),
  action     text not null,
  target     text,
  detail     jsonb not null default '{}'::jsonb,
  source_id  text                           -- a copied sign-in's id in Supabase's log (copied once)
);
create index if not exists audit_log_account on stay.audit_log (account_id, at desc);
create index if not exists audit_log_actor on stay.audit_log (actor, at desc);
create unique index if not exists audit_log_source on stay.audit_log (source_id) where source_id is not null;

-- Append-only, even for the database owner; only the yearly clean-up below
-- removes rows, and only rows older than a year.
create or replace function stay.audit_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('stay.audit_purge', true) = 'on' and old.at < now() - interval '1 year' then
    return old;
  end if;
  raise exception 'The audit log is append-only';
end $$;
drop trigger if exists append_only on stay.audit_log;
create trigger append_only before update or delete on stay.audit_log for each row execute function stay.audit_append_only();

alter table stay.audit_log enable row level security;
drop policy if exists "owner reads" on stay.audit_log;
create policy "owner reads" on stay.audit_log for select
  using (stay.is_owner(account_id) or actor = auth.uid() or stay.is_platform_admin());
revoke all on stay.audit_log from anon, authenticated;
grant select on stay.audit_log to authenticated;

-- Who is acting: a platform admin, a staff login, a member, or the system.
create or replace function stay.actor_kind() returns text
language sql security definer set search_path = stay, pg_temp stable as $$
  select case when auth.uid() is null then 'system'
              when exists (select 1 from stay.platform_admins where user_id = auth.uid()) then 'platform_admin'
              when exists (select 1 from stay.staff_logins where user_id = auth.uid()) then 'staff'
              else 'member' end
$$;
create or replace function stay.audit(p_account uuid, p_action text, p_target text, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = stay, pg_temp as $$
  insert into stay.audit_log (account_id, actor, actor_kind, action, target, detail)
  values (p_account, auth.uid(), stay.actor_kind(), p_action, p_target, coalesce(p_detail, '{}'::jsonb))
$$;

-- Changes to the team, staff logins and the account's settings. Which fields
-- changed, never their values — except role / active / permissions, which are
-- what the log is for.
create or replace function stay.audit_change() returns trigger
language plpgsql security definer set search_path = stay, pg_temp as $$
declare o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
        n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
        r jsonb := coalesce(n, o); changed text[]; d jsonb := '{}'::jsonb; k text;
        skip text[] := array['updated_at','version','updated_by','created_at','legacy'];
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(key order by key), '{}') into changed from jsonb_each(n)
     where not key = any(skip) and (o -> key) is distinct from value;
    if cardinality(changed) = 0 then return null; end if;
    d := jsonb_build_object('changed', to_jsonb(changed));
  end if;
  foreach k in array array['role','active','permissions','property_id','username','used_by','expires_at','label'] loop
    if r ? k and (tg_op <> 'UPDATE' or k = any(changed)) then d := d || jsonb_build_object(k, r -> k); end if;
  end loop;
  insert into stay.audit_log (account_id, actor, actor_kind, action, target, detail)
  values (case when tg_table_name = 'accounts' then (r ->> 'id')::uuid else (r ->> 'account_id')::uuid end,
          auth.uid(), stay.actor_kind(), tg_table_name || '.' || lower(tg_op),
          -- an invite's code is the secret in its link: only a short hash of it is kept
          case when tg_table_name = 'invites' then 'invite:' || left(md5(r ->> 'code'), 10)
               else coalesce(r ->> 'user_id', r ->> 'staff_id', r ->> 'code', r ->> 'id') end, d);
  return null;
end $$;
do $t$
declare t text;
begin
  foreach t in array array['members','member_properties','invites','staff_logins'] loop
    execute format('drop trigger if exists z_audit on stay.%I', t);
    execute format('create trigger z_audit after insert or update or delete on stay.%I for each row execute function stay.audit_change()', t);
  end loop;
  -- the account's own settings (not the billing columns: billing_events keeps those)
  drop trigger if exists z_audit on stay.accounts;
  create trigger z_audit after update of name, time_zone, currency, pays_directly_sources, owner_name, gstin
    on stay.accounts for each row execute function stay.audit_change();
end $t$;

-- What the app reports itself (it holds the data for these): an export, a
-- restore, a changed backup passphrase. Members of the account only; the
-- detail is counts, nothing else.
create or replace function stay.log_event(p_account uuid, p_action text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare d jsonb := '{}'::jsonb; k text;
begin
  if not stay.is_member(p_account) then raise exception 'Not a member of this account' using errcode = '42501'; end if;
  if p_action not in ('export_everything','backup_restored','backup_passphrase_changed','backup_file_saved') then
    raise exception 'Unknown event';
  end if;
  -- numbers only: a count per table, a size
  for k in select key from jsonb_each(coalesce(p_detail, '{}'::jsonb)) where jsonb_typeof(value) = 'number' loop
    d := d || jsonb_build_object(k, p_detail -> k);
  end loop;
  perform stay.audit(p_account, p_action, null, d);
end $$;

-- ── Support access ───────────────────────────────────────────────────────────
create table if not exists stay.support_grants (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references stay.accounts on delete cascade,
  granted_by  uuid not null,
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  note        text check (note is null or length(note) <= 300)
);
create index if not exists support_grants_live on stay.support_grants (account_id, expires_at desc);
alter table stay.support_grants enable row level security;
drop policy if exists "owner or admin reads" on stay.support_grants;
create policy "owner or admin reads" on stay.support_grants for select using (stay.is_owner(account_id) or stay.is_platform_admin());
revoke all on stay.support_grants from anon, authenticated;
grant select on stay.support_grants to authenticated;           -- written only by the functions below

create or replace function stay.live_support_grant(p_account uuid) returns stay.support_grants
language sql security definer set search_path = stay, pg_temp stable as $$
  select * from stay.support_grants where account_id = p_account and revoked_at is null and expires_at > now()
  order by expires_at desc limit 1
$$;

-- The owner lets support in for 1 to 7 days (one grant at a time).
create or replace function stay.grant_support(p_account uuid, p_days integer default 7, p_note text default null) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare g stay.support_grants;
begin
  if not stay.is_owner(p_account) then raise exception 'Only the owner can allow support access' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 7 then raise exception 'Between 1 and 7 days'; end if;
  update stay.support_grants set revoked_at = now() where account_id = p_account and revoked_at is null and expires_at > now();
  insert into stay.support_grants (account_id, granted_by, expires_at, note)
  values (p_account, auth.uid(), now() + make_interval(days => p_days), nullif(trim(p_note), ''))
  returning * into g;
  perform stay.audit(p_account, 'support_granted', g.id::text, jsonb_build_object('days', p_days, 'until', g.expires_at));
  return stay.support_state(p_account);
end $$;

create or replace function stay.revoke_support(p_account uuid) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare n integer;
begin
  if not stay.is_owner(p_account) then raise exception 'Only the owner can stop support access' using errcode = '42501'; end if;
  update stay.support_grants set revoked_at = now() where account_id = p_account and revoked_at is null and expires_at > now();
  get diagnostics n = row_count;
  if n > 0 then perform stay.audit(p_account, 'support_revoked', null, '{}'::jsonb); end if;
  return stay.support_state(p_account);
end $$;

-- For the owner: the grant in force, and support's reads under it.
create or replace function stay.support_state(p_account uuid) returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  select case when not stay.is_owner(p_account) then null else jsonb_build_object(
    'live', (select jsonb_build_object('granted_at', g.granted_at, 'expires_at', g.expires_at, 'note', g.note)
             from stay.support_grants g where g.account_id = p_account and g.revoked_at is null and g.expires_at > now()
             order by g.expires_at desc limit 1),
    'reads', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'table', l.target, 'rows', l.detail -> 'rows') order by l.at desc)
             from (select * from stay.audit_log l where l.account_id = p_account and l.action = 'support_read'
                   order by l.at desc limit 50) l), '[]'::jsonb))
  end
$$;

-- For the platform admin: which accounts have let support in.
create or replace function stay.support_accounts() returns jsonb
language plpgsql security definer set search_path = stay, pg_temp stable as $$
begin
  if not stay.is_platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('account', a.id, 'name', a.name, 'expires_at', g.expires_at, 'note', g.note)
                                    order by g.expires_at)
    from stay.support_grants g join stay.accounts a on a.id = g.account_id
    where g.revoked_at is null and g.expires_at > now()), '[]'::jsonb);
end $$;

-- The only way the platform admin reads an account's records: a live grant,
-- an allowed table, at most 200 rows, and every read in the log (the owner
-- sees it). Secrets are left out: Wi-Fi password, bank and UPI details, the
-- signature and the QR; calendar links are not readable at all.
create or replace function stay.support_read(p_account uuid, p_table text, p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare rows jsonb; n integer;
        hide text[] := array['wifi_password','bank_details','upi_id','upi_payee','upi_qr','signature'];
begin
  if not stay.is_platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
  if (stay.live_support_grant(p_account)).id is null then
    raise exception 'This account has not allowed support access (or it has ended)' using errcode = '42501';
  end if;
  if p_table not in ('properties','bookings','expenses','staff','loans','loan_repayments','attendance','utensil_marks') then
    raise exception 'Not readable under support access';
  end if;
  execute format('select coalesce(jsonb_agg(x), ''[]''::jsonb) from (select to_jsonb(t) - $2 as x from stay.%I t
                  where t.account_id = $1 order by t.updated_at desc limit $3) s', p_table)
    into rows using p_account, hide, greatest(1, least(coalesce(p_limit, 50), 200));
  n := jsonb_array_length(rows);
  perform stay.audit(p_account, 'support_read', p_table, jsonb_build_object('rows', n));
  return rows;
end $$;

-- ── Daily housekeeping (the billing function's daily job calls it) ───────────
-- Sign-ins copied from Supabase's own auth log (once each); audit rows older
-- than a year removed.
create or replace function stay.audit_housekeeping() returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare n_in integer := 0; n_out integer := 0;
begin
  if to_regclass('auth.audit_log_entries') is not null then
    execute $q$
      insert into stay.audit_log (at, account_id, actor, actor_kind, action, target, detail, source_id)
      select e.created_at, null, nullif(e.payload ->> 'actor_id', '')::uuid, 'auth', 'auth.' || coalesce(e.payload ->> 'action', '?'),
             null, '{}'::jsonb, e.id::text
      from auth.audit_log_entries e
      where e.payload ->> 'action' in ('login','logout','user_signedup','user_recovery_requested','user_deleted','user_modified','token_revoked')
        and e.created_at > now() - interval '2 days'
        and (e.payload ->> 'actor_id') ~ '^[0-9a-f-]{36}$'
      on conflict (source_id) where source_id is not null do nothing$q$;
    get diagnostics n_in = row_count;
  end if;
  perform set_config('stay.audit_purge', 'on', true);
  delete from stay.audit_log where at < now() - interval '1 year';
  get diagnostics n_out = row_count;
  perform set_config('stay.audit_purge', 'off', true);
  return jsonb_build_object('signins_copied', n_in, 'removed', n_out);
end $$;

-- ── The Aadhaar numbers already stored: count first, then shorten ────────────
-- 1) select stay.aadhaar_count();      -- changes nothing
-- 2) take a fresh encrypted backup on the phone
-- 3) select stay.mask_aadhaar('I have a fresh backup');
-- Run from the SQL editor (database owner). Notes are counted, never changed:
-- a number typed into a booking's notes is for the owner to remove by hand.
create or replace function stay.aadhaar_count() returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  select jsonb_build_object(
    'full_numbers', (select count(*) from stay.bookings b where stay.is_full_aadhaar(b.id_proof_type, b.id_proof_number)),
    'notes_with_a_12_digit_number', (select count(*) from stay.bookings b
       where b.notes ~ '(^|[^0-9])[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}([^0-9]|$)'),
    'by_account', coalesce((select jsonb_object_agg(a.name, x.n) from (
       select b.account_id, count(*) as n from stay.bookings b
       where stay.is_full_aadhaar(b.id_proof_type, b.id_proof_number) group by b.account_id) x
       join stay.accounts a on a.id = x.account_id), '{}'::jsonb))
$$;

create or replace function stay.mask_aadhaar(p_confirm text) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare n integer;
begin
  if p_confirm is distinct from 'I have a fresh backup' then
    raise exception 'Count first (select stay.aadhaar_count()), take a fresh encrypted backup, then run stay.mask_aadhaar(''I have a fresh backup'').';
  end if;
  perform set_config('stay.guard', 'off', true);     -- a read-only account's guests are shortened too
  update stay.bookings set id_proof_number = stay.aadhaar_short(id_proof_number)
   where stay.is_full_aadhaar(id_proof_type, id_proof_number);
  get diagnostics n = row_count;
  perform set_config('stay.guard', 'on', true);
  insert into stay.audit_log (account_id, actor, actor_kind, action, target, detail)
  values (null, auth.uid(), 'system', 'aadhaar_masked', null, jsonb_build_object('bookings', n));
  return jsonb_build_object('shortened', n, 'left', (select count(*) from stay.bookings b where stay.is_full_aadhaar(b.id_proof_type, b.id_proof_number)));
end $$;

-- ── Grants ───────────────────────────────────────────────────────────────────
do $g$
declare f text;
begin
  foreach f in array array['stay.log_event(uuid,text,jsonb)','stay.grant_support(uuid,integer,text)','stay.revoke_support(uuid)',
                           'stay.support_state(uuid)','stay.support_accounts()','stay.support_read(uuid,text,integer)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['stay.audit(uuid,text,text,jsonb)','stay.audit_housekeeping()','stay.aadhaar_count()',
                           'stay.mask_aadhaar(text)','stay.live_support_grant(uuid)','stay.actor_kind()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- the triggers' own helpers are called by whoever writes
  grant execute on function stay.aadhaar_short(text), stay.is_full_aadhaar(text,text) to authenticated;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function stay.audit_housekeeping(), stay.aadhaar_short(text), stay.is_full_aadhaar(text,text) to service_role;
    grant select, insert on stay.audit_log to service_role;
  end if;
end $g$;

-- Only v77 and later sync in the new model.
do $v$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'app_status' and column_name = 'model') then
    update public.app_status set min_version = greatest(min_version, 77) where id = 1 and model = 'stay';
  end if;
end $v$;
