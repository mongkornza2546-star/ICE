-- Event delivery Slice A: read-only event cards and destination-aware counts.
--
-- Event stop and delivery writers remain disabled. This migration makes the
-- manager summaries safe for mixed destinations and exposes a courier-readable
-- event read model for internal validation before any event stop can be synced.

do $$
begin
  if to_regclass('public.event_jobs') is null
    or to_regclass('public.event_participations') is null
    or to_regclass('public.event_delivery_feature_settings') is null
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'round_stops'
        and column_name = 'destination_kind'
    ) then
    raise exception
      'Migration 0165 requires the event lifecycle and destination compatibility foundations';
  end if;
end $$;

alter table public.event_delivery_feature_settings
  add column if not exists event_reads_enabled boolean not null default false;

update public.event_delivery_feature_settings
set schema_version = greatest(schema_version, 2),
    event_reads_enabled = true,
    updated_at = now()
where singleton;

alter table public.round_close_summaries
  add column if not exists regular_stop_count integer not null default 0,
  add column if not exists regular_delivered_stop_count integer not null default 0,
  add column if not exists regular_pending_stop_count integer not null default 0,
  add column if not exists regular_problem_stop_count integer not null default 0,
  add column if not exists event_stop_count integer not null default 0,
  add column if not exists event_delivered_stop_count integer not null default 0,
  add column if not exists event_pending_stop_count integer not null default 0,
  add column if not exists event_problem_stop_count integer not null default 0;

-- Operational event stops cannot exist before this migration. Preserve the
-- historical aggregate exactly and classify every earlier snapshot as regular.
update public.round_close_summaries
set regular_stop_count = total_shop_count,
    regular_delivered_stop_count = delivered_shop_count,
    regular_pending_stop_count = pending_shop_count,
    regular_problem_stop_count = problem_shop_count,
    event_stop_count = 0,
    event_delivered_stop_count = 0,
    event_pending_stop_count = 0,
    event_problem_stop_count = 0;

alter table public.round_close_summaries
  drop constraint if exists round_close_destination_counts_check,
  add constraint round_close_destination_counts_check check (
    regular_stop_count >= 0
    and regular_delivered_stop_count >= 0
    and regular_pending_stop_count >= 0
    and regular_problem_stop_count >= 0
    and event_stop_count >= 0
    and event_delivered_stop_count >= 0
    and event_pending_stop_count >= 0
    and event_problem_stop_count >= 0
    and regular_delivered_stop_count + regular_pending_stop_count
      + regular_problem_stop_count = regular_stop_count
    and event_delivered_stop_count + event_pending_stop_count
      + event_problem_stop_count = event_stop_count
    and regular_stop_count + event_stop_count = total_shop_count
    and regular_delivered_stop_count + event_delivered_stop_count = delivered_shop_count
    and regular_pending_stop_count + event_pending_stop_count = pending_shop_count
    and regular_problem_stop_count + event_problem_stop_count = problem_shop_count
  );

create or replace function public.populate_round_close_destination_counts()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select
    count(*),
    count(*) filter (where stop.status = 'delivered'),
    count(*) filter (where stop.status = 'pending'),
    count(*) filter (where stop.status not in ('pending', 'delivered')),
    count(*) filter (where stop.destination_kind = 'regular'),
    count(*) filter (
      where stop.destination_kind = 'regular' and stop.status = 'delivered'
    ),
    count(*) filter (
      where stop.destination_kind = 'regular' and stop.status = 'pending'
    ),
    count(*) filter (
      where stop.destination_kind = 'regular'
        and stop.status not in ('pending', 'delivered')
    ),
    count(*) filter (where stop.destination_kind = 'event'),
    count(*) filter (
      where stop.destination_kind = 'event' and stop.status = 'delivered'
    ),
    count(*) filter (
      where stop.destination_kind = 'event' and stop.status = 'pending'
    ),
    count(*) filter (
      where stop.destination_kind = 'event'
        and stop.status not in ('pending', 'delivered')
    )
  into
    new.total_shop_count,
    new.delivered_shop_count,
    new.pending_shop_count,
    new.problem_shop_count,
    new.regular_stop_count,
    new.regular_delivered_stop_count,
    new.regular_pending_stop_count,
    new.regular_problem_stop_count,
    new.event_stop_count,
    new.event_delivered_stop_count,
    new.event_pending_stop_count,
    new.event_problem_stop_count
  from public.round_stops stop
  where stop.round_id = new.round_id;

  return new;
