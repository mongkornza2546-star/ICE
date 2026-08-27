export const PWA_UPDATE_CONFIRM_MESSAGE = 'การอัปเดตจะโหลดหน้าใหม่ โปรดตรวจสอบว่าบันทึกงานที่ค้างไว้แล้ว ต้องการอัปเดตตอนนี้หรือไม่?';
export const LEGACY_CATALOG_IMAGE_CACHE = 'catalog-images';

type CacheDeletion = Pick<CacheStorage, 'delete'>;

export async function clearLegacyCatalogImageCache(
  cacheStorage: CacheDeletion | undefined = typeof window === 'undefined' ? undefined : window.caches,
) {
  if (!cacheStorage) return false;
  return cacheStorage.delete(LEGACY_CATALOG_IMAGE_CACHE).catch(() => false);
}

export async function requestPwaUpdate(
  updateServiceWorker: (() => Promise<void>) | null,
  confirmUpdate: (message: string) => boolean = (message) => window.confirm(message),
) {
  if (!updateServiceWorker || !confirmUpdate(PWA_UPDATE_CONFIRM_MESSAGE)) return false;
  await updateServiceWorker();
  return true;
}
