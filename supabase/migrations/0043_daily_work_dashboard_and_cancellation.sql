-- Migration 0043: Daily Work Session Dashboard & Admin Session Cancellation

-- 1. Helper function for daily work session cancellation blockers
create or replace function public.daily_work_session_cancellation_blockers(
  p_round_id uuid,
  p_service_date date
)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select array_remove(array[
    case when exists (
      select 1
      from public.delivery_charges charge
      join public.delivery_events event on event.id = charge.delivery_event_id
      join public.round_stops stop on stop.id = event.round_stop_id
      where (stop.round_id = p_round_id or charge.service_date = p_service_date)
        and charge.status = 'active'
    ) then 'delivery_charges' end,
    case when exists (
      select 1
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      where stop.round_id = p_round_id
    ) then 'delivery_events' end,
    case when exists (
      select 1
      from public.round_stops stop
      where stop.round_id = p_round_id and stop.status <> 'pending'
    ) then 'non_pending_stops' end,
    case when exists (
      select 1
      from public.stock_movements movement
      where (movement.round_id = p_round_id or movement.service_date = p_service_date)
        and movement.kind = 'factory_order'
        and movement.status = 'active'
    ) then 'factory_orders' end,
    case when exists (
      select 1
      from public.stock_movements movement
      where (movement.round_id = p_round_id or movement.service_date = p_service_date)
        and movement.kind <> 'factory_order'
    ) then 'stock_movements' end,
    case when exists (
      select 1
      from public.stock_count_snapshots snapshot
      where snapshot.service_date = p_service_date
    ) then 'stock_counts' end
  ]::text[], null);
$$;

-- 2. Admin RPC to cancel a daily work session
create or replace function public.cancel_daily_work_session(
  p_service_date date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.delivery_rounds%rowtype;
  v_captured_at timestamptz;
  v_blockers text[];
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'เฉพาะแอดมินเท่านั้นที่ยกเลิกงานวันนี้ได้';
  end if;

  if p_service_date is null then
    raise exception 'ระบุวันที่ต้องการยกเลิกงาน';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'ระบุเหตุผลในการยกเลิกงาน';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

  select * into v_round
  from public.delivery_rounds
  where service_date = p_service_date
    and round_type = 'daily'
    and status = 'open'
    and cancelled_at is null
  for update;

  if v_round.id is null then
    raise exception 'ไม่พบงานประจำวันที่กำลังทำงานอยู่';
  end if;

  v_blockers := public.daily_work_session_cancellation_blockers(v_round.id, p_service_date);
  if cardinality(v_blockers) > 0 then
    raise exception 'ยกเลิกไม่ได้ เนื่องจากเริ่มทำรายการแล้ว';
  end if;

  v_captured_at := clock_timestamp();

  insert into public.round_stock_snapshots (
    round_id, service_date, captured_by, captured_at
  ) values (
    v_round.id, p_service_date, auth.uid(), v_captured_at
  ) on conflict (round_id) do nothing;

  insert into public.round_stock_snapshot_items (
    round_id, location_id, location_code_snapshot, location_name_snapshot,
    location_kind_snapshot, ice_type_id, ice_type_name_snapshot, unit_snapshot, quantity
  )
  select
    v_round.id, location.id, location.code, location.name, location.kind,
    ice.id, ice.name, ice.unit, public.stock_balance_at(p_service_date, location.id, ice.id)
  from public.stock_locations location
  cross join public.ice_types ice
  where location.is_active and location.holds_inventory and ice.is_active
  on conflict (round_id, location_id, ice_type_id) do nothing;

  update public.delivery_rounds
  set status = 'closed',
      closed_by = auth.uid(),
      closed_at = v_captured_at,
      cancelled_by = auth.uid(),
      cancelled_at = v_captured_at,
      cancellation_reason = trim(p_reason)
  where id = v_round.id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'delivery_rounds',
    v_round.id,
    'cancelled',
    jsonb_build_object(
      'service_date', p_service_date,
      'status', 'cancelled',
      'cancellation_reason', trim(p_reason),
      'cancelled_by', auth.uid(),
      'cancelled_at', v_captured_at
    )
  );

  return jsonb_build_object(
    'status', 'cancelled',
    'round_id', v_round.id,
    'service_date', p_service_date,
    'reason', trim(p_reason)
  );
