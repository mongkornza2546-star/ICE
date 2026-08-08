-- Manager accounting read model. This migration is additive: every row is
-- derived from an operational source record and remains read-only.

create index if not exists payments_recorded_status_idx
  on public.payments (recorded_at desc, status);
create index if not exists delivery_charges_service_status_idx
  on public.delivery_charges (service_date, status, payment_term);
create index if not exists delivery_charge_adjustments_created_status_idx
  on public.delivery_charge_adjustments (created_at desc, status);
create index if not exists refund_obligations_created_status_idx
  on public.refund_obligations (created_at desc, status);
create index if not exists refund_settlements_settled_at_idx
  on public.refund_settlements (settled_at desc);

create function public.accounting_transaction_rows(
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
  -- Actual factory receipts, one row per product.
  select
    receipt.recorded_at, receipt.service_date, 'FACTORY', receipt.id, receipt.id,
    'factory_receipts', null::uuid, null::uuid,
    'FACTORY-' || upper(left(replace(receipt.id::text, '-', ''), 8)), null::text,
    null::uuid, null::text, null::text, truck.name, recorder.id, recorder.display_name,
    ice.id, ice.name, ice.unit, item.actual_quantity, 0::numeric,
    0::numeric, 0::numeric, 0::numeric, 0::numeric, 'recorded', receipt.note,
    case when item.variance_quantity <> 0 then 'factory_variance' end,
    case when item.variance_quantity <> 0 then 'รับจากโรงงานไม่ตรงใบสั่ง' end,
    false,
    jsonb_build_object('factory_order_id', receipt.factory_order_id,
      'expected_quantity', item.expected_quantity, 'variance_quantity', item.variance_quantity)
  from public.factory_receipts receipt
  join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
  join public.ice_types ice on ice.id = item.ice_type_id
  join public.stock_locations truck on truck.id = receipt.truck_location_id
  join public.users recorder on recorder.id = receipt.recorded_by
  where receipt.service_date between p_from_date and p_to_date

  union all

  -- Stock ledger. A direction is only asserted when the endpoint roles prove it.
  select
    movement.recorded_at, movement.service_date,
    case
      when movement.kind = 'damage' then 'DAMAGE'
      when movement.kind = 'return_to_factory' then 'RETURN'
      when source.kind = 'truck' and source.is_courier_source
        and destination.kind in ('team', 'small_vehicle') then 'WITHDRAW'
      when destination.kind = 'truck' and destination.is_courier_source
        and source.kind in ('team', 'small_vehicle', 'reserve_bin', 'front_vehicle') then 'RETURN'
      else 'TRANSFER'
    end,
    movement.id, movement.id, 'stock_movements', null::uuid, null::uuid,
    case
      when movement.kind = 'damage' then 'DAMAGE-'
      when movement.kind = 'return_to_factory' then 'RETURN-'
      else 'TRANSFER-'
    end || upper(left(replace(movement.id::text, '-', ''), 8)), null::text,
    null::uuid, null::text, null::text,
    nullif(concat_ws(' → ', source.name, destination.name), ''),
    recorder.id, recorder.display_name, ice.id, ice.name, ice.unit,
    case when movement.kind = 'transfer' then item.quantity else 0 end,
    item.quantity, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
    movement.status::text, movement.note,
    case when movement.status = 'cancelled' then 'cancelled_stock_movement' end,
    case when movement.status = 'cancelled' then 'รายการสต๊อกถูกยกเลิก' end,
    false,
    jsonb_build_object('kind', movement.kind, 'from_location_id', movement.from_location_id,
      'to_location_id', movement.to_location_id, 'original_movement_id', movement.original_movement_id,
      'replacement_movement_id', movement.replacement_movement_id,
      'idempotency_key', movement.idempotency_key)
  from public.stock_movements movement
  join public.stock_movement_items item on item.movement_id = movement.id
  join public.ice_types ice on ice.id = item.ice_type_id
  left join public.stock_locations source on source.id = movement.from_location_id
  left join public.stock_locations destination on destination.id = movement.to_location_id
  join public.users recorder on recorder.id = movement.recorded_by
  where movement.service_date between p_from_date and p_to_date
    and movement.kind <> 'factory_order'

  union all

  -- Sales documents, one row per product. Replaced documents stay visible.
  select
    event.recorded_at, charge.service_date,
    case when charge.payment_term = 'immediate' then 'SALE' else 'INV' end,
    charge.id, charge.id, 'delivery_charges', event.id, null::uuid,
    coalesce(charge.charge_number,
      case when charge.payment_term = 'immediate' then 'SALE-' else 'INV-' end
        || upper(left(replace(charge.id::text, '-', ''), 8))),
    null::text, shop.id, shop.code, shop.name, location.name,
    recorder.id, recorder.display_name, ice.id, ice.name, ice.unit,
    0::numeric, item.quantity, item.line_total, 0::numeric, 0::numeric,
    case when charge.payment_term = 'immediate' then 0::numeric else item.line_total end,
    case when charge.status = 'voided' or event.status = 'cancelled' then 'replaced' else charge.status::text end,
    event.note,
    case
      when charge.status = 'voided' or event.status = 'cancelled' then 'replaced_invoice'
      when charge.payment_term <> 'credit' and public.effective_delivery_charge_amount(charge.id)
        > coalesce(allocation.allocated_amount, 0) then 'unpaid_collectible'
      when charge.payment_term = 'credit' and charge.due_date < (now() at time zone 'Asia/Bangkok')::date
        and public.effective_delivery_charge_amount(charge.id) > coalesce(allocation.allocated_amount, 0)
        then 'overdue_credit'
    end,
    case
      when charge.status = 'voided' or event.status = 'cancelled' then 'INV ถูกแทนที่'
      when charge.payment_term <> 'credit' and public.effective_delivery_charge_amount(charge.id)
        > coalesce(allocation.allocated_amount, 0) then 'ยังรับเงินไม่ครบ'
      when charge.payment_term = 'credit' and charge.due_date < (now() at time zone 'Asia/Bangkok')::date
        and public.effective_delivery_charge_amount(charge.id) > coalesce(allocation.allocated_amount, 0)
        then 'เครดิตเลยกำหนด'
    end,
    charge.status = 'active' and event.status = 'active'
      and charge.payment_term <> 'immediate'
      and (public.current_app_role() = 'admin' or (round.status = 'open'
        and not exists (select 1 from public.daily_aggregate_stock_closures closure
          where closure.service_date = charge.service_date and closure.status = 'closed'))),
    jsonb_build_object('charge_id', charge.id, 'payment_term', charge.payment_term,
      'due_date', charge.due_date, 'original_amount', charge.original_amount,
      'effective_amount', public.effective_delivery_charge_amount(charge.id),
      'allocated_amount', coalesce(allocation.allocated_amount, 0),
      'round_id', round.id, 'round_status', round.status,
      'event_status', event.status, 'idempotency_key', event.idempotency_key)
  from public.delivery_charges charge
  join public.delivery_events event on event.id = charge.delivery_event_id
  join public.delivery_items item on item.delivery_event_id = event.id
  join public.ice_types ice on ice.id = item.ice_type_id
  join public.round_stops stop on stop.id = event.round_stop_id
  join public.delivery_rounds round on round.id = stop.round_id
  join public.shops shop on shop.id = charge.shop_id
  left join public.stock_locations location on location.id = event.source_stock_location_id
  join public.users recorder on recorder.id = event.recorded_by
  left join lateral (
    select coalesce(sum(payment_allocation.amount), 0)::numeric as allocated_amount
    from public.payment_allocations payment_allocation
    join public.payments payment on payment.id = payment_allocation.payment_id
    where payment_allocation.charge_id = charge.id and payment.status = 'active'
  ) allocation on true
  where charge.service_date between p_from_date and p_to_date

  union all

  -- One row per immutable receipt so money is never repeated for each invoice.
  select
    payment.recorded_at,
    (payment.recorded_at at time zone 'Asia/Bangkok')::date,
    'REC', payment.id, payment.id, 'payments', null::uuid, payment.id,
    coalesce(payment.receipt_number, 'REC-' || upper(left(replace(payment.id::text, '-', ''), 8))),
    payment.reference_number, shop.id, shop.code, shop.name, null::text,
    recorder.id, recorder.display_name, null::uuid, null::text, null::text,
    0::numeric, 0::numeric, 0::numeric,
    case when payment.status = 'active' then payment.allocated_amount else 0 end,
    0::numeric,
    case when payment.status = 'active' then -coalesce(receivable_allocation.amount, 0) else 0 end,
    payment.status::text, payment.void_reason,
    case
      when payment.status = 'voided' then 'voided_receipt'
      when payment.payment_method in ('bank_transfer', 'qr') and payment.evidence_path is null then 'missing_payment_evidence'
    end,
    case
      when payment.status = 'voided' then 'REC ถูก void'
      when payment.payment_method in ('bank_transfer', 'qr') and payment.evidence_path is null then 'โอน/QR ไม่มีหลักฐาน'
    end,
    jsonb_array_length(public.get_payment_correction_targets(payment.id)) > 0,
    jsonb_build_object('payment_method', payment.payment_method,
      'received_amount', payment.received_amount, 'allocated_amount', payment.allocated_amount,
      'change_amount', payment.change_amount, 'evidence_path', payment.evidence_path,
      'voided_at', payment.voided_at, 'idempotency_key', payment.idempotency_key,
      'receipt_snapshot', snapshot.receipt_data)
  from public.payments payment
  join public.shops shop on shop.id = payment.shop_id
  join public.users recorder on recorder.id = payment.recorded_by
  left join public.payment_receipt_snapshots snapshot on snapshot.payment_id = payment.id
  left join lateral (
    select sum(allocation.amount)::numeric amount
    from public.payment_allocations allocation
    join public.delivery_charges charge on charge.id = allocation.charge_id
    where allocation.payment_id = payment.id and charge.payment_term <> 'immediate'
  ) receivable_allocation on true
  where (payment.recorded_at at time zone 'Asia/Bangkok')::date between p_from_date and p_to_date

  union all

  -- Open-period revisions derive an ADJ delta while both INV documents remain
  -- visible in their original states.
  select
    revision.revised_at, original_charge.service_date, 'ADJ', revision.idempotency_key,
    revision.idempotency_key, 'delivery_event_revisions', revision.replacement_event_id,
    null::uuid, 'ADJ-' || upper(left(replace(revision.idempotency_key::text, '-', ''), 8)),
    original_charge.charge_number, shop.id, shop.code, shop.name, location.name,
    reviser.id, reviser.display_name, ice.id, ice.name, ice.unit,
    greatest(delta.original_quantity - delta.corrected_quantity, 0),
    greatest(delta.corrected_quantity - delta.original_quantity, 0),
    delta.corrected_line_total - delta.original_line_total,
    0::numeric, 0::numeric,
    case when original_charge.payment_term = 'immediate' then 0::numeric
      else delta.corrected_line_total - delta.original_line_total end,
    'active', revision.reason,
    case when exists (select 1 from public.payment_allocation_changes change
      where change.source_kind = 'open_revision' and change.source_id = revision.idempotency_key)
      then 'invoice_revised_after_payment' end,
    case when exists (select 1 from public.payment_allocation_changes change
      where change.source_kind = 'open_revision' and change.source_id = revision.idempotency_key)
      then 'แก้บิลหลังมีการรับเงิน' end,
    false,
    jsonb_build_object('action', revision.action,
      'original_event_id', revision.original_event_id,
      'replacement_event_id', revision.replacement_event_id,
      'original_charge_id', original_charge.id,
      'replacement_charge_id', replacement_charge.id,
      'original_quantity', delta.original_quantity,
      'corrected_quantity', delta.corrected_quantity)
  from public.delivery_event_revisions revision
  join public.delivery_events original_event on original_event.id = revision.original_event_id
  join public.delivery_charges original_charge on original_charge.delivery_event_id = original_event.id
  join public.shops shop on shop.id = original_charge.shop_id
  join public.users reviser on reviser.id = revision.revised_by
  left join public.stock_locations location on location.id = original_event.source_stock_location_id
  left join public.delivery_charges replacement_charge
    on replacement_charge.delivery_event_id = revision.replacement_event_id
  join lateral (
    select coalesce(original_item.ice_type_id, corrected_item.ice_type_id) ice_type_id,
      coalesce(original_item.quantity, 0)::numeric original_quantity,
      coalesce(corrected_item.quantity, 0)::numeric corrected_quantity,
      coalesce(original_item.line_total, 0)::numeric original_line_total,
      coalesce(corrected_item.line_total, 0)::numeric corrected_line_total
    from (select * from public.delivery_items item
      where item.delivery_event_id = revision.original_event_id) original_item
    full join (select * from public.delivery_items item
      where item.delivery_event_id = revision.replacement_event_id) corrected_item
      on corrected_item.ice_type_id = original_item.ice_type_id
  ) delta on true
  join public.ice_types ice on ice.id = delta.ice_type_id
  where original_charge.service_date between p_from_date and p_to_date
    and revision.action = 'correct' and revision.replacement_event_id is not null

  union all

  -- Closed-period adjustments, one row per adjusted product.
  select
    adjustment.created_at, charge.service_date, 'ADJ', adjustment.idempotency_key,
    adjustment.idempotency_key, 'delivery_charge_adjustments', charge.delivery_event_id,
    null::uuid, 'ADJ-' || upper(left(replace(adjustment.idempotency_key::text, '-', ''), 8)),
    charge.charge_number, shop.id, shop.code, shop.name, location.name,
    recorder.id, recorder.display_name, ice.id, ice.name, ice.unit,
    greatest(-item.quantity_delta, 0), greatest(item.quantity_delta, 0),
    item.quantity_delta * item.unit_price, 0::numeric, 0::numeric,
    item.quantity_delta * item.unit_price, adjustment.status::text, adjustment.reason,
    'invoice_adjusted_after_close', 'ปรับบิลหลังปิดรอบ', false,
    jsonb_build_object('charge_id', adjustment.charge_id, 'scope', adjustment.scope,
      'amount_delta', adjustment.amount_delta, 'corrected_total', adjustment.corrected_total,
      'original_quantity', item.original_quantity, 'corrected_quantity', item.corrected_quantity,
      'quantity_delta', item.quantity_delta, 'source_charge_number', charge.charge_number)
  from public.delivery_charge_adjustments adjustment
  join public.delivery_adjustment_items item on item.adjustment_id = adjustment.idempotency_key
  join public.delivery_charges charge on charge.id = adjustment.charge_id
  join public.delivery_events event on event.id = charge.delivery_event_id
  join public.ice_types ice on ice.id = item.ice_type_id
  join public.shops shop on shop.id = charge.shop_id
  left join public.stock_locations location on location.id = event.source_stock_location_id
  join public.users recorder on recorder.id = adjustment.created_by
  where charge.service_date between p_from_date and p_to_date

  union all

  -- One row per refund obligation. Cash leaves only when a settlement exists.
  select
    coalesce(settlement.settled_at, obligation.created_at),
    (coalesce(settlement.settled_at, obligation.created_at) at time zone 'Asia/Bangkok')::date,
    'REF', obligation.id, obligation.id, 'refund_obligations', charge.delivery_event_id,
    obligation.payment_id,
    'REF-' || upper(left(replace(obligation.id::text, '-', ''), 8)),
    coalesce(settlement.reference_number, charge.charge_number), shop.id, shop.code, shop.name,
    null::text, recorder.id, recorder.display_name, null::uuid, null::text, null::text,
    0::numeric, 0::numeric, 0::numeric, 0::numeric,
    case when obligation.status = 'settled' then obligation.amount else 0 end,
    0::numeric, obligation.status::text, obligation.reason,
    case when obligation.status = 'pending' then 'pending_refund' end,
    case when obligation.status = 'pending' then 'รอคืนเงิน' end,
    false,
    jsonb_build_object('source_kind', obligation.source_kind,
      'source_id', obligation.source_id, 'source_charge_id', obligation.source_charge_id,
      'settlement', case when settlement.obligation_id is null then null else
        jsonb_build_object('method', settlement.refund_method, 'settled_at', settlement.settled_at,
          'settled_by', settlement.settled_by) end)
  from public.refund_obligations obligation
  join public.delivery_charges charge on charge.id = obligation.source_charge_id
  join public.shops shop on shop.id = charge.shop_id
  join public.users recorder on recorder.id = obligation.created_by
  left join public.refund_settlements settlement on settlement.obligation_id = obligation.id
  where (coalesce(settlement.settled_at, obligation.created_at) at time zone 'Asia/Bangkok')::date
    between p_from_date and p_to_date;
$$;

create function public.get_accounting_transactions(
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

create function public.accounting_aggregate_reconciliation_rows(p_service_date date)
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
  with ice as materialized (
    select ice_type.id, ice_type.code, ice_type.name, ice_type.unit
    from public.ice_types ice_type
    where ice_type.is_active
  ), source_latest as (
    select greatest(
      coalesce((select max(recorded_at) from public.factory_receipts where service_date = p_service_date), '-infinity'),
      coalesce((select max(recorded_at) from public.stock_movements where service_date = p_service_date), '-infinity'),
      coalesce((select max(event.recorded_at) from public.delivery_events event
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
        where charge.service_date = p_service_date), '-infinity')
    ) as recorded_at
  ), aggregate_values as materialized (
    select ice.*,
      coalesce((select sum(item.actual_quantity)
        from public.factory_receipts receipt
        join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
        join public.stock_movements movement on movement.id = receipt.factory_order_id
        where receipt.service_date = p_service_date and movement.status = 'active'
          and item.ice_type_id = ice.id), 0)::numeric as factory_in,
      (coalesce((select sum(item.quantity)
        from public.delivery_events event
        join public.delivery_items item on item.delivery_event_id = event.id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date and event.status = 'active'
          and item.ice_type_id = ice.id), 0)
       + coalesce((select sum(item.quantity_delta)
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items item on item.adjustment_id = adjustment.idempotency_key
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        where charge.service_date = p_service_date and adjustment.status = 'active'
          and item.ice_type_id = ice.id), 0))::numeric as sold,
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
  select value.*,
    value.factory_in - value.sold - value.damaged - value.returned_to_factory as expected,
    case when closure.service_date is not null
      and closure.closed_at >= latest.recorded_at
      and (select count(*) from public.daily_aggregate_stock_closure_items item
        where item.service_date = p_service_date) = (select count(*) from ice)
      then closure_item.actual_quantity end as actual,
    case when closure.service_date is not null
      and closure.closed_at >= latest.recorded_at
      and (select count(*) from public.daily_aggregate_stock_closure_items item
        where item.service_date = p_service_date) = (select count(*) from ice)
      then closure_item.actual_quantity
        - (value.factory_in - value.sold - value.damaged - value.returned_to_factory) end as variance,
    case
      when closure.service_date is null or (select count(*) from public.daily_aggregate_stock_closure_items item
        where item.service_date = p_service_date) <> (select count(*) from ice) then 'incomplete'
      when closure.closed_at < latest.recorded_at then 'stale'
      else 'complete'
    end as count_status
  from aggregate_values value
  cross join source_latest latest
  left join public.daily_aggregate_stock_closures closure on closure.service_date = p_service_date
  left join public.daily_aggregate_stock_closure_items closure_item
    on closure_item.service_date = p_service_date and closure_item.ice_type_id = value.id;
$$;

create function public.get_accounting_reconciliation(p_service_date date)
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

  with ice as materialized (
    select id, code, name, unit from public.ice_types where is_active
  ), aggregate_rows as materialized (
    select * from public.accounting_aggregate_reconciliation_rows(p_service_date)
  ), locations as materialized (
    select location.* from public.stock_locations location
    where location.holds_inventory and location.is_active
  ), latest_counts as materialized (
    select distinct on (snapshot.location_id)
      snapshot.location_id, snapshot.id, snapshot.counted_at
    from public.stock_count_snapshots snapshot
    where snapshot.service_date = p_service_date
    order by snapshot.location_id, snapshot.counted_at desc, snapshot.id desc
  ), holder_rows as materialized (
    select location.id location_id, location.name location_name, location.kind::text location_kind,
      assigned.display_name employee_name, ice.id ice_type_id, ice.name ice_type_name, ice.unit,
      coalesce((select sum(item.actual_quantity) from public.factory_receipts receipt
        join public.factory_receipt_items item on item.factory_receipt_id = receipt.id
        join public.stock_movements factory_order on factory_order.id = receipt.factory_order_id
        where receipt.service_date = p_service_date and factory_order.status = 'active'
          and receipt.truck_location_id = location.id and item.ice_type_id = ice.id), 0)::numeric factory_in,
      (coalesce((select sum(item.quantity) from public.delivery_events event
        join public.delivery_items item on item.delivery_event_id = event.id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date and event.status = 'active'
          and event.source_stock_location_id = location.id and item.ice_type_id = ice.id), 0)
       + coalesce((select sum(item.quantity_delta)
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items item on item.adjustment_id = adjustment.idempotency_key
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        join public.delivery_events event on event.id = charge.delivery_event_id
        where charge.service_date = p_service_date and adjustment.status = 'active'
          and event.source_stock_location_id = location.id and item.ice_type_id = ice.id), 0))::numeric sold,
      coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'damage' and movement.from_location_id = location.id
          and item.ice_type_id = ice.id), 0)::numeric damaged,
      coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'return_to_factory' and movement.from_location_id = location.id
          and item.ice_type_id = ice.id), 0)::numeric returned_to_factory,
      (coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'transfer' and movement.to_location_id = location.id
          and item.ice_type_id = ice.id), 0)
       - coalesce((select sum(item.quantity) from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date and movement.status = 'active'
          and movement.kind = 'transfer' and movement.from_location_id = location.id
          and item.ice_type_id = ice.id), 0))::numeric transfer_net,
      count_item.actual_quantity::numeric actual_raw,
      latest_count.counted_at,
      (select count(*) from public.stock_count_snapshot_items item
        where item.snapshot_id = latest_count.id) = (select count(*) from ice) count_complete,
      greatest(
        coalesce((select max(movement.recorded_at) from public.stock_movements movement
          where movement.service_date = p_service_date
            and (movement.from_location_id = location.id or movement.to_location_id = location.id)), '-infinity'),
        coalesce((select max(event.recorded_at) from public.delivery_events event
          join public.round_stops stop on stop.id = event.round_stop_id
          join public.delivery_rounds round on round.id = stop.round_id
          where round.service_date = p_service_date and event.source_stock_location_id = location.id), '-infinity'),
        coalesce((select max(revision.revised_at)
          from public.delivery_event_revisions revision
          join public.delivery_events original_event on original_event.id = revision.original_event_id
          left join public.delivery_events replacement_event on replacement_event.id = revision.replacement_event_id
          join public.round_stops stop on stop.id = original_event.round_stop_id
          join public.delivery_rounds round on round.id = stop.round_id
          where round.service_date = p_service_date and (
            original_event.source_stock_location_id = location.id
            or replacement_event.source_stock_location_id = location.id
          )), '-infinity'),
        coalesce((select max(adjustment.created_at)
          from public.delivery_charge_adjustments adjustment
          join public.delivery_charges charge on charge.id = adjustment.charge_id
          join public.delivery_events event on event.id = charge.delivery_event_id
          where charge.service_date = p_service_date
            and event.source_stock_location_id = location.id), '-infinity')
      ) source_recorded_at
    from locations location
    cross join ice
    left join public.users assigned on assigned.id = location.assigned_user_id
    left join latest_counts latest_count on latest_count.location_id = location.id
    left join public.stock_count_snapshot_items count_item
      on count_item.snapshot_id = latest_count.id and count_item.ice_type_id = ice.id
  ), holder_json as (
    select location_id, min(location_name) location_name, min(location_kind) location_kind,
      min(employee_name) employee_name,
      jsonb_agg(jsonb_build_object(
        'ice_type_id', ice_type_id, 'ice_type_name', ice_type_name, 'unit', unit,
        'factory_in', factory_in, 'sold', sold, 'damaged', damaged,
        'returned_to_factory', returned_to_factory,
        'expected', factory_in + transfer_net - sold - damaged - returned_to_factory,
        'actual', case when count_complete and counted_at >= source_recorded_at then actual_raw end,
        'variance', case when count_complete and counted_at >= source_recorded_at then
          actual_raw - (factory_in + transfer_net - sold - damaged - returned_to_factory) end,
        'count_status', case when not coalesce(count_complete, false) then 'incomplete'
          when counted_at < source_recorded_at then 'stale' else 'complete' end
      ) order by ice_type_name) items
    from holder_rows
    group by location_id
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
      'ice_type_id', id, 'ice_type_name', name, 'unit', unit,
      'factory_in', factory_in, 'sold', sold, 'damaged', damaged,
      'returned_to_factory', returned_to_factory, 'expected', expected,
      'actual', actual, 'variance', variance, 'count_status', count_status
    ) order by code) from aggregate_rows), '[]'::jsonb),
    'holders', coalesce((select jsonb_agg(jsonb_build_object(
      'location_id', location_id, 'location_name', location_name,
      'location_kind', location_kind, 'employee_name', employee_name, 'items', items
    ) order by location_name) from holder_json), '[]'::jsonb),
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

