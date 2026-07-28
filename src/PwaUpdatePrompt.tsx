import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

export function PwaUpdatePrompt() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [updateServiceWorker, setUpdateServiceWorker] = useState<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const onDraftState = (event: Event) => {
      setHasDraft(Boolean((event as CustomEvent<{ dirty?: boolean }>).detail?.dirty));
    };
    window.addEventListener('ice-delivery-draft-state', onDraftState);
    if (!import.meta.env.PROD) return () => window.removeEventListener('ice-delivery-draft-state', onDraftState);
    const update = registerSW({
      onNeedRefresh() {
        setUpdateAvailable(true);
      },
    });
    setUpdateServiceWorker(() => update);
    return () => window.removeEventListener('ice-delivery-draft-state', onDraftState);
  }, []);

  if (!updateAvailable) return null;
  return (
    <aside className="pwa-update-prompt" role="status">
      <span>มีเวอร์ชันใหม่พร้อมใช้งาน</span>
      {hasDraft ? <span>บันทึกหรือยกเลิกงานค้างก่อนอัปเดต</span> : null}
      <button disabled={hasDraft || !updateServiceWorker} onClick={() => void updateServiceWorker?.()} type="button">
        อัปเดตตอนนี้
      </button>
    </aside>
  );
}
