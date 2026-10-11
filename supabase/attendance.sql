-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · staff attendance
--
-- She taps "I came in today" on her page; your app turns each mark into an
-- unpaid staff payout at her daily rate, which you then edit and pay exactly
-- like any expense you typed yourself.
--
-- The important part is what this table is NOT. Your sync is single-writer:
-- after pushing, it tombstones every row on the server that your phone does
-- not have. Attendance is the one thing SHE writes, so it is deliberately
-- outside that set — cloud.js never lists it in ORDER or MAP, and the
-- tombstone pass therefore never sees it. It flows one way only: up from her
-- phone, down into your expenses, and never back.
--
-- Two further safeguards against double payment:
--
--   * The primary key is built from her staff id and the date, so a second
--     tap, a retry after a dropped connection, or two phones cannot make a
--     second row for the same day. It is the same row being written again.
--
--   * expense_id is stamped by your app once it has made the expense. Only
--     rows where it is still null are ever converted, so a mark can produce
--     one expense and no more — and an expense you later delete stays
--     deleted rather than reappearing at the next sync.
--
-- Run once in the Supabase SQL editor, after setup.sql.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. What she is paid for a day's work ─────────────────────────────────────
alter table public.staff add column if not exists daily_wage numeric;

comment on column public.staff.daily_wage is
  'Amount one attendance mark becomes. Blank means marks are held rather than converted.';

-- ── 2. The marks themselves ──────────────────────────────────────────────────
create table if not exists public.attendance (
  id         text primary key,          -- att_<staff_id>_<yyyymmdd>, built below
  owner_id   uuid not null references auth.users on delete cascade,
  staff_id   text not null references public.staff on delete cascade,
  date       date not null,
  marked_at  timestamptz not null default now(),
  source     text not null default 'staff',   -- who tapped: 'staff' | 'owner'
  expense_id text,                       -- stamped by the app once converted
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (staff_id, date)
);
create index if not exists attendance_pending_idx
  on public.attendance (owner_id, date) where expense_id is null and deleted_at is null;

drop trigger if exists attendance_touch on public.attendance;
create trigger attendance_touch before update on public.attendance
  for each row execute function public.touch_updated_at();

alter table public.attendance enable row level security;

-- You read and stamp your own rows. She never touches the table at all; the
-- three functions below are her only way in, and they are the reason a policy
-- for her is not needed here.
drop policy if exists "owner full access" on public.attendance;
create policy "owner full access" on public.attendance
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ── How long an undo stays available ─────────────────────────────────────────
-- A mistaken tap is noticed within minutes. Hours later it is not a mistake
-- being corrected, it is a day's wage disappearing with nothing to show it
-- ever existed — and by then the owner's app may already have made it an
-- expense. After this window the day is his to change, not hers.
create or replace function public.attendance_undo_window()
returns interval language sql immutable as $$ select interval '15 minutes' $$;

-- ── 3. The id, in one place ──────────────────────────────────────────────────
-- Deterministic on purpose: same staff member, same day, same id, forever.
create or replace function public.attendance_id(p_staff text, p_date date)
returns text language sql immutable as $$
  select 'att_' || p_staff || '_' || to_char(p_date, 'YYYYMMDD');
$$;

-- ── 4. What she can call ─────────────────────────────────────────────────────
-- Today only. "Today" is taken in IST, not the server's UTC, or a tap made
-- after 10pm would be filed against tomorrow.

create or replace function public.staff_mark_today()
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

  insert into public.attendance (id, owner_id, staff_id, date, source)
  values (public.attendance_id(v_staff, v_today), v_owner, v_staff, v_today, 'staff')
  on conflict (id) do update
    -- An undo followed by a second tap is the same row coming back to life.
    set deleted_at = null,
        marked_at  = case when public.attendance.deleted_at is not null
                          then now() else public.attendance.marked_at end
  returning marked_at into v_at;

  return jsonb_build_object('ok', true, 'date', v_today, 'marked_at', v_at);
end $$;

-- Undo, for a tap she did not mean. Only today's, and only while your app has
-- not already turned it into an expense — after that it is your row to remove.
create or replace function public.staff_unmark_today()
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

  update public.attendance
     set deleted_at = now()
   where id = public.attendance_id(v_staff, v_today)
     and deleted_at is null
     and expense_id is null
     and marked_at > now() - public.attendance_undo_window();
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    -- Say which of the two it is; "no" without a reason is where support
    -- calls come from.
    return jsonb_build_object('ok', false, 'reason',
      case when exists (select 1 from public.attendance
                        where id = public.attendance_id(v_staff, v_today)
                          and deleted_at is null and expense_id is null)
           then 'too_late' else 'already_counted' end);
  end if;
  return jsonb_build_object('ok', true, 'date', v_today);
end $$;

revoke all on function public.staff_mark_today()   from public, anon;
revoke all on function public.staff_unmark_today() from public, anon;
grant execute on function public.staff_mark_today()   to authenticated;
grant execute on function public.staff_unmark_today() to authenticated;

-- ── 5. Her standing, now carrying today's mark ───────────────────────────────
-- Replaces the function from update-functions.sql; everything it returned is
-- returned still, with an 'attendance' key added, so her page needs one round
-- trip rather than two.

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
                 'note',     d.description
               ) order by d.date desc)
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

-- ─────────────────────────────────────────────────────────────────────────────
-- To check it works, signed in as her:
--   select public.staff_mark_today();      -- {"ok": true, ...}
--   select public.staff_mark_today();      -- ok again, still ONE row
--   select public.staff_unmark_today();    -- {"ok": true, ...}
--
-- And as yourself:
--   select id, date, expense_id, deleted_at from public.attendance order by date desc;
--
-- Set her rate before the marks can become expenses — in the app's staff
-- screen, or here:
--   update public.staff set daily_wage = 400 where name = 'Sunitha';
-- ─────────────────────────────────────────────────────────────────────────────
