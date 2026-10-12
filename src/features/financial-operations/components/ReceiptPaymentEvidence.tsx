import { useEffect, useState } from 'react';
import { FileText } from '@phosphor-icons/react';
import { translateUi, useLanguage } from '../../../i18n';
import { getErrorMessage } from '../../../lib/errorMessage';
import { getStoredPaymentEvidence } from '../../../lib/paymentEvidence';

export function ReceiptPaymentEvidence({ paymentId }: { paymentId: string }) {
  useLanguage();
  const [evidence, setEvidence] = useState<Awaited<ReturnType<typeof getStoredPaymentEvidence>>>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEvidence(null);
    void getStoredPaymentEvidence(paymentId)
      .then((result) => { if (!cancelled) setEvidence(result); })
      .catch((loadError: unknown) => { if (!cancelled) setError(getErrorMessage(loadError)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [paymentId, attempt]);

  return (
    <section className="financial-ops__receipt-charges financial-ops__receipt-evidence" aria-label={translateUi('หลักฐานการชำระเงิน')}>
      <strong><FileText aria-hidden="true" size={18} />{translateUi('หลักฐานการชำระเงิน')}</strong>
      {loading ? <p role="status">{translateUi('กำลังโหลดสลิป...')}</p> : null}
      {!loading && !error && !evidence ? <p>{translateUi('รายการนี้ไม่มีสลิปแนบ')}</p> : null}
      {error ? <>
        <p className="employee-error" role="alert">{translateUi('โหลดสลิปไม่สำเร็จ: ')}{error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>{translateUi('ลองใหม่')}</button>
      </> : null}
      {evidence ? <>
        {evidence.isPdf ? <p>{translateUi('แนบไฟล์ PDF แล้ว')}</p> : !error ? (
          <a href={evidence.url} target="_blank" rel="noopener noreferrer" aria-label={translateUi('เปิดภาพสลิปขนาดเต็ม')}>
            <img src={evidence.url} alt={translateUi('สลิปการชำระเงิน')} onError={() => setError(translateUi('ไม่สามารถแสดงภาพสลิปได้'))} />
          </a>
        ) : null}
        <a className="financial-ops__receipt-evidence-link" href={evidence.url} target="_blank" rel="noopener noreferrer">{translateUi('ดูสลิป')}</a>
      </> : null}
    </section>
  );
}
