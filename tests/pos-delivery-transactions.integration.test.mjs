import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const foundation = readFileSync(
  new URL('../supabase/migrations/0029_pos_financial_foundation.sql', import.meta.url),
  'utf8',
);
const transactions = readFileSync(
  new URL('../supabase/migrations/0030_pos_delivery_transactions.sql', import.meta.url),
  'utf8',
);
const operations = readFileSync(
  new URL('../supabase/migrations/0059_pos_financial_operations.sql', import.meta.url),
  'utf8',
);
const legacyRecordPayment = operations.slice(
  operations.indexOf('create or replace function public.record_payment('),
  operations.indexOf('revoke all on function public.record_payment('),
);
const recovery = readFileSync(
  new URL('../supabase/migrations/0060_recoverable_collection_balances.sql', import.meta.url),
  'utf8',
);
const collectorAccess = readFileSync(
  new URL('../supabase/migrations/0102_collection_collector_access.sql', import.meta.url),
  'utf8',
);
const adminBackdatedBilling = readFileSync(
  new URL('../supabase/migrations/0106_admin_backdated_billing.sql', import.meta.url),
  'utf8',
);
const dailyAggregateStock = readFileSync(
  new URL('../supabase/migrations/0107_daily_aggregate_stock.sql', import.meta.url),
  'utf8',
);
const dailyAggregateCompletion = readFileSync(
  new URL('../supabase/migrations/0108_finish_daily_aggregate_workflow.sql', import.meta.url),
  'utf8',
);
const collectionShopCardsAndChargeNumbers = readFileSync(
  new URL('../supabase/migrations/0109_collection_shop_cards_and_charge_numbers.sql', import.meta.url),
  'utf8',
);
const paymentReceiptNumbers = readFileSync(
  new URL('../supabase/migrations/0110_payment_receipt_numbers.sql', import.meta.url),
  'utf8',
);
const collectionCarryForwardBalances = readFileSync(
  new URL('../supabase/migrations/0115_collection_carry_forward_balances.sql', import.meta.url),
  'utf8',
);
const collectionQueueChargeItems = readFileSync(
  new URL('../supabase/migrations/0117_collection_queue_charge_items.sql', import.meta.url),
  'utf8',
);
const deliveryFinancialResponseItemLabels = readFileSync(
  new URL('../supabase/migrations/0118_delivery_financial_response_item_labels.sql', import.meta.url),
  'utf8',
);
const creditCollectionsAndDueDateExtensions = readFileSync(
  new URL('../supabase/migrations/0120_credit_collections_and_due_date_extensions.sql', import.meta.url),
  'utf8',
);
const disableDailyStockRefill = readFileSync(
  new URL('../supabase/migrations/0121_disable_daily_stock_refill.sql', import.meta.url),
  'utf8',
);
const creditAccountManagement = readFileSync(
  new URL('../supabase/migrations/0122_credit_account_management.sql', import.meta.url),
  'utf8',
);
const courierPaymentVoids = readFileSync(
  new URL('../supabase/migrations/0123_allow_couriers_to_void_own_payments.sql', import.meta.url),
  'utf8',
);
const paymentReceiptSnapshots = readFileSync(
  new URL('../supabase/migrations/0124_payment_receipt_snapshots.sql', import.meta.url),
  'utf8',
);
const weeklyCreditDueRule = readFileSync(
  new URL('../supabase/migrations/0125_add_weekly_credit_due_rule.sql', import.meta.url),
  'utf8',
);
const creditCollectionCycles = readFileSync(
  new URL('../supabase/migrations/0126_credit_collection_cycles.sql', import.meta.url),
  'utf8',
);
const creditBillDeliveryDetails = readFileSync(
  new URL('../supabase/migrations/0127_credit_bill_delivery_details.sql', import.meta.url),
  'utf8',
);
const deliveryCorrectionsRefundsAndAdjustments = readFileSync(
  new URL('../supabase/migrations/0128_delivery_corrections_refunds_and_adjustments.sql', import.meta.url),
  'utf8',
);
const effectiveChargeProjections = readFileSync(
  new URL('../supabase/migrations/0129_effective_charge_projections.sql', import.meta.url),
  'utf8',
);
const effectiveChargePayments = readFileSync(
  new URL('../supabase/migrations/0130_effective_charge_payments.sql', import.meta.url),
  'utf8',
);
const deliveryCorrectionHardeningAndRefundSummary = readFileSync(
  new URL('../supabase/migrations/0131_delivery_correction_hardening_and_refund_summary.sql', import.meta.url),
  'utf8',
);
const readOnlyDeliveryPriceResolution = readFileSync(
  new URL('../supabase/migrations/0132_read_only_delivery_price_resolution.sql', import.meta.url),
  'utf8',
);
const paymentCorrectionTargets = readFileSync(
  new URL('../supabase/migrations/0133_payment_correction_targets.sql', import.meta.url),
  'utf8',
);
const monthlySalesDocuments = readFileSync(
  new URL('../supabase/migrations/0134_monthly_sales_documents_and_atomic_immediate_sales.sql', import.meta.url),
  'utf8',
);
const accountingReadModel = readFileSync(
  new URL('../supabase/migrations/0136_accounting_read_model.sql', import.meta.url),
  'utf8',
);
const accountingFactoryOrderStock = readFileSync(
  new URL('../supabase/migrations/0138_accounting_factory_orders_as_truck_stock.sql', import.meta.url),
  'utf8',
);

const COURIER_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_ID = '10000000-0000-4000-8000-000000000002';
const OTHER_COURIER_ID = '10000000-0000-4000-8000-000000000003';
const ROUND_LEAD_ID = '10000000-0000-4000-8000-000000000004';
const INACTIVE_COURIER_ID = '10000000-0000-4000-8000-000000000005';
const ROUND_ID = '20000000-0000-4000-8000-000000000001';
const SHOP_ID = '30000000-0000-4000-8000-000000000001';
const STOP_ID = '40000000-0000-4000-8000-000000000001';
const ICE_ID = '50000000-0000-4000-8000-000000000001';
const HOLDING_ID = '60000000-0000-4000-8000-000000000001';
const SHOP_SOURCE_ID = '60000000-0000-4000-8000-000000000002';
const TRUCK_ID = '60000000-0000-4000-8000-000000000003';
const SERVICE_DATE = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const NEXT_SERVICE_DATE = new Date(`${SERVICE_DATE}T12:00:00+07:00`);
NEXT_SERVICE_DATE.setDate(NEXT_SERVICE_DATE.getDate() + 1);
const NEXT_SERVICE_DATE_TEXT = NEXT_SERVICE_DATE.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const PREVIOUS_SERVICE_DATE = new Date(`${SERVICE_DATE}T12:00:00+07:00`);
PREVIOUS_SERVICE_DATE.setDate(PREVIOUS_SERVICE_DATE.getDate() - 1);
const PREVIOUS_SERVICE_DATE_TEXT = PREVIOUS_SERVICE_DATE.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

async function createDatabase(t, { applyCollectionShopCards = true } = {}) {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto } });
  t.after(() => db.close());

  await db.exec(`
    create extension if not exists pgcrypto;
    create role anon;
    create role authenticated;
    create schema auth;
    create schema storage;

    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.shop_payment_status as enum ('unknown', 'paid', 'unpaid');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );
    create type public.delivery_event_status as enum ('active', 'cancelled');
    create type public.stock_location_kind as enum (
      'truck', 'team', 'small_vehicle', 'work_site', 'reserve_bin', 'front_vehicle'
    );
    create type public.stock_movement_kind as enum (
      'factory_order', 'transfer', 'damage', 'return_to_factory'
    );
    create type public.stock_movement_status as enum ('active', 'cancelled');

    create table public.auth_context (
      singleton boolean primary key default true,
      user_id uuid not null,
      app_role public.app_role not null,
      is_active boolean not null
    );
    insert into public.auth_context (user_id, app_role, is_active)
    values ('${COURIER_ID}', 'courier', true);

    create function auth.uid() returns uuid language sql stable as $$
      select user_id from public.auth_context where singleton
    $$;
    create function public.current_app_role() returns public.app_role language sql stable as $$
      select app_role from public.auth_context where singleton
    $$;
    create function public.is_active_user() returns boolean language sql stable as $$
      select is_active from public.auth_context where singleton
    $$;

    create table public.users (
      id uuid primary key,
      code text not null unique,
      role public.app_role not null,
      is_active boolean not null default true,
      display_name text not null,
      nickname text,
      avatar_path text
    );
    create table public.delivery_rounds (
      id uuid primary key,
      name text not null default 'Test round',
      service_date date not null,
      status public.delivery_round_status not null,
      cancelled_at timestamptz,
      closed_by uuid references public.users(id),
      closed_at timestamptz
    );
    create table public.delivery_round_members (
      round_id uuid not null references public.delivery_rounds(id),
      user_id uuid not null references public.users(id),
      primary key (round_id, user_id)
    );
    create function public.is_round_member(target_round_id uuid) returns boolean
    language sql stable as $$
      select exists (
        select 1 from public.delivery_round_members
        where round_id = target_round_id and user_id = auth.uid()
      )
    $$;

    create table public.stock_locations (
      id uuid primary key,
      code text not null unique,
      name text not null,
      kind public.stock_location_kind not null,
      assigned_user_id uuid references public.users(id),
      is_courier_source boolean not null default false,
      holds_inventory boolean not null default true,
      is_active boolean not null default true
    );
    create table public.shops (
      id uuid primary key,
      code text not null unique,
      name text not null,
      image_path text,
      payment_status public.shop_payment_status not null default 'unknown',
      stock_location_id uuid not null references public.stock_locations(id)
    );
    create table public.ice_types (
      id uuid primary key,
      code text not null unique,
      name text not null,
      unit text not null,
      image_path text,
      is_active boolean not null default true
    );
    create table public.round_stops (
      id uuid primary key,
      round_id uuid not null references public.delivery_rounds(id),
      shop_id uuid not null references public.shops(id),
      shop_code_snapshot text not null,
      shop_name_snapshot text not null,
      building_id_snapshot uuid not null default '00000000-0000-4000-8000-000000000001',
      building_name_snapshot text not null,
      floor_or_zone_snapshot text not null,
      sequence_no integer not null default 1,
      status public.shop_round_status not null default 'pending',
      note text,
      updated_by uuid not null references public.users(id),
      updated_at timestamptz not null default now()
    );
    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      round_stop_id uuid not null references public.round_stops(id),
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now(),
      client_recorded_at timestamptz,
      idempotency_key uuid not null unique,
      note text,
      status public.delivery_event_status not null default 'active',
      cancelled_by uuid references public.users(id),
      cancelled_at timestamptz,
      cancellation_reason text,
      source_stock_location_id uuid references public.stock_locations(id),
      corrects_event_id uuid references public.delivery_events(id),
      check (
        (status = 'active' and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
        or (status = 'cancelled' and cancelled_by is not null and cancelled_at is not null
          and nullif(trim(coalesce(cancellation_reason, '')), '') is not null)
      )
    );
    create table public.delivery_items (
      delivery_event_id uuid not null references public.delivery_events(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null check (quantity > 0),
      primary key (delivery_event_id, ice_type_id)
    );
    create table public.round_ice_counts (
      round_id uuid not null references public.delivery_rounds(id),
      ice_type_id uuid not null references public.ice_types(id),
      loaded_quantity integer not null default 0,
      replenished_quantity integer not null default 0,
      remaining_quantity integer not null default 0,
      damaged_quantity integer not null default 0,
      primary key (round_id, ice_type_id)
    );
    create view public.round_ice_reconciliation
    with (security_invoker = true)
    as
    select
      c.round_id,
      c.ice_type_id,
      c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity as expected_quantity,
      coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as delivered_quantity,
      (c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity)
        - coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as variance_quantity
    from public.round_ice_counts c
    left join public.round_stops s on s.round_id = c.round_id
    left join public.delivery_events e on e.round_stop_id = s.id
    left join public.delivery_items i on i.delivery_event_id = e.id and i.ice_type_id = c.ice_type_id
    group by c.round_id, c.ice_type_id, c.loaded_quantity, c.replenished_quantity,
      c.remaining_quantity, c.damaged_quantity;
    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      round_id uuid references public.delivery_rounds(id),
      kind public.stock_movement_kind not null,
      from_location_id uuid references public.stock_locations(id),
      to_location_id uuid references public.stock_locations(id),
      note text,
      idempotency_key uuid not null unique,
      request_fingerprint text,
      status public.stock_movement_status not null default 'active',
      recorded_by uuid not null references public.users(id),
      recorded_at timestamptz not null default now()
    );
    create table public.stock_movement_items (
      movement_id uuid not null references public.stock_movements(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity numeric(12,1) not null check (quantity > 0),
      primary key (movement_id, ice_type_id)
    );
    create table public.factory_receipts (
      id uuid primary key default gen_random_uuid(),
      factory_order_id uuid not null unique references public.stock_movements(id),
      service_date date not null,
      truck_location_id uuid not null references public.stock_locations(id)
    );
    create table public.factory_receipt_items (
      factory_receipt_id uuid not null references public.factory_receipts(id),
      ice_type_id uuid not null references public.ice_types(id),
      actual_quantity numeric(12,1) not null,
      primary key (factory_receipt_id, ice_type_id)
    );
    create table public.delivery_event_revisions (
      idempotency_key uuid primary key,
      original_event_id uuid not null references public.delivery_events(id),
      replacement_event_id uuid references public.delivery_events(id),
      action text not null check (action in ('cancel', 'correct')),
      reason text not null,
      revised_by uuid not null references public.users(id),
      revised_at timestamptz not null default now()
    );
    create table public.daily_stock_closures (
      service_date date primary key,
      status text not null
    );
    create table public.daily_stock_closure_items (
      service_date date not null,
      location_id uuid not null,
      ice_type_id uuid not null,
      variance_quantity numeric(12,1) not null default 0,
      primary key (service_date, location_id, ice_type_id)
    );
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_id uuid not null references public.users(id),
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      before_value jsonb,
      after_value jsonb,
      reason text,
      occurred_at timestamptz not null default now()
    );
    create function public.audit_row_update() returns trigger language plpgsql as $$
    begin
      if auth.uid() is not null then
        insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_value, after_value, reason)
        values (
          auth.uid(), tg_table_name, new.id,
          case when to_jsonb(old) ->> 'status' <> 'cancelled' and to_jsonb(new) ->> 'status' = 'cancelled'
            then 'cancelled' else 'updated' end,
          to_jsonb(old), to_jsonb(new),
          case when to_jsonb(new) ->> 'status' = 'cancelled' then to_jsonb(new) ->> 'cancellation_reason' end
        );
      end if;
      return new;
    end;
    $$;
    create table public.test_opening_balances (
      service_date date not null,
      location_id uuid not null references public.stock_locations(id),
      ice_type_id uuid not null references public.ice_types(id),
      quantity integer not null,
      primary key (service_date, location_id, ice_type_id)
    );
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null,
      unique (bucket_id, name)
    );
    create function storage.foldername(path text) returns text[]
    language sql immutable as $$
      select string_to_array(path, '/')
    $$;

    create function public.set_updated_at() returns trigger language plpgsql as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$;
    create function public.stock_balance_at(
      p_service_date date, p_location_id uuid, p_ice_type_id uuid
    ) returns numeric(12,1) language sql stable as $$
      select coalesce((
        select quantity from public.test_opening_balances
        where service_date = p_service_date and location_id = p_location_id
          and ice_type_id = p_ice_type_id
      ), 0) + coalesce((
        select sum(
          case when movement.to_location_id = p_location_id then item.quantity else 0 end
          - case when movement.from_location_id = p_location_id then item.quantity else 0 end
        )::integer
        from public.stock_movements movement
        join public.stock_movement_items item on item.movement_id = movement.id
        where movement.service_date = p_service_date
          and movement.status = 'active'
          and item.ice_type_id = p_ice_type_id
          and (movement.from_location_id = p_location_id
            or movement.to_location_id = p_location_id)
      ), 0) - coalesce((
        select sum(item.quantity)::integer
        from public.delivery_events event
        join public.delivery_items item on item.delivery_event_id = event.id
        join public.round_stops stop on stop.id = event.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where round.service_date = p_service_date
          and event.source_stock_location_id = p_location_id
          and item.ice_type_id = p_ice_type_id
          and event.status = 'active'
      ), 0)
    $$;
    create function public.is_delivery_event_visible(target_event_id uuid) returns boolean
    language sql stable as $$
      select exists (
        select 1
        from public.delivery_events event
        join public.round_stops stop on stop.id = event.round_stop_id
        where event.id = target_event_id
          and (public.current_app_role() in ('admin', 'round_lead')
            or public.is_round_member(stop.round_id))
      )
    $$;
    create function public.get_manager_delivery_events(p_round_id uuid) returns jsonb
    language sql stable as $$ select jsonb_build_object('round_id', p_round_id) $$;
    create function public.record_delivery(
      uuid, jsonb, public.shop_round_status, text, timestamptz, uuid
    ) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.revise_delivery_event(
      uuid, text, jsonb, public.shop_round_status, text, text, uuid
    ) returns jsonb language sql as $$ select '{}'::jsonb $$;

    insert into public.users (id, code, role, is_active, display_name, nickname, avatar_path) values
      ('${COURIER_ID}', 'C001', 'courier', true, 'Courier', 'First', 'users/${COURIER_ID}/avatar.webp'),
      ('${ADMIN_ID}', 'A001', 'admin', true, 'Admin', null, null),
      ('${OTHER_COURIER_ID}', 'C002', 'courier', true, 'Other courier', null, null),
      ('${ROUND_LEAD_ID}', 'R001', 'round_lead', true, 'Round lead', null, null),
      ('${INACTIVE_COURIER_ID}', 'C003', 'courier', false, 'Inactive courier', null, null);
    insert into public.delivery_rounds (id, service_date, status)
    values ('${ROUND_ID}', date '${SERVICE_DATE}', 'open');
    insert into public.delivery_round_members (round_id, user_id)
    values ('${ROUND_ID}', '${COURIER_ID}');
    insert into public.stock_locations (
      id, code, name, kind, assigned_user_id, is_courier_source, holds_inventory
    ) values
      ('${HOLDING_ID}', 'TEAM-1', 'Courier stock', 'team', '${COURIER_ID}', false, true),
      ('${SHOP_SOURCE_ID}', 'SITE-1', 'Shop stock', 'work_site', null, false, false),
      ('${TRUCK_ID}', 'TRUCK-1', 'Main truck', 'truck', null, true, true);
    insert into public.shops (id, code, name, stock_location_id)
    values ('${SHOP_ID}', 'SHOP-1', 'Shop One', '${SHOP_SOURCE_ID}');
    insert into public.ice_types (id, code, name, unit)
    values ('${ICE_ID}', 'ICE-1', 'Ice', 'bag');
    insert into public.round_stops (
      id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_name_snapshot, floor_or_zone_snapshot, updated_by
    ) values (
      '${STOP_ID}', '${ROUND_ID}', '${SHOP_ID}', 'SHOP-1', 'Shop One',
      'Building A', 'Zone 1', '${ADMIN_ID}'
    );
    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values
      (date '${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}', 10),
      (date '${SERVICE_DATE}', '${SHOP_SOURCE_ID}', '${ICE_ID}', 50),
      (date '${SERVICE_DATE}', '${TRUCK_ID}', '${ICE_ID}', 30);
    insert into public.stock_movements (
      id, service_date, kind, to_location_id, idempotency_key, recorded_by
    ) values (
      '65000000-0000-4000-8000-000000000001', date '${SERVICE_DATE}',
      'factory_order', '${TRUCK_ID}', '65000000-0000-4000-8000-000000000002',
      '${ADMIN_ID}'
    );
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('65000000-0000-4000-8000-000000000001', '${ICE_ID}', 30);
  `);

  await db.exec(foundation);
  await db.exec(transactions);
  await db.exec(operations);
  await db.exec(recovery);
  await db.exec(collectorAccess);
  await db.exec(adminBackdatedBilling);
  await db.exec(`
    create function public.record_factory_order(
      p_service_date date,
      p_truck_location_id uuid,
      p_items jsonb,
      p_note text default null,
      p_idempotency_key uuid default gen_random_uuid()
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = public
    as $$
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_service_date::text, 0));

      if exists (
        select 1
        from public.daily_stock_closures
        where service_date = p_service_date and status = 'closed'
      ) then
        raise exception 'Stock for this service date is already closed';
      end if;

      insert into public.stock_movements (
        service_date, kind, to_location_id, idempotency_key, recorded_by
      ) values (
        p_service_date, 'factory_order', p_truck_location_id,
        p_idempotency_key, auth.uid()
      );
      return '{}'::jsonb;
    end;
    $$;

    create function public.cancel_factory_order(
      p_movement_id uuid,
      p_reason text
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = public
    as $$
    declare
      v_movement public.stock_movements%rowtype;
    begin
      select * into v_movement
      from public.stock_movements
      where id = p_movement_id
      for update;

      perform pg_advisory_xact_lock(hashtextextended(v_movement.service_date::text, 0));

      if exists (
        select 1
        from public.daily_stock_closures closure
        where closure.service_date = v_movement.service_date
          and closure.status = 'closed'
      ) then
        raise exception 'Stock for this service date is already closed';
      end if;

      update public.stock_movements
      set status = 'cancelled'
      where id = p_movement_id;
      return '{}'::jsonb;
    end;
    $$;
  `);
  await db.exec(dailyAggregateStock);
  await db.exec(dailyAggregateCompletion);
  await db.exec(deliveryFinancialResponseItemLabels);
  if (applyCollectionShopCards) {
    await db.exec(collectionShopCardsAndChargeNumbers);
    await db.exec(paymentReceiptNumbers);
    await db.exec(collectionCarryForwardBalances);
    await db.exec(collectionQueueChargeItems);
    await db.exec(creditCollectionsAndDueDateExtensions);
    await db.exec(creditAccountManagement);
    await db.exec(paymentReceiptSnapshots);
    await db.exec(weeklyCreditDueRule);
    await db.exec(creditCollectionCycles);
    await db.exec(creditBillDeliveryDetails);
  }
  await db.exec(disableDailyStockRefill);
  await db.exec(courierPaymentVoids);
  if (applyCollectionShopCards) {
    await db.exec(deliveryCorrectionsRefundsAndAdjustments);
    await db.exec(effectiveChargeProjections);
    await db.exec(effectiveChargePayments);
    await db.exec(deliveryCorrectionHardeningAndRefundSummary);
    await db.exec(readOnlyDeliveryPriceResolution);
    await db.exec(paymentCorrectionTargets);
  }
  await db.exec(`
    insert into public.ice_type_prices (
      ice_type_id, unit_price, valid_from, created_by
    ) values ('${ICE_ID}', 20, date '2026-07-01', '${ADMIN_ID}');
    insert into public.shop_ice_type_prices (
      shop_id, ice_type_id, unit_price, valid_from, created_by
    ) values ('${SHOP_ID}', '${ICE_ID}', 18, date '2026-07-15', '${ADMIN_ID}');
    insert into public.shop_payment_profiles (
      shop_id, allowed_payment_terms, default_payment_term,
      allowed_payment_methods, default_payment_method, created_by
    ) values (
      '${SHOP_ID}', array['immediate']::public.payment_term[], 'immediate',
      array['cash']::public.payment_method[], 'cash', '${ADMIN_ID}'
    );
  `);
  return db;
}

