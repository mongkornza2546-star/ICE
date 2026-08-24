-- Event delivery Slice A / compatibility fence.
--
-- This migration deliberately creates no event stops. It prepares round_stops
-- for a second destination kind while keeping the legacy employee and manager
-- delivery workflows constrained to regular destinations. Event jobs,
-- participations, and their event-specific RPCs are added only after this fence
-- is deployed.

do $$
begin
  create type public.round_destination_kind as enum ('regular', 'event');
exception when duplicate_object then null;
end $$;

alter table public.round_stops
  add column if not exists destination_kind public.round_destination_kind not null default 'regular',
  add column if not exists event_participation_id uuid,
  add column if not exists is_operational boolean not null default true,
  add column if not exists event_job_name_snapshot text,
  add column if not exists event_location_snapshot text,
  add column if not exists event_booth_snapshot text,
  add column if not exists event_zone_snapshot text,
  add column if not exists event_landmark_snapshot text,
  add column if not exists event_contact_name_snapshot text,
  add column if not exists event_contact_phone_snapshot text;

do $$
declare
  v_constraint_name text;
begin
  select constraint_name into v_constraint_name
  from information_schema.table_constraints
  where table_schema = 'public'
    and table_name = 'round_stops'
    and constraint_type = 'UNIQUE'
    and constraint_name = 'round_stops_round_id_shop_id_key';

  if v_constraint_name is not null then
    execute format('alter table public.round_stops drop constraint %I', v_constraint_name);
  end if;
end;
$$;

create unique index if not exists round_stops_regular_destination_unique_idx
  on public.round_stops (round_id, shop_id)
  where destination_kind = 'regular';

create unique index if not exists round_stops_event_destination_unique_idx
  on public.round_stops (round_id, event_participation_id)
  where destination_kind = 'event';

alter table public.round_stops
  drop constraint if exists round_stops_destination_context_check,
  add constraint round_stops_destination_context_check check (
    (destination_kind = 'regular' and event_participation_id is null)
    or (destination_kind = 'event' and event_participation_id is not null)
  );

create index if not exists round_stops_event_participation_idx
  on public.round_stops (event_participation_id)
  where destination_kind = 'event';

-- The legacy sync remains regular-only. The partial-index predicate is part of
-- ON CONFLICT, otherwise PostgreSQL cannot infer the replacement index.
create or replace function public.sync_daily_round_active_shops(
  p_round_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_added_count integer;
  v_lock_service_date date;
  v_max_sequence integer;
  v_round public.delivery_rounds%rowtype;
begin
  select round.service_date into v_lock_service_date
  from public.delivery_rounds round
  where round.id = p_round_id;

  if not found then
    raise exception 'The selected delivery round does not exist';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_lock_service_date::text, 0));

  select round.* into v_round
  from public.delivery_rounds round
  where round.id = p_round_id
  for update;

  if not found then
    raise exception 'The selected delivery round does not exist';
  elsif v_round.service_date is distinct from v_lock_service_date then
    raise exception 'The delivery round changed service date; retry the request';
  end if;

  if not public.is_active_user()
    or (public.current_app_role() not in ('admin', 'round_lead')
      and not public.is_round_member(p_round_id)) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  if v_round.round_type <> 'daily'
    or v_round.status <> 'open'
    or v_round.cancelled_at is not null then
    return 0;
  end if;

  select coalesce(max(stop.sequence_no), 0)
  into v_max_sequence
  from public.round_stops stop
  where stop.round_id = p_round_id;

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
    p_round_id,
    shop.id,
    shop.code,
    shop.name,
    shop.building_id,
    building.name,
    shop.floor_or_zone,
    (v_max_sequence + row_number() over (
      order by building.sort_order, zone.sort_order,
        shop.delivery_sequence nulls last, shop.code, shop.id
    ))::integer,
    auth.uid()
  from public.shops shop
  join public.buildings building
    on building.id = shop.building_id and building.is_active
  join public.building_zones zone on zone.id = shop.zone_id
  where shop.status = 'active'
    and not exists (
      select 1
      from public.round_stops existing
      where existing.round_id = p_round_id
        and existing.shop_id = shop.id
        and existing.destination_kind = 'regular'
    )
  on conflict (round_id, shop_id) where destination_kind = 'regular' do nothing;

  get diagnostics v_added_count = row_count;
  return v_added_count;
end;
$$;

-- All stock-affecting round writers use the global service-date -> round-row
-- order. Preserve the deployed function bodies and signatures while moving the
-- two legacy locks into that order. Daily aggregate close already takes its
-- idempotency lock and service-date lock before updating delivery_rounds.
do $lock_order$
declare
  v_function regprocedure;
  v_definition text;
  v_old_round_lock text;
  v_new_round_lock text;
  v_old_service_lock constant text :=
    E'  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));\n';
