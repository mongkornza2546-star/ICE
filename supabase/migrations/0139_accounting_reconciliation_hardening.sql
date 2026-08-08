-- Keep accounting on the canonical aggregate stock model.
-- Include order-based factory stock in the ledger and preserve historical products.

create or replace function public.accounting_aggregate_reconciliation_rows(p_service_date date)
returns table (
  id uuid,
  code text,
  name text,
  unit text,
  factory_in numeric,
  sold numeric,
  damaged numeric,
  returned_to_factory numeric,
  expected numeric,
  actual numeric,
  variance numeric,
  count_status text
)
language sql
stable
security definer
set search_path = public
as $$
  with closure_state as materialized (
    select closure.service_date, closure.status, closure.closed_at
    from public.daily_aggregate_stock_closures closure
    where closure.service_date = p_service_date
  ), ice as materialized (
    select ice_type.id, ice_type.code, ice_type.name, ice_type.unit
    from public.ice_types ice_type
    where (ice_type.is_active and ice_type.created_at <= coalesce(
        (select state.closed_at from closure_state state where state.status = 'closed'),
        (p_service_date + 1)::timestamp at time zone 'Asia/Bangkok'
      ))
      or exists (
        select 1 from public.stock_movement_items item
        join public.stock_movements movement on movement.id = item.movement_id
        where movement.service_date = p_service_date and item.ice_type_id = ice_type.id
      )
      or exists (
        select 1 from public.delivery_items item
        join public.delivery_events event on event.id = item.delivery_event_id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date and item.ice_type_id = ice_type.id
      )
      or exists (
        select 1 from public.delivery_adjustment_items item
        join public.delivery_charge_adjustments adjustment
          on adjustment.idempotency_key = item.adjustment_id
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        where charge.service_date = p_service_date and item.ice_type_id = ice_type.id
      )
      or exists (
        select 1 from public.daily_stock_use_items item
        join public.daily_stock_uses usage on usage.id = item.use_id
        where usage.service_date = p_service_date and item.ice_type_id = ice_type.id
      )
      or exists (
        select 1 from public.daily_aggregate_stock_closure_items item
        where item.service_date = p_service_date and item.ice_type_id = ice_type.id
      )
  ), source_latest as (
    select greatest(
      coalesce((select max(receipt.recorded_at)
        from public.factory_receipts receipt
        join public.stock_movements factory_order on factory_order.id = receipt.factory_order_id
        where factory_order.service_date = p_service_date and factory_order.status = 'active'
          and factory_order.kind = 'factory_order'), '-infinity'),
      coalesce((select max(greatest(movement.recorded_at,
          coalesce(movement.cancelled_at, movement.recorded_at)))
        from public.stock_movements movement
        where movement.service_date = p_service_date), '-infinity'),
      coalesce((select max(greatest(event.recorded_at,
          coalesce(event.cancelled_at, event.recorded_at)))
        from public.delivery_events event
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date), '-infinity'),
      coalesce((select max(revision.revised_at) from public.delivery_event_revisions revision
        join public.delivery_events event on event.id = revision.original_event_id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date), '-infinity'),
      coalesce((select max(adjustment.created_at) from public.delivery_charge_adjustments adjustment
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        where charge.service_date = p_service_date), '-infinity'),
      coalesce((select max(greatest(usage.recorded_at,
          coalesce(usage.cancelled_at, usage.recorded_at)))
        from public.daily_stock_uses usage
        where usage.service_date = p_service_date), '-infinity')
    ) as recorded_at
  ), aggregate_values as materialized (
    select ice.*,
      (coalesce((select sum(item.quantity)
        from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'factory_order' and item.ice_type_id = ice.id
          and not exists (select 1 from public.factory_receipts receipt
            where receipt.factory_order_id = movement.id)), 0)
       + coalesce((select sum(item.actual_quantity)
        from public.factory_receipts receipt
        join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
        join public.stock_movements movement on movement.id = receipt.factory_order_id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'factory_order' and item.ice_type_id = ice.id), 0))::numeric as factory_in,
      (coalesce((select sum(item.quantity)
        from public.delivery_events event
        join public.delivery_items item on item.delivery_event_id = event.id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date and event.status = 'active'
          and event.source_stock_location_id is not null
          and item.ice_type_id = ice.id), 0)
       -- Post-close corrections remain visible here and make the saved count stale.
       + coalesce((select sum(item.quantity_delta)
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items item on item.adjustment_id = adjustment.idempotency_key
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        where charge.service_date = p_service_date and adjustment.status = 'active'
          and item.ice_type_id = ice.id), 0))::numeric as sold,
      coalesce((select sum(item.quantity)
        from public.daily_stock_uses usage
        join public.daily_stock_use_items item on item.use_id = usage.id
        where usage.service_date = p_service_date and usage.status = 'active'
          and item.ice_type_id = ice.id), 0)::numeric as legacy_refill,
      coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'damage' and item.ice_type_id = ice.id), 0)::numeric as damaged,
      coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'return_to_factory' and item.ice_type_id = ice.id), 0)::numeric as returned_to_factory
    from ice
  )
  select value.id, value.code, value.name, value.unit,
    value.factory_in, value.sold, value.damaged, value.returned_to_factory,
    value.factory_in - value.sold - value.legacy_refill
      - value.damaged - value.returned_to_factory as expected,
    case when state.status = 'closed' and closure_item.ice_type_id is not null
        and state.closed_at >= latest.recorded_at
      then closure_item.actual_quantity end as actual,
    case when state.status = 'closed' and closure_item.ice_type_id is not null
        and state.closed_at >= latest.recorded_at
      then closure_item.actual_quantity - (
        value.factory_in - value.sold - value.legacy_refill
          - value.damaged - value.returned_to_factory
    ) end as variance,
    case
      when state.status is distinct from 'closed' or closure_item.ice_type_id is null
        then 'incomplete'
      when state.closed_at < latest.recorded_at then 'stale'
      else 'complete'
    end as count_status
  from aggregate_values value
  cross join source_latest latest
  left join closure_state state on true
  left join public.daily_aggregate_stock_closure_items closure_item
    on closure_item.service_date = p_service_date and closure_item.ice_type_id = value.id;
