-- VAT is exclusive, per credit ice-delivery charge; existing documents stay unchanged.
alter table public.shop_payment_profiles add column vat_enabled boolean not null default false;
alter table public.shop_payment_profiles add constraint shop_vat_requires_credit
  check (not vat_enabled or 'credit' = any(allowed_payment_terms));
create function public.reset_noncredit_vat()
returns trigger language plpgsql set search_path = public as $$
begin
  if not ('credit' = any(new.allowed_payment_terms)) then new.vat_enabled := false; end if;
  return new;
end;
$$;
create trigger shop_payment_profiles_reset_vat before insert or update on public.shop_payment_profiles
for each row execute function public.reset_noncredit_vat();
revoke all on function public.reset_noncredit_vat() from public, anon, authenticated;

alter table public.delivery_charges
  add column subtotal_amount numeric(12,2),
  add column vat_rate numeric(5,2) not null default 0,
  add column vat_amount numeric(12,2) not null default 0;
update public.delivery_charges set subtotal_amount = original_amount;
-- Flush deferred ledger checks before subsequent ALTER TABLE statements.
set constraints all immediate;
alter table public.delivery_charges alter column subtotal_amount set not null;
alter table public.delivery_charges add constraint charge_vat_totals
  check (subtotal_amount >= 0 and vat_rate in (0, 7) and vat_amount = round(subtotal_amount * vat_rate / 100, 2)
    and original_amount = subtotal_amount + vat_amount);

create function public.credit_vat_total(p_subtotal numeric, p_rate numeric)
returns numeric language sql immutable set search_path = public as $$
  select round(p_subtotal, 2) + round(round(p_subtotal, 2) * p_rate / 100, 2);
$$;

-- Closed-period adjustments have been disabled since 0194. Existing adjustment
-- deltas belong to pre-VAT charges and remain entirely in the pre-tax subtotal.
create function public.charge_vat_totals(p_charge_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'subtotal_amount', charge.subtotal_amount + coalesce(sum(a.amount_delta), 0),
    'vat_rate', charge.vat_rate,
    'vat_amount', charge.vat_amount,
    'total_amount', charge.original_amount + coalesce(sum(a.amount_delta), 0)
  ) from public.delivery_charges charge
  left join public.delivery_charge_adjustments a on a.charge_id = charge.id and a.status = 'active'
  where charge.id = p_charge_id group by charge.id;
$$;
revoke all on function public.charge_vat_totals(uuid) from public, anon, authenticated;

create function public.snapshot_credit_charge_vat()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_parent uuid;
  v_enabled boolean;
begin
  if tg_op = 'UPDATE' then
    if row(new.subtotal_amount, new.vat_rate, new.vat_amount, new.original_amount)
      is distinct from row(old.subtotal_amount, old.vat_rate, old.vat_amount, old.original_amount) then
      raise exception 'Charge VAT snapshots are immutable; use a delivery correction';
    end if;
    return new;
  end if;
  new.vat_rate := 0;
  new.vat_amount := 0;
  new.subtotal_amount := new.original_amount;
  if new.payment_term = 'credit' and new.delivery_event_id is not null
    and new.event_settlement_context_id is null and new.tank_rental_id is null then
    select corrects_event_id into v_parent from public.delivery_events where id = new.delivery_event_id;
    if v_parent is not null then
      select vat_rate into new.vat_rate from public.delivery_charges where delivery_event_id = v_parent;
      if new.vat_rate is null then raise exception 'Original VAT snapshot is required'; end if;
    else
      select vat_enabled into v_enabled from public.shop_payment_profiles where shop_id = new.shop_id for share;
      new.vat_rate := case when v_enabled then 7 else 0 end;
    end if;
    select coalesce(sum(line_total), 0) into new.subtotal_amount
      from public.delivery_items where delivery_event_id = new.delivery_event_id;
    new.vat_amount := round(new.subtotal_amount * new.vat_rate / 100, 2);
    new.original_amount := new.subtotal_amount + new.vat_amount;
  end if;
  return new;
end;
$$;
create trigger delivery_charges_vat_snapshot before insert or update on public.delivery_charges
for each row execute function public.snapshot_credit_charge_vat();

