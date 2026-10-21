-- New sales carry an explicit selling building and cash owner. No historical backfill.
alter table public.casual_transactions
  add column sale_building_id uuid references public.buildings(id),
  add column cash_received_by uuid references public.users(id);
create index casual_transactions_building_date on public.casual_transactions(sale_building_id, service_date);

-- Extend the existing canonical writers without weakening their stock, receipt,
-- evidence, retry or closed-day checks. Older clients can still omit the new fields.
do $upgrade$
declare
  v_signature text;
  v_name text;
  v_definition text;
  v_before text;
begin
  for v_name, v_signature in select * from (values
    ('record_casual_transaction', 'uuid,uuid,numeric,casual_transaction_kind,numeric,payment_method,numeric,text,text,text,timestamptz,uuid'),
    ('record_casual_loose_transaction', 'uuid,uuid,casual_transaction_kind,numeric,payment_method,numeric,text,text,text,timestamptz,uuid')
  ) writers(name, signature) loop
    v_definition := pg_get_functiondef(('public.' || v_name || '(' || v_signature || ')')::regprocedure);
    execute format('alter function public.%I(%s) rename to %I', v_name, v_signature, v_name || '_without_building');
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', v_name || '_without_building', v_signature);
    v_before := v_definition;
    v_definition := replace(v_definition, 'p_idempotency_key uuid)',
      'p_idempotency_key uuid, p_sale_building_id uuid DEFAULT NULL, p_cash_received_by uuid DEFAULT NULL)');
    if v_before = v_definition then raise exception 'Casual writer signature changed: %', v_name; end if;
    -- Keep legacy request fingerprints identical when both new fields are absent.
    v_before := v_definition;
    v_definition := replace(v_definition, ')::text) into v_request_fingerprint;', $replacement$)
      || case when p_sale_building_id is null and p_cash_received_by is null then '{}'::jsonb
         else jsonb_build_object('sale_building_id', p_sale_building_id,
           'cash_received_by', case when p_transaction_kind = 'paid' then coalesce(p_cash_received_by, auth.uid()) else null end) end
    )::text) into v_request_fingerprint;$replacement$);
    v_definition := replace(v_definition, 'select md5(jsonb_build_object(', 'select md5((jsonb_build_object(');
    if v_before = v_definition then raise exception 'Casual writer fingerprint changed: %', v_name; end if;
    v_before := v_definition;
    v_definition := replace(v_definition, '  select round.service_date into v_service_date', $validation$
  if p_sale_building_id is not null and not exists (
    select 1 from public.buildings where id = p_sale_building_id and is_active
  ) then raise exception 'กรุณาเลือกตึกที่เปิดใช้งาน'; end if;
  if p_cash_received_by is not null and p_sale_building_id is null then
    raise exception 'กรุณาเลือกตึกที่ขาย';
  end if;
  if p_transaction_kind = 'free' and p_cash_received_by is not null then
    raise exception 'รายการแจกฟรีไม่มีผู้รับเงิน';
  end if;
  if p_cash_received_by is not null and (
    (p_cash_received_by <> auth.uid() and public.current_app_role() not in ('admin', 'round_lead'))
    or not exists (select 1 from public.users where id = p_cash_received_by
      and is_active and role in ('courier', 'admin', 'round_lead'))
  ) then raise exception 'ไม่สามารถระบุผู้รับเงินคนนี้ได้'; end if;

  select round.service_date into v_service_date$validation$);
    if v_before = v_definition then raise exception 'Casual writer validation anchor changed: %', v_name; end if;
    v_before := v_definition;
    v_definition := replace(v_definition,
      'receipt_number, idempotency_key, request_fingerprint, client_recorded_at, recorded_by',
      'receipt_number, idempotency_key, request_fingerprint, client_recorded_at, recorded_by, sale_building_id, cash_received_by');
    v_definition := replace(v_definition,
      'v_receipt_number, p_idempotency_key, v_request_fingerprint, p_client_recorded_at, auth.uid()',
      'v_receipt_number, p_idempotency_key, v_request_fingerprint, p_client_recorded_at, auth.uid(), p_sale_building_id, case when p_transaction_kind = ''paid'' and p_sale_building_id is not null then coalesce(p_cash_received_by, auth.uid()) else null end');
    if v_before = v_definition then raise exception 'Casual writer insert anchor changed: %', v_name; end if;
    execute v_definition;
    execute format('revoke all on function public.%I(%s,uuid,uuid) from public, anon', v_name, v_signature);
    execute format('grant execute on function public.%I(%s,uuid,uuid) to authenticated', v_name, v_signature);
  end loop;
end;
$upgrade$;

