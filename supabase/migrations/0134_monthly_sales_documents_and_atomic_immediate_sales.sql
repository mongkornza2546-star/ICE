-- Monthly INV/REC documents, immutable delivery snapshots, and atomic immediate sales.
-- Legacy C/R numbers are deliberately preserved and are not counted forward.

create table public.document_counters (
  document_type text not null check (document_type in ('INV', 'REC')),
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  last_sequence integer not null check (last_sequence between 0 and 99999),
  primary key (document_type, period_month)
);

create function public.next_sales_document_number(
  p_document_type text,
  p_period_month date
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_month date;
  v_sequence integer;
begin
  if p_document_type not in ('INV', 'REC') then
    raise exception 'Document type must be INV or REC';
  elsif p_period_month is null then
    raise exception 'Document period is required';
  end if;

  v_period_month := date_trunc('month', p_period_month)::date;
  insert into public.document_counters (document_type, period_month, last_sequence)
  values (p_document_type, v_period_month, 0)
  on conflict (document_type, period_month) do nothing;

  select counter.last_sequence
  into v_sequence
  from public.document_counters counter
  where counter.document_type = p_document_type
    and counter.period_month = v_period_month
  for update;

  if v_sequence >= 99999 then
    raise exception '% document sequence for % exceeds 99999', p_document_type, v_period_month;
  end if;

  update public.document_counters counter
  set last_sequence = counter.last_sequence + 1
  where counter.document_type = p_document_type
    and counter.period_month = v_period_month
  returning counter.last_sequence into v_sequence;

  return p_document_type || to_char(v_period_month, 'YYMM') || '-'
    || lpad(v_sequence::text, 5, '0');
end;
$$;

alter table public.delivery_charges
  alter column charge_number drop not null;

create or replace function public.assign_delivery_charge_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.payment_term = 'immediate' then
    new.charge_number := null;
  elsif new.charge_number is null then
    new.charge_number := public.next_sales_document_number(
      'INV', date_trunc('month', new.service_date)::date
    );
  end if;
  return new;
end;
$$;

create or replace function public.assign_payment_receipt_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.receipt_number is null then
    new.receipt_number := public.next_sales_document_number(
      'REC', date_trunc('month', coalesce(new.recorded_at, now()) at time zone 'Asia/Bangkok')::date
    );
  end if;
  return new;
end;
$$;

-- Receipt snapshots keep the original schema keys for legacy readers and add
-- the document fields needed by the shared INV/REC renderer.
create or replace function public.build_payment_receipt_snapshot(p_payment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'payment_id', payment.id,
    'document_type', 'REC',
    'document_number', payment.receipt_number,
    'receipt_number', payment.receipt_number,
    'document_title', case
      when bool_and(charge.payment_term = 'immediate') then 'ใบส่งของ / ใบเสร็จรับเงิน'
      else 'ใบเสร็จรับเงิน'
    end,
    'payment_term', case when count(distinct charge.payment_term) = 1
      then min(charge.payment_term::text) else null end,
    'shop_code', shop.code,
    'shop_name', shop.name,
    'shop_location', nullif(concat_ws(' · ', min(stop.building_name_snapshot), min(stop.floor_or_zone_snapshot)), ''),
    'service_date', min(charge.service_date),
    'payment_method', payment.payment_method,
    'received_amount', payment.received_amount,
    'allocated_amount', payment.allocated_amount,
    'change_amount', payment.change_amount,
    'recorded_at', payment.recorded_at,
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_number', charge_detail.charge_number,
        'payment_term', charge_detail.payment_term,
        'service_date', charge_detail.service_date,
        'location', nullif(concat_ws(' · ', stop_detail.building_name_snapshot, stop_detail.floor_or_zone_snapshot), ''),
        'received_amount', allocation.amount,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ice_type_name', ice.name,
            'ice_type_unit', ice.unit,
            'quantity', item.quantity,
            'unit_price', item.unit_price,
            'line_total', item.line_total
          ) order by ice.code)
          from public.delivery_events event
          join public.delivery_items item on item.delivery_event_id = event.id
          join public.ice_types ice on ice.id = item.ice_type_id
          where event.id = charge_detail.delivery_event_id
        ), '[]'::jsonb)
      ) order by charge_detail.service_date, charge_detail.created_at, charge_detail.id)
      from public.payment_allocations allocation
      join public.delivery_charges charge_detail on charge_detail.id = allocation.charge_id
      join public.delivery_events event_detail on event_detail.id = charge_detail.delivery_event_id
      join public.round_stops stop_detail on stop_detail.id = event_detail.round_stop_id
      where allocation.payment_id = payment.id
    ), '[]'::jsonb)
  )
  from public.payments payment
  join public.shops shop on shop.id = payment.shop_id
  join public.payment_allocations root_allocation on root_allocation.payment_id = payment.id
  join public.delivery_charges charge on charge.id = root_allocation.charge_id
  join public.delivery_events event on event.id = charge.delivery_event_id
  join public.round_stops stop on stop.id = event.round_stop_id
  where payment.id = p_payment_id
  group by payment.id, shop.id;
