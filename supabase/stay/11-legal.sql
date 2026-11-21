-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — stage 1 of billing and data protection (v73): legal pages and
-- what people accepted.
-- After 10-onboarding.sql. Safe to run twice. Changes no business data.
--
--   stay.legal_versions      the current version of each document (the pages
--                            on the website carry the same version):
--                            terms, privacy, refund, staff_notice
--   stay.legal_acceptances   who accepted which version, when, and how
--                            ('signup' through an invite, 'app' when asked in
--                            the app). Kept; never edited.
--   stay.legal_pending()     the documents this login has not accepted in
--                            their current version (Terms and Privacy Policy)
--   stay.accept_legal(docs)  records the current versions for this login
--   staff_logins.notice_*    the staff page's one-time notice: which version
--                            she acknowledged, and when
--   stay.staff_notice() / stay.staff_ack_notice(version), and public wrappers
--                            for her page
-- To publish a new version of a page: change its version here and on the page
-- in the same release; everyone is asked again.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists stay.legal_versions (
  document     text primary key check (document in ('terms','privacy','refund','staff_notice')),
  version      text not null,
  published_at timestamptz not null default now()
);
insert into stay.legal_versions (document, version) values
  ('terms', '2026-11-21'), ('privacy', '2026-11-21'), ('refund', '2026-11-21'), ('staff_notice', '2026-11-21')
on conflict (document) do update set version = excluded.version,
  published_at = case when stay.legal_versions.version = excluded.version then stay.legal_versions.published_at else now() end;

create table if not exists stay.legal_acceptances (
  user_id     uuid not null references auth.users on delete cascade,
  document    text not null,
  version     text not null,
  accepted_at timestamptz not null default now(),
  via         text not null default 'app' check (via in ('signup','app')),
  primary key (user_id, document, version)
);

alter table stay.legal_versions enable row level security;
alter table stay.legal_acceptances enable row level security;
drop policy if exists "anyone reads" on stay.legal_versions;
drop policy if exists "signed in reads" on stay.legal_versions;
create policy "signed in reads" on stay.legal_versions for select using (auth.uid() is not null);
drop policy if exists "own" on stay.legal_acceptances;
create policy "own" on stay.legal_acceptances for select using (user_id = auth.uid());
revoke all on stay.legal_versions, stay.legal_acceptances from anon, authenticated;
grant select on stay.legal_versions to authenticated;
grant select on stay.legal_acceptances to authenticated;      -- written only by the functions below

-- What this login still has to accept (Terms and Privacy Policy).
create or replace function stay.legal_pending() returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('document', v.document, 'version', v.version) order by v.document), '[]'::jsonb)
  from stay.legal_versions v
  where v.document in ('terms','privacy') and auth.uid() is not null
    and not exists (select 1 from stay.legal_acceptances a
                    where a.user_id = auth.uid() and a.document = v.document and a.version = v.version)
$$;

-- Records the current version of each named document for this login.
create or replace function stay.accept_legal(p_documents text[]) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  insert into stay.legal_acceptances (user_id, document, version, via)
  select auth.uid(), v.document, v.version, 'app' from stay.legal_versions v
  where v.document = any (p_documents) and v.document in ('terms','privacy','refund')
  on conflict do nothing;
  return stay.legal_pending();
end $$;

-- The staff page's notice: shown once per version, acknowledged by her.
alter table stay.staff_logins add column if not exists notice_version text;
alter table stay.staff_logins add column if not exists notice_acknowledged_at timestamptz;

create or replace function stay.staff_notice() returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  select jsonb_build_object(
    'version', (select version from stay.legal_versions where document = 'staff_notice'),
    'acknowledged', l.notice_version is not distinct from (select version from stay.legal_versions where document = 'staff_notice'),
    'acknowledged_at', l.notice_acknowledged_at)
  from stay.staff_logins l
  where l.user_id = auth.uid() and l.active
  limit 1
$$;

create or replace function stay.staff_ack_notice(p_version text) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare v_current text := (select version from stay.legal_versions where document = 'staff_notice');
begin
  if p_version is distinct from v_current then
    return jsonb_build_object('ok', false, 'reason', 'old_notice', 'version', v_current);
  end if;
  update stay.staff_logins set notice_version = v_current, notice_acknowledged_at = now()
  where user_id = auth.uid() and active;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_access'); end if;
  return jsonb_build_object('ok', true, 'version', v_current);
end $$;

create or replace function public.staff_notice() returns jsonb language sql volatile as $w$ select stay.staff_notice() $w$;
create or replace function public.staff_ack_notice(p_version text) returns jsonb language sql volatile as
  $w$ select stay.staff_ack_notice(p_version) $w$;

do $g$
declare f text;
begin
  foreach f in array array['stay.legal_pending()','stay.accept_legal(text[])','stay.staff_notice()','stay.staff_ack_notice(text)',
                           'public.staff_notice()','public.staff_ack_notice(text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on stay.legal_versions, stay.legal_acceptances to service_role;
  end if;
end $g$;
