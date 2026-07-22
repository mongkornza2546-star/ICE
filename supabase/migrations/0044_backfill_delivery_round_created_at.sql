-- Compatibility for legacy databases that do not yet have the created_at column
-- used consistently by the daily-work functions in 0042/0043.
alter table public.delivery_rounds
  add column if not exists created_at timestamptz;

update public.delivery_rounds
set created_at = opened_at
where created_at is null;

alter table public.delivery_rounds
  alter column created_at set default now(),
  alter column created_at set not null;