$$;

create or replace function public.get_payment_receipt_snapshot(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_receipt jsonb;
  v_payment public.payments%rowtype;
  v_voided_by_name text;
begin
  if not public.is_payment_visible(p_payment_id) then
    raise exception 'This payment cannot be viewed by the current user';
  end if;

  select payment.* into v_payment from public.payments payment where payment.id = p_payment_id;
  select snapshot.receipt_data into v_receipt
  from public.payment_receipt_snapshots snapshot where snapshot.payment_id = p_payment_id;
  if v_receipt is null then raise exception 'The payment receipt snapshot does not exist'; end if;

  if v_payment.voided_by is not null then
    select app_user.display_name into v_voided_by_name
    from public.users app_user where app_user.id = v_payment.voided_by;
  end if;

  return v_receipt || jsonb_build_object(
    'document_type', 'REC',
    'document_number', coalesce(v_receipt ->> 'document_number', v_receipt ->> 'receipt_number'),
    'document_title', coalesce(v_receipt ->> 'document_title', 'ใบเสร็จรับเงิน'),
    'status', v_payment.status,
    'void_info', case when v_payment.status = 'voided' then jsonb_build_object(
      'voided_at', v_payment.voided_at,
      'reason', v_payment.void_reason,
      'voided_by', v_voided_by_name
    ) else null end
  );
end;
$$;

create table public.delivery_charge_document_snapshots (
  charge_id uuid primary key references public.delivery_charges(id) on delete restrict,
  document_data jsonb not null check (jsonb_typeof(document_data) = 'object'),
  created_at timestamptz not null default now()
);

create function public.build_charge_print_document(p_charge_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'document_type', 'INV',
    'document_number', charge.charge_number,
    'document_title', 'ใบส่งของ / ใบแจ้งหนี้',
    'payment_term', charge.payment_term,
    'issued_at', charge.created_at,
    'service_date', charge.service_date,
    'due_date', charge.due_date,
    'shop_code', stop.shop_code_snapshot,
    'shop_name', stop.shop_name_snapshot,
    'shop_location', nullif(concat_ws(' · ', stop.building_name_snapshot, stop.floor_or_zone_snapshot), ''),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_name', ice.name,
        'ice_type_unit', ice.unit,
        'quantity', item.quantity,
        'unit_price', item.unit_price,
        'line_total', item.line_total
      ) order by ice.code)
      from public.delivery_items item
      join public.ice_types ice on ice.id = item.ice_type_id
      where item.delivery_event_id = charge.delivery_event_id
    ), '[]'::jsonb),
    'total_amount', charge.original_amount
  )
  from public.delivery_charges charge
  join public.delivery_events event on event.id = charge.delivery_event_id
  join public.round_stops stop on stop.id = event.round_stop_id
  where charge.id = p_charge_id and charge.charge_number is not null;
$$;

create function public.capture_charge_print_document()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.charge_number is not null then
    insert into public.delivery_charge_document_snapshots (charge_id, document_data)
    values (new.id, public.build_charge_print_document(new.id));
  end if;
  return null;
