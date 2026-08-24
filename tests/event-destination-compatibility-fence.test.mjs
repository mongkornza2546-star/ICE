import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0157_event_destination_compatibility_fence.sql', import.meta.url),
  'utf8',
);

test('event destination migration replaces the legacy shop uniqueness with scoped indexes', () => {
  assert.match(migration, /round_stops_regular_destination_unique_idx/);
  assert.match(migration, /\(round_id, shop_id\)\s*\n\s*where destination_kind = 'regular'/);
  assert.match(migration, /round_stops_event_destination_unique_idx/);
  assert.match(migration, /\(round_id, event_participation_id\)\s*\n\s*where destination_kind = 'event'/);
  assert.match(migration, /on conflict \(round_id, shop_id\) where destination_kind = 'regular' do nothing/);
});

test('legacy read and write RPCs have an event compatibility fence', () => {
  for (const rpc of [
    'get_delivery_pos_context',
    'record_delivery',
    'record_immediate_sale',
    'get_delivery_correction_context',
    'preview_delivery_correction',
    'apply_open_delivery_correction',
    'create_closed_delivery_adjustment',
    'get_manager_delivery_events',
    'revise_delivery_event',
  ]) {
    assert.match(migration, new RegExp(rpc));
  }
  assert.match(migration, /require_regular_round_stop/);
  assert.match(migration, /require_regular_delivery_event/);
  assert.match(migration, /stop\.destination_kind = ''regular''/);
  assert.match(migration, /day_stop\.destination_kind = ''regular''/);
});

test('legacy round writers are rewritten to lock service date before the round row', () => {
  assert.match(migration, /v_lock_service_date date/);
  assert.match(migration, /record_delivery does not contain the expected pre-lock round lookup/);
  assert.match(migration, /close_delivery_round does not contain the expected pre-lock round lookup/);

  const syncDefinition = migration.match(
    /create or replace function public\.sync_daily_round_active_shops[\s\S]*?\n\$\$;/,
  )?.[0];
  assert.ok(syncDefinition);
  const serviceDateLockAt = syncDefinition.indexOf(
    'pg_advisory_xact_lock(hashtextextended(v_lock_service_date::text, 0))',
  );
  const roundRowLockAt = syncDefinition.indexOf('for update;');
  assert.ok(serviceDateLockAt >= 0);
  assert.ok(roundRowLockAt > serviceDateLockAt);
});

