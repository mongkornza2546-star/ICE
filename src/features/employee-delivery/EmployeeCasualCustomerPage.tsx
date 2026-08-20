import { useLayoutEffect, useRef } from 'react';
import { ArrowLeft, LockKey, Receipt, UserCircle } from '@phosphor-icons/react';
import type { DeliveryRound } from '../../types/app';

export function EmployeeCasualCustomerPage({
  onBack,
  round,
  serviceDateLabel,
}: {
  onBack: () => void;
  round: DeliveryRound;
  serviceDateLabel: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="employee-entry employee-casual-page">
      <button aria-label="กลับไปเลือกร้าน" className="employee-back" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={20} weight="bold" />
        <span>กลับไปเลือกร้าน</span>
      </button>

      <section className="employee-entry-card employee-casual-page__header">
        <span className="employee-casual-page__icon"><UserCircle aria-hidden="true" size={38} weight="duotone" /></span>
        <div>
          <p className="employee-eyebrow">บันทึกส่งน้ำแข็ง · POS</p>
          <h1 ref={headingRef} tabIndex={-1}>ลูกค้าขาจร</h1>
          <p>{round.name} · {serviceDateLabel}</p>
        </div>
      </section>

      <section aria-labelledby="casual-rollout-title" className="employee-entry-section employee-casual-page__status">
        <span className="employee-casual-page__status-icon"><LockKey aria-hidden="true" size={28} weight="duotone" /></span>
        <div>
          <p className="employee-eyebrow">สถานะระบบ</p>
          <h2 id="casual-rollout-title">ยังไม่เปิดรับรายการจริง</h2>
          <p>หน้านี้อยู่ใน POS ตามตำแหน่งที่ถูกต้องแล้ว การบันทึกจะเปิดหลังเชื่อมการรับเงิน ใบรับเงิน และการตัดสต๊อกแบบ atomic ครบถ้วน</p>
        </div>
      </section>

      <section className="employee-entry-section employee-casual-page__preview" aria-labelledby="casual-next-step-title">
        <Receipt aria-hidden="true" size={28} weight="duotone" />
        <div>
          <h2 id="casual-next-step-title">รายการที่จะเปิดในหน้านี้</h2>
          <p>ขายทันทีหรือแจกฟรี · เต็มถุง ครึ่งถุง หรือแบ่งขาย · รับเงินสด โอน หรือ QR · ออกและพิมพ์ใบรับเงิน</p>
        </div>
      </section>
    </div>
  );
}
