-- POS financial foundation: effective-dated prices, shop payment profiles,
-- delivery charge snapshots, payments, collection runs, and approvals.
-- Existing delivery rows intentionally remain unpriced and outside this ledger.

create extension if not exists btree_gist;

do $$
begin
  create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.financial_payment_status as enum ('unpaid', 'partial', 'paid');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.price_source as enum ('standard', 'shop_override');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.credit_due_rule as enum ('net_days', 'end_of_month');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.financial_record_status as enum ('active', 'voided');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.collection_run_status as enum ('open', 'closed');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.financial_approval_kind as enum ('outstanding_balance', 'credit_limit');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.financial_approval_status as enum ('pending', 'approved', 'rejected', 'consumed');
exception when duplicate_object then null;
end $$;

create table public.ice_type_prices (
  id uuid primary key default gen_random_uuid(),
  ice_type_id uuid not null references public.ice_types(id) on delete restrict,
  unit_price numeric(12,2) not null check (unit_price > 0),
  valid_from date not null,
  valid_to date,
  is_active boolean not null default true,
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  exclude using gist (
    ice_type_id with =,
    daterange(valid_from, coalesce(valid_to + 1, 'infinity'::date), '[)') with &&
  ) where (is_active)
);

create table public.shop_ice_type_prices (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  ice_type_id uuid not null references public.ice_types(id) on delete restrict,
  unit_price numeric(12,2) not null check (unit_price > 0),
  valid_from date not null,
  valid_to date,
  is_active boolean not null default true,
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  exclude using gist (
    shop_id with =,
    ice_type_id with =,
    daterange(valid_from, coalesce(valid_to + 1, 'infinity'::date), '[)') with &&
  ) where (is_active)
);

create table public.shop_payment_profiles (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null unique references public.shops(id) on delete restrict,
  allowed_payment_terms public.payment_term[] not null,
  default_payment_term public.payment_term not null,
  allowed_payment_methods public.payment_method[] not null,
  default_payment_method public.payment_method not null,
  cash_reference_required boolean not null default false,
  cash_evidence_required boolean not null default false,
  bank_transfer_reference_required boolean not null default true,
  bank_transfer_evidence_required boolean not null default false,
  qr_reference_required boolean not null default true,
  qr_evidence_required boolean not null default false,
  allow_outstanding boolean not null default false,
  credit_due_rule public.credit_due_rule,
  credit_days integer,
  credit_limit numeric(12,2),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(allowed_payment_terms) > 0),
  check (default_payment_term = any(allowed_payment_terms)),
  check (cardinality(allowed_payment_methods) > 0),
  check (default_payment_method = any(allowed_payment_methods)),
  check (credit_limit is null or credit_limit >= 0),
  check (
    case
      when 'credit' = any(allowed_payment_terms) then
        cardinality(allowed_payment_terms) = 1
        and allow_outstanding
        and credit_due_rule is not null
        and (
          (credit_due_rule = 'net_days' and credit_days is not null and credit_days > 0)
          or (credit_due_rule = 'end_of_month' and credit_days is null)
        )
      else
        credit_due_rule is null and credit_days is null and credit_limit is null
    end
  )
);

-- Nullable snapshots preserve every pre-financial delivery as legacy unpriced.
alter table public.delivery_events
  add column request_fingerprint text;

alter table public.delivery_items
  add column unit_price numeric(12,2) check (unit_price > 0),
  add column line_total numeric(12,2)
    generated always as ((quantity * unit_price)::numeric(12,2)) stored,
  add column price_source public.price_source,
  add column price_source_id uuid,
  add constraint delivery_items_price_snapshot_complete check (
    (unit_price is null and price_source is null and price_source_id is null)
    or (unit_price is not null and price_source is not null and price_source_id is not null)
  );

