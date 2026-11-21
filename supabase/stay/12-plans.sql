-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — stage 2 of billing and data protection (v74): plans, the free
-- trial, and read-only accounts.
-- After 11-legal.sql. Safe to run twice. Changes no business data; the first
-- run gives every account a plan: Raaya Vasyam (the account moved in from the
-- old app) plan 'owner', any other a fresh 7-day trial.
--
-- POSTGRES DECIDES. The app only shows the state; a modified app, an old
-- cached copy or a direct API call meets the same rules here:
--   stay.account_can_write(acct)   true when any of:
--                                    plan 'owner' (never expires, never billed);
--                                    trialing and now() < trial_ends_at;
--                                    active and now() < current_period_end;
--                                    past_due and now() < grace_ends_at (3 days).
--   properties.paused              a property over the plan's limit (rule B):
--                                  read-only, chosen by the owner
--   stay.guard_write()             a trigger on every table of account data:
--                                  refuses insert, update and delete when the
--                                  account (or the row's property) can't be
--                                  written. Triggers run for every role, the
--                                  server's own key included (row-level
--                                  security does not), so the Edge Functions
--                                  are held to it too. Reading is untouched.
--   "plan allows writing"          a RESTRICTIVE policy on the same tables,
--                                  ANDed with the existing ones
-- What a read-only account may still do: sign in, read, export; switch a
-- manager off and remove their properties; withdraw an invite; keep its
-- devices, choices, backups and inbox (those tables are not guarded).
-- Only our own server functions can step past the guard, for jobs that must
-- run on a read-only account (choosing active properties, billing, and from
-- stage 5 retention and erasure): they set stay.guard = 'off' for their own
-- transaction. The API cannot set it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The plan on the account ───────────────────────────────────────────────────
alter table stay.accounts add column if not exists plan                     text;
alter table stay.accounts add column if not exists status                   text;
alter table stay.accounts add column if not exists trial_started_at         timestamptz;
alter table stay.accounts add column if not exists trial_ends_at            timestamptz;
alter table stay.accounts add column if not exists current_period_end       timestamptz;
alter table stay.accounts add column if not exists grace_ends_at            timestamptz;
alter table stay.accounts add column if not exists razorpay_customer_id     text;
alter table stay.accounts add column if not exists razorpay_subscription_id text;
alter table stay.accounts add column if not exists properties_allowed       integer;
alter table stay.accounts add column if not exists inactive_since           timestamptz;

-- The first run: every account gets its plan. The account moved in from the
-- old app is Rakshit's own: plan 'owner', unlimited properties.
-- (read through to_jsonb: 05-migrate.sql adds migrated_from, and a fresh
-- install may run this before it)
update stay.accounts a set plan = 'owner', status = 'active', properties_allowed = null
 where plan is null and to_jsonb(a) ->> 'migrated_from' is not null;
update stay.accounts set plan = 'trial', status = 'trialing', trial_started_at = now(),
       trial_ends_at = now() + interval '7 days', properties_allowed = 5
 where plan is null;

