-- Make the collection capability authoritative and replace user-managed runs
-- with one internal, current-day collection context.

do $$
declare
  v_today date := (clock_timestamp() at time zone 'Asia/Bangkok')::date;
  v_closed_run_ids uuid[];
begin
  if not exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = v_today
  ) then
    select array_agg(run.id order by run.id) into v_closed_run_ids
    from public.collection_runs run
    where run.service_date = v_today and run.status = 'closed';

    if cardinality(v_closed_run_ids) > 0 then
      raise exception 'Automatic collection context preflight failed for %; closed run IDs: %',
        v_today, v_closed_run_ids;
    end if;
  end if;
end;
$$;

create or replace function public.ensure_daily_collection_context(p_service_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_today date := (clock_timestamp() at time zone 'Asia/Bangkok')::date;
begin
  if not public.can_collect_shop_payments() then
    raise exception 'The current user cannot collect shop payments';
  elsif p_service_date is null or p_service_date <> v_today then
    raise exception 'The collection context is available only for the current Bangkok business date';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('collection-run:' || p_service_date::text, 0));

  if exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = p_service_date
  ) then
    raise exception 'The selected business date is already closed';
  end if;

  select run.id into v_run_id
  from public.collection_runs run
  where run.service_date = p_service_date and run.status = 'open';

  if v_run_id is null then
    if exists (
      select 1 from public.collection_runs run
      where run.service_date = p_service_date and run.status = 'closed'
    ) then
      raise exception 'The collection context for this business date is already closed';
    end if;

    insert into public.collection_runs (service_date, opened_by)
    values (p_service_date, auth.uid())
    returning id into v_run_id;

    insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
    values (
      auth.uid(), 'collection_runs', v_run_id, 'auto_opened',
      jsonb_build_object('service_date', p_service_date)
    );
  end if;

  return jsonb_build_object(
    'collection_run_id', v_run_id,
    'service_date', p_service_date,
    'status', 'open'
  );
end;
$$;

-- Preserve old RLS/function call sites while removing member rows from the
-- authorization model.
create or replace function public.is_collection_run_member(target_collection_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_collect_shop_payments() and exists (
    select 1
    from public.collection_runs run
    where run.id = target_collection_run_id
      and run.status = 'open'
      and run.service_date = (clock_timestamp() at time zone 'Asia/Bangkok')::date
      and not exists (
        select 1 from public.daily_aggregate_stock_closures closure
        where closure.service_date = run.service_date
      )
  );
$$;

create or replace function public.is_payment_visible(target_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and exists (
    select 1 from public.payments payment
    where payment.id = target_payment_id
      and (
        public.current_app_role() in ('admin', 'round_lead')
        or payment.recorded_by = auth.uid()
      )
  );
$$;

-- An allocation must never reveal a payment merely because its charge is
-- visible. Collection payment privacy follows the payment owner boundary.
drop policy if exists "assigned users read payment allocations"
  on public.payment_allocations;
create policy "assigned users read payment allocations"
  on public.payment_allocations for select
  using (public.is_payment_visible(payment_id));

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
        charge.payment_term in ('immediate', 'end_of_day')
        or (charge.payment_term = 'credit' and charge.due_date <= run.service_date)
      )
  );
$$;

-- Managers previously bypassed is_collection_run_member(), so a legacy open
-- run for another date could still expose a queue (and make future credit look
-- due). Apply the automatic-context boundary to every role before delegating
-- to the mature queue projection.
alter function public.get_collection_run_queue(uuid)
  rename to get_collection_run_queue_before_automatic_context;
revoke all on function public.get_collection_run_queue_before_automatic_context(uuid)
  from public, authenticated;

create function public.get_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
begin
  if not public.can_collect_shop_payments() then
    raise exception 'The current user cannot collect shop payments';
  end if;

  select run.service_date into v_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id
    and run.status = 'open';

  if v_service_date is null
    or v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or exists (
      select 1
      from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_service_date
    ) then
    raise exception 'The collection context is stale or closed';
  end if;

  return public.get_collection_run_queue_before_automatic_context(p_collection_run_id);
end;
$$;

create or replace function public.get_today_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.get_collection_run_queue(p_collection_run_id)
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
begin
  if jsonb_typeof(coalesce(p_member_ids, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Collection members must be a JSON array';
  end if;
  return public.ensure_daily_collection_context(p_service_date);
end;
$$;

-- Keep the mature payment implementation, but put the new authorization and
-- lock boundary in front of every collection payment.
alter function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) rename to record_payment_before_automatic_context;

do $patch_partial_collection$
declare
  v_function regprocedure :=
    'public.record_payment_before_automatic_context(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure;
  v_definition text;
  v_old text := 'if not v_profile.allow_outstanding and v_remaining_outstanding > 0 and exists (';
  v_new text := 'if p_collection_run_id is null and not v_profile.allow_outstanding and v_remaining_outstanding > 0 and exists (';
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_old) = 0 then
    raise exception 'record_payment outstanding-approval branch was not recognized';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$patch_partial_collection$;

revoke all on function public.record_payment_before_automatic_context(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) from public, authenticated;

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
  v_service_date date;
