-- Update receipt, accounting and validation labels in existing installations.
-- CREATE OR REPLACE preserves function signatures, ownership and permissions.
do $cash_sale_labels$
declare
  v_function record;
  v_definition text;
  v_receipt_display text := '(snapshot.receipt_data || jsonb_build_object(''shop_name'', ''ลูกค้าขายสด''))';
begin
  for v_function in
    select pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and (strpos(p.prosrc, 'ขาจร') > 0
        or strpos(p.prosrc, 'public.casual_receipt_snapshots snapshot') > 0)
  loop
    v_definition := replace(v_function.definition, 'ขาจร', 'ขายสด');
    -- Present historical receipts with the current label without rewriting
    -- immutable snapshots, including replay and accounting detail responses.
    if strpos(v_definition, 'public.casual_receipt_snapshots snapshot') > 0
      and strpos(v_definition, v_receipt_display) = 0 then
      v_definition := replace(v_definition, 'snapshot.receipt_data', v_receipt_display);
    end if;
    execute v_definition;
  end loop;
end;
$cash_sale_labels$;

notify pgrst, 'reload schema';
