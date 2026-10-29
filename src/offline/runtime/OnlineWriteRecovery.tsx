import { useEffect, useState } from 'react';
import type { EmployeeDeliveryGateway } from '../../EmployeeDeliveryWorkspace';
import { translateUi } from '../../i18n';
import { getErrorMessage } from '../../lib/errorMessage';
import { offlineStore } from './client';
import { retryPendingOnlineWrite } from './onlineRecovery';
import type { OnlineWrite } from './store';

export function OnlineWriteRecovery({ owner, live, onResolved = () => window.location.reload() }: {
  owner: string; live: EmployeeDeliveryGateway; onResolved?: () => void;
}) {
  const [pending, setPending] = useState<OnlineWrite>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (typeof indexedDB === 'undefined') return;
    let active = true;
    const read = () => { void offlineStore().onlineWrite().then(value => { if (active) setPending(value); }).catch(() => {}); };
    read(); const timer = setInterval(read, 15_000);
    window.addEventListener('focus', read);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', read); };
  }, [owner]);
  if (pending?.ownerId && pending.ownerId !== owner) return <section className="employee-offline-status" role="status">
    {translateUi('เครื่องนี้มีรายการค้างของบัญชีอื่น กรุณาเข้าสู่ระบบด้วยบัญชีเจ้าของรายการ')}
  </section>;
  if (pending?.ownerId !== owner && !error) return null;
  const retry = async () => {
    setBusy(true); setError(null);
    try {
      await retryPendingOnlineWrite(owner, live);
      // Remount from current server data after clearing the old pending save.
      onResolved();
    } catch (failure) { setError(getErrorMessage(failure)); }
    finally { setBusy(false); setPending(await offlineStore().onlineWrite().catch(() => pending)); }
  };
  return <section className="employee-offline-status" aria-label={translateUi('ตรวจสอบรายการออนไลน์ค้าง')}>
    <p>{translateUi('มีรายการออนไลน์ยังไม่ทราบผล กรุณาตรวจสอบรายการเดิมก่อนทำงานต่อ')}</p>
    {error ? <p role="alert">{error}</p> : null}
    {pending?.ownerId === owner ? <button type="button" disabled={busy} onClick={() => { void retry(); }}>
      {translateUi(busy ? 'กำลังตรวจสอบรายการเดิม…' : 'ตรวจสอบรายการเดิมและโหลดข้อมูลใหม่')}
    </button> : null}
  </section>;
}
