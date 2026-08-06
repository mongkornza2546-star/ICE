import { supabase } from './supabase';

export const MAX_PAYMENT_EVIDENCE_SIZE = 5 * 1024 * 1024;

export async function uploadPaymentEvidence(file: File, idempotencyKey: string) {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error('กรุณาเข้าสู่ระบบใหม่');

  const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const path = `${userData.user.id}/${idempotencyKey}.${extension}`;
  const { error } = await supabase.storage.from('payment-evidence').upload(path, file, {
    upsert: true,
    contentType: file.type,
  });
  if (error) throw error;
  return path;
}

export async function deletePaymentEvidence(path: string, idempotencyKey: string) {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
  const { data: canDelete, error: checkError } = await supabase.rpc('can_delete_payment_evidence', {
    p_idempotency_key: idempotencyKey,
    p_evidence_path: path,
  });
  if (checkError) throw checkError;
  if (!canDelete) return;
  const { error } = await supabase.storage.from('payment-evidence').remove([path]);
  if (error) throw error;
}
