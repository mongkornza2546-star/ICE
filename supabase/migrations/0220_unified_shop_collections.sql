-- Keep the legacy statement-specific APIs for older clients and receipt retries.
-- The new collection screen uses one regular-shop queue and one atomic payment.
alter table public.payment_allocations
  add column billing_statement_id uuid references public.billing_statements(id);

-- Capture membership when money is allocated, not when a statement is later
-- reissued. Legacy allocations keep using payments.billing_statement_id.
create function public.snapshot_allocation_billing_statement()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.billing_statement_id is distinct from old.billing_statement_id then
      raise exception 'Allocation billing statement snapshots are immutable';
    end if;
    return new;
  end if;
  select item.billing_statement_id into new.billing_statement_id
  from public.billing_statement_items item
  join public.billing_statements statement on statement.id = item.billing_statement_id
  where item.charge_id = new.charge_id and item.active and statement.status = 'active';
  return new;
end;
$$;
create trigger payment_allocations_billing_snapshot
before insert or update on public.payment_allocations
for each row execute function public.snapshot_allocation_billing_statement();
revoke all on function public.snapshot_allocation_billing_statement() from public, anon, authenticated;

-- Preserve the existing correction/reissue invariant, including payments made
-- before a statement was issued, and payments on a now-replaced statement.
do $allocation_scope$
declare
  v_definition text := pg_get_functiondef('public.assert_charge_allocation_integrity(uuid)'::regprocedure);
  v_old text := 'payment.billing_statement_id is distinct from item.billing_statement_id';
begin
  if strpos(v_definition, v_old) = 0 then raise exception 'Billing allocation guard not found'; end if;
  execute replace(v_definition, v_old,
    'coalesce(allocation.billing_statement_id, payment.billing_statement_id) is distinct from item.billing_statement_id');
end;
$allocation_scope$;

-- Allocation inserts now reference statement rows. Use the same shop-first
-- lock order as collection/issuance before locking the statement to void it.
do $void_lock_order$
declare
  v_definition text := pg_get_functiondef('public.void_billing_statement(uuid,text)'::regprocedure);
  v_lock text := '  perform pg_advisory_xact_lock(hashtextextended(''financial-shop:'' || v_statement.shop_id::text, 0));';
  v_select text := '  select * into v_statement from public.billing_statements';
begin
  if strpos(v_definition, v_lock) = 0 or strpos(v_definition, v_select) = 0 then
    raise exception 'Billing statement void lock boundary not found';
  end if;
  v_definition := replace(v_definition, v_lock, '');
  execute replace(v_definition, v_select,
    '  select * into v_statement from public.billing_statements where id = p_billing_statement_id;' || E'\n'
    || v_lock || E'\n' || v_select);
end;
$void_lock_order$;