end;
$$;

-- 3. RPC get_daily_work_dashboard
create or replace function public.get_daily_work_dashboard(
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
  v_round public.delivery_rounds%rowtype;
  v_status text;
  v_opened_by_name text;
  v_closed_by_name text;
  v_cancelled_by_name text;
  v_members jsonb;
  v_delivery_summary jsonb;
  v_net_sales_value numeric;
  v_ice_type_sales jsonb;
  v_sales_summary jsonb;
  v_recent_deliveries jsonb;
  v_problems jsonb;
  v_readiness jsonb;
  v_cancellation_state jsonb;
  v_blockers text[];
  v_can_cancel boolean;
  v_blocker_reason text;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view the daily work dashboard';
  end if;

  v_service_date := coalesce(
    p_service_date,
    (clock_timestamp() at time zone 'Asia/Bangkok')::date
  );

  select * into v_round
  from public.delivery_rounds
  where service_date = v_service_date
    and round_type = 'daily'
  order by (case when cancelled_at is null then 1 else 0 end) desc, created_at desc
  limit 1;

  if v_round.id is null then
    v_status := 'not_started';
  elsif v_round.cancelled_at is not null then
    v_status := 'cancelled';
  elsif v_round.status = 'closed' then
    v_status := 'completed';
  else
    v_status := 'in_progress';
  end if;

  if v_round.id is not null then
    if v_round.opened_by is not null then
      select display_name into v_opened_by_name from public.users where id = v_round.opened_by;
    end if;
    if v_round.closed_by is not null then
      select display_name into v_closed_by_name from public.users where id = v_round.closed_by;
    end if;
    if v_round.cancelled_by is not null then
      select display_name into v_cancelled_by_name from public.users where id = v_round.cancelled_by;
    end if;
  end if;

  -- Build members array with last activity
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', u.id,
      'display_name', u.display_name,
      'role', u.role,
      'role_label', case u.role
        when 'round_lead' then 'หัวหน้างาน'
        when 'courier' then 'พนักงานส่งน้ำแข็ง'
        when 'admin' then 'แอดมิน'
        else u.role
      end,
      'last_activity', (
        select jsonb_build_object(
          'type', act.activity_type,
          'timestamp', act.activity_time,
          'description', act.description
        )
        from (
          select 'delivery' as activity_type, charge.created_at as activity_time, 'บันทึกส่งน้ำแข็ง' as description
          from public.delivery_charges charge
          join public.delivery_events event on event.id = charge.delivery_event_id
          where event.recorded_by = u.id
            and charge.service_date = v_service_date
            and charge.status = 'active'
          union all
          select 'stock_movement' as activity_type, recorded_at as activity_time,
                 case kind when 'factory_order' then 'คำสั่งโรงงาน' when 'transfer' then 'โอนสต๊อก' else 'เคลื่อนย้ายสต๊อก' end as description
          from public.stock_movements
          where recorded_by = u.id and service_date = v_service_date
          union all
          select 'count' as activity_type, counted_at as activity_time, 'ตรวจนับสต๊อก' as description
          from public.stock_count_snapshots
          where counted_by = u.id and service_date = v_service_date
        ) act
        order by act.activity_time desc
        limit 1
      )
    ) order by case u.role when 'round_lead' then 1 when 'admin' then 2 else 3 end, u.display_name
  ), '[]'::jsonb)
  into v_members
  from public.delivery_round_members member
  join public.users u on u.id = member.user_id
  where v_round.id is not null
    and member.round_id = v_round.id;

  -- Delivery Summary
  select jsonb_build_object(
    'activeDeliveryCount', count(c.id),
    'actualShopCount', count(distinct c.shop_id),
    'problemCount', (
      select count(*)
      from public.round_stops s
      where (v_round.id is not null and s.round_id = v_round.id)
        and s.status = 'issue'
    )
  )
  into v_delivery_summary
  from public.delivery_charges c
  where c.service_date = v_service_date and c.status = 'active';

  -- Sales Summary
  select coalesce(sum(c.original_amount), 0)
  into v_net_sales_value
  from public.delivery_charges c
  where c.service_date = v_service_date and c.status = 'active';

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'ice_type_id', s.id,
      'ice_type_name', s.name,
      'unit', s.unit,
      'quantity', s.total_qty
    ) order by s.code
  ), '[]'::jsonb)
  into v_ice_type_sales
  from (
    select ice.id, ice.name, ice.unit, ice.code,
           coalesce(sum(item.quantity) filter (where charge.id is not null), 0) as total_qty
    from public.ice_types ice
    left join public.delivery_items item on item.ice_type_id = ice.id
    left join public.delivery_charges charge on charge.delivery_event_id = item.delivery_event_id
      and charge.service_date = v_service_date and charge.status = 'active'
    where ice.is_active
    group by ice.id, ice.name, ice.unit, ice.code
  ) s;

  v_sales_summary := jsonb_build_object(
    'netSalesValue', v_net_sales_value,
    'iceTypeSales', v_ice_type_sales
  );

  -- Recent Deliveries
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'charge_id', charge.id,
      'round_stop_id', event.round_stop_id,
      'shop_id', charge.shop_id,
      'shop_name', shop.name,
      'net_amount', charge.original_amount,
      'payment_term', charge.payment_term,
      'created_at', charge.created_at,
      'recorded_by_name', recorder.display_name
    ) order by charge.created_at desc
  ), '[]'::jsonb)
  into v_recent_deliveries
  from public.delivery_charges charge
  join public.delivery_events event on event.id = charge.delivery_event_id
  join public.shops shop on shop.id = charge.shop_id
  left join public.users recorder on recorder.id = event.recorded_by
  where charge.service_date = v_service_date and charge.status = 'active';

  -- Active Problems List
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'stop_id', stop.id,
      'shop_code', stop.shop_code_snapshot,
      'shop_name', stop.shop_name_snapshot,
      'problem_note', stop.note,
      'updated_at', stop.updated_at,
      'updated_by_name', updater.display_name
    ) order by stop.updated_at desc
  ), '[]'::jsonb)
  into v_problems
  from public.round_stops stop
  left join public.users updater on updater.id = stop.updated_by
  where (v_round.id is not null and stop.round_id = v_round.id)
    and stop.status = 'issue';

  -- Readiness snapshot
  v_readiness := public.get_daily_stock_count_readiness(null, v_service_date);

  -- Cancellation state
  if public.current_app_role() <> 'admin' then
    v_can_cancel := false;
    v_blocker_reason := 'เฉพาะแอดมินเท่านั้นที่สามารถยกเลิกงานวันนี้ได้';
  elsif v_status <> 'in_progress' then
    v_can_cancel := false;
    v_blocker_reason := 'สามารถยกเลิกได้เฉพาะงานที่กำลังทำงานอยู่เท่านั้น';
  else
    v_blockers := public.daily_work_session_cancellation_blockers(v_round.id, v_service_date);
    if cardinality(v_blockers) > 0 then
      v_can_cancel := false;
      v_blocker_reason := 'ยกเลิกไม่ได้ เนื่องจากเริ่มทำรายการแล้ว';
    else
      v_can_cancel := true;
      v_blocker_reason := null;
    end if;
  end if;

  v_cancellation_state := jsonb_build_object(
    'can_cancel', v_can_cancel,
    'blocker_reason', v_blocker_reason
  );

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_round.id,
      'service_date', v_service_date,
      'status', v_status,
      'opened_at', v_round.opened_at,
      'closed_at', v_round.closed_at,
      'cancelled_at', v_round.cancelled_at,
      'opened_by_name', v_opened_by_name,
      'closed_by_name', v_closed_by_name,
      'cancelled_by_name', v_cancelled_by_name,
      'cancel_reason', v_round.cancellation_reason
    ),
    'members', v_members,
    'deliverySummary', v_delivery_summary,
    'salesSummary', v_sales_summary,
    'recentDeliveries', v_recent_deliveries,
    'problems', v_problems,
    'readiness', v_readiness,
    'cancellationState', v_cancellation_state
  );
end;
$$;

-- 4. Update get_daily_stock_close_state to ignore open daily work sessions
create or replace function public.get_daily_stock_close_state(
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
      where service_date = v_service_date
        and status = 'open'
        and round_type = 'special'
        and cancelled_at is null
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

-- 5. Permissions
grant execute on function public.cancel_daily_work_session(date, text) to authenticated;
grant execute on function public.get_daily_work_dashboard(date) to authenticated;