alter table stay.accounts alter column plan set default 'trial';
alter table stay.accounts alter column status set default 'trialing';
alter table stay.accounts alter column plan set not null;
alter table stay.accounts alter column status set not null;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_plan_check' and conrelid = 'stay.accounts'::regclass) then
    alter table stay.accounts add constraint accounts_plan_check check (plan in ('trial','starter','pro','owner'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounts_status_check' and conrelid = 'stay.accounts'::regclass) then
    alter table stay.accounts add constraint accounts_status_check
      check (status in ('trialing','active','past_due','expired','cancelled'));
  end if;
end $c$;
-- (The app's role may still only update name, time_zone, currency,
-- pays_directly_sources and owner_name — 03-access.sql's column grant. None
-- of the columns above can be set from the app.)

-- A new account starts a 7-day trial with up to 5 properties. The account
-- moved in from the old app (migrated_from set, whenever that happens) is
-- Rakshit's own: plan 'owner'.
create or replace function stay.account_defaults() returns trigger language plpgsql as $$
begin
  if to_jsonb(new) ->> 'migrated_from' is not null
     and (tg_op = 'INSERT' or to_jsonb(old) ->> 'migrated_from' is null) then
    new.plan := 'owner'; new.status := 'active'; new.properties_allowed := null;
    new.trial_started_at := null; new.trial_ends_at := null;
    return new;
  end if;
  if tg_op = 'UPDATE' then return new; end if;
  if new.plan = 'trial' then
    new.status := coalesce(new.status, 'trialing');
    new.trial_started_at := coalesce(new.trial_started_at, now());
    new.trial_ends_at := coalesce(new.trial_ends_at, new.trial_started_at + interval '7 days');
    new.properties_allowed := coalesce(new.properties_allowed, 5);
  end if;
  return new;
end $$;
drop trigger if exists account_defaults on stay.accounts;
create trigger account_defaults before insert or update on stay.accounts for each row execute function stay.account_defaults();

-- Properties over the plan's limit are read-only (rule B).
alter table stay.properties add column if not exists paused boolean not null default false;

-- ── A fix found while building this stage ────────────────────────────────────
-- stay.is_owner() answered null (not false) for someone who is not a member
-- of the account at all, so a check written "if not stay.is_owner(...) then
-- refuse" let them through: stay.team() (08-team.sql) would show another
-- account's members and their emails to any signed-in login. It now answers
-- false. (Row-level security was never affected: a null there already means
-- "no".) The same fix is in 02-functions.sql for a fresh install.
create or replace function stay.is_owner(p_account uuid) returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$ select coalesce(stay.role_in(p_account) = 'owner', false) $$;

-- ── The one rule ─────────────────────────────────────────────────────────────
create or replace function stay.account_can_write(p_account uuid) returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$
  select coalesce((select case
      when a.plan = 'owner'      then true
      when a.status = 'trialing' then a.trial_ends_at is not null and now() < a.trial_ends_at
      when a.status = 'active'   then a.current_period_end is not null and now() < a.current_period_end
      when a.status = 'past_due' then a.grace_ends_at is not null and now() < a.grace_ends_at
      else false end
    from stay.accounts a where a.id = p_account), false)
$$;

create or replace function stay.property_can_write(p_account uuid, p_property text) returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$
  select stay.account_can_write(p_account)
     and (p_property is null or not exists (select 1 from stay.properties p
                                            where p.account_id = p_account and p.id = p_property and p.paused))
$$;

-- Why not, in words for the app and the error (null = it can).
create or replace function stay.write_refusal(p_account uuid, p_property text default null) returns text
language sql security definer set search_path = stay, pg_temp stable as $$
  select case
    when stay.account_can_write(p_account) then
      case when stay.property_can_write(p_account, p_property) then null
           else 'This property is read-only on your plan. Choose it as active in Account settings, or move to a bigger plan.' end
    when a.status = 'trialing' or a.plan = 'trial' then
      'Your free trial has ended — subscribe to keep adding bookings. Your data is safe and you can still view and export it.'
    when a.status = 'past_due' then
      'Your payment did not go through — update it to keep adding bookings. Your data is safe and you can still view and export it.'
    else 'Your plan has ended — subscribe to keep adding bookings. Your data is safe and you can still view and export it.'
  end
  from stay.accounts a where a.id = p_account
$$;

-- ── The guard ────────────────────────────────────────────────────────────────
create or replace function stay.guard_write() returns trigger language plpgsql as $$
declare
  r      jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  o      jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_acct uuid  := (r ->> 'account_id')::uuid;
  v_prop text  := case when tg_table_name = 'properties' then r ->> 'id' else r ->> 'property_id' end;
  v_why  text;
  v_n    integer;
  v_max  integer;
begin
  -- migrations (stay.importing) and our own server functions (stay.guard = off)
  if current_setting('stay.importing', true) = 'on' or current_setting('stay.guard', true) = 'off' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Taking access away is always allowed, even on a read-only account.
  if tg_table_name = 'members' and tg_op = 'UPDATE' and (o ->> 'active')::boolean and not (r ->> 'active')::boolean
     and (r - 'active' - 'updated_at') = (o - 'active' - 'updated_at') then return new; end if;
  if tg_table_name = 'member_properties' and tg_op = 'DELETE' then return old; end if;
  if tg_table_name = 'staff_logins' and tg_op = 'UPDATE' and (
       (r - 'notice_version' - 'notice_acknowledged_at' - 'updated_at') = (o - 'notice_version' - 'notice_acknowledged_at' - 'updated_at')
       or ((o ->> 'active')::boolean and not (r ->> 'active')::boolean and (r - 'active' - 'updated_at') = (o - 'active' - 'updated_at')))
     then return new; end if;
  if tg_table_name = 'invites' and tg_op = 'UPDATE'
     and (r - 'expires_at') = (o - 'expires_at') and (r ->> 'expires_at')::timestamptz <= now() then return new; end if;

  -- A property is never written while paused; and a new (or revived) one
  -- must fit the plan's limit.
  if tg_table_name = 'properties' and tg_op <> 'DELETE' then
    v_why := stay.write_refusal(v_acct, case when tg_op = 'UPDATE' and (o ->> 'paused')::boolean then v_prop else null end);
    if v_why is null and not (r ->> 'paused')::boolean and r ->> 'deleted_at' is null
       and (tg_op = 'INSERT' or (o ->> 'deleted_at') is not null or (o ->> 'paused')::boolean) then
      select properties_allowed into v_max from stay.accounts where id = v_acct;
      select count(*) into v_n from stay.properties
       where account_id = v_acct and deleted_at is null and not paused and id <> v_prop;
      if v_max is not null and v_n >= v_max then
        v_why := format('Your plan allows %s %s. Move to a bigger plan to add another.', v_max,
                        case when v_max = 1 then 'property' else 'properties' end);
      end if;
    end if;
  else
    v_why := stay.write_refusal(v_acct, v_prop);
    -- a row with no account (should not exist) is never let through
    if v_acct is null then v_why := 'No account for this row.'; end if;
    -- an update that moves a row out of a paused property is checked at both ends
    if v_why is null and tg_op = 'UPDATE' and o ? 'property_id' and (o ->> 'property_id') is distinct from v_prop then
      v_why := stay.write_refusal(v_acct, o ->> 'property_id');
    end if;
  end if;

  if v_why is not null then
    if tg_table_name in ('attendance','utensil_marks') then v_why := 'Paused by your employer''s account.'; end if;
    raise exception '%', v_why using errcode = 'SL403', hint = 'read_only';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

do $guard$
declare t text;
begin
  foreach t in array array['properties','bookings','expenses','staff','loans','loan_repayments','receipt_series',
                           'ical_feeds','members','member_properties','invites','staff_properties','attendance','utensil_marks',
                           'staff_logins'] loop
    -- named to run before the others (version bump, touch): BEFORE triggers
    -- fire in name order
    execute format('drop trigger if exists "a_guard_write" on stay.%I', t);
    execute format('create trigger "a_guard_write" before insert or update or delete on stay.%I for each row execute function stay.guard_write()', t);
  end loop;
end $guard$;

-- The same rule in row-level security, for the app's role: a RESTRICTIVE
-- policy is ANDed with the existing ones, so it can only narrow them.
do $pol$
declare t text; cond text; tables jsonb := jsonb_build_object(
  'properties', 'stay.property_can_write(account_id, id)',
  'bookings', 'stay.property_can_write(account_id, property_id)',
  'expenses', 'stay.property_can_write(account_id, property_id)',
  'staff', 'stay.account_can_write(account_id)',
  'loans', 'stay.account_can_write(account_id)',
  'loan_repayments', 'stay.account_can_write(account_id)',
  'receipt_series', 'stay.account_can_write(account_id)',
  'ical_feeds', 'stay.property_can_write(account_id, property_id)',
  'staff_properties', 'stay.property_can_write(account_id, property_id)',
  'attendance', 'stay.property_can_write(account_id, property_id)',
  'utensil_marks', 'stay.property_can_write(account_id, property_id)',
  'members', 'stay.account_can_write(account_id) or not active',
  'member_properties', 'stay.account_can_write(account_id)',
  'invites', 'stay.account_can_write(account_id) or expires_at <= now()');
begin
  for t, cond in select key, value #>> '{}' from jsonb_each(tables) loop
    execute format('drop policy if exists "plan allows writing" on stay.%I', t);
    execute format('drop policy if exists "plan allows changing" on stay.%I', t);
    execute format('drop policy if exists "plan allows removing" on stay.%I', t);
    execute format('create policy "plan allows writing" on stay.%I as restrictive for insert with check (%s)', t, cond);
    execute format('create policy "plan allows changing" on stay.%I as restrictive for update using (true) with check (%s)', t, cond);
    if t not in ('member_properties') then          -- removing a manager's property is always allowed
      execute format('create policy "plan allows removing" on stay.%I as restrictive for delete using (%s)', t, cond);
    end if;
  end loop;
end $pol$;

-- ── Her page while the account is paused ─────────────────────────────────────
-- Her marking functions answer "paused" instead of failing on the guard.
create or replace function stay.staff_paused() returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$
  select not stay.account_can_write(me.account_id) from stay.my_login() me where me.account_id is not null
$$;
create or replace function public.staff_paused() returns boolean language sql volatile as $w$ select coalesce(stay.staff_paused(), false) $w$;
do $her$
declare f text;
begin
  -- After the switch-over her public functions are wrappers over `stay`
  -- (the old ones kept as *_v58): each marking one checks first.
  foreach f in array array['staff_mark_today','staff_unmark_today','staff_mark_utensils_today','staff_unmark_utensils_today'] loop
    if to_regprocedure('public.' || f || '_v58()') is not null and to_regprocedure('stay.' || f || '()') is not null then
      execute format($fn$create or replace function public.%I() returns jsonb language plpgsql volatile as $w$
        begin
          if coalesce(stay.staff_paused(), false) then
            return jsonb_build_object('ok', false, 'reason', 'paused', 'message', 'Paused by your employer''s account.');
          end if;
          return stay.%I();
        end $w$$fn$, f, f);
    end if;
  end loop;
  if to_regprocedure('stay.staff_mark_today_at(text)') is not null then
    create or replace function public.staff_mark_today_at(p_property text) returns jsonb language plpgsql volatile as $w$
    begin
      if coalesce(stay.staff_paused(), false) then
        return jsonb_build_object('ok', false, 'reason', 'paused', 'message', 'Paused by your employer''s account.');
      end if;
      return stay.staff_mark_today_at(p_property);
    end $w$;
  end if;
end $her$;

-- ── What the app shows ───────────────────────────────────────────────────────
create or replace function stay.account_state(p_account uuid) returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  select case when stay.role_in(p_account) is null then null else jsonb_build_object(
    'plan', a.plan,
    'status', case when stay.account_can_write(a.id) then a.status
                   when a.status in ('trialing','active','past_due') then 'expired' else a.status end,
    'can_write', stay.account_can_write(a.id),
    'reason', stay.write_refusal(a.id),
    'trial_ends_at', a.trial_ends_at,
    'days_left', case when a.status = 'trialing' and a.trial_ends_at > now()
                      then ceil(extract(epoch from (a.trial_ends_at - now())) / 86400)::int end,
    'current_period_end', a.current_period_end,
    'grace_ends_at', a.grace_ends_at,
    'properties_allowed', a.properties_allowed,
    'properties_active', (select count(*) from stay.properties p where p.account_id = a.id and p.deleted_at is null and not p.paused),
    'paused_properties', coalesce((select jsonb_agg(p.id order by p.id) from stay.properties p
                                   where p.account_id = a.id and p.deleted_at is null and p.paused), '[]'::jsonb))
  end
  from stay.accounts a where a.id = p_account
$$;

-- For the Edge Functions (service key): which of these accounts can be written.
create or replace function stay.accounts_can_write(p_accounts uuid[]) returns table (account_id uuid, can_write boolean)
language sql security definer set search_path = stay, pg_temp stable as $$
  select x, stay.account_can_write(x) from unnest(p_accounts) x
$$;

-- ── Rule B: which properties stay active ─────────────────────────────────────
-- The owner picks; the rest are paused (read-only). Never more active than
-- the plan allows. Runs on a read-only account too.
create or replace function stay.choose_active_properties(p_account uuid, p_active text[]) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare v_max integer; v_n integer;
begin
  if not stay.is_owner(p_account) then raise exception 'Only the owner chooses' using errcode = '42501'; end if;
  select properties_allowed into v_max from stay.accounts where id = p_account;
  select count(*) into v_n from stay.properties where account_id = p_account and deleted_at is null and id = any(p_active);
  if v_max is not null and v_n > v_max then
    raise exception 'Your plan allows % active %', v_max, case when v_max = 1 then 'property' else 'properties' end using errcode = 'SL403';
  end if;
  perform set_config('stay.guard', 'off', true);
  update stay.properties set paused = not (id = any(p_active))
   where account_id = p_account and deleted_at is null and paused is distinct from not (id = any(p_active));
  perform set_config('stay.guard', 'on', true);
  return stay.account_state(p_account);
end $$;

-- After a plan change: if more properties are active than allowed, the
-- oldest stay active and the newest are paused (the owner can change the
-- choice). A bigger plan un-pauses as many as fit, oldest first.
create or replace function stay.fit_properties(p_account uuid) returns void
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare v_max integer;
begin
  select properties_allowed into v_max from stay.accounts where id = p_account;
  perform set_config('stay.guard', 'off', true);
  if v_max is null then
    update stay.properties set paused = false where account_id = p_account and paused;
  else
    with ranked as (
      select id, row_number() over (order by paused, created_at, id) as n
      from stay.properties where account_id = p_account and deleted_at is null)
    update stay.properties p set paused = (r.n > v_max)
      from ranked r where p.account_id = p_account and p.id = r.id and p.paused is distinct from (r.n > v_max);
  end if;
  perform set_config('stay.guard', 'on', true);
end $$;

-- ── The platform admin's screen (no guest data) ──────────────────────────────
create table if not exists stay.admin_audit (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  admin_id   uuid not null,
  account_id uuid,
  action     text not null,
  detail     jsonb not null default '{}'::jsonb
);
alter table stay.admin_audit enable row level security;
drop policy if exists "admins read" on stay.admin_audit;
create policy "admins read" on stay.admin_audit for select using (stay.is_platform_admin());
revoke all on stay.admin_audit from anon, authenticated;
grant select on stay.admin_audit to authenticated;               -- written only by the functions below
create or replace function stay.no_edit() returns trigger language plpgsql as $$
begin raise exception 'This log is append-only'; end $$;
drop trigger if exists append_only on stay.admin_audit;
create trigger append_only before update or delete on stay.admin_audit for each row execute function stay.no_edit();

create or replace function stay.admin_accounts() returns jsonb
language plpgsql security definer set search_path = stay, pg_temp stable as $$
begin
  if not stay.is_platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', a.id, 'name', a.name, 'code', a.code, 'plan', a.plan, 'status', a.status,
    'can_write', stay.account_can_write(a.id), 'trial_ends_at', a.trial_ends_at,
    'current_period_end', a.current_period_end, 'properties_allowed', a.properties_allowed,
    'properties', (select count(*) from stay.properties p where p.account_id = a.id and p.deleted_at is null),
    'owner', (select string_agg(coalesce(m.display_name, ''), ', ') from stay.members m where m.account_id = a.id and m.role = 'owner' and m.active),
    'last_activity', (select max(s.last_pull_at) from stay.sync_status s where s.account_id = a.id),
    'created_at', a.created_at) order by a.created_at desc) from stay.accounts a), '[]'::jsonb);
