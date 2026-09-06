-- Event ice delivery financial closeout. This migration installs the complete
-- settlement boundary, event-aware collection/payment contracts, immutable
-- document context, and pilot controls. Global intake remains disabled until
-- migration 0172 is applied after the pilot acceptance gate.

-- 0171 prerequisite and history preflight. Keep this block before every DDL
-- statement: rows created by the 0170 writer cannot be backfilled safely.
do $event_financial_preflight$
declare
  v_event_ids uuid[];
  v_event_count bigint;
  v_charge_count bigint;
  v_payment_count bigint;
  v_invoice_count bigint;
  v_receipt_count bigint;
begin
  if to_regclass('public.event_delivery_feature_settings') is null
    or to_regclass('public.event_participations') is null
    or to_regclass('public.event_job_config_versions') is null
    or to_regclass('public.delivery_charges') is null
    or to_regclass('public.payments') is null
    or to_regprocedure(
      'public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamp with time zone,uuid)'
    ) is null
    or not exists (
      select 1
      from public.event_delivery_feature_settings settings
      where settings.singleton and settings.schema_version >= 6
    ) then
    raise exception 'Migration 0171 requires migrations through 0170';
  end if;

  -- Serialize the history check with the legacy 0170 writer. If an in-flight
  -- writer wins these locks, its committed rows are visible to the checks
  -- below. If this migration wins, later delivered writes reach the new charge
  -- guard after this transaction commits and cannot create a context-less row.
  lock table public.delivery_events, public.delivery_charges
    in share row exclusive mode;

  select
    count(*),
    (array_agg(event.id order by event.id))[1:20]
  into v_event_count, v_event_ids
  from public.delivery_events event
  join public.round_stops stop on stop.id = event.round_stop_id
  where stop.destination_kind = 'event';

  if v_event_count > 0 then
    select count(*)
    into v_charge_count
    from public.delivery_charges charge
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.round_stops stop on stop.id = event.round_stop_id
    where stop.destination_kind = 'event';

    select count(distinct allocation.payment_id)
    into v_payment_count
    from public.payment_allocations allocation
    join public.delivery_charges charge on charge.id = allocation.charge_id
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.round_stops stop on stop.id = event.round_stop_id
    where stop.destination_kind = 'event';

    select count(*)
    into v_invoice_count
    from public.delivery_charge_document_snapshots snapshot
    join public.delivery_charges charge on charge.id = snapshot.charge_id
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.round_stops stop on stop.id = event.round_stop_id
    where stop.destination_kind = 'event';

    select count(distinct snapshot.payment_id)
    into v_receipt_count
    from public.payment_receipt_snapshots snapshot
    join public.payment_allocations allocation
      on allocation.payment_id = snapshot.payment_id
    join public.delivery_charges charge on charge.id = allocation.charge_id
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.round_stops stop on stop.id = event.round_stop_id
    where stop.destination_kind = 'event';

    raise exception 'Migration 0171 cannot infer settlement context for 0170 event history: %',
      jsonb_build_object(
        'event_count', v_event_count,
        'event_ids', to_jsonb(v_event_ids),
        'charge_count', v_charge_count,
        'payment_count', v_payment_count,
        'invoice_count', v_invoice_count,
        'receipt_count', v_receipt_count
      );
  end if;
end;
$event_financial_preflight$;

create table public.event_settlement_contexts (
  id uuid primary key default gen_random_uuid(),
  event_participation_id uuid not null
    references public.event_participations(id) on delete restrict,
  shop_id uuid not null references public.shops(id) on delete restrict,
  service_date date not null,
  config_version_id uuid not null
    references public.event_job_config_versions(id) on delete restrict,
  settlement_policy_fingerprint text not null
    check (nullif(trim(settlement_policy_fingerprint), '') is not null),
  created_at timestamptz not null default now(),
  unique (event_participation_id, service_date)
);

create table public.event_ice_delivery_pilots (
  event_participation_id uuid primary key
    references public.event_participations(id) on delete restrict,
  enabled_by uuid not null references public.users(id) on delete restrict,
  enabled_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > enabled_at)
);

alter table public.event_settlement_contexts enable row level security;
alter table public.event_ice_delivery_pilots enable row level security;
revoke all on table public.event_settlement_contexts from public, anon, authenticated;
revoke all on table public.event_ice_delivery_pilots from public, anon, authenticated;

create or replace function public.enforce_event_settlement_context()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_participation public.event_participations%rowtype;
  v_job public.event_jobs%rowtype;
  v_config public.event_job_config_versions%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Event settlement contexts are immutable';
  end if;

  select * into v_participation
  from public.event_participations participation
  where participation.id = new.event_participation_id;

  if v_participation.id is null
    or v_participation.config_version_id is null
    or v_participation.settlement_policy_fingerprint is null then
    raise exception 'The event participation does not have a frozen settlement policy';
  end if;

  select * into v_job
  from public.event_jobs job
  where job.id = v_participation.event_job_id;

  select * into v_config
  from public.event_job_config_versions config
  where config.id = v_participation.config_version_id
    and config.event_job_id = v_participation.event_job_id;

  if v_config.id is null
    or new.shop_id is distinct from v_participation.shop_id
    or new.config_version_id is distinct from v_participation.config_version_id
    or new.settlement_policy_fingerprint
      is distinct from v_participation.settlement_policy_fingerprint
    or new.settlement_policy_fingerprint is distinct from v_config.policy_fingerprint
    or new.service_date not between v_job.start_date and v_job.end_date
    or new.service_date not between v_participation.start_date and v_participation.end_date then
    raise exception 'Event settlement context does not match its frozen participation';
  end if;

  return new;
end;
$$;

create trigger event_settlement_contexts_validate_insert
before insert on public.event_settlement_contexts
for each row execute function public.enforce_event_settlement_context();

create trigger event_settlement_contexts_immutable
before update or delete on public.event_settlement_contexts
for each row execute function public.enforce_event_settlement_context();

create or replace function public.get_or_create_event_settlement_context(
  p_event_participation_id uuid,
  p_service_date date
)
returns public.event_settlement_contexts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participation public.event_participations%rowtype;
  v_context public.event_settlement_contexts%rowtype;
begin
  select * into v_participation
  from public.event_participations participation
  where participation.id = p_event_participation_id;

  if v_participation.id is null
    or v_participation.config_version_id is null
    or v_participation.settlement_policy_fingerprint is null then
    raise exception 'The event participation does not have a frozen settlement policy';
  end if;

  insert into public.event_settlement_contexts (
    event_participation_id,
    shop_id,
    service_date,
    config_version_id,
    settlement_policy_fingerprint
  ) values (
    v_participation.id,
    v_participation.shop_id,
    p_service_date,
    v_participation.config_version_id,
    v_participation.settlement_policy_fingerprint
  )
  on conflict (event_participation_id, service_date) do nothing;

  select * into v_context
  from public.event_settlement_contexts context
  where context.event_participation_id = p_event_participation_id
    and context.service_date = p_service_date
  for update;

  if v_context.id is null
    or v_context.shop_id is distinct from v_participation.shop_id
    or v_context.config_version_id is distinct from v_participation.config_version_id
    or v_context.settlement_policy_fingerprint
      is distinct from v_participation.settlement_policy_fingerprint then
    raise exception 'Existing event settlement context conflicts with the frozen participation';
  end if;

  return v_context;
end;
$$;

create or replace function public.is_event_ice_delivery_write_enabled(
  p_event_participation_id uuid
)
returns boolean
language sql
volatile
security definer
set search_path = public
as $$
  select coalesce((
    select settings.event_ice_delivery_enabled
      or exists (
        select 1
        from public.event_ice_delivery_pilots pilot
        where pilot.event_participation_id = p_event_participation_id
          and pilot.expires_at > clock_timestamp()
      )
    from public.event_delivery_feature_settings settings
    where settings.singleton
  ), false);
$$;

