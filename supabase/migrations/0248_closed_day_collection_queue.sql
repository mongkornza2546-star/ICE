-- Reading outstanding debt must not require opening a payment context.
-- Copy the current projections so VAT, billing groups and event balances stay
-- identical. Keep all existing payment authorization functions unchanged.
do $read_projection$
declare
  v_definition text := pg_get_functiondef('public.get_collection_run_queue(uuid)'::regprocedure);
  v_start integer;
  v_end integer;
begin
  v_definition := replace(v_definition,
    'get_collection_run_queue(p_collection_run_id uuid)',
    'get_collection_queue_for_date(p_service_date date, p_collection_run_id uuid)');
  v_start := strpos(v_definition, '  select run.service_date into v_service_date');
  v_end := strpos(v_definition, '  return coalesce(');
  if v_start = 0 or v_end <= v_start or strpos(v_definition,
    'public.is_charge_collectible_in_run(charge.id, p_collection_run_id)') = 0 then
    raise exception 'Unexpected collection queue projection';
  end if;
  v_definition := substring(v_definition for v_start - 1) || $guard$
  v_service_date := p_service_date;
  if v_service_date is null
    or v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'The collection queue is available only for the current Bangkok business date';
  end if;

$guard$ || substring(v_definition from v_end);
  v_definition := replace(v_definition,
    'public.is_charge_collectible_in_run(charge.id, p_collection_run_id)',
    $eligibility$charge.status = 'active'
      and (charge.event_settlement_context_id is null or charge.service_date <= v_service_date)
      and (charge.payment_term in ('immediate', 'end_of_day')
        or (charge.payment_term = 'credit' and (charge.due_date <= v_service_date
          or (statement.id is not null and statement.issued_service_date <= v_service_date))))$eligibility$);
  execute v_definition;

  v_definition := pg_get_functiondef('public.get_shop_collection_queue(uuid)'::regprocedure);
  if strpos(v_definition, 'public.get_collection_run_queue(p_collection_run_id)') = 0 then
    raise exception 'Unexpected unified shop queue projection';
  end if;
  v_definition := replace(v_definition,
    'get_shop_collection_queue(p_collection_run_id uuid)',
    'get_shop_collection_queue_for_date(p_service_date date, p_collection_run_id uuid)');
  execute replace(v_definition, 'public.get_collection_run_queue(p_collection_run_id)',
    'public.get_collection_queue_for_date(p_service_date, p_collection_run_id)');
end;
$read_projection$;

revoke all on function public.get_collection_queue_for_date(date, uuid) from public, anon, authenticated;
revoke all on function public.get_shop_collection_queue_for_date(date, uuid) from public, anon, authenticated;

create function public.get_daily_shop_collection_queue(p_service_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_status text;
  v_closed boolean;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required to view shop collections';
  elsif p_service_date is null
    or p_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'The collection queue is available only for the current Bangkok business date';
  end if;

  -- Serialize with daily close, including the first visit of a day without a run.
  perform pg_advisory_xact_lock(hashtextextended('collection-run:' || p_service_date::text, 0));
  select run.id, run.status::text into v_run_id, v_status
  from public.collection_runs run
  where run.service_date = p_service_date
  order by (run.status = 'open') desc, run.id
  limit 1;
  v_closed := coalesce(v_status = 'closed', false) or exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = p_service_date
  );
  if not v_closed then
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
