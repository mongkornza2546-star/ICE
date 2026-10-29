-- Durable employee commands. Typed wrappers preserve the original RPC signatures,
-- authorization, stock locks, payment allocations and idempotency. No business
-- write is acknowledged until the ledger and the original writer commit together.
create or replace function public.get_employee_offline_capability(p_service_date date)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_profile jsonb;
begin
  if not public.is_active_user() or public.current_app_role() <> 'courier'
    or p_service_date is distinct from (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception 'Offline preparation requires an active courier and today';
  end if;
  select jsonb_build_object('id',id,'code',code,'display_name',display_name,'nickname',nickname,
    'phone',phone,'role',role,'is_active',is_active,'can_collect_shop_payments',can_collect_shop_payments)
    into v_profile from public.users where id=auth.uid();
  -- The first successful preparation enrolls this employee. Explicit disabled
  -- and drain-only settings are never overwritten by a client request.
  insert into public.employee_offline_user_access(user_id,mode) values(auth.uid(),'enabled') on conflict do nothing;
  return jsonb_build_object('version',1,'profile',v_profile,
    'aggregate',(select coalesce(jsonb_object_agg(id,public.daily_aggregate_stock_balance_at(p_service_date,id)),'{}'::jsonb) from public.ice_types where is_active),
    'enabled',public.employee_offline_rollout_allows_command_v1(auth.uid(),clock_timestamp()),
    'validUntil',((p_service_date+1)::timestamp at time zone 'Asia/Bangkok'));
end $$;
revoke all on function public.get_employee_offline_capability(date) from public,anon;
grant execute on function public.get_employee_offline_capability(date) to authenticated;

create or replace function public.get_employee_offline_pos_contexts(p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_stop record; v_context jsonb; v_stock jsonb; v_stocks jsonb:='{}'::jsonb; v_result jsonb := '{}'::jsonb;
begin
  if not public.is_active_user() or public.current_app_role()<>'courier' or not public.is_round_member(p_round_id) then
    raise exception 'An assigned active courier is required';
  end if;
  for v_stop in select s.* from public.round_stops s where s.round_id=p_round_id
    and (s.destination_kind<>'event' or (s.is_operational and public.is_event_ice_delivery_write_enabled(s.event_participation_id))) order by s.id loop
    if v_stop.destination_kind='event' then
      v_context:=public.get_event_delivery_pos_context_part(v_stop.id,'sale');
      v_stock:=v_stocks->'event';
      if v_stock is null then v_stock:=public.get_event_delivery_pos_context_part(v_stop.id,'stock'); v_stocks:=v_stocks||jsonb_build_object('event',v_stock); end if;
    else
      v_context:=public.get_delivery_pos_context_part(v_stop.id,'sale');
      v_stock:=v_stocks->'regular';
      if v_stock is null then v_stock:=public.get_delivery_pos_context_part(v_stop.id,'stock'); v_stocks:=v_stocks||jsonb_build_object('regular',v_stock); end if;
    end if;
    -- A courier has one assigned holding. Read the shared ledger once per
    -- destination kind, while each sale reader retains its authorization.
    v_context:=v_context||jsonb_build_object('stock_source',v_stock->'stock_source',
      'stock_check_required',v_stock->'stock_check_required','items',(
        select coalesce(jsonb_agg(sale||jsonb_build_object('stock_quantity',stock->'stock_quantity')),'[]'::jsonb)
        from jsonb_array_elements(v_context->'items') sale
        join jsonb_array_elements(v_stock->'items') stock on sale->>'ice_type_id'=stock->>'ice_type_id'));

    v_context:=v_context||jsonb_build_object('offline_collection_template', jsonb_build_object(
      'queue_key',case when v_stop.destination_kind='event' then 'event-participation:'||v_stop.event_participation_id::text else 'regular:'||v_stop.shop_id::text end,
      'collection_scope',case when v_stop.destination_kind='event' then 'event_participation' else 'shop' end,
      'destination_kind',v_stop.destination_kind,'event_participation_id',v_stop.event_participation_id,
      'event_job_id',(select event_job_id from public.event_participations where id=v_stop.event_participation_id),'event_name',v_stop.event_job_name_snapshot,
      'settlement_policy_fingerprint',(select settlement_policy_fingerprint from public.event_participations where id=v_stop.event_participation_id),
      'shop_id',v_stop.shop_id,'shop_code',v_context->'shop'->>'code','shop_name',v_context->'shop'->>'name',
      'building_name',v_context->'shop'->>'building_name','image_path',v_context->'shop'->'image_path',
      'outstanding_amount',0,'charge_count',0,'has_new_charges',false,'charges','[]'::jsonb,
      'payment_profile',(select jsonb_object_agg(key,value) from jsonb_each(v_context->'payment_profile')
        where key in ('allowed_payment_methods','default_payment_method','cash_reference_required','cash_evidence_required',
        'bank_transfer_reference_required','bank_transfer_evidence_required','qr_reference_required','qr_evidence_required'))));
    v_result:=v_result||jsonb_build_object(v_stop.id::text,v_context);
  end loop;
  return v_result;
end $$;
revoke all on function public.get_employee_offline_pos_contexts(uuid) from public,anon;
grant execute on function public.get_employee_offline_pos_contexts(uuid) to authenticated;

create or replace function public.employee_offline_response_v2(p_id uuid)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('status',c.status,'result',c.result,'error',i.error_message,
    'code',i.error_code,'resolutionVersion',c.resolution_version)
  from public.employee_offline_commands c left join public.offline_sync_issues i on i.id=c.issue_id
  where c.command_id=p_id
$$;
revoke all on function public.employee_offline_response_v2(uuid) from public,anon,authenticated;

create or replace function public.employee_offline_begin_v2(
  p_type public.employee_offline_command_type,p_rpc text,p_key uuid,p_meta jsonb,p_args jsonb
) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_env record; v_old public.employee_offline_commands%rowtype; v_payload jsonb; v_last bigint;
begin
  if not public.is_active_user() or public.current_app_role()<>'courier' then raise exception 'An active courier is required'; end if;
  select * into v_env from public.employee_offline_parse_envelope_v1(p_meta->'envelope');
  if v_env.owner_id is distinct from auth.uid() then raise exception 'Offline owner mismatch'; end if;
  if v_env.command_id is distinct from p_key or v_env.idempotency_key is distinct from p_key
    or v_env.schema_version<>1 or v_env.payload_version<>1 then raise exception 'Invalid offline command identity/version'; end if;
  if (v_env.client_recorded_at at time zone 'Asia/Bangkok')::date is distinct from v_env.service_date
    or v_env.client_recorded_at > clock_timestamp()+interval '5 minutes' then raise exception 'Invalid offline service date'; end if;
  perform pg_advisory_xact_lock(hashtextextended('offline-device:'||auth.uid()::text||':'||v_env.device_id::text||':'||v_env.service_date::text,0));
  perform pg_advisory_xact_lock(hashtextextended(p_key::text,0));
  v_payload:=jsonb_build_object('rpc',p_rpc,'args',p_args,'expected',p_meta->'expected',
    'roundId',p_args->>'p_round_id','roundStopId',p_args->>'p_round_stop_id','collectionRunId',p_args->>'p_collection_run_id');
  select * into v_old from public.employee_offline_commands where command_id=p_key or idempotency_key=p_key for update;
  if found then
    if v_old.user_id<>auth.uid() or v_old.device_id<>v_env.device_id or v_old.sequence<>v_env.sequence
      or v_old.service_date<>v_env.service_date or v_old.command_type<>p_type
      or v_old.client_recorded_at<>v_env.client_recorded_at or v_old.payload is distinct from v_payload then
      raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    end if;
    if v_old.status<>'retry_requested' then return public.employee_offline_response_v2(p_key); end if;
  else
    select coalesce(max(sequence),0) into v_last from public.employee_offline_commands
      where user_id=auth.uid() and device_id=v_env.device_id and service_date=v_env.service_date;
    if v_env.sequence<>v_last+1 then raise exception 'Offline commands must sync in sequence'; end if;
    if exists(select 1 from public.employee_offline_commands where user_id=auth.uid() and device_id=v_env.device_id
      and service_date=v_env.service_date and status not in ('applied','discard_approved')) then raise exception 'Resolve the preceding offline command first'; end if;
    insert into public.employee_offline_commands(command_id,idempotency_key,device_id,user_id,service_date,sequence,
      command_type,schema_version,payload_version,payload,payload_hash,client_recorded_at)
    values(p_key,p_key,v_env.device_id,auth.uid(),v_env.service_date,v_env.sequence,p_type,1,1,v_payload,
      encode(digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex'),v_env.client_recorded_at);
  end if;
  if not public.employee_offline_rollout_allows_command_v1(auth.uid(),v_env.client_recorded_at) then
    raise exception 'Offline commands are disabled for this employee';
  end if;
  return null;
end $$;
revoke all on function public.employee_offline_begin_v2(public.employee_offline_command_type,text,uuid,jsonb,jsonb) from public,anon,authenticated;

create or replace function public.employee_offline_assert_expected_v2(p_type public.employee_offline_command_type,p_rpc text,p_args jsonb,p_expected jsonb,p_day date)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_context jsonb; v_current jsonb; v_row jsonb; v_price jsonb; v_day date;
begin
  if p_expected is null or jsonb_typeof(p_expected)<>'object' then raise exception 'Expected offline state is required'; end if;
  -- Prevent concurrent configuration edits between validation and the original
  -- transaction. Inventory/receivables retain their existing writer locks.
  lock table public.shop_payment_profiles,public.ice_type_prices,public.shop_ice_type_prices in share mode;
  if p_type in ('stock_transfer','stock_return','stock_damage') then
    v_context:=public.get_employee_stock_state((p_args->>'p_round_id')::uuid);
    v_current:=jsonb_build_object('truck_location_id',v_context->'truck_location'->>'id','holding_location_id',v_context->'holding_location'->>'id');
    if v_current is distinct from p_expected then raise exception 'Stock source changed; supervisor review required'; end if;
    v_day:=(v_context->>'service_date')::date;
  elsif p_type in ('delivery','immediate_sale') then
    if p_rpc='record_event_ice_delivery' then v_context:=public.get_event_delivery_pos_context((p_args->>'p_round_stop_id')::uuid);
    else v_context:=public.get_delivery_pos_context((p_args->>'p_round_stop_id')::uuid); end if;
    v_day:=(v_context->>'service_date')::date;
    v_current:=coalesce(v_context->'payment_profile','{}'::jsonb)-'credit_exposure'-'credit_remaining';
    if p_expected->'payment_profile' is distinct from v_current
      or p_expected->>'stock_source_id' is distinct from v_context->'stock_source'->>'id' then
      raise exception 'Payment terms or stock source changed; supervisor review required';
    end if;
    for v_row in select value from jsonb_array_elements(p_args->'p_items') loop
      select value into v_price from jsonb_array_elements(v_context->'items') where value->>'ice_type_id'=v_row->>'ice_type_id';
      if not exists(select 1 from jsonb_array_elements(p_expected->'prices') e where e->>'ice_type_id'=v_row->>'ice_type_id'
        and e->'unit_price'=v_price->'unit_price' and e->'price_source_id' is not distinct from v_price->'price_source_id') then
        raise exception 'Price changed; supervisor review required';
      end if;
    end loop;
  else
    select service_date into v_day from public.collection_runs where id=(p_args->>'p_collection_run_id')::uuid;
    v_context:=public.get_daily_shop_collection_queue_v2(p_day);
    select value into v_row from jsonb_array_elements(v_context->'queue')
      where coalesce(value->>'queue_key','regular:'||(value->>'shop_id'))=p_expected->>'queueKey';
    if v_row is null or v_row->'payment_profile' is distinct from p_expected->'payment_profile'
      or (v_row->>'outstanding_amount')::numeric is distinct from (p_args->>'p_expected_outstanding_amount')::numeric then
      raise exception 'Collection balance or payment terms changed; supervisor review required';
    end if;
    for v_current in select value from jsonb_array_elements(p_expected->'charges') loop
      if not exists(select 1 from jsonb_array_elements(v_row->'charges') c where c->>'charge_id'=v_current->>'charge_id'
        and (c->>'outstanding_amount')::numeric=(v_current->>'outstanding_amount')::numeric) then
        raise exception 'Collection allocation changed; supervisor review required';
      end if;
    end loop;
  end if;
  if v_day is distinct from p_day then raise exception 'Offline service date mismatch'; end if;
end $$;
revoke all on function public.employee_offline_assert_expected_v2(public.employee_offline_command_type,text,jsonb,jsonb,date) from public,anon,authenticated;

create or replace function public.employee_offline_finish_v2(p_id uuid,p_result jsonb,p_error text default null)
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare v_command public.employee_offline_commands%rowtype; v_issue uuid;
begin
  select * into strict v_command from public.employee_offline_commands where command_id=p_id for update;
  if p_error is null then
    if v_command.issue_id is not null then update public.offline_sync_issues set status='resolved_applied' where id=v_command.issue_id; end if;
    update public.employee_offline_commands set status='applied',result=p_result,applied_at=clock_timestamp() where command_id=p_id;
  else
    if v_command.issue_id is null then
      insert into public.offline_sync_issues(command_id,device_id,user_id,service_date,command_type,payload,error_code,error_message,scope_type)
      values(v_command.command_id,v_command.device_id,v_command.user_id,v_command.service_date,v_command.command_type,v_command.payload,
        'SERVER_CONTRACT_ERROR',p_error,'admin_only') returning id into v_issue;
    else
      v_issue:=v_command.issue_id;
      update public.offline_sync_issues set status='open',error_code='SERVER_CONTRACT_ERROR',error_message=p_error where id=v_issue;
    end if;
    update public.employee_offline_commands set status='conflict',issue_id=v_issue where command_id=p_id;
  end if;
  return public.employee_offline_response_v2(p_id);
end $$;
revoke all on function public.employee_offline_finish_v2(uuid,jsonb,text) from public,anon,authenticated;

-- Generate typed wrappers from this migration's explicit allowlist. Each exposes
-- the original typed arguments (PostgREST rejects unknown argument names). Caller
-- input never selects a function or SQL identifier; no public JSON dispatcher.
do $wrappers$
declare f record; v_kind text; v_args text; v_call text; v_payload text; v_signature text; v_definition text;
begin
  for f in select p.*,pg_get_function_arguments(p.oid) as arguments from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('record_employee_stock_transfer','record_employee_stock_return','record_employee_stock_damage',
      'record_delivery_with_vat_check','record_event_ice_delivery','record_immediate_sale',
      'record_shop_collection_payment','record_regular_collection_payment','record_billing_statement_payment','record_event_payment','record_event_collection_payment')
  loop
    v_kind:=case f.proname when 'record_employee_stock_transfer' then 'stock_transfer' when 'record_employee_stock_return' then 'stock_return'
      when 'record_employee_stock_damage' then 'stock_damage' when 'record_delivery_with_vat_check' then 'delivery'
      when 'record_event_ice_delivery' then 'delivery' when 'record_immediate_sale' then 'immediate_sale' else 'collection_payment' end;
    select string_agg(format('%I',name),',' order by ordinal),string_agg(format('%L,to_jsonb(%I)',name,name),',' order by ordinal)
      into v_call,v_payload from unnest(f.proargnames) with ordinality names(name,ordinal);
    v_args:=f.arguments||',p_offline jsonb default null';
    v_signature:=pg_get_function_identity_arguments(f.oid)||',jsonb';
    v_definition:=format($definition$
      create or replace function public.%I(%s) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $body$
      declare v_existing jsonb; v_args jsonb; v_result jsonb; v_expected numeric; v_actual numeric;
      begin
        v_args:=jsonb_build_object(%s);
        v_existing:=public.employee_offline_begin_v2(%L,%L,p_idempotency_key,p_offline,v_args);
        if v_existing is not null then return v_existing; end if;
        begin
          -- A discarded predecessor invalidates assumptions made before its
          -- decision. Register a reviewable conflict, never silently continue.
          if exists(select 1 from public.employee_offline_commands prior
            join public.offline_sync_issues issue on issue.id=prior.issue_id
            where prior.user_id=auth.uid() and prior.device_id=(p_offline->'envelope'->>'deviceId')::uuid
              and prior.service_date=(p_offline->'envelope'->>'serviceDate')::date
              and prior.sequence<(p_offline->'envelope'->>'sequence')::bigint and prior.status='discard_approved'
              and issue.decided_at>=(p_offline->'envelope'->>'clientRecordedAt')::timestamptz)
            and not exists(select 1 from public.employee_offline_commands where command_id=p_idempotency_key and status='retry_requested') then
            raise exception 'Preceding command was discarded; review dependent stock and money before retry';
          end if;
          perform public.employee_offline_assert_expected_v2(%L,%L,v_args,p_offline->'expected',(p_offline->'envelope'->>'serviceDate')::date);
          v_result:=public.%I(%s);
          if %L in ('delivery','immediate_sale') and coalesce(v_args->>'p_stop_status','delivered')='delivered' then
            v_expected:=coalesce((v_args->>'p_expected_total')::numeric,(p_offline->'expected'->>'expected_total')::numeric);
            v_actual:=coalesce((v_result->>'total_amount')::numeric,(v_result->'delivery'->>'total_amount')::numeric);
            if v_expected is distinct from v_actual then raise exception 'Offline total changed'; end if;
          end if;
        exception when serialization_failure or deadlock_detected or query_canceled then raise;
          when others then return public.employee_offline_finish_v2(p_idempotency_key,null,sqlerrm);
        end;
        return public.employee_offline_finish_v2(p_idempotency_key,v_result);
      end $body$;
    $definition$,'offline_'||f.proname,v_args,v_payload,v_kind,f.proname,v_kind,f.proname,f.proname,v_call,v_kind);
    execute v_definition;
    execute format('revoke all on function public.%I(%s) from public,anon','offline_'||f.proname,v_signature);
    execute format('grant execute on function public.%I(%s) to authenticated','offline_'||f.proname,v_signature);
  end loop;
end $wrappers$;

create or replace function public.get_employee_offline_commands(p_service_date date default null,p_command_ids uuid[] default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.is_active_user() then raise exception 'An active user is required'; end if;
  if cardinality(p_command_ids)>200 then raise exception 'At most 200 command IDs may be requested'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',c.command_id,'ownerId',c.user_id,'ownerName',u.display_name,'label',c.command_type,
    'recordedAt',c.client_recorded_at,'payload',c.payload)||public.employee_offline_response_v2(c.command_id) order by c.service_date,c.sequence)
    from (select * from public.employee_offline_commands where (p_service_date is null or service_date=p_service_date)
      and ((p_command_ids is null and status='conflict') or command_id=any(p_command_ids))
      and (user_id=auth.uid() or public.current_app_role()='admin') order by service_date,sequence limit 200) c
    join public.users u on u.id=c.user_id where (c.user_id=auth.uid() or public.current_app_role()='admin')), '[]'::jsonb);
end $$;
revoke all on function public.get_employee_offline_commands(date,uuid[]) from public,anon;
grant execute on function public.get_employee_offline_commands(date,uuid[]) to authenticated;

create or replace function public.resolve_employee_offline_command(p_id uuid,p_decision public.offline_sync_issue_decision,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.employee_offline_commands%rowtype; v_now timestamptz:=clock_timestamp(); v_version bigint;
begin
  if not public.is_active_user() or public.current_app_role()<>'admin' then raise exception 'An active administrator is required'; end if;
  if p_decision is null or nullif(trim(p_reason),'') is null then raise exception 'A decision and reason are required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into strict c from public.employee_offline_commands where command_id=p_id for update;
  if c.status<>'conflict' then raise exception 'Only a conflicting command may be resolved'; end if;
  update public.offline_sync_issues set status=case when p_decision='retry' then 'retry_requested'::public.offline_sync_issue_status else 'discard_approved'::public.offline_sync_issue_status end,
    decided_by=auth.uid(),decided_at=v_now,decision_reason=trim(p_reason) where id=c.issue_id;
  update public.employee_offline_commands set status=case when p_decision='retry' then 'retry_requested'::public.employee_offline_command_status else 'discard_approved'::public.employee_offline_command_status end
    where command_id=p_id returning resolution_version into v_version;
  insert into public.offline_sync_issue_decisions(issue_id,command_id,decision,reason,decided_by,decided_at,resolution_version)
    values(c.issue_id,p_id,p_decision,trim(p_reason),auth.uid(),v_now,v_version);
  return public.employee_offline_response_v2(p_id);
end $$;
revoke all on function public.resolve_employee_offline_command(uuid,public.offline_sync_issue_decision,text) from public,anon;
grant execute on function public.resolve_employee_offline_command(uuid,public.offline_sync_issue_decision,text) to authenticated;