end;
$$;

create trigger delivery_charges_capture_print_document
after insert on public.delivery_charges
for each row execute function public.capture_charge_print_document();

insert into public.delivery_charge_document_snapshots (charge_id, document_data, created_at)
select charge.id, public.build_charge_print_document(charge.id), charge.created_at
from public.delivery_charges charge
where charge.charge_number is not null
on conflict (charge_id) do nothing;

create function public.protect_charge_print_document()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Delivery charge document snapshots are immutable';
end;
$$;

create trigger delivery_charge_document_snapshots_immutable
before update or delete on public.delivery_charge_document_snapshots
for each row execute function public.protect_charge_print_document();

alter table public.delivery_charge_document_snapshots enable row level security;
create policy "assigned users read delivery charge document snapshots"
on public.delivery_charge_document_snapshots for select
using (public.is_financial_charge_visible(charge_id));

create function public.get_charge_print_document(p_charge_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_document jsonb;
  v_charge public.delivery_charges%rowtype;
  v_voided_by_name text;
begin
  if not public.is_financial_charge_visible(p_charge_id) then
    raise exception 'This delivery document cannot be viewed by the current user';
  end if;
  select charge.* into v_charge from public.delivery_charges charge where charge.id = p_charge_id;
  select snapshot.document_data into v_document
  from public.delivery_charge_document_snapshots snapshot where snapshot.charge_id = p_charge_id;
  if v_document is null then raise exception 'The delivery document snapshot does not exist'; end if;
  if v_charge.voided_by is not null then
    select app_user.display_name into v_voided_by_name
    from public.users app_user where app_user.id = v_charge.voided_by;
  end if;
  return v_document || jsonb_build_object(
    'status', v_charge.status,
    'void_info', case when v_charge.status = 'voided' then jsonb_build_object(
      'voided_at', v_charge.voided_at,
      'reason', v_charge.void_reason,
      'voided_by', v_voided_by_name
    ) else null end
  );
end;
$$;

-- Extend the existing delivery response without changing record_delivery's contract.
create or replace function public.delivery_financial_response(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'delivery_event_id', event.id,
    'round_stop_id', event.round_stop_id,
    'recorded_by', event.recorded_by,
    'recorded_at', event.recorded_at,
    'client_recorded_at', event.client_recorded_at,
    'note', event.note,
    'source_stock_location_id', event.source_stock_location_id,
    'charge_id', charge.id,
    'charge_number', charge.charge_number,
    'service_date', charge.service_date,
    'total_amount', charge.original_amount,
    'payment_term', charge.payment_term,
    'payment_status', case
      when charge.id is null then null
      when coalesce(allocation.allocated_amount, 0) <= 0 then 'unpaid'
      when allocation.allocated_amount < public.effective_delivery_charge_amount(charge.id) then 'partial'
      else 'paid'
    end,
    'due_date', charge.due_date,
    'approval_id', charge.approval_request_id,
    'print_document', snapshot.document_data,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ice_type_id', item.ice_type_id, 'name', ice.name, 'unit', ice.unit,
        'quantity', item.quantity, 'unit_price', item.unit_price,
        'line_total', item.line_total, 'price_source', item.price_source,
        'price_source_id', item.price_source_id
      ) order by item.ice_type_id)
      from public.delivery_items item
      join public.ice_types ice on ice.id = item.ice_type_id
      where item.delivery_event_id = event.id
    ), '[]'::jsonb)
  )
  from public.delivery_events event
  left join public.delivery_charges charge on charge.delivery_event_id = event.id and charge.status = 'active'
  left join public.delivery_charge_document_snapshots snapshot on snapshot.charge_id = charge.id
  left join lateral (
    select coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id and payment.status = 'active'
  ) allocation on true
  where event.id = p_event_id;
$$;

