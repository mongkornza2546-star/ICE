-- Keep configured building/zone/delivery order, but compare the numeric suffix
-- of shop codes numerically when delivery orders are equal or unconfigured.
-- Only changes the live ordering of open daily rounds introduced by 0178.
do $ordering$
declare
  v_definition text;
  v_previous text;
begin
  select pg_get_functiondef('public.get_round_shop_cards(uuid,uuid)'::regprocedure)
    into v_definition;
  v_previous := v_definition;
  v_definition := replace(v_definition,
    'shop.delivery_sequence nulls last, shop.code, shop.id',
    $replacement$shop.delivery_sequence nulls last,
        regexp_replace(shop.code, '[0-9]+$', ''),
        substring(shop.code from '[0-9]+$')::numeric nulls first,
        shop.code, shop.id$replacement$);
  if v_definition = v_previous then
    raise exception 'get_round_shop_cards is missing the expected live shop ordering';
  end if;
  execute v_definition;
end;
$ordering$;

notify pgrst, 'reload schema';
