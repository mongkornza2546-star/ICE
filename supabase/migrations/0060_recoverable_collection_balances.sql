-- Keep outstanding retail balances collectible after their original service date.
-- Collection runs remain the authority that assigns a courier to collect, but their
-- date no longer limits which active immediate/end-of-day charges can be settled.

create or replace function public.record_payment(
  p_shop_id uuid,
  p_allocations jsonb,
  p_payment_method public.payment_method,
  p_received_amount numeric,
  p_reference_number text,
  p_evidence_path text,
  p_collection_run_id uuid,
  p_expected_outstanding_amount numeric,
  p_approval_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_id uuid;
  v_existing_shop_id uuid;
  v_existing_fingerprint text;
  v_request_fingerprint text;
  v_allocated_amount numeric(12,2);
  v_current_outstanding numeric(12,2);
  v_remaining_outstanding numeric(12,2);
  v_change_amount numeric(12,2);
  v_collection_service_date date;
  v_outstanding_charge_id uuid;
  v_outstanding_round_stop_id uuid;
  v_approval_fingerprint text;
  v_approval public.financial_approval_requests%rowtype;
  v_profile public.shop_payment_profiles%rowtype;
  v_allocation record;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_shop_id is null or p_payment_method is null or p_idempotency_key is null then
    raise exception 'Shop, payment method, and idempotency key are required';
  elsif jsonb_typeof(p_allocations) is distinct from 'array'
    or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Payment allocations must be a non-empty JSON array';
  elsif p_received_amount is null or p_received_amount <= 0 then
    raise exception 'The received amount must be positive';
  end if;

  select coalesce(sum(item.amount), 0)::numeric(12,2)
  into v_allocated_amount
  from jsonb_to_recordset(p_allocations) as item(charge_id uuid, amount numeric);

  if v_allocated_amount <= 0 or exists (
    select 1
    from jsonb_to_recordset(p_allocations) as item(charge_id uuid, amount numeric)
    where item.charge_id is null or item.amount is null or item.amount <= 0
  ) or exists (
    select 1
    from jsonb_to_recordset(p_allocations) as item(charge_id uuid, amount numeric)
    group by item.charge_id having count(*) > 1
  ) then
    raise exception 'Every allocation must have a distinct charge and positive amount';
  end if;

  v_change_amount := (p_received_amount - v_allocated_amount)::numeric(12,2);
  if v_change_amount < 0 then
    raise exception 'The received amount cannot be less than the allocated amount';
  elsif p_payment_method <> 'cash' and v_change_amount <> 0 then
    raise exception 'Only cash payments can include change';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'charge_id', item.charge_id,
    'amount', item.amount::numeric(12,2)
  ) order by item.charge_id), '[]'::jsonb)
  into p_allocations
  from jsonb_to_recordset(p_allocations) as item(charge_id uuid, amount numeric);

  v_request_fingerprint := md5(jsonb_build_object(
    'shop_id', p_shop_id,
    'allocations', p_allocations,
    'payment_method', p_payment_method,
    'received_amount', p_received_amount::numeric(12,2),
    'reference_number', nullif(trim(coalesce(p_reference_number, '')), ''),
    'evidence_path', nullif(trim(coalesce(p_evidence_path, '')), ''),
    'collection_run_id', p_collection_run_id,
    'approval_id', p_approval_id
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select payment.id, payment.shop_id, payment.request_fingerprint
  into v_payment_id, v_existing_shop_id, v_existing_fingerprint
  from public.payments payment
  where payment.idempotency_key = p_idempotency_key;

  if v_payment_id is not null then
    if not public.is_payment_visible(v_payment_id) then
      raise exception 'This payment cannot be viewed by the current user';
    elsif v_existing_shop_id <> p_shop_id
      or v_existing_fingerprint is distinct from v_request_fingerprint then
      raise exception 'This idempotency key was already used for a different payment';
    end if;
    return public.financial_payment_response(v_payment_id);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));

  select profile.* into v_profile
  from public.shop_payment_profiles profile
  where profile.shop_id = p_shop_id;

  if v_profile.id is null then
    raise exception 'The selected shop does not have a payment profile';
  elsif not (p_payment_method = any(v_profile.allowed_payment_methods)) then
    raise exception 'The selected payment method is not allowed for this shop';
  elsif (
    (p_payment_method = 'cash' and v_profile.cash_reference_required)
    or (p_payment_method = 'bank_transfer' and v_profile.bank_transfer_reference_required)
    or (p_payment_method = 'qr' and v_profile.qr_reference_required)
  ) and nullif(trim(coalesce(p_reference_number, '')), '') is null then
    raise exception 'A payment reference is required for this method';
  elsif (
    (p_payment_method = 'cash' and v_profile.cash_evidence_required)
    or (p_payment_method = 'bank_transfer' and v_profile.bank_transfer_evidence_required)
    or (p_payment_method = 'qr' and v_profile.qr_evidence_required)
  ) and nullif(trim(coalesce(p_evidence_path, '')), '') is null then
    raise exception 'Payment evidence is required for this method';
  elsif nullif(trim(coalesce(p_evidence_path, '')), '') is not null
    and not exists (
      select 1
      from storage.objects evidence
      where evidence.bucket_id = 'payment-evidence'
        and evidence.name = trim(p_evidence_path)
        and (storage.foldername(evidence.name))[1] = auth.uid()::text
    ) then
    raise exception 'Payment evidence does not exist or does not belong to the current user';
  end if;

  if p_collection_run_id is not null then
    select run.service_date into v_collection_service_date
    from public.collection_runs run
    where run.id = p_collection_run_id and run.status = 'open'
      and (
        public.current_app_role() in ('admin', 'round_lead')
        or public.is_collection_run_member(run.id)
      );

    if v_collection_service_date is null then
      raise exception 'The collection run is not open or assigned to this user';
    elsif exists (
      select 1
      from jsonb_to_recordset(p_allocations) requested(charge_id uuid, amount numeric)
      left join public.delivery_charges charge on charge.id = requested.charge_id
      where charge.id is null
        or charge.shop_id is distinct from p_shop_id
        or charge.status is distinct from 'active'
        or charge.payment_term not in ('immediate', 'end_of_day')
    ) then
      raise exception 'The payment contains a charge outside the caller''s assigned collection scope';
    end if;
  elsif exists (
    select 1
    from jsonb_to_recordset(p_allocations) requested(charge_id uuid, amount numeric)
    left join public.delivery_charges charge on charge.id = requested.charge_id
    where charge.id is null
      or charge.shop_id is distinct from p_shop_id
      or charge.status is distinct from 'active'
      or charge.payment_term is distinct from 'immediate'
      or not public.is_financial_charge_visible(charge.id)
  ) then
    raise exception 'The payment contains a charge outside the caller''s assigned scope';
  end if;

  if p_approval_id is not null and p_collection_run_id is not null then
    raise exception 'Collection payments cannot use an immediate-payment approval';
  end if;

  select coalesce(sum(greatest(
    charge.original_amount - coalesce(active_allocations.amount, 0), 0
  )), 0)::numeric(12,2)
  into v_current_outstanding
  from public.delivery_charges charge
  left join lateral (
    select coalesce(sum(allocation.amount), 0)::numeric(12,2) as amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id and payment.status = 'active'
  ) active_allocations on true
  where charge.shop_id = p_shop_id
    and charge.status = 'active'
    and exists (
      select 1
      from jsonb_to_recordset(p_allocations) as requested(charge_id uuid, amount numeric)
      where requested.charge_id = charge.id
    );

  if p_expected_outstanding_amount is not null
    and v_current_outstanding <> p_expected_outstanding_amount::numeric(12,2) then
    raise exception 'The outstanding amount changed; refresh before recording payment';
  end if;

  for v_allocation in
    select item.charge_id, item.amount::numeric(12,2) as amount
    from jsonb_to_recordset(p_allocations) as item(charge_id uuid, amount numeric)
    order by item.charge_id
  loop
    if not exists (
      select 1
      from public.delivery_charges charge
      where charge.id = v_allocation.charge_id
        and charge.shop_id = p_shop_id
        and charge.status = 'active'
    ) then
      raise exception 'Every allocation must target an active charge for the selected shop';
    elsif v_allocation.amount > (
      select greatest(charge.original_amount - coalesce(sum(allocation.amount)
        filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
      from public.delivery_charges charge
      left join public.payment_allocations allocation on allocation.charge_id = charge.id
      left join public.payments payment on payment.id = allocation.payment_id
      where charge.id = v_allocation.charge_id
      group by charge.id
    ) then
      raise exception 'An allocation cannot exceed the latest charge balance';
    end if;
  end loop;

  v_remaining_outstanding := (v_current_outstanding - v_allocated_amount)::numeric(12,2);

  if not v_profile.allow_outstanding and v_remaining_outstanding > 0
    and exists (
      select 1
      from jsonb_to_recordset(p_allocations) as item(charge_id uuid, amount numeric)
      join public.delivery_charges charge on charge.id = item.charge_id
      where charge.payment_term = 'immediate'
    ) then
    if p_approval_id is null then
      raise exception 'This shop does not allow an outstanding immediate balance';
    elsif jsonb_array_length(p_allocations) <> 1 then
      raise exception 'An outstanding-balance approval can only cover one immediate charge';
    end if;

    select charge.id, event.round_stop_id
    into v_outstanding_charge_id, v_outstanding_round_stop_id
    from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric)
    join public.delivery_charges charge on charge.id = item.charge_id
    join public.delivery_events event on event.id = charge.delivery_event_id
    where charge.payment_term = 'immediate';

    v_approval_fingerprint := md5(jsonb_build_object(
      'kind', 'outstanding_balance',
      'charge_id', v_outstanding_charge_id,
      'outstanding_amount', v_remaining_outstanding
    )::text);

    select approval.* into v_approval
    from public.financial_approval_requests approval
    where approval.id = p_approval_id
    for update;

    if v_approval.status is distinct from 'approved'
      or v_approval.kind is distinct from 'outstanding_balance'
      or v_approval.shop_id is distinct from p_shop_id
      or v_approval.round_stop_id is distinct from v_outstanding_round_stop_id
      or v_approval.requested_by is distinct from auth.uid()
      or v_approval.requested_amount is distinct from v_remaining_outstanding
      or v_approval.request_fingerprint is distinct from v_approval_fingerprint then
      raise exception 'The outstanding-balance approval does not match this payment';
    elsif not exists (
      select 1 from public.delivery_charges charge
      where charge.id = v_outstanding_charge_id
        and charge.service_date = (now() at time zone 'Asia/Bangkok')::date
    ) then
      raise exception 'Financial approval has expired';
    end if;
  elsif p_approval_id is not null then
    raise exception 'This payment does not require a financial approval';
  end if;

  insert into public.payments (
    shop_id, collection_run_id, payment_method, received_amount,
    allocated_amount, change_amount, reference_number, evidence_path,
    approval_request_id, idempotency_key, request_fingerprint, recorded_by
  ) values (
    p_shop_id, p_collection_run_id, p_payment_method,
    p_received_amount::numeric(12,2), v_allocated_amount, v_change_amount,
    nullif(trim(coalesce(p_reference_number, '')), ''),
    nullif(trim(coalesce(p_evidence_path, '')), ''),
    p_approval_id, p_idempotency_key, v_request_fingerprint, auth.uid()
  ) returning id into v_payment_id;

  insert into public.payment_allocations (payment_id, charge_id, amount)
  select v_payment_id, item.charge_id, item.amount::numeric(12,2)
  from jsonb_to_recordset(p_allocations) as item(charge_id uuid, amount numeric);

  if p_approval_id is not null then
    update public.financial_approval_requests
    set status = 'consumed', consumed_by_payment_id = v_payment_id, consumed_at = now()
    where id = p_approval_id and status = 'approved';
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'payments', v_payment_id, 'created',
    jsonb_build_object(
      'shop_id', p_shop_id,
      'payment_method', p_payment_method,
      'received_amount', p_received_amount::numeric(12,2),
      'allocated_amount', v_allocated_amount,
      'change_amount', v_change_amount,
      'allocations', p_allocations,
      'collection_run_id', p_collection_run_id,
      'approval_id', p_approval_id
    )
  );

  return public.financial_payment_response(v_payment_id);
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
