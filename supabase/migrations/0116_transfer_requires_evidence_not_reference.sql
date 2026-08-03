-- A bank transfer must be supported by its payment slip, not a typed reference.
-- Keep the legacy reference columns so historical payment records remain compatible.

alter table public.shop_payment_profiles
  alter column bank_transfer_reference_required set default false,
  alter column bank_transfer_evidence_required set default true;

update public.shop_payment_profiles
set
  bank_transfer_reference_required = false,
  bank_transfer_evidence_required = true
where bank_transfer_reference_required
   or not bank_transfer_evidence_required;

do $transfer_requires_evidence$
declare
  v_function regprocedure :=
    'public.record_payment(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure;
  v_definition text;
  v_reference_check constant text := $fragment$  elsif (
    (p_payment_method = 'cash' and v_profile.cash_reference_required)
    or (p_payment_method = 'bank_transfer' and v_profile.bank_transfer_reference_required)
    or (p_payment_method = 'qr' and v_profile.qr_reference_required)
  ) and nullif(trim(coalesce(p_reference_number, '')), '') is null then
    raise exception 'A payment reference is required for this method';
$fragment$;
  v_evidence_check constant text := $fragment$    (p_payment_method = 'cash' and v_profile.cash_evidence_required)
    or (p_payment_method = 'bank_transfer' and v_profile.bank_transfer_evidence_required)
    or (p_payment_method = 'qr' and v_profile.qr_evidence_required)$fragment$;
  v_required_evidence_check constant text := $fragment$    p_payment_method = 'bank_transfer'
    or (p_payment_method = 'cash' and v_profile.cash_evidence_required)
    or (p_payment_method = 'qr' and v_profile.qr_evidence_required)$fragment$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  v_definition := replace(v_definition, v_reference_check, '');
  v_definition := replace(v_definition, v_evidence_check, v_required_evidence_check);

  if strpos(v_definition, 'A payment reference is required for this method') > 0
    or strpos(v_definition, v_required_evidence_check) = 0 then
    raise exception 'record_payment does not contain the expected payment validation rules';
  end if;

  execute v_definition;
end;
$transfer_requires_evidence$;