create or replace function public.lock_event_ice_delivery_write_eligibility(
  p_event_participation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_global_enabled boolean;
  v_pilot_expires_at timestamptz;
begin
  select settings.event_ice_delivery_enabled
  into v_global_enabled
  from public.event_delivery_feature_settings settings
  where settings.singleton
  for update;

  if not found then
    raise exception 'Event delivery feature settings are missing';
  end if;

  select pilot.expires_at
  into v_pilot_expires_at
  from public.event_ice_delivery_pilots pilot
  where pilot.event_participation_id = p_event_participation_id
  for update;

  return v_global_enabled
    or (v_pilot_expires_at is not null and v_pilot_expires_at > clock_timestamp());
end;
$$;

create or replace function public.enforce_event_participation_financial_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.event_job_id is distinct from old.event_job_id then
    raise exception 'An event participation cannot move to another event';
  end if;

  if new.shop_id is distinct from old.shop_id
    and (
      old.config_version_id is not null
      or exists (
        select 1 from public.round_stops stop
        where stop.event_participation_id = old.id
      )
      or exists (
        select 1 from public.event_settlement_contexts context
        where context.event_participation_id = old.id
      )
    ) then
    raise exception 'A frozen or history-bearing event participation cannot change shop';
  end if;

  return new;
end;
$$;

create trigger event_participations_protect_financial_identity
before update of event_job_id, shop_id on public.event_participations
for each row execute function public.enforce_event_participation_financial_identity();

create or replace function public.enforce_event_round_stop_shop()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.destination_kind = 'event' and not exists (
    select 1
    from public.event_participations participation
    where participation.id = new.event_participation_id
      and participation.shop_id = new.shop_id
  ) then
    raise exception 'Event round stop shop must match its participation shop';
  end if;
  return new;
end;
$$;

create trigger round_stops_enforce_event_shop
before insert or update of destination_kind, event_participation_id, shop_id
on public.round_stops
for each row execute function public.enforce_event_round_stop_shop();

create or replace function public.protect_delivery_event_round_stop()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.round_stop_id is distinct from old.round_stop_id then
    raise exception 'A delivery event cannot move to another round stop';
  end if;
  return new;
end;
$$;

create trigger delivery_events_protect_round_stop
before update of round_stop_id on public.delivery_events
for each row execute function public.protect_delivery_event_round_stop();

create or replace function public.protect_history_bearing_round_service_date()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.service_date is distinct from old.service_date and exists (
    select 1 from public.round_stops stop where stop.round_id = old.id
  ) then
    raise exception 'A delivery round with destination history cannot change service date';
  end if;
  return new;
end;
$$;

create trigger delivery_rounds_protect_history_service_date
before update of service_date on public.delivery_rounds
for each row execute function public.protect_history_bearing_round_service_date();

alter table public.delivery_charges
  add column event_settlement_context_id uuid
    references public.event_settlement_contexts(id) on delete restrict;

create index delivery_charges_event_settlement_active_idx
  on public.delivery_charges (shop_id, event_settlement_context_id, service_date)
  where status = 'active';

create or replace function public.enforce_delivery_charge_settlement_context()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_stop public.round_stops%rowtype;
  v_service_date date;
  v_context public.event_settlement_contexts%rowtype;
begin
  if tg_op = 'UPDATE' and (
    new.delivery_event_id is distinct from old.delivery_event_id
    or new.shop_id is distinct from old.shop_id
    or new.service_date is distinct from old.service_date
    or new.event_settlement_context_id is distinct from old.event_settlement_context_id
    or (
      old.event_settlement_context_id is not null
      and new.payment_term is distinct from old.payment_term
    )
  ) then
    raise exception 'Delivery charge settlement identity is immutable';
  end if;

  select stop.*
  into v_stop
  from public.delivery_events event
  join public.round_stops stop on stop.id = event.round_stop_id
  where event.id = new.delivery_event_id;

  select round.service_date
  into v_service_date
  from public.delivery_rounds round
  where round.id = v_stop.round_id;

  if v_stop.id is null
    or new.shop_id is distinct from v_stop.shop_id
    or new.service_date is distinct from v_service_date then
    raise exception 'Delivery charge shop and service date must match its destination';
  elsif v_stop.destination_kind = 'regular' then
    if new.event_settlement_context_id is not null then
      raise exception 'Regular delivery charges cannot use an event settlement context';
    end if;
  else
    if new.event_settlement_context_id is null then
      raise exception 'Event delivery charges require an event settlement context';
    elsif new.payment_term <> 'end_of_day' then
      raise exception 'Event delivery charges must use end-of-day settlement';
    end if;

    select * into v_context
    from public.event_settlement_contexts context
    where context.id = new.event_settlement_context_id;

    if v_context.id is null
      or v_context.event_participation_id is distinct from v_stop.event_participation_id
      or v_context.shop_id is distinct from new.shop_id
      or v_context.service_date is distinct from new.service_date then
      raise exception 'Event delivery charge does not match its settlement context';
    end if;
  end if;

  return new;
end;
$$;

create trigger delivery_charges_enforce_settlement_context
before insert or update of delivery_event_id, shop_id, service_date,
  payment_term, event_settlement_context_id
on public.delivery_charges
for each row execute function public.enforce_delivery_charge_settlement_context();

revoke all on function public.enforce_event_settlement_context()
  from public, anon, authenticated;
revoke all on function public.get_or_create_event_settlement_context(uuid, date)
  from public, anon, authenticated;
revoke all on function public.is_event_ice_delivery_write_enabled(uuid)
  from public, anon, authenticated;
revoke all on function public.lock_event_ice_delivery_write_eligibility(uuid)
  from public, anon, authenticated;
revoke all on function public.enforce_event_participation_financial_identity()
  from public, anon, authenticated;
revoke all on function public.enforce_event_round_stop_shop()
  from public, anon, authenticated;
revoke all on function public.protect_delivery_event_round_stop()
  from public, anon, authenticated;
revoke all on function public.protect_history_bearing_round_service_date()
  from public, anon, authenticated;
revoke all on function public.enforce_delivery_charge_settlement_context()
  from public, anon, authenticated;

alter table public.payments
  add column operation_kind text,
  add column event_settlement_context_id uuid
    references public.event_settlement_contexts(id) on delete restrict,
  add column request_fingerprint_version smallint;

update public.payments
set operation_kind = 'regular',
    request_fingerprint_version = 1
where operation_kind is null or request_fingerprint_version is null;

alter table public.payments
  alter column operation_kind set not null,
  alter column operation_kind set default 'regular',
  alter column request_fingerprint_version set not null,
  alter column request_fingerprint_version set default 2,
  add constraint payments_operation_kind_check
    check (operation_kind in ('regular', 'event')),
  add constraint payments_settlement_context_check check (
    (operation_kind = 'regular' and event_settlement_context_id is null)
    or (operation_kind = 'event' and event_settlement_context_id is not null)
  ),
  add constraint payments_fingerprint_version_check
    check (request_fingerprint_version in (1, 2));

create index payments_event_settlement_context_idx
  on public.payments (event_settlement_context_id, recorded_at desc, id desc)
  where operation_kind = 'event';

create or replace function public.protect_payment_settlement_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.shop_id is distinct from old.shop_id
    or new.operation_kind is distinct from old.operation_kind
    or new.event_settlement_context_id is distinct from old.event_settlement_context_id
    or new.request_fingerprint_version is distinct from old.request_fingerprint_version
    or new.request_fingerprint is distinct from old.request_fingerprint then
    raise exception 'Payment settlement identity is immutable';
  end if;
  return new;
end;
$$;

create trigger payments_protect_settlement_identity
before update of shop_id, operation_kind, event_settlement_context_id,
  request_fingerprint_version, request_fingerprint
on public.payments
for each row execute function public.protect_payment_settlement_identity();

create or replace function public.assert_payment_allocation_integrity(target_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_accounted_amount numeric(12,2);
begin
  select * into v_payment
  from public.payments payment
  where payment.id = target_payment_id;
  if not found then return; end if;

  perform pg_advisory_xact_lock(
    hashtextextended('financial-shop:' || v_payment.shop_id::text, 0)
  );

  select (
    coalesce((select sum(allocation.amount)
      from public.payment_allocations allocation
      where allocation.payment_id = target_payment_id), 0)
    + coalesce((select sum(obligation.amount)
      from public.refund_obligations obligation
      where obligation.payment_id = target_payment_id
        and obligation.status <> 'voided'), 0)
  )::numeric(12,2)
  into v_accounted_amount;

  if v_accounted_amount <> v_payment.allocated_amount then
    raise exception 'Payment allocations plus refund obligations must equal the allocated amount';
  elsif exists (
    select 1
    from public.payment_allocations allocation
    join public.delivery_charges charge on charge.id = allocation.charge_id
    where allocation.payment_id = target_payment_id
      and (
        charge.shop_id is distinct from v_payment.shop_id
        or charge.event_settlement_context_id
          is distinct from v_payment.event_settlement_context_id
      )
  ) then
    raise exception 'Every payment allocation must use the payment shop and settlement context';
  elsif exists (
    select 1
    from public.refund_obligations obligation
    join public.delivery_charges charge on charge.id = obligation.source_charge_id
    where obligation.payment_id = target_payment_id
      and (
        charge.shop_id is distinct from v_payment.shop_id
        or charge.event_settlement_context_id
          is distinct from v_payment.event_settlement_context_id
      )
  ) then
    raise exception 'Every refund obligation must use the payment settlement context';
  end if;
end;
$$;

-- Queue every table that can change either side of the allocation equation.
-- The original dispatcher only covered payments, allocations, and charges.
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
      union
      select distinct obligation.payment_id
      from public.refund_obligations obligation
      where obligation.source_charge_id = case when tg_op = 'DELETE' then old.id else new.id end
    loop
      perform public.assert_payment_allocation_integrity(v_related_id);
    end loop;
  elsif tg_table_name = 'payment_allocations' then
    if tg_op <> 'INSERT' then
      perform public.assert_payment_allocation_integrity(old.payment_id);
      perform public.assert_charge_allocation_integrity(old.charge_id);
    end if;
    if tg_op <> 'DELETE' then
      perform public.assert_payment_allocation_integrity(new.payment_id);
      perform public.assert_charge_allocation_integrity(new.charge_id);
    end if;
  elsif tg_table_name = 'refund_obligations' then
    if tg_op <> 'INSERT' then
      perform public.assert_payment_allocation_integrity(old.payment_id);
      perform public.assert_charge_allocation_integrity(old.source_charge_id);
    end if;
    if tg_op <> 'DELETE' then
      perform public.assert_payment_allocation_integrity(new.payment_id);
      perform public.assert_charge_allocation_integrity(new.source_charge_id);
    end if;
  elsif tg_table_name = 'delivery_charge_adjustments' then
    if tg_op <> 'INSERT' then
      perform public.assert_charge_allocation_integrity(old.charge_id);
    end if;
    if tg_op <> 'DELETE' then
      perform public.assert_charge_allocation_integrity(new.charge_id);
    end if;
  elsif tg_table_name = 'event_settlement_contexts' then
    for v_related_id in
      select payment.id
      from public.payments payment
      where payment.event_settlement_context_id = case
        when tg_op = 'DELETE' then old.id else new.id end
    loop
      perform public.assert_payment_allocation_integrity(v_related_id);
    end loop;
    for v_related_id in
      select charge.id
      from public.delivery_charges charge
      where charge.event_settlement_context_id = case
        when tg_op = 'DELETE' then old.id else new.id end
    loop
      perform public.assert_charge_allocation_integrity(v_related_id);
    end loop;
  end if;
  return null;
end;
$$;

create constraint trigger refund_obligations_allocation_integrity
after insert or update or delete on public.refund_obligations
deferrable initially deferred
for each row execute function public.check_payment_allocation_integrity();

create constraint trigger delivery_charge_adjustments_allocation_integrity
after insert or update or delete on public.delivery_charge_adjustments
deferrable initially deferred
for each row execute function public.check_payment_allocation_integrity();

create constraint trigger event_settlement_contexts_allocation_integrity
after insert or update or delete on public.event_settlement_contexts
deferrable initially deferred
for each row execute function public.check_payment_allocation_integrity();

create or replace function public.enable_event_ice_delivery_pilot(
  p_event_participation_id uuid,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can enable an event delivery pilot';
  elsif p_event_participation_id is null or p_expires_at <= clock_timestamp() then
    raise exception 'A participation and a future expiry are required';
  elsif not exists (
    select 1
    from public.event_participations participation
    join public.event_jobs job on job.id = participation.event_job_id
    where participation.id = p_event_participation_id
      and participation.status = 'active'
      and job.status = 'published'
      and participation.config_version_id is not null
      and participation.settlement_policy_fingerprint is not null
  ) then
    raise exception 'The event participation is not ready for a pilot';
  end if;

  perform 1 from public.event_delivery_feature_settings where singleton for update;
  insert into public.event_ice_delivery_pilots (
    event_participation_id, enabled_by, enabled_at, expires_at
  ) values (
    p_event_participation_id, auth.uid(), clock_timestamp(), p_expires_at
  )
  on conflict (event_participation_id) do update
  set enabled_by = excluded.enabled_by,
      enabled_at = excluded.enabled_at,
      expires_at = excluded.expires_at;

  return jsonb_build_object(
    'event_participation_id', p_event_participation_id,
    'expires_at', p_expires_at,
    'enabled', true
  );
end;
$$;

create or replace function public.disable_event_ice_delivery_pilot(
  p_event_participation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can disable an event delivery pilot';
  end if;
  perform 1 from public.event_delivery_feature_settings where singleton for update;
  perform 1 from public.event_ice_delivery_pilots
  where event_participation_id = p_event_participation_id for update;
  delete from public.event_ice_delivery_pilots
  where event_participation_id = p_event_participation_id;
  return jsonb_build_object(
    'event_participation_id', p_event_participation_id,
    'enabled', false
  );
end;
$$;

-- Event-specific correction RPCs set a transaction-local, server-controlled
-- scope. The mature correction implementation is then reused, while its
-- regular compatibility fence remains closed to old clients.
alter function public.resolve_delivery_price(uuid, uuid, date)
  rename to resolve_regular_delivery_price;
revoke all on function public.resolve_regular_delivery_price(uuid, uuid, date)
  from public, anon, authenticated;

create function public.resolve_delivery_price(
  p_shop_id uuid,
  p_ice_type_id uuid,
  p_service_date date
)
returns table (
  unit_price numeric(12,2),
  price_source public.price_source,
  price_source_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid := nullif(current_setting('app.event_correction_id', true), '')::uuid;
begin
  if v_event_id is not null then
    if not exists (
      select 1
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.delivery_rounds round on round.id = stop.round_id
      where event.id = v_event_id
        and stop.destination_kind = 'event'
        and stop.shop_id = p_shop_id
        and round.service_date = p_service_date
    ) then
      raise exception 'Event correction price scope does not match the delivery';
    end if;
    return query
    select price.unit_price, 'standard'::public.price_source, price.id
    from public.ice_type_prices price
    where price.ice_type_id = p_ice_type_id
      and price.is_active
      and price.valid_from <= p_service_date
      and (price.valid_to is null or price.valid_to >= p_service_date)
    order by price.valid_from desc
    limit 1;
    return;
  end if;
  return query select * from public.resolve_regular_delivery_price(
    p_shop_id, p_ice_type_id, p_service_date
  );
end;
$$;

revoke all on function public.resolve_delivery_price(uuid, uuid, date)
  from public, anon, authenticated;

create or replace function public.require_regular_delivery_event(p_event_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.delivery_events event
    join public.round_stops stop on stop.id = event.round_stop_id
    where event.id = p_event_id
      and stop.destination_kind <> 'regular'
  ) and nullif(current_setting('app.event_correction_id', true), '')
      is distinct from p_event_id::text then
    raise exception 'Event deliveries require the event delivery workflow';
  end if;
end;
$$;

-- A replacement event created by the audited event-correction RPC inherits
-- the immutable context of the charge it replaces. New intake still has to
-- supply a context explicitly.
create or replace function public.enforce_delivery_charge_settlement_context()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_stop public.round_stops%rowtype;
  v_event public.delivery_events%rowtype;
  v_service_date date;
  v_context public.event_settlement_contexts%rowtype;
begin
  if tg_op = 'UPDATE' and (
    new.delivery_event_id is distinct from old.delivery_event_id
    or new.shop_id is distinct from old.shop_id
    or new.service_date is distinct from old.service_date
    or new.event_settlement_context_id is distinct from old.event_settlement_context_id
    or (old.event_settlement_context_id is not null
      and new.payment_term is distinct from old.payment_term)
  ) then
    raise exception 'Delivery charge settlement identity is immutable';
  end if;

  select * into v_event
  from public.delivery_events event
  where event.id = new.delivery_event_id;
  select * into v_stop
  from public.round_stops stop
  where stop.id = v_event.round_stop_id;

  select round.service_date into v_service_date
  from public.delivery_rounds round where round.id = v_stop.round_id;

  if v_stop.id is null
    or new.shop_id is distinct from v_stop.shop_id
    or new.service_date is distinct from v_service_date then
    raise exception 'Delivery charge shop and service date must match its destination';
  elsif v_stop.destination_kind = 'regular' then
    if new.event_settlement_context_id is not null then
      raise exception 'Regular delivery charges cannot use an event settlement context';
    end if;
  else
    if new.event_settlement_context_id is null and v_event.corrects_event_id is not null
      and nullif(current_setting('app.event_correction_id', true), '')
        = v_event.corrects_event_id::text then
      select charge.event_settlement_context_id
      into new.event_settlement_context_id
      from public.delivery_charges charge
      where charge.delivery_event_id = v_event.corrects_event_id;
    end if;
    if new.event_settlement_context_id is null then
      raise exception 'Event delivery charges require an event settlement context';
    elsif new.payment_term <> 'end_of_day' then
      raise exception 'Event delivery charges must use end-of-day settlement';
    end if;
    select * into v_context from public.event_settlement_contexts context
    where context.id = new.event_settlement_context_id;
    if v_context.id is null
      or v_context.event_participation_id is distinct from v_stop.event_participation_id
      or v_context.shop_id is distinct from new.shop_id
      or v_context.service_date is distinct from new.service_date then
      raise exception 'Event delivery charge does not match its settlement context';
    end if;
  end if;
  return new;
end;
$$;

do $event_financial_writer$
declare
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(
    'public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamp with time zone,uuid)'::regprocedure
  ) into v_definition;
  v_updated := replace(v_definition,
    E'  v_total_amount numeric(12,2) := 0;\n',
    E'  v_total_amount numeric(12,2) := 0;\n  v_event_participation_id uuid;\n  v_settlement_context public.event_settlement_contexts%rowtype;\n'
  );
  v_updated := replace(v_updated,
    $fragment$  elsif not exists (
    select 1
    from public.event_delivery_feature_settings settings
    where settings.singleton and settings.event_ice_delivery_enabled
  ) then
    raise exception 'Event ice delivery is not enabled';
  elsif jsonb_typeof(p_items) is distinct from 'array' then$fragment$,
    $fragment$  elsif p_idempotency_key is null then
    raise exception 'An idempotency key is required';
  elsif jsonb_typeof(p_items) is distinct from 'array' then$fragment$
  );
  v_updated := replace(v_updated,
    E'  select round.service_date into v_lock_service_date\n  from public.round_stops stop',
    $fragment$  select stop.event_participation_id
  into v_event_participation_id
  from public.round_stops stop
  where stop.id = p_round_stop_id and stop.destination_kind = 'event';

  if v_event_participation_id is null
    or not public.lock_event_ice_delivery_write_eligibility(v_event_participation_id) then
    raise exception 'Event ice delivery is not enabled for this participation';
  end if;

  select round.service_date into v_lock_service_date
  from public.round_stops stop$fragment$
  );
  v_updated := replace(v_updated,
    E'  if public.current_app_role() = ''courier'' then',
    $fragment$  if v_event_participation_id is distinct from (
    select stop.event_participation_id from public.round_stops stop
    where stop.id = p_round_stop_id
  ) then
    raise exception 'The event participation changed; retry the request';
  end if;

  v_settlement_context := public.get_or_create_event_settlement_context(
    v_event_participation_id, v_service_date
  );

  if public.current_app_role() = 'courier' then$fragment$
  );
  v_updated := replace(v_updated,
    E'      original_amount, due_date, approval_request_id\n    ) values (\n      v_event_id, v_shop_id, v_service_date, ''end_of_day'',\n      v_total_amount, null, null',
    E'      original_amount, due_date, approval_request_id, event_settlement_context_id\n    ) values (\n      v_event_id, v_shop_id, v_service_date, ''end_of_day'',\n      v_total_amount, null, null, v_settlement_context.id'
  );
  if v_updated = v_definition
    or strpos(v_updated, 'v_settlement_context.id') = 0
    or strpos(v_updated, 'lock_event_ice_delivery_write_eligibility') = 0 then
    raise exception 'Could not install the 0171 event writer contract';
  end if;
  execute v_updated;
end;
$event_financial_writer$;

do $event_financial_reads$
declare
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef('public.get_event_delivery_cards(uuid,uuid,text)'::regprocedure)
  into v_definition;
  v_updated := replace(v_definition,
    E'''is_operational'', coalesce(current_stop.is_operational, true),\n      ''stop_status''',
    E'''is_operational'', coalesce(current_stop.is_operational, true),\n      ''event_delivery_enabled'', public.is_event_ice_delivery_write_enabled(eligible.id),\n      ''stop_status'''
  );
  if v_updated = v_definition then
    raise exception 'Could not add per-participation eligibility to event cards';
  end if;
  execute v_updated;

  select pg_get_functiondef('public.get_event_delivery_pos_context(uuid)'::regprocedure)
  into v_definition;
  v_updated := replace(v_definition,
    $fragment$  elsif not exists (
    select 1
    from public.event_delivery_feature_settings settings
    where settings.singleton and settings.event_ice_delivery_enabled
  ) then
    raise exception 'Event ice delivery is not enabled';
  end if;$fragment$,
    E'  end if;'
  );
  v_updated := replace(v_updated,
    $fragment$  if v_round_id is null then
    raise exception 'The selected destination is not an event round stop';$fragment$,
    $fragment$  if v_round_id is null then
    raise exception 'The selected destination is not an event round stop';
  elsif not public.is_event_ice_delivery_write_enabled((
    select stop.event_participation_id from public.round_stops stop
    where stop.id = p_round_stop_id
  )) then
    raise exception 'Event ice delivery is not enabled for this participation';$fragment$
  );
  if v_updated = v_definition
    or strpos(v_updated, 'not public.is_event_ice_delivery_write_enabled') = 0 then
    raise exception 'Could not install the 0171 event POS eligibility contract';
  end if;
  execute v_updated;
end;
$event_financial_reads$;

create or replace function public.get_collection_run_queue(p_collection_run_id uuid)
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
    raise exception 'An active user is required to view shop collections';
  end if;
  select run.service_date into v_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id and run.status = 'open';
  if v_service_date is null
    or v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or exists (
      select 1 from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_service_date
    ) then
    raise exception 'The collection context is stale or closed';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'queue_key', queue.queue_key,
      'destination_kind', queue.destination_kind,
      'event_settlement_context_id', queue.event_settlement_context_id,
      'event_participation_id', queue.event_participation_id,
      'settlement_service_date', queue.settlement_service_date,
      'settlement_policy_fingerprint', queue.settlement_policy_fingerprint,
      'event_name', queue.event_name,
      'event_location', queue.event_location,
      'event_zone', queue.event_zone,
      'event_booth', queue.event_booth,
      'shop_id', queue.shop_id,
      'shop_code', queue.shop_code,
      'shop_name', queue.shop_name,
      'building_id', queue.building_id,
      'building_name', queue.building_name,
      'zone_id', queue.zone_id,
      'zone_name', queue.zone_name,
      'image_path', queue.image_path,
      'outstanding_amount', queue.outstanding_amount,
      'charge_count', queue.charge_count,
      'latest_charge_at', queue.latest_charge_at,
      'latest_payment_at', queue.latest_payment_at,
      'has_new_charges', queue.latest_payment_at is not null
        and queue.latest_charge_at > queue.latest_payment_at,
      'payment_profile', queue.payment_profile,
      'charges', queue.charges
    ) order by queue.destination_kind, queue.event_name nulls first, queue.shop_code, queue.queue_key)
    from (
      select
        case when context.id is null then 'regular:' || shop.id::text
          else 'event:' || context.id::text end as queue_key,
        case when context.id is null then 'regular' else 'event' end as destination_kind,
        context.id as event_settlement_context_id,
        context.event_participation_id,
        context.service_date as settlement_service_date,
        context.settlement_policy_fingerprint,
        min(stop.event_job_name_snapshot) as event_name,
        min(stop.event_location_snapshot) as event_location,
        min(stop.event_zone_snapshot) as event_zone,
        min(stop.event_booth_snapshot) as event_booth,
        shop.id as shop_id,
        shop.code as shop_code,
        shop.name as shop_name,
        case when context.id is null then shop.building_id else null end as building_id,
        case when context.id is null then building.name else min(stop.event_location_snapshot) end as building_name,
        case when context.id is null then shop.zone_id else null end as zone_id,
        case when context.id is null then zone.name else min(stop.event_zone_snapshot) end as zone_name,
        case when context.id is null then shop.image_path else null end as image_path,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        count(*)::integer as charge_count,
        max(charge.created_at) as latest_charge_at,
        case when context.id is null then jsonb_build_object(
          'allowed_payment_methods', profile.allowed_payment_methods,
          'default_payment_method', profile.default_payment_method,
          'cash_reference_required', profile.cash_reference_required,
          'cash_evidence_required', profile.cash_evidence_required,
          'bank_transfer_reference_required', profile.bank_transfer_reference_required,
          'bank_transfer_evidence_required', profile.bank_transfer_evidence_required,
          'qr_reference_required', profile.qr_reference_required,
          'qr_evidence_required', profile.qr_evidence_required
        ) else jsonb_build_object(
          'allowed_payment_methods', participation.allowed_payment_methods_snapshot,
          'default_payment_method', participation.default_payment_method_snapshot,
          'cash_reference_required', participation.cash_reference_required_snapshot,
          'cash_evidence_required', participation.cash_evidence_required_snapshot,
          'bank_transfer_reference_required', participation.bank_transfer_reference_required_snapshot,
          'bank_transfer_evidence_required', participation.bank_transfer_evidence_required_snapshot,
          'qr_reference_required', participation.qr_reference_required_snapshot,
          'qr_evidence_required', participation.qr_evidence_required_snapshot
        ) end as payment_profile,
        (
          select max(payment.recorded_at)
          from public.payments payment
          where payment.collection_run_id = p_collection_run_id
            and payment.status = 'active'
            and payment.shop_id = shop.id
            and payment.event_settlement_context_id is not distinct from context.id
        ) as latest_payment_at,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id,
          'charge_number', charge.charge_number,
          'delivery_event_id', charge.delivery_event_id,
          'service_date', charge.service_date,
          'payment_term', charge.payment_term,
          'due_date', charge.due_date,
          'original_amount', public.effective_delivery_charge_amount(charge.id),
          'base_amount', charge.original_amount,
          'outstanding_amount', balance.outstanding_amount,
          'created_at', charge.created_at,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'ice_type_id', ice.id,
              'name', ice.name,
              'unit', ice.unit,
              'quantity', item.quantity,
              'line_total', item.line_total
            ) order by ice.code)
            from public.delivery_items item
            join public.ice_types ice on ice.id = item.ice_type_id
            where item.delivery_event_id = charge.delivery_event_id
          ), '[]'::jsonb)
        ) order by charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      join public.delivery_events event on event.id = charge.delivery_event_id
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.shops shop on shop.id = charge.shop_id
      left join public.buildings building on building.id = shop.building_id
      left join public.building_zones zone on zone.id = shop.zone_id
      left join public.shop_payment_profiles profile on profile.shop_id = shop.id
      left join public.event_settlement_contexts context
        on context.id = charge.event_settlement_context_id
      left join public.event_participations participation
        on participation.id = context.event_participation_id
      join lateral (
        select greatest(public.effective_delivery_charge_amount(charge.id)
          - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
          as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where public.is_charge_collectible_in_run(charge.id, p_collection_run_id)
        and balance.outstanding_amount > 0
        and (context.id is not null or profile.id is not null)
      group by shop.id, building.id, zone.id, profile.id, context.id, participation.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_today_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$ select public.get_collection_run_queue(p_collection_run_id) $$;

create or replace function public.financial_payment_request_fingerprint_v2(
  p_operation_kind text,
  p_payload jsonb
)
returns text
language sql
immutable
set search_path = public
as $$ select md5(jsonb_build_object('version', 2, 'operation_kind', p_operation_kind,
  'payload', p_payload)::text) $$;

create or replace function public.financial_payment_request_fingerprint_v1(p_payload jsonb)
returns text
language sql
immutable
set search_path = public
as $$ select md5(p_payload::text) $$;

-- The mature regular writer remains the new-write implementation. Patch only
-- its fingerprint assignment so new rows are truly version 2.
do $regular_payment_fingerprint_v2$
declare
  v_function regprocedure :=
    'public.record_payment_before_automatic_context(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure;
  v_definition text;
  v_patched text;
begin
  select pg_get_functiondef(v_function) into v_definition;
  v_patched := replace(v_definition,
    $old$  v_request_fingerprint := md5(jsonb_build_object(
    'shop_id', p_shop_id, 'allocations', p_allocations,
    'payment_method', p_payment_method, 'received_amount', p_received_amount::numeric(12,2),
    'reference_number', nullif(trim(coalesce(p_reference_number, '')), ''),
    'evidence_path', nullif(trim(coalesce(p_evidence_path, '')), ''),
    'collection_run_id', p_collection_run_id, 'approval_id', p_approval_id
  )::text);$old$,
    $new$  v_request_fingerprint := public.financial_payment_request_fingerprint_v2(
    'regular', jsonb_build_object(
      'shop_id', p_shop_id,
      'settlement_context_id', null,
      'allocations', p_allocations,
      'expected_outstanding_amount', p_expected_outstanding_amount::numeric(12,2),
      'payment_method', p_payment_method,
      'received_amount', p_received_amount::numeric(12,2),
      'reference_number', nullif(trim(coalesce(p_reference_number, '')), ''),
      'evidence_path', nullif(trim(coalesce(p_evidence_path, '')), ''),
      'collection_run_id', p_collection_run_id,
      'approval_id', p_approval_id
    )
  );$new$
  );
  if v_patched = v_definition then
    raise exception 'Could not install the regular payment v2 fingerprint';
  end if;
  execute v_patched;
end;
$regular_payment_fingerprint_v2$;

alter function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text,
  uuid, numeric, uuid, uuid
) rename to record_regular_payment_after_event_context;
revoke all on function public.record_regular_payment_after_event_context(
  uuid, jsonb, public.payment_method, numeric, text, text,
  uuid, numeric, uuid, uuid
) from public, anon, authenticated;

-- Replay is resolved before the current-run gate. Stored v1 payments retain
-- their exact legacy hash while every new regular payment is written as v2.
create function public.record_payment(
  p_shop_id uuid,
  p_allocations jsonb,
  p_payment_method public.payment_method,
  p_received_amount numeric,
  p_reference_number text,
  p_evidence_path text,
  p_collection_run_id uuid,
  p_expected_outstanding_amount numeric,
  p_approval_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_canonical_allocations jsonb;
  v_fingerprint_v1 text;
  v_fingerprint_v2 text;
begin
  if p_idempotency_key is null or p_shop_id is null or p_payment_method is null then
    raise exception 'Shop, payment method, and idempotency key are required';
  elsif jsonb_typeof(p_allocations) is distinct from 'array'
    or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Payment allocations must be a non-empty JSON array';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'charge_id', item.charge_id,
    'amount', item.amount::numeric(12,2)
  ) order by item.charge_id), '[]'::jsonb)
  into v_canonical_allocations
  from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric);

  v_fingerprint_v1 := public.financial_payment_request_fingerprint_v1(jsonb_build_object(
    'shop_id', p_shop_id,
    'allocations', v_canonical_allocations,
    'payment_method', p_payment_method,
    'received_amount', p_received_amount::numeric(12,2),
    'reference_number', nullif(trim(coalesce(p_reference_number, '')), ''),
    'evidence_path', nullif(trim(coalesce(p_evidence_path, '')), ''),
    'collection_run_id', p_collection_run_id,
    'approval_id', p_approval_id
  ));
  v_fingerprint_v2 := public.financial_payment_request_fingerprint_v2(
    'regular', jsonb_build_object(
      'shop_id', p_shop_id,
      'settlement_context_id', null,
      'allocations', v_canonical_allocations,
      'expected_outstanding_amount', p_expected_outstanding_amount::numeric(12,2),
      'payment_method', p_payment_method,
      'received_amount', p_received_amount::numeric(12,2),
      'reference_number', nullif(trim(coalesce(p_reference_number, '')), ''),
      'evidence_path', nullif(trim(coalesce(p_evidence_path, '')), ''),
      'collection_run_id', p_collection_run_id,
      'approval_id', p_approval_id
    )
  );

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_payment
  from public.payments payment
  where payment.idempotency_key = p_idempotency_key;
  if v_payment.id is not null then
    if not public.is_payment_visible(v_payment.id) then
      raise exception 'This payment cannot be viewed by the current user';
    elsif v_payment.operation_kind <> 'regular'
      or v_payment.event_settlement_context_id is not null
      or v_payment.shop_id is distinct from p_shop_id
      or v_payment.request_fingerprint is distinct from (case
        when v_payment.request_fingerprint_version = 1 then v_fingerprint_v1
        else v_fingerprint_v2
      end) then
      raise exception 'This idempotency key was already used for a different payment';
    end if;
    return public.financial_payment_response(v_payment.id);
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_canonical_allocations) requested(charge_id uuid, amount numeric)
    join public.delivery_charges charge on charge.id = requested.charge_id
    where charge.event_settlement_context_id is not null
  ) then
    raise exception 'Event charges require the event payment workflow';
  end if;

  return public.record_regular_payment_after_event_context(
    p_shop_id, v_canonical_allocations, p_payment_method, p_received_amount,
    p_reference_number, p_evidence_path, p_collection_run_id,
    p_expected_outstanding_amount, p_approval_id, p_idempotency_key
  );
