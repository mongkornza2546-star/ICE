-- Forward-only correction after 0249. No UPDATE/backfill of transactions,
-- refunds, receipt snapshots, stock conversion or closed-day snapshots.
begin;

alter table public.casual_refund_confirmations
  add column cash_refunded_by uuid references public.users(id);

-- Retain the original void's locks, evidence checks, immutable audit and retry
-- contract; add an explicit cash owner independent of the confirming actor.
do $upgrade$
declare v_definition text; v_before text;
begin
  v_definition := pg_get_functiondef('public.void_casual_transaction(uuid,text,payment_method,text,text,uuid)'::regprocedure);
  alter function public.void_casual_transaction(uuid,text,payment_method,text,text,uuid)
    rename to void_casual_transaction_without_refunder;
  revoke all on function public.void_casual_transaction_without_refunder(uuid,text,payment_method,text,text,uuid)
    from public, anon, authenticated;
  v_before := v_definition;
  v_definition := replace(v_definition, 'p_idempotency_key uuid)',
    'p_idempotency_key uuid, p_cash_refunded_by uuid DEFAULT NULL)');
  if v_before = v_definition then raise exception 'Void signature anchor changed'; end if;
  v_before := v_definition;
  v_definition := replace(v_definition, 'select md5(jsonb_build_object(', 'select md5((jsonb_build_object(');
  v_definition := replace(v_definition, ')::text) into v_request_fingerprint;',
    $patch$) || case when p_cash_refunded_by is null then '{}'::jsonb
      else jsonb_build_object('cash_refunded_by', p_cash_refunded_by) end
    )::text) into v_request_fingerprint;$patch$);
  if v_before = v_definition then raise exception 'Void fingerprint anchor changed'; end if;
  v_before := v_definition;
  v_definition := replace(v_definition, 'elsif v_transaction.recorded_by <> auth.uid()',
    'elsif v_transaction.recorded_by <> auth.uid() and coalesce(v_transaction.cash_received_by, v_transaction.recorded_by) <> auth.uid()');
  if v_before = v_definition then raise exception 'Void permission anchor changed'; end if;
  v_before := v_definition;
  v_definition := replace(v_definition, '  if v_transaction.transaction_kind = ''paid'' then', $patch$
  if p_cash_refunded_by is not null and (
    v_transaction.transaction_kind <> 'paid' or p_refund_method is distinct from 'cash'
    or (p_cash_refunded_by <> auth.uid() and public.current_app_role() not in ('admin', 'round_lead'))
    or not exists (select 1 from public.users where id = p_cash_refunded_by
      and is_active and role in ('courier', 'admin', 'round_lead'))
  ) then raise exception 'ไม่สามารถระบุผู้คืนเงินคนนี้ได้'; end if;

  if v_transaction.transaction_kind = 'paid' then$patch$);
  if v_before = v_definition then raise exception 'Void validation anchor changed'; end if;
  v_before := v_definition;
  v_definition := replace(v_definition, 'evidence_path, confirmed_by, idempotency_key, request_fingerprint',
    'evidence_path, confirmed_by, idempotency_key, request_fingerprint, cash_refunded_by');
  v_definition := replace(v_definition, E'p_idempotency_key, v_request_fingerprint\n    );',
    E'p_idempotency_key, v_request_fingerprint, case when p_refund_method = ''cash'' then coalesce(p_cash_refunded_by, auth.uid()) else null end\n    );');
  if v_before = v_definition then raise exception 'Void insert anchor changed'; end if;
  execute v_definition;
end;
$upgrade$;
revoke all on function public.void_casual_transaction(uuid,text,payment_method,text,text,uuid,uuid) from public, anon;
grant execute on function public.void_casual_transaction(uuid,text,payment_method,text,text,uuid,uuid) to authenticated;

