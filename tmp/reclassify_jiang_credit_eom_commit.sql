-- Reclassify only the explicitly approved historical invoices for ร้านเจียง.
-- The original invoice-document snapshot is deliberately retained; this records
-- the financial reclassification in audit_logs instead of rewriting history.
begin;

create temporary table requested_invoices (
  invoice_number text primary key
) on commit drop;

insert into requested_invoices (invoice_number) values
  ('INV2609-00007'),
  ('INV2609-00026'),
  ('INV2609-00040'),
  ('INV2609-00122'),
  ('INV2609-00132'),
  ('INV2609-00224'),
  ('INV2609-00255'),
  ('INV2609-00351'),
  ('INV2609-00376'),
  ('INV2609-00453'),
  ('INV2609-00479'),
  ('INV2609-00502');

create temporary table target_charges on commit preserve rows as
select
  charge.id,
  charge.charge_number,
  charge.shop_id,
  charge.service_date,
  charge.payment_term as previous_payment_term,
  charge.due_date as previous_due_date,
  charge.original_amount,
  charge.status,
  profile.created_by as audit_actor_id,
  profile.allowed_payment_terms,
  profile.default_payment_term,
  profile.credit_due_rule,
  coalesce(allocations.allocated_amount, 0)::numeric(12, 2) as allocated_amount
from requested_invoices requested
join public.delivery_charges charge on charge.charge_number = requested.invoice_number
join public.shops shop on shop.id = charge.shop_id
join public.shop_payment_profiles profile on profile.shop_id = charge.shop_id
left join lateral (
  select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0) as allocated_amount
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id
  where allocation.charge_id = charge.id
) allocations on true
for update of charge, profile;

do $validate_target$
declare
  v_target_count integer;
  v_shop_count integer;
begin
  select count(*), count(distinct shop_id)
  into v_target_count, v_shop_count
  from target_charges;

  if v_target_count <> 12 then
    raise exception 'Expected exactly 12 invoices, found %', v_target_count;
  elsif v_shop_count <> 1 then
    raise exception 'The selected invoices must belong to exactly one shop';
  elsif exists (select 1 from target_charges where status <> 'active') then
    raise exception 'Every selected invoice must be active';
  elsif exists (select 1 from target_charges where allocated_amount <> 0) then
    raise exception 'A selected invoice has an active payment allocation';
  elsif exists (select 1 from target_charges where previous_payment_term = 'credit') then
    raise exception 'A selected invoice is already credit and must not be reclassified again';
  elsif exists (
    select 1
    from target_charges
    where allowed_payment_terms <> array['credit']::public.payment_term[]
      or default_payment_term <> 'credit'
      or credit_due_rule <> 'end_of_month'
  ) then
    raise exception 'The current shop profile must be credit with an end-of-month cycle';
  elsif exists (select 1 from target_charges where audit_actor_id is null) then
    raise exception 'The shop profile must have a creator for audit logging';
  end if;
end;
$validate_target$;

create temporary table migrated_charges on commit preserve rows as
with updated as (
  update public.delivery_charges charge
  set
    payment_term = 'credit',
    due_date = public.resolve_credit_due_date(charge.shop_id, charge.service_date)
  from target_charges target
  where charge.id = target.id
  returning charge.id, charge.charge_number, charge.payment_term, charge.due_date
)
select * from updated;

insert into public.audit_logs (
  actor_id,
  entity_type,
  entity_id,
  action,
  before_value,
  after_value,
  reason
)
select
  target.audit_actor_id,
  'delivery_charges',
  target.id,
  'historical_payment_term_reclassified',
  jsonb_build_object(
    'charge_number', target.charge_number,
    'payment_term', target.previous_payment_term,
    'due_date', target.previous_due_date,
    'allocated_amount', target.allocated_amount
  ),
  jsonb_build_object(
    'charge_number', migrated.charge_number,
    'payment_term', migrated.payment_term,
    'due_date', migrated.due_date,
    'credit_due_rule', 'end_of_month'
  ),
  'Reclassified historical invoices to the shop''s approved end-of-month credit cycle'
from target_charges target
join migrated_charges migrated on migrated.id = target.id;

commit;

select
  migrated.charge_number as invoice_number,
  migrated.payment_term,
  migrated.due_date,
  target.original_amount,
  target.allocated_amount,
  (target.original_amount - target.allocated_amount)::numeric(12, 2) as outstanding_amount
from migrated_charges migrated
join target_charges target on target.id = migrated.id
order by migrated.charge_number;
