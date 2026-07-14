-- Phase 0 database contract. Review and approve before turning this into a migration.
-- PostgreSQL syntax; UUID generation, RLS, and auth integration are deferred to Phase 1.
-- All writes described as atomic must be implemented as server-side transactions/RPCs.
-- Update in migration 0006: new delivery rounds use all active shops and do not
-- use routes. The route tables below are legacy-only for old round history.

create type app_role as enum ('courier', 'round_lead', 'admin');
create type shop_status as enum ('active', 'inactive');
create type shop_payment_status as enum ('unknown', 'paid', 'unpaid');
create type delivery_round_status as enum ('open', 'closed');
create type shop_round_status as enum ('pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue');
create type delivery_event_status as enum ('active', 'cancelled');

create table users (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  phone text,
  role app_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table buildings (
  id uuid primary key,
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table routes (
  id uuid primary key,
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table building_zones (
  id uuid primary key,
  building_id uuid not null references buildings(id),
  code text not null,
  name text not null,
  sort_order integer not null check (sort_order > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (building_id, code),
  unique (building_id, name),
  unique (building_id, sort_order)
);

create table shops (
  id uuid primary key,
  code text not null unique,
  name text not null,
  building_id uuid not null references buildings(id),
  zone_id uuid not null references building_zones(id),
  floor_or_zone text not null, -- compatibility snapshot; derived from building_zones.name
  image_path text,
  normal_rounds_per_day smallint not null default 1 check (normal_rounds_per_day > 0),
  payment_status shop_payment_status not null default 'unknown',
  payment_status_updated_at timestamptz,
  payment_status_updated_by uuid references users(id),
  contact_name text,
  contact_phone text,
  access_note text,
  status shop_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payment_status = 'unknown'
      or (payment_status_updated_at is not null and payment_status_updated_by is not null))
);

-- Average and latest delivery are derived from active delivery events; they are not imported shop fields.
-- The Phase 2 query contract uses the latest event by recorded_at and a trailing 30-service-day average.

-- Legacy-only: retained for historic rounds created before migration 0006.
create table route_shops (
  route_id uuid not null references routes(id),
  shop_id uuid not null references shops(id),
  sequence_no integer not null check (sequence_no > 0),
  is_active boolean not null default true,
  primary key (route_id, shop_id),
  unique (route_id, sequence_no)
);

create table ice_types (
  id uuid primary key,
  code text not null unique,
  name text not null,
  unit text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table delivery_rounds (
  id uuid primary key,
  service_date date not null,
  name text not null,
  route_id uuid references routes(id), -- legacy reference; new rounds leave this null
  status delivery_round_status not null default 'open',
  opened_by uuid not null references users(id),
  opened_at timestamptz not null default now(),
  closed_by uuid references users(id),
  closed_at timestamptz,
  check ((status = 'open' and closed_by is null and closed_at is null)
      or (status = 'closed' and closed_by is not null and closed_at is not null))
);

create table delivery_round_members (
  round_id uuid not null references delivery_rounds(id),
  user_id uuid not null references users(id),
  primary key (round_id, user_id)
);

-- Created atomically when a round opens from all active shops. Snapshot fields
-- preserve the shop details at the time of that round.
create table round_stops (
  id uuid primary key,
  round_id uuid not null references delivery_rounds(id),
  shop_id uuid not null references shops(id),
  shop_code_snapshot text not null,
  shop_name_snapshot text not null,
  building_id_snapshot uuid not null,
  building_name_snapshot text not null,
  floor_or_zone_snapshot text not null,
  sequence_no integer not null check (sequence_no > 0),
  status shop_round_status not null default 'pending',
  note text,
  updated_by uuid not null references users(id),
  updated_at timestamptz not null default now(),
  unique (round_id, shop_id),
  unique (round_id, sequence_no),
  check ((status in ('pending', 'delivered')) or nullif(trim(coalesce(note, '')), '') is not null)
);

-- One row per ice type in a round. These are live values only while the round is open.
create table round_ice_counts (
  round_id uuid not null references delivery_rounds(id),
  ice_type_id uuid not null references ice_types(id),
  loaded_quantity integer not null default 0 check (loaded_quantity >= 0),
  replenished_quantity integer not null default 0 check (replenished_quantity >= 0),
  remaining_quantity integer not null default 0 check (remaining_quantity >= 0),
  damaged_quantity integer not null default 0 check (damaged_quantity >= 0),
  updated_by uuid not null references users(id),
  updated_at timestamptz not null default now(),
  primary key (round_id, ice_type_id)
);

-- One visit/confirmation. Idempotency belongs here so all ice items retry as one unit.
create table delivery_events (
  id uuid primary key,
  round_stop_id uuid not null references round_stops(id),
  recorded_by uuid not null references users(id),
  recorded_at timestamptz not null default now(),
  client_recorded_at timestamptz,
  idempotency_key uuid not null unique,
  note text,
  status delivery_event_status not null default 'active',
  cancelled_by uuid references users(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  check ((status = 'active' and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
      or (status = 'cancelled' and cancelled_by is not null and cancelled_at is not null
          and nullif(trim(coalesce(cancellation_reason, '')), '') is not null))
);

create table delivery_items (
  delivery_event_id uuid not null references delivery_events(id),
  ice_type_id uuid not null references ice_types(id),
  quantity integer not null check (quantity > 0),
  primary key (delivery_event_id, ice_type_id)
);

create table audit_logs (
  id uuid primary key,
  actor_id uuid not null references users(id),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  before_value jsonb,
  after_value jsonb,
  reason text,
  occurred_at timestamptz not null default now()
);

-- Frozen once per round by the same transaction that sets delivery_rounds.status = 'closed'.
create table round_close_summaries (
  round_id uuid primary key references delivery_rounds(id),
  total_shop_count integer not null check (total_shop_count >= 0),
  delivered_shop_count integer not null check (delivered_shop_count >= 0),
  pending_shop_count integer not null check (pending_shop_count >= 0),
  problem_shop_count integer not null check (problem_shop_count >= 0),
  captured_by uuid not null references users(id),
  captured_at timestamptz not null,
  check (delivered_shop_count + pending_shop_count + problem_shop_count = total_shop_count)
);

create table round_close_ice_summaries (
  round_id uuid not null references round_close_summaries(round_id),
  ice_type_id uuid not null references ice_types(id),
  loaded_quantity integer not null check (loaded_quantity >= 0),
  replenished_quantity integer not null check (replenished_quantity >= 0),
  remaining_quantity integer not null check (remaining_quantity >= 0),
  damaged_quantity integer not null check (damaged_quantity >= 0),
  expected_quantity integer not null,
  delivered_quantity integer not null check (delivered_quantity >= 0),
  variance_quantity integer not null,
  primary key (round_id, ice_type_id),
  check (expected_quantity = loaded_quantity + replenished_quantity - remaining_quantity - damaged_quantity),
  check (variance_quantity = expected_quantity - delivered_quantity)
);

create index round_stops_round_status_idx on round_stops (round_id, status);
create index delivery_events_stop_active_idx
  on delivery_events (round_stop_id, recorded_at)
  where status = 'active';
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, occurred_at desc);

-- Live reconciliation for an open round. Closed-round reports use round_close_ice_summaries.
create view round_ice_reconciliation as
select
  c.round_id,
  c.ice_type_id,
  c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity
    as expected_quantity,
  coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as delivered_quantity,
  (c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity)
    - coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as variance_quantity
from round_ice_counts c
left join round_stops s on s.round_id = c.round_id
left join delivery_events e on e.round_stop_id = s.id
left join delivery_items i on i.delivery_event_id = e.id and i.ice_type_id = c.ice_type_id
group by c.round_id, c.ice_type_id, c.loaded_quantity, c.replenished_quantity,
  c.remaining_quantity, c.damaged_quantity;
