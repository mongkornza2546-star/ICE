-- The delivery picker is an operational directory. Its search already uses
-- current shop/participation values, so its labels must use those values too.
-- Keep round-stop snapshots and all historical/financial readers unchanged.
do $current_event_identity$
declare
  v_definition text := pg_get_functiondef('public.get_event_delivery_cards(uuid,uuid,text)'::regprocedure);
  v_patch record;
begin
  for v_patch in select * from (values
    ($old$'shop_name', coalesce(current_stop.shop_name_snapshot, eligible.shop_name)$old$,
     $new$'shop_name', eligible.shop_name$new$),
    ($old$'booth_number', coalesce(current_stop.event_booth_snapshot, eligible.booth_number)$old$,
     $new$'booth_number', eligible.booth_number$new$)
  ) as patches(old_text, new_text) loop
    if strpos(v_definition, v_patch.old_text) > 0 then
      v_definition := replace(v_definition, v_patch.old_text, v_patch.new_text);
    elsif strpos(v_definition, v_patch.new_text) = 0 then
      raise exception 'Event card identity projection missing: %', v_patch.old_text;
    end if;
  end loop;
  execute v_definition;
end;
$current_event_identity$;

notify pgrst, 'reload schema';
