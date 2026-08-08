-- Daily, operational sign-off documents for credit deliveries. These documents
-- reference the existing INV snapshots and never create another receivable.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'credit-signoff-evidence',
  'credit-signoff-evidence',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create policy "credit sign-off uploaders add their own photos"
on storage.objects for insert
with check (
  bucket_id = 'credit-signoff-evidence'
  and public.is_active_user()
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "active users read credit sign-off photos"
on storage.objects for select
using (bucket_id = 'credit-signoff-evidence' and public.is_active_user());

create policy "credit sign-off uploaders retry their photos"
on storage.objects for update
using (
  bucket_id = 'credit-signoff-evidence'
  and public.is_active_user()
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'credit-signoff-evidence'
  and public.is_active_user()
  and (storage.foldername(name))[1] = auth.uid()::text
);

create table public.daily_credit_acknowledgements (
  id uuid primary key,
  shop_id uuid not null references public.shops(id) on delete restrict,
  service_date date not null,
  version integer not null check (version > 0),
  source_fingerprint text not null,
  document_data jsonb not null check (jsonb_typeof(document_data) = 'object'),
  generated_by uuid not null references public.users(id) on delete restrict,
  generated_at timestamptz not null default now(),
  unique (shop_id, service_date, version)
);

create table public.daily_credit_acknowledgement_evidence (
  id uuid primary key default gen_random_uuid(),
  acknowledgement_id uuid not null references public.daily_credit_acknowledgements(id) on delete restrict,
  storage_path text not null unique,
  uploaded_by uuid not null references public.users(id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  unique (acknowledgement_id, storage_path)
);

create function public.protect_daily_credit_acknowledgement()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Daily credit acknowledgement snapshots are immutable';
end;
$$;

create trigger daily_credit_acknowledgements_immutable
before update or delete on public.daily_credit_acknowledgements
for each row execute function public.protect_daily_credit_acknowledgement();

create function public.protect_daily_credit_acknowledgement_evidence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Daily credit acknowledgement evidence is immutable';
end;
$$;

create trigger daily_credit_acknowledgement_evidence_immutable
before update or delete on public.daily_credit_acknowledgement_evidence
for each row execute function public.protect_daily_credit_acknowledgement_evidence();

alter table public.daily_credit_acknowledgements enable row level security;
alter table public.daily_credit_acknowledgement_evidence enable row level security;

create policy "active users read daily credit acknowledgements"
on public.daily_credit_acknowledgements for select
using (public.is_active_user());

create policy "active users read daily credit acknowledgement evidence"
on public.daily_credit_acknowledgement_evidence for select
using (public.is_active_user());

create function public.daily_credit_acknowledgement_source(
  p_service_date date,
  p_shop_id uuid default null
)
returns table (
  shop_id uuid,
  charge_id uuid,
  document_number text,
  due_date date,
  total_amount numeric(12,2),
  recorded_at timestamptz,
  recorded_by text,
  shop_code text,
  shop_name text,
  shop_location text,
  items jsonb,
  fingerprint_data jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    canonical.shop_id,
    canonical.charge_id,
    canonical.document_number,
    canonical.due_date,
    canonical.total_amount,
    canonical.recorded_at,
    canonical.recorded_by,
    canonical.shop_code,
    canonical.shop_name,
    canonical.shop_location,
    canonical.items,
    jsonb_build_object(
      'charge_id', canonical.charge_id,
      'document_number', canonical.document_number,
      'due_date', canonical.due_date,
      'total_amount', canonical.total_amount,
      'recorded_at', canonical.recorded_at,
      'recorded_by', canonical.recorded_by,
      'shop_code', canonical.shop_code,
      'shop_name', canonical.shop_name,
      'shop_location', canonical.shop_location,
      'items', canonical.items
    ) as fingerprint_data
  from (
    select
      charge.shop_id,
      charge.id as charge_id,
      charge.charge_number as document_number,
      charge.due_date,
      public.effective_delivery_charge_amount(charge.id) as total_amount,
      event.recorded_at,
      recorder.display_name as recorded_by,
      snapshot.document_data ->> 'shop_code' as shop_code,
      snapshot.document_data ->> 'shop_name' as shop_name,
      snapshot.document_data ->> 'shop_location' as shop_location,
      effective.items
    from public.delivery_charges charge
    join public.delivery_events event on event.id = charge.delivery_event_id
    join public.users recorder on recorder.id = event.recorded_by
    join public.delivery_charge_document_snapshots snapshot on snapshot.charge_id = charge.id
    cross join lateral (
      with item_ids as (
        select item.ice_type_id
        from public.delivery_items item
        where item.delivery_event_id = event.id
        union
        select adjustment_item.ice_type_id
        from public.delivery_charge_adjustments adjustment
        join public.delivery_adjustment_items adjustment_item
          on adjustment_item.adjustment_id = adjustment.idempotency_key
        where adjustment.charge_id = charge.id and adjustment.status = 'active'
      ), effective_items as (
        select
          ice.code,
          ice.name,
          ice.unit,
          (
            coalesce(original_item.quantity, 0)
            + coalesce(adjustments.quantity_delta, 0)
          )::numeric(12,1) as quantity,
          coalesce(original_item.unit_price, adjustments.unit_price)::numeric(12,2) as unit_price
        from item_ids
        join public.ice_types ice on ice.id = item_ids.ice_type_id
        left join public.delivery_items original_item
          on original_item.delivery_event_id = event.id
          and original_item.ice_type_id = item_ids.ice_type_id
        left join lateral (
          select
            coalesce(sum(adjustment_item.quantity_delta), 0)::numeric(12,1) as quantity_delta,
            (array_agg(
              adjustment_item.unit_price
              order by adjustment.created_at desc, adjustment.idempotency_key desc
            ))[1]::numeric(12,2) as unit_price
          from public.delivery_charge_adjustments adjustment
          join public.delivery_adjustment_items adjustment_item
            on adjustment_item.adjustment_id = adjustment.idempotency_key
          where adjustment.charge_id = charge.id
            and adjustment.status = 'active'
            and adjustment_item.ice_type_id = item_ids.ice_type_id
        ) adjustments on true
      )
      select coalesce(jsonb_agg(jsonb_build_object(
        'ice_type_name', effective_items.name,
        'ice_type_unit', effective_items.unit,
        'quantity', effective_items.quantity,
        'unit_price', effective_items.unit_price,
        'line_total', (effective_items.quantity * effective_items.unit_price)::numeric(12,2)
      ) order by effective_items.code), '[]'::jsonb) as items
      from effective_items
      where effective_items.quantity > 0
    ) effective
    where charge.service_date = p_service_date
      and (p_shop_id is null or charge.shop_id = p_shop_id)
      and charge.payment_term = 'credit'
      and charge.status = 'active'
      and event.status = 'active'
  ) canonical;
$$;

create function public.daily_credit_acknowledgement_fingerprint(
  p_shop_id uuid,
  p_service_date date
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select md5(coalesce(jsonb_agg(
    source.fingerprint_data order by source.recorded_at, source.charge_id
  )::text, '[]'))
  from public.daily_credit_acknowledgement_source(p_service_date, p_shop_id) source;
$$;

create function public.build_daily_credit_acknowledgement_document(
  p_document_id uuid,
  p_shop_id uuid,
  p_service_date date,
  p_version integer,
  p_generated_at timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with source as (
    select *
    from public.daily_credit_acknowledgement_source(p_service_date, p_shop_id)
  ), item_totals as (
    select
      item ->> 'ice_type_name' as name,
      item ->> 'ice_type_unit' as unit,
      sum((item ->> 'quantity')::numeric(12,1)) as quantity,
      sum((item ->> 'line_total')::numeric(12,2)) as line_total
    from source
    cross join lateral jsonb_array_elements(source.items) item
    group by item ->> 'ice_type_name', item ->> 'ice_type_unit'
  )
  select jsonb_build_object(
    'document_type', 'DAILY_CREDIT_ACK',
    'document_id', p_document_id,
    'document_title', 'ใบสรุปการส่งเครดิตประจำวัน',
    'version', p_version,
    'generated_at', p_generated_at,
    'service_date', p_service_date,
    'shop_code', min(source.shop_code),
    'shop_name', min(source.shop_name),
    'shop_location', min(source.shop_location),
    'invoices', coalesce(jsonb_agg(jsonb_build_object(
      'charge_id', source.charge_id,
      'document_number', source.document_number,
      'recorded_at', source.recorded_at,
      'recorded_by', source.recorded_by,
      'due_date', source.due_date,
      'items', source.items,
      'total_amount', source.total_amount
    ) order by source.recorded_at, source.charge_id), '[]'::jsonb),
    'item_totals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', item_totals.name,
        'unit', item_totals.unit,
        'quantity', item_totals.quantity,
        'line_total', item_totals.line_total
      ) order by item_totals.name)
      from item_totals
    ), '[]'::jsonb),
    'total_amount', coalesce(sum(source.total_amount), 0)
  )
  from source;
$$;

create function public.prepare_daily_credit_acknowledgement(
  p_shop_id uuid,
  p_service_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fingerprint text;
  v_document_id uuid;
  v_document_fingerprint text;
  v_version integer;
  v_generated_at timestamptz;
  v_document jsonb;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_shop_id is null or p_service_date is null then
    raise exception 'Shop and service date are required';
  elsif p_service_date > (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'A future service date cannot be prepared';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('financial-shop:' || p_shop_id::text, 0));
  v_fingerprint := public.daily_credit_acknowledgement_fingerprint(p_shop_id, p_service_date);
  if v_fingerprint = md5('[]') then
    raise exception 'The selected shop does not have active credit deliveries for this date';
  end if;

  select document.id, document.source_fingerprint, document.document_data
  into v_document_id, v_document_fingerprint, v_document
  from public.daily_credit_acknowledgements document
  where document.shop_id = p_shop_id
    and document.service_date = p_service_date
  order by document.version desc
  limit 1;
  if found and v_document_fingerprint = v_fingerprint then
    return v_document;
  end if;

  select coalesce(max(document.version), 0) + 1
  into v_version
  from public.daily_credit_acknowledgements document
  where document.shop_id = p_shop_id and document.service_date = p_service_date;

  v_document_id := gen_random_uuid();
  v_generated_at := now();
  v_document := public.build_daily_credit_acknowledgement_document(
    v_document_id, p_shop_id, p_service_date, v_version, v_generated_at
  );
  insert into public.daily_credit_acknowledgements (
    id, shop_id, service_date, version, source_fingerprint,
    document_data, generated_by, generated_at
  ) values (
    v_document_id, p_shop_id, p_service_date, v_version, v_fingerprint,
    v_document, auth.uid(), v_generated_at
  );

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'daily_credit_acknowledgements', v_document_id, 'created',
    jsonb_build_object('shop_id', p_shop_id, 'service_date', p_service_date, 'version', v_version)
  );
  return v_document;
end;
$$;

create function public.get_daily_credit_acknowledgement(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_document jsonb;
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  end if;
  select document.document_data into v_document
  from public.daily_credit_acknowledgements document
  where document.id = p_document_id;
  if v_document is null then
    raise exception 'The daily credit acknowledgement does not exist';
  end if;
  return v_document || jsonb_build_object('evidences', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', evidence.id,
      'storage_path', evidence.storage_path,
      'uploaded_at', evidence.uploaded_at,
      'uploaded_by', uploader.display_name
    ) order by evidence.uploaded_at desc)
    from public.daily_credit_acknowledgement_evidence evidence
    join public.users uploader on uploader.id = evidence.uploaded_by
    where evidence.acknowledgement_id = p_document_id
  ), '[]'::jsonb));
