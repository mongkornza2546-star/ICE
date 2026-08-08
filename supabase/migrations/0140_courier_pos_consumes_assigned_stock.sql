-- Courier POS sales consume the stock that the courier withdrew into their
-- assigned holding point. The daily aggregate remains a second availability
-- check, so a sale cannot exceed either the courier's stock or the day's total.

do $migration$
declare
  v_function regprocedure;
  v_definition text;
  v_aggregate_source_branch constant text := $fragment$  -- Retained only as an audit snapshot; aggregate stock is authoritative.
  v_source_location_id := v_shop_source_location_id;$fragment$;
  v_courier_source_branch constant text := $fragment$  if public.current_app_role() = 'courier' then
    select count(*)::integer
    into v_active_holding_count
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;

    if v_active_holding_count = 0 then
      raise exception 'Employee delivery requires one active assigned holding location; none is configured';
    elsif v_active_holding_count > 1 then
      raise exception 'Employee delivery requires one active assigned holding location; multiple are configured';
    end if;

    select location.id into v_source_location_id
    from public.stock_locations location
    where location.assigned_user_id = auth.uid()
      and location.kind in ('team', 'small_vehicle')
      and location.is_active;
  else
    v_source_location_id := v_shop_source_location_id;
  end if;$fragment$;
  v_aggregate_quantity constant text := $fragment$'stock_quantity', public.daily_aggregate_stock_balance_at(v_service_date, ice.id),$fragment$;
  v_available_quantity constant text := $fragment$'stock_quantity', case
          when public.current_app_role() = 'courier' then least(
            public.stock_balance_at(v_service_date, v_source_location_id, ice.id),
            public.daily_aggregate_stock_balance_at(v_service_date, ice.id)
          )
          else public.daily_aggregate_stock_balance_at(v_service_date, ice.id)
        end,$fragment$;
  v_daily_only_check constant text := $fragment$    if public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)
      < v_item.quantity then
      raise exception 'Daily aggregate stock is not sufficient';$fragment$;
  v_courier_and_daily_check constant text := $fragment$    if public.current_app_role() = 'courier'
      and public.stock_balance_at(v_service_date, v_source_location_id, v_item.ice_type_id)
        < v_item.quantity then
      raise exception 'Employee holding does not have enough stock';
    elsif public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)
      < v_item.quantity then
      raise exception 'Daily aggregate stock is not sufficient';$fragment$;
  v_correction_daily_only_check constant text := $fragment$      if public.daily_aggregate_stock_balance_at(v_round.service_date, v_item.ice_type_id)
        < v_item.quantity then
        raise exception 'Daily aggregate stock is not sufficient for the corrected delivery';
      end if;$fragment$;
  v_correction_holding_and_daily_check constant text := $fragment$      if exists (
        select 1
        from public.stock_locations source
        where source.id = v_event.source_stock_location_id
          and source.assigned_user_id is not null
          and source.kind in ('team', 'small_vehicle')
      ) and public.stock_balance_at(
        v_round.service_date, v_event.source_stock_location_id, v_item.ice_type_id
      ) < v_item.quantity then
        raise exception 'Employee holding does not have enough stock';
      elsif public.daily_aggregate_stock_balance_at(v_round.service_date, v_item.ice_type_id)
        < v_item.quantity then
        raise exception 'Daily aggregate stock is not sufficient for the corrected delivery';
      end if;$fragment$;
begin
  v_function := 'public.get_delivery_pos_context(uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_aggregate_source_branch) = 0
    or strpos(v_definition, v_aggregate_quantity) = 0 then
    raise exception 'get_delivery_pos_context does not contain the expected aggregate stock source';
  end if;
  v_definition := replace(v_definition, v_aggregate_source_branch, v_courier_source_branch);
  v_definition := replace(v_definition, v_aggregate_quantity, v_available_quantity);
  v_definition := replace(v_definition, $$'id', null$$, $$'id', case when public.current_app_role() = 'courier' then location.id else null end$$);
  v_definition := replace(v_definition, $$'code', 'DAILY'$$, $$'code', case when public.current_app_role() = 'courier' then location.code else 'DAILY' end$$);
  v_definition := replace(v_definition, $$'name', 'สต๊อกรวมประจำวัน'$$, $$'name', case when public.current_app_role() = 'courier' then location.name else 'สต๊อกรวมประจำวัน' end$$);
  v_definition := replace(v_definition, $$'kind', 'daily'$$, $$'kind', case when public.current_app_role() = 'courier' then location.kind::text else 'daily' end$$);
  execute v_definition;

  v_function := 'public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_aggregate_source_branch) = 0
    or strpos(v_definition, v_daily_only_check) = 0 then
    raise exception 'record_delivery does not contain the expected aggregate stock validation';
  end if;
  v_definition := replace(v_definition, v_aggregate_source_branch, v_courier_source_branch);
  execute replace(v_definition, v_daily_only_check, v_courier_and_daily_check);

  v_function := 'public.apply_open_delivery_correction(uuid,text,jsonb,public.shop_round_status,text,text,uuid,uuid)'::regprocedure;
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_correction_daily_only_check) = 0 then
    raise exception 'apply_open_delivery_correction does not contain the expected aggregate stock validation';
  end if;
  execute replace(
    v_definition,
    v_correction_daily_only_check,
    v_correction_holding_and_daily_check
  );
end;
$migration$;
