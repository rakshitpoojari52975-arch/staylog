-- StayLog · every booking that came from the calendar import
-- ─────────────────────────────────────────────────────────────────────────────
-- Paste into the Supabase SQL editor to compare against Airbnb and the
-- Booking.com extranet. Read-only; changes nothing.
--
-- One row per booking, in date order:
--   how            imported — created from a feed ("Airbnb guest" until named)
--                  matched  — a booking you already had, which a feed also lists
--   feeds          which feeds list it now; "(gone)" = no longer in that feed
--   in_no_feed     no feed lists it any more: check whether it was cancelled
-- Bookings you deleted are left out (deleted_at is set; recoverable in SQL).
-- Only what this phone has synced is here: an imported stay appears after the
-- phone's next sync, not straight after the fetch.
-- ─────────────────────────────────────────────────────────────────────────────

select
  b.check_in,
  b.check_out,
  b.check_out - b.check_in                                    as nights,
  p.name                                                      as property,
  b.source,
  b.guest_name,
  b.status,
  case when b.id like 'ics\_%' then 'imported' else 'matched' end as how,
  string_agg(e.platform || case when e.gone_at is not null then ' (gone)' else '' end,
             ', ' order by e.platform)                        as feeds,
  bool_and(e.gone_at is not null)                             as in_no_feed,
  b.total_amount,
  b.id                                                        as booking_id
from public.bookings b
join public.ical_events e
  on e.imported_booking_id = b.id and e.owner_id = b.owner_id
left join public.properties p
  on p.id = b.property_id
where b.deleted_at is null
group by b.id, p.name
order by b.check_in, property;
