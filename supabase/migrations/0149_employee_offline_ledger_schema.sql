-- Private ledger foundation for employee offline sync. Public typed adapters and
-- resolution RPCs are added by later migrations; clients never access these
-- tables or helpers directly.

do $$
begin
  create type public.employee_offline_command_type as enum (
    'stock_transfer',
    'stock_return',
    'stock_damage',
    'delivery',
    'immediate_sale',
    'collection_payment'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.employee_offline_command_status as enum (
    'received',
    'applied',
    'conflict',
    'retry_requested',
    'discard_approved'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.offline_sync_issue_status as enum (
    'open',
    'retry_requested',
    'discard_approved',
    'resolved_applied'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.offline_sync_issue_decision as enum (
    'retry',
    'approve_discard'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.offline_sync_issue_scope_type as enum (
    'round',
    'collection_run',
    'admin_only'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.employee_offline_error_code as enum (
    'ROUND_CLOSED',
    'STOCK_DAY_CLOSED',
    'INSUFFICIENT_STOCK',
    'PRICE_CHANGED',
    'OUTSTANDING_CHANGED',
    'PAYMENT_PROFILE_CHANGED',
    'APPROVAL_REQUIRED',
    'APPROVAL_EXPIRED',
    'ROUND_ASSIGNMENT_CHANGED',
    'USER_INACTIVE',
    'COLLECTION_RUN_CLOSED',
    'IDEMPOTENCY_PAYLOAD_MISMATCH',
    'INVALID_SCHEMA_VERSION',
    'INVALID_PAYLOAD_VERSION',
    'INVALID_PAYLOAD',
    'DEVICE_MISMATCH',
    'OWNER_MISMATCH',
    'SERVICE_DATE_EXPIRED',
    'SERVER_CONTRACT_ERROR',
    'NETWORK_ERROR',
    'SERVER_UNAVAILABLE',
    'AUTH_REQUIRED',
    'EVIDENCE_UPLOAD_FAILED'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.employee_offline_rollout_mode as enum (
    'disabled',
    'enabled',
    'drain_only'
  );
exception when duplicate_object then null;
end $$;

-- A row is deliberately separate from public.users so rollout can enter
-- drain_only: clients stop creating commands while adapters continue draining
-- a durable queue that predates the flag change.
create table public.employee_offline_user_access (
  user_id uuid primary key references public.users(id) on delete cascade,
  mode public.employee_offline_rollout_mode not null default 'disabled',
  changed_by uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  mode_changed_at timestamptz not null default now(),
  drain_cutoff_at timestamptz,
  constraint employee_offline_user_access_drain_cutoff_check check (
    (
      mode = 'drain_only'
      and drain_cutoff_at is not null
      and drain_cutoff_at = mode_changed_at
    ) or (
      mode <> 'drain_only'
      and drain_cutoff_at is null
    )
  )
);

create sequence public.employee_offline_resolution_version_seq
  as bigint
  minvalue 1
  maxvalue 9007199254740991
  start with 1
  increment by 1
  no cycle;

create table public.employee_offline_commands (
  command_id uuid primary key,
  idempotency_key uuid not null unique,
  device_id uuid not null,
  user_id uuid not null references public.users(id) on delete restrict,
  service_date date not null,
  sequence bigint not null,
  command_type public.employee_offline_command_type not null,
  schema_version integer not null,
  payload_version integer not null,
  payload jsonb not null,
  payload_hash text not null,
  status public.employee_offline_command_status not null default 'received',
  result jsonb,
  issue_id uuid,
  resolution_version bigint not null default 0,
  client_recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint employee_offline_commands_versions_check check (
    schema_version > 0 and payload_version > 0
  ),
  constraint employee_offline_commands_sequence_check check (
    sequence > 0 and sequence <= 9007199254740991
  ),
  constraint employee_offline_commands_payload_check check (
    jsonb_typeof(payload) = 'object'
  ),
  constraint employee_offline_commands_payload_hash_check check (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint employee_offline_commands_resolution_version_check check (
    resolution_version >= 0 and resolution_version <= 9007199254740991
  ),
  constraint employee_offline_commands_state_check check (
    (
      status = 'received'
      and result is null
      and issue_id is null
      and resolution_version = 0
      and applied_at is null
    ) or (
      status = 'applied'
      and result is not null
      and jsonb_typeof(result) = 'object'
      and resolution_version > 0
      and applied_at is not null
    ) or (
      status in ('conflict', 'retry_requested', 'discard_approved')
      and result is null
      and issue_id is not null
      and resolution_version > 0
      and applied_at is null
    )
  ),
  unique (user_id, device_id, service_date, sequence),
  unique (command_id, device_id, user_id, service_date, command_type)
);

create table public.offline_sync_issues (
  id uuid primary key default gen_random_uuid(),
  command_id uuid not null unique,
  device_id uuid not null,
  user_id uuid not null,
  service_date date not null,
  command_type public.employee_offline_command_type not null,
  payload jsonb not null,
  error_code public.employee_offline_error_code not null,
  error_message text not null,
  error_details jsonb,
  status public.offline_sync_issue_status not null default 'open',
  scope_type public.offline_sync_issue_scope_type not null,
  round_id uuid references public.delivery_rounds(id) on delete restrict,
  collection_run_id uuid references public.collection_runs(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_by uuid references public.users(id) on delete restrict,
  decided_at timestamptz,
  decision_reason text,
  constraint offline_sync_issues_command_identity_fk foreign key (
    command_id, device_id, user_id, service_date, command_type
  ) references public.employee_offline_commands (
    command_id, device_id, user_id, service_date, command_type
  ) on delete restrict,
  constraint offline_sync_issues_payload_check check (
    jsonb_typeof(payload) = 'object'
  ),
  constraint offline_sync_issues_error_message_check check (
    nullif(trim(error_message), '') is not null
  ),
  constraint offline_sync_issues_error_details_check check (
    error_details is null or jsonb_typeof(error_details) = 'object'
  ),
  constraint offline_sync_issues_scope_check check (
    (
      scope_type = 'round'
      and command_type <> 'collection_payment'
      and round_id is not null
      and collection_run_id is null
    ) or (
      scope_type = 'collection_run'
      and command_type = 'collection_payment'
      and round_id is null
      and collection_run_id is not null
    ) or (
      scope_type = 'admin_only'
      and round_id is null
      and collection_run_id is null
    )
  ),
  constraint offline_sync_issues_decision_fields_check check (
    (
      decided_by is null
      and decided_at is null
      and decision_reason is null
    ) or (
      decided_by is not null
      and decided_at is not null
      and nullif(trim(decision_reason), '') is not null
    )
  ),
  constraint offline_sync_issues_decision_status_check check (
    status = 'open'
    or (
      status in ('retry_requested', 'discard_approved', 'resolved_applied')
      and decided_by is not null
    )
  ),
  unique (id, command_id)
);

-- The composite key prevents an issue from being attached to a different
-- command than the one copied into offline_sync_issues.
alter table public.employee_offline_commands
  add constraint employee_offline_commands_issue_fk
  foreign key (issue_id, command_id)
  references public.offline_sync_issues (id, command_id)
  on delete restrict;

-- Decisions are append-only. offline_sync_issues keeps the latest decision for
-- convenient review, while this table preserves every retry/discard audit event.
create table public.offline_sync_issue_decisions (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null,
  command_id uuid not null,
  decision public.offline_sync_issue_decision not null,
  reason text not null,
  decided_by uuid not null references public.users(id) on delete restrict,
  decided_at timestamptz not null default now(),
  resolution_version bigint not null,
  constraint offline_sync_issue_decisions_issue_fk foreign key (issue_id, command_id)
    references public.offline_sync_issues (id, command_id) on delete restrict,
  constraint offline_sync_issue_decisions_reason_check check (
    nullif(trim(reason), '') is not null
  ),
  constraint offline_sync_issue_decisions_resolution_version_check check (
    resolution_version > 0 and resolution_version <= 9007199254740991
  ),
  unique (issue_id, resolution_version),
  unique (resolution_version)
);

create unique index employee_offline_commands_resolution_version_idx
  on public.employee_offline_commands (resolution_version)
  where resolution_version > 0;

create index employee_offline_commands_owner_feed_idx
  on public.employee_offline_commands (user_id, device_id, resolution_version)
  where resolution_version > 0;

create index employee_offline_commands_pending_order_idx
  on public.employee_offline_commands (user_id, device_id, service_date, sequence)
  where status in ('received', 'retry_requested');

create index offline_sync_issues_status_date_idx
  on public.offline_sync_issues (status, service_date, created_at);

create index offline_sync_issues_round_scope_idx
  on public.offline_sync_issues (round_id, status)
  where round_id is not null;

create index offline_sync_issues_collection_scope_idx
  on public.offline_sync_issues (collection_run_id, status)
  where collection_run_id is not null;

create index offline_sync_issue_decisions_issue_date_idx
  on public.offline_sync_issue_decisions (issue_id, decided_at);

create or replace function public.employee_offline_guard_rollout_update_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.mode_changed_at := clock_timestamp();
    if new.mode = 'drain_only' then
      new.drain_cutoff_at := new.mode_changed_at;
    else
      new.drain_cutoff_at := null;
    end if;
  elsif new.mode is distinct from old.mode then
    new.mode_changed_at := clock_timestamp();
    if new.mode = 'drain_only' then
      new.drain_cutoff_at := new.mode_changed_at;
    else
      new.drain_cutoff_at := null;
    end if;
  else
    new.mode_changed_at := old.mode_changed_at;
    new.drain_cutoff_at := old.drain_cutoff_at;
  end if;

  return new;
end;
$$;

create trigger employee_offline_user_access_rollout_guard
  before insert or update on public.employee_offline_user_access
  for each row execute function public.employee_offline_guard_rollout_update_v1();

create trigger employee_offline_user_access_updated_at
  before update on public.employee_offline_user_access
  for each row execute function public.set_updated_at();

create trigger employee_offline_commands_updated_at
  before update on public.employee_offline_commands
  for each row execute function public.set_updated_at();

create trigger offline_sync_issues_updated_at
  before update on public.offline_sync_issues
  for each row execute function public.set_updated_at();

create or replace function public.employee_offline_jsonb_has_exact_keys_v1(
  p_value jsonb,
  p_keys text[]
)
returns boolean
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select jsonb_typeof(p_value) = 'object'
    and (
      select coalesce(array_agg(entry.key order by entry.key), array[]::text[])
      from jsonb_object_keys(p_value) entry(key)
    ) = (
      select coalesce(array_agg(expected.key order by expected.key), array[]::text[])
      from unnest(p_keys) expected(key)
    )
$$;

create or replace function public.employee_offline_error_v1(
  p_code public.employee_offline_error_code,
  p_message text,
  p_details jsonb default null
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_code is null then
    raise exception 'Employee offline errors require a stable error code';
  end if;
  if nullif(trim(coalesce(p_message, '')), '') is null then
    raise exception 'Employee offline errors require a non-blank message';
  end if;
  if p_details is not null and jsonb_typeof(p_details) <> 'object' then
    raise exception 'Employee offline error details must be a JSON object';
  end if;

  if p_details is null then
    return jsonb_build_object(
      'code', p_code,
      'message', p_message
    );
  end if;

  return jsonb_build_object(
    'code', p_code,
    'message', p_message,
    'details', p_details
  );
end;
$$;

create or replace function public.employee_offline_raise_v1(
  p_code public.employee_offline_error_code,
  p_message text,
  p_details jsonb default null
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = p_message,
    detail = public.employee_offline_error_v1(p_code, p_message, p_details)::text;
end;
$$;

-- This is an operational cutoff for honest queued clients. client_recorded_at
-- is client-controlled and is not cryptographic proof that a command existed
-- before drain_only began.
create or replace function public.employee_offline_rollout_allows_command_v1(
  p_user_id uuid,
  p_client_recorded_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case access.mode
      when 'enabled' then true
      when 'drain_only' then p_client_recorded_at <= access.drain_cutoff_at
      else false
    end
    from public.employee_offline_user_access access
    where access.user_id = p_user_id
  ), false)
$$;

-- Parse only the common envelope. Unsupported positive versions remain
-- representable so typed adapters can persist INVALID_*_VERSION conflicts.
create or replace function public.employee_offline_parse_envelope_v1(p_envelope jsonb)
returns table (
  schema_version integer,
  payload_version integer,
  command_id uuid,
  idempotency_key uuid,
  device_id uuid,
  owner_id uuid,
  service_date date,
  sequence bigint,
  client_recorded_at timestamptz
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_number numeric;
  v_text text;
begin
  if p_envelope is null
    or not coalesce(public.employee_offline_jsonb_has_exact_keys_v1(p_envelope, array[
    'schemaVersion',
    'payloadVersion',
    'commandId',
    'idempotencyKey',
    'deviceId',
    'ownerId',
    'serviceDate',
    'sequence',
    'clientRecordedAt'
  ]), false) then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command envelope does not match the v1 allowlist'
    );
  end if;

  if jsonb_typeof(p_envelope -> 'schemaVersion') <> 'number' then
    perform public.employee_offline_raise_v1(
      'INVALID_SCHEMA_VERSION',
      'Offline command schemaVersion must be a positive integer'
    );
  end if;
  v_number := (p_envelope ->> 'schemaVersion')::numeric;
  if v_number <> trunc(v_number) or v_number <= 0 or v_number > 2147483647 then
    perform public.employee_offline_raise_v1(
      'INVALID_SCHEMA_VERSION',
      'Offline command schemaVersion must be a positive integer'
    );
  end if;
  schema_version := v_number::integer;

  if jsonb_typeof(p_envelope -> 'payloadVersion') <> 'number' then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD_VERSION',
      'Offline command payloadVersion must be a positive integer'
    );
  end if;
  v_number := (p_envelope ->> 'payloadVersion')::numeric;
  if v_number <> trunc(v_number) or v_number <= 0 or v_number > 2147483647 then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD_VERSION',
      'Offline command payloadVersion must be a positive integer'
    );
  end if;
  payload_version := v_number::integer;

  v_text := p_envelope ->> 'commandId';
  if jsonb_typeof(p_envelope -> 'commandId') <> 'string'
    or v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command commandId must be a UUID v4'
    );
  end if;
  command_id := v_text::uuid;

  v_text := p_envelope ->> 'idempotencyKey';
  if jsonb_typeof(p_envelope -> 'idempotencyKey') <> 'string'
    or v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command idempotencyKey must be a UUID v4'
    );
  end if;
  idempotency_key := v_text::uuid;

  v_text := p_envelope ->> 'deviceId';
  if jsonb_typeof(p_envelope -> 'deviceId') <> 'string'
    or v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command deviceId must be a UUID v4'
    );
  end if;
  device_id := v_text::uuid;

  v_text := p_envelope ->> 'ownerId';
  if jsonb_typeof(p_envelope -> 'ownerId') <> 'string'
    or v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command ownerId must be a UUID v4'
    );
  end if;
  owner_id := v_text::uuid;

  v_text := p_envelope ->> 'serviceDate';
  if jsonb_typeof(p_envelope -> 'serviceDate') <> 'string'
    or v_text !~ '^\d{4}-\d{2}-\d{2}$' then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command serviceDate must be a valid YYYY-MM-DD date'
    );
  end if;
  begin
    service_date := v_text::date;
  exception when others then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command serviceDate must be a valid YYYY-MM-DD date'
    );
  end;
  if to_char(service_date, 'YYYY-MM-DD') <> v_text then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command serviceDate must be a valid YYYY-MM-DD date'
    );
  end if;

  if jsonb_typeof(p_envelope -> 'sequence') <> 'number' then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command sequence must be a positive safe integer'
    );
  end if;
  v_number := (p_envelope ->> 'sequence')::numeric;
  if v_number <> trunc(v_number) or v_number <= 0 or v_number > 9007199254740991 then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command sequence must be a positive safe integer'
    );
  end if;
  sequence := v_number::bigint;

  v_text := p_envelope ->> 'clientRecordedAt';
  if jsonb_typeof(p_envelope -> 'clientRecordedAt') <> 'string'
    or v_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command clientRecordedAt must be an ISO timestamp with an offset'
    );
  end if;
  if substring(v_text from 1 for 4)::integer = 0
    or substring(v_text from 12 for 2)::integer > 23
    or substring(v_text from 15 for 2)::integer > 59
    or substring(v_text from 18 for 2)::integer > 59
    or (
      right(v_text, 1) <> 'Z'
      and left(right(v_text, 5), 2)::integer > 15
    ) then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command clientRecordedAt must be an ISO timestamp with an offset'
    );
  end if;
  begin
    client_recorded_at := v_text::timestamptz;
  exception when others then
    perform public.employee_offline_raise_v1(
      'INVALID_PAYLOAD',
      'Offline command clientRecordedAt must be an ISO timestamp with an offset'
    );
  end;

  return next;
