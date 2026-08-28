-- Event delivery Slice A: lifecycle foundation.
--
-- This migration intentionally does not create event round stops or event
-- deliveries. It establishes the manager-owned event lifecycle and keeps every
-- operational feature flag off until the remaining compatibility gates land.

-- 0163 prerequisite guard: begin
do $$
begin
  if to_regclass('public.round_stops') is null
    or exists (
      select 1
      from unnest(array[
        'destination_kind',
        'event_participation_id',
        'is_operational',
        'event_job_name_snapshot',
        'event_location_snapshot',
        'event_booth_snapshot',
        'event_zone_snapshot',
        'event_landmark_snapshot',
        'event_contact_name_snapshot',
        'event_contact_phone_snapshot'
      ]::text[]) required(column_name)
      where not exists (
        select 1
        from information_schema.columns column_info
        where column_info.table_schema = 'public'
          and column_info.table_name = 'round_stops'
          and column_info.column_name = required.column_name
      )
    )
    or to_regclass('public.round_stops_regular_destination_unique_idx') is null
    or to_regclass('public.round_stops_event_destination_unique_idx') is null
    or not exists (
      select 1
      from pg_constraint
      where conname = 'round_stops_destination_context_check'
        and conrelid = to_regclass('public.round_stops')
    ) then
    raise exception
      'Migration 0163 requires migration 0157_event_destination_compatibility_fence.sql; apply 0157 before retrying 0163'
      using errcode = '55000';
  end if;
end $$;
-- 0163 prerequisite guard: end

do $$
begin
  create type public.event_job_status as enum ('draft', 'published', 'cancelled');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.event_participation_status as enum ('active', 'cancelled');
exception when duplicate_object then null;
end $$;

