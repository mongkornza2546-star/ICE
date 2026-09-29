-- Employee event operations use the existing event, shop, tank-register and
-- delivery-charge records. Public RPCs authorize their own role before calling
-- private write helpers, which are not executable by API roles.

-- Keep destination provisioning identical for admin bulk entry and employee booths.
-- Public callers authorize and validate the event before reaching this private helper.
create or replace function public.resolve_event_shop_zone_internal(
  p_event_job_id uuid, p_event_zone text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_job public.event_jobs%rowtype;
  v_zone text := trim(coalesce(p_event_zone, ''));
  v_building_id uuid;
  v_zone_id uuid;
  v_zone_code text;
  v_zone_name text;
begin
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if not found then raise exception 'The selected event does not exist'; end if;

  -- Resolve building:
  -- 1. Use real building if its name or code matches the supplied event location.
  -- 2. Otherwise use or provision an event building so no manual location setup is required.
  select id into v_building_id from public.buildings
  where (
    (is_active and (
      upper(name) = upper(coalesce(nullif(v_job.location, ''), nullif(v_zone, ''), v_job.name))
      or upper(code) = upper(coalesce(nullif(v_job.location, ''), nullif(v_zone, ''), v_job.name))
    ))
    or upper(code) = upper('EVENT-' || v_job.id::text)
  )
  order by
    case
      when nullif(v_job.location, '') is not null
        and (upper(name) = upper(v_job.location) or upper(code) = upper(v_job.location)) then 0
      when upper(code) = upper('EVENT-' || v_job.id::text) then 1
      else 2
    end,
    id
  limit 1;

  if v_building_id is null then
    insert into public.buildings(code, name)
    values ('EVENT-' || v_job.id::text, coalesce(nullif(v_job.location, ''), nullif(v_zone, ''), v_job.name))
    returning id into v_building_id;
  else
    update public.buildings set is_active = true where id = v_building_id and not is_active;
  end if;

  -- Serialize zone ordering against other event creations at this building.
  perform 1 from public.buildings where id = v_building_id for update;

  v_zone_code := 'EVENT-' || v_job.id::text || case when nullif(v_zone, '') is not null then '-' || md5(v_zone) else '' end;
  v_zone_name := coalesce(nullif(v_zone, ''), nullif(v_job.location, ''), v_job.name);

  select id into v_zone_id from public.building_zones
  where building_id = v_building_id
    and (
      upper(code) = upper(v_zone_code)
      or upper(name) = upper(v_zone_name)
    )
  order by
    case when upper(code) = upper(v_zone_code) then 0 else 1 end,
    id
  limit 1;

  if v_zone_id is null then
    insert into public.building_zones(building_id, code, name, sort_order)
    select
      v_building_id,
      v_zone_code,
      v_zone_name,
      coalesce(max(sort_order), 0) + 1
    from public.building_zones
    where building_id = v_building_id
    returning id into v_zone_id;
  else
    update public.building_zones set is_active = true where id = v_zone_id and not is_active;
  end if;
  return v_zone_id;
end;
$$;
revoke all on function public.resolve_event_shop_zone_internal(uuid,text) from public, anon, authenticated;

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

    v_zone_id := public.resolve_event_shop_zone_internal(v_job.id, v_zone);

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

create table public.employee_event_booth_requests (
  request_id uuid primary key,
  event_job_id uuid not null references public.event_jobs(id) on delete restrict,
  payload jsonb not null,
  event_participation_id uuid not null references public.event_participations(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.users(id)
);
alter table public.employee_event_booth_requests enable row level security;
revoke all on public.employee_event_booth_requests from public, anon, authenticated;

create or replace function public.employee_event_booth_payload(p_participation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(participation) || jsonb_build_object(
    'shop_name', shop.name,
    'contact_name', coalesce(participation.contact_name, shop.contact_name),
    'contact_phone', coalesce(participation.contact_phone, shop.contact_phone),
    'tank_handoff_count', coalesce(tanks.handoff_count, 0),
    'tank_return_count', coalesce(tanks.return_count, 0),
    'tank_balance', coalesce(tanks.handoff_count, 0) - coalesce(tanks.return_count, 0),
    'tank_rental_unit_price', coalesce(participation.tank_rental_unit_price_snapshot, 0)
  )
  from public.event_participations participation
  join public.shops shop on shop.id = participation.shop_id
  left join lateral (
    select
      coalesce(sum(quantity) filter (where movement_kind = 'handoff'), 0)::integer as handoff_count,
      coalesce(sum(quantity) filter (where movement_kind = 'return'), 0)::integer as return_count
    from public.event_tank_register
    where event_participation_id = participation.id
  ) tanks on true
  where participation.id = p_participation_id
$$;
revoke all on function public.employee_event_booth_payload(uuid) from public, anon, authenticated;

create or replace function public.get_employee_event_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_events jsonb;
begin
  if not public.is_active_user() then
    raise exception 'บัญชีไม่มีสิทธิ์ดูงานอีเวนต์';
  end if;
  select coalesce(jsonb_agg(summary order by
    case when summary ->> 'end_date' >= (now() at time zone 'Asia/Bangkok')::date::text then 0 else 1 end,
    summary ->> 'start_date', summary ->> 'name'), '[]'::jsonb)
  into v_events
  from (
    select to_jsonb(job) || jsonb_build_object(
      'active_participation_count', count(participation.id)
    ) as summary
    from public.event_jobs job
    left join public.event_participations participation
      on participation.event_job_id = job.id and participation.status = 'active'
    where job.status = 'published'
    group by job.id
  ) event_summaries;
  return jsonb_build_object('events', v_events);
end;
$$;
revoke all on function public.get_employee_event_overview() from public, anon;
grant execute on function public.get_employee_event_overview() to authenticated;

create or replace function public.get_employee_event_detail(p_event_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_job public.event_jobs%rowtype; v_booths jsonb;
begin
  if not public.is_active_user() then
    raise exception 'บัญชีไม่มีสิทธิ์ดูงานอีเวนต์';
  end if;
  select * into v_job from public.event_jobs
  where id = p_event_job_id and status = 'published';
  if not found then raise exception 'ไม่พบงานที่เผยแพร่แล้ว'; end if;

  select coalesce(jsonb_agg(public.employee_event_booth_payload(participation.id)
    order by coalesce(participation.event_zone, ''), participation.booth_number), '[]'::jsonb)
  into v_booths
  from public.event_participations participation
  where participation.event_job_id = v_job.id and participation.status = 'active';

  return jsonb_build_object(
    'event', to_jsonb(v_job) || jsonb_build_object(
      'active_participation_count', jsonb_array_length(v_booths)
    ),
    'booths', v_booths
  );
end;
$$;
revoke all on function public.get_employee_event_detail(uuid) from public, anon;
grant execute on function public.get_employee_event_detail(uuid) to authenticated;

create or replace function public.create_employee_event_booth(
  p_event_job_id uuid,
  p_request_id uuid,
  p_booth_number text,
  p_shop_name text default null,
  p_event_zone text default null,
  p_contact_name text default null,
  p_contact_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_config public.event_job_config_versions%rowtype;
  v_request public.employee_event_booth_requests%rowtype;
  v_existing public.event_participations%rowtype;
  v_participation public.event_participations%rowtype;
  v_zone_id uuid;
  v_shop_id uuid := gen_random_uuid();
  v_booth text := nullif(upper(trim(p_booth_number)), '');
  v_zone text := trim(coalesce(p_event_zone, ''));
  v_payload jsonb;
begin
  if not public.is_active_user() then
    raise exception 'บัญชีไม่มีสิทธิ์เพิ่มบูธ';
  end if;
  if p_request_id is null then raise exception 'ไม่พบ request ID'; end if;
  if v_booth is null then raise exception 'กรอกเลขบูธ'; end if;

  v_payload := jsonb_build_object(
    'booth_number', v_booth, 'shop_name', trim(coalesce(p_shop_name, '')),
    'event_zone', v_zone, 'contact_name', trim(coalesce(p_contact_name, '')),
    'contact_phone', trim(coalesce(p_contact_phone, ''))
  );
  perform pg_advisory_xact_lock(hashtextextended('employee-event-booth:' || p_request_id::text, 0));
  select * into v_request from public.employee_event_booth_requests where request_id = p_request_id;
  if found then
    if v_request.event_job_id <> p_event_job_id or v_request.payload <> v_payload then
      raise exception 'Request ID was already used with different input';
    end if;
    return jsonb_build_object('created', true, 'duplicate', false,
      'booth', public.employee_event_booth_payload(v_request.event_participation_id));
  end if;

  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if not found or v_job.status <> 'published' then
    raise exception 'เพิ่มบูธได้เฉพาะงานที่เผยแพร่แล้ว';
  end if;
  if (now() at time zone 'Asia/Bangkok')::date > v_job.end_date then
    raise exception 'งานจบแล้ว ไม่สามารถเพิ่มบูธได้';
  end if;

  select * into v_existing
  from public.event_participations participation
  where participation.event_job_id = v_job.id
    and upper(trim(participation.booth_number)) = v_booth
    and upper(trim(coalesce(participation.event_zone, ''))) = upper(v_zone)
  limit 1;
  if found then
    if v_existing.status <> 'active' then
      raise exception 'บูธนี้เคยมีและถูกยกเลิกแล้ว กรุณาติดต่อหัวหน้ารอบ';
    end if;
    return jsonb_build_object('created', false, 'duplicate', true,
      'booth', public.employee_event_booth_payload(v_existing.id));
  end if;

  select * into v_config from public.event_job_config_versions where id = v_job.current_config_version_id;
  if not found then raise exception 'งานยังไม่มีการตั้งค่าการเงิน'; end if;

  v_zone_id := public.resolve_event_shop_zone_internal(v_job.id, v_zone);

  insert into public.shops(id, code, name, zone_id, event_job_id, contact_name, contact_phone)
  values (v_shop_id, 'EV-' || v_shop_id::text,
    coalesce(nullif(trim(p_shop_name), ''), 'บูธ ' || v_booth), v_zone_id, v_job.id,
    nullif(trim(p_contact_name), ''), nullif(trim(p_contact_phone), ''));

  insert into public.event_participations (
    event_job_id, shop_id, booth_number, event_zone, contact_name, contact_phone,
    start_date, end_date, rents_tank_from_us, config_version_id,
    tank_rental_unit_price_snapshot, payment_term_snapshot,
    allowed_payment_methods_snapshot, default_payment_method_snapshot,
    cash_reference_required_snapshot, cash_evidence_required_snapshot,
    bank_transfer_reference_required_snapshot, bank_transfer_evidence_required_snapshot,
    qr_reference_required_snapshot, qr_evidence_required_snapshot,
    settlement_policy_fingerprint, created_by, updated_by
  ) values (
    v_job.id, v_shop_id, v_booth, nullif(v_zone, ''), nullif(trim(p_contact_name), ''),
    nullif(trim(p_contact_phone), ''), v_job.start_date, v_job.end_date, false, v_config.id,
    v_config.tank_rental_unit_price, v_config.payment_term, v_config.allowed_payment_methods,
    v_config.default_payment_method, v_config.cash_reference_required, v_config.cash_evidence_required,
    v_config.bank_transfer_reference_required, v_config.bank_transfer_evidence_required,
    v_config.qr_reference_required, v_config.qr_evidence_required,
    v_config.policy_fingerprint, auth.uid(), auth.uid()
  ) returning * into v_participation;

  insert into public.audit_logs(actor_id, entity_type, entity_id, action, after_value)
  values(auth.uid(), 'event_participation', v_participation.id, 'employee_create', to_jsonb(v_participation));
  insert into public.employee_event_booth_requests(
    request_id, event_job_id, payload, event_participation_id, created_by
  ) values(p_request_id, v_job.id, v_payload, v_participation.id, auth.uid());

  return jsonb_build_object('created', true, 'duplicate', false,
    'booth', public.employee_event_booth_payload(v_participation.id));
end;
$$;
revoke all on function public.create_employee_event_booth(uuid,uuid,text,text,text,text,text) from public, anon;
grant execute on function public.create_employee_event_booth(uuid,uuid,text,text,text,text,text) to authenticated;

-- Shared tank writer. Both public wrappers authorize first; this function owns
-- locking, idempotency, balance validation and atomic charge creation.
create or replace function public.record_event_tank_movement_internal(
  p_participation_id uuid, p_kind text, p_quantity integer, p_service_date date, p_note text, p_request_id uuid
) returns public.event_tank_register
language plpgsql security definer set search_path = public as $$
declare
  v_job public.event_jobs%rowtype;
  v_part public.event_participations%rowtype;
  v_existing public.event_tank_register%rowtype;
  v_saved public.event_tank_register%rowtype;
  v_balance integer;
  v_context public.event_settlement_contexts%rowtype;
  v_charge_date date;
  v_charge_amount numeric(12,2);
begin
  if p_request_id is null or p_service_date is null or p_service_date > (now() at time zone 'Asia/Bangkok')::date
    or p_kind is null or p_kind not in ('handoff', 'return') or p_quantity is null or p_quantity not between 1 and 10000 then
    raise exception 'ตรวจสอบวันที่ ประเภท และจำนวนถัง (ต้องไม่เป็นวันอนาคต)';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('event-tank-request:' || p_request_id::text, 0));
  select * into v_existing from public.event_tank_register where request_id = p_request_id;
  if found then
    if v_existing.event_participation_id <> p_participation_id or v_existing.movement_kind <> p_kind
      or v_existing.quantity <> p_quantity or v_existing.service_date <> p_service_date
      or v_existing.note <> trim(coalesce(p_note, '')) then
      raise exception 'Request ID was already used with different input';
    end if;
    return v_existing;
  end if;

  select job.* into v_job from public.event_jobs job
  join public.event_participations part on part.event_job_id = job.id
  where part.id = p_participation_id for update of job;
  if not found then raise exception 'ไม่พบร้านในงาน'; end if;
  select * into v_part from public.event_participations where id = p_participation_id for update;

  if p_kind = 'handoff' and (
    v_job.status <> 'published' or v_part.status <> 'active'
    or p_service_date not between coalesce(v_part.preparation_start_date, v_part.start_date) and v_part.end_date
    or p_service_date not between coalesce(v_job.preparation_start_date, v_job.start_date) and v_job.end_date
  ) then raise exception 'ส่งถังได้เฉพาะงานเผยแพร่และวันที่ร้านเปิดรับของ'; end if;

  if p_kind = 'return' and (
    select coalesce(min(balance), 0) from (
      select sum(sum(delta)) over (order by day) as balance from (
        select service_date as day, sum(case when movement_kind = 'handoff' then quantity else -quantity end) as delta
        from public.event_tank_register where event_participation_id = p_participation_id group by service_date
        union all select p_service_date, -p_quantity
      ) movements group by day
    ) running
  ) < 0 then raise exception 'จำนวนรับคืนเกินจำนวนถังที่ร้านถืออยู่ในวันนั้น'; end if;

  select coalesce(sum(case when movement_kind = 'handoff' then quantity else -quantity end), 0)
  into v_balance from public.event_tank_register where event_participation_id = p_participation_id;
  if p_kind = 'return' and p_quantity > v_balance then raise exception 'จำนวนรับคืนเกินถังค้าง'; end if;

  v_charge_date := case when p_kind = 'handoff' then greatest(v_job.start_date, p_service_date) end;
  if p_kind = 'handoff' then
    perform pg_advisory_xact_lock(hashtextextended(v_charge_date::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_part.shop_id::text, 0));
    if exists (select 1 from public.daily_aggregate_stock_closures where service_date = v_charge_date) then
      raise exception 'วันที่เริ่มค่าเช่าปิดยอดแล้ว กรุณาใช้วันที่ยังเปิดรับรายการ';
    end if;
  end if;

  insert into public.event_tank_register(request_id, event_participation_id, movement_kind, quantity, service_date,
    rental_start_date, rental_unit_price, note, recorded_by)
  values(p_request_id, p_participation_id, p_kind, p_quantity, p_service_date, v_charge_date,
    case when p_kind = 'handoff' then v_part.tank_rental_unit_price_snapshot end,
    trim(coalesce(p_note, '')), auth.uid()) returning * into v_saved;

  if p_kind = 'handoff' and v_saved.rental_unit_price is not null and v_saved.rental_unit_price > 0 then
    v_context := public.get_or_create_event_settlement_context(p_participation_id, v_saved.rental_start_date);
    v_charge_amount := (v_saved.quantity * v_saved.rental_unit_price)::numeric(12,2);
    insert into public.delivery_charges(
      shop_id, service_date, payment_term, original_amount,
      event_settlement_context_id, event_tank_rental_id
    ) values(
      v_part.shop_id, v_saved.rental_start_date, 'end_of_day', v_charge_amount,
      v_context.id, v_saved.id
    );
  end if;

  insert into public.audit_logs(actor_id, entity_type, entity_id, action, after_value)
  values(auth.uid(), 'event_tank_register', v_saved.id, p_kind, to_jsonb(v_saved));
  return v_saved;
end;
$$;
revoke all on function public.record_event_tank_movement_internal(uuid,text,integer,date,text,uuid) from public, anon, authenticated;

create or replace function public.record_event_tank_movement(
  p_participation_id uuid, p_kind text, p_quantity integer, p_service_date date, p_note text, p_request_id uuid
) returns public.event_tank_register
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can record tank movements';
  end if;
  return public.record_event_tank_movement_internal(
    p_participation_id, p_kind, p_quantity, p_service_date, p_note, p_request_id
  );
end;
$$;
revoke all on function public.record_event_tank_movement(uuid,text,integer,date,text,uuid) from public, anon;
grant execute on function public.record_event_tank_movement(uuid,text,integer,date,text,uuid) to authenticated;

create or replace function public.record_employee_event_tank_handoff(
  p_participation_id uuid, p_quantity integer, p_note text, p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_saved public.event_tank_register%rowtype; v_charge public.delivery_charges%rowtype;
begin
  if not public.is_active_user() then raise exception 'บัญชีไม่มีสิทธิ์ส่งถัง'; end if;
  v_saved := public.record_event_tank_movement_internal(
    p_participation_id, 'handoff', p_quantity,
    (now() at time zone 'Asia/Bangkok')::date, p_note, p_request_id
  );
  select * into v_charge from public.delivery_charges where event_tank_rental_id = v_saved.id;
  return to_jsonb(v_saved) || jsonb_build_object(
    'charge_id', v_charge.id,
    'charge_number', v_charge.charge_number
  );
end;
$$;
revoke all on function public.record_employee_event_tank_handoff(uuid,integer,text,uuid) from public, anon;
grant execute on function public.record_employee_event_tank_handoff(uuid,integer,text,uuid) to authenticated;

notify pgrst, 'reload schema';
