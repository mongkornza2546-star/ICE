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
          (credit_due_rule = 'net_days' and credit_days > 0)
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
  approval_request_id uuid references public.financial_approval_requests(id) on delete restrict,
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

create view public.delivery_charge_balances
with (security_invoker = true)
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
        or exists (
          select 1
          from public.payment_allocations allocation
          where allocation.payment_id = payment.id
            and public.is_financial_charge_visible(allocation.charge_id)
        )
      )
  );
$$;

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

create policy "active users read shop prices" on public.shop_ice_type_prices for select
  using (public.is_active_user());
create policy "admins create shop prices" on public.shop_ice_type_prices for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update shop prices" on public.shop_ice_type_prices for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');

create policy "active users read payment profiles" on public.shop_payment_profiles for select
  using (public.is_active_user());
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
grant execute on function public.is_collection_run_member(uuid) to authenticated;
grant execute on function public.is_financial_charge_visible(uuid) to authenticated;
grant execute on function public.is_payment_visible(uuid) to authenticated;

