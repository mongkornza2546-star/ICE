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
  return (
    <>
      <div className="employee-success" role="status">
        <CheckCircle size={22} weight="fill" />
        <span id="aggregate-closed-title">
          {translateUi('ปิดสต๊อกรวมวันที่ ')}{summary.service_date}{translateUi(' แล้ว ยอดพร้อมใช้เป็นศูนย์')}
        </span>
      </div>
      {summary.closed_at ? <p className="muted">
        {translateUi('ข้อมูล ณ')} {uiDateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(summary.closed_at))}
      </p> : null}
      <div className="daily-stock-closed-list">
        {summary.items.map((item) => (
          <div className="daily-stock-closed-item" key={item.ice_type_id}>
            {renderImage?.(item)}
            <div>
              <p className="muted">
                {item.name}{translateUi(': นับจริง ')}{item.actual_quantity ?? '—'} {item.unit}
                {' · '}{translateUi('ส่วนต่าง ')}{Number(item.variance_quantity ?? 0) > 0 ? '+' : ''}
                {item.variance_quantity ?? '—'}
              </p>
              <p className="muted">
                {translateUi('ตามระบบ ')}{item.system_quantity ?? (
                  // Compatibility with servers before migration 0246. Never use the live balance.
                  item.actual_quantity != null && item.variance_quantity != null
                    ? Number(item.actual_quantity) - Number(item.variance_quantity) : '—'
                )} {item.unit}
              </p>
              {item.note ? <p className="muted">{item.note}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
