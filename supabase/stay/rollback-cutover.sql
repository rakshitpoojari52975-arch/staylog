-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — undo the switch to the new model (phase 3). Run in the SQL editor.
-- Safe to run twice; does nothing if the switch has not happened.
--
--   • the old tables get back exactly the write grants they had (saved at the
--     switch in stay.cutover_grants)
--   • her page's functions go back to the old ones (*_v58 → their names)
--   • her marks made since the switch are copied back to the old tables, so
--     the phone's old sync finds them (the wage lines are already on the phone)
--   • public.app_status says model = 'public' again. min_version stays at 62,
--     so a stale v61 copy still cannot sync; v62 works with either model.
--
-- Nothing in `stay` is deleted: switching again later finds it there. On the
-- phone, v62 sees the old model is back, writes everything it holds into its
-- old copy (changes made since the switch included) and syncs the old way.
-- Also re-point the notify webhooks back to public.attendance and
-- public.utensil_marks (Database → Webhooks) if you moved them.
-- ─────────────────────────────────────────────────────────────────────────────
do $undo$
declare f record; g record; v_acct uuid; v_owner uuid;
begin
  if coalesce((select model from public.app_status where id = 1), 'public') <> 'stay' then
    raise notice 'Not switched over: nothing to undo.';
    return;
  end if;
  select account_id into v_acct from public.app_status where id = 1;
  select migrated_from into v_owner from stay.accounts where id = v_acct;

  -- her page
  for f in select * from stay.her_functions() loop
    if to_regprocedure('public.' || f.name || '_v58()') is not null then
      execute format('drop function if exists public.%I()', f.name);
      execute format('alter function public.%I() rename to %I', f.name || '_v58', f.name);
      execute format('revoke all on function public.%I() from public, anon', f.name);
      execute format('grant execute on function public.%I() to authenticated', f.name);
    end if;
  end loop;

  -- the old tables' grants, as they were
  for g in select * from stay.cutover_grants loop
    if to_regclass('public.' || g.table_name) is null then continue; end if;
    if g.column_name = '' then
      execute format('grant %s on public.%I to %I', g.privilege, g.table_name, g.grantee);
    else
      execute format('grant %s (%I) on public.%I to %I', g.privilege, g.column_name, g.table_name, g.grantee);
    end if;
  end loop;
  delete from stay.cutover_grants;

  -- her marks since the switch, back where the old app looks
  if v_owner is not null then
    insert into public.attendance (id, owner_id, staff_id, date, marked_at, source, expense_id, created_at, updated_at, deleted_at)
    select a.id, v_owner, a.staff_id, a.date, a.marked_at, a.source, a.expense_id, a.created_at, a.updated_at, a.deleted_at
    from stay.attendance a
    where a.account_id = v_acct and exists (select 1 from public.staff s where s.id = a.staff_id)
    on conflict (id) do update set expense_id = coalesce(public.attendance.expense_id, excluded.expense_id),
      deleted_at = excluded.deleted_at;
    if to_regclass('public.utensil_marks') is not null then
      insert into public.utensil_marks (id, owner_id, staff_id, date, marked_at, source, expense_id, created_at, updated_at, deleted_at)
      select a.id, v_owner, a.staff_id, a.date, a.marked_at, a.source, a.expense_id, a.created_at, a.updated_at, a.deleted_at
      from stay.utensil_marks a
      where a.account_id = v_acct and exists (select 1 from public.staff s where s.id = a.staff_id)
      on conflict (id) do update set expense_id = coalesce(public.utensil_marks.expense_id, excluded.expense_id),
        deleted_at = excluded.deleted_at;
    end if;
  end if;

  update public.app_status set model = 'public', switched_at = null, updated_at = now() where id = 1;
  insert into stay.migration_log (account_id, step, detail) values (v_acct, 'rollback', null);
end $undo$;

select 'model' as "check", (select model from public.app_status where id = 1) as result
union all
select 'her page on the old functions', case when to_regprocedure('public.staff_mark_today_v58()') is null
  then 'ok' else 'PROBLEM — run this script again' end;
