-- Delivery staff choose whether to collect payment for each delivery.
-- The default remains an internal value required by the existing schema.
-- Credit customers keep their separate billing terms.
update public.shop_payment_profiles
set allowed_payment_terms = array['end_of_day', 'immediate']::public.payment_term[],
    default_payment_term = 'end_of_day'::public.payment_term
where not ('credit' = any(allowed_payment_terms))
  and (allowed_payment_terms <> array['end_of_day', 'immediate']::public.payment_term[]
       or default_payment_term <> 'end_of_day'::public.payment_term);

notify pgrst, 'reload schema';
