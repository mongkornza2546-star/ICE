-- Expose the source delivery for each credit bill so managers can inspect and
-- revise it through the existing audited revise_delivery_event workflow.
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
    'ice_types', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ice.id, 'code', ice.code, 'name', ice.name, 'unit', ice.unit
      ) order by ice.code)
      from public.ice_types ice
      where ice.is_active
    ), '[]'::jsonb),
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
          join public.collection_runs collection_run on collection_run.id = assignment.collection_run_id
          where assignment.charge_id = charge.id and collection_run.status = 'open'
            and collection_run.service_date = p_as_of_date
          limit 1
        ),
        'days_overdue', greatest(p_as_of_date - charge.due_date, 0),
        'payment_status', case when balance.outstanding_amount = 0 then 'paid'
          when balance.allocated_amount > 0 then 'partial' else 'unpaid' end,
        'due_status', case when balance.outstanding_amount = 0 then 'paid'
          when charge.due_date < p_as_of_date then 'overdue'
          when charge.due_date = p_as_of_date then 'due_today' else 'not_due' end,
        'delivery_event_id', delivery_event.id,
        'round_status', delivery_round.status,
        'stop_status', coalesce(
          (
            select audit.after_value ->> 'stop_status'
            from public.audit_logs audit
            where audit.entity_type = 'delivery_events' and audit.entity_id = delivery_event.id
              and audit.after_value ? 'stop_status'
            order by audit.occurred_at
            limit 1
          ),
          case when exists (
            select 1 from public.delivery_items item where item.delivery_event_id = delivery_event.id
          ) then 'delivered' else 'issue' end
        ),
        'note', delivery_event.note,
        'recorded_at', delivery_event.recorded_at,
        'recorded_by', recorder.display_name,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ice_type_id', item.ice_type_id,
            'name', ice.name,
            'unit', ice.unit,
            'quantity', item.quantity
          ) order by ice.code)
          from public.delivery_items item
          join public.ice_types ice on ice.id = item.ice_type_id
          where item.delivery_event_id = delivery_event.id
        ), '[]'::jsonb)
      ) order by charge.due_date, charge.created_at, charge.id)
      from public.delivery_charges charge
      join public.delivery_events delivery_event on delivery_event.id = charge.delivery_event_id
      join public.round_stops stop on stop.id = delivery_event.round_stop_id
      join public.delivery_rounds delivery_round on delivery_round.id = stop.round_id
      join public.users recorder on recorder.id = delivery_event.recorded_by
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

-- A delivery correction replaces its financial charge. Keep charge-scoped
-- collection and due-date work attached to the active replacement charge.
create or replace function public.reconcile_credit_charge_revision_workflows()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original_charge_id uuid;
  v_replacement_charge_id uuid;
begin
  select charge.id into v_original_charge_id
  from public.delivery_charges charge
  where charge.delivery_event_id = new.original_event_id;

  if v_original_charge_id is null then
    return new;
  end if;

  select charge.id into v_replacement_charge_id
  from public.delivery_charges charge
  where charge.delivery_event_id = new.replacement_event_id
    and charge.status = 'active';

  if v_replacement_charge_id is not null then
    insert into public.collection_run_credit_charges (
      collection_run_id, charge_id, assigned_by, assigned_at
    )
    select assignment.collection_run_id, v_replacement_charge_id,
      assignment.assigned_by, assignment.assigned_at
    from public.collection_run_credit_charges assignment
    join public.collection_runs collection_run on collection_run.id = assignment.collection_run_id
    where assignment.charge_id = v_original_charge_id
      and collection_run.status = 'open'
    on conflict do nothing;

    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, before_value, after_value, reason
    )
    select new.revised_by, 'delivery_charges', v_replacement_charge_id,
      'collection_reassigned_after_delivery_revision',
      jsonb_build_object(
        'charge_id', v_original_charge_id,
        'collection_run_id', assignment.collection_run_id
      ),
      jsonb_build_object(
        'charge_id', v_replacement_charge_id,
        'collection_run_id', assignment.collection_run_id
      ), new.reason
    from public.collection_run_credit_charges assignment
    join public.collection_runs collection_run on collection_run.id = assignment.collection_run_id
    where assignment.charge_id = v_original_charge_id
      and collection_run.status = 'open';

    delete from public.collection_run_credit_charges assignment
    using public.collection_runs collection_run
    where assignment.collection_run_id = collection_run.id
      and assignment.charge_id = v_original_charge_id
      and collection_run.status = 'open';

    with moved_request as (
      update public.credit_due_date_requests request
      set charge_id = v_replacement_charge_id
      where request.charge_id = v_original_charge_id and request.status = 'pending'
      returning request.id
    )
    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, before_value, after_value, reason
    )
    select new.revised_by, 'credit_due_date_requests', request.id,
      'retargeted_after_delivery_revision',
      jsonb_build_object('charge_id', v_original_charge_id),
      jsonb_build_object('charge_id', v_replacement_charge_id), new.reason
    from moved_request request;
  else
    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, before_value, after_value, reason
    )
    select new.revised_by, 'delivery_charges', v_original_charge_id,
      'collection_unassigned_after_delivery_revision',
      jsonb_build_object('collection_run_id', assignment.collection_run_id),
      jsonb_build_object('collection_run_id', null), new.reason
    from public.collection_run_credit_charges assignment
    join public.collection_runs collection_run on collection_run.id = assignment.collection_run_id
    where assignment.charge_id = v_original_charge_id
      and collection_run.status = 'open';

    delete from public.collection_run_credit_charges assignment
    using public.collection_runs collection_run
    where assignment.collection_run_id = collection_run.id
      and assignment.charge_id = v_original_charge_id
      and collection_run.status = 'open';

    with rejected_request as (
      update public.credit_due_date_requests request
      set status = 'rejected', decided_by = new.revised_by, decided_at = now(),
          decision_reason = 'Delivery revision: ' || new.reason
      where request.charge_id = v_original_charge_id and request.status = 'pending'
      returning request.id
    )
    insert into public.audit_logs (
      actor_id, entity_type, entity_id, action, before_value, after_value, reason
    )
    select new.revised_by, 'credit_due_date_requests', request.id,
      'rejected_after_delivery_revision',
      jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'rejected'),
      new.reason
    from rejected_request request;
  end if;

  return new;
end;
$$;

drop trigger if exists delivery_event_revisions_reconcile_credit_workflows
  on public.delivery_event_revisions;
create trigger delivery_event_revisions_reconcile_credit_workflows
after insert on public.delivery_event_revisions
for each row execute function public.reconcile_credit_charge_revision_workflows();

revoke all on function public.get_credit_receivable_detail(uuid, date) from public;
revoke all on function public.reconcile_credit_charge_revision_workflows() from public;
grant execute on function public.get_credit_receivable_detail(uuid, date) to authenticated;

notify pgrst, 'reload schema';
