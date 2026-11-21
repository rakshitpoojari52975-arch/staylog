-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — stage 3 of billing and data protection (v75): paying with Razorpay.
-- After 12-plans.sql. Safe to run twice. Changes no business data, and never
-- touches an account on plan 'owner' (Raaya Vasyam).
--
--   stay.plans               what can be bought: plan (starter / pro), period
--                            (monthly / yearly), price in paise, the Razorpay
--                            plan id, properties allowed, on sale or not.
--                            Edited only from the admin screen (audited).
--   stay.platform_settings   one row: sales open?, GST on?, the rate, the
--                            seller's name, address, GSTIN and SAC code, the
--                            invoice prefix. GST stays off until Rakshit says.
--   stay.billing_events      every Razorpay webhook, once (its event id is the
--                            key), with what it did. Append-only.
--   stay.invoices            one per payment taken, numbered per Indian
--                            financial year (SL/2026-27/0001), with the seller
--                            and buyer as they stood. Append-only.
--   stay.trial_fingerprints  keyed hashes (never the email itself) so one
--                            business gets one free trial. Kept after an
--                            account is deleted (the Privacy Policy says so).
--   accounts                 + gstin (the owner may set it), the subscription
--                            on order (pending), cancel_at_period_end, the
--                            plan bought, the time of the last event applied,
--                            trial_repeat_of (a fingerprint seen before).
--
-- Who calls what: the `billing` Edge Function (service key) calls
-- billing_prepare / billing_pending / billing_cancelling / billing_record /
-- billing_sweep / trial_fingerprint. The app reads billing_state, plans,
-- platform_settings and invoices. The admin screen calls admin_save_plan,
-- admin_save_settings, admin_billing.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── What can be bought ───────────────────────────────────────────────────────
create table if not exists stay.plans (
  id                 text primary key,                        -- 'starter_monthly' …
  plan               text not null check (plan in ('starter','pro')),
  period             text not null check (period in ('monthly','yearly')),
  amount_paise       integer check (amount_paise is null or amount_paise > 0),
  currency           text not null default 'INR',
  razorpay_plan_id   text,
  properties_allowed integer not null check (properties_allowed > 0),
  active             boolean not null default false,
  sort               integer not null default 0,
  updated_at         timestamptz not null default now()
);
-- Not on sale until Rakshit sets a price and a Razorpay plan id and ticks it.
insert into stay.plans (id, plan, period, properties_allowed, sort) values
  ('starter_monthly','starter','monthly',1,1), ('starter_yearly','starter','yearly',1,2),
  ('pro_monthly','pro','monthly',5,3), ('pro_yearly','pro','yearly',5,4)
on conflict (id) do nothing;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'plans_on_sale_check' and conrelid = 'stay.plans'::regclass) then
    alter table stay.plans add constraint plans_on_sale_check
      check (not active or (amount_paise is not null and coalesce(razorpay_plan_id, '') <> ''));
  end if;
end $c$;

