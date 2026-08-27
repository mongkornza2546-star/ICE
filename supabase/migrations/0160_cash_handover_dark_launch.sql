-- Daily-close cash reconciliation foundation and dark-launch comparison.
-- The feature remains disabled until enabled_from_service_date is configured.

create type public.daily_close_reconciliation_issue_type as enum (
  'CASH_VARIANCE',
  'STOCK_VARIANCE'
);

create type public.daily_close_reconciliation_issue_status as enum (
  'open',
  'resolved'
);

create table public.daily_close_reconciliation_configuration (
  singleton boolean primary key default true check (singleton),
  enabled_from_service_date date
);

insert into public.daily_close_reconciliation_configuration (
  singleton, enabled_from_service_date
) values (true, null);

create table public.daily_close_reconciliation_requests (
  idempotency_key uuid primary key,
  service_date date not null unique,
  request_fingerprint text not null check (nullif(trim(request_fingerprint), '') is not null),
  recorded_by uuid not null references public.users(id) on delete restrict,
  recorded_at timestamptz not null default now()
);

create table public.daily_close_employee_snapshots (
  service_date date not null,
  employee_id uuid not null references public.users(id) on delete restrict,
  expected_cash_amount numeric(12,2) not null check (expected_cash_amount >= 0),
  actual_cash_amount numeric(12,2) not null check (actual_cash_amount >= 0),
  cash_variance_amount numeric(12,2)
    generated always as (actual_cash_amount - expected_cash_amount) stored,
  cash_reason text,
  recorded_by uuid not null references public.users(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  request_idempotency_key uuid not null
    references public.daily_close_reconciliation_requests(idempotency_key) on delete restrict,
  primary key (service_date, employee_id),
  check (
    actual_cash_amount = expected_cash_amount
    or nullif(trim(coalesce(cash_reason, '')), '') is not null
  )
);

create table public.daily_close_payment_items (
  service_date date not null,
  employee_id uuid not null,
  payment_id uuid not null references public.payments(id) on delete restrict,
  allocated_amount numeric(12,2) not null check (allocated_amount > 0),
  payment_fingerprint text not null check (nullif(trim(payment_fingerprint), '') is not null),
  primary key (service_date, employee_id, payment_id),
  foreign key (service_date, employee_id)
    references public.daily_close_employee_snapshots(service_date, employee_id) on delete restrict
);

create table public.daily_close_reconciliation_issues (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  employee_id uuid references public.users(id) on delete restrict,
  issue_type public.daily_close_reconciliation_issue_type not null,
  source_entity text not null,
  source_id uuid not null,
  expected_value numeric(12,2) not null,
  actual_value numeric(12,2) not null,
  variance_value numeric(12,2) not null,
  reason text not null check (nullif(trim(reason), '') is not null),
  status public.daily_close_reconciliation_issue_status not null default 'open',
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  resolved_by uuid references public.users(id) on delete restrict,
  resolved_at timestamptz,
  resolution_note text,
  external_reference text,
  check (variance_value = actual_value - expected_value),
  check (
    (status = 'open' and resolved_by is null and resolved_at is null
      and resolution_note is null and external_reference is null)
    or
    (status = 'resolved' and resolved_by is not null and resolved_at is not null
      and nullif(trim(coalesce(resolution_note, '')), '') is not null)
  )
);

create unique index daily_close_cash_variance_one_per_employee_idx
  on public.daily_close_reconciliation_issues (service_date, employee_id)
  where issue_type = 'CASH_VARIANCE';
create unique index daily_close_stock_variance_one_per_ice_type_idx
  on public.daily_close_reconciliation_issues (service_date, source_id)
  where issue_type = 'STOCK_VARIANCE';
create index daily_close_reconciliation_issues_queue_idx
  on public.daily_close_reconciliation_issues (status, service_date desc, created_at desc);

create function public.guard_daily_close_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Daily close snapshots cannot be changed';
end;
$$;

create trigger daily_close_requests_are_immutable
before update or delete on public.daily_close_reconciliation_requests
for each row execute function public.guard_daily_close_snapshot();
create trigger daily_close_employee_snapshots_are_immutable
before update or delete on public.daily_close_employee_snapshots
for each row execute function public.guard_daily_close_snapshot();
create trigger daily_close_payment_items_are_immutable
before update or delete on public.daily_close_payment_items
for each row execute function public.guard_daily_close_snapshot();

alter table public.daily_close_reconciliation_configuration enable row level security;
alter table public.daily_close_reconciliation_requests enable row level security;
alter table public.daily_close_employee_snapshots enable row level security;
alter table public.daily_close_payment_items enable row level security;
alter table public.daily_close_reconciliation_issues enable row level security;

create policy "managers read daily close configuration"
  on public.daily_close_reconciliation_configuration for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "managers read daily close requests"
  on public.daily_close_reconciliation_requests for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "managers read daily close employee snapshots"
  on public.daily_close_employee_snapshots for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "managers read daily close payment items"
  on public.daily_close_payment_items for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));
create policy "managers read daily close issues"
  on public.daily_close_reconciliation_issues for select
  using (public.is_active_user() and public.current_app_role() in ('admin', 'round_lead'));

revoke all on table public.daily_close_reconciliation_configuration from public, authenticated;
revoke all on table public.daily_close_reconciliation_requests from public, authenticated;
revoke all on table public.daily_close_employee_snapshots from public, authenticated;
revoke all on table public.daily_close_payment_items from public, authenticated;
revoke all on table public.daily_close_reconciliation_issues from public, authenticated;
grant select on table public.daily_close_reconciliation_configuration to authenticated;
grant select on table public.daily_close_reconciliation_requests to authenticated;
grant select on table public.daily_close_employee_snapshots to authenticated;
grant select on table public.daily_close_payment_items to authenticated;
grant select on table public.daily_close_reconciliation_issues to authenticated;
revoke all on function public.guard_daily_close_snapshot() from public, authenticated;

create function public.get_daily_close_cash_dark_launch_summary(
  p_service_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view daily close reconciliation';
  elsif p_service_date is null then
    raise exception 'Service date is required';
  end if;

  with relevant as materialized (
    select payment.*
    from public.payments payment
    left join public.collection_runs run on run.id = payment.collection_run_id
    where coalesce(
      run.service_date,
      (payment.recorded_at at time zone 'Asia/Bangkok')::date
    ) = p_service_date
      and payment.status = 'active'
      and payment.payment_method = 'cash'
  )
  select jsonb_build_object(
    'service_date', p_service_date,
    'courier_allocated_cash', coalesce(sum(allocated_amount)
      filter (where recorded_role = 'courier'), 0),
    'all_allocated_cash', coalesce(sum(allocated_amount), 0),
    'manager_recorded_cash', coalesce(sum(allocated_amount)
      filter (where recorded_role in ('admin', 'round_lead')), 0),
    'delta_from_all_cash', -coalesce(sum(allocated_amount)
      filter (where recorded_role in ('admin', 'round_lead')), 0)
  ) into v_result
  from relevant;

  return v_result;
end;
$$;

revoke all on function public.get_daily_close_cash_dark_launch_summary(date) from public;
grant execute on function public.get_daily_close_cash_dark_launch_summary(date) to authenticated;

comment on table public.daily_close_reconciliation_configuration is
  'Dark-launch gate. Set enabled_from_service_date only after comparing at least one service day.';
comment on table public.daily_close_employee_snapshots is
  'Immutable one-row-per-employee daily cash reconciliation snapshot.';
comment on table public.daily_close_payment_items is
  'Immutable source-payment snapshot for the employee daily close.';
