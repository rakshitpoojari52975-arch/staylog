-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — remove the `stay` schema again (undo phase 1).
--
-- Only while it holds no data: it refuses if any account has been opened in
-- it (the migration, phase 3, opens yours). The old public tables are not
-- touched. After it, also remove `stay` from Project Settings → Data API →
-- Exposed schemas. Safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────
do $undo$
begin
  if to_regclass('stay.accounts') is not null then
    if exists (select 1 from stay.accounts) then
      raise exception 'The stay schema already holds an account; it is not removed. Nothing was changed.';
    end if;
  end if;
  drop schema if exists stay cascade;
end $undo$;
