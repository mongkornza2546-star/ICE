-- Lead the accounting workspace with business-level shop balances while
-- retaining the immutable transaction ledger for audit work.

create index if not exists delivery_charge_adjustments_active_charge_idx
  on public.delivery_charge_adjustments (charge_id)
  where status = 'active';

create or replace function public.get_accounting_shop_summary(
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
  v_limit integer := coalesce(p_limit, 100);
  v_offset integer := coalesce(p_offset, 0);
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view accounting shop summaries';
  elsif p_from_date is null or p_to_date is null or p_to_date < p_from_date then
    raise exception 'A valid accounting date range is required';
  elsif p_to_date - p_from_date > 30 then
    raise exception 'Accounting date range cannot exceed 31 days';
  elsif v_limit < 1 or v_limit > 500 or v_offset < 0 then
    raise exception 'Invalid accounting shop summary pagination';
  elsif nullif(p_filters ->> 'payment_term', '') is not null
    and p_filters ->> 'payment_term' not in ('immediate', 'end_of_day', 'credit') then
    raise exception 'Unsupported accounting payment term';
  elsif nullif(p_filters ->> 'payment_status', '') is not null
    and p_filters ->> 'payment_status' not in ('paid', 'outstanding', 'overdue') then
    raise exception 'Unsupported accounting payment status';
  end if;

  with eligible_charges as materialized (
    select
      charge.id,
      charge.shop_id,
      charge.payment_term::text,
      coalesce(charge.due_date, charge.service_date) as effective_due_date,
      public.effective_delivery_charge_amount(charge.id)::numeric as effective_amount,
      event.recorded_by,
      event.recorded_at,
      stop.building_id_snapshot as building_id,
      stop.building_name_snapshot as building_name,
      current_shop.zone_id as current_zone_id,
      current_zone.name as current_zone_name,
      stop.floor_or_zone_snapshot as historical_zone_name
    from public.delivery_charges charge
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.shops current_shop on current_shop.id = charge.shop_id
    join public.building_zones current_zone on current_zone.id = current_shop.zone_id
    where charge.service_date between p_from_date and p_to_date
      and charge.status = 'active'
      and event.status = 'active'
      and (nullif(p_filters ->> 'payment_term', '') is null
        or charge.payment_term::text = p_filters ->> 'payment_term')
      and (nullif(p_filters ->> 'building_id', '') is null
        or stop.building_id_snapshot::text = p_filters ->> 'building_id')
      -- round_stops has no historical zone_id snapshot. Zone selection is
      -- intentionally current-shop location semantics until one exists.
      and (nullif(p_filters ->> 'zone_id', '') is null
        or current_shop.zone_id::text = p_filters ->> 'zone_id')
  ), charge_rows as materialized (
    select
      charge.id as charge_id,
      charge.shop_id,
      charge.payment_term,
      charge.effective_due_date,
      charge.effective_amount as sales_amount,
      least(charge.effective_amount, coalesce(allocation.allocated_amount, 0))::numeric
        as paid_amount,
      greatest(charge.effective_amount - coalesce(allocation.allocated_amount, 0), 0)::numeric
        as outstanding_amount,
      recorder.display_name as employee_name,
      charge.recorded_at,
      charge.building_id,
      charge.building_name,
      charge.current_zone_id,
      charge.current_zone_name,
      charge.historical_zone_name
    from eligible_charges charge
    join public.users recorder on recorder.id = charge.recorded_by
    left join lateral (
      select coalesce(sum(payment_allocation.amount), 0)::numeric as allocated_amount
      from public.payment_allocations payment_allocation
      join public.payments payment on payment.id = payment_allocation.payment_id
      where payment_allocation.charge_id = charge.id
        and payment.status = 'active'
    ) allocation on true
  ), shop_rows as materialized (
    select
      shop.id as shop_id,
      shop.code as shop_code,
      shop.name as shop_name,
      -- A shop remains one row even if it moved during the period. Its scalar
      -- location is the latest included sale; facets retain every snapshot.
      (array_agg(charge.building_id
        order by charge.recorded_at desc, charge.charge_id desc))[1] as building_id,
      (array_agg(charge.building_name
        order by charge.recorded_at desc, charge.charge_id desc))[1] as building_name,
      (array_agg(charge.current_zone_id
        order by charge.recorded_at desc, charge.charge_id desc))[1] as current_zone_id,
      (array_agg(charge.current_zone_name
        order by charge.recorded_at desc, charge.charge_id desc))[1] as current_zone_name,
      (array_agg(charge.historical_zone_name
        order by charge.recorded_at desc, charge.charge_id desc))[1] as historical_zone_name,
      case when count(distinct charge.payment_term) = 1
        then min(charge.payment_term)
        else 'mixed'
      end as payment_term,
      string_agg(distinct charge.employee_name, ', ' order by charge.employee_name) as employee_names,
      sum(charge.sales_amount)::numeric as sales_amount,
      sum(charge.paid_amount)::numeric as paid_amount,
      sum(charge.outstanding_amount)::numeric as outstanding_amount,
      sum(case
        when charge.outstanding_amount > 0
          and charge.effective_due_date < (now() at time zone 'Asia/Bangkok')::date
          then charge.outstanding_amount
        else 0
      end)::numeric as overdue_amount,
      count(*)::integer as invoice_count,
      min(charge.effective_due_date) filter (where charge.outstanding_amount > 0) as due_date,
      bool_or(charge.payment_term = 'immediate') as has_immediate,
      bool_or(charge.payment_term = 'end_of_day') as has_end_of_day,
      bool_or(charge.payment_term = 'credit') as has_credit
    from charge_rows charge
    join public.shops shop on shop.id = charge.shop_id
    group by shop.id, shop.code, shop.name
  ), filtered as materialized (
    select row.*,
      case
        when row.overdue_amount > 0 then 'overdue'
        when row.outstanding_amount > 0 then 'outstanding'
        else 'paid'
      end as payment_status
    from shop_rows row
    where (nullif(trim(p_filters ->> 'shop_search'), '') is null
        or row.shop_code ilike '%' || trim(p_filters ->> 'shop_search') || '%'
        or row.shop_name ilike '%' || trim(p_filters ->> 'shop_search') || '%')
      and (nullif(p_filters ->> 'shop_id', '') is null
        or row.shop_id::text = p_filters ->> 'shop_id')
      and (nullif(p_filters ->> 'building_id', '') is null
        or row.building_id::text = p_filters ->> 'building_id')
      and (nullif(p_filters ->> 'zone_id', '') is null
        or row.current_zone_id::text = p_filters ->> 'zone_id')
      and (nullif(p_filters ->> 'payment_term', '') is null
        or (p_filters ->> 'payment_term' = 'immediate' and row.has_immediate)
        or (p_filters ->> 'payment_term' = 'end_of_day' and row.has_end_of_day)
        or (p_filters ->> 'payment_term' = 'credit' and row.has_credit))
  ), status_filtered as materialized (
    select row.* from filtered row
    where nullif(p_filters ->> 'payment_status', '') is null
      or row.payment_status = p_filters ->> 'payment_status'
  ), ordered as (
    select row.* from status_filtered row
    order by
      case row.payment_status when 'overdue' then 1 when 'outstanding' then 2 else 3 end,
      row.overdue_amount desc,
      row.outstanding_amount desc,
      row.shop_code,
      row.shop_id
    limit v_limit offset v_offset
  ), received_in_period as (
    select coalesce(sum(case
      when nullif(p_filters ->> 'building_id', '') is null then payment.allocated_amount
      else coalesce(building_receipt.amount, 0)
    end), 0)::numeric as amount
    from public.payments payment
    join public.shops shop on shop.id = payment.shop_id
    left join lateral (
      -- Snapshot allocations never move when current payment_allocations do.
      -- Charge/event status and invoice filters must not rewrite receipt history.
      select coalesce(sum((receipt_charge.value ->> 'received_amount')::numeric), 0)::numeric
        as amount
      from public.payment_receipt_snapshots snapshot
      cross join lateral jsonb_array_elements(
        coalesce(snapshot.receipt_data -> 'charges', '[]'::jsonb)
      ) receipt_charge(value)
      join public.delivery_charges receipt_charge_record
        on receipt_charge_record.charge_number = receipt_charge.value ->> 'charge_number'
      join public.delivery_events receipt_event
        on receipt_event.id = receipt_charge_record.delivery_event_id
      join public.round_stops receipt_stop on receipt_stop.id = receipt_event.round_stop_id
      where snapshot.payment_id = payment.id
        and receipt_stop.building_id_snapshot::text = p_filters ->> 'building_id'
    ) building_receipt on nullif(p_filters ->> 'building_id', '') is not null
    where payment.status = 'active'
      and payment.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and payment.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
      and (nullif(trim(p_filters ->> 'shop_search'), '') is null
        or shop.code ilike '%' || trim(p_filters ->> 'shop_search') || '%'
        or shop.name ilike '%' || trim(p_filters ->> 'shop_search') || '%')
      and (nullif(p_filters ->> 'shop_id', '') is null
        or payment.shop_id::text = p_filters ->> 'shop_id')
      and (nullif(p_filters ->> 'zone_id', '') is null
        or shop.zone_id::text = p_filters ->> 'zone_id')
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(row) order by
      case row.payment_status when 'overdue' then 1 when 'outstanding' then 2 else 3 end,
      row.overdue_amount desc,
      row.outstanding_amount desc,
      row.shop_code,
      row.shop_id
    ) from ordered row), '[]'::jsonb),
    'total_count', (select count(*) from status_filtered),
    'totals', jsonb_build_object(
      'sales_amount', coalesce((select sum(sales_amount) from status_filtered), 0),
      'paid_amount', coalesce((select sum(paid_amount) from status_filtered), 0),
      'outstanding_amount', coalesce((select sum(outstanding_amount) from status_filtered), 0),
      'overdue_amount', coalesce((select sum(overdue_amount) from status_filtered), 0),
      'outstanding_shop_count', (select count(*) from status_filtered where outstanding_amount > 0),
      'cash_received_in_period', (select amount from received_in_period)
    ),
    'facets', jsonb_build_object(
      'shops', coalesce((select jsonb_agg(jsonb_build_object(
        'value', shop_id, 'label', concat_ws(' ', shop_code, shop_name), 'count', 1
      ) order by shop_code) from shop_rows), '[]'::jsonb),
      'buildings', coalesce((select jsonb_agg(jsonb_build_object(
        'value', building_id, 'label', building_name, 'count', shop_count
      ) order by building_name) from (
        select building_id,
          (array_agg(building_name order by recorded_at desc, charge_id desc))[1] building_name,
          count(distinct shop_id) shop_count
        from charge_rows group by building_id
      ) facet), '[]'::jsonb),
      'zones', coalesce((select jsonb_agg(jsonb_build_object(
        'value', zone_id, 'label', zone_name, 'count', shop_count
      ) order by zone_name) from (
        select row.current_zone_id as zone_id,
          min(row.current_zone_name) zone_name,
          count(*) shop_count
        from shop_rows row
        group by row.current_zone_id
      ) facet), '[]'::jsonb)
    )
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.get_accounting_shop_invoice_detail(
  p_shop_id uuid,
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
  v_limit integer := coalesce(p_limit, 100);
  v_offset integer := coalesce(p_offset, 0);
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view accounting shop invoice detail';
  elsif p_shop_id is null
    or not exists (select 1 from public.shops shop where shop.id = p_shop_id) then
    raise exception 'The shop does not exist';
  elsif p_from_date is null or p_to_date is null or p_to_date < p_from_date then
    raise exception 'A valid accounting date range is required';
  elsif p_to_date - p_from_date > 30 then
    raise exception 'Accounting date range cannot exceed 31 days';
  elsif v_limit < 1 or v_limit > 500 or v_offset < 0 then
    raise exception 'Invalid accounting shop invoice detail pagination';
  elsif nullif(p_filters ->> 'payment_term', '') is not null
    and p_filters ->> 'payment_term' not in ('immediate', 'end_of_day', 'credit') then
    raise exception 'Unsupported accounting payment term';
  end if;

  return coalesce((
    with invoice_facts as materialized (
      select
        charge.id as charge_id,
        charge.delivery_event_id,
        charge.charge_number,
        charge.service_date,
        charge.payment_term::text as payment_term,
        charge.due_date,
        coalesce(charge.due_date, charge.service_date) as effective_due_date,
        charge.original_amount,
        public.effective_delivery_charge_amount(charge.id)::numeric as total_amount,
        event.recorded_at,
        recorder.display_name as recorded_by_name,
        stop.building_id_snapshot as building_id,
        stop.building_name_snapshot as building_name,
        stop.floor_or_zone_snapshot as historical_zone_name,
        current_shop.zone_id as current_zone_id,
        current_zone.name as current_zone_name
      from public.delivery_charges charge
      join public.delivery_events event on event.id = charge.delivery_event_id
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.users recorder on recorder.id = event.recorded_by
      join public.shops current_shop on current_shop.id = charge.shop_id
      join public.building_zones current_zone on current_zone.id = current_shop.zone_id
      where charge.shop_id = p_shop_id
        and charge.service_date between p_from_date and p_to_date
        and charge.status = 'active'
        and event.status = 'active'
        and (nullif(p_filters ->> 'payment_term', '') is null
          or charge.payment_term::text = p_filters ->> 'payment_term')
        and (nullif(p_filters ->> 'building_id', '') is null
          or stop.building_id_snapshot::text = p_filters ->> 'building_id')
        and (nullif(p_filters ->> 'zone_id', '') is null
          or current_shop.zone_id::text = p_filters ->> 'zone_id')
    ), invoice_rows as materialized (
      select invoice.*,
        coalesce(active_payments.allocated_amount, 0)::numeric as allocated_amount,
        coalesce(active_payments.payments, '[]'::jsonb) as payments
      from invoice_facts invoice
      left join lateral (
        select coalesce(sum(allocation.amount), 0)::numeric as allocated_amount,
          jsonb_agg(jsonb_build_object(
            'payment_id', payment.id,
            'payment_method', payment.payment_method,
            'amount', allocation.amount,
            'recorded_at', payment.recorded_at
          ) order by payment.recorded_at, payment.id) as payments
        from public.payment_allocations allocation
        join public.payments payment
          on payment.id = allocation.payment_id and payment.status = 'active'
        where allocation.charge_id = invoice.charge_id
      ) active_payments on true
    ), page as (
      select invoice.*
      from invoice_rows invoice
      order by invoice.service_date desc, invoice.recorded_at desc, invoice.delivery_event_id desc
      limit v_limit offset v_offset
    )
    select jsonb_agg(jsonb_build_object(
      'delivery_event_id', invoice.delivery_event_id,
      'delivery_status', 'active',
      'charge_id', invoice.charge_id,
      'charge_number', invoice.charge_number,
      'charge_status', 'active',
      'service_date', invoice.service_date,
      'recorded_at', invoice.recorded_at,
      'recorded_by_name', invoice.recorded_by_name,
      'payment_term', invoice.payment_term,
      'due_date', invoice.due_date,
      'effective_due_date', invoice.effective_due_date,
      'original_amount', invoice.original_amount,
      'total_amount', invoice.total_amount,
      'allocated_amount', invoice.allocated_amount,
      'paid_amount', least(invoice.total_amount, invoice.allocated_amount),
      'outstanding_amount', greatest(invoice.total_amount - invoice.allocated_amount, 0),
      'overdue_amount', case
        when invoice.effective_due_date < (now() at time zone 'Asia/Bangkok')::date
          then greatest(invoice.total_amount - invoice.allocated_amount, 0)
        else 0
      end,
      'payment_status', case
        when invoice.total_amount <= invoice.allocated_amount then 'paid'
        when invoice.allocated_amount <= 0 then 'unpaid'
        else 'partial'
      end,
      'building_id', invoice.building_id,
      'building_name', invoice.building_name,
      'historical_zone_name', invoice.historical_zone_name,
      'current_zone_id', invoice.current_zone_id,
      'current_zone_name', invoice.current_zone_name,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'ice_type_id', item.ice_type_id,
          'name', ice.name,
          'unit', ice.unit,
          'quantity', item.quantity,
          'unit_price', item.unit_price,
          'line_total', item.line_total
        ) order by ice.code)
        from public.delivery_items item
        join public.ice_types ice on ice.id = item.ice_type_id
        where item.delivery_event_id = invoice.delivery_event_id
      ), '[]'::jsonb),
      'adjustments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', adjustment.idempotency_key,
          'scope', adjustment.scope,
          'amount_delta', adjustment.amount_delta,
          'corrected_total', adjustment.corrected_total,
          'reason', adjustment.reason,
          'created_at', adjustment.created_at,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'ice_type_id', adjustment_item.ice_type_id,
              'name', adjustment_ice.name,
              'unit', adjustment_ice.unit,
              'original_quantity', adjustment_item.original_quantity,
              'corrected_quantity', adjustment_item.corrected_quantity,
              'quantity_delta', adjustment_item.quantity_delta,
              'unit_price', adjustment_item.unit_price,
              'corrected_line_total',
                (adjustment_item.corrected_quantity * adjustment_item.unit_price)::numeric(12,2)
            ) order by adjustment_ice.code)
            from public.delivery_adjustment_items adjustment_item
            join public.ice_types adjustment_ice on adjustment_ice.id = adjustment_item.ice_type_id
            where adjustment_item.adjustment_id = adjustment.idempotency_key
          ), '[]'::jsonb)
        ) order by adjustment.created_at, adjustment.idempotency_key)
        from public.delivery_charge_adjustments adjustment
        where adjustment.charge_id = invoice.charge_id
          and adjustment.status = 'active'
      ), '[]'::jsonb),
      'payments', invoice.payments
    ) order by invoice.service_date desc, invoice.recorded_at desc, invoice.delivery_event_id desc)
    from page invoice
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_accounting_shop_summary(date, date, jsonb, integer, integer) from public;
grant execute on function public.get_accounting_shop_summary(date, date, jsonb, integer, integer) to authenticated;

revoke all on function public.get_accounting_shop_invoice_detail(uuid, date, date, jsonb, integer, integer)
  from public;
grant execute on function public.get_accounting_shop_invoice_detail(uuid, date, date, jsonb, integer, integer)
  to authenticated;

notify pgrst, 'reload schema';
