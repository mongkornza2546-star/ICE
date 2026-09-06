import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0171_event_ice_delivery_financial_closeout.sql', import.meta.url),
  'utf8',
);
const activationMigration = readFileSync(
  new URL('../supabase/migrations/0172_enable_event_ice_delivery.sql', import.meta.url),
  'utf8',
);
const foundationEnd = migration.indexOf('alter table public.payments\n  add column operation_kind');
assert.notEqual(foundationEnd, -1, '0171 financial foundation marker is missing');
const financialFoundation = migration.slice(0, foundationEnd);

test('0171 preflight locks legacy writer tables before inspecting history', () => {
  const lockAt = migration.indexOf(
    'lock table public.delivery_events, public.delivery_charges',
  );
  const historyReadAt = migration.indexOf('array_agg(event.id order by event.id)');
  assert.notEqual(lockAt, -1);
  assert.notEqual(historyReadAt, -1);
  assert.ok(lockAt < historyReadAt);
});

test('0171 dark-installs schema 7 and 0172 installs explicit guarded activation controls', () => {
  assert.match(migration, /set schema_version = greatest\(schema_version, 7\),\s*event_ice_delivery_enabled = false/i);
  assert.match(activationMigration, /schema_version >= 7/i);
  assert.match(activationMigration, /to_regprocedure\(\s*'public\.record_event_payment/i);
  assert.match(activationMigration, /create or replace function public\.activate_event_ice_delivery\(\)/i);
  assert.match(activationMigration, /create or replace function public\.deactivate_event_ice_delivery\(\)/i);
  assert.match(activationMigration, /current_app_role\(\) <> 'admin'/i);
  assert.match(activationMigration, /set event_ice_delivery_enabled = true/i);
  assert.match(activationMigration, /set event_ice_delivery_enabled = false/i);
  assert.match(activationMigration, /delete from public\.event_ice_delivery_pilots/i);
  assert.doesNotMatch(activationMigration, /alter\s+table/i);
});

test('0171 completes v2 payment fingerprints and deferred integrity coverage', () => {
  assert.match(migration, /alter column request_fingerprint_version set default 2/i);
  assert.match(migration, /financial_payment_request_fingerprint_v1\(p_payload jsonb\)/i);
  assert.match(migration, /'expected_outstanding_amount', p_expected_outstanding_amount::numeric\(12,2\)/i);
  assert.match(migration, /create constraint trigger refund_obligations_allocation_integrity/i);
  assert.match(migration, /create constraint trigger delivery_charge_adjustments_allocation_integrity/i);
  assert.match(migration, /create constraint trigger event_settlement_contexts_allocation_integrity/i);
  assert.match(migration, /apply_event_delivery_intake_correction/i);
  assert.match(
    migration,
    /get_event_delivery_correction_context[\s\S]*?is_delivery_event_visible\(p_event_id\)/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.resolve_delivery_price\(uuid, uuid, date\)\s+from public, anon, authenticated/i,
  );
});

async function createDatabase({ withEventHistory = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create type public.shop_round_status as enum (
      'pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue'
    );
    create type public.round_destination_kind as enum ('regular', 'event');
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');

    create function auth.uid() returns uuid language sql stable as $$
      select '10000000-0000-4000-8000-000000000001'::uuid
    $$;

    create table public.users (id uuid primary key);
    create table public.shops (id uuid primary key);
    create table public.event_jobs (
      id uuid primary key,
      start_date date not null,
      end_date date not null
    );
    create table public.event_job_config_versions (
      id uuid primary key,
      event_job_id uuid not null references public.event_jobs(id),
      policy_fingerprint text not null
    );
    create table public.event_participations (
      id uuid primary key,
      event_job_id uuid not null references public.event_jobs(id),
      shop_id uuid not null references public.shops(id),
      start_date date not null,
      end_date date not null,
      config_version_id uuid references public.event_job_config_versions(id),
      settlement_policy_fingerprint text
    );
    create table public.event_delivery_feature_settings (
      singleton boolean primary key,
      schema_version integer not null,
      event_ice_delivery_enabled boolean not null,
      updated_at timestamptz not null
    );
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null
    );
    create table public.round_stops (
      id uuid primary key,
      round_id uuid not null references public.delivery_rounds(id),
      shop_id uuid not null references public.shops(id),
      destination_kind public.round_destination_kind not null,
      event_participation_id uuid references public.event_participations(id)
    );
    create table public.delivery_events (
      id uuid primary key,
      round_stop_id uuid not null references public.round_stops(id)
    );
    create table public.delivery_charges (
      id uuid primary key,
      delivery_event_id uuid not null references public.delivery_events(id),
      shop_id uuid not null references public.shops(id),
      service_date date not null,
      payment_term public.payment_term not null default 'end_of_day',
      status text not null
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

    insert into public.users values ('10000000-0000-4000-8000-000000000001');
    insert into public.event_delivery_feature_settings
    values (true, 6, false, now());
    insert into public.shops values
      ('20000000-0000-4000-8000-000000000001'),
      ('20000000-0000-4000-8000-000000000002');
    insert into public.delivery_rounds
    values ('30000000-0000-4000-8000-000000000001', date '2026-09-03');
  `);

  if (withEventHistory) {
    await db.exec(`
      insert into public.round_stops values (
        '40000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        'event', null
      );
      insert into public.delivery_events values (
        '50000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001'
      );
      insert into public.delivery_charges values (
        '60000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        date '2026-09-03', 'end_of_day', 'active'
      );
      insert into public.payments values ('70000000-0000-4000-8000-000000000001');
      insert into public.payment_allocations values (
        '70000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001'
      );
      insert into public.delivery_charge_document_snapshots
      values ('60000000-0000-4000-8000-000000000001');
      insert into public.payment_receipt_snapshots
      values ('70000000-0000-4000-8000-000000000001');
    `);
  }

  return db;
}

test('0171 preflight aborts before DDL when 0170 event history exists', async (t) => {
  const db = await createDatabase({ withEventHistory: true });
  t.after(() => db.close());

  await assert.rejects(
    db.exec(migration),
    /"event_count": 1.*"charge_count": 1.*"invoice_count": 1.*"payment_count": 1.*"receipt_count": 1/i,
  );
  const relation = await db.query(`select to_regclass('public.event_settlement_contexts') as name`);
  assert.equal(relation.rows[0].name, null);
});

test('0171 foundation creates one immutable context and enforces charge identity', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await db.exec(financialFoundation);

  const ids = {
    job: '80000000-0000-4000-8000-000000000001',
    config: '81000000-0000-4000-8000-000000000001',
    participation: '82000000-0000-4000-8000-000000000001',
    eventStop: '83000000-0000-4000-8000-000000000001',
    regularStop: '83000000-0000-4000-8000-000000000002',
    eventDelivery: '84000000-0000-4000-8000-000000000001',
    regularDelivery: '84000000-0000-4000-8000-000000000002',
  };

  await db.exec(`
    insert into public.event_jobs values (
      '${ids.job}', date '2026-09-01', date '2026-09-05'
    );
    insert into public.event_job_config_versions values (
      '${ids.config}', '${ids.job}', 'policy-v1'
    );
    insert into public.event_participations values (
      '${ids.participation}', '${ids.job}',
      '20000000-0000-4000-8000-000000000001',
      date '2026-09-02', date '2026-09-04', '${ids.config}', 'policy-v1'
    );
    insert into public.round_stops values
      ('${ids.eventStop}', '30000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001', 'event', '${ids.participation}'),
      ('${ids.regularStop}', '30000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002', 'regular', null);
    insert into public.delivery_events values
      ('${ids.eventDelivery}', '${ids.eventStop}'),
      ('${ids.regularDelivery}', '${ids.regularStop}');
  `);

  await assert.rejects(
    db.exec(`
      insert into public.round_stops values (
        gen_random_uuid(), '30000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002', 'event', '${ids.participation}'
      )
    `),
    /shop must match its participation shop/,
  );

  const first = await db.query(`
    select (public.get_or_create_event_settlement_context(
      '${ids.participation}', date '2026-09-03'
    )).id as id
  `);
  const second = await db.query(`
    select (public.get_or_create_event_settlement_context(
      '${ids.participation}', date '2026-09-03'
    )).id as id
  `);
  assert.equal(second.rows[0].id, first.rows[0].id);

  await assert.rejects(
    db.query(`
      select public.get_or_create_event_settlement_context(
        '${ids.participation}', date '2026-09-05'
      )
    `),
    /does not match its frozen participation/,
  );

  await assert.rejects(
    db.exec(`
      insert into public.event_settlement_contexts (
        event_participation_id, shop_id, service_date,
        config_version_id, settlement_policy_fingerprint
      ) values (
        '${ids.participation}', '20000000-0000-4000-8000-000000000002',
        date '2026-09-04', '${ids.config}', 'policy-v1'
      )
    `),
    /does not match its frozen participation/,
  );

  await assert.rejects(
    db.exec(`
      insert into public.delivery_charges (
        id, delivery_event_id, shop_id, service_date, payment_term, status,
        event_settlement_context_id
      ) values (
        gen_random_uuid(), '${ids.eventDelivery}',
        '20000000-0000-4000-8000-000000000001', date '2026-09-03',
        'credit', 'active', '${first.rows[0].id}'
      )
    `),
    /must use end-of-day settlement/,
  );

  await assert.rejects(
    db.exec(`
      insert into public.delivery_charges (
        id, delivery_event_id, shop_id, service_date, status
      ) values (
        gen_random_uuid(), '${ids.eventDelivery}',
        '20000000-0000-4000-8000-000000000001', date '2026-09-03', 'active'
      )
    `),
    /require an event settlement context/,
  );

  await db.exec(`
    insert into public.delivery_charges (
      id, delivery_event_id, shop_id, service_date, status,
      event_settlement_context_id
    ) values (
      '85000000-0000-4000-8000-000000000001', '${ids.eventDelivery}',
      '20000000-0000-4000-8000-000000000001', date '2026-09-03', 'active',
      '${first.rows[0].id}'
    );
    insert into public.delivery_charges (
      id, delivery_event_id, shop_id, service_date, status
    ) values (
      '85000000-0000-4000-8000-000000000002', '${ids.regularDelivery}',
      '20000000-0000-4000-8000-000000000002', date '2026-09-03', 'active'
    );
  `);

  await assert.rejects(
    db.exec(`
      update public.event_settlement_contexts
      set settlement_policy_fingerprint = 'changed'
      where id = '${first.rows[0].id}'
    `),
    /immutable/,
  );
  await assert.rejects(
    db.exec(`
      update public.delivery_charges set payment_term = 'credit'
      where id = '85000000-0000-4000-8000-000000000001'
    `),
    /settlement identity is immutable/,
  );
  await assert.rejects(
    db.exec(`
      update public.delivery_rounds set service_date = date '2026-09-04'
      where id = '30000000-0000-4000-8000-000000000001'
    `),
    /cannot change service date/,
  );
  await assert.rejects(
    db.exec(`
      update public.event_participations
      set shop_id = '20000000-0000-4000-8000-000000000002'
      where id = '${ids.participation}'
    `),
    /cannot change shop/,
  );
  await assert.rejects(
    db.exec(`
      update public.delivery_events set round_stop_id = '${ids.regularStop}'
      where id = '${ids.eventDelivery}'
    `),
    /cannot move to another round stop/,
  );

  const disabled = await db.query(`
    select public.is_event_ice_delivery_write_enabled('${ids.participation}') as enabled
  `);
  assert.equal(disabled.rows[0].enabled, false);
  await db.exec(`
    insert into public.event_ice_delivery_pilots (
      event_participation_id, enabled_by, expires_at
    ) values ('${ids.participation}', auth.uid(), now() + interval '1 hour')
  `);
  const pilotEnabled = await db.query(`
    select public.lock_event_ice_delivery_write_eligibility('${ids.participation}') as enabled
  `);
  assert.equal(pilotEnabled.rows[0].enabled, true);

  const settings = await db.query(`
    select schema_version, event_ice_delivery_enabled
    from public.event_delivery_feature_settings
  `);
  assert.deepEqual(settings.rows[0], {
    schema_version: 6,
    event_ice_delivery_enabled: false,
  });
});
