import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CancelTankHandoffDialog } from '../src/features/event-management/CancelTankHandoffDialog';

it('retains committed success and retries only the refresh, even after repeated refresh failures', async () => {
  const onCancel = vi.fn().mockResolvedValue({ reversal_id: 'saved' });
  const onSaved = vi.fn()
    .mockRejectedValueOnce(new Error('Failed to fetch'))
    .mockRejectedValueOnce(new Error('Still offline'))
    .mockResolvedValue(undefined);
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<CancelTankHandoffDialog label="บูธ B90" quantity={1} onCancel={onCancel} onSaved={onSaved} onClose={onClose} />);
  await user.type(screen.getByLabelText('เหตุผลในการยกเลิก *'), 'ผิดร้าน');
  await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิกรายการถัง' }));
  expect((await screen.findByRole('status')).textContent).toBe('ยกเลิกรายการถังและบิลค่าเช่าแล้ว');
  expect(screen.getByRole('alert').textContent).toContain('โหลดข้อมูลล่าสุดไม่สำเร็จ');
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'ยืนยันยกเลิกรายการถัง' })).toBeNull();
  expect(screen.getByLabelText('เหตุผลในการยกเลิก *').hasAttribute('disabled')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'ลองโหลดข้อมูลใหม่' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status')).toBeTruthy();
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'ลองโหลดข้อมูลใหม่' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onSaved).toHaveBeenCalledTimes(3);
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it('retries cancellation if the cancellation itself was rejected', async () => {
  const onCancel = vi.fn().mockRejectedValueOnce(new Error('บิลค่าเช่านี้รับเงินแล้ว')).mockResolvedValue({});
  const onSaved = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<CancelTankHandoffDialog label="บูธ B90" quantity={1} onCancel={onCancel} onSaved={onSaved} onClose={onClose} />);
  await user.type(screen.getByLabelText('เหตุผลในการยกเลิก *'), 'ผิดร้าน');
  await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิกรายการถัง' }));
  expect((await screen.findByRole('alert')).textContent).toBe('บิลค่าเช่านี้รับเงินแล้ว');
  expect(screen.queryByRole('status')).toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'ยืนยันยกเลิกรายการถัง' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(onSaved).toHaveBeenCalledTimes(1);
});