end;
$$;

drop trigger if exists round_close_summaries_populate_destination_counts
on public.round_close_summaries;
create trigger round_close_summaries_populate_destination_counts
before insert on public.round_close_summaries
for each row execute function public.populate_round_close_destination_counts();

create or replace function public.get_round_control_summary(p_round_id uuid)
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
    raise exception 'Only a round lead or admin can view round control';
  end if;

  if not exists (select 1 from public.delivery_rounds where id = p_round_id) then
    raise exception 'The selected delivery round does not exist';
  end if;

  select jsonb_build_object(
    'stop_counts', jsonb_build_object(
      'total', count(*),
      'delivered', count(*) filter (where stop.status = 'delivered'),
      'pending', count(*) filter (where stop.status = 'pending'),
      'problem', count(*) filter (where stop.status not in ('pending', 'delivered'))
    ),
    'destination_counts', jsonb_build_object(
      'regular', jsonb_build_object(
        'total', count(*) filter (where stop.destination_kind = 'regular'),
        'delivered', count(*) filter (
          where stop.destination_kind = 'regular' and stop.status = 'delivered'
        ),
        'pending', count(*) filter (
          where stop.destination_kind = 'regular' and stop.status = 'pending'
        ),
        'problem', count(*) filter (
          where stop.destination_kind = 'regular'
            and stop.status not in ('pending', 'delivered')
        )
      ),
      'event', jsonb_build_object(
        'total', count(*) filter (where stop.destination_kind = 'event'),
        'delivered', count(*) filter (
          where stop.destination_kind = 'event' and stop.status = 'delivered'
        ),
        'pending', count(*) filter (
          where stop.destination_kind = 'event' and stop.status = 'pending'
        ),
        'problem', count(*) filter (
          where stop.destination_kind = 'event'
            and stop.status not in ('pending', 'delivered')
        )
      )
    ),
    'ice_counts', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'ice_type_id', ice.id,
          'ice_type_name', ice.name,
          'unit', ice.unit,
          'loaded_quantity', counts.loaded_quantity,
          'replenished_quantity', counts.replenished_quantity,
          'remaining_quantity', counts.remaining_quantity,
          'damaged_quantity', counts.damaged_quantity,
          'expected_quantity', counts.loaded_quantity + counts.replenished_quantity
            - counts.remaining_quantity - counts.damaged_quantity,
          'delivered_quantity', coalesce(delivered.quantity, 0),
          'variance_quantity', counts.loaded_quantity + counts.replenished_quantity
            - counts.remaining_quantity - counts.damaged_quantity
            - coalesce(delivered.quantity, 0)
        )
        order by ice.code
      )
      from public.round_ice_counts counts
      join public.ice_types ice on ice.id = counts.ice_type_id
      left join lateral (
        select sum(item.quantity) as quantity
        from public.round_stops delivery_stop
        join public.delivery_events delivery
          on delivery.round_stop_id = delivery_stop.id and delivery.status = 'active'
        join public.delivery_items item
          on item.delivery_event_id = delivery.id
          and item.ice_type_id = counts.ice_type_id
        where delivery_stop.round_id = counts.round_id
      ) delivered on true
      where counts.round_id = p_round_id
    ), '[]'::jsonb)
  )
  into v_result
  from public.round_stops stop
  where stop.round_id = p_round_id;

  return v_result;