create function public.record_immediate_sale(
  p_round_stop_id uuid,
  p_items jsonb,
  p_note text,
  p_client_recorded_at timestamptz,
  p_payment_method public.payment_method,
  p_received_amount numeric,
  p_reference_number text,
  p_evidence_path text,
  p_expected_total numeric,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery jsonb;
  v_payment jsonb;
  v_charge_id uuid;
  v_shop_id uuid;
  v_total numeric(12,2);
  v_payment_id uuid;
  v_print_document jsonb;
begin
  if p_idempotency_key is null or p_payment_method is null or p_expected_total is null then
    raise exception 'Payment method, expected total, and idempotency key are required';
  end if;

  v_delivery := public.record_delivery(
    p_round_stop_id, p_items, 'delivered', p_note, p_client_recorded_at,
    p_idempotency_key, 'immediate', null
  );
  v_charge_id := (v_delivery ->> 'charge_id')::uuid;
  v_total := (v_delivery ->> 'total_amount')::numeric(12,2);
  select charge.shop_id into v_shop_id from public.delivery_charges charge where charge.id = v_charge_id;

  if v_charge_id is null or v_shop_id is null or v_total is null then
    raise exception 'Immediate delivery did not create a financial charge';
  elsif p_expected_total::numeric(12,2) <> v_total then
    raise exception 'Immediate sale total changed; refresh prices and confirm again';
  elsif p_payment_method = 'cash' and p_received_amount < v_total then
    raise exception 'Cash received must cover the full immediate sale amount';
  elsif p_payment_method <> 'cash' and p_received_amount <> v_total then
    raise exception 'Transfer and QR payments must equal the immediate sale amount';
  end if;

  v_payment := public.record_payment(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('charge_id', v_charge_id, 'amount', v_total)),
    p_payment_method, p_received_amount, p_reference_number, p_evidence_path,
    null, v_total, null, p_idempotency_key
  );
  v_payment_id := (v_payment ->> 'payment_id')::uuid;

  select snapshot.receipt_data into v_print_document
  from public.payment_receipt_snapshots snapshot where snapshot.payment_id = v_payment_id;
  if v_print_document is null then
    v_print_document := public.build_payment_receipt_snapshot(v_payment_id)
      || jsonb_build_object('status', v_payment ->> 'status', 'void_info', null);
  else
    v_print_document := public.get_payment_receipt_snapshot(v_payment_id);
  end if;

  return jsonb_build_object(
    'delivery', public.delivery_financial_response((v_delivery ->> 'delivery_event_id')::uuid),
    'payment', v_payment,
    'receipt_number', v_payment ->> 'receipt_number',
    'print_document', v_print_document
  );
end;
$$;

-- record_delivery remains available for non-immediate terms. At transaction
-- commit, reject any newly-created immediate charge that did not receive a REC
-- allocation in the same transaction.
create function public.require_immediate_sale_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.delivery_charges charge
    where charge.id = new.id
      and charge.payment_term = 'immediate'
      and charge.status = 'active'
      and not exists (
        select 1
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      )
  ) then
    raise exception 'Immediate sales must be recorded atomically with a receipt';
  end if;
  return null;
end;
$$;

create constraint trigger delivery_charges_require_immediate_receipt
after insert on public.delivery_charges
deferrable initially deferred
for each row execute function public.require_immediate_sale_receipt();

create function public.can_delete_payment_evidence(
  p_idempotency_key uuid,
  p_evidence_path text
)
returns boolean
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_idempotency_key is null or nullif(trim(coalesce(p_evidence_path, '')), '') is null then
    raise exception 'Idempotency key and evidence path are required';
  elsif split_part(trim(p_evidence_path), '/', 1) <> auth.uid()::text then
    raise exception 'Payment evidence does not belong to the current user';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  return not exists (
    select 1
    from public.payments payment
    where payment.idempotency_key = p_idempotency_key
      or payment.evidence_path = trim(p_evidence_path)
  );
end;
$$;

-- First-release correction rule: immediate sales must be voided/cancelled and re-entered.
create function public.reject_immediate_delivery_correction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.action = 'correct' and exists (
    select 1 from public.delivery_charges charge
    where charge.delivery_event_id = new.original_event_id
      and charge.payment_term = 'immediate'
  ) then
    raise exception 'Immediate sales cannot be corrected in place; void payment, cancel delivery, and record a new sale';
  end if;
  return new;
