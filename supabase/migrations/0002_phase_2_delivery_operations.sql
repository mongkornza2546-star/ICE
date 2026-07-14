-- Phase 2: atomic round setup and employee delivery operations.
-- The mobile app calls these RPCs rather than writing delivery tables directly.

-- The Phase 1 policies use this helper directly. Keep inactive former members
-- from retaining read access after their account is disabled.
create or replace function public.is_round_member(target_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and exists(
    select 1
    from public.delivery_round_members
    where round_id = target_round_id and user_id = auth.uid()
  );
$$;

create or replace function public.create_delivery_round(
  p_service_date date,
  p_name text,
  p_route_id uuid,
  p_member_ids uuid[],
  p_loaded_quantities jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_member_ids uuid[];
  v_expected_stop_count integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can create a delivery round';
  end if;

  if p_service_date is null or nullif(trim(p_name), '') is null then
    raise exception 'A service date and round name are required';
  end if;

  if jsonb_typeof(p_loaded_quantities) is distinct from 'array' then
    raise exception 'Loaded quantities must be a JSON array';
  end if;

  select array_agg(distinct member_id)
  into v_member_ids
  from unnest(coalesce(p_member_ids, '{}'::uuid[]) || auth.uid()) as member_id;

  if exists (
    select 1
    from unnest(v_member_ids) as member_id
    left join public.users u on u.id = member_id
    where u.id is null or not u.is_active
  ) then
    raise exception 'Every round member must be an active user';
  end if;

  if not exists (
    select 1 from public.routes where id = p_route_id and is_active
  ) then
    raise exception 'The selected route is not active';
  end if;

  if not exists (select 1 from public.ice_types where is_active) then
    raise exception 'At least one active ice type is required';
  end if;

  select count(*)
  into v_expected_stop_count
  from public.route_shops rs
  join public.shops s on s.id = rs.shop_id and s.status = 'active'
  join public.buildings b on b.id = s.building_id and b.is_active
  where rs.route_id = p_route_id and rs.is_active;

  if v_expected_stop_count = 0 then
    raise exception 'The selected route has no active shops';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_loaded_quantities) as q(ice_type_id uuid, quantity integer)
    left join public.ice_types i on i.id = q.ice_type_id and i.is_active
    where q.ice_type_id is null or q.quantity is null or q.quantity < 0 or i.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_loaded_quantities) as q(ice_type_id uuid, quantity integer)
    group by q.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Loaded quantities must name each active ice type once with a non-negative quantity';
  end if;

  insert into public.delivery_rounds (service_date, name, route_id, opened_by)
  values (p_service_date, trim(p_name), p_route_id, auth.uid())
  returning id into v_round_id;

  insert into public.delivery_round_members (round_id, user_id)
  select v_round_id, member_id
  from unnest(v_member_ids) as member_id;

  insert into public.round_stops (
    round_id,
    shop_id,
    shop_code_snapshot,
    shop_name_snapshot,
    building_id_snapshot,
    building_name_snapshot,
    floor_or_zone_snapshot,
    sequence_no,
    updated_by
  )
  select
    v_round_id,
    s.id,
    s.code,
    s.name,
    b.id,
    b.name,
    s.floor_or_zone,
    rs.sequence_no,
    auth.uid()
  from public.route_shops rs
  join public.shops s on s.id = rs.shop_id and s.status = 'active'
  join public.buildings b on b.id = s.building_id and b.is_active
  where rs.route_id = p_route_id and rs.is_active
  order by rs.sequence_no;

  insert into public.round_ice_counts (round_id, ice_type_id, loaded_quantity, updated_by)
  select
    v_round_id,
    i.id,
    coalesce(q.quantity, 0),
    auth.uid()
  from public.ice_types i
  left join jsonb_to_recordset(p_loaded_quantities) as q(ice_type_id uuid, quantity integer)
    on q.ice_type_id = i.id
  where i.is_active;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'delivery_rounds',
    v_round_id,
    'created',
    jsonb_build_object('service_date', p_service_date, 'name', trim(p_name), 'route_id', p_route_id)
  );

  return v_round_id;
end;
$$;

