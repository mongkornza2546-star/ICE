import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import type { UserProfile } from '../src/types/app';
import { USER_PROFILE_REVALIDATE_MS, writeCachedUserProfile } from '../src/lib/userProfileCache';

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
    },
    maybeSingle,
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock.client }));
vi.mock('../src/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div data-testid="admin-layout">{children}</div>,
}));
vi.mock('../src/EmployeeLayout', () => ({
  EmployeeLayout: ({ children }: { children: ReactNode }) => <div data-testid="employee-layout">{children}</div>,
}));
vi.mock('../src/ManagerDashboard', () => ({ ManagerDashboard: () => null }));
vi.mock('../src/FactoryOrderPage', () => ({ FactoryOrderPage: () => null }));
vi.mock('../src/AdminReferenceSettings', () => ({ AdminReferenceSettings: () => null }));
vi.mock('../src/EmployeeDeliveryWorkspace', () => ({ EmployeeDeliveryWorkspace: () => null }));
vi.mock('../src/LocationManagementSettings', () => ({ LocationManagementSettings: () => null }));
vi.mock('../src/ShopSettings', () => ({ ShopSettings: () => null }));
vi.mock('../src/RoundWorkspace', () => ({ RoundWorkspace: () => null }));
vi.mock('../src/ManagerStockAudit', () => ({ ManagerStockAudit: () => null }));
vi.mock('../src/FinancialOperations', () => ({ FinancialOperations: () => null }));

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
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe('RoleRouter profile validation', () => {
  beforeEach(() => {
    supabaseMock.maybeSingle.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it('does not route from an unverified localStorage role', async () => {
    writeCachedUserProfile({ ...courierProfile, role: 'admin' });
    const profileResponse = deferred<{ data: UserProfile; error: null }>();
    supabaseMock.maybeSingle.mockReturnValueOnce(profileResponse.promise);

    render(<RoleRouter onRecoverableSessionError={vi.fn().mockResolvedValue(false)} session={session} />);

    expect(screen.getByText('ตรวจข้อมูลผู้ใช้ในระบบ')).not.toBeNull();
    expect(screen.queryByTestId('admin-layout')).toBeNull();
    expect(supabaseMock.maybeSingle).toHaveBeenCalledTimes(1);

    profileResponse.resolve({ data: courierProfile, error: null });
    expect(await screen.findByTestId('employee-layout')).not.toBeNull();
    expect(screen.queryByTestId('admin-layout')).toBeNull();
  });

  it('revalidates an open app every five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    supabaseMock.maybeSingle
      .mockResolvedValueOnce({ data: { ...courierProfile, role: 'admin' }, error: null })
      .mockResolvedValueOnce({ data: courierProfile, error: null });

    render(<RoleRouter onRecoverableSessionError={vi.fn().mockResolvedValue(false)} session={session} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('admin-layout')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(USER_PROFILE_REVALIDATE_MS);
      await Promise.resolve();
    });

    expect(screen.getByTestId('employee-layout')).not.toBeNull();
    expect(supabaseMock.maybeSingle).toHaveBeenCalledTimes(2);
  });
});