end;
$$;

create or replace function public.record_event_payment(
  p_expected_settlement_context_id uuid,
  p_expected_participation_id uuid,
  p_expected_service_date date,
  p_expected_policy_fingerprint text,
  p_allocations jsonb,
  p_payment_method public.payment_method,
  p_received_amount numeric,
  p_reference_number text,
  p_evidence_path text,
  p_collection_run_id uuid,
  p_expected_outstanding_amount numeric,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_context public.event_settlement_contexts%rowtype;
  v_participation public.event_participations%rowtype;
  v_payment public.payments%rowtype;
  v_canonical_allocations jsonb;
  v_allocated_amount numeric(12,2);
  v_change_amount numeric(12,2);
  v_current_outstanding numeric(12,2);
  v_fingerprint text;
  v_allocation record;
  v_reference text := nullif(trim(coalesce(p_reference_number, '')), '');
  v_evidence text := nullif(trim(coalesce(p_evidence_path, '')), '');
begin
  if not public.is_active_user() or not public.can_collect_shop_payments() then
    raise exception 'The current user cannot collect event payments';
  elsif p_expected_settlement_context_id is null
    or p_expected_participation_id is null
    or p_expected_service_date is null
    or p_idempotency_key is null
    or p_payment_method is null then
    raise exception 'Event settlement identity, method, and idempotency key are required';
  elsif jsonb_typeof(p_allocations) is distinct from 'array'
    or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Payment allocations must be a non-empty JSON array';
  elsif p_received_amount is null or p_received_amount <= 0 then
    raise exception 'The received amount must be positive';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'charge_id', item.charge_id,
    'amount', item.amount::numeric(12,2)
  ) order by item.charge_id), '[]'::jsonb),
  coalesce(sum(item.amount), 0)::numeric(12,2)
  into v_canonical_allocations, v_allocated_amount
  from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric);

  if v_allocated_amount <= 0 or exists (
    select 1 from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric)
    where item.charge_id is null or item.amount is null or item.amount <= 0
  ) or exists (
    select 1 from jsonb_to_recordset(p_allocations) item(charge_id uuid, amount numeric)
    group by item.charge_id having count(*) > 1
  ) then
    raise exception 'Every allocation must have a distinct charge and positive amount';
  end if;

  v_change_amount := (p_received_amount - v_allocated_amount)::numeric(12,2);
  if v_change_amount < 0 then
    raise exception 'The received amount cannot be less than the allocated amount';
  elsif p_payment_method <> 'cash' and v_change_amount <> 0 then
    raise exception 'Only cash payments can include change';
  end if;

  v_fingerprint := public.financial_payment_request_fingerprint_v2('event', jsonb_build_object(
    'settlement_context_id', p_expected_settlement_context_id,
    'participation_id', p_expected_participation_id,
    'service_date', p_expected_service_date,
    'policy_fingerprint', p_expected_policy_fingerprint,
    'allocations', v_canonical_allocations,
    'expected_outstanding_amount', p_expected_outstanding_amount::numeric(12,2),
    'payment_method', p_payment_method,
    'received_amount', p_received_amount::numeric(12,2),
    'reference_number', v_reference,
    'evidence_path', v_evidence,
    'collection_run_id', p_collection_run_id
  ));

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_payment from public.payments payment
  where payment.idempotency_key = p_idempotency_key;
  if v_payment.id is not null then
    if not public.is_payment_visible(v_payment.id) then
      raise exception 'This payment cannot be viewed by the current user';
    elsif v_payment.operation_kind <> 'event'
      or v_payment.event_settlement_context_id is distinct from p_expected_settlement_context_id
      or v_payment.request_fingerprint is distinct from v_fingerprint then
      raise exception 'This idempotency key was already used for a different payment';
    end if;
    return public.financial_payment_response(v_payment.id);
  end if;

  select * into v_context from public.event_settlement_contexts context
  where context.id = p_expected_settlement_context_id;
  if v_context.id is null
    or v_context.event_participation_id is distinct from p_expected_participation_id
    or v_context.service_date is distinct from p_expected_service_date
    or v_context.settlement_policy_fingerprint is distinct from p_expected_policy_fingerprint then
    raise exception 'The event settlement context changed; refresh before recording payment';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_context.service_date::text, 0));
  select * into v_context from public.event_settlement_contexts context
  where context.id = p_expected_settlement_context_id for update;
  perform pg_advisory_xact_lock(
    hashtextextended('financial-shop:' || v_context.shop_id::text, 0)
  );
  perform pg_advisory_xact_lock_shared(
    hashtextextended('collection-run:' || v_context.service_date::text, 0)
  );

  if p_collection_run_id is null or not exists (
    select 1 from public.collection_runs run
    where run.id = p_collection_run_id
      and run.status = 'open'
      and run.service_date = v_context.service_date
      and run.service_date = (clock_timestamp() at time zone 'Asia/Bangkok')::date
  ) or exists (
    select 1 from public.daily_aggregate_stock_closures closure
    where closure.service_date = v_context.service_date
  ) then
    raise exception 'The collection context is stale or closed';
  end if;

  select * into v_participation from public.event_participations participation
  where participation.id = v_context.event_participation_id;
  if not (p_payment_method = any(v_participation.allowed_payment_methods_snapshot)) then
    raise exception 'The selected payment method is not allowed for this event';
  elsif ((p_payment_method = 'cash' and v_participation.cash_reference_required_snapshot)
    or (p_payment_method = 'bank_transfer' and v_participation.bank_transfer_reference_required_snapshot)
    or (p_payment_method = 'qr' and v_participation.qr_reference_required_snapshot))
    and v_reference is null then
    raise exception 'A payment reference is required for this method';
  elsif ((p_payment_method = 'cash' and v_participation.cash_evidence_required_snapshot)
    or (p_payment_method = 'bank_transfer' and v_participation.bank_transfer_evidence_required_snapshot)
    or (p_payment_method = 'qr' and v_participation.qr_evidence_required_snapshot))
    and v_evidence is null then
    raise exception 'Payment evidence is required for this method';
  elsif v_evidence is not null and not exists (
    select 1 from storage.objects evidence
    where evidence.bucket_id = 'payment-evidence'
      and evidence.name = v_evidence
      and (storage.foldername(evidence.name))[1] = auth.uid()::text
  ) then
    raise exception 'Payment evidence does not exist or does not belong to the current user';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_canonical_allocations) requested(charge_id uuid, amount numeric)
    left join public.delivery_charges charge on charge.id = requested.charge_id
    where charge.id is null
      or charge.status <> 'active'
      or charge.event_settlement_context_id is distinct from v_context.id
      or not public.is_charge_collectible_in_run(charge.id, p_collection_run_id)
  ) then
    raise exception 'Every allocation must target an active charge in this event settlement';
  end if;

  select coalesce(sum(greatest(public.effective_delivery_charge_amount(charge.id)
    - coalesce(active_allocations.amount, 0), 0)), 0)::numeric(12,2)
  into v_current_outstanding
  from public.delivery_charges charge
  left join lateral (
    select coalesce(sum(allocation.amount), 0)::numeric(12,2) as amount
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = charge.id and payment.status = 'active'
  ) active_allocations on true
  where charge.event_settlement_context_id = v_context.id
    and charge.status = 'active'
    and public.is_charge_collectible_in_run(charge.id, p_collection_run_id);

  if p_expected_outstanding_amount is not null
    and v_current_outstanding <> p_expected_outstanding_amount::numeric(12,2) then
    raise exception 'The outstanding amount changed; refresh before recording payment';
  elsif v_allocated_amount > v_current_outstanding then
    raise exception 'Payment allocations cannot exceed the event outstanding amount';
  end if;

  for v_allocation in
    select item.charge_id, item.amount::numeric(12,2) as amount
    from jsonb_to_recordset(v_canonical_allocations) item(charge_id uuid, amount numeric)
    order by item.charge_id
  loop
    if v_allocation.amount > (
      select greatest(public.effective_delivery_charge_amount(charge.id)
        - coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
      from public.delivery_charges charge
      left join public.payment_allocations allocation on allocation.charge_id = charge.id
      left join public.payments payment on payment.id = allocation.payment_id
      where charge.id = v_allocation.charge_id group by charge.id
    ) then
      raise exception 'An allocation cannot exceed the latest charge balance';
    end if;
  end loop;

  insert into public.payments (
    shop_id, collection_run_id, payment_method, received_amount,
    allocated_amount, change_amount, reference_number, evidence_path,
    idempotency_key, request_fingerprint, recorded_by,
    operation_kind, event_settlement_context_id, request_fingerprint_version
  ) values (
    v_context.shop_id, p_collection_run_id, p_payment_method,
    p_received_amount::numeric(12,2), v_allocated_amount, v_change_amount,
    v_reference, v_evidence, p_idempotency_key, v_fingerprint, auth.uid(),
    'event', v_context.id, 2
  ) returning * into v_payment;

  insert into public.payment_allocations (payment_id, charge_id, amount)
  select v_payment.id, item.charge_id, item.amount::numeric(12,2)
  from jsonb_to_recordset(v_canonical_allocations) item(charge_id uuid, amount numeric);

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (auth.uid(), 'payments', v_payment.id, 'event_created', jsonb_build_object(
    'event_settlement_context_id', v_context.id,
    'event_participation_id', v_context.event_participation_id,
    'service_date', v_context.service_date,
    'allocations', v_canonical_allocations
  ));
  return public.financial_payment_response(v_payment.id);
end;
$$;

create or replace function public.get_payment_history(
  p_from_date date,
  p_to_date date,
  p_page_size integer default 50,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_items jsonb;
  v_next_recorded_at timestamptz;
  v_next_id uuid;
  v_has_more boolean;
  v_summary jsonb;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required to view payment history';
  elsif p_from_date is null or p_to_date is null
    or p_to_date < p_from_date or p_to_date - p_from_date > 30 then
    raise exception 'Payment history requires a valid range of at most 31 days';
  elsif p_page_size not between 1 and 100 then
    raise exception 'Payment history page size must be between 1 and 100';
  elsif (p_before_recorded_at is null) <> (p_before_id is null) then
    raise exception 'Payment history cursor fields must be supplied together';
  end if;

  v_start := p_from_date::timestamp at time zone 'Asia/Bangkok';
  v_end := (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok';
  if p_before_recorded_at is not null
    and (p_before_recorded_at < v_start or p_before_recorded_at >= v_end) then
    raise exception 'Payment history cursor is outside the requested range';
  end if;

  with visible as (
    select payment.*,
      shop.code as shop_code,
      shop.name as shop_name,
      context.event_participation_id,
      context.service_date as settlement_service_date,
      stop.event_job_name_snapshot as event_name,
      stop.event_location_snapshot as event_location,
      stop.event_zone_snapshot as event_zone,
      stop.event_booth_snapshot as event_booth
    from public.payments payment
    join public.shops shop on shop.id = payment.shop_id
    left join public.event_settlement_contexts context
      on context.id = payment.event_settlement_context_id
    left join lateral (
      select stop.*
      from public.payment_allocations allocation
      join public.delivery_charges charge on charge.id = allocation.charge_id
      join public.delivery_events event on event.id = charge.delivery_event_id
      join public.round_stops stop on stop.id = event.round_stop_id
      where allocation.payment_id = payment.id
      order by charge.created_at, charge.id
      limit 1
    ) stop on true
    where payment.recorded_at >= v_start
      and payment.recorded_at < v_end
      and public.is_payment_visible(payment.id)
  ), page as (
    select * from visible
    where p_before_recorded_at is null
      or (recorded_at, id) < (p_before_recorded_at, p_before_id)
    order by recorded_at desc, id desc
    limit p_page_size + 1
  ), returned as (
    select * from page order by recorded_at desc, id desc limit p_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', returned.id,
    'receipt_number', returned.receipt_number,
    'received_amount', returned.received_amount,
    'allocated_amount', returned.allocated_amount,
    'change_amount', returned.change_amount,
    'payment_method', returned.payment_method,
    'status', returned.status,
    'recorded_at', returned.recorded_at,
    'recorded_by', returned.recorded_by,
    'void_reason', returned.void_reason,
    'destination_kind', returned.operation_kind,
    'event_settlement_context_id', returned.event_settlement_context_id,
    'event_participation_id', returned.event_participation_id,
    'settlement_service_date', returned.settlement_service_date,
    'event_name', returned.event_name,
    'event_location', returned.event_location,
    'event_zone', returned.event_zone,
    'event_booth', returned.event_booth,
    'shops', jsonb_build_object('code', returned.shop_code, 'name', returned.shop_name)
  ) order by returned.recorded_at desc, returned.id desc), '[]'::jsonb)
  into v_items from returned;

  with visible as (
    select payment.*
    from public.payments payment
    where payment.recorded_at >= v_start
      and payment.recorded_at < v_end
      and public.is_payment_visible(payment.id)
  )
  select jsonb_build_object(
    'visible_payment_count', count(*),
    'active_payment_count', count(*) filter (where status = 'active'),
    'active_allocated_amount', coalesce(sum(allocated_amount) filter (where status = 'active'), 0),
    'active_cash_amount', coalesce(sum(allocated_amount) filter (
      where status = 'active' and payment_method = 'cash'), 0),
    'active_non_cash_amount', coalesce(sum(allocated_amount) filter (
      where status = 'active' and payment_method <> 'cash'), 0)
  ) into v_summary from visible;

  with page as (
    select payment.recorded_at, payment.id
    from public.payments payment
    where payment.recorded_at >= v_start
      and payment.recorded_at < v_end
      and public.is_payment_visible(payment.id)
      and (p_before_recorded_at is null
        or (payment.recorded_at, payment.id) < (p_before_recorded_at, p_before_id))
    order by payment.recorded_at desc, payment.id desc
    limit p_page_size + 1
  ), numbered as (
    select *, row_number() over (order by recorded_at desc, id desc) as row_number
    from page
  )
  select count(*) > p_page_size,
    max(recorded_at) filter (where row_number = p_page_size),
    (array_agg(id) filter (where row_number = p_page_size))[1]
  into v_has_more, v_next_recorded_at, v_next_id
  from numbered;

  return jsonb_build_object(
    'items', v_items,
    'next_cursor', case when v_has_more then jsonb_build_object(
      'recorded_at', v_next_recorded_at, 'id', v_next_id
    ) else null end,
    'range_summary', v_summary
  );
end;
$$;

create or replace function public.build_charge_print_document(p_charge_id uuid)
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
    'shop_location', case when stop.destination_kind = 'event'
      then nullif(concat_ws(' · ', stop.event_job_name_snapshot,
        stop.event_location_snapshot, stop.event_zone_snapshot, stop.event_booth_snapshot), '')
      else nullif(concat_ws(' · ', stop.building_name_snapshot,
        stop.floor_or_zone_snapshot), '') end,
    'destination_kind', stop.destination_kind,
    'event_settlement_context_id', charge.event_settlement_context_id,
    'event_participation_id', context.event_participation_id,
    'settlement_policy_fingerprint', context.settlement_policy_fingerprint,
    'event_name', stop.event_job_name_snapshot,
    'event_location', stop.event_location_snapshot,
    'event_zone', stop.event_zone_snapshot,
    'event_booth', stop.event_booth_snapshot,
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
  left join public.event_settlement_contexts context
    on context.id = charge.event_settlement_context_id
  where charge.id = p_charge_id and charge.charge_number is not null;
$$;

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
    'document_title', case when bool_and(charge.payment_term = 'immediate')
      then 'ใบส่งของ / ใบเสร็จรับเงิน' else 'ใบเสร็จรับเงิน' end,
    'payment_term', case when count(distinct charge.payment_term) = 1
      then min(charge.payment_term::text) else null end,
    'shop_code', shop.code,
    'shop_name', shop.name,
    'shop_location', case when payment.operation_kind = 'event'
      then nullif(concat_ws(' · ', min(stop.event_job_name_snapshot),
        min(stop.event_location_snapshot), min(stop.event_zone_snapshot),
        min(stop.event_booth_snapshot)), '')
      else nullif(concat_ws(' · ', min(stop.building_name_snapshot),
        min(stop.floor_or_zone_snapshot)), '') end,
    'service_date', min(charge.service_date),
    'payment_method', payment.payment_method,
    'received_amount', payment.received_amount,
    'allocated_amount', payment.allocated_amount,
    'change_amount', payment.change_amount,
    'recorded_at', payment.recorded_at,
    'destination_kind', payment.operation_kind,
    'event_settlement_context_id', payment.event_settlement_context_id,
    'event_participation_id', context.event_participation_id,
    'settlement_policy_fingerprint', context.settlement_policy_fingerprint,
    'event_name', min(stop.event_job_name_snapshot),
    'event_location', min(stop.event_location_snapshot),
    'event_zone', min(stop.event_zone_snapshot),
    'event_booth', min(stop.event_booth_snapshot),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_number', charge_detail.charge_number,
        'payment_term', charge_detail.payment_term,
        'service_date', charge_detail.service_date,
        'event_settlement_context_id', charge_detail.event_settlement_context_id,
        'location', case when stop_detail.destination_kind = 'event'
          then nullif(concat_ws(' · ', stop_detail.event_job_name_snapshot,
            stop_detail.event_location_snapshot, stop_detail.event_zone_snapshot,
            stop_detail.event_booth_snapshot), '')
          else nullif(concat_ws(' · ', stop_detail.building_name_snapshot,
            stop_detail.floor_or_zone_snapshot), '') end,
        'received_amount', allocation.amount,
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
          where item.delivery_event_id = charge_detail.delivery_event_id
        ), '[]'::jsonb)
      ) order by charge_detail.created_at, charge_detail.id)
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
  left join public.event_settlement_contexts context
    on context.id = payment.event_settlement_context_id
  where payment.id = p_payment_id
  group by payment.id, shop.id, context.id;
