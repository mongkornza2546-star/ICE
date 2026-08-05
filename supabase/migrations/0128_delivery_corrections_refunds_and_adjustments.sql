-- Complete the delivery correction workflow without rewriting issued receipts.
-- Current allocations may move, while payment receipt snapshots remain immutable.

create table public.payment_allocation_changes (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('open_revision', 'closed_adjustment')),
  source_id uuid not null,
  payment_id uuid not null references public.payments(id) on delete restrict,
  from_charge_id uuid references public.delivery_charges(id) on delete restrict,
  to_charge_id uuid references public.delivery_charges(id) on delete restrict,
  before_amount numeric(12,2) not null check (before_amount >= 0),
  after_amount numeric(12,2) not null check (after_amount >= 0),
  reason text not null check (nullif(trim(reason), '') is not null),
  changed_by uuid not null references public.users(id) on delete restrict,
  changed_at timestamptz not null default now(),
  check (from_charge_id is not null or to_charge_id is not null)
);

create index payment_allocation_changes_payment_idx
  on public.payment_allocation_changes (payment_id, changed_at);
create index payment_allocation_changes_source_idx
  on public.payment_allocation_changes (source_kind, source_id);

create table public.refund_obligations (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('open_revision', 'closed_adjustment')),
  source_id uuid not null,
  payment_id uuid not null references public.payments(id) on delete restrict,
  source_charge_id uuid not null references public.delivery_charges(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'settled', 'voided')),
  reason text not null check (nullif(trim(reason), '') is not null),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  voided_by uuid references public.users(id) on delete restrict,
  voided_at timestamptz,
  void_reason text,
  unique (source_kind, source_id, payment_id),
  check (
    (status in ('pending', 'settled') and voided_by is null and voided_at is null and void_reason is null)
    or (status = 'voided' and voided_by is not null and voided_at is not null
      and nullif(trim(coalesce(void_reason, '')), '') is not null)
  )
);

create table public.refund_settlements (
  idempotency_key uuid primary key,
  obligation_id uuid not null unique references public.refund_obligations(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  refund_method public.payment_method not null,
  reference_number text,
  settled_by uuid not null references public.users(id) on delete restrict,
  settled_at timestamptz not null default now()
);

create table public.delivery_charge_adjustments (
  idempotency_key uuid primary key,
  request_fingerprint text not null,
  charge_id uuid not null references public.delivery_charges(id) on delete restrict,
  scope text not null check (scope in ('round_closed', 'day_closed')),
  amount_delta numeric(12,2) not null,
  corrected_total numeric(12,2) not null check (corrected_total >= 0),
  reason text not null check (nullif(trim(reason), '') is not null),
  status public.financial_record_status not null default 'active',
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  voided_by uuid references public.users(id) on delete restrict,
  voided_at timestamptz,
  void_reason text,
  check (
    (status = 'active' and voided_by is null and voided_at is null and void_reason is null)
    or (status = 'voided' and voided_by is not null and voided_at is not null
      and nullif(trim(coalesce(void_reason, '')), '') is not null)
  )
);

create table public.delivery_adjustment_items (
  adjustment_id uuid not null references public.delivery_charge_adjustments(idempotency_key) on delete restrict,
  ice_type_id uuid not null references public.ice_types(id) on delete restrict,
  original_quantity numeric(12,1) not null check (original_quantity >= 0),
  corrected_quantity numeric(12,1) not null check (corrected_quantity >= 0),
  quantity_delta numeric(12,1) generated always as
    ((corrected_quantity - original_quantity)::numeric(12,1)) stored,
  unit_price numeric(12,2) not null check (unit_price > 0),
  primary key (adjustment_id, ice_type_id)
);

alter table public.payment_allocation_changes enable row level security;
alter table public.refund_obligations enable row level security;
alter table public.refund_settlements enable row level security;
alter table public.delivery_charge_adjustments enable row level security;
alter table public.delivery_adjustment_items enable row level security;

create policy "managers read payment allocation changes"
on public.payment_allocation_changes for select
using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "managers read refund obligations"
on public.refund_obligations for select
using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "managers read refund settlements"
on public.refund_settlements for select
using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "managers read delivery charge adjustments"
on public.delivery_charge_adjustments for select
using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "managers read delivery adjustment items"
on public.delivery_adjustment_items for select
using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));

create function public.protect_append_only_financial_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Financial correction history is append-only';
end;
$$;

