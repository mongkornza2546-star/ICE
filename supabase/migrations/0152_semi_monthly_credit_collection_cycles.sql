alter table public.shop_payment_profiles
  drop constraint if exists shop_payment_profiles_credit_collection_cycle_check;

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
          or (credit_due_rule = 'semi_monthly' and credit_days is null
            and credit_collection_weekday is null)
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
  elsif v_profile.credit_due_rule = 'semi_monthly' then
    v_candidate := case
      when extract(day from p_service_date) <= 15
        then date_trunc('month', p_service_date)::date + 14
      else (date_trunc('month', p_service_date)::date + interval '1 month - 1 day')::date
    end;
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
    elsif v_profile.credit_due_rule = 'semi_monthly' then
      v_candidate := case
        when extract(day from v_candidate) = 15
          then (date_trunc('month', v_candidate)::date + interval '1 month - 1 day')::date
        else date_trunc('month', v_candidate + 1)::date + 14
      end;
    else
      v_candidate := (
        date_trunc('month', v_candidate + 1)::date + interval '1 month - 1 day'
      )::date;
    end if;
  end loop;

  return v_candidate;
end;
$$;

do $extend_credit_account_cycle_validation$
declare
  v_function regprocedure := 'public.update_credit_account_settings(uuid,jsonb)'::regprocedure;
  v_definition text;
  v_old constant text := $fragment$      or (v_rule = 'end_of_month' and v_days is null and v_weekday is null)$fragment$;
  v_new constant text := $fragment$      or (v_rule = 'semi_monthly' and v_days is null and v_weekday is null)
      or (v_rule = 'end_of_month' and v_days is null and v_weekday is null)$fragment$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_old) = 0 then
    raise exception 'update_credit_account_settings does not contain the expected cycle validation';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$extend_credit_account_cycle_validation$;

do $extend_accounting_payment_condition$
declare
  v_function regprocedure := 'public.get_accounting_shop_daily_matrix(date,date,uuid[])'::regprocedure;
  v_definition text;
  v_old constant text := $fragment$        when profile.credit_due_rule = 'end_of_month' then 'เก็บสิ้นเดือน'$fragment$;
  v_new constant text := $fragment$        when profile.credit_due_rule = 'semi_monthly' then 'เก็บวันที่ 15 และสิ้นเดือน'
        when profile.credit_due_rule = 'end_of_month' then 'เก็บสิ้นเดือน'$fragment$;
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_old) = 0 then
    raise exception 'get_accounting_shop_daily_matrix does not contain the expected payment condition';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$extend_accounting_payment_condition$;

notify pgrst, 'reload schema';
