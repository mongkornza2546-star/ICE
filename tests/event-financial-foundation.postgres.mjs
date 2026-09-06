import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const container = `ice-event-financial-foundation-${process.pid}`;
const draft = readFileSync(
  new URL('../supabase/migrations/0171_event_ice_delivery_financial_closeout.sql', import.meta.url),
  'utf8',
);
const preflightEnd = draft.indexOf('$event_financial_preflight$;');
assert.notEqual(preflightEnd, -1, '0171 draft preflight marker is missing');
const preflight = draft.slice(
  0,
  preflightEnd + '$event_financial_preflight$;'.length,
);

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...options });
}

function psql(sql) {
  const result = docker([
    'exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At',
  ], { input: sql });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function psqlConcurrent(sql) {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At',
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(sql);
  });
}

const eventId = '50000000-0000-4000-8000-000000000001';
const stopId = '40000000-0000-4000-8000-000000000001';

try {
  const started = docker([
    'run', '--rm', '-d', '--name', container,
    '-e', 'POSTGRES_PASSWORD=test', 'postgres:16',
  ]);
  if (started.status !== 0) throw new Error(started.stderr);

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (docker([
      'exec', container, 'psql', '-U', 'postgres', '-Atc', 'select 1',
    ]).status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'PostgreSQL container did not become ready');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(docker([
    'exec', container, 'psql', '-U', 'postgres', '-Atc', 'select 1',
  ]).status, 0, 'PostgreSQL container did not remain ready');

  psql(`
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );
    create type public.round_destination_kind as enum ('regular', 'event');
    create table public.event_delivery_feature_settings (
      singleton boolean primary key,
      schema_version integer not null
    );
    create table public.event_participations (id uuid primary key);
    create table public.event_job_config_versions (id uuid primary key);
    create table public.round_stops (
      id uuid primary key,
      destination_kind public.round_destination_kind not null
    );
    create table public.delivery_events (
      id uuid primary key,
      round_stop_id uuid not null references public.round_stops(id)
    );
    create table public.delivery_charges (
      id uuid primary key,
      delivery_event_id uuid not null references public.delivery_events(id)
    );
    create table public.payments (id uuid primary key);
    create table public.payment_allocations (
      payment_id uuid not null references public.payments(id),
      charge_id uuid not null references public.delivery_charges(id)
    );
    create table public.delivery_charge_document_snapshots (
      charge_id uuid primary key references public.delivery_charges(id)
    );
    create table public.payment_receipt_snapshots (
      payment_id uuid primary key references public.payments(id)
    );
    create function public.record_event_ice_delivery(
      uuid, jsonb, public.shop_round_status, text, timestamptz, uuid
    ) returns jsonb language sql as $$ select '{}'::jsonb $$;
    insert into public.event_delivery_feature_settings values (true, 6);
    insert into public.round_stops values ('${stopId}', 'event');
  `);

  const writer = psqlConcurrent(`
    begin;
    insert into public.delivery_events values ('${eventId}', '${stopId}');
    select pg_advisory_xact_lock(hashtextextended('0171-preflight-writer', 0));
    select pg_sleep(0.75);
    commit;
  `);

  let writerReachedBarrier = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    writerReachedBarrier = psql(`
      select not pg_try_advisory_lock(hashtextextended('0171-preflight-writer', 0))
    `) === 't';
    if (writerReachedBarrier) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(writerReachedBarrier, true, 'Writer did not reach the race barrier');

  const migration = psqlConcurrent(preflight);
  const [writerResult, migrationResult] = await Promise.all([writer, migration]);
  assert.equal(writerResult.code, 0, writerResult.stderr);
  assert.notEqual(migrationResult.code, 0, 'Preflight should reject committed 0170 history');
  assert.match(migrationResult.stderr, /"event_count": 1/);
  assert.match(migrationResult.stderr, new RegExp(eventId));

  console.log('Event financial foundation PostgreSQL concurrency check passed');

  psql(`
    drop schema public cascade;
    drop schema if exists auth cascade;
    drop schema if exists storage cascade;
    create schema public;
    create schema auth;
    create schema storage;
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role; exception when duplicate_object then null; end $$;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
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
      metadata jsonb,
      unique (bucket_id, name)
    );
    create function storage.foldername(text) returns text[] language sql immutable as $$
      select string_to_array($1, '/')
    $$;
    alter table storage.objects enable row level security;
    create publication supabase_realtime;
  `);

  const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name <= '0173_allow_deferred_immediate_collection.sql')
    .sort();
  for (const migrationName of migrations) {
    try {
      psql(`begin;\n${readFileSync(new URL(migrationName, migrationDirectory), 'utf8')}\ncommit;`);
    } catch (error) {
      throw new Error(`Migration ${migrationName} failed: ${error.message}`);
    }
  }
  assert.equal(psql(`
    select schema_version || ':' || event_ice_delivery_enabled::text
    from public.event_delivery_feature_settings where singleton
  `), '7:false');
  assert.equal(psql(`
    select has_function_privilege(
      'anon', 'public.resolve_delivery_price(uuid,uuid,date)', 'execute'
    ) or has_function_privilege(
      'authenticated', 'public.resolve_delivery_price(uuid,uuid,date)', 'execute'
    )
  `), 'f');
  console.log('Migrations through 0173 apply cleanly and event delivery remains dark on PostgreSQL 16');

  const smokeOutput = psql(`
    set request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';
    insert into auth.users (id, email, raw_user_meta_data) values (
      '10000000-0000-4000-8000-000000000001', 'admin@example.test',
      '{"display_name":"Event admin"}'::jsonb
    );
    update public.users set is_active = true, role = 'admin'
    where id = '10000000-0000-4000-8000-000000000001';

    set session_replication_role = replica;
    insert into public.buildings (id, code, name) values (
      '20000000-0000-4000-8000-000000000001', 'EVT', 'Event building'
    );
    set session_replication_role = origin;
    insert into public.building_zones (id, building_id, code, name) values (
      '21000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001', 'HALL', 'Event hall'
    );
    insert into public.stock_locations (
      id, code, name, kind, assigned_user_id, is_active,
      holds_inventory, requires_daily_count
    ) values (
      '22000000-0000-4000-8000-000000000001', 'EVENT-HOLD',
      'Event holding', 'team', '10000000-0000-4000-8000-000000000001',
      true, true, false
    );
    set session_replication_role = replica;
    insert into public.shops (
      id, code, name, building_id, floor_or_zone, zone_id,
      contact_name, contact_phone, stock_location_id
    ) values (
      '30000000-0000-4000-8000-000000000001', 'EV01', 'Event shop',
      '20000000-0000-4000-8000-000000000001', 'Event hall',
      '21000000-0000-4000-8000-000000000001', 'Contact', '0800000000',
      '22000000-0000-4000-8000-000000000001'
    );
    set session_replication_role = origin;
    insert into public.ice_types (id, code, name, unit) values (
      '40000000-0000-4000-8000-000000000001', 'ICE-E', 'Event ice', 'bag'
    );
    insert into public.ice_type_prices (
      id, ice_type_id, unit_price, valid_from, created_by
    ) values (
      '41000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001', 25,
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      '10000000-0000-4000-8000-000000000001'
    );
    insert into public.delivery_rounds (
      id, service_date, name, round_type, status, opened_by
    ) values (
      '50000000-0000-4000-8000-000000000001',
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      'งานประจำวัน', 'daily', 'open',
      '10000000-0000-4000-8000-000000000001'
    );
    insert into public.event_jobs (
      id, name, organizer_name, contact_name, contact_phone, location,
      start_date, end_date, status, created_by, published_by, published_at
    ) values (
      '60000000-0000-4000-8000-000000000001', 'Pilot event', 'Organizer',
      'Contact', '0800000000', 'Hall A',
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      'published', '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001', clock_timestamp()
    );
    insert into public.event_job_config_versions (
      id, event_job_id, version_no, tank_rental_unit_price, payment_term,
      allowed_payment_methods, default_payment_method,
      bank_transfer_reference_required, qr_reference_required,
      policy_fingerprint, created_by
    ) values (
      '61000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001', 1, 100, 'end_of_day',
      array['cash']::public.payment_method[], 'cash', false, false, 'policy-v1',
      '10000000-0000-4000-8000-000000000001'
    );
    update public.event_jobs
    set current_config_version_id = '61000000-0000-4000-8000-000000000001'
    where id = '60000000-0000-4000-8000-000000000001';
    insert into public.event_participations (
      id, event_job_id, shop_id, booth_number, event_zone, contact_name,
      contact_phone, start_date, end_date, status, config_version_id,
      tank_rental_unit_price_snapshot, payment_term_snapshot,
      allowed_payment_methods_snapshot, default_payment_method_snapshot,
      cash_reference_required_snapshot, cash_evidence_required_snapshot,
      bank_transfer_reference_required_snapshot,
      bank_transfer_evidence_required_snapshot, qr_reference_required_snapshot,
      qr_evidence_required_snapshot, settlement_policy_fingerprint,
      created_by, updated_by
    ) values (
      '62000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001', 'A1', 'Food', 'Contact',
      '0800000000', (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      (clock_timestamp() at time zone 'Asia/Bangkok')::date, 'active',
      '61000000-0000-4000-8000-000000000001', 100, 'end_of_day',
      array['cash']::public.payment_method[], 'cash', false, false,
      false, false, false, false, 'policy-v1',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001'
    );
    insert into public.round_stops (
      id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot,
      sequence_no, status, updated_by, destination_kind,
      event_participation_id, is_operational, event_job_name_snapshot,
      event_location_snapshot, event_zone_snapshot, event_booth_snapshot,
      event_contact_name_snapshot, event_contact_phone_snapshot
    ) values (
      '70000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001', 'EV01', 'Event shop',
      '20000000-0000-4000-8000-000000000001', 'Event building', 'Event hall',
      1, 'pending',
      '10000000-0000-4000-8000-000000000001', 'event',
      '62000000-0000-4000-8000-000000000001', true,
      'Pilot event', 'Hall A', 'Food', 'A1', 'Contact', '0800000000'
    );
    insert into public.stock_movements (
      id, service_date, round_id, kind, to_location_id,
      idempotency_key, recorded_by
    ) select
      '71000000-0000-4000-8000-000000000001',
      (clock_timestamp() at time zone 'Asia/Bangkok')::date,
      '50000000-0000-4000-8000-000000000001', 'factory_order',
      shop.stock_location_id, '71000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001'
    from public.shops shop where shop.id = '30000000-0000-4000-8000-000000000001';
    insert into public.stock_movement_items (movement_id, ice_type_id, quantity)
    values ('71000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001', 10);

    select public.enable_event_ice_delivery_pilot(
      '62000000-0000-4000-8000-000000000001', clock_timestamp() + interval '1 hour'
    );
    select public.record_event_ice_delivery(
      '70000000-0000-4000-8000-000000000001',
      '[]'::jsonb, 'issue', 'customer asked to retry', clock_timestamp(),
      '80000000-0000-4000-8000-000000000001'
    );
    select public.disable_event_ice_delivery_pilot(
      '62000000-0000-4000-8000-000000000001'
    );
    do $$
    declare
      v_issue_event_id uuid;
    begin
      select event.id into v_issue_event_id
      from public.delivery_events event
      where event.idempotency_key = '80000000-0000-4000-8000-000000000001';
      perform public.apply_open_event_delivery_correction(
        v_issue_event_id, 'correct',
        '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
        'delivered', 'late correction', 'should remain dark',
        '80000000-0000-4000-8000-000000000005', null
      );
      raise exception 'disabled intake correction unexpectedly created a delivery';
    exception when others then
      if sqlerrm not like '%not enabled for this participation%' then raise; end if;
    end $$;
    select public.enable_event_ice_delivery_pilot(
      '62000000-0000-4000-8000-000000000001', clock_timestamp() + interval '1 hour'
    );
    select public.apply_open_event_delivery_correction(
      event.id, 'correct',
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
      'delivered', 'delivered on retry', 'resolved intake issue',
      '80000000-0000-4000-8000-000000000003', null
    )
    from public.delivery_events event
    where event.idempotency_key = '80000000-0000-4000-8000-000000000001';
    select public.disable_event_ice_delivery_pilot(
      '62000000-0000-4000-8000-000000000001'
    );
    do $$
    begin
      perform public.record_event_ice_delivery(
        '70000000-0000-4000-8000-000000000001',
        '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
        'delivered', null, clock_timestamp(),
        '80000000-0000-4000-8000-000000000002'
      );
      raise exception 'disabled pilot unexpectedly accepted a new delivery';
    exception when others then
      if sqlerrm not like '%not enabled for this participation%' then raise; end if;
    end $$;
    select public.activate_event_ice_delivery();
    select public.deactivate_event_ice_delivery();
    do $$
    begin
      if exists (
        select 1 from public.event_delivery_feature_settings settings
        where settings.singleton and settings.event_ice_delivery_enabled
      ) or exists (select 1 from public.event_ice_delivery_pilots) then
        raise exception 'global rollback did not leave event intake dark';
      end if;
    end $$;
    select public.ensure_daily_collection_context(
      (clock_timestamp() at time zone 'Asia/Bangkok')::date
    );
    do $$
    declare
      v_queue jsonb;
    begin
      select public.get_collection_run_queue(run.id) into v_queue
      from public.collection_runs run
      where run.service_date = (clock_timestamp() at time zone 'Asia/Bangkok')::date;
      if jsonb_array_length(v_queue) <> 1
        or v_queue -> 0 ->> 'destination_kind' <> 'event'
        or v_queue -> 0 ->> 'queue_key' not like 'event:%' then
        raise exception 'event collection queue contract mismatch: %', v_queue;
      end if;
    end $$;
    select public.record_event_payment(
      context.id, context.event_participation_id, context.service_date,
      context.settlement_policy_fingerprint,
      jsonb_build_array(jsonb_build_object('charge_id', charge.id, 'amount', 50)),
      'cash', 50, null, null, run.id, 50,
      '90000000-0000-4000-8000-000000000001'
    )
    from public.event_settlement_contexts context
    join public.delivery_charges charge
      on charge.event_settlement_context_id = context.id
    join public.collection_runs run on run.service_date = context.service_date
    where context.event_participation_id = '62000000-0000-4000-8000-000000000001';

    do $$
    declare
      v_context public.event_settlement_contexts%rowtype;
      v_charge public.delivery_charges%rowtype;
      v_run_id uuid;
    begin
      select * into v_context from public.event_settlement_contexts context
      where context.event_participation_id = '62000000-0000-4000-8000-000000000001';
      select * into v_charge from public.delivery_charges charge
      where charge.event_settlement_context_id = v_context.id and charge.status = 'active';
      select run.id into v_run_id from public.collection_runs run
      where run.service_date = v_context.service_date;
      perform public.record_event_payment(
        v_context.id, v_context.event_participation_id, v_context.service_date,
        v_context.settlement_policy_fingerprint,
        jsonb_build_array(jsonb_build_object('charge_id', v_charge.id, 'amount', 50)),
        'cash', 50, null, null, v_run_id, 49,
        '90000000-0000-4000-8000-000000000001'
      );
      raise exception 'changed expected outstanding unexpectedly replayed';
    exception when others then
      if sqlerrm not like '%idempotency key was already used%' then raise; end if;
    end $$;

    select public.apply_open_event_delivery_correction(
      charge.delivery_event_id, 'correct',
      '[{"ice_type_id":"40000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
      'delivered', 'corrected pilot quantity', 'pilot correction',
      '91000000-0000-4000-8000-000000000001', null
    )
    from public.delivery_charges charge
    where charge.event_settlement_context_id = (
      select context.id from public.event_settlement_contexts context
      where context.event_participation_id = '62000000-0000-4000-8000-000000000001'
    )
    order by charge.created_at
    limit 1;

    do $$
    begin
      insert into public.refund_obligations (
        payment_id, source_charge_id, amount, reason, source_kind, source_id,
        created_by
      ) select payment.id, charge.id, 1, 'invalid over-refund',
          'open_revision', gen_random_uuid(), auth.uid()
        from public.payments payment
        join public.payment_allocations allocation on allocation.payment_id = payment.id
        join public.delivery_charges charge on charge.id = allocation.charge_id
        where payment.idempotency_key = '90000000-0000-4000-8000-000000000001'
        limit 1;
      set constraints all immediate;
      raise exception 'invalid refund obligation unexpectedly committed';
    exception when others then
      if sqlerrm not like '%allocations plus refund obligations%' then raise; end if;
    end $$;
    set constraints all deferred;

    do $$
    begin
      insert into public.delivery_charge_adjustments (
        charge_id, scope, amount_delta, corrected_total, reason,
        idempotency_key, request_fingerprint, created_by
      ) select charge.id, 'round_closed', -25, 0, 'invalid paid adjustment',
          gen_random_uuid(), md5(gen_random_uuid()::text), auth.uid()
        from public.delivery_charges charge
        join public.payment_allocations allocation on allocation.charge_id = charge.id
        join public.payments payment on payment.id = allocation.payment_id
        where payment.idempotency_key = '90000000-0000-4000-8000-000000000001'
        limit 1;
      set constraints all immediate;
      raise exception 'invalid delivery adjustment unexpectedly committed';
    exception when others then
      if sqlerrm not like '%cannot exceed the effective charge amount%' then raise; end if;
    end $$;
    set constraints all deferred;

    do $$
    declare
      v_history jsonb;
      v_transactions jsonb;
      v_invoice_detail jsonb;
    begin
      v_history := public.get_payment_history(
        (clock_timestamp() at time zone 'Asia/Bangkok')::date,
        (clock_timestamp() at time zone 'Asia/Bangkok')::date,
        1, null, null
      );
      if v_history -> 'items' -> 0 ->> 'destination_kind' <> 'event'
        or v_history -> 'items' -> 0 ->> 'event_name' <> 'Pilot event' then
        raise exception 'event payment history projection mismatch: %', v_history;
      end if;

      v_transactions := public.get_accounting_transactions(
        (clock_timestamp() at time zone 'Asia/Bangkok')::date,
        (clock_timestamp() at time zone 'Asia/Bangkok')::date,
        '{}'::jsonb, '{"key":"occurred_at","direction":"desc"}'::jsonb,
        100, 0
      );
      if not exists (
        select 1 from jsonb_array_elements(v_transactions -> 'rows') row
        where row ->> 'type' = 'REC'
          and row #>> '{details,destination_kind}' = 'event'
          and row #>> '{details,event_name}' = 'Pilot event'
      ) or not exists (
        select 1 from jsonb_array_elements(v_transactions -> 'rows') row
        where row ->> 'type' = 'REF'
          and row #>> '{details,destination_kind}' = 'event'
      ) then
        raise exception 'event accounting projection mismatch: %', v_transactions;
      end if;

      v_invoice_detail := public.get_accounting_shop_invoice_detail(
        '30000000-0000-4000-8000-000000000001',
        (clock_timestamp() at time zone 'Asia/Bangkok')::date,
        (clock_timestamp() at time zone 'Asia/Bangkok')::date,
        '{}'::jsonb, 100, 0
      );
      if not exists (
        select 1 from jsonb_array_elements(v_invoice_detail) invoice
        where invoice ->> 'destination_kind' = 'event'
          and invoice ->> 'event_name' = 'Pilot event'
      ) then
        raise exception 'event invoice detail projection mismatch: %', v_invoice_detail;
      end if;
    end $$;

    insert into auth.users (id, email, raw_user_meta_data) values (
      '10000000-0000-4000-8000-000000000002', 'courier@example.test',
      '{"display_name":"Unassigned courier"}'::jsonb
    );
    update public.users set is_active = true, role = 'courier'
    where id = '10000000-0000-4000-8000-000000000002';

    set request.jwt.claim.sub = '10000000-0000-4000-8000-000000000002';
    do $event_correction_visibility$
    declare
      v_event_id uuid;
    begin
      select event.id into v_event_id
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      where stop.destination_kind = 'event'
      order by event.recorded_at desc, event.id desc
      limit 1;

      perform public.get_event_delivery_correction_context(v_event_id);
      raise exception 'unassigned courier unexpectedly read event correction context';
    exception
      when others then
        if sqlerrm not like '%cannot be viewed by the current user%' then
          raise;
        end if;
    end
    $event_correction_visibility$;
    set request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

    select payment.operation_kind || ':'
      || (payment.event_settlement_context_id is not null)::text || ':'
      || payment.request_fingerprint_version::text || ':'
      || (snapshot.receipt_data ->> 'destination_kind') || ':'
      || (select count(*) from public.refund_obligations obligation
          where obligation.payment_id = payment.id and obligation.status = 'pending')::text
    from public.payments payment
    join public.payment_receipt_snapshots snapshot on snapshot.payment_id = payment.id
    where payment.idempotency_key = '90000000-0000-4000-8000-000000000001';
  `);
  assert.equal(smokeOutput.split('\n').at(-1), 'event:true:2:event:1');
  console.log('Event pilot, intake correction, v2 payment, integrity, documents, and accounting smoke check passed');
} finally {
  docker(['rm', '-f', container]);
}
