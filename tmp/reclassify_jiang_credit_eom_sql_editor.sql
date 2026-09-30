-- Supabase SQL Editor: reclassify exactly 12 ร้านเจียง invoices to end-of-month credit.
-- This statement is all-or-nothing. It makes no temporary tables.
do $reclassify$
declare
  v_invoice_numbers constant text[] := array[
    'INV2609-00007', 'INV2609-00026', 'INV2609-00040', 'INV2609-00122',
    'INV2609-00132', 'INV2609-00224', 'INV2609-00255', 'INV2609-00351',
    'INV2609-00376', 'INV2609-00453', 'INV2609-00479', 'INV2609-00502'
  ];
  v_target_count integer;
  v_shop_count integer;
  v_shop_id uuid;
begin
  select count(*), count(distinct charge.shop_id), min(charge.shop_id::text)::uuid
  into v_target_count, v_shop_count, v_shop_id
  from public.delivery_charges charge
  where charge.charge_number = any(v_invoice_numbers);

  if v_target_count <> array_length(v_invoice_numbers, 1) then
    raise exception 'Expected exactly 12 invoices, found %', v_target_count;
  elsif v_shop_count <> 1 then
    raise exception 'The selected invoices must belong to exactly one shop';
  end if;

  -- Matches the lock used by payment recording, so payment allocation cannot race this conversion.
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));
  perform 1
  from public.delivery_charges charge
  where charge.charge_number = any(v_invoice_numbers)
  for update;

  if exists (
    select 1
    from public.delivery_charges charge
    where charge.charge_number = any(v_invoice_numbers)
      and charge.status <> 'active'
  ) then
    raise exception 'Every selected invoice must be active';
  elsif exists (
    select 1
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
    join public.delivery_charges charge on charge.id = allocation.charge_id
    where charge.charge_number = any(v_invoice_numbers)
  ) then
    raise exception 'A selected invoice has an active payment allocation';
  elsif not exists (
    select 1
    from public.shop_payment_profiles profile
    where profile.shop_id = v_shop_id
      and profile.allowed_payment_terms = array['credit']::public.payment_term[]
      and profile.default_payment_term = 'credit'
      and profile.credit_due_rule = 'end_of_month'
      and profile.created_by is not null
  ) then
    raise exception 'The current shop profile must be credit with an end-of-month cycle';
  end if;

  with target as (
    select
      charge.id,
      charge.charge_number,
      charge.payment_term as previous_payment_term,
      charge.due_date as previous_due_date,
      public.resolve_credit_due_date(charge.shop_id, charge.service_date) as expected_due_date,
      profile.created_by as audit_actor_id
    from public.delivery_charges charge
    join public.shop_payment_profiles profile on profile.shop_id = charge.shop_id
    where charge.charge_number = any(v_invoice_numbers)
  ), updated as (
    update public.delivery_charges charge
    set (payment_term, due_date) = (
      'credit'::public.payment_term,
      target.expected_due_date
    )
    from target
    where charge.id = target.id
      and (
        charge.payment_term <> 'credit'
        or charge.due_date is distinct from target.expected_due_date
      )
    returning charge.id, charge.charge_number, charge.payment_term, charge.due_date
  )
  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value, reason
  )
  select
    target.audit_actor_id,
    'delivery_charges',
    target.id,
    'historical_payment_term_reclassified',
    jsonb_build_object(
      'charge_number', target.charge_number,
      'payment_term', target.previous_payment_term,
      'due_date', target.previous_due_date
    ),
    jsonb_build_object(
      'charge_number', updated.charge_number,
      'payment_term', updated.payment_term,
      'due_date', updated.due_date,
      'credit_due_rule', 'end_of_month'
    ),
    'Reclassified historical invoices to the shop''s approved end-of-month credit cycle'
  from target
  join updated on updated.id = target.id;
end;
$reclassify$;

-- Success check: this must show 12 rows with payment_term = credit.
select
  charge.charge_number as invoice_number,
  charge.payment_term,
  charge.due_date,
  charge.original_amount,
  coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12, 2) as allocated_amount,
  (charge.original_amount - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0))::numeric(12, 2) as outstanding_amount
from public.delivery_charges charge
left join public.payment_allocations allocation on allocation.charge_id = charge.id
left join public.payments payment on payment.id = allocation.payment_id
where charge.charge_number = any(array[
  'INV2609-00007', 'INV2609-00026', 'INV2609-00040', 'INV2609-00122',
  'INV2609-00132', 'INV2609-00224', 'INV2609-00255', 'INV2609-00351',
  'INV2609-00376', 'INV2609-00453', 'INV2609-00479', 'INV2609-00502'
])
group by charge.id
order by charge.charge_number;
