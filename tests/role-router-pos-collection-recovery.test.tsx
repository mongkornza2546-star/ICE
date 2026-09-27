import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { StrictMode } from 'react';
import { expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import type { CollectionFocusRequest, ShopCard, UserProfile } from '../src/types/app';
import { readPosCollectionReturn, writePosCollectionReturn } from '../src/lib/posCollectionReturn';
import { toBangkokDateString } from '../src/lib/serviceDate';
import { writeCachedEmployeeReferenceData, writeCachedEmployeeShopCards } from '../src/lib/employeeWorkspaceCache';
import type { EmployeeDeliveryWorkspace, EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';

const supabaseMock = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle,
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return {
    client: {
      from: vi.fn(() => query),
      auth: { signOut: vi.fn() },
      channel: vi.fn(() => {
        const channel = { on: vi.fn(), subscribe: vi.fn() };
        channel.on.mockReturnValue(channel);
        channel.subscribe.mockReturnValue(channel);
        return channel;
      }),
      removeChannel: vi.fn(),
    },
    maybeSingle,
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock.client }));
vi.mock('../src/AdminLayout', () => ({
  AdminLayout: ({ children, onNavigate }: { children: ReactNode; onNavigate?: (view: string) => void }) => (
    <div data-testid="admin-layout">
      <button onClick={() => onNavigate?.('financial_operations')} type="button">ไปหน้าการเงิน</button>
      {children}
    </div>
  ),
}));
vi.mock('../src/EmployeeLayout', () => ({
  EmployeeLayout: ({ children }: { children: ReactNode }) => <div data-testid="employee-layout">{children}</div>,
}));
vi.mock('../src/ManagerDashboard', () => ({ ManagerDashboard: () => null }));
vi.mock('../src/FactoryOrderPage', () => ({ FactoryOrderPage: () => null }));
vi.mock('../src/AdminReferenceSettings', () => ({ AdminReferenceSettings: () => null }));
vi.mock('../src/EmployeeDeliveryWorkspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/EmployeeDeliveryWorkspace')>();
  return { ...actual, EmployeeDeliveryWorkspace: (props: ComponentProps<typeof EmployeeDeliveryWorkspace>) => <actual.EmployeeDeliveryWorkspace {...props} gateway={gateway} /> };
});
vi.mock('../src/LocationManagementSettings', () => ({ LocationManagementSettings: () => null }));
vi.mock('../src/ShopSettings', () => ({ ShopSettings: () => null }));
vi.mock('../src/RoundWorkspace', () => ({ RoundWorkspace: () => null }));
vi.mock('../src/ManagerStockAudit', () => ({ ManagerStockAudit: () => null }));
vi.mock('../src/FinancialOperations', () => ({
  FinancialOperations: ({ focusRequest, onFocusedCollectionClose }: ComponentProps<typeof import('../src/FinancialOperations').FinancialOperations>) => (
    <button data-testid="financial-operations" data-request-id={focusRequest?.requestId}
      onClick={() => focusRequest && onFocusedCollectionClose?.({ status: 'cancelled', requestId: focusRequest.requestId, shopId: focusRequest.shopId })}>
      Cancel collection
    </button>
  ),
}));

import { RoleRouter } from '../src/RoleRouter';

const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  token_type: 'bearer',
  user: {
    id: 'user-1',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-08-12T00:00:00.000Z',
  },
} as Session;

const courierProfile: UserProfile = {
  id: 'user-1',
  code: 'EMP001',
  display_name: 'พนักงานทดสอบ',
  phone: null,
  role: 'courier',
  is_active: true,
  can_collect_shop_payments: true,
};

const date = toBangkokDateString();
const reference = {
  rounds: [{ id: 'round-1', service_date: date, name: 'Round', status: 'open' as const, opened_at: date }],
  iceTypes: [{ id: 'ice-1', code: 'ICE', name: 'Ice', unit: 'Bag' }],
};
const shop: ShopCard = {
  round_stop_id: 'stop-1', shop_id: 'shop-1', shop_code: 'BB15', shop_name: 'Shop',
  building_id: 'building-1', building_name: 'Building', floor_or_zone: 'Zone', sequence_no: 1,
  image_path: null, image_url: null, payment_status: 'unpaid', stop_status: 'delivered',
  stop_note: null, today_history: [], today_totals: {},
};
const gateway: EmployeeDeliveryGateway = {
  loadReferenceData: vi.fn().mockResolvedValue(reference),
  loadShopCards: vi.fn().mockResolvedValue([shop]),
  loadEmployeeStockState: vi.fn(), recordEmployeeStockTransfer: vi.fn(),
  recordEmployeeStockReturn: vi.fn(), recordEmployeeStockDamage: vi.fn(),
  recordDelivery: vi.fn(), recordImmediateSale: vi.fn(),
};
it.each([false, true])('resumes focused collection before POS consumes return state (cached: %s)', async (cached) => {
  if (cached) {
    writeCachedEmployeeReferenceData('user-1', date, reference);
    writeCachedEmployeeShopCards('user-1', date, 'round-1', [shop]);
  }
  const request: CollectionFocusRequest = {
    requestId: 'request-1', source: 'pos-shortcut', shopId: 'shop-1',
    queueKey: 'regular:shop-1', returnContextId: 'request-1',
  };
  writePosCollectionReturn({
    version: 1, ownerId: 'user-1', returnTo: 'pos', origin: 'courier-pos', request,
    posServiceDate: date, collectionServiceDate: date, selectedRoundId: 'round-1',
    destinationKind: 'regular', selectedBuildingId: 'building-1', selectedZone: 'Zone', selectedEventJobId: '', query: 'BB15',
    shopId: 'shop-1', roundStopId: 'stop-1', scrollY: 700, cardViewportOffset: 100, savedAt: new Date().toISOString(),
  });
  supabaseMock.maybeSingle.mockResolvedValue({ data: courierProfile, error: null });
  render(<StrictMode><RoleRouter onRecoverableSessionError={vi.fn().mockResolvedValue(false)} session={session} /></StrictMode>);
  const collection = await screen.findByTestId('financial-operations');
  expect(collection.getAttribute('data-request-id')).toBe(request.requestId);
  expect(screen.getByRole('button', { name: 'เก็บเงิน' }).getAttribute('aria-current')).toBe('page');
  expect(readPosCollectionReturn('user-1')).not.toBeNull();

  fireEvent.click(collection);
  const card = await screen.findByRole('button', { name: 'เลือกร้าน BB15 Shop' });
  await waitFor(() => expect(document.activeElement).toBe(card));
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('BB15');
  expect(screen.getByRole('button', { name: 'Building' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Zone' }).getAttribute('aria-pressed')).toBe('true');
  expect(readPosCollectionReturn('user-1')).toBeNull();
});