create function public.get_shop_collection_queue(p_collection_run_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  -- Reuse the authorized queue, including due-date eligibility, VAT and event
  -- scopes. Statement identity moves from the queue row to each charge.
  with source as materialized (
    select value as row from jsonb_array_elements(public.get_collection_run_queue(p_collection_run_id))
  ), regular as (
    select (jsonb_agg(source.row - 'charges')->0) || jsonb_build_object(
      'queue_key', 'regular:' || (source.row->>'shop_id'),
      'collection_scope', 'shop',
      'billing_statement_id', null, 'billing_statement_number', null,
      'outstanding_amount', sum((charge->>'outstanding_amount')::numeric),
      'charge_count', count(*),
      'latest_charge_at', max(source.row->>'latest_charge_at'),
      'charges', jsonb_agg(charge || jsonb_build_object(
        'billing_statement_id', source.row->'billing_statement_id',
        'billing_statement_number', source.row->'billing_statement_number'
      ) order by charge->>'created_at', charge->>'charge_id')
    ) as row
    from source cross join lateral jsonb_array_elements(source.row->'charges') charge
    where source.row->>'destination_kind' = 'regular'
    group by source.row->>'shop_id'
  ), combined as (
    select row || jsonb_build_object(
      'latest_payment_at', latest.recorded_at,
      'has_new_charges', latest.recorded_at is not null
        and (row->>'latest_charge_at')::timestamptz > latest.recorded_at
    ) as row from regular
    left join lateral (
      select max(payment.recorded_at) as recorded_at from public.payments payment
      where payment.shop_id = (row->>'shop_id')::uuid and payment.status = 'active'
        and payment.collection_run_id = p_collection_run_id
        and payment.event_settlement_context_id is null
    ) latest on true
    union all
    select row from source where row->>'destination_kind' = 'event'
  )
  select coalesce(jsonb_agg(row order by row->>'destination_kind', row->>'event_name',
    row->>'shop_code', row->>'queue_key'), '[]'::jsonb) from combined;
$$;

create function public.record_shop_collection_payment(
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
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_payment public.payments%rowtype;
  v_fingerprint text;
  v_expected_outstanding numeric(12,2);
  v_collectible_outstanding numeric(12,2);
  v_result jsonb;
begin
  if not public.is_active_user() then raise exception 'An active user is required';
  elsif p_shop_id is null or p_idempotency_key is null or p_collection_run_id is null
    or p_expected_outstanding_amount is null then
    raise exception 'Shop, collection run, expected balance, and idempotency key are required';
  elsif p_approval_id is not null then
    raise exception 'Collection payments cannot use an immediate-payment approval';
  elsif jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Payment allocations must be a non-empty JSON array';
  end if;
  select jsonb_agg(jsonb_build_object('charge_id', item.charge_id,
    'amount', item.amount::numeric(12,2)) order by item.charge_id)
  into p_allocations from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric);
  v_fingerprint := public.financial_payment_request_fingerprint_v2('shop_collection', jsonb_build_object(
    'shop_id', p_shop_id, 'allocations', p_allocations,
    'payment_method', p_payment_method, 'received_amount', p_received_amount::numeric(12,2),
    'reference_number', nullif(trim(coalesce(p_reference_number, '')), ''),
    'evidence_path', nullif(trim(coalesce(p_evidence_path, '')), ''),
    'collection_run_id', p_collection_run_id,
    'expected_outstanding_amount', p_expected_outstanding_amount::numeric(12,2)
  ));
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_payment from public.payments where idempotency_key = p_idempotency_key;
  if v_payment.id is not null then
    if not public.is_payment_visible(v_payment.id) then
      raise exception 'This payment cannot be viewed by the current user';
    elsif v_payment.collection_request_fingerprint is distinct from v_fingerprint then
      raise exception 'This idempotency key was already used for a different payment';
    end if;
    return public.financial_payment_write_response(v_payment.id);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));
  select coalesce(sum(balance.outstanding_amount) filter (
      where charge.event_settlement_context_id is null), 0)::numeric(12,2),
    coalesce(sum(balance.outstanding_amount), 0)::numeric(12,2)
  into v_expected_outstanding, v_collectible_outstanding
  from public.delivery_charges charge
  join lateral (
    select greatest(public.effective_delivery_charge_amount(charge.id)
      - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
      as outstanding_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id
  ) balance on true
  where charge.shop_id = p_shop_id
    and public.is_charge_collectible_in_run(charge.id, p_collection_run_id);
  if v_expected_outstanding <> p_expected_outstanding_amount::numeric(12,2) then
    raise exception 'Collection outstanding changed; refresh before recording payment';
  end if;
  -- The mature writer still enforces permissions, dates, evidence, charge/shop
  -- scope, event exclusion, duplicate allocations and the latest charge balance.
  v_result := public.record_payment_before_billing_statements(
    p_shop_id, p_allocations, p_payment_method, p_received_amount,
    p_reference_number, p_evidence_path, p_collection_run_id,
    v_collectible_outstanding, null, p_idempotency_key
  );
  update public.payments set collection_request_fingerprint = v_fingerprint
  where id = (v_result->>'payment_id')::uuid;
  return v_result;
end;
$$;

-- Reuse the existing admin-only historical payment boundary and date replay
-- guard; only add the new writer to its explicit allowlist.
do $backdated_shop_collection$
declare
  v_definition text := pg_get_functiondef('public.record_backdated_collection_payment(text,date,jsonb)'::regprocedure);
  v_case text;
begin
  v_case := substring(v_definition from position('    when ''record_regular_collection_payment'' then' in v_definition)
    for position('    when ''record_billing_statement_payment'' then' in v_definition)
      - position('    when ''record_regular_collection_payment'' then' in v_definition));
  if v_case is null or length(v_case) = 0 then raise exception 'Backdated collection dispatch not found'; end if;
  execute replace(v_definition, v_case, replace(v_case,
    'record_regular_collection_payment', 'record_shop_collection_payment') || v_case);
end;
$backdated_shop_collection$;

revoke all on function public.get_shop_collection_queue(uuid) from public, anon;
grant execute on function public.get_shop_collection_queue(uuid) to authenticated;
revoke all on function public.record_shop_collection_payment(
  uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid
) from public, anon;
grant execute on function public.record_shop_collection_payment(
  uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid
) to authenticated;
notify pgrst, 'reload schema';
