-- Expose only the profile fields needed for collection assignments without
-- broadening round-lead access to public.users.

create or replace function public.get_collection_collectors()
returns table (
  id uuid,
  code text,
  display_name text,
  nickname text,
  avatar_path text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view collection collectors';
  end if;

  return query
  select
    app_user.id,
    app_user.code,
    app_user.display_name,
    app_user.nickname,
    app_user.avatar_path
  from public.users app_user
  where app_user.role = 'courier'
    and app_user.is_active
  order by app_user.code;
end;
$$;

create or replace function public.open_collection_run(
  p_service_date date,
  p_member_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can open collection runs';
  elsif p_service_date is null then
    raise exception 'A service date is required';
  elsif jsonb_typeof(coalesce(p_member_ids, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Collection members must be a JSON array';
  elsif exists (
    select 1
    from jsonb_to_recordset(coalesce(p_member_ids, '[]'::jsonb)) member(user_id uuid)
    left join public.users app_user on app_user.id = member.user_id
    where app_user.id is null
      or not app_user.is_active
      or app_user.role <> 'courier'
  ) then
    raise exception 'Collection members must be active couriers';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('collection-run:' || p_service_date::text, 0));

  select run.id into v_run_id
  from public.collection_runs run
  where run.service_date = p_service_date and run.status = 'open';

  if v_run_id is null then
    insert into public.collection_runs (service_date, opened_by)
    values (p_service_date, auth.uid()) returning id into v_run_id;
  end if;

  delete from public.collection_run_members existing
  where existing.collection_run_id = v_run_id
    and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_member_ids, '[]'::jsonb)) member(user_id uuid)
      where member.user_id = existing.user_id
    );

  insert into public.collection_run_members (collection_run_id, user_id)
  select v_run_id, member.user_id
  from jsonb_to_recordset(coalesce(p_member_ids, '[]'::jsonb)) as member(user_id uuid)
  join public.users app_user
    on app_user.id = member.user_id
    and app_user.is_active
    and app_user.role = 'courier'
  on conflict do nothing;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'collection_runs', v_run_id, 'opened',
    jsonb_build_object('service_date', p_service_date, 'member_ids', coalesce(p_member_ids, '[]'::jsonb))
  );

  return jsonb_build_object(
    'collection_run_id', v_run_id,
    'service_date', p_service_date,
    'status', 'open'
  );
end;
$$;

revoke all on function public.get_collection_collectors() from public;
revoke all on function public.open_collection_run(date, jsonb) from public;

grant execute on function public.get_collection_collectors() to authenticated;
grant execute on function public.open_collection_run(date, jsonb) to authenticated;
