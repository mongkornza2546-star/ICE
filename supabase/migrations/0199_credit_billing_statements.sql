-- Admin-issued credit billing statements. A statement can bring selected
-- future-due credit charges into collection without changing their due dates.

create table public.billing_statement_counters (
  period_month date primary key check (period_month = date_trunc('month', period_month)::date),
  last_sequence integer not null check (last_sequence between 0 and 99999)
);

create table public.billing_statements (
  id uuid primary key default gen_random_uuid(),
  statement_number text not null unique,
  shop_id uuid not null references public.shops(id),
  status text not null default 'active' check (status in ('active', 'voided')),
  issued_service_date date not null,
  issued_at timestamptz not null default now(),
  created_by uuid not null references public.users(id),
  voided_at timestamptz,
  voided_by uuid references public.users(id),
  void_reason text,
  check ((status = 'active' and voided_at is null and voided_by is null and void_reason is null)
    or (status = 'voided' and voided_at is not null and voided_by is not null
      and nullif(trim(void_reason), '') is not null))
);

create table public.billing_statement_items (
  billing_statement_id uuid not null references public.billing_statements(id),
  charge_id uuid not null references public.delivery_charges(id),
  billed_amount numeric(12,2) not null check (billed_amount > 0),
  active boolean not null default true,
  primary key (billing_statement_id, charge_id)
);

create unique index billing_statement_items_one_active_statement_idx
  on public.billing_statement_items(charge_id) where active;
create index billing_statements_shop_issued_idx
  on public.billing_statements(shop_id, issued_at desc);

alter table public.payments
  add column billing_statement_id uuid references public.billing_statements(id),
  -- Fingerprint of the caller's collection request, not the derived shop total
  -- passed to the mature writer. This keeps replay independent of live balances.
  add column collection_request_fingerprint text;
create index payments_billing_statement_idx
  on public.payments(billing_statement_id) where billing_statement_id is not null;

create function public.next_billing_statement_number(p_period_month date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_month date;
  v_sequence integer;
begin
  if p_period_month is null then raise exception 'Billing statement period is required'; end if;
  v_period_month := date_trunc('month', p_period_month)::date;
  insert into public.billing_statement_counters(period_month, last_sequence)
  values (v_period_month, 0) on conflict (period_month) do nothing;
  select counter.last_sequence into v_sequence
  from public.billing_statement_counters counter
  where counter.period_month = v_period_month for update;
  if v_sequence >= 99999 then raise exception 'Billing statement sequence exceeds 99999'; end if;
  update public.billing_statement_counters counter
  set last_sequence = counter.last_sequence + 1
  where counter.period_month = v_period_month
  returning counter.last_sequence into v_sequence;
  return 'BIL' || to_char(v_period_month, 'YYMM') || '-' || lpad(v_sequence::text, 5, '0');
end;
$$;

create function public.get_billing_statements(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view billing statements';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', statement.id,
      'statement_number', statement.statement_number,
      'shop_id', statement.shop_id,
      'shop_code', shop.code,
      'shop_name', shop.name,
      'shop_location', concat_ws(' · ', building.name, zone.name),
      'status', statement.status,
      'issued_service_date', statement.issued_service_date,
      'issued_at', statement.issued_at,
      'created_by_name', creator.display_name,
      'voided_at', statement.voided_at,
      'void_reason', statement.void_reason,
      'total_amount', totals.total_amount,
      'outstanding_amount', totals.outstanding_amount,
      'items', totals.items
    ) order by statement.issued_at desc)
    from public.billing_statements statement
    join public.shops shop on shop.id = statement.shop_id
    left join public.buildings building on building.id = shop.building_id
    left join public.building_zones zone on zone.id = shop.zone_id
    left join public.users creator on creator.id = statement.created_by
    join lateral (
      select
        sum(item.billed_amount)::numeric(12,2) as total_amount,
        sum(least(item.billed_amount, balance.outstanding_amount))::numeric(12,2) as outstanding_amount,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id,
          'charge_number', charge.charge_number,
          'service_date', charge.service_date,
          'due_date', charge.due_date,
          'billed_amount', item.billed_amount,
          'outstanding_amount', least(item.billed_amount, balance.outstanding_amount)
        ) order by charge.service_date, charge.created_at, charge.id) as items
      from public.billing_statement_items item
      join public.delivery_charges charge on charge.id = item.charge_id
      join lateral (
        select greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
          as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where item.billing_statement_id = statement.id
    ) totals on true
    where statement.shop_id = p_shop_id
  ), '[]'::jsonb);
