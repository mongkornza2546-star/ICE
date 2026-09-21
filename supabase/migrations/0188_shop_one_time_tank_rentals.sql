-- Per-occasion custody and agreed fees, separate from permanent tank assignments.
create table public.shop_tank_rentals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  shop_id uuid not null references public.shops(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 10000),
  unit_price numeric(12,2) not null check (unit_price > 0 and unit_price < 1000000),
  total_amount numeric(16,2) generated always as (quantity * unit_price) stored,
  handed_out_on date not null,
  due_on date not null check (due_on >= handed_out_on),
  note text not null default '',
  shop_code_snapshot text not null,
  shop_name_snapshot text not null,
  shop_location_snapshot text,
  recorded_by uuid not null references public.users(id),
  recorded_at timestamptz not null default now()
);
create index shop_tank_rentals_shop_idx on public.shop_tank_rentals(shop_id, handed_out_on);
create table public.shop_tank_rental_returns (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  rental_id uuid not null references public.shop_tank_rentals(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 10000),
  returned_on date not null,
  recorded_by uuid not null references public.users(id),
  recorded_at timestamptz not null default now()
);
create index shop_tank_rental_returns_rental_idx on public.shop_tank_rental_returns(rental_id);
alter table public.shop_tank_rentals enable row level security;
alter table public.shop_tank_rental_returns enable row level security;
revoke all on public.shop_tank_rentals, public.shop_tank_rental_returns from public, anon, authenticated;

alter table public.delivery_charges alter column delivery_event_id drop not null;
alter table public.delivery_charges add column tank_rental_id uuid unique references public.shop_tank_rentals(id) on delete restrict;
alter table public.delivery_charges add constraint delivery_charge_source_required
  check ((delivery_event_id is not null and tank_rental_id is null)
    or (delivery_event_id is null and tank_rental_id is not null and event_settlement_context_id is null and payment_term = 'end_of_day'));

create or replace function public.create_shop_tank_rental(
  p_shop_id uuid, p_quantity integer, p_unit_price numeric, p_handed_out_on date,
  p_due_on date, p_note text, p_request_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_existing public.shop_tank_rentals%rowtype; v_saved public.shop_tank_rentals%rowtype; v_shop public.shops%rowtype;
begin
  if not public.is_active_user() or public.current_app_role() is distinct from 'admin' then
    raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้นที่บันทึกเช่าถังได้';
  end if;
  if p_shop_id is null or p_request_id is null or p_quantity is null or p_quantity not between 1 and 10000
    or p_unit_price is null or not (p_unit_price > 0 and p_unit_price < 1000000)
    or p_unit_price <> round(p_unit_price, 2)
    or p_handed_out_on is null or p_due_on is null or p_due_on < p_handed_out_on
    or p_handed_out_on > (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'ตรวจสอบจำนวน ราคา และวันส่ง–กำหนดคืนถัง';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('shop-tank-rental:' || p_request_id::text, 0));
  select * into v_existing from public.shop_tank_rentals where request_id = p_request_id;
  if found then
    if v_existing.shop_id <> p_shop_id or v_existing.quantity <> p_quantity
      or v_existing.unit_price <> p_unit_price or v_existing.handed_out_on <> p_handed_out_on
      or v_existing.due_on <> p_due_on or v_existing.note <> trim(coalesce(p_note, '')) then
      raise exception 'Request ID was already used with different input';
    end if;
    return v_existing.id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_handed_out_on::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));
  select * into v_shop from public.shops where id = p_shop_id and status = 'active' and event_job_id is null for share;
  if not found then raise exception 'เลือกร้านประจำที่ใช้งานอยู่'; end if;
  if not exists (select 1 from public.shop_payment_profiles where shop_id = p_shop_id) then
    raise exception 'ตั้งค่าการชำระเงินของร้านก่อนเปิดรายการเช่า';
  end if;
  if exists (select 1 from public.daily_aggregate_stock_closures where service_date = p_handed_out_on) then
    raise exception 'วันที่ส่งถังปิดยอดแล้ว กรุณาใช้วันที่ยังเปิดรับรายการ';
  end if;
  insert into public.shop_tank_rentals(request_id, shop_id, quantity, unit_price, handed_out_on, due_on, note,
    shop_code_snapshot, shop_name_snapshot, shop_location_snapshot, recorded_by)
    values(p_request_id, p_shop_id, p_quantity, p_unit_price, p_handed_out_on, p_due_on, trim(coalesce(p_note, '')),
      v_shop.code, v_shop.name, nullif(concat_ws(' · ',
        (select name from public.buildings where id = v_shop.building_id), v_shop.floor_or_zone), ''), auth.uid())
    returning * into v_saved;
  insert into public.delivery_charges(shop_id, service_date, payment_term, original_amount, tank_rental_id)
    values(p_shop_id, p_handed_out_on, 'end_of_day', v_saved.total_amount, v_saved.id);
  insert into public.audit_logs(actor_id, entity_type, entity_id, action, after_value)
    values(auth.uid(), 'shop_tank_rental', v_saved.id, 'create', to_jsonb(v_saved));
  return v_saved.id;
