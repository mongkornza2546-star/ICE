alter table public.shop_payment_profiles
  add column credit_collection_weekday smallint;

do $$
declare
  v_constraint_name text;
begin
  select constraint_row.conname into v_constraint_name
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.shop_payment_profiles'::regclass
    and constraint_row.contype = 'c'
    and pg_get_constraintdef(constraint_row.oid) like '%credit_due_rule%';

  if v_constraint_name is not null then
    execute format(
      'alter table public.shop_payment_profiles drop constraint %I',
      v_constraint_name
    );
  end if;
end;
$$;

alter table public.shop_payment_profiles
  add constraint shop_payment_profiles_credit_collection_cycle_check check (
    case
      when 'credit' = any(allowed_payment_terms) then
        cardinality(allowed_payment_terms) = 1
        and allow_outstanding
        and credit_due_rule is not null
        and (
          (credit_due_rule = 'net_days' and credit_days is not null
            and credit_days > 0 and credit_collection_weekday is null)
          or (credit_due_rule = 'weekly' and credit_days is null
            and credit_collection_weekday between 1 and 7)
          or (credit_due_rule = 'end_of_month' and credit_days is null
            and credit_collection_weekday is null)
        )
      else
        credit_due_rule is null and credit_days is null
        and credit_collection_weekday is null and credit_limit is null
    end
  );

create or replace function public.resolve_credit_due_date(
  p_shop_id uuid,
  p_service_date date
)
returns date
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_profile public.shop_payment_profiles%rowtype;
  v_candidate date;
begin
  if p_shop_id is null or p_service_date is null then
    raise exception 'Shop and service date are required to resolve a credit due date';
  end if;

  select profile.* into v_profile
  from public.shop_payment_profiles profile
  where profile.shop_id = p_shop_id;

  if v_profile.id is null or not ('credit' = any(v_profile.allowed_payment_terms)) then
    raise exception 'The selected shop does not have an active credit payment profile';
  end if;

  if v_profile.credit_due_rule = 'net_days' then
    return p_service_date + v_profile.credit_days;
  elsif v_profile.credit_due_rule = 'weekly' then
    v_candidate := p_service_date + mod(
      v_profile.credit_collection_weekday - extract(isodow from p_service_date)::integer + 7,
      7
    );
  elsif v_profile.credit_due_rule = 'end_of_month' then
    v_candidate := (
      date_trunc('month', p_service_date)::date + interval '1 month - 1 day'
    )::date;
  else
    raise exception 'The selected shop does not have a valid credit collection cycle';
  end if;

  loop
    perform pg_advisory_xact_lock(
      hashtextextended('collection-run:' || v_candidate::text, 0)
    );

    exit when not exists (
      select 1
      from public.collection_runs run
      where run.service_date = v_candidate and run.status = 'closed'
    );

    if v_profile.credit_due_rule = 'weekly' then
      v_candidate := v_candidate + 7;
    else
      v_candidate := (
        date_trunc('month', v_candidate + 1)::date + interval '1 month - 1 day'
      )::date;
    end if;
  end loop;

  return v_candidate;
end;
$$;

create or replace function public.close_collection_run(p_collection_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_date date;
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can close collection runs';
  end if;

  select run.service_date into v_service_date
  from public.collection_runs run
  where run.id = p_collection_run_id and run.status = 'open';

  if v_service_date is null then
    raise exception 'The selected collection run is already closed or does not exist';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('collection-run:' || v_service_date::text, 0)
  );

  update public.collection_runs
  set status = 'closed', closed_by = auth.uid(), closed_at = now()
  where id = p_collection_run_id and status = 'open'
  returning service_date into v_service_date;

  if v_service_date is null then
    raise exception 'The selected collection run is already closed or does not exist';
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'collection_runs', p_collection_run_id, 'closed',
    jsonb_build_object('service_date', v_service_date)
  );
  return jsonb_build_object(
    'collection_run_id', p_collection_run_id,
    'service_date', v_service_date,
    'status', 'closed'
  );
end;
$$;

