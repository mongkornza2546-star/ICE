const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
const appMode = import.meta.env.VITE_APP_MODE?.trim() || 'live';

export const env = {
  supabaseUrl,
  supabaseAnonKey,
  appMode,
  isDemoMode: appMode === 'demo',
  isConfigured: Boolean(supabaseUrl && supabaseAnonKey),
};