end;
$$;

-- The transaction-level lock is held until commit. A later transaction cannot
-- publish a higher version before the transaction owning the lower version has
-- committed or rolled back.
create or replace function public.employee_offline_next_resolution_version_v1()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version bigint;
begin
  perform pg_advisory_xact_lock(590436178221);
  v_version := nextval('public.employee_offline_resolution_version_seq');
  return v_version;
end;
$$;

create or replace function public.employee_offline_guard_command_update_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'received'
      or new.result is not null
      or new.issue_id is not null
      or new.resolution_version <> 0
      or new.applied_at is not null then
      raise exception 'Employee offline commands must enter the ledger as received';
    end if;
    return new;
  end if;

  if row(
    new.command_id,
    new.idempotency_key,
    new.device_id,
    new.user_id,
    new.service_date,
    new.sequence,
    new.command_type,
    new.schema_version,
    new.payload_version,
    new.payload,
    new.payload_hash,
    new.client_recorded_at,
    new.created_at
  ) is distinct from row(
    old.command_id,
    old.idempotency_key,
    old.device_id,
    old.user_id,
    old.service_date,
    old.sequence,
    old.command_type,
    old.schema_version,
    old.payload_version,
    old.payload,
    old.payload_hash,
    old.client_recorded_at,
    old.created_at
  ) then
    raise exception 'Employee offline command identity and payload are immutable';
  end if;

  if old.issue_id is not null and new.issue_id is distinct from old.issue_id then
    raise exception 'Employee offline command issue identity is immutable once assigned';
  end if;

  if not (
    (old.status = 'received' and new.status in ('applied', 'conflict'))
    or (old.status = 'conflict' and new.status in ('retry_requested', 'discard_approved'))
    or (
      old.status = 'retry_requested'
      and new.status in ('applied', 'conflict', 'discard_approved')
    )
  ) then
    raise exception 'Invalid employee offline command status transition: % -> %',
      old.status, new.status;
  end if;

  if old.status = 'received' and new.status = 'applied'
    and (old.issue_id is not null or new.issue_id is not null) then
    raise exception 'A command cannot attach an issue while applying directly';
  end if;
  if old.status = 'received' and new.status = 'conflict' and new.issue_id is null then
    raise exception 'A conflicting command must attach its matching issue';
  end if;

  -- Callers cannot reserve or inject a version. The state transition itself
  -- allocates it while holding the transaction-level publication lock.
  new.resolution_version := public.employee_offline_next_resolution_version_v1();

  return new;
