-- Add daily tank handoffs and split received money into cash and transfer/QR.
-- Preserve the existing sales, invoice counts and statuses so the matrix stays
-- consistent with the shop summary, invoice detail and Excel export validation.

alter function public.get_accounting_shop_daily_matrix(date, date, uuid[])
  rename to get_accounting_shop_daily_matrix_before_tank_payment_split;

create function public.get_accounting_shop_daily_matrix(
  p_from_date date,
  p_to_date date,
  p_shop_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with base as materialized (
    -- The previous reader remains the single permission and input-validation gate.
    select public.get_accounting_shop_daily_matrix_before_tank_payment_split(
      p_from_date, p_to_date, p_shop_ids
    ) as result
  ), daily_payments as materialized (
    select payment.shop_id,
      (payment.recorded_at at time zone 'Asia/Bangkok')::date as service_date,
      coalesce(sum(payment.allocated_amount) filter (where payment.payment_method = 'cash'), 0)::numeric(12,2) as cash_received,
      coalesce(sum(payment.allocated_amount) filter (where payment.payment_method in ('bank_transfer', 'qr')), 0)::numeric(12,2) as transfer_received
    from public.payments payment
    where payment.shop_id = any(coalesce(p_shop_ids, '{}'::uuid[]))
      and payment.status = 'active'
      and payment.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and payment.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
    group by payment.shop_id, (payment.recorded_at at time zone 'Asia/Bangkok')::date
  ), tank_activity as materialized (
    select tank.shop_id, tank.rented_at as service_date, count(*)::numeric as quantity
    from public.shop_rented_tanks tank
    where tank.shop_id = any(coalesce(p_shop_ids, '{}'::uuid[]))
      and tank.rented_at between p_from_date and p_to_date
    group by tank.shop_id, tank.rented_at

    union all

    select rental.shop_id, rental.handed_out_on, sum(rental.quantity)::numeric
    from public.shop_tank_rentals rental
    where rental.shop_id = any(coalesce(p_shop_ids, '{}'::uuid[]))
      and rental.handed_out_on between p_from_date and p_to_date
    group by rental.shop_id, rental.handed_out_on

    union all

    -- Physical handoff dates can precede the event rental invoice date.
    select participation.shop_id, movement.service_date, sum(movement.quantity)::numeric
    from public.event_tank_register movement
    join public.event_participations participation
      on participation.id = movement.event_participation_id
    where participation.shop_id = any(coalesce(p_shop_ids, '{}'::uuid[]))
      and movement.movement_kind = 'handoff'
      and movement.service_date between p_from_date and p_to_date
    group by participation.shop_id, movement.service_date
  ), daily_tanks as materialized (
    select activity.shop_id, activity.service_date,
      sum(activity.quantity)::numeric as tank_quantity
    from tank_activity activity
    group by activity.shop_id, activity.service_date
  ), rebuilt_rows as materialized (
    select coalesce(jsonb_agg(
    jsonb_set(shop_row, '{days}', coalesce((
      select jsonb_agg(
        day.value || jsonb_build_object(
          'tank_quantity', coalesce(tank.tank_quantity, 0),
          'cash_received', coalesce(payment.cash_received, 0),
          'transfer_received', coalesce(payment.transfer_received, 0)
        ) order by day.ordinality)
      from jsonb_array_elements(shop_row->'days') with ordinality day(value, ordinality)
      left join daily_payments payment
        on payment.shop_id = (shop_row->>'shop_id')::uuid
        and payment.service_date = (day.value->>'service_date')::date
      left join daily_tanks tank
        on tank.shop_id = (shop_row->>'shop_id')::uuid
        and tank.service_date = (day.value->>'service_date')::date
    ), '[]'::jsonb)) order by shop_position.ordinality
    ), '[]'::jsonb) as rows
    from base
    cross join lateral jsonb_array_elements(base.result->'rows')
      with ordinality shop_position(shop_row, ordinality)
  ), casual_receipts as materialized (
    select (transaction.recorded_at at time zone 'Asia/Bangkok')::date as service_date,
      coalesce(sum(transaction.sale_amount) filter (where transaction.payment_method = 'cash'), 0)::numeric(12,2) as cash_received,
      coalesce(sum(transaction.sale_amount) filter (where transaction.payment_method in ('bank_transfer', 'qr')), 0)::numeric(12,2) as transfer_received
    from public.casual_transactions transaction
    where transaction.transaction_kind = 'paid'
      and transaction.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and transaction.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
    group by (transaction.recorded_at at time zone 'Asia/Bangkok')::date
  ), casual_refunds as materialized (
    select (confirmation.confirmed_at at time zone 'Asia/Bangkok')::date as service_date,
      coalesce(sum(confirmation.refunded_amount) filter (where confirmation.refund_method = 'cash'), 0)::numeric(12,2) as cash_refunded,
      coalesce(sum(confirmation.refunded_amount) filter (where confirmation.refund_method in ('bank_transfer', 'qr')), 0)::numeric(12,2) as transfer_refunded
    from public.casual_refund_confirmations confirmation
    where confirmation.confirmed_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and confirmation.confirmed_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
    group by (confirmation.confirmed_at at time zone 'Asia/Bangkok')::date
  ), rebuilt_casual_days as materialized (
    select coalesce(jsonb_agg(
      day.value || jsonb_build_object(
        'cash_received', coalesce(receipt.cash_received, 0),
        'transfer_received', coalesce(receipt.transfer_received, 0),
        'cash_refunded', coalesce(refund.cash_refunded, 0),
        'transfer_refunded', coalesce(refund.transfer_refunded, 0)
      ) order by day.ordinality
    ), '[]'::jsonb) as days
    from base
    cross join lateral jsonb_array_elements(coalesce(base.result->'casual_days', '[]'::jsonb))
      with ordinality day(value, ordinality)
    left join casual_receipts receipt
      on receipt.service_date = (day.value->>'service_date')::date
    left join casual_refunds refund
      on refund.service_date = (day.value->>'service_date')::date
  )
  select jsonb_set(
    jsonb_set(base.result, '{rows}', rebuilt_rows.rows),
    '{casual_days}', rebuilt_casual_days.days
  )
  from base cross join rebuilt_rows cross join rebuilt_casual_days;
$$;

revoke all on function public.get_accounting_shop_daily_matrix_before_tank_payment_split(date, date, uuid[])
  from public, anon, authenticated;
revoke all on function public.get_accounting_shop_daily_matrix(date, date, uuid[])
  from public, anon;
grant execute on function public.get_accounting_shop_daily_matrix(date, date, uuid[])
  to authenticated;

notify pgrst, 'reload schema';
