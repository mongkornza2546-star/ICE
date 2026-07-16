-- Factory orders belong to one service date and one receiving truck. Delivery
-- rounds remain optional reporting groups and are not stock containers.

alter table public.stock_movements
  alter column round_id drop not null;

alter table public.stock_movements
  add constraint stock_movements_round_or_factory_order_check
  check (round_id is not null or kind in ('factory_order', 'transfer', 'return_to_factory'));

alter table public.stock_count_snapshots
  alter column round_id drop not null;

alter table public.daily_stock_closures
  alter column round_id drop not null;

comment on column public.stock_movements.round_id is
  'Optional reporting round. Day-level factory orders and close-generated movements use service_date instead.';

comment on column public.stock_count_snapshots.round_id is
  'Optional reporting round. service_date is the stock-count boundary.';

comment on column public.daily_stock_closures.round_id is
  'Optional reporting round. service_date is the daily-close boundary.';

create index stock_movements_factory_order_date_truck_idx
  on public.stock_movements (service_date, to_location_id, recorded_at desc)
  where kind = 'factory_order' and status = 'active';

create or replace function public.get_factory_order_summary(
  p_service_date date,
  p_truck_location_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view factory orders';
  end if;

  if p_service_date is null then
    raise exception 'A factory order service date is required';
  end if;

  if p_truck_location_id is null or not exists (
    select 1
    from public.stock_locations location
    where location.id = p_truck_location_id
      and location.kind = 'truck'
      and location.is_active
  ) then
    raise exception 'Factory orders require an active truck location';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Factory order history limit must be between 1 and 200';
  end if;

  select jsonb_build_object(
    'service_date', p_service_date,
    'locations', jsonb_build_array(
      jsonb_build_object(
        'id', truck.id,
        'code', truck.code,
        'name', truck.name,
        'kind', truck.kind,
        'balances', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'ice_type_id', ice.id,
              'ice_type_name', ice.name,
              'unit', ice.unit,
              'quantity', public.stock_balance_at(
                p_service_date,
                truck.id,
                ice.id
              )
            ) order by ice.code
          )
          from public.ice_types ice
          where ice.is_active
        ), '[]'::jsonb)
      )
    ),
    'order_count', (
      select count(*)
      from public.stock_movements movement
      where movement.service_date = p_service_date
        and movement.kind = 'factory_order'
        and movement.status = 'active'
        and movement.to_location_id = p_truck_location_id
    ),
    'ordered_totals', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'ice_type_id', total.ice_type_id,
          'ice_type_name', total.ice_type_name,
          'unit', total.unit,
          'quantity', total.quantity
        ) order by total.ice_type_code
      )
      from (
        select
          ice.id as ice_type_id,
          ice.code as ice_type_code,
          ice.name as ice_type_name,
          ice.unit,
          sum(item.quantity)::integer as quantity
        from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        join public.ice_types ice on ice.id = item.ice_type_id
        where movement.service_date = p_service_date
          and movement.kind = 'factory_order'
          and movement.status = 'active'
          and movement.to_location_id = p_truck_location_id
        group by ice.id, ice.code, ice.name, ice.unit
      ) total
    ), '[]'::jsonb),
    'recent_movements', coalesce((
      select jsonb_agg(to_jsonb(recent) order by recent.recorded_at desc)
      from (
        select
          movement.id,
          movement.kind,
          movement.recorded_at,
          movement.note,
          source.name as from_location_name,
          destination.name as to_location_name,
          recorder.display_name as recorded_by,
          (
            select coalesce(jsonb_agg(
              jsonb_build_object(
                'ice_type_id', ice.id,
                'ice_type_name', ice.name,
                'unit', ice.unit,
                'quantity', item.quantity
              ) order by ice.code
            ), '[]'::jsonb)
            from public.stock_movement_items item
            join public.ice_types ice on ice.id = item.ice_type_id
            where item.movement_id = movement.id
          ) as items
        from public.stock_movements movement
        left join public.stock_locations source on source.id = movement.from_location_id
        left join public.stock_locations destination on destination.id = movement.to_location_id
        join public.users recorder on recorder.id = movement.recorded_by
        where movement.service_date = p_service_date
          and movement.kind = 'factory_order'
          and movement.status = 'active'
          and movement.to_location_id = p_truck_location_id
        order by movement.recorded_at desc
        limit p_limit
      ) recent
    ), '[]'::jsonb)
  )
  into v_result
  from public.stock_locations truck
  where truck.id = p_truck_location_id
    and truck.kind = 'truck'
    and truck.is_active;

  return v_result;
