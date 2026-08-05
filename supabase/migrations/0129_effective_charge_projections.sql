-- Make closed-period adjustments visible to stock, collection, receivable,
-- payment, and history consumers through one effective charge amount.

create or replace function public.stock_balance_at(
  p_service_date date,
  p_location_id uuid,
  p_ice_type_id uuid
)
returns numeric(12, 1)
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
      and (
        movement.kind <> 'factory_order'
        or not exists (
          select 1 from public.factory_receipts receipt
          where receipt.factory_order_id = movement.id
        )
      )
      and item.ice_type_id = p_ice_type_id
      and (movement.from_location_id = p_location_id or movement.to_location_id = p_location_id)
  ), delivery_totals as (
    select (
      coalesce(sum(item.quantity), 0)
      + coalesce((
        select sum(adjustment_item.quantity_delta)
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items adjustment_item
          on adjustment_item.adjustment_id = adjustment.idempotency_key
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        join public.delivery_events adjusted_event on adjusted_event.id = charge.delivery_event_id
        where adjustment.status = 'active' and adjustment.scope = 'round_closed'
          and charge.service_date = p_service_date
          and adjusted_event.source_stock_location_id = p_location_id
          and adjustment_item.ice_type_id = p_ice_type_id
      ), 0)
    ) as quantity
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id = event.id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.delivery_rounds round on round.id = stop.round_id
    where round.service_date = p_service_date
      and event.status = 'active'
      and event.source_stock_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
  ), receipt_totals as (
    select coalesce(sum(item.actual_quantity), 0) as quantity
    from public.factory_receipts receipt
    join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
    join public.stock_movements factory_order on factory_order.id = receipt.factory_order_id
    where receipt.service_date = p_service_date
      and receipt.truck_location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and factory_order.status = 'active'
  ), count_adjustment as (
    select coalesce(sum(item.variance_quantity), 0) as quantity
    from public.daily_stock_closure_items item
    join public.daily_stock_closures closure on closure.service_date = item.service_date
    where item.service_date = p_service_date
      and item.location_id = p_location_id
      and item.ice_type_id = p_ice_type_id
      and closure.status in ('closing', 'closed')
  )
  select (
    movement_totals.quantity - delivery_totals.quantity
    + receipt_totals.quantity + count_adjustment.quantity
  )::numeric(12, 1)
  from movement_totals, delivery_totals, receipt_totals, count_adjustment;
$$;

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
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = p_service_date and closure.status = 'closed'
  ) then 0::numeric(12,1) else (
    coalesce((
      select sum(item.quantity)
      from public.stock_movements movement
      join public.stock_movement_items item on item.movement_id = movement.id
      where movement.service_date = p_service_date and movement.status = 'active'
        and movement.kind = 'factory_order' and item.ice_type_id = p_ice_type_id
        and not exists (
          select 1 from public.factory_receipts receipt where receipt.factory_order_id = movement.id
        )
    ), 0)
    + coalesce((
      select sum(item.actual_quantity)
      from public.factory_receipts receipt
      join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
      join public.stock_movements movement on movement.id = receipt.factory_order_id
      where receipt.service_date = p_service_date and movement.status = 'active'
        and item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(item.quantity)
      from public.delivery_events event
      join public.delivery_items item on item.delivery_event_id = event.id
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.delivery_rounds round on round.id = stop.round_id
      where round.service_date = p_service_date and event.status = 'active'
        and event.source_stock_location_id is not null and item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(adjustment_item.quantity_delta)
      from public.delivery_charge_adjustments adjustment
      join public.delivery_adjustment_items adjustment_item
        on adjustment_item.adjustment_id = adjustment.idempotency_key
      join public.delivery_charges charge on charge.id = adjustment.charge_id
      where adjustment.status = 'active' and adjustment.scope = 'round_closed'
        and charge.service_date = p_service_date and adjustment_item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(item.quantity)
      from public.daily_stock_uses usage
      join public.daily_stock_use_items item on item.use_id = usage.id
      where usage.service_date = p_service_date and usage.status = 'active'
        and item.ice_type_id = p_ice_type_id
    ), 0)
    - coalesce((
      select sum(item.quantity)
      from public.stock_movements movement
      join public.stock_movement_items item on item.movement_id = movement.id
      where movement.service_date = p_service_date and movement.status = 'active'
        and movement.kind in ('damage', 'return_to_factory') and item.ice_type_id = p_ice_type_id
    ), 0)
  )::numeric(12,1) end;
