import { createClient } from 'npm:@supabase/supabase-js@2.54.0';
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from 'npm:@aws-sdk/client-s3@3.864.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.864.0';
import {
  canDeleteR2Objects,
  canSignR2Object,
  canUploadR2Object,
  isAllowedR2MimeType,
  R2_NAMESPACES,
  type R2Namespace,
} from './policy.ts';

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
};

const namespaces = new Set<string>(R2_NAMESPACES);
const maxFileSize = 5 * 1024 * 1024;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'ไม่ได้ส่งข้อมูลยืนยันตัวตน' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const accountId = Deno.env.get('R2_ACCOUNT_ID');
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
  const bucket = Deno.env.get('R2_BUCKET_NAME');
  if (!supabaseUrl || !supabaseAnonKey || !accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return json({ error: 'การตั้งค่า R2 ฝั่งเซิร์ฟเวอร์ยังไม่ครบ' }, 500);
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: userError } = await authClient.auth.getUser();
  if (userError || !user) return json({ error: 'ไม่สามารถยืนยันตัวตนได้' }, 401);
  const { data: profile, error: profileError } = await authClient
    .from('users').select('role, is_active').eq('id', user.id).maybeSingle();
  if (profileError || !profile?.is_active) return json({ error: 'บัญชีนี้ไม่ได้เปิดใช้งาน' }, 403);

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const namespace = form.get('namespace');
    const path = form.get('path');
    const file = form.get('file');
    if (typeof namespace !== 'string' || !namespaces.has(namespace)
      || typeof path !== 'string' || !(file instanceof File)) {
      return json({ error: 'ข้อมูลอัปโหลดไม่ถูกต้อง' }, 400);
    }
    const typedNamespace = namespace as R2Namespace;
    if (file.size > maxFileSize) return json({ error: 'ไฟล์ต้องมีขนาดไม่เกิน 5 MB' }, 400);
    if (!isAllowedR2MimeType(typedNamespace, file.type)) {
      return json({ error: 'ประเภทไฟล์ไม่ถูกต้อง' }, 400);
    }
    if (!canUploadR2Object(typedNamespace, path, user.id, profile.role)) {
      return json({ error: 'การอัปโหลดรูปประเภทนี้ใช้ได้เฉพาะแอดมิน' }, 403);
    }
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${namespace}/${path}`,
      Body: new Uint8Array(await file.arrayBuffer()),
      ContentType: file.type || 'application/octet-stream',
      CacheControl: namespace === 'shop-images' || namespace === 'ice-type-images'
        ? 'public, max-age=31536000, immutable'
        : 'private, max-age=3600',
    }));
    return json({ success: true });
  }

  let payload: { action?: unknown; namespace?: unknown; path?: unknown; paths?: unknown };
  try { payload = await request.json(); } catch { return json({ error: 'ข้อมูลไม่ถูกต้อง' }, 400); }
  if (typeof payload.namespace !== 'string' || !namespaces.has(payload.namespace)) {
    return json({ error: 'ประเภทไฟล์ไม่ถูกต้อง' }, 400);
  }
  const namespace = payload.namespace as R2Namespace;

  if (payload.action === 'sign' && typeof payload.path === 'string') {
    const path = payload.path;
    if (!canSignR2Object(namespace, path, user.id, profile.role)) {
      return json({ error: 'ไม่มีสิทธิ์เปิดไฟล์นี้' }, 403);
    }
    const signedUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: bucket,
      Key: `${namespace}/${path}`,
    }), { expiresIn: 3600 });
    return json({ signedUrl });
  }

  if (payload.action === 'signMany' && Array.isArray(payload.paths)) {
    const paths = payload.paths.filter((path): path is string => typeof path === 'string');
    if (paths.length === 0 || paths.length > 100 || paths.length !== payload.paths.length) {
      return json({ error: 'รายการไฟล์ไม่ถูกต้อง' }, 400);
    }
    if (!paths.every((path) => canSignR2Object(namespace, path, user.id, profile.role))) {
      return json({ error: 'ไม่มีสิทธิ์เปิดไฟล์นี้' }, 403);
    }
    const signedUrls = await Promise.all(paths.map(async (path) => ({
      path,
      signedUrl: await getSignedUrl(s3, new GetObjectCommand({
        Bucket: bucket,
        Key: `${namespace}/${path}`,
      }), { expiresIn: 3600 }),
    })));
    return json({ signedUrls });
  }

  if (payload.action === 'delete' && Array.isArray(payload.paths)) {
    const paths = payload.paths.filter((path): path is string => typeof path === 'string');
    if (paths.length === 0 || paths.length > 100) return json({ error: 'รายการไฟล์ไม่ถูกต้อง' }, 400);
    if (paths.length !== payload.paths.length
      || !canDeleteR2Objects(namespace, paths, user.id, profile.role)) {
      return json({ error: 'ไม่มีสิทธิ์ลบไฟล์นี้' }, 403);
    }
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: paths.map((path) => ({ Key: `${namespace}/${path}` })) },
    }));
    return json({ success: true });
  }

  return json({ error: 'คำสั่งไม่ถูกต้อง' }, 400);
});
