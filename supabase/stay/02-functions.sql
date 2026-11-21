-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — the new model, part 2 of 3: functions and triggers (schema `stay`).
-- After 01-schema.sql. Safe to run twice (create or replace). Reads and writes
-- only `stay` tables.
--
--   ids ............ attendance_id, utensil_mark_id, wage id = 'wag_' + mark id
--   bookkeeping .... touch(): updated_at, updated_by, version (+1 per change)
--   access ......... is_platform_admin, role_in, is_owner, is_member, holds, can
--   money .......... pays_directly, round_off_of, balance_due, revenue
--   receipts ....... financial_year, issue_receipt (one counter per series and
--                    year, in one transaction), seed_receipt_series
--   sync ........... apply_change: an upsert that only lands on the version it
--                    was edited from
--   her marks ...... a mark becomes one wage / utensil line on the server, at
--                    once; held without a rate; re-priced when bookings or rates
--                    change; her 15-minute undo removes a line still untouched
--   her page ....... staff_calendar, staff_standing, staff_mark_today and the
--                    rest — the same output as the public ones, over `stay`.
--                    Not used until the cutover points the public ones here.
-- Server-side code skips the mark and re-pricing triggers while a migration
-- runs (set_config('stay.importing','on', true)).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── ids ──────────────────────────────────────────────────────────────────────
create or replace function stay.attendance_id(p_staff text, p_date date)
returns text language sql immutable as $$ select 'att_' || p_staff || '_' || to_char(p_date, 'YYYYMMDD') $$;
create or replace function stay.utensil_mark_id(p_staff text, p_date date)
returns text language sql immutable as $$ select 'ute_' || p_staff || '_' || to_char(p_date, 'YYYYMMDD') $$;
create or replace function stay.undo_window()
returns interval language sql immutable as $$ select interval '15 minutes' $$;

do $ids$ begin
  begin
    alter table stay.attendance add constraint attendance_id_matches check (id = stay.attendance_id(staff_id, date));
  exception when duplicate_object then null; end;
  begin
    alter table stay.utensil_marks add constraint utensil_marks_id_matches check (id = stay.utensil_mark_id(staff_id, date));
  exception when duplicate_object then null; end;
end $ids$;

create or replace function stay.importing() returns boolean language sql stable as
$$ select coalesce(current_setting('stay.importing', true), '') = 'on' $$;

-- ── bookkeeping ──────────────────────────────────────────────────────────────
create or replace function stay.touch() returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    if new.version is not distinct from old.version then new.version := old.version + 1; end if;
  else
    new.version := coalesce(new.version, 1);
  end if;
  return new;
end $$;

create or replace function stay.touch_simple() returns trigger language plpgsql as $$
begin new.updated_at := clock_timestamp(); return new; end $$;

do $touch$
declare t text;
begin
  foreach t in array array['properties','bookings','staff','expenses','loans','loan_repayments'] loop
    execute format('drop trigger if exists touch on stay.%I', t);
    execute format('create trigger touch before insert or update on stay.%I for each row execute function stay.touch()', t);
  end loop;
  foreach t in array array['accounts','members','staff_logins','attendance','utensil_marks','ical_feeds','ical_events',
                           'receipt_series','notification_prefs','sync_status'] loop
    execute format('drop trigger if exists touch on stay.%I', t);
    execute format('create trigger touch before update on stay.%I for each row execute function stay.touch_simple()', t);
  end loop;
end $touch$;

-- Bookings are cancelled, never deleted (a migration may still carry an old
-- soft-deleted row across as it was).
create or replace function stay.bookings_never_deleted() returns trigger language plpgsql as $$
begin
  if new.deleted_at is not null and old.deleted_at is null and not stay.importing() then
    raise exception 'Bookings are cancelled, never deleted';
  end if;
  return new;
end $$;
drop trigger if exists never_deleted on stay.bookings;
create trigger never_deleted before update of deleted_at on stay.bookings
  for each row execute function stay.bookings_never_deleted();

-- ── access ───────────────────────────────────────────────────────────────────
create or replace function stay.is_platform_admin() returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$
  select exists (select 1 from stay.platform_admins where user_id = auth.uid())
$$;

create or replace function stay.role_in(p_account uuid) returns text
language sql security definer set search_path = stay, pg_temp stable as $$
  select role from stay.members where account_id = p_account and user_id = auth.uid() and active
$$;

create or replace function stay.is_member(p_account uuid) returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$ select stay.role_in(p_account) is not null $$;

-- false, never null, for someone who is not a member (a null here once let
-- non-members past "if not stay.is_owner(...)": found in v74)
create or replace function stay.is_owner(p_account uuid) returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$ select coalesce(stay.role_in(p_account) = 'owner', false) $$;

