-- Operational POS finance RPCs: payments, collection runs, approvals, and
-- receivables. All mutations are serialized per shop and are idempotent.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-evidence',
  'payment-evidence',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

create policy "payment recorders upload their evidence" on storage.objects for insert
  with check (
    bucket_id = 'payment-evidence'
    and public.is_active_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "payment evidence owners or managers read evidence" on storage.objects for select
  using (
    bucket_id = 'payment-evidence'
    and public.is_active_user()
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.current_app_role() in ('admin', 'round_lead')
    )
  );
create policy "payment recorders retry their evidence upload" on storage.objects for update
  using (
    bucket_id = 'payment-evidence'
    and public.is_active_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'payment-evidence'
    and public.is_active_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

alter table public.payments
  add column approval_request_id uuid unique
    references public.financial_approval_requests(id) on delete restrict;

alter table public.financial_approval_requests
  add column consumed_by_payment_id uuid unique
    references public.payments(id) on delete restrict;

alter table public.financial_approval_requests
  drop constraint financial_approval_requests_check;

alter table public.financial_approval_requests
  add constraint financial_approval_requests_status_check check (
    (status = 'pending' and decided_by is null and decided_at is null
      and decision_reason is null and consumed_by_delivery_event_id is null
      and consumed_by_payment_id is null and consumed_at is null)
    or (status in ('approved', 'rejected') and decided_by is not null and decided_at is not null
      and (status = 'approved' or nullif(trim(coalesce(decision_reason, '')), '') is not null)
      and consumed_by_delivery_event_id is null and consumed_by_payment_id is null
      and consumed_at is null)
    or (status = 'consumed' and decided_by is not null and decided_at is not null
      and num_nonnulls(consumed_by_delivery_event_id, consumed_by_payment_id) = 1
      and consumed_at is not null)
  );

create or replace function public.assert_financial_approval_integrity(target_approval_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.financial_approval_status;
  v_kind public.financial_approval_kind;
  v_shop_id uuid;
  v_delivery_event_id uuid;
  v_payment_id uuid;
begin
  select approval.status, approval.kind, approval.shop_id,
    approval.consumed_by_delivery_event_id, approval.consumed_by_payment_id
  into v_status, v_kind, v_shop_id, v_delivery_event_id, v_payment_id
  from public.financial_approval_requests approval
  where approval.id = target_approval_id;

  if not found then
    return;
  end if;

  if v_status = 'consumed' and v_kind = 'credit_limit' then
    if v_delivery_event_id is null or v_payment_id is not null or not exists (
      select 1
      from public.delivery_charges charge
      where charge.approval_request_id = target_approval_id
        and charge.delivery_event_id = v_delivery_event_id
        and charge.shop_id = v_shop_id
    ) then
      raise exception 'A consumed credit approval must match exactly one delivery charge';
    end if;
  elsif v_status = 'consumed' and v_kind = 'outstanding_balance' then
    if v_payment_id is null or v_delivery_event_id is not null or not exists (
      select 1
      from public.payments payment
      where payment.approval_request_id = target_approval_id
        and payment.id = v_payment_id
        and payment.shop_id = v_shop_id
    ) then
      raise exception 'A consumed outstanding approval must match exactly one payment';
    end if;
  elsif exists (
    select 1 from public.delivery_charges charge
    where charge.approval_request_id = target_approval_id
  ) or exists (
    select 1 from public.payments payment
    where payment.approval_request_id = target_approval_id
  ) then
    raise exception 'A financial record can only use a consumed approval';
  end if;
end;
$$;

create constraint trigger payments_approval_integrity
  after insert or update or delete on public.payments
  deferrable initially deferred
  for each row execute function public.check_financial_approval_integrity();

create or replace function public.financial_payment_response(p_payment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'payment_id', payment.id,
    'shop_id', payment.shop_id,
    'collection_run_id', payment.collection_run_id,
    'payment_method', payment.payment_method,
    'received_amount', payment.received_amount,
    'allocated_amount', payment.allocated_amount,
    'change_amount', payment.change_amount,
    'reference_number', payment.reference_number,
    'evidence_path', payment.evidence_path,
    'status', payment.status,
    'recorded_at', payment.recorded_at,
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_id', allocation.charge_id,
        'amount', allocation.amount
      ) order by charge.service_date, charge.created_at, charge.id)
      from public.payment_allocations allocation
      join public.delivery_charges charge on charge.id = allocation.charge_id
      where allocation.payment_id = payment.id
    ), '[]'::jsonb)
  )
  from public.payments payment
  where payment.id = p_payment_id;
