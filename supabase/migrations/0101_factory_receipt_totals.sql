-- A factory order is the expected quantity. A receipt records what arrived,
-- and only the immutable actual receipt quantity contributes to availability.

create table public.factory_receipts (
  id uuid primary key default gen_random_uuid(),
  factory_order_id uuid not null unique references public.stock_movements(id) on delete restrict,
  service_date date not null,
  truck_location_id uuid not null references public.stock_locations(id) on delete restrict,
  note text,
  recorded_by uuid not null references public.users(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  idempotency_key uuid not null unique,
  request_fingerprint text not null
);

create table public.factory_receipt_items (
  factory_receipt_id uuid not null references public.factory_receipts(id) on delete restrict,
  ice_type_id uuid not null references public.ice_types(id) on delete restrict,
  expected_quantity numeric(12, 1) not null check (expected_quantity > 0),
  actual_quantity numeric(12, 1) not null check (actual_quantity >= 0),
  variance_quantity numeric(12, 1) not null,
  primary key (factory_receipt_id, ice_type_id),
  check (variance_quantity = actual_quantity - expected_quantity)
);

alter table public.factory_receipts enable row level security;
alter table public.factory_receipt_items enable row level security;

create policy "managers read factory receipts"
  on public.factory_receipts for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));

create policy "managers read factory receipt items"
  on public.factory_receipt_items for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));

create index factory_receipts_date_truck_idx
  on public.factory_receipts (service_date, truck_location_id, recorded_at desc);

create or replace function public.prevent_received_factory_order_cancellation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.kind = 'factory_order'
    and old.status = 'active'
    and new.status = 'cancelled'
    and exists (
      select 1 from public.factory_receipts receipt
      where receipt.factory_order_id = old.id
    ) then
    raise exception 'A received factory order cannot be cancelled';
  end if;
  return new;
end;
$$;

create trigger stock_movements_prevent_received_factory_order_cancellation
  before update of status on public.stock_movements
  for each row execute function public.prevent_received_factory_order_cancellation();

create or replace function public.prevent_daily_close_with_pending_factory_receipts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.stock_movements movement
    where movement.service_date = new.service_date
      and movement.kind = 'factory_order'
      and movement.status = 'active'
      and not exists (
        select 1
        from public.factory_receipts receipt
        where receipt.factory_order_id = movement.id
      )
  ) then
    raise exception 'Receive or cancel every factory order before closing daily stock';
  end if;
  return new;
end;
$$;

create trigger daily_stock_closures_require_factory_receipts
  before insert on public.daily_stock_closures
  for each row execute function public.prevent_daily_close_with_pending_factory_receipts();

create or replace function public.stock_balance_at(
  p_service_date date,
  p_location_id uuid,
  p_ice_type_id uuid
)
returns numeric(12, 1)
language sql
stable
security definer
set search_path = public
as $$
  with movement_totals as (
    select
      coalesce(sum(item.quantity) filter (where movement.to_location_id = p_location_id), 0)
        - coalesce(sum(item.quantity) filter (where movement.from_location_id = p_location_id), 0)
        as quantity
    from public.stock_movements movement
    join public.stock_movement_items item on item.movement_id = movement.id
    where movement.service_date = p_service_date
      and movement.status = 'active'
      and movement.kind <> 'factory_order'
      and item.ice_type_id = p_ice_type_id
      and (movement.from_location_id = p_location_id or movement.to_location_id = p_location_id)
  ), delivery_totals as (
    select coalesce(sum(item.quantity), 0) as quantity
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id = event.id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.delivery_rounds round on round.id = stop.round_id
    where round.service_date = p_service_date
      and event.status = 'active'
      and event.source_stock_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
  ), receipt_totals as (
    select coalesce(sum(item.actual_quantity), 0) as quantity
    from public.factory_receipts receipt
    join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
    join public.stock_movements factory_order on factory_order.id = receipt.factory_order_id
    where receipt.service_date = p_service_date
      and receipt.truck_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and factory_order.status = 'active'
  ), count_adjustment as (
    select coalesce(sum(item.variance_quantity), 0) as quantity
    from public.daily_stock_closure_items item
    join public.daily_stock_closures closure on closure.service_date = item.service_date
    where item.service_date = p_service_date
      and item.location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and closure.status in ('closing', 'closed')
  )
  select (
    movement_totals.quantity
    - delivery_totals.quantity
    + receipt_totals.quantity
    + count_adjustment.quantity
  )::numeric(12, 1)
  from movement_totals, delivery_totals, receipt_totals, count_adjustment;
