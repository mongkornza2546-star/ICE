import { supabase } from './supabase';

export type R2Namespace =
  | 'shop-images'
  | 'ice-type-images'
  | 'user-avatars'
  | 'tank-images'
  | 'payment-evidence'
  | 'credit-signoff-evidence';

export function isR2Path(path: string) {
  return path.startsWith('r2/') || path.includes('/r2/');
}

async function invokeR2<T>(body: FormData | Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
  const { data, error } = await supabase.functions.invoke('r2-storage', { body });
  if (error) {
    const response = 'context' in error ? error.context : null;
    const payload = response ? await response.json().catch(() => null) : null;
    throw new Error(payload?.error ?? error.message);
  }
  return data as T;
}

export async function uploadR2Object(namespace: R2Namespace, path: string, file: Blob) {
  const body = new FormData();
  body.set('namespace', namespace);
  body.set('path', path);
  body.set('file', file);
  await invokeR2<{ success: true }>(body);
  return path;
}

export async function getR2ObjectUrl(namespace: R2Namespace, path: string) {
  const result = await invokeR2<{ signedUrl: string }>({ action: 'sign', namespace, path });
  return result.signedUrl;
}

export async function getR2ObjectUrls(namespace: R2Namespace, paths: string[]) {
  if (paths.length === 0) return [];
  const result = await invokeR2<{
    signedUrls: Array<{ path: string; signedUrl: string }>;
  }>({ action: 'signMany', namespace, paths });
  return result.signedUrls;
}

export async function removeR2Objects(namespace: R2Namespace, paths: string[]) {
  if (paths.length === 0) return;
  await invokeR2<{ success: true }>({ action: 'delete', namespace, paths });
}

export async function getHybridObjectUrl(
  namespace: R2Namespace,
  path: string,
  getSupabaseUrl: () => Promise<string> | string,
) {
  return isR2Path(path) ? getR2ObjectUrl(namespace, path) : getSupabaseUrl();
}

export async function getHybridObjectUrls(
  namespace: R2Namespace,
  paths: string[],
  getSupabaseUrls: (paths: string[]) => Promise<Array<{ path?: string | null; signedUrl?: string | null }>>,
) {
  const uniquePaths = [...new Set(paths)];
  const r2Paths = uniquePaths.filter(isR2Path);
  const supabasePaths = uniquePaths.filter((path) => !isR2Path(path));
  const [r2Entries, supabaseEntries] = await Promise.all([
    getR2ObjectUrls(namespace, r2Paths).catch(() => []),
    getSupabaseUrls(supabasePaths).catch(() => []),
  ]);
  return [...r2Entries, ...supabaseEntries];
}
