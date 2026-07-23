-- Paginated stock-count history for the dedicated Audit view.

create or replace function public.get_location_count_history_v2(
  p_service_date date,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view stock counts';
  end if;

  if p_service_date is null then
    raise exception 'A stock service date is required';
  end if;

  if p_limit < 1 or p_limit > 100 or p_offset < 0 then
    raise exception 'Invalid stock count history page';
  end if;

  select jsonb_build_object(
    'snapshots', coalesce((
      select jsonb_agg(to_jsonb(history) order by history.counted_at desc, history.id desc)
      from (
        select
          snapshot.id,
          snapshot.counted_at,
          snapshot.note,
          location.id as location_id,
          location.name as location_name,
          counter.display_name as counted_by,
          (
            select coalesce(jsonb_agg(jsonb_build_object(
              'ice_type_id', item.ice_type_id,
              'ice_type_name', ice.name,
              'unit', ice.unit,
              'system_quantity', item.system_quantity,
              'actual_quantity', item.actual_quantity,
              'variance_quantity', item.variance_quantity
            ) order by ice.code), '[]'::jsonb)
            from public.stock_count_snapshot_items item
            join public.ice_types ice on ice.id = item.ice_type_id
            where item.snapshot_id = snapshot.id
          ) as items
        from public.stock_count_snapshots snapshot
        join public.stock_locations location on location.id = snapshot.location_id
        join public.users counter on counter.id = snapshot.counted_by
        where snapshot.service_date = p_service_date
        order by snapshot.counted_at desc, snapshot.id desc
        limit p_limit
        offset p_offset
      ) history
    ), '[]'::jsonb),
    'total_count', (
      select count(*)::integer
      from public.stock_count_snapshots snapshot
      where snapshot.service_date = p_service_date
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_location_count_history_v2(date, integer, integer) from public;
grant execute on function public.get_location_count_history_v2(date, integer, integer) to authenticated;
