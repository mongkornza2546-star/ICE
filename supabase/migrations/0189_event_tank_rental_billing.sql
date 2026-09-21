-- Migration 0189: Automatic Event Tank Rental Billing
-- Enables automatic delivery_charges creation for event tank handoffs with event_settlement_context.

-- 1. Extend delivery_charges with event_tank_rental_id
alter table public.delivery_charges
  add column event_tank_rental_id uuid unique references public.event_tank_register(id) on delete restrict;

-- 2. Update source check constraint on delivery_charges
alter table public.delivery_charges drop constraint delivery_charge_source_required;
alter table public.delivery_charges add constraint delivery_charge_source_required
  check (
    (delivery_event_id is not null and tank_rental_id is null and event_tank_rental_id is null)
    or (delivery_event_id is null and tank_rental_id is not null and event_tank_rental_id is null
        and event_settlement_context_id is null and payment_term = 'end_of_day')
    or (delivery_event_id is null and tank_rental_id is null and event_tank_rental_id is not null
        and event_settlement_context_id is not null and payment_term = 'end_of_day')
  );

-- 3. Update delivery_charges_enforce_settlement_context trigger
create or replace function public.enforce_delivery_charge_settlement_context()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_stop public.round_stops%rowtype;
  v_event public.delivery_events%rowtype;
  v_service_date date;
  v_context public.event_settlement_contexts%rowtype;
  v_reg public.event_tank_register%rowtype;
begin
  if tg_op = 'UPDATE' and (
    new.tank_rental_id is distinct from old.tank_rental_id
    or new.event_tank_rental_id is distinct from old.event_tank_rental_id
  ) then
    raise exception 'Charge source is immutable';
  end if;

  if new.tank_rental_id is not null then
    if not exists (select 1 from public.shop_tank_rentals rental where rental.id = new.tank_rental_id
      and rental.shop_id = new.shop_id and rental.handed_out_on = new.service_date
      and rental.total_amount = new.original_amount)
      or new.delivery_event_id is not null or new.event_tank_rental_id is not null
      or new.event_settlement_context_id is not null
      or new.payment_term <> 'end_of_day' or new.status <> 'active' then
      raise exception 'Rental charge must match its rental';
    end if;
    return new;
  end if;

  if new.event_tank_rental_id is not null then
    select * into v_context from public.event_settlement_contexts context
    where context.id = new.event_settlement_context_id;

    select * into v_reg from public.event_tank_register reg
    where reg.id = new.event_tank_rental_id;

    if v_reg.id is null or v_reg.movement_kind <> 'handoff'
      or v_context.id is null
      or v_context.event_participation_id is distinct from v_reg.event_participation_id
      or new.delivery_event_id is not null or new.tank_rental_id is not null
      or new.shop_id is distinct from v_context.shop_id
      or new.service_date is distinct from v_context.service_date
      or new.service_date is distinct from coalesce(v_reg.rental_start_date, v_reg.service_date)
      or new.original_amount is distinct from (v_reg.quantity * v_reg.rental_unit_price)::numeric(12,2)
      or new.payment_term <> 'end_of_day' or new.status <> 'active' then
      raise exception 'Event rental charge must match its rental movement and settlement context';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and (
    new.delivery_event_id is distinct from old.delivery_event_id
    or new.shop_id is distinct from old.shop_id
    or new.service_date is distinct from old.service_date
    or new.event_settlement_context_id is distinct from old.event_settlement_context_id
    or (old.event_settlement_context_id is not null
      and new.payment_term is distinct from old.payment_term)
  ) then
    raise exception 'Delivery charge settlement identity is immutable';
  end if;

  select * into v_event
  from public.delivery_events event
  where event.id = new.delivery_event_id;
  select * into v_stop
  from public.round_stops stop
  where stop.id = v_event.round_stop_id;

  select round.service_date into v_service_date
  from public.delivery_rounds round where round.id = v_stop.round_id;

  if v_stop.id is null
    or new.shop_id is distinct from v_stop.shop_id
    or new.service_date is distinct from v_service_date then
    raise exception 'Delivery charge shop and service date must match its destination';
  elsif v_stop.destination_kind = 'regular' then
    if new.event_settlement_context_id is not null then
      raise exception 'Regular delivery charges cannot use an event settlement context';
    end if;
  else
    if new.event_settlement_context_id is null and v_event.corrects_event_id is not null
      and nullif(current_setting('app.event_correction_id', true), '')
        = v_event.corrects_event_id::text then
      select charge.event_settlement_context_id
      into new.event_settlement_context_id
      from public.delivery_charges charge
      where charge.delivery_event_id = v_event.corrects_event_id;
    end if;
    if new.event_settlement_context_id is null then
      raise exception 'Event delivery charges require an event settlement context';
    elsif new.payment_term <> 'end_of_day' then
      raise exception 'Event delivery charges must use end-of-day settlement';
    end if;
    select * into v_context from public.event_settlement_contexts context
    where context.id = new.event_settlement_context_id;
    if v_context.id is null
      or v_context.event_participation_id is distinct from v_stop.event_participation_id
      or v_context.shop_id is distinct from new.shop_id
      or v_context.service_date is distinct from new.service_date then
      raise exception 'Event delivery charge does not match its settlement context';
    end if;
  end if;
  return new;
