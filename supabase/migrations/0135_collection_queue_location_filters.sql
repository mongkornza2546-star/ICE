-- Include shop location in the collection queue so collectors can filter it by building and zone.

create or replace function public.get_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then raise exception 'An active user is required'; end if;
  if not exists (
    select 1 from public.collection_runs run
    where run.id = p_collection_run_id and run.status = 'open'
      and (public.current_app_role() in ('admin', 'round_lead') or public.is_collection_run_member(run.id))
  ) then raise exception 'The collection run does not exist, is closed, or is not assigned to this user'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', queue.shop_id, 'shop_code', queue.shop_code, 'shop_name', queue.shop_name,
      'building_id', queue.building_id, 'building_name', queue.building_name,
      'zone_id', queue.zone_id, 'zone_name', queue.zone_name,
      'image_path', queue.image_path, 'outstanding_amount', queue.outstanding_amount,
      'charge_count', queue.charge_count, 'latest_charge_at', queue.latest_charge_at,
      'latest_payment_at', queue.latest_payment_at,
      'has_new_charges', queue.latest_payment_at is not null and queue.latest_charge_at > queue.latest_payment_at,
      'payment_profile', queue.payment_profile, 'charges', queue.charges
    ) order by queue.shop_code)
    from (
      select shop.id as shop_id, shop.code as shop_code, shop.name as shop_name, shop.image_path,
        shop.building_id, building.name as building_name, shop.zone_id, zone.name as zone_name,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        count(*)::integer as charge_count, max(charge.created_at) as latest_charge_at,
        jsonb_build_object(
          'allowed_payment_methods', profile.allowed_payment_methods,
          'default_payment_method', profile.default_payment_method,
          'cash_reference_required', profile.cash_reference_required,
          'cash_evidence_required', profile.cash_evidence_required,
          'bank_transfer_reference_required', profile.bank_transfer_reference_required,
          'bank_transfer_evidence_required', profile.bank_transfer_evidence_required,
          'qr_reference_required', profile.qr_reference_required,
          'qr_evidence_required', profile.qr_evidence_required
        ) as payment_profile,
        (select max(payment.recorded_at) from public.payments payment
          where payment.shop_id = shop.id and payment.collection_run_id = p_collection_run_id
            and payment.status = 'active') as latest_payment_at,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id, 'charge_number', charge.charge_number,
          'delivery_event_id', charge.delivery_event_id, 'service_date', charge.service_date,
          'payment_term', charge.payment_term, 'due_date', charge.due_date,
          'original_amount', public.effective_delivery_charge_amount(charge.id),
          'base_amount', charge.original_amount,
          'outstanding_amount', balance.outstanding_amount, 'created_at', charge.created_at,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'ice_type_id', ice.id, 'name', ice.name, 'unit', ice.unit,
              'quantity', item.quantity, 'line_total', item.line_total
            ) order by ice.code)
            from public.delivery_items item join public.ice_types ice on ice.id = item.ice_type_id
            where item.delivery_event_id = charge.delivery_event_id
          ), '[]'::jsonb)
        ) order by coalesce(charge.due_date, charge.service_date), charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      join public.shops shop on shop.id = charge.shop_id
      left join public.buildings building on building.id = shop.building_id
      left join public.building_zones zone on zone.id = shop.zone_id
      join public.shop_payment_profiles profile on profile.shop_id = shop.id
      join lateral (
        select greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
          as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where public.is_charge_collectible_in_run(charge.id, p_collection_run_id)
        and balance.outstanding_amount > 0
      group by shop.id, building.id, zone.id, profile.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

notify pgrst, 'reload schema';