end $$;

create or replace function stay.admin_log(p_account uuid, p_action text, p_detail jsonb) returns void
language sql security definer set search_path = stay, pg_temp as $$
  insert into stay.admin_audit (admin_id, account_id, action, detail) values (auth.uid(), p_account, p_action, p_detail)
$$;

create or replace function stay.admin_extend_trial(p_account uuid, p_days integer) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare a stay.accounts;
begin
  if not stay.is_platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 90 then raise exception 'Between 1 and 90 days'; end if;
  select * into a from stay.accounts where id = p_account for update;
  if not found then raise exception 'No such account'; end if;
  if a.plan <> 'trial' then raise exception 'Only a trial can be extended'; end if;
  update stay.accounts set status = 'trialing', trial_started_at = coalesce(trial_started_at, now()),
         trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => p_days), inactive_since = null
   where id = p_account;
  perform stay.admin_log(p_account, 'extend_trial', jsonb_build_object('days', p_days, 'was', a.trial_ends_at));
  return stay.account_state_admin(p_account);
end $$;

create or replace function stay.admin_set_plan(p_account uuid, p_plan text, p_until timestamptz default null) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare a stay.accounts;
begin
  if not stay.is_platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
  if p_plan not in ('owner','starter','pro') then raise exception 'Plan owner, starter or pro'; end if;
  select * into a from stay.accounts where id = p_account for update;
  if not found then raise exception 'No such account'; end if;
  update stay.accounts set plan = p_plan,
         status = 'active',
         current_period_end = case when p_plan = 'owner' then null else coalesce(p_until, now() + interval '1 month') end,
         grace_ends_at = null, inactive_since = null,
         properties_allowed = case p_plan when 'owner' then null when 'starter' then 1 else 5 end
   where id = p_account;
  perform stay.fit_properties(p_account);
  perform stay.admin_log(p_account, 'set_plan', jsonb_build_object('plan', p_plan, 'until', p_until, 'was', a.plan));
  return stay.account_state_admin(p_account);
