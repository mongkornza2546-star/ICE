-- The free-refill workflow is retired. Keep historical rows and the audited
-- manager recovery path intact, but prevent every application user role from
-- creating new refill records.
revoke execute on function public.record_daily_stock_refill(date, jsonb, text, uuid)
  from public, anon, authenticated;
