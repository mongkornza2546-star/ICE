import type { ReactNode } from 'react';
import { CheckCircle } from '@phosphor-icons/react';
import { translateUi, uiDateTimeFormat, useLanguage } from '../../../i18n';

export interface AggregateItem {
  ice_type_id: string;
  code: string;
  name: string;
  unit: string;
  ordered_quantity?: number;
  sold_quantity?: number;
  damaged_quantity?: number;
  returned_quantity?: number;
  available_quantity: number;
  system_quantity?: number | null;
  actual_quantity?: number | null;
  variance_quantity?: number | null;
  note?: string | null;
}

export interface AggregateSummary {
  service_date: string;
  status: 'open' | 'closed';
  closed_at?: string | null;
  items: AggregateItem[];
}

export function DailyAggregateStockSnapshot({ summary, renderImage }: {
  summary: AggregateSummary;
  renderImage?: (item: AggregateItem) => ReactNode;
}) {
  useLanguage();
  const matched = summary.items.filter((item) => item.variance_quantity != null && Number(item.variance_quantity) === 0).length;
  const different = summary.items.filter((item) => item.variance_quantity != null && Number(item.variance_quantity) !== 0).length;
  return (
    <div className="daily-stock-snapshot">
      <div className="daily-stock-snapshot__status" role="status">
        <CheckCircle size={22} weight="fill" aria-hidden="true" />
        <div>
          <strong id="aggregate-closed-title">
            {translateUi('ปิดสต๊อกรวมวันที่ ')}{summary.service_date}{translateUi(' แล้ว ยอดพร้อมใช้เป็นศูนย์')}
          </strong>
          {summary.closed_at ? <p>
            {translateUi('ข้อมูล ณ')} {uiDateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(summary.closed_at))}
          </p> : null}
        </div>
      </div>
      <div className="daily-stock-snapshot__summary">
        <span>{translateUi('ทั้งหมด')} <b>{summary.items.length}</b> {translateUi('ชนิด')}</span>
        <span className="daily-stock-snapshot__matched">{translateUi('ตรงยอด')} <b>{matched}</b></span>
        <span className={different ? 'daily-stock-snapshot__different' : ''}>{translateUi('มีส่วนต่าง')} <b>{different}</b></span>
      </div>
      {summary.items.length === 0 ? <p className="empty-text">{translateUi('ไม่มีรายการสต๊อก')}</p> : (
        <table className="daily-stock-snapshot__table" aria-label={translateUi('สรุปสต๊อกเมื่อปิดวัน')}>
          <thead><tr>
            <th scope="col">{translateUi('ชนิดน้ำแข็ง')}</th>
            <th scope="col">{translateUi('ตามระบบ')}</th>
            <th scope="col">{translateUi('นับจริง')}</th>
            <th scope="col">{translateUi('ส่วนต่าง')}</th>
          </tr></thead>
          <tbody>
            {summary.items.map((item) => {
              const variance = item.variance_quantity == null ? null : Number(item.variance_quantity);
              const state = variance == null ? 'unknown' : variance < 0 ? 'short' : variance > 0 ? 'over' : 'matched';
              const system = item.system_quantity ?? (
                // Compatibility with servers before migration 0246. Never use the live balance.
                item.actual_quantity != null && item.variance_quantity != null
                  ? Number(item.actual_quantity) - Number(item.variance_quantity) : null
              );
              return (
                <tr key={item.ice_type_id} className={`daily-stock-snapshot__row daily-stock-snapshot__row--${state}`}>
                  <th scope="row" className="daily-stock-snapshot__identity">
                    <div className="daily-stock-snapshot__product">
                      {renderImage?.(item)}
                      <div>
                        <strong>{item.name}</strong>
                        {item.note ? <p className="daily-stock-snapshot__note">{item.note}</p> : null}
                      </div>
                    </div>
                  </th>
                  <td data-label={translateUi('ตามระบบ')}>
                    <span>{formatQuantity(system)} <small>{item.unit}</small></span>
                  </td>
                  <td data-label={translateUi('นับจริง')} className="daily-stock-snapshot__actual">
                    <span>{formatQuantity(item.actual_quantity)} <small>{item.unit}</small></span>
                  </td>
                  <td data-label={translateUi('ส่วนต่าง')}>
                    <span className={`daily-stock-snapshot__variance daily-stock-snapshot__variance--${state}`}>
                      {variance == null ? '—' : variance === 0 ? translateUi('ตรงยอด') : (
                        <>{translateUi(variance < 0 ? 'ขาด' : 'เกิน')} {formatQuantity(Math.abs(variance))} <small>{item.unit}</small></>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatQuantity(value: number | null | undefined) {
  return value == null ? '—' : Number(value).toLocaleString('th-TH', { maximumFractionDigits: 3 });
}
