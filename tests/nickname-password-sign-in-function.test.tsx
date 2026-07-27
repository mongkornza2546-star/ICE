import { describe, expect, it, vi } from 'vitest';
import { createNicknamePasswordSignInHandler } from '../supabase/functions/nickname-password-sign-in/handler';

function createFixture(options: { active?: boolean; signInError?: boolean } = {}) {
  const getUserById = vi.fn().mockResolvedValue({ data: { user: { email: 'staff@example.com' } }, error: null });
  const adminClient = {
    auth: { admin: { getUserById } },
    from: vi.fn(() => {
      const query = {
        select: vi.fn(),
        ilike: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'user-1', is_active: options.active ?? true }, error: null }),
      };
      query.select.mockReturnValue(query);
      query.ilike.mockReturnValue(query);
      return query;
    }),
  };
  const signInWithPassword = vi.fn().mockResolvedValue({
    data: { session: options.signInError ? null : { access_token: 'access', refresh_token: 'refresh' } },
    error: options.signInError ? { message: 'invalid login credentials' } : null,
  });
  const authClient = { auth: { signInWithPassword } };
  const createClient = vi.fn().mockReturnValueOnce(adminClient).mockReturnValueOnce(authClient);
  const handler = createNicknamePasswordSignInHandler({
    createClient,
    getEnv: (name) => ({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    })[name],
  });
  const request = (body = { nickname: '  Mew  ', password: 'secret' }) => new Request('https://example.test/sign-in', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { adminClient, createClient, getUserById, handler, request, signInWithPassword };
}

describe('nickname password sign-in edge handler', () => {
  it('finds the active profile by trimmed nickname and returns only session tokens', async () => {
    const fixture = createFixture();
    const response = await fixture.handler(fixture.request());

    expect(response.status).toBe(200);
    expect(fixture.adminClient.from).toHaveBeenCalledWith('users');
    expect(fixture.signInWithPassword).toHaveBeenCalledWith({ email: 'staff@example.com', password: 'secret' });
    await expect(response.json()).resolves.toEqual({ session: { access_token: 'access', refresh_token: 'refresh' } });
  });

  it('does not attempt password sign-in for an inactive nickname', async () => {
    const fixture = createFixture({ active: false });
    const response = await fixture.handler(fixture.request());

    expect(response.status).toBe(401);
    expect(fixture.createClient).toHaveBeenCalledOnce();
  });

  it('treats wildcard characters in a nickname as literal text', async () => {
    const fixture = createFixture();
    await fixture.handler(fixture.request({ nickname: 'mew_100%', password: 'secret' }));

    const query = fixture.adminClient.from.mock.results[0]?.value;
    expect(query.ilike).toHaveBeenCalledWith('nickname', 'mew\\_100\\%');
  });

  it('returns one generic error for an invalid password', async () => {
    const fixture = createFixture({ signInError: true });
    const response = await fixture.handler(fixture.request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'ชื่อเล่นหรือรหัสผ่านไม่ถูกต้อง' });
  });
});
