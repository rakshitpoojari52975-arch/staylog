-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — the new model, phase 3: moving in, and switching over.
-- After 01 → 02 → 03 → 04. Safe to run twice. Changes no data by itself.
-- (If 02-functions.sql is ever run again, run this again after it: 02 resets
-- who may call the functions in `stay`.)
--
-- The full data lives on the phone (the minimal cloud), so the phone moves
-- it in: the app (⋯ → Move to the new system) calls these functions.
--
--   stay.migration_account(name, code)   your account in `stay`, made once
--   stay.migrate_rows(acct, table, rows)  the phone's rows, as they are;
--                                         re-run = replace (the phone wins)
--   stay.migrate_prune(acct, table, ids)  rows a re-run no longer carries are
--                                         soft-deleted (never a booking)
--   stay.migrate_copy(acct)               what only the cloud has: her marks
--                                         and login, calendar links and
--                                         events, notification devices,
--                                         preferences, inbox, encrypted backups
--   stay.cutover(acct)                    the switch, in one transaction; only
--                                         from the app, after its report matched
--
-- Nothing here touches the old tables' data. Until the switch, the app keeps
-- working on the old model and a "Copy and compare" can be run any number of
-- times. The switch: her marks copied once more and turned into wage lines,
-- the old tables made read-only (their grants saved, for the rollback), her
-- page's functions pointed at `stay` (the old ones kept as *_v58), and
-- public.app_status says model = 'stay' with min_version 62, so an older copy
-- of the app stops syncing. Undo: rollback-cutover.sql.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── where things stand ───────────────────────────────────────────────────────
alter table public.app_status add column if not exists model       text not null default 'public';
alter table public.app_status add column if not exists account_id  uuid;
alter table public.app_status add column if not exists switched_at timestamptz;
do $c$ begin
  alter table public.app_status add constraint app_status_model check (model in ('public','stay'));
exception when duplicate_object then null; end $c$;

alter table stay.accounts add column if not exists migrated_from uuid;     -- the old owner_id
alter table stay.accounts add column if not exists migrated_at   timestamptz;
create unique index if not exists accounts_migrated_from on stay.accounts (migrated_from) where migrated_from is not null;

-- The old tables' write grants, saved at the switch so the rollback can give
-- back exactly what was there.
create table if not exists stay.cutover_grants (
  table_name  text not null,
  column_name text not null default '',
  grantee     text not null,
  privilege   text not null,
  primary key (table_name, column_name, grantee, privilege)
);
create table if not exists stay.migration_log (
  account_id uuid,
  at         timestamptz not null default now(),
  step       text not null,
  detail     jsonb
);
alter table stay.cutover_grants enable row level security;
alter table stay.migration_log  enable row level security;
revoke all on stay.cutover_grants, stay.migration_log from public, anon, authenticated;

-- ── who is moving in ─────────────────────────────────────────────────────────
-- The old owner (public.owners), moving their own data: never anyone else's.
create or replace function stay.migration_mine(p_account uuid) returns boolean
language sql security definer set search_path = stay, public, pg_temp stable as $$
  select auth.uid() is not null
     and exists (select 1 from public.owners o where o.user_id = auth.uid())
     and exists (select 1 from stay.accounts a where a.id = p_account and a.migrated_from = auth.uid())
$$;
create or replace function stay.current_model() returns text
language sql security definer set search_path = public, pg_temp stable as $$
  select coalesce((select model from public.app_status where id = 1), 'public')
$$;

create or replace function stay.migration_account(p_name text, p_code text) returns uuid
language plpgsql security definer set search_path = stay, public, pg_temp as $$
declare v_id uuid; v_code text;
begin
  if auth.uid() is null or not exists (select 1 from public.owners where user_id = auth.uid()) then
    raise exception 'Only the owner of the old data can move it';
  end if;
  select id into v_id from stay.accounts where migrated_from = auth.uid();
  if v_id is null then
    v_code := lower(regexp_replace(coalesce(p_code, ''), '[^a-zA-Z0-9]', '', 'g'));
    if length(v_code) < 2 then v_code := 'stay'; end if;
    v_code := left(v_code, 12);
    while exists (select 1 from stay.accounts where code = v_code) loop
      v_code := left(v_code, 8) || lpad((floor(random() * 10000))::int::text, 4, '0');
    end loop;
    insert into stay.accounts (name, code, migrated_from)
    values (coalesce(nullif(trim(p_name), ''), 'My homestay'), v_code, auth.uid()) returning id into v_id;
  end if;
  insert into stay.members (account_id, user_id, role)
  values (v_id, auth.uid(), 'owner') on conflict (account_id, user_id) do update set role = 'owner', active = true;
  insert into stay.platform_admins (user_id) values (auth.uid()) on conflict do nothing;
  return v_id;
