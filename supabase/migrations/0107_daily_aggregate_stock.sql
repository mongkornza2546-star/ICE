-- Daily aggregate stock is the operational source of truth. Physical stock
-- locations and transfers remain as distribution/audit snapshots, but they do
-- not gate POS sales or change the aggregate quantity.

alter table public.delivery_items
  drop column if exists line_total;

drop view public.round_ice_reconciliation;

alter table public.delivery_items
  alter column quantity type numeric(12, 1) using quantity::numeric(12, 1);

alter table public.delivery_items
  add column line_total numeric(12,2)
    generated always as ((quantity * unit_price)::numeric(12,2)) stored;

create view public.round_ice_reconciliation
with (security_invoker = true)
as
select
  c.round_id,
  c.ice_type_id,
  c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity as expected_quantity,
  coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as delivered_quantity,
  (c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity)
    - coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as variance_quantity
from public.round_ice_counts c
left join public.round_stops s on s.round_id = c.round_id
left join public.delivery_events e on e.round_stop_id = s.id
left join public.delivery_items i on i.delivery_event_id = e.id and i.ice_type_id = c.ice_type_id
group by c.round_id, c.ice_type_id, c.loaded_quantity, c.replenished_quantity,
  c.remaining_quantity, c.damaged_quantity;

create table public.daily_stock_uses (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  kind text not null check (kind = 'refill'),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  note text,
  idempotency_key uuid not null unique,
  request_fingerprint text not null,
  recorded_by uuid not null references public.users(id),
  recorded_at timestamptz not null default now(),
  cancelled_by uuid references public.users(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  check (
    (status = 'active' and cancelled_by is null and cancelled_at is null
      and cancellation_reason is null)
    or
    (status = 'cancelled' and cancelled_by is not null and cancelled_at is not null
      and nullif(trim(coalesce(cancellation_reason, '')), '') is not null)
  )
);

create table public.daily_stock_use_items (
  use_id uuid not null references public.daily_stock_uses(id),
  ice_type_id uuid not null references public.ice_types(id),
  quantity numeric(12,1) not null check (quantity > 0 and mod(quantity, 0.5) = 0),
  primary key (use_id, ice_type_id)
);

create table public.daily_aggregate_stock_closures (
  service_date date primary key,
  status text not null default 'closing' check (status in ('closing', 'closed')),
  note text,
  idempotency_key uuid not null unique,
  closed_by uuid not null references public.users(id),
  closed_at timestamptz not null default now()
);

create table public.daily_aggregate_stock_closure_items (
  service_date date not null references public.daily_aggregate_stock_closures(service_date),
  ice_type_id uuid not null references public.ice_types(id),
  system_quantity numeric(12,1) not null,
  actual_quantity numeric(12,1) not null check (actual_quantity >= 0),
  variance_quantity numeric(12,1) not null,
  note text,
  primary key (service_date, ice_type_id),
  check (variance_quantity = actual_quantity - system_quantity)
);

create or replace function public.enforce_open_daily_aggregate_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date := case when tg_op = 'DELETE'
    then old.service_date else new.service_date end;
begin
  if exists (
    select 1
    from public.daily_aggregate_stock_closures closure
    where closure.service_date = v_service_date
      or (
        tg_op = 'UPDATE'
        and closure.service_date = old.service_date
      )
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists stock_movements_require_open_daily_aggregate_stock
  on public.stock_movements;
create trigger stock_movements_require_open_daily_aggregate_stock
before insert or update or delete on public.stock_movements
for each row execute function public.enforce_open_daily_aggregate_stock_movement();

alter table public.daily_stock_uses enable row level security;
alter table public.daily_stock_use_items enable row level security;
alter table public.daily_aggregate_stock_closures enable row level security;
alter table public.daily_aggregate_stock_closure_items enable row level security;

create policy "active users read daily stock uses"
  on public.daily_stock_uses for select
  using (public.is_active_user());
create policy "active users read daily stock use items"
  on public.daily_stock_use_items for select
  using (public.is_active_user());
create policy "managers read aggregate stock closures"
  on public.daily_aggregate_stock_closures for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "managers read aggregate stock closure items"
  on public.daily_aggregate_stock_closure_items for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));

