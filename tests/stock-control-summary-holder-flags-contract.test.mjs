import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0057_sync_stock_control_summary_holder_flags.sql', import.meta.url),
  'utf8',
);

const SITE_ID = '10000000-0000-4000-8000-000000000001';
const TEAM_ID = '10000000-0000-4000-8000-000000000002';

test('stock-control summary refreshes holder flags from stock locations', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create table public.users (
      id uuid primary key,
      code text not null,
      display_name text not null,
      nickname text,
      avatar_path text,
      is_active boolean not null
    );
    create table public.stock_locations (
      id uuid primary key,
      code text not null,
      name text not null,
      kind text not null,
      assigned_user_id uuid references public.users(id),
      is_active boolean not null,
      holds_inventory boolean not null,
      requires_daily_count boolean not null,
      is_courier_source boolean not null
    );
    create table public.employee_work_site_assignments (
      user_id uuid not null references public.users(id),
      stock_location_id uuid not null references public.stock_locations(id)
    );
    create table public.ice_types (id uuid primary key, image_path text);
    insert into public.stock_locations values
      ('${SITE_ID}', 'SITE-A', 'A · จุดปฏิบัติงาน', 'work_site', null, true, false, false, false),
      ('${TEAM_ID}', 'TEAM-A', 'ทีม A', 'team', null, true, true, true, false);
    create function public.get_stock_control_summary_v2(
      p_round_id uuid default null,
      p_service_date date default null
    ) returns jsonb language sql stable as $$
      select jsonb_build_object(
        'is_snapshot', false,
        'locations', jsonb_build_array(
          jsonb_build_object('id', '${SITE_ID}', 'holds_inventory', true, 'balances', '[]'::jsonb),
          jsonb_build_object('id', '${TEAM_ID}', 'holds_inventory', false, 'balances', '[]'::jsonb)
        )
      )
    $$;
  `);

  await db.exec(migration);

  const result = await db.query('select public.get_stock_control_summary(null, current_date) as summary');
  const locations = result.rows[0].summary.locations;

  assert.equal(locations.find((location) => location.id === SITE_ID).holds_inventory, false);
  assert.equal(locations.find((location) => location.id === TEAM_ID).holds_inventory, true);
});
