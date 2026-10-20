-- Align accounting with executive sales: active delivery and rental charges,
-- net of stored VAT, on invoice service dates, including inactive shops.
-- Apply after 0244. Patch underlying readers to retain wrappers, permissions,
-- payment metadata, daily tank handoffs and Excel pagination contracts.
do $accounting_sales_scope$
declare
  v_patch record;
  v_definition text;
begin
  for v_patch in select * from (values
    ('public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer)'::regprocedure,
      $old$    where shop.status = 'active'
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
  ), base_shops as materialized ($old$,
      $new$    where (
      shop.status = 'active' and (
        shop.event_job_id is null
        or exists (
          select 1 from public.event_jobs job
          join public.event_participations participation
            on participation.event_job_id = job.id and participation.shop_id = shop.id
          where job.id = shop.event_job_id and job.status = 'published'
            and participation.status = 'active'
            and greatest(job.start_date, participation.start_date) <= p_to_date
            and least(job.end_date, participation.end_date) >= p_from_date
        )
      )
    ) or exists (
      -- Financial history survives shop/event deactivation, including rentals.
      select 1 from public.delivery_charges charge
      left join public.delivery_events event on event.id = charge.delivery_event_id
      where charge.shop_id = shop.id and charge.status = 'active'
        and (event.status = 'active' or charge.tank_rental_id is not null or charge.event_tank_rental_id is not null)
        and (charge.service_date between p_from_date and p_to_date
          or public.effective_delivery_charge_amount(charge.id) > (
            select coalesce(sum(allocation.amount), 0)
            from public.payment_allocations allocation
            join public.payments payment on payment.id = allocation.payment_id
            where allocation.charge_id = charge.id and payment.status = 'active'
          ))
    ) or exists (
      select 1 from public.payments payment
      where payment.shop_id = shop.id and payment.status = 'active'
        and payment.recorded_at >= p_from_date::timestamp at time zone 'Asia/Bangkok'
        and payment.recorded_at < (p_to_date + 1)::timestamp at time zone 'Asia/Bangkok'
    )
  ), base_shops as materialized ($new$),
    ('public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer)'::regprocedure,
      $old$      event.recorded_at,
      recorder.display_name as employee_name,$old$,
      $new$      coalesce(event.recorded_at, rental.recorded_at, event_rental.recorded_at) as recorded_at,
      recorder.display_name as employee_name,$new$),
    ('public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer)'::regprocedure,
      $old$    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.users recorder on recorder.id = event.recorded_by
    join public.round_stops stop on stop.id = event.round_stop_id
    where charge.status = 'active'
      and event.status = 'active'$old$,
      $new$    left join public.delivery_events event on event.id = charge.delivery_event_id
    left join public.shop_tank_rentals rental on rental.id = charge.tank_rental_id
    left join public.event_tank_register event_rental on event_rental.id = charge.event_tank_rental_id
    left join public.users recorder on recorder.id = coalesce(event.recorded_by, rental.recorded_by, event_rental.recorded_by)
    left join public.round_stops stop on stop.id = event.round_stop_id
    where charge.status = 'active'
      and (event.status = 'active' or charge.tank_rental_id is not null or charge.event_tank_rental_id is not null)$new$),
    ('public.get_accounting_shop_daily_matrix_without_casual(date,date,uuid[])'::regprocedure,
      $old$join public.shops shop on shop.id = requested.shop_id and shop.status = 'active'$old$,
      $new$join public.shops shop on shop.id = requested.shop_id -- Keep inactive shops selected by the summary.$new$),
    ('public.get_accounting_shop_daily_matrix_without_casual(date,date,uuid[])'::regprocedure,
      $old$    join public.delivery_events event on event.id = charge.delivery_event_id
    where charge.service_date between p_from_date and p_to_date
      and charge.status = 'active' and event.status = 'active'$old$,
      $new$    left join public.delivery_events event on event.id = charge.delivery_event_id
    where charge.service_date between p_from_date and p_to_date
      and charge.status = 'active'
      and (event.status = 'active' or charge.tank_rental_id is not null or charge.event_tank_rental_id is not null)$new$),
    ('public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'::regprocedure,
      $old$        event.recorded_at,
        recorder.display_name as recorded_by_name,
        stop.building_id_snapshot as building_id,
        stop.building_name_snapshot as building_name,$old$,
      $new$        coalesce(event.recorded_at, rental.recorded_at, event_rental.recorded_at) as recorded_at,
        recorder.display_name as recorded_by_name,
        coalesce(stop.building_id_snapshot, current_shop.building_id) as building_id,
        coalesce(stop.building_name_snapshot, building.name) as building_name,$new$),
    ('public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'::regprocedure,
      $old$      join public.delivery_events event on event.id = charge.delivery_event_id
      join public.round_stops stop on stop.id = event.round_stop_id
      join public.users recorder on recorder.id = event.recorded_by
      join public.shops current_shop on current_shop.id = charge.shop_id$old$,
      $new$      left join public.delivery_events event on event.id = charge.delivery_event_id
      left join public.round_stops stop on stop.id = event.round_stop_id
      left join public.shop_tank_rentals rental on rental.id = charge.tank_rental_id
      left join public.event_tank_register event_rental on event_rental.id = charge.event_tank_rental_id
      left join public.users recorder on recorder.id = coalesce(event.recorded_by, rental.recorded_by, event_rental.recorded_by)
      join public.shops current_shop on current_shop.id = charge.shop_id
      left join public.buildings building on building.id = current_shop.building_id
      left join public.event_settlement_contexts context on context.id = charge.event_settlement_context_id
      left join public.event_participations participation on participation.id = context.event_participation_id
      left join public.event_jobs job on job.id = participation.event_job_id$new$),
    ('public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'::regprocedure,
      $old$and event.status = 'active'$old$,
      $new$and (event.status = 'active' or charge.tank_rental_id is not null or charge.event_tank_rental_id is not null)$new$),
    ('public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'::regprocedure,
      $old$stop.building_id_snapshot::text = p_filters ->> 'building_id'$old$,
      $new$coalesce(stop.building_id_snapshot, current_shop.building_id)::text = p_filters ->> 'building_id'$new$),
    ('public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'::regprocedure,
      $old$        stop.destination_kind,
        charge.event_settlement_context_id,
        stop.event_participation_id,
        stop.event_job_name_snapshot as event_name,$old$,
      $new$        coalesce(stop.destination_kind::text, case when context.id is not null then 'event' else 'regular' end) as destination_kind,
        charge.event_settlement_context_id,
        coalesce(stop.event_participation_id, context.event_participation_id) as event_participation_id,
        coalesce(stop.event_job_name_snapshot, job.name) as event_name,$new$),
    ('public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'::regprocedure,
      $old$      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'ice_type_id', item.ice_type_id,
          'name', ice.name,
          'unit', ice.unit,
          'quantity', item.quantity,
          'unit_price', item.unit_price,
          'line_total', item.line_total
        ) order by ice.code)
        from public.delivery_items item
        join public.ice_types ice on ice.id = item.ice_type_id
        where item.delivery_event_id = invoice.delivery_event_id
      ), '[]'::jsonb),
$old$,
      $new$      'items', public.charge_line_items(invoice.charge_id),
$new$),
    ('public.get_accounting_shop_invoice_detail(uuid,date,date,jsonb,integer,integer)'::regprocedure,
      $old$invoice.recorded_at desc, invoice.delivery_event_id desc$old$,
      $new$invoice.recorded_at desc, invoice.charge_id desc$new$)
  ) as patches(function_id, old_text, new_text)
  loop
    v_definition := pg_get_functiondef(v_patch.function_id);
    if strpos(v_definition, v_patch.new_text) > 0 then continue; end if;
    if strpos(v_definition, v_patch.old_text) = 0 then
      raise exception 'Accounting sales scope boundary missing in %', v_patch.function_id;
    end if;
    execute replace(v_definition, v_patch.old_text, v_patch.new_text);
  end loop;
end;
$accounting_sales_scope$;

-- Replaced private readers must not inherit public EXECUTE via default grants.
revoke all on function public.get_accounting_shop_summary_without_casual(date,date,jsonb,integer,integer) from public, anon, authenticated;
revoke all on function public.get_accounting_shop_daily_matrix_without_casual(date,date,uuid[]) from public, anon, authenticated;
notify pgrst, 'reload schema';
