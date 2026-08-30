import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const container = `ice-event-sync-${process.pid}`;
const courierId = '10000000-0000-4000-8000-000000000001';
const secondCourierId = '10000000-0000-4000-8000-000000000002';
const adminId = '10000000-0000-4000-8000-000000000003';
const roundId = '40000000-0000-4000-8000-000000000001';
const participationId = '60000000-0000-4000-8000-000000000001';
const serviceDate = '2026-08-29';
const roundCloseMigration = readFileSync(
  new URL('../supabase/migrations/0026_round_stock_snapshots.sql', import.meta.url),
  'utf8',
);
const compatibilityMigration = readFileSync(
  new URL('../supabase/migrations/0157_event_destination_compatibility_fence.sql', import.meta.url),
  'utf8',
);
const dailyCloseMigration = readFileSync(
  new URL('../supabase/migrations/0107_daily_aggregate_stock.sql', import.meta.url),
  'utf8',
);
const lifecycleMigration = readFileSync(
  new URL('../supabase/migrations/0163_event_lifecycle_foundation.sql', import.meta.url),
  'utf8',
);

function extractFunction(migration, name) {
  const start = migration.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `Missing ${name} definition`);
  const end = migration.indexOf('\n$$;', start);
  assert.ok(end >= 0, `Incomplete ${name} definition`);
  return migration.slice(start, end + '\n$$;'.length);
}

function deployedRoundCloseDefinition() {
  let definition = extractFunction(roundCloseMigration, 'close_delivery_round');
  const oldDeclaration = '  v_service_date date;\n';
  const oldRoundLock = `  select status, service_date into v_status, v_service_date
  from public.delivery_rounds
  where id = p_round_id
  for update;`;
  const newRoundLock = `  select service_date into v_lock_service_date
  from public.delivery_rounds
  where id = p_round_id;

  if v_lock_service_date is null then
    raise exception 'The selected delivery round does not exist';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_lock_service_date::text, 0));

  select status, service_date into v_status, v_service_date
  from public.delivery_rounds
  where id = p_round_id
  for update;

  if v_service_date is distinct from v_lock_service_date then
    raise exception 'The delivery round changed service date; retry the request';
  end if;`;
  assert.ok(definition.includes(oldDeclaration));
  assert.ok(definition.includes(oldRoundLock));
  assert.ok(compatibilityMigration.includes(newRoundLock));
  definition = definition.replace(
    oldDeclaration,
    `${oldDeclaration}  v_lock_service_date date;\n`,
  );
  definition = definition.replace(oldRoundLock, newRoundLock);
  definition = definition.replace(
    '  perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));\n',
    '',
  );
  return definition;
}

const closeRoundDefinition = deployedRoundCloseDefinition();
const closeDailyDefinition = extractFunction(dailyCloseMigration, 'close_daily_aggregate_stock');
const cancelParticipationDefinition = extractFunction(
  lifecycleMigration,
  'cancel_event_participation',
);
const saveParticipationDefinition = extractFunction(lifecycleMigration, 'save_event_participation');

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

function session(userId, sql, holdMarker = false) {
  return `begin;
    set local lock_timeout = '3s';
    set local app.test_user_id = '${userId}';
    ${sql};
    ${holdMarker ? `
      select pg_advisory_xact_lock(hashtextextended('event-sync-test-marker', 0));
      select pg_sleep(0.5);
    ` : ''}
    commit;`;
}

async function runFirstThenSecond(firstSql, secondSql) {
  const first = psqlConcurrent(firstSql);
  let markerHeld = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    markerHeld = psql(`
      select not pg_try_advisory_lock(
        hashtextextended('event-sync-test-marker', 0)
      )
    `) === 't';
    if (markerHeld) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!markerHeld) {
    const result = await first;
    assert.fail(`First transaction did not reach the race barrier: ${result.stderr || result.stdout}`);
  }
  const second = psqlConcurrent(secondSql);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join('\n'));
  return results;
}