end;
$$;

create or replace function public.return_shop_tank_rental(
  p_rental_id uuid, p_quantity integer, p_returned_on date, p_request_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_rental public.shop_tank_rentals%rowtype; v_existing public.shop_tank_rental_returns%rowtype;
  v_saved public.shop_tank_rental_returns%rowtype; v_returned integer;
begin
  if not public.is_active_user() or public.current_app_role() is distinct from 'admin' then
    raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้นที่รับคืนถังได้';
  end if;
  if p_rental_id is null or p_request_id is null or p_quantity is null or p_quantity not between 1 and 10000
    or p_returned_on is null or p_returned_on > (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'ตรวจสอบจำนวนและวันรับคืนถัง';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('shop-tank-return:' || p_request_id::text, 0));
  select * into v_existing from public.shop_tank_rental_returns where request_id = p_request_id;
  if found then
    if v_existing.rental_id <> p_rental_id or v_existing.quantity <> p_quantity or v_existing.returned_on <> p_returned_on then
      raise exception 'Request ID was already used with different input';
    end if;
    return v_existing.id;
  end if;
  select * into v_rental from public.shop_tank_rentals where id = p_rental_id for update;
  if not found then raise exception 'ไม่พบรายการเช่า'; end if;
  if p_returned_on < v_rental.handed_out_on then raise exception 'วันรับคืนต้องไม่ก่อนวันส่งถัง'; end if;
  select coalesce(sum(quantity), 0) into v_returned from public.shop_tank_rental_returns where rental_id = p_rental_id;
  if p_quantity > v_rental.quantity - v_returned then raise exception 'จำนวนคืนเกินถังค้าง'; end if;
  insert into public.shop_tank_rental_returns(request_id, rental_id, quantity, returned_on, recorded_by)
    values(p_request_id, p_rental_id, p_quantity, p_returned_on, auth.uid()) returning * into v_saved;
  insert into public.audit_logs(actor_id, entity_type, entity_id, action, after_value)
    values(auth.uid(), 'shop_tank_rental', p_rental_id, 'return', to_jsonb(v_saved));
  return v_saved.id;
end;
$$;

create or replace function public.get_shop_tank_rentals(p_shop_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_active_user() or public.current_app_role() is distinct from 'admin' then
    raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้นที่ดูรายการเช่าถังได้';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(rows) order by rows.handed_out_on desc, rows.recorded_at desc) from (
    select rental.*, charge.id as charge_id, charge.charge_number,
      greatest(charge.original_amount - coalesce((select sum(allocation.amount)
        from public.payment_allocations allocation join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id and payment.status = 'active'), 0), 0) as outstanding_amount,
      rental.quantity - coalesce((select sum(ret.quantity) from public.shop_tank_rental_returns ret
      where ret.rental_id = rental.id), 0) as outstanding_quantity,
      coalesce((select jsonb_agg(to_jsonb(ret) order by ret.returned_on, ret.recorded_at)
        from public.shop_tank_rental_returns ret where ret.rental_id = rental.id), '[]'::jsonb) as returns
    from public.shop_tank_rentals rental join public.delivery_charges charge on charge.tank_rental_id = rental.id where rental.shop_id = p_shop_id
  ) rows), '[]'::jsonb);
