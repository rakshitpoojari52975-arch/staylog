-- ─────────────────────────────────────────────────────────────────────────────
-- "She marked attendance but no expense appeared" — one query, one answer
--
-- Read-only. Run it and read the verdict column.
--
-- The important change from the earlier version: this looks for the expense by
-- the id it WOULD have, not through attendance.expense_id. Those are different
-- questions. If the app created the expense but the tick-off failed, expense_id
-- is still null while the expense exists — and joining through expense_id makes
-- a perfectly good expense invisible, which is exactly how a working day came
-- to look like a missing one.
-- ─────────────────────────────────────────────────────────────────────────────

with marks as (
  select a.*,
         -- the id the app derives from the mark, deterministically
         'wag_' || substring(a.id from 5) as would_be_expense_id
  from public.attendance a
)
select
  m.date,
  s.name,
  s.daily_wage,
  m.expense_id                      as ticked_off_as,
  e.id                              as expense_found,
  e.amount,
  e.paid,
  case
    when m.deleted_at is not null
      then 'Withdrawn. Nothing is owed for this day.'
    when e.id is not null and m.expense_id is not null and e.paid
      then 'Done, and already marked paid.'
    when e.id is not null and m.expense_id is not null
      then 'Done. Unpaid staff payout of ' || e.amount || ' dated ' || e.date || ' in your app.'
    when e.id is not null and m.expense_id is null
      then 'The expense EXISTS (' || e.amount || ' on ' || e.date || ') but the mark was never '
           || 'ticked off. Nothing is missing and nothing will be paid twice — the app retries '
           || 'the tick-off at the next sync.'
    when m.expense_id is not null and e.id is null
      then 'Ticked off, but that expense is not in the cloud — either it has not synced yet, '
           || 'or you deleted it afterwards. Both are fine; it will not come back.'
    when s.daily_wage is null or s.daily_wage <= 0
      then 'No daily wage set for ' || s.name || '. The mark is held on purpose — set the daily '
           || 'wage in the app (Staff -> tap the name -> Daily wage).'
    else 'Not converted yet. Open StayLog, menu -> Cloud sync -> Check now, and read the '
         || 'Attendance line underneath.'
  end as verdict
from marks m
join public.staff s on s.id = m.staff_id
left join public.expenses e
       on e.id = m.would_be_expense_id and e.deleted_at is null
order by m.date desc
limit 12;


-- ── Every wage expense the app made, whatever the marks say ──────────────────
-- An attendance-born expense always has an id beginning 'wag_'. If a day is
-- listed here, the money is recorded, full stop.
select id, date, description, amount, paid
from public.expenses
where deleted_at is null and id like 'wag!_%' escape '!'
order by date desc
limit 15;


-- ── Marks and expenses side by side, counted ─────────────────────────────────
select
  (select count(*) from public.attendance where deleted_at is null)            as marks_made,
  (select count(*) from public.attendance
     where deleted_at is null and expense_id is not null)                      as marks_ticked_off,
  (select count(*) from public.expenses
     where deleted_at is null and id like 'wag!_%' escape '!')                 as wage_expenses,
  (select coalesce(sum(amount),0) from public.expenses
     where deleted_at is null and id like 'wag!_%' escape '!')                 as wage_total;
-- marks_made and wage_expenses should match. marks_ticked_off can lag behind
-- both without anything being wrong — it catches up at the next sync.


-- ── When did this phone last write anything? ─────────────────────────────────
select max(updated_at) at time zone 'Asia/Kolkata' as last_write_from_your_phone
from public.expenses;
