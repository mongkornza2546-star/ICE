import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import type { UserProfile } from '../src/types/app';
import { readCachedUserProfile, writeCachedUserProfile } from '../src/lib/userProfileCache';

const authMock = vi.hoisted(() => {
  const state = {
    listener: null as ((event: AuthChangeEvent, session: Session | null) => void) | null,
    session: null as Session | null,
  };
  return {
    state,
    client: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: state.session }, error: null })),
        onAuthStateChange: vi.fn((listener: (event: AuthChangeEvent, session: Session | null) => void) => {
          state.listener = listener;
          return { data: { subscription: { unsubscribe: vi.fn() } } };
        }),
        signOut: vi.fn(),
      },
    },
  };
});

vi.mock('../src/lib/env', () => ({ env: { isConfigured: true } }));
vi.mock('../src/lib/supabase', () => ({ supabase: authMock.client }));
vi.mock('../src/RoleRouter', () => ({ RoleRouter: () => <div data-testid="role-router" /> }));

import { AuthGate } from '../src/AuthGate';

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

const profile: UserProfile = {
  id: 'user-1',
  code: 'EMP001',
  display_name: 'พนักงานทดสอบ',
  phone: null,
  role: 'courier',
  is_active: true,
};

describe('AuthGate profile cache cleanup', () => {
  beforeEach(() => {
    authMock.state.session = session;
    authMock.state.listener = null;
  });

  it('clears the last user profile after an automatic sign-out', async () => {
    writeCachedUserProfile(profile);
    render(<AuthGate />);
    expect(await screen.findByTestId('role-router')).not.toBeNull();

    act(() => authMock.state.listener?.('SIGNED_OUT', null));

    expect(readCachedUserProfile(profile.id)).toBeNull();
    expect(screen.getByText('เข้าสู่ระบบหน้างาน')).not.toBeNull();
  });
});
