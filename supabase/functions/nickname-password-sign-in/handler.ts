interface QueryError {
  message: string;
}

interface QueryResult<T> {
  data: T;
  error: QueryError | null;
}

interface UserProfileQuery {
  select(columns: string): UserProfileQuery;
  ilike(column: string, value: string): UserProfileQuery;
  maybeSingle(): Promise<QueryResult<{ id: string; is_active: boolean } | null>>;
}

interface AuthSession {
  access_token: string;
  refresh_token: string;
}

interface SupabaseClientLike {
  auth: {
    admin?: {
      getUserById(userId: string): Promise<QueryResult<{ user: { email?: string | null } | null }>>;
    };
    signInWithPassword?(credentials: { email: string; password: string }): Promise<QueryResult<{ session: AuthSession | null }>>;
  };
  from(table: 'users'): UserProfileQuery;
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

const invalidCredentials = { error: 'ชื่อเล่นหรือรหัสผ่านไม่ถูกต้อง' };

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function createNicknamePasswordSignInHandler(dependencies: HandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

    let payload: { nickname?: unknown; password?: unknown };
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' }, 400);
    }

    const nickname = typeof payload.nickname === 'string' ? payload.nickname.trim() : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    if (!nickname || !password) return jsonResponse(invalidCredentials, 400);

    const supabaseUrl = dependencies.getEnv('SUPABASE_URL');
    const supabaseAnonKey = dependencies.getEnv('SUPABASE_ANON_KEY');
    const serviceRoleKey = dependencies.getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return jsonResponse({ error: 'การตั้งค่าบริการเข้าสู่ระบบไม่สมบูรณ์' }, 500);
    }

    const adminClient = dependencies.createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as SupabaseClientLike;
    const { data: profile, error: profileError } = await adminClient
      .from('users')
      .select('id, is_active')
      .ilike('nickname', escapeLikePattern(nickname))
      .maybeSingle();
    if (profileError || !profile?.is_active || !adminClient.auth.admin) {
      return jsonResponse(invalidCredentials, 401);
    }

    const { data: authUser, error: authUserError } = await adminClient.auth.admin.getUserById(profile.id);
    const email = authUser?.user?.email;
    if (authUserError || !email) return jsonResponse(invalidCredentials, 401);

    const authClient = dependencies.createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as SupabaseClientLike;
    if (!authClient.auth.signInWithPassword) return jsonResponse({ error: 'การตั้งค่าบริการเข้าสู่ระบบไม่สมบูรณ์' }, 500);
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data.session) return jsonResponse(invalidCredentials, 401);

    return jsonResponse({ session: data.session }, 200);
  };
}
