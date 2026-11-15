-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — the new model, part 3 of 3: who may see and change what.
-- After 02-functions.sql. Safe to run twice. Changes no data.
--
-- Access is by membership of the row's account:
--   owner    everything in the account
--   manager  only the properties assigned to them (stay.holds), and only what
--            their permissions allow (stay.can)
--   staff    never a base table: only the stay.staff_* functions
-- Every table has row-level security. Supabase's default grants (ALL,
-- TRUNCATE included) are taken back, then exactly what is used is granted.
-- Nothing a person uses deletes a business row: bookings are cancelled,
-- everything else is soft-deleted (deleted_at) and can be brought back. The
-- only DELETE grants are on links and devices: a manager's property, a staff
-- member's property, a push subscription, an old encrypted backup.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── nothing by default ───────────────────────────────────────────────────────
revoke all on all tables in schema stay from public, anon, authenticated;
revoke all on schema stay from public, anon;
grant usage on schema stay to authenticated;
alter default privileges in schema stay revoke all on tables from public, anon, authenticated;
alter default privileges in schema stay revoke all on functions from public, anon, authenticated;

-- The Edge Functions (service role) see everything and filter by account_id
-- themselves; row-level security does not apply to them.
do $svc$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema stay to service_role;
    grant all on all tables in schema stay to service_role;
    grant execute on all functions in schema stay to service_role;
  end if;
end $svc$;

do $rls$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'stay' loop
    execute format('alter table stay.%I enable row level security', t);
  end loop;
end $rls$;

-- A policy is (re)made by name, so a second run replaces rather than adds.
create or replace function stay._policy(p_table text, p_name text, p_sql text) returns void
language plpgsql as $$
begin
  execute format('drop policy if exists %I on stay.%I', p_name, p_table);
  execute format('create policy %I on stay.%I %s', p_name, p_table, p_sql);
end $$;

-- ── accounts and people ──────────────────────────────────────────────────────
select stay._policy('accounts', 'members read', 'for select using (stay.is_member(id) or stay.is_platform_admin())');
select stay._policy('accounts', 'owner edits',  'for update using (stay.is_owner(id)) with check (stay.is_owner(id))');
grant select on stay.accounts to authenticated;
grant update (name, time_zone, currency, pays_directly_sources, owner_name) on stay.accounts to authenticated;

select stay._policy('platform_admins', 'self', 'for select using (user_id = auth.uid())');
grant select on stay.platform_admins to authenticated;

select stay._policy('members', 'self or owner reads', 'for select using (user_id = auth.uid() or stay.is_owner(account_id))');
select stay._policy('members', 'owner adds',   'for insert with check (stay.is_owner(account_id))');
select stay._policy('members', 'owner edits',  'for update using (stay.is_owner(account_id)) with check (stay.is_owner(account_id))');
grant select, insert on stay.members to authenticated;
grant update (role, display_name, permissions, active) on stay.members to authenticated;

select stay._policy('member_properties', 'self or owner reads', 'for select using (user_id = auth.uid() or stay.is_owner(account_id))');
select stay._policy('member_properties', 'owner adds',    'for insert with check (stay.is_owner(account_id))');
select stay._policy('member_properties', 'owner removes', 'for delete using (stay.is_owner(account_id))');
grant select, insert, delete on stay.member_properties to authenticated;

select stay._policy('invites', 'owner', 'for all using (stay.is_owner(account_id)) with check (stay.is_owner(account_id))');
grant select, insert on stay.invites to authenticated;
grant update (expires_at) on stay.invites to authenticated;

