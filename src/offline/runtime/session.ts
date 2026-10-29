import type { Session } from '@supabase/supabase-js';
import { env } from '../../lib/env';
import { preparedProfile } from './client';

// Reuse the SDK's existing persisted session; never copy tokens into the work
// database. It is only an identity for local work. Sync revalidates with Supabase.
export async function readPreparedOfflineSession(): Promise<Session | null> {
  if (!env.supabaseUrl) return null;
  try {
    const project = new URL(env.supabaseUrl).hostname.split('.')[0];
    const value = JSON.parse(localStorage.getItem(`sb-${project}-auth-token`) ?? 'null') as Session | null;
    if (!value?.user?.id || !value.access_token || !value.refresh_token) return null;
    return await preparedProfile(value.user.id) ? value : null;
  } catch { return null; }
}
