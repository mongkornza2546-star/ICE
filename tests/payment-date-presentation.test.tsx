import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { HistoryReceiptModal } from '../src/features/financial-operations/components/HistoryReceiptModal';
import { receiptFromSnapshot } from '../src/features/financial-operations/utils';
import { printSalesDocument, salesDocumentFromStored } from '../src/lib/salesDocumentPrint';
import { ReceiptPreview } from '../src/features/accounting/AccountingPresentation';

const snapshot = {
  payment_id: 'payment-1', receipt_number: 'REC2609-00001',
  document_type: 'REC' as const, document_number: 'REC2609-00001', document_title: 'ใบเสร็จรับเงิน',
  shop_code: 'S1', shop_name: 'ร้านทดสอบ', payment_method: 'bank_transfer' as const,
  received_amount: 100, allocated_amount: 100, change_amount: 0,
  recorded_at: '2026-09-30T00:00:00+07:00',
  received_date_override: '2026-09-30', entered_at: '2026-10-03T13:43:00+07:00',
  charges: [],
};

it('shows date-only receipt time and the actual Bangkok entry time in history', () => {
  render(<HistoryReceiptModal busy={false} dialogRef={createRef()} closeButtonRef={createRef()}
    onClose={vi.fn()} onPrint={vi.fn()} historyReceipt={{
      payment: { ...snapshot, id: snapshot.payment_id, status: 'active', void_reason: null, shops: null },
      charges: [], error: null,
    }} />);
  const received = screen.getByText('วันที่รับเงิน').parentElement!;
  expect(received.textContent).not.toContain('00:00');
  expect(screen.getByText('บันทึกเมื่อ').parentElement?.textContent).toContain('13:43');
});

it('carries date precision and entry time through the stored receipt adapter', () => {
  expect(receiptFromSnapshot(snapshot)).toMatchObject({
    receivedDate: '2026-09-30', enteredAt: snapshot.entered_at,
  });
});

it('keeps the accounting receipt preview consistent with history and printing', () => {
  const { container } = render(<ReceiptPreview receipt={snapshot} />);
  expect(screen.getByText('วันที่รับเงิน').parentElement?.textContent).toContain('30/09/2026');
  expect(screen.getByText('บันทึกเมื่อ').parentElement?.textContent).toContain('13:43');
  expect(container.textContent).not.toContain('00:00');
});

it('prints the received date without an invented time and preserves entry time', () => {
  const printDocument = document.implementation.createHTMLDocument();
  const printWindow = { document: printDocument, addEventListener: vi.fn(), close: vi.fn(),
    focus: vi.fn(), print: vi.fn() } as unknown as Window;
  printSalesDocument(salesDocumentFromStored(snapshot), printWindow);
  expect(printDocument.body.textContent).toContain('วันที่รับเงิน: 30/09/2026');
  expect(printDocument.body.textContent).toContain('บันทึกเมื่อ: 03/10/2026 13:43');
  expect(printDocument.body.textContent).not.toContain('00:00');
});
