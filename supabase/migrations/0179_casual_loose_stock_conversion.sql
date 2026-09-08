-- Freeze the standard price for each day / holding location / ice type.
-- Only unmeasured paid sales contribute; measured sales already deduct stock.
create table public.casual_loose_stock_prices (
  service_date date not null,
  source_stock_location_id uuid not null references public.stock_locations(id),
  ice_type_id uuid not null references public.ice_types(id),
  unit_price numeric not null check (unit_price > 0),
  recorded_at timestamptz not null default now(),
  primary key (service_date, source_stock_location_id, ice_type_id)
);
alter table public.casual_loose_stock_prices enable row level security;
revoke all on table public.casual_loose_stock_prices from public, anon, authenticated;
create trigger casual_loose_stock_prices_immutable before update or delete on public.casual_loose_stock_prices
for each row execute function public.protect_casual_immutable_row();

-- Historical open days can be reconciled at their service-date price. Do not
-- change stock on already closed days, or infer a price where none exists.
insert into public.casual_loose_stock_prices (service_date, source_stock_location_id, ice_type_id, unit_price)
select distinct transaction.service_date, transaction.source_stock_location_id, transaction.ice_type_id, price.unit_price
from public.casual_transactions transaction
join lateral (
  select price.unit_price from public.ice_type_prices price
  where price.ice_type_id = transaction.ice_type_id and price.is_active
    and price.valid_from <= transaction.service_date
    and (price.valid_to is null or price.valid_to >= transaction.service_date)
  order by price.valid_from desc limit 1
) price on true
where transaction.fulfillment_mode = 'loose' and transaction.transaction_kind = 'paid'
  and not exists (select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = transaction.service_date)
  and not exists (select 1 from public.daily_stock_closures closure
    where closure.service_date = transaction.service_date);

create function public.casual_loose_stock_totals(p_service_date date)
returns table (source_stock_location_id uuid, ice_type_id uuid, unit_price numeric,
  sales_amount numeric, quantity numeric, remainder_amount numeric)
language sql stable security definer set search_path = public as $$
  select price.source_stock_location_id, price.ice_type_id, price.unit_price,
    coalesce(sum(transaction.sale_amount), 0),
    floor(coalesce(sum(transaction.sale_amount), 0) / price.unit_price),
    mod(coalesce(sum(transaction.sale_amount), 0), price.unit_price)
  from public.casual_loose_stock_prices price
  left join public.casual_transactions transaction
    on transaction.service_date = price.service_date
    and transaction.source_stock_location_id = price.source_stock_location_id
    and transaction.ice_type_id = price.ice_type_id
    and transaction.fulfillment_mode = 'loose' and transaction.transaction_kind = 'paid'
    and transaction.status = 'active'
  where price.service_date = p_service_date
  group by price.source_stock_location_id, price.ice_type_id, price.unit_price;
$$;