$$;

create or replace function public.get_delivery_correction_route(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_kind public.round_destination_kind;
begin
  if not public.is_active_user() or not public.is_delivery_event_visible(p_event_id) then
    raise exception 'This delivery cannot be viewed by the current user';
  end if;
  select stop.destination_kind into v_kind
  from public.delivery_events event
  join public.round_stops stop on stop.id = event.round_stop_id
  where event.id = p_event_id;
  if v_kind is null then raise exception 'The selected delivery event does not exist'; end if;
  return jsonb_build_object('destination_kind', v_kind);
end;
$$;

create or replace function public.get_event_delivery_correction_context(p_event_id uuid)
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
    or not public.is_delivery_event_visible(p_event_id)
  then
    raise exception 'This event delivery cannot be viewed by the current user';
  end if;

  if not exists (
    select 1 from public.delivery_events event
    join public.round_stops stop on stop.id = event.round_stop_id
    where event.id = p_event_id and stop.destination_kind = 'event'
  ) then raise exception 'The selected delivery is not an event delivery'; end if;
  perform set_config('app.event_correction_id', p_event_id::text, true);
  v_result := public.get_delivery_correction_context(p_event_id);
  return v_result || jsonb_build_object(
    'destination_kind', 'event',
    'event_settlement_context_id', (
      select charge.event_settlement_context_id
      from public.delivery_charges charge where charge.delivery_event_id = p_event_id
    ),
    'event_participation_id', (
      select stop.event_participation_id
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      where event.id = p_event_id
    )
  );
end;
$$;

create or replace function public.preview_event_delivery_correction(
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
begin
  perform public.get_event_delivery_correction_context(p_event_id);
  perform set_config('app.event_correction_id', p_event_id::text, true);
  return public.preview_delivery_correction(
    p_event_id, p_action, p_items, p_stop_status
  ) || jsonb_build_object('destination_kind', 'event');
end;
$$;

create or replace function public.apply_event_delivery_intake_correction(
  p_event_id uuid,
  p_items jsonb,
  p_note text,
  p_reason text,
  p_idempotency_key uuid
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
  v_participation public.event_participations%rowtype;
  v_job public.event_jobs%rowtype;
  v_service_date date;
  v_participation_id uuid;
  v_job_id uuid;
  v_canonical_items jsonb;
  v_revision_fingerprint text;
  v_delivery jsonb;
  v_new_event_id uuid;
  v_new_charge_id uuid;
begin
  if p_idempotency_key is null
    or nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'An idempotency key and correction reason are required';
  elsif jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Correction items must be an array';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'ice_type_id', item.ice_type_id, 'quantity', item.quantity
  ) order by item.ice_type_id), '[]'::jsonb)
  into v_canonical_items
  from jsonb_to_recordset(p_items) item(ice_type_id uuid, quantity numeric);
  v_revision_fingerprint := md5(jsonb_build_object(
    'event_id', p_event_id,
    'action', 'correct',
    'items', v_canonical_items,
    'stop_status', 'delivered'::public.shop_round_status,
    'note', nullif(trim(coalesce(p_note, '')), ''),
    'reason', trim(p_reason),
    'approval_id', null
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select revision.* into v_existing
  from public.delivery_event_revisions revision
  where revision.idempotency_key = p_idempotency_key;
  if v_existing.idempotency_key is not null then
    if not public.is_delivery_event_visible(v_existing.original_event_id) then
      raise exception 'This delivery correction cannot be viewed by the current user';
    elsif v_existing.original_event_id is distinct from p_event_id
      or v_existing.action <> 'correct'
      or v_existing.request_fingerprint is distinct from v_revision_fingerprint then
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
  from public.delivery_events event
  where event.id = p_event_id;
  select round.service_date, stop.event_participation_id,
    participation.event_job_id
  into v_service_date, v_participation_id, v_job_id
  from public.delivery_events event
  join public.round_stops stop on stop.id = event.round_stop_id
  join public.delivery_rounds round on round.id = stop.round_id
  join public.event_participations participation
    on participation.id = stop.event_participation_id
  where event.id = p_event_id and stop.destination_kind = 'event';

  if v_event.id is null or not public.is_delivery_event_visible(p_event_id) then
    raise exception 'This event delivery cannot be viewed by the current user';
  elsif public.current_app_role() not in ('courier', 'round_lead', 'admin') then
    raise exception 'The current user cannot correct this event delivery';
  elsif public.current_app_role() = 'courier' and v_event.recorded_by <> auth.uid() then
    raise exception 'Couriers can only correct deliveries they recorded';
  end if;

  if not public.lock_event_ice_delivery_write_eligibility(v_participation_id) then
    raise exception 'Event ice delivery is not enabled for this participation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));

  select round.* into v_round
  from public.delivery_rounds round
  where round.id = (select stop.round_id from public.round_stops stop
    where stop.id = v_event.round_stop_id)
  for update;
  select job.* into v_job
  from public.event_jobs job where job.id = v_job_id for update;
  select participation.* into v_participation
  from public.event_participations participation
  where participation.id = v_participation_id for update;
  select stop.* into v_stop
  from public.round_stops stop where stop.id = v_event.round_stop_id for update;
  select event.* into v_event
  from public.delivery_events event where event.id = p_event_id for update;

  if v_event.status <> 'active'
    or v_event.round_stop_id is distinct from v_stop.id
    or exists (select 1 from public.delivery_charges charge
      where charge.delivery_event_id = v_event.id) then
    raise exception 'The source event is no longer an unbilled active delivery';
  end if;

  v_delivery := public.record_event_ice_delivery(
    v_stop.id, v_canonical_items, 'delivered', p_note, clock_timestamp(),
    p_idempotency_key
  );
  v_new_event_id := (v_delivery ->> 'delivery_event_id')::uuid;
  v_new_charge_id := (v_delivery ->> 'charge_id')::uuid;
  if v_new_event_id is null or v_new_charge_id is null then
    raise exception 'The event correction did not create a financial delivery';
  end if;

  update public.delivery_events
  set corrects_event_id = v_event.id
  where id = v_new_event_id;
  update public.delivery_events
  set status = 'cancelled',
      cancelled_by = auth.uid(),
      cancelled_at = now(),
      cancellation_reason = trim(p_reason)
  where id = v_event.id;

  insert into public.delivery_event_revisions (
    idempotency_key, original_event_id, replacement_event_id,
    action, reason, revised_by, request_fingerprint
  ) values (
    p_idempotency_key, v_event.id, v_new_event_id,
    'correct', trim(p_reason), auth.uid(), v_revision_fingerprint
  );
  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value, reason
  ) values (
    auth.uid(), 'delivery_events', v_event.id, 'event_intake_corrected',
    jsonb_build_object('charge_id', null),
    jsonb_build_object('replacement_event_id', v_new_event_id,
      'replacement_charge_id', v_new_charge_id),
    trim(p_reason)
  );

  return jsonb_build_object(
    'original_event_id', v_event.id,
    'replacement_event_id', v_new_event_id,
    'original_charge_id', null,
    'replacement_charge_id', v_new_charge_id,
    'action', 'correct',
    'new_amount', (v_delivery ->> 'total_amount')::numeric,
    'refund_amount', 0,
    'outstanding_amount', (v_delivery ->> 'total_amount')::numeric
  );
end;
$$;

create or replace function public.apply_open_event_delivery_correction(
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
begin
  if p_approval_id is not null then
    raise exception 'Event end-of-day corrections do not use shop financial approvals';
  end if;
  if p_action = 'correct' and p_stop_status = 'delivered'
    and exists (
      select 1
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      where event.id = p_event_id and stop.destination_kind = 'event'
    )
    and not exists (
      select 1 from public.delivery_charges charge
      where charge.delivery_event_id = p_event_id
    ) then
    return public.apply_event_delivery_intake_correction(
      p_event_id, p_items, p_note, p_reason, p_idempotency_key
    );
  end if;
  perform public.get_event_delivery_correction_context(p_event_id);
  perform set_config('app.event_correction_id', p_event_id::text, true);
  return public.apply_open_delivery_correction(
    p_event_id, p_action, p_items, p_stop_status, p_note, p_reason,
    p_idempotency_key, null
  );
end;
$$;

create or replace function public.create_closed_event_delivery_adjustment(
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
begin
  perform public.get_event_delivery_correction_context(p_event_id);
  perform set_config('app.event_correction_id', p_event_id::text, true);
  return public.create_closed_delivery_adjustment(
    p_event_id, p_items, p_reason, p_idempotency_key
  );
end;
$$;

create or replace function public.get_payment_correction_targets(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view payment correction targets';
  elsif p_payment_id is null or not exists (
    select 1 from public.payments payment where payment.id = p_payment_id
  ) then
    raise exception 'The selected payment does not exist';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'charge_id', charge.id,
      'charge_number', charge.charge_number,
      'delivery_event_id', event.id,
      'destination_kind', stop.destination_kind,
      'event_settlement_context_id', charge.event_settlement_context_id,
      'event_participation_id', stop.event_participation_id,
      'settlement_service_date', charge.service_date,
      'payment_allocated_amount', target_allocation.amount,
      'allocated_amount', balance.allocated_amount,
      'effective_amount', public.effective_delivery_charge_amount(charge.id)
    ) order by charge.service_date, charge.created_at, charge.id)
    from public.payment_allocations target_allocation
    join public.payments target_payment on target_payment.id = target_allocation.payment_id
    join public.delivery_charges charge on charge.id = target_allocation.charge_id
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.delivery_rounds round on round.id = stop.round_id
    join lateral (
      select coalesce(sum(allocation.amount), 0)::numeric(12,2) as allocated_amount
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = charge.id and payment.status = 'active'
    ) balance on true
    where target_payment.id = p_payment_id
      and target_payment.status = 'active'
      and charge.status = 'active'
      and event.status = 'active'
      and public.effective_delivery_charge_amount(charge.id) > 0
      and balance.allocated_amount >= public.effective_delivery_charge_amount(charge.id)
      and not exists (
        select 1 from public.refund_obligations obligation
        where obligation.source_charge_id = charge.id and obligation.status = 'pending'
      )
      and (public.current_app_role() = 'admin' or (
        round.status = 'open'
        and not exists (select 1 from public.daily_stock_closures closure
          where closure.service_date = round.service_date and closure.status = 'closed')
        and not exists (select 1 from public.daily_aggregate_stock_closures closure
          where closure.service_date = round.service_date and closure.status = 'closed')
      ))
  ), '[]'::jsonb);