create table public.event_jobs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (nullif(trim(name), '') is not null),
  organizer_name text not null check (nullif(trim(organizer_name), '') is not null),
  contact_name text not null check (nullif(trim(contact_name), '') is not null),
  contact_phone text not null check (nullif(trim(contact_phone), '') is not null),
  location text not null check (nullif(trim(location), '') is not null),
  start_date date not null,
  end_date date not null,
  timezone text not null default 'Asia/Bangkok' check (timezone = 'Asia/Bangkok'),
  notes text,
  status public.event_job_status not null default 'draft',
  current_config_version_id uuid,
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_by uuid references public.users(id) on delete restrict,
  published_at timestamptz,
  cancelled_by uuid references public.users(id) on delete restrict,
  cancelled_at timestamptz,
  cancellation_reason text,
  check (end_date >= start_date),
  check (
    (status = 'draft'
      and published_by is null and published_at is null
      and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
    or (status = 'published'
      and published_by is not null and published_at is not null
      and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
    or (status = 'cancelled'
      and cancelled_by is not null and cancelled_at is not null
      and nullif(trim(coalesce(cancellation_reason, '')), '') is not null)
  )
);

create table public.event_job_config_versions (
  id uuid primary key default gen_random_uuid(),
  event_job_id uuid not null references public.event_jobs(id) on delete restrict,
  version_no integer not null check (version_no > 0),
  tank_rental_unit_price numeric(12,2) not null check (tank_rental_unit_price > 0),
  payment_term public.payment_term not null default 'end_of_day'
    check (payment_term = 'end_of_day'),
  allowed_payment_methods public.payment_method[] not null,
  default_payment_method public.payment_method not null,
  cash_reference_required boolean not null default false,
  cash_evidence_required boolean not null default false,
  bank_transfer_reference_required boolean not null default true,
  bank_transfer_evidence_required boolean not null default false,
  qr_reference_required boolean not null default true,
  qr_evidence_required boolean not null default false,
  policy_fingerprint text not null check (nullif(trim(policy_fingerprint), '') is not null),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (event_job_id, version_no),
  unique (id, event_job_id),
  check (cardinality(allowed_payment_methods) > 0),
  check (default_payment_method = any(allowed_payment_methods))
);

alter table public.event_jobs
  add constraint event_jobs_current_config_version_fk
  foreign key (current_config_version_id, id)
  references public.event_job_config_versions(id, event_job_id)
  deferrable initially deferred;

create table public.event_participations (
  id uuid primary key default gen_random_uuid(),
  event_job_id uuid not null references public.event_jobs(id) on delete restrict,
  shop_id uuid not null references public.shops(id) on delete restrict,
  booth_number text,
  event_zone text,
  landmark text,
  contact_name text,
  contact_phone text,
  start_date date not null,
  end_date date not null,
  rents_tank_from_us boolean not null default false,
  status public.event_participation_status not null default 'active',
  config_version_id uuid,
  tank_rental_unit_price_snapshot numeric(12,2),
  payment_term_snapshot public.payment_term,
  allowed_payment_methods_snapshot public.payment_method[],
  default_payment_method_snapshot public.payment_method,
  cash_reference_required_snapshot boolean,
  cash_evidence_required_snapshot boolean,
  bank_transfer_reference_required_snapshot boolean,
  bank_transfer_evidence_required_snapshot boolean,
  qr_reference_required_snapshot boolean,
  qr_evidence_required_snapshot boolean,
  settlement_policy_fingerprint text,
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  cancelled_by uuid references public.users(id) on delete restrict,
  cancelled_at timestamptz,
  cancellation_reason text,
  unique (event_job_id, shop_id),
  foreign key (config_version_id, event_job_id)
    references public.event_job_config_versions(id, event_job_id)
    deferrable initially deferred,
  check (end_date >= start_date),
  check (
    (status = 'active'
      and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
    or (status = 'cancelled'
      and cancelled_by is not null and cancelled_at is not null
      and nullif(trim(coalesce(cancellation_reason, '')), '') is not null)
  ),
  check (
    (config_version_id is null
      and tank_rental_unit_price_snapshot is null
      and payment_term_snapshot is null
      and allowed_payment_methods_snapshot is null
      and default_payment_method_snapshot is null
      and cash_reference_required_snapshot is null
      and cash_evidence_required_snapshot is null
      and bank_transfer_reference_required_snapshot is null
      and bank_transfer_evidence_required_snapshot is null
      and qr_reference_required_snapshot is null
      and qr_evidence_required_snapshot is null
      and settlement_policy_fingerprint is null)
    or (config_version_id is not null
      and tank_rental_unit_price_snapshot > 0
      and payment_term_snapshot = 'end_of_day'
      and cardinality(allowed_payment_methods_snapshot) > 0
      and default_payment_method_snapshot = any(allowed_payment_methods_snapshot)
      and cash_reference_required_snapshot is not null
      and cash_evidence_required_snapshot is not null
      and bank_transfer_reference_required_snapshot is not null
      and bank_transfer_evidence_required_snapshot is not null
      and qr_reference_required_snapshot is not null
      and qr_evidence_required_snapshot is not null
      and nullif(trim(settlement_policy_fingerprint), '') is not null)
  )
);

create index event_jobs_status_dates_idx
  on public.event_jobs (status, start_date, end_date);
create index event_participations_job_status_dates_idx
  on public.event_participations (event_job_id, status, start_date, end_date);
create index event_participations_shop_idx
  on public.event_participations (shop_id, start_date, end_date);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'round_stops_event_participation_fk'
      and conrelid = 'public.round_stops'::regclass
  ) then
    alter table public.round_stops
      add constraint round_stops_event_participation_fk
      foreign key (event_participation_id)
      references public.event_participations(id) on delete restrict;
  end if;
end $$;

create table public.event_delivery_feature_settings (
  singleton boolean primary key default true check (singleton),
  schema_version integer not null check (schema_version > 0),
  lifecycle_enabled boolean not null default true,
  event_stops_enabled boolean not null default false,
  event_ice_delivery_enabled boolean not null default false,
  event_tank_rental_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.event_delivery_feature_settings (
  singleton, schema_version, lifecycle_enabled,
  event_stops_enabled, event_ice_delivery_enabled, event_tank_rental_enabled
) values (true, 1, true, false, false, false)
on conflict (singleton) do update
set schema_version = greatest(public.event_delivery_feature_settings.schema_version, excluded.schema_version),
    lifecycle_enabled = true,
    event_stops_enabled = false,
    event_ice_delivery_enabled = false,
    event_tank_rental_enabled = false,
    updated_at = now();

create or replace function public.normalize_event_payment_methods(
  p_methods public.payment_method[]
)
returns public.payment_method[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(method order by method::text), array[]::public.payment_method[])
  from (
    select distinct method
    from unnest(coalesce(p_methods, array[]::public.payment_method[])) method
    where method is not null
  ) normalized;
$$;

create or replace function public.event_configuration_fingerprint(
  p_tank_rental_unit_price numeric,
  p_allowed_payment_methods public.payment_method[],
  p_default_payment_method public.payment_method,
  p_cash_reference_required boolean,
  p_cash_evidence_required boolean,
  p_bank_transfer_reference_required boolean,
  p_bank_transfer_evidence_required boolean,
  p_qr_reference_required boolean,
  p_qr_evidence_required boolean
)
returns text
language sql
immutable
set search_path = public
as $$
  select md5(jsonb_build_object(
    'tank_rental_unit_price', p_tank_rental_unit_price::numeric(12,2),
    'payment_term', 'end_of_day',
    'allowed_payment_methods', to_jsonb(public.normalize_event_payment_methods(p_allowed_payment_methods)),
    'default_payment_method', p_default_payment_method,
    'cash_reference_required', p_cash_reference_required,
    'cash_evidence_required', p_cash_evidence_required,
    'bank_transfer_reference_required', p_bank_transfer_reference_required,
    'bank_transfer_evidence_required', p_bank_transfer_evidence_required,
    'qr_reference_required', p_qr_reference_required,
    'qr_evidence_required', p_qr_evidence_required
  )::text);
$$;

create or replace function public.reject_event_config_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Event configuration versions are immutable';
end;
$$;

create trigger event_job_config_versions_immutable
before update or delete on public.event_job_config_versions
for each row execute function public.reject_event_config_mutation();

create or replace function public.enforce_event_job_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'cancelled' then
    raise exception 'Cancelled events are immutable';
  end if;

  if new.status is distinct from old.status then
    if current_setting('app.event_lifecycle_rpc', true) is distinct from 'on' then
      raise exception 'Event lifecycle transitions must use an event lifecycle RPC';
    end if;
    if not (
      (old.status = 'draft' and new.status in ('published', 'cancelled'))
      or (old.status = 'published' and new.status = 'cancelled')
    ) then
      raise exception 'Invalid event lifecycle transition';
    end if;
  end if;

  if old.status <> 'draft' and (
    new.name is distinct from old.name
    or new.organizer_name is distinct from old.organizer_name
    or new.contact_name is distinct from old.contact_name
    or new.contact_phone is distinct from old.contact_phone
    or new.location is distinct from old.location
    or new.start_date is distinct from old.start_date
    or new.end_date is distinct from old.end_date
    or new.timezone is distinct from old.timezone
    or new.notes is distinct from old.notes
  ) then
    raise exception 'Published event identity and dates are immutable';
  end if;

  return new;
end;
$$;

create trigger event_jobs_enforce_mutation
before update on public.event_jobs
for each row execute function public.enforce_event_job_mutation();
create trigger event_jobs_updated_at
before update on public.event_jobs
for each row execute function public.set_updated_at();

create or replace function public.enforce_event_participation_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_event_start date;
  v_event_end date;
  v_config public.event_job_config_versions%rowtype;
begin
  select job.start_date, job.end_date
  into v_event_start, v_event_end
  from public.event_jobs job
  where job.id = new.event_job_id;

  if v_event_start is null then
    raise exception 'The selected event does not exist';
  elsif new.start_date < v_event_start or new.end_date > v_event_end then
    raise exception 'Participation dates must be within the event date range';
  end if;

  if new.config_version_id is not null then
    select * into v_config
    from public.event_job_config_versions config
    where config.id = new.config_version_id
      and config.event_job_id = new.event_job_id;
    if v_config.id is null
      or new.tank_rental_unit_price_snapshot is distinct from v_config.tank_rental_unit_price
      or new.payment_term_snapshot is distinct from v_config.payment_term
      or new.allowed_payment_methods_snapshot is distinct from v_config.allowed_payment_methods
      or new.default_payment_method_snapshot is distinct from v_config.default_payment_method
      or new.cash_reference_required_snapshot is distinct from v_config.cash_reference_required
      or new.cash_evidence_required_snapshot is distinct from v_config.cash_evidence_required
      or new.bank_transfer_reference_required_snapshot is distinct from v_config.bank_transfer_reference_required
      or new.bank_transfer_evidence_required_snapshot is distinct from v_config.bank_transfer_evidence_required
      or new.qr_reference_required_snapshot is distinct from v_config.qr_reference_required
      or new.qr_evidence_required_snapshot is distinct from v_config.qr_evidence_required
      or new.settlement_policy_fingerprint is distinct from v_config.policy_fingerprint then
      raise exception 'Participation settlement snapshot does not match its configuration version';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.config_version_id is not null and (
      new.config_version_id is distinct from old.config_version_id
      or new.tank_rental_unit_price_snapshot is distinct from old.tank_rental_unit_price_snapshot
      or new.payment_term_snapshot is distinct from old.payment_term_snapshot
      or new.allowed_payment_methods_snapshot is distinct from old.allowed_payment_methods_snapshot
      or new.default_payment_method_snapshot is distinct from old.default_payment_method_snapshot
      or new.cash_reference_required_snapshot is distinct from old.cash_reference_required_snapshot
      or new.cash_evidence_required_snapshot is distinct from old.cash_evidence_required_snapshot
      or new.bank_transfer_reference_required_snapshot is distinct from old.bank_transfer_reference_required_snapshot
      or new.bank_transfer_evidence_required_snapshot is distinct from old.bank_transfer_evidence_required_snapshot
      or new.qr_reference_required_snapshot is distinct from old.qr_reference_required_snapshot
      or new.qr_evidence_required_snapshot is distinct from old.qr_evidence_required_snapshot
      or new.settlement_policy_fingerprint is distinct from old.settlement_policy_fingerprint
    ) then
      raise exception 'Published participation settlement snapshots are immutable';
    end if;

    if new.status is distinct from old.status
      and current_setting('app.event_lifecycle_rpc', true) is distinct from 'on' then
      raise exception 'Participation lifecycle transitions must use an event lifecycle RPC';
    end if;
  end if;

  return new;
end;
$$;

create trigger event_participations_enforce_mutation
before insert or update on public.event_participations
for each row execute function public.enforce_event_participation_mutation();
create trigger event_participations_updated_at
before update on public.event_participations
for each row execute function public.set_updated_at();

create or replace function public.save_event_job_metadata(
  p_event_job_id uuid,
  p_name text,
  p_organizer_name text,
  p_contact_name text,
  p_contact_phone text,
  p_location text,
  p_start_date date,
  p_end_date date,
  p_notes text
)
returns public.event_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_before jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can manage event metadata';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null
    or nullif(trim(coalesce(p_organizer_name, '')), '') is null
    or nullif(trim(coalesce(p_contact_name, '')), '') is null
    or nullif(trim(coalesce(p_contact_phone, '')), '') is null
    or nullif(trim(coalesce(p_location, '')), '') is null then
    raise exception 'Event name, organizer, contact, phone, and location are required';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Invalid event date range';
  end if;

  if p_event_job_id is null then
    insert into public.event_jobs (
      name, organizer_name, contact_name, contact_phone, location,
      start_date, end_date, notes, created_by
    ) values (
      trim(p_name), trim(p_organizer_name), trim(p_contact_name), trim(p_contact_phone), trim(p_location),
      p_start_date, p_end_date, nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
    ) returning * into v_job;
  else
    select * into v_job
    from public.event_jobs
    where id = p_event_job_id
    for update;
    if v_job.id is null then
      raise exception 'The selected event does not exist';
    elsif v_job.status <> 'draft' then
      raise exception 'Only draft events can be edited';
    end if;
    if exists (
      select 1
      from public.event_participations participation
      where participation.event_job_id = v_job.id
        and (participation.start_date < p_start_date or participation.end_date > p_end_date)
    ) then
      raise exception 'Event dates cannot exclude an existing participation';
    end if;
    v_before := to_jsonb(v_job);
    update public.event_jobs
    set name = trim(p_name),
        organizer_name = trim(p_organizer_name),
        contact_name = trim(p_contact_name),
        contact_phone = trim(p_contact_phone),
        location = trim(p_location),
        start_date = p_start_date,
        end_date = p_end_date,
        notes = nullif(trim(coalesce(p_notes, '')), '')
    where id = v_job.id
    returning * into v_job;
  end if;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value
  ) values (
    auth.uid(), 'event_job', v_job.id,
    case when p_event_job_id is null then 'create' else 'update_draft' end,
    v_before, to_jsonb(v_job)
  );
  return v_job;
end;
$$;

create or replace function public.save_event_job(
  p_event_job_id uuid,
  p_name text,
  p_organizer_name text,
  p_contact_name text,
  p_contact_phone text,
  p_location text,
  p_start_date date,
  p_end_date date,
  p_notes text,
  p_tank_rental_unit_price numeric,
  p_allowed_payment_methods public.payment_method[],
  p_default_payment_method public.payment_method,
  p_cash_reference_required boolean default false,
  p_cash_evidence_required boolean default false,
  p_bank_transfer_reference_required boolean default true,
  p_bank_transfer_evidence_required boolean default false,
  p_qr_reference_required boolean default true,
  p_qr_evidence_required boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_before jsonb;
  v_config public.event_job_config_versions%rowtype;
  v_methods public.payment_method[];
  v_fingerprint text;
  v_version_no integer;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can manage events';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null
    or nullif(trim(coalesce(p_organizer_name, '')), '') is null
    or nullif(trim(coalesce(p_contact_name, '')), '') is null
    or nullif(trim(coalesce(p_contact_phone, '')), '') is null
    or nullif(trim(coalesce(p_location, '')), '') is null then
    raise exception 'Event name, organizer, contact, phone, and location are required';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Invalid event date range';
  end if;
  if p_tank_rental_unit_price is null or p_tank_rental_unit_price <= 0 then
    raise exception 'Tank rental unit price must be greater than zero';
  end if;

  v_methods := public.normalize_event_payment_methods(p_allowed_payment_methods);
  if cardinality(v_methods) = 0 or p_default_payment_method is null
    or not (p_default_payment_method = any(v_methods)) then
    raise exception 'At least one payment method and a matching default are required';
  end if;
  v_fingerprint := public.event_configuration_fingerprint(
    p_tank_rental_unit_price, v_methods, p_default_payment_method,
    coalesce(p_cash_reference_required, false), coalesce(p_cash_evidence_required, false),
    coalesce(p_bank_transfer_reference_required, true), coalesce(p_bank_transfer_evidence_required, false),
    coalesce(p_qr_reference_required, true), coalesce(p_qr_evidence_required, false)
  );

  if p_event_job_id is null then
    insert into public.event_jobs (
      name, organizer_name, contact_name, contact_phone, location,
      start_date, end_date, notes, created_by
    ) values (
      trim(p_name), trim(p_organizer_name), trim(p_contact_name), trim(p_contact_phone), trim(p_location),
      p_start_date, p_end_date, nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
    ) returning * into v_job;
    v_version_no := 1;
  else
    select * into v_job
    from public.event_jobs
    where id = p_event_job_id
    for update;
    if v_job.id is null then
      raise exception 'The selected event does not exist';
    elsif v_job.status <> 'draft' then
      raise exception 'Only draft events can be edited';
    end if;
    if exists (
      select 1
      from public.event_participations participation
      where participation.event_job_id = v_job.id
        and (participation.start_date < p_start_date or participation.end_date > p_end_date)
    ) then
      raise exception 'Event dates cannot exclude an existing participation';
    end if;
    v_before := to_jsonb(v_job);
    update public.event_jobs
    set name = trim(p_name),
        organizer_name = trim(p_organizer_name),
        contact_name = trim(p_contact_name),
        contact_phone = trim(p_contact_phone),
        location = trim(p_location),
        start_date = p_start_date,
        end_date = p_end_date,
        notes = nullif(trim(coalesce(p_notes, '')), '')
    where id = v_job.id
    returning * into v_job;
    select coalesce(max(config.version_no), 0) + 1
    into v_version_no
    from public.event_job_config_versions config
    where config.event_job_id = v_job.id;
  end if;

  select * into v_config
  from public.event_job_config_versions config
  where config.id = v_job.current_config_version_id;

  if v_config.id is null or v_config.policy_fingerprint <> v_fingerprint then
    insert into public.event_job_config_versions (
      event_job_id, version_no, tank_rental_unit_price, allowed_payment_methods,
      default_payment_method, cash_reference_required, cash_evidence_required,
      bank_transfer_reference_required, bank_transfer_evidence_required,
      qr_reference_required, qr_evidence_required, policy_fingerprint, created_by
    ) values (
      v_job.id, v_version_no, p_tank_rental_unit_price, v_methods,
      p_default_payment_method, coalesce(p_cash_reference_required, false),
      coalesce(p_cash_evidence_required, false), coalesce(p_bank_transfer_reference_required, true),
      coalesce(p_bank_transfer_evidence_required, false), coalesce(p_qr_reference_required, true),
      coalesce(p_qr_evidence_required, false), v_fingerprint, auth.uid()
    ) returning * into v_config;
    update public.event_jobs
    set current_config_version_id = v_config.id
    where id = v_job.id
    returning * into v_job;
  end if;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value
  ) values (
    auth.uid(), 'event_job', v_job.id,
    case when p_event_job_id is null then 'create' else 'update_draft' end,
    v_before, to_jsonb(v_job)
  );

  return jsonb_build_object('event_job', to_jsonb(v_job), 'configuration', to_jsonb(v_config));
end;
$$;

create or replace function public.create_event_job_config_version(
  p_event_job_id uuid,
  p_tank_rental_unit_price numeric,
  p_allowed_payment_methods public.payment_method[],
  p_default_payment_method public.payment_method,
  p_cash_reference_required boolean default false,
  p_cash_evidence_required boolean default false,
  p_bank_transfer_reference_required boolean default true,
  p_bank_transfer_evidence_required boolean default false,
  p_qr_reference_required boolean default true,
  p_qr_evidence_required boolean default false
)
returns public.event_job_config_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_config public.event_job_config_versions%rowtype;
  v_methods public.payment_method[];
  v_fingerprint text;
  v_version_no integer;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can manage event configurations';
  end if;
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if v_job.id is null then
    raise exception 'The selected event does not exist';
  elsif v_job.status <> 'published' then
    raise exception 'New configuration versions are only needed after publication';
  end if;
  if p_tank_rental_unit_price is null or p_tank_rental_unit_price <= 0 then
    raise exception 'Tank rental unit price must be greater than zero';
  end if;
  v_methods := public.normalize_event_payment_methods(p_allowed_payment_methods);
  if cardinality(v_methods) = 0 or p_default_payment_method is null
    or not (p_default_payment_method = any(v_methods)) then
    raise exception 'At least one payment method and a matching default are required';
  end if;
  v_fingerprint := public.event_configuration_fingerprint(
    p_tank_rental_unit_price, v_methods, p_default_payment_method,
    coalesce(p_cash_reference_required, false), coalesce(p_cash_evidence_required, false),
    coalesce(p_bank_transfer_reference_required, true), coalesce(p_bank_transfer_evidence_required, false),
    coalesce(p_qr_reference_required, true), coalesce(p_qr_evidence_required, false)
  );
  if exists (
    select 1 from public.event_job_config_versions
    where event_job_id = p_event_job_id and policy_fingerprint = v_fingerprint
  ) then
    raise exception 'This event configuration already exists';
  end if;
  select coalesce(max(version_no), 0) + 1 into v_version_no
  from public.event_job_config_versions where event_job_id = p_event_job_id;
  insert into public.event_job_config_versions (
    event_job_id, version_no, tank_rental_unit_price, allowed_payment_methods,
    default_payment_method, cash_reference_required, cash_evidence_required,
    bank_transfer_reference_required, bank_transfer_evidence_required,
    qr_reference_required, qr_evidence_required, policy_fingerprint, created_by
  ) values (
    p_event_job_id, v_version_no, p_tank_rental_unit_price, v_methods,
    p_default_payment_method, coalesce(p_cash_reference_required, false),
    coalesce(p_cash_evidence_required, false), coalesce(p_bank_transfer_reference_required, true),
    coalesce(p_bank_transfer_evidence_required, false), coalesce(p_qr_reference_required, true),
    coalesce(p_qr_evidence_required, false), v_fingerprint, auth.uid()
  ) returning * into v_config;
  update public.event_jobs set current_config_version_id = v_config.id where id = p_event_job_id;
  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, after_value
  ) values (
    auth.uid(), 'event_job_config_version', v_config.id, 'create', to_jsonb(v_config)
  );
  return v_config;
