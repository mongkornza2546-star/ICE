import { translateUi, useLanguage } from '../../i18n';
import { accountingDateTime } from './AccountingPresentation';
import type { CashCloseReconciliation } from './types';

const money = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' });
const cents = (value: number) => Math.round(Number(value) * 100);
const amount = (value: number) => money.format(value / 100);
const signedAmount = (value: number) => `${value > 0 ? '+' : ''}${amount(value)}`;

export function CashReconciliationPanel({ data, error }: { data: CashCloseReconciliation | null; error: string | null }) {
  useLanguage();
  const employees = data?.employees ?? [];
  const complete = employees.length > 0 && employees.every((employee) => employee.actual_cash_amount != null);
  const expected = employees.reduce((sum, employee) => sum + cents(employee.expected_cash_amount), 0);
  const actual = complete ? employees.reduce((sum, employee) => sum + cents(employee.actual_cash_amount!), 0) : null;
  const differences = employees.filter((employee) => employee.actual_cash_amount != null)
    .map((employee) => cents(employee.actual_cash_amount!) - cents(employee.expected_cash_amount));
  const shortage = differences.reduce((sum, difference) => sum + Math.max(-difference, 0), 0);
  const surplus = differences.reduce((sum, difference) => sum + Math.max(difference, 0), 0);

  return <section className="accounting-cash-close" aria-labelledby="accounting-cash-close-title">
    <div className="accounting-cash-close__header">
      <h3 id="accounting-cash-close-title">{translateUi('เงินสดที่หัวหน้าได้รับจากพนักงาน')}</h3>
      {data && !error ? <span>{translateUi(complete ? 'บันทึกยอดนับเงินแล้ว' : 'ยังไม่บันทึกยอดนับเงิน')}</span> : null}
    </div>
    <p className="accounting-context-note">{translateUi('เทียบเงินสดที่พนักงานควรส่งตามระบบกับยอดที่หัวหน้าตรวจนับและยืนยันปิดยอดแล้ว รวมเงินสดร้านประจำและลูกค้าขาจร หลังหักเงินทอนและเงินสดที่พนักงานคืน ไม่รวมโอน/QR และเงินที่หัวหน้ารับหรือคืนเอง')}</p>
    {error || !data ? <p className="accounting-error" role="alert">{translateUi('โหลดข้อมูลยอดนับเงินไม่สำเร็จ กรุณากดรีเฟรช')}{error ? ` · ${error}` : ''}</p> : <>
      {!data.feature_enabled ? <p className="accounting-context-note">{translateUi('วันที่นี้ยังไม่เปิดใช้การบันทึกยอดนับเงิน')}</p> : null}
      {!complete && data.feature_enabled ? <p className="accounting-context-note">{translateUi('ยอดนับจริงจะแสดงเมื่อหัวหน้ากดยืนยันปิดยอดสต๊อกและเงินสดแล้ว ช่องว่างหมายถึงยังไม่มีการบันทึก')}</p> : null}
      <dl className="accounting-cash-close__totals">
        <div><dt>{translateUi('เงินสดควรส่งตามระบบ')}</dt><dd>{amount(expected)}</dd></div>
        <div><dt>{translateUi('หัวหน้าได้รับจริงตามยอดนับ')}</dt><dd>{actual == null ? '—' : amount(actual)}</dd></div>
        <div><dt>{translateUi('ส่วนต่างสุทธิ (นับจริง − ควรส่ง)')}</dt><dd>{actual == null ? '—' : signedAmount(actual - expected)}</dd></div>
      </dl>
      {complete ? <p className="accounting-context-note">{translateUi('เงินขาดรวม ')}<strong>{amount(shortage)}</strong>{translateUi(' · เงินเกินรวม ')}<strong>{amount(surplus)}</strong>{translateUi(' · ตรวจส่วนต่างของแต่ละคนได้ในตาราง')}</p> : null}
      <div className="accounting-table-wrap">
        <table className="accounting-table accounting-cash-close__table" aria-label={translateUi('เทียบยอดเงินสดรายพนักงาน')}>
          <thead><tr>{['พนักงาน', 'ควรส่งตามระบบ', 'หัวหน้านับจริง', 'ส่วนต่าง', 'สถานะ', 'เหตุผลส่วนต่าง', 'เวลาบันทึกยอดนับ'].map((label) => <th scope="col" key={label}>{translateUi(label)}</th>)}</tr></thead>
          <tbody>{employees.length ? employees.map((employee) => {
            const counted = employee.actual_cash_amount != null;
            const difference = counted ? cents(employee.actual_cash_amount!) - cents(employee.expected_cash_amount) : null;
            return <tr key={employee.employee_id} className={difference ? 'accounting-row--issue' : ''}>
              <th scope="row">{employee.employee_name}{!employee.is_active ? <small>{translateUi('พนักงานที่ยกเลิกแล้ว')}</small> : null}</th>
              <td>{money.format(Number(employee.expected_cash_amount))}</td>
              <td>{counted ? money.format(Number(employee.actual_cash_amount)) : '—'}</td>
              <td>{difference == null ? '—' : signedAmount(difference)}</td>
              <td>{translateUi(difference == null ? 'ยังไม่บันทึกยอดนับเงิน' : difference < 0 ? 'เงินขาด' : difference > 0 ? 'เงินเกิน' : 'ตรงยอด')}</td>
              <td>{employee.cash_reason || '—'}</td>
              <td>{employee.recorded_at ? accountingDateTime(employee.recorded_at) : '—'}</td>
            </tr>;
          }) : <tr><td colSpan={7}>{translateUi('ไม่มีรายการเงินสดรายพนักงานในวันนี้')}</td></tr>}</tbody>
        </table>
      </div>
    </>}
  </section>;
}
