-- Resolve the current fully paid delivery bill behind an immutable payment receipt.

create function public.get_payment_correction_targets(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view payment correction targets';
  elsif p_payment_id is null or not exists (
    select 1 from public.payments payment where payment.id = p_payment_id
  ) then
    raise exception 'The selected payment does not exist';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'charge_id', charge.id,
      'charge_number', charge.charge_number,
      'delivery_event_id', event.id,
      'payment_allocated_amount', target_allocation.amount,
      'allocated_amount', balance.allocated_amount,
      'effective_amount', public.effective_delivery_charge_amount(charge.id)
    ) order by charge.service_date, charge.created_at, charge.id)
    from public.payment_allocations target_allocation
    join public.payments target_payment on target_payment.id = target_allocation.payment_id
    join public.delivery_charges charge on charge.id = target_allocation.charge_id
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.delivery_rounds round on round.id = stop.round_id
    join lateral (
      select coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = charge.id and payment.status = 'active'
    ) balance on true
    where target_payment.id = p_payment_id
      and target_payment.status = 'active'
      and charge.status = 'active'
      and event.status = 'active'
      and not exists (
        select 1 from public.delivery_events newer
        where newer.round_stop_id = event.round_stop_id and newer.status = 'active'
          and (newer.recorded_at, newer.id) > (event.recorded_at, event.id)
      )
      and public.effective_delivery_charge_amount(charge.id) > 0
      and balance.allocated_amount >= public.effective_delivery_charge_amount(charge.id)
      and not exists (
        with recursive event_lineage(id) as (
          select event.id
          union
          select revision.original_event_id
          from public.delivery_event_revisions revision
          join event_lineage lineage on revision.replacement_event_id = lineage.id
        )
        select 1
        from public.refund_obligations obligation
        join public.delivery_charges source_charge on source_charge.id = obligation.source_charge_id
        join event_lineage lineage on lineage.id = source_charge.delivery_event_id
        where obligation.status = 'pending'
      )
      and (
        public.current_app_role() = 'admin'
        or (
          round.status = 'open'
          and not exists (
            select 1 from public.daily_stock_closures closure
            where closure.service_date = round.service_date and closure.status = 'closed'
          )
          and not exists (
            select 1 from public.daily_aggregate_stock_closures closure
            where closure.service_date = round.service_date and closure.status = 'closed'
          )
        )
      )
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_payment_correction_targets(uuid) from public;
grant execute on function public.get_payment_correction_targets(uuid) to authenticated;

notify pgrst, 'reload schema';
