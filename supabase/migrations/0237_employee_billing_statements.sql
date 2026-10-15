-- Issuing a statement does not record a payment or grant credit administration.
create function public.can_issue_billing_statement_charge(p_charge_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_user()
    and coalesce(public.current_app_role()::text, '') in ('admin', 'round_lead', 'courier')
    and (public.current_app_role() in ('admin', 'round_lead')
      or public.can_collect_shop_payments()
      or public.is_financial_charge_visible(p_charge_id));
$$;

-- Preserve the existing balance, VAT snapshot, date and concurrency checks.
do $$
declare
  definition text;
  updated text;
begin
  definition := pg_get_functiondef('public.create_billing_statement(uuid,uuid[],date)'::regprocedure);
  updated := replace(definition,
    $old$coalesce(public.current_app_role()::text, '') not in ('admin', 'round_lead')$old$,
    $new$coalesce(public.current_app_role()::text, '') not in ('admin', 'round_lead', 'courier')$new$);
  if updated = definition then raise exception 'Unexpected create_billing_statement role guard'; end if;
  updated := replace(updated, 'Only a round lead or admin can create a billing statement', 'Only active employees or managers can create a billing statement');
  definition := updated;
  updated := replace(definition, $old$and charge.shop_id = p_shop_id$old$,
    $new$and charge.shop_id = p_shop_id
    and public.can_issue_billing_statement_charge(charge.id)$new$);
  if updated = definition then raise exception 'Unexpected create_billing_statement charge guard'; end if;
  execute updated;

  definition := pg_get_functiondef('public.get_billing_statements(uuid)'::regprocedure);
  updated := replace(definition, $old$public.current_app_role() not in ('admin', 'round_lead')$old$,
    $new$coalesce(public.current_app_role()::text, '') not in ('admin', 'round_lead', 'courier')$new$);
  if updated = definition then raise exception 'Unexpected get_billing_statements role guard'; end if;
  definition := updated;
  updated := replace(definition, $old$where statement.shop_id = p_shop_id$old$,
    $new$where statement.shop_id = p_shop_id
      and not exists (
        select 1 from public.billing_statement_items visible_item
        where visible_item.billing_statement_id = statement.id
          and not public.can_issue_billing_statement_charge(visible_item.charge_id)
      )$new$);
  if updated = definition then raise exception 'Unexpected get_billing_statements shop filter'; end if;
  execute updated;
end;
$$;

-- A narrow employee read model: available credit bills and printable statements.
-- It deliberately does not expose credit settings or payment administration.
create function public.get_employee_billing_accounts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_active_user()
    or coalesce(public.current_app_role()::text, '') not in ('admin', 'round_lead', 'courier') then
    raise exception 'Only active employees or managers can view billing accounts';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', shop.id, 'shop_code', shop.code, 'shop_name', shop.name,
      'charges', bills.charges,
      'statements', public.get_billing_statements(shop.id)
    ) order by shop.code)
    from public.shops shop
    join lateral (
      select jsonb_agg(jsonb_build_object(
        'charge_id', charge.id, 'charge_number', charge.charge_number,
        'service_date', charge.service_date, 'due_date', charge.due_date,
        'original_amount', public.effective_delivery_charge_amount(charge.id),
        'allocated_amount', balance.paid,
        'outstanding_amount', balance.outstanding,
        'assigned_collection_run_id', null,
        'days_overdue', greatest((now() at time zone 'Asia/Bangkok')::date - charge.due_date, 0),
        'payment_status', case when balance.outstanding = 0 then 'paid' when balance.paid > 0 then 'partial' else 'unpaid' end,
        'due_status', case when balance.outstanding = 0 then 'paid'
          when charge.due_date < (now() at time zone 'Asia/Bangkok')::date then 'overdue'
          when charge.due_date = (now() at time zone 'Asia/Bangkok')::date then 'due_today' else 'not_due' end
      ) order by charge.service_date, charge.id) as charges
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
    ) bills on bills.charges is not null
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.can_issue_billing_statement_charge(uuid) from public, anon;
revoke all on function public.get_employee_billing_accounts() from public, anon;
grant execute on function public.can_issue_billing_statement_charge(uuid) to authenticated;
grant execute on function public.get_employee_billing_accounts() to authenticated;