end;
$$;

-- Refund servicing remains available after an event is disabled and carries
-- the immutable settlement identity needed by the desk to distinguish an
-- event refund from a regular-shop refund.
create or replace function public.get_refund_queue(p_pending_only boolean default true)
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
      'destination_kind', payment.operation_kind,
      'event_settlement_context_id', payment.event_settlement_context_id,
      'event_participation_id', context.event_participation_id,
      'settlement_service_date', context.service_date,
      'event_name', stop.event_job_name_snapshot,
      'event_location', stop.event_location_snapshot,
      'event_zone', stop.event_zone_snapshot,
      'event_booth', stop.event_booth_snapshot,
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
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.round_stops stop on stop.id = event.round_stop_id
    left join public.event_settlement_contexts context
      on context.id = payment.event_settlement_context_id
    left join public.refund_settlements settlement on settlement.obligation_id = obligation.id
    left join public.users settler on settler.id = settlement.settled_by
    where not p_pending_only or obligation.status = 'pending'
  ), '[]'::jsonb);
end;
$$;

-- Preserve the canonical accounting union and enrich its JSON details instead
-- of changing the long-lived tabular contract. This keeps existing filters and
-- aggregate formulae intact while making event identity exportable.
alter function public.accounting_transaction_rows(date, date)
  rename to accounting_transaction_rows_without_event_context;

