import { supabase } from './supabase';

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
