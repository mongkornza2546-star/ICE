-- Follow-up to 0254 (already safe to deploy independently after it).
-- Admins may cancel unpaid deliveries and void mistaken receipts after close.
-- Preserve paid-bill, reason, scope, refund and billing-statement protections.
-- Do not rewrite original stock/cash/handover close snapshots.
begin;

do $patch$
declare v_target record; v_definition text;
begin
  for v_target in select * from (values
    ('public.get_delivery_correction_context(uuid)', $old$elsif v_round.status <> 'open' then$old$, $new$elsif v_round.status <> 'open' and not (public.is_admin_business_date(v_round.service_date) and v_round.cancelled_at is null) then$new$),
    ('public.get_delivery_correction_context(uuid)', $old$elsif v_day_closed then$old$, $new$elsif v_day_closed and not (public.is_admin_business_date(v_round.service_date) and v_round.cancelled_at is null) then$new$),
    ('public.get_delivery_correction_context(uuid)', $old$'can_cancel', v_can_cancel,$old$, $new$'can_cancel', v_can_cancel,
    'can_cancel_closed_period', v_can_cancel and (public.is_admin_business_date(v_round.service_date) and v_round.cancelled_at is null),$new$),
    ('public.void_payment(uuid,text)', $old$  elsif v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or not exists (
      select 1 from public.collection_runs run
      where run.id = v_payment.collection_run_id and run.status = 'open'
    )
    or exists (
      select 1 from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_service_date
    ) then
$old$, $new$  elsif not public.is_admin_business_date(v_service_date) and (
v_service_date <> (clock_timestamp() at time zone 'Asia/Bangkok')::date
    or not exists (
      select 1 from public.collection_runs run
      where run.id = v_payment.collection_run_id and run.status = 'open'
    )
    or exists (
      select 1 from public.daily_aggregate_stock_closures closure
      where closure.service_date = v_service_date
    )) then
$new$),
    ('public.void_payment_before_automatic_context(uuid,text)', $old$where run.id = v_payment.collection_run_id and run.status = 'open'$old$, $new$where run.id = v_payment.collection_run_id
      and (run.status = 'open' or public.is_admin_business_date(run.service_date))$new$),
    ('public.void_payment_before_automatic_context(uuid,text)', $old$elsif v_payment.collection_run_id is null and exists ($old$, $new$elsif v_payment.collection_run_id is null
    and not public.is_admin_business_date(public.daily_close_payment_date(
      v_payment.received_date_override, null, v_payment.recorded_at)) and exists ($new$),
    ('public.guard_payment_cash_close()', $old$if tg_op = 'INSERT' and public.is_admin_business_date(v_date) then$old$, $new$if public.is_admin_business_date(v_date) and (tg_op = 'INSERT' or (
      tg_op = 'UPDATE' and old.status = 'active' and new.status = 'voided'
      and new.voided_by = auth.uid() and new.voided_at is not null
      and nullif(trim(new.void_reason), '') is not null
      and (to_jsonb(new) - array['status','voided_by','voided_at','void_reason'])
        = (to_jsonb(old) - array['status','voided_by','voided_at','void_reason'])
    )) then$new$)
  ) changes(signature, old_fragment, new_fragment) loop
    v_definition := pg_get_functiondef(v_target.signature::regprocedure);
    if strpos(v_definition,v_target.new_fragment)>0 then continue; end if;
    if strpos(v_definition,v_target.old_fragment)=0 then
      raise exception 'Unexpected post-close cancellation guard in %',v_target.signature;
    end if;
    execute replace(v_definition,v_target.old_fragment,v_target.new_fragment);
  end loop;
end;
$patch$;

create or replace function public.audit_admin_post_close_cancellation()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_date date; v_closed boolean; v_reason text;
begin
  if tg_table_name='delivery_events' then
    if old.status <> 'active' or new.status <> 'cancelled' then return new; end if;
    select round.service_date, round.status='closed' into v_date,v_closed
      from public.round_stops stop join public.delivery_rounds round on round.id=stop.round_id
      where stop.id=new.round_stop_id;
    v_closed := v_closed or public.admin_closed_stock_entry(v_date);
    v_reason := new.cancellation_reason;
  else
    if old.status <> 'active' or new.status <> 'voided' then return new; end if;
    v_date := public.daily_close_payment_date(new.received_date_override,
      (select service_date from public.collection_runs where id=new.collection_run_id),new.recorded_at);
    v_closed := exists (select 1 from public.daily_close_reconciliation_requests where service_date=v_date)
      or exists (select 1 from public.daily_aggregate_stock_closures where service_date=v_date)
      or exists (select 1 from public.daily_stock_closures where service_date=v_date and status='closed')
      or exists (select 1 from public.collection_runs where id=new.collection_run_id and status='closed');
    v_reason := new.void_reason;
  end if;
  if v_closed and public.is_admin_business_date(v_date) then
    insert into public.audit_logs(actor_id,entity_type,entity_id,action,before_value,after_value,reason)
    values(auth.uid(),tg_table_name,new.id,'admin_post_close_cancelled',to_jsonb(old),
      jsonb_build_object('service_date',v_date,'cancelled_at',clock_timestamp(),'record',to_jsonb(new)),v_reason);
  end if;
  return new;
end;
$$;
revoke all on function public.audit_admin_post_close_cancellation() from public,anon,authenticated;
drop trigger if exists delivery_events_admin_post_close_cancellation_audit on public.delivery_events;
create trigger delivery_events_admin_post_close_cancellation_audit after update on public.delivery_events
for each row execute function public.audit_admin_post_close_cancellation();
drop trigger if exists payments_admin_post_close_cancellation_audit on public.payments;
create trigger payments_admin_post_close_cancellation_audit after update on public.payments
for each row execute function public.audit_admin_post_close_cancellation();
notify pgrst,'reload schema';
commit;
