import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CollectionRunSection } from '../src/features/financial-operations/components/CollectionRunSection';
import type { QueueShop } from '../src/features/financial-operations/types';

const paymentProfile: QueueShop['payment_profile'] = {
  allowed_payment_methods: ['cash'],
  default_payment_method: 'cash',
  cash_reference_required: false,
  cash_evidence_required: false,
  bank_transfer_reference_required: false,
  bank_transfer_evidence_required: false,
  qr_reference_required: false,
  qr_evidence_required: false,
};

const queue: QueueShop[] = [
  {
    shop_id: 'shop-1',
    shop_code: 'BB58',
    shop_name: "Bellinee's",
    building_id: 'building-b',
    building_name: 'ตึก B',
    zone_id: 'zone-food-world',
    zone_name: 'Food World',
    image_path: null,
    outstanding_amount: 120,
    charge_count: 1,
    has_new_charges: false,
    payment_profile: paymentProfile,
    charges: [],
  },
  {
    shop_id: 'shop-2',
    shop_code: 'BB59',
    shop_name: 'Star coffee',
    building_id: 'building-b',
    building_name: 'ตึก B',
    zone_id: 'zone-food-world',
    zone_name: 'Food World',
    image_path: null,
    outstanding_amount: 60,
    charge_count: 1,
    has_new_charges: false,
    payment_profile: paymentProfile,
    charges: [],
  },
];

function renderCollectionRun() {
  render(<CollectionRunSection
    busy={false}
    collectorAvatarUrls={{}}
    collectors={[]}
    failedCollectorAvatars={new Set()}
    isManager={false}
    memberIds={[]}
    onCloseRun={vi.fn()}
    onCollectorAvatarError={vi.fn()}
    onSaveRun={vi.fn()}
    onSelectShop={vi.fn()}
    onToggleCollector={vi.fn()}
    queue={queue}
    runId="run-1"
  />);
}

describe('collection run search', () => {
  it('filters shops by code or name and restores the full queue when cleared', async () => {
    const user = userEvent.setup();
    renderCollectionRun();
    const search = screen.getByRole('searchbox', { name: 'ค้นหาร้านค้า' });

    await user.type(search, 'bb58');
    expect(screen.getByRole('button', { name: /BB58/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /BB59/ })).toBeNull();

    await user.clear(search);
    await user.type(search, 'STAR');
    expect(screen.queryByRole('button', { name: /BB58/ })).toBeNull();
    expect(screen.getByRole('button', { name: /BB59/ })).toBeTruthy();

    await user.clear(search);
    expect(screen.getByRole('button', { name: /BB58/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /BB59/ })).toBeTruthy();
  });

  it('shows a search-specific empty state', async () => {
    const user = userEvent.setup();
    renderCollectionRun();

    await user.type(screen.getByRole('searchbox', { name: 'ค้นหาร้านค้า' }), 'ไม่มีร้านนี้');

    expect(screen.getByText('ไม่พบร้านค้าที่ค้นหา')).toBeTruthy();
  });
});
