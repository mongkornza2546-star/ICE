import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migration = readFileSync(
  new URL('../supabase/migrations/0148_employee_offline_contract_v1.sql', import.meta.url),
  'utf8',
);
const fixtures = JSON.parse(
  readFileSync(new URL('../contracts/employee-offline-v1.fixtures.json', import.meta.url), 'utf8'),
);

test('PostgreSQL canonical JSON and SHA-256 match the shared TypeScript fixtures', async (t) => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create extension if not exists pgcrypto;
    create table public.shop_payment_profiles (
      allow_outstanding boolean,
      credit_suspended boolean,
      credit_due_rule text
    );
    create function public.get_delivery_pos_context(p_round_stop_id uuid)
    returns jsonb
    language plpgsql
    as $$
    declare
      v_profile public.shop_payment_profiles%rowtype;
    begin
      return jsonb_build_object(
      'allow_outstanding', v_profile.allow_outstanding,
      'credit_due_rule', v_profile.credit_due_rule,
      'credit_limit', null
      );
    end;
    $$;
  `);
  await db.exec(migration);
  await db.exec(migration);

  const projection = await db.query(
    `select pg_get_functiondef('public.get_delivery_pos_context(uuid)'::regprocedure) as definition`,
  );
  assert.match(projection.rows[0].definition, /'credit_suspended', v_profile\.credit_suspended/);

  for (const fixture of fixtures.fingerprints) {
    const result = await db.query(
      `select
        public.employee_offline_canonical_json_v1($1::jsonb) as canonical,
        public.employee_offline_fingerprint_v1($1::jsonb) as fingerprint`,
      [JSON.stringify(fixture.normalized)],
    );
    assert.equal(result.rows[0].canonical, fixture.canonical, fixture.name);
    assert.equal(result.rows[0].fingerprint, fixture.sha256, fixture.name);
  }

  await assert.rejects(
    db.query(`select public.employee_offline_canonical_json_v1('{"n": 1e-7}'::jsonb)`),
    /safe integers/,
  );
  await assert.rejects(
    db.query(`select public.employee_offline_canonical_json_v1('{"ราคา": 1}'::jsonb)`),
    /ASCII/,
  );
});
