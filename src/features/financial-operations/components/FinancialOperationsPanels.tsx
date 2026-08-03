import { CalendarBlank, CaretRight, Coins, CreditCard, Printer, type Icon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { shiftServiceDate } from '../../../lib/serviceDate';
import type { Approval, DueDateRequest, PaymentHistoryItem, Receivable, ReceivableCharge } from '../types';
import { money, paymentMethodLabel, receiptDateTime } from '../utils';

function chargeStatus(charge: ReceivableCharge) {
  if (charge.payment_status === 'paid') return 'ชำระครบแล้ว';
  if (charge.due_status === 'overdue') return `เกินกำหนด ${charge.days_overdue} วัน${charge.payment_status === 'partial' ? ' · ชำระบางส่วน' : ''}`;
  if (charge.due_status === 'due_today') return charge.payment_status === 'partial' ? 'ครบกำหนดวันนี้ · ชำระบางส่วน' : 'ครบกำหนดวันนี้';
  return charge.payment_status === 'partial' ? 'ยังไม่ถึงกำหนด · ชำระบางส่วน' : 'ยังไม่ถึงกำหนด';
}

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
  dueDateRequests,
  receivables,
  busy,
  runId,
  onDecide,
  onDecideDueDateRequest,
  onToggleCreditCollectionAssignment,
}: {
  approvals: Approval[];
  dueDateRequests: DueDateRequest[];
  receivables: Receivable[];
  busy: boolean;
  runId: string | null;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => void;
  onDecideDueDateRequest: (requestId: string, decision: 'approved' | 'rejected') => void;
  onToggleCreditCollectionAssignment: (charge: ReceivableCharge, assigned: boolean) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<'all' | 'not_due' | 'due_today' | 'overdue' | 'partial' | 'paid'>('all');
  const [sortBy, setSortBy] = useState<'due_date' | 'outstanding'>('due_date');
  const charges = useMemo(() => receivables.flatMap((shop) => shop.charges.map((charge) => ({
    ...charge,
    shopCode: shop.shop_code,
    shopName: shop.shop_name,
  }))).filter((charge) => statusFilter === 'all'
    || charge.due_status === statusFilter
    || charge.payment_status === statusFilter).sort((left, right) => sortBy === 'outstanding'
    ? Number(right.outstanding_amount) - Number(left.outstanding_amount)
    : left.due_date.localeCompare(right.due_date)), [receivables, sortBy, statusFilter]);

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
        <SectionTitle icon={CreditCard} title="คำขอเลื่อนกำหนดชำระ" description="อนุมัติก่อนเปลี่ยนวันครบกำหนดจริง" />
        {dueDateRequests.length === 0 ? <p className="financial-ops__empty">ไม่มีคำขอเลื่อนกำหนดชำระ</p> : (
          <div className="financial-ops__cards">
            {dueDateRequests.map((request) => (
              <article key={request.id}>
                <strong>{request.shop_code} · {request.shop_name}</strong>
                <span>{request.charge_number} · {request.original_due_date} → {request.requested_due_date}</span>
                <p>{request.reason}</p><small>ผู้ขอ {request.requested_by}</small>
                <div><button disabled={busy} onClick={() => onDecideDueDateRequest(request.id, 'rejected')} type="button">ไม่อนุมัติ</button><button disabled={busy} onClick={() => onDecideDueDateRequest(request.id, 'approved')} type="button">อนุมัติ</button></div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="financial-ops__section">
        <SectionTitle icon={CreditCard} title="ลูกหนี้เครดิต" description="สถานะ ยอดคงค้าง และวันครบกำหนด" />
        {receivables.length === 0 ? <p className="financial-ops__empty">ไม่มีลูกหนี้เครดิตคงค้าง</p> : (
          <>
            <div className="financial-ops__receivable-controls">
              <label>สถานะ<select aria-label="กรองสถานะลูกหนี้" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">ทั้งหมด</option><option value="not_due">ยังไม่ถึงกำหนด</option><option value="due_today">ครบกำหนดวันนี้</option><option value="overdue">เกินกำหนด</option><option value="partial">ชำระบางส่วน</option><option value="paid">ชำระครบแล้ว</option></select></label>
              <label>เรียงตาม<select aria-label="เรียงลูกหนี้" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}><option value="due_date">วันครบกำหนด</option><option value="outstanding">ยอดค้าง</option></select></label>
            </div>
            <div className="financial-ops__list">
              {receivables.map((item) => (
                <div key={item.shop_id}>
                  <span><strong>{item.shop_code} · {item.shop_name}</strong><small>ยอดเกินกำหนด {money.format(item.overdue_amount)} · วงเงินคงเหลือ {item.available_credit_amount === null ? 'ไม่จำกัด' : money.format(item.available_credit_amount)}</small></span>
                  <b>{money.format(item.outstanding_amount)}</b>
                </div>
              ))}
            </div>
            <div className="financial-ops__receivable-charges">
              {charges.map((charge) => <article key={charge.charge_id}>
                <span><strong>{charge.shopCode} · {charge.charge_number}</strong><small>ครบกำหนด {charge.due_date} · {chargeStatus(charge)}</small></span>
                <b>{money.format(charge.outstanding_amount)}</b>
                {charge.payment_status !== 'paid' && charge.due_status !== 'not_due' ? <button
                  disabled={busy || !runId}
                  onClick={() => onToggleCreditCollectionAssignment(charge, !charge.assigned_collection_run_id)}
                  type="button"
                >{charge.assigned_collection_run_id ? 'ถอนจากรอบเก็บ' : 'มอบหมายให้เก็บ'}</button> : null}
              </article>)}
            </div>
          </>
        )}
      </section>
    </>
  );
}

export function PaymentHistorySection({
  paymentHistory,
  historyDate,
  serviceDate,
  isManager,
  busy,
  onHistoryDateChange,
  onOpenReceipt,
  onPrintReceipt,
  onVoidPayment,
}: {
  paymentHistory: PaymentHistoryItem[];
  historyDate: string;
  serviceDate: string;
  isManager: boolean;
  busy: boolean;
  onHistoryDateChange: (serviceDate: string) => void;
  onOpenReceipt: (payment: PaymentHistoryItem, trigger: HTMLButtonElement) => void;
  onPrintReceipt: (payment: PaymentHistoryItem) => void;
  onVoidPayment: (payment: PaymentHistoryItem) => void;
}) {
  return (
    <section className="financial-ops__section">
      <SectionTitle
        icon={Coins}
        title="ประวัติรับเงิน"
        description="เลือกวันที่เพื่อดูรายการย้อนหลังและพิมพ์ใบเสร็จซ้ำ"
      />
      <div className="financial-ops__history-date">
        <button onClick={() => onHistoryDateChange(shiftServiceDate(historyDate, -1))} type="button">‹ วันก่อนหน้า</button>
        <label><CalendarBlank aria-hidden="true" size={17} /><input
          aria-label="วันที่ประวัติรับเงิน"
          max={serviceDate}
          onChange={(event) => {
            if (event.target.value && event.target.value <= serviceDate) onHistoryDateChange(event.target.value);
          }}
          type="date"
          value={historyDate}
        /></label>
        <button disabled={historyDate >= serviceDate} onClick={() => onHistoryDateChange(shiftServiceDate(historyDate, 1))} type="button">วันถัดไป ›</button>
      </div>
      {paymentHistory.length === 0 ? <p className="financial-ops__empty">ไม่มีรายการรับเงินในวันที่เลือก</p> : (
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
