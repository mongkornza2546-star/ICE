import { createClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { createAdminCreateUserHandler } from '../supabase/functions/admin-create-user/handler';

const payload = {
  requestId: '11111111-1111-4111-8111-111111111111',
  displayName: 'รี', nickname: 'ree', password: 'review-password-123',
  phone: '', role: 'courier', isActive: true, canCollectShopPayments: false, workSiteIds: [],
};

function harness(loseFirstCreateResponse = false) {
  const profiles: Array<Record<string, any>> = [];
  const authUsers: Array<Record<string, any>> = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return json({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.com' });
    if (url.pathname === '/auth/v1/admin/users') {
      const body = JSON.parse(String(init?.body));
      const auth = { id: crypto.randomUUID(), email: body.email, app_metadata: body.app_metadata };
      if (authUsers.some((user) => user.email === auth.email)) return json({ msg: 'Email exists' }, 422);
      authUsers.push(auth);
      // Match the existing auth_user_created trigger: no nickname, inactive courier.
      profiles.push({ id: auth.id, code: 'AUTH-' + auth.id, display_name: body.user_metadata.display_name,
        nickname: null, role: 'courier', is_active: false });
      if (loseFirstCreateResponse && authUsers.length === 1) return json({ msg: 'upstream response lost after commit' }, 503);
      return json(auth);
    }
    if (url.pathname === '/rest/v1/users') {
      if (url.searchParams.get('id') === 'eq.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') return json([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin', is_active: true }]);
      if (url.searchParams.has('nickname')) {
        const nickname = url.searchParams.get('nickname')!.slice('ilike.'.length).toLowerCase();
        return json(profiles.filter((user) => user.nickname?.toLowerCase() === nickname));
      }
      return json(profiles.filter((user) => 'eq.' + user.id === url.searchParams.get('id')));
    }
    if (url.pathname === '/rest/v1/rpc/get_admin_created_user') {
      const args = JSON.parse(String(init?.body));
      const auth = authUsers.find((user) => user.app_metadata?.creation_request_id === args.p_request_id
        && user.app_metadata?.created_by_admin === args.p_actor_id);
      return json(auth ? { user: profiles.find((user) => user.id === auth.id), work_site_ids: [] } : null);
    }
    if (url.pathname === '/rest/v1/rpc/save_user_profile_with_work_site_assignments_v2') {
      const args = JSON.parse(String(init?.body));
      const profile = profiles.find((user) => user.id === args.p_user_id)!;
      Object.assign(profile, { nickname: args.p_nickname, role: args.p_role, is_active: args.p_is_active });
      return json({ user: profile, work_site_ids: [] });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const handler = createAdminCreateUserHandler({
    createClient: (url, key, options) => createClient(url, key, { ...options, global: { ...options?.global, fetch } }),
    getEnv: (name) => name === 'SUPABASE_URL' ? 'https://review-project.supabase.co' : name,
  });
  return {
    profiles, authUsers,
    request: (overrides = {}) => handler(new Request('https://review.local', {
      method: 'POST', headers: { Authorization: 'Bearer admin-token' }, body: JSON.stringify({ ...payload, ...overrides }),
    })),
  };
}

it('reuses the committed Auth user after a lost create response', async () => {
  const ctx = harness(true);
  await ctx.request();
  expect(ctx.profiles).toHaveLength(1);
  const retry = await ctx.request();
  expect(retry.status).toBe(200);
  expect(ctx.authUsers).toHaveLength(1);
  expect((await retry.json()).user.id).toBe(ctx.authUsers[0].id);
});

it('recovers the completed result without replaying stale profile updates or changing credentials', async () => {
  const ctx = harness();
  const first = await ctx.request();
  expect(first.status).toBe(200);
  ctx.profiles[0].display_name = 'Edited after creation';
  ctx.profiles[0].is_active = false;
  const retry = await ctx.request({ password: 'different-password' });
  expect(retry.status).toBe(200);
  const result = await retry.json();
  expect(ctx.authUsers).toHaveLength(1);
  expect(result.user.display_name).toBe('Edited after creation');
  expect(result.user.is_active).toBe(false);
  expect(result.warning).toContain('รหัสผ่าน');
});

it('deduplicates simultaneous requests even when both preflight reads see no account', async () => {
  const ctx = harness();
  const responses = await Promise.all([ctx.request(), ctx.request()]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(ctx.authUsers).toHaveLength(1);
  const results = await Promise.all(responses.map((response) => response.json()));
  expect(results[0].user.id).toBe(results[1].user.id);
});
