import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeCasualCustomerPage } from '../src/features/employee-delivery/EmployeeCasualCustomerPage';
import type { CasualTransactionContext, CasualTransactionHistoryItem } from '../src/types/app';

function setup(historyCount = 1, extra: Partial<CasualTransactionContext> = {}) {
  const historyRead = vi.fn();
  const history: CasualTransactionHistoryItem[] = Array.from({ length: historyCount }, (_, index) => ({
    id: `sale-${index}`, ice_type_id: 'ice', ice_type_name: 'หลอดเล็ก', ice_type_unit: 'ถุง',
    fulfillment_mode: 'loose', quantity: null, transaction_kind: 'paid', sale_amount: 21,
    payment_method: 'cash', received_amount: 21, change_amount: 0, receipt_number: null,
    status: 'active', voided_at: null, void_reason: null, note: null,
    get recorded_at() { historyRead(); return '2026-10-12T12:00:00Z'; },
  }));
  const context: CasualTransactionContext = {
    round_id: 'round-1', service_date: '2026-10-12', round_status: 'open', stock_closed: false,
    stock_source: { id: 'holding', code: 'holding', name: 'จุดถือครอง' },
    items: [{ ice_type_id: 'ice', code: 'ice', name: 'หลอดเล็ก', unit: 'ถุง', available_quantity: 36.5 }],
    history, ...extra,
  };
  const loadContext = vi.fn().mockResolvedValue(context);
  const voidTransaction = vi.fn().mockResolvedValue({});
  const uploadEvidence = vi.fn().mockResolvedValue('refund/evidence.png');
  const deleteEvidence = vi.fn().mockResolvedValue(undefined);
  const onDraftStateChange = vi.fn();
  render(<EmployeeCasualCustomerPage
    round={{ id: 'round-1', name: 'งานประจำวัน', service_date: '2026-10-12', round_type: 'daily', status: 'open', opened_at: '2026-10-12T00:00:00Z' }}
    serviceDateLabel="12 ต.ค. 2026" loadContext={loadContext}
    recordTransaction={vi.fn()} deleteEvidence={deleteEvidence} loadReceipt={vi.fn().mockResolvedValue(null)}
    onBack={vi.fn()} onDraftStateChange={onDraftStateChange}
    uploadEvidence={uploadEvidence} voidTransaction={voidTransaction}
  />);
  return { user: userEvent.setup(), context, historyRead, loadContext, voidTransaction, uploadEvidence, deleteEvidence, onDraftStateChange };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'ประวัติวันนี้' });
  await user.click(screen.getAllByRole('button', { name: 'ยกเลิก', exact: true })[0]);
  return within(screen.getByRole('dialog', { name: 'ยกเลิกรายการขายสด' }));
}

