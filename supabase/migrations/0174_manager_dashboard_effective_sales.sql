-- Preserve the existing destination counts and role checks while using the
-- same adjusted amounts as collection and accounting. Historical bills stay intact.
do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.get_daily_work_dashboard(date)'::regprocedure)
  into v_definition;
  if strpos(v_definition, 'sum(c.original_amount)') = 0
    or strpos(v_definition, '''net_amount'', charge.original_amount') = 0 then
    raise exception 'The dashboard sales expressions do not match the expected contract';
  end if;
  v_definition := replace(v_definition,
    'sum(c.original_amount)', 'sum(public.effective_delivery_charge_amount(c.id))');
  v_definition := replace(v_definition,
    '''net_amount'', charge.original_amount',
    '''net_amount'', public.effective_delivery_charge_amount(charge.id)');
  execute v_definition;
end;
$migration$;
