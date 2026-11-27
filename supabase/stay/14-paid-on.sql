-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — v76: the day a wage was paid, on her page.
-- After 13-billing.sql (any order after 02 works). Safe to run twice. Changes
-- no data and no grants (create or replace keeps them).
--
-- stay.staff_standing() — her page's figures — gains:
--   paydays       her last 6 paydays, newest first: {date (paid_on), days,
--                 received, deducted}
--   last_payout   now the last payday by paid_on: {date, amount, deducted};
--                 null when no paid line has a payday recorded
--   paid_undated  how many paid lines have no payday (paid before v64)
-- Everything else is exactly as 02-functions.sql defines it. Re-running 02
-- puts the old definition back: run this script again after it.
-- ─────────────────────────────────────────────────────────────────────────────

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
    -- v76: the last payday by the day it was paid (paid_on), its days and what
    -- she received; null when no paid line has a payday recorded
    'last_payout', (select jsonb_build_object('date', p.paid_on, 'amount', sum(p.amount),
                                              'deducted', coalesce(sum(p.loan_deduction), 0))
                    from wages p where p.paid and p.paid_on is not null
                    group by p.paid_on order by p.paid_on desc limit 1),
    -- v76: her last 6 paydays, newest first: the day paid, how many days it
    -- covered (a wage and utensil cleaning on one date are one day), what she
    -- received and what went to her loan
    'paydays', coalesce((
      select jsonb_agg(jsonb_build_object('date', g.paid_on, 'days', g.days, 'received', g.received, 'deducted', g.deducted)
                       order by g.paid_on desc)
      from (select p.paid_on, count(distinct p.date) as days, sum(p.amount) as received,
                   coalesce(sum(p.loan_deduction), 0) as deducted
            from wages p where p.paid and p.paid_on is not null
            group by p.paid_on order by p.paid_on desc limit 6) g
    ), '[]'::jsonb),
    -- paid lines from before v64, when no payday was recorded (none invented)
    'paid_undated', (select count(*) from wages where paid and paid_on is null),
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
