-- Preparation dates extend operational eligibility without changing public event dates.
-- Tank custody is a separate register; rental starts on the event's opening day.
alter table public.event_jobs add column preparation_start_date date
  check (preparation_start_date <= start_date);
alter table public.event_participations add column preparation_start_date date
  check (preparation_start_date <= start_date);

create or replace function public.protect_event_preparation_dates()
returns trigger language plpgsql set search_path = public as $$
declare v_job public.event_jobs%rowtype;
begin
  if tg_op = 'UPDATE' and old.preparation_start_date is not null
    and (new.preparation_start_date is null or new.preparation_start_date > old.preparation_start_date) then
    raise exception 'วันเริ่มเตรียมงานที่บันทึกแล้วเลื่อนให้ช้าลงไม่ได้';
  end if;
  if tg_table_name = 'event_participations' and new.preparation_start_date is not null then
    select * into v_job from public.event_jobs where id = new.event_job_id;
    if v_job.preparation_start_date is null or new.preparation_start_date < v_job.preparation_start_date
      or new.preparation_start_date >= v_job.start_date then
      raise exception 'วันรับของล่วงหน้าต้องอยู่ในช่วงเตรียมงาน';
    end if;
  end if;
  return new;
end;
$$;
create trigger event_jobs_protect_preparation before update on public.event_jobs
for each row execute function public.protect_event_preparation_dates();
create trigger event_participations_protect_preparation before insert or update on public.event_participations
for each row execute function public.protect_event_preparation_dates();

