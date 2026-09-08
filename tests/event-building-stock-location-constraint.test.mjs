import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

function migration(name) {
  return readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
}

test('event-building provisioning creates a report-only work-site location', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create type public.stock_location_kind as enum ('work_site');
    create table public.buildings (
      id uuid primary key default gen_random_uuid(),
      code text unique not null,
      name text not null
    );
    create table public.stock_locations (
      id uuid primary key default gen_random_uuid(),
      code text unique not null,
      name text not null,
      kind public.stock_location_kind not null,
      building_id uuid references public.buildings(id),
      is_active boolean not null default true,
      is_default_for_building boolean not null default false,
      holds_inventory boolean not null default true,
      requires_daily_count boolean not null default false,
      constraint stock_locations_work_site_report_only_check
        check (kind <> 'work_site' or not holds_inventory)
    );
  `);
  await db.exec(migration('0022_restore_building_default_stock_locations'));
  await db.exec(migration('0177_fix_event_building_report_only_stock_location'));

  await db.exec("insert into public.buildings(code, name) values ('EVENT-66B12FB6-0E47-4D1F-97CA-A1EC3B212990', 'ตึก B')");
  assert.deepEqual(
    (await db.query('select kind, holds_inventory, requires_daily_count from public.stock_locations')).rows,
    [{ kind: 'work_site', holds_inventory: false, requires_daily_count: false }],
  );
});