function itemPayload(quantity) {
  return JSON.stringify([{ ice_type_id: ICE_ID, quantity }]);
}

async function applyAccountingReadModel(db) {
  await db.exec(monthlySalesDocuments);
  await db.exec(`
    alter table public.stock_movements
      add column if not exists original_movement_id uuid references public.stock_movements(id),
      add column if not exists replacement_movement_id uuid references public.stock_movements(id);
    alter table public.factory_receipts
      add column if not exists note text,
      add column if not exists recorded_by uuid references public.users(id),
      add column if not exists recorded_at timestamptz not null default now(),
      add column if not exists idempotency_key uuid,
      add column if not exists request_fingerprint text;
    alter table public.factory_receipt_items
      add column if not exists expected_quantity numeric(12,1) not null default 0,
      add column if not exists variance_quantity numeric(12,1) not null default 0;
    create table public.stock_count_snapshots (
      id uuid primary key default gen_random_uuid(),
      service_date date not null,
      location_id uuid not null references public.stock_locations(id),
      counted_at timestamptz not null default now()
    );
    create table public.stock_count_snapshot_items (
      snapshot_id uuid not null references public.stock_count_snapshots(id),
      ice_type_id uuid not null references public.ice_types(id),
      actual_quantity numeric(12,1) not null,
      primary key (snapshot_id, ice_type_id)
    );
  `);
  await db.exec(accountingReadModel);
  await db.exec(accountingFactoryOrderStock);
}

test('accounting migration returns retained cash and manager-only canonical rows', async (t) => {
  const db = await createDatabase(t);
  await applyAccountingReadModel(db);
  await db.exec(`
    update public.auth_context set user_id = '${COURIER_ID}', app_role = 'courier';
  `);
  await db.query(`select public.record_immediate_sale(
    '${STOP_ID}', '${itemPayload(2)}'::jsonb, null, now(),
    'cash', 50, null, null, 36,
    '9f000000-0000-4000-8000-000000000001'
  )`);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const ledger = await db.query(`select public.get_accounting_transactions(
    date '${SERVICE_DATE}', date '${SERVICE_DATE}', '{}'::jsonb,
    '{"key":"document_number","direction":"asc"}'::jsonb, 100, 0
  ) result`);
  assert.equal(ledger.rows[0].result.total_count > 0, true);
  assert.equal(ledger.rows[0].result.rows.some((row) => row.type === 'SALE'), true);
  assert.equal(ledger.rows[0].result.rows.some((row) => row.source_table === 'delivery_charges'), true);
  const receipt = ledger.rows[0].result.rows.find((row) => row.type === 'REC');
  const reconciliation = await db.query(`select public.get_accounting_reconciliation(
    date '${SERVICE_DATE}'
  ) result`);
  assert.equal(Number(receipt.cash_in), 36);
  assert.equal(Number(receipt.details.received_amount), 50);
  assert.equal(Number(reconciliation.rows[0].result.financial.cash_received), 36);
  assert.equal(Number(reconciliation.rows[0].result.financial.net_cash), 36);

  await db.exec(`update public.auth_context set user_id = '${COURIER_ID}', app_role = 'courier'`);
  await assert.rejects(
    db.query(`select public.get_accounting_transactions(
      date '${SERVICE_DATE}', date '${SERVICE_DATE}', '{}'::jsonb, '{}'::jsonb, 100, 0
    )`),
    /Only a round lead or admin can view accounting transactions/,
  );
});

test('accounting reconciliation treats factory orders as truck stock without a receipt', async (t) => {
  const db = await createDatabase(t);
  await applyAccountingReadModel(db);
  await db.exec(`
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
    insert into public.stock_movements (
      id, service_date, kind, from_location_id, to_location_id,
      idempotency_key, recorded_by
    ) values (
      '65000000-0000-4000-8000-000000000010', date '${SERVICE_DATE}',
      'transfer', '${TRUCK_ID}', '${HOLDING_ID}',
      '65000000-0000-4000-8000-000000000011', '${ADMIN_ID}'
    );
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('65000000-0000-4000-8000-000000000010', '${ICE_ID}', 15);
  `);

  const response = await db.query(`select public.get_accounting_reconciliation(
    date '${SERVICE_DATE}'
  ) result`);
  const reconciliation = response.rows[0].result;
  const truck = reconciliation.holders.find((holder) => holder.location_id === TRUCK_ID);
  const employee = reconciliation.holders.find((holder) => holder.location_id === HOLDING_ID);

  assert.equal(Number(reconciliation.aggregate[0].factory_in), 30);
  assert.equal(Number(truck.items[0].factory_in), 30);
  assert.equal(Number(truck.items[0].expected), 15);
  assert.equal(Number(employee.items[0].factory_in), 0);
  assert.equal(Number(employee.items[0].expected), 15);

  await db.exec(`
    insert into public.stock_count_snapshots (
      id, service_date, location_id, counted_at
    ) values (
      '65000000-0000-4000-8000-000000000012', date '${SERVICE_DATE}',
      '${TRUCK_ID}', now()
    );
    insert into public.stock_count_snapshot_items (
      snapshot_id, ice_type_id, actual_quantity
    ) values (
      '65000000-0000-4000-8000-000000000012', '${ICE_ID}', 15
    );
    insert into public.factory_receipts (
      id, factory_order_id, service_date, truck_location_id, recorded_at
    ) values (
      '65000000-0000-4000-8000-000000000013',
      '65000000-0000-4000-8000-000000000001',
      date '${SERVICE_DATE}', '${HOLDING_ID}', now() + interval '1 second'
    );
    insert into public.factory_receipt_items (
      factory_receipt_id, ice_type_id, expected_quantity,
      actual_quantity, variance_quantity
    ) values (
      '65000000-0000-4000-8000-000000000013', '${ICE_ID}', 30, 28, -2
    );
  `);
  const legacyResponse = await db.query(`select public.get_accounting_reconciliation(
    date '${SERVICE_DATE}'
  ) result`);
  const legacyReconciliation = legacyResponse.rows[0].result;
  const legacyTruck = legacyReconciliation.holders.find(
    (holder) => holder.location_id === TRUCK_ID,
  );
  const legacyEmployee = legacyReconciliation.holders.find(
    (holder) => holder.location_id === HOLDING_ID,
  );

  assert.equal(Number(legacyReconciliation.aggregate[0].factory_in), 28);
  assert.equal(Number(legacyTruck.items[0].factory_in), 28);
  assert.equal(Number(legacyTruck.items[0].expected), 13);
  assert.equal(legacyTruck.items[0].count_status, 'stale');
  assert.equal(legacyTruck.items[0].actual, null);
  assert.equal(Number(legacyEmployee.items[0].factory_in), 0);
  assert.equal(Number(legacyEmployee.items[0].expected), 15);
});

