import { CheckCircle, Info, Calendar } from '@phosphor-icons/react';
import type { DailyStockCloseState } from '../../../types/app';
import { uiDateTimeString, translateUi, useLanguage } from '../../../i18n';

interface StockCloseSummaryPanelProps {
  closeState: DailyStockCloseState;
}

export function StockCloseSummaryPanel({ closeState }: StockCloseSummaryPanelProps) {
  useLanguage();
  const isClosed = closeState.is_closed;

  return (
    <div className="stock-v2-panel stock-close-summary">
      <div className="stock-v2-panel__header">
        <div className="stock-v2-title-with-icon">
          <Calendar size={18} />
          <h3>{translateUi('สถานะการปิดสต๊อกประจำวัน')}</h3>
        </div>
        <span
          className={`status-badge ${
            isClosed
              ? 'status-badge--success'
              : 'status-badge--neutral'
          }`}
        >
          {isClosed ? translateUi('ปิดสต๊อกแล้ว') : translateUi('ยังไม่ปิดสต๊อก')}
        </span>
      </div>

      {isClosed ? (
        <div className="stock-close-summary__body">
          <div className="stock-close-summary__success">
            <CheckCircle size={18} weight="fill" />
            <div>
              <strong>{translateUi('ระบบปิดสต๊อกของวันนี้เรียบร้อยแล้ว')}</strong>
              <p>
                {translateUi('ปิดโดย: ')}<strong>{closeState.closed_by || translateUi('ระบบ')}</strong>{translateUi(' ณ')}{' '}
                {closeState.closed_at ? uiDateTimeString(new Date(closeState.closed_at)) : '-'}
              </p>
              {closeState.note && (
                <p>
                  {translateUi('หมายเหตุ: ')}{closeState.note}
                </p>
              )}
            </div>
          </div>

          <div>
            <h4>{translateUi('สรุปยอดนับจริงสิ้นวัน')}</h4>
            <div className="stock-close-summary__counts">
              {closeState.counts.length === 0 ? (
                <p className="empty-text">{translateUi('ไม่มีข้อมูลการนับจริง')}</p>
              ) : (
                closeState.counts.map((c, idx) => {
                  const hasVariance = c.variance_quantity !== 0;
                  return (
                    <div
                      key={`${c.location_id}-${c.ice_type_id}-${idx}`}
                      className="stock-close-summary__count"
                    >
                      <div>
                        <strong>{c.location_name}</strong>
                        <small>{c.ice_type_name}</small>
                      </div>
                      <div>
                        <strong>
                          {c.actual_quantity} {c.unit}
                        </strong>
                        <p
                          className={
                            hasVariance
                              ? c.variance_quantity > 0
                                ? 'success-text'
                                : 'error-text'
                              : 'muted'
                          }
                        >
                          {hasVariance
                            ? translateUi('ต่าง: {0}', { 0: c.variance_quantity > 0 ? `+${c.variance_quantity}` : c.variance_quantity })
                            : translateUi('ตรงกับระบบ')}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="stock-close-summary__pending">
          <Info size={18} weight="fill" />
          <div>
            <strong>{translateUi('รอการบันทึกผลการนับจริงและทำรายการปิดสต๊อกสิ้นวัน')}</strong>
            <p>
              {translateUi('*เมื่อปิดสต๊อกแล้ว ระบบจะรวบรวมน้ำแข็งคงเหลือจากทุกจุดโอนกลับไปที่รถบรรทุกหลัก และส่งยอดคืนโรงงานโดยอัตโนมัติ')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