end;
$$;

-- 4. Update record_event_tank_movement to create delivery_charge on handoff
create or replace function public.record_event_tank_movement(
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
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can record tank movements';
  end if;
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

  select job.* into v_job from public.event_jobs job join public.event_participations part on part.event_job_id = job.id
    where part.id = p_participation_id for update of job;
  if not found then raise exception 'ไม่พบร้านในงาน'; end if;
  select * into v_part from public.event_participations where id = p_participation_id for update;

  if p_kind = 'handoff' then
    if v_job.status <> 'published' or v_part.status <> 'active'
      or p_service_date not between coalesce(v_part.preparation_start_date, v_part.start_date) and v_part.end_date
      or p_service_date not between coalesce(v_job.preparation_start_date, v_job.start_date) and v_job.end_date then
      raise exception 'ส่งถังได้เฉพาะงานเผยแพร่และวันที่ร้านเปิดรับของ';
    end if;
  end if;

  if p_kind = 'return' and (
    select coalesce(min(balance), 0) from (
      select sum(sum(delta)) over (order by day) as balance from (
        select service_date as day, sum(case when movement_kind = 'handoff' then quantity else -quantity end) as delta
        from public.event_tank_register where event_participation_id = p_participation_id group by service_date
        union all select p_service_date, -p_quantity
      ) movements group by day
    ) running
  ) < 0 then
    raise exception 'จำนวนรับคืนเกินจำนวนถังที่ร้านถืออยู่ในวันนั้น';
  end if;

  select coalesce(sum(case when movement_kind = 'handoff' then quantity else -quantity end), 0)
    into v_balance from public.event_tank_register where event_participation_id = p_participation_id;
  if p_kind = 'return' and p_quantity > v_balance then
    raise exception 'จำนวนรับคืนเกินถังค้าง';
  end if;

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
  values(p_request_id, p_participation_id, p_kind, p_quantity, p_service_date,
    v_charge_date,
    case when p_kind = 'handoff' then v_part.tank_rental_unit_price_snapshot end,
    trim(coalesce(p_note, '')), auth.uid()) returning * into v_saved;

  if p_kind = 'handoff' and v_saved.rental_unit_price is not null and v_saved.rental_unit_price > 0 then
    v_context := public.get_or_create_event_settlement_context(
      p_participation_id, v_saved.rental_start_date
    );
    v_charge_amount := (v_saved.quantity * v_saved.rental_unit_price)::numeric(12,2);
    insert into public.delivery_charges (
      shop_id, service_date, payment_term, original_amount,
      event_settlement_context_id, event_tank_rental_id
    ) values (
      v_part.shop_id, v_saved.rental_start_date, 'end_of_day',
      v_charge_amount,
      v_context.id, v_saved.id
    );
  end if;

  insert into public.audit_logs(actor_id, entity_type, entity_id, action, after_value)
    values(auth.uid(), 'event_tank_register', v_saved.id, p_kind, to_jsonb(v_saved));
  return v_saved;
end;
$$;

-- 5. Update charge_line_items to include event tank rentals
create or replace function public.charge_line_items(p_charge_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'ice_type_id', item_id, 'name', name, 'unit', unit,
    'ice_type_name', name, 'ice_type_unit', unit,
    'quantity', quantity, 'unit_price', unit_price, 'line_total', line_total
  ) order by code), '[]'::jsonb) from (
    select ice.id as item_id, ice.code, ice.name, ice.unit, item.quantity, item.unit_price, item.line_total
    from public.delivery_charges charge join public.delivery_items item on item.delivery_event_id = charge.delivery_event_id
    join public.ice_types ice on ice.id = item.ice_type_id where charge.id = p_charge_id
    union all
    select rental.id, 'TANK-RENTAL', 'ค่าเช่าถังรายครั้ง', 'ใบ', rental.quantity, rental.unit_price, rental.total_amount
    from public.delivery_charges charge join public.shop_tank_rentals rental on rental.id = charge.tank_rental_id
    where charge.id = p_charge_id
    union all
    select reg.id, 'EVENT-TANK-RENTAL', 'ค่าเช่าถังอีเวนต์', 'ใบ',
      reg.quantity::numeric, reg.rental_unit_price, (reg.quantity * reg.rental_unit_price)::numeric(12,2)
    from public.delivery_charges charge join public.event_tank_register reg on reg.id = charge.event_tank_rental_id
    where charge.id = p_charge_id
  ) lines;
