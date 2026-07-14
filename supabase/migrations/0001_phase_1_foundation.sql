-- Phase 1: authenticated users, reference data, delivery foundations, and audit history.
-- Apply with: supabase db push

create extension if not exists pgcrypto;

do $$
begin
  create type public.app_role as enum ('courier', 'round_lead', 'admin');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.shop_status as enum ('active', 'inactive');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.shop_payment_status as enum ('unknown', 'paid', 'unpaid');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.delivery_round_status as enum ('open', 'closed');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.shop_round_status as enum ('pending', 'delivered', 'full_bin', 'closed_shop', 'no_access', 'issue');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.delivery_event_status as enum ('active', 'cancelled');
exception when duplicate_object then null;
end $$;

-- Every authenticated account receives an inactive courier profile. Only a database
-- administrator can activate it or grant a more privileged role.
create table public.users (
  id uuid primary key references auth.users(id) on delete restrict,
  code text not null unique,
  display_name text not null,
  phone text,
  role public.app_role not null default 'courier',
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  building_id uuid not null references public.buildings(id),
  floor_or_zone text not null,
  contact_name text,
  contact_phone text,
  image_path text,
  normal_rounds_per_day smallint not null default 1 check (normal_rounds_per_day > 0),
  payment_status public.shop_payment_status not null default 'unknown',
  payment_status_updated_at timestamptz,
  payment_status_updated_by uuid references public.users(id),
  access_note text,
  status public.shop_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payment_status = 'unknown'
      or (payment_status_updated_at is not null and payment_status_updated_by is not null))
);

create table public.route_shops (
  route_id uuid not null references public.routes(id),
  shop_id uuid not null references public.shops(id),
  sequence_no integer not null check (sequence_no > 0),
  is_active boolean not null default true,
  primary key (route_id, shop_id),
  unique (route_id, sequence_no)
);

create table public.ice_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  unit text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.delivery_rounds (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  name text not null,
  route_id uuid not null references public.routes(id),
  status public.delivery_round_status not null default 'open',
  opened_by uuid not null references public.users(id),
  opened_at timestamptz not null default now(),
  closed_by uuid references public.users(id),
  closed_at timestamptz,
  check ((status = 'open' and closed_by is null and closed_at is null)
      or (status = 'closed' and closed_by is not null and closed_at is not null))
);

create table public.delivery_round_members (
  round_id uuid not null references public.delivery_rounds(id),
  user_id uuid not null references public.users(id),
  primary key (round_id, user_id)
);

create table public.round_ice_counts (
  round_id uuid not null references public.delivery_rounds(id),
  ice_type_id uuid not null references public.ice_types(id),
  loaded_quantity integer not null default 0 check (loaded_quantity >= 0),
  replenished_quantity integer not null default 0 check (replenished_quantity >= 0),
  remaining_quantity integer not null default 0 check (remaining_quantity >= 0),
  damaged_quantity integer not null default 0 check (damaged_quantity >= 0),
  updated_by uuid not null references public.users(id),
  updated_at timestamptz not null default now(),
  primary key (round_id, ice_type_id)
);

create table public.round_stops (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.delivery_rounds(id),
  shop_id uuid not null references public.shops(id),
  shop_code_snapshot text not null,
  shop_name_snapshot text not null,
  building_id_snapshot uuid not null,
  building_name_snapshot text not null,
  floor_or_zone_snapshot text not null,
  sequence_no integer not null check (sequence_no > 0),
  status public.shop_round_status not null default 'pending',
  note text,
  updated_by uuid not null references public.users(id),
  updated_at timestamptz not null default now(),
  unique (round_id, shop_id),
  unique (round_id, sequence_no),
  check ((status in ('pending', 'delivered')) or nullif(trim(coalesce(note, '')), '') is not null)
);

