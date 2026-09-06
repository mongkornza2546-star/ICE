import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ShopSetting } from '../src/types/app';
const service = vi.hoisted(() => ({ bulkSaveShopPaymentProfiles: vi.fn().mockResolvedValue(1) }));
vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', () => ({
  ...service, getErrorMessage: (e: Error) => e.message,
}));
import { BulkPaymentSetupModal } from '../src/features/shop-settings/components/BulkPaymentSetupModal';

it('previews and sends only selected setting groups, preserving evidence requirements', async () => {
  render(<BulkPaymentSetupModal shops={[{ id: 'shop-1', code: 'A', name: 'ร้าน A', status: 'active' } as ShopSetting]}
    buildings={[]} zones={[]} onClose={vi.fn()} onSuccess={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'เลือกทั้งหมด' }));
  fireEvent.click(screen.getByLabelText('เปลี่ยนรูปแบบชำระเงินและเครดิต'));
  fireEvent.click(screen.getByLabelText('เปลี่ยนช่องทางการเงิน'));
  expect(screen.getByText(/คงเงื่อนไขหลักฐานและเลขอ้างอิงเดิม/)).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /ตรวจสอบการเปลี่ยนแปลง/ }));
  expect(service.bulkSaveShopPaymentProfiles).not.toHaveBeenCalled();
  expect(screen.getByText('สรุปก่อนบันทึก')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /ยืนยันตั้งค่า/ }));
  await waitFor(() => expect(service.bulkSaveShopPaymentProfiles).toHaveBeenCalledWith(['shop-1'], {
    terms: null,
    methods: { allowed_payment_methods: ['cash', 'bank_transfer', 'qr'], default_payment_method: 'cash' },
  }));
});
