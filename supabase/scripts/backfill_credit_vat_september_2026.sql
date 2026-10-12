-- Requested 2026-10-12: add exclusive VAT to existing credit bills for enabled shops.
-- Reviewed production scope: 221 unpaid/unbilled bills, base 35,640, VAT 2,494.80.
-- Dry run by default; execute the entire transaction with COMMIT to apply.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create temp table vat_repair_config on commit drop as
select '5047b139-345c-4173-b3dd-b5fe5a13bd2e'::uuid actor_id,
  221::integer expected_count, 35640::numeric expected_subtotal, 2494.80::numeric expected_vat;

-- Block concurrent sales/collections while selecting and checking the exact repair set.
lock table public.shop_payment_profiles, public.delivery_charges,
  public.payments, public.payment_allocations, public.billing_statement_items,
  public.delivery_charge_adjustments, public.delivery_charge_document_snapshots
  in share row exclusive mode;
create temp table vat_repair_targets on commit drop as
select c.id, c.shop_id, s.code, c.subtotal_amount,
  round(c.subtotal_amount * .07, 2) vat_amount,
  to_jsonb(c) before_charge, d.document_data before_document
from public.delivery_charges c
join public.shop_payment_profiles p on p.shop_id=c.shop_id
join public.shops s on s.id=c.shop_id
left join public.delivery_charge_document_snapshots d on d.charge_id=c.id
where p.vat_enabled and c.service_date >= date '2026-09-01'
  and c.status='active' and c.payment_term='credit'
  and c.delivery_event_id is not null and c.event_settlement_context_id is null
  and c.tank_rental_id is null and c.vat_rate=0;

do $check$
declare cfg record;
begin
  select * into strict cfg from vat_repair_config;
  if not exists(select 1 from public.users where id=cfg.actor_id and role='admin' and is_active) then
    raise exception 'Repair actor must be an active administrator';
  end if;
  if (select count(*) from vat_repair_targets) <> cfg.expected_count
    or (select coalesce(sum(subtotal_amount),0) from vat_repair_targets) <> cfg.expected_subtotal
    or (select coalesce(sum(vat_amount),0) from vat_repair_targets) <> cfg.expected_vat then
    raise exception 'VAT repair scope changed; rerun preflight before applying';
  end if;
  if exists(select 1 from vat_repair_targets where before_document is null
    or (before_document->>'total_amount')::numeric is distinct from subtotal_amount) then
    raise exception 'Missing or inconsistent invoice snapshot';
  end if;
  if exists(select 1 from public.payment_allocations a join public.payments p on p.id=a.payment_id
    join vat_repair_targets t on t.id=a.charge_id where p.status='active')
    or exists(select 1 from public.billing_statement_items i join vat_repair_targets t on t.id=i.charge_id where i.active)
    or exists(select 1 from public.delivery_charge_adjustments a join vat_repair_targets t on t.id=a.charge_id where a.status='active') then
    raise exception 'Paid, billed or adjusted charge requires separate review';
  end if;
end;
$check$;

-- Only these two immutability guards are suspended, under table locks, in this transaction.
-- All financial integrity constraints remain enabled; rollback restores guards on failure.
alter table public.delivery_charges disable trigger delivery_charges_vat_snapshot;
alter table public.delivery_charge_document_snapshots disable trigger delivery_charge_document_snapshots_immutable;
update public.delivery_charges c
set vat_rate=7, vat_amount=t.vat_amount, original_amount=t.subtotal_amount+t.vat_amount
from vat_repair_targets t where c.id=t.id;
update public.delivery_charge_document_snapshots d
set document_data=d.document_data || jsonb_build_object(
  'subtotal_amount',t.subtotal_amount,'vat_rate',7,'vat_amount',t.vat_amount,
  'total_amount',t.subtotal_amount+t.vat_amount)
from vat_repair_targets t where d.charge_id=t.id;
alter table public.delivery_charge_document_snapshots enable trigger delivery_charge_document_snapshots_immutable;
set constraints all immediate;
alter table public.delivery_charges enable trigger delivery_charges_vat_snapshot;

insert into public.audit_logs(actor_id,entity_type,entity_id,action,before_value,after_value,reason)
select cfg.actor_id,'delivery_charges',t.id,'backfill_credit_vat_september_2026',
  jsonb_build_object('charge',t.before_charge,'document',t.before_document),
  jsonb_build_object('charge',to_jsonb(c),'document',d.document_data),
  'เพิ่ม VAT 7% ย้อนหลังตั้งแต่ 1 กันยายน 2569 ตามคำขอผู้ใช้วันที่ 12 ตุลาคม 2569'
from vat_repair_targets t join public.delivery_charges c on c.id=t.id
join public.delivery_charge_document_snapshots d on d.charge_id=t.id
cross join vat_repair_config cfg;

select code,count(*) bills,sum(subtotal_amount) subtotal,sum(vat_amount) vat_added,
  sum(subtotal_amount+vat_amount) total_including_vat
from vat_repair_targets group by code order by code;
rollback;