create or replace function public.daily_aggregate_stock_balance_at(
  p_service_date date,
  p_ice_type_id uuid
)
returns numeric(12,1)
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (
    select 1
    from public.daily_aggregate_stock_closures closure
    where closure.service_date = p_service_date
      and closure.status = 'closed'
  ) then 0::numeric(12,1) else (
    coalesce((
      select sum(item.quantity)
      from public.stock_movements movement
      join public.stock_movement_items item on item.movement_id = movement.id
      where movement.service_date = p_service_date
        and movement.status = 'active'
        and movement.kind = 'factory_order'
        and item.ice_type_id = p_ice_type_id
        and not exists (
          select 1
          from public.factory_receipts receipt
          where receipt.factory_order_id = movement.id
        )
    ), 0)
    + coalesce((
      select sum(item.actual_quantity)
      from public.factory_receipts receipt
      join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
      join public.stock_movements movement on movement.id = receipt.factory_order_id
      where receipt.service_date = p_service_date
        and movement.status = 'active'
        and item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(item.quantity)
      from public.delivery_events event
      join public.delivery_items item on item.delivery_event_id = event.id
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.delivery_rounds round on round.id = stop.round_id
      where round.service_date = p_service_date
        and event.status = 'active'
        and event.source_stock_location_id is not null
        and item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(item.quantity)
      from public.daily_stock_uses usage
      join public.daily_stock_use_items item on item.use_id = usage.id
      where usage.service_date = p_service_date
        and usage.status = 'active'
        and item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(item.quantity)
      from public.stock_movements movement
      join public.stock_movement_items item on item.movement_id = movement.id
      where movement.service_date = p_service_date
        and movement.status = 'active'
        and movement.kind in ('damage', 'return_to_factory')
        and item.ice_type_id = p_ice_type_id
    ), 0)
  )::numeric(12,1) end;
$$;