create function public.accounting_transaction_rows(
  p_from_date date,
  p_to_date date
)
returns table (
  occurred_at timestamptz,
  service_date date,
  type text,
  group_id uuid,
  source_id uuid,
  source_table text,
  delivery_event_id uuid,
  payment_id uuid,
  document_number text,
  reference_number text,
  shop_id uuid,
  shop_code text,
  shop_name text,
  holder_name text,
  employee_id uuid,
  employee_name text,
  ice_type_id uuid,
  ice_type_name text,
  unit text,
  quantity_in numeric,
  quantity_out numeric,
  sales_amount numeric,
  cash_in numeric,
  cash_out numeric,
  receivable_delta numeric,
  status text,
  note text,
  issue_code text,
  issue_label text,
  can_correct boolean,
  details jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    row.occurred_at, row.service_date, row.type, row.group_id, row.source_id,
    row.source_table, row.delivery_event_id, row.payment_id, row.document_number,
    row.reference_number, row.shop_id, row.shop_code, row.shop_name,
    row.holder_name, row.employee_id, row.employee_name, row.ice_type_id,
    row.ice_type_name, row.unit, row.quantity_in, row.quantity_out,
    row.sales_amount, row.cash_in, row.cash_out, row.receivable_delta,
    row.status, row.note, row.issue_code, row.issue_label, row.can_correct,
    row.details || case when identity.event_settlement_context_id is null
      then jsonb_build_object('destination_kind', 'regular')
      else jsonb_build_object(
        'destination_kind', 'event',
        'event_settlement_context_id', identity.event_settlement_context_id,
        'event_participation_id', context.event_participation_id,
        'settlement_service_date', context.service_date,
        'settlement_policy_fingerprint', context.settlement_policy_fingerprint,
        'event_name', coalesce(snapshot.receipt_data ->> 'event_name', stop.event_job_name_snapshot),
        'event_location', coalesce(snapshot.receipt_data ->> 'event_location', stop.event_location_snapshot),
        'event_zone', coalesce(snapshot.receipt_data ->> 'event_zone', stop.event_zone_snapshot),
        'event_booth', coalesce(snapshot.receipt_data ->> 'event_booth', stop.event_booth_snapshot)
      ) end
  from public.accounting_transaction_rows_without_event_context(p_from_date, p_to_date) row
  left join public.payments payment on payment.id = row.payment_id
  left join public.payment_receipt_snapshots snapshot on snapshot.payment_id = payment.id
  left join lateral (
    select charge.event_settlement_context_id, charge.delivery_event_id
    from public.delivery_charges charge
    where charge.id = case when row.source_table = 'delivery_charges' then row.source_id end
      or charge.delivery_event_id = row.delivery_event_id
    order by (charge.id = row.source_id) desc, charge.created_at, charge.id
    limit 1
  ) charge_identity on true
  left join lateral (
    select coalesce(payment.event_settlement_context_id,
      charge_identity.event_settlement_context_id) as event_settlement_context_id,
      coalesce(row.delivery_event_id, charge_identity.delivery_event_id) as delivery_event_id
  ) identity on true
  left join public.event_settlement_contexts context
    on context.id = identity.event_settlement_context_id
  left join public.delivery_events event on event.id = identity.delivery_event_id
  left join public.round_stops stop on stop.id = event.round_stop_id;
$$;

do $accounting_invoice_event_projection$
declare
  v_definition text;
  v_patched text;
begin
  select pg_get_functiondef(
    'public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'::regprocedure
  ) into v_definition;

  v_patched := replace(v_definition,
    $needle$        current_zone.name as current_zone_name$needle$,
    $replacement$        current_zone.name as current_zone_name,
        stop.destination_kind,
        charge.event_settlement_context_id,
        stop.event_participation_id,
        stop.event_job_name_snapshot as event_name,
        stop.event_location_snapshot as event_location,
        stop.event_zone_snapshot as event_zone,
        stop.event_booth_snapshot as event_booth$replacement$
  );
  if v_patched = v_definition then
    raise exception 'Cannot patch accounting invoice facts with event context';
  end if;
  v_definition := v_patched;

  v_patched := replace(v_definition,
    $needle$      'current_zone_name', invoice.current_zone_name,
      'items',$needle$,
    $replacement$      'current_zone_name', invoice.current_zone_name,
      'destination_kind', invoice.destination_kind,
      'event_settlement_context_id', invoice.event_settlement_context_id,
      'event_participation_id', invoice.event_participation_id,
      'event_name', invoice.event_name,
      'event_location', invoice.event_location,
      'event_zone', invoice.event_zone,
      'event_booth', invoice.event_booth,
      'items',$replacement$
  );
  if v_patched = v_definition then
    raise exception 'Cannot patch accounting invoice JSON with event context';
  end if;

  execute v_patched;
end;
$accounting_invoice_event_projection$;

-- Keep intake dark for the client/pilot deploy. Version 7 means every
-- financial and routing contract above is present.
update public.event_delivery_feature_settings
set schema_version = greatest(schema_version, 7),
    event_ice_delivery_enabled = false,
    updated_at = now()
where singleton;

revoke all on function public.protect_payment_settlement_identity() from public, anon, authenticated;
revoke all on function public.financial_payment_request_fingerprint_v1(jsonb) from public, anon, authenticated;
revoke all on function public.financial_payment_request_fingerprint_v2(text, jsonb) from public, anon, authenticated;
revoke all on function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text,
  uuid, numeric, uuid, uuid
) from public, anon;
revoke all on function public.accounting_transaction_rows_without_event_context(date, date)
  from public, anon, authenticated;
