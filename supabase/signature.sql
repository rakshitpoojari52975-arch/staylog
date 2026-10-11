-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog · the signature that goes on receipts
--
-- It belongs here rather than in app.js. The app's repository is public, and a
-- signature committed into it is a signature anybody can lift and put on a
-- document of their own. Stored as property data it is covered by the policies
-- already on this table — owner only — and never appears in anything uploaded
-- to GitHub.
--
-- The house help cannot reach it. She reads nothing from base tables; the two
-- SECURITY DEFINER functions she calls return a fixed column list that includes
-- the property NAME and nothing else, so adding a column here cannot widen what
-- she sees.
--
-- Run once in the Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.properties add column if not exists signature text;
alter table public.properties add column if not exists signature_ratio numeric;

comment on column public.properties.signature is
  'Transparent PNG as a data URI, trimmed to the ink by the app. Owner only.';
comment on column public.properties.signature_ratio is
  'Height divided by width of that image, so the receipt can place it without loading it first.';

-- Confirm it is set, without printing the whole image back at you:
--   select name,
--          signature is not null and signature <> '' as has_signature,
--          length(signature) as bytes
--     from public.properties where deleted_at is null;
