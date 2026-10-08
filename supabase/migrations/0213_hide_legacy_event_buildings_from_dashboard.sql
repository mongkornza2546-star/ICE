-- Event compatibility buildings can use legacy EVENT-* codes that do not
-- contain an event job UUID. Match the same prefix used by location settings.
-- Older databases may not have the helpers from 0195/0207 yet. Skip absent
-- helpers with a notice; rerun this migration after installing them.
do $hide_legacy_event_buildings$
declare
  v_function text;
  v_function_oid regprocedure;
  v_definition text;
  v_old text := $old$      and not exists (
        select 1 from public.event_jobs job
        where upper(building.code) = upper('EVENT-' || job.id::text)
      )$old$;
  v_new text := $new$      and upper(btrim(building.code)) not like 'EVENT-%'$new$;
begin
  foreach v_function in array array[
    'public.daily_work_location_sales(date)',
    'public.daily_work_location_ice_quantities(date)'
  ] loop
    v_function_oid := to_regprocedure(v_function);
    if v_function_oid is null then
      raise notice 'Skipping absent function %. Apply its prerequisite migrations (0195/0207) and rerun 0213.', v_function;
      continue;
    end if;

    select pg_get_functiondef(v_function_oid) into v_definition;
    if strpos(v_definition, v_old) > 0 then
      execute replace(v_definition, v_old, v_new);
    elsif strpos(v_definition, v_new) = 0 then
      raise exception 'Cannot exclude legacy event buildings: % definition has changed', v_function;
    end if;
  end loop;
end;
$hide_legacy_event_buildings$;

notify pgrst, 'reload schema';