end;
$$;

create or replace function public.save_event_participation(
  p_participation_id uuid,
  p_event_job_id uuid,
  p_shop_id uuid,
  p_booth_number text,
  p_event_zone text,
  p_landmark text,
  p_contact_name text,
  p_contact_phone text,
  p_start_date date,
  p_end_date date,
  p_rents_tank_from_us boolean
)
returns public.event_participations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_config public.event_job_config_versions%rowtype;
  v_shop public.shops%rowtype;
  v_participation public.event_participations%rowtype;
  v_before jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can manage event participations';
  end if;
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if v_job.id is null then
    raise exception 'The selected event does not exist';
  elsif v_job.status = 'cancelled' then
    raise exception 'Cancelled events cannot accept participations';
  end if;
  select * into v_shop from public.shops where id = p_shop_id;
  if v_shop.id is null or v_shop.status <> 'active' then
    raise exception 'The selected shop is not active';
  end if;
  if p_start_date is null or p_end_date is null
    or p_start_date < v_job.start_date or p_end_date > v_job.end_date
    or p_end_date < p_start_date then
    raise exception 'Participation dates must be within the event date range';
  end if;

  if p_participation_id is null then
    if v_job.status = 'published' and (
      nullif(trim(coalesce(v_shop.code, '')), '') is null
      or nullif(trim(coalesce(v_shop.name, '')), '') is null
      or nullif(trim(coalesce(p_contact_name, v_shop.contact_name, '')), '') is null
      or nullif(trim(coalesce(p_contact_phone, v_shop.contact_phone, '')), '') is null
    ) then
      raise exception 'Published participations require customer identity and contact details';
    end if;
    if v_job.status = 'published' and (
      select count(*) from public.event_participations
      where event_job_id = v_job.id and status = 'active'
    ) >= 50 then
      raise exception 'Published events cannot have more than 50 active participations';
    end if;
    select * into v_config from public.event_job_config_versions
    where id = v_job.current_config_version_id;
    insert into public.event_participations (
      event_job_id, shop_id, booth_number, event_zone, landmark,
      contact_name, contact_phone, start_date, end_date, rents_tank_from_us,
      config_version_id, tank_rental_unit_price_snapshot, payment_term_snapshot,
      allowed_payment_methods_snapshot, default_payment_method_snapshot,
      cash_reference_required_snapshot, cash_evidence_required_snapshot,
      bank_transfer_reference_required_snapshot, bank_transfer_evidence_required_snapshot,
      qr_reference_required_snapshot, qr_evidence_required_snapshot,
      settlement_policy_fingerprint, created_by, updated_by
    ) values (
      v_job.id, p_shop_id, nullif(trim(coalesce(p_booth_number, '')), ''),
      nullif(trim(coalesce(p_event_zone, '')), ''), nullif(trim(coalesce(p_landmark, '')), ''),
      nullif(trim(coalesce(p_contact_name, '')), ''), nullif(trim(coalesce(p_contact_phone, '')), ''),
      p_start_date, p_end_date, coalesce(p_rents_tank_from_us, false),
      case when v_job.status = 'published' then v_config.id end,
      case when v_job.status = 'published' then v_config.tank_rental_unit_price end,
      case when v_job.status = 'published' then v_config.payment_term end,
      case when v_job.status = 'published' then v_config.allowed_payment_methods end,
      case when v_job.status = 'published' then v_config.default_payment_method end,
      case when v_job.status = 'published' then v_config.cash_reference_required end,
      case when v_job.status = 'published' then v_config.cash_evidence_required end,
      case when v_job.status = 'published' then v_config.bank_transfer_reference_required end,
      case when v_job.status = 'published' then v_config.bank_transfer_evidence_required end,
      case when v_job.status = 'published' then v_config.qr_reference_required end,
      case when v_job.status = 'published' then v_config.qr_evidence_required end,
      case when v_job.status = 'published' then v_config.policy_fingerprint end,
      auth.uid(), auth.uid()
    ) returning * into v_participation;
  else
    select * into v_participation
    from public.event_participations where id = p_participation_id for update;
    if v_participation.id is null or v_participation.event_job_id <> p_event_job_id then
      raise exception 'The selected participation does not belong to this event';
    elsif v_participation.status <> 'active' then
      raise exception 'Cancelled participations are immutable';
    elsif v_job.status = 'published' and v_participation.shop_id <> p_shop_id then
      raise exception 'A published participation cannot change customer identity';
    end if;
    if v_job.status = 'published' and (
      nullif(trim(coalesce(v_shop.code, '')), '') is null
      or nullif(trim(coalesce(v_shop.name, '')), '') is null
      or nullif(trim(coalesce(p_contact_name, v_shop.contact_name, '')), '') is null
      or nullif(trim(coalesce(p_contact_phone, v_shop.contact_phone, '')), '') is null
    ) then
      raise exception 'Published participations require customer identity and contact details';
    end if;
    if v_job.status = 'published'
      and (p_start_date > v_participation.start_date or p_end_date < v_participation.end_date)
      and exists (
        select 1
        from public.delivery_events delivery
        join public.round_stops stop on stop.id = delivery.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where stop.event_participation_id = v_participation.id
          and (round.service_date < p_start_date or round.service_date > p_end_date)
      ) then
      raise exception 'Participation dates cannot exclude an existing delivery';
    end if;
    v_before := to_jsonb(v_participation);
    update public.event_participations
    set shop_id = case when v_job.status = 'draft' then p_shop_id else v_participation.shop_id end,
        booth_number = nullif(trim(coalesce(p_booth_number, '')), ''),
        event_zone = nullif(trim(coalesce(p_event_zone, '')), ''),
        landmark = nullif(trim(coalesce(p_landmark, '')), ''),
        contact_name = nullif(trim(coalesce(p_contact_name, '')), ''),
        contact_phone = nullif(trim(coalesce(p_contact_phone, '')), ''),
        start_date = p_start_date,
        end_date = p_end_date,
        rents_tank_from_us = coalesce(p_rents_tank_from_us, false),
        updated_by = auth.uid()
    where id = p_participation_id
    returning * into v_participation;
  end if;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value
  ) values (
    auth.uid(), 'event_participation', v_participation.id,
    case
      when p_participation_id is null then 'create'
      when v_job.status = 'draft' then 'update_draft'
      else 'update_published'
    end,
    v_before, to_jsonb(v_participation)
  );
  return v_participation;
