-- Allow an unused delivery round opened by mistake to be cancelled without deleting its audit trail.

alter table public.delivery_rounds
  add column if not exists cancelled_by uuid references public.users(id),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text;

alter table public.delivery_rounds
  drop constraint if exists delivery_rounds_cancellation_consistency;

alter table public.delivery_rounds
  add constraint delivery_rounds_cancellation_consistency check (
    (cancelled_by is null and cancelled_at is null and cancellation_reason is null)
    or (
      status = 'closed'
      and cancelled_by is not null
      and cancelled_at is not null
      and nullif(trim(coalesce(cancellation_reason, '')), '') is not null
    )
  );

create or replace function public.reject_cancelled_round_stock_movement()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_cancelled_at timestamptz;
begin
  select round.cancelled_at into v_cancelled_at
  from public.delivery_rounds round
  where round.id = new.round_id
  for key share;

  if v_cancelled_at is not null then
    raise exception 'รอบนี้ยกเลิกแล้ว ไม่สามารถบันทึกรายการสต๊อกใหม่ได้';
  end if;

  return new;
end;
$$;

drop trigger if exists stock_movements_reject_cancelled_round on public.stock_movements;
create trigger stock_movements_reject_cancelled_round
before insert on public.stock_movements
for each row execute function public.reject_cancelled_round_stock_movement();

create or replace function public.delivery_round_cancellation_blockers(p_round_id uuid)
returns text[]
language sql
stable
set search_path = public
as $$
  select array_remove(array[
    case when exists (
      select 1
      from public.delivery_events event
      join public.round_stops stop on stop.id = event.round_stop_id
      where stop.round_id = p_round_id
    ) then 'delivery_events' end,
    case when exists (
      select 1
      from public.stock_movements movement
      where movement.round_id = p_round_id
    ) then 'stock_movements' end,
    case when exists (
      select 1
      from public.round_stops stop
      where stop.round_id = p_round_id and stop.status <> 'pending'
    ) then 'non_pending_stops' end,
    case when exists (
      select 1
      from public.round_ice_counts counts
      where counts.round_id = p_round_id
        and (
          counts.loaded_quantity <> 0
          or counts.replenished_quantity <> 0
          or counts.remaining_quantity <> 0
          or counts.damaged_quantity <> 0
        )
    ) then 'round_ice_counts' end
  ]::text[], null);
$$;

create or replace function public.get_delivery_round_cancellation_state(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_status public.delivery_round_status;
  v_cancelled_at timestamptz;
  v_blockers text[];
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'เฉพาะหัวหน้ารอบหรือแอดมินเท่านั้นที่ยกเลิกรอบส่งได้';
  end if;

  select status, cancelled_at into v_status, v_cancelled_at
  from public.delivery_rounds
  where id = p_round_id;

  if not found then
    raise exception 'ไม่พบรอบส่งที่เลือก';
  end if;

  v_blockers := public.delivery_round_cancellation_blockers(p_round_id);

  return jsonb_build_object(
    'can_cancel', v_status = 'open' and v_cancelled_at is null and cardinality(v_blockers) = 0,
    'blockers', v_blockers,
    'status', case when v_cancelled_at is not null then 'cancelled' else v_status::text end
  );
end;
$$;

create or replace function public.cancel_delivery_round(
  p_round_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.delivery_rounds%rowtype;
  v_captured_at timestamptz;
  v_blockers text[];
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'เฉพาะหัวหน้ารอบหรือแอดมินเท่านั้นที่ยกเลิกรอบส่งได้';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A cancellation reason is required';
  end if;

  select * into v_round
  from public.delivery_rounds
  where id = p_round_id
  for update;

  if not found then
    raise exception 'ไม่พบรอบส่งที่เลือก';
  elsif v_round.cancelled_at is not null then
    return jsonb_build_object('status', 'cancelled');
  elsif v_round.status <> 'open' then
    raise exception 'รอบที่ปิดแล้วไม่สามารถยกเลิกย้อนหลังได้';
  end if;

  v_blockers := public.delivery_round_cancellation_blockers(p_round_id);
  if cardinality(v_blockers) > 0 then
    raise exception 'รอบนี้มีการทำรายการแล้ว จึงไม่สามารถยกเลิกการเปิดรอบได้';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_round.service_date::text, 0));
  v_captured_at := clock_timestamp();

  -- Cancelled rounds use the existing closed status, so preserve the invariant
  -- that every closed round has a stock snapshot even though the UI hides it.
  insert into public.round_stock_snapshots (
    round_id, service_date, captured_by, captured_at
  ) values (
    p_round_id, v_round.service_date, auth.uid(), v_captured_at
  );

  insert into public.round_stock_snapshot_items (
    round_id,
    location_id,
    location_code_snapshot,
    location_name_snapshot,
    location_kind_snapshot,
    ice_type_id,
    ice_type_name_snapshot,
    unit_snapshot,
    quantity
  )
  select
    p_round_id,
    location.id,
    location.code,
    location.name,
    location.kind,
    ice.id,
    ice.name,
    ice.unit,
    public.stock_balance_at(v_round.service_date, location.id, ice.id)
  from public.stock_locations location
  cross join public.ice_types ice
  where location.is_active and ice.is_active;

  update public.delivery_rounds
  set status = 'closed',
      closed_by = auth.uid(),
      closed_at = v_captured_at,
      cancelled_by = auth.uid(),
      cancelled_at = v_captured_at,
      cancellation_reason = trim(p_reason)
  where id = p_round_id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(),
    'delivery_rounds',
    p_round_id,
    'cancelled',
    jsonb_build_object(
      'status', 'cancelled',
      'cancellation_reason', trim(p_reason),
      'cancelled_by', auth.uid(),
      'stock_snapshot_at', v_captured_at
    )
  );

  return jsonb_build_object(
    'status', 'cancelled',
    'round_id', p_round_id,
    'reason', trim(p_reason)
  );
end;
$$;

revoke all on function public.cancel_delivery_round(uuid, text) from public;
revoke all on function public.delivery_round_cancellation_blockers(uuid) from public;
revoke all on function public.get_delivery_round_cancellation_state(uuid) from public;
grant execute on function public.cancel_delivery_round(uuid, text) to authenticated;
grant execute on function public.get_delivery_round_cancellation_state(uuid) to authenticated;