end;
$$;

create trigger employee_offline_commands_state_guard
  before insert or update on public.employee_offline_commands
  for each row execute function public.employee_offline_guard_command_update_v1();

create or replace function public.employee_offline_guard_issue_update_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open'
      or new.decided_by is not null
      or new.decided_at is not null
      or new.decision_reason is not null then
      raise exception 'Employee offline issues must be inserted open and undecided';
    end if;
    return new;
  end if;

  if row(
    new.id,
    new.command_id,
    new.device_id,
    new.user_id,
    new.service_date,
    new.command_type,
    new.created_at
  ) is distinct from row(
    old.id,
    old.command_id,
    old.device_id,
    old.user_id,
    old.service_date,
    old.command_type,
    old.created_at
  ) then
    raise exception 'Employee offline issue identity is immutable';
  end if;

  if not (
    (old.status = 'open' and new.status in ('retry_requested', 'discard_approved'))
    or (
      old.status = 'retry_requested'
      and new.status in ('open', 'discard_approved', 'resolved_applied')
    )
  ) then
    raise exception 'Invalid employee offline issue status transition: % -> %',
      old.status, new.status;
  end if;

  if row(
    new.payload, new.scope_type, new.round_id, new.collection_run_id
  ) is distinct from row(
    old.payload, old.scope_type, old.round_id, old.collection_run_id
  ) then
    raise exception 'Employee offline issue payload and authorization scope are immutable';
  end if;

  if row(
    new.error_code,
    new.error_message,
    new.error_details
  ) is distinct from row(
    old.error_code,
    old.error_message,
    old.error_details
  ) and not (old.status = 'retry_requested' and new.status = 'open') then
    raise exception 'Employee offline error details may change only when a retry conflicts again';
  end if;

  if old.status = 'retry_requested'
    and new.status in ('open', 'resolved_applied')
    and row(new.decided_by, new.decided_at, new.decision_reason) is distinct from row(
      old.decided_by, old.decided_at, old.decision_reason
    ) then
    raise exception 'Employee offline retry decision metadata cannot be cleared or rewritten';
  end if;

  return new;
