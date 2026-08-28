-- Keep collection information visible to every active courier while retaining
-- can_collect_shop_payments as a write capability for recording/voiding money.

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
  if not public.is_active_user() then
    raise exception 'An active user is required to view shop collections';
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

create or replace function public.is_collection_run_member(target_collection_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user()
    and public.current_app_role() = 'courier'
    and exists (
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

-- is_collection_run_member now represents current-run visibility, so keep the
-- existing due-date mutation behind the explicit collection write capability.
alter function public.request_credit_due_date_change(uuid, date, text)
  rename to request_credit_due_date_change_before_collection_read_access;
revoke all on function public.request_credit_due_date_change_before_collection_read_access(uuid, date, text)
  from public, authenticated;

create function public.request_credit_due_date_change(
  p_charge_id uuid,
  p_requested_due_date date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_collect_shop_payments() then
    raise exception 'The current user cannot collect shop payments';
  end if;

  return public.request_credit_due_date_change_before_collection_read_access(
    p_charge_id, p_requested_due_date, p_reason
  );
end;
$$;

revoke all on function public.ensure_daily_collection_context(date) from public;
revoke all on function public.is_collection_run_member(uuid) from public;
revoke all on function public.get_collection_run_queue(uuid) from public;
revoke all on function public.request_credit_due_date_change(uuid, date, text) from public;
grant execute on function public.ensure_daily_collection_context(date) to authenticated;
grant execute on function public.is_collection_run_member(uuid) to authenticated;
grant execute on function public.get_collection_run_queue(uuid) to authenticated;
grant execute on function public.request_credit_due_date_change(uuid, date, text) to authenticated;

comment on function public.ensure_daily_collection_context(date)
  is 'Returns the current collection context to active users; payment writes remain capability-gated';

notify pgrst, 'reload schema';