end;
$$;

create trigger delivery_event_revisions_reject_immediate_correction
before insert on public.delivery_event_revisions
for each row execute function public.reject_immediate_delivery_correction();

create function public.reject_immediate_delivery_adjustment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.delivery_charges charge
    where charge.id = new.charge_id and charge.payment_term = 'immediate'
  ) then
    raise exception 'Immediate sales cannot be adjusted in place; void payment, cancel delivery, and record a new sale';
  end if;
  return new;
end;
$$;

create trigger delivery_charge_adjustments_reject_immediate
before insert on public.delivery_charge_adjustments
for each row execute function public.reject_immediate_delivery_adjustment();

-- Fail before apply_open_delivery_correction starts moving allocations. This
-- keeps the first-release immediate workflow strictly void -> cancel -> re-enter.
do $guard_immediate_open_correction$
declare
  v_definition text;
  v_marker text := $marker$  if v_charge.id is null then raise exception 'The selected delivery does not have a financial charge'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_round.service_date::text, 0));$marker$;
  v_replacement text := $replacement$  if v_charge.id is null then raise exception 'The selected delivery does not have a financial charge'; end if;
  if v_charge.payment_term = 'immediate' then
    if p_action = 'correct' then
      raise exception 'Immediate sales cannot be corrected in place; void payment, cancel delivery, and record a new sale';
    elsif exists (
      select 1 from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = v_charge.id and payment.status = 'active'
    ) then
      raise exception 'Void the active immediate-sale receipt before cancelling its delivery';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_round.service_date::text, 0));$replacement$;
begin
  select pg_get_functiondef(
    'public.apply_open_delivery_correction(uuid,text,jsonb,public.shop_round_status,text,text,uuid,uuid)'::regprocedure
  ) into v_definition;
  if position(v_marker in v_definition) = 0 then
    raise exception 'apply_open_delivery_correction does not contain the expected immediate-sale guard marker';
  end if;
  execute replace(v_definition, v_marker, v_replacement);
end;
$guard_immediate_open_correction$;

-- Managers may void an immediate receipt after its delivery period closes, but
-- the exception is deliberately narrow: every allocation must belong to an
-- immediate charge. Other closed-period receipts retain the existing guard.
do $allow_closed_immediate_receipt_void$
declare
  v_definition text;
  v_marker text := $marker$  ) then raise exception 'Payments can only be voided while the delivery period is open';$marker$;
  v_replacement text := $replacement$  ) and not (
    public.current_app_role() in ('round_lead', 'admin')
    and not exists (
      select 1
      from public.payment_allocations immediate_allocation
      join public.delivery_charges immediate_charge on immediate_charge.id = immediate_allocation.charge_id
      where immediate_allocation.payment_id = v_payment.id
        and immediate_charge.payment_term <> 'immediate'
    )
  ) then raise exception 'Payments can only be voided while the delivery period is open';$replacement$;
begin
  select pg_get_functiondef('public.void_payment(uuid,text)'::regprocedure) into v_definition;
  if position(v_marker in v_definition) = 0 then
    raise exception 'void_payment does not contain the expected closed-period marker';
  end if;
  execute replace(v_definition, v_marker, v_replacement);
end;
$allow_closed_immediate_receipt_void$;

-- Once the REC is voided, expose cancellation (never correction) for the
-- latest immediate delivery even if its round/day has closed.
do $allow_closed_immediate_delivery_cancel$
declare
  v_definition text;
  v_marker text := $marker$  v_can_correct := v_blocker is null;
  v_can_cancel := v_blocker is null and public.current_app_role() in ('round_lead', 'admin');$marker$;
  v_replacement text := $replacement$  v_can_correct := v_blocker is null;
  v_can_cancel := v_blocker is null and public.current_app_role() in ('round_lead', 'admin');
  if not v_can_cancel
    and v_event.status = 'active'
    and v_is_latest
    and v_charge.payment_term = 'immediate'
    and public.current_app_role() in ('round_lead', 'admin')
    and exists (
      select 1
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = v_charge.id and payment.status = 'voided'
    )
    and not exists (
      select 1
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = v_charge.id and payment.status = 'active'
    ) then
    v_can_cancel := true;
    v_blocker := null;
  end if;$replacement$;
