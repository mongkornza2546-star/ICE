-- Allow active round leads to issue billing statements. Voiding remains admin-only.
create or replace function public.create_billing_statement(
  p_shop_id uuid,
  p_charge_ids uuid[],
  p_issued_service_date date default ((clock_timestamp() at time zone 'Asia/Bangkok')::date)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_statement public.billing_statements%rowtype;
  v_requested_count integer;
  v_valid_count integer;
begin
  if not public.is_active_user() or coalesce(public.current_app_role()::text, '') not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can create a billing statement';
  elsif p_shop_id is null or p_issued_service_date is null
    or coalesce(cardinality(p_charge_ids), 0) = 0 then
    raise exception 'Shop, issue date, and at least one bill are required';
  elsif p_issued_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'Billing statements must be issued for today';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));
  select count(distinct requested.charge_id) into v_requested_count from unnest(p_charge_ids) requested(charge_id);
  perform 1 from public.delivery_charges charge
  where charge.id = any(p_charge_ids) order by charge.id for update;

  select count(*) into v_valid_count
  from public.delivery_charges charge
  join lateral (
    select greatest(public.effective_delivery_charge_amount(charge.id)
      - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
      as outstanding_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id
  ) balance on true
  where charge.id = any(p_charge_ids)
    and charge.shop_id = p_shop_id
    and charge.payment_term = 'credit'
    and charge.status = 'active'
    and balance.outstanding_amount > 0
    and not exists (
      select 1 from public.billing_statement_items item
      where item.charge_id = charge.id and item.active
    );
  if v_valid_count <> v_requested_count then
    raise exception 'One or more selected bills are invalid, paid, or already on an active billing statement';
  end if;

  insert into public.billing_statements(
    statement_number, shop_id, issued_service_date, created_by
  ) values (
    public.next_billing_statement_number(p_issued_service_date),
    p_shop_id, p_issued_service_date, auth.uid()
  ) returning * into v_statement;

  insert into public.billing_statement_items(billing_statement_id, charge_id, billed_amount)
  select v_statement.id, charge.id, balance.outstanding_amount
  from public.delivery_charges charge
  join lateral (
    select greatest(public.effective_delivery_charge_amount(charge.id)
      - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
      as outstanding_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id
  ) balance on true
  where charge.id = any(p_charge_ids);

  return (public.get_billing_statements(p_shop_id)->0);
end;
$$;

