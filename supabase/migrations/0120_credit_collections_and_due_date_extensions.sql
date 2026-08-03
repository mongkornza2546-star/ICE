-- Credit balances are collected in the same assigned collection run as other
-- balances.  Due-date changes are append-only requests; delivery charges keep
-- the effective date only after a manager decision has been recorded.

create table public.credit_due_date_requests (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.delivery_charges(id) on delete restrict,
  shop_id uuid not null references public.shops(id) on delete restrict,
  original_due_date date not null,
  requested_due_date date not null,
  reason text not null check (nullif(trim(reason), '') is not null),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid not null references public.users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  decided_by uuid references public.users(id) on delete restrict,
  decided_at timestamptz,
  decision_reason text,
  check (requested_due_date > original_due_date),
  check (
    (status = 'pending' and decided_by is null and decided_at is null and decision_reason is null)
    or (status = 'approved' and decided_by is not null and decided_at is not null)
    or (status = 'rejected' and decided_by is not null and decided_at is not null
      and nullif(trim(coalesce(decision_reason, '')), '') is not null)
  )
);

create unique index credit_due_date_requests_one_pending_charge_idx
  on public.credit_due_date_requests (charge_id) where status = 'pending';
create index credit_due_date_requests_shop_status_idx
  on public.credit_due_date_requests (shop_id, status, requested_at desc);

create table public.collection_run_credit_charges (
  collection_run_id uuid not null references public.collection_runs(id) on delete restrict,
  charge_id uuid not null references public.delivery_charges(id) on delete restrict,
  assigned_by uuid not null references public.users(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  primary key (collection_run_id, charge_id)
);

create index collection_run_credit_charges_charge_idx
  on public.collection_run_credit_charges (charge_id, collection_run_id);

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
          and charge.due_date <= run.service_date
          and exists (
            select 1
            from public.collection_run_credit_charges assignment
            where assignment.collection_run_id = run.id
              and assignment.charge_id = charge.id
          )
        )
      )
  );
$$;

create or replace function public.protect_credit_due_date_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.due_date is distinct from old.due_date
    and current_setting('app.credit_due_date_change_approved', true) is distinct from 'on' then
    raise exception 'Credit due dates can only change through an approved due-date request';
  end if;
  return new;
end;
$$;

create trigger delivery_charges_protect_credit_due_date_history
before update of due_date on public.delivery_charges
for each row execute function public.protect_credit_due_date_history();

create or replace function public.get_credit_due_date_request(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', request.id, 'charge_id', request.charge_id, 'shop_id', request.shop_id,
    'charge_number', charge.charge_number, 'shop_code', shop.code, 'shop_name', shop.name,
    'original_due_date', request.original_due_date, 'requested_due_date', request.requested_due_date,
    'reason', request.reason, 'status', request.status, 'requested_at', request.requested_at,
    'requested_by', requester.display_name, 'decided_at', request.decided_at,
    'decided_by', decider.display_name, 'decision_reason', request.decision_reason
  )
  from public.credit_due_date_requests request
  join public.delivery_charges charge on charge.id = request.charge_id
  join public.shops shop on shop.id = request.shop_id
  join public.users requester on requester.id = request.requested_by
  left join public.users decider on decider.id = request.decided_by
  where request.id = p_request_id;
$$;

