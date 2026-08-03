import { CaretRight, Coins, CreditCard, Printer, type Icon } from '@phosphor-icons/react';
import type { Approval, PaymentHistoryItem, Receivable } from '../types';
import { money, paymentMethodLabel, receiptDateTime } from '../utils';

function SectionTitle({
  icon: Icon,
  title,
  description,
}: {
  icon: Icon;
  title: string;
  description: string;
}) {
  return (
    <div className="financial-ops__title">
      <div><Icon /><span><h2>{title}</h2><p>{description}</p></span></div>
    </div>
  );
}

export function ManagerFinancialSections({
  approvals,
  receivables,
  busy,
  onDecide,
}: {
  approvals: Approval[];
  receivables: Receivable[];
  busy: boolean;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => void;
}) {
  return (
    <>
      <section className="financial-ops__section">
        <SectionTitle icon={CreditCard} title="คำขออนุมัติ" description="วงเงินเครดิตและยอดค้าง" />
        {approvals.length === 0 ? <p className="financial-ops__empty">ไม่มีคำขอรออนุมัติ</p> : (
          <div className="financial-ops__cards">
            {approvals.map((approval) => (
              <article key={approval.id}>
                <strong>{approval.shops?.code} · {approval.shops?.name}</strong>
                <span>{approval.kind === 'credit_limit' ? 'เกินวงเงินเครดิต' : 'ขอค้างชำระ'} · {money.format(approval.requested_amount)}</span>
                <p>{approval.reason}</p>
                <small>ผู้ขอ {approval.users?.display_name ?? '—'}</small>
                <div><button disabled={busy} onClick={() => onDecide(approval.id, 'rejected')} type="button">ไม่อนุมัติ</button><button disabled={busy} onClick={() => onDecide(approval.id, 'approved')} type="button">อนุมัติ</button></div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="financial-ops__section">
        <SectionTitle icon={CreditCard} title="ลูกหนี้เครดิต" description="ยอดคงค้างและวันครบกำหนด" />
        {receivables.length === 0 ? <p className="financial-ops__empty">ไม่มีลูกหนี้เครดิตคงค้าง</p> : (
          <div className="financial-ops__list">
            {receivables.map((item) => (
              <div key={item.shop_id}>
                <span><strong>{item.shop_code} · {item.shop_name}</strong><small>ครบกำหนดเก่าสุด {item.oldest_due_date}{item.overdue_amount > 0 ? ` · เกินกำหนด ${money.format(item.overdue_amount)}` : ''}</small></span>
                <b>{money.format(item.outstanding_amount)}</b>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export function PaymentHistorySection({
  paymentHistory,
  isManager,
  busy,
  onOpenReceipt,
  onPrintReceipt,
  onVoidPayment,
}: {
  paymentHistory: PaymentHistoryItem[];
  isManager: boolean;
  busy: boolean;
  onOpenReceipt: (payment: PaymentHistoryItem, trigger: HTMLButtonElement) => void;
  onPrintReceipt: (payment: PaymentHistoryItem) => void;
  onVoidPayment: (payment: PaymentHistoryItem) => void;
}) {
  return (
    <section className="financial-ops__section">
      <SectionTitle
        icon={Coins}
        title="ประวัติรับเงินล่าสุด"
        description={`พิมพ์ใบเสร็จซ้ำจากข้อมูลเดิม${isManager ? ' หรือตรวจสอบรายการที่บันทึกผิด' : ''}`}
      />
      {paymentHistory.length === 0 ? <p className="financial-ops__empty">ยังไม่มีรายการรับเงิน</p> : (
        <div className="financial-ops__list">
          {paymentHistory.map((payment) => (
            <article className="financial-ops__history-item" key={payment.id}>
              <button
                aria-label={`ดูบิล ${payment.receipt_number} ของ ${payment.shops?.name ?? 'ร้านค้า'}`}
                className="financial-ops__history-summary"
                onClick={(event) => onOpenReceipt(payment, event.currentTarget)}
                type="button"
              >
                <span>
                  <strong>{payment.shops?.code ?? '—'} · {payment.shops?.name ?? 'ไม่พบร้าน'}</strong>
                  <small>{payment.receipt_number} · {paymentMethodLabel(payment.payment_method)} · {receiptDateTime.format(new Date(payment.recorded_at))}{payment.status === 'voided' ? ` · ยกเลิก: ${payment.void_reason ?? '—'}` : ''}</small>
                </span>
                <span className="financial-ops__history-open-label">ดูบิล <CaretRight aria-hidden="true" size={19} /></span>
              </button>
              <span className="financial-ops__history-side">
                <b>{money.format(payment.allocated_amount)}</b>
                {payment.status === 'active' ? (
                  <span className="financial-ops__history-actions">
                    <button disabled={busy} onClick={() => onPrintReceipt(payment)} type="button"><Printer aria-hidden="true" size={16} />พิมพ์ซ้ำ</button>
                    {isManager ? <button disabled={busy} onClick={() => onVoidPayment(payment)} type="button">ยกเลิกรายการ</button> : null}
                  </span>
                ) : null}
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
