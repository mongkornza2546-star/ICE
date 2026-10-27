-- Admins may cancel an older delivery without cancelling newer deliveries first.
-- Keep payment, active-user, scope and closed-period checks in the existing RPCs.
-- Event cancellation delegates to the same policy. Cancellation already restores
-- only the selected delivery's stock and derives the stop from the latest survivor.
begin;

do $admin_cancel_any_order$
declare
  v_patch record;
  v_definition text;
begin
  for v_patch in select * from (values
    ('public.get_delivery_correction_context(uuid)',
     $old$elsif not v_is_latest then$old$,
     $new$elsif not v_is_latest and public.current_app_role() is distinct from 'admin' then$new$),
    ('public.get_delivery_correction_context(uuid)',
     $old$and v_is_latest
    and v_charge.payment_term$old$,
     $new$and (v_is_latest or public.current_app_role() = 'admin')
    and v_charge.payment_term$new$),
    -- Both action flags and the explanatory blocker use the same ordering rule.
    ('public.get_round_shop_cards(uuid,uuid)',
     $old$daily_events.is_latest$old$,
     $new$(daily_events.is_latest or public.current_app_role() = 'admin')$new$)
  ) patches(signature, old_fragment, new_fragment) loop
    v_definition := pg_get_functiondef(v_patch.signature::regprocedure);
    if strpos(v_definition, v_patch.new_fragment) > 0 then continue; end if;
    if strpos(v_definition, v_patch.old_fragment) = 0 then
      raise exception 'Unexpected delivery cancellation policy in %', v_patch.signature;
    end if;
    execute replace(v_definition, v_patch.old_fragment, v_patch.new_fragment);
  end loop;
end;
$admin_cancel_any_order$;

notify pgrst, 'reload schema';
commit;
