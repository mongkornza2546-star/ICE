-- Add idempotency_key to stock_count_snapshots table
alter table public.stock_count_snapshots
  add column if not exists idempotency_key uuid unique,
  add column if not exists request_fingerprint text;

-- Create stock_count_variance_reviews table
create table if not exists public.stock_count_variance_reviews (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.stock_count_snapshots(id) on delete restrict,
  service_date date not null,
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  ice_type_id uuid not null references public.ice_types(id) on delete restrict,
  system_quantity numeric(12, 1) not null,
  actual_quantity numeric(12, 1) not null,
  variance_quantity numeric(12, 1) not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.users(id) on delete restrict,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  constraint stock_count_variance_reviews_check_variance check (variance_quantity = actual_quantity - system_quantity),
  constraint stock_count_variance_reviews_snapshot_ice_unique unique (snapshot_id, ice_type_id)
);

alter table public.stock_count_variance_reviews enable row level security;

create policy "managers read stock count variance reviews"
  on public.stock_count_variance_reviews for select
  using (
    public.is_active_user()
    and public.current_app_role() in ('admin', 'round_lead')
  );

-- RPC for recording location stock counts (v2)
create or replace function public.record_location_count_v2(
  p_service_date date,
  p_location_id uuid,
  p_counts jsonb,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot_id uuid;
  v_existing_id uuid;
  v_existing_date date;
  v_existing_fingerprint text;
  v_request_fingerprint text;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can count returned stock';
  end if;

  if p_service_date is null then
    raise exception 'A stock service date is required';
  end if;

  if p_idempotency_key is null then
    raise exception 'A stock-count idempotency key is required';
  end if;

  -- Validate and normalize counts before comparing an idempotent replay.
  if jsonb_typeof(p_counts) is distinct from 'array'
    or exists (
      select 1
      from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity numeric)
      left join public.ice_types ice on ice.id = input.ice_type_id and ice.is_active
      where input.ice_type_id is null or input.actual_quantity is null
        or input.actual_quantity < 0
        or input.actual_quantity * 2 <> trunc(input.actual_quantity * 2)
        or ice.id is null
    )
    or exists (
      select 1
      from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity numeric)
      group by input.ice_type_id
      having count(*) > 1
    )
    or (select count(*) from jsonb_to_recordset(p_counts) as input(ice_type_id uuid))
      <> (select count(*) from public.ice_types where is_active) then
    raise exception 'Provide one non-negative whole or half-bag count for every active ice type';
  end if;

  select md5(jsonb_build_object(
    'operation', 'location_count_v2',
    'service_date', p_service_date,
    'location_id', p_location_id,
    'counts', (
      select jsonb_agg(
        jsonb_build_object('ice_type_id', input.ice_type_id, 'actual_quantity', input.actual_quantity)
        order by input.ice_type_id
      )
      from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity numeric)
    ),
    'note', nullif(trim(coalesce(p_note, '')), '')
  )::text) into v_request_fingerprint;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select id, service_date, request_fingerprint
  into v_existing_id, v_existing_date, v_existing_fingerprint
  from public.stock_count_snapshots
  where idempotency_key = p_idempotency_key;

  if v_existing_id is not null then
    if v_existing_date <> p_service_date
      or v_existing_fingerprint is distinct from v_request_fingerprint then
      raise exception 'This idempotency key belongs to another stock count request';
    end if;
    return public.get_stock_control_summary(null, v_existing_date);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures
    where service_date = p_service_date and status = 'closed'
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if not exists (
    select 1
    from public.stock_locations
    where id = p_location_id and is_active and holds_inventory
  ) then
    raise exception 'The selected stock location is not an active stock holder';
  end if;

  -- Insert snapshot header
  insert into public.stock_count_snapshots (
    service_date, location_id, note, counted_by, idempotency_key, request_fingerprint
  ) values (
    p_service_date, p_location_id,
    nullif(trim(coalesce(p_note, '')), ''), auth.uid(), p_idempotency_key, v_request_fingerprint
  ) returning id into v_snapshot_id;

  -- Insert snapshot items
  insert into public.stock_count_snapshot_items (
    snapshot_id, ice_type_id, system_quantity, actual_quantity, variance_quantity
  )
  select
    v_snapshot_id,
    input.ice_type_id,
    public.stock_balance_at(p_service_date, p_location_id, input.ice_type_id),
    input.actual_quantity,
    input.actual_quantity - public.stock_balance_at(p_service_date, p_location_id, input.ice_type_id)
  from jsonb_to_recordset(p_counts) as input(ice_type_id uuid, actual_quantity numeric);

  update public.stock_count_variance_reviews
  set status = 'rejected',
      reviewed_by = auth.uid(),
      reviewed_at = clock_timestamp(),
      review_note = 'Superseded by a newer stock count'
  where service_date = p_service_date
    and location_id = p_location_id
    and status = 'pending';

  insert into public.stock_count_variance_reviews (
    snapshot_id, service_date, location_id, ice_type_id,
    system_quantity, actual_quantity, variance_quantity
  )
  select
    v_snapshot_id, p_service_date, p_location_id, item.ice_type_id,
    item.system_quantity, item.actual_quantity, item.variance_quantity
  from public.stock_count_snapshot_items item
  join public.stock_locations location on location.id = p_location_id
  where item.snapshot_id = v_snapshot_id
    and location.requires_daily_count
    and item.variance_quantity <> 0;

  -- Log audit
  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'stock_count_snapshots',
    v_snapshot_id,
    'created',
    jsonb_build_object(
      'service_date', p_service_date,
      'location_id', p_location_id,
      'counts', p_counts,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.get_stock_control_summary(null, p_service_date);
end;
$$;

-- RPC for closing daily stock (v2)
create or replace function public.close_daily_stock_v2(
  p_counts jsonb,
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
      p_round_id => null,
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

  -- Validate counts JSON (must provide counts only for active locations with holds_inventory = true)
  if jsonb_typeof(p_counts) is distinct from 'array'
    or exists (
      select 1
      from jsonb_to_recordset(p_counts)
        as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text)
      left join public.stock_locations location
        on location.id = input.location_id and location.is_active and location.holds_inventory
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
          where location.is_active and location.holds_inventory and ice.is_active) then
    raise exception 'Provide one non-negative whole or half-bag actual count for every active location and ice type';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_counts)
      as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text)
    join public.stock_locations location on location.id = input.location_id
    where location.requires_daily_count
      and input.actual_quantity <> public.stock_balance_at(
        v_service_date, input.location_id, input.ice_type_id
      )
      and not exists (
        select 1
        from public.stock_count_snapshots snapshot
        join public.stock_count_snapshot_items count_item
          on count_item.snapshot_id = snapshot.id
          and count_item.ice_type_id = input.ice_type_id
        join public.stock_count_variance_reviews review
          on review.snapshot_id = snapshot.id
          and review.ice_type_id = input.ice_type_id
        where snapshot.service_date = v_service_date
          and snapshot.location_id = input.location_id
          and snapshot.id = (
            select latest.id
            from public.stock_count_snapshots latest
            where latest.service_date = v_service_date
              and latest.location_id = input.location_id
            order by latest.counted_at desc, latest.id desc
            limit 1
          )
          and public.is_stock_count_snapshot_current(snapshot.id)
          and count_item.system_quantity = public.stock_balance_at(
            v_service_date, input.location_id, input.ice_type_id
          )
          and count_item.actual_quantity = input.actual_quantity
          and review.status = 'approved'
      )
  ) then
    raise exception 'Approve every variance in the latest stock counts before closing daily stock';
  end if;

  -- Resolve truck ID for return transfers
  select id into v_truck_id
  from public.stock_locations
  where kind = 'truck' and is_active and holds_inventory and is_courier_source
  limit 1;

  if v_truck_id is null then
    select id into v_truck_id
    from public.stock_locations
    where kind = 'truck' and is_active and holds_inventory
    order by code
    limit 1;
  end if;

  if v_truck_id is null then
    raise exception 'An active truck location is required to return stock to the factory';
  end if;

  -- Insert daily stock closure header
  insert into public.daily_stock_closures (
    service_date, status, note, idempotency_key, closed_by
  ) values (
    v_service_date, 'closing',
    nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, auth.uid()
  );

  -- Insert daily stock closure items
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
    input.actual_quantity - public.stock_balance_at(v_service_date, input.location_id, input.ice_type_id),
    nullif(trim(coalesce(input.note, '')), '')
  from jsonb_to_recordset(p_counts)
    as input(location_id uuid, ice_type_id uuid, actual_quantity numeric, note text);

  -- Transfer actual stock from other stock holding locations to courier truck
  for v_source in
    select item.location_id
    from public.daily_stock_closure_items item
    join public.stock_locations loc on loc.id = item.location_id
    where item.service_date = v_service_date
      and item.location_id <> v_truck_id
      and loc.holds_inventory
      and item.actual_quantity > 0
    group by item.location_id
  loop
    insert into public.stock_movements (
      service_date, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by
    ) values (
      v_service_date, 'transfer', v_source.location_id, v_truck_id,
      'รวบรวมยอดนับจริงเพื่อส่งคืนโรงงาน', gen_random_uuid(), auth.uid()
    ) returning id into v_movement_id;

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select v_movement_id, item.ice_type_id, item.actual_quantity
    from public.daily_stock_closure_items item
    where item.service_date = v_service_date
      and item.location_id = v_source.location_id
      and item.actual_quantity > 0;
  end loop;

  -- Return all stock from courier truck to factory (virtual factory = NULL)
  if exists (
    select 1 from public.daily_stock_closure_items item
    join public.stock_locations loc on loc.id = item.location_id
    where item.service_date = v_service_date and item.actual_quantity > 0 and loc.holds_inventory
  ) then
    insert into public.stock_movements (
      service_date, kind, from_location_id, to_location_id,
      note, idempotency_key, recorded_by
    ) values (
      v_service_date, 'return_to_factory', v_truck_id, null,
      'ส่งยอดน้ำแข็งนับจริงคงเหลือทั้งหมดกลับโรงงาน', gen_random_uuid(), auth.uid()
    ) returning id into v_movement_id;

    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    select v_movement_id, item.ice_type_id, sum(item.actual_quantity)
    from public.daily_stock_closure_items item
    join public.stock_locations loc on loc.id = item.location_id
    where item.service_date = v_service_date and item.actual_quantity > 0 and loc.holds_inventory
    group by item.ice_type_id;
  end if;

  -- Set status to closed
  update public.daily_stock_closures
  set status = 'closed', closed_at = now()
  where service_date = v_service_date;

  -- Log audit
  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'daily_stock_closures', p_idempotency_key, 'closed',
    jsonb_build_object(
      'service_date', v_service_date,
      'counts', p_counts,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.get_daily_stock_close_state(
    p_round_id => null,
    p_service_date => v_service_date
  );
end;
$$;

-- RPC for reviewing variance
create or replace function public.approve_stock_count_variance(
  p_review_id uuid,
  p_status text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can review stock count variance';
  end if;

  if p_status not in ('approved', 'rejected') then
    raise exception 'Invalid review status';
  end if;

  update public.stock_count_variance_reviews
  set status = p_status,
      reviewed_by = auth.uid(),
      reviewed_at = clock_timestamp(),
      review_note = nullif(trim(p_note), '')
  where id = p_review_id and status = 'pending';

  if not found then
    raise exception 'The variance review does not exist or has already been reviewed';
  end if;
end;
$$;

create or replace function public.get_stock_count_variance_reviews(
  p_service_date date
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
    raise exception 'Only a round lead or admin can view stock count variance';
  end if;

  if p_service_date is null then
    raise exception 'A stock service date is required';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', review.id,
    'service_date', review.service_date,
    'location_id', review.location_id,
    'location_name', location.name,
    'ice_type_id', review.ice_type_id,
    'ice_type_name', ice.name,
    'unit', ice.unit,
    'system_quantity', review.system_quantity,
    'actual_quantity', review.actual_quantity,
    'variance_quantity', review.variance_quantity,
    'status', review.status,
    'reviewed_by', review.reviewed_by,
    'reviewed_by_name', reviewer.display_name,
    'reviewed_at', review.reviewed_at,
    'review_note', review.review_note,
    'created_at', review.created_at
  ) order by review.created_at, review.id), '[]'::jsonb)
  into v_result
  from public.stock_count_variance_reviews review
  join public.stock_locations location on location.id = review.location_id
  join public.ice_types ice on ice.id = review.ice_type_id
  left join public.users reviewer on reviewer.id = review.reviewed_by
  where review.service_date = p_service_date;

  return v_result;
