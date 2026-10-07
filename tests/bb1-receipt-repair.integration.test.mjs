import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const dryRun = read('supabase/scripts/repair_bb1_2026_10_06_receipt.sql');
const commit = dryRun.replace(/rollback;\s*$/, 'commit;');
const actor = '5047b139-345c-4173-b3dd-b5fe5a13bd2e';
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fn(path, name) {
  const source = read(`supabase/migrations/${path}`);
  const start = source.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n$$;', start) + 4);
}
async function database(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table public.users(id uuid primary key,role text,is_active boolean);
    create function public.current_app_role() returns text language sql stable as $$ select role from public.users where id=auth.uid() $$;
    create function public.is_active_user() returns boolean language sql stable as $$ select is_active from public.users where id=auth.uid() $$;
    create table public.shops(id uuid primary key,code text);
    create type public.financial_record_status as enum ('active','voided');
    create sequence receipt_sequence;
    create table public.payments(
      id uuid primary key default gen_random_uuid(),receipt_number text unique default ('TEST-REC-'||nextval('receipt_sequence')),
      shop_id uuid,collection_run_id uuid,payment_method text,received_amount numeric,allocated_amount numeric,change_amount numeric,
      reference_number text,idempotency_key uuid unique,request_fingerprint text,recorded_by uuid,recorded_at timestamptz,
      status public.financial_record_status default 'active',voided_by uuid,voided_at timestamptz,void_reason text,
      operation_kind text default 'regular',event_settlement_context_id uuid,request_fingerprint_version integer default 2,
      approval_request_id uuid,billing_statement_id uuid,entered_at timestamptz,received_date_override date,
      check(received_amount=allocated_amount+change_amount)
    );
    create table public.delivery_charges(id uuid primary key,charge_number text,shop_id uuid,original_amount numeric,
      status public.financial_record_status,event_settlement_context_id uuid);
    create table public.payment_allocations(payment_id uuid references public.payments,charge_id uuid references public.delivery_charges,
      amount numeric check(amount>0),primary key(payment_id,charge_id));
    create table public.refund_obligations(id uuid primary key,payment_id uuid,source_charge_id uuid,amount numeric,status text,
      source_kind text,source_id uuid,reason text,created_by uuid,created_at timestamptz,voided_by uuid,voided_at timestamptz,void_reason text);
    create table public.refund_settlements(obligation_id uuid,amount numeric);
    create table public.daily_close_payment_items(payment_id uuid);
    create table public.payment_allocation_changes(source_kind text,source_id uuid,payment_id uuid,from_charge_id uuid,to_charge_id uuid,
      before_amount numeric,after_amount numeric,reason text,changed_by uuid);
    create table public.payment_receipt_snapshots(payment_id uuid primary key,receipt_data jsonb);
    create table public.audit_logs(actor_id uuid,entity_type text,entity_id uuid,action text,before_value jsonb,after_value jsonb,reason text);
    create function public.effective_delivery_charge_amount(uuid) returns numeric language sql stable as $$
      select original_amount from public.delivery_charges where id=$1 $$;
    create function public.build_payment_receipt_snapshot(uuid) returns jsonb language sql stable as $$
      select jsonb_build_object('allocated_amount',p.allocated_amount,'allocations',(
        select jsonb_agg(to_jsonb(a)) from public.payment_allocations a where a.payment_id=p.id)) from public.payments p where p.id=$1 $$;
    insert into public.users values('${actor}','admin',true);
    insert into public.shops values('${id(1)}','BB1');
    insert into public.payments(id,receipt_number,shop_id,payment_method,received_amount,allocated_amount,change_amount,recorded_at,recorded_by) values
      ('${id(2)}','REC2610-00300','${id(1)}','cash',425,425,0,'2026-10-06 14:33+07','${actor}'),
      ('${id(3)}','REC2610-00307','${id(1)}','cash',50,50,0,'2026-10-06 16:12+07','${actor}');
    insert into public.delivery_charges values
      ('${id(4)}','INV2610-00335','${id(1)}',200,'active',null),
      ('${id(5)}','INV2610-00386','${id(1)}',100,'active',null),
      ('${id(6)}','INV2610-00397','${id(1)}',50,'active',null),
      ('${id(7)}','INV2610-00401','${id(1)}',75,'voided',null),
      ('${id(8)}','INV2610-00409','${id(1)}',50,'active',null);
    insert into public.payment_allocations values ('${id(2)}','${id(4)}',200),('${id(2)}','${id(5)}',100),('${id(2)}','${id(6)}',50),('${id(3)}','${id(8)}',50);
    insert into public.refund_obligations(id,payment_id,source_charge_id,amount,status,source_kind,source_id) values
      ('1d422e76-a8c5-47cf-9dc9-0664c45dca1a','${id(2)}','${id(7)}',75,'pending','open_revision','${id(9)}');
    insert into public.payment_receipt_snapshots values('${id(2)}','{"allocated_amount":425,"original":true}'),('${id(3)}','{"allocated_amount":50,"original":true}');
  `);
  await db.exec([
    fn('0171_event_ice_delivery_financial_closeout.sql','assert_payment_allocation_integrity'),
    fn('0128_delivery_corrections_refunds_and_adjustments.sql','assert_charge_allocation_integrity'),
    fn('0171_event_ice_delivery_financial_closeout.sql','check_payment_allocation_integrity'),
    fn('0124_payment_receipt_snapshots.sql','capture_payment_receipt_snapshot'),
    fn('0124_payment_receipt_snapshots.sql','protect_payment_receipt_snapshot'),
    fn('0202_admin_backdated_collection_payments.sql','apply_payment_received_date'),
  ].join('\n'));
  await db.exec(`
    create constraint trigger payments_integrity after insert or update on public.payments deferrable initially deferred for each row execute function public.check_payment_allocation_integrity();
    create constraint trigger allocations_integrity after insert or update on public.payment_allocations deferrable initially deferred for each row execute function public.check_payment_allocation_integrity();
    create constraint trigger refund_integrity after insert or update on public.refund_obligations deferrable initially deferred for each row execute function public.check_payment_allocation_integrity();
    create constraint trigger receipt_snapshot after insert on public.payments deferrable initially deferred for each row execute function public.capture_payment_receipt_snapshot();
    create trigger immutable_snapshot before update or delete on public.payment_receipt_snapshots for each row execute function public.protect_payment_receipt_snapshot();
    create trigger received_date before insert on public.payments for each row execute function public.apply_payment_received_date();
  `);
  return db;
}
test('BB1 repair dry run rolls back; commit preserves evidence and reissues only the valid balance', async(t) => {
  const db = await database(t);
  await db.exec(dryRun);
  assert.equal((await db.query('select * from public.payments')).rows.length,2);
  assert.equal((await db.query('select * from public.refund_obligations')).rows[0].status,'pending');
  await db.exec(commit);
  const rows=(await db.query('select receipt_number,status,allocated_amount from public.payments order by receipt_number')).rows;
  assert.deepEqual(rows.map(r=>[r.receipt_number,r.status,Number(r.allocated_amount)]),[
    ['REC2610-00300','voided',425],['REC2610-00307','active',50],['TEST-REC-2','active',350]
  ]);
  assert.equal((await db.query('select * from public.refund_obligations')).rows[0].status,'voided');
  assert.equal((await db.query('select * from public.refund_settlements')).rows.length,0);
  assert.deepEqual((await db.query(`select receipt_data from public.payment_receipt_snapshots where payment_id='${id(2)}'`)).rows[0].receipt_data,{allocated_amount:425,original:true});
  assert.equal((await db.query(`select receipt_data->>'allocated_amount' as amount from public.payment_receipt_snapshots where payment_id not in ('${id(2)}','${id(3)}')`)).rows[0].amount,'350');
  assert.equal((await db.query('select count(*)::int as n from public.audit_logs')).rows[0].n,2);
  await db.exec(commit);
  assert.equal((await db.query('select count(*)::int as n from public.payments')).rows[0].n,3);
});
for(const [name,change] of [
  ['a real refund exists',`insert into public.refund_settlements values('1d422e76-a8c5-47cf-9dc9-0664c45dca1a',75)`],
  ['cash reconciliation is frozen',`insert into public.daily_close_payment_items values('${id(2)}')`],
  ['another receipt changed the daily total',`insert into public.payments(id,receipt_number,shop_id,payment_method,received_amount,allocated_amount,change_amount,recorded_at) values('${id(10)}','EXTRA','${id(1)}','cash',1,1,0,'2026-10-06 17:00+07'); insert into public.payment_allocations values('${id(10)}','${id(8)}',1);`],
]) test(`BB1 repair refuses when ${name}`,async(t)=>{
  const db=await database(t);
  // Seed external-state differences without manufacturing an invalid allocation.
  if(name.startsWith('another')) {
    await db.exec(`set request.jwt.claim.sub='${actor}'; update public.delivery_charges set original_amount=51 where id='${id(8)}'`);
  }
  await db.exec(change);
  await assert.rejects(db.exec(commit),/preflight|frozen|daily receipt total/);
  await db.exec('rollback');
  assert.equal((await db.query(`select status from public.payments where id='${id(2)}'`)).rows[0].status,'active');
  assert.equal((await db.query('select count(*)::int as n from public.audit_logs')).rows[0].n,0);
});
