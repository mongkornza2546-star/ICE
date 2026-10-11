-- Apply after the frontend uses record_delivery_with_vat_check and before VAT
-- is enabled for any shop. Existing active clients may need to refresh.
revoke execute on function public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)
  from public, anon, authenticated;
revoke execute on function public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