create function public.apply_open_delivery_correction(
  p_event_id uuid,
  p_action text,
  p_items jsonb,
  p_stop_status public.shop_round_status,
  p_note text,
  p_reason text,
  p_idempotency_key uuid,
  p_approval_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.delivery_event_revisions%rowtype;
  v_event public.delivery_events%rowtype;
  v_stop public.round_stops%rowtype;
  v_round public.delivery_rounds%rowtype;
  v_charge public.delivery_charges%rowtype;
  v_preview jsonb;
  v_new_event_id uuid;
  v_new_charge_id uuid;
  v_new_amount numeric(12,2);
  v_remaining numeric(12,2);
  v_allocations jsonb;
  v_allocation record;
  v_keep numeric(12,2);
  v_refund numeric(12,2);
  v_item record;
  v_unit_price numeric(12,2);
  v_price_source public.price_source;
  v_price_source_id uuid;
  v_revision_fingerprint text;
  v_canonical_items jsonb;
  v_delivery_fingerprint text;
  v_allocated numeric(12,2);
  v_credit_exposure numeric(12,2);
  v_profile public.shop_payment_profiles%rowtype;
  v_approval public.financial_approval_requests%rowtype;
  v_previous_status public.shop_round_status;
  v_previous_note text;
begin
  if p_idempotency_key is null then raise exception 'An idempotency key is required';
  elsif nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'A correction reason is required';
  elsif jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Correction items must be an array';
  elsif p_action = 'cancel' and p_approval_id is not null then
    raise exception 'A cancellation cannot use a financial approval';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'ice_type_id', item.ice_type_id, 'quantity', item.quantity
  ) order by item.ice_type_id), '[]'::jsonb)
  into v_canonical_items
  from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric);
  v_revision_fingerprint := md5(jsonb_build_object(
    'event_id', p_event_id, 'action', p_action, 'items', v_canonical_items,
    'stop_status', p_stop_status, 'note', nullif(trim(coalesce(p_note, '')), ''),
    'reason', trim(p_reason), 'approval_id', p_approval_id
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select revision.* into v_existing
  from public.delivery_event_revisions revision
  where revision.idempotency_key = p_idempotency_key;
  if v_existing.idempotency_key is not null then
    if v_existing.original_event_id <> p_event_id or v_existing.action <> p_action then
      raise exception 'This idempotency key belongs to another delivery correction';
    elsif v_existing.request_fingerprint is not null
      and v_existing.request_fingerprint is distinct from v_revision_fingerprint then
      raise exception 'This idempotency key was already used for a different delivery correction request';
    end if;
    return jsonb_build_object(
      'original_event_id', v_existing.original_event_id,
      'replacement_event_id', v_existing.replacement_event_id,
      'action', v_existing.action,
      'idempotent_replay', true
    );
  end if;

  select event.* into v_event
  from public.delivery_events event where event.id = p_event_id for update;
  if v_event.id is null then raise exception 'The selected delivery event does not exist'; end if;
  select stop.* into v_stop from public.round_stops stop where stop.id = v_event.round_stop_id for update;
  select round.* into v_round from public.delivery_rounds round where round.id = v_stop.round_id for update;
  select charge.* into v_charge
  from public.delivery_charges charge where charge.delivery_event_id = v_event.id for update;
  if v_charge.id is null then raise exception 'The selected delivery does not have a financial charge'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_round.service_date::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_stop.shop_id::text, 0));
  v_preview := public.preview_delivery_correction(p_event_id, p_action, p_items, p_stop_status);
  v_new_amount := (v_preview->>'new_amount')::numeric(12,2);
  v_allocated := coalesce((v_preview->>'allocated_amount')::numeric(12,2), 0);
  v_delivery_fingerprint := public.delivery_request_fingerprint(
    v_event.round_stop_id, p_items, p_stop_status, null, v_charge.payment_term
  );

  if p_action = 'correct' and p_stop_status = 'delivered' and v_charge.payment_term = 'credit' then
    select profile.* into v_profile
    from public.shop_payment_profiles profile where profile.shop_id = v_charge.shop_id for update;
    if v_profile.id is null or not ('credit' = any(v_profile.allowed_payment_terms)) then
      raise exception 'The selected shop does not have an active credit payment profile';
    end if;

    select coalesce(sum(greatest(
      public.effective_delivery_charge_amount(charge.id) - coalesce(allocation.amount, 0), 0
    )), 0)::numeric(12,2)
    into v_credit_exposure
    from public.delivery_charges charge
    left join lateral (
      select coalesce(sum(payment_allocation.amount), 0)::numeric(12,2) as amount
      from public.payment_allocations payment_allocation
      join public.payments payment on payment.id = payment_allocation.payment_id
      where payment_allocation.charge_id = charge.id and payment.status = 'active'
    ) allocation on true
    where charge.shop_id = v_charge.shop_id and charge.payment_term = 'credit'
      and charge.status = 'active' and charge.id <> v_charge.id;

    if v_profile.credit_limit is not null
      and v_credit_exposure + greatest(v_new_amount - v_allocated, 0) > v_profile.credit_limit then
      if p_approval_id is null then
        raise exception 'An approved credit-limit request is required for this correction';
      end if;
      select approval.* into v_approval
      from public.financial_approval_requests approval where approval.id = p_approval_id for update;
      if v_approval.status is distinct from 'approved'
        or v_approval.shop_id is distinct from v_charge.shop_id
        or v_approval.round_stop_id is distinct from v_event.round_stop_id
        or v_approval.kind is distinct from 'credit_limit'
        or v_approval.requested_amount is distinct from v_new_amount
        or v_approval.request_fingerprint is distinct from v_delivery_fingerprint then
        raise exception 'The financial approval does not match this correction request';
      elsif v_round.service_date is distinct from (now() at time zone 'Asia/Bangkok')::date then
        raise exception 'Financial approval has expired';
      end if;
    elsif p_approval_id is not null then
      raise exception 'This correction does not require a financial approval';
    end if;
  elsif p_approval_id is not null then
    raise exception 'Only a credit-limit correction can use this approval';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'payment_id', payment.id,
    'amount', allocation.amount,
    'recorded_at', payment.recorded_at
  ) order by payment.recorded_at, payment.id), '[]'::jsonb)
  into v_allocations
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
  where allocation.charge_id = v_charge.id;

  delete from public.payment_allocations allocation
  using public.payments payment
  where allocation.payment_id = payment.id and payment.status = 'active'
    and allocation.charge_id = v_charge.id;

  update public.delivery_events
  set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
      cancellation_reason = trim(p_reason)
  where id = v_event.id;

  if p_action = 'correct' then
    for v_item in
      select * from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
      order by item.ice_type_id
    loop
      if public.daily_aggregate_stock_balance_at(v_round.service_date, v_item.ice_type_id)
        < v_item.quantity then
        raise exception 'Daily aggregate stock is not sufficient for the corrected delivery';
      end if;
    end loop;

    insert into public.delivery_events (
      round_stop_id, recorded_by, idempotency_key, request_fingerprint, note,
      source_stock_location_id, corrects_event_id
    ) values (
      v_event.round_stop_id, auth.uid(), p_idempotency_key, v_revision_fingerprint,
      nullif(trim(coalesce(p_note, '')), ''), v_event.source_stock_location_id, v_event.id
    ) returning id into v_new_event_id;

    for v_item in
      select * from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
      order by item.ice_type_id
    loop
      select original_item.unit_price, original_item.price_source, original_item.price_source_id
      into v_unit_price, v_price_source, v_price_source_id
      from public.delivery_items original_item
      where original_item.delivery_event_id = v_event.id
        and original_item.ice_type_id = v_item.ice_type_id;
      if v_unit_price is null then
        select resolved.unit_price, resolved.price_source, resolved.price_source_id
        into v_unit_price, v_price_source, v_price_source_id
        from public.resolve_delivery_price(v_stop.shop_id, v_item.ice_type_id, v_round.service_date) resolved;
      end if;
      insert into public.delivery_items (
        delivery_event_id, ice_type_id, quantity, unit_price, price_source, price_source_id
      ) values (
        v_new_event_id, v_item.ice_type_id, v_item.quantity,
        v_unit_price, v_price_source, v_price_source_id
      );
    end loop;

    if p_stop_status = 'delivered' then
      insert into public.delivery_charges (
        delivery_event_id, shop_id, service_date, payment_term,
        original_amount, due_date, approval_request_id
      ) values (
        v_new_event_id, v_charge.shop_id, v_charge.service_date, v_charge.payment_term,
        v_new_amount, v_charge.due_date, p_approval_id
      ) returning id into v_new_charge_id;
      if p_approval_id is not null then
        update public.financial_approval_requests
        set status = 'consumed', consumed_by_delivery_event_id = v_new_event_id,
            consumed_at = now()
        where id = p_approval_id and status = 'approved';
      end if;
    end if;
  end if;

  v_remaining := case when v_new_charge_id is null then 0 else v_new_amount end;
  for v_allocation in
    select * from jsonb_to_recordset(v_allocations)
      allocation(payment_id uuid, amount numeric, recorded_at timestamptz)
    order by allocation.recorded_at, allocation.payment_id
  loop
    v_keep := least(v_allocation.amount, v_remaining);
    v_refund := v_allocation.amount - v_keep;
    if v_keep > 0 then
      insert into public.payment_allocations (payment_id, charge_id, amount)
      values (v_allocation.payment_id, v_new_charge_id, v_keep);
      v_remaining := v_remaining - v_keep;
    end if;
    insert into public.payment_allocation_changes (
      source_kind, source_id, payment_id, from_charge_id, to_charge_id,
      before_amount, after_amount, reason, changed_by
    ) values (
      'open_revision', p_idempotency_key, v_allocation.payment_id,
      v_charge.id, v_new_charge_id, v_allocation.amount, v_keep,
      trim(p_reason), auth.uid()
    );
    if v_refund > 0 then
      insert into public.refund_obligations (
        source_kind, source_id, payment_id, source_charge_id,
        amount, reason, created_by
      ) values (
        'open_revision', p_idempotency_key, v_allocation.payment_id,
        v_charge.id, v_refund, trim(p_reason), auth.uid()
      );
    end if;
  end loop;

  if p_action = 'correct' then
    update public.round_stops
    set status = p_stop_status, note = nullif(trim(coalesce(p_note, '')), ''),
        updated_by = auth.uid(), updated_at = now()
    where id = v_stop.id;
  else
    select coalesce((
      select (log.after_value ->> 'stop_status')::public.shop_round_status
      from public.audit_logs log
      where log.entity_type = 'delivery_events' and log.entity_id = event.id
        and log.after_value ? 'stop_status'
      order by log.occurred_at limit 1
    ), case when exists (
      select 1 from public.delivery_items item where item.delivery_event_id = event.id
    ) then 'delivered'::public.shop_round_status else 'issue'::public.shop_round_status end),
      event.note
    into v_previous_status, v_previous_note
    from public.delivery_events event
    where event.round_stop_id = v_stop.id and event.status = 'active'
    order by event.recorded_at desc, event.id desc limit 1;
    update public.round_stops
    set status = coalesce(v_previous_status, 'pending'), note = v_previous_note,
        updated_by = auth.uid(), updated_at = now()
    where id = v_stop.id;
  end if;

  insert into public.delivery_event_revisions (
    idempotency_key, original_event_id, replacement_event_id,
    action, reason, revised_by, request_fingerprint
  ) values (
    p_idempotency_key, v_event.id, v_new_event_id,
    p_action, trim(p_reason), auth.uid(), v_revision_fingerprint
  );

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value, reason
  ) values (
    auth.uid(), 'delivery_events', v_event.id,
    case when p_action = 'cancel' then 'bill_cancelled' else 'bill_corrected' end,
    jsonb_build_object('charge_id', v_charge.id, 'amount', v_charge.original_amount),
    jsonb_build_object(
      'replacement_event_id', v_new_event_id, 'replacement_charge_id', v_new_charge_id,
      'amount', v_new_amount, 'refund_amount', v_preview->'refund_amount'
    ), trim(p_reason)
  );

  return jsonb_build_object(
    'original_event_id', v_event.id,
    'replacement_event_id', v_new_event_id,
    'original_charge_id', v_charge.id,
    'replacement_charge_id', v_new_charge_id,
    'action', p_action,
    'new_amount', v_new_amount,
    'refund_amount', v_preview->'refund_amount',
    'outstanding_amount', v_preview->'new_outstanding_amount'
  );
