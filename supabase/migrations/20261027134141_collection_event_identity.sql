-- Extend both authorized queue projections in place. Preserve eligibility, VAT,
-- billing, closed-day guards, existing grants, and the unified-shop wrappers.
do $collection_event_identity$
declare
  v_signature text;
  v_definition text;
  v_patch record;
begin
  foreach v_signature in array array[
    'public.get_collection_run_queue(uuid)',
    'public.get_collection_queue_for_date(date,uuid)'
  ] loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    for v_patch in select * from (values
      ($old$'event_participation_id', queue.event_participation_id,$old$,
       $new$'event_participation_id', queue.event_participation_id,
    'event_job_id', queue.event_job_id,
    'event_start_date', queue.event_start_date,
    'event_end_date', queue.event_end_date,$new$),
      ($old$context.event_participation_id,$old$,
       $new$context.event_participation_id,
      job.id as event_job_id, job.start_date as event_start_date, job.end_date as event_end_date,$new$)
    ) as patches(old_text, new_text) loop
      if strpos(v_definition, v_patch.old_text) = 0 then
        raise exception 'Event identity projection boundary missing in %: %', v_signature, v_patch.old_text;
      end if;
      v_definition := replace(v_definition, v_patch.old_text, v_patch.new_text);
    end loop;
    execute v_definition;
  end loop;
end;
$collection_event_identity$;

-- Rental-only and carry-forward payments have no delivery event/round stop.
-- Resolve their identity through settlement context -> participation -> job,
-- keeping delivery snapshots first when present. Do not change visibility,
-- pagination, totals, received-date metadata, or immutable receipt snapshots.
do $payment_history_event_identity$
declare
  v_definition text := pg_get_functiondef('public.get_payment_history(date,date,integer,timestamptz,uuid)'::regprocedure);
  v_patch record;
begin
  for v_patch in select * from (values
    ($old$context.event_participation_id,$old$,
     $new$context.event_participation_id,
      job.id as event_job_id, job.start_date as event_start_date, job.end_date as event_end_date,$new$),
    ($old$on context.id = payment.event_settlement_context_id$old$,
     $new$on context.id = payment.event_settlement_context_id
    left join public.event_participations participation on participation.id = context.event_participation_id
    left join public.event_jobs job on job.id = participation.event_job_id$new$),
    ($old$stop.event_job_name_snapshot as event_name$old$,
     $new$coalesce(stop.event_job_name_snapshot, job.name) as event_name$new$),
    ($old$stop.event_location_snapshot as event_location$old$,
     $new$coalesce(stop.event_location_snapshot, job.location) as event_location$new$),
    ($old$stop.event_zone_snapshot as event_zone$old$,
     $new$coalesce(stop.event_zone_snapshot, participation.event_zone) as event_zone$new$),
    ($old$stop.event_booth_snapshot as event_booth$old$,
     $new$coalesce(stop.event_booth_snapshot, participation.booth_number) as event_booth$new$),
    ($old$else stop.event_location_snapshot end as building_name$old$,
     $new$else coalesce(stop.event_location_snapshot, job.location) end as building_name$new$),
    ($old$else stop.event_zone_snapshot end as zone_name$old$,
     $new$else coalesce(stop.event_zone_snapshot, participation.event_zone) end as zone_name$new$),
    ($old$'event_participation_id', returned.event_participation_id,$old$,
     $new$'event_participation_id', returned.event_participation_id,
    'event_job_id', returned.event_job_id,
    'event_start_date', returned.event_start_date,
    'event_end_date', returned.event_end_date,$new$)
  ) as patches(old_text, new_text) loop
    if strpos(v_definition, v_patch.old_text) = 0 then
      raise exception 'Payment history event projection boundary missing: %', v_patch.old_text;
    end if;
    v_definition := replace(v_definition, v_patch.old_text, v_patch.new_text);
  end loop;
  execute v_definition;
end;
$payment_history_event_identity$;

notify pgrst, 'reload schema';
