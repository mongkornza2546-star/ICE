-- Read-only, admin-only aggregates. Dates are Bangkok service dates; receipts
-- and refunds use their actual recorded/settled day instead of invoice day.
create function public.executive_report_facts(p_from date, p_to date)
returns table (
  day date, kind text, source_id uuid, shop_id uuid, label text,
  area_kind text, area_id uuid, area_name text,
  amount numeric, method text, occurred_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select charge.service_date, 'sale'::text, charge.id, charge.shop_id,
    shop.name, case when participation.event_job_id is null then 'building' else 'event' end,
    coalesce(participation.event_job_id, stop.building_id_snapshot, shop.building_id),
    coalesce(job.name, stop.building_name_snapshot, building.name, 'ไม่ระบุพื้นที่'),
    public.effective_delivery_charge_amount(charge.id), null::text,
    coalesce(event.recorded_at, rental.recorded_at, event_rental.recorded_at)
  from public.delivery_charges charge
  left join public.delivery_events event on event.id = charge.delivery_event_id
  left join public.shop_tank_rentals rental on rental.id = charge.tank_rental_id
  left join public.event_tank_register event_rental on event_rental.id = charge.event_tank_rental_id
  join public.shops shop on shop.id = charge.shop_id
  left join public.round_stops stop on stop.id = event.round_stop_id
  left join public.buildings building on building.id = coalesce(stop.building_id_snapshot, shop.building_id)
  left join public.event_settlement_contexts context on context.id = charge.event_settlement_context_id
  left join public.event_participations participation
    on participation.id = coalesce(context.event_participation_id, stop.event_participation_id)
  left join public.event_jobs job on job.id = participation.event_job_id
  where charge.status = 'active' and charge.service_date between p_from and p_to
    and (event.status = 'active' or rental.id is not null or event_rental.id is not null)
  union all
  select (payment.recorded_at at time zone 'Asia/Bangkok')::date, 'receipt', payment.id,
    payment.shop_id, shop.name, null::text, null::uuid, null::text,
    payment.allocated_amount, payment.payment_method::text, payment.recorded_at
  from public.payments payment join public.shops shop on shop.id = payment.shop_id
  where payment.status = 'active'
    and payment.recorded_at >= p_from::timestamp at time zone 'Asia/Bangkok'
    and payment.recorded_at < (p_to + 1)::timestamp at time zone 'Asia/Bangkok'
  union all
  select (settlement.settled_at at time zone 'Asia/Bangkok')::date, 'refund',
    settlement.idempotency_key, payment.shop_id, shop.name,
    null::text, null::uuid, null::text, settlement.amount,
    settlement.refund_method::text, settlement.settled_at
  from public.refund_settlements settlement
  join public.refund_obligations obligation on obligation.id = settlement.obligation_id
  join public.payments payment on payment.id = obligation.payment_id
  join public.shops shop on shop.id = payment.shop_id
  where settlement.settled_at >= p_from::timestamp at time zone 'Asia/Bangkok'
    and settlement.settled_at < (p_to + 1)::timestamp at time zone 'Asia/Bangkok'
  union all
  select casual.service_date, 'sale', casual.id, null::uuid, 'ขายหน้ารถ',
    'casual', null::uuid, 'ขายหน้ารถ', casual.sale_amount,
    casual.payment_method::text, casual.recorded_at
  from public.casual_transactions casual
  where casual.transaction_kind = 'paid' and casual.status = 'active'
    and casual.service_date between p_from and p_to
  union all
  select (casual.recorded_at at time zone 'Asia/Bangkok')::date, 'receipt',
    casual.id, null::uuid, 'ขายหน้ารถ', null::text, null::uuid, null::text,
    casual.sale_amount, casual.payment_method::text, casual.recorded_at
  from public.casual_transactions casual
  where casual.transaction_kind = 'paid'
    and casual.recorded_at >= p_from::timestamp at time zone 'Asia/Bangkok'
    and casual.recorded_at < (p_to + 1)::timestamp at time zone 'Asia/Bangkok'
  union all
  select (confirmation.confirmed_at at time zone 'Asia/Bangkok')::date,
    'refund', confirmation.transaction_id, null::uuid, 'ขายหน้ารถ',
    null::text, null::uuid, null::text, confirmation.refunded_amount,
    confirmation.refund_method::text, confirmation.confirmed_at
  from public.casual_refund_confirmations confirmation
  where confirmation.confirmed_at >= p_from::timestamp at time zone 'Asia/Bangkok'
    and confirmation.confirmed_at < (p_to + 1)::timestamp at time zone 'Asia/Bangkok';
$$;
-- Migration 0040 also grants authenticated EXECUTE directly by default.
revoke all on function public.executive_report_facts(date, date) from public, anon, authenticated;

create function public.get_executive_report(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  v_previous_from date;
  v_previous_to date;
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can view executive reports';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to > v_today
    or p_to - p_from > 365 then
    raise exception 'Choose a valid date range of at most 366 days';
  end if;
  v_previous_to := p_from - 1;
  v_previous_from := p_from - (p_to - p_from + 1);

  with facts as materialized (
    select * from public.executive_report_facts(v_previous_from, p_to)
  ), period as materialized (
    select * from facts where day between p_from and p_to
  ), current_totals as (
    select coalesce(sum(amount) filter (where kind = 'sale'), 0) as sales,
      coalesce(sum(amount) filter (where kind = 'receipt'), 0) as receipts,
      coalesce(sum(amount) filter (where kind = 'refund'), 0) as refunds
    from period
  ), previous_totals as (
    select coalesce(sum(amount) filter (where kind = 'sale'), 0) as sales,
      coalesce(sum(amount) filter (where kind = 'receipt'), 0) as receipts,
      coalesce(sum(amount) filter (where kind = 'refund'), 0) as refunds
    from facts where day between v_previous_from and v_previous_to
  ), charge_balances as materialized (
    select charge.shop_id, greatest(0,
      public.effective_delivery_charge_amount(charge.id) - coalesce((
        select sum(allocation.amount) from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id and payment.status = 'active'
      ), 0)) as outstanding,
      coalesce(charge.due_date, charge.service_date) < v_today as overdue
    from public.delivery_charges charge
    left join public.delivery_events event on event.id = charge.delivery_event_id
    where charge.status = 'active'
      and (event.status = 'active' or charge.tank_rental_id is not null or charge.event_tank_rental_id is not null)
  ), debt as (
    select coalesce(sum(outstanding), 0) as outstanding,
      coalesce(sum(outstanding) filter (where overdue), 0) as overdue,
      count(distinct shop_id) filter (where outstanding > 0) as debtors
    from charge_balances
  ), trend_keys as (
    select generate_series(
      date_trunc(case when p_to - p_from > 30 then 'month' else 'day' end, p_from::timestamp),
      date_trunc(case when p_to - p_from > 30 then 'month' else 'day' end, p_to::timestamp),
      case when p_to - p_from > 30 then interval '1 month' else interval '1 day' end
    )::date as bucket
  ), trend as (
    select trend_keys.bucket,
      coalesce(sum(period.amount) filter (where period.kind = 'sale'), 0) as sales,
      coalesce(sum(period.amount) filter (where period.kind = 'receipt'), 0) as receipts,
      coalesce(sum(period.amount) filter (where period.kind = 'refund'), 0) as refunds
    from trend_keys left join period on
      date_trunc(case when p_to - p_from > 30 then 'month' else 'day' end,
        period.day::timestamp)::date = trend_keys.bucket
    group by trend_keys.bucket
  ), areas as (
    select area_kind, area_id, area_name, sum(amount) as sales
    from period where kind = 'sale'
    group by area_kind, area_id, area_name
  ), shops as (
    select shop_id, label, sum(amount) as sales from period
    where kind = 'sale' and shop_id is not null
    group by shop_id, label order by sales desc limit 10
  ), loose_quantities as materialized (
    -- The stock projection rounds per day, holding location and ice type.
    select bucket.ice_type_id, sum(bucket.quantity) as quantity
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') day(service_date)
    cross join lateral public.casual_loose_stock_totals(day.service_date::date) bucket
    group by bucket.ice_type_id
  ), products as (
    select ice.id, ice.name, ice.unit,
      coalesce((select sum(item.quantity) from public.delivery_items item
        join public.delivery_events event on event.id = item.delivery_event_id
        join public.delivery_charges charge on charge.delivery_event_id = event.id
        where item.ice_type_id = ice.id and charge.status = 'active'
          and event.status = 'active' and charge.service_date between p_from and p_to), 0)
      + coalesce((select sum(item.quantity_delta) from public.delivery_adjustment_items item
        join public.delivery_charge_adjustments adjustment on adjustment.idempotency_key = item.adjustment_id
        join public.delivery_charges charge on charge.id = adjustment.charge_id
        where item.ice_type_id = ice.id and adjustment.status = 'active'
          and charge.status = 'active' and charge.service_date between p_from and p_to), 0)
      + coalesce((select sum(casual.quantity) from public.casual_transactions casual
        where casual.ice_type_id = ice.id and casual.transaction_kind = 'paid'
          and casual.status = 'active' and casual.service_date between p_from and p_to), 0)
      + coalesce((select quantity from loose_quantities where ice_type_id = ice.id), 0) as delivered,
      coalesce((select sum(item.quantity) from public.stock_movement_items item
        join public.stock_movements movement on movement.id = item.movement_id
        where item.ice_type_id = ice.id and movement.kind = 'damage'
          and movement.status = 'active' and movement.service_date between p_from and p_to), 0) as damaged
    from public.ice_types ice
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'asOf', now(),
    'previousFrom', v_previous_from, 'previousTo', v_previous_to,
    'sales', current_totals.sales, 'receipts', current_totals.receipts,
    'refunds', current_totals.refunds, 'netReceipts', current_totals.receipts - current_totals.refunds,
    'previousSales', previous_totals.sales,
    'previousNetReceipts', previous_totals.receipts - previous_totals.refunds,
    'outstanding', debt.outstanding, 'overdue', debt.overdue, 'debtors', debt.debtors,
    'deliveryCount', (select count(*) from public.delivery_charges charge
      join public.delivery_events event on event.id = charge.delivery_event_id
      where charge.status = 'active' and event.status = 'active'
        and charge.service_date between p_from and p_to),
    'trend', coalesce((select jsonb_agg(jsonb_build_object('date', bucket,
      'sales', sales, 'receipts', receipts, 'refunds', refunds) order by bucket) from trend), '[]'::jsonb),
    'areas', coalesce((select jsonb_agg(jsonb_build_object('kind', area_kind,
      'id', area_id, 'name', area_name, 'sales', sales) order by sales desc) from areas), '[]'::jsonb),
    'shops', coalesce((select jsonb_agg(jsonb_build_object('id', shop_id,
      'name', label, 'sales', sales) order by sales desc) from shops), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', id,
      'name', name, 'unit', unit, 'delivered', delivered, 'damaged', damaged)
      order by name) from products where delivered <> 0 or damaged <> 0), '[]'::jsonb)
  ) into v_result from current_totals, previous_totals, debt;
  return v_result;
