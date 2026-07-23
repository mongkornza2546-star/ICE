import { supabase } from '../../lib/supabase';
import { toBangkokDateString } from '../../lib/serviceDate';
import { isMissingRpc } from '../../lib/rpc';
import type { UserProfile, AppRole, IceTypePriceSetting, ShopPaymentProfileSetting, ShopIcePriceSetting, POSReadinessReport, ShopReadinessItem } from '../../types/app';
import {
  USER_FIELDS,
  WORK_SITE_FIELDS,
  EMPLOYEE_WORK_SITE_ASSIGNMENT_FIELDS,
  ICE_TYPE_FIELDS,
  DELIVERY_ROUND_NAME_FIELDS,
  SHOP_FIELDS,
  SHOP_IMAGE_BUCKET,
  USER_AVATAR_BUCKET,
  ICE_TYPE_IMAGE_BUCKET,
  type IceTypeSetting,
  type DeliveryRoundNameSetting,
  type ShopImageSetting,
  type WorkSiteOption,
  type EmployeeWorkSiteAssignment,
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

  const [usersResponse, workSitesResponse, assignmentsResponse, iceTypesResponse, roundNamesResponse] = await Promise.all([
    client.from('users').select(USER_FIELDS).order('code'),
    client
      .from('stock_locations')
      .select(WORK_SITE_FIELDS)
      .eq('kind', 'work_site')
      .eq('is_active', true)
      .order('code'),
    client
      .from('employee_work_site_assignments')
      .select(EMPLOYEE_WORK_SITE_ASSIGNMENT_FIELDS),
    client.from('ice_types').select(ICE_TYPE_FIELDS).order('code'),
    client.from('delivery_round_name_options').select(DELIVERY_ROUND_NAME_FIELDS).order('sort_order').order('name'),
  ]);
  
  if (isCancelled()) return null;

  const firstError = usersResponse.error
    ?? workSitesResponse.error
    ?? assignmentsResponse.error
    ?? iceTypesResponse.error
    ?? roundNamesResponse.error;
  if (firstError) {
    throw new Error(firstError.message);
  }

  return {
    currentUserId: authData.user.id,
    users: (usersResponse.data ?? []) as UserProfile[],
    workSites: (workSitesResponse.data ?? []) as WorkSiteOption[],
    workSiteAssignments: (assignmentsResponse.data ?? []) as EmployeeWorkSiteAssignment[],
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

export async function saveUserWithWorkSiteAssignments(
  userId: string,
  updates: {
    display_name: string;
    nickname: string | null;
    avatar_path: string | null;
    phone: string | null;
    role: AppRole;
    is_active: boolean;
  },
  workSiteIds: string[],
): Promise<{ user: UserProfile; work_site_ids: string[] }> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client.rpc('save_user_profile_with_work_site_assignments', {
    p_user_id: userId,
    p_display_name: updates.display_name,
    p_nickname: updates.nickname,
    p_avatar_path: updates.avatar_path,
    p_phone: updates.phone,
    p_role: updates.role,
    p_is_active: updates.is_active,
    p_work_site_ids: workSiteIds,
  });

  if (error) throw new Error(error.message);
  const result = data as { user?: UserProfile; work_site_ids?: string[] } | null;
  if (!result?.user || !Array.isArray(result.work_site_ids)) {
    throw new Error('Supabase did not return the saved user and work-site assignments');
  }
  return { user: result.user, work_site_ids: result.work_site_ids };
}

export async function getUserAvatarSignedUrl(imagePath: string): Promise<string> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');
  const { data, error } = await client.storage.from(USER_AVATAR_BUCKET).createSignedUrl(imagePath, 3600);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export async function uploadUserAvatar(userId: string, file: File): Promise<string> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? 'jpg' : 'jpg';
  const path = `users/${userId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const { error } = await client.storage.from(USER_AVATAR_BUCKET).upload(path, file, {
    cacheControl: '3600', contentType: file.type || undefined, upsert: false,
  });
  if (error) throw new Error(error.message);
  return path;
}

export async function removeUserAvatarFiles(paths: string[]): Promise<void> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');
  if (paths.length === 0) return;
  const { error } = await client.storage.from(USER_AVATAR_BUCKET).remove(paths);
  if (error) throw new Error(error.message);
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

  // ice_types writes are intentionally performed through security-definer RPCs.
  // A direct update is rejected by RLS and PostgREST then tries to coerce its
  // empty result into .single(), which produces a misleading error message.
  const { data, error } = await client.rpc('update_ice_type_image_path', {
    p_ice_type_id: iceTypeId,
    p_image_path: imagePath,
  });

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

export async function loadIceTypePrices(iceTypeId?: string): Promise<IceTypePriceSetting[]> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  let query = client
    .from('ice_type_prices')
    .select(`
      id,
      ice_type_id,
      unit_price,
      valid_from,
      valid_to,
      is_active,
      created_at,
      ice_types ( code, name, unit )
    `)
    .order('valid_from', { ascending: false });

  if (iceTypeId) {
    query = query.eq('ice_type_id', iceTypeId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data ?? []).map((row: any) => ({
    id: row.id,
    ice_type_id: row.ice_type_id,
    ice_type_code: row.ice_types?.code,
    ice_type_name: row.ice_types?.name,
    unit: row.ice_types?.unit,
    unit_price: Number(row.unit_price),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    is_active: row.is_active,
    created_at: row.created_at,
  }));
}

export async function saveIceTypePrice(payload: {
  ice_type_id: string;
  unit_price: number;
  valid_from: string;
  valid_to: string | null;
}): Promise<IceTypePriceSetting> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client
    .rpc('set_ice_type_price', {
      target_ice_type_id: payload.ice_type_id,
      target_unit_price: payload.unit_price,
      target_valid_from: payload.valid_from,
      target_valid_to: payload.valid_to || null,
    })
    .single();

  if (error) throw new Error(error.message);

  const row = data as any;
  return {
    id: row.id,
    ice_type_id: row.ice_type_id,
    unit_price: Number(row.unit_price),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    is_active: row.is_active,
    created_at: row.created_at,
  };
}

export async function loadShopPaymentProfile(shopId: string): Promise<ShopPaymentProfileSetting | null> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client
    .from('shop_payment_profiles')
    .select('*')
    .eq('shop_id', shopId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    ...data,
    credit_limit: data.credit_limit !== null ? Number(data.credit_limit) : null,
  } as ShopPaymentProfileSetting;
}

export async function saveShopPaymentProfile(
  profile: ShopPaymentProfileSetting
): Promise<ShopPaymentProfileSetting> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data: authData } = await client.auth.getUser();
  if (!authData?.user) throw new Error('ไม่พบบัญชีผู้ใช้');

  const payload = {
    shop_id: profile.shop_id,
    allowed_payment_terms: profile.allowed_payment_terms,
    default_payment_term: profile.default_payment_term,
    allowed_payment_methods: profile.allowed_payment_methods,
    default_payment_method: profile.default_payment_method,
    cash_reference_required: profile.cash_reference_required,
    cash_evidence_required: profile.cash_evidence_required,
    bank_transfer_reference_required: profile.bank_transfer_reference_required,
    bank_transfer_evidence_required: profile.bank_transfer_evidence_required,
    qr_reference_required: profile.qr_reference_required,
    qr_evidence_required: profile.qr_evidence_required,
    allow_outstanding: profile.allow_outstanding,
    credit_due_rule: profile.credit_due_rule,
    credit_days: profile.credit_days,
    credit_limit: profile.credit_limit,
    created_by: authData.user.id,
  };

  const { data, error } = await client
    .from('shop_payment_profiles')
    .upsert(payload, { onConflict: 'shop_id' })
    .select('*')
    .single();

  if (error) throw new Error(error.message);
  return {
    ...data,
    credit_limit: data.credit_limit !== null ? Number(data.credit_limit) : null,
  } as ShopPaymentProfileSetting;
}

export async function loadShopIcePrices(shopId: string): Promise<ShopIcePriceSetting[]> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client
    .from('shop_ice_type_prices')
    .select(`
      id,
      shop_id,
      ice_type_id,
      unit_price,
      valid_from,
      valid_to,
      is_active,
      ice_types ( code, name, unit )
    `)
    .eq('shop_id', shopId)
    .order('valid_from', { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row: any) => ({
    id: row.id,
    shop_id: row.shop_id,
    ice_type_id: row.ice_type_id,
    ice_type_code: row.ice_types?.code,
    ice_type_name: row.ice_types?.name,
    unit: row.ice_types?.unit,
    unit_price: Number(row.unit_price),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    is_active: row.is_active,
  }));
}

export async function saveShopIcePrice(payload: {
  shop_id: string;
  ice_type_id: string;
  unit_price: number;
  valid_from: string;
  valid_to: string | null;
}): Promise<ShopIcePriceSetting> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const { data, error } = await client
    .rpc('set_shop_ice_type_price', {
      target_shop_id: payload.shop_id,
      target_ice_type_id: payload.ice_type_id,
      target_unit_price: payload.unit_price,
      target_valid_from: payload.valid_from,
      target_valid_to: payload.valid_to || null,
    })
    .single();

  if (error) throw new Error(error.message);

  const row = data as any;
  return {
    id: row.id,
    shop_id: row.shop_id,
    ice_type_id: row.ice_type_id,
    unit_price: Number(row.unit_price),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    is_active: row.is_active,
  };
}

export async function bulkSaveShopIcePrices(
  shopIds: string[],
  price: Omit<Parameters<typeof saveShopIcePrice>[0], 'shop_id'>,
): Promise<number> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');
  if (shopIds.length === 0) return 0;

  const { data, error } = await client.rpc('bulk_set_shop_ice_type_price', {
    target_shop_ids: shopIds,
    target_ice_type_id: price.ice_type_id,
    target_unit_price: price.unit_price,
    target_valid_from: price.valid_from,
    target_valid_to: price.valid_to,
  });
  if (error) throw new Error(error.message);
  return Number(data);
}

export async function bulkSaveShopPaymentProfiles(
  shopIds: string[],
  templateProfile: Omit<ShopPaymentProfileSetting, 'shop_id' | 'id'>
): Promise<number> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');
  if (shopIds.length === 0) return 0;

  const { data: authData } = await client.auth.getUser();
  if (!authData?.user) throw new Error('ไม่พบบัญชีผู้ใช้');

  const rows = shopIds.map((shop_id) => ({
    shop_id,
    allowed_payment_terms: templateProfile.allowed_payment_terms,
    default_payment_term: templateProfile.default_payment_term,
    allowed_payment_methods: templateProfile.allowed_payment_methods,
    default_payment_method: templateProfile.default_payment_method,
    cash_reference_required: templateProfile.cash_reference_required,
    cash_evidence_required: templateProfile.cash_evidence_required,
    bank_transfer_reference_required: templateProfile.bank_transfer_reference_required,
    bank_transfer_evidence_required: templateProfile.bank_transfer_evidence_required,
    qr_reference_required: templateProfile.qr_reference_required,
    qr_evidence_required: templateProfile.qr_evidence_required,
    allow_outstanding: templateProfile.allow_outstanding,
    credit_due_rule: templateProfile.credit_due_rule,
    credit_days: templateProfile.credit_days,
    credit_limit: templateProfile.credit_limit,
    created_by: authData.user.id,
  }));

  const { error } = await client
    .from('shop_payment_profiles')
    .upsert(rows, { onConflict: 'shop_id' });

  if (error) throw new Error(error.message);
  return shopIds.length;
}

export async function loadPOSReadinessReport(serviceDate = toBangkokDateString()): Promise<POSReadinessReport> {
  const client = supabase;
  if (!client) throw new Error('Supabase client not initialized');

  const [shopsRes, profilesRes, iceTypesRes, midPricesRes, specialPricesRes] = await Promise.all([
    client.from('shops').select('id, code, name, buildings(name), building_zones(name)').eq('status', 'active').order('code'),
    client.from('shop_payment_profiles').select('shop_id'),
    client.from('ice_types').select('id, code, name').eq('is_active', true),
    client.from('ice_type_prices').select('ice_type_id, valid_from, valid_to').eq('is_active', true),
    client.from('shop_ice_type_prices').select('shop_id, ice_type_id, valid_from, valid_to').eq('is_active', true),
  ]);

  for (const result of [shopsRes, profilesRes, iceTypesRes, midPricesRes, specialPricesRes]) {
    if (result.error) throw new Error(result.error.message);
  }

  const activeShops = (shopsRes.data ?? []) as any[];
  const profileSet = new Set((profilesRes.data ?? []).map((p: any) => p.shop_id));
  const activeIceTypes = (iceTypesRes.data ?? []) as any[];
  const midPrices = (midPricesRes.data ?? []) as any[];
  const specialPrices = (specialPricesRes.data ?? []) as any[];

  const iceTypesWithPriceToday = new Set(
    midPrices
      .filter((p) => p.valid_from <= serviceDate && (!p.valid_to || p.valid_to >= serviceDate))
      .map((p) => p.ice_type_id)
  );

  const missingMidPriceCount = activeIceTypes.filter((it) => !iceTypesWithPriceToday.has(it.id)).length;

  const items: ShopReadinessItem[] = activeShops.map((shop) => {
    const hasProfile = profileSet.has(shop.id);
    const issueDetails: string[] = [];

    if (!hasProfile) {
      issueDetails.push('ยังไม่มี Payment Profile');
    }

    let missingPricesForShop = 0;
    for (const iceType of activeIceTypes) {
      const hasSpecial = specialPrices.some(
        (sp) => sp.shop_id === shop.id && sp.ice_type_id === iceType.id && sp.valid_from <= serviceDate && (!sp.valid_to || sp.valid_to >= serviceDate)
      );
      const hasStd = iceTypesWithPriceToday.has(iceType.id);
      if (!hasSpecial && !hasStd) {
        missingPricesForShop++;
      }
    }

    if (missingPricesForShop > 0) {
      issueDetails.push(`ไม่มีราคาสินค้า ${missingPricesForShop} ชนิด`);
    }

    return {
      shop_id: shop.id,
      shop_code: shop.code,
      shop_name: shop.name,
      building_name: shop.buildings?.name,
      zone_name: shop.building_zones?.name,
      has_payment_profile: hasProfile,
      missing_special_prices_count: missingPricesForShop,
      has_issues: issueDetails.length > 0,
      issue_details: issueDetails,
    };
  });

  const readyCount = items.filter((item) => !item.has_issues).length;
  const missingProfilesCount = items.filter((item) => !item.has_payment_profile).length;

  return {
    total_active_shops: activeShops.length,
    shops_ready_count: readyCount,
    shops_missing_payment_profile: missingProfilesCount,
    ice_types_missing_standard_price: missingMidPriceCount,
    items,
  };
}