alter function public.get_casual_transaction_context(uuid) rename to get_casual_transaction_context_without_building;
create function public.get_casual_transaction_context(p_round_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb;
begin
  v_result := public.get_casual_transaction_context_without_building(p_round_id);
  return v_result || jsonb_build_object(
    'sale_buildings', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by code)
      from public.buildings where is_active), '[]'::jsonb),
    'default_receiver_id', auth.uid(),
    'cash_receivers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', display_name) order by display_name)
      from public.users where is_active and role in ('courier', 'admin', 'round_lead')
        and (id = auth.uid() or public.current_app_role() in ('admin', 'round_lead'))), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(entry.value || jsonb_build_object(
      'sale_building_id', sale.sale_building_id, 'sale_building_name', building.name,
      'cash_received_by', sale.cash_received_by, 'receiver_name', receiver.display_name)
      order by entry.ordinality)
      from jsonb_array_elements(v_result->'history') with ordinality entry(value, ordinality)
      join public.casual_transactions sale on sale.id = (entry.value->>'id')::uuid
      left join public.buildings building on building.id = sale.sale_building_id
      left join public.users receiver on receiver.id = coalesce(sale.cash_received_by, sale.recorded_by)), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_casual_transaction_context_without_building(uuid) from public, anon, authenticated;
revoke all on function public.get_casual_transaction_context(uuid) from public, anon;
grant execute on function public.get_casual_transaction_context(uuid) to authenticated;

-- Cash ownership follows the explicit recipient for NEW sales only; old rows
-- and closed-day snapshots keep their existing attribution. No new close UI.
do $$
declare v_definition text;
begin
  v_definition := pg_get_functiondef('public.daily_close_cash_sources(date)'::regprocedure);
  if strpos(v_definition, 'sale.recorded_by') = 0 then raise exception 'Casual cash source anchor changed'; end if;
  execute replace(v_definition, 'sale.recorded_by', 'coalesce(sale.cash_received_by, sale.recorded_by)');
end;
$$;