end;
$$;

create function public.create_billing_statement(
  p_shop_id uuid,
  p_charge_ids uuid[],
  p_issued_service_date date default ((clock_timestamp() at time zone 'Asia/Bangkok')::date)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_statement public.billing_statements%rowtype;
  v_requested_count integer;
  v_valid_count integer;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can create a billing statement';
  elsif p_shop_id is null or p_issued_service_date is null
    or coalesce(cardinality(p_charge_ids), 0) = 0 then
    raise exception 'Shop, issue date, and at least one bill are required';
  elsif p_issued_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'Billing statements must be issued for today';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));
  select count(distinct requested.charge_id) into v_requested_count from unnest(p_charge_ids) requested(charge_id);
  perform 1 from public.delivery_charges charge
  where charge.id = any(p_charge_ids) order by charge.id for update;

  select count(*) into v_valid_count
  from public.delivery_charges charge
  join lateral (
    select greatest(public.effective_delivery_charge_amount(charge.id)
      - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
      as outstanding_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id
  ) balance on true
  where charge.id = any(p_charge_ids)
    and charge.shop_id = p_shop_id
    and charge.payment_term = 'credit'
    and charge.status = 'active'
    and balance.outstanding_amount > 0
    and not exists (
      select 1 from public.billing_statement_items item
      where item.charge_id = charge.id and item.active
    );
  if v_valid_count <> v_requested_count then
    raise exception 'One or more selected bills are invalid, paid, or already on an active billing statement';
  end if;

  insert into public.billing_statements(
    statement_number, shop_id, issued_service_date, created_by
  ) values (
    public.next_billing_statement_number(p_issued_service_date),
    p_shop_id, p_issued_service_date, auth.uid()
  ) returning * into v_statement;

  insert into public.billing_statement_items(billing_statement_id, charge_id, billed_amount)
  select v_statement.id, charge.id, balance.outstanding_amount
  from public.delivery_charges charge
  join lateral (
    select greatest(public.effective_delivery_charge_amount(charge.id)
      - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
      as outstanding_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id
  ) balance on true
  where charge.id = any(p_charge_ids);

  return (public.get_billing_statements(p_shop_id)->0);
end;
$$;

create function public.void_billing_statement(p_billing_statement_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_statement public.billing_statements%rowtype;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can void a billing statement';
  elsif nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A void reason is required';
  end if;
  select * into v_statement from public.billing_statements
  where id = p_billing_statement_id for update;
  if v_statement.id is null then raise exception 'Billing statement not found';
  elsif v_statement.status <> 'active' then raise exception 'Billing statement is already voided'; end if;
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_statement.shop_id::text, 0));
  update public.billing_statements set status = 'voided', voided_at = now(),
    voided_by = auth.uid(), void_reason = trim(p_reason)
  where id = p_billing_statement_id;
  update public.billing_statement_items set active = false
  where billing_statement_id = p_billing_statement_id;
  return (select item from jsonb_array_elements(public.get_billing_statements(v_statement.shop_id)) item
    where item->>'id' = p_billing_statement_id::text limit 1);
end;
$$;

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
    join public.collection_runs run on run.id = p_collection_run_id and run.status = 'open'
    where charge.id = p_charge_id
      and charge.status = 'active'
      and (charge.event_settlement_context_id is null or charge.service_date <= run.service_date)
      and (
        charge.payment_term in ('immediate', 'end_of_day')
        or (charge.payment_term = 'credit' and (
          charge.due_date <= run.service_date
          or exists (
            select 1
            from public.billing_statement_items item
            join public.billing_statements statement on statement.id = item.billing_statement_id
            where item.charge_id = charge.id and item.active
              and statement.status = 'active'
              and statement.issued_service_date <= run.service_date
          )
        ))
      )
  );
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
  if not public.is_active_user() then raise exception 'An active user is required to view shop collections'; end if;
  select run.service_date into v_service_date from public.collection_runs run
  where run.id = p_collection_run_id and run.status = 'open';
  if v_service_date is null
    or v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or exists (select 1 from public.daily_aggregate_stock_closures closure where closure.service_date = v_service_date)
  then raise exception 'The collection context is stale or closed'; end if;

  return coalesce((select jsonb_agg(jsonb_build_object(
    'queue_key', queue.queue_key,
    'destination_kind', queue.destination_kind,
    'billing_statement_id', queue.billing_statement_id,
    'billing_statement_number', queue.billing_statement_number,
    'event_settlement_context_id', queue.event_settlement_context_id,
    'event_participation_id', queue.event_participation_id,
    'settlement_service_date', queue.settlement_service_date,
    'settlement_policy_fingerprint', queue.settlement_policy_fingerprint,
    'event_name', queue.event_name, 'event_location', queue.event_location,
    'event_zone', queue.event_zone, 'event_booth', queue.event_booth,
    'shop_id', queue.shop_id, 'shop_code', queue.shop_code, 'shop_name', queue.shop_name,
    'building_id', queue.building_id, 'building_name', queue.building_name,
    'zone_id', queue.zone_id, 'zone_name', queue.zone_name, 'image_path', queue.image_path,
    'outstanding_amount', queue.outstanding_amount, 'charge_count', queue.charge_count,
    'latest_charge_at', queue.latest_charge_at, 'latest_payment_at', queue.latest_payment_at,
    'has_new_charges', queue.latest_payment_at is not null and queue.latest_charge_at > queue.latest_payment_at,
    'payment_profile', queue.payment_profile, 'charges', queue.charges
  ) order by queue.destination_kind, queue.event_name nulls first, queue.shop_code, queue.queue_key)
  from (
    select
      case when context.id is not null then 'event:' || context.id::text
        when statement.id is not null then 'billing:' || statement.id::text
        else 'regular:' || shop.id::text end as queue_key,
      case when context.id is null then 'regular' else 'event' end as destination_kind,
      statement.id as billing_statement_id,
      statement.statement_number as billing_statement_number,
      context.id as event_settlement_context_id,
      context.event_participation_id, context.service_date as settlement_service_date,
      context.settlement_policy_fingerprint,
      min(coalesce(stop.event_job_name_snapshot, job.name)) as event_name,
      min(coalesce(stop.event_location_snapshot, job.location)) as event_location,
      min(coalesce(stop.event_zone_snapshot, participation.event_zone)) as event_zone,
      min(coalesce(stop.event_booth_snapshot, participation.booth_number)) as event_booth,
      shop.id as shop_id, shop.code as shop_code, shop.name as shop_name,
      case when context.id is null then shop.building_id else null end as building_id,
      case when context.id is null then building.name else min(coalesce(stop.event_location_snapshot, job.location)) end as building_name,
      case when context.id is null then shop.zone_id else null end as zone_id,
      case when context.id is null then zone.name else min(coalesce(stop.event_zone_snapshot, participation.event_zone)) end as zone_name,
      case when context.id is null then shop.image_path else null end as image_path,
      sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
      count(*)::integer as charge_count, max(charge.created_at) as latest_charge_at,
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
      (select max(payment.recorded_at) from public.payments payment
        where payment.collection_run_id = p_collection_run_id and payment.status = 'active'
          and payment.shop_id = shop.id
          and payment.event_settlement_context_id is not distinct from context.id
          and payment.billing_statement_id is not distinct from statement.id) as latest_payment_at,
      jsonb_agg(jsonb_build_object(
        'charge_id', charge.id, 'charge_number', charge.charge_number,
        'delivery_event_id', charge.delivery_event_id, 'service_date', charge.service_date,
        'payment_term', charge.payment_term, 'due_date', charge.due_date,
        'original_amount', public.effective_delivery_charge_amount(charge.id),
        'base_amount', charge.original_amount, 'outstanding_amount', balance.outstanding_amount,
        'created_at', charge.created_at, 'items', public.charge_line_items(charge.id)
      ) order by charge.created_at, charge.id) as charges
    from public.delivery_charges charge
    left join public.delivery_events event on event.id = charge.delivery_event_id
    left join public.round_stops stop on stop.id = event.round_stop_id
    join public.shops shop on shop.id = charge.shop_id
    left join public.buildings building on building.id = shop.building_id
    left join public.building_zones zone on zone.id = shop.zone_id
    left join public.shop_payment_profiles profile on profile.shop_id = shop.id
    left join public.event_settlement_contexts context on context.id = charge.event_settlement_context_id
    left join public.event_participations participation on participation.id = context.event_participation_id
    left join public.event_jobs job on job.id = participation.event_job_id
    left join public.billing_statement_items statement_item
      on statement_item.charge_id = charge.id and statement_item.active and context.id is null
    left join public.billing_statements statement
      on statement.id = statement_item.billing_statement_id and statement.status = 'active'
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
    group by shop.id, building.id, zone.id, profile.id, context.id, participation.id, job.id,
      statement.id, statement.statement_number
  ) queue), '[]'::jsonb);
