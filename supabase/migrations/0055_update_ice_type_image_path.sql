-- Ice-type metadata is written through security-definer RPCs because the
-- underlying table has no direct write policy. Image changes must follow the
-- same path, otherwise PostgREST returns no row for a chained .single() call.

create or replace function public.update_ice_type_image_path(
  p_ice_type_id uuid,
  p_image_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saved public.ice_types%rowtype;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can update ice type images';
  end if;

  update public.ice_types
  set image_path = nullif(trim(p_image_path), '')
  where id = p_ice_type_id
  returning * into v_saved;

  if not found then
    raise exception 'The selected ice type does not exist';
  end if;

  return jsonb_build_object(
    'id', v_saved.id,
    'code', v_saved.code,
    'name', v_saved.name,
    'unit', v_saved.unit,
    'image_path', v_saved.image_path,
    'is_active', v_saved.is_active
  );
end;
$$;

revoke all on function public.update_ice_type_image_path(uuid, text) from public;
grant execute on function public.update_ice_type_image_path(uuid, text) to authenticated;
