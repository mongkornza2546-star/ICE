import { supabase } from '../../lib/supabase';
import { isMissingRpc } from '../../lib/rpc';
import type { UserProfile, AppRole } from '../../types/app';
import {
  USER_FIELDS,
  ICE_TYPE_FIELDS,
  SHOP_FIELDS,
  SHOP_IMAGE_BUCKET,
  type IceTypeSetting,
  type ShopImageSetting,
} from './types';

export function getErrorMessage(error: unknown) {
  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return 'เกิดข้อผิดพลาดขณะติดต่อ Supabase';
}

export async function loadAdminSettings(isCancelled: () => boolean) {
  const client = supabase;
  if (!client) throw new Error('ยังไม่ได้ตั้งค่า Supabase สำหรับหน้านี้');

  const { data: authData, error: authError } = await client.auth.getUser();
  if (isCancelled()) return null;
  if (authError || !authData.user) {
    throw new Error(authError?.message ?? 'ไม่พบบัญชีที่กำลังเข้าใช้งาน');
  }

  const { data: profileData, error: profileError } = await client
    .from('users')
    .select('id, role, is_active')
    .eq('id', authData.user.id)
    .maybeSingle();
  
  if (isCancelled()) return null;
  if (profileError) {
    throw new Error(profileError.message);
  }

  const profile = profileData as Pick<UserProfile, 'id' | 'role' | 'is_active'> | null;
  if (!profile?.is_active || profile.role !== 'admin') {
    throw new Error('หน้านี้ใช้ได้เฉพาะบัญชีแอดมินที่เปิดใช้งาน');
  }

  const [usersResponse, iceTypesResponse] = await Promise.all([
    client.from('users').select(USER_FIELDS).order('code'),
    client.from('ice_types').select(ICE_TYPE_FIELDS).order('code'),
  ]);
  
  if (isCancelled()) return null;

  const firstError = usersResponse.error ?? iceTypesResponse.error;
  if (firstError) {
    throw new Error(firstError.message);
  }

  return {
    currentUserId: authData.user.id,
    users: (usersResponse.data ?? []) as UserProfile[],
    iceTypes: (iceTypesResponse.data ?? []) as IceTypeSetting[],
  };
}

export async function updateUser(
  userId: string,
  updates: { display_name: string; phone: string | null; role: AppRole; is_active: boolean }
): Promise<UserProfile> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client
    .from('users')
    .update(updates)
    .eq('id', userId)
    .select(USER_FIELDS)
    .single();

  if (error) throw new Error(error.message);
  return data as UserProfile;
}

export async function saveIceType(
  id: string | null,
  payload: { code: string; name: string; unit: string; is_active: boolean }
): Promise<IceTypeSetting> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const response = await client.rpc('save_ice_type', {
    p_ice_type_id: id || null,
    p_code: payload.code,
    p_name: payload.name,
    p_unit: payload.unit,
    p_is_active: payload.is_active,
  });

  if (response.error) {
    if (!isMissingRpc(response.error)) {
      throw new Error(response.error.message);
    }

    // Fallback if RPC doesn't exist
    const fallbackResponse = id
      ? await client
          .from('ice_types')
          .update(payload)
          .eq('id', id)
          .select(ICE_TYPE_FIELDS)
          .single()
      : await client
          .from('ice_types')
          .insert(payload)
          .select(ICE_TYPE_FIELDS)
          .single();

    if (fallbackResponse.error) {
      throw new Error(fallbackResponse.error.message);
    }
    return fallbackResponse.data as IceTypeSetting;
  }
  return response.data as IceTypeSetting;
}

export async function getShopImageSignedUrl(imagePath: string): Promise<string> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client.storage
    .from(SHOP_IMAGE_BUCKET)
    .createSignedUrl(imagePath, 3600);
    
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export async function uploadShopImage(shopId: string, file: File): Promise<string> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? 'jpg' : 'jpg';
  const nextPath = `shops/${shopId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await client.storage
    .from(SHOP_IMAGE_BUCKET)
    .upload(nextPath, file, {
      cacheControl: '3600',
      contentType: file.type || undefined,
      upsert: false,
    });

  if (uploadError) throw new Error(uploadError.message);
  return nextPath;
}

export async function updateShopImagePath(shopId: string, imagePath: string | null): Promise<ShopImageSetting> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client
    .from('shops')
    .update({ image_path: imagePath })
    .eq('id', shopId)
    .select(SHOP_FIELDS)
    .single();

  if (error) throw new Error(error.message);
  return data as ShopImageSetting;
}

export async function removeShopImageFiles(paths: string[]): Promise<void> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');
  
  if (paths.length === 0) return;
  const { error } = await client.storage.from(SHOP_IMAGE_BUCKET).remove(paths);
  if (error) throw new Error(error.message);
}