end $$;

create or replace function stay.admin_cancel(p_account uuid) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare a stay.accounts;
begin
  if not stay.is_platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
  select * into a from stay.accounts where id = p_account for update;
  if not found then raise exception 'No such account'; end if;
  if a.plan = 'owner' then raise exception 'An owner plan is never cancelled here'; end if;
  update stay.accounts set status = 'cancelled', inactive_since = coalesce(inactive_since, now()),
         trial_ends_at = case when status = 'trialing' then least(trial_ends_at, now()) else trial_ends_at end,
         current_period_end = case when current_period_end > now() then now() else current_period_end end
   where id = p_account;
  perform stay.admin_log(p_account, 'cancel', jsonb_build_object('was', a.status, 'plan', a.plan));
  return stay.account_state_admin(p_account);
end $$;

-- The admin's view of one account (account_state needs membership).
create or replace function stay.account_state_admin(p_account uuid) returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  select jsonb_build_object('id', a.id, 'plan', a.plan, 'status', a.status, 'can_write', stay.account_can_write(a.id),
    'trial_ends_at', a.trial_ends_at, 'current_period_end', a.current_period_end, 'properties_allowed', a.properties_allowed)
  from stay.accounts a where a.id = p_account and stay.is_platform_admin()
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
do $g$
declare f text;
begin
  foreach f in array array['stay.account_can_write(uuid)','stay.property_can_write(uuid,text)','stay.write_refusal(uuid,text)',
                           'stay.account_state(uuid)','stay.choose_active_properties(uuid,text[])','stay.admin_accounts()',
                           'stay.admin_extend_trial(uuid,integer)','stay.admin_set_plan(uuid,text,timestamptz)',
                           'stay.admin_cancel(uuid)','stay.account_state_admin(uuid)','stay.staff_paused()','public.staff_paused()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['stay.admin_log(uuid,text,jsonb)','stay.fit_properties(uuid)','stay.accounts_can_write(uuid[])'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- the guard runs as whoever writes, the server's key included
    grant execute on function stay.account_can_write(uuid), stay.property_can_write(uuid,text), stay.write_refusal(uuid,text),
      stay.account_state_admin(uuid) to service_role;
    grant execute on function stay.accounts_can_write(uuid[]) to service_role;
    grant execute on function stay.fit_properties(uuid) to service_role;
    grant all on stay.admin_audit to service_role;
  end if;
end $g$;

-- Only v74 and later may sync in the new model (they know read-only).
do $v$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'app_status' and column_name = 'model') then
    update public.app_status set min_version = greatest(min_version, 74) where id = 1 and model = 'stay';
  end if;
end $v$;
