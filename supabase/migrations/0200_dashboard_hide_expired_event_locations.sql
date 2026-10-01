-- The daily dashboard is an operational view. It must list only events that
-- are active on the selected service date, even when an expired event has a
-- historical charge recorded for that date.
do $dashboard_expired_event_locations$
declare
  v_definition text;
  v_old text := $old$
      or exists (select 1 from totals where kind = 'event' and id = job.id)$old$;
begin
  select pg_get_functiondef('public.daily_work_location_sales(date)'::regprocedure)
  into v_definition;

  if strpos(v_definition, v_old) = 0 then
    raise exception 'Cannot remove expired event locations: dashboard definition has changed';
  end if;

  execute replace(v_definition, v_old, '');
end;
$dashboard_expired_event_locations$;

notify pgrst, 'reload schema';