end;
$$;
revoke all on function public.get_executive_report(date, date) from public;
grant execute on function public.get_executive_report(date, date) to authenticated;

create function public.get_executive_report_details(
  p_from date, p_to date, p_metric text, p_limit integer default 50,
  p_offset integer default 0, p_bucket date default null,
  p_area_kind text default null, p_area_id uuid default null,
  p_shop_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can view executive report details';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to > v_today
    or p_to - p_from > 365 or p_metric not in ('sales', 'receipts', 'refunds', 'debt', 'overdue')
    or p_limit not between 1 and 100 or p_offset < 0 then
    raise exception 'Invalid executive report detail request';
  end if;

  if p_metric in ('debt', 'overdue') then
    with balances as materialized (
      select charge.id, charge.service_date as day, charge.shop_id, shop.name as label,
        greatest(0, public.effective_delivery_charge_amount(charge.id) - coalesce((
          select sum(allocation.amount) from public.payment_allocations allocation
          join public.payments payment on payment.id = allocation.payment_id
          where allocation.charge_id = charge.id and payment.status = 'active'
        ), 0)) as amount, coalesce(charge.due_date, charge.service_date) as due_date
      from public.delivery_charges charge
      left join public.delivery_events event on event.id = charge.delivery_event_id
      join public.shops shop on shop.id = charge.shop_id
      where charge.status = 'active'
        and (event.status = 'active' or charge.tank_rental_id is not null or charge.event_tank_rental_id is not null)
        and (p_shop_id is null or charge.shop_id = p_shop_id)
    ), filtered as (
      select * from balances where amount > 0
        and (p_metric = 'debt' or due_date < v_today)
    ), display_rows as (
      select shop_id as id, min(day) as day, shop_id, label,
        sum(amount) as amount, min(due_date) as due_date
      from filtered where p_shop_id is null
      group by shop_id, label
      union all
      select id, day, shop_id, label, amount, due_date
      from filtered where p_shop_id is not null
    )
    select jsonb_build_object('total', (select count(*) from display_rows),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'day', day,
        'label', label, 'amount', amount, 'dueDate', due_date, 'shopId', shop_id)
        order by amount desc, day, id) from (select * from display_rows
          order by amount desc, day, id limit p_limit offset p_offset) page), '[]'::jsonb))
    into v_result;
  else
    with filtered as materialized (
      select * from public.executive_report_facts(p_from, p_to) fact
      where fact.kind = case p_metric when 'sales' then 'sale'
        when 'receipts' then 'receipt' else 'refund' end
        and (p_bucket is null or date_trunc(case when p_to - p_from > 30 then 'month' else 'day' end,
          fact.day::timestamp)::date = p_bucket)
        and (p_area_kind is null or (fact.area_kind = p_area_kind
          and fact.area_id is not distinct from p_area_id))
        and (p_shop_id is null or fact.shop_id = p_shop_id)
    )
    select jsonb_build_object('total', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('id', source_id,
        'day', day, 'label', label, 'amount', amount, 'method', method,
        'area', area_name, 'shopId', shop_id) order by occurred_at desc, source_id)
        from (select * from filtered order by occurred_at desc, source_id
          limit p_limit offset p_offset) page), '[]'::jsonb))
    into v_result;
  end if;
  return v_result;