create table public.delivery_events (
  id uuid primary key default gen_random_uuid(),
  round_stop_id uuid not null references public.round_stops(id),
  recorded_by uuid not null references public.users(id),
  recorded_at timestamptz not null default now(),
  client_recorded_at timestamptz,
  idempotency_key uuid not null unique,
  note text,
  status public.delivery_event_status not null default 'active',
  cancelled_by uuid references public.users(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  check ((status = 'active' and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
      or (status = 'cancelled' and cancelled_by is not null and cancelled_at is not null
          and nullif(trim(coalesce(cancellation_reason, '')), '') is not null))
);

create table public.delivery_items (
  delivery_event_id uuid not null references public.delivery_events(id),
  ice_type_id uuid not null references public.ice_types(id),
  quantity integer not null check (quantity > 0),
  primary key (delivery_event_id, ice_type_id)
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.users(id),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  before_value jsonb,
  after_value jsonb,
  reason text,
  occurred_at timestamptz not null default now()
);

create table public.round_close_summaries (
  round_id uuid primary key references public.delivery_rounds(id),
  total_shop_count integer not null check (total_shop_count >= 0),
  delivered_shop_count integer not null check (delivered_shop_count >= 0),
  pending_shop_count integer not null check (pending_shop_count >= 0),
  problem_shop_count integer not null check (problem_shop_count >= 0),
  captured_by uuid not null references public.users(id),
  captured_at timestamptz not null,
  check (delivered_shop_count + pending_shop_count + problem_shop_count = total_shop_count)
);

create table public.round_close_ice_summaries (
  round_id uuid not null references public.round_close_summaries(round_id),
  ice_type_id uuid not null references public.ice_types(id),
  loaded_quantity integer not null check (loaded_quantity >= 0),
  replenished_quantity integer not null check (replenished_quantity >= 0),
  remaining_quantity integer not null check (remaining_quantity >= 0),
  damaged_quantity integer not null check (damaged_quantity >= 0),
  expected_quantity integer not null,
  delivered_quantity integer not null check (delivered_quantity >= 0),
  variance_quantity integer not null,
  primary key (round_id, ice_type_id),
  check (expected_quantity = loaded_quantity + replenished_quantity - remaining_quantity - damaged_quantity),
  check (variance_quantity = expected_quantity - delivered_quantity)
);

create index round_stops_round_status_idx on public.round_stops (round_id, status);
create index delivery_events_stop_active_idx
  on public.delivery_events (round_stop_id, recorded_at)
  where status = 'active';
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, occurred_at desc);

create view public.round_ice_reconciliation
with (security_invoker = true)
as
select
  c.round_id,
  c.ice_type_id,
  c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity as expected_quantity,
  coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as delivered_quantity,
  (c.loaded_quantity + c.replenished_quantity - c.remaining_quantity - c.damaged_quantity)
    - coalesce(sum(i.quantity) filter (where e.status = 'active'), 0) as variance_quantity
from public.round_ice_counts c
left join public.round_stops s on s.round_id = c.round_id
left join public.delivery_events e on e.round_stop_id = s.id
left join public.delivery_items i on i.delivery_event_id = e.id and i.ice_type_id = c.ice_type_id
group by c.round_id, c.ice_type_id, c.loaded_quantity, c.replenished_quantity,
  c.remaining_quantity, c.damaged_quantity;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, code, display_name, is_active)
  values (
    new.id,
    concat('AUTH-', upper(replace(new.id::text, '-', ''))),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), new.email, 'ผู้ใช้ใหม่'),
    false
  );
  return new;
end;
$$;

create trigger auth_user_created
  after insert on auth.users
  for each row execute function public.create_profile_for_auth_user();

create or replace function public.track_shop_payment_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.payment_status is distinct from old.payment_status then
    if new.payment_status = 'unknown' then
      new.payment_status_updated_at = null;
      new.payment_status_updated_by = null;
    else
      new.payment_status_updated_at = now();
      new.payment_status_updated_by = auth.uid();
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid() and is_active;
$$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.users where id = auth.uid() and is_active);
$$;

create or replace function public.is_round_member(target_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.delivery_round_members
    where round_id = target_round_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_delivery_event_visible(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.delivery_events e
    join public.round_stops s on s.id = e.round_stop_id
    where e.id = target_event_id
      and (public.current_app_role() in ('admin', 'round_lead') or public.is_round_member(s.round_id))
  );
$$;

create or replace function public.audit_row_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_value, after_value, reason)
    values (
      auth.uid(),
      tg_table_name,
      new.id,
      case
        when to_jsonb(old) ->> 'status' <> 'cancelled' and to_jsonb(new) ->> 'status' = 'cancelled' then 'cancelled'
        else 'updated'
      end,
      to_jsonb(old),
      to_jsonb(new),
      case when to_jsonb(new) ->> 'status' = 'cancelled' then to_jsonb(new) ->> 'cancellation_reason' end
    );
  end if;
  return new;
end;
$$;

