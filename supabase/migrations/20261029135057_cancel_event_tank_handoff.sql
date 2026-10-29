-- Cancellation is an audited compensating custody movement, not a physical return.
-- Existing balance readers continue summing handoffs minus returns unchanged.
alter table public.event_tank_register add column reverses_movement_id uuid unique
  references public.event_tank_register(id) on delete restrict;
alter table public.event_tank_register add constraint event_tank_reversal_is_return
  check (reverses_movement_id is null or (movement_kind = 'return' and reverses_movement_id <> id));

-- Retain all source validation. Only allow an immutable event rental invoice to
-- be voided after the matching cancellation movement has been inserted.
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.enforce_delivery_charge_settlement_context()'::regprocedure);
  v_new := replace(v_old, '  if new.event_tank_rental_id is not null then', $patch$
  if tg_op = 'UPDATE' and old.event_tank_rental_id is not null and new.status = 'voided' then
    if old.status <> 'active'
      or (to_jsonb(new) - array['status','voided_by','voided_at','void_reason'])
        is distinct from (to_jsonb(old) - array['status','voided_by','voided_at','void_reason'])
      or not exists (
        select 1 from public.event_tank_register reversal
        join public.event_tank_register original on original.id = reversal.reverses_movement_id
        where original.id = old.event_tank_rental_id
          and reversal.quantity = original.quantity
          and reversal.event_participation_id = original.event_participation_id
          and reversal.service_date = original.service_date
      ) then raise exception 'Event rental cancellation must match its original movement'; end if;
    return new;
  end if;
  if new.event_tank_rental_id is not null then$patch$);
  if v_new = v_old then raise exception 'Cannot install event rental cancellation guard'; end if;
  execute v_new;
end;
$$;

create function public.cancel_event_tank_handoff(p_movement_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_original public.event_tank_register%rowtype;
  v_reversal public.event_tank_register%rowtype;
  v_part public.event_participations%rowtype;
  v_charge public.delivery_charges%rowtype;
begin
  if auth.uid() is null or not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'เฉพาะแอดมินหรือหัวหน้ารอบเท่านั้นที่ยกเลิกรายการถังได้';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'กรุณาระบุเหตุผลในการยกเลิก'; end if;
  select * into v_original from public.event_tank_register where id = p_movement_id;
  if not found or v_original.movement_kind <> 'handoff' then
    raise exception 'ไม่พบรายการส่งมอบถังที่ยกเลิกได้';
  end if;
  -- Same lock order as handoff/return writers; payment writers share the shop lock.
  perform 1 from public.event_jobs job join public.event_participations part on part.event_job_id = job.id
    where part.id = v_original.event_participation_id for update of job;
  select * into v_part from public.event_participations where id = v_original.event_participation_id for update;
  select * into v_reversal from public.event_tank_register where reverses_movement_id = p_movement_id;
  if found then return jsonb_build_object('movement_id', p_movement_id, 'reversal_id', v_reversal.id); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_original.rental_start_date::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_part.shop_id::text, 0));
  if public.current_app_role() <> 'admin' and exists (
    select 1 from public.daily_aggregate_stock_closures where service_date = v_original.rental_start_date
  ) then raise exception 'วันที่ปิดยอดแล้วต้องให้แอดมินยกเลิกรายการ'; end if;
  select * into v_charge from public.delivery_charges where event_tank_rental_id = p_movement_id for update;
  if v_charge.id is not null and v_charge.status <> 'active' then raise exception 'บิลนี้ถูกยกเลิกแล้ว'; end if;
  if exists (select 1 from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = v_charge.id and payment.status = 'active') then
    raise exception 'บิลค่าเช่านี้รับเงินแล้ว กรุณาจัดการยกเลิกรายการรับเงินก่อนยกเลิกถัง';
  end if;
  -- Removing this handoff must not invalidate any later physical return.
  if (select coalesce(min(balance), 0) from (
    select sum(sum(delta)) over (order by day) as balance from (
      select service_date as day, case when movement_kind = 'handoff' then quantity else -quantity end as delta
      from public.event_tank_register where event_participation_id = v_part.id
      union all select v_original.service_date, -v_original.quantity
    ) movements group by day
  ) running) < 0 then
    raise exception 'ยกเลิกไม่ได้ เนื่องจากมีรายการรับคืนถังแล้วและจะทำให้ยอดถังติดลบ';
  end if;
  insert into public.event_tank_register(request_id, event_participation_id, movement_kind, quantity,
    service_date, note, recorded_by, reverses_movement_id)
  values(gen_random_uuid(), v_part.id, 'return', v_original.quantity, v_original.service_date,
    trim(p_reason), auth.uid(), p_movement_id) returning * into v_reversal;
  if v_charge.id is not null then
    update public.delivery_charges set status = 'voided', voided_by = auth.uid(),
      voided_at = now(), void_reason = trim(p_reason) where id = v_charge.id;
  end if;
  insert into public.audit_logs(actor_id, entity_type, entity_id, action, before_value, after_value)
  values(auth.uid(), 'event_tank_register', p_movement_id, 'cancel_handoff', to_jsonb(v_original),
    jsonb_build_object('reversal', to_jsonb(v_reversal), 'charge_id', v_charge.id, 'reason', trim(p_reason)));
  return jsonb_build_object('movement_id', p_movement_id, 'reversal_id', v_reversal.id, 'charge_id', v_charge.id);
