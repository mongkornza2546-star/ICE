import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0054_stock_audit_count_history.sql', import.meta.url),
  'utf8',
);

test('stock count audit history is role-protected, stable, and paginated', () => {
  assert.match(migration, /current_app_role\(\) not in \('admin', 'round_lead'\)/);
  assert.match(migration, /where snapshot\.service_date = p_service_date/);
  assert.match(migration, /order by snapshot\.counted_at desc, snapshot\.id desc/);
  assert.match(migration, /limit p_limit\s+offset p_offset/);
  assert.match(migration, /'total_count'[\s\S]*count\(\*\)::integer/);
  assert.match(
    migration,
    /grant execute on function public\.get_location_count_history_v2\(date, integer, integer\) to authenticated/,
  );
});

test('stock count audit history returns the requested page and the complete total', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role authenticated;
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$ select 'admin'::text $$;
    create table public.users (id uuid primary key, display_name text not null);
    create table public.stock_locations (id uuid primary key, name text not null);
    create table public.ice_types (id uuid primary key, code text not null, name text not null, unit text not null);
    create table public.stock_count_snapshots (
      id uuid primary key,
      service_date date not null,
      location_id uuid not null references public.stock_locations(id),
      note text,
      counted_by uuid not null references public.users(id),
      counted_at timestamptz not null
    );
    create table public.stock_count_snapshot_items (
      snapshot_id uuid not null references public.stock_count_snapshots(id),
      ice_type_id uuid not null references public.ice_types(id),
      system_quantity integer not null,
      actual_quantity integer not null,
      variance_quantity integer not null
    );
    insert into public.users values ('10000000-0000-4000-8000-000000000001', 'หัวหน้าทดสอบ');
    insert into public.stock_locations values ('20000000-0000-4000-8000-000000000001', 'จุด A');
    insert into public.ice_types values ('30000000-0000-4000-8000-000000000001', 'ICE', 'หลอดเล็ก', 'ถุง');
    insert into public.stock_count_snapshots values
      ('40000000-0000-4000-8000-000000000001', '2026-07-20', '20000000-0000-4000-8000-000000000001', null, '10000000-0000-4000-8000-000000000001', '2026-07-20T17:00:00+07:00'),
      ('40000000-0000-4000-8000-000000000002', '2026-07-20', '20000000-0000-4000-8000-000000000001', null, '10000000-0000-4000-8000-000000000001', '2026-07-20T18:00:00+07:00');
    insert into public.stock_count_snapshot_items values
      ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 5, 4, -1),
      ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 4, 4, 0);
  `);
  await db.exec(migration);

  const result = await db.query(`
    select public.get_location_count_history_v2('2026-07-20', 1, 1) as history
  `);

  assert.equal(result.rows[0].history.total_count, 2);
  assert.equal(result.rows[0].history.snapshots.length, 1);
  assert.equal(result.rows[0].history.snapshots[0].id, '40000000-0000-4000-8000-000000000001');
  assert.equal(result.rows[0].history.snapshots[0].items[0].variance_quantity, -1);
});
