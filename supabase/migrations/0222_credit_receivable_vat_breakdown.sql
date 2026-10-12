-- Split the current balance using each bill's stored VAT, never the shop's
-- current setting. Partial payments reduce net and VAT proportionally; round
-- the remaining net per bill before summing. Pre-VAT adjustments remain net.
do $patch$
declare
  v_definition text := pg_get_functiondef('public.get_credit_receivables(date)'::regprocedure);
  v_balance text := 'sum(charge.outstanding_amount)::numeric(12,2) as outstanding_amount,';
  v_projection text := '''outstanding_amount'', account.outstanding_amount,';
begin
  if position(v_balance in v_definition) = 0 or position(v_projection in v_definition) = 0 then
    raise exception 'Unexpected definition of public.get_credit_receivables(date)';
  end if;
  v_definition := replace(v_definition, v_balance, v_balance || $sql$
        sum(case when charge.outstanding_amount <= 0 then 0
          when charge.vat_amount = 0 then charge.outstanding_amount
          else round(charge.outstanding_amount *
            (public.effective_delivery_charge_amount(charge.id) - charge.vat_amount)
            / nullif(public.effective_delivery_charge_amount(charge.id), 0), 2)
          end)::numeric(12,2) as outstanding_subtotal_amount,$sql$);
  v_definition := replace(v_definition, v_projection, v_projection || $sql$
      'outstanding_subtotal_amount', account.outstanding_subtotal_amount,$sql$);
  execute v_definition;
end;
$patch$;