create or replace function public.prepare_event_shops(p_event_job_id uuid, p_service_date date, p_participation_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_job public.event_jobs%rowtype; v_count integer; v_before jsonb;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can prepare events';
  end if;
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if not found or v_job.status = 'cancelled' then raise exception 'ไม่พบงานหรืองานถูกยกเลิกแล้ว'; end if;
  if p_service_date is null or p_service_date >= v_job.start_date then
    raise exception 'วันเตรียมงานต้องอยู่ก่อนวันเปิดงาน';
  end if;
  if coalesce(cardinality(p_participation_ids), 0) not between 1 and 1000
    or array_position(p_participation_ids, null) is not null then
    raise exception 'เลือกร้าน 1–1,000 ร้าน';
  end if;
  perform id from public.event_participations where event_job_id = v_job.id
    and id = any(p_participation_ids) order by id for update;
  select count(*) into v_count from public.event_participations
    where event_job_id = v_job.id and id = any(p_participation_ids) and status = 'active';
  if v_count <> cardinality(p_participation_ids) then raise exception 'มีร้านซ้ำ ร้านถูกยกเลิก หรือร้านที่ไม่ได้อยู่ในงานนี้'; end if;
  if exists (select 1 from public.event_participations where id = any(p_participation_ids)
    and preparation_start_date < p_service_date) then
    raise exception 'วันรับของล่วงหน้าที่บันทึกแล้วเลื่อนให้ช้าลงไม่ได้';
  end if;
  -- Published jobs already passed normal readiness; additionally require prices for preparation days.
  if v_job.status = 'published' and exists (
    select 1 from public.ice_types ice
    cross join generate_series(p_service_date::timestamp, (v_job.start_date - 1)::timestamp, interval '1 day') day
    where ice.is_active and not exists (select 1 from public.ice_type_prices price
      where price.ice_type_id = ice.id and price.is_active and price.valid_from <= day::date
        and (price.valid_to is null or price.valid_to >= day::date))
  ) then raise exception 'กรุณาตั้งราคาน้ำแข็งให้ครอบคลุมวันเตรียมงานก่อน'; end if;
  v_before := to_jsonb(v_job);
  update public.event_jobs set preparation_start_date = least(coalesce(preparation_start_date, p_service_date), p_service_date)
    where id = v_job.id;
  update public.event_participations set preparation_start_date = p_service_date, updated_by = auth.uid()
    where event_job_id = v_job.id and id = any(p_participation_ids);
  insert into public.audit_logs(actor_id, entity_type, entity_id, action, before_value, after_value)
    values(auth.uid(), 'event_job', v_job.id, 'prepare_shops', v_before,
      jsonb_build_object('service_date', p_service_date, 'participation_ids', p_participation_ids));
  return jsonb_build_object('prepared_count', v_count);
end;
$$;
revoke all on function public.prepare_event_shops(uuid,date,uuid[]) from public, anon;
grant execute on function public.prepare_event_shops(uuid,date,uuid[]) to authenticated;

-- Patch every operational reader/writer, retaining all original authorization,
-- stock locks, financial-context checks and idempotency behavior from 0171.
do $preparation_eligibility$
declare v_signature text; v_original text; v_patched text;
begin
  foreach v_signature in array array[
    'public.sync_daily_round_destinations(uuid)',
    'public.get_event_delivery_cards(uuid,uuid,text)',
    'public.get_event_delivery_pos_context(uuid)',
    'public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamp with time zone,uuid)',
    'public.enforce_event_settlement_context()',
    'public.event_publish_readiness(uuid)'
  ] loop
    v_original := pg_get_functiondef(v_signature::regprocedure);
    v_patched := replace(v_original, 'between job.start_date and job.end_date',
      'between coalesce(job.preparation_start_date, job.start_date) and job.end_date');
    v_patched := replace(v_patched, 'between participation.start_date and participation.end_date',
      'between coalesce(participation.preparation_start_date, participation.start_date) and participation.end_date');
    -- POS and ice writer load dates into local eligibility variables.
    v_patched := replace(v_patched, E'    job.start_date,\n', E'    coalesce(job.preparation_start_date, job.start_date),\n');
    v_patched := replace(v_patched, E'    participation.start_date,\n', E'    coalesce(participation.preparation_start_date, participation.start_date),\n');
    v_patched := replace(v_patched, 'between v_job.start_date and v_job.end_date',
      'between coalesce(v_job.preparation_start_date, v_job.start_date) and v_job.end_date');
    v_patched := replace(v_patched, 'between v_participation.start_date and v_participation.end_date',
      'between coalesce(v_participation.preparation_start_date, v_participation.start_date) and v_participation.end_date');
    v_patched := replace(v_patched, 'v_job.start_date::timestamp', 'coalesce(v_job.preparation_start_date, v_job.start_date)::timestamp');
    if v_original = v_patched then raise exception 'Cannot install preparation eligibility in %', v_signature; end if;
    execute v_patched;
  end loop;
end;
$preparation_eligibility$;

create table public.event_tank_register (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  event_participation_id uuid not null references public.event_participations(id) on delete restrict,
  movement_kind text not null check (movement_kind in ('handoff', 'return')),
  quantity integer not null check (quantity between 1 and 10000),
  service_date date not null,
  rental_start_date date,
  rental_unit_price numeric(12,2),
  note text not null default '',
  recorded_by uuid not null references public.users(id),
  recorded_at timestamptz not null default now(),
  check ((movement_kind = 'handoff' and rental_start_date is not null and rental_unit_price is not null and rental_unit_price >= 0)
    or (movement_kind = 'return' and rental_start_date is null and rental_unit_price is null))
);
create index event_tank_register_participation_idx on public.event_tank_register(event_participation_id, service_date);
alter table public.event_tank_register enable row level security;
revoke all on public.event_tank_register from public, anon, authenticated;

create or replace function public.record_event_tank_movement(
  p_participation_id uuid, p_kind text, p_quantity integer, p_service_date date, p_note text, p_request_id uuid
) returns public.event_tank_register
language plpgsql security definer set search_path = public as $$
declare v_job public.event_jobs%rowtype; v_part public.event_participations%rowtype;
  v_existing public.event_tank_register%rowtype; v_saved public.event_tank_register%rowtype; v_balance integer;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can record tank movements';
  end if;
  if p_request_id is null or p_service_date is null or p_service_date > (now() at time zone 'Asia/Bangkok')::date
    or p_kind is null or p_kind not in ('handoff', 'return') or p_quantity is null or p_quantity not between 1 and 10000 then
    raise exception 'ตรวจสอบวันที่ ประเภท และจำนวนถัง (ต้องไม่เป็นวันอนาคต)';
  end if;
  -- Same lock order as lifecycle writers. Serialize duplicate requests even across shops.
  perform pg_advisory_xact_lock(hashtextextended('event-tank-request:' || p_request_id::text, 0));
  select * into v_existing from public.event_tank_register where request_id = p_request_id;
  if found then
    if v_existing.event_participation_id <> p_participation_id or v_existing.movement_kind <> p_kind
      or v_existing.quantity <> p_quantity or v_existing.service_date <> p_service_date
      or v_existing.note <> trim(coalesce(p_note, '')) then raise exception 'Request ID was already used with different input'; end if;
    return v_existing;
  end if;
  select job.* into v_job from public.event_jobs job join public.event_participations part on part.event_job_id = job.id
    where part.id = p_participation_id for update of job;
  if not found then raise exception 'ไม่พบร้านในงาน'; end if;
  select * into v_part from public.event_participations where id = p_participation_id for update;
  if p_kind = 'handoff' then
    if v_job.status <> 'published' or v_part.status <> 'active'
      or p_service_date not between coalesce(v_part.preparation_start_date, v_part.start_date) and v_part.end_date
      or p_service_date not between coalesce(v_job.preparation_start_date, v_job.start_date) and v_job.end_date then
      raise exception 'ส่งถังได้เฉพาะงานเผยแพร่และวันที่ร้านเปิดรับของ';
    end if;
  end if;
  -- Reject backdated returns that would make custody negative on any later day.
  if p_kind = 'return' and (
    select coalesce(min(balance), 0) from (
      select sum(sum(delta)) over (order by day) as balance from (
        select service_date as day, sum(case when movement_kind = 'handoff' then quantity else -quantity end) as delta
        from public.event_tank_register where event_participation_id = p_participation_id group by service_date
        union all select p_service_date, -p_quantity
      ) movements group by day
    ) running
  ) < 0 then raise exception 'จำนวนรับคืนเกินจำนวนถังที่ร้านถืออยู่ในวันนั้น'; end if;
  select coalesce(sum(case when movement_kind = 'handoff' then quantity else -quantity end), 0)
    into v_balance from public.event_tank_register where event_participation_id = p_participation_id;
  if p_kind = 'return' and p_quantity > v_balance then raise exception 'จำนวนรับคืนเกินถังค้าง'; end if;
  insert into public.event_tank_register(request_id, event_participation_id, movement_kind, quantity, service_date,
    rental_start_date, rental_unit_price, note, recorded_by)
  values(p_request_id, p_participation_id, p_kind, p_quantity, p_service_date,
    case when p_kind = 'handoff' then greatest(v_job.start_date, p_service_date) end,
    case when p_kind = 'handoff' then v_part.tank_rental_unit_price_snapshot end,
    trim(coalesce(p_note, '')), auth.uid()) returning * into v_saved;
  insert into public.audit_logs(actor_id, entity_type, entity_id, action, after_value)
    values(auth.uid(), 'event_tank_register', v_saved.id, p_kind, to_jsonb(v_saved));
  return v_saved;
end;
$$;
revoke all on function public.record_event_tank_movement(uuid,text,integer,date,text,uuid) from public, anon;
grant execute on function public.record_event_tank_movement(uuid,text,integer,date,text,uuid) to authenticated;

-- Existing management payload remains backward compatible; add the immutable custody history.
do $tank_management_read$
declare v_original text; v_patched text;
begin
  v_original := pg_get_functiondef('public.get_event_management_detail(uuid)'::regprocedure);
  v_patched := replace(v_original, E'    ''participations'', v_participations,',
    E'    ''participations'', v_participations,\n    ''tank_movements'', (select coalesce(jsonb_agg(to_jsonb(m) order by m.service_date, m.recorded_at), ''[]''::jsonb) from public.event_tank_register m join public.event_participations p on p.id = m.event_participation_id where p.event_job_id = v_job.id),');
  if v_original = v_patched then raise exception 'Cannot install tank management read'; end if;
  execute v_patched;
end;
$tank_management_read$;