$$;

-- 6. Update is_charge_collectible_in_run to constrain event charges to matching service_date
create or replace function public.is_charge_collectible_in_run(
  p_charge_id uuid,
  p_collection_run_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.delivery_charges charge
    join public.collection_runs run
      on run.id = p_collection_run_id and run.status = 'open'
    where charge.id = p_charge_id
      and charge.status = 'active'
      and (
        charge.event_settlement_context_id is null
        or charge.service_date = run.service_date
      )
      and (
        charge.payment_term in ('immediate', 'end_of_day')
        or (charge.payment_term = 'credit' and charge.due_date <= run.service_date)
      )
  );
$$;

-- 7. Update get_collection_run_queue to correctly project event info when delivery_event_id is null
create or replace function public.get_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required to view shop collections';
  end if;
  select run.service_date into v_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id and run.status = 'open';
  if v_service_date is null
    or v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or exists (
      select 1 from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_service_date
    ) then
    raise exception 'The collection context is stale or closed';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'queue_key', queue.queue_key,
      'destination_kind', queue.destination_kind,
      'event_settlement_context_id', queue.event_settlement_context_id,
      'event_participation_id', queue.event_participation_id,
      'settlement_service_date', queue.settlement_service_date,
      'settlement_policy_fingerprint', queue.settlement_policy_fingerprint,
      'event_name', queue.event_name,
      'event_location', queue.event_location,
      'event_zone', queue.event_zone,
      'event_booth', queue.event_booth,
      'shop_id', queue.shop_id,
      'shop_code', queue.shop_code,
      'shop_name', queue.shop_name,
      'building_id', queue.building_id,
      'building_name', queue.building_name,
      'zone_id', queue.zone_id,
      'zone_name', queue.zone_name,
      'image_path', queue.image_path,
      'outstanding_amount', queue.outstanding_amount,
      'charge_count', queue.charge_count,
      'latest_charge_at', queue.latest_charge_at,
      'latest_payment_at', queue.latest_payment_at,
      'has_new_charges', queue.latest_payment_at is not null
        and queue.latest_charge_at > queue.latest_payment_at,
      'payment_profile', queue.payment_profile,
      'charges', queue.charges
    ) order by queue.destination_kind, queue.event_name nulls first, queue.shop_code, queue.queue_key)
    from (
      select
        case when context.id is null then 'regular:' || shop.id::text
          else 'event:' || context.id::text end as queue_key,
        case when context.id is null then 'regular' else 'event' end as destination_kind,
        context.id as event_settlement_context_id,
        context.event_participation_id,
        context.service_date as settlement_service_date,
        context.settlement_policy_fingerprint,
        min(coalesce(stop.event_job_name_snapshot, job.name)) as event_name,
        min(coalesce(stop.event_location_snapshot, job.location)) as event_location,
        min(coalesce(stop.event_zone_snapshot, participation.event_zone)) as event_zone,
        min(coalesce(stop.event_booth_snapshot, participation.booth_number)) as event_booth,
        shop.id as shop_id,
        shop.code as shop_code,
        shop.name as shop_name,
        case when context.id is null then shop.building_id else null end as building_id,
        case when context.id is null then building.name else min(coalesce(stop.event_location_snapshot, job.location)) end as building_name,
        case when context.id is null then shop.zone_id else null end as zone_id,
        case when context.id is null then zone.name else min(coalesce(stop.event_zone_snapshot, participation.event_zone)) end as zone_name,
        case when context.id is null then shop.image_path else null end as image_path,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        count(*)::integer as charge_count,
        max(charge.created_at) as latest_charge_at,
        case when context.id is null then jsonb_build_object(
          'allowed_payment_methods', profile.allowed_payment_methods,
          'default_payment_method', profile.default_payment_method,
          'cash_reference_required', profile.cash_reference_required,
          'cash_evidence_required', profile.cash_evidence_required,
          'bank_transfer_reference_required', profile.bank_transfer_reference_required,
          'bank_transfer_evidence_required', profile.bank_transfer_evidence_required,
          'qr_reference_required', profile.qr_reference_required,
          'qr_evidence_required', profile.qr_evidence_required
        ) else jsonb_build_object(
          'allowed_payment_methods', participation.allowed_payment_methods_snapshot,
          'default_payment_method', participation.default_payment_method_snapshot,
          'cash_reference_required', participation.cash_reference_required_snapshot,
          'cash_evidence_required', participation.cash_evidence_required_snapshot,
          'bank_transfer_reference_required', participation.bank_transfer_reference_required_snapshot,
          'bank_transfer_evidence_required', participation.bank_transfer_evidence_required_snapshot,
          'qr_reference_required', participation.qr_reference_required_snapshot,
          'qr_evidence_required', participation.qr_evidence_required_snapshot
        ) end as payment_profile,
        (
          select max(payment.recorded_at)
          from public.payments payment
          where payment.collection_run_id = p_collection_run_id
            and payment.status = 'active'
            and payment.shop_id = shop.id
            and payment.event_settlement_context_id is not distinct from context.id
        ) as latest_payment_at,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id,
          'charge_number', charge.charge_number,
          'delivery_event_id', charge.delivery_event_id,
          'service_date', charge.service_date,
          'payment_term', charge.payment_term,
          'due_date', charge.due_date,
          'original_amount', public.effective_delivery_charge_amount(charge.id),
          'base_amount', charge.original_amount,
          'outstanding_amount', balance.outstanding_amount,
          'created_at', charge.created_at,
          'items', public.charge_line_items(charge.id)
        ) order by charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      left join public.delivery_events event on event.id = charge.delivery_event_id
      left join public.round_stops stop on stop.id = event.round_stop_id
      join public.shops shop on shop.id = charge.shop_id
      left join public.buildings building on building.id = shop.building_id
      left join public.building_zones zone on zone.id = shop.zone_id
      left join public.shop_payment_profiles profile on profile.shop_id = shop.id
      left join public.event_settlement_contexts context
        on context.id = charge.event_settlement_context_id
      left join public.event_participations participation
        on participation.id = context.event_participation_id
      left join public.event_jobs job on job.id = participation.event_job_id
      join lateral (
        select greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
          as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where public.is_charge_collectible_in_run(charge.id, p_collection_run_id)
        and balance.outstanding_amount > 0
        and (context.id is not null or profile.id is not null)
        and (context.id is null or context.service_date = v_service_date)
      group by shop.id, building.id, zone.id, profile.id, context.id, participation.id, job.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

-- 8. Update build_charge_print_document (INV)
create or replace function public.build_charge_print_document(p_charge_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'document_type', 'INV',
    'document_number', charge.charge_number,
    'document_title', 'ใบส่งของ / ใบแจ้งหนี้',
    'payment_term', charge.payment_term,
    'issued_at', charge.created_at,
    'service_date', charge.service_date,
    'due_date', charge.due_date,
    'shop_code', coalesce(rental.shop_code_snapshot, stop.shop_code_snapshot, shop.code),
    'shop_name', coalesce(rental.shop_name_snapshot, stop.shop_name_snapshot, shop.name),
    'shop_location', case
      when rental.id is not null then rental.shop_location_snapshot
      when charge.event_settlement_context_id is not null
        then nullif(concat_ws(' · ', coalesce(stop.event_job_name_snapshot, job.name),
          coalesce(stop.event_location_snapshot, job.location),
          coalesce(stop.event_zone_snapshot, participation.event_zone),
          coalesce(stop.event_booth_snapshot, participation.booth_number)), '')
      when stop.destination_kind = 'event'
        then nullif(concat_ws(' · ', stop.event_job_name_snapshot,
          stop.event_location_snapshot, stop.event_zone_snapshot, stop.event_booth_snapshot), '')
      else nullif(concat_ws(' · ', stop.building_name_snapshot,
        stop.floor_or_zone_snapshot), '') end,
    'destination_kind', case
      when charge.event_settlement_context_id is not null then 'event'
      else coalesce(stop.destination_kind::text, 'regular') end,
    'event_settlement_context_id', charge.event_settlement_context_id,
    'event_participation_id', context.event_participation_id,
    'settlement_policy_fingerprint', context.settlement_policy_fingerprint,
    'event_name', coalesce(stop.event_job_name_snapshot, job.name),
    'event_location', coalesce(stop.event_location_snapshot, job.location),
    'event_zone', coalesce(stop.event_zone_snapshot, participation.event_zone),
    'event_booth', coalesce(stop.event_booth_snapshot, participation.booth_number),
    'items', public.charge_line_items(charge.id),
    'total_amount', charge.original_amount
  )
  from public.delivery_charges charge
  join public.shops shop on shop.id = charge.shop_id
  left join public.shop_tank_rentals rental on rental.id = charge.tank_rental_id
  left join public.delivery_events event on event.id = charge.delivery_event_id
  left join public.round_stops stop on stop.id = event.round_stop_id
  left join public.event_settlement_contexts context
    on context.id = charge.event_settlement_context_id
  left join public.event_participations participation
    on participation.id = context.event_participation_id
  left join public.event_jobs job on job.id = participation.event_job_id
  where charge.id = p_charge_id and charge.charge_number is not null;
$$;

-- 9. Update build_payment_receipt_snapshot (REC)
create or replace function public.build_payment_receipt_snapshot(p_payment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'payment_id', payment.id,
    'document_type', 'REC',
    'document_number', payment.receipt_number,
    'receipt_number', payment.receipt_number,
    'document_title', case when bool_and(charge.payment_term = 'immediate')
      then 'ใบส่งของ / ใบเสร็จรับเงิน' else 'ใบเสร็จรับเงิน' end,
    'payment_term', case when count(distinct charge.payment_term) = 1
      then min(charge.payment_term::text) else null end,
    'shop_code', shop.code,
    'shop_name', shop.name,
    'shop_location', case when payment.operation_kind = 'event'
      then nullif(concat_ws(' · ', coalesce(min(stop.event_job_name_snapshot), min(job.name)),
        coalesce(min(stop.event_location_snapshot), min(job.location)),
        coalesce(min(stop.event_zone_snapshot), min(participation.event_zone)),
        coalesce(min(stop.event_booth_snapshot), min(participation.booth_number))), '')
      else coalesce(min(rental.shop_location_snapshot), nullif(concat_ws(' · ', min(stop.building_name_snapshot),
        min(stop.floor_or_zone_snapshot)), '')) end,
    'service_date', min(charge.service_date),
    'payment_method', payment.payment_method,
    'received_amount', payment.received_amount,
    'allocated_amount', payment.allocated_amount,
    'change_amount', payment.change_amount,
    'recorded_at', payment.recorded_at,
    'destination_kind', payment.operation_kind,
    'event_settlement_context_id', payment.event_settlement_context_id,
    'event_participation_id', context.event_participation_id,
    'settlement_policy_fingerprint', context.settlement_policy_fingerprint,
    'event_name', coalesce(min(stop.event_job_name_snapshot), min(job.name)),
    'event_location', coalesce(min(stop.event_location_snapshot), min(job.location)),
    'event_zone', coalesce(min(stop.event_zone_snapshot), min(participation.event_zone)),
    'event_booth', coalesce(min(stop.event_booth_snapshot), min(participation.booth_number)),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_number', charge_detail.charge_number,
        'payment_term', charge_detail.payment_term,
        'service_date', charge_detail.service_date,
        'event_settlement_context_id', charge_detail.event_settlement_context_id,
        'location', case
          when rental_detail.id is not null then rental_detail.shop_location_snapshot
          when charge_detail.event_settlement_context_id is not null
            then nullif(concat_ws(' · ', coalesce(stop_detail.event_job_name_snapshot, job_detail.name),
              coalesce(stop_detail.event_location_snapshot, job_detail.location),
              coalesce(stop_detail.event_zone_snapshot, part_detail.event_zone),
              coalesce(stop_detail.event_booth_snapshot, part_detail.booth_number)), '')
          when stop_detail.destination_kind = 'event'
            then nullif(concat_ws(' · ', stop_detail.event_job_name_snapshot,
              stop_detail.event_location_snapshot, stop_detail.event_zone_snapshot,
              stop_detail.event_booth_snapshot), '')
          else nullif(concat_ws(' · ', stop_detail.building_name_snapshot,
            stop_detail.floor_or_zone_snapshot), '') end,
        'received_amount', allocation.amount,
        'items', public.charge_line_items(charge_detail.id)
      ) order by charge_detail.created_at, charge_detail.id)
      from public.payment_allocations allocation
      join public.delivery_charges charge_detail on charge_detail.id = allocation.charge_id
      left join public.shop_tank_rentals rental_detail on rental_detail.id = charge_detail.tank_rental_id
      left join public.delivery_events event_detail on event_detail.id = charge_detail.delivery_event_id
      left join public.round_stops stop_detail on stop_detail.id = event_detail.round_stop_id
      left join public.event_settlement_contexts context_detail on context_detail.id = charge_detail.event_settlement_context_id
      left join public.event_participations part_detail on part_detail.id = context_detail.event_participation_id
      left join public.event_jobs job_detail on job_detail.id = part_detail.event_job_id
      where allocation.payment_id = payment.id
    ), '[]'::jsonb)
  )
  from public.payments payment
  join public.shops shop on shop.id = payment.shop_id
  join public.payment_allocations root_allocation on root_allocation.payment_id = payment.id
  join public.delivery_charges charge on charge.id = root_allocation.charge_id
  left join public.shop_tank_rentals rental on rental.id = charge.tank_rental_id
  left join public.delivery_events event on event.id = charge.delivery_event_id
  left join public.round_stops stop on stop.id = event.round_stop_id
  left join public.event_settlement_contexts context
    on context.id = payment.event_settlement_context_id
  left join public.event_participations participation
    on participation.id = context.event_participation_id
  left join public.event_jobs job on job.id = participation.event_job_id
  where payment.id = p_payment_id
  group by payment.id, shop.id, context.id, job.id, participation.id;