describe('casual cancellation input', () => {
  it('keeps Thai typing local to the dialog with a long daily history', async () => {
    const { user, historyRead, loadContext, onDraftStateChange } = setup(200);
    const dialog = await openDialog(user);
    const reason = dialog.getByRole('textbox', { name: 'เหตุผลการยกเลิก' });
    historyRead.mockClear();
    onDraftStateChange.mockClear();
    await user.type(reason, 'ลงรายการผิด');
    expect((reason as HTMLTextAreaElement).value).toBe('ลงรายการผิด');
    expect(document.activeElement).toBe(reason);
    expect(dialog.getByRole('textbox', { name: 'เหตุผลการยกเลิก' })).toBe(reason);
    expect(loadContext).toHaveBeenCalledTimes(1);
    expect(onDraftStateChange).not.toHaveBeenCalled();
    await user.type(dialog.getByRole('textbox', { name: 'เลขอ้างอิงการคืน (ไม่บังคับ)' }), 'REF-21');
    // Each keystroke must not reformat/reconcile every receipt behind the modal.
    expect(historyRead.mock.calls.length).toBe(0);
  });

  it('submits the latest Thai reason and refreshes after a cash refund', async () => {
    const { user, voidTransaction, loadContext } = setup();
    const dialog = await openDialog(user);
    const reason = dialog.getByRole('textbox', { name: 'เหตุผลการยกเลิก' });
    fireEvent.compositionStart(reason);
    fireEvent.change(reason, { target: { value: 'ลงรายการผิด' } });
    fireEvent.compositionEnd(reason, { data: 'ลงรายการผิด' });
    await user.click(dialog.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await waitFor(() => expect(voidTransaction).toHaveBeenCalledWith({
      transactionId: 'sale-0', reason: 'ลงรายการผิด', refundMethod: 'cash',
      referenceNumber: null, evidencePath: null, idempotencyKey: expect.any(String),
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(loadContext).toHaveBeenCalledTimes(2);
  });

  it('keeps refund inputs on failure and retries with the same request and evidence', async () => {
    const { user, voidTransaction, uploadEvidence } = setup();
    voidTransaction.mockRejectedValueOnce(new Error('ลองใหม่'));
    const dialog = await openDialog(user);
    const confirm = dialog.getByRole('button', { name: 'ยืนยันยกเลิก' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(dialog.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }), ' คืนสินค้า ');
    await user.click(dialog.getByRole('button', { name: 'คืนโอนเงิน' }));
    await user.type(dialog.getByRole('textbox', { name: 'เลขอ้างอิงการคืน (ไม่บังคับ)' }), 'REF-21');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const evidence = new File(['refund'], 'refund.png', { type: 'image/png' });
    await user.upload(dialog.getByLabelText('หลักฐานการคืนเงิน'), evidence);
    await user.click(confirm);
    await screen.findByText('ลองใหม่');
    expect((dialog.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }) as HTMLTextAreaElement).value).toBe(' คืนสินค้า ');
    expect(voidTransaction).toHaveBeenCalledWith({
      transactionId: 'sale-0', reason: 'คืนสินค้า', refundMethod: 'bank_transfer',
      referenceNumber: 'REF-21', evidencePath: 'refund/evidence.png', idempotencyKey: expect.any(String),
    });
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(voidTransaction).toHaveBeenCalledTimes(2);
    expect(voidTransaction.mock.calls[1][0]).toEqual(voidTransaction.mock.calls[0][0]);
    expect(uploadEvidence).toHaveBeenCalledTimes(1);
  });

  it('discards the closed dialog draft and reports the page clean', async () => {
    const { user, onDraftStateChange, voidTransaction } = setup(2);
    const dialog = await openDialog(user);
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: true, submitting: false });
    await user.type(dialog.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }), 'รายการแรก');
    await user.click(dialog.getByRole('button', { name: 'คืนโอนเงิน' }));
    await user.type(dialog.getByRole('textbox', { name: 'เลขอ้างอิงการคืน (ไม่บังคับ)' }), 'REF-21');
    await user.click(dialog.getByRole('button', { name: 'กลับ', exact: true }));
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, submitting: false });
    await user.click(screen.getAllByRole('button', { name: 'ยกเลิก', exact: true })[1]);
    const next = within(screen.getByRole('dialog'));
    expect((next.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }) as HTMLTextAreaElement).value).toBe('');
    expect((next.getByRole('textbox', { name: 'เลขอ้างอิงการคืน (ไม่บังคับ)' }) as HTMLInputElement).value).toBe('');
    expect(next.queryByLabelText('หลักฐานการคืนเงิน')).toBeNull();
    expect(voidTransaction).not.toHaveBeenCalled();
  });

  it.each(['cash', 'bank_transfer'] as const)('recovers a committed %s refund after a lost response and reopening', async (method) => {
    const { user, voidTransaction, uploadEvidence, onDraftStateChange, historyRead } = setup();
    let committedRequest: unknown;
    voidTransaction.mockImplementation(async (payload) => {
      if (!committedRequest) {
        committedRequest = payload;
        throw new Error('Failed to fetch');
      }
      // The server only replays a committed void with its original key and payload.
      if (JSON.stringify(payload) !== JSON.stringify(committedRequest)) {
        throw new Error('The casual transaction is already voided');
      }
      return {};
    });
    const dialog = await openDialog(user);
    await user.type(dialog.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }), 'คืนสินค้า');
    await user.type(dialog.getByRole('textbox', { name: 'เลขอ้างอิงการคืน (ไม่บังคับ)' }), 'REF-21');
    if (method === 'bank_transfer') {
      await user.click(dialog.getByRole('button', { name: 'คืนโอนเงิน' }));
      await user.upload(dialog.getByLabelText('หลักฐานการคืนเงิน'), new File(['refund'], 'refund.png', { type: 'image/png' }));
    }
    await user.click(dialog.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await screen.findByText('Failed to fetch');
    await user.click(dialog.getByRole('button', { name: 'กลับ', exact: true }));
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: true, submitting: false });
    const reopened = await openDialog(user);
    const reason = reopened.getByRole('textbox', { name: 'เหตุผลการยกเลิก' });
    expect((reason as HTMLTextAreaElement).value).toBe('คืนสินค้า');
    expect((reopened.getByRole('textbox', { name: 'เลขอ้างอิงการคืน (ไม่บังคับ)' }) as HTMLInputElement).value).toBe('REF-21');
    expect(reopened.getByRole('button', { name: method === 'cash' ? 'คืนเงินสด' : 'คืนโอนเงิน' }).className).toBe('is-selected');
    if (method === 'bank_transfer') expect(reopened.getByText('refund.png')).toBeTruthy();
    historyRead.mockClear();
    await user.type(reason, ' ');
    expect(historyRead.mock.calls.length).toBe(0);
    await user.click(reopened.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(voidTransaction).toHaveBeenCalledTimes(2);
    expect(voidTransaction.mock.calls[1][0]).toEqual(committedRequest);
    expect(uploadEvidence).toHaveBeenCalledTimes(method === 'cash' ? 0 : 1);
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, submitting: false });
  });

  it.each([false, true])('keeps retries separate and reconciles confirmed refunds on refresh (confirmed: %s)', async (confirmed) => {
    const { user, context, loadContext, voidTransaction, uploadEvidence, deleteEvidence, onDraftStateChange } = setup(2);
    voidTransaction.mockRejectedValueOnce(new Error('Failed to fetch'));
    const first = await openDialog(user);
    await user.type(first.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }), 'คืนสินค้า');
    await user.click(first.getByRole('button', { name: 'คืนโอนเงิน' }));
    await user.upload(first.getByLabelText('หลักฐานการคืนเงิน'), new File(['refund'], 'refund.png', { type: 'image/png' }));
    await user.click(first.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await screen.findByText('Failed to fetch');
    await user.click(first.getByRole('button', { name: 'กลับ', exact: true }));

    await user.click(screen.getAllByRole('button', { name: 'ยกเลิก', exact: true })[1]);
    const second = within(screen.getByRole('dialog'));
    expect((second.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }) as HTMLTextAreaElement).value).toBe('');
    expect(second.queryByLabelText('หลักฐานการคืนเงิน')).toBeNull();
    await user.type(second.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }), 'รายการที่สอง');
    if (confirmed) {
      loadContext.mockResolvedValue({
        ...context,
        history: context.history.map((item) => ({ ...item, status: 'voided', void_reason: 'คืนสินค้า' })),
      });
    }
    await user.click(second.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    if (confirmed) {
      expect(screen.queryByRole('button', { name: 'ยกเลิก', exact: true })).toBeNull();
      expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, submitting: false });
      expect(uploadEvidence).toHaveBeenCalledTimes(1);
      expect(deleteEvidence).not.toHaveBeenCalled();
      return;
    }
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: true, submitting: false });

    const reopened = await openDialog(user);
    expect((reopened.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }) as HTMLTextAreaElement).value).toBe('คืนสินค้า');
    await user.click(reopened.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(voidTransaction).toHaveBeenCalledTimes(3);
    expect(voidTransaction.mock.calls[2][0]).toEqual(voidTransaction.mock.calls[0][0]);
    expect(uploadEvidence).toHaveBeenCalledTimes(1);
    expect(deleteEvidence).not.toHaveBeenCalled();
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, submitting: false });
  });
});

