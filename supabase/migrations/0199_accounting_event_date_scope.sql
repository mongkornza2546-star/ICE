-- Event-created shops remain active after their event ends. Scope the shared
-- accounting registry to the report dates before facets, totals and pagination.
-- The public wrapper from 0154 serves both the screen and Excel export; retain
-- its casual-sale totals and keep financial history/open debt accessible.
do $accounting_event_scope$
declare
  v_definition text;
  v_updated text;
  v_old text := $old$    where shop.status = 'active'
  ), base_shops as materialized ($old$;
  v_new text := $new$    where shop.status = 'active'
      and (
        shop.event_job_id is null
        or exists (
          select 1
          from public.event_jobs job
          join public.event_participations participation
            on participation.event_job_id = job.id
            and participation.shop_id = shop.id
          where job.id = shop.event_job_id
            and job.status = 'published'
            and participation.status = 'active'
            and greatest(job.start_date, participation.start_date) <= p_to_date
            and least(job.end_date, participation.end_date) >= p_from_date
        )
        -- Closed/cancelled events still belong in accounting when they have
        -- invoices in the report period or any remaining ice-delivery debt.
        or exists (
          select 1
          from public.delivery_charges charge
          join public.delivery_events event on event.id = charge.delivery_event_id
          where charge.shop_id = shop.id
            and charge.status = 'active'
            and event.status = 'active'
            and (
              charge.service_date between p_from_date and p_to_date
              or public.effective_delivery_charge_amount(charge.id) > (
                select coalesce(sum(allocation.amount), 0)
                from public.payment_allocations allocation
                join public.payments payment on payment.id = allocation.payment_id
                where allocation.charge_id = charge.id and payment.status = 'active'
              )
            )
        )
        -- A later collection must remain visible even if it settles all debt.
        or exists (
          select 1 from public.payments payment
          where payment.shop_id = shop.id and payment.status = 'active'
            and payment.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
            and payment.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
        )
      )
  ), base_shops as materialized ($new$;
begin
  select pg_get_functiondef(
    'public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer)'::regprocedure
  ) into v_definition;
  if strpos(v_definition, v_new) > 0 then
    return;
  end if;
  v_updated := replace(v_definition, v_old, v_new);
  if v_updated = v_definition then
    raise exception 'Cannot apply accounting event date scope: registry definition has changed';
  end if;
  execute v_updated;
end;
$accounting_event_scope$;

notify pgrst, 'reload schema';
