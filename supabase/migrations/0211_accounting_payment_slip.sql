-- Include the stored evidence path with each payment in the accounting invoice detail.
-- Preserve the existing authorization, invoice scope, and later payment date metadata.
do $accounting_payment_slip$
declare
  v_definition text := pg_get_functiondef(
    'public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'::regprocedure
  );
  v_marker text := '''recorded_at'', payment.recorded_at';
begin
  if strpos(v_definition, v_marker) = 0 then
    raise exception 'Accounting payment projection boundary not found';
  end if;
  execute replace(v_definition, v_marker,
    v_marker || ', ''evidence_path'', payment.evidence_path');
end;
$accounting_payment_slip$;