end;
$$;
revoke all on function public.create_shop_tank_rental(uuid,integer,numeric,date,date,text,uuid) from public, anon;
revoke all on function public.return_shop_tank_rental(uuid,integer,date,uuid) from public, anon;
revoke all on function public.get_shop_tank_rentals(uuid) from public, anon;
grant execute on function public.create_shop_tank_rental(uuid,integer,numeric,date,date,text,uuid) to authenticated;
grant execute on function public.return_shop_tank_rental(uuid,integer,date,uuid) to authenticated;
grant execute on function public.get_shop_tank_rentals(uuid) to authenticated;

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
begin
  if tg_op = 'UPDATE' and new.tank_rental_id is distinct from old.tank_rental_id then
    raise exception 'Charge source is immutable';
  end if;
  if new.tank_rental_id is not null then
    if not exists (select 1 from public.shop_tank_rentals rental where rental.id = new.tank_rental_id
      and rental.shop_id = new.shop_id and rental.handed_out_on = new.service_date
      and rental.total_amount = new.original_amount)
      or new.delivery_event_id is not null or new.event_settlement_context_id is not null
      or new.payment_term <> 'end_of_day' or new.status <> 'active' then
      raise exception 'Rental charge must match its rental';
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
drop trigger delivery_charges_enforce_settlement_context on public.delivery_charges;
create trigger delivery_charges_enforce_settlement_context before insert or update on public.delivery_charges
for each row execute function public.enforce_delivery_charge_settlement_context();


-- Existing document/collection fields are retained for client compatibility.
create function public.charge_line_items(p_charge_id uuid) returns jsonb
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
  ) lines;
$$;
revoke all on function public.charge_line_items(uuid) from public, anon, authenticated;
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
        min(stop.event_job_name_snapshot) as event_name,
        min(stop.event_location_snapshot) as event_location,
        min(stop.event_zone_snapshot) as event_zone,
        min(stop.event_booth_snapshot) as event_booth,
        shop.id as shop_id,
        shop.code as shop_code,
        shop.name as shop_name,
        case when context.id is null then shop.building_id else null end as building_id,
        case when context.id is null then building.name else min(stop.event_location_snapshot) end as building_name,
        case when context.id is null then shop.zone_id else null end as zone_id,
        case when context.id is null then zone.name else min(stop.event_zone_snapshot) end as zone_name,
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
      group by shop.id, building.id, zone.id, profile.id, context.id, participation.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

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
    'shop_code', coalesce(rental.shop_code_snapshot, stop.shop_code_snapshot),
    'shop_name', coalesce(rental.shop_name_snapshot, stop.shop_name_snapshot),
    'shop_location', case when rental.id is not null then rental.shop_location_snapshot when stop.destination_kind = 'event'
      then nullif(concat_ws(' · ', stop.event_job_name_snapshot,
        stop.event_location_snapshot, stop.event_zone_snapshot, stop.event_booth_snapshot), '')
      else nullif(concat_ws(' · ', stop.building_name_snapshot,
        stop.floor_or_zone_snapshot), '') end,
    'destination_kind', coalesce(stop.destination_kind::text, 'regular'),
    'event_settlement_context_id', charge.event_settlement_context_id,
    'event_participation_id', context.event_participation_id,
    'settlement_policy_fingerprint', context.settlement_policy_fingerprint,
    'event_name', stop.event_job_name_snapshot,
    'event_location', stop.event_location_snapshot,
    'event_zone', stop.event_zone_snapshot,
    'event_booth', stop.event_booth_snapshot,
    'items', public.charge_line_items(charge.id),
    'total_amount', charge.original_amount
  )
  from public.delivery_charges charge
  left join public.shop_tank_rentals rental on rental.id = charge.tank_rental_id
  left join public.delivery_events event on event.id = charge.delivery_event_id
  left join public.round_stops stop on stop.id = event.round_stop_id
  left join public.event_settlement_contexts context
    on context.id = charge.event_settlement_context_id
  where charge.id = p_charge_id and charge.charge_number is not null;