end;
$$;

-- Override get_daily_stock_count_readiness to filter by holds_inventory = true
create or replace function public.get_daily_stock_count_readiness(
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
    raise exception 'Only a round lead or admin can view stock count readiness';
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'location_id', location.id,
    'location_name', location.name,
    'status', case
      when snapshot.id is null then 'uncounted'
      when public.is_stock_count_snapshot_current(snapshot.id) then 'current'
      else 'stale'
    end,
    'snapshot', case when snapshot.id is null then null else jsonb_build_object(
      'id', snapshot.id,
      'counted_at', snapshot.counted_at,
      'note', snapshot.note,
      'location_id', location.id,
      'location_name', location.name,
      'counted_by', counter.display_name,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'ice_type_id', item.ice_type_id,
          'ice_type_name', ice.name,
          'unit', ice.unit,
          'system_quantity', item.system_quantity,
          'actual_quantity', item.actual_quantity,
          'variance_quantity', item.variance_quantity
        ) order by ice.code)
        from public.stock_count_snapshot_items item
        join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
        where item.snapshot_id = snapshot.id
      ), '[]'::jsonb)
    ) end
  ) order by location.name), '[]'::jsonb)
  into v_result
  from public.stock_locations location
  left join lateral (
    select candidate.*
    from public.stock_count_snapshots candidate
    where candidate.service_date = v_service_date
      and candidate.location_id = location.id
    order by candidate.counted_at desc, candidate.id desc
    limit 1
  ) snapshot on true
  left join public.users counter on counter.id = snapshot.counted_by
  where location.is_active
    and location.holds_inventory
    and location.requires_daily_count;

  return v_result;
