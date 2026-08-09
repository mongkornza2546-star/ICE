-- Make the accounting shop summary follow operational area order and expose
-- complete per-zone totals independently from row pagination.

alter table public.buildings add column if not exists sort_order integer;
alter table public.shops add column if not exists delivery_sequence integer;

with ordered_buildings as (
  select id, row_number() over (order by created_at, id)::integer as next_sort_order
  from public.buildings
)
update public.buildings building
set sort_order = ordered.next_sort_order
from ordered_buildings ordered
where ordered.id = building.id and building.sort_order is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.shops'::regclass
      and conname = 'shops_delivery_sequence_positive'
  ) then
    alter table public.shops add constraint shops_delivery_sequence_positive
      check (delivery_sequence is null or delivery_sequence > 0);
  end if;
end;
$$;

create unique index if not exists shops_active_zone_delivery_sequence_uidx
  on public.shops (zone_id, delivery_sequence)
  where status = 'active' and delivery_sequence is not null;

create or replace function public.next_building_sort_order()
returns integer
language plpgsql
volatile
set search_path = public
as $$
declare
  v_next integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('building-sort-order', 0));
  select coalesce(max(building.sort_order), 0) + 1 into v_next
  from public.buildings building;
  return v_next;
end;
$$;

alter table public.buildings alter column sort_order
  set default public.next_building_sort_order();
alter table public.buildings alter column sort_order set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.buildings'::regclass
      and conname = 'buildings_sort_order_positive'
  ) then
    alter table public.buildings
      add constraint buildings_sort_order_positive check (sort_order > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.buildings'::regclass
      and conname = 'buildings_sort_order_unique'
  ) then
    alter table public.buildings add constraint buildings_sort_order_unique
      unique (sort_order) deferrable initially immediate;
  end if;
end;
$$;

