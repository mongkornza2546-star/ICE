-- Keep cancelled regular deliveries visible in the admin's daily shop history.
-- Patch only the history projection; active-only totals, event fencing, access
-- checks and current shop ordering remain in the existing read model.
do $admin_cancelled_history$
declare
  v_definition text;
  v_patch record;
begin
  select pg_get_functiondef('public.get_round_shop_cards(uuid,uuid)'::regprocedure)
    into v_definition;
  for v_patch in select * from (values
    ($old$event.recorded_by as recorded_by_id,$old$,
     $new$event.recorded_by as recorded_by_id,
      event.status as delivery_status, event.cancelled_at, event.cancellation_reason,
      (select canceller.display_name from public.users canceller
        where canceller.id = event.cancelled_by) as cancelled_by,$new$),
    ($old$join public.delivery_events event on event.round_stop_id = day_stop.id and event.status = 'active'
    join public.users recorder$old$,
     $new$join public.delivery_events event on event.round_stop_id = day_stop.id
      and (event.status = 'active'
        or (public.current_app_role() = 'admin' and event.status = 'cancelled'))
    join public.users recorder$new$),
    ($old$'recorded_by_id', daily_events.recorded_by_id,$old$,
     $new$'recorded_by_id', daily_events.recorded_by_id,
      'delivery_status', daily_events.delivery_status,
      'cancelled_at', daily_events.cancelled_at,
      'cancelled_by', daily_events.cancelled_by,
      'cancellation_reason', daily_events.cancellation_reason,$new$),
    ($old$'can_correct', daily_events.is_latest$old$,
     $new$'can_correct', daily_events.delivery_status = 'active' and daily_events.is_latest$new$),
    ($old$'can_cancel', daily_events.is_latest$old$,
     $new$'can_cancel', daily_events.delivery_status = 'active' and daily_events.is_latest$new$),
    ($old$'correction_blocker', case$old$,
     $new$'correction_blocker', case
        when daily_events.delivery_status = 'cancelled' then 'รายการนี้ถูกยกเลิกแล้ว'$new$)
  ) as patches(old_text, new_text)
  loop
    if position(v_patch.old_text in v_definition) = 0 then
      raise exception 'get_round_shop_cards is missing the expected history marker: %', v_patch.old_text;
    end if;
    v_definition := replace(v_definition, v_patch.old_text, v_patch.new_text);
  end loop;
  execute v_definition;
end;
$admin_cancelled_history$;

notify pgrst, 'reload schema';