create or replace function public.audit_route_shop_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    insert into public.audit_logs (actor_id, entity_type, entity_id, action, before_value, after_value)
    values (auth.uid(), 'route_shops', new.shop_id, 'updated', to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end;
$$;

create trigger users_updated_at before update on public.users for each row execute function public.set_updated_at();
create trigger buildings_updated_at before update on public.buildings for each row execute function public.set_updated_at();
create trigger routes_updated_at before update on public.routes for each row execute function public.set_updated_at();
create trigger shops_updated_at before update on public.shops for each row execute function public.set_updated_at();
create trigger shops_track_payment_status before insert or update on public.shops for each row execute function public.track_shop_payment_status();
create trigger ice_types_updated_at before update on public.ice_types for each row execute function public.set_updated_at();
create trigger users_audit_update after update on public.users for each row execute function public.audit_row_update();
create trigger buildings_audit_update after update on public.buildings for each row execute function public.audit_row_update();
create trigger routes_audit_update after update on public.routes for each row execute function public.audit_row_update();
create trigger shops_audit_update after update on public.shops for each row execute function public.audit_row_update();
create trigger ice_types_audit_update after update on public.ice_types for each row execute function public.audit_row_update();
create trigger route_shops_audit_update after update on public.route_shops for each row execute function public.audit_route_shop_update();
create trigger delivery_rounds_audit_update after update on public.delivery_rounds for each row execute function public.audit_row_update();
create trigger round_stops_audit_update after update on public.round_stops for each row execute function public.audit_row_update();
create trigger delivery_events_audit_update after update on public.delivery_events for each row execute function public.audit_row_update();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-images', 'shop-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

alter table public.users enable row level security;
alter table public.buildings enable row level security;
alter table public.routes enable row level security;
alter table public.shops enable row level security;
alter table public.route_shops enable row level security;
alter table public.ice_types enable row level security;
alter table public.delivery_rounds enable row level security;
alter table public.delivery_round_members enable row level security;
alter table public.round_ice_counts enable row level security;
alter table public.round_stops enable row level security;
alter table public.delivery_events enable row level security;
alter table public.delivery_items enable row level security;
alter table public.audit_logs enable row level security;
alter table public.round_close_summaries enable row level security;
alter table public.round_close_ice_summaries enable row level security;

create policy "active users read own profile or admins read all" on public.users for select
  using (public.is_active_user() and (id = auth.uid() or public.current_app_role() = 'admin'));
create policy "admins update users" on public.users for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');

create policy "active users read buildings" on public.buildings for select using (public.is_active_user());
create policy "admins create buildings" on public.buildings for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update buildings" on public.buildings for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');
create policy "active users read routes" on public.routes for select using (public.is_active_user());
create policy "admins create routes" on public.routes for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update routes" on public.routes for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');
create policy "active users read shops" on public.shops for select using (public.is_active_user());
create policy "admins create shops" on public.shops for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update shops" on public.shops for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');
create policy "active users read route shops" on public.route_shops for select using (public.is_active_user());
create policy "admins create route shops" on public.route_shops for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update route shops" on public.route_shops for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');
create policy "active users read ice types" on public.ice_types for select using (public.is_active_user());
create policy "admins create ice types" on public.ice_types for insert
  with check (public.current_app_role() = 'admin');
create policy "admins update ice types" on public.ice_types for update
  using (public.current_app_role() = 'admin') with check (public.current_app_role() = 'admin');

create policy "admins or leads read rounds" on public.delivery_rounds for select
  using (public.current_app_role() in ('admin', 'round_lead') or public.is_round_member(id));
create policy "admins or leads read round members" on public.delivery_round_members for select
  using (public.current_app_role() in ('admin', 'round_lead') or user_id = auth.uid());
create policy "round members read ice counts" on public.round_ice_counts for select
  using (public.current_app_role() in ('admin', 'round_lead') or public.is_round_member(round_id));
create policy "round members read stops" on public.round_stops for select
  using (public.current_app_role() in ('admin', 'round_lead') or public.is_round_member(round_id));
create policy "round members read delivery events" on public.delivery_events for select
  using (public.current_app_role() in ('admin', 'round_lead') or exists (
    select 1 from public.round_stops where id = round_stop_id and public.is_round_member(round_id)
  ));
create policy "round members read delivery items" on public.delivery_items for select
  using (public.is_delivery_event_visible(delivery_event_id));
create policy "admins or leads read round close summaries" on public.round_close_summaries for select
  using (public.current_app_role() in ('admin', 'round_lead'));
create policy "admins or leads read round close ice summaries" on public.round_close_ice_summaries for select
  using (public.current_app_role() in ('admin', 'round_lead'));
create policy "admins read audit history" on public.audit_logs for select
  using (public.current_app_role() = 'admin');

create policy "active users read shop images" on storage.objects for select
  using (bucket_id = 'shop-images' and public.is_active_user());
create policy "admins upload shop images" on storage.objects for insert
  with check (bucket_id = 'shop-images' and public.current_app_role() = 'admin');
create policy "admins update shop images" on storage.objects for update
  using (bucket_id = 'shop-images' and public.current_app_role() = 'admin')
  with check (bucket_id = 'shop-images' and public.current_app_role() = 'admin');
create policy "admins delete shop images" on storage.objects for delete
  using (bucket_id = 'shop-images' and public.current_app_role() = 'admin');

revoke all on function public.current_app_role() from public;
revoke all on function public.is_active_user() from public;
revoke all on function public.is_round_member(uuid) from public;
revoke all on function public.is_delivery_event_visible(uuid) from public;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_active_user() to authenticated;
grant execute on function public.is_round_member(uuid) to authenticated;
grant execute on function public.is_delivery_event_visible(uuid) to authenticated;
