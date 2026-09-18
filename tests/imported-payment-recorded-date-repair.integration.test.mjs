import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0186_fix_imported_payment_recorded_dates.sql', import.meta.url),
  'utf8',
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const IMPORT_NOTE = 'นำเข้าจาก สรุปยอดขาย ศูนย์ราชการ ปี 69-3.xls แถวทดสอบ';

test('historical import repair moves only mismatched receipts and preserves snapshot immutability', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create table public.payments (
      id uuid primary key,
      recorded_by uuid not null,
      recorded_at timestamptz not null,
      status text not null
    );
    create table public.delivery_events (
      id uuid primary key,
      client_recorded_at timestamptz,
      note text
    );
    create table public.delivery_charges (
      id uuid primary key,
      delivery_event_id uuid not null references public.delivery_events(id),
      service_date date not null
    );
    create table public.payment_allocations (
      payment_id uuid not null references public.payments(id),
      charge_id uuid not null references public.delivery_charges(id)
    );
    create table public.payment_receipt_snapshots (
      payment_id uuid primary key references public.payments(id),
      receipt_data jsonb not null
    );
    create table public.audit_logs (
      actor_id uuid not null,
      entity_type text not null,
      entity_id uuid not null,
      action text not null,
      before_value jsonb,
      after_value jsonb,
      reason text
    );
    create function public.reject_snapshot_update()
    returns trigger language plpgsql as $$
    begin
      raise exception 'payment receipt snapshots are immutable';
    end;
    $$;
    create trigger payment_receipt_snapshots_immutable
      before update or delete on public.payment_receipt_snapshots
      for each row execute function public.reject_snapshot_update();

    insert into public.delivery_events values
      ('20000000-0000-4000-8000-000000000001', '2026-09-14T05:00:00Z', '${IMPORT_NOTE}'),
      ('20000000-0000-4000-8000-000000000002', '2026-09-15T05:00:00Z', '${IMPORT_NOTE}'),
      ('20000000-0000-4000-8000-000000000003', '2026-09-16T05:00:00Z', 'บันทึกตามปกติ'),
      ('20000000-0000-4000-8000-000000000004', null, '${IMPORT_NOTE}');
    insert into public.delivery_charges values
      ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '2026-09-14'),
      ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '2026-09-15'),
      ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', '2026-09-16'),
      ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004', '2026-09-17');
    insert into public.payments values
      ('40000000-0000-4000-8000-000000000001', '${USER_ID}', '2026-09-18T08:37:00Z', 'active'),
      ('40000000-0000-4000-8000-000000000002', '${USER_ID}', '2026-09-15T05:00:00Z', 'active'),
      ('40000000-0000-4000-8000-000000000003', '${USER_ID}', '2026-09-18T08:39:00Z', 'active'),
      ('40000000-0000-4000-8000-000000000004', '${USER_ID}', '2026-09-18T08:40:00Z', 'active');
    insert into public.payment_allocations values
      ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'),
      ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002'),
      ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003'),
      ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000004');
    insert into public.payment_receipt_snapshots values
      ('40000000-0000-4000-8000-000000000001', '{"recorded_at":"2026-09-18T08:37:00Z"}'),
      ('40000000-0000-4000-8000-000000000002', '{"recorded_at":"2026-09-15T05:00:00Z"}'),
      ('40000000-0000-4000-8000-000000000003', '{"recorded_at":"2026-09-18T08:39:00Z"}'),
      ('40000000-0000-4000-8000-000000000004', '{"recorded_at":"2026-09-18T08:40:00Z"}');
  `);

  await db.exec(migration);

  const payments = await db.query(`
    select id, recorded_at from public.payments order by id
  `);
  assert.deepEqual(
    payments.rows.map(({ id, recorded_at }) => [id, recorded_at.toISOString()]),
    [
      ['40000000-0000-4000-8000-000000000001', '2026-09-14T05:00:00.000Z'],
      ['40000000-0000-4000-8000-000000000002', '2026-09-15T05:00:00.000Z'],
      ['40000000-0000-4000-8000-000000000003', '2026-09-18T08:39:00.000Z'],
      ['40000000-0000-4000-8000-000000000004', '2026-09-17T08:40:00.000Z'],
    ],
  );

  const snapshots = await db.query(`
    select payment_id, receipt_data->>'recorded_at' as recorded_at
    from public.payment_receipt_snapshots order by payment_id
  `);
  assert.equal(snapshots.rows[0].recorded_at, '2026-09-14T12:00:00+07:00');
  assert.equal(snapshots.rows[1].recorded_at, '2026-09-15T05:00:00Z');
  assert.equal(snapshots.rows[2].recorded_at, '2026-09-18T08:39:00Z');
  assert.equal(snapshots.rows[3].recorded_at, '2026-09-17T15:40:00+07:00');

  const audit = await db.query(`select * from public.audit_logs`);
  assert.equal(audit.rows.length, 2);
  assert.equal(audit.rows[0].entity_id, '40000000-0000-4000-8000-000000000001');
  assert.equal(audit.rows[0].action, 'imported_payment_recorded_at_corrected');

  await assert.rejects(
    db.exec(`
      update public.payment_receipt_snapshots
      set receipt_data = '{}'::jsonb
      where payment_id = '40000000-0000-4000-8000-000000000001'
    `),
    /immutable/i,
  );
});
