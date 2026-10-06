-- Payment terms govern new sales. Historical credit charges and receipts remain
-- readable after a shop switches to immediate or end-of-day payment terms.
-- Patch only the eligibility guard to preserve the effective-charge projection
-- and the payment date metadata added by 0204.
do $former_credit_history$
declare
  v_definition text := pg_get_functiondef('public.get_credit_receivable_detail(uuid,date)'::regprocedure);
  v_old text := $guard$  elsif p_shop_id is null or not exists (
    select 1 from public.shop_payment_profiles profile
    where profile.shop_id = p_shop_id and 'credit' = any(profile.allowed_payment_terms)
  ) then raise exception 'The selected shop does not have a credit account'; end if;$guard$;
  v_new text := $guard$  elsif p_shop_id is null or not (
    exists (
      select 1 from public.shop_payment_profiles profile
      where profile.shop_id = p_shop_id and 'credit' = any(profile.allowed_payment_terms)
    ) or exists (
      select 1 from public.delivery_charges charge
      where charge.shop_id = p_shop_id and charge.payment_term = 'credit'
    )
  ) then raise exception 'The selected shop does not have a credit account'; end if;$guard$;
  v_guard text;
  v_pattern text;
begin
  -- Recognize the patched guard first so SQL Editor retries are a no-op.
  -- Match either known guard across indentation, tabs, and line-ending changes.
  -- Escape the regex metacharacters present in these two literal SQL guards.
  foreach v_guard in array array[v_new, v_old] loop
    v_pattern := replace(replace(replace(btrim(v_guard), '.', '\.'), '(', '\('), ')', '\)');
    v_pattern := regexp_replace(v_pattern, '[[:space:]]+', '[[:space:]]+', 'g');
    if v_definition ~ v_pattern then
      if v_guard = v_old then
        execute regexp_replace(v_definition, v_pattern, btrim(v_new));
      end if;
      return;
    end if;
  end loop;
  raise exception 'Credit receivable eligibility guard not found'
    using hint = 'Inspect pg_get_functiondef(''public.get_credit_receivable_detail(uuid,date)''::regprocedure); the function matches neither the original nor the patched guard.';
end;
$former_credit_history$;

notify pgrst, 'reload schema';
