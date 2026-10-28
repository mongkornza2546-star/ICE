-- Share the installed cancellation rules between history and the write preview.
-- History needs eligibility only, not the dialog's full price/item calculations.
begin;

do $shared_policy$
declare
  v_definition text;
  v_body text;
  v_policy_body text;
  v_start integer;
  v_end integer;
begin
  select pg_get_functiondef(oid), prosrc into v_definition, v_body
  from pg_proc where oid = 'public.get_delivery_correction_context(uuid)'::regprocedure;
  if strpos(v_body, 'public.get_delivery_cancellation_policy(p_event_id)') > 0 then return; end if;
  v_start := strpos(v_body, '  select coalesce(sum(allocation.amount)');
  v_end := strpos(v_body, '  return jsonb_build_object(');
  if v_start = 0 or v_end <= v_start
    or strpos(v_body, 'v_blocker text;') = 0
    or strpos(v_body, 'public.require_regular_delivery_event(p_event_id)') = 0
    or strpos(v_body, 'if not public.is_active_user()') = 0
    or strpos(v_body, 'public.is_admin_business_date(v_round.service_date)') = 0 then
    raise exception 'Unexpected delivery correction policy';
  end if;

  -- Copy the installed policy verbatim, including regular/event fencing,
  -- paid-bill checks, admin ordering and post-close exceptions.
  v_policy_body := left(v_body, v_end - 1) || $body$
  return jsonb_build_object(
    'can_correct', v_can_correct,
    'can_cancel', v_can_cancel,
    'can_cancel_closed_period', v_can_cancel and (
      public.is_admin_business_date(v_round.service_date) and v_round.cancelled_at is null),
    'blocker_reason', v_blocker,
    'allocated_amount', v_allocated,
    'is_latest', v_is_latest,
    'day_closed', v_day_closed
  );
end;
$body$;
  execute format('create or replace function public.get_delivery_cancellation_policy(p_event_id uuid)
    returns jsonb language plpgsql stable security definer set search_path = public as %L', v_policy_body);

  v_body := left(v_body, v_start - 1) || $body$
  v_policy := public.get_delivery_cancellation_policy(p_event_id);
  v_can_correct := (v_policy->>'can_correct')::boolean;
  v_can_cancel := (v_policy->>'can_cancel')::boolean;
  v_blocker := v_policy->>'blocker_reason';
  v_allocated := (v_policy->>'allocated_amount')::numeric;
  v_is_latest := (v_policy->>'is_latest')::boolean;
  v_day_closed := (v_policy->>'day_closed')::boolean;

$body$ || substr(v_body, v_end);
  v_body := replace(v_body, 'v_blocker text;', E'v_blocker text;\n  v_policy jsonb;');
  v_body := replace(v_body,
    'v_can_cancel and (public.is_admin_business_date(v_round.service_date) and v_round.cancelled_at is null)',
    '(v_policy->>''can_cancel_closed_period'')::boolean');
  execute replace(v_definition,
    (select prosrc from pg_proc where oid = 'public.get_delivery_correction_context(uuid)'::regprocedure), v_body);
end;
$shared_policy$;

-- Internal helper: only existing SECURITY DEFINER readers may call it.
revoke all on function public.get_delivery_cancellation_policy(uuid) from public, anon, authenticated;

do $history_policy$
declare
  v_definition text := pg_get_functiondef('public.get_round_shop_cards(uuid,uuid)'::regprocedure);
  v_start integer;
  v_end integer;
begin
  if strpos(v_definition, 'daily_cancellation_policy as materialized') > 0 then return; end if;
  v_start := strpos(v_definition, '      ''can_correct'',');
  v_end := strpos(v_definition, '    ) order by daily_events.recorded_at');
  if v_start = 0 or v_end <= v_start
    or strpos(v_definition, '  ), daily_history as (') = 0
    or strpos(v_definition, '    from daily_events group by daily_events.shop_id') = 0 then
    raise exception 'Unexpected regular delivery history policy';
  end if;
  v_definition := left(v_definition, v_start - 1) || $body$
      'can_correct', false,
      'can_cancel', (daily_events.cancellation_policy->>'can_cancel')::boolean,
      'correction_blocker', daily_events.cancellation_policy->>'blocker_reason'
$body$ || substr(v_definition, v_end);
  v_definition := replace(v_definition, '  ), daily_history as (', $body$  ), daily_cancellation_policy as materialized (
    select daily_events.*, public.get_delivery_cancellation_policy(daily_events.id) as cancellation_policy
    from daily_events
  ), daily_history as ($body$);
  v_definition := replace(v_definition, '    from daily_events group by daily_events.shop_id',
    '    from daily_cancellation_policy daily_events group by daily_events.shop_id');
  execute v_definition;
end;
$history_policy$;

notify pgrst, 'reload schema';
commit;
