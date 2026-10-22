-- Realtime applies SELECT policies to stock_movements. Couriers need changes
-- affecting the same dated truck/holding ledger exposed by their stock RPC.
-- A shared truck may be changed by a different round on the same service date.
create function public.can_read_employee_stock_movement(
  p_service_date date,
  p_from_location_id uuid,
  p_to_location_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user()
    and public.current_app_role() = 'courier'
    and exists (
      select 1 from public.delivery_round_members member
      join public.delivery_rounds round on round.id = member.round_id
      where member.user_id = auth.uid() and round.service_date = p_service_date
    )
    and exists (
      select 1 from public.stock_locations location
      where location.id in (p_from_location_id, p_to_location_id)
        and location.is_active
        and (
          (location.kind = 'truck' and location.is_courier_source)
          or (location.kind in ('team', 'small_vehicle') and location.assigned_user_id = auth.uid())
        )
    );
$$;

revoke all on function public.can_read_employee_stock_movement(date, uuid, uuid) from public, anon;
grant execute on function public.can_read_employee_stock_movement(date, uuid, uuid) to authenticated;

create policy "couriers read related dated stock movements"
  on public.stock_movements for select to authenticated
  using (public.can_read_employee_stock_movement(service_date, from_location_id, to_location_id));

-- No item, insert, update or delete policy is added. Mutations still use the
-- existing transactional RPCs; managers retain their existing SELECT policy.
grant select on public.stock_movements to authenticated;

notify pgrst, 'reload schema';
