import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const projections = migration('0129_effective_charge_projections');
const original = projections.slice(
  projections.indexOf('create or replace function public.get_credit_receivable_detail('),
  projections.indexOf('revoke all on function public.stock_balance_at('),
);
// Include the timestamp projection added by 0204 so a guard fix cannot regress it.
const definition = original.replace("'recorded_at', payment.recorded_at",
  "'recorded_at', payment.recorded_at, 'received_date_override', payment.received_date_override, 'entered_at', payment.entered_at");
const patch = migration('0208_preserve_former_credit_customer_history');
const readDefinition = async (db) => (await db.query(
  "select pg_get_functiondef('public.get_credit_receivable_detail(uuid,date)'::regprocedure) as definition",
)).rows[0].definition;

for (const [name, format] of [
  ['original formatting', (sql) => sql],
  ['multiline guard', (sql) => sql.replace(
    ") then raise exception 'The selected shop does not have a credit account'; end if;",
    ") then\n    raise exception 'The selected shop does not have a credit account';\n  end if;",
  )],
  ['tabs and CRLF', (sql) => sql.replaceAll('    ', '\t').replaceAll('\n', '\r\n')],
]) {
  test(`0208 patches and replays with ${name} while preserving the projection`, async (t) => {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(format(definition));
    const before = await readDefinition(db);
    await db.exec(patch);
    const after = await readDefinition(db);
    assert.match(after, /charge\.shop_id = p_shop_id and charge\.payment_term = 'credit'/);
    assert.equal(after.slice(after.indexOf('return jsonb_build_object(')),
      before.slice(before.indexOf('return jsonb_build_object(')));
    assert.equal(after.slice(0, after.indexOf('elsif')), before.slice(0, before.indexOf('elsif')));
    await db.exec(patch);
    assert.equal(await readDefinition(db), after);
    // Reformatting an already-patched guard must also be a no-op.
    await db.exec(after.replaceAll('\n', '\r\n'));
    const reformatted = await readDefinition(db);
    await db.exec(patch);
    assert.equal(await readDefinition(db), reformatted);
  });
}

test('0208 rejects an unknown eligibility rule without changing the function', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(definition.replace("'credit' = any(profile.allowed_payment_terms)",
    "'immediate' = any(profile.allowed_payment_terms)"));
  const before = await readDefinition(db);
  await assert.rejects(db.exec(patch), /Credit receivable eligibility guard not found/);
  assert.equal(await readDefinition(db), before);
});
