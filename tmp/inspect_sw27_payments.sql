select jsonb_build_object(
  'profile',(
    select jsonb_build_object(
      'default_payment_term',profile.default_payment_term,
      'default_payment_method',profile.default_payment_method,
      'credit_due_rule',profile.credit_due_rule,
      'credit_collection_weekday',profile.credit_collection_weekday
    )
    from public.shop_payment_profiles profile
    join public.shops shop on shop.id=profile.shop_id
    where shop.code='SW-27'
  ),
  'charges',(
    select jsonb_agg(jsonb_build_object(
      'charge_id',charge.id,'service_date',charge.service_date,'charge_number',charge.charge_number,
      'amount',charge.original_amount,'due_date',charge.due_date,'paid',coalesce(a.paid,0),
      'outstanding',charge.original_amount-coalesce(a.paid,0)
    ) order by charge.service_date)
    from public.delivery_charges charge
    join public.shops shop on shop.id=charge.shop_id
    left join lateral (
      select sum(allocation.amount) paid from public.payment_allocations allocation
      join public.payments payment on payment.id=allocation.payment_id and payment.status='active'
      where allocation.charge_id=charge.id
    ) a on true
    where shop.code='SW-27' and charge.service_date between '2026-09-01' and '2026-09-18'
  ),
  'payments',(
    select jsonb_agg(jsonb_build_object(
      'payment_id',payment.id,'recorded_at',payment.recorded_at,'receipt',payment.receipt_number,
      'method',payment.payment_method,'amount',payment.allocated_amount,'reference',payment.reference_number,
      'allocations',(select jsonb_agg(jsonb_build_object('charge_id',charge.id,'date',charge.service_date,'amount',allocation.amount) order by charge.service_date) from public.payment_allocations allocation join public.delivery_charges charge on charge.id=allocation.charge_id where allocation.payment_id=payment.id)
    ) order by payment.recorded_at,payment.id)
    from public.payments payment
    join public.shops shop on shop.id=payment.shop_id
    where shop.code='SW-27' and payment.status='active'
      and payment.recorded_at between '2026-09-01 00:00+07' and '2026-09-19 00:00+07'
  )
) as sw27;