end;
$$;

-- Keep the mature writer private. All public collection entry points must
-- enforce statement isolation; immediate payments still use record_payment.
alter function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) rename to record_payment_before_billing_statements;
revoke all on function public.record_payment_before_billing_statements(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) from public, anon, authenticated;

create function public.record_payment(
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
  v_payment public.payments%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_payment from public.payments where idempotency_key = p_idempotency_key;
  if v_payment.id is not null then
    if v_payment.collection_request_fingerprint is not null or v_payment.billing_statement_id is not null then
      raise exception 'This idempotency key was already used for a different payment';
    end if;
    -- The private writer authenticates legacy replays before current-state gates.
  else
    perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));
    if exists (
      select 1 from jsonb_to_recordset(p_allocations) requested(charge_id uuid, amount numeric)
      join public.billing_statement_items item on item.charge_id = requested.charge_id and item.active
    ) then raise exception 'Billing-statement bills must be paid from their billing-statement queue'; end if;
  end if;
  return public.record_payment_before_billing_statements(
    p_shop_id, p_allocations, p_payment_method, p_received_amount,
    p_reference_number, p_evidence_path, p_collection_run_id,
    p_expected_outstanding_amount, p_approval_id, p_idempotency_key
  );
end;
$$;

-- Shared, private collection boundary: replay first, then scope/balance checks,
-- then the existing writer. Statement and regular requests share lock ordering.
create function public.record_collection_payment_for_billing(
  p_shop_id uuid,
  p_billing_statement_id uuid,
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
  v_payment public.payments%rowtype;
  v_statement public.billing_statements%rowtype;
  v_fingerprint text;
  v_expected_outstanding numeric(12,2);
  v_collectible_outstanding numeric(12,2);
  v_result jsonb;
begin
  if not public.is_active_user() then raise exception 'An active user is required';
  elsif p_shop_id is null or p_idempotency_key is null or p_collection_run_id is null
    or p_expected_outstanding_amount is null then
    raise exception 'Shop, collection run, expected balance, and idempotency key are required';
  elsif jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Payment allocations must be a non-empty JSON array';
  end if;
  select jsonb_agg(jsonb_build_object('charge_id', item.charge_id,
    'amount', item.amount::numeric(12,2)) order by item.charge_id)
  into p_allocations
  from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric);
  v_fingerprint := public.financial_payment_request_fingerprint_v2('collection', jsonb_build_object(
    'shop_id', p_shop_id,
    'billing_statement_id', p_billing_statement_id,
    'allocations', p_allocations,
    'payment_method', p_payment_method,
    'received_amount', p_received_amount::numeric(12,2),
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
    elsif v_payment.collection_request_fingerprint is distinct from v_fingerprint
      or v_payment.billing_statement_id is distinct from p_billing_statement_id then
      raise exception 'This idempotency key was already used for a different payment';
    end if;
    v_result := public.financial_payment_response(v_payment.id);
  else
    perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));
    if p_billing_statement_id is not null then
      select * into v_statement from public.billing_statements
      where id = p_billing_statement_id and shop_id = p_shop_id and status = 'active';
      if v_statement.id is null then raise exception 'Billing statement is not active'; end if;
      if exists (
        select 1 from jsonb_to_recordset(p_allocations) requested(charge_id uuid, amount numeric)
        left join public.billing_statement_items item
          on item.billing_statement_id = p_billing_statement_id
          and item.charge_id = requested.charge_id and item.active
        where item.charge_id is null
      ) then raise exception 'The payment contains a bill outside the billing statement'; end if;
    elsif exists (
      select 1 from jsonb_to_recordset(p_allocations) requested(charge_id uuid, amount numeric)
      join public.billing_statement_items item on item.charge_id = requested.charge_id and item.active
    ) then raise exception 'Billing-statement bills must be paid from their billing-statement queue'; end if;

    select
      coalesce(sum(balance.outstanding_amount) filter (
        where charge.event_settlement_context_id is null
          and item.billing_statement_id is not distinct from p_billing_statement_id
      ), 0)::numeric(12,2),
      coalesce(sum(balance.outstanding_amount), 0)::numeric(12,2)
    into v_expected_outstanding, v_collectible_outstanding
    from public.delivery_charges charge
    left join public.billing_statement_items item on item.charge_id = charge.id and item.active
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

    v_result := public.record_payment_before_billing_statements(
      p_shop_id, p_allocations, p_payment_method, p_received_amount,
      p_reference_number, p_evidence_path, p_collection_run_id,
      v_collectible_outstanding, null, p_idempotency_key
    );
    update public.payments set billing_statement_id = p_billing_statement_id,
      collection_request_fingerprint = v_fingerprint
    where id = (v_result->>'payment_id')::uuid;
  end if;
  if p_billing_statement_id is not null then
    return v_result || jsonb_build_object(
      'billing_statement_id', p_billing_statement_id,
      'billing_statement_number', (select statement_number from public.billing_statements where id = p_billing_statement_id)
    );
  end if;
  return v_result;
