-- Let assigned collectors settle a shop's full immediate/end-of-day balance,
-- including unpaid charges from earlier service dates and new charges from today.

create or replace function public.get_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  if not exists (
    select 1
    from public.collection_runs run
    where run.id = p_collection_run_id
      and run.status = 'open'
      and (
        public.current_app_role() in ('admin', 'round_lead')
        or public.is_collection_run_member(run.id)
      )
  ) then
    raise exception 'The collection run does not exist, is closed, or is not assigned to this user';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', queue.shop_id,
      'shop_code', queue.shop_code,
      'shop_name', queue.shop_name,
      'image_path', queue.image_path,
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
        shop.image_path,
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
          'charge_number', charge.charge_number,
          'delivery_event_id', charge.delivery_event_id,
          'service_date', charge.service_date,
          'payment_term', charge.payment_term,
          'original_amount', charge.original_amount,
          'outstanding_amount', balance.outstanding_amount,
          'created_at', charge.created_at
        ) order by charge.service_date, charge.created_at, charge.id) as charges
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
      where charge.payment_term in ('immediate', 'end_of_day')
        and charge.status = 'active'
        and balance.outstanding_amount > 0
      group by shop.id, profile.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

-- Preserve the old RPC name for deployed clients while keeping one queue query.
create or replace function public.get_today_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.get_collection_run_queue(p_collection_run_id);
$$;

do $collector_carry_forward_payment_scope$
declare
  v_function regprocedure;
  v_definition text;
  v_current_day_scope constant text :=
    $fragment$        or charge.status is distinct from 'active'
        or (
          public.current_app_role() = 'courier'
          and charge.service_date is distinct from v_collection_service_date
        )
        or charge.payment_term not in ('immediate', 'end_of_day')$fragment$;
  v_all_dates_scope constant text :=
    $fragment$        or charge.status is distinct from 'active'
        or charge.payment_term not in ('immediate', 'end_of_day')$fragment$;
  v_allocated_charges_outstanding constant text :=
    $fragment$  where charge.shop_id = p_shop_id
    and charge.status = 'active'
    and exists (
      select 1
      from jsonb_to_recordset(p_allocations) as requested(charge_id uuid, amount numeric)
      where requested.charge_id = charge.id
    );$fragment$;
  v_collection_scope_outstanding constant text :=
    $fragment$  where charge.shop_id = p_shop_id
    and charge.status = 'active'
    and (
      (
        p_collection_run_id is not null
        and charge.payment_term in ('immediate', 'end_of_day')
      )
      or (
        p_collection_run_id is null
        and exists (
          select 1
          from jsonb_to_recordset(p_allocations) as requested(charge_id uuid, amount numeric)
          where requested.charge_id = charge.id
        )
      )
    );$fragment$;
begin
  v_function :=
    'public.record_payment(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;

  if strpos(v_definition, v_current_day_scope) > 0 then
    v_definition := replace(v_definition, v_current_day_scope, v_all_dates_scope);
  elsif strpos(v_definition, v_all_dates_scope) = 0 then
    raise exception 'record_payment does not contain a recognized collection scope';
  end if;

  if strpos(v_definition, v_allocated_charges_outstanding) > 0 then
    v_definition := replace(
      v_definition,
      v_allocated_charges_outstanding,
      v_collection_scope_outstanding
    );
  elsif strpos(v_definition, v_collection_scope_outstanding) = 0 then
    raise exception 'record_payment does not contain a recognized outstanding balance query';
  end if;

  execute v_definition;
end;
$collector_carry_forward_payment_scope$;

revoke all on function public.get_collection_run_queue(uuid) from public;
revoke all on function public.get_today_collection_run_queue(uuid) from public;
grant execute on function public.get_collection_run_queue(uuid) to authenticated;
grant execute on function public.get_today_collection_run_queue(uuid) to authenticated;

notify pgrst, 'reload schema';