test('migration applies and legacy RPCs reject an event destination', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create type public.shop_round_status as enum ('pending', 'delivered');
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create type public.payment_method as enum ('cash', 'bank_transfer', 'qr');
    create type public.delivery_round_status as enum ('open', 'closed');
    create type public.shop_status as enum ('active', 'inactive');

    create function auth.uid() returns uuid language sql stable
    as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$ select 'admin'::text $$;
    create function public.is_round_member(uuid) returns boolean language sql stable as $$ select true $$;

    create table public.users (id uuid primary key);
    create table public.buildings (id uuid primary key, name text not null, sort_order integer not null, is_active boolean not null);
    create table public.building_zones (id uuid primary key, sort_order integer not null);
    create table public.shops (
      id uuid primary key, code text not null, name text not null,
      building_id uuid not null, zone_id uuid not null, floor_or_zone text not null,
      delivery_sequence integer, status public.shop_status not null, stock_location_id uuid
    );
    create table public.delivery_rounds (
      id uuid primary key, service_date date not null, round_type text not null,
      status public.delivery_round_status not null, cancelled_at timestamptz
    );
    create table public.round_stops (
      id uuid primary key default gen_random_uuid(), round_id uuid not null, shop_id uuid not null,
      shop_code_snapshot text not null, shop_name_snapshot text not null,
      building_id_snapshot uuid not null, building_name_snapshot text not null,
      floor_or_zone_snapshot text not null, sequence_no integer not null,
      status public.shop_round_status not null default 'pending', updated_by uuid not null,
      unique (round_id, shop_id), unique (round_id, sequence_no)
    );
    create table public.delivery_events (
      id uuid primary key, round_stop_id uuid not null, quantity integer not null default 0,
      status text not null default 'active'
    );

    create function public.get_delivery_pos_context(p_round_stop_id uuid) returns jsonb language plpgsql as $$
    begin
      return '{}'::jsonb;
    end;
    $$;
    create function public.record_delivery(p_round_stop_id uuid, p_items jsonb, p_status public.shop_round_status, p_note text, p_recorded_at timestamptz, p_key uuid, p_term public.payment_term, p_approval uuid) returns jsonb language plpgsql as $$
    declare
      v_round_id uuid;
      v_round_status public.delivery_round_status;
      v_service_date date;
      v_shop_id uuid;
      v_shop_source_location_id uuid;
    begin
      perform pg_advisory_xact_lock(hashtextextended(p_key::text, 0));
      select stop.round_id, round.status, round.service_date, stop.shop_id, shop.stock_location_id
      into v_round_id, v_round_status, v_service_date, v_shop_id, v_shop_source_location_id
      from public.round_stops stop
      join public.delivery_rounds round on round.id = stop.round_id
      join public.shops shop on shop.id = stop.shop_id
      where stop.id = p_round_stop_id
      for update of round;
      if v_round_id is null then
        raise exception 'The selected shop is not in a delivery round';
      end if;
      perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));
      return '{}'::jsonb;
    end;
    $$;
    create function public.record_immediate_sale(p_round_stop_id uuid, p_items jsonb, p_note text, p_recorded_at timestamptz, p_method public.payment_method, p_amount numeric, p_reference text, p_evidence text, p_total numeric, p_key uuid) returns jsonb language plpgsql as $$
    begin
      return '{}'::jsonb;
    end;
    $$;
    create function public.get_delivery_correction_context(p_event_id uuid) returns jsonb language plpgsql as $$
    begin
      return '{}'::jsonb;
    end;
    $$;
    create function public.preview_delivery_correction(p_event_id uuid, p_action text, p_items jsonb, p_status public.shop_round_status) returns jsonb language plpgsql as $$
    begin
      return '{}'::jsonb;
    end;
    $$;
    create function public.apply_open_delivery_correction(p_event_id uuid, p_action text, p_items jsonb, p_status public.shop_round_status, p_note text, p_reason text, p_key uuid, p_approval uuid) returns jsonb language plpgsql as $$
    begin
      return '{}'::jsonb;
    end;
    $$;
    create function public.create_closed_delivery_adjustment(p_event_id uuid, p_items jsonb, p_reason text, p_key uuid) returns jsonb language plpgsql as $$
    begin
      return '{}'::jsonb;
    end;
    $$;
    create function public.get_manager_delivery_events(p_round_id uuid) returns jsonb language plpgsql as $$
    declare
      v_result jsonb;
    begin
      select jsonb_build_object('events', coalesce(jsonb_agg(event.id order by event.id), '[]'::jsonb))
      into v_result
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      where stop.round_id = p_round_id and event.status = 'active';
      return v_result;
    end;
    $$;
    create function public.revise_delivery_event(p_event_id uuid, p_action text, p_items jsonb, p_status public.shop_round_status, p_note text, p_reason text, p_key uuid, p_approval uuid) returns jsonb language plpgsql as $$
    begin
      return '{}'::jsonb;
    end;
    $$;
    create function public.close_delivery_round(p_round_id uuid, p_counts jsonb) returns jsonb language plpgsql as $$
    declare
      v_status public.delivery_round_status;
      v_service_date date;
    begin
      select status, service_date into v_status, v_service_date
      from public.delivery_rounds
      where id = p_round_id
      for update;
      if v_status is null then
        raise exception 'The selected delivery round does not exist';
      end if;
      perform pg_advisory_xact_lock(hashtextextended(v_service_date::text, 0));
      return '{}'::jsonb;
    end;
    $$;
    create function public.get_round_shop_cards(p_round_id uuid, p_building_id uuid)
    returns table (round_stop_id uuid, shop_id uuid, today_history jsonb, today_totals jsonb)
    language plpgsql as $$
      declare v_service_date date;
      begin
        select service_date into v_service_date from public.delivery_rounds where id = p_round_id;
        return query
        with daily_events as (
          select day_stop.shop_id, event.id
          from public.round_stops day_stop
          join public.delivery_rounds day_round on day_round.id = day_stop.round_id
          join public.delivery_events event on event.round_stop_id = day_stop.id
          where day_round.service_date = v_service_date
        ), daily_history as (
          select daily_events.shop_id, jsonb_agg(daily_events.id order by daily_events.id) as history
          from daily_events group by daily_events.shop_id
        ), daily_item_totals as (
          select day_stop.shop_id, sum(event.quantity) as quantity
          from public.round_stops day_stop
          join public.delivery_rounds day_round on day_round.id = day_stop.round_id
          join public.delivery_events event on event.round_stop_id = day_stop.id
          where day_round.service_date = v_service_date
          group by day_stop.shop_id
        )
        select stop.id, stop.shop_id,
          coalesce(history.history, '[]'::jsonb),
          jsonb_build_object('quantity', coalesce(totals.quantity, 0))
        from public.round_stops stop
        left join daily_history history on history.shop_id = stop.shop_id
        left join daily_item_totals totals on totals.shop_id = stop.shop_id
        where stop.round_id = p_round_id
          and (p_building_id is null or stop.building_id_snapshot = p_building_id);
      end;
    $$;
  `.replace(/^ {4}/gm, ''));

  await db.exec(migration);

  await db.exec(`
    insert into public.buildings values (
      '20000000-0000-4000-8000-000000000001', 'Building', 1, true
    );
    insert into public.building_zones values (
      '20000000-0000-4000-8000-000000000002', 1
    );
    insert into public.shops (
      id, code, name, building_id, zone_id, floor_or_zone, delivery_sequence, status
    ) values
      (
        '30000000-0000-4000-8000-000000000001', 'S001', 'Regular shop',
        '20000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002', 'A1', 1, 'active'
      ),
      (
        '30000000-0000-4000-8000-000000000002', 'S002', 'Synced shop',
        '20000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002', 'A2', 2, 'active'
      );
    insert into public.delivery_rounds values (
      '40000000-0000-4000-8000-000000000002', date '2026-08-24', 'daily', 'open', null
    );
    insert into public.round_stops (
      id, round_id, shop_id, shop_code_snapshot, shop_name_snapshot,
      building_id_snapshot, building_name_snapshot, floor_or_zone_snapshot,
      sequence_no, updated_by, destination_kind, event_participation_id
    ) values
      (
        '40000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000001', 'S001', 'Regular shop',
        '20000000-0000-4000-8000-000000000001', 'Building', 'A1', 1,
        '10000000-0000-4000-8000-000000000001', 'regular', null
      ),
      (
        '40000000-0000-4000-8000-000000000006',
        '40000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000001', 'S001', 'Regular shop at event',
        '20000000-0000-4000-8000-000000000001', 'Event', 'Booth 1', 2,
        '10000000-0000-4000-8000-000000000001', 'event',
        '40000000-0000-4000-8000-000000000005'
      );
    insert into public.delivery_events (id, round_stop_id, quantity) values
      ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 2),
      ('50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000006', 9);
  `);

  for (const query of [
    `select public.get_delivery_pos_context('40000000-0000-4000-8000-000000000006')`,
    `select public.record_delivery('40000000-0000-4000-8000-000000000006', '[]', 'delivered', null, now(), '60000000-0000-4000-8000-000000000001', 'end_of_day', null)`,
    `select public.record_immediate_sale('40000000-0000-4000-8000-000000000006', '[]', null, now(), 'cash', 0, null, null, 0, '60000000-0000-4000-8000-000000000002')`,
  ]) {
    await assert.rejects(db.query(query), /Event destinations require the event delivery workflow/);
  }

  for (const query of [
    `select public.get_delivery_correction_context('50000000-0000-4000-8000-000000000002')`,
    `select public.preview_delivery_correction('50000000-0000-4000-8000-000000000002', 'correct', '[]', 'delivered')`,
    `select public.apply_open_delivery_correction('50000000-0000-4000-8000-000000000002', 'correct', '[]', 'delivered', null, 'reason', '60000000-0000-4000-8000-000000000003', null)`,
    `select public.create_closed_delivery_adjustment('50000000-0000-4000-8000-000000000002', '[]', 'reason', '60000000-0000-4000-8000-000000000004')`,
    `select public.revise_delivery_event('50000000-0000-4000-8000-000000000002', 'correct', '[]', 'delivered', null, 'reason', '60000000-0000-4000-8000-000000000006', null)`,
  ]) {
    await assert.rejects(db.query(query), /Event deliveries require the event delivery workflow/);
  }

  await db.query(`select public.get_delivery_pos_context('40000000-0000-4000-8000-000000000001')`);
  await db.query(`select public.record_delivery('40000000-0000-4000-8000-000000000001', '[]', 'delivered', null, now(), '60000000-0000-4000-8000-000000000005', 'end_of_day', null)`);
  await db.query(`select public.get_delivery_correction_context('50000000-0000-4000-8000-000000000001')`);
  await db.query(`select public.revise_delivery_event('50000000-0000-4000-8000-000000000001', 'correct', '[]', 'delivered', null, 'reason', '60000000-0000-4000-8000-000000000007', null)`);

  const managerEvents = (await db.query(`
    select public.get_manager_delivery_events(
      '40000000-0000-4000-8000-000000000002'
    ) as result
  `)).rows[0].result;
  assert.deepEqual(managerEvents.events, ['50000000-0000-4000-8000-000000000001']);

  const cards = await db.query(`
    select * from public.get_round_shop_cards(
      '40000000-0000-4000-8000-000000000002', null
    ) order by round_stop_id
  `);
  assert.equal(cards.rows.length, 1);
  assert.equal(cards.rows[0].round_stop_id, '40000000-0000-4000-8000-000000000001');
  assert.deepEqual(cards.rows[0].today_history, ['50000000-0000-4000-8000-000000000001']);
  assert.deepEqual(cards.rows[0].today_totals, { quantity: 2 });

  assert.equal(
    (await db.query(`select public.sync_daily_round_active_shops('40000000-0000-4000-8000-000000000002') as added`)).rows[0].added,
    1,
  );
  const synced = await db.query(`
    select destination_kind from public.round_stops
    where round_id = '40000000-0000-4000-8000-000000000002'
      and shop_id = '30000000-0000-4000-8000-000000000002'
  `);
  assert.deepEqual(synced.rows, [{ destination_kind: 'regular' }]);

  for (const signature of [
    'public.sync_daily_round_active_shops(uuid)',
    'public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)',
    'public.close_delivery_round(uuid,jsonb)',
  ]) {
    const definition = (await db.query(
      `select pg_get_functiondef($1::regprocedure) as definition`,
      [signature],
    )).rows[0].definition.toLowerCase();
    const serviceDateLockAt = definition.indexOf(
      'pg_advisory_xact_lock(hashtextextended(v_lock_service_date::text, 0))',
    );
    const roundRowLockAt = definition.indexOf('for update');
    assert.ok(serviceDateLockAt >= 0, `${signature} must acquire the service-date lock`);
    assert.ok(roundRowLockAt > serviceDateLockAt, `${signature} must lock the round row second`);
  }
});