const foundation = `
  create extension if not exists pgcrypto;
  create schema auth;
  create role anon;
  create role authenticated;
  create type public.app_role as enum ('courier', 'round_lead', 'admin');
  create type public.shop_status as enum ('active', 'inactive');
  create type public.delivery_round_status as enum ('open', 'closed');
  create type public.shop_round_status as enum (
    'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
  );
  create type public.round_destination_kind as enum ('regular', 'event');
  create type public.event_job_status as enum ('draft', 'published', 'cancelled');
  create type public.event_participation_status as enum ('active', 'cancelled');
  create type public.stock_location_kind as enum ('building', 'team', 'small_vehicle');
  create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
  create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');

  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('app.test_user_id', true), '')::uuid
  $$;
  create table public.users (
    id uuid primary key, role public.app_role not null, is_active boolean not null
  );
  create function public.is_active_user() returns boolean language sql stable as $$
    select exists (select 1 from public.users where id = auth.uid() and is_active)
  $$;
  create function public.current_app_role() returns public.app_role language sql stable as $$
    select role from public.users where id = auth.uid() and is_active
  $$;

  create table public.buildings (
    id uuid primary key, name text not null, sort_order integer not null,
    is_active boolean not null
  );
  create table public.building_zones (id uuid primary key, sort_order integer not null);
  create table public.shops (
    id uuid primary key, code text not null, name text not null,
    building_id uuid not null, zone_id uuid not null, floor_or_zone text not null,
    delivery_sequence integer, status public.shop_status not null,
    contact_name text, contact_phone text
  );
  create table public.delivery_rounds (
    id uuid primary key, service_date date not null, name text not null,
    round_type text not null, status public.delivery_round_status not null,
    opened_at timestamptz not null default now(), created_at timestamptz not null default now(),
    cancelled_at timestamptz, closed_by uuid, closed_at timestamptz
  );
  create table public.delivery_round_members (
    round_id uuid not null, user_id uuid not null, primary key (round_id, user_id)
  );
  create function public.is_round_member(p_round_id uuid) returns boolean language sql stable as $$
    select exists (
      select 1 from public.delivery_round_members
      where round_id = p_round_id and user_id = auth.uid()
    )
  $$;

  create table public.ice_types (
    id uuid primary key, code text not null, name text not null, unit text not null,
    is_active boolean not null
  );
  create table public.stock_locations (
    id uuid primary key, code text not null, name text not null,
    kind public.stock_location_kind not null, is_active boolean not null
  );
  create function public.stock_balance_at(date, uuid, uuid)
  returns integer language sql stable as $$ select 0 $$;
  create function public.daily_aggregate_stock_balance_at(date, uuid)
  returns numeric language sql stable as $$ select 0::numeric $$;

  create table public.event_jobs (
    id uuid primary key, name text not null, location text not null,
    start_date date not null, end_date date not null, status public.event_job_status not null,
    current_config_version_id uuid
  );
  create table public.event_job_config_versions (
    id uuid primary key, event_job_id uuid not null, version_no integer not null,
    tank_rental_unit_price numeric, payment_term public.payment_term,
    allowed_payment_methods public.payment_method[], default_payment_method public.payment_method,
    cash_reference_required boolean, cash_evidence_required boolean,
    bank_transfer_reference_required boolean, bank_transfer_evidence_required boolean,
    qr_reference_required boolean, qr_evidence_required boolean,
    policy_fingerprint text
  );
  create table public.event_participations (
    id uuid primary key, event_job_id uuid not null, shop_id uuid not null,
    booth_number text, event_zone text, landmark text, contact_name text,
    contact_phone text, start_date date not null, end_date date not null,
    rents_tank_from_us boolean not null default false,
    status public.event_participation_status not null,
    config_version_id uuid, tank_rental_unit_price_snapshot numeric,
    payment_term_snapshot public.payment_term,
    allowed_payment_methods_snapshot public.payment_method[],
    default_payment_method_snapshot public.payment_method,
    cash_reference_required_snapshot boolean, cash_evidence_required_snapshot boolean,
    bank_transfer_reference_required_snapshot boolean,
    bank_transfer_evidence_required_snapshot boolean,
    qr_reference_required_snapshot boolean, qr_evidence_required_snapshot boolean,
    settlement_policy_fingerprint text, created_by uuid, updated_by uuid,
    cancelled_by uuid, cancelled_at timestamptz, cancellation_reason text
  );
  create table public.event_delivery_feature_settings (
    singleton boolean primary key, schema_version integer not null,
    lifecycle_enabled boolean not null, event_reads_enabled boolean not null,
    event_stops_enabled boolean not null, event_ice_delivery_enabled boolean not null,
    event_tank_rental_enabled boolean not null, updated_at timestamptz not null
  );
  create table public.round_stops (
    id uuid primary key default gen_random_uuid(), round_id uuid not null,
    shop_id uuid not null, shop_code_snapshot text not null,
    shop_name_snapshot text not null, building_id_snapshot uuid not null,
    building_name_snapshot text not null, floor_or_zone_snapshot text not null,
    sequence_no integer not null, status public.shop_round_status not null default 'pending',
    note text, updated_by uuid not null, updated_at timestamptz not null default now(),
    destination_kind public.round_destination_kind not null default 'regular',
    event_participation_id uuid, is_operational boolean not null default true,
    event_job_name_snapshot text, event_location_snapshot text,
    event_booth_snapshot text, event_zone_snapshot text, event_landmark_snapshot text,
    event_contact_name_snapshot text, event_contact_phone_snapshot text,
    unique (round_id, sequence_no)
  );
  create unique index round_stops_regular_destination_unique_idx
    on public.round_stops (round_id, shop_id) where destination_kind = 'regular';
  create unique index round_stops_event_destination_unique_idx
    on public.round_stops (round_id, event_participation_id) where destination_kind = 'event';

  create table public.delivery_events (
    id uuid primary key default gen_random_uuid(), round_stop_id uuid not null
  );
  create table public.audit_logs (
    id uuid primary key default gen_random_uuid(), actor_id uuid,
    entity_type text, entity_id uuid, action text, before_value jsonb,
    after_value jsonb, reason text, occurred_at timestamptz not null default now()
  );
  create table public.round_close_summaries (
    round_id uuid primary key, total_shop_count integer, delivered_shop_count integer,
    pending_shop_count integer, problem_shop_count integer,
    captured_by uuid, captured_at timestamptz
  );
  create table public.round_stock_snapshots (
    round_id uuid primary key, service_date date not null,
    captured_by uuid not null, captured_at timestamptz not null
  );
  create table public.round_stock_snapshot_items (
    round_id uuid not null, location_id uuid not null,
    location_code_snapshot text not null, location_name_snapshot text not null,
    location_kind_snapshot public.stock_location_kind not null,
    ice_type_id uuid not null, ice_type_name_snapshot text not null,
    unit_snapshot text not null, quantity integer not null
  );
  create table public.daily_aggregate_stock_closures (
    service_date date primary key, status text not null, note text,
    idempotency_key uuid unique, closed_by uuid, closed_at timestamptz
  );
  create table public.daily_aggregate_stock_closure_items (
    service_date date not null, ice_type_id uuid not null,
    system_quantity numeric not null, actual_quantity numeric not null,
    variance_quantity numeric not null, note text
  );
  create function public.get_round_control_summary(uuid)
  returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create function public.get_daily_aggregate_stock_summary(date)
  returns jsonb language sql stable as $$ select '{}'::jsonb $$;

  create function public.get_employee_active_session(date default null)
  returns jsonb language sql as $$ select '{}'::jsonb $$;

  insert into public.users values
    ('${courierId}', 'courier', true),
    ('${secondCourierId}', 'courier', true),
    ('${adminId}', 'admin', true);
  insert into public.buildings values
    ('20000000-0000-4000-8000-000000000001', 'Building A', 1, true);
  insert into public.building_zones values
    ('20000000-0000-4000-8000-000000000002', 1);
  insert into public.ice_types values
    ('70000000-0000-4000-8000-000000000001', 'ICE', 'Ice', 'bag', true);
  insert into public.stock_locations values
    ('71000000-0000-4000-8000-000000000001', 'BLD', 'Building stock', 'building', true);
  insert into public.shops values
    (
      '30000000-0000-4000-8000-000000000001', 'R001', 'Regular shop',
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002', 'A1', 1, 'active',
      'Regular contact', '0811111111'
    ),
    (
      '30000000-0000-4000-8000-000000000002', 'E001', 'Event shop',
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002', 'A2', 2, 'inactive',
      'Event contact', '0899999999'
    );
  insert into public.delivery_rounds (
    id, service_date, name, round_type, status, opened_at, created_at, cancelled_at
  ) values (
    '${roundId}', date '${serviceDate}', 'Daily', 'daily', 'open', now(), now(), null
  );
  insert into public.event_jobs (id, name, location, start_date, end_date, status) values (
    '50000000-0000-4000-8000-000000000001', 'Expo', 'Hall A',
    date '${serviceDate}', date '2026-08-30', 'published'
  );
  insert into public.event_participations (
    id, event_job_id, shop_id, booth_number, event_zone, landmark,
    contact_name, contact_phone, start_date, end_date, status, created_by, updated_by
  ) values (
    '${participationId}', '50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002', 'B01', 'North', null,
    'Event contact', '0899999999', date '${serviceDate}', date '2026-08-30', 'active',
    '${adminId}', '${adminId}'
  );
  insert into public.event_delivery_feature_settings values (
    true, 2, true, true, false, false, false, now()
  );
`;

