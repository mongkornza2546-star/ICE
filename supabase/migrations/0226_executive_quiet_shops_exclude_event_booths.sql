-- Event booths remain active for historical accounting after their event ends.
-- Match the regular shop directory: only shops without event_job_id are reorder
-- candidates. Keep event sales, receipts and debt in the financial report.
do $quiet_shop_scope$
declare
  v_definition text := pg_get_functiondef('public.executive_report_insights(date,date)'::regprocedure);
  v_old text := $old$where charge.status = 'active' and event.status = 'active' and shop.status = 'active'
      and charge.service_date between today.day - 89 and today.day$old$;
  v_new text := $new$where charge.status = 'active' and event.status = 'active' and shop.status = 'active'
      and shop.event_job_id is null
      and charge.service_date between today.day - 89 and today.day$new$;
begin
  if strpos(v_definition, v_new) > 0 then
    raise notice 'Quiet-shop event exclusion is already applied';
  elsif strpos(v_definition, v_old) > 0 then
    execute replace(v_definition, v_old, v_new);
  else
    raise exception 'Cannot scope quiet shops: executive insights definition has changed';
  end if;
end;
$quiet_shop_scope$;

notify pgrst, 'reload schema';
