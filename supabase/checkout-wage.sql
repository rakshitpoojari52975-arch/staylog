-- StayLog · checkout-day wages
-- ─────────────────────────────────────────────────────────────────────────────
-- Run in the Supabase SQL editor, after setup.sql and attendance.sql. Safe to
-- run twice.
--
-- A marked day pays the daily wage, or the checkout-day wage when a booking
-- that is not cancelled checks out that day (once, however many leave). The
-- app works the rate out; this adds where it is kept:
--   staff.checkout_wage    the checkout-day rate; null = pay the daily wage
--   expenses.wage_kind     'daily' or 'checkout': which rate the app used
--   expenses.auto_amount   the amount the app set. An unpaid day whose amount
--                          still equals it is re-priced when bookings change;
--                          one that differs was edited by hand and is left alone.
-- And staff_standing() gains one key per unpaid day, 'checkout', so her page
-- can label checkout days. Everything else it returns is unchanged.
--
-- Until this has run, the app syncs without these columns and the cloud panel
-- says to run it; nothing is lost on the phone.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.staff    add column if not exists checkout_wage numeric;
alter table public.expenses add column if not exists wage_kind     text;
alter table public.expenses add column if not exists auto_amount   numeric;

do $$ begin
  alter table public.staff add constraint staff_checkout_wage_positive
    check (checkout_wage is null or checkout_wage >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.expenses add constraint expenses_wage_kind_known
    check (wage_kind is null or wage_kind in ('daily','checkout'));
exception when duplicate_object then null; end $$;

-- ── Her standing, with checkout days marked ──────────────────────────────────
-- The attendance.sql version, plus 'checkout' in each pending day. Running
-- attendance.sql again afterwards would drop the key; run this after it.

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
                 'note',     d.description,
                 -- paid at the checkout-day rate: a guest left that day
                 'checkout', coalesce(d.wage_kind = 'checkout', false)
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
