import type { AppRole } from '../../types/app';

export interface UserDraft {
  id: string;
  code: string;
  displayName: string;
  phone: string;
  role: AppRole;
  isActive: boolean;
}

export interface IceTypeSetting {
  id: string;
  code: string;
  name: string;
  unit: string;
  is_active: boolean;
}

export interface IceTypeDraft {
  id: string;
  code: string;
  name: string;
  unit: string;
  isActive: boolean;
}

export interface ShopImageSetting {
  id: string;
  code: string;
  name: string;
  image_path: string | null;
  status: 'active' | 'inactive';
}

export const EMPTY_ICE_TYPE: IceTypeDraft = {
  id: '',
  code: '',
  name: '',
  unit: '',
  isActive: true,
};

export const ALLOWED_SHOP_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_SHOP_IMAGE_SIZE = 5 * 1024 * 1024;
export const SHOP_IMAGE_BUCKET = 'shop-images';
export const USER_FIELDS = 'id, code, display_name, phone, role, is_active';
export const ICE_TYPE_FIELDS = 'id, code, name, unit, is_active';
export const SHOP_FIELDS = 'id, code, name, image_path, status';

export const ROLE_OPTIONS: Array<{ value: AppRole; label: string }> = [
  { value: 'courier', label: 'พนักงานส่ง' },
  { value: 'round_lead', label: 'หัวหน้ารอบ' },
  { value: 'admin', label: 'แอดมิน' },
];
