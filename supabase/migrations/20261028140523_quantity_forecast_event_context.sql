-- Forecast-only context. Reuse the report's area attribution and corrections;
-- never train ordinary demand on deliveries attributed to an event.
create or replace function public.get_quantity_forecast_context(p_anchor date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  v_end date;
  v_days jsonb;
begin
  if public.is_active_user() is not true or public.current_app_role() is distinct from 'admin' then
    raise exception 'Only an active admin can view quantity forecasts';
  end if;
  if p_anchor is null or p_anchor > v_today then
    raise exception 'Choose a valid forecast anchor no later than today';
  end if;
  v_end := least(p_anchor, v_today - 1);
  -- Exactly 28 calls to the existing private area helper. This keeps historical
  -- corrections, legacy event buildings and loose-stock rounding consistent.
  with days as (
    select d::date as day from generate_series((v_end - 27)::timestamp, v_end::timestamp, interval '1 day') d
  ), daily as (
    select day, coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', unit, 'delivered', delivered) order by name, id)
      from (
        select product->>'id' as id, max(product->>'name') as name, product->>'unit' as unit,
          sum((product->>'delivered')::numeric) as delivered
        from jsonb_array_elements(public.executive_report_volume_areas(day, day)) area
        cross join lateral jsonb_array_elements(area->'products') product
        where area->>'kind' <> 'event'
        group by product->>'id', product->>'unit'
      ) quantities
    ), '[]'::jsonb) as products from days
  )
  select jsonb_agg(jsonb_build_object('date', day, 'sales', 0, 'products', products) order by day)
    into v_days from daily;
  return jsonb_build_object(
    'basis', 'regular_only', 'historyFrom', v_end - 27, 'historyTo', v_end,
    'dailyTrend', v_days,
    'products', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', unit,
      'created_at', created_at) order by name, id), '[]'::jsonb) from public.ice_types where is_active),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name,
      'start', coalesce(preparation_start_date, start_date), 'end', end_date) order by start_date, id), '[]'::jsonb)
      from public.event_jobs where status = 'published'
        and coalesce(preparation_start_date, start_date) <= p_anchor + 30 and end_date > p_anchor)
  );
end;
$$;
revoke all on function public.get_quantity_forecast_context(date) from public, anon, authenticated;
grant execute on function public.get_quantity_forecast_context(date) to authenticated;
notify pgrst, 'reload schema';
