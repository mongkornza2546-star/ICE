begin;

set local request.jwt.claim.sub = '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
set local request.jwt.claim.role = 'authenticated';

with target_charges as (
  select charge.id, charge.due_date
  from public.delivery_charges charge
  join public.shops shop on shop.id = charge.shop_id
  where shop.code in ('BB37', 'BB54')
    and charge.status = 'active'
    and charge.payment_term = 'credit'
), queue_rows as (
  select jsonb_array_elements(public.get_collection_run_queue(run.id)) as item
  from public.collection_runs run
  where run.status = 'open'
    and run.service_date = date '2026-09-29'
)
select
  (select count(*) from target_charges) as target_charge_count,
  (select count(*) from target_charges where due_date <> date '2026-09-30') as wrong_due_date_count,
  (
    select count(*)
    from public.credit_due_date_requests request
    join target_charges target on target.id = request.charge_id
    where request.original_due_date = date '2026-09-25'
      and request.requested_due_date = date '2026-09-30'
      and request.status = 'approved'
  ) as approved_request_count,
  (
    select count(*)
    from queue_rows
    where item ->> 'shop_code' in ('BB37', 'BB54')
  ) as target_queue_count;

commit;
