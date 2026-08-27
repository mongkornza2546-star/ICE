-- Phase 1 foundation for automatic shop-payment collection.
-- Existing couriers intentionally remain disabled until an admin opts them in.

alter table public.users
  add column can_collect_shop_payments boolean not null default false;

create or replace function public.enforce_user_collection_capability()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role <> 'courier' then
    new.can_collect_shop_payments := false;
  end if;
  return new;
end;
$$;

create trigger users_enforce_collection_capability
before insert or update of role, can_collect_shop_payments on public.users
for each row execute function public.enforce_user_collection_capability();

create or replace function public.can_collect_shop_payments()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select app_user.is_active and (
      app_user.role in ('admin', 'round_lead')
      or (app_user.role = 'courier' and app_user.can_collect_shop_payments)
    )
    from public.users app_user
    where app_user.id = auth.uid()
  ), false);
$$;

revoke all on function public.can_collect_shop_payments() from public;
grant execute on function public.can_collect_shop_payments() to authenticated;

create or replace function public.save_user_profile_with_work_site_assignments_v2(
  p_user_id uuid,
  p_display_name text,
  p_phone text,
  p_role public.app_role,
  p_is_active boolean,
  p_work_site_ids uuid[],
  p_nickname text,
  p_avatar_path text,
  p_can_collect_shop_payments boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_saved public.users%rowtype;
  v_avatar_path text := nullif(trim(coalesce(p_avatar_path, '')), '');
begin
  if v_avatar_path is not null
    and v_avatar_path not like 'users/' || p_user_id::text || '/%' then
    raise exception 'The avatar path does not belong to the selected user';
  end if;

  v_result := public.save_user_with_work_site_assignments(
    p_user_id,
    p_display_name,
    p_phone,
    p_role,
    p_is_active,
    p_work_site_ids
  );

  update public.users
  set nickname = nullif(trim(coalesce(p_nickname, '')), ''),
      avatar_path = v_avatar_path,
      can_collect_shop_payments = case
        when p_role = 'courier' then coalesce(p_can_collect_shop_payments, false)
        else false
      end
  where id = p_user_id
  returning * into v_saved;

  return jsonb_build_object(
    'user', to_jsonb(v_saved),
    'work_site_ids', coalesce(v_result -> 'work_site_ids', '[]'::jsonb)
  );
end;
$$;

revoke all on function public.save_user_profile_with_work_site_assignments_v2(
  uuid, text, text, public.app_role, boolean, uuid[], text, text, boolean
) from public;
grant execute on function public.save_user_profile_with_work_site_assignments_v2(
  uuid, text, text, public.app_role, boolean, uuid[], text, text, boolean
) to authenticated;

-- Compatibility path for older clients. A courier keeps their current value;
-- changing away from courier always clears it through both this wrapper and the trigger.
create or replace function public.save_user_profile_with_work_site_assignments(
  p_user_id uuid,
  p_display_name text,
  p_phone text,
  p_role public.app_role,
  p_is_active boolean,
  p_work_site_ids uuid[],
  p_nickname text,
  p_avatar_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.users%rowtype;
  v_capability boolean := false;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an active admin can edit users and their work sites';
  end if;

  select * into v_existing
  from public.users
  where id = p_user_id
  for update;

  if v_existing.id is null then
    raise exception 'The selected user does not exist';
  end if;

  if v_existing.role = 'courier' and p_role = 'courier' then
    v_capability := v_existing.can_collect_shop_payments;
  end if;

  return public.save_user_profile_with_work_site_assignments_v2(
    p_user_id,
    p_display_name,
    p_phone,
    p_role,
    p_is_active,
    p_work_site_ids,
    p_nickname,
    p_avatar_path,
    v_capability
  );
end;
$$;

revoke all on function public.save_user_profile_with_work_site_assignments(
  uuid, text, text, public.app_role, boolean, uuid[], text, text
) from public;
grant execute on function public.save_user_profile_with_work_site_assignments(
  uuid, text, text, public.app_role, boolean, uuid[], text, text
) to authenticated;

-- The lower-level writer must not be a public save path.
revoke all on function public.save_user_with_work_site_assignments(
  uuid, text, text, public.app_role, boolean, uuid[]
) from public, authenticated;

alter table public.payments
  add column recorded_role public.app_role;

update public.payments payment
set recorded_role = app_user.role
from public.users app_user
where app_user.id = payment.recorded_by;

do $$
begin
  if exists (select 1 from public.payments where recorded_role is null) then
    raise exception 'Cannot backfill payments.recorded_role for every existing payment';
  end if;
end;
$$;

alter table public.payments
  alter column recorded_role set not null;

create or replace function public.enforce_payment_recorded_role()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_role public.app_role;
begin
  if tg_op = 'INSERT' then
    v_role := public.current_app_role();
    if v_role is null then
      raise exception 'An active user role is required to record a payment';
    end if;
    new.recorded_role := v_role;
  elsif new.recorded_role is distinct from old.recorded_role then
    raise exception 'The recorded payment role cannot be changed';
  end if;
  return new;
end;
$$;

create trigger payments_enforce_recorded_role
before insert or update of recorded_role on public.payments
for each row execute function public.enforce_payment_recorded_role();

notify pgrst, 'reload schema';
