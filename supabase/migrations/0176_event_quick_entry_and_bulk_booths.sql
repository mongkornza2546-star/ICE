-- Optional event metadata, free-text event shops, and atomic bulk booth creation.
-- Existing regular shops keep their location, identity, and settlement behavior.
alter table public.event_jobs drop constraint event_jobs_organizer_name_check;
alter table public.event_jobs drop constraint event_jobs_contact_name_check;
alter table public.event_jobs drop constraint event_jobs_contact_phone_check;
alter table public.event_jobs drop constraint event_jobs_location_check;

alter table public.shops add column event_job_id uuid references public.event_jobs(id) on delete restrict;
create index shops_event_job_idx on public.shops(event_job_id) where event_job_id is not null;

create table public.event_shop_creation_requests (
  request_id uuid primary key,
  event_job_id uuid not null references public.event_jobs(id) on delete restrict,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.event_shop_creation_requests enable row level security;
revoke all on public.event_shop_creation_requests from anon, authenticated;


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
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Invalid event date range';
  end if;

  if p_event_job_id is null then
    insert into public.event_jobs (
      name, organizer_name, contact_name, contact_phone, location,
      start_date, end_date, notes, created_by
    ) values (
      coalesce(nullif(trim(p_name), ''), 'อีเวนต์ ' || p_start_date::text), trim(coalesce(p_organizer_name, '')), trim(coalesce(p_contact_name, '')), trim(coalesce(p_contact_phone, '')), trim(coalesce(p_location, '')),
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
    set name = coalesce(nullif(trim(p_name), ''), 'อีเวนต์ ' || p_start_date::text),
        organizer_name = trim(coalesce(p_organizer_name, '')),
        contact_name = trim(coalesce(p_contact_name, '')),
        contact_phone = trim(coalesce(p_contact_phone, '')),
        location = trim(coalesce(p_location, '')),
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
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Invalid event date range';
  end if;
  p_tank_rental_unit_price := coalesce(p_tank_rental_unit_price, 100);
  if p_tank_rental_unit_price <= 0 then
    raise exception 'Tank rental unit price must be greater than zero';
  end if;

  v_methods := public.normalize_event_payment_methods(p_allowed_payment_methods);
  if cardinality(v_methods) = 0 then v_methods := array['cash']::public.payment_method[]; end if;
  p_default_payment_method := coalesce(p_default_payment_method, v_methods[1]);
  if p_default_payment_method is null
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
      coalesce(nullif(trim(p_name), ''), 'อีเวนต์ ' || p_start_date::text), trim(coalesce(p_organizer_name, '')), trim(coalesce(p_contact_name, '')), trim(coalesce(p_contact_phone, '')), trim(coalesce(p_location, '')),
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
    set name = coalesce(nullif(trim(p_name), ''), 'อีเวนต์ ' || p_start_date::text),
        organizer_name = trim(coalesce(p_organizer_name, '')),
        contact_name = trim(coalesce(p_contact_name, '')),
        contact_phone = trim(coalesce(p_contact_phone, '')),
        location = trim(coalesce(p_location, '')),
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
  if v_shop.event_job_id is not null and v_shop.event_job_id <> v_job.id then
    raise exception 'This shop belongs to another event';
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
    ) then
      raise exception 'Published participations require customer identity';
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
    ) then
      raise exception 'Published participations require customer identity';
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