end;
$$;

create trigger offline_sync_issues_state_guard
  before insert or update on public.offline_sync_issues
  for each row execute function public.employee_offline_guard_issue_update_v1();

create or replace function public.employee_offline_reject_decision_change_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Employee offline issue decisions are append-only';
end;
$$;

create trigger offline_sync_issue_decisions_append_only
  before update or delete on public.offline_sync_issue_decisions
  for each row execute function public.employee_offline_reject_decision_change_v1();

-- Enforce the circular command/issue state at transaction commit so adapters
-- may insert the issue and link the command in either order inside one atomic
-- transaction, but cannot commit an orphan or mismatched state.
create or replace function public.employee_offline_assert_command_issue_state_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_command_id uuid;
  v_command_status public.employee_offline_command_status;
  v_command_issue_id uuid;
  v_command_type public.employee_offline_command_type;
  v_command_payload jsonb;
  v_command_service_date date;
  v_command_resolution_version bigint;
  v_issue_id uuid;
  v_issue_status public.offline_sync_issue_status;
  v_issue_scope_type public.offline_sync_issue_scope_type;
  v_issue_payload jsonb;
  v_issue_round_id uuid;
  v_issue_collection_run_id uuid;
  v_issue_decided_by uuid;
  v_issue_decided_at timestamptz;
  v_issue_decision_reason text;
  v_decision public.offline_sync_issue_decision;
  v_decision_reason text;
  v_decided_by uuid;
  v_decided_at timestamptz;
