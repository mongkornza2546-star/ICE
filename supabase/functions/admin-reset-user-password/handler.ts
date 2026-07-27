interface QueryError {
  message: string;
}

interface QueryResult<T> {
  data: T;
  error: QueryError | null;
}

interface SelectQuery<T> {
  select(columns: string): SelectQuery<T>;
  eq(column: string, value: string): SelectQuery<T>;
  maybeSingle(): Promise<QueryResult<T | null>>;
}

interface InsertQuery {
  insert(values: Record<string, unknown>): PromiseLike<QueryResult<unknown>>;
}

interface AuthUser {
  id: string;
}

interface SupabaseClientLike {
  auth: {
    getUser(): Promise<QueryResult<{ user: AuthUser | null }>>;
    admin: {
      updateUserById(userId: string, attributes: { password: string }): Promise<{ error: QueryError | null }>;
    };
  };
  from<T = unknown>(table: string): SelectQuery<T> & InsertQuery;
}

interface HandlerDependencies {
  createClient: (...args: any[]) => unknown;
  getEnv: (name: string) => string | undefined;
}

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function createAdminResetPasswordHandler(dependencies: HandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

    const authorization = request.headers.get('Authorization');
    if (!authorization) return jsonResponse({ error: 'ไม่ได้ส่งข้อมูลยืนยันตัวตน' }, 401);

    const supabaseUrl = dependencies.getEnv('SUPABASE_URL');
    const supabaseAnonKey = dependencies.getEnv('SUPABASE_ANON_KEY');
    const serviceRoleKey = dependencies.getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return jsonResponse({ error: 'การตั้งค่าบริการรีเซ็ตรหัสผ่านไม่สมบูรณ์' }, 500);
    }

    const callerClient = dependencies.createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
    }) as SupabaseClientLike;
    const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !caller) return jsonResponse({ error: 'ไม่สามารถยืนยันตัวตนได้' }, 401);

    const { data: callerProfile, error: profileError } = await callerClient
      .from<{ role: string; is_active: boolean }>('users')
      .select('role, is_active')
      .eq('id', caller.id)
      .maybeSingle();
    if (profileError || callerProfile?.role !== 'admin' || !callerProfile.is_active) {
      return jsonResponse({ error: 'การรีเซ็ตรหัสผ่านใช้ได้เฉพาะแอดมินที่เปิดใช้งาน' }, 403);
    }

    let payload: { userId?: unknown; password?: unknown };
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' }, 400);
    }
    if (typeof payload.userId !== 'string' || typeof payload.password !== 'string' || payload.password.length < 8) {
      return jsonResponse({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' }, 400);
    }
    if (payload.userId === caller.id) {
      return jsonResponse({ error: 'ไม่สามารถรีเซ็ตรหัสผ่านของบัญชีที่กำลังใช้งานได้' }, 400);
    }

    const adminClient = dependencies.createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as SupabaseClientLike;
    const { data: targetProfile, error: targetError } = await adminClient
      .from<{ id: string }>('users')
      .select('id')
      .eq('id', payload.userId)
      .maybeSingle();
    if (targetError || !targetProfile) return jsonResponse({ error: 'ไม่พบผู้ใช้ที่เลือก' }, 404);

    const { error: requestAuditError } = await adminClient.from('audit_logs').insert({
      actor_id: caller.id,
      entity_type: 'auth_user',
      entity_id: payload.userId,
      action: 'password_reset_requested_by_admin',
      after_value: { status: 'requested' },
    });
    if (requestAuditError) {
      return jsonResponse({ error: 'บันทึกคำขอรีเซ็ตรหัสผ่านไม่สำเร็จ จึงยังไม่มีการเปลี่ยนรหัสผ่าน' }, 500);
    }

    const { error: resetError } = await adminClient.auth.admin.updateUserById(payload.userId, {
      password: payload.password,
    });
    if (resetError) {
      await adminClient.from('audit_logs').insert({
        actor_id: caller.id,
        entity_type: 'auth_user',
        entity_id: payload.userId,
        action: 'password_reset_failed',
        after_value: { status: 'failed' },
        reason: resetError.message,
      });
      return jsonResponse({ error: resetError.message }, 400);
    }

    const { error: successAuditError } = await adminClient.from('audit_logs').insert({
      actor_id: caller.id,
      entity_type: 'auth_user',
      entity_id: payload.userId,
      action: 'password_reset_succeeded_by_admin',
      after_value: { status: 'succeeded' },
    });
    if (successAuditError) {
      console.error('Password reset succeeded but result audit failed', successAuditError);
      return jsonResponse({
        error: 'รหัสผ่านถูกเปลี่ยนแล้ว แต่บันทึกผล audit ไม่สำเร็จ กรุณาตรวจสอบ log ก่อนดำเนินการต่อ',
      }, 500);
    }

    return jsonResponse({ success: true }, 200);
  };
}