create or replace function public.get_collection_run_queue(p_collection_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;

  if not exists (
    select 1 from public.collection_runs run
    where run.id = p_collection_run_id and run.status = 'open'
      and (public.current_app_role() in ('admin', 'round_lead') or public.is_collection_run_member(run.id))
  ) then
    raise exception 'The collection run does not exist, is closed, or is not assigned to this user';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shop_id', queue.shop_id,
      'shop_code', queue.shop_code,
      'shop_name', queue.shop_name,
      'image_path', queue.image_path,
      'outstanding_amount', queue.outstanding_amount,
      'charge_count', queue.charge_count,
      'latest_charge_at', queue.latest_charge_at,
      'latest_payment_at', queue.latest_payment_at,
      'has_new_charges', queue.latest_payment_at is not null and queue.latest_charge_at > queue.latest_payment_at,
      'payment_profile', queue.payment_profile,
      'charges', queue.charges
    ) order by queue.shop_code)
    from (
      select shop.id as shop_id, shop.code as shop_code, shop.name as shop_name, shop.image_path,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        count(*)::integer as charge_count, max(charge.created_at) as latest_charge_at,
        jsonb_build_object(
          'allowed_payment_methods', profile.allowed_payment_methods,
          'default_payment_method', profile.default_payment_method,
          'cash_reference_required', profile.cash_reference_required,
          'cash_evidence_required', profile.cash_evidence_required,
          'bank_transfer_reference_required', profile.bank_transfer_reference_required,
          'bank_transfer_evidence_required', profile.bank_transfer_evidence_required,
          'qr_reference_required', profile.qr_reference_required,
          'qr_evidence_required', profile.qr_evidence_required
        ) as payment_profile,
        (select max(payment.recorded_at) from public.payments payment
          where payment.shop_id = shop.id and payment.collection_run_id = p_collection_run_id
            and payment.status = 'active') as latest_payment_at,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id, 'charge_number', charge.charge_number,
          'delivery_event_id', charge.delivery_event_id, 'service_date', charge.service_date,
          'payment_term', charge.payment_term, 'due_date', charge.due_date,
          'original_amount', charge.original_amount, 'outstanding_amount', balance.outstanding_amount,
          'created_at', charge.created_at,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'ice_type_id', ice.id, 'name', ice.name, 'unit', ice.unit,
              'quantity', item.quantity, 'line_total', item.line_total
            ) order by ice.code)
            from public.delivery_items item join public.ice_types ice on ice.id = item.ice_type_id
            where item.delivery_event_id = charge.delivery_event_id
          ), '[]'::jsonb)
        ) order by coalesce(charge.due_date, charge.service_date), charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      join public.shops shop on shop.id = charge.shop_id
      join public.shop_payment_profiles profile on profile.shop_id = shop.id
      join lateral (
        select greatest(charge.original_amount - coalesce(sum(allocation.amount)
          filter (where payment.status = 'active'), 0), 0)::numeric(12,2) as outstanding_amount
        from public.payment_allocations allocation join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where public.is_charge_collectible_in_run(charge.id, p_collection_run_id)
        and balance.outstanding_amount > 0
      group by shop.id, profile.id
    ) queue
  ), '[]'::jsonb);
end;
$$;

-- The established payment RPC already serializes a shop and checks the
-- idempotency key. Extend only its collection-run scope, then enforce FIFO for
-- credit allocations inside the same transaction.
do $credit_collection_payment_scope$
declare
  v_function regprocedure :=
    'public.record_payment(uuid,jsonb,public.payment_method,numeric,text,text,uuid,numeric,uuid,uuid)'::regprocedure;
  v_definition text;
  v_scope constant text := $fragment$        or charge.payment_term not in ('immediate', 'end_of_day')$fragment$;
  v_eligible_scope constant text := $fragment$        or not public.is_charge_collectible_in_run(charge.id, p_collection_run_id)$fragment$;
  v_outstanding_scope constant text := $fragment$        and charge.payment_term in ('immediate', 'end_of_day')$fragment$;
  v_eligible_outstanding_scope constant text := $fragment$        and public.is_charge_collectible_in_run(charge.id, p_collection_run_id)$fragment$;
  v_marker constant text := '  v_remaining_outstanding := (v_current_outstanding - v_allocated_amount)::numeric(12,2);';
  v_fifo text;
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_scope) = 0 or strpos(v_definition, v_outstanding_scope) = 0 then
    raise exception 'record_payment does not contain the expected collection scopes';
  end if;
  v_definition := replace(v_definition, v_scope, v_eligible_scope);
  v_definition := replace(v_definition, v_outstanding_scope, v_eligible_outstanding_scope);

  v_fifo := $fifo$
  if p_collection_run_id is not null and exists (
    select 1
    from jsonb_to_recordset(p_allocations) requested(charge_id uuid, amount numeric)
    join public.delivery_charges target on target.id = requested.charge_id
    where target.payment_term = 'credit'
      and exists (
        select 1
        from public.delivery_charges older
        left join lateral (
          select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2) as paid
          from public.payment_allocations allocation join public.payments payment on payment.id = allocation.payment_id
          where allocation.charge_id = older.id
        ) older_balance on true
        left join lateral (
          select allocation.amount::numeric(12,2) as proposed
          from jsonb_to_recordset(p_allocations) allocation(charge_id uuid, amount numeric)
          where allocation.charge_id = older.id
        ) proposed on true
        where older.shop_id = p_shop_id and older.payment_term = 'credit'
          and public.is_charge_collectible_in_run(older.id, p_collection_run_id)
          and (older.due_date, older.created_at, older.id) < (target.due_date, target.created_at, target.id)
          and older.original_amount - older_balance.paid - coalesce(proposed.proposed, 0) > 0
      )
  ) then
    raise exception 'Credit payments must be allocated to the oldest due balance first';
  end if;

  v_remaining_outstanding := (v_current_outstanding - v_allocated_amount)::numeric(12,2);$fifo$;

  if strpos(v_definition, v_marker) = 0 then
    raise exception 'record_payment does not contain the expected allocation marker';
  end if;
  v_definition := replace(v_definition, v_marker, v_fifo);
  execute v_definition;
