-- Work sites are reporting dimensions, not inventory holders. Older rows were
-- created while holds_inventory still defaulted to true.
update public.stock_locations
set holds_inventory = false,
    requires_daily_count = false
where kind = 'work_site'
  and (holds_inventory or requires_daily_count);
