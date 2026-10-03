-- Keep legacy fingerprints intact. Every writer (including replay branches)
-- validates the requested date before returning success, under its existing lock.
-- Read/void APIs deliberately continue to use financial_payment_response.
create function public.financial_payment_write_response(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stored_date date;
  v_requested_date date := nullif(current_setting('app.payment_received_date', true), '')::date;
begin
  select received_date_override into v_stored_date
  from public.payments where id = p_payment_id;
  if not found or v_stored_date is distinct from v_requested_date then
    raise exception 'Idempotency key was already used for a different received date';
  end if;
  return public.financial_payment_response(p_payment_id);
end;
$$;
revoke all on function public.financial_payment_write_response(uuid) from public, anon, authenticated;

do $payment_write_date_guard$
declare
  v_function regprocedure;
  v_definition text;
begin
  foreach v_function in array array[
    'public.record_payment_before_automatic_context(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure,
    'public.record_payment_before_billing_statements(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure,
    'public.record_collection_payment_for_billing(uuid,uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid)'::regprocedure,
    'public.record_event_payment(uuid,uuid,date,text,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_function);
    if strpos(v_definition, 'public.financial_payment_response(') = 0 then
      raise exception 'Payment response boundary not found in %', v_function;
    end if;
    execute replace(v_definition, 'public.financial_payment_response(', 'public.financial_payment_write_response(');
  end loop;
end;
$payment_write_date_guard$;

-- Extend the existing projections without duplicating their visibility rules,
-- event joins, receipt items, or pagination. Ordinary/legacy rows have no override.
do $payment_date_metadata$
declare
  v_target record;
  v_definition text;
  v_marker text;
begin
  for v_target in select * from (values
    ('public.financial_payment_response(uuid)', 'payment'),
    ('public.build_payment_receipt_snapshot(uuid)', 'payment'),
    ('public.get_payment_history(date,date,integer,timestamp with time zone,uuid)', 'returned'),
    ('public.get_credit_receivable_detail(uuid,date)', 'payment'),
    ('public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)', 'payment')
  ) as targets(signature, row_alias) loop
    v_definition := pg_get_functiondef(v_target.signature::regprocedure);
    v_marker := format('''recorded_at'', %s.recorded_at', v_target.row_alias);
    if strpos(v_definition, v_marker) = 0 then
      raise exception 'Payment timestamp projection not found in %', v_target.signature;
    end if;
    execute replace(v_definition, v_marker, v_marker || format(
      ', ''received_date_override'', %1$s.received_date_override, ''entered_at'', %1$s.entered_at',
      v_target.row_alias
    ));
  end loop;
end;
$payment_date_metadata$;

-- Also expose metadata for receipts captured between 0202 and this migration.
-- Preserve the immutable snapshot and the existing read authorization/void data.
do $stored_receipt_date_metadata$
declare
  v_definition text := pg_get_functiondef('public.get_payment_receipt_snapshot(uuid)'::regprocedure);
begin
  if strpos(v_definition, 'return v_receipt') = 0 then
    raise exception 'Stored receipt return boundary not found';
  end if;
  execute replace(v_definition, 'return v_receipt', $replacement$return v_receipt || (
    select jsonb_build_object('received_date_override', payment.received_date_override,
      'entered_at', payment.entered_at)
    from public.payments payment where payment.id = p_payment_id
  )$replacement$);
end;
$stored_receipt_date_metadata$;

notify pgrst, 'reload schema';
