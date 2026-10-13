import { useId } from 'react';
import { ChartBar, CreditCard, Receipt, TrendUp, Wallet, Coins, Calculator, ArrowSquareOut } from '@phosphor-icons/react';
import { translateUi } from '../../i18n';
import { toBangkokDateString } from '../../lib/serviceDate';
import { formatReportDate } from './reportDates';
import { financialChange, financialReconciliation, missingFinancialData as missing, money } from './financialReport';
import type { DetailQuery, ExecutiveReport } from './types';

type Props = {
  report: ExecutiveReport;
  openDetail: (query: DetailQuery, label?: string, trigger?: HTMLElement) => void;
  onAnalyze: (target: string) => void;
};

export function FinancialOverview({ report, openDetail, onAnalyze }: Props) {
  const id = useId();
  const asOf = formatReportDate(toBangkokDateString(new Date(report.asOf)));
  const metrics = [
    { title: 'ยอดขายสุทธิ', value: report.sales, icon: ChartBar, note: report.financialVersion ? 'หลังปรับยอด · ไม่รวม VAT · รวมค่าเช่าถัง' : 'ข้อมูลเดิมรวม VAT · รอปรับฐานยอดขาย', previous: report.previousSales, metric: 'sales' as const },
    { title: 'กำไรจากการดำเนินงาน', value: null, icon: TrendUp, note: 'เหลือหลังหักต้นทุนและค่าใช้จ่าย', reason: missing.profit },
    { title: 'เงินรับจริง', value: report.receipts, icon: CreditCard, note: 'รับในช่วงนี้ รวมเก็บหนี้จากยอดขายเก่า', previous: report.previousReceipts, metric: 'receipts' as const },
    { title: 'ลูกหนี้ค้างชำระ', value: report.outstanding, icon: Receipt, note: `ยอด ณ ${asOf} · รวม VAT`, reason: missing.debtComparison, metric: 'debt' as const },
    { title: 'ต้นทุนขาย', value: null, icon: Coins, note: 'ต้นทุนของสินค้าที่ขายในช่วงนี้', reason: missing.cost },
    { title: 'กำไรขั้นต้น', value: null, icon: Calculator, note: 'ยอดขายสุทธิ − ต้นทุนขาย', reason: missing.cost },
    { title: 'ค่าใช้จ่ายดำเนินงาน', value: null, icon: Wallet, note: 'ค่าใช้จ่ายเพื่อดำเนินธุรกิจในช่วงนี้', reason: missing.expenses },
    { title: 'เงินจ่ายจริง', value: null, icon: ArrowSquareOut, note: 'เงินออกจากกิจการในช่วงนี้', reason: missing.payments, target: 'executive-cash' },
  ];
  return <section className="executive-business-overview" aria-label={translateUi('ภาพรวมธุรกิจ')}>
    <div className="executive-business-overview__heading"><div><h2>{translateUi('ภาพรวมการเงิน')}</h2>
      <p>{translateUi('ขายได้เท่าไร · เหลือกำไรเท่าไร · เงินอยู่ที่ไหน')}</p></div>
      <span className="executive-level">{translateUi('1 · ภาพรวม')}</span></div>
    <div className="executive-metrics executive-financial-metrics" aria-label={translateUi('ตัวเลขสำคัญ')}>
      {metrics.map(({ title, value, icon: Icon, note, reason, previous, metric, target }, index) => {
        const change = metric && metric !== 'debt' ? financialChange(value!, previous) : null;
        return <button key={title} className={`executive-metric${value === null ? ' executive-metric--unavailable' : ''}`}
          aria-label={translateUi(title)} aria-describedby={`${id}-${index}-value ${id}-${index}-note ${id}-${index}-change`} type="button" onClick={(event) => metric ? openDetail({ metric }, undefined, event.currentTarget) : onAnalyze(target ?? 'executive-profit')}>
          <span className="executive-metric__heading"><Icon size={20} aria-hidden="true" />{translateUi(title)}</span>
          <strong id={`${id}-${index}-value`}>{value === null ? translateUi('ยังคำนวณไม่ได้') : money(value)}</strong>
          <small id={`${id}-${index}-note`}>{translateUi(note)}</small>
          {change ? <small id={`${id}-${index}-change`} className={`executive-change executive-change--${change.tone}`}>{translateUi(change.text)}</small> : <small id={`${id}-${index}-change`}>{translateUi(reason!)}</small>}
          <span className="executive-metric__action">{translateUi(value === null ? 'ดูข้อมูลที่ขาด ›' : 'ดูที่มาของตัวเลข ›')}</span>
        </button>;
      })}
    </div>
    {!financialReconciliation(report) ? <p className="executive-error" role="alert">{translateUi('ยอดสรุปบางส่วนไม่ตรงกับข้อมูลแยกย่อย กรุณารีเฟรชและตรวจรายการก่อนใช้ตัดสินใจ')}</p> : null}
  </section>;
}