end;
$$;

-- Override close_daily_stock_from_latest_counts to filter by holds_inventory = true and use close_daily_stock_v2
create or replace function public.close_daily_stock_from_latest_counts(
  p_round_id uuid default null,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid(),
  p_service_date date default null,
  p_use_system_for_uncounted boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_date date;
  v_service_date date := p_service_date;
  v_counts jsonb;
  v_missing_count integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close daily stock';
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

  if p_idempotency_key is null then
    raise exception 'A daily-close idempotency key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1 from public.daily_stock_closures
    where idempotency_key = p_idempotency_key
  ) then
    return public.close_daily_stock_v2(
      p_counts => '[]'::jsonb,
      p_note => p_note,
      p_idempotency_key => p_idempotency_key,
      p_service_date => v_service_date
    );
  end if;

  select count(*)::integer
  into v_missing_count
  from public.stock_locations location
  left join lateral (
    select snapshot.id
    from public.stock_count_snapshots snapshot
    where snapshot.service_date = v_service_date
      and snapshot.location_id = location.id
    order by snapshot.counted_at desc, snapshot.id desc
    limit 1
  ) latest on true
  where location.is_active
    and location.holds_inventory
    and location.requires_daily_count
    and (latest.id is null or not public.is_stock_count_snapshot_current(latest.id));

  if v_missing_count > 0 and not p_use_system_for_uncounted then
    raise exception 'Count every active stock location again before closing daily stock';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'location_id', location.id,
    'ice_type_id', ice.id,
    'actual_quantity', case
      when public.is_stock_count_snapshot_current(latest.id)
        then count_item.actual_quantity
      else public.stock_balance_at(v_service_date, location.id, ice.id)
    end,
    'note', null
  ) order by location.name, ice.code), '[]'::jsonb)
  into v_counts
  from public.stock_locations location
  cross join public.ice_types ice
  left join lateral (
    select snapshot.id
    from public.stock_count_snapshots snapshot
    where snapshot.service_date = v_service_date
      and snapshot.location_id = location.id
    order by snapshot.counted_at desc, snapshot.id desc
    limit 1
  ) latest on true
  left join public.stock_count_snapshot_items count_item
    on count_item.snapshot_id = latest.id and count_item.ice_type_id = ice.id
  where location.is_active and location.holds_inventory and ice.is_active;

  return public.close_daily_stock_v2(
    p_counts => v_counts,
    p_note => p_note,
    p_idempotency_key => p_idempotency_key,
    p_service_date => v_service_date
  );
end;
$$;

-- Grant permissions to authenticated users
grant execute on function public.record_location_count_v2(date, uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.close_daily_stock_v2(jsonb, text, uuid, date) to authenticated;
grant execute on function public.approve_stock_count_variance(uuid, text, text) to authenticated;
grant execute on function public.get_stock_count_variance_reviews(date) to authenticated;
grant execute on function public.get_daily_stock_count_readiness(uuid, date) to authenticated;
grant execute on function public.close_daily_stock_from_latest_counts(uuid, text, uuid, date, boolean) to authenticated;
