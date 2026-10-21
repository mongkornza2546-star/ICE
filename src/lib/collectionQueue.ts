import type { QueueShop } from '../features/financial-operations/types';
import { invalidateCurrentCollectionContext } from './collectionContext';
import { supabase } from './supabase';

export interface CurrentCollectionQueue {
  runId: string | null;
  isClosed: boolean;
  queue: QueueShop[];
}

export async function loadCurrentCollectionQueue(serviceDate: string): Promise<CurrentCollectionQueue> {
  if (!supabase) return { runId: null, isClosed: false, queue: [] };
  const response = await supabase.rpc('get_daily_shop_collection_queue', {
    p_service_date: serviceDate,
  });
  if (response.error) {
    invalidateCurrentCollectionContext(true);
    throw response.error;
  }
  return {
    runId: response.data.collection_run_id,
    isClosed: response.data.status === 'closed',
    queue: (response.data.queue ?? []) as QueueShop[],
  };
}
