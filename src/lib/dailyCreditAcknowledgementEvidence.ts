import { supabase } from './supabase';
import { optimizeImage } from './imageOptimizer';

export const MAX_DAILY_CREDIT_EVIDENCE_SIZE = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function uploadDailyCreditAcknowledgementEvidence(file: File, documentId: string) {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
  if (!ACCEPTED_TYPES.has(file.type)) throw new Error('รองรับเฉพาะรูป JPEG, PNG หรือ WebP');
  if (file.size > MAX_DAILY_CREDIT_EVIDENCE_SIZE) throw new Error('รูปใบเซ็นต้องมีขนาดไม่เกิน 5 MB');

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error('กรุณาเข้าสู่ระบบใหม่');

  const uploadFile = await optimizeImage(file);
  const path = `${userData.user.id}/${documentId}/${crypto.randomUUID()}.webp`;
  const { error } = await supabase.storage.from('credit-signoff-evidence').upload(path, uploadFile, {
    contentType: 'image/webp',
  });
  if (error) throw error;
  return path;
}
