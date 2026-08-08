-- Keep the day's gross employee withdrawals separate from the holding's
-- current balance. Sales reduce only the latter, so the withdrawal screen can
-- show how much was received and how much should remain as distinct figures.

create or replace function public.get_employee_stock_state(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_truck_location_id uuid;
  v_holding_location_id uuid;
  v_active_holding_count integer;
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() <> 'courier' then
    raise exception 'Only an active courier can view employee stock';
  end if;

  select round.service_date into v_service_date
  from public.delivery_rounds round where round.id = p_round_id;
  if v_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;
  if not public.is_round_member(p_round_id) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  select location.id into v_truck_location_id
  from public.stock_locations location
  where location.kind = 'truck' and location.is_courier_source and location.is_active;
  if v_truck_location_id is null then
    raise exception 'Employee stock requires a configured courier source truck';
  end if;

  select count(*)::integer into v_active_holding_count
  from public.stock_locations location
  where location.assigned_user_id = auth.uid()
    and location.kind in ('team', 'small_vehicle') and location.is_active;
  if v_active_holding_count = 0 then
    raise exception 'Employee stock requires one active assigned holding location; none is configured';
  elsif v_active_holding_count > 1 then
    raise exception 'Employee stock requires one active assigned holding location; multiple are configured';
  end if;

  select location.id into v_holding_location_id
  from public.stock_locations location
  where location.assigned_user_id = auth.uid()
    and location.kind in ('team', 'small_vehicle') and location.is_active;

  select jsonb_build_object(
    'round_id', p_round_id,
    'service_date', v_service_date,
    'withdrawn_balances', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'ice_type_id', ice.id,
        'ice_type_name', ice.name,
        'unit', ice.unit,
        'quantity', (
          select coalesce(sum(item.quantity), 0)
          from public.stock_movements movement
          join public.stock_movement_items item on item.movement_id = movement.id
          join public.stock_locations source on source.id = movement.from_location_id
          where movement.service_date = v_service_date
            and movement.kind = 'transfer'
            and movement.status = 'active'
            and source.kind = 'truck'
            and movement.to_location_id = v_holding_location_id
            and item.ice_type_id = ice.id
        )
      ) order by ice.code), '[]'::jsonb)
      from public.ice_types ice where ice.is_active
    ),
    'truck_location', jsonb_build_object(
      'id', truck.id, 'code', truck.code, 'name', truck.name,
      'balances', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'ice_type_id', ice.id, 'ice_type_name', ice.name, 'unit', ice.unit,
          'quantity', public.stock_balance_at(v_service_date, truck.id, ice.id)
        ) order by ice.code), '[]'::jsonb)
        from public.ice_types ice where ice.is_active
      )
    ),
    'holding_location', jsonb_build_object(
      'id', holding.id, 'code', holding.code, 'name', holding.name,
      'balances', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'ice_type_id', ice.id, 'ice_type_name', ice.name, 'unit', ice.unit,
          'quantity', public.stock_balance_at(v_service_date, holding.id, ice.id)
        ) order by ice.code), '[]'::jsonb)
        from public.ice_types ice where ice.is_active
      )
    )
  ) into v_result
  from public.stock_locations truck
  cross join public.stock_locations holding
  where truck.id = v_truck_location_id and holding.id = v_holding_location_id;

  return v_result;
end;
$$;
