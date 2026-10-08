-- Split accounting shop summary received cash into cash and transfer/QR.
-- Retain cash_received_in_period as the total so all existing consumers,
-- filters, tests, and summaries remain fully backwards compatible.
do $received_split$
declare
  v_func regprocedure;
  v_definition text;
  v_updated text;
  v_old_select text := $old$  ), received_in_period as (
    select coalesce(sum(payment.allocated_amount), 0)::numeric as amount
    from public.payments payment$old$;
  v_new_select text := $new$  ), received_in_period as (
    select coalesce(sum(payment.allocated_amount), 0)::numeric as amount,
      coalesce(sum(payment.allocated_amount) filter (where payment.payment_method = 'cash'), 0)::numeric as cash_amount,
      coalesce(sum(payment.allocated_amount) filter (where payment.payment_method in ('bank_transfer', 'qr')), 0)::numeric as transfer_amount
    from public.payments payment$new$;
  v_old_totals text := $old$      'cash_received_in_period', (select amount from received_in_period)$old$;
  v_new_totals text := $new$      'cash_received_in_period', (select amount from received_in_period),
      'cash_in_period', (select cash_amount from received_in_period),
      'transfer_in_period', (select transfer_amount from received_in_period)$new$;
begin
  if to_regprocedure('public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer)') is not null then
    v_func := 'public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer)'::regprocedure;
  elsif to_regprocedure('public.get_accounting_shop_summary(date,date,jsonb,integer,integer)') is not null then
    v_func := 'public.get_accounting_shop_summary(date,date,jsonb,integer,integer)'::regprocedure;
  else
    raise exception 'Accounting shop summary function not found';
  end if;

  select pg_get_functiondef(v_func) into v_definition;
  if strpos(v_definition, '''cash_in_period''') > 0 then
    return;
  end if;

  v_updated := replace(v_definition, v_old_select, v_new_select);
  if v_updated = v_definition then
    raise exception 'Cannot apply accounting received payment method split: received_in_period select not found';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition, v_old_totals, v_new_totals);
  if v_updated = v_definition then
    raise exception 'Cannot apply accounting received payment method split: totals cash_received_in_period not found';
  end if;

  execute v_updated;
end;
$received_split$;

notify pgrst, 'reload schema';
