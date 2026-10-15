-- Include courier walk-in cash in the same close as regular customer payments.
-- Keep all existing closed snapshots intact; only open days use the new sources.
-- Casual refunds are signed cash movements of the confirming employee on the
-- transaction's service date (the write RPC disallows refunds after that close).
-- Unlike payments, casual records do not store the actor's role at receipt time;
-- eligibility uses the existing user role until the daily snapshot is frozen.

create function public.daily_close_cash_sources(p_service_date date)
returns table (
  source_kind text, source_id uuid, employee_id uuid,
  cash_amount numeric, source_snapshot jsonb
)
language sql
stable
set search_path = public
as $$
  select 'payment'::text, payment.id, payment.recorded_by,
    payment.allocated_amount, null::jsonb
  from public.payments payment
  left join public.collection_runs run on run.id = payment.collection_run_id
  where coalesce(run.service_date,
    (payment.recorded_at at time zone 'Asia/Bangkok')::date) = p_service_date
    and payment.status = 'active' and payment.payment_method = 'cash'
    and payment.recorded_role = 'courier' and payment.allocated_amount > 0
  union all
  -- A void does not undo the original receipt: a transfer refund still leaves
  -- the original cash with the courier. Subtract cash refunds separately below.
  select 'casual_receipt', sale.id, sale.recorded_by,
    sale.sale_amount, to_jsonb(sale)
  from public.casual_transactions sale
  join public.users recorder on recorder.id = sale.recorded_by
  where sale.service_date = p_service_date and sale.transaction_kind = 'paid'
    and sale.payment_method = 'cash' and recorder.role = 'courier'
  union all
  select 'casual_refund', sale.id, refund.confirmed_by,
    -refund.refunded_amount, to_jsonb(refund)
  from public.casual_refund_confirmations refund
  join public.casual_transactions sale on sale.id = refund.transaction_id
  join public.users recorder on recorder.id = refund.confirmed_by
  where sale.service_date = p_service_date
    and refund.refund_method = 'cash' and recorder.role = 'courier';
$$;
revoke all on function public.daily_close_cash_sources(date) from public, anon, authenticated;

-- Net expected cash may be negative when a courier refunds a transfer in cash.
-- Actual physical counts remain non-negative and differences still need reasons.
alter table public.daily_close_employee_snapshots
  drop constraint daily_close_employee_snapshots_expected_cash_amount_check;

create table public.daily_close_casual_cash_items (
  service_date date not null,
  employee_id uuid not null,
  transaction_id uuid not null references public.casual_transactions(id) on delete restrict,
  source_kind text not null check (source_kind in ('casual_receipt', 'casual_refund')),
  cash_amount numeric(12,2) not null,
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  primary key (service_date, employee_id, transaction_id, source_kind),
  foreign key (service_date, employee_id)
    references public.daily_close_employee_snapshots(service_date, employee_id) on delete restrict,
  check ((source_kind = 'casual_receipt' and cash_amount > 0)
    or (source_kind = 'casual_refund' and cash_amount < 0))
);
create trigger daily_close_casual_cash_items_are_immutable
before update or delete on public.daily_close_casual_cash_items
for each row execute function public.guard_daily_close_snapshot();
alter table public.daily_close_casual_cash_items enable row level security;
create policy "managers read daily close casual cash items"
  on public.daily_close_casual_cash_items for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
revoke all on table public.daily_close_casual_cash_items from public, anon, authenticated;
grant select on table public.daily_close_casual_cash_items to authenticated;

-- Preserve the existing stock/collection-close implementation as a private core.
-- The legacy public entry point must enforce the feature gate on the server,
-- including callers whose page was loaded before activation.
alter function public.close_daily_aggregate_stock(date, jsonb, text, uuid)
  rename to close_daily_aggregate_stock_internal;
revoke all on function public.close_daily_aggregate_stock_internal(date, jsonb, text, uuid)
  from public, anon, authenticated;

create function public.close_daily_aggregate_stock(
  p_service_date date,
  p_counts jsonb,
  p_note text default null,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close daily aggregate stock';
  elsif p_service_date is null or p_idempotency_key is null then
    raise exception 'Service date and idempotency key are required';
  end if;
  -- Keep the same lock ordering as close v2 and the stock core.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));
  if exists (
    select 1 from public.daily_close_reconciliation_configuration
    where singleton and enabled_from_service_date is not null
      and p_service_date >= enabled_from_service_date
  ) then
    raise exception 'Daily cash reconciliation is enabled; use close_daily_reconciliation_v2';
  end if;
  return public.close_daily_aggregate_stock_internal(
    p_service_date, p_counts, p_note, p_idempotency_key
  );