create table public.financial_approval_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  round_stop_id uuid not null references public.round_stops(id) on delete restrict,
  kind public.financial_approval_kind not null,
  requested_amount numeric(12,2) not null check (requested_amount > 0),
  reason text not null check (nullif(trim(reason), '') is not null),
  request_fingerprint text not null,
  status public.financial_approval_status not null default 'pending',
  requested_by uuid not null references public.users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  decided_by uuid references public.users(id) on delete restrict,
  decided_at timestamptz,
  decision_reason text,
  consumed_by_delivery_event_id uuid unique references public.delivery_events(id) on delete restrict,
  consumed_at timestamptz,
  check (
    (status = 'pending' and decided_by is null and decided_at is null
      and decision_reason is null and consumed_by_delivery_event_id is null and consumed_at is null)
    or (status in ('approved', 'rejected') and decided_by is not null and decided_at is not null
      and (status = 'approved' or nullif(trim(coalesce(decision_reason, '')), '') is not null)
      and consumed_by_delivery_event_id is null and consumed_at is null)
    or (status = 'consumed' and decided_by is not null and decided_at is not null
      and consumed_by_delivery_event_id is not null and consumed_at is not null)
  )
);

create unique index financial_approval_pending_fingerprint_idx
  on public.financial_approval_requests (requested_by, request_fingerprint)
  where status = 'pending';

create table public.delivery_charges (
  id uuid primary key default gen_random_uuid(),
  delivery_event_id uuid not null unique references public.delivery_events(id) on delete restrict,
  shop_id uuid not null references public.shops(id) on delete restrict,
  service_date date not null,
  payment_term public.payment_term not null,
  original_amount numeric(12,2) not null check (original_amount > 0),
  due_date date,
  approval_request_id uuid unique references public.financial_approval_requests(id) on delete restrict,
  status public.financial_record_status not null default 'active',
  created_at timestamptz not null default now(),
  voided_by uuid references public.users(id) on delete restrict,
  voided_at timestamptz,
  void_reason text,
  check (
    (payment_term = 'credit' and due_date is not null and due_date >= service_date)
    or (payment_term <> 'credit' and due_date is null)
  ),
  check (
    (status = 'active' and voided_by is null and voided_at is null and void_reason is null)
    or (status = 'voided' and voided_by is not null and voided_at is not null
      and nullif(trim(coalesce(void_reason, '')), '') is not null)
  )
);

create table public.collection_runs (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  status public.collection_run_status not null default 'open',
  opened_by uuid not null references public.users(id) on delete restrict,
  opened_at timestamptz not null default now(),
  closed_by uuid references public.users(id) on delete restrict,
  closed_at timestamptz,
  check (
    (status = 'open' and closed_by is null and closed_at is null)
    or (status = 'closed' and closed_by is not null and closed_at is not null)
  )
);

create unique index collection_runs_one_open_per_day_idx
  on public.collection_runs (service_date)
  where status = 'open';

