-- Update only explicitly selected groups. Evidence rules and original creators
-- remain attached to each shop, including when two admins edit concurrently.
create function public.bulk_update_shop_payment_profiles(
  p_shop_ids uuid[],
  p_terms jsonb default null,
  p_methods jsonb default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
  v_before public.shop_payment_profiles%rowtype;
  v_after public.shop_payment_profiles%rowtype;
  v_count integer := 0;
  v_patch jsonb;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'เฉพาะแอดมินที่เปิดใช้งานเท่านั้นที่ตั้งค่าร้านแบบกลุ่มได้';
  end if;
  if coalesce(cardinality(p_shop_ids), 0) = 0 or array_position(p_shop_ids, null) is not null then
    raise exception 'กรุณาเลือกร้านค้าอย่างน้อย 1 ร้าน';
  end if;
  if p_terms is null and p_methods is null then
    raise exception 'กรุณาเลือกกลุ่มข้อมูลที่ต้องการเปลี่ยน';
  end if;
  if (p_terms is not null and jsonb_typeof(p_terms) <> 'object')
    or (p_methods is not null and jsonb_typeof(p_methods) <> 'object') then
    raise exception 'รูปแบบข้อมูลตั้งค่าไม่ถูกต้อง';
  end if;
  if p_terms is not null and (
    not (p_terms ?& array['allowed_payment_terms', 'default_payment_term', 'allow_outstanding',
      'credit_due_rule', 'credit_days', 'credit_collection_weekday', 'credit_limit'])
    or exists (select 1 from jsonb_object_keys(p_terms) k where k <> all(array[
      'allowed_payment_terms', 'default_payment_term', 'allow_outstanding',
      'credit_due_rule', 'credit_days', 'credit_collection_weekday', 'credit_limit']))
  ) then
    raise exception 'ส่งเฉพาะรูปแบบชำระเงินและเครดิตให้ครบทุกช่อง';
  end if;
  if p_methods is not null and (
    not (p_methods ?& array['allowed_payment_methods', 'default_payment_method'])
    or exists (select 1 from jsonb_object_keys(p_methods) k
      where k <> all(array['allowed_payment_methods', 'default_payment_method']))
  ) then
    raise exception 'ส่งเฉพาะช่องทางการเงินและช่องทางเริ่มต้น';
  end if;
  v_patch := coalesce(p_terms, '{}'::jsonb) || coalesce(p_methods, '{}'::jsonb);

  for v_shop_id in select distinct unnest(p_shop_ids) order by 1 loop
    -- Lock in stable order and recheck eligibility before any profile changes.
    perform 1 from public.shops where id = v_shop_id and status = 'active' for update;
    if not found then
      raise exception 'พบร้านที่ไม่มีอยู่หรือไม่ได้เปิดใช้งาน กรุณาโหลดรายชื่อใหม่';
    end if;
    select * into v_before from public.shop_payment_profiles where shop_id = v_shop_id for update;
    if not found then
      if p_terms is null or p_methods is null then
        raise exception 'ร้านที่ยังไม่เคยตั้งค่าต้องเลือกทั้งรูปแบบชำระเงินและช่องทางการเงิน';
      end if;
      v_after := jsonb_populate_record(null::public.shop_payment_profiles, v_patch);
      insert into public.shop_payment_profiles (
        shop_id, allowed_payment_terms, default_payment_term,
        allowed_payment_methods, default_payment_method, allow_outstanding,
        credit_due_rule, credit_days, credit_collection_weekday, credit_limit, created_by
      ) values (
        v_shop_id, v_after.allowed_payment_terms, v_after.default_payment_term,
        v_after.allowed_payment_methods, v_after.default_payment_method, v_after.allow_outstanding,
        v_after.credit_due_rule, v_after.credit_days, v_after.credit_collection_weekday, v_after.credit_limit, auth.uid()
      ) on conflict (shop_id) do nothing;
      select * into v_before from public.shop_payment_profiles where shop_id = v_shop_id for update;
    end if;

    v_after := jsonb_populate_record(v_before, v_patch);
    update public.shop_payment_profiles set
      allowed_payment_terms = v_after.allowed_payment_terms,
      default_payment_term = v_after.default_payment_term,
      allowed_payment_methods = v_after.allowed_payment_methods,
      default_payment_method = v_after.default_payment_method,
      allow_outstanding = v_after.allow_outstanding,
      credit_due_rule = v_after.credit_due_rule,
      credit_days = v_after.credit_days,
      credit_collection_weekday = v_after.credit_collection_weekday,
      credit_limit = v_after.credit_limit
    where shop_id = v_shop_id;
    -- The existing shop_payment_profiles_audit_update trigger records the change.
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.bulk_update_shop_payment_profiles(uuid[], jsonb, jsonb) from public;
grant execute on function public.bulk_update_shop_payment_profiles(uuid[], jsonb, jsonb) to authenticated;