begin
  select pg_get_functiondef('public.get_delivery_correction_context(uuid)'::regprocedure)
  into v_definition;
  if position(v_marker in v_definition) = 0 then
    raise exception 'get_delivery_correction_context does not contain the expected permission marker';
  end if;
  execute replace(v_definition, v_marker, v_replacement);
end;
$allow_closed_immediate_delivery_cancel$;

-- Active immediate receipts must still be voided first. A voided immediate REC
-- points back to its delivery so the manager can perform the cancellation step.
do $route_immediate_payment_correction_targets$
declare
  v_definition text;
  v_status_marker text := $marker$      and target_payment.status = 'active'
      and charge.status = 'active'$marker$;
  v_status_replacement text := $replacement$      and charge.status = 'active'$replacement$;
  v_balance_marker text := $marker$      and public.effective_delivery_charge_amount(charge.id) > 0
      and balance.allocated_amount >= public.effective_delivery_charge_amount(charge.id)$marker$;
  v_balance_replacement text := $replacement$      and public.effective_delivery_charge_amount(charge.id) > 0
      and (
        (target_payment.status = 'active'
          and charge.payment_term <> 'immediate'
          and balance.allocated_amount >= public.effective_delivery_charge_amount(charge.id))
        or (target_payment.status = 'voided'
          and charge.payment_term = 'immediate'
          and balance.allocated_amount = 0)
      )$replacement$;
  v_role_marker text := $marker$        public.current_app_role() = 'admin'
        or ($marker$;
  v_role_replacement text := $replacement$        public.current_app_role() = 'admin'
        or (target_payment.status = 'voided' and charge.payment_term = 'immediate')
        or ($replacement$;
begin
  select pg_get_functiondef('public.get_payment_correction_targets(uuid)'::regprocedure)
  into v_definition;
  if position(v_status_marker in v_definition) = 0
    or position(v_balance_marker in v_definition) = 0
    or position(v_role_marker in v_definition) = 0 then
    raise exception 'get_payment_correction_targets does not contain the expected routing markers';
  end if;
  v_definition := replace(v_definition, v_status_marker, v_status_replacement);
  v_definition := replace(v_definition, v_balance_marker, v_balance_replacement);
  v_definition := replace(v_definition, v_role_marker, v_role_replacement);
  execute v_definition;
end;
$route_immediate_payment_correction_targets$;

revoke all on table public.document_counters from public, anon, authenticated;
revoke all on table public.delivery_charge_document_snapshots from public, anon, authenticated;
revoke all on function public.next_sales_document_number(text, date) from public, anon, authenticated;
revoke all on function public.build_charge_print_document(uuid) from public, anon, authenticated;
revoke all on function public.capture_charge_print_document() from public, anon, authenticated;
revoke all on function public.protect_charge_print_document() from public, anon, authenticated;
revoke all on function public.require_immediate_sale_receipt() from public, anon, authenticated;
revoke all on function public.can_delete_payment_evidence(uuid, text) from public;
revoke all on function public.reject_immediate_delivery_correction() from public, anon, authenticated;
revoke all on function public.reject_immediate_delivery_adjustment() from public, anon, authenticated;
revoke all on function public.get_charge_print_document(uuid) from public;
revoke all on function public.record_immediate_sale(
  uuid, jsonb, text, timestamptz, public.payment_method, numeric, text, text, numeric, uuid
) from public;
grant execute on function public.get_charge_print_document(uuid) to authenticated;
grant execute on function public.can_delete_payment_evidence(uuid, text) to authenticated;
grant execute on function public.record_immediate_sale(
  uuid, jsonb, text, timestamptz, public.payment_method, numeric, text, text, numeric, uuid
) to authenticated;

notify pgrst, 'reload schema';
