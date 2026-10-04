-- Match the numeric shop-code fallback used by the delivery screen (0181).
-- Sort before pagination so the accounting screen and Excel export agree.
do $ordering$
declare
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(
    'public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer)'::regprocedure
  ) into v_definition;
  if strpos(v_definition, 'substring(row.shop_code from ''[0-9]+$'')::numeric') > 0 then
    return;
  end if;

  v_updated := replace(v_definition,
    'case when v_shop_sort = ''area'' then row.shop_code end,',
    $replacement$case when v_shop_sort = 'area' then regexp_replace(row.shop_code, '[0-9]+$', '') end,
        case when v_shop_sort = 'area' then substring(row.shop_code from '[0-9]+$')::numeric end nulls first,
        case when v_shop_sort = 'area' then row.shop_code end,$replacement$);
  if v_updated = v_definition then
    raise exception 'Accounting summary is missing the expected area code ordering';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition,
    'case when v_shop_sort = ''code'' then row.shop_code end,',
    $replacement$case when v_shop_sort = 'code' then regexp_replace(row.shop_code, '[0-9]+$', '') end,
        case when v_shop_sort = 'code' then substring(row.shop_code from '[0-9]+$')::numeric end nulls first,
        case when v_shop_sort = 'code' then row.shop_code end,$replacement$);
  if v_updated = v_definition then
    raise exception 'Accounting summary is missing the expected explicit code ordering';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition,
    'row.shop_code, row.shop_id',
    $replacement$regexp_replace(row.shop_code, '[0-9]+$', ''),
        substring(row.shop_code from '[0-9]+$')::numeric nulls first,
        row.shop_code, row.shop_id$replacement$);
  if v_updated = v_definition then
    raise exception 'Accounting summary is missing the expected code tie breaker';
  end if;
  execute v_updated;
end;
$ordering$;

notify pgrst, 'reload schema';
