-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · utensil cleaning
--
-- Laxmi sometimes cleans the guests' utensils. Sometimes the guest pays her
-- directly (the house notes say so); sometimes Rakshit pays her. She reports
-- it only when he is paying, at most once a day: "I cleaned the utensils
-- today" on her page, under "I came in today".
--
-- Built exactly like attendance, and beside it — attendance itself is not
-- changed:
--   * its own table, one row per staff member per day, id ute_<staff>_<date>
--   * written only through the SECURITY DEFINER functions below
--   * outside the app's sync set (never in cloud.js ORDER or MAP), drained one
--     way into an unpaid staff expense "Utensil cleaning — <name> · <date>",
--     and stamped with that expense's id so it converts once and a deleted
--     expense stays deleted
--   * the same 15-minute undo
-- It can only be marked once she is marked present that day, and undoing her
-- attendance undoes that day's utensil mark too (a trigger on attendance; the
-- attendance functions are untouched).
--
-- staff.utensil_rate is what one mark pays. Blank: marks are held and
-- reported, never given an invented amount. It is a separate line from the
-- day's wage, so a checkout day with utensils pays both.
--
-- Run in the Supabase SQL editor after setup.sql, attendance.sql and
-- checkout-wage.sql. Safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The rate ──────────────────────────────────────────────────────────────
alter table public.staff add column if not exists utensil_rate numeric;
comment on column public.staff.utensil_rate is
  'Amount one utensil-cleaning mark becomes. Blank means marks are held rather than converted.';
do $$ begin
  alter table public.staff add constraint staff_utensil_rate_positive
    check (utensil_rate is null or utensil_rate >= 0);
exception when duplicate_object then null; end $$;

-- ── 2. The marks ─────────────────────────────────────────────────────────────
create table if not exists public.utensil_marks (
  id         text primary key,          -- ute_<staff_id>_<yyyymmdd>
  owner_id   uuid not null references auth.users on delete cascade,
  staff_id   text not null references public.staff on delete cascade,
  date       date not null,
  marked_at  timestamptz not null default now(),
  source     text not null default 'staff',
  expense_id text,                       -- stamped by the app once converted
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (staff_id, date)
);
create index if not exists utensil_marks_pending_idx
  on public.utensil_marks (owner_id, date) where expense_id is null and deleted_at is null;

drop trigger if exists utensil_marks_touch on public.utensil_marks;
create trigger utensil_marks_touch before update on public.utensil_marks
  for each row execute function public.touch_updated_at();

alter table public.utensil_marks enable row level security;

-- The owner reads his rows and stamps expense_id. She never touches the table;
-- the functions below are her only way in. Supabase grants ALL on new tables
-- (TRUNCATE included, which ignores RLS), so take it back and grant only that.
drop policy if exists "owner reads" on public.utensil_marks;
create policy "owner reads" on public.utensil_marks
  for select using (owner_id = auth.uid());
drop policy if exists "owner stamps" on public.utensil_marks;
create policy "owner stamps" on public.utensil_marks
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.utensil_marks from anon, authenticated;
grant select on public.utensil_marks to authenticated;
grant update (expense_id) on public.utensil_marks to authenticated;

-- ── 3. The id, in one place ──────────────────────────────────────────────────
create or replace function public.utensil_mark_id(p_staff text, p_date date)
returns text language sql immutable as $$
  select 'ute_' || p_staff || '_' || to_char(p_date, 'YYYYMMDD');
$$;

-- ── 4. What she can call ─────────────────────────────────────────────────────
-- Today only, in IST, like attendance.
create or replace function public.staff_mark_utensils_today()
returns jsonb
language plpgsql security definer set search_path = public volatile as $$
declare
  v_staff text;
  v_owner uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_at    timestamptz;
