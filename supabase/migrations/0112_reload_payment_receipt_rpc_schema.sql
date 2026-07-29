-- Environments that applied the receipt RPC through SQL Editor can retain the
-- previous PostgREST schema cache and return PGRST202 even though the function
-- exists. Keep this as a follow-up migration so already-applied 0111 installs
-- also receive the repair.
grant execute on function public.get_payment_receipt_items(uuid) to authenticated;
notify pgrst, 'reload schema';
