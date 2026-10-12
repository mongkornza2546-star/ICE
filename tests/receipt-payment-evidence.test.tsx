import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { HistoryReceiptModal } from '../src/features/financial-operations/components/HistoryReceiptModal';
import type { HistoryReceiptDetail } from '../src/features/financial-operations/types';
import { getStoredPaymentEvidence } from '../src/lib/paymentEvidence';

vi.mock('../src/lib/paymentEvidence', () => ({ getStoredPaymentEvidence: vi.fn() }));
const loadEvidence = vi.mocked(getStoredPaymentEvidence);
const receipt: HistoryReceiptDetail = {
  payment: {
    id: 'payment-1', receipt_number: 'REC2610-00605', payment_method: 'bank_transfer',
    received_amount: 780, allocated_amount: 780, change_amount: 0,
    recorded_at: '2026-10-09T10:55:00Z', status: 'active', void_reason: null,
    shops: { code: 'AA27', name: 'อัยการ' },
  },
  charges: [], error: null,
};

function modal(detail = receipt) {
  return <HistoryReceiptModal historyReceipt={detail} busy={false} dialogRef={createRef()}
    closeButtonRef={createRef()} onClose={vi.fn()} onPrint={vi.fn()} />;
}

beforeEach(() => loadEvidence.mockReset());

it('loads the selected transfer receipt and displays its slip with a full-size link', async () => {
  loadEvidence.mockResolvedValue({ url: 'https://example.com/slip.webp', isPdf: false });
  render(modal());
  expect(screen.getByRole('status').textContent).toBe('กำลังโหลดสลิป...');
  const preview = await screen.findByRole('img', { name: 'สลิปการชำระเงิน' });
  expect(loadEvidence).toHaveBeenCalledWith('payment-1');
  expect(preview.getAttribute('src')).toBe('https://example.com/slip.webp');
  expect(screen.getByRole('link', { name: 'ดูสลิป' }).getAttribute('href')).toBe('https://example.com/slip.webp');
});

it('shows an explicit empty state for older transfer receipts without an attachment', async () => {
  loadEvidence.mockResolvedValue(null);
  render(modal());
  expect(await screen.findByText('รายการนี้ไม่มีสลิปแนบ')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'ดูสลิป' })).toBeNull();
});

it('opens PDF evidence without trying to render it as an image, including QR payments', async () => {
  loadEvidence.mockResolvedValue({ url: 'https://example.com/slip.pdf', isPdf: true });
  render(modal({ ...receipt, payment: { ...receipt.payment, payment_method: 'qr' } }));
  expect(await screen.findByText('แนบไฟล์ PDF แล้ว')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'สลิปการชำระเงิน' })).toBeNull();
  expect(screen.getByRole('link', { name: 'ดูสลิป' }).getAttribute('href')).toBe('https://example.com/slip.pdf');
});

it('reports signing failures and lets the user retry', async () => {
  loadEvidence.mockRejectedValueOnce(new Error('โหลดไฟล์ไม่ได้'))
    .mockResolvedValueOnce({ url: 'https://example.com/slip.webp', isPdf: false });
  render(modal());
  expect((await screen.findByRole('alert')).textContent).toContain('โหลดไฟล์ไม่ได้');
  fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
  expect(await screen.findByRole('img', { name: 'สลิปการชำระเงิน' })).toBeTruthy();
});

it('keeps a file link available when the image fails to display', async () => {
  loadEvidence.mockResolvedValue({ url: 'https://example.com/slip.webp', isPdf: false });
  render(modal());
  fireEvent.error(await screen.findByRole('img', { name: 'สลิปการชำระเงิน' }));
  expect(screen.getByRole('alert').textContent).toContain('ไม่สามารถแสดงภาพสลิปได้');
  expect(screen.getByRole('link', { name: 'ดูสลิป' })).toBeTruthy();
});

it('does not show a previous receipt slip if its request finishes after switching receipts', async () => {
  let finishFirst!: (value: { url: string; isPdf: boolean }) => void;
  loadEvidence.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
    .mockResolvedValueOnce({ url: 'https://example.com/second.webp', isPdf: false });
  const view = render(modal());
  view.rerender(modal({ ...receipt, payment: { ...receipt.payment, id: 'payment-2' } }));
  await waitFor(() => expect(screen.getByRole('img', { name: 'สลิปการชำระเงิน' }).getAttribute('src')).toBe('https://example.com/second.webp'));
  await act(async () => finishFirst({ url: 'https://example.com/first.webp', isPdf: false }));
  expect(screen.getByRole('img', { name: 'สลิปการชำระเงิน' }).getAttribute('src')).toBe('https://example.com/second.webp');
});

it('does not fetch or display a slip section for cash payments', () => {
  render(modal({ ...receipt, payment: { ...receipt.payment, payment_method: 'cash' } }));
  expect(screen.queryByRole('region', { name: 'หลักฐานการชำระเงิน' })).toBeNull();
  expect(loadEvidence).not.toHaveBeenCalled();
});