do $replace_record_delivery_due_date$
declare
  v_function regprocedure :=
    'public.record_delivery(uuid,jsonb,public.shop_round_status,text,timestamptz,uuid,public.payment_term,uuid)'::regprocedure;
  v_definition text;
  v_profile_read constant text := $fragment$  if p_stop_status = 'delivered' then
    select profile.* into v_profile
    from public.shop_payment_profiles profile
    where profile.shop_id = v_shop_id;$fragment$;
  v_locked_profile_read constant text := $fragment$  if p_stop_status = 'delivered' then
    perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

    select profile.* into v_profile
    from public.shop_payment_profiles profile
    where profile.shop_id = v_shop_id
    for share;$fragment$;
  v_late_financial_lock constant text := $fragment$  if p_stop_status = 'delivered' then
    perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_shop_id::text, 0));

    if v_resolved_payment_term = 'credit' then$fragment$;
  v_without_late_financial_lock constant text := $fragment$  if p_stop_status = 'delivered' then
    if v_resolved_payment_term = 'credit' then$fragment$;
  v_old constant text := $fragment$    if v_resolved_payment_term = 'credit' then
      if v_profile.credit_due_rule = 'net_days' then
        v_due_date := v_service_date + v_profile.credit_days;
      else
        v_due_date := (date_trunc('month', v_service_date)::date
          + interval '1 month - 1 day')::date;
      end if;$fragment$;
  v_new constant text := $fragment$    if v_resolved_payment_term = 'credit' then
      v_due_date := public.resolve_credit_due_date(v_shop_id, v_service_date);$fragment$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_profile_read) = 0 then
    raise exception 'record_delivery does not contain the expected payment-profile read';
  elsif strpos(v_definition, v_late_financial_lock) = 0 then
    raise exception 'record_delivery does not contain the expected financial lock';
  elsif strpos(v_definition, v_old) = 0 then
    raise exception 'record_delivery does not contain the expected due-date calculation';
  end if;
  v_definition := replace(v_definition, v_profile_read, v_locked_profile_read);
  v_definition := replace(v_definition, v_late_financial_lock, v_without_late_financial_lock);
  execute replace(v_definition, v_old, v_new);
end;
$replace_record_delivery_due_date$;

do $extend_pos_credit_cycle$
declare
  v_function regprocedure := 'public.get_delivery_pos_context(uuid)'::regprocedure;
  v_definition text;
  v_old constant text := $fragment$      'credit_due_rule', v_profile.credit_due_rule,
      'credit_days', v_profile.credit_days,
      'credit_limit', v_profile.credit_limit,$fragment$;
  v_new constant text := $fragment$      'credit_due_rule', v_profile.credit_due_rule,
      'credit_days', v_profile.credit_days,
      'credit_collection_weekday', v_profile.credit_collection_weekday,
      'credit_limit', v_profile.credit_limit,$fragment$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_old) = 0 then
    raise exception 'get_delivery_pos_context does not contain the expected credit profile projection';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$extend_pos_credit_cycle$;