end;
$$;

create function public.create_closed_delivery_adjustment(
  p_event_id uuid,
  p_items jsonb,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.delivery_events%rowtype;
  v_stop public.round_stops%rowtype;
  v_round public.delivery_rounds%rowtype;
  v_charge public.delivery_charges%rowtype;
  v_existing public.delivery_charge_adjustments%rowtype;
  v_scope text;
  v_current_total numeric(12,2);
  v_corrected_total numeric(12,2) := 0;
  v_allocated numeric(12,2);
  v_remove numeric(12,2);
  v_take numeric(12,2);
  v_item record;
  v_payment record;
  v_unit_price numeric(12,2);
  v_original_quantity numeric(12,1);
  v_current_quantity numeric(12,1);
  v_restore_remaining numeric(12,2);
  v_restore_take numeric(12,2);
  v_before_allocation numeric(12,2);
  v_obligation record;
  v_request_fingerprint text;
  v_canonical_items jsonb;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can create a closed-period delivery adjustment';
  elsif p_idempotency_key is null or nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'An idempotency key and reason are required';
  elsif jsonb_typeof(p_items) <> 'array' then raise exception 'Adjustment items must be an array';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'ice_type_id', item.ice_type_id, 'quantity', item.quantity
  ) order by item.ice_type_id), '[]'::jsonb)
  into v_canonical_items
  from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric);
  v_request_fingerprint := md5(jsonb_build_object(
    'event_id', p_event_id, 'items', v_canonical_items, 'reason', trim(p_reason)
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select adjustment.* into v_existing
  from public.delivery_charge_adjustments adjustment
  where adjustment.idempotency_key = p_idempotency_key;
  if v_existing.idempotency_key is not null then
    if v_existing.charge_id is distinct from (
      select charge.id from public.delivery_charges charge where charge.delivery_event_id = p_event_id
    ) then raise exception 'This idempotency key belongs to another adjustment'; end if;
    if v_existing.request_fingerprint is distinct from v_request_fingerprint then
      raise exception 'This idempotency key was already used for a different delivery adjustment request';
    end if;
    return to_jsonb(v_existing) || jsonb_build_object('idempotent_replay', true);
  end if;

  select event.* into v_event from public.delivery_events event where event.id = p_event_id for update;
  select stop.* into v_stop from public.round_stops stop where stop.id = v_event.round_stop_id;
  select round.* into v_round from public.delivery_rounds round where round.id = v_stop.round_id for update;
  select charge.* into v_charge from public.delivery_charges charge
  where charge.delivery_event_id = v_event.id and charge.status = 'active' for update;
  if v_charge.id is null then raise exception 'Only an active financial delivery can be adjusted'; end if;
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_charge.shop_id::text, 0));

  if exists (
    select 1 from public.daily_stock_closures closure
    where closure.service_date = v_round.service_date and closure.status = 'closed'
  ) or exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = v_round.service_date and closure.status = 'closed'
  ) then v_scope := 'day_closed';
  elsif v_round.status <> 'open' then v_scope := 'round_closed';
  else raise exception 'Use the open delivery correction workflow while the round is open';
  end if;
  if v_scope = 'round_closed' then
    perform pg_advisory_xact_lock(hashtextextended(v_round.service_date::text, 0));
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
    where item.ice_type_id is null or item.quantity is null or item.quantity < 0
      or item.quantity * 2 <> trunc(item.quantity * 2)
  ) or exists (
    select 1 from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
    group by item.ice_type_id having count(*) > 1
  ) then raise exception 'Every adjustment item must be distinct and use a non-negative whole or half-bag quantity'; end if;

  v_current_total := public.effective_delivery_charge_amount(v_charge.id);
  for v_item in
    select item.ice_type_id, item.quantity
    from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
    order by item.ice_type_id
  loop
    select original_item.quantity, original_item.unit_price
    into v_original_quantity, v_unit_price
    from public.delivery_items original_item
    where original_item.delivery_event_id = v_event.id and original_item.ice_type_id = v_item.ice_type_id;
    v_original_quantity := coalesce(v_original_quantity, 0);
    if v_unit_price is null then
      select resolved.unit_price into v_unit_price
      from public.resolve_delivery_price(v_charge.shop_id, v_item.ice_type_id, v_charge.service_date) resolved;
    end if;
    if v_unit_price is null then raise exception 'An effective price is required for every adjusted item'; end if;
    select (
      coalesce((select item.quantity from public.delivery_items item
        where item.delivery_event_id = v_event.id and item.ice_type_id = v_item.ice_type_id), 0)
      + coalesce((select sum(adjustment_item.quantity_delta)
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items adjustment_item
          on adjustment_item.adjustment_id = adjustment.idempotency_key
        where adjustment.charge_id = v_charge.id and adjustment.status = 'active'
          and adjustment_item.ice_type_id = v_item.ice_type_id), 0)
    )::numeric(12,1) into v_current_quantity;
    if v_scope = 'round_closed' and v_item.quantity > v_current_quantity
      and public.daily_aggregate_stock_balance_at(v_round.service_date, v_item.ice_type_id)
        < v_item.quantity - v_current_quantity then
      raise exception 'Daily aggregate stock is not sufficient for the closed-period adjustment';
    end if;
    v_corrected_total := v_corrected_total + v_item.quantity * v_unit_price;
  end loop;

  insert into public.delivery_charge_adjustments (
    idempotency_key, request_fingerprint, charge_id, scope,
    amount_delta, corrected_total, reason, created_by
  ) values (
    p_idempotency_key, v_request_fingerprint, v_charge.id, v_scope,
    v_corrected_total - v_current_total, v_corrected_total, trim(p_reason), auth.uid()
  );

  insert into public.delivery_adjustment_items (
    adjustment_id, ice_type_id, original_quantity, corrected_quantity, unit_price
  )
  select p_idempotency_key, all_items.ice_type_id,
    coalesce(original_item.quantity, 0) + coalesce(prior_adjustments.quantity_delta, 0),
    coalesce(corrected.quantity, 0),
    coalesce(original_item.unit_price, resolved.unit_price)
  from (
    select item.ice_type_id from public.delivery_items item where item.delivery_event_id = v_event.id
    union
    select input.ice_type_id from jsonb_to_recordset(p_items) input(ice_type_id uuid, quantity numeric)
    union
    select prior_item.ice_type_id
    from public.delivery_charge_adjustments prior
    join public.delivery_adjustment_items prior_item on prior_item.adjustment_id = prior.idempotency_key
    where prior.charge_id = v_charge.id and prior.status = 'active'
  ) all_items
  left join public.delivery_items original_item
    on original_item.delivery_event_id = v_event.id and original_item.ice_type_id = all_items.ice_type_id
  left join jsonb_to_recordset(p_items) corrected(ice_type_id uuid, quantity numeric)
    on corrected.ice_type_id = all_items.ice_type_id
  left join lateral (
    select coalesce(sum(prior_item.quantity_delta), 0)::numeric(12,1) as quantity_delta
    from public.delivery_charge_adjustments prior
    join public.delivery_adjustment_items prior_item
      on prior_item.adjustment_id = prior.idempotency_key
    where prior.charge_id = v_charge.id and prior.status = 'active'
      and prior_item.ice_type_id = all_items.ice_type_id
  ) prior_adjustments on true
  left join lateral public.resolve_delivery_price(
    v_charge.shop_id, all_items.ice_type_id, v_charge.service_date
  ) resolved on original_item.unit_price is null;

  select coalesce(sum(allocation.amount), 0)::numeric(12,2)
  into v_allocated
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
  where allocation.charge_id = v_charge.id;

  v_restore_remaining := greatest(v_corrected_total - v_allocated, 0);
  for v_obligation in
    select obligation.*
    from public.refund_obligations obligation
    where obligation.source_charge_id = v_charge.id and obligation.status = 'pending'
    order by obligation.created_at desc, obligation.id desc
    for update
  loop
    exit when v_restore_remaining <= 0;
    v_restore_take := least(v_obligation.amount, v_restore_remaining);
    select coalesce((select allocation.amount from public.payment_allocations allocation
      where allocation.payment_id = v_obligation.payment_id and allocation.charge_id = v_charge.id), 0)
    into v_before_allocation;

    update public.refund_obligations
    set status = 'voided', voided_by = auth.uid(), voided_at = now(),
        void_reason = 'Reconciled by closed-period adjustment: ' || trim(p_reason)
    where id = v_obligation.id;
    if v_obligation.amount > v_restore_take then
      insert into public.refund_obligations (
        source_kind, source_id, payment_id, source_charge_id, amount, reason, created_by
      ) values (
        'closed_adjustment', p_idempotency_key, v_obligation.payment_id, v_charge.id,
        v_obligation.amount - v_restore_take, v_obligation.reason, auth.uid()
      );
    end if;
    insert into public.payment_allocations (payment_id, charge_id, amount)
    values (v_obligation.payment_id, v_charge.id, v_restore_take)
    on conflict (payment_id, charge_id) do update
      set amount = public.payment_allocations.amount + excluded.amount;
    insert into public.payment_allocation_changes (
      source_kind, source_id, payment_id, from_charge_id, to_charge_id,
      before_amount, after_amount, reason, changed_by
    ) values (
      'closed_adjustment', p_idempotency_key, v_obligation.payment_id,
      v_charge.id, v_charge.id, v_before_allocation, v_before_allocation + v_restore_take,
      trim(p_reason), auth.uid()
    );
    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, before_value, after_value, reason
    ) values (
      auth.uid(), 'refund_obligations', v_obligation.id, 'voided_after_adjustment',
      jsonb_build_object('status', 'pending', 'amount', v_obligation.amount),
      jsonb_build_object('status', 'voided', 'restored_allocation', v_restore_take,
        'replacement_refund_amount', greatest(v_obligation.amount - v_restore_take, 0)),
      trim(p_reason)
    );
    v_restore_remaining := v_restore_remaining - v_restore_take;
  end loop;

  select coalesce(sum(allocation.amount), 0)::numeric(12,2)
  into v_allocated
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
  where allocation.charge_id = v_charge.id;
  v_remove := greatest(v_allocated - v_corrected_total, 0);

  for v_payment in
    select payment.id as payment_id, allocation.amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
    where allocation.charge_id = v_charge.id
    order by payment.recorded_at desc, payment.id desc
  loop
    exit when v_remove <= 0;
    v_take := least(v_payment.amount, v_remove);
    if v_take = v_payment.amount then
      delete from public.payment_allocations
      where payment_id = v_payment.payment_id and charge_id = v_charge.id;
    else
      update public.payment_allocations set amount = amount - v_take
      where payment_id = v_payment.payment_id and charge_id = v_charge.id;
    end if;
    insert into public.payment_allocation_changes (
      source_kind, source_id, payment_id, from_charge_id, to_charge_id,
      before_amount, after_amount, reason, changed_by
    ) values (
      'closed_adjustment', p_idempotency_key, v_payment.payment_id,
      v_charge.id, v_charge.id, v_payment.amount, v_payment.amount - v_take,
      trim(p_reason), auth.uid()
    );
    insert into public.refund_obligations (
      source_kind, source_id, payment_id, source_charge_id, amount, reason, created_by
    ) values (
      'closed_adjustment', p_idempotency_key, v_payment.payment_id,
      v_charge.id, v_take, trim(p_reason), auth.uid()
    );
    v_remove := v_remove - v_take;
  end loop;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value, reason
  ) values (
    auth.uid(), 'delivery_charges', v_charge.id, 'closed_period_adjusted',
    jsonb_build_object('effective_amount', v_current_total),
    jsonb_build_object('effective_amount', v_corrected_total, 'scope', v_scope),
    trim(p_reason)
  );

  return jsonb_build_object(
    'adjustment_id', p_idempotency_key, 'charge_id', v_charge.id, 'scope', v_scope,
    'previous_amount', v_current_total, 'corrected_amount', v_corrected_total,
    'amount_delta', v_corrected_total - v_current_total,
    'refund_amount', greatest(v_allocated - v_corrected_total, 0)
  );
