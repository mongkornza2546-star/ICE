-- Sales reporting uses net sales; receipts and receivable balances remain gross.
-- Patch the underlying readers so pagination, groups and Excel share one basis.
do $patch$
declare
  v_function regprocedure;
  v_definition text;
  v_old text;
  v_new text;
  v_patch record;
begin
  for v_patch in select * from (values
    (coalesce(to_regprocedure('public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer)'),
      to_regprocedure('public.get_accounting_shop_summary(date,date,jsonb,integer,integer)')),
      'public.effective_delivery_charge_amount(charge.id)::numeric as effective_amount,',
      'public.effective_delivery_charge_amount(charge.id)::numeric as effective_amount, charge.vat_amount as sales_vat_amount,'),
    (coalesce(to_regprocedure('public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer)'),
      to_regprocedure('public.get_accounting_shop_summary(date,date,jsonb,integer,integer)')),
      'sum(charge.effective_amount) filter (where charge.is_period)',
      'sum(charge.effective_amount - charge.sales_vat_amount) filter (where charge.is_period)'),
    -- 0180 moves the sales reader under the casual wrapper; 0201 then wraps
    -- that wrapper again. Patch the reader, not either outer wrapper.
    (coalesce(to_regprocedure('public.get_accounting_shop_daily_matrix_without_casual(date,date,uuid[])'),
      to_regprocedure('public.get_accounting_shop_daily_matrix_before_tank_payment_split(date,date,uuid[])'),
      to_regprocedure('public.get_accounting_shop_daily_matrix(date,date,uuid[])')),
      'public.effective_delivery_charge_amount(charge.id) as sales_amount',
      '(public.effective_delivery_charge_amount(charge.id) - charge.vat_amount) as sales_amount'),
    (to_regprocedure('public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'),
      '''total_amount'', invoice.total_amount,',
      '''total_amount'', invoice.total_amount, ''sales_amount'', (public.charge_vat_totals(invoice.charge_id)->>''subtotal_amount'')::numeric,')
  ) as patches(function_id, old_text, new_text)
  loop
    v_function := v_patch.function_id;
    if v_function is null then raise exception 'Accounting sales reader missing'; end if;
    v_definition := pg_get_functiondef(v_function);
    v_old := v_patch.old_text;
    v_new := v_patch.new_text;
    if strpos(v_definition, v_new) > 0 then continue; end if;
    if strpos(v_definition, v_old) = 0 then
      raise exception 'Accounting net sales boundary missing in %', v_function;
    end if;
    execute replace(v_definition, v_old, v_new);
  end loop;
end;
$patch$;

notify pgrst, 'reload schema';