$$;

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
      then nullif(concat_ws(' · ', min(stop.event_job_name_snapshot),
        min(stop.event_location_snapshot), min(stop.event_zone_snapshot),
        min(stop.event_booth_snapshot)), '')
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
    'event_name', min(stop.event_job_name_snapshot),
    'event_location', min(stop.event_location_snapshot),
    'event_zone', min(stop.event_zone_snapshot),
    'event_booth', min(stop.event_booth_snapshot),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_number', charge_detail.charge_number,
        'payment_term', charge_detail.payment_term,
        'service_date', charge_detail.service_date,
        'event_settlement_context_id', charge_detail.event_settlement_context_id,
        'location', case when rental_detail.id is not null then rental_detail.shop_location_snapshot when stop_detail.destination_kind = 'event'
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
  where payment.id = p_payment_id
  group by payment.id, shop.id, context.id;
$$;

create or replace function public.get_payment_receipt_items(p_payment_id uuid)
returns table (charge_number text, received_amount numeric(12,2), ice_type_name text,
  ice_type_unit text, quantity numeric(12,1), line_total numeric(12,2))
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_payment_visible(p_payment_id) then raise exception 'This payment cannot be viewed by the current user'; end if;
  return query select charge.charge_number, allocation.amount::numeric(12,2),
    item ->> 'name', item ->> 'unit', (item ->> 'quantity')::numeric(12,1), (item ->> 'line_total')::numeric(12,2)
  from public.payment_allocations allocation join public.delivery_charges charge on charge.id = allocation.charge_id
  cross join lateral jsonb_array_elements(public.charge_line_items(charge.id)) item
  where allocation.payment_id = p_payment_id order by charge.service_date, charge.created_at, charge.id;
end;
$$;

-- Financial totals include rental invoices. Ice quantities remain unchanged.
alter function public.accounting_transaction_rows(date,date) rename to accounting_transaction_rows_before_tank_rentals;
revoke all on function public.accounting_transaction_rows_before_tank_rentals(date,date) from public, anon, authenticated;
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
  select * from public.accounting_transaction_rows_before_tank_rentals(p_from_date, p_to_date)
  union all
  select rental.recorded_at, charge.service_date, 'INV', charge.id, charge.id,
    'delivery_charges', null::uuid, null::uuid, charge.charge_number, null::text,
    shop.id, rental.shop_code_snapshot, rental.shop_name_snapshot, null::text,
    recorder.id, recorder.display_name, null::uuid, 'ค่าเช่าถังรายครั้ง', 'ใบ',
    0::numeric, 0::numeric, charge.original_amount, 0::numeric, 0::numeric,
    charge.original_amount, charge.status::text, rental.note,
    case when charge.original_amount > coalesce(paid.amount, 0) then 'unpaid_collectible' end,
    case when charge.original_amount > coalesce(paid.amount, 0) then 'ยังรับเงินไม่ครบ' end,
    false, jsonb_build_object('charge_id', charge.id, 'charge_kind', 'tank_rental',
      'destination_kind', 'regular', 'payment_term', charge.payment_term,
      'quantity', rental.quantity, 'unit_price', rental.unit_price,
      'effective_amount', charge.original_amount, 'allocated_amount', coalesce(paid.amount, 0))
  from public.delivery_charges charge join public.shop_tank_rentals rental on rental.id = charge.tank_rental_id
  join public.shops shop on shop.id = charge.shop_id join public.users recorder on recorder.id = rental.recorded_by
  left join lateral (select sum(allocation.amount) as amount from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id and payment.status = 'active') paid on true
  where charge.service_date between p_from_date and p_to_date;
$$;
revoke all on function public.accounting_transaction_rows(date,date) from public, anon, authenticated;
notify pgrst, 'reload schema';