end $$;

-- A parent a row points at but the phone no longer has (deleted long ago):
-- made as a deleted placeholder with that id, so nothing pointing at it is
-- dropped. Listed in the report. Returns true when one was made.
create or replace function stay.migration_placeholder(p_account uuid, p_kind text, p_id text) returns boolean
language plpgsql security definer set search_path = stay, pg_temp as $$
begin
  if p_id is null or p_id = '' then return false; end if;
  if p_kind = 'property' then
    if exists (select 1 from stay.properties where account_id = p_account and id = p_id) then return false; end if;
    insert into stay.properties (account_id, id, name, deleted_at, legacy)
    values (p_account, p_id, '(removed property)', now(), '{"placeholder":true}');
  elsif p_kind = 'staff' then
    if exists (select 1 from stay.staff where account_id = p_account and id = p_id) then return false; end if;
    insert into stay.staff (account_id, id, name, active, deleted_at, legacy)
    values (p_account, p_id, '(removed staff member)', false, now(), '{"placeholder":true}');
  elsif p_kind = 'loan' then
    if exists (select 1 from stay.loans where account_id = p_account and id = p_id) then return false; end if;
    insert into stay.loans (account_id, id, principal, status, deleted_at, legacy)
    values (p_account, p_id, 0, 'closed', now(), '{"placeholder":true}');
  else
    raise exception 'unknown placeholder kind %', p_kind;
  end if;
  insert into stay.migration_log (account_id, step, detail)
  values (p_account, 'placeholder', jsonb_build_object('kind', p_kind, 'id', p_id));
  return true;
end $$;