begin
  v_command_id := new.command_id;

  select
    command.status,
    command.issue_id,
    command.command_type,
    command.payload,
    command.service_date,
    command.resolution_version,
    issue.id,
    issue.status,
    issue.scope_type,
    issue.payload,
    issue.round_id,
    issue.collection_run_id,
    issue.decided_by,
    issue.decided_at,
    issue.decision_reason
  into
    v_command_status,
    v_command_issue_id,
    v_command_type,
    v_command_payload,
    v_command_service_date,
    v_command_resolution_version,
    v_issue_id,
    v_issue_status,
    v_issue_scope_type,
    v_issue_payload,
    v_issue_round_id,
    v_issue_collection_run_id,
    v_issue_decided_by,
    v_issue_decided_at,
    v_issue_decision_reason
  from public.employee_offline_commands command
  left join public.offline_sync_issues issue on issue.command_id = command.command_id
  where command.command_id = v_command_id;

  if not found then
    return new;
  end if;

  if v_issue_id is null then
    if v_command_issue_id is not null
      or v_command_status not in ('received', 'applied') then
      raise exception 'Employee offline command state requires a matching issue';
    end if;
    return new;
  end if;

  if v_command_issue_id is distinct from v_issue_id then
    raise exception 'Employee offline issue must be linked by its matching command';
  end if;

  if v_issue_payload is distinct from v_command_payload then
    raise exception 'Employee offline issue payload must match its immutable command payload';
  end if;

  if v_command_type = 'collection_payment' then
    if v_issue_scope_type = 'round' then
      raise exception 'Collection payment issues cannot use delivery-round scope';
    end if;
    if v_issue_scope_type = 'collection_run' and not exists (
      select 1
      from public.collection_runs run
      where run.id = v_issue_collection_run_id
        and run.service_date = v_command_service_date
        and run.id::text = lower(v_command_payload ->> 'collectionRunId')
    ) then
      raise exception 'Employee offline collection scope does not match its command';
    end if;
  else
    if v_issue_scope_type = 'collection_run' then
      raise exception 'Only collection payment issues can use collection-run scope';
    end if;
    if v_issue_scope_type = 'round' and v_command_type in (
      'stock_transfer', 'stock_return', 'stock_damage'
    ) and not exists (
      select 1
      from public.delivery_rounds round
      where round.id = v_issue_round_id
        and round.service_date = v_command_service_date
        and round.id::text = lower(v_command_payload ->> 'roundId')
    ) then
      raise exception 'Employee offline stock issue scope does not match its command';
    end if;
    if v_issue_scope_type = 'round' and v_command_type in (
      'delivery', 'immediate_sale'
    ) and not exists (
      select 1
      from public.round_stops stop
      join public.delivery_rounds round on round.id = stop.round_id
      where stop.round_id = v_issue_round_id
        and round.service_date = v_command_service_date
        and stop.id::text = lower(v_command_payload ->> 'roundStopId')
    ) then
      raise exception 'Employee offline delivery issue scope does not match its command';
    end if;
  end if;

  if not (
    (v_command_status = 'conflict' and v_issue_status = 'open')
    or (
      v_command_status = 'retry_requested'
      and v_issue_status = 'retry_requested'
    )
    or (
      v_command_status = 'discard_approved'
      and v_issue_status = 'discard_approved'
    )
    or (
      v_command_status = 'applied'
      and v_issue_status = 'resolved_applied'
    )
  ) then
    raise exception 'Employee offline command and issue statuses do not agree';
  end if;

  if v_command_status in ('retry_requested', 'discard_approved') then
    select
      decision.decision,
      decision.reason,
      decision.decided_by,
      decision.decided_at
    into v_decision, v_decision_reason, v_decided_by, v_decided_at
    from public.offline_sync_issue_decisions decision
    where decision.issue_id = v_issue_id
      and decision.resolution_version = v_command_resolution_version;

    if not found
      or (v_command_status = 'retry_requested' and v_decision <> 'retry')
      or (v_command_status = 'discard_approved' and v_decision <> 'approve_discard')
      or v_decision_reason is distinct from v_issue_decision_reason
      or v_decided_by is distinct from v_issue_decided_by
      or v_decided_at is distinct from v_issue_decided_at then
      raise exception 'Employee offline decision transition requires a matching append-only audit record';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.employee_offline_assert_decision_transition_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_command_status public.employee_offline_command_status;
  v_resolution_version bigint;
