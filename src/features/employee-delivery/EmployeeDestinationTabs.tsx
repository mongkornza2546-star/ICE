import type { RefObject } from 'react';
import { translateUi, useLanguage } from '../../i18n';

export function EmployeeDestinationTabs({
  value,
  onChange,
  casualVisible = true,
  casualButtonRef,
  disabled = false,
}: {
  value: 'regular' | 'event' | 'casual';
  onChange: (kind: 'regular' | 'event' | 'casual') => void;
  casualVisible?: boolean;
  casualButtonRef?: RefObject<HTMLButtonElement>;
  disabled?: boolean;
}) {
  useLanguage();
  return (
    <nav aria-label={translateUi('ประเภทจุดส่ง')} className={`employee-destination-tabs${casualVisible ? '' : ' employee-destination-tabs--two'}`}>
      <button aria-pressed={value === 'regular'} disabled={disabled} onClick={() => onChange('regular')} type="button">{translateUi('ร้านประจำ')}</button>
      <button aria-pressed={value === 'event'} disabled={disabled} onClick={() => onChange('event')} type="button">{translateUi('อีเว้น')}</button>
      {casualVisible ? <button aria-label={translateUi('บันทึกลูกค้าขายสด')} aria-pressed={value === 'casual'} disabled={disabled} onClick={() => onChange('casual')} ref={casualButtonRef} type="button">{translateUi('ขายสด')}</button> : null}
    </nav>
  );
}
