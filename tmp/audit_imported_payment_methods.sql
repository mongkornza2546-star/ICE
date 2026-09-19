with imported as (
  select distinct payment.id,payment.shop_id,payment.payment_method,payment.recorded_at,payment.allocated_amount
  from public.payments payment
  join public.audit_logs audit on audit.entity_type='payments' and audit.entity_id=payment.id
  where audit.action in ('imported','import_price_reconciliation')
    and audit.after_value->>'source'='สรุปยอดขาย ศูนย์ราชการ ปี 69-2.xls'
    and payment.status='active'
), compared as (
  select imported.*,shop.code,profile.default_payment_method,
    case when shop.code='SW-27' then 'bank_transfer'::public.payment_method else profile.default_payment_method end desired_method
  from imported
  join public.shops shop on shop.id=imported.shop_id
  join public.shop_payment_profiles profile on profile.shop_id=shop.id
)
select jsonb_build_object(
  'imported_payment_count',(select count(*) from compared),
  'mismatch_count',(select count(*) from compared where payment_method<>desired_method),
  'mismatch_amount',(select coalesce(sum(allocated_amount),0) from compared where payment_method<>desired_method),
  'by_shop',coalesce((select jsonb_agg(to_jsonb(summary) order by code) from (
    select code,payment_method::text current_method,desired_method::text desired_method,count(*) payment_count,sum(allocated_amount) amount
    from compared where payment_method<>desired_method
    group by code,payment_method,desired_method
  ) summary),'[]'::jsonb)
) result;