end;
$$;

create or replace function public.record_factory_order(
  p_service_date date,
  p_truck_location_id uuid,
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
  v_existing public.stock_movements%rowtype;
  v_item record;
  v_movement_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can record factory orders';
  end if;

  if p_service_date is null then
    raise exception 'A factory order service date is required';
  end if;

  if p_truck_location_id is null then
    raise exception 'A factory order truck location is required';
  end if;

  if p_idempotency_key is null then
    raise exception 'A factory order idempotency key is required';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'Factory order items must be a non-empty JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    where item.ice_type_id is null
      or item.quantity is null
      or item.quantity <= 0
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every factory order item must use a distinct ice type and a positive quantity';
  end if;

  -- A weak connection may submit one request more than once. Lock and resolve
  -- the retry before checking mutable day/truck/ice state.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select movement.* into v_existing
  from public.stock_movements movement
  where movement.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.kind <> 'factory_order'
      or v_existing.service_date <> p_service_date
      or v_existing.from_location_id is not null
      or v_existing.to_location_id is distinct from p_truck_location_id
      or v_existing.note is distinct from nullif(trim(coalesce(p_note, '')), '')
      or coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'ice_type_id', item.ice_type_id,
              'quantity', item.quantity
            ) order by item.ice_type_id
          )
          from public.stock_movement_items item
          where item.movement_id = v_existing.id
        ), '[]'::jsonb) is distinct from (
          select jsonb_agg(
            jsonb_build_object(
              'ice_type_id', item.ice_type_id,
              'quantity', item.quantity
            ) order by item.ice_type_id
          )
          from jsonb_to_recordset(p_items)
            as item(ice_type_id uuid, quantity integer)
        ) then
      raise exception 'This idempotency key belongs to another factory order';
    end if;

    return public.get_factory_order_summary(
      p_service_date,
      p_truck_location_id,
      50
    );
  end if;

  -- Ice-type retirement takes the same locks. Sorting prevents deadlocks when
  -- one order contains more than one type.
  for v_item in
    select item.ice_type_id
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid)
    order by item.ice_type_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('ice_type:' || v_item.ice_type_id::text, 0)
    );
  end loop;

  -- The ledger and daily close share one atomic boundary across every round.
  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

  if exists (
    select 1
    from public.daily_stock_closures closure
    where closure.service_date = p_service_date
      and closure.status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if not exists (
    select 1
    from public.stock_locations location
    where location.id = p_truck_location_id
      and location.kind = 'truck'
      and location.is_active
  ) then
    raise exception 'Factory orders require an active truck location';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid)
    left join public.ice_types ice
      on ice.id = item.ice_type_id and ice.is_active
    where ice.id is null
  ) then
    raise exception 'Every factory order item must use an active ice type';
  end if;

  insert into public.stock_movements (
    service_date,
    round_id,
    kind,
    from_location_id,
    to_location_id,
    note,
    idempotency_key,
    recorded_by
  ) values (
    p_service_date,
    null,
    'factory_order',
    null,
    p_truck_location_id,
    nullif(trim(coalesce(p_note, '')), ''),
    p_idempotency_key,
    auth.uid()
  )
  returning id into v_movement_id;

  insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
  select v_movement_id, item.ice_type_id, item.quantity
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

  insert into public.audit_logs (
    actor_id,
    entity_type,
    entity_id,
    action,
    after_value
  ) values (
    auth.uid(),
    'stock_movements',
    v_movement_id,
    'created',
    jsonb_build_object(
      'round_id', null,
      'service_date', p_service_date,
      'kind', 'factory_order',
      'from_location_id', null,
      'to_location_id', p_truck_location_id,
      'items', p_items,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.get_factory_order_summary(
    p_service_date,
    p_truck_location_id,
    50
  );
end;
$$;

-- Stock reads now resolve by service date. p_round_id remains optional so
-- existing callers can keep using a round as reporting provenance.
drop function if exists public.get_stock_control_summary(uuid);
create function public.get_stock_control_summary(
  p_round_id uuid default null,
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_round_date date;
  v_service_date date := p_service_date;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view stock control';
  end if;

  if p_round_id is not null then
    select service_date into v_round_date
    from public.delivery_rounds
    where id = p_round_id;

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

  select jsonb_build_object(
    'service_date', v_service_date,
    'locations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', location.id,
          'code', location.code,
          'name', location.name,
          'kind', location.kind,
          'balances', (
            select coalesce(jsonb_agg(
              jsonb_build_object(
                'ice_type_id', ice.id,
                'ice_type_name', ice.name,
                'unit', ice.unit,
                'quantity', public.stock_balance_at(v_service_date, location.id, ice.id)
              ) order by ice.code
            ), '[]'::jsonb)
            from public.ice_types ice
            where ice.is_active
          )
        ) order by
          case location.kind
            when 'truck' then 0
            when 'work_site' then 1
            when 'team' then 2
            when 'small_vehicle' then 3
            when 'reserve_bin' then 4
            else 5
          end,
          location.name
      )
      from public.stock_locations location
      where location.is_active
    ), '[]'::jsonb),
    'recent_movements', coalesce((
      select jsonb_agg(to_jsonb(recent) order by recent.recorded_at desc)
      from (
        select
          movement.id,
          movement.kind,
          movement.recorded_at,
          movement.note,
          source.name as from_location_name,
          destination.name as to_location_name,
          recorder.display_name as recorded_by,
          (
            select coalesce(jsonb_agg(
              jsonb_build_object(
                'ice_type_id', ice.id,
                'ice_type_name', ice.name,
                'unit', ice.unit,
                'quantity', item.quantity
              ) order by ice.code
            ), '[]'::jsonb)
            from public.stock_movement_items item
            join public.ice_types ice on ice.id = item.ice_type_id
            where item.movement_id = movement.id
          ) as items
        from public.stock_movements movement
        left join public.stock_locations source on source.id = movement.from_location_id
        left join public.stock_locations destination on destination.id = movement.to_location_id
        join public.users recorder on recorder.id = movement.recorded_by
        where movement.service_date = v_service_date
          and movement.status = 'active'
        order by movement.recorded_at desc
        limit 12
      ) recent
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

drop function if exists public.get_location_count_history(uuid);
create function public.get_location_count_history(
  p_round_id uuid default null,
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_round_date date;
  v_service_date date := p_service_date;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view stock counts';
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

  select coalesce(jsonb_agg(to_jsonb(history) order by history.counted_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      snapshot.id,
      snapshot.counted_at,
      snapshot.note,
      location.id as location_id,
      location.name as location_name,
      counter.display_name as counted_by,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'ice_type_id', item.ice_type_id,
          'ice_type_name', ice.name,
          'unit', ice.unit,
          'system_quantity', item.system_quantity,
          'actual_quantity', item.actual_quantity,
          'variance_quantity', item.variance_quantity
        ) order by ice.code), '[]'::jsonb)
        from public.stock_count_snapshot_items item
        join public.ice_types ice on ice.id = item.ice_type_id
        where item.snapshot_id = snapshot.id
      ) as items
    from public.stock_count_snapshots snapshot
    join public.stock_locations location on location.id = snapshot.location_id
    join public.users counter on counter.id = snapshot.counted_by
    where snapshot.service_date = v_service_date
    order by snapshot.counted_at desc
    limit 20
  ) history;

  return v_result;
