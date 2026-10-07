import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../supabase/migrations/0194_delivery_slips_cancel_only.sql', import.meta.url), 'utf8');
const id = '10000000-0000-4000-8000-000000000001';

async function createDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create type public.shop_round_status as enum ('pending', 'delivered', 'issue');
    create function auth.uid() returns uuid language sql stable as $$ select '${id}'::uuid $$;
    create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
    create function public.current_app_role() returns text language sql stable as $$ select coalesce(nullif(current_setting('test.role', true), ''), 'courier') $$;
    create function public.require_regular_delivery_event(uuid) returns void language plpgsql as $$ begin end $$;
    create function public.effective_delivery_charge_amount(uuid) returns numeric language sql stable as $$ select 60::numeric $$;
    create function public.resolve_delivery_price(uuid,uuid,date) returns table(unit_price numeric) language sql stable as $$ select 60::numeric $$;
    create table public.delivery_events(id uuid, round_stop_id uuid, recorded_at timestamptz, recorded_by uuid, status text, note text);
    create table public.round_stops(id uuid, round_id uuid, shop_id uuid, shop_name_snapshot text);
    create table public.delivery_rounds(id uuid, service_date date, status text);
    create table public.delivery_charges(id uuid, delivery_event_id uuid, charge_number text, payment_term text, due_date date, original_amount numeric);
    create table public.payments(id uuid, status text);
    create table public.payment_allocations(charge_id uuid, payment_id uuid, amount numeric);
    create table public.daily_stock_closures(service_date date, status text);
    create table public.daily_aggregate_stock_closures(service_date date, status text);
    create table public.delivery_items(delivery_event_id uuid, ice_type_id uuid, quantity numeric, unit_price numeric);
    create table public.ice_types(id uuid, code text, name text, unit text, is_active boolean);
    create table public.delivery_charge_adjustments(charge_id uuid, idempotency_key uuid, status text);
    create table public.delivery_adjustment_items(adjustment_id uuid, ice_type_id uuid, quantity_delta numeric);
    create function public.revise_delivery_event(
      p_event_id uuid, p_action text, p_items jsonb, p_stop_status public.shop_round_status,
      p_note text, p_reason text, p_idempotency_key uuid, p_approval_id uuid default null
    ) returns jsonb language plpgsql as $$
    begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_action not in ('cancel', 'correct') then
    raise exception 'The revision action must be cancel or correct';
  end if;
  return jsonb_build_object('action', p_action);
    end;
    $$;
    create function public.get_event_delivery_correction_context(p_event_id uuid)
    returns jsonb language plpgsql stable as $$
    begin
      return public.get_delivery_correction_context(p_event_id);
    end;
    $$;
    create function public.get_event_delivery_cards(uuid, uuid, text)
    returns jsonb language plpgsql stable as $$
    begin
      return (select jsonb_agg(jsonb_build_object(
          'delivery_event_id', delivery.id,
          'recorded_at', delivery.recorded_at,
          'items', '[]'::jsonb
        )) from public.delivery_events delivery);
    end;
    $$;
    insert into public.delivery_rounds values ('${id}', (now() at time zone 'Asia/Bangkok')::date, 'open');
    insert into public.round_stops values ('${id}', '${id}', '${id}', 'ร้านทดสอบ');
    insert into public.delivery_events values ('${id}', '${id}', now(), '${id}', 'active', null);
    insert into public.delivery_charges values ('${id}', '${id}', 'INV-1', 'end_of_day', current_date, 60);
    insert into public.ice_types values ('${id}', 'ICE', 'หลอดเล็ก', 'ถุง', true);
    insert into public.delivery_items values ('${id}', '${id}', 1, 60);
  `);
  await db.exec(migration);
  await db.exec(readFileSync(new URL('../supabase/migrations/0210_block_paid_delivery_cancellation.sql', import.meta.url), 'utf8'));
  return db;
}

test('cancellation policy permits own unpaid deliveries and rejects edits and protected deliveries', async (t) => {
  const db = await createDatabase(t);
  const context = async () => (await db.query(`select public.get_delivery_correction_context('${id}') as data`)).rows[0].data;
  const preview = async (action = 'cancel') => (await db.query(`select public.preview_delivery_correction('${id}', $1, '[]', 'delivered') as data`, [action])).rows[0].data;
  assert.equal((await context()).can_cancel, true);
  assert.equal((await context()).can_correct, false);
  const result = await preview();
  assert.equal(result.new_amount, 0);
  assert.equal(result.stock_deltas[0].quantity_delta, 1);
  await assert.rejects(preview('correct'), /only be cancelled/);
  await assert.rejects(db.query(`select public.revise_delivery_event('${id}', 'correct', '[]', 'delivered', null, 'test', '${id}', null)`), /only be cancelled/);
  assert.equal((await db.query(`select public.revise_delivery_event('${id}', 'cancel', '[]', 'delivered', null, 'test', '${id}', null) as data`)).rows[0].data.action, 'cancel');
  assert.equal((await db.query(`select public.get_event_delivery_cards(null, null, null) as data`)).rows[0].data[0].can_cancel, true);
  await assert.rejects(db.query(`select public.apply_open_event_delivery_correction('${id}', 'correct', '[]', 'delivered', null, 'test', '${id}', null)`), /only be cancelled/);
  await assert.rejects(db.query(`select public.create_closed_delivery_adjustment('${id}', '[]', 'test', '${id}')`), /cannot be edited/);

  await db.exec(`update public.delivery_events set recorded_by = '20000000-0000-4000-8000-000000000001'`);
  assert.equal((await context()).can_cancel, false);
  assert.equal((await db.query(`select public.get_event_delivery_cards(null, null, null) as data`)).rows[0].data[0].can_cancel, false);
  await assert.rejects(preview(), /ตนเอง/);
  await db.exec(`update public.delivery_events set recorded_by = '${id}'; update public.delivery_rounds set service_date = current_date - 2`);
  assert.equal((await context()).can_cancel, false);
  await db.exec(`update public.delivery_rounds set service_date = (now() at time zone 'Asia/Bangkok')::date, status = 'closed'`);
  assert.equal((await context()).can_cancel, false);
  await db.exec(`update public.delivery_rounds set status = 'open'; insert into public.daily_stock_closures select service_date, 'closed' from public.delivery_rounds`);
  assert.equal((await context()).can_cancel, false);
  await db.exec(`delete from public.daily_stock_closures; insert into public.payments values ('${id}', 'active'); insert into public.payment_allocations values ('${id}', '${id}', 60)`);
  assert.equal((await context()).can_cancel, false);
  await assert.rejects(preview(), /รับชำระแล้ว/);
  await db.exec(`set test.role = 'admin'`);
  assert.equal((await context()).can_cancel, false, 'paid bills must be protected for admins too');
  await assert.rejects(preview(), /รับชำระแล้ว/);
  await db.exec(`update public.delivery_rounds set status = 'closed'; update public.delivery_charges set payment_term = 'immediate'`);
  assert.equal((await context()).can_cancel, false);
  await db.exec(`update public.payments set status = 'voided'`);
  assert.equal((await context()).can_cancel, true);
  await db.exec(`update public.delivery_events set status = 'cancelled'`);
  assert.equal((await context()).can_cancel, false);
});

// Exercise the real write RPC: the cancellation must fail before it can detach
// receipt allocations, cancel the delivery, or create a refund obligation.
test('paid cancellation is rejected atomically by regular and event write RPCs', async (t) => {
  const db = await createDatabase(t);
  await db.exec(`
    create type public.price_source as enum ('default');
    create table public.shop_payment_profiles(id uuid);
    create table public.financial_approval_requests(id uuid);
    create table public.delivery_event_revisions(
      idempotency_key uuid, original_event_id uuid, replacement_event_id uuid,
      action text, reason text, revised_by uuid, request_fingerprint text
    );
    create table public.payment_allocation_changes(
      source_kind text, source_id uuid, payment_id uuid, from_charge_id uuid,
      to_charge_id uuid, before_amount numeric, after_amount numeric, reason text, changed_by uuid
    );
    create table public.refund_obligations(
      source_kind text, source_id uuid, payment_id uuid, source_charge_id uuid,
      amount numeric, reason text, created_by uuid
    );
    create table public.audit_logs(
      actor_id uuid, entity_type text, entity_id uuid, action text,
      before_value jsonb, after_value jsonb, reason text, occurred_at timestamptz default now()
    );
    alter table public.delivery_events add cancelled_by uuid, add cancelled_at timestamptz, add cancellation_reason text;
    alter table public.round_stops add status public.shop_round_status, add note text, add updated_by uuid, add updated_at timestamptz;
    alter table public.payments add recorded_at timestamptz default now();
    create function public.delivery_request_fingerprint(uuid,jsonb,public.shop_round_status,text,text)
      returns text language sql as $$ select 'test'::text $$;
    set test.role = 'admin';
    insert into public.payments(id, status) values ('${id}', 'active');
    insert into public.payment_allocations values ('${id}', '${id}', 60);
  `);
  const foundation = readFileSync(new URL('../supabase/migrations/0128_delivery_corrections_refunds_and_adjustments.sql', import.meta.url), 'utf8');
  const start = foundation.indexOf('create function public.apply_open_delivery_correction(');
  await db.exec(foundation.slice(start, foundation.indexOf('\n$$;', start) + 4));
  // Include the existing immediate-sale guard from the deployed migration.
  const immediate = readFileSync(new URL('../supabase/migrations/0134_monthly_sales_documents_and_atomic_immediate_sales.sql', import.meta.url), 'utf8');
  const guardStart = immediate.indexOf('do $guard_immediate_open_correction$');
  const guardEnd = immediate.indexOf('$guard_immediate_open_correction$;', guardStart);
  await db.exec(immediate.slice(guardStart, guardEnd + '$guard_immediate_open_correction$;'.length));
  for (const role of ['admin', 'round_lead', 'courier']) {
    await db.exec(`set test.role = '${role}'`);
    for (const term of ['end_of_day', 'credit', 'immediate']) {
      await db.query(`update public.delivery_charges set payment_term = $1`, [term]);
      for (const amount of [60, 30]) {
        await db.query(`update public.payment_allocations set amount = $1`, [amount]);
        // A user may open an eligible dialog before another user takes payment.
        await db.exec(`update public.payments set status = 'voided'`);
        assert.equal((await db.query(`select public.preview_delivery_correction('${id}', 'cancel', '[]', 'delivered') as data`)).rows[0].data.can_cancel, true);
        await db.exec(`update public.payments set status = 'active'`);
        assert.equal((await db.query(`select public.get_delivery_correction_context('${id}') as data`)).rows[0].data.can_cancel, false);
        for (const rpc of ['apply_open_delivery_correction', 'apply_open_event_delivery_correction']) {
          await assert.rejects(db.query(`select public.${rpc}('${id}', 'cancel', '[]', 'delivered', null, 'ส่งผิด', '${id}', null)`), /รับชำระแล้ว|Void the active immediate-sale receipt/, `${role} ${term} ${amount} ${rpc}`);
          assert.equal((await db.query(`select status from public.delivery_events`)).rows[0].status, 'active');
          assert.equal(Number((await db.query(`select amount from public.payment_allocations`)).rows[0].amount), amount);
          assert.equal((await db.query(`select * from public.refund_obligations`)).rows.length, 0);
          assert.equal((await db.query(`select * from public.delivery_event_revisions`)).rows.length, 0);
        }
      }
    }
  }
  // The same request succeeds once the mistaken receipt has been voided,
  // and a retry must replay the result without a second mutation.
  await db.exec(`set test.role = 'admin'; update public.payments set status = 'voided'`);
  const cancel = () => db.query(`select public.apply_open_delivery_correction('${id}', 'cancel', '[]', 'delivered', null, 'ส่งผิด', '${id}', null) as data`);
  assert.equal((await cancel()).rows[0].data.action, 'cancel');
  assert.equal((await cancel()).rows[0].data.idempotent_replay, true);
  assert.equal((await db.query(`select status from public.delivery_events`)).rows[0].status, 'cancelled');
  assert.equal((await db.query(`select * from public.delivery_event_revisions`)).rows.length, 1);
});
