import { supabase } from './supabase';

type CollectionContext = {
  collection_run_id: string;
  service_date: string;
  status: 'open';
};

let cachedContext: CollectionContext | null = null;
let pendingContext: Promise<CollectionContext> | null = null;

export const COLLECTION_PROFILE_REFRESH_EVENT = 'ice-profile-refresh-requested';

export function invalidateCurrentCollectionContext(refreshProfile = false) {
  cachedContext = null;
  pendingContext = null;
  if (refreshProfile && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(COLLECTION_PROFILE_REFRESH_EVENT));
  }
}

export async function ensureCurrentCollectionContext(serviceDate: string): Promise<CollectionContext> {
  if (cachedContext?.service_date === serviceDate) return cachedContext;
  if (cachedContext?.service_date !== serviceDate) cachedContext = null;
  if (pendingContext) return pendingContext;
  if (!supabase) throw new Error('ไม่พบการเชื่อมต่อฐานข้อมูล');

  pendingContext = (async () => {
    const { data, error } = await supabase.rpc('ensure_daily_collection_context', {
      p_service_date: serviceDate,
    });
    if (error) throw error;
    const context = data as Partial<CollectionContext> | null;
    if (!context?.collection_run_id || context.service_date !== serviceDate || context.status !== 'open') {
      throw new Error('ระบบไม่ได้ส่งบริบทรับเงินของวันปัจจุบันกลับมา');
    }
    cachedContext = context as CollectionContext;
    return cachedContext;
  })().catch((error) => {
    invalidateCurrentCollectionContext(true);
    throw error;
  }).finally(() => {
    pendingContext = null;
  });

  return pendingContext;
}