end;
$$;

create or replace function public.daily_work_delivery_destination_summary(
  p_round_id uuid,
  p_service_date date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'activeDeliveryCount', count(charge.id),
    'actualShopCount', count(distinct charge.shop_id),
    'problemCount', (
      select count(*)
      from public.round_stops problem_stop
      where problem_stop.round_id = p_round_id
        and problem_stop.status = 'issue'
    ),
    'regularDeliveryCount', count(charge.id) filter (
      where stop.destination_kind = 'regular'
    ),
    'regularShopCount', count(distinct charge.shop_id) filter (
      where stop.destination_kind = 'regular'
    ),
    'regularProblemCount', (
      select count(*)
      from public.round_stops problem_stop
      where problem_stop.round_id = p_round_id
        and problem_stop.destination_kind = 'regular'
        and problem_stop.status = 'issue'
    ),
    'eventDeliveryCount', count(charge.id) filter (
      where stop.destination_kind = 'event'
    ),
    'eventParticipationCount', count(distinct stop.event_participation_id) filter (
      where stop.destination_kind = 'event'
    ),
    'eventProblemCount', (
      select count(*)
      from public.round_stops problem_stop
      where problem_stop.round_id = p_round_id
        and problem_stop.destination_kind = 'event'
        and problem_stop.status = 'issue'
    )
  )
  from public.delivery_charges charge
  join public.delivery_events delivery on delivery.id = charge.delivery_event_id
  join public.round_stops stop on stop.id = delivery.round_stop_id
  where charge.service_date = p_service_date
    and charge.status = 'active';
$$;

-- Patch only the dashboard's delivery-summary assignment. Keeping the rest of
-- the deployed dashboard body intact preserves later role-label fixes.
do $dashboard_patch$
declare
  v_definition text;
  v_old_summary constant text := $fragment$  select jsonb_build_object(
    'activeDeliveryCount', count(c.id),
    'actualShopCount', count(distinct c.shop_id),
    'problemCount', (
      select count(*)
      from public.round_stops s
      where (v_round.id is not null and s.round_id = v_round.id)
        and s.status = 'issue'
    )
  )
  into v_delivery_summary
  from public.delivery_charges c
  where c.service_date = v_service_date and c.status = 'active';$fragment$;
  v_new_summary constant text := $fragment$  v_delivery_summary := public.daily_work_delivery_destination_summary(
    v_round.id,
    v_service_date
  );$fragment$;
begin
  select pg_get_functiondef('public.get_daily_work_dashboard(date)'::regprocedure)
  into v_definition;

  if strpos(v_definition, v_old_summary) = 0 then
    raise exception 'get_daily_work_dashboard does not contain the expected delivery summary';
  end if;

  execute replace(v_definition, v_old_summary, v_new_summary);
end;
$dashboard_patch$;