end;
$$;

create trigger payment_allocation_changes_append_only
before update or delete on public.payment_allocation_changes
for each row execute function public.protect_append_only_financial_history();
create trigger refund_settlements_append_only
before update or delete on public.refund_settlements
for each row execute function public.protect_append_only_financial_history();
create trigger delivery_adjustment_items_append_only
before update or delete on public.delivery_adjustment_items
for each row execute function public.protect_append_only_financial_history();

create function public.effective_delivery_charge_amount(p_charge_id uuid)
returns numeric(12,2)
language sql
stable
security definer
set search_path = public
as $$
  select (
    charge.original_amount + coalesce((
      select sum(adjustment.amount_delta)
      from public.delivery_charge_adjustments adjustment
      where adjustment.charge_id = charge.id and adjustment.status = 'active'
    ), 0)
  )::numeric(12,2)
  from public.delivery_charges charge
  where charge.id = p_charge_id;
$$;

create or replace function public.assert_payment_allocation_integrity(target_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_declared_amount numeric(12,2);
  v_accounted_amount numeric(12,2);
  v_shop_id uuid;
begin
  select payment.shop_id, payment.allocated_amount
  into v_shop_id, v_declared_amount
  from public.payments payment
  where payment.id = target_payment_id;
  if not found then return; end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

  select (
    coalesce((select sum(allocation.amount)
      from public.payment_allocations allocation
      where allocation.payment_id = target_payment_id), 0)
    + coalesce((select sum(obligation.amount)
      from public.refund_obligations obligation
      where obligation.payment_id = target_payment_id and obligation.status <> 'voided'), 0)
  )::numeric(12,2)
  into v_accounted_amount;

  if v_accounted_amount <> v_declared_amount then
    raise exception 'Payment allocations plus refund obligations must equal the allocated amount';
  end if;

  if exists (
    select 1
    from public.payment_allocations allocation
    join public.delivery_charges charge on charge.id = allocation.charge_id
    where allocation.payment_id = target_payment_id
      and charge.shop_id <> v_shop_id
  ) then
    raise exception 'Every payment allocation must belong to the payment shop';
  end if;
end;
$$;

create or replace function public.assert_charge_allocation_integrity(target_charge_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effective_amount numeric(12,2);
  v_allocated_amount numeric(12,2);
  v_status public.financial_record_status;
  v_shop_id uuid;
begin
  select public.effective_delivery_charge_amount(charge.id), charge.status, charge.shop_id
  into v_effective_amount, v_status, v_shop_id
  from public.delivery_charges charge
  where charge.id = target_charge_id;
  if not found then return; end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

  select coalesce(sum(allocation.amount), 0)::numeric(12,2)
  into v_allocated_amount
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id
  where allocation.charge_id = target_charge_id and payment.status = 'active';

  if v_status = 'voided' and v_allocated_amount > 0 then
    raise exception 'Void active payments before voiding their delivery charge';
  elsif v_allocated_amount > v_effective_amount then
    raise exception 'Active payment allocations cannot exceed the effective charge amount';
  end if;
end;
$$;

create function public.get_delivery_correction_context(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_event public.delivery_events%rowtype;
  v_round public.delivery_rounds%rowtype;
  v_stop public.round_stops%rowtype;
  v_charge public.delivery_charges%rowtype;
  v_allocated numeric(12,2) := 0;
  v_is_latest boolean := false;
  v_day_closed boolean := false;
  v_can_correct boolean := false;
  v_can_cancel boolean := false;
  v_blocker text;
begin
  if not public.is_active_user() then raise exception 'An active user is required'; end if;

  select event.* into v_event from public.delivery_events event where event.id = p_event_id;
  if v_event.id is null then raise exception 'The selected delivery event does not exist'; end if;
  select stop.* into v_stop from public.round_stops stop where stop.id = v_event.round_stop_id;
  select round.* into v_round from public.delivery_rounds round where round.id = v_stop.round_id;
  select charge.* into v_charge from public.delivery_charges charge where charge.delivery_event_id = v_event.id;

  select coalesce(sum(allocation.amount), 0)::numeric(12,2)
  into v_allocated
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
  where allocation.charge_id = v_charge.id;

  select not exists (
    select 1 from public.delivery_events newer
    where newer.round_stop_id = v_event.round_stop_id and newer.status = 'active'
      and (newer.recorded_at, newer.id) > (v_event.recorded_at, v_event.id)
  ) into v_is_latest;
  select exists (
    select 1 from public.daily_stock_closures closure
    where closure.service_date = v_round.service_date and closure.status = 'closed'
  ) or exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = v_round.service_date and closure.status = 'closed'
  ) into v_day_closed;

  if v_event.status <> 'active' then v_blocker := 'รายการนี้ถูกยกเลิกหรือแทนที่แล้ว';
  elsif not v_is_latest then v_blocker := 'รายการนี้ไม่ใช่รายการล่าสุดของร้านในรอบ';
  elsif v_round.status <> 'open' then v_blocker := 'รอบส่งปิดแล้ว ต้องสร้างเอกสารปรับปรุง';
  elsif v_day_closed then v_blocker := 'วันทำงานปิดแล้ว ต้องสร้างเอกสารปรับปรุง';
  elsif v_charge.id is null then v_blocker := 'รายการเดิมนี้ไม่มีข้อมูลบิลและราคา';
  elsif public.current_app_role() = 'courier' and v_event.recorded_by <> auth.uid() then
    v_blocker := 'พนักงานแก้ได้เฉพาะรายการที่ตนเองบันทึก';
  elsif public.current_app_role() = 'courier' and v_allocated > 0 then
    v_blocker := 'บิลรับชำระแล้ว ต้องให้หัวหน้าหรือแอดมินแก้ไข';
  elsif public.current_app_role() = 'courier'
    and v_round.service_date <> (now() at time zone 'Asia/Bangkok')::date then
    v_blocker := 'พนักงานแก้ได้เฉพาะรายการของวันนี้';
  elsif public.current_app_role() not in ('courier', 'round_lead', 'admin') then
    v_blocker := 'ผู้ใช้ไม่มีสิทธิ์แก้ไขบิล';
  end if;

  v_can_correct := v_blocker is null;
  v_can_cancel := v_blocker is null and public.current_app_role() in ('round_lead', 'admin');

  return jsonb_build_object(
    'delivery_event_id', v_event.id,
    'round_stop_id', v_event.round_stop_id,
    'charge_id', v_charge.id,
    'charge_number', v_charge.charge_number,
    'shop_id', v_stop.shop_id,
    'shop_name', v_stop.shop_name_snapshot,
    'service_date', v_round.service_date,
    'round_status', v_round.status,
    'day_closed', v_day_closed,
    'is_latest', v_is_latest,
    'recorded_by', v_event.recorded_by,
    'payment_term', v_charge.payment_term,
    'due_date', v_charge.due_date,
    'note', v_event.note,
    'original_amount', v_charge.original_amount,
    'effective_amount', public.effective_delivery_charge_amount(v_charge.id),
    'allocated_amount', v_allocated,
    'can_correct', v_can_correct,
    'can_cancel', v_can_cancel,
    'blocker_reason', v_blocker,
    'ice_types', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', ice.id,
        'code', ice.code,
        'name', ice.name,
        'unit', ice.unit,
        'unit_price', coalesce(original_item.unit_price, resolved.unit_price)
      ) order by ice.code)
      from public.ice_types ice
      left join public.delivery_items original_item
        on original_item.delivery_event_id = v_event.id and original_item.ice_type_id = ice.id
      left join lateral public.resolve_delivery_price(v_stop.shop_id, ice.id, v_round.service_date) resolved on true
      where ice.is_active or original_item.delivery_event_id is not null
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', all_items.ice_type_id, 'name', ice.name, 'unit', ice.unit,
        'quantity', coalesce(original_item.quantity, 0) + coalesce(adjustments.quantity_delta, 0),
        'unit_price', coalesce(original_item.unit_price, resolved.unit_price)
      ) order by ice.code)
      from (
        select item.ice_type_id
        from public.delivery_items item where item.delivery_event_id = v_event.id
        union
        select adjustment_item.ice_type_id
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items adjustment_item
          on adjustment_item.adjustment_id = adjustment.idempotency_key
        where adjustment.charge_id = v_charge.id and adjustment.status = 'active'
      ) all_items
      join public.ice_types ice on ice.id = all_items.ice_type_id
      left join public.delivery_items original_item
        on original_item.delivery_event_id = v_event.id and original_item.ice_type_id = all_items.ice_type_id
      left join lateral (
        select coalesce(sum(adjustment_item.quantity_delta), 0)::numeric(12,1) as quantity_delta
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items adjustment_item
          on adjustment_item.adjustment_id = adjustment.idempotency_key
        where adjustment.charge_id = v_charge.id and adjustment.status = 'active'
          and adjustment_item.ice_type_id = all_items.ice_type_id
      ) adjustments on true
      left join lateral public.resolve_delivery_price(v_stop.shop_id, all_items.ice_type_id, v_round.service_date) resolved on true
    ), '[]'::jsonb)
  );