create table public.collection_run_members (
  collection_run_id uuid not null references public.collection_runs(id) on delete restrict,
  user_id uuid not null references public.users(id) on delete restrict,
  primary key (collection_run_id, user_id)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  collection_run_id uuid references public.collection_runs(id) on delete restrict,
  payment_method public.payment_method not null,
  received_amount numeric(12,2) not null check (received_amount > 0),
  allocated_amount numeric(12,2) not null check (allocated_amount > 0),
  change_amount numeric(12,2) not null default 0 check (change_amount >= 0),
  reference_number text,
  evidence_path text,
  idempotency_key uuid not null unique,
  request_fingerprint text not null,
  status public.financial_record_status not null default 'active',
  recorded_by uuid not null references public.users(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  voided_by uuid references public.users(id) on delete restrict,
  voided_at timestamptz,
  void_reason text,
  check (received_amount = allocated_amount + change_amount),
  check (payment_method = 'cash' or change_amount = 0),
  check (
    (status = 'active' and voided_by is null and voided_at is null and void_reason is null)
    or (status = 'voided' and voided_by is not null and voided_at is not null
      and nullif(trim(coalesce(void_reason, '')), '') is not null)
  )
);

create table public.payment_allocations (
  payment_id uuid not null references public.payments(id) on delete restrict,
  charge_id uuid not null references public.delivery_charges(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  primary key (payment_id, charge_id)
);

create or replace function public.assert_payment_allocation_integrity(target_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_declared_amount numeric(12,2);
  v_actual_amount numeric(12,2);
  v_shop_id uuid;
begin
  select payment.shop_id
  into v_shop_id
  from public.payments payment
  where payment.id = target_payment_id;

  if not found then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

  select payment.allocated_amount
  into v_declared_amount
  from public.payments payment
  where payment.id = target_payment_id;

  if not found then
    return;
  end if;

  select coalesce(sum(allocation.amount), 0)::numeric(12,2)
  into v_actual_amount
  from public.payment_allocations allocation
  where allocation.payment_id = target_payment_id;

  if v_actual_amount <> v_declared_amount then
    raise exception 'Payment allocated amount must equal its allocation rows';
  end if;

  if exists (
    select 1
    from public.payment_allocations allocation
    join public.delivery_charges charge on charge.id = allocation.charge_id
    where allocation.payment_id = target_payment_id
      and charge.shop_id <> v_shop_id
  ) then
    raise exception 'A payment can only allocate charges for the same shop';
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
  v_original_amount numeric(12,2);
  v_allocated_amount numeric(12,2);
  v_status public.financial_record_status;
  v_shop_id uuid;
begin
  select charge.shop_id
  into v_shop_id
  from public.delivery_charges charge
  where charge.id = target_charge_id;

  if not found then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

  select charge.original_amount, charge.status
  into v_original_amount, v_status
  from public.delivery_charges charge
  where charge.id = target_charge_id;

  if not found then
    return;
  end if;

  select coalesce(sum(allocation.amount), 0)::numeric(12,2)
  into v_allocated_amount
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id
  where allocation.charge_id = target_charge_id
    and payment.status = 'active';

  if v_status = 'voided' and v_allocated_amount > 0 then
    raise exception 'Void active payments before voiding their delivery charge';
  elsif v_allocated_amount > v_original_amount then
    raise exception 'Active payment allocations cannot exceed the original charge amount';
  end if;
end;
$$;

create or replace function public.check_payment_allocation_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_related_id uuid;
begin
  if tg_table_name = 'payments' then
    perform public.assert_payment_allocation_integrity(
      case when tg_op = 'DELETE' then old.id else new.id end
    );

    for v_related_id in
      select distinct allocation.charge_id
      from public.payment_allocations allocation
      where allocation.payment_id = case when tg_op = 'DELETE' then old.id else new.id end
    loop
      perform public.assert_charge_allocation_integrity(v_related_id);
    end loop;
  elsif tg_table_name = 'delivery_charges' then
    perform public.assert_charge_allocation_integrity(
      case when tg_op = 'DELETE' then old.id else new.id end
    );

    for v_related_id in
      select distinct allocation.payment_id
      from public.payment_allocations allocation
      where allocation.charge_id = case when tg_op = 'DELETE' then old.id else new.id end
    loop
      perform public.assert_payment_allocation_integrity(v_related_id);
    end loop;
  else
    if tg_op <> 'INSERT' then
      perform public.assert_payment_allocation_integrity(old.payment_id);
      perform public.assert_charge_allocation_integrity(old.charge_id);
    end if;
    if tg_op <> 'DELETE' then
      perform public.assert_payment_allocation_integrity(new.payment_id);
      perform public.assert_charge_allocation_integrity(new.charge_id);
    end if;
  end if;

  return null;
end;
$$;

create constraint trigger payments_allocation_integrity
  after insert or update or delete on public.payments
  deferrable initially deferred
  for each row execute function public.check_payment_allocation_integrity();

create constraint trigger payment_allocations_integrity
  after insert or update or delete on public.payment_allocations
  deferrable initially deferred
  for each row execute function public.check_payment_allocation_integrity();

create constraint trigger delivery_charges_allocation_integrity
  after insert or update or delete on public.delivery_charges
  deferrable initially deferred
  for each row execute function public.check_payment_allocation_integrity();

create or replace function public.assert_financial_approval_integrity(target_approval_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.financial_approval_status;
  v_shop_id uuid;
  v_delivery_event_id uuid;
begin
  select approval.status, approval.shop_id, approval.consumed_by_delivery_event_id
  into v_status, v_shop_id, v_delivery_event_id
  from public.financial_approval_requests approval
  where approval.id = target_approval_id;

  if not found then
    return;
  end if;

  if v_status = 'consumed' then
    if not exists (
      select 1
      from public.delivery_charges charge
      where charge.approval_request_id = target_approval_id
        and charge.delivery_event_id = v_delivery_event_id
        and charge.shop_id = v_shop_id
    ) then
      raise exception 'A consumed approval must match exactly one delivery charge';
    end if;
  elsif exists (
    select 1
    from public.delivery_charges charge
    where charge.approval_request_id = target_approval_id
  ) then
    raise exception 'A delivery charge can only use a consumed approval';
  end if;
end;
$$;

create or replace function public.check_financial_approval_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'financial_approval_requests' then
    perform public.assert_financial_approval_integrity(
      case when tg_op = 'DELETE' then old.id else new.id end
    );
  else
    if tg_op <> 'INSERT' and old.approval_request_id is not null then
      perform public.assert_financial_approval_integrity(old.approval_request_id);
    end if;
    if tg_op <> 'DELETE' and new.approval_request_id is not null then
      perform public.assert_financial_approval_integrity(new.approval_request_id);
    end if;
  end if;

  return null;
end;
$$;

create constraint trigger financial_approval_requests_integrity
  after insert or update or delete on public.financial_approval_requests
  deferrable initially deferred
  for each row execute function public.check_financial_approval_integrity();

create constraint trigger delivery_charges_approval_integrity
  after insert or update or delete on public.delivery_charges
  deferrable initially deferred
  for each row execute function public.check_financial_approval_integrity();

create or replace function public.protect_financial_delivery_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.corrects_event_id is not null
    and (tg_op = 'INSERT' or new.corrects_event_id is distinct from old.corrects_event_id)
    and exists (
      select 1
      from public.delivery_charges charge
      where charge.delivery_event_id = new.corrects_event_id
    ) then
    raise exception 'Financial delivery corrections require the financial-aware revision RPC';
  end if;

  if tg_op = 'UPDATE'
    and old.status = 'active' and new.status = 'cancelled' and exists (
    select 1
    from public.delivery_charges charge
    where charge.delivery_event_id = new.id and charge.status = 'active'
  ) then
    if exists (
      select 1
      from public.delivery_charges charge
      join public.payment_allocations allocation on allocation.charge_id = charge.id
      join public.payments payment on payment.id = allocation.payment_id
      where charge.delivery_event_id = new.id
        and charge.status = 'active'
        and payment.status = 'active'
    ) then
      raise exception 'Void active payment allocations before cancelling this delivery';
    end if;

    update public.delivery_charges
    set status = 'voided',
        voided_by = new.cancelled_by,
        voided_at = new.cancelled_at,
        void_reason = new.cancellation_reason
    where delivery_event_id = new.id and status = 'active';
  elsif tg_op = 'UPDATE'
    and old.status = 'cancelled' and new.status = 'active' and exists (
      select 1
      from public.delivery_charges charge
      where charge.delivery_event_id = new.id
    ) then
    raise exception 'A financial delivery cannot be reactivated after cancellation';
  end if;

  return new;
end;
$$;

create trigger delivery_events_protect_financial_revision
  before insert or update of status, corrects_event_id on public.delivery_events
  for each row execute function public.protect_financial_delivery_revision();

create index ice_type_prices_lookup_idx
  on public.ice_type_prices (ice_type_id, valid_from, valid_to) where is_active;
create index shop_ice_type_prices_lookup_idx
  on public.shop_ice_type_prices (shop_id, ice_type_id, valid_from, valid_to) where is_active;
create index delivery_charges_shop_day_idx
  on public.delivery_charges (shop_id, service_date) where status = 'active';
create index payments_shop_recorded_idx
  on public.payments (shop_id, recorded_at desc) where status = 'active';
create index payment_allocations_charge_idx
  on public.payment_allocations (charge_id);
create index financial_approvals_shop_status_idx
  on public.financial_approval_requests (shop_id, status, requested_at desc);

create or replace function public.is_financial_charge_visible(target_charge_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and exists (
    select 1
    from public.delivery_charges charge
    where charge.id = target_charge_id
      and (
        public.current_app_role() in ('admin', 'round_lead')
        or public.is_delivery_event_visible(charge.delivery_event_id)
      )
  );
$$;

create view public.delivery_charge_balances
with (security_invoker = true, security_barrier = true)
as
select
  charge.id as charge_id,
  charge.delivery_event_id,
  charge.shop_id,
  charge.service_date,
  charge.payment_term,
  charge.original_amount,
  coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2)
    as allocated_amount,
  greatest(
    charge.original_amount
      - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0),
    0
  )::numeric(12,2) as outstanding_amount,
  case
    when coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0) <= 0
      then 'unpaid'::public.financial_payment_status
    when coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)
      < charge.original_amount
      then 'partial'::public.financial_payment_status
    else 'paid'::public.financial_payment_status
  end as payment_status,
  charge.due_date,
  charge.created_at
from public.delivery_charges charge
left join public.payment_allocations allocation on allocation.charge_id = charge.id
left join public.payments payment on payment.id = allocation.payment_id
where charge.status = 'active'
  and public.is_financial_charge_visible(charge.id)
group by charge.id;

create or replace function public.is_collection_run_member(target_collection_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and exists (
    select 1
    from public.collection_run_members member
    where member.collection_run_id = target_collection_run_id
      and member.user_id = auth.uid()
  );
$$;

create or replace function public.is_payment_visible(target_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and exists (
    select 1
    from public.payments payment
    where payment.id = target_payment_id
      and (
        public.current_app_role() in ('admin', 'round_lead')
        or payment.recorded_by = auth.uid()
        or public.is_collection_run_member(payment.collection_run_id)
      )
  );
$$;

create or replace function public.is_shop_financial_context_visible(target_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and (
    public.current_app_role() in ('admin', 'round_lead')
    or exists (
      select 1
      from public.round_stops stop
      join public.delivery_round_members member on member.round_id = stop.round_id
      where stop.shop_id = target_shop_id
        and member.user_id = auth.uid()
    )
  );
$$;

create or replace function public.protect_effective_price_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.price_source;
  v_is_used boolean;
begin
  v_source := case
    when tg_table_name = 'ice_type_prices' then 'standard'::public.price_source
    else 'shop_override'::public.price_source
  end;

  select exists (
    select 1
    from public.delivery_items item
    where item.price_source = v_source
      and item.price_source_id = old.id
  ) into v_is_used;

  if v_is_used and (
    new.unit_price is distinct from old.unit_price
    or new.ice_type_id is distinct from old.ice_type_id
    or new.valid_from is distinct from old.valid_from
    or new.is_active is distinct from old.is_active
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or (
      tg_table_name = 'shop_ice_type_prices'
      and to_jsonb(new) ->> 'shop_id' is distinct from to_jsonb(old) ->> 'shop_id'
    )
  ) then
    raise exception 'Used effective price history is immutable; create a new price row';
  end if;

  if v_is_used and new.valid_to is distinct from old.valid_to and new.valid_to is not null
    and exists (
      select 1
      from public.delivery_items item
      join public.delivery_charges charge on charge.delivery_event_id = item.delivery_event_id
      where item.price_source = v_source
        and item.price_source_id = old.id
        and charge.service_date > new.valid_to
    ) then
    raise exception 'An effective price cannot end before a delivery that used it';
  end if;

  return new;
end;
$$;

create trigger ice_type_prices_protect_history
  before update on public.ice_type_prices
  for each row execute function public.protect_effective_price_history();
create trigger shop_ice_type_prices_protect_history
  before update on public.shop_ice_type_prices
  for each row execute function public.protect_effective_price_history();

create trigger ice_type_prices_updated_at
  before update on public.ice_type_prices
  for each row execute function public.set_updated_at();
create trigger shop_ice_type_prices_updated_at
  before update on public.shop_ice_type_prices
  for each row execute function public.set_updated_at();
create trigger shop_payment_profiles_updated_at
  before update on public.shop_payment_profiles
  for each row execute function public.set_updated_at();

alter table public.ice_type_prices enable row level security;
alter table public.shop_ice_type_prices enable row level security;
alter table public.shop_payment_profiles enable row level security;
alter table public.financial_approval_requests enable row level security;
alter table public.delivery_charges enable row level security;
alter table public.collection_runs enable row level security;
alter table public.collection_run_members enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;

create policy "active users read standard prices" on public.ice_type_prices for select
  using (public.is_active_user());
create policy "admins create standard prices" on public.ice_type_prices for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update standard prices" on public.ice_type_prices for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');

create policy "assigned users read shop prices" on public.shop_ice_type_prices for select
  using (public.is_shop_financial_context_visible(shop_id));
create policy "admins create shop prices" on public.shop_ice_type_prices for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update shop prices" on public.shop_ice_type_prices for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');

create policy "assigned users read payment profiles" on public.shop_payment_profiles for select
  using (public.is_shop_financial_context_visible(shop_id));
create policy "admins create payment profiles" on public.shop_payment_profiles for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update payment profiles" on public.shop_payment_profiles for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');

create policy "requesters or managers read financial approvals"
  on public.financial_approval_requests for select
  using (
    public.is_active_user()
    and (requested_by = auth.uid() or public.current_app_role() in ('admin', 'round_lead'))
  );

create policy "assigned users read delivery charges" on public.delivery_charges for select
  using (public.is_financial_charge_visible(id));

create policy "assigned users read collection runs" on public.collection_runs for select
  using (
    public.current_app_role() in ('admin', 'round_lead')
    or public.is_collection_run_member(id)
  );
create policy "assigned users read collection members" on public.collection_run_members for select
  using (
    public.current_app_role() in ('admin', 'round_lead')
    or user_id = auth.uid()
  );

create policy "assigned users read payments" on public.payments for select
  using (public.is_payment_visible(id));
create policy "assigned users read payment allocations" on public.payment_allocations for select
  using (
    public.is_payment_visible(payment_id)
    or public.is_financial_charge_visible(charge_id)
  );

revoke all on function public.is_collection_run_member(uuid) from public;
revoke all on function public.is_financial_charge_visible(uuid) from public;
revoke all on function public.is_payment_visible(uuid) from public;
revoke all on function public.is_shop_financial_context_visible(uuid) from public;
revoke all on function public.assert_payment_allocation_integrity(uuid) from public;
revoke all on function public.assert_charge_allocation_integrity(uuid) from public;
revoke all on function public.assert_financial_approval_integrity(uuid) from public;
grant execute on function public.is_collection_run_member(uuid) to authenticated;
grant execute on function public.is_financial_charge_visible(uuid) to authenticated;
grant execute on function public.is_payment_visible(uuid) to authenticated;
grant execute on function public.is_shop_financial_context_visible(uuid) to authenticated;
