-- Admin regular/event deliveries consume the same configured truck that feeds
-- employee withdrawals. Keep courier holdings and round-lead routing unchanged.
-- Historical source corrections are deliberately separate from this migration.
do $admin_truck$
declare
  v_signature text;
  v_definition text;
  v_old_source constant text := $fragment$  else
    v_source_location_id := v_shop_source_location_id;
  end if;$fragment$;
  v_new_source constant text := $fragment$  elsif public.current_app_role() = 'admin' then
    select location.id into v_source_location_id
    from public.stock_locations location
    where location.kind = 'truck' and location.is_courier_source
      and location.is_active and location.holds_inventory;
    if v_source_location_id is null then
      raise exception 'Admin delivery requires a configured active source truck';
    end if;
  else
    v_source_location_id := v_shop_source_location_id;
  end if;$fragment$;
  v_old_check constant text := $fragment$    if public.current_app_role() = 'courier'
      and public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)$fragment$;
  v_new_check constant text := $fragment$    if public.current_app_role() = 'admin'
      and public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)
        < v_item.quantity then
      raise exception 'The source location does not have enough stock';
    elsif public.current_app_role() = 'courier'
      and public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)$fragment$;
begin
  foreach v_signature in array array[
    'public.get_delivery_pos_context(uuid)',
    'public.get_event_delivery_pos_context(uuid)',
    'public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)',
    'public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)'
  ] loop
    select pg_get_functiondef(v_signature::regprocedure) into v_definition;
    -- Allow a manual SQL deployment to be reconciled with migration history.
    if strpos(v_definition, v_new_source) > 0 then
      continue;
    end if;
    if strpos(v_definition, v_old_source) = 0 then
      raise exception 'Unexpected admin stock source in %', v_signature;
    end if;
    v_definition := replace(v_definition, v_old_source, v_new_source);
    if v_signature like 'public.get_%' then
      if strpos(v_definition, 'public.stock_balance_at(v_service_date, v_source_location_id, ice.id)') = 0 then
        raise exception 'Missing stock availability projection in %', v_signature;
      end if;
      -- Both the displayed source and available quantity must match the writer.
      v_definition := replace(v_definition,
        $$when public.current_app_role() = 'courier'$$,
        $$when public.current_app_role() in ('courier', 'admin')$$);
    else
      if strpos(v_definition, v_old_check) = 0 then
        raise exception 'Missing stock availability check in %', v_signature;
      end if;
      v_definition := replace(v_definition, v_old_check, v_new_check);
    end if;
    execute v_definition;
  end loop;
end;
$admin_truck$;