end;
$$;

drop function if exists public.record_location_count(uuid, uuid, jsonb, text);
create function public.record_location_count(
  p_round_id uuid default null,
  p_location_id uuid default null,
  p_counts jsonb default null,
  p_note text default null,
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
  v_snapshot_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can count returned stock';
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

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures
    where service_date = v_service_date and status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if not exists (
    select 1 from public.stock_locations where id = p_location_id and is_active
  ) then
    raise exception 'The selected stock location is not active';
  end if;

  if jsonb_typeof(p_counts) is distinct from 'array'
    or exists (
      select 1
      from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity integer)
      left join public.ice_types ice on ice.id = input.ice_type_id and ice.is_active
      where input.ice_type_id is null or input.actual_quantity is null
        or input.actual_quantity < 0 or ice.id is null
    )
    or exists (
      select 1
      from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity integer)
      group by input.ice_type_id
      having count(*) > 1
    )
    or (select count(*) from jsonb_to_recordset(p_counts) as input(ice_type_id uuid))
      <> (select count(*) from public.ice_types where is_active) then
    raise exception 'Provide one non-negative actual count for every active ice type';
  end if;

  insert into public.stock_count_snapshots (
    service_date, round_id, location_id, note, counted_by
  ) values (
    v_service_date, p_round_id, p_location_id,
    nullif(trim(coalesce(p_note, '')), ''), auth.uid()
  ) returning id into v_snapshot_id;

  insert into public.stock_count_snapshot_items (
    snapshot_id, ice_type_id, system_quantity, actual_quantity, variance_quantity
  )
  select
    v_snapshot_id,
    input.ice_type_id,
    public.stock_balance_at(v_service_date, p_location_id, input.ice_type_id),
    input.actual_quantity,
    input.actual_quantity - public.stock_balance_at(
      v_service_date, p_location_id, input.ice_type_id
    )
  from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity integer);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'stock_count_snapshots', v_snapshot_id, 'counted',
    jsonb_build_object(
      'round_id', p_round_id,
      'service_date', v_service_date,
      'location_id', p_location_id,
      'counts', p_counts,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return jsonb_build_object('snapshot_id', v_snapshot_id);
end;
$$;

drop function if exists public.get_daily_stock_close_state(uuid);
create function public.get_daily_stock_close_state(
  p_round_id uuid default null,
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_round_date date;
  v_service_date date := p_service_date;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view daily stock close';
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

  select jsonb_build_object(
    'service_date', v_service_date,
    'open_round_count', (
      select count(*) from public.delivery_rounds
      where service_date = v_service_date and status = 'open'
    ),
    'is_closed', coalesce(closure.status = 'closed', false),
    'closed_at', closure.closed_at,
    'closed_by', closer.display_name,
    'note', closure.note,
    'counts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'location_id', item.location_id,
        'location_name', location.name,
        'ice_type_id', item.ice_type_id,
        'ice_type_name', ice.name,
        'unit', ice.unit,
        'system_quantity', item.system_quantity,
        'actual_quantity', item.actual_quantity,
        'variance_quantity', item.variance_quantity,
        'note', item.note
      ) order by location.name, ice.code)
      from public.daily_stock_closure_items item
      join public.stock_locations location on location.id = item.location_id
      join public.ice_types ice on ice.id = item.ice_type_id
      where item.service_date = v_service_date
    ), '[]'::jsonb)
  ) into v_result
  from (select 1) seed
  left join public.daily_stock_closures closure on closure.service_date = v_service_date
  left join public.users closer on closer.id = closure.closed_by;

  return v_result;
