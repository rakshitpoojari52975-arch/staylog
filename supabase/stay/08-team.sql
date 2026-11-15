-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — phase 6: the team (managers).
-- After 07-staff.sql. Safe to run twice. Changes no data.
--
-- An owner invites a manager with a link (the app's Team screen): the invite
-- names the properties the manager will hold and the permissions they get.
-- The manager opens the link, makes their login (or signs in with one they
-- have) and joins — through the team-invite Edge Function, which checks the
-- invite again and uses it once. Row-level security (03-access.sql) already
-- limits a manager to their properties and permissions; this adds:
--   stay.invites.label        who the invite is for ("Priya"), for the list
--   invites: managers only    an owner's invite can only make a manager (new
--                             owners join only by a platform invite)
--   stay.my_access(acct)      what the signed-in person may do there: role,
--                             each permission as stay.can() decides it, and
--                             the properties a manager holds (null = all)
--   stay.team(acct)           the owner's Team screen: members with their
--                             sign-in email, properties and permissions, and
--                             the invites still open
-- ─────────────────────────────────────────────────────────────────────────────

alter table stay.invites add column if not exists label text;

-- The owner's invites: read, add (managers only), withdraw (expires_at).
drop policy if exists "owner" on stay.invites;
drop policy if exists "owner reads" on stay.invites;
drop policy if exists "owner invites managers" on stay.invites;
drop policy if exists "owner withdraws" on stay.invites;
create policy "owner reads" on stay.invites for select using (stay.is_owner(account_id));
create policy "owner invites managers" on stay.invites for insert
  with check (stay.is_owner(account_id) and role = 'manager' and used_by is null);
create policy "owner withdraws" on stay.invites for update using (stay.is_owner(account_id)) with check (stay.is_owner(account_id));
revoke all on stay.invites from anon, authenticated;
grant select, insert on stay.invites to authenticated;
grant update (expires_at) on stay.invites to authenticated;

create or replace function stay.my_access(p_account uuid) returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  select case when stay.role_in(p_account) is null then null else jsonb_build_object(
    'role', stay.role_in(p_account),
    'permissions', (select jsonb_object_agg(p, stay.can(p_account, p))
                    from unnest(array['edit_bookings','send_messages','mark_paid','see_money','add_expenses',
                                      'manage_staff','edit_properties','manage_calendar']) p),
    'properties', case when stay.role_in(p_account) = 'owner' then null
                       else coalesce((select jsonb_agg(mp.property_id order by mp.property_id) from stay.member_properties mp
                                      where mp.account_id = p_account and mp.user_id = auth.uid()), '[]'::jsonb) end)
  end
$$;

create or replace function stay.team(p_account uuid) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp stable as $$
begin
  if not stay.is_owner(p_account) then raise exception 'Only the owner sees the team'; end if;
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'role', m.role, 'name', m.display_name, 'email', u.email, 'active', m.active,
        'permissions', m.permissions, 'me', m.user_id = auth.uid(),
        'properties', coalesce((select jsonb_agg(mp.property_id order by mp.property_id) from stay.member_properties mp
                                where mp.account_id = m.account_id and mp.user_id = m.user_id), '[]'::jsonb))
        order by (m.role <> 'owner'), m.created_at)
      from stay.members m left join auth.users u on u.id = m.user_id where m.account_id = p_account), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object(
        'code', i.code, 'label', i.label, 'role', i.role, 'property_ids', i.property_ids, 'permissions', i.permissions,
        'created_at', i.created_at, 'expires_at', i.expires_at) order by i.created_at desc)
      from stay.invites i where i.account_id = p_account and i.used_by is null and i.expires_at > now()), '[]'::jsonb));
end $$;

do $g$
declare f text;
begin
  foreach f in array array['stay.my_access(uuid)','stay.team(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $g$;

select 'the team (08-team.sql)' as "check",
       case when to_regprocedure('stay.team(uuid)') is not null and to_regprocedure('stay.my_access(uuid)') is not null
                 and exists (select 1 from pg_policies where schemaname = 'stay' and tablename = 'invites' and policyname = 'owner invites managers')
            then 'ok' else 'PROBLEM — run this script again' end as result;