create or replace function public.event_publish_readiness(p_event_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_config public.event_job_config_versions%rowtype;
  v_participation_count integer;
  v_config_ready boolean;
  v_participations_ready boolean;
  v_prices_ready boolean;
  v_invalid_participations jsonb;
  v_price_gaps jsonb;
begin
  select * into v_job
  from public.event_jobs
  where id = p_event_job_id;

  if v_job.id is null then
    raise exception 'The selected event does not exist';
  elsif v_job.status <> 'draft' then
    return jsonb_build_object(
      'is_ready', false,
      'checks', jsonb_build_array(
        jsonb_build_object(
          'code', 'draft_status',
          'ok', false,
          'message', 'เผยแพร่ได้เฉพาะงานฉบับร่าง'
        )
      )
    );
  end if;

  select * into v_config
  from public.event_job_config_versions
  where id = v_job.current_config_version_id;

  v_config_ready := v_config.id is not null
    and v_config.tank_rental_unit_price > 0
    and v_config.payment_term = 'end_of_day'
    and cardinality(v_config.allowed_payment_methods) > 0
    and v_config.default_payment_method = any(v_config.allowed_payment_methods);

  select count(*) into v_participation_count
  from public.event_participations
  where event_job_id = v_job.id
    and status = 'active';

  select coalesce(jsonb_agg(problem order by problem ->> 'shop_code'), '[]'::jsonb)
  into v_invalid_participations
  from (
    select jsonb_build_object(
      'participation_id', participation.id,
      'shop_id', shop.id,
      'shop_code', shop.code,
      'shop_name', shop.name,
      'issues', to_jsonb(array_remove(array[
        case when shop.status <> 'active' then 'inactive_shop' end,
        case when nullif(trim(coalesce(shop.code, '')), '') is null then 'missing_shop_code' end,
        case when nullif(trim(coalesce(shop.name, '')), '') is null then 'missing_shop_name' end,
        case when participation.start_date < v_job.start_date
          or participation.end_date > v_job.end_date
          or participation.end_date < participation.start_date then 'invalid_date_range' end
      ], null))
    ) as problem
    from public.event_participations participation
    join public.shops shop on shop.id = participation.shop_id
    where participation.event_job_id = v_job.id
      and participation.status = 'active'
      and (
        shop.status <> 'active'
        or nullif(trim(coalesce(shop.code, '')), '') is null
        or nullif(trim(coalesce(shop.name, '')), '') is null
        or participation.start_date < v_job.start_date
        or participation.end_date > v_job.end_date
        or participation.end_date < participation.start_date
      )
  ) problems;
  v_participations_ready := jsonb_array_length(v_invalid_participations) = 0;

  with missing_days as (
    select ice.id as ice_type_id, ice.code as ice_type_code, ice.name as ice_type_name,
      service_day::date as service_date
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
  ), numbered_days as (
    select missing_days.*,
      service_date - row_number() over (
        partition by ice_type_id order by service_date
      )::integer as range_group
    from missing_days
  ), missing_ranges as (
    select ice_type_id, ice_type_code, ice_type_name,
      min(service_date) as start_date,
      max(service_date) as end_date
    from numbered_days
    group by ice_type_id, ice_type_code, ice_type_name, range_group
  ), grouped_gaps as (
    select ice_type_id, ice_type_code, ice_type_name,
      jsonb_agg(
        jsonb_build_object('start_date', start_date, 'end_date', end_date)
        order by start_date
      ) as missing_ranges
    from missing_ranges
    group by ice_type_id, ice_type_code, ice_type_name
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'ice_type_id', ice_type_id,
      'ice_type_code', ice_type_code,
      'ice_type_name', ice_type_name,
      'missing_ranges', missing_ranges
    ) order by ice_type_code
  ), '[]'::jsonb)
  into v_price_gaps
  from grouped_gaps;
  v_prices_ready := jsonb_array_length(v_price_gaps) = 0;

  return jsonb_build_object(
    'is_ready',
      v_job.status = 'draft'
      and v_config_ready
      and v_participation_count >= 1
      and v_participations_ready
      and v_prices_ready,
    'checks', jsonb_build_array(
      jsonb_build_object(
        'code', 'draft_status',
        'ok', v_job.status = 'draft',
        'message', case when v_job.status = 'draft'
          then 'งานอยู่ในสถานะฉบับร่าง'
          else 'เผยแพร่ได้เฉพาะงานฉบับร่าง'
        end
      ),
      jsonb_build_object(
        'code', 'settlement_configuration',
        'ok', v_config_ready,
        'message', case when v_config_ready
          then 'ตั้งค่านโยบายการชำระเงินแล้ว'
          else 'รอแอดมินตั้งค่านโยบายการชำระเงิน'
        end
      ),
      jsonb_build_object(
        'code', 'participation_count',
        'ok', v_participation_count >= 1,
        'message', case when v_participation_count >= 1
          then 'จำนวนร้านอยู่ในช่วงที่เผยแพร่ได้'
          else 'ต้องมีร้านที่ใช้งานอย่างน้อย 1 ร้าน'
        end,
        'actual', v_participation_count,
        'minimum', 1
      ),
      jsonb_build_object(
        'code', 'participation_details',
        'ok', v_participations_ready,
        'message', case when v_participations_ready
          then 'ข้อมูลร้านและวันที่พร้อม'
          else 'มีร้านที่ข้อมูลยังไม่พร้อม'
        end,
        'items', v_invalid_participations
      ),
      jsonb_build_object(
        'code', 'standard_price_coverage',
        'ok', v_prices_ready,
        'message', case when v_prices_ready
          then 'ราคากลางครอบคลุมทุกวันของงาน'
          else 'ราคากลางยังไม่ครอบคลุมทุกวันของงาน'
        end,
        'items', v_price_gaps
      )
    )
  );
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
  v_readiness jsonb;
  v_check jsonb;
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

  v_readiness := public.event_publish_readiness(v_job.id);
  if not (v_readiness ->> 'is_ready')::boolean then
    select value into v_check
    from jsonb_array_elements(v_readiness -> 'checks') value
    where value ->> 'code' = 'settlement_configuration';
    if not (v_check ->> 'ok')::boolean then
      raise exception 'The event settlement configuration is incomplete';
    end if;
    select value into v_check
    from jsonb_array_elements(v_readiness -> 'checks') value
    where value ->> 'code' = 'participation_count';
    if not (v_check ->> 'ok')::boolean then
      raise exception 'Published events require at least 1 active participation';
    end if;
    select value into v_check
    from jsonb_array_elements(v_readiness -> 'checks') value
    where value ->> 'code' = 'participation_details';
    if not (v_check ->> 'ok')::boolean then
      raise exception 'Every participation requires an active customer, identity, and valid dates';
    end if;
    raise exception 'Standard prices must cover every active ice type and event service date';
  end if;

  select * into v_config
  from public.event_job_config_versions
  where id = v_job.current_config_version_id;

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

