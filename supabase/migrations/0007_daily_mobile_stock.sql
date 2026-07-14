-- Phase 3: day-wide mobile stock ledger for factory orders, transfers, damage,
-- and automatic delivery deductions from each shop's stock location.

do $$
begin
  create type public.stock_location_kind as enum (
    'truck', 'team', 'small_vehicle', 'work_site', 'reserve_bin', 'front_vehicle'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.stock_movement_kind as enum (
    'factory_order', 'transfer', 'damage', 'return_to_factory'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.stock_movement_status as enum ('active', 'cancelled');
exception when duplicate_object then null;
end $$;

create table public.stock_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  kind public.stock_location_kind not null,
  building_id uuid references public.buildings(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  round_id uuid not null references public.delivery_rounds(id),
  kind public.stock_movement_kind not null,
  from_location_id uuid references public.stock_locations(id),
  to_location_id uuid references public.stock_locations(id),
  note text,
  idempotency_key uuid not null unique,
  status public.stock_movement_status not null default 'active',
  recorded_by uuid not null references public.users(id),
  recorded_at timestamptz not null default now(),
  cancelled_by uuid references public.users(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  check (from_location_id is distinct from to_location_id),
  check ((kind = 'factory_order' and from_location_id is null and to_location_id is not null)
      or (kind = 'transfer' and from_location_id is not null and to_location_id is not null)
      or (kind in ('damage', 'return_to_factory') and from_location_id is not null and to_location_id is null)),
  check ((status = 'active' and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
      or (status = 'cancelled' and cancelled_by is not null and cancelled_at is not null
          and nullif(trim(coalesce(cancellation_reason, '')), '') is not null))
);

create table public.stock_movement_items (
  movement_id uuid not null references public.stock_movements(id),
  ice_type_id uuid not null references public.ice_types(id),
  quantity integer not null check (quantity > 0),
  primary key (movement_id, ice_type_id)
);

insert into public.stock_locations (code, name, kind)
values ('TRUCK-MAIN', 'รถบรรทุกหลัก', 'truck')
on conflict (code) do nothing;

insert into public.stock_locations (code, name, kind, building_id)
select 'SITE-' || b.code, b.name || ' · จุดปฏิบัติงาน', 'work_site', b.id
from public.buildings b
on conflict (code) do nothing;

create or replace function public.ensure_building_stock_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.stock_locations (code, name, kind, building_id)
  values ('SITE-' || new.code, new.name || ' · จุดปฏิบัติงาน', 'work_site', new.id)
  on conflict (code) do nothing;
  return new;
end;
$$;

create trigger buildings_create_stock_location
  after insert on public.buildings
  for each row execute function public.ensure_building_stock_location();

alter table public.shops
  add column stock_location_id uuid references public.stock_locations(id);

update public.shops s
set stock_location_id = location.id
from public.stock_locations location
where location.building_id = s.building_id
  and location.kind = 'work_site'
  and s.stock_location_id is null;

alter table public.shops alter column stock_location_id set not null;

alter table public.delivery_events
  add column source_stock_location_id uuid references public.stock_locations(id);

-- Existing delivery events intentionally remain outside the stock ledger.
-- Their original source was never captured and backfilling the shop's current
-- source would create unsupported historical balances. The insert trigger below
-- requires a source for every delivery recorded after this migration.

create or replace function public.assign_shop_stock_location()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_building_id uuid;
begin
  select building_id into v_building_id
  from public.building_zones
  where id = new.zone_id;

  if v_building_id is null then
    raise exception 'The selected building zone does not exist';
  end if;

  if new.stock_location_id is null
    or not exists (
      select 1
      from public.stock_locations location
      where location.id = new.stock_location_id
        and location.building_id = v_building_id
        and location.is_active
    ) then
    select id into new.stock_location_id
    from public.stock_locations
    where building_id = v_building_id
      and kind = 'work_site'
      and is_active
    order by created_at
    limit 1;
  end if;

  if new.stock_location_id is null then
    raise exception 'The shop building does not have an active stock location';
  end if;

  return new;
end;
$$;

create trigger shops_assign_stock_location
  before insert or update of zone_id, building_id, stock_location_id on public.shops
  for each row execute function public.assign_shop_stock_location();

create or replace function public.set_delivery_source_location()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_stock_location_id is null then
    select shop.stock_location_id into new.source_stock_location_id
    from public.round_stops stop
    join public.shops shop on shop.id = stop.shop_id
    where stop.id = new.round_stop_id;
  end if;

  if new.source_stock_location_id is null then
    raise exception 'The selected shop does not have a stock source';
  end if;

  return new;
end;
$$;

create trigger delivery_events_set_stock_source
  before insert on public.delivery_events
  for each row execute function public.set_delivery_source_location();

create or replace function public.stock_balance_at(
  p_service_date date,
  p_location_id uuid,
  p_ice_type_id uuid
)
returns integer
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
  )
  select (movement_totals.quantity - delivery_totals.quantity)::integer
  from movement_totals, delivery_totals;
$$;

create or replace function public.get_stock_control_summary(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view stock control';
  end if;

  select service_date into v_service_date
  from public.delivery_rounds
  where id = p_round_id;

  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
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

  -- One retry key may be submitted concurrently after a weak connection.
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

  -- Stock is shared by every round on the same service date. Serialize all
  -- checked outgoing movements for that day, not only movements in one round.
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'Stock movement items must be a non-empty JSON array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0 or ice.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every stock item must use a distinct active ice type and a positive quantity';
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
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
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
  from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer);

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

-- Delivery and manual movement writes consume the same day-wide stock pool.
-- Replace the Phase 2 RPC so both paths take the same service-date lock and
-- validate the same balance before anything leaves a stock location.
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
  v_service_date date;
  v_source_location_id uuid;
  v_event_id uuid;
  v_existing_event_id uuid;
  v_existing_round_stop_id uuid;
  v_item_count integer;
  v_item record;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  -- A concurrent retry must observe the first committed event before checking
  -- the now-reduced stock balance.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

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

  select s.round_id, r.status, r.service_date, shop.stock_location_id
  into v_round_id, v_round_status, v_service_date, v_source_location_id
  from public.round_stops s
  join public.delivery_rounds r on r.id = s.round_id
  join public.shops shop on shop.id = s.shop_id
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

  if not exists (
    select 1
    from public.stock_locations
    where id = v_source_location_id and is_active
  ) then
    raise exception 'The selected shop does not have an active stock source';
  end if;

  -- Serialize every checked stock deduction for this service date, including
  -- deliveries from other rounds and manual transfers recorded by a manager.
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

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
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0 or ice.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
    group by item.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Every delivery item must use a distinct active ice type and a positive quantity';
  end if;

  for v_item in
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity integer)
  loop
    if public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)
      < v_item.quantity then
      raise exception 'The source location does not have enough stock';
    end if;
  end loop;

  insert into public.delivery_events (
    round_stop_id,
    recorded_by,
    client_recorded_at,
    idempotency_key,
    note,
    source_stock_location_id
  )
  values (
    p_round_stop_id,
    auth.uid(),
    p_client_recorded_at,
    p_idempotency_key,
    nullif(trim(coalesce(p_note, '')), ''),
    v_source_location_id
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
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'source_stock_location_id', v_source_location_id
    )
  );

  return public.delivery_event_response(v_event_id);
