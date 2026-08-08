import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { requestPwaUpdate } from './pwaUpdateSafety';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const IOS_INSTALL_DISMISSED_KEY = 'ice-delivery-ios-install-dismissed';

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
}

export function PwaUpdatePrompt() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [offlineReady, setOfflineReady] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosInstallHelp, setShowIosInstallHelp] = useState(false);
  const [updateServiceWorker, setUpdateServiceWorker] = useState<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const onDraftState = (event: Event) => {
      setHasDraft(Boolean((event as CustomEvent<{ dirty?: boolean }>).detail?.dirty));
    };
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setInstallPrompt(null);
      setShowIosInstallHelp(false);
    };

    window.addEventListener('ice-delivery-draft-state', onDraftState);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setShowIosInstallHelp(
      isIos && !isStandalone() && sessionStorage.getItem(IOS_INSTALL_DISMISSED_KEY) !== 'true',
    );

    let stopUpdateChecks = () => undefined;
    if (import.meta.env.PROD) {
      const update = registerSW({
        onNeedRefresh() {
          setUpdateAvailable(true);
        },
        onOfflineReady() {
          setOfflineReady(true);
        },
        onRegisteredSW(_serviceWorkerUrl, registration) {
          if (!registration) return;
          const checkForUpdate = () => {
            if (navigator.onLine && document.visibilityState === 'visible') void registration.update();
          };
          window.addEventListener('focus', checkForUpdate);
          document.addEventListener('visibilitychange', checkForUpdate);
          stopUpdateChecks = () => {
            window.removeEventListener('focus', checkForUpdate);
            document.removeEventListener('visibilitychange', checkForUpdate);
          };
        },
        onRegisterError(error) {
          console.error('ลงทะเบียน PWA service worker ไม่สำเร็จ', error);
        },
      });
      setUpdateServiceWorker(() => update);
    }

    return () => {
      stopUpdateChecks();
      window.removeEventListener('ice-delivery-draft-state', onDraftState);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const installApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const dismissIosInstallHelp = () => {
    sessionStorage.setItem(IOS_INSTALL_DISMISSED_KEY, 'true');
    setShowIosInstallHelp(false);
  };

  if (!isOnline) {
    return (
      <aside className="pwa-update-prompt pwa-update-prompt--offline" role="status" aria-live="assertive">
        <strong>กำลังใช้งานแบบออฟไลน์</strong>
        <span>เปิดดูหน้าที่เคยโหลดได้ แต่ต้องเชื่อมต่ออินเทอร์เน็ตก่อนบันทึกข้อมูล</span>
      </aside>
    );
  }

  if (updateAvailable) {
    return (
      <aside className="pwa-update-prompt" role="status" aria-live="polite">
        <strong>มีเวอร์ชันใหม่พร้อมใช้งาน</strong>
        {hasDraft ? <span>บันทึกหรือยกเลิกงานค้างก่อนอัปเดต</span> : null}
        <div className="pwa-update-prompt__actions">
          <button disabled={hasDraft || !updateServiceWorker} onClick={() => void requestPwaUpdate(updateServiceWorker)} type="button">
            อัปเดตตอนนี้
          </button>
        </div>
      </aside>
    );
  }

  if (installPrompt) {
    return (
      <aside className="pwa-update-prompt" role="status" aria-live="polite">
        <strong>ติดตั้งแอปส่งน้ำแข็ง</strong>
        <span>เปิดใช้งานจากหน้าจอหลักได้รวดเร็วและเปิดหน้าที่โหลดไว้ได้เมื่อสัญญาณขาด</span>
        <div className="pwa-update-prompt__actions">
          <button className="pwa-update-prompt__secondary" onClick={() => setInstallPrompt(null)} type="button">ไว้ภายหลัง</button>
          <button onClick={() => void installApp()} type="button">ติดตั้ง</button>
        </div>
      </aside>
    );
  }

  if (showIosInstallHelp) {
    return (
      <aside className="pwa-update-prompt" role="status" aria-live="polite">
        <strong>เพิ่มแอปลงหน้าจอโฮม</strong>
        <span>แตะปุ่มแชร์ใน Safari แล้วเลือก “เพิ่มไปยังหน้าจอโฮม”</span>
        <div className="pwa-update-prompt__actions">
          <button onClick={dismissIosInstallHelp} type="button">เข้าใจแล้ว</button>
        </div>
      </aside>
    );
  }

  if (!offlineReady) return null;
  return (
    <aside className="pwa-update-prompt pwa-update-prompt--ready" role="status" aria-live="polite">
      <strong>แอปพร้อมใช้งานออฟไลน์แล้ว</strong>
      <span>ครั้งถัดไปสามารถเปิดหน้าที่โหลดไว้ได้แม้สัญญาณขาด</span>
      <div className="pwa-update-prompt__actions">
        <button onClick={() => setOfflineReady(false)} type="button">รับทราบ</button>
      </div>
    </aside>
  );
}
