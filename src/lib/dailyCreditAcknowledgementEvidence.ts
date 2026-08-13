import { supabase } from './supabase';
import { optimizeImage } from './imageOptimizer';
import { removeR2Objects, uploadR2Object } from './r2Storage';

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
  const path = `${userData.user.id}/${documentId}/r2/${crypto.randomUUID()}.webp`;
  await uploadR2Object('credit-signoff-evidence', path, uploadFile);
  const { error } = await supabase.storage.from('credit-signoff-evidence').upload(path, new Blob([]), {
    contentType: 'image/webp',
  });
  if (error) {
    await removeR2Objects('credit-signoff-evidence', [path]).catch(() => undefined);
    throw error;
  }
  return path;
}
