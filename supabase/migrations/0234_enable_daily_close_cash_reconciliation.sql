-- Enable manager-counted cash together with daily stock closing from 2026-10-15.
-- Production preflight: the service date was open; courier cash matched payment
-- allocations on 2026-10-14 (1950.00) and 2026-10-15 (90.00), with zero delta.
-- Earlier service dates retain the existing stock-only closing workflow.
do $$
declare
  v_enabled_from date;
begin
  if to_regprocedure('public.close_daily_reconciliation_v2(date,jsonb,jsonb,text,uuid)') is null then
    raise exception 'Daily cash reconciliation workflow must be installed before activation';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('2026-10-15', 0));
  select enabled_from_service_date into v_enabled_from
  from public.daily_close_reconciliation_configuration
  where singleton
  for update;

  if not found then
    raise exception 'Daily cash reconciliation configuration is missing';
  end if;

  if v_enabled_from is null or v_enabled_from > date '2026-10-15' then
    if exists (
      select 1 from public.daily_aggregate_stock_closures
      where service_date = date '2026-10-15'
    ) then
      raise exception 'Cannot activate cash reconciliation on an already closed service date';
    end if;

    update public.daily_close_reconciliation_configuration
    set enabled_from_service_date = date '2026-10-15'
    where singleton;
  end if;
end;
$$;