end;
$$;

create function public.preview_delivery_correction(
  p_event_id uuid,
  p_action text,
  p_items jsonb,
  p_stop_status public.shop_round_status
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_context jsonb;
  v_shop_id uuid;
  v_service_date date;
  v_new_amount numeric(12,2) := 0;
  v_allocated numeric(12,2);
  v_charge_id uuid;
  v_payment_term public.payment_term;
  v_credit_limit numeric(12,2);
  v_credit_exposure numeric(12,2) := 0;
  v_approval_required boolean := false;
  v_item record;
  v_unit_price numeric(12,2);
begin
  v_context := public.get_delivery_correction_context(p_event_id);
  if p_action not in ('correct', 'cancel') then raise exception 'Correction action must be correct or cancel';
  elsif p_action = 'correct' and not coalesce((v_context->>'can_correct')::boolean, false) then
    raise exception '%', coalesce(v_context->>'blocker_reason', 'This bill cannot be corrected');
  elsif p_action = 'cancel' and not coalesce((v_context->>'can_cancel')::boolean, false) then
    raise exception '%', coalesce(v_context->>'blocker_reason', 'This bill cannot be cancelled');
  end if;

  if p_action = 'correct' then
    if jsonb_typeof(p_items) <> 'array' then raise exception 'Correction items must be an array'; end if;
    if p_stop_status = 'pending' then raise exception 'A correction cannot reset a shop to pending';
    elsif p_stop_status = 'delivered' and jsonb_array_length(p_items) = 0 then
      raise exception 'A delivered correction requires at least one item';
    elsif p_stop_status <> 'delivered' and jsonb_array_length(p_items) > 0 then
      raise exception 'A non-delivery correction cannot contain items';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
      where item.ice_type_id is null or item.quantity is null or item.quantity <= 0
        or item.quantity * 2 <> trunc(item.quantity * 2)
    ) or exists (
      select 1 from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
      group by item.ice_type_id having count(*) > 1
    ) then raise exception 'Every item must be distinct and use a positive whole or half-bag quantity'; end if;

    v_shop_id := (v_context->>'shop_id')::uuid;
    v_service_date := (v_context->>'service_date')::date;
    for v_item in select * from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric)
    loop
      select original_item.unit_price into v_unit_price
      from public.delivery_items original_item
      where original_item.delivery_event_id = p_event_id
        and original_item.ice_type_id = v_item.ice_type_id;
      if v_unit_price is null then
        select resolved.unit_price into v_unit_price
        from public.resolve_delivery_price(v_shop_id, v_item.ice_type_id, v_service_date) resolved;
      end if;
      if v_unit_price is null then raise exception 'An effective price is required for every corrected item'; end if;
      v_new_amount := v_new_amount + v_item.quantity * v_unit_price;
    end loop;
  end if;

  v_allocated := coalesce((v_context->>'allocated_amount')::numeric, 0);
  v_charge_id := (v_context->>'charge_id')::uuid;
  v_payment_term := (v_context->>'payment_term')::public.payment_term;
  if p_action = 'correct' and p_stop_status = 'delivered' and v_payment_term = 'credit' then
    select profile.credit_limit into v_credit_limit
    from public.shop_payment_profiles profile where profile.shop_id = v_shop_id;
    select coalesce(sum(greatest(
      public.effective_delivery_charge_amount(charge.id) - coalesce(allocation.amount, 0), 0
    )), 0)::numeric(12,2)
    into v_credit_exposure
    from public.delivery_charges charge
    left join lateral (
      select coalesce(sum(payment_allocation.amount), 0)::numeric(12,2) as amount
      from public.payment_allocations payment_allocation
      join public.payments payment on payment.id = payment_allocation.payment_id
      where payment_allocation.charge_id = charge.id and payment.status = 'active'
    ) allocation on true
    where charge.shop_id = v_shop_id and charge.payment_term = 'credit'
      and charge.status = 'active' and charge.id <> v_charge_id;
    v_approval_required := v_credit_limit is not null
      and v_credit_exposure + greatest(v_new_amount - v_allocated, 0) > v_credit_limit;
  end if;
  return v_context || jsonb_build_object(
    'action', p_action,
    'new_amount', v_new_amount,
    'new_outstanding_amount', greatest(v_new_amount - v_allocated, 0),
    'outstanding_amount', greatest(v_new_amount - v_allocated, 0),
    'refund_amount', greatest(v_allocated - v_new_amount, 0),
    'approval_required', v_approval_required,
    'amount_delta', v_new_amount - coalesce((v_context->>'effective_amount')::numeric, 0),
    'stock_deltas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', all_items.ice_type_id,
        'name', ice.name,
        'unit', ice.unit,
        'quantity_delta', coalesce(original_item.quantity, 0) - coalesce(corrected.quantity, 0)
      ) order by ice.code)
      from (
        select item.ice_type_id from public.delivery_items item where item.delivery_event_id = p_event_id
        union
        select input.ice_type_id from jsonb_to_recordset(p_items) input(ice_type_id uuid, quantity numeric)
      ) all_items
      join public.ice_types ice on ice.id = all_items.ice_type_id
      left join public.delivery_items original_item
        on original_item.delivery_event_id = p_event_id and original_item.ice_type_id = all_items.ice_type_id
      left join jsonb_to_recordset(p_items) corrected(ice_type_id uuid, quantity numeric)
        on corrected.ice_type_id = all_items.ice_type_id
    ), '[]'::jsonb)
  );
