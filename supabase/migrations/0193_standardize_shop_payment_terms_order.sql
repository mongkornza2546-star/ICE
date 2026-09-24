-- Standardize allowed_payment_terms ordering in shop_payment_profiles:
-- 'end_of_day' first (ส่งอย่างเดียว), 'immediate' second (ส่งและรับชำระ), 'credit' third (เครดิต).

update public.shop_payment_profiles
set allowed_payment_terms = (
  select coalesce(array_agg(term order by case term
    when 'end_of_day' then 1
    when 'immediate' then 2
    when 'credit' then 3
    else 4
  end), allowed_payment_terms)
  from unnest(allowed_payment_terms) as term
)
where cardinality(allowed_payment_terms) > 1;

notify pgrst, 'reload schema';
