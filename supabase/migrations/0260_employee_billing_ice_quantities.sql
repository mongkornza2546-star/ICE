-- Include delivered ice quantities for employee summary statement printing.
create or replace function public.get_employee_billing_accounts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_active_user()
    or coalesce(public.current_app_role()::text, '') not in ('admin', 'round_lead', 'courier') then
    raise exception 'Only active employees or managers can view billing accounts';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', shop.id, 'shop_code', shop.code, 'shop_name', shop.name,
      'charges', coalesce(bills.charges, '[]'::jsonb),
      'statements', history.statements
    ) order by shop.code)
    from public.shops shop
    join lateral (
      select jsonb_agg(jsonb_build_object(
        'charge_id', charge.id, 'charge_number', charge.charge_number,
        'service_date', charge.service_date, 'due_date', charge.due_date,
        'original_amount', public.effective_delivery_charge_amount(charge.id),
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ice_type_id', item.ice_type_id, 'name', ice.name,
            'unit', ice.unit, 'quantity', item.quantity
          ) order by ice.code)
          from public.delivery_items item
          join public.ice_types ice on ice.id = item.ice_type_id
          where item.delivery_event_id = charge.delivery_event_id
        ), '[]'::jsonb),
        'allocated_amount', balance.paid,
        'outstanding_amount', balance.outstanding,
        'assigned_collection_run_id', null,
        'days_overdue', greatest((now() at time zone 'Asia/Bangkok')::date - charge.due_date, 0),
        'payment_status', case when balance.outstanding = 0 then 'paid' when balance.paid > 0 then 'partial' else 'unpaid' end,
        'due_status', case when balance.outstanding = 0 then 'paid'
          when charge.due_date < (now() at time zone 'Asia/Bangkok')::date then 'overdue'
          when charge.due_date = (now() at time zone 'Asia/Bangkok')::date then 'due_today' else 'not_due' end
      ) order by charge.service_date, charge.id) as charges,
        bool_or(balance.outstanding > 0) as has_outstanding
      from public.delivery_charges charge
      cross join lateral (
        select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2) as paid,
          greatest(public.effective_delivery_charge_amount(charge.id)
            - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2) as outstanding
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance
      where charge.shop_id = shop.id and charge.payment_term = 'credit' and charge.status = 'active'
        and public.can_issue_billing_statement_charge(charge.id)
    ) bills on true
    cross join lateral (
      select public.get_billing_statements(shop.id) as statements
    ) history
    where bills.has_outstanding or jsonb_array_length(history.statements) > 0
  ), '[]'::jsonb);
end;
$$;
