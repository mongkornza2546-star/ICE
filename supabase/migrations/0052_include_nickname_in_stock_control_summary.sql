-- Stock-control shows the responsible employee's nickname when one is set.
-- The previous summary wrapper predated the nickname column and omitted it.

create or replace function public.get_stock_control_summary(
  p_round_id uuid default null,
  p_service_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_locations jsonb;
begin
  v_result := public.get_stock_control_summary_v2(p_round_id, p_service_date);

  select coalesce(jsonb_agg(
    location_value || jsonb_build_object(
      'assigned_employee', case
        when coalesce((v_result ->> 'is_snapshot')::boolean, false) then null
        else (
          select jsonb_build_object(
            'id', employee.id,
            'code', employee.code,
            'display_name', employee.display_name,
            'nickname', employee.nickname
          )
          from public.users employee
          where employee.id = location.assigned_user_id
            and employee.is_active
        )
      end,
      'assigned_work_sites', case
        when coalesce((v_result ->> 'is_snapshot')::boolean, false) then '[]'::jsonb
        else coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', work_site.id,
            'code', work_site.code,
            'name', work_site.name
          ) order by work_site.code, work_site.name)
          from public.employee_work_site_assignments assignment
          join public.stock_locations work_site on work_site.id = assignment.stock_location_id
          where assignment.user_id = location.assigned_user_id
            and work_site.kind = 'work_site'
            and work_site.is_active
        ), '[]'::jsonb)
      end,
      'assigned_employees', case
        when coalesce((v_result ->> 'is_snapshot')::boolean, false) then '[]'::jsonb
        when location.kind = 'work_site' then coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', employee.id,
            'code', employee.code,
            'display_name', employee.display_name,
            'nickname', employee.nickname
          ) order by employee.code, employee.display_name)
          from public.employee_work_site_assignments assignment
          join public.users employee on employee.id = assignment.user_id
          where assignment.stock_location_id = location.id
            and employee.is_active
        ), '[]'::jsonb)
        else '[]'::jsonb
      end
    ) order by location_ordinality
  ), '[]'::jsonb)
  into v_locations
  from jsonb_array_elements(coalesce(v_result -> 'locations', '[]'::jsonb))
    with ordinality as summary_location(location_value, location_ordinality)
  left join public.stock_locations location
    on location.id = (location_value ->> 'id')::uuid;

  return jsonb_set(v_result, '{locations}', v_locations, true);
end;
$$;

revoke all on function public.get_stock_control_summary(uuid, date) from public;
grant execute on function public.get_stock_control_summary(uuid, date) to authenticated;
