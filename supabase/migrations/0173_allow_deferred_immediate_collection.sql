-- Courier POS now records the delivery before opening the collection screen.
-- Keep record_immediate_sale available for callers that still require one atomic
-- delivery/payment transaction, but permit an immediate charge to remain unpaid
-- when collection is cancelled or completed separately.

drop trigger if exists delivery_charges_require_immediate_receipt
  on public.delivery_charges;
drop function if exists public.require_immediate_sale_receipt();

-- Selecting the deferred immediate workflow is still a collection action for
-- couriers, even though the delivery and receipt now commit separately.
create function public.authorize_deferred_immediate_charge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_term = 'immediate'
    and public.current_app_role() = 'courier'
    and not public.can_collect_shop_payments() then
    raise exception 'The current user cannot start an immediate collection';
  end if;
  return new;
end;
$$;

create trigger delivery_charges_authorize_deferred_immediate
before insert on public.delivery_charges
for each row execute function public.authorize_deferred_immediate_charge();

-- An unpaid immediate sale is a real receivable until its later receipt. Keep
-- atomic immediate sales net-zero by recording both sides instead of omitting
-- both sides from the ledger.
do $account_for_deferred_immediate_receivables$
declare
  v_function regprocedure := coalesce(
    to_regprocedure('public.accounting_transaction_rows_without_casual(date,date)'),
    to_regprocedure('public.accounting_transaction_rows_without_event_context(date,date)'),
    to_regprocedure('public.accounting_transaction_rows(date,date)')
  );
  v_definition text;
  v_sale_old text := $old$case when charge.payment_term = 'immediate' then 0::numeric else item.line_total end$old$;
  v_sale_new text := $new$item.line_total$new$;
  v_receipt_old text := $old$where allocation.payment_id = payment.id and charge.payment_term <> 'immediate'$old$;
  v_receipt_new text := $new$where allocation.payment_id = payment.id$new$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  if position(v_sale_old in v_definition) = 0
    or position(v_receipt_old in v_definition) = 0 then
    raise exception 'accounting_transaction_rows does not contain the expected immediate receivable markers';
  end if;
  v_definition := replace(v_definition, v_sale_old, v_sale_new);
  v_definition := replace(v_definition, v_receipt_old, v_receipt_new);
  execute v_definition;
end;
$account_for_deferred_immediate_receivables$;

-- Closed-period immediate sales traditionally required a voided receipt before
-- cancellation. A deferred charge may never have had a receipt, so absence of
-- an active allocation is now the authoritative cancellation condition.
do $allow_unpaid_immediate_delivery_cancel$
declare
  v_function regprocedure := 'public.get_delivery_correction_context(uuid)'::regprocedure;
  v_definition text;
  v_old text := $old$    and exists (
      select 1
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = v_charge.id and payment.status = 'voided'
    )
    and not exists (
      select 1
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = v_charge.id and payment.status = 'active'
    )$old$;
  v_new text := $new$    and not exists (
      select 1
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = v_charge.id and payment.status = 'active'
    )$new$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'get_delivery_correction_context does not contain the expected immediate cancellation marker';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$allow_unpaid_immediate_delivery_cancel$;

revoke all on function public.authorize_deferred_immediate_charge()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