end;
$$;

create or replace function public.publish_event_job(p_event_job_id uuid)
returns public.event_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_config public.event_job_config_versions%rowtype;
  v_participation_count integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can publish events';
  end if;
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if v_job.id is null then
    raise exception 'The selected event does not exist';
  elsif v_job.status <> 'draft' then
    raise exception 'Only draft events can be published';
  end if;
  select * into v_config from public.event_job_config_versions
  where id = v_job.current_config_version_id;
  if v_config.id is null or v_config.tank_rental_unit_price <= 0
    or v_config.payment_term <> 'end_of_day'
    or cardinality(v_config.allowed_payment_methods) = 0 then
    raise exception 'The event settlement configuration is incomplete';
  end if;
  select count(*) into v_participation_count
  from public.event_participations
  where event_job_id = v_job.id and status = 'active';
  if v_participation_count < 2 or v_participation_count > 50 then
    raise exception 'Published events require 2 to 50 active participations';
  end if;
  if exists (
    select 1
    from public.event_participations participation
    join public.shops shop on shop.id = participation.shop_id
    where participation.event_job_id = v_job.id
      and participation.status = 'active'
      and (
        shop.status <> 'active'
        or nullif(trim(coalesce(shop.code, '')), '') is null
        or nullif(trim(coalesce(shop.name, '')), '') is null
        or nullif(trim(coalesce(participation.contact_name, shop.contact_name, '')), '') is null
        or nullif(trim(coalesce(participation.contact_phone, shop.contact_phone, '')), '') is null
        or participation.start_date < v_job.start_date
        or participation.end_date > v_job.end_date
      )
  ) then
    raise exception 'Every participation requires an active customer, identity, contact, and valid dates';
  end if;
  if exists (
    select 1
    from public.ice_types ice
    cross join generate_series(
      v_job.start_date::timestamp,
      v_job.end_date::timestamp,
      interval '1 day'
    ) service_day
    where ice.is_active
      and not exists (
        select 1
        from public.ice_type_prices price
        where price.ice_type_id = ice.id
          and price.is_active
          and price.valid_from <= service_day::date
          and (price.valid_to is null or price.valid_to >= service_day::date)
      )
  ) then
    raise exception 'Standard prices must cover every active ice type and event service date';
  end if;

  update public.event_participations
  set config_version_id = v_config.id,
      tank_rental_unit_price_snapshot = v_config.tank_rental_unit_price,
      payment_term_snapshot = v_config.payment_term,
      allowed_payment_methods_snapshot = v_config.allowed_payment_methods,
      default_payment_method_snapshot = v_config.default_payment_method,
      cash_reference_required_snapshot = v_config.cash_reference_required,
      cash_evidence_required_snapshot = v_config.cash_evidence_required,
      bank_transfer_reference_required_snapshot = v_config.bank_transfer_reference_required,
      bank_transfer_evidence_required_snapshot = v_config.bank_transfer_evidence_required,
      qr_reference_required_snapshot = v_config.qr_reference_required,
      qr_evidence_required_snapshot = v_config.qr_evidence_required,
      settlement_policy_fingerprint = v_config.policy_fingerprint,
      updated_by = auth.uid()
  where event_job_id = v_job.id and status = 'active';

  perform set_config('app.event_lifecycle_rpc', 'on', true);
  update public.event_jobs
  set status = 'published', published_by = auth.uid(), published_at = now()
  where id = v_job.id
  returning * into v_job;
  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value
  ) values (
    auth.uid(), 'event_job', v_job.id, 'publish',
    jsonb_build_object('status', 'draft'), to_jsonb(v_job)
  );
  return v_job;