-- Does this login hold the property? An owner holds every one; a manager the
-- ones assigned to them.
create or replace function stay.holds(p_account uuid, p_property text) returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$
  select case stay.role_in(p_account)
    when 'owner'   then true
    when 'manager' then exists (select 1 from stay.member_properties
                                where account_id = p_account and user_id = auth.uid() and property_id = p_property)
    else false end
$$;

-- A manager permission (an owner has them all). Defaults when not set:
-- edit_bookings, send_messages, mark_paid, add_expenses on; see_money,
-- manage_staff, edit_properties off; manage_calendar never.
create or replace function stay.can(p_account uuid, p_perm text) returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$
  select case
    when stay.role_in(p_account) = 'owner' then true
    when stay.role_in(p_account) is distinct from 'manager' then false
    when p_perm = 'manage_calendar' then false
    else coalesce((select (m.permissions ->> p_perm)::boolean from stay.members m
                   where m.account_id = p_account and m.user_id = auth.uid()),
                  p_perm in ('edit_bookings','send_messages','mark_paid','add_expenses'))
  end
$$;

-- An account keeps at least one active owner.
create or replace function stay.keep_an_owner() returns trigger language plpgsql as $$
begin
  if old.role = 'owner' and old.active and (new.role <> 'owner' or not new.active)
     and not exists (select 1 from stay.members where account_id = old.account_id and role = 'owner' and active
                     and user_id <> old.user_id) then
    raise exception 'An account needs at least one owner';
  end if;
  return new;
end $$;
drop trigger if exists keep_an_owner on stay.members;
create trigger keep_an_owner before update on stay.members for each row execute function stay.keep_an_owner();

-- A platform admin opens a new account and becomes its owner.
create or replace function stay.create_account(p_name text, p_code text, p_owner_name text default null)
returns uuid language plpgsql security definer set search_path = stay, pg_temp as $$
declare v_id uuid;
begin
  if not stay.is_platform_admin() then raise exception 'Only a platform admin can open an account'; end if;
  insert into stay.accounts (name, code, owner_name) values (p_name, lower(p_code), p_owner_name) returning id into v_id;
  insert into stay.members (account_id, user_id, role, display_name) values (v_id, auth.uid(), 'owner', p_owner_name);
  return v_id;
end $$;

-- ── dates ────────────────────────────────────────────────────────────────────
create or replace function stay.account_today(p_account uuid) returns date
language sql security definer set search_path = stay, pg_temp stable as $$
  select (now() at time zone coalesce((select time_zone from stay.accounts where id = p_account), 'Asia/Kolkata'))::date
$$;

-- Indian financial year, April to March: 2025-26.
create or replace function stay.financial_year(p_date date) returns text language sql immutable as $$
  select case when extract(month from p_date) >= 4
    then extract(year from p_date)::int || '-' || lpad(((extract(year from p_date)::int + 1) % 100)::text, 2, '0')
    else (extract(year from p_date)::int - 1) || '-' || lpad((extract(year from p_date)::int % 100)::text, 2, '0') end
$$;

-- ── money: one rule each, as in the app ──────────────────────────────────────
-- Does this source's guest pay the house? A blank source counts as Direct.
create or replace function stay.pays_directly(p_account uuid, p_source text) returns boolean
language sql security definer set search_path = stay, pg_temp stable as $$
  select coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'Direct') = any (a.pays_directly_sources)
  from stay.accounts a where a.id = p_account
$$;

create or replace function stay.round_off_of(b stay.bookings) returns numeric language sql stable as $$
  select case when coalesce(stay.pays_directly(b.account_id, b.source), false) then coalesce(b.round_off, 0) else 0 end
$$;

-- THE balance: total − paid − round off; under ₹1 counts as paid.
create or replace function stay.balance_due(b stay.bookings) returns numeric language sql stable as $$
  select case when d < 1 then 0 else d end
  from (select round(coalesce(b.total_amount, 0) - coalesce(b.paid, 0) - stay.round_off_of(b), 2) as d) x
$$;

-- What a stay earns: total less round off (cancelled stays earn nothing).
create or replace function stay.revenue(b stay.bookings) returns numeric language sql stable as $$
  select case when b.status = 'cancelled' then 0 else round(coalesce(b.total_amount, 0) - stay.round_off_of(b), 2) end
$$;

