-- Store-level credit controls and a store-level AR projection. Financial
-- documents remain append-only; payments continue to reduce balances only
-- through payment_allocations.

alter table public.shop_payment_profiles
  add column credit_suspended boolean not null default false,
  add column credit_suspension_reason text,
  add column credit_suspended_by uuid references public.users(id) on delete restrict,
  add column credit_suspended_at timestamptz,
  add constraint shop_payment_profiles_credit_suspension_complete check (
    (not credit_suspended and credit_suspension_reason is null
      and credit_suspended_by is null and credit_suspended_at is null)
    or (credit_suspended and nullif(trim(coalesce(credit_suspension_reason, '')), '') is not null
      and credit_suspended_by is not null and credit_suspended_at is not null)
  );

create trigger shop_payment_profiles_audit_update
after update on public.shop_payment_profiles
for each row execute function public.audit_row_update();

create or replace function public.reject_suspended_credit_charge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_term = 'credit' and exists (
    select 1 from public.shop_payment_profiles profile
    where profile.shop_id = new.shop_id and profile.credit_suspended
  ) then
    raise exception 'Credit is suspended for this shop';
  end if;
  return new;
end;
$$;

create trigger delivery_charges_reject_suspended_credit
before insert on public.delivery_charges
for each row execute function public.reject_suspended_credit_charge();

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
  v_days integer;
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
  where key not in ('credit_limit', 'credit_days', 'credit_suspended', 'credit_suspension_reason')
  limit 1;
  if v_unknown_key is not null then
    raise exception 'Unsupported credit setting: %', v_unknown_key;
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

  if p_changes ? 'credit_days' then
    v_days := (p_changes->>'credit_days')::integer;
    if v_days < 1 then raise exception 'Credit days must be at least one'; end if;
  else
    v_days := v_profile.credit_days;
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
      credit_due_rule = case when p_changes ? 'credit_days' then 'net_days'::public.credit_due_rule else credit_due_rule end,
      credit_days = case when p_changes ? 'credit_days' then v_days else credit_days end,
      credit_suspended = v_suspended,
      credit_suspension_reason = case when v_suspended then v_reason else null end,
      credit_suspended_by = case when v_suspended then auth.uid() else null end,
      credit_suspended_at = case when v_suspended then coalesce(v_profile.credit_suspended_at, now()) else null end
  where id = v_profile.id
  returning * into v_profile;

  return jsonb_build_object(
    'shop_id', v_profile.shop_id,
    'credit_limit', v_profile.credit_limit,
    'credit_days', v_profile.credit_days,
    'credit_suspended', v_profile.credit_suspended,
    'credit_suspension_reason', v_profile.credit_suspension_reason
  );
end;
$$;

-- Due credit bills enter today's collection run automatically. An explicit
-- assignment remains useful for adding a future bill to a collection plan.
create or replace function public.is_charge_collectible_in_run(
  p_charge_id uuid,
  p_collection_run_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.delivery_charges charge
    join public.collection_runs run on run.id = p_collection_run_id and run.status = 'open'
    where charge.id = p_charge_id
      and charge.status = 'active'
      and (
        charge.payment_term in ('immediate', 'end_of_day')
        or (
          charge.payment_term = 'credit'
          and (
            charge.due_date <= run.service_date
            or exists (
              select 1 from public.collection_run_credit_charges assignment
              where assignment.collection_run_id = run.id and assignment.charge_id = charge.id
            )
          )
        )
      )
  );
$$;