end;
$$;

create or replace function public.cancel_event_job(
  p_event_job_id uuid,
  p_reason text
)
returns public.event_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_before jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can cancel events';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A cancellation reason is required';
  end if;
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if v_job.id is null then
    raise exception 'The selected event does not exist';
  elsif v_job.status = 'cancelled' then
    raise exception 'The event is already cancelled';
  end if;
  v_before := to_jsonb(v_job);
  perform set_config('app.event_lifecycle_rpc', 'on', true);
  update public.event_jobs
  set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
      cancellation_reason = trim(p_reason)
  where id = p_event_job_id
  returning * into v_job;
  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value, reason
  ) values (
    auth.uid(), 'event_job', v_job.id, 'cancel', v_before, to_jsonb(v_job), trim(p_reason)
  );
  return v_job;
end;
$$;

create or replace function public.cancel_event_participation(
  p_participation_id uuid,
  p_reason text
)
returns public.event_participations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_job_id uuid;
  v_job public.event_jobs%rowtype;
  v_participation public.event_participations%rowtype;
  v_before jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can cancel event participations';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A cancellation reason is required';
  end if;
  select participation.event_job_id into v_event_job_id
  from public.event_participations participation
  where participation.id = p_participation_id;
  if v_event_job_id is null then
    raise exception 'The selected participation does not exist';
  end if;
  select job.* into v_job
  from public.event_jobs job
  where job.id = v_event_job_id
  for update;
  select * into v_participation
  from public.event_participations
  where id = p_participation_id
  for update;
  if v_participation.id is null or v_participation.event_job_id <> v_job.id then
    raise exception 'The selected participation does not exist';
  elsif v_participation.status = 'cancelled' then
    raise exception 'The participation is already cancelled';
  end if;
  v_before := to_jsonb(v_participation);
  perform set_config('app.event_lifecycle_rpc', 'on', true);
  update public.event_participations
  set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
      cancellation_reason = trim(p_reason), updated_by = auth.uid()
  where id = p_participation_id
  returning * into v_participation;
  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value, reason
  ) values (
    auth.uid(), 'event_participation', v_participation.id, 'cancel',
    v_before, to_jsonb(v_participation), trim(p_reason)
  );
  return v_participation;