end;
$$;

drop function if exists public.close_daily_stock(uuid, jsonb, text, uuid);
create function public.close_daily_stock(
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

  if jsonb_typeof(p_counts) is distinct from 'array'
    or exists (
      select 1
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity integer, note text)
      left join public.stock_locations location
        on location.id = input.location_id and location.is_active
      left join public.ice_types ice
        on ice.id = input.ice_type_id and ice.is_active
      where input.location_id is null or input.ice_type_id is null
        or input.actual_quantity is null or input.actual_quantity < 0
        or location.id is null or ice.id is null
    )
    or exists (
      select 1
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity integer, note text)
      group by input.location_id, input.ice_type_id
      having count(*) > 1
    )
    or (select count(*) from jsonb_to_recordset(p_counts)
          as input(location_id uuid, ice_type_id uuid, actual_quantity integer, note text))
      <> (select count(*) from public.stock_locations location
          cross join public.ice_types ice
          where location.is_active and ice.is_active) then
    raise exception 'Provide one non-negative actual count for every active location and ice type';
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
    as input(location_id uuid, ice_type_id uuid, actual_quantity integer, note text);

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
    select v_movement_id, item.ice_type_id, sum(item.actual_quantity)::integer
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

-- Factory orders can now establish an open stock date before any round exists.
-- Include movement-only dates when protecting an ice type with an open balance.
create or replace function public.save_ice_type(
  p_ice_type_id uuid,
  p_code text,
  p_name text,
  p_unit text,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.ice_types%rowtype;
  v_saved public.ice_types%rowtype;
  v_day record;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can save ice types';
  end if;

  if nullif(trim(p_code), '') is null
    or nullif(trim(p_name), '') is null
    or nullif(trim(p_unit), '') is null then
    raise exception 'Ice type code, name, and unit are required';
  end if;

  if p_ice_type_id is null then
    insert into public.ice_types (code, name, unit, is_active)
    values (upper(trim(p_code)), trim(p_name), trim(p_unit), p_is_active)
    returning * into v_saved;
  else
    perform pg_advisory_xact_lock(
      hashtextextended('ice_type:' || p_ice_type_id::text, 0)
    );

    select * into v_existing
    from public.ice_types
    where id = p_ice_type_id
    for update;

    if not found then
      raise exception 'The selected ice type does not exist';
    end if;

    if v_existing.is_active and not p_is_active then
      for v_day in
        select day.service_date
        from (
          select round.service_date
          from public.delivery_rounds round
          union
          select movement.service_date
          from public.stock_movements movement
        ) day
        where not exists (
          select 1
          from public.daily_stock_closures closure
          where closure.service_date = day.service_date
            and closure.status = 'closed'
        )
        order by day.service_date
      loop
        perform pg_advisory_xact_lock(hashtextextended(v_day.service_date::text, 0));
      end loop;

      if exists (
        select 1
        from (
          select round.service_date
          from public.delivery_rounds round
          union
          select movement.service_date
          from public.stock_movements movement
        ) day
        cross join public.stock_locations location
        where not exists (
            select 1
            from public.daily_stock_closures closure
            where closure.service_date = day.service_date
              and closure.status = 'closed'
          )
          and public.stock_balance_at(
            day.service_date,
            location.id,
            p_ice_type_id
          ) <> 0
      ) then
        raise exception 'An ice type with stock on an open service day cannot be deactivated';
      end if;
    end if;

    update public.ice_types
    set code = upper(trim(p_code)),
        name = trim(p_name),
        unit = trim(p_unit),
        is_active = p_is_active
    where id = p_ice_type_id
    returning * into v_saved;
  end if;

  return jsonb_build_object(
    'id', v_saved.id,
    'code', v_saved.code,
    'name', v_saved.name,
    'unit', v_saved.unit,
    'is_active', v_saved.is_active
  );
end;
$$;

revoke all on function public.get_factory_order_summary(date, uuid, integer) from public;
revoke all on function public.record_factory_order(date, uuid, jsonb, text, uuid) from public;
revoke all on function public.save_ice_type(uuid, text, text, text, boolean) from public;
revoke all on function public.get_stock_control_summary(uuid, date) from public;
revoke all on function public.get_location_count_history(uuid, date) from public;
revoke all on function public.record_location_count(uuid, uuid, jsonb, text, date) from public;
revoke all on function public.get_daily_stock_close_state(uuid, date) from public;
revoke all on function public.close_daily_stock(uuid, jsonb, text, uuid, date) from public;
grant execute on function public.get_factory_order_summary(date, uuid, integer) to authenticated;
grant execute on function public.record_factory_order(date, uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.save_ice_type(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.get_stock_control_summary(uuid, date) to authenticated;
grant execute on function public.get_location_count_history(uuid, date) to authenticated;
grant execute on function public.record_location_count(uuid, uuid, jsonb, text, date) to authenticated;
grant execute on function public.get_daily_stock_close_state(uuid, date) to authenticated;
grant execute on function public.close_daily_stock(uuid, jsonb, text, uuid, date) to authenticated;
