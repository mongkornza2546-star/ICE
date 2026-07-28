-- Keep the employee collection queue scoped to the current business day while
-- preserving the broader recovery queue for manager financial operations.
create or replace function public.get_today_collection_run_queue(
  p_collection_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  select run.service_date
  into v_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id
    and run.status = 'open'
    and (
      public.current_app_role() in ('admin', 'round_lead')
      or public.is_collection_run_member(run.id)
    );

  if v_service_date is null then
    raise exception 'The collection run does not exist, is closed, or is not assigned to this user';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', queue.shop_id,
      'shop_code', queue.shop_code,
      'shop_name', queue.shop_name,
      'outstanding_amount', queue.outstanding_amount,
      'charge_count', queue.charge_count,
      'latest_charge_at', queue.latest_charge_at,
      'latest_payment_at', queue.latest_payment_at,
      'has_new_charges', queue.latest_payment_at is not null
        and queue.latest_charge_at > queue.latest_payment_at,
      'payment_profile', queue.payment_profile,
      'charges', queue.charges
    ) order by queue.shop_code)
    from (
      select
        shop.id as shop_id,
        shop.code as shop_code,
        shop.name as shop_name,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        count(*)::integer as charge_count,
        max(charge.created_at) as latest_charge_at,
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
        (
          select max(payment.recorded_at)
          from public.payments payment
          where payment.shop_id = shop.id
            and payment.collection_run_id = p_collection_run_id
            and payment.status = 'active'
        ) as latest_payment_at,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id,
          'delivery_event_id', charge.delivery_event_id,
          'service_date', charge.service_date,
          'payment_term', charge.payment_term,
          'original_amount', charge.original_amount,
          'outstanding_amount', balance.outstanding_amount,
          'created_at', charge.created_at
        ) order by charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      join public.shops shop on shop.id = charge.shop_id
      join public.shop_payment_profiles profile on profile.shop_id = shop.id
      join lateral (
        select greatest(charge.original_amount - coalesce(sum(allocation.amount)
          filter (where payment.status = 'active'), 0), 0)::numeric(12,2) as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where charge.service_date = v_service_date
        and charge.payment_term in ('immediate', 'end_of_day')
        and charge.status = 'active'
        and balance.outstanding_amount > 0
      group by shop.id, profile.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_daily_stock_refill_history(
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
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view refill history';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', usage.id,
      'service_date', usage.service_date,
      'status', usage.status,
      'note', usage.note,
      'recorded_at', usage.recorded_at,
      'recorded_by', recorded_by.display_name,
      'cancelled_at', usage.cancelled_at,
      'cancelled_by', cancelled_by.display_name,
      'cancellation_reason', usage.cancellation_reason,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'ice_type_id', item.ice_type_id,
          'ice_type_name', ice.name,
          'unit', ice.unit,
          'quantity', item.quantity
        ) order by ice.code)
        from public.daily_stock_use_items item
        join public.ice_types ice on ice.id = item.ice_type_id
        where item.use_id = usage.id
      ), '[]'::jsonb)
    ) order by usage.recorded_at desc, usage.id)
    from public.daily_stock_uses usage
    join public.users recorded_by on recorded_by.id = usage.recorded_by
    left join public.users cancelled_by on cancelled_by.id = usage.cancelled_by
    where usage.service_date = v_service_date
      and usage.kind = 'refill'
  ), '[]'::jsonb);
end;
$$;

do $courier_collection_scope_patch$
declare
  v_function regprocedure;
  v_definition text;
  v_recovery_scope constant text :=
    $fragment$        or charge.status is distinct from 'active'
        or charge.payment_term not in ('immediate', 'end_of_day')$fragment$;
  v_legacy_scope constant text :=
    $fragment$        or charge.status is distinct from 'active'
        or charge.service_date is distinct from v_collection_service_date
        or charge.payment_term is distinct from 'end_of_day'$fragment$;
  v_new_scope constant text :=
    $fragment$        or charge.status is distinct from 'active'
        or (
          public.current_app_role() = 'courier'
          and charge.service_date is distinct from v_collection_service_date
        )
        or charge.payment_term not in ('immediate', 'end_of_day')$fragment$;
  v_old_queue_access constant text :=
    $fragment$  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;$fragment$;
  v_new_queue_access constant text :=
    $fragment$  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view recovery collection balances';
  end if;$fragment$;
begin
  v_function :=
    'public.record_payment(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_recovery_scope) > 0 then
    v_definition := replace(v_definition, v_recovery_scope, v_new_scope);
    execute v_definition;
  elsif strpos(v_definition, v_legacy_scope) > 0 then
    v_definition := replace(v_definition, v_legacy_scope, v_new_scope);
    execute v_definition;
  elsif strpos(v_definition, v_new_scope) = 0 then
    raise exception 'record_payment does not contain a recognized collection scope';
  end if;

  v_function := 'public.get_collection_run_queue(uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_old_queue_access) > 0 then
    v_definition := replace(v_definition, v_old_queue_access, v_new_queue_access);
    execute v_definition;
  elsif strpos(v_definition, v_new_queue_access) = 0 then
    raise exception 'get_collection_run_queue does not contain a recognized recovery access check';
  end if;
end;
$courier_collection_scope_patch$;

revoke all on function public.get_today_collection_run_queue(uuid) from public;
grant execute on function public.get_today_collection_run_queue(uuid) to authenticated;
revoke all on function public.get_daily_stock_refill_history(date) from public;
grant execute on function public.get_daily_stock_refill_history(date) to authenticated;

notify pgrst, 'reload schema';