$$;

create or replace function public.get_accounting_reconciliation(p_service_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view accounting reconciliation';
  elsif p_service_date is null then
    raise exception 'An accounting service date is required';
  end if;

  with aggregate_rows as materialized (
    select * from public.accounting_aggregate_reconciliation_rows(p_service_date)
  ), financial as (
    select
      coalesce((select sum(public.effective_delivery_charge_amount(charge.id))
        from public.delivery_charges charge
        where charge.service_date = p_service_date and charge.status = 'active'), 0)::numeric effective_sales,
      coalesce((select sum(allocation.amount) from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
        join public.delivery_charges charge on charge.id = allocation.charge_id
        where charge.service_date = p_service_date and charge.status = 'active'), 0)::numeric allocated_to_sales,
      coalesce((select sum(greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(allocated.amount, 0), 0)) from public.delivery_charges charge
        left join lateral (select sum(allocation.amount) amount from public.payment_allocations allocation
          join public.payments payment on payment.id = allocation.payment_id
          where allocation.charge_id = charge.id and payment.status = 'active') allocated on true
        where charge.service_date = p_service_date and charge.status = 'active'
          and charge.payment_term <> 'credit'), 0)::numeric outstanding_collectible,
      coalesce((select sum(greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(allocated.amount, 0), 0)) from public.delivery_charges charge
        left join lateral (select sum(allocation.amount) amount from public.payment_allocations allocation
          join public.payments payment on payment.id = allocation.payment_id
          where allocation.charge_id = charge.id and payment.status = 'active') allocated on true
        where charge.service_date = p_service_date and charge.status = 'active'
          and charge.payment_term = 'credit'), 0)::numeric outstanding_credit,
      coalesce((select sum(payment.allocated_amount) from public.payments payment
        where payment.status = 'active'
          and (payment.recorded_at at time zone 'Asia/Bangkok')::date = p_service_date), 0)::numeric cash_received,
      coalesce((select sum(settlement.amount) from public.refund_settlements settlement
        where (settlement.settled_at at time zone 'Asia/Bangkok')::date = p_service_date), 0)::numeric cash_refunded,
      coalesce((select sum(obligation.amount) from public.refund_obligations obligation
        where obligation.status = 'pending'), 0)::numeric pending_refunds
  )
  select jsonb_build_object(
    'service_date', p_service_date,
    'aggregate', coalesce((select jsonb_agg(jsonb_build_object(
      'ice_type_id', row.id, 'ice_type_name', row.name, 'unit', row.unit,
      'factory_in', row.factory_in, 'sold', row.sold,
      'legacy_refill', coalesce((select sum(item.quantity)
        from public.daily_stock_uses usage
        join public.daily_stock_use_items item on item.use_id = usage.id
        where usage.service_date = p_service_date and usage.status = 'active'
          and item.ice_type_id = row.id), 0),
      'damaged', row.damaged, 'returned_to_factory', row.returned_to_factory,
      'expected', row.expected, 'actual', row.actual, 'variance', row.variance,
      'closed_returned_to_factory', coalesce((select item.actual_quantity
        from public.daily_aggregate_stock_closure_items item
        join public.daily_aggregate_stock_closures closure
          on closure.service_date = item.service_date and closure.status = 'closed'
        where item.service_date = p_service_date and item.ice_type_id = row.id), 0),
      'count_status', row.count_status
    ) order by row.code) from aggregate_rows row), '[]'::jsonb),
    'holders', '[]'::jsonb,
    'financial', (select jsonb_build_object(
      'effective_sales', effective_sales, 'allocated_to_sales', allocated_to_sales,
      'outstanding_collectible', outstanding_collectible, 'outstanding_credit', outstanding_credit,
      'cash_received', cash_received, 'cash_refunded', cash_refunded,
      'net_cash', cash_received - cash_refunded, 'pending_refunds', pending_refunds
    ) from financial)
  ) into v_result;
  return v_result;
