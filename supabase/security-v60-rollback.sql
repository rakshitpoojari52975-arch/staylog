-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog v60 — undo security-v60.sql, only if it locked you out or broke a
-- sync. Run in the Supabase SQL editor. Safe to run twice. Changes no data.
--
-- Removes the "owners only" policies and the mark-id checks. Leaves
-- public.app_status and sync_status.device_id / device_name in place (they
-- change nothing on their own). The owner match inside staff_standing() stays:
-- it only ever narrows her page to his own account.
-- ─────────────────────────────────────────────────────────────────────────────
do $undo$
declare t text;
begin
  foreach t in array array['properties','bookings','staff','loans','loan_repayments','expenses','staff_access',
                           'attendance','utensil_marks','ical_feeds','ical_events',
                           'push_subscriptions','notification_prefs','sync_status','push_log','backups']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists "owners only" on public.%I', t);
    end if;
  end loop;
  alter table public.attendance drop constraint if exists attendance_id_matches;
  if to_regclass('public.utensil_marks') is not null then
    alter table public.utensil_marks drop constraint if exists utensil_marks_id_matches;
  end if;
end $undo$;

select count(*) as "owners only policies left (expect 0)" from pg_policies where policyname = 'owners only';