-- ── receipts ─────────────────────────────────────────────────────────────────
-- A property's series: its receipt_prefix, else its initials (as the old app).
create or replace function stay.receipt_prefix_of(p_account uuid, p_property text) returns text
language sql security definer set search_path = stay, pg_temp stable as $$
  select coalesce(nullif(btrim(p.receipt_prefix), ''),
                  nullif(upper(left(regexp_replace(
                    (select string_agg(left(w, 1), '') from regexp_split_to_table(btrim(p.name), '\s+') w), '[^A-Za-z]', '', 'g'), 3)), ''),
                  'R')
  from stay.properties p where p.account_id = p_account and p.id = p_property
$$;

-- Counters start above the highest number already used in each series and
-- year, so no number is ever handed out twice. Safe to run any time.
create or replace function stay.seed_receipt_series(p_account uuid) returns integer
language plpgsql security definer set search_path = stay, pg_temp as $$
declare n int;
begin
  insert into stay.receipt_series (account_id, prefix, financial_year, last_number)
  select p_account, m[1], m[2], max(m[3]::int)
  from (select regexp_match(receipt_no, '^(.+)/(\d{4}-\d{2})/(\d+)$') m
        from stay.bookings where account_id = p_account and receipt_no is not null) x
  where m is not null
  group by m[1], m[2]
  on conflict (account_id, prefix, financial_year)
  do update set last_number = greatest(stay.receipt_series.last_number, excluded.last_number);
  get diagnostics n = row_count;
  return n;
end $$;

-- The booking's receipt number: assigned once, on first issue, never reused.
-- In one transaction with the counter row locked, so two devices issuing at
-- once get two numbers.
create or replace function stay.issue_receipt(p_account uuid, p_booking text) returns text
language plpgsql security definer set search_path = stay, pg_temp as $$
declare b stay.bookings; v_px text; v_fy text; v_n int; v_no text;
begin
  select * into b from stay.bookings where account_id = p_account and id = p_booking for update;
  if b.id is null then raise exception 'No such booking'; end if;
  if not (stay.holds(p_account, b.property_id) and stay.can(p_account, 'mark_paid')) then
    raise exception 'Not allowed to issue receipts for this property';
  end if;
  if b.receipt_no is not null then return b.receipt_no; end if;
  if not coalesce(stay.pays_directly(p_account, b.source), false) then
    raise exception 'Receipts are only for guests who pay the house';
  end if;
  v_px := stay.receipt_prefix_of(p_account, b.property_id);
  v_fy := stay.financial_year(stay.account_today(p_account));
  perform stay.seed_receipt_series(p_account);
  insert into stay.receipt_series (account_id, prefix, financial_year, last_number)
  values (p_account, v_px, v_fy, 0) on conflict do nothing;
  loop
    update stay.receipt_series set last_number = last_number + 1
     where account_id = p_account and prefix = v_px and financial_year = v_fy
    returning last_number into v_n;
    v_no := v_px || '/' || v_fy || '/' || lpad(v_n::text, 3, '0');
    exit when not exists (select 1 from stay.bookings where account_id = p_account and receipt_no = v_no);
  end loop;
  update stay.bookings set receipt_no = v_no, receipt_on = stay.account_today(p_account)
   where account_id = p_account and id = p_booking;
  return v_no;
end $$;

-- ── sync: a change lands only on the version it was edited from ─────────────
-- Security invoker: row-level security decides who may write what.
-- p_base_version null = a new row (refused if the id exists: a conflict).
-- Returns {status: 'ok', row} | {status: 'conflict', server} | {status: 'missing'}.
create or replace function stay.apply_change(p_table text, p_row jsonb, p_base_version integer)
returns jsonb language plpgsql set search_path = stay, pg_temp as $$
declare
  v_acct uuid := (p_row ->> 'account_id')::uuid;
  v_id   text := p_row ->> 'id';
  v_cols text[];
  v_list text;
  v_res  jsonb;