end;
$credit_collection_payment_scope$;

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

  if p_assigned and (v_charge.due_date > v_run.service_date or v_outstanding <= 0) then
    raise exception 'Only an outstanding credit charge due by this run can be assigned';
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

create or replace function public.request_credit_due_date_change(
  p_charge_id uuid,
  p_requested_due_date date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge public.delivery_charges%rowtype;
  v_outstanding numeric(12,2);
  v_request_id uuid;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_charge_id is null or p_requested_due_date is null
    or nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Charge, new due date, and reason are required';
  end if;

  select charge.* into v_charge from public.delivery_charges charge where charge.id = p_charge_id for update;
  if v_charge.id is null or v_charge.status <> 'active' or v_charge.payment_term <> 'credit' then
    raise exception 'Only an active credit charge can have its due date extended';
  elsif not (public.current_app_role() in ('admin', 'round_lead') or exists (
    select 1
    from public.collection_run_credit_charges assignment
    join public.collection_runs run on run.id = assignment.collection_run_id
    where assignment.charge_id = v_charge.id
      and run.status = 'open'
      and public.is_collection_run_member(run.id)
  )) then
    raise exception 'The charge is not assigned to the current collector';
  elsif p_requested_due_date <= v_charge.due_date then
    raise exception 'The new due date must be later than the current due date';
  end if;

  select greatest(v_charge.original_amount - coalesce(sum(allocation.amount)
    filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
  into v_outstanding
  from public.payment_allocations allocation join public.payments payment on payment.id = allocation.payment_id
  where allocation.charge_id = v_charge.id;
  if v_outstanding <= 0 then
    raise exception 'A fully paid credit charge cannot have its due date extended';
  end if;

  insert into public.credit_due_date_requests (
    charge_id, shop_id, original_due_date, requested_due_date, reason, requested_by
  ) values (
    v_charge.id, v_charge.shop_id, v_charge.due_date, p_requested_due_date, trim(p_reason), auth.uid()
  ) returning id into v_request_id;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (auth.uid(), 'credit_due_date_requests', v_request_id, 'requested', jsonb_build_object(
    'charge_id', v_charge.id, 'old_due_date', v_charge.due_date,
    'new_due_date', p_requested_due_date, 'reason', trim(p_reason)
  ));
  return public.get_credit_due_date_request(v_request_id);
end;
$$;

create or replace function public.get_credit_due_date_request(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', request.id, 'charge_id', request.charge_id, 'shop_id', request.shop_id,
    'charge_number', charge.charge_number, 'shop_code', shop.code, 'shop_name', shop.name,
    'original_due_date', request.original_due_date, 'requested_due_date', request.requested_due_date,
    'reason', request.reason, 'status', request.status, 'requested_at', request.requested_at,
    'requested_by', requester.display_name, 'decided_at', request.decided_at,
    'decided_by', decider.display_name, 'decision_reason', request.decision_reason
  )
  from public.credit_due_date_requests request
  join public.delivery_charges charge on charge.id = request.charge_id
  join public.shops shop on shop.id = request.shop_id
  join public.users requester on requester.id = request.requested_by
  left join public.users decider on decider.id = request.decided_by
  where request.id = p_request_id;
$$;

create or replace function public.get_credit_due_date_requests(p_pending_only boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user()
    or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view due-date requests';
  end if;
  return coalesce((
    select jsonb_agg(public.get_credit_due_date_request(request.id) order by request.requested_at)
    from public.credit_due_date_requests request
    where not p_pending_only or request.status = 'pending'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.decide_credit_due_date_request(
  p_request_id uuid,
  p_decision text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.credit_due_date_requests%rowtype;
  v_charge public.delivery_charges%rowtype;
  v_request_shop_id uuid;
  v_outstanding numeric(12,2);
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can decide due-date requests';
  elsif p_decision not in ('approved', 'rejected') then
    raise exception 'The decision must be approved or rejected';
  elsif p_decision = 'rejected' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A rejection reason is required';
  end if;

  select request.shop_id into v_request_shop_id
  from public.credit_due_date_requests request
  where request.id = p_request_id and request.status = 'pending';
  if v_request_shop_id is null then
    raise exception 'The due-date request is no longer pending';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || v_request_shop_id::text, 0));

  select request.* into v_request from public.credit_due_date_requests request
  where request.id = p_request_id and request.status = 'pending' for update;
  if v_request.id is null then
    raise exception 'The due-date request is no longer pending';
  end if;
  select charge.* into v_charge from public.delivery_charges charge where charge.id = v_request.charge_id for update;
  select greatest(v_charge.original_amount - coalesce(sum(allocation.amount)
    filter (where payment.status = 'active'), 0), 0)::numeric(12,2)
  into v_outstanding
  from public.payment_allocations allocation join public.payments payment on payment.id = allocation.payment_id
  where allocation.charge_id = v_charge.id;
  if p_decision = 'approved' and (v_charge.status <> 'active' or v_charge.payment_term <> 'credit'
    or v_charge.due_date <> v_request.original_due_date or v_outstanding <= 0) then
    raise exception 'The credit charge changed and cannot use this due-date request';
  end if;

  update public.credit_due_date_requests
  set status = p_decision, decided_by = auth.uid(), decided_at = now(),
      decision_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = v_request.id;
  if p_decision = 'approved' then
    perform set_config('app.credit_due_date_change_approved', 'on', true);
    update public.delivery_charges set due_date = v_request.requested_due_date where id = v_charge.id;
    delete from public.collection_run_credit_charges assignment
    using public.collection_runs run
    where assignment.collection_run_id = run.id
      and assignment.charge_id = v_charge.id
      and run.status = 'open'
      and run.service_date < v_request.requested_due_date;
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_value, after_value)
  values (auth.uid(), 'credit_due_date_requests', v_request.id, 'decided',
    jsonb_build_object('old_due_date', v_request.original_due_date),
    jsonb_build_object('decision', p_decision, 'new_due_date', v_request.requested_due_date,
      'reason', nullif(trim(coalesce(p_reason, '')), '')));
  return public.get_credit_due_date_request(v_request.id);
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
    select jsonb_agg(jsonb_build_object(
      'shop_id', receivable.shop_id, 'shop_code', receivable.shop_code, 'shop_name', receivable.shop_name,
      'credit_limit', receivable.credit_limit, 'available_credit_amount', receivable.available_credit_amount,
      'original_amount', receivable.original_amount, 'allocated_amount', receivable.allocated_amount,
      'outstanding_amount', receivable.outstanding_amount, 'oldest_due_date', receivable.oldest_due_date,
      'overdue_amount', receivable.overdue_amount, 'charges', receivable.charges
    ) order by receivable.oldest_due_date nulls last, receivable.shop_code)
    from (
      select shop.id as shop_id, shop.code as shop_code, shop.name as shop_name,
        profile.credit_limit,
        case when profile.credit_limit is null then null
          else greatest(profile.credit_limit - sum(balance.outstanding_amount), 0)::numeric(12,2)
        end as available_credit_amount,
        sum(charge.original_amount)::numeric(12,2) as original_amount,
        sum(balance.allocated_amount)::numeric(12,2) as allocated_amount,
        sum(balance.outstanding_amount)::numeric(12,2) as outstanding_amount,
        min(charge.due_date) filter (where balance.outstanding_amount > 0) as oldest_due_date,
        sum(case when charge.due_date < p_as_of_date then balance.outstanding_amount else 0 end)::numeric(12,2)
          as overdue_amount,
        jsonb_agg(jsonb_build_object(
          'charge_id', charge.id, 'charge_number', charge.charge_number, 'service_date', charge.service_date,
          'due_date', charge.due_date, 'original_amount', charge.original_amount,
          'allocated_amount', balance.allocated_amount, 'outstanding_amount', balance.outstanding_amount,
          'assigned_collection_run_id', (
            select assignment.collection_run_id
            from public.collection_run_credit_charges assignment
            join public.collection_runs run on run.id = assignment.collection_run_id
            where assignment.charge_id = charge.id
              and run.status = 'open'
              and run.service_date = p_as_of_date
            limit 1
          ),
          'days_overdue', greatest(p_as_of_date - charge.due_date, 0),
          'payment_status', case when balance.outstanding_amount = 0 then 'paid'
            when balance.allocated_amount > 0 then 'partial' else 'unpaid' end,
          'due_status', case when balance.outstanding_amount = 0 then 'paid'
            when charge.due_date < p_as_of_date then 'overdue'
            when charge.due_date = p_as_of_date then 'due_today' else 'not_due' end
        ) order by charge.due_date, charge.created_at, charge.id) as charges
      from public.delivery_charges charge
      join public.shops shop on shop.id = charge.shop_id
      join public.shop_payment_profiles profile on profile.shop_id = shop.id
      join lateral (
        select coalesce(sum(allocation.amount) filter (where payment.status = 'active'), 0)::numeric(12,2) as allocated_amount,
          greatest(charge.original_amount - coalesce(sum(allocation.amount)
            filter (where payment.status = 'active'), 0), 0)::numeric(12,2) as outstanding_amount
        from public.payment_allocations allocation join public.payments payment on payment.id = allocation.payment_id
        where allocation.charge_id = charge.id
      ) balance on true
      where charge.payment_term = 'credit' and charge.status = 'active'
      group by shop.id, profile.id
    ) receivable
  ), '[]'::jsonb);
end;
$$;

alter table public.credit_due_date_requests enable row level security;
alter table public.collection_run_credit_charges enable row level security;
create policy "requesters or managers read credit due-date requests"
  on public.credit_due_date_requests for select using (
    public.is_active_user() and (requested_by = auth.uid() or public.current_app_role() in ('admin', 'round_lead'))
  );
create policy "assigned collectors or managers read credit collection assignments"
  on public.collection_run_credit_charges for select using (
    public.is_active_user() and (
      public.current_app_role() in ('admin', 'round_lead')
      or public.is_collection_run_member(collection_run_id)
    )
  );

revoke all on function public.protect_credit_due_date_history() from public;
revoke all on function public.is_charge_collectible_in_run(uuid, uuid) from public;
revoke all on function public.set_credit_charge_collection_assignment(uuid, uuid, boolean) from public;
revoke all on function public.request_credit_due_date_change(uuid, date, text) from public;
revoke all on function public.get_credit_due_date_request(uuid) from public;
revoke all on function public.get_credit_due_date_requests(boolean) from public;
revoke all on function public.decide_credit_due_date_request(uuid, text, text) from public;
grant execute on function public.get_collection_run_queue(uuid) to authenticated;
grant execute on function public.set_credit_charge_collection_assignment(uuid, uuid, boolean) to authenticated;
grant execute on function public.request_credit_due_date_change(uuid, date, text) to authenticated;
grant execute on function public.get_credit_due_date_requests(boolean) to authenticated;
grant execute on function public.decide_credit_due_date_request(uuid, text, text) to authenticated;
grant execute on function public.get_credit_receivables(date) to authenticated;

notify pgrst, 'reload schema';
