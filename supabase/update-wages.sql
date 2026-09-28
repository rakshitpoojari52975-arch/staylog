-- Re-defines staff_standing() so wages come from the expense records rather
-- than a salary figure. Safe to run on a live project: it replaces one
-- function and touches no data.

create or replace function public.staff_standing()
returns jsonb
language sql security definer set search_path = public stable as $$
  with me as (
    select a.display_name, s.id as staff_id
    from public.staff_access a
    join public.staff s on s.id = a.staff_id and s.deleted_at is null
    where a.user_id = auth.uid() and a.active
  ),
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
    'pending', jsonb_build_object(
      'amount', coalesce((select sum(amount) from wages where not paid), 0),
      'count',  (select count(*) from wages where not paid),
      'oldest', (select min(date) from wages where not paid)
    ),
    'this_month', jsonb_build_object(
      'amount',   coalesce((select sum(amount) from wages
                            where date >= date_trunc('month', current_date)), 0),
      'deducted', coalesce((select sum(loan_deduction) from wages
                            where date >= date_trunc('month', current_date)), 0)
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