test('accounting review derives stock variance only from a current complete count', async (t) => {
  const db = await createDatabase(t);
  await applyAccountingReadModel(db);
  await db.exec(`
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
    update public.shop_payment_profiles
    set allowed_payment_terms = array['end_of_day']::public.payment_term[],
        default_payment_term = 'end_of_day', allow_outstanding = true
    where shop_id = '${SHOP_ID}';
  `);
  await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
    '9f000000-0000-4000-8000-000000000011', 'end_of_day'
  )`);
  const charge = await db.query(`select id, original_amount
    from public.delivery_charges where service_date = date '${SERVICE_DATE}'`);
  const balance = await db.query(`select public.daily_aggregate_stock_balance_at(
    date '${SERVICE_DATE}', '${ICE_ID}'
  ) value`);
  const actual = Number(balance.rows[0].value) + 1;
  await db.query(`select public.close_daily_aggregate_stock(
    date '${SERVICE_DATE}',
    '[{"ice_type_id":"${ICE_ID}","actual_quantity":${actual},"note":"test variance"}]'::jsonb,
    'test variance', '9f000000-0000-4000-8000-000000000012'
  )`);

  let review = await db.query(`select public.get_accounting_review_queue(
    date '${SERVICE_DATE}', date '${SERVICE_DATE}', '{}'::jsonb, 100, 0
  ) result`);
  assert.equal(review.rows[0].result.rows.some((item) => item.issue_type === 'STOCK_VARIANCE'), true);

  await db.exec(`
    insert into public.delivery_charge_adjustments (
      idempotency_key, request_fingerprint, charge_id, scope, amount_delta,
      corrected_total, reason, created_by, created_at
    ) select
      '9f000000-0000-4000-8000-000000000013', 'accounting-stale-test', id,
      'day_closed', -18, original_amount - 18, 'test post-close correction',
      '${ADMIN_ID}', (select closed_at + interval '1 second'
        from public.daily_aggregate_stock_closures where service_date = date '${SERVICE_DATE}')
    from public.delivery_charges where id = '${charge.rows[0].id}';
    insert into public.delivery_adjustment_items (
      adjustment_id, ice_type_id, original_quantity, corrected_quantity, unit_price
    ) values (
      '9f000000-0000-4000-8000-000000000013', '${ICE_ID}', 2, 1, 18
    );
  `);

  const staleReconciliation = await db.query(`select public.get_accounting_reconciliation(
    date '${SERVICE_DATE}'
  ) result`);
  assert.equal(staleReconciliation.rows[0].result.aggregate[0].count_status, 'stale');
  assert.equal(staleReconciliation.rows[0].result.aggregate[0].actual, null);
  review = await db.query(`select public.get_accounting_review_queue(
    date '${SERVICE_DATE}', date '${SERVICE_DATE}', '{}'::jsonb, 100, 0
  ) result`);
  assert.equal(review.rows[0].result.rows.some((item) => item.issue_type === 'STOCK_VARIANCE'), false);
});

test('monthly document migration issues atomic immediate REC and preserves idempotency', async (t) => {
  const db = await createDatabase(t);
  await db.exec(monthlySalesDocuments);
  const key = 'a0000000-0000-4000-8000-000000000001';
  const saleSql = `select public.record_immediate_sale(
    '${STOP_ID}', '${itemPayload(2)}'::jsonb, null, now(),
    'cash', 40, null, null, 36, '${key}'
  ) as result`;

  const first = await db.query(saleSql);
  const replay = await db.query(saleSql);
  assert.equal(first.rows[0].result.receipt_number, replay.rows[0].result.receipt_number);
  assert.match(first.rows[0].result.receipt_number, /^REC\d{4}-00001$/);
  assert.equal(first.rows[0].result.delivery.charge_number, null);
  assert.equal(first.rows[0].result.print_document.document_title, 'ใบส่งของ / ใบเสร็จรับเงิน');
  const evidenceCleanup = await db.query(`select public.can_delete_payment_evidence(
    '${key}', '${COURIER_ID}/${key}.jpg'
  ) as allowed`);
  assert.equal(evidenceCleanup.rows[0].allowed, false);

  const persisted = await db.query(`
    select
      (select count(*)::integer from public.delivery_events) as deliveries,
      (select count(*)::integer from public.payments) as payments,
      (select count(*)::integer from public.payment_receipt_snapshots) as snapshots
  `);
  assert.deepEqual(persisted.rows[0], { deliveries: 1, payments: 1, snapshots: 1 });
});

test('monthly document migration rejects a direct immediate delivery without a REC', async (t) => {
  const db = await createDatabase(t);
  await db.exec(monthlySalesDocuments);

  await assert.rejects(
    db.query(`select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, now(),
      'a0000000-0000-4000-8000-000000000013', 'immediate', null
    )`),
    /must be recorded atomically with a receipt/i,
  );

  const counts = await db.query(`select
    (select count(*)::integer from public.delivery_events) as deliveries,
    (select count(*)::integer from public.delivery_charges) as charges,
    (select count(*)::integer from public.payments) as payments
  `);
  assert.deepEqual(counts.rows[0], { deliveries: 0, charges: 0, payments: 0 });
});

test('monthly INV and REC counters are independent and reject overflow', async (t) => {
  const db = await createDatabase(t);
  await db.exec(monthlySalesDocuments);
  const period = '2026-08-01';
  const numbers = await db.query(`
    select public.next_sales_document_number('INV', date '${period}') as inv,
      public.next_sales_document_number('REC', date '${period}') as rec
  `);
  assert.equal(numbers.rows[0].inv, 'INV2608-00001');
  assert.equal(numbers.rows[0].rec, 'REC2608-00001');
  await db.exec(`update public.document_counters set last_sequence = 99999
    where document_type = 'INV' and period_month = date '${period}'`);
  await assert.rejects(
    db.query(`select public.next_sales_document_number('INV', date '${period}')`),
    /exceeds 99999/i,
  );
});

test('an immediate payment validation failure rolls back delivery, stock, charge, and counters', async (t) => {
  const db = await createDatabase(t);
  await db.exec(monthlySalesDocuments);
  await assert.rejects(
    db.query(`select public.record_immediate_sale(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, null, now(),
      'cash', 20, null, null, 36, 'a0000000-0000-4000-8000-000000000002'
    )`),
    /must cover the full immediate sale amount/i,
  );
  const counts = await db.query(`
    select
      (select count(*)::integer from public.delivery_events) as deliveries,
      (select count(*)::integer from public.delivery_charges) as charges,
      (select count(*)::integer from public.payments) as payments,
      (select count(*)::integer from public.document_counters) as counters
  `);
  assert.deepEqual(counts.rows[0], { deliveries: 0, charges: 0, payments: 0, counters: 0 });
});

test('an immediate server-price change rolls back and requires client reconfirmation', async (t) => {
  const db = await createDatabase(t);
  await db.exec(monthlySalesDocuments);

  await assert.rejects(
    db.query(`select public.record_immediate_sale(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, null, now(),
      'cash', 40, null, null, 40, 'a0000000-0000-4000-8000-000000000008'
    )`),
    /Immediate sale total changed/i,
  );

  const counts = await db.query(`select
    (select count(*)::integer from public.delivery_events) as deliveries,
    (select count(*)::integer from public.payments) as payments,
    (select count(*)::integer from public.document_counters) as counters
  `);
  assert.deepEqual(counts.rows[0], { deliveries: 0, payments: 0, counters: 0 });
});

test('immediate sales require void then cancel and cannot be corrected in place', async (t) => {
  const db = await createDatabase(t);
  await db.exec(monthlySalesDocuments);
  const sale = await db.query(`select public.record_immediate_sale(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, null, now(),
    'cash', 20, null, null, 18, 'a0000000-0000-4000-8000-000000000005'
  ) as result`);
  const eventId = sale.rows[0].result.delivery.delivery_event_id;
  await db.exec(`update public.auth_context set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead'`);

  await assert.rejects(
    db.query(`select public.apply_open_delivery_correction(
      '${eventId}', 'correct', '${itemPayload(2)}'::jsonb, 'delivered', null,
      'change quantity', 'a0000000-0000-4000-8000-000000000006', null
    )`),
    /Immediate sales cannot be corrected in place/i,
  );
  await assert.rejects(
    db.query(`select public.apply_open_delivery_correction(
      '${eventId}', 'cancel', '[]'::jsonb, 'delivered', null,
      'cancel sale', 'a0000000-0000-4000-8000-000000000007', null
    )`),
    /Void the active immediate-sale receipt/i,
  );
  const state = await db.query(`select event.status as event_status, charge.status as charge_status
    from public.delivery_events event join public.delivery_charges charge on charge.delivery_event_id = event.id
    where event.id = '${eventId}'`);
  assert.deepEqual(state.rows[0], { event_status: 'active', charge_status: 'active' });
});

test('closed-period adjustments reject immediate sales', async (t) => {
  const db = await createDatabase(t);
  await db.exec(monthlySalesDocuments);
  const sale = await db.query(`select public.record_immediate_sale(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, null, now(),
    'cash', 20, null, null, 18, 'a0000000-0000-4000-8000-000000000009'
  ) as result`);
  const eventId = sale.rows[0].result.delivery.delivery_event_id;
  await db.exec(`
    update public.delivery_rounds set status = 'closed' where id = '${ROUND_ID}';
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);

  await assert.rejects(
    db.query(`select public.create_closed_delivery_adjustment(
      '${eventId}', '${itemPayload(0.5)}'::jsonb, 'incorrect immediate sale',
      'a0000000-0000-4000-8000-000000000010'
    )`),
    /Immediate sales cannot be adjusted in place/i,
  );
});

test('a closed-round immediate sale can be voided and cancelled before re-entry', async (t) => {
  const db = await createDatabase(t);
  await db.exec(monthlySalesDocuments);
  const sale = await db.query(`select public.record_immediate_sale(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, null, now(),
    'cash', 20, null, null, 18, 'a0000000-0000-4000-8000-000000000011'
  ) as result`);
  const eventId = sale.rows[0].result.delivery.delivery_event_id;
  const paymentId = sale.rows[0].result.payment.payment_id;
  await db.exec(`
    update public.delivery_rounds set status = 'closed' where id = '${ROUND_ID}';
    update public.auth_context set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead';
  `);

  await db.query(`select public.void_payment('${paymentId}', 'incorrect immediate sale')`);
  const targets = await db.query(`select public.get_payment_correction_targets('${paymentId}') as result`);
  assert.equal(targets.rows[0].result.length, 1);
  assert.equal(targets.rows[0].result[0].delivery_event_id, eventId);
  await db.query(`select public.apply_open_delivery_correction(
    '${eventId}', 'cancel', '[]'::jsonb, 'delivered', null,
    'incorrect immediate sale', 'a0000000-0000-4000-8000-000000000012', null
  )`);

  const state = await db.query(`select event.status as event_status, charge.status as charge_status,
      payment.status as payment_status
    from public.delivery_events event
    join public.delivery_charges charge on charge.delivery_event_id = event.id
    join public.payment_allocations allocation on allocation.charge_id = charge.id
    join public.payments payment on payment.id = allocation.payment_id
    where event.id = '${eventId}'`);
  assert.deepEqual(state.rows[0], {
    event_status: 'cancelled', charge_status: 'voided', payment_status: 'voided',
  });
});

test('a legacy unpaid immediate delivery cannot skip the REC void step after closing', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, now(),
    'a0000000-0000-4000-8000-000000000014', 'immediate', null
  ) as result`);
  const eventId = delivery.rows[0].result.delivery_event_id;
  await db.exec(monthlySalesDocuments);
  await db.exec(`
    update public.delivery_rounds set status = 'closed' where id = '${ROUND_ID}';
    update public.auth_context set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead';
  `);

  const context = await db.query(
    `select public.get_delivery_correction_context('${eventId}') as result`,
  );
  assert.equal(context.rows[0].result.can_cancel, false);
  assert.match(context.rows[0].result.blocker_reason, /closed|\u0e1b\u0e34\u0e14/i);
});

test('legacy charge numbers stay unchanged while new non-immediate deliveries receive snapshot INV numbers', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`update public.shop_payment_profiles set
    allowed_payment_terms = array['end_of_day']::public.payment_term[],
    default_payment_term = 'end_of_day' where shop_id = '${SHOP_ID}'`);
  const legacy = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, now(),
    'a0000000-0000-4000-8000-000000000003', 'end_of_day', null
  ) as result`);
  const legacyChargeId = legacy.rows[0].result.charge_id;
  const legacyNumber = (await db.query(`select charge_number from public.delivery_charges
    where id = '${legacyChargeId}'`)).rows[0].charge_number;
  assert.match(legacyNumber, /^C\d{6}-\d{6}$/);

  await db.exec(monthlySalesDocuments);
  const current = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, now(),
    'a0000000-0000-4000-8000-000000000004', 'end_of_day', null
  ) as result`);
  assert.equal(current.rows[0].result.charge_number, `INV${SERVICE_DATE.slice(2, 7).replace('-', '')}-00001`);
  assert.equal(current.rows[0].result.print_document.document_title, 'ใบส่งของ / ใบแจ้งหนี้');

  const preserved = await db.query(`select charge_number from public.delivery_charges
    where id = '${legacyChargeId}'`);
  assert.equal(preserved.rows[0].charge_number, legacyNumber);
  const snapshots = await db.query(`select count(*)::integer as count
    from public.delivery_charge_document_snapshots`);
  assert.equal(snapshots.rows[0].count, 2);
});

test('round leads and admins list only active collection couriers', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead', is_active = true;
  `);

  const roundLeadResult = await db.query(`
    select * from public.get_collection_collectors()
  `);
  assert.deepEqual(
    roundLeadResult.rows.map((collector) => collector.code),
    ['C001', 'C002'],
  );
  assert.deepEqual(Object.keys(roundLeadResult.rows[0]).sort(), [
    'avatar_path',
    'code',
    'display_name',
    'id',
    'nickname',
  ]);

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  const adminResult = await db.query(`
    select * from public.get_collection_collectors()
  `);
  assert.deepEqual(
    adminResult.rows.map((collector) => collector.code),
    ['C001', 'C002'],
  );

  await db.exec(`
    update public.auth_context
    set user_id = '${COURIER_ID}', app_role = 'courier';
  `);
  await assert.rejects(
    db.query(`select * from public.get_collection_collectors()`),
    /Only a round lead or admin/i,
  );
});

test('collection runs reject members who are not active couriers', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead', is_active = true;
  `);

  for (const invalidUserId of [
    ADMIN_ID,
    INACTIVE_COURIER_ID,
    '10000000-0000-4000-8000-000000000099',
  ]) {
    await assert.rejects(
      db.query(`
        select public.open_collection_run(
          date '${SERVICE_DATE}',
          '[{"user_id":"${invalidUserId}"}]'::jsonb
        )
      `),
      /Collection members must be active couriers/i,
    );
  }

  const runCount = await db.query(`select count(*)::integer as count from public.collection_runs`);
  assert.equal(runCount.rows[0].count, 0);

  const validRun = await db.query(`
    select public.open_collection_run(
      date '${SERVICE_DATE}',
      '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  assert.ok(validRun.rows[0].result.collection_run_id);
});

test('POS context and delivery use override price, aggregate stock, and idempotent charge', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`delete from public.delivery_round_members where round_id = '${ROUND_ID}'`);
  await assert.rejects(
    db.query(`select public.get_delivery_pos_context('${STOP_ID}')`),
    /not assigned/i,
  );
  await db.exec(`
    insert into public.delivery_round_members (round_id, user_id)
    values ('${ROUND_ID}', '${COURIER_ID}')
  `);
  const context = await db.query(`select public.get_delivery_pos_context('${STOP_ID}') as result`);
  assert.equal(context.rows[0].result.service_date, SERVICE_DATE);
  assert.equal(context.rows[0].result.stock_source.id, null);
  assert.equal(context.rows[0].result.stock_source.code, 'DAILY');
  assert.equal(Number(context.rows[0].result.items[0].unit_price), 18);
  assert.equal(context.rows[0].result.items[0].price_source, 'shop_override');
  assert.equal(context.rows[0].result.items[0].stock_quantity, 30);

  const key = '70000000-0000-4000-8000-000000000001';
  const first = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null, '${key}', 'immediate'
    ) as result
  `);
  assert.equal(Number(first.rows[0].result.total_amount), 36);
  assert.equal(first.rows[0].result.payment_status, 'unpaid');
  assert.equal(first.rows[0].result.source_stock_location_id, SHOP_SOURCE_ID);
  assert.deepEqual(
    first.rows[0].result.items.map((item) => ({
      name: item.name,
      unit: item.unit,
      quantity: Number(item.quantity),
      line_total: Number(item.line_total),
    })),
    [{ name: 'Ice', unit: 'bag', quantity: 2, line_total: 36 }],
  );

  const retry = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null, '${key}', 'immediate'
    ) as result
  `);
  assert.equal(retry.rows[0].result.delivery_event_id, first.rows[0].result.delivery_event_id);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(3)}'::jsonb, 'delivered', null, null, '${key}', 'immediate'
      )
    `),
    /different delivery request/i,
  );

  const counts = await db.query(`
    select
      (select count(*)::integer from public.delivery_events) as events,
      (select count(*)::integer from public.delivery_charges) as charges
  `);
  assert.deepEqual(counts.rows[0], { events: 1, charges: 1 });

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin'
  `);
  const adminContext = await db.query(`
    select public.get_delivery_pos_context('${STOP_ID}') as result
  `);
  assert.equal(adminContext.rows[0].result.stock_source.id, null);
  assert.equal(adminContext.rows[0].result.items[0].stock_quantity, 28);
});

test('delivery creation and correction reject quantities outside half-bag increments', async (t) => {
  const db = await createDatabase(t);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(0.1)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000096', 'immediate'
      )
    `),
    /positive quantity/i,
  );

  const valid = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(0.5)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000095', 'immediate'
    ) as result
  `);
  assert.equal(Number(valid.rows[0].result.total_amount), 9);

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  await assert.rejects(
    db.query(`
      select public.revise_delivery_event(
        '${valid.rows[0].result.delivery_event_id}', 'correct',
        '${itemPayload(0.1)}'::jsonb, 'delivered', null, 'แก้จำนวน',
        '70000000-0000-4000-8000-000000000094'
      )
    `),
    /positive quantity/i,
  );
});

test('internal transfers do not change aggregate stock and corrections preserve aggregate inventory', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
    insert into public.stock_movements (
      id, service_date, kind, from_location_id, to_location_id,
      idempotency_key, recorded_by
    ) values (
      '65000000-0000-4000-8000-000000000010', date '${SERVICE_DATE}',
      'transfer', '${TRUCK_ID}', '${HOLDING_ID}',
      '65000000-0000-4000-8000-000000000011', '${ADMIN_ID}'
    );
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('65000000-0000-4000-8000-000000000010', '${ICE_ID}', 10);
  `);

  const contextResult = await db.query(`
    select public.get_delivery_pos_context('${STOP_ID}') as result
  `);
  assert.equal(contextResult.rows[0].result.stock_source.id, null);
  assert.equal(contextResult.rows[0].result.items[0].stock_quantity, 30);

  const key = '70000000-0000-4000-8000-000000000099';
  await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '${key}', 'immediate'
    )
  `);
  await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '${key}', 'immediate'
    )
  `);

  const balances = await db.query(`
    select
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as aggregate,
      (select count(*)::integer from public.stock_movements
       where idempotency_key = '${key}') as movements,
      (select count(*)::integer from public.delivery_events
       where idempotency_key = '${key}') as deliveries,
      (select source_stock_location_id from public.delivery_events
       where idempotency_key = '${key}') as source
  `);
  assert.deepEqual({ ...balances.rows[0], aggregate: Number(balances.rows[0].aggregate) }, {
    aggregate: 28,
    movements: 0,
    deliveries: 1,
    source: SHOP_SOURCE_ID,
  });

  const original = await db.query(`
    select id from public.delivery_events where idempotency_key = '${key}'
  `);
  await db.query(`
    select public.revise_delivery_event(
      '${original.rows[0].id}', 'correct', '${itemPayload(1)}'::jsonb,
      'delivered', null, 'แก้จำนวน', '70000000-0000-4000-8000-000000000098'
    )
  `);
  const correctedBalances = await db.query(`
    select
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as aggregate
  `);
  assert.deepEqual(
    { aggregate: Number(correctedBalances.rows[0].aggregate) },
    { aggregate: 29 },
  );

  await db.exec(`
    update public.auth_context
    set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead';
  `);
  const roundLeadContext = await db.query(`
    select public.get_delivery_pos_context('${STOP_ID}') as result
  `);
  assert.equal(roundLeadContext.rows[0].result.stock_source.id, null);
  assert.equal(roundLeadContext.rows[0].result.items[0].stock_quantity, 29);
});

