-- Reconcile cash for couriers, admins, and round leads on every open day.
-- Require an explicit count (including zero) for every active account, plus
-- inactive accounts with cash activity. Attribute receipts/refunds to the
-- recording/confirming user; receiving a handover is not a second receipt.
-- Closed days retain their immutable roster, amounts, sources and retry keys.
-- Casual transactions have no historical role; as before, use the current role.

-- Explicit receipt dates take precedence over the current collection context.
-- Ordinary payments retain their collection business date for compatibility.
create function public.daily_close_payment_date(
  p_received_date_override date, p_collection_service_date date, p_recorded_at timestamptz
)
returns date language sql immutable set search_path = public as $$
  select coalesce(p_received_date_override, p_collection_service_date,
    (p_recorded_at at time zone 'Asia/Bangkok')::date);
$$;

-- Share the same lock as daily close. Do not take the stock-date lock here:
-- collection writers already hold the collection lock before inserting cash.
create function public.assert_daily_cash_date_open(p_service_date date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_service_date is null then raise exception 'Cash service date is required'; end if;
  perform pg_advisory_xact_lock_shared(
    hashtextextended('collection-run:' || p_service_date::text, 0)
  );
  if exists (select 1 from public.daily_close_reconciliation_requests
    where service_date = p_service_date) then
    raise exception 'วันที่ % ปิดตรวจนับเงินสดแล้ว ไม่สามารถเพิ่มหรือแก้ไขรายการเงินสดของวันนั้นได้', p_service_date;
  end if;
end;
$$;

create function public.guard_payment_cash_close()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_dates date[] := '{}'::date[];
  v_date date;
begin
  -- Receipt numbering, evidence and request metadata do not change cash.
  if tg_op = 'UPDATE' and
    row(old.status, old.payment_method, old.allocated_amount, old.recorded_by,
      old.recorded_role, old.recorded_at, old.received_date_override, old.collection_run_id)
    is not distinct from
    row(new.status, new.payment_method, new.allocated_amount, new.recorded_by,
      new.recorded_role, new.recorded_at, new.received_date_override, new.collection_run_id) then
    return new;
  end if;
  if tg_op <> 'INSERT' and old.status = 'active'
    and old.payment_method = 'cash' and old.allocated_amount > 0 then
    v_dates := array_append(v_dates, public.daily_close_payment_date(
      old.received_date_override,
      (select service_date from public.collection_runs where id = old.collection_run_id),
      old.recorded_at));
  end if;
  if tg_op <> 'DELETE' and new.status = 'active'
    and new.payment_method = 'cash' and new.allocated_amount > 0 then
    v_dates := array_append(v_dates, public.daily_close_payment_date(
      new.received_date_override,
      (select service_date from public.collection_runs where id = new.collection_run_id),
      new.recorded_at));
  end if;
  for v_date in select distinct value from unnest(v_dates) value order by value loop
    perform public.assert_daily_cash_date_open(v_date);
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Runs after payments_00_received_date, including for backdated entry.
create trigger payments_01_cash_close_guard
before insert or update or delete on public.payments
for each row execute function public.guard_payment_cash_close();

create function public.guard_refund_cash_close()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.refund_method = 'cash' then
    perform public.assert_daily_cash_date_open((new.settled_at at time zone 'Asia/Bangkok')::date);
  end if;
  return new;
end;
$$;
create trigger refund_settlements_cash_close_guard
before insert on public.refund_settlements
for each row execute function public.guard_refund_cash_close();

create table public.daily_close_refund_cash_items (
  service_date date not null,
  employee_id uuid not null,
  refund_id uuid not null references public.refund_settlements(idempotency_key) on delete restrict,
  cash_amount numeric(12,2) not null check (cash_amount < 0),
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  primary key (service_date, employee_id, refund_id),
  foreign key (service_date, employee_id)
    references public.daily_close_employee_snapshots(service_date, employee_id) on delete restrict
);
create trigger daily_close_refund_cash_items_are_immutable
before update or delete on public.daily_close_refund_cash_items
for each row execute function public.guard_daily_close_snapshot();
alter table public.daily_close_refund_cash_items enable row level security;
create policy "managers read daily close refund cash items"
  on public.daily_close_refund_cash_items for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
revoke all on table public.daily_close_refund_cash_items from public, anon, authenticated;
grant select on table public.daily_close_refund_cash_items to authenticated;
revoke all on function public.daily_close_payment_date(date, date, timestamptz) from public, anon, authenticated;
revoke all on function public.assert_daily_cash_date_open(date) from public, anon, authenticated;
revoke all on function public.guard_payment_cash_close() from public, anon, authenticated;
revoke all on function public.guard_refund_cash_close() from public, anon, authenticated;

create or replace function public.daily_close_cash_sources(p_service_date date)
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
  where public.daily_close_payment_date(payment.received_date_override, run.service_date,
    payment.recorded_at) = p_service_date
    and payment.status = 'active' and payment.payment_method = 'cash'
    and payment.recorded_role in ('courier', 'admin', 'round_lead') and payment.allocated_amount > 0
  union all
  -- A void does not undo the original receipt: a transfer refund still leaves
  -- the original cash with the recorder. Subtract cash refunds separately below.
  select 'casual_receipt', sale.id, sale.recorded_by,
    sale.sale_amount, to_jsonb(sale)
  from public.casual_transactions sale
  join public.users recorder on recorder.id = sale.recorded_by
  where sale.service_date = p_service_date and sale.transaction_kind = 'paid'
    and sale.payment_method = 'cash' and recorder.role in ('courier', 'admin', 'round_lead')
  union all
  select 'casual_refund', sale.id, refund.confirmed_by,
    -refund.refunded_amount, to_jsonb(refund)
  from public.casual_refund_confirmations refund
  join public.casual_transactions sale on sale.id = refund.transaction_id
  join public.users recorder on recorder.id = refund.confirmed_by
  where sale.service_date = p_service_date
    and refund.refund_method = 'cash' and recorder.role in ('courier', 'admin', 'round_lead')
  union all
  select 'regular_refund', refund.idempotency_key, refund.settled_by,
    -refund.amount, to_jsonb(refund)
  from public.refund_settlements refund
  where (refund.settled_at at time zone 'Asia/Bangkok')::date = p_service_date
    and refund.refund_method = 'cash';
$$;

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
      and app_user.role in ('courier', 'admin', 'round_lead') and app_user.is_active
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
      where app_user.role in ('courier', 'admin', 'round_lead') and app_user.is_active
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
      public.daily_close_payment_date(payment.received_date_override, run.service_date, payment.recorded_at)
    )
  from public.payments payment
  left join public.collection_runs run on run.id = payment.collection_run_id
  where public.daily_close_payment_date(payment.received_date_override, run.service_date,
    payment.recorded_at) = p_service_date
    and payment.status = 'active' and payment.payment_method = 'cash'
    and payment.recorded_role in ('courier', 'admin', 'round_lead') and payment.allocated_amount > 0;

  insert into public.daily_close_casual_cash_items (
    service_date, employee_id, transaction_id, source_kind, cash_amount, source_snapshot
  )
  select p_service_date, source.employee_id, source.source_id,
    source.source_kind, source.cash_amount, source.source_snapshot
  from public.daily_close_cash_sources(p_service_date) source
  where source.source_kind in ('casual_receipt', 'casual_refund');

  insert into public.daily_close_refund_cash_items (
    service_date, employee_id, refund_id, cash_amount, source_snapshot
  )
  select p_service_date, source.employee_id, source.source_id,
    source.cash_amount, source.source_snapshot
  from public.daily_close_cash_sources(p_service_date) source
  where source.source_kind = 'regular_refund';

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

comment on function public.close_daily_reconciliation_v2(date, jsonb, jsonb, text, uuid) is
  'Atomically snapshots cash for couriers, admins and round leads, requires every eligible account count, and closes daily stock.';

notify pgrst, 'reload schema';
