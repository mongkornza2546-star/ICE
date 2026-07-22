import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopPaymentProfileEditor } from '../src/features/shop-settings/components/ShopPaymentProfileEditor';
import { ShopSpecialPriceEditor } from '../src/features/shop-settings/components/ShopSpecialPriceEditor';
import { ShopReadinessPanel } from '../src/features/shop-settings/components/ShopReadinessPanel';
import { BulkPaymentSetupModal } from '../src/features/shop-settings/components/BulkPaymentSetupModal';
import * as service from '../src/features/admin-reference-settings/adminReferenceSettingsService';
import type { IceTypeOption, ShopPaymentProfileSetting } from '../src/types/app';

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', async (importOriginal) => {
  const actual = await importOriginal<typeof service>();
  return {
    ...actual,
    loadShopPaymentProfile: vi.fn(),
    saveShopPaymentProfile: vi.fn(),
    loadShopIcePrices: vi.fn(),
    saveShopIcePrice: vi.fn(),
    loadPOSReadinessReport: vi.fn(),
    bulkSaveShopPaymentProfiles: vi.fn(),
  };
});

const iceTypes: IceTypeOption[] = [
  { id: 'ice-block', code: 'BLOCK', name: 'ก้อน', unit: 'ถุง' },
];

const mockProfile: ShopPaymentProfileSetting = {
  shop_id: 'shop-1',
  allowed_payment_terms: ['immediate'],
  default_payment_term: 'immediate',
  allowed_payment_methods: ['cash', 'bank_transfer', 'qr'],
  default_payment_method: 'cash',
  cash_reference_required: false,
  cash_evidence_required: false,
  bank_transfer_reference_required: true,
  bank_transfer_evidence_required: false,
  qr_reference_required: true,
  qr_evidence_required: false,
  allow_outstanding: false,
  credit_due_rule: null,
  credit_days: null,
  credit_limit: null,
};

