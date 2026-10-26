-- Compatibility buildings remain active after events end for historical records.
-- They belong to event management, not the regular casual-POS building picker.
-- Match src/lib/eventLocationCode.ts without relying on a translated display name.
do $filter_casual_buildings$
declare
  v_definition text;
  v_old text := 'from public.buildings where is_active)';
  v_new text := 'from public.buildings where is_active and btrim(code) !~* ''^(SITE-)?EVENT-'')';
begin
  v_definition := pg_get_functiondef('public.get_casual_transaction_context(uuid)'::regprocedure);
  if strpos(v_definition, v_old) > 0 then
    execute replace(v_definition, v_old, v_new);
  elsif strpos(v_definition, v_new) = 0 then
    raise exception 'Casual POS building selector changed; review before applying 0259';
  end if;
end;
$filter_casual_buildings$;

notify pgrst, 'reload schema';