export function FinancialAnalysis({ report, openDetail }: Omit<Props, 'onAnalyze'>) {
  return <>
    <section className="executive-panel executive-report__stack" id="executive-profit" aria-label={translateUi('กำไรมาจากไหน')}>
      <div className="executive-panel__head"><div><h2>{translateUi('กำไรมาจากไหน')}</h2><p>{translateUi('แยกยอดขาย ต้นทุน และค่าใช้จ่าย ก่อนสรุปกำไร')}</p></div><span className="executive-level">{translateUi('2 · วิเคราะห์สาเหตุ')}</span></div>
      <ol className="executive-profit-bridge">
        <li><span>{translateUi('ยอดขายสุทธิ')}</span><button className="executive-table-link" onClick={(event) => openDetail({ metric: 'sales' }, undefined, event.currentTarget)} type="button">{money(report.sales)} ›</button><small>{translateUi(report.financialVersion ? 'ไม่รวม VAT' : 'ข้อมูลเดิมรวม VAT')}</small></li>
        <li><span>{translateUi('− ต้นทุนขาย')}</span><strong>{translateUi('ยังคำนวณไม่ได้')}</strong></li>
        <li className="executive-profit-bridge__result"><span>{translateUi('= กำไรขั้นต้น')}</span><strong>{translateUi('ยังคำนวณไม่ได้')}</strong></li>
        <li><span>{translateUi('− ค่าใช้จ่ายดำเนินงาน')}</span><strong>{translateUi('ยังคำนวณไม่ได้')}</strong></li>
        <li className="executive-profit-bridge__result"><span>{translateUi('= กำไรจากการดำเนินงาน')}</span><strong>{translateUi('ยังคำนวณไม่ได้')}</strong></li>
      </ol>
      <div className="executive-financial-gap"><strong>{translateUi('ข้อมูลที่ต้องเติมเพื่อวิเคราะห์กำไร')}</strong>
        <p>{translateUi(missing.cost)} · {translateUi(missing.expenses)}</p>
        <p>{translateUi('ยังแยกยอด สัดส่วน และการเปลี่ยนแปลงตามหมวดไม่ได้ และยังระบุไม่ได้ว่าหมวดใดทำให้กำไรเพิ่มหรือลด')}</p></div>
      <p className="executive-panel-note">{translateUi('กำไรจากการดำเนินงานยังไม่หักดอกเบี้ยและภาษีเงินได้ จึงไม่ใช่กำไรสุทธิ')}</p>
    </section>
    <section className="executive-panel executive-report__stack" id="executive-cash" aria-label={translateUi('เงินสดอยู่ที่ไหน')}>
      <div><h2>{translateUi('เงินสดอยู่ที่ไหน')}</h2><p className="executive-panel-note">{translateUi('เงินรับและเงินจ่ายเป็นยอดเคลื่อนไหวในช่วงที่เลือก กำไรไม่เท่ากับกระแสเงินสด')}</p></div>
      <div className="executive-cash-grid">
        <div><span>{translateUi('เงินรับจริง')}</span><button className="executive-table-link" onClick={(event) => openDetail({ metric: 'receipts' }, undefined, event.currentTarget)} type="button">{money(report.receipts)} ›</button></div>
        <div><span>{translateUi('เงินจ่ายจริงทั้งหมด')}</span><strong>{translateUi('ยังคำนวณไม่ได้')}</strong><small>{translateUi(missing.payments)}</small></div>
        <div><span>{translateUi('กระแสเงินสดสุทธิ')}</span><strong>{translateUi('ยังคำนวณไม่ได้')}</strong><small>{translateUi('เงินรับจริง − เงินจ่ายจริงทั้งหมด')}</small></div>
      </div>
      <p className="executive-panel-note">{translateUi('ข้อมูลเงินออกที่มี: เงินคืนลูกค้า')} {money(report.refunds)} · {translateUi('เงินรับหลังหักเงินคืน')} {money(report.netReceipts)} {translateUi('ยังไม่ใช่กระแสเงินสดสุทธิของกิจการ')}</p>
      <div className="executive-financial-gap"><strong>{translateUi('เงินสดและเงินธนาคารคงเหลือ ณ')} {formatReportDate(toBangkokDateString(new Date(report.asOf)))}: {translateUi('ยังคำนวณไม่ได้')}</strong><p>{translateUi(missing.balance)}</p>
        <p>{translateUi('ช่องทางรับเงินบอกว่าเก็บเงินด้วยวิธีใด แต่ไม่ได้บอกยอดที่เหลือในแต่ละบัญชี')}</p></div>
    </section>
    <details className="executive-panel executive-methodology" id="executive-methodology"><summary>{translateUi('วิธีคำนวณและขอบเขตข้อมูล')}</summary>
      <ul>
        <li>{translateUi(report.financialVersion ? 'ยอดขาย = ยอดบิลที่มีผลหลังปรับปรุง − VAT ที่บันทึกไว้ในแต่ละบิล + ยอดขายหน้ารถ รวมค่าเช่าถัง ตามวันที่ขาย' : 'รายงานรุ่นเดิมยังรวม VAT ในยอดขาย ต้องอัปเดตฐานข้อมูลรายงานก่อนแสดงยอดขายไม่รวม VAT')}</li>
        <li>{translateUi('ส่วนลดและคืนสินค้าใช้ยอดปรับปรุงที่บันทึกและยังมีผล ไม่หักเงินคืนซ้ำจากยอดขาย ยกเลิกบิล/รายการส่งแล้วไม่นับเป็นยอดขาย')}</li>
        <li>{translateUi('เงินรับใช้ยอดรับชำระที่จัดสรรในรายการที่ยังมีผล ตามวันรับเงินจริงในเวลาไทย การขายหน้ารถที่ยกเลิกยังเก็บประวัติเงินรับ และหักเมื่อยืนยันคืนเงินจริง')}</li>
        <li>{translateUi('ลูกหนี้ = ยอดบิลรวม VAT หลังปรับปรุง − เงินชำระที่ยังมีผล ไม่น้อยกว่าศูนย์ เป็นยอดปัจจุบัน ณ เวลาอัปเดต ไม่ใช่ยอด ณ วันสิ้นช่วงที่เลือก')}</li>
        <li>{translateUi('อายุหนี้นับจากวันครบกำหนด หากไม่ระบุใช้วันที่ขายตามระบบเดิม ครบกำหนดวันนี้ยังไม่ถือว่าเกินกำหนด ไม่มีประวัติภาพยอดลูกหนี้จึงยังเปรียบเทียบย้อนหลังไม่ได้')}</li>
        <li>{translateUi('เปรียบเทียบกับช่วงก่อนหน้าที่ต่อเนื่องและมีจำนวนวันเท่ากัน ช่วงที่รวมวันนี้อาจยังรับข้อมูลไม่ครบวัน')}</li>
        <li>{translateUi('ตรวจยอดขายกับแนวโน้มและพื้นที่ เงินรับกับช่องทาง และลูกหนี้กับอายุหนี้ ก่อนส่งออกจะตรวจยอดรวมกับรายการทั้งหมดอีกครั้ง')}</li>
      </ul>
    </details>
  </>;
}