$$;

-- 10. Update get_event_management_detail to return charge_id, charge_number, outstanding_amount in tank_movements
do $event_mgmt_patch$
declare
  v_original text;
  v_patched text;
begin
  v_original := pg_get_functiondef('public.get_event_management_detail(uuid)'::regprocedure);
  v_patched := replace(v_original,
    E'''tank_movements'', (select coalesce(jsonb_agg(to_jsonb(m) order by m.service_date, m.recorded_at), ''[]''::jsonb) from public.event_tank_register m join public.event_participations p on p.id = m.event_participation_id where p.event_job_id = v_job.id)',
    E'''tank_movements'', (select coalesce(jsonb_agg(jsonb_build_object(\n      ''id'', m.id, ''request_id'', m.request_id, ''event_participation_id'', m.event_participation_id,\n      ''movement_kind'', m.movement_kind, ''quantity'', m.quantity, ''service_date'', m.service_date,\n      ''rental_start_date'', m.rental_start_date, ''rental_unit_price'', m.rental_unit_price,\n      ''note'', m.note, ''recorded_by'', m.recorded_by, ''recorded_at'', m.recorded_at,\n      ''charge_id'', charge.id, ''charge_number'', charge.charge_number,\n      ''outstanding_amount'', greatest(charge.original_amount - coalesce((\n        select sum(allocation.amount) from public.payment_allocations allocation\n        join public.payments payment on payment.id = allocation.payment_id\n        where allocation.charge_id = charge.id and payment.status = ''active''\n      ), 0), 0)\n    ) order by m.service_date, m.recorded_at), ''[]''::jsonb)\n    from public.event_tank_register m\n    join public.event_participations p on p.id = m.event_participation_id\n    left join public.delivery_charges charge on charge.event_tank_rental_id = m.id\n    where p.event_job_id = v_job.id)');
  if v_original = v_patched then
    raise exception 'Could not install event management tank detail patch';
  end if;
  execute v_patched;
end;
$event_mgmt_patch$;

-- 11. Update accounting_transaction_rows to include event tank rental INV rows
alter function public.accounting_transaction_rows(date,date) rename to accounting_transaction_rows_before_event_tank_rentals;
revoke all on function public.accounting_transaction_rows_before_event_tank_rentals(date,date) from public, anon, authenticated;

create function public.accounting_transaction_rows(
  p_from_date date,
  p_to_date date
)
returns table (
  occurred_at timestamptz,
  service_date date,
  type text,
  group_id uuid,
  source_id uuid,
  source_table text,
  delivery_event_id uuid,
  payment_id uuid,
  document_number text,
  reference_number text,
  shop_id uuid,
  shop_code text,
  shop_name text,
  holder_name text,
  employee_id uuid,
  employee_name text,
  ice_type_id uuid,
  ice_type_name text,
  unit text,
  quantity_in numeric,
  quantity_out numeric,
  sales_amount numeric,
  cash_in numeric,
  cash_out numeric,
  receivable_delta numeric,
  status text,
  note text,
  issue_code text,
  issue_label text,
  can_correct boolean,
  details jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.accounting_transaction_rows_before_event_tank_rentals(p_from_date, p_to_date)
  union all
  select reg.recorded_at, charge.service_date, 'INV', charge.id, charge.id,
    'delivery_charges', null::uuid, null::uuid, charge.charge_number, null::text,
    shop.id, shop.code, shop.name, null::text,
    recorder.id, recorder.display_name, null::uuid, 'ค่าเช่าถังอีเวนต์', 'ใบ',
    0::numeric, 0::numeric, charge.original_amount, 0::numeric, 0::numeric,
    charge.original_amount, charge.status::text, reg.note,
    case when charge.original_amount > coalesce(paid.amount, 0) then 'unpaid_collectible' end,
    case when charge.original_amount > coalesce(paid.amount, 0) then 'ยังรับเงินไม่ครบ' end,
    false, jsonb_build_object('charge_id', charge.id, 'charge_kind', 'event_tank_rental',
      'destination_kind', 'event', 'payment_term', charge.payment_term,
      'event_participation_id', reg.event_participation_id,
      'event_name', job.name,
      'booth_number', part.booth_number,
      'quantity', reg.quantity, 'unit_price', reg.rental_unit_price,
      'effective_amount', charge.original_amount, 'allocated_amount', coalesce(paid.amount, 0))
  from public.delivery_charges charge
  join public.event_tank_register reg on reg.id = charge.event_tank_rental_id
  join public.event_participations part on part.id = reg.event_participation_id
  join public.event_jobs job on job.id = part.event_job_id
  join public.shops shop on shop.id = charge.shop_id
  join public.users recorder on recorder.id = reg.recorded_by
  left join lateral (select sum(allocation.amount) as amount from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id and payment.status = 'active') paid on true
  where charge.service_date between p_from_date and p_to_date;
$$;
revoke all on function public.accounting_transaction_rows(date,date) from public, anon, authenticated;

notify pgrst, 'reload schema';
