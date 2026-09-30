-- Allow collection users to choose any eligible credit bill in the current
-- shop/run scope. All authorization, scope, balance, stale-data, and
-- idempotency checks in the established writer remain unchanged.
-- 0159 renamed the writer; 0171's record_regular_payment_after_event_context
-- is the authorization wrapper that delegates to it.
do $allow_selected_credit_bills$
declare
  v_function regprocedure :=
    'public.record_payment_before_automatic_context(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure;
  v_definition text;
  v_fifo_guard constant text := $fragment$  if p_collection_run_id is not null and exists (
    select 1
    from jsonb_to_recordset(p_allocations) requested(charge_id uuid, amount numeric)
    join public.delivery_charges target on target.id = requested.charge_id
    where target.payment_term = 'credit' and exists (
      select 1 from public.delivery_charges older
      left join lateral (
        select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2) as paid
        from public.payment_allocations allocation join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = older.id
      ) older_balance on true
      left join lateral (
        select allocation.amount::numeric(12,2) as proposed
        from jsonb_to_recordset(p_allocations) allocation(charge_id uuid, amount numeric)
        where allocation.charge_id = older.id
      ) proposed on true
      where older.shop_id = p_shop_id and older.payment_term = 'credit'
        and public.is_charge_collectible_in_run(older.id, p_collection_run_id)
        and (older.due_date, older.created_at, older.id) < (target.due_date, target.created_at, target.id)
        and public.effective_delivery_charge_amount(older.id)
          - older_balance.paid - coalesce(proposed.proposed, 0) > 0
    )
  ) then raise exception 'Credit payments must be allocated to the oldest due balance first'; end if;

$fragment$;
begin
  select pg_get_functiondef(v_function) into v_definition;

  if strpos(v_definition, v_fifo_guard) = 0 then
    raise exception 'The regular payment credit-order guard was not recognized';
  elsif strpos(v_definition, 'p_expected_outstanding_amount') = 0
    or strpos(v_definition, 'public.is_charge_collectible_in_run') = 0
    or strpos(v_definition, 'p_idempotency_key') = 0 then
    raise exception 'The regular payment safety contract was not recognized';
  end if;

  v_definition := replace(v_definition, v_fifo_guard, '');
  if strpos(v_definition, 'Credit payments must be allocated to the oldest due balance first') > 0 then
    raise exception 'The regular payment credit-order guard was not fully removed';
  end if;

  execute v_definition;
end;
$allow_selected_credit_bills$;
