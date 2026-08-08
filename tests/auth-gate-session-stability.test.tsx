import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { AuthGate } from '../src/AuthGate';

const session = { user: { id: 'courier-1' } } as unknown as Session;
const profile = {
  id: 'courier-1',
  code: 'C001',
  display_name: 'พนักงานทดสอบ',
  phone: null,
  role: 'courier',
  is_active: true,
};

const mocks = vi.hoisted(() => ({
  authChange: null as null | ((event: AuthChangeEvent, session: Session | null) => void),
  getSession: vi.fn(),
  maybeSingle: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('../src/lib/env', () => ({
  env: { isConfigured: true },
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
        mocks.authChange = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      signOut: mocks.signOut,
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.maybeSingle }),
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

describe('AuthGate session stability', () => {
  beforeEach(() => {
    mocks.authChange = null;
    mocks.getSession.mockReset().mockResolvedValue({ data: { session }, error: null });
    mocks.maybeSingle.mockReset().mockResolvedValue({ data: profile, error: null });
    mocks.signOut.mockReset().mockResolvedValue(undefined);
  });

  it('keeps the loaded workspace mounted when Supabase repeats the same signed-in session', async () => {
    render(<AuthGate />);

    await screen.findByText('delivery workspace');
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);

    act(() => {
      mocks.authChange?.('TOKEN_REFRESHED', { ...session, user: { ...session.user } });
    });

    await waitFor(() => expect(mocks.maybeSingle).toHaveBeenCalledTimes(1));
    expect(screen.getByText('delivery workspace')).toBeTruthy();
    expect(screen.queryByText('กำลังโหลดสิทธิ์')).toBeNull();
  });
});
