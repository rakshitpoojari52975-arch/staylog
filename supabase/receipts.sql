-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · guest receipts
--
-- Two columns on bookings. A receipt number is assigned once, the first time
-- the document is issued, and never changes afterwards — re-sending the same
-- stay has to hand the guest the same number as the first time, or two pieces
-- of paper exist for one stay with different references on them.
--
-- Nothing here is a tax artefact: StayLog issues a receipt, not a tax invoice,
-- and the document says so on its face.
--
-- Run once in the Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings add column if not exists receipt_no text;
alter table public.bookings add column if not exists receipt_on date;

comment on column public.bookings.receipt_no is
  'Assigned on first issue, e.g. RV/2026-27/001. Sequential within the Indian financial year. Never reused.';

-- A number must not end up on two stays. This allows many bookings with no
-- receipt yet, and at most one holding any given number.
create unique index if not exists bookings_receipt_no_unique
  on public.bookings (owner_id, receipt_no) where receipt_no is not null;

-- To see what has been issued:
--   select receipt_no, receipt_on, guest_name, check_in, total_amount, source
--     from public.bookings
--    where receipt_no is not null and deleted_at is null
--    order by receipt_on desc, receipt_no desc;
