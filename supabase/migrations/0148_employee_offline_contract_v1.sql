-- Frozen cross-runtime canonical JSON + SHA-256 contract for employee offline v1.
-- Domain callers must normalize monetary values to integer minor units and sort
-- arrays with set semantics before calling these functions. Canonical numbers
-- are safe integers and object keys use ASCII letters, digits, or underscores.
-- Sequence arrays keep their original order.

create or replace function public.employee_offline_canonical_json_v1(p_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = public, pg_temp
as $$
declare
  v_result text;
  v_number numeric;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      if exists (
        select 1 from jsonb_each(p_value) entry
        where entry.key !~ '^[A-Za-z0-9_]+$'
      ) then
        raise exception 'canonical JSON v1 object keys must use printable ASCII letters, digits, or underscore';
      end if;
      select '{' || coalesce(string_agg(
        to_jsonb(entry.key)::text || ':' || public.employee_offline_canonical_json_v1(entry.value),
        ',' order by entry.key collate "C"
      ), '') || '}'
      into v_result
      from jsonb_each(p_value) entry;
      return v_result;

    when 'array' then
      select '[' || coalesce(string_agg(
        public.employee_offline_canonical_json_v1(entry.value),
        ',' order by entry.ordinality
      ), '') || ']'
      into v_result
      from jsonb_array_elements(p_value) with ordinality entry(value, ordinality);
      return v_result;

    when 'number' then
      v_number := (p_value #>> '{}')::numeric;
      if v_number <> trunc(v_number)
        or v_number < -9007199254740991
        or v_number > 9007199254740991 then
        raise exception 'canonical JSON v1 numbers must be safe integers';
      end if;
      return trunc(v_number)::text;

    else
      return p_value::text;
  end case;
end;
$$;

create or replace function public.employee_offline_fingerprint_v1(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = public, extensions, pg_temp
as $$
  select encode(
    digest(convert_to(public.employee_offline_canonical_json_v1(p_value), 'UTF8'), 'sha256'),
    'hex'
  )
$$;

-- Credit suspension changes whether a queued credit delivery may be applied, so
-- it must be visible to the bundle/POS profile used for expected-state hashing.
do $extend_delivery_pos_credit_suspension$
declare
  v_function regprocedure := to_regprocedure('public.get_delivery_pos_context(uuid)');
  v_definition text;
  v_old constant text := $fragment$'credit_due_rule', v_profile.credit_due_rule,$fragment$;
  v_marker constant text := $fragment$'credit_suspended', v_profile.credit_suspended,$fragment$;
  v_new constant text := $fragment$'credit_suspended', v_profile.credit_suspended,
      'credit_due_rule', v_profile.credit_due_rule,$fragment$;
begin
  if v_function is not null then
    select pg_get_functiondef(v_function) into v_definition;
    if strpos(v_definition, v_marker) = 0 then
      if strpos(v_definition, v_old) = 0 then
        raise exception 'get_delivery_pos_context does not contain the expected payment-profile projection';
      end if;
      execute replace(v_definition, v_old, v_new);
    end if;
  end if;
end;
$extend_delivery_pos_credit_suspension$;

comment on function public.employee_offline_canonical_json_v1(jsonb) is
  'Canonical JSON for employee offline sha256-canonical-json-v1. Keys use ASCII/C ordering, numbers are safe integers, and array order is preserved.';
comment on function public.employee_offline_fingerprint_v1(jsonb) is
  'SHA-256 hex digest for normalized employee offline canonical JSON v1 values.';

revoke all on function public.employee_offline_canonical_json_v1(jsonb) from public, anon, authenticated;
revoke all on function public.employee_offline_fingerprint_v1(jsonb) from public, anon, authenticated;