begin
  select command.status, command.resolution_version
  into v_command_status, v_resolution_version
  from public.employee_offline_commands command
  where command.command_id = new.command_id;

  if not found or not (
    new.resolution_version = v_resolution_version
    and (
      (v_command_status = 'retry_requested' and new.decision = 'retry')
      or (
        v_command_status = 'discard_approved'
        and new.decision = 'approve_discard'
      )
    )
  ) then
    raise exception 'Employee offline audit record must match its final command transition';
  end if;

  return new;
end;
$$;

create constraint trigger employee_offline_commands_issue_state_check
  after insert or update on public.employee_offline_commands
  deferrable initially deferred
  for each row execute function public.employee_offline_assert_command_issue_state_v1();

create constraint trigger offline_sync_issues_command_state_check
  after insert or update on public.offline_sync_issues
  deferrable initially deferred
  for each row execute function public.employee_offline_assert_command_issue_state_v1();

create constraint trigger offline_sync_issue_decisions_command_state_check
  after insert on public.offline_sync_issue_decisions
  deferrable initially deferred
  for each row execute function public.employee_offline_assert_decision_transition_v1();

alter table public.employee_offline_user_access enable row level security;
alter table public.employee_offline_commands enable row level security;
alter table public.offline_sync_issues enable row level security;
alter table public.offline_sync_issue_decisions enable row level security;

