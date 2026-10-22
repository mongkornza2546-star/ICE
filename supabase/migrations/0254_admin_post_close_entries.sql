-- Allow active admins to append historical deliveries/collections without reopening
-- a day or rewriting immutable stock, cash-count or handover snapshots.
create or replace function public.is_admin_business_date(p_date date)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.is_active_user() and public.current_app_role() = 'admin'
    and isfinite(p_date) and p_date <= (clock_timestamp() at time zone 'Asia/Bangkok')::date, false);
$$;
create or replace function public.admin_closed_stock_entry(p_date date)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin_business_date(p_date) and (
    exists (select 1 from public.daily_aggregate_stock_closures where service_date=p_date)
    or exists (select 1 from public.daily_stock_closures where service_date=p_date and status='closed'));
$$;
create or replace function public.can_use_collection_context(p_run_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_collect_shop_payments() and exists (
    select 1 from public.collection_runs run where run.id=p_run_id and (
      public.is_admin_business_date(run.service_date)
      or (run.status='open' and run.service_date=(clock_timestamp() at time zone 'Asia/Bangkok')::date
        and not exists (select 1 from public.daily_aggregate_stock_closures where service_date=run.service_date))));
$$;
revoke all on function public.is_admin_business_date(date), public.admin_closed_stock_entry(date),
  public.can_use_collection_context(uuid) from public, anon, authenticated;

do $patch$
declare v_target record; v_definition text;
begin
  for v_target in select * from (values
    ('public.get_employee_active_session(date)', $old$and round.status = 'open'$old$, $new$and (round.status = 'open' or public.is_admin_business_date(v_service_date))$new$),
    ('public.get_employee_active_session(date)', $old$'status', round.status,$old$, $new$'status', round.status,
      'can_record_delivery', public.is_admin_business_date(v_service_date),$new$),
    ('public.get_delivery_pos_context(uuid)', $old$elsif v_round_status <> 'open' then$old$, $new$elsif v_round_status <> 'open' and not public.is_admin_business_date(v_service_date) then$new$),
    ('public.get_delivery_pos_context(uuid)', $old$if v_round_id is null then$old$, $new$if exists (select 1 from public.delivery_rounds where id=v_round_id and cancelled_at is not null) then
    raise exception 'This delivery round is cancelled';
  elsif v_round_id is null then$new$),
    ('public.get_delivery_pos_context(uuid)', $old$'stock_source', jsonb_build_object($old$, $new$'stock_check_required', not public.admin_closed_stock_entry(v_service_date),
    'stock_source', jsonb_build_object($new$),
    ('public.get_event_delivery_pos_context(uuid)', $old$elsif v_round_status <> 'open' then$old$, $new$elsif v_round_status <> 'open' and not public.is_admin_business_date(v_service_date) then$new$),
    ('public.get_event_delivery_pos_context(uuid)', $old$elsif public.current_app_role() not in ('admin', 'round_lead')$old$, $new$elsif exists (select 1 from public.delivery_rounds where id=v_round_id and cancelled_at is not null) then
    raise exception 'This delivery round is cancelled';
  elsif public.current_app_role() not in ('admin', 'round_lead')$new$),
    ('public.get_event_delivery_pos_context(uuid)', $old$'stock_source', jsonb_build_object($old$, $new$'stock_check_required', not public.admin_closed_stock_entry(v_service_date),
    'stock_source', jsonb_build_object($new$),
    ('public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)', $old$elsif v_round_status <> 'open' then$old$, $new$elsif v_round_status <> 'open' and not public.is_admin_business_date(v_service_date) then$new$),
    ('public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)', $old$if v_round_id is null then$old$, $new$if exists (select 1 from public.delivery_rounds where id=v_round_id and cancelled_at is not null) then
    raise exception 'This delivery round is cancelled';
  elsif v_round_id is null then$new$),
    ('public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)', $old$elsif exists (
    select 1 from public.daily_aggregate_stock_closures$old$, $new$elsif not public.is_admin_business_date(v_service_date) and exists (
    select 1 from public.daily_aggregate_stock_closures$new$),
    ('public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)', $old$if public.current_app_role() = 'admin'
      and public.stock_balance_at$old$, $new$if public.current_app_role() = 'admin'
      and not public.admin_closed_stock_entry(v_service_date)
      and public.stock_balance_at$new$),
    ('public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)', $old$elsif public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)$old$, $new$elsif not public.admin_closed_stock_entry(v_service_date)
      and public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)$new$),
    ('public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)', $old$elsif v_round_status <> 'open' then$old$, $new$elsif v_round_status <> 'open' and not public.is_admin_business_date(v_service_date) then$new$),
    ('public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)', $old$elsif public.current_app_role() not in ('admin', 'round_lead')$old$, $new$elsif exists (select 1 from public.delivery_rounds where id=v_round_id and cancelled_at is not null) then
    raise exception 'This delivery round is cancelled';
  elsif public.current_app_role() not in ('admin', 'round_lead')$new$),
    ('public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)', $old$elsif exists (
    select 1 from public.daily_aggregate_stock_closures$old$, $new$elsif not public.is_admin_business_date(v_service_date) and exists (
    select 1 from public.daily_aggregate_stock_closures$new$),
    ('public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)', $old$if public.current_app_role() = 'admin'
      and public.stock_balance_at$old$, $new$if public.current_app_role() = 'admin'
      and not public.admin_closed_stock_entry(v_service_date)
      and public.stock_balance_at$new$),
    ('public.record_event_ice_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid)', $old$elsif public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)$old$, $new$elsif not public.admin_closed_stock_entry(v_service_date)
      and public.daily_aggregate_stock_balance_at(v_service_date, v_item.ice_type_id)$new$),
    ('public.reject_closed_service_day()', $old$  if exists ($old$, $new$  if not (tg_table_name = 'delivery_events' and tg_op = 'INSERT'
    and public.admin_closed_stock_entry(v_service_date)) and exists ($new$),
    ('public.guard_payment_cash_close()', $old$    perform public.assert_daily_cash_date_open(v_date);$old$, $new$    if tg_op = 'INSERT' and public.is_admin_business_date(v_date) then
      perform pg_advisory_xact_lock_shared(hashtextextended('collection-run:' || v_date::text, 0));
    else
      perform public.assert_daily_cash_date_open(v_date);
    end if;$new$),
    ('public.record_payment_before_automatic_context(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)', $old$run.status = 'open'$old$, $new$(run.status = 'open' or public.is_admin_business_date(run.service_date))$new$),
    ('public.is_charge_collectible_in_run(uuid,uuid)', $old$run.status = 'open'$old$, $new$(run.status = 'open' or public.is_admin_business_date(run.service_date))$new$),
    ('public.record_regular_payment_after_event_context(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)', $old$    elsif v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
      or not exists (
        select 1 from public.collection_runs run
        where run.id = p_collection_run_id and run.status = 'open'
      )
      or exists (
        select 1 from public.daily_aggregate_stock_closures closure
        where closure.service_date = v_service_date
      ) then
$old$, $new$    elsif not public.can_use_collection_context(p_collection_run_id) then
$new$),
    ('public.record_event_payment(uuid,uuid,date,text,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid)', $old$  select run.service_date into v_run_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id and run.status = 'open';

  if v_run_service_date is null
    or v_run_service_date < v_context.service_date
    or v_run_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or exists (
      select 1 from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_run_service_date
    ) then
$old$, $new$  select run.service_date into v_run_service_date
  from public.collection_runs run where run.id = p_collection_run_id;
  if v_run_service_date is null or v_run_service_date < v_context.service_date
    or not public.can_use_collection_context(p_collection_run_id) then
$new$),
    ('public.get_collection_run_queue(uuid)', $old$  select run.service_date into v_service_date from public.collection_runs run
  where run.id = p_collection_run_id and run.status = 'open';
  if v_service_date is null
    or v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or exists (select 1 from public.daily_aggregate_stock_closures closure where closure.service_date = v_service_date)
  then raise exception 'The collection context is stale or closed'; end if;
$old$, $new$  select run.service_date into v_service_date from public.collection_runs run where run.id=p_collection_run_id;
  if not public.can_use_collection_context(p_collection_run_id) and not (
    public.is_active_user() and v_service_date=(clock_timestamp() at time zone 'Asia/Bangkok')::date
    and exists (select 1 from public.collection_runs where id=p_collection_run_id and status='open')
    and not exists (select 1 from public.daily_aggregate_stock_closures where service_date=v_service_date)
  ) then raise exception 'The collection context is stale or closed'; end if;
$new$),
    ('public.get_collection_queue_for_date(date,uuid)', $old$or v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date$old$, $new$or (v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
      and not public.is_admin_business_date(v_service_date))$new$),
    ('public.ensure_daily_collection_context(date)', $old$  if not public.is_active_user() then$old$, $new$  if public.is_admin_business_date(p_service_date) then
    if exists (select 1 from public.collection_runs where service_date=p_service_date) then
      perform pg_advisory_xact_lock_shared(hashtextextended('collection-run:' || p_service_date::text, 0));
    else
      perform pg_advisory_xact_lock(hashtextextended('collection-run:' || p_service_date::text, 0));
    end if;
    select id into v_run_id from public.collection_runs where service_date=p_service_date
      order by (status='open') desc, id limit 1;
    if v_run_id is null then
      insert into public.collection_runs(service_date,opened_by,status,closed_by,closed_at)
      select p_service_date,auth.uid(),
        case when closed then 'closed' else 'open' end::public.collection_run_status,
        case when closed then auth.uid() end, case when closed then clock_timestamp() end
      from (select exists (select 1 from public.daily_aggregate_stock_closures
        where service_date=p_service_date) as closed) day
      returning id into v_run_id;
      insert into public.audit_logs(actor_id,entity_type,entity_id,action,after_value)
      values(auth.uid(),'collection_runs',v_run_id,'admin_collection_context_created',
        jsonb_build_object('service_date',p_service_date));
    end if;
    return jsonb_build_object('collection_run_id',v_run_id,'service_date',p_service_date,
      'status',case when exists (select 1 from public.daily_aggregate_stock_closures where service_date=p_service_date)
        then 'closed' else (select status::text from public.collection_runs where id=v_run_id) end,
      'can_record_payment',true);
  end if;
  if not public.is_active_user() then$new$),
    ('public.get_daily_shop_collection_queue(date)', $old$  if not public.is_active_user() then$old$, $new$  if public.is_admin_business_date(p_service_date) then
    declare v_context jsonb;
    begin
      v_context := public.ensure_daily_collection_context(p_service_date);
      v_run_id := (v_context->>'collection_run_id')::uuid;
      return v_context || jsonb_build_object('queue',
        public.get_shop_collection_queue_for_date(p_service_date,v_run_id));
    end;
  end if;
  if not public.is_active_user() then$new$)
  ) changes(signature, old_fragment, new_fragment) loop
    v_definition := pg_get_functiondef(v_target.signature::regprocedure);
    if strpos(v_definition,v_target.new_fragment)>0 then continue; end if;
    if strpos(v_definition,v_target.old_fragment)=0 then
      raise exception 'Unexpected closed-day guard in %',v_target.signature;
    end if;
    execute replace(v_definition,v_target.old_fragment,v_target.new_fragment);
  end loop;
end;
$patch$;

-- Keep an explicit audit link for additions after closure, including actual
-- entry time vs business date. Existing detailed delivery/payment audits remain.
create or replace function public.audit_admin_closed_day_entry()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_date date; v_closed boolean;
begin
  if tg_table_name='delivery_events' then
    select round.service_date into v_date from public.round_stops stop
      join public.delivery_rounds round on round.id=stop.round_id where stop.id=new.round_stop_id;
    v_closed := public.admin_closed_stock_entry(v_date) or exists (
      select 1 from public.round_stops stop join public.delivery_rounds round on round.id=stop.round_id
      where stop.id=new.round_stop_id and round.status='closed');
  else
    v_date := public.daily_close_payment_date(new.received_date_override,
      (select service_date from public.collection_runs where id=new.collection_run_id),new.recorded_at);
    v_closed := exists (select 1 from public.daily_close_reconciliation_requests where service_date=v_date)
      or exists (select 1 from public.daily_aggregate_stock_closures where service_date=v_date)
      or exists (select 1 from public.collection_runs where id=new.collection_run_id and status='closed');
  end if;
  if v_closed and public.is_admin_business_date(v_date) then
    insert into public.audit_logs(actor_id,entity_type,entity_id,action,after_value)
    values(auth.uid(),tg_table_name,new.id,'admin_post_close_entry',
      jsonb_build_object('service_date',v_date,'entered_at',clock_timestamp(),'record',to_jsonb(new)));
  end if;
  return new;
end;
$$;
revoke all on function public.audit_admin_closed_day_entry() from public,anon,authenticated;
drop trigger if exists delivery_events_admin_post_close_audit on public.delivery_events;
create trigger delivery_events_admin_post_close_audit after insert on public.delivery_events
for each row execute function public.audit_admin_closed_day_entry();
drop trigger if exists payments_admin_post_close_audit on public.payments;
create trigger payments_admin_post_close_audit after insert on public.payments
for each row execute function public.audit_admin_closed_day_entry();
notify pgrst,'reload schema';