function resetRound({ clearMembers = false, clearStops = false, activeParticipation = true } = {}) {
  psql(`
    delete from public.round_stock_snapshot_items where round_id = '${roundId}';
    delete from public.round_stock_snapshots where round_id = '${roundId}';
    delete from public.round_close_summaries where round_id = '${roundId}';
    delete from public.daily_aggregate_stock_closure_items where service_date = date '${serviceDate}';
    delete from public.daily_aggregate_stock_closures where service_date = date '${serviceDate}';
    update public.delivery_rounds
      set status = 'open', cancelled_at = null, closed_by = null, closed_at = null
      where id = '${roundId}';
    update public.event_participations
      set status = '${activeParticipation ? 'active' : 'cancelled'}',
          start_date = date '${serviceDate}',
          cancelled_by = ${activeParticipation ? 'null' : `'${adminId}'`},
          cancelled_at = ${activeParticipation ? 'null' : 'now()'},
          cancellation_reason = ${activeParticipation ? 'null' : "'test reset'"}
      where id = '${participationId}';
    ${clearMembers ? `delete from public.delivery_round_members where round_id = '${roundId}';` : ''}
    ${clearStops ? `delete from public.round_stops where round_id = '${roundId}';` : ''}
  `);
}

try {
  const started = docker([
    'run', '--rm', '-d', '--name', container,
    '-e', `POSTGRES_PASSWORD=${randomUUID()}`, 'postgres:16',
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (docker(['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'PostgreSQL container did not become ready');

  psql(foundation);
  psql(closeRoundDefinition);
  psql(closeDailyDefinition);
  psql(cancelParticipationDefinition);
  psql(saveParticipationDefinition);
  psql(readFileSync(new URL('../supabase/migrations/0166_event_destination_sync_dark_launch.sql', import.meta.url), 'utf8'));
  psql(readFileSync(new URL('../supabase/migrations/0167_enable_event_destination_stops.sql', import.meta.url), 'utf8'));

  resetRound({ clearMembers: true, clearStops: true });
  await runFirstThenSecond(
    session(adminId, `select public.close_delivery_round('${roundId}', '[]'::jsonb)`, true),
    session(courierId, `select public.get_employee_active_session(date '${serviceDate}')`),
  );
  assert.equal(psql(`select count(*) from public.delivery_round_members where user_id = '${courierId}'`), '0');

  resetRound({ clearMembers: true });
  await runFirstThenSecond(
    session(courierId, `select public.get_employee_active_session(date '${serviceDate}')`, true),
    session(adminId, `select public.close_delivery_round('${roundId}', '[]'::jsonb)`),
  );
  assert.equal(psql(`select count(*) from public.delivery_round_members where user_id = '${courierId}'`), '1');

  resetRound({ clearStops: true });
  await runFirstThenSecond(
    session(adminId, `select public.close_delivery_round('${roundId}', '[]'::jsonb)`, true),
    session(adminId, `select public.sync_daily_round_destinations('${roundId}')`),
  );
  assert.equal(psql(`select count(*) from public.round_stops where round_id = '${roundId}'`), '0');

  resetRound({ clearStops: true });
  await runFirstThenSecond(
    session(adminId, `select public.sync_daily_round_destinations('${roundId}')`, true),
    session(adminId, `select public.close_delivery_round('${roundId}', '[]'::jsonb)`),
  );
  assert.equal(psql(`select count(*) from public.round_stops where round_id = '${roundId}'`), '2');

  resetRound({ clearStops: true });
  await runFirstThenSecond(
    session(adminId, `select public.close_daily_aggregate_stock(
      date '${serviceDate}',
      '[{"ice_type_id":"70000000-0000-4000-8000-000000000001","actual_quantity":0}]'::jsonb,
      null,
      '${randomUUID()}'
    )`, true),
    session(adminId, `select public.sync_daily_round_destinations('${roundId}')`),
  );
  assert.equal(psql(`select count(*) from public.round_stops where round_id = '${roundId}'`), '0');

  resetRound({ clearStops: true });
  await runFirstThenSecond(
    session(adminId, `select public.sync_daily_round_destinations('${roundId}')`, true),
    session(adminId, `select public.close_daily_aggregate_stock(
      date '${serviceDate}',
      '[{"ice_type_id":"70000000-0000-4000-8000-000000000001","actual_quantity":0}]'::jsonb,
      null,
      '${randomUUID()}'
    )`),
  );
  assert.equal(psql(`select count(*) from public.round_stops where round_id = '${roundId}'`), '2');

  resetRound({ clearStops: true });
  await runFirstThenSecond(
    session(adminId, `select public.cancel_event_participation(
      '${participationId}', 'test cancellation'
    )`, true),
    session(adminId, `select public.sync_daily_round_destinations('${roundId}')`),
  );
  assert.equal(psql(`select count(*) from public.round_stops where destination_kind = 'event'`), '0');

  resetRound({ clearStops: true });
  await runFirstThenSecond(
    session(adminId, `select public.sync_daily_round_destinations('${roundId}')`, true),
    session(adminId, `select public.cancel_event_participation(
      '${participationId}', 'test cancellation'
    )`),
  );
  assert.equal(psql(`select is_operational from public.round_stops where destination_kind = 'event'`), 't');
  resetRound({ activeParticipation: false });
  psql(session(adminId, `select public.sync_daily_round_destinations('${roundId}')`));
  assert.equal(psql(`select is_operational from public.round_stops where destination_kind = 'event'`), 'f');

  psql(`update public.shops set status = 'active'
    where id = '30000000-0000-4000-8000-000000000002'`);
  resetRound({ clearStops: true });
  psql(session(adminId, `select public.sync_daily_round_destinations('${roundId}')`));
  psql(`update public.event_participations set start_date = date '2026-08-30' where id = '${participationId}'`);
  psql(session(adminId, `select public.sync_daily_round_destinations('${roundId}')`));
  assert.equal(psql(`select is_operational from public.round_stops where destination_kind = 'event'`), 'f');
  await runFirstThenSecond(
    session(adminId, `
      select public.save_event_participation(
        '${participationId}', '50000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002', 'B01', 'North', null,
        'Event contact', '0899999999', date '${serviceDate}', date '2026-08-30', false
      )
    `, true),
    session(adminId, `select public.sync_daily_round_destinations('${roundId}')`),
  );
  assert.equal(psql(`select is_operational from public.round_stops where destination_kind = 'event'`), 't');

  psql(`update public.event_participations set start_date = date '2026-08-30' where id = '${participationId}'`);
  psql(session(adminId, `select public.sync_daily_round_destinations('${roundId}')`));
  await runFirstThenSecond(
    session(adminId, `select public.sync_daily_round_destinations('${roundId}')`, true),
    session(adminId, `
      select public.save_event_participation(
        '${participationId}', '50000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002', 'B01', 'North', null,
        'Event contact', '0899999999', date '${serviceDate}', date '2026-08-30', false
      )
    `),
  );
  assert.equal(psql(`select is_operational from public.round_stops where destination_kind = 'event'`), 'f');
  psql(session(adminId, `select public.sync_daily_round_destinations('${roundId}')`));
  assert.equal(psql(`select is_operational from public.round_stops where destination_kind = 'event'`), 't');

  console.log('event destination PostgreSQL concurrency checks passed');
} finally {
  docker(['rm', '-f', container]);
}
