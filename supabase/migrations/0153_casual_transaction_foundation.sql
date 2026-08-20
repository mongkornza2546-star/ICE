-- Additive storage foundation for casual-customer sales and free issues.
-- No authenticated write path is exposed here; later migrations add the
-- server-derived RPCs and update the canonical stock/accounting projections.
-- The shared daily_stock_uses extension and loose-use membership are deferred
-- until close v2 can update every reader and legacy write guard atomically.

do $$
begin
  create type public.casual_transaction_kind as enum ('paid', 'free');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.casual_fulfillment_mode as enum ('measured', 'loose');
exception when duplicate_object then null;
end $$;

alter table public.delivery_rounds
  add constraint delivery_rounds_id_service_date_key unique (id, service_date);

create table public.casual_transactions (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  round_id uuid not null,
  source_stock_location_id uuid not null references public.stock_locations(id) on delete restrict,
  ice_type_id uuid not null references public.ice_types(id) on delete restrict,
  transaction_kind public.casual_transaction_kind not null,
  fulfillment_mode public.casual_fulfillment_mode not null,
  quantity numeric,
  sale_amount numeric not null,
  payment_method public.payment_method,
  received_amount numeric,
  change_amount numeric,
  reference_number text,
  evidence_path text,
  note text,
  receipt_number text,
  idempotency_key uuid not null unique,
  request_fingerprint text not null,
  client_recorded_at timestamptz,
  recorded_by uuid not null references public.users(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  status public.financial_record_status not null default 'active',
  voided_by uuid references public.users(id) on delete restrict,
  voided_at timestamptz,
  void_reason text,
  constraint casual_transactions_round_service_date_fk foreign key (round_id, service_date)
    references public.delivery_rounds(id, service_date) on delete restrict,
  constraint casual_transactions_fulfillment_check check (
    (
      fulfillment_mode = 'measured'
      and quantity > 0
      and quantity < 100000000000
      and mod(quantity, 0.5) = 0
    )
    or (fulfillment_mode = 'loose' and quantity is null)
  ),
  constraint casual_transactions_money_check check (
    sale_amount = trunc(sale_amount)
    and abs(sale_amount) < 1000000000000
    and (
      received_amount is null
      or (
        received_amount = trunc(received_amount)
        and abs(received_amount) < 1000000000000
      )
    )
    and (
      change_amount is null
      or (
        change_amount = trunc(change_amount)
        and abs(change_amount) < 1000000000000
      )
    )
  ),
  constraint casual_transactions_payment_check check (
    (
      transaction_kind = 'paid'
      and sale_amount > 0
      and payment_method is not null
      and received_amount is not null
      and change_amount is not null
      and nullif(trim(coalesce(receipt_number, '')), '') is not null
      and (
        (
          payment_method = 'cash'
          and received_amount >= sale_amount
          and change_amount = received_amount - sale_amount
        )
        or (
          payment_method in ('bank_transfer', 'qr')
          and received_amount = sale_amount
          and change_amount = 0
          and nullif(trim(coalesce(evidence_path, '')), '') is not null
        )
      )
    )
    or (
      transaction_kind = 'free'
      and sale_amount = 0
      and payment_method is null
      and received_amount is null
      and change_amount is null
      and reference_number is null
      and evidence_path is null
      and receipt_number is null
    )
  ),
  constraint casual_transactions_fingerprint_check check (
    nullif(trim(request_fingerprint), '') is not null
  ),
  constraint casual_transactions_status_check check (
    (
      status = 'active'
      and voided_by is null
      and voided_at is null
      and void_reason is null
    )
    or (
      status = 'voided'
      and voided_by is not null
      and voided_at is not null
      and nullif(trim(coalesce(void_reason, '')), '') is not null
    )
  )
);

create unique index casual_transactions_paid_receipt_number_idx
  on public.casual_transactions (receipt_number)
  where transaction_kind = 'paid';
create index casual_transactions_service_status_user_idx
  on public.casual_transactions (service_date, status, recorded_by);
create index casual_transactions_stock_projection_idx
  on public.casual_transactions (
    service_date,
    status,
    source_stock_location_id,
    ice_type_id,
    fulfillment_mode
  );

create table public.casual_receipt_snapshots (
  transaction_id uuid primary key references public.casual_transactions(id) on delete restrict,
  receipt_data jsonb not null check (jsonb_typeof(receipt_data) = 'object'),
  created_at timestamptz not null default now()
);

create table public.casual_refund_confirmations (
  transaction_id uuid primary key references public.casual_transactions(id) on delete restrict,
  refunded_amount numeric not null,
  refund_method public.payment_method not null,
  reference_number text,
  evidence_path text,
  confirmed_by uuid not null references public.users(id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  idempotency_key uuid not null unique,
  request_fingerprint text not null,
  constraint casual_refund_confirmations_amount_check check (
    refunded_amount > 0
    and refunded_amount = trunc(refunded_amount)
    and refunded_amount < 1000000000000
  ),
  constraint casual_refund_confirmations_evidence_check check (
    refund_method = 'cash'
    or nullif(trim(coalesce(evidence_path, '')), '') is not null
  ),
  constraint casual_refund_confirmations_fingerprint_check check (
    nullif(trim(request_fingerprint), '') is not null
  )
);

create function public.enforce_casual_receipt_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_transaction_kind public.casual_transaction_kind;
  v_receipt_number text;
begin
  select transaction.transaction_kind, transaction.receipt_number
  into v_transaction_kind, v_receipt_number
  from public.casual_transactions transaction
  where transaction.id = new.transaction_id;

  if v_transaction_kind <> 'paid' then
    raise exception 'Only paid casual transactions can have receipt snapshots';
  elsif new.receipt_data ->> 'receipt_number' is distinct from v_receipt_number then
    raise exception 'The receipt snapshot number must match the casual transaction';
  end if;

  return new;
end;
$$;

create trigger casual_receipt_snapshots_validate
before insert on public.casual_receipt_snapshots
for each row execute function public.enforce_casual_receipt_snapshot();

create function public.require_casual_paid_receipt_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.transaction_kind = 'paid' and not exists (
    select 1
    from public.casual_receipt_snapshots snapshot
    where snapshot.transaction_id = new.id
      and snapshot.receipt_data ->> 'receipt_number' = new.receipt_number
  ) then
    raise exception 'Paid casual transactions require one matching receipt snapshot';
  end if;

  return null;
end;
$$;

create constraint trigger casual_paid_transactions_require_receipt_snapshot
after insert on public.casual_transactions
deferrable initially deferred
for each row execute function public.require_casual_paid_receipt_snapshot();

create function public.enforce_casual_refund_confirmation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_transaction public.casual_transactions%rowtype;
begin
  select transaction.*
  into v_transaction
  from public.casual_transactions transaction
  where transaction.id = new.transaction_id;

  if v_transaction.id is null then
    raise exception 'The casual transaction does not exist';
  elsif v_transaction.transaction_kind <> 'paid' then
    raise exception 'Only paid casual transactions can have refund confirmations';
  elsif v_transaction.status <> 'active' then
    raise exception 'Only active casual transactions can be refund-confirmed';
  elsif new.refunded_amount <> v_transaction.sale_amount then
    raise exception 'The confirmed refund must equal the casual sale amount';
  end if;

  return new;
end;
$$;

create trigger casual_refund_confirmations_validate
before insert on public.casual_refund_confirmations
for each row execute function public.enforce_casual_refund_confirmation();

create function public.protect_casual_transaction_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Casual transactions cannot be deleted';
  elsif to_jsonb(new) - array['status', 'voided_by', 'voided_at', 'void_reason']
      <> to_jsonb(old) - array['status', 'voided_by', 'voided_at', 'void_reason'] then
    raise exception 'Issued casual transaction details are immutable';
  elsif old.status <> 'active' or new.status <> 'voided' then
    raise exception 'Casual transactions can only transition from active to voided';
  elsif new.transaction_kind = 'paid' and not exists (
    select 1
    from public.casual_refund_confirmations confirmation
    where confirmation.transaction_id = new.id
      and confirmation.refunded_amount = new.sale_amount
  ) then
    raise exception 'Paid casual transactions require a full refund confirmation before voiding';
  end if;

  return new;
end;
$$;

create trigger casual_transactions_protect_history
before update or delete on public.casual_transactions
for each row execute function public.protect_casual_transaction_history();

create function public.protect_casual_immutable_row()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Casual receipt and refund records are immutable';
end;
$$;

create trigger casual_receipt_snapshots_immutable
before update or delete on public.casual_receipt_snapshots
for each row execute function public.protect_casual_immutable_row();

create trigger casual_refund_confirmations_immutable
before update or delete on public.casual_refund_confirmations
for each row execute function public.protect_casual_immutable_row();

alter table public.casual_transactions enable row level security;
alter table public.casual_receipt_snapshots enable row level security;
alter table public.casual_refund_confirmations enable row level security;

create policy "authorized users read casual transactions"
on public.casual_transactions for select
using (
  public.is_active_user()
  and (
    recorded_by = auth.uid()
    or public.current_app_role() in ('admin', 'round_lead')
  )
);

create policy "authorized users read casual receipt snapshots"
on public.casual_receipt_snapshots for select
using (
  exists (
    select 1
    from public.casual_transactions transaction
    where transaction.id = transaction_id
      and public.is_active_user()
      and (
        transaction.recorded_by = auth.uid()
        or public.current_app_role() in ('admin', 'round_lead')
      )
  )
);

create policy "authorized users read casual refund confirmations"
on public.casual_refund_confirmations for select
using (
  exists (
    select 1
    from public.casual_transactions transaction
    where transaction.id = transaction_id
      and public.is_active_user()
      and (
        transaction.recorded_by = auth.uid()
        or public.current_app_role() in ('admin', 'round_lead')
      )
  )
);

revoke all on table public.casual_transactions from anon, authenticated;
revoke all on table public.casual_receipt_snapshots from anon, authenticated;
revoke all on table public.casual_refund_confirmations from anon, authenticated;
grant select on table public.casual_transactions to authenticated;
grant select on table public.casual_receipt_snapshots to authenticated;
grant select on table public.casual_refund_confirmations to authenticated;

revoke all on function public.enforce_casual_receipt_snapshot() from public, anon, authenticated;
revoke all on function public.require_casual_paid_receipt_snapshot() from public, anon, authenticated;
revoke all on function public.enforce_casual_refund_confirmation() from public, anon, authenticated;
revoke all on function public.protect_casual_transaction_history() from public, anon, authenticated;
revoke all on function public.protect_casual_immutable_row() from public, anon, authenticated;

comment on table public.casual_transactions is
  'Operational source for casual paid and free transactions; writes are RPC-only.';
comment on table public.casual_receipt_snapshots is
  'Immutable receipt content captured when a paid casual transaction is issued.';
comment on table public.casual_refund_confirmations is
  'Immutable evidence that a paid casual transaction was fully refunded before voiding.';

notify pgrst, 'reload schema';