end;
$$;

create function public.record_regular_collection_payment(
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
begin
  if p_approval_id is not null then
    raise exception 'Collection payments cannot use an immediate-payment approval';
  end if;
  return public.record_collection_payment_for_billing(
    p_shop_id, null, p_allocations, p_payment_method, p_received_amount,
    p_reference_number, p_evidence_path, p_collection_run_id,
    p_expected_outstanding_amount, p_idempotency_key
  );
end;
$$;

create function public.record_billing_statement_payment(
  p_billing_statement_id uuid,
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
  v_shop_id uuid;
begin
  -- Read identity even for a voided statement so committed payments can replay.
  select shop_id into v_shop_id from public.billing_statements where id = p_billing_statement_id;
  if v_shop_id is null then raise exception 'Billing statement not found'; end if;
  return public.record_collection_payment_for_billing(
    v_shop_id, p_billing_statement_id, p_allocations, p_payment_method, p_received_amount,
    p_reference_number, p_evidence_path, p_collection_run_id,
    p_expected_outstanding_amount, p_idempotency_key
  );
end;
$$;

-- Extend the existing deferred integrity checks, which already cover charges,
-- payments, allocations, and adjustments. Only payments linked to this statement
-- may change its balance; other corrections require void/reissue first.
alter function public.assert_charge_allocation_integrity(uuid)
  rename to assert_charge_allocation_integrity_before_billing;
revoke all on function public.assert_charge_allocation_integrity_before_billing(uuid)
  from public, anon, authenticated;
create function public.assert_charge_allocation_integrity(target_charge_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_charge_allocation_integrity_before_billing(target_charge_id);
  if exists (
    select 1 from public.billing_statement_items item
    join public.delivery_charges charge on charge.id = item.charge_id
    where item.charge_id = target_charge_id and item.active
      and (charge.status <> 'active' or charge.event_settlement_context_id is not null
        or public.effective_delivery_charge_amount(charge.id) - coalesce((
          select sum(allocation.amount)
          from public.payment_allocations allocation
          join public.payments payment on payment.id = allocation.payment_id
          where allocation.charge_id = charge.id and payment.status = 'active'
            and payment.billing_statement_id is distinct from item.billing_statement_id
        ), 0) <> item.billed_amount)
  ) then
    raise exception 'Void the active billing statement first, then correct the bill or payment and reissue';
  end if;
end;
$$;
revoke all on function public.assert_charge_allocation_integrity(uuid) from public, anon, authenticated;
revoke all on function public.record_collection_payment_for_billing(
  uuid, uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid
) from public, anon, authenticated;
revoke all on function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) from public, anon;
grant execute on function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) to authenticated;

alter table public.billing_statements enable row level security;
alter table public.billing_statement_items enable row level security;

revoke all on table public.billing_statement_counters, public.billing_statements,
  public.billing_statement_items from public, anon, authenticated;
revoke all on function public.next_billing_statement_number(date) from public, anon, authenticated;
revoke all on function public.get_billing_statements(uuid) from public, anon;
revoke all on function public.create_billing_statement(uuid, uuid[], date) from public, anon;
revoke all on function public.void_billing_statement(uuid, text) from public, anon;
revoke all on function public.record_billing_statement_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid
) from public, anon;
revoke all on function public.record_regular_collection_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) from public, anon;
grant execute on function public.get_billing_statements(uuid) to authenticated;
grant execute on function public.create_billing_statement(uuid, uuid[], date) to authenticated;
grant execute on function public.void_billing_statement(uuid, text) to authenticated;
grant execute on function public.record_billing_statement_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid
) to authenticated;
grant execute on function public.record_regular_collection_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) to authenticated;

notify pgrst, 'reload schema';