end;
$$;

create function public.get_refund_queue(p_pending_only boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view refunds';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', obligation.id,
      'shop_id', payment.shop_id,
      'shop_code', shop.code,
      'shop_name', shop.name,
      'payment_id', payment.id,
      'receipt_number', payment.receipt_number,
      'charge_id', obligation.source_charge_id,
      'charge_number', charge.charge_number,
      'amount', obligation.amount,
      'status', obligation.status,
      'reason', obligation.reason,
      'created_at', obligation.created_at,
      'age_days', greatest((now() at time zone 'Asia/Bangkok')::date - obligation.created_at::date, 0),
      'settlement', case when settlement.obligation_id is null then null else jsonb_build_object(
        'refund_method', settlement.refund_method,
        'reference_number', settlement.reference_number,
        'settled_by', settler.display_name,
        'settled_at', settlement.settled_at
      ) end
    ) order by obligation.created_at, obligation.id)
    from public.refund_obligations obligation
    join public.payments payment on payment.id = obligation.payment_id
    join public.shops shop on shop.id = payment.shop_id
    join public.delivery_charges charge on charge.id = obligation.source_charge_id
    left join public.refund_settlements settlement on settlement.obligation_id = obligation.id
    left join public.users settler on settler.id = settlement.settled_by
    where not p_pending_only or obligation.status = 'pending'
  ), '[]'::jsonb);