-- The recipient must be able to find, print and cancel a sale entered on their
-- behalf. Broaden only the ownership predicate; keep round/user checks intact.
do $upgrade$
declare v_definition text; v_before text;
begin
  v_definition := pg_get_functiondef('public.get_casual_transaction_context_without_loose(uuid)'::regprocedure);
  v_before := v_definition;
  v_definition := replace(v_definition, 'transaction.recorded_by = auth.uid()',
    '(transaction.recorded_by = auth.uid() or transaction.cash_received_by = auth.uid())');
  if v_before = v_definition then raise exception 'Casual history ownership anchor changed'; end if;
  execute v_definition;

  v_definition := pg_get_functiondef('public.get_casual_receipt_snapshot(uuid)'::regprocedure);
  v_before := v_definition;
  v_definition := replace(v_definition, 'elsif v_transaction.recorded_by <> auth.uid()',
    'elsif v_transaction.recorded_by <> auth.uid() and coalesce(v_transaction.cash_received_by, v_transaction.recorded_by) <> auth.uid()');
  if v_before = v_definition then raise exception 'Receipt ownership anchor changed'; end if;
  execute v_definition;

  v_definition := pg_get_functiondef('public.get_casual_transaction_context(uuid)'::regprocedure);
  v_before := v_definition;
  v_definition := replace(v_definition, '''default_receiver_id'', auth.uid(),',
    '''default_receiver_id'', auth.uid(), ''supports_cash_refunder'', true,');
  if v_before = v_definition then raise exception 'Context capability anchor changed'; end if;
  execute v_definition;

  v_definition := pg_get_functiondef('public.daily_close_cash_sources(date)'::regprocedure);
  v_before := v_definition;
  v_definition := replace(v_definition, 'refund.confirmed_by', 'coalesce(refund.cash_refunded_by, refund.confirmed_by)');
  if v_before = v_definition then raise exception 'Cash refund ownership anchor changed'; end if;
  execute v_definition;
end;
$upgrade$;

-- Reuse the canonical daily reader (including tank rentals/payment splits and
-- adjustments) over ALL active shops in the building. Chunk to its 500-shop
-- bound; p_shop_ids from the visible page must never control a building total.
create function public.accounting_building_shop_days(p_from_date date, p_to_date date, p_building_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_ids uuid[]; v_offset integer := 1; v_batch jsonb;
  v_rows jsonb := '[]'::jsonb; v_ice jsonb := '[]'::jsonb; v_days jsonb;
begin
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_ids
    from public.shops where building_id = p_building_id and status = 'active';
  while v_offset <= cardinality(v_ids) loop
    v_batch := public.get_accounting_shop_daily_matrix_without_building(p_from_date, p_to_date, v_ids[v_offset:v_offset + 499]);
    v_rows := v_rows || (v_batch->'rows');
    v_ice := v_ice || (v_batch->'ice_types');
    v_offset := v_offset + 500;
  end loop;
  with cells as materialized (
    select day from jsonb_array_elements(v_rows) row_data,
      lateral jsonb_array_elements(row_data->'days') day
  ), amounts as (
    select day->>'service_date' as service_date,
      sum((day->>'sales_amount')::numeric) as sales_amount,
      sum((day->>'cash_received')::numeric) as cash_received,
      sum(coalesce((day->>'transfer_received')::numeric, 0)) as transfer_received,
      sum(coalesce((day->>'tank_quantity')::numeric, 0)) as tank_quantity
    from cells group by day->>'service_date'
  ), items as (
    select day->>'service_date' as service_date, item->>'ice_type_id' as ice_type_id,
      sum((item->>'quantity')::numeric) as quantity
    from cells, lateral jsonb_array_elements(day->'items') item
    group by day->>'service_date', item->>'ice_type_id'
  )
  select jsonb_agg(jsonb_build_object(
    'service_date', date.service_date::date,
    'sales_amount', coalesce(amounts.sales_amount, 0), 'cash_received', coalesce(amounts.cash_received, 0),
    'transfer_received', coalesce(amounts.transfer_received, 0), 'tank_quantity', coalesce(amounts.tank_quantity, 0),
    'items', coalesce((select jsonb_agg(to_jsonb(items) - 'service_date' order by ice_type_id)
      from items where items.service_date = date.service_date::date::text), '[]'::jsonb)
  ) order by date.service_date) into v_days
  from generate_series(p_from_date, p_to_date, interval '1 day') date(service_date)
  left join amounts on amounts.service_date = date.service_date::date::text;
  return jsonb_build_object('days', v_days, 'ice_types',
    coalesce((select jsonb_agg(distinct value) from jsonb_array_elements(v_ice)), '[]'::jsonb));
end;
$$;
revoke all on function public.accounting_building_shop_days(date,date,uuid) from public, anon, authenticated;

-- Correct only building projections. Legacy/global conversion remains unchanged;
-- loose money cannot truthfully be attributed as measured bags to one building.
do $upgrade$
declare v_definition text; v_before text;
begin
  v_definition := pg_get_functiondef('public.get_accounting_shop_daily_matrix(date,date,uuid[])'::regprocedure);
  v_before := v_definition;
  v_definition := replace(v_definition,
    'coalesce(floor(sale.running_amount / sale.unit_price) - floor((sale.running_amount - sale.sale_amount) / sale.unit_price), 0)',
    'case when sale.sale_building_id is null then coalesce(floor(sale.running_amount / sale.unit_price) - floor((sale.running_amount - sale.sale_amount) / sale.unit_price), 0) else 0 end');
  v_definition := replace(v_definition, 'case when sale.last_position = 1 then',
    'case when sale.sale_building_id is null and sale.last_position = 1 then');
  v_definition := replace(v_definition, 'case when sale.unit_price is null then sale.sale_amount else 0 end',
    'case when sale.sale_building_id is null and sale.unit_price is null then sale.sale_amount else 0 end');
  if v_before = v_definition then raise exception 'Building quantity anchor changed'; end if;
  v_before := v_definition;
  v_definition := replace(v_definition, 'v_groups jsonb;',
    'v_groups jsonb; v_group jsonb; v_totals jsonb; v_enriched jsonb := ''[]''::jsonb;');
  v_definition := replace(v_definition, E'  return v_result || jsonb_build_object(', $patch$
  for v_group in select value from jsonb_array_elements(v_groups) loop
    if v_group->>'building_id' is not null then
      v_totals := public.accounting_building_shop_days(p_from_date, p_to_date, (v_group->>'building_id')::uuid);
      v_group := v_group || jsonb_build_object('shop_days', v_totals->'days');
      v_result := jsonb_set(v_result, '{ice_types}', (
        select coalesce(jsonb_agg(value order by value->>'code'), '[]'::jsonb)
        from (select distinct value from jsonb_array_elements((v_result->'ice_types') || (v_totals->'ice_types'))) ice
      ));
    end if;
    v_enriched := v_enriched || jsonb_build_array(v_group);
  end loop;
  v_groups := v_enriched;
  return v_result || jsonb_build_object($patch$);
  if v_before = v_definition then raise exception 'Building totals anchor changed'; end if;
  execute v_definition;
end;
$upgrade$;
notify pgrst, 'reload schema';
commit;
