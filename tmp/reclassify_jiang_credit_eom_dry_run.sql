-- Read-only preflight for the 12 historical invoices that belong to ร้านเจียง.
-- This query does not change any data.
with requested_invoices(invoice_number) as (
  values
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
    ('INV2609-00502')
), target as (
  select
    requested.invoice_number,
    charge.id as charge_id,
    shop.code as shop_code,
    shop.name as shop_name,
    charge.service_date,
    charge.status,
    charge.payment_term as current_payment_term,
    charge.due_date as current_due_date,
    charge.original_amount,
    coalesce(allocations.allocated_amount, 0)::numeric(12, 2) as allocated_amount,
    (charge.original_amount - coalesce(allocations.allocated_amount, 0))::numeric(12, 2) as outstanding_amount,
    profile.allowed_payment_terms,
    profile.default_payment_term,
    profile.credit_due_rule,
    public.resolve_credit_due_date(charge.shop_id, charge.service_date) as proposed_due_date
  from requested_invoices requested
  left join public.delivery_charges charge on charge.charge_number = requested.invoice_number
  left join public.shops shop on shop.id = charge.shop_id
  left join public.shop_payment_profiles profile on profile.shop_id = charge.shop_id
  left join lateral (
    select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0) as allocated_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id
  ) allocations on charge.id is not null
)
select
  invoice_number,
  shop_code,
  shop_name,
  service_date,
  status,
  current_payment_term,
  current_due_date,
  original_amount,
  allocated_amount,
  outstanding_amount,
  allowed_payment_terms,
  default_payment_term,
  credit_due_rule,
  proposed_due_date,
  case
    when charge_id is null then 'ERROR: ไม่พบบิล'
    when status <> 'active' then 'ERROR: บิลไม่ active'
    when allocated_amount <> 0 then 'ERROR: มีการรับชำระแล้ว'
    when current_payment_term = 'credit' then 'SKIP: เป็นเครดิตอยู่แล้ว'
    when allowed_payment_terms <> array['credit']::public.payment_term[]
      or default_payment_term <> 'credit'
      or credit_due_rule <> 'end_of_month' then 'ERROR: โปรไฟล์ร้านไม่ใช่เครดิตสิ้นเดือน'
    when proposed_due_date is null then 'ERROR: คำนวณวันครบกำหนดไม่ได้'
    else 'READY'
  end as migration_status
from target
order by invoice_number;
