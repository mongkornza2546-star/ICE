-- Sales match accounting (0223): net of stored VAT, including active corrections.
-- Cash and current debt remain gross. No cost/expense/bank-balance ledger exists.
do $patch$
declare
  definition text;
begin
  definition := pg_get_functiondef('public.executive_report_facts(date,date)'::regprocedure);
  if strpos(definition, 'public.effective_delivery_charge_amount(charge.id), null::text,') = 0 then
    raise exception 'Executive sales boundary changed';
  end if;
  execute replace(definition, 'public.effective_delivery_charge_amount(charge.id), null::text,',
    '(public.effective_delivery_charge_amount(charge.id) - charge.vat_amount), null::text,');

  definition := pg_get_functiondef('public.get_executive_report(date,date)'::regprocedure);
  if strpos(definition, '''previousSales'', previous_totals.sales,') = 0 then
    raise exception 'Executive comparison boundary changed';
  end if;
  definition := replace(definition, '''previousSales'', previous_totals.sales,',
    '''financialVersion'', 1, ''previousReceipts'', previous_totals.receipts, ''previousRefunds'', previous_totals.refunds,
    ''scopeOptions'', coalesce((select jsonb_agg(jsonb_build_object(''id'', id, ''name'', name) order by name, id) from public.shops), ''[]''::jsonb),
    ''previousSales'', previous_totals.sales,');
  execute definition;

  definition := pg_get_functiondef('public.executive_report_insights(date,date)'::regprocedure);
  execute replace(definition, 'public.effective_delivery_charge_amount(charge.id) as amount',
    '(public.effective_delivery_charge_amount(charge.id) - charge.vat_amount) as amount');

  definition := pg_get_functiondef('public.get_executive_report_invoice(uuid)'::regprocedure);
  execute replace(definition, '''total'', public.effective_delivery_charge_amount(charge.id),',
    '''sales'', public.effective_delivery_charge_amount(charge.id) - charge.vat_amount,
    ''vat'', charge.vat_amount, ''total'', public.effective_delivery_charge_amount(charge.id),');
end;
$patch$;

-- One canonical current-debt projection for scoped totals and aging drilldowns.
create function public.executive_financial_balances(p_shop_id uuid default null)
returns table(id uuid, day date, shop_id uuid, label text, amount numeric, due_date date, bucket text)
language sql stable security definer set search_path = public as $$
  with balances as (
    select c.id, c.service_date, c.shop_id, s.name,
      greatest(0, public.effective_delivery_charge_amount(c.id) - coalesce((
        select sum(a.amount) from public.payment_allocations a
        join public.payments p on p.id = a.payment_id
        where a.charge_id = c.id and p.status = 'active'), 0)) as amount,
      coalesce(c.due_date, c.service_date) as due_date
    from public.delivery_charges c
    left join public.delivery_events e on e.id = c.delivery_event_id
    join public.shops s on s.id = c.shop_id
    where c.status = 'active'
      and (e.status = 'active' or c.tank_rental_id is not null or c.event_tank_rental_id is not null)
      and (p_shop_id is null or c.shop_id = p_shop_id)
  )
  select *, case when due_date >= (now() at time zone 'Asia/Bangkok')::date then 'notDue'
    when (now() at time zone 'Asia/Bangkok')::date - due_date <= 7 then 'days1to7'
    when (now() at time zone 'Asia/Bangkok')::date - due_date <= 30 then 'days8to30'
    else 'days31plus' end
  from balances where amount > 0;
$$;
revoke all on function public.executive_financial_balances(uuid) from public, anon, authenticated;

create function public.get_executive_report_for_shop(p_from date, p_to date, p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare base jsonb; result jsonb;
begin
  -- Reuse the existing active-admin authorization and bounded-date validation.
  if not public.is_active_user() or public.current_app_role() is distinct from 'admin' then
    raise exception 'Only an active admin can view executive reports';
  end if;
  base := public.get_executive_report(p_from, p_to);
  if p_shop_id is null or not exists (select 1 from public.shops where id = p_shop_id) then
    raise exception 'Choose an existing shop';
  end if;
  with facts as materialized (
    select * from public.executive_report_facts(p_from - (p_to - p_from + 1), p_to)
    where shop_id = p_shop_id
  ), period as materialized (select * from facts where day between p_from and p_to),
  totals as (
    select coalesce(sum(amount) filter (where kind = 'sale' and day >= p_from), 0) as sales,
      coalesce(sum(amount) filter (where kind = 'receipt' and day >= p_from), 0) as receipts,
      coalesce(sum(amount) filter (where kind = 'refund' and day >= p_from), 0) as refunds,
      coalesce(sum(amount) filter (where kind = 'sale' and day < p_from), 0) as previous_sales,
      coalesce(sum(amount) filter (where kind = 'receipt' and day < p_from), 0) as previous_receipts,
      coalesce(sum(amount) filter (where kind = 'refund' and day < p_from), 0) as previous_refunds
    from facts
  ), debt as materialized (select * from public.executive_financial_balances(p_shop_id)),
  aging as (
    select b.bucket, b.position, coalesce(sum(d.amount), 0) as amount,
      count(distinct d.shop_id) as shops
    from (values ('notDue', 1), ('days1to7', 2), ('days8to30', 3), ('days31plus', 4)) b(bucket, position)
    left join debt d on d.bucket = b.bucket group by b.bucket, b.position
  ), trend as (
    select (key->>'date')::date as day,
      coalesce(sum(p.amount) filter (where p.kind = 'sale'), 0) as sales,
      coalesce(sum(p.amount) filter (where p.kind = 'receipt'), 0) as receipts,
      coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as refunds
    from jsonb_array_elements(base->'trend') key
    left join period p on date_trunc(case when p_to - p_from > 30 then 'month' else 'day' end,
      p.day::timestamp)::date = (key->>'date')::date
    group by key->>'date'
  ), areas as (
    select area_kind, area_id, area_name, sum(amount) as sales
    from period where kind = 'sale' group by area_kind, area_id, area_name
  ), methods as (
    select coalesce(method, 'other') as method, sum(amount) as amount
    from period where kind = 'receipt' group by coalesce(method, 'other')
  )
  select jsonb_build_object(
    'scopeShopId', p_shop_id, 'scopeName', (select name from public.shops where id = p_shop_id),
    'sales', sales, 'receipts', receipts, 'refunds', refunds, 'netReceipts', receipts - refunds,
    'previousSales', previous_sales, 'previousReceipts', previous_receipts,
    'previousRefunds', previous_refunds, 'previousNetReceipts', previous_receipts - previous_refunds,
    'outstanding', (select coalesce(sum(amount), 0) from debt),
    'overdue', (select coalesce(sum(amount) filter (where bucket <> 'notDue'), 0) from debt),
    'debtors', (select count(distinct shop_id) from debt),
    'debtAging', (select jsonb_agg(jsonb_build_object('bucket', bucket, 'amount', amount, 'shops', shops) order by position) from aging),
    'trend', (select jsonb_agg(jsonb_build_object('date', day, 'sales', sales, 'receipts', receipts, 'refunds', refunds) order by day) from trend),
    'areas', coalesce((select jsonb_agg(jsonb_build_object('kind', area_kind, 'id', area_id, 'name', area_name, 'sales', sales) order by sales desc) from areas), '[]'::jsonb),
    'shops', jsonb_build_array(jsonb_build_object('id', p_shop_id, 'name', (select name from public.shops where id = p_shop_id), 'sales', sales)),
    'receiptMethods', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'amount', amount) order by amount desc, method) from methods), '[]'::jsonb),
    'quietShops', null, 'products', '[]'::jsonb, 'volumeAreas', null,
    'deliveryCount', (select count(*) from public.delivery_charges c join public.delivery_events e on e.id = c.delivery_event_id
      where c.shop_id = p_shop_id and c.status = 'active' and e.status = 'active' and c.service_date between p_from and p_to)
  ) into result from totals;
  -- Volume/damage has no reliable shop allocation; do not leak whole-business quantities.
  return base || result;
end;
$$;
revoke all on function public.get_executive_report_for_shop(date,date,uuid) from public, anon;
grant execute on function public.get_executive_report_for_shop(date,date,uuid) to authenticated;

create function public.get_executive_report_aged_details(
  p_bucket text, p_shop_id uuid default null, p_limit integer default 50, p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() is distinct from 'admin' then
    raise exception 'Only an active admin can view executive report details';
  end if;
  if p_bucket is null or p_bucket not in ('notDue', 'days1to7', 'days8to30', 'days31plus')
    or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset < 0 then
    raise exception 'Invalid aging request';
  end if;
  with filtered as materialized (
    select * from public.executive_financial_balances(p_shop_id) where bucket = p_bucket
  ), display_rows as (
    select shop_id as id, min(day) as day, shop_id, label, sum(amount) as amount, min(due_date) as due_date
    from filtered where p_shop_id is null group by shop_id, label
    union all
    select id, day, shop_id, label, amount, due_date from filtered where p_shop_id is not null
  )
  select jsonb_build_object('total', (select count(*) from display_rows), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'day', day, 'shopId', shop_id, 'label', label,
      'amount', amount, 'dueDate', due_date) order by amount desc, day, id)
    from (select * from display_rows order by amount desc, day, id limit p_limit offset p_offset) page
  ), '[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.get_executive_report_aged_details(text,uuid,integer,integer) from public, anon;
grant execute on function public.get_executive_report_aged_details(text,uuid,integer,integer) to authenticated;
notify pgrst, 'reload schema';
