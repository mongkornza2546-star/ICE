interface QueryError { message: string; status?: number }
interface Result<T> { data: T; error: QueryError | null }
interface Profile { id: string; role: string; is_active: boolean; [key: string]: unknown }
interface Query {
  select(columns: string): Query;
  eq(column: string, value: string): Query;
  ilike(column: string, value: string): Query;
  maybeSingle(): Promise<Result<Profile | null>>;
}
interface Client {
  auth: {
    getUser(): Promise<Result<{ user: { id: string } | null }>>;
    admin: {
      createUser(attributes: {
        email: string; password: string; email_confirm: boolean;
        user_metadata: { display_name: string };
        app_metadata: { created_by_admin: string; creation_request_id: string };
      }): Promise<Result<{ user: { id: string } | null }>>;
    };
  };
  from(table: string): Query;
  rpc(name: string, args: Record<string, unknown>): Promise<Result<{ user: Profile; work_site_ids: string[] } | null>>;
}

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
};
const uuidPattern = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const recoveryWarning = 'พบบัญชีที่สร้างจากคำขอนี้แล้ว รหัสผ่านยังเป็นค่าที่สร้างบัญชีครั้งแรก กรุณาตรวจสอบข้อมูลก่อนบันทึก หรือใช้รีเซ็ตรหัสผ่านหากต้องการเปลี่ยน';

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function createAdminCreateUserHandler(dependencies: {
  createClient: (...args: any[]) => unknown;
  getEnv: (name: string) => string | undefined;
}) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const authorization = request.headers.get('Authorization');
    if (!authorization) return json({ error: 'ไม่ได้ส่งข้อมูลยืนยันตัวตน' }, 401);
    const url = dependencies.getEnv('SUPABASE_URL');
    const anonKey = dependencies.getEnv('SUPABASE_ANON_KEY');
    const serviceKey = dependencies.getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anonKey || !serviceKey) return json({ error: 'การตั้งค่าบริการเพิ่มพนักงานไม่สมบูรณ์' }, 500);

    const callerClient = dependencies.createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    }) as Client;
    const { data: auth, error: authError } = await callerClient.auth.getUser();
    if (authError || !auth.user) return json({ error: 'ไม่สามารถยืนยันตัวตนได้' }, 401);
    const { data: caller, error: callerError } = await callerClient.from('users')
      .select('id, role, is_active').eq('id', auth.user.id).maybeSingle();
    if (callerError || caller?.role !== 'admin' || !caller.is_active) {
      return json({ error: 'เฉพาะแอดมินที่เปิดใช้งานเท่านั้นที่เพิ่มพนักงานได้' }, 403);
    }

    let payload: Record<string, unknown>;
    try {
      const body = await request.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
      payload = body;
    } catch {
      return json({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' }, 400);
    }
    const displayName = typeof payload.displayName === 'string' ? payload.displayName.trim() : '';
    const nickname = typeof payload.nickname === 'string' ? payload.nickname.trim() : '';
    if (!displayName || !nickname) return json({ error: 'กรุณาระบุชื่อและชื่อเล่นสำหรับเข้าสู่ระบบ' }, 400);
    if (nickname.includes('@')) return json({ error: 'ชื่อเล่นต้องไม่มีเครื่องหมาย @' }, 400);
    if (typeof payload.requestId !== 'string' || !uuidPattern.test(payload.requestId)) {
      return json({ error: 'รหัสคำขอสร้างบัญชีไม่ถูกต้อง กรุณาเปิดฟอร์มเพิ่มพนักงานใหม่' }, 400);
    }
    const requestId = payload.requestId.toLowerCase();
    if (typeof payload.password !== 'string' || payload.password.length < 8) {
      return json({ error: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' }, 400);
    }
    if (typeof payload.role !== 'string' || !['courier', 'round_lead', 'admin'].includes(payload.role)
      || typeof payload.isActive !== 'boolean' || typeof payload.canCollectShopPayments !== 'boolean'
      || typeof payload.phone !== 'string'
      || !Array.isArray(payload.workSiteIds)
      || payload.workSiteIds.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) {
      return json({ error: 'ข้อมูลบทบาทหรือจุดประจำไม่ถูกต้อง' }, 400);
    }

    const adminClient = dependencies.createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as Client;
    const recover = () => adminClient.rpc('get_admin_created_user', {
      p_actor_id: auth.user!.id, p_request_id: requestId,
    });
    // Fail closed if recovery is unavailable; never create an account that a retry
    // cannot find. Replays return current state without reverting subsequent edits.
    const previous = await recover();
    if (previous.error) return json({ error: 'ตรวจสอบคำขอสร้างบัญชีไม่สำเร็จ กรุณาลองอีกครั้ง' }, 503);
    if (previous.data) return json({ ...previous.data, warning: recoveryWarning }, 200);

    const { data: duplicate, error: duplicateError } = await adminClient.from('users')
      .select('id').ilike('nickname', nickname.replace(/[\\%_]/g, '\\$&')).maybeSingle();
    if (duplicateError) return json({ error: 'ตรวจสอบชื่อเล่นไม่สำเร็จ กรุณาลองอีกครั้ง' }, 500);
    if (duplicate) return json({ error: 'ชื่อเล่นนี้มีผู้ใช้แล้ว กรุณาเลือกชื่อเล่นอื่น' }, 409);

    // Stable 64-character local part: Auth's email uniqueness also protects
    // simultaneous requests and lost responses, including before profile save.
    // The existing auth trigger creates an inactive courier until the atomic RPC succeeds.
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: `${auth.user.id.replace(/-/g, '')}${requestId.replace(/-/g, '')}@staff.ice-delivery.invalid`,
      password: payload.password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
      app_metadata: { created_by_admin: auth.user.id, creation_request_id: requestId },
    });
    if (createError || !created.user) {
      // An error can follow a committed Auth insert (or another concurrent call).
      const recovered = await recover();
      if (recovered.data) return json({ ...recovered.data, warning: recoveryWarning }, 200);
      if (recovered.error || (createError?.status ?? 0) >= 500) {
        return json({ error: 'ยังยืนยันผลสร้างบัญชีไม่ได้ กรุณากดสร้างบัญชีอีกครั้งจากฟอร์มเดิม ระบบจะตรวจหาบัญชีเดิมก่อน' }, 503);
      }
      return json({ error: createError?.message ?? 'สร้างบัญชีไม่สำเร็จ' }, 400);
    }

    const userId = created.user.id;
    const { data: saved, error: saveError } = await callerClient.rpc('save_user_profile_with_work_site_assignments_v2', {
      p_user_id: userId, p_display_name: displayName, p_nickname: nickname,
      p_avatar_path: null, p_phone: payload.phone.trim() || null,
      p_role: payload.role, p_is_active: payload.isActive,
      p_can_collect_shop_payments: payload.role === 'courier' && payload.canCollectShopPayments,
      p_work_site_ids: payload.role === 'courier' && payload.isActive ? [...new Set(payload.workSiteIds)] : [],
    });
    if (!saveError && saved?.user) return json(saved, 200);

    // Return the created profile so the form retries editing the same account,
    // rather than creating another Auth user after a failed profile transaction.
    const { data: pending } = await recover();
    if (!pending) return json({ error: 'สร้างบัญชีแล้ว แต่โหลดข้อมูลไม่สำเร็จ กรุณาโหลดรายชื่อใหม่ก่อนดำเนินการต่อ' }, 500);
    return json({
      ...pending,
      warning: `สร้างบัญชีแล้ว แต่บันทึกข้อมูลไม่สำเร็จ กรุณาแก้ไขแล้วบันทึกผู้ใช้อีกครั้ง: ${saveError?.message ?? 'ไม่พบข้อมูลที่บันทึก'}`,
    }, 200);
  };
}