create or replace function public.update_credit_account_settings(
  p_shop_id uuid,
  p_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.shop_payment_profiles%rowtype;
  v_unknown_key text;
  v_limit numeric(12,2);
  v_rule public.credit_due_rule;
  v_days integer;
  v_weekday smallint;
  v_cycle_changed boolean;
  v_suspended boolean;
  v_reason text;
begin
  if not public.is_active_user() or public.current_app_role() <> 'admin' then
    raise exception 'Only an admin can change credit settings';
  elsif p_shop_id is null or p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'Shop and credit changes are required';
  end if;

  select key into v_unknown_key
  from jsonb_object_keys(p_changes) key
  where key not in (
    'credit_limit', 'credit_due_rule', 'credit_days', 'credit_collection_weekday',
    'credit_suspended', 'credit_suspension_reason'
  )
  limit 1;
  if v_unknown_key is not null then
    raise exception 'Unsupported credit setting: %', v_unknown_key;
  end if;

  v_cycle_changed := p_changes ?| array[
    'credit_due_rule', 'credit_days', 'credit_collection_weekday'
  ];
  if v_cycle_changed and not (
    p_changes ? 'credit_due_rule'
    and p_changes ? 'credit_days'
    and p_changes ? 'credit_collection_weekday'
  ) then
    raise exception 'Credit collection cycle changes must include rule, days, and weekday';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));
  select profile.* into v_profile
  from public.shop_payment_profiles profile
  where profile.shop_id = p_shop_id
  for update;
  if v_profile.id is null or not ('credit' = any(v_profile.allowed_payment_terms)) then
    raise exception 'The selected shop does not have a credit account';
  end if;

  if p_changes ? 'credit_limit' then
    v_limit := nullif(p_changes->>'credit_limit', '')::numeric;
    if v_limit is not null and v_limit < 0 then
      raise exception 'Credit limit must be zero or greater';
    end if;
  else
    v_limit := v_profile.credit_limit;
  end if;

  if v_cycle_changed then
    v_rule := (p_changes->>'credit_due_rule')::public.credit_due_rule;
    v_days := nullif(p_changes->>'credit_days', '')::integer;
    v_weekday := nullif(p_changes->>'credit_collection_weekday', '')::smallint;

    if not (
      (v_rule = 'net_days' and v_days is not null and v_days > 0 and v_weekday is null)
      or (v_rule = 'weekly' and v_days is null and v_weekday between 1 and 7)
      or (v_rule = 'end_of_month' and v_days is null and v_weekday is null)
    ) then
      raise exception 'The credit collection cycle is invalid';
    end if;
  else
    v_rule := v_profile.credit_due_rule;
    v_days := v_profile.credit_days;
    v_weekday := v_profile.credit_collection_weekday;
  end if;

  v_suspended := case when p_changes ? 'credit_suspended'
    then (p_changes->>'credit_suspended')::boolean else v_profile.credit_suspended end;
  v_reason := case when p_changes ? 'credit_suspension_reason'
    then nullif(trim(p_changes->>'credit_suspension_reason'), '') else v_profile.credit_suspension_reason end;
  if v_suspended and v_reason is null then
    raise exception 'A suspension reason is required';
  end if;

  update public.shop_payment_profiles
  set credit_limit = v_limit,
      credit_due_rule = v_rule,
      credit_days = v_days,
      credit_collection_weekday = v_weekday,
      credit_suspended = v_suspended,
      credit_suspension_reason = case when v_suspended then v_reason else null end,
      credit_suspended_by = case when v_suspended then auth.uid() else null end,
      credit_suspended_at = case when v_suspended then coalesce(v_profile.credit_suspended_at, now()) else null end
  where id = v_profile.id
  returning * into v_profile;

  return jsonb_build_object(
    'shop_id', v_profile.shop_id,
    'credit_limit', v_profile.credit_limit,
    'credit_due_rule', v_profile.credit_due_rule,
    'credit_days', v_profile.credit_days,
    'credit_collection_weekday', v_profile.credit_collection_weekday,
    'credit_suspended', v_profile.credit_suspended,
    'credit_suspension_reason', v_profile.credit_suspension_reason
  );
end;
$$;

do $protect_closed_collection_cutoff$
declare
  v_function regprocedure :=
    'public.set_credit_charge_collection_assignment(uuid,uuid,boolean)'::regprocedure;
  v_definition text;
  v_marker constant text := $fragment$  if p_assigned and v_outstanding <= 0 then$fragment$;
  v_guard constant text := $fragment$  if p_assigned
    and v_charge.due_date > v_run.service_date
    and exists (
      select 1
      from public.collection_runs closed_run
      where closed_run.service_date = v_run.service_date
        and closed_run.status = 'closed'
    ) then
    raise exception 'A closed collection cutoff cannot accept a future credit charge';
  end if;

  if p_assigned and v_outstanding <= 0 then$fragment$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_marker) = 0 then
    raise exception 'set_credit_charge_collection_assignment does not contain the expected validation';
  end if;
  execute replace(v_definition, v_marker, v_guard);
end;
$protect_closed_collection_cutoff$;

do $extend_credit_receivables_cycle$
declare
  v_function regprocedure := 'public.get_credit_receivables(date)'::regprocedure;
  v_definition text;
  v_old constant text := $fragment$      'credit_days', profile.credit_days,
      'credit_limit', profile.credit_limit,$fragment$;
  v_new constant text := $fragment$      'credit_due_rule', profile.credit_due_rule,
      'credit_days', profile.credit_days,
      'credit_collection_weekday', profile.credit_collection_weekday,
      'credit_limit', profile.credit_limit,$fragment$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_old) = 0 then
    raise exception 'get_credit_receivables does not contain the expected credit profile projection';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$extend_credit_receivables_cycle$;

revoke all on function public.resolve_credit_due_date(uuid, date) from public;
