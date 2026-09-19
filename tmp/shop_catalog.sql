select jsonb_agg(
  jsonb_build_object(
    'code', shop.code,
    'name', shop.name,
    'building', building.code,
    'zone', zone.code,
    'status', shop.status
  ) order by shop.code
) as shops
from public.shops shop
join public.buildings building on building.id = shop.building_id
left join public.building_zones zone on zone.id = shop.zone_id;
