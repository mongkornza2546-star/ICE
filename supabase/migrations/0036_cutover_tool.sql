-- One-time, audited cutover from work-site inventory to explicit stock holders.
create table public.stock_cutover_runs (
  service_date date primary key,
  consolidated_to_location_id uuid not null references public.stock_locations(id) on delete restrict,
  moved_item_count integer not null check (moved_item_count >= 0),
  moved_quantity numeric(12, 1) not null check (moved_quantity >= 0),
  executed_by uuid not null references public.users(id) on delete restrict,
  executed_at timestamptz not null default now()
);

alter table public.stock_cutover_runs enable row level security;

create policy "admins read stock cutover runs"
  on public.stock_cutover_runs for select
  using (public.is_active_user() and public.current_app_role() = 'admin');

create or replace function public.execute_stock_cutover(
  p_service_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.stock_cutover_runs%rowtype;
  v_truck_id uuid;
  v_loc record;
  v_item record;
  v_balance numeric(12, 1);
  v_movement_id uuid;
  v_moved_item_count integer := 0;
  v_moved_quantity numeric(12, 1) := 0;
begin
  if not public.is_active_user()
    or public.current_app_role() <> 'admin' then
    raise exception 'Only an administrator can execute stock cutover';
  end if;

  if p_service_date is null then
    raise exception 'A stock service date is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('stock-holder-cutover', 0));
  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

  select * into v_existing
  from public.stock_cutover_runs
  where service_date = p_service_date;

  if found then
    return jsonb_build_object(
      'status', 'already_executed',
      'service_date', v_existing.service_date,
      'consolidated_to_location_id', v_existing.consolidated_to_location_id,
      'moved_item_count', v_existing.moved_item_count,
      'moved_quantity', v_existing.moved_quantity,
      'executed_at', v_existing.executed_at
    );
  end if;

  if exists (
    select 1
    from public.daily_stock_closures
    where service_date = p_service_date and status = 'closed'
  ) then
    raise exception 'Cannot execute stock cutover for a closed service date';
  end if;

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
    raise exception 'An active inventory-holding truck is required for cutover consolidation';
  end if;

  -- Include inactive work sites and ice types: both can still carry historical
  -- balance on the selected open service date.
  for v_loc in
    select id, code
    from public.stock_locations
    where kind = 'work_site'
    order by code
  loop
    for v_item in
      select id, code
      from public.ice_types
      order by code
    loop
      v_balance := public.stock_balance_at(p_service_date, v_loc.id, v_item.id);

      if v_balance < 0 then
        raise exception 'Cannot cut over negative balance at work site % for ice type %',
          v_loc.code, v_item.code;
      elsif v_balance > 0 then
        insert into public.stock_movements (
          service_date, kind, from_location_id, to_location_id,
          note, idempotency_key, recorded_by
        ) values (
          p_service_date, 'transfer', v_loc.id, v_truck_id,
          'Stock-holder cutover consolidation', gen_random_uuid(), auth.uid()
        ) returning id into v_movement_id;

        insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
        values (v_movement_id, v_item.id, v_balance);

        v_moved_item_count := v_moved_item_count + 1;
        v_moved_quantity := v_moved_quantity + v_balance;
      end if;
    end loop;
  end loop;

  if exists (
    select 1
    from public.stock_locations location
    cross join public.ice_types ice
    where location.kind = 'work_site'
      and public.stock_balance_at(p_service_date, location.id, ice.id) <> 0
  ) then
    raise exception 'Cutover did not clear every work-site balance';
  end if;

  update public.stock_locations
  set holds_inventory = false,
      requires_daily_count = false
  where kind = 'work_site';

  update public.stock_locations
  set holds_inventory = true,
      requires_daily_count = kind in ('truck', 'team', 'small_vehicle')
  where kind in ('truck', 'team', 'small_vehicle', 'reserve_bin', 'front_vehicle');

  alter table public.stock_locations
    validate constraint stock_locations_work_site_report_only_check;

  insert into public.stock_cutover_runs (
    service_date, consolidated_to_location_id, moved_item_count,
    moved_quantity, executed_by
  ) values (
    p_service_date, v_truck_id, v_moved_item_count,
    v_moved_quantity, auth.uid()
  );

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'system',
    '00000000-0000-0000-0000-000000000000'::uuid,
    'stock_holder_cutover_executed',
    jsonb_build_object(
      'service_date', p_service_date,
      'consolidated_to_location_id', v_truck_id,
      'moved_item_count', v_moved_item_count,
      'moved_quantity', v_moved_quantity
    )
  );

  return jsonb_build_object(
    'status', 'executed',
    'service_date', p_service_date,
    'consolidated_to_location_id', v_truck_id,
    'moved_item_count', v_moved_item_count,
    'moved_quantity', v_moved_quantity
  );
end;
$$;

revoke all on function public.execute_stock_cutover(date) from public;
grant execute on function public.execute_stock_cutover(date) to authenticated;
