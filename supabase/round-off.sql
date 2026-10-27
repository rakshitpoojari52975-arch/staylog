-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · Round off on bookings
--
-- For guests who pay us directly (Direct and Booking.com): the rupees settled
-- without being paid. Signed: positive = what we let go (₹4,632.47 billed,
-- ₹4,630 taken → 2.47), negative = what the guest paid over (₹4,995 billed,
-- ₹5,000 taken → −5.00). Always 0 for Airbnb and other platforms, which
-- collect payment themselves.
--
--   balance = total_amount − paid − round_off      (the app's balanceDue)
--   revenue = total_amount − round_off             (= the money received)
--
-- Until this has run, the app keeps round offs on the phone, syncs without
-- them, and Cloud sync names this script. Run in the Supabase SQL editor after
-- setup.sql. Safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bookings add column if not exists round_off numeric(12,2) not null default 0;

comment on column public.bookings.round_off is
  'Signed rupees settled without being paid: + let go, − paid over. 0 unless Direct or Booking.com.';
