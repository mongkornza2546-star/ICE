-- Give every delivery charge a stable human-readable reference in the form
-- CYYMMDD-000001, and expose charge/shop imagery to the collection workspace.

create sequence if not exists public.delivery_charge_number_seq;

alter table public.delivery_charges
  add column charge_number text;

with numbered_charges as (
  select
    charge.id,
    row_number() over (
      order by charge.service_date, charge.created_at, charge.id
    ) as sequence_no
  from public.delivery_charges charge
)
update public.delivery_charges charge
set charge_number = 'C'
  || to_char(charge.service_date, 'YYMMDD')
  || '-'
  || lpad(numbered.sequence_no::text, 6, '0')
from numbered_charges numbered
where numbered.id = charge.id;

-- The backfill fires deferred financial snapshot triggers on delivery_charges.
-- Flush them before the later ALTER TABLE in this migration.
set constraints all immediate;

do $charge_sequence$
declare
  v_existing_count bigint;
begin
  select count(*) into v_existing_count
  from public.delivery_charges;

  if v_existing_count = 0 then
    perform setval('public.delivery_charge_number_seq', 1, false);
  else
    perform setval('public.delivery_charge_number_seq', v_existing_count, true);
  end if;
end;
$charge_sequence$;

create or replace function public.assign_delivery_charge_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.charge_number is null then
    new.charge_number := 'C'
      || to_char(new.service_date, 'YYMMDD')
      || '-'
      || lpad(nextval('public.delivery_charge_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

create trigger delivery_charges_assign_charge_number
before insert on public.delivery_charges
for each row execute function public.assign_delivery_charge_number();

alter table public.delivery_charges
  alter column charge_number set not null;

create unique index delivery_charges_charge_number_idx
  on public.delivery_charges (charge_number);

create or replace function public.get_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view recovery collection balances';
  end if;

  if not exists (
    select 1
    from public.collection_runs run
    where run.id = p_collection_run_id
      and run.status = 'open'
  ) then
    raise exception 'The collection run does not exist or is closed';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', queue.shop_id,
      'shop_code', queue.shop_code,
      'shop_name', queue.shop_name,
      'image_path', queue.image_path,
      'outstanding_amount', queue.outstanding_amount,
      'charge_count', queue.charge_count,
      'latest_charge_at', queue.latest_charge_at,
      'latest_payment_at', queue.latest_payment_at,
      'has_new_charges', queue.latest_payment_at is not null
        and queue.latest_charge_at > queue.latest_payment_at,
      'payment_profile', queue.payment_profile,
      'charges', queue.charges
    ) order by queue.shop_code)
    from (
      select
        shop.id as shop_id,
        shop.code as shop_code,
        shop.name as shop_name,
        shop.image_path,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        count(*)::integer as charge_count,
        max(charge.created_at) as latest_charge_at,
        jsonb_build_object(
          'allowed_payment_methods', profile.allowed_payment_methods,
          'default_payment_method', profile.default_payment_method,
          'cash_reference_required', profile.cash_reference_required,
          'cash_evidence_required', profile.cash_evidence_required,
          'bank_transfer_reference_required', profile.bank_transfer_reference_required,
          'bank_transfer_evidence_required', profile.bank_transfer_evidence_required,
          'qr_reference_required', profile.qr_reference_required,
          'qr_evidence_required', profile.qr_evidence_required
        ) as payment_profile,
        (
          select max(payment.recorded_at)
          from public.payments payment
          where payment.shop_id = shop.id
            and payment.collection_run_id = p_collection_run_id
            and payment.status = 'active'
        ) as latest_payment_at,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id,
          'charge_number', charge.charge_number,
          'delivery_event_id', charge.delivery_event_id,
          'service_date', charge.service_date,
          'payment_term', charge.payment_term,
          'original_amount', charge.original_amount,
          'outstanding_amount', balance.outstanding_amount,
          'created_at', charge.created_at
        ) order by charge.service_date, charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      join public.shops shop on shop.id = charge.shop_id
      join public.shop_payment_profiles profile on profile.shop_id = shop.id
      join lateral (
        select greatest(charge.original_amount - coalesce(sum(allocation.amount)
          filter (where payment.status = 'active'), 0), 0)::numeric(12,2) as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where charge.payment_term in ('immediate', 'end_of_day')
        and charge.status = 'active'
        and balance.outstanding_amount > 0
      group by shop.id, profile.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_today_collection_run_queue(
  p_collection_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service_date date;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  select run.service_date
  into v_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id
    and run.status = 'open'
    and (
      public.current_app_role() in ('admin', 'round_lead')
      or public.is_collection_run_member(run.id)
    );

  if v_service_date is null then
    raise exception 'The collection run does not exist, is closed, or is not assigned to this user';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', queue.shop_id,
      'shop_code', queue.shop_code,
      'shop_name', queue.shop_name,
      'image_path', queue.image_path,
      'outstanding_amount', queue.outstanding_amount,
      'charge_count', queue.charge_count,
      'latest_charge_at', queue.latest_charge_at,
      'latest_payment_at', queue.latest_payment_at,
      'has_new_charges', queue.latest_payment_at is not null
        and queue.latest_charge_at > queue.latest_payment_at,
      'payment_profile', queue.payment_profile,
      'charges', queue.charges
    ) order by queue.shop_code)
    from (
      select
        shop.id as shop_id,
        shop.code as shop_code,
        shop.name as shop_name,
        shop.image_path,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        count(*)::integer as charge_count,
        max(charge.created_at) as latest_charge_at,
        jsonb_build_object(
          'allowed_payment_methods', profile.allowed_payment_methods,
          'default_payment_method', profile.default_payment_method,
          'cash_reference_required', profile.cash_reference_required,
          'cash_evidence_required', profile.cash_evidence_required,
          'bank_transfer_reference_required', profile.bank_transfer_reference_required,
          'bank_transfer_evidence_required', profile.bank_transfer_evidence_required,
          'qr_reference_required', profile.qr_reference_required,
          'qr_evidence_required', profile.qr_evidence_required
        ) as payment_profile,
        (
          select max(payment.recorded_at)
          from public.payments payment
          where payment.shop_id = shop.id
            and payment.collection_run_id = p_collection_run_id
            and payment.status = 'active'
        ) as latest_payment_at,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id,
          'charge_number', charge.charge_number,
          'delivery_event_id', charge.delivery_event_id,
          'service_date', charge.service_date,
          'payment_term', charge.payment_term,
          'original_amount', charge.original_amount,
          'outstanding_amount', balance.outstanding_amount,
          'created_at', charge.created_at
        ) order by charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      join public.shops shop on shop.id = charge.shop_id
      join public.shop_payment_profiles profile on profile.shop_id = shop.id
      join lateral (
        select greatest(charge.original_amount - coalesce(sum(allocation.amount)
          filter (where payment.status = 'active'), 0), 0)::numeric(12,2) as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where charge.service_date = v_service_date
        and charge.payment_term in ('immediate', 'end_of_day')
        and charge.status = 'active'
        and balance.outstanding_amount > 0
      group by shop.id, profile.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.assign_delivery_charge_number() from public;
