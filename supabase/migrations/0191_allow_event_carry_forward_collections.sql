-- Migration 0191: Allow event carry-forward collections
-- Allow unpaid event delivery charges and tank rental charges from past service dates
-- to carry forward and be collected in the current day's collection run, matching regular shop rules.

-- 1. Update is_charge_collectible_in_run to allow past event charges (charge.service_date <= run.service_date)
create or replace function public.is_charge_collectible_in_run(
  p_charge_id uuid,
  p_collection_run_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.delivery_charges charge
    join public.collection_runs run
      on run.id = p_collection_run_id and run.status = 'open'
    where charge.id = p_charge_id
      and charge.status = 'active'
      and (
        charge.event_settlement_context_id is null
        or charge.service_date <= run.service_date
      )
      and (
        charge.payment_term in ('immediate', 'end_of_day')
        or (charge.payment_term = 'credit' and charge.due_date <= run.service_date)
      )
  );
$$;

revoke all on function public.is_charge_collectible_in_run(uuid, uuid) from public, anon;
grant execute on function public.is_charge_collectible_in_run(uuid, uuid) to authenticated;

-- 2. Update get_collection_run_queue to include past unpaid event contexts (context.service_date <= v_service_date)
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
    raise exception 'An active user is required to view shop collections';
  end if;
  select run.service_date into v_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id and run.status = 'open';
  if v_service_date is null
    or v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or exists (
      select 1 from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_service_date
    ) then
    raise exception 'The collection context is stale or closed';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'queue_key', queue.queue_key,
      'destination_kind', queue.destination_kind,
      'event_settlement_context_id', queue.event_settlement_context_id,
      'event_participation_id', queue.event_participation_id,
      'settlement_service_date', queue.settlement_service_date,
      'settlement_policy_fingerprint', queue.settlement_policy_fingerprint,
      'event_name', queue.event_name,
      'event_location', queue.event_location,
      'event_zone', queue.event_zone,
      'event_booth', queue.event_booth,
      'shop_id', queue.shop_id,
      'shop_code', queue.shop_code,
      'shop_name', queue.shop_name,
      'building_id', queue.building_id,
      'building_name', queue.building_name,
      'zone_id', queue.zone_id,
      'zone_name', queue.zone_name,
      'image_path', queue.image_path,
      'outstanding_amount', queue.outstanding_amount,
      'charge_count', queue.charge_count,
      'latest_charge_at', queue.latest_charge_at,
      'latest_payment_at', queue.latest_payment_at,
      'has_new_charges', queue.latest_payment_at is not null
        and queue.latest_charge_at > queue.latest_payment_at,
      'payment_profile', queue.payment_profile,
      'charges', queue.charges
    ) order by queue.destination_kind, queue.event_name nulls first, queue.shop_code, queue.queue_key)
    from (
      select
        case when context.id is null then 'regular:' || shop.id::text
          else 'event:' || context.id::text end as queue_key,
        case when context.id is null then 'regular' else 'event' end as destination_kind,
        context.id as event_settlement_context_id,
        context.event_participation_id,
        context.service_date as settlement_service_date,
        context.settlement_policy_fingerprint,
        min(coalesce(stop.event_job_name_snapshot, job.name)) as event_name,
        min(coalesce(stop.event_location_snapshot, job.location)) as event_location,
        min(coalesce(stop.event_zone_snapshot, participation.event_zone)) as event_zone,
        min(coalesce(stop.event_booth_snapshot, participation.booth_number)) as event_booth,
        shop.id as shop_id,
        shop.code as shop_code,
        shop.name as shop_name,
        case when context.id is null then shop.building_id else null end as building_id,
        case when context.id is null then building.name else min(coalesce(stop.event_location_snapshot, job.location)) end as building_name,
        case when context.id is null then shop.zone_id else null end as zone_id,
        case when context.id is null then zone.name else min(coalesce(stop.event_zone_snapshot, participation.event_zone)) end as zone_name,
        case when context.id is null then shop.image_path else null end as image_path,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        count(*)::integer as charge_count,
        max(charge.created_at) as latest_charge_at,
        case when context.id is null then jsonb_build_object(
          'allowed_payment_methods', profile.allowed_payment_methods,
          'default_payment_method', profile.default_payment_method,
          'cash_reference_required', profile.cash_reference_required,
          'cash_evidence_required', profile.cash_evidence_required,
          'bank_transfer_reference_required', profile.bank_transfer_reference_required,
          'bank_transfer_evidence_required', profile.bank_transfer_evidence_required,
          'qr_reference_required', profile.qr_reference_required,
          'qr_evidence_required', profile.qr_evidence_required
        ) else jsonb_build_object(
          'allowed_payment_methods', participation.allowed_payment_methods_snapshot,
          'default_payment_method', participation.default_payment_method_snapshot,
          'cash_reference_required', participation.cash_reference_required_snapshot,
          'cash_evidence_required', participation.cash_evidence_required_snapshot,
          'bank_transfer_reference_required', participation.bank_transfer_reference_required_snapshot,
          'bank_transfer_evidence_required', participation.bank_transfer_evidence_required_snapshot,
          'qr_reference_required', participation.qr_reference_required_snapshot,
          'qr_evidence_required', participation.qr_evidence_required_snapshot
        ) end as payment_profile,
        (
          select max(payment.recorded_at)
          from public.payments payment
          where payment.collection_run_id = p_collection_run_id
            and payment.status = 'active'
            and payment.shop_id = shop.id
            and payment.event_settlement_context_id is not distinct from context.id
        ) as latest_payment_at,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id,
          'charge_number', charge.charge_number,
          'delivery_event_id', charge.delivery_event_id,
          'service_date', charge.service_date,
          'payment_term', charge.payment_term,
          'due_date', charge.due_date,
          'original_amount', public.effective_delivery_charge_amount(charge.id),
          'base_amount', charge.original_amount,
          'outstanding_amount', balance.outstanding_amount,
          'created_at', charge.created_at,
          'items', public.charge_line_items(charge.id)
        ) order by charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      left join public.delivery_events event on event.id = charge.delivery_event_id
      left join public.round_stops stop on stop.id = event.round_stop_id
      join public.shops shop on shop.id = charge.shop_id
      left join public.buildings building on building.id = shop.building_id
      left join public.building_zones zone on zone.id = shop.zone_id
      left join public.shop_payment_profiles profile on profile.shop_id = shop.id
      left join public.event_settlement_contexts context
        on context.id = charge.event_settlement_context_id
      left join public.event_participations participation
        on participation.id = context.event_participation_id
      left join public.event_jobs job on job.id = participation.event_job_id
      join lateral (
        select greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
          as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where public.is_charge_collectible_in_run(charge.id, p_collection_run_id)
        and balance.outstanding_amount > 0
        and (context.id is not null or profile.id is not null)
        and (context.id is null or context.service_date <= v_service_date)
      group by shop.id, building.id, zone.id, profile.id, context.id, participation.id, job.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_collection_run_queue(uuid) from public, anon;
grant execute on function public.get_collection_run_queue(uuid) to authenticated;

-- 3. Update record_event_payment to allow paying past contexts (run.service_date >= v_context.service_date)
create or replace function public.record_event_payment(
  p_expected_settlement_context_id uuid,
  p_expected_participation_id uuid,
  p_expected_service_date date,
  p_expected_policy_fingerprint text,
  p_allocations jsonb,
  p_payment_method public.payment_method,
  p_received_amount numeric,
  p_reference_number text,
  p_evidence_path text,
  p_collection_run_id uuid,
  p_expected_outstanding_amount numeric,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_context public.event_settlement_contexts%rowtype;
  v_participation public.event_participations%rowtype;
  v_payment public.payments%rowtype;
  v_canonical_allocations jsonb;
  v_allocated_amount numeric(12,2);
  v_change_amount numeric(12,2);
  v_current_outstanding numeric(12,2);
  v_fingerprint text;
  v_allocation record;
  v_reference text := nullif(trim(coalesce(p_reference_number, '')), '');
  v_evidence text := nullif(trim(coalesce(p_evidence_path, '')), '');
  v_run_service_date date;
begin
  if not public.is_active_user() or not public.can_collect_shop_payments() then
    raise exception 'The current user cannot collect event payments';
  elsif p_expected_settlement_context_id is null
    or p_expected_participation_id is null
    or p_expected_service_date is null
    or p_idempotency_key is null
    or p_payment_method is null then
    raise exception 'Event settlement identity, method, and idempotency key are required';
  elsif jsonb_typeof(p_allocations) is distinct from 'array'
    or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Payment allocations must be a non-empty JSON array';
  elsif p_received_amount is null or p_received_amount <= 0 then
    raise exception 'The received amount must be positive';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'charge_id', item.charge_id,
    'amount', item.amount::numeric(12,2)
  ) order by item.charge_id), '[]'::jsonb),
  coalesce(sum(item.amount), 0)::numeric(12,2)
  into v_canonical_allocations, v_allocated_amount
  from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric);

  if v_allocated_amount <= 0 or exists (
    select 1 from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric)
    where item.charge_id is null or item.amount is null or item.amount <= 0
  ) or exists (
    select 1 from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric)
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

  v_fingerprint := public.financial_payment_request_fingerprint_v2('event', jsonb_build_object(
    'settlement_context_id', p_expected_settlement_context_id,
    'participation_id', p_expected_participation_id,
    'service_date', p_expected_service_date,
    'policy_fingerprint', p_expected_policy_fingerprint,
    'allocations', v_canonical_allocations,
    'expected_outstanding_amount', p_expected_outstanding_amount::numeric(12,2),
    'payment_method', p_payment_method,
    'received_amount', p_received_amount::numeric(12,2),
    'reference_number', v_reference,
    'evidence_path', v_evidence,
    'collection_run_id', p_collection_run_id
  ));

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_payment from public.payments payment
  where payment.idempotency_key = p_idempotency_key;
  if v_payment.id is not null then
    if not public.is_payment_visible(v_payment.id) then
      raise exception 'This payment cannot be viewed by the current user';
    elsif v_payment.operation_kind <> 'event'
      or v_payment.event_settlement_context_id is distinct from p_expected_settlement_context_id
      or v_payment.request_fingerprint is distinct from v_fingerprint then
      raise exception 'This idempotency key was already used for a different payment';
    end if;
    return public.financial_payment_response(v_payment.id);
  end if;

  select * into v_context from public.event_settlement_contexts context
  where context.id = p_expected_settlement_context_id;
  if v_context.id is null
    or v_context.event_participation_id is distinct from p_expected_participation_id
    or v_context.service_date is distinct from p_expected_service_date
    or v_context.settlement_policy_fingerprint is distinct from p_expected_policy_fingerprint then
    raise exception 'The event settlement context changed; refresh before recording payment';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_context.service_date::text, 0));
  select * into v_context from public.event_settlement_contexts context
  where context.id = p_expected_settlement_context_id for update;
  perform pg_advisory_xact_lock(
    hashtextextended('financial-shop:' || v_context.shop_id::text, 0)
  );

  select run.service_date into v_run_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id and run.status = 'open';

  if v_run_service_date is null
    or v_run_service_date < v_context.service_date
    or v_run_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or exists (
      select 1 from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_run_service_date
    ) then
    raise exception 'The collection context is stale or closed';
  end if;

  perform pg_advisory_xact_lock_shared(
    hashtextextended('collection-run:' || v_run_service_date::text, 0)
  );

  select * into v_participation from public.event_participations participation
  where participation.id = v_context.event_participation_id;
  if not (p_payment_method = any(v_participation.allowed_payment_methods_snapshot)) then
    raise exception 'The selected payment method is not allowed for this event';
  elsif ((p_payment_method = 'cash' and v_participation.cash_reference_required_snapshot)
    or (p_payment_method = 'bank_transfer' and v_participation.bank_transfer_reference_required_snapshot)
    or (p_payment_method = 'qr' and v_participation.qr_reference_required_snapshot))
    and v_reference is null then
    raise exception 'A payment reference is required for this method';
  elsif ((p_payment_method = 'cash' and v_participation.cash_evidence_required_snapshot)
    or (p_payment_method = 'bank_transfer' and v_participation.bank_transfer_evidence_required_snapshot)
    or (p_payment_method = 'qr' and v_participation.qr_evidence_required_snapshot))
    and v_evidence is null then
    raise exception 'Payment evidence is required for this method';
  elsif v_evidence is not null and not exists (
    select 1 from storage.objects evidence
    where evidence.bucket_id = 'payment-evidence'
      and evidence.name = v_evidence
      and (storage.foldername(evidence.name))[1] = auth.uid()::text
  ) then
    raise exception 'Payment evidence does not exist or does not belong to the current user';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_canonical_allocations) requested(charge_id uuid, amount numeric)
    left join public.delivery_charges charge on charge.id = requested.charge_id
    where charge.id is null
      or charge.status <> 'active'
      or charge.event_settlement_context_id is distinct from v_context.id
      or not public.is_charge_collectible_in_run(charge.id, p_collection_run_id)
  ) then
    raise exception 'Every allocation must target an active charge in this event settlement';
  end if;

  select coalesce(sum(greatest(public.effective_delivery_charge_amount(charge.id)
    - coalesce(active_allocations.amount, 0), 0)), 0)::numeric(12,2)
  into v_current_outstanding
  from public.delivery_charges charge
  left join lateral (
    select coalesce(sum(allocation.amount), 0)::numeric(12,2) as amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id and payment.status = 'active'
  ) active_allocations on true
  where charge.event_settlement_context_id = v_context.id
    and charge.status = 'active'
    and public.is_charge_collectible_in_run(charge.id, p_collection_run_id);

  if p_expected_outstanding_amount is not null
    and v_current_outstanding <> p_expected_outstanding_amount::numeric(12,2) then
    raise exception 'The outstanding amount changed; refresh before recording payment';
  elsif v_allocated_amount > v_current_outstanding then
    raise exception 'Payment allocations cannot exceed the event outstanding amount';
  end if;

  for v_allocation in
    select item.charge_id, item.amount::numeric(12,2) as amount
    from jsonb_to_recordset(v_canonical_allocations) item(charge_id uuid, amount numeric)
    order by item.charge_id
  loop
    if v_allocation.amount > (
      select greatest(public.effective_delivery_charge_amount(charge.id)
        - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
      from public.delivery_charges charge
      left join public.payment_allocations allocation on allocation.charge_id = charge.id
      left join public.payments payment on payment.id = allocation.payment_id
      where charge.id = v_allocation.charge_id group by charge.id
    ) then
      raise exception 'An allocation cannot exceed the latest charge balance';
    end if;
  end loop;

  insert into public.payments (
    shop_id, collection_run_id, payment_method, received_amount,
    allocated_amount, change_amount, reference_number, evidence_path,
    idempotency_key, request_fingerprint, recorded_by,
    operation_kind, event_settlement_context_id, request_fingerprint_version
  ) values (
    v_context.shop_id, p_collection_run_id, p_payment_method,
    p_received_amount::numeric(12,2), v_allocated_amount, v_change_amount,
    v_reference, v_evidence, p_idempotency_key, v_fingerprint, auth.uid(),
    'event', v_context.id, 2
  ) returning * into v_payment;

  insert into public.payment_allocations (payment_id, charge_id, amount)
  select v_payment.id, item.charge_id, item.amount::numeric(12,2)
  from jsonb_to_recordset(v_canonical_allocations) item(charge_id uuid, amount numeric);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (auth.uid(), 'payments', v_payment.id, 'event_created', jsonb_build_object(
    'event_settlement_context_id', v_context.id,
    'event_participation_id', v_context.event_participation_id,
    'service_date', v_context.service_date,
    'allocations', v_canonical_allocations
  ));
  return public.financial_payment_response(v_payment.id);
end;
$$;

revoke all on function public.record_event_payment(uuid, uuid, date, text, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid) from public, anon;
grant execute on function public.record_event_payment(uuid, uuid, date, text, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid) to authenticated;

notify pgrst, 'reload schema';