create function public.get_accounting_review_queue(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
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
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view the accounting review queue';
  elsif p_from_date is null or p_to_date is null or p_to_date < p_from_date
    or p_to_date - p_from_date > 30 then
    raise exception 'Accounting review date range must be between 1 and 31 days';
  elsif p_limit < 1 or p_limit > 1000 or p_offset < 0 then
    raise exception 'Invalid accounting review pagination';
  end if;

  with stock_variance_issues as materialized (
    select
      'stock-variance-' || closure.service_date || '-' || item.id issue_id,
      'STOCK_VARIANCE' issue_type, 'critical' severity, closure.service_date,
      closure.closed_at occurred_at, null::text document_number, null::text shop_name,
      'สต๊อกรวมต่างยอด' title,
      item.name || ' ต่าง ' || item.variance || ' ' || item.unit description,
      item.id source_id, null::uuid delivery_event_id, null::uuid payment_id
    from public.daily_aggregate_stock_closures closure
    cross join lateral public.accounting_aggregate_reconciliation_rows(closure.service_date) item
    where closure.service_date between p_from_date and p_to_date
      and item.count_status = 'complete' and item.variance <> 0
  ), issues as materialized (
    select
      issue_id, issue_type, severity, service_date, occurred_at, document_number, shop_name,
      title, description, source_id, delivery_event_id, payment_id
    from stock_variance_issues

    union all
    select
      'unpaid-' || charge.id, 'UNPAID_CHARGE',
      case when charge.payment_term = 'credit' then 'critical' else 'warning' end,
      charge.service_date, charge.created_at, charge.charge_number, shop.name,
      case when charge.payment_term = 'credit' then 'เครดิตเลยกำหนด' else 'รับเงินไม่ครบ' end,
      'คงค้าง ' || (public.effective_delivery_charge_amount(charge.id) - coalesce(allocated.amount, 0)) || ' บาท',
      charge.id, charge.delivery_event_id, null::uuid
    from public.delivery_charges charge
    join public.shops shop on shop.id = charge.shop_id
    left join lateral (select coalesce(sum(allocation.amount), 0) amount
      from public.payment_allocations allocation join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = charge.id and payment.status = 'active') allocated on true
    where charge.service_date between p_from_date and p_to_date and charge.status = 'active'
      and public.effective_delivery_charge_amount(charge.id) > coalesce(allocated.amount, 0)
      and (charge.payment_term <> 'credit' or charge.due_date < (now() at time zone 'Asia/Bangkok')::date)

    union all
    select 'paid-change-' || paid_change.source_kind || '-' || paid_change.source_id,
      'PAID_INVOICE_REVISED', 'critical', paid_change.service_date,
      paid_change.changed_at, paid_change.charge_number, paid_change.shop_name,
      'แก้บิลหลังมีการรับเงิน', paid_change.reason,
      paid_change.source_id, paid_change.delivery_event_id, paid_change.payment_id
    from (
      select distinct on (change.source_kind, change.source_id)
        change.source_kind, change.source_id, charge.service_date, change.changed_at,
        charge.charge_number, shop.name shop_name, change.reason,
        charge.delivery_event_id, change.payment_id
      from public.payment_allocation_changes change
      join public.delivery_charges charge on charge.id = change.from_charge_id
      join public.shops shop on shop.id = charge.shop_id
      where charge.service_date between p_from_date and p_to_date
        and change.before_amount > 0
      order by change.source_kind, change.source_id, change.changed_at, change.id
    ) paid_change

    union all
    select 'refund-' || obligation.id, 'PENDING_REFUND', 'critical', charge.service_date,
      obligation.created_at, charge.charge_number, shop.name, 'รอคืนเงิน',
      obligation.amount || ' บาท · ' || obligation.reason,
      obligation.id, charge.delivery_event_id, obligation.payment_id
    from public.refund_obligations obligation
    join public.delivery_charges charge on charge.id = obligation.source_charge_id
    join public.shops shop on shop.id = charge.shop_id
    where charge.service_date between p_from_date and p_to_date and obligation.status = 'pending'

    union all
    select 'void-rec-' || payment.id, 'VOIDED_RECEIPT', 'warning',
      (payment.recorded_at at time zone 'Asia/Bangkok')::date, coalesce(payment.voided_at, payment.recorded_at),
      payment.receipt_number, shop.name, 'REC ถูก void', coalesce(payment.void_reason, 'ไม่ระบุเหตุผล'),
      payment.id, null::uuid, payment.id
    from public.payments payment join public.shops shop on shop.id = payment.shop_id
    where (payment.recorded_at at time zone 'Asia/Bangkok')::date between p_from_date and p_to_date
      and payment.status = 'voided'

    union all
    select 'replaced-inv-' || charge.id, 'REPLACED_INVOICE', 'warning', charge.service_date,
      coalesce(charge.voided_at, charge.created_at), charge.charge_number, shop.name,
      'INV ถูกแทนที่', coalesce(charge.void_reason, 'มีเอกสารใหม่แทน'),
      charge.id, charge.delivery_event_id, null::uuid
    from public.delivery_charges charge join public.shops shop on shop.id = charge.shop_id
    where charge.service_date between p_from_date and p_to_date and charge.status = 'voided'

    union all
    select 'evidence-' || payment.id, 'MISSING_PAYMENT_EVIDENCE', 'warning',
      (payment.recorded_at at time zone 'Asia/Bangkok')::date, payment.recorded_at,
      payment.receipt_number, shop.name, 'โอน/QR ไม่มีหลักฐาน',
      'ตรวจสอบเลขอ้างอิงและหลักฐานรับเงิน',
      payment.id, null::uuid, payment.id
    from public.payments payment join public.shops shop on shop.id = payment.shop_id
    where (payment.recorded_at at time zone 'Asia/Bangkok')::date between p_from_date and p_to_date
      and payment.status = 'active' and payment.payment_method in ('bank_transfer', 'qr')
      and payment.evidence_path is null
  ), filtered as materialized (
    select * from issues issue
    where nullif(trim(p_filters ->> 'document'), '') is null
      or coalesce(issue.document_number, '') ilike '%' || trim(p_filters ->> 'document') || '%'
      or coalesce(issue.shop_name, '') ilike '%' || trim(p_filters ->> 'document') || '%'
  ), page as (
    select * from filtered order by case severity when 'critical' then 0 else 1 end,
      occurred_at desc, issue_id limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(row)) from page row), '[]'::jsonb),
    'total_count', (select count(*) from filtered)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.accounting_transaction_rows(date, date) from public;
revoke all on function public.accounting_transaction_rows(date, date) from authenticated;
revoke all on function public.accounting_aggregate_reconciliation_rows(date) from public;
revoke all on function public.accounting_aggregate_reconciliation_rows(date) from authenticated;
revoke all on function public.get_accounting_reconciliation(date) from public;
revoke all on function public.get_accounting_transactions(date, date, jsonb, jsonb, integer, integer) from public;
revoke all on function public.get_accounting_review_queue(date, date, jsonb, integer, integer) from public;
grant execute on function public.get_accounting_reconciliation(date) to authenticated;
grant execute on function public.get_accounting_transactions(date, date, jsonb, jsonb, integer, integer) to authenticated;
grant execute on function public.get_accounting_review_queue(date, date, jsonb, integer, integer) to authenticated;

notify pgrst, 'reload schema';