-- Managers may deliberately place an outstanding future credit bill in a
-- collection plan. Due bills do not need this explicit assignment because
-- is_charge_collectible_in_run already includes them automatically.
create or replace function public.set_credit_charge_collection_assignment(
  p_collection_run_id uuid,
  p_charge_id uuid,
  p_assigned boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.collection_runs%rowtype;
  v_charge public.delivery_charges%rowtype;
  v_charge_shop_id uuid;
  v_outstanding numeric(12,2);
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can assign credit collections';
  elsif p_collection_run_id is null or p_charge_id is null or p_assigned is null then
    raise exception 'Collection run, charge, and assignment state are required';
  end if;

  select charge.shop_id into v_charge_shop_id
  from public.delivery_charges charge
  where charge.id = p_charge_id;
  if v_charge_shop_id is null then
    raise exception 'Only an active credit charge can be assigned for collection';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_charge_shop_id::text, 0));

  select run.* into v_run
  from public.collection_runs run
  where run.id = p_collection_run_id and run.status = 'open'
  for update;
  if v_run.id is null then
    raise exception 'The collection run is not open';
  end if;

  select charge.* into v_charge
  from public.delivery_charges charge
  where charge.id = p_charge_id
  for update;
  if v_charge.id is null or v_charge.status <> 'active' or v_charge.payment_term <> 'credit' then
    raise exception 'Only an active credit charge can be assigned for collection';
  end if;

  select greatest(v_charge.original_amount - coalesce(sum(allocation.amount)
    filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
  into v_outstanding
  from public.payment_allocations allocation
  join public.payments payment on payment.id = allocation.payment_id
  where allocation.charge_id = v_charge.id;

  if p_assigned and v_outstanding <= 0 then
    raise exception 'Only an outstanding credit charge can be assigned';
  elsif not p_assigned and exists (
    select 1
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.charge_id = v_charge.id
      and payment.collection_run_id = v_run.id
      and payment.status = 'active'
  ) then
    raise exception 'A credit charge with an active payment in this run cannot be unassigned';
  end if;

  if p_assigned then
    insert into public.collection_run_credit_charges (
      collection_run_id, charge_id, assigned_by
    ) values (
      v_run.id, v_charge.id, auth.uid()
    ) on conflict do nothing;
  else
    delete from public.collection_run_credit_charges assignment
    where assignment.collection_run_id = v_run.id and assignment.charge_id = v_charge.id;
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (auth.uid(), 'delivery_charges', v_charge.id,
    case when p_assigned then 'credit_collection_assigned' else 'credit_collection_unassigned' end,
    jsonb_build_object('collection_run_id', v_run.id, 'due_date', v_charge.due_date));

  return jsonb_build_object(
    'collection_run_id', v_run.id,
    'charge_id', v_charge.id,
    'assigned', p_assigned
  );
end;
$$;

create or replace function public.get_credit_receivables(
  p_as_of_date date default ((now() at time zone 'Asia/Bangkok')::date)
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view credit receivables';
  end if;

  return coalesce((
    with charge_balances as (
      select charge.*,
        coalesce(active_allocations.amount, 0)::numeric(12,2) as allocated_amount,
        greatest(charge.original_amount - coalesce(active_allocations.amount, 0), 0)::numeric(12,2) as outstanding_amount
      from public.delivery_charges charge
      left join lateral (
        select sum(allocation.amount)::numeric(12,2) as amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id and payment.status = 'active'
        where allocation.charge_id = charge.id
      ) active_allocations on true
      where charge.payment_term = 'credit' and charge.status = 'active'
    ), account_balances as (
      select charge.shop_id,
        sum(charge.outstanding_amount)::numeric(12,2) as outstanding_amount,
        min(charge.due_date) filter (where charge.outstanding_amount > 0) as oldest_due_date,
        sum(case when charge.due_date < p_as_of_date then charge.outstanding_amount else 0 end)::numeric(12,2) as overdue_amount,
        sum(case when charge.due_date = p_as_of_date then charge.outstanding_amount else 0 end)::numeric(12,2) as due_today_amount,
        count(*) filter (where charge.outstanding_amount > 0 and charge.due_date = p_as_of_date)::integer as due_today_charge_count,
        count(*) filter (where charge.outstanding_amount > 0 and charge.due_date < p_as_of_date)::integer as overdue_charge_count,
        sum(case when charge.due_date >= p_as_of_date then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_current_amount,
        sum(case when p_as_of_date - charge.due_date between 1 and 7 then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_1_7_amount,
        sum(case when p_as_of_date - charge.due_date between 8 and 15 then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_8_15_amount,
        sum(case when p_as_of_date - charge.due_date between 16 and 30 then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_16_30_amount,
        sum(case when p_as_of_date - charge.due_date > 30 then charge.outstanding_amount else 0 end)::numeric(12,2) as aging_over_30_amount
      from charge_balances charge
      group by charge.shop_id
    )
    select jsonb_agg(jsonb_build_object(
      'shop_id', shop.id,
      'shop_code', shop.code,
      'shop_name', shop.name,
      'building_name', latest_stop.building_name_snapshot,
      'zone_name', latest_stop.floor_or_zone_snapshot,
      'responsible_name', responsible.display_name,
      'credit_days', profile.credit_days,
      'credit_limit', profile.credit_limit,
      'available_credit_amount', case when profile.credit_limit is null then null
        else (profile.credit_limit - account.outstanding_amount)::numeric(12,2) end,
      'credit_suspended', profile.credit_suspended,
      'credit_suspension_reason', profile.credit_suspension_reason,
      'outstanding_amount', account.outstanding_amount,
      'oldest_due_date', account.oldest_due_date,
      'overdue_amount', account.overdue_amount,
      'due_today_amount', account.due_today_amount,
      'due_today_charge_count', account.due_today_charge_count,
      'overdue_charge_count', account.overdue_charge_count,
      'aging_current_amount', account.aging_current_amount,
      'aging_1_7_amount', account.aging_1_7_amount,
      'aging_8_15_amount', account.aging_8_15_amount,
      'aging_16_30_amount', account.aging_16_30_amount,
      'aging_over_30_amount', account.aging_over_30_amount,
      'last_payment_at', last_payment.recorded_at,
      'charges', '[]'::jsonb,
      'payments', '[]'::jsonb
    ) order by account.oldest_due_date nulls last, shop.code)
    from account_balances account
    join public.shops shop on shop.id = account.shop_id
    join public.shop_payment_profiles profile on profile.shop_id = shop.id
    left join lateral (
      select stop.round_id, stop.building_name_snapshot, stop.floor_or_zone_snapshot
      from public.round_stops stop
      join public.delivery_rounds round on round.id = stop.round_id
      where stop.shop_id = shop.id and round.service_date <= p_as_of_date
      order by round.service_date desc, stop.updated_at desc, stop.id
      limit 1
    ) latest_stop on true
    left join lateral (
      select string_agg(distinct member.display_name, ', ' order by member.display_name) as display_name
      from public.delivery_round_members membership
      join public.users member on member.id = membership.user_id
      where membership.round_id = latest_stop.round_id
    ) responsible on true
    left join lateral (
      select max(payment.recorded_at) as recorded_at
      from public.payments payment
      where payment.shop_id = shop.id and payment.status = 'active'
        and exists (
          select 1 from public.payment_allocations allocation
          join public.delivery_charges allocated_charge on allocated_charge.id = allocation.charge_id
          where allocation.payment_id = payment.id and allocated_charge.payment_term = 'credit'
        )
    ) last_payment on true
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_credit_receivable_detail(
  p_shop_id uuid,
  p_as_of_date date default ((now() at time zone 'Asia/Bangkok')::date)
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view credit receivables';
  elsif p_shop_id is null or not exists (
    select 1 from public.shop_payment_profiles profile
    where profile.shop_id = p_shop_id and 'credit' = any(profile.allowed_payment_terms)
  ) then
    raise exception 'The selected shop does not have a credit account';
  end if;

  return jsonb_build_object(
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_id', charge.id,
        'charge_number', charge.charge_number,
        'service_date', charge.service_date,
        'due_date', charge.due_date,
        'original_amount', charge.original_amount,
        'allocated_amount', balance.allocated_amount,
        'outstanding_amount', balance.outstanding_amount,
        'assigned_collection_run_id', (
          select assignment.collection_run_id
          from public.collection_run_credit_charges assignment
          join public.collection_runs run on run.id = assignment.collection_run_id
          where assignment.charge_id = charge.id and run.status = 'open'
            and run.service_date = p_as_of_date
          limit 1
        ),
        'days_overdue', greatest(p_as_of_date - charge.due_date, 0),
        'payment_status', case when balance.outstanding_amount = 0 then 'paid'
          when balance.allocated_amount > 0 then 'partial' else 'unpaid' end,
        'due_status', case when balance.outstanding_amount = 0 then 'paid'
          when charge.due_date < p_as_of_date then 'overdue'
          when charge.due_date = p_as_of_date then 'due_today' else 'not_due' end
      ) order by charge.due_date, charge.created_at, charge.id)
      from public.delivery_charges charge
      join lateral (
        select
          coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2) as allocated_amount,
          greatest(charge.original_amount - coalesce(sum(allocation.amount)
            filter (where payment.status = 'active'), 0), 0)::numeric(12,2) as outstanding_amount
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id
          and allocation.charge_id = charge.id
      ) balance on true
      where charge.shop_id = p_shop_id and charge.payment_term = 'credit' and charge.status = 'active'
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', payment.id,
        'receipt_number', payment.receipt_number,
        'received_amount', payment.received_amount,
        'allocated_amount', payment.allocated_amount,
        'payment_method', payment.payment_method,
        'status', payment.status,
        'recorded_at', payment.recorded_at,
        'recorded_by', recorder.display_name,
        'allocations', coalesce((
          select jsonb_agg(jsonb_build_object(
            'charge_id', allocated_charge.id,
            'charge_number', allocated_charge.charge_number,
            'amount', allocation.amount
          ) order by allocated_charge.due_date, allocated_charge.created_at)
          from public.payment_allocations allocation
          join public.delivery_charges allocated_charge on allocated_charge.id = allocation.charge_id
          where allocation.payment_id = payment.id and allocated_charge.payment_term = 'credit'
        ), '[]'::jsonb)
      ) order by payment.recorded_at desc)
      from public.payments payment
      join public.users recorder on recorder.id = payment.recorded_by
      where payment.shop_id = p_shop_id and exists (
        select 1 from public.payment_allocations allocation
        join public.delivery_charges allocated_charge on allocated_charge.id = allocation.charge_id
        where allocation.payment_id = payment.id and allocated_charge.payment_term = 'credit'
      )
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.reject_suspended_credit_charge() from public;
revoke all on function public.update_credit_account_settings(uuid, jsonb) from public;
revoke all on function public.get_credit_receivable_detail(uuid, date) from public;
grant execute on function public.update_credit_account_settings(uuid, jsonb) to authenticated;
grant execute on function public.get_credit_receivables(date) to authenticated;
grant execute on function public.get_credit_receivable_detail(uuid, date) to authenticated;

notify pgrst, 'reload schema';