-- Full bill amounts are frozen at statement issue; billed_amount stays the amount due.
alter table public.billing_statement_items
  add column subtotal_amount numeric(12,2),
  add column vat_amount numeric(12,2) not null default 0,
  add column gross_amount numeric(12,2);
-- Leave old statement snapshots absent: their historical full/paid split was not stored.
-- New inserts always populate it, while reprinting old statements keeps the old layout.
alter table public.billing_statement_items add constraint statement_vat_totals
  check (gross_amount = subtotal_amount + vat_amount and gross_amount >= billed_amount);
create function public.snapshot_billing_statement_vat()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_totals jsonb;
begin
  if tg_op = 'UPDATE' then
    if row(new.subtotal_amount, new.vat_amount, new.gross_amount, new.billed_amount)
      is distinct from row(old.subtotal_amount, old.vat_amount, old.gross_amount, old.billed_amount) then
      raise exception 'Billing statement amount snapshots are immutable';
    end if;
    return new;
  end if;
  v_totals := public.charge_vat_totals(new.charge_id);
  new.subtotal_amount := (v_totals->>'subtotal_amount')::numeric;
  new.vat_amount := (v_totals->>'vat_amount')::numeric;
  new.gross_amount := (v_totals->>'total_amount')::numeric;
  return new;