create or replace function public.delivery_event_response(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'event_id', e.id,
    'round_stop_id', e.round_stop_id,
    'recorded_by', e.recorded_by,
    'recorded_at', e.recorded_at,
    'client_recorded_at', e.client_recorded_at,
    'note', e.note,
    'items', coalesce(
      jsonb_agg(
        jsonb_build_object('ice_type_id', i.ice_type_id, 'quantity', i.quantity)
        order by i.ice_type_id
      ) filter (where i.ice_type_id is not null),
      '[]'::jsonb
    )
  )
  from public.delivery_events e
  left join public.delivery_items i on i.delivery_event_id = e.id
  where e.id = p_event_id
  group by e.id;
$$;

create or replace function public.record_delivery(
  p_round_stop_id uuid,
  p_items jsonb,
  p_stop_status public.shop_round_status default 'delivered',
  p_note text default null,
  p_client_recorded_at timestamptz default null,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_round_status public.delivery_round_status;
  v_event_id uuid;
  v_existing_event_id uuid;
  v_existing_round_stop_id uuid;
  v_item_count integer;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  select e.id, e.round_stop_id
  into v_existing_event_id, v_existing_round_stop_id
  from public.delivery_events e
  where e.idempotency_key = p_idempotency_key;

  if v_existing_event_id is not null then
    if not public.is_delivery_event_visible(v_existing_event_id) then
      raise exception 'This delivery request cannot be viewed by the current user';
    end if;
    if v_existing_round_stop_id <> p_round_stop_id then
      raise exception 'This idempotency key belongs to a different shop';
    end if;
    return public.delivery_event_response(v_existing_event_id);
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Delivery items must be a JSON array';
  end if;

  select s.round_id, r.status
  into v_round_id, v_round_status
  from public.round_stops s
  join public.delivery_rounds r on r.id = s.round_id
  where s.id = p_round_stop_id
  for update of r;

  if v_round_id is null then
    raise exception 'The selected shop is not in a delivery round';
  end if;

  if public.current_app_role() not in ('admin', 'round_lead')
    and not public.is_round_member(v_round_id) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  if v_round_status <> 'open' then
    raise exception 'This delivery round is already closed';
  end if;

  select count(*)
  into v_item_count
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

  if p_stop_status = 'pending' then
    raise exception 'A delivery record cannot reset a shop to pending';
  elsif p_stop_status = 'delivered' then
    if v_item_count = 0 then
      raise exception 'A delivered shop requires at least one ice item';
    end if;
  elsif v_item_count <> 0 or nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'A non-delivery status requires a note and cannot include ice items';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    left join public.ice_types i on i.id = item.ice_type_id and i.is_active
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0 or i.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every delivery item must use a distinct active ice type and a positive quantity';
  end if;

  insert into public.delivery_events (
    round_stop_id,
    recorded_by,
    client_recorded_at,
    idempotency_key,
    note
  )
  values (
    p_round_stop_id,
    auth.uid(),
    p_client_recorded_at,
    p_idempotency_key,
    nullif(trim(coalesce(p_note, '')), '')
  )
  on conflict (idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select id, round_stop_id
    into v_event_id, v_existing_round_stop_id
    from public.delivery_events
    where idempotency_key = p_idempotency_key;
    if v_event_id is null or not public.is_delivery_event_visible(v_event_id) then
      raise exception 'This delivery request cannot be viewed by the current user';
    end if;
    if v_existing_round_stop_id <> p_round_stop_id then
      raise exception 'This idempotency key belongs to a different shop';
    end if;
    return public.delivery_event_response(v_event_id);
  end if;

  insert into public.delivery_items (delivery_event_id, ice_type_id, quantity)
  select v_event_id, item.ice_type_id, item.quantity
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

  update public.round_stops
  set status = p_stop_status,
      note = nullif(trim(coalesce(p_note, '')), ''),
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_round_stop_id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'delivery_events',
    v_event_id,
    'created',
    jsonb_build_object(
      'round_stop_id', p_round_stop_id,
      'items', p_items,
      'stop_status', p_stop_status,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return public.delivery_event_response(v_event_id);
end;
$$;

create or replace function public.get_round_shop_cards(
  p_round_id uuid,
  p_building_id uuid default null
)
returns table (
  round_stop_id uuid,
  shop_id uuid,
  shop_code text,
  shop_name text,
  building_id uuid,
  building_name text,
  floor_or_zone text,
  sequence_no integer,
  image_path text,
  payment_status public.shop_payment_status,
  stop_status public.shop_round_status,
  stop_note text,
  today_history jsonb,
  today_totals jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_can_view_all boolean;
begin
  select service_date into v_service_date from public.delivery_rounds where id = p_round_id;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  v_can_view_all := public.current_app_role() in ('admin', 'round_lead');

  if not public.is_active_user()
    or (not coalesce(v_can_view_all, false)
      and not public.is_round_member(p_round_id)) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  return query
  with daily_events as (
    select
      day_stop.shop_id,
      e.id,
      e.recorded_at,
      day_round.name as round_name,
      u.display_name as recorded_by_name,
      coalesce(
        jsonb_object_agg(i.ice_type_id, i.quantity) filter (where i.ice_type_id is not null),
        '{}'::jsonb
      ) as items
    from public.round_stops day_stop
    join public.delivery_rounds day_round on day_round.id = day_stop.round_id
    join public.delivery_events e on e.round_stop_id = day_stop.id and e.status = 'active'
    join public.users u on u.id = e.recorded_by
    left join public.delivery_items i on i.delivery_event_id = e.id
    where day_round.service_date = v_service_date
      and (v_can_view_all or public.is_round_member(day_round.id))
    group by day_stop.shop_id, e.id, e.recorded_at, day_round.name, u.display_name
  ), daily_history as (
    select
      daily_events.shop_id,
      jsonb_agg(
        jsonb_build_object(
          'event_id', id,
          'recorded_at', recorded_at,
          'round_name', round_name,
          'recorded_by', recorded_by_name,
          'items', items
        )
        order by recorded_at
      ) as history
    from daily_events
    group by daily_events.shop_id
  ), daily_item_totals as (
    select
      day_stop.shop_id,
      t.ice_type_id,
      sum(t.quantity) as quantity
    from public.round_stops day_stop
    join public.delivery_rounds day_round on day_round.id = day_stop.round_id
    join public.delivery_events e on e.round_stop_id = day_stop.id and e.status = 'active'
    join public.delivery_items t on t.delivery_event_id = e.id
    where day_round.service_date = v_service_date
      and (v_can_view_all or public.is_round_member(day_round.id))
    group by day_stop.shop_id, t.ice_type_id
  ), daily_totals as (
    select
      daily_item_totals.shop_id,
      jsonb_object_agg(ice_type_id, quantity) as totals
    from daily_item_totals
    group by daily_item_totals.shop_id
  )
  select
    s.id,
    s.shop_id,
    s.shop_code_snapshot,
    s.shop_name_snapshot,
    s.building_id_snapshot,
    s.building_name_snapshot,
    s.floor_or_zone_snapshot,
    s.sequence_no,
    shop.image_path,
    shop.payment_status,
    s.status,
    s.note,
    coalesce(h.history, '[]'::jsonb),
    coalesce(t.totals, '{}'::jsonb)
  from public.round_stops s
  join public.shops shop on shop.id = s.shop_id
  left join daily_history h on h.shop_id = s.shop_id
  left join daily_totals t on t.shop_id = s.shop_id
  where s.round_id = p_round_id
    and (p_building_id is null or s.building_id_snapshot = p_building_id)
  order by s.sequence_no;
end;
$$;

revoke all on function public.create_delivery_round(date, text, uuid, uuid[], jsonb) from public;
revoke all on function public.delivery_event_response(uuid) from public;
revoke all on function public.record_delivery(uuid, jsonb, public.shop_round_status, text, timestamptz, uuid) from public;
revoke all on function public.get_round_shop_cards(uuid, uuid) from public;
grant execute on function public.create_delivery_round(date, text, uuid, uuid[], jsonb) to authenticated;
grant execute on function public.record_delivery(uuid, jsonb, public.shop_round_status, text, timestamptz, uuid) to authenticated;
grant execute on function public.get_round_shop_cards(uuid, uuid) to authenticated;
