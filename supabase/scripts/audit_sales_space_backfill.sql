-- Read-only preflight for normalized sales-space ownership.
-- Run this against the target database before migration 0136.
-- Every result set must be reviewed; this script performs no writes.

-- 1. Backfill population and immediate blockers.
with normalized_shops as (
  select
    id,
    code as shop_code,
    status,
    zone_id,
    government_shop_code as raw_space_code,
    nullif(upper(trim(coalesce(government_shop_code, ''))), '') as space_code
  from public.shops
), code_groups as (
  select
    space_code,
    count(*) filter (where status = 'active') as active_shop_count,
    count(*) filter (where status = 'inactive') as inactive_shop_count,
    count(distinct zone_id) as zone_count
  from normalized_shops
  where space_code is not null
  group by space_code
)
select
  (select count(*) from normalized_shops) as total_shops,
  (select count(*) from normalized_shops where space_code is not null) as shops_with_space_code,
  (select count(*) from normalized_shops where raw_space_code is not null and space_code is null) as blank_space_codes,
  (select count(*) from code_groups) as distinct_sales_spaces,
  (select count(*) from code_groups where active_shop_count > 1) as active_assignment_conflicts,
  (select count(*) from code_groups where inactive_shop_count > 1) as unknown_history_groups,
  (select count(*) from code_groups where zone_count > 1) as zone_conflicts,
  (select count(*) from public.round_stops) as existing_round_stops_without_space_snapshot;

-- 2. Blocking: more than one active shop claims the same normalized code.
select
  upper(trim(government_shop_code)) as space_code,
  count(*) as active_shop_count,
  array_agg(code order by code) as active_shop_codes
from public.shops
where status = 'active'
  and nullif(trim(government_shop_code), '') is not null
group by upper(trim(government_shop_code))
having count(*) > 1
order by space_code;

-- 3. Blocking: one physical code points at more than one current zone.
-- Resolve the authoritative zone before backfill; do not choose by updated_at.
select
  upper(trim(shop.government_shop_code)) as space_code,
  count(distinct shop.zone_id) as zone_count,
  array_agg(distinct building.code || ' / ' || zone.code order by building.code || ' / ' || zone.code) as locations,
  array_agg(shop.code order by shop.code) as shop_codes
from public.shops shop
join public.building_zones zone on zone.id = shop.zone_id
join public.buildings building on building.id = zone.building_id
where nullif(trim(shop.government_shop_code), '') is not null
group by upper(trim(shop.government_shop_code))
having count(distinct shop.zone_id) > 1
order by space_code;

-- 4. Review: legacy reuse whose chronology is unknown. These relationships are
-- real, but no exact start/end dates can be derived from generic timestamps.
select
  upper(trim(government_shop_code)) as space_code,
  count(*) filter (where status = 'inactive') as inactive_shop_count,
  array_agg(code order by code) filter (where status = 'inactive') as inactive_shop_codes,
  array_agg(code order by code) filter (where status = 'active') as active_shop_codes
from public.shops
where nullif(trim(government_shop_code), '') is not null
group by upper(trim(government_shop_code))
having count(*) filter (where status = 'inactive') > 1
order by space_code;

-- 5. Review: normalization changes that users will see after cutover.
select
  code as shop_code,
  government_shop_code as raw_space_code,
  upper(trim(government_shop_code)) as normalized_space_code
from public.shops
where nullif(trim(government_shop_code), '') is not null
  and government_shop_code is distinct from upper(trim(government_shop_code))
order by normalized_space_code, shop_code;

-- 6. Review: active shops without a sales-space assignment remain supported,
-- but their future delivery stops cannot answer location-by-space questions.
select shop.id, shop.code, shop.name, building.code as building_code, zone.code as zone_code
from public.shops shop
join public.building_zones zone on zone.id = shop.zone_id
join public.buildings building on building.id = zone.building_id
where shop.status = 'active'
  and nullif(trim(coalesce(shop.government_shop_code, '')), '') is null
order by building.code, zone.sort_order, shop.code;

-- 7. Review: existing delivery history cannot be assigned a historical space
-- from the mutable current shop field without inventing facts.
select
  count(*) as round_stop_count,
  min(round.service_date) as first_service_date,
  max(round.service_date) as last_service_date,
  count(*) filter (
    where nullif(trim(coalesce(shop.government_shop_code, '')), '') is null
  ) as current_shop_has_no_space_code,
  count(*) filter (where shop.status = 'inactive') as now_inactive_shop_stop_count
from public.round_stops stop
join public.delivery_rounds round on round.id = stop.round_id
join public.shops shop on shop.id = stop.shop_id;
