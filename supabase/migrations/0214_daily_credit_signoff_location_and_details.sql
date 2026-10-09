-- Expose current shop location for filtering and live INV lines for a read-only detail view.
create or replace function public.list_daily_credit_acknowledgements(p_service_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_service_date is null then
    raise exception 'Service date is required';
  end if;

  return coalesce((
    with source_rows as (
      select * from public.daily_credit_acknowledgement_source(p_service_date)
    ), source as (
      select
        source_rows.shop_id,
        min(source_rows.shop_code) as shop_code,
        min(source_rows.shop_name) as shop_name,
        min(source_rows.shop_location) as shop_location,
        count(*)::integer as invoice_count,
        sum(source_rows.total_amount)::numeric(12,2) as total_amount,
        max(source_rows.recorded_at) as latest_delivery_at,
        md5(jsonb_agg(
          source_rows.fingerprint_data order by source_rows.recorded_at, source_rows.charge_id
        )::text) as source_fingerprint
      from source_rows
      group by source_rows.shop_id
    ), open_rounds as (
      select count(*)::integer as count
      from public.delivery_rounds round
      where round.service_date = p_service_date and round.status = 'open'
    )
    select jsonb_agg(jsonb_build_object(
      'shop_id', source.shop_id,
      'shop_code', source.shop_code,
      'shop_name', source.shop_name,
      'shop_location', source.shop_location,
      'image_path', shop.image_path,
      'building_id', shop.building_id,
      'building_name', building.name,
      'zone_id', shop.zone_id,
      'zone_name', zone.name,
      'invoice_count', source.invoice_count,
      'total_amount', source.total_amount,
      'latest_delivery_at', source.latest_delivery_at,
      'open_round_count', open_rounds.count,
      'document_id', document.id,
      'document_version', document.version,
      'is_stale', document.id is not null and document.source_fingerprint <> source.source_fingerprint,
      'evidence_count', coalesce(evidence.count, 0),
      'latest_evidence_path', evidence.latest_path
    ) order by source.shop_code)
    from source
    join public.shops shop on shop.id = source.shop_id
    join public.buildings building on building.id = shop.building_id
    left join public.building_zones zone on zone.id = shop.zone_id
    cross join open_rounds
    left join lateral (
      select acknowledgement.id, acknowledgement.version, acknowledgement.source_fingerprint
      from public.daily_credit_acknowledgements acknowledgement
      where acknowledgement.shop_id = source.shop_id
        and acknowledgement.service_date = p_service_date
      order by acknowledgement.version desc
      limit 1
    ) document on true
    left join lateral (
      select
        count(*)::integer as count,
        (array_agg(evidence.storage_path order by evidence.uploaded_at desc))[1] as latest_path
      from public.daily_credit_acknowledgement_evidence evidence
      where evidence.acknowledgement_id = document.id
    ) evidence on true
  ), '[]'::jsonb);
end;
$$;

create function public.get_daily_credit_acknowledgement_details(
  p_shop_id uuid,
  p_service_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_shop_id is null or p_service_date is null then
    raise exception 'Shop and service date are required';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'charge_id', source.charge_id,
      'document_number', source.document_number,
      'recorded_at', source.recorded_at,
      'recorded_by', source.recorded_by,
      'due_date', source.due_date,
      'items', source.items,
      'total_amount', source.total_amount
    ) order by source.recorded_at, source.charge_id)
    from public.daily_credit_acknowledgement_source(p_service_date, p_shop_id) source
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_daily_credit_acknowledgement_details(uuid, date) from public, anon, authenticated;
grant execute on function public.get_daily_credit_acknowledgement_details(uuid, date) to authenticated;
notify pgrst, 'reload schema';