$$;

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
        or charge.service_date is distinct from v_collection_service_date
        or charge.payment_term is distinct from 'end_of_day'
    ) then
      raise exception 'The payment contains a charge outside the caller''s assigned scope';
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

create or replace function public.void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can void payments';
  elsif nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A void reason is required';
  end if;

  select payment.shop_id into v_shop_id
  from public.payments payment where payment.id = p_payment_id;
  if v_shop_id is null then
    raise exception 'The selected payment does not exist';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

  update public.payments
  set status = 'voided', voided_by = auth.uid(), voided_at = now(),
      void_reason = trim(p_reason)
  where id = p_payment_id and status = 'active';

  if not found then
    raise exception 'The selected payment is already voided';
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'payments', p_payment_id, 'voided',
    jsonb_build_object('reason', trim(p_reason))
  );
  return public.financial_payment_response(p_payment_id);
end;
$$;

create or replace function public.open_collection_run(
  p_service_date date,
  p_member_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can open collection runs';
  elsif p_service_date is null then
    raise exception 'A service date is required';
  elsif jsonb_typeof(coalesce(p_member_ids, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Collection members must be a JSON array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('collection-run:' || p_service_date::text, 0));

  select run.id into v_run_id
  from public.collection_runs run
  where run.service_date = p_service_date and run.status = 'open';

  if v_run_id is null then
    insert into public.collection_runs (service_date, opened_by)
    values (p_service_date, auth.uid()) returning id into v_run_id;
  end if;

  delete from public.collection_run_members existing
  where existing.collection_run_id = v_run_id
    and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_member_ids, '[]'::jsonb)) member(user_id uuid)
      where member.user_id = existing.user_id
    );

  insert into public.collection_run_members (collection_run_id, user_id)
  select v_run_id, member.user_id
  from jsonb_to_recordset(coalesce(p_member_ids, '[]'::jsonb)) as member(user_id uuid)
  join public.users app_user on app_user.id = member.user_id and app_user.is_active
  on conflict do nothing;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'collection_runs', v_run_id, 'opened',
    jsonb_build_object('service_date', p_service_date, 'member_ids', coalesce(p_member_ids, '[]'::jsonb))
  );

  return jsonb_build_object(
    'collection_run_id', v_run_id,
    'service_date', p_service_date,
    'status', 'open'
  );
end;
$$;

create or replace function public.get_collection_run_queue(p_collection_run_id uuid)
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

  select run.service_date into v_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id
    and (
      public.current_app_role() in ('admin', 'round_lead')
      or public.is_collection_run_member(run.id)
    );

  if v_service_date is null then
    raise exception 'The collection run does not exist or is not assigned to this user';
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
        and charge.payment_term = 'end_of_day'
        and charge.status = 'active'
        and balance.outstanding_amount > 0
      group by shop.id, profile.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

create or replace function public.close_collection_run(p_collection_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close collection runs';
  end if;

  update public.collection_runs
  set status = 'closed', closed_by = auth.uid(), closed_at = now()
  where id = p_collection_run_id and status = 'open'
  returning service_date into v_service_date;

  if v_service_date is null then
    raise exception 'The selected collection run is already closed or does not exist';
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'collection_runs', p_collection_run_id, 'closed',
    jsonb_build_object('service_date', v_service_date)
  );
  return jsonb_build_object(
    'collection_run_id', p_collection_run_id,
    'service_date', v_service_date,
    'status', 'closed'
  );
end;
$$;