create table if not exists stay.platform_settings (
  id             integer primary key default 1 check (id = 1),
  billing_open   boolean not null default false,              -- Subscribe shown in the app
  gst_enabled    boolean not null default false,              -- off until Rakshit says (his CA)
  gst_rate       numeric(5,2) not null default 18 check (gst_rate >= 0 and gst_rate <= 28),
  seller_name    text not null default 'Rakshit Poojari',
  seller_address text not null default '1331, 3rd floor, Sector 37, Faridabad - 121003',
  seller_gstin   text check (seller_gstin is null or seller_gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  sac_code       text,
  invoice_prefix text not null default 'SL' check (invoice_prefix ~ '^[A-Z0-9]{1,6}$'),
  updated_at     timestamptz not null default now()
);
insert into stay.platform_settings (id) values (1) on conflict (id) do nothing;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_gst_needs_gstin' and conrelid = 'stay.platform_settings'::regclass) then
    alter table stay.platform_settings add constraint settings_gst_needs_gstin
      check (not gst_enabled or seller_gstin is not null);
  end if;
end $c$;

-- ── The account's side ───────────────────────────────────────────────────────
alter table stay.accounts add column if not exists gstin                   text;
alter table stay.accounts add column if not exists subscription_plan_id    text;   -- stay.plans.id bought
alter table stay.accounts add column if not exists pending_subscription_id text;   -- ordered, not yet paid
alter table stay.accounts add column if not exists pending_at              timestamptz;
alter table stay.accounts add column if not exists cancel_at_period_end    boolean not null default false;
alter table stay.accounts add column if not exists billing_event_at        timestamptz;
alter table stay.accounts add column if not exists trial_repeat_of         uuid;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_gstin_check' and conrelid = 'stay.accounts'::regclass) then
    alter table stay.accounts add constraint accounts_gstin_check check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$');
  end if;
end $c$;
-- The owner may set the GSTIN printed on their invoices (03's policy: owner only).
grant update (gstin) on stay.accounts to authenticated;

-- ── Razorpay's events, each once ─────────────────────────────────────────────
create table if not exists stay.billing_events (
  event_id    text primary key,
  account_id  uuid,
  event       text not null,
  payload     jsonb not null,
  result      text not null,
  received_at timestamptz not null default now()
);
drop trigger if exists append_only on stay.billing_events;
create trigger append_only before update or delete on stay.billing_events for each row execute function stay.no_edit();

-- ── Invoices ─────────────────────────────────────────────────────────────────
create table if not exists stay.invoices (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references stay.accounts on delete restrict,
  number              text not null unique,
  issued_at           timestamptz not null default now(),
  plan_id             text,
  description         text not null,
  period_start        timestamptz,
  period_end          timestamptz,
  amount_paise        integer not null,                       -- what was paid, tax included
  taxable_paise       integer not null,
  gst_paise           integer not null default 0,
  gst_rate            numeric(5,2) not null default 0,
  tax_invoice         boolean not null default false,         -- false = a receipt, not a tax invoice
  currency            text not null default 'INR',
  seller              jsonb not null,                         -- name, address, gstin, sac as they stood
  buyer               jsonb not null,                         -- business name, gstin
  razorpay_payment_id text unique,
  razorpay_invoice_id text,
  razorpay_subscription_id text
);
drop trigger if exists append_only on stay.invoices;
create trigger append_only before update or delete on stay.invoices for each row execute function stay.no_edit();
create index if not exists invoices_account on stay.invoices (account_id, issued_at desc);

create table if not exists stay.invoice_series (
  prefix text not null,
  fy     text not null,
  last   integer not null default 0,
  primary key (prefix, fy)
);

-- ── One trial per business ───────────────────────────────────────────────────
create table if not exists stay.trial_fingerprints (
  kind       text not null check (kind in ('email','airbnb_listing')),
  hash       text not null check (hash ~ '^[0-9a-f]{64}$'),
  account_id uuid not null,                                   -- no foreign key: kept after deletion
  created_at timestamptz not null default now(),
  primary key (kind, hash)
);

-- ── Access ───────────────────────────────────────────────────────────────────
alter table stay.plans enable row level security;
alter table stay.platform_settings enable row level security;
alter table stay.billing_events enable row level security;
alter table stay.invoices enable row level security;
alter table stay.invoice_series enable row level security;
alter table stay.trial_fingerprints enable row level security;
drop policy if exists "signed in reads" on stay.plans;
create policy "signed in reads" on stay.plans for select using (auth.uid() is not null and (active or stay.is_platform_admin()));
drop policy if exists "signed in reads" on stay.platform_settings;
create policy "signed in reads" on stay.platform_settings for select using (auth.uid() is not null);
drop policy if exists "admins read" on stay.billing_events;
create policy "admins read" on stay.billing_events for select using (stay.is_platform_admin());
drop policy if exists "owner reads" on stay.invoices;
create policy "owner reads" on stay.invoices for select using (stay.is_owner(account_id) or stay.is_platform_admin());
revoke all on stay.plans, stay.platform_settings, stay.billing_events, stay.invoices, stay.invoice_series,
  stay.trial_fingerprints from anon, authenticated;
grant select on stay.plans, stay.platform_settings, stay.billing_events, stay.invoices to authenticated;

-- ── Helpers ──────────────────────────────────────────────────────────────────
create or replace function stay.financial_year_of(p_at timestamptz) returns text
language sql immutable as $$
  select case when extract(month from (p_at at time zone 'Asia/Kolkata')) >= 4
    then extract(year from (p_at at time zone 'Asia/Kolkata'))::int || '-' || lpad(((extract(year from (p_at at time zone 'Asia/Kolkata'))::int + 1) % 100)::text, 2, '0')
    else (extract(year from (p_at at time zone 'Asia/Kolkata'))::int - 1) || '-' || lpad((extract(year from (p_at at time zone 'Asia/Kolkata'))::int % 100)::text, 2, '0') end
$$;

create or replace function stay.ts_of(p_unix text) returns timestamptz
language sql immutable as $$ select case when p_unix ~ '^[0-9]+$' then to_timestamp(p_unix::bigint) end $$;

-- An invoice for one payment (once per payment id). GST, when on, is inside
-- the amount paid (prices are shown tax included).
create or replace function stay.make_invoice(p_account uuid, p_plan text, p_sub jsonb, p_pay jsonb) returns text
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare s stay.platform_settings; a stay.accounts; pl stay.plans; v_fy text; v_n integer; v_no text;
        v_amount integer := nullif(p_pay ->> 'amount', '')::integer; v_taxable integer;
begin
  if v_amount is null or v_amount <= 0 or coalesce(p_pay ->> 'id', '') = '' then return null; end if;
  if exists (select 1 from stay.invoices where razorpay_payment_id = p_pay ->> 'id') then
    return (select number from stay.invoices where razorpay_payment_id = p_pay ->> 'id');
  end if;
  select * into s from stay.platform_settings where id = 1;
  select * into a from stay.accounts where id = p_account;
  select * into pl from stay.plans where id = p_plan;
  v_fy := stay.financial_year_of(now());
  insert into stay.invoice_series (prefix, fy, last) values (s.invoice_prefix, v_fy, 1)
  on conflict (prefix, fy) do update set last = stay.invoice_series.last + 1
  returning last into v_n;
  v_no := s.invoice_prefix || '/' || v_fy || '/' || lpad(v_n::text, 4, '0');
  v_taxable := case when s.gst_enabled then round(v_amount * 100.0 / (100 + s.gst_rate))::integer else v_amount end;
  insert into stay.invoices (account_id, number, plan_id, description, period_start, period_end, amount_paise, taxable_paise,
    gst_paise, gst_rate, tax_invoice, currency, seller, buyer, razorpay_payment_id, razorpay_invoice_id, razorpay_subscription_id)
  values (p_account, v_no, p_plan,
    'StayLog ' || initcap(coalesce(pl.plan, 'plan')) || ' — ' || coalesce(pl.period, '') || ' subscription',
    stay.ts_of(p_sub ->> 'current_start'), stay.ts_of(p_sub ->> 'current_end'),
    v_amount, v_taxable, v_amount - v_taxable, case when s.gst_enabled then s.gst_rate else 0 end, s.gst_enabled,
    coalesce(p_pay ->> 'currency', 'INR'),
    jsonb_build_object('name', s.seller_name, 'address', s.seller_address, 'gstin', s.seller_gstin, 'sac', s.sac_code),
    jsonb_build_object('name', a.name, 'gstin', a.gstin),
    p_pay ->> 'id', nullif(p_pay ->> 'invoice_id', ''), nullif(p_sub ->> 'id', ''));
  return v_no;
end $$;

-- ── What one Razorpay event does ─────────────────────────────────────────────
-- Returns {result, account, cancel_subscription?}. Never changes plan 'owner'.
--   authenticated                → the subscription is on order
--   activated / charged / resumed → active, paid until current_end, the plan's
--                                   properties (rule B fits them); charged
--                                   with a payment → an invoice
--   pending / halted             → payment due, 3 days' grace (kept, not reset)
--   cancelled / completed / paused → ends at the period's end (read-only then)
-- An older event than the last one applied changes nothing (charged still
-- records its invoice). A second subscription activating while one is live
-- is answered with cancel_subscription, so nobody pays twice.
create or replace function stay.billing_apply(p jsonb) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare
  ev   text := p ->> 'event';
  sub  jsonb := p #> '{payload,subscription,entity}';
  pay  jsonb := p #> '{payload,payment,entity}';
  sid  text := sub ->> 'id';
  at   timestamptz := coalesce(stay.ts_of(p ->> 'created_at'), now());
  acct uuid; a stay.accounts; pl stay.plans; v_inv text; v_end timestamptz;
begin
  if sub is null or coalesce(sid, '') = '' then return jsonb_build_object('result', 'not a subscription event'); end if;
  begin acct := nullif(sub #>> '{notes,account_id}', '')::uuid; exception when others then acct := null; end;
  if acct is null then
    select id into acct from stay.accounts where razorpay_subscription_id = sid or pending_subscription_id = sid limit 1;
  end if;
  if acct is null then return jsonb_build_object('result', 'unknown account'); end if;
  select * into a from stay.accounts where id = acct for update;
  if not found then return jsonb_build_object('result', 'unknown account'); end if;
  if a.plan = 'owner' then return jsonb_build_object('result', 'owner plan untouched', 'account', acct); end if;
  select * into pl from stay.plans where razorpay_plan_id = sub ->> 'plan_id' limit 1;

  -- an event of a subscription that is not this account's live or ordered one
  if sid is distinct from a.razorpay_subscription_id and sid is distinct from a.pending_subscription_id then
    if ev in ('subscription.activated','subscription.charged','subscription.authenticated')
       and a.razorpay_subscription_id is not null and a.status = 'active' and not a.cancel_at_period_end
       and a.current_period_end > now() then
      if ev = 'subscription.charged' and pl.id is not null then perform stay.make_invoice(acct, pl.id, sub, pay); end if;
      return jsonb_build_object('result', 'second subscription', 'account', acct, 'cancel_subscription', sid);
    end if;
    if ev not in ('subscription.activated','subscription.charged','subscription.authenticated','subscription.resumed') then
      return jsonb_build_object('result', 'old subscription ignored', 'account', acct);
    end if;
  end if;

  if ev = 'subscription.charged' and pl.id is not null then v_inv := stay.make_invoice(acct, pl.id, sub, pay); end if;
  if a.billing_event_at is not null and at < a.billing_event_at then
    return jsonb_build_object('result', 'older event', 'account', acct, 'invoice', v_inv);
  end if;

  if ev = 'subscription.authenticated' then
    update stay.accounts set pending_subscription_id = sid, pending_at = coalesce(pending_at, now()),
           razorpay_customer_id = coalesce(nullif(sub ->> 'customer_id', ''), razorpay_customer_id), billing_event_at = at
     where id = acct;
    return jsonb_build_object('result', 'on order', 'account', acct);
  elsif ev in ('subscription.activated','subscription.charged','subscription.resumed') then
    if pl.id is null then return jsonb_build_object('result', 'unknown plan', 'account', acct); end if;
    v_end := coalesce(stay.ts_of(sub ->> 'current_end'),
                      greatest(coalesce(a.current_period_end, now()), now()) + case pl.period when 'yearly' then interval '1 year' else interval '1 month' end);
    update stay.accounts set plan = pl.plan, subscription_plan_id = pl.id, status = 'active', current_period_end = v_end,
           grace_ends_at = null, inactive_since = null, cancel_at_period_end = false,
           properties_allowed = pl.properties_allowed, razorpay_subscription_id = sid,
           razorpay_customer_id = coalesce(nullif(sub ->> 'customer_id', ''), razorpay_customer_id),
           pending_subscription_id = case when pending_subscription_id = sid then null else pending_subscription_id end,
           pending_at = case when pending_subscription_id = sid then null else pending_at end,
           billing_event_at = at
     where id = acct;
    perform stay.fit_properties(acct);
    return jsonb_build_object('result', 'active', 'account', acct, 'until', v_end, 'invoice', v_inv);
  elsif ev in ('subscription.pending','subscription.halted') then
    update stay.accounts set status = 'past_due', razorpay_subscription_id = sid,
           grace_ends_at = case when status = 'past_due' and grace_ends_at is not null then grace_ends_at
                                else greatest(coalesce(current_period_end, now()), now()) + interval '3 days' end,
           billing_event_at = at
     where id = acct;
    return jsonb_build_object('result', 'payment due', 'account', acct);
  elsif ev in ('subscription.cancelled','subscription.completed','subscription.paused') then
    update stay.accounts set
           cancel_at_period_end = (current_period_end is not null and current_period_end > now()),
           status = case when current_period_end is not null and current_period_end > now() then status else 'cancelled' end,
           inactive_since = case when current_period_end is not null and current_period_end > now() then inactive_since
                                 else coalesce(inactive_since, now()) end,
           grace_ends_at = null, billing_event_at = at
     where id = acct and razorpay_subscription_id = sid;
    update stay.accounts set pending_subscription_id = null, pending_at = null where id = acct and pending_subscription_id = sid;
    return jsonb_build_object('result', 'ends at period end', 'account', acct);
  end if;
  return jsonb_build_object('result', 'ignored', 'account', acct);
end $$;

-- The webhook's one call: keep the event once, then apply it, in one
-- transaction. A repeat delivery changes nothing.
create or replace function stay.billing_record(p_event_id text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare r jsonb;
begin
  if coalesce(p_event_id, '') = '' then raise exception 'event id needed'; end if;
  perform pg_advisory_xact_lock(hashtext('billing:' || p_event_id));   -- two deliveries at once: one applies
  if exists (select 1 from stay.billing_events where event_id = p_event_id) then
    return jsonb_build_object('result', 'duplicate');
  end if;
  r := stay.billing_apply(p_payload);
  insert into stay.billing_events (event_id, account_id, event, payload, result)
  values (p_event_id, nullif(r ->> 'account', '')::uuid, coalesce(p_payload ->> 'event', '?'), p_payload, r ->> 'result')
  on conflict (event_id) do nothing;
  if not found then return jsonb_build_object('result', 'duplicate'); end if;
  return r;
end $$;

-- ── Ordering and cancelling (the function checks the caller first) ───────────
-- Who may buy: an active owner of an account that is not on plan owner, for a
-- plan on sale, while sales are open (platform admins may test before).
create or replace function stay.billing_prepare(p_account uuid, p_user uuid, p_plan text) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp stable as $$
declare a stay.accounts; pl stay.plans; s stay.platform_settings;
begin
  if not exists (select 1 from stay.members where account_id = p_account and user_id = p_user and role = 'owner' and active) then
    return jsonb_build_object('error', 'Only the owner can change the plan.');
  end if;
  select * into a from stay.accounts where id = p_account;
  if a.plan = 'owner' then return jsonb_build_object('error', 'This account has no billing.'); end if;
  select * into s from stay.platform_settings where id = 1;
  if not s.billing_open and not exists (select 1 from stay.platform_admins where user_id = p_user) then
    return jsonb_build_object('error', 'Paid plans are not open yet.');
  end if;
  if p_plan is null then   -- cancelling: the live subscription
    return jsonb_build_object('subscription', a.razorpay_subscription_id, 'status', a.status,
                              'cancel_at_period_end', a.cancel_at_period_end, 'current_period_end', a.current_period_end);
  end if;
  select * into pl from stay.plans where id = p_plan and active;
  if not found then return jsonb_build_object('error', 'That plan is not on sale.'); end if;
  if a.status = 'active' and not a.cancel_at_period_end and a.current_period_end > now() and a.razorpay_subscription_id is not null then
    return jsonb_build_object('error', 'You already have a plan. To change it, cancel this one first — it runs to the end of what you paid for.');
  end if;
  return jsonb_build_object('razorpay_plan_id', pl.razorpay_plan_id, 'period', pl.period, 'plan', pl.plan,
                            'amount_paise', pl.amount_paise, 'business', a.name);
end $$;

create or replace function stay.billing_pending(p_account uuid, p_subscription text) returns void
language sql security definer set search_path = stay, pg_temp as $$
  update stay.accounts set pending_subscription_id = p_subscription, pending_at = now() where id = p_account and plan <> 'owner'
$$;

create or replace function stay.billing_cancelling(p_account uuid) returns void
language sql security definer set search_path = stay, pg_temp as $$
  update stay.accounts set cancel_at_period_end = true where id = p_account and plan <> 'owner' and status = 'active'
$$;

-- Daily: statuses catch up with the clock (writing is already refused by the
-- dates; this keeps status and inactive_since true for the app, the admin
-- screen and retention later). A paid period that ran out with no renewal
-- heard of gets the 3 days' grace, not an end.
create or replace function stay.billing_sweep() returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare n_trial int; n_cancel int; n_due int; n_exp int;
begin
  update stay.accounts set status = 'expired', inactive_since = coalesce(inactive_since, trial_ends_at)
   where plan <> 'owner' and status = 'trialing' and trial_ends_at <= now();
  get diagnostics n_trial = row_count;
  update stay.accounts set status = 'cancelled', inactive_since = coalesce(inactive_since, current_period_end)
   where plan <> 'owner' and status = 'active' and cancel_at_period_end and current_period_end <= now();
  get diagnostics n_cancel = row_count;
  update stay.accounts set status = 'past_due', grace_ends_at = current_period_end + interval '3 days'
   where plan <> 'owner' and status = 'active' and not cancel_at_period_end and current_period_end <= now();
  get diagnostics n_due = row_count;
  update stay.accounts set status = 'expired', inactive_since = coalesce(inactive_since, grace_ends_at)
   where plan <> 'owner' and status = 'past_due' and grace_ends_at <= now();
  get diagnostics n_exp = row_count;
  return jsonb_build_object('trials_ended', n_trial, 'cancelled', n_cancel, 'payment_due', n_due, 'expired', n_exp);
end $$;

-- ── One trial per business ───────────────────────────────────────────────────
-- An email seen before (another account): the new account starts without a
-- free trial (read-only until it subscribes, or the admin extends it). An
-- Airbnb listing seen before: flagged for the admin only.
create or replace function stay.trial_fingerprint(p_account uuid, p_kind text, p_hashes text[]) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare h text; v_other uuid; v_repeat uuid;
begin
  foreach h in array coalesce(p_hashes, '{}') loop
    select account_id into v_other from stay.trial_fingerprints where kind = p_kind and hash = h;
    if v_other is null then
      insert into stay.trial_fingerprints (kind, hash, account_id) values (p_kind, h, p_account) on conflict do nothing;
    elsif v_other <> p_account then
      v_repeat := coalesce(v_repeat, v_other);
    end if;
  end loop;
  if v_repeat is not null then
    update stay.accounts set trial_repeat_of = coalesce(trial_repeat_of, v_repeat) where id = p_account and plan <> 'owner';
    if p_kind = 'email' then
      update stay.accounts set trial_ends_at = least(trial_ends_at, now())
       where id = p_account and plan = 'trial' and status = 'trialing';
      return jsonb_build_object('repeat', true, 'trial', false);
    end if;
    return jsonb_build_object('repeat', true);
  end if;
  return jsonb_build_object('repeat', false);
end $$;

-- ── What the app shows ───────────────────────────────────────────────────────
create or replace function stay.billing_state(p_account uuid) returns jsonb
language sql security definer set search_path = stay, pg_temp stable as $$
  select case when not stay.is_owner(p_account) then null else jsonb_build_object(
    'open', (select billing_open from stay.platform_settings where id = 1),
    'subscription_plan', a.subscription_plan_id,
    'has_subscription', a.razorpay_subscription_id is not null,
    'cancel_at_period_end', a.cancel_at_period_end,
    'pending', a.pending_subscription_id is not null and a.pending_at > now() - interval '1 day',
    'gstin', a.gstin,
    'repeat_trial', a.trial_repeat_of is not null)
  end
  from stay.accounts a where a.id = p_account
$$;

-- ── The admin screen ─────────────────────────────────────────────────────────
create or replace function stay.admin_save_plan(p_id text, p_amount_paise integer, p_razorpay_plan_id text,
                                                p_properties integer, p_active boolean) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare old stay.plans;
begin
  if not stay.is_platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
  select * into old from stay.plans where id = p_id for update;
  if not found then raise exception 'No such plan'; end if;
  update stay.plans set amount_paise = p_amount_paise, razorpay_plan_id = nullif(trim(p_razorpay_plan_id), ''),
         properties_allowed = p_properties, active = p_active, updated_at = now() where id = p_id;
  perform stay.admin_log(null, 'save_plan', jsonb_build_object('plan', p_id, 'amount_paise', p_amount_paise,
    'razorpay_plan_id', p_razorpay_plan_id, 'properties', p_properties, 'active', p_active,
    'was', jsonb_build_object('amount_paise', old.amount_paise, 'razorpay_plan_id', old.razorpay_plan_id, 'active', old.active)));
  return (select to_jsonb(x) from stay.plans x where id = p_id);
end $$;

create or replace function stay.admin_save_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = stay, pg_temp volatile as $$
declare old stay.platform_settings;
begin
  if not stay.is_platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
  select * into old from stay.platform_settings where id = 1 for update;
  update stay.platform_settings set
    billing_open   = coalesce((p ->> 'billing_open')::boolean, billing_open),
    gst_enabled    = coalesce((p ->> 'gst_enabled')::boolean, gst_enabled),
    gst_rate       = coalesce((p ->> 'gst_rate')::numeric, gst_rate),
    seller_name    = coalesce(nullif(trim(p ->> 'seller_name'), ''), seller_name),
    seller_address = coalesce(nullif(trim(p ->> 'seller_address'), ''), seller_address),
    seller_gstin   = case when p ? 'seller_gstin' then nullif(upper(trim(p ->> 'seller_gstin')), '') else seller_gstin end,
    sac_code       = case when p ? 'sac_code' then nullif(trim(p ->> 'sac_code'), '') else sac_code end,
    invoice_prefix = coalesce(nullif(upper(trim(p ->> 'invoice_prefix')), ''), invoice_prefix),
    updated_at = now()
  where id = 1;
  perform stay.admin_log(null, 'save_settings', jsonb_build_object('set', p, 'was', to_jsonb(old)));
  return (select to_jsonb(x) from stay.platform_settings x where id = 1);
end $$;

-- Billing per account for the admin screen (beside admin_accounts): the plan
-- bought, cancelling, a repeat trial, invoices and the last event. No guest data.
create or replace function stay.admin_billing() returns jsonb
language plpgsql security definer set search_path = stay, pg_temp stable as $$
begin
  if not stay.is_platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
  return coalesce((select jsonb_object_agg(a.id, jsonb_build_object(
    'subscription_plan', a.subscription_plan_id, 'cancel_at_period_end', a.cancel_at_period_end,
    'has_subscription', a.razorpay_subscription_id is not null, 'repeat_trial', a.trial_repeat_of is not null,
    'repeat_of', (select b.name from stay.accounts b where b.id = a.trial_repeat_of),
    'invoices', (select count(*) from stay.invoices i where i.account_id = a.id),
    'paid_paise', (select coalesce(sum(amount_paise), 0) from stay.invoices i where i.account_id = a.id),
    'last_event', (select jsonb_build_object('event', e.event, 'result', e.result, 'at', e.received_at)
                   from stay.billing_events e where e.account_id = a.id order by e.received_at desc limit 1)))
    from stay.accounts a), '{}'::jsonb);
end $$;

-- ── Grants ───────────────────────────────────────────────────────────────────
do $g$
declare f text;
begin
  foreach f in array array['stay.billing_state(uuid)','stay.admin_save_plan(text,integer,text,integer,boolean)',
                           'stay.admin_save_settings(jsonb)','stay.admin_billing()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['stay.make_invoice(uuid,text,jsonb,jsonb)','stay.billing_apply(jsonb)','stay.billing_record(text,jsonb)',
                           'stay.billing_prepare(uuid,uuid,text)','stay.billing_pending(uuid,text)','stay.billing_cancelling(uuid)',
                           'stay.billing_sweep()','stay.trial_fingerprint(uuid,text,text[])'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on stay.billing_events, stay.invoices to service_role;
    grant all on stay.plans, stay.platform_settings, stay.invoice_series, stay.trial_fingerprints to service_role;
  end if;
end $g$;
