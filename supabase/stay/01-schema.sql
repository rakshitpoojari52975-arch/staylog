-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — the new model, part 1 of 3: the tables (schema `stay`).
--
-- Built BESIDE the old public tables. Nothing here reads or changes them, and
-- nothing in the app uses these tables yet (phase 1 of the revamp: see
-- CLAUDE.md). Run order: 01-schema.sql → 02-functions.sql → 03-access.sql →
-- check.sql. Every script is safe to run twice. None drops or truncates.
--
-- Shape of every business table:
--   primary key (account_id, id)   — every existing id is kept as it is; new
--                                    ids are UUIDs made on the device
--   created_at, updated_at, updated_by, version
--                                  — set by stay.touch(); version is what a
--                                    device edited from (optimistic sync)
--   deleted_at                     — soft delete; nothing is ever removed
--   legacy jsonb                   — fields from the old app the new model has
--                                    no column for: kept, never dropped
-- Foreign keys are composite, (account_id, x_id) → table(account_id, id), so
-- a row can never point at another account's data.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists stay;

-- ── Accounts and the people in them ─────────────────────────────────────────
create table if not exists stay.accounts (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  code                  text not null unique check (code ~ '^[a-z0-9]{2,12}$'),
  time_zone             text not null default 'Asia/Kolkata',
  currency              text not null default 'INR',
  -- Sources whose guests pay the house (receipts, payment requests, balance
  -- alerts, round off). A blank source counts as 'Direct'.
  pays_directly_sources text[] not null default '{Direct,Booking.com}',
  owner_name            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Who may create new accounts (by invitation). Seeded from public.owners.
create table if not exists stay.platform_admins (
  user_id    uuid primary key references auth.users on delete cascade,
  added_at   timestamptz not null default now()
);

create table if not exists stay.members (
  account_id   uuid not null references stay.accounts on delete restrict,
  user_id      uuid not null references auth.users on delete cascade,
  role         text not null check (role in ('owner','manager')),
  display_name text,
  -- Manager permissions (an owner has them all). Missing key = the default
  -- in stay.can(): edit_bookings, send_messages, mark_paid, add_expenses on;
  -- see_money, manage_staff, edit_properties off; manage_calendar never.
  permissions  jsonb not null default '{}'::jsonb,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (account_id, user_id)
);

-- ── Properties ───────────────────────────────────────────────────────────────
create table if not exists stay.properties (
  account_id           uuid not null references stay.accounts on delete restrict,
  id                   text not null,
  name                 text not null,
  address              text,
  city                 text,
  maps_link            text,
  rooms                integer check (rooms is null or rooms >= 0),
  rented_as_whole_unit boolean not null default false,
  price_per_night      numeric check (price_per_night is null or price_per_night >= 0),
  notes                text,
  checkin_time         time not null default '13:00',
  checkout_time        time not null default '11:00',
  arrival_instructions text,
  house_rules          text[] not null default '{}',
  house_notes          text,
  welcome_text         text,
  wifi_name            text,
  wifi_password        text,
  upi_id               text,
  upi_payee            text,
  upi_qr               text,
  bank_details         text,
  signature            text,
  signature_ratio      numeric,
  receipt_prefix       text,
  card_payment_link    text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid, version integer not null default 1, deleted_at timestamptz, legacy jsonb,
  primary key (account_id, id),
  unique (account_id, receipt_prefix)
);

-- Which properties a manager holds.
create table if not exists stay.member_properties (
  account_id  uuid not null,
  user_id     uuid not null,
  property_id text not null,
  created_at  timestamptz not null default now(),
  primary key (account_id, user_id, property_id),
  foreign key (account_id, user_id)     references stay.members (account_id, user_id) on delete cascade,
  foreign key (account_id, property_id) references stay.properties (account_id, id) on delete restrict
);

-- ── Staff ────────────────────────────────────────────────────────────────────
create table if not exists stay.staff (
  account_id     uuid not null references stay.accounts on delete restrict,
  id             text not null,
  name           text not null,
  role           text,
  phone          text,
  joined_on      date,
  monthly_salary numeric check (monthly_salary is null or monthly_salary >= 0),
  daily_wage     numeric check (daily_wage is null or daily_wage >= 0),
  checkout_wage  numeric check (checkout_wage is null or checkout_wage >= 0),
  utensil_rate   numeric check (utensil_rate is null or utensil_rate >= 0),
  active         boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid, version integer not null default 1, deleted_at timestamptz, legacy jsonb,
  primary key (account_id, id)
);

-- Where each staff member works. None = every property of the account (as today).
create table if not exists stay.staff_properties (
  account_id  uuid not null,
  staff_id    text not null,
  property_id text not null,
  created_at  timestamptz not null default now(),
  primary key (account_id, staff_id, property_id),
  foreign key (account_id, staff_id)    references stay.staff (account_id, id) on delete cascade,
  foreign key (account_id, property_id) references stay.properties (account_id, id) on delete restrict
);

-- A staff member's own login (her page). Replaces public.staff_access.
create table if not exists stay.staff_logins (
  user_id      uuid primary key references auth.users on delete cascade,
  account_id   uuid not null,
  staff_id     text not null,
  username     text not null,
  display_name text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (account_id, username),
  foreign key (account_id, staff_id) references stay.staff (account_id, id) on delete restrict
);

-- Account invitations (managers; owners join by platform invite, phase 9).
create table if not exists stay.invites (
  code         text primary key,
  account_id   uuid not null references stay.accounts on delete cascade,
  role         text not null check (role in ('owner','manager')),
  property_ids text[] not null default '{}',
  permissions  jsonb not null default '{}'::jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  used_by      uuid,
  used_at      timestamptz
);

-- ── Bookings ─────────────────────────────────────────────────────────────────
create table if not exists stay.bookings (
  account_id      uuid not null references stay.accounts on delete restrict,
  id              text not null,
  property_id     text not null,
  guest_name      text,
  phone           text,
  check_in        date not null,
  check_out       date not null,
  guests          integer,
  source          text,
  status          text not null default 'confirmed' check (status in ('confirmed','checkedin','checkedout','cancelled')),
  notes           text,
  total_amount    numeric,
  paid            numeric,
  round_off       numeric not null default 0,
  round_off_hand  boolean not null default false,
  id_proof_type   text,
  id_proof_number text,
  msg_sent        jsonb not null default '{}'::jsonb,
  receipt_no      text,
  receipt_on      date,
  imported_on     date,
  ical_moved      date,
  ical_moved_from jsonb,
  ical_gone       boolean not null default false,
  gap_closed      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid, version integer not null default 1, deleted_at timestamptz, legacy jsonb,
  primary key (account_id, id),
  foreign key (account_id, property_id) references stay.properties (account_id, id) on delete restrict
);
create unique index if not exists bookings_receipt_no on stay.bookings (account_id, receipt_no) where receipt_no is not null;
create index if not exists bookings_dates on stay.bookings (account_id, property_id, check_in, check_out);
create index if not exists bookings_changed on stay.bookings (account_id, updated_at);

-- ── Loans (before expenses: a payout can carry a loan deduction) ────────────
create table if not exists stay.loans (
  account_id         uuid not null references stay.accounts on delete restrict,
  id                 text not null,
  staff_id           text not null,
  principal          numeric not null check (principal >= 0),
  installment_amount numeric check (installment_amount is null or installment_amount >= 0),
  disbursed_on       date,
  first_due_date     date,
  status             text not null default 'active' check (status in ('active','closed','writtenoff')),
  written_off_on     date,
  notes              text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid, version integer not null default 1, deleted_at timestamptz, legacy jsonb,
  primary key (account_id, id),
  foreign key (account_id, staff_id) references stay.staff (account_id, id) on delete restrict
);

-- ── Expenses ─────────────────────────────────────────────────────────────────
-- property_id null = Shared (charged to no single property).
create table if not exists stay.expenses (
  account_id     uuid not null references stay.accounts on delete restrict,
  id             text not null,
  property_id    text,
  date           date not null,
  category       text not null default 'other'
                 check (category in ('maintenance','utilities','supplies','staff','marketing','other')),
  description    text,
  amount         numeric not null default 0,
  paid           boolean not null default false,
  paid_on        date,
  notes          text,
  staff_id       text,
  loan_id        text,
  loan_deduction numeric,
  gross_amount   numeric,
  auto_amount    numeric,
  wage_kind      text check (wage_kind is null or wage_kind in ('daily','checkout')),
  source_mark_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid, version integer not null default 1, deleted_at timestamptz, legacy jsonb,
  primary key (account_id, id),
  foreign key (account_id, property_id) references stay.properties (account_id, id) on delete restrict,
  foreign key (account_id, staff_id)    references stay.staff (account_id, id) on delete restrict,
  foreign key (account_id, loan_id)     references stay.loans (account_id, id) on delete restrict
);
create index if not exists expenses_changed on stay.expenses (account_id, updated_at);
create index if not exists expenses_staff_unpaid on stay.expenses (account_id, staff_id) where not paid and deleted_at is null;

create table if not exists stay.loan_repayments (
  account_id uuid not null references stay.accounts on delete restrict,
  id         text not null,
  loan_id    text not null,
  date       date,
  amount     numeric not null check (amount >= 0),
  mode       text not null default 'direct' check (mode in ('direct','payout')),
  expense_id text,
  note       text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid, version integer not null default 1, deleted_at timestamptz, legacy jsonb,
  primary key (account_id, id),
  foreign key (account_id, loan_id)    references stay.loans (account_id, id) on delete restrict,
  foreign key (account_id, expense_id) references stay.expenses (account_id, id) on delete restrict
);

-- ── Her marks ────────────────────────────────────────────────────────────────
-- One per staff member per day; the id is the staff and the date, always
-- (stay.attendance_id), so a re-run and a migration name the same row.
create table if not exists stay.attendance (
  account_id  uuid not null references stay.accounts on delete restrict,
  id          text not null,
  staff_id    text not null,
  date        date not null,
  property_id text,
  marked_at   timestamptz not null default now(),
  source      text not null default 'staff',
  expense_id  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (account_id, id),
  unique (account_id, staff_id, date),
  foreign key (account_id, staff_id)    references stay.staff (account_id, id) on delete restrict,
  foreign key (account_id, property_id) references stay.properties (account_id, id) on delete restrict
);

create table if not exists stay.utensil_marks (
  account_id  uuid not null references stay.accounts on delete restrict,
  id          text not null,
  staff_id    text not null,
  date        date not null,
  property_id text,
  marked_at   timestamptz not null default now(),
  source      text not null default 'staff',
  expense_id  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (account_id, id),
  unique (account_id, staff_id, date),
  foreign key (account_id, staff_id)    references stay.staff (account_id, id) on delete restrict,
  foreign key (account_id, property_id) references stay.properties (account_id, id) on delete restrict
);

-- ── Receipt numbers: one counter per series and financial year ──────────────
create table if not exists stay.receipt_series (
  account_id     uuid not null references stay.accounts on delete restrict,
  prefix         text not null,
  financial_year text not null,             -- '2025-26' (April to March)
  last_number    integer not null default 0 check (last_number >= 0),
  updated_at     timestamptz not null default now(),
  primary key (account_id, prefix, financial_year)
);

-- ── Calendar import ──────────────────────────────────────────────────────────
-- The links are owner-only secrets (03-access.sql); managers never see them.
create table if not exists stay.ical_feeds (
  account_id      uuid not null references stay.accounts on delete restrict,
  id              uuid not null default gen_random_uuid(),
  property_id     text not null,
  platform        text not null check (platform in ('Airbnb','Booking.com')),
  url             text not null check (url ~* '^https://'),
  connected       boolean not null default false,
  last_fetched_at timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  last_count      integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (account_id, id),
  unique (account_id, property_id, platform, url),
  foreign key (account_id, property_id) references stay.properties (account_id, id) on delete restrict
);

create table if not exists stay.ical_events (
  account_id          uuid not null references stay.accounts on delete restrict,
  feed_id             uuid not null,
  uid                 text not null,
  property_id         text not null,
  platform            text not null,
  start_date          date not null,
  end_date            date not null,
  summary             text,
  description         text,
  kind                text not null default 'reserved' check (kind in ('reserved','blocked')),
  gone_at             timestamptz,
  imported_booking_id text,
  announced_at        timestamptz,
  first_seen_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (account_id, feed_id, uid),
  foreign key (account_id, feed_id)     references stay.ical_feeds (account_id, id) on delete cascade,
  foreign key (account_id, property_id) references stay.properties (account_id, id) on delete restrict
);

-- ── Notifications, devices, backups ──────────────────────────────────────────
create table if not exists stay.push_subscriptions (
  account_id   uuid not null references stay.accounts on delete cascade,
  user_id      uuid not null references auth.users on delete cascade,
  device_id    text,
  endpoint     text not null,
  p256dh       text not null,
  auth         text not null,
  device       text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (account_id, user_id, endpoint)
);

create table if not exists stay.notification_prefs (
  account_id uuid not null references stay.accounts on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

-- The inbox: one row per alert per recipient. Read state is the recipient's.
create table if not exists stay.push_log (
  account_id  uuid not null references stay.accounts on delete cascade,
  recipient   uuid not null references auth.users on delete cascade,
  key         text not null,
  title       text,
  body        text,
  url         text,
  alert       text,
  property_id text,
  sent_at     timestamptz not null default now(),
  delivered   boolean not null default false,
  read_at     timestamptz,
  claimed_at  timestamptz,
  primary key (account_id, recipient, key)
);
create index if not exists push_log_inbox on stay.push_log (account_id, recipient, sent_at desc);

-- One row per device: sync health, for the Sync panel and the stale alert.
create table if not exists stay.sync_status (
  account_id     uuid not null references stay.accounts on delete cascade,
  device_id      text not null,
  user_id        uuid not null references auth.users on delete cascade,
  device_name    text,
  app_version    text,
  last_pull_at   timestamptz,
  last_push_at   timestamptz,
  oldest_unsent  timestamptz,
  outbox         integer not null default 0,
  conflicts      integer not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (account_id, device_id)
);

-- Encrypted snapshots: ciphertext only, per account and device.
create table if not exists stay.backups (
  account_id  uuid not null references stay.accounts on delete cascade,
  id          uuid not null default gen_random_uuid(),
  device_id   text,
  created_by  uuid,
  ciphertext  text not null,
  salt        text not null,
  iv          text not null,
  iterations  integer not null,
  app_version text,
  size        integer,
  created_at  timestamptz not null default now(),
  primary key (account_id, id)
);

-- Row-level security on from the start. Until 03-access.sql adds the rules,
-- nobody signed in can read or write these tables (the dashboard's SQL editor
-- also asks about this when a script creates tables).
alter table stay.accounts enable row level security;
alter table stay.platform_admins enable row level security;
alter table stay.members enable row level security;
alter table stay.properties enable row level security;
alter table stay.member_properties enable row level security;
alter table stay.staff enable row level security;
alter table stay.staff_properties enable row level security;
alter table stay.staff_logins enable row level security;
alter table stay.invites enable row level security;
alter table stay.bookings enable row level security;
alter table stay.loans enable row level security;
alter table stay.expenses enable row level security;
alter table stay.loan_repayments enable row level security;
alter table stay.attendance enable row level security;
alter table stay.utensil_marks enable row level security;
alter table stay.receipt_series enable row level security;
alter table stay.ical_feeds enable row level security;
alter table stay.ical_events enable row level security;
alter table stay.push_subscriptions enable row level security;
alter table stay.notification_prefs enable row level security;
alter table stay.push_log enable row level security;
alter table stay.sync_status enable row level security;
alter table stay.backups enable row level security;

-- Platform admins: everyone in public.owners today (that is Rakshit).
do $seed$ begin
  if to_regclass('public.owners') is not null then
    insert into stay.platform_admins (user_id)
    select user_id from public.owners on conflict (user_id) do nothing;
  end if;
end $seed$;
