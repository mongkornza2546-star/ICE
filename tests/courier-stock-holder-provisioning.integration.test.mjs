import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migration = readFileSync(
  new URL('../supabase/migrations/0051_provision_courier_stock_holders.sql', import.meta.url),
  'utf8',
);

const COURIER_ID = '10000000-0000-4000-8000-000000000001';
const LATER_COURIER_ID = '10000000-0000-4000-8000-000000000002';
const MISCONFIGURED_COURIER_ID = '10000000-0000-4000-8000-000000000003';
const REACTIVATED_COURIER_ID = '10000000-0000-4000-8000-000000000004';
const WORK_SITE_ID = '20000000-0000-4000-8000-000000000001';
const TRUCK_ID = '30000000-0000-4000-8000-000000000001';
const MISCONFIGURED_HOLDER_ID = '40000000-0000-4000-8000-000000000001';
const REACTIVATED_HOLDER_ID = '40000000-0000-4000-8000-000000000002';

test('assigned couriers receive one inventory-holding transfer destination', async (t) => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());

  await db.exec(`
    create extension if not exists pgcrypto;
    create role authenticated;
    create type public.app_role as enum ('courier', 'round_lead', 'admin');
    create type public.stock_location_kind as enum (
      'truck', 'team', 'small_vehicle', 'work_site', 'reserve_bin', 'front_vehicle'
    );
    create type public.stock_movement_kind as enum ('transfer');
    create table public.users (
      id uuid primary key,
      display_name text not null,
      role public.app_role not null,
      is_active boolean not null
    );
    create table public.stock_locations (
      id uuid primary key default gen_random_uuid(),
      code text not null unique,
      name text not null,
      kind public.stock_location_kind not null,
      assigned_user_id uuid references public.users(id),
      is_courier_source boolean not null default false,
      is_default_for_building boolean not null default false,
      is_active boolean not null default true,
      holds_inventory boolean not null default true,
      requires_daily_count boolean not null default false
    );
    create unique index stock_locations_one_active_employee_holding_idx
      on public.stock_locations (assigned_user_id)
      where is_active and kind in ('team', 'small_vehicle');
    create table public.employee_work_site_assignments (
      user_id uuid not null references public.users(id),
      stock_location_id uuid not null references public.stock_locations(id),
      primary key (user_id, stock_location_id)
    );
    create table public.stock_movements (
      id uuid primary key default gen_random_uuid(),
      kind public.stock_movement_kind not null,
      from_location_id uuid references public.stock_locations(id),
      to_location_id uuid references public.stock_locations(id)
    );

    insert into public.users values
      ('${COURIER_ID}', 'สมชาย ใจดี', 'courier', true),
      ('${LATER_COURIER_ID}', 'สมหญิง จันทร์', 'courier', true),
      ('${MISCONFIGURED_COURIER_ID}', 'สศักดิ์ พรม', 'courier', true),
      ('${REACTIVATED_COURIER_ID}', 'สมพร พร้อม', 'courier', true);
    insert into public.stock_locations (
      id, code, name, kind, assigned_user_id, is_active, holds_inventory, requires_daily_count
    ) values
      ('${WORK_SITE_ID}', 'SITE-A', 'A · จุดปฏิบัติงาน', 'work_site', null, true, false, false),
      ('${TRUCK_ID}', 'TRUCK', 'รถบรรทุก', 'truck', null, true, true, true),
      ('${MISCONFIGURED_HOLDER_ID}', 'TEAM-OLD', 'จุดเก่า', 'team', '${MISCONFIGURED_COURIER_ID}', true, false, false),
      (
        '${REACTIVATED_HOLDER_ID}',
        'HOLDER-' || replace('${REACTIVATED_COURIER_ID}', '-', ''),
        'จุดพักใช้',
        'team',
        '${REACTIVATED_COURIER_ID}',
        false,
        true,
        true
      );
    insert into public.employee_work_site_assignments values
      ('${COURIER_ID}', '${WORK_SITE_ID}'),
      ('${MISCONFIGURED_COURIER_ID}', '${WORK_SITE_ID}'),
      ('${REACTIVATED_COURIER_ID}', '${WORK_SITE_ID}');
  `);

  await db.exec(migration);

  let holders = await db.query(`
    select assigned_user_id, kind, holds_inventory, requires_daily_count
    from public.stock_locations
    where kind in ('team', 'small_vehicle')
    order by assigned_user_id
  `);
  assert.deepEqual(holders.rows, [
    {
      assigned_user_id: COURIER_ID,
      kind: 'team',
      holds_inventory: true,
      requires_daily_count: true,
    },
    {
      assigned_user_id: MISCONFIGURED_COURIER_ID,
      kind: 'team',
      holds_inventory: true,
      requires_daily_count: true,
    },
    {
      assigned_user_id: REACTIVATED_COURIER_ID,
      kind: 'team',
      holds_inventory: true,
      requires_daily_count: true,
    },
  ]);

  await db.query(
    `insert into public.employee_work_site_assignments values ($1, $2)`,
    [LATER_COURIER_ID, WORK_SITE_ID],
  );

  holders = await db.query(`
    select assigned_user_id
    from public.stock_locations
    where kind in ('team', 'small_vehicle')
    order by assigned_user_id
  `);
  assert.deepEqual(holders.rows, [
    { assigned_user_id: COURIER_ID },
    { assigned_user_id: LATER_COURIER_ID },
    { assigned_user_id: MISCONFIGURED_COURIER_ID },
    { assigned_user_id: REACTIVATED_COURIER_ID },
  ]);

  const laterHolder = await db.query(
    `select id from public.stock_locations where assigned_user_id = $1 and is_active`,
    [LATER_COURIER_ID],
  );
  const laterHolderId = laterHolder.rows[0].id;

  await db.query(
    `delete from public.employee_work_site_assignments where user_id = $1`,
    [LATER_COURIER_ID],
  );
  await assert.rejects(
    db.query(
      `insert into public.stock_movements (kind, from_location_id, to_location_id) values ('transfer', $1, $2)`,
      [TRUCK_ID, laterHolderId],
    ),
    /active courier with a work-site assignment/i,
  );

  await db.query(
    `insert into public.stock_movements (kind, from_location_id, to_location_id) values ('transfer', $1, $2)`,
    [laterHolderId, TRUCK_ID],
  );

  await db.query(`update public.users set is_active = false where id = $1`, [MISCONFIGURED_COURIER_ID]);
  await assert.rejects(
    db.query(
      `insert into public.stock_movements (kind, from_location_id, to_location_id) values ('transfer', $1, $2)`,
      [TRUCK_ID, MISCONFIGURED_HOLDER_ID],
    ),
    /active courier with a work-site assignment/i,
  );
});
