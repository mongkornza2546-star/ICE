-- Replace the standalone cash-handover workflow with one atomic daily close.

create function public.daily_close_payment_fingerprint(
  p_payment_id uuid,
  p_status text,
  p_payment_method public.payment_method,
  p_allocated_amount numeric,
  p_recorded_by uuid,
  p_recorded_role public.app_role,
  p_accountable_service_date date
)
returns text
language sql
immutable
set search_path = public
as $$
  select md5(jsonb_build_object(
    'payment_id', p_payment_id,
    'status', p_status,
    'payment_method', p_payment_method,
    'allocated_amount', p_allocated_amount::numeric(12,2),
    'recorded_by', p_recorded_by,
    'recorded_role', p_recorded_role,
    'accountable_service_date', p_accountable_service_date
  )::text);
$$;

create function public.get_daily_close_reconciliation(
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

  with accountable_payments as materialized (
    select
      payment.id,
      payment.recorded_by employee_id,
      payment.allocated_amount,
      payment.status,
      payment.payment_method,
      payment.recorded_role,
      coalesce(run.service_date,
        (payment.recorded_at at time zone 'Asia/Bangkok')::date) accountable_service_date
    from public.payments payment
    left join public.collection_runs run on run.id = payment.collection_run_id
    where coalesce(run.service_date,
      (payment.recorded_at at time zone 'Asia/Bangkok')::date) = v_service_date
      and payment.status = 'active'
      and payment.payment_method = 'cash'
      and payment.recorded_role = 'courier'
      and payment.allocated_amount > 0
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
    from accountable_payments payment
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
    'recorded_by', snapshot.recorded_by,
    'recorded_at', snapshot.recorded_at
  ) order by employee.display_name, employee.id), '[]'::jsonb)
  into v_employees
  from eligible_employees employee
  left join public.daily_close_employee_snapshots snapshot
    on snapshot.service_date = v_service_date and snapshot.employee_id = employee.id
  left join lateral (
    select
      coalesce(sum(payment.allocated_amount), 0)::numeric(12,2) expected_cash_amount,
      coalesce(jsonb_agg(payment.id order by payment.id), '[]'::jsonb) payment_ids
    from accountable_payments payment
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

create function public.close_daily_reconciliation_v2(
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
      select payment.recorded_by employee_id, sum(payment.allocated_amount)::numeric(12,2) expected
      from public.payments payment
      left join public.collection_runs run on run.id = payment.collection_run_id
      where coalesce(run.service_date,
        (payment.recorded_at at time zone 'Asia/Bangkok')::date) = p_service_date
        and payment.status = 'active' and payment.payment_method = 'cash'
        and payment.recorded_role = 'courier' and payment.allocated_amount > 0
      group by payment.recorded_by
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

  v_stock_result := public.close_daily_aggregate_stock(
    p_service_date, p_stock_counts, p_stock_note, p_idempotency_key
  );

  with accountable as materialized (
    select payment.recorded_by employee_id,
      coalesce(sum(payment.allocated_amount), 0)::numeric(12,2) expected
    from public.payments payment
    left join public.collection_runs run on run.id = payment.collection_run_id
    where coalesce(run.service_date,
      (payment.recorded_at at time zone 'Asia/Bangkok')::date) = p_service_date
      and payment.status = 'active' and payment.payment_method = 'cash'
      and payment.recorded_role = 'courier' and payment.allocated_amount > 0
    group by payment.recorded_by
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

create function public.resolve_daily_close_reconciliation_issue(
  p_issue_id uuid,
  p_resolution_note text,
  p_external_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_issue public.daily_close_reconciliation_issues%rowtype;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can resolve reconciliation issues';
  elsif p_issue_id is null
    or nullif(trim(coalesce(p_resolution_note, '')), '') is null then
    raise exception 'Issue and resolution note are required';
  end if;

  select * into v_issue
  from public.daily_close_reconciliation_issues issue
  where issue.id = p_issue_id
  for update;
  if v_issue.id is null then
    raise exception 'Reconciliation issue does not exist';
  elsif v_issue.status = 'resolved' then
    return to_jsonb(v_issue);
  end if;

  update public.daily_close_reconciliation_issues
  set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
    resolution_note = trim(p_resolution_note),
    external_reference = nullif(trim(coalesce(p_external_reference, '')), '')
  where id = p_issue_id
  returning * into v_issue;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, after_value
  ) values (
    auth.uid(), 'daily_close_reconciliation_issues', p_issue_id, 'resolved',
    jsonb_build_object('resolution_note', v_issue.resolution_note,
      'external_reference', v_issue.external_reference)
  );
  return to_jsonb(v_issue);
end;
$$;

revoke all on function public.daily_close_payment_fingerprint(
  uuid, text, public.payment_method, numeric, uuid, public.app_role, date
) from public, authenticated;
revoke all on function public.get_daily_close_reconciliation(date) from public;
revoke all on function public.close_daily_reconciliation_v2(date, jsonb, jsonb, text, uuid) from public;
revoke all on function public.resolve_daily_close_reconciliation_issue(uuid, text, text) from public;
grant execute on function public.get_daily_close_reconciliation(date) to authenticated;
grant execute on function public.close_daily_reconciliation_v2(date, jsonb, jsonb, text, uuid) to authenticated;
grant execute on function public.resolve_daily_close_reconciliation_issue(uuid, text, text) to authenticated;

comment on function public.close_daily_reconciliation_v2(date, jsonb, jsonb, text, uuid) is
  'Atomically snapshots courier cash, creates independent variance issues, and closes daily stock.';

notify pgrst, 'reload schema';