create or replace function public.normalize_event_search_text(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(lower(coalesce(p_value, '')), '[[:space:][:punct:]]+', '', 'g');
$$;

create or replace function public.get_event_delivery_cards(
  p_round_id uuid,
  p_event_job_id uuid default null,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_round public.delivery_rounds%rowtype;
  v_search text := public.normalize_event_search_text(p_search);
  v_jobs jsonb;
  v_cards jsonb;
begin
  if not public.is_active_user() then
    raise exception 'Only active users can view event deliveries';
  end if;

  select * into v_round
  from public.delivery_rounds
  where id = p_round_id;

  if v_round.id is null then
    raise exception 'The selected delivery round does not exist';
  elsif v_round.round_type <> 'daily' or v_round.cancelled_at is not null then
    raise exception 'Event cards require a non-cancelled daily round';
  elsif public.current_app_role() not in ('admin', 'round_lead')
    and not public.is_round_member(p_round_id) then
    raise exception 'You are not assigned to this delivery round';
  elsif not exists (
    select 1
    from public.event_delivery_feature_settings settings
    where settings.singleton and settings.event_reads_enabled
  ) then
    raise exception 'Event delivery reads are not enabled';
  end if;

  if p_event_job_id is not null and not exists (
    select 1
    from public.event_jobs job
    where job.id = p_event_job_id
      and job.status = 'published'
      and v_round.service_date between job.start_date and job.end_date
      and exists (
        select 1
        from public.event_participations participation
        where participation.event_job_id = job.id
          and participation.status = 'active'
          and v_round.service_date between participation.start_date and participation.end_date
      )
  ) then
    raise exception 'The selected event is not active for this service date';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'event_job_id', job.id,
      'name', job.name,
      'organizer_name', job.organizer_name,
      'location', job.location,
      'start_date', job.start_date,
      'end_date', job.end_date,
      'participation_count', (
        select count(*)
        from public.event_participations participation
        where participation.event_job_id = job.id
          and participation.status = 'active'
          and v_round.service_date between participation.start_date and participation.end_date
      )
    ) order by job.name, job.id
  ), '[]'::jsonb)
  into v_jobs
  from public.event_jobs job
  where job.status = 'published'
    and v_round.service_date between job.start_date and job.end_date
    and exists (
      select 1
      from public.event_participations participation
      where participation.event_job_id = job.id
        and participation.status = 'active'
        and v_round.service_date between participation.start_date and participation.end_date
    );

  with eligible as (
    select
      participation.*,
      job.name as job_name,
      job.location as job_location,
      shop.code as shop_code,
      shop.name as shop_name,
      shop.contact_name as shop_contact_name,
      shop.contact_phone as shop_contact_phone
    from public.event_participations participation
    join public.event_jobs job on job.id = participation.event_job_id
    join public.shops shop on shop.id = participation.shop_id
    where job.status = 'published'
      and participation.status = 'active'
      and v_round.service_date between job.start_date and job.end_date
      and v_round.service_date between participation.start_date and participation.end_date
      and (p_event_job_id is null or job.id = p_event_job_id)
      and (
        v_search = ''
        or public.normalize_event_search_text(shop.code) like '%' || v_search || '%'
        or public.normalize_event_search_text(shop.name) like '%' || v_search || '%'
        or public.normalize_event_search_text(participation.booth_number) like '%' || v_search || '%'
        or public.normalize_event_search_text(participation.event_zone) like '%' || v_search || '%'
        or public.normalize_event_search_text(
          coalesce(participation.contact_name, shop.contact_name)
        ) like '%' || v_search || '%'
        or public.normalize_event_search_text(
          coalesce(participation.contact_phone, shop.contact_phone)
        ) like '%' || v_search || '%'
      )
  ), today_history as (
    select
      history_stop.event_participation_id,
      jsonb_agg(
        jsonb_build_object(
          'delivery_event_id', delivery.id,
          'recorded_at', delivery.recorded_at,
          'note', delivery.note,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'ice_type_id', ice.id,
              'ice_type_name', ice.name,
              'unit', ice.unit,
              'quantity', item.quantity
            ) order by ice.code)
            from public.delivery_items item
            join public.ice_types ice on ice.id = item.ice_type_id
            where item.delivery_event_id = delivery.id
          ), '[]'::jsonb)
        ) order by delivery.recorded_at, delivery.id
      ) as entries
    from public.round_stops history_stop
    join public.delivery_rounds history_round on history_round.id = history_stop.round_id
    join public.delivery_events delivery
      on delivery.round_stop_id = history_stop.id and delivery.status = 'active'
    where history_stop.destination_kind = 'event'
      and history_round.service_date = v_round.service_date
    group by history_stop.event_participation_id
  ), today_totals as (
    select
      totals.event_participation_id,
      jsonb_agg(jsonb_build_object(
        'ice_type_id', ice.id,
        'ice_type_name', ice.name,
        'unit', ice.unit,
        'quantity', totals.quantity
      ) order by ice.code) as items
    from (
      select history_stop.event_participation_id, item.ice_type_id, sum(item.quantity) as quantity
      from public.round_stops history_stop
      join public.delivery_rounds history_round on history_round.id = history_stop.round_id
      join public.delivery_events delivery
        on delivery.round_stop_id = history_stop.id and delivery.status = 'active'
      join public.delivery_items item on item.delivery_event_id = delivery.id
      where history_stop.destination_kind = 'event'
        and history_round.service_date = v_round.service_date
      group by history_stop.event_participation_id, item.ice_type_id
    ) totals
    join public.ice_types ice on ice.id = totals.ice_type_id
    group by totals.event_participation_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'event_participation_id', eligible.id,
      'event_job_id', eligible.event_job_id,
      'round_stop_id', current_stop.id,
      'event_name', coalesce(current_stop.event_job_name_snapshot, eligible.job_name),
      'location', coalesce(current_stop.event_location_snapshot, eligible.job_location),
      'shop_id', eligible.shop_id,
      'shop_code', coalesce(current_stop.shop_code_snapshot, eligible.shop_code),
      'shop_name', coalesce(current_stop.shop_name_snapshot, eligible.shop_name),
      'booth_number', coalesce(current_stop.event_booth_snapshot, eligible.booth_number),
      'event_zone', coalesce(current_stop.event_zone_snapshot, eligible.event_zone),
      'landmark', coalesce(current_stop.event_landmark_snapshot, eligible.landmark),
      'contact_name', coalesce(
        current_stop.event_contact_name_snapshot,
        eligible.contact_name,
        eligible.shop_contact_name
      ),
      'contact_phone', coalesce(
        current_stop.event_contact_phone_snapshot,
        eligible.contact_phone,
        eligible.shop_contact_phone
      ),
      'rents_tank_from_us', eligible.rents_tank_from_us,
      'is_operational', coalesce(current_stop.is_operational, true),
      'today_history', coalesce(history.entries, '[]'::jsonb),
      'today_totals', coalesce(totals.items, '[]'::jsonb)
    ) order by eligible.event_zone nulls last, eligible.booth_number nulls last,
      eligible.shop_code, eligible.id
  ), '[]'::jsonb)
  into v_cards
  from eligible
  left join public.round_stops current_stop
    on current_stop.round_id = p_round_id
    and current_stop.destination_kind = 'event'
    and current_stop.event_participation_id = eligible.id
  left join today_history history on history.event_participation_id = eligible.id
  left join today_totals totals on totals.event_participation_id = eligible.id;

  return jsonb_build_object(
    'round_id', v_round.id,
    'service_date', v_round.service_date,
    'events', v_jobs,
    'cards', v_cards
  );
end;
$$;

create or replace function public.get_event_delivery_capability()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings public.event_delivery_feature_settings%rowtype;
begin
  if not public.is_active_user() then
    raise exception 'Only active users can inspect event delivery capability';
  end if;
  select * into v_settings
  from public.event_delivery_feature_settings
  where singleton;
  return jsonb_build_object(
    'schema_version', v_settings.schema_version,
    'lifecycle_enabled', v_settings.lifecycle_enabled,
    'event_reads_enabled', v_settings.event_reads_enabled,
    'event_stops_enabled', v_settings.event_stops_enabled,
    'event_ice_delivery_enabled', v_settings.event_ice_delivery_enabled,
    'event_tank_rental_enabled', v_settings.event_tank_rental_enabled,
    'online_only', true
  );
end;
$$;

revoke all on function public.normalize_event_search_text(text) from public, anon, authenticated;
revoke all on function public.daily_work_delivery_destination_summary(uuid, date)
  from public, anon, authenticated;
revoke all on function public.get_event_delivery_cards(uuid, uuid, text) from public, anon;
grant execute on function public.get_event_delivery_cards(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';