revoke all on function public.accounting_transaction_rows(date, date)
  from public, anon, authenticated;
revoke all on function public.enable_event_ice_delivery_pilot(uuid, timestamptz) from public, anon;
revoke all on function public.disable_event_ice_delivery_pilot(uuid) from public, anon;
revoke all on function public.record_event_payment(
  uuid, uuid, date, text, jsonb, public.payment_method, numeric,
  text, text, uuid, numeric, uuid
) from public, anon;
revoke all on function public.get_payment_history(date, date, integer, timestamptz, uuid)
  from public, anon;
revoke all on function public.get_delivery_correction_route(uuid) from public, anon;
revoke all on function public.get_event_delivery_correction_context(uuid) from public, anon;
revoke all on function public.preview_event_delivery_correction(
  uuid, text, jsonb, public.shop_round_status
) from public, anon;
revoke all on function public.apply_event_delivery_intake_correction(
  uuid, jsonb, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.apply_open_event_delivery_correction(
  uuid, text, jsonb, public.shop_round_status, text, text, uuid, uuid
) from public, anon;
revoke all on function public.create_closed_event_delivery_adjustment(uuid, jsonb, text, uuid)
  from public, anon;

grant execute on function public.enable_event_ice_delivery_pilot(uuid, timestamptz)
  to authenticated;
grant execute on function public.disable_event_ice_delivery_pilot(uuid)
  to authenticated;
grant execute on function public.record_payment(
  uuid, jsonb, public.payment_method, numeric, text, text,
  uuid, numeric, uuid, uuid
) to authenticated;
grant execute on function public.record_event_payment(
  uuid, uuid, date, text, jsonb, public.payment_method, numeric,
  text, text, uuid, numeric, uuid
) to authenticated;
grant execute on function public.get_payment_history(date, date, integer, timestamptz, uuid)
  to authenticated;
grant execute on function public.get_delivery_correction_route(uuid) to authenticated;
grant execute on function public.get_event_delivery_correction_context(uuid) to authenticated;
grant execute on function public.preview_event_delivery_correction(
  uuid, text, jsonb, public.shop_round_status
) to authenticated;
grant execute on function public.apply_open_event_delivery_correction(
  uuid, text, jsonb, public.shop_round_status, text, text, uuid, uuid
) to authenticated;
grant execute on function public.create_closed_event_delivery_adjustment(uuid, jsonb, text, uuid)
  to authenticated;

notify pgrst, 'reload schema';
