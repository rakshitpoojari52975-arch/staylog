-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · minimal cloud, step 1 of 2: make room for the minimal sync
--
-- From v51 the phone mirrors only the columns something online needs (see
-- "Sync model" in CLAUDE.md); everything else stays on the phone and in the
-- encrypted backup. This prepares the tables for that. It deletes nothing.
--
--   bookings.balance_due     what a Direct / Booking.com guest still owes, worked
--                            out on the phone, for the checkout-tomorrow alert
--                            (instead of the total, paid and round off amounts)
--   sync_status.app_version  which app version last synced: purge-private.sql
--                            will not run until it is the minimal-cloud one
--   NOT NULL dropped from the two old private columns that had it, so rows
--   written without them are accepted until purge-private.sql drops them.
--
-- Run in the Supabase SQL editor BEFORE opening StayLog v51 (until then its
-- syncs stop and say to run this; nothing is lost). Safe to run twice, and
-- safe after purge-private.sql.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings add column if not exists balance_due numeric;
comment on column public.bookings.balance_due is
  'Owed by a guest who pays us directly (Direct, Booking.com), as the phone works it out; null for platforms that collect payment.';

do $$
begin
  if to_regclass('public.sync_status') is not null then
    alter table public.sync_status add column if not exists app_version text;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'bookings' and column_name = 'guest_name') then
    alter table public.bookings alter column guest_name drop not null;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'loan_repayments' and column_name = 'date') then
    alter table public.loan_repayments alter column date drop not null;
  end if;
end $$;
