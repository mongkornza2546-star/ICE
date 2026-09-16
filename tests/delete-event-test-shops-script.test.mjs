import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const script = readFileSync(
  new URL('../supabase/scripts/delete_event_test_shops.sql', import.meta.url),
  'utf8',
);

test('event cleanup targets one explicit event id and locks it before deleting', () => {
  assert.match(script, /set_config\(\s*'app\.event_cleanup_target_id',[\s\S]+false\s*\)/i);
  assert.match(script, /where job\.id = current_setting\('app\.event_cleanup_target_id'\)::uuid[\s\S]+for update/i);
  assert.doesNotMatch(script, /_event_cleanup_input/i);
  assert.doesNotMatch(script, /where name = 'Otop Trader'/i);
});

test('event cleanup fails closed when shared immutable accounting data is present', () => {
  assert.match(script, /daily_close_payment_items[\s\S]+RAISE EXCEPTION[\s\S]+Daily Close/i);
  assert.match(script, /RAISE EXCEPTION[\s\S]{0,180}outside the target event/i);
  assert.doesNotMatch(script, /DISABLE TRIGGER daily_close_payment_items_are_immutable/i);
});

test('event cleanup handles event-owned immutable rows and stays rollback-first', () => {
  assert.match(script, /DISABLE TRIGGER daily_credit_acknowledgement_evidence_immutable/i);
  assert.match(script, /ENABLE TRIGGER daily_credit_acknowledgement_evidence_immutable/i);
  assert.match(script, /DISABLE TRIGGER event_settlement_contexts_immutable/i);
  assert.match(script, /ENABLE TRIGGER event_settlement_contexts_immutable/i);
  assert.match(script, /\nROLLBACK;\s*\n-- COMMIT;/i);
});

test('event cleanup dry run executes against the referenced schema surface', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create table event_jobs (id uuid primary key, name text, status text, start_date date,
      end_date date, location text, contact_name text, contact_phone text,
      created_at timestamptz default now());
    create table shops (id uuid primary key, event_job_id uuid, code text, name text, zone_id uuid);
    create table event_participations (id uuid primary key, event_job_id uuid, shop_id uuid,
      booth_number text, event_zone text, status text);
    create table event_shop_creation_requests (event_job_id uuid);
    create table round_stops (id uuid primary key, event_participation_id uuid, shop_id uuid);
    create table delivery_events (id uuid primary key, round_stop_id uuid);
    create table delivery_charges (id uuid primary key, shop_id uuid, delivery_event_id uuid,
      approval_request_id uuid, service_date date);
    create table payments (id uuid primary key, shop_id uuid, evidence_path text,
      approval_request_id uuid);
    create table payment_allocations (payment_id uuid, charge_id uuid);
    create table financial_approval_requests (id uuid primary key, round_stop_id uuid,
      consumed_by_delivery_event_id uuid, consumed_by_payment_id uuid);
    create table daily_credit_acknowledgements (id uuid primary key, shop_id uuid, service_date date);
    create table daily_credit_acknowledgement_evidence (acknowledgement_id uuid, storage_path text);
    create table daily_close_payment_items (payment_id uuid);
    create table refund_obligations (id uuid primary key, payment_id uuid, source_charge_id uuid);
    create table refund_settlements (obligation_id uuid);
    create table delivery_charge_adjustments (idempotency_key uuid, charge_id uuid);
    create table delivery_adjustment_items (adjustment_id uuid);
    create table payment_receipt_snapshots (payment_id uuid);
    create table delivery_charge_document_snapshots (charge_id uuid);
    create table credit_due_date_requests (charge_id uuid, shop_id uuid);
    create table collection_run_credit_charges (charge_id uuid);
    create table payment_allocation_changes (payment_id uuid, from_charge_id uuid, to_charge_id uuid);
    create table delivery_event_revisions (original_event_id uuid, replacement_event_id uuid);
    create table delivery_items (delivery_event_id uuid);
    create table event_settlement_contexts (event_participation_id uuid, shop_id uuid);
    create table event_ice_delivery_pilots (event_participation_id uuid);
    create table shop_ice_type_prices (shop_id uuid);
    create table shop_payment_profiles (shop_id uuid);
    create table shop_rented_tanks (shop_id uuid);
    create table route_shops (shop_id uuid);
    create table building_zones (id uuid primary key, code text);
    create table audit_logs (entity_type text, entity_id uuid);

    create function protect_test_row() returns trigger language plpgsql as $$
    begin raise exception 'protected test row'; end;
    $$;
    create trigger payment_allocation_changes_append_only before delete on payment_allocation_changes
      for each row execute function protect_test_row();
    create trigger refund_settlements_append_only before delete on refund_settlements
      for each row execute function protect_test_row();
    create trigger delivery_adjustment_items_append_only before delete on delivery_adjustment_items
      for each row execute function protect_test_row();
    create trigger daily_credit_acknowledgements_immutable before delete on daily_credit_acknowledgements
      for each row execute function protect_test_row();
    create trigger daily_credit_acknowledgement_evidence_immutable before delete on daily_credit_acknowledgement_evidence
      for each row execute function protect_test_row();
    create trigger payment_receipt_snapshots_immutable before delete on payment_receipt_snapshots
      for each row execute function protect_test_row();
    create trigger delivery_charge_document_snapshots_immutable before delete on delivery_charge_document_snapshots
      for each row execute function protect_test_row();
    create trigger event_settlement_contexts_immutable before delete on event_settlement_contexts
      for each row execute function protect_test_row();
  `);

  const eventId = '10000000-0000-4000-8000-000000000001';
  const eventShopId = '20000000-0000-4000-8000-000000000001';
  const participationId = '30000000-0000-4000-8000-000000000001';
  const acknowledgementId = '40000000-0000-4000-8000-000000000001';
  await db.query('insert into event_jobs(id, name, status) values ($1, $2, $3)', [eventId, 'Test event', 'draft']);
  await db.query('insert into shops(id, event_job_id, code, name) values ($1, $2, $3, $4)',
    [eventShopId, eventId, 'EV-1', 'Test booth']);
  await db.query('insert into event_participations(id, event_job_id, shop_id, booth_number, status) values ($1, $2, $3, $4, $5)',
    [participationId, eventId, eventShopId, 'A1', 'active']);
  await db.query('insert into event_settlement_contexts(event_participation_id, shop_id) values ($1, $2)',
    [participationId, eventShopId]);
  await db.query('insert into daily_credit_acknowledgements(id, shop_id) values ($1, $2)',
    [acknowledgementId, eventShopId]);
  await db.query('insert into daily_credit_acknowledgement_evidence(acknowledgement_id, storage_path) values ($1, $2)',
    [acknowledgementId, 'event/test-evidence.jpg']);

  const dryRun = script
    .replace('00000000-0000-0000-0000-000000000000', eventId)
    .replace("-- SET LOCAL app.confirm_delete_event_shops = 'DELETE EVENT TEST SHOPS';",
      "SET LOCAL app.confirm_delete_event_shops = 'DELETE EVENT TEST SHOPS';");

  await db.exec(dryRun);
  assert.equal((await db.query('select count(*)::int as count from event_jobs')).rows[0].count, 1);
  assert.equal((await db.query('select count(*)::int as count from event_settlement_contexts')).rows[0].count, 1);
  assert.equal((await db.query('select count(*)::int as count from daily_credit_acknowledgement_evidence')).rows[0].count, 1);
});