create or replace function public.save_building_settings(
  p_building_id uuid,
  p_code text,
  p_name text,
  p_sort_order integer,
  p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_building_id uuid;
  v_current_sort_order integer;
  v_building_count integer;
  v_target_sort_order integer;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can save building settings';
  elsif nullif(trim(p_code), '') is null or nullif(trim(p_name), '') is null
    or p_sort_order is null or p_sort_order < 1 then
    raise exception 'Building code, name, and a positive sort order are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('building-sort-order', 0));
  set constraints buildings_sort_order_unique deferred;
  select count(*)::integer into v_building_count from public.buildings;

  if p_building_id is null then
    v_target_sort_order := least(p_sort_order, v_building_count + 1);
    update public.buildings
    set sort_order = sort_order + 1
    where sort_order >= v_target_sort_order;
    insert into public.buildings (code, name, sort_order, is_active)
    values (trim(p_code), trim(p_name), v_target_sort_order, coalesce(p_is_active, true))
    returning id into v_building_id;
  else
    select sort_order into v_current_sort_order
    from public.buildings where id = p_building_id for update;
    if v_current_sort_order is null then
      raise exception 'The selected building does not exist';
    end if;

    v_target_sort_order := least(p_sort_order, v_building_count);
    if v_target_sort_order < v_current_sort_order then
      update public.buildings set sort_order = sort_order + 1
      where sort_order >= v_target_sort_order and sort_order < v_current_sort_order;
    elsif v_target_sort_order > v_current_sort_order then
      update public.buildings set sort_order = sort_order - 1
      where sort_order > v_current_sort_order and sort_order <= v_target_sort_order;
    end if;

    update public.buildings
    set code = trim(p_code), name = trim(p_name), sort_order = v_target_sort_order,
      is_active = coalesce(p_is_active, true)
    where id = p_building_id
    returning id into v_building_id;
  end if;

  return v_building_id;
end;
$$;

revoke all on function public.save_building_settings(uuid, text, text, integer, boolean)
  from public;
grant execute on function public.save_building_settings(uuid, text, text, integer, boolean)
  to authenticated;

create or replace function public.save_shop(
  p_shop_id uuid,
  p_code text,
  p_name text,
  p_zone_id uuid,
  p_contact_name text,
  p_contact_phone text,
  p_normal_rounds_per_day smallint,
  p_access_note text,
  p_status public.shop_status,
  p_government_shop_code text,
  p_delivery_sequence integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can save shop settings';
  elsif p_delivery_sequence is not null and p_delivery_sequence < 1 then
    raise exception 'Delivery sequence must be a positive integer';
  end if;

  if p_shop_id is not null then
    update public.shops set delivery_sequence = null where id = p_shop_id;
  end if;

  v_shop_id := public.save_shop(
    p_shop_id, p_code, p_name, p_zone_id, p_contact_name, p_contact_phone,
    p_normal_rounds_per_day, p_access_note, p_status, p_government_shop_code
  );

  update public.shops set delivery_sequence = p_delivery_sequence where id = v_shop_id;
  return v_shop_id;
end;
$$;

revoke all on function public.save_shop(
  uuid, text, text, uuid, text, text, smallint, text,
  public.shop_status, text, integer
) from public;
grant execute on function public.save_shop(
  uuid, text, text, uuid, text, text, smallint, text,
  public.shop_status, text, integer
) to authenticated;

do $$
begin
  if to_regprocedure(
    'public.ensure_daily_delivery_round_before_area_order(date)'
  ) is null then
    execute 'alter function public.ensure_daily_delivery_round(date) '
      || 'rename to ensure_daily_delivery_round_before_area_order';
  end if;
end;
$$;

create or replace function public.ensure_daily_delivery_round(p_service_date date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_existing_round_id uuid;
  v_sequence_offset integer;
begin
  select id into v_existing_round_id
  from public.delivery_rounds
  where service_date = p_service_date and round_type = 'daily' and cancelled_at is null
  order by created_at asc limit 1;

  v_round_id := public.ensure_daily_delivery_round_before_area_order(p_service_date);
  if v_existing_round_id is not null then
    return v_round_id;
  end if;

  select coalesce(max(sequence_no), 0) + count(*)::integer into v_sequence_offset
  from public.round_stops where round_id = v_round_id;
  update public.round_stops
  set sequence_no = sequence_no + v_sequence_offset
  where round_id = v_round_id;

  with desired as (
    select stop.id,
      row_number() over (order by building.sort_order, zone.sort_order,
        shop.delivery_sequence nulls last, shop.code, shop.id)::integer as sequence_no
    from public.round_stops stop
    join public.shops shop on shop.id = stop.shop_id
    join public.buildings building on building.id = shop.building_id
    join public.building_zones zone on zone.id = shop.zone_id
    where stop.round_id = v_round_id
  )
  update public.round_stops stop
  set sequence_no = desired.sequence_no
  from desired where desired.id = stop.id;

  return v_round_id;
end;
$$;

revoke all on function public.ensure_daily_delivery_round_before_area_order(date)
  from public, authenticated;
revoke all on function public.ensure_daily_delivery_round(date) from public;
grant execute on function public.ensure_daily_delivery_round(date) to authenticated;

create or replace function public.get_accounting_shop_summary(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 100,
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
  v_limit integer := coalesce(p_limit, 100);
  v_offset integer := coalesce(p_offset, 0);
  v_shop_sort text := coalesce(nullif(p_filters ->> 'shop_sort', ''), 'area');
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view accounting shop summaries';
  elsif p_from_date is null or p_to_date is null or p_to_date < p_from_date then
    raise exception 'A valid accounting date range is required';
  elsif p_to_date - p_from_date > 30 then
    raise exception 'Accounting date range cannot exceed 31 days';
  elsif v_limit < 1 or v_limit > 500 or v_offset < 0 then
    raise exception 'Invalid accounting shop summary pagination';
  elsif nullif(p_filters ->> 'payment_term', '') is not null
    and p_filters ->> 'payment_term' not in ('immediate', 'end_of_day', 'credit') then
    raise exception 'Unsupported accounting payment term';
  elsif nullif(p_filters ->> 'payment_status', '') is not null
    and p_filters ->> 'payment_status' not in ('paid', 'outstanding', 'overdue') then
    raise exception 'Unsupported accounting payment status';
  elsif v_shop_sort not in ('area', 'outstanding', 'overdue', 'sales', 'name', 'code') then
    raise exception 'Unsupported accounting shop sort';
  end if;

  with registry_shops as materialized (
    select
      shop.id as shop_id,
      shop.code as shop_code,
      shop.name as shop_name,
      shop.building_id,
      building.name as building_name,
      building.sort_order as building_sort_order,
      shop.zone_id as current_zone_id,
      zone.name as current_zone_name,
      zone.sort_order as zone_sort_order,
      shop.delivery_sequence,
      coalesce(stop_activity.has_closed_shop, false) as has_closed_shop,
      coalesce(stop_activity.has_recorded_activity, false) as has_recorded_activity,
      profile.allowed_payment_terms,
      case
        when profile.shop_id is null then null
        when nullif(p_filters ->> 'payment_term', '') is not null
          then p_filters ->> 'payment_term'
        when cardinality(profile.allowed_payment_terms) > 1 then 'mixed'
        else profile.default_payment_term::text
      end as payment_term
    from public.shops shop
    join public.buildings building on building.id = shop.building_id
    join public.building_zones zone on zone.id = shop.zone_id
    left join public.shop_payment_profiles profile on profile.shop_id = shop.id
    left join lateral (
      select
        bool_or(stop.status::text = 'closed_shop') as has_closed_shop,
        bool_or(stop.status::text <> 'pending') as has_recorded_activity
      from public.round_stops stop
      join public.delivery_rounds round on round.id = stop.round_id
      where stop.shop_id = shop.id
        and round.service_date between p_from_date and p_to_date
        and round.cancelled_at is null
    ) stop_activity on true
    where shop.status = 'active'
  ), base_shops as materialized (
    select shop.*
    from registry_shops shop
    where (nullif(trim(p_filters ->> 'shop_search'), '') is null
        or shop.shop_code ilike '%' || trim(p_filters ->> 'shop_search') || '%'
        or shop.shop_name ilike '%' || trim(p_filters ->> 'shop_search') || '%')
      and (nullif(p_filters ->> 'shop_id', '') is null
        or shop.shop_id::text = p_filters ->> 'shop_id')
      and (nullif(p_filters ->> 'building_id', '') is null
        or shop.building_id::text = p_filters ->> 'building_id')
      and (nullif(p_filters ->> 'zone_id', '') is null
        or shop.current_zone_id::text = p_filters ->> 'zone_id')
  ), eligible_shops as materialized (
    select shop.*
    from base_shops shop
    where nullif(p_filters ->> 'payment_term', '') is null
      or (p_filters ->> 'payment_term')::public.payment_term = any(shop.allowed_payment_terms)
  ), eligible_charges as materialized (
    select
      charge.id as charge_id,
      charge.shop_id,
      charge.service_date between p_from_date and p_to_date as is_period,
      coalesce(charge.due_date, charge.service_date) as effective_due_date,
      public.effective_delivery_charge_amount(charge.id)::numeric as effective_amount,
      event.recorded_at,
      recorder.display_name as employee_name,
      stop.floor_or_zone_snapshot as historical_zone_name
    from eligible_shops shop
    join public.delivery_charges charge on charge.shop_id = shop.shop_id
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.users recorder on recorder.id = event.recorded_by
    join public.round_stops stop on stop.id = event.round_stop_id
    where charge.status = 'active'
      and event.status = 'active'
  ), charge_rows as materialized (
    select
      charge.*,
      least(charge.effective_amount, coalesce(allocation.allocated_amount, 0))::numeric
        as paid_amount,
      greatest(charge.effective_amount - coalesce(allocation.allocated_amount, 0), 0)::numeric
        as outstanding_amount
    from eligible_charges charge
    left join lateral (
      select coalesce(sum(payment_allocation.amount), 0)::numeric as allocated_amount
      from public.payment_allocations payment_allocation
      join public.payments payment on payment.id = payment_allocation.payment_id
      where payment_allocation.charge_id = charge.charge_id
        and payment.status = 'active'
    ) allocation on true
  ), shop_rows as materialized (
    select
      shop.shop_id,
      shop.shop_code,
      shop.shop_name,
      shop.building_id,
      shop.building_name,
      shop.building_sort_order,
      shop.current_zone_id,
      shop.current_zone_name,
      shop.zone_sort_order,
      shop.delivery_sequence,
      shop.has_closed_shop,
      shop.has_recorded_activity,
      (array_agg(charge.historical_zone_name
        order by charge.recorded_at desc, charge.charge_id desc)
        filter (where charge.is_period))[1] as historical_zone_name,
      shop.payment_term,
      string_agg(distinct charge.employee_name, ', ' order by charge.employee_name)
        filter (where charge.is_period) as employee_names,
      coalesce(sum(charge.effective_amount) filter (where charge.is_period), 0)::numeric
        as sales_amount,
      coalesce(sum(charge.paid_amount) filter (where charge.is_period), 0)::numeric
        as paid_amount,
      coalesce(sum(charge.outstanding_amount) filter (where charge.is_period), 0)::numeric
        as outstanding_amount,
      coalesce(sum(charge.outstanding_amount) filter (
        where charge.is_period
          and charge.effective_due_date < (now() at time zone 'Asia/Bangkok')::date
      ), 0)::numeric as overdue_amount,
      count(charge.charge_id) filter (where charge.is_period)::integer as invoice_count,
      min(charge.effective_due_date) filter (
        where charge.is_period and charge.outstanding_amount > 0
      ) as due_date,
      coalesce(sum(charge.outstanding_amount), 0)::numeric as cumulative_outstanding_amount,
      coalesce(sum(charge.outstanding_amount) filter (
        where charge.effective_due_date < (now() at time zone 'Asia/Bangkok')::date
      ), 0)::numeric as cumulative_overdue_amount,
      min(charge.effective_due_date) filter (
        where charge.outstanding_amount > 0
      ) as oldest_outstanding_due_date
    from eligible_shops shop
    left join charge_rows charge on charge.shop_id = shop.shop_id
    group by shop.shop_id, shop.shop_code, shop.shop_name, shop.building_id,
      shop.building_name, shop.building_sort_order, shop.current_zone_id,
      shop.current_zone_name, shop.zone_sort_order, shop.delivery_sequence,
      shop.has_closed_shop, shop.has_recorded_activity, shop.payment_term
  ), with_activity as materialized (
    select row.*,
      case
        when row.sales_amount > 0 then 'purchased'
        when row.has_closed_shop then 'closed_shop'
        when row.has_recorded_activity then 'recorded_no_sale'
        else 'not_recorded'
      end as period_activity_status
    from shop_rows row
  ), with_status as materialized (
    select row.*,
      case
        when row.cumulative_overdue_amount > 0 then 'overdue'
        when row.cumulative_outstanding_amount > 0 then 'outstanding'
        else 'paid'
      end as payment_status
    from with_activity row
  ), status_filtered as materialized (
    select row.*
    from with_status row
    where nullif(p_filters ->> 'payment_status', '') is null
      or row.payment_status = p_filters ->> 'payment_status'
  ), positioned as materialized (
    select row.*,
      row_number() over (order by
        case when v_shop_sort = 'area' then row.building_sort_order end,
        case when v_shop_sort = 'area' then row.zone_sort_order end,
        case when v_shop_sort = 'area' then row.delivery_sequence end nulls last,
        case when v_shop_sort = 'area' then row.shop_code end,
        case when v_shop_sort = 'outstanding' then row.cumulative_outstanding_amount end desc,
        case when v_shop_sort = 'overdue' then row.cumulative_overdue_amount end desc,
        case when v_shop_sort = 'sales' then row.sales_amount end desc,
        case when v_shop_sort = 'name' then lower(row.shop_name) end,
        case when v_shop_sort = 'code' then row.shop_code end,
        row.building_sort_order, row.zone_sort_order, row.delivery_sequence nulls last,
        row.shop_code, row.shop_id
      ) as sort_position
    from status_filtered row
  ), ordered as (
    select row.* from positioned row
    order by row.sort_position
    limit v_limit offset v_offset
  ), received_in_period as (
    select coalesce(sum(payment.allocated_amount), 0)::numeric as amount
    from public.payments payment
    join public.shops shop on shop.id = payment.shop_id
    where payment.status = 'active'
      and payment.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
      and payment.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
      and (nullif(trim(p_filters ->> 'shop_search'), '') is null
        or shop.code ilike '%' || trim(p_filters ->> 'shop_search') || '%'
        or shop.name ilike '%' || trim(p_filters ->> 'shop_search') || '%')
      and (nullif(p_filters ->> 'shop_id', '') is null
        or shop.id::text = p_filters ->> 'shop_id')
      and (nullif(p_filters ->> 'building_id', '') is null
        or shop.building_id::text = p_filters ->> 'building_id')
      and (nullif(p_filters ->> 'zone_id', '') is null
        or shop.zone_id::text = p_filters ->> 'zone_id')
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(row) - 'sort_position'
      order by row.sort_position) from ordered row), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(to_jsonb(group_row)
      order by group_row.building_sort_order, group_row.zone_sort_order,
        group_row.building_name, group_row.current_zone_name) from (
      select
        row.building_id, min(row.building_name) as building_name,
        row.current_zone_id, min(row.current_zone_name) as current_zone_name,
        min(row.building_sort_order) as building_sort_order,
        min(row.zone_sort_order) as zone_sort_order,
        count(*)::integer as total_shop_count,
        count(*) filter (where row.period_activity_status = 'purchased')::integer
          as purchased_shop_count,
        count(*) filter (where row.period_activity_status = 'closed_shop')::integer
          as closed_shop_count,
        count(*) filter (where row.period_activity_status = 'recorded_no_sale')::integer
          as recorded_no_sale_shop_count,
        count(*) filter (where row.period_activity_status = 'not_recorded')::integer
          as not_recorded_shop_count,
        coalesce(sum(row.sales_amount), 0)::numeric as sales_amount,
        coalesce(sum(row.cumulative_outstanding_amount), 0)::numeric
          as cumulative_outstanding_amount
      from status_filtered row
      group by row.building_id, row.current_zone_id
    ) group_row), '[]'::jsonb),
    'total_count', (select count(*) from status_filtered),
    'totals', jsonb_build_object(
      'sales_amount', coalesce((select sum(sales_amount) from status_filtered), 0),
      'paid_amount', coalesce((select sum(paid_amount) from status_filtered), 0),
      'outstanding_amount', coalesce((select sum(outstanding_amount) from status_filtered), 0),
      'overdue_amount', coalesce((select sum(overdue_amount) from status_filtered), 0),
      'outstanding_shop_count', (select count(*) from status_filtered where outstanding_amount > 0),
      'cumulative_outstanding_amount', coalesce((select sum(cumulative_outstanding_amount) from status_filtered), 0),
      'cumulative_overdue_amount', coalesce((select sum(cumulative_overdue_amount) from status_filtered), 0),
      'cumulative_outstanding_shop_count', (select count(*) from status_filtered where cumulative_outstanding_amount > 0),
      'cash_received_in_period', (select amount from received_in_period)
    ),
    'facets', jsonb_build_object(
      'shops', coalesce((select jsonb_agg(jsonb_build_object(
        'value', shop_id, 'label', concat_ws(' ', shop_code, shop_name), 'count', 1
      ) order by shop_code) from registry_shops), '[]'::jsonb),
      'buildings', coalesce((select jsonb_agg(jsonb_build_object(
        'value', building_id, 'label', building_name, 'count', shop_count
      ) order by building_sort_order, building_name) from (
        select building_id, min(building_name) building_name,
          min(building_sort_order) building_sort_order, count(*) shop_count
        from registry_shops group by building_id
      ) facet), '[]'::jsonb),
      'zones', coalesce((select jsonb_agg(jsonb_build_object(
        'value', zone_id,
        'label', case
          when nullif(p_filters ->> 'building_id', '') is null
            then concat_ws(' / ', building_name, zone_name)
          else zone_name
        end,
        'count', shop_count
      ) order by building_sort_order, zone_sort_order, building_name, zone_name) from (
        select building_id, current_zone_id zone_id, min(building_name) building_name,
          min(current_zone_name) zone_name, min(building_sort_order) building_sort_order,
          min(zone_sort_order) zone_sort_order, count(*) shop_count
        from registry_shops
        where nullif(p_filters ->> 'building_id', '') is null
          or building_id::text = p_filters ->> 'building_id'
        group by building_id, current_zone_id
      ) facet), '[]'::jsonb)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_accounting_shop_summary(date, date, jsonb, integer, integer)
  from public;
grant execute on function public.get_accounting_shop_summary(date, date, jsonb, integer, integer)
  to authenticated;

notify pgrst, 'reload schema';
