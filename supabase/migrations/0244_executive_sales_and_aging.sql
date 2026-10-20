-- Match accounting's stored-VAT sales basis (0223). Receipts, refunds and
-- current receivables keep their gross amounts. Updating the facts reader also
-- updates period comparisons, trends, areas, shops and paginated sales details.
do $sales_basis$
declare
  v_patch record;
  v_definition text;
begin
  for v_patch in select * from (values
    ('public.executive_report_facts(date,date)'::regprocedure,
      'public.effective_delivery_charge_amount(charge.id), null::text,',
      '(public.effective_delivery_charge_amount(charge.id) - charge.vat_amount), null::text,'),
    ('public.executive_report_insights(date,date)'::regprocedure,
      'public.effective_delivery_charge_amount(charge.id) as amount',
      '(public.effective_delivery_charge_amount(charge.id) - charge.vat_amount) as amount'),
    ('public.get_executive_report(date,date)'::regprocedure,
      '''from'', p_from, ''to'', p_to, ''asOf'', now(),',
      '''from'', p_from, ''to'', p_to, ''asOf'', now(),
    ''salesBasis'', ''excluding_vat'', ''agingDetailsVersion'', 1,'),
    ('public.get_executive_report_invoice(uuid)'::regprocedure,
      '''total'', public.effective_delivery_charge_amount(charge.id),',
      '''total'', public.effective_delivery_charge_amount(charge.id),
    ''salesAmount'', public.effective_delivery_charge_amount(charge.id) - charge.vat_amount,
    ''vatAmount'', charge.vat_amount,')
  ) as patches(function_id, old_text, new_text)
  loop
    v_definition := pg_get_functiondef(v_patch.function_id);
    if strpos(v_definition, v_patch.new_text) > 0 then continue; end if;
    if strpos(v_definition, v_patch.old_text) = 0 then
      raise exception 'Executive sales boundary missing in %', v_patch.function_id;
    end if;
    execute replace(v_definition, v_patch.old_text, v_patch.new_text);
  end loop;
end;
$sales_basis$;

-- Keep the legacy date-bucket details endpoint unchanged. Aging is a current
-- Bangkok-date snapshot independent of the report's selected sales period.
create or replace function public.get_executive_report_aging_details(
  p_bucket text, p_shop_id uuid default null,
  p_limit integer default 50, p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  if public.is_active_user() is not true or public.current_app_role() is distinct from 'admin' then
    raise exception 'Only an active admin can view executive report aging details';
  end if;
  if p_bucket is null or p_bucket not in ('notDue', 'days1to7', 'days8to30', 'days31plus')
    or p_limit is null or p_limit not between 1 and 100
    or p_offset is null or p_offset < 0 then
    raise exception 'Invalid executive report aging detail request';
  end if;

  with balances as materialized (
    -- Same active gross receivable projection as the summary and debtAging.
    select charge.id, charge.service_date as day, charge.shop_id, shop.name as label,
      greatest(0, public.effective_delivery_charge_amount(charge.id) - coalesce((
        select sum(allocation.amount) from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id and payment.status = 'active'
      ), 0)) as amount, coalesce(charge.due_date, charge.service_date) as due_date
    from public.delivery_charges charge
    left join public.delivery_events event on event.id = charge.delivery_event_id
    join public.shops shop on shop.id = charge.shop_id
    where charge.status = 'active'
      and (event.status = 'active' or charge.tank_rental_id is not null or charge.event_tank_rental_id is not null)
      and (p_shop_id is null or charge.shop_id = p_shop_id)
  ), aged as (
    select balances.*,
      case when due_date >= v_today then 'notDue'
        when v_today - due_date <= 7 then 'days1to7'
        when v_today - due_date <= 30 then 'days8to30'
        else 'days31plus' end as bucket
    from balances where amount > 0
  ), filtered as (
    select * from aged where bucket = p_bucket
  ), display_rows as (
    select shop_id as id, min(day) as day, shop_id, label,
      sum(amount) as amount, min(due_date) as due_date
    from filtered where p_shop_id is null
    group by shop_id, label
    union all
    select id, day, shop_id, label, amount, due_date
    from filtered where p_shop_id is not null
  )
  select jsonb_build_object('total', (select count(*) from display_rows),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'day', day,
      'label', label, 'amount', amount, 'dueDate', due_date, 'shopId', shop_id)
      order by amount desc, day, id) from (select * from display_rows
        order by amount desc, day, id limit p_limit offset p_offset) page), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$$;

-- Production default grants include authenticated EXECUTE, so explicitly keep
-- the internal readers private after replacing their definitions.
revoke all on function public.executive_report_facts(date, date) from public, anon, authenticated;
revoke all on function public.executive_report_insights(date, date) from public, anon, authenticated;
revoke all on function public.get_executive_report_aging_details(text, uuid, integer, integer) from public, anon;
grant execute on function public.get_executive_report_aging_details(text, uuid, integer, integer) to authenticated;

notify pgrst, 'reload schema';
