-- One event participation can collect multiple service days in one payment.
-- Legacy single-context payments keep their exact invariant and retry contract.
begin;
alter table public.payments add column event_collection boolean not null default false;
alter table public.payments add constraint payments_event_collection_kind
  check (not event_collection or operation_kind = 'event');

create function public.event_collection_context_matches(p_context_id uuid, p_anchor_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.event_settlement_contexts context
    join public.event_settlement_contexts anchor on anchor.id = p_anchor_id
    where context.id = p_context_id and context.shop_id = anchor.shop_id
      and context.event_participation_id = anchor.event_participation_id
      and context.settlement_policy_fingerprint = anchor.settlement_policy_fingerprint
      and context.config_version_id = anchor.config_version_id
  );
$$;
revoke all on function public.event_collection_context_matches(uuid,uuid) from public, anon, authenticated;

create function public.protect_event_collection_scope()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.event_collection is distinct from old.event_collection then
    raise exception 'Payment collection scope is immutable';
  end if;
  if new.event_collection and not exists (
    select 1 from public.event_settlement_contexts context
    where context.id = new.event_settlement_context_id and context.shop_id = new.shop_id
  ) then raise exception 'Event collection must match its settlement shop'; end if;
  return new;
end;
$$;
create trigger payments_protect_event_collection_scope
before insert or update on public.payments
for each row execute function public.protect_event_collection_scope();
revoke all on function public.protect_event_collection_scope() from public, anon, authenticated;

-- Extend both allocation and refund guards only for the new, immutable scope.
do $integrity$
declare
  v_definition text := pg_get_functiondef('public.assert_payment_allocation_integrity(uuid)'::regprocedure);
  v_old text := 'charge.event_settlement_context_id
          is distinct from v_payment.event_settlement_context_id';
begin
  if strpos(v_definition, v_old) = 0 then raise exception 'Payment context guard not found'; end if;
  execute replace(v_definition, v_old, '(case when v_payment.event_collection then
          not public.event_collection_context_matches(charge.event_settlement_context_id, v_payment.event_settlement_context_id)
        else charge.event_settlement_context_id is distinct from v_payment.event_settlement_context_id end)');
end;
$integrity$;

-- Opt in to participation-wide rows without changing the legacy daily queue
-- contract used by installed APKs. Reuse its authorization and date/run locks.
create function public.get_daily_shop_collection_queue_v2(p_service_date date)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_result jsonb;
  v_queue jsonb;
begin
  v_result := public.get_daily_shop_collection_queue(p_service_date);
  with source as materialized (
    select value as row from jsonb_array_elements(v_result->'queue')
  ), events as (
    select (jsonb_agg(source.row - 'charges' order by source.row->>'settlement_service_date' desc)->0)
      || jsonb_build_object(
        'queue_key', 'event-participation:' || (source.row->>'event_participation_id'),
        'collection_scope', 'event_participation',
        'settlement_service_date', case when count(distinct source.row->>'settlement_service_date') = 1
          then min(source.row->>'settlement_service_date') else null end,
        'outstanding_amount', sum((charge->>'outstanding_amount')::numeric),
        'charge_count', count(*),
        'latest_charge_at', max(source.row->>'latest_charge_at'),
        'latest_payment_at', max(source.row->>'latest_payment_at'),
        'has_new_charges', max(source.row->>'latest_payment_at') is not null
          and max(source.row->>'latest_charge_at') > max(source.row->>'latest_payment_at'),
        'charges', jsonb_agg(charge order by charge->>'service_date', charge->>'created_at', charge->>'charge_id')
      ) as row
    from source cross join lateral jsonb_array_elements(source.row->'charges') charge
    where source.row->>'destination_kind' = 'event'
    group by source.row->>'shop_id', source.row->>'event_participation_id'
  ), combined as (
    select row from source where row->>'destination_kind' is distinct from 'event'
    union all select row from events
  )
  select coalesce(jsonb_agg(row order by row->>'destination_kind', row->>'event_name',
    row->>'shop_code', row->>'queue_key'), '[]'::jsonb) into v_queue from combined;
  return jsonb_set(v_result, '{queue}', v_queue);
end;
$$;
revoke all on function public.get_daily_shop_collection_queue_v2(date) from public, anon;
grant execute on function public.get_daily_shop_collection_queue_v2(date) to authenticated;

-- A payment may pay its anchor day in full and leave debt on a later day.
-- Remaining rows must still see that payment for the "new charges" indicator.
do $latest_payment$
declare
  v_signature text;
  v_definition text;
  v_old text := 'payment.event_settlement_context_id is not distinct from context.id';
begin
  foreach v_signature in array array['public.get_collection_run_queue(uuid)',
    'public.get_collection_queue_for_date(date,uuid)'] loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    if strpos(v_definition, v_old) = 0 then raise exception 'Latest event payment boundary missing: %', v_signature; end if;
    execute replace(v_definition, v_old, '(payment.event_settlement_context_id is not distinct from context.id
      or (payment.event_collection and public.event_collection_context_matches(context.id, payment.event_settlement_context_id)))');
  end loop;
end;
$latest_payment$;