it('records the actual cash refunder and changes retry identity when that person changes', async () => {
  const { user, voidTransaction } = setup(1, {
    supports_cash_refunder: true, default_receiver_id: 'admin',
    cash_receivers: [{ id: 'admin', name: 'แอดมิน' }, { id: 'worker', name: 'คนคืนเงินจริง' }],
  });
  voidTransaction.mockRejectedValueOnce(new Error('Failed to fetch'));
  const dialog = await openDialog(user);
  await user.type(dialog.getByRole('textbox', { name: 'เหตุผลการยกเลิก' }), 'คืนสินค้า');
  await user.selectOptions(dialog.getByRole('combobox', { name: 'ผู้คืนเงินจริง' }), 'worker');
  await user.click(dialog.getByRole('button', { name: 'ยืนยันยกเลิก' }));
  await screen.findByText('Failed to fetch');
  expect(voidTransaction.mock.calls[0][0].cashRefundedBy).toBe('worker');
  await user.click(dialog.getByRole('button', { name: 'กลับ', exact: true }));
  const reopened = await openDialog(user);
  expect((reopened.getByRole('combobox', { name: 'ผู้คืนเงินจริง' }) as HTMLSelectElement).value).toBe('worker');
  await user.selectOptions(reopened.getByRole('combobox', { name: 'ผู้คืนเงินจริง' }), 'admin');
  await user.click(reopened.getByRole('button', { name: 'ยืนยันยกเลิก' }));
  await waitFor(() => expect(voidTransaction).toHaveBeenCalledTimes(2));
  expect(voidTransaction.mock.calls[1][0].cashRefundedBy).toBe('admin');
  expect(voidTransaction.mock.calls[1][0].idempotencyKey).not.toBe(voidTransaction.mock.calls[0][0].idempotencyKey);
});