end;
$$;
revoke all on function public.cancel_event_tank_handoff(uuid,text) from public, anon;
grant execute on function public.cancel_event_tank_handoff(uuid,text) to authenticated;

-- Expose audit state while preserving the original read model and authorization.
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.get_event_management_detail(uuid)'::regprocedure);
  v_new := replace(v_old, '''id'', m.id,', $patch$'id', m.id,
      'reverses_movement_id', m.reverses_movement_id,
      'cancelled', exists(select 1 from public.event_tank_register r where r.reverses_movement_id = m.id),
      'charge_status', charge.status,$patch$);
  v_new := replace(v_new, 'greatest(charge.original_amount -', 'greatest((case when charge.status = ''active'' then charge.original_amount else 0 end) -');
  if v_old = v_new then raise exception 'Cannot install tank cancellation detail'; end if;
  execute v_new;
end;
$$;

-- Rental history remains visible in the delivery screen, marked as cancelled.
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.delivery_today_tank_rentals(uuid)'::regprocedure);
  v_new := replace(v_old, '''id'', rental.id,', $patch$'id', rental.id,
    'cancelled', exists(select 1 from public.event_tank_register r where r.reverses_movement_id = rental.id),
    'can_cancel', public.is_active_user() and public.current_app_role() in ('admin', 'round_lead')
      and exists(select 1 from public.event_tank_register m where m.id = rental.id and m.movement_kind = 'handoff')
      and not exists(select 1 from public.event_tank_register r where r.reverses_movement_id = rental.id),$patch$);
  if v_old = v_new then raise exception 'Cannot install tank cancellation history'; end if;
  execute v_new;
end;
$$;

-- Cancelled invoices remain auditable without inflating accounting totals.
do $$
declare v_old text; v_new text; v_signature text;
begin
  v_old := pg_get_functiondef('public.accounting_transaction_rows(date,date)'::regprocedure);
  v_new := replace(v_old, 'charge.original_amount',
    '(case when charge.status = ''active'' then charge.original_amount else 0::numeric end)');
  if v_new = v_old then raise exception 'Cannot install cancelled rental accounting totals'; end if;
  execute v_new;
  -- The daily matrix wrapper was renamed when building filters were added.
  v_signature := case when to_regprocedure('public.get_accounting_shop_daily_matrix_without_building(date,date,uuid[])') is not null
    then 'public.get_accounting_shop_daily_matrix_without_building(date,date,uuid[])'
    else 'public.get_accounting_shop_daily_matrix(date,date,uuid[])' end;
  v_old := pg_get_functiondef(v_signature::regprocedure);
  v_new := replace(v_old, 'and movement.movement_kind = ''handoff''',
    'and movement.movement_kind = ''handoff'' and not exists (select 1 from public.event_tank_register reversal where reversal.reverses_movement_id = movement.id)');
  if v_new = v_old then raise exception 'Cannot install cancelled rental daily tank counts'; end if;
  execute v_new;
end;
$$;

-- Employee booth totals describe physical movements. Exclude both sides of a
-- cancellation so sent/returned counts remain truthful and net custody is unchanged.
create or replace function public.employee_event_booth_payload(p_participation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(participation) || jsonb_build_object(
    'shop_name', shop.name,
    'contact_name', coalesce(participation.contact_name, shop.contact_name),
    'contact_phone', coalesce(participation.contact_phone, shop.contact_phone),
    'tank_handoff_count', coalesce(tanks.handoff_count, 0),
    'tank_return_count', coalesce(tanks.return_count, 0),
    'tank_balance', coalesce(tanks.handoff_count, 0) - coalesce(tanks.return_count, 0),
    'tank_rental_unit_price', coalesce(participation.tank_rental_unit_price_snapshot, 0)
  )
  from public.event_participations participation
  join public.shops shop on shop.id = participation.shop_id
  left join lateral (
    select
      coalesce(sum(quantity) filter (where movement_kind = 'handoff'), 0)::integer as handoff_count,
      coalesce(sum(quantity) filter (where movement_kind = 'return'), 0)::integer as return_count
    from public.event_tank_register movement
    where movement.event_participation_id = participation.id
      and movement.reverses_movement_id is null
      and not exists (
        select 1 from public.event_tank_register reversal
        where reversal.reverses_movement_id = movement.id
      )
  ) tanks on true
  where participation.id = p_participation_id
$$;
notify pgrst, 'reload schema';