test('admin delivery rejects a future service date at the database boundary', async (t) => {
  const db = await createDatabase(t);
  const futureRoundId = '20000000-0000-4000-8000-000000000099';
  const futureStopId = '40000000-0000-4000-8000-000000000099';
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';

    insert into public.delivery_rounds (id, service_date, status)
    values ('${futureRoundId}', date '${NEXT_SERVICE_DATE_TEXT}', 'open');
    insert into public.round_stops (
      id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_name_snapshot, floor_or_zone_snapshot, updated_by
    ) values (
      '${futureStopId}', '${futureRoundId}', '${SHOP_ID}', 'SHOP-1', 'Shop One',
      'Building A', 'Zone 1', '${ADMIN_ID}'
    );
    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values (
      date '${NEXT_SERVICE_DATE_TEXT}', '${TRUCK_ID}', '${ICE_ID}', 5
    );
  `);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${futureStopId}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000097', 'immediate'
      )
    `),
    /future service date/i,
  );
});

test('application users cannot create refills but managers retain legacy recovery RPC access', async (t) => {
  const db = await createDatabase(t);
  const privileges = await db.query(`
    select
      has_function_privilege(
        'authenticated',
        'public.record_daily_stock_refill(date,jsonb,text,uuid)',
        'EXECUTE'
      ) as can_record,
      has_function_privilege(
        'authenticated',
        'public.get_daily_stock_refill_history(date)',
        'EXECUTE'
      ) as can_view_history,
      has_function_privilege(
        'authenticated',
        'public.cancel_daily_stock_refill(uuid,text)',
        'EXECUTE'
      ) as can_cancel;
  `);

  assert.deepEqual(privileges.rows[0], {
    can_record: false,
    can_view_history: true,
    can_cancel: true,
  });
});

test('legacy half-bag refill is cancellable and aggregate close zeros the day', async (t) => {
  const db = await createDatabase(t);
  const refillKey = '70000000-0000-4000-8000-000000000090';
  const refillItems = JSON.stringify([{ ice_type_id: ICE_ID, quantity: 0.5 }]);

  await db.query(`
    select public.record_daily_stock_refill(
      date '${SERVICE_DATE}', '${refillItems}'::jsonb, 'เติมให้จุดบริการ', '${refillKey}'
    )
  `);
  await db.query(`
    select public.record_daily_stock_refill(
      date '${SERVICE_DATE}', '${refillItems}'::jsonb, 'เติมให้จุดบริการ', '${refillKey}'
    )
  `);
  let state = await db.query(`
    select
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as balance,
      (select count(*)::integer from public.daily_stock_uses) as uses
  `);
  assert.deepEqual(
    { balance: Number(state.rows[0].balance), uses: state.rows[0].uses },
    { balance: 29.5, uses: 1 },
  );

  const refill = await db.query(`
    select id from public.daily_stock_uses where idempotency_key = '${refillKey}'
  `);
  await db.exec(`
    update public.auth_context
    set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead'
  `);
  await db.query(`
    select public.cancel_daily_stock_refill('${refill.rows[0].id}', 'บันทึกผิด')
  `);
  const refillHistory = await db.query(`
    select public.get_daily_stock_refill_history(date '${SERVICE_DATE}') as result
  `);
  assert.equal(refillHistory.rows[0].result[0].status, 'cancelled');
  assert.equal(refillHistory.rows[0].result[0].cancellation_reason, 'บันทึกผิด');
  assert.equal(Number(refillHistory.rows[0].result[0].items[0].quantity), 0.5);
  state = await db.query(`
    select public.daily_aggregate_stock_balance_at(
      date '${SERVICE_DATE}', '${ICE_ID}'
    ) as balance
  `);
  assert.equal(Number(state.rows[0].balance), 30);

  await db.query(`
    select public.close_daily_aggregate_stock(
      date '${SERVICE_DATE}',
      '[{"ice_type_id":"${ICE_ID}","actual_quantity":30}]'::jsonb,
      null,
      '70000000-0000-4000-8000-000000000091'
    )
  `);
  state = await db.query(`
    select
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as balance,
      (select system_quantity from public.daily_aggregate_stock_closure_items
       where service_date = date '${SERVICE_DATE}' and ice_type_id = '${ICE_ID}') as system,
      (select status from public.daily_aggregate_stock_closures
       where service_date = date '${SERVICE_DATE}') as status,
      public.get_daily_aggregate_stock_summary(date '${SERVICE_DATE}') as summary
  `);
  assert.deepEqual(
    {
      balance: Number(state.rows[0].balance),
      system: Number(state.rows[0].system),
      status: state.rows[0].status,
      returned: Number(state.rows[0].summary.items[0].returned_quantity),
    },
    { balance: 0, system: 30, status: 'closed', returned: 30 },
  );

  await assert.rejects(
    db.query(`
      select public.record_daily_stock_refill(
        date '${SERVICE_DATE}', '${refillItems}'::jsonb, null,
        '70000000-0000-4000-8000-000000000092'
      )
    `),
    /already closed/i,
  );
});

test('aggregate close makes all stock movements immutable', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  await db.query(`
    select public.close_daily_aggregate_stock(
      date '${SERVICE_DATE}',
      '[{"ice_type_id":"${ICE_ID}","actual_quantity":30}]'::jsonb,
      null,
      '70000000-0000-4000-8000-000000000093'
    )
  `);

  await assert.rejects(
    db.query(`
      select public.record_factory_order(
        date '${SERVICE_DATE}', '${TRUCK_ID}', '${itemPayload(1)}'::jsonb, null,
        '70000000-0000-4000-8000-000000000092'
      )
    `),
    /already closed/i,
  );
  await assert.rejects(
    db.query(`
      select public.cancel_factory_order(
        '65000000-0000-4000-8000-000000000001', 'ยกเลิกหลังปิดวัน'
      )
    `),
    /already closed/i,
  );
  await assert.rejects(
    db.query(`
      update public.stock_movements
      set service_date = date '${NEXT_SERVICE_DATE_TEXT}'
      where id = '65000000-0000-4000-8000-000000000001'
    `),
    /already closed/i,
  );

  const movement = await db.query(`
    select service_date::text, status from public.stock_movements
    where id = '65000000-0000-4000-8000-000000000001'
  `);
  assert.deepEqual(movement.rows[0], {
    service_date: SERVICE_DATE,
    status: 'active',
  });
});

test('missing payment profile or effective price fails before stock and ledger writes', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`delete from public.shop_payment_profiles where shop_id = '${SHOP_ID}'`);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000002', 'immediate'
      )
    `),
    /payment profile/i,
  );

  await db.exec(`
    insert into public.shop_payment_profiles (
      shop_id, allowed_payment_terms, default_payment_term,
      allowed_payment_methods, default_payment_method, created_by
    ) values (
      '${SHOP_ID}', array['immediate']::public.payment_term[], 'immediate',
      array['cash']::public.payment_method[], 'cash', '${ADMIN_ID}'
    );
    delete from public.shop_ice_type_prices where shop_id = '${SHOP_ID}';
    delete from public.ice_type_prices where ice_type_id = '${ICE_ID}';
  `);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000003', 'immediate'
      )
    `),
    /effective price/i,
  );

  const counts = await db.query(`
    select
      (select count(*)::integer from public.delivery_events) as events,
      (select count(*)::integer from public.delivery_charges) as charges,
      public.stock_balance_at(date '${SERVICE_DATE}', '${HOLDING_ID}', '${ICE_ID}') as stock
  `);
  assert.deepEqual(counts.rows[0], { events: 0, charges: 0, stock: '0.0' });
});

test('financial correction reprices at original service date and cancellation voids its charge', async (t) => {
  const db = await createDatabase(t);
  const original = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000004', 'immediate'
    ) as result
  `);
  const originalEventId = original.rows[0].result.delivery_event_id;

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
    update public.shop_ice_type_prices
    set valid_to = date '${SERVICE_DATE}'
    where shop_id = '${SHOP_ID}' and ice_type_id = '${ICE_ID}';
    insert into public.shop_ice_type_prices (
      shop_id, ice_type_id, unit_price, valid_from, created_by
    ) values ('${SHOP_ID}', '${ICE_ID}', 30, date '${NEXT_SERVICE_DATE_TEXT}', '${ADMIN_ID}');
  `);

  await db.query(`
    select public.revise_delivery_event(
      '${originalEventId}', 'correct', '${itemPayload(3)}'::jsonb,
      'delivered', null, 'แก้จำนวน',
      '80000000-0000-4000-8000-000000000001'
    )
  `);

  const correction = await db.query(`
    select
      original.status as original_status,
      original_charge.status as original_charge_status,
      replacement.id as replacement_id,
      item.unit_price,
      replacement_charge.original_amount,
      replacement_charge.status as replacement_charge_status
    from public.delivery_events original
    join public.delivery_events replacement on replacement.corrects_event_id = original.id
    join public.delivery_items item on item.delivery_event_id = replacement.id
    join public.delivery_charges original_charge on original_charge.delivery_event_id = original.id
    join public.delivery_charges replacement_charge on replacement_charge.delivery_event_id = replacement.id
    where original.id = '${originalEventId}'
  `);
  assert.equal(correction.rows[0].original_status, 'cancelled');
  assert.equal(correction.rows[0].original_charge_status, 'voided');
  assert.equal(Number(correction.rows[0].unit_price), 18);
  assert.equal(Number(correction.rows[0].original_amount), 54);
  assert.equal(correction.rows[0].replacement_charge_status, 'active');

  await db.query(`
    select public.revise_delivery_event(
      '${correction.rows[0].replacement_id}', 'cancel', '[]'::jsonb,
      'delivered', null, 'ยกเลิกรายการ',
      '80000000-0000-4000-8000-000000000002'
    )
  `);
  const cancelled = await db.query(`
    select event.status, charge.status as charge_status
    from public.delivery_events event
    join public.delivery_charges charge on charge.delivery_event_id = event.id
    where event.id = '${correction.rows[0].replacement_id}'
  `);
  assert.deepEqual(cancelled.rows[0], { status: 'cancelled', charge_status: 'voided' });
});

test('credit correction preserves the original due date after the shop cycle changes', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit', allow_outstanding = true,
        credit_due_rule = 'net_days', credit_days = 30,
        credit_collection_weekday = null, credit_limit = null
    where shop_id = '${SHOP_ID}';
  `);
  const original = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000014', 'credit'
    ) as result
  `);

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
    update public.shop_payment_profiles
    set credit_due_rule = 'weekly', credit_days = null,
        credit_collection_weekday = 5
    where shop_id = '${SHOP_ID}';
  `);
  await db.query(`
    select public.revise_delivery_event(
      '${original.rows[0].result.delivery_event_id}', 'correct',
      '${itemPayload(3)}'::jsonb, 'delivered', null, 'แก้จำนวน',
      '80000000-0000-4000-8000-000000000014'
    )
  `);

  const dueDates = await db.query(`
    select original_charge.due_date as original_due_date,
      replacement_charge.due_date as replacement_due_date
    from public.delivery_events original
    join public.delivery_events replacement on replacement.corrects_event_id = original.id
    join public.delivery_charges original_charge on original_charge.delivery_event_id = original.id
    join public.delivery_charges replacement_charge on replacement_charge.delivery_event_id = replacement.id
    where original.id = '${original.rows[0].result.delivery_event_id}'
  `);
  assert.equal(
    dueDates.rows[0].replacement_due_date.getTime(),
    dueDates.rows[0].original_due_date.getTime(),
  );
});

test('credit correction preserves open collection and due-date workflows', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit', allow_outstanding = true,
        credit_due_rule = 'net_days', credit_days = 30, credit_limit = null
    where shop_id = '${SHOP_ID}';
  `);
  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '74000000-0000-4000-8000-000000000001', 'credit'
    ) as result
  `);
  const eventId = delivered.rows[0].result.delivery_event_id;
  const chargeId = delivered.rows[0].result.charge_id;
  const dueDate = delivered.rows[0].result.due_date;

  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const run = await db.query(`
    select public.open_collection_run(
      date '${SERVICE_DATE}', '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  const runId = run.rows[0].result.collection_run_id;
  await db.query(`select public.set_credit_charge_collection_assignment('${runId}', '${chargeId}', true)`);
  const requested = await db.query(`
    select public.request_credit_due_date_change(
      '${chargeId}', date '${dueDate}' + 7, 'customer requested more time'
    ) as result
  `);
  const requestId = requested.rows[0].result.id;

  await db.query(`
    select public.revise_delivery_event(
      '${eventId}', 'correct', '${itemPayload(0.5)}'::jsonb, 'delivered', null,
      'correct quantity', '74000000-0000-4000-8000-000000000002'
    )
  `);
  const replacement = await db.query(`
    select event.id as event_id, charge.id as charge_id
    from public.delivery_events event
    join public.delivery_charges charge on charge.delivery_event_id = event.id
    where event.corrects_event_id = '${eventId}' and event.status = 'active'
  `);
  const replacementEventId = replacement.rows[0].event_id;
  const replacementChargeId = replacement.rows[0].charge_id;
  const transferred = await db.query(`
    select
      (select charge_id from public.collection_run_credit_charges where collection_run_id = '${runId}') as assigned_charge_id,
      (select charge_id from public.credit_due_date_requests where id = '${requestId}') as request_charge_id
  `);
  assert.equal(transferred.rows[0].assigned_charge_id, replacementChargeId);
  assert.equal(transferred.rows[0].request_charge_id, replacementChargeId);

  const queue = await db.query(`select public.get_collection_run_queue('${runId}') as result`);
  assert.equal(queue.rows[0].result[0].charges[0].charge_id, replacementChargeId);

  await db.query(`
    select public.revise_delivery_event(
      '${replacementEventId}', 'correct', '[]'::jsonb, 'issue', 'delivery did not occur',
      'correct status', '74000000-0000-4000-8000-000000000003'
    )
  `);
  const closedWorkflows = await db.query(`
    select
      (select count(*)::integer from public.collection_run_credit_charges where collection_run_id = '${runId}') as assignment_count,
      (select status from public.credit_due_date_requests where id = '${requestId}') as request_status
  `);
  assert.equal(closedWorkflows.rows[0].assignment_count, 0);
  assert.equal(closedWorkflows.rows[0].request_status, 'rejected');
});