end;
$$;
create trigger billing_statement_items_vat_snapshot before insert or update on public.billing_statement_items
for each row execute function public.snapshot_billing_statement_vat();

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)'::regprocedure);
begin
  if position($old$if v_resolved_payment_term = 'credit' then$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)';
  end if;
  execute replace(v_definition, $old$if v_resolved_payment_term = 'credit' then$old$, $new$if v_resolved_payment_term = 'credit' then
      v_total_amount := public.credit_vat_total(v_total_amount, case when v_profile.vat_enabled then 7 else 0 end);$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.get_delivery_pos_context(uuid)'::regprocedure);
begin
  if position($old$'allow_outstanding', v_profile.allow_outstanding,$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.get_delivery_pos_context(uuid)';
  end if;
  execute replace(v_definition, $old$'allow_outstanding', v_profile.allow_outstanding,$old$, $new$'vat_enabled', v_profile.vat_enabled,
      'allow_outstanding', v_profile.allow_outstanding,$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.get_credit_receivables(date)'::regprocedure);
begin
  if position($old$'credit_limit', profile.credit_limit,$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.get_credit_receivables(date)';
  end if;
  execute replace(v_definition, $old$'credit_limit', profile.credit_limit,$old$, $new$'vat_enabled', profile.vat_enabled,
      'credit_limit', profile.credit_limit,$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.build_charge_print_document(uuid)'::regprocedure);
begin
  if position($old$'total_amount', charge.original_amount$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.build_charge_print_document(uuid)';
  end if;
  execute replace(v_definition, $old$'total_amount', charge.original_amount$old$, $new$'subtotal_amount', charge.subtotal_amount, 'vat_rate', charge.vat_rate,
    'vat_amount', charge.vat_amount, 'total_amount', charge.original_amount$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.delivery_financial_response(uuid)'::regprocedure);
begin
  if position($old$'total_amount', charge.original_amount$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.delivery_financial_response(uuid)';
  end if;
  execute replace(v_definition, $old$'total_amount', charge.original_amount$old$, $new$'subtotal_amount', charge.subtotal_amount, 'vat_rate', charge.vat_rate,
    'vat_amount', charge.vat_amount, 'total_amount', charge.original_amount$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.get_credit_receivable_detail(uuid,date)'::regprocedure);
begin
  if position($old$'original_amount', public.effective_delivery_charge_amount(charge.id),$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.get_credit_receivable_detail(uuid,date)';
  end if;
  execute replace(v_definition, $old$'original_amount', public.effective_delivery_charge_amount(charge.id),$old$, $new$'subtotal_amount', public.charge_vat_totals(charge.id)->'subtotal_amount',
        'vat_rate', charge.vat_rate, 'vat_amount', public.charge_vat_totals(charge.id)->'vat_amount',
        'original_amount', public.effective_delivery_charge_amount(charge.id),$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.get_collection_run_queue(uuid)'::regprocedure);
begin
  if position($old$'original_amount', public.effective_delivery_charge_amount(charge.id),$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.get_collection_run_queue(uuid)';
  end if;
  execute replace(v_definition, $old$'original_amount', public.effective_delivery_charge_amount(charge.id),$old$, $new$'subtotal_amount', public.charge_vat_totals(charge.id)->'subtotal_amount',
        'vat_rate', charge.vat_rate, 'vat_amount', public.charge_vat_totals(charge.id)->'vat_amount',
        'original_amount', public.effective_delivery_charge_amount(charge.id),$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.get_delivery_correction_context(uuid)'::regprocedure);
begin
  if position($old$'charge_id', v_charge.id,$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.get_delivery_correction_context(uuid)';
  end if;
  execute replace(v_definition, $old$'charge_id', v_charge.id,$old$, $new$'subtotal_amount', public.charge_vat_totals(v_charge.id)->'subtotal_amount',
    'vat_rate', v_charge.vat_rate, 'vat_amount', public.charge_vat_totals(v_charge.id)->'vat_amount',
    'charge_id', v_charge.id,$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.get_billing_statements(uuid)'::regprocedure);
begin
  if position($old$'total_amount', totals.total_amount,$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.get_billing_statements(uuid)';
  end if;
  execute replace(v_definition, $old$'total_amount', totals.total_amount,$old$, $new$'subtotal_amount', totals.subtotal_amount, 'vat_amount', totals.vat_amount,
      'gross_amount', totals.gross_amount,
      'total_amount', totals.total_amount,$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.get_billing_statements(uuid)'::regprocedure);
begin
  if position($old$sum(item.billed_amount)::numeric(12,2) as total_amount,$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.get_billing_statements(uuid)';
  end if;
  execute replace(v_definition, $old$sum(item.billed_amount)::numeric(12,2) as total_amount,$old$, $new$sum(item.subtotal_amount)::numeric(12,2) as subtotal_amount,
        sum(item.vat_amount)::numeric(12,2) as vat_amount,
        sum(item.gross_amount)::numeric(12,2) as gross_amount,
        sum(item.billed_amount)::numeric(12,2) as total_amount,$new$);
end;
$vat_patch$;

-- Preserve the authorization, idempotency and settlement logic of the current writer/projection.
do $vat_patch$
declare v_definition text := pg_get_functiondef('public.get_billing_statements(uuid)'::regprocedure);
begin
  if position($old$'billed_amount', item.billed_amount,$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected definition of public.get_billing_statements(uuid)';
  end if;
  execute replace(v_definition, $old$'billed_amount', item.billed_amount,$old$, $new$'subtotal_amount', item.subtotal_amount, 'vat_amount', item.vat_amount,
          'gross_amount', item.gross_amount, 'billed_amount', item.billed_amount,$new$);
end;
$vat_patch$;

-- The caller's displayed VAT/total is checked in the same transaction as the sale.
-- A replay keeps the original result even when the shop setting changes afterwards.
create function public.record_delivery_with_vat_check(
  p_round_stop_id uuid, p_items jsonb, p_stop_status public.shop_round_status,
  p_note text, p_client_recorded_at timestamptz, p_idempotency_key uuid,
  p_payment_term public.payment_term, p_approval_id uuid,
  p_expected_vat_rate numeric, p_expected_total numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
  v_context jsonb;
  v_replay boolean;
  v_rate numeric;
  v_subtotal numeric(12,2);
  v_price numeric;
  v_item record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select exists (select 1 from public.delivery_events where idempotency_key = p_idempotency_key) into v_replay;
  if not v_replay and p_stop_status = 'delivered' then
    -- Check the displayed amount before the writer can reject a newly taxed
    -- charge for exceeding the credit limit. The writer remains authoritative.
    v_context := public.get_delivery_pos_context(p_round_stop_id);
    v_rate := case when coalesce(p_payment_term, (v_context->'payment_profile'->>'default_payment_term')::public.payment_term) = 'credit'
      and (v_context->'payment_profile'->>'vat_enabled')::boolean then 7 else 0 end;
    v_subtotal := 0;
    for v_item in select item.ice_type_id, item.quantity
      from jsonb_to_recordset(p_items) as item(ice_type_id uuid, quantity numeric)
    loop
      select (product->>'unit_price')::numeric into v_price
      from jsonb_array_elements(v_context->'items') product
      where product->>'ice_type_id' = v_item.ice_type_id::text;
      if v_price is null then v_subtotal := null; exit; end if;
      v_subtotal := v_subtotal + round(v_item.quantity * v_price, 2);
    end loop;
    if v_subtotal is not null and (
      p_expected_vat_rate is distinct from v_rate
      or p_expected_total is distinct from public.credit_vat_total(v_subtotal, v_rate)
    ) then
      raise exception 'ราคา หรือ VAT ของร้านเปลี่ยนแล้ว กรุณาตรวจสอบยอดใหม่ก่อนบันทึก'
        using detail = 'VAT_OR_PRICE_CHANGED';
    end if;
  end if;
  v_result := public.record_delivery(p_round_stop_id, p_items, p_stop_status, p_note,
    p_client_recorded_at, p_idempotency_key, p_payment_term, p_approval_id);
  if not v_replay and p_stop_status = 'delivered' and (
    p_expected_vat_rate is distinct from (v_result->>'vat_rate')::numeric
    or p_expected_total is distinct from (v_result->>'total_amount')::numeric
  ) then
    raise exception 'ราคา หรือ VAT ของร้านเปลี่ยนแล้ว กรุณาตรวจสอบยอดใหม่ก่อนบันทึก'
      using detail = 'VAT_OR_PRICE_CHANGED';
  end if;
  return v_result;
end;
$$;
revoke all on function public.record_delivery_with_vat_check(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid,numeric,numeric) from public, anon;
grant execute on function public.record_delivery_with_vat_check(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid,numeric,numeric) to authenticated;
revoke all on function public.snapshot_credit_charge_vat(), public.snapshot_billing_statement_vat() from public, anon, authenticated;
-- Daily credit details and newly issued daily summaries use the same bill snapshots.

do $vat_daily$
declare v_definition text := pg_get_functiondef('public.get_daily_credit_acknowledgement_details(uuid,date)'::regprocedure);
begin
  if position($old$'total_amount', source.total_amount$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected daily-credit projection';
  end if;
  execute replace(v_definition, $old$'total_amount', source.total_amount$old$, $new$'subtotal_amount', public.charge_vat_totals(source.charge_id)->'subtotal_amount',
      'vat_rate', public.charge_vat_totals(source.charge_id)->'vat_rate',
      'vat_amount', public.charge_vat_totals(source.charge_id)->'vat_amount',
      'total_amount', source.total_amount$new$);
end;
$vat_daily$;

do $vat_daily$
declare v_definition text := pg_get_functiondef('public.build_daily_credit_acknowledgement_document(uuid,uuid,date,integer,timestamptz)'::regprocedure);
begin
  if position($old$'total_amount', source.total_amount$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected daily-credit projection';
  end if;
  execute replace(v_definition, $old$'total_amount', source.total_amount$old$, $new$'subtotal_amount', public.charge_vat_totals(source.charge_id)->'subtotal_amount',
      'vat_rate', public.charge_vat_totals(source.charge_id)->'vat_rate',
      'vat_amount', public.charge_vat_totals(source.charge_id)->'vat_amount',
      'total_amount', source.total_amount$new$);
end;
$vat_daily$;

do $vat_daily$
declare v_definition text := pg_get_functiondef('public.build_daily_credit_acknowledgement_document(uuid,uuid,date,integer,timestamptz)'::regprocedure);
begin
  if position($old$'total_amount', coalesce(sum(source.total_amount), 0)$old$ in v_definition) = 0 then
    raise exception 'VAT migration: unexpected daily-credit projection';
  end if;
  execute replace(v_definition, $old$'total_amount', coalesce(sum(source.total_amount), 0)$old$, $new$'subtotal_amount', coalesce(sum((public.charge_vat_totals(source.charge_id)->>'subtotal_amount')::numeric), 0),
    'vat_amount', coalesce(sum((public.charge_vat_totals(source.charge_id)->>'vat_amount')::numeric), 0),
    'total_amount', coalesce(sum(source.total_amount), 0)$new$);
end;
$vat_daily$;

set constraints all deferred;
notify pgrst, 'reload schema';
