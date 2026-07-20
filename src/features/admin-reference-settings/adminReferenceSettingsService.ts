import { supabase } from '../../lib/supabase';
import { isMissingRpc } from '../../lib/rpc';
import type { UserProfile, AppRole } from '../../types/app';
import {
  USER_FIELDS,
  ICE_TYPE_FIELDS,
  DELIVERY_ROUND_NAME_FIELDS,
  SHOP_FIELDS,
  SHOP_IMAGE_BUCKET,
  ICE_TYPE_IMAGE_BUCKET,
  type IceTypeSetting,
  type DeliveryRoundNameSetting,
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

  const [usersResponse, iceTypesResponse, roundNamesResponse] = await Promise.all([
    client.from('users').select(USER_FIELDS).order('code'),
    client.from('ice_types').select(ICE_TYPE_FIELDS).order('code'),
    client.from('delivery_round_name_options').select(DELIVERY_ROUND_NAME_FIELDS).order('sort_order').order('name'),
  ]);
  
  if (isCancelled()) return null;

  const firstError = usersResponse.error ?? iceTypesResponse.error ?? roundNamesResponse.error;
  if (firstError) {
    throw new Error(firstError.message);
  }

  return {
    currentUserId: authData.user.id,
    users: (usersResponse.data ?? []) as UserProfile[],
    iceTypes: (iceTypesResponse.data ?? []) as IceTypeSetting[],
    roundNames: (roundNamesResponse.data ?? []) as DeliveryRoundNameSetting[],
  };
}

export async function saveDeliveryRoundName(
  id: string | null,
  payload: { name: string; sort_order: number; is_active: boolean },
): Promise<DeliveryRoundNameSetting> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client.rpc('save_delivery_round_name_option', {
    p_option_id: id || null,
    p_name: payload.name,
    p_sort_order: payload.sort_order,
    p_is_active: payload.is_active,
  });

  if (error) throw new Error(error.message);
  return data as DeliveryRoundNameSetting;
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
  const savedId = (response.data as { id?: string } | null)?.id;
  if (!savedId) throw new Error('Supabase did not return the saved ice type id');

  const { data, error } = await client
    .from('ice_types')
    .select(ICE_TYPE_FIELDS)
    .eq('id', savedId)
    .single();

  if (error) throw new Error(error.message);
  return data as IceTypeSetting;
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

export async function getShopImageSignedUrls(imagePaths: string[]): Promise<Record<string, string>> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');
  if (imagePaths.length === 0) return {};

  const { data, error } = await client.storage
    .from(SHOP_IMAGE_BUCKET)
    .createSignedUrls(imagePaths, 3600);

  if (error) throw new Error(error.message);
  return Object.fromEntries(
    (data ?? []).flatMap((entry) => entry.path && entry.signedUrl ? [[entry.path, entry.signedUrl]] : []),
  );
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

export async function getIceTypeImageSignedUrl(imagePath: string): Promise<string> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client.storage
    .from(ICE_TYPE_IMAGE_BUCKET)
    .createSignedUrl(imagePath, 3600);

  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export async function uploadIceTypeImage(iceTypeId: string, file: File): Promise<string> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? 'jpg' : 'jpg';
  const nextPath = `ice_types/${iceTypeId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await client.storage
    .from(ICE_TYPE_IMAGE_BUCKET)
    .upload(nextPath, file, {
      cacheControl: '3600',
      contentType: file.type || undefined,
      upsert: false,
    });

  if (uploadError) throw new Error(uploadError.message);
  return nextPath;
}

export async function updateIceTypeImagePath(iceTypeId: string, imagePath: string | null): Promise<IceTypeSetting> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client
    .from('ice_types')
    .update({ image_path: imagePath })
    .eq('id', iceTypeId)
    .select(ICE_TYPE_FIELDS)
    .single();

  if (error) throw new Error(error.message);
  return data as IceTypeSetting;
}

export async function removeIceTypeImageFiles(paths: string[]): Promise<void> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  if (paths.length === 0) return;
  const { error } = await client.storage.from(ICE_TYPE_IMAGE_BUCKET).remove(paths);
  if (error) throw new Error(error.message);
}
