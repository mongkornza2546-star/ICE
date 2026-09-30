begin;

set local request.jwt.claim.sub = '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
set local request.jwt.claim.role = 'authenticated';

create temporary table requested_invoices (
  shop_code text not null,
  invoice_number text not null primary key
) on commit drop;

insert into requested_invoices (shop_code, invoice_number) values
  ('BB37', 'INV2609-00007'),
  ('BB37', 'INV2609-00026'),
  ('BB37', 'INV2609-00040'),
  ('BB37', 'INV2609-00122'),
  ('BB37', 'INV2609-00132'),
  ('BB37', 'INV2609-00224'),
  ('BB37', 'INV2609-00255'),
  ('BB37', 'INV2609-00351'),
  ('BB37', 'INV2609-00376'),
  ('BB37', 'INV2609-00453'),
  ('BB37', 'INV2609-00479'),
  ('BB37', 'INV2609-00502'),
  ('BB54', 'INV2609-00074'),
  ('BB54', 'INV2609-00144'),
  ('BB54', 'INV2609-00238'),
  ('BB54', 'INV2609-00380'),
  ('BB54', 'INV2609-00459');

do $validate$
declare
  v_target_count integer;
  v_shop_count integer;
begin
  select count(*), count(distinct charge.shop_id)
  into v_target_count, v_shop_count
  from requested_invoices requested
  join public.delivery_charges charge on charge.charge_number = requested.invoice_number
  join public.shops shop on shop.id = charge.shop_id and shop.code = requested.shop_code;

  if v_target_count <> 17 then
    raise exception 'Expected exactly 17 target invoices, found %', v_target_count;
  elsif v_shop_count <> 2 then
    raise exception 'Expected exactly two target shops, found %', v_shop_count;
  elsif exists (
    select 1
    from requested_invoices requested
    join public.delivery_charges charge on charge.charge_number = requested.invoice_number
    join public.shops shop on shop.id = charge.shop_id and shop.code = requested.shop_code
    left join public.shop_payment_profiles profile on profile.shop_id = charge.shop_id
    left join lateral (
      select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0) as allocated_amount
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = charge.id
    ) allocations on true
    where charge.status <> 'active'
       or charge.payment_term <> 'credit'
       or charge.due_date <> date '2026-09-25'
       or public.resolve_credit_due_date(charge.shop_id, charge.service_date) <> date '2026-09-30'
       or coalesce(allocations.allocated_amount, 0) <> 0
       or profile.allowed_payment_terms <> array['credit']::public.payment_term[]
       or profile.default_payment_term <> 'credit'
       or profile.credit_due_rule <> 'end_of_month'
  ) then
    raise exception 'Target invoices or shop profiles no longer match the verified preflight state';
  elsif exists (
    select 1
    from public.credit_due_date_requests request
    join public.delivery_charges charge on charge.id = request.charge_id
    join requested_invoices requested on requested.invoice_number = charge.charge_number
    where request.status = 'pending'
  ) then
    raise exception 'A target invoice already has a pending due-date request';
  end if;
end;
$validate$;

do $apply$
declare
  v_charge record;
  v_request jsonb;
begin
  for v_charge in
    select charge.id, charge.shop_id, charge.service_date
    from requested_invoices requested
    join public.delivery_charges charge on charge.charge_number = requested.invoice_number
    join public.shops shop on shop.id = charge.shop_id and shop.code = requested.shop_code
    order by charge.shop_id, charge.charge_number
  loop
    v_request := public.request_credit_due_date_change(
      v_charge.id,
      public.resolve_credit_due_date(v_charge.shop_id, v_charge.service_date),
      'แก้วันครบกำหนดเดิมให้ตรงกับเงื่อนไขเครดิตรอบสิ้นเดือนของร้าน'
    );

    perform public.decide_credit_due_date_request(
      (v_request ->> 'id')::uuid,
      'approved',
      'อนุมัติการแก้ไขข้อมูลย้อนหลังจาก 25 ก.ย. เป็นวันสิ้นเดือน'
    );
  end loop;
end;
$apply$;

commit;

select
  shop.code as shop_code,
  shop.name as shop_name,
  count(*) as invoice_count,
  sum(charge.original_amount)::numeric(12, 2) as total_amount,
  min(charge.due_date) as earliest_due_date,
  max(charge.due_date) as latest_due_date
from public.delivery_charges charge
join public.shops shop on shop.id = charge.shop_id
where charge.charge_number in (
  'INV2609-00007', 'INV2609-00026', 'INV2609-00040', 'INV2609-00122',
  'INV2609-00132', 'INV2609-00224', 'INV2609-00255', 'INV2609-00351',
  'INV2609-00376', 'INV2609-00453', 'INV2609-00479', 'INV2609-00502',
  'INV2609-00074', 'INV2609-00144', 'INV2609-00238', 'INV2609-00380',
  'INV2609-00459'
)
group by shop.code, shop.name
order by shop.code;
