-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — the new model, phase 2: what the sync engine needs.
-- After 01 → 02 → 03. Safe to run twice. Changes no data.
--
-- A loan need not belong to a staff member: the app also records the
-- house's own loans (a bank loan, say), which have no staff member. In the
-- old cloud those never left the phone; in the new model every record lives
-- in Supabase, so stay.loans.staff_id may be empty. Her page only ever reads
-- loans with her own staff id, so it is unaffected.
-- ─────────────────────────────────────────────────────────────────────────────
alter table stay.loans alter column staff_id drop not null;

-- The sync engine reads each table by account and "changed since", in that
-- order; these indexes keep that quick as the data grows.
create index if not exists properties_changed      on stay.properties      (account_id, updated_at);
create index if not exists staff_changed           on stay.staff           (account_id, updated_at);
create index if not exists loans_changed           on stay.loans           (account_id, updated_at);
create index if not exists loan_repayments_changed on stay.loan_repayments (account_id, updated_at);

select 'stay.loans.staff_id may be empty' as "check",
       case when (select is_nullable from information_schema.columns
                  where table_schema = 'stay' and table_name = 'loans' and column_name = 'staff_id') = 'YES'
            then 'ok' else 'PROBLEM — run this script again' end as result;