end;
$$;

create or replace function public.get_event_delivery_capability()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings public.event_delivery_feature_settings%rowtype;
begin
  if not public.is_active_user() then
    raise exception 'Only active users can inspect event delivery capability';
  end if;
  select * into v_settings
  from public.event_delivery_feature_settings
  where singleton;
  return jsonb_build_object(
    'schema_version', v_settings.schema_version,
    'lifecycle_enabled', v_settings.lifecycle_enabled,
    'event_stops_enabled', v_settings.event_stops_enabled,
    'event_ice_delivery_enabled', v_settings.event_ice_delivery_enabled,
    'event_tank_rental_enabled', v_settings.event_tank_rental_enabled,
    'online_only', true
  );
end;
$$;

alter table public.event_jobs enable row level security;
alter table public.event_job_config_versions enable row level security;
alter table public.event_participations enable row level security;
alter table public.event_delivery_feature_settings enable row level security;

create policy "admins and leads read event jobs" on public.event_jobs for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "admins and leads read event configurations" on public.event_job_config_versions for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "admins and leads read event participations" on public.event_participations for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));

revoke all on function public.normalize_event_payment_methods(public.payment_method[]) from public, anon, authenticated;
revoke all on function public.event_configuration_fingerprint(
  numeric, public.payment_method[], public.payment_method,
  boolean, boolean, boolean, boolean, boolean, boolean
) from public, anon, authenticated;
revoke all on function public.save_event_job_metadata(
  uuid, text, text, text, text, text, date, date, text
) from public, anon;
revoke all on function public.save_event_job(
  uuid, text, text, text, text, text, date, date, text, numeric,
  public.payment_method[], public.payment_method,
  boolean, boolean, boolean, boolean, boolean, boolean
) from public, anon;
revoke all on function public.create_event_job_config_version(
  uuid, numeric, public.payment_method[], public.payment_method,
  boolean, boolean, boolean, boolean, boolean, boolean
) from public, anon;
revoke all on function public.save_event_participation(
  uuid, uuid, uuid, text, text, text, text, text, date, date, boolean
) from public, anon;
revoke all on function public.publish_event_job(uuid) from public, anon;
revoke all on function public.cancel_event_job(uuid, text) from public, anon;
revoke all on function public.cancel_event_participation(uuid, text) from public, anon;
revoke all on function public.get_event_delivery_capability() from public, anon;

grant execute on function public.save_event_job(
  uuid, text, text, text, text, text, date, date, text, numeric,
  public.payment_method[], public.payment_method,
  boolean, boolean, boolean, boolean, boolean, boolean
) to authenticated;
grant execute on function public.save_event_job_metadata(
  uuid, text, text, text, text, text, date, date, text
) to authenticated;
grant execute on function public.create_event_job_config_version(
  uuid, numeric, public.payment_method[], public.payment_method,
  boolean, boolean, boolean, boolean, boolean, boolean
) to authenticated;
grant execute on function public.save_event_participation(
  uuid, uuid, uuid, text, text, text, text, text, date, date, boolean
) to authenticated;
grant execute on function public.publish_event_job(uuid) to authenticated;
grant execute on function public.cancel_event_job(uuid, text) to authenticated;
grant execute on function public.cancel_event_participation(uuid, text) to authenticated;
grant execute on function public.get_event_delivery_capability() to authenticated;

notify pgrst, 'reload schema';
