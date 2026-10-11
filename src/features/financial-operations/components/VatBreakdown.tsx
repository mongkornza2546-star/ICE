import { translateUi } from '../../../i18n';
import { money } from '../utils';

export function VatBreakdown({ subtotal, vat, total, rate, paid }: {
  subtotal: number; vat: number; total: number; rate?: number; paid?: number;
}) {
  return <dl className="vat-breakdown" aria-label={translateUi('รายละเอียด VAT')}>
    <div><dt>{translateUi('ค่าสินค้าก่อน VAT')}</dt><dd>{money.format(subtotal)}</dd></div>
    <div><dt>VAT{rate ? ` ${rate}%` : ''}</dt><dd>{money.format(vat)}</dd></div>
    <div><dt>{translateUi('ยอดรวมสุทธิ')}</dt><dd>{money.format(total)}</dd></div>
    {paid != null && paid > 0 ? <>
      <div><dt>{translateUi('ชำระแล้ว')}</dt><dd>{money.format(paid)}</dd></div>
      <div><dt>{translateUi('คงเหลือ')}</dt><dd>{money.format(Math.max(total - paid, 0))}</dd></div>
    </> : null}
  </dl>;
}
