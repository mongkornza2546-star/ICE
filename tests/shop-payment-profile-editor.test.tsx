import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  loadShopPaymentProfile: vi.fn(),
  saveShopPaymentProfile: vi.fn(),
}));

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', () => ({
  ...service,
  getErrorMessage: (error: Error) => error.message,
}));

import { ShopPaymentProfileEditor } from '../src/features/shop-settings/components/ShopPaymentProfileEditor';

const legacyProfile = {
  shop_id: 'shop-1',
  allowed_payment_terms: ['immediate'] as const,
  default_payment_term: 'immediate' as const,
  allowed_payment_methods: ['cash', 'qr'] as const,
  default_payment_method: 'qr' as const,
  cash_reference_required: false,
  cash_evidence_required: false,
  bank_transfer_reference_required: false,
  bank_transfer_evidence_required: true,
  qr_reference_required: true,
  qr_evidence_required: false,
  allow_outstanding: false,
  credit_due_rule: null,
  credit_days: null,
  credit_collection_weekday: null,
  credit_limit: null,
};

it('merges a legacy QR option into bank transfer and never renders QR as a choice', async () => {
  service.loadShopPaymentProfile.mockResolvedValue(legacyProfile);
  service.saveShopPaymentProfile.mockImplementation(async (profile) => profile);

  render(<ShopPaymentProfileEditor shopId="shop-1" shopName="ร้านทดสอบ" />);

  expect((await screen.findByLabelText('โอนเงิน (Transfer)') as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByLabelText('สแกน QR')).toBeNull();
  expect((screen.getByLabelText('ช่องทางเริ่มต้น (Default Method)') as HTMLSelectElement).value).toBe('bank_transfer');

  fireEvent.click(screen.getByRole('button', { name: 'บันทึกโปรไฟล์การชำระเงิน' }));

  await waitFor(() => expect(service.saveShopPaymentProfile).toHaveBeenCalledWith(expect.objectContaining({
    allowed_payment_methods: ['cash', 'bank_transfer'],
    default_payment_method: 'bank_transfer',
  })));
});