alter function public.stock_balance_at(date, uuid, uuid) rename to stock_balance_at_without_loose;
create function public.stock_balance_at(p_service_date date, p_location_id uuid, p_ice_type_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select public.stock_balance_at_without_loose(p_service_date, p_location_id, p_ice_type_id)
    - coalesce((select sum(bucket.quantity) from public.casual_loose_stock_totals(p_service_date) bucket
      where bucket.source_stock_location_id = p_location_id and bucket.ice_type_id = p_ice_type_id), 0);
$$;

alter function public.daily_aggregate_stock_balance_at(date, uuid) rename to daily_aggregate_stock_balance_at_without_loose;
create function public.daily_aggregate_stock_balance_at(p_service_date date, p_ice_type_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = p_service_date and closure.status = 'closed') then 0
  else public.daily_aggregate_stock_balance_at_without_loose(p_service_date, p_ice_type_id)
    - coalesce((select sum(bucket.quantity) from public.casual_loose_stock_totals(p_service_date) bucket
      where bucket.ice_type_id = p_ice_type_id), 0) end;
$$;

-- The close screen's sold breakdown must explain the same casual deductions
-- as its available balance, including measured free issues as in reconciliation.
alter function public.get_daily_aggregate_stock_summary(date) rename to get_daily_aggregate_stock_summary_without_casual;
create function public.get_daily_aggregate_stock_summary(p_service_date date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb; v_service_date date;
begin
  v_result := public.get_daily_aggregate_stock_summary_without_casual(p_service_date);
  v_service_date := (v_result->>'service_date')::date;
  return jsonb_set(v_result, '{items}', coalesce((
    select jsonb_agg(item.value || jsonb_build_object('sold_quantity',
      (item.value->>'sold_quantity')::numeric
      + coalesce((select sum(transaction.quantity) from public.casual_transactions transaction
        where transaction.service_date = v_service_date and transaction.status = 'active'
          and transaction.fulfillment_mode = 'measured'
          and transaction.ice_type_id = (item.value->>'ice_type_id')::uuid), 0)
      + coalesce((select sum(bucket.quantity) from public.casual_loose_stock_totals(v_service_date) bucket
        where bucket.ice_type_id = (item.value->>'ice_type_id')::uuid), 0)
    ) order by item.ordinality)
    from jsonb_array_elements(v_result->'items') with ordinality item(value, ordinality)
  ), '[]'::jsonb));
end;
$$;

create function public.prepare_casual_loose_stock_price()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_price numeric;
begin
  if new.fulfillment_mode <> 'loose' or new.transaction_kind <> 'paid' then return new; end if;
  -- Same lock as sale, void, transfer and daily close; no independent counter.
  perform pg_advisory_xact_lock(hashtextextended(new.service_date::text, 0));
  select price.unit_price into v_price from public.casual_loose_stock_prices price
  where price.service_date = new.service_date
    and price.source_stock_location_id = new.source_stock_location_id and price.ice_type_id = new.ice_type_id;
  if v_price is null then
    select price.unit_price into v_price from public.ice_type_prices price
    where price.ice_type_id = new.ice_type_id and price.is_active
      and price.valid_from <= new.service_date and (price.valid_to is null or price.valid_to >= new.service_date)
    order by price.valid_from desc limit 1;
    if v_price is null then raise exception 'กรุณาตั้งราคากลางของน้ำแข็งก่อนบันทึกขาจรแบบไม่ระบุจำนวน'; end if;
    insert into public.casual_loose_stock_prices values
      (new.service_date, new.source_stock_location_id, new.ice_type_id, v_price, now());
  end if;
  return new;
end;
$$;
create trigger casual_loose_stock_price_before_insert before insert on public.casual_transactions
for each row execute function public.prepare_casual_loose_stock_price();

create function public.validate_casual_loose_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.fulfillment_mode = 'loose' and new.transaction_kind = 'paid' then
    if public.stock_balance_at(new.service_date, new.source_stock_location_id, new.ice_type_id) < 0
      or public.daily_aggregate_stock_balance_at(new.service_date, new.ice_type_id) < 0 then
      raise exception 'สต๊อกไม่พอสำหรับจำนวนถุงที่รวมจากยอดขายขาจร';
    end if;
  end if;
  return null;
end;
$$;
create trigger casual_loose_stock_after_insert after insert on public.casual_transactions
for each row execute function public.validate_casual_loose_stock();

alter function public.accounting_aggregate_reconciliation_rows(date) rename to accounting_aggregate_reconciliation_rows_without_loose;
create function public.accounting_aggregate_reconciliation_rows(p_service_date date)
returns table (id uuid, code text, name text, unit text, factory_in numeric, sold numeric,
  damaged numeric, returned_to_factory numeric, expected numeric, actual numeric, variance numeric, count_status text)
language sql stable security definer set search_path = public as $$
  select row.id, row.code, row.name, row.unit, row.factory_in, row.sold + loose.quantity,
    row.damaged, row.returned_to_factory, row.expected - loose.quantity, row.actual,
    row.variance + loose.quantity, row.count_status
  from public.accounting_aggregate_reconciliation_rows_without_loose(p_service_date) row
  cross join lateral (select coalesce(sum(bucket.quantity), 0) as quantity
    from public.casual_loose_stock_totals(p_service_date) bucket where bucket.ice_type_id = row.id) loose;
$$;

alter function public.get_casual_transaction_context(uuid) rename to get_casual_transaction_context_without_loose;
create function public.get_casual_transaction_context(p_round_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb;
begin
  v_result := public.get_casual_transaction_context_without_loose(p_round_id);
  return jsonb_set(v_result, '{loose_stock}', coalesce((
    select jsonb_agg(to_jsonb(bucket)) from public.casual_loose_stock_totals((v_result->>'service_date')::date) bucket
    where bucket.source_stock_location_id = (v_result->'stock_source'->>'id')::uuid
  ), '[]'::jsonb));
end;
$$;

-- Attribute each newly completed bag to the sale which crosses the threshold.
-- The active-sale projection is recomputed after a void, just like stock totals.
alter function public.accounting_casual_transaction_rows(date, date) rename to accounting_casual_transaction_rows_without_conversion;
create function public.accounting_casual_transaction_rows(p_from_date date, p_to_date date)
returns table (
  occurred_at timestamptz, service_date date, type text, group_id uuid,
  source_id uuid, source_table text, delivery_event_id uuid, payment_id uuid,
  document_number text, reference_number text, shop_id uuid, shop_code text,
  shop_name text, holder_name text, employee_id uuid, employee_name text,
  ice_type_id uuid, ice_type_name text, unit text, quantity_in numeric,
  quantity_out numeric, sales_amount numeric, cash_in numeric, cash_out numeric,
  receivable_delta numeric, status text, note text, issue_code text,
  issue_label text, can_correct boolean, details jsonb
)
language sql stable security definer set search_path = public as $$
  with running_sales as (
    select transaction.id, transaction.sale_amount, price.unit_price,
      sum(transaction.sale_amount) over (
        partition by transaction.service_date, transaction.source_stock_location_id, transaction.ice_type_id
        order by transaction.recorded_at, transaction.id rows unbounded preceding
      ) as running_amount
    from public.casual_transactions transaction
    join public.casual_loose_stock_prices price
      on price.service_date = transaction.service_date
      and price.source_stock_location_id = transaction.source_stock_location_id
      and price.ice_type_id = transaction.ice_type_id
    where transaction.status = 'active' and transaction.fulfillment_mode = 'loose'
      and transaction.transaction_kind = 'paid'
      and transaction.service_date between p_from_date and p_to_date
  )
  select row.occurred_at, row.service_date, row.type, row.group_id,
    row.source_id, row.source_table, row.delivery_event_id, row.payment_id,
    row.document_number, row.reference_number, row.shop_id, row.shop_code,
    row.shop_name, row.holder_name, row.employee_id, row.employee_name,
    row.ice_type_id, row.ice_type_name, row.unit, row.quantity_in,
    case when row.type = 'SALE' and running.id is not null
      then floor(running.running_amount / running.unit_price)
        - floor((running.running_amount - running.sale_amount) / running.unit_price)
      else row.quantity_out end,
    row.sales_amount, row.cash_in, row.cash_out, row.receivable_delta, row.status,
    row.note, row.issue_code, row.issue_label, row.can_correct,
    case when row.type = 'SALE' and running.id is not null then coalesce(row.details, '{}'::jsonb)
      || jsonb_build_object('stock_conversion_unit_price', running.unit_price, 'stock_conversion_running_amount', running.running_amount)
      else row.details end
  from public.accounting_casual_transaction_rows_without_conversion(p_from_date, p_to_date) row
  left join running_sales running on running.id = row.source_id;
$$;

revoke all on function public.casual_loose_stock_totals(date) from public, anon, authenticated;
revoke all on function public.accounting_casual_transaction_rows_without_conversion(date, date) from public, anon, authenticated;
revoke all on function public.accounting_casual_transaction_rows(date, date) from public, anon, authenticated;
revoke all on function public.prepare_casual_loose_stock_price() from public, anon, authenticated;
revoke all on function public.validate_casual_loose_stock() from public, anon, authenticated;
revoke all on function public.stock_balance_at_without_loose(date, uuid, uuid) from public, anon, authenticated;
revoke all on function public.daily_aggregate_stock_balance_at_without_loose(date, uuid) from public, anon, authenticated;
revoke all on function public.get_daily_aggregate_stock_summary_without_casual(date) from public, anon, authenticated;
revoke all on function public.accounting_aggregate_reconciliation_rows_without_loose(date) from public, anon, authenticated;
revoke all on function public.get_casual_transaction_context_without_loose(uuid) from public, anon, authenticated;
revoke all on function public.stock_balance_at(date, uuid, uuid) from public, anon, authenticated;
revoke all on function public.daily_aggregate_stock_balance_at(date, uuid) from public, anon, authenticated;
revoke all on function public.get_daily_aggregate_stock_summary(date) from public, anon;
grant execute on function public.get_daily_aggregate_stock_summary(date) to authenticated;
revoke all on function public.accounting_aggregate_reconciliation_rows(date) from public, anon, authenticated;
revoke all on function public.get_casual_transaction_context(uuid) from public, anon;
grant execute on function public.get_casual_transaction_context(uuid) to authenticated;
notify pgrst, 'reload schema';