describe('Shop Payment and Pricing Settings Components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(service.loadShopPaymentProfile).mockResolvedValue(mockProfile);
    vi.mocked(service.saveShopPaymentProfile).mockResolvedValue(mockProfile);
    vi.mocked(service.loadShopIcePrices).mockResolvedValue([]);
    vi.mocked(service.saveShopIcePrice).mockResolvedValue({
      id: 'sp-1',
      shop_id: 'shop-1',
      ice_type_id: 'ice-block',
      unit_price: 35.0,
      valid_from: '2026-07-21',
      valid_to: null,
      is_active: true,
    });
    vi.mocked(service.loadPOSReadinessReport).mockResolvedValue({
      total_active_shops: 5,
      shops_ready_count: 4,
      shops_missing_payment_profile: 1,
      ice_types_missing_standard_price: 0,
      items: [
        {
          shop_id: 'shop-2',
          shop_code: 'S02',
          shop_name: 'ร้านเจ๊อ้อย',
          building_name: 'ตึก A',
          zone_name: 'ชั้น 1',
          has_payment_profile: false,
          missing_special_prices_count: 0,
          has_issues: true,
          issue_details: ['ยังไม่มี Payment Profile'],
        },
      ],
    });
    vi.mocked(service.bulkSaveShopPaymentProfiles).mockResolvedValue(1);
  });

  it('renders and updates shop payment profile', async () => {
    const user = userEvent.setup();
    render(<ShopPaymentProfileEditor shopId="shop-1" shopName="ร้านทดสอบ" />);

    expect(await screen.findByText(/เงื่อนไขการชำระเงินของ ร้านทดสอบ/i)).toBeTruthy();

    const submitBtn = screen.getByRole('button', { name: 'บันทึกโปรไฟล์การชำระเงิน' });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(service.saveShopPaymentProfile).toHaveBeenCalledWith(expect.objectContaining({
        shop_id: 'shop-1',
        allowed_payment_terms: ['immediate'],
      }));
    });
  });

  it('renders and adds a shop special ice price', async () => {
    const user = userEvent.setup();
    render(<ShopSpecialPriceEditor iceTypes={iceTypes} shopId="shop-1" shopName="ร้านทดสอบ" />);

    expect(await screen.findByText(/ราคาน้ำแข็งพิเศษประจำร้าน ร้านทดสอบ/i)).toBeTruthy();

    const priceInput = screen.getByLabelText(/ราคาพิเศษ \(บาท\)/i);
    await user.type(priceInput, '35.00');

    const submitBtn = screen.getByRole('button', { name: 'บันทึกราคาพิเศษ' });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(service.saveShopIcePrice).toHaveBeenCalledWith({
        shop_id: 'shop-1',
        ice_type_id: 'ice-block',
        unit_price: 35.0,
        valid_from: expect.any(String),
        valid_to: null,
      });
    });
  });

  it('renders the POS readiness panel with issue summary', async () => {
    render(<ShopReadinessPanel />);

    expect(await screen.findByText(/สถานะความพร้อมก่อนเปิดใช้ POS การเงิน/i)).toBeTruthy();
    expect(screen.getByText('ร้านเจ๊อ้อย')).toBeTruthy();
    expect(screen.getByText('• ยังไม่มี Payment Profile')).toBeTruthy();
  });

  it('keeps bulk payment defaults inside their allowed values', async () => {
    const user = userEvent.setup();
    render(
      <BulkPaymentSetupModal
        buildings={[{ id: 'building-a', code: 'A', name: 'ตึก A' }]}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
        shops={[{
          id: 'shop-1', code: 'S01', name: 'ร้านทดสอบ', image_path: null,
          building_id: 'building-a', zone_id: 'zone-a', floor_or_zone: 'ชั้น 1',
          government_shop_code: null, contact_name: null, contact_phone: null,
          normal_rounds_per_day: 1, access_note: null, status: 'active',
        }]}
        zones={[{ id: 'zone-a', building_id: 'building-a', code: 'A1', name: 'ชั้น 1', sort_order: 1, is_active: true }]}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: /S01/ }));
    await user.click(screen.getByRole('checkbox', { name: 'เก็บท้ายวัน' }));
    await user.selectOptions(screen.getByLabelText('รูปแบบเริ่มต้น'), 'end_of_day');
    await user.click(screen.getByRole('checkbox', { name: 'เงินสด' }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันตั้งค่า 1 ร้าน' }));

    await waitFor(() => expect(service.bulkSaveShopPaymentProfiles).toHaveBeenCalledWith(
      ['shop-1'],
      expect.objectContaining({
        allowed_payment_terms: ['immediate', 'end_of_day'],
        default_payment_term: 'end_of_day',
        allowed_payment_methods: ['bank_transfer', 'qr'],
        default_payment_method: 'bank_transfer',
      }),
    ));
  });

  it('clears hidden shop selections when a bulk filter changes', async () => {
    const user = userEvent.setup();
    render(
      <BulkPaymentSetupModal
        buildings={[
          { id: 'building-a', code: 'A', name: 'ตึก A' },
          { id: 'building-b', code: 'B', name: 'ตึก B' },
        ]}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
        shops={[
          { id: 'shop-a', code: 'A01', name: 'ร้าน A', image_path: null, building_id: 'building-a', zone_id: 'zone-a', floor_or_zone: '1', government_shop_code: null, contact_name: null, contact_phone: null, normal_rounds_per_day: 1, access_note: null, status: 'active' },
          { id: 'shop-b', code: 'B01', name: 'ร้าน B', image_path: null, building_id: 'building-b', zone_id: 'zone-b', floor_or_zone: '1', government_shop_code: null, contact_name: null, contact_phone: null, normal_rounds_per_day: 1, access_note: null, status: 'active' },
        ]}
        zones={[]}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: /A01/ }));
    await user.selectOptions(screen.getByLabelText('กรองตามอาคาร'), 'building-b');

    expect(screen.getByText(/\(0\/1\)/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'ยืนยันตั้งค่า 0 ร้าน' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
