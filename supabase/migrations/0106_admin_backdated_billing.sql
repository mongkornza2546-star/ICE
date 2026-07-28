-- Only admins may create a new delivery against a past service date.
-- Corrections keep their existing authorization path and are not treated as
-- new backdated sales by this guard.

create or replace function public.enforce_admin_backdated_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date;
begin
  select round.service_date
  into v_service_date
  from public.round_stops stop
  join public.delivery_rounds round on round.id = stop.round_id
  where stop.id = new.round_stop_id;

  if v_service_date > (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'A delivery cannot be recorded for a future service date';
  elsif new.corrects_event_id is not null then
    return new;
  elsif v_service_date < (clock_timestamp() at time zone 'Asia/Bangkok')::date
    and public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can record a backdated delivery';
  end if;

  return new;
end;
$$;

drop trigger if exists delivery_events_require_admin_for_backdated_sale
  on public.delivery_events;

create trigger delivery_events_require_admin_for_backdated_sale
before insert on public.delivery_events
for each row execute function public.enforce_admin_backdated_delivery();

revoke all on function public.enforce_admin_backdated_delivery() from public;
