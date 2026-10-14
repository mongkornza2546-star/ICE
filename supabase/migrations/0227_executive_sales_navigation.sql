-- Keep area summaries and drilldowns on the same identity, even when historical
-- delivery snapshots contain different names for one destination.
do $sales_areas$
declare
  v_definition text := pg_get_functiondef('public.get_executive_report(date,date)'::regprocedure);
  v_old text := $old$select area_kind, area_id, area_name, sum(amount) as sales
    from period where kind = 'sale'
    group by area_kind, area_id, area_name$old$;
  v_new text := $new$select area_kind, area_id,
      (array_agg(area_name order by day desc, occurred_at desc nulls last, source_id))[1] as area_name,
      sum(amount) as sales
    from period where kind = 'sale'
    group by area_kind, area_id$new$;
begin
  if strpos(v_definition, v_new) > 0 then
    raise notice 'Executive sales area grouping is already applied';
  elsif strpos(v_definition, v_old) > 0 then
    execute replace(v_definition, v_old, v_new);
  else
    raise exception 'Cannot update sales areas: executive report definition has changed';
  end if;
end;
$sales_areas$;

-- Return every candidate in the existing summary payload so the UI can page
-- through all flagged shops. Preserve the existing ranking and access control.
do $quiet_shop_pages$
declare
  v_definition text := pg_get_functiondef('public.executive_report_insights(date,date)'::regprocedure);
  v_old text := 'from (select * from flagged order by monthly_sales desc, days_since desc, shop_id limit 10) page';
  v_new text := 'from flagged';
begin
  if strpos(v_definition, v_old) > 0 then
    execute replace(v_definition, v_old, v_new);
  elsif strpos(v_definition, 'order by monthly_sales desc, days_since desc, shop_id)' || chr(10) || '        from flagged)') > 0 then
    raise notice 'All quiet-shop candidates are already included';
  else
    raise exception 'Cannot update quiet shops: executive insights definition has changed';
  end if;
end;
$quiet_shop_pages$;

notify pgrst, 'reload schema';