$$;

create or replace function public.get_factory_receipt_summary(
  p_service_date date,
  p_truck_location_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_truck_id uuid := p_truck_location_id;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view factory receipts';
  end if;

  if p_service_date is null then
    raise exception 'A factory receipt service date is required';
  end if;

  if v_truck_id is null then
    select location.id into v_truck_id
    from public.stock_locations location
    where location.kind = 'truck'
      and location.is_active
      and location.is_courier_source
    order by location.code
    limit 1;
  end if;

  if v_truck_id is null then
    return jsonb_build_object(
      'service_date', p_service_date,
      'truck_location_id', null,
      'truck_location_name', null,
      'receipts', '[]'::jsonb
    );
  end if;

  if not exists (
    select 1 from public.stock_locations location
    where location.id = v_truck_id and location.kind = 'truck' and location.is_active
  ) then
    raise exception 'Factory receipts require an active truck location';
  end if;

  select jsonb_build_object(
    'service_date', p_service_date,
    'truck_location_id', truck.id,
    'truck_location_name', truck.name,
    'receipts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'factory_order_id', movement.id,
        'recorded_at', movement.recorded_at,
        'status', case when receipt.id is null then 'pending' else 'recorded' end,
        'note', receipt.note,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ice_type_id', ice.id,
            'ice_type_name', ice.name,
            'unit', ice.unit,
            'expected_quantity', coalesce(receipt_item.expected_quantity, order_item.quantity),
            'actual_quantity', receipt_item.actual_quantity,
            'variance_quantity', receipt_item.variance_quantity
          ) order by ice.code)
          from public.stock_movement_items order_item
          join public.ice_types ice on ice.id = order_item.ice_type_id
          left join public.factory_receipt_items receipt_item
            on receipt_item.factory_receipt_id = receipt.id
            and receipt_item.ice_type_id = order_item.ice_type_id
          where order_item.movement_id = movement.id
        ), '[]'::jsonb)
      ) order by movement.recorded_at)
      from public.stock_movements movement
      left join public.factory_receipts receipt on receipt.factory_order_id = movement.id
      where movement.service_date = p_service_date
        and movement.to_location_id = truck.id
        and movement.kind = 'factory_order'
        and movement.status = 'active'
    ), '[]'::jsonb)
  ) into v_result
  from public.stock_locations truck
  where truck.id = v_truck_id;

  return v_result;
end;
$$;