-- Extra building rows are separate from casual_days so existing summaries and
-- exports keep their original contract. The UI uses legacy days + building rows.
alter function public.get_accounting_shop_daily_matrix(date,date,uuid[]) rename to get_accounting_shop_daily_matrix_without_building;
create function public.get_accounting_shop_daily_matrix(p_from_date date, p_to_date date, p_shop_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb; v_groups jsonb;
begin
  -- Existing reader enforces manager permissions and the 31-day range bound.
  v_result := public.get_accounting_shop_daily_matrix_without_building(p_from_date, p_to_date, p_shop_ids);
  with active_sales as materialized (
    select sale.*, price.unit_price,
      sum(sale.sale_amount) over (
        partition by sale.service_date, sale.source_stock_location_id, sale.ice_type_id
        order by sale.recorded_at, sale.id rows unbounded preceding) as running_amount,
      row_number() over (
        partition by sale.service_date, sale.source_stock_location_id, sale.ice_type_id
        order by sale.recorded_at desc, sale.id desc) as last_position
    from public.casual_transactions sale
    left join public.casual_loose_stock_prices price
      on price.service_date = sale.service_date
      and price.source_stock_location_id = sale.source_stock_location_id
      and price.ice_type_id = sale.ice_type_id and sale.fulfillment_mode = 'loose'
    where sale.status = 'active' and sale.fulfillment_mode = 'loose'
      and sale.service_date between p_from_date and p_to_date
  ), quantities as (
    select sale.sale_building_id, sale.service_date, sale.ice_type_id,
      coalesce(sale.quantity, 0) as quantity, 0::numeric as automatic_quantity,
      0::numeric as remainder_amount, 0::numeric as unconverted_amount,
      case when sale.transaction_kind = 'free' then coalesce(sale.quantity, 0) else 0 end as free_quantity,
      0::bigint as loose_count, 0::numeric as loose_sales_amount
    from public.casual_transactions sale
    where sale.status = 'active' and sale.fulfillment_mode = 'measured'
      and sale.service_date between p_from_date and p_to_date
    union all
    select sale.sale_building_id, sale.service_date, sale.ice_type_id,
      coalesce(floor(sale.running_amount / sale.unit_price) - floor((sale.running_amount - sale.sale_amount) / sale.unit_price), 0),
      coalesce(floor(sale.running_amount / sale.unit_price) - floor((sale.running_amount - sale.sale_amount) / sale.unit_price), 0),
      case when sale.last_position = 1 then coalesce(mod(sale.running_amount, sale.unit_price), 0) else 0 end,
      case when sale.unit_price is null then sale.sale_amount else 0 end,
      0, 1, sale.sale_amount
    from active_sales sale
  ), items as (
    select sale_building_id, service_date, ice_type_id, sum(quantity) as quantity,
      sum(automatic_quantity) as automatic_quantity, sum(remainder_amount) as remainder_amount,
      sum(unconverted_amount) as unconverted_amount, sum(free_quantity) as free_quantity,
      sum(loose_count) as loose_count, sum(loose_sales_amount) as loose_sales_amount
    from quantities group by sale_building_id, service_date, ice_type_id
  ), activity as (
    select sale.sale_building_id, sale.service_date, sale.sale_amount as sales_amount,
      0::numeric as cash_received, 0::numeric as transfer_received,
      0::numeric as cash_refunded, 0::numeric as transfer_refunded, 1 as transaction_count
    from public.casual_transactions sale
    where sale.status = 'active' and sale.service_date between p_from_date and p_to_date
    union all
    select sale.sale_building_id, (sale.recorded_at at time zone 'Asia/Bangkok')::date, 0,
      case when sale.payment_method = 'cash' then sale.sale_amount else 0 end,
      case when sale.payment_method in ('bank_transfer', 'qr') then sale.sale_amount else 0 end, 0, 0, 0
    from public.casual_transactions sale
    where sale.transaction_kind = 'paid'
      and sale.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and sale.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
    union all
    select sale.sale_building_id, (refund.confirmed_at at time zone 'Asia/Bangkok')::date, 0, 0, 0,
      case when refund.refund_method = 'cash' then refund.refunded_amount else 0 end,
      case when refund.refund_method in ('bank_transfer', 'qr') then refund.refunded_amount else 0 end, 0
    from public.casual_refund_confirmations refund
    join public.casual_transactions sale on sale.id = refund.transaction_id
    where refund.confirmed_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and refund.confirmed_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
  ), days as (
    select sale_building_id, service_date, sum(sales_amount) as sales_amount,
      sum(cash_received) as cash_received, sum(transfer_received) as transfer_received,
      sum(cash_refunded) as cash_refunded, sum(transfer_refunded) as transfer_refunded,
      sum(transaction_count) as transaction_count
    from activity group by sale_building_id, service_date
  ), building_days as (
    select day.sale_building_id,
      jsonb_agg((to_jsonb(day) - 'sale_building_id') || jsonb_build_object(
        'items', coalesce((select jsonb_agg(to_jsonb(item) - array['sale_building_id', 'service_date'] order by item.ice_type_id)
          from items item where item.sale_building_id is not distinct from day.sale_building_id
            and item.service_date = day.service_date), '[]'::jsonb)
      ) order by day.service_date) as days
    from days day group by day.sale_building_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('building_id', group_row.sale_building_id,
    'building_name', building.name, 'days', group_row.days,
    'transactions', coalesce((select jsonb_agg(jsonb_build_object(
      'id', sale.id, 'service_date', sale.service_date, 'recorded_at', sale.recorded_at,
      'ice_type_name', ice.name, 'quantity', sale.quantity, 'sale_amount', sale.sale_amount,
      'payment_method', sale.payment_method, 'status', sale.status,
      'receiver_name', receiver.display_name, 'recorder_name', recorder.display_name,
      'refunded_at', refund.confirmed_at, 'refunded_amount', refund.refunded_amount,
      'refund_method', refund.refund_method)
      order by sale.recorded_at, sale.id)
      from public.casual_transactions sale
      join public.ice_types ice on ice.id = sale.ice_type_id
      join public.users recorder on recorder.id = sale.recorded_by
      left join public.users receiver on receiver.id = coalesce(sale.cash_received_by, sale.recorded_by)
      left join public.casual_refund_confirmations refund on refund.transaction_id = sale.id
      where sale.sale_building_id = group_row.sale_building_id
        and (sale.service_date between p_from_date and p_to_date
          or (sale.recorded_at at time zone 'Asia/Bangkok')::date between p_from_date and p_to_date
          or (refund.confirmed_at at time zone 'Asia/Bangkok')::date between p_from_date and p_to_date)), '[]'::jsonb)
  ) order by building.code nulls first), '[]'::jsonb) into v_groups
  from building_days group_row left join public.buildings building on building.id = group_row.sale_building_id;

  return v_result || jsonb_build_object(
    'casual_legacy_days', coalesce((select value->'days' from jsonb_array_elements(v_groups)
      where value->>'building_id' is null), '[]'::jsonb),
    'casual_buildings', coalesce((select jsonb_agg(value) from jsonb_array_elements(v_groups)
      where value->>'building_id' is not null), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_accounting_shop_daily_matrix_without_building(date,date,uuid[]) from public, anon, authenticated;
revoke all on function public.get_accounting_shop_daily_matrix(date,date,uuid[]) from public, anon;
grant execute on function public.get_accounting_shop_daily_matrix(date,date,uuid[]) to authenticated;
notify pgrst, 'reload schema';
