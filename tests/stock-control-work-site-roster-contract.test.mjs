import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0046_stock_control_work_site_roster.sql', import.meta.url),
  'utf8',
);

const EMPLOYEE_ID = '10000000-0000-4000-8000-000000000001';
const SITE_ID = '20000000-0000-4000-8000-000000000001';
const TEAM_ID = '20000000-0000-4000-8000-000000000002';

test('stock summary links the holder employee to their work sites and keeps snapshots immutable', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create table public.users (
      id uuid primary key,
      code text not null,
      display_name text not null,
      is_active boolean not null
    );
    create table public.stock_locations (
      id uuid primary key,
      code text not null,
      name text not null,
      kind text not null,
      assigned_user_id uuid references public.users(id),
      is_active boolean not null,
      holds_inventory boolean not null
    );
    create table public.employee_work_site_assignments (
      user_id uuid not null references public.users(id),
      stock_location_id uuid not null references public.stock_locations(id)
    );
    create function public.get_stock_control_summary(
      p_round_id uuid default null,
      p_service_date date default null
    ) returns jsonb language sql stable as $$
      select jsonb_build_object(
        'is_snapshot', p_round_id is not null,
        'locations', jsonb_build_array(
          jsonb_build_object('id', '${SITE_ID}', 'kind', 'work_site'),
          jsonb_build_object('id', '${TEAM_ID}', 'kind', 'team')
        )
      )
    $$;
    insert into public.users values ('${EMPLOYEE_ID}', 'EMP-1', 'สมชาย ใจดี', true);
    insert into public.stock_locations values
      ('${SITE_ID}', 'SITE-A', 'A · จุดปฏิบัติงาน', 'work_site', null, true, false),
      ('${TEAM_ID}', 'TEAM-1', 'รถเข็นสมชาย', 'team', '${EMPLOYEE_ID}', true, true);
    insert into public.employee_work_site_assignments values ('${EMPLOYEE_ID}', '${SITE_ID}');
  `);

  await db.exec(migration);

  const liveResult = await db.query(`select public.get_stock_control_summary(null, current_date) as summary`);
  const liveLocations = liveResult.rows[0].summary.locations;
  const site = liveLocations.find((location) => location.id === SITE_ID);
  const team = liveLocations.find((location) => location.id === TEAM_ID);

  assert.deepEqual(site.assigned_employees, [{ id: EMPLOYEE_ID, code: 'EMP-1', display_name: 'สมชาย ใจดี' }]);
  assert.deepEqual(team.assigned_employee, { id: EMPLOYEE_ID, code: 'EMP-1', display_name: 'สมชาย ใจดี' });
  assert.deepEqual(team.assigned_work_sites, [{ id: SITE_ID, code: 'SITE-A', name: 'A · จุดปฏิบัติงาน' }]);

  const holderState = await db.query(`select holds_inventory from public.stock_locations where id = $1`, [SITE_ID]);
  assert.equal(holderState.rows[0].holds_inventory, false);

  const snapshotResult = await db.query(
    `select public.get_stock_control_summary('30000000-0000-4000-8000-000000000001', current_date) as summary`,
  );
  for (const location of snapshotResult.rows[0].summary.locations) {
    assert.equal(location.assigned_employee, null);
    assert.deepEqual(location.assigned_work_sites, []);
    assert.deepEqual(location.assigned_employees, []);
  }
});
