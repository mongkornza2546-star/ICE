import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0173_allow_deferred_immediate_collection.sql', import.meta.url),
  'utf8',
);

test('0173 permits an immediate delivery charge to remain unpaid for collection handoff', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create type public.payment_term as enum ('immediate', 'end_of_day', 'credit');
    create table public.delivery_events (
      id uuid primary key,
      status text not null default 'active'
    );
    create table public.delivery_charges (
      id uuid primary key,
      delivery_event_id uuid references public.delivery_events(id),
      payment_term public.payment_term not null,
      status text not null default 'active'
    );
    create table public.delivery_items (
      charge_id uuid not null references public.delivery_charges(id),
      line_total numeric not null
    );
    create table public.payments (
      id uuid primary key,
      status text not null default 'active'
    );
    create table public.payment_allocations (
      payment_id uuid not null references public.payments(id),
      charge_id uuid not null references public.delivery_charges(id),
      amount numeric not null
    );
    create function public.current_app_role()
    returns text language sql stable as $$
      select coalesce(nullif(current_setting('test.app_role', true), ''), 'admin')
    $$;
    create function public.can_collect_shop_payments()
    returns boolean language sql stable as $$
      select coalesce(nullif(current_setting('test.can_collect', true), '')::boolean, true)
    $$;
    create function public.accounting_transaction_rows(date, date)
    returns table (kind text, receivable_delta numeric)
    language sql stable as $$
      select 'SALE',
        case when charge.payment_term = 'immediate' then 0::numeric else item.line_total end
      from public.delivery_charges charge
      join public.delivery_items item on item.charge_id = charge.id
      union all
      select 'REC',
        case when payment.status = 'active' then -coalesce(receivable_allocation.amount, 0) else 0 end
      from public.payments payment
      left join lateral (
        select sum(allocation.amount)::numeric amount
        from public.payment_allocations allocation
        join public.delivery_charges charge on charge.id = allocation.charge_id
        where allocation.payment_id = payment.id and charge.payment_term <> 'immediate'
      ) receivable_allocation on true
    $$;
    create function public.get_delivery_correction_context(p_event_id uuid)
    returns jsonb
    language plpgsql stable as $$
    declare
      v_event public.delivery_events%rowtype;
      v_charge public.delivery_charges%rowtype;
      v_is_latest boolean := true;
      v_can_cancel boolean := false;
      v_blocker text := 'closed';
    begin
      select event.* into v_event from public.delivery_events event where event.id = p_event_id;
      select charge.* into v_charge from public.delivery_charges charge
      where charge.delivery_event_id = p_event_id;
  if not v_can_cancel
    and v_event.status = 'active'
    and v_is_latest
    and v_charge.payment_term = 'immediate'
    and public.current_app_role() in ('round_lead', 'admin')
    and exists (
      select 1
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = v_charge.id and payment.status = 'voided'
    )
    and not exists (
      select 1
      from public.payment_allocations allocation
      join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = v_charge.id and payment.status = 'active'
    ) then
        v_can_cancel := true;
        v_blocker := null;
      end if;
      return jsonb_build_object('can_cancel', v_can_cancel, 'blocker_reason', v_blocker);
    end;
    $$;
    create function public.require_immediate_sale_receipt()
    returns trigger
    language plpgsql
    as $$
    begin
      if exists (
        select 1
        from public.delivery_charges charge
        where charge.id = new.id
          and charge.payment_term = 'immediate'
          and charge.status = 'active'
          and not exists (
            select 1
            from public.payment_allocations allocation
            join public.payments payment on payment.id = allocation.payment_id
            where allocation.charge_id = charge.id
          )
      ) then
        raise exception 'Immediate sales must be recorded atomically with a receipt';
      end if;
      return null;
    end;
    $$;
    create constraint trigger delivery_charges_require_immediate_receipt
      after insert on public.delivery_charges
      deferrable initially deferred
      for each row execute function public.require_immediate_sale_receipt();
  `);

  await assert.rejects(
    db.query(`insert into public.delivery_charges (id, payment_term)
      values ('10000000-0000-4000-8000-000000000001', 'immediate')`),
    /atomically with a receipt/i,
  );

  await db.exec(migration);
  await db.exec(`insert into public.delivery_charges (id, payment_term)
    values ('10000000-0000-4000-8000-000000000001', 'immediate')`);

  const result = await db.query('select payment_term, status from public.delivery_charges');
  assert.deepEqual(result.rows, [{ payment_term: 'immediate', status: 'active' }]);

  await db.exec(`
    set test.app_role = 'courier';
    set test.can_collect = 'false';
  `);
  await assert.rejects(
    db.query(`insert into public.delivery_charges (id, payment_term)
      values ('10000000-0000-4000-8000-000000000002', 'immediate')`),
    /cannot start an immediate collection/i,
  );
  await db.exec(`
    set test.can_collect = 'true';
    insert into public.delivery_charges (id, payment_term)
    values ('10000000-0000-4000-8000-000000000002', 'immediate');
    insert into public.delivery_items (charge_id, line_total)
    values ('10000000-0000-4000-8000-000000000002', 30);
    insert into public.payments (id)
    values ('20000000-0000-4000-8000-000000000001');
    insert into public.payment_allocations (payment_id, charge_id, amount)
    values (
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      30
    );
  `);
  const ledger = await db.query(`
    select kind, receivable_delta
    from public.accounting_transaction_rows(current_date, current_date)
    order by kind
  `);
  assert.deepEqual(ledger.rows, [
    { kind: 'REC', receivable_delta: '-30' },
    { kind: 'SALE', receivable_delta: '30' },
  ]);

  await db.exec(`
    set test.app_role = 'admin';
    insert into public.delivery_events (id)
    values ('30000000-0000-4000-8000-000000000001');
    insert into public.delivery_charges (id, delivery_event_id, payment_term)
    values (
      '10000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000001',
      'immediate'
    );
  `);
  const correction = await db.query(`
    select public.get_delivery_correction_context(
      '30000000-0000-4000-8000-000000000001'
    ) ->> 'can_cancel' as can_cancel
  `);
  assert.deepEqual(correction.rows, [{ can_cancel: 'true' }]);
});