end;
$$;
revoke all on function public.get_executive_report_details(date, date, text, integer, integer, date, text, uuid, uuid) from public;
grant execute on function public.get_executive_report_details(date, date, text, integer, integer, date, text, uuid, uuid) to authenticated;

create function public.get_executive_report_invoice(p_charge_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can view executive report invoices';
  end if;
  select jsonb_build_object(
    'number', charge.charge_number, 'shop', shop.name,
    'serviceDate', charge.service_date,
    'area', coalesce(job.name, rental.shop_location_snapshot, stop.building_name_snapshot, 'ไม่ระบุพื้นที่'),
    'dueDate', coalesce(charge.due_date, charge.service_date),
    'total', public.effective_delivery_charge_amount(charge.id),
    'paid', coalesce((select sum(allocation.amount) from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = charge.id and payment.status = 'active'), 0),
    'items', case when charge.delivery_event_id is null then public.charge_line_items(charge.id)
      else coalesce((select jsonb_agg(jsonb_build_object(
      'name', ice.name, 'unit', ice.unit,
      'quantity', coalesce(item.quantity, 0) + coalesce((select sum(adjusted.quantity_delta)
        from public.delivery_adjustment_items adjusted
        join public.delivery_charge_adjustments adjustment
          on adjustment.idempotency_key = adjusted.adjustment_id
        where adjustment.charge_id = charge.id and adjustment.status = 'active'
          and adjusted.ice_type_id = ice.id), 0)) order by ice.name)
      from public.ice_types ice
      left join public.delivery_items item
        on item.delivery_event_id = event.id and item.ice_type_id = ice.id
      where item.ice_type_id is not null or exists (
        select 1 from public.delivery_adjustment_items adjusted
        join public.delivery_charge_adjustments adjustment
          on adjustment.idempotency_key = adjusted.adjustment_id
        where adjustment.charge_id = charge.id and adjustment.status = 'active'
          and adjusted.ice_type_id = ice.id)), '[]'::jsonb) end,
    'payments', coalesce((select jsonb_agg(jsonb_build_object('date', payment.recorded_at,
      'method', payment.payment_method, 'amount', allocation.amount)
      order by payment.recorded_at, payment.id)
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = charge.id and payment.status = 'active'), '[]'::jsonb)
  ) into v_result
  from public.delivery_charges charge
  left join public.delivery_events event on event.id = charge.delivery_event_id
  left join public.shop_tank_rentals rental on rental.id = charge.tank_rental_id
  join public.shops shop on shop.id = charge.shop_id
  left join public.round_stops stop on stop.id = event.round_stop_id
  left join public.event_settlement_contexts context on context.id = charge.event_settlement_context_id
  left join public.event_participations participation
    on participation.id = coalesce(context.event_participation_id, stop.event_participation_id)
  left join public.event_jobs job on job.id = participation.event_job_id
  where charge.id = p_charge_id and charge.status = 'active'
    and (event.status = 'active' or charge.tank_rental_id is not null or charge.event_tank_rental_id is not null);
  return v_result;
end;
$$;
revoke all on function public.get_executive_report_invoice(uuid) from public;
grant execute on function public.get_executive_report_invoice(uuid) to authenticated;
notify pgrst, 'reload schema';