create or replace function public.record_event_collection_payment(
  p_expected_participation_id uuid,
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
  v_lock_date date;
begin
  if not public.is_active_user() or not public.can_collect_shop_payments() then
    raise exception 'The current user cannot collect event payments';
  elsif p_expected_participation_id is null
    or p_expected_policy_fingerprint is null
    or p_collection_run_id is null
    or p_expected_outstanding_amount is null
    or p_idempotency_key is null
    or p_payment_method is null then
    raise exception 'Event settlement identity, method, and idempotency key are required';
  elsif jsonb_typeof(p_allocations) is distinct from 'array'
    or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Payment allocations must be a non-empty JSON array';
  end if;

  -- PostgreSQL numeric NaN compares greater than zero, so positivity alone
  -- cannot validate money. Check every supplied amount before casting/summing.
  if p_received_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or p_expected_outstanding_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or exists (
      select 1 from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric)
      where item.amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    ) then
    raise exception 'Payment amounts must be finite';
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

  v_fingerprint := public.financial_payment_request_fingerprint_v2('event_collection', jsonb_build_object(
    'participation_id', p_expected_participation_id,
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
      or not v_payment.event_collection
      or v_payment.request_fingerprint is distinct from v_fingerprint then
      raise exception 'This idempotency key was already used for a different payment';
    end if;
    return public.financial_payment_write_response(v_payment.id);
  end if;

  -- Contexts and their participation/policy identities are immutable. Keep an
  -- anchor for existing history/receipt readers; each charge retains its own day.
  select context.* into v_context from public.event_settlement_contexts context
  join public.delivery_charges charge on charge.event_settlement_context_id = context.id
  join jsonb_to_recordset(v_canonical_allocations) requested(charge_id uuid, amount numeric)
    on requested.charge_id = charge.id
  where context.event_participation_id = p_expected_participation_id
    and context.settlement_policy_fingerprint = p_expected_policy_fingerprint
  order by context.service_date, context.id limit 1;
  if v_context.id is null then
    raise exception 'The event settlement context changed; refresh before recording payment';
  end if;

  -- Match legacy writers' date-before-shop order, taking multiple dates in a
  -- deterministic order. The shop lock serializes old and new collection APIs.
  for v_lock_date in select distinct context.service_date
    from public.event_settlement_contexts context
    where context.event_participation_id = p_expected_participation_id
    order by context.service_date
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_date::text, 0));
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_context.shop_id::text, 0));
  select run.service_date into v_run_service_date
  from public.collection_runs run where run.id = p_collection_run_id;
  if v_run_service_date is null then
    raise exception 'The collection context is stale or closed';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('collection-run:' || v_run_service_date::text, 0));
  if not public.can_use_collection_context(p_collection_run_id) then
    raise exception 'The collection context is stale or closed';
  end if;

  select * into v_participation from public.event_participations participation
  where participation.id = v_context.event_participation_id;
  if not coalesce(p_payment_method = any(v_participation.allowed_payment_methods_snapshot), false) then
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
      or charge.shop_id is distinct from v_context.shop_id
      or not public.event_collection_context_matches(charge.event_settlement_context_id, v_context.id)
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
  where charge.shop_id = v_context.shop_id
    and public.event_collection_context_matches(charge.event_settlement_context_id, v_context.id)
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
    operation_kind, event_settlement_context_id, request_fingerprint_version, event_collection
  ) values (
    v_context.shop_id, p_collection_run_id, p_payment_method,
    p_received_amount::numeric(12,2), v_allocated_amount, v_change_amount,
    v_reference, v_evidence, p_idempotency_key, v_fingerprint, auth.uid(),
    'event', v_context.id, 2, true
  ) returning * into v_payment;

  insert into public.payment_allocations (payment_id, charge_id, amount)
  select v_payment.id, item.charge_id, item.amount::numeric(12,2)
  from jsonb_to_recordset(v_canonical_allocations) item(charge_id uuid, amount numeric);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (auth.uid(), 'payments', v_payment.id, 'event_collection_created', jsonb_build_object(
    'event_settlement_context_id', v_context.id,
    'event_participation_id', v_context.event_participation_id,
    'service_date', v_context.service_date,
    'allocations', v_canonical_allocations
  ));
  return public.financial_payment_write_response(v_payment.id);
end;
$$;

-- Keep the same admin-only received-date authorization and replay checks.
do $backdated$
declare
  v_definition text := pg_get_functiondef('public.record_backdated_collection_payment(text,date,jsonb)'::regprocedure);
  v_start integer;
  v_end integer;
  v_case text;
begin
  v_start := strpos(v_definition, '    when ''record_event_payment'' then');
  v_end := strpos(substring(v_definition from v_start), '    else');
  if v_start = 0 or v_end = 0 then raise exception 'Backdated event dispatch not found'; end if;
  v_case := substring(v_definition from v_start for v_end - 1);
  v_case := replace(v_case, 'record_event_payment', 'record_event_collection_payment');
  v_case := replace(v_case, '        (p_payment_args ->> ''p_expected_settlement_context_id'')::uuid,' || E'\n', '');
  v_case := replace(v_case, '        (p_payment_args ->> ''p_expected_service_date'')::date,' || E'\n', '');
  execute overlay(v_definition placing v_case from v_start for 0);
end;
$backdated$;

revoke all on function public.record_event_collection_payment(uuid,text,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid)
  from public, anon;
grant execute on function public.record_event_collection_payment(uuid,text,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid)
  to authenticated;
notify pgrst, 'reload schema';
commit;
