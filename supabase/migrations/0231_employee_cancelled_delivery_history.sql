-- Show cancelled regular deliveries to every user authorized to view the round.
-- Keep the existing access checks, active-only totals and read-only cancelled rows.
do $employee_cancelled_history$
declare
  v_definition text;
  v_old text := $old$and (event.status = 'active'
        or (public.current_app_role() = 'admin' and event.status = 'cancelled'))$old$;
begin
  select pg_get_functiondef('public.get_round_shop_cards(uuid,uuid)'::regprocedure)
    into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'get_round_shop_cards is missing the expected admin-only history marker';
  end if;
  execute replace(v_definition, v_old, $new$and event.status in ('active', 'cancelled')$new$);
end;
$employee_cancelled_history$;

notify pgrst, 'reload schema';
