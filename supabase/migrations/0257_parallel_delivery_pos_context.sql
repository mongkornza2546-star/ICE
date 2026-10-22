-- Split POS reads into stock and sale requests. Clone the installed readers so
-- both parts retain regular/event authorization, frozen event terms, VAT,
-- courier holdings, admin truck routing and closed-day rules. Keep the full
-- readers unchanged for older clients and the transactional writers.
do $split_pos$
declare
  v_name text;
  v_definition text;
  v_fragment text;
begin
  foreach v_name in array array['get_delivery_pos_context', 'get_event_delivery_pos_context'] loop
    v_definition := pg_get_functiondef(format('public.%I(uuid)', v_name)::regprocedure);
    if strpos(v_definition, format('FUNCTION public.%s(p_round_stop_id uuid)', v_name)) = 0
      or strpos(v_definition, 'if not public.is_active_user()') = 0
      or strpos(v_definition, 'where price.ice_type_id = ice.id') = 0
      or strpos(v_definition, 'public.stock_balance_at(v_service_date, v_source_location_id, ice.id)') = 0
      or strpos(v_definition, 'public.daily_aggregate_stock_balance_at(v_service_date, ice.id)') = 0
      or strpos(v_definition, 'return v_result;') = 0 then
      raise exception 'Unexpected POS reader definition: %', v_name;
    end if;
    v_definition := replace(v_definition,
      format('FUNCTION public.%s(p_round_stop_id uuid)', v_name),
      format('FUNCTION public.%s_part(p_round_stop_id uuid, p_part text)', v_name));
    v_definition := replace(v_definition, 'if not public.is_active_user()', $part$if p_part is null or p_part not in ('stock', 'sale') then
    raise exception 'Unknown POS context part';
  end if;
  if not public.is_active_user()$part$);

    -- CASE prevents ledger scans in the sale request; a WHERE gate prevents
    -- effective-price lookups in the stock request.
    foreach v_fragment in array array[
      'public.stock_balance_at(v_service_date, v_source_location_id, ice.id)',
      'public.daily_aggregate_stock_balance_at(v_service_date, ice.id)'
    ] loop
      v_definition := replace(v_definition, v_fragment,
        format('(case when p_part = ''stock'' then %s else null end)', v_fragment));
    end loop;
    v_definition := replace(v_definition, 'where price.ice_type_id = ice.id',
      'where p_part = ''sale'' and price.ice_type_id = ice.id');
    v_definition := replace(v_definition, 'where price.shop_id = v_shop_id',
      'where p_part = ''sale'' and price.shop_id = v_shop_id');

    if v_name = 'get_delivery_pos_context' then
      if strpos(v_definition, 'select profile.* into v_profile') = 0
        or strpos(v_definition, E'and charge.status = ''active'';') = 0 then
        raise exception 'Unexpected payment projection in %', v_name;
      end if;
      v_definition := replace(v_definition, 'select profile.* into v_profile',
        E'if p_part = ''sale'' then\n  select profile.* into v_profile');
      v_definition := replace(v_definition, E'and charge.status = ''active'';',
        E'and charge.status = ''active'';\n  end if;');
    end if;

    -- Do not ship duplicate product descriptions or fields from the other part.
    v_definition := replace(v_definition, 'return v_result;', $result$
  if p_part = 'stock' then
    return jsonb_build_object(
      'round_id', v_result->'round_id',
      'round_stop_id', v_result->'round_stop_id',
      'service_date', v_result->'service_date',
      'stock_source', v_result->'stock_source',
      'stock_check_required', v_result->'stock_check_required',
      'items', coalesce((select jsonb_agg(jsonb_build_object(
        'ice_type_id', item->'ice_type_id', 'stock_quantity', item->'stock_quantity'
      ) order by ordinality) from jsonb_array_elements(v_result->'items') with ordinality as entries(item, ordinality)), '[]'::jsonb)
    );
  end if;
  return (v_result - 'stock_source' - 'stock_check_required') || jsonb_build_object(
    'items', coalesce((select jsonb_agg(item - 'stock_quantity' order by ordinality)
      from jsonb_array_elements(v_result->'items') with ordinality as entries(item, ordinality)), '[]'::jsonb)
  );$result$);
    execute v_definition;
    execute format('revoke all on function public.%I(uuid,text) from public, anon', v_name || '_part');
    execute format('grant execute on function public.%I(uuid,text) to authenticated', v_name || '_part');
  end loop;

  -- Advertise support in an existing startup response: no capability round trip
  -- and no speculative requests to databases that have not been migrated yet.
  v_definition := pg_get_functiondef('public.get_employee_active_session(date)'::regprocedure);
  if strpos(v_definition, '''pos_context_parts_version''') = 0 then
    if strpos(v_definition, '''sessions'', v_rounds') = 0 then
      raise exception 'Unexpected employee session projection';
    end if;
    execute replace(v_definition, '''sessions'', v_rounds',
      '''pos_context_parts_version'', 1, ''sessions'', v_rounds');
  end if;
end;
$split_pos$;

notify pgrst, 'reload schema';
