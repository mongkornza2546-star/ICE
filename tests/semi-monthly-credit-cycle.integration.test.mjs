import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const enumMigration = readFileSync(
  new URL('../supabase/migrations/0151_add_semi_monthly_credit_due_rule.sql', import.meta.url),
  'utf8',
);
const cycleMigration = readFileSync(
  new URL('../supabase/migrations/0152_semi_monthly_credit_collection_cycles.sql', import.meta.url),
  'utf8',
);

const SHOP_ID = '10000000-0000-4000-8000-000000000001';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create type public.credit_due_rule as enum ('net_days', 'weekly', 'end_of_month');

    create table public.shop_payment_profiles (
      id uuid primary key default gen_random_uuid(),
      shop_id uuid not null unique,
      allowed_payment_terms public.payment_term[] not null,
      allow_outstanding boolean not null,
      credit_due_rule public.credit_due_rule,
      credit_days integer,
      credit_collection_weekday smallint,
      credit_limit numeric(12,2),
      constraint shop_payment_profiles_credit_collection_cycle_check check (
        case
          when 'credit' = any(allowed_payment_terms) then
            cardinality(allowed_payment_terms) = 1
            and allow_outstanding
            and credit_due_rule is not null
            and (
              (credit_due_rule = 'net_days' and credit_days is not null
                and credit_days > 0 and credit_collection_weekday is null)
              or (credit_due_rule = 'weekly' and credit_days is null
                and credit_collection_weekday between 1 and 7)
              or (credit_due_rule = 'end_of_month' and credit_days is null
                and credit_collection_weekday is null)
            )
          else
            credit_due_rule is null and credit_days is null
            and credit_collection_weekday is null and credit_limit is null
        end
      )
    );
    create table public.collection_runs (
      service_date date not null,
      status text not null
    );

    create function public.update_credit_account_settings(
      p_shop_id uuid,
      p_changes jsonb
    )
    returns jsonb
    language plpgsql
    as $$
    declare
      v_rule public.credit_due_rule;
      v_days integer;
      v_weekday smallint;
    begin
      v_rule := (p_changes->>'credit_due_rule')::public.credit_due_rule;
      v_days := nullif(p_changes->>'credit_days', '')::integer;
      v_weekday := nullif(p_changes->>'credit_collection_weekday', '')::smallint;

      if not (
        (v_rule = 'net_days' and v_days is not null and v_days > 0 and v_weekday is null)
        or (v_rule = 'weekly' and v_days is null and v_weekday between 1 and 7)
        or (v_rule = 'end_of_month' and v_days is null and v_weekday is null)
      ) then
        raise exception 'The credit collection cycle is invalid';
      end if;

      update public.shop_payment_profiles
      set credit_due_rule = v_rule,
          credit_days = v_days,
          credit_collection_weekday = v_weekday
      where shop_id = p_shop_id;

      return jsonb_build_object(
        'credit_due_rule', v_rule,
        'credit_days', v_days,
        'credit_collection_weekday', v_weekday
      );
    end;
    $$;

    create function public.get_accounting_shop_daily_matrix(
      p_from_date date,
      p_to_date date,
      p_shop_ids uuid[]
    )
    returns jsonb
    language plpgsql
    as $$
    declare
      v_result jsonb;
    begin
      select jsonb_build_object(
        'payment_condition', case
          when profile.credit_due_rule = 'weekly' then
            'เก็บทุกวัน' || (array['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'])[profile.credit_collection_weekday]
          when profile.credit_due_rule = 'end_of_month' then 'เก็บสิ้นเดือน'
          when profile.credit_due_rule = 'net_days' then 'เครดิต ' || profile.credit_days || ' วัน'
          else 'เครดิต'
        end
      ) into v_result
      from public.shop_payment_profiles profile
      where profile.shop_id = any(p_shop_ids)
      limit 1;

      return coalesce(v_result, '{}'::jsonb);
    end;
    $$;
  `);

  await db.exec(enumMigration);
  await db.exec(cycleMigration);
  await db.exec(`
    insert into public.shop_payment_profiles (
      shop_id, allowed_payment_terms, allow_outstanding, credit_due_rule
    ) values (
      '${SHOP_ID}', array['credit']::public.payment_term[], true, 'end_of_month'
    );
  `);
  return db;
}

async function setSemiMonthly(db) {
  return db.query(`
    select public.update_credit_account_settings(
      '${SHOP_ID}',
      '{"credit_due_rule":"semi_monthly","credit_days":null,"credit_collection_weekday":null}'::jsonb
    ) as result
  `);
}

test('the complete migrations install the enum, constraint, RPC rewrite, and accounting rewrite', async (t) => {
  const db = await createDatabase(t);
  const update = await setSemiMonthly(db);
  assert.equal(update.rows[0].result.credit_due_rule, 'semi_monthly');

  const profile = await db.query(`
    select credit_due_rule::text, credit_days, credit_collection_weekday
    from public.shop_payment_profiles where shop_id = '${SHOP_ID}'
  `);
  assert.deepEqual(profile.rows[0], {
    credit_due_rule: 'semi_monthly',
    credit_days: null,
    credit_collection_weekday: null,
  });

  const accounting = await db.query(`
    select public.get_accounting_shop_daily_matrix(
      '2026-08-01', '2026-08-31', array['${SHOP_ID}']::uuid[]
    ) as result
  `);
  assert.equal(accounting.rows[0].result.payment_condition, 'เก็บวันที่ 15 และสิ้นเดือน');

  await assert.rejects(
    db.exec(`
      update public.shop_payment_profiles
      set credit_days = 15
      where shop_id = '${SHOP_ID}'
    `),
    /shop_payment_profiles_credit_collection_cycle_check/,
  );
});

test('semi-monthly credit uses the 15th for deliveries from day 1 through day 15', async (t) => {
  const db = await createDatabase(t);
  await setSemiMonthly(db);
  for (const serviceDate of ['2026-08-01', '2026-08-14', '2026-08-15']) {
    const result = await db.query(
      `select public.resolve_credit_due_date('${SHOP_ID}', '${serviceDate}')::text as due_date`,
    );
    assert.equal(result.rows[0].due_date, '2026-08-15');
  }
});

test('semi-monthly credit uses the actual month end for deliveries from day 16 onward', async (t) => {
  const scenarios = [
    ['2026-08-16', '2026-08-31'],
    ['2026-04-30', '2026-04-30'],
    ['2026-02-28', '2026-02-28'],
    ['2028-02-29', '2028-02-29'],
  ];
  const db = await createDatabase(t);
  await setSemiMonthly(db);
  for (const [serviceDate, expectedDueDate] of scenarios) {
    const result = await db.query(
      `select public.resolve_credit_due_date('${SHOP_ID}', '${serviceDate}')::text as due_date`,
    );
    assert.equal(result.rows[0].due_date, expectedDueDate);
  }
});

test('a closed cutoff advances to the next half-month cutoff', async (t) => {
  const db = await createDatabase(t);
  await setSemiMonthly(db);
  await db.exec(`insert into public.collection_runs values ('2026-08-15', 'closed')`);
  const afterFirstHalf = await db.query(
    `select public.resolve_credit_due_date('${SHOP_ID}', '2026-08-10')::text as due_date`,
  );
  assert.equal(afterFirstHalf.rows[0].due_date, '2026-08-31');

  await db.exec(`insert into public.collection_runs values ('2026-08-31', 'closed')`);
  const afterMonthEnd = await db.query(
    `select public.resolve_credit_due_date('${SHOP_ID}', '2026-08-20')::text as due_date`,
  );
  assert.equal(afterMonthEnd.rows[0].due_date, '2026-09-15');
});
