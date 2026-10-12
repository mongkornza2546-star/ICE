import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { FinancialOperations } from '../src/FinancialOperations';
import { HistoryReceiptModal } from '../src/features/financial-operations/components/HistoryReceiptModal';
import type { HistoryReceiptDetail } from '../src/features/financial-operations/types';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));

const receipt: HistoryReceiptDetail = {
  payment: {
    id: 'payment-1', receipt_number: 'REC2610-00572', payment_method: 'cash',
    received_amount: 300, allocated_amount: 300, change_amount: 0,
    recorded_at: '2026-10-09T08:06:00Z', status: 'active', void_reason: null,
    shops: { code: 'BB72', name: 'ร้านยอดชา' },
  },
  charges: [
    { chargeNumber: 'INV2610-00237', receivedAmount: 240, items: [{ name: 'หลอดเล็ก', quantity: 4, unit: 'ถุง', lineTotal: 240 }] },
    { chargeNumber: 'INV2610-00270', receivedAmount: 60, items: [{ name: 'หลอดเล็ก', quantity: 1, unit: 'ถุง', lineTotal: 60 }] },
  ],
  error: null,
};
const notice = 'บิลที่มีการรับชำระอยู่ยังยกเลิกใบส่งไม่ได้ หากบันทึกรับเงินผิด ให้ตรวจสอบและยกเลิกใบเสร็จที่ผิดก่อน';

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'get_payment_correction_targets') return { data: [{
      charge_id: 'charge-1', charge_number: 'INV2610-00237', delivery_event_id: 'delivery-1',
      payment_allocated_amount: 240, allocated_amount: 240, effective_amount: 240,
    }], error: null };
    if (name === 'get_payment_receipt_snapshot') return { data: {
      ...receipt.payment, payment_id: receipt.payment.id, shop_code: 'BB72', shop_name: 'ร้านยอดชา',
      charges: receipt.charges!.map((charge) => ({ charge_number: charge.chargeNumber,
        received_amount: charge.receivedAmount, items: charge.items.map((item) => ({
          ice_type_name: item.name, ice_type_unit: item.unit, quantity: item.quantity, line_total: item.lineTotal,
        })),
      })),
    }, error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  });
});

it.each(['admin', 'round_lead'] as const)('opens a paid receipt for %s without offering the blocked delivery cancellation', async (userRole) => {
  render(<FinancialOperations userRole={userRole} demoData={{
    serviceDate: '2026-10-09', queue: [], paymentHistory: [receipt.payment],
  }} />);
  fireEvent.click(screen.getByRole('tab', { name: /ประวัติรับเงิน/ }));
  fireEvent.click(screen.getByRole('button', { name: /เลือกรายการ.*ร้านยอดชา/ }));
  const dialog = screen.getByRole('dialog', { name: 'รายละเอียดใบเสร็จ REC2610-00572' });
  await within(dialog).findByText('หลอดเล็ก × 4 ถุง');
  expect(rpc).not.toHaveBeenCalledWith('get_payment_correction_targets', expect.anything());
  expect(within(dialog).queryByRole('button', { name: /ยกเลิกใบส่ง/ })).toBeNull();
  expect(within(dialog).getAllByText('INV2610-00237')).toHaveLength(1);
  expect(within(dialog).getAllByRole('region', { name: 'บิลที่ชำระ' })).toHaveLength(1);
  expect(within(dialog).getByText(notice)).toBeTruthy();
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
  fireEvent.click(within(dialog).getByRole('button', { name: 'ยกเลิกรายการ' }));
  expect(prompt).toHaveBeenCalledWith('เหตุผลที่ยกเลิกรับเงินจาก ร้านยอดชา');
  prompt.mockRestore();
});

it('keeps the authorized receipt-void action and print action available', () => {
  const onVoid = vi.fn();
  const onPrint = vi.fn();
  const view = render(<HistoryReceiptModal historyReceipt={receipt} busy={false} dialogRef={createRef()}
    closeButtonRef={createRef()} onClose={vi.fn()} onPrint={onPrint} onVoid={onVoid} />);
  fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกรายการ' }));
  fireEvent.click(screen.getByRole('button', { name: 'พิมพ์ซ้ำ' }));
  expect(onVoid).toHaveBeenCalledOnce();
  expect(onPrint).toHaveBeenCalledOnce();
  view.rerender(<HistoryReceiptModal historyReceipt={receipt} busy dialogRef={createRef()}
    closeButtonRef={createRef()} onClose={vi.fn()} onPrint={onPrint} onVoid={onVoid} />);
  expect(screen.getByRole('button', { name: 'ยกเลิกรายการ' }).hasAttribute('disabled')).toBe(true);
});

it('shows voided receipt history without cancellation guidance or a void action', () => {
  render(<HistoryReceiptModal historyReceipt={{ ...receipt, payment: {
    ...receipt.payment, status: 'voided', void_reason: 'บันทึกผิด',
  } }} busy={false} dialogRef={createRef()} closeButtonRef={createRef()} onClose={vi.fn()} onPrint={vi.fn()} />);
  expect(screen.getByRole('status').textContent).toContain('บันทึกผิด');
  expect(screen.queryByText(notice)).toBeNull();
  expect(screen.queryByRole('button', { name: 'ยกเลิกรายการ' })).toBeNull();
  expect(screen.getByText('หลอดเล็ก × 4 ถุง')).toBeTruthy();
});
