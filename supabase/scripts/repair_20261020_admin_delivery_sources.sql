-- One-time repair for the inspected 2026-10-20 open day.
-- Run after 0241. Only source attribution changes; quantities and financial
-- records are untouched. Audit rows retain each complete before/after event.
begin;
set local lock_timeout = '5s';
set local request.jwt.claim.sub = '5047b139-345c-4173-b3dd-b5fe5a13bd2e';

do $repair$
declare
  v_date constant date := date '2026-10-20';
  v_truck uuid;
  v_round record;
  v_item record;
  v_event record;
  v_after jsonb;
  v_aggregate_before jsonb;
  v_aggregate_after jsonb;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'An active admin is required for this stock source repair';
  end if;
  for v_round in select id from public.delivery_rounds
    where service_date=v_date order by id for update
  loop
    null;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended(v_date::text,0));
  if exists(select 1 from public.delivery_rounds where service_date=v_date and status<>'open')
    or exists(select 1 from public.daily_stock_closures where service_date=v_date)
    or exists(select 1 from public.daily_aggregate_stock_closures where service_date=v_date) then
    raise exception 'The repair requires an open stock day';
  end if;
  select id into strict v_truck from public.stock_locations
    where kind='truck' and is_courier_source and is_active and holds_inventory;

  for v_item in
    select item.ice_type_id,sum(item.quantity) as quantity
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id=event.id
    join public.round_stops stop on stop.id=event.round_stop_id
    join public.delivery_rounds round on round.id=stop.round_id
    join public.users actor on actor.id=event.recorded_by
    join public.stock_locations source on source.id=event.source_stock_location_id
    where round.service_date=v_date and event.status='active'
      and actor.role='admin' and source.kind='work_site' and not source.holds_inventory
    group by item.ice_type_id
  loop
    if public.stock_balance_at(v_date,v_truck,v_item.ice_type_id)<v_item.quantity then
      raise exception 'Repair would overdraw truck stock for %',v_item.ice_type_id;
    end if;
  end loop;

  select jsonb_object_agg(id,public.daily_aggregate_stock_balance_at(v_date,id))
    into v_aggregate_before from public.ice_types;
  for v_event in
    select event.*
    from public.delivery_events event
    join public.round_stops stop on stop.id=event.round_stop_id
    join public.delivery_rounds round on round.id=stop.round_id
    join public.users actor on actor.id=event.recorded_by
    join public.stock_locations source on source.id=event.source_stock_location_id
    where round.service_date=v_date and event.status='active'
      and actor.role='admin' and source.kind='work_site' and not source.holds_inventory
    order by event.id for update of event
  loop
    update public.delivery_events set source_stock_location_id=v_truck
      where id=v_event.id returning to_jsonb(delivery_events.*) into v_after;
    insert into public.audit_logs(actor_id,entity_type,entity_id,action,before_value,after_value,reason)
    values(auth.uid(),'delivery_events',v_event.id,'admin_truck_source_repair_20261020',
      to_jsonb(v_event),v_after,
      'Correct admin deliveries attributed to report-only work sites to the source truck; quantities and financial records unchanged');
  end loop;
  select jsonb_object_agg(id,public.daily_aggregate_stock_balance_at(v_date,id))
    into v_aggregate_after from public.ice_types;
  if v_aggregate_before is distinct from v_aggregate_after then
    raise exception 'Source repair must preserve daily aggregate quantities';
  end if;
end;
$repair$;
commit;
