-- Follow-up to 0248, including databases where it was run in SQL Editor.
-- Safe to rerun: replace only the RPC, preserving its response and all data.
create or replace function public.get_daily_shop_collection_queue(p_service_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_status text;
  v_closed boolean;
  v_creation_lock boolean;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required to view shop collections';
  elsif p_service_date is null
    or p_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'The collection queue is available only for the current Bangkok business date';
  end if;

  -- Choose the mode before acquiring any date lock. Never upgrade a shared
  -- lock: two first visitors upgrading together could deadlock.
  v_creation_lock := not exists (
    select 1 from public.collection_runs run where run.service_date = p_service_date
  ) and not exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = p_service_date
  );
  if v_creation_lock then
    perform pg_advisory_xact_lock(hashtextextended('collection-run:' || p_service_date::text, 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('collection-run:' || p_service_date::text, 0));
  end if;

  -- Re-read after waiting: another visitor may have created the context,
  -- or daily close may have completed before this transaction got its lock.
  select run.id, run.status::text into v_run_id, v_status
  from public.collection_runs run
  where run.service_date = p_service_date
  order by (run.status = 'open') desc, run.id
  limit 1;
  v_closed := coalesce(v_status = 'closed', false) or exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = p_service_date
  );
  if not v_closed and v_run_id is null then
    if not v_creation_lock then
      -- A context/closure was removed while waiting. Retry in a new transaction
      -- instead of upgrading the shared lock through ensure's exclusive lock.
      raise exception 'The collection context changed; refresh the queue';
    end if;
    v_run_id := (public.ensure_daily_collection_context(p_service_date)->>'collection_run_id')::uuid;
  end if;

  return jsonb_build_object(
    'collection_run_id', case when v_closed then null else v_run_id end,
    'status', case when v_closed then 'closed' else 'open' end,
    'queue', public.get_shop_collection_queue_for_date(p_service_date, v_run_id)
  );
end;
$$;

revoke all on function public.get_daily_shop_collection_queue(date) from public, anon;
grant execute on function public.get_daily_shop_collection_queue(date) to authenticated;
notify pgrst, 'reload schema';