end;
$$;

create trigger stock_locations_updated_at
  before update on public.stock_locations
  for each row execute function public.set_updated_at();

create index stock_locations_kind_active_idx
  on public.stock_locations (kind, is_active, name);
create index stock_movements_service_date_idx
  on public.stock_movements (service_date, recorded_at desc)
  where status = 'active';
create index stock_movements_round_idx on public.stock_movements (round_id);
create index delivery_events_stock_source_idx
  on public.delivery_events (source_stock_location_id, recorded_at)
  where status = 'active';
create index shops_stock_location_idx on public.shops (stock_location_id);

alter table public.stock_locations enable row level security;
alter table public.stock_movements enable row level security;
alter table public.stock_movement_items enable row level security;

create policy "active users read stock locations" on public.stock_locations for select
  using (public.is_active_user());
create policy "admins manage stock locations" on public.stock_locations for all
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');
create policy "admins or leads read stock movements" on public.stock_movements for select
  using (public.current_app_role() in ('admin', 'round_lead'));
create policy "admins or leads read stock movement items" on public.stock_movement_items for select
  using (public.current_app_role() in ('admin', 'round_lead'));

revoke all on function public.stock_balance_at(date, uuid, uuid) from public;
revoke all on function public.get_stock_control_summary(uuid) from public;
revoke all on function public.record_stock_movement(
  uuid, public.stock_movement_kind, uuid, uuid, jsonb, text, uuid
) from public;
grant execute on function public.get_stock_control_summary(uuid) to authenticated;
grant execute on function public.record_stock_movement(
  uuid, public.stock_movement_kind, uuid, uuid, jsonb, text, uuid
) to authenticated;
