-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · checking attendance
--
-- Read-only. Nothing here changes a row, so run any of it whenever you like.
-- Times are shown in IST; the database stores them in UTC.
--
-- The one column worth understanding is expense_id. Empty means your app has
-- not turned that day into an expense yet — either it has not synced since she
-- marked, or she has no daily wage set. Filled means the day is done with: it
-- will never be converted again, and deleting the expense afterwards does not
-- bring it back.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── A. The one to run most days ──────────────────────────────────────────────
-- Last 30 days, newest first, with what became of each mark.
select a.date,
       s.name,
       to_char(a.marked_at at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI am') as marked_at,
       case when a.deleted_at is not null then 'undone'
            when a.expense_id is null    then 'waiting for the app'
            else 'in expenses' end as status,
       a.expense_id
from public.attendance a
join public.staff s on s.id = a.staff_id
where a.date >= current_date - 30
order by a.date desc;


-- ── B. Days worked per month ─────────────────────────────────────────────────
-- at_current_rate is days × today's daily wage. It is an indication, not your
-- books: the real figure is the sum of the expenses, which you may have edited.
select to_char(a.date, 'Mon YYYY') as month,
       s.name,
       count(*) as days_marked,
       count(*) * coalesce(s.daily_wage, 0) as at_current_rate
from public.attendance a
join public.staff s on s.id = a.staff_id
where a.deleted_at is null
group by date_trunc('month', a.date), to_char(a.date, 'Mon YYYY'), s.name, s.daily_wage
order by date_trunc('month', a.date) desc;


-- ── C. Anything stuck ────────────────────────────────────────────────────────
-- Rows here should clear on the next sync. If one sits for days, check that
-- daily_wage is set for that person — a blank rate holds the mark rather than
-- guessing an amount.
select s.name, a.date,
       to_char(a.marked_at at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI am') as marked_at,
       s.daily_wage
from public.attendance a
join public.staff s on s.id = a.staff_id
where a.expense_id is null and a.deleted_at is null
order by a.date;


-- ── D. This month, each day against its expense ──────────────────────────────
-- The reconciliation view: one row per marked day, and what it became.
-- '(expense deleted)' means the mark was converted and you removed the expense
-- afterwards — which is fine, and deliberately does not reappear.
select a.date,
       case when a.expense_id is null then '—'
            else coalesce(e.description, '(expense deleted)') end as expense,
       e.amount,
       case when e.id is null then null when e.paid then 'paid' else 'unpaid' end as state
from public.attendance a
left join public.expenses e on e.id = a.expense_id and e.deleted_at is null
where a.deleted_at is null
  and a.date >= date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)
order by a.date;


-- ── E. Did she mark today? ───────────────────────────────────────────────────
select coalesce((
  select 'yes, at ' || to_char(marked_at at time zone 'Asia/Kolkata', 'HH12:MI am')
  from public.attendance
  where date = (now() at time zone 'Asia/Kolkata')::date and deleted_at is null
  limit 1), 'not yet') as marked_today;


-- ── Adding a day yourself ────────────────────────────────────────────────────
-- She can only mark today. For a day she forgot, add the expense in the app
-- as you always have — do NOT insert a row here, or you will get a second
-- expense for the same day when the app next syncs.
-- ─────────────────────────────────────────────────────────────────────────────
