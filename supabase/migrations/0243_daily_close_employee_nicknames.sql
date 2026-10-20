-- Include nicknames for cash cards while preserving full names for other consumers.
create or replace function public.get_daily_close_reconciliation(
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date := coalesce(
    p_service_date,
    (clock_timestamp() at time zone 'Asia/Bangkok')::date
  );
  v_stock jsonb;
  v_employees jsonb;
  v_enabled_from date;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view daily close reconciliation';
  end if;

  select configuration.enabled_from_service_date into v_enabled_from
  from public.daily_close_reconciliation_configuration configuration
  where configuration.singleton;

  v_stock := public.get_daily_aggregate_stock_summary(v_service_date);

  with cash_sources as materialized (
    select * from public.daily_close_cash_sources(v_service_date)
  ), reconciliation_state as materialized (
    select exists (
      select 1
      from public.daily_close_reconciliation_requests request
      where request.service_date = v_service_date
    ) is_closed
  ), eligible_employees as materialized (
    select app_user.id, app_user.display_name, app_user.nickname, app_user.is_active
    from public.users app_user
    cross join reconciliation_state state
    where not state.is_closed
      and app_user.role in ('courier', 'admin', 'round_lead') and app_user.is_active
    union
    select app_user.id, app_user.display_name, app_user.nickname, app_user.is_active
    from cash_sources payment
    join public.users app_user on app_user.id = payment.employee_id
    cross join reconciliation_state state
    where not state.is_closed
    union
    select app_user.id, app_user.display_name, app_user.nickname, app_user.is_active
    from public.daily_close_employee_snapshots snapshot
    join public.users app_user on app_user.id = snapshot.employee_id
    where snapshot.service_date = v_service_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'employee_id', employee.id,
    'employee_name', employee.display_name,
    'employee_nickname', nullif(btrim(employee.nickname), ''),
    'is_active', employee.is_active,
    'expected_cash_amount', coalesce(snapshot.expected_cash_amount, live.expected_cash_amount, 0),
    'actual_cash_amount', snapshot.actual_cash_amount,
    'cash_variance_amount', snapshot.cash_variance_amount,
    'cash_reason', snapshot.cash_reason,
    'payment_ids', coalesce(snapshot_payments.payment_ids, live.payment_ids, '[]'::jsonb),
    'cash_source_count', case when snapshot.employee_id is not null then
      jsonb_array_length(snapshot_payments.payment_ids) + (
        select count(*) from public.daily_close_casual_cash_items item
        where item.service_date = v_service_date and item.employee_id = employee.id
      ) + (
        select count(*) from public.daily_close_refund_cash_items item
        where item.service_date = v_service_date and item.employee_id = employee.id
      ) else live.cash_source_count end,
    'recorded_by', snapshot.recorded_by,
    'recorded_at', snapshot.recorded_at
  ) order by employee.display_name, employee.id), '[]'::jsonb)
  into v_employees
  from eligible_employees employee
  left join public.daily_close_employee_snapshots snapshot
    on snapshot.service_date = v_service_date and snapshot.employee_id = employee.id
  left join lateral (
    select
      count(*) cash_source_count,
      coalesce(sum(payment.cash_amount), 0)::numeric(12,2) expected_cash_amount,
      coalesce(jsonb_agg(payment.source_id order by payment.source_id)
        filter (where payment.source_kind = 'payment'), '[]'::jsonb) payment_ids
    from cash_sources payment
    where payment.employee_id = employee.id
  ) live on true
  left join lateral (
    select coalesce(jsonb_agg(item.payment_id order by item.payment_id), '[]'::jsonb) payment_ids
    from public.daily_close_payment_items item
    where item.service_date = v_service_date and item.employee_id = employee.id
  ) snapshot_payments on snapshot.employee_id is not null;

  return jsonb_build_object(
    'service_date', v_service_date,
    'status', v_stock ->> 'status',
    'feature_enabled', v_enabled_from is not null and v_service_date >= v_enabled_from,
    'enabled_from_service_date', v_enabled_from,
    'stock', v_stock,
    'employees', v_employees
  );
end;
$$;