end;
$$;

create function public.accounting_factory_order_transaction_rows(
  p_from_date date,
  p_to_date date
)
returns table (
  occurred_at timestamptz,
  service_date date,
  type text,
  group_id uuid,
  source_id uuid,
  source_table text,
  delivery_event_id uuid,
  payment_id uuid,
  document_number text,
  reference_number text,
  shop_id uuid,
  shop_code text,
  shop_name text,
  holder_name text,
  employee_id uuid,
  employee_name text,
  ice_type_id uuid,
  ice_type_name text,
  unit text,
  quantity_in numeric,
  quantity_out numeric,
  sales_amount numeric,
  cash_in numeric,
  cash_out numeric,
  receivable_delta numeric,
  status text,
  note text,
  issue_code text,
  issue_label text,
  can_correct boolean,
  details jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select movement.recorded_at, movement.service_date, 'FACTORY', movement.id, movement.id,
    'stock_movements', null::uuid, null::uuid,
    'FACTORY-' || upper(left(replace(movement.id::text, '-', ''), 8)), null::text,
    null::uuid, null::text, null::text, destination.name,
    recorder.id, recorder.display_name, ice.id, ice.name, ice.unit,
    item.quantity, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
    movement.status::text, movement.note,
    case when movement.status = 'cancelled' then 'cancelled_factory_order' end,
    case when movement.status = 'cancelled' then 'คำสั่งซื้อโรงงานถูกยกเลิก' end,
    false,
    jsonb_build_object('kind', movement.kind, 'to_location_id', movement.to_location_id,
      'idempotency_key', movement.idempotency_key)
  from public.stock_movements movement
  join public.stock_movement_items item on item.movement_id = movement.id
  join public.ice_types ice on ice.id = item.ice_type_id
  join public.stock_locations destination on destination.id = movement.to_location_id
  join public.users recorder on recorder.id = movement.recorded_by
  where movement.service_date between p_from_date and p_to_date
    and movement.kind = 'factory_order'
    and not exists (
      select 1 from public.factory_receipts receipt where receipt.factory_order_id = movement.id
    );
$$;

create or replace function public.get_accounting_transactions(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
  p_sort jsonb default '{"key":"occurred_at","direction":"desc"}'::jsonb,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sort_key text := coalesce(p_sort ->> 'key', 'occurred_at');
  v_direction text := lower(coalesce(p_sort ->> 'direction', 'desc'));
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view accounting transactions';
  elsif p_from_date is null or p_to_date is null or p_to_date < p_from_date then
    raise exception 'A valid accounting date range is required';
  elsif p_to_date - p_from_date > 30 then
    raise exception 'Accounting date range cannot exceed 31 days';
  elsif p_limit < 1 or p_limit > 50000 or p_offset < 0 then
    raise exception 'Invalid accounting pagination';
  elsif v_direction not in ('asc', 'desc') then
    raise exception 'Accounting sort direction must be asc or desc';
  elsif v_sort_key not in ('occurred_at', 'service_date', 'document_number', 'type',
    'shop_name', 'holder_name', 'employee_name', 'ice_type_name', 'quantity_in',
    'quantity_out', 'sales_amount', 'cash_in', 'cash_out', 'receivable_delta',
    'status', 'can_correct') then
    raise exception 'Unsupported accounting sort key';
  end if;

  with base as materialized (
    select row.* from public.accounting_transaction_rows(p_from_date, p_to_date) row
    union all
    select row.* from public.accounting_factory_order_transaction_rows(p_from_date, p_to_date) row
  ), filtered as materialized (
    select row.* from base row
    where (nullif(trim(p_filters ->> 'document'), '') is null
      or row.document_number ilike '%' || trim(p_filters ->> 'document') || '%'
      or coalesce(row.reference_number, '') ilike '%' || trim(p_filters ->> 'document') || '%')
      and (nullif(p_filters ->> 'ice_type_id', '') is null
        or row.ice_type_id::text = p_filters ->> 'ice_type_id')
      and (nullif(p_filters ->> 'shop_id', '') is null
        or row.shop_id::text = p_filters ->> 'shop_id')
      and (nullif(p_filters ->> 'employee_id', '') is null
        or row.employee_id::text = p_filters ->> 'employee_id')
      and (coalesce((p_filters ->> 'issues_only')::boolean, false) = false or row.issue_code is not null)
      and (jsonb_typeof(p_filters -> 'types') is distinct from 'array'
        or jsonb_array_length(p_filters -> 'types') = 0
        or row.type in (select jsonb_array_elements_text(p_filters -> 'types')))
  ), ordered as (
    select row.* from filtered row
    order by
      case when v_direction = 'asc' and v_sort_key = 'occurred_at' then row.occurred_at end asc,
      case when v_direction = 'desc' and v_sort_key = 'occurred_at' then row.occurred_at end desc,
      case when v_direction = 'asc' and v_sort_key = 'service_date' then row.service_date end asc,
      case when v_direction = 'desc' and v_sort_key = 'service_date' then row.service_date end desc,
      case when v_direction = 'asc' and v_sort_key = 'document_number' then row.document_number end asc,
      case when v_direction = 'desc' and v_sort_key = 'document_number' then row.document_number end desc,
      case when v_direction = 'asc' and v_sort_key = 'type' then row.type end asc,
      case when v_direction = 'desc' and v_sort_key = 'type' then row.type end desc,
      case when v_direction = 'asc' and v_sort_key = 'shop_name' then row.shop_name end asc nulls last,
      case when v_direction = 'desc' and v_sort_key = 'shop_name' then row.shop_name end desc nulls last,
      case when v_direction = 'asc' and v_sort_key = 'holder_name' then row.holder_name end asc nulls last,
      case when v_direction = 'desc' and v_sort_key = 'holder_name' then row.holder_name end desc nulls last,
      case when v_direction = 'asc' and v_sort_key = 'employee_name' then row.employee_name end asc nulls last,
      case when v_direction = 'desc' and v_sort_key = 'employee_name' then row.employee_name end desc nulls last,
      case when v_direction = 'asc' and v_sort_key = 'ice_type_name' then row.ice_type_name end asc nulls last,
      case when v_direction = 'desc' and v_sort_key = 'ice_type_name' then row.ice_type_name end desc nulls last,
      case when v_direction = 'asc' and v_sort_key = 'quantity_in' then row.quantity_in end asc,
      case when v_direction = 'desc' and v_sort_key = 'quantity_in' then row.quantity_in end desc,
      case when v_direction = 'asc' and v_sort_key = 'quantity_out' then row.quantity_out end asc,
      case when v_direction = 'desc' and v_sort_key = 'quantity_out' then row.quantity_out end desc,
      case when v_direction = 'asc' and v_sort_key = 'sales_amount' then row.sales_amount end asc,
      case when v_direction = 'desc' and v_sort_key = 'sales_amount' then row.sales_amount end desc,
      case when v_direction = 'asc' and v_sort_key = 'cash_in' then row.cash_in end asc,
      case when v_direction = 'desc' and v_sort_key = 'cash_in' then row.cash_in end desc,
      case when v_direction = 'asc' and v_sort_key = 'cash_out' then row.cash_out end asc,
      case when v_direction = 'desc' and v_sort_key = 'cash_out' then row.cash_out end desc,
      case when v_direction = 'asc' and v_sort_key = 'receivable_delta' then row.receivable_delta end asc,
      case when v_direction = 'desc' and v_sort_key = 'receivable_delta' then row.receivable_delta end desc,
      case when v_direction = 'asc' and v_sort_key = 'status' then row.status end asc,
      case when v_direction = 'desc' and v_sort_key = 'status' then row.status end desc,
      case when v_direction = 'asc' and v_sort_key = 'can_correct' then row.can_correct end asc,
      case when v_direction = 'desc' and v_sort_key = 'can_correct' then row.can_correct end desc,
      row.occurred_at desc, row.source_id, row.ice_type_id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(row)) from ordered row), '[]'::jsonb),
    'total_count', (select count(*) from filtered),
    'facets', jsonb_build_object(
      'ice_types', coalesce((select jsonb_agg(jsonb_build_object('value', ice_type_id,
        'label', ice_type_name, 'count', count) order by ice_type_name) from (
          select ice_type_id, min(ice_type_name) ice_type_name, count(*) count from filtered
          where ice_type_id is not null group by ice_type_id) facet), '[]'::jsonb),
      'shops', coalesce((select jsonb_agg(jsonb_build_object('value', shop_id,
        'label', concat_ws(' ', shop_code, shop_name), 'count', count) order by shop_code) from (
          select shop_id, min(shop_code) shop_code, min(shop_name) shop_name, count(*) count from filtered
          where shop_id is not null group by shop_id) facet), '[]'::jsonb),
      'employees', coalesce((select jsonb_agg(jsonb_build_object('value', employee_id,
        'label', employee_name, 'count', count) order by employee_name) from (
          select employee_id, min(employee_name) employee_name, count(*) count from filtered
          where employee_id is not null group by employee_id) facet), '[]'::jsonb),
      'types', coalesce((select jsonb_agg(jsonb_build_object('value', type,
        'label', type, 'count', count) order by type) from (
          select type, count(*) count from filtered group by type) facet), '[]'::jsonb)
    )
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.accounting_factory_order_transaction_rows(date, date) from public;
revoke all on function public.accounting_factory_order_transaction_rows(date, date) from authenticated;
revoke all on function public.accounting_aggregate_reconciliation_rows(date) from public;
revoke all on function public.accounting_aggregate_reconciliation_rows(date) from authenticated;
revoke all on function public.get_accounting_reconciliation(date) from public;
revoke all on function public.get_accounting_transactions(date, date, jsonb, jsonb, integer, integer) from public;
grant execute on function public.get_accounting_reconciliation(date) to authenticated;
grant execute on function public.get_accounting_transactions(date, date, jsonb, jsonb, integer, integer) to authenticated;

notify pgrst, 'reload schema';