test('legacy unpriced correction stays outside the financial ledger', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
    insert into public.delivery_events (
      round_stop_id, recorded_by, idempotency_key, source_stock_location_id
    ) values (
      '${STOP_ID}', '${ADMIN_ID}', '70000000-0000-4000-8000-000000000005',
      '${SHOP_SOURCE_ID}'
    );
    insert into public.delivery_items (delivery_event_id, ice_type_id, quantity)
    select id, '${ICE_ID}', 1 from public.delivery_events
    where idempotency_key = '70000000-0000-4000-8000-000000000005';
  `);
  const legacy = await db.query(`
    select id from public.delivery_events
    where idempotency_key = '70000000-0000-4000-8000-000000000005'
  `);

  await db.query(`
    select public.revise_delivery_event(
      '${legacy.rows[0].id}', 'correct', '${itemPayload(2)}'::jsonb,
      'delivered', null, 'แก้ legacy',
      '80000000-0000-4000-8000-000000000003'
    )
  `);

  const replacement = await db.query(`
    select item.unit_price,
      (select count(*)::integer from public.delivery_charges charge
       where charge.delivery_event_id = event.id) as charges
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id = event.id
    where event.corrects_event_id = '${legacy.rows[0].id}'
  `);
  assert.deepEqual(replacement.rows[0], { unit_price: null, charges: 0 });
});

test('charge reference migration backfills history and advances the sequence for new charges', async (t) => {
  const db = await createDatabase(t, { applyCollectionShopCards: false });
  const original = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000099', 'immediate'
    ) as result
  `);
  const originalEventId = original.rows[0].result.delivery_event_id;

  await db.exec(collectionShopCardsAndChargeNumbers);
  const historical = await db.query(`
    select charge_number
    from public.delivery_charges
    where delivery_event_id = '${originalEventId}'
  `);
  assert.match(historical.rows[0].charge_number, /^C\d{6}-000001$/);

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin'
  `);
  await db.query(`
    select public.revise_delivery_event(
      '${originalEventId}', 'correct', '${itemPayload(2)}'::jsonb,
      'delivered', null, 'verify charge sequence',
      '80000000-0000-4000-8000-000000000099'
    )
  `);
  const references = await db.query(`
    select charge_number
    from public.delivery_charges
    order by charge_number
  `);
  assert.deepEqual(
    references.rows.map((row) => row.charge_number.slice(-6)),
    ['000001', '000002'],
  );
  assert.equal(new Set(references.rows.map((row) => row.charge_number)).size, 2);
});

test('credit-limit approval must match and is consumed by exactly one delivery', async (t) => {
  const db = await createDatabase(t);
  const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0];
  const expectedDueDate = new Date(Date.now() + 7 * 3600000);
  expectedDueDate.setDate(expectedDueDate.getDate() + 30);
  const expectedDueDateStr = expectedDueDate.toISOString().split('T')[0];

  await db.exec(`
    update public.delivery_rounds
    set service_date = date '${todayStr}'
    where id = '${ROUND_ID}';
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit',
        allow_outstanding = true,
        credit_due_rule = 'net_days',
        credit_days = 30,
        credit_limit = 20
    where shop_id = '${SHOP_ID}';
    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values (
      date '${todayStr}',
      '${HOLDING_ID}', '${ICE_ID}', 10
    ) on conflict (service_date, location_id, ice_type_id) do update
      set quantity = excluded.quantity;
  `);
  const fingerprint = await db.query(`
    select public.delivery_request_fingerprint(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, 'credit'
    ) as value
  `);
  const approval = await db.query(`
    insert into public.financial_approval_requests (
      shop_id, round_stop_id, kind, requested_amount, reason,
      request_fingerprint, status, requested_by, decided_by, decided_at
    ) values (
      '${SHOP_ID}', '${STOP_ID}', 'credit_limit', 35, 'credit test',
      '${fingerprint.rows[0].value}', 'approved', '${COURIER_ID}', '${ADMIN_ID}', now()
    ) returning id
  `);
  const approvalId = approval.rows[0].id;

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000006', 'credit', '${approvalId}'
      )
    `),
    /approval does not match/i,
  );

  await db.exec(`
    update public.financial_approval_requests
    set requested_amount = 36
    where id = '${approvalId}'
  `);
  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000006', 'credit', '${approvalId}'
    ) as result
  `);
  assert.equal(Number(delivered.rows[0].result.total_amount), 36);
  assert.equal(delivered.rows[0].result.payment_term, 'credit');
  assert.equal(delivered.rows[0].result.due_date, expectedDueDateStr);

  const consumed = await db.query(`
    select status, consumed_by_delivery_event_id
    from public.financial_approval_requests where id = '${approvalId}'
  `);
  assert.deepEqual(consumed.rows[0], {
    status: 'consumed',
    consumed_by_delivery_event_id: delivered.rows[0].result.delivery_event_id,
  });

  const retry = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000006', 'credit', '${approvalId}'
    ) as result
  `);
  assert.equal(retry.rows[0].result.delivery_event_id, delivered.rows[0].result.delivery_event_id);
});

test('credit-limit approval expires after its business day', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.delivery_rounds
    set service_date = (now() at time zone 'Asia/Bangkok')::date - 1
    where id = '${ROUND_ID}';
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit',
        allow_outstanding = true,
        credit_due_rule = 'net_days',
        credit_days = 30,
        credit_limit = 20
    where shop_id = '${SHOP_ID}';
    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values (
      (now() at time zone 'Asia/Bangkok')::date - 1,
      '${HOLDING_ID}', '${ICE_ID}', 10
    ) on conflict (service_date, location_id, ice_type_id) do update
      set quantity = excluded.quantity;
    insert into public.stock_movements (
      id, service_date, kind, to_location_id, idempotency_key, recorded_by
    ) values (
      '65000000-0000-4000-8000-000000000020',
      (now() at time zone 'Asia/Bangkok')::date - 1,
      'factory_order', '${TRUCK_ID}',
      '65000000-0000-4000-8000-000000000021', '${ADMIN_ID}'
    );
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('65000000-0000-4000-8000-000000000020', '${ICE_ID}', 10);
  `);
  const fingerprint = await db.query(`
    select public.delivery_request_fingerprint(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, 'credit'
    ) as value
  `);
  const approval = await db.query(`
    insert into public.financial_approval_requests (
      shop_id, round_stop_id, kind, requested_amount, reason,
      request_fingerprint, status, requested_by, decided_by, decided_at
    ) values (
      '${SHOP_ID}', '${STOP_ID}', 'credit_limit', 36, 'expired credit test',
      '${fingerprint.rows[0].value}', 'approved', '${COURIER_ID}', '${ADMIN_ID}', now()
    ) returning id
  `);

  await assert.rejects(
    db.query(`
      select public.record_delivery(
        '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
        '70000000-0000-4000-8000-000000000010', 'credit', '${approval.rows[0].id}'
      )
    `),
    /approval has expired/i,
  );
});

test('active payment allocations block financial cancellation', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000007', 'immediate'
    ) as result
  `);
  await db.exec(`
    begin;
    with payment as (
      insert into public.payments (
        shop_id, payment_method, received_amount, allocated_amount,
        idempotency_key, request_fingerprint, recorded_by
      ) values (
        '${SHOP_ID}', 'cash', 18, 18,
        '90000000-0000-4000-8000-000000000001', 'payment', '${COURIER_ID}'
      ) returning id
    )
    insert into public.payment_allocations (payment_id, charge_id, amount)
    select payment.id, '${delivery.rows[0].result.charge_id}', 18 from payment;
    commit;
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);

  await assert.rejects(
    db.query(`
      select public.revise_delivery_event(
        '${delivery.rows[0].result.delivery_event_id}', 'cancel', '[]'::jsonb,
        'delivered', null, 'cannot cancel paid',
        '80000000-0000-4000-8000-000000000004'
      )
    `),
    /void active payment allocations/i,
  );
  const state = await db.query(`
    select event.status, charge.status as charge_status
    from public.delivery_events event
    join public.delivery_charges charge on charge.delivery_event_id = event.id
    where event.id = '${delivery.rows[0].result.delivery_event_id}'
  `);
  assert.deepEqual(state.rows[0], { status: 'active', charge_status: 'active' });
});

test('correcting a priced delivery to an issue voids the charge without replacing it', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '70000000-0000-4000-8000-000000000009', 'immediate'
    ) as result
  `);
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin'
  `);
  await db.query(`
    select public.revise_delivery_event(
      '${delivery.rows[0].result.delivery_event_id}', 'correct', '[]'::jsonb,
      'issue', 'บันทึกผิด ร้านปิด', 'แก้สถานะ',
      '80000000-0000-4000-8000-000000000005'
    )
  `);
  const state = await db.query(`
    select
      original.status as original_status,
      original_charge.status as original_charge_status,
      replacement.id as replacement_id,
      replacement.status as replacement_status,
      (select count(*)::integer from public.delivery_charges charge
       where charge.delivery_event_id = replacement.id) as replacement_charges,
      stop.status as stop_status,
      stop.note
    from public.delivery_events original
    join public.delivery_events replacement on replacement.corrects_event_id = original.id
    join public.delivery_charges original_charge on original_charge.delivery_event_id = original.id
    join public.round_stops stop on stop.id = replacement.round_stop_id
    where original.id = '${delivery.rows[0].result.delivery_event_id}'
  `);
  const { replacement_id: issueEventId, ...issueState } = state.rows[0];
  assert.deepEqual(issueState, {
    original_status: 'cancelled',
    original_charge_status: 'voided',
    replacement_status: 'active',
    replacement_charges: 0,
    stop_status: 'issue',
    note: 'บันทึกผิด ร้านปิด',
  });

  await db.query(`
    select public.revise_delivery_event(
      '${issueEventId}', 'correct', '${itemPayload(1)}'::jsonb,
      'delivered', null, 'แก้กลับเป็นส่งแล้ว',
      '80000000-0000-4000-8000-000000000006'
    )
  `);
  const restored = await db.query(`
    select item.unit_price, charge.original_amount, charge.payment_term,
      charge.status as charge_status
    from public.delivery_events issue
    join public.delivery_events replacement on replacement.corrects_event_id = issue.id
    join public.delivery_items item on item.delivery_event_id = replacement.id
    join public.delivery_charges charge on charge.delivery_event_id = replacement.id
    where issue.id = '${issueEventId}'
  `);
  assert.deepEqual(restored.rows[0], {
    unit_price: '18.00',
    original_amount: '18.00',
    payment_term: 'immediate',
    charge_status: 'active',
  });
});

test('revision retries created before fingerprinting remain idempotent', async (t) => {
  const db = await createDatabase(t);
  const legacyEvent = await db.query(`
    insert into public.delivery_events (
      round_stop_id, recorded_by, idempotency_key, source_stock_location_id,
      status, cancelled_by, cancelled_at, cancellation_reason
    ) values (
      '${STOP_ID}', '${ADMIN_ID}', '70000000-0000-4000-8000-000000000011',
      '${SHOP_SOURCE_ID}', 'cancelled', '${ADMIN_ID}', now(), 'legacy cancellation'
    ) returning id
  `);
  await db.exec(`
    insert into public.delivery_event_revisions (
      idempotency_key, original_event_id, action, reason, revised_by,
      request_fingerprint
    ) values (
      '80000000-0000-4000-8000-000000000007', '${legacyEvent.rows[0].id}',
      'cancel', 'legacy cancellation', '${ADMIN_ID}', null
    );
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);

  const retry = await db.query(`
    select public.revise_delivery_event(
      '${legacyEvent.rows[0].id}', 'cancel', '[]'::jsonb,
      'delivered', null, 'legacy cancellation',
      '80000000-0000-4000-8000-000000000007'
    ) as result
  `);
  assert.equal(retry.rows[0].result.round_id, ROUND_ID);
});

test('payment recording enforces actor scope, collection scope, and stored evidence', async (t) => {
  const db = await createDatabase(t);
  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000001', 'immediate'
    ) as result
  `);
  const chargeId = delivered.rows[0].result.charge_id;

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  const run = await db.query(`
    select public.open_collection_run(
      date '${SERVICE_DATE}',
      '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  await db.exec(`
    update public.auth_context
    set user_id = '${OTHER_COURIER_ID}', app_role = 'courier';
  `);

  await assert.rejects(
    db.query(`
      select public.record_payment(
        '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":18}]'::jsonb,
        'cash', 18, null, null, null, 18, null,
        '90000000-0000-4000-8000-000000000002'
      )
    `),
    /assigned scope/i,
  );
  const queue = await db.query(`
    select public.get_today_collection_run_queue('${run.rows[0].result.collection_run_id}') as result
  `);
  assert.equal(queue.rows[0].result[0].charges[0].charge_id, chargeId);
  assert.match(queue.rows[0].result[0].charges[0].charge_number, /^C\d{6}-\d{6}$/);
  assert.equal(Object.hasOwn(queue.rows[0].result[0], 'image_path'), true);

  await db.exec(`
    update public.auth_context
    set user_id = '${COURIER_ID}', app_role = 'courier';
    update public.shop_payment_profiles
    set allowed_payment_terms = array['immediate', 'end_of_day']::public.payment_term[]
    where shop_id = '${SHOP_ID}';
  `);
  const endOfDayDelivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000007', 'end_of_day'
    ) as result
  `);
  await assert.rejects(
    db.query(`
      select public.record_payment(
        '${SHOP_ID}',
        '[{"charge_id":"${endOfDayDelivery.rows[0].result.charge_id}","amount":18}]'::jsonb,
        'cash', 18, null, null, null, 18, null,
        '90000000-0000-4000-8000-000000000008'
      )
    `),
    /assigned scope/i,
  );

  await db.exec(`
    update public.shop_payment_profiles
    set cash_evidence_required = true
    where shop_id = '${SHOP_ID}';
  `);
  const evidencePath = `${COURIER_ID}/payment.webp`;
  await assert.rejects(
    db.query(`
      select public.record_payment(
        '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":18}]'::jsonb,
        'cash', 18, null, '${evidencePath}', null, 18, null,
        '90000000-0000-4000-8000-000000000004'
      )
    `),
    /evidence does not exist/i,
  );

  await db.exec(`
    insert into storage.objects (bucket_id, name)
    values ('payment-evidence', '${evidencePath}');
  `);
  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":18}]'::jsonb,
      'cash', 18, null, '${evidencePath}', null, 18, null,
      '90000000-0000-4000-8000-000000000004'
    ) as result
  `);
  assert.equal(Number(payment.rows[0].result.allocated_amount), 18);
});

test('payment receipts keep their issued content after source data changes', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000030', 'immediate'
    ) as result
  `);
  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}',
      '[{"charge_id":"${delivery.rows[0].result.charge_id}","amount":18}]'::jsonb,
      'cash', 18, null, null, null, 18, null,
      '90000000-0000-4000-8000-000000000031'
    ) as result
  `);
  const paymentId = payment.rows[0].result.payment_id;

  await db.exec(`
    update public.shops set name = 'Renamed Shop' where id = '${SHOP_ID}';
    update public.ice_types set name = 'Renamed Ice' where id = '${ICE_ID}';
  `);

  const snapshot = await db.query(`
    select public.get_payment_receipt_snapshot('${paymentId}') as result
  `);
  assert.equal(snapshot.rows[0].result.shop_name, 'Shop One');
  assert.equal(snapshot.rows[0].result.charges[0].items[0].ice_type_name, 'Ice');
  assert.equal(Number(snapshot.rows[0].result.charges[0].items[0].quantity), 1);

  const items = await db.query(`
    select * from public.get_payment_receipt_items('${paymentId}')
  `);
  assert.equal(items.rows[0].ice_type_name, 'Ice');
  assert.equal(Number(items.rows[0].quantity), 1);

  await assert.rejects(
    db.query(`update public.payment_receipt_snapshots set receipt_data = '{}' where payment_id = '${paymentId}'`),
    /immutable/i,
  );

  await db.exec(`
    update public.auth_context
    set user_id = '${OTHER_COURIER_ID}', app_role = 'courier';
  `);
  await assert.rejects(
    db.query(`select public.get_payment_receipt_snapshot('${paymentId}')`),
    /cannot be viewed/i,
  );
});

test('couriers can void their own payments but not payments recorded by another courier', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000020', 'immediate'
    ) as result
  `);
  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}',
      '[{"charge_id":"${delivery.rows[0].result.charge_id}","amount":18}]'::jsonb,
      'cash', 18, null, null, null, 18, null,
      '90000000-0000-4000-8000-000000000021'
    ) as result
  `);
  const paymentId = payment.rows[0].result.payment_id;

  await db.exec(`
    update public.auth_context
    set user_id = '${OTHER_COURIER_ID}', app_role = 'courier';
  `);
  await assert.rejects(
    db.query(`select public.void_payment('${paymentId}', 'not my payment')`),
    /Couriers can only void payments they recorded/i,
  );

  await db.exec(`
    update public.auth_context
    set user_id = '${COURIER_ID}', app_role = 'courier';
  `);
  await db.query(`select public.void_payment('${paymentId}', 'wrong amount')`);

  const result = await db.query(`
    select payment.status, payment.voided_by, payment.void_reason,
      exists (
        select 1 from public.audit_logs audit
        where audit.entity_type = 'payments'
          and audit.entity_id = payment.id
          and audit.action = 'voided'
      ) as audited
    from public.payments payment
    where payment.id = '${paymentId}'
  `);
  assert.deepEqual(result.rows[0], {
    status: 'voided',
    voided_by: COURIER_ID,
    void_reason: 'wrong amount',
    audited: true,
  });
});

test('credit account settings are admin-only, audited, and suspension blocks new credit', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit', allow_outstanding = true,
        credit_due_rule = 'net_days', credit_days = 30, credit_limit = 500
    where shop_id = '${SHOP_ID}';
  `);

  await db.query(`select public.update_credit_account_settings(
    '${SHOP_ID}', '{"credit_limit":400,"credit_suspended":true,"credit_suspension_reason":"manual review"}'::jsonb
  )`);
  const audited = await db.query(`
    select after_value from public.audit_logs
    where entity_type = 'shop_payment_profiles' and action = 'updated'
    order by occurred_at desc limit 1
  `);
  assert.equal(audited.rows[0].after_value.credit_suspended, true);
  assert.equal(audited.rows[0].after_value.credit_limit, 400);

  await db.exec(`update public.auth_context set user_id = '${COURIER_ID}', app_role = 'courier'`);
  await assert.rejects(
    db.query(`select public.update_credit_account_settings('${SHOP_ID}', '{"credit_limit":300}'::jsonb)`),
    /only an admin/i,
  );
  await assert.rejects(
    db.query(`select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '92000000-0000-4000-8000-000000000007', 'credit'
    )`),
    /credit is suspended/i,
  );
});