-- The phone's rows, mapped by the app (sync.js), written as they are. A
-- second run replaces what the first wrote: until the switch, the phone is
-- the source of truth. The mark and re-pricing triggers are off meanwhile.
create or replace function stay.migrate_rows(p_account uuid, p_table text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp as $$
declare
  r jsonb; v_cols text[]; v_list text; v_set text; n int := 0; made jsonb := '[]'::jsonb;
  v_exp text;
begin
  if not stay.migration_mine(p_account) then raise exception 'Not your account to move into'; end if;
  if stay.current_model() <> 'public' then raise exception 'Already switched over: the new sync writes now'; end if;
  if p_table not in ('properties','staff','loans','bookings','expenses','loan_repayments') then
    raise exception 'migrate_rows: % is not a business table', p_table;
  end if;
  perform set_config('stay.importing', 'on', true);
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    r := r || jsonb_build_object('account_id', p_account);
    if r ->> 'id' is null then continue; end if;
    -- parents that are gone become placeholders
    if p_table = 'bookings' and stay.migration_placeholder(p_account, 'property', r ->> 'property_id') then
      made := made || jsonb_build_object('kind', 'property', 'id', r ->> 'property_id'); end if;
    if p_table = 'expenses' then
      if stay.migration_placeholder(p_account, 'property', r ->> 'property_id') then made := made || jsonb_build_object('kind', 'property', 'id', r ->> 'property_id'); end if;
      if stay.migration_placeholder(p_account, 'staff', r ->> 'staff_id') then made := made || jsonb_build_object('kind', 'staff', 'id', r ->> 'staff_id'); end if;
      if stay.migration_placeholder(p_account, 'loan', r ->> 'loan_id') then made := made || jsonb_build_object('kind', 'loan', 'id', r ->> 'loan_id'); end if;
    end if;
    if p_table = 'loans' and stay.migration_placeholder(p_account, 'staff', r ->> 'staff_id') then
      made := made || jsonb_build_object('kind', 'staff', 'id', r ->> 'staff_id'); end if;
    if p_table = 'loan_repayments' then
      if stay.migration_placeholder(p_account, 'loan', r ->> 'loan_id') then made := made || jsonb_build_object('kind', 'loan', 'id', r ->> 'loan_id'); end if;
      v_exp := r ->> 'expense_id';
      if v_exp is not null and not exists (select 1 from stay.expenses where account_id = p_account and id = v_exp) then
        -- the expense it came from is gone: the link is kept in legacy
        r := r || jsonb_build_object('expense_id', null,
               'legacy', coalesce(r -> 'legacy', '{}'::jsonb) || jsonb_build_object('orphan_expense_id', v_exp));
      end if;
    end if;
    select array_agg(column_name::text order by ordinal_position) into v_cols
    from information_schema.columns
    where table_schema = 'stay' and table_name = p_table
      and column_name in (select jsonb_object_keys(r))
      and column_name not in ('created_at','updated_at','updated_by','version');
    v_list := array_to_string(array(select quote_ident(c) from unnest(v_cols) c), ', ');
    v_set  := array_to_string(array(select format('%I = excluded.%I', c, c) from unnest(v_cols) c
                                    where c not in ('account_id','id')), ', ');
    execute format('insert into stay.%I (%s) select %s from jsonb_populate_record(null::stay.%I, $1)
                    on conflict (account_id, id) do %s',
                   p_table, v_list, v_list, p_table,
                   case when v_set = '' then 'nothing' else 'update set ' || v_set end) using r;
    n := n + 1;
  end loop;
  return jsonb_build_object('written', n, 'placeholders', made);
end $$;

-- A re-run: rows written before that the phone no longer has are soft-
-- deleted (they would otherwise be counted twice). Never a booking, never a
-- placeholder, never a line the server made from her marks.
create or replace function stay.migrate_prune(p_account uuid, p_table text, p_ids text[]) returns integer
language plpgsql security definer set search_path = stay, pg_temp as $$
declare n int;
begin
  if not stay.migration_mine(p_account) then raise exception 'Not your account to move into'; end if;
  if stay.current_model() <> 'public' then raise exception 'Already switched over'; end if;
  if p_table not in ('properties','staff','loans','expenses','loan_repayments') then return 0; end if;
  perform set_config('stay.importing', 'on', true);
  execute format('update stay.%I set deleted_at = now()
                  where account_id = $1 and deleted_at is null and not (id = any($2))
                    and coalesce((legacy ->> ''placeholder'')::boolean, false) = false %s',
                 p_table, case when p_table = 'expenses' then 'and source_mark_id is null' else '' end)
    using p_account, coalesce(p_ids, '{}');
  get diagnostics n = row_count;
  -- and rows it does carry again come back
  execute format('update stay.%I set deleted_at = null
                  where account_id = $1 and deleted_at is not null and id = any($2)', p_table)
    using p_account, coalesce(p_ids, '{}');
  return n;
end $$;

-- What only the cloud has. Run by "Copy and compare" (marks only copied, not
-- turned into lines: until the switch the phone does that) and again by the
-- switch itself. Each part only if its old table exists.
create or replace function stay.migrate_server_side(p_account uuid) returns jsonb
language plpgsql security definer set search_path = stay, public, pg_temp as $$
declare v_owner uuid; out_ jsonb := '{}'::jsonb; n int; misfit int;
begin
  select migrated_from into v_owner from stay.accounts where id = p_account;
  if v_owner is null then raise exception 'Not an account moved from the old model'; end if;
  perform set_config('stay.importing', 'on', true);

  -- her login (staff_access → staff_logins)
  if to_regclass('public.staff_access') is not null then
    perform stay.migration_placeholder(p_account, 'staff', a.staff_id) from public.staff_access a where a.owner_id = v_owner;
    insert into stay.staff_logins (user_id, account_id, staff_id, username, display_name, active)
    select a.user_id, p_account, a.staff_id,
           coalesce(nullif(split_part(u.email, '@', 1), ''), a.user_id::text), a.display_name, a.active
    from public.staff_access a left join auth.users u on u.id = a.user_id
    where a.owner_id = v_owner
    on conflict (user_id) do update set account_id = excluded.account_id, staff_id = excluded.staff_id,
      display_name = excluded.display_name, active = excluded.active;
    get diagnostics n = row_count; out_ := out_ || jsonb_build_object('staff_logins', n);
  end if;

  -- her marks, as they are (stamps included); ids that do not fit the rule
  -- (listed by security-v60.sql) are left behind and counted
  if to_regclass('public.attendance') is not null then
    perform stay.migration_placeholder(p_account, 'staff', a.staff_id) from public.attendance a where a.owner_id = v_owner;
    insert into stay.attendance (account_id, id, staff_id, date, marked_at, source, expense_id, created_at, updated_at, deleted_at)
    select p_account, a.id, a.staff_id, a.date, a.marked_at, a.source, a.expense_id, a.created_at, a.updated_at, a.deleted_at
    from public.attendance a where a.owner_id = v_owner and a.id = stay.attendance_id(a.staff_id, a.date)
    on conflict (account_id, id) do update set marked_at = excluded.marked_at, source = excluded.source,
      expense_id = coalesce(stay.attendance.expense_id, excluded.expense_id), deleted_at = excluded.deleted_at;
    get diagnostics n = row_count;
    select count(*) into misfit from public.attendance a where a.owner_id = v_owner and a.id <> stay.attendance_id(a.staff_id, a.date);
    out_ := out_ || jsonb_build_object('attendance', n, 'attendance_misfits', misfit);
  end if;
  if to_regclass('public.utensil_marks') is not null then
    perform stay.migration_placeholder(p_account, 'staff', a.staff_id) from public.utensil_marks a where a.owner_id = v_owner;
    insert into stay.utensil_marks (account_id, id, staff_id, date, marked_at, source, expense_id, created_at, updated_at, deleted_at)
    select p_account, a.id, a.staff_id, a.date, a.marked_at, a.source, a.expense_id, a.created_at, a.updated_at, a.deleted_at
    from public.utensil_marks a where a.owner_id = v_owner and a.id = stay.utensil_mark_id(a.staff_id, a.date)
    on conflict (account_id, id) do update set marked_at = excluded.marked_at, source = excluded.source,
      expense_id = coalesce(stay.utensil_marks.expense_id, excluded.expense_id), deleted_at = excluded.deleted_at;
    get diagnostics n = row_count;
    select count(*) into misfit from public.utensil_marks a where a.owner_id = v_owner and a.id <> stay.utensil_mark_id(a.staff_id, a.date);
    out_ := out_ || jsonb_build_object('utensil_marks', n, 'utensil_misfits', misfit);
  end if;

  -- calendar links (still secrets: owner-only in `stay` too) and their events
  if to_regclass('public.ical_feeds') is not null then
    perform stay.migration_placeholder(p_account, 'property', f.property_id) from public.ical_feeds f where f.owner_id = v_owner;
    insert into stay.ical_feeds (account_id, id, property_id, platform, url, connected, last_fetched_at, last_ok_at,
                                 last_error, last_count, created_at)
    select p_account, f.id, f.property_id, f.platform, f.url, coalesce((to_jsonb(f) ->> 'connected')::boolean, false),
           f.last_fetched_at, f.last_ok_at, f.last_error, f.last_count, f.created_at
    from public.ical_feeds f where f.owner_id = v_owner
    on conflict (account_id, id) do update set property_id = excluded.property_id, platform = excluded.platform,
      url = excluded.url, connected = excluded.connected, last_fetched_at = excluded.last_fetched_at,
      last_ok_at = excluded.last_ok_at, last_error = excluded.last_error, last_count = excluded.last_count;
    get diagnostics n = row_count; out_ := out_ || jsonb_build_object('ical_feeds', n);
  end if;
  if to_regclass('public.ical_events') is not null then
    perform stay.migration_placeholder(p_account, 'property', e.property_id) from public.ical_events e where e.owner_id = v_owner;
    insert into stay.ical_events (account_id, feed_id, uid, property_id, platform, start_date, end_date, summary,
                                  description, kind, gone_at, imported_booking_id, first_seen_at, updated_at)
    select p_account, e.feed_id, e.uid, e.property_id, e.platform, e.start_date, e.end_date, e.summary,
           e.description, e.kind, e.gone_at, e.imported_booking_id, e.first_seen_at, e.updated_at
    from public.ical_events e
    where e.owner_id = v_owner and exists (select 1 from stay.ical_feeds f where f.account_id = p_account and f.id = e.feed_id)
    on conflict (account_id, feed_id, uid) do update set property_id = excluded.property_id, start_date = excluded.start_date,
      end_date = excluded.end_date, summary = excluded.summary, description = excluded.description, kind = excluded.kind,
      gone_at = excluded.gone_at, imported_booking_id = coalesce(stay.ical_events.imported_booking_id, excluded.imported_booking_id),
      updated_at = excluded.updated_at;
    get diagnostics n = row_count; out_ := out_ || jsonb_build_object('ical_events', n);
  end if;

  -- notifications: devices, choices, the inbox (read state kept)
  if to_regclass('public.push_subscriptions') is not null then
    insert into stay.push_subscriptions (account_id, user_id, endpoint, p256dh, auth, device, created_at, last_seen_at)
    select p_account, s.owner_id, s.endpoint, s.p256dh, s.auth, s.device, s.created_at, s.last_seen_at
    from public.push_subscriptions s where s.owner_id = v_owner
    on conflict (account_id, user_id, endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
      device = excluded.device, last_seen_at = excluded.last_seen_at;
    get diagnostics n = row_count; out_ := out_ || jsonb_build_object('push_subscriptions', n);
  end if;
  if to_regclass('public.notification_prefs') is not null then
    insert into stay.notification_prefs (account_id, user_id, prefs)
    select p_account, p.owner_id, p.prefs from public.notification_prefs p where p.owner_id = v_owner
    on conflict (account_id, user_id) do update set prefs = excluded.prefs;
    get diagnostics n = row_count; out_ := out_ || jsonb_build_object('notification_prefs', n);
  end if;
  if to_regclass('public.push_log') is not null then
    insert into stay.push_log (account_id, recipient, key, title, body, url, alert, sent_at, delivered, read_at)
    select p_account, l.owner_id, l.key, to_jsonb(l) ->> 'title', to_jsonb(l) ->> 'body', to_jsonb(l) ->> 'url',
           to_jsonb(l) ->> 'alert', l.sent_at, coalesce((to_jsonb(l) ->> 'delivered')::boolean, true),
           (to_jsonb(l) ->> 'read_at')::timestamptz
    from public.push_log l where l.owner_id = v_owner
    on conflict (account_id, recipient, key) do update set read_at = coalesce(stay.push_log.read_at, excluded.read_at),
      delivered = stay.push_log.delivered or excluded.delivered;
    get diagnostics n = row_count; out_ := out_ || jsonb_build_object('push_log', n);
  end if;

  -- encrypted backups: ciphertext as it is (the passphrase opens them as before)
  if to_regclass('public.backups') is not null then
    insert into stay.backups (account_id, id, created_by, ciphertext, salt, iv, iterations, app_version, size, created_at)
    select p_account, b.id, b.owner_id, b.ciphertext, b.salt, b.iv, b.iterations, b.app_version, b.size, b.created_at
    from public.backups b where b.owner_id = v_owner
    on conflict do nothing;
    get diagnostics n = row_count; out_ := out_ || jsonb_build_object('backups', n);
  end if;
  return out_;
end $$;

-- "Copy and compare": what only the cloud has, then a record of the run.
create or replace function stay.migrate_copy(p_account uuid) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp as $$
declare r jsonb;
begin
  if not stay.migration_mine(p_account) then raise exception 'Not your account to move into'; end if;
  if stay.current_model() <> 'public' then raise exception 'Already switched over'; end if;
  r := stay.migrate_server_side(p_account);
  update stay.accounts set migrated_at = now() where id = p_account;
  insert into stay.migration_log (account_id, step, detail) values (p_account, 'copy', r);
  return r;
end $$;

-- ── the switch ───────────────────────────────────────────────────────────────
-- Her page's functions, by name and exact result type.
create or replace function stay.her_functions() returns table (name text, returns text)
language sql immutable as $$
  values ('staff_calendar', 'table (check_in date, check_out date, guests integer, status text, property text)'),
         ('staff_standing', 'jsonb'), ('staff_mark_today', 'jsonb'), ('staff_unmark_today', 'jsonb'),
         ('staff_mark_utensils_today', 'jsonb'), ('staff_unmark_utensils_today', 'jsonb')
$$;
create or replace function stay.old_tables() returns text[] language sql immutable as $$
  select array['properties','bookings','staff','loans','loan_repayments','expenses','attendance','utensil_marks',
               'staff_access','ical_feeds','ical_events','push_subscriptions','notification_prefs','sync_status',
               'push_log','backups']
$$;

create or replace function stay.cutover(p_account uuid) returns jsonb
language plpgsql security definer set search_path = stay, public, pg_temp as $$
declare r jsonb; pending jsonb; t text; f record;
begin
  if not stay.migration_mine(p_account) then raise exception 'Not your account to switch'; end if;
  if stay.current_model() = 'stay' then return jsonb_build_object('status', 'already'); end if;
  if (select migrated_at from stay.accounts where id = p_account) is null
     or (select migrated_at from stay.accounts where id = p_account) < now() - interval '1 hour' then
    raise exception 'Run "Copy and compare" first (within the hour)';
  end if;

  -- 1. her latest marks, then the wage lines for any the phone had not made
  r := stay.migrate_server_side(p_account);
  perform set_config('stay.importing', 'off', true);
  pending := stay.process_pending(p_account);

  -- 2. the old tables become read-only for the app (grants saved first)
  insert into stay.cutover_grants (table_name, column_name, grantee, privilege)
  select g.table_name, '', g.grantee, g.privilege_type from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.table_name = any(stay.old_tables())
    and g.grantee in ('anon','authenticated') and g.privilege_type in ('INSERT','UPDATE','DELETE')
  union
  select c.table_name, c.column_name, c.grantee, c.privilege_type from information_schema.column_privileges c
  where c.table_schema = 'public' and c.table_name = any(stay.old_tables())
    and c.grantee in ('anon','authenticated') and c.privilege_type in ('INSERT','UPDATE')
    and not exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public'
                    and g.table_name = c.table_name and g.grantee = c.grantee and g.privilege_type = c.privilege_type)
  on conflict do nothing;
  foreach t in array stay.old_tables() loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    end if;
  end loop;

  -- 3. her page: the same functions, by name, now over `stay`
  for f in select * from stay.her_functions() loop
    if to_regprocedure('public.' || f.name || '()') is null then continue; end if;
    if to_regprocedure('public.' || f.name || '_v58()') is null then
      execute format('alter function public.%I() rename to %I', f.name, f.name || '_v58');
      execute format('revoke all on function public.%I() from public, anon, authenticated', f.name || '_v58');
      execute format('create function public.%I() returns %s language sql volatile as $w$ select * from stay.%I() $w$',
                     f.name, f.returns, f.name);
      execute format('revoke all on function public.%I() from public, anon', f.name);
      execute format('grant execute on function public.%I() to authenticated', f.name);
    end if;
  end loop;

  -- 4. the switch itself
  update public.app_status set model = 'stay', account_id = p_account, switched_at = now(),
         min_version = greatest(min_version, 62), updated_at = now() where id = 1;
  insert into stay.migration_log (account_id, step, detail)
  values (p_account, 'cutover', jsonb_build_object('copied', r, 'pending', pending));
  return jsonb_build_object('status', 'ok', 'copied', r, 'pending', pending);
end $$;

-- In the new model the app clears a calendar link as it did before (the
-- link is the owner's; RLS "owner" covers it). Its events go with it.
grant delete on stay.ical_feeds to authenticated;

-- ── who may call what ────────────────────────────────────────────────────────
do $g$
declare f text;
begin
  foreach f in array array['stay.migration_mine(uuid)','stay.current_model()','stay.migration_placeholder(uuid,text,text)',
                           'stay.migrate_server_side(uuid)','stay.her_functions()','stay.old_tables()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['stay.migration_account(text,text)','stay.migrate_rows(uuid,text,jsonb)',
                           'stay.migrate_prune(uuid,text,text[])','stay.migrate_copy(uuid)','stay.cutover(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $g$;

select 'phase 3 functions' as "check",
       case when to_regprocedure('stay.cutover(uuid)') is not null
             and has_function_privilege('authenticated', 'stay.cutover(uuid)', 'execute')
            then 'ok' else 'PROBLEM — run this script again' end as result
union all
select 'the app reads the model', case when exists (select 1 from information_schema.columns where table_schema = 'public'
       and table_name = 'app_status' and column_name = 'model') then 'ok' else 'PROBLEM' end
union all
select 'switched over', (select case when model = 'stay' then 'yes, since ' || switched_at::text else 'not yet (the app does it)' end
                         from public.app_status where id = 1);
