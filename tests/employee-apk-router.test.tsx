import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => {
  vi.stubEnv('VITE_EMPLOYEE_ONLY', 'true');
  return { profile: vi.fn(), signOut: vi.fn(), adminLoaded: vi.fn() };
});
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.profile }) }) }),
    auth: { signOut: mocks.signOut },
  },
}));
vi.mock('../src/lib/realtimeSync', () => ({ initGlobalRealtimeSync: () => () => {} }));
vi.mock('../src/AdminRoleWorkspace', () => {
  mocks.adminLoaded();
  return { default: () => <div>Admin workspace</div> };
});
vi.mock('../src/EmployeeLayout', () => ({
  EmployeeLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../src/EmployeeDeliveryWorkspace', () => ({
  EmployeeDeliveryWorkspace: ({ viewMode }: { viewMode: string }) => <div data-testid="delivery" data-mode={viewMode} />,
}));
vi.mock('../src/EmployeeEventPage', () => ({
  EmployeeEventPage: ({ isActive }: { isActive: boolean }) => <div data-testid="events" data-active={String(isActive)} />,
}));
vi.mock('../src/FinancialOperations', () => ({
  FinancialOperations: ({ userRole, canCollectShopPayments }: { userRole: string; canCollectShopPayments: boolean }) => (
    <div data-testid="payments" data-role={userRole} data-can-collect={String(canCollectShopPayments)} />
  ),
}));

import { RoleRouter } from '../src/RoleRouter';
const session = { user: { id: 'employee-apk-user' } } as Session;
const profile = {
  id: session.user.id, code: 'EMP', display_name: 'Employee', nickname: null,
  phone: null, role: 'courier', is_active: true, can_collect_shop_payments: true,
};

it.each([true, false])('keeps current employee tasks and payment permission (%s) without loading admin', async (canCollect) => {
  mocks.profile.mockResolvedValue({ data: { ...profile, can_collect_shop_payments: canCollect }, error: null });
  render(<RoleRouter session={session} onRecoverableSessionError={vi.fn().mockResolvedValue(false)} />);
  expect((await screen.findByTestId('delivery')).getAttribute('data-mode')).toBe('pos');
  fireEvent.click(screen.getByRole('button', { name: 'เติม / คืน / ละลาย' }));
  expect(screen.getByTestId('delivery').getAttribute('data-mode')).toBe('withdrawal');
  fireEvent.click(screen.getByRole('button', { name: 'เก็บเงิน' }));
  expect(screen.getByTestId('payments').getAttribute('data-role')).toBe('courier');
  expect(screen.getByTestId('payments').getAttribute('data-can-collect')).toBe(String(canCollect));
  fireEvent.click(screen.getByRole('button', { name: 'อีเวนต์' }));
  expect(screen.getByTestId('events').getAttribute('data-active')).toBe('true');
  expect(mocks.adminLoaded).not.toHaveBeenCalled();
});

it.each(['admin', 'round_lead'])('blocks management account %s and allows signing out', async (role) => {
  mocks.profile.mockResolvedValue({ data: { ...profile, role }, error: null });
  render(<RoleRouter session={session} onRecoverableSessionError={vi.fn().mockResolvedValue(false)} />);
  expect(await screen.findByText('แอปสำหรับพนักงานส่งน้ำแข็ง')).toBeTruthy();
  expect(screen.queryByTestId('delivery')).toBeNull();
  expect(mocks.adminLoaded).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'ออกจากระบบ' }));
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
});

it('does not grant access to an inactive employee', async () => {
  mocks.profile.mockResolvedValue({ data: { ...profile, is_active: false }, error: null });
  render(<RoleRouter session={session} onRecoverableSessionError={vi.fn().mockResolvedValue(false)} />);
  await screen.findByRole('button', { name: 'ออกจากระบบ' });
  expect(screen.queryByTestId('delivery')).toBeNull();
  expect(mocks.adminLoaded).not.toHaveBeenCalled();
});