begin
  if p_table not in ('properties','bookings','staff','expenses','loans','loan_repayments') then
    raise exception 'apply_change: % is not a synced table', p_table;
  end if;
  if v_acct is null or v_id is null then raise exception 'apply_change: account_id and id are required'; end if;
  select array_agg(column_name::text order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'stay' and table_name = p_table
    and column_name in (select jsonb_object_keys(p_row))
    and column_name not in ('account_id','id','created_at','updated_at','updated_by','version');

  if p_base_version is null then
    v_list := array_to_string(array(select quote_ident(c) from unnest(array['account_id','id'] || coalesce(v_cols, '{}')) c), ', ');
    execute format('insert into stay.%I (%s) select %s from jsonb_populate_record(null::stay.%I, $1)
                    on conflict (account_id, id) do nothing returning to_jsonb(%I.*)',
                   p_table, v_list, v_list, p_table, p_table) using p_row into v_res;
  elsif coalesce(array_length(v_cols, 1), 0) > 0 then
    v_list := array_to_string(array(select quote_ident(c) from unnest(v_cols) c), ', ');
    execute format('update stay.%I t set (%s) = (select %s from jsonb_populate_record(null::stay.%I, $1))
                    where t.account_id = $2 and t.id = $3 and t.version = $4 returning to_jsonb(t.*)',
                   p_table, v_list, v_list, p_table) using p_row, v_acct, v_id, p_base_version into v_res;
  end if;

  if v_res is not null then return jsonb_build_object('status', 'ok', 'row', v_res); end if;
  execute format('select to_jsonb(t.*) from stay.%I t where t.account_id = $1 and t.id = $2', p_table)
    using v_acct, v_id into v_res;
  if v_res is null then return jsonb_build_object('status', 'missing'); end if;
  if p_base_version is not null and (v_res ->> 'version')::int = p_base_version then
    return jsonb_build_object('status', 'ok', 'row', v_res);          -- nothing to change
  end if;
  return jsonb_build_object('status', 'conflict', 'server', v_res);
end $$;

-- ── her marks → wage and utensil lines ───────────────────────────────────────
-- The day's wage: the checkout-day rate when a stay that is not cancelled
-- checks out that day at one of her properties (all of them when none are
-- assigned), else the daily wage. A blank or non-positive checkout rate
-- means the daily one. Flat, however many leave.
create or replace function stay.wage_for(p_account uuid, p_staff text, p_date date, out kind text, out amount numeric)
language plpgsql security definer set search_path = stay, pg_temp stable as $$
declare s stay.staff; v_co boolean;
begin
  select * into s from stay.staff where account_id = p_account and id = p_staff;
  select exists (
    select 1 from stay.bookings b
    where b.account_id = p_account and b.check_out = p_date and b.status <> 'cancelled' and b.deleted_at is null
      and (not exists (select 1 from stay.staff_properties sp where sp.account_id = p_account and sp.staff_id = p_staff)
           or b.property_id in (select sp.property_id from stay.staff_properties sp
                                where sp.account_id = p_account and sp.staff_id = p_staff))) into v_co;
  if v_co then
    kind := 'checkout'; amount := case when coalesce(s.checkout_wage, 0) > 0 then s.checkout_wage else s.daily_wage end;
  else
    kind := 'daily'; amount := s.daily_wage;
  end if;
end $$;

-- Where a line is charged: the mark's property; else her one property; else Shared.
create or replace function stay.charge_to(p_account uuid, p_staff text, p_mark_property text) returns text
language sql security definer set search_path = stay, pg_temp stable as $$
  select coalesce(p_mark_property,
    (select min(property_id) from stay.staff_properties where account_id = p_account and staff_id = p_staff
     having count(*) = 1))
$$;

create or replace function stay.pretty_day(p_date date) returns text language sql immutable as
$$ select to_char(p_date, 'FMDD Mon') $$;

-- One mark → one line. Returns what happened: skip / stamped / revived /
-- removed (a stamped mark whose line was deleted on purpose stays deleted) /
-- held (no rate: never an invented amount) / created.
create or replace function stay.process_mark(p_account uuid, p_kind text, p_mark text) returns text
language plpgsql security definer set search_path = stay, pg_temp as $$
declare
  m   record;
  e   stay.expenses;
  s   stay.staff;
  v_kind text;
  eid text;
  amt numeric;
begin
  if p_kind = 'attendance' then
    select * into m from stay.attendance where account_id = p_account and id = p_mark for update;
  else
    select * into m from stay.utensil_marks where account_id = p_account and id = p_mark for update;
  end if;
  if m.id is null or m.deleted_at is not null or m.expense_id is not null then return 'skip'; end if;
  eid := case when p_kind = 'attendance' then 'wag_' || substr(m.id, 5) else m.id end;

  select * into e from stay.expenses where account_id = p_account and id = eid for update;
  if e.id is not null then
    if e.deleted_at is not null and coalesce((e.legacy ->> 'undone')::boolean, false) then
      update stay.expenses set deleted_at = null, legacy = legacy - 'undone'
       where account_id = p_account and id = eid;
      if p_kind = 'attendance' then perform stay.reprice_wages(p_account); end if;
      perform stay.stamp_mark(p_account, p_kind, m.id, eid);
      return 'revived';
    end if;
    perform stay.stamp_mark(p_account, p_kind, m.id, eid);
    return case when e.deleted_at is null then 'stamped' else 'removed' end;
  end if;

  select * into s from stay.staff where account_id = p_account and id = m.staff_id;
  if p_kind = 'attendance' then
    select f.kind, f.amount into v_kind, amt from stay.wage_for(p_account, m.staff_id, m.date) f;
  else
    amt := s.utensil_rate;
  end if;
  if s.id is null or amt is null or amt <= 0 then return 'held'; end if;

  insert into stay.expenses (account_id, id, property_id, date, category, description, amount, gross_amount,
                             auto_amount, wage_kind, staff_id, paid, notes, source_mark_id)
  values (p_account, eid, stay.charge_to(p_account, m.staff_id, m.property_id), m.date, 'staff',
          case when p_kind = 'attendance'
               then 'Wage — ' || s.name || ' · ' || stay.pretty_day(m.date) || case when v_kind = 'checkout' then ' · checkout day' else '' end
               else 'Utensil cleaning — ' || s.name || ' · ' || stay.pretty_day(m.date) end,
          amt, amt, case when p_kind = 'attendance' then amt end, v_kind,
          m.staff_id, false,
          case when p_kind = 'attendance' then 'From her attendance mark' else 'From her utensil mark' end, m.id);
  perform stay.stamp_mark(p_account, p_kind, m.id, eid);
  return 'created';
end $$;

create or replace function stay.stamp_mark(p_account uuid, p_kind text, p_mark text, p_expense text) returns void
language plpgsql security definer set search_path = stay, pg_temp as $$
begin
  if p_kind = 'attendance' then
    update stay.attendance set expense_id = p_expense where account_id = p_account and id = p_mark;
  else
    update stay.utensil_marks set expense_id = p_expense where account_id = p_account and id = p_mark;
  end if;
end $$;

-- Every mark still waiting: after a rate is set, or her properties change.
create or replace function stay.process_pending(p_account uuid) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp as $$
declare r record; v text; out_ jsonb := '{}'::jsonb;
begin
  for r in select 'attendance' k, id from stay.attendance where account_id = p_account and deleted_at is null and expense_id is null
           union all
           select 'utensils', id from stay.utensil_marks where account_id = p_account and deleted_at is null and expense_id is null
           order by 2 loop
    v := stay.process_mark(p_account, r.k, r.id);
    out_ := jsonb_set(out_, array[v], to_jsonb(coalesce((out_ ->> v)::int, 0) + 1));
  end loop;
  return out_;
end $$;

-- Unpaid wage lines still at the amount the app set (auto_amount; or, for
-- days from before it existed, the daily wage) and with no loan cut follow
-- today's rates and bookings. Paid lines and hand edits: never. Utensil
-- lines: never (only wag_ ids).
create or replace function stay.reprice_wages(p_account uuid) returns integer
language plpgsql security definer set search_path = stay, pg_temp as $$
declare e record; w record; v_desc text; n int := 0;
begin
  for e in
    select x.*, s.daily_wage from stay.expenses x join stay.staff s on s.account_id = x.account_id and s.id = x.staff_id
    where x.account_id = p_account and x.category = 'staff' and x.id like 'wag\_%' and not x.paid and x.deleted_at is null
      and coalesce(x.loan_deduction, 0) = 0
      and (case when x.auto_amount is not null then x.amount = x.auto_amount
                else coalesce(s.daily_wage, 0) > 0 and x.amount = s.daily_wage end)
  loop
    select * into w from stay.wage_for(p_account, e.staff_id, e.date);
    continue when w.amount is null or w.amount <= 0;            -- never price a day to nothing
    v_desc := regexp_replace(coalesce(e.description, ''), ' · checkout day$', '') || case when w.kind = 'checkout' then ' · checkout day' else '' end;
    continue when e.amount = w.amount and e.wage_kind is not distinct from w.kind
              and e.auto_amount is not distinct from w.amount and e.description is not distinct from v_desc;
    update stay.expenses set amount = w.amount, gross_amount = w.amount, auto_amount = w.amount,
                             wage_kind = w.kind, description = v_desc
     where account_id = p_account and id = e.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Undo a mark within 15 minutes. A line already made from it goes too, but
-- only while untouched (unpaid, no loan cut, still the app's amount); it is
-- soft-deleted and flagged, so marking again brings it back rather than
-- counting as "deleted on purpose". Returns ok / too_late / already_counted.
create or replace function stay.undo_mark(p_account uuid, p_kind text, p_mark text) returns text
language plpgsql security definer set search_path = stay, pg_temp as $$
declare m record; e stay.expenses;
begin
  if p_kind = 'attendance' then
    select * into m from stay.attendance where account_id = p_account and id = p_mark for update;
  else
    select * into m from stay.utensil_marks where account_id = p_account and id = p_mark for update;
  end if;
  if m.id is null or m.deleted_at is not null then return 'already_counted'; end if;
  if m.expense_id is not null then
    select * into e from stay.expenses where account_id = p_account and id = m.expense_id for update;
    if e.id is not null and e.deleted_at is null and
       (e.paid or coalesce(e.loan_deduction, 0) > 0 or (e.auto_amount is not null and e.amount <> e.auto_amount)) then
      return 'already_counted';
    end if;
  end if;
  if m.marked_at <= now() - stay.undo_window() then return 'too_late'; end if;
  if e.id is not null and e.deleted_at is null then
    update stay.expenses set deleted_at = now(), legacy = coalesce(legacy, '{}'::jsonb) || '{"undone":true}'::jsonb
     where account_id = p_account and id = e.id;
  end if;
  if p_kind = 'attendance' then
    update stay.attendance set deleted_at = now(), expense_id = null where account_id = p_account and id = p_mark;
  else
    update stay.utensil_marks set deleted_at = now(), expense_id = null where account_id = p_account and id = p_mark;
  end if;
  return 'ok';
end $$;

-- Triggers: a new or revived mark is processed at once.
create or replace function stay.on_mark() returns trigger language plpgsql security definer set search_path = stay, pg_temp as $$
begin
  if stay.importing() then return new; end if;
  if new.deleted_at is null and new.expense_id is null then
    perform stay.process_mark(new.account_id, case when tg_table_name = 'attendance' then 'attendance' else 'utensils' end, new.id);
  end if;
  return new;
end $$;
drop trigger if exists on_mark on stay.attendance;
create trigger on_mark after insert or update of deleted_at on stay.attendance
  for each row execute function stay.on_mark();
drop trigger if exists on_mark on stay.utensil_marks;
create trigger on_mark after insert or update of deleted_at on stay.utensil_marks
  for each row execute function stay.on_mark();

-- Undoing attendance undoes that day's utensil mark (and its untouched line).
create or replace function stay.attendance_undo_utensils() returns trigger language plpgsql
security definer set search_path = stay, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null and not stay.importing() then
    perform stay.undo_mark(new.account_id, 'utensils', stay.utensil_mark_id(new.staff_id, new.date));
  end if;
  return new;
end $$;
drop trigger if exists undo_utensils on stay.attendance;
create trigger undo_utensils after update of deleted_at on stay.attendance
  for each row execute function stay.attendance_undo_utensils();

-- Re-price when what decides a rate changes: bookings (dates, status,
-- property), her rates, her properties. Rates set late also release held marks.
create or replace function stay.on_rate_inputs() returns trigger language plpgsql security definer set search_path = stay, pg_temp as $$
declare v_acct uuid := coalesce(new.account_id, old.account_id);
begin
  if stay.importing() then return null; end if;
  if tg_table_name in ('staff','staff_properties') then perform stay.process_pending(v_acct); end if;
  perform stay.reprice_wages(v_acct);
  return null;
end $$;
drop trigger if exists reprice on stay.bookings;
create trigger reprice after insert or update of check_out, status, property_id, deleted_at on stay.bookings
  for each row execute function stay.on_rate_inputs();
drop trigger if exists reprice on stay.staff;
create trigger reprice after update of daily_wage, checkout_wage, utensil_rate on stay.staff
  for each row execute function stay.on_rate_inputs();
drop trigger if exists reprice on stay.staff_properties;
create trigger reprice after insert or delete on stay.staff_properties
  for each row execute function stay.on_rate_inputs();

-- ── her page, over `stay` (not used until the cutover) ───────────────────────
-- Fixed columns, as the public ones. Her login → her account and staff
-- record; everything below is matched by both.
create or replace function stay.my_login(out account_id uuid, out staff_id text, out display_name text)
language sql security definer set search_path = stay, pg_temp stable as $$
  select l.account_id, l.staff_id, coalesce(l.display_name, s.name)
  from stay.staff_logins l join stay.staff s on s.account_id = l.account_id and s.id = l.staff_id and s.deleted_at is null
  where l.user_id = auth.uid() and l.active
$$;

create or replace function stay.staff_calendar()
returns table (check_in date, check_out date, guests integer, status text, property text)
language sql security definer set search_path = stay, pg_temp stable as $$
  -- The next fortnight at her properties (all of them when none are assigned).
  select b.check_in, b.check_out, b.guests, b.status, p.name
  from stay.my_login() me
  join stay.bookings b on b.account_id = me.account_id
  left join stay.properties p on p.account_id = b.account_id and p.id = b.property_id
  where me.account_id is not null
    and b.deleted_at is null and b.status <> 'cancelled'
    and b.check_out >  stay.account_today(me.account_id)
    and b.check_in  <= stay.account_today(me.account_id) + 15
    and (not exists (select 1 from stay.staff_properties sp where sp.account_id = me.account_id and sp.staff_id = me.staff_id)
         or b.property_id in (select sp.property_id from stay.staff_properties sp
                              where sp.account_id = me.account_id and sp.staff_id = me.staff_id))
  order by b.check_in
$$;

create or replace function stay.staff_mark_today()
returns jsonb language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare me record; v_today date; v_at timestamptz;
begin
  select * into me from stay.my_login();
  if me.account_id is null then return jsonb_build_object('ok', false, 'reason', 'no_access'); end if;
  v_today := stay.account_today(me.account_id);
  insert into stay.attendance (account_id, id, staff_id, date, property_id, source)
  values (me.account_id, stay.attendance_id(me.staff_id, v_today), me.staff_id, v_today,
          stay.charge_to(me.account_id, me.staff_id, null), 'staff')
  on conflict (account_id, id) do update
    set deleted_at = null,
        marked_at  = case when stay.attendance.deleted_at is not null then now() else stay.attendance.marked_at end
  returning marked_at into v_at;
  return jsonb_build_object('ok', true, 'date', v_today, 'marked_at', v_at);
end $$;

create or replace function stay.staff_unmark_today()
returns jsonb language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare me record; v_today date; v text;
begin
  select * into me from stay.my_login();
  if me.account_id is null then return jsonb_build_object('ok', false, 'reason', 'no_access'); end if;
  v_today := stay.account_today(me.account_id);
  v := stay.undo_mark(me.account_id, 'attendance', stay.attendance_id(me.staff_id, v_today));
  if v <> 'ok' then return jsonb_build_object('ok', false, 'reason', v); end if;
  return jsonb_build_object('ok', true, 'date', v_today);
end $$;

create or replace function stay.staff_mark_utensils_today()
returns jsonb language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare me record; v_today date; v_at timestamptz;
begin
  select * into me from stay.my_login();
  if me.account_id is null then return jsonb_build_object('ok', false, 'reason', 'no_access'); end if;
  v_today := stay.account_today(me.account_id);
  if not exists (select 1 from stay.attendance where account_id = me.account_id
                 and id = stay.attendance_id(me.staff_id, v_today) and deleted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'not_present');
  end if;
  insert into stay.utensil_marks (account_id, id, staff_id, date, property_id, source)
  values (me.account_id, stay.utensil_mark_id(me.staff_id, v_today), me.staff_id, v_today,
          stay.charge_to(me.account_id, me.staff_id, null), 'staff')
  on conflict (account_id, id) do update
    set deleted_at = null,
        marked_at  = case when stay.utensil_marks.deleted_at is not null then now() else stay.utensil_marks.marked_at end
  returning marked_at into v_at;
  return jsonb_build_object('ok', true, 'date', v_today, 'marked_at', v_at);
end $$;

create or replace function stay.staff_unmark_utensils_today()
returns jsonb language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare me record; v_today date; v text;
begin
  select * into me from stay.my_login();
  if me.account_id is null then return jsonb_build_object('ok', false, 'reason', 'no_access'); end if;
  v_today := stay.account_today(me.account_id);
  v := stay.undo_mark(me.account_id, 'utensils', stay.utensil_mark_id(me.staff_id, v_today));
  if v <> 'ok' then return jsonb_build_object('ok', false, 'reason', v); end if;
  return jsonb_build_object('ok', true, 'date', v_today);
end $$;

-- A line made from a mark counts as "locked" (Counted) once it exists; it can
-- still be undone within the window while untouched.
create or replace function stay.mark_state(p_account uuid, p_kind text, p_mark text) returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  with m as (
    select a.id, a.marked_at, a.deleted_at, a.expense_id from stay.attendance a
     where p_kind = 'attendance' and a.account_id = p_account and a.id = p_mark
    union all
    select u.id, u.marked_at, u.deleted_at, u.expense_id from stay.utensil_marks u
     where p_kind = 'utensils' and u.account_id = p_account and u.id = p_mark
  ), e as (
    select x.* from stay.expenses x join m on x.account_id = p_account and x.id = m.expense_id where x.deleted_at is null
  )
  select jsonb_build_object(
    'marked',    (select count(*) from m where deleted_at is null) > 0,
    'marked_at', (select marked_at from m where deleted_at is null),
    'undone_at', (select deleted_at from m),
    'locked',    exists (select 1 from e),
    'can_undo',  coalesce((select m.deleted_at is null and m.marked_at > now() - stay.undo_window()
                             and not exists (select 1 from e where e.paid or coalesce(e.loan_deduction, 0) > 0
                                             or (e.auto_amount is not null and e.amount <> e.auto_amount))
                           from m), false))
$$;

create or replace function stay.staff_standing()
returns jsonb language sql security definer set search_path = stay, pg_temp stable as $$
  with me as (select * from stay.my_login()),
  today as (select stay.account_today(me.account_id) as d from me),
  wages as (
    select e.* from stay.expenses e join me on e.account_id = me.account_id and e.staff_id = me.staff_id
    where e.deleted_at is null
  )
  select jsonb_build_object(
    'name', me.display_name,
    'attendance',
      stay.mark_state(me.account_id, 'attendance', stay.attendance_id(me.staff_id, t.d))
      || jsonb_build_object('today', t.d,
           'this_month', (select count(*) from stay.attendance x
                           where x.account_id = me.account_id and x.staff_id = me.staff_id and x.deleted_at is null
                             and x.date >= date_trunc('month', t.d))),
    'utensils',
      stay.mark_state(me.account_id, 'utensils', stay.utensil_mark_id(me.staff_id, t.d))
      || jsonb_build_object('available', exists (select 1 from stay.attendance x
                              where x.account_id = me.account_id and x.id = stay.attendance_id(me.staff_id, t.d)
                                and x.deleted_at is null)),
    'pending', jsonb_build_object(
      'amount', coalesce((select sum(amount) from wages where not paid), 0),
      'count',  (select count(*) from wages where not paid),
      'oldest', (select min(date) from wages where not paid),
      'days', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'date',     d.date,
                 'gross',    coalesce(d.gross_amount, d.amount + coalesce(d.loan_deduction, 0)),
                 'deducted', coalesce(d.loan_deduction, 0),
                 'net',      d.amount,
                 'note',     d.description,
                 'checkout', coalesce(d.wage_kind = 'checkout', false),
                 'kind',     case when d.id like 'ute\_%' then 'utensils' else 'wage' end
               ) order by d.date desc, d.id)
        from (select * from wages where not paid order by date desc limit 30) d
      ), '[]'::jsonb),
      'earlier', greatest(0, (select count(*) from wages where not paid) - 30)
    ),
    'this_month', jsonb_build_object(
      'amount',   coalesce((select sum(amount) from wages where date >= date_trunc('month', t.d)), 0),
      'deducted', coalesce((select sum(loan_deduction) from wages where date >= date_trunc('month', t.d)), 0)
    ),
    'overall', jsonb_build_object(
      'paid',     coalesce((select sum(amount) from wages where paid), 0),
      'deducted', coalesce((select sum(loan_deduction) from wages where paid), 0)
    ),
    'last_payout', (select jsonb_build_object('date', date, 'amount', amount)
                    from wages where paid order by date desc limit 1),
    'loans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'principal',    l.principal,
               'instalment',   l.installment_amount,
               'disbursed_on', l.disbursed_on,
               'first_due',    l.first_due_date,
               'status',       l.status,
               'repaid',       coalesce((select sum(r.amount) from stay.loan_repayments r
                                         where r.account_id = me.account_id and r.loan_id = l.id and r.deleted_at is null), 0)
             ) order by l.disbursed_on desc)
      from stay.loans l
      where l.account_id = me.account_id and l.staff_id = me.staff_id and l.deleted_at is null
    ), '[]'::jsonb)
  )
  from me cross join today t
  where me.account_id is not null
$$;

-- ── who may call what ────────────────────────────────────────────────────────
do $grants$
declare f text;
begin
  -- everything private by default
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'stay' loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- what row-level security, the app and her page call
  foreach f in array array[
    'stay.importing()', 'stay.is_platform_admin()', 'stay.role_in(uuid)', 'stay.is_member(uuid)', 'stay.is_owner(uuid)',
    'stay.holds(uuid,text)', 'stay.can(uuid,text)', 'stay.account_today(uuid)', 'stay.financial_year(date)',
    'stay.pays_directly(uuid,text)', 'stay.round_off_of(stay.bookings)', 'stay.balance_due(stay.bookings)',
    'stay.revenue(stay.bookings)', 'stay.issue_receipt(uuid,text)', 'stay.apply_change(text,jsonb,integer)',
    'stay.create_account(text,text,text)', 'stay.attendance_id(text,date)', 'stay.utensil_mark_id(text,date)',
    'stay.staff_calendar()', 'stay.staff_standing()', 'stay.staff_mark_today()', 'stay.staff_unmark_today()',
    'stay.staff_mark_utensils_today()', 'stay.staff_unmark_utensils_today()'] loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;