begin
  v_function := 'public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, E'  v_service_date date;\n') = 0 then
    raise exception 'record_delivery does not contain the expected service-date declaration';
  end if;
  v_definition := replace(
    v_definition,
    E'  v_service_date date;\n',
    E'  v_service_date date;\n  v_lock_service_date date;\n'
  );
  v_old_round_lock := $fragment$  select stop.round_id, round.status, round.service_date, stop.shop_id, shop.stock_location_id
  into v_round_id, v_round_status, v_service_date, v_shop_id, v_shop_source_location_id
  from public.round_stops stop
  join public.delivery_rounds round on round.id = stop.round_id
  join public.shops shop on shop.id = stop.shop_id
  where stop.id = p_round_stop_id
  for update of round;$fragment$;
  v_new_round_lock := $fragment$  select round.service_date
  into v_lock_service_date
  from public.round_stops stop
  join public.delivery_rounds round on round.id = stop.round_id
  where stop.id = p_round_stop_id;

  if v_lock_service_date is null then
    raise exception 'The selected shop is not in a delivery round';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_lock_service_date::text, 0));

  select stop.round_id, round.status, round.service_date, stop.shop_id, shop.stock_location_id
  into v_round_id, v_round_status, v_service_date, v_shop_id, v_shop_source_location_id
  from public.round_stops stop
  join public.delivery_rounds round on round.id = stop.round_id
  join public.shops shop on shop.id = stop.shop_id
  where stop.id = p_round_stop_id
  for update of round;

  if v_service_date is distinct from v_lock_service_date then
    raise exception 'The delivery round changed service date; retry the request';
  end if;$fragment$;
  if strpos(v_definition, v_old_round_lock) = 0 then
    raise exception 'record_delivery does not contain the expected pre-lock round lookup';
  elsif strpos(v_definition, v_old_service_lock) = 0 then
    raise exception 'record_delivery does not contain the expected service-date lock';
  end if;
  v_definition := replace(v_definition, v_old_round_lock, v_new_round_lock);
  v_definition := replace(v_definition, v_old_service_lock, '');
  execute v_definition;

  v_function := 'public.close_delivery_round(uuid,jsonb)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, E'  v_service_date date;\n') = 0 then
    raise exception 'close_delivery_round does not contain the expected service-date declaration';
  end if;
  v_definition := replace(
    v_definition,
    E'  v_service_date date;\n',
    E'  v_service_date date;\n  v_lock_service_date date;\n'
  );
  v_old_round_lock := $fragment$  select status, service_date into v_status, v_service_date
  from public.delivery_rounds
  where id = p_round_id
  for update;$fragment$;
  v_new_round_lock := $fragment$  select service_date into v_lock_service_date
  from public.delivery_rounds
  where id = p_round_id;

  if v_lock_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_lock_service_date::text, 0));

  select status, service_date into v_status, v_service_date
  from public.delivery_rounds
  where id = p_round_id
  for update;

  if v_service_date is distinct from v_lock_service_date then
    raise exception 'The delivery round changed service date; retry the request';
  end if;$fragment$;
  if strpos(v_definition, v_old_round_lock) = 0 then
    raise exception 'close_delivery_round does not contain the expected pre-lock round lookup';
  elsif strpos(v_definition, v_old_service_lock) = 0 then
    raise exception 'close_delivery_round does not contain the expected service-date lock';
  end if;
  v_definition := replace(v_definition, v_old_round_lock, v_new_round_lock);
  v_definition := replace(v_definition, v_old_service_lock, '');
  execute v_definition;
end;
$lock_order$;

create or replace function public.require_regular_round_stop(p_round_stop_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.round_stops stop
    where stop.id = p_round_stop_id
      and stop.destination_kind <> 'regular'
  ) then
    raise exception 'Event destinations require the event delivery workflow';
  end if;
end;
$$;

create or replace function public.require_regular_delivery_event(p_event_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.delivery_events event
    join public.round_stops stop on stop.id = event.round_stop_id
    where event.id = p_event_id
      and stop.destination_kind <> 'regular'
  ) then
    raise exception 'Event deliveries require the event delivery workflow';
  end if;
end;
$$;

-- Inject a guard at the first executable BEGIN of the deployed legacy RPC.
-- Keeping its signature and body intact avoids changing offline v1 contracts.
do $fence$
declare
  v_function regprocedure;
  v_definition text;
  v_begin_at integer;
  v_guard text;
