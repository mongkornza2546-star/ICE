-- A replay capability exists only inside an authenticated typed offline RPC.
-- Do not widen the ordinary courier's historical-date access or reopen days.
create schema if not exists employee_offline_private;
revoke all on schema employee_offline_private from public, anon, authenticated;
create table employee_offline_private.collection_replay (
  transaction_id bigint primary key,
  command_id uuid not null references public.employee_offline_commands(command_id)
);
alter table employee_offline_private.collection_replay enable row level security;
revoke all on employee_offline_private.collection_replay from public, anon, authenticated;

create function employee_offline_private.collection_replay_allowed(p_day date, p_run uuid default null)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  select coalesce(public.is_active_user() and public.current_app_role()='courier'
    and public.can_collect_shop_payments() and exists (
      select 1 from employee_offline_private.collection_replay replay
      join public.employee_offline_commands command on command.command_id=replay.command_id
      join public.collection_runs run on run.id=(command.payload->'args'->>'p_collection_run_id')::uuid
      where replay.transaction_id=txid_current() and command.user_id=auth.uid()
        and command.command_type='collection_payment' and command.status in ('received','retry_requested')
        and command.service_date=p_day and run.service_date=p_day
        and (p_run is null or run.id=p_run) and run.status='open'
        and p_day <= (clock_timestamp() at time zone 'Asia/Bangkok')::date
        and not exists(select 1 from public.daily_aggregate_stock_closures where service_date=p_day)
        and not exists(select 1 from public.daily_close_reconciliation_requests where service_date=p_day)
    ), false);
$$;
revoke all on function employee_offline_private.collection_replay_allowed(date,uuid) from public,anon,authenticated;

do $patch$
declare change record; definition text;
begin
  for change in select * from (values
    ('public.is_collection_run_member(uuid)',
      $old$run.service_date = (clock_timestamp() at time zone 'Asia/Bangkok')::date$old$,
      $new$(run.service_date = (clock_timestamp() at time zone 'Asia/Bangkok')::date
        or employee_offline_private.collection_replay_allowed(run.service_date,run.id))$new$),
    ('public.can_use_collection_context(uuid)',
      $old$run.service_date=(clock_timestamp() at time zone 'Asia/Bangkok')::date$old$,
      $new$(run.service_date=(clock_timestamp() at time zone 'Asia/Bangkok')::date
        or employee_offline_private.collection_replay_allowed(run.service_date,run.id))$new$),
    ('public.get_collection_queue_for_date(date,uuid)',
      $old$and not public.is_admin_business_date(v_service_date))$old$,
      $new$and not public.is_admin_business_date(v_service_date)
        and not employee_offline_private.collection_replay_allowed(v_service_date,p_collection_run_id))$new$),
    ('public.get_daily_shop_collection_queue(date)',
      $old$or p_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date then$old$,
      $new$or (p_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
        and not employee_offline_private.collection_replay_allowed(p_service_date)) then$new$),
    ('public.get_daily_shop_collection_queue(date)',
      $old$'status', case when v_closed then 'closed' else 'open' end,$old$,
      $new$'status', case when v_closed then 'closed' else 'open' end,
    'can_record_payment',not v_closed and public.can_use_collection_context(v_run_id),$new$)
  ) as changes(signature,old_text,new_text) loop
    definition:=pg_get_functiondef(change.signature::regprocedure);
    if strpos(definition,change.old_text)=0 then raise exception 'Unexpected offline collection definition: %',change.signature; end if;
    execute replace(definition,change.old_text,change.new_text);
  end loop;

  for change in select oid from pg_proc where pronamespace='public'::regnamespace and proname in (
    'offline_record_shop_collection_payment','offline_record_regular_collection_payment',
    'offline_record_billing_statement_payment','offline_record_event_payment','offline_record_event_collection_payment')
  loop
    definition:=pg_get_functiondef(change.oid);
    if strpos(definition,'if v_existing is not null then return v_existing; end if;')=0
      or strpos(definition,'when others then return public.employee_offline_finish_v2')=0 then
      raise exception 'Unexpected offline payment wrapper: %',change.oid::regprocedure;
    end if;
    definition:=replace(definition,
      'if v_existing is not null then return v_existing; end if;',
      'if v_existing is not null then return v_existing; end if;
       insert into employee_offline_private.collection_replay(transaction_id,command_id)
         values(txid_current(),p_idempotency_key);');
    definition:=replace(definition,
      'when others then return public.employee_offline_finish_v2',
      'when others then
         delete from employee_offline_private.collection_replay where transaction_id=txid_current();
         return public.employee_offline_finish_v2');
    definition:=replace(definition,
      'return public.employee_offline_finish_v2(p_idempotency_key,v_result);',
      'delete from employee_offline_private.collection_replay where transaction_id=txid_current();
       return public.employee_offline_finish_v2(p_idempotency_key,v_result);');
    execute definition;
  end loop;
end $patch$;