end;
$$;

create function public.settle_refund(
  p_obligation_id uuid,
  p_refund_method public.payment_method,
  p_reference_number text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_obligation public.refund_obligations%rowtype;
  v_existing public.refund_settlements%rowtype;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can settle refunds';
  elsif p_obligation_id is null or p_refund_method is null or p_idempotency_key is null then
    raise exception 'Refund obligation, method, and idempotency key are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select settlement.* into v_existing
  from public.refund_settlements settlement
  where settlement.idempotency_key = p_idempotency_key;
  if v_existing.idempotency_key is not null then
    if v_existing.obligation_id <> p_obligation_id or v_existing.refund_method <> p_refund_method
      or v_existing.reference_number is distinct from nullif(trim(coalesce(p_reference_number, '')), '') then
      raise exception 'This idempotency key belongs to another refund settlement';
    end if;
    return to_jsonb(v_existing) || jsonb_build_object('idempotent_replay', true);
  end if;

  select obligation.* into v_obligation
  from public.refund_obligations obligation
  where obligation.id = p_obligation_id for update;
  if v_obligation.id is null then raise exception 'The refund obligation does not exist';
  elsif v_obligation.status <> 'pending' then raise exception 'The refund obligation is not pending';
  end if;

  insert into public.refund_settlements (
    idempotency_key, obligation_id, amount, refund_method,
    reference_number, settled_by
  ) values (
    p_idempotency_key, v_obligation.id, v_obligation.amount, p_refund_method,
    nullif(trim(coalesce(p_reference_number, '')), ''), auth.uid()
  );
  update public.refund_obligations set status = 'settled' where id = v_obligation.id;
  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'refund_obligations', v_obligation.id, 'settled',
    jsonb_build_object('amount', v_obligation.amount, 'method', p_refund_method,
      'reference_number', nullif(trim(coalesce(p_reference_number, '')), ''))
  );
  return jsonb_build_object(
    'obligation_id', v_obligation.id, 'amount', v_obligation.amount,
    'status', 'settled', 'refund_method', p_refund_method
  );
