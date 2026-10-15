-- Keep the existing owner/manager access (including upload previews).
-- Share only attachments linked to payments visible through payment RLS;
-- another employee's unattached uploads remain private.
create policy "users read evidence for visible payments"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-evidence'
    and public.is_active_user()
    and exists (
      select 1 from public.payments payment
      where payment.evidence_path = storage.objects.name
    )
  );

notify pgrst, 'reload schema';