create or replace function public.record_factory_receipt(
  p_factory_order_id uuid,
  p_items jsonb,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.stock_movements%rowtype;
  v_existing public.factory_receipts%rowtype;
  v_receipt_id uuid;
  v_request_fingerprint text;
  v_item record;
  v_actual_item_count integer;
  v_expected_item_count integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can record factory receipts';
  end if;

  if p_factory_order_id is null or p_idempotency_key is null then
    raise exception 'A factory order and receipt idempotency key are required';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0
    or exists (
      select 1
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, actual_quantity numeric)
      where item.ice_type_id is null or item.actual_quantity is null or item.actual_quantity < 0
        or item.actual_quantity * 2 <> trunc(item.actual_quantity * 2)
    )
    or exists (
      select 1 from jsonb_to_recordset(p_items) as item(ice_type_id uuid)
      group by item.ice_type_id having count(*) > 1
    ) then
    raise exception 'Every factory receipt item must use a distinct non-negative whole or half-bag quantity';
  end if;

  select md5(jsonb_build_object(
    'operation', 'factory_receipt',
    'factory_order_id', p_factory_order_id,
    'items', (
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', item.ice_type_id,
        'actual_quantity', item.actual_quantity
      ) order by item.ice_type_id)
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, actual_quantity numeric)
    ),
    'note', nullif(trim(coalesce(p_note, '')), '')
  )::text) into v_request_fingerprint;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select * into v_existing
  from public.factory_receipts receipt
  where receipt.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.factory_order_id <> p_factory_order_id
      or v_existing.request_fingerprint <> v_request_fingerprint then
      raise exception 'This idempotency key belongs to another factory receipt request';
    end if;
    return public.get_factory_receipt_summary(v_existing.service_date, v_existing.truck_location_id);
  end if;

  select * into v_order
  from public.stock_movements movement
  where movement.id = p_factory_order_id
  for update;

  if not found or v_order.kind <> 'factory_order' or v_order.status <> 'active'
    or v_order.to_location_id is null then
    raise exception 'The selected factory order is not active';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_order.service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures closure
    where closure.service_date = v_order.service_date and closure.status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if exists (
    select 1 from public.factory_receipts receipt where receipt.factory_order_id = v_order.id
  ) then
    raise exception 'This factory order has already been received';
  end if;

  select count(*) into v_actual_item_count
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid);

  select count(*) into v_expected_item_count
  from public.stock_movement_items
  where movement_id = v_order.id;

  if v_actual_item_count <> v_expected_item_count or exists (
      select 1
      from public.stock_movement_items expected_item
      left join jsonb_to_recordset(p_items) as received_item(ice_type_id uuid, actual_quantity numeric)
        on received_item.ice_type_id = expected_item.ice_type_id
      where expected_item.movement_id = v_order.id and received_item.ice_type_id is null
    ) then
    raise exception 'Provide an actual quantity for every factory order item';
  end if;

  -- A short receipt must be saved before the missing stock is transferred or
  -- delivered.  Otherwise the stock ledger could not remain non-negative.
  for v_item in
    select expected_item.ice_type_id, received_item.actual_quantity
    from public.stock_movement_items expected_item
    join jsonb_to_recordset(p_items) as received_item(ice_type_id uuid, actual_quantity numeric)
      on received_item.ice_type_id = expected_item.ice_type_id
    where expected_item.movement_id = v_order.id
  loop
    if public.stock_balance_at(v_order.service_date, v_order.to_location_id, v_item.ice_type_id)
        + v_item.actual_quantity < 0 then
      raise exception 'Cannot record this shortage after stock has left the truck';
    end if;
  end loop;

  insert into public.factory_receipts (
    factory_order_id, service_date, truck_location_id, note, recorded_by,
    idempotency_key, request_fingerprint
  ) values (
    v_order.id, v_order.service_date, v_order.to_location_id,
    nullif(trim(coalesce(p_note, '')), ''), auth.uid(),
    p_idempotency_key, v_request_fingerprint
  ) returning id into v_receipt_id;

  insert into public.factory_receipt_items (
    factory_receipt_id, ice_type_id, expected_quantity, actual_quantity, variance_quantity
  )
  select
    v_receipt_id, expected_item.ice_type_id, expected_item.quantity,
    received_item.actual_quantity, received_item.actual_quantity - expected_item.quantity
  from public.stock_movement_items expected_item
  join jsonb_to_recordset(p_items) as received_item(ice_type_id uuid, actual_quantity numeric)
    on received_item.ice_type_id = expected_item.ice_type_id
  where expected_item.movement_id = v_order.id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'factory_receipts', v_receipt_id, 'created',
    jsonb_build_object(
      'factory_order_id', v_order.id,
      'service_date', v_order.service_date,
      'truck_location_id', v_order.to_location_id,
      'items', p_items,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.get_factory_receipt_summary(v_order.service_date, v_order.to_location_id);
end;
$$;

revoke all on function public.get_factory_receipt_summary(date, uuid) from public;
grant execute on function public.get_factory_receipt_summary(date, uuid) to authenticated;
revoke all on function public.record_factory_receipt(uuid, jsonb, text, uuid) from public;
grant execute on function public.record_factory_receipt(uuid, jsonb, text, uuid) to authenticated;
