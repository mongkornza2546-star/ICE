import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CollectionDesk } from '../src/features/financial-operations/components/CollectionDesk';
import type { PaymentHistoryItem } from '../src/features/financial-operations/types';

const payments: PaymentHistoryItem[] = [
  {
    id: 'payment-a', receipt_number: 'REC-A', received_amount: 100, allocated_amount: 100,
    change_amount: 0, payment_method: 'cash', status: 'active',
    recorded_at: '2026-09-24T08:00:00.000Z', void_reason: null,
    building_id: 'building-a', building_name: 'ตึก A', zone_id: 'zone-a1', zone_name: 'โซน 1',
    shops: { code: 'A1', name: 'ร้าน A' },
  },
  {
    id: 'payment-b', receipt_number: 'REC-B', received_amount: 200, allocated_amount: 200,
    change_amount: 0, payment_method: 'cash', status: 'active',
    recorded_at: '2026-09-24T09:00:00.000Z', void_reason: null,
    building_id: 'building-b', building_name: 'ตึก B', zone_id: 'zone-b1', zone_name: 'โซน 1',
    shops: { code: 'B1', name: 'ร้าน B' },
  },
  {
    id: 'payment-b2', receipt_number: 'REC-B2', received_amount: 300, allocated_amount: 300,
    change_amount: 0, payment_method: 'cash', status: 'active',
    recorded_at: '2026-09-24T10:00:00.000Z', void_reason: null,
    building_id: 'building-b', building_name: 'ตึก B', zone_id: 'zone-b2', zone_name: 'โซน 2',
    shops: { code: 'B2', name: 'ร้าน B2' },
  },
];

describe('CollectionDesk history filters', () => {
  it('offers paid locations and filters history by building and zone when the unpaid queue is empty', async () => {
    const user = userEvent.setup();
    render(<CollectionDesk
      busy={false}
      historyDate="2026-09-24"
      onClearShop={vi.fn()}
      onHistoryDateChange={vi.fn()}
      onOpenReceipt={vi.fn()}
      onPrintReceipt={vi.fn()}
      onRefresh={vi.fn()}
      onSelectShop={vi.fn()}
      onVoidPayment={vi.fn()}
      paymentHistory={payments}
      paymentPanel={null}
      queue={[]}
      runId={null}
      selectedShop={null}
      serviceDate="2026-09-24"
      todayPayments={payments}
    />);

    await user.click(screen.getByRole('tab', { name: /ประวัติรับเงิน/ }));
    const building = screen.getByLabelText('เลือกตึก') as HTMLSelectElement;
    const zone = screen.getByLabelText('เลือกโซน') as HTMLSelectElement;
    expect(screen.getByRole('option', { name: 'ตึก B' })).toBeTruthy();
    await user.selectOptions(building, 'building-b');
    expect(screen.queryByText('REC-A')).toBeNull();
    expect(screen.getByText('REC-B')).toBeTruthy();
    expect(screen.getByText('REC-B2')).toBeTruthy();

    await user.selectOptions(zone, 'zone-b2');
    expect(screen.queryByText('REC-B')).toBeNull();
    expect(screen.getByText('REC-B2')).toBeTruthy();

    await user.selectOptions(building, '');
    expect(screen.getByText('REC-A')).toBeTruthy();
    expect(screen.getByText('REC-B')).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'ทั้งหมด' }));
    await user.selectOptions(building, 'building-a');
    expect(screen.getByText('REC-A')).toBeTruthy();
    expect(screen.queryByText('REC-B')).toBeNull();
  });
});
