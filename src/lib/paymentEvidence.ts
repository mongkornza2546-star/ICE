import { supabase } from './supabase';
import { optimizeImage } from './imageOptimizer';
import { removeR2Objects, uploadR2Object } from './r2Storage';

export const MAX_PAYMENT_EVIDENCE_SIZE = 5 * 1024 * 1024;

export async function uploadPaymentEvidence(file: File, idempotencyKey: string) {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error('กรุณาเข้าสู่ระบบใหม่');

  const uploadFile = file.type === 'application/pdf' ? file : await optimizeImage(file);
  const extension = uploadFile.type === 'application/pdf' ? 'pdf' : 'webp';
  const path = `${userData.user.id}/r2/${idempotencyKey}.${extension}`;
  await uploadR2Object('payment-evidence', path, uploadFile);
  const { error } = await supabase.storage.from('payment-evidence').upload(path, new Blob([]), {
    upsert: true,
    contentType: uploadFile.type,
  });
  if (error) {
    await removeR2Objects('payment-evidence', [path]).catch(() => undefined);
    throw error;
  }
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
  await removeR2Objects('payment-evidence', [path]);
  const { error } = await supabase.storage.from('payment-evidence').remove([path]);
  if (error) throw error;
}
