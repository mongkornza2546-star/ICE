-- Couriers may cancel their own mistaken handoffs. Preserve payment, custody,
-- closed-day, idempotency and audit protections from the existing cancellation.
create or replace function public.cancel_event_tank_handoff(p_movement_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_original public.event_tank_register%rowtype;
  v_reversal public.event_tank_register%rowtype;
  v_part public.event_participations%rowtype;
  v_charge public.delivery_charges%rowtype;
begin
  if auth.uid() is null or not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead', 'courier') then
    raise exception 'บัญชีนี้ไม่มีสิทธิ์ยกเลิกรายการถัง';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'กรุณาระบุเหตุผลในการยกเลิก'; end if;
  select * into v_original from public.event_tank_register where id = p_movement_id;
  if not found or v_original.movement_kind <> 'handoff' then
    raise exception 'ไม่พบรายการส่งมอบถังที่ยกเลิกได้';
  end if;
  if public.current_app_role() = 'courier' and v_original.recorded_by is distinct from auth.uid() then
    raise exception 'พนักงานยกเลิกได้เฉพาะรายการถังที่ตนเองบันทึก';
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

-- The delivery history offers the action only for the caller's allowed rows.
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.delivery_today_tank_rentals(uuid)'::regprocedure);
  v_new := replace(v_old,
    $old$'can_cancel', public.is_active_user() and public.current_app_role() in ('admin', 'round_lead')
      and exists(select 1 from public.event_tank_register m where m.id = rental.id and m.movement_kind = 'handoff')$old$,
    $new$'can_cancel', public.is_active_user()
      and exists(select 1 from public.event_tank_register m
        where m.id = rental.id and m.movement_kind = 'handoff'
          and (public.current_app_role() in ('admin', 'round_lead')
            or (public.current_app_role() = 'courier' and m.recorded_by = auth.uid()
              and not exists (select 1 from public.daily_aggregate_stock_closures closure
                where closure.service_date = m.rental_start_date))))$new$);
  if v_new = v_old then raise exception 'Cannot install courier tank cancellation history'; end if;
  execute v_new;
end;
$$;
notify pgrst, 'reload schema';
