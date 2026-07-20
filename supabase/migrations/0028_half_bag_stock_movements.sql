-- Stock transfers can carry a half bag. Keep the ledger, balances, snapshots,
-- and end-of-day reconciliation in the same half-bag unit.

alter table public.stock_movement_items
  alter column quantity type numeric(12, 1) using quantity::numeric(12, 1);

alter table public.stock_count_snapshot_items
  alter column system_quantity type numeric(12, 1) using system_quantity::numeric(12, 1);

alter table public.daily_stock_closure_items
  alter column system_quantity type numeric(12, 1) using system_quantity::numeric(12, 1),
  alter column actual_quantity type numeric(12, 1) using actual_quantity::numeric(12, 1),
  alter column variance_quantity type numeric(12, 1) using variance_quantity::numeric(12, 1);

alter table public.round_stock_snapshot_items
  alter column quantity type numeric(12, 1) using quantity::numeric(12, 1);

-- PostgreSQL does not allow CREATE OR REPLACE to change a function return
-- type. The function has no database-object dependants; callers resolve it by
-- name and retain the same argument signature.
drop function public.stock_balance_at(date, uuid, uuid);

create function public.stock_balance_at(
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
  ), count_adjustment as (
    select coalesce(sum(item.variance_quantity), 0) as quantity
    from public.daily_stock_closure_items item
    join public.daily_stock_closures closure on closure.service_date = item.service_date
    where item.service_date = p_service_date
      and item.location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and closure.status in ('closing', 'closed')
  )
  select (movement_totals.quantity - delivery_totals.quantity + count_adjustment.quantity)::numeric(12, 1)
  from movement_totals, delivery_totals, count_adjustment;
$$;

