import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('aggregate reconciliation keeps product formulas separate and nulls incomplete counts', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create table accounting_inputs (
      ice_type text primary key,
      factory_in numeric not null,
      sold numeric not null,
      damaged numeric not null,
      returned numeric not null,
      actual numeric,
      count_complete boolean not null,
      stale boolean not null default false
    );
    insert into accounting_inputs values
      ('tube', 420, 390, 20, 5, 4, true, false),
      ('block', 100, 20, 5, 0, null, false, false),
      ('crushed', 80, 30, 0, 0, 50, true, true);
  `);
  const result = await db.query(`
    select ice_type,
      factory_in - sold - damaged - returned as expected,
      case when count_complete and not stale then actual end as actual,
      case when count_complete and not stale
        then actual - (factory_in - sold - damaged - returned) end as variance,
      case when not count_complete then 'incomplete' when stale then 'stale' else 'complete' end status
    from accounting_inputs order by ice_type
  `);
  assert.deepEqual(result.rows.map((row) => ({
    ...row,
    expected: Number(row.expected),
    actual: row.actual == null ? null : Number(row.actual),
    variance: row.variance == null ? null : Number(row.variance),
  })), [
    { ice_type: 'block', expected: 75, actual: null, variance: null, status: 'incomplete' },
    { ice_type: 'crushed', expected: 50, actual: null, variance: null, status: 'stale' },
    { ice_type: 'tube', expected: 5, actual: 4, variance: -1, status: 'complete' },
  ]);
});

test('holder formula handles truck issue, net transfer, sale, return, and damage', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const result = await db.query(`
    with holder(opening, transfer_in, transfer_out, sold, returned, damaged, actual) as (
      values (0::numeric, 100::numeric, 10::numeric, 70::numeric, 5::numeric, 2::numeric, 12::numeric)
    )
    select opening + transfer_in - transfer_out - sold - returned - damaged expected,
      actual, actual - (opening + transfer_in - transfer_out - sold - returned - damaged) variance
    from holder
  `);
  assert.deepEqual({
    expected: Number(result.rows[0].expected),
    actual: Number(result.rows[0].actual),
    variance: Number(result.rows[0].variance),
  }, { expected: 13, actual: 12, variance: -1 });
});
