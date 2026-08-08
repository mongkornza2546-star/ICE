export const PWA_UPDATE_CONFIRM_MESSAGE = 'การอัปเดตจะโหลดหน้าใหม่ โปรดตรวจสอบว่าบันทึกงานที่ค้างไว้แล้ว ต้องการอัปเดตตอนนี้หรือไม่?';

export async function requestPwaUpdate(
  updateServiceWorker: (() => Promise<void>) | null,
  confirmUpdate: (message: string) => boolean = (message) => window.confirm(message),
) {
  if (!updateServiceWorker || !confirmUpdate(PWA_UPDATE_CONFIRM_MESSAGE)) return false;
  await updateServiceWorker();
  return true;
}