test('couriers collect prior balances together with new charges from today', async (t) => {
  const db = await createDatabase(t);
  const priorDelivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000010', 'immediate'
    ) as result
  `);
  const priorChargeId = priorDelivery.rows[0].result.charge_id;

  await db.exec(`
    update public.delivery_charges set service_date = date '${PREVIOUS_SERVICE_DATE_TEXT}'
    where id = '${priorChargeId}';
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  const run = await db.query(`
    select public.open_collection_run(
      date '${SERVICE_DATE}', '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  const todayDelivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000013', 'immediate'
    ) as result
  `);
  const todayChargeId = todayDelivery.rows[0].result.charge_id;
  await db.exec(`
    update public.shop_payment_profiles
    set allow_outstanding = true
    where shop_id = '${SHOP_ID}';
    update public.auth_context set user_id = '${COURIER_ID}', app_role = 'courier';
  `);

  await assert.rejects(
    db.query(`
      select public.get_collection_run_queue(
        '${run.rows[0].result.collection_run_id}'
      )
    `),
    /not assigned to this user/i,
  );
  await db.exec(`
    update public.auth_context set user_id = '${OTHER_COURIER_ID}', app_role = 'courier';
  `);

  const canonicalQueue = await db.query(`
    select public.get_collection_run_queue(
      '${run.rows[0].result.collection_run_id}'
    ) as result
  `);
  const compatibilityQueue = await db.query(`
    select public.get_today_collection_run_queue(
      '${run.rows[0].result.collection_run_id}'
    ) as result
  `);
  assert.deepEqual(compatibilityQueue.rows[0].result, canonicalQueue.rows[0].result);

  const queueShop = canonicalQueue.rows[0].result[0];
  assert.equal(Number(queueShop.outstanding_amount), 36);
  assert.equal(queueShop.charge_count, 2);
  assert.deepEqual(
    queueShop.charges.map((charge) => charge.service_date),
    [PREVIOUS_SERVICE_DATE_TEXT, SERVICE_DATE],
  );
  assert.deepEqual(
    queueShop.charges.map((charge) => charge.charge_id),
    [priorChargeId, todayChargeId],
  );
  assert.deepEqual(
    queueShop.charges.map((charge) => charge.items.map((item) => ({
      ice_type_id: item.ice_type_id,
      name: item.name,
      unit: item.unit,
      quantity: Number(item.quantity),
      line_total: Number(item.line_total),
    }))),
    [
      [{ ice_type_id: ICE_ID, name: 'Ice', unit: 'bag', quantity: 1, line_total: 18 }],
      [{ ice_type_id: ICE_ID, name: 'Ice', unit: 'bag', quantity: 1, line_total: 18 }],
    ],
  );

  const partialPayment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${priorChargeId}","amount":10}]'::jsonb,
      'cash', 10, null, null, '${run.rows[0].result.collection_run_id}', 36, null,
      '90000000-0000-4000-8000-000000000011'
    ) as result
  `);
  assert.equal(Number(partialPayment.rows[0].result.allocated_amount), 10);

  const remainingQueue = await db.query(`
    select public.get_collection_run_queue(
      '${run.rows[0].result.collection_run_id}'
    ) as result
  `);
  assert.equal(Number(remainingQueue.rows[0].result[0].outstanding_amount), 26);
  assert.deepEqual(
    remainingQueue.rows[0].result[0].charges.map((charge) => Number(charge.outstanding_amount)),
    [8, 18],
  );

  const finalPayment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[
        {"charge_id":"${priorChargeId}","amount":8},
        {"charge_id":"${todayChargeId}","amount":18}
      ]'::jsonb,
      'cash', 26, null, null, '${run.rows[0].result.collection_run_id}', 26, null,
      '90000000-0000-4000-8000-000000000012'
    ) as result
  `);
  assert.equal(Number(finalPayment.rows[0].result.allocated_amount), 26);
});

test('credit collection includes due charges automatically and supports planned future collection', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit', allow_outstanding = true,
        credit_due_rule = 'net_days', credit_days = 30, credit_limit = null
    where shop_id = '${SHOP_ID}';
  `);
  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '92000000-0000-4000-8000-000000000001', 'credit'
    ) as result
  `);
  const chargeId = delivered.rows[0].result.charge_id;
  const dueDate = delivered.rows[0].result.due_date;
  const secondDelivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '92000000-0000-4000-8000-000000000005', 'credit'
    ) as result
  `);
  const secondChargeId = secondDelivery.rows[0].result.charge_id;

  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const todayRun = await db.query(`
    select public.open_collection_run(
      date '${SERVICE_DATE}', '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  await db.query(`select public.set_credit_charge_collection_assignment(
    '${todayRun.rows[0].result.collection_run_id}', '${chargeId}', true
  )`);
  await db.exec(`update public.auth_context set user_id = '${OTHER_COURIER_ID}', app_role = 'courier'`);
  const plannedQueue = await db.query(`
    select public.get_collection_run_queue('${todayRun.rows[0].result.collection_run_id}') as result
  `);
  assert.equal(plannedQueue.rows[0].result[0].charges[0].charge_id, chargeId);

  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const dueRun = await db.query(`
    select public.open_collection_run(
      date '${dueDate}', '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  const dueRunId = dueRun.rows[0].result.collection_run_id;
  await db.exec(`update public.auth_context set user_id = '${OTHER_COURIER_ID}', app_role = 'courier'`);
  const automaticQueue = await db.query(`
    select public.get_collection_run_queue('${dueRunId}') as result
  `);
  const automaticCharges = automaticQueue.rows[0].result[0].charges;
  assert.equal(automaticCharges.length, 2);
  await assert.rejects(
    db.query(`select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${automaticCharges[1].charge_id}","amount":18}]'::jsonb,
      'cash', 18, null, null, '${dueRunId}', 36, null,
      '92000000-0000-4000-8000-000000000006'
    )`),
    /oldest due balance first/i,
  );
  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${automaticCharges[0].charge_id}","amount":18}]'::jsonb,
      'cash', 18, null, null, '${dueRunId}', 36, null,
      '92000000-0000-4000-8000-000000000003'
    ) as result
  `);
  assert.equal(Number(payment.rows[0].result.allocated_amount), 18);

  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const receivableSummary = await db.query(`
    select public.get_credit_receivables(date '${dueDate}') as result
  `);
  assert.deepEqual(receivableSummary.rows[0].result[0].charges, []);
  assert.deepEqual(receivableSummary.rows[0].result[0].payments, []);
  assert.equal(Number(receivableSummary.rows[0].result[0].outstanding_amount), 18);
  assert.equal(Number(receivableSummary.rows[0].result[0].due_today_amount), 18);

  const receivableDetail = await db.query(`
    select public.get_credit_receivable_detail('${SHOP_ID}', date '${dueDate}') as result
  `);
  assert.equal(receivableDetail.rows[0].result.charges.length, 2);
  assert.equal(receivableDetail.rows[0].result.payments.length, 1);
  assert.equal(receivableDetail.rows[0].result.payments[0].allocations[0].charge_id, automaticCharges[0].charge_id);
});

test('due-date approval is auditable, guarded, and preserves unlimited credit', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit', allow_outstanding = true,
        credit_due_rule = 'net_days', credit_days = 30, credit_limit = null
    where shop_id = '${SHOP_ID}';
  `);
  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      '92000000-0000-4000-8000-000000000004', 'credit'
    ) as result
  `);
  const chargeId = delivered.rows[0].result.charge_id;
  const dueDate = delivered.rows[0].result.due_date;
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const run = await db.query(`
    select public.open_collection_run(
      date '${dueDate}', '[{"user_id":"${OTHER_COURIER_ID}"}]'::jsonb
    ) as result
  `);
  const runId = run.rows[0].result.collection_run_id;
  await db.exec(`
    select public.set_credit_charge_collection_assignment('${runId}', '${chargeId}', true);
    update public.auth_context set user_id = '${OTHER_COURIER_ID}', app_role = 'courier';
  `);
  const requested = await db.query(`
    select public.request_credit_due_date_change(
      '${chargeId}', date '${dueDate}' + 7, 'customer requested more time'
    ) as result
  `);
  const requestId = requested.rows[0].result.id;

  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  await assert.rejects(
    db.query(`update public.delivery_charges set due_date = date '${dueDate}' + 3 where id = '${chargeId}'`),
    /approved due-date request/i,
  );
  await db.query(`select public.decide_credit_due_date_request('${requestId}', 'approved', null)`);

  const state = await db.query(`
    select charge.due_date, (date '${dueDate}' + 7) as expected_due_date,
      request.status, request.decided_by,
      (select count(*)::integer from public.collection_run_credit_charges assignment
        where assignment.charge_id = charge.id) as assignment_count
    from public.delivery_charges charge
    join public.credit_due_date_requests request on request.charge_id = charge.id
    where charge.id = '${chargeId}'
  `);
  assert.equal(state.rows[0].due_date.getTime(), state.rows[0].expected_due_date.getTime());
  assert.equal(state.rows[0].status, 'approved');
  assert.equal(state.rows[0].decided_by, ADMIN_ID);
  assert.equal(state.rows[0].assignment_count, 0);

  const receivables = await db.query(`
    select public.get_credit_receivables(date '${dueDate}') as result
  `);
  assert.equal(receivables.rows[0].result[0].credit_limit, null);
  assert.equal(receivables.rows[0].result[0].available_credit_amount, null);
});

test('daily aggregate completion patches the pre-recovery payment contract', async (t) => {
  const db = await createDatabase(t);
  await db.exec(legacyRecordPayment);
  await db.exec(dailyAggregateCompletion);

  const definition = await db.query(`
    select pg_get_functiondef(
      'public.record_payment(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure
    ) as value
  `);
  assert.match(definition.rows[0].value, /charge\.payment_term not in \('immediate', 'end_of_day'\)/i);
  assert.match(definition.rows[0].value, /charge\.service_date is distinct from v_collection_service_date/i);
});

test('an approved outstanding exception is consumed by one partial payment', async (t) => {
  const db = await createDatabase(t);
  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      '90000000-0000-4000-8000-000000000005', 'immediate'
    ) as result
  `);
  const chargeId = delivered.rows[0].result.charge_id;
  const approval = await db.query(`
    select public.request_financial_approval(
      '${STOP_ID}', 'outstanding_balance', '[]'::jsonb, 'immediate',
      16, 'ลูกค้าจ่ายบางส่วน', '${chargeId}'
    ) as result
  `);
  assert.equal(approval.rows[0].result.status, 'pending');

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  await db.query(`
    select public.decide_financial_approval(
      '${approval.rows[0].result.id}', 'approved', null
    )
  `);
  await db.exec(`
    update public.auth_context
    set user_id = '${COURIER_ID}', app_role = 'courier';
  `);

  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":20}]'::jsonb,
      'cash', 20, null, null, null, 36, '${approval.rows[0].result.id}',
      '90000000-0000-4000-8000-000000000006'
    ) as result
  `);
  assert.equal(Number(payment.rows[0].result.allocated_amount), 20);

  const consumed = await db.query(`
    select approval.status, approval.consumed_by_payment_id,
      payment.approval_request_id
    from public.financial_approval_requests approval
    join public.payments payment on payment.id = approval.consumed_by_payment_id
    where approval.id = '${approval.rows[0].result.id}'
  `);
  assert.deepEqual(consumed.rows[0], {
    status: 'consumed',
    consumed_by_payment_id: payment.rows[0].result.payment_id,
    approval_request_id: approval.rows[0].result.id,
  });

  const retry = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":20}]'::jsonb,
      'cash', 20, null, null, null, 36, '${approval.rows[0].result.id}',
      '90000000-0000-4000-8000-000000000006'
    ) as result
  `);
  assert.equal(retry.rows[0].result.payment_id, payment.rows[0].result.payment_id);
});