end;
$$;
revoke all on function public.close_daily_aggregate_stock(date, jsonb, text, uuid) from public, anon;
grant execute on function public.close_daily_aggregate_stock(date, jsonb, text, uuid) to authenticated;

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
    select app_user.id, app_user.display_name, app_user.is_active
    from public.users app_user
    cross join reconciliation_state state
    where not state.is_closed
      and app_user.role = 'courier' and app_user.is_active
    union
    select app_user.id, app_user.display_name, app_user.is_active
    from cash_sources payment
    join public.users app_user on app_user.id = payment.employee_id
    cross join reconciliation_state state
    where not state.is_closed
    union
    select app_user.id, app_user.display_name, app_user.is_active
    from public.daily_close_employee_snapshots snapshot
    join public.users app_user on app_user.id = snapshot.employee_id
    where snapshot.service_date = v_service_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'employee_id', employee.id,
    'employee_name', employee.display_name,
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

create or replace function public.close_daily_reconciliation_v2(
  p_service_date date,
  p_stock_counts jsonb,
  p_cash_counts jsonb,
  p_stock_note text default null,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled_from date;
  v_request_fingerprint text;
  v_existing_request public.daily_close_reconciliation_requests%rowtype;
  v_stock_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close daily reconciliation';
  elsif p_service_date is null or p_idempotency_key is null then
    raise exception 'Service date and idempotency key are required';
  elsif jsonb_typeof(p_stock_counts) is distinct from 'array'
    or jsonb_typeof(p_cash_counts) is distinct from 'array' then
    raise exception 'Stock counts and cash counts must be JSON arrays';
  end if;

  select configuration.enabled_from_service_date into v_enabled_from
  from public.daily_close_reconciliation_configuration configuration
  where configuration.singleton;
  if v_enabled_from is null or p_service_date < v_enabled_from then
    raise exception 'Daily close reconciliation is not enabled for this service date';
  end if;

  select md5(jsonb_build_object(
    'operation', 'close_daily_reconciliation_v2',
    'service_date', p_service_date,
    'stock_counts', (select coalesce(jsonb_agg(to_jsonb(input) order by input.ice_type_id), '[]'::jsonb)
      from jsonb_to_recordset(p_stock_counts)
        input(ice_type_id uuid, actual_quantity numeric, note text)),
    'cash_counts', (select coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', input.employee_id,
      'actual_cash_amount', input.actual_cash_amount::numeric(12,2),
      'reason', nullif(trim(coalesce(input.reason, '')), '')
    ) order by input.employee_id), '[]'::jsonb)
      from jsonb_to_recordset(p_cash_counts)
        input(employee_id uuid, actual_cash_amount numeric, reason text)),
    'stock_note', nullif(trim(coalesce(p_stock_note, '')), '')
  )::text) into v_request_fingerprint;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_existing_request
  from public.daily_close_reconciliation_requests request
  where request.idempotency_key = p_idempotency_key;
  if v_existing_request.idempotency_key is not null then
    if v_existing_request.service_date <> p_service_date
      or v_existing_request.request_fingerprint is distinct from v_request_fingerprint then
      raise exception 'This idempotency key belongs to another daily close request';
    end if;
    return public.get_daily_close_reconciliation(p_service_date);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('collection-run:' || p_service_date::text, 0));

  if exists (
    select 1 from public.daily_close_reconciliation_requests request
    where request.service_date = p_service_date
  ) then
    raise exception 'Daily reconciliation for this service date is already closed';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_cash_counts)
      input(employee_id uuid, actual_cash_amount numeric, reason text)
    where input.employee_id is null or input.actual_cash_amount is null
      or input.actual_cash_amount < 0
  ) or exists (
    select 1
    from jsonb_to_recordset(p_cash_counts)
      input(employee_id uuid, actual_cash_amount numeric, reason text)
    group by input.employee_id having count(*) > 1
  ) then
    raise exception 'Provide one non-negative cash count for every employee';
  end if;

  if exists (
    with accountable as (
      select source.employee_id, sum(source.cash_amount)::numeric(12,2) expected
      from public.daily_close_cash_sources(p_service_date) source
      group by source.employee_id
    ), eligible as (
      select app_user.id employee_id
      from public.users app_user
      where app_user.role = 'courier' and app_user.is_active
      union select employee_id from accountable
    ), supplied as (
      select input.employee_id, input.actual_cash_amount, input.reason
      from jsonb_to_recordset(p_cash_counts)
        input(employee_id uuid, actual_cash_amount numeric, reason text)
    )
    select 1 from eligible
    full join supplied using (employee_id)
    left join accountable using (employee_id)
    where eligible.employee_id is null or supplied.employee_id is null
      or (supplied.actual_cash_amount <> coalesce(accountable.expected, 0)
        and nullif(trim(coalesce(supplied.reason, '')), '') is null)
  ) then
    raise exception 'A cash variance reason is required and every eligible employee must be included';
  end if;

  insert into public.daily_close_reconciliation_requests (
    idempotency_key, service_date, request_fingerprint, recorded_by
  ) values (
    p_idempotency_key, p_service_date, v_request_fingerprint, auth.uid()
  );

  v_stock_result := public.close_daily_aggregate_stock_internal(
    p_service_date, p_stock_counts, p_stock_note, p_idempotency_key
  );

  with accountable as materialized (
    select source.employee_id, sum(source.cash_amount)::numeric(12,2) expected
    from public.daily_close_cash_sources(p_service_date) source
    group by source.employee_id
  )
  insert into public.daily_close_employee_snapshots (
    service_date, employee_id, expected_cash_amount, actual_cash_amount,
    cash_reason, recorded_by, request_idempotency_key
  )
  select p_service_date, input.employee_id, coalesce(accountable.expected, 0),
    input.actual_cash_amount, nullif(trim(coalesce(input.reason, '')), ''),
    auth.uid(), p_idempotency_key
  from jsonb_to_recordset(p_cash_counts)
    input(employee_id uuid, actual_cash_amount numeric, reason text)
  left join accountable using (employee_id);

  insert into public.daily_close_payment_items (
    service_date, employee_id, payment_id, allocated_amount, payment_fingerprint
  )
  select p_service_date, payment.recorded_by, payment.id, payment.allocated_amount,
    public.daily_close_payment_fingerprint(
      payment.id, payment.status, payment.payment_method, payment.allocated_amount,
      payment.recorded_by, payment.recorded_role,
      coalesce(run.service_date, (payment.recorded_at at time zone 'Asia/Bangkok')::date)
    )
  from public.payments payment
  left join public.collection_runs run on run.id = payment.collection_run_id
  where coalesce(run.service_date,
    (payment.recorded_at at time zone 'Asia/Bangkok')::date) = p_service_date
    and payment.status = 'active' and payment.payment_method = 'cash'
    and payment.recorded_role = 'courier' and payment.allocated_amount > 0;

  insert into public.daily_close_casual_cash_items (
    service_date, employee_id, transaction_id, source_kind, cash_amount, source_snapshot
  )
  select p_service_date, source.employee_id, source.source_id,
    source.source_kind, source.cash_amount, source.source_snapshot
  from public.daily_close_cash_sources(p_service_date) source
  where source.source_kind in ('casual_receipt', 'casual_refund');

  insert into public.daily_close_reconciliation_issues (
    service_date, employee_id, issue_type, source_entity, source_id,
    expected_value, actual_value, variance_value, reason, created_by
  )
  select snapshot.service_date, snapshot.employee_id, 'CASH_VARIANCE',
    'daily_close_employee_snapshots', snapshot.employee_id,
    snapshot.expected_cash_amount, snapshot.actual_cash_amount,
    snapshot.cash_variance_amount, snapshot.cash_reason, auth.uid()
  from public.daily_close_employee_snapshots snapshot
  where snapshot.service_date = p_service_date and snapshot.cash_variance_amount <> 0;

  insert into public.daily_close_reconciliation_issues (
    service_date, employee_id, issue_type, source_entity, source_id,
    expected_value, actual_value, variance_value, reason, created_by
  )
  select item.service_date, null, 'STOCK_VARIANCE',
    'daily_aggregate_stock_closure_items', item.ice_type_id,
    item.system_quantity, item.actual_quantity, item.variance_quantity,
    coalesce(nullif(trim(coalesce(item.note, '')), ''),
      nullif(trim(coalesce(p_stock_note, '')), ''), 'ส่วนต่างสต๊อกยังไม่ทราบสาเหตุ'),
    auth.uid()
  from public.daily_aggregate_stock_closure_items item
  where item.service_date = p_service_date and item.variance_quantity <> 0;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, after_value
  ) values (
    auth.uid(), 'daily_close_reconciliation_requests', p_idempotency_key,
    'closed_with_cash_reconciliation', jsonb_build_object(
      'service_date', p_service_date,
      'cash_counts', p_cash_counts,
      'stock_result', v_stock_result
    )
  );

  return public.get_daily_close_reconciliation(p_service_date);
end;
$$;

notify pgrst, 'reload schema';
