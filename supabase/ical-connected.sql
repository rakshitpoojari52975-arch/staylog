-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — "<platform> is connected to <other platform>'s calendar", per feed.
--
-- Airbnb and Booking.com can be connected to each other, so each closes the
-- other's stays by itself. Airbnb's export link then leaves out the dates it
-- copied in (confirmed on the real feed), so the app's still-open check
-- (coverageGaps) would call every Booking.com stay "still open on Airbnb".
-- With this on for a feed, stays from the other platform are not checked
-- against it; direct stays still are.
--
-- The owner may change this setting and the link itself, never the record
-- the ical-sync function keeps (last_fetched_at, last_ok_at, last_error,
-- last_count): that is written with the service role, which bypasses grants.
--
-- Run in the Supabase SQL editor after ical.sql. Safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.ical_feeds add column if not exists connected boolean not null default false;

-- Column grants, not the table-wide UPDATE ical.sql gave. The app's link
-- upsert sets owner_id, property_id, platform and url (row-level security
-- still pins owner_id to the signed-in owner).
revoke update on public.ical_feeds from authenticated;
grant update (owner_id, property_id, platform, url, connected) on public.ical_feeds to authenticated;