end;
$$;

create or replace function public.void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
begin
  if not public.is_active_user() then raise exception 'An active user is required';
  elsif nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'A void reason is required';
  end if;

  select payment.* into v_payment from public.payments payment where payment.id = p_payment_id for update;
  if v_payment.id is null then raise exception 'The selected payment does not exist';
  elsif v_payment.status <> 'active' then raise exception 'The selected payment is already voided';
  elsif public.current_app_role() = 'courier' and v_payment.recorded_by <> auth.uid() then
    raise exception 'Couriers can only void payments they recorded';
  elsif public.current_app_role() not in ('courier', 'round_lead', 'admin') then
    raise exception 'The current user cannot void payments';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_payment.shop_id::text, 0));
  if exists (
    select 1 from public.payment_allocation_changes change where change.payment_id = v_payment.id
  ) or exists (
    select 1 from public.refund_obligations obligation where obligation.payment_id = v_payment.id
  ) then raise exception 'A payment linked to a bill correction or refund cannot be voided';
  end if;

  if v_payment.collection_run_id is not null and not exists (
    select 1 from public.collection_runs run
    where run.id = v_payment.collection_run_id and run.status = 'open'
  ) then raise exception 'Payments can only be voided while their collection run is open';
  elsif v_payment.collection_run_id is null and exists (
    select 1
    from public.payment_allocations allocation
    join public.delivery_charges charge on charge.id = allocation.charge_id
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.delivery_rounds round on round.id = stop.round_id
    where allocation.payment_id = v_payment.id
      and (round.status <> 'open' or exists (
        select 1 from public.daily_stock_closures closure
        where closure.service_date = round.service_date and closure.status = 'closed'
      ) or exists (
        select 1 from public.daily_aggregate_stock_closures closure
        where closure.service_date = round.service_date and closure.status = 'closed'
      ))
  ) then raise exception 'Payments can only be voided while the delivery period is open';
  end if;

  update public.payments
  set status = 'voided', voided_by = auth.uid(), voided_at = now(), void_reason = trim(p_reason)
  where id = v_payment.id;
  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (auth.uid(), 'payments', v_payment.id, 'voided', jsonb_build_object('reason', trim(p_reason)));
  return public.financial_payment_response(v_payment.id);
end;
$$;

revoke all on function public.protect_append_only_financial_history() from public;
revoke all on function public.effective_delivery_charge_amount(uuid) from public;
revoke all on function public.get_delivery_correction_context(uuid) from public;
revoke all on function public.preview_delivery_correction(uuid, text, jsonb, public.shop_round_status) from public;
revoke all on function public.apply_open_delivery_correction(uuid, text, jsonb, public.shop_round_status, text, text, uuid, uuid) from public;
revoke all on function public.create_closed_delivery_adjustment(uuid, jsonb, text, uuid) from public;
revoke all on function public.get_refund_queue(boolean) from public;
revoke all on function public.settle_refund(uuid, public.payment_method, text, uuid) from public;
revoke all on function public.void_payment(uuid, text) from public;
grant execute on function public.get_delivery_correction_context(uuid) to authenticated;
grant execute on function public.preview_delivery_correction(uuid, text, jsonb, public.shop_round_status) to authenticated;
grant execute on function public.apply_open_delivery_correction(uuid, text, jsonb, public.shop_round_status, text, text, uuid, uuid) to authenticated;
grant execute on function public.create_closed_delivery_adjustment(uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.get_refund_queue(boolean) to authenticated;
grant execute on function public.settle_refund(uuid, public.payment_method, text, uuid) to authenticated;
grant execute on function public.void_payment(uuid, text) to authenticated;

notify pgrst, 'reload schema';
