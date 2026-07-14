import { createClient } from '@supabase/supabase-js';
import { env } from './env';

export const supabase = env.isConfigured
  ? createClient(env.supabaseUrl!, env.supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;