begin
  select a.staff_id, a.owner_id into v_staff, v_owner
  from public.staff_access a
  join public.staff s on s.id = a.staff_id and s.deleted_at is null
  where a.user_id = auth.uid() and a.active;

  if v_staff is null then
    return jsonb_build_object('ok', false, 'reason', 'no_access');
  end if;

  -- Only on a day she is marked present.
  if not exists (select 1 from public.attendance
                 where id = public.attendance_id(v_staff, v_today) and deleted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'not_present');
  end if;

  insert into public.utensil_marks (id, owner_id, staff_id, date, source)
  values (public.utensil_mark_id(v_staff, v_today), v_owner, v_staff, v_today, 'staff')
  on conflict (id) do update
    -- A second tap is the same row; after an undo it comes back to life.
    set deleted_at = null,
        marked_at  = case when public.utensil_marks.deleted_at is not null
                          then now() else public.utensil_marks.marked_at end
  returning marked_at into v_at;

  return jsonb_build_object('ok', true, 'date', v_today, 'marked_at', v_at);
end $$;

create or replace function public.staff_unmark_utensils_today()
returns jsonb
language plpgsql security definer set search_path = public volatile as $$
declare
  v_staff text;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_rows  int;
begin
  select a.staff_id into v_staff
  from public.staff_access a
  where a.user_id = auth.uid() and a.active;

  if v_staff is null then
    return jsonb_build_object('ok', false, 'reason', 'no_access');
  end if;

  update public.utensil_marks
     set deleted_at = now()
   where id = public.utensil_mark_id(v_staff, v_today)
     and deleted_at is null
     and expense_id is null
     and marked_at > now() - public.attendance_undo_window();
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return jsonb_build_object('ok', false, 'reason',
      case when exists (select 1 from public.utensil_marks
                        where id = public.utensil_mark_id(v_staff, v_today)
                          and deleted_at is null and expense_id is null)
           then 'too_late' else 'already_counted' end);
  end if;
  return jsonb_build_object('ok', true, 'date', v_today);
end $$;

revoke all on function public.staff_mark_utensils_today()   from public, anon;
revoke all on function public.staff_unmark_utensils_today() from public, anon;
grant execute on function public.staff_mark_utensils_today()   to authenticated;
grant execute on function public.staff_unmark_utensils_today() to authenticated;

-- ── 5. Undoing attendance undoes that day's utensil mark ─────────────────────
-- A trigger rather than a change to staff_unmark_today, so attendance works
-- exactly as before. Only a mark not yet turned into an expense is undone;
-- one already converted is the owner's to remove, as with attendance.
create or replace function public.attendance_undo_utensils()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.utensil_marks
       set deleted_at = new.deleted_at
     where id = public.utensil_mark_id(new.staff_id, new.date)
       and deleted_at is null
       and expense_id is null;
  end if;
  return new;
end $$;

drop trigger if exists attendance_undo_utensils on public.attendance;
create trigger attendance_undo_utensils after update of deleted_at on public.attendance
  for each row execute function public.attendance_undo_utensils();

-- ── 6. Her standing, with utensil cleaning ───────────────────────────────────
-- The checkout-wage.sql version, plus a 'kind' per pending line ('wage' or
-- 'utensils') and today's 'utensils' state. This is now the latest of the
-- four definitions (setup.sql, attendance.sql, checkout-wage.sql, this one):
-- run this file last.