$$;

create or replace function public.get_shop_purchase_history(
  p_shop_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view shop purchase history';
  elsif p_shop_id is null or not exists (select 1 from public.shops shop where shop.id = p_shop_id) then
    raise exception 'The shop does not exist';
  end if;

  return coalesce((
    select jsonb_agg(history.entry order by history.service_date desc, history.recorded_at desc)
    from (
      select jsonb_build_object(
        'delivery_event_id', event.id,
        'delivery_status', case
          when event.status = 'cancelled' and revision.replacement_event_id is not null then 'replaced'
          else event.status::text
        end,
        'corrects_event_id', event.corrects_event_id,
        'replacement_event_id', revision.replacement_event_id,
        'cancellation_reason', event.cancellation_reason,
        'round_status', round.status,
        'day_closed', exists (
          select 1 from public.daily_stock_closures closure
          where closure.service_date = round.service_date and closure.status = 'closed'
        ) or exists (
          select 1 from public.daily_aggregate_stock_closures closure
          where closure.service_date = round.service_date and closure.status = 'closed'
        ),
        'charge_id', charge.id,
        'charge_number', charge.charge_number,
        'charge_status', charge.status,
        'service_date', round.service_date,
        'recorded_at', event.recorded_at,
        'recorded_by_name', recorder.display_name,
        'total_amount', case when charge.id is null then null else public.effective_delivery_charge_amount(charge.id) end,
        'original_amount', charge.original_amount,
        'payment_term', charge.payment_term,
        'allocated_amount', coalesce(payment_summary.allocated_amount, 0),
        'outstanding_amount', case when charge.id is null or charge.status = 'voided' then 0
          else greatest(public.effective_delivery_charge_amount(charge.id)
            - coalesce(payment_summary.allocated_amount, 0), 0) end,
        'payment_status', case
          when charge.id is null then null
          when charge.status = 'voided' then 'voided'
          when coalesce(payment_summary.allocated_amount, 0) <= 0 then 'unpaid'
          when payment_summary.allocated_amount < public.effective_delivery_charge_amount(charge.id) then 'partial'
          else 'paid' end,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ice_type_id', item.ice_type_id, 'name', ice.name, 'unit', ice.unit,
            'quantity', item.quantity, 'unit_price', item.unit_price, 'line_total', item.line_total
          ) order by ice.code)
          from public.delivery_items item join public.ice_types ice on ice.id = item.ice_type_id
          where item.delivery_event_id = event.id
        ), '[]'::jsonb),
        'adjustments', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', adjustment.idempotency_key, 'scope', adjustment.scope,
            'amount_delta', adjustment.amount_delta, 'corrected_total', adjustment.corrected_total,
            'reason', adjustment.reason, 'created_at', adjustment.created_at,
            'items', coalesce((
              select jsonb_agg(jsonb_build_object(
                'ice_type_id', adjustment_item.ice_type_id,
                'original_quantity', adjustment_item.original_quantity,
                'corrected_quantity', adjustment_item.corrected_quantity,
                'quantity_delta', adjustment_item.quantity_delta
              )) from public.delivery_adjustment_items adjustment_item
              where adjustment_item.adjustment_id = adjustment.idempotency_key
            ), '[]'::jsonb)
          ) order by adjustment.created_at)
          from public.delivery_charge_adjustments adjustment
          where adjustment.charge_id = charge.id and adjustment.status = 'active'
        ), '[]'::jsonb),
        'payments', coalesce(payment_summary.payments, '[]'::jsonb)
      ) as entry, round.service_date, event.recorded_at
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.delivery_rounds round on round.id = stop.round_id
      join public.users recorder on recorder.id = event.recorded_by
      left join public.delivery_charges charge on charge.delivery_event_id = event.id
      left join public.delivery_event_revisions revision on revision.original_event_id = event.id
      left join lateral (
        select coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount,
          jsonb_agg(jsonb_build_object(
            'payment_id', payment.id, 'payment_method', payment.payment_method,
            'amount', allocation.amount, 'recorded_at', payment.recorded_at
          ) order by payment.recorded_at) as payments
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
        where allocation.charge_id = charge.id
      ) payment_summary on true
      where stop.shop_id = p_shop_id
        and exists (select 1 from public.delivery_items item where item.delivery_event_id = event.id)
      order by round.service_date desc, event.recorded_at desc
      limit v_limit offset v_offset
    ) history
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then raise exception 'An active user is required'; end if;
  if not exists (
    select 1 from public.collection_runs run
    where run.id = p_collection_run_id and run.status = 'open'
      and (public.current_app_role() in ('admin', 'round_lead') or public.is_collection_run_member(run.id))
  ) then raise exception 'The collection run does not exist, is closed, or is not assigned to this user'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', queue.shop_id, 'shop_code', queue.shop_code, 'shop_name', queue.shop_name,
      'image_path', queue.image_path, 'outstanding_amount', queue.outstanding_amount,
      'charge_count', queue.charge_count, 'latest_charge_at', queue.latest_charge_at,
      'latest_payment_at', queue.latest_payment_at,
      'has_new_charges', queue.latest_payment_at is not null and queue.latest_charge_at > queue.latest_payment_at,
      'payment_profile', queue.payment_profile, 'charges', queue.charges
    ) order by queue.shop_code)
    from (
      select shop.id as shop_id, shop.code as shop_code, shop.name as shop_name, shop.image_path,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        count(*)::integer as charge_count, max(charge.created_at) as latest_charge_at,
        jsonb_build_object(
          'allowed_payment_methods', profile.allowed_payment_methods,
          'default_payment_method', profile.default_payment_method,
          'cash_reference_required', profile.cash_reference_required,
          'cash_evidence_required', profile.cash_evidence_required,
          'bank_transfer_reference_required', profile.bank_transfer_reference_required,
          'bank_transfer_evidence_required', profile.bank_transfer_evidence_required,
          'qr_reference_required', profile.qr_reference_required,
          'qr_evidence_required', profile.qr_evidence_required
        ) as payment_profile,
        (select max(payment.recorded_at) from public.payments payment
          where payment.shop_id = shop.id and payment.collection_run_id = p_collection_run_id
            and payment.status = 'active') as latest_payment_at,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id, 'charge_number', charge.charge_number,
          'delivery_event_id', charge.delivery_event_id, 'service_date', charge.service_date,
          'payment_term', charge.payment_term, 'due_date', charge.due_date,
          'original_amount', public.effective_delivery_charge_amount(charge.id),
          'base_amount', charge.original_amount,
          'outstanding_amount', balance.outstanding_amount, 'created_at', charge.created_at,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'ice_type_id', ice.id, 'name', ice.name, 'unit', ice.unit,
              'quantity', item.quantity, 'line_total', item.line_total
            ) order by ice.code)
            from public.delivery_items item join public.ice_types ice on ice.id = item.ice_type_id
            where item.delivery_event_id = charge.delivery_event_id
          ), '[]'::jsonb)
        ) order by coalesce(charge.due_date, charge.service_date), charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      join public.shops shop on shop.id = charge.shop_id
      join public.shop_payment_profiles profile on profile.shop_id = shop.id
      join lateral (
        select greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
          as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where public.is_charge_collectible_in_run(charge.id, p_collection_run_id)
        and balance.outstanding_amount > 0
      group by shop.id, profile.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_today_collection_run_queue(p_collection_run_id uuid)
returns jsonb language sql stable security definer set search_path = public
as $$ select public.get_collection_run_queue(p_collection_run_id); $$;

create or replace function public.get_credit_receivables(
  p_as_of_date date default ((now() at time zone 'Asia/Bangkok')::date)
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view credit receivables';
  end if;
  return coalesce((
    with charge_balances as (
      select charge.*,
        coalesce(active_allocations.amount, 0)::numeric(12,2) as allocated_amount,
        greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(active_allocations.amount, 0), 0)::numeric(12,2) as outstanding_amount
      from public.delivery_charges charge
      left join lateral (
        select sum(allocation.amount)::numeric(12,2) as amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
        where allocation.charge_id = charge.id
      ) active_allocations on true
      where charge.payment_term = 'credit' and charge.status = 'active'
    ), account_balances as (
      select charge.shop_id,
        sum(charge.outstanding_amount)::numeric(12,2) as outstanding_amount,
        min(charge.due_date) filter (where charge.outstanding_amount > 0) as oldest_due_date,
        sum(case when charge.due_date < p_as_of_date then charge.outstanding_amount else 0 end)::numeric(12,2) as overdue_amount,
        sum(case when charge.due_date = p_as_of_date then charge.outstanding_amount else 0 end)::numeric(12,2) as due_today_amount,
        count(*) filter (where charge.outstanding_amount > 0 and charge.due_date = p_as_of_date)::integer as due_today_charge_count,
        count(*) filter (where charge.outstanding_amount > 0 and charge.due_date < p_as_of_date)::integer as overdue_charge_count,
        sum(case when charge.due_date >= p_as_of_date then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_current_amount,
        sum(case when p_as_of_date - charge.due_date between 1 and 7 then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_1_7_amount,
        sum(case when p_as_of_date - charge.due_date between 8 and 15 then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_8_15_amount,
        sum(case when p_as_of_date - charge.due_date between 16 and 30 then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_16_30_amount,
        sum(case when p_as_of_date - charge.due_date > 30 then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_over_30_amount
      from charge_balances charge group by charge.shop_id
    )
    select jsonb_agg(jsonb_build_object(
      'shop_id', shop.id, 'shop_code', shop.code, 'shop_name', shop.name,
      'building_name', latest_stop.building_name_snapshot,
      'zone_name', latest_stop.floor_or_zone_snapshot,
      'responsible_name', responsible.display_name,
      'credit_due_rule', profile.credit_due_rule,
      'credit_days', profile.credit_days,
      'credit_collection_weekday', profile.credit_collection_weekday,
      'credit_limit', profile.credit_limit,
      'available_credit_amount', case when profile.credit_limit is null then null
        else (profile.credit_limit - account.outstanding_amount)::numeric(12,2) end,
      'credit_suspended', profile.credit_suspended,
      'credit_suspension_reason', profile.credit_suspension_reason,
      'outstanding_amount', account.outstanding_amount,
      'oldest_due_date', account.oldest_due_date, 'overdue_amount', account.overdue_amount,
      'due_today_amount', account.due_today_amount,
      'due_today_charge_count', account.due_today_charge_count,
      'overdue_charge_count', account.overdue_charge_count,
      'aging_current_amount', account.aging_current_amount,
      'aging_1_7_amount', account.aging_1_7_amount,
      'aging_8_15_amount', account.aging_8_15_amount,
      'aging_16_30_amount', account.aging_16_30_amount,
      'aging_over_30_amount', account.aging_over_30_amount,
      'last_payment_at', last_payment.recorded_at,
      'charges', '[]'::jsonb, 'payments', '[]'::jsonb
    ) order by account.oldest_due_date nulls last, shop.code)
    from account_balances account
    join public.shops shop on shop.id = account.shop_id
    join public.shop_payment_profiles profile on profile.shop_id = shop.id
    left join lateral (
      select stop.round_id, stop.building_name_snapshot, stop.floor_or_zone_snapshot
      from public.round_stops stop join public.delivery_rounds round on round.id = stop.round_id
      where stop.shop_id = shop.id and round.service_date <= p_as_of_date
      order by round.service_date desc, stop.updated_at desc, stop.id limit 1
    ) latest_stop on true
    left join lateral (
      select string_agg(distinct member.display_name, ', ' order by member.display_name) as display_name
      from public.delivery_round_members membership
      join public.users member on member.id = membership.user_id
      where membership.round_id = latest_stop.round_id
    ) responsible on true
    left join lateral (
      select max(payment.recorded_at) as recorded_at
      from public.payments payment where payment.shop_id = shop.id and payment.status = 'active'
        and exists (
          select 1 from public.payment_allocations allocation
          join public.delivery_charges allocated_charge on allocated_charge.id = allocation.charge_id
          where allocation.payment_id = payment.id and allocated_charge.payment_term = 'credit'
        )
    ) last_payment on true
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_credit_receivable_detail(
  p_shop_id uuid,
  p_as_of_date date default ((now() at time zone 'Asia/Bangkok')::date)
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view credit receivables';
  elsif p_shop_id is null or not exists (
    select 1 from public.shop_payment_profiles profile
    where profile.shop_id = p_shop_id and 'credit' = any(profile.allowed_payment_terms)
  ) then raise exception 'The selected shop does not have a credit account'; end if;

  return jsonb_build_object(
    'ice_types', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ice.id, 'code', ice.code, 'name', ice.name, 'unit', ice.unit
      ) order by ice.code) from public.ice_types ice where ice.is_active
    ), '[]'::jsonb),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_id', charge.id, 'charge_number', charge.charge_number,
        'service_date', charge.service_date, 'due_date', charge.due_date,
        'original_amount', public.effective_delivery_charge_amount(charge.id),
        'base_amount', charge.original_amount,
        'allocated_amount', balance.allocated_amount,
        'outstanding_amount', balance.outstanding_amount,
        'assigned_collection_run_id', (
          select assignment.collection_run_id
          from public.collection_run_credit_charges assignment
          join public.collection_runs collection_run on collection_run.id = assignment.collection_run_id
          where assignment.charge_id = charge.id and collection_run.status = 'open'
            and collection_run.service_date = p_as_of_date limit 1
        ),
        'days_overdue', greatest(p_as_of_date - charge.due_date, 0),
        'payment_status', case when balance.outstanding_amount = 0 then 'paid'
          when balance.allocated_amount > 0 then 'partial' else 'unpaid' end,
        'due_status', case when balance.outstanding_amount = 0 then 'paid'
          when charge.due_date < p_as_of_date then 'overdue'
          when charge.due_date = p_as_of_date then 'due_today' else 'not_due' end,
        'delivery_event_id', delivery_event.id,
        'round_status', delivery_round.status,
        'day_closed', exists (
          select 1 from public.daily_stock_closures closure
          where closure.service_date = delivery_round.service_date and closure.status = 'closed'
        ) or exists (
          select 1 from public.daily_aggregate_stock_closures closure
          where closure.service_date = delivery_round.service_date and closure.status = 'closed'
        ),
        'stop_status', coalesce((
          select audit.after_value ->> 'stop_status'
          from public.audit_logs audit
          where audit.entity_type = 'delivery_events' and audit.entity_id = delivery_event.id
            and audit.after_value ? 'stop_status'
          order by audit.occurred_at limit 1
        ), case when exists (
          select 1 from public.delivery_items item where item.delivery_event_id = delivery_event.id
        ) then 'delivered' else 'issue' end),
        'note', delivery_event.note, 'recorded_at', delivery_event.recorded_at,
        'recorded_by', recorder.display_name,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ice_type_id', item.ice_type_id, 'name', ice.name, 'unit', ice.unit,
            'quantity', item.quantity
          ) order by ice.code)
          from public.delivery_items item join public.ice_types ice on ice.id = item.ice_type_id
          where item.delivery_event_id = delivery_event.id
        ), '[]'::jsonb),
        'adjustments', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', adjustment.idempotency_key, 'scope', adjustment.scope,
            'amount_delta', adjustment.amount_delta, 'corrected_total', adjustment.corrected_total,
            'reason', adjustment.reason, 'created_at', adjustment.created_at
          ) order by adjustment.created_at)
          from public.delivery_charge_adjustments adjustment
          where adjustment.charge_id = charge.id and adjustment.status = 'active'
        ), '[]'::jsonb)
      ) order by charge.due_date, charge.created_at, charge.id)
      from public.delivery_charges charge
      join public.delivery_events delivery_event on delivery_event.id = charge.delivery_event_id
      join public.round_stops stop on stop.id = delivery_event.round_stop_id
      join public.delivery_rounds delivery_round on delivery_round.id = stop.round_id
      join public.users recorder on recorder.id = delivery_event.recorded_by
      join lateral (
        select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2)
            as allocated_amount,
          greatest(public.effective_delivery_charge_amount(charge.id)
            - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
            as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
          and allocation.charge_id = charge.id
      ) balance on true
      where charge.shop_id = p_shop_id and charge.payment_term = 'credit' and charge.status = 'active'
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', payment.id, 'receipt_number', payment.receipt_number,
        'received_amount', payment.received_amount, 'allocated_amount', payment.allocated_amount,
        'payment_method', payment.payment_method, 'status', payment.status,
        'recorded_at', payment.recorded_at, 'recorded_by', recorder.display_name,
        'allocations', coalesce((
          select jsonb_agg(jsonb_build_object(
            'charge_id', allocated_charge.id, 'charge_number', allocated_charge.charge_number,
            'amount', allocation.amount
          ) order by allocated_charge.due_date, allocated_charge.created_at)
          from public.payment_allocations allocation
          join public.delivery_charges allocated_charge on allocated_charge.id = allocation.charge_id
          where allocation.payment_id = payment.id and allocated_charge.payment_term = 'credit'
        ), '[]'::jsonb),
        'refund_obligations', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', obligation.id, 'amount', obligation.amount, 'status', obligation.status,
            'reason', obligation.reason
          ) order by obligation.created_at)
          from public.refund_obligations obligation where obligation.payment_id = payment.id
        ), '[]'::jsonb)
      ) order by payment.recorded_at desc)
      from public.payments payment join public.users recorder on recorder.id = payment.recorded_by
      where payment.shop_id = p_shop_id and (
        exists (
          select 1 from public.payment_allocations allocation
          join public.delivery_charges allocated_charge on allocated_charge.id = allocation.charge_id
          where allocation.payment_id = payment.id and allocated_charge.payment_term = 'credit'
        ) or exists (
          select 1 from public.refund_obligations obligation
          join public.delivery_charges source_charge on source_charge.id = obligation.source_charge_id
          where obligation.payment_id = payment.id and source_charge.payment_term = 'credit'
        )
      )
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.stock_balance_at(date, uuid, uuid) from public;