create or replace function public.record_stock_movement(
  p_round_id uuid,
  p_kind public.stock_movement_kind,
  p_from_location_id uuid,
  p_to_location_id uuid,
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
  v_service_date date;
  v_day_has_open_round boolean;
  v_movement_id uuid;
  v_existing_round_id uuid;
  v_item record;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can record stock movements';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select movement.round_id into v_existing_round_id
  from public.stock_movements movement
  where movement.idempotency_key = p_idempotency_key;

  if v_existing_round_id is not null then
    if v_existing_round_id <> p_round_id then
      raise exception 'This idempotency key belongs to another delivery round';
    end if;
    return public.get_stock_control_summary(p_round_id);
  end if;

  select service_date into v_service_date
  from public.delivery_rounds
  where id = p_round_id
  for update;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  select exists (
    select 1
    from public.delivery_rounds
    where service_date = v_service_date and status = 'open'
  ) into v_day_has_open_round;

  if p_kind = 'factory_order' and not v_day_has_open_round then
    raise exception 'A factory order requires an open delivery round for this service date';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'Stock movement items must be a non-empty JSON array';
  end if;

  -- Decode without a scale so validation sees the submitted value before the
  -- numeric(12, 1) storage column can round it.
  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0
      or item.quantity * 2 <> trunc(item.quantity * 2) or ice.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every stock item must use a distinct active ice type and a positive whole or half-bag quantity';
  end if;

  if p_kind = 'factory_order' then
    if p_from_location_id is not null
      or not exists (
        select 1 from public.stock_locations
        where id = p_to_location_id and kind = 'truck' and is_active
      ) then
      raise exception 'A factory order must enter an active truck location';
    end if;
  elsif p_kind = 'transfer' then
    if p_from_location_id is null or p_to_location_id is null
      or p_from_location_id = p_to_location_id then
      raise exception 'A transfer requires two different locations';
    end if;
  elsif p_kind = 'damage' then
    if p_from_location_id is null or p_to_location_id is not null
      or nullif(trim(coalesce(p_note, '')), '') is null then
      raise exception 'Damage requires a source location and a note';
    end if;
  elsif p_kind = 'return_to_factory' then
    if p_to_location_id is not null
      or not exists (
        select 1 from public.stock_locations
        where id = p_from_location_id and kind = 'truck' and is_active
      ) then
      raise exception 'A factory return must leave an active truck location';
    end if;
  end if;

  if (p_from_location_id is not null and not exists (
      select 1 from public.stock_locations where id = p_from_location_id and is_active
    )) or (p_to_location_id is not null and not exists (
      select 1 from public.stock_locations where id = p_to_location_id and is_active
    )) then
    raise exception 'Every stock location must be active';
  end if;

  if p_from_location_id is not null then
    for v_item in
      select item.ice_type_id, item.quantity
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    loop
      if public.stock_balance_at(v_service_date, p_from_location_id, v_item.ice_type_id)
        < v_item.quantity then
        raise exception 'The source location does not have enough stock';
      end if;
    end loop;
  end if;

  insert into public.stock_movements (
    service_date, round_id, kind, from_location_id, to_location_id,
    note, idempotency_key, recorded_by
  ) values (
    v_service_date, p_round_id, p_kind, p_from_location_id, p_to_location_id,
    nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, auth.uid()
  )
  returning id into v_movement_id;

  insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
  select v_movement_id, item.ice_type_id, item.quantity
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'stock_movements',
    v_movement_id,
    'created',
    jsonb_build_object(
      'round_id', p_round_id,
      'service_date', v_service_date,
      'kind', p_kind,
      'from_location_id', p_from_location_id,
      'to_location_id', p_to_location_id,
      'items', p_items,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.get_stock_control_summary(p_round_id);
end;
$$;

create or replace function public.close_daily_stock(
  p_round_id uuid default null,
  p_counts jsonb default null,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid(),
  p_service_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_date date;
  v_service_date date := p_service_date;
  v_existing_date date;
  v_truck_id uuid;
  v_source record;
  v_movement_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close daily stock';
  end if;

  if p_idempotency_key is null then
    raise exception 'A daily-close idempotency key is required';
  end if;

  if p_round_id is not null then
    select service_date into v_round_date
    from public.delivery_rounds where id = p_round_id;
    if v_round_date is null then
      raise exception 'The selected delivery round does not exist';
    elsif v_service_date is not null and v_service_date <> v_round_date then
      raise exception 'The selected delivery round belongs to another service date';
    end if;
    v_service_date := v_round_date;
  end if;

  if v_service_date is null then
    raise exception 'A stock service date is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select service_date into v_existing_date
  from public.daily_stock_closures
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_date <> v_service_date then
      raise exception 'This idempotency key belongs to another service day';
    end if;
    return public.get_daily_stock_close_state(
      p_round_id => p_round_id,
      p_service_date => v_service_date
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  perform 1
  from public.daily_stock_closures
  where service_date = v_service_date
  for update;

  if found then
    raise exception 'Stock for this service date is already closed';
  end if;

  if exists (
    select 1 from public.delivery_rounds
    where service_date = v_service_date and status = 'open'
  ) then
    raise exception 'Close every delivery round before closing daily stock';
  end if;

  -- Keep the submitted precision until the whole/half-bag check has run.
  if jsonb_typeof(p_counts) is distinct from 'array'
    or exists (
      select 1
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text)
      left join public.stock_locations location
        on location.id = input.location_id and location.is_active
      left join public.ice_types ice
        on ice.id = input.ice_type_id and ice.is_active
      where input.location_id is null or input.ice_type_id is null
        or input.actual_quantity is null or input.actual_quantity < 0
        or input.actual_quantity * 2 <> trunc(input.actual_quantity * 2)
        or location.id is null or ice.id is null
    )
    or exists (
      select 1
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text)
      group by input.location_id, input.ice_type_id
      having count(*) > 1
    )
    or (select count(*) from jsonb_to_recordset(p_counts)
          as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text))
      <> (select count(*) from public.stock_locations location
          cross join public.ice_types ice
          where location.is_active and ice.is_active) then
    raise exception 'Provide one non-negative whole or half-bag actual count for every active location and ice type';
  end if;

  select id into v_truck_id
  from public.stock_locations
  where kind = 'truck' and is_active
  order by created_at
  limit 1;

  if v_truck_id is null then
    raise exception 'An active truck location is required to return stock to the factory';
  end if;

  insert into public.daily_stock_closures (
    service_date, round_id, status, note, idempotency_key, closed_by
  ) values (
    v_service_date, p_round_id, 'closing',
    nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, auth.uid()
  );

  insert into public.daily_stock_closure_items (
    service_date, location_id, ice_type_id,
    system_quantity, actual_quantity, variance_quantity, note
  )
  select
    v_service_date,
    input.location_id,
    input.ice_type_id,
    public.stock_balance_at(v_service_date, input.location_id, input.ice_type_id),
    input.actual_quantity,
    input.actual_quantity - public.stock_balance_at(
      v_service_date, input.location_id, input.ice_type_id
    ),
    nullif(trim(coalesce(input.note, '')), '')
  from jsonb_to_recordset(p_counts)
    as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text);

  for v_source in
    select item.location_id
    from public.daily_stock_closure_items item
    where item.service_date = v_service_date
      and item.location_id <> v_truck_id
      and item.actual_quantity > 0
    group by item.location_id
  loop
    insert into public.stock_movements (
      service_date, round_id, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by
    ) values (
      v_service_date, p_round_id, 'transfer', v_source.location_id, v_truck_id,
      'รวบรวมยอดนับจริงเพื่อส่งคืนโรงงาน', gen_random_uuid(), auth.uid()
    ) returning id into v_movement_id;

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select v_movement_id, item.ice_type_id, item.actual_quantity
    from public.daily_stock_closure_items item
    where item.service_date = v_service_date
      and item.location_id = v_source.location_id
      and item.actual_quantity > 0;
  end loop;

  if exists (
    select 1 from public.daily_stock_closure_items
    where service_date = v_service_date and actual_quantity > 0
  ) then
    insert into public.stock_movements (
      service_date, round_id, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by
    ) values (
      v_service_date, p_round_id, 'return_to_factory', v_truck_id, null,
      'ส่งยอดน้ำแข็งนับจริงคงเหลือทั้งหมดกลับโรงงาน', gen_random_uuid(), auth.uid()
    ) returning id into v_movement_id;

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select v_movement_id, item.ice_type_id, sum(item.actual_quantity)
    from public.daily_stock_closure_items item
    where item.service_date = v_service_date and item.actual_quantity > 0
    group by item.ice_type_id;
  end if;

  update public.daily_stock_closures
  set status = 'closed', closed_at = now()
  where service_date = v_service_date;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, after_value
  ) values (
    auth.uid(), 'daily_stock_closures', coalesce(p_round_id, p_idempotency_key), 'closed',
    jsonb_build_object(
      'round_id', p_round_id,
      'service_date', v_service_date,
      'counts', p_counts,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.get_daily_stock_close_state(
    p_round_id => p_round_id,
    p_service_date => v_service_date
  );
end;
$$;

revoke all on function public.stock_balance_at(date, uuid, uuid) from public;
revoke all on function public.record_stock_movement(
  uuid, public.stock_movement_kind, uuid, uuid, jsonb, text, uuid
) from public;
revoke all on function public.close_daily_stock(uuid, jsonb, text, uuid, date) from public;
grant execute on function public.record_stock_movement(
  uuid, public.stock_movement_kind, uuid, uuid, jsonb, text, uuid
) to authenticated;
grant execute on function public.close_daily_stock(uuid, jsonb, text, uuid, date) to authenticated;