test('credit collection cycles resolve weekly, month-end, and net-day due dates', async (t) => {
  const db = await createDatabase(t);
  const recordDeliveryDefinition = await db.query(`
    select pg_get_functiondef(
      'public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)'::regprocedure
    ) as definition
  `);
  assert.match(
    recordDeliveryDefinition.rows[0].definition,
    /pg_advisory_xact_lock\([\s\S]*?'financial-shop:'[\s\S]*?select profile\.\* into v_profile[\s\S]*?where profile\.shop_id = v_shop_id\s+for share/i,
  );
  await db.exec(`
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit', allow_outstanding = true,
        credit_due_rule = 'weekly', credit_days = null,
        credit_collection_weekday = 5
    where shop_id = '${SHOP_ID}';
  `);

  const weekly = await db.query(`
    select
      public.resolve_credit_due_date('${SHOP_ID}', date '2026-07-26') as from_sunday,
      public.resolve_credit_due_date('${SHOP_ID}', date '2026-07-31') as on_friday
  `);
  assert.equal(weekly.rows[0].from_sunday.toISOString().slice(0, 10), '2026-07-31');
  assert.equal(weekly.rows[0].on_friday.toISOString().slice(0, 10), '2026-07-31');

  await db.exec(`
    insert into public.collection_runs (
      service_date, status, opened_by, closed_by, closed_at
    ) values (
      date '2026-07-31', 'closed', '${ADMIN_ID}', '${ADMIN_ID}', now()
    );
    insert into public.collection_runs (service_date, opened_by)
    values (date '2026-07-31', '${ADMIN_ID}');
  `);
  const afterFirstClose = await db.query(`
    select public.resolve_credit_due_date('${SHOP_ID}', date '2026-07-31') as due_date
  `);
  assert.equal(afterFirstClose.rows[0].due_date.toISOString().slice(0, 10), '2026-08-07');

  await db.exec(`
    update public.shop_payment_profiles
    set credit_due_rule = 'end_of_month', credit_days = null,
        credit_collection_weekday = null
    where shop_id = '${SHOP_ID}';
  `);
  const monthEnds = await db.query(`
    select
      public.resolve_credit_due_date('${SHOP_ID}', date '2026-02-10') as feb_28,
      public.resolve_credit_due_date('${SHOP_ID}', date '2028-02-10') as feb_29,
      public.resolve_credit_due_date('${SHOP_ID}', date '2026-04-30') as apr_30,
      public.resolve_credit_due_date('${SHOP_ID}', date '2026-01-15') as jan_31
  `);
  assert.deepEqual(Object.fromEntries(Object.entries(monthEnds.rows[0]).map(([key, value]) => [
    key, value.toISOString().slice(0, 10),
  ])), {
    feb_28: '2026-02-28',
    feb_29: '2028-02-29',
    apr_30: '2026-04-30',
    jan_31: '2026-01-31',
  });

  await db.exec(`
    insert into public.collection_runs (
      service_date, status, opened_by, closed_by, closed_at
    ) values (
      date '2026-02-28', 'closed', '${ADMIN_ID}', '${ADMIN_ID}', now()
    );
  `);
  const afterMonthEndClose = await db.query(`
    select public.resolve_credit_due_date('${SHOP_ID}', date '2026-02-10') as due_date
  `);
  assert.equal(afterMonthEndClose.rows[0].due_date.toISOString().slice(0, 10), '2026-03-31');

  await db.exec(`
    update public.shop_payment_profiles
    set credit_due_rule = 'net_days', credit_days = 30,
        credit_collection_weekday = null
    where shop_id = '${SHOP_ID}';
  `);
  const netDays = await db.query(`
    select public.resolve_credit_due_date('${SHOP_ID}', date '2026-07-01') as due_date
  `);
  assert.equal(netDays.rows[0].due_date.toISOString().slice(0, 10), '2026-07-31');

  await assert.rejects(
    db.exec(`
      update public.shop_payment_profiles
      set credit_due_rule = 'weekly', credit_days = 30,
          credit_collection_weekday = 5
      where shop_id = '${SHOP_ID}';
    `),
    /shop_payment_profiles_credit_collection_cycle_check/,
  );

  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin', is_active = true;
  `);
  await assert.rejects(
    db.query(`
      select public.update_credit_account_settings(
        '${SHOP_ID}', '{"credit_due_rule":"end_of_month"}'::jsonb
      )
    `),
    /must include rule, days, and weekday/,
  );

  const updatedCycle = await db.query(`
    select public.update_credit_account_settings(
      '${SHOP_ID}',
      '{"credit_due_rule":"weekly","credit_days":null,"credit_collection_weekday":2}'::jsonb
    ) as result
  `);
  assert.equal(updatedCycle.rows[0].result.credit_due_rule, 'weekly');
  assert.equal(updatedCycle.rows[0].result.credit_days, null);
  assert.equal(updatedCycle.rows[0].result.credit_collection_weekday, 2);
});

test('record_delivery uses database acceptance after the first close as its cutoff', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.auth_context
    set user_id = '${ADMIN_ID}', app_role = 'admin', is_active = true;
    update public.delivery_rounds set service_date = date '2026-07-31'
    where id = '${ROUND_ID}';
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit', allow_outstanding = true,
        credit_due_rule = 'weekly', credit_days = null,
        credit_collection_weekday = 5, credit_limit = null
    where shop_id = '${SHOP_ID}';
    insert into public.collection_runs (
      service_date, status, opened_by, closed_by, closed_at
    ) values (
      date '2026-07-31', 'closed', '${ADMIN_ID}', '${ADMIN_ID}', now()
    );
    insert into public.collection_runs (service_date, opened_by)
    values (date '2026-07-31', '${ADMIN_ID}');
    insert into public.test_opening_balances (
      service_date, location_id, ice_type_id, quantity
    ) values (
      date '2026-07-31', '${HOLDING_ID}', '${ICE_ID}', 10
    ) on conflict (service_date, location_id, ice_type_id) do update
      set quantity = excluded.quantity;
    insert into public.stock_movements (
      id, service_date, kind, to_location_id, idempotency_key, recorded_by
    ) values (
      '65000000-0000-4000-8000-000000000099', date '2026-07-31',
      'factory_order', '${TRUCK_ID}',
      '65000000-0000-4000-8000-000000000098', '${ADMIN_ID}'
    );
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('65000000-0000-4000-8000-000000000099', '${ICE_ID}', 10);
  `);

  const delivered = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null,
      timestamptz '2026-07-31 08:00:00+07',
      '70000000-0000-4000-8000-000000000099', 'credit', null
    ) as result
  `);
  assert.equal(delivered.rows[0].result.due_date, '2026-08-07');

  const reopenedRun = await db.query(`
    select id from public.collection_runs
    where service_date = date '2026-07-31' and status = 'open'
  `);
  await assert.rejects(
    db.query(`
      select public.set_credit_charge_collection_assignment(
        '${reopenedRun.rows[0].id}', '${delivered.rows[0].result.charge_id}', true
      )
    `),
    /closed collection cutoff/i,
  );
  const eligibility = await db.query(`
    select public.is_charge_collectible_in_run(
      '${delivered.rows[0].result.charge_id}', '${reopenedRun.rows[0].id}'
    ) as collectible
  `);
  assert.equal(eligibility.rows[0].collectible, false);
});

test('paid open-period correction preserves the receipt and creates a refund for the reduced amount', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      'a1000000-0000-4000-8000-000000000001', 'immediate'
    ) as result
  `);
  const eventId = delivery.rows[0].result.delivery_event_id;
  const chargeId = delivery.rows[0].result.charge_id;
  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":36}]'::jsonb,
      'cash', 36, null, null, null, 36, null,
      'a1000000-0000-4000-8000-000000000002'
    ) as result
  `);
  const paymentId = payment.rows[0].result.payment_id;
  await assert.rejects(
    db.query(`select public.get_payment_correction_targets('${paymentId}')`),
    /Only a round lead or admin can view payment correction targets/i,
  );
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);

  const originalTargets = await db.query(`select public.get_payment_correction_targets('${paymentId}') as result`);
  assert.equal(originalTargets.rows[0].result.length, 1);
  assert.equal(originalTargets.rows[0].result[0].delivery_event_id, eventId);
  assert.equal(Number(originalTargets.rows[0].result[0].effective_amount), 36);

  const corrected = await db.query(`
    select public.apply_open_delivery_correction(
      '${eventId}', 'correct', '${itemPayload(1)}'::jsonb, 'delivered', null,
      'customer received one bag', 'a1000000-0000-4000-8000-000000000003'
    ) as result
  `);
  const replacementChargeId = corrected.rows[0].result.replacement_charge_id;
  assert.equal(Number(corrected.rows[0].result.new_amount), 18);
  assert.equal(Number(corrected.rows[0].result.refund_amount), 18);

  const state = await db.query(`
    select original.status as original_status, replacement.status as replacement_status,
      allocation.charge_id, allocation.amount,
      obligation.amount as refund_amount, obligation.status as refund_status,
      payment.allocated_amount,
      snapshot.receipt_data -> 'charges' -> 0 ->> 'received_amount' as receipt_amount
    from public.delivery_charges original
    join public.delivery_charges replacement on replacement.id = '${replacementChargeId}'
    join public.payments payment on payment.id = '${paymentId}'
    join public.payment_allocations allocation on allocation.payment_id = payment.id
    join public.refund_obligations obligation on obligation.payment_id = payment.id
    join public.payment_receipt_snapshots snapshot on snapshot.payment_id = payment.id
    where original.id = '${chargeId}'
  `);
  assert.deepEqual(state.rows[0], {
    original_status: 'voided', replacement_status: 'active',
    charge_id: replacementChargeId, amount: '18.00', refund_amount: '18.00',
    refund_status: 'pending', allocated_amount: '36.00', receipt_amount: '36.00',
  });

  const pendingRefundTargets = await db.query(`select public.get_payment_correction_targets('${paymentId}') as result`);
  assert.equal(pendingRefundTargets.rows[0].result.length, 0);

  const obligation = await db.query(`select id from public.refund_obligations where payment_id = '${paymentId}'`);
  await db.query(`select public.settle_refund(
    '${obligation.rows[0].id}', 'cash', null,
    'a1000000-0000-4000-8000-000000000004'
  )`);
  const settledRefundTargets = await db.query(`select public.get_payment_correction_targets('${paymentId}') as result`);
  assert.equal(settledRefundTargets.rows[0].result.length, 1);
  assert.equal(settledRefundTargets.rows[0].result[0].charge_id, replacementChargeId);
  assert.equal(settledRefundTargets.rows[0].result[0].delivery_event_id, corrected.rows[0].result.replacement_event_id);
  assert.equal(Number(settledRefundTargets.rows[0].result[0].effective_amount), 18);

  const replay = await db.query(`
    select public.apply_open_delivery_correction(
      '${eventId}', 'correct', '${itemPayload(1)}'::jsonb, 'delivered', null,
      'customer received one bag', 'a1000000-0000-4000-8000-000000000003'
    ) as result
  `);
  assert.equal(replay.rows[0].result.idempotent_replay, true);
  const counts = await db.query(`
    select (select count(*)::integer from public.refund_obligations) as refunds,
      (select count(*)::integer from public.payment_allocation_changes) as changes
  `);
  assert.deepEqual(counts.rows[0], { refunds: 1, changes: 1 });
});

test('paid open-period correction can increase the bill without changing the original payment', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      'a2000000-0000-4000-8000-000000000001', 'immediate'
    ) as result
  `);
  const eventId = delivery.rows[0].result.delivery_event_id;
  const chargeId = delivery.rows[0].result.charge_id;
  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":18}]'::jsonb,
      'cash', 18, null, null, null, 18, null,
      'a2000000-0000-4000-8000-000000000002'
    ) as result
  `);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const corrected = await db.query(`
    select public.apply_open_delivery_correction(
      '${eventId}', 'correct', '${itemPayload(2)}'::jsonb, 'delivered', null,
      'customer received two bags', 'a2000000-0000-4000-8000-000000000003'
    ) as result
  `);
  assert.equal(Number(corrected.rows[0].result.new_amount), 36);
  assert.equal(Number(corrected.rows[0].result.outstanding_amount), 18);
  const state = await db.query(`
    select allocation.amount,
      public.effective_delivery_charge_amount(allocation.charge_id) - allocation.amount as outstanding,
      (select count(*)::integer from public.refund_obligations) as refunds
    from public.payment_allocations allocation
    where allocation.payment_id = '${payment.rows[0].result.payment_id}'
  `);
  assert.deepEqual(state.rows[0], { amount: '18.00', outstanding: '18.00', refunds: 0 });
});

test('manager cancellation of a paid open bill creates a full refund obligation', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
      'a3000000-0000-4000-8000-000000000001', 'immediate'
    ) as result
  `);
  const eventId = delivery.rows[0].result.delivery_event_id;
  const chargeId = delivery.rows[0].result.charge_id;
  const payment = await db.query(`
    select public.record_payment(
      '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":18}]'::jsonb,
      'cash', 18, null, null, null, 18, null,
      'a3000000-0000-4000-8000-000000000002'
    ) as result
  `);
  await db.exec(`update public.auth_context set user_id = '${ROUND_LEAD_ID}', app_role = 'round_lead'`);
  const cancelled = await db.query(`
    select public.apply_open_delivery_correction(
      '${eventId}', 'cancel', '[]'::jsonb, 'delivered', null,
      'sale cancelled', 'a3000000-0000-4000-8000-000000000003'
    ) as result
  `);
  assert.equal(cancelled.rows[0].result.replacement_event_id, null);
  const state = await db.query(`
    select charge.status,
      (select count(*)::integer from public.payment_allocations allocation
        where allocation.payment_id = '${payment.rows[0].result.payment_id}') as allocations,
      obligation.amount
    from public.delivery_charges charge
    join public.refund_obligations obligation on obligation.source_charge_id = charge.id
    where charge.id = '${chargeId}'
  `);
  assert.deepEqual(state.rows[0], { status: 'voided', allocations: 0, amount: '18.00' });
});

test('a correction preserves other bills on a shared receipt and refunds the newest target payment first', async (t) => {
  const db = await createDatabase(t);
  const otherStopId = '22000000-0000-4000-8000-000000000099';
  await db.exec(`
    insert into public.round_stops (
      id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_name_snapshot, floor_or_zone_snapshot, updated_by
    ) values (
      '${otherStopId}', '${ROUND_ID}', '${SHOP_ID}', 'SHOP-1', 'Shop One',
      'Building A', 'Zone 1', '${ADMIN_ID}'
    );
    update public.shop_payment_profiles set allow_outstanding = true where shop_id = '${SHOP_ID}';
  `);
  const target = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
    'a4500000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  const other = await db.query(`select public.record_delivery(
    '${otherStopId}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a4500000-0000-4000-8000-000000000002', 'immediate'
  ) as result`);
  const firstPayment = await db.query(`select public.record_payment(
    '${SHOP_ID}', '[
      {"charge_id":"${target.rows[0].result.charge_id}","amount":10},
      {"charge_id":"${other.rows[0].result.charge_id}","amount":18}
    ]'::jsonb, 'cash', 28, null, null, null, 54, null,
    'a4500000-0000-4000-8000-000000000003'
  ) as result`);
  const secondPayment = await db.query(`select public.record_payment(
    '${SHOP_ID}', '[{"charge_id":"${target.rows[0].result.charge_id}","amount":26}]'::jsonb,
    'cash', 26, null, null, null, 26, null,
    'a4500000-0000-4000-8000-000000000004'
  ) as result`);

  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const corrected = await db.query(`select public.apply_open_delivery_correction(
    '${target.rows[0].result.delivery_event_id}', 'correct', '${itemPayload(1)}'::jsonb,
    'delivered', null, 'target bill had one extra bag',
    'a4500000-0000-4000-8000-000000000005'
  ) as result`);
  const allocations = await db.query(`
    select allocation.payment_id, allocation.charge_id, allocation.amount
    from public.payment_allocations allocation
    where allocation.payment_id in (
      '${firstPayment.rows[0].result.payment_id}', '${secondPayment.rows[0].result.payment_id}'
    ) order by allocation.payment_id, allocation.charge_id
  `);
  assert.deepEqual(allocations.rows.map((row) => ({
    payment_id: row.payment_id, charge_id: row.charge_id, amount: Number(row.amount),
  })), [
    { payment_id: firstPayment.rows[0].result.payment_id, charge_id: other.rows[0].result.charge_id, amount: 18 },
    { payment_id: firstPayment.rows[0].result.payment_id, charge_id: corrected.rows[0].result.replacement_charge_id, amount: 10 },
    { payment_id: secondPayment.rows[0].result.payment_id, charge_id: corrected.rows[0].result.replacement_charge_id, amount: 8 },
  ].sort((a, b) => a.payment_id.localeCompare(b.payment_id) || a.charge_id.localeCompare(b.charge_id)));
  const refunds = await db.query(`select payment_id, amount from public.refund_obligations`);
  assert.deepEqual(refunds.rows.map((row) => ({ payment_id: row.payment_id, amount: Number(row.amount) })), [
    { payment_id: secondPayment.rows[0].result.payment_id, amount: 18 },
  ]);
  const firstSnapshot = await db.query(`select receipt_data from public.payment_receipt_snapshots
    where payment_id = '${firstPayment.rows[0].result.payment_id}'`);
  assert.equal(firstSnapshot.rows[0].receipt_data.charges.length, 2);
  assert.equal(Number(firstSnapshot.rows[0].receipt_data.allocated_amount), 28);
});

test('couriers may correct only their own latest unpaid delivery and cannot cancel the sale', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      'a4000000-0000-4000-8000-000000000001', 'immediate'
    ) as result
  `);
  const eventId = delivery.rows[0].result.delivery_event_id;
  const context = await db.query(`select public.get_delivery_correction_context('${eventId}') as result`);
  assert.equal(context.rows[0].result.can_correct, true);
  assert.equal(context.rows[0].result.can_cancel, false);
  await assert.rejects(
    db.query(`select public.apply_open_delivery_correction(
      '${eventId}', 'cancel', '[]'::jsonb, 'delivered', null,
      'not allowed', 'a4000000-0000-4000-8000-000000000002'
    )`),
    /cannot be cancelled|cancel/i,
  );
  const corrected = await db.query(`select public.apply_open_delivery_correction(
    '${eventId}', 'correct', '${itemPayload(1)}'::jsonb, 'delivered', null,
    'entered wrong amount', 'a4000000-0000-4000-8000-000000000003'
  ) as result`);
  assert.ok(corrected.rows[0].result.replacement_event_id);
});

test('couriers cannot turn an unpaid delivery into a non-delivery through the correction RPC', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a4100000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);

  await assert.rejects(
    db.query(`select public.apply_open_delivery_correction(
      '${delivery.rows[0].result.delivery_event_id}', 'correct', '[]'::jsonb,
      'issue', 'ร้านปิด', 'attempted status change',
      'a4100000-0000-4000-8000-000000000002'
    )`),
    /couriers can only correct delivered quantities/i,
  );

  const state = await db.query(`select event.status, charge.status as charge_status
    from public.delivery_events event
    join public.delivery_charges charge on charge.delivery_event_id = event.id
    where event.id = '${delivery.rows[0].result.delivery_event_id}'`);
  assert.deepEqual(state.rows[0], { status: 'active', charge_status: 'active' });
});