create or replace function public.get_round_shop_cards(
  p_round_id uuid,
  p_building_id uuid default null
)
returns table (
  round_stop_id uuid, shop_id uuid, shop_code text, shop_name text,
  building_id uuid, building_name text, floor_or_zone text, sequence_no integer,
  image_path text, payment_status public.shop_payment_status,
  stop_status public.shop_round_status, stop_note text,
  today_history jsonb, today_totals jsonb
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
  if v_service_date is null then raise exception 'The selected delivery round does not exist'; end if;
  v_can_view_all := public.current_app_role() in ('admin', 'round_lead');
  if not public.is_active_user() or (not coalesce(v_can_view_all, false)
    and not public.is_round_member(p_round_id)) then
    raise exception 'You are not assigned to this delivery round';
  end if;

  return query
  with daily_events as (
    select day_stop.shop_id, event.id, event.recorded_at, day_round.name as round_name,
      day_round.status as delivery_round_status, event.recorded_by as recorded_by_id,
      recorder.display_name as recorded_by_name, event.note, charge.id as charge_id,
      coalesce(allocation.allocated_amount, 0)::numeric(12,2) as allocated_amount,
      coalesce((
        select log.after_value ->> 'stop_status' from public.audit_logs log
        where log.entity_type = 'delivery_events' and log.entity_id = event.id
          and log.after_value ? 'stop_status'
        order by log.occurred_at limit 1
      ), case when count(item.ice_type_id) > 0 then 'delivered' else 'issue' end) as event_stop_status,
      coalesce(jsonb_object_agg(item.ice_type_id, item.quantity)
        filter (where item.ice_type_id is not null), '{}'::jsonb) as items,
      not exists (
        select 1 from public.delivery_events newer
        where newer.round_stop_id = event.round_stop_id and newer.status = 'active'
          and (newer.recorded_at, newer.id) > (event.recorded_at, event.id)
      ) as is_latest
    from public.round_stops day_stop
    join public.delivery_rounds day_round on day_round.id = day_stop.round_id
    join public.delivery_events event on event.round_stop_id = day_stop.id and event.status = 'active'
    join public.users recorder on recorder.id = event.recorded_by
    left join public.delivery_items item on item.delivery_event_id = event.id
    left join public.delivery_charges charge on charge.delivery_event_id = event.id and charge.status = 'active'
    left join lateral (
      select sum(payment_allocation.amount) as allocated_amount
      from public.payment_allocations payment_allocation
      join public.payments payment on payment.id = payment_allocation.payment_id and payment.status = 'active'
      where payment_allocation.charge_id = charge.id
    ) allocation on true
    where day_round.service_date = v_service_date
    group by day_stop.shop_id, event.id, event.recorded_at, day_round.name, day_round.status,
      event.recorded_by, recorder.display_name, event.note, charge.id, allocation.allocated_amount
  ), daily_history as (
    select daily_events.shop_id, jsonb_agg(jsonb_build_object(
      'event_id', daily_events.id, 'recorded_at', daily_events.recorded_at,
      'round_name', daily_events.round_name, 'recorded_by', daily_events.recorded_by_name,
      'recorded_by_id', daily_events.recorded_by_id,
      'stop_status', daily_events.event_stop_status, 'note', daily_events.note,
      'items', daily_events.items, 'charge_id', daily_events.charge_id,
      'allocated_amount', daily_events.allocated_amount,
      'can_correct', daily_events.is_latest and daily_events.delivery_round_status = 'open'
        and daily_events.charge_id is not null
        and (public.current_app_role() in ('admin', 'round_lead') or (
          daily_events.recorded_by_id = auth.uid() and daily_events.allocated_amount = 0
          and v_service_date = (now() at time zone 'Asia/Bangkok')::date
        )),
      'can_cancel', daily_events.is_latest and daily_events.delivery_round_status = 'open'
        and daily_events.charge_id is not null
        and public.current_app_role() in ('admin', 'round_lead'),
      'correction_blocker', case
        when not daily_events.is_latest then 'ไม่ใช่รายการล่าสุด'
        when daily_events.delivery_round_status <> 'open' then 'รอบส่งปิดแล้ว'
        when daily_events.charge_id is null then 'รายการนี้ไม่มีข้อมูลบิล'
        when public.current_app_role() = 'courier' and daily_events.recorded_by_id <> auth.uid()
          then 'แก้ได้เฉพาะรายการที่คุณบันทึก'
        when public.current_app_role() = 'courier' and daily_events.allocated_amount > 0
          then 'บิลรับชำระแล้ว ต้องให้หัวหน้าหรือแอดมินแก้'
        else null end
    ) order by daily_events.recorded_at desc, daily_events.id desc) as history
    from daily_events group by daily_events.shop_id
  ), daily_item_totals as (
    select day_stop.shop_id, item.ice_type_id, sum(item.quantity) as quantity
    from public.round_stops day_stop
    join public.delivery_rounds day_round on day_round.id = day_stop.round_id
    join public.delivery_events event on event.round_stop_id = day_stop.id and event.status = 'active'
    join public.delivery_items item on item.delivery_event_id = event.id
    where day_round.service_date = v_service_date
    group by day_stop.shop_id, item.ice_type_id
  ), daily_totals as (
    select daily_item_totals.shop_id, jsonb_object_agg(ice_type_id, quantity) as totals
    from daily_item_totals group by daily_item_totals.shop_id
  )
  select stop.id, stop.shop_id, stop.shop_code_snapshot, stop.shop_name_snapshot,
    stop.building_id_snapshot, stop.building_name_snapshot, stop.floor_or_zone_snapshot,
    stop.sequence_no, shop.image_path, shop.payment_status, stop.status, stop.note,
    coalesce(history.history, '[]'::jsonb), coalesce(totals.totals, '{}'::jsonb)
  from public.round_stops stop join public.shops shop on shop.id = stop.shop_id
  left join daily_history history on history.shop_id = stop.shop_id
  left join daily_totals totals on totals.shop_id = stop.shop_id
  where stop.round_id = p_round_id
    and (p_building_id is null or stop.building_id_snapshot = p_building_id)
  order by stop.sequence_no;
end;
$$;

revoke all on function public.daily_aggregate_stock_balance_at(date, uuid) from public;
revoke all on function public.get_shop_purchase_history(uuid, integer, integer) from public;
revoke all on function public.get_round_shop_cards(uuid, uuid) from public;
grant execute on function public.get_shop_purchase_history(uuid, integer, integer) to authenticated;
grant execute on function public.get_round_shop_cards(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
