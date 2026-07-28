-- audit_logs.entity_id is a UUID. Migration 0042 accidentally cast the daily
-- close idempotency key to text, causing the entire atomic close to roll back.
do $$
declare
  v_function regprocedure :=
    'public.close_daily_stock_v2(jsonb,text,uuid,date)'::regprocedure;
  v_definition text;
  v_old_fragment constant text :=
    $fragment$p_idempotency_key::text, 'closed'$fragment$;
  v_new_fragment constant text :=
    $fragment$p_idempotency_key, 'closed'$fragment$;
begin
  select pg_get_functiondef(v_function)
  into v_definition;

  if strpos(v_definition, v_old_fragment) > 0 then
    execute replace(v_definition, v_old_fragment, v_new_fragment);
  elsif strpos(v_definition, v_new_fragment) > 0 then
    -- The destination schema already has the UUID-safe audit expression.
    null;
  else
    raise exception
      'close_daily_stock_v2 does not contain a recognized audit entity expression';
  end if;
end;
$$;