create or replace function public.request_financial_approval(
  p_round_stop_id uuid,
  p_kind public.financial_approval_kind,
  p_items jsonb,
  p_payment_term public.payment_term,
  p_requested_amount numeric,
  p_reason text,
  p_charge_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
  v_round_id uuid;
  v_fingerprint text;
  v_approval_id uuid;
  v_charge_shop_id uuid;
  v_charge_round_stop_id uuid;
  v_charge_payment_term public.payment_term;
  v_charge_outstanding numeric(12,2);
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_kind is null or p_requested_amount is null or p_requested_amount <= 0 then
    raise exception 'Approval kind and a positive requested amount are required';
  elsif nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'An approval reason is required';
  elsif p_kind = 'credit_limit' and jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Approval items must be a JSON array';
  end if;

  select stop.shop_id, stop.round_id into v_shop_id, v_round_id
  from public.round_stops stop where stop.id = p_round_stop_id;

  if v_shop_id is null then
    raise exception 'The selected shop is not in a delivery round';
  elsif public.current_app_role() not in ('admin', 'round_lead')
    and not public.is_round_member(v_round_id) then
    raise exception 'You are not assigned to this delivery round';
  elsif (p_kind = 'credit_limit' and p_payment_term <> 'credit')
    or (p_kind = 'outstanding_balance' and p_payment_term = 'credit') then
    raise exception 'The approval kind does not match the payment term';
  end if;

  if p_kind = 'outstanding_balance' then
    if p_charge_id is null then
      raise exception 'An outstanding-balance approval requires a delivery charge';
    end if;

    select charge.shop_id, event.round_stop_id, charge.payment_term,
      greatest(charge.original_amount - coalesce(sum(allocation.amount)
        filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
    into v_charge_shop_id, v_charge_round_stop_id, v_charge_payment_term,
      v_charge_outstanding
    from public.delivery_charges charge
    join public.delivery_events event on event.id = charge.delivery_event_id
    left join public.payment_allocations allocation on allocation.charge_id = charge.id
    left join public.payments payment on payment.id = allocation.payment_id
    where charge.id = p_charge_id and charge.status = 'active'
    group by charge.id, event.round_stop_id;

    if v_charge_shop_id is distinct from v_shop_id
      or v_charge_round_stop_id is distinct from p_round_stop_id
      or v_charge_payment_term is distinct from 'immediate'
      or not public.is_financial_charge_visible(p_charge_id) then
      raise exception 'The delivery charge does not match this outstanding request';
    elsif p_requested_amount >= v_charge_outstanding then
      raise exception 'The requested outstanding amount must be below the current charge balance';
    end if;

    v_fingerprint := md5(jsonb_build_object(
      'kind', 'outstanding_balance',
      'charge_id', p_charge_id,
      'outstanding_amount', p_requested_amount::numeric(12,2)
    )::text);
  else
    if p_charge_id is not null then
      raise exception 'A credit-limit approval cannot include a delivery charge';
    end if;
    v_fingerprint := public.delivery_request_fingerprint(
      p_round_stop_id, p_items, 'delivered', null, p_payment_term
    );
  end if;

  select approval.id into v_approval_id
  from public.financial_approval_requests approval
  where approval.requested_by = auth.uid()
    and approval.request_fingerprint = v_fingerprint
    and approval.status in ('pending', 'approved')
  order by case approval.status when 'approved' then 0 else 1 end, approval.requested_at desc
  limit 1;

  if v_approval_id is null then
    insert into public.financial_approval_requests (
      shop_id, round_stop_id, kind, requested_amount, reason,
      request_fingerprint, requested_by
    ) values (
      v_shop_id, p_round_stop_id, p_kind, p_requested_amount::numeric(12,2),
      trim(p_reason), v_fingerprint, auth.uid()
    ) returning id into v_approval_id;

    insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
    values (
      auth.uid(), 'financial_approval_requests', v_approval_id, 'requested',
      jsonb_build_object(
        'kind', p_kind,
        'requested_amount', p_requested_amount::numeric(12,2),
        'request_fingerprint', v_fingerprint
      )
    );
  end if;

  return (
    select to_jsonb(approval) from public.financial_approval_requests approval
    where approval.id = v_approval_id
  );
end;
$$;

create or replace function public.decide_financial_approval(
  p_approval_id uuid,
  p_decision public.financial_approval_status,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can decide financial approvals';
  elsif p_decision not in ('approved', 'rejected') then
    raise exception 'The decision must be approved or rejected';
  elsif p_decision = 'rejected' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A rejection reason is required';
  end if;

  update public.financial_approval_requests
  set status = p_decision,
      decided_by = auth.uid(),
      decided_at = now(),
      decision_reason = case when p_decision = 'rejected' then trim(p_reason)
        else nullif(trim(coalesce(p_reason, '')), '') end
  where id = p_approval_id and status = 'pending';

  if not found then
    raise exception 'The selected approval is no longer pending';
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'financial_approval_requests', p_approval_id, 'decided',
    jsonb_build_object('decision', p_decision, 'reason', nullif(trim(coalesce(p_reason, '')), ''))
  );

  return (
    select to_jsonb(approval) from public.financial_approval_requests approval
    where approval.id = p_approval_id
  );
end;
$$;

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
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view credit receivables';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', receivable.shop_id,
      'shop_code', receivable.shop_code,
      'shop_name', receivable.shop_name,
      'original_amount', receivable.original_amount,
      'allocated_amount', receivable.allocated_amount,
      'outstanding_amount', receivable.outstanding_amount,
      'oldest_due_date', receivable.oldest_due_date,
      'overdue_amount', receivable.overdue_amount,
      'charges', receivable.charges
    ) order by receivable.oldest_due_date, receivable.shop_code)
    from (
      select
        shop.id as shop_id,
        shop.code as shop_code,
        shop.name as shop_name,
        sum(charge.original_amount)::numeric(12,2) as original_amount,
        sum(balance.allocated_amount)::numeric(12,2) as allocated_amount,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        min(charge.due_date) as oldest_due_date,
        sum(case when charge.due_date < p_as_of_date
          then balance.outstanding_amount else 0 end)::numeric(12,2) as overdue_amount,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id,
          'delivery_event_id', charge.delivery_event_id,
          'service_date', charge.service_date,
          'due_date', charge.due_date,
          'original_amount', charge.original_amount,
          'allocated_amount', balance.allocated_amount,
          'outstanding_amount', balance.outstanding_amount
        ) order by charge.due_date, charge.created_at) as charges
      from public.delivery_charges charge
      join public.shops shop on shop.id = charge.shop_id
      join lateral (
        select
          coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2)
            as allocated_amount,
          greatest(charge.original_amount - coalesce(sum(allocation.amount)
            filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
            as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where charge.payment_term = 'credit'
        and charge.status = 'active'
        and balance.outstanding_amount > 0
      group by shop.id
    ) receivable
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.financial_payment_response(uuid) from public;
revoke all on function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) from public;
revoke all on function public.void_payment(uuid, text) from public;
revoke all on function public.open_collection_run(date, jsonb) from public;
revoke all on function public.get_collection_run_queue(uuid) from public;
revoke all on function public.close_collection_run(uuid) from public;
revoke all on function public.request_financial_approval(
  uuid, public.financial_approval_kind, jsonb, public.payment_term, numeric, text, uuid
) from public;
revoke all on function public.decide_financial_approval(
  uuid, public.financial_approval_status, text
) from public;
revoke all on function public.get_credit_receivables(date) from public;

grant execute on function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) to authenticated;
grant execute on function public.void_payment(uuid, text) to authenticated;
grant execute on function public.open_collection_run(date, jsonb) to authenticated;
grant execute on function public.get_collection_run_queue(uuid) to authenticated;
grant execute on function public.close_collection_run(uuid) to authenticated;
grant execute on function public.request_financial_approval(
  uuid, public.financial_approval_kind, jsonb, public.payment_term, numeric, text, uuid
) to authenticated;
grant execute on function public.decide_financial_approval(
  uuid, public.financial_approval_status, text
) to authenticated;
grant execute on function public.get_credit_receivables(date) to authenticated;