test('closed-round adjustment changes effective billing and open-day stock without rewriting the round', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`
    select public.record_delivery(
      '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
      'a5000000-0000-4000-8000-000000000001', 'immediate'
    ) as result
  `);
  const eventId = delivery.rows[0].result.delivery_event_id;
  const chargeId = delivery.rows[0].result.charge_id;
  const beforeStock = await db.query(`select public.daily_aggregate_stock_balance_at(
    date '${SERVICE_DATE}', '${ICE_ID}'
  ) as balance`);
  await db.exec(`
    update public.delivery_rounds set status = 'closed' where id = '${ROUND_ID}';
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  const adjusted = await db.query(`
    select public.create_closed_delivery_adjustment(
      '${eventId}', '${itemPayload(1)}'::jsonb, 'one bag was returned',
      'a5000000-0000-4000-8000-000000000002'
    ) as result
  `);
  assert.equal(adjusted.rows[0].result.scope, 'round_closed');
  assert.equal(Number(adjusted.rows[0].result.corrected_amount), 18);
  const state = await db.query(`
    select charge.original_amount,
      public.effective_delivery_charge_amount(charge.id) as effective_amount,
      event.status as event_status,
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as stock_balance
    from public.delivery_charges charge
    join public.delivery_events event on event.id = charge.delivery_event_id
    where charge.id = '${chargeId}'
  `);
  assert.equal(state.rows[0].original_amount, '36.00');
  assert.equal(state.rows[0].effective_amount, '18.00');
  assert.equal(state.rows[0].event_status, 'active');
  assert.equal(Number(state.rows[0].stock_balance), Number(beforeStock.rows[0].balance) + 1);

  await db.query(`select public.create_closed_delivery_adjustment(
    '${eventId}', '${itemPayload(0.5)}'::jsonb, 'another half bag was returned',
    'a5000000-0000-4000-8000-000000000003'
  )`);
  const cumulative = await db.query(`
    select public.effective_delivery_charge_amount('${chargeId}') as effective_amount,
      public.daily_aggregate_stock_balance_at(date '${SERVICE_DATE}', '${ICE_ID}') as stock_balance,
      public.get_delivery_correction_context('${eventId}') as context,
      item.original_quantity, item.corrected_quantity, item.quantity_delta
    from public.delivery_adjustment_items item
    where item.adjustment_id = 'a5000000-0000-4000-8000-000000000003'
  `);
  assert.equal(cumulative.rows[0].effective_amount, '9.00');
  assert.equal(Number(cumulative.rows[0].stock_balance), Number(beforeStock.rows[0].balance) + 1.5);
  assert.equal(Number(cumulative.rows[0].context.items[0].quantity), 0.5);
  assert.equal(Number(cumulative.rows[0].original_quantity), 1);
  assert.equal(Number(cumulative.rows[0].corrected_quantity), 0.5);
  assert.equal(Number(cumulative.rows[0].quantity_delta), -0.5);
  await assert.rejects(
    db.query(`select public.create_closed_delivery_adjustment(
      '${eventId}', '${itemPayload(1)}'::jsonb, 'changed retry payload',
      'a5000000-0000-4000-8000-000000000003'
    )`),
    /different delivery adjustment request/i,
  );
});

test('closed-round increases cannot exceed available aggregate stock', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a5100000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  await db.exec(`
    update public.delivery_rounds set status = 'closed' where id = '${ROUND_ID}';
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);

  await assert.rejects(
    db.query(`select public.create_closed_delivery_adjustment(
      '${delivery.rows[0].result.delivery_event_id}', '${itemPayload(31)}'::jsonb,
      'quantity exceeds remaining stock', 'a5100000-0000-4000-8000-000000000002'
    )`),
    /aggregate stock is not sufficient/i,
  );
});

test('increasing a closed-period correction reconciles pending refunds before opening a balance', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
    'a5200000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  const payment = await db.query(`select public.record_payment(
    '${SHOP_ID}', '[{"charge_id":"${delivery.rows[0].result.charge_id}","amount":36}]'::jsonb,
    'cash', 36, null, null, null, 36, null,
    'a5200000-0000-4000-8000-000000000002'
  ) as result`);
  await db.exec(`
    update public.delivery_rounds set status = 'closed' where id = '${ROUND_ID}';
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  await db.query(`select public.create_closed_delivery_adjustment(
    '${delivery.rows[0].result.delivery_event_id}', '${itemPayload(1)}'::jsonb,
    'one bag returned', 'a5200000-0000-4000-8000-000000000003'
  )`);
  await db.query(`select public.create_closed_delivery_adjustment(
    '${delivery.rows[0].result.delivery_event_id}', '${itemPayload(1.5)}'::jsonb,
    'half bag confirmed later', 'a5200000-0000-4000-8000-000000000004'
  )`);

  const partial = await db.query(`select
    public.effective_delivery_charge_amount('${delivery.rows[0].result.charge_id}') as effective_amount,
    (select amount from public.payment_allocations
      where payment_id = '${payment.rows[0].result.payment_id}'
        and charge_id = '${delivery.rows[0].result.charge_id}') as allocated_amount,
    (select coalesce(sum(amount), 0) from public.refund_obligations
      where payment_id = '${payment.rows[0].result.payment_id}' and status = 'pending') as pending_refund,
    (select count(*)::integer from public.refund_obligations
      where payment_id = '${payment.rows[0].result.payment_id}' and status = 'voided') as voided_refunds
  `);
  assert.deepEqual(partial.rows[0], {
    effective_amount: '27.00', allocated_amount: '27.00', pending_refund: '9.00', voided_refunds: 1,
  });

  await db.query(`select public.create_closed_delivery_adjustment(
    '${delivery.rows[0].result.delivery_event_id}', '${itemPayload(2)}'::jsonb,
    'full quantity confirmed', 'a5200000-0000-4000-8000-000000000005'
  )`);
  const restored = await db.query(`select
    (select amount from public.payment_allocations
      where payment_id = '${payment.rows[0].result.payment_id}'
        and charge_id = '${delivery.rows[0].result.charge_id}') as allocated_amount,
    (select coalesce(sum(amount), 0) from public.refund_obligations
      where payment_id = '${payment.rows[0].result.payment_id}' and status = 'pending') as pending_refund
  `);
  assert.deepEqual(restored.rows[0], { allocated_amount: '36.00', pending_refund: '0' });
});

test('refunds settle once and corrected payments cannot be voided', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a6000000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  const payment = await db.query(`select public.record_payment(
    '${SHOP_ID}', '[{"charge_id":"${delivery.rows[0].result.charge_id}","amount":18}]'::jsonb,
    'cash', 18, null, null, null, 18, null,
    'a6000000-0000-4000-8000-000000000002'
  ) as result`);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  await db.query(`select public.apply_open_delivery_correction(
    '${delivery.rows[0].result.delivery_event_id}', 'cancel', '[]'::jsonb,
    'delivered', null, 'duplicate sale', 'a6000000-0000-4000-8000-000000000003'
  )`);
  const queue = await db.query(`select public.get_refund_queue(true) as result`);
  assert.equal(queue.rows[0].result.length, 1);
  assert.equal(Number(queue.rows[0].result[0].amount), 18);
  const obligationId = queue.rows[0].result[0].id;
  await assert.rejects(
    db.query(`select public.void_payment('${payment.rows[0].result.payment_id}', 'try to erase history')`),
    /linked to a bill correction or refund/i,
  );
  const settled = await db.query(`select public.settle_refund(
    '${obligationId}', 'cash', 'cash-return-1',
    'a6000000-0000-4000-8000-000000000004'
  ) as result`);
  assert.equal(settled.rows[0].result.status, 'settled');
  const replay = await db.query(`select public.settle_refund(
    '${obligationId}', 'cash', 'cash-return-1',
    'a6000000-0000-4000-8000-000000000004'
  ) as result`);
  assert.equal(replay.rows[0].result.idempotent_replay, true);
  await assert.rejects(
    db.query(`select public.settle_refund(
      '${obligationId}', 'cash', 'again',
      'a6000000-0000-4000-8000-000000000005'
    )`),
    /not pending/i,
  );
});

test('financial refund summary separates gross receipts, settled refunds, and net receipts under concurrent settlement', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
    'a6100000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  await db.query(`select public.record_payment(
    '${SHOP_ID}', '[{"charge_id":"${delivery.rows[0].result.charge_id}","amount":36}]'::jsonb,
    'cash', 36, null, null, null, 36, null,
    'a6100000-0000-4000-8000-000000000002'
  )`);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  await db.query(`select public.apply_open_delivery_correction(
    '${delivery.rows[0].result.delivery_event_id}', 'cancel', '[]'::jsonb,
    'delivered', null, 'duplicate sale', 'a6100000-0000-4000-8000-000000000003'
  )`);

  const before = await db.query(`select public.get_financial_refund_summary(date '${SERVICE_DATE}') as result`);
  assert.deepEqual(before.rows[0].result, {
    service_date: SERVICE_DATE,
    gross_received: 36,
    refunded_amount: 0,
    net_received: 36,
  });
  const obligation = await db.query('select id from public.refund_obligations');
  const obligationId = obligation.rows[0].id;
  const attempts = await Promise.allSettled([
    db.query(`select public.settle_refund(
      '${obligationId}', 'cash', null, 'a6100000-0000-4000-8000-000000000004'
    )`),
    db.query(`select public.settle_refund(
      '${obligationId}', 'cash', null, 'a6100000-0000-4000-8000-000000000005'
    )`),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);

  const after = await db.query(`select public.get_financial_refund_summary(date '${SERVICE_DATE}') as result`);
  assert.deepEqual(after.rows[0].result, {
    service_date: SERVICE_DATE,
    gross_received: 36,
    refunded_amount: 36,
    net_received: 0,
  });
  const settlementCount = await db.query('select count(*)::integer as count from public.refund_settlements');
  assert.equal(settlementCount.rows[0].count, 1);
});

test('concurrent correction retries create one replacement and one revision', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
    'a6200000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const correctionSql = `select public.apply_open_delivery_correction(
    '${delivery.rows[0].result.delivery_event_id}', 'correct', '${itemPayload(1)}'::jsonb,
    'delivered', null, 'concurrent retry', 'a6200000-0000-4000-8000-000000000002'
  ) as result`;

  const results = await Promise.all([db.query(correctionSql), db.query(correctionSql)]);
  assert.equal(results.filter((result) => result.rows[0].result.idempotent_replay === true).length, 1);
  const counts = await db.query(`select
    (select count(*)::integer from public.delivery_event_revisions) as revisions,
    (select count(*)::integer from public.delivery_events
      where corrects_event_id = '${delivery.rows[0].result.delivery_event_id}') as replacements`);
  assert.deepEqual(counts.rows[0], { revisions: 1, replacements: 1 });
});

test('an increased closed-period adjustment is collectible at its effective amount', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a7000000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  const chargeId = delivery.rows[0].result.charge_id;
  await db.exec(`
    update public.delivery_rounds set status = 'closed' where id = '${ROUND_ID}';
    update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin';
  `);
  await db.query(`select public.create_closed_delivery_adjustment(
    '${delivery.rows[0].result.delivery_event_id}', '${itemPayload(2)}'::jsonb,
    'second bag confirmed later', 'a7000000-0000-4000-8000-000000000002'
  )`);
  const run = await db.query(`select public.open_collection_run(
    date '${SERVICE_DATE}', '[{"user_id":"${COURIER_ID}"}]'::jsonb
  ) as result`);
  const runId = run.rows[0].result.collection_run_id;
  const queue = await db.query(`select public.get_collection_run_queue('${runId}') as result`);
  assert.equal(Number(queue.rows[0].result[0].charges[0].original_amount), 36);
  assert.equal(Number(queue.rows[0].result[0].charges[0].outstanding_amount), 36);
  await db.exec(`update public.auth_context set user_id = '${COURIER_ID}', app_role = 'courier'`);
  const payment = await db.query(`select public.record_payment(
    '${SHOP_ID}', '[{"charge_id":"${chargeId}","amount":36}]'::jsonb,
    'cash', 36, null, null, '${runId}', 36, null,
    'a7000000-0000-4000-8000-000000000003'
  ) as result`);
  assert.equal(Number(payment.rows[0].result.allocated_amount), 36);
});

test('open corrections preserve aggregate stock limits', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a8000000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);

  await assert.rejects(
    db.query(`select public.apply_open_delivery_correction(
      '${delivery.rows[0].result.delivery_event_id}', 'correct', '${itemPayload(31)}'::jsonb,
      'delivered', null, 'quantity exceeds stock',
      'a8000000-0000-4000-8000-000000000002'
    )`),
    /aggregate stock is not sufficient/i,
  );
});

test('open credit corrections preserve credit-limit approval checks', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    update public.shop_payment_profiles
    set allowed_payment_terms = array['credit']::public.payment_term[],
        default_payment_term = 'credit', allow_outstanding = true,
        credit_due_rule = 'net_days', credit_days = 30, credit_limit = 18
    where shop_id = '${SHOP_ID}'
  `);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a8100000-0000-4000-8000-000000000001', 'credit'
  ) as result`);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);

  await assert.rejects(
    db.query(`select public.apply_open_delivery_correction(
      '${delivery.rows[0].result.delivery_event_id}', 'correct', '${itemPayload(2)}'::jsonb,
      'delivered', null, 'increase credit delivery',
      'a8100000-0000-4000-8000-000000000002'
    )`),
    /approved credit-limit request is required/i,
  );

  const preview = await db.query(`select public.preview_delivery_correction(
    '${delivery.rows[0].result.delivery_event_id}', 'correct', '${itemPayload(2)}'::jsonb,
    'delivered'
  ) as result`);
  assert.equal(preview.rows[0].result.approval_required, true);
  const approval = await db.query(`select public.request_financial_approval(
    '${STOP_ID}', 'credit_limit', '${itemPayload(2)}'::jsonb, 'credit',
    36, 'approve corrected total', null
  ) as result`);
  await db.query(`select public.decide_financial_approval(
    '${approval.rows[0].result.id}', 'approved', 'approved for correction'
  )`);
  const corrected = await db.query(`select public.apply_open_delivery_correction(
    '${delivery.rows[0].result.delivery_event_id}', 'correct', '${itemPayload(2)}'::jsonb,
    'delivered', 'keep delivery note', 'increase credit delivery',
    'a8100000-0000-4000-8000-000000000003', '${approval.rows[0].result.id}'
  ) as result`);
  const consumed = await db.query(`select status, consumed_by_delivery_event_id
    from public.financial_approval_requests where id = '${approval.rows[0].result.id}'`);
  assert.deepEqual(consumed.rows[0], {
    status: 'consumed',
    consumed_by_delivery_event_id: corrected.rows[0].result.replacement_event_id,
  });
});

test('delivery correction preview works in a read-only transaction', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a8150000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);

  await db.exec('begin read only');
  const preview = await db.query(`select public.preview_delivery_correction(
    '${delivery.rows[0].result.delivery_event_id}', 'correct', '${itemPayload(2)}'::jsonb,
    'delivered'
  ) as result`);
  await db.exec('commit');

  assert.equal(Number(preview.rows[0].result.new_amount), 36);
});

test('delivery correction idempotency rejects a changed payload', async (t) => {
  const db = await createDatabase(t);
  const delivery = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(2)}'::jsonb, 'delivered', null, null,
    'a8200000-0000-4000-8000-000000000001', 'immediate'
  ) as result`);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  const key = 'a8200000-0000-4000-8000-000000000002';
  await db.query(`select public.apply_open_delivery_correction(
    '${delivery.rows[0].result.delivery_event_id}', 'correct', '${itemPayload(1)}'::jsonb,
    'delivered', null, 'first payload', '${key}'
  )`);

  await assert.rejects(
    db.query(`select public.apply_open_delivery_correction(
      '${delivery.rows[0].result.delivery_event_id}', 'correct', '${itemPayload(1.5)}'::jsonb,
      'delivered', null, 'changed payload', '${key}'
    )`),
    /different delivery correction request/i,
  );
});

test('cancelling the latest delivery restores the previous active stop state', async (t) => {
  const db = await createDatabase(t);
  await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a8300000-0000-4000-8000-000000000001', 'immediate'
  )`);
  const latest = await db.query(`select public.record_delivery(
    '${STOP_ID}', '${itemPayload(1)}'::jsonb, 'delivered', null, null,
    'a8300000-0000-4000-8000-000000000002', 'immediate'
  ) as result`);
  await db.exec(`update public.auth_context set user_id = '${ADMIN_ID}', app_role = 'admin'`);
  await db.query(`select public.apply_open_delivery_correction(
    '${latest.rows[0].result.delivery_event_id}', 'cancel', '[]'::jsonb,
    'delivered', null, 'duplicate latest delivery',
    'a8300000-0000-4000-8000-000000000003'
  )`);

  const stop = await db.query(`select status from public.round_stops where id = '${STOP_ID}'`);
  assert.equal(stop.rows[0].status, 'delivered');
});
