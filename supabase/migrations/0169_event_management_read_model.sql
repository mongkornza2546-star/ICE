-- Event management read model and publish-readiness contract.

update public.event_delivery_feature_settings
set schema_version = greatest(schema_version, 5),
    updated_at = now()
where singleton;

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
        case when nullif(trim(coalesce(participation.contact_name, shop.contact_name, '')), '') is null then 'missing_contact_name' end,
        case when nullif(trim(coalesce(participation.contact_phone, shop.contact_phone, '')), '') is null then 'missing_contact_phone' end,
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
        or nullif(trim(coalesce(participation.contact_name, shop.contact_name, '')), '') is null
        or nullif(trim(coalesce(participation.contact_phone, shop.contact_phone, '')), '') is null
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
      and v_participation_count between 2 and 50
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
        'ok', v_participation_count between 2 and 50,
        'message', case when v_participation_count between 2 and 50
          then 'จำนวนร้านอยู่ในช่วงที่เผยแพร่ได้'
          else 'ต้องมีร้านที่ใช้งาน 2–50 ร้าน'
        end,
        'actual', v_participation_count,
        'minimum', 2,
        'maximum', 50
      ),
      jsonb_build_object(
        'code', 'participation_details',
        'ok', v_participations_ready,
        'message', case when v_participations_ready
          then 'ข้อมูลร้านและผู้ติดต่อครบ'
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

create or replace function public.get_event_management_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_events jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can manage events';
  end if;

  select coalesce(jsonb_agg(event_summary order by event_summary ->> 'updated_at' desc), '[]'::jsonb)
  into v_events
  from (
    select to_jsonb(job) || jsonb_build_object(
      'active_participation_count', count(participation.id),
      'has_configuration', job.current_config_version_id is not null
    ) as event_summary
    from public.event_jobs job
    left join public.event_participations participation
      on participation.event_job_id = job.id
      and participation.status = 'active'
    group by job.id
  ) summaries;

  return jsonb_build_object('events', v_events);
end;
$$;

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
      raise exception 'Published events require 2 to 50 active participations';
    end if;
    select value into v_check
    from jsonb_array_elements(v_readiness -> 'checks') value
    where value ->> 'code' = 'participation_details';
    if not (v_check ->> 'ok')::boolean then
      raise exception 'Every participation requires an active customer, identity, contact, and valid dates';
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

revoke all on function public.event_publish_readiness(uuid) from public, anon, authenticated;
revoke all on function public.get_event_management_overview() from public, anon;
revoke all on function public.get_event_management_detail(uuid) from public, anon;
revoke all on function public.publish_event_job(uuid) from public, anon;

grant execute on function public.get_event_management_overview() to authenticated;
grant execute on function public.get_event_management_detail(uuid) to authenticated;
grant execute on function public.publish_event_job(uuid) to authenticated;

notify pgrst, 'reload schema';