create or replace function public.staff_standing()
returns jsonb
language sql security definer set search_path = public stable as $$
  with me as (
    select a.display_name, s.id as staff_id
    from public.staff_access a
    join public.staff s on s.id = a.staff_id and s.deleted_at is null
    where a.user_id = auth.uid() and a.active
  ),
  today as (select (now() at time zone 'Asia/Kolkata')::date as d),
  -- Every expense booked against her IS a wage payment; the app only sets
  -- staff_id on a staff payout. amount is the cash she receives, after any
  -- loan instalment has come off; loan_deduction is what went to the loan.
  wages as (
    select e.* from public.expenses e
    join me on e.staff_id = me.staff_id
    where e.deleted_at is null
  )
  select jsonb_build_object(
    'name', me.display_name,
    'attendance', (
      -- The row is joined WITHOUT filtering deleted_at, so a withdrawn day can
      -- be shown as withdrawn rather than silently reverting to an empty card.
      select jsonb_build_object(
        'today',      t.d,
        'marked',     a.id is not null and a.deleted_at is null,
        'marked_at',  case when a.deleted_at is null then a.marked_at end,
        'undone_at',  a.deleted_at,
        'locked',     coalesce(a.expense_id is not null, false),
        'can_undo',   coalesce(a.deleted_at is null
                               and a.expense_id is null
                               and a.marked_at > now() - public.attendance_undo_window(), false),
        'this_month', (select count(*) from public.attendance x
                        where x.staff_id = me.staff_id and x.deleted_at is null
                          and x.date >= date_trunc('month', t.d))
      )
      from today t
      left join public.attendance a
        on a.id = public.attendance_id(me.staff_id, t.d)
    ),
    -- Today's utensil mark, beside attendance. 'available' is whether she is
    -- marked present today: the only time the button is offered.
    'utensils', (
      select jsonb_build_object(
        'available',  exists (select 1 from public.attendance x
                              where x.id = public.attendance_id(me.staff_id, t.d)
                                and x.deleted_at is null),
        'marked',     u.id is not null and u.deleted_at is null,
        'marked_at',  case when u.deleted_at is null then u.marked_at end,
        'undone_at',  u.deleted_at,
        'locked',     coalesce(u.expense_id is not null, false),
        'can_undo',   coalesce(u.deleted_at is null
                               and u.expense_id is null
                               and u.marked_at > now() - public.attendance_undo_window(), false)
      )
      from today t
      left join public.utensil_marks u
        on u.id = public.utensil_mark_id(me.staff_id, t.d)
    ),
    'pending', jsonb_build_object(
      'amount', coalesce((select sum(amount) from wages where not paid), 0),
      'count',  (select count(*) from wages where not paid),
      'oldest', (select min(date) from wages where not paid),
      -- The arithmetic behind that figure, newest first. gross is the day's
      -- wage, deducted is any loan instalment coming off it, net is what she
      -- actually receives — which is the number she will check against.
      'days', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'date',     d.date,
                 'gross',    coalesce(d.gross_amount, d.amount + coalesce(d.loan_deduction, 0)),
                 'deducted', coalesce(d.loan_deduction, 0),
                 'net',      d.amount,
                 'note',     d.description,
                 -- paid at the checkout-day rate: a guest left that day
                 'checkout', coalesce(d.wage_kind = 'checkout', false),
                 -- which line this is, so a wage and utensil cleaning on the
                 -- same date read as two things, not one paid twice
                 'kind',     case when d.id like 'ute\_%' then 'utensils' else 'wage' end
               ) order by d.date desc, d.id)
        from (select * from wages where not paid order by date desc limit 30) d
      ), '[]'::jsonb),
      -- A long backlog should not turn her page into a scroll.
      'earlier', greatest(0, (select count(*) from wages where not paid) - 30)
    ),
    'this_month', jsonb_build_object(
      'amount',   coalesce((select sum(amount) from wages
                            where date >= date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)), 0),
      'deducted', coalesce((select sum(loan_deduction) from wages
                            where date >= date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)), 0)
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
               'repaid',       coalesce((
                   select sum(r.amount) from public.loan_repayments r
                   where r.loan_id = l.id and r.deleted_at is null), 0)
             ) order by l.disbursed_on desc)
      from public.loans l
      where l.staff_id = me.staff_id and l.deleted_at is null
    ), '[]'::jsonb)
  )
  from me;
$$;

revoke all on function public.staff_standing() from public, anon;
grant execute on function public.staff_standing() to authenticated;