create or replace function public.get_daily_aggregate_stock_summary(
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date := coalesce(
    p_service_date,
    (clock_timestamp() at time zone 'Asia/Bangkok')::date
  );
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  return jsonb_build_object(
    'service_date', v_service_date,
    'status', case when exists (
      select 1 from public.daily_aggregate_stock_closures
      where service_date = v_service_date
    ) then 'closed' else 'open' end,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', ice.id,
        'code', ice.code,
        'name', ice.name,
        'unit', ice.unit,
        'ordered_quantity', totals.ordered_quantity,
        'sold_quantity', totals.sold_quantity,
        'refill_quantity', totals.refill_quantity,
        'damaged_quantity', totals.damaged_quantity,
        'returned_quantity', (
          totals.returned_quantity + coalesce(closure_item.actual_quantity, 0)
        )::numeric(12,1),
        'available_quantity', public.daily_aggregate_stock_balance_at(v_service_date, ice.id),
        'actual_quantity', closure_item.actual_quantity,
        'variance_quantity', closure_item.variance_quantity
      ) order by ice.code)
      from public.ice_types ice
      cross join lateral (
        select
          (
            coalesce((
              select sum(item.quantity)
              from public.stock_movements movement
              join public.stock_movement_items item on item.movement_id = movement.id
              where movement.service_date = v_service_date
                and movement.status = 'active'
                and movement.kind = 'factory_order'
                and item.ice_type_id = ice.id
                and not exists (
                  select 1
                  from public.factory_receipts receipt
                  where receipt.factory_order_id = movement.id
                )
            ), 0)
            + coalesce((
              select sum(item.actual_quantity)
              from public.factory_receipts receipt
              join public.factory_receipt_items item
                on item.factory_receipt_id = receipt.id
              join public.stock_movements movement
                on movement.id = receipt.factory_order_id
              where receipt.service_date = v_service_date
                and movement.status = 'active'
                and item.ice_type_id = ice.id
            ), 0)
          )::numeric(12,1) as ordered_quantity,
          coalesce((
            select sum(item.quantity)
            from public.delivery_events event
            join public.delivery_items item on item.delivery_event_id = event.id
            join public.round_stops stop on stop.id = event.round_stop_id
            join public.delivery_rounds round on round.id = stop.round_id
            where round.service_date = v_service_date
              and event.status = 'active'
              and event.source_stock_location_id is not null
              and item.ice_type_id = ice.id
          ), 0)::numeric(12,1) as sold_quantity,
          coalesce((
            select sum(item.quantity)
            from public.daily_stock_uses usage
            join public.daily_stock_use_items item on item.use_id = usage.id
            where usage.service_date = v_service_date
              and usage.status = 'active'
              and item.ice_type_id = ice.id
          ), 0)::numeric(12,1) as refill_quantity,
          coalesce((
            select sum(item.quantity)
            from public.stock_movements movement
            join public.stock_movement_items item on item.movement_id = movement.id
            where movement.service_date = v_service_date
              and movement.status = 'active'
              and movement.kind = 'damage'
              and item.ice_type_id = ice.id
          ), 0)::numeric(12,1) as damaged_quantity,
          coalesce((
            select sum(item.quantity)
            from public.stock_movements movement
            join public.stock_movement_items item on item.movement_id = movement.id
            where movement.service_date = v_service_date
              and movement.status = 'active'
              and movement.kind = 'return_to_factory'
              and item.ice_type_id = ice.id
          ), 0)::numeric(12,1) as returned_quantity
      ) totals
      left join public.daily_aggregate_stock_closure_items closure_item
        on closure_item.service_date = v_service_date
       and closure_item.ice_type_id = ice.id
      where ice.is_active
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.record_daily_stock_refill(
  p_service_date date,
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
  v_use_id uuid;
  v_existing_fingerprint text;
  v_request_fingerprint text;
  v_items jsonb;
  v_item record;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_service_date is null or p_idempotency_key is null then
    raise exception 'Service date and idempotency key are required';
  elsif jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'Refill items must be a non-empty JSON array';
  elsif p_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'A refill can only be recorded for the current service date';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'ice_type_id', item.ice_type_id,
    'quantity', item.quantity
  ) order by item.ice_type_id), '[]'::jsonb)
  into v_items
  from jsonb_to_recordset(p_items)
    as item(ice_type_id uuid, quantity numeric);

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    left join public.ice_types ice on ice.id = item.ice_type_id and ice.is_active
    where item.ice_type_id is null or item.quantity is null or item.quantity <= 0
      or mod(item.quantity, 0.5) <> 0 or ice.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    group by item.ice_type_id having count(*) > 1
  ) then
    raise exception 'Every refill item must use a distinct active ice type in half-bag increments';
  end if;

  v_request_fingerprint := md5(jsonb_build_object(
    'service_date', p_service_date,
    'items', v_items,
    'note', nullif(trim(coalesce(p_note, '')), '')
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select usage.id, usage.request_fingerprint
  into v_use_id, v_existing_fingerprint
  from public.daily_stock_uses usage
  where usage.idempotency_key = p_idempotency_key;

  if v_use_id is not null then
    if v_existing_fingerprint is distinct from v_request_fingerprint then
      raise exception 'This idempotency key was already used for another refill';
    end if;
    return public.get_daily_aggregate_stock_summary(p_service_date);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

  if exists (
    select 1 from public.daily_aggregate_stock_closures
    where service_date = p_service_date
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  for v_item in
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    order by item.ice_type_id
  loop
    if public.daily_aggregate_stock_balance_at(p_service_date, v_item.ice_type_id)
      < v_item.quantity then
      raise exception 'Daily aggregate stock is not sufficient for this refill';
    end if;
  end loop;

  insert into public.daily_stock_uses (
    service_date, kind, note, idempotency_key, request_fingerprint, recorded_by
  ) values (
    p_service_date, 'refill', nullif(trim(coalesce(p_note, '')), ''),
    p_idempotency_key, v_request_fingerprint, auth.uid()
  ) returning id into v_use_id;

  insert into public.daily_stock_use_items (use_id, ice_type_id, quantity)
  select v_use_id, item.ice_type_id, item.quantity
  from jsonb_to_recordset(v_items) as item(ice_type_id uuid, quantity numeric);

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, after_value
  ) values (
    auth.uid(), 'daily_stock_uses', v_use_id, 'created',
    jsonb_build_object('service_date', p_service_date, 'kind', 'refill', 'items', v_items)
  );

  return public.get_daily_aggregate_stock_summary(p_service_date);
end;
$$;

create or replace function public.cancel_daily_stock_refill(
  p_use_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_status text;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can cancel a refill';
  elsif nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A cancellation reason is required';
  end if;

  select usage.service_date, usage.status
  into v_service_date, v_status
  from public.daily_stock_uses usage
  where usage.id = p_use_id
  for update;

  if v_service_date is null then
    raise exception 'The selected refill does not exist';
  elsif v_status <> 'active' then
    raise exception 'The selected refill is already cancelled';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if exists (
    select 1 from public.daily_aggregate_stock_closures
    where service_date = v_service_date
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  update public.daily_stock_uses
  set status = 'cancelled',
      cancelled_by = auth.uid(),
      cancelled_at = now(),
      cancellation_reason = trim(p_reason)
  where id = p_use_id;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, reason
  ) values (
    auth.uid(), 'daily_stock_uses', p_use_id, 'cancelled', trim(p_reason)
  );

  return public.get_daily_aggregate_stock_summary(v_service_date);
end;
$$;

create or replace function public.close_daily_aggregate_stock(
  p_service_date date,
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
  v_existing_date date;
  v_item record;
  v_system_quantity numeric(12,1);
  v_has_variance boolean := false;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close daily aggregate stock';
  elsif p_service_date is null or p_idempotency_key is null then
    raise exception 'Service date and idempotency key are required';
  elsif jsonb_typeof(p_counts) is distinct from 'array'
    or jsonb_array_length(p_counts) = 0 then
    raise exception 'Aggregate counts must be a non-empty JSON array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select closure.service_date into v_existing_date
  from public.daily_aggregate_stock_closures closure
  where closure.idempotency_key = p_idempotency_key;
  if v_existing_date is not null then
    if v_existing_date <> p_service_date then
      raise exception 'This idempotency key belongs to another service date';
    end if;
    return public.get_daily_aggregate_stock_summary(p_service_date);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

  if exists (
    select 1 from public.daily_aggregate_stock_closures
    where service_date = p_service_date
  ) then
    raise exception 'Stock for this service date is already closed';
  elsif exists (
    select 1
    from jsonb_to_recordset(p_counts)
      as input(ice_type_id uuid, actual_quantity numeric, note text)
    left join public.ice_types ice on ice.id = input.ice_type_id and ice.is_active
    where input.ice_type_id is null or input.actual_quantity is null
      or input.actual_quantity < 0 or mod(input.actual_quantity, 0.5) <> 0
      or ice.id is null
  ) or exists (
    select 1
    from jsonb_to_recordset(p_counts)
      as input(ice_type_id uuid, actual_quantity numeric, note text)
    group by input.ice_type_id having count(*) > 1
  ) or (
    select count(*) from jsonb_to_recordset(p_counts)
      as input(ice_type_id uuid, actual_quantity numeric, note text)
  ) <> (
    select count(*) from public.ice_types where is_active
  ) then
    raise exception 'Provide one non-negative half-bag count for every active ice type';
  end if;

  for v_item in
    select input.ice_type_id, input.actual_quantity, input.note
    from jsonb_to_recordset(p_counts)
      as input(ice_type_id uuid, actual_quantity numeric, note text)
    order by input.ice_type_id
  loop
    v_system_quantity :=
      public.daily_aggregate_stock_balance_at(p_service_date, v_item.ice_type_id);
    if v_item.actual_quantity <> v_system_quantity then
      v_has_variance := true;
      if nullif(trim(coalesce(v_item.note, p_note, '')), '') is null then
        raise exception 'A note is required when an aggregate count has a variance';
      end if;
    end if;
  end loop;

  insert into public.daily_aggregate_stock_closures (
    service_date, status, note, idempotency_key, closed_by
  ) values (
    p_service_date,
    'closing',
    case when v_has_variance
      then coalesce(nullif(trim(coalesce(p_note, '')), ''), 'ส่วนต่างยังไม่ทราบสาเหตุ')
      else nullif(trim(coalesce(p_note, '')), '')
    end,
    p_idempotency_key,
    auth.uid()
  );

  insert into public.daily_aggregate_stock_closure_items (
    service_date, ice_type_id, system_quantity,
    actual_quantity, variance_quantity, note
  )
  select
    p_service_date,
    input.ice_type_id,
    public.daily_aggregate_stock_balance_at(p_service_date, input.ice_type_id),
    input.actual_quantity,
    input.actual_quantity
      - public.daily_aggregate_stock_balance_at(p_service_date, input.ice_type_id),
    nullif(trim(coalesce(input.note, '')), '')
  from jsonb_to_recordset(p_counts)
    as input(ice_type_id uuid, actual_quantity numeric, note text);

  update public.delivery_rounds
  set status = 'closed', closed_by = auth.uid(), closed_at = now()
  where service_date = p_service_date and status = 'open' and cancelled_at is null;

  update public.daily_aggregate_stock_closures
  set status = 'closed', closed_at = now()
  where service_date = p_service_date;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, after_value
  ) values (
    auth.uid(), 'daily_aggregate_stock_closures', p_idempotency_key, 'closed',
    jsonb_build_object('service_date', p_service_date, 'counts', p_counts)
  );

  return public.get_daily_aggregate_stock_summary(p_service_date);
end;
$$;

-- Keep pricing, charges, approvals, revisions, and audit in the canonical POS
-- RPCs. Only source resolution and stock checks change.
do $migration$
declare
  v_function regprocedure;
  v_definition text;
  v_old_source_branch constant text :=
    $fragment$  if public.current_app_role() = 'courier' then
    select count(*)::integer
    into v_active_holding_count
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;

    if v_active_holding_count = 0 then
      raise exception 'Employee delivery requires one active assigned holding location; none is configured';
    elsif v_active_holding_count > 1 then
      raise exception 'Employee delivery requires one active assigned holding location; multiple are configured';
    end if;

    select location.id into v_source_location_id
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;
  else
    v_source_location_id := v_shop_source_location_id;
  end if;$fragment$;
  v_new_source_branch constant text :=
    $fragment$  -- Retained only as an audit snapshot; aggregate stock is authoritative.
  v_source_location_id := v_shop_source_location_id;$fragment$;
  v_old_lock constant text :=
    $fragment$  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if p_stop_status = 'delivered' then$fragment$;
  v_new_lock constant text :=
    $fragment$  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  if v_service_date > (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'A delivery cannot be recorded for a future service date';
  elsif exists (
    select 1 from public.daily_aggregate_stock_closures
    where service_date = v_service_date
  ) then
    raise exception 'Stock for this service date is already closed';
  end if;

  if p_stop_status = 'delivered' then$fragment$;
begin
  v_function := 'public.delivery_request_fingerprint(uuid,jsonb,public.shop_round_status,text,public.payment_term)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  v_definition := replace(v_definition, 'quantity integer', 'quantity numeric');
  execute v_definition;

  v_function := 'public.get_delivery_pos_context(uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_old_source_branch) = 0 then
    raise exception 'get_delivery_pos_context does not contain the expected source branch';
  end if;
  v_definition := replace(v_definition, v_old_source_branch, v_new_source_branch);
  v_definition := replace(
    v_definition,
    'public.stock_balance_at(v_service_date, v_source_location_id, ice.id)',
    'public.daily_aggregate_stock_balance_at(v_service_date, ice.id)'
  );
  v_definition := replace(v_definition, $$'id', location.id$$, $$'id', null$$);
  v_definition := replace(v_definition, $$'code', location.code$$, $$'code', 'DAILY'$$);
  v_definition := replace(
    v_definition, $$'name', location.name$$, $$'name', 'สต๊อกรวมประจำวัน'$$
  );
  v_definition := replace(v_definition, $$'kind', location.kind$$, $$'kind', 'daily'$$);
  execute v_definition;

  v_function :=
    'public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_old_source_branch) = 0 or strpos(v_definition, v_old_lock) = 0 then
    raise exception 'record_delivery does not contain the expected aggregate patch points';
  end if;
  v_definition := replace(v_definition, v_old_source_branch, v_new_source_branch);
  v_definition := replace(v_definition, v_old_lock, v_new_lock);
  v_definition := replace(v_definition, 'quantity integer', 'quantity numeric');
  v_definition := replace(
    v_definition,
    'or item.quantity <= 0 or ice.id is null',
    'or item.quantity <= 0 or mod(item.quantity, 0.5) <> 0 or ice.id is null'
  );
  v_definition := replace(
    v_definition,
    'public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)',
    'public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)'
  );
  v_definition := replace(
    v_definition,
    'The source location does not have enough stock',
    'Daily aggregate stock is not sufficient'
  );
  execute v_definition;

  v_function :=
    'public.revise_delivery_event(uuid,text,jsonb,public.shop_round_status,text,text,uuid,uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  v_definition := replace(v_definition, 'quantity integer', 'quantity numeric');
  v_definition := replace(
    v_definition,
    'or item.quantity <= 0 or ice.id is null',
    'or item.quantity <= 0 or mod(item.quantity, 0.5) <> 0 or ice.id is null'
  );
  v_definition := replace(
    v_definition,
    'public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)',
    'public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)'
  );
  v_definition := replace(
    v_definition,
    'The source location does not have enough stock for the corrected delivery',
    'Daily aggregate stock is not sufficient for the corrected delivery'
  );
  execute v_definition;
end;
$migration$;

do $movement_patch$
declare
  v_function regprocedure := to_regprocedure(
    'public.record_stock_transfer_v2(date,text,uuid,uuid,jsonb,text,uuid)'
  );
  v_definition text;
  v_old_closed_check constant text :=
    $fragment$  if exists (
    select 1 from public.daily_stock_closures
    where service_date = p_service_date and status = 'closed'
  ) then$fragment$;
  v_new_closed_check constant text :=
    $fragment$  if exists (
    select 1 from public.daily_stock_closures
    where service_date = p_service_date and status = 'closed'
  ) or exists (
    select 1 from public.daily_aggregate_stock_closures
    where service_date = p_service_date
  ) then$fragment$;
  v_old_balance_check constant text :=
    $fragment$    if public.stock_balance_at(p_service_date, p_from_location_id, v_item.ice_type_id)
      < v_item.quantity then
      raise exception 'The source location does not have enough stock';
    end if;$fragment$;
  v_new_balance_check constant text :=
    $fragment$    if (
      v_purpose in ('damage', 'return_to_factory')
      and public.daily_aggregate_stock_balance_at(p_service_date, v_item.ice_type_id)
        < v_item.quantity
    ) or (
      v_purpose not in ('damage', 'return_to_factory')
      and public.stock_balance_at(p_service_date, p_from_location_id, v_item.ice_type_id)
        < v_item.quantity
    ) then
      raise exception 'The selected stock source does not have enough stock';
    end if;$fragment$;
begin
  if v_function is null then
    return;
  end if;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_old_closed_check) = 0
    or strpos(v_definition, v_old_balance_check) = 0 then
    raise exception 'record_stock_transfer_v2 does not contain the expected aggregate patch points';
  end if;
  v_definition := replace(v_definition, v_old_closed_check, v_new_closed_check);
  v_definition := replace(v_definition, v_old_balance_check, v_new_balance_check);
  execute v_definition;
end;
$movement_patch$;

revoke all on function public.daily_aggregate_stock_balance_at(date, uuid) from public;
revoke all on function public.enforce_open_daily_aggregate_stock_movement() from public;
revoke all on function public.get_daily_aggregate_stock_summary(date) from public;
grant execute on function public.get_daily_aggregate_stock_summary(date) to authenticated;
revoke all on function public.record_daily_stock_refill(date, jsonb, text, uuid) from public;
grant execute on function public.record_daily_stock_refill(date, jsonb, text, uuid) to authenticated;
revoke all on function public.cancel_daily_stock_refill(uuid, text) from public;
grant execute on function public.cancel_daily_stock_refill(uuid, text) to authenticated;
revoke all on function public.close_daily_aggregate_stock(date, jsonb, text, uuid) from public;
grant execute on function public.close_daily_aggregate_stock(date, jsonb, text, uuid) to authenticated;

notify pgrst, 'reload schema';
