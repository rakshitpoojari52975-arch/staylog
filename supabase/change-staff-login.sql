-- ─────────────────────────────────────────────────────────────────────────────
-- Change the house help's username and/or password
--
-- Her account is an ordinary Supabase auth user whose email address is made
-- up: the login screen turns what she types into "<username>@staff.raaya
-- vasyam.invalid". So changing her USERNAME means changing that email, and
-- changing her PASSWORD means changing the hash stored against it.
--
-- Two things to know before you run it:
--
--   * The username must be lower case. staff.js lower-cases whatever she
--     types before adding the domain, so an address stored with a capital
--     letter can never be matched and she would be locked out.
--
--   * Changing the password does NOT sign her out. Her phone holds a refresh
--     token that keeps working until it expires. Section 3 revokes it — run
--     that too if the point is to cut off access rather than just tidy up.
--
-- Run in the Supabase SQL editor (Project → SQL Editor → New query).
-- Edit the three values in the "settings" block, then run the sections you
-- need. Everything below is written so that running it twice is harmless.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Settings: change these three lines, nothing else ─────────────────────────
-- current_username : what she signs in with TODAY (no @, no domain)
-- new_username     : what she should sign in with FROM NOW ON, lower case.
--                    Leave it the same as current_username to change only the
--                    password.
-- new_password     : her new password. Leave as null to change only the
--                    username.
--
-- You will retype these in each section — SQL editor tabs do not share
-- variables, and a stray temp table is worse than a little repetition.

-- ── 0. Where the password hashing lives ─────────────────────────────────────
-- Section 2 calls extensions.crypt(). On a stock Supabase project that is
-- where pgcrypto sits, but check rather than find out halfway through:

select coalesce((select n.nspname from pg_extension e
                 join pg_namespace n on n.oid = e.extnamespace
                 where e.extname = 'pgcrypto'), 'NOT INSTALLED') as pgcrypto_lives_in;

-- 'extensions' → nothing to do, section 2 is correct as written.
-- 'public'     → change extensions.crypt / extensions.gen_salt in section 2
--                to public.crypt / public.gen_salt.
-- NOT INSTALLED→ run: create extension pgcrypto with schema extensions;


-- ── 1. Check you are pointing at the right account ───────────────────────────
-- Run this first. It should return exactly one row, and the display_name
-- should be the person you mean. If it returns nothing, the username in
-- 'current_username' is not the one on the account.
select u.id,
       u.email                as signs_in_as,
       a.display_name,
       a.active               as access_enabled,
       u.last_sign_in_at
from auth.users u
left join public.staff_access a on a.user_id = u.id
where u.email = lower('sunitha') || '@staff.raayavasyam.invalid';   -- current_username


-- ── 2. Make the change ───────────────────────────────────────────────────────
-- Both the username and the password in one statement. Set either half to
-- null to leave it alone:
--   new_username = null  → password only
--   new_password = null  → username only
--
-- auth.identities is updated alongside auth.users because sign-in looks the
-- account up through it. Changing one and not the other leaves an account
-- that exists but cannot be signed into.

with settings as (
  select
    lower('sunitha')  as current_username,   -- ← what she uses today
    lower('sunitha')  as new_username,       -- ← what she should use (or null)
    'NewPasswordHere' as new_password,       -- ← her new password  (or null)
    'staff.raayavasyam.invalid' as domain
),
target as (
  select u.id, s.*
  from auth.users u
  cross join settings s
  where u.email = s.current_username || '@' || s.domain
),
touch_identity as (
  update auth.identities i
     set identity_data = jsonb_set(i.identity_data, '{email}',
                           to_jsonb(t.new_username || '@' || t.domain)),
         updated_at = now()
    from target t
   where i.user_id = t.id
     and t.new_username is not null
  returning i.user_id
)
update auth.users u
   set email = case when t.new_username is not null
                    then t.new_username || '@' || t.domain
                    else u.email end,
       encrypted_password = case when t.new_password is not null
                    then extensions.crypt(t.new_password, extensions.gen_salt('bf'))
                    else u.encrypted_password end,
       email_confirmed_at = coalesce(u.email_confirmed_at, now()),
       updated_at = now()
  from target t
 where u.id = t.id
returning u.id,
          u.email as now_signs_in_as,
          (t.new_password is not null) as password_changed;

-- One row back means it worked. Zero rows means the current_username did not
-- match any account — go back to section 1.


-- ── 3. Sign her out of the phone she is already on ───────────────────────────
-- Only needed if the password change is meant to end her current access.
-- Skip it if you are simply resetting a password she has forgotten.

delete from auth.refresh_tokens
 where user_id = (select id from auth.users
                   where email = lower('sunitha') || '@staff.raayavasyam.invalid');
                                 -- ↑ the NEW username, if you changed it


-- ── 4. Confirm ───────────────────────────────────────────────────────────────
-- Re-run section 1 with the NEW username. It should return the same account
-- id as before, with the new address and her display_name intact.
--
-- Then sign in as her on her page once yourself, with the new username and
-- password, before handing them over.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Notes ────────────────────────────────────────────────────────────────────
--
-- Her display name is separate. It lives in public.staff_access and is what
-- her page greets her with; it has nothing to do with signing in:
--
--   update public.staff_access set display_name = 'Sunitha'
--    where user_id = (select id from auth.users
--                      where email = 'sunitha@staff.raayavasyam.invalid');
--
-- To suspend her without touching her password, which is reversible and
-- leaves the account intact:
--
--   update public.staff_access set active = false where display_name = 'Sunitha';
--
-- The password can also be changed from the dashboard: Authentication →
-- Users → the ⋯ at the end of her row. Do not use "Send password recovery"
-- — .invalid is a reserved domain that goes nowhere by design, so the mail
-- is never delivered. The username cannot be changed there without also
-- updating auth.identities, which is why section 2 exists.
-- ─────────────────────────────────────────────────────────────────────────────