begin
  foreach v_function in array array[
    'public.get_delivery_pos_context(uuid)'::regprocedure,
    'public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)'::regprocedure,
    'public.record_immediate_sale(uuid,jsonb,text,timestamptz,public.payment_method,numeric,text,text,numeric,uuid)'::regprocedure
  ] loop
    select pg_get_functiondef(v_function) into v_definition;
    v_begin_at := position(E'begin\n' in lower(v_definition));
    if v_begin_at = 0 then
      raise exception 'Could not install round-stop compatibility fence on %', v_function;
    end if;
    v_guard := E'begin\n  perform public.require_regular_round_stop(p_round_stop_id);\n';
    execute overlay(v_definition placing v_guard from v_begin_at for length(E'begin\n'));
  end loop;

  foreach v_function in array array[
    'public.get_delivery_correction_context(uuid)'::regprocedure,
    'public.preview_delivery_correction(uuid,text,jsonb,public.shop_round_status)'::regprocedure,
    'public.apply_open_delivery_correction(uuid,text,jsonb,public.shop_round_status,text,text,uuid,uuid)'::regprocedure,
    'public.create_closed_delivery_adjustment(uuid,jsonb,text,uuid)'::regprocedure,
    'public.revise_delivery_event(uuid,text,jsonb,public.shop_round_status,text,text,uuid,uuid)'::regprocedure
  ] loop
    select pg_get_functiondef(v_function) into v_definition;
    v_begin_at := position(E'begin\n' in lower(v_definition));
    if v_begin_at = 0 then
      raise exception 'Could not install delivery-event compatibility fence on %', v_function;
    end if;
    v_guard := E'begin\n  perform public.require_regular_delivery_event(p_event_id);\n';
    execute overlay(v_definition placing v_guard from v_begin_at for length(E'begin\n'));
  end loop;
end;
$fence$;

-- The legacy manager correction screen has its own event list. Keep that old
-- client on regular deliveries just like the employee card read model.
do $fence$
declare
  v_function regprocedure := 'public.get_manager_delivery_events(uuid)'::regprocedure;
  v_definition text;
  v_previous_definition text;
begin
  select pg_get_functiondef(v_function) into v_definition;
  v_previous_definition := v_definition;
  v_definition := regexp_replace(
    v_definition,
    '(?i)(where\s+stop\.round_id\s*=\s*p_round_id\s+)(and\s+event\.status\s*=\s*''active'')',
    E'\\1and stop.destination_kind = ''regular''\n          \\2',
    'g'
  );
  if v_definition = v_previous_definition then
    raise exception 'get_manager_delivery_events does not contain the expected regular-event marker';
  elsif (
    length(lower(v_definition))
      - length(replace(lower(v_definition), 'and stop.destination_kind = ''regular''', ''))
  ) / length('and stop.destination_kind = ''regular''') <> 1 then
    raise exception 'get_manager_delivery_events did not fence regular events exactly once';
  end if;
  execute v_definition;
end;
$fence$;

-- get_round_shop_cards is the legacy read-model. Exclude event stops both from
-- the visible cards and from same-day history/totals of a regular shop.
do $fence$
declare
  v_function regprocedure := 'public.get_round_shop_cards(uuid,uuid)'::regprocedure;
  v_definition text;
  v_previous_definition text;
begin
  select pg_get_functiondef(v_function) into v_definition;
  v_previous_definition := v_definition;
  v_definition := regexp_replace(
    v_definition,
    '(?i)(where\s+day_round\.service_date\s*=\s*v_service_date)',
    E'\\1\n      and day_stop.destination_kind = ''regular''',
    'g'
  );
  if v_definition = v_previous_definition then
    raise exception 'get_round_shop_cards does not contain the expected regular-history marker';
  end if;
  v_previous_definition := v_definition;
  v_definition := regexp_replace(
    v_definition,
    '(?i)(where\s+stop\.round_id\s*=\s*p_round_id\s+)(and\s+\(p_building_id\s+is\s+null\s+or\s+stop\.building_id_snapshot\s*=\s*p_building_id\))',
    E'\\1and stop.destination_kind = ''regular''\n    \\2',
    'g'
  );
  if v_definition = v_previous_definition then
    raise exception 'get_round_shop_cards does not contain the expected regular-card marker';
  elsif (
    length(lower(v_definition))
      - length(replace(lower(v_definition), 'and day_stop.destination_kind = ''regular''', ''))
  ) / length('and day_stop.destination_kind = ''regular''') <> 2 then
    raise exception 'get_round_shop_cards did not fence both history and totals';
  elsif (
    length(lower(v_definition))
      - length(replace(lower(v_definition), 'and stop.destination_kind = ''regular''', ''))
  ) / length('and stop.destination_kind = ''regular''') <> 1 then
    raise exception 'get_round_shop_cards did not fence the visible cards exactly once';
  end if;
  execute v_definition;
end;
$fence$;

revoke all on function public.require_regular_round_stop(uuid) from public, anon, authenticated;
revoke all on function public.require_regular_delivery_event(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
