-- Manager-first round control: reconciliation snapshot and atomic close.

create or replace function public.get_round_control_summary(p_round_id uuid)
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
    raise exception 'Only a round lead or admin can view round control';
  end if;

  if not exists (select 1 from public.delivery_rounds where id = p_round_id) then
    raise exception 'The selected delivery round does not exist';
  end if;

  select jsonb_build_object(
    'stop_counts', jsonb_build_object(
      'total', count(*),
      'delivered', count(*) filter (where s.status = 'delivered'),
      'pending', count(*) filter (where s.status = 'pending'),
      'problem', count(*) filter (where s.status not in ('pending', 'delivered'))
    ),
    'ice_counts', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'ice_type_id', i.id,
          'ice_type_name', i.name,
          'unit', i.unit,
          'loaded_quantity', c.loaded_quantity,
          'replenished_quantity', c.replenished_quantity,
          'remaining_quantity', c.remaining_quantity,
          'damaged_quantity', c.damaged_quantity,
          'expected_quantity', c.loaded_quantity + c.replenished_quantity
            - c.remaining_quantity - c.damaged_quantity,
          'delivered_quantity', coalesce(delivered.quantity, 0),
          'variance_quantity', c.loaded_quantity + c.replenished_quantity
            - c.remaining_quantity - c.damaged_quantity - coalesce(delivered.quantity, 0)
        )
        order by i.code
      )
      from public.round_ice_counts c
      join public.ice_types i on i.id = c.ice_type_id
      left join lateral (
        select sum(di.quantity)::integer as quantity
        from public.round_stops rs
        join public.delivery_events de on de.round_stop_id = rs.id and de.status = 'active'
        join public.delivery_items di on di.delivery_event_id = de.id and di.ice_type_id = c.ice_type_id
        where rs.round_id = c.round_id
      ) delivered on true
      where c.round_id = p_round_id
    ), '[]'::jsonb)
  )
  into v_result
  from public.round_stops s
  where s.round_id = p_round_id;

  return v_result;
end;
$$;

create or replace function public.close_delivery_round(
  p_round_id uuid,
  p_ice_counts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.delivery_round_status;
  v_total integer;
  v_delivered integer;
  v_pending integer;
  v_problem integer;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close a delivery round';
  end if;

  if jsonb_typeof(p_ice_counts) is distinct from 'array' then
    raise exception 'Ice counts must be a JSON array';
  end if;

  select status into v_status
  from public.delivery_rounds
  where id = p_round_id
  for update;

  if v_status is null then
    raise exception 'The selected delivery round does not exist';
  elsif v_status = 'closed' then
    return public.get_round_control_summary(p_round_id);
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_ice_counts)
      as input(ice_type_id uuid, replenished_quantity integer, remaining_quantity integer, damaged_quantity integer)
    left join public.round_ice_counts c
      on c.round_id = p_round_id and c.ice_type_id = input.ice_type_id
    where c.ice_type_id is null
      or input.replenished_quantity is null or input.replenished_quantity < 0
      or input.remaining_quantity is null or input.remaining_quantity < 0
      or input.damaged_quantity is null or input.damaged_quantity < 0
  ) or (
    select count(*) from jsonb_to_recordset(p_ice_counts) as input(ice_type_id uuid)
  ) <> (
    select count(*) from public.round_ice_counts where round_id = p_round_id
  ) or exists (
    select 1
    from jsonb_to_recordset(p_ice_counts) as input(ice_type_id uuid)
    group by input.ice_type_id
    having count(*) > 1
  ) then
    raise exception 'Provide one non-negative count for every ice type in the round';
  end if;

  update public.round_ice_counts c
  set replenished_quantity = input.replenished_quantity,
      remaining_quantity = input.remaining_quantity,
      damaged_quantity = input.damaged_quantity,
      updated_by = auth.uid(),
      updated_at = now()
  from jsonb_to_recordset(p_ice_counts)
    as input(ice_type_id uuid, replenished_quantity integer, remaining_quantity integer, damaged_quantity integer)
  where c.round_id = p_round_id and c.ice_type_id = input.ice_type_id;

  select
    count(*),
    count(*) filter (where status = 'delivered'),
    count(*) filter (where status = 'pending'),
    count(*) filter (where status not in ('pending', 'delivered'))
  into v_total, v_delivered, v_pending, v_problem
  from public.round_stops
  where round_id = p_round_id;

  insert into public.round_close_summaries (
    round_id, total_shop_count, delivered_shop_count, pending_shop_count,
    problem_shop_count, captured_by, captured_at
  ) values (
    p_round_id, v_total, v_delivered, v_pending, v_problem, auth.uid(), now()
  );

  insert into public.round_close_ice_summaries (
    round_id, ice_type_id, loaded_quantity, replenished_quantity,
    remaining_quantity, damaged_quantity, expected_quantity,
    delivered_quantity, variance_quantity
  )
  select
    p_round_id,
    c.ice_type_id,
    c.loaded_quantity,
    c.replenished_quantity,
    c.remaining_quantity,
    c.damaged_quantity,
    c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity,
    coalesce(delivered.quantity, 0),
    c.loaded_quantity + c.replenished_quantity - c.remaining_quantity
      - c.damaged_quantity - coalesce(delivered.quantity, 0)
  from public.round_ice_counts c
  left join lateral (
    select sum(di.quantity)::integer as quantity
    from public.round_stops rs
    join public.delivery_events de on de.round_stop_id = rs.id and de.status = 'active'
    join public.delivery_items di on di.delivery_event_id = de.id and di.ice_type_id = c.ice_type_id
    where rs.round_id = c.round_id
  ) delivered on true
  where c.round_id = p_round_id;

  update public.delivery_rounds
  set status = 'closed', closed_by = auth.uid(), closed_at = now()
  where id = p_round_id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'delivery_rounds', p_round_id, 'closed',
    jsonb_build_object(
      'total_shop_count', v_total,
      'delivered_shop_count', v_delivered,
      'pending_shop_count', v_pending,
      'problem_shop_count', v_problem
    )
  );

  return public.get_round_control_summary(p_round_id);
end;
$$;

revoke all on function public.get_round_control_summary(uuid) from public;
revoke all on function public.close_delivery_round(uuid, jsonb) from public;
grant execute on function public.get_round_control_summary(uuid) to authenticated;
grant execute on function public.close_delivery_round(uuid, jsonb) to authenticated;