end;
$$;

create function public.list_daily_credit_acknowledgements(p_service_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_service_date is null then
    raise exception 'Service date is required';
  end if;

  return coalesce((
    with source_rows as (
      select * from public.daily_credit_acknowledgement_source(p_service_date)
    ), source as (
      select
        source_rows.shop_id,
        min(source_rows.shop_code) as shop_code,
        min(source_rows.shop_name) as shop_name,
        min(source_rows.shop_location) as shop_location,
        count(*)::integer as invoice_count,
        sum(source_rows.total_amount)::numeric(12,2) as total_amount,
        max(source_rows.recorded_at) as latest_delivery_at,
        md5(jsonb_agg(
          source_rows.fingerprint_data order by source_rows.recorded_at, source_rows.charge_id
        )::text) as source_fingerprint
      from source_rows
      group by source_rows.shop_id
    ), open_rounds as (
      select count(*)::integer as count
      from public.delivery_rounds round
      where round.service_date = p_service_date and round.status = 'open'
    )
    select jsonb_agg(jsonb_build_object(
      'shop_id', source.shop_id,
      'shop_code', source.shop_code,
      'shop_name', source.shop_name,
      'shop_location', source.shop_location,
      'invoice_count', source.invoice_count,
      'total_amount', source.total_amount,
      'latest_delivery_at', source.latest_delivery_at,
      'open_round_count', open_rounds.count,
      'document_id', document.id,
      'document_version', document.version,
      'is_stale', document.id is not null and document.source_fingerprint <> source.source_fingerprint,
      'evidence_count', coalesce(evidence.count, 0),
      'latest_evidence_path', evidence.latest_path
    ) order by source.shop_code)
    from source
    cross join open_rounds
    left join lateral (
      select acknowledgement.id, acknowledgement.version, acknowledgement.source_fingerprint
      from public.daily_credit_acknowledgements acknowledgement
      where acknowledgement.shop_id = source.shop_id
        and acknowledgement.service_date = p_service_date
      order by acknowledgement.version desc
      limit 1
    ) document on true
    left join lateral (
      select
        count(*)::integer as count,
        (array_agg(evidence.storage_path order by evidence.uploaded_at desc))[1] as latest_path
      from public.daily_credit_acknowledgement_evidence evidence
      where evidence.acknowledgement_id = document.id
    ) evidence on true
  ), '[]'::jsonb);
end;
$$;

create function public.attach_daily_credit_acknowledgement_evidence(
  p_document_id uuid,
  p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_evidence_id uuid;
  v_path text := trim(coalesce(p_storage_path, ''));
begin
  if not public.is_active_user() then
    raise exception 'An active user is required';
  elsif p_document_id is null or v_path = '' then
    raise exception 'Document and evidence path are required';
  elsif split_part(v_path, '/', 1) <> auth.uid()::text then
    raise exception 'Evidence does not belong to the current user';
  elsif split_part(v_path, '/', 2) <> p_document_id::text then
    raise exception 'Evidence path does not match the daily credit acknowledgement';
  elsif not exists (
    select 1 from public.daily_credit_acknowledgements document where document.id = p_document_id
  ) then
    raise exception 'The daily credit acknowledgement does not exist';
  elsif not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'credit-signoff-evidence' and object.name = v_path
  ) then
    raise exception 'The uploaded evidence does not exist';
  end if;

  insert into public.daily_credit_acknowledgement_evidence (
    acknowledgement_id, storage_path, uploaded_by
  ) values (p_document_id, v_path, auth.uid())
  on conflict (acknowledgement_id, storage_path) do nothing
  returning id into v_evidence_id;

  if v_evidence_id is null then
    select evidence.id into v_evidence_id
    from public.daily_credit_acknowledgement_evidence evidence
    where evidence.acknowledgement_id = p_document_id and evidence.storage_path = v_path;
  end if;

  insert into public.audit_logs (actor_id, entity_type, entity_id, action, after_value)
  values (
    auth.uid(), 'daily_credit_acknowledgement_evidence', v_evidence_id, 'created',
    jsonb_build_object('acknowledgement_id', p_document_id, 'storage_path', v_path)
  ) on conflict do nothing;
  return jsonb_build_object('evidence_id', v_evidence_id, 'storage_path', v_path);
end;
$$;

revoke all on table public.daily_credit_acknowledgements from public, anon, authenticated;
revoke all on table public.daily_credit_acknowledgement_evidence from public, anon, authenticated;
revoke all on function public.protect_daily_credit_acknowledgement() from public, anon, authenticated;
revoke all on function public.protect_daily_credit_acknowledgement_evidence() from public, anon, authenticated;
revoke all on function public.daily_credit_acknowledgement_source(date, uuid) from public, anon, authenticated;
revoke all on function public.daily_credit_acknowledgement_fingerprint(uuid, date) from public, anon, authenticated;
revoke all on function public.build_daily_credit_acknowledgement_document(uuid, uuid, date, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.prepare_daily_credit_acknowledgement(uuid, date) from public, anon, authenticated;
revoke all on function public.get_daily_credit_acknowledgement(uuid) from public, anon, authenticated;
revoke all on function public.list_daily_credit_acknowledgements(date) from public, anon, authenticated;
revoke all on function public.attach_daily_credit_acknowledgement_evidence(uuid, text) from public, anon, authenticated;
grant execute on function public.prepare_daily_credit_acknowledgement(uuid, date) to authenticated;
grant execute on function public.get_daily_credit_acknowledgement(uuid) to authenticated;
grant execute on function public.list_daily_credit_acknowledgements(date) to authenticated;
grant execute on function public.attach_daily_credit_acknowledgement_evidence(uuid, text) to authenticated;

notify pgrst, 'reload schema';
