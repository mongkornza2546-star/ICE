import { describe, expect, it, vi } from 'vitest';
import { createAdminResetPasswordHandler } from '../supabase/functions/admin-reset-user-password/handler';

interface FakeOptions {
  callerRole?: string;
  callerActive?: boolean;
  requestAuditError?: boolean;
  successAuditError?: boolean;
  resetError?: boolean;
}

function createFixture(options: FakeOptions = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const updateUserById = vi.fn().mockImplementation(async () => {
    events.push('auth:update-password');
    return {
      error: options.resetError ? { message: 'auth update failed' } : null,
    };
  });
  const callerClient = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'admin-1' } },
        error: null,
      }),
    },
    from: vi.fn(() => {
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            role: options.callerRole ?? 'admin',
            is_active: options.callerActive ?? true,
          },
          error: null,
        }),
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      return query;
    }),
  };
  const adminClient = {
    auth: { admin: { updateUserById } },
    from: vi.fn((table: string) => {
      if (table === 'users') {
        const query = {
          select: vi.fn(),
          eq: vi.fn(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'employee-1' }, error: null }),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }
      return {
        insert: vi.fn((values: Record<string, unknown>) => {
          audits.push(values);
          const action = values.action;
          events.push(`audit:${String(action)}`);
          const error = (action === 'password_reset_requested_by_admin' && options.requestAuditError)
            || (action === 'password_reset_succeeded_by_admin' && options.successAuditError)
            ? { message: 'audit unavailable' }
            : null;
          return Promise.resolve({ data: null, error });
        }),
      };
    }),
  };
  const createClient = vi.fn()
    .mockReturnValueOnce(callerClient)
    .mockReturnValueOnce(adminClient);
  const handler = createAdminResetPasswordHandler({
    createClient,
    getEnv: (name) => ({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    })[name],
  });

  function request(body = { userId: 'employee-1', password: 'new-password' }) {
    return new Request('https://example.test/admin-reset-user-password', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer caller-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  return { audits, createClient, events, handler, request, updateUserById };
}

describe('admin password reset edge handler', () => {
  it('rejects a request without an access token', async () => {
    const fixture = createFixture();
    const response = await fixture.handler(new Request('https://example.test', { method: 'POST' }));

    expect(response.status).toBe(401);
    expect(fixture.createClient).not.toHaveBeenCalled();
  });

  it('rejects a non-admin before creating a privileged client', async () => {
    const fixture = createFixture({ callerRole: 'courier' });
    const response = await fixture.handler(fixture.request());

    expect(response.status).toBe(403);
    expect(fixture.createClient).toHaveBeenCalledOnce();
    expect(fixture.updateUserById).not.toHaveBeenCalled();
  });

  it('rejects self-reset and short passwords before creating a privileged client', async () => {
    const selfReset = createFixture();
    const selfResponse = await selfReset.handler(selfReset.request({
      userId: 'admin-1',
      password: 'new-password',
    }));
    const shortPassword = createFixture();
    const shortResponse = await shortPassword.handler(shortPassword.request({
      userId: 'employee-1',
      password: 'short',
    }));

    expect(selfResponse.status).toBe(400);
    expect(shortResponse.status).toBe(400);
    expect(selfReset.createClient).toHaveBeenCalledOnce();
    expect(shortPassword.createClient).toHaveBeenCalledOnce();
  });

  it('records the request before changing the password and then records success', async () => {
    const fixture = createFixture();
    const response = await fixture.handler(fixture.request());

    expect(response.status).toBe(200);
    expect(fixture.audits.map((audit) => audit.action)).toEqual([
      'password_reset_requested_by_admin',
      'password_reset_succeeded_by_admin',
    ]);
    expect(fixture.events).toEqual([
      'audit:password_reset_requested_by_admin',
      'auth:update-password',
      'audit:password_reset_succeeded_by_admin',
    ]);
    expect(fixture.updateUserById).toHaveBeenCalledWith('employee-1', { password: 'new-password' });
  });

  it('does not change the password when the request audit cannot be stored', async () => {
    const fixture = createFixture({ requestAuditError: true });
    const response = await fixture.handler(fixture.request());

    expect(response.status).toBe(500);
    expect(fixture.updateUserById).not.toHaveBeenCalled();
  });

  it('records a failed result when Supabase Auth rejects the password change', async () => {
    const fixture = createFixture({ resetError: true });
    const response = await fixture.handler(fixture.request());

    expect(response.status).toBe(400);
    expect(fixture.audits.map((audit) => audit.action)).toEqual([
      'password_reset_requested_by_admin',
      'password_reset_failed',
    ]);
  });

  it('reports the partial failure when the password changes but the result audit fails', async () => {
    const fixture = createFixture({ successAuditError: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await fixture.handler(fixture.request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(fixture.updateUserById).toHaveBeenCalledOnce();
    expect(body.error).toContain('รหัสผ่านถูกเปลี่ยนแล้ว');
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