begin
  if p_collection_run_id is not null then
    if p_shop_id is null or p_idempotency_key is null then
      raise exception 'Shop, payment method, and idempotency key are required';
    end if;

    select run.service_date into v_service_date
    from public.collection_runs run
    where run.id = p_collection_run_id;
    if v_service_date is null then
      raise exception 'The collection context does not exist';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));
    perform pg_advisory_xact_lock_shared(
      hashtextextended('collection-run:' || v_service_date::text, 0)
    );

    if not public.can_collect_shop_payments() then
      raise exception 'The current user cannot collect shop payments';
    elsif v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
      or not exists (
        select 1 from public.collection_runs run
        where run.id = p_collection_run_id and run.status = 'open'
      )
      or exists (
        select 1 from public.daily_aggregate_stock_closures closure
        where closure.service_date = v_service_date
      ) then
      raise exception 'The collection context is stale or closed';
    end if;
  end if;

  return public.record_payment_before_automatic_context(
    p_shop_id, p_allocations, p_payment_method, p_received_amount,
    p_reference_number, p_evidence_path, p_collection_run_id,
    p_expected_outstanding_amount, p_approval_id, p_idempotency_key
  );
end;
$$;

alter function public.void_payment(uuid, text)
  rename to void_payment_before_automatic_context;
revoke all on function public.void_payment_before_automatic_context(uuid, text)
  from public, authenticated;

create function public.void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_service_date date;
begin
  select payment.* into v_payment
  from public.payments payment
  where payment.id = p_payment_id;

  select run.service_date into v_service_date
  from public.collection_runs run
  where run.id = v_payment.collection_run_id;

  if v_payment.id is null or v_payment.collection_run_id is null then
    return public.void_payment_before_automatic_context(p_payment_id, p_reason);
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('financial-shop:' || v_payment.shop_id::text, 0)
  );
  perform pg_advisory_xact_lock_shared(
    hashtextextended('collection-run:' || v_service_date::text, 0)
  );

  select payment.* into v_payment
  from public.payments payment
  where payment.id = p_payment_id
  for update;

  if not public.can_collect_shop_payments() then
    raise exception 'The current user cannot collect shop payments';
  elsif v_payment.recorded_by <> auth.uid()
    and public.current_app_role() = 'courier' then
    raise exception 'Couriers can only void payments they recorded';
  elsif v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or not exists (
      select 1 from public.collection_runs run
      where run.id = v_payment.collection_run_id and run.status = 'open'
    )
    or exists (
      select 1 from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_service_date
    ) then
    raise exception 'The collection context is stale or closed';
  end if;

  return public.void_payment_before_automatic_context(p_payment_id, p_reason);
end;
$$;

alter function public.close_daily_aggregate_stock(date, jsonb, text, uuid)
  rename to close_daily_aggregate_stock_before_collection_context;
revoke all on function public.close_daily_aggregate_stock_before_collection_context(date, jsonb, text, uuid)
  from public, authenticated;

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
declare
  v_result jsonb;
  v_run_id uuid;
begin
  if p_service_date is null or p_idempotency_key is null then
    raise exception 'Service date and idempotency key are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));
  perform pg_advisory_xact_lock(
    hashtextextended('collection-run:' || p_service_date::text, 0)
  );

  v_result := public.close_daily_aggregate_stock_before_collection_context(
    p_service_date, p_counts, p_note, p_idempotency_key
  );

  update public.collection_runs
  set status = 'closed', closed_by = auth.uid(), closed_at = now()
  where service_date = p_service_date and status = 'open'
  returning id into v_run_id;

  if v_run_id is not null then
    insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
    values (
      auth.uid(), 'collection_runs', v_run_id, 'closed_by_daily_close',
      jsonb_build_object('service_date', p_service_date)
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.ensure_daily_collection_context(date) from public;
revoke all on function public.open_collection_run(date, jsonb) from public;
revoke all on function public.get_collection_run_queue(uuid) from public;
revoke all on function public.get_today_collection_run_queue(uuid) from public;
revoke all on function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) from public;
revoke all on function public.void_payment(uuid, text) from public;
revoke all on function public.close_daily_aggregate_stock(date, jsonb, text, uuid) from public;
revoke all on function public.close_collection_run(uuid) from public, authenticated;
revoke all on function public.set_credit_charge_collection_assignment(uuid, uuid, boolean)
  from public, authenticated;

grant execute on function public.ensure_daily_collection_context(date) to authenticated;
grant execute on function public.open_collection_run(date, jsonb) to authenticated;
grant execute on function public.get_collection_run_queue(uuid) to authenticated;
grant execute on function public.get_today_collection_run_queue(uuid) to authenticated;
grant execute on function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text, uuid, numeric, uuid, uuid
) to authenticated;
grant execute on function public.void_payment(uuid, text) to authenticated;
grant execute on function public.close_daily_aggregate_stock(date, jsonb, text, uuid) to authenticated;

comment on function public.open_collection_run(date, jsonb)
  is 'Deprecated compatibility wrapper for ensure_daily_collection_context';
comment on function public.close_collection_run(uuid)
  is 'Deprecated; collection contexts close only through close_daily_aggregate_stock';
comment on function public.set_credit_charge_collection_assignment(uuid, uuid, boolean)
  is 'Deprecated; due credit charges enter the collection queue automatically';

notify pgrst, 'reload schema';
