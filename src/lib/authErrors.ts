export function getRecoverableSessionNotice(message: string | null | undefined) {
  if (!message) return null;

  if (/jwt issued at future/i.test(message)) {
    return 'เวลาในเครื่องหรือเซสชันไม่ตรงกับระบบ โปรดตรวจสอบวันและเวลาเครื่อง แล้วเข้าสู่ระบบใหม่อีกครั้ง';
  }

  if (/jwt has expired|invalid refresh token|refresh token.*not found/i.test(message)) {
    return 'เซสชันหมดอายุแล้ว โปรดเข้าสู่ระบบใหม่อีกครั้ง';
  }

  return null;
}
