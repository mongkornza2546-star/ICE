import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../supabase/migrations/0194_delivery_slips_cancel_only.sql', import.meta.url), 'utf8');
const id = '10000000-0000-4000-8000-000000000001';

test('cancellation policy permits own unpaid deliveries and rejects edits and protected deliveries', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create type public.shop_round_status as enum ('pending', 'delivered');
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
  assert.equal((await context()).can_cancel, true);
  assert.equal((await preview()).refund_amount, 60);
  await db.exec(`update public.delivery_rounds set status = 'closed'; update public.delivery_charges set payment_term = 'immediate'`);
  assert.equal((await context()).can_cancel, false);
  await db.exec(`update public.payments set status = 'voided'`);
  assert.equal((await context()).can_cancel, true);
  await db.exec(`update public.delivery_events set status = 'cancelled'`);
  assert.equal((await context()).can_cancel, false);
});
