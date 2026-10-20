-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · payment details for guests who pay at the property
--
-- Direct and Booking.com guests pay Rakshit directly during their stay. The
-- app sends them the balance and how to pay — before check-out, or whenever
-- he taps "Payment request". The details are property data, kept here beside
-- the Wi-Fi details and synced like them. They are never in the app's code:
-- the repository is public.
--
--   upi_id        the UPI ID, sent as plain text the guest can copy
--   upi_payee     the name the guest should see when paying
--   upi_qr        optional QR image (a data: URL, like properties.signature),
--                 shared through the phone's share sheet, never in a link
--   bank_details  optional free text: account name, number, IFSC, bank
--
-- Readable only by the owner (setup.sql's "owner full access" policy on
-- properties). The house help reads nothing here: staff_calendar() returns
-- the property name only.
--
-- Run in the Supabase SQL editor after setup.sql. Safe to run twice. Until it
-- has run, the app syncs without these columns and the cloud panel says so;
-- the phone keeps the values.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.properties add column if not exists upi_id       text;
alter table public.properties add column if not exists upi_payee    text;
alter table public.properties add column if not exists upi_qr       text;
alter table public.properties add column if not exists bank_details text;

-- A UPI ID is name@handle. Anything else is a typo that would send a guest's
-- money nowhere, so it is refused here as well as in the app.
do $$ begin
  alter table public.properties add constraint properties_upi_id_shape
    check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$');
exception when duplicate_object then null; end $$;

-- An image, not anything else that could be dropped into the column.
do $$ begin
  alter table public.properties add constraint properties_upi_qr_image
    check (upi_qr is null or upi_qr ~ '^data:image/(png|jpeg|webp);base64,');
exception when duplicate_object then null; end $$;
