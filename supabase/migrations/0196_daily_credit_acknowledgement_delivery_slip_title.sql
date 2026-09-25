create or replace function public.build_daily_credit_acknowledgement_document(
  p_document_id uuid,
  p_shop_id uuid,
  p_service_date date,
  p_version integer,
  p_generated_at timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with source as (
    select *
    from public.daily_credit_acknowledgement_source(p_service_date, p_shop_id)
  ), item_totals as (
    select
      item ->> 'ice_type_name' as name,
      item ->> 'ice_type_unit' as unit,
      sum((item ->> 'quantity')::numeric(12,1)) as quantity,
      sum((item ->> 'line_total')::numeric(12,2)) as line_total
    from source
    cross join lateral jsonb_array_elements(source.items) item
    group by item ->> 'ice_type_name', item ->> 'ice_type_unit'
  )
  select jsonb_build_object(
    'document_type', 'DAILY_CREDIT_ACK',
    'document_id', p_document_id,
    'document_title', 'ใบส่งของ',
    'version', p_version,
    'generated_at', p_generated_at,
    'service_date', p_service_date,
    'shop_code', min(source.shop_code),
    'shop_name', min(source.shop_name),
    'shop_location', min(source.shop_location),
    'invoices', coalesce(jsonb_agg(jsonb_build_object(
      'charge_id', source.charge_id,
      'document_number', source.document_number,
      'recorded_at', source.recorded_at,
      'recorded_by', source.recorded_by,
      'due_date', source.due_date,
      'items', source.items,
      'total_amount', source.total_amount
    ) order by source.recorded_at, source.charge_id), '[]'::jsonb),
    'item_totals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', item_totals.name,
        'unit', item_totals.unit,
        'quantity', item_totals.quantity,
        'line_total', item_totals.line_total
      ) order by item_totals.name)
      from item_totals
    ), '[]'::jsonb),
    'total_amount', coalesce(sum(source.total_amount), 0)
  )
  from source;
$$;
