-- Enable Supabase Realtime publication for core operational tables
-- Idempotent script: safely checks if table exists and isn't already added to the publication

do $$
declare
  v_table text;
  v_tables text[] := array[
    'delivery_events',
    'delivery_charges',
    'payments',
    'payment_allocations',
    'stock_movements',
    'daily_credit_acknowledgements',
    'casual_transactions',
    'delivery_rounds',
    'round_stops',
    'shop_tank_rentals'
  ];
begin
  if not exists (
    select 1 from pg_catalog.pg_publication publication
    where publication.pubname = 'supabase_realtime'
  ) then
    raise exception 'The supabase_realtime publication is required';
  elsif exists (
    select 1 from pg_catalog.pg_publication publication
    where publication.pubname = 'supabase_realtime'
      and publication.puballtables
  ) then
    return;
  end if;

  foreach v_table in array v_tables loop
    -- Check if table exists in public schema
    if exists (
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = v_table
    ) then
      -- Check if already added to supabase_realtime publication
      if not exists (
        select 1
        from pg_catalog.pg_publication publication
        join pg_catalog.pg_publication_rel publication_rel
          on publication_rel.prpubid = publication.oid
        join pg_catalog.pg_class relation
          on relation.oid = publication_rel.prrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where publication.pubname = 'supabase_realtime'
          and namespace.nspname = 'public'
          and relation.relname = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