create or replace function public.sync_daily_round_destinations(
  p_round_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_added_count integer := 0;
  v_event_added_count integer := 0;
  v_event_job_id uuid;
  v_event_participation_id uuid;
  v_event_stops_enabled boolean := false;
  v_lock_service_date date;
  v_max_sequence integer;
  v_round public.delivery_rounds%rowtype;
begin
  select round.service_date into v_lock_service_date
  from public.delivery_rounds round
  where round.id = p_round_id;

  if not found then
    raise exception 'The selected delivery round does not exist';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_lock_service_date::text, 0));

  select round.* into v_round
  from public.delivery_rounds round
  where round.id = p_round_id
  for update;

  if not found then
    raise exception 'The selected delivery round does not exist';
  elsif v_round.service_date is distinct from v_lock_service_date then
    raise exception 'The delivery round changed service date; retry the request';
  end if;

  if not public.is_active_user()
    or (public.current_app_role() not in ('admin', 'round_lead')
      and not public.is_round_member(p_round_id)) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  if v_round.round_type <> 'daily'
    or v_round.status <> 'open'
    or v_round.cancelled_at is not null then
    return 0;
  end if;

  insert into public.delivery_round_members (round_id, user_id)
  select p_round_id, app_user.id
  from public.users app_user
  where app_user.is_active
    and app_user.role in ('courier', 'round_lead', 'admin')
  on conflict (round_id, user_id) do nothing;

  select coalesce(max(stop.sequence_no), 0)
  into v_max_sequence
  from public.round_stops stop
  where stop.round_id = p_round_id;

  insert into public.round_stops (
    round_id,
    shop_id,
    shop_code_snapshot,
    shop_name_snapshot,
    building_id_snapshot,
    building_name_snapshot,
    floor_or_zone_snapshot,
    sequence_no,
    updated_by,
    destination_kind,
    event_participation_id,
    is_operational
  )
  select
    p_round_id,
    shop.id,
    shop.code,
    shop.name,
    shop.building_id,
    building.name,
    shop.floor_or_zone,
    (v_max_sequence + row_number() over (
      order by building.sort_order, zone.sort_order,
        shop.delivery_sequence nulls last, shop.code, shop.id
    ))::integer,
    auth.uid(),
    'regular',
    null,
    true
  from public.shops shop
  join public.buildings building
    on building.id = shop.building_id and building.is_active
  join public.building_zones zone on zone.id = shop.zone_id
  where shop.status = 'active'
    and shop.event_job_id is null
  on conflict (round_id, shop_id) where destination_kind = 'regular' do nothing;

  get diagnostics v_added_count = row_count;

  select coalesce(settings.event_stops_enabled, false)
  into v_event_stops_enabled
  from public.event_delivery_feature_settings settings
  where settings.singleton;

  if not coalesce(v_event_stops_enabled, false) then
    return v_added_count;
  end if;

  -- Lock every job that can produce a stop today, plus jobs already represented
  -- in the round. The latter set is required for safe deactivation.
  for v_event_job_id in
    with relevant_job_ids as (
      select job.id
      from public.event_jobs job
      where v_round.service_date between job.start_date and job.end_date
      union
      select participation.event_job_id
      from public.round_stops stop
      join public.event_participations participation
        on participation.id = stop.event_participation_id
      where stop.round_id = p_round_id
        and stop.destination_kind = 'event'
    )
    select job.id
    from public.event_jobs job
    join relevant_job_ids relevant on relevant.id = job.id
    order by job.id
    for update of job
  loop
    null;
  end loop;

  -- Job locks serialize participation lifecycle writers. Lock all participation
  -- rows for today's jobs, not only currently eligible rows, so a concurrent date
  -- expansion cannot be missed by reactivation.
  for v_event_participation_id in
    with relevant_participation_ids as (
      select participation.id
      from public.event_participations participation
      join public.event_jobs job on job.id = participation.event_job_id
      where v_round.service_date between job.start_date and job.end_date
      union
      select stop.event_participation_id
      from public.round_stops stop
      where stop.round_id = p_round_id
        and stop.destination_kind = 'event'
        and stop.event_participation_id is not null
    )
    select participation.id
    from public.event_participations participation
    join relevant_participation_ids relevant on relevant.id = participation.id
    order by participation.id
    for update of participation
  loop
    null;
  end loop;

  select coalesce(max(stop.sequence_no), 0)
  into v_max_sequence
  from public.round_stops stop
  where stop.round_id = p_round_id;

  insert into public.round_stops (
    round_id,
    shop_id,
    shop_code_snapshot,
    shop_name_snapshot,
    building_id_snapshot,
    building_name_snapshot,
    floor_or_zone_snapshot,
    sequence_no,
    updated_by,
    destination_kind,
    event_participation_id,
    is_operational,
    event_job_name_snapshot,
    event_location_snapshot,
    event_booth_snapshot,
    event_zone_snapshot,
    event_landmark_snapshot,
    event_contact_name_snapshot,
    event_contact_phone_snapshot
  )
  select
    p_round_id,
    shop.id,
    shop.code,
    shop.name,
    shop.building_id,
    building.name,
    shop.floor_or_zone,
    (v_max_sequence + row_number() over (
      order by job.id, participation.id
    ))::integer,
    auth.uid(),
    'event',
    participation.id,
    true,
    job.name,
    job.location,
    participation.booth_number,
    participation.event_zone,
    participation.landmark,
    coalesce(participation.contact_name, shop.contact_name),
    coalesce(participation.contact_phone, shop.contact_phone)
  from public.event_participations participation
  join public.event_jobs job on job.id = participation.event_job_id
  join public.shops shop on shop.id = participation.shop_id
  join public.buildings building on building.id = shop.building_id
  where job.status = 'published'
    and participation.status = 'active'
    and v_round.service_date between job.start_date and job.end_date
    and v_round.service_date between participation.start_date and participation.end_date
  on conflict (round_id, event_participation_id)
    where destination_kind = 'event' do nothing;

  get diagnostics v_event_added_count = row_count;

  update public.round_stops stop
  set is_operational = exists (
        select 1
        from public.event_participations participation
        join public.event_jobs job on job.id = participation.event_job_id
        where participation.id = stop.event_participation_id
          and job.status = 'published'
          and participation.status = 'active'
          and v_round.service_date between job.start_date and job.end_date
          and v_round.service_date between participation.start_date and participation.end_date
      ),
      updated_by = auth.uid(),
      updated_at = now()
  where stop.round_id = p_round_id
    and stop.destination_kind = 'event'
    and stop.is_operational is distinct from exists (
      select 1
      from public.event_participations participation
      join public.event_jobs job on job.id = participation.event_job_id
      where participation.id = stop.event_participation_id
        and job.status = 'published'
        and participation.status = 'active'
        and v_round.service_date between job.start_date and job.end_date
        and v_round.service_date between participation.start_date and participation.end_date
    );

  return v_added_count + v_event_added_count;
