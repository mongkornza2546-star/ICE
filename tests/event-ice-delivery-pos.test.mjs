import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/0170_event_ice_delivery_pos.sql', import.meta.url),
  'utf8',
);

function definition(name, nextMarker) {
  const start = migration.indexOf(`create or replace function public.${name}`);
  const end = migration.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `${name} definition is missing`);
  assert.notEqual(end, -1, `${name} end marker is missing`);
  return migration.slice(start, end);
}

async function createEventPosDatabase() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );
    create type public.event_job_status as enum ('draft', 'published', 'cancelled');
    create type public.event_participation_status as enum ('active', 'cancelled');
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.stock_location_kind as enum ('shop', 'truck', 'team', 'small_vehicle');
    create type public.price_source as enum ('standard', 'shop');
    create type public.round_destination_kind as enum ('regular', 'event');

    create function auth.uid() returns uuid language sql stable as $$
      select '10000000-0000-4000-8000-000000000001'::uuid
    $$;
    create function public.is_active_user() returns boolean language sql stable
      as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('app.test_role', true), ''), 'courier')
    $$;
    create function public.is_round_member(uuid) returns boolean language sql stable
      as $$ select true $$;
    create function public.sync_daily_round_destinations(uuid) returns integer language sql
      as $$ select 0 $$;
    create function public.stock_balance_at(date, uuid, uuid)
    returns numeric(12,1) language sql stable as $$
      select coalesce(nullif(current_setting('app.test_holding_stock', true), ''), '10')::numeric
    $$;
    create function public.daily_aggregate_stock_balance_at(date, uuid)
    returns numeric(12,1) language sql stable as $$
      select coalesce(nullif(current_setting('app.test_daily_stock', true), ''), '8')::numeric
    $$;
    create function public.delivery_request_fingerprint(
      uuid, jsonb, public.shop_round_status, text, public.payment_term
    ) returns text language sql immutable as $$
      select md5(coalesce($2::text, '') || coalesce($3::text, '')
        || coalesce($4, '') || coalesce($5::text, ''))
    $$;
    create function public.is_delivery_event_visible(uuid) returns boolean language sql stable
      as $$ select true $$;

    create table public.event_delivery_feature_settings (
      singleton boolean primary key,
      schema_version integer not null,
      event_stops_enabled boolean not null,
      event_ice_delivery_enabled boolean not null,
      updated_at timestamptz not null default now()
    );
    insert into public.event_delivery_feature_settings
    values (true, 5, true, false, now());

    create table public.delivery_rounds (
      id uuid primary key,
      status public.delivery_round_status not null,
      service_date date not null
    );
    create table public.stock_locations (
      id uuid primary key,
      code text not null,
      name text not null,
      kind public.stock_location_kind not null,
      assigned_user_id uuid,
      is_active boolean not null
    );
    create table public.shops (
      id uuid primary key,
      image_path text,
      stock_location_id uuid not null references public.stock_locations(id)
    );
    create table public.event_jobs (
      id uuid primary key,
      status public.event_job_status not null,
      start_date date not null,
      end_date date not null
    );
    create table public.event_participations (
      id uuid primary key,
      event_job_id uuid not null references public.event_jobs(id),
      status public.event_participation_status not null,
      start_date date not null,
      end_date date not null,
      config_version_id uuid,
      payment_term_snapshot public.payment_term,
      allowed_payment_methods_snapshot public.payment_method[],
      default_payment_method_snapshot public.payment_method,
      cash_reference_required_snapshot boolean,
      cash_evidence_required_snapshot boolean,
      bank_transfer_reference_required_snapshot boolean,
      bank_transfer_evidence_required_snapshot boolean,
      qr_reference_required_snapshot boolean,
      qr_evidence_required_snapshot boolean
    );
    create table public.round_stops (
      id uuid primary key,
      round_id uuid not null references public.delivery_rounds(id),
      shop_id uuid not null references public.shops(id),
      destination_kind public.round_destination_kind not null,
      event_participation_id uuid references public.event_participations(id),
      shop_code_snapshot text not null,
      shop_name_snapshot text not null,
      building_name_snapshot text,
      floor_or_zone_snapshot text,
      event_job_name_snapshot text,
      event_location_snapshot text,
      event_zone_snapshot text,
      event_booth_snapshot text,
      is_operational boolean not null,
      status public.shop_round_status not null,
      note text,
      updated_by uuid,
      updated_at timestamptz
    );
    create table public.ice_types (
      id uuid primary key,
      code text not null,
      name text not null,
      unit text not null,
      image_path text,
      is_active boolean not null
    );
    create table public.ice_type_prices (
      id uuid primary key,
      ice_type_id uuid not null references public.ice_types(id),
      unit_price numeric(12,2) not null,
      valid_from date not null,
      valid_to date,
      is_active boolean not null
    );
    create table public.delivery_events (
      id uuid primary key default gen_random_uuid(),
      round_stop_id uuid not null references public.round_stops(id),
      recorded_by uuid not null,
      recorded_at timestamptz not null default now(),
      client_recorded_at timestamptz,
      idempotency_key uuid not null unique,
      request_fingerprint text not null,
      note text,
      source_stock_location_id uuid,
      status text not null default 'active'
    );
    create table public.delivery_items (
      delivery_event_id uuid not null references public.delivery_events(id),
      ice_type_id uuid not null,
      quantity numeric(12,1) not null,
      unit_price numeric(12,2),
      price_source public.price_source,
      price_source_id uuid,
      line_total numeric(12,2) generated always as (quantity * unit_price) stored
    );
    create table public.delivery_charges (
      id uuid primary key default gen_random_uuid(),
      delivery_event_id uuid not null unique references public.delivery_events(id),
      shop_id uuid not null,
      service_date date not null,
      payment_term public.payment_term not null,
      original_amount numeric(12,2) not null,
      due_date date,
      approval_request_id uuid,
      charge_number text default 'INV-TEST',
      created_at timestamptz not null default now(),
      status text not null default 'active'
    );
    create table public.delivery_charge_document_snapshots (
      charge_id uuid primary key,
      document_data jsonb not null
    );
    create table public.daily_aggregate_stock_closures (service_date date primary key);
    create table public.audit_logs (
      entity_type text not null,
      entity_id uuid not null,
      actor_id uuid,
      action text,
      after_value jsonb,
      occurred_at timestamptz not null default now()
    );

    create function public.delivery_financial_response(p_event_id uuid)
    returns jsonb language sql stable as $$
      select jsonb_build_object('delivery_event_id', p_event_id)
    $$;
    create function public.build_charge_print_document(uuid)
    returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function public.capture_charge_print_document()
    returns trigger language plpgsql as $$
    begin
      insert into public.delivery_charge_document_snapshots (charge_id, document_data)
      values (new.id, public.build_charge_print_document(new.id));
      return null;
    end;
    $$;
    create trigger delivery_charges_capture_print_document
    after insert on public.delivery_charges
    for each row execute function public.capture_charge_print_document();
    create function public.get_event_delivery_cards(uuid, uuid, text)
    returns jsonb language sql stable as $$
      select coalesce(jsonb_agg(jsonb_build_object(
        'delivery_event_id', delivery.id,
        'note', delivery.note,
        'items', '[]'::jsonb
      )), '[]'::jsonb)
      from public.delivery_events delivery
    $$;
  `);
  await db.exec(migration);
  return db;
}

test('event migration executes context and writer contracts end to end', async (t) => {
  const db = await createEventPosDatabase();
  t.after(() => db.close());
  const ids = {
    round: '20000000-0000-4000-8000-000000000001',
    shop: '30000000-0000-4000-8000-000000000001',
    holding: '40000000-0000-4000-8000-000000000001',
    shopStock: '40000000-0000-4000-8000-000000000002',
    job: '50000000-0000-4000-8000-000000000001',
    participation: '60000000-0000-4000-8000-000000000001',
    stop: '70000000-0000-4000-8000-000000000001',
    ice: '80000000-0000-4000-8000-000000000001',
    request: '90000000-0000-4000-8000-000000000001',
  };

  const disabled = await db.query(`
    select schema_version, event_ice_delivery_enabled
    from public.event_delivery_feature_settings
  `);
  assert.deepEqual(disabled.rows[0], { schema_version: 6, event_ice_delivery_enabled: false });
  await assert.rejects(
    db.query(`select public.get_event_delivery_pos_context('${ids.stop}')`),
    /Event ice delivery is not enabled/,
  );

  await db.exec(`
    update public.event_delivery_feature_settings set event_ice_delivery_enabled = true;
    insert into public.stock_locations values
      ('${ids.holding}', 'HOLDING', 'Courier holding', 'team', auth.uid(), true),
      ('${ids.shopStock}', 'SHOP', 'Shop stock', 'shop', null, true);
    insert into public.shops values ('${ids.shop}', null, '${ids.shopStock}');
    insert into public.delivery_rounds values ('${ids.round}', 'open', current_date);
    insert into public.event_jobs values ('${ids.job}', 'published', current_date, current_date);
    insert into public.event_participations values (
      '${ids.participation}', '${ids.job}', 'active', current_date, current_date,
      gen_random_uuid(), 'end_of_day', array['cash']::public.payment_method[], 'cash',
      false, false, true, false, true, false
    );
    insert into public.round_stops values (
      '${ids.stop}', '${ids.round}', '${ids.shop}', 'event', '${ids.participation}',
      'E1', 'Event shop', null, null, 'Expo', 'Hall', 'Zone A', 'B1',
      true, 'pending', null, auth.uid(), now()
    );
    insert into public.ice_types values ('${ids.ice}', 'ICE', 'Ice', 'bag', null, true);
    insert into public.ice_type_prices values (
      gen_random_uuid(), '${ids.ice}', 25, current_date, null, true
    );
  `);

  const courierContext = await db.query(`
    select public.get_event_delivery_pos_context('${ids.stop}') as value
  `);
  assert.equal(courierContext.rows[0].value.stock_source.id, ids.holding);
  assert.equal(courierContext.rows[0].value.items[0].stock_quantity, 8);
  assert.deepEqual(courierContext.rows[0].value.payment_profile.allowed_payment_terms, ['end_of_day']);

  await db.exec(`select set_config('app.test_role', 'admin', false)`);
  const adminContext = await db.query(`
    select public.get_event_delivery_pos_context('${ids.stop}') as value
  `);
  assert.equal(adminContext.rows[0].value.stock_source.id, null);
  assert.equal(adminContext.rows[0].value.stock_source.code, 'DAILY');
  assert.equal(adminContext.rows[0].value.items[0].stock_quantity, 8);
  await db.exec(`select set_config('app.test_role', 'courier', false)`);

  const writeSql = `select public.record_event_ice_delivery(
    '${ids.stop}',
    '[{"ice_type_id":"${ids.ice}","quantity":2}]'::jsonb,
    'delivered', null, now(), '${ids.request}'
  ) as value`;
  const created = await db.query(writeSql);
  const replayed = await db.query(writeSql);
  assert.equal(replayed.rows[0].value.delivery_event_id, created.rows[0].value.delivery_event_id);
  assert.equal((await db.query(`select count(*)::integer as count from public.delivery_events`)).rows[0].count, 1);

  const recorded = await db.query(`
    select event.source_stock_location_id, item.quantity, item.unit_price,
      charge.original_amount, stop.status, audit.after_value,
      snapshot.document_data
    from public.delivery_events event
    join public.delivery_items item on item.delivery_event_id = event.id
    join public.delivery_charges charge on charge.delivery_event_id = event.id
    join public.round_stops stop on stop.id = event.round_stop_id
    join public.audit_logs audit on audit.entity_id = event.id
    join public.delivery_charge_document_snapshots snapshot on snapshot.charge_id = charge.id
  `);
  assert.equal(recorded.rows[0].source_stock_location_id, ids.holding);
  assert.equal(recorded.rows[0].quantity, '2.0');
  assert.equal(recorded.rows[0].unit_price, '25.00');
  assert.equal(recorded.rows[0].original_amount, '50.00');
  assert.equal(recorded.rows[0].status, 'delivered');
  assert.equal(recorded.rows[0].after_value.stop_status, 'delivered');
  assert.equal(recorded.rows[0].document_data.shop_location, 'Expo · Hall · Zone A · B1');

  await assert.rejects(
    db.query(`select public.record_event_ice_delivery(
      '${ids.stop}',
      '[{"ice_type_id":"${ids.ice}","quantity":3}]'::jsonb,
      'delivered', null, now(), '${ids.request}'
    )`),
    /already used for a different delivery request/,
  );

  await db.exec(`select set_config('app.test_holding_stock', '1', false)`);
  await assert.rejects(
    db.query(`select public.record_event_ice_delivery(
      '${ids.stop}',
      '[{"ice_type_id":"${ids.ice}","quantity":2}]'::jsonb,
      'delivered', null, now(), '90000000-0000-4000-8000-000000000002'
    )`),
    /Employee holding does not have enough stock/,
  );
  await db.exec(`
    select set_config('app.test_holding_stock', '10', false);
    select set_config('app.test_daily_stock', '1', false);
  `);
  await assert.rejects(
    db.query(`select public.record_event_ice_delivery(
      '${ids.stop}',
      '[{"ice_type_id":"${ids.ice}","quantity":2}]'::jsonb,
      'delivered', null, now(), '90000000-0000-4000-8000-000000000003'
    )`),
    /Daily aggregate stock is not sufficient/,
  );

  const privileges = await db.query(`
    select
      has_function_privilege(
        'authenticated',
        'public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)',
        'execute'
      ) as authenticated_can_write,
      has_function_privilege(
        'anon',
        'public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)',
        'execute'
      ) as anon_can_write
  `);
  assert.deepEqual(privileges.rows[0], {
    authenticated_can_write: true,
    anon_can_write: false,
  });
});

test('event POS context exposes daily stock, standard prices, and frozen event terms', () => {
  const context = definition(
    'get_event_delivery_pos_context',
    'create or replace function public.record_event_ice_delivery',
  );

  assert.match(context, /daily_aggregate_stock_balance_at\(v_service_date, ice\.id\)/);
  assert.match(context, /from public\.ice_type_prices price/);
  assert.doesNotMatch(context, /shop_ice_type_prices/);
  assert.match(context, /'price_source'.*'standard'/s);
  assert.match(context, /'allowed_payment_terms', array\['end_of_day'\]/);
  assert.match(context, /participation\.payment_term_snapshot/);
});

test('event writer atomically records quantities, stock usage, and a sales charge', () => {
  const writer = definition(
    'record_event_ice_delivery',
    '-- Event documents show the event destination',
  );

  assert.match(writer, /pg_advisory_xact_lock\(hashtextextended\(v_lock_service_date::text, 0\)\)/);
  assert.match(writer, /daily_aggregate_stock_balance_at\(v_service_date, v_item\.ice_type_id\)/);
  assert.match(writer, /location\.assigned_user_id = auth\.uid\(\)/);
  assert.match(writer, /location\.kind in \('team', 'small_vehicle'\)/);
  assert.match(writer, /stock_balance_at\(v_service_date, v_source_location_id, v_item\.ice_type_id\)/);
  assert.match(writer, /Employee holding does not have enough stock/);
  assert.match(writer, /insert into public\.delivery_events/);
  assert.match(writer, /insert into public\.delivery_items/);
  assert.match(writer, /insert into public\.delivery_charges/);
  assert.match(writer, /'end_of_day'/);
  assert.match(writer, /'standard'::public\.price_source/);
  assert.doesNotMatch(writer, /shop_ice_type_prices/);
});

test('event writer validates live event state and remains dark after installation', () => {
  const writer = definition(
    'record_event_ice_delivery',
    '-- Event documents show the event destination',
  );

  assert.match(writer, /stop\.destination_kind = 'event'/);
  assert.match(writer, /v_job_status <> 'published'/);
  assert.match(writer, /v_participation_status <> 'active'/);
  assert.match(writer, /Stock for this service date is already closed/);
  assert.match(migration, /schema_version = greatest\(schema_version, 6\)/);
  assert.match(migration, /event_ice_delivery_enabled = false/);
  assert.doesNotMatch(migration, /event_ice_delivery_enabled = true/);
});

test('event card history carries the recorded stop status', () => {
  assert.match(migration, /event_delivery_history_status/);
  assert.match(migration, /audit\.after_value ->> 'stop_status'/);
  assert.match(migration, /'stop_status'/);
});

test('event card history status patch applies and returns the audited status', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );
    create table public.audit_logs (
      entity_type text not null,
      entity_id uuid not null,
      after_value jsonb,
      occurred_at timestamptz not null default now()
    );
    create table public.delivery_events (id uuid primary key, note text);
    create table public.delivery_items (delivery_event_id uuid not null);
    create function public.get_event_delivery_cards(uuid, uuid, text)
    returns jsonb
    language sql
    stable
    as $$
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'delivery_event_id', delivery.id,
          'note', delivery.note,
          'items', '[]'::jsonb
        )),
        '[]'::jsonb
      )
      from public.delivery_events delivery
    $$;
  `);

  const patchStart = migration.indexOf(
    'create or replace function public.event_delivery_history_status',
  );
  const patchEnd = migration.indexOf('-- Event documents show the event destination', patchStart);
  assert.notEqual(patchStart, -1);
  assert.notEqual(patchEnd, -1);
  await db.exec(migration.slice(patchStart, patchEnd));

  const eventId = '20000000-0000-4000-8000-000000000001';
  await db.query('insert into public.delivery_events (id, note) values ($1, $2)', [
    eventId,
    'เข้าบูธไม่ได้',
  ]);
  await db.query(
    `insert into public.audit_logs (entity_type, entity_id, after_value)
     values ('delivery_events', $1, jsonb_build_object('stop_status', 'no_access'))`,
    [eventId],
  );

  const result = await db.query(
    'select public.get_event_delivery_cards(null, null, null) as cards',
  );
  assert.equal(result.rows[0].cards[0].stop_status, 'no_access');
});

test('event sales documents use the event location snapshot', () => {
  const documentBuilder = definition(
    'build_charge_print_document',
    'update public.event_delivery_feature_settings',
  );

  assert.match(documentBuilder, /stop\.destination_kind = 'event'/);
  assert.match(documentBuilder, /stop\.event_job_name_snapshot/);
  assert.match(documentBuilder, /stop\.event_location_snapshot/);
});
