import { describe, expect, it, vi } from 'vitest';
import { createAdminCreateUserHandler } from '../supabase/functions/admin-create-user/handler';

const payload = {
  requestId: '11111111-1111-4111-8111-111111111111',
  displayName: ' พนักงานใหม่ ', nickname: ' ใหม่ ', phone: ' 0812345678 ',
  password: 'test-password-123', role: 'courier', isActive: true,
  canCollectShopPayments: true, workSiteIds: ['12345678-1234-1234-1234-123456789012'],
};
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup(options: { role?: string; active?: boolean; signedIn?: boolean; duplicate?: boolean; saveError?: boolean; createError?: boolean } = {}) {
  const pending = { id: 'new-user', code: 'AUTH-NEW', display_name: 'พนักงานใหม่', nickname: null, role: 'courier', is_active: false };
  const saved = { user: { ...pending, nickname: 'ใหม่', is_active: true }, work_site_ids: payload.workSiteIds };
  function query(result: unknown) {
    return {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: result, error: null }),
    };
  }
  const callerQuery = query({ id: adminId, role: options.role ?? 'admin', is_active: options.active ?? true });
  const duplicateQuery = query(options.duplicate ? { id: 'existing' } : null);
  const rpc = vi.fn().mockResolvedValue(options.saveError
    ? { data: null, error: { message: 'Work site is inactive' } }
    : { data: saved, error: null });
  const createUser = vi.fn().mockResolvedValue(options.createError
    ? { data: { user: null }, error: { message: 'Password rejected' } }
    : { data: { user: { id: 'new-user' } }, error: null });
  const callerClient = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: options.signedIn === false ? null : { id: adminId } }, error: null }) },
    from: vi.fn().mockReturnValue(callerQuery), rpc,
  };
  const adminClient = {
    auth: { admin: { createUser } },
    from: vi.fn().mockReturnValue(duplicateQuery),
    rpc: vi.fn().mockResolvedValueOnce({ data: null, error: null }).mockResolvedValue({
      data: options.saveError ? { user: pending, work_site_ids: [] } : null, error: null,
    }),
  };
  const createClient = vi.fn().mockReturnValueOnce(callerClient).mockReturnValue(adminClient);
  const handler = createAdminCreateUserHandler({ createClient, getEnv: (name) => name });
  const request = (body: unknown = payload, authorization = 'Bearer admin-token', method = 'POST') => handler(new Request('https://test.local', {
    method, headers: authorization ? { Authorization: authorization } : {},
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }));
  return { request, createClient, createUser, rpc, saved, pending, duplicateQuery, recover: adminClient.rpc };
}

describe('admin account provisioning', () => {
  it.each([
    { role: 'courier' }, { role: 'round_lead' }, { active: false }, { signedIn: false },
  ])('rejects callers without active admin privileges: %j', async (options) => {
    const ctx = setup(options);
    expect((await ctx.request()).status).toBe(options.signedIn === false ? 401 : 403);
    expect(ctx.createUser).not.toHaveBeenCalled();
    expect(ctx.createClient).toHaveBeenCalledTimes(1);
  });

  it('allows CORS and rejects unsupported or unauthenticated requests before using credentials', async () => {
    const ctx = setup();
    expect((await ctx.request(undefined, '', 'OPTIONS')).status).toBe(200);
    expect((await ctx.request(undefined, '', 'GET')).status).toBe(405);
    expect((await ctx.request(payload, '')).status).toBe(401);
    expect(ctx.createClient).not.toHaveBeenCalled();
  });

  it.each([null, [], { ...payload, password: 'short' }, { ...payload, nickname: ' ' },
    { ...payload, role: 'superadmin' }, { ...payload, workSiteIds: ['bad-id'] },
    { ...payload, isActive: 'true' }, { ...payload, nickname: 'ree@example.com' }])('validates input before creating Auth users: %j', async (body) => {
    const ctx = setup();
    expect((await ctx.request(body)).status).toBe(400);
    expect(ctx.createUser).not.toHaveBeenCalled();
  });

  it('rejects duplicate nicknames and escapes SQL wildcard characters', async () => {
    const ctx = setup({ duplicate: true });
    expect((await ctx.request({ ...payload, nickname: 'A_%' })).status).toBe(409);
    expect(ctx.duplicateQuery.ilike).toHaveBeenCalledWith('nickname', 'A\\_\\%');
    expect(ctx.createUser).not.toHaveBeenCalled();
  });

  it('creates confirmed internal credentials and saves permissions through the admin caller RPC', async () => {
    const ctx = setup();
    const response = await ctx.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ctx.saved);
    expect(ctx.createUser).toHaveBeenCalledWith({
      email: `${adminId.replace(/-/g, '')}${payload.requestId.replace(/-/g, '')}@staff.ice-delivery.invalid`,
      password: payload.password, email_confirm: true, user_metadata: { display_name: 'พนักงานใหม่' },
      app_metadata: { created_by_admin: adminId, creation_request_id: payload.requestId },
    });
    expect(ctx.rpc).toHaveBeenCalledWith('save_user_profile_with_work_site_assignments_v2', {
      p_user_id: 'new-user', p_display_name: 'พนักงานใหม่', p_nickname: 'ใหม่', p_avatar_path: null,
      p_phone: '0812345678', p_role: 'courier', p_is_active: true, p_can_collect_shop_payments: true,
      p_work_site_ids: payload.workSiteIds,
    });
    expect(ctx.createClient.mock.calls[0][2].global.headers.Authorization).toBe('Bearer admin-token');
    expect(ctx.createClient.mock.calls[1][1]).toBe('SUPABASE_SERVICE_ROLE_KEY');
  });

  it.each([{ role: 'admin' }, { role: 'round_lead' }, { isActive: false }])('omits unsupported work-site assignments: %j', async (changes) => {
    const ctx = setup();
    await ctx.request({ ...payload, ...changes });
    expect(ctx.rpc.mock.calls[0][1].p_work_site_ids).toEqual([]);
    if (changes.role) expect(ctx.rpc.mock.calls[0][1].p_can_collect_shop_payments).toBe(false);
  });

  it('does not save a profile if Auth rejects the password', async () => {
    const ctx = setup({ createError: true });
    expect((await ctx.request()).status).toBe(400);
    expect(ctx.rpc).not.toHaveBeenCalled();
  });

  it('returns the inactive account for recovery after profile validation fails', async () => {
    const ctx = setup({ saveError: true });
    const response = await ctx.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: ctx.pending, work_site_ids: [], warning: expect.stringContaining('Work site is inactive') });
    expect(ctx.createUser).toHaveBeenCalledTimes(1);
  });

  it('does not create credentials when the recovery migration or service is unavailable', async () => {
    const ctx = setup();
    ctx.recover.mockReset().mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } });
    expect((await ctx.request()).status).toBe(503);
    expect(ctx.createUser).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'not-a-uuid'])('rejects invalid request IDs: %s', async (requestId) => {
    const ctx = setup();
    expect((await ctx.request({ ...payload, requestId })).status).toBe(400);
    expect(ctx.createUser).not.toHaveBeenCalled();
  });
});