end;
$$;

-- One transaction creates customers and participations; a retry returns the
-- original result. Locking the event also serializes duplicate-booth checks.
create or replace function public.create_event_shops(
  p_event_job_id uuid,
  p_request_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_request public.event_shop_creation_requests%rowtype;
  v_row jsonb;
  v_shop_id uuid;
  v_building_id uuid;
  v_zone_id uuid;
  v_booth text;
  v_zone text;
  v_name text;
  v_created integer := 0;
  v_skipped integer := 0;
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can create event shops';
  end if;
  if p_request_id is null then raise exception 'A request ID is required'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Expected an array of event shops';
  end if;
  if jsonb_array_length(p_rows) not between 1 and 1000 then
    raise exception 'Create between 1 and 1000 event shops per request';
  end if;
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if v_job.id is null then raise exception 'The selected event does not exist'; end if;
  select * into v_request from public.event_shop_creation_requests where request_id = p_request_id;
  if found then
    if v_request.event_job_id <> p_event_job_id or v_request.payload <> p_rows then
      raise exception 'This request ID was already used for different input';
    end if;
    return v_request.result;
  end if;
  if v_job.status = 'cancelled' then raise exception 'Cancelled events cannot accept participations'; end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object' then raise exception 'Invalid event shop row'; end if;
    if nullif(v_row ->> 'start_date', '') is null or nullif(v_row ->> 'end_date', '') is null
      or (v_row ->> 'start_date')::date < v_job.start_date
      or (v_row ->> 'end_date')::date > v_job.end_date
      or (v_row ->> 'end_date')::date < (v_row ->> 'start_date')::date then
      raise exception 'Participation dates must be within the event date range';
    end if;
    v_booth := nullif(upper(trim(v_row ->> 'booth_number')), '');
    v_zone := trim(coalesce(v_row ->> 'event_zone', ''));
    if v_booth is not null and exists (
      select 1 from public.event_participations
      where event_job_id = v_job.id
        and upper(trim(booth_number)) = v_booth
        and upper(trim(coalesce(event_zone, ''))) = upper(v_zone)
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Use the real building if its code/name matches the supplied location.
    -- Otherwise provision an event location so no location entry is mandatory.
    select id into v_building_id from public.buildings
    where is_active and (
      upper(name) = upper(coalesce(nullif(v_zone, ''), v_job.location))
      or upper(code) = upper(coalesce(nullif(v_zone, ''), v_job.location))
      or code = 'EVENT-' || v_job.id::text
    ) order by case when code = 'EVENT-' || v_job.id::text then 1 else 0 end, id limit 1;
    if v_building_id is null then
      insert into public.buildings(code, name)
      values ('EVENT-' || v_job.id::text, coalesce(nullif(v_zone, ''), nullif(v_job.location, ''), v_job.name))
      returning id into v_building_id;
    end if;
    -- Serialize zone ordering against other event creations at this building.
    perform 1 from public.buildings where id = v_building_id for update;
    select id into v_zone_id from public.building_zones
    where building_id = v_building_id and code = 'EVENT-' || v_job.id::text;
    if v_zone_id is null then
      insert into public.building_zones(building_id, code, name, sort_order)
      select v_building_id, 'EVENT-' || v_job.id::text, v_job.name || ' · ' || v_job.id::text,
        coalesce(max(sort_order), 0) + 1
      from public.building_zones where building_id = v_building_id
      returning id into v_zone_id;
    end if;
    v_shop_id := gen_random_uuid();
    v_name := coalesce(nullif(trim(v_row ->> 'name'), ''),
      case when v_booth is not null then 'บูธ ' || v_booth end,
      'ร้านใหม่ ' || left(v_shop_id::text, 8));
    insert into public.shops(id, code, name, zone_id, event_job_id, contact_name, contact_phone)
    values (v_shop_id, 'EV-' || v_shop_id::text, v_name, v_zone_id, v_job.id,
      nullif(trim(v_row ->> 'contact_name'), ''), nullif(trim(v_row ->> 'contact_phone'), ''));
    perform public.save_event_participation(
      null, v_job.id, v_shop_id, v_booth, v_zone, v_row ->> 'landmark',
      v_row ->> 'contact_name', v_row ->> 'contact_phone',
      (v_row ->> 'start_date')::date, (v_row ->> 'end_date')::date, false
    );
    v_created := v_created + 1;
  end loop;
  v_result := jsonb_build_object('created_count', v_created, 'skipped_count', v_skipped);
  insert into public.event_shop_creation_requests(request_id, event_job_id, payload, result)
  values (p_request_id, v_job.id, p_rows, v_result);
  return v_result;
end;
$$;

revoke all on function public.create_event_shops(uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_event_shops(uuid, uuid, jsonb) to authenticated;

-- Cover initial round creation and older clients as well as destination sync.
-- Preserve deployed bodies (including wrappers and locking fixes).
do $regular_shop_scope$
declare
  v_signature text;
  v_definition text;
  v_updated text;
begin
  foreach v_signature in array array[
    'public.ensure_daily_delivery_round_before_area_order(date)',
    'public.create_delivery_round(date,text,uuid[],jsonb)',
    'public.sync_daily_round_active_shops(uuid)'
  ] loop
    select pg_get_functiondef(v_signature::regprocedure) into v_definition;
    v_updated := replace(v_definition, 'where s.status = ''active''',
      'where s.status = ''active'' and s.event_job_id is null');
    v_updated := replace(v_updated, 'where shop.status = ''active''',
      'where shop.status = ''active'' and shop.event_job_id is null');
    if v_updated = v_definition then
      raise exception 'Cannot apply event-only shop filter to %', v_signature;
    end if;
    execute v_updated;
  end loop;
end;
$regular_shop_scope$;

create or replace function public.get_event_management_detail(p_event_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_config public.event_job_config_versions%rowtype;
  v_participations jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can manage events';
  end if;

  select * into v_job
  from public.event_jobs
  where id = p_event_job_id;
  if v_job.id is null then
    raise exception 'The selected event does not exist';
  end if;

  select * into v_config
  from public.event_job_config_versions
  where id = v_job.current_config_version_id;

  select coalesce(jsonb_agg(
    to_jsonb(participation) || jsonb_build_object(
      'shop_code', shop.code,
      'shop_name', shop.name,
      'shop_event_job_id', shop.event_job_id,
      'shop_status', shop.status,
      'shop_contact_name', shop.contact_name,
      'shop_contact_phone', shop.contact_phone
    ) order by participation.status, shop.code
  ), '[]'::jsonb)
  into v_participations
  from public.event_participations participation
  join public.shops shop on shop.id = participation.shop_id
  where participation.event_job_id = v_job.id;

  return jsonb_build_object(
    'event', to_jsonb(v_job),
    'configuration', case when v_config.id is null then null else to_jsonb(v_config) end,
    'participations', v_participations,
    'readiness', public.event_publish_readiness(v_job.id)
  );
end;
$$;

-- Rename only an existing event-owned customer, atomically with its participation.
-- Keep the legacy RPC signature and immutable delivery snapshots intact.
create or replace function public.save_event_participation_with_shop_name(
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
  p_rents_tank_from_us boolean,
  p_shop_name text
)
returns public.event_participations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participation public.event_participations%rowtype;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can edit event shops';
  end if;
  if nullif(trim(p_shop_name), '') is null then
    raise exception 'An event shop name is required';
  end if;

  -- Use the same job -> participation lock order as the lifecycle RPCs.
  perform 1 from public.event_jobs where id = p_event_job_id for update;
  select * into v_participation from public.event_participations
  where id = p_participation_id and event_job_id = p_event_job_id
    and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'The selected participation does not belong to this event and shop';
  end if;
  perform 1 from public.shops
  where id = p_shop_id and event_job_id = p_event_job_id
  for update;
  if not found then
    raise exception 'Only an event-owned shop can be renamed here';
  end if;

  v_participation := public.save_event_participation(
    p_participation_id, p_event_job_id, p_shop_id, p_booth_number,
    p_event_zone, p_landmark, p_contact_name, p_contact_phone,
    p_start_date, p_end_date, p_rents_tank_from_us
  );
  -- The existing shops_audit_update trigger records the name change.
  update public.shops set name = trim(p_shop_name)
  where id = p_shop_id and name is distinct from trim(p_shop_name);
  return v_participation;
end;
$$;

revoke all on function public.save_event_participation_with_shop_name(uuid, uuid, uuid, text, text, text, text, text, date, date, boolean, text) from public, anon;
grant execute on function public.save_event_participation_with_shop_name(uuid, uuid, uuid, text, text, text, text, text, date, date, boolean, text) to authenticated;

notify pgrst, 'reload schema';