revoke all on table public.employee_offline_user_access from public, anon, authenticated;
revoke all on table public.employee_offline_commands from public, anon, authenticated;
revoke all on table public.offline_sync_issues from public, anon, authenticated;
revoke all on table public.offline_sync_issue_decisions from public, anon, authenticated;
revoke all on sequence public.employee_offline_resolution_version_seq from public, anon, authenticated;

revoke all on function public.employee_offline_jsonb_has_exact_keys_v1(jsonb, text[])
  from public, anon, authenticated;
revoke all on function public.employee_offline_error_v1(
  public.employee_offline_error_code, text, jsonb
) from public, anon, authenticated;
revoke all on function public.employee_offline_raise_v1(
  public.employee_offline_error_code, text, jsonb
) from public, anon, authenticated;
revoke all on function public.employee_offline_parse_envelope_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.employee_offline_rollout_allows_command_v1(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.employee_offline_next_resolution_version_v1()
  from public, anon, authenticated;
revoke all on function public.employee_offline_guard_rollout_update_v1()
  from public, anon, authenticated;
revoke all on function public.employee_offline_guard_command_update_v1()
  from public, anon, authenticated;
revoke all on function public.employee_offline_guard_issue_update_v1()
  from public, anon, authenticated;
revoke all on function public.employee_offline_reject_decision_change_v1()
  from public, anon, authenticated;
revoke all on function public.employee_offline_assert_command_issue_state_v1()
  from public, anon, authenticated;
revoke all on function public.employee_offline_assert_decision_transition_v1()
  from public, anon, authenticated;

comment on table public.employee_offline_commands is
  'Authoritative server ledger for durable employee offline command reconciliation.';
comment on table public.offline_sync_issues is
  'Durable employee offline conflicts with explicit round, collection-run, or admin-only authorization scope; direct table access is denied and decisions use audited RPCs.';
comment on table public.offline_sync_issue_decisions is
  'Append-only audit history for every manager retry or discard decision.';
comment on table public.employee_offline_user_access is
  'Server-authoritative per-user offline rollout mode. drain_only uses a server timestamp cutoff against client_recorded_at to drain commands from honest clients.';
comment on function public.employee_offline_rollout_allows_command_v1(uuid, timestamptz) is
  'Checks enabled/drain_only admission. The drain cutoff uses client_recorded_at as an operational honest-client rule, not cryptographic creation proof.';
comment on function public.employee_offline_next_resolution_version_v1() is
  'Allocates a global client-visible transition version while serializing allocation through transaction commit.';
