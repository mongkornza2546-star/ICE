import { uiDateTimeFormat, translateUi, useLanguage } from '../../../i18n';
import { FileText, Printer, Prohibit, X } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { printBillingStatement } from '../../../lib/billingStatementPrint';
import type { BillingStatement, ReceivableCharge } from '../types';
import { money } from '../utils';

const thaiDate = uiDateTimeFormat({ dateStyle: 'medium' });

function serviceDate(value: string) {
  return thaiDate.format(new Date(`${value}T12:00:00+07:00`));
}

export function BillingStatementsSection({
  busy,
  charges,
  serviceDate: currentServiceDate,
  statements,
  onCreate,
  onVoid,
}: {
  busy: boolean;
  charges: ReceivableCharge[];
  serviceDate: string;
  statements: BillingStatement[];
  onCreate: (chargeIds: string[]) => Promise<BillingStatement>;
  onVoid: (statement: BillingStatement, reason: string) => Promise<void>;
}) {
  useLanguage();
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeChargeIds = useMemo(() => new Set(statements
    .filter((statement) => statement.status === 'active')
    .flatMap((statement) => statement.items.map((item) => item.charge_id))), [statements]);
  const availableCharges = charges.filter((charge) => (
    Number(charge.outstanding_amount) > 0 && !activeChargeIds.has(charge.charge_id)
  ));
  const selected = new Set(selectedIds);
  const selectedTotal = availableCharges
    .filter((charge) => selected.has(charge.charge_id))
    .reduce((total, charge) => total + Number(charge.outstanding_amount), 0);

  const openEditor = () => {
    setSelectedIds(availableCharges
      .filter((charge) => charge.due_date <= currentServiceDate)
      .map((charge) => charge.charge_id));
    setError(null);
    setEditorOpen(true);
  };

  const create = async () => {
    if (selectedIds.length === 0) return;
    const printWindow = window.open('', '_blank', 'popup,width=900,height=720');
    setWorking(true);
    setError(null);
    try {
      const statement = await onCreate(selectedIds);
      setEditorOpen(false);
      printBillingStatement(statement, printWindow);
    } catch (createError) {
      printWindow?.close();
      setError(createError instanceof Error ? createError.message : 'ออกใบวางบิลไม่สำเร็จ');
    } finally {
      setWorking(false);
    }
  };

  const voidStatement = async (statement: BillingStatement) => {
    const reason = window.prompt(`เหตุผลที่ยกเลิก ${statement.statement_number}`)?.trim();
    if (!reason) return;
    setWorking(true);
    setError(null);
    try {
      await onVoid(statement, reason);
    } catch (voidError) {
      setError(voidError instanceof Error ? voidError.message : 'ยกเลิกใบวางบิลไม่สำเร็จ');
    } finally {
      setWorking(false);
    }
  };

  return <>
    <section className="credit-ar__drawer-section">
      <div className="credit-ar__drawer-section-title">
        <span><FileText size={18} /><h3>{translateUi('ใบวางบิล')}</h3></span>
        <button className="credit-ar__statement-create" disabled={busy || working || availableCharges.length === 0} onClick={openEditor} type="button">{translateUi('ออกใบวางบิล')}</button>
      </div>
      {error ? <p className="credit-ar__action-error" role="alert">{translateUi(error)}</p> : null}
      {statements.length === 0 ? <p className="financial-ops__empty">{translateUi('ยังไม่มีใบวางบิล')}</p> : <div className="credit-ar__statement-list">
        {statements.map((statement) => <article key={statement.id}>
          <span><strong>{statement.statement_number}</strong><small>{serviceDate(statement.issued_service_date)} · {statement.items.length}{translateUi(' บิล')}{statement.status === 'voided' ? translateUi(' · ยกเลิก: {0}', { 0: statement.void_reason ?? '—' }) : ''}</small></span>
          <span><b>{money.format(Number(statement.total_amount))}</b><small>{translateUi('คงเหลือ ')}{money.format(Number(statement.outstanding_amount))}</small></span>
          <button aria-label={translateUi('พิมพ์ {0}', { 0: statement.statement_number })} onClick={() => printBillingStatement(statement)} type="button"><Printer size={16} />{translateUi('พิมพ์')}</button>
          {statement.status === 'active' ? <button aria-label={translateUi('ยกเลิก {0}', { 0: statement.statement_number })} className="is-danger" disabled={working} onClick={() => void voidStatement(statement)} type="button"><Prohibit size={16} />{translateUi('ยกเลิก')}</button> : <em>{translateUi('ยกเลิกแล้ว')}</em>}
        </article>)}
      </div>}
    </section>

    {editorOpen ? <div className="modal-backdrop">
      <section aria-labelledby="billing-statement-editor-title" className="panel credit-ar__statement-editor" role="dialog">
        <div className="panel-header"><span><h2 id="billing-statement-editor-title">{translateUi('ออกใบวางบิล')}</h2><small>{translateUi('เลือกบิลที่ต้องการนำไปเก็บเงินในยอดเดียวกัน')}</small></span><button aria-label={translateUi('ปิดหน้าออกใบวางบิล')} className="ghost-button" onClick={() => setEditorOpen(false)} type="button"><X size={20} /></button></div>
        <div className="credit-ar__statement-actions"><button onClick={() => setSelectedIds(availableCharges.map((charge) => charge.charge_id))} type="button">{translateUi('เลือกทั้งหมด')}</button><button onClick={() => setSelectedIds(availableCharges.filter((charge) => charge.due_date <= currentServiceDate).map((charge) => charge.charge_id))} type="button">{translateUi('เฉพาะบิลถึงกำหนด')}</button><button onClick={() => setSelectedIds([])} type="button">{translateUi('ล้างการเลือก')}</button></div>
        <div className="credit-ar__statement-bills">
          {availableCharges.map((charge) => <label key={charge.charge_id}>
            <input checked={selected.has(charge.charge_id)} onChange={() => setSelectedIds((current) => current.includes(charge.charge_id) ? current.filter((id) => id !== charge.charge_id) : [...current, charge.charge_id])} type="checkbox" />
            <span><strong>{charge.charge_number}</strong><small>{translateUi('ส่ง ')}{serviceDate(charge.service_date)}{translateUi(' · ครบกำหนด ')}{serviceDate(charge.due_date)}{charge.due_date > currentServiceDate ? translateUi(' · นอกรอบเก็บเงิน') : ''}</small></span>
            <b>{money.format(Number(charge.outstanding_amount))}</b>
          </label>)}
        </div>
        <div className="credit-ar__statement-total"><span>{translateUi('เลือก ')}{selectedIds.length}{translateUi(' บิล')}</span><strong>{money.format(selectedTotal)}</strong></div>
        {error ? <p className="credit-ar__action-error" role="alert">{translateUi(error)}</p> : null}
        <div className="credit-ar__statement-footer"><button className="secondary-button" disabled={working} onClick={() => setEditorOpen(false)} type="button">{translateUi('ยกเลิก')}</button><button className="primary-button" disabled={working || selectedIds.length === 0} onClick={() => void create()} type="button"><Printer size={17} />{translateUi('ออกและพิมพ์ใบวางบิล')}</button></div>
      </section>
    </div> : null}
  </>;
}
