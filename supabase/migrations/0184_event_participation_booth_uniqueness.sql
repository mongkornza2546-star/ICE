-- Match bulk booth uniqueness for both regular-shop additions and booth edits.
create or replace function public.save_event_participation(
  p_participation_id uuid,
  p_event_job_id uuid,
  p_shop_id uuid,
  p_booth_number text,
  p_event_zone text,
  p_landmark text,
  p_contact_name text,
  p_contact_phone text,
  p_start_date date,
  p_end_date date,
  p_rents_tank_from_us boolean
)
returns public.event_participations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.event_jobs%rowtype;
  v_config public.event_job_config_versions%rowtype;
  v_shop public.shops%rowtype;
  v_participation public.event_participations%rowtype;
  v_before jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only an active admin or round lead can manage event participations';
  end if;
  select * into v_job from public.event_jobs where id = p_event_job_id for update;
  if v_job.id is null then
    raise exception 'The selected event does not exist';
  elsif v_job.status = 'cancelled' then
    raise exception 'Cancelled events cannot accept participations';
  end if;
  select * into v_shop from public.shops where id = p_shop_id;
  if v_shop.id is null or v_shop.status <> 'active' then
    raise exception 'The selected shop is not active';
  end if;
  if v_shop.event_job_id is not null and v_shop.event_job_id <> v_job.id then
    raise exception 'This shop belongs to another event';
  end if;
  if p_start_date is null or p_end_date is null
    or p_start_date < v_job.start_date or p_end_date > v_job.end_date
    or p_end_date < p_start_date then
    raise exception 'Participation dates must be within the event date range';
  end if;

  -- The event row is already locked above, serializing this check with
  -- create_event_shops and other participation writers for the same event.
  -- Cancelled participations continue reserving their booth, as in bulk entry.
  if nullif(trim(p_booth_number), '') is not null and exists (
    select 1 from public.event_participations participation
    where participation.event_job_id = v_job.id
      and participation.id is distinct from p_participation_id
      and upper(trim(participation.booth_number)) = upper(trim(p_booth_number))
      and upper(trim(coalesce(participation.event_zone, '')))
        = upper(trim(coalesce(p_event_zone, '')))
  ) then
    raise exception 'เลขบูธนี้มีอยู่แล้วในโซนเดียวกันของงาน กรุณาใช้เลขบูธอื่น';
  end if;

  if p_participation_id is null then
    if v_job.status = 'published' and (
      nullif(trim(coalesce(v_shop.code, '')), '') is null
      or nullif(trim(coalesce(v_shop.name, '')), '') is null
    ) then
      raise exception 'Published participations require customer identity';
    end if;
    select * into v_config from public.event_job_config_versions
    where id = v_job.current_config_version_id;
    insert into public.event_participations (
      event_job_id, shop_id, booth_number, event_zone, landmark,
      contact_name, contact_phone, start_date, end_date, rents_tank_from_us,
      config_version_id, tank_rental_unit_price_snapshot, payment_term_snapshot,
      allowed_payment_methods_snapshot, default_payment_method_snapshot,
      cash_reference_required_snapshot, cash_evidence_required_snapshot,
      bank_transfer_reference_required_snapshot, bank_transfer_evidence_required_snapshot,
      qr_reference_required_snapshot, qr_evidence_required_snapshot,
      settlement_policy_fingerprint, created_by, updated_by
    ) values (
      v_job.id, p_shop_id, nullif(trim(coalesce(p_booth_number, '')), ''),
      nullif(trim(coalesce(p_event_zone, '')), ''), nullif(trim(coalesce(p_landmark, '')), ''),
      nullif(trim(coalesce(p_contact_name, '')), ''), nullif(trim(coalesce(p_contact_phone, '')), ''),
      p_start_date, p_end_date, coalesce(p_rents_tank_from_us, false),
      case when v_job.status = 'published' then v_config.id end,
      case when v_job.status = 'published' then v_config.tank_rental_unit_price end,
      case when v_job.status = 'published' then v_config.payment_term end,
      case when v_job.status = 'published' then v_config.allowed_payment_methods end,
      case when v_job.status = 'published' then v_config.default_payment_method end,
      case when v_job.status = 'published' then v_config.cash_reference_required end,
      case when v_job.status = 'published' then v_config.cash_evidence_required end,
      case when v_job.status = 'published' then v_config.bank_transfer_reference_required end,
      case when v_job.status = 'published' then v_config.bank_transfer_evidence_required end,
      case when v_job.status = 'published' then v_config.qr_reference_required end,
      case when v_job.status = 'published' then v_config.qr_evidence_required end,
      case when v_job.status = 'published' then v_config.policy_fingerprint end,
      auth.uid(), auth.uid()
    ) returning * into v_participation;
  else
    select * into v_participation
    from public.event_participations where id = p_participation_id for update;
    if v_participation.id is null or v_participation.event_job_id <> p_event_job_id then
      raise exception 'The selected participation does not belong to this event';
    elsif v_participation.status <> 'active' then
      raise exception 'Cancelled participations are immutable';
    elsif v_job.status = 'published' and v_participation.shop_id <> p_shop_id then
      raise exception 'A published participation cannot change customer identity';
    end if;
    if v_job.status = 'published' and (
      nullif(trim(coalesce(v_shop.code, '')), '') is null
      or nullif(trim(coalesce(v_shop.name, '')), '') is null
    ) then
      raise exception 'Published participations require customer identity';
    end if;
    if v_job.status = 'published'
      and (p_start_date > v_participation.start_date or p_end_date < v_participation.end_date)
      and exists (
        select 1
        from public.delivery_events delivery
        join public.round_stops stop on stop.id = delivery.round_stop_id
        join public.delivery_rounds round on round.id = stop.round_id
        where stop.event_participation_id = v_participation.id
          and (round.service_date < p_start_date or round.service_date > p_end_date)
      ) then
      raise exception 'Participation dates cannot exclude an existing delivery';
    end if;
    v_before := to_jsonb(v_participation);
    update public.event_participations
    set shop_id = case when v_job.status = 'draft' then p_shop_id else v_participation.shop_id end,
        booth_number = nullif(trim(coalesce(p_booth_number, '')), ''),
        event_zone = nullif(trim(coalesce(p_event_zone, '')), ''),
        landmark = nullif(trim(coalesce(p_landmark, '')), ''),
        contact_name = nullif(trim(coalesce(p_contact_name, '')), ''),
        contact_phone = nullif(trim(coalesce(p_contact_phone, '')), ''),
        start_date = p_start_date,
        end_date = p_end_date,
        rents_tank_from_us = coalesce(p_rents_tank_from_us, false),
        updated_by = auth.uid()
    where id = p_participation_id
    returning * into v_participation;
  end if;

  insert into public.audit_logs (
    actor_id, entity_type, entity_id, action, before_value, after_value
  ) values (
    auth.uid(), 'event_participation', v_participation.id,
    case
      when p_participation_id is null then 'create'
      when v_job.status = 'draft' then 'update_draft'
      else 'update_published'
    end,
    v_before, to_jsonb(v_participation)
  );
  return v_participation;
end;
$$;

notify pgrst, 'reload schema';
