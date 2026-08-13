import { optimizeImage } from './imageOptimizer';
import { supabase } from './supabase';

export async function uploadTankImage(shopId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');

  const uploadFile = await optimizeImage(file);
  const path = `${shopId}/${crypto.randomUUID()}.webp`;
  const { error } = await supabase.storage.from('tank-images').upload(path, uploadFile, {
    cacheControl: '3600',
    contentType: 'image/webp',
    upsert: false,
  });
  if (error) throw error;
  return path;
}
