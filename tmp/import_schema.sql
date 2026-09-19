select
  table_name,
  jsonb_agg(
    jsonb_build_object(
      'column', column_name,
      'type', data_type,
      'udt', udt_name,
      'nullable', is_nullable,
      'default', column_default,
      'generated', is_generated
    ) order by ordinal_position
  ) as columns
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'delivery_rounds',
    'round_stops',
    'delivery_events',
    'delivery_items',
    'delivery_charges',
    'payments',
    'payment_allocations',
    'casual_transactions',
    'casual_receipt_snapshots',
    'shop_payment_profiles',
    'ice_type_prices',
    'shop_ice_type_prices'
  )
group by table_name
order by table_name;
