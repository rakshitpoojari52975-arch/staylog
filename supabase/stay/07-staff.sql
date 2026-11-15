-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — phase 5: staff.
-- After 06-property-texts.sql. Safe to run twice. Changes no data but the
-- "Works at" column it fills from what is already there.
--
--   stay.staff.works_at       the properties a staff member works at, as the
--                             app edits them ("Works at"). stay.staff_properties
--                             follows it (a trigger), so everything that reads
--                             it — her calendar, the checkout-day rate, where a
--                             wage is charged — follows the app. Empty = every
--                             property, as before.
--   stay.staff_profile()      her page's header: her name, the business name,
--                             the owner's name, her properties with their
--                             check-in / check-out times. Fixed fields, no
--                             guests, no money.
--   stay.staff_mark_today_at  "I came in today" at one of her properties, for
--                             someone who works at more than one.
--   public.* wrappers         her page calls the public names, as before.
-- ─────────────────────────────────────────────────────────────────────────────

alter table stay.staff add column if not exists works_at text[] not null default '{}';

-- What staff_properties already says becomes works_at (once; then works_at leads).
update stay.staff s set works_at = sub.ids
from (select account_id, staff_id, array_agg(property_id order by property_id) ids
      from stay.staff_properties group by account_id, staff_id) sub
where s.account_id = sub.account_id and s.id = sub.staff_id and s.works_at = '{}';

-- works_at → staff_properties. A property id that is not the account's is
-- refused by the foreign key, so the change is refused as a whole.
create or replace function stay.staff_works_at() returns trigger
language plpgsql security definer set search_path = stay, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.works_at is not distinct from old.works_at then return null; end if;
  delete from stay.staff_properties
   where account_id = new.account_id and staff_id = new.id and not (property_id = any(new.works_at));
  insert into stay.staff_properties (account_id, staff_id, property_id)
  select new.account_id, new.id, p from unnest(new.works_at) p
  on conflict do nothing;
  return null;
end $$;
drop trigger if exists works_at on stay.staff;
create trigger works_at after insert or update of works_at on stay.staff
  for each row execute function stay.staff_works_at();

-- Her properties: the ones she works at, or every live one when none are set.
create or replace function stay.my_properties() returns table (id text, name text, checkin text, checkout text)
language sql security definer set search_path = stay, pg_temp stable as $$
  select p.id, p.name, to_char(p.checkin_time, 'FMHH12:MI AM'), to_char(p.checkout_time, 'FMHH12:MI AM')
  from stay.my_login() me
  join stay.properties p on p.account_id = me.account_id
  where me.account_id is not null and p.deleted_at is null
    and coalesce((p.legacy ->> 'placeholder')::boolean, false) = false
    and (not exists (select 1 from stay.staff_properties sp where sp.account_id = me.account_id and sp.staff_id = me.staff_id)
         or p.id in (select sp.property_id from stay.staff_properties sp where sp.account_id = me.account_id and sp.staff_id = me.staff_id))
  order by p.name
$$;

create or replace function stay.staff_profile() returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  select jsonb_build_object(
    'name',     me.display_name,
    'business', a.name,
    'owner',    coalesce(nullif(btrim(a.owner_name), ''),
                         (select m.display_name from stay.members m where m.account_id = me.account_id and m.role = 'owner'
                            and m.active and nullif(btrim(m.display_name), '') is not null order by m.created_at limit 1)),
    'properties', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'checkin', x.checkin, 'checkout', x.checkout))
                            from stay.my_properties() x), '[]'::jsonb))
  from stay.my_login() me join stay.accounts a on a.id = me.account_id
  where me.account_id is not null
$$;

-- "I came in today" at a property she works at (for the line's property and
-- her wage there). Not one of hers: refused. Already marked today: as before.
create or replace function stay.staff_mark_today_at(p_property text) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare me record; v_today date; v_at timestamptz;
begin
  select * into me from stay.my_login();
  if me.account_id is null then return jsonb_build_object('ok', false, 'reason', 'no_access'); end if;
  if p_property is null or not exists (select 1 from stay.my_properties() x where x.id = p_property) then
    return jsonb_build_object('ok', false, 'reason', 'not_your_property');
  end if;
  v_today := stay.account_today(me.account_id);
  insert into stay.attendance (account_id, id, staff_id, date, property_id, source)
  values (me.account_id, stay.attendance_id(me.staff_id, v_today), me.staff_id, v_today, p_property, 'staff')
  on conflict (account_id, id) do update
    set deleted_at  = null,
        property_id = case when stay.attendance.deleted_at is not null then excluded.property_id else stay.attendance.property_id end,
        marked_at   = case when stay.attendance.deleted_at is not null then now() else stay.attendance.marked_at end
  returning marked_at into v_at;
  return jsonb_build_object('ok', true, 'date', v_today, 'marked_at', v_at, 'property', p_property);
end $$;

-- Her page calls the public names (the cutover's wrappers live there too).
create or replace function public.staff_profile() returns jsonb language sql volatile as $w$ select stay.staff_profile() $w$;
create or replace function public.staff_mark_today_at(p_property text) returns jsonb language sql volatile as
  $w$ select stay.staff_mark_today_at(p_property) $w$;

do $g$
declare f text;
begin
  foreach f in array array['stay.staff_works_at()','stay.my_properties()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['stay.staff_profile()','stay.staff_mark_today_at(text)',
                           'public.staff_profile()','public.staff_mark_today_at(text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $g$;
-- my_properties is used inside the two above (security definer), and by
-- nobody directly.

select 'staff "Works at"' as "check",
       case when exists (select 1 from information_schema.columns where table_schema = 'stay' and table_name = 'staff'
                         and column_name = 'works_at') then 'ok' else 'PROBLEM — run this script again' end as result
union all
select 'her page: profile and marking at a property',
       case when to_regprocedure('public.staff_profile()') is not null and to_regprocedure('public.staff_mark_today_at(text)') is not null
            then 'ok' else 'PROBLEM — run this script again' end;
