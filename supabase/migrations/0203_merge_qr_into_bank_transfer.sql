update public.shop_payment_profiles profile
set
  allowed_payment_methods = array(
    select grouped.method
    from (
      select
        case when item.method = 'qr' then 'bank_transfer'::public.payment_method else item.method end as method,
        min(item.ordinality) as first_position
      from unnest(profile.allowed_payment_methods) with ordinality as item(method, ordinality)
      group by 1
    ) grouped
    order by grouped.first_position
  ),
  default_payment_method = case
    when profile.default_payment_method = 'qr' then 'bank_transfer'::public.payment_method
    else profile.default_payment_method
  end
where 'qr'::public.payment_method = any(profile.allowed_payment_methods)
   or profile.default_payment_method = 'qr'::public.payment_method;

alter table public.shop_payment_profiles
  add constraint shop_payment_profiles_no_qr_method
  check (
    not ('qr'::public.payment_method = any(allowed_payment_methods))
    and default_payment_method <> 'qr'::public.payment_method
  );