-- ── properties ───────────────────────────────────────────────────────────────
select stay._policy('properties', 'holders read', 'for select using (stay.holds(account_id, id))');
select stay._policy('properties', 'owner adds',   'for insert with check (stay.is_owner(account_id))');
select stay._policy('properties', 'may edit',     'for update using (stay.holds(account_id, id) and stay.can(account_id, ''edit_properties''))
                                                   with check (stay.holds(account_id, id) and stay.can(account_id, ''edit_properties''))');
grant select, insert, update on stay.properties to authenticated;

-- ── bookings (guest details included: only for the property's holders) ─────
select stay._policy('bookings', 'holders read', 'for select using (stay.holds(account_id, property_id))');
select stay._policy('bookings', 'may add',      'for insert with check (stay.holds(account_id, property_id) and stay.can(account_id, ''edit_bookings''))');
select stay._policy('bookings', 'may edit',     'for update using (stay.holds(account_id, property_id) and (stay.can(account_id, ''edit_bookings'')
                                                   or stay.can(account_id, ''send_messages'') or stay.can(account_id, ''mark_paid'')))
                                                 with check (stay.holds(account_id, property_id) and (stay.can(account_id, ''edit_bookings'')
                                                   or stay.can(account_id, ''send_messages'') or stay.can(account_id, ''mark_paid'')))');
grant select, insert, update on stay.bookings to authenticated;

-- ── staff, loans ─────────────────────────────────────────────────────────────
do $staff$
declare t text;
begin
  foreach t in array array['staff','loans','loan_repayments'] loop
    perform stay._policy(t, 'staff managers', 'for all using (stay.can(account_id, ''manage_staff''))
                                               with check (stay.can(account_id, ''manage_staff''))');
    execute format('grant select, insert, update on stay.%I to authenticated', t);
  end loop;
end $staff$;
select stay._policy('staff_properties', 'staff managers', 'for all using (stay.can(account_id, ''manage_staff''))
                                                           with check (stay.can(account_id, ''manage_staff''))');
grant select, insert, delete on stay.staff_properties to authenticated;
select stay._policy('staff_logins', 'staff managers read', 'for select using (stay.can(account_id, ''manage_staff''))');
select stay._policy('staff_logins', 'owner edits', 'for update using (stay.is_owner(account_id)) with check (stay.is_owner(account_id))');
grant select on stay.staff_logins to authenticated;
grant update (active, display_name) on stay.staff_logins to authenticated;

-- ── expenses ─────────────────────────────────────────────────────────────────
-- An owner sees all. A manager: their properties' ordinary expenses (with
-- add_expenses or see_money); staff lines only with manage_staff; Shared
-- (no property) only with see_money.
select stay._policy('expenses', 'may read', 'for select using (
    stay.is_owner(account_id)
    or (staff_id is not null and stay.can(account_id, ''manage_staff''))
    or (staff_id is null and property_id is not null and stay.holds(account_id, property_id)
        and (stay.can(account_id, ''add_expenses'') or stay.can(account_id, ''see_money'')))
    or (staff_id is null and property_id is null and stay.can(account_id, ''see_money'')))');
select stay._policy('expenses', 'may add', 'for insert with check (
    stay.is_owner(account_id)
    or (staff_id is not null and stay.can(account_id, ''manage_staff''))
    or (staff_id is null and property_id is not null and stay.holds(account_id, property_id) and stay.can(account_id, ''add_expenses'')))');
select stay._policy('expenses', 'may edit', 'for update using (
    stay.is_owner(account_id)
    or (staff_id is not null and stay.can(account_id, ''manage_staff''))
    or (staff_id is null and property_id is not null and stay.holds(account_id, property_id) and stay.can(account_id, ''add_expenses'')))
  with check (
    stay.is_owner(account_id)
    or (staff_id is not null and stay.can(account_id, ''manage_staff''))
    or (staff_id is null and property_id is not null and stay.holds(account_id, property_id) and stay.can(account_id, ''add_expenses'')))');
grant select, insert, update on stay.expenses to authenticated;

-- ── her marks: written only by her functions; read by staff managers ────────
select stay._policy('attendance',    'staff managers read', 'for select using (stay.can(account_id, ''manage_staff''))');
select stay._policy('utensil_marks', 'staff managers read', 'for select using (stay.can(account_id, ''manage_staff''))');
grant select on stay.attendance, stay.utensil_marks to authenticated;

-- ── receipts: numbers only through stay.issue_receipt ───────────────────────
select stay._policy('receipt_series', 'owner reads', 'for select using (stay.is_owner(account_id))');
grant select on stay.receipt_series to authenticated;

-- ── calendar: links are owner-only secrets; events show to the holders ──────
select stay._policy('ical_feeds', 'owner', 'for all using (stay.is_owner(account_id)) with check (stay.is_owner(account_id))');
grant select, insert on stay.ical_feeds to authenticated;
grant update (property_id, platform, url, connected) on stay.ical_feeds to authenticated;
select stay._policy('ical_events', 'holders read', 'for select using (stay.holds(account_id, property_id))');
select stay._policy('ical_events', 'owner stamps', 'for update using (stay.is_owner(account_id)) with check (stay.is_owner(account_id))');
grant select on stay.ical_events to authenticated;
grant update (imported_booking_id) on stay.ical_events to authenticated;

-- ── each person's own: devices, alerts, inbox ────────────────────────────────
select stay._policy('push_subscriptions', 'own', 'for all using (user_id = auth.uid() and stay.is_member(account_id))
                                                  with check (user_id = auth.uid() and stay.is_member(account_id))');
grant select, insert, update, delete on stay.push_subscriptions to authenticated;
select stay._policy('notification_prefs', 'own', 'for all using (user_id = auth.uid() and stay.is_member(account_id))
                                                  with check (user_id = auth.uid() and stay.is_member(account_id))');
grant select, insert, update on stay.notification_prefs to authenticated;
select stay._policy('push_log', 'own inbox', 'for select using (recipient = auth.uid() and stay.is_member(account_id))');
select stay._policy('push_log', 'marks read', 'for update using (recipient = auth.uid() and stay.is_member(account_id))
                                               with check (recipient = auth.uid() and stay.is_member(account_id))');
grant select on stay.push_log to authenticated;
grant update (read_at) on stay.push_log to authenticated;
select stay._policy('sync_status', 'own device', 'for all using ((user_id = auth.uid() and stay.is_member(account_id)) or stay.is_owner(account_id))
                                                  with check (user_id = auth.uid() and stay.is_member(account_id))');
grant select, insert, update on stay.sync_status to authenticated;

-- ── encrypted backups: the owner's ───────────────────────────────────────────
select stay._policy('backups', 'owner', 'for all using (stay.is_owner(account_id)) with check (stay.is_owner(account_id))');
grant select, insert, delete on stay.backups to authenticated;

drop function stay._policy(text, text, text);
