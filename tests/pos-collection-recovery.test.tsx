import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FinancialOperations } from '../src/FinancialOperations';
import { useEmployeeDeliveryData } from '../src/features/employee-delivery/useEmployeeDeliveryData';
import { readPosCollectionReturn, writePosCollectionReturn } from '../src/lib/posCollectionReturn';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import type { QueueShop } from '../src/features/financial-operations/types';
import type { CollectionFocusRequest } from '../src/types/app';

const mocks = vi.hoisted(() => ({ loadQueue: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('../src/lib/collectionQueue', () => ({ loadCurrentCollectionQueue: mocks.loadQueue }));

const request: CollectionFocusRequest = {
  requestId: 'request-1', source: 'pos-shortcut', shopId: 'shop-1',
  queueKey: 'regular:shop-1', returnContextId: 'request-1',
};
const date = '2026-09-27';
function saveReturn() {
  writePosCollectionReturn({
    version: 1, ownerId: 'employee-1', request, returnTo: 'pos', origin: 'courier-pos',
    posServiceDate: date, collectionServiceDate: date, selectedRoundId: 'round-1',
    destinationKind: 'regular', selectedBuildingId: 'building-1', selectedZone: 'zone-1',
    selectedEventJobId: '', query: '', shopId: 'shop-1', roundStopId: 'stop-1',
    scrollY: 700, cardViewportOffset: 100, savedAt: new Date().toISOString(),
  });
}
function gateway(): EmployeeDeliveryGateway {
  return {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{ id: 'round-1', service_date: date, name: 'Round', status: 'open', opened_at: date }],
      iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'Ice', unit: 'Bag' }],
    }),
    loadShopCards: vi.fn().mockResolvedValue([]), loadEmployeeStockState: vi.fn(),
    recordEmployeeStockTransfer: vi.fn(), recordEmployeeStockReturn: vi.fn(),
    recordEmployeeStockDamage: vi.fn(), recordDelivery: vi.fn(), recordImmediateSale: vi.fn(),
  };
}

it('retains stored return until shop list has loaded', () => {
  saveReturn();
  const gw = gateway();
  gw.loadReferenceData = vi.fn(() => new Promise(() => {}));
  renderHook(() => useEmployeeDeliveryData({ gateway: gw, serviceDate: date, requestScope: 'employee-1' }));
  expect(readPosCollectionReturn('employee-1')).not.toBeNull();
});

it('keeps saved filters while cold-loading the inactive POS', async () => {
  saveReturn();
  const gw = gateway();
  const { result } = renderHook(() => useEmployeeDeliveryData({
    gateway: gw, serviceDate: date, requestScope: 'employee-1', isActive: false,
  }));
  await waitFor(() => expect(result.current.loadingReference).toBe(false));
  expect(result.current.selectedBuildingId).toBe('building-1');
  expect(result.current.selectedZone).toBe('zone-1');
});

it.each([false, true])('ignores a cleared focus request, including after returning (active: %s)', async (isActive) => {
  let resolve!: (value: {runId: string; queue: QueueShop[]}) => void;
  mocks.loadQueue.mockReturnValue(new Promise((done) => { resolve = done; }));
  const view = render(<FinancialOperations userRole="courier" focusRequest={request} />);
  await waitFor(() => expect(mocks.loadQueue).toHaveBeenCalled());
  view.rerender(<FinancialOperations userRole="courier" focusRequest={null} isActive={isActive} />);
  await act(async () => resolve({ runId: 'run-1', queue: [{
    queue_key: 'regular:shop-1', destination_kind: 'regular', shop_id: 'shop-1',
    shop_code: 'BB15', shop_name: 'Review shop', image_path: null,
    outstanding_amount: 30, charge_count: 1, has_new_charges: false,
    payment_profile: {
      allowed_payment_methods: ['cash'], default_payment_method: 'cash',
      cash_reference_required: false, cash_evidence_required: false,
      bank_transfer_reference_required: false, bank_transfer_evidence_required: false,
      qr_reference_required: false, qr_evidence_required: false,
    },
    charges: [{ charge_id: 'charge-1', charge_number: 'INV-1', service_date: date,
      original_amount: 30, outstanding_amount: 30, items: [] }],
  }] }));
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<FinancialOperations userRole="courier" focusRequest={null} isActive />);
  await act(async () => {});
  expect(screen.queryByRole('dialog')).toBeNull();
});
