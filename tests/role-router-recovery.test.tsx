import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { RoleRouter } from '../src/RoleRouter';
import { readNavigation, writeNavigation } from '../src/lib/recoveryStorage';

const profile = {
  id: 'courier-1',
  code: 'C001',
  display_name: 'พนักงานทดสอบ',
  phone: null,
  role: 'courier',
  is_active: true,
};

const mockedSupabase = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: { signOut: mockedSupabase.signOut },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mockedSupabase.maybeSingle }),
      }),
    }),
  },
}));

vi.mock('../src/EmployeeDeliveryWorkspace', () => ({
  EmployeeDeliveryWorkspace: () => <div>delivery workspace</div>,
}));

vi.mock('../src/FinancialOperations', () => ({
  FinancialOperations: () => <div>financial operations</div>,
}));

describe('RoleRouter recovery', () => {
  it('does not overwrite restored navigation with initial defaults', async () => {
    mockedSupabase.maybeSingle.mockResolvedValue({ data: profile, error: null });
    mockedSupabase.signOut.mockResolvedValue(undefined);
    writeNavigation(profile.id, {
      activeView: 'manager_overview',
      courierView: 'withdrawal',
      billingServiceDate: '2026-07-15',
    });

    render(
      <RoleRouter
        onRecoverableSessionError={vi.fn().mockResolvedValue(false)}
        session={{ user: { id: profile.id } } as unknown as Session}
      />,
    );

    await waitFor(() => expect(
      screen.getByRole('button', { name: /เบิก/ }).getAttribute('aria-current'),
    ).toBe('page'));
    expect(readNavigation(profile.id)).toEqual({
      activeView: 'manager_overview',
      courierView: 'withdrawal',
      billingServiceDate: '2026-07-15',
    });
  });
});
