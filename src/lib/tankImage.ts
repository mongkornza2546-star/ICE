import { optimizeImage } from './imageOptimizer';
import { supabase } from './supabase';
import { removeR2Objects, uploadR2Object } from './r2Storage';

export async function uploadTankImage(shopId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');

  const uploadFile = await optimizeImage(file);
  const path = `${shopId}/r2/${crypto.randomUUID()}.webp`;
  return uploadR2Object('tank-images', path, uploadFile);
}

export async function removeTankImage(path: string): Promise<void> {
  await removeR2Objects('tank-images', [path]);
}
